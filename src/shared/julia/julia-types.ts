/**
 * Tipos do cliente JULIA — pesquisa de jurisprudência do TRF5.
 *
 * Contratos levantados na Fase 0; ver `docs/extracao-julia-trf5.md` para as
 * capturas que os originaram e para o que ainda está por confirmar.
 *
 * Dois pontos que este arquivo existe para tornar difíceis de errar:
 *
 *   1. **Vocabulário duplo.** O segmento da URL (`TR_CE`) NÃO é o mesmo valor
 *      que volta nos campos da resposta (`orgao: "JFCE"`, `instancia: "TR"`).
 *      São dois vocabulários distintos e não deriváveis um do outro por
 *      manipulação de string — daí `JuliaInstancia` (URL) e os campos brutos
 *      serem tipos separados.
 *   2. **Assimetria de data.** A API recebe `dd/MM/yyyy` e devolve ISO
 *      `yyyy-MM-dd`. Toda a superfície pública daqui trabalha em ISO; a
 *      conversão fica confinada ao cliente.
 */

// ── Instâncias (segmento da URL) ─────────────────────────────────

/** Seccionais oferecidas pela interface da Júlia. */
export const JULIA_SECCIONAIS = ['AL', 'CE', 'PB', 'PE', 'RN', 'SE'] as const;
export type JuliaSeccional = (typeof JULIA_SECCIONAIS)[number];

/**
 * Valor aceito no segmento `{instancia}` da URL.
 *
 * `G1`, `G1_CE`, `JEF`, `JEF_CE`, `TR` e `TURMA_RECURSAL` foram testados e
 * respondem **400** — o 1º grau não existe nesta API (doc §1.2).
 */
export type JuliaInstancia = 'G2' | 'TRU' | `TR_${JuliaSeccional}`;

/**
 * Instâncias efetivamente verificadas com resposta 200. As demais `TR_*`
 * são presumidas válidas pelo padrão observado, mas não testadas — se uma
 * delas devolver 400 em produção, é aqui que a suspeita começa.
 */
export const JULIA_INSTANCIAS_VERIFICADAS: readonly JuliaInstancia[] = [
  'G2',
  'TRU',
  'TR_CE',
  'TR_PE'
] as const;

/** Rótulos para a interface. */
export const JULIA_INSTANCIA_LABELS: Record<JuliaInstancia, string> = {
  G2: 'TRF5 — Segundo Grau',
  TRU: 'Turma Regional de Uniformização',
  TR_AL: 'Turma Recursal — Alagoas',
  TR_CE: 'Turma Recursal — Ceará',
  TR_PB: 'Turma Recursal — Paraíba',
  TR_PE: 'Turma Recursal — Pernambuco',
  TR_RN: 'Turma Recursal — Rio Grande do Norte',
  TR_SE: 'Turma Recursal — Sergipe'
};

// ── API autenticada: eixos separados ─────────────────────────────

/**
 * Unidade. Na API autenticada é parâmetro próprio (`orgao`), ao contrário da
 * pública, que funde unidade e instância num segmento composto no caminho.
 */
export const JULIA_ORGAOS = [
  'TRF5',
  'JFAL',
  'JFCE',
  'JFPB',
  'JFPE',
  'JFRN',
  'JFSE'
] as const;
export type JuliaOrgao = (typeof JULIA_ORGAOS)[number];

/**
 * Instância na API autenticada. **`G1` é o 1º grau comum** — o rótulo "Comum"
 * da interface. Confirmados na captura: `G1` e `JEF`. `TR` e `TRU` são
 * inferidos dos rótulos e ainda não verificados (doc §5.10).
 */
export const JULIA_INSTANCIAS_AUTENTICADAS = ['G1', 'JEF', 'TR', 'TRU'] as const;
export type JuliaInstanciaAutenticada =
  (typeof JULIA_INSTANCIAS_AUTENTICADAS)[number];

export const JULIA_INSTANCIA_AUTENTICADA_LABELS: Record<
  JuliaInstanciaAutenticada,
  string
> = {
  G1: 'Comum (1º grau)',
  JEF: 'Juizado Especial Federal',
  TR: 'Turma Recursal',
  TRU: 'Turma Regional de Uniformização'
};

// ── Tipos de documento ───────────────────────────────────────────

/**
 * ATENÇÃO: há **dois vocabulários distintos** de tipo de documento, e trocá-los
 * é erro silencioso (filtro que não filtra, comparação que nunca casa).
 *
 *   - **Na resposta**: maiúscula sem acento (`EMENTA`, `ACORDAO`).
 *   - **No filtro da API autenticada**: título com acento, separado por `#`
 *     (`Acórdão#Sentença#…`). Ver `JULIA_TIPOS_DOCUMENTO_FILTRO`.
 *
 * Este é o vocabulário **de resposta**. Só `EMENTA` e `ACORDAO` foram vistos de
 * fato; os demais são inferência a partir dos rótulos da interface e da
 * convenção dos dois conhecidos — confirmar antes de comparar contra eles.
 */
export const JULIA_TIPOS_DOCUMENTO_RESPOSTA = [
  'ACORDAO',
  'DECISAO',
  'DESPACHO',
  'SENTENCA',
  'EMENTA',
  'VOTO',
  'RELATORIO',
  'INTEIRO_TEOR_ACORDAO',
  'APELACAO',
  'RECURSO_ESPECIAL',
  'RECURSO_EXTRAORDINARIO'
] as const;
export type JuliaTipoDocumentoResposta =
  (typeof JULIA_TIPOS_DOCUMENTO_RESPOSTA)[number];

/** Valores efetivamente observados no campo `tipoDocumento` da resposta. */
export const JULIA_TIPOS_DOCUMENTO_VERIFICADOS: readonly string[] = [
  'EMENTA',
  'ACORDAO'
] as const;

/**
 * Vocabulário **de filtro** da API autenticada, capturado literalmente do
 * parâmetro `tiposDocumento` (doc §5.3). Grafia exata: título, com acento.
 *
 * O separador é `#`, mas o **sufixo varia por endpoint** — capturado na mesma
 * sessão:
 *
 *   - `sumario:dt`    → `"Sentença#"`  (com `#` final)
 *   - `documentos:dt` → `"Sentença"`   (sem `#` final)
 *
 * Não normalizar os dois para a mesma forma sem testar: um endpoint que parseia
 * por `split('#')` tolera o sufixo, outro pode gerar um item vazio e filtrar por
 * tipo inexistente — resultado vazio sem erro. Montar conforme o destino.
 */
export const JULIA_TIPOS_DOCUMENTO_FILTRO = [
  'Acórdão',
  'Apelação',
  'Decisão',
  'Despacho',
  'Ementa',
  'Inteiro Teor do Acórdão',
  'Recurso Especial',
  'Recurso Extraordinário',
  'Relatório',
  'Sentença',
  'Voto'
] as const;
export type JuliaTipoDocumentoFiltro =
  (typeof JULIA_TIPOS_DOCUMENTO_FILTRO)[number];

/**
 * Tipos que expressam a **decisão do juízo** — o filtro padrão do "Fale com
 * Júlia".
 *
 * Sem este filtro a Júlia devolve tudo que está indexado no processo, incluindo
 * **petição inicial e contestação** (observado em campo em 18/07/2026). Peça de
 * parte não é entendimento do juízo: alimentá-la ao modelo numa pergunta sobre
 * posicionamento faz a tese do advogado ser reportada como posição da vara.
 *
 * Ficam de fora, deliberadamente:
 *   - `Apelação`, `Recurso Especial`, `Recurso Extraordinário` — são recursos
 *     interpostos pelas partes, não a resposta do tribunal a eles.
 *   - `Relatório` — expõe o que foi alegado, não o que se decidiu.
 *   - `Despacho` — de conteúdo ordinatório, sem carga decisória relevante.
 *
 * O vocabulário completo do acervo é maior que o exibido na interface, então
 * filtrar por inclusão (só o que se quer) é mais seguro que por exclusão.
 */
export const JULIA_TIPOS_DECISAO: readonly JuliaTipoDocumentoFiltro[] = [
  'Sentença',
  'Acórdão',
  'Decisão',
  'Ementa',
  'Voto',
  'Inteiro Teor do Acórdão'
] as const;

/**
 * Atos de **juízo singular** — o filtro do escopo da unidade em 1º grau.
 *
 * A Júlia indexa por processo, não por autoria: filtrar pelo órgão julgador
 * traz todos os documentos dos processos daquela vara, **inclusive o acórdão
 * que o tribunal proferiu no recurso**. Observado em campo em 18/07/2026 —
 * ementa, acórdão e voto do julgamento recursal apareceram na lista do primeiro
 * grau.
 *
 * Isso inverte a autoria: acórdão é ato colegiado, e se a sentença foi
 * reformada ele diz o **oposto** do que a vara entendeu. Sem este recorte, a
 * síntese atribuiria à unidade a posição de quem a revisou.
 */
export const JULIA_TIPOS_1O_GRAU: readonly JuliaTipoDocumentoFiltro[] = [
  'Sentença',
  'Decisão'
] as const;

/** Atos colegiados — escopo recursal. */
export const JULIA_TIPOS_COLEGIADO: readonly JuliaTipoDocumentoFiltro[] = [
  'Acórdão',
  'Ementa',
  'Voto',
  'Inteiro Teor do Acórdão'
] as const;

/** Tipos adequados à instância consultada. */
export function tiposPorInstancia(
  instancia: JuliaInstanciaAutenticada
): readonly JuliaTipoDocumentoFiltro[] {
  return instancia === 'G1' || instancia === 'JEF'
    ? JULIA_TIPOS_1O_GRAU
    : JULIA_TIPOS_COLEGIADO;
}

// ── Filtros de busca ─────────────────────────────────────────────

export interface JuliaFiltros {
  instancia: JuliaInstancia;
  /** Termo livre. Aceita os operadores da interface (`e`, `ou`, `nao`, `prox`, `adj`, `$`). */
  pesquisaLivre?: string;
  /** 20 dígitos, sem máscara. */
  numeroProcesso?: string;
  orgaoJulgador?: string;
  relator?: string;
  /** ISO `yyyy-MM-dd` — o cliente converte para `dd/MM/yyyy` na saída. */
  dataIni?: string;
  /** ISO `yyyy-MM-dd`. */
  dataFim?: string;
  /** Offset 0-based. */
  start?: number;
  /** Tamanho da página. */
  length?: number;
}

// ── Resposta bruta da API ────────────────────────────────────────

/** Item exatamente como a API devolve. Uso interno do cliente. */
export interface JuliaDocumentoBruto {
  codigoDocumento: string;
  sistema: string | null;
  instancia: string | null;
  orgao: string | null;
  tipoDocumento: string | null;
  numeroProcesso: string | null;
  classeJudicial: string | null;
  relator: string | null;
  revisor: string | null;
  relatorAcordao: string | null;
  orgaoJulgador: string | null;
  dataAutuacao: string | null;
  dataJulgamento: string | null;
  dataAssinatura: string | null;
  ativo: boolean | null;
  texto: string | null;
  resumo: string | null;
}

export interface JuliaRespostaBruta {
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
  data: JuliaDocumentoBruto[];
}

// ── Forma normalizada (superfície pública) ───────────────────────

export interface JuliaDocumento {
  /** Chave estável: `{orgao}:{instancia}:{sistema}:{id}:{id}:{id}`. Use para deduplicar. */
  codigoDocumento: string;
  sistema: string | null;
  /** Valor do campo da resposta (ex.: `TR`), não o segmento da URL. */
  instancia: string | null;
  /** Valor do campo da resposta (ex.: `JFCE`), não o segmento da URL. */
  orgao: string | null;
  /** `EMENTA` (visto em G2) ou `ACORDAO` (visto em TR). Vocabulário incompleto. */
  tipoDocumento: string | null;
  /** 20 dígitos, como veio da API. */
  numeroProcesso: string | null;
  /** Máscara CNJ, para exibição. `null` se o número não tiver 20 dígitos. */
  numeroProcessoFormatado: string | null;
  classeJudicial: string | null;
  relator: string | null;
  orgaoJulgador: string | null;
  /** ISO `yyyy-MM-dd`. */
  dataJulgamento: string | null;
  dataAssinatura: string | null;
  /** Texto integral, já **sem** as tags `<em>` de realce. Seguro para o LLM. */
  texto: string;
  /**
   * Só a seção EMENTA, quando identificável. Em `ACORDAO` (TR) o `texto`
   * integral passa de 15 mil caracteres — usar este campo para montar prompt.
   */
  ementa: string;
  /** `false` quando o recorte da ementa falhou e `ementa === texto`. */
  ementaFoiRecortada: boolean;
  /** Citação pronta devolvida pela API. */
  resumo: string | null;
  /**
   * HTML **já escapado** com os `<em>` de realce preservados. Único campo
   * desta interface que pode ir para `innerHTML`.
   */
  textoRealcadoHtml: string;

  // ── Campos só da API autenticada ──────────────────────────────

  /** Qual API produziu este documento. */
  origem: 'publica' | 'autenticada';
  /**
   * `true` quando o documento está sob segredo. **Só na API autenticada** — a
   * pública serve acervo público por definição e não expõe a flag.
   *
   * Documento sigiloso nunca vai a provedor de IA externo nem a cache local.
   */
  sigiloso?: boolean;
  publico?: boolean;
  /**
   * `false` quando `texto` é o trecho de busca (~500 chars), não o inteiro
   * teor. A busca autenticada devolve snippet; o texto completo exige
   * `obterInteiroTeor()`.
   */
  textoCompleto: boolean;
  /** Link de volta para o PJe. */
  urlPje?: string | null;
  nomeAssinatura?: string | null;
  /** Relevância atribuída pelo motor de busca (só autenticada). */
  score?: number | null;
}

export interface JuliaResultado {
  documentos: JuliaDocumento[];
  /** `recordsTotal` da API. Ver `totalEhTeto`. */
  total: number;
  /**
   * `true` quando `total` bateu exatamente no teto de 10.000 do backend de
   * busca. Nesse caso `total` é um piso, não uma contagem: a interface deve
   * dizer "mais de 10.000", nunca "10.000 resultados".
   */
  totalEhTeto: boolean;
  start: number;
  length: number;
  /** Quantos itens foram descartados por `codigoDocumento` repetido. */
  duplicatasRemovidas: number;
  /** `false` quando a próxima página cairia além do teto de paginação. */
  temMais: boolean;
}
