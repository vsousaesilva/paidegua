/**
 * Provedor Google Gemini — usa generateContent com streaming SSE em
 * `streamGenerateContent?alt=sse`. Aceita áudio nativamente como input
 * para transcrição (Gemini multimodal).
 *
 * TTS: usa `gemini-2.5-flash-preview-tts` quando disponível; em caso de
 * indisponibilidade, retorna null para que o caller use SpeechSynthesis.
 */

import { LOG_PREFIX, PROVIDER_ENDPOINTS } from '../../shared/constants';
import type { TestConnectionResult } from '../../shared/types';
import type { LLMProvider, SendMessageParams, StreamChunk } from './base';
import { parseSseStream } from './sse';

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
}

interface GeminiStreamPayload {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    safetyRatings?: Array<{ category: string; probability: string; blocked?: boolean }>;
  }>;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{ category: string; probability: string }>;
  };
}

/**
 * Configurações de safety. Em contexto judicial é comum o conteúdo das peças
 * mencionar crimes, violência, dados pessoais etc., disparando os filtros
 * padrão do Gemini (que bloqueiam até MEDIUM). Para uso pelo Judiciário
 * Federal, configuramos BLOCK_NONE — a responsabilidade do uso correto é do
 * servidor, não da plataforma de IA.
 */
const SAFETY_SETTINGS_PERMISSIVE = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
];

export const geminiProvider: LLMProvider = {
  id: 'gemini',

  async *sendMessage(params: SendMessageParams): AsyncGenerator<StreamChunk, void, void> {
    const contents: GeminiContent[] = [];
    for (const m of params.messages) {
      if (m.role === 'system') {
        continue;
      }
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      });
    }

    const url =
      `${PROVIDER_ENDPOINTS.gemini.base}/models/${encodeURIComponent(params.model)}` +
      `:streamGenerateContent?alt=sse&key=${encodeURIComponent(params.apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      signal: params.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.systemPrompt }] },
        contents,
        safetySettings: SAFETY_SETTINGS_PERMISSIVE,
        generationConfig: {
          temperature: params.temperature,
          maxOutputTokens: params.maxTokens,
          // Modelos Gemini 2.5/3.x são "thinking models": gastam tokens em
          // raciocínio interno antes de produzir texto. Para análise jurídica
          // queremos a resposta direta, então zeramos o budget de thinking
          // para liberar todo o maxOutputTokens para o output visível.
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });

    if (!response.ok) {
      const errText = await safeReadText(response);
      throw new Error(`Gemini ${response.status}: ${errText}`);
    }

    let totalChunks = 0;
    let totalTextLen = 0;
    let lastFinishReason: string | undefined;
    let blockReason: string | undefined;

    for await (const event of parseSseStream(response, params.signal)) {
      if (!event.data) {
        continue;
      }
      let payload: GeminiStreamPayload;
      try {
        payload = JSON.parse(event.data) as GeminiStreamPayload;
      } catch (err) {
        console.warn(`${LOG_PREFIX} gemini: JSON parse falhou`, event.data.slice(0, 200), err);
        continue;
      }

      // Detecta bloqueio do prompt antes de qualquer candidate
      if (payload.promptFeedback?.blockReason) {
        blockReason = payload.promptFeedback.blockReason;
      }

      const candidate = payload.candidates?.[0];
      if (candidate?.finishReason) {
        lastFinishReason = candidate.finishReason;
      }

      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          totalChunks++;
          totalTextLen += part.text.length;
          yield { delta: part.text };
        }
      }
    }

    // Stream terminou sem nenhum texto — diagnóstico para o usuário.
    if (totalChunks === 0) {
      console.warn(
        `${LOG_PREFIX} gemini: stream encerrado sem texto. ` +
          `finishReason=${lastFinishReason ?? '(nenhum)'} ` +
          `blockReason=${blockReason ?? '(nenhum)'}`
      );
      if (blockReason) {
        throw new Error(
          `Gemini bloqueou o prompt (${blockReason}). O conteúdo dos autos disparou um filtro de segurança.`
        );
      }
      if (lastFinishReason && lastFinishReason !== 'STOP') {
        throw new Error(
          `Gemini encerrou sem produzir texto (finishReason=${lastFinishReason}). ` +
            'Pode ser bloqueio por safety, limite de tokens, ou conteúdo recitado.'
        );
      }
      throw new Error(
        'Gemini retornou resposta vazia. Verifique se a chave tem acesso ao modelo selecionado e se o processo não excedeu o context window.'
      );
    }
    console.log(
      `${LOG_PREFIX} gemini: stream OK — ${totalChunks} chunks, ${totalTextLen} chars, finishReason=${lastFinishReason ?? 'STOP'}`
    );
  },

  async testConnection(apiKey: string, model: string): Promise<TestConnectionResult> {
    try {
      const url =
        `${PROVIDER_ENDPOINTS.gemini.base}/models/${encodeURIComponent(model)}` +
        `:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 16 }
        })
      });
      if (!response.ok) {
        const text = await safeReadText(response);
        return { ok: false, error: `${response.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true, modelEcho: model };
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error) };
    }
  },

  async transcribeAudio(
    apiKey: string,
    audioBytes: Uint8Array,
    mimeType: string
  ): Promise<string | null> {
    // Gemini aceita áudio inline como Base64. Usa flash para custo baixo.
    const model = 'gemini-2.5-flash';
    const url =
      `${PROVIDER_ENDPOINTS.gemini.base}/models/${model}:generateContent` +
      `?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Transcreva fielmente este áudio em português brasileiro. Responda apenas com a transcrição, sem comentários.' },
              { inlineData: { mimeType, data: bytesToBase64(audioBytes) } }
            ]
          }
        ],
        generationConfig: { temperature: 0.0, maxOutputTokens: 2048 }
      })
    });
    if (!response.ok) {
      const errText = await safeReadText(response);
      throw new Error(`Gemini STT ${response.status}: ${errText}`);
    }
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ?? null;
  },

  async synthesizeSpeech(): Promise<null> {
    // A API pública estável de TTS do Gemini ainda varia por região e
    // exige formato preview. Para garantir robustez, devolvemos null e o
    // caller usa SpeechSynthesis local (voz pt-BR feminina do Edge).
    return null;
  }
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
