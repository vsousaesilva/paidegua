/**
 * Persistência do snapshot de auth do PJe capturado pelo interceptor
 * page-world (`src/content/auth/pje-auth-interceptor-page.ts`).
 *
 * O snapshot é salvo em `chrome.storage.session` para sobreviver à
 * hibernação do service worker MV3 (sem precisar esperar nova chamada
 * REST do painel para reidratar). É lido pelo content script (mesma
 * origem do PJe) que executa as chamadas REST diretamente — o background
 * não faz mais essas chamadas, apenas guarda o snapshot.
 */

import { LOG_PREFIX, STORAGE_KEYS } from '../shared/constants';
import type { PJeAuthSnapshot } from '../shared/types';

export async function gravarAuthSnapshot(snap: PJeAuthSnapshot): Promise<void> {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEYS.PJE_AUTH_SNAPSHOT]: snap
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} pje-api-client: falha gravando snapshot:`, err);
  }
}
