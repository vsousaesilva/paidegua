/**
 * Orquestrador do botão "Sigcrim" (perfil Secretaria → Sigcrim).
 *
 * Padrão clonado de Perícias pAIdegua / Prazos na Fita:
 *   1. Pede a lista completa de tarefas do painel do usuário (REST do
 *      Angular interno, mesma mecânica usada por outras features).
 *   2. Lê a configuração criminal local (matrícula do servidor, vara) —
 *      pode ser nula; criminal-config preenche.
 *   3. Pede ao background para abrir a aba do painel Sigcrim via
 *      `CRIMINAL_OPEN_PAINEL`, passando `{ tarefas, config, hostname }`.
 *
 * A seleção de tarefas, escolha de modo (rápido/completo) e
 * acompanhamento de progresso ficam dentro daquela aba — esse arquivo
 * só dispara a abertura.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import { loadCriminalConfig } from '../../shared/criminal-store';
import type { CriminalConfig } from '../../shared/criminal-types';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';

export interface AbrirSigcrimResult {
  ok: boolean;
  totalTarefas: number;
  error?: string;
}

export async function abrirSigcrim(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AbrirSigcrimResult> {
  const progress = opts.onProgress ?? (() => {});

  progress('Listando tarefas do painel do PJe...');
  const { ok: okListar, tarefas, error: errListar } =
    await listarTarefasDoPainel();
  if (!okListar) {
    return {
      ok: false,
      totalTarefas: 0,
      error: errListar ?? 'Falha ao listar tarefas do painel.'
    };
  }

  if (tarefas.length === 0) {
    return {
      ok: false,
      totalTarefas: 0,
      error:
        'Nenhuma tarefa encontrada no painel — confira se o painel-usuário ' +
        'do PJe carregou completamente antes de abrir o Sigcrim.'
    };
  }

  progress('Lendo configuração local...');
  let config: CriminalConfig | null = null;
  try {
    config = await loadCriminalConfig();
  } catch (err) {
    console.warn(`${LOG_PREFIX} sigcrim: falha lendo config local:`, err);
  }

  progress('Abrindo aba do Sigcrim...');
  const resp = await pedirAberturaAbaPainel(tarefas, config);
  if (!resp.ok) {
    return {
      ok: false,
      totalTarefas: tarefas.length,
      error: resp.error ?? 'Falha ao abrir a aba do Sigcrim.'
    };
  }

  return { ok: true, totalTarefas: tarefas.length };
}

async function pedirAberturaAbaPainel(
  tarefas: Array<{ nome: string; quantidade: number | null }>,
  config: CriminalConfig | null
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.CRIMINAL_OPEN_PAINEL,
      payload: {
        tarefas,
        config,
        hostnamePJe: window.location.hostname,
        abertoEm: new Date().toISOString()
      }
    });
    return { ok: Boolean(resp?.ok), error: resp?.error };
  } catch (err) {
    console.warn(`${LOG_PREFIX} pedirAberturaAbaPainel (sigcrim) falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
