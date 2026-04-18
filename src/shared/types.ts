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
