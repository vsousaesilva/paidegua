/**
 * Bridge isolated-world → page-world do fetch de vinculação de etiqueta.
 *
 * API de uso (do iframe Angular — onde é seguro fazer o fetch):
 *   const r = await fetchVincularEtiquetaNoPageWorld({ url, headers, body });
 *   if (r.ok) { ... }
 *
 * Implementação: dispara `CustomEvent('paidegua:vincular-etiqueta-request')`
 * com `detail: { id, url, headers, body }`, aguarda o
 * `paidegua:vincular-etiqueta-result` de mesmo `id`.
 *
 * Por que page world: em MV3, fetches do content script em isolated world
 * podem sofrer tratamento diferente do browser (metadados de request,
 * atribuição de Origin/Referer) mesmo rodando no mesmo iframe cross-origin
 * do Angular. O endpoint de vinculação do PJe rejeita silenciosamente o
 * isolated-world fetch (200 + corpo vazio). Ver `pericias-etiqueta-page.ts`.
 */

import { LOG_PREFIX } from '../../shared/constants';

const REQ_EVENT = 'paidegua:vincular-etiqueta-request';
const RESP_EVENT = 'paidegua:vincular-etiqueta-result';
const TIMEOUT_MS = 32_000;

export interface PageWorldFetchInput {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface PageWorldFetchResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  bodyText?: string;
  responseHeaders?: Record<string, string>;
  error?: string;
  durationMs?: number;
}

function gerarId(): string {
  const r = Math.random().toString(36).slice(2, 10);
  return `vinc-${Date.now()}-${r}`;
}

export function fetchVincularEtiquetaNoPageWorld(
  input: PageWorldFetchInput
): Promise<PageWorldFetchResult> {
  const id = gerarId();
  return new Promise<PageWorldFetchResult>((resolve) => {
    let settled = false;
    const onResult = (ev: Event): void => {
      const detail = (ev as CustomEvent).detail as
        | {
            id: string;
            ok: boolean;
            status?: number;
            contentType?: string;
            bodyText?: string;
            responseHeaders?: Record<string, string>;
            error?: string;
            durationMs?: number;
          }
        | undefined;
      if (!detail || detail.id !== id || settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener(RESP_EVENT, onResult as EventListener);
      resolve({
        ok: detail.ok,
        status: detail.status,
        contentType: detail.contentType,
        bodyText: detail.bodyText,
        responseHeaders: detail.responseHeaders,
        error: detail.error,
        durationMs: detail.durationMs
      });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      document.removeEventListener(RESP_EVENT, onResult as EventListener);
      resolve({
        ok: false,
        error: 'timeout bridge isolated-world → page-world',
        durationMs: TIMEOUT_MS
      });
    }, TIMEOUT_MS);

    document.addEventListener(RESP_EVENT, onResult as EventListener);

    try {
      document.dispatchEvent(
        new CustomEvent(REQ_EVENT, {
          detail: {
            id,
            url: input.url,
            headers: input.headers,
            body: input.body
          }
        })
      );
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener(RESP_EVENT, onResult as EventListener);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} vincular-etiqueta-bridge dispatch falhou:`, err);
      resolve({ ok: false, error: `dispatch: ${msg}` });
    }
  });
}
