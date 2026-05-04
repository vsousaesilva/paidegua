/**
 * Tabela Processual Unificada (TPU/CNJ) — tipos do catálogo de
 * movimentos processuais reconhecidos pelo PJe.
 *
 * O catálogo bruto é extraído da tela de cadastro do PJe TRF5
 * (`/pje/Evento/listView.seam`) e materializado em `tpu-seed-data.ts`
 * via `scripts/build-tpu-seed.mjs`. As categorias semânticas são
 * adicionadas em arquivos separados (um por domínio: julgamento,
 * audiência, criminal etc.) e mescladas em runtime ao popular o banco
 * `paidegua.tpu`.
 *
 * Por que catalogar localmente em vez de buscar via REST:
 *   - O endpoint não é estável nem público no PJe.
 *   - A TPU SGT muda raramente (revisões anuais do CNJ); locais por
 *     tribunal mudam mais, mas ainda assim em escala de meses.
 *   - Asset embarcado no bundle = inicialização instantânea, zero
 *     dependência de rede para popular o banco.
 */

/**
 * Origem do movimento na taxonomia processual.
 *   - `'SGT'`  → Sistema de Gestão de Tabelas do CNJ — padrão nacional,
 *                estável, reusável em qualquer tribunal.
 *   - `'TRF5'` → Movimento local criado/customizado pelo TRF5; pode não
 *                existir em outros tribunais.
 *
 * Ao escalar para outros TRFs, basta acrescentar `'TRF1' | 'TRF2' | ...`
 * e gerar seeds adicionais.
 */
export type TpuOrigem = 'SGT' | 'TRF5';

/**
 * Categorias semânticas aplicáveis a movimentos. Populadas
 * incrementalmente conforme features pedem — começa vazia para a maioria
 * dos movimentos. Cada categoria mora em um arquivo de mapeamento
 * dedicado (ex.: `tpu-categorias-julgamento.ts`) que mescla sobre o seed
 * ao popular o banco.
 *
 * Adicionar novos rótulos aqui antes de usar — manter o conjunto fechado
 * permite verificação em compile time.
 */
export type TpuCategoria =
  // Bloco "fim do processo" (Metas CNJ, Painel Gerencial)
  | 'julgamento_merito'
  | 'julgamento_sem_merito'
  | 'homologacao_acordo'
  | 'extincao_punibilidade'
  | 'baixa'
  | 'redistribuicao'
  // Bloco temporal/fluxo
  | 'suspensao'
  | 'levantamento_suspensao'
  | 'despacho_impulso'
  | 'ato_ordinatorio'
  // Bloco audiência (Audiência pAIdegua)
  | 'audiencia_designacao'
  | 'audiencia_realizada'
  | 'audiencia_cancelada'
  // Bloco criminal (Sigcrim)
  | 'sentenca_criminal'
  | 'absolvicao'
  | 'condenacao'
  | 'recebimento_denuncia'
  | 'pronuncia'
  | 'impronuncia'
  | 'homologacao_anpp'
  | 'revogacao_anpp'
  | 'cumprimento_anpp'
  // Bloco execução / cumprimento
  | 'execucao_iniciada'
  | 'cumprimento_sentenca_iniciado';

/**
 * Movimento processual canônico do catálogo TPU.
 *
 * Identidade: `codigoCnj` é a chave estável universal que aparece no
 * histórico de movimentos do processo (DOM dos autos digitais). Não
 * confundir com `identificadorInternoPje`, que é PK interna desta
 * instância TRF5 e muda entre tribunais — mantida apenas para auditoria.
 */
export interface MovimentoTpu {
  /** Código CNJ canônico — chave estável universal. */
  codigoCnj: number;
  /**
   * Descrição oficial do movimento (preserva placeholders do PJe como
   * `#{nome_da_parte}`, que aparecem renderizados no histórico real).
   */
  descricao: string;
  /**
   * Caminho hierárquico humano com códigos entre parênteses, ex.:
   * `"Magistrado (1) | Decisão (3) | Acolhimento de exceção (133)"`.
   */
  caminhoCompleto: string;
  /**
   * Códigos da raiz até o movimento — útil para queries hierárquicas via
   * IndexedDB `multiEntry`. O último elemento é igual a `codigoCnj`.
   * Vazio em movimentos cujo caminho do PJe não usa `(N)` no fim de cada
   * segmento (caso raro em locais antigos).
   */
  caminhoCodigos: number[];
  /** Pai imediato na árvore. `null` em nós raiz (Magistrado, Serventuário etc.). */
  superiorCodigoCnj: number | null;
  /** Profundidade na árvore (1 = raiz). `null` quando o PJe não declara o nível. */
  nivel: number | null;
  /** Origem do movimento na taxonomia. */
  origem: TpuOrigem;
  /**
   * Categorias semânticas aplicadas — vazio por padrão. A lista é
   * preenchida pelo merge de mapeamentos em `tpu-categorias-*.ts` no
   * momento de popular o banco `paidegua.tpu`.
   */
  categorias: TpuCategoria[];
  /**
   * `true` quando o movimento ainda é ofertado no cadastro do PJe;
   * `false` quando descontinuado (ex.: refatorado para outro código,
   * deprecado por revisão da TPU). Movimentos inativos permanecem no
   * catálogo porque processos antigos ainda referenciam esses códigos
   * no histórico — precisamos reconhecê-los para classificação retroativa.
   */
  ativo: boolean;
  /**
   * ID interno do PJe — específico desta instância (TRF5 1g). NÃO usar
   * para cross-reference com outros tribunais. Mantido apenas para
   * auditoria/diagnóstico em logs.
   */
  identificadorInternoPje?: number;
}

/**
 * Snapshot publicado de uma extração do catálogo. Conteúdo do arquivo
 * `tpu-seed-data.ts`.
 */
export interface TpuSeedSnapshot {
  /** ISO da extração no PJe. */
  extraidoEm: string;
  /** Hostname do PJe de origem (auditoria). */
  paginaPje: string;
  /** Total de movimentos coletados — cross-check com `movimentos.length`. */
  total: number;
  /** Contagem por origem (auditoria). */
  contagemPorOrigem: Record<TpuOrigem, number>;
  /** Contagem ativos vs inativos (auditoria). */
  contagemPorStatus: { ativo: number; inativo: number };
  movimentos: readonly MovimentoTpu[];
}
