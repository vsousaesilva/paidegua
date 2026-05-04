/**
 * Aba-painel da "Audiência pAIdegua" (perfil Secretaria).
 *
 * Topologia simplificada (mesma da Central de Comunicação):
 *   carregando → seletor → progresso → resultado.
 *
 * No estado "resultado" o usuário vê uma pauta por advogado, com a
 * etiqueta sugerida (no formato "Audiência de Instrução DD.MM.AA")
 * editável e um botão "Inserir etiqueta" que reusa o aplicador das
 * Perícias (canal `AUDIENCIA_APLICAR_ETIQUETAS` no background).
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import {
  lerNomeVaraDasSettings,
  renderHeaderMeta
} from '../shared/header-meta';
import {
  criarBotaoCopiar,
  criarLinkAbrirExterno
} from '../shared/icons';
import type {
  AudienciaColetaResult,
  AudienciaPainelState,
  AudienciaPauta,
  AudienciaPautaItem,
  AudienciaTarefaInfo
} from '../shared/types';

interface AplicarEtiquetasResponse {
  ok: boolean;
  aplicadas: number;
  error?: string;
  idEtiqueta?: number;
}

const sel = {
  carregando: byId('estado-carregando'),
  erro: byId('estado-erro'),
  seletor: byId('estado-seletor'),
  progresso: byId('estado-progresso'),
  resultado: byId('estado-resultado')
};
const elMeta = byId('meta');
const elErroMsg = byId('erro-msg');
const elBtnFechar = byId<HTMLButtonElement>('btn-fechar');
const elBtnCancelar = byId<HTMLButtonElement>('btn-cancelar');
const elBtnColetar = byId<HTMLButtonElement>('btn-coletar');
const elBtnVoltar = byId<HTMLButtonElement>('btn-voltar');
const elInputData = byId<HTMLInputElement>('input-data');
const elInputQtd = byId<HTMLInputElement>('input-qtd');
const elDataAviso = byId('data-aviso');
const elListaTarefas = byId<HTMLUListElement>('lista-tarefas');
const elBarLabel = byId('bar-label');
const elBar = byId('bar-fill').parentElement as HTMLElement;
const elLog = byId<HTMLUListElement>('log');
const elResultadoResumo = byId('resultado-resumo');
const elResultadoAvisos = byId('resultado-avisos');
const elResultadoPautas = byId('resultado-pautas');

let requestId = '';
let stateAtual: AudienciaPainelState | null = null;

void main();

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
}

async function main(): Promise<void> {
  try {
    const params = new URLSearchParams(window.location.search);
    requestId = params.get('rid') ?? '';
    if (!requestId) {
      exibirErro(
        'Identificador de requisição ausente. Feche esta aba e abra a ' +
          'Audiência pAIdegua novamente a partir do PJe.'
      );
      return;
    }
    const state = await carregarEstado(requestId);
    if (!state) {
      exibirErro(
        'Não encontrei os dados desta sessão. A aba do PJe pode ter sido ' +
          'fechada. Abra a Audiência pAIdegua novamente a partir do PJe.'
      );
      return;
    }
    stateAtual = state;
    void montarMeta(state);
    renderizarSeletor(state);
  } catch (err) {
    console.error(`${LOG_PREFIX} Audiência pAIdegua: erro ao montar:`, err);
    exibirErro(err instanceof Error ? err.message : String(err));
  }
}

async function carregarEstado(
  rid: string
): Promise<AudienciaPainelState | null> {
  const key = `${STORAGE_KEYS.AUDIENCIA_PAINEL_STATE_PREFIX}${rid}`;
  const out = await chrome.storage.session.get(key);
  const raw = out[key];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<AudienciaPainelState>;
  if (!Array.isArray(obj.tarefas)) return null;
  return {
    requestId: rid,
    hostnamePJe: typeof obj.hostnamePJe === 'string' ? obj.hostnamePJe : '',
    legacyOrigin: typeof obj.legacyOrigin === 'string' ? obj.legacyOrigin : '',
    abertoEm:
      typeof obj.abertoEm === 'string' ? obj.abertoEm : new Date().toISOString(),
    tarefas: obj.tarefas as AudienciaTarefaInfo[]
  };
}

async function montarMeta(state: AudienciaPainelState): Promise<void> {
  const nomeVara = await lerNomeVaraDasSettings();
  const unidade = nomeVara || state.hostnamePJe;
  const contadores: string[] = [];
  // Mostra o hostname como referência apenas quando a unidade veio das
  // settings (evita duplicar quando o próprio hostname já é a linha 1).
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

/**
 * Versão do header usada no estado "resultado": exibe a unidade, a data
 * da geração e contadores específicos da pauta calculada.
 */
async function atualizarMetaResultado(resp: AudienciaColetaResult): Promise<void> {
  if (!stateAtual) return;
  const nomeVara = await lerNomeVaraDasSettings();
  const unidade = nomeVara || stateAtual.hostnamePJe;
  const totalEmPauta = resp.pautas.reduce(
    (acc, p) => acc + p.quantidadeAtingida,
    0
  );
  const contadores: string[] = [];
  if (unidade !== stateAtual.hostnamePJe && stateAtual.hostnamePJe) {
    contadores.push(stateAtual.hostnamePJe);
  }
  contadores.push(
    `${resp.totalVarridos} processo(s) varrido(s)`,
    `${totalEmPauta} em pauta · ${resp.pautas.length} advogado(s)`
  );
  renderHeaderMeta(elMeta, {
    unidade,
    geradoEm: new Date(),
    contadores
  });
}

function isoDataLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function renderizarSeletor(state: AudienciaPainelState): void {
  mostrarEstado('seletor');
  // Data: mínimo amanhã.
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  elInputData.min = isoDataLocal(amanha);

  elListaTarefas.innerHTML = '';
  if (state.tarefas.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Nenhuma tarefa de audiência encontrada.';
    elListaTarefas.appendChild(li);
  } else {
    state.tarefas.forEach((t, i) => {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `tarefa-${i}`;
      cb.value = t.nome;
      cb.checked = true;
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

  elInputData.addEventListener('change', validarEntrada);
  elInputData.addEventListener('input', validarEntrada);
  elInputQtd.addEventListener('input', validarEntrada);
  validarEntrada();
}

function validarEntrada(): void {
  const raw = elInputData.value;
  let dataOk = false;
  if (!raw) {
    elDataAviso.textContent = 'Informe a data da audiência.';
  } else {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) {
      elDataAviso.textContent = 'Data inválida.';
    } else {
      const escolhida = new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0
      );
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      if (escolhida.getTime() < hoje.getTime() + 24 * 60 * 60 * 1000) {
        elDataAviso.textContent = 'A data deve ser futura (a partir de amanhã).';
      } else {
        elDataAviso.textContent = '';
        dataOk = true;
      }
    }
  }
  const qtd = Math.trunc(Number(elInputQtd.value) || 0);
  const qtdOk = qtd >= 1 && qtd <= 500;
  const pelosMenosUma = Array.from(
    elListaTarefas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  ).some((c) => c.checked);
  elBtnColetar.disabled = !dataOk || !qtdOk || !pelosMenosUma;
}

function tarefasSelecionadas(): string[] {
  return Array.from(
    elListaTarefas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  )
    .filter((c) => c.checked)
    .map((c) => c.value);
}

elBtnFechar.addEventListener('click', () => window.close());
elBtnCancelar.addEventListener('click', () => window.close());
elBtnVoltar.addEventListener('click', () => {
  if (stateAtual) renderizarSeletor(stateAtual);
});
elBtnColetar.addEventListener('click', () => {
  void executarColeta();
});

elListaTarefas.addEventListener('change', validarEntrada);

async function executarColeta(): Promise<void> {
  if (!stateAtual) return;
  const nomes = tarefasSelecionadas();
  const qtd = Math.max(1, Math.trunc(Number(elInputQtd.value) || 1));
  const dataISO = elInputData.value;
  if (!dataISO || nomes.length === 0) return;

  mostrarEstado('progresso');
  elLog.innerHTML = '';
  elBar.classList.add('indeterminada');
  elBarLabel.textContent = 'Solicitando coleta ao PJe...';
  logLinha(`Tarefas: ${nomes.length} · qtd/advogado: ${qtd} · data: ${dataISO}`);

  try {
    const resp: AudienciaColetaResult | undefined =
      await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.AUDIENCIA_RUN_COLETA,
        payload: {
          requestId,
          nomesTarefas: nomes,
          quantidadePorPauta: qtd,
          dataAudienciaISO: dataISO
        }
      });
    if (!resp || !resp.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao coletar processos.';
      logLinha(msg, 'err');
      exibirErro(msg);
      return;
    }
    elBar.classList.remove('indeterminada');
    elBarLabel.textContent =
      `${resp.totalVarridos} processo(s) varrido(s), ${resp.pautas.length} pauta(s).`;
    renderizarResultado(resp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLinha(`Erro: ${msg}`, 'err');
    exibirErro(msg);
  }
}

function renderizarResultado(resp: AudienciaColetaResult): void {
  mostrarEstado('resultado');
  void atualizarMetaResultado(resp);
  const totalEmPauta = resp.pautas.reduce((acc, p) => acc + p.quantidadeAtingida, 0);
  elResultadoResumo.textContent =
    `${resp.totalVarridos} processo(s) varrido(s), ${totalEmPauta} em pauta, ` +
    `distribuídos entre ${resp.pautas.length} advogado(s).`;

  elResultadoAvisos.innerHTML = '';
  for (const a of resp.avisos) {
    const div = document.createElement('div');
    div.className = 'aviso';
    div.textContent = a;
    elResultadoAvisos.appendChild(div);
  }

  elResultadoPautas.innerHTML = '';
  if (resp.pautas.length === 0) {
    const vazio = document.createElement('p');
    vazio.className = 'hint';
    vazio.textContent = 'Nenhum advogado identificado para compor a pauta.';
    elResultadoPautas.appendChild(vazio);
    return;
  }
  for (const p of resp.pautas) {
    elResultadoPautas.appendChild(renderizarPauta(p));
  }
  if (resp.naoAgrupados.length > 0) {
    const card = document.createElement('div');
    card.className = 'pauta';
    const head = document.createElement('div');
    head.className = 'pauta__head';
    const info = document.createElement('span');
    info.className = 'pauta__head-info';
    const titulo = document.createElement('span');
    titulo.className = 'pauta__advogado';
    titulo.textContent = 'Não agrupados';
    const cont = document.createElement('span');
    cont.className = 'pauta__contagem';
    cont.textContent = `${resp.naoAgrupados.length} processo(s)`;
    info.append(titulo, cont);
    head.appendChild(info);
    const cnjsLista = resp.naoAgrupados
      .map((it) => it.numeroProcesso ?? `id ${it.idProcesso}`)
      .join('\n');
    head.appendChild(
      criarBotaoCopiar({
        texto: cnjsLista,
        className: 'pauta__copy-all',
        titulo: `Copiar lista de ${resp.naoAgrupados.length} processo(s)`,
        tamanho: 16
      })
    );
    card.appendChild(head);
    const ul = document.createElement('ul');
    ul.className = 'pauta__processos';
    for (const it of resp.naoAgrupados) ul.appendChild(itemProcesso(it));
    card.appendChild(ul);
    elResultadoPautas.appendChild(card);
  }
}

function renderizarPauta(p: AudienciaPauta): HTMLElement {
  const card = document.createElement('div');
  card.className = 'pauta';

  const head = document.createElement('div');
  head.className = 'pauta__head';
  const info = document.createElement('span');
  info.className = 'pauta__head-info';
  const adv = document.createElement('span');
  adv.className = 'pauta__advogado';
  adv.textContent = p.advogadoNome;
  info.appendChild(adv);
  if (p.advogadoOab) {
    const oab = document.createElement('span');
    oab.className = 'pauta__oab';
    oab.textContent = p.advogadoOab;
    info.appendChild(oab);
  }
  const contagem = document.createElement('span');
  contagem.className = 'pauta__contagem';
  contagem.textContent = `${p.quantidadeAtingida}/${p.quantidadePedida}`;
  info.appendChild(contagem);
  head.appendChild(info);

  // Botão "copiar toda a lista" — ao lado do nome, no canto direito.
  const cnjsLista = p.itens
    .map((it) => it.numeroProcesso ?? `id ${it.idProcesso}`)
    .join('\n');
  const btnCopyAll = criarBotaoCopiar({
    texto: cnjsLista,
    className: 'pauta__copy-all',
    titulo: `Copiar lista de ${p.itens.length} processo(s)`,
    tamanho: 16
  });
  head.appendChild(btnCopyAll);
  card.appendChild(head);

  const etqLinha = document.createElement('div');
  etqLinha.className = 'pauta__etiqueta';
  const labelEtq = document.createElement('label');
  labelEtq.textContent = 'Etiqueta:';
  labelEtq.style.fontSize = '12px';
  labelEtq.style.color = 'var(--muted)';
  const inputEtq = document.createElement('input');
  inputEtq.type = 'text';
  inputEtq.className = 'input';
  inputEtq.value = p.etiquetaPauta;
  etqLinha.append(labelEtq, inputEtq);
  card.appendChild(etqLinha);

  const ul = document.createElement('ul');
  ul.className = 'pauta__processos';
  for (const it of p.itens) ul.appendChild(itemProcesso(it));
  card.appendChild(ul);

  const actions = document.createElement('div');
  actions.className = 'pauta__actions';
  const cbFav = document.createElement('input');
  cbFav.type = 'checkbox';
  cbFav.id = `fav-${p.advogadoNome.replace(/\W+/g, '-')}`;
  cbFav.checked = true;
  const lblFav = document.createElement('label');
  lblFav.htmlFor = cbFav.id;
  lblFav.append(cbFav, document.createTextNode(' Favoritar etiqueta'));
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = 'Inserir etiqueta';
  const status = document.createElement('span');
  status.className = 'pauta__resultado';
  actions.append(lblFav, btn, status);
  card.appendChild(actions);

  btn.addEventListener('click', () => {
    void aplicarEtiqueta(
      inputEtq.value.trim(),
      p.itens,
      cbFav.checked,
      btn,
      status
    );
  });
  return card;
}

async function aplicarEtiqueta(
  etiqueta: string,
  itens: AudienciaPautaItem[],
  favoritar: boolean,
  btn: HTMLButtonElement,
  status: HTMLElement
): Promise<void> {
  if (!etiqueta) {
    status.classList.add('is-err');
    status.textContent = 'Informe um nome de etiqueta.';
    return;
  }
  if (itens.length === 0) {
    status.classList.add('is-err');
    status.textContent = 'Pauta vazia.';
    return;
  }
  btn.disabled = true;
  status.classList.remove('is-err');
  status.textContent = 'Aplicando...';
  try {
    const resp: AplicarEtiquetasResponse | undefined =
      await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.AUDIENCIA_APLICAR_ETIQUETAS,
        payload: {
          requestId,
          etiquetaPauta: etiqueta,
          idsProcesso: itens.map((it) => it.idProcesso),
          favoritarAposCriar: favoritar
        }
      });
    if (!resp || !resp.ok) {
      status.classList.add('is-err');
      status.textContent = resp?.error ?? 'Falha ao aplicar etiqueta.';
      btn.disabled = false;
      return;
    }
    status.textContent = `${resp.aplicadas} processo(s) com etiqueta aplicada.`;
  } catch (err) {
    status.classList.add('is-err');
    status.textContent = err instanceof Error ? err.message : String(err);
    btn.disabled = false;
  }
}

function itemProcesso(p: AudienciaPautaItem): HTMLLIElement {
  const li = document.createElement('li');
  const numero = p.numeroProcesso ?? `id ${p.idProcesso}`;

  // Número (clicável quando há URL, texto puro caso contrário).
  const cnj = document.createElement('span');
  cnj.className = 'processo-cnj';
  cnj.textContent = numero;
  li.appendChild(cnj);

  // Ícone de copiar CNJ (substitui o antigo botão "Copiar CNJ" textual).
  li.appendChild(
    criarBotaoCopiar({
      texto: numero,
      className: 'proc-copy',
      titulo: `Copiar número do processo ${numero}`
    })
  );

  // Ícone de abrir os autos no PJe (quando a URL foi resolvida).
  const linkExterno = criarLinkAbrirExterno({
    url: p.url,
    className: 'proc-open-external',
    titulo: 'Abrir autos no PJe'
  });
  if (linkExterno) li.appendChild(linkExterno);

  // Meta — classe judicial em discreto, à direita.
  const meta = document.createElement('span');
  meta.style.color = 'var(--muted)';
  meta.style.fontSize = '11px';
  meta.style.marginLeft = 'auto';
  meta.textContent = p.classeJudicial ? `(${p.classeJudicial})` : '';
  li.appendChild(meta);
  return li;
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
  nome: 'carregando' | 'erro' | 'seletor' | 'progresso' | 'resultado'
): void {
  for (const k of Object.keys(sel) as Array<keyof typeof sel>) {
    sel[k].hidden = k !== nome;
  }
}

function exibirErro(msg: string): void {
  elErroMsg.textContent = msg;
  mostrarEstado('erro');
}

