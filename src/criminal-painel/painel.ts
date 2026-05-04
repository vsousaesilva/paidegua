/**
 * Página `criminal-painel/painel.html` — UI da varredura criminal.
 *
 * Fluxo:
 *   1. Lê o estado da `chrome.storage.session` indexado por `?rid=` na URL
 *      (gravado pelo background ao processar `CRIMINAL_OPEN_PAINEL`).
 *      O estado tem: `tarefas` do painel, `config` local.
 *   2. Renderiza lista de tarefas com checkboxes (todas marcadas).
 *   3. Usuário escolhe modo (rápido/completo) e clica "Iniciar varredura".
 *   4. Envia `CRIMINAL_START_COLETA` ao background, que dispatcha
 *      `CRIMINAL_RUN_COLETA` para a aba PJe correspondente.
 *   5. Recebe progressão via canais `CRIMINAL_COLETA_PROG/SLOT/DONE/FAIL`
 *      e atualiza UI em tempo real. Cada SLOT tem o ProcessoCapturado
 *      e já foi salvo no IndexedDB pelo content script.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';

interface PainelState {
  requestId: string;
  tarefas: Array<{ nome: string; quantidade: number | null }>;
  config: unknown;
  hostnamePJe: string;
  abertoEm: string;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`criminal-painel: elemento #${id} ausente`);
  return el as T;
};

function setEstado(estado: 'carregando' | 'erro' | 'seletor' | 'progresso' | 'concluido'): void {
  for (const id of ['carregando', 'erro', 'seletor', 'progresso', 'concluido']) {
    const sec = document.getElementById(`estado-${id}`);
    if (sec) sec.hidden = id !== estado;
  }
}

function mostrarErro(msg: string): void {
  $<HTMLElement>('erro-msg').textContent = msg;
  setEstado('erro');
}

// ── Estado em memória ────────────────────────────────────────────

let state: PainelState | null = null;
let totalEstimado = 0;
let capturados = 0;
let erros = 0;
let tarefasProcessadas = 0;

// ── Bootstrapping ────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const rid = params.get('rid');
  if (!rid) {
    mostrarErro('Parâmetro rid ausente na URL — recarregue do botão Sigcrim no PJe.');
    return;
  }

  const stateKey = `${STORAGE_KEYS.CRIMINAL_PAINEL_STATE_PREFIX}${rid}`;
  const raw = await chrome.storage.session.get(stateKey);
  const value = raw?.[stateKey] as PainelState | undefined;
  if (!value || !Array.isArray(value.tarefas)) {
    mostrarErro(
      'Estado da aba não encontrado. Feche esta aba e abra o Sigcrim de novo a partir do PJe.'
    );
    return;
  }
  state = value;
  renderSeletor();
  registrarListenerEventos();
}

// ── Seletor de tarefas ────────────────────────────────────────────

function renderSeletor(): void {
  if (!state) return;
  const lista = $<HTMLDivElement>('lista-tarefas');
  lista.innerHTML = '';
  for (const t of state.tarefas) {
    const linha = document.createElement('label');
    linha.className = 'paidegua-criminal-painel__tarefa';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.nome = t.nome;
    const nome = document.createElement('span');
    nome.className = 'paidegua-criminal-painel__tarefa-nome';
    nome.textContent = t.nome;
    const qtd = document.createElement('span');
    qtd.className = 'paidegua-criminal-painel__tarefa-qtd';
    qtd.textContent = t.quantidade != null ? `${t.quantidade} processo(s)` : '—';
    linha.append(cb, nome, qtd);
    cb.addEventListener('change', atualizarResumoSelecao);
    lista.appendChild(linha);
  }
  atualizarResumoSelecao();
  setEstado('seletor');
}

function selecionadas(): { nomes: string[]; total: number } {
  const cbs = document.querySelectorAll<HTMLInputElement>(
    '#lista-tarefas input[type="checkbox"]:checked'
  );
  const nomes = Array.from(cbs)
    .map((cb) => cb.dataset.nome ?? '')
    .filter((n) => n);
  let total = 0;
  for (const cb of Array.from(cbs)) {
    const wrap = cb.closest('.paidegua-criminal-painel__tarefa');
    const qtdText = wrap?.querySelector(
      '.paidegua-criminal-painel__tarefa-qtd'
    )?.textContent ?? '';
    const m = qtdText.match(/(\d+)/);
    if (m) total += Number(m[1]);
  }
  return { nomes, total };
}

function atualizarResumoSelecao(): void {
  const { nomes, total } = selecionadas();
  const resumo = $<HTMLSpanElement>('resumo-selecao');
  if (nomes.length === 0) {
    resumo.textContent = 'Nenhuma tarefa selecionada';
  } else {
    resumo.textContent = `${nomes.length} tarefa(s) · ${total} processo(s) estimado(s)`;
  }
}

function setSelecaoTodas(marcar: boolean): void {
  const cbs = document.querySelectorAll<HTMLInputElement>(
    '#lista-tarefas input[type="checkbox"]'
  );
  for (const cb of Array.from(cbs)) cb.checked = marcar;
  atualizarResumoSelecao();
}

// ── Iniciar varredura ─────────────────────────────────────────────

function lerNumero(id: string, fallback: number): number {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return fallback;
  const n = Number(el.value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

async function iniciarVarredura(): Promise<void> {
  if (!state) return;
  const { nomes, total } = selecionadas();
  if (nomes.length === 0) {
    alert('Selecione pelo menos uma tarefa.');
    return;
  }
  const modoEl = document.querySelector<HTMLInputElement>(
    'input[name="modo"]:checked'
  );
  const modo = modoEl?.value === 'rapido' ? 'rapido' : 'completo';

  const diasMaximos = lerNumero('input-dias', 0);
  const tetoProcessos = lerNumero('input-teto', 1000);
  const concorrencia = Math.min(30, Math.max(1, lerNumero('input-concorrencia', 25)));
  const filtroSiglaEl = document.getElementById(
    'input-filtro-sigla'
  ) as HTMLInputElement | null;
  const filtroSigla = filtroSiglaEl ? filtroSiglaEl.checked : true;

  totalEstimado = total;
  capturados = 0;
  erros = 0;
  tarefasProcessadas = 0;
  $<HTMLElement>('stat-capturados').textContent = '0';
  $<HTMLElement>('stat-erros').textContent = '0';
  $<HTMLElement>('stat-tarefas').textContent = '0';
  $<HTMLDivElement>('progresso-fill').style.width = '0%';
  $<HTMLParagraphElement>('progresso-texto').textContent = 'Iniciando...';
  $<HTMLUListElement>('lista-capturados').innerHTML = '';
  setEstado('progresso');

  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.CRIMINAL_START_COLETA,
      payload: {
        requestId: state.requestId,
        nomesTarefas: nomes,
        modo,
        config: state.config,
        diasMaximos,
        tetoProcessos,
        concorrencia,
        filtroSigla
      }
    })) as { ok: boolean; error?: string };
    if (!resp || !resp.ok) {
      mostrarErro(`Falha ao iniciar varredura: ${resp?.error ?? 'sem detalhes'}`);
      return;
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} criminal-painel: erro disparando coleta:`, err);
    mostrarErro(err instanceof Error ? err.message : 'Erro inesperado.');
  }
}

// ── Listener dos eventos do background ────────────────────────────

function registrarListenerEventos(): void {
  chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
    // CRÍTICO: chrome.runtime.sendMessage de um content script é ENTREGUE
    // tanto ao background QUANTO a todas as páginas da extensão (popup,
    // options, painéis). Isso faz a mesma mensagem chegar duas vezes ao
    // painel: 1) direto do content via broadcast; 2) roteada via
    // tabs.sendMessage do background. O `sender.tab` distingue:
    //   - definido (sender.tab) → veio direto do content (IGNORAR)
    //   - undefined            → veio do background (PROCESSAR)
    if (sender?.tab) return false;
    if (!message || typeof message !== 'object') return false;
    const ch = (message as { channel?: string }).channel;
    if (!ch) return false;
    if (ch === MESSAGE_CHANNELS.CRIMINAL_COLETA_PROG) {
      const msg = (message as { payload?: { texto?: string } }).payload?.texto ?? '';
      $<HTMLParagraphElement>('progresso-texto').textContent = msg;
      // O texto traz informações que permitem ajustar a barra:
      //   - "Pool de N worker(s) coletando M processo(s)..." → fixa o
      //     total real (após filtros de sigla/idade/teto), substituindo
      //     a estimativa otimista feita a partir das contagens das tarefas.
      //   - "[X/Y] número-proc — N réu(s)" → atualiza o denominador Y
      //     (defesa redundante caso a frase do pool não chegue) e o
      //     contador de processados X (inclui erros, mais preciso para
      //     a barra do que `capturados` puro).
      const mPool = msg.match(/coletando\s+(\d+)\s+processo/);
      if (mPool) {
        totalEstimado = Number(mPool[1]);
      }
      const mIter = msg.match(/^\[(\d+)\/(\d+)\]/);
      if (mIter) {
        const processados = Number(mIter[1]);
        const total = Number(mIter[2]);
        if (Number.isFinite(total) && total > 0) totalEstimado = total;
        if (Number.isFinite(processados)) {
          atualizarBarraProgressoPor(processados);
        }
      }
      return false;
    }
    if (ch === MESSAGE_CHANNELS.CRIMINAL_COLETA_SLOT) {
      const slot = (message as { payload?: { numero?: string; nReus?: number } })
        .payload ?? {};
      capturados += 1;
      $<HTMLElement>('stat-capturados').textContent = String(capturados);
      atualizarBarraProgresso();
      adicionarLinhaCapturado(slot.numero ?? '?', slot.nReus ?? 0);
      return false;
    }
    if (ch === MESSAGE_CHANNELS.CRIMINAL_COLETA_DONE) {
      const resumo = (
        message as {
          payload?: {
            capturados?: number;
            erros?: number;
            tarefasProcessadas?: number;
            duracaoMs?: number;
            totalProcessosListados?: number;
            descartadosPorSigla?: number;
            descartadosPorIdade?: number;
            descartadosPorTeto?: number;
            siglasDesconhecidas?: Record<string, number>;
          };
        }
      ).payload ?? {};
      tarefasProcessadas = resumo.tarefasProcessadas ?? tarefasProcessadas;
      $<HTMLElement>('stat-tarefas').textContent = String(tarefasProcessadas);
      finalizarVarredura(resumo);
      return false;
    }
    if (ch === MESSAGE_CHANNELS.CRIMINAL_COLETA_FAIL) {
      const err = (message as { payload?: { error?: string } }).payload?.error ?? 'erro desconhecido';
      mostrarErro(`Varredura interrompida: ${err}`);
      return false;
    }
    return false;
  });
}

function atualizarBarraProgresso(): void {
  atualizarBarraProgressoPor(capturados);
}

/**
 * Variante explícita: usa um numerador `processados` arbitrário em
 * vez do `capturados` puro. O texto de progresso do content traz
 * `[X/Y]` onde X conta sucessos+erros — esse é um numerador mais
 * preciso para a barra, porque erros também consumem tempo do pool
 * e devem aparecer no avanço visual.
 */
function atualizarBarraProgressoPor(processados: number): void {
  const fill = $<HTMLDivElement>('progresso-fill');
  if (totalEstimado <= 0) {
    fill.style.width = '0%';
    return;
  }
  const pct = Math.min(100, Math.round((processados / totalEstimado) * 100));
  fill.style.width = `${pct}%`;
}

function adicionarLinhaCapturado(numero: string, nReus: number): void {
  const lista = $<HTMLUListElement>('lista-capturados');
  const li = document.createElement('li');
  li.className = 'paidegua-criminal-painel__capturado';
  const nome = document.createElement('span');
  nome.className = 'paidegua-criminal-painel__capturado-numero';
  nome.textContent = numero;
  const info = document.createElement('span');
  info.className = 'paidegua-criminal-painel__capturado-info';
  info.textContent = `${nReus} réu(s)`;
  li.append(nome, info);
  lista.insertBefore(li, lista.firstChild);
  // Limita a 50 itens visíveis
  while (lista.children.length > 50) lista.removeChild(lista.lastChild!);
}

function finalizarVarredura(resumo: {
  capturados?: number;
  erros?: number;
  duracaoMs?: number;
  tarefasProcessadas?: number;
  totalProcessosListados?: number;
  descartadosPorSigla?: number;
  descartadosPorIdade?: number;
  descartadosPorTeto?: number;
  siglasDesconhecidas?: Record<string, number>;
}): void {
  const cap = resumo.capturados ?? capturados;
  const err = resumo.erros ?? erros;
  const tar = resumo.tarefasProcessadas ?? tarefasProcessadas;
  const dur = resumo.duracaoMs ?? 0;
  const minutos = Math.round(dur / 60000);
  const segundos = Math.max(1, Math.round(dur / 1000));
  const totListado = resumo.totalProcessosListados ?? 0;
  const dSigla = resumo.descartadosPorSigla ?? 0;
  const dIdade = resumo.descartadosPorIdade ?? 0;
  const dTeto = resumo.descartadosPorTeto ?? 0;

  const linhasFiltro: string[] = [];
  if (totListado > 0) {
    linhasFiltro.push(`<strong>${totListado}</strong> processo(s) listado(s) na Fase 1`);
  }
  if (dSigla > 0) {
    linhasFiltro.push(`${dSigla} descartado(s) por sigla não-criminal`);
  }
  if (dIdade > 0) {
    linhasFiltro.push(`${dIdade} fora da janela de dias`);
  }
  if (dTeto > 0) {
    linhasFiltro.push(`${dTeto} além do teto`);
  }
  const filtroLinha = linhasFiltro.length > 0 ? linhasFiltro.join(' · ') + '.<br>' : '';

  const siglasDesconhecidas = resumo.siglasDesconhecidas ?? {};
  const siglasNaoCatalogadas = Object.entries(siglasDesconhecidas)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k} (${v})`)
    .join(', ');
  const siglasLinha = siglasNaoCatalogadas
    ? `<br><small>Siglas descartadas: ${siglasNaoCatalogadas}. ` +
      'Reporte se alguma deveria estar no catálogo criminal.</small>'
    : '';

  $<HTMLParagraphElement>('resumo-final').innerHTML =
    `<strong>${cap}</strong> processo(s) capturado(s) · ` +
    `<strong>${err}</strong> erro(s) · ` +
    `<strong>${tar}</strong> tarefa(s) processada(s)` +
    (minutos > 0 ? ` · duração ~${minutos} min` : ` · duração ~${segundos}s`) +
    '.<br>' +
    filtroLinha +
    'Os dados foram salvos no IndexedDB local. ' +
    'Abra a configuração para ver as estatísticas do acervo.' +
    siglasLinha;
  setEstado('concluido');
}

// ── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  void bootstrap();

  $<HTMLButtonElement>('btn-todas').addEventListener('click', () =>
    setSelecaoTodas(true)
  );
  $<HTMLButtonElement>('btn-nenhuma').addEventListener('click', () =>
    setSelecaoTodas(false)
  );
  $<HTMLButtonElement>('btn-iniciar').addEventListener('click', () => {
    void iniciarVarredura();
  });
  $<HTMLButtonElement>('btn-cancelar').addEventListener('click', () => {
    window.close();
  });
  $<HTMLButtonElement>('btn-fechar').addEventListener('click', () => {
    window.close();
  });
  $<HTMLButtonElement>('btn-fechar-final').addEventListener('click', () => {
    window.close();
  });
  $<HTMLButtonElement>('btn-config').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL(
      'criminal-config/criminal-config.html'
    );
  });
  $<HTMLButtonElement>('btn-dashboard').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL(
      'criminal-dashboard/dashboard.html'
    );
  });

  // Atalhos do card fixo no topo — sempre visíveis, independem do
  // estado da varredura. Abrem em aba nova para não perder o estado
  // do painel (uma varredura em andamento, p.ex.).
  const abrirEmAba = (path: string): void => {
    const url = chrome.runtime.getURL(path);
    if (chrome.tabs?.create) {
      void chrome.tabs.create({ url });
    } else {
      window.open(url, '_blank');
    }
  };
  $<HTMLButtonElement>('btn-abrir-acervo').addEventListener('click', () => {
    abrirEmAba('criminal-dashboard/dashboard.html');
  });
  $<HTMLButtonElement>('btn-abrir-config').addEventListener('click', () => {
    abrirEmAba('criminal-config/criminal-config.html');
  });
});
