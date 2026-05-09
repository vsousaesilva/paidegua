/**
 * Detector contextual proativo de tarefa do PJe (FLUX-04).
 *
 * Quando o servidor está numa tela do PJe que cita o nome de uma
 * tarefa humana conhecida do catálogo (ex.: "[JEF] Análise inicial"),
 * detectamos isso e oferecemos abrir a vista da tarefa nos Mapas de
 * Jornada — sem que o usuário precise digitar nada.
 *
 * Não-intrusivo: dispensa-se com um clique, e a mesma tarefa não
 * reaparece nesta sessão. Sem persistência no storage — só `Set` em
 * memória.
 */

import { getIndiceTarefas, type TarefaIndice } from '../../shared/tarefas-indice';

export interface TarefaContextualHandlers {
  onTarefaDetectada: (tarefa: TarefaIndice) => void;
}

interface DetectorState {
  regex: RegExp | null;
  porNome: Map<string, TarefaIndice>;
  ultimaDetectada: string | null;
  dispensadas: Set<string>;
  carregando: boolean;
  carregado: boolean;
  handlers: TarefaContextualHandlers | null;
  observer: MutationObserver | null;
  scheduled: number | null;
}

const state: DetectorState = {
  regex: null,
  porNome: new Map(),
  ultimaDetectada: null,
  dispensadas: new Set(),
  carregando: false,
  carregado: false,
  handlers: null,
  observer: null,
  scheduled: null
};

const DEBOUNCE_MS = 1500;

/**
 * Carrega as tarefas humanas do catálogo e monta UM regex global.
 * Filtra apenas tarefas com PREFIXO entre colchetes (`[JEF]`, `[EF]`,
 * `[PREVJUD]`, `[ECARTA]`...) — nomes "soltos" da lane Comum
 * ("Comunicação - Elaborar", "Audiência - Designar") são ambíguos
 * demais e geram falso positivo em qualquer menu/link do PJe que
 * cite essas palavras. Tarefas com prefixo são inequívocas.
 *
 * Match único contra body.innerText devolve o primeiro nome
 * encontrado — bem mais barato que ~430 testes individuais.
 */
async function carregarRegex(): Promise<void> {
  if (state.carregado || state.carregando) return;
  state.carregando = true;
  try {
    const lista = await getIndiceTarefas();
    const dedup = new Map<string, TarefaIndice>();
    for (const t of lista) {
      // Filtro chave: só tarefas com prefixo entre colchetes (inequívocas).
      if (!/^\[[A-Z]+\]/.test(t.nome)) continue;
      // Escolhe a primeira ocorrência de cada nome (vários fluxos podem
      // ter task-nodes homônimas; o detector só precisa de um match por
      // nome — id é único, navegação resolve depois).
      if (!dedup.has(t.nome)) dedup.set(t.nome, t);
    }
    state.porNome = dedup;
    // Ordena por comprimento decrescente para que nomes mais específicos
    // ("[JEF] Análise inicial - Perícia") vençam sobre prefixos
    // ("[JEF] Análise inicial").
    const nomes = [...dedup.keys()].sort((a, b) => b.length - a.length);
    const escapados = nomes.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    state.regex = new RegExp(escapados.join('|'), 'g');
    state.carregado = true;
  } finally {
    state.carregando = false;
  }
}

/**
 * Procura uma tarefa conhecida usando o SELETOR OFICIAL do header da
 * tela de tarefa do PJe v2 (Angular):
 *
 *   <span class="nome-tarefa" title="[JEF] Arquivamento - Analisar nova petição">
 *
 * Quando bate, temos certeza alta: o usuário está NA tarefa. Não há
 * fallback de varredura ampla — gerava falso positivo em menus/sidebars
 * que listam tarefas (Quadro de avisos, hamburguer do PJe, etc.).
 * Em telas sem esse seletor (PJe legacy puro, painéis, etc.) o detector
 * simplesmente não dispara — o que é o comportamento desejado.
 *
 * Variantes aceitas: `.nome-tarefa` (Angular), `h1.tarefa` (futuro), e
 * `[data-paidegua-nome-tarefa]` (override manual em testes).
 */
function procurarTarefaNaPagina(): TarefaIndice | null {
  if (!state.carregado) return null;
  const seletorEl = document.querySelector<HTMLElement>(
    '.nome-tarefa, [class*="nome-tarefa"], h1.tarefa, [data-paidegua-nome-tarefa]'
  );
  if (!seletorEl) return null;
  const candidato = (seletorEl.getAttribute('title') || seletorEl.textContent || '').trim();
  if (!candidato) return null;
  return state.porNome.get(candidato) ?? null;
}

function escanear(): void {
  state.scheduled = null;
  if (!state.handlers) return;
  const t = procurarTarefaNaPagina();
  if (!t) return;
  if (t.nome === state.ultimaDetectada) return;
  if (state.dispensadas.has(t.nome)) return;
  state.ultimaDetectada = t.nome;
  state.handlers.onTarefaDetectada(t);
}

function agendarEscaneamento(): void {
  if (state.scheduled !== null) return;
  state.scheduled = window.setTimeout(escanear, DEBOUNCE_MS);
}

/**
 * Instala o detector. Idempotente — chamadas adicionais reinstalam
 * apenas o handler. O carregamento do regex é assíncrono mas não
 * bloqueia o caller.
 */
export function instalarDetectorTarefaContextual(handlers: TarefaContextualHandlers): void {
  state.handlers = handlers;
  void carregarRegex().then(() => {
    if (state.carregado) escanear();
  });
  if (state.observer) return; // já instalado
  state.observer = new MutationObserver(() => agendarEscaneamento());
  state.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
  // Primeira tentativa também em URL change (Angular do PJe v2).
  window.addEventListener('popstate', () => agendarEscaneamento());
}

/**
 * Marca a tarefa como dispensada nesta sessão — não reaparece até
 * o usuário recarregar a página.
 */
export function dispensarTarefaContextual(nome: string): void {
  state.dispensadas.add(nome);
  if (state.ultimaDetectada === nome) state.ultimaDetectada = null;
}

/** Estado de teste / debug. */
export function _statusDetector(): { carregado: boolean; ultima: string | null; dispensadas: number } {
  return {
    carregado: state.carregado,
    ultima: state.ultimaDetectada,
    dispensadas: state.dispensadas.size
  };
}
