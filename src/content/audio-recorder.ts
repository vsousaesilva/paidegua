/**
 * Gravação de áudio do microfone via MediaRecorder + getUserMedia.
 *
 * Usado pelo botão de microfone do chat. Codifica a saída como WebM/Opus
 * (formato suportado universalmente pelo Chromium) e devolve um Blob que
 * pode ser enviado para a API de transcrição do provedor ativo.
 *
 * Fallback de transcrição via Web Speech API mora em web-speech.ts —
 * este módulo cuida apenas da captura de áudio.
 */

export interface RecorderHandle {
  stop(): Promise<{ blob: Blob; mimeType: string; durationMs: number }>;
  cancel(): void;
}

export async function startRecording(): Promise<RecorderHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microfone indisponível neste navegador.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  const startedAt = Date.now();

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  let stopped = false;
  const stopPromise = new Promise<{ blob: Blob; mimeType: string; durationMs: number }>(
    (resolve, reject) => {
      recorder.addEventListener('stop', () => {
        try {
          stream.getTracks().forEach((t) => t.stop());
          const finalType = recorder.mimeType || mimeType || 'audio/webm';
          const blob = new Blob(chunks, { type: finalType });
          resolve({ blob, mimeType: finalType, durationMs: Date.now() - startedAt });
        } catch (err) {
          reject(err);
        }
      });
      recorder.addEventListener('error', (event) => {
        stream.getTracks().forEach((t) => t.stop());
        reject((event as ErrorEvent).error ?? new Error('Erro de gravação'));
      });
    }
  );

  recorder.start();

  return {
    async stop() {
      if (stopped) {
        throw new Error('Gravação já encerrada.');
      }
      stopped = true;
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
      return stopPromise;
    },
    cancel() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
      stream.getTracks().forEach((t) => t.stop());
    }
  };
}

function pickMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(c)) {
      return c;
    }
  }
  return undefined;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}
