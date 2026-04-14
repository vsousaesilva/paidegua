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

import { PROVIDER_ENDPOINTS } from '../../shared/constants';
import type { TestConnectionResult } from '../../shared/types';
import type { LLMProvider, SendMessageParams, StreamChunk } from './base';
import { parseSseStream } from './sse';

interface AnthropicSseDelta {
  type: string;
  delta?: { type: string; text?: string };
  message?: { content?: Array<{ type: string; text?: string }> };
}

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',

  async *sendMessage(params: SendMessageParams): AsyncGenerator<StreamChunk, void, void> {
    const body = {
      model: params.model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      system: params.systemPrompt,
      stream: true,
      messages: params.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }))
    };

    const response = await fetch(PROVIDER_ENDPOINTS.anthropic.messages, {
      method: 'POST',
      signal: params.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey,
        'anthropic-version': PROVIDER_ENDPOINTS.anthropic.apiVersion,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await safeReadText(response);
      throw new Error(`Anthropic ${response.status}: ${errText}`);
    }

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
