/**
 * Detector de status do processo para o módulo "Controle Metas CNJ".
 *
 * Lógica pura — recebe os dados já coletados de um processo (histórico
 * de movimentos, documentos, tarefa atual, override manual) e devolve
 * o status classificado com a evidência que o sustenta. Não acessa o
 * IndexedDB nem o PJe; é responsabilidade do chamador enriquecer os
 * movimentos com `categorias` (via `enriquecerMovimentos` abaixo) antes
 * de chamar `detectarStatus`.
 *
 * Hierarquia de prioridade — implementa a regra acordada na conversa
 * de gênese (mai/2026):
 *
 *   1. OVERRIDE MANUAL  — sempre vence.
 *   2. MOVIMENTO OFICIAL DE BAIXA — categoria 'baixa' no histórico.
 *   3. MOVIMENTO OFICIAL DE JULGAMENTO — qualquer das categorias
 *      'julgamento_merito' | 'julgamento_sem_merito' |
 *      'homologacao_acordo' | 'extincao_punibilidade' no histórico.
 *   4. DOCUMENTO ANEXO — tipo "Sentença"/"Acórdão" sem ruído na descrição.
 *      Cobre processos migrados sem histórico de movimentos.
 *   5. TAREFA ATUAL — nome bate com lista de "tarefas pós-julgamento"
 *      (ex.: "Cumprimento de sentença", "Execução"). Útil para
 *      processos cuja história não está mais visível.
 *   6. SUMIÇO INFERIDO — processo sumiu da varredura sem evidência
 *      (apenas marca como `inferido_sumico`, mantém status anterior).
 *   7. DEFAULT — pendente.
 *
 * Princípio: zero ação manual no caminho feliz. O usuário só precisa
 * intervir em casos verdadeiramente excepcionais (override manual).
 */

import type {
  OrigemStatusMeta,
  StatusProcessoMeta
} from './metas-cnj-types';
import type { TpuCategoria } from './tpu-types';
import { getCategoriasDe } from './tpu-store';

// =====================================================================
// Tipos de I/O
// =====================================================================

/**
 * Movimento processual no histórico do processo. Forma "leve" — vem do
 * scrape do DOM dos autos digitais ou da API REST.
 */
export interface MovimentoProcessual {
  /** Código CNJ do movimento (quando reconhecido pelo extrator). */
  codigoCnj: number | null;
  /** Descrição literal do movimento como aparece no histórico. */
  descricao: string;
  /**
   * Data do movimento. Aceita ISO (`YYYY-MM-DD` ou completo) ou
   * `DD/MM/AAAA`. Comparação é por string lexicográfica quando ambos no
   * mesmo formato; o detector ordena os movimentos por essa string.
   */
  data: string;
  /**
   * Categorias semânticas do movimento — preenchido por
   * `enriquecerMovimentos` antes de chamar `detectarStatus`.
   */
  categorias?: readonly TpuCategoria[];
}

/**
 * Documento juntado aos autos. Vem da árvore de documentos do PJe.
 */
export interface DocumentoProcessual {
  /** Tipo nominal (ex.: "Sentença", "Petição", "Despacho"). */
  tipo: string;
  /** Descrição/título dado pelo usuário ao subir o documento. */
  descricao: string;
  /** Data de juntada. Mesma flexibilidade de formato que `MovimentoProcessual.data`. */
  dataJuntada: string;
}

/**
 * Override manual do usuário. Sempre vence sobre as inferências.
 */
export interface OverrideManualStatus {
  status: StatusProcessoMeta;
  /** Data declarada pelo usuário (opcional). */
  data?: string | null;
  /** Nota livre — auditoria. */
  nota?: string;
}

export interface DetectorInput {
  movimentos: readonly MovimentoProcessual[];
  documentos?: readonly DocumentoProcessual[];
  /** Nome da tarefa atual onde o processo está alocado. */
  tarefaAtual?: string | null;
  /** Override manual, se houver. */
  override?: OverrideManualStatus | null;

  // Configuração (vem do MetasCnjConfig)
  /** Lista (case-insensitive substring) — default em `defaultMetasCnjConfig`. */
  tarefasIndicamJulgado?: readonly string[];
  /** Lista (case-insensitive substring). */
  tarefasIndicamBaixa?: readonly string[];
  /** Liga a regra 1B (documento → julgado). */
  detectaJulgadoPorDocumento?: boolean;
  /** Tipos de documento que comprovam julgamento (match exato CI). */
  documentosTiposPositivos?: readonly string[];
  /** Substrings que excluem o documento da inferência (ruído). */
  documentosDescricoesNegativas?: readonly string[];

  /**
   * Status anterior (do registro existente no acervo). Usado quando
   * o processo sumiu da varredura — preserva a última classificação.
   */
  statusAnterior?: {
    status: StatusProcessoMeta;
    origem: OrigemStatusMeta;
    data: string | null;
  } | null;

  /**
   * `true` quando este processo não apareceu na varredura corrente.
   * Aciona a regra de "inferido_sumico".
   */
  sumiuDaVarredura?: boolean;
}

/**
 * Evidência que sustenta a classificação — vai pra UI (auditoria visual)
 * e para logs.
 */
export interface EvidenciaStatus {
  tipo: 'movimento' | 'documento' | 'tarefa' | 'override' | 'inferencia';
  descricao: string;
  data?: string | null;
  /** Código CNJ envolvido, quando aplicável. */
  codigoCnj?: number;
}

export interface ResultadoStatus {
  status: StatusProcessoMeta;
  origem: OrigemStatusMeta;
  /** Data do evento que justificou a classificação (ISO ou DD/MM/AAAA). */
  data: string | null;
  /** Frase humana — vai como tooltip/legenda no dashboard. */
  detalhe: string;
  /** Evidências consideradas (até 3, em ordem de relevância). */
  evidencias: EvidenciaStatus[];
}

// =====================================================================
// Helpers
// =====================================================================

/** Match case-insensitive de substring. */
function contemCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** True se string é igual case-insensitive. */
function igualCI(a: string, b: string): boolean {
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

/**
 * Categorias que, no histórico, indicam julgamento para fins de Metas.
 * Inclui todas as variações de fim do processo na vara.
 */
const CATEGORIAS_JULGAMENTO: readonly TpuCategoria[] = [
  'julgamento_merito',
  'julgamento_sem_merito',
  'homologacao_acordo',
  'extincao_punibilidade'
] as const;

function temCategoriaJulgamento(m: MovimentoProcessual): boolean {
  if (!m.categorias) return false;
  return m.categorias.some((c) => CATEGORIAS_JULGAMENTO.includes(c));
}

function temCategoriaBaixa(m: MovimentoProcessual): boolean {
  return Boolean(m.categorias?.includes('baixa'));
}

/**
 * Ordena movimentos por data DESC (mais recente primeiro). Tolera
 * formatos mistos (ISO e DD/MM/AAAA) — o que importa é consistência
 * dentro de cada processo.
 *
 * Conversão simplificada: `DD/MM/AAAA` → `AAAA-MM-DD` para comparação;
 * ISO já está em ordem lexicográfica.
 */
function chaveOrdenacao(data: string): string {
  const t = data.trim();
  // DD/MM/AAAA HH:MM:SS  ou  DD/MM/AAAA
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return t; // ISO ou desconhecido
}

function maisRecentePrimeiro(a: MovimentoProcessual, b: MovimentoProcessual): number {
  return chaveOrdenacao(b.data).localeCompare(chaveOrdenacao(a.data));
}

// =====================================================================
// Enriquecimento (preenche categorias dos movimentos via tpu-store)
// =====================================================================

/**
 * Preenche `categorias` em cada movimento consultando o catálogo TPU.
 * Faz cache local para evitar chamadas IDB repetidas para o mesmo
 * código.
 *
 * Idealmente usado em batch antes de processar muitos processos —
 * passar a mesma instância do `cache` permite acumular entre
 * chamadas.
 */
export async function enriquecerMovimentos(
  movimentos: readonly MovimentoProcessual[],
  cache?: Map<number, readonly TpuCategoria[]>
): Promise<MovimentoProcessual[]> {
  const cacheReal = cache ?? new Map<number, readonly TpuCategoria[]>();
  const resultado: MovimentoProcessual[] = [];
  for (const m of movimentos) {
    if (m.categorias) {
      // Já preenchido — passa adiante.
      resultado.push(m);
      continue;
    }
    if (m.codigoCnj == null) {
      resultado.push({ ...m, categorias: [] });
      continue;
    }
    let cats = cacheReal.get(m.codigoCnj);
    if (cats === undefined) {
      cats = await getCategoriasDe(m.codigoCnj);
      cacheReal.set(m.codigoCnj, cats);
    }
    resultado.push({ ...m, categorias: cats });
  }
  return resultado;
}

// =====================================================================
// Detector
// =====================================================================

/**
 * Aplica a hierarquia de regras e retorna o veredito.
 *
 * Pré-condição: os movimentos já devem ter `categorias` preenchidas
 * (rode `enriquecerMovimentos` antes).
 *
 * Função pura (não toca IDB nem rede) — testável e idempotente.
 */
export function detectarStatus(input: DetectorInput): ResultadoStatus {
  // ── Regra 1: override manual ──────────────────────────────────
  if (input.override) {
    const o = input.override;
    return {
      status: o.status,
      origem: 'manual',
      data: o.data ?? null,
      detalhe:
        o.nota?.trim() ||
        `Status definido manualmente como "${o.status}".`,
      evidencias: [
        { tipo: 'override', descricao: o.nota ?? '(sem nota)', data: o.data ?? null }
      ]
    };
  }

  const movimentosOrdenados = [...input.movimentos].sort(maisRecentePrimeiro);

  // ── Regra 2: movimento de baixa ──────────────────────────────
  const movBaixa = movimentosOrdenados.find(temCategoriaBaixa);
  if (movBaixa) {
    return {
      status: 'baixado',
      origem: 'movimento_oficial',
      data: movBaixa.data,
      detalhe: `Baixa registrada: "${movBaixa.descricao}".`,
      evidencias: [
        {
          tipo: 'movimento',
          descricao: movBaixa.descricao,
          data: movBaixa.data,
          codigoCnj: movBaixa.codigoCnj ?? undefined
        }
      ]
    };
  }

  // ── Regra 3: movimento de julgamento ─────────────────────────
  const movJulg = movimentosOrdenados.find(temCategoriaJulgamento);
  if (movJulg) {
    return {
      status: 'julgado',
      origem: 'movimento_oficial',
      data: movJulg.data,
      detalhe: `Julgamento registrado: "${movJulg.descricao}".`,
      evidencias: [
        {
          tipo: 'movimento',
          descricao: movJulg.descricao,
          data: movJulg.data,
          codigoCnj: movJulg.codigoCnj ?? undefined
        }
      ]
    };
  }

  // ── Regra 4: documento "Sentença" anexo (cobre migrados) ────
  if (input.detectaJulgadoPorDocumento && input.documentos) {
    const tiposPositivos = input.documentosTiposPositivos ?? ['Sentença'];
    const negativas = input.documentosDescricoesNegativas ?? [];
    const docSentenca = input.documentos.find((d) => {
      const tipoBate = tiposPositivos.some((t) => igualCI(d.tipo, t));
      if (!tipoBate) return false;
      // Ruído na descrição (minuta, embargos, recurso) descarta.
      const temRuido = negativas.some((r) => contemCI(d.descricao, r));
      return !temRuido;
    });
    if (docSentenca) {
      return {
        status: 'julgado',
        origem: 'documento_anexo',
        data: docSentenca.dataJuntada,
        detalhe:
          `Documento "${docSentenca.tipo}" juntado em ${docSentenca.dataJuntada} ` +
          `(processo provavelmente migrado sem histórico de movimentos).`,
        evidencias: [
          {
            tipo: 'documento',
            descricao: `${docSentenca.tipo}: ${docSentenca.descricao}`,
            data: docSentenca.dataJuntada
          }
        ]
      };
    }
  }

  // ── Regra 5: tarefa atual indica fase pós-julgamento ─────────
  const tarefa = (input.tarefaAtual ?? '').trim();
  if (tarefa) {
    const indicaBaixa = (input.tarefasIndicamBaixa ?? []).some((s) =>
      contemCI(tarefa, s)
    );
    if (indicaBaixa) {
      return {
        status: 'baixado',
        origem: 'tarefa_indireta',
        data: null,
        detalhe: `Tarefa atual "${tarefa}" indica baixa.`,
        evidencias: [{ tipo: 'tarefa', descricao: tarefa }]
      };
    }
    const indicaJulgado = (input.tarefasIndicamJulgado ?? []).some((s) =>
      contemCI(tarefa, s)
    );
    if (indicaJulgado) {
      return {
        status: 'julgado',
        origem: 'tarefa_indireta',
        data: null,
        detalhe:
          `Tarefa atual "${tarefa}" sugere fase pós-julgamento ` +
          `(data exata desconhecida — sem movimento ou documento que comprove).`,
        evidencias: [{ tipo: 'tarefa', descricao: tarefa }]
      };
    }
  }

  // ── Regra 6: sumiço inferido (mantém status anterior) ────────
  if (input.sumiuDaVarredura && input.statusAnterior) {
    return {
      status: input.statusAnterior.status,
      origem: 'inferido_sumico',
      data: input.statusAnterior.data,
      detalhe:
        `Processo não apareceu na última varredura. ` +
        `Mantendo classificação anterior ("${input.statusAnterior.status}", origem ${input.statusAnterior.origem}).`,
      evidencias: [
        {
          tipo: 'inferencia',
          descricao: 'Sumiço sem evidência de julgamento ou baixa.'
        }
      ]
    };
  }

  // ── Default: pendente ─────────────────────────────────────────
  return {
    status: 'pendente',
    origem: 'movimento_oficial',
    data: null,
    detalhe: 'Sem evidência de julgamento ou baixa — classificado como pendente.',
    evidencias: []
  };
}
