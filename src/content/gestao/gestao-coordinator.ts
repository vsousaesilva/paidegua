/**
 * Orquestrador do botão "Abrir Painel Gerencial" no topo (perfil Gestão).
 *
 * Fluxo completo:
 *   1. Pede ao iframe (ou local) a lista de tarefas do painel.
 *   2. Mostra o seletor múltiplo ao usuário (pré-marcando o que ele
 *      usou da última vez).
 *   3. Salva a seleção e dispara a varredura das tarefas escolhidas.
 *   4. Computa indicadores locais, monta o payload e pede ao background
 *      para abrir a página do dashboard gerencial.
 *
 * Sem chamada à LLM nesta etapa — os insights interpretativos rodam
 * dentro do dashboard, sobre dados sanitizados.
 */

import {
  LOG_PREFIX,
  MESSAGE_CHANNELS,
  STORAGE_KEYS
} from '../../shared/constants';
import type { GestaoDashboardPayload } from '../../shared/types';
import {
  coletarTarefasSelecionadas,
  listarTarefasDoPainel
} from './gestao-bridge';
import { computarIndicadoresGestao } from './gestao-indicadores';
import { mostrarSeletorTarefas } from './gestao-picker';

export interface AbrirPainelGerencialResult {
  ok: boolean;
  totalTarefas: number;
  totalProcessos: number;
  cancelado?: boolean;
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
      totalProcessos: 0,
      error: errListar ?? 'Falha ao listar tarefas do painel.'
    };
  }

  const preSelecionadas = await carregarSelecaoAnterior();
  const escolhidas = await mostrarSeletorTarefas({
    tarefas,
    preSelecionadas
  });
  if (escolhidas === null) {
    return { ok: false, totalTarefas: 0, totalProcessos: 0, cancelado: true };
  }
  if (escolhidas.length === 0) {
    return {
      ok: false,
      totalTarefas: 0,
      totalProcessos: 0,
      error: 'Nenhuma tarefa selecionada.'
    };
  }

  await salvarSelecao(escolhidas);

  progress(
    `Varredura iniciada em ${escolhidas.length} tarefa(s). Pode levar alguns minutos.`
  );

  const { ok, snapshots, error } = await coletarTarefasSelecionadas({
    nomes: escolhidas,
    onProgress: progress
  });
  if (!ok) {
    return {
      ok: false,
      totalTarefas: snapshots.length,
      totalProcessos: snapshots.reduce((s, t) => s + t.totalLido, 0),
      error: error ?? 'Falha na varredura das tarefas selecionadas.'
    };
  }

  const totalProcessos = snapshots.reduce((s, t) => s + t.totalLido, 0);
  const indicadores = computarIndicadoresGestao(snapshots);

  const payload: GestaoDashboardPayload = {
    geradoEm: new Date().toISOString(),
    hostnamePJe: new URL(window.location.origin).hostname,
    tarefasSelecionadas: escolhidas,
    tarefas: snapshots,
    totalProcessos,
    indicadores,
    insightsLLM: null
  };

  progress('Abrindo painel gerencial...');
  const resp = await pedirAberturaDashboard(payload);
  if (!resp) {
    return {
      ok: false,
      totalTarefas: snapshots.length,
      totalProcessos,
      error: 'Falha ao abrir o dashboard gerencial. Veja o console para detalhes.'
    };
  }

  return { ok: true, totalTarefas: snapshots.length, totalProcessos };
}

async function carregarSelecaoAnterior(): Promise<string[]> {
  try {
    const { [STORAGE_KEYS.GESTAO_TAREFAS_SELECIONADAS]: raw } =
      await chrome.storage.local.get(STORAGE_KEYS.GESTAO_TAREFAS_SELECIONADAS);
    if (!raw || typeof raw !== 'object') return [];
    const obj = raw as { tarefasSelecionadas?: unknown };
    const lista = obj.tarefasSelecionadas;
    if (!Array.isArray(lista)) return [];
    return lista.filter((x): x is string => typeof x === 'string');
  } catch (err) {
    console.warn(`${LOG_PREFIX} carregarSelecaoAnterior falhou:`, err);
    return [];
  }
}

async function salvarSelecao(nomes: string[]): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.GESTAO_TAREFAS_SELECIONADAS]: {
        tarefasSelecionadas: nomes,
        salvoEm: new Date().toISOString()
      }
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} salvarSelecao falhou:`, err);
  }
}

async function pedirAberturaDashboard(
  payload: GestaoDashboardPayload
): Promise<boolean> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.GESTAO_OPEN_DASHBOARD,
      payload
    });
    return Boolean(resp?.ok);
  } catch (err) {
    console.warn(`${LOG_PREFIX} pedirAberturaDashboard (gestao) falhou:`, err);
    return false;
  }
}
