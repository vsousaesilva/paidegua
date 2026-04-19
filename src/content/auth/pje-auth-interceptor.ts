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

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import type { PJeAuthSnapshot } from '../../shared/types';

const MIN_INTERVAL_MS = 5_000;
let ultimoEnvioMs = 0;

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
  console.log(`${LOG_PREFIX} pje-auth-interceptor: bridge isolated-world instalada.`);
}
