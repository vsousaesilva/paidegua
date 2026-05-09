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
  /** Campos calculados pelo enriquecedor (FLUX-08). Opcional para
   * compatibilidade com catálogos pré-Sprint-1 dos Mapas de Jornada. */
  enriquecimento?: EnriquecimentoFluxo;
}

export interface CatalogoFluxos {
  versao: string;
  geradoEm: string;
  totalFluxos: number;
  fluxos: FluxoEntrada[];
  /** ISO timestamp do último enriquecimento; ausente em catálogos antigos. */
  enriquecidoEm?: string;
}

/** Campos calculados pelo enriquecedor para dar contexto humano e visual. */
export interface EnriquecimentoFluxo {
  /** Soma de chamadas entrantes + saintes no grafo. */
  grau_total: number;
  grau_in: number;
  grau_out: number;
  /** Top 5 fluxos que chamam este, ordenados por contagem. */
  top_origens: FluxoVizinho[];
  /** Top 5 fluxos chamados por este, ordenados por contagem. */
  top_destinos: FluxoVizinho[];
  /** Alertas computados pelas regras de pontos de atenção. */
  alertas: AlertaFluxo[];
  /** Frase humana de 1 linha que descreve o fluxo. */
  frase_humana: string;
  /** Origem da frase: 'manual' (curada por servidor sênior) ou 'template'. */
  frase_origem: 'manual' | 'template';
}

export interface FluxoVizinho {
  codigo: string;
  nome: string;
  /** Quantas vezes o vizinho chama (ou é chamado por) este fluxo. */
  chamadas: number;
}

export type AlertaTipo =
  | 'hub'
  | 'decisao_automatica'
  | 'loop'
  | 'prazo_paralelo'
  | 'fantasma_downstream'
  | 'subfluxo_shared';

export type AlertaSeveridade = 'baixa' | 'media' | 'alta';

export interface AlertaFluxo {
  tipo: AlertaTipo;
  severidade: AlertaSeveridade;
  mensagem: string;
  /** Códigos relacionados (ex.: lista de fantasmas, prazos paralelos). */
  detalhes?: string[];
}

/* ───────────────────── Mapas de Jornada (FLUX-08+) ───────────────────── */

export type EstacaoPapel = 'principal' | 'ramificacao' | 'origem' | 'retorno';

export interface JornadaEstacao {
  /** Nome OFICIAL da tarefa humana (com prefixo `[JEF]`/`[EF]` etc.) —
   * é o que o servidor vê na fila do PJe. Unidade primária do produto
   * desde o pivot FLUX-17 (2026-05-07). */
  tarefa?: string;
  /** Código do fluxo no catálogo. Usado em modo técnico ou como
   * fallback quando a estação ainda não foi convertida para tarefa. */
  fluxo?: string;
  papel: EstacaoPapel;
  /** Rótulo curto (≤ 30 chars) opcional para o card. Se ausente, deriva do nome da tarefa/fluxo. */
  rotulo?: string;
}

export interface JornadaTrilha {
  id: string;
  nome: string;
  descricaoCurta: string;
  /** Nome de ícone (lucide). */
  icone: string;
  /** CSS variable da paleta (ex.: 'var(--jef)'). */
  cor: string;
  /** Id do agrupamento da Camada 1 onde a trilha vive. */
  agrupamento: string;
  estacoes: JornadaEstacao[];
}

export interface JornadaAgrupamento {
  id: string;
  nome: string;
  descricaoCurta: string;
  /** Id da fase canônica (eixo X) onde o agrupamento começa. Mais
   * robusto que matching por nome. Se ausente, cai em `ordem`. */
  faseInicial?: string;
  /** Id da fase canônica onde o agrupamento termina. */
  faseFinal?: string;
  /** Fases do macro-processo cobertas por este agrupamento (legível). */
  fasesCanonicas: FluxoFase[] | string[];
  /** Tarefas humanas âncora exibidas no card do agrupamento (modo
   * usuário). Nomes oficiais como aparecem na fila do PJe.
   * Ex.: "[JEF] Analisar inicial", "[JEF] Ato do magistrado - Despacho". */
  tarefasPrincipais?: string[];
  /** Fluxos âncora — fallback / modo técnico. */
  fluxosPrincipais: string[];
  /** Posição horizontal de fallback (1..N). */
  ordem: number;
}

export interface JornadaFaseCanonica {
  id: string;
  nome: string;
  ordem: number;
}

export interface Jornada {
  lane: FluxoLane;
  versao: string;
  geradoEm: string;
  validadoPor: string;
  trilhas: JornadaTrilha[];
  agrupamentos: JornadaAgrupamento[];
  fasesCanonicas: JornadaFaseCanonica[];
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
