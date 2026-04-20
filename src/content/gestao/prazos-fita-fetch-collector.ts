/**
 * Coletor de expedientes via `fetch` direto — substitui o caminho via
 * iframe oculto.
 *
 * Descoberta que viabiliza este caminho: a URL
 * `listAutosDigitais.seam?idProcesso=X&ca=Y&idTaskInstance=Z&aba=processoExpedienteTab`
 * retorna o HTML ja renderizado no servidor com a aba Expedientes ativa
 * (SSR JSF). Nao precisamos do postback A4J para popular a tabela; o
 * fragmento completo ja vem no HTML inicial.
 *
 * Ganhos vs iframe:
 *  - ~10x mais rapido por processo (300-500ms vs 3-5s): sem render, sem
 *    postback, sem esperar evento `load`.
 *  - Determinismo: elimina a classe inteira de bugs relacionados a iframe
 *    pendurado, eventos `load` tardios e session state de RichFaces.
 *  - Custo de memoria baixo: so strings + um Document transiente, sem
 *    manter iframes vivos no DOM.
 *
 * Pre-condicoes:
 *  - Rodar no content script same-origin com o PJe legacy (para que
 *    cookies JSESSIONID sejam enviados pelo browser).
 *  - URL construida com `aba=processoExpedienteTab` (o coordinator faz).
 */

import type { PrazosProcessoColeta } from '../../shared/types';
import {
  derivarAnomaliasProcesso,
  extractExpedientesFromDoc,
  extractNumeroProcessoFromDoc
} from '../adapters/pje-legacy';

interface Opts {
  url: string;
  /** Timeout duro para o GET completo (handshake + body). Default 30s. */
  timeoutMs?: number;
}

export async function coletarExpedientesViaFetch(
  opts: Opts
): Promise<PrazosProcessoColeta> {
  const inicio = Date.now();
  const url = opts.url;
  if (!url || typeof url !== 'string') {
    return {
      url: String(url ?? ''),
      ok: false,
      numeroProcesso: null,
      error: 'URL ausente ou invalida.',
      duracaoMs: 0
    };
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs
  );
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal: ctrl.signal
    });
    const html = await resp.text();
    if (!resp.ok) {
      return {
        url,
        ok: false,
        numeroProcesso: null,
        error: `HTTP ${resp.status} carregando autos digitais.`,
        duracaoMs: Date.now() - inicio
      };
    }
    if (!html) {
      return {
        url,
        ok: false,
        numeroProcesso: null,
        error: 'Resposta vazia do PJe.',
        duracaoMs: Date.now() - inicio
      };
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const numeroProcesso = extractNumeroProcessoFromDoc(doc);
    const extracao = extractExpedientesFromDoc(doc);
    const anomaliasProcesso = derivarAnomaliasProcesso(extracao);
    return {
      url,
      ok: true,
      numeroProcesso,
      extracao,
      anomaliasProcesso,
      duracaoMs: Date.now() - inicio
    };
  } catch (err) {
    return {
      url,
      ok: false,
      numeroProcesso: null,
      error: err instanceof Error ? err.message : String(err),
      duracaoMs: Date.now() - inicio
    };
  } finally {
    clearTimeout(timer);
  }
}
