/**
 * Aba intermediária do "Controle Metas CNJ" (perfil Gestão).
 *
 * Espelha `gestao-painel/painel.ts` em forma simplificada:
 *   - Não tem modos (só Metas CNJ).
 *   - Não tem filtros pré-coleta (a configuração de metas vive no
 *     dashboard).
 *   - Estados: carregando → seletor → progresso → (redireciona pro
 *     dashboard ao receber METAS_COLETA_READY) ou erro.
 *
 * Toda a comunicação com o content script da aba PJe passa pelo
 * background, que conhece a rota `requestId → {painelTabId, pjeTabId}`.
 */

import {
  LOG_PREFIX,
  MESSAGE_CHANNELS,
  STORAGE_KEYS
} from '../shared/constants';
import {
  lerNomeVaraDasSettings,
  renderHeaderMeta
} from '../shared/header-meta';

interface PainelState {
  requestId: string;
  tarefas: Array<{ nome: string; quantidade: number | null }>;
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
const elBarLabel = document.getElementById('bar-label') as HTMLElement;
const elLog = document.getElementById('log') as HTMLElement;

let requestId = '';

void main();

async function main(): Promise<void> {
  try {
    const params = new URLSearchParams(window.location.search);
    requestId = params.get('rid') ?? '';
    if (!requestId) {
      exibirErro(
        'Identificador de requisição ausente. Feche e abra novamente a partir do PJe.'
      );
      return;
    }
    const state = await carregarEstado(requestId);
    if (!state) {
      exibirErro(
        'Não encontrei os dados desta sessão. Talvez a aba do PJe tenha sido ' +
          'fechada ou a sessão expirou. Abra novamente a partir do PJe.'
      );
      return;
    }
    void montarMeta(state);
    registrarListenerBackground();
    renderizarSeletor(state);
  } catch (err) {
    console.error(`${LOG_PREFIX} metas-painel falhou ao montar:`, err);
    exibirErro(err instanceof Error ? err.message : String(err));
  }
}

async function carregarEstado(rid: string): Promise<PainelState | null> {
  const key = `${STORAGE_KEYS.METAS_PAINEL_STATE_PREFIX}${rid}`;
  const out = await chrome.storage.session.get(key);
  const raw = out[key];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PainelState>;
  if (!Array.isArray(obj.tarefas)) return null;
  return {
    requestId: rid,
    tarefas: obj.tarefas as PainelState['tarefas'],
    hostnamePJe: typeof obj.hostnamePJe === 'string' ? obj.hostnamePJe : '',
    abertoEm:
      typeof obj.abertoEm === 'string' ? obj.abertoEm : new Date().toISOString()
  };
}

async function montarMeta(state: PainelState): Promise<void> {
  const nomeVara = await lerNomeVaraDasSettings();
  const unidade = nomeVara || state.hostnamePJe;
  const contadores: string[] = [];
  if (unidade !== state.hostnamePJe && state.hostnamePJe) {
    contadores.push(state.hostnamePJe);
  }
  contadores.push(`${state.tarefas.length} tarefa(s) detectada(s)`);
  renderHeaderMeta(elMeta, {
    unidade,
    geradoEm: state.abertoEm,
    contadores
  });
}

function renderizarSeletor(state: PainelState): void {
  mostrarEstado('seletor');

  carregarSelecaoAnterior().then((pre) => {
    const preSet = new Set(pre);
    elLista.innerHTML = '';
    if (state.tarefas.length === 0) {
      const li = document.createElement('li');
      li.className = 'lista-vazia';
      li.textContent =
        'Nenhuma tarefa foi encontrada no painel atual. Confirme que a aba ' +
        'do PJe está no Painel do Usuário.';
      elLista.appendChild(li);
      elBtnConfirmar.disabled = true;
      elBtnTodas.disabled = true;
      elBtnLimpar.disabled = true;
      return;
    }
    for (let i = 0; i < state.tarefas.length; i += 1) {
      const t = state.tarefas[i]!;
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
  });
}

function atualizarContador(): void {
  const cbs = elLista.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]'
  );
  const selecionadas = Array.from(cbs).filter((cb) => cb.checked).length;
  elContador.textContent =
    selecionadas === 0
      ? 'Nenhuma selecionada'
      : `${selecionadas} tarefa${selecionadas === 1 ? '' : 's'} selecionada${selecionadas === 1 ? '' : 's'}`;
  elBtnConfirmar.disabled = selecionadas === 0;
}

function nomesSelecionados(): string[] {
  const cbs = elLista.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]'
  );
  return Array.from(cbs)
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
}

elBtnTodas.addEventListener('click', () => {
  elLista
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((cb) => {
      cb.checked = true;
    });
  atualizarContador();
});
elBtnLimpar.addEventListener('click', () => {
  elLista
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((cb) => {
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
  elLog.innerHTML = '';
  mostrarEstado('progresso');
  elProgressoResumo.textContent =
    `Varrendo ${nomes.length} tarefa${nomes.length === 1 ? '' : 's'}. ` +
    'Não feche esta aba — ela carrega o dashboard automaticamente ao final.';
  logLinha(`Pedindo ao PJe para iniciar a varredura de ${nomes.length} tarefa(s)...`);

  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.METAS_START_COLETA,
      payload: { requestId, nomes }
    });
    if (!resp?.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao iniciar a varredura.';
      logLinha(msg, 'err');
      exibirErro(msg);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLinha(`Erro de comunicação: ${msg}`, 'err');
    exibirErro(msg);
  }
}

function registrarListenerBackground(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.channel !== 'string') return false;
    // Aceita só mensagens via background (sender.tab ausente).
    if (sender?.tab) return false;
    const payload = message.payload as { requestId?: string } | undefined;
    if (!payload || payload.requestId !== requestId) return false;

    if (message.channel === MESSAGE_CHANNELS.METAS_COLETA_PROG) {
      const msg = (payload as { msg?: string }).msg ?? '';
      logLinha(msg);
      // Tenta atualizar label da barra a partir de "Tarefa X/Y" ou "Y/Z"
      const m = msg.match(/(\d+)\/(\d+)/);
      if (m) elBarLabel.textContent = `${m[1]} de ${m[2]}`;
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.METAS_COLETA_READY) {
      logLinha('Varredura concluída — abrindo dashboard...', 'ok');
      const url = chrome.runtime.getURL('metas-dashboard/dashboard.html');
      window.setTimeout(() => window.location.replace(url), 300);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.METAS_COLETA_FAIL) {
      const err = (payload as { error?: string }).error ?? 'Erro desconhecido.';
      logLinha(`Falha: ${err}`, 'err');
      exibirErro(err);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
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

function mostrarEstado(
  nome: 'carregando' | 'erro' | 'seletor' | 'progresso'
): void {
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
    const out = await chrome.storage.local.get(
      STORAGE_KEYS.METAS_TAREFAS_SELECIONADAS
    );
    const raw = out[STORAGE_KEYS.METAS_TAREFAS_SELECIONADAS];
    if (!raw || typeof raw !== 'object') return [];
    const obj = raw as { tarefasSelecionadas?: unknown };
    const lista = obj.tarefasSelecionadas;
    if (!Array.isArray(lista)) return [];
    return lista.filter((x): x is string => typeof x === 'string');
  } catch (err) {
    console.warn(`${LOG_PREFIX} metas-painel carregarSelecao falhou:`, err);
    return [];
  }
}

async function salvarSelecao(nomes: string[]): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.METAS_TAREFAS_SELECIONADAS]: {
        tarefasSelecionadas: nomes,
        salvoEm: new Date().toISOString()
      }
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} metas-painel salvarSelecao falhou:`, err);
  }
}

