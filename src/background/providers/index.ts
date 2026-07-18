/**
 * Registry de provedores. O background script importa apenas daqui.
 */

import type { ProviderId } from '../../shared/constants';
import { anthropicProvider } from './anthropic';
import type { LLMProvider } from './base';
import { geminiProvider } from './gemini';
import { openaiProvider } from './openai';
import { withStreamGuard } from './stream-guard';

// withStreamGuard: keepalive do service worker MV3 + watchdog de primeiro
// token. Aplicado a todos os provedores para que nenhum call site precise
// repetir a protecao. Ver stream-guard.ts.
const REGISTRY: Record<ProviderId, LLMProvider> = {
  anthropic: withStreamGuard(anthropicProvider),
  openai: withStreamGuard(openaiProvider),
  gemini: withStreamGuard(geminiProvider)
};

export function getProvider(id: ProviderId): LLMProvider {
  return REGISTRY[id];
}
