/**
 * Interceptor passivo de autenticacao do PJe — roda em PAGE WORLD
 * (mesmo contexto JavaScript do Angular do painel servido em
 * `frontend-prd.<tribunal>.jus.br`).
 *
 * Por que precisa estar no page world: a aplicacao Angular guarda o
 * token JWT do Keycloak em memoria (HttpInterceptor da propria SPA) e
 * injeta nas chamadas REST como `Authorization: Bearer ...` junto com
 * headers customizados (`X-pje-cookies`, `X-pje-legacy-app`,
 * `X-pje-usuario-localizacao`). Do isolated world dos content scripts
 * MV3 nao conseguimos enxergar essas chamadas — `window.fetch` e
 * `XMLHttpRequest` sao copias isoladas. Por isso este script precisa
 * ser injetado diretamente na page world via segundo entry de
 * `content_scripts` com `world: "MAIN"`.
 *
 * Comportamento: PASSIVO. Patcha `fetch` e `XMLHttpRequest`, le os
 * headers, despacha um `CustomEvent('paidegua:pje-auth')` no
 * `document` com o snapshot e segue. Nao bloqueia, nao modifica e
 * nao persiste — quem persiste e o background, atraves do bridge
 * isolated-world (`pje-auth-interceptor.ts`).
 *
 * Idempotente: protegido por flag global em `window` para evitar
 * patch duplo se o script for re-injetado.
 */

interface AuthSnapshotPage {
  capturedAt: number;
  url: string;
  authorization: string;
  pjeCookies: string | null;
  pjeLegacyApp: string | null;
  pjeUsuarioLocalizacao: string | null;
  xNoSso: string | null;
  xPjeAuthorization: string | null;
}

interface InstalledFlagWindow {
  __paideguaPjeAuthInstalled?: boolean;
}

interface XhrInstrumented extends XMLHttpRequest {
  __paideguaUrl?: string;
  __paideguaHeaders?: Record<string, string>;
}

(() => {
  const w = window as unknown as InstalledFlagWindow;
  if (w.__paideguaPjeAuthInstalled) return;
  w.__paideguaPjeAuthInstalled = true;

  // Qualquer endpoint REST sob /pje-legacy/ serve para extrair o Bearer
  // token e headers (painelUsuario, cartaoDoProcesso, processo, etc.).
  // Restringir a /pje-legacy/api/ era a convencao antiga — o PJe atual
  // do TRF5 serve sob /pje-legacy/painelUsuario/... sem o segmento /api/.
  const RELEVANT_URL_RE = /\/pje-legacy\//i;

  function pickHeader(
    headers: Record<string, string>,
    ...names: string[]
  ): string | null {
    for (const n of names) {
      const direto = headers[n];
      if (typeof direto === 'string' && direto) return direto;
      const lower = n.toLowerCase();
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === lower) {
          const v = headers[k];
          if (typeof v === 'string' && v) return v;
        }
      }
    }
    return null;
  }

  function snapshotFromHeaders(
    url: string,
    headers: Record<string, string>
  ): AuthSnapshotPage | null {
    // Aceitamos qualquer esquema no `Authorization` (Bearer do Keycloak
    // quando SSO esta vigente, Basic do legacy Seam quando o SSO expira
    // e o PJe cai no fallback com dummy X:12345). Quem de fato autentica
    // as chamadas same-origin e o cookie JSESSIONID junto com os headers
    // `X-pje-cookies`, `X-pje-legacy-app` e `X-pje-usuario-localizacao`;
    // o `Authorization` e repassado apenas para manter a paridade com
    // o que o painel Angular envia.
    const auth =
      pickHeader(headers, 'Authorization') ??
      pickHeader(headers, 'X-pje-authorization');
    if (!auth) return null;
    return {
      capturedAt: Date.now(),
      url,
      authorization: auth,
      pjeCookies: pickHeader(headers, 'X-pje-cookies'),
      pjeLegacyApp: pickHeader(headers, 'X-pje-legacy-app'),
      pjeUsuarioLocalizacao: pickHeader(headers, 'X-pje-usuario-localizacao'),
      xNoSso: pickHeader(headers, 'X-no-sso'),
      xPjeAuthorization: pickHeader(headers, 'X-pje-authorization')
    };
  }

  function dispatch(snapshot: AuthSnapshotPage): void {
    try {
      document.dispatchEvent(
        new CustomEvent('paidegua:pje-auth', { detail: snapshot })
      );
    } catch {
      /* ignore: nunca quebrar a SPA host */
    }
    // Cache em window apenas com o header de auth corrente — o probe
    // Keycloak (page world) decodifica o JWT pra extrair o issuer.
    // Nao persiste; sumira quando a aba fechar. Nao expomos refresh_token
    // (nao temos acesso) nem identidade do usuario alem do que ja esta no
    // Bearer que a SPA propria envia.
    try {
      (window as unknown as { __paideguaLastAuth?: AuthSnapshotPage }).
        __paideguaLastAuth = snapshot;
    } catch {
      /* ignore */
    }
  }

  // ----- fetch -----
  const origFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (RELEVANT_URL_RE.test(url)) {
        const headers: Record<string, string> = {};
        const initHeaders = init?.headers;
        if (initHeaders instanceof Headers) {
          initHeaders.forEach((v, k) => {
            headers[k] = v;
          });
        } else if (Array.isArray(initHeaders)) {
          for (const [k, v] of initHeaders) headers[k] = v;
        } else if (initHeaders && typeof initHeaders === 'object') {
          Object.assign(headers, initHeaders as Record<string, string>);
        }
        if (input instanceof Request) {
          input.headers.forEach((v, k) => {
            if (!(k in headers)) headers[k] = v;
          });
        }
        const snap = snapshotFromHeaders(url, headers);
        if (snap) dispatch(snap);
      }
    } catch {
      /* ignore */
    }
    return origFetch(input, init);
  } as typeof window.fetch;

  // ----- XMLHttpRequest -----
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSetRequestHeader = proto.setRequestHeader;
  const origSend = proto.send;

  proto.open = function patchedOpen(
    this: XhrInstrumented,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    try {
      this.__paideguaUrl = typeof url === 'string' ? url : url.toString();
      this.__paideguaHeaders = {};
    } catch {
      /* ignore */
    }
    return (origOpen as (...a: unknown[]) => void).apply(this, [
      method,
      url,
      ...rest
    ]);
  } as typeof proto.open;

  proto.setRequestHeader = function patchedSetRequestHeader(
    this: XhrInstrumented,
    name: string,
    value: string
  ): void {
    try {
      if (this.__paideguaHeaders) this.__paideguaHeaders[name] = value;
    } catch {
      /* ignore */
    }
    return origSetRequestHeader.call(this, name, value);
  } as typeof proto.setRequestHeader;

  proto.send = function patchedSend(
    this: XhrInstrumented,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    try {
      const url = this.__paideguaUrl ?? '';
      const headers = this.__paideguaHeaders ?? {};
      if (url && RELEVANT_URL_RE.test(url)) {
        const snap = snapshotFromHeaders(url, headers);
        if (snap) dispatch(snap);
      }
    } catch {
      /* ignore */
    }
    return origSend.call(this, body as XMLHttpRequestBodyInit | null);
  } as typeof proto.send;
})();
