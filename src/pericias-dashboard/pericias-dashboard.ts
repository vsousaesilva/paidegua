/**
 * Dashboard da pauta de perícias (perfil Secretaria → Perícias pAIdegua).
 *
 * Lê o payload gravado em `chrome.storage.session` sob o prefixo
 * `PERICIAS_DASHBOARD_PAYLOAD_PREFIX` + requestId (obtido via `?rid=`) e
 * renderiza uma pauta por perito com tabela de processos.
 *
 * Para cada item da pauta: hiperlink para os autos + botão para copiar
 * o número CNJ (padrão pAIdegua para todos os relatórios).
 *
 * Ações disponíveis por pauta:
 *   - Copiar lista (números CNJ)
 *   - Baixar CSV
 *   - Aplicar etiquetas (cria a etiqueta da pauta — "DR(A) NOME DD.MM.AA"
 *     — se não existir, e vincula a todos os processos da pauta do perito)
 *     → stub nesta fase; o endpoint está em investigação.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import type {
  PericiaPauta,
  PericiaPautaItem,
  PericiasDashboardPayload
} from '../shared/types';

const LOG = `${LOG_PREFIX} [pericias-dashboard]`;

// Estado runtime do dashboard — usado para "Atualizar pauta" (exclusões +
// regeneração). Não persiste; é reconstruído a cada carregamento.
interface DashboardRuntime {
  rid: string;
  payload: PericiasDashboardPayload | null;
  /** Acumula idProcesso que o usuário marcou com X desde o último refazer. */
  excluidosRuntime: Set<number>;
  atualizando: boolean;
}
const rt: DashboardRuntime = {
  rid: '',
  payload: null,
  excluidosRuntime: new Set<number>(),
  atualizando: false
};

// =====================================================================
// Entrypoint
// =====================================================================

document.addEventListener('DOMContentLoaded', () => {
  registrarListenerBackground();
  void carregar();
});

function registrarListenerBackground(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.channel !== 'string') return false;
    if (sender?.tab) return false; // só o relay do background
    const payload = message.payload as { requestId?: string } | undefined;
    if (!payload || payload.requestId !== rt.rid) return false;

    if (message.channel === MESSAGE_CHANNELS.PERICIAS_COLETA_PROG) {
      const msg = (payload as { msg?: string }).msg ?? '';
      atualizarOverlayProgresso(msg);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.PERICIAS_COLETA_READY) {
      // A nova pauta já foi gravada no storage.session. Recarrega esta
      // mesma aba para re-ler e renderizar — preserva o rid na URL.
      sendResponse({ ok: true });
      window.setTimeout(() => window.location.reload(), 250);
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.PERICIAS_COLETA_FAIL) {
      const err = (payload as { error?: string }).error ?? 'Erro desconhecido.';
      encerrarOverlayProgresso(err, true);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}

async function carregar(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const rid = params.get('rid') ?? '';
  const main = document.getElementById('main');
  const meta = document.getElementById('meta');
  if (!main) return;

  rt.rid = rid;
  rt.excluidosRuntime = new Set<number>();
  rt.atualizando = false;

  if (!rid) {
    main.innerHTML = '<p class="erro-msg">Parâmetro <code>rid</code> ausente na URL.</p>';
    return;
  }

  try {
    const key = STORAGE_KEYS.PERICIAS_DASHBOARD_PAYLOAD_PREFIX + rid;
    const raw = await chrome.storage.session.get(key);
    const payload = raw?.[key] as PericiasDashboardPayload | undefined;
    if (!payload) {
      main.innerHTML =
        '<p class="erro-msg">Pauta não encontrada no armazenamento da sessão. ' +
        'Feche esta aba e gere a pauta novamente a partir do PJe.</p>';
      return;
    }
    rt.payload = payload;
    renderMeta(meta, payload);
    renderConteudo(main, payload);
  } catch (err) {
    console.error(`${LOG} falha ao carregar payload:`, err);
    main.innerHTML = `<p class="erro-msg">Falha ao carregar pauta: ${escapeHtml(String(err))}</p>`;
  }
}

function renderMeta(meta: HTMLElement | null, payload: PericiasDashboardPayload): void {
  if (!meta) return;
  const quando = new Date(payload.geradoEm).toLocaleString('pt-BR');
  meta.innerHTML =
    `Gerado em ${escapeHtml(quando)}<br>` +
    `Tarefas: ${payload.tarefasVarridas.map(escapeHtml).join(' · ')}<br>` +
    `Origem: ${escapeHtml(payload.hostnamePJe)}`;
}

// =====================================================================
// Conteúdo
// =====================================================================

function renderConteudo(main: HTMLElement, payload: PericiasDashboardPayload): void {
  main.innerHTML = '';

  // KPIs do topo
  const kpis = el('div', 'kpis');
  kpis.appendChild(buildKpi('Processos varridos', payload.totais.processosVarridos));
  kpis.appendChild(buildKpi('Na pauta final', payload.totais.processosNaPauta));
  kpis.appendChild(buildKpi('Peritos contemplados', payload.totais.peritosContemplados));
  kpis.appendChild(buildKpi('Peritos na seleção', payload.pautas.length));
  main.appendChild(kpis);

  // Barra global de ações — botão "Atualizar pauta" refaz a varredura
  // excluindo os processos marcados com X.
  const barra = el('div', 'barra-global');
  const info = el('span', 'barra-global__info');
  info.textContent =
    'Clique no "×" ao lado de um processo para excluí-lo da pauta. Depois use "Atualizar pauta" para refazer sem ele.';
  barra.appendChild(info);
  const btnAtualizar = document.createElement('button');
  btnAtualizar.type = 'button';
  btnAtualizar.className = 'btn primary';
  btnAtualizar.id = 'btn-atualizar-pauta';
  btnAtualizar.textContent = 'Atualizar pauta';
  btnAtualizar.disabled = true;
  btnAtualizar.title = 'Refaz a pauta removendo os processos marcados.';
  btnAtualizar.addEventListener('click', () => void acionarAtualizarPauta());
  barra.appendChild(btnAtualizar);
  main.appendChild(barra);

  // Pautas por perito
  if (payload.pautas.length === 0) {
    const vazio = el('section', 'section');
    vazio.appendChild(textEl('h2', '', 'Nenhuma pauta montada'));
    vazio.appendChild(
      textEl('p', 'section__hint', 'Nenhum perito foi selecionado para esta montagem.')
    );
    main.appendChild(vazio);
    return;
  }

  for (const pauta of payload.pautas) {
    main.appendChild(buildPautaCard(pauta));
  }

  // Resíduo (processos fora de qualquer pauta)
  if (payload.naoDistribuidos.length > 0) {
    main.appendChild(buildResiduo(payload.naoDistribuidos));
  }
}

function buildKpi(label: string, value: number): HTMLElement {
  const box = el('div', 'kpi');
  box.appendChild(textEl('div', 'kpi__label', label));
  box.appendChild(textEl('div', 'kpi__value', String(value)));
  return box;
}

// =====================================================================
// Pauta por perito
// =====================================================================

function buildPautaCard(pauta: PericiaPauta): HTMLElement {
  const card = el('section', 'pauta');
  if (pauta.quantidadeAtingida === 0) card.classList.add('pauta--vazia');
  else if (pauta.quantidadeAtingida < pauta.quantidadePedida)
    card.classList.add('pauta--parcial');

  const head = el('header', 'pauta__head');

  const titulo = el('div', 'pauta__titulo');
  titulo.appendChild(textEl('h3', '', pauta.peritoNomeCompleto));
  titulo.appendChild(
    textEl('span', 'pauta__etiqueta', pauta.etiquetaPauta)
  );
  head.appendChild(titulo);

  const stats = el('div', 'pauta__stats');
  const atingida = pauta.quantidadeAtingida;
  const pedida = pauta.quantidadePedida;
  const s = atingida >= pedida
    ? `<span class="ok">${atingida}/${pedida} processo(s)</span>`
    : `<span class="warn">${atingida}/${pedida} processo(s) &mdash; meta não atingida</span>`;
  stats.innerHTML = s;
  head.appendChild(stats);

  card.appendChild(head);

  // Área de status das ações (feedback do Aplicar etiquetas)
  const statusHolder = el('div', 'status-holder');
  card.appendChild(statusHolder);

  // Toolbar de ações
  const toolbar = el('div', 'toolbar');

  const btnCopy = buildBtn('Copiar lista', () => {
    const txt = pauta.itens
      .map((it) => extractCNJ(it.numeroProcesso ?? ''))
      .filter((n) => n)
      .join('\n');
    if (!txt) {
      showToast('Pauta vazia — nada para copiar.');
      return;
    }
    void copyToClipboard(txt, `Copiado: ${pauta.itens.length} processo(s).`);
  });
  toolbar.appendChild(btnCopy);

  const btnCsv = buildBtn('Baixar CSV', () => {
    baixarCsvPauta(pauta);
  });
  toolbar.appendChild(btnCsv);

  // Toggle "favoritar a etiqueta após criar" — opt-in. Quando a etiqueta
  // já existir no PJe, o flag é ignorado pelo applier (só favorita criação
  // nova). Ver pericias-etiqueta-applier.ts#aplicarEtiquetaEmLote.
  const favWrap = el('label', 'apply-fav-toggle');
  const favInput = document.createElement('input');
  favInput.type = 'checkbox';
  favInput.id = `fav-${pauta.peritoId}`;
  const favText = document.createElement('span');
  favText.textContent = 'Favoritar etiqueta (se for criada agora)';
  favWrap.append(favInput, favText);
  favWrap.setAttribute('for', favInput.id);
  toolbar.appendChild(favWrap);

  const btnApply = buildBtn('Aplicar etiquetas', () => {
    void handleAplicarEtiquetas(pauta, statusHolder, btnApply, favInput.checked);
  });
  btnApply.classList.add('primary');
  if (pauta.itens.length === 0) btnApply.disabled = true;
  toolbar.appendChild(btnApply);

  card.appendChild(toolbar);

  // Tabela de processos
  if (pauta.itens.length === 0) {
    card.appendChild(textEl('p', 'vazio', 'Nenhum processo entrou nesta pauta.'));
  } else {
    card.appendChild(wrapScroll(buildTabela(pauta.itens)));
  }

  return card;
}

function buildTabela(itens: PericiaPautaItem[]): HTMLElement {
  const tbl = el('table', 'tbl') as HTMLTableElement;
  const thead = el('thead');
  const trh = el('tr');
  for (const h of [
    '#',
    'Processo',
    'Classe',
    'Assunto principal',
    'Polo ativo',
    'Chegada na tarefa',
    'Tarefa',
    'Etiqueta-fonte',
    'Etiquetas do processo',
    ''
  ]) {
    trh.appendChild(textEl('th', '', h));
  }
  thead.appendChild(trh);
  tbl.appendChild(thead);

  const tbody = el('tbody');
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i];
    const tr = el('tr');
    tr.dataset.idProcesso = String(it.idProcesso);
    if (rt.excluidosRuntime.has(it.idProcesso)) {
      tr.classList.add('is-excluded');
    }
    tr.appendChild(textEl('td', '', String(i + 1)));

    const tdProc = el('td');
    tdProc.appendChild(buildProcCell(it));
    tr.appendChild(tdProc);

    tr.appendChild(textEl('td', '', it.classeJudicial ?? '—'));
    tr.appendChild(textEl('td', '', it.assuntoPrincipal ?? '—'));
    tr.appendChild(textEl('td', '', it.poloAtivo ?? '—'));
    tr.appendChild(textEl('td', '', formatarData(it.dataChegadaTarefa)));
    tr.appendChild(textEl('td', '', it.tarefaNome));

    const tdTag = el('td');
    if (it.etiquetaOrigemNome) {
      tdTag.appendChild(textEl('span', 'tag-origem', it.etiquetaOrigemNome));
    } else {
      tdTag.textContent = '—';
    }
    tr.appendChild(tdTag);

    tr.appendChild(buildTdEtiquetasProcesso(it.etiquetasProcesso));
    tr.appendChild(buildTdRemover(it.idProcesso, tr));

    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  return tbl;
}

function buildTdEtiquetasProcesso(etiquetas: string[] | undefined): HTMLElement {
  const td = el('td');
  const lista = Array.isArray(etiquetas) ? etiquetas : [];
  if (lista.length === 0) {
    td.textContent = '—';
    return td;
  }
  const wrap = el('div', 'etiquetas-cell');
  for (const nome of lista) {
    const chip = el('span', 'etiqueta-chip');
    chip.textContent = nome;
    chip.title = nome;
    wrap.appendChild(chip);
  }
  td.appendChild(wrap);
  return td;
}

function buildTdRemover(idProcesso: number, tr: HTMLElement): HTMLElement {
  const td = el('td', 'td-remover');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-remover';
  btn.title = 'Excluir este processo da pauta';
  btn.setAttribute('aria-label', 'Excluir este processo da pauta');
  btn.textContent = '×';
  const sincronizar = (): void => {
    const excluido = rt.excluidosRuntime.has(idProcesso);
    tr.classList.toggle('is-excluded', excluido);
    btn.textContent = excluido ? '↺' : '×';
    btn.title = excluido
      ? 'Desfazer exclusão'
      : 'Excluir este processo da pauta';
    sincronizarBotaoAtualizar();
  };
  sincronizar();
  btn.addEventListener('click', () => {
    if (rt.excluidosRuntime.has(idProcesso)) {
      rt.excluidosRuntime.delete(idProcesso);
    } else {
      rt.excluidosRuntime.add(idProcesso);
    }
    sincronizar();
  });
  td.appendChild(btn);
  return td;
}

function sincronizarBotaoAtualizar(): void {
  const btn = document.getElementById('btn-atualizar-pauta') as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = rt.atualizando || rt.excluidosRuntime.size === 0;
  btn.textContent = rt.atualizando
    ? 'Atualizando...'
    : rt.excluidosRuntime.size > 0
      ? `Atualizar pauta (${rt.excluidosRuntime.size} exclus${rt.excluidosRuntime.size === 1 ? 'ão' : 'ões'})`
      : 'Atualizar pauta';
}

/**
 * Célula do número do processo: hiperlink para os autos + botão
 * separado para copiar o CNJ (padrão pAIdegua).
 */
function buildProcCell(it: PericiaPautaItem): HTMLElement {
  const wrap = el('span', 'proc-cell');
  const cnj = extractCNJ(it.numeroProcesso ?? '');
  const label = it.numeroProcesso || '(sem número)';

  if (it.url) {
    const a = document.createElement('a');
    a.className = 'proc-link';
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'Abrir autos em nova guia';
    a.textContent = label;
    wrap.appendChild(a);
  } else {
    const span = el('span', 'proc-link proc-link--disabled');
    span.textContent = label;
    span.title = 'Link dos autos não resolvido';
    wrap.appendChild(span);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'proc-copy';
  btn.title = 'Copiar número do processo';
  btn.setAttribute('aria-label', `Copiar número do processo ${cnj}`);
  btn.innerHTML = COPY_ICON_SVG;
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (cnj) void copyToClipboard(cnj, `Número copiado: ${cnj}`);
  });
  wrap.appendChild(btn);

  return wrap;
}

// =====================================================================
// Resíduo: não distribuídos
// =====================================================================

function buildResiduo(itens: PericiaPautaItem[]): HTMLElement {
  const sec = el('section', 'section');
  sec.appendChild(textEl('h2', '', `Processos fora da pauta (${itens.length})`));
  sec.appendChild(
    textEl(
      'p',
      'section__hint',
      'Nenhuma etiqueta destes processos corresponde a uma etiqueta vinculada ' +
        'aos peritos selecionados. Eles ficam fora da distribuição — reserve-os ' +
        'para ajuste manual ou para uma nova pauta com mais peritos/etiquetas.'
    )
  );
  sec.appendChild(wrapScroll(buildTabelaResiduo(itens)));
  return sec;
}

function buildTabelaResiduo(itens: PericiaPautaItem[]): HTMLElement {
  const tbl = el('table', 'tbl') as HTMLTableElement;
  const thead = el('thead');
  const trh = el('tr');
  for (const h of [
    '#',
    'Processo',
    'Classe',
    'Assunto',
    'Chegada',
    'Tarefa',
    'Etiquetas do processo',
    ''
  ]) {
    trh.appendChild(textEl('th', '', h));
  }
  thead.appendChild(trh);
  tbl.appendChild(thead);
  const tbody = el('tbody');
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i];
    const tr = el('tr');
    tr.dataset.idProcesso = String(it.idProcesso);
    if (rt.excluidosRuntime.has(it.idProcesso)) tr.classList.add('is-excluded');
    tr.appendChild(textEl('td', '', String(i + 1)));
    const tdProc = el('td');
    tdProc.appendChild(buildProcCell(it));
    tr.appendChild(tdProc);
    tr.appendChild(textEl('td', '', it.classeJudicial ?? '—'));
    tr.appendChild(textEl('td', '', it.assuntoPrincipal ?? '—'));
    tr.appendChild(textEl('td', '', formatarData(it.dataChegadaTarefa)));
    tr.appendChild(textEl('td', '', it.tarefaNome));
    tr.appendChild(buildTdEtiquetasProcesso(it.etiquetasProcesso));
    tr.appendChild(buildTdRemover(it.idProcesso, tr));
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  return tbl;
}

// =====================================================================
// Ação: Aplicar etiquetas
// =====================================================================

async function handleAplicarEtiquetas(
  pauta: PericiaPauta,
  statusHolder: HTMLElement,
  btn: HTMLButtonElement,
  favoritarAposCriar: boolean
): Promise<void> {
  if (pauta.itens.length === 0) return;
  const sufixoFav = favoritarAposCriar
    ? '\n\nSe a etiqueta precisar ser criada agora, ela também será marcada como favorita.'
    : '';
  const confirma = window.confirm(
    `Aplicar a etiqueta "${pauta.etiquetaPauta}" aos ${pauta.itens.length} ` +
      `processo(s) da pauta de ${pauta.peritoNomeCompleto}?\n\n` +
      'A etiqueta será criada no PJe caso ainda não exista.' +
      sufixoFav
  );
  if (!confirma) return;

  btn.disabled = true;
  const status = el('p', 'apply-status');
  status.textContent = 'Enviando pedido ao PJe...';
  statusHolder.replaceChildren(status);

  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PERICIAS_APLICAR_ETIQUETAS,
      payload: {
        etiquetaPauta: pauta.etiquetaPauta,
        idsProcesso: pauta.itens.map((it) => it.idProcesso),
        favoritarAposCriar
      }
    });
    if (!resp?.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao aplicar etiquetas.';
      status.classList.add('err');
      status.textContent = msg;
    } else {
      status.classList.add('ok');
      const aplicadas = resp.aplicadas ?? pauta.itens.length;
      status.textContent = `Etiqueta "${pauta.etiquetaPauta}" aplicada em ${aplicadas} processo(s).`;
    }
  } catch (err) {
    status.classList.add('err');
    status.textContent = `Erro ao contactar o PJe: ${errorMessage(err)}`;
  } finally {
    btn.disabled = false;
  }
}

// =====================================================================
// CSV
// =====================================================================

function baixarCsvPauta(pauta: PericiaPauta): void {
  if (pauta.itens.length === 0) {
    showToast('Pauta vazia — nada para exportar.');
    return;
  }
  const colunas = [
    'Ordem',
    'Numero CNJ',
    'Classe',
    'Assunto principal',
    'Polo ativo',
    'Chegada na tarefa',
    'Tarefa',
    'Etiqueta-fonte',
    'Etiquetas do processo'
  ];
  const linhas = pauta.itens.map((it, i) => [
    String(i + 1),
    extractCNJ(it.numeroProcesso ?? '') || (it.numeroProcesso ?? ''),
    it.classeJudicial ?? '',
    it.assuntoPrincipal ?? '',
    it.poloAtivo ?? '',
    formatarData(it.dataChegadaTarefa),
    it.tarefaNome,
    it.etiquetaOrigemNome,
    Array.isArray(it.etiquetasProcesso) ? it.etiquetasProcesso.join(' | ') : ''
  ]);
  const csv = [colunas, ...linhas].map((row) => row.map(csvCell).join(';')).join('\r\n');
  // BOM para o Excel abrir com acentos corretos.
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pauta-${sanitizeFilename(pauta.peritoNomeEtiquetaPauta)}-${stamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(v: string): string {
  const s = (v ?? '').replace(/"/g, '""');
  if (/[;"\r\n]/.test(s)) return `"${s}"`;
  return s;
}

function sanitizeFilename(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'pauta';
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

// =====================================================================
// Helpers
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

function buildBtn(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function wrapScroll(inner: HTMLElement): HTMLElement {
  const box = el('div', 'tbl-wrap');
  box.appendChild(inner);
  return box;
}

function extractCNJ(raw: string): string {
  if (!raw) return '';
  const m = raw.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  return m ? m[0] : raw.trim();
}

function formatarData(raw: string | null): string {
  if (!raw) return '—';
  const trimmed = raw.trim();
  if (!trimmed) return '—';
  // Epoch em milissegundos (ex.: "1775052742280"). O PJe por vezes devolve
  // a data como timestamp numérico puro — sem esse branch, Date.parse
  // retorna NaN e a UI mostra o número cru.
  if (/^\d{10,}$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return new Date(n).toLocaleDateString('pt-BR');
  }
  const d = Date.parse(trimmed);
  if (!Number.isNaN(d)) return new Date(d).toLocaleDateString('pt-BR');
  const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  return trimmed;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function copyToClipboard(text: string, msgOk: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msgOk);
  } catch (err) {
    console.error(`${LOG} falha ao copiar:`, err);
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

// =====================================================================
// Atualizar pauta (re-execução com exclusões)
// =====================================================================

async function acionarAtualizarPauta(): Promise<void> {
  if (rt.atualizando) return;
  if (!rt.payload) return;
  if (rt.excluidosRuntime.size === 0) return;

  const entrada = rt.payload.entrada;
  if (
    !entrada ||
    !Array.isArray(entrada.nomesTarefas) ||
    !Array.isArray(entrada.peritos) ||
    !entrada.dataPericiaISO
  ) {
    showToast(
      'Esta pauta foi gerada por uma versão anterior e não tem os dados ' +
        'necessários para refazer. Gere uma nova pauta a partir do PJe.'
    );
    return;
  }

  const confirma = window.confirm(
    `Refazer a pauta excluindo ${rt.excluidosRuntime.size} processo(s) marcado(s)?\n\n` +
      'A data da perícia e os peritos permanecem os mesmos da pauta original.'
  );
  if (!confirma) return;

  // União das exclusões antigas (do próprio payload) com as novas.
  const totalExclusoes = new Set<number>(entrada.excluirIds ?? []);
  for (const id of rt.excluidosRuntime) totalExclusoes.add(id);

  rt.atualizando = true;
  sincronizarBotaoAtualizar();
  iniciarOverlayProgresso('Solicitando nova varredura ao PJe...');

  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PERICIAS_START_COLETA,
      payload: {
        requestId: rt.rid,
        nomes: entrada.nomesTarefas,
        peritosSelecionados: entrada.peritos,
        dataPericiaISO: entrada.dataPericiaISO,
        excluirIds: Array.from(totalExclusoes)
      }
    });
    if (!resp?.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao refazer a pauta.';
      encerrarOverlayProgresso(msg, true);
    }
    // Sucesso: o listener de PERICIAS_COLETA_READY vai recarregar a aba.
  } catch (err) {
    encerrarOverlayProgresso(
      'Erro de comunicação ao refazer a pauta: ' + errorMessage(err),
      true
    );
  }
}

function iniciarOverlayProgresso(msgInicial: string): void {
  let overlay = document.getElementById('overlay-atualizar');
  if (!overlay) {
    overlay = el('div', 'overlay');
    overlay.id = 'overlay-atualizar';
    const box = el('div', 'overlay__box');
    const titulo = textEl('h3', 'overlay__titulo', 'Atualizando a pauta...');
    const texto = el('p', 'overlay__msg');
    texto.id = 'overlay-msg';
    texto.textContent = msgInicial;
    const hint = textEl(
      'p',
      'overlay__hint',
      'Não feche esta aba — a pauta recarrega automaticamente ao terminar.'
    );
    box.append(titulo, texto, hint);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  } else {
    const texto = document.getElementById('overlay-msg');
    if (texto) texto.textContent = msgInicial;
  }
  overlay.classList.remove('overlay--error');
  overlay.classList.add('overlay--visible');
}

function atualizarOverlayProgresso(msg: string): void {
  const texto = document.getElementById('overlay-msg');
  if (texto && msg) texto.textContent = msg;
}

function encerrarOverlayProgresso(msgFinal: string, erro: boolean): void {
  rt.atualizando = false;
  sincronizarBotaoAtualizar();
  const overlay = document.getElementById('overlay-atualizar');
  if (!overlay) {
    if (erro) showToast(msgFinal);
    return;
  }
  if (erro) {
    overlay.classList.add('overlay--error');
    const texto = document.getElementById('overlay-msg');
    if (texto) texto.textContent = msgFinal;
    const titulo = overlay.querySelector('.overlay__titulo');
    if (titulo) titulo.textContent = 'Falha ao atualizar';
    const box = overlay.querySelector('.overlay__box');
    if (box && !overlay.querySelector('.overlay__btn-fechar')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn overlay__btn-fechar';
      btn.textContent = 'Fechar';
      btn.addEventListener('click', () => overlay.classList.remove('overlay--visible'));
      box.appendChild(btn);
    }
    return;
  }
  overlay.classList.remove('overlay--visible');
}

// =====================================================================

const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';
