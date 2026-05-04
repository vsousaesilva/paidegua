/**
 * Tipos do módulo "Controle Metas CNJ" (perfil Gestão).
 *
 * O módulo mantém um acervo persistente (IndexedDB `paidegua.metas-cnj`)
 * dos processos da vara classificados quanto às Metas Nacionais 2026
 * do Conselho Nacional de Justiça. Cada processo carrega seu status
 * atual (pendente/julgado/baixado), data de distribuição e quais metas
 * lhe são aplicáveis.
 *
 * Fonte das regras: Metas Nacionais 2026 aprovadas no 19º ENPJ
 * (Florianópolis/SC, 1-2 dez/2025). Foco aqui: Justiça Federal 1G,
 * TRF5 (Faixa 2 nas metas 6 e 7).
 */

/**
 * Identificadores das metas mensuráveis pelo painel. Metas que dependem
 * apenas de indicadores agregados (1, 3, 5, 9) ficam fora — entram
 * apenas como cartões informativos manuais.
 *
 *   - meta-2  → Antigos: distribuídos há 15 anos + até 31/12/2022 + JEF até 31/12/2023
 *   - meta-4  → Improbidade + crimes Adm. Pública distribuídos até 31/12/2023
 *   - meta-6  → Ambientais distribuídos até 31/12/2025 (TRF5 Faixa 2 = 38%)
 *   - meta-7  → Indígenas/quilombolas/racismo até 31/12/2025 (Faixa 2)
 *   - meta-10 → Subtração internacional de crianças até 31/12/2025
 */
export type MetaCnjId = 'meta-2' | 'meta-4' | 'meta-6' | 'meta-7' | 'meta-10';

export const META_CNJ_IDS: readonly MetaCnjId[] = [
  'meta-2',
  'meta-4',
  'meta-6',
  'meta-7',
  'meta-10'
] as const;

/**
 * IDs das metas informativas (não calculadas — entrada manual do valor
 * publicado pelo Justiça em Números).
 */
export type MetaInformativaId = 'meta-1' | 'meta-3' | 'meta-5';

/** Status do processo no controle de Metas. */
export type StatusProcessoMeta = 'pendente' | 'julgado' | 'baixado';

/**
 * Como o status foi determinado. Hierarquia de prioridade (do mais
 * autoritativo ao mais frágil):
 *   - `manual`           : usuário sobrescreveu (sempre vence).
 *   - `movimento_oficial`: histórico do PJe contém movimento de
 *                          julgamento/baixa (códigos da TPU).
 *   - `documento_anexo`  : há documento de tipo/descrição "Sentença"
 *                          (cobre processos migrados sem histórico).
 *   - `tarefa_indireta`  : tarefa atual indica fase pós-julgamento
 *                          (ex.: "Cumprimento de sentença").
 *   - `inferido_sumico`  : sumiu da varredura sem evidência clara.
 */
export type OrigemStatusMeta =
  | 'manual'
  | 'movimento_oficial'
  | 'documento_anexo'
  | 'tarefa_indireta'
  | 'inferido_sumico';

/** Faixa do TRF para as metas 6 e 7 (CNJ separa Faixa 1 = TRF1/6 / Faixa 2 = TRF2/3/4/5). */
export type FaixaTrf = 1 | 2;

/**
 * Processo no acervo de Metas. Chave natural = `numero_processo` (CNJ).
 */
export interface ProcessoMetasCnj {
  /** Número CNJ formatado — chave primária. */
  numero_processo: string;
  /** ID interno do processo no PJe (numérico). */
  id_processo_pje: number;
  /** ID da TaskInstance corrente; null se sumiu da última varredura. */
  id_task_instance_atual: number | null;

  // ── Identificação básica (vem da listagem REST do painel) ──────
  classe_sigla: string;
  assunto_principal: string | null;
  polo_ativo: string | null;
  polo_passivo: string | null;
  orgao_julgador: string | null;
  cargo_judicial: string | null;
  /** Etiquetas aplicadas no PJe (nomes). */
  etiquetas_pje: string[];
  /** Tarefa onde o processo foi encontrado na última varredura. */
  tarefa_origem_atual: string | null;
  /** URL dos autos (quando `ca` foi resolvido). */
  url: string | null;

  // ── Datas-chave (vêm do fetch profundo dos autos) ──────────────
  /** Data de distribuição (ISO YYYY-MM-DD). Crítico para Meta 2. */
  data_distribuicao: string | null;
  /** Data de autuação (pode diferir da distribuição em redistribuídos). */
  data_autuacao: string | null;
  /** Ano da distribuição — derivado, indexável para queries por meta. */
  ano_distribuicao: number | null;

  // ── Classificação por meta ─────────────────────────────────────
  /** Metas em que o processo se enquadra (computado a partir das regras). */
  metas_aplicaveis: MetaCnjId[];
  /**
   * Override manual por meta: força inclusão (`true`) ou exclusão
   * (`false`) explícita pelo usuário, sobrescrevendo a regra automática.
   * Vazio quando não há override.
   */
  meta_override_manual: Partial<Record<MetaCnjId, boolean>>;

  // ── Status para fim de Metas ───────────────────────────────────
  status: StatusProcessoMeta;
  origem_status: OrigemStatusMeta;
  /** ISO de quando o status foi computado pela última vez. */
  status_definido_em: string;
  /** Data do julgamento (ISO YYYY-MM-DD), quando `status='julgado'`. */
  data_julgamento: string | null;
  /** Data da baixa (ISO YYYY-MM-DD), quando `status='baixado'`. */
  data_baixa: string | null;

  // ── Auditoria de varredura / incremental ───────────────────────
  /**
   * `true` se o processo apareceu na última varredura. `false` quando
   * sumiu (foi julgado, baixado, redistribuído ou simplesmente saiu das
   * tarefas selecionadas).
   */
  presente_ultima_varredura: boolean;
  /**
   * String do `ultimoMovimento` do PJe (texto + timestamp) registrada
   * na última varredura. Chave da atualização incremental: se o valor
   * não mudou, evita refazer fetch profundo dos autos.
   */
  ultimo_movimento_visto: string | null;

  /**
   * Origem por campo (`'pje' | 'manual' | 'ia'`) — espelha o padrão do
   * sigcrim. Permite preservar edições manuais entre varreduras.
   */
  origem_dados: Record<string, 'pje' | 'manual' | 'ia'>;

  // ── Carimbos ────────────────────────────────────────────────────
  capturado_em: string;
  atualizado_em: string;
  /** ISO da última varredura que tocou neste registro. */
  ultima_sincronizacao_pje: string;
}

/**
 * Configuração de uma meta individual (parâmetros que o usuário pode
 * ajustar). Defaults vêm das Metas Nacionais 2026; o usuário pode
 * sobrescrever por unidade.
 */
export interface ConfigMetaIndividual {
  /** Liga/desliga a meta no painel. */
  ativada: boolean;
  /** Data limite de distribuição (ISO YYYY-MM-DD). */
  dataCorte: string;
  /**
   * Siglas de classes processuais elegíveis (vazio = qualquer classe).
   * Aplicável a Meta 4 principalmente.
   */
  classesElegiveis: string[];
  /**
   * Substrings (case-insensitive) para casar com `assunto_principal`
   * do processo. Vazio = qualquer assunto.
   */
  assuntosElegiveis: string[];
  /**
   * Etiqueta-padrão sugerida para aplicar nos processos da meta.
   * Editável; é só uma sugestão exibida na UI.
   */
  etiquetaSugerida: string;
}

/**
 * Valor publicado oficialmente pelo CNJ/TRF5 para uma meta informativa.
 * Entrada manual — o painel apenas exibe.
 */
export interface CartaoInformativoMeta {
  /** Valor numérico publicado (ponto percentual ou contagem). */
  valor: number | null;
  /** Unidade humana (ex.: "%", "processos"). */
  unidade: string;
  /** Data de apuração do valor (ISO). */
  dataApuracao: string | null;
  /** Anotação do usuário sobre a fonte (ex.: "Justiça em Números 2025"). */
  fonte: string;
}

/**
 * Configuração persistida do módulo Metas CNJ. Fica em
 * `paidegua.metas-cnj` no store `meta`, key `'config'`.
 */
export interface MetasCnjConfig {
  schemaVersion: 1;
  /** Faixa do TRF — afeta percentuais das metas 6 e 7. TRF5 = 2. */
  faixaTrf: FaixaTrf;
  /** Configurações por meta mensurável. */
  metas: Record<MetaCnjId, ConfigMetaIndividual>;
  /** Valores manuais das metas informativas (1, 3, 5). */
  cartoesInformativos: Partial<Record<MetaInformativaId, CartaoInformativoMeta>>;
  /**
   * Substrings (case-insensitive) que, ao aparecerem no nome da
   * tarefa atual, indicam que o processo já foi julgado (regra 2 do
   * detector — útil para migrados sem histórico). Editável pelo usuário.
   */
  tarefasIndicamJulgado: string[];
  /**
   * Substrings que indicam BAIXA (raras — geralmente o processo só
   * some das tarefas). Editável.
   */
  tarefasIndicamBaixa: string[];
  /**
   * Liga a regra 1B do detector: quando há documento anexo cujo tipo
   * ou descrição contém "sentença"/"acórdão", classifica como julgado.
   * Útil para processos migrados; pode gerar falsos positivos com
   * "Petição requerendo cumprimento de sentença" (mitigado por
   * `documentosTiposPositivos`/`documentosDescricoesNegativas`).
   */
  detectaJulgadoPorDocumento: boolean;
  /**
   * Tipos de documento que, sozinhos, comprovam julgamento (case-
   * insensitive, match exato).
   */
  documentosTiposPositivos: string[];
  /**
   * Substrings na descrição que excluem o documento da inferência
   * positiva (ex.: "minuta", "embargos", "anexo").
   */
  documentosDescricoesNegativas: string[];
}

/**
 * Snapshot da última varredura — usado para mostrar "Atualizado em XX"
 * no dashboard. Fica em `meta`, key `'last_sync'`.
 */
export interface MetasCnjLastSync {
  /** ISO do início da varredura. */
  startedAt: string;
  /** ISO da conclusão. null se em andamento ou abortada. */
  finishedAt: string | null;
  /** Total de processos no acervo após a varredura. */
  totalNoAcervo: number;
  /** Capturas novas (não estavam no acervo antes). */
  novosNoAcervo: number;
  /** Atualizações em processos já existentes. */
  atualizados: number;
  /** Processos marcados como `presente_ultima_varredura: false` desta vez. */
  sumidos: number;
  /** Contagem por meta no acervo atual (após varredura). */
  contagemPorMeta: Record<MetaCnjId, { pendentes: number; julgados: number }>;
  /** Tarefas que entraram na varredura. */
  tarefasVarridas: string[];
  /** Mensagem de erro se a varredura abortou. */
  error: string | null;
}

/**
 * Defaults para Metas Nacionais 2026 - JF 1G - TRF5 (Faixa 2).
 *
 * Derivado da norma. O usuário pode sobrescrever na tela de
 * configuração; manter aqui o ponto de partida documentado.
 */
export function defaultMetasCnjConfig(): MetasCnjConfig {
  const vazia = (etiquetaSugerida: string): ConfigMetaIndividual => ({
    ativada: true,
    dataCorte: '',
    classesElegiveis: [],
    assuntosElegiveis: [],
    etiquetaSugerida
  });

  return {
    schemaVersion: 1,
    faixaTrf: 2,
    metas: {
      'meta-2': {
        ...vazia('META 2 - 2011'),
        // 15 anos relativos a 2026 = distribuídos até 31/12/2011
        dataCorte: '2011-12-31'
      },
      'meta-4': {
        ...vazia('META 4 - IMPROBIDADE 2023'),
        dataCorte: '2023-12-31'
        // classes/assuntos: a definir com o usuário (Improbidade + crimes Adm. Pública)
      },
      'meta-6': {
        ...vazia('META 6 - AMBIENTAL'),
        dataCorte: '2025-12-31'
      },
      'meta-7': {
        ...vazia('META 7 - DISCRIMINACAO'),
        dataCorte: '2025-12-31'
      },
      'meta-10': {
        ...vazia('META 10 - SUBTRACAO INTERNACIONAL'),
        dataCorte: '2025-12-31'
      }
    },
    cartoesInformativos: {},
    tarefasIndicamJulgado: [
      'cumprimento de sentença',
      'execução',
      'liquidação',
      'aguardando trânsito',
      'apelação',
      'recursos',
      'embargos de declaração',
      'recurso especial',
      'recurso extraordinário'
    ],
    tarefasIndicamBaixa: [
      'arquivar definitivamente',
      'baixa definitiva'
    ],
    detectaJulgadoPorDocumento: true,
    documentosTiposPositivos: ['Sentença', 'Acórdão'],
    documentosDescricoesNegativas: [
      'minuta',
      'embargos',
      'anexo',
      'recurso',
      'cumprimento'
    ]
  };
}
