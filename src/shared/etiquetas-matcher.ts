/**
 * De-para semântico entre MARCADORES gerados pela IA e ETIQUETAS do PJe.
 *
 * ───────────────────────────────────────────────────────────────────────
 *  CONTEXTO
 * ───────────────────────────────────────────────────────────────────────
 *
 * Na Triagem Inteligente, uma LLM analisa o processo e produz uma lista
 * curta de MARCADORES semânticos (p.ex. "aposentadoria por idade rural",
 * "indefere tutela de urgência", "revisão do FAP"). Este módulo casa esses
 * marcadores contra o subconjunto de etiquetas do PJe que o usuário
 * marcou como "sugestionáveis" na aba de Etiquetas Inteligentes, e
 * devolve as etiquetas mais prováveis em ordem de relevância.
 *
 * ───────────────────────────────────────────────────────────────────────
 *  POR QUE BM25 (E NÃO EMBEDDINGS) — IDEM AO `templates-search.ts`
 * ───────────────────────────────────────────────────────────────────────
 *
 * - Documentos CURTOS: cada etiqueta tem ~3-10 tokens úteis (nome + path
 *   hierárquico + descrição opcional). Embeddings brilham em textos
 *   longos; em textos curtos, BM25 + boa tokenização vence.
 * - Queries CURTAS: marcadores também são curtos (2-6 tokens). Queries
 *   curtas contra documentos curtos exigem match lexical ou de radical —
 *   justamente o forte do BM25.
 * - INTRANET / ZERO DEPENDÊNCIA: mesmo argumento do matcher de modelos.
 * - EXPLICABILIDADE: registramos em `matchedMarkers` quais marcadores
 *   contribuíram para a etiqueta ficar no topo — essencial para que o
 *   servidor revise a sugestão antes de aplicar.
 *
 * ───────────────────────────────────────────────────────────────────────
 *  DETALHES
 * ───────────────────────────────────────────────────────────────────────
 *
 * - Reaproveitamos `tokenize` de `templates-search.ts` (lowercase + NFKD
 *   + stopwords PT-BR). Manter a tokenização idêntica evita surpresas
 *   (stopwords divergentes entre módulos).
 * - Texto indexado da etiqueta: `nomeTag + nomeTagCompleto + descricao?`.
 *   O `nomeTagCompleto` carrega o caminho hierárquico (ex.: "Previdenciário
 *   > Aposentadoria > Rural"), o que dá contexto e melhora o match.
 * - Parâmetros BM25: k1 = 1.2 (um pouco menor que o padrão 1.5 porque as
 *   etiquetas são mais curtas — saturamos tf mais cedo) e b = 0.75.
 * - Agregação: cada marcador é uma query BM25 independente; a pontuação
 *   final da etiqueta é a SOMA das pontuações por marcador. Isso favorece
 *   etiquetas que casam com múltiplos marcadores.
 * - Similaridade: normalizada 0..100 relativa ao top — mesma UX do
 *   matcher de modelos.
 * - Cache: índice reconstruído sob demanda; invalidado quando o popup
 *   envia `ETIQUETAS_INVALIDATE` (catálogo refeito ou seleção alterada).
 */

import { LOG_PREFIX } from './constants';
import { listEtiquetas, listSugestionaveis, type EtiquetaRecord } from './etiquetas-store';
import { tokenize } from './templates-search';

// ─────────────────────────── índice ───────────────────────────

interface EtiquetaDoc {
  /** Chave primária (idTag do PJe). */
  id: number;
  /** Registro original para devolver ao chamador. */
  etiqueta: EtiquetaRecord;
  /** Map<term, count>. */
  termFreqs: Map<string, number>;
  /** Tamanho em tokens após filtragem. */
  length: number;
}

export interface EtiquetasBm25Index {
  docs: EtiquetaDoc[];
  /** Map<term, nº de documentos que contêm o termo>. */
  docFreqs: Map<string, number>;
  /** Total de documentos. */
  N: number;
  /** Comprimento médio (em tokens) dos documentos indexados. */
  avgLen: number;
}

const K1 = 1.2;
const B = 0.75;

/** Texto "searchable" de uma etiqueta (nome + caminho + descrição). */
function etiquetaToSearchText(e: EtiquetaRecord): string {
  const parts: string[] = [e.nomeTag];
  if (e.nomeTagCompleto && e.nomeTagCompleto !== e.nomeTag) {
    parts.push(e.nomeTagCompleto);
  }
  if (e.descricao) parts.push(e.descricao);
  return parts.join(' ');
}

/** Constrói o índice BM25 para um conjunto arbitrário de etiquetas. */
export function buildEtiquetasIndex(etiquetas: EtiquetaRecord[]): EtiquetasBm25Index {
  const docs: EtiquetaDoc[] = [];
  const docFreqs = new Map<string, number>();
  let totalLen = 0;

  for (const e of etiquetas) {
    const tokens = tokenize(etiquetaToSearchText(e));
    if (tokens.length === 0) continue;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    docs.push({ id: e.id, etiqueta: e, termFreqs: tf, length: tokens.length });
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

function idf(index: EtiquetasBm25Index, term: string): number {
  const df = index.docFreqs.get(term) ?? 0;
  return Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
}

function scoreDoc(
  index: EtiquetasBm25Index,
  doc: EtiquetaDoc,
  queryTerms: string[]
): number {
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

// ─────────────────────────── API pública ───────────────────────────

export interface MatcherOptions {
  /** Quantidade máxima de etiquetas a devolver. Padrão: 8. */
  topK?: number;
  /** Score mínimo para a etiqueta aparecer. Padrão: 0.1. */
  minScore?: number;
  /**
   * Se true, eleva ligeiramente etiquetas favoritas do PJe (presunção de
   * uso frequente pelo servidor). Fator 1.15. Padrão: true.
   */
  boostFavoritas?: boolean;
}

export interface EtiquetaMatch {
  etiqueta: EtiquetaRecord;
  /** Score BM25 bruto (somado entre marcadores, com boost aplicado). */
  score: number;
  /** Similaridade normalizada 0..100 relativa ao 1º colocado. */
  similarity: number;
  /** Marcadores que contribuíram com pontuação > 0 para esta etiqueta. */
  matchedMarkers: string[];
}

/**
 * Rankeia etiquetas pelo match BM25 contra um conjunto de marcadores.
 *
 * Cada marcador vira uma query BM25 independente; a pontuação da
 * etiqueta é a soma das queries em que ela casou. Etiquetas que
 * casam com múltiplos marcadores tendem a subir no ranking.
 */
export function rankEtiquetas(
  marcadores: string[],
  etiquetas: EtiquetaRecord[] | EtiquetasBm25Index,
  opts: MatcherOptions = {}
): EtiquetaMatch[] {
  const topK = opts.topK ?? 8;
  const minScore = opts.minScore ?? 0.1;
  const boostFavoritas = opts.boostFavoritas ?? true;
  const FAV_BOOST = 1.15;

  if (!marcadores || marcadores.length === 0) return [];

  const index: EtiquetasBm25Index = Array.isArray(etiquetas)
    ? buildEtiquetasIndex(etiquetas)
    : etiquetas;
  if (index.N === 0) return [];

  // Tokeniza cada marcador individualmente — descarta marcadores vazios
  // (p.ex. stopwords puras) após tokenização.
  const queries = marcadores
    .map((m) => ({ marker: m, tokens: tokenize(m) }))
    .filter((q) => q.tokens.length > 0);
  if (queries.length === 0) return [];

  // Acumula score + set de marcadores contribuintes por docId.
  const byId = new Map<number, { total: number; matched: Set<string> }>();

  for (const { marker, tokens } of queries) {
    for (const doc of index.docs) {
      const s = scoreDoc(index, doc, tokens);
      if (s <= 0) continue;
      const entry = byId.get(doc.id);
      if (entry) {
        entry.total += s;
        entry.matched.add(marker);
      } else {
        byId.set(doc.id, { total: s, matched: new Set([marker]) });
      }
    }
  }

  const scored: Array<{ doc: EtiquetaDoc; score: number; matched: Set<string> }> = [];
  for (const doc of index.docs) {
    const entry = byId.get(doc.id);
    if (!entry) continue;
    let finalScore = entry.total;
    if (boostFavoritas && doc.etiqueta.favorita) {
      finalScore *= FAV_BOOST;
    }
    if (finalScore < minScore) continue;
    scored.push({ doc, score: finalScore, matched: entry.matched });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);
  const topScore = top[0]?.score ?? 0;

  return top.map((s) => ({
    etiqueta: s.doc.etiqueta,
    score: s.score,
    similarity: topScore > 0 ? Math.round((s.score / topScore) * 100) : 0,
    matchedMarkers: Array.from(s.matched)
  }));
}

// ─────────────────────────── cache do índice dos sugestionáveis ───

interface CachedSugIndex {
  version: number;
  index: EtiquetasBm25Index;
}

let sugCached: CachedSugIndex | null = null;
let currentSugVersion = 0;

/**
 * Invalida o índice em memória dos sugestionáveis. O popup dispara o
 * `MESSAGE_CHANNELS.ETIQUETAS_INVALIDATE` quando o catálogo é refeito
 * ou a seleção muda; o ouvinte (background/content) deve chamar esta
 * função para reconstruir no próximo uso.
 */
export function invalidateSugestionaveisIndex(): void {
  currentSugVersion++;
  sugCached = null;
}

/**
 * Devolve o índice BM25 construído sobre a seleção de etiquetas
 * "sugestionáveis" do usuário. Reconstrói se invalidado. Devolve índice
 * vazio se o usuário ainda não selecionou etiquetas.
 */
export async function getSugestionaveisIndex(): Promise<EtiquetasBm25Index> {
  if (sugCached && sugCached.version === currentSugVersion) {
    return sugCached.index;
  }
  const [sugestionaveis, todas] = await Promise.all([
    listSugestionaveis(),
    listEtiquetas()
  ]);
  const setIds = new Set(sugestionaveis.map((s) => s.idTag));
  const subset = todas.filter((e) => setIds.has(e.id));
  const index = buildEtiquetasIndex(subset);
  sugCached = { version: currentSugVersion, index };
  console.log(
    `${LOG_PREFIX} BM25 etiquetas (sugestionáveis) reconstruído: ${index.N} docs, ` +
      `${index.docFreqs.size} termos únicos, comprimento médio ${Math.round(index.avgLen)} tokens.`
  );
  return index;
}

/**
 * Conveniência: rankeia marcadores contra o índice dos sugestionáveis.
 * Chamada pela pipeline de Triagem Inteligente após o LLM devolver os
 * marcadores.
 */
export async function rankEtiquetasSugestionaveis(
  marcadores: string[],
  opts: MatcherOptions = {}
): Promise<EtiquetaMatch[]> {
  const index = await getSugestionaveisIndex();
  return rankEtiquetas(marcadores, index, opts);
}
