/**
 * Helper compartilhado para renderizar o `<div class="header__meta">`
 * dos painéis e dashboards do paidegua. Padrão:
 *
 *   - Linha 1: nome da unidade em negrito (ex.: "35ª Vara Federal CE")
 *   - Linha 2: data/hora formatada em pt-BR
 *   - Linha 3+: contadores ou indicadores (ex.: "3 tarefa(s) · 776 processo(s)")
 *
 * Linhas vazias são suprimidas — quando a unidade não foi configurada
 * em `settings.comunicacao.nomeVara`, os painéis caem para o `hostnamePJe`
 * como fallback.
 */

import { defaultComunicacaoSettings } from './comunicacao-store';
import { MESSAGE_CHANNELS } from './constants';
import type { PAIdeguaSettings } from './types';

export interface HeaderMetaInput {
  /**
   * Nome da unidade (ex.: "35ª Vara Federal CE"). Quando vazio, a linha
   * de unidade é omitida e o caller geralmente passa `hostnamePJe` como
   * fallback nas linhas extras.
   */
  unidade?: string | null;
  /** Timestamp para a linha de data (Date, ISO string ou epoch ms). */
  geradoEm?: string | number | Date;
  /** Linhas adicionais (já formatadas como texto cru — sem HTML). */
  contadores?: string[];
}

export function renderHeaderMeta(
  alvo: HTMLElement,
  input: HeaderMetaInput
): void {
  const linhas: string[] = [];
  const u = (input.unidade ?? '').trim();
  if (u) {
    linhas.push(`<div><strong>${escapeHtml(u)}</strong></div>`);
  }
  if (input.geradoEm != null) {
    const dt = toDate(input.geradoEm);
    if (dt) {
      linhas.push(`<div>${escapeHtml(formatarDataHora(dt))}</div>`);
    }
  }
  if (input.contadores) {
    for (const linha of input.contadores) {
      const t = (linha ?? '').trim();
      if (t) linhas.push(`<div>${escapeHtml(t)}</div>`);
    }
  }
  alvo.innerHTML = linhas.join('');
}

/**
 * Lê o nome da Vara cadastrado na seção "Central de Comunicação" das
 * settings — fonte canônica única para identificar a unidade nos
 * painéis. Devolve string vazia quando ausente.
 *
 * Pode ser chamado tanto a partir de painéis (extension views) quanto
 * de content scripts.
 */
export async function lerNomeVaraDasSettings(): Promise<string> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.GET_SETTINGS,
      payload: {}
    });
    const s = (resp?.settings ?? null) as PAIdeguaSettings | null;
    if (s?.comunicacao) {
      return (s.comunicacao.nomeVara ?? '').trim();
    }
  } catch {
    /* default abaixo */
  }
  return defaultComunicacaoSettings().nomeVara;
}

function toDate(v: string | number | Date): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === 'number') {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function formatarDataHora(d: Date): string {
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
