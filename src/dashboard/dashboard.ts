/**
 * Dashboard "Analisar tarefas" — página estática da extensão (chrome-extension://...).
 *
 * Recebe o payload via `chrome.storage.session` (chave `STORAGE_KEYS.TRIAGEM_DASHBOARD_PAYLOAD`),
 * renderiza métricas + listas com hyperlinks para cada processo, e oferece
 * um botão "Gerar insights com IA" que chama o background. A chamada à LLM
 * usa SOMENTE a versão anonimizada do payload (ver `triagem-anonymize.ts`).
 *
 * Por que página estática (e não data: URL)? Permite usar `chrome.storage`
 * e `chrome.runtime.sendMessage` sem expor dados sensíveis na URL — e
 * facilita F5 (recarregar lê do storage outra vez) e bookmarking visual.
 */

import { MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import { sanitizePayloadForLLM } from '../shared/triagem-anonymize';
import type {
  TriagemDashboardPayload,
  TriagemInsightsLLM,
  TriagemProcesso,
  TriagemSugestao
} from '../shared/types';

interface AggSubject {
  assunto: string;
  count: number;
  procs: TriagemProcesso[];
}

void main();

async function main(): Promise<void> {
  const main = document.getElementById('main') as HTMLElement;
  const meta = document.getElementById('meta') as HTMLElement;
  try {
    const payload = await loadPayload();
    if (!payload) {
      main.innerHTML =
        '<p class="loading">Nenhum dado de triagem encontrado. ' +
        'Volte ao painel do PJe e clique em "Analisar tarefas" novamente.</p>';
      meta.textContent = '';
      return;
    }
    renderMeta(meta, payload);
    renderDashboard(main, payload);
  } catch (err) {
    console.error('[pAIdegua dashboard] falha ao montar:', err);
    main.innerHTML = `<p class="loading">Erro ao montar o dashboard: ${escapeHtml(
      err instanceof Error ? err.message : String(err)
    )}</p>`;
  }
}

async function loadPayload(): Promise<TriagemDashboardPayload | null> {
  const out = await chrome.storage.session.get(STORAGE_KEYS.TRIAGEM_DASHBOARD_PAYLOAD);
  const raw = out[STORAGE_KEYS.TRIAGEM_DASHBOARD_PAYLOAD];
  if (!raw) return null;
  return raw as TriagemDashboardPayload;
}

function renderMeta(meta: HTMLElement, payload: TriagemDashboardPayload): void {
  const dt = new Date(payload.geradoEm);
  const dataFmt = dt.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  const unidade = extractUnidadeJudicial(payload);
  meta.innerHTML =
    `<div><strong>${escapeHtml(unidade)}</strong></div>` +
    `<div>${escapeHtml(dataFmt)}</div>` +
    `<div>${payload.tarefas.length} tarefa(s) &middot; ${payload.totalProcessos} processo(s)</div>`;
}

/**
 * Deduz a unidade judicial a partir do campo `orgao` do primeiro processo
 * com o campo preenchido. O texto bruto no PJe TRF5 vem como
 * "/ 35ª Vara Federal CE / Juiz Federal Titular" — segmentos separados
 * por "/". Queremos apenas o segmento da vara (descartando cargo do
 * magistrado, competência etc.). Fallback: hostname.
 */
function extractUnidadeJudicial(payload: TriagemDashboardPayload): string {
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

function renderDashboard(root: HTMLElement, payload: TriagemDashboardPayload): void {
  root.innerHTML = '';

  const todos = payload.tarefas.flatMap((t) => t.processos);

  root.appendChild(buildMetrics(todos));

  // Linha 1: 10 mais antigos | distribuição por faixa
  const grid1 = el('section', 'grid-2');
  grid1.appendChild(buildMaisAntigos(todos));
  grid1.appendChild(buildFaixas(todos));
  root.appendChild(grid1);

  // Linha 2: assuntos | etiquetas
  const grid2 = el('section', 'grid-2');
  grid2.appendChild(buildAssuntos(todos));
  grid2.appendChild(buildEtiquetas(todos));
  root.appendChild(grid2);

  // Prioritários
  if (todos.some((p) => p.prioritario)) {
    root.appendChild(buildPrioritarios(todos));
  }

  // Sigilosos (apenas se houver)
  if (todos.some((p) => p.sigiloso)) {
    root.appendChild(buildSigilosos(todos));
  }

  // Avisos de truncamento por tarefa
  const truncadas = payload.tarefas.filter((t) => t.truncado);
  if (truncadas.length > 0) {
    const sec = section('Atenção: leitura limitada à primeira página');
    const ul = document.createElement('ul');
    ul.style.margin = '0';
    ul.style.paddingLeft = '18px';
    truncadas.forEach((t) => {
      const li = document.createElement('li');
      li.textContent = `${t.tarefaNome}: ${t.totalLido} processos lidos (existem mais páginas no PJe).`;
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    root.appendChild(sec);
  }

  // Diagnóstico de coleta — sempre visível, ajuda a entender por que cada
  // tarefa parou de paginar. Útil enquanto o parser está em estabilização.
  root.appendChild(buildDiagnostico(payload));

  // Insights — última seção (carrega sob demanda).
  root.appendChild(buildInsightsArea(payload));
}

// =====================================================================
// Métricas
// =====================================================================

function buildMetrics(procs: TriagemProcesso[]): HTMLElement {
  const wrap = el('section', 'metrics');

  const total = procs.length;
  const prio = procs.filter((p) => p.prioritario).length;
  const sig = procs.filter((p) => p.sigiloso).length;
  const diasArr = procs.map((p) => p.diasNaTarefa).filter((n): n is number => n !== null);
  const mediaDias = diasArr.length
    ? Math.round(diasArr.reduce((s, n) => s + n, 0) / diasArr.length)
    : 0;
  const max30 = procs.filter((p) => (p.diasNaTarefa ?? 0) > 30).length;

  wrap.append(
    metric('Total de processos', String(total)),
    metric('Prioritários', String(prio), pct(prio, total)),
    metric('Sigilosos', String(sig), pct(sig, total)),
    metric('Média de dias na tarefa', String(mediaDias)),
    metric('Mais de 30 dias', String(max30), pct(max30, total))
  );
  return wrap;
}

function metric(label: string, value: string, hint?: string): HTMLElement {
  const card = el('div', 'metric');
  card.appendChild(elText('div', 'metric__label', label));
  card.appendChild(elText('div', 'metric__value', value));
  if (hint) card.appendChild(elText('div', 'metric__hint', hint));
  return card;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0% do total';
  return `${Math.round((n / total) * 100)}% do total`;
}

// =====================================================================
// 10 mais antigos
// =====================================================================

function buildMaisAntigos(procs: TriagemProcesso[]): HTMLElement {
  const sec = section('10 processos mais antigos na tarefa');
  setHint(sec, 'Ordenados pelos dias decorridos desde a entrada na tarefa.');
  const ord = [...procs]
    .filter((p) => p.diasNaTarefa !== null)
    .sort((a, b) => (b.diasNaTarefa ?? 0) - (a.diasNaTarefa ?? 0))
    .slice(0, 10);

  if (ord.length === 0) {
    sec.appendChild(elText('p', 'section__hint', 'Sem datas de entrada disponíveis.'));
    return sec;
  }

  const table = document.createElement('table');
  table.className = 'proc-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Processo</th>
        <th>Assunto</th>
        <th>Polo passivo</th>
        <th style="text-align:right">Dias</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody') as HTMLElement;
  for (const p of ord) {
    const tr = document.createElement('tr');
    tr.appendChild(tdProcNum(p));
    tr.appendChild(tdText(p.assunto));
    tr.appendChild(tdText(p.poloPassivo));
    tr.appendChild(tdDias(p.diasNaTarefa));
    tbody.appendChild(tr);
  }
  sec.appendChild(wrapScroll(table));
  attachCopyButton(sec, () => procsToText(ord), 'Copiar lista de processos');
  return sec;
}

// =====================================================================
// Distribuição por faixa de dias
// =====================================================================

function buildFaixas(procs: TriagemProcesso[]): HTMLElement {
  const sec = section('Distribuição por tempo na tarefa');
  setHint(sec, 'Quantos processos estão em cada faixa de dias decorridos.');

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
    row.appendChild(elText('div', 'faixas__label', b.label));
    const track = el('div', 'faixas__track');
    const fill = el('div', `faixas__fill${b.alerta ? ' faixas__fill--alerta' : ''}`);
    fill.style.width = `${(counts[i] / max) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(elText('div', 'faixas__count', String(counts[i])));
    wrap.appendChild(row);
  });
  sec.appendChild(wrapScroll(wrap));
  return sec;
}

// =====================================================================
// Assuntos (top + grupos expansíveis com links)
// =====================================================================

function buildAssuntos(procs: TriagemProcesso[]): HTMLElement {
  const sec = section('Agrupamento por assunto');
  setHint(sec, 'Clique em um assunto para ver os processos correspondentes.');

  const map = new Map<string, AggSubject>();
  for (const p of procs) {
    const key = p.assunto || '(sem assunto)';
    let curr = map.get(key);
    if (!curr) {
      curr = { assunto: key, count: 0, procs: [] };
      map.set(key, curr);
    }
    curr.count += 1;
    curr.procs.push(p);
  }
  const ord = Array.from(map.values()).sort((a, b) => b.count - a.count);
  const max = ord[0]?.count ?? 1;

  const list = el('div', 'group-list');
  for (const grp of ord) {
    list.appendChild(buildGroupItem(grp.assunto, grp.count, max, grp.procs));
  }
  sec.appendChild(wrapScroll(list));
  const todosProcs = ord.flatMap((g) => g.procs);
  attachCopyButton(
    sec,
    () => procsToText(todosProcs),
    'Copiar lista de processos'
  );
  return sec;
}

function buildGroupItem(
  label: string,
  count: number,
  max: number,
  procs: TriagemProcesso[]
): HTMLElement {
  const det = document.createElement('details');
  det.className = 'group-item';

  const sum = document.createElement('summary');
  const left = document.createElement('span');
  left.style.position = 'relative';
  left.style.flex = '1';
  left.style.padding = '4px 8px';
  left.style.borderRadius = 'var(--radius-sm)';
  left.style.background = `linear-gradient(90deg, rgba(19,81,180,0.12) ${(count / max) * 100}%, transparent ${(count / max) * 100}%)`;
  left.textContent = label;
  sum.appendChild(left);
  const badge = elText('span', 'group-item__count', String(count));
  sum.appendChild(badge);
  det.appendChild(sum);

  const ul = document.createElement('ul');
  for (const p of procs) {
    const li = document.createElement('li');
    li.appendChild(procNumberSpan(p));
    const meta = document.createElement('span');
    meta.style.color = 'var(--muted)';
    meta.style.fontSize = '11px';
    const days = p.diasNaTarefa !== null ? `${p.diasNaTarefa}d` : '—';
    meta.textContent = `${days} · ${p.poloPassivo}`;
    li.appendChild(meta);
    ul.appendChild(li);
  }
  det.appendChild(ul);
  return det;
}

// =====================================================================
// Etiquetas
// =====================================================================

function buildEtiquetas(procs: TriagemProcesso[]): HTMLElement {
  const sec = section('Etiquetas já aplicadas');
  setHint(sec, 'Distribuição das etiquetas presentes nos processos.');

  const map = new Map<string, number>();
  for (const p of procs) {
    for (const tag of p.etiquetas) {
      map.set(tag, (map.get(tag) ?? 0) + 1);
    }
  }
  if (map.size === 0) {
    sec.appendChild(elText('p', 'section__hint', 'Nenhuma etiqueta encontrada nos processos.'));
    return sec;
  }
  const ord = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  const max = ord[0][1];

  const list = el('div', 'barlist');
  for (const [tag, count] of ord) {
    const row = el('div', 'barlist__row');
    const lab = el('div', 'barlist__label');
    const bar = el('div', 'barlist__bar');
    bar.style.width = `${(count / max) * 100}%`;
    bar.style.right = 'auto';
    lab.appendChild(bar);
    lab.appendChild(document.createTextNode(tag));
    row.appendChild(lab);
    row.appendChild(elText('div', 'barlist__count', String(count)));
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
  sec.appendChild(buildProcLista(lista));
  attachCopyButton(sec, () => procsToText(lista), 'Copiar lista de processos');
  return sec;
}

function buildSigilosos(procs: TriagemProcesso[]): HTMLElement {
  const sec = section('Processos sigilosos');
  setHint(sec, 'Sigilo declarado nos cartões — atenção redobrada na manipulação.');
  const lista = procs.filter((p) => p.sigiloso);
  sec.appendChild(buildProcLista(lista));
  attachCopyButton(sec, () => procsToText(lista), 'Copiar lista de processos');
  return sec;
}

function buildProcLista(procs: TriagemProcesso[]): HTMLElement {
  if (procs.length === 0) {
    return elText('p', 'section__hint', 'Nenhum processo nessa categoria.');
  }
  const table = document.createElement('table');
  table.className = 'proc-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Processo</th>
        <th>Assunto</th>
        <th>Polo passivo</th>
        <th style="text-align:right">Dias</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody') as HTMLElement;
  for (const p of procs) {
    const tr = document.createElement('tr');
    tr.appendChild(tdProcNum(p));
    tr.appendChild(tdText(p.assunto));
    tr.appendChild(tdText(p.poloPassivo));
    tr.appendChild(tdDias(p.diasNaTarefa));
    tbody.appendChild(tr);
  }
  return wrapScroll(table);
}

// =====================================================================
// Insights LLM
// =====================================================================

function buildInsightsArea(payload: TriagemDashboardPayload): HTMLElement {
  const wrap = el('section', 'insights');
  const head = el('div', 'insights__head');

  const titleWrap = el('div', 'insights__title');
  titleWrap.appendChild(elText('span', 'insights__llm-badge', 'IA'));
  titleWrap.appendChild(elText('h2', '', 'Insights e sugestões geradas pela LLM'));
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
    'O número CNJ é enviado à IA (informação pública, importante para referenciar os autos nas sugestões). O polo ativo é substituído por "[POLO ATIVO]", o polo passivo só permanece se for ente público (INSS, União etc.) e CPF/CNPJ/telefone/email no texto das movimentações também são anonimizados. Datas, etiquetas, prioridade e assunto são mantidos para análise estatística.';
  wrap.appendChild(notice);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Gerando insights...';
    body.innerHTML = '<p class="loading" style="padding:16px 0">Aguardando resposta do modelo...</p>';
    try {
      const anon = sanitizePayloadForLLM(payload);
      const resp = await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.TRIAGEM_INSIGHTS,
        payload: anon
      });
      if (!resp?.ok) {
        throw new Error(resp?.error || 'Falha desconhecida.');
      }
      const insights = resp.insights as TriagemInsightsLLM;
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

function renderInsights(body: HTMLElement, insights: TriagemInsightsLLM): void {
  body.innerHTML = '';
  if (insights.panorama) {
    const p = elText('p', 'insights__panorama', insights.panorama);
    body.appendChild(p);
  }
  if (insights.sugestoes && insights.sugestoes.length > 0) {
    const wrap = el('div', 'insights__sugestoes');
    for (const s of insights.sugestoes) {
      wrap.appendChild(buildSugestao(s));
    }
    body.appendChild(wrap);
  }
}

function buildSugestao(s: TriagemSugestao): HTMLElement {
  const card = el('div', 'sugestao');
  const prio = elText('span', `sugestao__prio sugestao__prio--${s.prioridade}`, s.prioridade);
  card.appendChild(prio);
  const right = document.createElement('div');
  right.appendChild(elText('h3', '', s.titulo));
  right.appendChild(elText('p', '', s.detalhe));
  card.appendChild(right);
  return card;
}

// =====================================================================
// Helpers
// =====================================================================

function el(tag: string, className = ''): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

/**
 * Envolve um elemento numa caixa com altura máxima ~10 linhas e scroll
 * vertical. O CSS `.scroll-limit` faz o `thead` das tabelas ficar sticky
 * para que o cabeçalho permaneça visível durante a rolagem.
 */
function wrapScroll(inner: HTMLElement): HTMLElement {
  const box = el('div', 'scroll-limit');
  box.appendChild(inner);
  return box;
}

function elText(tag: string, className: string, text: string): HTMLElement {
  const e = el(tag, className);
  e.textContent = text;
  return e;
}

function buildDiagnostico(payload: TriagemDashboardPayload): HTMLElement {
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
    '<th style="text-align:right">Páginas</th>' +
    '</tr></thead>';
  const tbody = document.createElement('tbody');
  for (const t of payload.tarefas) {
    const tr = document.createElement('tr');
    tr.appendChild(tdText(t.tarefaNome));
    const tdLido = tdText(String(t.totalLido));
    tdLido.style.textAlign = 'right';
    tr.appendChild(tdLido);
    const tdPag = tdText(String(t.paginasLidas ?? '—'));
    tdPag.style.textAlign = 'right';
    tr.appendChild(tdPag);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  sec.appendChild(wrapScroll(table));
  return sec;
}

function section(title: string): HTMLElement {
  const sec = el('section', 'section');
  sec.appendChild(elText('h2', '', title));
  return sec;
}

function setHint(sec: HTMLElement, hint: string): void {
  sec.appendChild(elText('p', 'section__hint', hint));
}

function tdText(text: string): HTMLElement {
  const td = document.createElement('td');
  td.textContent = text;
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
 * Padrão aplicado em todos os relatórios pAIdegua.
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

  return wrap;
}

/**
 * Extrai apenas o número CNJ (formato NNNNNNN-DD.YYYY.J.TR.OOOO) do
 * texto recebido do PJe, que costuma vir prefixado pela classe
 * processual (ex.: "PJEC 0003020-32.2026.4.05.8109"). Retorna o número
 * original caso o padrão não seja encontrado.
 */
function extractCNJ(raw: string): string {
  if (!raw) return raw;
  const m = raw.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  return m ? m[0] : raw.trim();
}

/**
 * Copia `text` para a área de transferência e mostra um toast com `msgOk`.
 * Em caso de falha, mostra um toast de erro.
 */
async function copyToClipboard(text: string, msgOk: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msgOk);
  } catch (err) {
    console.error('[pAIdegua dashboard] falha ao copiar:', err);
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
  // Reflow para reativar a animação de entrada se já estava visível.
  toastEl.classList.remove('toast--visible');
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  void toastEl.offsetWidth;
  toastEl.classList.add('toast--visible');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl?.classList.remove('toast--visible');
  }, 1800);
}

/** Concatena os números dos processos em uma coluna (um por linha). */
function procsToText(procs: TriagemProcesso[]): string {
  return procs
    .map((p) => extractCNJ(p.numeroProcesso))
    .filter((n) => n && n.trim())
    .join('\n');
}

/** Ícone de copiar (16x16, currentColor para herdar a cor do botão). */
const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';

/**
 * Adiciona um botão "copiar" no canto superior direito da seção. Ao
 * clicar, chama `getText()` no momento do clique (lazy — permite que a
 * lista mude entre render e clique) e copia o resultado.
 */
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
  const span = elText('span', cls, String(d));
  td.appendChild(span);
  return td;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
