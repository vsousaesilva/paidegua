/**
 * Coletor de ranking de advogados (RANK-01 — recurso de teste discreto).
 *
 * Varre as tarefas selecionadas do painel do usuário, deduplica processos
 * por idProcesso, identifica o advogado do polo ativo (estratégia híbrida:
 * heurística da string `poloAtivo` primeiro; HTML dos autos como fallback
 * só nos processos sem OAB) e devolve um ranking ordenado por contagem desc.
 *
 * Lições aprendidas no 1º teste em caixa real (22/05/2026, ~10k processos):
 *   - Pool de 10 paralelas + caixa grande satura PJe → 403 + silent SSO falha
 *     em loop → coletor estagna. Reduzido para POOL=4 + jitter 200-500ms.
 *   - Heurística REST acertou pouquíssimo → quase tudo cai na 2ª passada.
 *     Cap configurável (default 1000) na 2ª passada protege contra coletas
 *     gigantes acidentais — acima do cap, fica só o que a REST pegou.
 *   - Sem cancelamento, único jeito de parar era fechar a aba. AbortSignal
 *     interrompe entre batches; ranking parcial é devolvido.
 *   - Sem visibilidade do progresso, owner não sabia se estava perto do fim.
 *     onPartial dispara após cada batch da 2ª passada com o ranking-até-agora.
 */

import { LOG_PREFIX } from '../../shared/constants';
import {
  chaveAgrupamentoAdvogado,
  extrairAdvogadoDoPoloAtivo
} from '../../shared/audiencia-helpers';
import { listarProcessosDaTarefa } from '../pje-api/pje-api-from-content';
import {
  escolherAdvogadoAtivo,
  obterPartesDoProcesso
} from '../pje-api/pje-api-partes';

const LOG = `${LOG_PREFIX} [ranking-coletor]`;
const POOL = 4;
const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 500;
const CAP_DEFAULT_ENRIQUECIMENTO = 1000;

export interface RankingAdvogadoItem {
  advogadoNome: string;
  advogadoOab: string | null;
  quantidade: number;
}

export interface ColetarRankingInput {
  legacyOrigin: string;
  nomesTarefas: string[];
  /**
   * Máximo de processos a enriquecer via HTML dos autos (2ª passada).
   * Default: 1000. Acima disso, os excedentes ficam só com o que a
   * heurística REST pegou — proteção contra caixas gigantes.
   */
  capEnriquecimento?: number;
  /**
   * Callback chamado após cada batch da 2ª passada com o ranking
   * parcial — permite à UI mostrar resultado em tempo real.
   */
  onPartial?: (parcial: ParcialRanking) => void;
  /** Sinal de cancelamento. Quando abortado, retorna ranking parcial. */
  signal?: AbortSignal;
}

export interface ParcialRanking {
  totalVarridos: number;
  enriquecidosAteAgora: number;
  totalParaEnriquecer: number;
  semAdvogado: number;
  ranking: RankingAdvogadoItem[];
}

export interface ColetarRankingResult {
  ok: boolean;
  totalVarridos: number;
  semAdvogado: number;
  /** True se o usuário cancelou — ranking é parcial mas válido. */
  cancelado: boolean;
  /** True se a 2ª passada foi truncada pelo cap. */
  truncadoPorCap: boolean;
  /** Quantos processos ficaram fora da 2ª passada por causa do cap. */
  truncadosCount: number;
  tarefasComFalha: Array<{ nome: string; error: string }>;
  ranking: RankingAdvogadoItem[];
  error?: string;
}

interface ItemColeta {
  idProcesso: number;
  poloAtivoBruto: string | null;
  idTaskInstance: number | null;
  advogadoNome: string | null;
  advogadoOab: string | null;
}

export async function coletarRankingAdvogados(
  input: ColetarRankingInput
): Promise<ColetarRankingResult> {
  if (!input.nomesTarefas || input.nomesTarefas.length === 0) {
    return baseResult({ ok: false, error: 'Nenhuma tarefa selecionada.' });
  }

  const signal = input.signal;
  const cap = Math.max(
    0,
    Math.trunc(input.capEnriquecimento ?? CAP_DEFAULT_ENRIQUECIMENTO)
  );
  const onPartial = input.onPartial ?? (() => {});

  // --- 1. Listar processos por tarefa, deduplicando ---
  const porIdProcesso = new Map<number, ItemColeta>();
  const tarefasComFalha: Array<{ nome: string; error: string }> = [];
  for (const nome of input.nomesTarefas) {
    if (signal?.aborted) break;
    const r = await listarProcessosDaTarefa({ nomeTarefa: nome });
    if (!r.ok) {
      tarefasComFalha.push({ nome, error: r.error ?? 'erro desconhecido' });
      continue;
    }
    for (const p of r.processos) {
      if (p.idProcesso <= 0) continue;
      if (porIdProcesso.has(p.idProcesso)) continue;
      porIdProcesso.set(p.idProcesso, {
        idProcesso: p.idProcesso,
        poloAtivoBruto: p.poloAtivo,
        idTaskInstance: p.idTaskInstance,
        advogadoNome: null,
        advogadoOab: null
      });
    }
  }
  const todos = Array.from(porIdProcesso.values());

  // --- 2. 1ª passada: heurística barata ---
  for (const it of todos) {
    const adv = extrairAdvogadoDoPoloAtivo(it.poloAtivoBruto);
    if (adv.nome) {
      it.advogadoNome = adv.nome;
      it.advogadoOab = adv.oab;
    }
  }
  const semOab = todos.filter((it) => !it.advogadoNome);
  const aEnriquecer = semOab.slice(0, cap);
  const truncadosCount = Math.max(0, semOab.length - cap);
  const truncadoPorCap = truncadosCount > 0;

  // Despacha parcial inicial (só com heurística).
  onPartial(montarParcial(todos, 0, aEnriquecer.length));

  // --- 3. 2ª passada: enriquecimento via HTML com pool + jitter ---
  let cancelado = false;
  if (aEnriquecer.length > 0) {
    let processadosAteAgora = 0;
    for (let i = 0; i < aEnriquecer.length; i += POOL) {
      if (signal?.aborted) {
        cancelado = true;
        break;
      }
      // Jitter antes do batch — pulveriza no tempo pra não bater todas
      // simultâneas no PJe.
      await sleep(
        JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS)
      );
      const batch = aEnriquecer.slice(i, i + POOL);
      await Promise.all(
        batch.map(async (it) => {
          try {
            const r = await obterPartesDoProcesso({
              idProcesso: it.idProcesso,
              idTaskInstance: it.idTaskInstance,
              legacyOrigin: input.legacyOrigin
            });
            if (!r.ok || !r.partes) return;
            const adv = escolherAdvogadoAtivo(r.partes);
            if (adv.nome) {
              it.advogadoNome = adv.nome;
              it.advogadoOab = adv.oab;
            }
          } catch (err) {
            console.warn(
              `${LOG} falha ao enriquecer advogado de ${it.idProcesso}:`,
              err
            );
          }
        })
      );
      processadosAteAgora = Math.min(i + POOL, aEnriquecer.length);
      onPartial(montarParcial(todos, processadosAteAgora, aEnriquecer.length));
    }
  }

  const finalRanking = montarRanking(todos);
  const semAdv = todos.filter((it) => !it.advogadoNome).length;

  return {
    ok: true,
    totalVarridos: todos.length,
    semAdvogado: semAdv,
    cancelado,
    truncadoPorCap,
    truncadosCount,
    tarefasComFalha,
    ranking: finalRanking
  };
}

function montarParcial(
  todos: ItemColeta[],
  enriquecidosAteAgora: number,
  totalParaEnriquecer: number
): ParcialRanking {
  return {
    totalVarridos: todos.length,
    enriquecidosAteAgora,
    totalParaEnriquecer,
    semAdvogado: todos.filter((it) => !it.advogadoNome).length,
    ranking: montarRanking(todos)
  };
}

function montarRanking(todos: ItemColeta[]): RankingAdvogadoItem[] {
  const grupos = new Map<
    string,
    { nomeOriginal: string; oab: string | null; quantidade: number }
  >();
  for (const it of todos) {
    if (!it.advogadoNome) continue;
    const chave = chaveAgrupamentoAdvogado(it.advogadoNome);
    const g = grupos.get(chave);
    if (g) {
      g.quantidade += 1;
      if (!g.oab && it.advogadoOab) g.oab = it.advogadoOab;
    } else {
      grupos.set(chave, {
        nomeOriginal: it.advogadoNome,
        oab: it.advogadoOab,
        quantidade: 1
      });
    }
  }
  return Array.from(grupos.entries())
    .map(([, g]) => ({
      advogadoNome: chaveAgrupamentoAdvogado(g.nomeOriginal),
      advogadoOab: g.oab,
      quantidade: g.quantidade
    }))
    .sort((a, b) => {
      if (b.quantidade !== a.quantidade) return b.quantidade - a.quantidade;
      return a.advogadoNome.localeCompare(b.advogadoNome, 'pt-BR');
    });
}

function baseResult(over: Partial<ColetarRankingResult>): ColetarRankingResult {
  return {
    ok: true,
    totalVarridos: 0,
    semAdvogado: 0,
    cancelado: false,
    truncadoPorCap: false,
    truncadosCount: 0,
    tarefasComFalha: [],
    ranking: [],
    ...over
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
