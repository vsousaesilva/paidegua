/**
 * Dashboard "Prazos na Fita pAIdegua" — aba dedicada do perfil Gestão.
 *
 * Lê o payload gravado pelo background em `storage.session` e renderiza:
 *   - KPIs do resumo (processos, abertos, prazo_correndo, próx. 7 dias).
 *   - Um card/tabela por tarefa selecionada, com cabeçalhos clicáveis para
 *     ordenação (asc/desc). Default: `Data limite` asc (null ao final).
 *     Cada lista exibe até ~10 linhas e os demais ficam acessíveis por
 *     rolagem vertical.
 *   - Blocos colapsáveis com processos sem expedientes abertos e com
 *     falhas de coleta.
 *
 * Sem LLM, sem filtros, sem export — iterações futuras tratam disso.
 */

import { LOG_PREFIX, STORAGE_KEYS } from '../shared/constants';
import type {
  PrazosFitaDashboardPayload,
  ProcessoExpediente,
  StatusPrazo
} from '../shared/types';

interface LinhaExpediente {
  tarefaNome: string;
  numeroProcesso: string;
  url: string | null;
  exp: ProcessoExpediente;
  diasRestantes: number | null;
}

type ColKey =
  | 'processo' | 'tarefa' | 'ato' | 'ciencia'
  | 'dataLimite' | 'dias' | 'natureza' | 'status' | 'anomalias';

type SortDir = 'asc' | 'desc';
interface SortState { key: ColKey; dir: SortDir; }

interface Coluna {
  key: ColKey;
  label: string;
  value: (l: LinhaExpediente) => string | number | null;
}

const COLUNAS: Coluna[] = [
  { key: 'processo',   label: 'Processo',             value: (l) => extractCNJ(l.numeroProcesso || '') || l.numeroProcesso || null },
  { key: 'tarefa',     label: 'Tarefa',               value: (l) => l.tarefaNome },
  { key: 'ato',        label: 'Ato / Destinatário',   value: (l) => `${l.exp.tipoAto} ${l.exp.destinatario}`.trim() },
  { key: 'ciencia',    label: 'Ciência',              value: (l) => cienciaSortKey(l.exp) },
  { key: 'dataLimite', label: 'Data limite',          value: (l) => parseDataLimite(l.exp.dataLimite) },
  { key: 'dias',       label: 'Dias',                 value: (l) => l.diasRestantes },
  { key: 'natureza',   label: 'Natureza',             value: (l) => l.exp.naturezaPrazoLiteral ?? null },
  { key: 'status',     label: 'Status',               value: (l) => l.exp.status },
  { key: 'anomalias',  label: 'Anomalias',            value: (l) => l.exp.anomalias.length }
];

const linhasPorTarefa = new Map<string, LinhaExpediente[]>();
const sortStates = new Map<string, SortState>();

void main();

async function main(): Promise<void> {
  const root = document.getElementById('main') as HTMLElement;
  const meta = document.getElementById('meta') as HTMLElement;
  instalarCopyDelegation();
  instalarSortDelegation();
  try {
    const payload = await loadPayload();
    if (!payload) {
      root.innerHTML =
        '<p class="loading">Nenhum dado encontrado. Volte ao Painel do Usuário do PJe e clique em "Prazos na Fita pAIdegua".</p>';
      meta.textContent = '';
      return;
    }
    renderMeta(meta, payload);
    renderDashboard(root, payload);
  } catch (err) {
    console.error(`${LOG_PREFIX} prazos-fita-dashboard falhou:`, err);
    root.innerHTML =
      '<p class="loading">Erro ao montar o painel: ' +
      escapeHtml(err instanceof Error ? err.message : String(err)) +
      '</p>';
  }
}

async function loadPayload(): Promise<PrazosFitaDashboardPayload | null> {
  const out = await chrome.storage.session.get(
    STORAGE_KEYS.PRAZOS_FITA_DASHBOARD_PAYLOAD
  );
  const raw = out[STORAGE_KEYS.PRAZOS_FITA_DASHBOARD_PAYLOAD];
  if (!raw) return null;
  return raw as PrazosFitaDashboardPayload;
}

function renderMeta(meta: HTMLElement, payload: PrazosFitaDashboardPayload): void {
  const dt = new Date(payload.geradoEm);
  const dataFmt = dt.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const unidade = extrairUnidade(payload);
  const totalTarefas = payload.tarefasSelecionadas.length;
  const totalProc = payload.resultado.consolidado.length;
  meta.innerHTML =
    `<div><strong>${escapeHtml(unidade)}</strong></div>` +
    `<div>${escapeHtml(dataFmt)}</div>` +
    `<div>${totalTarefas} tarefa(s) &middot; ${totalProc} processo(s)</div>`;
}

function extrairUnidade(payload: PrazosFitaDashboardPayload): string {
  for (const c of payload.resultado.consolidado) {
    const og = c.processoApi.orgaoJulgador;
    if (og && og.trim()) return og.trim();
  }
  return payload.hostnamePJe;
}

function renderDashboard(
  root: HTMLElement,
  payload: PrazosFitaDashboardPayload
): void {
  const linhas = construirLinhasExpediente(payload);
  const ordenadas = ordenarPorDataLimite(linhas);

  const comAbertos = payload.resultado.consolidado.filter(
    (c) => (c.coleta?.extracao?.abertos ?? []).length > 0
  );
  const semAbertos = payload.resultado.consolidado.filter(
    (c) => c.coleta?.ok === true && (c.coleta?.extracao?.abertos ?? []).length === 0
  );
  const falhas = payload.resultado.consolidado.filter(
    (c) => !c.coleta || c.coleta.ok === false
  );

  const totalAbertos = ordenadas.length;
  const correndo = ordenadas.filter((l) => l.exp.status === 'prazo_correndo').length;
  const proximos7 = ordenadas.filter(
    (l) => l.diasRestantes !== null && l.diasRestantes >= 0 && l.diasRestantes <= 7
  ).length;
  const vencidos = ordenadas.filter(
    (l) => l.diasRestantes !== null && l.diasRestantes < 0
  ).length;
  const anomalias = ordenadas.filter((l) => l.exp.anomalias.length > 0).length;

  root.innerHTML = '';

  root.appendChild(
    section(
      'div',
      'resumo',
      kpi('Processos', String(payload.resultado.consolidado.length), `${comAbertos.length} com expedientes abertos`) +
      kpi('Expedientes abertos', String(totalAbertos), '') +
      kpi('Prazo correndo', String(correndo), '', 'success') +
      kpi('Próximos 7 dias', String(proximos7), '', 'warning') +
      kpi('Vencidos (aberto)', String(vencidos), 'possível Quartz', vencidos > 0 ? 'danger' : undefined) +
      kpi('Com anomalia', String(anomalias), '', anomalias > 0 ? 'warning' : undefined)
    )
  );

  if (ordenadas.length > 0) {
    root.appendChild(renderGruposPorTarefa(ordenadas));
  } else {
    root.appendChild(
      section('div', 'card', '<div class="empty-state">Nenhum expediente aberto nas tarefas selecionadas.</div>')
    );
  }

  if (semAbertos.length > 0) {
    root.appendChild(renderColapsivel(
      `Processos sem expedientes abertos (${semAbertos.length})`,
      renderListaSemAbertos(semAbertos)
    ));
  }

  if (falhas.length > 0) {
    root.appendChild(renderColapsivel(
      `Processos com falha na coleta (${falhas.length})`,
      renderListaFalhas(falhas)
    ));
  }
}

function construirLinhasExpediente(
  payload: PrazosFitaDashboardPayload
): LinhaExpediente[] {
  const out: LinhaExpediente[] = [];
  for (const c of payload.resultado.consolidado) {
    const abertos = c.coleta?.extracao?.abertos ?? [];
    const numero = c.coleta?.numeroProcesso ?? c.processoApi.numeroProcesso ?? '';
    for (const exp of abertos) {
      out.push({
        tarefaNome: c.tarefaNome,
        numeroProcesso: numero,
        url: c.url,
        exp,
        diasRestantes: calcularDiasRestantes(exp.dataLimite)
      });
    }
  }
  return out;
}

function ordenarPorDataLimite(linhas: LinhaExpediente[]): LinhaExpediente[] {
  return [...linhas].sort((a, b) => {
    const da = parseDataLimite(a.exp.dataLimite);
    const db = parseDataLimite(b.exp.dataLimite);
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
}

function parseDataLimite(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, dd, mm, aaaa, hh = '23', mi = '59', ss = '59'] = m;
  const dt = new Date(
    Number(aaaa), Number(mm) - 1, Number(dd),
    Number(hh), Number(mi), Number(ss)
  );
  const t = dt.getTime();
  return Number.isFinite(t) ? t : null;
}

function calcularDiasRestantes(dataLimite: string | null): number | null {
  const ts = parseDataLimite(dataLimite);
  if (ts === null) return null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const diff = ts - hoje.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function renderGruposPorTarefa(linhas: LinhaExpediente[]): HTMLElement {
  const container = document.createElement('div');
  container.className = 'grupos';
  linhasPorTarefa.clear();
  const grupos = agruparPorTarefa(linhas);
  for (const [tarefa, arr] of grupos) {
    linhasPorTarefa.set(tarefa, arr);
    if (!sortStates.has(tarefa)) {
      sortStates.set(tarefa, { key: 'dataLimite', dir: 'asc' });
    }
    container.appendChild(renderCardTarefa(tarefa));
  }
  return container;
}

function agruparPorTarefa(
  linhas: LinhaExpediente[]
): Map<string, LinhaExpediente[]> {
  const mapa = new Map<string, LinhaExpediente[]>();
  for (const l of linhas) {
    const g = mapa.get(l.tarefaNome);
    if (g) g.push(l);
    else mapa.set(l.tarefaNome, [l]);
  }
  return mapa;
}

function renderCardTarefa(tarefa: string): HTMLElement {
  const card = document.createElement('section');
  card.className = 'card card-tarefa';
  card.dataset.tarefa = tarefa;
  card.innerHTML = renderCardTarefaInner(tarefa);
  return card;
}

function renderCardTarefaInner(tarefa: string): string {
  const linhas = linhasPorTarefa.get(tarefa) ?? [];
  const state = sortStates.get(tarefa) ?? { key: 'dataLimite', dir: 'asc' };
  const sorted = sortLinhas(linhas, state);
  const total = linhas.length;
  const wrapCls = total > 10 ? 'table-wrap table-wrap--scroll' : 'table-wrap';
  const sub = total > 10
    ? `${total} expediente(s) aberto(s) — role a lista para ver os demais. Clique no ícone do cabeçalho para ordenar.`
    : `${total} expediente(s) aberto(s). Clique no ícone do cabeçalho para ordenar.`;
  return (
    `<h2 class="card__title">${escapeHtml(tarefa)}</h2>` +
    `<p class="card__sub">${escapeHtml(sub)}</p>` +
    `<div class="${wrapCls}"><table><thead><tr>` +
    COLUNAS.map((c) => renderTh(c, state)).join('') +
    '</tr></thead><tbody>' +
    sorted.map(renderLinhaExpediente).join('') +
    '</tbody></table></div>'
  );
}

function renderTh(col: Coluna, state: SortState): string {
  const active = state.key === col.key;
  const dir = active ? state.dir : null;
  const cls = 'th-sort' + (active ? ' th-sort--active' : '');
  const aria = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  return (
    `<th class="${cls}" aria-sort="${aria}">` +
    '<span class="th-wrap">' +
    `<span class="th-label">${escapeHtml(col.label)}</span>` +
    `<button type="button" class="th-sort-btn" data-sort-key="${col.key}" ` +
    `title="Ordenar por ${escapeAttr(col.label)}" aria-label="Ordenar por ${escapeAttr(col.label)}">` +
    renderSortIcon(dir) +
    '</button>' +
    '</span></th>'
  );
}

function renderSortIcon(dir: SortDir | null): string {
  const upCls = dir === 'asc' ? 'sort-icon__arrow sort-icon__arrow--active' : 'sort-icon__arrow';
  const downCls = dir === 'desc' ? 'sort-icon__arrow sort-icon__arrow--active' : 'sort-icon__arrow';
  return (
    '<svg class="sort-icon" width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">' +
    `<polygon class="${upCls}" points="5,0 10,5 0,5"/>` +
    `<polygon class="${downCls}" points="5,12 10,7 0,7"/>` +
    '</svg>'
  );
}

function sortLinhas(linhas: LinhaExpediente[], state: SortState): LinhaExpediente[] {
  const col = COLUNAS.find((c) => c.key === state.key);
  if (!col) return linhas;
  const sign = state.dir === 'asc' ? 1 : -1;
  return [...linhas].sort((a, b) => {
    const va = normalizeSortValue(col.value(a));
    const vb = normalizeSortValue(col.value(b));
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb), 'pt-BR', { numeric: true, sensitivity: 'base' }) * sign;
  });
}

function normalizeSortValue(v: string | number | null): string | number | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = v.trim();
  return t === '' || t === '—' ? null : t;
}

function cienciaSortKey(e: ProcessoExpediente): string {
  if (!e.cienciaRegistrada) return '';
  if (e.cienciaAutor === 'servidor') return e.cienciaServidor ?? 'servidor';
  if (e.cienciaAutor === 'domicilio_eletronico') return 'Domicílio eletrônico';
  return 'Ficta (sistema)';
}

function instalarSortDelegation(): void {
  document.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest<HTMLElement>('.th-sort-btn');
    if (!btn) return;
    const card = btn.closest<HTMLElement>('.card-tarefa');
    if (!card) return;
    const tarefa = card.dataset.tarefa ?? '';
    const key = (btn.dataset.sortKey ?? '') as ColKey;
    if (!tarefa || !key) return;
    ev.preventDefault();
    ev.stopPropagation();
    const cur = sortStates.get(tarefa) ?? { key: 'dataLimite' as ColKey, dir: 'asc' as SortDir };
    const next: SortState = cur.key === key
      ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' };
    sortStates.set(tarefa, next);
    card.innerHTML = renderCardTarefaInner(tarefa);
  });
}

function renderLinhaExpediente(l: LinhaExpediente): string {
  const numero = l.numeroProcesso || '—';
  const processoCol = renderProcCell(numero, l.url);
  const ciencia = l.exp.cienciaRegistrada
    ? (l.exp.cienciaAutor === 'servidor'
        ? escapeHtml(l.exp.cienciaServidor ?? 'servidor')
        : l.exp.cienciaAutor === 'domicilio_eletronico'
          ? 'Domicílio eletrônico'
          : 'Ficta (sistema)')
    : 'Sem ciência';
  const cienciaData = l.exp.cienciaDataHora
    ? `<div class="col-tar">${escapeHtml(encurtarData(l.exp.cienciaDataHora))}</div>`
    : '';
  return (
    '<tr>' +
    `<td class="col-num">${processoCol}</td>` +
    `<td class="col-tar">${escapeHtml(l.tarefaNome)}</td>` +
    `<td><div>${escapeHtml(l.exp.tipoAto)}</div><div class="col-tar">${escapeHtml(l.exp.destinatario)}${l.exp.representante ? ' — ' + escapeHtml(l.exp.representante) : ''}</div></td>` +
    `<td><div>${ciencia}</div>${cienciaData}</td>` +
    `<td class="col-dia">${escapeHtml(encurtarData(l.exp.dataLimite ?? '—'))}</td>` +
    `<td class="col-dia">${renderDiasRestantes(l.diasRestantes)}</td>` +
    `<td class="col-tar">${escapeHtml(l.exp.naturezaPrazoLiteral ?? '—')}</td>` +
    `<td>${renderStatus(l.exp.status)}</td>` +
    `<td>${renderAnomalias(l.exp.anomalias)}</td>` +
    '</tr>'
  );
}

function renderDiasRestantes(d: number | null): string {
  if (d === null) return '—';
  if (d < 0) return `<span class="badge badge--danger">${d}</span>`;
  if (d <= 7) return `<span class="badge badge--warning">${d}</span>`;
  return `<span class="badge badge--ok">${d}</span>`;
}

function renderStatus(s: StatusPrazo): string {
  if (s === 'prazo_correndo') return '<span class="badge badge--ok">prazo correndo</span>';
  if (s === 'aguardando_ciencia') return '<span class="badge badge--warning">aguardando ciência</span>';
  if (s === 'sem_prazo') return '<span class="badge badge--muted">sem prazo</span>';
  return '<span class="badge badge--danger">indeterminado</span>';
}

const ROTULO_ANOMALIA: Record<string, string> = {
  prazo_vencido_aberto: 'Possível Quartz',
  ciencia_nao_convertida: 'Ciência vencida não encerrada',
  prazo_definido_sem_data_limite: 'Prazo sem data-limite',
  prazo_sem_prazo_com_data: 'Sem prazo + data inconsistente',
  todos_prazos_encerrados: 'Todos os prazos encerrados'
};

function rotularAnomalia(a: string): string {
  return ROTULO_ANOMALIA[a] ?? a;
}

function renderAnomalias(anoms: readonly string[]): string {
  if (anoms.length === 0) return '—';
  return anoms
    .map((a) => `<span class="badge badge--warning" title="${escapeAttr(a)}">${escapeHtml(rotularAnomalia(a))}</span>`)
    .join(' ');
}

function renderColapsivel(titulo: string, bodyHtml: string): HTMLElement {
  const d = document.createElement('details');
  d.className = 'card';
  d.innerHTML = `<summary>${escapeHtml(titulo)}<span class="col-tar">expandir/recolher</span></summary>${bodyHtml}`;
  return d;
}

function renderListaSemAbertos(
  itens: PrazosFitaDashboardPayload['resultado']['consolidado']
): string {
  const linhas = itens
    .map((c) => {
      const numero = c.coleta?.numeroProcesso ?? c.processoApi.numeroProcesso ?? '—';
      const fechados = c.coleta?.extracao?.fechados ?? 0;
      const anomList = c.coleta?.anomaliasProcesso ?? [];
      const anom = anomList.length === 0
        ? '—'
        : anomList.map((a) => `<span class="badge badge--warning" title="${escapeAttr(a)}">${escapeHtml(rotularAnomalia(a))}</span>`).join(' ');
      const link = renderProcCell(numero, c.url);
      return (
        '<tr>' +
        `<td class="col-num">${link}</td>` +
        `<td class="col-tar">${escapeHtml(c.tarefaNome)}</td>` +
        `<td class="col-dia">${fechados}</td>` +
        `<td>${anom}</td>` +
        '</tr>'
      );
    })
    .join('');
  return (
    '<div class="table-wrap"><table><thead><tr>' +
    '<th>Processo</th>' +
    '<th>Tarefa</th>' +
    '<th>Expedientes fechados</th>' +
    '<th>Anomalias de processo</th>' +
    '</tr></thead><tbody>' + linhas + '</tbody></table></div>'
  );
}

function renderListaFalhas(
  itens: PrazosFitaDashboardPayload['resultado']['consolidado']
): string {
  const linhas = itens
    .map((c) => {
      const numero = c.coleta?.numeroProcesso ?? c.processoApi.numeroProcesso ?? '—';
      const err = c.error ?? c.coleta?.error ?? 'erro desconhecido';
      return (
        '<tr>' +
        `<td class="col-num">${renderProcCell(numero, c.url)}</td>` +
        `<td class="col-tar">${escapeHtml(c.tarefaNome)}</td>` +
        `<td>${escapeHtml(err)}</td>` +
        '</tr>'
      );
    })
    .join('');
  return (
    '<div class="table-wrap"><table><thead><tr>' +
    '<th>Processo</th>' +
    '<th>Tarefa</th>' +
    '<th>Erro</th>' +
    '</tr></thead><tbody>' + linhas + '</tbody></table></div>'
  );
}

function section(tag: string, cls: string, innerHtml: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  el.innerHTML = innerHtml;
  return el;
}

function kpi(
  label: string,
  value: string,
  sub: string,
  kind?: 'danger' | 'warning' | 'success'
): string {
  const cls = kind ? ` kpi__value--${kind}` : '';
  return (
    '<div class="kpi">' +
    `<div class="kpi__label">${escapeHtml(label)}</div>` +
    `<div class="kpi__value${cls}">${escapeHtml(value)}</div>` +
    (sub ? `<div class="kpi__sub">${escapeHtml(sub)}</div>` : '') +
    '</div>'
  );
}

function encurtarData(s: string): string {
  const m = s.match(/^(\d{2}\/\d{2}\/\d{4})(?:\s+(\d{2}:\d{2}))?/);
  if (!m) return s;
  return m[2] ? `${m[1]} ${m[2]}` : m[1];
}

const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';

function extractCNJ(raw: string): string {
  if (!raw) return raw;
  const m = raw.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  return m ? m[0] : raw.trim();
}

function renderProcCell(numero: string, url: string | null): string {
  const cnj = extractCNJ(numero);
  const label = escapeHtml(numero || '—');
  const main = url
    ? `<a class="proc-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" title="Abrir processo em nova guia">${label}</a>`
    : `<span class="proc-link proc-link--disabled" title="URL do processo indisponível">${label}</span>`;
  const copyBtn =
    `<button type="button" class="proc-copy" data-cnj="${escapeAttr(cnj)}" ` +
    `title="Copiar número do processo" aria-label="Copiar número do processo ${escapeAttr(cnj)}">` +
    `${COPY_ICON_SVG}</button>`;
  return `<span class="proc-cell">${main}${copyBtn}</span>`;
}

function instalarCopyDelegation(): void {
  document.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest<HTMLElement>('.proc-copy');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const cnj = btn.dataset.cnj || '';
    if (!cnj) return;
    void navigator.clipboard
      .writeText(cnj)
      .then(() => showToast(`Número copiado: ${cnj}`))
      .catch(() => showToast('Não foi possível copiar para a área de transferência.'));
  });
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
