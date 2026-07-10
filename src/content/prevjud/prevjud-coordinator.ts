/**
 * Orquestrador do botão "Ordens PREVJUD" (perfil Gestão — GES-10). Mesmo
 * padrão do Painel Gerencial / Perícias:
 *
 *   1. Lista todas as tarefas do painel do usuário (o usuário escolhe na
 *      aba-painel quais varrer — não há filtro fixo de nome de tarefa).
 *   2. Pede ao background para abrir a aba-painel via `PREVJUD_OPEN_PAINEL`.
 *      A seleção de tarefas + etiquetas de filtro e o acompanhamento de
 *      progresso acontecem naquela aba; a coleta é disparada depois via
 *      `PREVJUD_START_COLETA` → `PREVJUD_RUN_COLETA`.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';

export interface AbrirPrevjudPainelResult {
  ok: boolean;
  totalTarefas: number;
  error?: string;
}

export async function abrirPrevjudPainel(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AbrirPrevjudPainelResult> {
  const progress = opts.onProgress ?? ((): void => {});

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
  if (!tarefas || tarefas.length === 0) {
    return {
      ok: false,
      totalTarefas: 0,
      error: 'Nenhuma tarefa encontrada no painel do usuário.'
    };
  }

  progress('Abrindo "Ordens PREVJUD" em nova aba...');
  const resp = await pedirAberturaAbaPainel(
    tarefas.map((t) => ({ nome: t.nome, quantidade: t.quantidade }))
  );
  if (!resp.ok) {
    return {
      ok: false,
      totalTarefas: tarefas.length,
      error: resp.error ?? 'Falha ao abrir a aba de Ordens PREVJUD.'
    };
  }

  return { ok: true, totalTarefas: tarefas.length };
}

async function pedirAberturaAbaPainel(
  tarefas: { nome: string; quantidade: number | null }[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PREVJUD_OPEN_PAINEL,
      payload: {
        tarefas,
        hostnamePJe: window.location.hostname,
        legacyOrigin: window.location.origin,
        abertoEm: new Date().toISOString()
      }
    });
    return { ok: Boolean(resp?.ok), error: resp?.error };
  } catch (err) {
    console.warn(`${LOG_PREFIX} pedirAberturaAbaPainel (PREVJUD) falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
