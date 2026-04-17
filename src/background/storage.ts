/**
 * Camada de persistência sobre chrome.storage.local.
 *
 * Responsabilidades:
 *  - Salvar/recuperar configurações (PAIdeguaSettings)
 *  - Salvar/recuperar API keys cifradas, uma por provedor
 *  - Verificar presença de chave sem expô-la
 *
 * Conteúdo de processos NUNCA passa por aqui.
 */

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_PROFILE,
  DEFAULT_PROVIDER,
  DEFAULT_TEMPERATURE,
  PROFILE_IDS,
  PROVIDER_IDS,
  PROVIDER_MODELS,
  STORAGE_KEYS,
  TRIAGEM_CRITERIOS,
  type ProviderId,
  type TriagemCriterioId,
  type TriagemCriterioSetting
} from '../shared/constants';
import type { PAIdeguaSettings } from '../shared/types';
import { decryptString, encryptString, type EncryptedBlob } from './crypto';

function defaultModelFor(provider: ProviderId): string {
  const models = PROVIDER_MODELS[provider];
  const recommended = models.find((m) => m.recommended);
  return (recommended ?? models[0]!).id;
}

function defaultTriagemCriterios(): Record<TriagemCriterioId, TriagemCriterioSetting> {
  const map = {} as Record<TriagemCriterioId, TriagemCriterioSetting>;
  for (const c of TRIAGEM_CRITERIOS) {
    map[c.id] = { adopted: true, customText: '' };
  }
  return map;
}

export function defaultSettings(): PAIdeguaSettings {
  const models = {} as Record<ProviderId, string>;
  for (const id of PROVIDER_IDS) {
    models[id] = defaultModelFor(id);
  }
  return {
    activeProvider: DEFAULT_PROVIDER,
    models,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    useStreaming: true,
    ttsVoice: '',
    lgpdAccepted: false,
    ocrAutoRun: false,
    ocrMaxPages: 30,
    defaultProfile: DEFAULT_PROFILE,
    triagemCriterios: defaultTriagemCriterios(),
    triagemCriteriosCustom: []
  };
}

export async function getSettings(): Promise<PAIdeguaSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const stored = result[STORAGE_KEYS.SETTINGS] as Partial<PAIdeguaSettings> | undefined;
  const base = defaultSettings();
  if (!stored) {
    return base;
  }
  // Merge defensivo: garante que novos campos adicionados em versões futuras
  // tenham um valor sensato mesmo com storage antigo. Modelos descontinuados
  // (ex.: gemini-2.5-* substituído por 3.1-*) caem no default do provedor.
  const mergedModels = { ...base.models, ...(stored.models ?? {}) };
  for (const id of PROVIDER_IDS) {
    const valid = PROVIDER_MODELS[id].some((m) => m.id === mergedModels[id]);
    if (!valid) {
      mergedModels[id] = defaultModelFor(id);
    }
  }
  // Migração: usuários instalados quando o teto era 8192 ficavam com
  // sentenças longas truncadas. Sobe automaticamente o saved value para
  // o novo default quando estiver no piso antigo, preservando ajustes
  // explícitos acima disso.
  const storedMaxTokens =
    typeof stored.maxTokens === 'number' && stored.maxTokens > 8192
      ? stored.maxTokens
      : DEFAULT_MAX_TOKENS;

  // Defensivo: instalações pré-perfis não têm `defaultProfile`; valida
  // também contra valores inesperados vindos de storage corrompido.
  const storedProfile =
    typeof stored.defaultProfile === 'string' &&
    (PROFILE_IDS as readonly string[]).includes(stored.defaultProfile)
      ? stored.defaultProfile
      : DEFAULT_PROFILE;

  // Critérios de triagem: instalações antigas não têm o campo. Garante todos
  // os ids da NT atual com default `adopted=true` e preserva escolhas já
  // feitas. Critérios desconhecidos vindos do storage são descartados.
  const mergedCriterios = base.triagemCriterios;
  const storedCriterios = stored.triagemCriterios;
  if (storedCriterios && typeof storedCriterios === 'object') {
    for (const c of TRIAGEM_CRITERIOS) {
      const v = (storedCriterios as Record<string, unknown>)[c.id];
      if (v && typeof v === 'object') {
        const adopted =
          typeof (v as TriagemCriterioSetting).adopted === 'boolean'
            ? (v as TriagemCriterioSetting).adopted
            : true;
        const customText =
          typeof (v as TriagemCriterioSetting).customText === 'string'
            ? (v as TriagemCriterioSetting).customText
            : '';
        mergedCriterios[c.id] = { adopted, customText };
      }
    }
  }

  // Critérios livres: aceita apenas itens com id e texto string. Itens
  // sem id estável recebem um derivado do índice para sobreviver a
  // re-renderizações do popup.
  const storedCustom = Array.isArray(stored.triagemCriteriosCustom)
    ? stored.triagemCriteriosCustom
        .map((item, i) => {
          if (!item || typeof item !== 'object') return null;
          const obj = item as { id?: unknown; text?: unknown };
          const text = typeof obj.text === 'string' ? obj.text : '';
          const id =
            typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : `custom-${i}-${Date.now()}`;
          return { id, text };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    : [];

  return {
    ...base,
    ...stored,
    models: mergedModels,
    maxTokens: storedMaxTokens,
    defaultProfile: storedProfile,
    triagemCriterios: mergedCriterios,
    triagemCriteriosCustom: storedCustom
  };
}

export async function saveSettings(settings: PAIdeguaSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

function apiKeyStorageKey(provider: ProviderId): string {
  return `${STORAGE_KEYS.API_KEY_PREFIX}${provider}`;
}

export async function saveApiKey(provider: ProviderId, plainKey: string): Promise<void> {
  const blob = await encryptString(plainKey);
  await chrome.storage.local.set({ [apiKeyStorageKey(provider)]: blob });
}

export async function getApiKey(provider: ProviderId): Promise<string | null> {
  const key = apiKeyStorageKey(provider);
  const result = await chrome.storage.local.get(key);
  const blob = result[key] as EncryptedBlob | undefined;
  if (!blob || !blob.iv || !blob.ct) {
    return null;
  }
  try {
    return await decryptString(blob);
  } catch {
    return null;
  }
}

export async function hasApiKey(provider: ProviderId): Promise<boolean> {
  const key = apiKeyStorageKey(provider);
  const result = await chrome.storage.local.get(key);
  const blob = result[key] as EncryptedBlob | undefined;
  return Boolean(blob && blob.iv && blob.ct);
}

export async function removeApiKey(provider: ProviderId): Promise<void> {
  await chrome.storage.local.remove(apiKeyStorageKey(provider));
}

export async function getAllApiKeyPresence(): Promise<Record<ProviderId, boolean>> {
  const presence = {} as Record<ProviderId, boolean>;
  for (const id of PROVIDER_IDS) {
    presence[id] = await hasApiKey(id);
  }
  return presence;
}
