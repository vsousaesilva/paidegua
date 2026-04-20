/**
 * Aba intermediária do Painel Gerencial (perfil Gestão).
 *
 * Racional: o modal de seleção anterior era renderizado em shadow-DOM no
 * próprio PJe e ficava por trás do sidebar da aplicação. Esta página é
 * aberta em nova aba (como o dashboard de triagem) e atende três estados:
 *
 *   1. Seleção — lista de tarefas com checkboxes, pré-marcando o que o
 *      usuário escolheu da última vez (`GESTAO_TAREFAS_SELECIONADAS`).
 *   2. Progresso — barra + log ao vivo enquanto a aba PJe varre as
 *      tarefas escolhidas (o content script reporta por mensagens
 *      roteadas pelo background).
 *   3. Conclusão — ao receber `*_COLETA_READY`, navega para o dashboard
 *      correspondente ao modo (Painel Gerencial ou Prazos na Fita).
 *
 * Dois modos de uso, selecionados via query `?modo=`:
 *   - `gestao` (default): Painel Gerencial pAIdegua — lista todas as
 *     tarefas e dispara a coleta agregada de indicadores.
 *   - `prazos`: Prazos na Fita pAIdegua — filtra apenas tarefas cujo
 *     nome contém "Controle de prazo" (case-insensitive) e dispara a
 *     coleta de expedientes via API REST.
 *
 * Esta página NÃO dialoga diretamente com o content script do PJe: todo
 * o roteamento passa pelo background, que conhece o par
 * `painelTabId ↔ pjeTabId` indexado pelo `requestId` carregado na URL.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import type { GestaoTarefaInfo } from '../shared/types';

type ModoPainel = 'gestao' | 'prazos';

interface ModoConfig {
  titulo: string;
  subtitulo: string;
  filtraTarefas: (tarefas: GestaoTarefaInfo[]) => GestaoTarefaInfo[];
  vazioMsg: string;
  startChannel: string;
  progChannel: string;
  doneChannel: string;
  readyChannel: string;
  failChannel: string;
  dashboardUrl: string;
}

const MODOS: Record<ModoPainel, ModoConfig> = {
  gestao: {
    titulo: 'Painel Gerencial',
    subtitulo: 'pAIdegua \u2014 Perfil Gestão',
    filtraTarefas: (t) => t,
    vazioMsg:
      'Nenhuma tarefa foi encontrada no painel atual. Confirme que a aba ' +
      'do PJe está no Painel do Usuário e tente novamente.',
    startChannel: MESSAGE_CHANNELS.GESTAO_START_COLETA,
    progChannel: MESSAGE_CHANNELS.GESTAO_COLETA_PROG,
    doneChannel: MESSAGE_CHANNELS.GESTAO_COLETA_DONE,
    readyChannel: MESSAGE_CHANNELS.GESTAO_COLETA_READY,
    failChannel: MESSAGE_CHANNELS.GESTAO_COLETA_FAIL,
    dashboardUrl: 'gestao-dashboard/gestao-dashboard.html'
  },
  prazos: {
    titulo: 'Prazos na Fita',
    subtitulo: 'pAIdegua \u2014 Perfil Gestão',
    filtraTarefas: (t) =>
      t.filter((x) => /controle\s+de\s+prazo/i.test(x.nome)),
    vazioMsg:
      'Nenhuma tarefa de "Controle de prazo" foi encontrada no painel atual. ' +
      'Confirme que a aba do PJe está no Painel do Usuário e tente novamente.',
    startChannel: MESSAGE_CHANNELS.PRAZOS_FITA_START_COLETA,
    progChannel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_PROG,
    doneChannel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_DONE,
    readyChannel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_READY,
    failChannel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_FAIL,
    dashboardUrl: 'prazos-fita-dashboard/prazos-fita-dashboard.html'
  }
};

interface PainelState {
  requestId: string;
  tarefas: GestaoTarefaInfo[];
  hostnamePJe: string;
  abertoEm: string;
}

const selEstados = {
  carregando: document.getElementById('estado-carregando') as HTMLElement,
  erro: document.getElementById('estado-erro') as HTMLElement,
  seletor: document.getElementById('estado-seletor') as HTMLElement,
  progresso: document.getElementById('estado-progresso') as HTMLElement
};

const elMeta = document.getElementById('meta') as HTMLElement;
const elErroMsg = document.getElementById('erro-msg') as HTMLElement;
const elLista = document.getElementById('lista-tarefas') as HTMLElement;
const elContador = document.getElementById('contador') as HTMLElement;
const elBtnTodas = document.getElementById('btn-todas') as HTMLButtonElement;
const elBtnLimpar = document.getElementById('btn-limpar') as HTMLButtonElement;
const elBtnCancelar = document.getElementById('btn-cancelar') as HTMLButtonElement;
const elBtnConfirmar = document.getElementById('btn-confirmar') as HTMLButtonElement;
const elBtnFechar = document.getElementById('btn-fechar') as HTMLButtonElement;
const elProgressoResumo = document.getElementById('progresso-resumo') as HTMLElement;
const elBarFill = document.getElementById('bar-fill') as HTMLElement;
const elBarLabel = document.getElementById('bar-label') as HTMLElement;
const elLog = document.getElementById('log') as HTMLElement;

let requestId = '';
let stateAtual: PainelState | null = null;
let totalSelecionadas = 0;
let concluidasAtual = 0;
let modo: ModoPainel = 'gestao';
let modoConfig: ModoConfig = MODOS.gestao;
let unidadeAtual: string | null = null;

void main();

async function main(): Promise<void> {
  try {
    const params = new URLSearchParams(window.location.search);
    requestId = params.get('rid') ?? '';
    const modoParam = params.get('modo');
    modo = modoParam === 'prazos' ? 'prazos' : 'gestao';
    modoConfig = MODOS[modo];
    aplicarTextosDoModo();

    if (!requestId) {
      exibirErro(
        'Identificador de requisição ausente. Feche esta aba e abra a ' +
          'ferramenta novamente a partir do PJe.'
      );
      return;
    }

    const state = await carregarEstado(requestId);
    if (!state) {
      exibirErro(
        'Não encontrei os dados desta sessão. Talvez a aba do PJe tenha sido ' +
          'fechada ou a sessão do navegador tenha expirado. Abra a ferramenta ' +
          'novamente a partir do PJe.'
      );
      return;
    }
    stateAtual = {
      ...state,
      tarefas: modoConfig.filtraTarefas(state.tarefas)
    };
    montarMeta(stateAtual);
    registrarListenerBackground();
    await renderizarSeletor(stateAtual);
  } catch (err) {
    console.error(`${LOG_PREFIX} painel (modo=${modo}) falhou ao montar:`, err);
    exibirErro(err instanceof Error ? err.message : String(err));
  }
}

function aplicarTextosDoModo(): void {
  document.title = `pAIdegua \u2014 ${modoConfig.titulo}`;
  const tituloEl = document.querySelector<HTMLElement>('[data-modo-titulo]');
  if (tituloEl) tituloEl.textContent = modoConfig.titulo;
  const subEl = document.querySelector<HTMLElement>('[data-modo-subtitulo]');
  if (subEl) subEl.textContent = modoConfig.subtitulo;
  // Secoes com `data-modo-only` so aparecem no modo declarado.
  document
    .querySelectorAll<HTMLElement>('[data-modo-only]')
    .forEach((el) => {
      const soEm = el.dataset.modoOnly;
      el.hidden = soEm !== modo;
    });
}

/**
 * Le os filtros do formulario de Prazos na Fita. No modo "gestao" a
 * secao de filtros esta escondida; retorna nulls neutros.
 */
function lerFiltrosPrazos(): {
  diasMinNaTarefa: number | null;
  maxProcessosTotal: number | null;
} {
  if (modo !== 'prazos') {
    return { diasMinNaTarefa: null, maxProcessosTotal: null };
  }
  const elDias = document.getElementById(
    'filtro-dias-min'
  ) as HTMLInputElement | null;
  const elMax = document.getElementById(
    'filtro-max-total'
  ) as HTMLSelectElement | null;
  const diasRaw = elDias?.value?.trim() ?? '';
  const diasNum = diasRaw === '' ? 0 : Number(diasRaw);
  const diasMinNaTarefa =
    Number.isFinite(diasNum) && diasNum > 0 ? Math.floor(diasNum) : null;
  const maxRaw = elMax?.value ?? '';
  const maxNum = maxRaw === '' ? null : Number(maxRaw);
  const maxProcessosTotal =
    maxNum != null && Number.isFinite(maxNum) && maxNum > 0
      ? Math.floor(maxNum)
      : null;
  return { diasMinNaTarefa, maxProcessosTotal };
}

async function carregarEstado(rid: string): Promise<PainelState | null> {
  const key = `${STORAGE_KEYS.GESTAO_PAINEL_STATE_PREFIX}${rid}`;
  const out = await chrome.storage.session.get(key);
  const raw = out[key];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PainelState>;
  if (!Array.isArray(obj.tarefas)) return null;
  return {
    requestId: rid,
    tarefas: obj.tarefas as GestaoTarefaInfo[],
    hostnamePJe: typeof obj.hostnamePJe === 'string' ? obj.hostnamePJe : '',
    abertoEm: typeof obj.abertoEm === 'string' ? obj.abertoEm : new Date().toISOString()
  };
}

function montarMeta(state: PainelState): void {
  const dt = new Date(state.abertoEm);
  const dataFmt = dt.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  const topo = unidadeAtual ? unidadeAtual : state.hostnamePJe;
  const segunda = unidadeAtual
    ? `<div>${escapeHtml(state.hostnamePJe)}</div>`
    : '';
  elMeta.innerHTML =
    `<div><strong>${escapeHtml(topo)}</strong></div>` +
    segunda +
    `<div>${escapeHtml(dataFmt)}</div>`;
}

/**
 * O coordinator emite uma linha de progresso com prefixo `[unidade]`
 * assim que tem o primeiro `orgaoJulgador` em mãos. Aqui guardamos e
 * re-renderizamos o bloco meta para mostrar a vara no cabeçalho da aba.
 */
function aplicarUnidadeNoHeader(nome: string): void {
  const limpo = nome.trim();
  if (!limpo) return;
  if (unidadeAtual === limpo) return;
  unidadeAtual = limpo;
  if (stateAtual) montarMeta(stateAtual);
}

async function renderizarSeletor(state: PainelState): Promise<void> {
  mostrarEstado('seletor');

  const pre = await carregarSelecaoAnterior();
  const preSet = new Set(pre);

  elLista.innerHTML = '';
  if (state.tarefas.length === 0) {
    const li = document.createElement('li');
    li.className = 'lista-vazia';
    li.textContent = modoConfig.vazioMsg;
    elLista.appendChild(li);
    elBtnConfirmar.disabled = true;
    elBtnTodas.disabled = true;
    elBtnLimpar.disabled = true;
    return;
  }

  for (let i = 0; i < state.tarefas.length; i += 1) {
    const t = state.tarefas[i];
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `tarefa-${i}`;
    cb.value = t.nome;
    cb.checked = preSet.has(t.nome);
    cb.addEventListener('change', atualizarContador);
    const label = document.createElement('label');
    label.htmlFor = cb.id;
    const nome = document.createElement('span');
    nome.textContent = t.nome;
    const qtd = document.createElement('span');
    qtd.className = 'qtd';
    qtd.textContent = t.quantidade === null ? '' : `(${t.quantidade})`;
    label.append(nome, qtd);
    li.append(cb, label);
    elLista.appendChild(li);
  }

  atualizarContador();
}

function atualizarContador(): void {
  const cbs = elLista.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const selecionadas = Array.from(cbs).filter((cb) => cb.checked).length;
  elContador.textContent =
    selecionadas === 0
      ? 'Nenhuma selecionada'
      : `${selecionadas} tarefa${selecionadas === 1 ? '' : 's'} selecionada${selecionadas === 1 ? '' : 's'}`;
  elBtnConfirmar.disabled = selecionadas === 0;
}

function nomesSelecionados(): string[] {
  const cbs = elLista.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  return Array.from(cbs)
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
}

elBtnTodas.addEventListener('click', () => {
  elLista.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.checked = true;
  });
  atualizarContador();
});
elBtnLimpar.addEventListener('click', () => {
  elLista.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.checked = false;
  });
  atualizarContador();
});
elBtnCancelar.addEventListener('click', () => window.close());
elBtnFechar.addEventListener('click', () => window.close());

elBtnConfirmar.addEventListener('click', () => {
  const nomes = nomesSelecionados();
  if (nomes.length === 0) return;
  void iniciarColeta(nomes);
});

async function iniciarColeta(nomes: string[]): Promise<void> {
  await salvarSelecao(nomes);

  const filtros = lerFiltrosPrazos();

  // Apenas no modo "prazos" temos checkpoint e suporte a retomar —
  // no modo "gestao" a varredura e mais leve (aberta/fechamento do
  // painel Angular) e ainda nao foi instrumentada com checkpoint.
  let retomar = false;
  if (modo === 'prazos') {
    const info = await consultarScanStateExistente(nomes, filtros);
    if (info.hasState && info.total && info.concluidos != null) {
      const restantes = info.total - info.concluidos;
      const minutosAtras = info.updatedAt
        ? Math.max(1, Math.round((Date.now() - info.updatedAt) / 60000))
        : null;
      const msg =
        `Detectei uma varredura anterior interrompida:\n\n` +
        `  - ${info.concluidos}/${info.total} processo(s) ja coletados\n` +
        `  - ${restantes} restam a coletar\n` +
        (minutosAtras != null
          ? `  - atualizada ha ${minutosAtras} minuto(s)\n`
          : '') +
        `\nOK = continuar de onde parou\n` +
        `Cancelar = comecar do zero (perde o trabalho anterior)`;
      retomar = window.confirm(msg);
    }
  }

  totalSelecionadas = nomes.length;
  concluidasAtual = 0;
  elLog.innerHTML = '';
  atualizarBarra();
  mostrarEstado('progresso');
  elProgressoResumo.textContent =
    `Varrendo ${nomes.length} tarefa${nomes.length === 1 ? '' : 's'}. ` +
    'Não feche esta aba — ela carrega o dashboard automaticamente ao final.';

  logLinha(
    retomar
      ? `Retomando varredura anterior de ${nomes.length} tarefa(s)...`
      : `Pedindo ao PJe para iniciar a varredura de ${nomes.length} tarefa(s)...`
  );

  try {
    const resp = await chrome.runtime.sendMessage({
      channel: modoConfig.startChannel,
      payload: { requestId, nomes, ...filtros, retomar }
    });
    if (!resp?.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao iniciar a varredura.';
      logLinha(msg, 'err');
      exibirErro(msg);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLinha(`Erro na comunicação com o PJe: ${msg}`, 'err');
    exibirErro(msg);
  }
}

/**
 * Pergunta ao background se existe um checkpoint "Prazos na Fita"
 * compativel com a selecao atual. O background roteia para a aba do
 * PJe (via requestId) — e la que o `chrome.storage.local` da unidade
 * esta acessivel.
 */
async function consultarScanStateExistente(
  nomes: string[],
  filtros: { diasMinNaTarefa: number | null; maxProcessosTotal: number | null }
): Promise<{
  hasState: boolean;
  scanId?: string;
  concluidos?: number;
  total?: number;
  startedAt?: number;
  updatedAt?: number;
}> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PRAZOS_FITA_QUERY_SCAN_STATE,
      payload: { requestId, nomes, ...filtros }
    });
    if (!resp || typeof resp !== 'object') return { hasState: false };
    return resp as { hasState: boolean };
  } catch {
    return { hasState: false };
  }
}

function registrarListenerBackground(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.channel !== 'string') return false;
    // Esta pagina e uma "extension view" e, como tal, recebe DUAS copias
    // de cada mensagem que o content script envia via `chrome.runtime.
    // sendMessage`: (1) diretamente, pelo broadcast do runtime para todas
    // as views da extensao — com `sender.tab` apontando para a aba do
    // content; (2) indiretamente, pelo relay que o background faz via
    // `chrome.tabs.sendMessage(painelTabId, ...)` — com `sender.tab`
    // ausente (mensagem vinda do service worker). Aceitamos apenas o
    // caminho (2) para deduplicar; o relay pelo background e o canonico,
    // ja valida a rota pelo requestId.
    if (sender?.tab) return false;
    const payload = message.payload as { requestId?: string } | undefined;
    if (!payload || payload.requestId !== requestId) return false;

    if (message.channel === modoConfig.progChannel) {
      const msg = (payload as { msg?: string }).msg ?? '';
      const mUnidade = msg.match(/^\[unidade\]\s+(.+)$/);
      if (mUnidade && mUnidade[1]) {
        aplicarUnidadeNoHeader(mUnidade[1]);
        sendResponse({ ok: true });
        return false;
      }
      logLinha(msg);
      avancarBarra(msg);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === modoConfig.readyChannel) {
      logLinha('Varredura concluída — abrindo dashboard...', 'ok');
      const url = chrome.runtime.getURL(modoConfig.dashboardUrl);
      window.setTimeout(() => {
        window.location.replace(url);
      }, 300);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === modoConfig.failChannel) {
      const err = (payload as { error?: string }).error ?? 'Erro desconhecido.';
      logLinha(`Falha: ${err}`, 'err');
      exibirErro(err);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}

/**
 * Avança o contador com base nas mensagens estruturadas da varredura.
 * O gerador original emite strings como "Tarefa 3/7: ..." e "Tarefa 3/7:
 * N processo(s) lido(s).". Usamos a linha "N processo(s) lido(s)" como
 * marco de conclusão de tarefa — ela aparece uma única vez por tarefa.
 */
function avancarBarra(msg: string): void {
  const m = msg.match(/^Tarefa\s+(\d+)\/(\d+):\s+\d+\s+processo/i);
  if (!m) return;
  const atual = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(atual) || !Number.isFinite(total) || total <= 0) return;
  concluidasAtual = Math.max(concluidasAtual, atual);
  totalSelecionadas = total;
  atualizarBarra();
}

function atualizarBarra(): void {
  const pct =
    totalSelecionadas > 0
      ? Math.min(100, Math.round((concluidasAtual / totalSelecionadas) * 100))
      : 0;
  elBarFill.style.width = `${pct}%`;
  elBarLabel.textContent = `${concluidasAtual} de ${totalSelecionadas} tarefa${totalSelecionadas === 1 ? '' : 's'} concluída${concluidasAtual === 1 ? '' : 's'} · ${pct}%`;
}

function logLinha(msg: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
  const li = document.createElement('li');
  if (kind === 'ok') li.className = 'ok';
  if (kind === 'err') li.className = 'err';
  const hh = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  li.textContent = `[${hh}] ${msg}`;
  elLog.appendChild(li);
  elLog.scrollTop = elLog.scrollHeight;
}

function mostrarEstado(nome: 'carregando' | 'erro' | 'seletor' | 'progresso'): void {
  for (const chave of Object.keys(selEstados) as Array<keyof typeof selEstados>) {
    selEstados[chave].hidden = chave !== nome;
  }
}

function exibirErro(msg: string): void {
  elErroMsg.textContent = msg;
  mostrarEstado('erro');
}

async function carregarSelecaoAnterior(): Promise<string[]> {
  try {
    const out = await chrome.storage.local.get(STORAGE_KEYS.GESTAO_TAREFAS_SELECIONADAS);
    const raw = out[STORAGE_KEYS.GESTAO_TAREFAS_SELECIONADAS];
    if (!raw || typeof raw !== 'object') return [];
    const obj = raw as { tarefasSelecionadas?: unknown };
    const lista = obj.tarefasSelecionadas;
    if (!Array.isArray(lista)) return [];
    return lista.filter((x): x is string => typeof x === 'string');
  } catch (err) {
    console.warn(`${LOG_PREFIX} carregarSelecaoAnterior (painel) falhou:`, err);
    return [];
  }
}

async function salvarSelecao(nomes: string[]): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.GESTAO_TAREFAS_SELECIONADAS]: {
        tarefasSelecionadas: nomes,
        salvoEm: new Date().toISOString()
      }
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} salvarSelecao (painel) falhou:`, err);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Silencia unused-warning do stateAtual — a referência é mantida para
// depuração no console e futuras extensões (ex.: botão "voltar ao seletor").
void stateAtual;
