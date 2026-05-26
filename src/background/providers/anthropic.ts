/**
 * Provedor Anthropic Claude — usa a API Messages com streaming SSE.
 *
 * Endpoint: POST https://api.anthropic.com/v1/messages
 * Header obrigatório quando chamado de browser:
 *   anthropic-dangerous-direct-browser-access: true
 *
 * STT/TTS: a API da Anthropic não fornece estes recursos. As funções
 * retornam null e o caller usa fallback do browser (Web Speech API /
 * SpeechSynthesis).
 */

import { LOG_PREFIX, PROVIDER_ENDPOINTS } from '../../shared/constants';
import type { ImagemIA, TestConnectionResult } from '../../shared/types';
import {
  type LLMProvider,
  type SendMessageParams,
  type StreamChunk
} from './base';
import { fetchWithRetry } from './retry';
import { parseSseStream } from './sse';

interface AnthropicSseDelta {
  type: string;
  delta?: { type: string; text?: string };
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      input_tokens?: number;
    };
  };
}

// Prompt caching ephemeral exige um piso de tokens (1024 em Opus/Sonnet,
// 2048 em Haiku) — abaixo disso a API ignora o cache_control silenciosamente
// e ainda assim consome 1 dos 4 breakpoints permitidos. Estes cortes
// conservadores em chars (~4 chars/token em PT-BR) garantem que só marcamos
// blocos que realmente vão render hit.
const CACHE_MIN_SYSTEM_CHARS = 5000;
const CACHE_MIN_IMAGES_FOR_BREAKPOINT = 3;

// A API Messages exige que max_tokens <= limite de saida do modelo (Opus 4.x
// aceita ate 32k; Sonnet e Haiku 4.x aceitam ate 64k). O default global
// DEFAULT_MAX_TOKENS (32k) cabe em Opus, mas um eventual aumento do default
// quebraria Opus silenciosamente. O map cap por modelo isola essa regra.
const ANTHROPIC_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'claude-opus-4-6': 32_000,
  'claude-sonnet-4-6': 64_000,
  'claude-haiku-4-5-20251001': 64_000
};
const ANTHROPIC_FALLBACK_MAX_OUTPUT = 8_192;

function resolveAnthropicMaxTokens(model: string, requested: number): number {
  const cap = ANTHROPIC_MAX_OUTPUT_TOKENS[model] ?? ANTHROPIC_FALLBACK_MAX_OUTPUT;
  return Math.min(Math.max(1, requested), cap);
}

// system prompt → array de content blocks com cache_control. A API aceita
// `system` como string, mas para cachear precisa ser array. Quando o prompt
// é curto (abaixo do piso), retornamos o array sem cache_control para
// preservar 1 dos 4 breakpoints disponíveis.
function buildSystemBlocks(
  prompt: string | undefined
): Array<Record<string, unknown>> | undefined {
  if (!prompt) return undefined;
  const block: Record<string, unknown> = { type: 'text', text: prompt };
  if (prompt.length >= CACHE_MIN_SYSTEM_CHARS) {
    block.cache_control = { type: 'ephemeral' };
  }
  return [block];
}

// Anthropic recusa requests multimodais com >20 imagens se alguma exceder
// 2000px em qualquer dimensão ("many-image requests" → 400). PDFs em formato
// maior que A4 (ofício, scans em DPI alto) renderizados pelo OCR imagem-direto
// podem passar disso. Reencoda apenas as que estouram o cap.
const ANTHROPIC_IMAGE_MAX_DIM = 2000;
const ANTHROPIC_DOWNSCALE_QUALITY = 0.85;

async function downscaleImagesForAnthropic(
  images: ImagemIA[]
): Promise<ImagemIA[]> {
  const out: ImagemIA[] = [];
  for (const img of images) {
    try {
      const blob = base64ToBlob(img.dataBase64, img.mimeType);
      const bitmap = await createImageBitmap(blob);
      const { width, height } = bitmap;
      const maxSide = Math.max(width, height);
      if (maxSide <= ANTHROPIC_IMAGE_MAX_DIM) {
        bitmap.close?.();
        out.push(img);
        continue;
      }
      const scale = ANTHROPIC_IMAGE_MAX_DIM / maxSide;
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close?.();
        out.push(img);
        continue;
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();
      const newBlob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: ANTHROPIC_DOWNSCALE_QUALITY
      });
      const buf = await newBlob.arrayBuffer();
      out.push({
        mimeType: 'image/jpeg',
        dataBase64: uint8ToBase64(new Uint8Array(buf))
      });
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} anthropic: downscale falhou, enviando imagem original`,
        err
      );
      out.push(img);
    }
  }
  return out;
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function uint8ToBase64(bytes: Uint8Array): string {
  // btoa direto em string grande estoura a stack; particiona em chunks.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk))
    );
  }
  return btoa(binary);
}

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',

  async *sendMessage(params: SendMessageParams): AsyncGenerator<StreamChunk, void, void> {
    const filteredMessages = params.messages.filter((m) => m.role !== 'system');
    // Índice do primeiro user com imagens — é onde colocamos o breakpoint de
    // cache da v1 (cobre o prefixo system+texto+todas as imagens desse turno).
    // Em chats subsequentes a mesma 1ª mensagem é re-enviada e dá cache hit.
    const firstImageMsgIdx = filteredMessages.findIndex(
      (m) => m.images && m.images.length > 0
    );

    const messagesPayload = await Promise.all(
      filteredMessages.map(async (m, idx) => {
        // Sem imagens: content é string simples. Com imagens: vira o
        // array multimodal da API Messages (imagens antes do texto).
        if (!m.images || m.images.length === 0) {
          return { role: m.role, content: m.content };
        }
        const safeImages = await downscaleImagesForAnthropic(m.images);
        const content: Array<Record<string, unknown>> = safeImages.map(
          (img) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mimeType,
              data: img.dataBase64
            }
          })
        );
        if (m.content) content.push({ type: 'text', text: m.content });

        // Breakpoint de cache no ÚLTIMO content block da 1ª user com imagens
        // (texto se houver, senão última imagem). cobre todo o prefixo.
        if (
          idx === firstImageMsgIdx &&
          safeImages.length >= CACHE_MIN_IMAGES_FOR_BREAKPOINT &&
          content.length > 0
        ) {
          content[content.length - 1].cache_control = { type: 'ephemeral' };
        }
        return { role: m.role, content };
      })
    );

    const body = {
      model: params.model,
      max_tokens: resolveAnthropicMaxTokens(params.model, params.maxTokens),
      temperature: params.temperature,
      system: buildSystemBlocks(params.systemPrompt),
      stream: true,
      messages: messagesPayload
    };

    const response = await fetchWithRetry(
      PROVIDER_ENDPOINTS.anthropic.messages,
      {
        method: 'POST',
        signal: params.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': params.apiKey,
          'anthropic-version': PROVIDER_ENDPOINTS.anthropic.apiVersion,
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      },
      { provider: 'anthropic', model: params.model }
    );

    for await (const event of parseSseStream(response, params.signal)) {
      if (!event.data || event.data === '[DONE]') {
        continue;
      }
      let payload: AnthropicSseDelta;
      try {
        payload = JSON.parse(event.data) as AnthropicSseDelta;
      } catch {
        continue;
      }
      // Telemetria do cache: aparece no message_start. Logamos só quando há
      // sinal (read>0 ou created>0) para não poluir o console.
      if (payload.type === 'message_start' && payload.message?.usage) {
        const u = payload.message.usage;
        const read = u.cache_read_input_tokens ?? 0;
        const created = u.cache_creation_input_tokens ?? 0;
        if (read > 0 || created > 0) {
          console.log(
            `${LOG_PREFIX} anthropic cache: read=${read} created=${created} ` +
              `input=${u.input_tokens ?? 0} model=${params.model}`
          );
        }
      }
      if (payload.type === 'content_block_delta' && payload.delta?.text) {
        yield { delta: payload.delta.text };
      }
    }
  },

  async testConnection(apiKey: string, model: string): Promise<TestConnectionResult> {
    try {
      const response = await fetch(PROVIDER_ENDPOINTS.anthropic.messages, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': PROVIDER_ENDPOINTS.anthropic.apiVersion,
          'anthropic-dangerous-direct-browser-access': 'true'
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
  }

  // STT/TTS: ausentes por design — caller faz fallback do browser.
};

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
