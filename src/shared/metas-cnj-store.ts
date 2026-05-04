/**
 * Banco IndexedDB do acervo "Controle Metas CNJ" — `paidegua.metas-cnj`.
 *
 * Persistência durável dos processos classificados quanto às Metas
 * Nacionais 2026, com chave natural `numero_processo` (CNJ) e índices
 * para o dashboard filtrar rápido por meta, status, ano de distribuição.
 *
 * Padrão arquitetural espelhado do `criminal-store.ts`:
 *   - openDb / withTx / reqAsPromise idênticos.
 *   - Upsert por chave natural preservando origem por campo.
 *   - Object store separado para metadados (config + last_sync).
 *   - Banco isolado dos demais (criminal, tpu) — propósitos distintos
 *     com ciclo de vida independente.
 *
 * O preenchimento incremental (atualizar só o que mudou via
 * `ultimo_movimento_visto`) e a mesclagem de manual vs PJe ficam neste
 * arquivo. A LÓGICA de classificação por meta e detecção de status
 * mora em outros módulos (`processo-status-detector.ts` e os helpers
 * de regras das metas — a serem criados na fase de coleta).
 */

import { LOG_PREFIX } from './constants';
import {
  defaultMetasCnjConfig,
  type MetaCnjId,
  type MetasCnjConfig,
  type MetasCnjLastSync,
  type ProcessoMetasCnj,
  type StatusProcessoMeta
} from './metas-cnj-types';

export const METAS_CNJ_DB_NAME = 'paidegua.metas-cnj';
export const METAS_CNJ_DB_VERSION = 1;

export const METAS_CNJ_STORES = {
  PROCESSOS: 'processos',
  META: 'meta'
} as const;

const META_KEY_CONFIG = 'config';
const META_KEY_LAST_SYNC = 'last_sync';
const META_KEY_SCHEMA_VERSION = 'schema_version';

// ── Acesso ao DB ─────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(METAS_CNJ_DB_NAME, METAS_CNJ_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(METAS_CNJ_STORES.PROCESSOS)) {
        const store = db.createObjectStore(METAS_CNJ_STORES.PROCESSOS, {
          keyPath: 'numero_processo'
        });
        store.createIndex('classe_sigla', 'classe_sigla', { unique: false });
        store.createIndex('ano_distribuicao', 'ano_distribuicao', {
          unique: false
        });
        store.createIndex('status', 'status', { unique: false });
        // multiEntry: cada meta em `metas_aplicaveis` vira uma entrada
        // no índice — query por meta = O(log n) ao invés de full scan.
        store.createIndex('meta_aplicavel', 'metas_aplicaveis', {
          unique: false,
          multiEntry: true
        });
        store.createIndex(
          'presente_ultima_varredura',
          'presente_ultima_varredura',
          { unique: false }
        );
        store.createIndex('id_processo_pje', 'id_processo_pje', {
          unique: false
        });
      }

      if (!db.objectStoreNames.contains(METAS_CNJ_STORES.META)) {
        db.createObjectStore(METAS_CNJ_STORES.META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('Falha ao abrir o IndexedDB metas-cnj.'));
    req.onblocked = () =>
      reject(new Error('IndexedDB metas-cnj bloqueado por outra versão aberta.'));
  });
}

function txError(tx: IDBTransaction, label: string): Error {
  return tx.error ?? new Error(`Falha em transação IDB metas-cnj: ${label}`);
}

async function withTx<T>(
  stores: readonly (keyof typeof METAS_CNJ_STORES)[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const storeNames = stores.map((s) => METAS_CNJ_STORES[s]);
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
        reject(tx.error ?? new Error('Transação metas-cnj abortada.'));
    });
  } finally {
    db.close();
  }
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('Falha em IDBRequest metas-cnj.'));
  });
}

// =====================================================================
// Config
// =====================================================================

interface ConfigRecord {
  key: typeof META_KEY_CONFIG;
  value: MetasCnjConfig;
}

export async function loadConfig(): Promise<MetasCnjConfig> {
  return withTx(['META'], 'readonly', async (tx) => {
    const rec = await reqAsPromise(
      tx
        .objectStore(METAS_CNJ_STORES.META)
        .get(META_KEY_CONFIG) as IDBRequest<ConfigRecord | undefined>
    );
    if (rec && rec.value && rec.value.schemaVersion === 1) return rec.value;
    return defaultMetasCnjConfig();
  });
}

export async function saveConfig(config: MetasCnjConfig): Promise<void> {
  await withTx(['META'], 'readwrite', (tx) => {
    tx.objectStore(METAS_CNJ_STORES.META).put({
      key: META_KEY_CONFIG,
      value: config
    } satisfies ConfigRecord);
  });
}

export async function patchConfig(
  patch: Partial<MetasCnjConfig>
): Promise<MetasCnjConfig> {
  const current = await loadConfig();
  const next: MetasCnjConfig = { ...current, ...patch, schemaVersion: 1 };
  await saveConfig(next);
  return next;
}

// =====================================================================
// Last sync
// =====================================================================

interface LastSyncRecord {
  key: typeof META_KEY_LAST_SYNC;
  value: MetasCnjLastSync;
}

export async function loadLastSync(): Promise<MetasCnjLastSync | null> {
  return withTx(['META'], 'readonly', async (tx) => {
    const rec = await reqAsPromise(
      tx
        .objectStore(METAS_CNJ_STORES.META)
        .get(META_KEY_LAST_SYNC) as IDBRequest<LastSyncRecord | undefined>
    );
    return rec ? rec.value : null;
  });
}

export async function saveLastSync(sync: MetasCnjLastSync): Promise<void> {
  await withTx(['META'], 'readwrite', (tx) => {
    tx.objectStore(METAS_CNJ_STORES.META).put({
      key: META_KEY_LAST_SYNC,
      value: sync
    } satisfies LastSyncRecord);
  });
}

// =====================================================================
// CRUD de processos
// =====================================================================

export async function getProcesso(
  numeroProcesso: string
): Promise<ProcessoMetasCnj | null> {
  return withTx(['PROCESSOS'], 'readonly', async (tx) => {
    const rec = await reqAsPromise(
      tx
        .objectStore(METAS_CNJ_STORES.PROCESSOS)
        .get(numeroProcesso) as IDBRequest<ProcessoMetasCnj | undefined>
    );
    return rec ?? null;
  });
}

/**
 * Lista TODOS os processos do acervo. O dashboard filtra em memória —
 * volume típico (centenas a poucos milhares) cabe sem problema.
 */
export async function listAllProcessos(): Promise<ProcessoMetasCnj[]> {
  return withTx(['PROCESSOS'], 'readonly', async (tx) => {
    return reqAsPromise(
      tx.objectStore(METAS_CNJ_STORES.PROCESSOS).getAll() as IDBRequest<ProcessoMetasCnj[]>
    );
  });
}

/**
 * Lista processos de uma meta específica via índice multiEntry — query
 * O(log n).
 */
export async function listProcessosPorMeta(
  meta: MetaCnjId
): Promise<ProcessoMetasCnj[]> {
  return withTx(['PROCESSOS'], 'readonly', async (tx) => {
    const idx = tx
      .objectStore(METAS_CNJ_STORES.PROCESSOS)
      .index('meta_aplicavel');
    return reqAsPromise(
      idx.getAll(IDBKeyRange.only(meta)) as IDBRequest<ProcessoMetasCnj[]>
    );
  });
}

/**
 * Lista processos por status (pendente/julgado/baixado).
 */
export async function listProcessosPorStatus(
  status: StatusProcessoMeta
): Promise<ProcessoMetasCnj[]> {
  return withTx(['PROCESSOS'], 'readonly', async (tx) => {
    const idx = tx.objectStore(METAS_CNJ_STORES.PROCESSOS).index('status');
    return reqAsPromise(
      idx.getAll(IDBKeyRange.only(status)) as IDBRequest<ProcessoMetasCnj[]>
    );
  });
}

// =====================================================================
// Upsert via varredura (preserva origem manual)
// =====================================================================

/**
 * Patch que a varredura entrega para um processo. Pode ser parcial: a
 * varredura "leve" (apenas listagem REST) não sabe `data_distribuicao`;
 * o fetch profundo dos autos preenche. O upsert mescla campo a campo.
 *
 * Campos presentes serão considerados origem `'pje'` para registro em
 * `origem_dados`. Campos que o usuário tiver editado manualmente
 * (origem `'manual'`) NÃO serão sobrescritos.
 */
export type ProcessoVarreduraPatch = Partial<
  Omit<
    ProcessoMetasCnj,
    | 'numero_processo'
    | 'capturado_em'
    | 'atualizado_em'
    | 'ultima_sincronizacao_pje'
    | 'origem_dados'
    | 'meta_override_manual'
  >
> & {
  numero_processo: string;
};

export interface UpsertOpts {
  /** ISO da varredura corrente. */
  ultimaSincronizacaoPje: string;
  /**
   * Campos cuja origem deve ser marcada como `'pje'` (sobrescrevem
   * `origem_dados`). Default: todos os campos no patch.
   */
  camposPje?: readonly string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Upsert por `numero_processo`:
 *   - Novo: insere com timestamps frescos, `presente_ultima_varredura: true`.
 *   - Existente: para cada campo no patch, sobrescreve apenas se a origem
 *     atual NÃO for `'manual'`. Acumula `origem_dados` marcando os
 *     campos sobrescritos como `'pje'`.
 *
 * Devolve `{ created: boolean, processo }`.
 */
export async function upsertProcesso(
  patch: ProcessoVarreduraPatch,
  opts: UpsertOpts
): Promise<{ created: boolean; processo: ProcessoMetasCnj }> {
  return withTx(['PROCESSOS'], 'readwrite', async (tx) => {
    const store = tx.objectStore(METAS_CNJ_STORES.PROCESSOS);
    const atual = await reqAsPromise(
      store.get(patch.numero_processo) as IDBRequest<ProcessoMetasCnj | undefined>
    );

    const camposPje = opts.camposPje ?? Object.keys(patch);

    if (!atual) {
      const novo = construirProcessoNovo(patch, opts, camposPje);
      store.put(novo);
      return { created: true, processo: novo };
    }

    const proximo = mesclarPatch(atual, patch, opts, camposPje);
    store.put(proximo);
    return { created: false, processo: proximo };
  });
}

function construirProcessoNovo(
  patch: ProcessoVarreduraPatch,
  opts: UpsertOpts,
  camposPje: readonly string[]
): ProcessoMetasCnj {
  const ts = nowIso();
  const origem_dados: Record<string, 'pje' | 'manual' | 'ia'> = {};
  for (const campo of camposPje) origem_dados[campo] = 'pje';

  return {
    // Defaults para campos não fornecidos no patch
    id_processo_pje: 0,
    id_task_instance_atual: null,
    classe_sigla: '',
    assunto_principal: null,
    polo_ativo: null,
    polo_passivo: null,
    orgao_julgador: null,
    cargo_judicial: null,
    etiquetas_pje: [],
    tarefa_origem_atual: null,
    url: null,
    data_distribuicao: null,
    data_autuacao: null,
    ano_distribuicao: null,
    metas_aplicaveis: [],
    meta_override_manual: {},
    status: 'pendente',
    origem_status: 'movimento_oficial',
    status_definido_em: ts,
    data_julgamento: null,
    data_baixa: null,
    presente_ultima_varredura: true,
    ultimo_movimento_visto: null,
    // Aplica o patch
    ...patch,
    // Carimbos (sempre vencem)
    capturado_em: ts,
    atualizado_em: ts,
    ultima_sincronizacao_pje: opts.ultimaSincronizacaoPje,
    origem_dados
  };
}

function mesclarPatch(
  atual: ProcessoMetasCnj,
  patch: ProcessoVarreduraPatch,
  opts: UpsertOpts,
  camposPje: readonly string[]
): ProcessoMetasCnj {
  const proximaOrigem: Record<string, 'pje' | 'manual' | 'ia'> = {
    ...atual.origem_dados
  };
  const proximoPatch: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(patch)) {
    if (k === 'numero_processo') continue;
    // Preserva valor manual: se a origem atual é 'manual', NÃO sobrescreve.
    if (atual.origem_dados[k] === 'manual') continue;
    proximoPatch[k] = v;
    if (camposPje.includes(k)) proximaOrigem[k] = 'pje';
  }

  return {
    ...atual,
    ...(proximoPatch as Partial<ProcessoMetasCnj>),
    atualizado_em: nowIso(),
    ultima_sincronizacao_pje: opts.ultimaSincronizacaoPje,
    origem_dados: proximaOrigem
  };
}

/**
 * Marca um processo como NÃO presente na varredura corrente. Não
 * apaga — preserva o registro com `presente_ultima_varredura: false`
 * para que o detector de status aplique a regra "inferido_sumico" na
 * próxima reclassificação.
 */
export async function marcarSumido(numeroProcesso: string): Promise<void> {
  await withTx(['PROCESSOS'], 'readwrite', async (tx) => {
    const store = tx.objectStore(METAS_CNJ_STORES.PROCESSOS);
    const atual = await reqAsPromise(
      store.get(numeroProcesso) as IDBRequest<ProcessoMetasCnj | undefined>
    );
    if (!atual) return;
    store.put({
      ...atual,
      presente_ultima_varredura: false,
      atualizado_em: nowIso()
    });
  });
}

/**
 * Marca TODOS os processos do acervo como `presente_ultima_varredura: false`.
 * Uso no início de uma nova varredura — depois cada processo capturado é
 * marcado `true` via `upsertProcesso`. Os que ficarem `false` ao fim
 * recebem reclassificação como "sumido".
 */
export async function resetarPresencaVarredura(): Promise<void> {
  await withTx(['PROCESSOS'], 'readwrite', async (tx) => {
    const store = tx.objectStore(METAS_CNJ_STORES.PROCESSOS);
    const todos = await reqAsPromise(
      store.getAll() as IDBRequest<ProcessoMetasCnj[]>
    );
    for (const p of todos) {
      store.put({ ...p, presente_ultima_varredura: false });
    }
  });
}

// =====================================================================
// Override manual de campo
// =====================================================================

/**
 * Atualiza UM campo específico do processo marcando origem `'manual'`.
 * Próximas varreduras NÃO sobrescrevem esse campo (ver `upsertProcesso`).
 */
export async function setCampoManual<K extends keyof ProcessoMetasCnj>(
  numeroProcesso: string,
  campo: K,
  valor: ProcessoMetasCnj[K]
): Promise<void> {
  await withTx(['PROCESSOS'], 'readwrite', async (tx) => {
    const store = tx.objectStore(METAS_CNJ_STORES.PROCESSOS);
    const atual = await reqAsPromise(
      store.get(numeroProcesso) as IDBRequest<ProcessoMetasCnj | undefined>
    );
    if (!atual) {
      throw new Error(`Processo ${numeroProcesso} não está no acervo.`);
    }
    store.put({
      ...atual,
      [campo]: valor,
      origem_dados: { ...atual.origem_dados, [campo as string]: 'manual' },
      atualizado_em: nowIso()
    });
  });
}

/**
 * Override manual de inclusão/exclusão em uma meta específica.
 * Sobrepõe a regra automática.
 */
export async function setOverrideMeta(
  numeroProcesso: string,
  meta: MetaCnjId,
  incluir: boolean
): Promise<void> {
  await withTx(['PROCESSOS'], 'readwrite', async (tx) => {
    const store = tx.objectStore(METAS_CNJ_STORES.PROCESSOS);
    const atual = await reqAsPromise(
      store.get(numeroProcesso) as IDBRequest<ProcessoMetasCnj | undefined>
    );
    if (!atual) {
      throw new Error(`Processo ${numeroProcesso} não está no acervo.`);
    }
    const novoOverride = { ...atual.meta_override_manual, [meta]: incluir };
    // Se incluir=true e a meta não está em metas_aplicaveis, adiciona
    let novasAplicaveis = [...atual.metas_aplicaveis];
    if (incluir && !novasAplicaveis.includes(meta)) {
      novasAplicaveis.push(meta);
    }
    if (!incluir) {
      novasAplicaveis = novasAplicaveis.filter((m) => m !== meta);
    }
    store.put({
      ...atual,
      meta_override_manual: novoOverride,
      metas_aplicaveis: novasAplicaveis,
      atualizado_em: nowIso()
    });
  });
}

// =====================================================================
// Estatísticas / diagnóstico
// =====================================================================

export interface MetasCnjStats {
  totalProcessos: number;
  porStatus: Record<StatusProcessoMeta, number>;
  porMeta: Record<MetaCnjId, { pendentes: number; julgados: number; baixados: number }>;
  presentesUltimaVarredura: number;
}

export async function getStats(): Promise<MetasCnjStats> {
  const todos = await listAllProcessos();
  const stats: MetasCnjStats = {
    totalProcessos: todos.length,
    porStatus: { pendente: 0, julgado: 0, baixado: 0 },
    porMeta: {
      'meta-2': { pendentes: 0, julgados: 0, baixados: 0 },
      'meta-4': { pendentes: 0, julgados: 0, baixados: 0 },
      'meta-6': { pendentes: 0, julgados: 0, baixados: 0 },
      'meta-7': { pendentes: 0, julgados: 0, baixados: 0 },
      'meta-10': { pendentes: 0, julgados: 0, baixados: 0 }
    },
    presentesUltimaVarredura: 0
  };
  for (const p of todos) {
    stats.porStatus[p.status] = (stats.porStatus[p.status] ?? 0) + 1;
    if (p.presente_ultima_varredura) stats.presentesUltimaVarredura++;
    for (const m of p.metas_aplicaveis) {
      const entry = stats.porMeta[m];
      if (!entry) continue;
      if (p.status === 'pendente') entry.pendentes++;
      else if (p.status === 'julgado') entry.julgados++;
      else if (p.status === 'baixado') entry.baixados++;
    }
  }
  return stats;
}

// =====================================================================
// Limpeza
// =====================================================================

/**
 * Apaga todo o acervo. Usado pelo botão "Apagar acervo de metas" nas
 * configurações. Mantém o store META se `manterConfig=true`.
 */
export async function apagarAcervo(
  opts: { manterConfig?: boolean } = {}
): Promise<void> {
  await withTx(['PROCESSOS', 'META'], 'readwrite', (tx) => {
    tx.objectStore(METAS_CNJ_STORES.PROCESSOS).clear();
    if (!opts.manterConfig) tx.objectStore(METAS_CNJ_STORES.META).clear();
  });
  console.info(
    `${LOG_PREFIX} metas-cnj: acervo apagado (manterConfig=${opts.manterConfig ?? false})`
  );
}

// Schema version handshake — não usado por enquanto, deixado para
// migrações futuras. Quando bumparmos METAS_CNJ_DB_VERSION, podemos
// gravar/ler aqui o schema_version do conteúdo para distinguir
// upgrade vs. downgrade.
export async function getSchemaVersion(): Promise<number | null> {
  return withTx(['META'], 'readonly', async (tx) => {
    const rec = await reqAsPromise(
      tx.objectStore(METAS_CNJ_STORES.META).get(META_KEY_SCHEMA_VERSION) as IDBRequest<
        { key: string; value: number } | undefined
      >
    );
    return rec ? rec.value : null;
  });
}
