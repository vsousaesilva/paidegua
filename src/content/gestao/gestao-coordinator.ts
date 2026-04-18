/**
 * Orquestrador do botão "Abrir Painel Gerencial" no sidebar (perfil Gestão).
 *
 * Fluxo atual (aba dedicada):
 *
 *   1. Pede ao iframe do painel (ou ao próprio top, se o painel rodar no
 *      top frame) a lista completa de tarefas disponíveis.
 *   2. Manda o background abrir uma NOVA aba — a página
 *      `gestao-painel/painel.html` — passando as tarefas via
 *      `chrome.storage.session` e memorizando o par painelTabId ↔ pjeTabId.
 *   3. Toda a seleção, o progresso da varredura e a navegação final para
 *      o dashboard acontecem dentro daquela aba.
 *
 * O seletor antigo em shadow-DOM ficava por trás do sidebar lateral do
 * PJe; a aba dedicada resolve isso e ainda traz barra de progresso real
 * para o usuário acompanhar a varredura.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import { listarTarefasDoPainel } from './gestao-bridge';

export interface AbrirPainelGerencialResult {
  ok: boolean;
  totalTarefas: number;
  error?: string;
}

export async function abrirPainelGerencial(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AbrirPainelGerencialResult> {
  const progress = opts.onProgress ?? (() => {});

  progress('Listando tarefas disponíveis no painel...');
  const { ok: okListar, tarefas, error: errListar } = await listarTarefasDoPainel();
  if (!okListar) {
    return {
      ok: false,
      totalTarefas: 0,
      error: errListar ?? 'Falha ao listar tarefas do painel.'
    };
  }

  progress('Abrindo aba do Painel Gerencial...');
  const resp = await pedirAberturaAbaPainel(tarefas);
  if (!resp.ok) {
    return {
      ok: false,
      totalTarefas: tarefas.length,
      error: resp.error ?? 'Falha ao abrir a aba do Painel Gerencial.'
    };
  }

  return { ok: true, totalTarefas: tarefas.length };
}

async function pedirAberturaAbaPainel(
  tarefas: Array<{ nome: string; quantidade: number | null }>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.GESTAO_OPEN_PAINEL,
      payload: {
        tarefas,
        hostnamePJe: window.location.hostname,
        abertoEm: new Date().toISOString()
      }
    });
    return { ok: Boolean(resp?.ok), error: resp?.error };
  } catch (err) {
    console.warn(`${LOG_PREFIX} pedirAberturaAbaPainel falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
