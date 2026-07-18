/**
 * Dashboard do Painel de Perícias (perfil Gestão). Lê o
 * `PautaPericiaDashboardPayload` de `chrome.storage.session` e renderiza, no
 * kit visual do PREVJUD: métricas (KPIs), quebra por situação e por perito, e
 * a tabela detalhada (uma linha por perícia) com copiar nº, abrir autos e Excel.
 */

import { MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import { renderHeaderMeta } from '../shared/header-meta';
import { criarBotaoCopiar } from '../shared/icons';
import {
  OPEN_TASK_ICON_SVG,
  abrirTarefaPopup,
  podeAbrirTarefa
} from '../shared/pje-task-popup';
import { attachExcelButton, type ExcelColumn } from '../shared/xlsx-export';
import { makeTableSortable, type TableSortColumn } from '../shared/table-sort';
import type {
  PautaPericiaDashboardPayload,
  PericiaItem,
  ProcessoComPericias
} from '../shared/pauta-pericia-types';

/** Uma linha da tabela = uma perícia com seu processo. */
interface Linha {
  proc: ProcessoComPericias;
  pericia: PericiaItem;
}

const elMain = document.getElementById('main') as HTMLElement;
const elMeta = document.getElementById('meta') as HTMLElement;

let requestId = '';

void main();

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  requestId = params.get('rid') ?? '';
  const viaCache = params.get('cache') === '1';

  // Reabrir último relatório salvo, sem refazer a coleta.
  if (viaCache) {
    const cached = await carregarCache();
    if (!cached) return exibirErro('Não há relatório salvo. Gere um novo a partir do PJe.');
    render(cached);
    return;
  }

  if (!requestId) return exibirErro('Identificador de requisição ausente.');
  const key = `${STORAGE_KEYS.PAUTA_PERICIA_DASHBOARD_PAYLOAD_PREFIX}${requestId}`;
  let payload: PautaPericiaDashboardPayload | null = null;
  try {
    const got = await chrome.storage.session.get(key);
    payload = (got[key] as PautaPericiaDashboardPayload) ?? null;
  } catch {
    payload = null;
  }
  if (!payload) {
    const cached = await carregarCache();
    if (cached && cached.requestId === requestId) payload = cached;
  }
  if (!payload) return exibirErro('Relatório não encontrado. Gere um novo a partir do PJe.');

  render(payload);
  if (payload.status !== 'running') void salvarCache(payload);

  // Streaming: o background grava o esqueleto (running) e vai aplicando os
  // slot-patches; o dashboard re-renderiza a cada atualização da sessão e
  // persiste no cache quando a coleta conclui.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    const ch = changes[key];
    const nv = ch?.newValue as PautaPericiaDashboardPayload | undefined;
    if (nv && Array.isArray(nv.processos)) {
      if (nv.status === 'done') void salvarCache(nv);
      render(nv);
    }
  });

  window.addEventListener('pagehide', () => {
    void chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PAUTA_PERICIA_CLEAR_PAYLOAD,
      payload: { requestId }
    });
  });
}

async function carregarCache(): Promise<PautaPericiaDashboardPayload | null> {
  try {
    const out = await chrome.storage.local.get(STORAGE_KEYS.PAUTA_PERICIA_ULTIMO_RELATORIO);
    const raw = out[STORAGE_KEYS.PAUTA_PERICIA_ULTIMO_RELATORIO];
    if (raw && typeof raw === 'object' && Array.isArray((raw as PautaPericiaDashboardPayload).processos)) {
      return raw as PautaPericiaDashboardPayload;
    }
    return null;
  } catch {
    return null;
  }
}

async function salvarCache(p: PautaPericiaDashboardPayload): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.PAUTA_PERICIA_ULTIMO_RELATORIO]: p });
  } catch {
    /* cache é conveniência — ignora falha */
  }
}

function render(p: PautaPericiaDashboardPayload): void {
  const linhas: Linha[] = p.processos.flatMap((proc) =>
    proc.pericias.map((pericia) => ({ proc, pericia }))
  );

  renderHeaderMeta(elMeta, {
    unidade: undefined,
    geradoEm: p.geradoEm,
    contadores: [
      p.hostnamePJe,
      `${p.totais.processosComPericia} processo(s) · ${p.totais.totalPericias} perícia(s)`
    ]
  });

  elMain.textContent = '';

  // Banner de streaming enquanto a coleta corre.
  if (p.status === 'running') {
    const feitos = p.progress?.feitos ?? 0;
    const total = p.progress?.total ?? 0;
    const banner = el('div', { className: 'aviso' });
    banner.textContent = `Coletando perícias… ${feitos} de ${total} processo(s) varrido(s). O painel atualiza sozinho.`;
    elMain.appendChild(banner);
  }

  // KPIs
  const metrics = el('section', { className: 'metrics' });
  metrics.append(
    metric(String(p.totais.processosComPericia), 'Processos com perícia'),
    metric(String(p.totais.totalPericias), 'Perícias'),
    metric(formatarBRL(p.totais.valorTotal), 'Valor total'),
    metric(String(p.totais.processosVarridos), 'Candidatos varridos'),
    metric(String(p.diagnostico.falhas.length), 'Falhas', p.diagnostico.falhas.length ? 'warning' : undefined)
  );
  elMain.appendChild(metrics);

  if (linhas.length === 0) {
    // Durante o streaming (running) ainda não há linhas — não mostrar o
    // vazio definitivo; o banner já indica que está coletando.
    if (p.status !== 'running') {
      const v = el('div', { className: 'section' });
      v.textContent = 'Nenhuma perícia encontrada nos processos das tarefas selecionadas.';
      elMain.appendChild(v);
    }
    if (p.diagnostico.falhas.length > 0) elMain.appendChild(secaoDiagnostico(p));
    return;
  }

  // Agregações
  const grid = el('div', { className: 'grid-2' });
  grid.append(
    secaoBarlist('Por situação', agregarContagem(linhas, (l) => l.pericia.situacao || '—')),
    secaoBarlist('Por perito', agregarPerito(linhas), 'Quantidade de perícias e valor por perito.')
  );
  elMain.appendChild(grid);

  // Tabela
  elMain.appendChild(montarSecaoTabela(p, linhas));

  // Diagnóstico
  elMain.appendChild(secaoDiagnostico(p));

  montarToast();
}

// ---------- Agregações ----------

interface LinhaBar { label: string; count: number; sub?: string }

function agregarContagem(linhas: Linha[], chave: (l: Linha) => string): LinhaBar[] {
  const mapa = new Map<string, number>();
  for (const l of linhas) {
    const k = chave(l);
    mapa.set(k, (mapa.get(k) ?? 0) + 1);
  }
  return [...mapa.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

function agregarPerito(linhas: Linha[]): LinhaBar[] {
  const mapa = new Map<string, { count: number; valor: number }>();
  for (const l of linhas) {
    const k = l.pericia.peritoNome ?? '— sem perito —';
    const cur = mapa.get(k) ?? { count: 0, valor: 0 };
    cur.count += 1;
    cur.valor += l.pericia.valor ?? 0;
    mapa.set(k, cur);
  }
  return [...mapa.entries()]
    .map(([label, v]) => ({ label, count: v.count, sub: formatarBRL(v.valor) }))
    .sort((a, b) => b.count - a.count);
}

function secaoBarlist(titulo: string, linhas: LinhaBar[], hint?: string): HTMLElement {
  const sec = el('section', { className: 'section' });
  const h2 = el('h2'); h2.textContent = titulo; sec.appendChild(h2);
  if (hint) { const p = el('p', { className: 'section__hint' }); p.textContent = hint; sec.appendChild(p); }
  const max = Math.max(1, ...linhas.map((l) => l.count));
  const lista = el('div', { className: 'barlist scroll-limit' });
  for (const l of linhas) {
    const row = el('div', { className: 'barlist__row' });
    const lab = el('div', { className: 'barlist__label' });
    const bar = el('span', { className: 'barlist__bar' });
    bar.style.width = `${Math.round((l.count / max) * 100)}%`;
    lab.appendChild(bar);
    lab.appendChild(document.createTextNode(l.sub ? `${l.label} · ${l.sub}` : l.label));
    const cnt = el('div', { className: 'barlist__count' });
    cnt.textContent = String(l.count);
    row.append(lab, cnt);
    lista.appendChild(row);
  }
  sec.appendChild(lista);
  return sec;
}

// ---------- Tabela ----------

function montarSecaoTabela(p: PautaPericiaDashboardPayload, linhas: Linha[]): HTMLElement {
  const sec = el('section', { className: 'section section--copy' });
  const h2 = el('h2'); h2.textContent = 'Perícias'; sec.appendChild(h2);
  const hint = el('p', { className: 'section__hint' });
  hint.textContent = 'Clique nos cabeçalhos para ordenar. Use os botões no topo para copiar a lista de processos ou baixar em Excel.';
  sec.appendChild(hint);

  const wrap = el('div', { className: 'scroll-limit' });
  const tabela = el('table', { className: 'proc-table' });
  const thead = el('thead');
  const trh = el('tr');
  for (const c of ['Processo', 'Data/Hora', 'Periciado', 'Valor', 'Perito', 'Situação', '']) {
    const th = el('th'); th.textContent = c; trh.appendChild(th);
  }
  thead.appendChild(trh);
  tabela.appendChild(thead);
  const tbody = el('tbody');
  for (const l of linhas) tbody.appendChild(montarLinha(l));
  tabela.appendChild(tbody);
  wrap.appendChild(tabela);
  sec.appendChild(wrap);

  const colsSort: Array<TableSortColumn<Linha> | null> = [
    { type: 'alpha', value: (l) => l.proc.numeroProcesso },
    { type: 'date', value: (l) => l.pericia.dataHora },
    { type: 'alpha', value: (l) => l.pericia.periciado },
    { type: 'num', value: (l) => l.pericia.valor },
    { type: 'alpha', value: (l) => l.pericia.peritoNome },
    { type: 'alpha', value: (l) => l.pericia.situacao },
    null
  ];
  makeTableSortable(tabela, linhas, colsSort);

  const numeros = Array.from(new Set(p.processos.map((pr) => pr.numeroProcesso).filter(Boolean)));
  sec.appendChild(
    criarBotaoCopiar({
      className: 'copy-btn',
      titulo: 'Copiar números dos processos',
      tamanho: 16,
      texto: numeros.join('\n')
    })
  );
  attachExcelButton(sec, () => linhas, COLUNAS_EXCEL, 'painel-pericias', {
    label: 'Baixar perícias em Excel',
    sheetName: 'Perícias',
    onToast: showToast
  });
  return sec;
}

function montarLinha(l: Linha): HTMLElement {
  const tr = el('tr');

  const tdProc = el('td', { className: 'num' });
  const cell = el('span', { className: 'proc-cell' });
  if (l.proc.urlAutos) {
    const a = el('a', { className: 'proc-link' }) as HTMLAnchorElement;
    a.href = l.proc.urlAutos; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = l.proc.numeroProcesso ?? '—';
    cell.appendChild(a);
  } else {
    cell.appendChild(document.createTextNode(l.proc.numeroProcesso ?? '—'));
  }
  if (l.proc.numeroProcesso) {
    cell.appendChild(criarBotaoCopiar({ className: 'proc-copy', titulo: 'Copiar número do processo', texto: l.proc.numeroProcesso }));
  }
  // Abrir a tarefa do processo no PJe (popup nomeado, como o painel nativo).
  const idP = String(l.proc.idProcesso);
  const idT = l.proc.idTaskInstance != null ? String(l.proc.idTaskInstance) : null;
  if (idT && podeAbrirTarefa(idP, idT)) {
    const btnTarefa = el('button', { className: 'proc-open-task', title: 'Abrir a tarefa' });
    btnTarefa.type = 'button';
    btnTarefa.innerHTML = OPEN_TASK_ICON_SVG;
    btnTarefa.addEventListener('click', () => {
      const ok = abrirTarefaPopup({ idProcesso: idP, idTaskInstance: idT, referenciaUrlAutos: l.proc.urlAutos });
      if (!ok) showToast('Não consegui abrir a tarefa — verifique se o PJe está aberto e se o popup foi permitido.');
    });
    cell.appendChild(btnTarefa);
  }
  tdProc.appendChild(cell);
  tr.appendChild(tdProc);

  tr.append(
    tdTexto(l.pericia.dataHora ?? '—'),
    tdTexto(l.pericia.periciado ?? '—'),
    tdTexto(l.pericia.valorTexto ?? '—'),
    tdTexto(l.pericia.peritoNome ?? '—'),
    tdSituacao(l.pericia.situacao),
    el('td')
  );
  return tr;
}

function tdTexto(texto: string): HTMLElement {
  const td = el('td'); td.textContent = texto; return td;
}

function tdSituacao(s: string): HTMLElement {
  const td = el('td');
  const span = el('span', { className: `badge ${classeBadgeSituacao(s)}` });
  span.textContent = s || '—';
  td.appendChild(span);
  return td;
}

function classeBadgeSituacao(s: string): string {
  if (/pago|realizad|entregue|juntad/i.test(s)) return 'badge--ok';
  if (/cancel|n[ãa]o realizad|devolvid/i.test(s)) return 'badge--danger';
  if (/enviad|aguardando/i.test(s)) return 'badge--warn';
  return 'badge--neutro';
}

function secaoDiagnostico(p: PautaPericiaDashboardPayload): HTMLElement {
  const sec = el('section', { className: 'section' });
  const h2 = el('h2'); h2.textContent = 'Diagnóstico'; sec.appendChild(h2);
  const ul = el('ul', { className: 'diag-lista' });
  const li = (t: string): void => { const x = el('li'); x.textContent = t; ul.appendChild(x); };
  li(`${p.diagnostico.processosNaTarefa} processo(s) nas tarefas · ${p.diagnostico.filtradosPorEtiqueta} após filtro de etiqueta.`);
  if (p.diagnostico.situacoesIgnoradas && p.diagnostico.situacoesIgnoradas.length > 0) {
    li(`Situações ignoradas: ${p.diagnostico.situacoesIgnoradas.join(', ')} (${p.diagnostico.periciasIgnoradas ?? 0} perícia(s) descartada(s)).`);
  }
  if (p.diagnostico.falhas.length > 0) {
    li(`${p.diagnostico.falhas.length} processo(s) com falha na coleta:`);
    for (const f of p.diagnostico.falhas.slice(0, 30)) {
      const x = el('li'); x.textContent = `• ${f.numeroProcesso ?? f.idProcesso}: ${f.erro}`; ul.appendChild(x);
    }
  }
  sec.appendChild(ul);
  return sec;
}

// ---------- Excel ----------

const COLUNAS_EXCEL: ExcelColumn<Linha>[] = [
  { header: 'Processo', key: (l) => l.proc.numeroProcesso, width: 24 },
  { header: 'Classe', key: (l) => l.proc.classeJudicial, width: 30 },
  { header: 'Data/Hora', key: (l) => l.pericia.dataHora, width: 18 },
  { header: 'Periciado', key: (l) => l.pericia.periciado, width: 28 },
  { header: 'Valor', key: (l) => l.pericia.valor, width: 12, type: 'number', format: 'R$ #,##0.00' },
  { header: 'Perito', key: (l) => l.pericia.peritoNome, width: 26 },
  { header: 'CPF perito', key: (l) => l.pericia.peritoCpf, width: 16 },
  { header: 'Situação', key: (l) => l.pericia.situacao, width: 20 }
];

// ---------- Helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) Object.assign(node, props);
  return node;
}

function metric(valor: string, rotulo: string, tom?: 'warning' | 'danger'): HTMLElement {
  const box = el('div', { className: 'metric' });
  const lab = el('div', { className: 'metric__label' }); lab.textContent = rotulo;
  const val = el('div', { className: 'metric__value' + (tom ? ` metric__value--${tom}` : '') }); val.textContent = valor;
  box.append(lab, val);
  return box;
}

function formatarBRL(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

let toastEl: HTMLElement | null = null;
let toastTimer = 0;
function montarToast(): void {
  if (toastEl) return;
  toastEl = el('div', { className: 'toast' });
  document.body.appendChild(toastEl);
}
function showToast(msg: string): void {
  if (!toastEl) montarToast();
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('toast--visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('toast--visible'), 2600);
}

function exibirErro(msg: string): void {
  elMain.textContent = '';
  const p = el('p', { className: 'erro-msg' });
  p.textContent = msg;
  elMain.appendChild(p);
}
