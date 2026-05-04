/**
 * Orquestrador do botão "Central de Comunicação" (perfil Secretaria).
 *
 * Mesmo padrão das demais features de painel: lê o snapshot de peritos
 * e settings, envia ao background `COMUNICACAO_OPEN_PAINEL` e o background
 * abre a aba `comunicacao-painel/painel.html` com a UI completa (seleção
 * de modo + filtros + coleta + ações de cobrança).
 *
 * Diferente das Perícias, NÃO há etapa de coleta no content disparada
 * pelo coordinator: a aba do painel é que decide quando coletar (após o
 * usuário escolher modo/filtro). A coleta é roteada via background pelo
 * canal `COMUNICACAO_RUN_COLETA`.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import { listPeritosAtivos } from '../../shared/pericias-store';
import { defaultComunicacaoSettings } from '../../shared/comunicacao-store';
import type {
  ComunicacaoSettings,
  PAIdeguaSettings,
  PericiaPerito
} from '../../shared/types';

export interface AbrirComunicacaoPainelResult {
  ok: boolean;
  error?: string;
}

export async function abrirComunicacaoPainel(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AbrirComunicacaoPainelResult> {
  const progress = opts.onProgress ?? (() => {});

  progress('Carregando configurações da Central de Comunicação...');
  const settings = await lerComunicacaoSettings();

  progress('Carregando peritos cadastrados...');
  let peritos: PericiaPerito[] = [];
  try {
    peritos = await listPeritosAtivos();
  } catch (err) {
    console.warn(`${LOG_PREFIX} comunicacao-coordinator: peritos:`, err);
  }

  progress('Abrindo aba da Central de Comunicação...');
  const resp = await pedirAberturaAbaPainel(peritos, settings);
  if (!resp.ok) {
    return {
      ok: false,
      error: resp.error ?? 'Falha ao abrir a aba da Central de Comunicação.'
    };
  }
  return { ok: true };
}

async function lerComunicacaoSettings(): Promise<ComunicacaoSettings> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.GET_SETTINGS,
      payload: {}
    });
    const s = (resp?.settings ?? null) as PAIdeguaSettings | null;
    if (s && typeof s === 'object' && s.comunicacao) {
      return {
        nomeVara: s.comunicacao.nomeVara ?? '',
        emailCeab: s.comunicacao.emailCeab ?? '',
        telefoneCeab: s.comunicacao.telefoneCeab ?? '',
        etiquetaCobrancaPerito: s.comunicacao.etiquetaCobrancaPerito ?? '',
        etiquetaCobrancaCeab: s.comunicacao.etiquetaCobrancaCeab ?? ''
      };
    }
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} comunicacao-coordinator: erro lendo settings:`,
      err
    );
  }
  return defaultComunicacaoSettings();
}

async function pedirAberturaAbaPainel(
  peritos: PericiaPerito[],
  settings: ComunicacaoSettings
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.COMUNICACAO_OPEN_PAINEL,
      payload: {
        peritos,
        settings,
        hostnamePJe: window.location.hostname,
        legacyOrigin: window.location.origin,
        abertoEm: new Date().toISOString()
      }
    });
    return { ok: Boolean(resp?.ok), error: resp?.error };
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} comunicacao-coordinator: pedirAberturaAbaPainel:`,
      err
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
