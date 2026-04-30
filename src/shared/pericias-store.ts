/**
 * Store de peritos da feature "Perícias pAIdegua" (perfil Secretaria).
 *
 * Persistência em `chrome.storage.local` sob a chave
 * `STORAGE_KEYS.PERICIAS_PERITOS`. O formato é versionado via
 * `PericiaPeritosStore.version` para tolerar migrações futuras.
 *
 * Fluxos de uso:
 *   - Popup / aba "Perícias": CRUD completo.
 *   - Content script (ao abrir o painel): leitura do snapshot de peritos
 *     ativos para alimentar a aba-painel (via `listPeritosAtivos`).
 *   - Dashboard: leitura no payload já gravado; não toca o store.
 *
 * Convenções:
 *   - `id` gerado com `crypto.randomUUID` (disponível em service worker,
 *     content script e popup em MV3/Chrome 92+).
 *   - Campos `criadoEm` / `atualizadoEm` em ISO 8601.
 *   - `etiquetas` precisa ter ao menos 1 item para o perito aparecer como
 *     ativo — a validação é feita pelo chamador (popup/UI); o store
 *     apenas grava o que recebe.
 */

import { STORAGE_KEYS } from './constants';
import type { PericiaPerito, PericiaPeritosStore } from './types';

function emptyStore(): PericiaPeritosStore {
  return { version: 1, peritos: [] };
}

function isStore(value: unknown): value is PericiaPeritosStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { peritos?: unknown }).peritos)
  );
}

/**
 * Lê o store do `chrome.storage.local`. Em caso de formato inválido ou
 * chave ausente, devolve um store vazio — o chamador pode gravar sem
 * se preocupar com inicialização.
 */
export async function loadPericiasStore(): Promise<PericiaPeritosStore> {
  const key = STORAGE_KEYS.PERICIAS_PERITOS;
  const raw = await chrome.storage.local.get(key);
  const value = raw?.[key];
  if (isStore(value)) return value;
  return emptyStore();
}

/**
 * Grava o store completo. Uso: export/import de configurações.
 * Sobrescreve o conteúdo atual.
 */
export async function savePericiasStore(store: PericiaPeritosStore): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.PERICIAS_PERITOS]: {
      version: 1,
      peritos: Array.isArray(store.peritos) ? store.peritos : []
    }
  });
}

/** Atalho para listar apenas peritos ativos (`ativo === true`). */
export async function listPeritosAtivos(): Promise<PericiaPerito[]> {
  const store = await loadPericiasStore();
  return store.peritos.filter((p) => p.ativo);
}

/** Lista TODOS os peritos, ativos ou não (para o CRUD na aba do popup). */
export async function listPeritos(): Promise<PericiaPerito[]> {
  const store = await loadPericiasStore();
  return [...store.peritos];
}

export type PericiaPeritoInput = Omit<
  PericiaPerito,
  'id' | 'criadoEm' | 'atualizadoEm'
>;

/** Cria um perito novo — gera `id`, `criadoEm` e `atualizadoEm`. */
export async function addPerito(
  input: PericiaPeritoInput
): Promise<PericiaPerito> {
  const now = new Date().toISOString();
  const perito: PericiaPerito = {
    ...input,
    id: crypto.randomUUID(),
    criadoEm: now,
    atualizadoEm: now
  };
  const store = await loadPericiasStore();
  store.peritos.push(perito);
  await savePericiasStore(store);
  return perito;
}

/**
 * Atualiza um perito existente por `id`. Campos ausentes em `patch`
 * ficam inalterados. `atualizadoEm` é atualizado automaticamente.
 */
export async function updatePerito(
  id: string,
  patch: Partial<PericiaPeritoInput>
): Promise<PericiaPerito | null> {
  const store = await loadPericiasStore();
  const idx = store.peritos.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const prev = store.peritos[idx];
  const next: PericiaPerito = {
    ...prev,
    ...patch,
    id: prev.id,
    criadoEm: prev.criadoEm,
    atualizadoEm: new Date().toISOString()
  };
  store.peritos[idx] = next;
  await savePericiasStore(store);
  return next;
}

/** Remove o perito com o `id` informado. Retorna true se removeu. */
export async function deletePerito(id: string): Promise<boolean> {
  const store = await loadPericiasStore();
  const before = store.peritos.length;
  store.peritos = store.peritos.filter((p) => p.id !== id);
  if (store.peritos.length === before) return false;
  await savePericiasStore(store);
  return true;
}

/**
 * Regex usado para decidir se o nome de uma tarefa do painel pertence à
 * feature Perícias. Case-insensível e tolerante a acentos na palavra
 * "Perícia" (aceita "Pericia" também). Aceita hífen Unicode (– —).
 */
const REGEX_PERICIA_DESIGNAR = /per[ií]cia\s*[-–—]\s*designar/i;
const REGEX_PERICIA_AGENDAR = /per[ií]cia\s*[-–—]\s*agendar\s+e\s+administrar/i;

export function isTarefaDePericia(nome: string): boolean {
  if (!nome) return false;
  return REGEX_PERICIA_DESIGNAR.test(nome) || REGEX_PERICIA_AGENDAR.test(nome);
}

/**
 * Monta a etiqueta canônica da pauta:
 *   - Assistente Social: "AS [NOME] DD.MM.AA" (sem distinção de gênero).
 *   - Demais profissões: "DR [NOME] DD.MM.AA" (M) / "DRA [NOME] DD.MM.AA" (F).
 * Usa a data local do navegador — ou a data passada em `quando` (data da
 * perícia escolhida pelo usuário na tela de montagem).
 */
/**
 * Catálogo acumulativo de assuntos observados nas coletas do painel.
 * Alimenta o autocomplete do campo "Assuntos preferenciais" no cadastro
 * do perito. Persistido em `chrome.storage.local` sob a chave
 * `STORAGE_KEYS.PERICIAS_ASSUNTOS_CATALOGO`. O conteúdo é apenas o texto
 * do `assuntoPrincipal` das tarefas (ex.: "Auxílio-Doença Previdenciário")
 * — não contém PII.
 */
export interface PericiasAssuntosCatalogo {
  version: 1;
  assuntos: string[];
}

function emptyCatalogoAssuntos(): PericiasAssuntosCatalogo {
  return { version: 1, assuntos: [] };
}

function isCatalogoAssuntos(value: unknown): value is PericiasAssuntosCatalogo {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { assuntos?: unknown }).assuntos)
  );
}

/** Lê o catálogo de assuntos do `chrome.storage.local`. */
export async function loadAssuntosCatalogo(): Promise<PericiasAssuntosCatalogo> {
  const key = STORAGE_KEYS.PERICIAS_ASSUNTOS_CATALOGO;
  const raw = await chrome.storage.local.get(key);
  const value = raw?.[key];
  if (isCatalogoAssuntos(value)) return value;
  return emptyCatalogoAssuntos();
}

/**
 * Adiciona novos assuntos ao catálogo preservando ordenação case-insensitive
 * e deduplicando por forma normalizada (trim + lowercase). Itens vazios são
 * ignorados. Retorna o catálogo resultante.
 */
export async function appendAssuntosCatalogo(
  novos: Iterable<string>
): Promise<PericiasAssuntosCatalogo> {
  const atual = await loadAssuntosCatalogo();
  const norm = new Map<string, string>();
  for (const a of atual.assuntos) {
    const v = a.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (!norm.has(k)) norm.set(k, v);
  }
  let mudou = false;
  for (const a of novos) {
    if (typeof a !== 'string') continue;
    const v = a.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (!norm.has(k)) {
      norm.set(k, v);
      mudou = true;
    }
  }
  const ordenado = Array.from(norm.values()).sort((a, b) =>
    a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })
  );
  const next: PericiasAssuntosCatalogo = { version: 1, assuntos: ordenado };
  if (mudou) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.PERICIAS_ASSUNTOS_CATALOGO]: next
    });
  }
  return next;
}

export function montarEtiquetaPauta(
  perito: Pick<PericiaPerito, 'genero' | 'nomeEtiquetaPauta' | 'profissao'>,
  quando: Date = new Date()
): string {
  const prefixo =
    perito.profissao === 'ASSISTENTE_SOCIAL'
      ? 'AS'
      : perito.genero === 'F'
        ? 'DRA'
        : 'DR';
  const dd = String(quando.getDate()).padStart(2, '0');
  const mm = String(quando.getMonth() + 1).padStart(2, '0');
  const aa = String(quando.getFullYear()).slice(-2);
  const nome = perito.nomeEtiquetaPauta.trim().toUpperCase();
  return `${prefixo} ${nome} ${dd}.${mm}.${aa}`;
}
