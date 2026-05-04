/**
 * Catálogo das classes processuais criminais usadas pelo perfil
 * "Gestão Criminal" do paidegua.
 *
 * Escopo: classes criminais ATIVAS no PJe legacy do TRF5 1º Grau,
 * extraídas integralmente da tela de administração de classes
 * judiciais (`/pje/ClasseJudicial/listView.seam`) — fonte canônica.
 *
 * Cada entrada carrega:
 *   - `codigo`            → código CNJ canônico (TPU/CNJ).
 *   - `nome`              → nome canônico do PJe (em CAIXA ALTA).
 *   - `sigla`             → sigla curta exibida pelo PJe nos painéis
 *                           (ex.: "APOrd", "HCCrim"). É o valor que o
 *                           REST do painel devolve em `classeJudicial` e
 *                           o que o filtro Fase 1 da varredura usa para
 *                           separar processo criminal de não-criminal.
 *   - `idClasseJudicial`  → PK interna desta instância (TRF5 1g).
 *                           **Específica por instância** — em outros
 *                           tribunais o mesmo código CNJ tem id
 *                           diferente. Usado em filtros server-side.
 *   - `categoria`         → agrupamento para a tree-view do Painel.
 *   - `isPrimaria`        → entra no dashboard primário (apenas
 *                           Procedimento Comum + Processo Especial).
 *   - `isAgrupador`       → flag para classes-pai que não viram
 *                           processo real (ex.: "PROCESSO CRIMINAL",
 *                           "MEDIDAS CAUTELARES"). Ficam no catálogo
 *                           apenas pelo valor defensivo no whitelist
 *                           de sigla — se um processo eventualmente
 *                           bater num agrupador, é criminal e passa.
 *
 * Decisões (2026-05-03, refeito após inspeção do dump real do PJe):
 *   - Categoria `'anpp'` removida — CNJ 14678 (Acordo de Não Persecução
 *     Penal) **não existe** na instância TRF5 1g. ANPPs locais são
 *     tratados dentro de `PetCrim` (1727) ou da própria `APOrd` (283)
 *     com assunto ANPP. A gestão de ANPP do dashboard usa os
 *     movimentos 12733/12734/12735 da timeline, não a classe.
 *   - Os `idClasseJudicial` da v1 estavam **todos errados** (eram de
 *     outra instância PJe). Refeitos a partir do dump real.
 *   - Adicionada `APSumss` (sumaríssimo, CNJ 10944) que faltava.
 *   - Removidas várias classes do catálogo antigo que não existem na
 *     instância TRF5 1g (Crimes de Responsabilidade, Lei Antitóxicos
 *     dedicada, MS Criminal, Habeas Data Criminal, Revisão Criminal,
 *     Insanidade Mental, Reabilitação, várias Exceções específicas).
 *     Se aparecerem em alguma varredura futura, o log de "siglas
 *     desconhecidas" sinaliza e adicionamos.
 *   - Categoria `'execucao_penal'` continua auxiliar — schema de
 *     prescrição/ANPP/SERP foi pensado pra cognição. Execução vira
 *     trilha futura.
 */

export type CategoriaCriminal =
  | 'desconhecida'
  | 'procedimento_comum'
  | 'processo_especial'
  | 'anpp'
  | 'execucao_penal'
  | 'cartas'
  | 'medidas_cautelares'
  | 'medidas_garantidoras'
  | 'medidas_preparatorias'
  | 'peticao'
  | 'procedimentos_investigatorios'
  | 'questoes_incidentes'
  | 'recursos';

export const CATEGORIAS_PRIMARIAS = [
  'procedimento_comum',
  'processo_especial',
  'anpp'
] as const satisfies readonly CategoriaCriminal[];

export type CategoriaPrimaria = (typeof CATEGORIAS_PRIMARIAS)[number];

export const CATEGORIA_LABELS: Record<CategoriaCriminal, string> = {
  desconhecida: 'Desconhecida',
  procedimento_comum: 'Procedimento Comum',
  processo_especial: 'Processo Especial',
  anpp: 'Acordo de Não Persecução Penal',
  execucao_penal: 'Execução Penal',
  cartas: 'Cartas',
  medidas_cautelares: 'Medidas Cautelares',
  medidas_garantidoras: 'Medidas Garantidoras',
  medidas_preparatorias: 'Medidas Preparatórias',
  peticao: 'Petição',
  procedimentos_investigatorios: 'Procedimentos Investigatórios',
  questoes_incidentes: 'Questões e Processos Incidentes',
  recursos: 'Recursos'
};

export interface ClasseCnjCriminal {
  /** Código CNJ canônico da TPU. */
  codigo: number;
  /** Nome canônico (em CAIXA ALTA conforme o PJe TRF5 exibe). */
  nome: string;
  /**
   * Sigla curta do PJe (CamelCase: `APOrd`, `HCCrim`, `IP`). Match
   * no whitelist é case-insensitive — o derivado em
   * `criminal-siglas.ts` faz `.toUpperCase()`.
   */
  sigla: string;
  /** Categoria de agrupamento na UI. */
  categoria: CategoriaCriminal;
  /** Entra no dashboard primário (procedimento comum + processo especial)? */
  isPrimaria: boolean;
  /**
   * É classe-pai (agrupador da tree-view) e não recebe processos
   * diretamente. Mantida no catálogo só pra resiliência do whitelist
   * de sigla — se um processo aparecer com sigla de agrupador
   * (improvável, mas possível em deploys atípicos), passa filtro.
   */
  isAgrupador: boolean;
  /**
   * ID interno da classe judicial no PJe TRF5 1g. **Específico desta
   * instância** — não tente reusar em outro tribunal sem reverificar
   * via `/pje/ClasseJudicial/listView.seam`.
   */
  idClasseJudicial: number;
}

export const CLASSES_CRIMINAIS: readonly ClasseCnjCriminal[] = [
  // ── Raiz ─────────────────────────────────────────────────────────
  { codigo: 268,   sigla: 'ProCri',        nome: 'PROCESSO CRIMINAL',                                       categoria: 'desconhecida',                  isPrimaria: false, isAgrupador: true,  idClasseJudicial: 307 },

  // ── Cartas ───────────────────────────────────────────────────────
  { codigo: 334,   sigla: 'Cartas',        nome: 'CARTAS',                                                  categoria: 'cartas',                        isPrimaria: false, isAgrupador: true,  idClasseJudicial: 390 },
  { codigo: 335,   sigla: 'CartOrdCrim',   nome: 'CARTA DE ORDEM CRIMINAL',                                 categoria: 'cartas',                        isPrimaria: false, isAgrupador: false, idClasseJudicial: 391 },
  { codigo: 355,   sigla: 'CartPrecCrim',  nome: 'CARTA PRECATÓRIA CRIMINAL',                               categoria: 'cartas',                        isPrimaria: false, isAgrupador: false, idClasseJudicial: 392 },
  { codigo: 375,   sigla: 'RogatoCrim',    nome: 'CARTA ROGATÓRIA CRIMINAL',                                categoria: 'cartas',                        isPrimaria: false, isAgrupador: false, idClasseJudicial: 393 },

  // ── Medidas Preparatórias ────────────────────────────────────────
  { codigo: 269,   sigla: 'MedPre',        nome: 'MEDIDAS PREPARATÓRIAS',                                   categoria: 'medidas_preparatorias',         isPrimaria: false, isAgrupador: true,  idClasseJudicial: 308 },
  { codigo: 274,   sigla: 'Interp',        nome: 'INTERPELAÇÕES',                                           categoria: 'medidas_preparatorias',         isPrimaria: false, isAgrupador: true,  idClasseJudicial: 310 },
  { codigo: 275,   sigla: 'NotExp',        nome: 'NOTIFICAÇÃO PARA EXPLICAÇÕES',                            categoria: 'medidas_preparatorias',         isPrimaria: false, isAgrupador: false, idClasseJudicial: 311 },
  { codigo: 276,   sigla: 'NotExpLI',      nome: 'NOTIFICAÇÃO PARA EXPLICAÇÕES (LEI DE IMPRENSA)',          categoria: 'medidas_preparatorias',         isPrimaria: false, isAgrupador: false, idClasseJudicial: 312 },

  // ── Procedimentos Investigatórios ────────────────────────────────
  { codigo: 277,   sigla: 'ProcInv',       nome: 'PROCEDIMENTOS INVESTIGATÓRIOS',                           categoria: 'procedimentos_investigatorios', isPrimaria: false, isAgrupador: true,  idClasseJudicial: 313 },
  { codigo: 271,   sigla: 'RpCr',          nome: 'REPRESENTAÇÃO CRIMINAL',                                  categoria: 'procedimentos_investigatorios', isPrimaria: false, isAgrupador: false, idClasseJudicial: 314 },
  { codigo: 272,   sigla: 'RpCrNotCrim',   nome: 'REPRESENTAÇÃO CRIMINAL/NOTÍCIA DE CRIME',                 categoria: 'procedimentos_investigatorios', isPrimaria: false, isAgrupador: false, idClasseJudicial: 315 },
  { codigo: 278,   sigla: 'TCO',           nome: 'TERMO CIRCUNSTANCIADO',                                   categoria: 'procedimentos_investigatorios', isPrimaria: false, isAgrupador: false, idClasseJudicial: 317 },
  { codigo: 279,   sigla: 'IP',            nome: 'INQUÉRITO POLICIAL',                                      categoria: 'procedimentos_investigatorios', isPrimaria: false, isAgrupador: false, idClasseJudicial: 318 },
  { codigo: 1731,  sigla: 'InvMag',        nome: 'INVESTIGAÇÃO CONTRA MAGISTRADO',                          categoria: 'procedimentos_investigatorios', isPrimaria: false, isAgrupador: false, idClasseJudicial: 320 },
  { codigo: 1733,  sigla: 'PICMP',         nome: 'PROCEDIMENTO INVESTIGATÓRIO CRIMINAL (PIC-MP)',           categoria: 'procedimentos_investigatorios', isPrimaria: false, isAgrupador: false, idClasseJudicial: 321 },
  { codigo: 12121, sigla: 'APri',          nome: 'COMUNICADO DE MANDADO DE PRISÃO',                         categoria: 'procedimentos_investigatorios', isPrimaria: false, isAgrupador: false, idClasseJudicial: 686 },

  // ── Procedimento Comum (PRIMÁRIA) ───────────────────────────────
  { codigo: 281,   sigla: 'ProcedCom',     nome: 'PROCEDIMENTO COMUM',                                      categoria: 'procedimento_comum',            isPrimaria: false, isAgrupador: true,  idClasseJudicial: 322 },
  { codigo: 282,   sigla: 'Juri',          nome: 'AÇÃO PENAL DE COMPETÊNCIA DO JÚRI',                       categoria: 'procedimento_comum',            isPrimaria: true,  isAgrupador: false, idClasseJudicial: 323 },
  { codigo: 283,   sigla: 'APOrd',         nome: 'AÇÃO PENAL - PROCEDIMENTO ORDINÁRIO',                     categoria: 'procedimento_comum',            isPrimaria: true,  isAgrupador: false, idClasseJudicial: 324 },
  { codigo: 10943, sigla: 'APSum',         nome: 'AÇÃO PENAL - PROCEDIMENTO SUMÁRIO',                       categoria: 'procedimento_comum',            isPrimaria: true,  isAgrupador: false, idClasseJudicial: 325 },
  { codigo: 10944, sigla: 'APSumss',       nome: 'AÇÃO PENAL - PROCEDIMENTO SUMARÍSSIMO',                   categoria: 'procedimento_comum',            isPrimaria: true,  isAgrupador: false, idClasseJudicial: 326 },

  // ── Processo Especial (PRIMÁRIA) ────────────────────────────────
  { codigo: 284,   sigla: 'ProEsp',        nome: 'PROCESSO ESPECIAL',                                       categoria: 'processo_especial',             isPrimaria: false, isAgrupador: true,  idClasseJudicial: 327 },
  // Filhas do agrupador PECPP (Processo Especial do Código de Processo Penal):
  { codigo: 285,   sigla: 'PECPP',         nome: 'PROCESSO ESPECIAL DO CÓDIGO DE PROCESSO PENAL',           categoria: 'processo_especial',             isPrimaria: false, isAgrupador: true,  idClasseJudicial: 328 },
  { codigo: 287,   sigla: 'CRFP',          nome: 'CRIMES DE RESPONSABILIDADE DOS FUNCIONÁRIOS PÚBLICOS',    categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 329 },
  { codigo: 288,   sigla: 'CCIDCJS',       nome: 'CRIMES DE CALÚNIA, INJÚRIA E DIFAMAÇÃO DE COMPETÊNCIA DO JUIZ SINGULAR', categoria: 'processo_especial',  isPrimaria: true,  isAgrupador: false, idClasseJudicial: 330 },
  { codigo: 289,   sigla: 'CCPImat',       nome: 'CRIMES CONTRA A PROPRIEDADE IMATERIAL',                   categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 331 },
  { codigo: 291,   sigla: 'ResAutCrim',    nome: 'RESTAURAÇÃO DE AUTOS CRIMINAL',                           categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 333 },
  { codigo: 11798, sigla: 'ProcApMSegFNC', nome: 'PROCESSO DE APLICAÇÃO DE MEDIDA DE SEGURANÇA POR FATO NÃO CRIMINOSO', categoria: 'processo_especial',     isPrimaria: true,  isAgrupador: false, idClasseJudicial: 334 },
  // Filhas do agrupador PELE (Processo Especial de Leis Esparsas):
  { codigo: 292,   sigla: 'PELE',          nome: 'PROCESSO ESPECIAL DE LEIS ESPARSAS',                      categoria: 'processo_especial',             isPrimaria: false, isAgrupador: true,  idClasseJudicial: 335 },
  { codigo: 293,   sigla: 'CriAmb',        nome: 'CRIMES AMBIENTAIS',                                       categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 336 },
  { codigo: 294,   sigla: 'CCPInd',        nome: 'CRIMES CONTRA A PROPRIEDADE INDUSTRIAL',                  categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 337 },
  { codigo: 295,   sigla: 'CCPInt',        nome: 'CRIMES CONTRA A PROPRIEDADE INTELECTUAL',                 categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 338 },
  { codigo: 297,   sigla: 'CriImp',        nome: 'CRIMES DE IMPRENSA',                                      categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 339 },
  { codigo: 300,   sigla: 'PrEsAn',        nome: 'PROCEDIMENTO ESPECIAL DA LEI ANTITÓXICOS',                categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 341 },
  { codigo: 302,   sigla: 'PECAA',         nome: 'PROCEDIMENTO ESPECIAL DOS CRIMES DE ABUSO DE AUTORIDADE', categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 342 },
  { codigo: 1710,  sigla: 'MSCrim',        nome: 'MANDADO DE SEGURANÇA CRIMINAL',                           categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 343 },
  { codigo: 12394, sigla: 'RevCrim',       nome: 'REVISÃO CRIMINAL',                                        categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 731 },
  { codigo: 14701, sigla: 'HDCrim',        nome: 'HABEAS DATA CRIMINAL',                                    categoria: 'processo_especial',             isPrimaria: true,  isAgrupador: false, idClasseJudicial: 758 },

  // ── Medidas Garantidoras ─────────────────────────────────────────
  { codigo: 303,   sigla: 'MedGar',        nome: 'MEDIDAS GARANTIDORAS',                                    categoria: 'medidas_garantidoras',          isPrimaria: false, isAgrupador: true,  idClasseJudicial: 344 },
  { codigo: 304,   sigla: 'Liberd',        nome: 'LIBERDADE',                                               categoria: 'medidas_garantidoras',          isPrimaria: false, isAgrupador: true,  idClasseJudicial: 345 },
  { codigo: 305,   sigla: 'LibProv',       nome: 'LIBERDADE PROVISÓRIA COM OU SEM FIANÇA',                  categoria: 'medidas_garantidoras',          isPrimaria: false, isAgrupador: false, idClasseJudicial: 346 },
  { codigo: 306,   sigla: 'RelPri',        nome: 'RELAXAMENTO DE PRISÃO',                                   categoria: 'medidas_garantidoras',          isPrimaria: false, isAgrupador: false, idClasseJudicial: 347 },
  { codigo: 307,   sigla: 'HCCrim',        nome: 'HABEAS CORPUS CRIMINAL',                                  categoria: 'medidas_garantidoras',          isPrimaria: false, isAgrupador: false, idClasseJudicial: 348 },

  // ── Medidas Cautelares ───────────────────────────────────────────
  { codigo: 308,   sigla: 'MedCau',        nome: 'MEDIDAS CAUTELARES',                                      categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: true,  idClasseJudicial: 349 },
  { codigo: 309,   sigla: 'PBACrim',       nome: 'PEDIDO DE BUSCA E APREENSÃO CRIMINAL',                    categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: false, idClasseJudicial: 350 },
  { codigo: 310,   sigla: 'QuebSig',       nome: 'PEDIDO DE QUEBRA DE SIGILO DE DADOS E/OU TELEFÔNICO',     categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: false, idClasseJudicial: 351 },
  { codigo: 311,   sigla: 'MISOC',         nome: 'MEDIDAS INVESTIGATÓRIAS SOBRE ORGANIZAÇÕES CRIMINOSAS',   categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: false, idClasseJudicial: 352 },
  { codigo: 312,   sigla: 'PedPri',        nome: 'PEDIDO DE PRISÃO',                                        categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: true,  idClasseJudicial: 353 },
  { codigo: 313,   sigla: 'PePrPr',        nome: 'PEDIDO DE PRISÃO PREVENTIVA',                             categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: false, idClasseJudicial: 354 },
  { codigo: 314,   sigla: 'PePrTe',        nome: 'PEDIDO DE PRISÃO TEMPORÁRIA',                             categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: false, idClasseJudicial: 355 },
  { codigo: 1268,  sigla: 'MPUMPCrim',     nome: 'MEDIDAS PROTETIVAS DE URGÊNCIA (LEI MARIA DA PENHA) CRIMINAL', categoria: 'medidas_cautelares',         isPrimaria: false, isAgrupador: false, idClasseJudicial: 357 },
  { codigo: 10967, sigla: 'MedProtEICrim', nome: 'MEDIDAS DE PROTEÇÃO À PESSOA IDOSA - CRIMINAL',           categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: false, idClasseJudicial: 358 },
  { codigo: 11793, sigla: 'PAPCrim',       nome: 'PRODUÇÃO ANTECIPADA DE PROVAS CRIMINAL',                  categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: false, idClasseJudicial: 359 },
  { codigo: 11955, sigla: 'CauInomCrim',   nome: 'CAUTELAR INOMINADA CRIMINAL',                             categoria: 'medidas_cautelares',            isPrimaria: false, isAgrupador: false, idClasseJudicial: 649 },

  // ── Questões e Processos Incidentes ──────────────────────────────
  { codigo: 316,   sigla: 'QuPrIn',        nome: 'QUESTÕES E PROCESSOS INCIDENTES',                         categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: true,  idClasseJudicial: 360 },
  // Filhas do agrupador Exc (Exceções):
  { codigo: 317,   sigla: 'Exc',           nome: 'EXCEÇÕES',                                                categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: true,  idClasseJudicial: 361 },
  { codigo: 318,   sigla: 'ExcSuspei',     nome: 'EXCEÇÃO DE SUSPEIÇÃO',                                    categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 362 },
  { codigo: 319,   sigla: 'ExcInc',        nome: 'EXCEÇÃO DE INCOMPETÊNCIA DE JUÍZO',                       categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 363 },
  { codigo: 320,   sigla: 'Litisp',        nome: 'EXCEÇÃO DE LITISPENDÊNCIA',                               categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 364 },
  { codigo: 321,   sigla: 'IlePar',        nome: 'EXCEÇÃO DE ILEGITIMIDADE DE PARTE',                       categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 365 },
  { codigo: 322,   sigla: 'CoiJul',        nome: 'EXCEÇÃO DE COISA JULGADA',                                categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 366 },
  { codigo: 323,   sigla: 'ExcImpedi',     nome: 'EXCEÇÃO DE IMPEDIMENTO',                                  categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 367 },
  { codigo: 324,   sigla: 'Verdad',        nome: 'EXCEÇÃO DA VERDADE',                                      categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 368 },
  // Restituição/Embargos de Terceiro:
  { codigo: 326,   sigla: 'ReCoAp',        nome: 'RESTITUIÇÃO DE COISAS APREENDIDAS',                       categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 369 },
  { codigo: 327,   sigla: 'ETCrim',        nome: 'EMBARGOS DE TERCEIRO CRIMINAL',                           categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 370 },
  // Filhas do agrupador MedAss (Medidas Assecuratórias):
  { codigo: 328,   sigla: 'MedAss',        nome: 'MEDIDAS ASSECURATÓRIAS',                                  categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: true,  idClasseJudicial: 371 },
  { codigo: 329,   sigla: 'Seques',        nome: 'SEQÜESTRO',                                               categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 372 },
  { codigo: 330,   sigla: 'ArrHipLeg',     nome: 'ARRESTO / HIPOTECA LEGAL',                                categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 373 },
  // Filhas do agrupador Inc (Incidentes):
  { codigo: 331,   sigla: 'Inc',           nome: 'INCIDENTES',                                              categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: true,  idClasseJudicial: 374 },
  { codigo: 332,   sigla: 'IncFal',        nome: 'INCIDENTE DE FALSIDADE',                                  categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 376 },
  { codigo: 333,   sigla: 'InsanAc',       nome: 'INSANIDADE MENTAL DO ACUSADO',                            categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 377 },
  { codigo: 1178,  sigla: 'ArgInc',        nome: 'INCIDENTE DE ARGUIÇÃO DE INCONSTITUCIONALIDADE CRIMINAL', categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 380 },
  { codigo: 1291,  sigla: 'Reabil',        nome: 'REABILITAÇÃO',                                            categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 381 },
  { codigo: 1719,  sigla: 'AvalDep',       nome: 'AVALIAÇÃO PARA ATESTAR DEPENDÊNCIA DE DROGAS',            categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 382 },
  { codigo: 11788, sigla: 'ExDoCoCrim',    nome: 'EXIBIÇÃO DE DOCUMENTO OU COISA CRIMINAL',                 categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 384 },
  { codigo: 11791, sigla: 'PUILCrim',      nome: 'PEDIDO DE UNIFORMIZAÇÃO DE INTERPRETAÇÃO DE LEI CRIMINAL',categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 387 },
  { codigo: 1715,  sigla: 'EmbAc',         nome: 'EMBARGOS DO ACUSADO',                                     categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 388 },
  { codigo: 1717,  sigla: 'AlienBAc',      nome: 'ALIENAÇÃO DE BENS DO ACUSADO',                            categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 389 },
  { codigo: 12077, sigla: 'HomoAcColPrem', nome: 'HOMOLOGAÇÃO EM ACORDO DE COLABORAÇÃO PREMIADA',           categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 674 },
  { codigo: 14123, sigla: 'DestBemApre',   nome: 'DESTINAÇÃO DE BENS APREENDIDOS',                          categoria: 'questoes_incidentes',           isPrimaria: false, isAgrupador: false, idClasseJudicial: 759 },

  // ── Execução Penal (auxiliar v1) ─────────────────────────────────
  { codigo: 385,   sigla: 'ExeCri',        nome: 'EXECUÇÃO PENAL E DE MEDIDAS ALTERNATIVAS',                categoria: 'execucao_penal',                isPrimaria: false, isAgrupador: true,  idClasseJudicial: 394 },
  { codigo: 386,   sigla: 'ExPe',          nome: 'EXECUÇÃO DA PENA',                                        categoria: 'execucao_penal',                isPrimaria: false, isAgrupador: false, idClasseJudicial: 395 },
  { codigo: 12727, sigla: 'ExePenMul',     nome: 'EXECUÇÃO DE PENA DE MULTA',                               categoria: 'execucao_penal',                isPrimaria: false, isAgrupador: false, idClasseJudicial: 756 },
  { codigo: 12728, sigla: 'TEEP',          nome: 'TRANSFERÊNCIA ENTRE ESTABELECIMENTOS PENAIS',             categoria: 'execucao_penal',                isPrimaria: false, isAgrupador: false, idClasseJudicial: 757 },
  { codigo: 14696, sigla: 'ExeMedAltJE',   nome: 'EXECUÇÃO DE MEDIDAS ALTERNATIVAS NOS JUIZADOS ESPECIAIS', categoria: 'execucao_penal',                isPrimaria: false, isAgrupador: false, idClasseJudicial: 755 },

  // ── Recursos ─────────────────────────────────────────────────────
  { codigo: 412,   sigla: 'Rec',           nome: 'RECURSOS',                                                categoria: 'recursos',                      isPrimaria: false, isAgrupador: true,  idClasseJudicial: 407 },
  { codigo: 413,   sigla: 'AgExPe',        nome: 'AGRAVO DE EXECUÇÃO PENAL',                                categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 408 },
  { codigo: 417,   sigla: 'ApCrim',        nome: 'APELAÇÃO CRIMINAL',                                       categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 410 },
  { codigo: 418,   sigla: 'CT',            nome: 'CARTA TESTEMUNHÁVEL',                                     categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 411 },
  { codigo: 419,   sigla: 'CorPar',        nome: 'CORREIÇÃO PARCIAL CRIMINAL',                              categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 412 },
  { codigo: 420,   sigla: 'EDCrim',        nome: 'EMBARGOS DE DECLARAÇÃO CRIMINAL',                         categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 413 },
  { codigo: 421,   sigla: 'EIfNu',         nome: 'EMBARGOS INFRINGENTES E DE NULIDADE',                     categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 414 },
  { codigo: 427,   sigla: 'RemNecCrim',    nome: 'REMESSA NECESSÁRIA CRIMINAL',                             categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 419 },
  { codigo: 1711,  sigla: 'AIREsp',        nome: 'AGRAVO DE INSTRUMENTO EM RECURSO ESPECIAL',               categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 421 },
  { codigo: 1729,  sigla: 'ArRCrim',       nome: 'AGRAVO REGIMENTAL CRIMINAL',                              categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 423 },
  { codigo: 11398, sigla: 'RSEExOf',       nome: 'RECURSO EM SENTIDO ESTRITO/RECURSO EX OFFICIO',           categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 425 },
  { codigo: 12122, sigla: 'ReclCrim',      nome: 'RECLAMAÇÃO CRIMINAL',                                     categoria: 'recursos',                      isPrimaria: false, isAgrupador: false, idClasseJudicial: 687 },

  // ── Acordo de Não Persecução Penal (PRIMÁRIA) ────────────────────
  // Confirmada na varredura admin do TRF5 1g em 2026-05-03 com sigla
  // "AcNãoPerPenal" (não "ANPP" como antes presumido). É a classe-alvo
  // do dashboard de gestão ANPP — categoria primária dedicada.
  { codigo: 14678, sigla: 'AcNãoPerPenal', nome: 'ACORDO DE NÃO PERSECUÇÃO PENAL',                          categoria: 'anpp',                          isPrimaria: true,  isAgrupador: false, idClasseJudicial: 760 },

  // ── Petição ──────────────────────────────────────────────────────
  { codigo: 1727,  sigla: 'PetCrim',       nome: 'PETIÇÃO CRIMINAL',                                        categoria: 'peticao',                       isPrimaria: false, isAgrupador: false, idClasseJudicial: 426 }
] as const;

// ── Índices derivados ───────────────────────────────────────────

const POR_CODIGO: ReadonlyMap<number, ClasseCnjCriminal> = new Map(
  CLASSES_CRIMINAIS.map((c) => [c.codigo, c])
);

const POR_ID_CLASSE_JUDICIAL: ReadonlyMap<number, ClasseCnjCriminal> = new Map(
  CLASSES_CRIMINAIS.map((c) => [c.idClasseJudicial, c])
);

/**
 * Normaliza uma sigla para comparação no whitelist:
 *   - trim
 *   - UPPER-case
 *   - NFC (algumas siglas têm acentos — `AcNãoPerPenal` — e o REST
 *     do PJe pode entregar em NFD em ambientes específicos; NFC
 *     garante match case-insensitive estável)
 */
export function normalizarSigla(sigla: string): string {
  return sigla.trim().toUpperCase().normalize('NFC');
}

/**
 * Mapa por sigla normalizada. Comparação case-insensitive +
 * Unicode-stable é feita pelo caller chamando `normalizarSigla()`
 * antes do lookup.
 *
 * Quando duas classes raras compartilham sigla (não observado no
 * TRF5 1g hoje, mas possível em catálogos atípicos), o `Map` fica
 * com a última inserção — comportamento aceitável para o uso atual
 * (apenas teste de pertinência criminal, não desambiguação fina).
 */
const POR_SIGLA_UPPER: ReadonlyMap<string, ClasseCnjCriminal> = new Map(
  CLASSES_CRIMINAIS.map((c) => [normalizarSigla(c.sigla), c])
);

/** Códigos CNJ de todas as classes do catálogo. */
export const CODIGOS_CRIMINAIS: readonly number[] = CLASSES_CRIMINAIS.map(
  (c) => c.codigo
);

/** Subset primário (procedimento_comum + processo_especial). */
export const CODIGOS_PRIMARIOS: readonly number[] = CLASSES_CRIMINAIS
  .filter((c) => c.isPrimaria)
  .map((c) => c.codigo);

/** Subset auxiliar — filtragem em fase posterior (Fase 8). */
export const CODIGOS_AUXILIARES: readonly number[] = CLASSES_CRIMINAIS
  .filter((c) => !c.isPrimaria)
  .map((c) => c.codigo);

/** IDs do PJe correspondentes às classes primárias — para o filtro REST. */
export const IDS_CLASSE_JUDICIAL_PRIMARIOS: readonly number[] = CLASSES_CRIMINAIS
  .filter((c) => c.isPrimaria)
  .map((c) => c.idClasseJudicial);

/**
 * Set de siglas (UPPER-case) reconhecidas como criminais. Consumido
 * pelo whitelist em `criminal-siglas.ts`. Inclui agrupadores como
 * fallback defensivo — se um processo aparecer com sigla de
 * agrupador, ainda é criminal e passa filtro.
 */
export const SIGLAS_CRIMINAIS_UPPER: ReadonlySet<string> = new Set(
  CLASSES_CRIMINAIS.map((c) => normalizarSigla(c.sigla))
);

export function getClasseByCodigo(codigo: number): ClasseCnjCriminal | undefined {
  return POR_CODIGO.get(codigo);
}

export function getClasseByIdJudicial(
  idClasseJudicial: number
): ClasseCnjCriminal | undefined {
  return POR_ID_CLASSE_JUDICIAL.get(idClasseJudicial);
}

export function getClasseBySigla(sigla: string): ClasseCnjCriminal | undefined {
  return POR_SIGLA_UPPER.get(normalizarSigla(sigla));
}

export function isCodigoCriminal(codigo: number): boolean {
  return POR_CODIGO.has(codigo);
}

export function isCodigoPrimario(codigo: number): boolean {
  return POR_CODIGO.get(codigo)?.isPrimaria === true;
}

export function getCategoriaDoCodigo(codigo: number): CategoriaCriminal | null {
  return POR_CODIGO.get(codigo)?.categoria ?? null;
}

export function getIdClasseJudicial(codigoCnj: number): number | null {
  return POR_CODIGO.get(codigoCnj)?.idClasseJudicial ?? null;
}

/**
 * Agrupa as classes por categoria, preservando a ordem de declaração.
 * Útil para construir a tree-view do Painel de Varredura.
 */
export function classesPorCategoria(): Record<CategoriaCriminal, ClasseCnjCriminal[]> {
  const out: Record<CategoriaCriminal, ClasseCnjCriminal[]> = {
    desconhecida: [],
    procedimento_comum: [],
    processo_especial: [],
    anpp: [],
    execucao_penal: [],
    cartas: [],
    medidas_cautelares: [],
    medidas_garantidoras: [],
    medidas_preparatorias: [],
    peticao: [],
    procedimentos_investigatorios: [],
    questoes_incidentes: [],
    recursos: []
  };
  for (const classe of CLASSES_CRIMINAIS) {
    out[classe.categoria].push(classe);
  }
  return out;
}
