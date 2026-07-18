/**
 * Coletor de Ordens PREVJUD (perfil Gestão — GES-10).
 *
 * Roda no top frame do PJe legacy. Fluxo:
 *   1. Lista os processos de cada tarefa selecionada via
 *      `listarProcessosDaTarefa` (REST do PJe) e deduplica por `idProcesso`.
 *   2. Pré-filtra pelo conjunto de ETIQUETAS ESCOLHIDAS pelo usuário — só os
 *      processos que casam entram na coleta cara (abrir aba). A vara costuma
 *      etiquetar com "INSS intimado em…"; sem esse filtro varreríamos milhares
 *      de processos sem ordem. Lista de etiquetas vazia = sem filtro.
 *   3. Para cada candidato: resolve a URL dos autos (`montarUrlAutos`) e pede
 *      ao background (`PREVJUD_COLETAR_PROCESSO`) a raspagem da tabela
 *      "Intimações INSS" via aba inativa + A4J em main world.
 *   4. Normaliza as linhas (`normalizarOrdemPrevjud`) e descarta processos sem
 *      ordem (tabela vazia). Monta `PrevjudDashboardPayload`.
 *
 * Não há endpoint REST para as ordens — ver
 * `docs/extracao-ordens-prevjud-pje.md`.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../../shared/constants';
import type {
  OrdemPrevjud,
  PJeApiProcesso,
  PJeAuthSnapshot,
  PrevjudColetaApiResult,
  PrevjudColetaConfig,
  PrevjudColetaProcessoResult,
  PrevjudDashboardPayload,
  ProcessoOrdensPrevjud
} from '../../shared/types';
import {
  listarProcessosDaTarefa,
  montarUrlAutos
} from '../pje-api/pje-api-from-content';
import {
  normalizarOrdemPrevjud,
  ordemPendente,
  statusOrdemIgnorado
} from '../../shared/prevjud-parser';
import { coletarOrdensPrevjudViaSSR } from './prevjud-ssr';

export interface ColetorPrevjudInput {
  requestId: string;
  hostnamePJe: string;
  legacyOrigin: string;
  config: PrevjudColetaConfig;
  onProgress?: (msg: string) => void;
}

export interface ColetorPrevjudResult {
  ok: boolean;
  payload?: PrevjudDashboardPayload;
  error?: string;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Lê a localização (lotação) do snapshot de auth capturado sob o perfil em que
 * o usuário abriu a feature. Vira o `X-pje-usuario-localizacao` EXPLÍCITO da
 * escrita de etiquetas (via rota), imune à poluição posterior do snapshot
 * global por outro perfil aberto. Ver `docs/migracao-etiquetas-pje-v11.md`.
 */
async function lerLocalizacaoSnapshot(): Promise<string | null> {
  try {
    const r = await chrome.storage.session.get(STORAGE_KEYS.PJE_AUTH_SNAPSHOT);
    const snap = r?.[STORAGE_KEYS.PJE_AUTH_SNAPSHOT] as PJeAuthSnapshot | undefined;
    const loc = snap?.pjeUsuarioLocalizacao;
    return typeof loc === 'string' && loc.trim() ? loc.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Casa o processo contra as etiquetas de filtro escolhidas pelo usuário.
 * O casamento é por SUBSTRING (case-insensitive) — assim "INSS intimado em"
 * pega todas as variantes datadas ("INSS intimado em 02/07/2026", …). Modo
 * `qualquer`: basta uma etiqueta do processo conter algum filtro. Modo
 * `todas`: cada filtro precisa ser encontrado em alguma etiqueta.
 */
function casaEtiquetas(
  p: PJeApiProcesso,
  filtroNorm: string[],
  modo: 'qualquer' | 'todas'
): boolean {
  if (filtroNorm.length === 0) return true; // sem filtro = todos
  const tags = (p.etiquetas ?? []).map(norm);
  const contem = (f: string): boolean => tags.some((t) => t.includes(f));
  return modo === 'todas' ? filtroNorm.every(contem) : filtroNorm.some(contem);
}

export async function coletarOrdensPrevjud(
  input: ColetorPrevjudInput
): Promise<ColetorPrevjudResult> {
  const progress = input.onProgress ?? ((): void => {});
  const { config } = input;
  const modo = config.etiquetaModo ?? 'qualquer';
  const filtroNorm = (config.etiquetasFiltro ?? [])
    .map(norm)
    .filter((s) => s.length > 0);
  const statusIgnorar = config.statusIgnorar ?? [];

  if (!config.nomesTarefas || config.nomesTarefas.length === 0) {
    return { ok: false, error: 'Nenhuma tarefa selecionada para a coleta.' };
  }

  // -- Fase 1: listar processos por tarefa e deduplicar --
  const porId = new Map<number, PJeApiProcesso>();
  /** Tarefa de origem de cada processo — usada pela sonda de rota da API. */
  const tarefaPorId = new Map<number, string>();
  const tarefasOk: string[] = [];
  const erros: string[] = [];
  for (const nome of config.nomesTarefas) {
    progress(`[listar] tarefa "${nome}"...`);
    const resp = await listarProcessosDaTarefa({ nomeTarefa: nome });
    if (!resp.ok) {
      erros.push(`"${nome}": ${resp.error ?? 'erro desconhecido'}`);
      progress(`[listar] falha em "${nome}": ${resp.error ?? 'erro'}`);
      continue;
    }
    tarefasOk.push(nome);
    for (const p of resp.processos) {
      if (p.idProcesso > 0 && !porId.has(p.idProcesso)) {
        porId.set(p.idProcesso, p);
        tarefaPorId.set(p.idProcesso, nome);
      }
    }
    progress(
      `[listar] "${nome}": ${resp.processos.length}/${resp.total} processo(s).`
    );
  }

  const processosNaTarefa = porId.size;
  if (processosNaTarefa === 0) {
    const msg =
      erros.length > 0
        ? `Não foi possível listar processos: ${erros.join(' | ')}`
        : 'As tarefas selecionadas não têm processos pendentes.';
    return { ok: false, error: msg };
  }

  // -- Fase 2: pré-filtro por etiqueta escolhida pelo usuário --
  const candidatos = Array.from(porId.values()).filter((p) =>
    casaEtiquetas(p, filtroNorm, modo)
  );
  progress(
    `[filtro] ${candidatos.length}/${processosNaTarefa} candidato(s) ` +
      `após filtro de etiqueta` +
      (filtroNorm.length > 0 ? ` (${config.etiquetasFiltro.join(', ')})` : ' (sem filtro)') +
      '.'
  );

  // Localização (lotação) do perfil sob o qual os processos foram listados —
  // capturada AGORA (contexto certo), enviada ao background para virar o
  // `X-pje-usuario-localizacao` explícito da escrita de etiquetas.
  const localizacaoEtiqueta = await lerLocalizacaoSnapshot();

  // Esqueleto pronto: o dashboard já pode abrir e ir populando (streaming).
  await chrome.runtime
    .sendMessage({
      channel: MESSAGE_CHANNELS.PREVJUD_SKELETON_READY,
      payload: {
        requestId: input.requestId,
        hostnamePJe: input.hostnamePJe,
        tarefasVarridas: tarefasOk,
        etiquetasFiltro: [...(config.etiquetasFiltro ?? [])],
        total: candidatos.length,
        processosNaTarefa,
        filtradosPorEtiqueta: candidatos.length,
        localizacaoEtiqueta
      }
    })
    .catch(() => { /* aba-painel pode ter fechado */ });

  // -- Fase 3: coleta das ordens por processo --
  // Três mecanismos, do mais rápido ao mais lento (sondados nessa ordem):
  //   'api' — API oficial PREVJUD no gateway PDPJ (~0,2s; hoje bloqueada
  //           no TRF5 — a sonda se auto-ativa se o gateway voltar);
  //   'ssr' — fetch SSR + POST A4J replicado, sem aba (~0,5-1s);
  //   'aba' — aba invisível + A4J em main world (~2-3s), fallback final.
  // Falha pontual em api/ssr faz SÓ aquele processo cair para o mecanismo
  // seguinte; falha sistêmica (401/403 da API, SSR falhando em sequência)
  // rebaixa a rota da varredura inteira. docs/extracao-ordens-prevjud-pje.md.
  // Como o JS é single-thread, os push em `processos`/`falhas` são seguros.
  const processos: ProcessoOrdensPrevjud[] = [];
  const falhas: PrevjudDashboardPayload['diagnostico']['falhas'] = [];
  let rota: 'api' | 'ssr' | 'aba' = 'aba';
  let coletadosViaApi = 0;
  let coletadosViaSsr = 0;
  let tentativasViaAba = 0;

  let ordensIgnoradas = 0;
  const registrarProcesso = (
    p: PJeApiProcesso,
    ordensBrutas: OrdemPrevjud[],
    urlAutos: string | null
  ): void => {
    let ordens = ordensBrutas;
    if (statusIgnorar.length > 0) {
      const antes = ordens.length;
      ordens = ordens.filter((o) => !statusOrdemIgnorado(o.status, statusIgnorar));
      ordensIgnoradas += antes - ordens.length;
      // Processo que ficou sem ordens é descartado do relatório.
      if (ordens.length === 0) return;
    }
    processos.push({
      idProcesso: p.idProcesso,
      numeroProcesso: p.numeroProcesso,
      idTaskInstance: p.idTaskInstance,
      classeJudicial: p.classeJudicial,
      assuntoPrincipal: p.assuntoPrincipal,
      poloAtivo: p.poloAtivo,
      etiquetas: Array.isArray(p.etiquetas) ? [...p.etiquetas] : [],
      urlAutos,
      ordens
    });
  };

  /** Última mensagem de erro da Rota A — exibida no log da sonda. */
  let ultimoErroApi = '';

  /**
   * Rota A. 'auth' = gateway recusou o token (fallback global); 'erro' =
   * falha pontual (o processo cai para a aba). Só um 200/204 real conta
   * como 'ok' — no estado atual do gateway (500 até para processo com
   * ordem, ver docs §2.2) a sonda não valida a API e tudo vai pela aba.
   */
  const coletarViaApi = async (
    p: PJeApiProcesso
  ): Promise<'ok' | 'auth' | 'erro'> => {
    let resp: PrevjudColetaApiResult;
    try {
      resp = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.PREVJUD_COLETAR_PROCESSO_API,
        payload: { numeroProcesso: p.numeroProcesso }
      })) as PrevjudColetaApiResult;
    } catch (err) {
      ultimoErroApi = err instanceof Error ? err.message : String(err);
      return 'erro';
    }
    if (resp?.error) ultimoErroApi = resp.error;
    if (resp?.ok) {
      coletadosViaApi += 1;
      if (!resp.vazio && resp.ordens && resp.ordens.length > 0) {
        // URL dos autos fica para a Fase 3b — só para quem tem ordem.
        registrarProcesso(p, resp.ordens, null);
      }
      return 'ok';
    }
    return resp?.authRejeitada ? 'auth' : 'erro';
  };

  /** Último erro da rota SSR — exibido no log da sonda. */
  let ultimoErroSsr = '';
  /** Falhas SSR consecutivas — 3 seguidas rebaixam a rota para 'aba'. */
  let falhasSsrSeguidas = 0;

  /**
   * Rota SSR: fetch da página + POST A4J replicado, sem aba. Não registra
   * falha terminal — 'erro' faz o processo cair para a aba, que decide.
   */
  const coletarViaSsr = async (p: PJeApiProcesso): Promise<'ok' | 'erro'> => {
    const urlR = await montarUrlAutos({
      legacyOrigin: input.legacyOrigin,
      idProcesso: p.idProcesso,
      idTaskInstance: p.idTaskInstance
    });
    if (!urlR.ok || !urlR.url) {
      ultimoErroSsr = urlR.error ?? 'Falha ao resolver URL dos autos.';
      return 'erro';
    }
    const resp = await coletarOrdensPrevjudViaSSR({ url: urlR.url });
    if (!resp.ok) {
      ultimoErroSsr = resp.error ?? 'Falha na coleta SSR.';
      return 'erro';
    }
    coletadosViaSsr += 1;
    if (!resp.vazio && resp.linhas && resp.linhas.length > 0) {
      registrarProcesso(p, resp.linhas.map(normalizarOrdemPrevjud), urlR.url);
    }
    return 'ok';
  };

  /** Rota final: aba invisível + A4J (comportamento original). */
  const coletarViaAba = async (p: PJeApiProcesso): Promise<void> => {
    tentativasViaAba += 1;
    // URL dos autos (resolve `ca` on-demand).
    const urlR = await montarUrlAutos({
      legacyOrigin: input.legacyOrigin,
      idProcesso: p.idProcesso,
      idTaskInstance: p.idTaskInstance
    });
    if (!urlR.ok || !urlR.url) {
      falhas.push({
        idProcesso: p.idProcesso,
        numeroProcesso: p.numeroProcesso,
        erro: urlR.error ?? 'Falha ao resolver URL dos autos.'
      });
      return;
    }

    let resp: PrevjudColetaProcessoResult;
    try {
      resp = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.PREVJUD_COLETAR_PROCESSO,
        payload: { url: urlR.url, timeoutMs: 45_000 }
      })) as PrevjudColetaProcessoResult;
    } catch (err) {
      falhas.push({
        idProcesso: p.idProcesso,
        numeroProcesso: p.numeroProcesso,
        erro: err instanceof Error ? err.message : String(err)
      });
      return;
    }

    if (!resp || resp.ok === false) {
      falhas.push({
        idProcesso: p.idProcesso,
        numeroProcesso: p.numeroProcesso,
        erro: resp?.error ?? 'Coleta não respondeu.'
      });
      return;
    }
    // Processo sem ordem: descarta (não entra no relatório).
    if (resp.vazio || !resp.linhas || resp.linhas.length === 0) return;

    registrarProcesso(p, resp.linhas.map(normalizarOrdemPrevjud), urlR.url);
  };

  // Sonda de rota: valida a API em até 4 candidatos, priorizando os das
  // tarefas [PREVJUD] — esses têm registro e devolvem 200; um processo sem
  // registro devolve 500 ('ok500'), que é inconclusivo para validar a rota.
  const prioridadeSonda = (p: PJeApiProcesso): number =>
    /prevjud/i.test(tarefaPorId.get(p.idProcesso) ?? '') ? 0 : 1;
  const candidatosSonda = candidatos
    .filter((c) => c.numeroProcesso)
    .sort((a, b) => prioridadeSonda(a) - prioridadeSonda(b))
    .slice(0, 4);
  let sondaJaColetada: PJeApiProcesso | null = null;
  if (candidatosSonda.length > 0) {
    progress('[rota] testando a API PREVJUD do gateway PDPJ...');
    for (const cand of candidatosSonda) {
      const r = await coletarViaApi(cand);
      if (r === 'ok') {
        rota = 'api';
        sondaJaColetada = cand;
        progress('[rota] API PREVJUD aceita — coleta rápida, sem abrir abas.');
        break;
      }
      if (r === 'auth') break;
    }
    if (rota !== 'api') {
      const detalhe = ultimoErroApi ? ` [${ultimoErroApi}]` : '';
      progress(
        `[rota] API PREVJUD não validada${detalhe} — usando abas invisíveis (mais lento).`
      );
    }
    // Zera o contador da sonda: os candidatos sondados (exceto o que
    // validou a rota) voltam para a fila e serão recontados.
    coletadosViaApi = sondaJaColetada ? 1 : 0;
  }

  // Sonda SSR: se a API não validou, testa a coleta rápida por fetch
  // (GET + POST A4J) em até 2 candidatos antes de recorrer às abas.
  if (rota === 'aba' && candidatosSonda.length > 0) {
    progress('[rota] testando a coleta rápida por fetch (SSR/A4J)...');
    for (const cand of candidatosSonda.slice(0, 2)) {
      const r = await coletarViaSsr(cand);
      if (r === 'ok') {
        rota = 'ssr';
        sondaJaColetada = cand;
        progress('[rota] coleta rápida SSR ativa — sem abrir abas.');
        break;
      }
    }
    if (rota !== 'ssr') {
      const detalhe = ultimoErroSsr ? ` [${ultimoErroSsr}]` : '';
      progress(
        `[rota] SSR indisponível${detalhe} — usando abas invisíveis (mais lento).`
      );
    }
    coletadosViaSsr = rota === 'ssr' && sondaJaColetada ? 1 : 0;
  }

  const coletarUm = async (p: PJeApiProcesso): Promise<void> => {
    if (rota === 'api' && p.numeroProcesso) {
      const r = await coletarViaApi(p);
      if (r === 'ok') return;
      if (r === 'auth') {
        rota = 'ssr';
        progress(
          '[rota] token expirou no gateway — alternando para a coleta SSR.'
        );
      }
      // Erro pontual (ou auth): desce para o mecanismo seguinte.
    }
    if (rota === 'ssr') {
      const r = await coletarViaSsr(p);
      if (r === 'ok') {
        falhasSsrSeguidas = 0;
        return;
      }
      falhasSsrSeguidas += 1;
      if (falhasSsrSeguidas >= 3) {
        rota = 'aba';
        progress(
          '[rota] SSR falhando em sequência — alternando para abas invisíveis.'
        );
      }
      // Este processo desce para a aba.
    }
    await coletarViaAba(p);
  };

  // Pool de workers. Concorrência por rota: API 6 (chamadas leves), SSR 8
  // (2 requests JSF por processo, mas HTTP/2 multiplexa e o parse agora é
  // só do fragmento da tabela), aba 3 (abre janela real —
  // docs/extracao-conteudo-pje.md §3.2). Se a rota cair no meio da
  // varredura, os workers seguem no mecanismo mais lento com a
  // concorrência antiga — raro e tolerável.
  const CONCORRENCIA = rota === 'api' ? 6 : rota === 'ssr' ? 8 : 3;
  const fila = sondaJaColetada
    ? candidatos.filter((c) => c !== sondaJaColetada)
    : candidatos;
  const total = candidatos.length;
  let proximo = 0;
  let concluidos = sondaJaColetada ? 1 : 0;

  // Patch de streaming: envia o acumulado de processos COM ordem + o
  // progresso. Só emite quando a lista cresce (novo processo com ordem),
  // a cada 10 conclusões (barra) ou no fim — evita 600+ mensagens.
  let ultimoEmitLen = -1;
  let ultimoEmitFeitos = 0;
  const emitirPatch = (feitos: number): void => {
    void chrome.runtime
      .sendMessage({
        channel: MESSAGE_CHANNELS.PREVJUD_SLOT_PATCH,
        payload: {
          requestId: input.requestId,
          seq: feitos,
          feitos,
          total,
          processos: [...processos]
        }
      })
      .catch(() => { /* dashboard pode ter fechado */ });
  };
  const talvezEmitir = (feitos: number): void => {
    if (
      processos.length !== ultimoEmitLen ||
      feitos - ultimoEmitFeitos >= 10 ||
      feitos >= total
    ) {
      ultimoEmitLen = processos.length;
      ultimoEmitFeitos = feitos;
      emitirPatch(feitos);
    }
  };

  if (sondaJaColetada) {
    progress(
      `[coleta] 1/${total} — ${sondaJaColetada.numeroProcesso ?? sondaJaColetada.idProcesso}`
    );
    talvezEmitir(1);
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = proximo++;
      if (i >= fila.length) return;
      const p = fila[i];
      await coletarUm(p);
      concluidos += 1;
      progress(
        `[coleta] ${concluidos}/${total} — ${p.numeroProcesso ?? p.idProcesso}`
      );
      talvezEmitir(concluidos);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCORRENCIA, Math.max(1, fila.length)) }, () =>
      worker()
    )
  );

  // -- Fase 3b: URLs dos autos dos processos coletados via API --
  // A Rota A não passa pela `listAutosDigitais.seam`, então o link dos
  // autos é resolvido aqui, APENAS para os processos com ordem (dezenas,
  // não centenas) — antes o `gerarChaveAcesso` rodava para todo candidato.
  const semUrl = processos.filter((pr) => !pr.urlAutos);
  if (semUrl.length > 0) {
    progress(`[url] resolvendo o link dos autos de ${semUrl.length} processo(s)...`);
    for (const pr of semUrl) {
      const cand = porId.get(pr.idProcesso);
      try {
        const r = await montarUrlAutos({
          legacyOrigin: input.legacyOrigin,
          idProcesso: pr.idProcesso,
          idTaskInstance: cand?.idTaskInstance ?? null
        });
        if (r.ok && r.url) pr.urlAutos = r.url;
      } catch {
        /* processo fica sem hyperlink; não é falha de coleta */
      }
    }
  }

  const mecanismosUsados = [
    coletadosViaApi > 0 ? 'api' : null,
    coletadosViaSsr > 0 ? 'ssr' : null,
    tentativasViaAba > 0 ? 'aba' : null
  ].filter((m): m is 'api' | 'ssr' | 'aba' => m !== null);
  const rotaColeta: 'api' | 'ssr' | 'aba' | 'mista' =
    mecanismosUsados.length > 1 ? 'mista' : (mecanismosUsados[0] ?? 'aba');

  // -- Fase 4: totais e payload --
  const totalOrdens = processos.reduce((acc, pr) => acc + pr.ordens.length, 0);
  const ordensPendentes = processos.reduce(
    (acc, pr) => acc + pr.ordens.filter(ordemPendente).length,
    0
  );

  const payload: PrevjudDashboardPayload = {
    requestId: input.requestId,
    geradoEm: new Date().toISOString(),
    hostnamePJe: input.hostnamePJe,
    tarefasVarridas: tarefasOk,
    etiquetasFiltro: [...(config.etiquetasFiltro ?? [])],
    totais: {
      processosVarridos: candidatos.length,
      processosComOrdem: processos.length,
      totalOrdens,
      ordensPendentes
    },
    processos,
    diagnostico: {
      processosNaTarefa,
      filtradosPorEtiqueta: candidatos.length,
      rotaColeta,
      ordensIgnoradas: statusIgnorar.length > 0 ? ordensIgnoradas : undefined,
      statusIgnorados: statusIgnorar.length > 0 ? [...statusIgnorar] : undefined,
      falhas
    }
  };

  console.log(
    `${LOG_PREFIX} [prevjud-coletor] concluído (rota ${rotaColeta}): ` +
      `${candidatos.length} candidato(s), ${processos.length} com ordem, ` +
      `${totalOrdens} ordem(ns), ${ordensPendentes} pendente(s), ` +
      `${falhas.length} falha(s), ` +
      `${coletadosViaApi} via API / ${coletadosViaSsr} via SSR / ${tentativasViaAba} via aba.`
  );

  return { ok: true, payload };
}
