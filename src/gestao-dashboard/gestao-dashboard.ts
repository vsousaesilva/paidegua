/**
 * Painel Gerencial — página estática da extensão (perfil Gestão).
 *
 * Recebe o payload via `chrome.storage.session` na chave
 * `STORAGE_KEYS.GESTAO_DASHBOARD_PAYLOAD`, renderiza indicadores
 * determinísticos calculados no content script + listas por tarefa, e
 * oferece um botão para gerar insights via LLM. A chamada à LLM passa
 * pela mesma sanitização do dashboard de triagem
 * (`sanitizePayloadForLLM`) antes de cruzar o limite do navegador.
 *
 * Layout espelha o de "Analisar tarefas" (dashboard.ts) — mesmas
 * convenções de seção/cópia/scroll sticky — com um card extra "10
 * mais antigos por tarefa" destacado visualmente.
 */

import { MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import {
  abrirTarefaPopup,
  OPEN_TASK_ICON_SVG,
  podeAbrirTarefa
} from '../shared/pje-task-popup';
import { makeTableSortable, type TableSortColumn } from '../shared/table-sort';
import { sanitizePayloadForLLM } from '../shared/triagem-anonymize';
import type {
  GestaoAlerta,
  GestaoDashboardPayload,
  GestaoIndicadores,
  GestaoInsightsLLM,
  GestaoSugestao,
  TriagemDashboardPayload,
  TriagemProcesso,
  TriagemTarefaSnapshot
} from '../shared/types';

void main();

async function main(): Promise<void> {
  const root = document.getElementById('main') as HTMLElement;
  const meta = document.getElementById('meta') as HTMLElement;
  try {
    const payload = await loadPayload();
    if (!payload) {
      root.innerHTML =
        '<p class="loading">Nenhum dado encontrado. Volte ao Painel do Usuário do PJe e clique em "Painel Gerencial pAIdegua".</p>';
      meta.textContent = '';
      return;
    }
    renderMeta(meta, payload);
    renderDashboard(root, payload);
  } catch (err) {
    console.error('[pAIdegua gestao] falha ao montar:', err);
    root.innerHTML = `<p class="loading">Erro ao montar o painel: ${escapeHtml(
      err instanceof Error ? err.message : String(err)
    )}</p>`;
  }
}

async function loadPayload(): Promise<GestaoDashboardPayload | null> {
  const out = await chrome.storage.session.get(STORAGE_KEYS.GESTAO_DASHBOARD_PAYLOAD);
  const raw = out[STORAGE_KEYS.GESTAO_DASHBOARD_PAYLOAD];
  if (!raw) return null;
  return raw as GestaoDashboardPayload;
}

function renderMeta(meta: HTMLElement, payload: GestaoDashboardPayload): void {
  const dt = new Date(payload.geradoEm);
  const dataFmt = dt.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const unidade = extractUnidadeJudicial(payload);
  meta.innerHTML =
    `<div><strong>${escapeHtml(unidade)}</strong></div>` +
    `<div>${escapeHtml(dataFmt)}</div>` +
    `<div>${payload.tarefas.length} tarefa(s) &middot; ${payload.totalProcessos} processo(s)</div>`;
}

/**
 * Mesmo racional do dashboard de Triagem: tenta extrair "35ª Vara Federal CE"
 * do campo `orgao` do primeiro processo com o campo preenchido. Fallback
 * para o hostname.
 */
function extractUnidadeJudicial(payload: GestaoDashboardPayload): string {
  for (const t of payload.tarefas) {
    for (const p of t.processos) {
      const raw = (p.orgao || '').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      const segs = raw
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);
      const vara = segs.find((s) => /\bvara\b/i.test(s));
      if (vara) return vara;
      if (segs[0]) return segs[0];
    }
  }
  return payload.hostnamePJe;
}

function renderDashboard(root: HTMLElement, payload: GestaoDashboardPayload): void {
  root.innerHTML = '';

  const todos = payload.tarefas.flatMap((t) => t.processos);
  const ind = payload.indicadores;

  root.appendChild(buildMetricas(ind, payload.totalProcessos, todos));

  // Linha 1: 10 mais antigos (geral) | faixas de tempo
  const grid1 = el('section', 'grid-2');
  grid1.appendChild(buildMaisAntigos(todos));
  grid1.appendChild(buildFaixas(todos, ind.limiarAtrasoDias));
  root.appendChild(grid1);

  // Linha 2: distribuição por tarefa | top etiquetas
  const grid2 = el('section', 'grid-2');
  grid2.appendChild(buildDistribuicaoTarefas(ind));
  grid2.appendChild(buildTopEtiquetas(ind));
  root.appendChild(grid2);

  // Card NOVO com destaque: 10 mais antigos POR tarefa
  root.appendChild(buildMaisAntigosPorTarefa(payload.tarefas, ind.limiarAtrasoDias));

  // Prioritários / sigilosos (só aparecem quando existem)
  if (todos.some((p) => p.prioritario)) {
    root.appendChild(buildPrioritarios(todos));
  }
  if (todos.some((p) => p.sigiloso)) {
    root.appendChild(buildSigilosos(todos));
  }

  // Avisos de truncamento (leitura parou por limite de páginas)
  const truncadas = payload.tarefas.filter((t) => t.truncado);
  if (truncadas.length > 0) {
    root.appendChild(buildAvisoTruncamento(truncadas));
  }

  root.appendChild(buildDiagnostico(payload));
  root.appendChild(buildInsightsArea(payload));
}

// =====================================================================
// Métricas (topo)
// =====================================================================

function buildMetricas(
  ind: GestaoIndicadores,
  total: number,
  todos: TriagemProcesso[]
): HTMLElement {
  const wrap = el('section', 'metrics');

  const diasArr = todos
    .map((p) => p.diasNaTarefa)
    .filter((n): n is number => typeof n === 'number');
  const mediaDias = diasArr.length
    ? Math.round(diasArr.reduce((s, n) => s + n, 0) / diasArr.length)
    : 0;

  wrap.append(
    metric('Processos', String(total)),
    metric('Tarefas', String(ind ? Object.keys(ind.porTarefa).length : 0)),
    metric(
      `Atrasados (> ${ind.limiarAtrasoDias}d)`,
      String(ind.atrasados),
      ind.atrasados > 0 ? 'danger' : undefined,
      pct(ind.atrasados, total)
    ),
    metric(
      'Prioritários',
      String(ind.prioritarios),
      ind.prioritarios > 0 ? 'warning' : undefined,
      pct(ind.prioritarios, total)
    ),
    metric('Sigilosos', String(ind.sigilosos), undefined, pct(ind.sigilosos, total)),
    metric('Média de dias na tarefa', String(mediaDias))
  );
  return wrap;
}

function metric(
  label: string,
  value: string,
  variant?: 'danger' | 'warning',
  hint?: string
): HTMLElement {
  const cls = variant ? `metric metric--${variant}` : 'metric';
  const m = el('div', cls);
  m.appendChild(textEl('div', 'metric__label', label));
  m.appendChild(textEl('div', 'metric__value', value));
  if (hint) m.appendChild(textEl('div', 'metric__hint', hint));
  return m;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0% do total';
  return `${Math.round((n / total) * 100)}% do total`;
}

// =====================================================================
// 10 mais antigos (geral)
// =====================================================================

function buildMaisAntigos(procs: TriagemProcesso[]): HTMLElement {
  const sec = section('10 processos mais antigos (geral)');
  setHint(sec, 'Ordenados pelos dias decorridos desde a entrada na tarefa atual.');

  const ord = [...procs]
    .filter((p) => p.diasNaTarefa !== null)
    .sort((a, b) => (b.diasNaTarefa ?? 0) - (a.diasNaTarefa ?? 0))
    .slice(0, 10);

  if (ord.length === 0) {
    sec.appendChild(textEl('p', 'section__hint', 'Sem datas de entrada disponíveis.'));
    return sec;
  }

  sec.appendChild(wrapScroll(buildProcTable(ord)));
  attachCopyButton(sec, () => procsToText(ord), 'Copiar lista de processos');
  return sec;
}

// =====================================================================
// 10 mais antigos POR tarefa — card destacado
// =====================================================================

function buildMaisAntigosPorTarefa(
  tarefas: TriagemTarefaSnapshot[],
  limiar: number
): HTMLElement {
  const sec = el('section', 'section section--copy section--highlight');
  sec.appendChild(textEl('h2', '', '10 mais antigos por tarefa'));
  setHint(
    sec,
    'Para cada tarefa varrida, os 10 processos com mais tempo parado. ' +
      'Use para redistribuir carga e priorizar a vista imediata.'
  );

  const ordenadas = [...tarefas].sort((a, b) => {
    const maxA = Math.max(0, ...a.processos.map((p) => p.diasNaTarefa ?? 0));
    const maxB = Math.max(0, ...b.processos.map((p) => p.diasNaTarefa ?? 0));
    return maxB - maxA;
  });

  const todosListados: TriagemProcesso[] = [];

  const wrap = el('div', 'tarefa-cards');
  for (const t of ordenadas) {
    const ord = [...t.processos]
      .filter((p) => p.diasNaTarefa !== null)
      .sort((a, b) => (b.diasNaTarefa ?? 0) - (a.diasNaTarefa ?? 0))
      .slice(0, 10);
    todosListados.push(...ord);

    const card = el('div', 'tarefa-card');
    const head = el('div', 'tarefa-card__head');
    head.appendChild(textEl('h3', 'tarefa-card__title', t.tarefaNome));

    const metaTxt = document.createElement('div');
    metaTxt.className = 'tarefa-card__meta';
    const acima = ord.filter((p) => (p.diasNaTarefa ?? 0) >= limiar).length;
    metaTxt.innerHTML =
      `${t.totalLido} processo(s) na tarefa` +
      (acima > 0
        ? ` &middot; <strong>${acima} acima de ${limiar}d</strong>`
        : '');
    head.appendChild(metaTxt);
    card.appendChild(head);

    if (ord.length === 0) {
      card.appendChild(textEl('p', 'tarefa-card__empty', 'Sem datas de entrada disponíveis nesta tarefa.'));
    } else {
      card.appendChild(wrapScroll(buildProcTable(ord)));
    }
    wrap.appendChild(card);
  }

  sec.appendChild(wrap);
  attachCopyButton(
    sec,
    () => procsToText(todosListados),
    'Copiar lista consolidada dos mais antigos'
  );
  return sec;
}

// =====================================================================
// Distribuição por faixa de dias
// =====================================================================

function buildFaixas(procs: TriagemProcesso[], limiar: number): HTMLElement {
  const sec = section('Distribuição por tempo na tarefa');
  setHint(
    sec,
    `Faixas de dias decorridos. A partir de ${limiar} dias o processo é considerado atrasado.`
  );

  const buckets: Array<{ label: string; range: [number, number]; alerta: boolean }> = [
    { label: '0–15 dias', range: [0, 15], alerta: false },
    { label: '16–30 dias', range: [16, 30], alerta: false },
    { label: '31–60 dias', range: [31, 60], alerta: true },
    { label: '61–90 dias', range: [61, 90], alerta: true },
    { label: '> 90 dias', range: [91, Infinity], alerta: true }
  ];

  const counts = buckets.map(
    (b) =>
      procs.filter((p) => {
        const d = p.diasNaTarefa;
        return d !== null && d >= b.range[0] && d <= b.range[1];
      }).length
  );
  const max = Math.max(1, ...counts);

  const wrap = el('div', 'faixas');
  buckets.forEach((b, i) => {
    const row = el('div', 'faixas__row');
    row.appendChild(textEl('div', 'faixas__label', b.label));
    const track = el('div', 'faixas__track');
    const fill = el('div', `faixas__fill${b.alerta ? ' faixas__fill--alerta' : ''}`);
    fill.style.width = `${(counts[i] / max) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(textEl('div', 'faixas__count', String(counts[i])));
    wrap.appendChild(row);
  });
  sec.appendChild(wrapScroll(wrap));
  return sec;
}

// =====================================================================
// Distribuição por tarefa
// =====================================================================

function buildDistribuicaoTarefas(ind: GestaoIndicadores): HTMLElement {
  const sec = section('Distribuição por tarefa');
  setHint(sec, 'Quantos processos cada tarefa selecionada retornou.');
  const entries = Object.entries(ind.porTarefa).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    sec.appendChild(textEl('p', 'section__hint', 'Nenhuma tarefa com processos.'));
    return sec;
  }
  const max = entries[0][1] || 1;
  const list = el('div', 'barlist');
  for (const [nome, count] of entries) {
    const row = el('div', 'barlist__row');
    const lab = el('div', 'barlist__label');
    const bar = el('div', 'barlist__bar');
    bar.style.width = `${(count / max) * 100}%`;
    lab.appendChild(bar);
    lab.appendChild(document.createTextNode(nome));
    row.appendChild(lab);
    row.appendChild(textEl('div', 'barlist__count', String(count)));
    list.appendChild(row);
  }
  sec.appendChild(wrapScroll(list));
  return sec;
}

function buildTopEtiquetas(ind: GestaoIndicadores): HTMLElement {
  const sec = section('Etiquetas mais frequentes');
  setHint(sec, 'Top 5 etiquetas aplicadas nos processos varridos.');
  if (ind.topEtiquetas.length === 0) {
    sec.appendChild(textEl('p', 'section__hint', 'Nenhuma etiqueta aplicada.'));
    return sec;
  }
  const max = ind.topEtiquetas[0].total || 1;
  const list = el('div', 'barlist');
  for (const { etiqueta, total } of ind.topEtiquetas) {
    const row = el('div', 'barlist__row');
    const lab = el('div', 'barlist__label');
    const bar = el('div', 'barlist__bar');
    bar.style.width = `${(total / max) * 100}%`;
    lab.appendChild(bar);
    lab.appendChild(document.createTextNode(etiqueta));
    row.appendChild(lab);
    row.appendChild(textEl('div', 'barlist__count', String(total)));
    list.appendChild(row);
  }
  sec.appendChild(wrapScroll(list));
  return sec;
}

// =====================================================================
// Prioritários e sigilosos
// =====================================================================

function buildPrioritarios(procs: TriagemProcesso[]): HTMLElement {
  const sec = section('Processos prioritários');
  setHint(sec, 'Marcados pelo PJe com prioridade legal — devem ser tratados primeiro.');
  const lista = procs.filter((p) => p.prioritario);
  sec.appendChild(wrapScroll(buildProcTable(lista)));
  attachCopyButton(sec, () => procsToText(lista), 'Copiar lista de processos');
  return sec;
}

function buildSigilosos(procs: TriagemProcesso[]): HTMLElement {
  const sec = section('Processos sigilosos');
  setHint(sec, 'Sigilo declarado nos cartões — atenção redobrada na manipulação.');
  const lista = procs.filter((p) => p.sigiloso);
  sec.appendChild(wrapScroll(buildProcTable(lista)));
  attachCopyButton(sec, () => procsToText(lista), 'Copiar lista de processos');
  return sec;
}

// =====================================================================
// Avisos de truncamento
// =====================================================================

function buildAvisoTruncamento(truncadas: TriagemTarefaSnapshot[]): HTMLElement {
  const sec = section('Leitura limitada à primeira página');
  setHint(
    sec,
    'Tarefas que pararam de paginar por limite de segurança. O total exibido ' +
      'pode ser menor que o real; abra a tarefa no PJe para conferir.'
  );
  const ul = document.createElement('ul');
  ul.style.margin = '0';
  ul.style.paddingLeft = '18px';
  for (const t of truncadas) {
    const li = document.createElement('li');
    li.textContent = `${t.tarefaNome}: ${t.totalLido} processos lidos (existem mais páginas no PJe).`;
    ul.appendChild(li);
  }
  sec.appendChild(ul);
  return sec;
}

// =====================================================================
// Diagnóstico de coleta
// =====================================================================

function buildDiagnostico(payload: GestaoDashboardPayload): HTMLElement {
  const sec = section('Diagnóstico de coleta');
  setHint(
    sec,
    'Detalhes técnicos por tarefa para entender o resultado da varredura ' +
      '(útil quando o total parece menor do que o esperado).'
  );
  const table = document.createElement('table');
  table.className = 'tabela';
  table.innerHTML =
    '<thead><tr>' +
    '<th>Tarefa</th>' +
    '<th style="text-align:right">Lidos</th>' +
    '</tr></thead>';
  const tbody = document.createElement('tbody');
  for (const t of payload.tarefas) {
    const tr = document.createElement('tr');
    tr.appendChild(tdText(t.tarefaNome));
    const tdLido = tdText(String(t.totalLido));
    tdLido.style.textAlign = 'right';
    tr.appendChild(tdLido);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  makeTableSortable(table, payload.tarefas, [
    { type: 'alpha', value: (t) => t.tarefaNome || null },
    { type: 'num',   value: (t) => t.totalLido }
  ]);
  sec.appendChild(wrapScroll(table));
  return sec;
}

// =====================================================================
// Insights (LLM)
// =====================================================================

function buildInsightsArea(payload: GestaoDashboardPayload): HTMLElement {
  const wrap = el('section', 'insights');
  const head = el('div', 'insights__head');

  const titleWrap = el('div', 'insights__title');
  titleWrap.appendChild(textEl('span', 'insights__llm-badge', 'IA'));
  titleWrap.appendChild(textEl('h2', '', 'Leitura gerencial gerada pela LLM'));
  head.appendChild(titleWrap);

  const btn = document.createElement('button');
  btn.className = 'insights__btn';
  btn.type = 'button';
  btn.textContent = 'Gerar insights com IA';
  head.appendChild(btn);
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.id = 'insights-body';
  wrap.appendChild(body);

  const notice = document.createElement('p');
  notice.className = 'insights__notice';
  notice.textContent =
    'O número CNJ é enviado à IA (informação pública). O polo ativo é ' +
    'substituído por "[POLO ATIVO]"; o polo passivo só permanece se for ente ' +
    'público. CPF, CNPJ, telefone e e-mail em movimentações também são ' +
    'anonimizados. Datas, etiquetas, prioridade e assunto são mantidos para análise.';
  wrap.appendChild(notice);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Gerando insights...';
    body.innerHTML = '<p class="loading" style="padding:16px 0">Aguardando resposta do modelo...</p>';
    try {
      const triagemLike: TriagemDashboardPayload = {
        geradoEm: payload.geradoEm,
        hostnamePJe: payload.hostnamePJe,
        tarefas: payload.tarefas,
        totalProcessos: payload.totalProcessos,
        insightsLLM: null
      };
      const anon = sanitizePayloadForLLM(triagemLike);
      const resp = await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.GESTAO_INSIGHTS,
        payload: { indicadores: payload.indicadores, anon }
      });
      if (!resp?.ok) {
        throw new Error(resp?.error || 'Falha desconhecida ao chamar a IA.');
      }
      const insights = resp.insights as GestaoInsightsLLM;
      renderInsights(body, insights);
      btn.textContent = 'Regenerar insights';
      btn.disabled = false;
    } catch (err) {
      body.innerHTML = '';
      const errEl = document.createElement('p');
      errEl.className = 'insights__error';
      errEl.textContent = `Não foi possível gerar insights: ${
        err instanceof Error ? err.message : String(err)
      }`;
      body.appendChild(errEl);
      btn.textContent = 'Tentar novamente';
      btn.disabled = false;
    }
  });

  return wrap;
}

function renderInsights(body: HTMLElement, insights: GestaoInsightsLLM): void {
  body.innerHTML = '';
  if (insights.panorama) {
    body.appendChild(textEl('p', 'insights__panorama', insights.panorama));
  }
  if (insights.alertas && insights.alertas.length > 0) {
    body.appendChild(textEl('h3', 'insights__subtitle', 'Alertas'));
    const list = el('div', 'insights__list');
    for (const a of insights.alertas) list.appendChild(renderAlerta(a));
    body.appendChild(list);
  }
  if (insights.sugestoes && insights.sugestoes.length > 0) {
    body.appendChild(textEl('h3', 'insights__subtitle', 'Sugestões'));
    const list = el('div', 'insights__list');
    for (const s of insights.sugestoes) list.appendChild(renderSugestao(s));
    body.appendChild(list);
  }
}

function renderAlerta(a: GestaoAlerta): HTMLElement {
  const card = el('div', `insights__card insights__card--${a.severidade}`);
  const prio = textEl('span', `insights__prio insights__prio--${a.severidade}`, a.severidade);
  card.appendChild(prio);
  const right = document.createElement('div');
  right.appendChild(textEl('h3', '', a.titulo));
  right.appendChild(textEl('p', '', a.detalhe));
  card.appendChild(right);
  return card;
}

function renderSugestao(s: GestaoSugestao): HTMLElement {
  const card = el('div', `insights__card insights__card--${s.prioridade}`);
  const prio = textEl('span', `insights__prio insights__prio--${s.prioridade}`, s.prioridade);
  card.appendChild(prio);
  const right = document.createElement('div');
  right.appendChild(textEl('h3', '', s.titulo));
  right.appendChild(textEl('p', '', s.detalhe));
  card.appendChild(right);
  return card;
}

// =====================================================================
// Helpers — construção de tabela de processos
// =====================================================================

function buildProcTable(procs: TriagemProcesso[]): HTMLElement {
  const table = document.createElement('table');
  table.className = 'proc-table';
  table.innerHTML =
    '<thead><tr>' +
    '<th>Processo</th>' +
    '<th>Assunto</th>' +
    '<th>Polo passivo</th>' +
    '<th>Marcadores</th>' +
    '<th style="text-align:right">Dias</th>' +
    '</tr></thead><tbody></tbody>';
  const tbody = table.querySelector('tbody') as HTMLElement;
  for (const p of procs) {
    const tr = document.createElement('tr');
    tr.appendChild(tdProcNum(p));
    tr.appendChild(tdText(p.assunto));
    tr.appendChild(tdText(p.poloPassivo));
    tr.appendChild(tdMarcadores(p));
    tr.appendChild(tdDias(p.diasNaTarefa));
    tbody.appendChild(tr);
  }
  makeTableSortable(table, procs, procTableColumns());
  return table;
}

function procTableColumns(): TableSortColumn<TriagemProcesso>[] {
  return [
    { type: 'alpha', value: (p) => extractCNJ(p.numeroProcesso) || p.numeroProcesso || null },
    { type: 'alpha', value: (p) => p.assunto || null },
    { type: 'alpha', value: (p) => p.poloPassivo || null },
    { type: 'alpha', value: (p) => marcadoresSortKey(p) },
    { type: 'num',   value: (p) => p.diasNaTarefa }
  ];
}

function marcadoresSortKey(p: TriagemProcesso): string | null {
  const partes: string[] = [];
  if (p.prioritario) partes.push('prioritário');
  if (p.sigiloso) partes.push('sigiloso');
  for (const e of p.etiquetas) partes.push(e);
  return partes.length > 0 ? partes.join(' ') : null;
}

function tdMarcadores(p: TriagemProcesso): HTMLElement {
  const td = document.createElement('td');
  const wrap = el('div', 'badge-row');
  if (p.prioritario) {
    wrap.appendChild(textEl('span', 'badge badge--prioritario', 'Prioritário'));
  }
  if (p.sigiloso) {
    wrap.appendChild(textEl('span', 'badge badge--sigiloso', 'Sigiloso'));
  }
  for (const e of p.etiquetas) {
    wrap.appendChild(textEl('span', 'badge', e));
  }
  if (!p.prioritario && !p.sigiloso && p.etiquetas.length === 0) {
    td.textContent = '—';
  } else {
    td.appendChild(wrap);
  }
  return td;
}

function tdDias(d: number | null): HTMLElement {
  const td = document.createElement('td');
  td.style.textAlign = 'right';
  if (d === null) {
    td.textContent = '—';
    return td;
  }
  let cls = 'dias-badge';
  if (d > 60) cls += ' dias-badge--alerta';
  else if (d > 30) cls += ' dias-badge--atencao';
  const span = textEl('span', cls, String(d));
  td.appendChild(span);
  return td;
}

function tdText(text: string): HTMLElement {
  const td = document.createElement('td');
  td.textContent = text || '—';
  return td;
}

function tdProcNum(p: TriagemProcesso): HTMLElement {
  const td = document.createElement('td');
  td.className = 'num';
  td.appendChild(procNumberSpan(p));
  return td;
}

/**
 * Renderiza o número do processo como hiperlink (abre os autos em nova
 * aba) acompanhado de um pequeno botão com ícone para copiar o CNJ.
 * Mesmo padrão usado em todos os relatórios pAIdegua.
 */
function procNumberSpan(p: TriagemProcesso): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'proc-cell';
  const cnj = extractCNJ(p.numeroProcesso);
  const label = p.numeroProcesso || '(sem número)';

  let main: HTMLElement;
  if (p.url) {
    const a = document.createElement('a');
    a.className = 'proc-link';
    a.href = p.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'Abrir processo em nova guia';
    a.textContent = label;
    main = a;
  } else {
    const span = document.createElement('span');
    span.className = 'proc-link proc-link--disabled';
    span.textContent = label;
    span.title = 'URL do processo indisponível';
    main = span;
  }
  wrap.appendChild(main);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'proc-copy';
  btn.title = 'Copiar número do processo';
  btn.setAttribute('aria-label', `Copiar número do processo ${cnj}`);
  btn.innerHTML = COPY_ICON_SVG;
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void copyToClipboard(cnj, `Número copiado: ${cnj}`);
  });
  wrap.appendChild(btn);

  if (podeAbrirTarefa(p.idProcesso, p.idTaskInstance) && p.url) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'proc-open-task';
    openBtn.title = 'Abrir tarefa no PJe';
    openBtn.setAttribute('aria-label', `Abrir tarefa do processo ${cnj}`);
    openBtn.innerHTML = OPEN_TASK_ICON_SVG;
    openBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const ok = abrirTarefaPopup({
        idProcesso: p.idProcesso,
        idTaskInstance: p.idTaskInstance!,
        referenciaUrlAutos: p.url
      });
      if (!ok) showToast('Não foi possível abrir a tarefa (popup bloqueado?).');
    });
    wrap.appendChild(openBtn);
  }

  return wrap;
}

/**
 * Extrai apenas o número CNJ (formato NNNNNNN-DD.YYYY.J.TR.OOOO) do
 * texto do PJe, que vem prefixado pela classe processual (ex.:
 * "PJEC 0003020-32.2026.4.05.8109"). Retorna o número original caso o
 * padrão não seja encontrado.
 */
function extractCNJ(raw: string): string {
  if (!raw) return raw;
  const m = raw.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  return m ? m[0] : raw.trim();
}

// =====================================================================
// Helpers genéricos
// =====================================================================

function el(tag: string, className = ''): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function textEl(tag: string, className: string, text: string): HTMLElement {
  const e = el(tag, className);
  e.textContent = text;
  return e;
}

function section(title: string): HTMLElement {
  const sec = el('section', 'section');
  sec.appendChild(textEl('h2', '', title));
  return sec;
}

function setHint(sec: HTMLElement, hint: string): void {
  sec.appendChild(textEl('p', 'section__hint', hint));
}

function wrapScroll(inner: HTMLElement): HTMLElement {
  const box = el('div', 'scroll-limit');
  box.appendChild(inner);
  return box;
}

async function copyToClipboard(text: string, msgOk: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msgOk);
  } catch (err) {
    console.error('[pAIdegua gestao] falha ao copiar:', err);
    showToast('Não foi possível copiar para a área de transferência.');
  }
}

let toastTimer: number | null = null;
let toastEl: HTMLDivElement | null = null;

function showToast(msg: string): void {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.remove('toast--visible');
  void toastEl.offsetWidth;
  toastEl.classList.add('toast--visible');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl?.classList.remove('toast--visible');
  }, 1800);
}

function procsToText(procs: TriagemProcesso[]): string {
  return procs
    .map((p) => extractCNJ(p.numeroProcesso))
    .filter((n) => n && n.trim())
    .join('\n');
}

const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';

function attachCopyButton(
  sec: HTMLElement,
  getText: () => string,
  label: string
): void {
  sec.classList.add('section--copy');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = COPY_ICON_SVG;
  btn.addEventListener('click', () => {
    const text = getText();
    if (!text) {
      showToast('Lista vazia — nada para copiar.');
      return;
    }
    const linhas = text.split('\n').filter((l) => l).length;
    void copyToClipboard(text, `Copiado: ${linhas} processo(s).`);
  });
  sec.appendChild(btn);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
