/**
 * Dashboard "Validação de cadastro" — página estática da extensão.
 *
 * Recebe o payload via `chrome.storage.session`
 * (`STORAGE_KEYS.VALIDACAO_CADASTRO_DASHBOARD_PAYLOAD`) e renderiza:
 *   - Métricas (regulares / com apontamentos / não lidos);
 *   - Distribuição por tipo de irregularidade;
 *   - Processos com apontamentos (chips das irregularidades + botões);
 *   - Cadastros regulares (selo "Cadastro OK");
 *   - Processos não lidos (erro de coleta).
 *
 * Sem IA: as regras são determinísticas e já vieram avaliadas do content
 * script. O botão "Encaminhar para minutar sentença" (com minuta + movimento
 * 459) é da Fase 3 — não aparece aqui ainda.
 */

import { MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import {
  abrirTarefaPopup,
  OPEN_TASK_ICON_SVG,
  podeAbrirTarefa
} from '../shared/pje-task-popup';
import type {
  IrregularidadeCadastro,
  IrregularidadeId
} from '../shared/validacao-cadastro-regras';
import { montarMinutaValidacao } from '../shared/validacao-minuta';
import { renderForPJe } from '../content/ui/markdown';
import type {
  ValidacaoCadastroDashboardPayload,
  ValidacaoCadastroProcesso
} from '../shared/types';
import { attachExcelButton, type ExcelColumn } from '../shared/xlsx-export';

void main();

async function main(): Promise<void> {
  const mainEl = document.getElementById('main') as HTMLElement;
  const meta = document.getElementById('meta') as HTMLElement;
  try {
    const payload = await loadPayload();
    if (!payload) {
      mainEl.innerHTML =
        '<p class="loading">Nenhum dado de validação encontrado. ' +
        'Volte ao painel do PJe e clique em "Validação de cadastro" novamente.</p>';
      meta.textContent = '';
      return;
    }
    renderMeta(meta, payload);
    renderDashboard(mainEl, payload);
  } catch (err) {
    console.error('[pAIdegua validacao] falha ao montar:', err);
    mainEl.innerHTML = `<p class="loading">Erro ao montar o relatório: ${escapeHtml(
      err instanceof Error ? err.message : String(err)
    )}</p>`;
  }
}

async function loadPayload(): Promise<ValidacaoCadastroDashboardPayload | null> {
  const out = await chrome.storage.session.get(
    STORAGE_KEYS.VALIDACAO_CADASTRO_DASHBOARD_PAYLOAD
  );
  const raw = out[STORAGE_KEYS.VALIDACAO_CADASTRO_DASHBOARD_PAYLOAD];
  if (!raw) return null;
  return raw as ValidacaoCadastroDashboardPayload;
}

// =====================================================================
// Meta / cabeçalho
// =====================================================================

function renderMeta(meta: HTMLElement, payload: ValidacaoCadastroDashboardPayload): void {
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
    `<div>${payload.totalProcessos} processo(s) analisado(s)</div>`;
}

function extractUnidadeJudicial(payload: ValidacaoCadastroDashboardPayload): string {
  for (const p of payload.processos) {
    const raw = (p.orgao || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const segs = raw.split('/').map((s) => s.trim()).filter(Boolean);
    const vara = segs.find((s) => /\bvara\b/i.test(s));
    if (vara) return vara;
    if (segs[0]) return segs[0];
  }
  return payload.hostnamePJe;
}

// =====================================================================
// Dashboard
// =====================================================================

function renderDashboard(root: HTMLElement, payload: ValidacaoCadastroDashboardPayload): void {
  root.innerHTML = '';

  const irregulares = payload.processos.filter((p) => p.status === 'irregular');
  const regulares = payload.processos.filter((p) => p.status === 'ok');
  const erros = payload.processos.filter((p) => p.status === 'erro');

  root.appendChild(buildMetrics(payload));

  if (irregulares.length > 0) {
    root.appendChild(buildDistribuicao(irregulares));
    root.appendChild(buildIrregulares(irregulares));
  } else {
    const sec = section('Nenhuma irregularidade encontrada');
    setHint(sec, 'Todos os processos lidos estão com o cadastro regular. 🎉');
    root.appendChild(sec);
  }

  root.appendChild(buildRegulares(regulares));

  if (erros.length > 0) {
    root.appendChild(buildErros(erros));
  }
}

// =====================================================================
// Métricas
// =====================================================================

function buildMetrics(payload: ValidacaoCadastroDashboardPayload): HTMLElement {
  const wrap = el('section', 'metrics');
  wrap.append(
    metric('Processos analisados', String(payload.totalProcessos)),
    metric('Cadastro regular', String(payload.totalOk), pct(payload.totalOk, payload.totalProcessos), 'ok'),
    metric('Com apontamentos', String(payload.totalIrregular), pct(payload.totalIrregular, payload.totalProcessos), 'irregular'),
    metric('Não lidos', String(payload.totalErro), pct(payload.totalErro, payload.totalProcessos))
  );
  return wrap;
}

function metric(
  label: string,
  value: string,
  hint?: string,
  variant?: 'ok' | 'irregular'
): HTMLElement {
  const card = el('div', 'metric');
  card.appendChild(elText('div', 'metric__label', label));
  const val = elText(
    'div',
    'metric__value' + (variant ? ` metric__value--${variant}` : ''),
    value
  );
  card.appendChild(val);
  if (hint) card.appendChild(elText('div', 'metric__hint', hint));
  return card;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0% do total';
  return `${Math.round((n / total) * 100)}% do total`;
}

// =====================================================================
// Distribuição por tipo de irregularidade
// =====================================================================

function buildDistribuicao(irregulares: ValidacaoCadastroProcesso[]): HTMLElement {
  const sec = section('Distribuição por tipo de irregularidade');
  setHint(sec, 'Quantos processos apresentam cada apontamento (um processo pode ter mais de um).');

  const map = new Map<IrregularidadeId, { titulo: string; count: number }>();
  for (const p of irregulares) {
    for (const irr of p.irregularidades) {
      const cur = map.get(irr.id);
      if (cur) cur.count += 1;
      else map.set(irr.id, { titulo: irr.titulo, count: 1 });
    }
  }
  const ord = Array.from(map.values()).sort((a, b) => b.count - a.count);
  const max = ord[0]?.count ?? 1;

  const list = el('div', 'barlist');
  for (const item of ord) {
    const row = el('div', 'barlist__row');
    const lab = el('div', 'barlist__label');
    const bar = el('div', 'barlist__bar');
    bar.style.width = `${(item.count / max) * 100}%`;
    lab.appendChild(bar);
    lab.appendChild(document.createTextNode(item.titulo));
    row.appendChild(lab);
    row.appendChild(elText('div', 'barlist__count', String(item.count)));
    list.appendChild(row);
  }
  sec.appendChild(list);
  return sec;
}

// =====================================================================
// Processos com apontamentos
// =====================================================================

function buildIrregulares(irregulares: ValidacaoCadastroProcesso[]): HTMLElement {
  const sec = section('Processos com apontamentos de cadastro');
  setHint(sec, 'Cada processo abaixo tem ao menos uma irregularidade cadastral. Passe o mouse sobre um apontamento para ver o detalhe.');

  const table = document.createElement('table');
  table.className = 'proc-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Processo</th>
        <th>Tarefa</th>
        <th>Apontamentos</th>
        <th>Ação</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody') as HTMLElement;
  for (const p of irregulares) {
    const tr = document.createElement('tr');
    tr.appendChild(tdProcNum(p));
    tr.appendChild(tdText(p.tarefaNome));
    tr.appendChild(tdIrregularidades(p.irregularidades));
    tr.appendChild(tdAcaoMinutar(p));
    tbody.appendChild(tr);
  }
  sec.appendChild(wrapScroll(table));

  attachCopyButton(sec, () => procsToText(irregulares), 'Copiar lista de processos');
  attachExcelButton(
    sec,
    () => irregulares,
    COLUNAS_EXCEL,
    'validacao_apontamentos',
    { label: 'Baixar lista em Excel', sheetName: 'Apontamentos', onToast: showToast }
  );
  return sec;
}

function tdIrregularidades(irrs: IrregularidadeCadastro[]): HTMLElement {
  const td = document.createElement('td');
  const list = el('div', 'irreg-list');
  for (const irr of irrs) {
    const chip = elText('span', `irreg-chip irreg-chip--${irr.gravidade}`, irr.titulo);
    chip.title = irr.detalhe;
    list.appendChild(chip);
  }
  td.appendChild(list);
  return td;
}

function tdAcaoMinutar(p: ValidacaoCadastroProcesso): HTMLElement {
  const td = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'minutar-btn';
  btn.textContent = 'Minutar sentença';
  btn.title = 'Gerar a minuta de sentença de extinção e inseri-la no editor do PJe';
  btn.addEventListener('click', () => abrirModalMinuta(p));
  td.appendChild(btn);
  return td;
}

// =====================================================================
// Modal da minuta de sentença
// =====================================================================

let modalOverlay: HTMLElement | null = null;

function fecharModal(): void {
  if (modalOverlay) {
    modalOverlay.remove();
    modalOverlay = null;
  }
}

/**
 * Abre o modal com a minuta de sentença de extinção (art. 485 CPC) montada a
 * partir das irregularidades do processo. Oferece copiar, inserir no editor
 * do PJe e abrir a tarefa. O movimento 459 e o encaminhamento à tarefa
 * "minutar sentença" são manuais nesta versão (automação = Fase 4).
 */
function abrirModalMinuta(p: ValidacaoCadastroProcesso): void {
  fecharModal();
  const minuta = montarMinutaValidacao(p.irregularidades);
  const cnj = extractCNJ(p.numeroProcesso);

  const overlay = el('div', 'modal-overlay');
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) fecharModal();
  });

  const box = el('div', 'modal-box');

  const head = el('div', 'modal-head');
  head.appendChild(elText('h2', 'modal-title', 'Minuta de sentença — extinção (art. 485 do CPC)'));
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', 'Fechar');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', fecharModal);
  head.appendChild(closeBtn);
  box.appendChild(head);

  box.appendChild(elText('p', 'modal-sub', `Processo ${cnj} · ${p.tarefaNome}`));

  const aviso = el('div', 'modal-aviso');
  aviso.innerHTML =
    'Para inserir, deixe a tela de <strong>minutar peça</strong> do PJe aberta em outra aba. ' +
    'O lançamento do <strong>movimento 459</strong> e o encaminhamento à tarefa ainda são manuais nesta versão.';
  box.appendChild(aviso);

  const preview = el('div', 'modal-preview');
  preview.textContent = minuta.plain;
  box.appendChild(preview);

  // HTML no formato do editor Badon do PJe (parágrafos bd-def-pp, citação
  // bd-def-citacao recuada) — usado tanto na inserção quanto na cópia rica.
  const html = renderForPJe(minuta.markdown);

  const actions = el('div', 'modal-actions');

  const btnCopiar = modalButton('Copiar minuta', 'modal-btn');
  btnCopiar.addEventListener('click', () => {
    void copiarMinuta(html, minuta.plain);
  });
  actions.appendChild(btnCopiar);

  const btnInserir = modalButton('Inserir no PJe', 'modal-btn modal-btn--primary');
  btnInserir.addEventListener('click', () => {
    void inserirMinutaNoPje(html, minuta.plain, btnInserir);
  });
  actions.appendChild(btnInserir);

  if (podeAbrirTarefa(p.idProcesso, p.idTaskInstance) && p.url) {
    const btnTarefa = modalButton('Abrir tarefa no PJe', 'modal-btn');
    btnTarefa.addEventListener('click', () => {
      const ok = abrirTarefaPopup({
        idProcesso: p.idProcesso,
        idTaskInstance: p.idTaskInstance!,
        referenciaUrlAutos: p.url
      });
      if (!ok) showToast('Não foi possível abrir a tarefa (popup bloqueado?).');
    });
    actions.appendChild(btnTarefa);
  }

  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  modalOverlay = overlay;
}

function modalButton(label: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  return btn;
}

/**
 * Copia a minuta preservando o recuo: grava HTML (com a citação recuada) e
 * texto plano na área de transferência. Ao colar em editor rico (PJe/Word) o
 * recuo é mantido; em destino de texto puro, cai no `plain` (citação com tab).
 */
async function copiarMinuta(html: string, plain: string): Promise<void> {
  try {
    const cw = navigator.clipboard as unknown as {
      write?: (items: ClipboardItem[]) => Promise<void>;
    };
    if (typeof ClipboardItem !== 'undefined' && cw.write) {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' })
      });
      await cw.write([item]);
    } else {
      await navigator.clipboard.writeText(plain);
    }
    showToast('Minuta copiada para a área de transferência.');
  } catch (err) {
    try {
      await navigator.clipboard.writeText(plain);
      showToast('Minuta copiada (texto).');
    } catch {
      console.error('[pAIdegua validacao] falha ao copiar minuta:', err);
      showToast('Não foi possível copiar a minuta.');
    }
  }
}

async function inserirMinutaNoPje(
  html: string,
  plain: string,
  btn: HTMLButtonElement
): Promise<void> {
  const rotulo = btn.textContent ?? 'Inserir no PJe';
  btn.disabled = true;
  btn.textContent = 'Inserindo...';
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.INSERT_IN_PJE_EDITOR,
      payload: { html, plain, actionId: '' }
    })) as { ok: boolean; error?: string };
    if (resp?.ok) {
      showToast('Minuta inserida no editor do PJe.');
    } else {
      showToast(
        resp?.error ??
          'Nenhum editor encontrado. Abra a tela de minutar peça no PJe e tente novamente.'
      );
    }
  } catch (err) {
    showToast(`Falha ao inserir: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = rotulo;
  }
}

// =====================================================================
// Cadastros regulares
// =====================================================================

function buildRegulares(regulares: ValidacaoCadastroProcesso[]): HTMLElement {
  const sec = section('Cadastros regulares');
  if (regulares.length === 0) {
    setHint(sec, 'Nenhum processo com cadastro regular nesta varredura.');
    return sec;
  }
  setHint(sec, 'Processos sem apontamentos — cadastro conforme as regras verificadas.');

  const table = document.createElement('table');
  table.className = 'proc-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Processo</th>
        <th>Tarefa</th>
        <th>Situação</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody') as HTMLElement;
  for (const p of regulares) {
    const tr = document.createElement('tr');
    tr.appendChild(tdProcNum(p));
    tr.appendChild(tdText(p.tarefaNome));
    const tdSit = document.createElement('td');
    tdSit.appendChild(elText('span', 'val-badge val-badge--ok', '✓ Cadastro OK'));
    tr.appendChild(tdSit);
    tbody.appendChild(tr);
  }
  sec.appendChild(wrapScroll(table));
  attachCopyButton(sec, () => procsToText(regulares), 'Copiar lista de processos');
  attachExcelButton(
    sec,
    () => regulares,
    COLUNAS_EXCEL,
    'validacao_regulares',
    { label: 'Baixar lista em Excel', sheetName: 'Regulares', onToast: showToast }
  );
  return sec;
}

// =====================================================================
// Não lidos (erro)
// =====================================================================

function buildErros(erros: ValidacaoCadastroProcesso[]): HTMLElement {
  const sec = section('Processos não lidos');
  setHint(sec, 'Não foi possível baixar os autos destes processos — verifique manualmente.');

  const table = document.createElement('table');
  table.className = 'proc-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Processo</th>
        <th>Tarefa</th>
        <th>Motivo</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody') as HTMLElement;
  for (const p of erros) {
    const tr = document.createElement('tr');
    tr.appendChild(tdProcNum(p));
    tr.appendChild(tdText(p.tarefaNome));
    const tdMotivo = document.createElement('td');
    tdMotivo.className = 'erro-cell';
    tdMotivo.textContent = p.erro ?? 'Erro desconhecido.';
    tr.appendChild(tdMotivo);
    tbody.appendChild(tr);
  }
  sec.appendChild(wrapScroll(table));
  attachCopyButton(sec, () => procsToText(erros), 'Copiar lista de processos');
  return sec;
}

// =====================================================================
// Excel
// =====================================================================

const COLUNAS_EXCEL: ExcelColumn<ValidacaoCadastroProcesso>[] = [
  { header: 'Número CNJ', key: (p) => extractCNJ(p.numeroProcesso), type: 'string', width: 28 },
  { header: 'Tarefa', key: 'tarefaNome', type: 'string', width: 26 },
  { header: 'Assunto', key: 'assunto', type: 'string', width: 30 },
  { header: 'Órgão', key: 'orgao', type: 'string', width: 28 },
  { header: 'Valor da causa', key: (p) => p.valorCausaTexto ?? '', type: 'string', width: 16 },
  {
    header: 'Situação',
    key: (p) =>
      p.status === 'ok' ? 'Regular' : p.status === 'irregular' ? 'Com apontamentos' : 'Não lido',
    type: 'string',
    width: 18
  },
  {
    header: 'Irregularidades',
    key: (p) => p.irregularidades.map((i) => i.titulo).join('; '),
    type: 'string',
    width: 50
  }
];

// =====================================================================
// Helpers de tabela / célula de processo
// =====================================================================

function tdProcNum(p: ValidacaoCadastroProcesso): HTMLElement {
  const td = document.createElement('td');
  td.className = 'num';
  td.appendChild(procNumberSpan(p));
  return td;
}

/**
 * Renderiza o número como hiperlink para os autos + botão copiar CNJ +
 * (quando possível) botão abrir tarefa. Padrão dos demais relatórios.
 */
function procNumberSpan(p: ValidacaoCadastroProcesso): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'proc-cell';
  const cnj = extractCNJ(p.numeroProcesso);
  const label = p.numeroProcesso || '(sem número)';

  let mainEl: HTMLElement;
  if (p.url) {
    const a = document.createElement('a');
    a.className = 'proc-link';
    a.href = p.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'Abrir processo em nova guia';
    a.textContent = label;
    mainEl = a;
  } else {
    const span = document.createElement('span');
    span.className = 'proc-link proc-link--disabled';
    span.textContent = label;
    span.title = 'Link dos autos indisponível';
    mainEl = span;
  }
  wrap.appendChild(mainEl);

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

function extractCNJ(raw: string): string {
  if (!raw) return raw;
  const m = raw.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  return m ? m[0] : raw.trim();
}

function procsToText(procs: ValidacaoCadastroProcesso[]): string {
  return procs
    .map((p) => extractCNJ(p.numeroProcesso))
    .filter((n) => n && n.trim())
    .join('\n');
}

// =====================================================================
// Helpers genéricos (DOM, toast, cópia)
// =====================================================================

function el(tag: string, className = ''): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function elText(tag: string, className: string, text: string): HTMLElement {
  const e = el(tag, className);
  e.textContent = text;
  return e;
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

function wrapScroll(inner: HTMLElement): HTMLElement {
  const box = el('div', 'scroll-limit');
  box.appendChild(inner);
  return box;
}

const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';

function attachCopyButton(sec: HTMLElement, getText: () => string, label: string): void {
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

async function copyToClipboard(text: string, msgOk: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msgOk);
  } catch (err) {
    console.error('[pAIdegua validacao] falha ao copiar:', err);
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
