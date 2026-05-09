/**
 * Telemetria dos Mapas de Jornada (FLUX-11).
 *
 * Comportamento estritamente opt-in:
 *   - Default: `false`. Nada é registrado nem enviado.
 *   - Quando `true`: registros locais em `chrome.storage.local`,
 *     somente metadata (tipo do evento, timestamp, ids agregados),
 *     SEM conteúdo do processo, SEM número de processo, SEM PII.
 *   - Nunca envia a backend até acordo formal com a SETIC.
 *
 * Decisão owner em 2026-05-06: "Deixe pronto, mas ainda não temos um
 * acordo." → mantemos pronto + desligado por default.
 */

import { STORAGE_KEYS } from './constants';

export type EventoTipo =
  | 'pagina_carregada'
  | 'mapa_aberto'
  | 'agrupamento_clicado'
  | 'estacao_aberta'
  | 'palette_aberta'
  | 'palette_busca'
  | 'catalogo_aberto'
  | 'catalogo_filtro'
  | 'modo_tecnico_toggled'
  | 'imprimir_clicado'
  | 'consultor_aberto_da_estacao';

export interface EventoTelemetria {
  /** Timestamp em ms desde epoch. */
  ts: number;
  tipo: EventoTipo;
  /** Lane visualizada na hora do evento. */
  lane?: 'jef' | 'ef' | 'comum';
  /** Código do fluxo, agrupamento ou trilha (curto, sem PII). */
  alvo?: string;
  /** Para `palette_busca`: comprimento do termo digitado (NUNCA o termo
   * em si, para não vazar dado de processo). */
  buscaLen?: number;
}

const MAX_EVENTOS = 500;

/** Lê a flag do opt-in. Default = false. Falha graciosamente. */
export async function getOptIn(): Promise<boolean> {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEYS.JORNADAS_TELEMETRIA_OPT_IN);
    return Boolean(r?.[STORAGE_KEYS.JORNADAS_TELEMETRIA_OPT_IN]);
  } catch {
    return false;
  }
}

export async function setOptIn(valor: boolean): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.JORNADAS_TELEMETRIA_OPT_IN]: Boolean(valor)
  });
  // Quando desligado, NÃO apagamos os dados — quem desligou pode querer
  // exportar primeiro. Há `limparEventos()` separado.
}

/**
 * Registra um evento. No-op se opt-in OFF. Truncamento circular:
 * mantém os últimos MAX_EVENTOS para não inflar storage.local.
 */
export async function registrarEvento(evento: Omit<EventoTelemetria, 'ts'>): Promise<void> {
  if (!(await getOptIn())) return;
  const completo: EventoTelemetria = { ts: Date.now(), ...evento };
  const atuais = await getEventos();
  const novos = [...atuais, completo].slice(-MAX_EVENTOS);
  await chrome.storage.local.set({ [STORAGE_KEYS.JORNADAS_TELEMETRIA_DADOS]: novos });
}

export async function getEventos(): Promise<EventoTelemetria[]> {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEYS.JORNADAS_TELEMETRIA_DADOS);
    const lista = r?.[STORAGE_KEYS.JORNADAS_TELEMETRIA_DADOS];
    return Array.isArray(lista) ? (lista as EventoTelemetria[]) : [];
  } catch {
    return [];
  }
}

export async function limparEventos(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.JORNADAS_TELEMETRIA_DADOS);
}

/**
 * Helper síncrono que dispara `registrarEvento` em fire-and-forget.
 * Adequado para handlers de UI (não bloqueia o event loop).
 */
export function registrar(evento: Omit<EventoTelemetria, 'ts'>): void {
  void registrarEvento(evento).catch(() => {
    /* opt-in pode estar OFF ou storage indisponível — silencioso por design */
  });
}
