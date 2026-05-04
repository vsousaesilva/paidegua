/**
 * Banco IndexedDB do catálogo TPU/CNJ — `paidegua.tpu`.
 *
 * Por que IndexedDB e não importar `TPU_SEED` direto:
 *   - Índices em `categoria` (multiEntry), `superiorCodigoCnj`,
 *     `caminhoCodigos` (multiEntry) tornam queries do dashboard
 *     instantâneas (vs. varrer 677 entradas em memória a cada filtro).
 *   - Permite extensões locais do usuário (ex.: marcar manualmente um
 *     movimento com categoria adicional) sem reconstruir o seed.
 *   - Export/import do catálogo por arquivo JSON, espelhando o padrão do
 *     sigcrim — útil para distribuir versões customizadas entre varas.
 *
 * Banco separado de `paidegua.criminal` e `paidegua.metas-cnj` por
 * propósitos distintos: TPU é catálogo de referência (cresce raramente,
 * versionado por revisão CNJ), criminal e metas são acervos de dados de
 * processos.
 */

import { LOG_PREFIX } from './constants';
import { TPU_SEED } from './tpu-seed-data';
import type {
  MovimentoTpu,
  TpuCategoria,
  TpuOrigem,
  TpuSeedSnapshot
} from './tpu-types';

export const TPU_DB_NAME = 'paidegua.tpu';
export const TPU_DB_VERSION = 1;

export const TPU_STORES = {
  MOVIMENTOS: 'movimentos',
  META: 'meta'
} as const;

const META_KEY_SNAPSHOT_INFO = 'snapshot_info';
const META_KEY_SCHEMA_VERSION = 'schema_version';
const META_KEY_LAST_SEED = 'last_seed';

// ── Acesso ao DB ─────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TPU_DB_NAME, TPU_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(TPU_STORES.MOVIMENTOS)) {
        const store = db.createObjectStore(TPU_STORES.MOVIMENTOS, {
          keyPath: 'codigoCnj'
        });
        store.createIndex('superiorCodigoCnj', 'superiorCodigoCnj', {
          unique: false
        });
        // multiEntry: cada elemento de `caminhoCodigos` vira uma entrada
        // no índice. Permite queries "todos os descendentes de X" em
        // O(log n) ao invés de varrer o store.
        store.createIndex('caminhoCodigos', 'caminhoCodigos', {
          unique: false,
          multiEntry: true
        });
        // Índice por categoria semântica — também multiEntry porque um
        // movimento pode ter várias categorias.
        store.createIndex('categorias', 'categorias', {
          unique: false,
          multiEntry: true
        });
        store.createIndex('origem', 'origem', { unique: false });
        // Booleans não indexam de forma confiável em todos os engines IDB,
        // mas funcionam em Chromium (alvo da extensão). Useful para
        // separar "movimentos em uso hoje" do histórico.
        store.createIndex('ativo', 'ativo', { unique: false });
      }

      if (!db.objectStoreNames.contains(TPU_STORES.META)) {
        db.createObjectStore(TPU_STORES.META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('Falha ao abrir o IndexedDB tpu.'));
    req.onblocked = () =>
      reject(new Error('IndexedDB tpu bloqueado por outra versão aberta.'));
  });
}

function txError(tx: IDBTransaction, label: string): Error {
  return tx.error ?? new Error(`Falha em transação IDB tpu: ${label}`);
}

async function withTx<T>(
  stores: readonly (keyof typeof TPU_STORES)[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const storeNames = stores.map((s) => TPU_STORES[s]);
      const tx = db.transaction(storeNames, mode);
      let result: T;
      let pending = true;
      Promise.resolve(body(tx))
        .then((v) => {
          result = v;
          pending = false;
        })
        .catch((err) => {
          pending = false;
          tx.abort();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      tx.oncomplete = () => {
        if (!pending) resolve(result);
      };
      tx.onerror = () => reject(txError(tx, mode));
      tx.onabort = () =>
        reject(tx.error ?? new Error('Transação tpu abortada.'));
    });
  } finally {
    db.close();
  }
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('Falha em IDBRequest tpu.'));
  });
}

// ── Seed (popular o banco a partir de TPU_SEED) ──────────────────

/**
 * Mapeamento de categorias semânticas a aplicar sobre o seed bruto.
 * Cada arquivo de domínio (ex.: `tpu-categorias-julgamento.ts`) exporta
 * uma instância deste tipo, e `popularBanco` mescla todos antes do
 * upsert.
 *
 * Chave = `codigoCnj`; valor = lista de categorias a anexar (acumulativo
 * — um movimento pode aparecer em vários mapeamentos).
 */
export type TpuCategoriasMap = ReadonlyMap<number, readonly TpuCategoria[]>;

function mesclarCategorias(
  seed: readonly MovimentoTpu[],
  mapas: readonly TpuCategoriasMap[]
): MovimentoTpu[] {
  return seed.map((mov) => {
    const acumulado = new Set<TpuCategoria>(mov.categorias);
    for (const mapa of mapas) {
      const extras = mapa.get(mov.codigoCnj);
      if (extras) for (const c of extras) acumulado.add(c);
    }
    return { ...mov, categorias: Array.from(acumulado) };
  });
}

interface SnapshotInfoRecord {
  key: typeof META_KEY_SNAPSHOT_INFO;
  value: {
    extraidoEm: string;
    paginaPje: string;
    total: number;
    contagemPorOrigem: Record<TpuOrigem, number>;
    contagemPorStatus: { ativo: number; inativo: number };
  };
}

interface LastSeedRecord {
  key: typeof META_KEY_LAST_SEED;
  value: {
    /** ISO de quando o `popularBanco` rodou. */
    populadoEm: string;
    /** `extraidoEm` do seed usado. Permite detectar se houve atualização do seed. */
    seedExtraidoEm: string;
    /** Quantidade de mapeamentos de categoria aplicados. */
    mapeamentosAplicados: number;
  };
}

/**
 * Idempotente: popula o banco com `TPU_SEED` se vazio, OU se o seed
 * embarcado for mais novo que o último carregado. Aplica os mapeamentos
 * de categoria fornecidos antes do upsert.
 *
 * Devolve `true` quando efetivamente populou; `false` quando o banco já
 * estava em dia.
 */
export async function garantirSeed(
  mapeamentosCategorias: readonly TpuCategoriasMap[] = []
): Promise<boolean> {
  const ultimo = await lerLastSeed();
  if (ultimo && ultimo.seedExtraidoEm === TPU_SEED.extraidoEm) {
    // Verifica se a contagem bate, defensivo (banco íntegro?).
    const totalNoBanco = await contarMovimentos();
    if (totalNoBanco === TPU_SEED.total) return false;
    console.warn(
      `${LOG_PREFIX} tpu: snapshot bate mas contagem diverge ` +
        `(banco=${totalNoBanco}, seed=${TPU_SEED.total}). Repopulando.`
    );
  }

  const movimentos = mesclarCategorias(TPU_SEED.movimentos, mapeamentosCategorias);

  await withTx(['MOVIMENTOS', 'META'], 'readwrite', (tx) => {
    const movStore = tx.objectStore(TPU_STORES.MOVIMENTOS);
    movStore.clear();
    for (const m of movimentos) movStore.put(m);

    const metaStore = tx.objectStore(TPU_STORES.META);
    metaStore.put({
      key: META_KEY_SCHEMA_VERSION,
      value: TPU_DB_VERSION
    });
    metaStore.put({
      key: META_KEY_SNAPSHOT_INFO,
      value: {
        extraidoEm: TPU_SEED.extraidoEm,
        paginaPje: TPU_SEED.paginaPje,
        total: TPU_SEED.total,
        contagemPorOrigem: TPU_SEED.contagemPorOrigem,
        contagemPorStatus: TPU_SEED.contagemPorStatus
      }
    } satisfies SnapshotInfoRecord);
    metaStore.put({
      key: META_KEY_LAST_SEED,
      value: {
        populadoEm: new Date().toISOString(),
        seedExtraidoEm: TPU_SEED.extraidoEm,
        mapeamentosAplicados: mapeamentosCategorias.length
      }
    } satisfies LastSeedRecord);
  });

  console.info(
    `${LOG_PREFIX} tpu: ${movimentos.length} movimentos populados ` +
      `(${mapeamentosCategorias.length} mapeamentos de categoria aplicados).`
  );
  return true;
}

async function lerLastSeed(): Promise<LastSeedRecord['value'] | null> {
  return withTx(['META'], 'readonly', async (tx) => {
    const rec = await reqAsPromise(
      tx
        .objectStore(TPU_STORES.META)
        .get(META_KEY_LAST_SEED) as IDBRequest<LastSeedRecord | undefined>
    );
    return rec ? rec.value : null;
  });
}

async function contarMovimentos(): Promise<number> {
  return withTx(['MOVIMENTOS'], 'readonly', async (tx) => {
    return reqAsPromise(
      tx.objectStore(TPU_STORES.MOVIMENTOS).count() as IDBRequest<number>
    );
  });
}

// ── Queries ──────────────────────────────────────────────────────

export async function getMovimento(codigoCnj: number): Promise<MovimentoTpu | null> {
  return withTx(['MOVIMENTOS'], 'readonly', async (tx) => {
    const rec = await reqAsPromise(
      tx
        .objectStore(TPU_STORES.MOVIMENTOS)
        .get(codigoCnj) as IDBRequest<MovimentoTpu | undefined>
    );
    return rec ?? null;
  });
}

/**
 * Devolve todos os movimentos com a categoria fornecida — usa o índice
 * `categorias` (multiEntry) para varredura O(log n).
 */
export async function getMovimentosPorCategoria(
  categoria: TpuCategoria
): Promise<MovimentoTpu[]> {
  return withTx(['MOVIMENTOS'], 'readonly', async (tx) => {
    const idx = tx.objectStore(TPU_STORES.MOVIMENTOS).index('categorias');
    return reqAsPromise(
      idx.getAll(IDBKeyRange.only(categoria)) as IDBRequest<MovimentoTpu[]>
    );
  });
}

/**
 * Filhos diretos de um movimento na árvore TPU.
 */
export async function getFilhosDiretos(
  codigoCnj: number
): Promise<MovimentoTpu[]> {
  return withTx(['MOVIMENTOS'], 'readonly', async (tx) => {
    const idx = tx
      .objectStore(TPU_STORES.MOVIMENTOS)
      .index('superiorCodigoCnj');
    return reqAsPromise(
      idx.getAll(IDBKeyRange.only(codigoCnj)) as IDBRequest<MovimentoTpu[]>
    );
  });
}

/**
 * Todos os descendentes (em qualquer profundidade) de um movimento. Usa
 * o índice `caminhoCodigos` (multiEntry) — qualquer movimento que tenha
 * `codigoCnj` em sua hierarquia retorna.
 *
 * Inclui o próprio nó-raiz no resultado (porque ele aparece em seu
 * próprio `caminhoCodigos`). Filtre se não quiser.
 */
export async function getDescendentes(
  codigoCnj: number
): Promise<MovimentoTpu[]> {
  return withTx(['MOVIMENTOS'], 'readonly', async (tx) => {
    const idx = tx
      .objectStore(TPU_STORES.MOVIMENTOS)
      .index('caminhoCodigos');
    return reqAsPromise(
      idx.getAll(IDBKeyRange.only(codigoCnj)) as IDBRequest<MovimentoTpu[]>
    );
  });
}

/**
 * Snapshot completo do catálogo (para export ou diagnóstico). Cuidado
 * — carrega 677+ entradas na memória.
 */
export async function listAllMovimentos(): Promise<MovimentoTpu[]> {
  return withTx(['MOVIMENTOS'], 'readonly', async (tx) => {
    return reqAsPromise(
      tx.objectStore(TPU_STORES.MOVIMENTOS).getAll() as IDBRequest<MovimentoTpu[]>
    );
  });
}

/**
 * Categorias aplicadas a um movimento — atalho para o caminho mais
 * comum no detector de status (precisa só das categorias de UM código).
 */
export async function getCategoriasDe(
  codigoCnj: number
): Promise<readonly TpuCategoria[]> {
  const m = await getMovimento(codigoCnj);
  return m?.categorias ?? [];
}

// ── Export / Import ──────────────────────────────────────────────

/**
 * Snapshot exportável do banco. Mesmo shape do seed, mas com o estado
 * atual do banco (inclui categorias mescladas e quaisquer edições
 * locais do usuário).
 */
export async function exportar(): Promise<TpuSeedSnapshot> {
  const movs = await listAllMovimentos();
  movs.sort((a, b) => a.codigoCnj - b.codigoCnj);
  const totalSgt = movs.filter((m) => m.origem === 'SGT').length;
  const totalLocal = movs.length - totalSgt;
  const totalAtivo = movs.filter((m) => m.ativo).length;
  return {
    extraidoEm: new Date().toISOString(),
    paginaPje: 'export from paidegua.tpu',
    total: movs.length,
    contagemPorOrigem: { SGT: totalSgt, TRF5: totalLocal },
    contagemPorStatus: { ativo: totalAtivo, inativo: movs.length - totalAtivo },
    movimentos: movs
  };
}

/**
 * Modo de importação:
 *   - `'substituir'`: limpa o banco e carrega o conteúdo do arquivo.
 *   - `'mesclar-arquivo-vence'`: upsert — em conflito, vence o do arquivo.
 *   - `'mesclar-local-vence'`: upsert — em conflito, mantém local; arquivo
 *     só preenche o que falta.
 */
export type ModoImport =
  | 'substituir'
  | 'mesclar-arquivo-vence'
  | 'mesclar-local-vence';

export async function importar(
  snapshot: TpuSeedSnapshot,
  modo: ModoImport
): Promise<{ inseridos: number; atualizados: number; ignorados: number }> {
  let inseridos = 0;
  let atualizados = 0;
  let ignorados = 0;

  await withTx(['MOVIMENTOS', 'META'], 'readwrite', async (tx) => {
    const store = tx.objectStore(TPU_STORES.MOVIMENTOS);

    if (modo === 'substituir') {
      store.clear();
      for (const m of snapshot.movimentos) {
        store.put(m);
        inseridos++;
      }
    } else {
      for (const m of snapshot.movimentos) {
        const atual = await reqAsPromise(
          store.get(m.codigoCnj) as IDBRequest<MovimentoTpu | undefined>
        );
        if (!atual) {
          store.put(m);
          inseridos++;
          continue;
        }
        if (modo === 'mesclar-arquivo-vence') {
          // Mescla categorias acumulando; demais campos vencem do arquivo.
          const cats = new Set<TpuCategoria>([...atual.categorias, ...m.categorias]);
          store.put({ ...m, categorias: Array.from(cats) });
          atualizados++;
        } else {
          // mesclar-local-vence: mantém local; só absorve categorias novas.
          const cats = new Set<TpuCategoria>([...atual.categorias, ...m.categorias]);
          if (cats.size === atual.categorias.length) {
            ignorados++;
          } else {
            store.put({ ...atual, categorias: Array.from(cats) });
            atualizados++;
          }
        }
      }
    }

    const metaStore = tx.objectStore(TPU_STORES.META);
    metaStore.put({
      key: META_KEY_SNAPSHOT_INFO,
      value: {
        extraidoEm: snapshot.extraidoEm,
        paginaPje: snapshot.paginaPje,
        total: snapshot.total,
        contagemPorOrigem: snapshot.contagemPorOrigem,
        contagemPorStatus: snapshot.contagemPorStatus
      }
    } satisfies SnapshotInfoRecord);
  });

  console.info(
    `${LOG_PREFIX} tpu: importação (${modo}) — ` +
      `inseridos=${inseridos}, atualizados=${atualizados}, ignorados=${ignorados}.`
  );
  return { inseridos, atualizados, ignorados };
}

/**
 * Apaga todo o conteúdo. Usado por "Resetar catálogo" nas configurações
 * antes de reimportar — ou para diagnóstico.
 */
export async function apagar(): Promise<void> {
  await withTx(['MOVIMENTOS', 'META'], 'readwrite', (tx) => {
    tx.objectStore(TPU_STORES.MOVIMENTOS).clear();
    tx.objectStore(TPU_STORES.META).clear();
  });
  console.info(`${LOG_PREFIX} tpu: banco apagado.`);
}
