/**
 * Provedor OpenAI — chat completions com streaming SSE, transcrição via
 * Whisper e síntese de voz via /v1/audio/speech.
 */

import { PROVIDER_ENDPOINTS } from '../../shared/constants';
import type { TestConnectionResult } from '../../shared/types';
import {
  type LLMProvider,
  type SendMessageParams,
  type StreamChunk
} from './base';
import { fetchWithRetry } from './retry';
import { parseSseStream } from './sse';

interface OpenAiChatChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

// O default global DEFAULT_MAX_TOKENS (32k) serve para modelos com janela de
// saida grande (Claude Sonnet/Haiku 4.x, Gemini 2.5/3.x). Os GPT-5.6 (sol/
// terra/luna) aceitam ate 128k tokens de saida; modelos GPT-4o legados
// aceitavam no maximo 16.384 — enviar mais retornava HTTP 400 invalid_value.
// O map cap por modelo evita o erro sem baixar o default global.
const OPENAI_MAX_COMPLETION_TOKENS: Record<string, number> = {
  'gpt-5.6-sol': 128_000,
  'gpt-5.6-terra': 128_000,
  'gpt-5.6-luna': 128_000,
  'gpt-4o': 16_384,
  'gpt-4o-mini': 16_384
};
// Fallback para IDs desconhecidos: 128k cobre a familia GPT-5 atual. Modelos
// GPT-4o legados ficam limitados pelo map acima.
const OPENAI_FALLBACK_MAX_COMPLETION = 128_000;

function resolveOpenAiMaxTokens(model: string, requested: number): number {
  const cap = OPENAI_MAX_COMPLETION_TOKENS[model] ?? OPENAI_FALLBACK_MAX_COMPLETION;
  return Math.min(Math.max(1, requested), cap);
}

// A partir da serie GPT-5, `max_tokens` esta deprecado e e incompativel com
// os modelos de raciocinio — deve-se enviar `max_completion_tokens`. Alem
// disso, `temperature` virou campo "greylist": pode ser rejeitado. Para os
// GPT-5 nao enviamos temperature (usa o default do modelo); modelos legados
// (gpt-4o*) continuam aceitando o parametro normalmente.
function isGpt5Family(model: string): boolean {
  return model.startsWith('gpt-5');
}

// Sem `reasoning_effort` explicito o GPT-5.6 assume o default `medium`. No
// Sol (tier frontier) isso significa dezenas de segundos — as vezes minutos —
// gastos so em reasoning tokens. Em /v1/chat/completions esses tokens NAO
// aparecem em `delta.content`: o stream fica aberto e silencioso, a UI pisca
// o indicador de digitacao e nada chega. Mesmo problema que resolvemos no
// Gemini com `thinkingConfig` (ver buildThinkingConfig em gemini.ts).
//
// `low` mantem a qualidade do modelo em redacao de minutas e triagem (tarefas
// de geracao, nao de prova matematica) com latencia aceitavel. Os valores
// `none`/`minimal` existem mas sao model-dependent e podem retornar 400 em
// parte da familia — por isso usamos `low` uniformemente nos tres tiers.
// Modelos gpt-4o legados nao conhecem o parametro: nada e enviado.
const OPENAI_REASONING_EFFORT: Record<string, string> = {
  'gpt-5.6-sol': 'low',
  'gpt-5.6-terra': 'low',
  'gpt-5.6-luna': 'low'
};

function resolveReasoningEffort(model: string): string | undefined {
  if (!isGpt5Family(model)) {
    return undefined;
  }
  return OPENAI_REASONING_EFFORT[model] ?? 'low';
}

function reasoningEffortField(model: string): Record<string, string> {
  const effort = resolveReasoningEffort(model);
  return effort ? { reasoning_effort: effort } : {};
}

export const openaiProvider: LLMProvider = {
  id: 'openai',

  async *sendMessage(params: SendMessageParams): AsyncGenerator<StreamChunk, void, void> {
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'system', content: params.systemPrompt }
    ];
    for (const m of params.messages) {
      if (m.role === 'system') {
        continue;
      }
      if (!m.images || m.images.length === 0) {
        messages.push({ role: m.role, content: m.content });
        continue;
      }
      // Com imagens: content vira o array multimodal da chat/completions.
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const img of m.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` }
        });
      }
      messages.push({ role: m.role, content });
    }

    const response = await fetchWithRetry(
      PROVIDER_ENDPOINTS.openai.chat,
      {
        method: 'POST',
        signal: params.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.apiKey}`
        },
        body: JSON.stringify({
          model: params.model,
          // temperature so e enviado para modelos legados; nos GPT-5 e
          // greylist e pode retornar 400 (usa-se o default do modelo).
          ...(isGpt5Family(params.model) ? {} : { temperature: params.temperature }),
          ...reasoningEffortField(params.model),
          max_completion_tokens: resolveOpenAiMaxTokens(params.model, params.maxTokens),
          stream: true,
          messages
        })
      },
      { provider: 'openai', model: params.model }
    );

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
          ...reasoningEffortField(model),
          // Nos modelos de raciocinio o orcamento e consumido primeiro pelos
          // reasoning tokens: com 16 tokens o ping volta sempre vazio
          // (finish_reason 'length'). 512 da folga para o texto final.
          max_completion_tokens: isGpt5Family(model) ? 512 : 16,
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

    const response = await fetchWithRetry(
      PROVIDER_ENDPOINTS.openai.transcriptions,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      },
      { provider: 'openai', model: 'whisper-1', resourceLabel: 'transcrição de áudio' }
    );
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
    const response = await fetchWithRetry(
      PROVIDER_ENDPOINTS.openai.speech,
      {
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
      },
      { provider: 'openai', model: 'tts-1', resourceLabel: 'síntese de voz' }
    );
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
