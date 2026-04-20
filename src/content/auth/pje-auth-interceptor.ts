/**
 * Bridge isolated-world ↔ background para o snapshot de autenticacao
 * do PJe capturado pelo `pje-auth-interceptor-page.ts` (page world).
 *
 * Page world ↔ isolated world se comunicam apenas via DOM/eventos
 * customizados — chrome.* nao existe na page world. Aqui escutamos
 * o `CustomEvent('paidegua:pje-auth')` despachado em `document` e
 * relayamos ao background, que mantem a memoria do snapshot.
 *
 * Throttling: o painel Angular pode disparar muitas chamadas REST por
 * minuto e os headers raramente mudam entre elas. Limita a um envio
 * a cada 5s para nao inundar o service worker.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../../shared/constants';
import type { PJeAuthSnapshot } from '../../shared/types';

const MIN_INTERVAL_MS = 5_000;
let ultimoEnvioMs = 0;

/**
 * Persiste o relatorio do probe Keycloak (despachado por
 * `pje-auth-probe-page.ts`). Mantem o relatorio MAIS INFORMATIVO ja gravado
 * (nao o mais recente), porque o probe roda em varias abas — cada uma com
 * perfil diferente (Seam legacy vs SPA Angular) — e um report rico da aba
 * Angular nao pode ser sobrescrito por um pobre da aba Seam.
 *
 * Score (maior vence):
 *   foundAny:true   → +1000
 *   Angular attr    → +200
 *   JWT iss decodado→ +100
 *   candidatos      → +10 por candidato
 *   cookies/iframes → +1 por item (desempate)
 *
 * Tolerante a erro — storage falho nao pode derrubar a SPA host.
 */
interface ProbeReportForScoring {
  foundAny?: boolean;
  angularVersion?: string | null;
  jwtIssuer?: string | null;
  candidates?: unknown[];
  cookieNames?: unknown[];
  iframes?: unknown[];
  localStorageKeys?: unknown[];
}

function scoreProbe(r: ProbeReportForScoring | undefined | null): number {
  if (!r) return -1;
  let s = 0;
  if (r.foundAny) s += 1000;
  if (r.angularVersion) s += 200;
  if (r.jwtIssuer) s += 100;
  if (Array.isArray(r.candidates)) s += r.candidates.length * 10;
  if (Array.isArray(r.cookieNames)) s += r.cookieNames.length;
  if (Array.isArray(r.iframes)) s += r.iframes.length;
  if (Array.isArray(r.localStorageKeys)) s += r.localStorageKeys.length;
  return s;
}

async function persistirProbeKeycloak(novo: unknown): Promise<void> {
  if (!novo || typeof novo !== 'object') return;
  try {
    const atual = await chrome.storage.local.get(STORAGE_KEYS.KEYCLOAK_PROBE);
    const anterior = atual?.[STORAGE_KEYS.KEYCLOAK_PROBE] as
      | ProbeReportForScoring
      | undefined;
    const novoObj = novo as ProbeReportForScoring;
    if (scoreProbe(novoObj) < scoreProbe(anterior)) return;
    await chrome.storage.local.set({ [STORAGE_KEYS.KEYCLOAK_PROBE]: novo });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/extension context invalidated/i.test(msg)) return;
    console.warn(`${LOG_PREFIX} persistencia do probe Keycloak falhou:`, err);
  }
}

function isAuthSnapshot(x: unknown): x is PJeAuthSnapshot {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  // Aceita qualquer esquema (Bearer | Basic): o PJe autentica via cookie
  // de sessao + X-pje-* — o Authorization apenas preserva a paridade com
  // o que o painel Angular envia. Exigir "Bearer" quebra quando o SSO
  // expira e o legacy cai no fallback Basic dummy.
  return (
    typeof o.authorization === 'string' &&
    o.authorization.length > 0 &&
    typeof o.url === 'string' &&
    typeof o.capturedAt === 'number'
  );
}

export function instalarBridgeInterceptorAuth(): void {
  document.addEventListener('paidegua:pje-auth', (ev) => {
    const detail = (ev as CustomEvent).detail;
    if (!isAuthSnapshot(detail)) return;
    const agora = Date.now();
    if (agora - ultimoEnvioMs < MIN_INTERVAL_MS) return;
    ultimoEnvioMs = agora;
    chrome.runtime
      .sendMessage({
        channel: MESSAGE_CHANNELS.PJE_AUTH_CAPTURED,
        payload: detail
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`${LOG_PREFIX} relay auth ao background falhou:`, msg);
      });
  });
  // Probe Keycloak: page world detecta se o adapter Angular esta acessivel
  // e envia um relatorio; isolated world persiste para a pagina de
  // Diagnostico consultar.
  document.addEventListener('paidegua:kc-probe', (ev) => {
    const detail = (ev as CustomEvent).detail;
    void persistirProbeKeycloak(detail);
  });
  console.log(`${LOG_PREFIX} pje-auth-interceptor: bridge isolated-world instalada.`);
}
