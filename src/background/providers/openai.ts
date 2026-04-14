/**
 * Provedor OpenAI — chat completions com streaming SSE, transcrição via
 * Whisper e síntese de voz via /v1/audio/speech.
 */

import { PROVIDER_ENDPOINTS } from '../../shared/constants';
import type { TestConnectionResult } from '../../shared/types';
import type { LLMProvider, SendMessageParams, StreamChunk } from './base';
import { parseSseStream } from './sse';

interface OpenAiChatChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

export const openaiProvider: LLMProvider = {
  id: 'openai',

  async *sendMessage(params: SendMessageParams): AsyncGenerator<StreamChunk, void, void> {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: params.systemPrompt }
    ];
    for (const m of params.messages) {
      if (m.role === 'system') {
        continue;
      }
      messages.push({ role: m.role, content: m.content });
    }

    const response = await fetch(PROVIDER_ENDPOINTS.openai.chat, {
      method: 'POST',
      signal: params.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify({
        model: params.model,
        temperature: params.temperature,
        max_tokens: params.maxTokens,
        stream: true,
        messages
      })
    });

    if (!response.ok) {
      const errText = await safeReadText(response);
      throw new Error(`OpenAI ${response.status}: ${errText}`);
    }

    for await (const event of parseSseStream(response, params.signal)) {
      if (!event.data || event.data === '[DONE]') {
        continue;
      }
      let payload: OpenAiChatChunk;
      try {
        payload = JSON.parse(event.data) as OpenAiChatChunk;
      } catch {
        continue;
      }
      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        yield { delta };
      }
    }
  },

  async testConnection(apiKey: string, model: string): Promise<TestConnectionResult> {
    try {
      const response = await fetch(PROVIDER_ENDPOINTS.openai.chat, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }]
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
    // Cópia defensiva: o tipo Uint8Array<ArrayBufferLike> do TS 5.7 não é
    // diretamente atribuível a BlobPart por causa do union com SharedArrayBuffer.
    const audioBuffer = new ArrayBuffer(audioBytes.length);
    new Uint8Array(audioBuffer).set(audioBytes);
    const blob = new Blob([audioBuffer], { type: mimeType });
    const form = new FormData();
    form.append('file', blob, fileNameForMime(mimeType));
    form.append('model', 'whisper-1');
    form.append('language', 'pt');
    form.append('response_format', 'json');

    const response = await fetch(PROVIDER_ENDPOINTS.openai.transcriptions, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    if (!response.ok) {
      const errText = await safeReadText(response);
      throw new Error(`Whisper ${response.status}: ${errText}`);
    }
    const json = (await response.json()) as { text?: string };
    return json.text ?? null;
  },

  async synthesizeSpeech(
    apiKey: string,
    text: string,
    voice: string | undefined
  ): Promise<{ audio: Uint8Array; mimeType: string } | null> {
    // Vozes femininas em pt-BR no OpenAI TTS: nova, shimmer, sage.
    const selectedVoice = voice && voice.length > 0 ? voice : 'nova';
    const response = await fetch(PROVIDER_ENDPOINTS.openai.speech, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: selectedVoice,
        input: text,
        response_format: 'mp3'
      })
    });
    if (!response.ok) {
      const errText = await safeReadText(response);
      throw new Error(`OpenAI TTS ${response.status}: ${errText}`);
    }
    const buf = await response.arrayBuffer();
    return { audio: new Uint8Array(buf), mimeType: 'audio/mpeg' };
  }
};

function fileNameForMime(mime: string): string {
  if (mime.includes('webm')) {
    return 'audio.webm';
  }
  if (mime.includes('ogg')) {
    return 'audio.ogg';
  }
  if (mime.includes('mp4') || mime.includes('m4a')) {
    return 'audio.m4a';
  }
  if (mime.includes('wav')) {
    return 'audio.wav';
  }
  return 'audio.bin';
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
