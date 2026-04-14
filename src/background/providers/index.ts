/**
 * Registry de provedores. O background script importa apenas daqui.
 */

import type { ProviderId } from '../../shared/constants';
import { anthropicProvider } from './anthropic';
import type { LLMProvider } from './base';
import { geminiProvider } from './gemini';
import { openaiProvider } from './openai';

const REGISTRY: Record<ProviderId, LLMProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider
};

export function getProvider(id: ProviderId): LLMProvider {
  return REGISTRY[id];
}
