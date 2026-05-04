/**
 * Catálogo de movimentos processuais (TPU/CNJ) relevantes para o perfil
 * "Gestão Criminal" do paidegua.
 *
 * Fonte primária: Tabela de Movimentos Processuais — Justiça Estadual 1º
 * Grau, baixada do SGT/CNJ
 *   http://www.cnj.jus.br/sgt/versoes_tabelas/xls_ultima_versao/Movimentos/
 *     Tabela_Movimentos_Justica_Estadual_1_Grau.xls
 *
 * Códigos do bloco ANPP (12733/12734/12735) — não constam dessa versão da
 * tabela; foram confirmados via TJDFT
 *   https://www.tjdft.jus.br/informacoes/significado-dos-andamentos/andamentos/12733
 *
 * Estes códigos compõem o filtro de varredura usado em
 * `pje-criminal-fetcher.ts`: ao consultar os movimentos de cada processo,
 * mapeamos os reconhecidos para preencher campos de `Processo`/`Reu`
 * automaticamente. Os não reconhecidos são ignorados (registro silencioso
 * no console em modo dev).
 *
 * Por que catalogar e não simplesmente armazenar tudo do PJe: precisamos
 * extrair *o significado* de cada movimento para alimentar
 * `data_recebimento_denuncia`, `data_sentenca`, `status_anpp` etc. — esse
 * mapeamento é o que diferencia a varredura criminal de uma simples
 * cópia.
 */

/**
 * Tipo semântico do movimento — usado pelo fetcher para decidir qual
 * campo de `Processo`/`Reu` preencher.
 */
export type TipoMovimentoCriminal =
  | 'recebimento_denuncia'   // Recebida a denúncia
  | 'recebimento_queixa'     // Recebida a queixa (ação privada)
  | 'suspensao_366'          // Suspensão por art. 366 CPP (réu revel cit. edital)
  | 'suspensao_condicional'  // Suspensão Condicional do Processo (Lei 9099)
  | 'sentenca_procedencia'   // Procedência → condenação em criminal
  | 'sentenca_improcedencia' // Improcedência → absolvição em criminal
  | 'sentenca_parcial'       // Procedência em parte
  | 'absolvicao_sumaria'     // Absolvição sumária (CPP 397 ou 415)
  | 'pronuncia'              // Sentença de pronúncia (júri)
  | 'impronuncia'            // Sentença de impronúncia (júri)
  | 'extincao_punibilidade'  // Extinção da punibilidade (todos os motivos)
  | 'extincao_prescricao'    // Extinção por prescrição (subtipo de extinção)
  | 'declaracao_prescricao'  // Declarada decadência ou prescrição (sentença)
  | 'homologacao_anpp'       // Homologação do ANPP
  | 'revogacao_anpp'         // Revogação do ANPP
  | 'cumprimento_anpp'       // Cumprimento do ANPP
  | 'homologacao_transacao'; // Homologada Transação (CPC) — diferente de ANPP

export interface MovimentoCriminal {
  codigo: number;
  /** Nome canônico exato da TPU. */
  nome: string;
  /** Classificação semântica para o fetcher. */
  tipo: TipoMovimentoCriminal;
  /** Código pai na hierarquia TPU (informativo). */
  codigoPai?: number;
  /** Diploma legal de referência. */
  diploma?: string;
  /** Artigo de referência. */
  artigo?: string;
  /** `true` se é um movimento agrupador (não usado diretamente em processos). */
  isAgrupador?: boolean;
}

export const MOVIMENTOS_CRIMINAIS: readonly MovimentoCriminal[] = [
  // ── Recebimento (pai 160) ──────────────────────────────────────
  {
    codigo: 391,
    nome: 'Recebida a denúncia',
    tipo: 'recebimento_denuncia',
    codigoPai: 160,
    diploma: 'CPP',
    artigo: '394; CP 117 I'
  },
  {
    codigo: 393,
    nome: 'Recebida a queixa',
    tipo: 'recebimento_queixa',
    codigoPai: 160,
    diploma: 'CPP',
    artigo: '394'
  },

  // ── Suspensão (pai 25) ─────────────────────────────────────────
  {
    codigo: 263,
    nome: 'Processo Suspenso por Réu revel citado por edital',
    tipo: 'suspensao_366',
    codigoPai: 25,
    diploma: 'CPP',
    artigo: '366'
  },
  {
    codigo: 264,
    nome: 'Suspensão Condicional do Processo',
    tipo: 'suspensao_condicional',
    codigoPai: 25,
    diploma: 'Lei 9.099/95',
    artigo: '89'
  },

  // ── Sentença / Julgamento (pai 385) ────────────────────────────
  {
    codigo: 219,
    nome: 'Julgado procedente o pedido',
    tipo: 'sentenca_procedencia',
    codigoPai: 385
  },
  {
    codigo: 220,
    nome: 'Julgado improcedente o pedido',
    tipo: 'sentenca_improcedencia',
    codigoPai: 385
  },
  {
    codigo: 221,
    nome: 'Julgado procedente em parte do pedido',
    tipo: 'sentenca_parcial',
    codigoPai: 385
  },
  {
    codigo: 11876,
    nome: 'Absolvido sumariamente o réu - art. 397 do CPP',
    tipo: 'absolvicao_sumaria',
    codigoPai: 385,
    diploma: 'CPP',
    artigo: '397'
  },
  {
    codigo: 11877,
    nome: 'Absolvido sumariamente o réu - art. 415 do CPP',
    tipo: 'absolvicao_sumaria',
    codigoPai: 385,
    diploma: 'CPP',
    artigo: '415'
  },
  {
    codigo: 10953,
    nome: 'Proferida Sentença de Pronúncia',
    tipo: 'pronuncia',
    codigoPai: 218,
    diploma: 'CPP',
    artigo: '413'
  },
  {
    codigo: 10961,
    nome: 'Proferida Sentença de Impronúncia',
    tipo: 'impronuncia',
    codigoPai: 218,
    diploma: 'CPP',
    artigo: '414'
  },
  {
    codigo: 471,
    nome: 'Declarada decadência ou prescrição',
    tipo: 'declaracao_prescricao',
    codigoPai: 385,
    diploma: 'CPC',
    artigo: '269 IV'
  },
  {
    codigo: 466,
    nome: 'Homologada a Transação',
    tipo: 'homologacao_transacao',
    codigoPai: 385,
    diploma: 'CPC',
    artigo: '269 III'
  },

  // ── Extinção da Punibilidade (pai 973) ─────────────────────────
  {
    codigo: 973,
    nome: 'Extinta a Punibilidade por',
    tipo: 'extincao_punibilidade',
    codigoPai: 385,
    diploma: 'CP; LEP',
    artigo: '107; 66, II',
    isAgrupador: true
  },
  {
    codigo: 11878,
    nome: 'Extinta a punibilidade por prescrição',
    tipo: 'extincao_prescricao',
    codigoPai: 973,
    diploma: 'CP',
    artigo: '107 IV'
  },
  {
    codigo: 1042,
    nome: 'Extinta a Punibilidade por morte do agente',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'CP',
    artigo: '107 I'
  },
  {
    codigo: 1043,
    nome: 'Extinta a Punibilidade por anistia, graça ou indulto',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'CP',
    artigo: '107 II'
  },
  {
    codigo: 1044,
    nome: 'Extinta a Punibilidade por retroatividade de lei',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'CP',
    artigo: '107 III'
  },
  {
    codigo: 1046,
    nome: 'Extinta a Punibilidade por renúncia do queixoso ou perdão aceito',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'CP',
    artigo: '107 V'
  },
  {
    codigo: 1047,
    nome: 'Extinta a Punibilidade por retratação do agente',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'CP',
    artigo: '107 VI'
  },
  {
    codigo: 1048,
    nome: 'Extinta a Punibilidade por perdão judicial',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'CP',
    artigo: '107 IX'
  },
  {
    codigo: 1049,
    nome: 'Extinta a Punibilidade por pagamento integral do débito',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'Lei 10.684/2003',
    artigo: '9º §2º'
  },
  {
    codigo: 1050,
    nome: 'Extinta a Punibilidade por Cumprimento da Pena',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'LEP',
    artigo: '66 II'
  },
  {
    codigo: 11411,
    nome: 'Extinta a punibilidade por cumprimento da suspensão condicional do processo',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'Lei 9.099/95',
    artigo: '89 §5º'
  },
  {
    codigo: 11879,
    nome: 'Extinta a punibilidade por decadência ou perempção',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'CP',
    artigo: '107 IV'
  },
  {
    codigo: 12028,
    nome: 'Extinta a punibilidade por cumprimento da transação penal',
    tipo: 'extincao_punibilidade',
    codigoPai: 973,
    diploma: 'Lei 9.099/95',
    artigo: '84 par. único'
  },

  // ── ANPP (Lei 13.964/2019) ─────────────────────────────────────
  // Não consta da versão da TPU baixada (anterior à atualização ANPP).
  // Códigos confirmados via TJDFT:
  // https://www.tjdft.jus.br/informacoes/significado-dos-andamentos/andamentos/12733
  {
    codigo: 12733,
    nome: 'Homologação do Acordo de Não Persecução Penal',
    tipo: 'homologacao_anpp',
    diploma: 'CPP',
    artigo: '28-A'
  },
  {
    codigo: 12734,
    nome: 'Revogação do Acordo de Não Persecução Penal',
    tipo: 'revogacao_anpp',
    diploma: 'CPP',
    artigo: '28-A §10'
  },
  {
    codigo: 12735,
    nome: 'Cumprimento de ANPP',
    tipo: 'cumprimento_anpp',
    diploma: 'CPP',
    artigo: '28-A §13'
  }
] as const;

// ── Índices derivados ───────────────────────────────────────────

const POR_CODIGO: ReadonlyMap<number, MovimentoCriminal> = new Map(
  MOVIMENTOS_CRIMINAIS.map((m) => [m.codigo, m])
);

const POR_TIPO: ReadonlyMap<TipoMovimentoCriminal, MovimentoCriminal[]> = (() => {
  const out = new Map<TipoMovimentoCriminal, MovimentoCriminal[]>();
  for (const m of MOVIMENTOS_CRIMINAIS) {
    const list = out.get(m.tipo) ?? [];
    list.push(m);
    out.set(m.tipo, list);
  }
  return out;
})();

/** Códigos numéricos como `readonly number[]` (todos os mapeados). */
export const CODIGOS_MOVIMENTOS_CRIMINAIS: readonly number[] = MOVIMENTOS_CRIMINAIS.map(
  (m) => m.codigo
);

export function getMovimentoByCodigo(codigo: number): MovimentoCriminal | undefined {
  return POR_CODIGO.get(codigo);
}

export function isMovimentoCriminal(codigo: number): boolean {
  return POR_CODIGO.has(codigo);
}

export function getMovimentosByTipo(
  tipo: TipoMovimentoCriminal
): readonly MovimentoCriminal[] {
  return POR_TIPO.get(tipo) ?? [];
}

/**
 * Conjuntos de códigos para uso pelo fetcher (filtros rápidos).
 * Mantém-se em sincronia com `MOVIMENTOS_CRIMINAIS` via `getMovimentosByTipo`.
 */
export const CODIGOS_RECEBIMENTO_DENUNCIA: readonly number[] = [
  ...getMovimentosByTipo('recebimento_denuncia').map((m) => m.codigo),
  ...getMovimentosByTipo('recebimento_queixa').map((m) => m.codigo)
];

export const CODIGOS_SENTENCA: readonly number[] = [
  ...getMovimentosByTipo('sentenca_procedencia').map((m) => m.codigo),
  ...getMovimentosByTipo('sentenca_improcedencia').map((m) => m.codigo),
  ...getMovimentosByTipo('sentenca_parcial').map((m) => m.codigo),
  ...getMovimentosByTipo('absolvicao_sumaria').map((m) => m.codigo),
  ...getMovimentosByTipo('pronuncia').map((m) => m.codigo),
  ...getMovimentosByTipo('impronuncia').map((m) => m.codigo)
];

export const CODIGOS_SUSPENSAO_366: readonly number[] = getMovimentosByTipo(
  'suspensao_366'
).map((m) => m.codigo);

export const CODIGOS_ANPP: readonly number[] = [
  ...getMovimentosByTipo('homologacao_anpp').map((m) => m.codigo),
  ...getMovimentosByTipo('revogacao_anpp').map((m) => m.codigo),
  ...getMovimentosByTipo('cumprimento_anpp').map((m) => m.codigo)
];

export const CODIGOS_EXTINCAO_PUNIBILIDADE: readonly number[] = [
  ...getMovimentosByTipo('extincao_punibilidade').map((m) => m.codigo),
  ...getMovimentosByTipo('extincao_prescricao').map((m) => m.codigo),
  ...getMovimentosByTipo('declaracao_prescricao').map((m) => m.codigo)
];
