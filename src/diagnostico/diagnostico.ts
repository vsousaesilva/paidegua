/**
 * Página de diagnóstico — renderiza o histórico local de varreduras
 * (gravado por `shared/telemetry.ts`). Não faz chamadas ao PJe nem à
 * rede: toda a informação vem de `chrome.storage.local`.
 *
 * Isolamento: é uma página web_accessible da extensão, aberta em aba
 * nova pelo popup. Nenhum caminho de coleta depende desta página.
 */

import {
  clearScans,
  listRecentScans,
  type ScanPhaseRecord,
  type ScanRecord
} from '../shared/telemetry';

/* ---------------------------- formatação ----------------------------- */

const fmtDateTime = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

function formatClock(ts: number): string {
  try {
    return fmtDateTime.format(new Date(ts));
  } catch {
    return String(ts);
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m} min ${String(rs).padStart(2, '0')} s`;
}

function kindLabel(kind: ScanRecord['kind']): string {
  switch (kind) {
    case 'painel-gerencial':
      return 'Painel Gerencial';
    case 'prazos-fita':
      return 'Prazos na Fita';
    case 'prazos-simples':
      return 'Prazos (simples)';
    case 'triagem':
      return 'Triagem';
    default:
      return 'Outro';
  }
}

function statusLabel(status: ScanRecord['status']): string {
  switch (status) {
    case 'ok':
      return 'sucesso';
    case 'error':
      return 'erro';
    case 'running':
      return 'em andamento';
    case 'canceled':
      return 'cancelada';
    default:
      return String(status);
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.map((x) => String(x)).join(', ');
  if (typeof v === 'number') return new Intl.NumberFormat('pt-BR').format(v);
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  return String(v);
}

/* ------------------------------ DOM ---------------------------------- */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function renderKv(rec: ScanRecord): HTMLElement | null {
  const entries = Object.entries(rec.meta).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return null;
  const box = el('div', { class: 'diag-kv' });
  for (const [k, v] of entries) {
    const item = el('div');
    item.appendChild(el('span', { class: 'diag-kv__key' }, `${k}:`));
    item.appendChild(el('span', { class: 'diag-kv__value' }, formatValue(v)));
    box.appendChild(item);
  }
  return box;
}

function renderCounters(rec: ScanRecord): HTMLElement | null {
  const entries = Object.entries(rec.counters);
  if (entries.length === 0) return null;
  const box = el('div', { class: 'diag-counters' });
  const warnSet = new Set([
    'fallback-dom',
    'tarefas-truncadas',
    'auth-expired',
    'ca-erros',
    'tarefas-listar-erro',
    'processos-omitidos'
  ]);
  for (const [k, v] of entries) {
    const cls = 'diag-counter' + (warnSet.has(k) ? ' diag-counter--warn' : '');
    box.appendChild(el('span', { class: cls }, `${k}: ${formatValue(v)}`));
  }
  return box;
}

function renderPhases(phases: ScanPhaseRecord[]): HTMLElement | null {
  if (phases.length === 0) return null;
  const box = el('div', { class: 'diag-phases' });
  box.appendChild(el('p', { class: 'diag-phases__title' }, 'Fases'));
  for (const p of phases) {
    const row = el('div', { class: 'diag-phase' });
    row.appendChild(el('span', { class: 'diag-phase__name' }, p.name));
    row.appendChild(
      el('span', { class: 'diag-phase__duration' }, formatDuration(p.durationMs))
    );
    if (p.extra && Object.keys(p.extra).length > 0) {
      const pairs = Object.entries(p.extra)
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(' · ');
      row.appendChild(el('span', { class: 'diag-phase__extra' }, pairs));
    }
    box.appendChild(row);
  }
  return box;
}

function renderCard(rec: ScanRecord): HTMLElement {
  const card = el('div', { class: 'diag-card' });

  const head = el('div', { class: 'diag-card__head' });
  head.appendChild(el('span', { class: 'diag-card__kind' }, kindLabel(rec.kind)));
  head.appendChild(
    el('span', { class: `diag-card__status diag-card__status--${rec.status}` }, statusLabel(rec.status))
  );
  const endedAt = rec.finishedAt ?? Date.now();
  const duration = endedAt - rec.startedAt;
  head.appendChild(
    el('span', { class: 'diag-card__duration' }, formatDuration(duration))
  );
  head.appendChild(el('span', { class: 'diag-card__time' }, formatClock(rec.startedAt)));
  card.appendChild(head);

  if (rec.error) {
    card.appendChild(el('p', { class: 'diag-card__error' }, rec.error));
  }

  const kv = renderKv(rec);
  if (kv) card.appendChild(kv);

  const counters = renderCounters(rec);
  if (counters) card.appendChild(counters);

  const phases = renderPhases(rec.phases);
  if (phases) card.appendChild(phases);

  return card;
}

function updateSummary(list: ScanRecord[]): void {
  const summary = document.getElementById('summary');
  if (!summary) return;
  if (list.length === 0) {
    summary.hidden = true;
    return;
  }
  summary.hidden = false;
  const ok = list.filter((r) => r.status === 'ok').length;
  const err = list.filter((r) => r.status === 'error').length;
  const fallback = list.filter(
    (r) => (r.counters['fallback-dom'] ?? 0) > 0
  ).length;
  const totalEl = document.getElementById('sum-total');
  const okEl = document.getElementById('sum-ok');
  const errEl = document.getElementById('sum-error');
  const fbEl = document.getElementById('sum-fallback');
  if (totalEl) totalEl.textContent = String(list.length);
  if (okEl) okEl.textContent = String(ok);
  if (errEl) errEl.textContent = String(err);
  if (fbEl) fbEl.textContent = String(fallback);
}

async function carregar(): Promise<void> {
  const list = await listRecentScans();
  updateSummary(list);
  const empty = document.getElementById('empty');
  const container = document.getElementById('list');
  if (!container) return;
  container.innerHTML = '';
  if (list.length === 0) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  for (const rec of list) {
    container.appendChild(renderCard(rec));
  }
}

async function limpar(): Promise<void> {
  const ok = window.confirm(
    'Confirma a remoção do histórico local de diagnóstico? Esta ação não afeta coletas em andamento nem dados do PJe.'
  );
  if (!ok) return;
  await clearScans();
  await carregar();
}

function bindUi(): void {
  const reload = document.getElementById('btn-reload');
  const clear = document.getElementById('btn-clear');
  reload?.addEventListener('click', () => {
    void carregar();
  });
  clear?.addEventListener('click', () => {
    void limpar();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindUi();
  void carregar();
});
