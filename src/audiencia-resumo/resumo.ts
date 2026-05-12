/**
 * Aba "Resumo dos processos da pauta" (AUD-10).
 *
 * Topologia: carregando → seletor (período + situações) → progresso →
 * resultado (tabela de processos).
 *
 * Diferente do painel da Audiência (AUD-08), a coleta não depende das
 * tarefas do painel do usuário — vai direto ao endpoint nativo
 * `ProcessoAudiencia/PautaAudiencia/listView.seam` filtrando por
 * período e situações marcadas. O coletor real vive no content script
 * (mesma origem do PJe = cookies herdados); esta aba pede via
 * `chrome.runtime.sendMessage` → background → tabs.sendMessage.
 *
 * Default das situações: M (Designada) + R (Redesignada) — audiências
 * futuras + remarcadas. Magistrado pode mudar antes de buscar.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import { lerNomeVaraDasSettings, renderHeaderMeta } from '../shared/header-meta';
import { criarBotaoCopiar } from '../shared/icons';
import {
  abrirTarefaPopup,
  OPEN_TASK_ICON_SVG,
  podeAbrirTarefa
} from '../shared/pje-task-popup';
import type { AudienciaResumoPainelState } from '../shared/types';
import { abrirModalResumo, instalarFechamentoDoModal } from './resumo-modal';
import type {
  AudienciaPautaItem,
  AudienciaSituacaoCodigo,
  ColetarPautaResult
} from '../content/audiencia/audiencia-pauta-coletor';

const LOG = `${LOG_PREFIX} [audiencia-resumo/painel]`;

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
const elBtnFecharSeletor = byId<HTMLButtonElement>('btn-fechar-seletor');
const elBtnBuscar = byId<HTMLButtonElement>('btn-buscar');
const elBtnNova = byId<HTMLButtonElement>('btn-nova');
const elInputDataDe = byId<HTMLInputElement>('input-data-de');
const elInputDataAte = byId<HTMLInputElement>('input-data-ate');
const elSituacoesGrupo = byId('situacoes-grupo');
const elBarLabel = byId('bar-label');
const elResultadoTitulo = byId('resultado-titulo');
const elResultadoResumo = byId('resultado-resumo');
const elResultadoTabelaWrap = byId('resultado-tabela-wrap');

let requestId = '';
let stateAtual: AudienciaResumoPainelState | null = null;

/**
 * Cache dos parâmetros da última busca da pauta — usado pelo refetch leve
 * do `ca` por Resumir (Frente 2.5). Cada vez que a pauta é carregada com
 * sucesso, gravamos aqui os filtros + timestamp; antes de cada Resumir
 * refazemos essa mesma busca pra renovar o `ca` do processo alvo.
 */
let paramsUltimaPauta:
  | { dataDe: string; dataAte: string; situacoes: AudienciaSituacaoCodigo[]; loadedAt: number }
  | null = null;

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
        'Identificador de requisição ausente. Feche esta aba e abra o ' +
          '"Resumo dos processos da pauta" novamente a partir do PJe.'
      );
      return;
    }
    const stateKey = `${STORAGE_KEYS.AUDIENCIA_RESUMO_PAINEL_STATE_PREFIX}${requestId}`;
    const data = await chrome.storage.session.get(stateKey);
    const state = data[stateKey] as AudienciaResumoPainelState | undefined;
    if (!state) {
      exibirErro(
        'Estado da aba não encontrado. A sessão pode ter expirado — feche ' +
          'esta aba e abra novamente a partir do PJe.'
      );
      return;
    }
    stateAtual = state;
    await renderMeta(state);
    inicializarSeletor();
    bindEventos();

    // Pré-config via URL: pula seletor e dispara busca direto.
    const preDataDe = params.get('dataDe');
    const preDataAte = params.get('dataAte');
    const preSituacoes = params.get('situacoes');
    if (preDataDe && preDataAte && preSituacoes) {
      // Carrega os inputs (para se o usuário clicar "Nova busca", já vem preenchido).
      elInputDataDe.value = isoFromPtBr(preDataDe);
      elInputDataAte.value = isoFromPtBr(preDataAte);
      const codigos = preSituacoes.split(',').map((s) => s.trim()).filter(Boolean);
      const inputs = elSituacoesGrupo.querySelectorAll<HTMLInputElement>(
        'input[name="situacao"]'
      );
      for (const input of Array.from(inputs)) {
        input.checked = codigos.includes(input.value);
      }
      // Dispara busca imediatamente — usuário não vê o seletor.
      void onBuscar();
    } else {
      transicionar('seletor');
    }
  } catch (err) {
    console.warn(`${LOG} init falhou:`, err);
    exibirErro(errorMessage(err));
  }
}

async function renderMeta(state: AudienciaResumoPainelState): Promise<void> {
  const nomeVara = await lerNomeVaraDasSettings();
  const unidade = nomeVara || state.hostnamePJe || '';
  renderHeaderMeta(elMeta, {
    unidade,
    geradoEm: state.abertoEm
  });
}

function inicializarSeletor(): void {
  const hoje = formatarDataIsoLocal(new Date());
  if (!elInputDataDe.value) elInputDataDe.value = hoje;
  if (!elInputDataAte.value) elInputDataAte.value = hoje;
}

function bindEventos(): void {
  elBtnFechar.addEventListener('click', () => window.close());
  elBtnFecharSeletor.addEventListener('click', () => window.close());
  elBtnBuscar.addEventListener('click', () => {
    void onBuscar();
  });
  elBtnNova.addEventListener('click', () => transicionar('seletor'));
  elInputDataDe.addEventListener('change', () => {
    if (
      elInputDataAte.value &&
      elInputDataDe.value &&
      elInputDataAte.value < elInputDataDe.value
    ) {
      elInputDataAte.value = elInputDataDe.value;
    }
  });
  instalarFechamentoDoModal();
}

async function onBuscar(): Promise<void> {
  if (!stateAtual) return;
  const dataDeIso = elInputDataDe.value.trim();
  const dataAteIso = elInputDataAte.value.trim();
  if (!dataDeIso || !dataAteIso) {
    alert('Informe as duas datas (de e até). Para um único dia, use a mesma data.');
    return;
  }
  if (dataAteIso < dataDeIso) {
    alert('A data "até" não pode ser anterior à data "de".');
    return;
  }
  const situacoes = lerSituacoesSelecionadas();
  if (situacoes.length === 0) {
    alert('Marque ao menos uma situação de audiência (Designada, Redesignada, etc.).');
    return;
  }

  transicionar('progresso');
  elBarLabel.textContent = `Consultando pauta de ${formatarDataPtBr(dataDeIso)} a ${formatarDataPtBr(dataAteIso)}...`;

  let resp: ColetarPautaResult;
  try {
    resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.AUDIENCIA_RESUMO_COLETAR_PAUTA,
      payload: {
        requestId,
        legacyOrigin: stateAtual.legacyOrigin,
        dataDe: formatarDataPtBr(dataDeIso),
        dataAte: formatarDataPtBr(dataAteIso),
        situacoes
      }
    })) as ColetarPautaResult;
  } catch (err) {
    console.warn(`${LOG} sendMessage falhou:`, err);
    exibirErroVoltar(
      'Falha ao contactar a aba do PJe: ' +
        errorMessage(err) +
        '. Verifique se a aba do PJe original ainda está aberta.'
    );
    return;
  }

  if (!resp || !resp.ok) {
    exibirErroVoltar(resp?.error ?? 'Resposta vazia do PJe.');
    return;
  }

  // Cache dos params para o refetch leve do ca por Resumir.
  paramsUltimaPauta = {
    dataDe: formatarDataPtBr(dataDeIso),
    dataAte: formatarDataPtBr(dataAteIso),
    situacoes,
    loadedAt: Date.now()
  };

  renderResultado(resp.itens ?? [], resp.totalInformado);
  transicionar('resultado');
}

/**
 * Refetch leve do `ca` para um processo específico antes do Resumir.
 *
 * Por que: o token `ca` é por processo+sessão e tende a rotacionar quando
 * a sessão do PJe é tocada. Pauta carregada às 9h, Resumir clicado às 11h
 * pode ter `ca` rotacionado → fetches do processo voltam vazios. Refazer
 * a pauta com os mesmos filtros devolve a lista atual com `ca` fresco
 * para todos os processos.
 *
 * Devolve o `ca` fresco do processo (procurado por `idProcesso`); se não
 * achar o processo na pauta atual ou houver qualquer falha, devolve `null`
 * — o caller usa o `ca` antigo como fallback. Nunca bloqueia o Resumir.
 */
async function refetchCaFresco(idProcesso: number): Promise<string | null> {
  if (!paramsUltimaPauta || !stateAtual) return null;
  // Curto-circuito: se a pauta foi carregada há menos de 30s, é praticamente
  // impossível o ca já ter rotacionado — pula o refetch e segue.
  if (Date.now() - paramsUltimaPauta.loadedAt < 30_000) return null;
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.AUDIENCIA_RESUMO_COLETAR_PAUTA,
      payload: {
        requestId,
        legacyOrigin: stateAtual.legacyOrigin,
        dataDe: paramsUltimaPauta.dataDe,
        dataAte: paramsUltimaPauta.dataAte,
        situacoes: paramsUltimaPauta.situacoes
      }
    })) as ColetarPautaResult;
    if (!resp?.ok || !resp.itens) return null;
    const fresco = resp.itens.find((it) => it.idProcesso === idProcesso);
    if (!fresco?.ca) return null;
    // Atualiza timestamp do cache para que cliques subsequentes em <30s
    // não disparem refetch redundante.
    paramsUltimaPauta.loadedAt = Date.now();
    return fresco.ca;
  } catch (err) {
    console.info(`${LOG} refetchCaFresco falhou (segue com ca antigo):`, err);
    return null;
  }
}

function lerSituacoesSelecionadas(): AudienciaSituacaoCodigo[] {
  const inputs = elSituacoesGrupo.querySelectorAll<HTMLInputElement>(
    'input[name="situacao"]:checked'
  );
  const out: AudienciaSituacaoCodigo[] = [];
  for (const input of Array.from(inputs)) {
    const v = input.value as AudienciaSituacaoCodigo;
    if (v === 'M' || v === 'C' || v === 'R' || v === 'F' || v === 'N' || v === 'D') {
      out.push(v);
    }
  }
  return out;
}

function renderResultado(
  itens: AudienciaPautaItem[],
  totalInformado: number | undefined
): void {
  const dataDe = formatarDataPtBr(elInputDataDe.value);
  const dataAte = formatarDataPtBr(elInputDataAte.value);
  const periodo = dataDe === dataAte ? dataDe : `${dataDe} a ${dataAte}`;
  elResultadoTitulo.textContent = `Pauta de ${periodo}`;
  const total = itens.length;
  if (total === 0) {
    elResultadoResumo.textContent = '';
    elResultadoTabelaWrap.innerHTML = `
      <div class="empty">Nenhum processo encontrado para esse período e situações.</div>
    `;
    return;
  }
  const totalTxt =
    totalInformado != null && totalInformado !== total
      ? `${total} de ${totalInformado} processo(s) informado(s) pelo PJe`
      : `${total} processo(s) encontrado(s)`;
  elResultadoResumo.textContent = totalTxt;

  elResultadoTabelaWrap.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'tabela';
  table.innerHTML = `
    <thead>
      <tr>
        <th class="col-data">Data/Hora</th>
        <th class="col-cnj">Processo</th>
        <th>Partes</th>
        <th>Classe</th>
        <th>Tipo</th>
        <th>Situação</th>
        <th class="col-acoes">Ações</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody') as HTMLElement;
  for (const item of itens) {
    tbody.appendChild(criarLinhaProcesso(item));
  }
  elResultadoTabelaWrap.appendChild(table);
}

function criarLinhaProcesso(item: AudienciaPautaItem): HTMLTableRowElement {
  const tr = document.createElement('tr');

  const tdData = document.createElement('td');
  tdData.className = 'col-data';
  tdData.textContent = item.dataHora;
  tr.appendChild(tdData);

  // Coluna processo: número CNJ clicável (abre autos) + ícone copiar + ícone
  // abrir externo. Helpers compartilhados em src/shared/icons.ts.
  const tdCnj = document.createElement('td');
  tdCnj.className = 'col-cnj';
  const cnjLink = document.createElement('a');
  cnjLink.className = 'proc-numero';
  cnjLink.href = item.urlDetalhe;
  cnjLink.target = '_blank';
  cnjLink.rel = 'noopener noreferrer';
  cnjLink.title = 'Abrir autos no PJe';
  cnjLink.textContent = item.cnj;
  tdCnj.appendChild(cnjLink);
  tdCnj.appendChild(
    criarBotaoCopiar({
      texto: item.cnj,
      className: 'proc-copy',
      titulo: `Copiar número do processo ${item.cnj}`
    })
  );
  // Ícone "abrir tarefa": padrão dos dashboards (Gestão, Triagem, Prazos
  // na Fita). Abre `movimentar.seam?idProcesso=X&newTaskId=Y` em popup
  // nomeado, idêntico ao `openPopUp('{idProcesso}popUpFluxo', ...)` do
  // PJe nativo. Quando `idTaskInstance` é null (processo não está em
  // nenhuma das 4 tarefas de audiência da caixa do usuário), o botão
  // fica desabilitado com tooltip explicando.
  const btnTarefa = document.createElement('button');
  btnTarefa.type = 'button';
  btnTarefa.className = 'proc-open-task';
  btnTarefa.innerHTML = OPEN_TASK_ICON_SVG;
  const idProcessoStr = String(item.idProcesso);
  const idTaskStr = item.idTaskInstance != null ? String(item.idTaskInstance) : null;
  if (idTaskStr && podeAbrirTarefa(idProcessoStr, idTaskStr)) {
    btnTarefa.title = 'Abrir tarefa no PJe';
    btnTarefa.setAttribute('aria-label', `Abrir tarefa do processo ${item.cnj}`);
    btnTarefa.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const ok = abrirTarefaPopup({
        idProcesso: idProcessoStr,
        idTaskInstance: idTaskStr,
        referenciaUrlAutos: item.urlDetalhe
      });
      if (!ok) {
        alert('Não foi possível abrir a tarefa (popup bloqueado pelo navegador?).');
      }
    });
  } else {
    btnTarefa.disabled = true;
    btnTarefa.title =
      'Tarefa do processo não localizada na sua caixa (nenhuma tarefa de "Audiência" tem este processo).';
    btnTarefa.setAttribute(
      'aria-label',
      `Tarefa do processo ${item.cnj} não localizada`
    );
  }
  tdCnj.appendChild(btnTarefa);
  tr.appendChild(tdCnj);

  const tdPartes = document.createElement('td');
  tdPartes.innerHTML = `
    <span class="partes-autor">${escapeHtml(item.autor)}</span>
    <span class="partes-vs">×</span>
    <span class="partes-reu">${escapeHtml(item.reu)}</span>
  `;
  tr.appendChild(tdPartes);

  const tdClasse = document.createElement('td');
  tdClasse.textContent = item.classe;
  tr.appendChild(tdClasse);

  const tdTipo = document.createElement('td');
  tdTipo.textContent = item.tipoAudiencia;
  tr.appendChild(tdTipo);

  const tdSit = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge ${classeBadgeSituacao(item.situacao)}`;
  badge.textContent = item.situacao;
  tdSit.appendChild(badge);
  tr.appendChild(tdSit);

  const tdAcoes = document.createElement('td');
  tdAcoes.className = 'col-acoes';
  const btnResumir = document.createElement('button');
  btnResumir.type = 'button';
  btnResumir.className = 'btn-resumir';
  btnResumir.textContent = 'Resumir';
  btnResumir.title = 'Gerar resumo deste processo (lê documentos principais e usa IA)';
  btnResumir.addEventListener('click', async () => {
    if (!stateAtual) return;
    // Refetch leve do `ca` (Frente 2.5) — pula se pauta < 30s.
    // Best-effort: se falhar, segue com o ca cacheado da listagem.
    btnResumir.disabled = true;
    btnResumir.textContent = 'Preparando...';
    let caFinal = item.ca;
    try {
      const fresco = await refetchCaFresco(item.idProcesso);
      if (fresco) caFinal = fresco;
    } finally {
      btnResumir.disabled = false;
      btnResumir.textContent = 'Resumir';
    }
    void abrirModalResumo({
      requestId,
      legacyOrigin: stateAtual.legacyOrigin,
      modo: 'filtrado',
      linha: {
        cnj: item.cnj,
        dataHora: item.dataHora,
        autor: item.autor,
        reu: item.reu,
        classe: item.classe,
        tipoAudiencia: item.tipoAudiencia,
        sala: item.sala,
        situacao: item.situacao,
        orgaoJulgador: item.orgaoJulgador,
        idProcesso: item.idProcesso,
        ca: caFinal
      }
    });
  });
  tdAcoes.appendChild(btnResumir);
  tr.appendChild(tdAcoes);

  return tr;
}

function classeBadgeSituacao(situacao: string): string {
  const s = situacao.toLowerCase();
  if (s.includes('realizada') && !s.includes('não')) return 'is-realizada';
  if (s.includes('cancelada')) return 'is-cancelada';
  if (s.includes('não-realizada') || s.includes('nao-realizada')) return 'is-naorealizada';
  if (s.includes('diligência') || s.includes('diligencia')) return 'is-diligencia';
  return '';
}

function transicionar(estado: 'carregando' | 'erro' | 'seletor' | 'progresso' | 'resultado'): void {
  for (const [k, el] of Object.entries(sel)) {
    el.hidden = k !== estado;
  }
}

function exibirErro(msg: string): void {
  elErroMsg.textContent = msg;
  transicionar('erro');
}

function exibirErroVoltar(msg: string): void {
  alert(msg);
  transicionar('seletor');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatarDataIsoLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatarDataPtBr(iso: string): string {
  // ISO `YYYY-MM-DD` → `DD/MM/YYYY`
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function isoFromPtBr(ptbr: string): string {
  // `DD/MM/YYYY` → `YYYY-MM-DD` (para preencher input type="date")
  const m = ptbr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return ptbr;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

