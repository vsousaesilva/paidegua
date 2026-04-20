/**
 * Checkpoints persistentes da varredura "Prazos na Fita".
 *
 * Unidades de 10k-20k processos podem demorar 10-15 minutos mesmo com
 * concorrencia alta. Se o Chrome fechar, se o token Keycloak expirar
 * sem ser renovado em 60s, ou se o usuario cancelar a aba — sem
 * checkpoint, todo o trabalho anterior e perdido.
 *
 * Persistencia: IndexedDB (`paidegua.prazosFitaScanState`, store `states`)
 * keyado por `scanId`. Migramos de `chrome.storage.local` porque este
 * ultimo tem teto fixo de 10 MB — em varreduras grandes (visto em 2335
 * processos), o checkpoint estoura com `Resource::kQuotaBytes quota
 * exceeded`, a escrita passa a falhar silenciosamente e a varredura
 * para. IDB nao tem esse teto fixo; quota e proporcional ao disco.
 *
 * API publica preservada:
 *   - `computeScanId` deriva um id deterministico de (host, nomes,
 *     filtros). Relancar a mesma selecao reaproveita o checkpoint.
 *   - `salvarEstado`/`lerEstado`/`apagarEstado` operam por id.
 *   - `consultarPorAssinatura` responde "existe um scan incompleto?"
 *   - `expirarAntigos` descarta checkpoints com >24h (GC oportunista).
 *
 * Conteudo: processos + expedientes ja coletados. NUNCA vai para a LLM
 * nem sai do dispositivo.
 */
import type {
  PrazosFitaScanState,
  PrazosFitaScanStateInfo
} from '../../shared/types';

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DB_NAME = 'paidegua.prazosFitaScanState';
const DB_VERSION = 1;
const STORE = 'states';

/**
 * Hash SHA-256 hex (primeiros 16 bytes) de uma string. Determinismo:
 * mesma entrada -> mesmo id em qualquer execucao. Webcrypto esta
 * disponivel em content scripts (isolated world).
 */
async function sha256Hex32(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest).slice(0, 16);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function computeScanId(params: {
  host: string;
  nomes: string[];
  filtros: {
    diasMinNaTarefa: number | null;
    maxProcessosTotal: number | null;
  };
}): Promise<string> {
  const nomesOrdenados = [...params.nomes].map((n) => n.trim()).sort();
  const payload = JSON.stringify({
    host: params.host,
    nomes: nomesOrdenados,
    dias: params.filtros.diasMinNaTarefa ?? 0,
    max: params.filtros.maxProcessosTotal ?? 0
  });
  return sha256Hex32(payload);
}

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
    req.onerror = () =>
      reject(req.error ?? new Error('Falha ao abrir o IndexedDB.'));
    req.onblocked = () =>
      reject(new Error('IndexedDB bloqueado por outra versão aberta.'));
  });
}

async function idbGet(scanId: string): Promise<PrazosFitaScanState | null> {
  const db = await openDb();
  try {
    return await new Promise<PrazosFitaScanState | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(scanId);
      req.onsuccess = () =>
        resolve((req.result as PrazosFitaScanState | undefined) ?? null);
      req.onerror = () =>
        reject(req.error ?? new Error('Falha ao ler do IndexedDB.'));
    });
  } finally {
    db.close();
  }
}

async function idbPut(state: PrazosFitaScanState): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, state.scanId);
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

async function idbDelete(scanId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(scanId);
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

/**
 * Itera todos os states via cursor. Para GC: nao carrega tudo em
 * memoria de uma so vez — inspeciona `updatedAt` por registro e apaga
 * na mesma transacao os expirados.
 */
async function idbExpireOld(ttlMs: number): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      const agora = Date.now();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const v = cur.value as PrazosFitaScanState | undefined;
        if (!v || typeof v.updatedAt !== 'number' || agora - v.updatedAt > ttlMs) {
          cur.delete();
        }
        cur.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('Falha ao expirar states no IndexedDB.'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('Transação de expiração abortada.'));
    });
  } finally {
    db.close();
  }
}

/**
 * Le um checkpoint pelo id. Retorna null se nao existir ou estiver
 * expirado (apaga o expirado de passagem).
 */
export async function lerEstado(
  scanId: string
): Promise<PrazosFitaScanState | null> {
  try {
    const raw = await idbGet(scanId);
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.updatedAt !== 'number' || Date.now() - raw.updatedAt > TTL_MS) {
      await idbDelete(scanId).catch(() => {});
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function salvarEstado(state: PrazosFitaScanState): Promise<void> {
  try {
    await idbPut(state);
  } catch (err) {
    console.warn('[pAIdegua] salvarEstado falhou:', err);
  }
}

export async function apagarEstado(scanId: string): Promise<void> {
  try {
    await idbDelete(scanId);
  } catch (err) {
    console.warn('[pAIdegua] apagarEstado falhou:', err);
  }
}

/**
 * Limpeza unica dos checkpoints legados que ficaram em
 * `chrome.storage.local` antes da migracao para IndexedDB. Best-effort:
 * um erro aqui nao aborta o fluxo. Roda dentro de `expirarAntigos`, que
 * ja e oportunista.
 */
const LEGACY_LOCAL_PREFIX = 'paidegua.prazosFita.scanState.';
async function limparLegadoChromeLocal(): Promise<void> {
  try {
    const all = await chrome.storage.local.get(null);
    const paraApagar: string[] = [];
    for (const k of Object.keys(all)) {
      if (k.startsWith(LEGACY_LOCAL_PREFIX)) paraApagar.push(k);
    }
    if (paraApagar.length > 0) {
      await chrome.storage.local.remove(paraApagar);
    }
  } catch {
    // sem logs — legado pode nao existir; ausencia e esperada.
  }
}

/**
 * Remove checkpoints com updatedAt > TTL_MS. Chamado no inicio de
 * qualquer consulta por assinatura — GC oportunista, sem job dedicado.
 */
export async function expirarAntigos(): Promise<void> {
  try {
    await idbExpireOld(TTL_MS);
  } catch (err) {
    console.warn('[pAIdegua] expirarAntigos falhou:', err);
  }
  await limparLegadoChromeLocal();
}

/**
 * Consulta a existencia de um checkpoint compativel com a assinatura
 * informada. Usada pela aba-painel no clique de "Iniciar varredura":
 * se houver state, pergunta ao usuario se deseja retomar.
 */
export async function consultarPorAssinatura(params: {
  host: string;
  nomes: string[];
  filtros: {
    diasMinNaTarefa: number | null;
    maxProcessosTotal: number | null;
  };
}): Promise<PrazosFitaScanStateInfo> {
  await expirarAntigos();
  const scanId = await computeScanId(params);
  const st = await lerEstado(scanId);
  if (!st) return { hasState: false };
  const concluidos = st.consolidados.filter((c) => c != null).length;
  const total = st.unicos.length;
  if (total > 0 && concluidos >= total) {
    // checkpoint saturado (nao deveria ocorrer — o coordinator apaga
    // no sucesso) — trata como ausente.
    await apagarEstado(scanId);
    return { hasState: false };
  }
  return {
    hasState: true,
    scanId,
    concluidos,
    total,
    startedAt: st.startedAt,
    updatedAt: st.updatedAt
  };
}
