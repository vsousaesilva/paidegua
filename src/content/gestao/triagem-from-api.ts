/**
 * Conversão `PJeApiProcesso` (resposta REST normalizada) → `TriagemProcesso`
 * (forma canônica consumida pelos dashboards) + orquestrador de coleta de
 * snapshots por tarefa via API REST.
 *
 * Por que existe: historicamente o Gestão coletava cartões via DOM
 * scraping do painel Angular. Isso trazia dois problemas reais:
 *   1. `idProcesso` escapado como `idTaskInstance`, quebrando a montagem
 *      de URL autenticada (`listAutosDigitais.seam?idProcesso=X&ca=Y`);
 *   2. campos ausentes (`sigiloso` sempre `false`, etiquetas com ruído).
 *
 * A REST `recuperarProcessosTarefaPendenteComCriterios` devolve tudo que
 * o DOM dava — e mais (assuntoPrincipal, descricaoUltimoMovimento,
 * ultimoMovimento ms, cargoJudicial). Com `gerarChaveAcessoProcesso`
 * resolvemos o `ca` necessário para abrir os autos no contexto da tarefa.
 *
 * Este módulo não faz DOM scraping. O `gestao-bridge.ts` decide se usa
 * este caminho (rápido e completo) ou cai no fallback DOM se o snapshot
 * de auth ainda não foi capturado pelo interceptor.
 */

import { LOG_PREFIX, STORAGE_KEYS } from '../../shared/constants';
import type {
  PJeApiProcesso,
  TriagemProcesso,
  TriagemTarefaSnapshot
} from '../../shared/types';
import {
  gerarChaveAcesso,
  listarProcessosDaTarefa
} from '../pje-api/pje-api-from-content';
import type { ScanHandle } from '../../shared/telemetry';

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Extrai o nome da vara a partir do campo `orgaoJulgador` do PJe TRF5,
 * que vem no formato "1º Grau / 35ª Vara Federal CE / Juiz Federal
 * Titular". Preferimos o segmento que contém "vara"; na ausência, o
 * primeiro segmento não vazio. Usado para emitir `[unidade]` cedo no
 * progresso, antes mesmo da resolução de `ca`, para que o cabeçalho da
 * aba de varredura mostre a unidade desde a primeira tarefa.
 */
function extrairNomeVara(orgao: string | null | undefined): string | null {
  if (!orgao) return null;
  const raw = orgao.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const segs = raw.split('/').map((s) => s.trim()).filter(Boolean);
  const vara = segs.find((s) => /\bvara\b/i.test(s));
  if (vara) return vara;
  return segs[0] ?? null;
}

/**
 * Converte timestamp ms para o formato `dd-mm-aa` usado pelos dashboards
 * (legado do DOM scraping do PJe). Retorna `null` se o número não for
 * um timestamp válido.
 */
function msParaDdMmAa(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const aa = String(d.getFullYear() % 100).padStart(2, '0');
  return `${dd}-${mm}-${aa}`;
}

/**
 * Aceita string numérica (como a REST `dataChegadaTarefa` devolve — ms
 * serializado em texto) ou número já em ms. Retorna ms ou null.
 */
function toMsOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function diasDesdeMs(ms: number | null): number | null {
  if (ms == null) return null;
  const hoje = Date.now();
  if (ms > hoje) return 0;
  return Math.floor((hoje - ms) / (1000 * 60 * 60 * 24));
}

/**
 * Monta o texto de última movimentação combinando data + descrição —
 * mesmo formato aproximado que o DOM rendered usa ("dd/mm/aaaa – texto").
 */
function montarUltimaMovimentacaoTexto(p: PJeApiProcesso): string | null {
  const desc = p.descricaoUltimoMovimento?.trim();
  const ms = p.ultimoMovimento;
  if (!desc && (ms == null || !Number.isFinite(ms))) return null;
  if (!desc) return null;
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return desc;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return desc;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy} – ${desc}`;
}

/**
 * Converte um `PJeApiProcesso` (com URL autenticada já resolvida) em
 * `TriagemProcesso` canônico.
 *
 * Diferenças em relação ao caminho DOM:
 *   - `idProcesso` é o ID real do processo (não o `idTaskInstance`).
 *   - `sigiloso` vem do servidor (não mais `false` fixo).
 *   - `assunto` vem de `assuntoPrincipal` (matéria, não classe).
 *   - `dataUltimoMovimento` / `diasUltimoMovimento` são populados.
 *   - `ultimaMovimentacaoTexto` usa `descricaoUltimoMovimento` com data.
 */
export function triagemProcessoFromApi(
  p: PJeApiProcesso,
  url: string
): TriagemProcesso {
  const chegadaMs = toMsOrNull(p.dataChegadaTarefa);
  return {
    idProcesso: String(p.idProcesso),
    idTaskInstance: p.idTaskInstance != null ? String(p.idTaskInstance) : null,
    numeroProcesso: p.numeroProcesso ?? '',
    assunto: p.assuntoPrincipal ?? '',
    orgao: p.orgaoJulgador ?? '',
    poloAtivo: p.poloAtivo ?? '',
    poloPassivo: p.poloPassivo ?? '',
    dataEntradaTarefa: msParaDdMmAa(chegadaMs),
    diasNaTarefa: diasDesdeMs(chegadaMs),
    dataUltimoMovimento: msParaDdMmAa(p.ultimoMovimento),
    diasUltimoMovimento: diasDesdeMs(p.ultimoMovimento),
    dataConclusao: null,
    diasDesdeConclusao: null,
    ultimaMovimentacaoTexto: montarUltimaMovimentacaoTexto(p),
    prioritario: p.prioridade,
    sigiloso: p.sigiloso,
    etiquetas: p.etiquetas,
    url
  };
}

export interface ColetarSnapshotsViaAPIOptions {
  /** Nomes exatos das tarefas a coletar (mesmos rótulos do painel). */
  nomes: string[];
  /**
   * Origin do PJe legacy usado para montar a URL dos autos. Em iframe
   * cross-origin, o `window.location.origin` aponta para o frontend — o
   * caller deve passar aqui o origin do PJe real (ex. `pje1g.trf5...`).
   */
  pjeOrigin?: string;
  /** Limite de processos por tarefa. */
  maxProcessosPorTarefa?: number;
  /** Paralelismo de resolução de `ca`. Default 10, clamp [1, 10]. */
  concurrencyCa?: number;
  onProgress?: (msg: string) => void;
  /**
   * Handle de telemetria opcional. Quando fornecido, o coletor registra
   * fases (uma por tarefa) e contadores (processos, ca-erros). O caller
   * permanece responsável por `success`/`fail`/`cancel` do handle.
   * Se omitido, o coletor não grava telemetria (útil para testes e para
   * chamadas secundárias que não devem poluir o histórico).
   */
  telemetry?: ScanHandle;
  /**
   * Quando `true`, o coletor NÃO resolve `ca` (chaveAcessoProcesso) por
   * processo — todos os `TriagemProcesso.url` saem vazios. Usado pela
   * estratégia de hidratação progressiva: a coleta termina em segundos
   * (uma chamada REST por tarefa, sem worker pool), abre o relatório
   * imediatamente e a resolução de URLs roda em segundo plano via
   * `hidratarUrlsViaAPI`, atualizando o dashboard progressivamente.
   * Default `false` (comportamento legado: resolve tudo antes de abrir).
   */
  skipCaResolution?: boolean;
}

export interface ColetarSnapshotsViaAPIResult {
  ok: boolean;
  snapshots: TriagemTarefaSnapshot[];
  error?: string;
}

/**
 * Coleta snapshots de todas as tarefas em `nomes` via REST:
 *   1. Para cada tarefa, lista os processos (pagina até esgotar).
 *   2. Pool de `gerarChaveAcesso` para montar URL autenticada.
 *   3. Converte em `TriagemProcesso` via `triagemProcessoFromApi`.
 *
 * Se o snapshot de auth não estiver disponível, devolve `ok: false` com
 * erro — cabe ao caller cair no fallback DOM.
 */
export async function coletarSnapshotsViaAPI(
  opts: ColetarSnapshotsViaAPIOptions
): Promise<ColetarSnapshotsViaAPIResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const legacyOrigin = (
    opts.pjeOrigin ?? window.location.origin
  ).replace(/\/+$/, '');
  const concurrencyCa = clamp(opts.concurrencyCa ?? 10, 1, 10);
  const skipCa = opts.skipCaResolution === true;

  const snapshots: TriagemTarefaSnapshot[] = [];
  const tele = opts.telemetry;
  const totalTarefas = opts.nomes.length;
  let unidadeEmitida = false;

  for (let iTarefa = 0; iTarefa < opts.nomes.length; iTarefa++) {
    const nomeTarefa = opts.nomes[iTarefa];
    const indiceHuman = iTarefa + 1;
    onProgress(`Coletando processos da tarefa "${nomeTarefa}" — aguarde...`);
    const endListar = tele?.phase(`listar:${nomeTarefa}`);
    const lista = await listarProcessosDaTarefa({
      nomeTarefa,
      maxProcessos: opts.maxProcessosPorTarefa
    });
    await endListar?.({
      ok: lista.ok,
      total: lista.total,
      lidos: lista.processos.length
    });
    if (!lista.ok) {
      tele?.counter('tarefa-listar-erro');
      return {
        ok: false,
        snapshots,
        error: lista.error ?? `Falha listando "${nomeTarefa}".`
      };
    }
    tele?.counter('processos-listados', lista.processos.length);
    if (lista.processos.length < lista.total) {
      tele?.counter('processos-omitidos', lista.total - lista.processos.length);
    }

    // Emitir `[unidade]` assim que tivermos o primeiro `orgaoJulgador` em
    // mãos — o painel da aba de varredura captura esse prefixo para exibir
    // a vara no cabeçalho desde a primeira tarefa, em vez de esperar o
    // fim da coleta.
    if (!unidadeEmitida) {
      for (const p of lista.processos) {
        const nomeVara = extrairNomeVara(p.orgaoJulgador);
        if (nomeVara) {
          onProgress(`[unidade] ${nomeVara}`);
          unidadeEmitida = true;
          break;
        }
      }
    }

    // Caminho rápido: sem resolução de `ca`, os `TriagemProcesso` saem
    // imediatamente com `url = ''`. Responsabilidade de hidratar em
    // segundo plano recai sobre `hidratarUrlsViaAPI`.
    if (skipCa) {
      const processos = lista.processos.map((p) => triagemProcessoFromApi(p, ''));
      snapshots.push({
        tarefaNome: nomeTarefa,
        totalLido: processos.length,
        truncado: processos.length < lista.total,
        processos
      });
      // Marco estruturado para a barra de progresso da aba-painel avançar
      // tarefa a tarefa. O regex da aba-painel (`painel.ts`) casa
      // `Tarefa N/M: K processo(s) lido(s)` — sem esse marco, a barra
      // fica em 0% no caminho REST (antes só o caminho DOM emitia).
      onProgress(
        `Tarefa ${indiceHuman}/${totalTarefas}: ${processos.length} processo(s) lido(s) em "${nomeTarefa}".`
      );
      continue;
    }

    onProgress(
      `Tarefa "${nomeTarefa}": ${lista.processos.length}/${lista.total} processo(s) identificados. Resolvendo autos...`
    );

    const processos: TriagemProcesso[] = new Array(lista.processos.length);
    let proximo = 0;
    let concluidos = 0;
    let errosCa = 0;

    const endResolver = tele?.phase(`resolver-ca:${nomeTarefa}`);
    const worker = async (): Promise<void> => {
      while (true) {
        const idx = proximo++;
        if (idx >= lista.processos.length) return;
        const api = lista.processos[idx];
        let url = '';
        try {
          if (api.idProcesso > 0) {
            const ca = await gerarChaveAcesso(api.idProcesso);
            if (ca.ok && ca.ca) {
              url = montarUrlAutos(legacyOrigin, api.idProcesso, ca.ca, api.idTaskInstance);
            } else {
              errosCa++;
            }
          }
        } catch {
          errosCa++;
          /* segue com url vazia — dashboard renderiza disabled */
        }
        processos[idx] = triagemProcessoFromApi(api, url);
        concluidos++;
        if (concluidos % 25 === 0 || concluidos === lista.processos.length) {
          onProgress(
            `Resolvendo autos em "${nomeTarefa}": ${concluidos}/${lista.processos.length}...`
          );
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrencyCa, lista.processos.length) },
      () => worker()
    );
    await Promise.all(workers);
    await endResolver?.({ concluidos, errosCa });
    if (errosCa > 0) tele?.counter('ca-erros', errosCa);

    snapshots.push({
      tarefaNome: nomeTarefa,
      totalLido: processos.length,
      truncado: processos.length < lista.total,
      processos
    });
    onProgress(
      `Tarefa ${indiceHuman}/${totalTarefas}: ${processos.length} processo(s) lido(s) em "${nomeTarefa}".`
    );
  }

  return { ok: true, snapshots };
}

/**
 * Monta a URL autenticada dos autos digitais no PJe legacy.
 */
function montarUrlAutos(
  legacyOrigin: string,
  idProcesso: number,
  ca: string,
  idTaskInstance: number | null
): string {
  const params = new URLSearchParams();
  params.set('idProcesso', String(idProcesso));
  params.set('ca', ca);
  if (idTaskInstance != null) {
    params.set('idTaskInstance', String(idTaskInstance));
  }
  return (
    `${legacyOrigin}/pje/Processo/ConsultaProcesso/Detalhe/` +
    `listAutosDigitais.seam?${params.toString()}`
  );
}

export interface HidratarUrlsOptions {
  /** Identificador único da varredura — chave da entrada em `storage.session`. */
  scanId: string;
  /** Origin do PJe legacy usado para montar as URLs. */
  legacyOrigin: string;
  /** Paralelismo de resolução de `ca`. Default 10, clamp [1, 10]. */
  concurrencyCa?: number;
  /**
   * Batching: quantas resoluções acumular antes de gravar em
   * `chrome.storage.session`. Default 25. Também há um debounce de 500ms
   * para entregar o último lote parcial em tarefas pequenas.
   */
  flushEvery?: number;
  /** Intervalo máximo de debounce antes de descarregar o buffer (ms). */
  flushAfterMs?: number;
}

interface HidratacaoEntry {
  scanId: string;
  status: 'running' | 'done';
  updatedAt: number;
  urls: Record<string, string>;
}

function chromeSessionAvailable(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' &&
      !!chrome?.storage?.session?.get &&
      !!chrome?.storage?.session?.set
    );
  } catch {
    return false;
  }
}

/**
 * Resolve `ca` (chaveAcessoProcesso) progressivamente para todos os
 * processos de `snapshots`, gravando mapas parciais em
 * `chrome.storage.session` para que o dashboard atualize os links em
 * tempo real. Tolerante a erro: falhas individuais de `gerarChaveAcesso`
 * deixam o processo sem URL (dashboard mantém o estilo disabled).
 *
 * Executa em segundo plano (fire-and-forget do caller). Não retorna
 * resultado — o estado final (`status: 'done'`) fica gravado no storage
 * para que recargas do dashboard (F5) recuperem o estado.
 */
export async function hidratarUrlsViaAPI(
  snapshots: TriagemTarefaSnapshot[],
  opts: HidratarUrlsOptions
): Promise<void> {
  if (!chromeSessionAvailable()) return;
  const storageKey = STORAGE_KEYS.DASHBOARD_URL_HYDRATION_PREFIX + opts.scanId;
  const legacyOrigin = opts.legacyOrigin.replace(/\/+$/, '');
  const concurrencyCa = clamp(opts.concurrencyCa ?? 10, 1, 10);
  const flushEvery = Math.max(1, opts.flushEvery ?? 25);
  const flushAfterMs = Math.max(100, opts.flushAfterMs ?? 500);

  // Enfileira uma lista única de (idProcesso, idTaskInstance) preservando
  // ordem de apresentação no dashboard — primeiros processos da primeira
  // tarefa resolvem primeiro, melhorando a percepção de progresso.
  interface Item {
    idProcesso: number;
    idTaskInstance: number | null;
  }
  const fila: Item[] = [];
  for (const snap of snapshots) {
    for (const p of snap.processos) {
      const idProc = Number(p.idProcesso);
      if (!Number.isFinite(idProc) || idProc <= 0) continue;
      if (p.url) continue; // já resolvido (caso raro de cache futuro)
      const idTask = p.idTaskInstance != null ? Number(p.idTaskInstance) : null;
      fila.push({
        idProcesso: idProc,
        idTaskInstance:
          idTask != null && Number.isFinite(idTask) ? idTask : null
      });
    }
  }

  const bufferUrls: Record<string, string> = {};
  let flushPendente = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let novasDesdeUltimoFlush = 0;

  const flush = async (final: boolean): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!flushPendente && !final) return;
    flushPendente = false;
    novasDesdeUltimoFlush = 0;
    try {
      const cur = await chrome.storage.session.get(storageKey);
      const prev = (cur?.[storageKey] as HidratacaoEntry | undefined) ?? null;
      const next: HidratacaoEntry = {
        scanId: opts.scanId,
        status: final ? 'done' : 'running',
        updatedAt: Date.now(),
        urls: { ...(prev?.urls ?? {}), ...bufferUrls }
      };
      await chrome.storage.session.set({ [storageKey]: next });
    } catch (err) {
      console.warn(`${LOG_PREFIX} hidratacao: falha gravando storage:`, err);
    }
  };

  const scheduleFlush = (): void => {
    flushPendente = true;
    if (novasDesdeUltimoFlush >= flushEvery) {
      void flush(false);
      return;
    }
    if (flushTimer != null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush(false);
    }, flushAfterMs);
  };

  // Marca a entrada como `running` desde o primeiro instante para que o
  // dashboard saiba que há hidratação em andamento antes mesmo do
  // primeiro `ca` resolver.
  try {
    const entry: HidratacaoEntry = {
      scanId: opts.scanId,
      status: 'running',
      updatedAt: Date.now(),
      urls: {}
    };
    await chrome.storage.session.set({ [storageKey]: entry });
  } catch {
    /* ignore */
  }

  let proximo = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = proximo++;
      if (idx >= fila.length) return;
      const item = fila[idx];
      try {
        const ca = await gerarChaveAcesso(item.idProcesso);
        if (ca.ok && ca.ca) {
          const url = montarUrlAutos(
            legacyOrigin,
            item.idProcesso,
            ca.ca,
            item.idTaskInstance
          );
          bufferUrls[String(item.idProcesso)] = url;
          novasDesdeUltimoFlush++;
          scheduleFlush();
        }
      } catch {
        /* item segue sem URL — dashboard mantém disabled */
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrencyCa, fila.length || 1) },
    () => worker()
  );
  await Promise.all(workers);
  await flush(true);
}
