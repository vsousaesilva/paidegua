/**
 * Coletor de pautas de perícia (perfil Secretaria → Perícias pAIdegua).
 *
 * Roda no top frame do PJe legacy. Fluxo:
 *   1. Lista os processos de cada tarefa de perícia selecionada via
 *      `listarProcessosDaTarefa` (REST do PJe).
 *   2. Deduplica por `idProcesso` (quando a unidade usa as duas tarefas,
 *      o mesmo processo pode aparecer em ambas — fica só a primeira).
 *   3. Ordena todos os processos por antiguidade na tarefa
 *      (`dataChegadaTarefa` asc — mais antigo primeiro).
 *   4. Para cada perito selecionado, percorre as etiquetas do perito na
 *      ORDEM cadastrada (prioridade em cascata). A cada etiqueta, varre
 *      os processos ordenados e inclui os que:
 *        - tenham a etiqueta entre as tags do processo;
 *        - (se o perito tiver assuntos cadastrados) tenham o
 *          `assuntoPrincipal` na lista do perito;
 *        - ainda não tenham sido alocados a OUTRO perito.
 *      Para assim que a quantidade-padrão do perito for atingida.
 *   5. Monta `PericiaPauta[]` por perito e `PericiaPautaItem[]` para os
 *      processos não distribuídos (nenhuma etiqueta do processo bate com
 *      nenhum perito selecionado — resíduo informativo do dashboard).
 *
 * Não resolve URL dos autos aqui (`url: null`): o dashboard resolve on-demand
 * com `gerarChaveAcesso` quando o usuário clicar em um item — manter a
 * coleta barata em tarefas grandes.
 */

import { LOG_PREFIX } from '../../shared/constants';
import type {
  PericiaPauta,
  PericiaPautaItem,
  PericiaPerito,
  PericiasDashboardPayload,
  PJeApiProcesso
} from '../../shared/types';
import {
  listarProcessosDaTarefa,
  montarUrlAutos
} from '../pje-api/pje-api-from-content';
import {
  appendAssuntosCatalogo,
  montarEtiquetaPauta
} from '../../shared/pericias-store';

export interface ColetorPericiasInput {
  requestId: string;
  hostnamePJe: string;
  legacyOrigin: string;
  nomes: string[];
  /**
   * Peritos efetivamente selecionados na aba-painel, com o snapshot
   * completo do cadastro (nome, etiquetas na ordem de prioridade,
   * assuntos filtro, quantidade-padrão). A ordem do array é a ordem de
   * atendimento — primeiro perito atende antes (prioridade de tomada).
   * A quantidade-padrão pode ter sido editada no painel antes de gerar.
   */
  peritosSelecionados: PericiaPerito[];
  /**
   * Data da perícia escolhida pelo usuário (futura). Compõe a etiqueta
   * da pauta: "DR(A)/AS [NOME] DD.MM.AA". Também é devolvida no payload
   * e usada se o dashboard pedir para refazer a pauta.
   */
  dataPericia: Date;
  /**
   * Quando o dashboard aciona "Atualizar pauta", vem populado com os
   * `idProcesso` que o usuário excluiu. O coletor ignora esses processos
   * em TODAS as fases (pauta e resíduo).
   */
  excluirIds?: Set<number>;
  onProgress?: (msg: string) => void;
}

export interface ColetorPericiasResult {
  ok: boolean;
  payload?: PericiasDashboardPayload;
  error?: string;
}

interface ItemComTarefa {
  tarefaNome: string;
  processo: PJeApiProcesso;
}

function normalizar(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function antiguidadeMs(p: PJeApiProcesso): number {
  // Formatos observados:
  //   - epoch em ms como string ("1744848000000") — é o padrão da REST
  //     `recuperarProcessosTarefaPendenteComCriterios` do PJe legacy;
  //   - ISO 8601 ("2026-04-17T12:34:56") — alguns endpoints;
  //   - "dd/mm/yyyy hh:mm[:ss]" — fallback de compatibilidade.
  // Se não parsear, joga pro fim (Number.MAX_SAFE_INTEGER) — aparece no
  // final da fila e não atrapalha a ordenação dos que têm data.
  const raw = p.dataChegadaTarefa;
  if (!raw) return Number.MAX_SAFE_INTEGER;
  const trimmed = raw.trim();
  if (!trimmed) return Number.MAX_SAFE_INTEGER;
  // Epoch ms puro (10+ dígitos cobre tudo após 2001-09-09).
  if (/^\d{10,}$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const direto = Date.parse(trimmed);
  if (!Number.isNaN(direto)) return direto;
  // Tenta dd/mm/yyyy [hh:mm[:ss]]
  const m = trimmed.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (m) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
    const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  return Number.MAX_SAFE_INTEGER;
}

function montarPautaItem(
  item: ItemComTarefa,
  etiquetaOrigemId: number,
  etiquetaOrigemNome: string
): PericiaPautaItem {
  const p = item.processo;
  return {
    idProcesso: p.idProcesso,
    numeroProcesso: p.numeroProcesso,
    idTaskInstance: p.idTaskInstance,
    classeJudicial: p.classeJudicial,
    assuntoPrincipal: p.assuntoPrincipal,
    poloAtivo: p.poloAtivo,
    dataChegadaTarefa: p.dataChegadaTarefa,
    url: null,
    etiquetaOrigemId,
    etiquetaOrigemNome,
    tarefaNome: item.tarefaNome,
    etiquetasProcesso: Array.isArray(p.etiquetas) ? [...p.etiquetas] : []
  };
}

export async function coletarPautasPorPeritos(
  input: ColetorPericiasInput
): Promise<ColetorPericiasResult> {
  const progress = input.onProgress ?? (() => {});
  const peritos = input.peritosSelecionados.filter(
    (p): p is PericiaPerito => Boolean(p) && typeof p.id === 'string'
  );

  if (peritos.length === 0) {
    return {
      ok: false,
      error: 'Nenhum perito selecionado válido foi recebido pelo coletor.'
    };
  }
  // Sanity check: todo perito ativo precisa ter ao menos 1 etiqueta para
  // a pauta fazer sentido. A aba-painel já filtra, mas confirmamos aqui.
  const semEtiqueta = peritos.filter((p) => p.etiquetas.length === 0);
  if (semEtiqueta.length > 0) {
    return {
      ok: false,
      error:
        `Peritos sem etiquetas cadastradas não podem entrar na pauta: ` +
        semEtiqueta.map((p) => p.nomeCompleto).join(', ')
    };
  }

  // -- Fase 1: listar processos por tarefa --
  const todos: ItemComTarefa[] = [];
  const tarefasOk: string[] = [];
  const erros: string[] = [];
  for (const nome of input.nomes) {
    progress(`[listar] tarefa "${nome}"...`);
    const resp = await listarProcessosDaTarefa({ nomeTarefa: nome });
    if (!resp.ok) {
      erros.push(`"${nome}": ${resp.error ?? 'erro desconhecido'}`);
      progress(`[listar] falha em "${nome}": ${resp.error ?? 'erro'}`);
      continue;
    }
    tarefasOk.push(nome);
    for (const p of resp.processos) {
      todos.push({ tarefaNome: nome, processo: p });
    }
    progress(
      `[listar] "${nome}": ${resp.processos.length}/${resp.total} processo(s).`
    );
  }

  if (todos.length === 0) {
    const msg =
      erros.length > 0
        ? `Não foi possível listar processos: ${erros.join(' | ')}`
        : 'As tarefas selecionadas não têm processos pendentes.';
    return { ok: false, error: msg };
  }

  // Dedup por idProcesso (preserva a 1ª tarefa onde o processo apareceu).
  // Já aplica `excluirIds` aqui — processos excluídos pelo usuário somem
  // dos elegíveis em todas as fases (pauta e resíduo).
  const excluirIds = input.excluirIds ?? new Set<number>();
  const porId = new Map<number, ItemComTarefa>();
  for (const item of todos) {
    if (item.processo.idProcesso <= 0) continue;
    if (excluirIds.has(item.processo.idProcesso)) continue;
    if (!porId.has(item.processo.idProcesso)) porId.set(item.processo.idProcesso, item);
  }
  const unicos = Array.from(porId.values()).sort(
    (a, b) => antiguidadeMs(a.processo) - antiguidadeMs(b.processo)
  );
  progress(
    `[setup] ${tarefasOk.length} tarefa(s) — total ${unicos.length} processo(s).`
  );

  // -- Fase 2: montagem de pautas por perito --
  const assigned = new Set<number>();
  const pautas: PericiaPauta[] = [];
  const dataPericia = input.dataPericia;

  for (let pIdx = 0; pIdx < peritos.length; pIdx++) {
    const perito = peritos[pIdx];
    const itens: PericiaPautaItem[] = [];
    const meta = perito.quantidadePadrao;
    const assuntosFiltro = perito.assuntos
      .map(normalizar)
      .filter((s) => s.length > 0);

    // Cascata de etiquetas na ordem cadastrada (prioridade).
    for (const etiqueta of perito.etiquetas) {
      if (itens.length >= meta) break;
      const etiqNorm = normalizar(etiqueta.nomeTag);
      if (!etiqNorm) continue;

      for (const item of unicos) {
        if (itens.length >= meta) break;
        if (assigned.has(item.processo.idProcesso)) continue;
        const tagsProc = item.processo.etiquetas.map(normalizar);
        if (!tagsProc.includes(etiqNorm)) continue;
        if (assuntosFiltro.length > 0) {
          const ap = normalizar(item.processo.assuntoPrincipal);
          if (!ap || !assuntosFiltro.includes(ap)) continue;
        }
        itens.push(montarPautaItem(item, etiqueta.id, etiqueta.nomeTag));
        assigned.add(item.processo.idProcesso);
        progress(
          `[coleta] ${itens.length}/${meta} — ` +
            `${item.processo.numeroProcesso ?? item.processo.idProcesso} ` +
            `(${etiqueta.nomeTag})`
        );
      }
    }

    pautas.push({
      peritoId: perito.id,
      peritoNomeCompleto: perito.nomeCompleto,
      peritoNomeEtiquetaPauta: perito.nomeEtiquetaPauta,
      peritoGenero: perito.genero,
      etiquetaPauta: montarEtiquetaPauta(perito, dataPericia),
      itens,
      quantidadePedida: meta,
      quantidadeAtingida: itens.length
    });
    progress(
      `[perito] ${pIdx + 1}/${peritos.length} — ${perito.nomeCompleto} ` +
        `(${itens.length}/${meta})`
    );
  }

  // -- Fase 3: resíduo (processos cuja etiqueta não casa com nenhum perito) --
  const etiquetasAlvo = new Set<string>();
  for (const perito of peritos) {
    for (const e of perito.etiquetas) {
      const n = normalizar(e.nomeTag);
      if (n) etiquetasAlvo.add(n);
    }
  }
  const naoDistribuidos: PericiaPautaItem[] = [];
  for (const item of unicos) {
    if (assigned.has(item.processo.idProcesso)) continue;
    const tagsProc = item.processo.etiquetas.map(normalizar);
    const casa = tagsProc.some((n) => etiquetasAlvo.has(n));
    if (casa) continue; // esgotou cota de perito, mas tinha match
    naoDistribuidos.push(montarPautaItem(item, 0, ''));
  }

  const peritosContemplados = pautas.filter(
    (p) => p.quantidadeAtingida > 0
  ).length;

  // -- Fase 4: resolução de URLs dos autos (apenas para itens em pauta) --
  // Os não-distribuídos ficam sem URL — o dashboard só os mostra como
  // residuo informativo, não há ação direta sobre eles. Resolver URLs de
  // milhares de varridos consumiria `gerarChaveAcesso` em excesso.
  const itensEmPauta = pautas.flatMap((p) => p.itens);
  let urlsOk = 0;
  let urlsFail = 0;
  progress(`[url] resolvendo link de ${itensEmPauta.length} processo(s)...`);
  for (let i = 0; i < itensEmPauta.length; i++) {
    const item = itensEmPauta[i];
    try {
      const r = await montarUrlAutos({
        legacyOrigin: input.legacyOrigin,
        idProcesso: item.idProcesso,
        idTaskInstance: item.idTaskInstance
      });
      if (r.ok && r.url) {
        item.url = r.url;
        urlsOk += 1;
      } else {
        urlsFail += 1;
      }
    } catch (err) {
      urlsFail += 1;
      console.warn(
        `${LOG_PREFIX} [pericias-coletor] falha ao resolver URL`,
        item.idProcesso,
        err
      );
    }
    if ((i + 1) % 10 === 0 || i === itensEmPauta.length - 1) {
      progress(`[url] ${i + 1}/${itensEmPauta.length}`);
    }
  }
  if (urlsFail > 0) {
    progress(
      `[url] ${urlsOk} link(s) OK, ${urlsFail} com falha (processo ainda ` +
        `aparece na pauta, sem hyperlink).`
    );
  }

  const payload: PericiasDashboardPayload = {
    requestId: input.requestId,
    geradoEm: new Date().toISOString(),
    hostnamePJe: input.hostnamePJe,
    tarefasVarridas: tarefasOk,
    totais: {
      processosVarridos: unicos.length,
      processosNaPauta: assigned.size,
      peritosContemplados
    },
    pautas,
    naoDistribuidos,
    dataPericiaISO: dataPericia.toISOString(),
    entrada: {
      nomesTarefas: [...input.nomes],
      peritos: input.peritosSelecionados,
      dataPericiaISO: dataPericia.toISOString(),
      legacyOrigin: input.legacyOrigin,
      excluirIds: Array.from(excluirIds).sort((a, b) => a - b)
    }
  };

  // Alimenta o catálogo acumulativo de assuntos (usado pelo autocomplete
  // no cadastro do perito no popup). Tolerante a falha — é feature de UI.
  try {
    const assuntosVistos = unicos
      .map((i) => i.processo.assuntoPrincipal)
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
    if (assuntosVistos.length > 0) {
      await appendAssuntosCatalogo(assuntosVistos);
    }
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} [pericias-coletor] falha ao atualizar catálogo de assuntos`,
      err
    );
  }

  console.log(
    `${LOG_PREFIX} [pericias-coletor] concluido: ` +
      `${unicos.length} varridos, ${assigned.size} em pauta, ` +
      `${peritosContemplados}/${peritos.length} perito(s) contemplado(s).`
  );

  return { ok: true, payload };
}
