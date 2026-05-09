/**
 * Índice de tarefas humanas (FLUX-17).
 *
 * O catálogo (`fluxos-catalogo.json`) é organizado por fluxos jBPM
 * (210 entradas). Mas o usuário do PJe não vê fluxos: ele vê tarefas
 * humanas na fila de trabalho — nomes como "[JEF] Análise inicial",
 * "[JEF] Análise inicial - Perícia", "[JEF] Operação de perícia -
 * Designar". Cada fluxo contém de 1 a 30+ task-nodes.
 *
 * Este módulo achata o catálogo em uma lista plana de tarefas, cada
 * uma com referência ao fluxo pai. É a unidade primária dos Mapas de
 * Jornada no MODO USUÁRIO. Nomes de fluxo voltam apenas no MODO
 * TÉCNICO (decisão owner em 2026-05-07).
 *
 * Cache em memória durante a vida da página.
 */

import { getCatalogo } from './fluxos-store';
import type {
  AlertaFluxo,
  FluxoFase,
  FluxoLane,
  FluxoTransicao
} from './fluxos-types';

export interface TarefaIndice {
  /** Identificador URL-safe (p/ rota `?tarefa=...`). */
  id: string;
  /** Nome oficial da tarefa, exatamente como aparece no PJe (com `[JEF]`). */
  nome: string;
  /** Código do fluxo onde essa tarefa vive. Modo dev. */
  fluxoCodigo: string;
  /** Nome legível do fluxo pai (com `[JEF]`). Modo dev. */
  fluxoNome: string;
  lane: FluxoLane;
  fase: FluxoFase;
  /** Swimlane responsável (Secretaria, Gabinete, Audiências...). */
  swimlane: string;
  /** Transições saintes da tarefa — para onde ela pode levar. */
  transicoes: FluxoTransicao[];
  /** Alertas herdados do fluxo pai (hub, decisão automática, etc.). */
  alertasFluxoPai: AlertaFluxo[];
  /** Frase humana herdada do fluxo pai, se houver. */
  fraseFluxoPai?: string;
}

let _cache: TarefaIndice[] | null = null;
let _porId: Map<string, TarefaIndice> | null = null;
let _porFluxo: Map<string, TarefaIndice[]> | null = null;

/**
 * Carrega (ou retorna do cache) o índice plano de tarefas humanas
 * extraído de todas as task-nodes do catálogo.
 *
 * Critério (validado com o owner em 2026-05-07 via extrair-tarefas.bat):
 *   1. task-node TEM swimlane definido (alguém é responsável)
 *   2. nome NÃO começa com "Nó de Desvio" (rota de exceção interna jBPM
 *      que não aparece para o servidor)
 *
 * Resultado esperado: ~583 tarefas, ~562 nomes únicos no catálogo atual.
 *
 * Importante: NÃO filtrar por `endTasks: true` — em jPDL 3.2 esse atributo
 * significa "ao concluir, sai automaticamente pela transição default", e
 * é o comportamento padrão de task-nodes humanas reais (ex.: "[JEF]
 * Analisar - Secretaria", "[JEF] Ato do magistrado - Despacho"). Filtrar
 * por isso descarta 717 das 793 task-nodes — bug que zerou o catálogo.
 */
export async function getIndiceTarefas(): Promise<TarefaIndice[]> {
  if (_cache) return _cache;
  const cat = await getCatalogo();
  const lista: TarefaIndice[] = [];

  for (const f of cat.fluxos) {
    for (const tn of f.taskNodes ?? []) {
      // Cada task-node tem 0..N tasks; geralmente 1. O swimlane é da
      // primeira task que declara um.
      const swimlane = tn.tasks?.find((t) => t.swimlane)?.swimlane ?? '';
      if (!swimlane) continue;
      if (/^N. de Desvio/i.test(tn.nome)) continue;
      lista.push({
        id: gerarId(f.codigo, tn.nome),
        nome: tn.nome,
        fluxoCodigo: f.codigo,
        fluxoNome: f.nome,
        lane: f.lane,
        fase: f.fase,
        swimlane,
        transicoes: tn.transicoes ?? [],
        alertasFluxoPai: f.enriquecimento?.alertas ?? [],
        fraseFluxoPai: f.enriquecimento?.frase_humana
      });
    }
  }

  _cache = lista;
  _porId = new Map(lista.map((t) => [t.id, t]));
  _porFluxo = new Map();
  for (const t of lista) {
    if (!_porFluxo.has(t.fluxoCodigo)) _porFluxo.set(t.fluxoCodigo, []);
    _porFluxo.get(t.fluxoCodigo)!.push(t);
  }
  return lista;
}

/** Recupera tarefa pelo `id` (chave URL-safe). */
export async function getTarefa(id: string): Promise<TarefaIndice | null> {
  await getIndiceTarefas();
  return _porId?.get(id) ?? null;
}

/** Recupera todas as tarefas humanas de um fluxo. */
export async function getTarefasDoFluxo(fluxoCodigo: string): Promise<TarefaIndice[]> {
  await getIndiceTarefas();
  return _porFluxo?.get(fluxoCodigo) ?? [];
}

/**
 * Busca textual nas tarefas. Tokeniza a consulta e pontua por
 * ocorrência em campos com peso decrescente: nome > swimlane >
 * fluxo pai > fase. Suficiente para milhares de tarefas sem libs.
 */
export async function buscarTarefas(consulta: string, limite = 15): Promise<TarefaIndice[]> {
  const tokens = tokenizar(consulta);
  if (tokens.length === 0) return [];
  const lista = await getIndiceTarefas();

  const pontuadas: Array<{ t: TarefaIndice; score: number }> = [];
  for (const t of lista) {
    const nomeNorm = normalizar(t.nome);
    const swimNorm = normalizar(t.swimlane);
    const fluxoNorm = normalizar(t.fluxoNome);
    const faseNorm = normalizar(t.fase);
    let score = 0;
    for (const tk of tokens) {
      if (nomeNorm === tk) score += 80;
      else if (nomeNorm.includes(tk)) score += 30;
      if (swimNorm.includes(tk)) score += 8;
      if (fluxoNorm.includes(tk)) score += 6;
      if (faseNorm.includes(tk)) score += 4;
    }
    if (score > 0) pontuadas.push({ t, score });
  }
  pontuadas.sort((a, b) => b.score - a.score);
  return pontuadas.slice(0, limite).map((p) => p.t);
}

/** URL-safe stable id: `<fluxoCodigo>__<slug-do-nome>`. */
function gerarId(fluxoCodigo: string, nomeTarefa: string): string {
  return `${fluxoCodigo}__${slugify(nomeTarefa)}`;
}

function slugify(s: string): string {
  return normalizar(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function tokenizar(s: string): string[] {
  return normalizar(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function normalizar(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Útil em hot-reload local. Em produção o cache vive a sessão. */
export function invalidarCacheTarefas(): void {
  _cache = null;
  _porId = null;
  _porFluxo = null;
}
