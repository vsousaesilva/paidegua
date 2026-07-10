/**
 * Aba-painel da feature "Ordens PREVJUD pAIdegua" (perfil Gestão — GES-10).
 *
 * Fluxo (parelho com pericias-painel):
 *   1. Recebe `?rid=<requestId>`; lê o estado gravado pelo background em
 *      `chrome.storage.session` (`PREVJUD_PAINEL_STATE_PREFIX + rid`).
 *   2. Mostra o seletor de tarefas + as etiquetas de filtro (uma por linha,
 *      casamento por trecho) + o modo (qualquer/todas).
 *   3. Ao confirmar, dispara `PREVJUD_START_COLETA` → background →
 *      `PREVJUD_RUN_COLETA` na aba do PJe.
 *   4. Recebe progresso via `PREVJUD_COLETA_PROG` e fim via
 *      `PREVJUD_COLETA_READY` (navega ao dashboard) ou `_FAIL`.
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
  PJeApiEtiquetasListResponse,
  PrevjudPainelState
} from '../shared/types';

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
const elChkIgnorarCumpridas = document.getElementById('chk-ignorar-cumpridas') as HTMLInputElement;
const elBtnCancelar = document.getElementById('btn-cancelar') as HTMLButtonElement;
const elBtnConfirmar = document.getElementById('btn-confirmar') as HTMLButtonElement;
const elBtnFechar = document.getElementById('btn-fechar') as HTMLButtonElement;
const elProgressoResumo = document.getElementById('progresso-resumo') as HTMLElement;
const elCacheAviso = document.getElementById('cache-aviso') as HTMLElement;
const elCacheAvisoTexto = document.getElementById('cache-aviso-texto') as HTMLElement;
const elBtnReabrir = document.getElementById('btn-reabrir') as HTMLButtonElement;
const elBarFill = document.getElementById('bar-fill') as HTMLElement;
const elBarLabel = document.getElementById('bar-label') as HTMLElement;
const elLog = document.getElementById('log') as HTMLElement;
const elBar = elBarFill.parentElement as HTMLElement;

let requestId = '';
let stateAtual: PrevjudPainelState | null = null;
let totalAcumulado = 0;
let coletadosAcumulado = 0;
/** Catálogo de etiquetas (nomeTag únicos, ordenado) lido do IndexedDB. */
let catalogoEtiquetas: string[] = [];

void main();

async function main(): Promise<void> {
  try {
    const params = new URLSearchParams(window.location.search);
    requestId = params.get('rid') ?? '';
    if (!requestId) {
      exibirErro(
        'Identificador de requisição ausente. Feche esta aba e abra a feature ' +
          'Ordens PREVJUD novamente a partir do PJe.'
      );
      return;
    }
    const state = await carregarEstado(requestId);
    if (!state) {
      exibirErro(
        'Não encontrei os dados desta sessão. A aba do PJe pode ter sido ' +
          'fechada. Abra a ferramenta novamente a partir do PJe.'
      );
      return;
    }
    stateAtual = state;
    void montarMeta(state);
    registrarListenerBackground();
    await renderizarSeletor(state);
  } catch (err) {
    console.error(`${LOG_PREFIX} painel PREVJUD falhou ao montar:`, err);
    exibirErro(err instanceof Error ? err.message : String(err));
  }
}

async function carregarEstado(rid: string): Promise<PrevjudPainelState | null> {
  const key = `${STORAGE_KEYS.PREVJUD_PAINEL_STATE_PREFIX}${rid}`;
  const out = await chrome.storage.session.get(key);
  const raw = out[key];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PrevjudPainelState>;
  if (!Array.isArray(obj.tarefas)) return null;
  return {
    requestId: rid,
    tarefas: obj.tarefas,
    hostnamePJe: typeof obj.hostnamePJe === 'string' ? obj.hostnamePJe : '',
    legacyOrigin: typeof obj.legacyOrigin === 'string' ? obj.legacyOrigin : '',
    abertoEm:
      typeof obj.abertoEm === 'string' ? obj.abertoEm : new Date().toISOString()
  };
}

async function montarMeta(state: PrevjudPainelState): Promise<void> {
  const nomeVara = await lerNomeVaraDasSettings();
  const unidade = nomeVara || state.hostnamePJe;
  const contadores: string[] = [];
  if (unidade !== state.hostnamePJe && state.hostnamePJe) {
    contadores.push(state.hostnamePJe);
  }
  contadores.push(`${state.tarefas.length} tarefa(s) no painel`);
  renderHeaderMeta(elMeta, { unidade, geradoEm: state.abertoEm, contadores });
}

async function renderizarSeletor(state: PrevjudPainelState): Promise<void> {
  mostrarEstado('seletor');

  void mostrarAvisoCache();

  // Pré-preenche a partir da última seleção salva (não é PII).
  const salvo = await lerSelecaoSalva();

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
      // Se houver seleção salva, respeita-a; senão marca todas.
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

  if (salvo) {
    const radio = document.querySelector<HTMLInputElement>(
      `input[name="etiqueta-modo"][value="${salvo.etiquetaModo}"]`
    );
    if (radio) radio.checked = true;
    elChkIgnorarCumpridas.checked = salvo.ignorarCumpridas === true;
  }

  await carregarEtiquetas(salvo?.etiquetasFiltro ?? []);
  atualizarContadores();
}

function normalizarBuscaEtq(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lê o catálogo do IndexedDB e renderiza a lista, marcando `selecionadas`. */
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
  catalogoEtiquetas = Array.from(nomes).sort((a, b) =>
    a.localeCompare(b, 'pt-BR')
  );
  renderizarEtiquetas(new Set(selecionadas));
}

function renderizarEtiquetas(selecionadas: Set<string>): void {
  elListaEtiquetas.innerHTML = '';
  if (catalogoEtiquetas.length === 0) {
    const li = document.createElement('li');
    li.className = 'lista-vazia';
    li.textContent =
      'Catálogo de etiquetas vazio. Clique em "Recarregar catálogo" ' +
      '(exige uma aba do PJe aberta no painel do usuário). Sem etiquetas ' +
      'marcadas, a varredura considera todos os processos das tarefas.';
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

/** Desenha as etiquetas escolhidas como chips destacados (com × para tirar). */
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

/** Desmarca no checklist a etiqueta cujo valor bate com `nome`. */
function desmarcarEtiqueta(nome: string): void {
  const alvo = elListaEtiquetas.querySelector<HTMLInputElement>(
    `input[type="checkbox"][value="${cssEscapar(nome)}"]`
  );
  if (alvo) {
    alvo.checked = false;
  } else {
    // Fallback por comparação de valor (caso o seletor de atributo falhe).
    elListaEtiquetas
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((c) => {
        if (c.value === nome) c.checked = false;
      });
  }
  atualizarContadorEtiquetas();
}

/** Escapa aspas/barras para uso seguro em seletor de atributo. */
function cssEscapar(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}

/** Rebusca o catálogo no PJe (via aba aberta) e regrava no IndexedDB. */
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
      elContadorEtiquetas.textContent =
        resp?.error ?? 'Falha ao buscar o catálogo no PJe.';
      return;
    }
    const now = new Date().toISOString();
    const records: EtiquetaRecord[] = resp.etiquetas.map(
      (e: PJeApiEtiqueta) => ({
        id: e.id,
        nomeTag: e.nomeTag,
        nomeTagCompleto: e.nomeTagCompleto,
        favorita: e.favorita,
        possuiFilhos: e.possuiFilhos,
        idTagFavorita: e.idTagFavorita,
        ingestedAt: now
      })
    );
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

function tarefasSelecionadas(): string[] {
  return Array.from(
    elListaTarefas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  )
    .filter((c) => c.checked)
    .map((c) => c.value);
}

function etiquetasFiltro(): string[] {
  return Array.from(
    elListaEtiquetas.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]'
    )
  )
    .filter((c) => c.checked)
    .map((c) => c.value);
}

function etiquetaModo(): 'qualquer' | 'todas' {
  const marcado = document.querySelector<HTMLInputElement>(
    'input[name="etiqueta-modo"]:checked'
  );
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
  elListaTarefas
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((c) => {
      c.checked = true;
    });
  atualizarContadores();
});
elBtnTarefasLimpar.addEventListener('click', () => {
  elListaTarefas
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((c) => {
      c.checked = false;
    });
  atualizarContadores();
});
elInputEtiquetasBusca.addEventListener('input', aplicarBuscaEtiquetas);
elBtnEtiquetasLimpar.addEventListener('click', () => {
  elListaEtiquetas
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((c) => {
      c.checked = false;
    });
  atualizarContadorEtiquetas();
});
elBtnEtiquetasRecarregar.addEventListener('click', () => {
  void recarregarCatalogo();
});
elBtnCancelar.addEventListener('click', () => window.close());
elBtnFechar.addEventListener('click', () => window.close());

elBtnConfirmar.addEventListener('click', () => {
  const nomesTarefas = tarefasSelecionadas();
  if (nomesTarefas.length === 0) return;
  const filtro = etiquetasFiltro();
  const modo = etiquetaModo();
  void salvarSelecao({
    nomesTarefas,
    etiquetasFiltro: filtro,
    etiquetaModo: modo,
    ignorarCumpridas: elChkIgnorarCumpridas.checked
  });
  void iniciarColeta(nomesTarefas, filtro, modo);
});

async function iniciarColeta(
  nomesTarefas: string[],
  filtro: string[],
  modo: 'qualquer' | 'todas'
): Promise<void> {
  totalAcumulado = 0;
  coletadosAcumulado = 0;
  elLog.innerHTML = '';
  elBarFill.style.width = '0%';
  elBar.classList.add('indeterminada');
  elBarLabel.textContent = 'Preparando...';
  mostrarEstado('progresso');

  elProgressoResumo.textContent =
    filtro.length > 0
      ? `Varrendo ${nomesTarefas.length} tarefa(s), filtrando por: ${filtro.join(', ')}. ` +
        'Não feche esta aba — o painel abre automaticamente ao final.'
      : `Varrendo ${nomesTarefas.length} tarefa(s) SEM filtro de etiqueta (pode demorar). ` +
        'Não feche esta aba.';
  logLinha('Pedindo ao PJe para varrer as tarefas selecionadas...');

  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PREVJUD_START_COLETA,
      payload: {
        requestId,
        nomesTarefas,
        etiquetasFiltro: filtro,
        etiquetaModo: modo,
        ignorarCumpridas: elChkIgnorarCumpridas.checked
      }
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
    if (sender?.tab) return false; // fica só com o relay do background
    const payload = message.payload as { requestId?: string } | undefined;
    if (!payload || payload.requestId !== requestId) return false;

    if (message.channel === MESSAGE_CHANNELS.PREVJUD_COLETA_PROG) {
      const msg = (payload as { msg?: string }).msg ?? '';
      logLinha(msg);
      avancarBarra(msg);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.PREVJUD_COLETA_READY) {
      logLinha('Abrindo o painel — vai populando durante a coleta...', 'ok');
      const url =
        chrome.runtime.getURL('prevjud-dashboard/prevjud-dashboard.html') +
        `?rid=${encodeURIComponent(requestId)}`;
      window.setTimeout(() => window.location.replace(url), 300);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.PREVJUD_COLETA_FAIL) {
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
 * Progresso reconhecido:
 *   - `[filtro] N/M candidato(s)...` → define o denominador (candidatos).
 *   - `[coleta] i/total — <processo>` → atualiza o numerador.
 */
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
  elBarLabel.textContent =
    `${coletadosAcumulado} de ${totalAcumulado} processo${totalAcumulado === 1 ? '' : 's'} · ${pct}%`;
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

/**
 * Se houver um relatório salvo (`PREVJUD_ULTIMO_RELATORIO`, gravado pelo
 * dashboard a cada coleta), oferece reabri-lo sem nova varredura — a
 * coleta abre uma aba por processo e pode levar minutos.
 */
async function mostrarAvisoCache(): Promise<void> {
  try {
    const out = await chrome.storage.local.get(
      STORAGE_KEYS.PREVJUD_ULTIMO_RELATORIO
    );
    const raw = out[STORAGE_KEYS.PREVJUD_ULTIMO_RELATORIO] as
      | { geradoEm?: string; totais?: { totalOrdens?: number } }
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
    const ordens = raw.totais?.totalOrdens;
    elCacheAvisoTexto.textContent =
      `Há um relatório salvo${rotuloQuando}` +
      (typeof ordens === 'number' ? ` (${ordens} ordem(ns))` : '') +
      '. Você pode reabri-lo sem refazer a coleta.';
    elCacheAviso.hidden = false;
    elBtnReabrir.addEventListener('click', () => {
      const url =
        chrome.runtime.getURL('prevjud-dashboard/prevjud-dashboard.html') +
        '?cache=1';
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
  ignorarCumpridas?: boolean;
}

async function lerSelecaoSalva(): Promise<SelecaoSalva | null> {
  try {
    const out = await chrome.storage.local.get(STORAGE_KEYS.PREVJUD_SELECAO);
    const raw = out[STORAGE_KEYS.PREVJUD_SELECAO];
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Partial<SelecaoSalva>;
    return {
      nomesTarefas: Array.isArray(o.nomesTarefas) ? o.nomesTarefas : [],
      etiquetasFiltro: Array.isArray(o.etiquetasFiltro) ? o.etiquetasFiltro : [],
      etiquetaModo: o.etiquetaModo === 'todas' ? 'todas' : 'qualquer',
      ignorarCumpridas: o.ignorarCumpridas === true
    };
  } catch {
    return null;
  }
}

async function salvarSelecao(sel: SelecaoSalva): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.PREVJUD_SELECAO]: sel });
  } catch {
    /* não crítico */
  }
}

void stateAtual;
