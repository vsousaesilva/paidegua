/**
 * Orquestrador do botão "Audiência pAIdegua" (perfil Secretaria).
 *
 * Mesmo padrão do `pericias-coordinator.ts`:
 *   1. Lista as tarefas do painel e filtra as que casam com a regex de
 *      "Audiência - Designar".
 *   2. Pede ao background para abrir a aba `audiencia-painel/painel.html`
 *      passando as tarefas detectadas.
 *
 * A coleta em si acontece sob comando da própria aba (canal
 * `AUDIENCIA_RUN_COLETA`), depois que o usuário escolhe data e quantidade.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import { isTarefaDesignarAudiencia } from '../../shared/audiencia-helpers';
import type { AudienciaTarefaInfo } from '../../shared/types';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';

export interface AbrirAudienciaPainelResult {
  ok: boolean;
  totalTarefas: number;
  error?: string;
}

export async function abrirAudienciaPainel(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AbrirAudienciaPainelResult> {
  const progress = opts.onProgress ?? (() => {});

  progress('Listando tarefas do painel do PJe...');
  const respTarefas = await listarTarefasDoPainel();
  if (!respTarefas.ok) {
    return {
      ok: false,
      totalTarefas: 0,
      error: respTarefas.error ?? 'Falha ao listar tarefas do painel.'
    };
  }
  const tarefas: AudienciaTarefaInfo[] = respTarefas.tarefas
    .filter((t) => isTarefaDesignarAudiencia(t.nome))
    .map((t) => ({ nome: t.nome, quantidade: t.quantidade }));

  if (tarefas.length === 0) {
    return {
      ok: false,
      totalTarefas: 0,
      error:
        'Nenhuma tarefa de "Audiência - Designar" foi encontrada no painel atual.'
    };
  }

  progress('Abrindo aba de Audiência pAIdegua...');
  const resp = await pedirAberturaAbaPainel(tarefas);
  if (!resp.ok) {
    return {
      ok: false,
      totalTarefas: tarefas.length,
      error: resp.error ?? 'Falha ao abrir a aba de Audiência pAIdegua.'
    };
  }
  return { ok: true, totalTarefas: tarefas.length };
}

async function pedirAberturaAbaPainel(
  tarefas: AudienciaTarefaInfo[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.AUDIENCIA_OPEN_PAINEL,
      payload: {
        tarefas,
        hostnamePJe: window.location.hostname,
        legacyOrigin: window.location.origin,
        abertoEm: new Date().toISOString()
      }
    });
    return { ok: Boolean(resp?.ok), error: resp?.error };
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} audiencia-coordinator: pedirAberturaAbaPainel:`,
      err
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
