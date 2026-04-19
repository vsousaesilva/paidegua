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

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import {
  abrirTarefaPopup,
  montarUrlTarefa,
  OPEN_TASK_ICON_SVG,
  podeAbrirTarefa
} from '../shared/pje-task-popup';
import { makeTableSortable } from '../shared/table-sort';
import type {
  PrazosFitaDashboardPayload,
  ProcessoExpediente,
  StatusPrazo
} from '../shared/types';

interface LinhaExpediente {
  tarefaNome: string;
  numeroProcesso: string;
  url: string | null;
  /** ID interno do processo no PJe (ou null quando indisponível). */
  idProcesso: string | null;
  /** ID da TaskInstance (`newTaskId` do PJe) ou null. */
  idTaskInstance: string | null;
  exp: ProcessoExpediente;
  diasRestantes: number | null;
}

type ColKey =
  | 'processo' | 'tarefa' | 'ato' | 'ciencia'
  | 'dataLimite' | 'dias' | 'natureza' | 'status' | 'anomalias'
  | 'encerrar';

/**
 * Estados do botão "encerrar expedientes" por tarefa (chave:
 * `${idProcesso}:${idTaskInstance}`). Múltiplas linhas do mesmo
 * expediente compartilham a mesma chave — todas as linhas são
 * atualizadas simultaneamente quando o estado muda.
 */
type EncerrarEstado =
  | 'pronto'
  | 'executando'
  | 'sucesso'
  | 'erro'
  | 'nada-a-fazer';

interface EncerrarState {
  estado: EncerrarEstado;
  atualizadoEm: number;
  quantidade?: number;
  mensagem?: string;
  /**
   * `idDocumento` da linha que iniciou o clique. Como múltiplas linhas
   * compartilham o mesmo `(idProcesso, idTaskInstance)` e a automação, no
   * PJe, fecha todos os expedientes pendentes da tarefa de uma só vez,
   * todas as linhas precisam refletir a execução — mas apenas a linha
   * clicada exibe a mensagem completa. As demais ficam em modo compacto
   * (só ícone, sem rótulo) para não parecer que o usuário clicou em todas.
   */
  iniciadoPor?: string | null;
}

interface EncerrarQueueItem {
  key: string;
  url: string;
  numeroProcesso: string;
  idProcesso: string;
  idTaskInstance: string;
  /** `idDocumento` da linha clicada — grava no estado como `iniciadoPor`. */
  idDocumento: string;
}

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
  { key: 'anomalias',  label: 'Anomalias',            value: (l) => l.exp.anomalias.length },
  { key: 'encerrar',   label: 'Encerrar',             value: () => null }
];

const linhasPorTarefa = new Map<string, LinhaExpediente[]>();
const sortStates = new Map<string, SortState>();
const encerramentos = new Map<string, EncerrarState>();
const encerrarQueue: EncerrarQueueItem[] = [];
let encerrarRunningKey: string | null = null;

void main();

async function main(): Promise<void> {
  const root = document.getElementById('main') as HTMLElement;
  const meta = document.getElementById('meta') as HTMLElement;
  await restaurarEstadoEncerramento();
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
      'metrics',
      metric('Processos', String(payload.resultado.consolidado.length), `${comAbertos.length} com expedientes abertos`) +
      metric('Expedientes abertos', String(totalAbertos), '') +
      metric('Prazo correndo', String(correndo), '', 'success') +
      metric('Próximos 7 dias', String(proximos7), '', 'warning') +
      metric('Vencidos (aberto)', String(vencidos), 'possível Quartz', vencidos > 0 ? 'danger' : undefined) +
      metric('Com anomalia', String(anomalias), '', anomalias > 0 ? 'warning' : undefined)
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

  root.appendChild(renderDiagnosticoColeta(payload));
}

function renderDiagnosticoColeta(payload: PrazosFitaDashboardPayload): HTMLElement {
  const card = document.createElement('section');
  card.className = 'card';

  const contagem = new Map<string, number>();
  for (const t of payload.tarefasSelecionadas) contagem.set(t, 0);
  for (const c of payload.resultado.consolidado) {
    contagem.set(c.tarefaNome, (contagem.get(c.tarefaNome) ?? 0) + 1);
  }

  const entries = Array.from(contagem.entries()).map(([tarefa, lidos]) => ({ tarefa, lidos }));

  card.innerHTML =
    '<h2 class="card__title">Diagnóstico de coleta</h2>' +
    '<p class="card__sub">Detalhes técnicos por tarefa para entender o resultado da varredura ' +
    '(útil quando o total parece menor do que o esperado).</p>';

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap table-wrap--auto';
  const table = document.createElement('table');
  table.className = 'table--auto';
  table.innerHTML =
    '<thead><tr><th>Tarefa</th><th style="text-align:right">Lidos</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const e of entries) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = e.tarefa;
    const td2 = document.createElement('td');
    td2.style.textAlign = 'right';
    td2.textContent = String(e.lidos);
    tr.appendChild(td1);
    tr.appendChild(td2);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  makeTableSortable(table, entries, [
    { type: 'alpha', value: (e) => e.tarefa || null },
    { type: 'num',   value: (e) => e.lidos }
  ]);
  wrap.appendChild(table);
  card.appendChild(wrap);
  return card;
}

function construirLinhasExpediente(
  payload: PrazosFitaDashboardPayload
): LinhaExpediente[] {
  const out: LinhaExpediente[] = [];
  for (const c of payload.resultado.consolidado) {
    const abertos = c.coleta?.extracao?.abertos ?? [];
    const numero = c.coleta?.numeroProcesso ?? c.processoApi.numeroProcesso ?? '';
    const idProcesso =
      c.processoApi.idProcesso > 0 ? String(c.processoApi.idProcesso) : null;
    const idTaskInstance =
      c.processoApi.idTaskInstance != null
        ? String(c.processoApi.idTaskInstance)
        : null;
    for (const exp of abertos) {
      out.push({
        tarefaNome: c.tarefaNome,
        numeroProcesso: numero,
        url: c.url,
        idProcesso,
        idTaskInstance,
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
  // Coluna "Encerrar" é ação, não ordenável. Ela exibe, ao lado do rótulo,
  // um "?" com tooltip explicando que o clique fecha TODOS os expedientes
  // abertos da tarefa — a transparência que evita o confirm por clique.
  if (col.key === 'encerrar') {
    const dica =
      'Ao clicar, o pAIdegua fecha TODOS os expedientes pendentes desta ' +
      'tarefa de uma só vez. Para encerrar parcialmente, use o ícone de ' +
      '"Abrir tarefa" e faça pelo PJe.';
    return (
      '<th class="th-encerrar" aria-sort="none">' +
      '<span class="th-wrap th-wrap--encerrar">' +
      `<span class="th-label">${escapeHtml(col.label)}</span>` +
      `<span class="th-help" title="${escapeAttr(dica)}" ` +
      `aria-label="${escapeAttr(dica)}" tabindex="0">?</span>` +
      '</span></th>'
    );
  }
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
  const processoCol = renderProcCell(numero, l.url, l.idProcesso, l.idTaskInstance);
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
    `<td class="col-encerrar">${renderEncerrarCell(l)}</td>` +
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

function renderColapsivel(titulo: string, body: HTMLElement): HTMLElement {
  const d = document.createElement('details');
  d.className = 'card';
  d.innerHTML = `<summary>${escapeHtml(titulo)}<span class="col-tar">expandir/recolher</span></summary>`;
  d.appendChild(body);
  return d;
}

function renderListaSemAbertos(
  itens: PrazosFitaDashboardPayload['resultado']['consolidado']
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.innerHTML =
    '<thead><tr>' +
    '<th>Processo</th>' +
    '<th>Tarefa</th>' +
    '<th>Expedientes fechados</th>' +
    '<th>Anomalias de processo</th>' +
    '</tr></thead>';
  const tbody = document.createElement('tbody');
  const rows = itens.map((c) => {
    const numero = c.coleta?.numeroProcesso ?? c.processoApi.numeroProcesso ?? '—';
    const fechados = c.coleta?.extracao?.fechados ?? 0;
    const anomList = c.coleta?.anomaliasProcesso ?? [];
    const anom = anomList.length === 0
      ? '—'
      : anomList.map((a) => `<span class="badge badge--warning" title="${escapeAttr(a)}">${escapeHtml(rotularAnomalia(a))}</span>`).join(' ');
    const idProcesso =
      c.processoApi.idProcesso > 0 ? String(c.processoApi.idProcesso) : null;
    const idTaskInstance =
      c.processoApi.idTaskInstance != null
        ? String(c.processoApi.idTaskInstance)
        : null;
    const link = renderProcCell(numero, c.url, idProcesso, idTaskInstance);
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="col-num">${link}</td>` +
      `<td class="col-tar">${escapeHtml(c.tarefaNome)}</td>` +
      `<td class="col-dia">${fechados}</td>` +
      `<td>${anom}</td>`;
    tbody.appendChild(tr);
    return { c, numero, fechados, anomCount: anomList.length };
  });
  table.appendChild(tbody);
  makeTableSortable(table, rows, [
    { type: 'alpha', value: (r) => extractCNJ(r.numero) || r.numero || null },
    { type: 'alpha', value: (r) => r.c.tarefaNome || null },
    { type: 'num',   value: (r) => r.fechados },
    { type: 'num',   value: (r) => r.anomCount }
  ]);
  wrap.appendChild(table);
  return wrap;
}

function renderListaFalhas(
  itens: PrazosFitaDashboardPayload['resultado']['consolidado']
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.innerHTML =
    '<thead><tr>' +
    '<th>Processo</th>' +
    '<th>Tarefa</th>' +
    '<th>Erro</th>' +
    '</tr></thead>';
  const tbody = document.createElement('tbody');
  const rows = itens.map((c) => {
    const numero = c.coleta?.numeroProcesso ?? c.processoApi.numeroProcesso ?? '—';
    const err = c.error ?? c.coleta?.error ?? 'erro desconhecido';
    const idProcesso =
      c.processoApi.idProcesso > 0 ? String(c.processoApi.idProcesso) : null;
    const idTaskInstance =
      c.processoApi.idTaskInstance != null
        ? String(c.processoApi.idTaskInstance)
        : null;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="col-num">${renderProcCell(numero, c.url, idProcesso, idTaskInstance)}</td>` +
      `<td class="col-tar">${escapeHtml(c.tarefaNome)}</td>` +
      `<td>${escapeHtml(err)}</td>`;
    tbody.appendChild(tr);
    return { c, numero, err };
  });
  table.appendChild(tbody);
  makeTableSortable(table, rows, [
    { type: 'alpha', value: (r) => extractCNJ(r.numero) || r.numero || null },
    { type: 'alpha', value: (r) => r.c.tarefaNome || null },
    { type: 'alpha', value: (r) => r.err || null }
  ]);
  wrap.appendChild(table);
  return wrap;
}

function section(tag: string, cls: string, innerHtml: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  el.innerHTML = innerHtml;
  return el;
}

/**
 * Card numerico do topo. Mesmo layout e classes dos demais relatorios
 * ("Analisar tarefas" e "Painel Gerencial") para manter a apresentacao
 * padronizada: rotulo bold uppercase em cor primaria, valor grande em
 * primary-dark, hint discreto abaixo. A variante `kind` adiciona uma
 * faixa colorida na borda esquerda e tinge o valor — mesmo padrao
 * usado em `gestao-dashboard`.
 */
function metric(
  label: string,
  value: string,
  hint: string,
  kind?: 'danger' | 'warning' | 'success'
): string {
  const cls = kind ? ` metric--${kind}` : '';
  return (
    `<div class="metric${cls}">` +
    `<div class="metric__label">${escapeHtml(label)}</div>` +
    `<div class="metric__value">${escapeHtml(value)}</div>` +
    (hint ? `<div class="metric__hint">${escapeHtml(hint)}</div>` : '') +
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

function renderProcCell(
  numero: string,
  url: string | null,
  idProcesso: string | null,
  idTaskInstance: string | null
): string {
  const cnj = extractCNJ(numero);
  const label = escapeHtml(numero || '—');
  const main = url
    ? `<a class="proc-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" title="Abrir processo em nova guia">${label}</a>`
    : `<span class="proc-link proc-link--disabled" title="URL do processo indisponível">${label}</span>`;
  const copyBtn =
    `<button type="button" class="proc-copy" data-cnj="${escapeAttr(cnj)}" ` +
    `title="Copiar número do processo" aria-label="Copiar número do processo ${escapeAttr(cnj)}">` +
    `${COPY_ICON_SVG}</button>`;
  let openTaskBtn = '';
  if (podeAbrirTarefa(idProcesso, idTaskInstance) && url) {
    openTaskBtn =
      `<button type="button" class="proc-open-task" ` +
      `data-id-processo="${escapeAttr(idProcesso!)}" ` +
      `data-id-task="${escapeAttr(idTaskInstance!)}" ` +
      `data-url-ref="${escapeAttr(url)}" ` +
      `title="Abrir tarefa no PJe" aria-label="Abrir tarefa do processo ${escapeAttr(cnj)}">` +
      `${OPEN_TASK_ICON_SVG}</button>`;
  }
  return `<span class="proc-cell">${main}${copyBtn}${openTaskBtn}</span>`;
}

function instalarCopyDelegation(): void {
  document.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const copyBtn = target.closest<HTMLElement>('.proc-copy');
    if (copyBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const cnj = copyBtn.dataset.cnj || '';
      if (!cnj) return;
      void navigator.clipboard
        .writeText(cnj)
        .then(() => showToast(`Número copiado: ${cnj}`))
        .catch(() => showToast('Não foi possível copiar para a área de transferência.'));
      return;
    }
    const openBtn = target.closest<HTMLElement>('.proc-open-task');
    if (openBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const idProcesso = openBtn.dataset.idProcesso || '';
      const idTaskInstance = openBtn.dataset.idTask || '';
      const urlRef = openBtn.dataset.urlRef || '';
      if (!idProcesso || !idTaskInstance) return;
      const ok = abrirTarefaPopup({
        idProcesso,
        idTaskInstance,
        referenciaUrlAutos: urlRef
      });
      if (!ok) {
        showToast('Não foi possível abrir a tarefa (popup bloqueado?).');
      }
      return;
    }
    const encerrarBtn = target.closest<HTMLElement>('.proc-encerrar');
    if (encerrarBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      if (encerrarBtn.hasAttribute('disabled')) return;
      const key = encerrarBtn.dataset.encerrarKey || '';
      const idProcesso = encerrarBtn.dataset.idProcesso || '';
      const idTaskInstance = encerrarBtn.dataset.idTask || '';
      const idDocumento = encerrarBtn.dataset.idDocumento || '';
      const urlRef = encerrarBtn.dataset.urlRef || '';
      const numero = encerrarBtn.dataset.numero || '';
      if (!key || !idProcesso || !idTaskInstance || !urlRef) return;
      const urlTarefa = montarUrlTarefa({
        idProcesso,
        idTaskInstance,
        referenciaUrlAutos: urlRef
      });
      if (!urlTarefa) {
        showToast('Não foi possível montar a URL da tarefa no PJe.');
        return;
      }
      enfileirarEncerramento({
        key,
        url: urlTarefa,
        numeroProcesso: numero,
        idProcesso,
        idTaskInstance,
        idDocumento
      });
    }
  });
}

// =====================================================================
// Coluna "Encerrar" — estados, fila serial e ponte para o background
// =====================================================================

function renderEncerrarCell(l: LinhaExpediente): string {
  if (
    !l.url ||
    !podeAbrirTarefa(l.idProcesso, l.idTaskInstance)
  ) {
    return '';
  }
  const cnj = extractCNJ(l.numeroProcesso || '');
  // Chave por TAREFA (idProcesso+idTaskInstance) — todas as linhas da
  // mesma tarefa compartilham o estado porque a automação fecha tudo
  // junto. A diferenciação visual (quem clicou vs. espectadores) é feita
  // em `renderEncerrarBtn` comparando `idDocumento` com `state.iniciadoPor`.
  const key = buildEncerrarKey(l.idProcesso!, l.idTaskInstance!);
  const state = encerramentos.get(key) ?? { estado: 'pronto', atualizadoEm: 0 };
  return renderEncerrarBtn(
    key,
    l.idProcesso!,
    l.idTaskInstance!,
    l.exp.idDocumento,
    l.url,
    cnj,
    state
  );
}

function buildEncerrarKey(
  idProcesso: string,
  idTaskInstance: string
): string {
  return `${idProcesso}:${idTaskInstance}`;
}

function renderEncerrarBtn(
  key: string,
  idProcesso: string,
  idTaskInstance: string,
  idDocumento: string,
  urlRef: string,
  numeroCNJ: string,
  state: EncerrarState
): string {
  const { estado } = state;
  const isDisabled =
    estado === 'executando' || estado === 'sucesso' || estado === 'nada-a-fazer';
  // Modo "compacto": linhas da mesma tarefa que NÃO iniciaram o clique
  // refletem o andamento/resultado só pelo ícone. Enquanto `pronto`
  // (ninguém clicou ainda) todos são full. Depois que alguém clica,
  // só a linha do `iniciadoPor` continua full.
  const isClicker =
    state.iniciadoPor == null || state.iniciadoPor === idDocumento;
  const compact = estado !== 'pronto' && !isClicker;
  const cls =
    'proc-encerrar ' +
    `proc-encerrar--${estado === 'nada-a-fazer' ? 'vazio' : estado}` +
    (compact ? ' proc-encerrar--compact' : '');
  const label = compact ? labelCompactEncerrar(state) : labelEncerrar(state);
  const titulo = compact ? tooltipCompactEncerrar(state) : tooltipEncerrar(state);
  const labelHtml = label
    ? `<span class="proc-encerrar__label">${escapeHtml(label)}</span>`
    : '';
  return (
    `<button type="button" class="${cls}" ` +
    `data-encerrar-key="${escapeAttr(key)}" ` +
    `data-id-processo="${escapeAttr(idProcesso)}" ` +
    `data-id-task="${escapeAttr(idTaskInstance)}" ` +
    `data-id-documento="${escapeAttr(idDocumento)}" ` +
    `data-url-ref="${escapeAttr(urlRef)}" ` +
    `data-numero="${escapeAttr(numeroCNJ)}" ` +
    `title="${escapeAttr(titulo)}" aria-label="${escapeAttr(titulo)}"` +
    (isDisabled ? ' disabled' : '') +
    '>' +
    iconeEncerrar(estado) +
    labelHtml +
    '</button>'
  );
}

function labelCompactEncerrar(state: EncerrarState): string {
  // Linhas espectadoras: só ícone. Sem rótulo para não parecer que o
  // usuário clicou em todas. Ainda assim `sucesso`/`erro` têm um rótulo
  // curto como dica visual redundante ao ícone.
  switch (state.estado) {
    case 'executando': return '';
    case 'sucesso': return '';
    case 'erro': return '';
    case 'nada-a-fazer': return '';
    default: return '';
  }
}

function tooltipCompactEncerrar(state: EncerrarState): string {
  switch (state.estado) {
    case 'executando':
      return 'Outra linha desta tarefa disparou o encerramento — aguarde.';
    case 'sucesso':
      return (
        `Encerrado pela linha que foi clicada — ${state.quantidade ?? 0} ` +
        'expediente(s) desta tarefa foram fechados.'
      );
    case 'erro':
      return (
        'Encerramento desta tarefa falhou: ' +
        (state.mensagem || 'erro desconhecido') +
        '. Clique em qualquer linha para tentar novamente.'
      );
    case 'nada-a-fazer':
      return 'Todos os expedientes desta tarefa já estavam fechados.';
    default:
      return 'Fechar todos os expedientes desta tarefa no PJe.';
  }
}

function labelEncerrar(state: EncerrarState): string {
  switch (state.estado) {
    case 'executando': return 'Encerrando…';
    case 'sucesso':
      return state.quantidade
        ? `Encerrado (${state.quantidade})`
        : 'Encerrado';
    case 'erro': return 'Tentar novamente';
    case 'nada-a-fazer': return 'Nada a fazer';
    default: return 'Encerrar todos';
  }
}

function tooltipEncerrar(state: EncerrarState): string {
  const hora =
    state.atualizadoEm > 0
      ? new Date(state.atualizadoEm).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit'
        })
      : '';
  switch (state.estado) {
    case 'executando':
      return 'Fechando expedientes no PJe — aguarde.';
    case 'sucesso':
      return (
        `Encerrado às ${hora} — ${state.quantidade ?? 0} expediente(s).`
      );
    case 'erro':
      return (
        `Falhou às ${hora}: ` +
        (state.mensagem || 'erro desconhecido') +
        '. Clique para tentar de novo.'
      );
    case 'nada-a-fazer':
      return 'Todos os expedientes desta tarefa já estavam fechados.';
    default:
      return 'Fechar todos os expedientes desta tarefa no PJe.';
  }
}

function iconeEncerrar(estado: EncerrarEstado): string {
  if (estado === 'executando') {
    return (
      '<svg class="proc-encerrar__icon proc-encerrar__icon--spin" ' +
      'width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 12a9 9 0 1 1-6.2-8.55"/>' +
      '</svg>'
    );
  }
  if (estado === 'sucesso') {
    return (
      '<svg class="proc-encerrar__icon" width="14" height="14" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="20 6 9 17 4 12"/></svg>'
    );
  }
  if (estado === 'erro') {
    return (
      '<svg class="proc-encerrar__icon" width="14" height="14" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    );
  }
  if (estado === 'nada-a-fazer') {
    return (
      '<svg class="proc-encerrar__icon" width="14" height="14" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="5" y1="12" x2="19" y2="12"/></svg>'
    );
  }
  // pronto
  return (
    '<svg class="proc-encerrar__icon" width="14" height="14" ' +
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="3 6 5 6 21 6"/>' +
    '<path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>' +
    '<path d="M10 11v6"/><path d="M14 11v6"/>' +
    '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>'
  );
}

function enfileirarEncerramento(item: EncerrarQueueItem): void {
  // Se já está executando ou na fila, ignora o novo clique silenciosamente.
  if (encerrarRunningKey === item.key) return;
  if (encerrarQueue.some((q) => q.key === item.key)) return;
  const atual = encerramentos.get(item.key);
  if (atual?.estado === 'executando') return;
  atualizarEstadoEncerramento(item.key, {
    estado: 'executando',
    atualizadoEm: Date.now(),
    iniciadoPor: item.idDocumento
  });
  encerrarQueue.push(item);
  void processarFilaEncerramento();
}

async function processarFilaEncerramento(): Promise<void> {
  if (encerrarRunningKey !== null) return;
  const prox = encerrarQueue.shift();
  if (!prox) return;
  encerrarRunningKey = prox.key;
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PRAZOS_ENCERRAR_RUN,
      payload: {
        url: prox.url,
        numeroProcesso: prox.numeroProcesso,
        idProcesso: prox.idProcesso,
        idTaskInstance: prox.idTaskInstance
      }
    })) as
      | {
          ok: boolean;
          estado: EncerrarEstado;
          quantidade: number;
          error?: string;
          terminouEm: number;
        }
      | undefined;
    if (!resp) {
      atualizarEstadoEncerramento(prox.key, {
        estado: 'erro',
        atualizadoEm: Date.now(),
        mensagem: 'Sem resposta do background.',
        iniciadoPor: prox.idDocumento
      });
    } else {
      atualizarEstadoEncerramento(prox.key, {
        estado: resp.estado,
        atualizadoEm: resp.terminouEm || Date.now(),
        quantidade: resp.quantidade,
        mensagem: resp.error,
        iniciadoPor: prox.idDocumento
      });
    }
  } catch (err) {
    atualizarEstadoEncerramento(prox.key, {
      estado: 'erro',
      atualizadoEm: Date.now(),
      mensagem: err instanceof Error ? err.message : String(err),
      iniciadoPor: prox.idDocumento
    });
  } finally {
    encerrarRunningKey = null;
    if (encerrarQueue.length > 0) {
      void processarFilaEncerramento();
    }
  }
}

function atualizarEstadoEncerramento(
  key: string,
  state: EncerrarState
): void {
  encerramentos.set(key, state);
  persistirEstadoEncerramento();
  repintarBotoesEncerrar(key);
  if (state.estado === 'erro') {
    showToast('Encerramento falhou: ' + (state.mensagem || 'erro desconhecido'));
  } else if (state.estado === 'sucesso') {
    showToast(`Encerrado: ${state.quantidade ?? 0} expediente(s).`);
  } else if (state.estado === 'nada-a-fazer') {
    showToast('Nenhum expediente aberto encontrado.');
  }
}

function repintarBotoesEncerrar(key: string): void {
  const botoes = document.querySelectorAll<HTMLButtonElement>(
    `.proc-encerrar[data-encerrar-key="${escapeAttr(key)}"]`
  );
  botoes.forEach((btn) => {
    const idProcesso = btn.dataset.idProcesso ?? '';
    const idTask = btn.dataset.idTask ?? '';
    const idDocumento = btn.dataset.idDocumento ?? '';
    const urlRef = btn.dataset.urlRef ?? '';
    const numero = btn.dataset.numero ?? '';
    const state =
      encerramentos.get(key) ?? { estado: 'pronto' as EncerrarEstado, atualizadoEm: 0 };
    const html = renderEncerrarBtn(
      key,
      idProcesso,
      idTask,
      idDocumento,
      urlRef,
      numero,
      state
    );
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const novo = tmp.firstElementChild as HTMLButtonElement | null;
    if (novo) btn.replaceWith(novo);
  });
}

function persistirEstadoEncerramento(): void {
  const obj: Record<string, EncerrarState> = {};
  for (const [k, v] of encerramentos) obj[k] = v;
  chrome.storage.local
    .set({ [STORAGE_KEYS.PRAZOS_ENCERRAMENTOS]: obj })
    .catch((e) =>
      console.warn(`${LOG_PREFIX} falha ao persistir encerramentos:`, e)
    );
}

async function restaurarEstadoEncerramento(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.PRAZOS_ENCERRAMENTOS
    ]);
    const raw = stored[STORAGE_KEYS.PRAZOS_ENCERRAMENTOS] as
      | Record<string, EncerrarState>
      | undefined;
    if (!raw) return;
    // "executando" ficou preso (F5 mid-run): rebaixa a "erro" para re-tentativa.
    for (const [k, v] of Object.entries(raw)) {
      if (v.estado === 'executando') {
        encerramentos.set(k, {
          estado: 'erro',
          atualizadoEm: v.atualizadoEm,
          mensagem: 'Recarregou a página durante o encerramento.'
        });
      } else {
        encerramentos.set(k, v);
      }
    }
  } catch (e) {
    console.warn(`${LOG_PREFIX} falha ao restaurar encerramentos:`, e);
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
