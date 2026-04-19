/**
 * Persistência local do catálogo de etiquetas do PJe usado pela feature
 * "Etiquetas Inteligentes" (Triagem Inteligente → botão Inserir etiquetas
 * mágicas).
 *
 * Estrutura (IndexedDB, banco `paidegua.etiquetas`, versão 1):
 *
 *   Object store `meta`          — keyPath 'key'
 *     - { key: 'catalog', value: { lastFetchedAt, count, ojLocalizacao? } }
 *
 *   Object store `etiquetas`     — keyPath 'id'
 *     campos: id, nomeTag, nomeTagCompleto, favorita, possuiFilhos,
 *             idTagFavorita?, descricao?, ingestedAt
 *     index 'nomeTag' (non-unique; podem existir homônimos com ids distintos)
 *     index 'favorita'
 *
 *   Object store `sugestionaveis` — keyPath 'idTag'
 *     campos: idTag, addedAt
 *     Usado pela tela de opções — usuário escolhe em "coluna A" quais
 *     etiquetas o de-para deve considerar (subset menor, reduz ruído no
 *     BM25).
 *
 * Por que IndexedDB:
 *  - `chrome.storage.local` tem quota pequena (~5MB no pior cenário) e o
 *    catálogo pode ter milhares de itens.
 *  - Precisamos de lookup por id rápido na hora da aplicação da etiqueta
 *    ao processo (o POST exige `tag: nomeTag` mas o id resolve ambiguidade
 *    entre homônimos).
 *
 * Por que id como keyPath (não nomeTag):
 *  - O backend do PJe permite etiquetas com o mesmo `nomeTag` em ids
 *    distintos (ex.: "2025 - vigilante" com id 277271 e 266967). Usar
 *    `id` evita colisão no store e mantém a origem íntegra para reindex.
 */

import { LOG_PREFIX } from './constants';

export const ETIQUETAS_DB_NAME = 'paidegua.etiquetas';
export const ETIQUETAS_DB_VERSION = 1;

export const ETIQUETAS_STORES = {
  META: 'meta',
  ETIQUETAS: 'etiquetas',
  SUGESTIONAVEIS: 'sugestionaveis'
} as const;

/** Metadados do catálogo persistido. */
export interface EtiquetasCatalogMeta {
  /** Timestamp ISO da última busca completa do catálogo. */
  lastFetchedAt: string;
  /** Quantidade total de etiquetas armazenadas após a busca. */
  count: number;
  /** OJ/localização do usuário no momento da busca (para auditoria). */
  ojLocalizacao?: string | null;
}

/** Registro de uma etiqueta vinda do PJe. */
export interface EtiquetaRecord {
  /** `id` do PJe (idTag/idProcessoTag). Chave primária do store. */
  id: number;
  /** Nome exibido na UI do PJe. */
  nomeTag: string;
  /** Nome hierárquico completo (ex.: "Raiz > Subgrupo > Tag"). */
  nomeTagCompleto: string;
  /** Se o usuário marcou como favorita no PJe. */
  favorita: boolean;
  /** Se a etiqueta tem filhos (é agrupadora). */
  possuiFilhos: boolean;
  /** Quando favorita, o PJe devolve um apelido/id auxiliar — preservamos. */
  idTagFavorita?: number | null;
  /** Descrição opcional (não vem da API; reservada para enriquecimento). */
  descricao?: string | null;
  /** Timestamp ISO da ingestão. */
  ingestedAt: string;
}

/** Registro de etiqueta marcada como "sugestionável" pelo usuário. */
export interface EtiquetaSugestionavel {
  /** FK para `EtiquetaRecord.id`. */
  idTag: number;
  /** Timestamp ISO da marcação. */
  addedAt: string;
}

/** Abre (e migra) o IndexedDB do catálogo de etiquetas. */
export function openEtiquetasDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ETIQUETAS_DB_NAME, ETIQUETAS_DB_VERSION);

    req.onupgradeneeded = (): void => {
      const db = req.result;

      if (!db.objectStoreNames.contains(ETIQUETAS_STORES.META)) {
        db.createObjectStore(ETIQUETAS_STORES.META, { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains(ETIQUETAS_STORES.ETIQUETAS)) {
        const store = db.createObjectStore(ETIQUETAS_STORES.ETIQUETAS, {
          keyPath: 'id'
        });
        store.createIndex('nomeTag', 'nomeTag', { unique: false });
        store.createIndex('favorita', 'favorita', { unique: false });
      }

      if (!db.objectStoreNames.contains(ETIQUETAS_STORES.SUGESTIONAVEIS)) {
        db.createObjectStore(ETIQUETAS_STORES.SUGESTIONAVEIS, {
          keyPath: 'idTag'
        });
      }
    };

    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void =>
      reject(req.error ?? new Error('Falha ao abrir IndexedDB de etiquetas'));
  });
}

function tx(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode
): IDBTransaction {
  return db.transaction(stores, mode);
}

function awaitTx(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = (): void => resolve();
    t.onerror = (): void =>
      reject(t.error ?? new Error('IndexedDB transaction failed'));
    t.onabort = (): void =>
      reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void =>
      reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

// ─────────────────────────── meta (catalog) ───────────────────────────

export async function saveCatalogMeta(meta: EtiquetasCatalogMeta): Promise<void> {
  const db = await openEtiquetasDb();
  try {
    const t = tx(db, ETIQUETAS_STORES.META, 'readwrite');
    t.objectStore(ETIQUETAS_STORES.META).put({ key: 'catalog', value: meta });
    await awaitTx(t);
  } finally {
    db.close();
  }
}

export async function loadCatalogMeta(): Promise<EtiquetasCatalogMeta | null> {
  const db = await openEtiquetasDb();
  try {
    const t = tx(db, ETIQUETAS_STORES.META, 'readonly');
    const store = t.objectStore(ETIQUETAS_STORES.META);
    const row = (await reqAsPromise(store.get('catalog'))) as
      | { key: string; value: EtiquetasCatalogMeta }
      | undefined;
    return row?.value ?? null;
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} loadCatalogMeta:`, error);
    return null;
  } finally {
    db.close();
  }
}

export async function clearCatalogMeta(): Promise<void> {
  const db = await openEtiquetasDb();
  try {
    const t = tx(db, ETIQUETAS_STORES.META, 'readwrite');
    t.objectStore(ETIQUETAS_STORES.META).delete('catalog');
    await awaitTx(t);
  } finally {
    db.close();
  }
}

// ─────────────────────────── etiquetas ───────────────────────────

export async function clearAllEtiquetas(): Promise<void> {
  const db = await openEtiquetasDb();
  try {
    const t = tx(
      db,
      [ETIQUETAS_STORES.ETIQUETAS, ETIQUETAS_STORES.SUGESTIONAVEIS],
      'readwrite'
    );
    t.objectStore(ETIQUETAS_STORES.ETIQUETAS).clear();
    // Limpamos "sugestionaveis" junto porque os ids ficam órfãos quando o
    // catálogo é recriado. Reindexar é um gesto explícito; se o usuário
    // quiser preservar a seleção, deve exportar antes (feature futura).
    t.objectStore(ETIQUETAS_STORES.SUGESTIONAVEIS).clear();
    await awaitTx(t);
  } finally {
    db.close();
  }
}

export async function saveEtiquetas(records: EtiquetaRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openEtiquetasDb();
  try {
    const t = tx(db, ETIQUETAS_STORES.ETIQUETAS, 'readwrite');
    const store = t.objectStore(ETIQUETAS_STORES.ETIQUETAS);
    for (const r of records) {
      store.put(r);
    }
    await awaitTx(t);
  } finally {
    db.close();
  }
}

export async function listEtiquetas(): Promise<EtiquetaRecord[]> {
  const db = await openEtiquetasDb();
  try {
    const t = tx(db, ETIQUETAS_STORES.ETIQUETAS, 'readonly');
    const store = t.objectStore(ETIQUETAS_STORES.ETIQUETAS);
    const all = (await reqAsPromise(store.getAll())) as EtiquetaRecord[];
    return all;
  } finally {
    db.close();
  }
}

export async function countEtiquetas(): Promise<number> {
  const db = await openEtiquetasDb();
  try {
    const t = tx(db, ETIQUETAS_STORES.ETIQUETAS, 'readonly');
    const store = t.objectStore(ETIQUETAS_STORES.ETIQUETAS);
    return (await reqAsPromise(store.count())) as number;
  } finally {
    db.close();
  }
}

// ─────────────────────────── sugestionaveis ───────────────────────────

/** Substitui integralmente a lista de sugestionáveis pela nova seleção. */
export async function replaceSugestionaveis(ids: number[]): Promise<void> {
  const db = await openEtiquetasDb();
  try {
    const t = tx(db, ETIQUETAS_STORES.SUGESTIONAVEIS, 'readwrite');
    const store = t.objectStore(ETIQUETAS_STORES.SUGESTIONAVEIS);
    store.clear();
    const now = new Date().toISOString();
    for (const id of ids) {
      store.put({ idTag: id, addedAt: now });
    }
    await awaitTx(t);
  } finally {
    db.close();
  }
}

export async function listSugestionaveis(): Promise<EtiquetaSugestionavel[]> {
  const db = await openEtiquetasDb();
  try {
    const t = tx(db, ETIQUETAS_STORES.SUGESTIONAVEIS, 'readonly');
    const store = t.objectStore(ETIQUETAS_STORES.SUGESTIONAVEIS);
    const all = (await reqAsPromise(
      store.getAll()
    )) as EtiquetaSugestionavel[];
    return all;
  } finally {
    db.close();
  }
}

export async function countSugestionaveis(): Promise<number> {
  const db = await openEtiquetasDb();
  try {
    const t = tx(db, ETIQUETAS_STORES.SUGESTIONAVEIS, 'readonly');
    const store = t.objectStore(ETIQUETAS_STORES.SUGESTIONAVEIS);
    return (await reqAsPromise(store.count())) as number;
  } finally {
    db.close();
  }
}
