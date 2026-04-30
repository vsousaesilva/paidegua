/**
 * Orquestrador do botão "Criar pauta" (perfil Secretaria → Perícias
 * pAIdegua). Mesmo padrão do Painel Gerencial / Prazos na Fita:
 *
 *   1. Pede ao iframe do painel (ou ao próprio top) a lista completa de
 *      tarefas e filtra as que contêm "Perícia - Designar" ou
 *      "Perícia - Agendar e administrar".
 *   2. Lê os peritos ativos do `chrome.storage.local` para entregar um
 *      snapshot à aba-painel — evita leitura concorrente com edições
 *      feitas em outra aba.
 *   3. Pede ao background para abrir a aba-painel via
 *      `PERICIAS_OPEN_PAINEL`, passando `{ tarefas, peritos, ... }`. Toda
 *      a seleção de peritos, configuração de critérios e acompanhamento
 *      de progresso acontece naquela aba. A coleta em si é disparada
 *      depois via `PERICIAS_START_COLETA` → `PERICIAS_RUN_COLETA`.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import {
  isTarefaDePericia,
  listPeritosAtivos
} from '../../shared/pericias-store';
import type { PericiaPerito, PericiaTarefaInfo } from '../../shared/types';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';

export interface AbrirPericiasPainelResult {
  ok: boolean;
  totalTarefas: number;
  error?: string;
}

export async function abrirPericiasPainel(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AbrirPericiasPainelResult> {
  const progress = opts.onProgress ?? (() => {});

  progress('Listando tarefas do painel do PJe...');
  const { ok: okListar, tarefas: todas, error: errListar } =
    await listarTarefasDoPainel();
  if (!okListar) {
    return {
      ok: false,
      totalTarefas: 0,
      error: errListar ?? 'Falha ao listar tarefas do painel.'
    };
  }

  const tarefasPericia: PericiaTarefaInfo[] = todas
    .filter((t) => isTarefaDePericia(t.nome))
    .map((t) => ({ nome: t.nome, quantidade: t.quantidade }));

  if (tarefasPericia.length === 0) {
    return {
      ok: false,
      totalTarefas: 0,
      error:
        'Nenhuma tarefa de perícia encontrada no painel. A feature espera ' +
        'tarefas cujos nomes contenham "Perícia - Designar" ou ' +
        '"Perícia - Agendar e administrar".'
    };
  }

  progress('Carregando peritos cadastrados...');
  let peritos: PericiaPerito[] = [];
  try {
    peritos = await listPeritosAtivos();
  } catch (err) {
    console.warn(`${LOG_PREFIX} Falha ao ler peritos ativos:`, err);
  }

  progress('Abrindo aba de Perícias pAIdegua...');
  const resp = await pedirAberturaAbaPainel(tarefasPericia, peritos);
  if (!resp.ok) {
    return {
      ok: false,
      totalTarefas: tarefasPericia.length,
      error: resp.error ?? 'Falha ao abrir a aba de Perícias pAIdegua.'
    };
  }

  return { ok: true, totalTarefas: tarefasPericia.length };
}

async function pedirAberturaAbaPainel(
  tarefas: PericiaTarefaInfo[],
  peritos: PericiaPerito[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PERICIAS_OPEN_PAINEL,
      payload: {
        tarefas,
        peritos,
        hostnamePJe: window.location.hostname,
        abertoEm: new Date().toISOString()
      }
    });
    return { ok: Boolean(resp?.ok), error: resp?.error };
  } catch (err) {
    console.warn(`${LOG_PREFIX} pedirAberturaAbaPainel (perícias) falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
