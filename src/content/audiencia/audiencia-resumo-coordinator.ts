/**
 * Orquestrador da feature "Resumo dos processos da pauta" (AUD-10).
 *
 * Diferente do `audiencia-coordinator.ts` (que primeiro varre tarefas
 * do painel), este coordinator não precisa de pré-coleta — a aba aberta
 * (`audiencia-resumo/resumo.html`) consulta o endpoint nativo do PJe
 * (`listView.seam`) sob demanda do magistrado, com filtros de período
 * e situações.
 *
 * Aqui apenas pedimos ao background para abrir a aba, passando o
 * contexto mínimo (hostname/origin) que ela vai precisar para chamar
 * o coletor de volta no content script via `AUDIENCIA_RESUMO_COLETAR_PAUTA`.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import type { SituacaoCodigo } from '../ui/audiencia-resumo-config-modal';

export interface AbrirAudienciaResumoPainelResult {
  ok: boolean;
  error?: string;
}

export interface AbrirAudienciaResumoPainelInput {
  onProgress?: (msg: string) => void;
  /**
   * Quando presente, abre a aba já com a busca pré-configurada — a aba
   * pula o seletor interno e dispara a busca direto. Quando ausente,
   * abre a aba em estado seletor (comportamento de fallback).
   */
  preConfig?: {
    dataDe: string;          // DD/MM/YYYY
    dataAte: string;         // DD/MM/YYYY
    situacoes: SituacaoCodigo[];
  };
}

export async function abrirAudienciaResumoPainel(
  opts: AbrirAudienciaResumoPainelInput
): Promise<AbrirAudienciaResumoPainelResult> {
  const progress = opts.onProgress ?? (() => {});
  progress('Abrindo aba de Resumo da pauta...');
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.AUDIENCIA_RESUMO_OPEN_PAINEL,
      payload: {
        hostnamePJe: window.location.hostname,
        legacyOrigin: window.location.origin,
        abertoEm: new Date().toISOString(),
        preConfig: opts.preConfig
      }
    });
    if (!resp?.ok) {
      return {
        ok: false,
        error: resp?.error ?? 'Falha ao abrir a aba de Resumo da pauta.'
      };
    }
    return { ok: true };
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} audiencia-resumo-coordinator: abrirAudienciaResumoPainel:`,
      err
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
