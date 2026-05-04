/**
 * Orquestrador do botão "Controle Metas CNJ" na sidebar (perfil Gestão).
 *
 * Espelha `abrirPainelGerencial` (gestao-coordinator):
 *   1. Lista as tarefas disponíveis no painel via bridge.
 *   2. Pede ao background para abrir a aba intermediária `metas-painel`,
 *      passando as tarefas via `chrome.storage.session`.
 *   3. Toda a seleção, varredura e navegação para o dashboard acontece
 *      dentro dessa aba — esta função só faz o "abrir".
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';

export interface AbrirMetasResult {
  ok: boolean;
  totalTarefas: number;
  error?: string;
}

export async function abrirMetasPainel(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AbrirMetasResult> {
  const progress = opts.onProgress ?? (() => {});

  progress('Listando tarefas disponíveis no painel...');
  const { ok, tarefas, error } = await listarTarefasDoPainel();
  if (!ok) {
    return {
      ok: false,
      totalTarefas: 0,
      error: error ?? 'Falha ao listar tarefas do painel.'
    };
  }

  progress('Abrindo aba "Controle Metas CNJ"...');
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.METAS_OPEN_PAINEL,
      payload: {
        tarefas,
        hostnamePJe: window.location.hostname,
        abertoEm: new Date().toISOString()
      }
    });
    if (!resp?.ok) {
      return {
        ok: false,
        totalTarefas: tarefas.length,
        error: resp?.error ?? 'Falha ao abrir aba do Controle Metas CNJ.'
      };
    }
    return { ok: true, totalTarefas: tarefas.length };
  } catch (err) {
    console.warn(`${LOG_PREFIX} abrirMetasPainel falhou:`, err);
    return {
      ok: false,
      totalTarefas: tarefas.length,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
