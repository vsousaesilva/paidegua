/**
 * Persistência local do perfil "Gestão Criminal" em IndexedDB.
 *
 * Estrutura (banco `paidegua.criminal`, versão 1):
 *
 *   Object store `processos`  — keyPath 'id'
 *     index 'numero_processo'   (unique)
 *     index 'classe_cnj'        (non-unique)
 *     index 'is_classe_primaria' (non-unique)
 *     index 'data_fato'          (non-unique)
 *
 *   Object store `reus`       — keyPath 'id'
 *     index 'processo_id'       (non-unique)
 *     index 'cpf_reu'           (non-unique)
 *     index 'status_anpp'       (non-unique)
 *
 *   Object store `meta`       — keyPath 'key'
 *     - { key: 'config', value: CriminalConfig }
 *
 * Por que IndexedDB (e não chrome.storage.local):
 *  - Volume potencial de processos (milhares) ultrapassa a quota prática
 *    de chrome.storage.local.
 *  - Filtros do dashboard (farol, SERP, ANPP, busca) ficam rápidos com
 *    índices em vez de varrer um JSON em memória.
 *  - O JSON exportado é APENAS o artefato de transporte (Fase 6) — não
 *    é como os dados são armazenados internamente.
 *
 * Por que sem cifragem em REST:
 *  - Estação institucional já gateia acesso ao perfil Chrome via login.
 *  - Coerência com peritos-store, etiquetas-store, templates-store, todos
 *    em texto puro pelo mesmo trade-off (ver crypto.ts).
 *  - Risco de senha esquecida → acervo perdido era pior do que o de leak
 *    casual, dado que o leitor casual já é barrado pelo SO.
 *  - Cifragem volta como opção no arquivo de export (Fase 6), onde o
 *    artefato sai da máquina e o risco real existe.
 */

import { LOG_PREFIX } from './constants';
import {
  emptyCriminalConfig,
  type CriminalConfig,
  type PjeOrigemMap,
  type Processo,
  type ProcessoPayload,
  type Reu,
  type ReuPayload
} from './criminal-types';
import {
  getClasseByCodigo,
  isCodigoPrimario,
  getCategoriaDoCodigo
} from './criminal-classes';

export const CRIMINAL_DB_NAME = 'paidegua.criminal';
export const CRIMINAL_DB_VERSION = 1;

export const CRIMINAL_STORES = {
  PROCESSOS: 'processos',
  REUS: 'reus',
  META: 'meta'
} as const;

const META_KEY_CONFIG = 'config';
const META_KEY_EXPORT_HANDLE = 'exportFolderHandle';

// ── Acesso ao DB ─────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CRIMINAL_DB_NAME, CRIMINAL_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(CRIMINAL_STORES.PROCESSOS)) {
        const store = db.createObjectStore(CRIMINAL_STORES.PROCESSOS, { keyPath: 'id' });
        store.createIndex('numero_processo', 'numero_processo', { unique: true });
        store.createIndex('classe_cnj', 'classe_cnj', { unique: false });
        store.createIndex('is_classe_primaria', 'is_classe_primaria', { unique: false });
        store.createIndex('data_fato', 'data_fato', { unique: false });
      }

      if (!db.objectStoreNames.contains(CRIMINAL_STORES.REUS)) {
        const store = db.createObjectStore(CRIMINAL_STORES.REUS, { keyPath: 'id' });
        store.createIndex('processo_id', 'processo_id', { unique: false });
        store.createIndex('cpf_reu', 'cpf_reu', { unique: false });
        store.createIndex('status_anpp', 'status_anpp', { unique: false });
      }

      if (!db.objectStoreNames.contains(CRIMINAL_STORES.META)) {
        db.createObjectStore(CRIMINAL_STORES.META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('Falha ao abrir o IndexedDB criminal.'));
    req.onblocked = () =>
      reject(new Error('IndexedDB criminal bloqueado por outra versão aberta.'));
  });
}

// Réus são persistidos com `processo_id` adicional (FK lógica). Um Reu
// "puro" da API pública não carrega esse campo — internamente sim.
type ReuStored = Reu & { processo_id: string };

function txError(tx: IDBTransaction, label: string): Error {
  return tx.error ?? new Error(`Falha em transação IDB criminal: ${label}`);
}

async function withTx<T>(
  stores: readonly (keyof typeof CRIMINAL_STORES)[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const storeNames = stores.map((s) => CRIMINAL_STORES[s]);
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
      tx.onabort = () => reject(tx.error ?? new Error('Transação criminal abortada.'));
    });
  } finally {
    db.close();
  }
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('Falha em IDBRequest criminal.'));
  });
}

// ── Config ───────────────────────────────────────────────────────

interface ConfigRecord {
  key: typeof META_KEY_CONFIG;
  value: CriminalConfig;
}

export async function loadCriminalConfig(): Promise<CriminalConfig> {
  return withTx(['META'], 'readonly', async (tx) => {
    const store = tx.objectStore(CRIMINAL_STORES.META);
    const rec = await reqAsPromise(store.get(META_KEY_CONFIG) as IDBRequest<ConfigRecord | undefined>);
    if (rec && rec.value && rec.value.schemaVersion === 1) return rec.value;
    return emptyCriminalConfig();
  });
}

export async function saveCriminalConfig(config: CriminalConfig): Promise<void> {
  await withTx(['META'], 'readwrite', (tx) => {
    const store = tx.objectStore(CRIMINAL_STORES.META);
    store.put({ key: META_KEY_CONFIG, value: config } satisfies ConfigRecord);
  });
}

export async function patchCriminalConfig(
  patch: Partial<CriminalConfig>
): Promise<CriminalConfig> {
  const current = await loadCriminalConfig();
  const next: CriminalConfig = { ...current, ...patch, schemaVersion: 1 };
  await saveCriminalConfig(next);
  return next;
}

// ── Pasta de auto-export (File System Access API) ────────────────

interface ExportHandleRecord {
  key: typeof META_KEY_EXPORT_HANDLE;
  value: FileSystemDirectoryHandle;
  registeredAt: string;
}

/**
 * Persiste o handle da pasta de auto-export. `chrome.storage.*` não
 * aceita FileSystemDirectoryHandle (não é serializável); IndexedDB sim,
 * via structured clone.
 */
export async function setExportFolderHandle(
  handle: FileSystemDirectoryHandle
): Promise<void> {
  await withTx(['META'], 'readwrite', (tx) => {
    tx.objectStore(CRIMINAL_STORES.META).put({
      key: META_KEY_EXPORT_HANDLE,
      value: handle,
      registeredAt: nowIso()
    } satisfies ExportHandleRecord);
  });
}

export async function getExportFolderHandle(): Promise<{
  handle: FileSystemDirectoryHandle;
  registeredAt: string;
} | null> {
  return withTx(['META'], 'readonly', async (tx) => {
    const rec = await reqAsPromise(
      tx
        .objectStore(CRIMINAL_STORES.META)
        .get(META_KEY_EXPORT_HANDLE) as IDBRequest<ExportHandleRecord | undefined>
    );
    if (!rec) return null;
    return { handle: rec.value, registeredAt: rec.registeredAt };
  });
}

export async function clearExportFolderHandle(): Promise<void> {
  await withTx(['META'], 'readwrite', (tx) => {
    tx.objectStore(CRIMINAL_STORES.META).delete(META_KEY_EXPORT_HANDLE);
  });
}

// ── Helpers de criação ───────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

function reuFromPayload(input: ReuPayload, processoId: string): ReuStored {
  const ts = nowIso();
  return {
    ...input,
    id: newId(),
    processo_id: processoId,
    pje_origem: {},
    criado_em: ts,
    atualizado_em: ts
  };
}

function processoFromPayload(input: ProcessoPayload): Processo {
  const ts = nowIso();
  const classe = getClasseByCodigo(input.classe_cnj);
  if (!classe) {
    throw new Error(
      `Classe CNJ ${input.classe_cnj} não está no catálogo criminal. ` +
        'Use isCodigoCriminal() antes de salvar.'
    );
  }
  return {
    ...input,
    id: newId(),
    classe_categoria: classe.categoria,
    is_classe_primaria: classe.isPrimaria,
    pje_origem: {},
    criado_em: ts,
    atualizado_em: ts,
    reus: []
  };
}

// ── CRUD: Processos ──────────────────────────────────────────────

/**
 * Lê um processo por id, com seus réus inline.
 */
export async function getProcessoById(id: string): Promise<Processo | null> {
  return withTx(['PROCESSOS', 'REUS'], 'readonly', async (tx) => {
    const proc = (await reqAsPromise(
      tx.objectStore(CRIMINAL_STORES.PROCESSOS).get(id) as IDBRequest<Processo | undefined>
    )) ?? null;
    if (!proc) return null;
    const reus = await getReusOfProcesso(tx, id);
    return { ...proc, reus };
  });
}

/**
 * Lê um processo pelo número CNJ. Conveniência para o coordinator (chave
 * natural na API do PJe).
 */
export async function getProcessoByNumero(numero: string): Promise<Processo | null> {
  return withTx(['PROCESSOS', 'REUS'], 'readonly', async (tx) => {
    const idx = tx.objectStore(CRIMINAL_STORES.PROCESSOS).index('numero_processo');
    const proc = (await reqAsPromise(
      idx.get(numero) as IDBRequest<Processo | undefined>
    )) ?? null;
    if (!proc) return null;
    const reus = await getReusOfProcesso(tx, proc.id);
    return { ...proc, reus };
  });
}

/**
 * Lista todos os processos (com réus inline). Usado pelo dashboard.
 * Aplicar filtros depois — o volume esperado por vara não justifica
 * paginação no store; o sigcrim original também carrega tudo.
 */
export async function listAllProcessos(): Promise<Processo[]> {
  return withTx(['PROCESSOS', 'REUS'], 'readonly', async (tx) => {
    const procs = await reqAsPromise(
      tx.objectStore(CRIMINAL_STORES.PROCESSOS).getAll() as IDBRequest<Processo[]>
    );
    const reusAll = await reqAsPromise(
      tx.objectStore(CRIMINAL_STORES.REUS).getAll() as IDBRequest<ReuStored[]>
    );
    const reusByProc = new Map<string, Reu[]>();
    for (const r of reusAll) {
      const list = reusByProc.get(r.processo_id) ?? [];
      const { processo_id: _omit, ...reu } = r;
      list.push(reu);
      reusByProc.set(r.processo_id, list);
    }
    return procs.map((p) => ({ ...p, reus: reusByProc.get(p.id) ?? [] }));
  });
}

/**
 * Lista apenas processos primários (para o dashboard principal v1).
 */
export async function listProcessosPrimarios(): Promise<Processo[]> {
  const all = await listAllProcessos();
  return all.filter((p) => p.is_classe_primaria);
}

/**
 * Cria um processo novo + seus réus, em uma única transação.
 * Lança se `numero_processo` já existir (índice único).
 */
export async function criarProcesso(
  payload: ProcessoPayload,
  reus: readonly ReuPayload[]
): Promise<Processo> {
  if (reus.length === 0) {
    throw new Error('O processo deve ter ao menos um réu.');
  }
  const proc = processoFromPayload(payload);
  const reusStored = reus.map((r) => reuFromPayload(r, proc.id));

  await withTx(['PROCESSOS', 'REUS'], 'readwrite', (tx) => {
    tx.objectStore(CRIMINAL_STORES.PROCESSOS).add(proc);
    const reusStore = tx.objectStore(CRIMINAL_STORES.REUS);
    for (const r of reusStored) reusStore.add(r);
  });

  return {
    ...proc,
    reus: reusStored.map(({ processo_id: _drop, ...r }) => r)
  };
}

/**
 * Atualiza um processo existente. Mantém o padrão delete-and-reinsert dos
 * réus do sigcrim (actions.ts:57) — se `reus` vier definido, substitui
 * todos. Se vier `undefined`, preserva os réus atuais.
 */
export async function atualizarProcesso(
  id: string,
  patch: Partial<ProcessoPayload>,
  reus?: readonly ReuPayload[]
): Promise<Processo> {
  const proc = await withTx(['PROCESSOS', 'REUS'], 'readwrite', async (tx) => {
    const procsStore = tx.objectStore(CRIMINAL_STORES.PROCESSOS);
    const current = await reqAsPromise(
      procsStore.get(id) as IDBRequest<Processo | undefined>
    );
    if (!current) throw new Error(`Processo ${id} não encontrado.`);

    const ts = nowIso();
    let next: Processo = { ...current, ...patch, id, atualizado_em: ts };

    // Se a classe mudou, recalcula categoria / primária
    if (patch.classe_cnj !== undefined && patch.classe_cnj !== current.classe_cnj) {
      const cat = getCategoriaDoCodigo(patch.classe_cnj);
      if (!cat) throw new Error(`Classe CNJ ${patch.classe_cnj} fora do catálogo.`);
      next = {
        ...next,
        classe_categoria: cat,
        is_classe_primaria: isCodigoPrimario(patch.classe_cnj)
      };
    }

    procsStore.put(next);

    if (reus) {
      const reusStore = tx.objectStore(CRIMINAL_STORES.REUS);
      const idx = reusStore.index('processo_id');
      // Apaga réus atuais
      const existentes = await reqAsPromise(
        idx.getAllKeys(IDBKeyRange.only(id)) as IDBRequest<IDBValidKey[]>
      );
      for (const k of existentes) reusStore.delete(k);
      // Insere novos
      for (const r of reus) reusStore.add(reuFromPayload(r, id));
    }

    return next;
  });

  // Recarrega com réus para devolver consistente
  const reloaded = await getProcessoById(proc.id);
  if (!reloaded) throw new Error('Processo desapareceu após atualização.');
  return reloaded;
}

/**
 * Atualiza UM réu específico (por `id`) preservando os demais réus
 * do processo. Usado pelo enriquecimento JSF de Pessoa Física no
 * dashboard — só queremos sobrescrever campos do réu enriquecido,
 * sem disparar delete-and-reinsert dos demais.
 *
 * `patch` aceita qualquer subconjunto de campos do `Reu` (exceto
 * `id` e timestamps de criação). `pje_origem_patch`, quando passado,
 * é mesclado em `pje_origem` (carimba origem para cada campo
 * preenchido pela atualização).
 */
export async function atualizarReu(
  reuId: string,
  patch: Partial<Reu>,
  pje_origem_patch?: PjeOrigemMap
): Promise<Reu | null> {
  return withTx(['REUS'], 'readwrite', async (tx) => {
    const reusStore = tx.objectStore(CRIMINAL_STORES.REUS);
    const stored = (await reqAsPromise(
      reusStore.get(reuId) as IDBRequest<ReuStored | undefined>
    )) ?? null;
    if (!stored) return null;
    const ts = nowIso();
    const novo: ReuStored = {
      ...stored,
      ...patch,
      id: stored.id, // imutável
      processo_id: stored.processo_id, // imutável
      criado_em: stored.criado_em, // preserva
      atualizado_em: ts,
      pje_origem: pje_origem_patch
        ? { ...stored.pje_origem, ...pje_origem_patch }
        : stored.pje_origem
    };
    reusStore.put(novo);
    const { processo_id: _omit, ...resultado } = novo;
    return resultado;
  });
}

/**
 * Apaga o processo e todos os seus réus. Usado pelo CRUD na sidebar.
 */
export async function excluirProcesso(id: string): Promise<boolean> {
  return withTx(['PROCESSOS', 'REUS'], 'readwrite', async (tx) => {
    const procStore = tx.objectStore(CRIMINAL_STORES.PROCESSOS);
    const found = await reqAsPromise(
      procStore.get(id) as IDBRequest<Processo | undefined>
    );
    if (!found) return false;

    procStore.delete(id);

    const reusStore = tx.objectStore(CRIMINAL_STORES.REUS);
    const idx = reusStore.index('processo_id');
    const reusKeys = await reqAsPromise(
      idx.getAllKeys(IDBKeyRange.only(id)) as IDBRequest<IDBValidKey[]>
    );
    for (const k of reusKeys) reusStore.delete(k);

    return true;
  });
}

// ── Utilitários internos ─────────────────────────────────────────

async function getReusOfProcesso(tx: IDBTransaction, processoId: string): Promise<Reu[]> {
  const idx = tx.objectStore(CRIMINAL_STORES.REUS).index('processo_id');
  const reusStored = await reqAsPromise(
    idx.getAll(IDBKeyRange.only(processoId)) as IDBRequest<ReuStored[]>
  );
  return reusStored.map(({ processo_id: _omit, ...r }) => r);
}

// ── Upsert via captura PJe (varredura streaming) ─────────────────

/**
 * Upsert de um processo capturado pela varredura criminal. Estratégia:
 *
 *   - Procura por `numero_processo` (índice único). Se existe, atualiza
 *     mantendo `id` e `criado_em` originais. Réus são totalmente
 *     substituídos (delete-and-reinsert) — a varredura é a fonte de
 *     verdade da estrutura processual no momento da coleta.
 *
 *   - Para campos com origem `'manual'` na versão local, NÃO sobrescreve
 *     se a captura nova tiver origem `'pje'` ou `'ia'` mais fraca. Isso
 *     preserva edições manuais do usuário entre varreduras incrementais.
 *
 *   - `pje_origem` é mesclado por campo: para cada campo do payload novo
 *     que vier preenchido, se a versão local tinha `'manual'` no campo,
 *     mantém local; caso contrário, usa o novo.
 *
 * Devolve `{ created: true }` quando inseriu, `{ created: false, id }`
 * quando atualizou.
 */
export interface UpsertProcessoOpts {
  /** Pje origem por campo do processo (vem do `ProcessoCapturado`). */
  pje_origem: PjeOrigemMap;
  /** Pje origem por réu (alinhado por índice com `reus`). */
  reus_origem: PjeOrigemMap[];
  /** Carimbo da última sincronização — vai em `ultima_sincronizacao_pje`. */
  ultima_sincronizacao_pje: string;
}

export async function upsertProcessoFromPje(
  payload: ProcessoPayload,
  reus: readonly ReuPayload[],
  opts: UpsertProcessoOpts
): Promise<{ created: boolean; id: string }> {
  if (reus.length === 0) {
    throw new Error('upsertProcessoFromPje: precisa de ao menos 1 réu.');
  }
  const existente = await getProcessoByNumero(payload.numero_processo);

  if (!existente) {
    // Inserção: usa criarProcesso e em seguida marca pje_origem +
    // ultima_sincronizacao_pje (que criarProcesso inicializa como `{}`).
    const proc = await criarProcesso(payload, reus);
    await withTx(['PROCESSOS', 'REUS'], 'readwrite', async (tx) => {
      const procStore = tx.objectStore(CRIMINAL_STORES.PROCESSOS);
      const cur = (await reqAsPromise(
        procStore.get(proc.id) as IDBRequest<Processo | undefined>
      )) ?? null;
      if (!cur) return;
      cur.pje_origem = { ...opts.pje_origem };
      cur.ultima_sincronizacao_pje = opts.ultima_sincronizacao_pje;
      cur.atualizado_em = nowIso();
      procStore.put(cur);
      // Atualiza pje_origem nos réus recém-inseridos (alinhado por índice).
      const reusStore = tx.objectStore(CRIMINAL_STORES.REUS);
      const idx = reusStore.index('processo_id');
      const stored = await reqAsPromise(
        idx.getAll(IDBKeyRange.only(proc.id)) as IDBRequest<ReuStored[]>
      );
      // Mesma ordem da inserção original (delete-and-reinsert do criarProcesso).
      stored.sort((a, b) => a.criado_em.localeCompare(b.criado_em));
      for (let i = 0; i < stored.length; i++) {
        const r = stored[i]!;
        const o = opts.reus_origem[i] ?? {};
        r.pje_origem = { ...o };
        reusStore.put(r);
      }
    });
    return { created: true, id: proc.id };
  }

  // Atualização do PROCESSO: preserva campos com origem 'manual' do
  // existente, preserva valores enriquecidos por IA quando a captura
  // nova só traz dado mais pobre (PJe-sigla), e — CRÍTICO — NUNCA
  // permite que um valor null/undefined da captura nova apague um
  // valor já preenchido. Captura sem dado ≠ remoção do dado.
  const novoPayload: Partial<ProcessoPayload> = {};
  const origemFinalProc: PjeOrigemMap = { ...existente.pje_origem };
  for (const k of Object.keys(payload) as (keyof ProcessoPayload)[]) {
    const valorNovo = (payload as Record<string, unknown>)[k as string];
    const valorAtual = (existente as unknown as Record<string, unknown>)[k as string];
    const origemAtual = existente.pje_origem[k as string];
    const origemNova = opts.pje_origem[k as string];

    // 1. Valor novo vazio + valor atual preenchido → preserva o atual.
    if ((valorNovo == null || valorNovo === '') && valorAtual != null && valorAtual !== '') {
      continue;
    }
    // 2. 'manual' é soberano.
    if (origemAtual === 'manual') continue;
    // 3. 'ia' só cede para 'ia' ou 'manual'.
    if (origemAtual === 'ia' && origemNova !== 'ia' && origemNova !== 'manual') {
      continue;
    }
    // 4. Aplica o valor novo.
    (novoPayload as Record<string, unknown>)[k as string] = valorNovo;
    if (origemNova) origemFinalProc[k as string] = origemNova;
  }

  // Atualiza só os campos do processo — réus serão tratados em
  // transação dedicada com merge (NÃO delete-and-reinsert).
  await atualizarProcesso(existente.id, novoPayload);

  // RÉUS: merge inteligente preservando dados enriquecidos.
  await mergearReusUpsert(
    existente.id,
    existente.reus,
    reus,
    opts.reus_origem
  );

  // Aplica pje_origem + sincronização no processo
  await withTx(['PROCESSOS'], 'readwrite', async (tx) => {
    const procStore = tx.objectStore(CRIMINAL_STORES.PROCESSOS);
    const cur = (await reqAsPromise(
      procStore.get(existente.id) as IDBRequest<Processo | undefined>
    )) ?? null;
    if (!cur) return;
    cur.pje_origem = origemFinalProc;
    cur.ultima_sincronizacao_pje = opts.ultima_sincronizacao_pje;
    cur.atualizado_em = nowIso();
    procStore.put(cur);
  });

  return { created: false, id: existente.id };
}

/**
 * Merge inteligente de réus durante uma re-varredura.
 *
 * Em vez de delete-and-reinsert (que apagava `data_nascimento`/`rg`/
 * `nome_mae`/`endereco`/dados de IA enriquecidos via "Atualizar com
 * PJe + IA"), faz matching réu-a-réu por:
 *   1. CPF normalizado (11 dígitos) — match forte
 *   2. Nome normalizado (uppercase + sem acento) — match secundário
 *
 * Para cada par matched, faz merge campo-a-campo respeitando origens:
 *   - `manual`  → nunca sobrescreve. Edição do servidor é soberana.
 *   - `ia`      → só é sobrescrito por `ia` ou `manual`. PJe (sigla
 *                 do painel) é fonte mais pobre que a IA do PDF.
 *   - `pje`     → sobrescrito por qualquer origem nova preenchida.
 *   - vazio     → recebe o valor novo se houver, com origem nova.
 *
 * Réus existentes que não casam com nenhum novo: **preservam**.
 * Cenário: réu deletado do polo passivo no PJe, mas dados enriquecidos
 * pelo servidor não devem ser perdidos. O usuário pode excluir
 * manualmente se quiser, mas a varredura nunca apaga.
 *
 * Réus novos sem match: **inseridos**. Cenário: novo acusado incluído
 * no processo desde a última varredura.
 */
async function mergearReusUpsert(
  processoId: string,
  reusExistentes: readonly Reu[],
  reusNovos: readonly ReuPayload[],
  reusOrigemNova: readonly PjeOrigemMap[]
): Promise<void> {
  const idxNovo = new Map<number, number>(); // novoIdx → matched existente idx
  const usadosExistentes = new Set<number>();

  // ── 1ª passada: match por CPF ─────────────────────────────────
  const cpfsExist = reusExistentes.map((r) => normalizarDoc(r.cpf_reu));
  for (let i = 0; i < reusNovos.length; i++) {
    const cpfN = normalizarDoc(reusNovos[i]!.cpf_reu);
    if (!cpfN) continue;
    const j = cpfsExist.findIndex((c, k) => c === cpfN && !usadosExistentes.has(k));
    if (j >= 0) {
      idxNovo.set(i, j);
      usadosExistentes.add(j);
    }
  }
  // ── 2ª passada: match por nome (apenas para os que não casaram) ─
  const nomesExist = reusExistentes.map((r) => normalizarNome(r.nome_reu));
  for (let i = 0; i < reusNovos.length; i++) {
    if (idxNovo.has(i)) continue;
    const nomeN = normalizarNome(reusNovos[i]!.nome_reu);
    if (!nomeN) continue;
    const j = nomesExist.findIndex(
      (n, k) => n === nomeN && !usadosExistentes.has(k)
    );
    if (j >= 0) {
      idxNovo.set(i, j);
      usadosExistentes.add(j);
    }
  }

  await withTx(['REUS'], 'readwrite', async (tx) => {
    const reusStore = tx.objectStore(CRIMINAL_STORES.REUS);
    const ts = nowIso();

    for (let i = 0; i < reusNovos.length; i++) {
      const novo = reusNovos[i]!;
      const origemNovaReu = reusOrigemNova[i] ?? {};
      const matchIdx = idxNovo.get(i);

      if (matchIdx === undefined) {
        // Réu novo, sem match — INSERE.
        const novoStored = reuFromPayload(novo, processoId);
        novoStored.pje_origem = { ...origemNovaReu };
        reusStore.add(novoStored);
        continue;
      }

      // Match — MERGE campo-a-campo no réu existente.
      const existente = reusExistentes[matchIdx]!;
      const stored = (await reqAsPromise(
        reusStore.get(existente.id) as IDBRequest<ReuStored | undefined>
      )) ?? null;
      if (!stored) continue; // safety

      const origemAtual = stored.pje_origem ?? {};
      const novosFiltrados: Partial<Reu> = {};
      const origemFinal: PjeOrigemMap = { ...origemAtual };

      for (const k of Object.keys(novo) as (keyof ReuPayload)[]) {
        const valorNovo = (novo as Record<string, unknown>)[k as string];
        // null/undefined da varredura nunca sobrescreve valor existente —
        // ausência de info nova ≠ remoção. Crítico para preservar
        // data_nascimento/rg/nome_mae/etc.
        if (valorNovo == null) continue;

        const origNov = origemNovaReu[k as string];
        const origAtu = origemAtual[k as string];
        if (origAtu === 'manual') continue; // manual é soberano
        if (
          origAtu === 'ia' &&
          origNov !== 'ia' &&
          origNov !== 'manual'
        ) {
          // IA é mais rica que PJe-sigla; só IA/manual sobrescrevem IA.
          continue;
        }
        (novosFiltrados as Record<string, unknown>)[k as string] = valorNovo;
        if (origNov) origemFinal[k as string] = origNov;
      }

      const merged: ReuStored = {
        ...stored,
        ...novosFiltrados,
        id: stored.id,
        processo_id: stored.processo_id,
        criado_em: stored.criado_em,
        atualizado_em: ts,
        pje_origem: origemFinal
      };
      reusStore.put(merged);
    }
    // Réus existentes não casados ficam intocados — preservados.
  });
}

function normalizarDoc(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  return d.length === 11 || d.length === 14 ? d : null;
}

function normalizarNome(s: string | null | undefined): string | null {
  if (!s) return null;
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Limpeza ──────────────────────────────────────────────────────

/**
 * Set de nomes de classes criminais (uppercase + sem acento) — usado
 * para detectar `tipo_crime` poluído com nome de classe processual.
 * Inicializado lazy via getter para não criar dependência circular
 * com `criminal-classes`.
 */
let _nomesClassesCache: Set<string> | null = null;
async function getNomesClassesNormalizados(): Promise<Set<string>> {
  if (_nomesClassesCache) return _nomesClassesCache;
  const { CLASSES_CRIMINAIS } = await import('./criminal-classes');
  _nomesClassesCache = new Set(
    CLASSES_CRIMINAIS.map((c) =>
      c.nome
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .trim()
    )
  );
  return _nomesClassesCache;
}

const PREFIXOS_CLASSE_PROCESSUAL = [
  'ACAO PENAL',
  'PROCEDIMENTO ',
  'INQUERITO',
  'CARTA ',
  'MEDIDA',
  'MEDIDAS ',
  'EXCECAO',
  'EXCECOES',
  'EMBARGOS',
  'RECURSO ',
  'AGRAVO',
  'APELACAO',
  'EXECUCAO ',
  'PETICAO',
  'HABEAS '
] as const;

function ehNomeDeClasse(s: string, nomesClasses: Set<string>): boolean {
  const norm = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
  if (!norm) return false;
  if (nomesClasses.has(norm)) return true;
  return PREFIXOS_CLASSE_PROCESSUAL.some((p) => norm.startsWith(p));
}

function ehSentinelaSeam(s: string): boolean {
  return /^org\.jboss\./i.test(s) || /noSelection/i.test(s);
}

/**
 * Limpa do acervo dados que comprovadamente são "lixo" capturado
 * por bugs antigos:
 *   - `Processo.tipo_crime`: quando contém nome de classe processual
 *     ("AÇÃO PENAL - PROCEDIMENTO ORDINÁRIO") em vez de tipificação.
 *   - `Reu.endereco`: quando contém o sentinela JSF
 *     `org.jboss.seam.ui.NoSelectionConverter.noSelectionValue`.
 *
 * Limpa o valor (vira null) E remove a entrada de `pje_origem` para
 * o campo, deixando o registro num estado equivalente a "nunca foi
 * preenchido" — assim a próxima captura/IA pode preencher
 * corretamente sem ser bloqueada pela proteção `null não sobrescreve`.
 *
 * Retorna estatísticas pra log.
 */
export async function limparDadosPoluidos(): Promise<{
  processosLimpos: number;
  reusLimpos: number;
}> {
  const nomesClasses = await getNomesClassesNormalizados();
  let processosLimpos = 0;
  let reusLimpos = 0;

  await withTx(['PROCESSOS', 'REUS'], 'readwrite', async (tx) => {
    // Processos: tipo_crime poluído.
    const procsStore = tx.objectStore(CRIMINAL_STORES.PROCESSOS);
    const procs = await reqAsPromise(
      procsStore.getAll() as IDBRequest<Processo[]>
    );
    for (const p of procs) {
      if (p.tipo_crime && ehNomeDeClasse(p.tipo_crime, nomesClasses)) {
        const pjeOrigem = { ...(p.pje_origem ?? {}) };
        delete pjeOrigem.tipo_crime;
        procsStore.put({
          ...p,
          tipo_crime: null,
          pje_origem: pjeOrigem,
          atualizado_em: nowIso()
        });
        processosLimpos++;
      }
    }

    // Réus: endereço com sentinela Seam.
    const reusStore = tx.objectStore(CRIMINAL_STORES.REUS);
    const reus = await reqAsPromise(
      reusStore.getAll() as IDBRequest<ReuStored[]>
    );
    for (const r of reus) {
      if (r.endereco && ehSentinelaSeam(r.endereco)) {
        const pjeOrigem = { ...(r.pje_origem ?? {}) };
        delete pjeOrigem.endereco;
        reusStore.put({
          ...r,
          endereco: null,
          pje_origem: pjeOrigem,
          atualizado_em: nowIso()
        });
        reusLimpos++;
      }
    }
  });

  if (processosLimpos > 0 || reusLimpos > 0) {
    console.info(
      `${LOG_PREFIX} limparDadosPoluidos: ${processosLimpos} processo(s) ` +
        `e ${reusLimpos} réu(s) limpos.`
    );
  }
  return { processosLimpos, reusLimpos };
}

/**
 * Item no preview da limpeza — exibido na UI antes de aplicar.
 * Permite que o usuário revise individualmente o que seria limpo.
 */
export interface ItemPreviewLimpeza {
  tipo: 'processo' | 'reu';
  /** ID interno do registro (processo.id ou reu.id). */
  id: string;
  /** Identificador legível (número CNJ do processo ou nome do réu). */
  rotulo: string;
  /** Nome do campo que seria limpo. */
  campo: string;
  /** Valor atual (que seria removido). */
  valorAtual: string;
  /** Motivo: regra que disparou a detecção. */
  motivo: string;
}

/**
 * Lê o acervo e retorna o que SERIA limpo, sem alterar nada. Mostra
 * cada item individualmente para o usuário revisar antes de aplicar
 * `limparDadosPoluidos()`.
 */
export async function previewLimpezaPoluidos(): Promise<ItemPreviewLimpeza[]> {
  const nomesClasses = await getNomesClassesNormalizados();
  const itens: ItemPreviewLimpeza[] = [];

  await withTx(['PROCESSOS', 'REUS'], 'readonly', async (tx) => {
    const procs = await reqAsPromise(
      tx.objectStore(CRIMINAL_STORES.PROCESSOS).getAll() as IDBRequest<Processo[]>
    );
    for (const p of procs) {
      if (p.tipo_crime && ehNomeDeClasse(p.tipo_crime, nomesClasses)) {
        itens.push({
          tipo: 'processo',
          id: p.id,
          rotulo: p.numero_processo,
          campo: 'tipo_crime',
          valorAtual: p.tipo_crime,
          motivo: 'Valor é nome de classe processual, não tipificação criminal'
        });
      }
    }

    const reus = await reqAsPromise(
      tx.objectStore(CRIMINAL_STORES.REUS).getAll() as IDBRequest<ReuStored[]>
    );
    for (const r of reus) {
      if (r.endereco && ehSentinelaSeam(r.endereco)) {
        itens.push({
          tipo: 'reu',
          id: r.id,
          rotulo: r.nome_reu,
          campo: 'endereco',
          valorAtual: r.endereco,
          motivo: 'Sentinela interno do JSF (org.jboss.seam… / NoSelection)'
        });
      }
    }
  });

  return itens;
}

/**
 * Apaga todo o conteúdo do banco — usado pelo botão "Apagar acervo" das
 * configurações e pelo importador antes de carregar um JSON limpo.
 * Mantém o object store META se `manterConfig=true`.
 */
export async function apagarAcervoCompleto(
  opts: { manterConfig?: boolean } = {}
): Promise<void> {
  await withTx(['PROCESSOS', 'REUS', 'META'], 'readwrite', (tx) => {
    tx.objectStore(CRIMINAL_STORES.PROCESSOS).clear();
    tx.objectStore(CRIMINAL_STORES.REUS).clear();
    if (!opts.manterConfig) tx.objectStore(CRIMINAL_STORES.META).clear();
  });
  console.info(`${LOG_PREFIX} acervo criminal apagado (manterConfig=${opts.manterConfig ?? false})`);
}

// ── Estatísticas rápidas ─────────────────────────────────────────

export interface CriminalStats {
  totalProcessos: number;
  totalProcessosPrimarios: number;
  totalReus: number;
}

export async function getCriminalStats(): Promise<CriminalStats> {
  return withTx(['PROCESSOS', 'REUS'], 'readonly', async (tx) => {
    const totalProcessos = await reqAsPromise(
      tx.objectStore(CRIMINAL_STORES.PROCESSOS).count() as IDBRequest<number>
    );
    const idxPrim = tx.objectStore(CRIMINAL_STORES.PROCESSOS).index('is_classe_primaria');
    // IndexedDB não indexa booleans diretamente em todos os engines —
    // armazenamos como `true` (truthy) e usamos getAllKeys + filtro
    // como fallback se o index falhar com KeyRange para booleano.
    let totalProcessosPrimarios = 0;
    try {
      totalProcessosPrimarios = await reqAsPromise(
        idxPrim.count(IDBKeyRange.only(true)) as IDBRequest<number>
      );
    } catch {
      const all = await reqAsPromise(
        tx.objectStore(CRIMINAL_STORES.PROCESSOS).getAll() as IDBRequest<Processo[]>
      );
      totalProcessosPrimarios = all.filter((p) => p.is_classe_primaria).length;
    }
    const totalReus = await reqAsPromise(
      tx.objectStore(CRIMINAL_STORES.REUS).count() as IDBRequest<number>
    );
    return { totalProcessos, totalProcessosPrimarios, totalReus };
  });
}
