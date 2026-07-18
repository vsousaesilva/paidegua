/**
 * Orquestrador do botão "Painel de Perícias pAIdegua" (perfil Gestão).
 * Mesmo padrão do `prevjud-coordinator`:
 *
 *   1. Lista todas as tarefas do painel do usuário (a escolha de quais varrer
 *      acontece na aba-painel).
 *   2. Descobre a lista de situações de perícia (para o usuário escolher
 *      quais ignorar) — lida do `<select>` de situação do relatório
 *      `PautaPericia/listView.seam`, com fallback para uma lista canônica.
 *   3. Pede ao background para abrir a aba-painel via `PAUTA_PERICIA_OPEN_PAINEL`;
 *      a coleta é disparada depois via `START_COLETA` → `RUN_COLETA`.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';

/** Situações canônicas de perícia — fallback se o relatório não responder. */
const SITUACOES_FALLBACK = [
  'Designada',
  'Redesignada',
  'Realizada',
  'Não realizada',
  'Cancelada',
  'Aguardando laudo',
  'Laudo entregue',
  'Enviado para pagamento',
  'Pago'
];

export interface AbrirPautaPericiaPainelResult {
  ok: boolean;
  totalTarefas: number;
  error?: string;
}

export async function abrirPautaPericiaPainel(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AbrirPautaPericiaPainelResult> {
  const progress = opts.onProgress ?? ((): void => {});

  progress('Listando tarefas do painel do PJe...');
  const { ok: okListar, tarefas, error: errListar } = await listarTarefasDoPainel();
  if (!okListar) {
    return { ok: false, totalTarefas: 0, error: errListar ?? 'Falha ao listar tarefas do painel.' };
  }
  if (!tarefas || tarefas.length === 0) {
    return { ok: false, totalTarefas: 0, error: 'Nenhuma tarefa encontrada no painel do usuário.' };
  }

  progress('Carregando situações de perícia...');
  const situacoes = await lerSituacoesDisponiveis(window.location.origin);

  progress('Abrindo "Painel de Perícias" em nova aba...');
  const resp = await pedirAberturaAbaPainel(
    tarefas.map((t) => ({ nome: t.nome, quantidade: t.quantidade })),
    situacoes
  );
  if (!resp.ok) {
    return {
      ok: false,
      totalTarefas: tarefas.length,
      error: resp.error ?? 'Falha ao abrir a aba do Painel de Perícias.'
    };
  }
  return { ok: true, totalTarefas: tarefas.length };
}

/**
 * Lê as situações do `<select>` de situação do relatório de perícia
 * (`…:statusDecoration:status`). GET same-origin; tolerante a falha (cai no
 * fallback canônico). Descarta o placeholder e o NoSelectionConverter.
 */
async function lerSituacoesDisponiveis(legacyOrigin: string): Promise<string[]> {
  try {
    const url = `${legacyOrigin.replace(/\/+$/, '')}/pje/PautaPericia/listView.seam`;
    const resp = await fetch(url, { method: 'GET', credentials: 'include' });
    if (!resp.ok) return SITUACOES_FALLBACK;
    const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
    const select = doc.querySelector('select[name*="statusDecoration:status"], select[name*="status"]');
    if (!select) return SITUACOES_FALLBACK;
    const out: string[] = [];
    select.querySelectorAll('option').forEach((op) => {
      const value = op.getAttribute('value') ?? '';
      const label = (op.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!value || /noSelectionValue/i.test(value)) return;
      if (!label || /^(todos|selecione)$/i.test(label)) return;
      out.push(label);
    });
    return out.length > 0 ? out : SITUACOES_FALLBACK;
  } catch (err) {
    console.warn(`${LOG_PREFIX} lerSituacoesDisponiveis falhou:`, err);
    return SITUACOES_FALLBACK;
  }
}

async function pedirAberturaAbaPainel(
  tarefas: { nome: string; quantidade: number | null }[],
  situacoes: string[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PAUTA_PERICIA_OPEN_PAINEL,
      payload: {
        tarefas,
        situacoes,
        hostnamePJe: window.location.hostname,
        legacyOrigin: window.location.origin,
        abertoEm: new Date().toISOString()
      }
    });
    return { ok: Boolean(resp?.ok), error: resp?.error };
  } catch (err) {
    console.warn(`${LOG_PREFIX} pedirAberturaAbaPainel (pauta-pericia) falhou:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
