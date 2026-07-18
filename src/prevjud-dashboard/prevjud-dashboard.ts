/**
 * Dashboard de Ordens PREVJUD (perfil Gestão — GES-10). Layout no mesmo
 * padrão do "Analisar tarefas" da Triagem: shell fixo (header com a unidade
 * variável + `#main`) e conteúdo montado dinamicamente em seções.
 *
 * Lê o payload de `chrome.storage.session` (ou do cache local ao reabrir) e
 * renderiza métricas, quebra por Status/Serviço, tabela detalhada (com
 * copiar nº, abrir tarefa, ordenação, copiar lista e Excel) e diagnóstico.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import { lerNomeVaraDasSettings, renderHeaderMeta } from '../shared/header-meta';
import { criarBotaoCopiar } from '../shared/icons';
import {
  OPEN_TASK_ICON_SVG,
  abrirTarefaPopup,
  podeAbrirTarefa
} from '../shared/pje-task-popup';
import {
  envelhecimentoDias,
  ordemPendente,
  parseDataPrevjud,
  situacaoPrazo,
  type SituacaoPrazoPrevjud
} from '../shared/prevjud-parser';
import {
  attachExcelButton,
  type ExcelColumn
} from '../shared/xlsx-export';
import { makeTableSortable, type TableSortColumn } from '../shared/table-sort';
import type {
  OrdemPrevjud,
  PrevjudAplicarEtiquetasResult,
  PrevjudDashboardPayload,
  ProcessoOrdensPrevjud
} from '../shared/types';

/** Ordens pendentes há mais dias que isto entram no alerta de envelhecimento. */
const ALERTA_DIAS = 30;
const ATENCAO_DIAS = 15;

const elMain = document.getElementById('main') as HTMLElement;
const elMeta = document.getElementById('meta') as HTMLElement;

interface Linha {
  processo: ProcessoOrdensPrevjud;
  ordem: OrdemPrevjud;
  busca: string;
}

let requestId = '';
let payloadAtual: PrevjudDashboardPayload | null = null;
let nomeVaraCache: string | null = null;
let renderAgendado = false;
let proximoPayload: PrevjudDashboardPayload | null = null;
let linhas: Linha[] = [];
let linhasVisiveis: Linha[] = [];
let elTabelaCorpo: HTMLElement | null = null;
let elTabela: HTMLTableElement | null = null;

void main();

async function main(): Promise<void> {
  try {
    const params = new URLSearchParams(window.location.search);
    requestId = params.get('rid') ?? '';
    const viaCache = params.get('cache') === '1';

    let payload: PrevjudDashboardPayload | null = null;
    if (viaCache) {
      payload = await carregarCache();
      if (!payload) {
        exibirErro('Não há relatório salvo. Gere um novo a partir do PJe.');
        return;
      }
    } else {
      if (!requestId) {
        exibirErro('Identificador de requisição ausente.');
        return;
      }
      payload = await carregarPayload(requestId);
      if (!payload) {
        const cached = await carregarCache();
        if (cached && cached.requestId === requestId) payload = cached;
      }
      if (!payload) {
        exibirErro(
          'Não encontrei os dados deste painel. A sessão pode ter expirado — ' +
            'gere o relatório novamente ou use "Reabrir último relatório".'
        );
        return;
      }
      registrarLimpezaAoFechar();
      // Streaming: escuta as atualizações de storage.session (patches +
      // finalização). Só persiste no cache quando a coleta termina.
      subscreverAtualizacoes();
      if (payload.status !== 'running') await salvarCache(payload);
    }
    await renderizar(payload);
  } catch (err) {
    console.error(`${LOG_PREFIX} dashboard PREVJUD falhou:`, err);
    exibirErro(err instanceof Error ? err.message : String(err));
  }
}

/** Escuta patches/finalização da coleta em storage.session (coalescido). */
function subscreverAtualizacoes(): void {
  const key = `${STORAGE_KEYS.PREVJUD_DASHBOARD_PAYLOAD_PREFIX}${requestId}`;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    const ch = changes[key];
    if (!ch || !ch.newValue) return;
    const novo = validarPayload(ch.newValue);
    if (novo) agendarRender(novo);
  });
}

/** Coalesce re-renders (vários patches em sequência) num único por frame. */
function agendarRender(p: PrevjudDashboardPayload): void {
  proximoPayload = p;
  if (renderAgendado) return;
  renderAgendado = true;
  requestAnimationFrame(() => {
    renderAgendado = false;
    const alvo = proximoPayload;
    proximoPayload = null;
    if (!alvo) return;
    if (alvo.status === 'done') void salvarCache(alvo);
    void renderizar(alvo);
  });
}

async function carregarPayload(
  rid: string
): Promise<PrevjudDashboardPayload | null> {
  const key = `${STORAGE_KEYS.PREVJUD_DASHBOARD_PAYLOAD_PREFIX}${rid}`;
  const out = await chrome.storage.session.get(key);
  return validarPayload(out[key]);
}

async function carregarCache(): Promise<PrevjudDashboardPayload | null> {
  try {
    const out = await chrome.storage.local.get(
      STORAGE_KEYS.PREVJUD_ULTIMO_RELATORIO
    );
    return validarPayload(out[STORAGE_KEYS.PREVJUD_ULTIMO_RELATORIO]);
  } catch {
    return null;
  }
}

function validarPayload(raw: unknown): PrevjudDashboardPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PrevjudDashboardPayload>;
  if (!Array.isArray(obj.processos)) return null;
  return obj as PrevjudDashboardPayload;
}

async function salvarCache(p: PrevjudDashboardPayload): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.PREVJUD_ULTIMO_RELATORIO]: p });
  } catch (err) {
    console.warn(`${LOG_PREFIX} falha ao salvar cache PREVJUD:`, err);
  }
}

// =====================================================================
// Render
// =====================================================================

async function renderizar(p: PrevjudDashboardPayload): Promise<void> {
  payloadAtual = p;
  if (nomeVaraCache === null) nomeVaraCache = await lerNomeVaraDasSettings();
  const unidade = nomeVaraCache || p.hostnamePJe;
  const contadores: string[] = [];
  if (unidade !== p.hostnamePJe && p.hostnamePJe) contadores.push(p.hostnamePJe);
  contadores.push(
    `${p.tarefasVarridas.length} tarefa(s) varrida(s)`,
    p.etiquetasFiltro.length > 0
      ? `filtro: ${p.etiquetasFiltro.join(', ')}`
      : 'sem filtro de etiqueta'
  );
  renderHeaderMeta(elMeta, { unidade, geradoEm: p.geradoEm, contadores });

  // Achatar ordens em linhas.
  linhas = [];
  for (const proc of p.processos) {
    for (const ordem of proc.ordens) {
      const busca = [
        proc.numeroProcesso ?? '',
        proc.classeJudicial ?? '',
        proc.poloAtivo ?? '',
        ordem.status,
        ordem.servico
      ]
        .join(' ')
        .toLowerCase();
      linhas.push({ processo: proc, ordem, busca });
    }
  }

  elMain.innerHTML = '';
  if (p.status === 'running') elMain.appendChild(montarBannerColeta(p));
  elMain.appendChild(montarMetrics(p));
  elMain.appendChild(montarBreakdowns());
  elMain.appendChild(montarSecaoTabela());
  if (p.status !== 'running') elMain.appendChild(montarDiagnostico(p));
  garantirToast();
}

/** Banner de progresso enquanto a coleta ainda está rodando (streaming). */
function montarBannerColeta(p: PrevjudDashboardPayload): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'section';
  sec.style.borderColor = 'rgba(19, 81, 180, 0.35)';
  sec.style.background = 'rgba(19, 81, 180, 0.04)';
  const feitos = p.progress?.feitos ?? 0;
  const total = p.progress?.total ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((feitos / total) * 100)) : 0;

  const h = document.createElement('h2');
  h.textContent = 'Coletando ordens PREVJUD…';
  sec.appendChild(h);
  const info = document.createElement('p');
  info.className = 'section__hint';
  info.textContent =
    `Varredura em andamento: ${feitos} de ${total} processo(s) verificados · ` +
    `${p.processos.length} com ordem até agora. O painel atualiza sozinho — ` +
    `não é preciso esperar.`;
  sec.appendChild(info);

  const track = document.createElement('div');
  track.className = 'header__hydration-track';
  track.style.height = '8px';
  const fill = document.createElement('div');
  fill.className = 'header__hydration-fill';
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  sec.appendChild(track);
  return sec;
}

function montarMetrics(p: PrevjudDashboardPayload): HTMLElement {
  const vencidos = linhas.filter(
    (l) => situacaoPrazo(l.ordem) === 'vencido'
  ).length;
  const envelhecidas = linhas.filter((l) => {
    if (!ordemPendente(l.ordem)) return false;
    const d = envelhecimentoDias(l.ordem);
    return d != null && d >= ALERTA_DIAS;
  }).length;

  const cards: { valor: number; label: string; tom?: 'danger' | 'warning' }[] = [
    { valor: p.totais.processosComOrdem, label: 'Processos com ordem' },
    { valor: p.totais.totalOrdens, label: 'Ordens no total' },
    { valor: p.totais.ordensPendentes, label: 'Ordens pendentes', tom: 'warning' },
    { valor: envelhecidas, label: `Pendentes há ${ALERTA_DIAS}+ dias`, tom: 'danger' },
    { valor: vencidos, label: 'Prazos vencidos', tom: 'danger' }
  ];

  const wrap = document.createElement('section');
  wrap.className = 'metrics';
  for (const c of cards) {
    const div = document.createElement('div');
    div.className = 'metric';
    const l = document.createElement('div');
    l.className = 'metric__label';
    l.textContent = c.label;
    const v = document.createElement('div');
    v.className = 'metric__value' + (c.tom ? ` metric__value--${c.tom}` : '');
    v.textContent = String(c.valor);
    div.append(l, v);
    wrap.appendChild(div);
  }
  return wrap;
}

function montarBreakdowns(): HTMLElement {
  const porStatus = new Map<string, number>();
  const porServico = new Map<string, number>();
  for (const l of linhas) {
    const s = l.ordem.status || '(sem status)';
    const sv = l.ordem.servico || '(sem serviço)';
    porStatus.set(s, (porStatus.get(s) ?? 0) + 1);
    porServico.set(sv, (porServico.get(sv) ?? 0) + 1);
  }
  const grid = document.createElement('div');
  grid.className = 'grid-2';
  grid.appendChild(montarBarlist('Por Status', porStatus));
  grid.appendChild(montarBarlist('Por Serviço', porServico));
  return grid;
}

function montarBarlist(titulo: string, mapa: Map<string, number>): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'section';
  const h = document.createElement('h2');
  h.textContent = titulo;
  sec.appendChild(h);
  const lista = document.createElement('div');
  lista.className = 'barlist';
  const ordenado = Array.from(mapa.entries()).sort((a, b) => b[1] - a[1]);
  const max = ordenado.length > 0 ? ordenado[0][1] : 1;
  if (ordenado.length === 0) {
    const vazio = document.createElement('p');
    vazio.className = 'section__hint';
    vazio.textContent = '—';
    sec.appendChild(vazio);
    return sec;
  }
  for (const [nome, qtd] of ordenado) {
    const row = document.createElement('div');
    row.className = 'barlist__row';
    const label = document.createElement('div');
    label.className = 'barlist__label';
    label.textContent = nome;
    const bar = document.createElement('div');
    bar.className = 'barlist__bar';
    bar.style.width = `${Math.max(6, Math.round((qtd / max) * 100))}%`;
    label.appendChild(bar);
    const count = document.createElement('div');
    count.className = 'barlist__count';
    count.textContent = String(qtd);
    row.append(label, count);
    lista.appendChild(row);
  }
  sec.appendChild(lista);
  return sec;
}

// =====================================================================
// Tabela
// =====================================================================

const CABECALHO_TABELA = [
  'Processo',
  'Ordem',
  'Status',
  'Serviço',
  'Envio',
  'Dias',
  'Final do prazo',
  'Cumprida?',
  'Documento'
] as const;

const COLUNAS_SORT: Array<TableSortColumn<Linha> | null> = [
  { type: 'alpha', value: (l) => l.processo.numeroProcesso ?? String(l.processo.idProcesso) },
  { type: 'num', value: (l) => l.ordem.ordem },
  { type: 'alpha', value: (l) => l.ordem.status },
  { type: 'alpha', value: (l) => l.ordem.servico },
  { type: 'date', value: (l) => l.ordem.dataEnvio },
  { type: 'num', value: (l) => envelhecimentoDias(l.ordem) },
  { type: 'date', value: (l) => l.ordem.finalPrazo },
  { type: 'alpha', value: (l) => (ordemPendente(l.ordem) ? 'Pendente' : 'Cumprida') },
  null
];

const ROTULO_PRAZO: Record<SituacaoPrazoPrevjud, string> = {
  'sem-prazo': '—',
  'a-vencer': 'A vencer',
  'vence-hoje': 'Vence hoje',
  vencido: 'Vencido'
};
const CLASSE_PRAZO: Record<SituacaoPrazoPrevjud, string> = {
  'sem-prazo': 'badge--neutro',
  'a-vencer': 'badge--ok',
  'vence-hoje': 'badge--warn',
  vencido: 'badge--danger'
};

function montarSecaoTabela(): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'section section--copy';

  const h = document.createElement('h2');
  h.textContent = 'Ordens';
  sec.appendChild(h);

  const busca = document.createElement('input');
  busca.type = 'search';
  busca.className = 'busca';
  busca.placeholder = 'Filtrar por processo, status, serviço...';
  busca.setAttribute('autocomplete', 'off');
  busca.addEventListener('input', () => {
    const q = busca.value.trim().toLowerCase();
    const filtradas = q ? linhas.filter((l) => l.busca.includes(q)) : linhas;
    montarTabela(filtradas);
  });
  const hint = document.createElement('p');
  hint.className = 'section__hint';
  hint.appendChild(busca);
  sec.appendChild(hint);

  const wrap = document.createElement('div');
  wrap.className = 'scroll-limit';
  elTabela = document.createElement('table');
  elTabela.className = 'proc-table';
  elTabela.appendChild(document.createElement('thead'));
  elTabelaCorpo = document.createElement('tbody');
  elTabela.appendChild(elTabelaCorpo);
  wrap.appendChild(elTabela);
  sec.appendChild(wrap);

  // Botões do topo do card: copiar lista (canto) + Excel (à esquerda).
  const btnCopiarLista = criarBotaoCopiar({
    className: 'copy-btn',
    titulo: 'Copiar a lista de processos (números CNJ)',
    tamanho: 16,
    texto: '',
    textoFn: () => {
      const nums = new Set<string>();
      for (const l of linhasVisiveis) {
        const n = l.processo.numeroProcesso;
        if (n) nums.add(n);
      }
      return Array.from(nums).join('\n');
    }
  });
  sec.appendChild(btnCopiarLista);

  attachExcelButton(sec, () => linhasVisiveis, COLUNAS_EXCEL, 'ordens-prevjud', {
    label: 'Baixar Excel (linhas visíveis)',
    sheetName: 'Ordens PREVJUD',
    emptyMessage: 'Nada para exportar.',
    onToast: showToast
  });

  // Botão de aplicar etiquetas de status (à esquerda do Excel).
  const btnEtq = document.createElement('button');
  btnEtq.type = 'button';
  btnEtq.className = 'acao-btn';
  btnEtq.textContent = 'Aplicar etiquetas de status';
  btnEtq.title =
    'Insere/atualiza a etiqueta "Prevjud - [status]" em todos os processos do relatório, ' +
    'removendo as etiquetas Prevjud anteriores.';
  btnEtq.addEventListener('click', () => void aplicarEtiquetasStatus(btnEtq));
  sec.appendChild(btnEtq);

  montarTabela(linhas);
  return sec;
}

/** Status representativo do processo: o da ordem mais recente (por envio). */
function statusRepresentativo(proc: ProcessoOrdensPrevjud): string {
  let melhor: OrdemPrevjud | null = null;
  let melhorT = -Infinity;
  for (const o of proc.ordens) {
    const t = parseDataPrevjud(o.dataEnvio) ?? -Infinity;
    if (melhor === null || t >= melhorT) {
      melhor = o;
      melhorT = t;
    }
  }
  return melhor ? melhor.status.trim() : '';
}

async function aplicarEtiquetasStatus(btn: HTMLButtonElement): Promise<void> {
  if (!payloadAtual) return;
  if (payloadAtual.status === 'running') {
    showToast('Aguarde a coleta terminar antes de aplicar etiquetas.');
    return;
  }
  const processos = payloadAtual.processos
    .map((proc) => ({
      idProcesso: proc.idProcesso,
      numeroProcesso: proc.numeroProcesso,
      statusEtiqueta: statusRepresentativo(proc),
      etiquetasAtuais: Array.isArray(proc.etiquetas) ? proc.etiquetas : []
    }))
    .filter((x) => x.statusEtiqueta.length > 0);
  if (processos.length === 0) {
    showToast('Nenhum processo com status para etiquetar.');
    return;
  }
  const ok = window.confirm(
    `Isto vai inserir/atualizar a etiqueta "Prevjud - [status]" em ` +
      `${processos.length} processo(s) no PJe, removendo as etiquetas ` +
      `"Prevjud - *" anteriores de cada um. Continuar?\n\n` +
      `Requer o Painel do Usuário do PJe aberto em outra aba.`
  );
  if (!ok) return;

  const rotulo = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Aplicando...';
  try {
    const r = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PREVJUD_APLICAR_ETIQUETAS,
      payload: { processos, requestId }
    })) as PrevjudAplicarEtiquetasResult | undefined;
    console.log(`${LOG_PREFIX} [aplicar-etiquetas] resposta`, r);
    // Atualiza o estado local com o que o PJe confirmou ter escrito, para o
    // próximo clique reconhecer os já-etiquetados (check `jaTem`) e NÃO
    // reenviar — revincular etiqueta existente devolve HTTP 500 no PJe.
    if (r) aplicarResultadoNoEstado(r);

    const semAcao = !!r?.diag && r.diag.aAplicar === 0 && r.diag.aRemover === 0;
    if (r?.ok && semAcao) {
      mostrarAviso(
        'Tudo já estava atualizado — nenhuma etiqueta a aplicar ou remover.',
        'ok'
      );
    } else if (r?.diag && r.vinculadas === 0 && r.removidas === 0) {
      const d = r.diag;
      mostrarAviso(
        `Nada aplicado. Recebidos: ${d.recebidos} · já com a etiqueta: ` +
          `${d.jaComEtiqueta} · a aplicar: ${d.aAplicar} · a remover: ${d.aRemover}.` +
          (r.error ? ` Erro: ${r.error}` : ' Veja o console para detalhes.'),
        'erro'
      );
    } else if (r?.ok) {
      mostrarAviso(
        `Etiquetas atualizadas: ${r.vinculadas} aplicada(s), ` +
          `${r.removidas} removida(s).` + (r.error ? ` (avisos: ${r.error})` : ''),
        'ok'
      );
    } else {
      mostrarAviso(
        'Falha ao aplicar etiquetas: ' + (r?.error ?? 'erro desconhecido.'),
        'erro'
      );
    }
  } catch (err) {
    showToast('Erro: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = rotulo ?? 'Aplicar etiquetas de status';
  }
}

/**
 * Reflete no `payloadAtual` (memória + storage + cache) as etiquetas que o PJe
 * confirmou ter escrito/removido. Assim o próximo "Aplicar" enxerga os
 * já-etiquetados pelo check `jaTem` e não os reenvia (revincular etiqueta
 * existente devolve HTTP 500 — associação duplicada).
 */
function aplicarResultadoNoEstado(r: PrevjudAplicarEtiquetasResult): void {
  if (!payloadAtual) return;
  const aplic = r.aplicadasProcessos ?? [];
  const remov = r.removidasProcessos ?? [];
  if (aplic.length === 0 && remov.length === 0) return;

  const porId = new Map<number, ProcessoOrdensPrevjud>();
  for (const p of payloadAtual.processos) porId.set(p.idProcesso, p);

  const igual = (a: string, b: string): boolean =>
    a.trim().toLowerCase() === b.trim().toLowerCase();

  for (const a of aplic) {
    const p = porId.get(a.idProcesso);
    if (!p) continue;
    if (!Array.isArray(p.etiquetas)) p.etiquetas = [];
    if (!p.etiquetas.some((t) => igual(t, a.etiqueta))) p.etiquetas.push(a.etiqueta);
  }
  for (const rm of remov) {
    const p = porId.get(rm.idProcesso);
    if (!p || !Array.isArray(p.etiquetas)) continue;
    p.etiquetas = p.etiquetas.filter((t) => !igual(t, rm.etiqueta));
  }
  void persistirPayloadAtual();
}

/** Regrava o payload atualizado no storage.session (dispara re-render). */
async function persistirPayloadAtual(): Promise<void> {
  if (!payloadAtual || !requestId) return;
  try {
    const key = `${STORAGE_KEYS.PREVJUD_DASHBOARD_PAYLOAD_PREFIX}${requestId}`;
    await chrome.storage.session.set({ [key]: payloadAtual });
  } catch (err) {
    console.warn(`${LOG_PREFIX} persistir payload PREVJUD falhou:`, err);
  }
}

function montarTabela(dados: Linha[]): void {
  const tabela = elTabela;
  const corpo = elTabelaCorpo;
  if (!tabela || !corpo) return;
  linhasVisiveis = dados;

  const thead = tabela.tHead;
  if (thead) {
    thead.innerHTML = '';
    const trHead = document.createElement('tr');
    for (const rotulo of CABECALHO_TABELA) {
      const th = document.createElement('th');
      th.textContent = rotulo;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
  }

  corpo.innerHTML = '';
  if (dados.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.textContent = 'Nenhuma ordem para exibir.';
    td.style.color = 'var(--muted)';
    td.style.textAlign = 'center';
    td.style.padding = '18px';
    tr.appendChild(td);
    corpo.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const l of dados) {
    frag.appendChild(montarLinha(l));
  }
  corpo.appendChild(frag);

  makeTableSortable(tabela, dados, COLUNAS_SORT, {
    initial: { col: 5, dir: 'desc' }
  });
}

function montarLinha(l: Linha): HTMLTableRowElement {
  const { processo: proc, ordem } = l;
  const tr = document.createElement('tr');

  const dias = envelhecimentoDias(ordem);
  if (ordemPendente(ordem) && dias != null && dias >= ALERTA_DIAS) {
    tr.classList.add('row-alerta');
    tr.title = `Ordem pendente há ${dias} dias — candidata a cobrança.`;
  }

  // Processo: link autos + copiar CNJ + abrir tarefa.
  const tdProc = document.createElement('td');
  const cell = document.createElement('span');
  cell.className = 'proc-cell';
  const numero = proc.numeroProcesso ?? String(proc.idProcesso);
  if (proc.urlAutos) {
    const a = document.createElement('a');
    a.className = 'proc-link';
    a.href = proc.urlAutos;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = numero;
    cell.appendChild(a);
  } else {
    const span = document.createElement('span');
    span.textContent = numero;
    cell.appendChild(span);
  }
  if (proc.numeroProcesso) {
    cell.appendChild(
      criarBotaoCopiar({
        className: 'proc-copy',
        titulo: 'Copiar número do processo',
        texto: proc.numeroProcesso
      })
    );
  }
  const idP = String(proc.idProcesso);
  const idT = proc.idTaskInstance != null ? String(proc.idTaskInstance) : '';
  if (proc.urlAutos && podeAbrirTarefa(idP, idT)) {
    const btnTarefa = document.createElement('button');
    btnTarefa.type = 'button';
    btnTarefa.className = 'proc-open-task';
    btnTarefa.title = 'Abrir a tarefa do processo no PJe';
    btnTarefa.setAttribute('aria-label', 'Abrir tarefa');
    btnTarefa.innerHTML = OPEN_TASK_ICON_SVG;
    btnTarefa.addEventListener('click', (ev) => {
      ev.preventDefault();
      const ok = abrirTarefaPopup({
        idProcesso: idP,
        idTaskInstance: idT,
        referenciaUrlAutos: proc.urlAutos
      });
      if (!ok) showToast('Não foi possível abrir a tarefa (popup bloqueado?).');
    });
    cell.appendChild(btnTarefa);
  }
  tdProc.appendChild(cell);
  if (proc.classeJudicial) {
    const cj = document.createElement('div');
    cj.style.color = 'var(--muted)';
    cj.style.fontSize = '11px';
    cj.textContent = proc.classeJudicial;
    tdProc.appendChild(cj);
  }

  const tdEnvio = celula(ordem.dataEnvio ?? '—');
  const tdDias = document.createElement('td');
  if (dias == null) {
    tdDias.textContent = '—';
  } else {
    const badge = document.createElement('span');
    const pend = ordemPendente(ordem);
    badge.className =
      'dias-badge' +
      (pend && dias >= ALERTA_DIAS
        ? ' dias-badge--alerta'
        : pend && dias >= ATENCAO_DIAS
          ? ' dias-badge--atencao'
          : '');
    badge.textContent = String(dias);
    tdDias.appendChild(badge);
  }

  const sit = situacaoPrazo(ordem);
  const tdPrazo = document.createElement('td');
  const bPrazo = document.createElement('span');
  bPrazo.className = `badge ${CLASSE_PRAZO[sit]}`;
  bPrazo.textContent =
    sit === 'sem-prazo' && ordem.finalPrazo ? ordem.finalPrazo : ROTULO_PRAZO[sit];
  tdPrazo.appendChild(bPrazo);
  if (ordem.finalPrazo && sit !== 'sem-prazo') {
    const d = document.createElement('div');
    d.style.color = 'var(--muted)';
    d.style.fontSize = '11px';
    d.textContent = ordem.finalPrazo;
    tdPrazo.appendChild(d);
  }

  const tdCumprida = document.createElement('td');
  const pend = ordemPendente(ordem);
  const bC = document.createElement('span');
  bC.className = `badge ${pend ? 'badge--warn' : 'badge--ok'}`;
  bC.textContent = pend ? 'Pendente' : 'Cumprida';
  tdCumprida.appendChild(bC);

  const tdDoc = document.createElement('td');
  if (ordem.urlDocumento) {
    const a = document.createElement('a');
    a.href = ordem.urlDocumento;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = ordem.idDocumento ?? 'documento';
    tdDoc.appendChild(a);
  } else {
    tdDoc.textContent = ordem.idDocumento ?? '—';
  }

  tr.append(
    tdProc,
    celula(String(ordem.ordem)),
    celula(ordem.status || '—'),
    celula(ordem.servico || '—'),
    tdEnvio,
    tdDias,
    tdPrazo,
    tdCumprida,
    tdDoc
  );
  return tr;
}

function celula(texto: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = texto;
  return td;
}

const COLUNAS_EXCEL: ExcelColumn<Linha>[] = [
  { header: 'Processo', key: (l) => l.processo.numeroProcesso ?? String(l.processo.idProcesso), width: 26 },
  { header: 'Classe', key: (l) => l.processo.classeJudicial ?? '', width: 24 },
  { header: 'Polo ativo', key: (l) => l.processo.poloAtivo ?? '', width: 32 },
  { header: 'Ordem', key: (l) => l.ordem.ordem, type: 'number', width: 8 },
  { header: 'Status', key: (l) => l.ordem.status, width: 22 },
  { header: 'Serviço', key: (l) => l.ordem.servico, width: 36 },
  { header: 'Protocolo', key: (l) => l.ordem.protocolo ?? '', width: 38 },
  { header: 'Data de envio', key: (l) => l.ordem.dataEnvio ?? '', width: 18 },
  { header: 'Dias desde envio', key: (l) => envelhecimentoDias(l.ordem), type: 'number', width: 10 },
  { header: 'Início do prazo', key: (l) => l.ordem.inicioPrazo ?? '', width: 16 },
  { header: 'Final do prazo', key: (l) => l.ordem.finalPrazo ?? '', width: 16 },
  { header: 'Situação do prazo', key: (l) => ROTULO_PRAZO[situacaoPrazo(l.ordem)], width: 14 },
  { header: 'Cumprida', key: (l) => (ordemPendente(l.ordem) ? 'Pendente' : 'Cumprida'), width: 10 },
  { header: 'ID Documento', key: (l) => l.ordem.idDocumento ?? '', width: 14 }
];

// =====================================================================
// Diagnóstico
// =====================================================================

function montarDiagnostico(p: PrevjudDashboardPayload): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'section';
  const h = document.createElement('h2');
  h.textContent = 'Diagnóstico da coleta';
  sec.appendChild(h);

  const ROTULO_ROTA: Record<string, string> = {
    api: 'Coleta via API PREVJUD (gateway PDPJ) — rota rápida.',
    ssr: 'Coleta rápida por fetch (A4J replicado) — sem abrir abas.',
    aba: 'Coleta via abas invisíveis (A4J) — rota de fallback.',
    mista: 'Coleta mista: mais de um mecanismo na mesma varredura.'
  };
  const ul = document.createElement('ul');
  ul.className = 'diag-lista';
  const itens = [
    `${p.diagnostico.processosNaTarefa} processo(s) nas tarefas antes do filtro.`,
    `${p.diagnostico.filtradosPorEtiqueta} candidato(s) após o filtro de etiqueta.`,
    `${p.totais.processosComOrdem} processo(s) com ordem PREVJUD (o restante foi descartado por não ter ordem).`
  ];
  if (typeof p.diagnostico.ordensIgnoradas === 'number') {
    const sts = p.diagnostico.statusIgnorados?.length
      ? ` (status ignorado(s): ${p.diagnostico.statusIgnorados.join(', ')})`
      : '';
    itens.push(`${p.diagnostico.ordensIgnoradas} ordem(ns) ignorada(s)${sts}.`);
  }
  if (p.diagnostico.rotaColeta && ROTULO_ROTA[p.diagnostico.rotaColeta]) {
    itens.push(ROTULO_ROTA[p.diagnostico.rotaColeta]);
  }
  for (const t of itens) {
    const li = document.createElement('li');
    li.textContent = t;
    ul.appendChild(li);
  }
  if (p.diagnostico.falhas.length > 0) {
    const li = document.createElement('li');
    li.className = 'diag-falha';
    li.textContent = `${p.diagnostico.falhas.length} processo(s) falharam na coleta:`;
    ul.appendChild(li);
    for (const f of p.diagnostico.falhas.slice(0, 30)) {
      const sub = document.createElement('li');
      sub.className = 'diag-falha';
      sub.textContent = `• ${f.numeroProcesso ?? f.idProcesso}: ${f.erro}`;
      ul.appendChild(sub);
    }
  }
  sec.appendChild(ul);
  return sec;
}

// =====================================================================
// Utilitários de UI
// =====================================================================

let toastEl: HTMLElement | null = null;
let toastTimer: number | null = null;

function garantirToast(): void {
  if (toastEl) return;
  toastEl = document.createElement('div');
  toastEl.className = 'toast';
  document.body.appendChild(toastEl);
}

function showToast(msg: string): void {
  garantirToast();
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('toast--visible');
  if (toastTimer != null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl?.classList.remove('toast--visible');
  }, 2600);
}

/**
 * Toast persistente (não some sozinho) para mensagens que o usuário precisa
 * ler/copiar — com botão "Copiar" e um "×" para fechar.
 */
function mostrarAviso(msg: string, tom: 'ok' | 'erro'): void {
  document.getElementById('prevjud-aviso')?.remove();
  const box = document.createElement('div');
  box.id = 'prevjud-aviso';
  box.className = 'toast toast--visible';
  box.style.pointerEvents = 'auto';
  box.style.maxWidth = '680px';
  box.style.display = 'flex';
  box.style.gap = '10px';
  box.style.alignItems = 'flex-start';
  box.style.textAlign = 'left';
  box.style.background = tom === 'erro' ? '#7a1f1f' : 'var(--primary-dark)';

  const texto = document.createElement('span');
  texto.style.flex = '1';
  texto.style.lineHeight = '1.5';
  texto.style.maxHeight = '40vh';
  texto.style.overflowY = 'auto';
  texto.textContent = msg;

  const btnCopiar = criarBotaoCopiar({
    className: 'proc-copy',
    titulo: 'Copiar mensagem',
    tamanho: 16,
    texto: msg
  });
  btnCopiar.style.background = 'rgba(255,255,255,0.15)';
  btnCopiar.style.color = '#fff';
  btnCopiar.style.borderColor = 'rgba(255,255,255,0.4)';
  btnCopiar.style.flexShrink = '0';

  const x = document.createElement('button');
  x.type = 'button';
  x.textContent = '×';
  x.title = 'Fechar';
  x.setAttribute('aria-label', 'Fechar');
  x.style.cssText =
    'border:none;background:transparent;color:#fff;font-size:22px;line-height:1;cursor:pointer;flex-shrink:0;padding:0 2px;';
  x.addEventListener('click', () => box.remove());

  box.append(texto, btnCopiar, x);
  document.body.appendChild(box);
}

function registrarLimpezaAoFechar(): void {
  window.addEventListener('pagehide', () => {
    const key = `${STORAGE_KEYS.PREVJUD_DASHBOARD_PAYLOAD_PREFIX}${requestId}`;
    void chrome.storage.session.remove(key).catch(() => { /* ignora */ });
  });
}

function exibirErro(msg: string): void {
  elMain.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'loading erro-msg';
  p.textContent = msg;
  elMain.appendChild(p);
}
