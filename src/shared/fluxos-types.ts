/**
 * Tipos compartilhados do módulo "Consultor de fluxos".
 *
 * O catálogo é gerado offline pelo parser jPDL em `fluxos-pje/scripts/`
 * e empacotado no build da extensão como `assets/fluxos-catalogo.json`.
 * Quando o catálogo for migrado para servidor (Cloudflare Worker),
 * apenas o loader em `fluxos-store.ts` muda — o schema permanece.
 */

/** Lane do fluxo no macro-processo. */
export type FluxoLane = 'JEF' | 'EF' | 'Comum' | 'Shared';

/**
 * Fase canônica do macro-processo (CNJ/MNI). Não é exhaustiva — fluxos
 * que não se encaixam ficam com 'Indefinido' até validação humana.
 */
export type FluxoFase =
  | 'Distribuição'
  | 'Análise da secretaria'
  | 'Análise de comunicação'
  | 'Análise de manifestação'
  | 'Intimação/Citação'
  | 'Comunicação'
  | 'Perícia'
  | 'Audiência'
  | 'Despacho'
  | 'Decisão'
  | 'Decisão urgente'
  | 'Sentença'
  | 'Trânsito em julgado'
  | 'Cumprimento de sentença'
  | 'Recurso'
  | 'Remessa superior'
  | 'Cálculo'
  | 'RPV/Precatório'
  | 'Cancelamento/Aguardo'
  | 'Sobrestamento'
  | 'Aguardo'
  | 'Documento'
  | 'Arquivo'
  | 'Indefinido';

/** Origem da classificação de fase — heurística (parser) ou manual (validador). */
export type FaseOrigem = 'heuristica' | 'manual' | 'pendente';

export interface FluxoTransicao {
  nome: string;
  para: string;
  condicao: string;
}

export interface FluxoSwimlane {
  nome: string;
  pooledActors: string;
  localizacoes: string[];
}

export interface FluxoTaskNode {
  nome: string;
  endTasks: boolean;
  tasks: Array<{ nome: string; swimlane: string; priority: string }>;
  transicoes: FluxoTransicao[];
}

export interface FluxoDecisao {
  nome: string;
  expressao: string;
  transicoes: FluxoTransicao[];
}

export interface FluxoNo {
  nome: string;
  transicoes: FluxoTransicao[];
  acoes: string[];
}

export interface FluxoSubChamado {
  codigo: string;
  contextos: string[];
}

export interface FluxoVariaveis {
  lidas: string[];
  gravadas: string[];
}

export interface FluxoEntrada {
  codigo: string;
  nome: string;
  descricao: string;
  arquivoOrigem: string;
  lane: FluxoLane;
  fase: FluxoFase;
  faseOrigem: FaseOrigem;
  swimlanes: FluxoSwimlane[];
  inicio: { nome: string; transicoes: FluxoTransicao[] } | null;
  fins: Array<{ nome: string }>;
  taskNodes: FluxoTaskNode[];
  decisoes: FluxoDecisao[];
  nos: FluxoNo[];
  subfluxosChamados: FluxoSubChamado[];
  variaveis: FluxoVariaveis;
  stats?: Record<string, unknown>;
}

export interface CatalogoFluxos {
  versao: string;
  geradoEm: string;
  totalFluxos: number;
  fluxos: FluxoEntrada[];
}

/** Aresta no grafo direcionado de chamadas. */
export interface FluxoEdge {
  from: string;
  to: string;
  contextos: string[];
}

/** Mensagem do chat do Consultor — paralelo simplificado de ChatMessage. */
export interface ConsultorMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Fluxo(s) destacado(s) na resposta — para rendering visual lateral. */
  fluxosDestacados?: string[];
  /** Mermaid renderizado para acompanhar a resposta. */
  diagramaMermaid?: string;
}

/**
 * Modo de operação do consultor.
 *
 *   - 'usuario': linguagem natural, sem códigos jBPM, sem siglas, sem
 *     vocabulário técnico ("swimlane", "task-node", "decisão"). Voltado
 *     para servidor / magistrado / parte que quer entender o que
 *     acontece com o processo.
 *
 *   - 'dev': comportamento técnico completo — códigos entre crases,
 *     análise de transições, decisões EL/SQL, swimlanes,
 *     `incluirNovoFluxo`, etc. Voltado a quem mantém os fluxos.
 *
 * Persistido em chrome.storage.local sob STORAGE_KEYS.FLUXOS_MODO.
 */
export type ConsultorModo = 'usuario' | 'dev';

export const CONSULTOR_MODO_DEFAULT: ConsultorModo = 'usuario';
