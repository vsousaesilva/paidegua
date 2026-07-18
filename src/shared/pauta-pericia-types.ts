/**
 * Tipos do Painel de Perícias (Pauta) — perfil Gestão.
 *
 * Modelo POR PROCESSO (igual ao PREVJUD): o universo é tarefas do painel +
 * filtro de etiquetas. De cada processo candidato, a extração abre a aba de
 * perícia (link `navbar:linkAbaPericia`) e lê a tabela
 * `#processoPericiaNovaPericiaList` (5 colunas: Data, Periciado, Valor,
 * Perito, Situação). Processos sem perícia são descartados. Só troca
 * "Intimações INSS" por "Perícias".
 *
 * Não confundir com o módulo `pericias/` existente (feature "Criar pauta").
 */

/** Linha crua da tabela de perícia — células por índice de coluna 0–4. */
export interface RawPericiaRow {
  celulas: string[];
}

/** Uma perícia normalizada. */
export interface PericiaItem {
  /** Coluna 0 — "dd/mm/aaaa hh:mm". */
  dataHora: string | null;
  /** Coluna 1 — nome do periciado. */
  periciado: string | null;
  /** Coluna 2 — valor em reais (número); null se não parseou. */
  valor: number | null;
  /** Texto original do valor (ex.: "R$ 330,00"). */
  valorTexto: string | null;
  /** Coluna 3 — nome do perito. */
  peritoNome: string | null;
  /** Coluna 3 — CPF do perito. */
  peritoCpf: string | null;
  /** Coluna 4 — situação canônica (ex.: "Enviado para pagamento"). */
  situacao: string;
}

/** Processo com ao menos uma perícia (sem perícia é descartado do relatório). */
export interface ProcessoComPericias {
  idProcesso: number;
  numeroProcesso: string | null;
  idTaskInstance: number | null;
  classeJudicial: string | null;
  assuntoPrincipal: string | null;
  poloAtivo: string | null;
  etiquetas: string[];
  /** URL dos autos (resolvida on-demand na coleta). */
  urlAutos: string | null;
  pericias: PericiaItem[];
}

/**
 * Resultado da coleta de UM processo (SSR). `vazio: true` = processo sem
 * perícia (tabela renderizada sem linhas).
 */
export interface PericiaColetaProcessoResult {
  ok: boolean;
  vazio?: boolean;
  linhas?: RawPericiaRow[];
  error?: string;
  duracaoMs?: number;
}

/** Configuração da coleta escolhida na aba-painel (espelha o PREVJUD). */
export interface PautaPericiaColetaConfig {
  nomesTarefas: string[];
  etiquetasFiltro: string[];
  etiquetaModo?: 'qualquer' | 'todas';
  /**
   * Situações (rótulos canônicos) que o usuário quer IGNORAR no relatório.
   * Perícia cuja situação casar (case-insensitive) é descartada; processo
   * que ficar sem perícia sai do relatório.
   */
  situacoesIgnorar?: string[];
}

/** Estado da aba-painel (via `chrome.storage.session`). */
export interface PautaPericiaPainelState {
  requestId: string;
  tarefas: { nome: string; quantidade: number | null }[];
  /** Situações disponíveis para o usuário escolher quais ignorar. */
  situacoes: string[];
  hostnamePJe: string;
  legacyOrigin: string;
  abertoEm: string;
}

/** Payload do dashboard (via `chrome.storage.session`). */
export interface PautaPericiaDashboardPayload {
  requestId: string;
  geradoEm: string;
  hostnamePJe: string;
  tarefasVarridas: string[];
  etiquetasFiltro: string[];
  /**
   * Estado da coleta em streaming: `running` enquanto o dashboard vai sendo
   * populado, `done` ao final. Ausente = payload completo (legado).
   */
  status?: 'running' | 'done';
  /** Progresso da coleta enquanto `status: 'running'`. */
  progress?: { feitos: number; total: number };
  /** Sequência monotônica — descarta patches de slot fora de ordem. */
  seq?: number;
  totais: {
    /** Candidatos após o filtro de etiqueta. */
    processosVarridos: number;
    /** Candidatos que de fato tinham perícia. */
    processosComPericia: number;
    totalPericias: number;
    valorTotal: number;
  };
  processos: ProcessoComPericias[];
  diagnostico: {
    processosNaTarefa: number;
    filtradosPorEtiqueta: number;
    situacoesIgnoradas?: string[];
    periciasIgnoradas?: number;
    falhas: { idProcesso: number; numeroProcesso: string | null; erro: string }[];
  };
}
