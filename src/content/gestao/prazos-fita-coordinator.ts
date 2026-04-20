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
  gerarChaveAcesso,
  lerSnapshotAuth,
  listarProcessosDaTarefa
} from '../pje-api/pje-api-from-content';
import {
  decodeJwtExp,
  solicitarRefreshSilent
} from '../auth/pje-auth-refresh-bridge';
import { coletarTarefasSelecionadas } from './gestao-bridge';
import { coletarExpedientesViaFetch } from './prazos-fita-fetch-collector';
import {
  apagarEstado,
  computeScanId,
  lerEstado,
  salvarEstado
} from './prazos-fita-scan-state';
import { startScan } from '../../shared/telemetry';

/**
 * Limpa o cache morto de `ca` que existia em `chrome.storage.local` na
 * versao anterior. Rodava como otimizacao para reaproveitar
 * `chaveAcessoProcesso` entre varreduras — mas no PJe TRF5 a `ca` expira
 * silenciosamente (servidor responde 200 com stub, sem tbody), o que
 * levava a coletas aparentemente bem-sucedidas com "0 expedientes" em
 * ~99% dos processos. Sem forma confiavel de revalidar a chave cacheada
 * sem refazer a propria requisicao completa, o custo do cache passou a
 * ser maior que o ganho: removido por completo.
 *
 * A remocao e idempotente e silenciosa — so serve para limpar os 1000+
 * itens residuais de usuarios que ja tinham o cache populado. Pode ser
 * retirada em uma versao futura quando tivermos certeza que nenhuma
 * instalacao antiga persiste a chave.
 */
async function limparCacheCaLegado(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORAGE_KEYS.PRAZOS_FITA_CA_CACHE);
  } catch {
    /* ignore: limpeza e best-effort */
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
 * Reconhece erros transientes pos-retry da fase de expedientes: "Failed
 * to fetch" (TypeError do browser em rede instavel/rate limit), timeout
 * do AbortController, HTTP 429 e HTTP 5xx. Esses erros justificam NAO
 * consolidar o slot — ele vai ficar `null` no checkpoint e sera recoletado
 * quando o usuario relancar com "retomar". Erros definitivos (404, 400,
 * etc.) permanecem consolidados com `error` preenchido.
 */
function eErroTransienteMsg(errorMsg: string | undefined | null): boolean {
  if (!errorMsg) return false;
  // Failed to fetch / NetworkError: emitido como TypeError.message
  if (/failed to fetch/i.test(errorMsg)) return true;
  if (/network\s*error/i.test(errorMsg)) return true;
  // Timeout do AbortController local (DOMException.name === 'TimeoutError')
  if (/\btimeout\b/i.test(errorMsg)) return true;
  // Http status classes transientes
  if (/\bHTTP\s*429\b/i.test(errorMsg)) return true;
  if (/\bHTTP\s*5\d\d\b/i.test(errorMsg)) return true;
  return false;
}

/**
 * Tempo maximo que um worker fica aguardando o refresh silencioso do
 * token Keycloak apos detectar 403. 90s cobre varias tentativas de iframe
 * cross-origin (cada uma pode levar ate 25s quando a aba esta em
 * background e o Chrome throttla), alem de backoff entre elas.
 */
const REFRESH_TIMEOUT_MS = 90_000;

/**
 * Margem em ms antes do `exp` do JWT em que disparamos refresh proativo.
 * 45s: cobre o pior caso de iframe cross-origin (25s) + backoff + retry,
 * com folga para a chamada REST que vai usar o token novo. Reduzir isso
 * re-introduz o storm de 403 quando 25 workers pegam tokens expirando
 * no mesmo instante.
 */
const JWT_PROACTIVE_MARGIN_MS = 45_000;

/**
 * Garante que o token corrente ainda tera validade suficiente para a
 * proxima chamada REST. Se o JWT esta a menos de `JWT_PROACTIVE_MARGIN_MS`
 * de expirar, dispara silent refresh ANTES de tentar a requisicao. O
 * `inflight` de `solicitarRefreshSilent` coalesca — 25 workers chamando
 * simultaneamente compartilham UMA unica requisicao.
 *
 * Por que proativo: em varreduras 2k+ (~20min), o token (~5min) expira
 * varias vezes no meio. Sem refresh proativo, os 25 workers batem em
 * 403 simultaneamente, o Angular do PJe (se a aba estiver em background)
 * nao renova sozinho, e o fallback do iframe pode falhar por throttle.
 * Melhor gastar 1 refresh planejado antes do storm que 25 falhas depois.
 *
 * Silencioso em falha: se o refresh proativo falhar, o fluxo segue para
 * a chamada REST normal — o 403 resultante vai acionar o retry ativo
 * em `gerarCaComRetryEmRefresh`, sem regressao do caminho atual.
 */
async function garantirTokenFresco(
  onProgress: (msg: string) => void
): Promise<void> {
  const snap = await lerSnapshotAuth();
  if (!snap?.authorization) return;
  const jwtExpSec = decodeJwtExp(snap.authorization);
  if (jwtExpSec == null) return;
  const expMs = jwtExpSec * 1_000;
  if (expMs - Date.now() > JWT_PROACTIVE_MARGIN_MS) return;
  // Log apenas quando disparamos — em N workers, o `inflight` garante 1 log.
  onProgress('[auth] token proximo do vencimento, renovando proativamente...');
  try {
    await solicitarRefreshSilent();
  } catch {
    /* ignore: coberto pelo retry reativo em caso de 403 */
  }
}

/**
 * Chama `gerarChaveAcesso` com recuperacao automatica de 403:
 *
 *  1. Se der 403 (mesmo apos o silent refresh interno de `gerarChaveAcesso`),
 *     dispara `solicitarRefreshSilent()` em loop ATIVO com backoff, ate
 *     `REFRESH_TIMEOUT_MS`. Em cada tentativa bem-sucedida, re-executa
 *     `gerarChaveAcesso` (que le o snapshot atualizado).
 *  2. Se esgotar o budget, devolve o 403 original — coordinator seta
 *     `authExpired` e aborta com mensagem instruindo o usuario.
 *
 * Por que ativo em vez de `aguardarNovoSnapshot`: o wait passivo depende
 * do Angular do PJe fazer alguma REST que atualize o snapshot via
 * interceptor. Em aba em background (situacao tipica de varreduras longas,
 * o usuario ja trocou de aba), o Chrome throttla e isso pode nunca
 * acontecer. Retries ativos do iframe eventualmente passam (Chrome libera
 * quando a aba volta a foco, ou simplesmente pelo aquecimento DNS/socket
 * da segunda tentativa).
 *
 * Coalescing via `inflight` de `solicitarRefreshSilent` — N workers
 * concorrentes em 403 compartilham UMA refresh attempt.
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
  onProgress(
    '[auth] token do PJe expirou, tentando renovar em background...'
  );
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  let tentativa = 0;
  let ultimo: Awaited<ReturnType<typeof gerarChaveAcesso>> = primeira;
  while (Date.now() < deadline) {
    tentativa++;
    const refresh = await solicitarRefreshSilent();
    if (refresh.ok) {
      onProgress('[auth] token renovado, retomando varredura.');
      const segunda = await gerarChaveAcesso(idProcesso);
      if (segunda?.ok || !eErro403(segunda?.error)) {
        return { caResp: segunda, aguardouRefresh: true };
      }
      // Refresh disse ok mas servidor ainda devolveu 403 — pode ser clock
      // skew entre iframe e servidor. Continua tentando ate o deadline.
      ultimo = segunda;
    }
    const restante = deadline - Date.now();
    if (restante <= 0) break;
    // Backoff exponencial: 2s, 4s, 8s, cap 15s. Em paralelo, o Chrome
    // pode liberar o iframe (usuario volta pra aba, etc).
    const waitMs = Math.min(15_000, 2_000 * Math.pow(2, tentativa - 1));
    await new Promise((res) => setTimeout(res, Math.min(waitMs, restante)));
  }
  return { caResp: ultimo, aguardouRefresh: true };
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
    onProgress: (m) => {
      // `[unidade]` e um sinal estruturado consumido pelo cabecalho da
      // aba de varredura — nao podemos embrulhar em `[snapshots]` ou o
      // regex da aba-painel deixa de casar e a vara nao aparece.
      if (m.startsWith('[unidade] ')) {
        onProgress(m);
        return;
      }
      onProgress(`[snapshots] ${m}`);
    }
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
  /**
   * Callbacks de streaming progressivo. Quando fornecidos, permitem ao
   * chamador abrir o dashboard ANTES da coleta terminar:
   *   1. `onEnumerated` dispara logo que a enumeracao (Fase 1) conclui
   *      e `unicos.length` esta estavel. O chamador deve gravar o
   *      skeleton no IDB e navegar a aba-painel pro dashboard.
   *   2. `onSlot` dispara para cada processo coletado (sucesso, erro
   *      definitivo ou transiente ja "resolvido"). O chamador grava no
   *      IDB como slot:idx e faz broadcast pro dashboard.
   *   3. `onFinalized` dispara no fim — ok ou abort.
   *
   * Opcionais: o pipeline funciona igual sem eles (caminho legado:
   * tudo num unico COLETA_DONE no final).
   */
  onEnumerated?: (meta: StreamingEnumeratedMeta) => void | Promise<void>;
  onSlot?: (idx: number, item: ConsolidadoViaAPI) => void | Promise<void>;
  /**
   * Reemissao de um slot ja presente no checkpoint de retomada. Semantica
   * identica a `onSlot`, mas o chamador deve gravar no IDB sem mexer no
   * contador `meta.consolidados` — o init do skeleton ja nasceu com
   * `consolidadosInicial = X`. Se omitido, o coordinator cai de volta em
   * `onSlot` (comportamento legado, que mostrava o card subindo de 0).
   */
  onHydrateSlot?: (idx: number, item: ConsolidadoViaAPI) => void | Promise<void>;
  onFinalized?: (args: StreamingFinalizedArgs) => void | Promise<void>;
}

/** Payload do callback `onEnumerated` (Fase 1 concluida). */
export interface StreamingEnumeratedMeta {
  /** Total de processos unicos pos-dedup+filtros+teto. */
  total: number;
  /** Total antes da dedup (soma das tarefas). */
  totalDescobertos: number;
  /** Hostname do PJe de origem (para o IDB meta). */
  hostnamePJe: string;
  /** Nomes de tarefas informados pelo usuario. */
  tarefasSelecionadas: string[];
  /** Nome extraido da vara (primeira ocorrencia), quando detectavel. */
  nomeUnidade: string | null;
  /** ISO do inicio do scan (ou do scan retomado). */
  geradoEm: string;
  /**
   * Em retomada, quantos processos ja estavam coletados no checkpoint.
   * Usado pelo dashboard para abrir com o card "Processos" em `X/total`
   * em vez de `0/total` enquanto os slots sao reemitidos por hidratacao.
   * Omitido (ou 0) em scans novos.
   */
  consolidadosInicial?: number;
}

/** Payload do callback `onFinalized`. */
export interface StreamingFinalizedArgs {
  status: 'done' | 'aborted';
  tempoTotalMs: number;
  abortadoEm?: string;
  erroAbort?: string;
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

  // Telemetria: mede o comportamento das varreduras grandes (tempo por fase,
  // taxa de 403, cache hits, retomadas). Sem efeito sobre a coleta — todos
  // os métodos do handle são tolerantes a falha de storage.
  const scan = startScan('prazos-fita', {
    tarefas: opts.nomesTarefas.length,
    retomar: Boolean(opts.retomar),
    concurrencyPedida: opts.concurrency ?? 25,
    diasMinNaTarefa: filtros.diasMinNaTarefa,
    maxProcessosTotal: filtros.maxProcessosTotal
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
      scan.counter('retomada');
      scan.mergeMeta({ retomadoConcluidos: concluidos, totalUnicos: unicos.length });
      onProgress(
        `[retomar] ${concluidos}/${unicos.length} processo(s) ja coletados no checkpoint anterior. Continuando...`
      );
    }
  }

  if (!retomado) {
    // -- Fase 1: listagem por API, em sequencia (uma tarefa por vez) --
    const endListar = scan.phase('listar-tarefas');
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
      await endListar({
        tarefasOk: 0,
        tarefasErro: errosPorTarefa.length,
        totalDescobertos: 0
      });
      await scan.fail('Nenhuma tarefa pode ser lida via API.', {
        errosPorTarefa
      });
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
    await endListar({
      tarefasOk: opts.nomesTarefas.length - errosPorTarefa.length,
      tarefasErro: errosPorTarefa.length,
      totalDescobertos,
      unicosAposFiltros: unicos.length
    });
    if (errosPorTarefa.length > 0) {
      scan.counter('tarefas-listar-erro', errosPorTarefa.length);
    }
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

  // Streaming: dashboard abre agora, com cartoes em "0/unicos.length".
  // Feito apos a ordenacao por antiguidade + aplicacao de teto, para que
  // o idx dos slots bata com a ordem final de renderizacao. Em retomada
  // tambem emitimos — o chamador precisa do meta para reidratar o IDB.
  if (opts.onEnumerated) {
    try {
      await opts.onEnumerated({
        total: unicos.length,
        totalDescobertos,
        hostnamePJe,
        tarefasSelecionadas: opts.nomesTarefas,
        nomeUnidade: nomeUnidade ?? null,
        geradoEm: new Date(startedAt).toISOString(),
        consolidadosInicial: retomado ? concluidos : 0
      });
    } catch (err) {
      onProgress(
        `[aviso] falha emitindo skeleton de streaming: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Em retomada com streaming: re-emite os slots ja consolidados para
  // hidratar o dashboard recem-aberto. Sem isso, ele abriria vazio e o
  // usuario veria so os slots coletados DAQUI pra frente. Usa
  // `onHydrateSlot` quando disponivel — esse caminho grava o slot sem
  // mexer no contador `consolidados`, que ja nasceu no valor certo
  // no skeleton. Fallback para `onSlot` preserva o comportamento legado.
  const reemit = opts.onHydrateSlot ?? opts.onSlot;
  if (retomado && reemit) {
    for (let i = 0; i < consolidados.length; i++) {
      const c = consolidados[i];
      if (c == null) continue;
      try {
        await reemit(i, c);
      } catch {
        /* ignore: streaming nao deve quebrar a retomada */
      }
    }
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

  // `ca` (chaveAcessoProcesso) e gerada fresca para cada processo. Antes
  // havia cache persistente em `chrome.storage.local`, mas a `ca` expira
  // silenciosamente no servidor (200 com stub em vez de 4xx), gerando
  // coletas com "0 expedientes" em ~99% dos processos sem erro visivel.
  // Limpa entradas residuais de instalacoes antigas (no-op se vazio).
  void limparCacheCaLegado();

  // Flag compartilhada entre workers: se qualquer um detectar 403 no
  // `gerarChaveAcesso`, todos paramos de pegar trabalho novo. Melhor
  // abortar cedo que listar centenas de "erro: HTTP 403" no log.
  let authExpired = false;
  let authExpiredAtProcId = 0;
  // Contador de slots deixados em `null` por erro transiente (pos-retry).
  // Sao preservados no checkpoint para retomada — o dashboard abre com o
  // que foi consolidado, e a proxima varredura com "retomar" recoleta estes.
  let pendentesTransientes = 0;

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
      let caValor: string | null = null;

      try {
        // Proativo: se o JWT esta a menos de 45s de expirar, dispara
        // refresh ANTES de bater no servidor. Coalesce via `inflight` —
        // N workers concorrentes viram 1 refresh. Evita o storm de 403
        // que antes derrubava varreduras 2k+.
        await garantirTokenFresco(onProgress);
        const { caResp } = await gerarCaComRetryEmRefresh(
          processoApi.idProcesso,
          onProgress
        );
        if (!caResp?.ok || !caResp.ca) {
          if (eErro403(caResp?.error)) {
            authExpired = true;
            authExpiredAtProcId = processoApi.idProcesso;
            // Deixa `consolidados[idx]` como null — auth-expirado e
            // transiente do ponto de vista da retomada: basta o usuario
            // renovar a sessao no PJe e relancar. Consolidar com erro
            // aqui faria o slot ser pulado (`if (consolidados[idx] != null)`)
            // e o processo 3090332-equivalente nunca seria recoletado.
            return;
          }
          error = caResp?.error ?? 'Falha resolvendo chave de acesso.';
        } else {
          caValor = caResp.ca;
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

      // Classificacao do slot:
      //  - erro transiente pos-retry (Failed to fetch, timeout, 429, 5xx):
      //    nao consolida — deixa consolidados[idx] = null para permitir
      //    retomada; nao conta em `concluidos`.
      //  - erro definitivo (ca nao resolvida, HTTP 4xx nao-429, etc.):
      //    consolida com `error` preenchido — nao vale recoletar.
      //  - sucesso ou coleta.ok === true: consolida normalmente.
      const msgErroColeta =
        coleta && coleta.ok === false ? coleta.error : undefined;
      const msgTransienteRaiz =
        (msgErroColeta && eErroTransienteMsg(msgErroColeta) && msgErroColeta) ||
        (error && eErroTransienteMsg(error) && error) ||
        null;
      if (msgTransienteRaiz) {
        pendentesTransientes++;
        concluidosDesdeUltimoCheckpoint++;
        onProgress(
          `[expedientes] ${concluidos}/${unicos.length} — ${
            processoApi.numeroProcesso ?? `id ${processoApi.idProcesso}`
          } (pendente transiente: ${msgTransienteRaiz})`
        );
      } else {
        const slot: ConsolidadoViaAPI = {
          tarefaNome,
          processoApi,
          url,
          coleta,
          error
        };
        consolidados[idx] = slot;
        concluidos++;
        concluidosDesdeUltimoCheckpoint++;
        onProgress(
          `[expedientes] ${concluidos}/${unicos.length} — ${
            processoApi.numeroProcesso ?? `id ${processoApi.idProcesso}`
          }${error ? ` (erro: ${error})` : ''}`
        );
        // Streaming: propaga o slot recem-consolidado. Best-effort — se
        // o chamador (background) explodir, a coleta continua.
        if (opts.onSlot) {
          try {
            await opts.onSlot(idx, slot);
          } catch {
            /* ignore */
          }
        }
      }
      if (concluidosDesdeUltimoCheckpoint >= CHECKPOINT_INTERVA) {
        concluidosDesdeUltimoCheckpoint = 0;
        // Fire-and-forget: nao bloqueia o worker; se falhar, GC limpa
        // depois. Storage nao precisa ser atomico aqui.
        void persistirCheckpoint();
      }
    }
  };

  const endFetch = scan.phase('fetch-expedientes');
  const workers = Array.from(
    { length: Math.min(concurrency, unicos.length) },
    () => worker()
  );
  await Promise.all(workers);
  await endFetch({
    unicos: unicos.length,
    concluidos,
    concurrency,
    authExpired
  });

  if (authExpired) {
    // Salva checkpoint com o estado parcial antes de abortar — o
    // usuario pode relancar com "retomar" quando renovar a sessao.
    await persistirCheckpoint();
    scan.counter('auth-expired');
    await scan.fail('auth-expired', {
      parciaisPreservados: concluidos,
      authExpiredAtProcId
    });
    const mensagemAbort =
      `Token do PJe expirou e nao foi renovado automaticamente em 60s ` +
      `(HTTP 403 no processo ${authExpiredAtProcId}). ` +
      'Clique em qualquer tarefa no painel do PJe para renovar a sessao e relance a varredura — ' +
      'a varredura continuara de onde parou (checkpoint preservado). ' +
      'Dica: mantenha uma aba do PJe ativa durante varreduras longas — o Angular renova o token em background apenas quando a aba esta visivel.';
    // Streaming: finaliza o dashboard em estado aborted. Feito ANTES do
    // throw para garantir que o dashboard ja aberto (se estiver) saia do
    // "running" e mostre o toast — o throw sobe para o handler legado
    // que emite COLETA_FAIL, que continua funcional.
    if (opts.onFinalized) {
      try {
        await opts.onFinalized({
          status: 'aborted',
          tempoTotalMs: Date.now() - t0,
          abortadoEm: new Date().toISOString(),
          erroAbort: mensagemAbort
        });
      } catch {
        /* ignore */
      }
    }
    throw new Error(mensagemAbort);
  }

  if (pendentesTransientes > 0) {
    // Varredura incompleta: ha slots deixados em `null` por erros
    // transientes (Failed to fetch, timeout, 429, 5xx) mesmo apos os
    // retries locais. Preserva o checkpoint para que o usuario possa
    // relancar e a UI oferecera "retomar" — so os pendentes serao
    // recoletados. Ainda geramos o dashboard com o parcial para que o
    // trabalho ate aqui nao se perca.
    await persistirCheckpoint();
    scan.counter('pendentes-transientes', pendentesTransientes);
    onProgress(
      `[aviso] ${pendentesTransientes} processo(s) com falha transiente — ` +
        `checkpoint preservado. Relance a varredura e confirme "retomar" ` +
        `para recoletar apenas os pendentes.`
    );
  } else {
    // Sucesso total: limpa checkpoint — nao precisamos reter 5000
    // processos em disco apos o dashboard ter sido gerado.
    await apagarEstado(scanId);
  }

  // Normaliza consolidados para filtrar posicoes null (slots pendentes
  // transientes, que serao recoletados na proxima varredura com retomar).
  const consolidadoFinal = consolidados.filter(
    (c): c is ConsolidadoViaAPI => c != null
  );

  await scan.success({
    totalDescobertos,
    consolidados: consolidadoFinal.length,
    pendentesTransientes,
    tempoTotalMs: Date.now() - t0
  });

  const tempoTotalMs = Date.now() - t0;

  // Streaming: marca o dashboard como concluido. O background ja recebeu
  // todos os SLOT_PATCH durante a coleta — aqui so liberamos a coluna
  // "Encerrar" e trocamos a contagem para o numero final.
  if (opts.onFinalized) {
    try {
      await opts.onFinalized({ status: 'done', tempoTotalMs });
    } catch {
      /* ignore */
    }
  }

  return {
    totalDescobertos,
    consolidado: consolidadoFinal,
    tempoTotalMs
  };
}
