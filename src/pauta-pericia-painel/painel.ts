/**
 * Aba-painel do "Painel de Perícias pAIdegua" (perfil Gestão). Espelha o
 * prevjud-painel: seleção de tarefas + etiquetas de filtro (busca, chips,
 * modo qualquer/todas). No lugar do "ignorar cumpridas", oferece uma
 * multi-seleção de SITUAÇÕES a ignorar.
 *
 * Fluxo: lê `?rid=` → estado em `chrome.storage.session` → ao confirmar,
 * dispara `PAUTA_PERICIA_START_COLETA` → background → `RUN_COLETA` na aba do
 * PJe; progresso via `COLETA_PROG`, fim via `COLETA_READY` (dashboard) / `_FAIL`.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import { lerNomeVaraDasSettings, renderHeaderMeta } from '../shared/header-meta';
import {
  clearAllEtiquetas,
  listEtiquetas,
  saveEtiquetas
} from '../shared/etiquetas-store';
import type { EtiquetaRecord } from '../shared/etiquetas-store';
import type {
  PJeApiEtiqueta,
  PJeApiEtiquetasListResponse
} from '../shared/types';
import type {
  PautaPericiaColetaConfig,
  PautaPericiaPainelState
} from '../shared/pauta-pericia-types';

const selEstados = {
  carregando: document.getElementById('estado-carregando') as HTMLElement,
  erro: document.getElementById('estado-erro') as HTMLElement,
  seletor: document.getElementById('estado-seletor') as HTMLElement,
  progresso: document.getElementById('estado-progresso') as HTMLElement
};

const elMeta = document.getElementById('meta') as HTMLElement;
const elErroMsg = document.getElementById('erro-msg') as HTMLElement;
const elListaTarefas = document.getElementById('lista-tarefas') as HTMLElement;
const elContadorTarefas = document.getElementById('contador-tarefas') as HTMLElement;
const elListaEtiquetas = document.getElementById('lista-etiquetas') as HTMLElement;
const elInputEtiquetasBusca = document.getElementById('input-etiquetas-busca') as HTMLInputElement;
const elContadorEtiquetas = document.getElementById('contador-etiquetas') as HTMLElement;
const elChipsSelecionadas = document.getElementById('etiquetas-selecionadas') as HTMLElement;
const elBtnEtiquetasLimpar = document.getElementById('btn-etiquetas-limpar') as HTMLButtonElement;
const elBtnEtiquetasRecarregar = document.getElementById('btn-etiquetas-recarregar') as HTMLButtonElement;
const elBtnTarefasTodas = document.getElementById('btn-tarefas-todas') as HTMLButtonElement;
const elBtnTarefasLimpar = document.getElementById('btn-tarefas-limpar') as HTMLButtonElement;
const elListaSituacoes = document.getElementById('lista-situacoes') as HTMLElement;
const elContadorSituacoes = document.getElementById('contador-situacoes') as HTMLElement;
const elBtnSituacoesLimpar = document.getElementById('btn-situacoes-limpar') as HTMLButtonElement;
const elCacheAviso = document.getElementById('cache-aviso') as HTMLElement;
const elCacheAvisoTexto = document.getElementById('cache-aviso-texto') as HTMLElement;
const elBtnReabrir = document.getElementById('btn-reabrir') as HTMLButtonElement;
const elBtnCancelar = document.getElementById('btn-cancelar') as HTMLButtonElement;
const elBtnConfirmar = document.getElementById('btn-confirmar') as HTMLButtonElement;
const elBtnFechar = document.getElementById('btn-fechar') as HTMLButtonElement;
const elProgressoResumo = document.getElementById('progresso-resumo') as HTMLElement;
const elBarFill = document.getElementById('bar-fill') as HTMLElement;
const elBarLabel = document.getElementById('bar-label') as HTMLElement;
const elLog = document.getElementById('log') as HTMLElement;
const elBar = elBarFill.parentElement as HTMLElement;

let requestId = '';
let stateAtual: PautaPericiaPainelState | null = null;
let totalAcumulado = 0;
let coletadosAcumulado = 0;
let catalogoEtiquetas: string[] = [];

void main();

async function main(): Promise<void> {
  try {
    requestId = new URLSearchParams(window.location.search).get('rid') ?? '';
    if (!requestId) {
      exibirErro('Identificador de requisição ausente. Feche esta aba e abra o Painel de Perícias novamente a partir do PJe.');
      return;
    }
    const state = await carregarEstado(requestId);
    if (!state) {
      exibirErro('Não encontrei os dados desta sessão. A aba do PJe pode ter sido fechada. Abra a ferramenta novamente a partir do PJe.');
      return;
    }
    stateAtual = state;
    void montarMeta(state);
    registrarListenerBackground();
    await renderizarSeletor(state);
  } catch (err) {
    console.error(`${LOG_PREFIX} painel de perícias falhou ao montar:`, err);
    exibirErro(err instanceof Error ? err.message : String(err));
  }
}

async function carregarEstado(rid: string): Promise<PautaPericiaPainelState | null> {
  const key = `${STORAGE_KEYS.PAUTA_PERICIA_PAINEL_STATE_PREFIX}${rid}`;
  const out = await chrome.storage.session.get(key);
  const raw = out[key];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PautaPericiaPainelState>;
  if (!Array.isArray(obj.tarefas)) return null;
  return {
    requestId: rid,
    tarefas: obj.tarefas,
    situacoes: Array.isArray(obj.situacoes) ? obj.situacoes : [],
    hostnamePJe: typeof obj.hostnamePJe === 'string' ? obj.hostnamePJe : '',
    legacyOrigin: typeof obj.legacyOrigin === 'string' ? obj.legacyOrigin : '',
    abertoEm: typeof obj.abertoEm === 'string' ? obj.abertoEm : new Date().toISOString()
  };
}

async function montarMeta(state: PautaPericiaPainelState): Promise<void> {
  const nomeVara = await lerNomeVaraDasSettings();
  const unidade = nomeVara || state.hostnamePJe;
  const contadores: string[] = [];
  if (unidade !== state.hostnamePJe && state.hostnamePJe) contadores.push(state.hostnamePJe);
  contadores.push(`${state.tarefas.length} tarefa(s) no painel`);
  renderHeaderMeta(elMeta, { unidade, geradoEm: state.abertoEm, contadores });
}

async function renderizarSeletor(state: PautaPericiaPainelState): Promise<void> {
  mostrarEstado('seletor');
  void mostrarAvisoCache();
  const salvo = await lerSelecaoSalva();

  // Tarefas
  elListaTarefas.innerHTML = '';
  if (state.tarefas.length === 0) {
    const li = document.createElement('li');
    li.className = 'lista-vazia';
    li.textContent = 'Nenhuma tarefa encontrada no painel atual.';
    elListaTarefas.appendChild(li);
  } else {
    state.tarefas.forEach((t, i) => {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `tarefa-${i}`;
      cb.value = t.nome;
      cb.checked = salvo ? salvo.nomesTarefas.includes(t.nome) : true;
      cb.addEventListener('change', atualizarContadores);
      const label = document.createElement('label');
      label.htmlFor = cb.id;
      const nome = document.createElement('span');
      nome.textContent = t.nome;
      const qtd = document.createElement('span');
      qtd.className = 'qtd';
      qtd.textContent = t.quantidade === null ? '' : `(${t.quantidade})`;
      label.append(nome, qtd);
      li.append(cb, label);
      elListaTarefas.appendChild(li);
    });
  }

  // Modo de etiqueta
  if (salvo) {
    const radio = document.querySelector<HTMLInputElement>(
      `input[name="etiqueta-modo"][value="${salvo.etiquetaModo}"]`
    );
    if (radio) radio.checked = true;
  }

  // Situações a ignorar
  renderizarSituacoes(state.situacoes, new Set(salvo?.situacoesIgnorar ?? []));

  await carregarEtiquetas(salvo?.etiquetasFiltro ?? []);
  atualizarContadores();
}

// ---------- Situações ----------

function renderizarSituacoes(situacoes: string[], marcadas: Set<string>): void {
  elListaSituacoes.innerHTML = '';
  if (situacoes.length === 0) {
    const li = document.createElement('li');
    li.className = 'lista-vazia';
    li.textContent = 'Não consegui carregar a lista de situações — a coleta trará todas.';
    elListaSituacoes.appendChild(li);
    atualizarContadorSituacoes();
    return;
  }
  situacoes.forEach((nome, i) => {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `sit-${i}`;
    cb.value = nome;
    cb.checked = marcadas.has(nome);
    cb.addEventListener('change', atualizarContadorSituacoes);
    const label = document.createElement('label');
    label.htmlFor = cb.id;
    const span = document.createElement('span');
    span.textContent = nome;
    label.appendChild(span);
    li.append(cb, label);
    elListaSituacoes.appendChild(li);
  });
  atualizarContadorSituacoes();
}

function situacoesIgnorar(): string[] {
  return Array.from(elListaSituacoes.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter((c) => c.checked)
    .map((c) => c.value);
}

function atualizarContadorSituacoes(): void {
  const n = situacoesIgnorar().length;
  elContadorSituacoes.textContent =
    n === 0 ? 'Nenhuma (traz todas as situações)' : `${n} situação(ões) a ignorar`;
}

// ---------- Etiquetas (idêntico ao PREVJUD) ----------

function normalizarBuscaEtq(s: string): string {
  return s
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function carregarEtiquetas(selecionadas: string[]): Promise<void> {
  let registros: EtiquetaRecord[] = [];
  try {
    registros = await listEtiquetas();
  } catch (err) {
    console.warn(`${LOG_PREFIX} falha ao ler catálogo de etiquetas:`, err);
  }
  const nomes = new Set<string>();
  for (const r of registros) {
    const n = (r.nomeTag ?? '').trim();
    if (n) nomes.add(n);
  }
  catalogoEtiquetas = Array.from(nomes).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  renderizarEtiquetas(new Set(selecionadas));
}

function renderizarEtiquetas(selecionadas: Set<string>): void {
  elListaEtiquetas.innerHTML = '';
  if (catalogoEtiquetas.length === 0) {
    const li = document.createElement('li');
    li.className = 'lista-vazia';
    li.textContent =
      'Catálogo de etiquetas vazio. Clique em "Recarregar catálogo" (exige uma aba do PJe aberta no painel do usuário). Sem etiquetas marcadas, a varredura considera todos os processos das tarefas.';
    elListaEtiquetas.appendChild(li);
    atualizarContadorEtiquetas();
    return;
  }
  catalogoEtiquetas.forEach((nome, i) => {
    const li = document.createElement('li');
    li.dataset.busca = normalizarBuscaEtq(nome);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `etq-${i}`;
    cb.value = nome;
    cb.checked = selecionadas.has(nome);
    cb.addEventListener('change', atualizarContadorEtiquetas);
    const label = document.createElement('label');
    label.htmlFor = cb.id;
    const span = document.createElement('span');
    span.className = 'etiqueta-nome';
    span.textContent = nome;
    label.appendChild(span);
    li.append(cb, label);
    elListaEtiquetas.appendChild(li);
  });
  atualizarContadorEtiquetas();
}

function aplicarBuscaEtiquetas(): void {
  const q = normalizarBuscaEtq(elInputEtiquetasBusca.value);
  const termos = q ? q.split(' ').filter(Boolean) : [];
  elListaEtiquetas.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
    if (li.classList.contains('lista-vazia')) return;
    const idx = li.dataset.busca ?? '';
    const visivel = termos.length === 0 || termos.every((t) => idx.includes(t));
    li.classList.toggle('is-hidden', !visivel);
  });
}

function atualizarContadorEtiquetas(): void {
  const selecionadas = etiquetasFiltro();
  const sel = selecionadas.length;
  elContadorEtiquetas.textContent =
    sel === 0
      ? 'Sem filtro (todos os processos das tarefas)'
      : `${sel} etiqueta${sel === 1 ? '' : 's'} selecionada${sel === 1 ? '' : 's'}`;
  renderChipsSelecionadas(selecionadas);
}

function renderChipsSelecionadas(selecionadas: string[]): void {
  elChipsSelecionadas.innerHTML = '';
  if (selecionadas.length === 0) {
    elChipsSelecionadas.hidden = true;
    return;
  }
  elChipsSelecionadas.hidden = false;
  const titulo = document.createElement('div');
  titulo.className = 'chips__titulo';
  titulo.textContent = 'Etiquetas escolhidas para a varredura';
  elChipsSelecionadas.appendChild(titulo);
  for (const nome of selecionadas) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const span = document.createElement('span');
    span.className = 'chip__nome';
    span.textContent = nome;
    span.title = nome;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip__x';
    x.textContent = '×';
    x.title = `Remover "${nome}" da seleção`;
    x.setAttribute('aria-label', `Remover ${nome}`);
    x.addEventListener('click', () => desmarcarEtiqueta(nome));
    chip.append(span, x);
    elChipsSelecionadas.appendChild(chip);
  }
}

function desmarcarEtiqueta(nome: string): void {
  elListaEtiquetas
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((c) => {
      if (c.value === nome) c.checked = false;
    });
  atualizarContadorEtiquetas();
}

async function recarregarCatalogo(): Promise<void> {
  const preserva = new Set(etiquetasFiltro());
  elBtnEtiquetasRecarregar.disabled = true;
  const rotulo = elBtnEtiquetasRecarregar.textContent;
  elBtnEtiquetasRecarregar.textContent = 'Buscando...';
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.ETIQUETAS_FETCH_CATALOG,
      payload: { pageSize: 5000 }
    })) as PJeApiEtiquetasListResponse | undefined;
    if (!resp || !resp.ok) {
      elContadorEtiquetas.textContent = resp?.error ?? 'Falha ao buscar o catálogo no PJe.';
      return;
    }
    const now = new Date().toISOString();
    const records: EtiquetaRecord[] = resp.etiquetas.map((e: PJeApiEtiqueta) => ({
      id: e.id,
      nomeTag: e.nomeTag,
      nomeTagCompleto: e.nomeTagCompleto,
      favorita: e.favorita,
      possuiFilhos: e.possuiFilhos,
      idTagFavorita: e.idTagFavorita,
      ingestedAt: now
    }));
    await clearAllEtiquetas();
    await saveEtiquetas(records);
    await carregarEtiquetas(Array.from(preserva));
    aplicarBuscaEtiquetas();
  } catch (err) {
    console.warn(`${LOG_PREFIX} recarregarCatalogo falhou:`, err);
    elContadorEtiquetas.textContent =
      'Erro ao recarregar: ' + (err instanceof Error ? err.message : String(err));
  } finally {
    elBtnEtiquetasRecarregar.disabled = false;
    elBtnEtiquetasRecarregar.textContent = rotulo ?? 'Recarregar catálogo';
  }
}

// ---------- Seleções ----------

function tarefasSelecionadas(): string[] {
  return Array.from(elListaTarefas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter((c) => c.checked)
    .map((c) => c.value);
}

function etiquetasFiltro(): string[] {
  return Array.from(elListaEtiquetas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter((c) => c.checked)
    .map((c) => c.value);
}

function etiquetaModo(): 'qualquer' | 'todas' {
  const marcado = document.querySelector<HTMLInputElement>('input[name="etiqueta-modo"]:checked');
  return marcado?.value === 'todas' ? 'todas' : 'qualquer';
}

function atualizarContadores(): void {
  const sel = tarefasSelecionadas().length;
  elContadorTarefas.textContent =
    sel === 0
      ? 'Nenhuma tarefa selecionada'
      : `${sel} tarefa${sel === 1 ? '' : 's'} selecionada${sel === 1 ? '' : 's'}`;
  elBtnConfirmar.disabled = sel === 0;
}

elBtnTarefasTodas.addEventListener('click', () => {
  elListaTarefas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => { c.checked = true; });
  atualizarContadores();
});
elBtnTarefasLimpar.addEventListener('click', () => {
  elListaTarefas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => { c.checked = false; });
  atualizarContadores();
});
elInputEtiquetasBusca.addEventListener('input', aplicarBuscaEtiquetas);
elBtnEtiquetasLimpar.addEventListener('click', () => {
  elListaEtiquetas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => { c.checked = false; });
  atualizarContadorEtiquetas();
});
elBtnEtiquetasRecarregar.addEventListener('click', () => { void recarregarCatalogo(); });
elBtnSituacoesLimpar.addEventListener('click', () => {
  elListaSituacoes.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => { c.checked = false; });
  atualizarContadorSituacoes();
});
elBtnCancelar.addEventListener('click', () => window.close());
elBtnFechar.addEventListener('click', () => window.close());

elBtnConfirmar.addEventListener('click', () => {
  const nomesTarefas = tarefasSelecionadas();
  if (nomesTarefas.length === 0) return;
  const config: PautaPericiaColetaConfig = {
    nomesTarefas,
    etiquetasFiltro: etiquetasFiltro(),
    etiquetaModo: etiquetaModo(),
    situacoesIgnorar: situacoesIgnorar()
  };
  void salvarSelecao(config);
  void iniciarColeta(config);
});

async function iniciarColeta(config: PautaPericiaColetaConfig): Promise<void> {
  totalAcumulado = 0;
  coletadosAcumulado = 0;
  elLog.innerHTML = '';
  elBarFill.style.width = '0%';
  elBar.classList.add('indeterminada');
  elBarLabel.textContent = 'Preparando...';
  mostrarEstado('progresso');

  elProgressoResumo.textContent =
    config.etiquetasFiltro.length > 0
      ? `Varrendo ${config.nomesTarefas.length} tarefa(s), filtrando por: ${config.etiquetasFiltro.join(', ')}. Não feche esta aba — o painel abre ao final.`
      : `Varrendo ${config.nomesTarefas.length} tarefa(s) SEM filtro de etiqueta (pode demorar). Não feche esta aba.`;
  logLinha('Pedindo ao PJe para varrer as tarefas selecionadas...');

  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PAUTA_PERICIA_START_COLETA,
      payload: { requestId, config }
    });
    if (!resp?.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao iniciar a coleta.';
      logLinha(msg, 'err');
      exibirErro(msg);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLinha(`Erro na comunicação com o PJe: ${msg}`, 'err');
    exibirErro(msg);
  }
}

function registrarListenerBackground(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.channel !== 'string') return false;
    if (sender?.tab) return false;
    const payload = message.payload as { requestId?: string } | undefined;
    if (!payload || payload.requestId !== requestId) return false;

    if (message.channel === MESSAGE_CHANNELS.PAUTA_PERICIA_COLETA_PROG) {
      const msg = (payload as { msg?: string }).msg ?? '';
      logLinha(msg);
      avancarBarra(msg);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.PAUTA_PERICIA_COLETA_READY) {
      logLinha('Abrindo o painel de perícias...', 'ok');
      const url =
        chrome.runtime.getURL('pauta-pericia-dashboard/pauta-pericia-dashboard.html') +
        `?rid=${encodeURIComponent(requestId)}`;
      window.setTimeout(() => window.location.replace(url), 300);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.PAUTA_PERICIA_COLETA_FAIL) {
      const err = (payload as { error?: string }).error ?? 'Erro desconhecido.';
      logLinha(`Falha: ${err}`, 'err');
      exibirErro(err);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}

function avancarBarra(msg: string): void {
  const mFiltro = msg.match(/\[filtro\]\s+(\d+)\//i);
  if (mFiltro) {
    totalAcumulado = Number(mFiltro[1]);
    elBar.classList.remove('indeterminada');
    atualizarBarra();
    return;
  }
  const mColeta = msg.match(/\[coleta\]\s+(\d+)\/(\d+)\b/i);
  if (mColeta) {
    coletadosAcumulado = Math.max(coletadosAcumulado, Number(mColeta[1]));
    totalAcumulado = Math.max(totalAcumulado, Number(mColeta[2]));
    elBar.classList.remove('indeterminada');
    atualizarBarra();
  }
}

function atualizarBarra(): void {
  if (totalAcumulado <= 0) {
    elBarFill.style.width = '0%';
    elBarLabel.textContent = 'Preparando...';
    return;
  }
  const pct = Math.min(100, Math.round((coletadosAcumulado / totalAcumulado) * 100));
  elBarFill.style.width = `${pct}%`;
  elBarLabel.textContent = `${coletadosAcumulado} de ${totalAcumulado} processo${totalAcumulado === 1 ? '' : 's'} · ${pct}%`;
}

function logLinha(msg: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
  if (!msg) return;
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

/**
 * Se houver um relatório salvo (`PAUTA_PERICIA_ULTIMO_RELATORIO`, gravado
 * pelo dashboard ao concluir a coleta), oferece reabri-lo sem nova varredura
 * — a coleta abre cada processo e pode levar minutos.
 */
async function mostrarAvisoCache(): Promise<void> {
  try {
    const out = await chrome.storage.local.get(
      STORAGE_KEYS.PAUTA_PERICIA_ULTIMO_RELATORIO
    );
    const raw = out[STORAGE_KEYS.PAUTA_PERICIA_ULTIMO_RELATORIO] as
      | { geradoEm?: string; totais?: { totalPericias?: number } }
      | undefined;
    if (!raw || typeof raw.geradoEm !== 'string') return;
    const quando = new Date(raw.geradoEm);
    const rotuloQuando = Number.isNaN(quando.getTime())
      ? ''
      : ` de ${quando.toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        })}`;
    const pericias = raw.totais?.totalPericias;
    elCacheAvisoTexto.textContent =
      `Há um relatório salvo${rotuloQuando}` +
      (typeof pericias === 'number' ? ` (${pericias} perícia(s))` : '') +
      '. Você pode reabri-lo sem refazer a coleta.';
    elCacheAviso.hidden = false;
    elBtnReabrir.addEventListener('click', () => {
      const url =
        chrome.runtime.getURL(
          'pauta-pericia-dashboard/pauta-pericia-dashboard.html'
        ) + '?cache=1';
      window.location.replace(url);
    });
  } catch {
    /* sem cache — segue o fluxo normal */
  }
}

interface SelecaoSalva {
  nomesTarefas: string[];
  etiquetasFiltro: string[];
  etiquetaModo: 'qualquer' | 'todas';
  situacoesIgnorar: string[];
}

async function lerSelecaoSalva(): Promise<SelecaoSalva | null> {
  try {
    const out = await chrome.storage.local.get(STORAGE_KEYS.PAUTA_PERICIA_SELECAO);
    const raw = out[STORAGE_KEYS.PAUTA_PERICIA_SELECAO];
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Partial<SelecaoSalva>;
    return {
      nomesTarefas: Array.isArray(o.nomesTarefas) ? o.nomesTarefas : [],
      etiquetasFiltro: Array.isArray(o.etiquetasFiltro) ? o.etiquetasFiltro : [],
      etiquetaModo: o.etiquetaModo === 'todas' ? 'todas' : 'qualquer',
      situacoesIgnorar: Array.isArray(o.situacoesIgnorar) ? o.situacoesIgnorar : []
    };
  } catch {
    return null;
  }
}

async function salvarSelecao(config: PautaPericiaColetaConfig): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.PAUTA_PERICIA_SELECAO]: {
        nomesTarefas: config.nomesTarefas,
        etiquetasFiltro: config.etiquetasFiltro,
        etiquetaModo: config.etiquetaModo ?? 'qualquer',
        situacoesIgnorar: config.situacoesIgnorar ?? []
      }
    });
  } catch {
    /* não crítico */
  }
}

void stateAtual;
