/**
 * Tipos TypeScript compartilhados entre content script, background e popup.
 * Mantém contratos explícitos — strict mode sem `any`.
 */

import type {
  ProfileId,
  ProviderId,
  TriagemCriterioId,
  TriagemCriterioSetting
} from './constants';

/** Resultado da detecção de uma página do PJe. */
export interface PJeDetection {
  isPJe: boolean;
  version: 'legacy' | 'pje2' | 'unknown';
  tribunal: string;
  grau: '1g' | '2g' | 'turma_recursal' | 'unknown';
  isProcessoPage: boolean;
  numeroProcesso: string | null;
  baseUrl: string;
  /**
   * True quando a aba atual é (ou contém como iframe) o painel do
   * usuário interno do PJe — a única tela em que as ações do perfil
   * Gestão (e a ação "Analisar tarefas" do perfil Secretaria) têm
   * dados para varrer. Em outras telas as seções do perfil Gestão
   * são ocultadas via CSS pela sidebar.
   */
  isPainelUsuario: boolean;
}

/** Documento processual extraído dos autos digitais. */
export interface ProcessoDocumento {
  id: string;
  tipo: string;
  descricao: string;
  dataMovimentacao: string;
  mimeType: string;
  url: string;
  tamanho?: number;
  isScanned?: boolean;
  textoExtraido?: string;
}

/** Mensagens no chat com a IA. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

/** Configurações persistidas do usuário. */
export interface PAIdeguaSettings {
  activeProvider: ProviderId;
  /** Modelo selecionado por provedor. */
  models: Record<ProviderId, string>;
  temperature: number;
  maxTokens: number;
  useStreaming: boolean;
  /** Voz preferida para TTS (id depende do provedor; '' = automática). */
  ttsVoice: string;
  lgpdAccepted: boolean;
  /** Roda OCR automaticamente após extração quando há PDFs digitalizados. */
  ocrAutoRun: boolean;
  /** Máximo de páginas que o OCR processa por documento (cap de segurança). */
  ocrMaxPages: number;
  /**
   * Perfil padrão ao abrir a extensão (Gabinete ou Secretaria). O sidebar
   * permite alternar na sessão corrente via seletor, mas ao reabrir volta
   * para este valor.
   */
  defaultProfile: ProfileId;
  /**
   * Critérios de análise inicial da NT 1/2025 do CLI-JFCE. Para cada
   * critério, o magistrado decide se adota a redação padrão (`adopted: true`)
   * ou se substitui pelo seu entendimento próprio (`customText`). Esses
   * valores são injetados nos prompts da Triagem Inteligente.
   */
  triagemCriterios: Record<TriagemCriterioId, TriagemCriterioSetting>;
  /**
   * Critérios adicionais livres, definidos pelo magistrado além dos da
   * NT 1/2025. Cada item tem id estável (para edição/remoção) e o texto
   * livre que o juiz escreveu.
   */
  triagemCriteriosCustom: TriagemCriterioCustom[];
  /**
   * Orientações em texto livre que o usuário redige na aba "Etiquetas
   * Inteligentes" para guiar a extração de MARCADORES pela LLM antes do
   * de-para BM25. Fica vazio por padrão; quando preenchido, é injetado
   * no prompt do extrator de marcadores.
   */
  etiquetasPromptCriterios: string;
}

/** Critério livre criado pelo magistrado, fora do conjunto da NT 1/2025. */
export interface TriagemCriterioCustom {
  id: string;
  text: string;
}

/** Ação rápida customizável (botão de um clique). */
export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
  builtin: boolean;
}

/** Envelope genérico para mensagens entre os contextos da extensão. */
export interface ExtensionMessage<T = unknown> {
  channel: string;
  payload: T;
  requestId?: string;
}

/** Payload enviado ao iniciar uma conversa via porta de chat. */
export interface ChatStartPayload {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  documents: ProcessoDocumento[];
  numeroProcesso: string | null;
  temperature?: number;
  maxTokens?: number;
}

/** Resultado de uma chamada de teste de conexão. */
export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  modelEcho?: string;
}

/** Payload de transcrição de áudio. */
export interface TranscribeAudioPayload {
  provider: ProviderId;
  /** Áudio codificado em base64 (data URL sem prefixo). */
  audioBase64: string;
  mimeType: string;
}

/** Payload de síntese de voz. */
export interface SynthesizeSpeechPayload {
  provider: ProviderId;
  text: string;
  voice?: string;
}

/** Resposta de síntese de voz: ou audio em base64, ou flag para usar fallback local. */
export interface SynthesizeSpeechResult {
  ok: boolean;
  audioBase64?: string;
  mimeType?: string;
  useBrowserFallback?: boolean;
  error?: string;
}

// =====================================================================
// Dashboard "Analisar tarefas" — perfil Secretaria
// =====================================================================

/**
 * Cartão de processo coletado de uma tarefa do painel do usuário.
 *
 * IMPORTANTE: este objeto contém dados sensíveis (nomes das partes).
 * Não enviar a APIs externas sem passar antes por
 * `sanitizeProcessoForLLM` (ver `shared/triagem-anonymize.ts`).
 */
export interface TriagemProcesso {
  /** ID interno do PJe (extraído do `<span class="hidden" id="...">`). */
  idProcesso: string;
  /**
   * ID da TaskInstance corrente (equivalente ao `newTaskId` que o PJe usa
   * em `movimentar.seam?idProcesso=X&newTaskId=Y` para abrir a tarefa).
   * Populado apenas no caminho da API REST — o fallback DOM não consegue
   * separar `idProcesso` de `idTaskInstance`, então aqui vem null.
   */
  idTaskInstance: string | null;
  /** Número CNJ (ex: "PJEC 0001019-74.2026.4.05.8109"). */
  numeroProcesso: string;
  /** Classe / assunto curto (linha logo após o número, ex: "Indenização por Dano Moral"). */
  assunto: string;
  /** Texto bruto do bloco `.orgao` (vara, juiz, etc.). */
  orgao: string;
  /** Polo ativo (nomes — sensível). */
  poloAtivo: string;
  /** Polo passivo (nomes ou ente público). */
  poloPassivo: string;
  /** Data de entrada na tarefa, formato `dd-mm-aa`. */
  dataEntradaTarefa: string | null;
  /** Dias decorridos desde a entrada na tarefa (extraído de `(N)`). */
  diasNaTarefa: number | null;
  /** Data do último movimento, formato `dd-mm-aa`. */
  dataUltimoMovimento: string | null;
  diasUltimoMovimento: number | null;
  /** Data de conclusão, formato `dd-mm-aa`. */
  dataConclusao: string | null;
  diasDesdeConclusao: number | null;
  /** Texto da última movimentação (ex: "Juntada de Petição..."). */
  ultimaMovimentacaoTexto: string | null;
  /** True quando o cartão exibe o ícone fa-arrow-circle-up (prioritário). */
  prioritario: boolean;
  /** True quando há sigilo declarado nos `sr-only`. */
  sigiloso: boolean;
  /** Etiquetas aplicadas (texto). */
  etiquetas: string[];
  /** URL para abrir os autos em nova aba. */
  url: string;
}

/** Conjunto de processos lidos de uma tarefa específica. */
export interface TriagemTarefaSnapshot {
  /** Texto exato do `<span class="nome">` da tarefa (ex: "Analisar inicial - JEF"). */
  tarefaNome: string;
  /** Quantos cartões foram efetivamente lidos. */
  totalLido: number;
  /** True quando a leitura parou por limite de páginas/segurança. */
  truncado: boolean;
  /** Quantas páginas foram lidas (paginação). */
  paginasLidas?: number;
  /** Mensagem do motivo do encerramento da paginação (debug). */
  motivoFimPaginacao?: string;
  processos: TriagemProcesso[];
}

/** Payload completo gerado pelo content e gravado em storage.session. */
export interface TriagemDashboardPayload {
  /** ISO timestamp de quando os dados foram coletados. */
  geradoEm: string;
  /** Hostname da instância PJe (ex: "pje1g.trf5.jus.br"). */
  hostnamePJe: string;
  tarefas: TriagemTarefaSnapshot[];
  /** Total geral de processos. */
  totalProcessos: number;
  /** Insights gerados pela LLM (sobre dados anonimizados). null = ainda carregando. */
  insightsLLM: TriagemInsightsLLM | null;
}

/** Saída do LLM com sugestões de ação sobre os dados agregados anonimizados. */
export interface TriagemInsightsLLM {
  /** 2-4 frases de leitura geral do panorama (sem citar nomes). */
  panorama: string;
  /** Sugestões priorizadas de próximos passos. */
  sugestoes: TriagemSugestao[];
}

export interface TriagemSugestao {
  /** Título curto da sugestão. */
  titulo: string;
  /** Detalhamento (1-3 frases). */
  detalhe: string;
  /** Prioridade percebida pelo modelo. */
  prioridade: 'alta' | 'media' | 'baixa';
}

// =====================================================================
// "Analisar o processo" — botão da Triagem Inteligente (Secretaria)
// =====================================================================

/** Avaliação de um único critério no contexto do processo em análise. */
export interface AnaliseCriterio {
  /**
   * Identificador do critério. Para os 11 critérios da NT 1/2025 do CLI-JFCE
   * vem o id estável (ex.: "procuracao", "comprovante-endereco"); para
   * critérios livres adicionados pelo magistrado vem `custom-N` (índice
   * 1-based dentro de `triagemCriteriosCustom`).
   */
  id: string;
  /** Rótulo curto do critério (replica o `label` do critério adotado). */
  label: string;
  /** True quando o LLM considera o critério satisfeito pelos autos. */
  atendido: boolean;
  /**
   * Justificativa em 1-3 linhas, citando explicitamente os ids dos
   * documentos que embasam a conclusão (ex.: "id 152717156").
   */
  justificativa: string;
  /**
   * Texto imperativo já formatado para entrar como tópico no ato de
   * emenda à inicial (ex.: "apresentar comprovante de endereço emitido
   * nos últimos 12 meses"). Obrigatoriamente preenchido quando
   * `atendido === false`; ignorado caso contrário.
   */
  providenciaSolicitada?: string;
}

/** Resposta estruturada do LLM para o botão "Analisar o processo". */
export interface AnaliseProcessoResult {
  /**
   * Veredito global da análise. "parcialmente" indica que pelo menos um
   * critério não foi atendido, mas outros foram. Quando ao menos um item
   * estiver com `atendido === false`, o veredito NÃO pode ser "atendido".
   */
  veredito: 'atendido' | 'parcialmente' | 'nao_atendido';
  /** Panorama curto (1-2 frases), sem citar nomes das partes. */
  panorama: string;
  /** Avaliação detalhada por critério (mesma ordem da configuração). */
  criterios: AnaliseCriterio[];
  /**
   * Itens que o servidor deve verificar no PDF original por limitação do
   * OCR ou da análise automatizada (ex.: nomes manuscritos em procuração
   * a rogo, data de assinatura ilegível). Sempre presente; pode ser [].
   */
  pontosDeConferenciaHumana: string[];
  /**
   * Divergências objetivas entre o cadastro do sistema processual e os
   * documentos anexos (ex.: CPF do cadastro diverge do documento). Não
   * contamina o veredito; serve de alerta para conferência humana.
   * Sempre presente; pode ser [].
   */
  divergenciasCadastrais: string[];
  /**
   * Situações que merecem atenção do servidor/magistrado mas fogem do
   * binário atendido/não atendido (ex.: possível incompetência, valor da
   * causa, prevenção). Não afeta o veredito global. Sempre presente;
   * pode ser [].
   */
  alertasEspeciais: string[];
}

// =====================================================================
// Painel Gerencial — perfil Gestão
// =====================================================================

/**
 * Metadados de uma tarefa disponível no painel do usuário, usados pelo
 * seletor múltiplo do perfil Gestão. Capturado antes da varredura para
 * permitir que o magistrado escolha exatamente quais tarefas incluir no
 * dashboard gerencial — diferente da Triagem (perfil Secretaria) que
 * aplica um filtro fixo via `TAREFA_REGEX`.
 */
export interface GestaoTarefaInfo {
  /** Texto exato do `<span class="nome">` da tarefa. */
  nome: string;
  /** Quantidade exibida no badge da tarefa (quando disponível). */
  quantidade: number | null;
}

/** Configuração escolhida pelo usuário antes de disparar a coleta gerencial. */
export interface GestaoSelecaoTarefas {
  /** Nomes exatos (como aparecem no `<span class="nome">`) selecionados. */
  tarefasSelecionadas: string[];
  /** ISO timestamp da última seleção (para mostrar no dashboard). */
  salvoEm: string;
}

/**
 * Resultado agregado exibido no dashboard gerencial. Reaproveita o
 * mesmo formato de `TriagemTarefaSnapshot` para os cartões, mas agrupa
 * por tarefa selecionada pelo usuário e agrega indicadores no topo.
 */
export interface GestaoDashboardPayload {
  /** ISO timestamp de quando os dados foram coletados. */
  geradoEm: string;
  /** Hostname da instância PJe (ex: "pje1g.trf5.jus.br"). */
  hostnamePJe: string;
  /** Nomes das tarefas efetivamente varridas (subset da seleção do usuário). */
  tarefasSelecionadas: string[];
  /** Snapshots completos por tarefa. */
  tarefas: TriagemTarefaSnapshot[];
  /** Total geral de processos varridos. */
  totalProcessos: number;
  /** Indicadores agregados calculados localmente (sem LLM). */
  indicadores: GestaoIndicadores;
  /** Insights gerados pela LLM (sobre dados anonimizados). null = carregando. */
  insightsLLM: GestaoInsightsLLM | null;
}

/**
 * Indicadores determinísticos calculados no próprio navegador, a partir
 * do payload anonimizado ou não — nenhum vai para a LLM. Servem para
 * alimentar cards de alerta e gráficos antes (e independentemente) de
 * qualquer resposta da IA.
 */
export interface GestaoIndicadores {
  /** Processos cujo `diasNaTarefa` excede o limiar configurado. */
  atrasados: number;
  /** Limiar de dias considerado "atraso" (padrão 30). */
  limiarAtrasoDias: number;
  /** Processos marcados como prioritários nos cartões. */
  prioritarios: number;
  /** Processos com sigilo declarado. */
  sigilosos: number;
  /** Contagem por tarefa: mapeia nome da tarefa → total de processos. */
  porTarefa: Record<string, number>;
  /** Top 5 etiquetas mais frequentes. */
  topEtiquetas: Array<{ etiqueta: string; total: number }>;
}

/** Saída do LLM com leitura gerencial sobre indicadores anonimizados. */
export interface GestaoInsightsLLM {
  /** Leitura geral (2-4 frases) — nunca cita nomes. */
  panorama: string;
  /** Alertas priorizados para atenção imediata. */
  alertas: GestaoAlerta[];
  /** Sugestões de reorganização/distribuição de trabalho. */
  sugestoes: GestaoSugestao[];
}

export interface GestaoAlerta {
  titulo: string;
  detalhe: string;
  severidade: 'alta' | 'media' | 'baixa';
}

export interface GestaoSugestao {
  titulo: string;
  detalhe: string;
  prioridade: 'alta' | 'media' | 'baixa';
}

// =====================================================================
// Painel "Prazos na fita" — perfil Gestão (controle de prazos abertos)
// =====================================================================

/**
 * Mapeamento normalizado da natureza do prazo extraída de
 * `span[title^="Data limite prevista"]` no PJe.
 *
 * - `manifestacao`: prazo já iniciou; data é o último dia para a parte
 *   praticar o ato (PJe expressa como "para manifestação").
 * - `ciencia`: parte ainda não registrou ciência; data é o limite para
 *   ela tomar ciência. Quando a parte registra OU o prazo decorre, o
 *   PJe deveria converter automaticamente para `manifestacao`.
 * - `outro`: forma não reconhecida pelo enum (preserva o literal em
 *   `naturezaPrazoLiteral`).
 */
export type NaturezaPrazo = 'manifestacao' | 'ciencia' | 'outro';

/**
 * Estado legítimo de um expediente ABERTO. O painel só armazena
 * expedientes com `fechado=NÃO` — os fechados são apenas contados para
 * derivar a anomalia `todos_prazos_encerrados`. Por isso não existe
 * status `prazo_encerrado`. Estados "vencido" / "ciência vencida"
 * também não viram status próprio: o PJe deveria ter feito a transição,
 * então quando aparecem caem em `indeterminado` + anomalia.
 */
export type StatusPrazo =
  | 'aguardando_ciencia'
  | 'prazo_correndo'
  | 'sem_prazo'
  | 'indeterminado';

/**
 * Quem registrou a ciência:
 *  - 'servidor': pessoa física identificada pelo nome (ex.: procurador).
 *  - 'sistema': ficta clássica do PJe — texto literal "O sistema registrou ciência".
 *  - 'domicilio_eletronico': ciência automática pelo portal de Domicílio
 *    Eletrônico — o PJe registra com o "usuário" literal
 *    "Usuário Domicílio Eletrônico". Não é servidor humano nem o sistema
 *    PJe em si; é um perfil automatizado do portal.
 */
export type CienciaAutor = 'servidor' | 'sistema' | 'domicilio_eletronico';

/**
 * Linha ABERTA da aba Expedientes de um processo, normalizada para o
 * painel "Prazos na fita". Construída por
 * `PJeLegacyAdapter.extractExpedientes()` apenas para linhas em que a
 * coluna FECHADO é NÃO. Linhas com FECHADO=SIM não viram instâncias
 * desta interface — são contadas em `ExpedientesExtracao.fechados`.
 *
 * IMPORTANTE: contém PII (nomes de partes, servidores). Não enviar a
 * APIs externas sem anonimização.
 */
export interface ProcessoExpediente {
  /** ID do documento de comunicação (parsed de "Tipo (XXX)"). Chave da linha. */
  idDocumento: string;
  /** ID do ProcessoParteExpediente quando localizável no DOM. */
  idProcessoParteExpediente: string | null;
  /** Literal do tipo do ato (ex: "Intimação", "Sentença", "Citação"). */
  tipoAto: string;
  /** Nome do destinatário (parte ou órgão). */
  destinatario: string;
  /** Representante quando declarado (ex: "Procuradoria Geral Federal (PGF/AGU)"). */
  representante: string | null;
  /** Meio de comunicação (ex: "Expedição eletrônica", "Diário Eletrônico"). */
  meio: string;
  /** Data/hora de expedição (string crua do PJe, dd/mm/aaaa hh:mm:ss). */
  dataExpedicao: string;
  /** True quando há "registrou ciência" no DOM. */
  cienciaRegistrada: boolean;
  /** Servidor (pessoa) ou sistema (ficta). null quando não há ciência. */
  cienciaAutor: CienciaAutor | null;
  /** Nome do servidor que registrou. null quando ficta ou ausente. */
  cienciaServidor: string | null;
  /** Data/hora do registro (string crua, dd/mm/aaaa hh:mm:ss). null quando ausente. */
  cienciaDataHora: string | null;
  /** Prazo em dias declarado pelo PJe. null quando "sem prazo". */
  prazoDias: number | null;
  /** Data/hora limite (string crua). null quando "sem prazo". */
  dataLimite: string | null;
  /** Literal cru do `span[title]`/texto entre parênteses. Preserva valores fora do enum. */
  naturezaPrazoLiteral: string | null;
  /** Mapeamento normalizado para enum. null quando não identificável. */
  naturezaPrazo: NaturezaPrazo | null;
  /** Status derivado. Função pura sobre os campos acima + data atual. */
  status: StatusPrazo;
  /** Rótulos curtos das anomalias detectadas. Vazio quando consistente. */
  anomalias: ProcessoExpedienteAnomalia[];
}

/**
 * Resultado da varredura da aba Expedientes de um processo.
 * `abertos` traz só as linhas FECHADO=NÃO totalmente parseadas.
 * `fechados` é a contagem das linhas FECHADO=SIM (não parseadas).
 *
 * Permite derivar a anomalia de processo `todos_prazos_encerrados` sem
 * precisar carregar dados de expedientes que o painel não mostra.
 */
export interface ExpedientesExtracao {
  abertos: ProcessoExpediente[];
  fechados: number;
}

/**
 * Catálogo fechado de anomalias atualmente detectadas pelo parser.
 * Cada rótulo é estável e usado tanto no filtro Layer 2 do painel quanto
 * em badges visuais. Adicionar novos rótulos aqui antes de usar no código.
 *
 * - `prazo_vencido_aberto`: expediente FECHADO=NÃO cuja data limite de
 *   manifestação já passou. Interpretação de negócio: **possível falha
 *   do job Quartz do PJe** que deveria ter fechado o expediente ao expirar
 *   o prazo. O label humano exibido no painel deve refletir essa causa
 *   (ex.: "Possível problema no Quartz"), mesmo que o enum técnico
 *   descreva o fenômeno observável.
 * - `ciencia_nao_convertida`: ciência expressa ainda marcada como
 *   aguardando mesmo após a data limite. O PJe deveria ter convertido
 *   automaticamente para "para manifestação" — outra suspeita de Quartz.
 * - `prazo_definido_sem_data_limite`: `prazoDias > 0` sem `dataLimite`
 *   ou `naturezaPrazo` — indica parse incompleto ou estado inconsistente
 *   do próprio expediente.
 * - `prazo_sem_prazo_com_data`: literal "Prazo: sem prazo" convivendo
 *   com uma `dataLimite` — contradição interna do expediente.
 */
export type ProcessoExpedienteAnomalia =
  | 'prazo_vencido_aberto'
  | 'ciencia_nao_convertida'
  | 'prazo_definido_sem_data_limite'
  | 'prazo_sem_prazo_com_data';

/**
 * Anomalias de nível PROCESSO — derivadas da agregação dos expedientes
 * de um mesmo processo, não de um expediente isolado.
 *
 * - `todos_prazos_encerrados`: o processo está numa tarefa de "Controle
 *   de prazo" mas TODOS os seus expedientes estão FECHADO=SIM
 *   (`extracao.abertos.length === 0` com `extracao.fechados > 0`). Não
 *   há mais prazo ativo a controlar — o processo deveria ter sido
 *   movido para fora dessa tarefa.
 */
export type ProcessoAnomalia = 'todos_prazos_encerrados';

/**
 * Resultado da coleta de UM processo na Fase A2 do painel "Prazos na fita".
 *
 * Estruturado para ser agregável: quando `ok=false`, `extracao` e
 * `anomaliasProcesso` ficam ausentes e `error` traz a mensagem. Quando
 * `ok=true`, `extracao` reflete o resultado de `extractExpedientes()`
 * e `anomaliasProcesso` o de `derivarAnomaliasProcesso()`.
 *
 * O `numeroProcesso` pode vir `null` quando o adapter não conseguiu
 * extrair o número do DOM da aba recém-aberta (caso raro; a aba
 * provavelmente não é uma tela de processo).
 */
export interface PrazosProcessoColeta {
  url: string;
  ok: boolean;
  numeroProcesso: string | null;
  extracao?: ExpedientesExtracao;
  anomaliasProcesso?: ProcessoAnomalia[];
  error?: string;
  /** Duração da coleta em milissegundos (debug/telemetria). */
  duracaoMs: number;
}

// =====================================================================
// PJe REST API — capturada via interceptor + cliente no background
// =====================================================================

/**
 * Snapshot de autenticacao do PJe capturado pelo interceptor page-world
 * a partir das chamadas reais do Angular do painel. Permite ao
 * background reproduzir as chamadas com os mesmos headers.
 *
 * IMPORTANTE: contem token Bearer com TTL curto (geralmente 5-15 min
 * no Keycloak da JFCE). Nao persistir em `storage.local` — apenas em
 * `storage.session` ou em memoria do service worker.
 */
export interface PJeAuthSnapshot {
  /** ms epoch da captura. */
  capturedAt: number;
  /** URL da chamada REST que serviu de amostra (debug). */
  url: string;
  /**
   * Header `Authorization` exato como o Angular envia. Pode ser
   * `Bearer <jwt>` (quando SSO Keycloak esta ativo) ou `Basic ...`
   * (fallback legacy quando o SSO expira). Quem de fato autentica
   * as chamadas same-origin e o cookie JSESSIONID + `X-pje-*`.
   */
  authorization: string;
  /** Header `X-pje-cookies` (sessao do legacy serializada). */
  pjeCookies: string | null;
  /** Header `X-pje-legacy-app` (geralmente "true"). */
  pjeLegacyApp: string | null;
  /** Header `X-pje-usuario-localizacao` (id da localizacao do usuario). */
  pjeUsuarioLocalizacao: string | null;
  /**
   * Header `X-no-sso` — quando presente, sinaliza ao backend para nao
   * exigir o fluxo SSO (usar cookie + `X-pje-*`). Sem ele, o PJe pode
   * responder 200 com corpo vazio mesmo para chamadas aparentemente
   * validas.
   */
  xNoSso: string | null;
  /** Header `X-pje-authorization` (esquema secundario que o Angular envia). */
  xPjeAuthorization: string | null;
}

/**
 * Processo retornado pela API
 * `recuperarProcessosTarefaPendenteComCriterios`. Normalizado a partir
 * do shape variavel do PJe (campos com `descricao` aninhada, arrays
 * mistos etc.).
 */
export interface PJeApiProcesso {
  /** ID interno do processo no PJe (numero, nao string). */
  idProcesso: number;
  /** Numero CNJ formatado quando presente. */
  numeroProcesso: string | null;
  /**
   * ID da TaskInstance corrente. Necessario para montar o link dos
   * autos com `idTaskInstance=...` (caso contrario o PJe abre a aba
   * Movimentacoes em vez da tela do processo no contexto da tarefa).
   */
  idTaskInstance: number | null;
  classeJudicial: string | null;
  poloAtivo: string | null;
  poloPassivo: string | null;
  orgaoJulgador: string | null;
  /** Data de chegada do processo na tarefa (string crua do PJe). */
  dataChegadaTarefa: string | null;
  prioridade: boolean;
  sigiloso: boolean;
  /** Etiquetas/tags aplicadas ao processo. */
  etiquetas: string[];
  /**
   * Assunto principal do processo (ex.: "Pessoa com Deficiência",
   * "Aposentadoria", "Inadimplemento"). Diferente de `classeJudicial`,
   * que traz a sigla da classe processual (CumSenFaz, PJEC, etc.).
   */
  assuntoPrincipal: string | null;
  /**
   * Descrição textual do último movimento do processo (ex.: "Juntada de
   * Certidão", "Decorrido prazo de X em dd/mm/aaaa 23:59.").
   */
  descricaoUltimoMovimento: string | null;
  /**
   * Timestamp (ms desde epoch) do último movimento do processo.
   */
  ultimoMovimento: number | null;
  /**
   * Cargo do magistrado responsável (ex.: "Juiz Federal Titular",
   * "Juiz Federal Substituto").
   */
  cargoJudicial: string | null;
}

/** Pedido de listagem ao background. */
export interface PJeApiListarRequest {
  /** Nome exato da tarefa (ex.: "Controle de prazo - INSS"). */
  nomeTarefa: string;
  /** Pagina inicial (1-based). Default 1. */
  page?: number;
  /** Tamanho de pagina. Default 100, maximo pratico ~200. */
  pageSize?: number;
  /** Limite total de processos a coletar (corta paginacao). */
  maxProcessos?: number;
}

/** Resposta consolidada da listagem. */
export interface PJeApiListarResponse {
  ok: boolean;
  /** Total reportado pelo servidor (`count`). */
  total: number;
  /** Processos efetivamente coletados (pode ser menor que `total`). */
  processos: PJeApiProcesso[];
  error?: string;
}

/** Pedido de resolucao da chave de acesso. */
export interface PJeApiResolveCaRequest {
  idProcesso: number;
}

/** Resposta da resolucao. */
export interface PJeApiResolveCaResponse {
  ok: boolean;
  /** Hash `ca` para anexar como query string da URL dos autos. */
  ca: string | null;
  error?: string;
}

/**
 * Shape bruto de uma etiqueta na resposta de
 * `POST /painelUsuario/etiquetas`. Parsing tolera campos ausentes — só
 * `id` e `nomeTag` são obrigatórios para formar um `EtiquetaRecord`.
 */
export interface PJeApiEtiquetaRaw {
  id: number;
  nomeTag: string;
  nomeTagCompleto?: string | null;
  favorita?: boolean | null;
  possuiFilhos?: boolean | null;
  idTagFavorita?: number | null;
}

/** Item normalizado retornado pelo cliente REST. */
export interface PJeApiEtiqueta {
  id: number;
  nomeTag: string;
  nomeTagCompleto: string;
  favorita: boolean;
  possuiFilhos: boolean;
  idTagFavorita: number | null;
}

/** Resposta consolidada da listagem de etiquetas (todas as páginas). */
export interface PJeApiEtiquetasListResponse {
  ok: boolean;
  total: number;
  etiquetas: PJeApiEtiqueta[];
  error?: string;
}

/**
 * Uma etiqueta sugerida pelo pipeline "Inserir etiquetas mágicas".
 * Formato "leve" — carrega apenas o mínimo que a UI precisa exibir e o
 * `content.ts` precisa para aplicar a etiqueta no futuro.
 */
export interface EtiquetaSugerida {
  /** `id` do PJe (idTag). Necessário para aplicação/dedupe. */
  id: number;
  /** Nome exibível (usa `nomeTag` do registro). */
  nomeTag: string;
  /** Caminho hierárquico (ex.: "Previdenciário > Aposentadoria > Rural"). */
  nomeTagCompleto: string;
  /** True quando o usuário marcou a etiqueta como favorita no PJe. */
  favorita: boolean;
  /** Similaridade normalizada 0..100 relativa ao top-1 do ranking. */
  similarity: number;
  /** Score BM25 bruto (somado por marcador, com boost aplicado). */
  score: number;
  /** Marcadores (gerados pela LLM) que contribuíram com este match. */
  matchedMarkers: string[];
}

/** Envelope enviado do content para o background na ação "sugerir etiquetas". */
export interface SugerirEtiquetasRequest {
  /** Trecho consolidado dos autos (já truncado pelo chamador). */
  caseContext: string;
}

/** Resposta consolidada da ação "sugerir etiquetas". */
export interface SugerirEtiquetasResponse {
  ok: boolean;
  /** Marcadores gerados pelo extrator LLM (antes do de-para BM25). */
  markers?: string[];
  /** Etiquetas sugestionáveis ranqueadas, já ordenadas por score. */
  matches?: EtiquetaSugerida[];
  error?: string;
}

/**
 * Checkpoint de uma varredura "Prazos na Fita" em andamento. Persistido
 * em `chrome.storage.local` para permitir retomada apos fechamento do
 * Chrome, 403 por token expirado nao renovado em 60s, ou cancelamento
 * manual. Identificado por `scanId` — derivado deterministicamente da
 * assinatura `(nomes ordenados + filtros)`, de forma que relancar a
 * mesma selecao reaproveita o checkpoint.
 *
 * `unicos` e a lista PROCESSADA (ja deduplicada, filtrada e cortada ao
 * teto) — varrer o mesmo conjunto evita que o resume inclua/exclua
 * processos se `dataChegadaTarefa` mudar entre execucoes.
 *
 * `consolidados` e alinhado por indice com `unicos`: entradas `null`
 * indicam "ainda nao processado"; entradas preenchidas podem ter
 * `coleta` ou `error` e sao preservadas ao retomar.
 */
export interface PrazosFitaScanState {
  scanId: string;
  nomes: string[];
  filtros: {
    diasMinNaTarefa: number | null;
    maxProcessosTotal: number | null;
  };
  unicos: Array<{ tarefaNome: string; processoApi: PJeApiProcesso }>;
  consolidados: Array<{
    tarefaNome: string;
    processoApi: PJeApiProcesso;
    url: string | null;
    coleta: PrazosProcessoColeta | null;
    error?: string;
  } | null>;
  /** Total antes de dedup (referencia, nao afeta resume). */
  totalDescobertos: number;
  /** Hostname do PJe onde a varredura foi iniciada. */
  hostnamePJe: string;
  /** ms epoch da criacao. */
  startedAt: number;
  /** ms epoch do ultimo checkpoint. Usado para expiracao (24h). */
  updatedAt: number;
}

/**
 * Resposta de consulta a painel: `hasState` true quando existe um
 * checkpoint valido para a assinatura consultada. O painel usa
 * `concluidos`/`total`/`updatedAt` para montar a pergunta ao usuario
 * ("Continuar X/Y ou comecar do zero?").
 */
export interface PrazosFitaScanStateInfo {
  hasState: boolean;
  scanId?: string;
  concluidos?: number;
  total?: number;
  startedAt?: number;
  updatedAt?: number;
}

/**
 * Payload do dashboard "Prazos na Fita" — gravado em `storage.session`
 * pelo background e lido pela aba dedicada. Sem LGPD no servidor:
 * nomes de partes e numeros CNJ ficam apenas localmente.
 */
export interface PrazosFitaDashboardPayload {
  geradoEm: string;
  hostnamePJe: string;
  /** Nomes das tarefas selecionadas no seletor. */
  tarefasSelecionadas: string[];
  /** Resultado bruto de `coletarPrazosPorTarefasViaAPI`. */
  resultado: {
    totalDescobertos: number;
    tempoTotalMs: number;
    consolidado: Array<{
      tarefaNome: string;
      processoApi: PJeApiProcesso;
      url: string | null;
      coleta: PrazosProcessoColeta | null;
      error?: string;
    }>;
  };
}
