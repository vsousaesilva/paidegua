/**
 * Constantes globais da extensão pAIdegua.
 * Centralizar strings mágicas aqui facilita manutenção e testes.
 */

export const EXTENSION_NAME = 'pAIdegua';
export const LOG_PREFIX = '[pAIdegua]';

/**
 * Padrões de domínio reconhecidos como instâncias do PJe.
 */
export const PJE_HOST_PATTERNS: readonly RegExp[] = [
  /^pje[a-z0-9-]*\.[a-z0-9-]+\.jus\.br$/i,
  /\.pje\.jus\.br$/i
];

/** Regex oficial do número único de processo (CNJ Resolução 65/2008). */
export const NUMERO_PROCESSO_REGEX = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;

/** Identificadores dos provedores de IA suportados. */
export const PROVIDER_IDS = ['anthropic', 'openai', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Provedor padrão na primeira instalação (definido pelo usuário em Fase 4). */
export const DEFAULT_PROVIDER: ProviderId = 'gemini';

/** Modelos disponíveis por provedor. */
export interface ModelInfo {
  id: string;
  label: string;
  /** true = recomendado / default para o provedor. */
  recommended?: boolean;
}

export const PROVIDER_MODELS: Record<ProviderId, readonly ModelInfo[]> = {
  anthropic: [
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 (mais capaz)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (equilibrado)', recommended: true },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (rápido)' }
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o (capaz)', recommended: true },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini (rápido)' }
  ],
  gemini: [
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (mais capaz)' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (equilibrado)', recommended: true },
    { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite (rápido)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (estável)' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (estável)' }
  ]
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  gemini: 'Google Gemini'
};

/** Endpoints oficiais usados por cada provedor (precisam estar em host_permissions). */
export const PROVIDER_ENDPOINTS = {
  anthropic: {
    messages: 'https://api.anthropic.com/v1/messages',
    apiVersion: '2023-06-01'
  },
  openai: {
    chat: 'https://api.openai.com/v1/chat/completions',
    transcriptions: 'https://api.openai.com/v1/audio/transcriptions',
    speech: 'https://api.openai.com/v1/audio/speech'
  },
  gemini: {
    base: 'https://generativelanguage.googleapis.com/v1beta'
  }
} as const;

/** Defaults gerais. */
// 32k cobre minutas longas (sentenças com fundamentação extensa) sem corte
// nos provedores atuais — Gemini 1.5/2.x/3.x suporta até 65k, Claude até
// 16-64k conforme o modelo, GPT-4o até 16k. Para sentenças assistenciais
// e previdenciárias com relatório+fundamentação completos o teto antigo
// (8192) cortava a peça no meio do dispositivo.
export const DEFAULT_MAX_TOKENS = 32768;
export const DEFAULT_TEMPERATURE = 0.3;

/** Canais de mensagem entre content script, background e popup. */
export const MESSAGE_CHANNELS = {
  PING: 'paidegua/ping',
  GET_SETTINGS: 'paidegua/get-settings',
  SAVE_SETTINGS: 'paidegua/save-settings',
  SAVE_API_KEY: 'paidegua/save-api-key',
  HAS_API_KEY: 'paidegua/has-api-key',
  REMOVE_API_KEY: 'paidegua/remove-api-key',
  TEST_CONNECTION: 'paidegua/test-connection',
  TRANSCRIBE_AUDIO: 'paidegua/transcribe-audio',
  SYNTHESIZE_SPEECH: 'paidegua/synthesize-speech',
  /** Content → background: pede para inserir conteúdo no editor do PJe. */
  INSERT_IN_PJE_EDITOR: 'paidegua/insert-in-pje-editor',
  /** Background → content (outras tabs): executa inserção local. */
  INSERT_IN_PJE_EDITOR_PERFORM: 'paidegua/insert-in-pje-editor-perform',
  /** Content → background: pergunta se há pasta de modelos configurada. */
  TEMPLATES_HAS_CONFIG: 'paidegua/templates/has-config',
  /** Content → background: busca templates por relevância (BM25). */
  TEMPLATES_SEARCH: 'paidegua/templates/search',
  /** Content → background: re-rank LLM dos candidatos BM25 (RAG híbrido). */
  TEMPLATES_RERANK: 'paidegua/templates/rerank',
  /** Options → background: avisa que o índice foi reconstruído (invalida cache). */
  TEMPLATES_INVALIDATE: 'paidegua/templates/invalidate',
  /** Content → background: chama o LLM para identificar nomes a anonimizar. */
  ANONYMIZE_NAMES: 'paidegua/anonymize/names',
  /** Content → background: triagem LLM para sugerir o melhor ato processual. */
  MINUTAR_TRIAGEM: 'paidegua/minutar/triagem'
} as const;

/** Nomes de portas long-lived (chat com streaming). */
export const PORT_NAMES = {
  CHAT_STREAM: 'paidegua/chat-stream'
} as const;

/** Mensagens trocadas via porta de chat. */
export const CHAT_PORT_MSG = {
  START: 'start',
  CHUNK: 'chunk',
  DONE: 'done',
  ERROR: 'error',
  ABORT: 'abort'
} as const;

/** Chaves usadas em chrome.storage. Conteúdo de processos NUNCA é persistido. */
export const STORAGE_KEYS = {
  SETTINGS: 'paidegua.settings',
  API_KEY_PREFIX: 'paidegua.apiKey.',
  LGPD_ACCEPTED: 'paidegua.lgpdAccepted'
} as const;

/** Limites de contexto (em caracteres aproximados, conservador). */
export const CONTEXT_LIMITS = {
  /** ~150k tokens ≈ 600k chars. */
  MAX_DOCUMENTS_CHARS: 600_000,
  /** Truncamento por documento individual quando o total estoura. */
  PER_DOCUMENT_HARD_CAP: 80_000
} as const;
