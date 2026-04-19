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

import { MESSAGE_CHANNELS } from '../../shared/constants';
import type {
  PJeApiProcesso,
  PrazosProcessoColeta,
  TriagemProcesso,
  TriagemTarefaSnapshot
} from '../../shared/types';
import {
  gerarChaveAcesso,
  listarProcessosDaTarefa
} from '../pje-api/pje-api-from-content';
import { coletarTarefasSelecionadas } from './gestao-bridge';
import { coletarExpedientesViaIframe } from './prazos-fita-iframe-collector';

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

  // -- Fase 1: listagem por API, em sequencia (uma tarefa por vez) --
  const todos: InternalProcessoTask[] = [];
  const errosPorTarefa: string[] = [];
  for (const nomeTarefa of opts.nomesTarefas) {
    onProgress(`[API] listando processos da tarefa "${nomeTarefa}"...`);
    const resp = await listarProcessosDaTarefa({
      nomeTarefa,
      maxProcessos: opts.maxProcessosPorTarefa
    });
    if (!resp?.ok) {
      const err = resp?.error ?? 'erro desconhecido';
      errosPorTarefa.push(`"${nomeTarefa}": ${err}`);
      onProgress(`[API] falha listando "${nomeTarefa}": ${err}`);
      continue;
    }
    onProgress(
      `[API] "${nomeTarefa}": ${resp.processos.length}/${resp.total} processo(s) descobertos.`
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

  // -- Dedup por idProcesso (preserva a primeira tarefa em que apareceu) --
  const porId = new Map<number, InternalProcessoTask>();
  for (const item of todos) {
    if (item.processoApi.idProcesso <= 0) continue;
    if (!porId.has(item.processoApi.idProcesso)) {
      porId.set(item.processoApi.idProcesso, item);
    }
  }
  const unicos = Array.from(porId.values());
  onProgress(
    `[API] ${unicos.length} processo(s) unicos a coletar (de ${todos.length} totais).`
  );

  // -- Fase 2: pool concorrente: resolver ca + montar URL + coletar expedientes --
  // Default 4 (antes 2): com iframe same-origin o custo por processo deixa
  // de disputar criacao de tab com o Chrome, entao podemos rodar mais em
  // paralelo sem tanto risco de congelar a UI. Clamp ate 8 — acima disso o
  // servidor PJe fica saturado com varreduras de 300+ processos.
  const concurrency = clamp(opts.concurrency ?? 4, 1, 8);
  const consolidados: ConsolidadoViaAPI[] = new Array(unicos.length);
  let proximo = 0;
  let concluidos = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = proximo++;
      if (idx >= unicos.length) return;
      const item = unicos[idx];
      const { tarefaNome, processoApi } = item;
      let url: string | null = null;
      let coleta: PrazosProcessoColeta | null = null;
      let error: string | undefined;

      try {
        const ca = await gerarChaveAcesso(processoApi.idProcesso);
        if (!ca?.ok || !ca.ca) {
          error = ca?.error ?? 'Falha resolvendo chave de acesso.';
        } else {
          const params = new URLSearchParams();
          params.set('idProcesso', String(processoApi.idProcesso));
          params.set('ca', ca.ca);
          if (processoApi.idTaskInstance != null) {
            params.set('idTaskInstance', String(processoApi.idTaskInstance));
          }
          url = `${legacyOrigin}/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam?${params.toString()}`;

          // Iframe oculto no DOM do proprio painel: mesmo origin, sem
          // overhead de `chrome.tabs.create` + bridge ao service worker.
          // Cai para o caminho antigo (via background) se o iframe nao
          // conseguir obter `contentDocument` (improvavel em same-origin).
          coleta = await coletarExpedientesViaIframe({
            url,
            timeoutMs: opts.timeoutPorProcessoMs
          });
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      consolidados[idx] = { tarefaNome, processoApi, url, coleta, error };
      concluidos++;
      onProgress(
        `[expedientes] ${concluidos}/${unicos.length} — ${
          processoApi.numeroProcesso ?? `id ${processoApi.idProcesso}`
        }${error ? ` (erro: ${error})` : ''}`
      );
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, unicos.length) },
    () => worker()
  );
  await Promise.all(workers);

  return {
    totalDescobertos: todos.length,
    consolidado: consolidados,
    tempoTotalMs: Date.now() - t0
  };
}
