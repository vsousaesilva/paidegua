/**
 * Bridge isolated-world → page-world do silent SSO refresh.
 *
 * API de uso (no caminho same-origin do PJe):
 *   import { solicitarRefreshSilent } from './pje-auth-refresh-bridge';
 *   const r = await solicitarRefreshSilent();
 *   if (r.ok) { ... snapshot atualizado ... }
 *
 * Implementacao: dispara `CustomEvent('paidegua:pje-refresh-request')` e
 * aguarda um `paidegua:pje-refresh-result` com o MESMO `id`. Se duas
 * chamadas acontecerem em paralelo (workers concorrentes pegando 403 ao
 * mesmo tempo), todas compartilham o MESMO request in-flight — evita N
 * iframes simultaneos no page world.
 *
 * Apos sucesso, atualiza `chrome.storage.session[PJE_AUTH_SNAPSHOT]`:
 * preserva os headers `X-pje-*` do snapshot atual (nao mudam no refresh,
 * sao da sessao legacy) e troca apenas o `Authorization`. Isso acorda
 * automaticamente `aguardarNovoSnapshot` via `chrome.storage.onChanged`.
 */

import {
  LOG_PREFIX,
  STORAGE_KEYS
} from '../../shared/constants';
import type {
  Http403Diagnostic,
  PJeAuthSnapshot,
  SilentRefreshResult
} from '../../shared/types';

const REFRESH_ISSUER = 'https://sso.cloud.pje.jus.br/auth/realms/pje';
const REFRESH_CLIENT_ID = 'pje-frontend';

/**
 * Monta o `redirect_uri` aceito pelo Keycloak. Derivamos do `window.location`
 * porque cada tribunal tem seu proprio host de frontend (ex.: frontend-prd.
 * trf5.jus.br, frontend-pje.tjpb.jus.br). Cai no default do TRF5 se nao
 * estivermos em um origin *.jus.br reconhecivel.
 */
function redirectUriParaOrigem(): string {
  try {
    const host = window.location.hostname;
    if (/^frontend/i.test(host) && /\.jus\.br$/i.test(host)) {
      return `${window.location.origin}/silent-check-sso.html`;
    }
  } catch {
    /* ignore */
  }
  return 'https://frontend-prd.trf5.jus.br/silent-check-sso.html';
}

// Guard da bridge: precisa acomodar o REFRESH_TIMEOUT_MS do page-world
// (25s) + ~3s de margem para o CustomEvent roundtrip. Aumentado do
// original 12s junto com o aumento dos budgets do iframe/token em abas
// em background.
const TIMEOUT_MS = 28_000;

interface PendingRequest {
  id: string;
  resolve: (r: SilentRefreshResult) => void;
}

let inflight: Promise<SilentRefreshResult> | null = null;

function gerarId(): string {
  const r = Math.random().toString(36).slice(2, 10);
  return `refresh-${Date.now()}-${r}`;
}

async function disparar(): Promise<SilentRefreshResult> {
  const id = gerarId();
  const redirectUri = redirectUriParaOrigem();

  return new Promise<SilentRefreshResult>((resolve) => {
    const pending: PendingRequest = { id, resolve };
    let settled = false;

    const onResult = (ev: Event): void => {
      const detail = (ev as CustomEvent).detail as
        | {
            id: string;
            ok: boolean;
            authorization?: string;
            accessToken?: string;
            expiresIn?: number;
            jwtExp?: number;
            error?: string;
            durationMs?: number;
          }
        | undefined;
      if (!detail || detail.id !== pending.id || settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener(
        'paidegua:pje-refresh-result',
        onResult as EventListener
      );
      if (detail.ok && detail.authorization) {
        pending.resolve({
          ok: true,
          authorization: detail.authorization,
          accessToken: detail.accessToken,
          expiresIn: detail.expiresIn,
          jwtExp: detail.jwtExp,
          durationMs: detail.durationMs
        });
      } else {
        pending.resolve({
          ok: false,
          error: detail.error ?? 'falha desconhecida',
          durationMs: detail.durationMs
        });
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      document.removeEventListener(
        'paidegua:pje-refresh-result',
        onResult as EventListener
      );
      pending.resolve({
        ok: false,
        error: 'timeout bridge isolated-world',
        durationMs: TIMEOUT_MS
      });
    }, TIMEOUT_MS);

    document.addEventListener(
      'paidegua:pje-refresh-result',
      onResult as EventListener
    );

    try {
      document.dispatchEvent(
        new CustomEvent('paidegua:pje-refresh-request', {
          detail: {
            id,
            issuer: REFRESH_ISSUER,
            clientId: REFRESH_CLIENT_ID,
            redirectUri
          }
        })
      );
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener(
        'paidegua:pje-refresh-result',
        onResult as EventListener
      );
      const msg = err instanceof Error ? err.message : String(err);
      pending.resolve({ ok: false, error: `dispatch: ${msg}` });
    }
  });
}

async function lerSnapshotAtual(): Promise<PJeAuthSnapshot | null> {
  try {
    const r = await chrome.storage.session.get(STORAGE_KEYS.PJE_AUTH_SNAPSHOT);
    const s = r[STORAGE_KEYS.PJE_AUTH_SNAPSHOT];
    if (s && typeof s === 'object') return s as PJeAuthSnapshot;
  } catch {
    /* ignore */
  }
  return null;
}

async function gravarSnapshotAtualizado(
  authorization: string
): Promise<void> {
  const atual = await lerSnapshotAtual();
  const novo: PJeAuthSnapshot = atual
    ? { ...atual, authorization, capturedAt: Date.now() }
    : {
        capturedAt: Date.now(),
        url: window.location.href,
        authorization,
        pjeCookies: null,
        pjeLegacyApp: null,
        pjeUsuarioLocalizacao: null,
        xNoSso: null,
        xPjeAuthorization: null
      };
  try {
    await chrome.storage.session.set({
      [STORAGE_KEYS.PJE_AUTH_SNAPSHOT]: novo
    });
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} silent-refresh: falha gravando snapshot atualizado:`,
      err
    );
  }
}

/**
 * Solicita um silent refresh do Bearer. Coalesce chamadas concorrentes —
 * se ja existe um refresh in-flight, aguarda ele e devolve o mesmo
 * resultado (evita rajada de iframes se varios workers pegarem 403 juntos).
 *
 * Retry: faz ate 2 tentativas dentro do mesmo inflight. A primeira costuma
 * falhar com "timeout silent SSO" quando a aba do PJe esta em background
 * (Chrome throttla o iframe cross-origin), mas a segunda frequentemente
 * passa porque o browser ja esta com os sockets/DNS do sso.cloud.pje
 * aquecidos. Backoff curto (1s) entre tentativas. Total ~51s no pior
 * caso — cabe no orcamento de 60s do `gerarCaComRetryEmRefresh`.
 *
 * Em sucesso, grava novo snapshot em `chrome.storage.session` — o que
 * acorda automaticamente `aguardarNovoSnapshot` em `pje-api-from-content.ts`
 * via `chrome.storage.onChanged`.
 */
const TENTATIVAS = 2;
const BACKOFF_MS = 1_000;
export async function solicitarRefreshSilent(): Promise<SilentRefreshResult> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      let ultimo: SilentRefreshResult | null = null;
      for (let i = 0; i < TENTATIVAS; i++) {
        const r = await disparar();
        if (r.ok && r.authorization) {
          await gravarSnapshotAtualizado(r.authorization);
          return r;
        }
        ultimo = r;
        if (i < TENTATIVAS - 1) {
          await new Promise((res) => setTimeout(res, BACKOFF_MS));
        }
      }
      return ultimo ?? { ok: false, error: 'silent refresh: falha desconhecida' };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Grava diagnostico de um HTTP 403 em `chrome.storage.local` como ring
 * buffer (cap 50, mais recente no fim). Chamado pelo cliente REST
 * sempre que um 403 sobe. Ter historico — e nao so o ultimo — e
 * essencial em varreduras longas: a causa raiz de uma falha "token nao
 * renovou em 60s" so aparece analisando os 403s que antecederam o
 * abort (ex.: silent SSO falhando com `login_required` varias vezes,
 * indicando sessao Keycloak caducada). Nao bloqueante: falha silenciosa.
 */
const HTTP_403_LOG_CAP = 50;
export async function registrar403Diag(
  diag: Http403Diagnostic
): Promise<void> {
  try {
    const existente = await chrome.storage.local.get(STORAGE_KEYS.HTTP_403_LOG);
    const prev = existente[STORAGE_KEYS.HTTP_403_LOG];
    const arr: Http403Diagnostic[] = Array.isArray(prev)
      ? (prev as Http403Diagnostic[])
      : [];
    arr.push(diag);
    const trimmed =
      arr.length > HTTP_403_LOG_CAP ? arr.slice(-HTTP_403_LOG_CAP) : arr;
    await chrome.storage.local.set({
      [STORAGE_KEYS.HTTP_403_LOG]: trimmed
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} silent-refresh: falha gravando 403 diag:`, err);
  }
}

/**
 * Decodifica `exp` do JWT (sem validar assinatura). Retorna epoch segundos
 * ou null. Tolerante a qualquer erro.
 */
export function decodeJwtExp(authorization: string | null): number | null {
  if (!authorization) return null;
  try {
    const match = authorization.match(/Bearer\s+([A-Za-z0-9._-]+)/);
    if (!match) return null;
    const parts = match[1].split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice(0, (4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}
