/**
 * Constantes globais da extensão pAIdegua.
 * Centralizar strings mágicas aqui facilita manutenção e testes.
 */

export const EXTENSION_NAME = 'pAIdegua';
export const LOG_PREFIX = '[pAIdegua]';

/**
 * Dominios institucionais aceitos no login. Qualquer e-mail fora desta lista
 * e rejeitado pelo backend antes mesmo de consultar a whitelist da planilha.
 * Mantenha em sincronia com `ALLOWED_DOMAINS` do `backend/apps-script/Code.gs`.
 */
export const AUTH_ALLOWED_DOMAINS: readonly string[] = [
  'trf5.jus.br',
  'jfce.jus.br',
  'jfrn.jus.br',
  'jfpb.jus.br',
  'jfpe.jus.br',
  'jfal.jus.br',
  'jfse.jus.br'
] as const;

/**
 * Periodo (ms) entre revalidacoes silenciosas do token contra o backend.
 * Permite revogar acesso na planilha sem esperar os 90 dias do JWT — na
 * proxima revalidacao a extensao detecta `revoked` e faz logout automatico.
 */
export const AUTH_REVALIDATE_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

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
 * do cartório/secretaria (a primeira é Triagem Inteligente). "Gestão"
 * é o perfil do diretor de secretaria: expõe, na tela do painel do
 * usuário do PJe, ferramentas de diagnóstico e alertas gerenciais
 * sobre a carga de trabalho.
 *
 * Regras de disponibilidade por grau (ver `shared/pje-host.ts`):
 *   - Gabinete: todos os graus
 *   - Gestão:   todos os graus
 *   - Secretaria: apenas 1º grau (pje1g). 2º grau e Turma Recursal
 *     continuam restritos por ora — avaliação futura.
 */
export const PROFILE_IDS = ['gabinete', 'secretaria', 'gestao'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export const PROFILE_LABELS: Record<ProfileId, string> = {
  gabinete: 'Gabinete',
  secretaria: 'Secretaria',
  gestao: 'Gestão'
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
  /**
   * Canais de autenticacao (whitelist Inovajus + OTP por e-mail).
   * Toda chamada a provedor de IA so prossegue se `AUTH_GET_STATUS` indicar
   * `authenticated: true` no momento do despacho — ver `requireAuth()` no
   * background.
   */
  AUTH_REQUEST_CODE: 'paidegua/auth/request-code',
  AUTH_VERIFY_CODE: 'paidegua/auth/verify-code',
  AUTH_GET_STATUS: 'paidegua/auth/get-status',
  AUTH_REVALIDATE: 'paidegua/auth/revalidate',
  AUTH_LOGOUT: 'paidegua/auth/logout',
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
  ENCAMINHAR_EMENDA: 'paidegua/triagem/encaminhar-emenda',
  /**
   * Content → background: pede para abrir a página "Salvar como modelo"
   * em uma nova aba, passando o HTML/texto da minuta via
   * `chrome.storage.session`. A página efetua a gravação no disco (pasta
   * de modelos do usuário) e o append no IndexedDB de templates.
   */
  TEMPLATES_SAVE_AS_MODEL: 'paidegua/templates/save-as-model',
  /**
   * Content → background: pede a abertura da página do Painel Gerencial
   * (perfil Gestão) em uma nova aba. O payload com os agregados coletados
   * é gravado em `chrome.storage.session` antes de a aba ser criada.
   */
  GESTAO_OPEN_DASHBOARD: 'paidegua/gestao/open-dashboard',
  /**
   * Dashboard gerencial → background: pede insights gerenciais à LLM a
   * partir do payload já sanitizado (mesma política do dashboard de
   * Triagem — ver `shared/triagem-anonymize.ts`).
   */
  GESTAO_INSIGHTS: 'paidegua/gestao/insights',
  /**
   * Content (aba PJe) → background: pede a abertura da aba intermediária
   * do Painel Gerencial (seletor + progresso). O background grava a lista
   * de tarefas em `chrome.storage.session`, cria a aba e memoriza o
   * relacionamento `{painelTabId ↔ pjeTabId}` para rotear as mensagens
   * posteriores. Evita o modal em shadow-DOM que ficava por trás do
   * sidebar da aplicação.
   */
  GESTAO_OPEN_PAINEL: 'paidegua/gestao/open-painel',
  /**
   * Aba-painel → background: o usuário confirmou a seleção de tarefas.
   * O background localiza o content script da aba PJe correspondente e
   * dispara `GESTAO_RUN_COLETA`.
   */
  GESTAO_START_COLETA: 'paidegua/gestao/start-coleta',
  /**
   * Background → content (aba PJe): inicia a varredura das tarefas
   * selecionadas. O content reporta progresso e resultado de volta via
   * `GESTAO_COLETA_PROG` / `GESTAO_COLETA_DONE` (ou `GESTAO_COLETA_FAIL`).
   */
  GESTAO_RUN_COLETA: 'paidegua/gestao/run-coleta',
  /**
   * Content (aba PJe) → background → aba-painel: atualização de progresso
   * textual. Roteada pelo background via `chrome.tabs.sendMessage`.
   */
  GESTAO_COLETA_PROG: 'paidegua/gestao/coleta-prog',
  /**
   * Content (aba PJe) → background: varredura concluída. O background
   * grava o payload final em `GESTAO_DASHBOARD_PAYLOAD` e manda a
   * aba-painel navegar para o dashboard.
   */
  GESTAO_COLETA_DONE: 'paidegua/gestao/coleta-done',
  /**
   * Background → aba-painel: aviso de que o payload foi gravado e a
   * página pode navegar para `gestao-dashboard.html`.
   */
  GESTAO_COLETA_READY: 'paidegua/gestao/coleta-ready',
  /**
   * Content (aba PJe) → background → aba-painel: varredura falhou. A
   * aba-painel exibe o erro e oferece nova tentativa / voltar ao seletor.
   */
  GESTAO_COLETA_FAIL: 'paidegua/gestao/coleta-fail',
  /**
   * Dashboard gerencial → background: aba do dashboard foi fechada
   * (evento `pagehide`), apague os payloads do IndexedDB para não
   * deixar resíduo em disco. Postura LGPD equivalente à antiga com
   * `storage.session`.
   */
  GESTAO_CLEAR_PAYLOADS: 'paidegua/gestao/clear-payloads',
  /**
   * Caller (qualquer content/painel) → background: pede para coletar os
   * expedientes abertos de UM processo a partir da URL dos autos. O
   * background abre uma aba inativa com a URL, aguarda o content script
   * daquela aba sinalizar pronto, envia `PRAZOS_FITA_EXTRAIR_NA_ABA` e
   * devolve ao chamador o resultado estruturado. Base da Fase A2 do
   * painel "Prazos na fita".
   */
  PRAZOS_FITA_COLETAR_PROCESSO: 'paidegua/prazos-fita/coletar-processo',
  /**
   * Background → content (aba recém-aberta do processo): comanda a
   * extração dos expedientes via adapter ativo. Content responde com
   * `{ ok, extracao, anomaliasProcesso }` ou `{ ok: false, error }`.
   */
  PRAZOS_FITA_EXTRAIR_NA_ABA: 'paidegua/prazos-fita/extrair-na-aba',
  /**
   * Bridge isolated-world → background: relay do snapshot de auth do
   * PJe capturado pelo interceptor page-world (`pje-auth-interceptor-page`)
   * a partir das chamadas REST reais do Angular do painel. Permite ao
   * background repetir essas chamadas com os mesmos headers (Authorization
   * Bearer + X-pje-cookies + X-pje-usuario-localizacao). Sem este snapshot,
   * o painel "Prazos na fita" cai de volta para o caminho de scraping.
   */
  PJE_AUTH_CAPTURED: 'paidegua/pje-api/auth-captured',
  /**
   * Canais do painel "Prazos na Fita pAIdegua" (perfil Gestão). Mesma
   * topologia do Painel Gerencial: o content abre a aba-painel (seletor
   * filtrado em "Controle de prazo") e, ao confirmar, o background
   * dispara a coleta via API REST no content do PJe.
   */
  PRAZOS_FITA_OPEN_PAINEL: 'paidegua/prazos-fita/open-painel',
  PRAZOS_FITA_START_COLETA: 'paidegua/prazos-fita/start-coleta',
  PRAZOS_FITA_RUN_COLETA: 'paidegua/prazos-fita/run-coleta',
  PRAZOS_FITA_COLETA_PROG: 'paidegua/prazos-fita/coleta-prog',
  PRAZOS_FITA_COLETA_DONE: 'paidegua/prazos-fita/coleta-done',
  PRAZOS_FITA_COLETA_READY: 'paidegua/prazos-fita/coleta-ready',
  PRAZOS_FITA_COLETA_FAIL: 'paidegua/prazos-fita/coleta-fail',
  /**
   * Streaming progressivo do dashboard "Prazos na Fita":
   *
   * - `PRAZOS_FITA_SKELETON_READY`: content (aba PJe) → background. Terminou
   *   a enumeracao de processos em todas as tarefas; o meta inicial (total,
   *   tarefasSelecionadas, hostname) ja esta gravado no IndexedDB com
   *   `status: 'running'`. O background encaminha um READY para a aba-painel,
   *   que redireciona imediatamente para o dashboard. O dashboard abre em
   *   segundos, com os cartoes em "0/N".
   *
   * - `PRAZOS_FITA_SLOT_PATCH`: content (aba PJe) → background → dashboard.
   *   Um processo acabou de ser coletado; o content grava o slot no IDB e
   *   emite este canal com `{ requestId, idx, item }`. O background roteia
   *   para o tab do dashboard. O dashboard agrega e re-renderiza com
   *   `requestAnimationFrame` (coalescente).
   *
   * - `PRAZOS_FITA_COLETA_FINALIZED`: content → background → dashboard.
   *   Varredura terminou (ok ou abort). Content ja gravou `status: 'done'`
   *   (ou 'aborted') no meta. Dashboard libera a coluna "Encerrar" e,
   *   em abort, mostra toast com opcao de retomar.
   */
  PRAZOS_FITA_SKELETON_READY: 'paidegua/prazos-fita/skeleton-ready',
  PRAZOS_FITA_SLOT_PATCH: 'paidegua/prazos-fita/slot-patch',
  PRAZOS_FITA_HYDRATE_SLOT: 'paidegua/prazos-fita/hydrate-slot',
  PRAZOS_FITA_COLETA_FINALIZED: 'paidegua/prazos-fita/coleta-finalized',
  /**
   * Aba do dashboard (pagehide) → background: pede para apagar o payload
   * do IndexedDB. Mesma postura LGPD do Painel Gerencial — agregados
   * não permanecem em disco depois do uso.
   */
  PRAZOS_FITA_CLEAR_PAYLOAD: 'paidegua/prazos-fita/clear-payload',
  /**
   * Aba-painel -> background -> content (aba PJe): consulta se existe um
   * checkpoint persistido em `storage.local` compativel com a assinatura
   * (nomes + filtros) que o usuario acabou de confirmar no seletor.
   * Devolve `{ hasState, concluidos, total, startedAt, updatedAt }` para
   * a aba-painel decidir se oferece retomar ou comecar do zero.
   */
  PRAZOS_FITA_QUERY_SCAN_STATE: 'paidegua/prazos-fita/query-scan-state',
  /**
   * Dashboard "Prazos na Fita" → background: pede para abrir a aba do PJe em
   * `movimentar.seam` da tarefa alvo e automatizar o encerramento de todos os
   * expedientes abertos. O background abre a aba com um marcador em `#hash`,
   * o content script do PJe reconhece o marcador e dispara a automação em
   * main world (monkey-patch de `confirm`, clique no header "selecionar todos"
   * e no botão "Encerrar expedientes selecionados"). Progresso e resultado
   * voltam ao dashboard via `PRAZOS_ENCERRAR_RESULT`.
   */
  PRAZOS_ENCERRAR_RUN: 'paidegua/prazos-fita/encerrar-run',
  /**
   * Content (aba do PJe na `movimentar.seam`) → background → dashboard: status
   * de uma tentativa de encerramento automático. Estados possíveis no payload:
   * `executando`, `sucesso`, `erro`, `nada-a-fazer`. O dashboard atualiza o
   * ícone da coluna e persiste o resultado em `PRAZOS_ENCERRAMENTOS`.
   */
  PRAZOS_ENCERRAR_RESULT: 'paidegua/prazos-fita/encerrar-result',
  /**
   * Canais da feature "Etiquetas Inteligentes" (perfil Secretaria /
   * Triagem Inteligente → botão Inserir etiquetas mágicas).
   *
   * O catálogo de etiquetas do PJe é buscado sob demanda a partir da
   * página de opções. O background encaminha a chamada para o content
   * script da aba PJe ativa (mesmo padrão do Painel Gerencial e do
   * Prazos na Fita — rodar same-origin é o que permite que os cookies
   * e o `X-pje-*` capturados pelo interceptor sejam aceitos pelo
   * servidor).
   */
  /** Options → background: pede para buscar o catálogo completo via API. */
  ETIQUETAS_FETCH_CATALOG: 'paidegua/etiquetas/fetch-catalog',
  /**
   * Background → content (aba PJe): executa a paginação do catálogo
   * via `listarEtiquetas` e devolve a lista consolidada.
   */
  ETIQUETAS_RUN_FETCH: 'paidegua/etiquetas/run-fetch',
  /**
   * Options/Triagem → background: reconstrói o índice BM25 das
   * etiquetas sugestionáveis após alteração no IndexedDB.
   */
  ETIQUETAS_INVALIDATE: 'paidegua/etiquetas/invalidate',
  /**
   * Content (Triagem Inteligente) → background: dada a lista de documentos
   * extraídos do processo em curso, pede à LLM a extração de marcadores
   * semânticos e roda o BM25 contra as etiquetas sugestionáveis. Devolve
   * os marcadores produzidos + as etiquetas ranqueadas (com a métrica de
   * similaridade e os marcadores que contribuíram para cada match).
   */
  ETIQUETAS_SUGERIR: 'paidegua/etiquetas/sugerir',
  /**
   * Canais da feature "Perícias pAIdegua" (perfil Secretaria → card
   * irmão da Triagem Inteligente). Mesma topologia do Painel Gerencial /
   * Prazos na Fita:
   *
   * - O content script do PJe dispara `PERICIAS_OPEN_PAINEL` passando a
   *   lista de tarefas do painel cujos nomes contêm "Perícia - Designar"
   *   ou "Perícia - Agendar e administrar". O background grava em
   *   `chrome.storage.session` e cria a aba da feature.
   * - Ao confirmar a configuração, a aba-painel emite
   *   `PERICIAS_START_COLETA` e o background dispara `PERICIAS_RUN_COLETA`
   *   no content script da aba PJe correspondente.
   * - O content reporta progresso via `PERICIAS_COLETA_PROG` e resultado
   *   final via `PERICIAS_COLETA_DONE` ou `PERICIAS_COLETA_FAIL`; o
   *   background grava o payload no IndexedDB e emite
   *   `PERICIAS_COLETA_READY` para a aba-painel navegar até o dashboard.
   * - Ao fechar o dashboard, `PERICIAS_CLEAR_PAYLOAD` apaga o payload —
   *   mesma postura LGPD dos demais dashboards.
   */
  PERICIAS_OPEN_PAINEL: 'paidegua/pericias/open-painel',
  PERICIAS_START_COLETA: 'paidegua/pericias/start-coleta',
  PERICIAS_RUN_COLETA: 'paidegua/pericias/run-coleta',
  PERICIAS_COLETA_PROG: 'paidegua/pericias/coleta-prog',
  PERICIAS_COLETA_DONE: 'paidegua/pericias/coleta-done',
  PERICIAS_COLETA_READY: 'paidegua/pericias/coleta-ready',
  PERICIAS_COLETA_FAIL: 'paidegua/pericias/coleta-fail',
  PERICIAS_CLEAR_PAYLOAD: 'paidegua/pericias/clear-payload',
  /**
   * Aba do dashboard de Perícias → background → content (aba PJe): aplica
   * a etiqueta da pauta (formato "DR(A) [NOME] DD.MM.AA") a um lote de
   * processos, criando a etiqueta se ainda não existir. Devolve por
   * processo o resultado (ok/erro). Depende de endpoints REST do PJe —
   * ver `pericias-etiqueta-applier.ts`.
   */
  PERICIAS_APLICAR_ETIQUETAS: 'paidegua/pericias/aplicar-etiquetas'
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
   * Token de autenticacao do usuario contra o backend Inovajus. Conteudo:
   * `{ jwt, email, expiresAt, lastValidatedAt }`. Sem este registro, o
   * background recusa qualquer chamada a provedor de IA.
   */
  AUTH: 'paidegua.auth',
  /**
   * Chave usada APENAS em `chrome.storage.session` (volátil — apagada ao
   * fechar o navegador) para entregar o payload do dashboard de triagem
   * para a aba que será aberta. Conteúdo de processos não vai para
   * `storage.local`.
   */
  TRIAGEM_DASHBOARD_PAYLOAD: 'paidegua.triagem.dashboardPayload',
  /**
   * Chave em `chrome.storage.session` (volátil) usada para entregar o
   * HTML da minuta para a página "Salvar como modelo". Conteúdo de
   * minutas NUNCA vai para `storage.local`.
   */
  SAVE_TEMPLATE_PAYLOAD: 'paidegua.saveTemplate.payload',
  /**
   * Chave em `chrome.storage.session` (volátil) usada para entregar o
   * payload agregado do Painel Gerencial (perfil Gestão) para a aba
   * que será aberta. Mesmo racional do `TRIAGEM_DASHBOARD_PAYLOAD`:
   * preserva nomes apenas localmente; o envio à LLM exige sanitização.
   */
  GESTAO_DASHBOARD_PAYLOAD: 'paidegua.gestao.dashboardPayload',
  /**
   * Chave em `chrome.storage.session` (volátil) com o payload JÁ ANONIMIZADO
   * do Painel Gerencial, pronto para enviar à LLM. Separado do
   * `GESTAO_DASHBOARD_PAYLOAD` (leve, usado para renderizar o dashboard)
   * para evitar estourar a quota de 10 MB do `storage.session` em unidades
   * com muitos processos — os campos pesados (última movimentação, polo
   * ativo etc.) só ficam aqui, na forma já sanitizada.
   */
  GESTAO_DASHBOARD_PAYLOAD_ANON: 'paidegua.gestao.dashboardPayloadAnon',
  /**
   * Chave em `chrome.storage.local` com a última seleção de tarefas do
   * Painel Gerencial (apenas nomes de tarefa — não é PII). Usada para
   * pré-marcar os checkboxes do seletor múltiplo ao reabrir.
   */
  GESTAO_TAREFAS_SELECIONADAS: 'paidegua.gestao.tarefasSelecionadas',
  /**
   * Prefixo de chave em `chrome.storage.session` com o estado da aba
   * intermediária do Painel Gerencial (lista de tarefas disponíveis para
   * seleção, origem do PJe). Indexado por `requestId` — a aba-painel lê
   * da chave `${PREFIX}${requestId}` ao carregar.
   */
  GESTAO_PAINEL_STATE_PREFIX: 'paidegua.gestao.painelState.',
  /**
   * Prefixo de chave em `chrome.storage.session` com o roteamento da aba
   * intermediária do Painel Gerencial (`requestId → {painelTabId, pjeTabId}`).
   * Precisa ser persistido porque o service worker do MV3 pode ser
   * suspenso durante a varredura (dezenas de segundos entre mensagens de
   * progresso é suficiente) — se dependêssemos de um Map em memória,
   * perderíamos a rota e `GESTAO_COLETA_DONE` chegaria sem destinatário.
   */
  GESTAO_PAINEL_ROUTE_PREFIX: 'paidegua.gestao.painelRoute.',
  /**
   * Chave em `chrome.storage.session` (volatil, sobrevive a hibernacao
   * do service worker mas nao a fechamento do navegador) com o ultimo
   * snapshot de auth do PJe capturado pelo interceptor. Permite ao
   * background reidratar a memoria apos hibernar sem precisar esperar o
   * usuario disparar uma nova chamada no painel.
   */
  PJE_AUTH_SNAPSHOT: 'paidegua.pjeAuth.snapshot',
  /**
   * DEPRECATED — chave legada do cache de `ca` (chaveAcessoProcesso).
   * O cache foi removido: no PJe TRF5 a `ca` expira silenciosamente no
   * servidor (resposta 200 com HTML stub em vez de 4xx), o que fazia a
   * coleta exibir "0 expedientes" sem erro visivel em ~99% dos processos.
   * A chave so permanece aqui para permitir a limpeza one-shot em
   * `limparCacheCaLegado` (prazos-fita-coordinator.ts) — remover em uma
   * versao futura quando nao houver mais instalacoes com a chave escrita.
   */
  PRAZOS_FITA_CA_CACHE: 'paidegua.prazosFita.caCache',
  /**
   * Mapa em `chrome.storage.local` com o estado por tarefa do encerramento
   * automatico acionado pelo painel "Prazos na Fita". Chave do mapa:
   * `${idProcesso}:${idTaskInstance}`. Valor: `{ estado, atualizadoEm,
   * quantidade?, mensagem? }`. Persistir em `local` (nao `session`) permite
   * que o dashboard, ao ser recarregado apos um F5, ja saiba quais linhas
   * ficaram verdes (sucesso) ou amarelas (erro) na ultima tentativa.
   */
  PRAZOS_ENCERRAMENTOS: 'paidegua.prazosFita.encerramentos',
  /**
   * Log de auditoria em `chrome.storage.local` com o historico de
   * encerramentos automaticos (timestamp, CNJ, idProcesso, idTaskInstance,
   * quantidade encerrada, estado final). Mantido apenas localmente — nao
   * vai para a LLM nem para nuvem. Serve para o proprio usuario conferir,
   * depois, o que foi fechado automaticamente pelo painel.
   */
  PRAZOS_ENCERRAR_AUDIT: 'paidegua.prazosFita.encerrarAudit',
  /**
   * Chave em `chrome.storage.local` com o ultimo relatorio de probe do
   * adapter Keycloak do PJe. Gravada pelo bridge isolated-world ao receber
   * o evento `paidegua:kc-probe` despachado pelo interceptor page-world.
   * Uso: decidir se a estrategia de refresh proativo via
   * `keycloak.updateToken()` e viavel no setup do tribunal — se nenhum
   * candidato for encontrado, recaimos no fluxo de espera + prompt.
   * Conteudo: `{ timestamp, url, angularVersion, foundAny, candidates[],
   * attemptedPaths[] }`. Nao contem tokens nem PII.
   */
  KEYCLOAK_PROBE: 'paidegua.keycloakProbe',
  /**
   * Chave em `chrome.storage.session` (volatil) usada pela hidratacao
   * progressiva de URLs dos autos nos dashboards (Triagem Inteligente +
   * Painel Gerencial). O content script abre o relatorio IMEDIATAMENTE
   * com processos sem link e, em segundo plano, resolve `ca` via
   * `gerarChaveAcessoProcesso` em lote, gravando mapas parciais nesta
   * chave. Os dashboards escutam `chrome.storage.onChanged` e atualizam
   * os cartoes progressivamente. Formato:
   * `{ scanId, status: 'running'|'done', updatedAt, urls: Record<idProcesso, string> }`.
   * Indexado por `scanId` para nao colidir com varreduras concorrentes.
   */
  DASHBOARD_URL_HYDRATION_PREFIX: 'paidegua.dashboardUrlHydration.',
  /**
   * Chave em `chrome.storage.local` com o log dos ultimos 50 diagnosticos
   * de HTTP 403 capturados por chamadas REST do PJe. Ring buffer (cap 50)
   * gravado por `pje-api-from-content.ts` sempre que um 403 sobe. Cada
   * entrada inclui idade do snapshot de auth, exp do JWT em cache,
   * presenca do JSESSIONID no document.cookie, resultado do silent SSO
   * (ok, erro detalhado do Keycloak, duracao) e trecho truncado do body.
   * Uso: card no painel de Diagnostico — permite analisar CAUSA provavel
   * de falhas em varreduras longas (JWT expirado e Angular nao renovou,
   * SSO session caducou, cookie KEYCLOAK_IDENTITY invalido, rede do SSO
   * indisponivel, etc.). Nao contem o Bearer token completo nem dados
   * de partes.
   */
  HTTP_403_LOG: 'paidegua.http403Log',
  /**
   * Chave em `chrome.storage.local` com o catálogo de peritos cadastrados
   * na feature "Perícias pAIdegua" (perfil Secretaria). Cada entrada tem
   * nome completo, nome explícito para compor a etiqueta, gênero (M/F
   * para DR/DRA), lista ordenada de etiquetas já cadastradas no PJe
   * (cascateamento da pauta), lista opcional de assuntos preferenciais,
   * quantidade-padrão por pauta e flag de ativo. O cadastro é do usuário
   * (escala em volume de peritos); etiquetas vinculadas são requisito
   * para gerar a pauta.
   */
  PERICIAS_PERITOS: 'paidegua.pericias.peritos',
  /**
   * Chave em `chrome.storage.local` com o catálogo acumulativo de
   * `assuntoPrincipal` observados nas coletas do painel de Perícias.
   * Alimenta o autocomplete do campo "Assuntos preferenciais" no cadastro
   * do perito. Estrutura: `{ version: 1, assuntos: string[] }`, ordenado
   * case-insensitive. Não contém dados pessoais — apenas nomes de
   * assuntos processuais (ex.: "Auxílio-Doença Previdenciário").
   */
  PERICIAS_ASSUNTOS_CATALOGO: 'paidegua.pericias.assuntosCatalogo',
  /**
   * Prefixo em `chrome.storage.session` (volátil) com o estado da
   * aba-painel de Perícias, indexado por `requestId`. Carrega as tarefas
   * detectadas e o snapshot de configuração de peritos — a aba lê da
   * chave `${PREFIX}${requestId}` ao abrir.
   */
  PERICIAS_PAINEL_STATE_PREFIX: 'paidegua.pericias.painelState.',
  /**
   * Prefixo em `chrome.storage.session` com o roteamento
   * `requestId → {painelTabId, pjeTabId}`. Mesma necessidade do
   * `GESTAO_PAINEL_ROUTE_PREFIX`: o service worker pode ser suspenso
   * entre mensagens de progresso e precisamos reidratar a rota sem
   * depender de um Map em memória.
   */
  PERICIAS_PAINEL_ROUTE_PREFIX: 'paidegua.pericias.painelRoute.',
  /**
   * Prefixo em `chrome.storage.session` com o payload da pauta gerada,
   * entregue para o dashboard de Perícias. Conteúdo: tarefas coletadas,
   * processos por perito (pauta), metadados. Apagado pelo
   * `PERICIAS_CLEAR_PAYLOAD` ao fechar o dashboard.
   */
  PERICIAS_DASHBOARD_PAYLOAD_PREFIX: 'paidegua.pericias.dashboardPayload.'
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
      'ajuizamento da ação. No caso de autor analfabeto ou impossibilitado ' +
      'de assinar, é válida a procuração particular lavrada a rogo, ' +
      'contendo (i) marcador textual de rogo (expressões como "a rogo", ' +
      '"assina o rogado", "a pedido de", "por não saber/poder assinar"), ' +
      '(ii) identificação do rogado (nome e CPF ou RG) e (iii) assinatura ' +
      'de ao menos duas testemunhas com nome e CPF ou RG, dispensado o ' +
      'instrumento público.'
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
