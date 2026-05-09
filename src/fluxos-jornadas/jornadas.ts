/**
 * Mapas de Jornada — entry da página `fluxos-jornadas/jornadas.html`.
 *
 * Renderiza, em ordem:
 *   - Camada 1 (Mapa unificado): SVG horizontal com 9 fases canônicas
 *     no eixo X e agrupamentos do JEF como caixas clicáveis.
 *   - Camada 2 (Trilhas): 5 cards horizontais com estações do fluxo.
 *
 * Estratégia visual:
 *   - SVG puro (sem D3 nem libs externas) para Camada 1 — leve e
 *     auditável; D3 só vira dependência se virmos necessidade real
 *     de zoom/pan.
 *   - Cards DOM para Camada 2 — melhor para acessibilidade e teclado.
 *
 * Acesso ao detalhe de cada fluxo (Camada 3) chega no FLUX-10.
 */

import {
  getCatalogo
} from '../shared/fluxos-store';
import { buscar } from '../shared/fluxos-search';
import { registrar as registrarTelemetria } from '../shared/jornadas-telemetria';
import {
  buscarTarefas,
  getIndiceTarefas,
  type TarefaIndice
} from '../shared/tarefas-indice';
import type {
  CatalogoFluxos,
  FluxoEntrada,
  Jornada,
  JornadaTrilha,
  JornadaAgrupamento,
  AlertaFluxo,
  EnriquecimentoFluxo
} from '../shared/fluxos-types';

const STORAGE_KEY_TECNICO = 'paidegua/jornadas/modo-tecnico';

interface Estado {
  lane: 'jef' | 'ef' | 'comum';
  catalogo: CatalogoFluxos | null;
  jornada: Jornada | null;
  fluxoPorCodigo: Map<string, FluxoEntrada>;
  modoTecnico: boolean;
}

const estado: Estado = {
  lane: 'jef',
  catalogo: null,
  jornada: null,
  fluxoPorCodigo: new Map(),
  modoTecnico: false
};

document.addEventListener('DOMContentLoaded', () => {
  void inicializar();
});

async function inicializar(): Promise<void> {
  estado.lane = lerLaneDaUrl();
  estado.modoTecnico = (localStorage.getItem(STORAGE_KEY_TECNICO) ?? 'false') === 'true';
  document.body.dataset.tecnico = String(estado.modoTecnico);
  marcarLaneAtivaNaNav();
  ativarBotoes();
  bindPalette();

  // Todas as 3 lanes (jef/ef/comum) têm jornadas-<lane>.json — nenhuma
  // cai mais em renderizarLaneIndisponivel(). A função é mantida como
  // fallback caso uma lane futura não tenha JSON ainda.

  try {
    const [catalogo, jornada] = await Promise.all([
      getCatalogo(),
      carregarJornada(estado.lane)
    ]);
    estado.catalogo = catalogo;
    estado.jornada = jornada;
    estado.fluxoPorCodigo = new Map(catalogo.fluxos.map((f) => [f.codigo, f]));
    renderizarMapa();
    renderizarTrilhas();
    rotear();
    window.addEventListener('popstate', () => rotear());
    registrarTelemetria({ tipo: 'pagina_carregada', lane: estado.lane });
  } catch (e) {
    mostrarErro(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Roteador minimal por query string. Mostra a vista correta entre
 * mapa+trilhas (default), estação (?fluxo=X) e catálogo (?lista=1).
 */
function rotear(): void {
  const params = new URLSearchParams(location.search);
  const fluxo = params.get('fluxo');
  const tarefa = params.get('tarefa');
  const lista = params.get('lista') === '1';

  const elMapa     = document.getElementById('camada-mapa');
  const elTrilhas  = document.getElementById('camada-trilhas');
  const elEstacao  = document.getElementById('camada-estacao');
  const elCatalogo = document.getElementById('camada-catalogo');
  if (!elMapa || !elTrilhas || !elEstacao || !elCatalogo) return;

  if (tarefa) {
    elMapa.hidden = true;
    elTrilhas.hidden = true;
    elCatalogo.hidden = true;
    elEstacao.hidden = false;
    void renderizarTarefaPagina(tarefa);
    registrarTelemetria({ tipo: 'estacao_aberta', lane: estado.lane, alvo: tarefa });
  } else if (fluxo) {
    elMapa.hidden = true;
    elTrilhas.hidden = true;
    elCatalogo.hidden = true;
    elEstacao.hidden = false;
    renderizarEstacaoPagina(fluxo);
    registrarTelemetria({ tipo: 'estacao_aberta', lane: estado.lane, alvo: fluxo });
  } else if (lista) {
    elMapa.hidden = true;
    elTrilhas.hidden = true;
    elEstacao.hidden = true;
    elCatalogo.hidden = false;
    void renderizarCatalogo();
    registrarTelemetria({ tipo: 'catalogo_aberto', lane: estado.lane });
  } else {
    elMapa.hidden = false;
    elTrilhas.hidden = false;
    elEstacao.hidden = true;
    elCatalogo.hidden = true;
    registrarTelemetria({ tipo: 'mapa_aberto', lane: estado.lane });
  }
  window.scrollTo({ top: 0 });
}

/**
 * Página dedicada de TAREFA (Camada 3 — pivot FLUX-17 / F3).
 * Layout próprio centrado na tarefa humana: nome oficial em destaque,
 * responsável, próximas tarefas como botões clicáveis, alertas da
 * rotina pai, outras tarefas da mesma rotina, e ações.
 */
async function renderizarTarefaPagina(tarefaId: string): Promise<void> {
  const host = document.getElementById('estacao-host');
  if (!host) return;
  host.innerHTML = '<div class="catalogo-vazio">Carregando tarefa…</div>';

  const { getTarefa, getTarefasDoFluxo } = await import('../shared/tarefas-indice');
  const t = await getTarefa(tarefaId);
  if (!t) {
    host.innerHTML = `<div class="catalogo-vazio">
      <p>Tarefa não encontrada no catálogo.</p>
      <p class="muted small">Pode ser uma tarefa descontinuada ou ainda não coletada do PJe.</p>
    </div>`;
    return;
  }

  // Pré-carrega outras tarefas da mesma rotina (para o bloco "outras tarefas").
  const irmas = (await getTarefasDoFluxo(t.fluxoCodigo)).filter((x) => x.id !== t.id);

  host.innerHTML = '';

  // ─── Cabeçalho ───
  const cab = document.createElement('header');
  cab.className = 'fluxo-page__cabecalho';
  const metas = document.createElement('div');
  metas.className = 'fluxo-page__metas';
  metas.appendChild(pillMeta(t.lane, `lane-${t.lane.toLowerCase()}`));
  if (t.swimlane) metas.appendChild(pillMeta(`Responsável: ${t.swimlane}`));
  if (t.fase && t.fase !== 'Indefinido') metas.appendChild(pillMeta(t.fase));
  cab.appendChild(metas);

  const tit = document.createElement('h1');
  tit.className = 'fluxo-page__titulo';
  tit.textContent = t.nome;
  cab.appendChild(tit);
  host.appendChild(cab);

  // ─── Frase humana da rotina pai (modo usuário, sem nome técnico) ───
  if (t.fraseFluxoPai) {
    const fr = document.createElement('p');
    fr.className = 'fluxo-page__frase';
    fr.textContent = t.fraseFluxoPai;
    host.appendChild(fr);
  }

  // ─── Próximas tarefas — botões clicáveis quando o destino é tarefa conhecida ───
  if (t.transicoes.length > 0) {
    const sec = document.createElement('section');
    const h = document.createElement('h2');
    h.className = 'fluxo-page__bloco-titulo';
    h.textContent = 'O que pode acontecer a partir daqui';
    sec.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'fluxo-page__transicoes';
    t.transicoes.forEach((tr) => {
      const card = document.createElement('div');
      card.className = 'fluxo-page__transicao';
      const acao = document.createElement('div');
      acao.className = 'fluxo-page__transicao-acao';
      acao.textContent = tr.nome || 'transição';
      card.appendChild(acao);
      const destino = document.createElement('div');
      destino.className = 'fluxo-page__transicao-destino';
      destino.textContent = limparDestino(tr.para);
      card.appendChild(destino);
      sec.appendChild(card);
      grid.appendChild(card);
    });
    sec.appendChild(grid);
    host.appendChild(sec);
  }

  // ─── Pontos de atenção (herdados da rotina pai) ───
  if (t.alertasFluxoPai.length > 0) {
    const sec = document.createElement('section');
    const h = document.createElement('h2');
    h.className = 'fluxo-page__bloco-titulo';
    h.textContent = 'Pontos de atenção desta rotina';
    sec.appendChild(h);
    const lista = document.createElement('div');
    lista.className = 'fluxo-page__alertas';
    t.alertasFluxoPai.forEach((a) => lista.appendChild(renderAlertaCompleto(a)));
    sec.appendChild(lista);
    host.appendChild(sec);
  }

  // ─── Outras tarefas da mesma rotina ───
  if (irmas.length > 0) {
    const sec = document.createElement('section');
    const h = document.createElement('h2');
    h.className = 'fluxo-page__bloco-titulo';
    h.textContent = `Outras tarefas desta rotina (${irmas.length})`;
    sec.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'fluxo-page__irmas';
    irmas.slice(0, 12).forEach((irma) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fluxo-page__irma';
      btn.textContent = irma.nome;
      btn.addEventListener('click', () => navegarPara({ tarefa: irma.id }));
      grid.appendChild(btn);
    });
    if (irmas.length > 12) {
      const mais = document.createElement('p');
      mais.className = 'muted small';
      mais.style.cssText = 'margin: 6px 0 0;';
      mais.textContent = `+${irmas.length - 12} outras tarefas. Use Ctrl+K para buscar.`;
      sec.appendChild(mais);
    }
    sec.appendChild(grid);
    host.appendChild(sec);
  }

  // ─── Modo técnico: revela rotina pai/código ───
  const tec = document.createElement('details');
  tec.className = 'fluxo-page__tecnico tecnico-only';
  if (estado.modoTecnico) tec.open = true;
  const sum = document.createElement('summary');
  sum.className = 'fluxo-page__tecnico-summary';
  sum.textContent = 'Detalhes técnicos';
  tec.appendChild(sum);
  const corpo = document.createElement('div');
  corpo.className = 'fluxo-page__tecnico-corpo';
  const dl = document.createElement('dl');
  dl.appendChild(dlRow('Rotina (etapa pai)', t.fluxoNome));
  dl.appendChild(dlRow('Código do fluxo', t.fluxoCodigo));
  dl.appendChild(dlRow('Swimlane', t.swimlane || '—'));
  dl.appendChild(dlRow('Transições', String(t.transicoes.length)));
  dl.appendChild(dlRow('Tarefas irmãs', String(irmas.length)));
  corpo.appendChild(dl);
  tec.appendChild(corpo);
  host.appendChild(tec);

  // ─── Ações ───
  const acoes = document.createElement('div');
  acoes.className = 'fluxo-page__acoes';
  const acaoConsultor = document.createElement('a');
  acaoConsultor.className = 'fluxo-page__acao';
  acaoConsultor.href = chrome.runtime.getURL('fluxos-consultor/consultor.html');
  acaoConsultor.target = '_blank';
  acaoConsultor.rel = 'noopener';
  acaoConsultor.textContent = 'Perguntar ao Consultor sobre esta tarefa';
  acoes.appendChild(acaoConsultor);
  const acaoCatalogo = document.createElement('button');
  acaoCatalogo.className = 'fluxo-page__acao fluxo-page__acao--ghost';
  acaoCatalogo.type = 'button';
  acaoCatalogo.textContent = 'Ver catálogo de tarefas';
  acaoCatalogo.addEventListener('click', () => navegarPara({ lista: '1' }));
  acoes.appendChild(acaoCatalogo);
  const acaoEtapa = document.createElement('button');
  acaoEtapa.className = 'fluxo-page__acao fluxo-page__acao--ghost tecnico-only';
  acaoEtapa.type = 'button';
  acaoEtapa.textContent = 'Abrir rotina pai (modo técnico)';
  acaoEtapa.addEventListener('click', () => navegarPara({ fluxo: t.fluxoCodigo }));
  acoes.appendChild(acaoEtapa);
  host.appendChild(acoes);
}

/** Higieniza o destino de uma transição (remove "Incluir no fluxo de"). */
function limparDestino(s: string): string {
  return s.replace(/^Incluir no fluxo de\s+/i, '').trim();
}

/** Atualiza o histórico do navegador sem recarregar. Aceita `fluxo`,
 * `tarefa` ou `lista` como query (em ordem de prioridade no `rotear`). */
function navegarPara(params: Record<string, string | undefined>): void {
  const sp = new URLSearchParams();
  sp.set('lane', estado.lane);
  for (const [k, v] of Object.entries(params)) {
    if (v) sp.set(k, v);
  }
  const url = `${location.pathname}?${sp.toString()}`;
  history.pushState({}, '', url);
  rotear();
}

function lerLaneDaUrl(): 'jef' | 'ef' | 'comum' {
  const raw = new URLSearchParams(location.search).get('lane');
  if (raw === 'ef' || raw === 'comum') return raw;
  return 'jef';
}

async function carregarJornada(lane: 'jef' | 'ef' | 'comum'): Promise<Jornada> {
  const url = chrome.runtime.getURL(`assets/jornadas-${lane}.json`);
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(
      `Arquivo de jornadas não encontrado (assets/jornadas-${lane}.json). ` +
        'Garantir que o build copia o asset.'
    );
  }
  return (await r.json()) as Jornada;
}

function marcarLaneAtivaNaNav(): void {
  const chips = document.querySelectorAll<HTMLAnchorElement>('.lane-chip');
  chips.forEach((c) => {
    if (c.dataset.lane === estado.lane) {
      c.classList.add('is-active');
      c.setAttribute('aria-current', 'page');
    }
  });
  const titulo = document.getElementById('page-titulo');
  const subtitulo = document.getElementById('page-subtitulo');
  if (titulo && subtitulo) {
    if (estado.lane === 'jef') {
      titulo.textContent = 'Mapa de Jornada — JEF';
      subtitulo.textContent = 'Por onde o processo caminha nos Juizados Especiais Federais.';
    } else if (estado.lane === 'ef') {
      titulo.textContent = 'Mapa de Jornada — Execução Fiscal';
      subtitulo.textContent = 'Citação, penhora online (SISBAJUD/RENAJUD), cálculo, sobrestamento e arquivo.';
    } else {
      titulo.textContent = 'Mapa de Jornada — Cível e Criminal';
      subtitulo.textContent = 'Comunicação, audiência, perícia, decisão, trânsito em julgado e arquivo nas varas comuns federais.';
    }
  }
}

function ativarBotoes(): void {
  const btnImprimir = document.getElementById('btn-imprimir');
  if (btnImprimir) {
    btnImprimir.addEventListener('click', () => {
      registrarTelemetria({ tipo: 'imprimir_clicado', lane: estado.lane });
      window.print();
    });
  }

  const btnTecnico = document.getElementById('btn-tecnico');
  if (btnTecnico) {
    btnTecnico.setAttribute('aria-pressed', String(estado.modoTecnico));
    btnTecnico.addEventListener('click', () => {
      estado.modoTecnico = !estado.modoTecnico;
      localStorage.setItem(STORAGE_KEY_TECNICO, String(estado.modoTecnico));
      document.body.dataset.tecnico = String(estado.modoTecnico);
      btnTecnico.setAttribute('aria-pressed', String(estado.modoTecnico));
      registrarTelemetria({
        tipo: 'modo_tecnico_toggled',
        lane: estado.lane,
        alvo: String(estado.modoTecnico)
      });
    });
  }

  const btnBuscar = document.getElementById('btn-buscar');
  if (btnBuscar) btnBuscar.addEventListener('click', () => abrirPalette());

  const btnCatalogo = document.getElementById('btn-catalogo');
  if (btnCatalogo) btnCatalogo.addEventListener('click', () => navegarPara({ lista: '1' }));
}

/* ───────────────────── Camada 1 — Mapa unificado ─────────────────────
 * Implementação em CSS Grid HTML — uma única grade compartilhada entre
 * a régua de fases (linha 1) e os cards de agrupamento (linha 2). Cada
 * agrupamento ocupa N colunas via `grid-column: <inicio> / <fim+1>`,
 * onde inicio/fim são derivados do par faseInicial/faseFinal do JSON
 * (com fallback para o campo `ordem`).
 *
 * Vantagens sobre o SVG anterior: textos quebram naturalmente, badges
 * podem ficar livres do título, responsivo sem viewBox, acessibilidade
 * via tag native sem aria gymnastics. */

function renderizarMapa(): void {
  const host = document.getElementById('mapa-host');
  if (!host || !estado.jornada) return;
  host.innerHTML = '';

  const fases = estado.jornada.fasesCanonicas.slice().sort((a, b) => a.ordem - b.ordem);
  const agrupamentos = estado.jornada.agrupamentos.slice().sort((a, b) => a.ordem - b.ordem);

  const wrap = document.createElement('div');
  wrap.className = 'mapa-grid';
  wrap.style.setProperty('--num-fases', String(fases.length));

  // Linha 1 — régua de fases.
  fases.forEach((f, i) => {
    const cell = document.createElement('div');
    cell.className = 'fase-cell';
    cell.style.gridColumn = `${i + 1} / ${i + 2}`;
    cell.textContent = f.nome;
    wrap.appendChild(cell);
  });

  // Mapa fase-id → coluna (1-based).
  const colByFaseId = new Map(fases.map((f, i) => [f.id, i + 1]));

  // Linha 2 — cards de agrupamento, cada um com grid-column derivado.
  agrupamentos.forEach((g) => {
    const startCol: number = g.faseInicial
      ? colByFaseId.get(g.faseInicial) ?? g.ordem
      : g.ordem;
    const endCol: number = g.faseFinal
      ? colByFaseId.get(g.faseFinal) ?? startCol
      : startCol;
    // grid-column: start / end+1 (end exclusivo).
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `agrupamento-card lane-${estado.lane}`;
    card.dataset.agrupamento = g.id;
    card.style.gridColumn = `${startCol} / ${endCol + 1}`;
    card.style.gridRow = '2';
    card.setAttribute('aria-label', `Agrupamento: ${g.nome}. Clique para abrir a trilha.`);

    const tit = document.createElement('h3');
    tit.className = 'agrupamento-card__titulo';
    tit.textContent = g.nome;
    card.appendChild(tit);

    const desc = document.createElement('p');
    desc.className = 'agrupamento-card__desc';
    desc.textContent = g.descricaoCurta;
    card.appendChild(desc);

    // Pivot FLUX-17 (2026-05-07): preferir tarefasPrincipais (nomes
    // que o servidor vê na fila do PJe) sobre fluxosPrincipais.
    // Fluxos só aparecem como fallback quando não há tarefas curadas.
    const tarefas = g.tarefasPrincipais ?? [];
    if (tarefas.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'agrupamento-card__fluxos';
      tarefas.slice(0, 5).forEach((nomeTarefa) => {
        const li = document.createElement('li');
        li.textContent = nomeTarefa;
        ul.appendChild(li);
      });
      card.appendChild(ul);
    } else if (g.fluxosPrincipais.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'agrupamento-card__fluxos';
      g.fluxosPrincipais.slice(0, 4).forEach((cod) => {
        const fluxo = estado.fluxoPorCodigo.get(cod);
        const li = document.createElement('li');
        li.textContent = fluxo ? fraseCurta(fluxo) : cod;
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }

    // Badges de alerta no rodapé do card (longe do título).
    const alertasGrupo = coletarAlertasDoAgrupamento(g);
    if (alertasGrupo.length > 0) {
      const badges = document.createElement('div');
      badges.className = 'agrupamento-card__badges';
      uniq(alertasGrupo.map((a) => a.tipo))
        .slice(0, 4)
        .forEach((tipo) => {
          const b = document.createElement('span');
          b.className = `card-badge card-badge--${tipo}`;
          b.title = legendaAlertaCompleta(tipo);
          b.textContent = `${emojiAlerta(tipo)} ${mapaAlertaLegivel(tipo)}`;
          badges.appendChild(b);
        });
      card.appendChild(badges);
    }

    card.addEventListener('click', () => abrirAgrupamento(g.id));
    wrap.appendChild(card);
  });

  host.appendChild(wrap);
}

function abrirAgrupamento(id: string): void {
  registrarTelemetria({ tipo: 'agrupamento_clicado', lane: estado.lane, alvo: id });
  const alvo = document.querySelector<HTMLElement>(`[data-agrupamento-trilha="${id}"]`);
  if (alvo) {
    alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
    alvo.classList.add('is-foco-temporario');
    setTimeout(() => alvo.classList.remove('is-foco-temporario'), 1200);
  } else {
    // Sem trilha vinculada — apenas leva ao topo da seção.
    document.getElementById('camada-trilhas')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ───────────────────── Camada 2 — Trilhas temáticas ─────────────────── */

function renderizarTrilhas(): void {
  const host = document.getElementById('trilhas-host');
  if (!host || !estado.jornada) return;
  host.innerHTML = '';

  estado.jornada.trilhas.forEach((trilha) => {
    host.appendChild(renderizarTrilha(trilha));
  });
}

function renderizarTrilha(trilha: JornadaTrilha): HTMLElement {
  const wrap = document.createElement('article');
  wrap.className = 'trilha';
  wrap.dataset.trilhaId = trilha.id;
  wrap.dataset.agrupamentoTrilha = trilha.agrupamento;
  wrap.setAttribute('aria-labelledby', `trilha-${trilha.id}-titulo`);

  const head = document.createElement('header');
  head.className = 'trilha__cabecalho';

  const ico = document.createElement('span');
  ico.className = 'trilha__icone';
  ico.setAttribute('aria-hidden', 'true');
  ico.textContent = iniciaisDoIcone(trilha.icone);
  head.appendChild(ico);

  const tit = document.createElement('h3');
  tit.id = `trilha-${trilha.id}-titulo`;
  tit.className = 'trilha__titulo';
  tit.textContent = trilha.nome;
  head.appendChild(tit);

  wrap.appendChild(head);

  const resumo = document.createElement('p');
  resumo.className = 'trilha__resumo';
  resumo.textContent = trilha.descricaoCurta;
  wrap.appendChild(resumo);

  const estacoes = document.createElement('div');
  estacoes.className = 'estacoes';
  estacoes.setAttribute('role', 'list');
  trilha.estacoes.forEach((est) => {
    estacoes.appendChild(renderizarEstacao(est));
  });
  wrap.appendChild(estacoes);

  return wrap;
}

/**
 * Renderiza um card de estação (Camada 2). Pivot FLUX-17: estação
 * pode ter `tarefa` (nome oficial da tarefa humana — preferido) ou
 * `fluxo` (código de fluxo — fallback). Click navega para a página
 * da tarefa ou da etapa pai conforme o caso.
 */
function renderizarEstacao(est: {
  tarefa?: string;
  fluxo?: string;
  papel: string;
  rotulo?: string;
}): HTMLElement {
  const card = document.createElement('div');
  card.className = `estacao estacao--${est.papel}`;
  card.setAttribute('role', 'listitem');
  card.setAttribute('tabindex', '0');

  const papelEl = document.createElement('div');
  papelEl.className = 'estacao__papel';
  papelEl.textContent = mapaPapelLegivel(est.papel);
  card.appendChild(papelEl);

  const rotEl = document.createElement('p');
  rotEl.className = 'estacao__rotulo';
  // Em modo TAREFA, o rótulo é o próprio nome da tarefa (com [JEF]).
  rotEl.textContent = est.tarefa || est.rotulo || est.fluxo || '?';
  card.appendChild(rotEl);

  if (est.tarefa) {
    card.dataset.tarefa = est.tarefa;
    card.setAttribute('aria-label', `Tarefa ${est.tarefa}.`);
    // Click: resolve o id no índice de tarefas e navega para ?tarefa=<id>.
    const handler = async (): Promise<void> => {
      const { getIndiceTarefas } = await import('../shared/tarefas-indice');
      const lista = await getIndiceTarefas();
      const t = lista.find((x) => x.nome === est.tarefa);
      if (t) navegarPara({ tarefa: t.id });
    };
    card.addEventListener('click', () => void handler());
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        void handler();
      }
    });
  } else if (est.fluxo) {
    // Fallback: estação ainda referencia fluxo (modo técnico).
    const fluxo = estado.fluxoPorCodigo.get(est.fluxo);
    card.dataset.fluxo = est.fluxo;
    card.setAttribute('aria-label', `Etapa ${est.rotulo || est.fluxo}.`);
    if (fluxo?.enriquecimento?.frase_humana) {
      const frase = document.createElement('p');
      frase.className = 'estacao__frase';
      frase.textContent = fluxo.enriquecimento.frase_humana;
      card.appendChild(frase);
    }
    const cod = document.createElement('span');
    cod.className = 'estacao__codigo tecnico-only';
    cod.textContent = est.fluxo;
    card.appendChild(cod);
    card.addEventListener('click', () => navegarPara({ fluxo: est.fluxo }));
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        navegarPara({ fluxo: est.fluxo });
      }
    });
  } else {
    const aviso = document.createElement('p');
    aviso.className = 'estacao__frase';
    aviso.textContent = 'Tarefa sem destino configurado.';
    card.appendChild(aviso);
  }

  return card;
}

/* ───────────────────── Helpers visuais ──────────────────────────── */

function emojiAlerta(tipo: AlertaFluxo['tipo']): string {
  switch (tipo) {
    case 'hub': return '⬢';
    case 'decisao_automatica': return '⚙';
    case 'loop': return '↻';
    case 'prazo_paralelo': return '⏱';
    case 'fantasma_downstream': return '⚠';
    case 'subfluxo_shared': return '⇄';
    default: return '·';
  }
}

function mapaAlertaLegivel(tipo: AlertaFluxo['tipo']): string {
  switch (tipo) {
    case 'hub': return 'hub';
    case 'decisao_automatica': return 'automática';
    case 'loop': return 'ciclo';
    case 'prazo_paralelo': return 'prazo';
    case 'fantasma_downstream': return 'descontinuado';
    case 'subfluxo_shared': return 'compartilhado';
    default: return tipo;
  }
}

function legendaAlertaCompleta(tipo: AlertaFluxo['tipo']): string {
  switch (tipo) {
    case 'hub': return 'Esta rotina é um ponto de convergência — quase todo processo passa por aqui.';
    case 'decisao_automatica': return 'Decisão tomada automaticamente pelo sistema, sem intervenção do servidor.';
    case 'loop': return 'Esta rotina pode se repetir — o processo costuma voltar a passar por aqui.';
    case 'prazo_paralelo': return 'Há relógio de prazo rolando em paralelo a esta rotina.';
    case 'fantasma_downstream': return 'Esta rotina dispara um fluxo descontinuado ou ausente do catálogo do PJe.';
    case 'subfluxo_shared': return 'Esta rotina reusa subfluxo compartilhado com outras competências.';
    default: return tipo;
  }
}

function mapaPapelLegivel(papel: string): string {
  switch (papel) {
    case 'principal': return 'caminho típico';
    case 'ramificacao': return 'ramificação';
    case 'origem': return 'origem';
    case 'retorno': return 'retorno';
    default: return papel;
  }
}

function coletarAlertasDoAgrupamento(g: JornadaAgrupamento): AlertaFluxo[] {
  const out: AlertaFluxo[] = [];
  for (const cod of g.fluxosPrincipais) {
    const fluxo = estado.fluxoPorCodigo.get(cod);
    if (fluxo?.enriquecimento?.alertas) out.push(...fluxo.enriquecimento.alertas);
  }
  return out;
}

function fraseCurta(fluxo: FluxoEntrada): string {
  const enr: EnriquecimentoFluxo | undefined = fluxo.enriquecimento;
  if (enr?.frase_humana) return enr.frase_humana.split(' — ')[0];
  return fluxo.nome.replace(/^\[JEF\]\s*/i, '');
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function iniciaisDoIcone(nome: string): string {
  const map: Record<string, string> = {
    'users-round': '◇',
    stethoscope: '✚',
    gavel: '§',
    'arrow-up-right': '↗',
    wallet: '$'
  };
  return map[nome] ?? '·';
}

/* ───────────────────── Estados de erro ──────────────────────────── */
// renderizarLaneIndisponivel() removida — todas as 3 lanes (jef/ef/comum)
// têm assets/jornadas-<lane>.json. Lanes sem JSON caem no mostrarErro()
// quando o fetch falha em carregarJornada(). Restaurar se uma lane futura
// for cadastrada sem JSON.

function mostrarErro(msg: string): void {
  const host = document.getElementById('mapa-host');
  if (!host) return;
  host.innerHTML = '';
  const div = document.createElement('div');
  div.style.padding = '24px';
  div.style.color = 'var(--danger)';
  div.style.background = '#fee2e2';
  div.style.border = '1px solid #fca5a5';
  div.style.borderRadius = '6px';
  div.style.maxWidth = '720px';
  div.style.margin = '24px auto';
  div.innerHTML = `<strong>Falha ao carregar dados.</strong><br><br>${escapeHtml(msg)}<br><br><span class="muted small">Verifique se o catálogo embarcado e <code>jornadas-jef.json</code> foram gerados (rodar <code>gerar-catalogo.bat</code> + <code>enriquecer-catalogo.bat</code>) antes do build.</span>`;
  host.appendChild(div);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

/* ───────────────────── Camada 3 — Vista de estação ───────────────────── */

function renderizarEstacaoPagina(codigo: string): void {
  const host = document.getElementById('estacao-host');
  if (!host) return;
  host.innerHTML = '';

  const fluxo = estado.fluxoPorCodigo.get(codigo);
  if (!fluxo) {
    host.innerHTML = `
      <div class="catalogo-vazio">
        <p>Fluxo <code>${escapeHtml(codigo)}</code> não encontrado no catálogo.</p>
        <p class="muted small">Pode ser um fluxo descontinuado, com erro de digitação, ou ainda não coletado.</p>
      </div>`;
    return;
  }

  const enr = fluxo.enriquecimento;
  const nomeLimpo = fluxo.nome.replace(/^\[JEF\]\s*/i, '').trim() || fluxo.codigo;

  // Cabeçalho
  const cab = document.createElement('header');
  cab.className = 'fluxo-page__cabecalho';
  const metas = document.createElement('div');
  metas.className = 'fluxo-page__metas';
  metas.appendChild(pillMeta(fluxo.lane, `lane-${fluxo.lane.toLowerCase()}`));
  if (fluxo.fase && fluxo.fase !== 'Indefinido') metas.appendChild(pillMeta(fluxo.fase));
  if (enr && enr.grau_total >= 20) {
    metas.appendChild(pillMeta(`hub · ${enr.grau_total} conexões`));
  }
  if (fluxo.faseOrigem === 'manual') metas.appendChild(pillMeta('classificação validada'));
  cab.appendChild(metas);

  const tit = document.createElement('h1');
  tit.className = 'fluxo-page__titulo';
  tit.textContent = nomeLimpo;
  cab.appendChild(tit);

  if (estado.modoTecnico) {
    const cod = document.createElement('span');
    cod.className = 'fluxo-page__codigo-tecnico';
    cod.textContent = `código: ${fluxo.codigo} · arquivo: ${fluxo.arquivoOrigem}`;
    cab.appendChild(cod);
  }
  host.appendChild(cab);

  // Frase humana
  if (enr?.frase_humana) {
    const fr = document.createElement('p');
    fr.className = 'fluxo-page__frase';
    fr.textContent = enr.frase_humana;
    host.appendChild(fr);
  }

  // De onde vem / Para onde vai
  const grid = document.createElement('div');
  grid.className = 'fluxo-page__grid';
  grid.appendChild(renderBlocoVizinhos('De onde vem', enr?.top_origens ?? []));
  grid.appendChild(renderBlocoVizinhos('Para onde vai', enr?.top_destinos ?? []));
  host.appendChild(grid);

  // Pontos de atenção
  if (enr?.alertas && enr.alertas.length > 0) {
    const sec = document.createElement('section');
    sec.innerHTML = '<h2 class="fluxo-page__bloco-titulo">Pontos de atenção</h2>';
    const lista = document.createElement('div');
    lista.className = 'fluxo-page__alertas';
    enr.alertas.forEach((a) => lista.appendChild(renderAlertaCompleto(a)));
    sec.appendChild(lista);
    host.appendChild(sec);
  }

  // Modo técnico — colapsável
  const tec = document.createElement('details');
  tec.className = 'fluxo-page__tecnico';
  if (estado.modoTecnico) tec.open = true;
  const sum = document.createElement('summary');
  sum.className = 'fluxo-page__tecnico-summary';
  sum.textContent = 'Detalhes técnicos';
  tec.appendChild(sum);

  const corpo = document.createElement('div');
  corpo.className = 'fluxo-page__tecnico-corpo';
  const dl = document.createElement('dl');
  dl.appendChild(dlRow('Código', fluxo.codigo));
  dl.appendChild(dlRow('Lane', fluxo.lane));
  dl.appendChild(dlRow('Fase', `${fluxo.fase} (${fluxo.faseOrigem})`));
  dl.appendChild(dlRow('Swimlanes', fluxo.swimlanes.map((s) => s.nome).join(', ') || '—'));
  dl.appendChild(dlRow('Tarefas', String(fluxo.taskNodes.length)));
  dl.appendChild(dlRow('Decisões', String(fluxo.decisoes.length)));
  dl.appendChild(dlRow('Subfluxos chamados', String(fluxo.subfluxosChamados.length)));
  dl.appendChild(dlRow('Pontos finais', fluxo.fins.map((e) => e.nome).join(', ') || '—'));
  corpo.appendChild(dl);

  // Decisões (resumo legível, sem jPDL cru)
  if (fluxo.decisoes.length > 0) {
    const h = document.createElement('h3');
    h.style.cssText = 'margin: 14px 0 4px; font-size: 12px; text-transform: uppercase; color: var(--text-muted);';
    h.textContent = 'Decisões';
    corpo.appendChild(h);
    const ul = document.createElement('ul');
    ul.style.cssText = 'margin: 4px 0; padding-left: 18px; font-size: 12px;';
    fluxo.decisoes.forEach((d) => {
      const li = document.createElement('li');
      li.textContent = `${d.nome} → ${d.transicoes.length} saída(s)`;
      ul.appendChild(li);
    });
    corpo.appendChild(ul);
  }

  // Placeholder do BPMN drill-down (FLUX-10b)
  const ph = document.createElement('div');
  ph.style.cssText =
    'margin-top: 14px; padding: 14px; background: var(--bg-card); border: 1px dashed var(--border-strong); border-radius: 6px; text-align: center; color: var(--text-muted); font-size: 12.5px;';
  ph.innerHTML =
    'Diagrama BPMN limpo (bpmn-js) chega no <strong>FLUX-10b</strong>.<br><span class="small">Conversão jPDL → BPMN 2.0 + viewer inline.</span>';
  corpo.appendChild(ph);

  tec.appendChild(corpo);
  host.appendChild(tec);

  // Ações
  const acoes = document.createElement('div');
  acoes.className = 'fluxo-page__acoes';

  const acaoConsultor = document.createElement('a');
  acaoConsultor.className = 'fluxo-page__acao';
  acaoConsultor.href = chrome.runtime.getURL('fluxos-consultor/consultor.html');
  acaoConsultor.target = '_blank';
  acaoConsultor.rel = 'noopener';
  acaoConsultor.textContent = 'Perguntar ao Consultor de fluxos';
  acaoConsultor.addEventListener('click', () => {
    registrarTelemetria({
      tipo: 'consultor_aberto_da_estacao',
      lane: estado.lane,
      alvo: fluxo.codigo
    });
  });
  acoes.appendChild(acaoConsultor);

  const acaoCatalogo = document.createElement('button');
  acaoCatalogo.className = 'fluxo-page__acao fluxo-page__acao--ghost';
  acaoCatalogo.type = 'button';
  acaoCatalogo.textContent = 'Ver catálogo completo';
  acaoCatalogo.addEventListener('click', () => navegarPara({ lista: '1' }));
  acoes.appendChild(acaoCatalogo);

  host.appendChild(acoes);
}

function pillMeta(texto: string, cls = ''): HTMLElement {
  const p = document.createElement('span');
  p.className = `fluxo-page__meta-pill ${cls}`;
  p.textContent = texto;
  return p;
}

function renderBlocoVizinhos(titulo: string, vizinhos: { codigo: string; nome: string; chamadas: number }[]): HTMLElement {
  const bloco = document.createElement('div');
  bloco.className = 'fluxo-page__bloco';
  const h = document.createElement('h2');
  h.className = 'fluxo-page__bloco-titulo';
  h.textContent = titulo;
  bloco.appendChild(h);

  if (vizinhos.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.style.margin = '0';
    p.textContent = 'Nenhuma conexão registrada.';
    bloco.appendChild(p);
    return bloco;
  }

  vizinhos.forEach((v) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fluxo-page__vizinho';
    btn.innerHTML =
      `<span class="fluxo-page__vizinho-nome">${escapeHtml(v.nome || v.codigo)}</span>` +
      `<span class="fluxo-page__vizinho-contagem">${v.chamadas}×</span>`;
    btn.addEventListener('click', () => navegarPara({ fluxo: v.codigo }));
    bloco.appendChild(btn);
  });

  return bloco;
}

function renderAlertaCompleto(a: AlertaFluxo): HTMLElement {
  const div = document.createElement('div');
  div.className = `fluxo-page__alerta fluxo-page__alerta--${a.severidade}`;
  const ico = document.createElement('span');
  ico.className = 'fluxo-page__alerta-icone';
  ico.textContent = emojiAlerta(a.tipo);
  div.appendChild(ico);
  const txt = document.createElement('div');
  txt.className = 'fluxo-page__alerta-texto';
  txt.textContent = a.mensagem;
  if (a.detalhes && a.detalhes.length > 0) {
    const det = document.createElement('div');
    det.className = 'fluxo-page__alerta-detalhes';
    det.textContent = a.detalhes.join(', ');
    txt.appendChild(det);
  }
  div.appendChild(txt);
  return div;
}

function dlRow(rotulo: string, valor: string): DocumentFragment {
  const f = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = rotulo;
  const dd = document.createElement('dd');
  dd.textContent = valor;
  f.appendChild(dt);
  f.appendChild(dd);
  return f;
}

/* ───────────────────── Camada 4 — Catálogo de tarefas humanas ─────────
 * Pivot do produto (FLUX-17, decisão owner em 2026-05-07): a unidade
 * primária do catálogo são as TAREFAS HUMANAS que o servidor vê na
 * fila de trabalho do PJe — não os fluxos. Nomes de fluxo só voltam
 * em modo técnico. */

interface FiltrosCatalogo {
  busca: string;
  lane: string;
  swimlane: string;
}

const filtros: FiltrosCatalogo = {
  busca: '',
  lane: '',
  swimlane: ''
};

let _tarefasCarregadas: TarefaIndice[] | null = null;

async function renderizarCatalogo(): Promise<void> {
  const host = document.getElementById('catalogo-host');
  if (!host) return;
  host.innerHTML = '<div class="catalogo-vazio">Carregando tarefas…</div>';

  if (!_tarefasCarregadas) {
    _tarefasCarregadas = await getIndiceTarefas();
  }
  popularSelectsCatalogoUmaVez(_tarefasCarregadas);
  bindCatalogoFiltros();
  redesenharCatalogo();
}

let _selectsPopulados = false;
function popularSelectsCatalogoUmaVez(tarefas: TarefaIndice[]): void {
  if (_selectsPopulados) return;
  _selectsPopulados = true;

  const lanes = uniq(tarefas.map((t) => t.lane)).sort();
  const swimlanes = uniq(tarefas.map((t) => t.swimlane).filter(Boolean)).sort();

  const selLane = document.getElementById('catalogo-lane') as HTMLSelectElement | null;
  const selSwim = document.getElementById('catalogo-swimlane') as HTMLSelectElement | null;
  if (selLane) {
    lanes.forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l;
      opt.textContent = l;
      selLane.appendChild(opt);
    });
  }
  if (selSwim) {
    swimlanes.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      selSwim.appendChild(opt);
    });
  }
}

let _filtrosBindados = false;
function bindCatalogoFiltros(): void {
  if (_filtrosBindados) return;
  _filtrosBindados = true;
  const busca = document.getElementById('catalogo-busca') as HTMLInputElement | null;
  const lane = document.getElementById('catalogo-lane') as HTMLSelectElement | null;
  const swim = document.getElementById('catalogo-swimlane') as HTMLSelectElement | null;

  if (busca) busca.addEventListener('input', () => { filtros.busca = busca.value; redesenharCatalogo(); });
  if (lane) lane.addEventListener('change', () => { filtros.lane = lane.value; redesenharCatalogo(); });
  if (swim) swim.addEventListener('change', () => { filtros.swimlane = swim.value; redesenharCatalogo(); });
}

function redesenharCatalogo(): void {
  const host = document.getElementById('catalogo-host');
  const contagem = document.getElementById('catalogo-contagem');
  if (!host || !_tarefasCarregadas) return;

  const buscaNorm = filtros.busca.trim().toLowerCase();
  const lista = _tarefasCarregadas.filter((t) => {
    if (filtros.lane && t.lane !== filtros.lane) return false;
    if (filtros.swimlane && t.swimlane !== filtros.swimlane) return false;
    if (buscaNorm) {
      const blob = `${t.nome} ${t.swimlane} ${t.fluxoNome} ${t.fase}`.toLowerCase();
      if (!blob.includes(buscaNorm)) return false;
    }
    return true;
  });

  if (contagem) contagem.textContent = `${lista.length} de ${_tarefasCarregadas.length} tarefas`;

  if (lista.length === 0) {
    host.innerHTML = '<div class="catalogo-vazio">Nenhuma tarefa combina com os filtros atuais.</div>';
    return;
  }

  // Tabela: cabeçalhos extras só em modo técnico (etapa pai).
  const tbl = document.createElement('table');
  tbl.className = 'catalogo-tabela';
  tbl.innerHTML =
    '<thead><tr>' +
      '<th>Tarefa</th>' +
      '<th>Responsável</th>' +
      '<th>Lane</th>' +
      '<th class="tecnico-only">Etapa (fluxo pai)</th>' +
      '<th>Sinais</th>' +
    '</tr></thead>';
  const tbody = document.createElement('tbody');

  // Ordena alfabeticamente.
  lista
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .forEach((t) => {
      const tr = document.createElement('tr');
      tr.dataset.tarefa = t.id;
      const sinais = (t.alertasFluxoPai ?? [])
        .map((a) => `<span class="card-badge card-badge--${a.tipo}" title="${escapeHtml(a.mensagem)}">${emojiAlerta(a.tipo)} ${mapaAlertaLegivel(a.tipo)}</span>`)
        .join('');
      tr.innerHTML =
        `<td><strong>${escapeHtml(t.nome)}</strong></td>` +
        `<td>${escapeHtml(t.swimlane || '—')}</td>` +
        `<td>${escapeHtml(t.lane)}</td>` +
        `<td class="tecnico-only">${escapeHtml(t.fluxoNome)} <span class="muted small">(${escapeHtml(t.fluxoCodigo)})</span></td>` +
        `<td>${sinais}</td>`;
      tr.addEventListener('click', () => navegarPara({ tarefa: t.id }));
      tbody.appendChild(tr);
    });
  tbl.appendChild(tbody);

  host.innerHTML = '';
  host.appendChild(tbl);
}

/* ───────────────────── Ctrl+K palette ─────────────────────
 * Pivot do produto (FLUX-17, decisão owner em 2026-05-07): por padrão
 * busca TAREFAS HUMANAS. Em modo técnico, inclui também fluxos como
 * resultados. Cada item navega para `?tarefa=<id>` (ou `?fluxo=<cod>`
 * se for um fluxo do modo técnico). */

interface PaletteItem {
  tipo: 'tarefa' | 'fluxo';
  /** id (tarefa) ou código (fluxo). */
  ref: string;
  rotulo: string;
  contexto: string;
  lane: string;
}

let paletteSelecionado = 0;
let paletteResultados: PaletteItem[] = [];

function bindPalette(): void {
  const dialog = document.getElementById('palette') as HTMLDialogElement | null;
  const input = document.getElementById('palette-input') as HTMLInputElement | null;
  if (!dialog || !input) return;

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      abrirPalette();
    }
  });

  input.addEventListener('input', () => atualizarResultadosPalette(input.value));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); moverSelecaoPalette(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); moverSelecaoPalette(-1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); abrirSelecionado(); }
    else if (ev.key === 'Escape') { dialog.close(); }
  });

  dialog.addEventListener('click', (ev) => {
    // Clique fora do conteúdo (no backdrop) fecha.
    if (ev.target === dialog) dialog.close();
  });
}

function abrirPalette(): void {
  const dialog = document.getElementById('palette') as HTMLDialogElement | null;
  const input = document.getElementById('palette-input') as HTMLInputElement | null;
  if (!dialog || !input) return;
  if (!dialog.open) dialog.showModal();
  input.value = '';
  void atualizarResultadosPalette('');
  setTimeout(() => input.focus(), 0);
  registrarTelemetria({ tipo: 'palette_aberta', lane: estado.lane });
}

async function atualizarResultadosPalette(consulta: string): Promise<void> {
  const ul = document.getElementById('palette-results');
  if (!ul) return;

  // Modo padrão: busca TAREFAS HUMANAS (o que o usuário vê na fila).
  // Modo técnico: também inclui FLUXOS no fim da lista, identificados.
  if (!consulta.trim()) {
    // Lista inicial: tarefas com swimlane definido, ordenadas por nome.
    const tarefas = await getIndiceTarefas();
    paletteResultados = tarefas
      .filter((t) => t.swimlane)
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .slice(0, 12)
      .map<PaletteItem>((t) => ({
        tipo: 'tarefa',
        ref: t.id,
        rotulo: t.nome,
        contexto: t.swimlane || t.lane,
        lane: t.lane
      }));
  } else {
    registrarTelemetria({
      tipo: 'palette_busca',
      lane: estado.lane,
      buscaLen: consulta.trim().length
    });
    const tarefas = await buscarTarefas(consulta, estado.modoTecnico ? 8 : 12);
    paletteResultados = tarefas.map<PaletteItem>((t) => ({
      tipo: 'tarefa',
      ref: t.id,
      rotulo: t.nome,
      contexto: t.swimlane ? `${t.swimlane} · ${t.fase}` : t.fase,
      lane: t.lane
    }));
    if (estado.modoTecnico && estado.catalogo) {
      const fluxos = buscar(estado.catalogo, consulta, 6).map<PaletteItem>((r) => ({
        tipo: 'fluxo',
        ref: r.fluxo.codigo,
        rotulo: `Etapa: ${r.fluxo.nome}`,
        contexto: `${r.fluxo.lane} · ${r.fluxo.codigo}`,
        lane: r.fluxo.lane
      }));
      paletteResultados.push(...fluxos);
    }
  }
  paletteSelecionado = 0;

  if (paletteResultados.length === 0) {
    ul.innerHTML = '<li class="palette__vazio">Nada encontrado.</li>';
    return;
  }

  ul.innerHTML = paletteResultados
    .map(
      (r, i) =>
        `<li class="${i === 0 ? 'is-selected' : ''}" data-i="${i}" role="option">
          <strong>${escapeHtml(r.rotulo)}</strong>
          <span class="palette__lane lane-${r.lane.toLowerCase()}">${escapeHtml(r.lane)}</span>
          <small>${escapeHtml(r.contexto)}</small>
        </li>`
    )
    .join('');

  ul.querySelectorAll<HTMLLIElement>('li[data-i]').forEach((li) => {
    li.addEventListener('mouseenter', () => {
      paletteSelecionado = Number(li.dataset.i);
      atualizarSelecaoVisual();
    });
    li.addEventListener('click', () => abrirSelecionado());
  });
}

function moverSelecaoPalette(delta: number): void {
  if (paletteResultados.length === 0) return;
  paletteSelecionado = (paletteSelecionado + delta + paletteResultados.length) % paletteResultados.length;
  atualizarSelecaoVisual();
}

function atualizarSelecaoVisual(): void {
  const ul = document.getElementById('palette-results');
  if (!ul) return;
  ul.querySelectorAll<HTMLLIElement>('li[data-i]').forEach((li) => {
    const ativo = Number(li.dataset.i) === paletteSelecionado;
    li.classList.toggle('is-selected', ativo);
    if (ativo) li.scrollIntoView({ block: 'nearest' });
  });
}

function abrirSelecionado(): void {
  if (paletteResultados.length === 0) return;
  const escolhido = paletteResultados[paletteSelecionado];
  const dialog = document.getElementById('palette') as HTMLDialogElement | null;
  if (dialog?.open) dialog.close();
  if (escolhido.tipo === 'tarefa') {
    navegarPara({ tarefa: escolhido.ref });
  } else {
    navegarPara({ fluxo: escolhido.ref });
  }
}
