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
    // Preserva a última localização (lotação) conhecida. O interceptor grava
    // um snapshot a cada request `/pje-legacy/`, e nem todos carregam o header
    // `X-pje-usuario-localizacao` (alguns trazem só o Bearer). Sobrescrever
    // uma localização válida com `null` faz a ESCRITA de etiqueta — que é
    // escopada por localização/perfil no PJe — perder o contexto e o servidor
    // responder HTTP 500 ("Erro ao vincular ... ao processo "). Só trocamos a
    // localização quando a nova é não-vazia; caso contrário, mantemos a última
    // boa. É a lotação dinâmica do próprio usuário — nunca um valor fixo.
    let aGravar = snap;
    if (!snap.pjeUsuarioLocalizacao) {
      const got = await chrome.storage.session.get(STORAGE_KEYS.PJE_AUTH_SNAPSHOT);
      const anterior = got?.[STORAGE_KEYS.PJE_AUTH_SNAPSHOT] as
        | PJeAuthSnapshot
        | undefined;
      if (anterior?.pjeUsuarioLocalizacao) {
        aGravar = {
          ...snap,
          pjeUsuarioLocalizacao: anterior.pjeUsuarioLocalizacao
        };
      }
    }
    await chrome.storage.session.set({
      [STORAGE_KEYS.PJE_AUTH_SNAPSHOT]: aGravar
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} pje-api-client: falha gravando snapshot:`, err);
  }
}
