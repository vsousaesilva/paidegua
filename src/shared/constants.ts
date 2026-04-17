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

/**
 * Perfis de trabalho. "Gabinete" expõe os atos baseados em modelos
 * (sentenças, decisões, despachos etc.) — é o comportamento histórico
 * da extensão. "Secretaria" substitui esses botões por ações próprias
 * do cartório/secretaria (a primeira é Triagem Inteligente).
 */
export const PROFILE_IDS = ['gabinete', 'secretaria'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export const PROFILE_LABELS: Record<ProfileId, string> = {
  gabinete: 'Gabinete',
  secretaria: 'Secretaria'
};

/** Perfil padrão na primeira instalação — preserva UX atual. */
export const DEFAULT_PROFILE: ProfileId = 'gabinete';

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
  MINUTAR_TRIAGEM: 'paidegua/minutar/triagem',
  /**
   * Content → background: pede a abertura da página de dashboard "Analisar
   * tarefas" em uma nova aba. O payload completo (já anonimizado para envio
   * à LLM, mas com nomes preservados para exibição local) é gravado em
   * `chrome.storage.session` antes de a aba ser aberta.
   */
  TRIAGEM_OPEN_DASHBOARD: 'paidegua/triagem/open-dashboard',
  /**
   * Dashboard → background: requisita os insights anonimizados do LLM a
   * partir dos agregados pré-calculados do painel.
   */
  TRIAGEM_INSIGHTS: 'paidegua/triagem/insights',
  /**
   * Content → background: análise do processo em curso contra os critérios
   * de triagem configurados pelo magistrado. Devolve veredito por critério
   * e (quando algum não é atendido) providências sugeridas para emenda.
   */
  ANALISAR_PROCESSO: 'paidegua/triagem/analisar-processo',
  /**
   * Content → background: dispara a automação que, na aba do PJe em que o
   * processo está aberto, aciona a transição "Comunicação - Elaborar
   * (emenda automática)" e injeta a minuta de emenda (HTML) no editor
   * Badon. O salvamento e a assinatura ficam com o usuário.
   */
  ENCAMINHAR_EMENDA: 'paidegua/triagem/encaminhar-emenda'
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
  LGPD_ACCEPTED: 'paidegua.lgpdAccepted',
  /**
   * Chave usada APENAS em `chrome.storage.session` (volátil — apagada ao
   * fechar o navegador) para entregar o payload do dashboard de triagem
   * para a aba que será aberta. Conteúdo de processos não vai para
   * `storage.local`.
   */
  TRIAGEM_DASHBOARD_PAYLOAD: 'paidegua.triagem.dashboardPayload'
} as const;

/** Limites de contexto (em caracteres aproximados, conservador). */
export const CONTEXT_LIMITS = {
  /** ~150k tokens ≈ 600k chars. */
  MAX_DOCUMENTS_CHARS: 600_000,
  /** Truncamento por documento individual quando o total estoura. */
  PER_DOCUMENT_HARD_CAP: 80_000
} as const;

/**
 * Critérios de análise inicial/triagem extraídos da Nota Técnica nº 1/2025
 * do Centro Local de Inteligência da Justiça Federal do Ceará. Cada critério
 * representa um bloco coerente do Anexo da NT — o magistrado decide, na aba
 * "Triagem Inteligente" do popup, se adota a redação padrão ou se descreve
 * seu próprio entendimento. O resultado é injetado dinamicamente nos prompts
 * das ações da Triagem Inteligente (Analisar tarefas, Analisar processo,
 * Inserir etiquetas mágicas).
 */
export interface TriagemCriterio {
  id: string;
  label: string;
  defaultText: string;
}

export const TRIAGEM_CRITERIOS = [
  {
    id: 'peticao-nomeacao',
    label: 'Nomeação correta da petição inicial e dos documentos',
    defaultText:
      'Nomeação correta da petição inicial e dos documentos que a acompanham, ' +
      'de modo que cada peça anexada permita identificação imediata pelo nome ' +
      'do arquivo no PJe.'
  },
  {
    id: 'renuncia-teto',
    label: 'Renúncia ao teto dos JEFs',
    defaultText:
      'Declaração de renúncia ao teto dos JEFs (60 salários-mínimos), exigida ' +
      'sempre que houver possibilidade de o valor da causa ultrapassar o limite ' +
      'de alçada do Juizado Especial Federal.'
  },
  {
    id: 'procuracao',
    label: 'Procuração',
    defaultText:
      'Procuração pública ou particular, emitida há no máximo um ano do ' +
      'ajuizamento da ação. No caso de autor analfabeto, procuração lavrada ' +
      'a rogo, com duas testemunhas e cópias dos documentos do rogante, ' +
      'rogado e testemunhas.'
  },
  {
    id: 'documentos-pessoais',
    label: 'Documentos pessoais',
    defaultText:
      'Documento oficial de identificação pessoal e CPF da parte autora.'
  },
  {
    id: 'comprovante-endereco',
    label: 'Comprovante de endereço',
    defaultText:
      'Comprovante de endereço emitido há no máximo um ano do ajuizamento da ' +
      'ação: contas de água, gás, energia elétrica, telefone (fixo ou móvel) ' +
      'ou fatura de cartão de crédito. Para comprovantes em nome de terceiros, ' +
      'declaração de moradia, exceto no caso de cônjuge (mediante certidão de ' +
      'casamento) ou de genitor (em caso de menores ou incapazes).'
  },
  {
    id: 'aposentadorias',
    label: 'Aposentadorias',
    defaultText:
      'Para ações de aposentadoria: comprovante de indeferimento do requerimento ' +
      'administrativo ou de requerimento com decurso de prazo sem análise; provas ' +
      'de qualidade de segurado e cumprimento da carência; indicação dos períodos ' +
      'e categoria de segurado do RGPS; autodeclaração de tempo de labor (em caso ' +
      'de segurado especial), com indicação de períodos e locais de trabalho; ' +
      'provas da exposição a agentes nocivos (PPPs, laudos técnicos etc.) quando ' +
      'houver alegação de tempo submetido a condições especiais de trabalho.'
  },
  {
    id: 'salario-maternidade',
    label: 'Salário-maternidade',
    defaultText:
      'Para ações de salário-maternidade: comprovante de indeferimento do ' +
      'requerimento administrativo ou de requerimento com decurso de prazo sem ' +
      'análise; provas de qualidade de segurada do RGPS; certidão de nascimento.'
  },
  {
    id: 'incapacidade',
    label: 'Benefícios previdenciários por incapacidade',
    defaultText:
      'Para benefícios por incapacidade: comprovante de indeferimento do ' +
      'requerimento administrativo ou de requerimento com decurso de prazo sem ' +
      'análise; pedido de prorrogação ou demonstração da impossibilidade do ' +
      'protocolo de prorrogação, em caso de alta programada ou concessão pelo ' +
      'INSS para período pretérito; provas de qualidade de segurado do RGPS; ' +
      'documentos médicos (atestados, laudos, exames etc.).'
  },
  {
    id: 'amparo-assistencial',
    label: 'Amparo assistencial (BPC/LOAS)',
    defaultText:
      'Para amparo assistencial: comprovante de indeferimento do requerimento ' +
      'administrativo ou de requerimento com decurso de prazo sem análise; ' +
      'declaração de composição e renda familiar conforme modelo disponibilizado ' +
      'no sítio eletrônico da Justiça Federal; CPF de todos os membros do grupo ' +
      'familiar informado na declaração; CadÚnico atualizado e correspondente ao ' +
      'grupo familiar declarado.'
  },
  {
    id: 'pensao-morte',
    label: 'Pensão por morte',
    defaultText:
      'Para pensão por morte: comprovante de indeferimento do requerimento ' +
      'administrativo ou de requerimento com decurso de prazo sem análise; provas ' +
      'de qualidade de segurado do RGPS do instituidor; certidão de óbito; prova ' +
      'da condição de dependente.'
  },
  {
    id: 'auxilio-reclusao',
    label: 'Auxílio-reclusão',
    defaultText:
      'Para auxílio-reclusão: comprovante de indeferimento do requerimento ' +
      'administrativo ou de requerimento com decurso de prazo sem análise; provas ' +
      'de qualidade de segurado do RGPS do instituidor; certidão judicial que ' +
      'ateste o efetivo recolhimento à prisão.'
  }
] as const satisfies readonly TriagemCriterio[];

export type TriagemCriterioId = (typeof TRIAGEM_CRITERIOS)[number]['id'];

export const TRIAGEM_CRITERIO_IDS: readonly TriagemCriterioId[] =
  TRIAGEM_CRITERIOS.map((c) => c.id);

/** Estado de cada critério para um magistrado: adota a NT ou define entendimento próprio. */
export interface TriagemCriterioSetting {
  adopted: boolean;
  customText: string;
}
