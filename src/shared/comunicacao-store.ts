/**
 * Store da "Central de Comunicação" (perfil Secretaria).
 *
 * Persiste o histórico de cobranças geradas (perito por WhatsApp ou Ceab
 * por e-mail) em `chrome.storage.local` sob `STORAGE_KEYS.COMUNICACAO_REGISTROS`.
 * As configurações (e-mail Ceab, etiquetas opcionais) ficam em
 * `PAIdeguaSettings.comunicacao` — usar o getter/setter de settings padrão.
 *
 * Fornece também as regex e os helpers usados pelo coletor para identificar
 * as tarefas-alvo de cobrança (perito vs. Ceab).
 */

import { STORAGE_KEYS } from './constants';
import type {
  ComunicacaoCanal,
  ComunicacaoModo,
  ComunicacaoSettings,
  RegistroCobranca,
  RegistroCobrancaStore
} from './types';

/** Limite generoso para o ring buffer do histórico. */
const MAX_REGISTROS = 1000;

/** Tarefa-padrão para cobrar laudo do perito. */
const REGEX_TAREFA_COBRAR_LAUDO = /cobrar\s+laudo/i;

/**
 * Tarefa-padrão para cobrar a Ceab — tipicamente "Obrigação de fazer -
 * Sem manifestação". Aceita variações de hífen e espaçamento.
 */
const REGEX_TAREFA_OBRIGACAO_FAZER =
  /obriga[cç][aã]o\s+de\s+fazer.*sem\s+manifesta[cç][aã]o/i;

export function isTarefaCobrarLaudo(nome: string): boolean {
  return Boolean(nome) && REGEX_TAREFA_COBRAR_LAUDO.test(nome);
}

export function isTarefaObrigacaoFazerCeab(nome: string): boolean {
  return Boolean(nome) && REGEX_TAREFA_OBRIGACAO_FAZER.test(nome);
}

/** Settings padrão (vazias) — usadas quando nunca houve gravação. */
export function defaultComunicacaoSettings(): ComunicacaoSettings {
  return {
    nomeVara: '',
    emailCeab: '',
    telefoneCeab: '',
    etiquetaCobrancaPerito: '',
    etiquetaCobrancaCeab: ''
  };
}

// =====================================================================
// Histórico de cobranças
// =====================================================================

function emptyRegistroStore(): RegistroCobrancaStore {
  return { version: 1, registros: [] };
}

function isRegistroStore(value: unknown): value is RegistroCobrancaStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { registros?: unknown }).registros)
  );
}

export async function loadRegistros(): Promise<RegistroCobrancaStore> {
  const key = STORAGE_KEYS.COMUNICACAO_REGISTROS;
  const raw = await chrome.storage.local.get(key);
  const value = raw?.[key];
  if (isRegistroStore(value)) return value;
  return emptyRegistroStore();
}

export async function listRegistros(): Promise<RegistroCobranca[]> {
  const store = await loadRegistros();
  return [...store.registros];
}

/**
 * Adiciona um registro de cobrança ao histórico, gerando `id` e `geradoEm`
 * automaticamente. Aplica ring buffer de `MAX_REGISTROS` para evitar
 * crescimento ilimitado.
 */
export async function addRegistro(
  input: Omit<RegistroCobranca, 'id' | 'geradoEm'>
): Promise<RegistroCobranca> {
  const reg: RegistroCobranca = {
    ...input,
    id: crypto.randomUUID(),
    geradoEm: new Date().toISOString()
  };
  const store = await loadRegistros();
  const proximos = [reg, ...store.registros];
  if (proximos.length > MAX_REGISTROS) proximos.length = MAX_REGISTROS;
  await chrome.storage.local.set({
    [STORAGE_KEYS.COMUNICACAO_REGISTROS]: {
      version: 1,
      registros: proximos
    } satisfies RegistroCobrancaStore
  });
  return reg;
}

/**
 * Remove um registro pelo `id`. Devolve `true` quando algo foi removido.
 */
export async function deleteRegistro(id: string): Promise<boolean> {
  const store = await loadRegistros();
  const before = store.registros.length;
  const proximos = store.registros.filter((r) => r.id !== id);
  if (proximos.length === before) return false;
  await chrome.storage.local.set({
    [STORAGE_KEYS.COMUNICACAO_REGISTROS]: {
      version: 1,
      registros: proximos
    } satisfies RegistroCobrancaStore
  });
  return true;
}

/**
 * Lista a data ISO da cobrança mais recente para um destinatário (perito
 * ou "Ceab"). Útil para o painel mostrar "última cobrança em DD/MM/AAAA"
 * antes de o usuário acionar nova rodada.
 */
export async function ultimaCobrancaPorDestinatario(
  destinatario: string,
  modo: ComunicacaoModo,
  canal?: ComunicacaoCanal
): Promise<RegistroCobranca | null> {
  const store = await loadRegistros();
  const alvo = destinatario.trim().toLowerCase();
  for (const r of store.registros) {
    if (r.modo !== modo) continue;
    if (canal && r.canal !== canal) continue;
    if (r.destinatario.trim().toLowerCase() === alvo) return r;
  }
  return null;
}
