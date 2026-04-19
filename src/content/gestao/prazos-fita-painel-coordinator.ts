/**
 * Orquestrador do botão "Prazos na Fita pAIdegua" no sidebar (perfil Gestão).
 *
 * Mesma topologia do `gestao-coordinator`, mas o background abre a aba do
 * painel em `?modo=prazos`, que aplica o filtro "Controle de prazo" e
 * dispara a coleta via API REST (`coletarPrazosPorTarefasViaAPI`) em vez
 * da varredura por scraping do Painel Gerencial.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import { listarTarefasDoPainel } from './gestao-bridge';

export interface AbrirPrazosFitaResult {
  ok: boolean;
  totalTarefas: number;
  error?: string;
}

export async function abrirPrazosFitaPainel(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AbrirPrazosFitaResult> {
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

  progress('Abrindo aba "Prazos na Fita pAIdegua"...');
  const resp = await pedirAberturaAbaPainel(tarefas);
  if (!resp.ok) {
    return {
      ok: false,
      totalTarefas: tarefas.length,
      error: resp.error ?? 'Falha ao abrir a aba "Prazos na Fita pAIdegua".'
    };
  }

  return { ok: true, totalTarefas: tarefas.length };
}

async function pedirAberturaAbaPainel(
  tarefas: Array<{ nome: string; quantidade: number | null }>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PRAZOS_FITA_OPEN_PAINEL,
      payload: {
        tarefas,
        hostnamePJe: window.location.hostname,
        abertoEm: new Date().toISOString()
      }
    });
    return { ok: Boolean(resp?.ok), error: resp?.error };
  } catch (err) {
    console.warn(`${LOG_PREFIX} pedirAberturaAbaPainel (prazos) falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
