/**
 * Página de diagnóstico — renderiza o histórico local de varreduras
 * (gravado por `shared/telemetry.ts`). Não faz chamadas ao PJe nem à
 * rede: toda a informação vem de `chrome.storage.local`.
 *
 * Isolamento: é uma página web_accessible da extensão, aberta em aba
 * nova pelo popup. Nenhum caminho de coleta depende desta página.
 */

import { STORAGE_KEYS } from '../shared/constants';
import {
  clearScans,
  listRecentScans,
  type ScanPhaseRecord,
  type ScanRecord
} from '../shared/telemetry';
import type { Http403Diagnostic } from '../shared/types';

interface KeycloakCandidate {
  path: string;
  hasUpdateToken: boolean;
  hasToken: boolean;
  hasTokenParsed: boolean;
  hasRefreshToken: boolean;
  authServerUrl: string | null;
  realm: string | null;
  clientId: string | null;
  tokenExp: number | null;
}

interface IframeInfo {
  src: string;
  id: string | null;
  name: string | null;
  hidden: boolean;
}

interface AngularProbe {
  ngVersionAttr: string | null;
  hasNgGlobal: boolean;
  rootCount: number;
  hasZone: boolean;
}

interface KeycloakProbeReport {
  timestamp: number;
  url: string;
  angularVersion: string | null;
  foundAny: boolean;
  candidates: KeycloakCandidate[];
  attemptedPaths: string[];
  passes: number;
  localStorageKeys?: string[];
  sessionStorageKeys?: string[];
  cookieNames?: string[];
  iframes?: IframeInfo[];
  angular?: AngularProbe;
  jwtIssuer?: string | null;
  jwtExp?: number | null;
  jwtAzp?: string | null;
}

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

async function lerProbeKeycloak(): Promise<KeycloakProbeReport | null> {
  try {
    if (!chrome?.storage?.local?.get) return null;
    const data = await chrome.storage.local.get(STORAGE_KEYS.KEYCLOAK_PROBE);
    const rep = data?.[STORAGE_KEYS.KEYCLOAK_PROBE];
    if (rep && typeof rep === 'object') return rep as KeycloakProbeReport;
    return null;
  } catch {
    return null;
  }
}

function renderProbeCandidate(c: KeycloakCandidate): HTMLElement {
  const box = el('div', { class: 'diag-probe__candidate' });
  const flags: string[] = [];
  if (c.hasUpdateToken) flags.push('updateToken');
  if (c.hasToken) flags.push('token');
  if (c.hasTokenParsed) flags.push('tokenParsed');
  if (c.hasRefreshToken) flags.push('refreshToken');
  const parts: string[] = [c.path];
  parts.push(`[${flags.join(', ') || '—'}]`);
  if (c.realm) parts.push(`realm=${c.realm}`);
  if (c.clientId) parts.push(`clientId=${c.clientId}`);
  if (c.authServerUrl) parts.push(`authServerUrl=${c.authServerUrl}`);
  if (c.tokenExp) {
    const faltam = c.tokenExp * 1000 - Date.now();
    parts.push(
      `exp=${formatClock(c.tokenExp * 1000)} (${
        faltam > 0 ? 'em ' + formatDuration(faltam) : 'expirado'
      })`
    );
  }
  box.textContent = parts.join(' · ');
  return box;
}

function renderProbe(rep: KeycloakProbeReport | null): void {
  const section = document.getElementById('probe-section');
  const status = document.getElementById('probe-status');
  const body = document.getElementById('probe-body');
  if (!section || !status || !body) return;
  section.hidden = false;
  body.innerHTML = '';
  if (!rep) {
    status.textContent = 'nunca rodado';
    status.className = 'diag-probe__status diag-probe__status--never';
    body.appendChild(
      el(
        'p',
        { class: 'diag-empty' },
        'O probe roda automaticamente ao abrir uma aba do PJe. Se nada aparecer aqui depois de alguns segundos, recarregue a aba do PJe.'
      )
    );
    return;
  }
  if (rep.foundAny) {
    status.textContent = 'adapter encontrado';
    status.className = 'diag-probe__status diag-probe__status--found';
  } else {
    status.textContent = 'nao encontrado';
    status.className = 'diag-probe__status diag-probe__status--notfound';
  }
  const kv = el('div', { class: 'diag-kv' });
  const add = (k: string, v: string): void => {
    const item = el('div');
    item.appendChild(el('span', { class: 'diag-kv__key' }, `${k}:`));
    item.appendChild(el('span', { class: 'diag-kv__value' }, v));
    kv.appendChild(item);
  };
  add('Rodado em', formatClock(rep.timestamp));
  add('URL', rep.url);
  add('Angular attr', rep.angularVersion ?? '—');
  add('Passes', String(rep.passes));
  add('Candidatos', String(rep.candidates.length));
  if (rep.angular) {
    add('ng global', rep.angular.hasNgGlobal ? 'sim' : 'não');
    add('Zone.js', rep.angular.hasZone ? 'sim' : 'não');
    add('Roots Angular', String(rep.angular.rootCount));
  }
  if (rep.jwtIssuer) add('JWT iss', rep.jwtIssuer);
  if (rep.jwtAzp) add('JWT azp', rep.jwtAzp);
  if (rep.jwtExp) {
    const ms = rep.jwtExp * 1000;
    const falta = ms - Date.now();
    add(
      'JWT exp',
      `${formatClock(ms)} (${falta > 0 ? 'em ' + formatDuration(falta) : 'expirado'})`
    );
  }
  body.appendChild(kv);
  for (const c of rep.candidates) {
    body.appendChild(renderProbeCandidate(c));
  }

  // Pistas adicionais (storages, cookies, iframes) quando nenhum candidato
  // direto foi achado — orientam a proxima estrategia.
  const extras = el('div', { class: 'diag-probe__extras' });
  const addLista = (titulo: string, itens: string[] | undefined): void => {
    if (!itens || itens.length === 0) return;
    const h = el('p', { class: 'diag-probe__paths' }, `${titulo}: ${itens.join(', ')}`);
    extras.appendChild(h);
  };
  addLista('localStorage', rep.localStorageKeys);
  addLista('sessionStorage', rep.sessionStorageKeys);
  addLista('cookies', rep.cookieNames);
  if (rep.iframes && rep.iframes.length > 0) {
    const linhas = rep.iframes.map(
      (f) => `${f.hidden ? '[oculto] ' : ''}${f.id ?? f.name ?? '<sem-id>'} → ${f.src || '(sem src)'}`
    );
    addLista('iframes', linhas);
  }
  if (extras.children.length > 0) body.appendChild(extras);

  const paths = el(
    'p',
    { class: 'diag-probe__paths' },
    `Caminhos inspecionados: ${rep.attemptedPaths.join(', ') || '—'}`
  );
  body.appendChild(paths);
}

async function ler403Log(): Promise<Http403Diagnostic[]> {
  try {
    if (!chrome?.storage?.local?.get) return [];
    const data = await chrome.storage.local.get(STORAGE_KEYS.HTTP_403_LOG);
    const raw = data?.[STORAGE_KEYS.HTTP_403_LOG];
    if (Array.isArray(raw)) return raw as Http403Diagnostic[];
    return [];
  } catch {
    return [];
  }
}

function render403Entrada(diag: Http403Diagnostic): HTMLElement {
  const det = el('details', { class: 'diag-403-entry' });
  const sum = el('summary', { class: 'diag-403-entry__head' });
  const statusLabel =
    diag.silentRefreshAttempted && diag.silentRefreshOk
      ? 'refresh ok'
      : diag.silentRefreshAttempted
      ? 'refresh falhou'
      : 'sem refresh';
  const statusCls =
    diag.silentRefreshAttempted && diag.silentRefreshOk
      ? 'diag-probe__status--found'
      : 'diag-probe__status--notfound';
  sum.appendChild(
    el('span', { class: 'diag-403-entry__time' }, formatClock(diag.capturedAt))
  );
  sum.appendChild(
    el(
      'span',
      { class: `diag-probe__status ${statusCls}` },
      `HTTP ${diag.status} · ${statusLabel}`
    )
  );
  if (diag.silentRefreshError) {
    sum.appendChild(
      el(
        'span',
        { class: 'diag-403-entry__err' },
        diag.silentRefreshError.slice(0, 120)
      )
    );
  }
  det.appendChild(sum);

  const kv = el('div', { class: 'diag-kv' });
  const add = (k: string, v: string): void => {
    const item = el('div');
    item.appendChild(el('span', { class: 'diag-kv__key' }, `${k}:`));
    item.appendChild(el('span', { class: 'diag-kv__value' }, v));
    kv.appendChild(item);
  };
  add('URL', diag.url);
  add('Status HTTP', String(diag.status));
  add(
    'Idade do snapshot',
    diag.snapshotAgeMs != null ? formatDuration(diag.snapshotAgeMs) : '—'
  );
  if (diag.jwtExp != null) {
    const ms = diag.jwtExp * 1000;
    const delta = ms - diag.capturedAt;
    add(
      'JWT exp',
      `${formatClock(ms)} (${
        delta > 0
          ? 'faltavam ' + formatDuration(delta)
          : 'expirado há ' + formatDuration(-delta)
      })`
    );
  } else {
    add('JWT exp', '—');
  }
  add(
    'JWT expirado na requisição',
    diag.jwtExpiredAtRequest === null
      ? '—'
      : diag.jwtExpiredAtRequest
      ? 'sim'
      : 'não'
  );
  add('JSESSIONID presente', diag.jsessionIdPresent ? 'sim' : 'não');
  add('Silent refresh tentado', diag.silentRefreshAttempted ? 'sim' : 'não');
  if (diag.silentRefreshAttempted) {
    add(
      'Silent refresh ok',
      diag.silentRefreshOk === null
        ? '—'
        : diag.silentRefreshOk
        ? 'sim'
        : 'não'
    );
    if (diag.silentRefreshError) {
      add('Silent refresh erro', diag.silentRefreshError);
    }
  }
  det.appendChild(kv);
  if (diag.bodySnippet) {
    const pre = el('pre', { class: 'diag-probe__paths' });
    pre.textContent = diag.bodySnippet;
    det.appendChild(pre);
  }
  return det;
}

function render403(log: Http403Diagnostic[]): void {
  const section = document.getElementById('http403-section');
  const status = document.getElementById('http403-status');
  const body = document.getElementById('http403-body');
  if (!section || !status || !body) return;
  section.hidden = false;
  body.innerHTML = '';

  if (log.length === 0) {
    status.textContent = 'nenhum registrado';
    status.className = 'diag-probe__status diag-probe__status--never';
    body.appendChild(
      el(
        'p',
        { class: 'diag-empty' },
        'Nenhum HTTP 403 foi capturado ainda. Se uma varredura falhar com 403, cada ocorrência será registrada aqui com a causa provável (expiração de JWT, falha do silent SSO, JSESSIONID ausente etc.).'
      )
    );
    return;
  }

  const refreshOk = log.filter(
    (d) => d.silentRefreshAttempted && d.silentRefreshOk
  ).length;
  const refreshFail = log.filter(
    (d) => d.silentRefreshAttempted && !d.silentRefreshOk
  ).length;
  const semRefresh = log.length - refreshOk - refreshFail;

  status.textContent = `${log.length} entrada(s) · ${refreshOk} refresh ok · ${refreshFail} refresh falhou · ${semRefresh} sem refresh`;
  status.className =
    refreshFail > 0
      ? 'diag-probe__status diag-probe__status--notfound'
      : 'diag-probe__status diag-probe__status--found';

  const mensagemContexto = el(
    'p',
    { class: 'diag-empty' },
    'Mais recente primeiro. Cada linha é um HTTP 403 observado em chamadas REST ao PJe — expanda para ver o resultado do silent SSO (mensagem real do Keycloak ou motivo do timeout). Entradas com "refresh falhou" são a causa raiz quando o coordinator aborta com "token expirou e não foi renovado em 60s".'
  );
  body.appendChild(mensagemContexto);

  const lista = el('div', { class: 'diag-403-list' });
  for (let i = log.length - 1; i >= 0; i--) {
    lista.appendChild(render403Entrada(log[i]));
  }
  body.appendChild(lista);
}

async function carregar(): Promise<void> {
  const [list, probe, log403] = await Promise.all([
    listRecentScans(),
    lerProbeKeycloak(),
    ler403Log()
  ]);
  renderProbe(probe);
  render403(log403);
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
