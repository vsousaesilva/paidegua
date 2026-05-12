/**
 * Wrappers de mensagem para o sistema de modelos (templates) do paidegua.
 *
 * Originalmente esses wrappers viviam em `src/content/content.ts` (eram
 * funções privadas usadas só pela sidebar). Foram extraídos para este
 * módulo compartilhado quando a feature "Sentença com modelo" da aba
 * `audiencia-resumo/resumo.html` (AUD-10) precisou da mesma busca BM25
 * + rerank, mas a aba não pode importar do content script.
 *
 * As funções aqui são puramente RPC — todo o trabalho é feito pelo
 * background. Nenhuma depende de `mounted`, `memory`, `chrome.tabs`
 * ou `window.location` — podem rodar tanto em content script quanto em
 * página da extensão.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from './constants';

/**
 * Hit retornado por `templatesSearch` (BM25). Originalmente declarado
 * em `content.ts` como interface privada — movido para cá quando
 * extraímos os wrappers para reuso pela aba `audiencia-resumo`.
 *
 * O texto completo do template vem embutido — o caso de uso (poucos
 * top-K com escolha imediata) torna inviável fazer round-trip extra
 * para buscar o texto após o usuário escolher.
 */
export interface TemplateSearchHit {
  id: number;
  relativePath: string;
  name: string;
  ext: string;
  charCount: number;
  score: number;
  /** Similaridade normalizada em 0..100. */
  similarity: number;
  matchedFolderHint: boolean;
  text: string;
}

/** Verifica se o usuário cadastrou pasta de modelos no popup. */
export async function templatesHasConfig(): Promise<boolean> {
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TEMPLATES_HAS_CONFIG,
      payload: null
    })) as { ok: boolean; hasTemplates: boolean };
    return Boolean(response?.hasTemplates);
  } catch {
    return false;
  }
}

/**
 * Busca BM25 nos modelos cadastrados pelo usuário. `folderHints`
 * direciona o ranking para pastas com nomes que contenham aqueles
 * trechos (ex.: 'sentenca-procedente'). `excludeTerms` desclassifica
 * candidatos com palavras incompatíveis (ex.: filtrar despachos quando
 * a ação é sentença).
 */
export async function templatesSearch(
  query: string,
  folderHints: string[],
  excludeTerms?: string[]
): Promise<TemplateSearchHit[]> {
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TEMPLATES_SEARCH,
      payload: { query, opts: { folderHints, topK: 8, excludeTerms } }
    })) as { ok: boolean; results?: TemplateSearchHit[]; error?: string };
    return response?.results ?? [];
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} [templates-client] templatesSearch falhou:`, error);
    return [];
  }
}

/**
 * Pede ao background para reordenar os candidatos do BM25 usando o LLM
 * ativo (RAG híbrido). Devolve `null` em caso de falha — o chamador
 * deve cair de volta para a ordem original do BM25 sem barulho.
 */
export async function templatesRerank(
  actionLabel: string,
  caseContext: string,
  hits: TemplateSearchHit[]
): Promise<{ ordered: TemplateSearchHit[]; justificativa: string } | null> {
  if (hits.length < 2 || !caseContext) return null;
  try {
    const candidates = hits.map((h, i) => ({
      index: i,
      relativePath: h.relativePath,
      // Excerto do começo do template — onde costumam aparecer relatório,
      // partes e enquadramento da matéria. Suficiente para o LLM decidir.
      excerpt: (h.text ?? '').slice(0, 1500)
    }));
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TEMPLATES_RERANK,
      payload: { actionLabel, caseContext, candidates }
    })) as {
      ok: boolean;
      ranking?: number[];
      justificativa?: string;
      error?: string;
    };
    if (!response?.ok || !response.ranking || response.ranking.length === 0) {
      if (response?.error) {
        console.warn(
          `${LOG_PREFIX} [templates-client] rerank LLM falhou: ${response.error}`
        );
      }
      return null;
    }
    const ordered: TemplateSearchHit[] = [];
    const seen = new Set<number>();
    for (const idx of response.ranking) {
      if (idx >= 0 && idx < hits.length && !seen.has(idx)) {
        seen.add(idx);
        ordered.push(hits[idx]!);
      }
    }
    // Defensivo: completa eventuais faltantes na ordem original.
    for (let i = 0; i < hits.length; i++) {
      if (!seen.has(i)) ordered.push(hits[i]!);
    }
    return { ordered, justificativa: response.justificativa ?? '' };
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} [templates-client] templatesRerank falhou:`, error);
    return null;
  }
}
