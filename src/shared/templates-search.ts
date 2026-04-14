/**
 * Busca de modelos de minuta — implementação BM25 (Okapi) sobre o texto
 * extraído pela ingestão.
 *
 * ───────────────────────────────────────────────────────────────────────
 *  POR QUE BM25 EM VEZ DE EMBEDDINGS NEURAIS (Transformers.js)
 * ───────────────────────────────────────────────────────────────────────
 *
 * A intenção original (Fase B do plano) era usar Transformers.js com um
 * modelo multilíngue (`Xenova/multilingual-e5-small` ou similar) e busca
 * por cosseno. Após avaliação, BM25 venceu por motivos práticos:
 *
 *  1. TAMANHO: o menor modelo multilíngue de qualidade aceitável tem
 *     ~120MB em ONNX quantizado. Bundling em uma extensão Chrome é
 *     impraticável (limites de tamanho, tempo de carregamento, RAM).
 *
 *  2. INTRANET: o ambiente da JFCE roda em intranet sem internet livre.
 *     Modelos baixados sob demanda do HuggingFace não funcionariam, e
 *     servir o modelo localmente reintroduz o problema (1).
 *
 *  3. CASO DE USO: a busca é disparada por 5 categorias FIXAS (sentença
 *     procedente, improcedente, decidir, converter em diligência,
 *     despachar). Para queries categóricas curtas contra um corpus
 *     pequeno (dezenas a centenas de modelos), BM25 com tokenização
 *     PT-BR + filtragem por subpasta supera embeddings genéricos —
 *     embeddings só vencem quando a query é longa, com sinônimos e
 *     paráfrases sem sobreposição lexical.
 *
 *  4. DETERMINISMO: BM25 é explicável e reprodutível. Para um servidor
 *     da Justiça precisar entender por que um modelo foi escolhido em
 *     vez de outro, "esse termo apareceu N vezes na peça-modelo" é
 *     muito mais defensável que "o vetor cosseno deu 0,87".
 *
 *  5. CUSTO ZERO: nenhuma nova dependência, nenhum WASM, nenhum
 *     download. Roda no service worker, no content script ou na página
 *     de opções sem distinção.
 *
 * Se no futuro quisermos embeddings (para queries livres em chat, por
 * exemplo), o índice BM25 continua útil como filtro de primeira camada
 * antes do re-ranking neural. Esta implementação NÃO precisa ser
 * descartada.
 *
 * ───────────────────────────────────────────────────────────────────────
 *  DETALHES DA IMPLEMENTAÇÃO
 * ───────────────────────────────────────────────────────────────────────
 *
 * - Tokenização: lowercase + NFKD strip de diacríticos + split por
 *   não-alfanuméricos. Tokens com < 2 caracteres descartados.
 * - Stopwords PT-BR: lista fechada e curta — apenas as mais frequentes
 *   que poluiriam o ranking ("de", "da", "do", "que", etc.). Termos
 *   jurídicos NÃO são filtrados.
 * - Pesos: k1 = 1.5 (saturação de term frequency), b = 0.75 (normalização
 *   de comprimento) — valores padrão consagrados na literatura.
 * - Cache: o índice é construído sob demanda no service worker, com
 *   uma chave que invalida automaticamente quando templates são
 *   reindexados (versão monotônica salva em IDB).
 */

import { LOG_PREFIX } from './constants';
import { listTemplates, type TemplateRecord } from './templates-store';

// ─────────────────────────── tokenização ───────────────────────────

const STOPWORDS_PT_BR = new Set<string>([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas',
  'de', 'da', 'do', 'das', 'dos', 'dum', 'duma',
  'no', 'na', 'nos', 'nas', 'num', 'numa',
  'em', 'por', 'para', 'pelo', 'pela', 'pelos', 'pelas',
  'com', 'sem', 'sob', 'sobre', 'entre', 'ate', 'apos', 'desde',
  'e', 'ou', 'mas', 'que', 'se', 'porque', 'pois', 'como', 'quando',
  'onde', 'qual', 'quais', 'cujo', 'cuja', 'cujos', 'cujas',
  'eu', 'tu', 'ele', 'ela', 'nos', 'vos', 'eles', 'elas',
  'meu', 'minha', 'teu', 'tua', 'seu', 'sua',
  'este', 'esta', 'esse', 'essa', 'aquele', 'aquela',
  'isto', 'isso', 'aquilo',
  'ja', 'so', 'tambem', 'nao', 'sim', 'mais', 'menos', 'muito', 'pouco',
  'ser', 'estar', 'ter', 'haver', 'foi', 'sao', 'era', 'sera',
  'art', 'arts', 'artigo', 'inciso', 'incisos', 'paragrafo'
]);

/** Normaliza string: lowercase + remove diacríticos via NFKD. */
function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Tokeniza um texto, devolvendo array de termos filtrados. */
export function tokenize(text: string): string[] {
  const norm = normalize(text);
  const raw = norm.split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const tok of raw) {
    if (tok.length < 2) continue;
    if (STOPWORDS_PT_BR.has(tok)) continue;
    if (/^\d+$/.test(tok) && tok.length < 4) continue; // descarta números curtos
    out.push(tok);
  }
  return out;
}

// ─────────────────────────── índice BM25 ───────────────────────────

interface IndexedDoc {
  /** id numérico do registro de template no IDB. */
  id: number;
  relativePath: string;
  /** Map<term, count> para o documento. */
  termFreqs: Map<string, number>;
  /** Tamanho do documento em tokens (após filtro). */
  length: number;
}

interface Bm25Index {
  /** Documentos indexados, na ordem de inserção. */
  docs: IndexedDoc[];
  /** Map<term, número de documentos que contêm o termo>. */
  docFreqs: Map<string, number>;
  /** Comprimento médio dos documentos. */
  avgLen: number;
  /** Total de documentos. */
  N: number;
}

const K1 = 1.5;
const B = 0.75;

function buildIndex(records: TemplateRecord[]): Bm25Index {
  const docs: IndexedDoc[] = [];
  const docFreqs = new Map<string, number>();
  let totalLen = 0;

  for (const rec of records) {
    if (rec.id === undefined) continue;
    const tokens = tokenize(rec.text);
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    docs.push({
      id: rec.id,
      relativePath: rec.relativePath,
      termFreqs: tf,
      length: tokens.length
    });
    totalLen += tokens.length;
    for (const term of tf.keys()) {
      docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
    }
  }

  return {
    docs,
    docFreqs,
    N: docs.length,
    avgLen: docs.length > 0 ? totalLen / docs.length : 0
  };
}

function idf(index: Bm25Index, term: string): number {
  const df = index.docFreqs.get(term) ?? 0;
  // IDF do BM25 com smoothing — sempre positivo, evita termos muito comuns
  // dominarem o ranking.
  return Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
}

function scoreDoc(index: Bm25Index, doc: IndexedDoc, queryTerms: string[]): number {
  let score = 0;
  for (const term of queryTerms) {
    const tf = doc.termFreqs.get(term) ?? 0;
    if (tf === 0) continue;
    const idfVal = idf(index, term);
    const norm = 1 - B + B * (doc.length / (index.avgLen || 1));
    const tfComp = (tf * (K1 + 1)) / (tf + K1 * norm);
    score += idfVal * tfComp;
  }
  return score;
}

// ─────────────────────────── cache ───────────────────────────

interface CachedIndex {
  /** Versão monotônica — invalida o cache quando templates mudam. */
  version: number;
  index: Bm25Index;
  /** Templates originais (texto completo) para devolver ao chamador. */
  records: TemplateRecord[];
}

let cached: CachedIndex | null = null;
let currentVersion = 0;

/**
 * Marca o índice como invalidado. Chamado pela página de opções após
 * uma reindexação. O próximo `searchTemplates` reconstrói o índice.
 */
export function invalidateSearchIndex(): void {
  currentVersion++;
  cached = null;
}

async function getIndex(): Promise<CachedIndex> {
  if (cached && cached.version === currentVersion) {
    return cached;
  }
  const records = await listTemplates();
  const index = buildIndex(records);
  cached = { version: currentVersion, index, records };
  console.log(
    `${LOG_PREFIX} BM25 index reconstruído: ${index.N} documentos, ` +
      `${index.docFreqs.size} termos únicos, comprimento médio ${Math.round(index.avgLen)} tokens.`
  );
  return cached;
}

// ─────────────────────────── API pública ───────────────────────────

export interface SearchOptions {
  /** Quantidade máxima de resultados a devolver. Padrão: 5. */
  topK?: number;
  /**
   * Filtra documentos cujo `relativePath` começa com algum dos prefixos
   * informados (case-insensitive, depois de normalize). Útil para
   * priorizar uma subpasta como "procedente/" ou "despachos/".
   *
   * Se for fornecido e algum documento bater, APENAS esses são
   * considerados. Se for fornecido mas NENHUM bater, faz fallback para
   * o corpus inteiro (não deixa o usuário sem resposta por causa de uma
   * subpasta inexistente).
   */
  folderHints?: string[];
  /** Pontuação mínima abaixo da qual os resultados são descartados. Padrão: 0.1. */
  minScore?: number;
  /**
   * Termos que, se presentes no caminho ou texto do template, EXCLUEM o
   * template dos resultados. Serve para evitar que modelos de sentença
   * sejam usados como referência para despachos, e vice-versa.
   */
  excludeTerms?: string[];
}

export interface SearchResult {
  template: TemplateRecord;
  score: number;
  /**
   * Similaridade relativa em 0..100 (percentual). O candidato com maior
   * score recebe 100% e os demais são proporcionais a ele. Mais intuitivo
   * para o usuário do que o máximo teórico do BM25.
   */
  similarity: number;
  /** Indica se o template veio do filtro de subpasta (true) ou do corpus geral (false). */
  matchedFolderHint: boolean;
}

/**
 * Busca templates ordenados por relevância à query usando BM25.
 * Retorna no máximo `topK` resultados com pontuação acima de `minScore`.
 */
export async function searchTemplates(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0.1;
  const folderHints = opts.folderHints ?? [];
  const excludeTerms = (opts.excludeTerms ?? []).map((t) => normalize(t));

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return [];
  }

  const { index, records } = await getIndex();
  if (index.N === 0) {
    return [];
  }

  // Pré-computa texto normalizado dos templates para exclusão.
  // Indexa por doc.id para lookup O(1).
  const recordTextById = new Map<number, string>();
  if (excludeTerms.length > 0) {
    for (const r of records) {
      if (r.id !== undefined) {
        // Combina caminho + primeiros 500 chars do texto para detecção
        const combined = normalize(r.relativePath + ' ' + r.text.slice(0, 500));
        recordTextById.set(r.id, combined);
      }
    }
  }

  // folderHints como boost (não filtro exclusivo): pontua TODO o corpus e
  // aplica multiplicador nos docs cujo caminho bate no hint. Isso garante que
  // templates de matéria diferente (ex: BPC vs. Aposentadoria) não sejam
  // excluídos apenas porque algum template errado casou no hint "procedência".
  const FOLDER_HINT_BOOST = 1.3;
  const normalizedHints = folderHints.map((h) => normalize(h));

  const scored = index.docs
    .filter((doc) => {
      // Filtro negativo: exclui templates que contenham termos incompatíveis
      if (excludeTerms.length === 0) return true;
      const combined = recordTextById.get(doc.id) ?? normalize(doc.relativePath);
      return !excludeTerms.some((term) => combined.includes(term));
    })
    .map((doc) => {
      const baseScore = scoreDoc(index, doc, queryTerms);
      const hintMatch =
        normalizedHints.length > 0 &&
        normalizedHints.some((h) => normalize(doc.relativePath).includes(h));
      const boostedScore = hintMatch ? baseScore * FOLDER_HINT_BOOST : baseScore;
      return { doc, baseScore, boostedScore, hintMatch };
    })
    .filter((s) => s.baseScore >= minScore)
    .sort((a, b) => b.boostedScore - a.boostedScore)
    .slice(0, topK);

  // Similaridade relativa: normaliza pelo score do melhor candidato.
  // O 1º colocado fica com 100% e os demais proporcionalmente. Isso é
  // mais intuitivo do que o máximo teórico do BM25 (que resultava em
  // percentuais comprimidos na faixa 0.5-5% mesmo para bons matches).
  const topScore = scored.length > 0 ? scored[0]!.boostedScore : 0;

  // Mapeia de volta para os TemplateRecord originais.
  const recordsById = new Map<number, TemplateRecord>();
  for (const r of records) {
    if (r.id !== undefined) recordsById.set(r.id, r);
  }

  const results: SearchResult[] = [];
  for (const s of scored) {
    const rec = recordsById.get(s.doc.id);
    if (rec) {
      const similarity =
        topScore > 0
          ? Math.max(0, Math.min(100, (s.boostedScore / topScore) * 100))
          : 0;
      results.push({ template: rec, score: s.boostedScore, similarity, matchedFolderHint: s.hintMatch });
    }
  }
  return results;
}

/**
 * Conveniência: indica se há ao menos um template indexado.
 * Usado pela UI para decidir se mostra a opção "Usar modelo similar".
 */
export async function hasAnyTemplate(): Promise<boolean> {
  const { index } = await getIndex();
  return index.N > 0;
}