/**
 * Persistência local dos modelos de minuta usados pelo RAG.
 *
 * Estrutura (IndexedDB, banco `paidegua.templates`, versão 1):
 *
 *   Object store `meta`        — keyPath 'key'
 *     - { key: 'directory',   value: { handle, name, configuredAt } }
 *     - (futuro) { key: 'embeddingsModel', value: 'Xenova/multilingual-e5-small' }
 *
 *   Object store `templates`   — keyPath 'id', autoincrement
 *     campos: id, relativePath, name, ext, size, lastModified,
 *             text, charCount, ingestedAt
 *     index 'relativePath' (unique)
 *
 *   Object store `chunks`      — keyPath 'id', autoincrement
 *     reservado para a Fase B (chunks com embeddings).
 *
 * Por que IndexedDB e não chrome.storage:
 *  - chrome.storage.local não persiste FileSystemHandle (perde a referência
 *    e a permissão entre abas/recargas).
 *  - O texto extraído pode passar de 5MB no agregado, acima do limite
 *    confortável do storage.local.
 *
 * Por que page de opções e não popup:
 *  - showDirectoryPicker exige user gesture e gera modal nativo. O popup do
 *    chrome.action fecha ao perder foco; em alguns ambientes corporativos
 *    isso interrompe o fluxo. Página de opções (aba dedicada) é estável e
 *    permite barra de progresso longa (relevante na Fase B).
 */

import { LOG_PREFIX } from './constants';

export const TEMPLATES_DB_NAME = 'paidegua.templates';
export const TEMPLATES_DB_VERSION = 1;

export const TEMPLATES_STORES = {
  META: 'meta',
  TEMPLATES: 'templates',
  CHUNKS: 'chunks'
} as const;

/** Metadados do diretório raiz configurado pelo usuário. */
export interface DirectoryMeta {
  /** FileSystemDirectoryHandle persistido (estruturado-clonável no IDB). */
  handle: FileSystemDirectoryHandle;
  /** Nome legível para exibir na UI. */
  name: string;
  /** Timestamp ISO da última (re)configuração. */
  configuredAt: string;
}

/** Registro de um modelo já ingerido. */
export interface TemplateRecord {
  id?: number;
  /** Caminho relativo à pasta raiz, ex.: "procedente/sentenca.docx". */
  relativePath: string;
  /** Nome do arquivo apenas. */
  name: string;
  /** Extensão sem ponto, lowercase. */
  ext: string;
  size: number;
  lastModified: number;
  /** Texto puro extraído (já normalizado). */
  text: string;
  charCount: number;
  /** Timestamp ISO da ingestão. */
  ingestedAt: string;
}

/** Abre (e migra) o IndexedDB de templates. */
export function openTemplatesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TEMPLATES_DB_NAME, TEMPLATES_DB_VERSION);

    req.onupgradeneeded = (): void => {
      const db = req.result;

      if (!db.objectStoreNames.contains(TEMPLATES_STORES.META)) {
        db.createObjectStore(TEMPLATES_STORES.META, { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains(TEMPLATES_STORES.TEMPLATES)) {
        const store = db.createObjectStore(TEMPLATES_STORES.TEMPLATES, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('relativePath', 'relativePath', { unique: true });
      }

      if (!db.objectStoreNames.contains(TEMPLATES_STORES.CHUNKS)) {
        const store = db.createObjectStore(TEMPLATES_STORES.CHUNKS, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('templateId', 'templateId', { unique: false });
      }
    };

    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('Falha ao abrir IndexedDB de templates'));
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
    t.onerror = (): void => reject(t.error ?? new Error('IndexedDB transaction failed'));
    t.onabort = (): void => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

// ─────────────────────────── meta (directory) ───────────────────────────

export async function saveDirectoryMeta(meta: DirectoryMeta): Promise<void> {
  const db = await openTemplatesDb();
  try {
    const t = tx(db, TEMPLATES_STORES.META, 'readwrite');
    t.objectStore(TEMPLATES_STORES.META).put({ key: 'directory', value: meta });
    await awaitTx(t);
  } finally {
    db.close();
  }
}

export async function loadDirectoryMeta(): Promise<DirectoryMeta | null> {
  const db = await openTemplatesDb();
  try {
    const t = tx(db, TEMPLATES_STORES.META, 'readonly');
    const store = t.objectStore(TEMPLATES_STORES.META);
    const row = (await reqAsPromise(store.get('directory'))) as
      | { key: string; value: DirectoryMeta }
      | undefined;
    return row?.value ?? null;
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} loadDirectoryMeta:`, error);
    return null;
  } finally {
    db.close();
  }
}

export async function clearDirectoryMeta(): Promise<void> {
  const db = await openTemplatesDb();
  try {
    const t = tx(db, TEMPLATES_STORES.META, 'readwrite');
    t.objectStore(TEMPLATES_STORES.META).delete('directory');
    await awaitTx(t);
  } finally {
    db.close();
  }
}

// ─────────────────────────── templates ───────────────────────────

export async function clearAllTemplates(): Promise<void> {
  const db = await openTemplatesDb();
  try {
    const t = tx(db, [TEMPLATES_STORES.TEMPLATES, TEMPLATES_STORES.CHUNKS], 'readwrite');
    t.objectStore(TEMPLATES_STORES.TEMPLATES).clear();
    t.objectStore(TEMPLATES_STORES.CHUNKS).clear();
    await awaitTx(t);
  } finally {
    db.close();
  }
}

export async function saveTemplates(records: TemplateRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openTemplatesDb();
  try {
    const t = tx(db, TEMPLATES_STORES.TEMPLATES, 'readwrite');
    const store = t.objectStore(TEMPLATES_STORES.TEMPLATES);
    for (const r of records) {
      store.put(r);
    }
    await awaitTx(t);
  } finally {
    db.close();
  }
}

export async function listTemplates(): Promise<TemplateRecord[]> {
  const db = await openTemplatesDb();
  try {
    const t = tx(db, TEMPLATES_STORES.TEMPLATES, 'readonly');
    const store = t.objectStore(TEMPLATES_STORES.TEMPLATES);
    const all = (await reqAsPromise(store.getAll())) as TemplateRecord[];
    return all;
  } finally {
    db.close();
  }
}

export async function countTemplates(): Promise<number> {
  const db = await openTemplatesDb();
  try {
    const t = tx(db, TEMPLATES_STORES.TEMPLATES, 'readonly');
    const store = t.objectStore(TEMPLATES_STORES.TEMPLATES);
    return (await reqAsPromise(store.count())) as number;
  } finally {
    db.close();
  }
}