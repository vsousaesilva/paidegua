/**
 * Persistência do Painel Gerencial em IndexedDB.
 *
 * Por que IndexedDB e não `chrome.storage.session`? A quota de
 * `storage.session` é fixa em 10 MB e estoura em unidades com muitos
 * processos (já confirmado em 8.4k processos). IndexedDB não tem esse
 * limite fixo — a quota prática é proporcional ao disco livre, bem mais
 * do que precisamos aqui.
 *
 * Decisão LGPD explícita: o IndexedDB persiste em disco no perfil do
 * Chrome (`%LocalAppData%\…\IndexedDB\chrome-extension_<id>_…`). Para
 * preservar a mesma postura de "dados do painel não ficam em disco
 * depois da sessão" que tínhamos com `storage.session`, esta camada é
 * limpa explicitamente em três gatilhos:
 *
 *   1. `chrome.runtime.onStartup` — ao iniciar o Chrome, apaga qualquer
 *      resíduo da sessão anterior.
 *   2. `pagehide` da aba do dashboard — usuário fecha a aba, o dashboard
 *      avisa o background e o background apaga.
 *   3. Nova coleta — `put` sobrescreve, então a varredura antiga nunca
 *      sobrevive à nova.
 *
 * Tanto o background (service worker) quanto a página do dashboard
 * acessam o mesmo banco por compartilharem a origem
 * `chrome-extension://<id>/`.
 */

import type { GestaoDashboardPayload } from './types';
import type { TriagemPayloadAnon } from './triagem-anonymize';

const DB_NAME = 'paidegua.gestao';
const DB_VERSION = 1;
const STORE = 'payloads';

const KEY_DASHBOARD = 'dashboardPayload';
const KEY_ANON = 'dashboardPayloadAnon';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Falha ao abrir o IndexedDB.'));
    req.onblocked = () => reject(new Error('IndexedDB bloqueado por outra versão aberta.'));
  });
}

async function idbPut<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('Falha ao gravar no IndexedDB.'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('Transação do IndexedDB abortada.'));
    });
  } finally {
    db.close();
  }
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () =>
        reject(req.error ?? new Error('Falha ao ler do IndexedDB.'));
    });
  } finally {
    db.close();
  }
}

async function idbDelete(keys: string[]): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const k of keys) store.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('Falha ao apagar no IndexedDB.'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('Transação de delete abortada.'));
    });
  } finally {
    db.close();
  }
}

export async function saveGestaoPayloads(
  dashboard: GestaoDashboardPayload,
  anon: TriagemPayloadAnon
): Promise<void> {
  await idbPut(KEY_DASHBOARD, dashboard);
  await idbPut(KEY_ANON, anon);
}

export async function loadGestaoDashboardPayload(): Promise<GestaoDashboardPayload | null> {
  return idbGet<GestaoDashboardPayload>(KEY_DASHBOARD);
}

export async function loadGestaoAnonPayload(): Promise<TriagemPayloadAnon | null> {
  return idbGet<TriagemPayloadAnon>(KEY_ANON);
}

export async function clearGestaoPayloads(): Promise<void> {
  await idbDelete([KEY_DASHBOARD, KEY_ANON]);
}
