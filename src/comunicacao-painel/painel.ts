/**
 * Aba-painel da "Central de Comunicação" (perfil Secretaria).
 *
 * Topologia simplificada (sem dashboard separado): a mesma aba conduz o
 * usuário pelos estados:
 *   carregando → seletor → progresso → resultado.
 *
 * O usuário escolhe duas dimensões independentes:
 *   - Destinatário (`modo`): perito ou Ceab.
 *   - Canal: WhatsApp ou e-mail.
 *
 * No estado "resultado":
 *   - Modo `cobrar-perito`: agrupa processos por perito (inferido da
 *     etiqueta-pauta). O botão de envio aciona WhatsApp ou e-mail conforme
 *     o canal escolhido — fica desabilitado quando o perito não tem
 *     contato cadastrado para aquele canal.
 *   - Modo `cobrar-ceab`: lista processos numa única mensagem; o botão
 *     único usa o telefone ou o e-mail da Ceab das settings.
 *
 * Cada disparo registra um `RegistroCobranca` em `chrome.storage.local`
 * via canal `COMUNICACAO_REGISTRAR_COBRANCA` (handler no background).
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import {
  defaultComunicacaoSettings,
  listRegistros
} from '../shared/comunicacao-store';
import {
  montarMensagemEmailCeab,
  montarMensagemEmailPerito,
  montarMensagemWhatsAppCeab,
  montarMensagemWhatsAppPerito,
  montarUrlMailto,
  montarUrlWhatsApp,
  normalizarTelefoneWhatsApp
} from '../shared/comunicacao-templates';
import { renderHeaderMeta } from '../shared/header-meta';
import {
  criarBotaoCopiar,
  criarLinkAbrirExterno
} from '../shared/icons';
import type {
  ComunicacaoCanal,
  ComunicacaoColetaResult,
  ComunicacaoFiltro,
  ComunicacaoModo,
  ComunicacaoPainelState,
  ComunicacaoProcesso,
  ComunicacaoSettings,
  PericiaPerito,
  RegistroCobranca
} from '../shared/types';

const sel = {
  carregando: byId('estado-carregando'),
  erro: byId('estado-erro'),
  seletor: byId('estado-seletor'),
  progresso: byId('estado-progresso'),
  resultado: byId('estado-resultado'),
  historico: byId('estado-historico')
};
const elMeta = byId('meta');
const elErroMsg = byId('erro-msg');
const elBtnFechar = byId<HTMLButtonElement>('btn-fechar');
const elBtnCancelar = byId<HTMLButtonElement>('btn-cancelar');
const elBtnColetar = byId<HTMLButtonElement>('btn-coletar');
const elBtnVoltar = byId<HTMLButtonElement>('btn-voltar');
const elFiltroEtiquetaLabel = byId('filtro-etiqueta-label');
const elFiltroEtiquetaNome = byId('filtro-etiqueta-nome');
const elFiltroAviso = byId('filtro-aviso');
const elCanalAviso = byId('canal-aviso');
const elBarLabel = byId('bar-label');
const elBar = byId('bar-fill').parentElement as HTMLElement;
const elLog = byId<HTMLUListElement>('log');
const elResultadoTitulo = byId('resultado-titulo');
const elResultadoResumo = byId('resultado-resumo');
const elResultadoAvisos = byId('resultado-avisos');
const elResultadoGrupos = byId('resultado-grupos');
const elHistoricoLista = byId<HTMLUListElement>('historico-lista');

let requestId = '';
let stateAtual: ComunicacaoPainelState | null = null;

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
          'Central de Comunicação novamente a partir do PJe.'
      );
      return;
    }
    const state = await carregarEstado(requestId);
    if (!state) {
      exibirErro(
        'Não encontrei os dados desta sessão. A aba do PJe pode ter sido ' +
          'fechada. Abra a Central de Comunicação novamente a partir do PJe.'
      );
      return;
    }
    stateAtual = state;
    montarMeta(state);
    renderizarHistorico();
    renderizarSeletor(state);
  } catch (err) {
    console.error(`${LOG_PREFIX} Central de Comunicação: erro ao montar:`, err);
    exibirErro(err instanceof Error ? err.message : String(err));
  }
}

async function carregarEstado(
  rid: string
): Promise<ComunicacaoPainelState | null> {
  const key = `${STORAGE_KEYS.COMUNICACAO_PAINEL_STATE_PREFIX}${rid}`;
  const out = await chrome.storage.session.get(key);
  const raw = out[key];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<ComunicacaoPainelState>;
  if (!Array.isArray(obj.peritos)) return null;
  const settings: ComunicacaoSettings = {
    ...defaultComunicacaoSettings(),
    ...(obj.settings ?? {})
  };
  return {
    requestId: rid,
    hostnamePJe: typeof obj.hostnamePJe === 'string' ? obj.hostnamePJe : '',
    legacyOrigin: typeof obj.legacyOrigin === 'string' ? obj.legacyOrigin : '',
    abertoEm:
      typeof obj.abertoEm === 'string' ? obj.abertoEm : new Date().toISOString(),
    peritos: obj.peritos as PericiaPerito[],
    settings
  };
}

function montarMeta(state: ComunicacaoPainelState): void {
  const nomeVara = state.settings.nomeVara.trim();
  const unidade = nomeVara || state.hostnamePJe;
  const peritosAtivos = state.peritos.filter((p) => p.ativo).length;
  const contadores: string[] = [];
  if (unidade !== state.hostnamePJe && state.hostnamePJe) {
    contadores.push(state.hostnamePJe);
  }
  contadores.push(`${peritosAtivos} perito(s) ativo(s) cadastrado(s)`);
  renderHeaderMeta(elMeta, {
    unidade,
    geradoEm: state.abertoEm,
    contadores
  });
}

/** Header recalculado depois da coleta — inclui contagem de processos. */
function atualizarMetaResultado(resp: ComunicacaoColetaResult): void {
  if (!stateAtual) return;
  const nomeVara = stateAtual.settings.nomeVara.trim();
  const unidade = nomeVara || stateAtual.hostnamePJe;
  const contadores: string[] = [];
  if (unidade !== stateAtual.hostnamePJe && stateAtual.hostnamePJe) {
    contadores.push(stateAtual.hostnamePJe);
  }
  contadores.push(`${resp.total} processo(s) coletado(s)`);
  renderHeaderMeta(elMeta, {
    unidade,
    geradoEm: new Date(),
    contadores
  });
}

function modoSelecionado(): ComunicacaoModo {
  const r = document.querySelector<HTMLInputElement>(
    'input[name="modo"]:checked'
  );
  return (r?.value ?? 'cobrar-perito') as ComunicacaoModo;
}

function canalSelecionado(): ComunicacaoCanal {
  const r = document.querySelector<HTMLInputElement>(
    'input[name="canal"]:checked'
  );
  return (r?.value ?? 'whatsapp') as ComunicacaoCanal;
}

function filtroSelecionado(): ComunicacaoFiltro {
  const r = document.querySelector<HTMLInputElement>(
    'input[name="filtro"]:checked'
  );
  return (r?.value ?? 'tarefa') as ComunicacaoFiltro;
}

function renderizarSeletor(state: ComunicacaoPainelState): void {
  mostrarEstado('seletor');

  const modos = document.querySelectorAll<HTMLLabelElement>('.modo-radio');
  const sincronizarSelecaoModo = (): void => {
    const modo = modoSelecionado();
    modos.forEach((m) => {
      m.classList.toggle('modo-radio--selected', m.dataset.modo === modo);
    });
    sincronizarFiltro(state);
    sincronizarCanal(state);
  };
  modos.forEach((m) =>
    m.querySelector<HTMLInputElement>('input')?.addEventListener('change', sincronizarSelecaoModo)
  );
  document
    .querySelectorAll<HTMLInputElement>('input[name="canal"]')
    .forEach((r) => r.addEventListener('change', () => sincronizarCanal(state)));
  document
    .querySelectorAll<HTMLInputElement>('input[name="filtro"]')
    .forEach((r) => r.addEventListener('change', () => sincronizarFiltro(state)));
  sincronizarSelecaoModo();
}

function sincronizarFiltro(state: ComunicacaoPainelState): void {
  const modo = modoSelecionado();
  const etq =
    modo === 'cobrar-perito'
      ? state.settings.etiquetaCobrancaPerito
      : state.settings.etiquetaCobrancaCeab;
  const trimmed = (etq ?? '').trim();
  const radio = document.querySelector<HTMLInputElement>(
    'input[name="filtro"][value="etiqueta"]'
  );
  if (!radio) return;
  if (trimmed) {
    elFiltroEtiquetaNome.textContent = trimmed;
    elFiltroEtiquetaLabel.classList.remove('is-disabled');
    radio.disabled = false;
    elFiltroAviso.textContent = '';
  } else {
    elFiltroEtiquetaNome.textContent = 'sem etiqueta cadastrada';
    elFiltroEtiquetaLabel.classList.add('is-disabled');
    radio.disabled = true;
    if (radio.checked) {
      const padrao = document.querySelector<HTMLInputElement>(
        'input[name="filtro"][value="tarefa"]'
      );
      if (padrao) padrao.checked = true;
    }
    elFiltroAviso.textContent =
      'Para usar o filtro por etiqueta, cadastre o nome da etiqueta nas ' +
      'configurações da extensão (popup → Central de Comunicação).';
  }
}

/**
 * Valida se o canal escolhido é viável para o modo atual:
 *   - Ceab: precisa do contato (telefone ou e-mail) cadastrado nas settings.
 *   - Perito: para o canal escolhido, ao menos UM perito ativo precisa ter
 *     o contato correspondente — caso contrário, a coleta não tem como ser
 *     executada com o atalho.
 *
 * Quando o canal escolhido não é viável, exibe aviso e desabilita o botão
 * "Coletar processos". O usuário pode trocar o canal ou cadastrar o
 * contato faltante.
 */
function sincronizarCanal(state: ComunicacaoPainelState): void {
  const modo = modoSelecionado();
  const canal = canalSelecionado();
  let aviso = '';
  let bloquear = false;

  if (modo === 'cobrar-ceab') {
    if (canal === 'whatsapp' && !state.settings.telefoneCeab.trim()) {
      aviso = 'Cadastre o telefone (WhatsApp) da Ceab nas configurações para usar este canal.';
      bloquear = true;
    } else if (canal === 'email' && !state.settings.emailCeab.trim()) {
      aviso = 'Cadastre o e-mail da Ceab nas configurações para usar este canal.';
      bloquear = true;
    }
  } else {
    const ativos = state.peritos.filter((p) => p.ativo);
    if (ativos.length === 0) {
      aviso = 'Nenhum perito ativo cadastrado.';
      bloquear = true;
    } else if (canal === 'whatsapp') {
      const comTel = ativos.filter((p) => p.telefone && normalizarTelefoneWhatsApp(p.telefone));
      if (comTel.length === 0) {
        aviso = 'Nenhum perito ativo tem telefone (WhatsApp) cadastrado.';
        bloquear = true;
      } else if (comTel.length < ativos.length) {
        aviso = `${ativos.length - comTel.length} perito(s) ativo(s) sem telefone — só os com telefone poderão ser cobrados.`;
      }
    } else if (canal === 'email') {
      const comEmail = ativos.filter((p) => p.email && p.email.trim());
      if (comEmail.length === 0) {
        aviso = 'Nenhum perito ativo tem e-mail cadastrado.';
        bloquear = true;
      } else if (comEmail.length < ativos.length) {
        aviso = `${ativos.length - comEmail.length} perito(s) ativo(s) sem e-mail — só os com e-mail poderão ser cobrados.`;
      }
    }
  }

  elCanalAviso.textContent = aviso;
  elCanalAviso.style.color = bloquear ? 'var(--danger)' : '';
  elBtnColetar.disabled = bloquear;
}

elBtnFechar.addEventListener('click', () => window.close());
elBtnCancelar.addEventListener('click', () => window.close());
elBtnVoltar.addEventListener('click', () => {
  if (stateAtual) renderizarSeletor(stateAtual);
});
elBtnColetar.addEventListener('click', () => {
  void executarColeta();
});

async function executarColeta(): Promise<void> {
  if (!stateAtual) return;
  const modo = modoSelecionado();
  const canal = canalSelecionado();
  const filtro = filtroSelecionado();
  mostrarEstado('progresso');
  elLog.innerHTML = '';
  elBar.classList.add('indeterminada');
  elBarLabel.textContent = 'Solicitando coleta ao PJe...';
  logLinha(`Destinatário: ${modo} · Canal: ${canal} · Filtro: ${filtro}`);

  try {
    const resp: ComunicacaoColetaResult | undefined =
      await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.COMUNICACAO_RUN_COLETA,
        payload: {
          requestId,
          modo,
          filtro
        }
      });
    if (!resp || !resp.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao coletar processos.';
      logLinha(msg, 'err');
      exibirErro(msg);
      return;
    }
    elBar.classList.remove('indeterminada');
    elBarLabel.textContent = `${resp.total} processo(s) coletado(s).`;
    renderizarResultado(resp, canal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLinha(`Erro: ${msg}`, 'err');
    exibirErro(msg);
  }
}

function renderizarResultado(
  resp: ComunicacaoColetaResult,
  canal: ComunicacaoCanal
): void {
  if (!stateAtual) return;
  mostrarEstado('resultado');
  atualizarMetaResultado(resp);

  const canalLabel = canal === 'whatsapp' ? 'WhatsApp' : 'e-mail';
  elResultadoTitulo.textContent =
    resp.modo === 'cobrar-perito'
      ? `Cobrança de peritos por ${canalLabel}`
      : `Cobrança da Ceab por ${canalLabel}`;
  elResultadoResumo.textContent =
    `${resp.total} processo(s) coletado(s) — filtro: ${resp.filtro}.`;

  elResultadoAvisos.innerHTML = '';
  for (const a of resp.avisos) {
    const div = document.createElement('div');
    div.className = 'aviso';
    div.textContent = a;
    elResultadoAvisos.appendChild(div);
  }

  elResultadoGrupos.innerHTML = '';
  if (resp.processos.length === 0) {
    const vazio = document.createElement('p');
    vazio.className = 'hint';
    vazio.textContent = 'Nenhum processo a cobrar neste momento.';
    elResultadoGrupos.appendChild(vazio);
    return;
  }
  if (resp.modo === 'cobrar-perito') {
    renderizarGruposPorPerito(resp.processos, canal);
  } else {
    renderizarGrupoCeab(resp.processos, canal);
  }
}

function renderizarGruposPorPerito(
  processos: ComunicacaoProcesso[],
  canal: ComunicacaoCanal
): void {
  if (!stateAtual) return;
  const grupos = new Map<string, ComunicacaoProcesso[]>();
  const ordemChaves: string[] = [];
  const chaveDe = (p: ComunicacaoProcesso): string => {
    if (p.peritoId) return `id:${p.peritoId}`;
    if (p.peritoNomeInferido) return `nome:${p.peritoNomeInferido}`;
    return 'sem-perito';
  };
  for (const p of processos) {
    const k = chaveDe(p);
    if (!grupos.has(k)) {
      grupos.set(k, []);
      ordemChaves.push(k);
    }
    grupos.get(k)?.push(p);
  }
  for (const chave of ordemChaves) {
    const lista = grupos.get(chave) ?? [];
    const primeiro = lista[0];
    const perito = primeiro.peritoId
      ? stateAtual.peritos.find((p) => p.id === primeiro.peritoId) ?? null
      : null;
    elResultadoGrupos.appendChild(montarCardPerito(perito, primeiro, lista, canal));
  }
}

function montarCardPerito(
  perito: PericiaPerito | null,
  primeiro: ComunicacaoProcesso,
  lista: ComunicacaoProcesso[],
  canal: ComunicacaoCanal
): HTMLElement {
  if (!stateAtual) throw new Error('state ausente');
  const nomeExibicao = perito
    ? perito.nomeCompleto
    : primeiro.peritoNomeInferido ?? 'Sem perito identificado';
  const card = document.createElement('div');
  card.className = 'grupo-perito';

  const contatoLabel = perito
    ? canal === 'whatsapp'
      ? perito.telefone || 'sem telefone'
      : perito.email || 'sem e-mail'
    : 'não cadastrado';
  const meta = `${lista.length} processo(s) · ${contatoLabel}`;
  card.appendChild(montarHeadCard(nomeExibicao, meta, lista));
  const ul = document.createElement('ul');
  ul.className = 'grupo-perito__processos';
  for (const p of lista) ul.appendChild(itemProcesso(p));
  card.appendChild(ul);

  const actions = document.createElement('div');
  actions.className = 'grupo-perito__actions';
  const btnPreview = document.createElement('button');
  btnPreview.className = 'btn';
  btnPreview.textContent = 'Visualizar mensagem';
  const btnEnviar = document.createElement('button');
  btnEnviar.className = canal === 'whatsapp' ? 'btn whatsapp' : 'btn email';
  btnEnviar.textContent = canal === 'whatsapp' ? 'Abrir WhatsApp' : 'Abrir e-mail';

  // Validação por canal
  let bloqueio: string | null = null;
  if (!perito) {
    bloqueio = 'Perito não cadastrado — adicione-o no popup da extensão.';
  } else if (canal === 'whatsapp') {
    if (!perito.telefone || !normalizarTelefoneWhatsApp(perito.telefone)) {
      bloqueio = 'Cadastre o telefone do perito para usar este atalho.';
    }
  } else {
    if (!perito.email || !perito.email.trim()) {
      bloqueio = 'Cadastre o e-mail do perito para usar este atalho.';
    }
  }
  btnEnviar.disabled = bloqueio !== null;
  if (bloqueio) btnEnviar.title = bloqueio;

  actions.append(btnPreview, btnEnviar);
  card.appendChild(actions);

  const preview = document.createElement('pre');
  preview.className = 'preview';
  card.appendChild(preview);

  btnPreview.addEventListener('click', () => {
    if (!stateAtual) return;
    if (canal === 'whatsapp' && perito) {
      preview.textContent = montarMensagemWhatsAppPerito(
        perito,
        lista,
        stateAtual.settings.nomeVara
      );
    } else if (canal === 'email' && perito) {
      const { subject, body } = montarMensagemEmailPerito(
        perito,
        lista,
        stateAtual.settings.nomeVara
      );
      preview.textContent = `Assunto: ${subject}\n\n${body}`;
    } else {
      preview.textContent = '(perito não cadastrado — não há como gerar a mensagem)';
    }
    preview.classList.toggle('is-visible');
  });

  btnEnviar.addEventListener('click', () => {
    if (!stateAtual || !perito) return;
    if (canal === 'whatsapp') {
      if (!perito.telefone) return;
      const msg = montarMensagemWhatsAppPerito(
        perito,
        lista,
        stateAtual.settings.nomeVara
      );
      const url = montarUrlWhatsApp(perito.telefone, msg);
      if (!url) return;
      window.open(url, '_blank', 'noopener,noreferrer');
      void registrarCobranca({
        modo: 'cobrar-perito',
        canal: 'whatsapp',
        destinatario: perito.nomeCompleto,
        contato: perito.telefone,
        numerosProcesso: lista.map((p) => p.numeroProcesso ?? String(p.idProcesso))
      });
    } else {
      if (!perito.email) return;
      const { subject, body } = montarMensagemEmailPerito(
        perito,
        lista,
        stateAtual.settings.nomeVara
      );
      window.location.href = montarUrlMailto(perito.email, subject, body);
      void registrarCobranca({
        modo: 'cobrar-perito',
        canal: 'email',
        destinatario: perito.nomeCompleto,
        contato: perito.email,
        numerosProcesso: lista.map((p) => p.numeroProcesso ?? String(p.idProcesso))
      });
    }
  });
  return card;
}

function renderizarGrupoCeab(
  processos: ComunicacaoProcesso[],
  canal: ComunicacaoCanal
): void {
  if (!stateAtual) return;
  const settings = stateAtual.settings;
  const card = document.createElement('div');
  card.className = 'grupo-perito';
  const contato =
    canal === 'whatsapp'
      ? settings.telefoneCeab || 'sem telefone cadastrado'
      : settings.emailCeab || 'sem e-mail cadastrado';
  card.appendChild(
    montarHeadCard('Ceab', `${processos.length} processo(s) · ${contato}`, processos)
  );
  const ul = document.createElement('ul');
  ul.className = 'grupo-perito__processos';
  for (const p of processos) ul.appendChild(itemProcesso(p));
  card.appendChild(ul);

  const actions = document.createElement('div');
  actions.className = 'grupo-perito__actions';
  const btnPreview = document.createElement('button');
  btnPreview.className = 'btn';
  btnPreview.textContent = 'Visualizar mensagem';
  const btnEnviar = document.createElement('button');
  btnEnviar.className = canal === 'whatsapp' ? 'btn whatsapp' : 'btn email';
  btnEnviar.textContent = canal === 'whatsapp' ? 'Abrir WhatsApp' : 'Abrir e-mail';
  if (canal === 'whatsapp') {
    btnEnviar.disabled =
      !settings.telefoneCeab.trim() ||
      !normalizarTelefoneWhatsApp(settings.telefoneCeab);
  } else {
    btnEnviar.disabled = !settings.emailCeab.trim();
  }
  actions.append(btnPreview, btnEnviar);
  card.appendChild(actions);

  const preview = document.createElement('pre');
  preview.className = 'preview';
  card.appendChild(preview);

  btnPreview.addEventListener('click', () => {
    if (!stateAtual) return;
    if (canal === 'whatsapp') {
      preview.textContent = montarMensagemWhatsAppCeab(
        processos,
        stateAtual.settings.nomeVara
      );
    } else {
      const { subject, body } = montarMensagemEmailCeab(
        processos,
        stateAtual.settings.nomeVara
      );
      preview.textContent = `Assunto: ${subject}\n\n${body}`;
    }
    preview.classList.toggle('is-visible');
  });

  btnEnviar.addEventListener('click', () => {
    if (!stateAtual) return;
    if (canal === 'whatsapp') {
      const tel = stateAtual.settings.telefoneCeab.trim();
      if (!tel) return;
      const msg = montarMensagemWhatsAppCeab(
        processos,
        stateAtual.settings.nomeVara
      );
      const url = montarUrlWhatsApp(tel, msg);
      if (!url) return;
      window.open(url, '_blank', 'noopener,noreferrer');
      void registrarCobranca({
        modo: 'cobrar-ceab',
        canal: 'whatsapp',
        destinatario: 'Ceab',
        contato: tel,
        numerosProcesso: processos.map((p) => p.numeroProcesso ?? String(p.idProcesso))
      });
    } else {
      const email = stateAtual.settings.emailCeab.trim();
      if (!email) return;
      const { subject, body } = montarMensagemEmailCeab(
        processos,
        stateAtual.settings.nomeVara
      );
      window.location.href = montarUrlMailto(email, subject, body);
      void registrarCobranca({
        modo: 'cobrar-ceab',
        canal: 'email',
        destinatario: 'Ceab',
        contato: email,
        numerosProcesso: processos.map((p) => p.numeroProcesso ?? String(p.idProcesso))
      });
    }
  });
  elResultadoGrupos.appendChild(card);
}

function itemProcesso(p: ComunicacaoProcesso): HTMLLIElement {
  const li = document.createElement('li');
  const numero = p.numeroProcesso ?? `id ${p.idProcesso}`;

  // Número do processo (texto puro — clicar não abre nada).
  const cnj = document.createElement('span');
  cnj.className = 'processo-cnj';
  cnj.textContent = numero;
  li.appendChild(cnj);

  // Ícone de copiar CNJ.
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

  // Tarefa em texto discreto, à direita.
  const tarefa = document.createElement('span');
  tarefa.className = 'processo-tarefa';
  tarefa.style.marginLeft = 'auto';
  tarefa.textContent = p.tarefaNome ? `(${p.tarefaNome})` : '';
  li.appendChild(tarefa);
  return li;
}

/**
 * Cabeçalho do card de grupo (perito ou Ceab): nome + meta + botão de
 * copiar a lista completa de CNJs. O botão usa o mesmo ícone do
 * inline mas com borda discreta para diferenciá-lo visualmente.
 */
function montarHeadCard(
  nomeExibicao: string,
  meta: string,
  lista: ComunicacaoProcesso[]
): HTMLElement {
  const head = document.createElement('div');
  head.className = 'grupo-perito__head';

  const info = document.createElement('span');
  info.className = 'grupo-perito__head-info';
  const nomeEl = document.createElement('span');
  nomeEl.className = 'grupo-perito__nome';
  nomeEl.textContent = nomeExibicao;
  const metaEl = document.createElement('span');
  metaEl.className = 'grupo-perito__meta';
  metaEl.textContent = meta;
  info.append(nomeEl, metaEl);

  const txtLista = lista
    .map((p) => p.numeroProcesso ?? `id ${p.idProcesso}`)
    .join('\n');
  const btnCopiarTudo = criarBotaoCopiar({
    texto: txtLista,
    className: 'grupo-perito__copy-all',
    titulo: `Copiar lista de ${lista.length} processo(s)`,
    tamanho: 16
  });

  head.append(info, btnCopiarTudo);
  return head;
}

async function registrarCobranca(
  payload: Omit<RegistroCobranca, 'id' | 'geradoEm'>
): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.COMUNICACAO_REGISTRAR_COBRANCA,
      payload
    });
    renderizarHistorico();
  } catch (err) {
    console.warn(`${LOG_PREFIX} registrarCobranca falhou:`, err);
  }
}

async function renderizarHistorico(): Promise<void> {
  try {
    const todos = await listRegistros();
    const exibir = todos.slice(0, 30);
    elHistoricoLista.innerHTML = '';
    if (exibir.length === 0) {
      sel.historico.hidden = true;
      return;
    }
    sel.historico.hidden = false;
    for (const r of exibir) {
      const li = document.createElement('li');
      const dt = new Date(r.geradoEm).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      const canalLabel = r.canal === 'whatsapp' ? 'WhatsApp' : 'E-mail';
      li.innerHTML =
        `<span><strong>${escapeHtml(r.destinatario)}</strong> · ${escapeHtml(canalLabel)} · ` +
        `${r.numerosProcesso.length} processo(s)</span>` +
        `<span class="historico__quando">${escapeHtml(dt)}</span>`;
      elHistoricoLista.appendChild(li);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} renderizarHistorico:`, err);
  }
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
    if (k === 'historico') continue;
    sel[k].hidden = k !== nome;
  }
}

function exibirErro(msg: string): void {
  elErroMsg.textContent = msg;
  mostrarEstado('erro');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
