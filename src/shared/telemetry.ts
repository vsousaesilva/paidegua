/**
 * Telemetria local para varreduras do pAIdegua.
 *
 * Objetivo: medir comportamento real das coletas (Painel Gerencial, Prazos
 * na Fita, Triagem) em unidades de diferentes tamanhos sem depender de
 * observação externa. Tudo fica em `chrome.storage.local`, nunca sai do
 * navegador do usuário, e a API é tolerante a erro: se a persistência
 * falhar, a coleta em si NÃO é interrompida — a telemetria é auxiliar.
 *
 * Isolamento: este módulo não importa nada do domínio da extensão (além
 * de `constants` e `types` puros). Nenhum caminho de coleta depende de
 * seu sucesso — todo acesso a storage é `try/catch` silencioso.
 *
 * O que registramos:
 *   - Início/fim de cada varredura (kind, meta livre, status).
 *   - Fases nomeadas com duração (ex.: "listar", "resolver-ca", "fetch-expedientes").
 *   - Contadores (ex.: processos, 403, fallback-dom, auth-expired).
 *
 * O que NÃO registramos: qualquer dado sensível (CNJ, CPF, conteúdo de
 * processos). `meta` é livre mas o código chamador deve evitar gravar PII.
 * O módulo não faz sanitização automática — responsabilidade do caller.
 */

import { LOG_PREFIX } from './constants';

/** Chave única em `chrome.storage.local`. */
const STORAGE_KEY = 'paidegua.telemetry.scans';

/** Quantas varreduras manter no buffer circular. */
const MAX_SCANS = 30;

/**
 * Tipos de varredura rastreáveis. Novos kinds podem ser adicionados sem
 * migração — o consumidor trata desconhecidos como "outro".
 */
export type ScanKind =
  | 'painel-gerencial'
  | 'prazos-fita'
  | 'prazos-simples'
  | 'triagem'
  | 'outro';

export type ScanStatus = 'running' | 'ok' | 'error' | 'canceled';

export interface ScanPhaseRecord {
  name: string;
  startedAt: number;
  durationMs: number;
  extra?: Record<string, unknown>;
}

export interface ScanRecord {
  id: string;
  kind: ScanKind;
  startedAt: number;
  finishedAt: number | null;
  status: ScanStatus;
  meta: Record<string, unknown>;
  phases: ScanPhaseRecord[];
  counters: Record<string, number>;
  error?: string;
}

/** Handle devolvido pelo `startScan`. Métodos são tolerantes a erro. */
export interface ScanHandle {
  readonly id: string;
  readonly kind: ScanKind;
  /** Abre uma fase nomeada. Retorna callback `end(extra?)` para fechá-la. */
  phase(name: string): (extra?: Record<string, unknown>) => Promise<void>;
  /** Incrementa um contador nomeado em `delta` (default 1). */
  counter(name: string, delta?: number): void;
  /** Funde campos em `meta` (merge raso). */
  mergeMeta(partial: Record<string, unknown>): void;
  /** Marca a varredura como encerrada com sucesso. */
  success(extra?: Record<string, unknown>): Promise<void>;
  /** Marca como erro. */
  fail(error: unknown, extra?: Record<string, unknown>): Promise<void>;
  /** Marca como cancelada (por usuário, auth expirada, etc.). */
  cancel(reason?: string): Promise<void>;
}

/* ------------------------- storage helpers --------------------------- */

function chromeLocalAvailable(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' &&
      !!chrome?.storage?.local?.get &&
      !!chrome?.storage?.local?.set
    );
  } catch {
    return false;
  }
}

async function readAll(): Promise<ScanRecord[]> {
  if (!chromeLocalAvailable()) return [];
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const list = data?.[STORAGE_KEY];
    if (!Array.isArray(list)) return [];
    // Filtra entradas corrompidas sem derrubar o resto.
    return list.filter(
      (x): x is ScanRecord =>
        x && typeof x === 'object' && typeof x.id === 'string'
    );
  } catch (err) {
    console.warn(`${LOG_PREFIX} telemetria: falha lendo storage:`, err);
    return [];
  }
}

async function writeAll(list: ScanRecord[]): Promise<void> {
  if (!chromeLocalAvailable()) return;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: list });
  } catch (err) {
    console.warn(`${LOG_PREFIX} telemetria: falha gravando storage:`, err);
  }
}

/**
 * Funde `rec` na lista persistida, mantendo apenas os últimos MAX_SCANS.
 * Operação "last write wins" — varreduras paralelas do mesmo kind podem
 * concorrer na leitura/escrita, mas o impacto é apenas de ordem; não
 * vamos perder um registro anterior de outra varredura porque sempre
 * relemos antes de gravar.
 */
async function upsertRecord(rec: ScanRecord): Promise<void> {
  const list = await readAll();
  const idx = list.findIndex((r) => r.id === rec.id);
  if (idx >= 0) {
    list[idx] = rec;
  } else {
    list.push(rec);
  }
  // Ordena por `startedAt` descendente e apara.
  list.sort((a, b) => b.startedAt - a.startedAt);
  if (list.length > MAX_SCANS) list.length = MAX_SCANS;
  await writeAll(list);
}

/* ---------------------------- API pública ---------------------------- */

function novoId(kind: ScanKind): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${kind}-${Date.now()}-${rand}`;
}

/**
 * Abre uma nova varredura para instrumentação. Sempre retorna um handle,
 * mesmo que a persistência falhe — as chamadas internas são tolerantes.
 */
export function startScan(
  kind: ScanKind,
  meta: Record<string, unknown> = {}
): ScanHandle {
  const rec: ScanRecord = {
    id: novoId(kind),
    kind,
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    meta: { ...meta },
    phases: [],
    counters: {}
  };

  // Grava inicial em fire-and-forget para não bloquear o caller.
  void upsertRecord(rec);

  const handle: ScanHandle = {
    id: rec.id,
    kind,
    phase(name: string) {
      const startedAt = Date.now();
      return async (extra?: Record<string, unknown>): Promise<void> => {
        try {
          const durationMs = Date.now() - startedAt;
          const phaseRec: ScanPhaseRecord = {
            name,
            startedAt,
            durationMs,
            ...(extra ? { extra } : {})
          };
          rec.phases.push(phaseRec);
          await upsertRecord(rec);
        } catch {
          /* ignore — telemetria nunca quebra coleta */
        }
      };
    },
    counter(name: string, delta: number = 1): void {
      try {
        rec.counters[name] = (rec.counters[name] ?? 0) + delta;
        void upsertRecord(rec);
      } catch {
        /* ignore */
      }
    },
    mergeMeta(partial: Record<string, unknown>): void {
      try {
        rec.meta = { ...rec.meta, ...partial };
        void upsertRecord(rec);
      } catch {
        /* ignore */
      }
    },
    async success(extra?: Record<string, unknown>): Promise<void> {
      try {
        rec.finishedAt = Date.now();
        rec.status = 'ok';
        if (extra) rec.meta = { ...rec.meta, ...extra };
        await upsertRecord(rec);
      } catch {
        /* ignore */
      }
    },
    async fail(err: unknown, extra?: Record<string, unknown>): Promise<void> {
      try {
        rec.finishedAt = Date.now();
        rec.status = 'error';
        rec.error = err instanceof Error ? err.message : String(err);
        if (extra) rec.meta = { ...rec.meta, ...extra };
        await upsertRecord(rec);
      } catch {
        /* ignore */
      }
    },
    async cancel(reason?: string): Promise<void> {
      try {
        rec.finishedAt = Date.now();
        rec.status = 'canceled';
        if (reason) rec.error = reason;
        await upsertRecord(rec);
      } catch {
        /* ignore */
      }
    }
  };

  return handle;
}

/** Lista as últimas varreduras, mais recentes primeiro. */
export async function listRecentScans(): Promise<ScanRecord[]> {
  const list = await readAll();
  list.sort((a, b) => b.startedAt - a.startedAt);
  return list;
}

/** Remove todo o histórico. Útil para o botão "Limpar" na página de diagnóstico. */
export async function clearScans(): Promise<void> {
  if (!chromeLocalAvailable()) return;
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch (err) {
    console.warn(`${LOG_PREFIX} telemetria: falha limpando storage:`, err);
  }
}
