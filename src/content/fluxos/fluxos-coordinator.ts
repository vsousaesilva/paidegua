/**
 * Orquestrador do botão "Consultor de fluxos" no sidebar.
 *
 * Diferente de Gestão/Perícias, o Consultor de fluxos NÃO depende de
 * estado da aba PJe (não coleta dados, não acessa processo). É uma
 * página estática que carrega o catálogo embarcado e abre uma conversa.
 *
 * Fluxo:
 *   1. Sidebar dispara `abrirConsultorFluxos()`.
 *   2. Coordinator pede ao background `FLUXOS_OPEN_CONSULTOR`.
 *   3. Background faz `chrome.tabs.create({ url: 'fluxos-consultor/consultor.html' })`.
 *   4. A aba carrega autonomamente.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';

export interface AbrirConsultorFluxosResult {
  ok: boolean;
  error?: string;
}

export async function abrirConsultorFluxos(): Promise<AbrirConsultorFluxosResult> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.FLUXOS_OPEN_CONSULTOR,
      payload: {}
    });
    return { ok: Boolean(resp?.ok), error: resp?.error };
  } catch (err) {
    console.warn(`${LOG_PREFIX} abrirConsultorFluxos falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
