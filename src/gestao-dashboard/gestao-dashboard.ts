/**
 * Painel Gerencial — página estática da extensão (perfil Gestão).
 *
 * Recebe o payload via `chrome.storage.session` na chave
 * `STORAGE_KEYS.GESTAO_DASHBOARD_PAYLOAD`, renderiza indicadores
 * determinísticos calculados no content script + listas por tarefa, e
 * oferece um botão para gerar insights via LLM. A chamada à LLM passa
 * pela mesma sanitização do dashboard de triagem
 * (`sanitizePayloadForLLM`) antes de cruzar o limite do navegador.
 */

import { MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
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
        '<p class="loading">Nenhum dado encontrado. Volte ao Painel do Usuário do PJe e clique em "Abrir Painel Gerencial".</p>';
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
  meta.innerHTML =
    `<div><strong>${escapeHtml(payload.hostnamePJe)}</strong></div>` +
    `<div>${escapeHtml(dataFmt)}</div>` +
    `<div>${payload.tarefas.length} tarefa(s) &middot; ${payload.totalProcessos} processo(s)</div>`;
}

function renderDashboard(root: HTMLElement, payload: GestaoDashboardPayload): void {
  root.innerHTML = '';
  root.appendChild(buildMetricas(payload.indicadores, payload.totalProcessos));

  const grid = el('section', 'grid-2');
  grid.appendChild(buildDistribuicaoTarefas(payload.indicadores));
  grid.appendChild(buildTopEtiquetas(payload.indicadores));
  root.appendChild(grid);

  root.appendChild(buildAtrasados(payload.tarefas, payload.indicadores.limiarAtrasoDias));
  root.appendChild(buildPorTarefa(payload.tarefas));
  root.appendChild(buildInsightsArea(payload));
}

function buildMetricas(ind: GestaoIndicadores, total: number): HTMLElement {
  const wrap = el('section', 'metrics');
  wrap.appendChild(metric('Processos varridos', String(total)));
  wrap.appendChild(
    metric(
      `Atrasados (> ${ind.limiarAtrasoDias}d)`,
      String(ind.atrasados),
      ind.atrasados > 0 ? 'danger' : undefined
    )
  );
  wrap.appendChild(
    metric(
      'Prioritários',
      String(ind.prioritarios),
      ind.prioritarios > 0 ? 'warning' : undefined
    )
  );
  wrap.appendChild(metric('Sigilosos', String(ind.sigilosos)));
  return wrap;
}

function metric(label: string, value: string, variant?: 'danger' | 'warning'): HTMLElement {
  const cls = variant ? `metric ${variant}` : 'metric';
  const m = el('div', cls);
  m.appendChild(textEl('div', 'metric__label', label));
  m.appendChild(textEl('div', 'metric__value', value));
  return m;
}

function buildDistribuicaoTarefas(ind: GestaoIndicadores): HTMLElement {
  const sec = el('section', 'panel');
  sec.appendChild(textEl('h2', '', 'Distribuição por tarefa'));
  const entries = Object.entries(ind.porTarefa).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    sec.appendChild(textEl('p', '', 'Nenhuma tarefa com processos.'));
    return sec;
  }
  const max = entries[0][1] || 1;
  for (const [nome, count] of entries) {
    const row = el('div', 'bar');
    row.appendChild(textEl('div', 'bar__label', nome));
    const track = el('div', 'bar__track');
    const fill = el('div', 'bar__fill');
    fill.style.width = `${(count / max) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(textEl('div', 'bar__count', String(count)));
    sec.appendChild(row);
  }
  return sec;
}

function buildTopEtiquetas(ind: GestaoIndicadores): HTMLElement {
  const sec = el('section', 'panel');
  sec.appendChild(textEl('h2', '', 'Top 5 etiquetas'));
  if (ind.topEtiquetas.length === 0) {
    sec.appendChild(textEl('p', '', 'Nenhuma etiqueta aplicada nos processos varridos.'));
    return sec;
  }
  const max = ind.topEtiquetas[0].total || 1;
  for (const { etiqueta, total } of ind.topEtiquetas) {
    const row = el('div', 'bar');
    row.appendChild(textEl('div', 'bar__label', etiqueta));
    const track = el('div', 'bar__track');
    const fill = el('div', 'bar__fill');
    fill.style.width = `${(total / max) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(textEl('div', 'bar__count', String(total)));
    sec.appendChild(row);
  }
  return sec;
}

function buildAtrasados(
  tarefas: TriagemTarefaSnapshot[],
  limiar: number
): HTMLElement {
  const sec = el('section', 'panel');
  sec.appendChild(textEl('h2', '', `Processos com mais de ${limiar} dias na tarefa`));
  const atrasados = tarefas
    .flatMap((t) => t.processos.map((p) => ({ tarefa: t.tarefaNome, p })))
    .filter((x) => typeof x.p.diasNaTarefa === 'number' && (x.p.diasNaTarefa as number) >= limiar)
    .sort((a, b) => (b.p.diasNaTarefa ?? 0) - (a.p.diasNaTarefa ?? 0));

  if (atrasados.length === 0) {
    sec.appendChild(textEl('p', '', 'Nenhum processo acima do limiar. 👏'));
    return sec;
  }

  const table = document.createElement('table');
  table.className = 'plain';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Processo</th>
        <th>Tarefa</th>
        <th>Assunto</th>
        <th>Polo passivo</th>
        <th style="text-align:right">Dias</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody') as HTMLElement;
  for (const { tarefa, p } of atrasados.slice(0, 200)) {
    const tr = document.createElement('tr');
    tr.appendChild(cellProc(p));
    tr.appendChild(cellText(tarefa));
    tr.appendChild(cellText(p.assunto));
    tr.appendChild(cellText(p.poloPassivo));
    tr.appendChild(cellDias(p.diasNaTarefa));
    tbody.appendChild(tr);
  }
  sec.appendChild(table);
  if (atrasados.length > 200) {
    sec.appendChild(
      textEl(
        'p',
        '',
        `Mostrando os 200 mais antigos de ${atrasados.length} processos atrasados.`
      )
    );
  }
  return sec;
}

function buildPorTarefa(tarefas: TriagemTarefaSnapshot[]): HTMLElement {
  const sec = el('section', 'panel');
  sec.appendChild(textEl('h2', '', 'Processos por tarefa'));

  for (const t of tarefas) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.style.cssText = 'cursor:pointer;padding:6px 0;font-weight:600;';
    sum.textContent = `${t.tarefaNome} (${t.totalLido}${t.truncado ? ' — truncado' : ''})`;
    det.appendChild(sum);

    if (t.processos.length === 0) {
      det.appendChild(textEl('p', '', 'Sem processos.'));
    } else {
      const table = document.createElement('table');
      table.className = 'plain';
      table.innerHTML = `
        <thead>
          <tr>
            <th>Processo</th>
            <th>Assunto</th>
            <th>Polo passivo</th>
            <th>Marcadores</th>
            <th style="text-align:right">Dias</th>
          </tr>
        </thead>
        <tbody></tbody>
      `;
      const tbody = table.querySelector('tbody') as HTMLElement;
      const ord = [...t.processos].sort(
        (a, b) => (b.diasNaTarefa ?? 0) - (a.diasNaTarefa ?? 0)
      );
      for (const p of ord) {
        const tr = document.createElement('tr');
        tr.appendChild(cellProc(p));
        tr.appendChild(cellText(p.assunto));
        tr.appendChild(cellText(p.poloPassivo));
        tr.appendChild(cellMarcadores(p));
        tr.appendChild(cellDias(p.diasNaTarefa));
        tbody.appendChild(tr);
      }
      det.appendChild(table);
    }
    sec.appendChild(det);
  }
  return sec;
}

function buildInsightsArea(payload: GestaoDashboardPayload): HTMLElement {
  const sec = el('section', 'panel');
  const head = el('div', 'toolbar');
  const title = textEl('h2', '', 'Leitura gerencial (IA)');
  title.style.marginRight = 'auto';
  head.appendChild(title);
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = 'Gerar insights com IA';
  head.appendChild(btn);
  sec.appendChild(head);

  const hint = document.createElement('p');
  hint.style.cssText = 'color:var(--muted);font-size:12px;';
  hint.textContent =
    'Os nomes das partes são removidos antes do envio. Apenas indicadores agregados, assuntos, datas, etiquetas e prioridade são compartilhados com o modelo.';
  sec.appendChild(hint);

  const body = document.createElement('div');
  body.id = 'gestao-insights-body';
  sec.appendChild(body);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Gerando insights...';
    body.innerHTML = '<p style="color:var(--muted)">Aguardando resposta do modelo...</p>';
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
        payload: {
          indicadores: payload.indicadores,
          anon
        }
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
      errEl.style.color = 'var(--danger)';
      errEl.textContent = `Não foi possível gerar insights: ${
        err instanceof Error ? err.message : String(err)
      }`;
      body.appendChild(errEl);
      btn.textContent = 'Tentar novamente';
      btn.disabled = false;
    }
  });

  return sec;
}

function renderInsights(body: HTMLElement, insights: GestaoInsightsLLM): void {
  body.innerHTML = '';
  if (insights.panorama) {
    const p = document.createElement('p');
    p.textContent = insights.panorama;
    p.style.cssText = 'font-size:14px;color:var(--fg);';
    body.appendChild(p);
  }
  if (insights.alertas && insights.alertas.length > 0) {
    const h = textEl('h3', '', 'Alertas');
    h.style.cssText = 'font-size:13px;margin:12px 0 6px;color:var(--primary-dark);';
    body.appendChild(h);
    const wrap = el('div', 'alerts-list');
    for (const a of insights.alertas) wrap.appendChild(renderAlerta(a));
    body.appendChild(wrap);
  }
  if (insights.sugestoes && insights.sugestoes.length > 0) {
    const h = textEl('h3', '', 'Sugestões');
    h.style.cssText = 'font-size:13px;margin:12px 0 6px;color:var(--primary-dark);';
    body.appendChild(h);
    const wrap = el('div', 'alerts-list');
    for (const s of insights.sugestoes) wrap.appendChild(renderSugestao(s));
    body.appendChild(wrap);
  }
}

function renderAlerta(a: GestaoAlerta): HTMLElement {
  const div = el('div', `alert ${a.severidade}`);
  div.appendChild(textEl('h3', '', a.titulo));
  div.appendChild(textEl('p', '', a.detalhe));
  return div;
}

function renderSugestao(s: GestaoSugestao): HTMLElement {
  const div = el('div', `alert ${s.prioridade}`);
  div.appendChild(textEl('h3', '', s.titulo));
  div.appendChild(textEl('p', '', s.detalhe));
  return div;
}

function cellProc(p: TriagemProcesso): HTMLTableCellElement {
  const td = document.createElement('td');
  const a = document.createElement('a');
  a.href = p.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = p.numeroProcesso || '(sem número)';
  td.appendChild(a);
  return td;
}

function cellText(s: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = s || '—';
  return td;
}

function cellDias(dias: number | null): HTMLTableCellElement {
  const td = document.createElement('td');
  td.style.textAlign = 'right';
  td.style.fontVariantNumeric = 'tabular-nums';
  td.textContent = typeof dias === 'number' ? `${dias}d` : '—';
  return td;
}

function cellMarcadores(p: TriagemProcesso): HTMLTableCellElement {
  const td = document.createElement('td');
  const marks: string[] = [];
  if (p.prioritario) marks.push('<span class="badge prioritario">Prioritário</span>');
  if (p.sigiloso) marks.push('<span class="badge sigiloso">Sigiloso</span>');
  for (const e of p.etiquetas) {
    marks.push(`<span class="badge">${escapeHtml(e)}</span>`);
  }
  td.innerHTML = marks.join(' ') || '—';
  return td;
}

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
