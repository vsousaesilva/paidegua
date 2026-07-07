/**
 * Página de diagnóstico — renderiza o histórico local de varreduras
 * (gravado por `shared/telemetry.ts`). Não faz chamadas ao PJe nem à
 * rede: toda a informação vem de `chrome.storage.local`.
 *
 * Isolamento: é uma página web_accessible da extensão, aberta em aba
 * nova pelo popup. Nenhum caminho de coleta depende desta página.
 */

import {
  ADMIN_EMAILS,
  MESSAGE_CHANNELS,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  STORAGE_KEYS,
  type ProviderId
} from '../shared/constants';
import {
  clearScans,
  listRecentScans,
  type ScanPhaseRecord,
  type ScanRecord
} from '../shared/telemetry';
import type { AuthState, Http403Diagnostic } from '../shared/types';

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

// =====================================================================
// Testador de Modelos de IA (visível apenas para admin)
// =====================================================================

interface TestConnectionResult {
  ok: boolean;
  error?: string;
  modelEcho?: string;
}

interface TestGenerateResult {
  ok: boolean;
  error?: string;
  ttft?: number;
  totalMs?: number;
  chars?: number;
  chunks?: number;
}

interface RowRefs {
  tdChave: HTMLTableCellElement;
  tdConexao: HTMLTableCellElement;
  tdTtft: HTMLTableCellElement;
  tdTotal: HTMLTableCellElement;
  tdChars: HTMLTableCellElement;
  tdStatus: HTMLTableCellElement;
}

async function isAdmin(): Promise<boolean> {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.AUTH);
    const auth = data?.[STORAGE_KEYS.AUTH] as AuthState | undefined;
    return ADMIN_EMAILS.includes(auth?.email ?? '');
  } catch {
    return false;
  }
}

async function hasApiKey(provider: ProviderId): Promise<boolean> {
  try {
    const result = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.HAS_API_KEY,
      payload: { provider }
    })) as { ok: boolean; present?: boolean } | undefined;
    return result?.ok === true && result.present === true;
  } catch {
    return false;
  }
}

function setBadge(
  cell: HTMLTableCellElement,
  text: string,
  variant: 'ok' | 'error' | 'warn' | 'muted' | 'running'
): void {
  cell.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = `diag-tester__badge-cell diag-tester__badge-cell--${variant}`;
  badge.textContent = text;
  cell.appendChild(badge);
}

function addTesterRow(
  tbody: HTMLTableSectionElement,
  providerLabel: string,
  modelLabel: string
): RowRefs {
  const tr = document.createElement('tr');
  const make = (text = ''): HTMLTableCellElement => {
    const td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
    return td;
  };
  make(providerLabel);
  make(modelLabel);
  const tdChave = make('—');
  const tdConexao = make('—');
  const tdTtft = make('—');
  const tdTotal = make('—');
  const tdChars = make('—');
  const tdStatus = make('aguardando…');
  tbody.appendChild(tr);
  return { tdChave, tdConexao, tdTtft, tdTotal, tdChars, tdStatus };
}

function ms(n: number | undefined): string {
  if (n === undefined) return '—';
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

async function runModelTests(): Promise<void> {
  const tbody = document.getElementById('tester-tbody') as HTMLTableSectionElement | null;
  const progressLabel = document.getElementById('tester-progress-label');
  const resultsDiv = document.getElementById('tester-results');
  const btn = document.getElementById('btn-test-models') as HTMLButtonElement | null;

  if (!tbody || !progressLabel || !resultsDiv || !btn) return;

  btn.disabled = true;
  tbody.innerHTML = '';
  resultsDiv.hidden = false;
  progressLabel.hidden = false;
  progressLabel.textContent = 'Verificando chaves de API…';

  // Monta a lista de todos os pares (provider, model) com status de chave
  type TestItem = {
    provider: ProviderId;
    model: string;
    modelLabel: string;
    temChave: boolean;
    rows: RowRefs;
  };
  const items: TestItem[] = [];

  for (const provider of PROVIDER_IDS) {
    const temChave = await hasApiKey(provider);
    for (const m of PROVIDER_MODELS[provider]) {
      const rows = addTesterRow(tbody, PROVIDER_LABELS[provider], m.label);
      setBadge(rows.tdChave, temChave ? 'sim' : 'não', temChave ? 'ok' : 'muted');
      if (!temChave) {
        setBadge(rows.tdStatus, 'sem chave', 'muted');
      }
      items.push({ provider, model: m.id, modelLabel: m.label, temChave, rows });
    }
  }

  const withKey = items.filter((i) => i.temChave);
  if (withKey.length === 0) {
    progressLabel.textContent = 'Nenhuma chave de API cadastrada. Configure ao menos uma no popup da extensão.';
    btn.disabled = false;
    return;
  }

  let done = 0;
  const total = withKey.length * 2; // conexão + geração por item

  const setProgress = (extra = ''): void => {
    progressLabel.textContent = `Testando… ${done}/${total} etapas concluídas.${extra ? ' ' + extra : ''}`;
  };

  setProgress();

  for (const item of withKey) {
    const { provider, model, rows } = item;

    // ── Fase 1: conexão (streaming ping) ───────────────────────────
    setBadge(rows.tdConexao, 'testando…', 'running');
    setBadge(rows.tdStatus, 'testando conexão…', 'running');

    const t0conn = performance.now();
    let connResult: TestConnectionResult;
    try {
      connResult = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.TEST_CONNECTION,
        payload: { provider, model }
      })) as TestConnectionResult;
    } catch (e) {
      connResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const connMs = Math.round(performance.now() - t0conn);

    if (connResult.ok) {
      setBadge(rows.tdConexao, ms(connMs), 'ok');
    } else {
      setBadge(rows.tdConexao, `FALHA (${ms(connMs)})`, 'error');
      rows.tdConexao.title = connResult.error ?? '';
      setBadge(rows.tdStatus, 'falhou na conexão', 'error');
      rows.tdStatus.title = connResult.error ?? '';
      done += 2; // pula fase de geração
      setProgress();
      continue;
    }

    done++;
    setProgress();

    // ── Fase 2: geração real ─────────────────────────────────────────
    setBadge(rows.tdTtft, 'gerando…', 'running');
    setBadge(rows.tdStatus, 'testando geração…', 'running');

    let genResult: TestGenerateResult;
    try {
      genResult = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.TEST_MODEL_GENERATE,
        payload: { provider, model }
      })) as TestGenerateResult;
    } catch (e) {
      genResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (genResult.ok) {
      rows.tdTtft.textContent = ms(genResult.ttft);
      rows.tdTotal.textContent = ms(genResult.totalMs);
      rows.tdChars.textContent = String(genResult.chars ?? 0);
      setBadge(rows.tdStatus, 'OK', 'ok');
    } else {
      setBadge(rows.tdTtft, '—', 'muted');
      setBadge(rows.tdStatus, 'falhou na geração', 'error');
      rows.tdStatus.title = genResult.error ?? '';
      if (genResult.totalMs !== undefined) {
        rows.tdTotal.textContent = ms(genResult.totalMs);
      }
    }

    done++;
    setProgress();
  }

  progressLabel.textContent = `Diagnóstico concluído. ${done} etapas executadas.`;
  btn.disabled = false;
}

async function setupModelTester(): Promise<void> {
  if (!(await isAdmin())) return;
  const section = document.getElementById('model-tester-section');
  if (section) section.hidden = false;
  const btn = document.getElementById('btn-test-models');
  btn?.addEventListener('click', () => {
    void runModelTests();
  });
}

// =====================================================================
// Log de Uso Real — Gemini
// =====================================================================

const GEMINI_USAGE_LOG_KEY = 'paidegua.gemini.usageLog';

interface GeminiUsageEntry {
  ts: number;
  model: string;
  inChars: number;
  ttft: number | null;
  totalMs: number;
  outChars: number;
  finishReason: string | null;
  ok: boolean;
  errorSnippet: string | null;
}

async function lerGeminiUsageLog(): Promise<GeminiUsageEntry[]> {
  try {
    const data = await chrome.storage.local.get(GEMINI_USAGE_LOG_KEY);
    const raw = data?.[GEMINI_USAGE_LOG_KEY];
    return Array.isArray(raw) ? (raw as GeminiUsageEntry[]) : [];
  } catch {
    return [];
  }
}

async function limparGeminiUsageLog(): Promise<void> {
  await chrome.storage.local.remove(GEMINI_USAGE_LOG_KEY);
}

function kchars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function renderUsageStats(log: GeminiUsageEntry[]): void {
  const statsDiv = document.getElementById('usage-stats');
  const tbody = document.getElementById('usage-stats-tbody') as HTMLTableSectionElement | null;
  if (!statsDiv || !tbody) return;

  // Agrupa por modelo
  const byModel = new Map<string, GeminiUsageEntry[]>();
  for (const e of log) {
    const arr = byModel.get(e.model) ?? [];
    arr.push(e);
    byModel.set(e.model, arr);
  }

  tbody.innerHTML = '';
  for (const [model, entries] of Array.from(byModel.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const ok = entries.filter((e) => e.ok).length;
    const ttfts = entries.filter((e) => e.ttft !== null).map((e) => e.ttft as number);
    const totals = entries.map((e) => e.totalMs);
    const inputs = entries.map((e) => e.inChars);
    const outputs = entries.map((e) => e.outChars);

    const tr = document.createElement('tr');
    const td = (text: string, cls?: string): HTMLTableCellElement => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (cls) cell.className = cls;
      return cell;
    };
    tr.appendChild(td(model));
    tr.appendChild(td(String(entries.length)));
    const successRate = Math.round((ok / entries.length) * 100);
    const successCell = td(`${ok}/${entries.length} (${successRate}%)`);
    successCell.className = successRate === 100 ? 'diag-usage__ok' : successRate < 50 ? 'diag-usage__error' : '';
    tr.appendChild(successCell);
    tr.appendChild(td(avg(ttfts) !== null ? ms(avg(ttfts) ?? undefined) : '—'));
    tr.appendChild(td(avg(totals) !== null ? ms(avg(totals) ?? undefined) : '—'));
    tr.appendChild(td(avg(inputs) !== null ? kchars(avg(inputs) ?? 0) : '—'));
    tr.appendChild(td(avg(outputs) !== null ? kchars(avg(outputs) ?? 0) : '—'));
    tbody.appendChild(tr);
  }
  statsDiv.hidden = false;
}

function renderUsageLog(log: GeminiUsageEntry[]): void {
  const logDiv = document.getElementById('usage-log');
  const tbody = document.getElementById('usage-log-tbody') as HTMLTableSectionElement | null;
  const emptyEl = document.getElementById('usage-empty');

  if (!logDiv || !tbody || !emptyEl) return;

  if (log.length === 0) {
    emptyEl.hidden = false;
    logDiv.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  tbody.innerHTML = '';

  // Mais recente primeiro
  const reversed = [...log].reverse().slice(0, 200);
  for (const e of reversed) {
    const tr = document.createElement('tr');

    const td = (text: string): HTMLTableCellElement => {
      const cell = document.createElement('td');
      cell.textContent = text;
      return cell;
    };

    tr.appendChild(td(formatClock(e.ts)));
    tr.appendChild(td(e.model));
    tr.appendChild(td(kchars(e.inChars)));
    tr.appendChild(td(e.ttft !== null ? ms(e.ttft) : '—'));
    tr.appendChild(td(ms(e.totalMs)));
    tr.appendChild(td(kchars(e.outChars)));
    tr.appendChild(td(e.finishReason ?? '—'));

    const statusCell = document.createElement('td');
    if (e.ok) {
      const badge = document.createElement('span');
      badge.className = 'diag-tester__badge-cell diag-tester__badge-cell--ok';
      badge.textContent = 'OK';
      statusCell.appendChild(badge);
    } else {
      const badge = document.createElement('span');
      badge.className = 'diag-tester__badge-cell diag-tester__badge-cell--error';
      badge.textContent = 'ERRO';
      badge.title = e.errorSnippet ?? '';
      statusCell.appendChild(badge);
      if (e.errorSnippet) {
        const detail = document.createElement('div');
        detail.className = 'diag-usage__error-detail';
        detail.textContent = e.errorSnippet.slice(0, 120);
        statusCell.appendChild(detail);
      }
    }
    tr.appendChild(statusCell);

    tbody.appendChild(tr);
  }

  logDiv.hidden = false;
}

async function carregarUsageLog(): Promise<void> {
  const log = await lerGeminiUsageLog();
  renderUsageStats(log);
  renderUsageLog(log);
}

async function setupGeminiUsageLog(): Promise<void> {
  if (!(await isAdmin())) return;
  const section = document.getElementById('gemini-usage-section');
  if (section) section.hidden = false;

  document.getElementById('btn-usage-refresh')?.addEventListener('click', () => {
    void carregarUsageLog();
  });
  document.getElementById('btn-usage-clear')?.addEventListener('click', () => {
    if (!window.confirm('Limpar todo o log de uso do Gemini?')) return;
    void limparGeminiUsageLog().then(() => carregarUsageLog());
  });

  void carregarUsageLog();
}

document.addEventListener('DOMContentLoaded', () => {
  bindUi();
  void carregar();
  void setupModelTester();
  void setupGeminiUsageLog();
});
