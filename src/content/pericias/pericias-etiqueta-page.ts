/**
 * Executa, no page world do PJe, o fetch de vinculação de etiqueta ao
 * processo.
 *
 * Por que page world:
 *   - O endpoint `/painelUsuario/processoTags/inserir` rejeita silenciosamente
 *     (HTTP 200 com corpo vazio) quando o fetch é disparado do isolated
 *     world de uma content script — mesmo a partir do iframe Angular em
 *     `frontend-prd.*.jus.br`. Replicando os headers exatos do Angular
 *     (sem `X-no-sso`, sem `X-pje-authorization`, com `Accept` canônico)
 *     não resolve.
 *   - O Angular da SPA roda no page world e consegue gravar
 *     normalmente. Logo, executar o fetch daqui dá a mesma marca ao
 *     browser (Origin, Referer, credentials, sec-fetch-*) que o PJe
 *     aceita.
 *
 * Protocolo (espelha o de `pje-auth-refresh-page.ts`):
 *   1. Isolated world dispara `CustomEvent('paidegua:vincular-etiqueta-request',
 *      { detail: { id, url, headers, body } })`.
 *   2. Este script executa `fetch(url, { method: 'POST', headers, body,
 *      credentials: 'include' })`, lê status + corpo, responde com
 *      `CustomEvent('paidegua:vincular-etiqueta-result', { detail })`.
 *
 * Idempotente: guard em window global evita instalação dupla se injetado
 * em iframes aninhados.
 */

interface VincularRequestDetail {
  id: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface VincularResultDetail {
  id: string;
  ok: boolean;
  status?: number;
  contentType?: string;
  bodyText?: string;
  /** Headers da resposta em forma serializável. */
  responseHeaders?: Record<string, string>;
  error?: string;
  durationMs?: number;
}

interface VincularInstalledFlagWindow {
  __paideguaVincularEtiquetaInstalled?: boolean;
}

(() => {
  const LOG = '[pAIdegua][vincular-etiqueta-page]';
  const w = window as unknown as VincularInstalledFlagWindow;
  if (w.__paideguaVincularEtiquetaInstalled) return;
  w.__paideguaVincularEtiquetaInstalled = true;

  const TIMEOUT_MS = 30_000;

  function dispatchResult(detail: VincularResultDetail): void {
    try {
      document.dispatchEvent(
        new CustomEvent('paidegua:vincular-etiqueta-result', { detail })
      );
    } catch {
      /* ignore: nunca quebrar a SPA host */
    }
  }

  async function executar(req: VincularRequestDetail): Promise<void> {
    const inicio = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        credentials: 'include',
        signal: controller.signal
      });
      const text = await resp.text().catch(() => '');
      const respHeaders: Record<string, string> = {};
      try {
        resp.headers.forEach((v, k) => {
          respHeaders[k] = v;
        });
      } catch {
        /* ignore */
      }
      dispatchResult({
        id: req.id,
        ok: resp.ok,
        status: resp.status,
        contentType: resp.headers.get('content-type') ?? '',
        bodyText: text,
        responseHeaders: respHeaders,
        durationMs: Date.now() - inicio
      });
    } catch (err) {
      dispatchResult({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - inicio
      });
    } finally {
      clearTimeout(timer);
    }
  }

  document.addEventListener(
    'paidegua:vincular-etiqueta-request',
    (ev) => {
      const detail = (ev as CustomEvent).detail as
        | VincularRequestDetail
        | undefined;
      if (!detail || typeof detail.id !== 'string' || !detail.url) {
        return;
      }
      void executar(detail);
    }
  );

  try {
    console.log(`${LOG} instalado em`, window.location.href);
  } catch {
    /* ignore */
  }
})();
