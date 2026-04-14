/**
 * Wrappers das APIs nativas de fala do browser:
 *  - SpeechRecognition (STT) — fallback quando o provedor ativo não tem
 *    transcrição (Anthropic).
 *  - SpeechSynthesis (TTS) — fallback quando o provedor ativo não tem
 *    síntese de voz (Anthropic, e Gemini quando indisponível).
 *
 * Funciona offline no Edge/Chromium em pt-BR usando vozes nativas do
 * sistema (no Windows: Microsoft Maria/Francisca/Letícia).
 */

interface SpeechRecognitionResult {
  transcript: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<SpeechRecognitionResult>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isWebSpeechAvailable(): boolean {
  return getRecognitionCtor() !== null;
}

/**
 * Transcreve um Blob de áudio usando a Web Speech API.
 *
 * IMPORTANTE: a Web Speech API NÃO aceita Blob diretamente — ela escuta
 * o microfone em tempo real. Para usar como fallback de transcrição de
 * um áudio já gravado, reproduzimos o blob no contexto do reconhecedor
 * via um elemento <audio> mudo, o que infelizmente não funciona em todos
 * os navegadores.
 *
 * Estratégia adotada: oferecer uma função `recognizeLive` que pega áudio
 * direto do microfone (alternativa ao MediaRecorder). O caller decide
 * qual fluxo usar baseado no provedor ativo.
 */
export function recognizeLive(): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      reject(new Error('Web Speech API indisponível neste navegador.'));
      return;
    }
    const recognizer = new Ctor();
    recognizer.lang = 'pt-BR';
    recognizer.continuous = false;
    recognizer.interimResults = false;

    let finalText = '';
    recognizer.onresult = (event) => {
      const first = event.results?.[0]?.[0];
      if (first?.transcript) {
        finalText = first.transcript;
      }
    };
    recognizer.onerror = (event) => {
      reject(new Error(`Reconhecimento falhou: ${event.error}`));
    };
    recognizer.onend = () => {
      resolve(finalText.trim());
    };

    try {
      recognizer.start();
    } catch (err) {
      reject(err);
    }
  });
}

// =====================================================================
// TTS (SpeechSynthesis)
// =====================================================================

let cachedVoices: SpeechSynthesisVoice[] | null = null;

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (cachedVoices && cachedVoices.length > 0) {
      resolve(cachedVoices);
      return;
    }
    const initial = window.speechSynthesis.getVoices();
    if (initial && initial.length > 0) {
      cachedVoices = initial;
      resolve(initial);
      return;
    }
    const handler = (): void => {
      cachedVoices = window.speechSynthesis.getVoices();
      window.speechSynthesis.removeEventListener('voiceschanged', handler);
      resolve(cachedVoices);
    };
    window.speechSynthesis.addEventListener('voiceschanged', handler);
    // Fallback timeout
    setTimeout(() => {
      cachedVoices = window.speechSynthesis.getVoices();
      resolve(cachedVoices);
    }, 1500);
  });
}

/**
 * Escolhe uma voz feminina pt-BR. Heurística: prioriza nomes conhecidos
 * (Maria, Francisca, Letícia, Helena), depois qualquer voz pt-BR.
 */
async function pickFemalePtBrVoice(): Promise<SpeechSynthesisVoice | null> {
  const voices = await loadVoices();
  if (!voices || voices.length === 0) {
    return null;
  }
  const ptBr = voices.filter((v) => /^pt[-_]BR/i.test(v.lang));
  const namesPriority = ['Maria', 'Francisca', 'Letícia', 'Leticia', 'Helena', 'Camila'];
  for (const name of namesPriority) {
    const found = ptBr.find((v) => v.name.toLowerCase().includes(name.toLowerCase()));
    if (found) {
      return found;
    }
  }
  return ptBr[0] ?? null;
}

export interface SpeakHandle {
  stop(): void;
  pause(): void;
  resume(): void;
  promise: Promise<void>;
}

export async function speakLocal(text: string): Promise<SpeakHandle> {
  if (typeof window.speechSynthesis === 'undefined') {
    throw new Error('SpeechSynthesis indisponível.');
  }
  const voice = await pickFemalePtBrVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'pt-BR';
  if (voice) {
    utterance.voice = voice;
  }
  utterance.rate = 1.0;
  utterance.pitch = 1.05;

  const promise = new Promise<void>((resolve, reject) => {
    utterance.onend = () => resolve();
    utterance.onerror = (event) => reject(new Error(`Speech: ${event.error}`));
  });

  // Cancela qualquer fala anterior antes de iniciar.
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);

  return {
    stop: () => window.speechSynthesis.cancel(),
    pause: () => window.speechSynthesis.pause(),
    resume: () => window.speechSynthesis.resume(),
    promise
  };
}
