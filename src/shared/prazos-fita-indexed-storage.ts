/**
 * Persistência do dashboard de "Prazos na Fita" em IndexedDB.
 *
 * Por que não `chrome.storage.session`? A quota fixa de 10 MB estoura
 * em unidades com muitos processos (já visto em 2331 processos, com
 * erro "Session storage quota bytes exceeded"). IndexedDB não tem esse
 * teto fixo — a quota prática é proporcional ao disco livre.
 *
 * Decisão LGPD: o IndexedDB persiste em disco no perfil do Chrome
 * (`%LocalAppData%\…\IndexedDB\chrome-extension_<id>_…`). Para manter a
 * mesma postura de "dados não ficam em disco após a sessão" que tínhamos
 * com `storage.session`, esta camada é limpa em três gatilhos:
 *
 *   1. `chrome.runtime.onStartup` — ao iniciar o Chrome, apaga resíduo
 *      da sessão anterior.
 *   2. `pagehide` da aba do dashboard — usuário fechou, background apaga.
 *   3. Nova coleta — o `initPrazosFitaDashboardStream` zera tudo antes
 *      de gravar o novo meta.
 *
 * Tanto o background (service worker) quanto a página do dashboard
 * acessam o mesmo banco por compartilharem `chrome-extension://<id>/`.
 *
 * Observação: usamos um DB separado do Painel Gerencial
 * (`paidegua.prazosFita`) para que `clearGestaoPayloads` e este clear
 * não interfiram um no outro.
 *
 * ─────────────────────────────────────────────────────────────────────
 * MODELO DE STREAMING (2026-04-20)
 * ─────────────────────────────────────────────────────────────────────
 * Para suportar o dashboard que abre em ~2s e recebe patches a cada
 * processo coletado, o layout dentro do objectStore `payloads` é:
 *
 *   - chave `dashboardMeta`    → metadados + status + progresso + tarefas
 *   - chave `slot:000000` ...  → um registro por processo (ordem estável
 *                                  da enumeração, zero-padded p/ sort)
 *   - chave `dashboardPayload` → LEGADO: payload completo em um único
 *                                  registro. Mantido apenas para retro-
 *                                  compat (migracao automatica em `read`).
 *
 * A API pública "legada" (`save`/`load`/`clear`) é preservada como
 * wrapper que escreve/lê o formato novo. Callers antigos continuam
 * funcionando sem alteração — ideal porque o background ainda tem
 * um handler que recebe o dashboard inteiro num único evento DONE.
 */

import type { PrazosFitaDashboardPayload } from './types';

const DB_NAME = 'paidegua.prazosFita';
const DB_VERSION = 1;
const STORE = 'payloads';

const KEY_META = 'dashboardMeta';
const KEY_LEGACY_DASHBOARD = 'dashboardPayload';
const SLOT_PREFIX = 'slot:';
const SLOT_INDEX_PAD = 6;

/** Metadado leve do stream — independente dos slots. */
interface DashboardMeta {
  geradoEm: string;
  hostnamePJe: string;
  tarefasSelecionadas: string[];
  status: 'running' | 'done' | 'aborted';
  total: number;
  consolidados: number;
  totalDescobertos: number;
  tempoTotalMs: number;
  abortadoEm?: string;
  erroAbort?: string;
}

type ConsolidadoItem =
  PrazosFitaDashboardPayload['resultado']['consolidado'][number];

function slotKey(idx: number): string {
  return SLOT_PREFIX + String(idx).padStart(SLOT_INDEX_PAD, '0');
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

/** Apaga tudo do store — usado em `clear` e no `init` do stream. */
async function idbClearAll(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('Falha no clear do IndexedDB.'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('Transação de clear abortada.'));
    });
  } finally {
    db.close();
  }
}

/**
 * Lê meta + todos os slots e reconstrói o payload completo. Usa cursor
 * com `IDBKeyRange.bound` para varrer somente `slot:*`. A ordem da
 * enumeração (zero-padded) garante estabilidade entre ressuscitações.
 */
async function idbReadStream(): Promise<PrazosFitaDashboardPayload | null> {
  const db = await openDb();
  try {
    return await new Promise<PrazosFitaDashboardPayload | null>(
      (resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const metaReq = store.get(KEY_META);
        metaReq.onerror = () =>
          reject(metaReq.error ?? new Error('Falha lendo meta.'));
        metaReq.onsuccess = () => {
          const meta = metaReq.result as DashboardMeta | undefined;
          if (!meta) {
            // Sem meta: pode haver payload legado (formato antigo).
            const legacyReq = store.get(KEY_LEGACY_DASHBOARD);
            legacyReq.onsuccess = () =>
              resolve(
                (legacyReq.result as PrazosFitaDashboardPayload | undefined) ??
                  null
              );
            legacyReq.onerror = () =>
              reject(legacyReq.error ?? new Error('Falha lendo legado.'));
            return;
          }
          const consolidado: ConsolidadoItem[] = [];
          const range = IDBKeyRange.bound(
            SLOT_PREFIX,
            SLOT_PREFIX + '\uffff',
            false,
            false
          );
          const cursorReq = store.openCursor(range);
          cursorReq.onerror = () =>
            reject(cursorReq.error ?? new Error('Falha lendo slots.'));
          cursorReq.onsuccess = () => {
            const c = cursorReq.result;
            if (c) {
              const v = c.value as ConsolidadoItem | undefined;
              if (v) consolidado.push(v);
              c.continue();
              return;
            }
            resolve({
              geradoEm: meta.geradoEm,
              hostnamePJe: meta.hostnamePJe,
              tarefasSelecionadas: meta.tarefasSelecionadas,
              status: meta.status,
              progresso: {
                total: meta.total,
                consolidados: meta.consolidados,
                abortadoEm: meta.abortadoEm,
                erroAbort: meta.erroAbort
              },
              resultado: {
                totalDescobertos: meta.totalDescobertos,
                tempoTotalMs: meta.tempoTotalMs,
                consolidado
              }
            });
          };
        };
      }
    );
  } finally {
    db.close();
  }
}

// ─── API DE STREAMING ────────────────────────────────────────────────

export interface InitStreamMeta {
  geradoEm: string;
  hostnamePJe: string;
  tarefasSelecionadas: string[];
  total: number;
  totalDescobertos: number;
  /**
   * Quantos slots ja estao coletados no inicio (retomada). O contador
   * `meta.consolidados` nasce com esse valor para que o card "Processos"
   * mostre `X/total` imediatamente na reabertura do dashboard, em vez
   * de comecar em 0 e subir aos poucos enquanto os slots sao reemitidos
   * pela hidratacao do checkpoint.
   */
  consolidadosInicial?: number;
}

/**
 * Marca o início de uma varredura: apaga o banco e grava o meta com
 * `status = 'running'`. O dashboard pode ler imediatamente e renderizar
 * o esqueleto (0 de N).
 */
export async function initPrazosFitaDashboardStream(
  meta: InitStreamMeta
): Promise<void> {
  await idbClearAll();
  const inicial =
    typeof meta.consolidadosInicial === 'number' && meta.consolidadosInicial > 0
      ? Math.min(meta.total, Math.floor(meta.consolidadosInicial))
      : 0;
  const record: DashboardMeta = {
    geradoEm: meta.geradoEm,
    hostnamePJe: meta.hostnamePJe,
    tarefasSelecionadas: meta.tarefasSelecionadas,
    status: 'running',
    total: meta.total,
    consolidados: inicial,
    totalDescobertos: meta.totalDescobertos,
    tempoTotalMs: 0
  };
  await idbPut(KEY_META, record);
}

/**
 * Grava um slot sem mexer no contador `meta.consolidados`. Usado durante
 * a hidratacao de retomada: na reabertura, o init ja nasce com
 * `consolidados = X` e os X slots sao reemitidos apenas para que o IDB
 * reflita o conteudo visivel na tabela do dashboard. Se incrementassemos
 * aqui, o card "Processos" subiria a X via patch — exatamente o "retoma
 * do zero" que esse caminho busca evitar.
 */
export async function hydratePrazosFitaSlot(
  idx: number,
  item: ConsolidadoItem
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put(item, slotKey(idx));
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('Falha no hydrate do slot.'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('Transação de hydrate abortada.'));
    });
  } finally {
    db.close();
  }
}

/**
 * Grava um slot individual e atualiza `consolidados` no meta. Em stream
 * longo (milhares de processos) isso gera duas writes por item — ok,
 * o coordinator já chama com throttle (checkpoint a cada 100 processos
 * no disco; no canal de streaming, cada slot vira uma mensagem).
 */
export async function patchPrazosFitaSlot(
  idx: number,
  item: ConsolidadoItem
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put(item, slotKey(idx));
      const metaReq = store.get(KEY_META);
      metaReq.onsuccess = () => {
        const meta = metaReq.result as DashboardMeta | undefined;
        if (meta) {
          meta.consolidados = Math.min(meta.total, meta.consolidados + 1);
          store.put(meta, KEY_META);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('Falha no patch do slot.'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('Transação de patch abortada.'));
    });
  } finally {
    db.close();
  }
}

export interface FinalizeStreamArgs {
  status: 'done' | 'aborted';
  tempoTotalMs: number;
  abortadoEm?: string;
  erroAbort?: string;
}

/**
 * Marca fim da varredura. Não mexe nos slots — preserva tudo que já
 * foi coletado, inclusive em abort (usuário retoma do ponto onde parou).
 */
export async function finalizePrazosFitaDashboardStream(
  args: FinalizeStreamArgs
): Promise<void> {
  const atual = await idbGet<DashboardMeta>(KEY_META);
  if (!atual) return;
  const novo: DashboardMeta = {
    ...atual,
    status: args.status,
    tempoTotalMs: args.tempoTotalMs,
    abortadoEm: args.abortadoEm,
    erroAbort: args.erroAbort
  };
  await idbPut(KEY_META, novo);
}

/**
 * Lê apenas o meta — suficiente pro dashboard consultar progresso sem
 * pagar o custo de reconstruir `consolidado`.
 */
export async function readPrazosFitaDashboardMeta(): Promise<DashboardMeta | null> {
  return idbGet<DashboardMeta>(KEY_META);
}

/**
 * Lê um slot específico — útil quando o dashboard recebe a mensagem
 * SLOT_PATCH mas ainda não carregou seu estado em memória, ou para
 * hidratar apenas a janela visível num futuro modo paginado.
 */
export async function readPrazosFitaSlot(
  idx: number
): Promise<ConsolidadoItem | null> {
  return idbGet<ConsolidadoItem>(slotKey(idx));
}

// ─── API LEGADA (compat) ─────────────────────────────────────────────

/**
 * Wrapper compat: recebe o payload inteiro e distribui em meta + slots.
 * Usado pelo caminho não-streaming do background (quando COLETA_DONE
 * chega com `dashboardPayload` completo) e por testes.
 */
export async function savePrazosFitaDashboardPayload(
  dashboard: PrazosFitaDashboardPayload
): Promise<void> {
  await idbClearAll();
  const total =
    dashboard.progresso?.total ?? dashboard.resultado.consolidado.length;
  const consolidados =
    dashboard.progresso?.consolidados ?? dashboard.resultado.consolidado.length;
  const meta: DashboardMeta = {
    geradoEm: dashboard.geradoEm,
    hostnamePJe: dashboard.hostnamePJe,
    tarefasSelecionadas: dashboard.tarefasSelecionadas,
    status: dashboard.status ?? 'done',
    total,
    consolidados,
    totalDescobertos: dashboard.resultado.totalDescobertos,
    tempoTotalMs: dashboard.resultado.tempoTotalMs,
    abortadoEm: dashboard.progresso?.abortadoEm,
    erroAbort: dashboard.progresso?.erroAbort
  };
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put(meta, KEY_META);
      dashboard.resultado.consolidado.forEach((item, idx) => {
        store.put(item, slotKey(idx));
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('Falha gravando payload legado.'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('Transação de save abortada.'));
    });
  } finally {
    db.close();
  }
}

export async function loadPrazosFitaDashboardPayload(): Promise<PrazosFitaDashboardPayload | null> {
  return idbReadStream();
}

export async function clearPrazosFitaDashboardPayload(): Promise<void> {
  await idbClearAll();
}
