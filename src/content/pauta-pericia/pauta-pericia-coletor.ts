/**
 * Coletor do Painel de Perícias (perfil Gestão). Mesmo desenho do
 * `prevjud-coletor`, trocando a tabela "Intimações INSS" pela de perícia
 * (`#processoPericiaNovaPericiaList`) e o filtro "ignorar cumpridas" por
 * "ignorar situações selecionadas".
 *
 * Roda no top frame do PJe legacy. Fluxo:
 *   1. Lista os processos de cada tarefa (`listarProcessosDaTarefa`) e dedup.
 *   2. Pré-filtra pelas ETIQUETAS escolhidas (modo qualquer/todas).
 *   3. Para cada candidato: resolve a URL dos autos e extrai a tabela de
 *      perícia via SSR (`coletarPericiasViaSSR`).
 *   4. Normaliza, aplica o filtro de situações a ignorar e descarta processos
 *      sem perícia. Monta o `PautaPericiaDashboardPayload`.
 *
 * Sem API/PDPJ e sem fallback por aba: o SSR foi validado em campo e cobre o
 * caso; falha pontual em um processo vira registro em `diagnostico.falhas`.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import type { PJeApiProcesso } from '../../shared/types';
import type {
  PautaPericiaColetaConfig,
  PautaPericiaDashboardPayload,
  PericiaItem,
  ProcessoComPericias
} from '../../shared/pauta-pericia-types';
import {
  listarProcessosDaTarefa,
  montarUrlAutos
} from '../pje-api/pje-api-from-content';
import { normalizarPericia, situacaoIgnorada } from '../../shared/pauta-pericia-parser';
import { coletarPericiasViaSSR } from './pauta-pericia-ssr';

export interface ColetorPautaPericiaInput {
  requestId: string;
  hostnamePJe: string;
  legacyOrigin: string;
  config: PautaPericiaColetaConfig;
  onProgress?: (msg: string) => void;
}

export interface ColetorPautaPericiaResult {
  ok: boolean;
  payload?: PautaPericiaDashboardPayload;
  error?: string;
}

/** Concorrência do pool de coleta SSR (2 requests JSF por processo). */
const CONCORRENCIA = 8;

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Casa o processo contra as etiquetas de filtro (por SUBSTRING, igual ao
 * PREVJUD). Modo `qualquer`: basta uma etiqueta conter algum filtro; `todas`:
 * cada filtro precisa ser encontrado em alguma etiqueta.
 */
function casaEtiquetas(
  p: PJeApiProcesso,
  filtroNorm: string[],
  modo: 'qualquer' | 'todas'
): boolean {
  if (filtroNorm.length === 0) return true;
  const tags = (p.etiquetas ?? []).map(norm);
  const contem = (f: string): boolean => tags.some((t) => t.includes(f));
  return modo === 'todas' ? filtroNorm.every(contem) : filtroNorm.some(contem);
}

export async function coletarPautaPericia(
  input: ColetorPautaPericiaInput
): Promise<ColetorPautaPericiaResult> {
  const progress = input.onProgress ?? ((): void => {});
  const { config } = input;
  const modo = config.etiquetaModo ?? 'qualquer';
  const filtroNorm = (config.etiquetasFiltro ?? [])
    .map(norm)
    .filter((s) => s.length > 0);
  const situacoesIgnorar = config.situacoesIgnorar ?? [];

  if (!config.nomesTarefas || config.nomesTarefas.length === 0) {
    return { ok: false, error: 'Nenhuma tarefa selecionada para a coleta.' };
  }

  // -- Fase 1: listar processos por tarefa e deduplicar --
  const porId = new Map<number, PJeApiProcesso>();
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
      if (p.idProcesso > 0 && !porId.has(p.idProcesso)) porId.set(p.idProcesso, p);
    }
    progress(`[listar] "${nome}": ${resp.processos.length}/${resp.total} processo(s).`);
  }

  const processosNaTarefa = porId.size;
  if (processosNaTarefa === 0) {
    const msg =
      erros.length > 0
        ? `Não foi possível listar processos: ${erros.join(' | ')}`
        : 'As tarefas selecionadas não têm processos pendentes.';
    return { ok: false, error: msg };
  }

  // -- Fase 2: pré-filtro por etiqueta --
  const candidatos = Array.from(porId.values()).filter((p) =>
    casaEtiquetas(p, filtroNorm, modo)
  );
  progress(
    `[filtro] ${candidatos.length}/${processosNaTarefa} candidato(s) após filtro de etiqueta` +
      (filtroNorm.length > 0 ? ` (${config.etiquetasFiltro.join(', ')})` : ' (sem filtro)') +
      '.'
  );

  // Esqueleto pronto: o dashboard já pode abrir e ir populando (streaming).
  await chrome.runtime
    .sendMessage({
      channel: MESSAGE_CHANNELS.PAUTA_PERICIA_SKELETON_READY,
      payload: {
        requestId: input.requestId,
        hostnamePJe: input.hostnamePJe,
        tarefasVarridas: tarefasOk,
        etiquetasFiltro: [...(config.etiquetasFiltro ?? [])],
        total: candidatos.length,
        processosNaTarefa,
        filtradosPorEtiqueta: candidatos.length,
        situacoesIgnoradas: situacoesIgnorar.length > 0 ? [...situacoesIgnorar] : undefined
      }
    })
    .catch(() => { /* aba-painel pode ter fechado */ });

  // -- Fase 3: coleta das perícias por processo (pool SSR) --
  const processos: ProcessoComPericias[] = [];
  const falhas: PautaPericiaDashboardPayload['diagnostico']['falhas'] = [];
  let periciasIgnoradas = 0;

  const registrarProcesso = (
    p: PJeApiProcesso,
    periciasBrutas: PericiaItem[],
    urlAutos: string | null
  ): void => {
    let pericias = periciasBrutas;
    if (situacoesIgnorar.length > 0) {
      const antes = pericias.length;
      pericias = pericias.filter((pe) => !situacaoIgnorada(pe.situacao, situacoesIgnorar));
      periciasIgnoradas += antes - pericias.length;
      if (pericias.length === 0) return; // processo sem perícia relevante
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
      pericias
    });
  };

  const coletarUm = async (p: PJeApiProcesso): Promise<void> => {
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
    const resp = await coletarPericiasViaSSR({ url: urlR.url });
    if (!resp.ok) {
      falhas.push({
        idProcesso: p.idProcesso,
        numeroProcesso: p.numeroProcesso,
        erro: resp.error ?? 'Falha na coleta de perícia.'
      });
      return;
    }
    if (resp.vazio || !resp.linhas || resp.linhas.length === 0) return; // sem perícia
    registrarProcesso(p, resp.linhas.map(normalizarPericia), urlR.url);
  };

  const total = candidatos.length;
  let proximo = 0;
  let concluidos = 0;

  // Patch de streaming: envia o acumulado de processos COM perícia + o
  // progresso. Só emite quando a lista cresce, a cada 10 conclusões (barra)
  // ou no fim — evita centenas de mensagens (mesmo critério do PREVJUD).
  let ultimoEmitLen = -1;
  let ultimoEmitFeitos = 0;
  const talvezEmitir = (feitos: number): void => {
    if (
      processos.length !== ultimoEmitLen ||
      feitos - ultimoEmitFeitos >= 10 ||
      feitos >= total
    ) {
      ultimoEmitLen = processos.length;
      ultimoEmitFeitos = feitos;
      void chrome.runtime
        .sendMessage({
          channel: MESSAGE_CHANNELS.PAUTA_PERICIA_SLOT_PATCH,
          payload: {
            requestId: input.requestId,
            seq: feitos,
            feitos,
            total,
            processos: [...processos]
          }
        })
        .catch(() => { /* dashboard pode ter fechado */ });
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = proximo++;
      if (i >= candidatos.length) return;
      const p = candidatos[i];
      await coletarUm(p);
      concluidos += 1;
      progress(`[coleta] ${concluidos}/${total} — ${p.numeroProcesso ?? p.idProcesso}`);
      talvezEmitir(concluidos);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCORRENCIA, Math.max(1, candidatos.length)) }, () =>
      worker()
    )
  );

  // -- Fase 4: totais e payload --
  const totalPericias = processos.reduce((acc, pr) => acc + pr.pericias.length, 0);
  const valorTotal = processos.reduce(
    (acc, pr) => acc + pr.pericias.reduce((s, pe) => s + (pe.valor ?? 0), 0),
    0
  );

  const payload: PautaPericiaDashboardPayload = {
    requestId: input.requestId,
    geradoEm: new Date().toISOString(),
    hostnamePJe: input.hostnamePJe,
    tarefasVarridas: tarefasOk,
    etiquetasFiltro: [...(config.etiquetasFiltro ?? [])],
    totais: {
      processosVarridos: candidatos.length,
      processosComPericia: processos.length,
      totalPericias,
      valorTotal
    },
    processos,
    diagnostico: {
      processosNaTarefa,
      filtradosPorEtiqueta: candidatos.length,
      situacoesIgnoradas: situacoesIgnorar.length > 0 ? [...situacoesIgnorar] : undefined,
      periciasIgnoradas: situacoesIgnorar.length > 0 ? periciasIgnoradas : undefined,
      falhas
    }
  };

  console.log(
    `${LOG_PREFIX} [pauta-pericia-coletor] concluído: ` +
      `${candidatos.length} candidato(s), ${processos.length} com perícia, ` +
      `${totalPericias} perícia(s), ${falhas.length} falha(s).`
  );
  return { ok: true, payload };
}
