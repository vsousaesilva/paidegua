/**
 * Refresh silencioso de token do Keycloak via OIDC Authorization Code
 * Flow com `prompt=none` (runs in PAGE WORLD do Angular do PJe).
 *
 * Por que page world do `frontend-prd.<tribunal>.jus.br`:
 *   - O `redirect_uri` registrado no client Keycloak (`pje-frontend`) e
 *     `https://frontend-prd.<tribunal>.jus.br/silent-check-sso.html`. O
 *     iframe do auth so pode ser lido depois do redirect se o parent
 *     estiver no mesmo origin (mesmo CORS). Rodando no page world do
 *     iframe Angular, somos exatamente esse origin.
 *   - O POST de token exchange exige `Origin: https://frontend-prd...`
 *     (lista de `allowed-origins` do client). Um `fetch` do service worker
 *     do extension nao passa no CORS — precisa sair do proprio origin.
 *   - O cookie `KEYCLOAK_IDENTITY` vive em `sso.cloud.pje.jus.br` (third-
 *     party do ponto de vista da SPA, mas o browser envia porque esse
 *     fluxo e o padrao OIDC — se bloqueasse, o login original tambem
 *     quebraria).
 *
 * Protocolo de ativacao:
 *   1. Isolated world (content script) dispara
 *      `CustomEvent('paidegua:pje-refresh-request', { detail: { id, issuer,
 *      clientId, redirectUri } })` no `document`.
 *   2. Este script executa o fluxo e responde com
 *      `CustomEvent('paidegua:pje-refresh-result', { detail: { id, ...result } })`.
 *   3. Isolated world relaya pro background / grava snapshot atualizado.
 *
 * Seguranca:
 *   - Nunca loga o access_token no console.
 *   - O iframe e sempre `display:none` e removido apos onload.
 *   - Timeout duro de 10s cobre o fluxo inteiro — evita leaks de iframe
 *     se a rede ficar pendurada.
 *
 * Idempotente: guard em window global evita instalacao dupla se injetado
 * em iframes aninhados.
 */

interface RefreshRequestDetail {
  id: string;
  issuer: string; // ex.: https://sso.cloud.pje.jus.br/auth/realms/pje
  clientId: string; // ex.: pje-frontend
  redirectUri: string; // ex.: https://frontend-prd.trf5.jus.br/silent-check-sso.html
}

interface RefreshResultDetail {
  id: string;
  ok: boolean;
  authorization?: string;
  accessToken?: string;
  expiresIn?: number;
  jwtExp?: number;
  error?: string;
  durationMs?: number;
}

interface RefreshInstalledFlagWindow {
  __paideguaRefreshInstalled?: boolean;
}

(() => {
  const LOG = '[pAIdegua][silent-refresh]';
  const w = window as unknown as RefreshInstalledFlagWindow;
  if (w.__paideguaRefreshInstalled) return;
  w.__paideguaRefreshInstalled = true;

  // 25s de guard global. Divididos entre iframe (15s) e POST do token (8s)
  // + ~2s de margem. Budget maior que o original de 10s porque, em abas
  // PJe em background (situacao real em varreduras longas), o Chrome da
  // prioridade baixa ao iframe cross-origin para sso.cloud.pje.jus.br —
  // o fluxo OIDC completo pode passar dos 6s facilmente. Ver diag de
  // 20/04/2026: "timeout silent SSO" repetido com aba em outra guia.
  const REFRESH_TIMEOUT_MS = 25_000;

  function respondErro(id: string, error: string, durationMs: number): void {
    dispatchResult({ id, ok: false, error, durationMs });
  }

  function dispatchResult(detail: RefreshResultDetail): void {
    try {
      document.dispatchEvent(
        new CustomEvent('paidegua:pje-refresh-result', { detail })
      );
    } catch {
      /* ignore: nunca quebrar a SPA host */
    }
  }

  function randomNonce(): string {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function decodeJwtExp(accessToken: string): number | null {
    try {
      const parts = accessToken.split('.');
      if (parts.length < 2) return null;
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '==='.slice(0, (4 - (b64.length % 4)) % 4);
      const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
      return typeof payload.exp === 'number' ? payload.exp : null;
    } catch {
      return null;
    }
  }

  /**
   * Passo 1: silent auth via iframe. Retorna `code` quando o Keycloak
   * redireciona para `redirectUri` com `?code=...`. Rejeita em erro ou
   * timeout. Remove o iframe sempre.
   */
  function obterCodeViaIframe(
    issuer: string,
    clientId: string,
    redirectUri: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const state = 'p-' + randomNonce();
      const nonce = 'n-' + randomNonce();
      const authUrl =
        `${issuer}/protocol/openid-connect/auth` +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&response_type=code` +
        `&scope=openid` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${state}` +
        `&nonce=${nonce}` +
        `&prompt=none`;

      const ifr = document.createElement('iframe');
      ifr.style.display = 'none';
      ifr.setAttribute('aria-hidden', 'true');
      ifr.setAttribute('title', 'paidegua-silent-refresh');

      let settled = false;
      const cleanup = (): void => {
        try {
          ifr.remove();
        } catch {
          /* ignore */
        }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('timeout silent SSO'));
      }, timeoutMs);

      ifr.onload = () => {
        if (settled) return;
        try {
          const href = ifr.contentWindow?.location.href ?? '';
          const u = new URL(href);
          const code = u.searchParams.get('code');
          const errParam = u.searchParams.get('error');
          const returnedState = u.searchParams.get('state');
          if (errParam) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(new Error(`keycloak ${errParam}`));
            return;
          }
          if (returnedState && returnedState !== state) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(new Error('state mismatch'));
            return;
          }
          if (code) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve(code);
          }
          // onload pode disparar para a URL inicial (pre-redirect) em alguns
          // navegadores — nao e erro; o proximo onload tras o redirect final.
        } catch (err) {
          // Cross-origin enquanto o iframe ainda esta em sso.cloud.pje.jus.br:
          // nao e erro, vira o proximo onload quando voltar pro redirect_uri.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/cross-origin|SecurityError/i.test(msg)) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(new Error(`iframe read: ${msg}`));
          }
        }
      };
      ifr.src = authUrl;
      document.body.appendChild(ifr);
    });
  }

  async function trocarCodePorToken(
    issuer: string,
    clientId: string,
    redirectUri: string,
    code: string,
    timeoutMs: number
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri
    });
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new DOMException('Timeout', 'TimeoutError')),
      timeoutMs
    );
    try {
      const resp = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ctrl.signal,
        credentials: 'omit'
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`token HTTP ${resp.status}: ${text.slice(0, 120)}`);
      }
      const json = (await resp.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      const accessToken =
        typeof json.access_token === 'string' ? json.access_token : '';
      if (!accessToken) {
        throw new Error('token response sem access_token');
      }
      const expiresIn =
        typeof json.expires_in === 'number' ? json.expires_in : 0;
      return { accessToken, expiresIn };
    } finally {
      clearTimeout(timer);
    }
  }

  async function executar(req: RefreshRequestDetail): Promise<void> {
    const t0 = performance.now();
    // Orcamento total: 25s. Divididos: 15s pro iframe auth, 8s pro POST
    // do token, ~2s de margem para o guard externo. Aumentado do original
    // 6+4 porque em aba em background o iframe cross-origin demora mais
    // (Chrome prioriza recursos da aba ativa). Ver ADR no topo do arquivo.
    const IFRAME_BUDGET = 15_000;
    const TOKEN_BUDGET = 8_000;
    try {
      const code = await obterCodeViaIframe(
        req.issuer,
        req.clientId,
        req.redirectUri,
        IFRAME_BUDGET
      );
      const { accessToken, expiresIn } = await trocarCodePorToken(
        req.issuer,
        req.clientId,
        req.redirectUri,
        code,
        TOKEN_BUDGET
      );
      const durationMs = Math.round(performance.now() - t0);
      const jwtExp = decodeJwtExp(accessToken);
      dispatchResult({
        id: req.id,
        ok: true,
        authorization: `Bearer ${accessToken}`,
        accessToken,
        expiresIn,
        jwtExp: jwtExp ?? undefined,
        durationMs
      });
      console.log(
        `${LOG} ok em ${durationMs}ms (exp em ${expiresIn}s)`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respondErro(req.id, msg, Math.round(performance.now() - t0));
      console.warn(`${LOG} falha:`, msg);
    }
  }

  document.addEventListener('paidegua:pje-refresh-request', (ev) => {
    const detail = (ev as CustomEvent).detail as
      | RefreshRequestDetail
      | undefined;
    if (
      !detail ||
      typeof detail.id !== 'string' ||
      typeof detail.issuer !== 'string' ||
      typeof detail.clientId !== 'string' ||
      typeof detail.redirectUri !== 'string'
    ) {
      return;
    }
    // Garantia extra: nao deixar requisicoes penduradas se a SPA demorar a
    // responder eventos. O executar ja tem timeout interno, mas o wrapper
    // externo garante que o result SEMPRE sai dentro da janela.
    let respondeuViaExecute = false;
    const guardTimer = setTimeout(() => {
      if (respondeuViaExecute) return;
      respondErro(detail.id, 'timeout global', REFRESH_TIMEOUT_MS);
    }, REFRESH_TIMEOUT_MS + 1_000);
    void executar(detail).finally(() => {
      respondeuViaExecute = true;
      clearTimeout(guardTimer);
    });
  });

  console.log(`${LOG} instalado em ${window.location.href}`);
})();
