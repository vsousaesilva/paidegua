/**
 * Orquestrador do painel "Prazos na fita" — Fase A2.
 *
 * Recebe uma lista de URLs de processos do PJe e dispara a coleta de
 * expedientes de cada um via `PRAZOS_FITA_COLETAR_PROCESSO` no background.
 * O background é quem abre a aba isolada, extrai e fecha; aqui só
 * coordenamos o pool de concorrência para não abrir 50 abas de uma vez
 * nem derreter o PJe servidor.
 *
 * Sem DOM. Sem adapter. Pura orquestração de mensagens + agregação —
 * isso facilita testes futuros (basta mockar `chrome.runtime.sendMessage`).
 */

import { MESSAGE_CHANNELS, STORAGE_KEYS } from '../../shared/constants';
import type {
  PJeApiProcesso,
  PrazosProcessoColeta,
  TriagemProcesso,
  TriagemTarefaSnapshot
} from '../../shared/types';
import {
  aguardarNovoSnapshot,
  gerarChaveAcesso,
  lerCapturadoEmSnapshot,
  listarProcessosDaTarefa
} from '../pje-api/pje-api-from-content';
import { coletarTarefasSelecionadas } from './gestao-bridge';
import { coletarExpedientesViaFetch } from './prazos-fita-fetch-collector';
import {
  apagarEstado,
  computeScanId,
  lerEstado,
  salvarEstado
} from './prazos-fita-scan-state';

/**
 * Carrega o cache de `ca` persistido em `chrome.storage.local`. Usar
 * `local` (nao `session`) garante que o cache sobrevive ao fechamento do
 * Chrome — cruciais nas varreduras recorrentes, onde 100% dos processos
 * ja tem `ca` conhecido e a primeira chamada (gerarChaveAcessoProcesso)
 * pode ser totalmente pulada, reduzindo pela metade o numero de HTTP
 * calls por varredura.
 *
 * Retorna Map vazio em qualquer erro — cache e apenas otimizacao, nunca
 * deve impedir a varredura.
 */
async function carregarCaCache(): Promise<Map<number, string>> {
  try {
    const out = await chrome.storage.local.get(
      STORAGE_KEYS.PRAZOS_FITA_CA_CACHE
    );
    const raw = out[STORAGE_KEYS.PRAZOS_FITA_CA_CACHE];
    if (!raw || typeof raw !== 'object') return new Map();
    const result = new Map<number, string>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v) {
        const n = Number(k);
        if (Number.isFinite(n) && n > 0) result.set(n, v);
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

/**
 * Persiste todo o Map como JSON-like em `storage.local`. Como sempre
 * chamamos com o Map carregado + adicoes desta varredura, o efeito e um
 * merge — nunca perdemos entradas previas.
 */
async function persistirCaCache(cache: Map<number, string>): Promise<void> {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of cache) obj[String(k)] = v;
    await chrome.storage.local.set({
      [STORAGE_KEYS.PRAZOS_FITA_CA_CACHE]: obj
    });
  } catch (err) {
    console.warn('[pAIdegua] persistirCaCache falhou:', err);
  }
}

/**
 * Reconhece a string de erro devolvida por `gerarChaveAcesso` quando o
 * servidor respondeu HTTP 403 — marcador canonico de token Bearer
 * expirado no meio da varredura.
 */
function eErro403(errorMsg: string | undefined | null): boolean {
  if (!errorMsg) return false;
  return /\bHTTP\s*403\b/i.test(errorMsg);
}

/**
 * Tempo maximo que um worker fica aguardando o Angular renovar o token
 * Keycloak apos detectar 403. 60s cobre a janela tipica de refresh
 * automatico; se passar disso e porque ninguem esta ativo no PJe.
 */
const REFRESH_TIMEOUT_MS = 60_000;

/**
 * Chama `gerarChaveAcesso` com recuperacao automatica de 403:
 *
 *  1. Se der 403, le o `capturedAt` atual do snapshot e aguarda
 *     `chrome.storage.onChanged` sinalizar um snapshot mais novo (o
 *     interceptor grava quando o Angular faz qualquer REST com token
 *     renovado).
 *  2. Ao detectar snapshot novo, repete `gerarChaveAcesso` — desta vez
 *     `obterSnapshot` ja le o token fresco.
 *  3. Se 60s se passarem sem refresh, desiste e devolve o 403 original
 *     (coordinator vai setar `authExpired` e abortar com mensagem
 *     instruindo o usuario).
 *
 * Acorda todos os workers de uma so vez quando o refresh chega — sem
 * polling, sem N timers independentes.
 */
async function gerarCaComRetryEmRefresh(
  idProcesso: number,
  onProgress: (msg: string) => void
): Promise<{
  caResp: Awaited<ReturnType<typeof gerarChaveAcesso>>;
  aguardouRefresh: boolean;
}> {
  const primeira = await gerarChaveAcesso(idProcesso);
  if (primeira?.ok || !eErro403(primeira?.error)) {
    return { caResp: primeira, aguardouRefresh: false };
  }
  const capturadoEm = (await lerCapturadoEmSnapshot()) ?? 0;
  onProgress(
    '[auth] token do PJe expirou, aguardando Angular renovar em background...'
  );
  const refreshOk = await aguardarNovoSnapshot(
    capturadoEm,
    REFRESH_TIMEOUT_MS
  );
  if (!refreshOk) {
    return { caResp: primeira, aguardouRefresh: true };
  }
  onProgress('[auth] token renovado, retomando varredura.');
  const segunda = await gerarChaveAcesso(idProcesso);
  return { caResp: segunda, aguardouRefresh: true };
}

export interface ColetarLoteOptions {
  urls: string[];
  /**
   * Abas simultâneas em coleta. Default 2 — equilíbrio entre velocidade
   * e carga no servidor do PJe. Clamp para [1, 5] por segurança.
   */
  concurrency?: number;
  /** Callback opcional de progresso (ex.: atualizar barra no painel). */
  onProgress?: (info: ProgressoColeta) => void;
  /** Timeout por processo (ms), repassado ao background. Default 45s. */
  timeoutPorProcessoMs?: number;
}

export interface ProgressoColeta {
  concluidos: number;
  total: number;
  url: string;
  /** Último resultado recebido; null enquanto o worker ainda não começou. */
  ultimoResultado: PrazosProcessoColeta | null;
}

/**
 * Coleta em lote com pool de concorrência. Retorna os resultados na
 * MESMA ordem das URLs de entrada — útil para cruzar com outras listas
 * (ex.: metadados da `TriagemTarefaSnapshot`).
 *
 * Nunca rejeita: falhas viram `PrazosProcessoColeta` com `ok=false`.
 */
export async function coletarPrazosEmLote(
  opts: ColetarLoteOptions
): Promise<PrazosProcessoColeta[]> {
  const urls = opts.urls;
  if (urls.length === 0) return [];

  const concurrency = clamp(opts.concurrency ?? 2, 1, 5);
  const onProgress = opts.onProgress ?? (() => {});
  const timeoutMs = opts.timeoutPorProcessoMs;

  const resultados: PrazosProcessoColeta[] = new Array(urls.length);
  let proximo = 0;
  let concluidos = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = proximo++;
      if (idx >= urls.length) return;
      const url = urls[idx];
      let resp: PrazosProcessoColeta;
      try {
        const raw = await chrome.runtime.sendMessage({
          channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETAR_PROCESSO,
          payload: { url, timeoutMs }
        });
        resp = normalizarResposta(raw, url);
      } catch (err) {
        resp = {
          url,
          ok: false,
          numeroProcesso: null,
          error: err instanceof Error ? err.message : String(err),
          duracaoMs: 0
        };
      }
      resultados[idx] = resp;
      concluidos++;
      onProgress({
        concluidos,
        total: urls.length,
        url,
        ultimoResultado: resp
      });
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, urls.length) },
    () => worker()
  );
  await Promise.all(workers);
  return resultados;
}

/**
 * Garante que qualquer resposta do background cabe no contrato
 * `PrazosProcessoColeta`. Protege contra `undefined` e campos faltantes
 * se o background for atualizado fora de sync com o content.
 */
function normalizarResposta(raw: unknown, url: string): PrazosProcessoColeta {
  if (!raw || typeof raw !== 'object') {
    return {
      url,
      ok: false,
      numeroProcesso: null,
      error: 'Resposta vazia do background.',
      duracaoMs: 0
    };
  }
  const r = raw as Partial<PrazosProcessoColeta>;
  return {
    url: r.url ?? url,
    ok: Boolean(r.ok),
    numeroProcesso: r.numeroProcesso ?? null,
    extracao: r.extracao,
    anomaliasProcesso: r.anomaliasProcesso,
    error: r.error,
    duracaoMs: typeof r.duracaoMs === 'number' ? r.duracaoMs : 0
  };
}

export interface MetricasLote {
  total: number;
  sucessos: number;
  falhas: number;
  totalAbertos: number;
  totalFechados: number;
  tempoTotalMs: number;
  tempoMedioPorUrlMs: number;
  anomaliasProcesso: Record<string, number>;
  anomaliasExpediente: Record<string, number>;
}

/**
 * Agrega métricas a partir do array de resultados. Pura — pode ser
 * chamada tanto no content quanto no painel futuro.
 *
 * `tempoTotalMs` deve vir de fora (wall-clock do chamador); as durações
 * individuais (`duracaoMs` de cada processo) são somadas só na média.
 */
export function metricasDoLote(
  resultados: PrazosProcessoColeta[],
  tempoTotalMs: number
): MetricasLote {
  const sucessos = resultados.filter((r) => r.ok).length;
  const falhas = resultados.length - sucessos;
  const totalAbertos = resultados.reduce(
    (acc, r) => acc + (r.extracao?.abertos.length ?? 0),
    0
  );
  const totalFechados = resultados.reduce(
    (acc, r) => acc + (r.extracao?.fechados ?? 0),
    0
  );
  const durSum = resultados.reduce((acc, r) => acc + r.duracaoMs, 0);

  const anomaliasProcesso: Record<string, number> = {};
  const anomaliasExpediente: Record<string, number> = {};
  for (const r of resultados) {
    for (const a of r.anomaliasProcesso ?? []) {
      anomaliasProcesso[a] = (anomaliasProcesso[a] ?? 0) + 1;
    }
    for (const e of r.extracao?.abertos ?? []) {
      for (const a of e.anomalias) {
        anomaliasExpediente[a] = (anomaliasExpediente[a] ?? 0) + 1;
      }
    }
  }

  return {
    total: resultados.length,
    sucessos,
    falhas,
    totalAbertos,
    totalFechados,
    tempoTotalMs,
    tempoMedioPorUrlMs:
      resultados.length > 0 ? Math.round(durSum / resultados.length) : 0,
    anomaliasProcesso,
    anomaliasExpediente
  };
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * Converte `dataChegadaTarefa` (ISO string ou epoch ms como string) em
 * epoch ms. Retorna null quando nao parseavel — esses processos sao
 * tratados como "sem data conhecida" (colocados no fim da ordenacao por
 * antiguidade e excluidos do filtro "ha N dias").
 */
function parseDataChegada(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Espelha a extração usada pelos dashboards: o PJe TRF5 devolve `orgao`
 * como "1º Grau / 35ª Vara Federal CE / Juiz Federal Titular" — segmentos
 * separados por "/". Pega o segmento que contém "vara"; se nenhum, cai no
 * primeiro segmento não vazio.
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

export interface ColetarPorTarefasOptions {
  /** Nomes exatos das tarefas do painel (ex.: "Controle de prazo - INSS"). */
  nomesTarefas: string[];
  /** Concorrência do pool de coleta de expedientes. */
  concurrency?: number;
  /** Callback textual de progresso (fase snapshots + fase expedientes). */
  onProgress?: (msg: string) => void;
  /** Timeout por processo na fase de expedientes. */
  timeoutPorProcessoMs?: number;
}

/**
 * Resultado consolidado: cada processo descoberto via `coletarSnapshots`
 * aparece associado à sua coleta de expedientes (ou à falha dela), mais
 * os metadados originais da tarefa em que foi encontrado.
 *
 * `processoMeta` vem de `TriagemProcesso` — útil para o painel exibir
 * classe/partes/orgão sem ter que reler o DOM do processo.
 */
export interface ProcessoExpedientesConsolidado {
  tarefaNome: string;
  processoMeta: TriagemProcesso;
  coleta: PrazosProcessoColeta;
}

export interface ResultadoColetaPorTarefas {
  /** Snapshots tal como vindos de `coletarTarefasSelecionadas`. */
  snapshots: TriagemTarefaSnapshot[];
  /** Processos deduplicados (por URL) com sua coleta de expedientes. */
  consolidado: ProcessoExpedientesConsolidado[];
  /** URLs deduplicadas efetivamente varridas. */
  urlsColetadas: string[];
  /** Tempo total wall-clock em ms (snapshots + pool). */
  tempoTotalMs: number;
}

/**
 * Pipeline completo da Fase A2: a partir dos NOMES de tarefas escolhidos
 * no painel do PJe, descobre automaticamente as URLs dos processos
 * (via `coletarTarefasSelecionadas`), despacha o pool de coleta de
 * expedientes, e devolve o resultado consolidado.
 *
 * Pré-condição: rodar no top frame de uma aba PJe com o painel do
 * usuário carregado (a mesma pré-condição já exigida pela Gestão).
 *
 * Deduplicação: se um processo aparece em mais de uma tarefa selecionada,
 * a coleta acontece uma única vez — o `consolidado` ainda lista o
 * processo em cada tarefa (referenciando a mesma `PrazosProcessoColeta`).
 */
export async function coletarPrazosPorTarefas(
  opts: ColetarPorTarefasOptions
): Promise<ResultadoColetaPorTarefas> {
  const onProgress = opts.onProgress ?? (() => {});
  const t0 = Date.now();

  onProgress(
    `Listando processos em ${opts.nomesTarefas.length} tarefa(s) selecionada(s)...`
  );
  const { ok, snapshots, error } = await coletarTarefasSelecionadas({
    nomes: opts.nomesTarefas,
    onProgress: (m) => onProgress(`[snapshots] ${m}`)
  });
  if (!ok) {
    throw new Error(error ?? 'Falha ao coletar snapshots das tarefas.');
  }

  const urlParaProcesso = new Map<
    string,
    { tarefaNome: string; processo: TriagemProcesso }
  >();
  for (const snap of snapshots) {
    for (const p of snap.processos) {
      if (!p.url) continue;
      if (!urlParaProcesso.has(p.url)) {
        urlParaProcesso.set(p.url, { tarefaNome: snap.tarefaNome, processo: p });
      }
    }
  }
  const urls = Array.from(urlParaProcesso.keys());

  onProgress(
    `${urls.length} processo(s) únicos descobertos. Iniciando coleta de expedientes...`
  );
  const resultados = await coletarPrazosEmLote({
    urls,
    concurrency: opts.concurrency,
    timeoutPorProcessoMs: opts.timeoutPorProcessoMs,
    onProgress: (p) =>
      onProgress(
        `[expedientes] ${p.concluidos}/${p.total} — ${p.ultimoResultado?.numeroProcesso ?? p.url}`
      )
  });

  const porUrl = new Map<string, PrazosProcessoColeta>();
  for (const r of resultados) porUrl.set(r.url, r);

  const consolidado: ProcessoExpedientesConsolidado[] = [];
  for (const snap of snapshots) {
    for (const p of snap.processos) {
      if (!p.url) continue;
      const coleta = porUrl.get(p.url);
      if (!coleta) continue;
      consolidado.push({
        tarefaNome: snap.tarefaNome,
        processoMeta: p,
        coleta
      });
    }
  }

  return {
    snapshots,
    consolidado,
    urlsColetadas: urls,
    tempoTotalMs: Date.now() - t0
  };
}

// ====================================================================
// Caminho via API REST do PJe (substitui o scraping para "Prazos na fita")
// ====================================================================

export interface ColetarPorTarefasViaAPIOptions {
  /** Nomes exatos das tarefas (ex.: "Controle de prazo - INSS"). */
  nomesTarefas: string[];
  /**
   * Origem do PJe legacy para montar a URL dos autos. Default:
   * `window.location.origin` — funciona quando o coordinator roda no
   * top frame do PJe (ex.: pje1g.trf5.jus.br).
   */
  legacyOrigin?: string;
  /** Concorrencia do pool de coleta de expedientes. Default 2. */
  concurrency?: number;
  /** Callback textual de progresso. */
  onProgress?: (msg: string) => void;
  /** Timeout por processo na fase de expedientes. */
  timeoutPorProcessoMs?: number;
  /** Limite duro de processos por tarefa (para testes). */
  maxProcessosPorTarefa?: number;
  /**
   * Inclui apenas processos que estao na tarefa ha pelo menos N dias
   * (proxy para "expediente proximo de vencer"). 0 ou null = sem filtro.
   */
  diasMinNaTarefa?: number | null;
  /**
   * Teto total de processos apos dedup+filtro+ordenacao por antiguidade.
   * null = sem teto. Aplicado depois de `diasMinNaTarefa`.
   */
  maxProcessosTotal?: number | null;
  /**
   * Quando true, tenta retomar um checkpoint previo cuja assinatura
   * (host + nomes + filtros) bata com a desta chamada. Se nao existir,
   * faz uma varredura do zero (equivalente a `retomar: false`).
   */
  retomar?: boolean;
}

export interface ConsolidadoViaAPI {
  tarefaNome: string;
  /** Metadados retornados pela API REST. */
  processoApi: PJeApiProcesso;
  /** URL final dos autos montada com idProcesso + ca + idTaskInstance. */
  url: string | null;
  /** Resultado da coleta de expedientes (se url foi montada com sucesso). */
  coleta: PrazosProcessoColeta | null;
  /** Quando url ficou null ou coleta falhou em etapa anterior. */
  error?: string;
}

export interface ResultadoColetaViaAPI {
  /** Total de processos descobertos (antes de dedup). */
  totalDescobertos: number;
  /** Processos unicos por idProcesso, com sua coleta. */
  consolidado: ConsolidadoViaAPI[];
  /** Tempo total wall-clock em ms. */
  tempoTotalMs: number;
}

interface InternalProcessoTask {
  tarefaNome: string;
  processoApi: PJeApiProcesso;
}

/**
 * Pipeline completo via API REST: para cada tarefa selecionada, lista
 * os processos pendentes via `PJE_API_LISTAR_PROCESSOS`, deduplica por
 * `idProcesso`, resolve `ca` e abre cada autos digitais para extrair
 * expedientes.
 *
 * Vantagens sobre o caminho de scraping:
 *  - Nao varre o painel Angular (nao precisa abrir/fechar tarefas).
 *  - Recebe `idProcesso` direto da API (sem precisar inferir do DOM).
 *  - Dispensa a URL publica de consulta (que nao tem aba Expedientes).
 *
 * Pre-condicoes:
 *  - Snapshot de auth ja capturado pelo interceptor (basta o usuario
 *    ter aberto qualquer tarefa do painel ao menos uma vez na sessao).
 *  - Coordinator rodando no top frame do PJe legacy (para
 *    `legacyOrigin` default).
 */
export async function coletarPrazosPorTarefasViaAPI(
  opts: ColetarPorTarefasViaAPIOptions
): Promise<ResultadoColetaViaAPI> {
  const onProgress = opts.onProgress ?? (() => {});
  const t0 = Date.now();
  const legacyOrigin = (
    opts.legacyOrigin ?? window.location.origin
  ).replace(/\/+$/, '');
  const hostnamePJe = (() => {
    try {
      return new URL(legacyOrigin).hostname;
    } catch {
      return window.location.hostname;
    }
  })();

  const filtros = {
    diasMinNaTarefa: opts.diasMinNaTarefa ?? null,
    maxProcessosTotal: opts.maxProcessosTotal ?? null
  };
  const scanId = await computeScanId({
    host: hostnamePJe,
    nomes: opts.nomesTarefas,
    filtros
  });

  // -- Tenta retomar checkpoint compativel --
  let unicos: InternalProcessoTask[] = [];
  let consolidados: ConsolidadoViaAPI[] = [];
  let totalDescobertos = 0;
  let concluidos = 0;
  let proximo = 0;
  let retomado = false;
  let startedAt = t0;

  if (opts.retomar) {
    const estado = await lerEstado(scanId);
    if (estado && estado.unicos.length > 0) {
      unicos = estado.unicos.map((u) => ({
        tarefaNome: u.tarefaNome,
        processoApi: u.processoApi
      }));
      consolidados = new Array(unicos.length);
      for (let i = 0; i < estado.consolidados.length && i < unicos.length; i++) {
        const c = estado.consolidados[i];
        if (c != null) {
          consolidados[i] = c;
          concluidos++;
        }
      }
      totalDescobertos = estado.totalDescobertos;
      startedAt = estado.startedAt;
      retomado = true;
      onProgress(
        `[retomar] ${concluidos}/${unicos.length} processo(s) ja coletados no checkpoint anterior. Continuando...`
      );
    }
  }

  if (!retomado) {
    // -- Fase 1: listagem por API, em sequencia (uma tarefa por vez) --
    const todos: InternalProcessoTask[] = [];
    const errosPorTarefa: string[] = [];
    for (const nomeTarefa of opts.nomesTarefas) {
      onProgress(`Coletando processos da tarefa "${nomeTarefa}" — aguarde...`);
      const resp = await listarProcessosDaTarefa({
        nomeTarefa,
        maxProcessos: opts.maxProcessosPorTarefa
      });
      if (!resp?.ok) {
        const err = resp?.error ?? 'erro desconhecido';
        errosPorTarefa.push(`"${nomeTarefa}": ${err}`);
        onProgress(`Falha ao coletar "${nomeTarefa}": ${err}`);
        continue;
      }
      onProgress(
        `Tarefa "${nomeTarefa}": ${resp.processos.length}/${resp.total} processo(s) descobertos.`
      );
      for (const p of resp.processos) {
        todos.push({ tarefaNome: nomeTarefa, processoApi: p });
      }
    }

    // Se todas as tarefas falharam, aborta com erro visivel — caso contrario
    // o painel navega para um dashboard vazio e o usuario nao ve o motivo
    // (classicamente "Sem snapshot de auth").
    if (todos.length === 0 && errosPorTarefa.length > 0) {
      throw new Error(
        `Nenhuma tarefa pode ser lida via API. ${errosPorTarefa.join(' | ')}`
      );
    }

    totalDescobertos = todos.length;

    // -- Dedup por idProcesso (preserva a primeira tarefa em que apareceu) --
    const porId = new Map<number, InternalProcessoTask>();
    for (const item of todos) {
      if (item.processoApi.idProcesso <= 0) continue;
      if (!porId.has(item.processoApi.idProcesso)) {
        porId.set(item.processoApi.idProcesso, item);
      }
    }
    let unicosLocal = Array.from(porId.values());

    // -- Filtros opcionais para reduzir pressao em unidades grandes --
    const totalAntesFiltro = unicosLocal.length;
    const diasMin = opts.diasMinNaTarefa ?? 0;
    if (diasMin > 0) {
      const agoraMs = Date.now();
      unicosLocal = unicosLocal.filter((u) => {
        const d = parseDataChegada(u.processoApi.dataChegadaTarefa);
        if (d == null) return false;
        const diasNa = Math.floor((agoraMs - d) / 86_400_000);
        return diasNa >= diasMin;
      });
      onProgress(
        `[filtro] ${totalAntesFiltro} -> ${unicosLocal.length} processo(s) com >= ${diasMin} dia(s) na tarefa.`
      );
    }

    // Ordena por antiguidade ASC (mais velho primeiro) — garante que o teto
    // `maxProcessosTotal` corta os processos MENOS criticos, nao os mais.
    unicosLocal.sort((a, b) => {
      const da = parseDataChegada(a.processoApi.dataChegadaTarefa) ?? Infinity;
      const db = parseDataChegada(b.processoApi.dataChegadaTarefa) ?? Infinity;
      return da - db;
    });

    const teto = opts.maxProcessosTotal ?? null;
    if (teto != null && teto > 0 && unicosLocal.length > teto) {
      onProgress(
        `[teto] ${unicosLocal.length} -> ${teto} processo(s) (corte pelos mais antigos).`
      );
      unicosLocal = unicosLocal.slice(0, teto);
    }

    unicos = unicosLocal;
    consolidados = new Array(unicos.length);
  }

  // Mensagem estruturada com o nome da unidade judicial — o painel da aba
  // intercepta o prefixo `[unidade]` para exibir no cabeçalho durante a
  // varredura (mesma lógica de extração usada pelos dashboards finais).
  const nomeUnidade = unicos
    .map((u) => extrairNomeVara(u.processoApi.orgaoJulgador))
    .find((n): n is string => Boolean(n));
  if (nomeUnidade) onProgress(`[unidade] ${nomeUnidade}`);

  if (!retomado) {
    onProgress(
      `${unicos.length} processo(s) únicos a coletar (de ${totalDescobertos} totais). Buscando expedientes — aguarde...`
    );
  }

  // Salva o estado inicial (antes de qualquer worker comecar) — se o
  // usuario fechar o Chrome imediatamente, temos pelo menos o unicos
  // e o setup para retomar sem refazer a Fase 1.
  const persistirCheckpoint = async (): Promise<void> => {
    await salvarEstado({
      scanId,
      nomes: opts.nomesTarefas,
      filtros,
      unicos: unicos.map((u) => ({
        tarefaNome: u.tarefaNome,
        processoApi: u.processoApi
      })),
      consolidados: consolidados.map((c) => c ?? null),
      totalDescobertos,
      hostnamePJe,
      startedAt,
      updatedAt: Date.now()
    });
  };
  if (!retomado) await persistirCheckpoint();

  // -- Fase 2: pool concorrente: resolver ca (com cache) + montar URL +
  // coletar expedientes.
  //
  // Default 25: HTTP/2 do PJe multiplexa dezenas de streams sobre UMA
  // conexao TCP. Unidades grandes (10k-20k processos) precisam de
  // concorrencia alta para caber num tempo razoavel — a 10 workers o
  // pior caso fica em 13min; a 25 cai para ~5min. Teto 30 para evitar
  // estourar rate limits do servidor sem observacao previa.
  const concurrency = clamp(opts.concurrency ?? 25, 1, 30);
  // Checkpoint a cada N processos concluidos. 100 mantem overhead
  // baixo (~0.1% do tempo total) e garante que um crash perde no
  // maximo ~20s de trabalho.
  const CHECKPOINT_INTERVA = 100;
  let concluidosDesdeUltimoCheckpoint = 0;

  // Se retomado, os workers pulam indices ja preenchidos no loop
  // (pode haver gaps — um worker pode ter completado idx=N antes de
  // idx=N-1 falhar por 403). `proximo` segue sequencial; o skip e
  // feito dentro do worker.
  proximo = 0;

  // Cache de `ca` (chaveAcessoProcesso). O token e estavel enquanto o
  // processo existir no servidor — reusa-lo entre varreduras elimina a
  // chamada `gerarChaveAcessoProcesso` (Bearer, sujeita a 403 por token
  // Keycloak expirado).
  const caCache = await carregarCaCache();
  let caCacheHits = 0;

  // Flag compartilhada entre workers: se qualquer um detectar 403 no
  // `gerarChaveAcesso`, todos paramos de pegar trabalho novo. Melhor
  // abortar cedo que listar centenas de "erro: HTTP 403" no log.
  let authExpired = false;
  let authExpiredAtProcId = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (authExpired) return;
      const idx = proximo++;
      if (idx >= unicos.length) return;
      // Retomada: pula o que ja foi consolidado em varredura anterior.
      if (consolidados[idx] != null) continue;
      const item = unicos[idx];
      const { tarefaNome, processoApi } = item;
      let url: string | null = null;
      let coleta: PrazosProcessoColeta | null = null;
      let error: string | undefined;
      let caValor: string | null = caCache.get(processoApi.idProcesso) ?? null;

      try {
        if (!caValor) {
          const { caResp } = await gerarCaComRetryEmRefresh(
            processoApi.idProcesso,
            onProgress
          );
          if (!caResp?.ok || !caResp.ca) {
            if (eErro403(caResp?.error)) {
              authExpired = true;
              authExpiredAtProcId = processoApi.idProcesso;
              consolidados[idx] = {
                tarefaNome,
                processoApi,
                url: null,
                coleta: null,
                error: 'auth expirado (HTTP 403) — varredura abortada.'
              };
              return;
            }
            error = caResp?.error ?? 'Falha resolvendo chave de acesso.';
          } else {
            caValor = caResp.ca;
            caCache.set(processoApi.idProcesso, caValor);
          }
        } else {
          caCacheHits++;
        }

        if (caValor && !error) {
          const params = new URLSearchParams();
          params.set('idProcesso', String(processoApi.idProcesso));
          params.set('ca', caValor);
          if (processoApi.idTaskInstance != null) {
            params.set('idTaskInstance', String(processoApi.idTaskInstance));
          }
          // `aba=processoExpedienteTab` forca o SSR a ja renderizar a aba
          // Expedientes na resposta inicial — elimina o postback A4J que
          // antes obrigava a usar iframe para clicar na aba.
          params.set('aba', 'processoExpedienteTab');
          url = `${legacyOrigin}/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam?${params.toString()}`;

          coleta = await coletarExpedientesViaFetch({
            url,
            timeoutMs: opts.timeoutPorProcessoMs
          });
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      consolidados[idx] = { tarefaNome, processoApi, url, coleta, error };
      concluidos++;
      concluidosDesdeUltimoCheckpoint++;
      onProgress(
        `[expedientes] ${concluidos}/${unicos.length} — ${
          processoApi.numeroProcesso ?? `id ${processoApi.idProcesso}`
        }${error ? ` (erro: ${error})` : ''}`
      );
      if (concluidosDesdeUltimoCheckpoint >= CHECKPOINT_INTERVA) {
        concluidosDesdeUltimoCheckpoint = 0;
        // Fire-and-forget: nao bloqueia o worker; se falhar, GC limpa
        // depois. Storage nao precisa ser atomico aqui.
        void persistirCheckpoint();
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, unicos.length) },
    () => worker()
  );
  await Promise.all(workers);

  // Persiste o cache (load + novos `ca` desta varredura) ao final. Feito
  // aqui em vez de a cada novo `ca` para evitar N writes no storage em
  // 2000+ processos.
  await persistirCaCache(caCache);
  if (caCacheHits > 0) {
    onProgress(
      `[cache] ${caCacheHits} chave(s) de acesso reaproveitadas do cache.`
    );
  }

  if (authExpired) {
    // Salva checkpoint com o estado parcial antes de abortar — o
    // usuario pode relancar com "retomar" quando renovar a sessao.
    await persistirCheckpoint();
    throw new Error(
      `Token do PJe expirou e nao foi renovado automaticamente em 60s ` +
        `(HTTP 403 no processo ${authExpiredAtProcId}). ` +
        'Clique em qualquer tarefa no painel do PJe para renovar a sessao e relance a varredura — ' +
        'a varredura continuara de onde parou (checkpoint preservado). ' +
        'Dica: mantenha uma aba do PJe ativa durante varreduras longas — o Angular renova o token em background apenas quando a aba esta visivel.'
    );
  }

  // Sucesso: limpa checkpoint — nao precisamos reter 5000 processos em
  // disco apos o dashboard ter sido gerado.
  await apagarEstado(scanId);

  // Normaliza consolidados para filtrar eventuais posicoes null (nao
  // deveria ocorrer em sucesso; defesa contra bug futuro).
  const consolidadoFinal = consolidados.filter(
    (c): c is ConsolidadoViaAPI => c != null
  );

  return {
    totalDescobertos,
    consolidado: consolidadoFinal,
    tempoTotalMs: Date.now() - t0
  };
}
