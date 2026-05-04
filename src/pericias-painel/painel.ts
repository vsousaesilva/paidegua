/**
 * Aba-painel da feature "Perícias pAIdegua" (perfil Secretaria).
 *
 * Fluxo (parelho com o painel-gerencial/prazos-fita):
 *   1. Recebe `?rid=<requestId>` na URL. Lê o snapshot gravado em
 *      `chrome.storage.session` com chave
 *      `PERICIAS_PAINEL_STATE_PREFIX + requestId` (gravado pelo
 *      background em `handleOpenPericiasPainel`).
 *   2. Mostra dois seletores no mesmo card: tarefas do painel (já
 *      filtradas pelo content para conter só "Perícia - Designar" e
 *      "Perícia - Agendar e administrar") e peritos ativos.
 *   3. Ao confirmar, dispara `PERICIAS_START_COLETA` para o background,
 *      que repassa `PERICIAS_RUN_COLETA` para a aba do PJe.
 *   4. Recebe progresso via `PERICIAS_COLETA_PROG` e fim via
 *      `PERICIAS_COLETA_READY` — navega para o dashboard de pauta.
 *
 * Roteamento é feito pelo background usando `setRota/getRota` (mesmas
 * helpers do Painel Gerencial). O `requestId` tem prefixo "pericias-",
 * portanto não colide com rotas gestão/prazos.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import {
  lerNomeVaraDasSettings,
  renderHeaderMeta
} from '../shared/header-meta';
import type {
  PericiaPerito,
  PericiaTarefaInfo,
  PericiasPainelState
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
const elListaPeritos = document.getElementById('lista-peritos') as HTMLElement;
const elContadorTarefas = document.getElementById('contador-tarefas') as HTMLElement;
const elContadorPeritos = document.getElementById('contador-peritos') as HTMLElement;
const elInputDataPericia = document.getElementById(
  'input-data-pericia'
) as HTMLInputElement;
const elDataPericiaAviso = document.getElementById(
  'data-pericia-aviso'
) as HTMLElement;
const elBtnTarefasTodas = document.getElementById('btn-tarefas-todas') as HTMLButtonElement;
const elBtnTarefasLimpar = document.getElementById('btn-tarefas-limpar') as HTMLButtonElement;
const elBtnPeritosTodos = document.getElementById('btn-peritos-todos') as HTMLButtonElement;
const elBtnPeritosLimpar = document.getElementById('btn-peritos-limpar') as HTMLButtonElement;
const elInputPeritosBusca = document.getElementById(
  'input-peritos-busca'
) as HTMLInputElement;
const elBtnCancelar = document.getElementById('btn-cancelar') as HTMLButtonElement;
const elBtnConfirmar = document.getElementById('btn-confirmar') as HTMLButtonElement;
const elBtnFechar = document.getElementById('btn-fechar') as HTMLButtonElement;
const elProgressoResumo = document.getElementById('progresso-resumo') as HTMLElement;
const elBarFill = document.getElementById('bar-fill') as HTMLElement;
const elBarLabel = document.getElementById('bar-label') as HTMLElement;
const elLog = document.getElementById('log') as HTMLElement;
const elBar = elBarFill.parentElement as HTMLElement;

let requestId = '';
let stateAtual: PericiasPainelState | null = null;
let totalProcessosAcumulado = 0;
let coletadosAcumulado = 0;

void main();

async function main(): Promise<void> {
  try {
    const params = new URLSearchParams(window.location.search);
    requestId = params.get('rid') ?? '';
    if (!requestId) {
      exibirErro(
        'Identificador de requisição ausente. Feche esta aba e abra a ' +
          'feature Perícias novamente a partir do PJe.'
      );
      return;
    }

    const state = await carregarEstado(requestId);
    if (!state) {
      exibirErro(
        'Não encontrei os dados desta sessão de Perícias. A aba do PJe pode ' +
          'ter sido fechada ou o navegador ter descartado a sessão. Abra a ' +
          'ferramenta novamente a partir do PJe.'
      );
      return;
    }
    stateAtual = state;
    void montarMeta(state);
    registrarListenerBackground();
    renderizarSeletor(state);
  } catch (err) {
    console.error(`${LOG_PREFIX} painel Perícias falhou ao montar:`, err);
    exibirErro(err instanceof Error ? err.message : String(err));
  }
}

async function carregarEstado(rid: string): Promise<PericiasPainelState | null> {
  const key = `${STORAGE_KEYS.PERICIAS_PAINEL_STATE_PREFIX}${rid}`;
  const out = await chrome.storage.session.get(key);
  const raw = out[key];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<PericiasPainelState>;
  if (!Array.isArray(obj.tarefas) || !Array.isArray(obj.peritos)) return null;
  return {
    requestId: rid,
    tarefas: obj.tarefas as PericiaTarefaInfo[],
    peritos: obj.peritos as PericiaPerito[],
    hostnamePJe: typeof obj.hostnamePJe === 'string' ? obj.hostnamePJe : '',
    abertoEm:
      typeof obj.abertoEm === 'string' ? obj.abertoEm : new Date().toISOString()
  };
}

async function montarMeta(state: PericiasPainelState): Promise<void> {
  const nomeVara = await lerNomeVaraDasSettings();
  const unidade = nomeVara || state.hostnamePJe;
  const peritosAtivos = state.peritos.filter((p) => p.ativo).length;
  const contadores: string[] = [];
  if (unidade !== state.hostnamePJe && state.hostnamePJe) {
    contadores.push(state.hostnamePJe);
  }
  contadores.push(
    `${state.tarefas.length} tarefa(s) detectada(s)`,
    `${peritosAtivos} perito(s) ativo(s) cadastrado(s)`
  );
  renderHeaderMeta(elMeta, {
    unidade,
    geradoEm: state.abertoEm,
    contadores
  });
}

function isoDataLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function renderizarSeletor(state: PericiasPainelState): void {
  mostrarEstado('seletor');

  // Data da perícia: mínimo = amanhã (futura, obrigatória); default vazio
  // para forçar escolha consciente.
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  elInputDataPericia.min = isoDataLocal(amanha);
  elInputDataPericia.value = '';
  elInputDataPericia.addEventListener('change', atualizarContadores);
  elInputDataPericia.addEventListener('input', atualizarContadores);

  // Tarefas — pré-selecionadas (normalmente 1-2, quase sempre ambas usadas).
  elListaTarefas.innerHTML = '';
  if (state.tarefas.length === 0) {
    const li = document.createElement('li');
    li.className = 'lista-vazia';
    li.textContent =
      'Nenhuma tarefa de perícia foi encontrada no painel atual.';
    elListaTarefas.appendChild(li);
  } else {
    state.tarefas.forEach((t, i) => {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `tarefa-${i}`;
      cb.value = t.nome;
      cb.checked = true;
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

  // Peritos — só ativos; desabilita os sem etiquetas.
  elListaPeritos.innerHTML = '';
  const ativos = state.peritos
    .filter((p) => p.ativo)
    .slice()
    .sort((a, b) => a.nomeCompleto.localeCompare(b.nomeCompleto, 'pt-BR'));
  if (ativos.length === 0) {
    const li = document.createElement('li');
    li.className = 'lista-vazia';
    li.textContent =
      'Nenhum perito ativo cadastrado. Abra o popup da extensão, aba ' +
      '"Perícias pAIdegua", e cadastre ao menos um perito com etiquetas.';
    elListaPeritos.appendChild(li);
  } else {
    ativos.forEach((p, i) => {
      const li = document.createElement('li');
      const semEtiquetas = p.etiquetas.length === 0;
      if (semEtiquetas) li.classList.add('is-disabled');
      // Índice de busca: nome + etiquetas + assuntos, normalizado sem
      // acentos/caixa para `input-peritos-busca`.
      const termosBusca = [
        p.nomeCompleto,
        ...p.etiquetas.map((e) => e.nomeTag),
        ...p.etiquetas.map((e) => e.nomeTagCompleto).filter((s): s is string => !!s),
        ...p.assuntos
      ].join(' ');
      li.dataset.busca = normalizarBusca(termosBusca);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `perito-${i}`;
      cb.value = p.id;
      cb.checked = false;
      cb.disabled = semEtiquetas;
      cb.addEventListener('change', atualizarContadores);
      const label = document.createElement('label');
      label.htmlFor = cb.id;

      const linhaTopo = document.createElement('div');
      linhaTopo.style.display = 'flex';
      linhaTopo.style.justifyContent = 'space-between';
      linhaTopo.style.alignItems = 'baseline';
      linhaTopo.style.gap = '10px';
      linhaTopo.style.width = '100%';
      const nome = document.createElement('span');
      nome.className = 'perito-nome';
      const tratamento =
        p.profissao === 'ASSISTENTE_SOCIAL'
          ? 'AS'
          : p.genero === 'F'
            ? 'DRA'
            : 'DR';
      nome.textContent = `${tratamento} ${p.nomeCompleto}`;
      const meta = document.createElement('span');
      meta.className = 'perito-meta';
      if (p.assuntos.length > 0) {
        meta.textContent = `assuntos: ${p.assuntos.length}`;
      }
      linhaTopo.append(nome, meta);
      label.appendChild(linhaTopo);

      // Input de quantidade editável — default = cadastro; stop propagation
      // para que o clique no input NÃO alterne o checkbox.
      const qtdLinha = document.createElement('div');
      qtdLinha.className = 'perito-qtd-linha';
      const qtdLabel = document.createElement('label');
      qtdLabel.className = 'perito-qtd-label';
      qtdLabel.textContent = 'Quantidade';
      qtdLabel.htmlFor = `perito-qtd-${i}`;
      const qtdInput = document.createElement('input');
      qtdInput.type = 'number';
      qtdInput.id = `perito-qtd-${i}`;
      qtdInput.className = 'input perito-qtd-input';
      qtdInput.min = '1';
      qtdInput.max = '500';
      qtdInput.step = '1';
      qtdInput.value = String(Math.max(1, p.quantidadePadrao || 1));
      qtdInput.dataset.peritoId = p.id;
      const swallow = (ev: Event): void => ev.stopPropagation();
      qtdInput.addEventListener('click', swallow);
      qtdInput.addEventListener('mousedown', swallow);
      qtdInput.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
      });
      qtdInput.addEventListener('change', atualizarContadores);
      qtdInput.addEventListener('input', atualizarContadores);
      qtdLinha.append(qtdLabel, qtdInput);
      label.appendChild(qtdLinha);

      if (p.etiquetas.length > 0) {
        const tags = document.createElement('div');
        tags.className = 'perito-etiquetas';
        p.etiquetas.slice(0, 6).forEach((e) => {
          const chip = document.createElement('span');
          chip.className = 'perito-tag';
          chip.textContent = e.nomeTag;
          chip.title = e.nomeTagCompleto || e.nomeTag;
          tags.appendChild(chip);
        });
        if (p.etiquetas.length > 6) {
          const resto = document.createElement('span');
          resto.className = 'perito-tag';
          resto.textContent = `+${p.etiquetas.length - 6}`;
          tags.appendChild(resto);
        }
        label.appendChild(tags);
      } else {
        const aviso = document.createElement('div');
        aviso.className = 'perito-aviso';
        aviso.textContent =
          'Sem etiquetas vinculadas — edite o perito no popup para habilitá-lo.';
        label.appendChild(aviso);
      }
      li.append(cb, label);
      elListaPeritos.appendChild(li);
    });
  }

  atualizarContadores();
}

function validarDataPericia(): { ok: boolean; aviso: string } {
  const raw = elInputDataPericia.value;
  if (!raw) return { ok: false, aviso: 'Informe a data da perícia.' };
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, aviso: 'Data inválida.' };
  const escolhida = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    12, 0, 0
  );
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  if (escolhida.getTime() < hoje.getTime() + 24 * 60 * 60 * 1000) {
    return { ok: false, aviso: 'A data deve ser futura (a partir de amanhã).' };
  }
  return { ok: true, aviso: '' };
}

/**
 * Normaliza string para busca: minúsculas, sem acentos, espaços simples.
 * Aplicado no índice salvo em `li.dataset.busca` e na consulta digitada.
 */
function normalizarBusca(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Aplica o texto do input `input-peritos-busca` à lista de peritos,
 * escondendo os `<li>` cujo `dataset.busca` não contém todos os termos.
 * Busca por múltiplos termos: separadas por espaço, todas devem bater
 * (AND) — não há suporte a frases com aspas.
 */
function aplicarFiltroPeritos(): void {
  const q = normalizarBusca(elInputPeritosBusca.value);
  const termos = q ? q.split(' ').filter(Boolean) : [];
  const itens = elListaPeritos.querySelectorAll<HTMLLIElement>('li');
  itens.forEach((li) => {
    if (termos.length === 0) {
      li.classList.remove('is-hidden');
      return;
    }
    const idx = li.dataset.busca ?? '';
    const visivel = termos.every((t) => idx.includes(t));
    li.classList.toggle('is-hidden', !visivel);
  });
  atualizarContadores();
}

function atualizarContadores(): void {
  const cbT = elListaTarefas.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]'
  );
  const selT = Array.from(cbT).filter((c) => c.checked).length;
  elContadorTarefas.textContent =
    selT === 0
      ? 'Nenhuma tarefa selecionada'
      : `${selT} tarefa${selT === 1 ? '' : 's'} selecionada${selT === 1 ? '' : 's'}`;

  const cbP = elListaPeritos.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]:not(:disabled)'
  );
  const selP = Array.from(cbP).filter((c) => c.checked).length;
  const totalLi = elListaPeritos.querySelectorAll('li').length;
  const visiveisLi = elListaPeritos.querySelectorAll('li:not(.is-hidden)').length;
  const filtroAtivo = visiveisLi < totalLi;
  const base =
    selP === 0
      ? 'Nenhum perito selecionado'
      : `${selP} perito${selP === 1 ? '' : 's'} selecionado${selP === 1 ? '' : 's'}`;
  elContadorPeritos.textContent = filtroAtivo
    ? `${base} — ${visiveisLi} de ${totalLi} visível${totalLi === 1 ? '' : 'eis'}`
    : base;

  const { ok: dataOk, aviso } = validarDataPericia();
  elDataPericiaAviso.textContent = dataOk ? '' : aviso;
  elDataPericiaAviso.style.color = dataOk ? '' : 'var(--paidegua-danger, #b91c1c)';

  elBtnConfirmar.disabled = selT === 0 || selP === 0 || !dataOk;
}

function tarefasSelecionadas(): string[] {
  return Array.from(
    elListaTarefas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  )
    .filter((c) => c.checked)
    .map((c) => c.value);
}

function peritosSelecionados(): PericiaPerito[] {
  const ids = new Set(
    Array.from(
      elListaPeritos.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]:not(:disabled)'
      )
    )
      .filter((c) => c.checked)
      .map((c) => c.value)
  );
  // Sobrescreve `quantidadePadrao` com o valor digitado no painel — o
  // cadastro no store fica intacto; a alteração vale só para esta pauta.
  const quantidadesEditadas = new Map<string, number>();
  elListaPeritos
    .querySelectorAll<HTMLInputElement>('input.perito-qtd-input')
    .forEach((inp) => {
      const pid = inp.dataset.peritoId;
      if (!pid) return;
      const n = Math.max(1, Math.min(500, Math.trunc(Number(inp.value) || 0)));
      if (n > 0) quantidadesEditadas.set(pid, n);
    });
  return (stateAtual?.peritos ?? [])
    .filter((p) => ids.has(p.id))
    .map((p) => {
      const q = quantidadesEditadas.get(p.id);
      if (q == null || q === p.quantidadePadrao) return p;
      return { ...p, quantidadePadrao: q };
    });
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
elBtnPeritosTodos.addEventListener('click', () => {
  // Restringe aos peritos visíveis no filtro atual — intencional para que
  // a busca sirva como pré-seleção em massa (ex.: "JEFERSON" + Todos).
  elListaPeritos
    .querySelectorAll<HTMLLIElement>('li:not(.is-hidden)')
    .forEach((li) => {
      const c = li.querySelector<HTMLInputElement>(
        'input[type="checkbox"]:not(:disabled)'
      );
      if (c) c.checked = true;
    });
  atualizarContadores();
});
elBtnPeritosLimpar.addEventListener('click', () => {
  // Simetria com "Selecionar todos": limpa só os visíveis. Para limpar
  // geral, basta apagar o filtro antes.
  elListaPeritos
    .querySelectorAll<HTMLLIElement>('li:not(.is-hidden)')
    .forEach((li) => {
      const c = li.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (c) c.checked = false;
    });
  atualizarContadores();
});
elInputPeritosBusca.addEventListener('input', aplicarFiltroPeritos);
elBtnCancelar.addEventListener('click', () => window.close());
elBtnFechar.addEventListener('click', () => window.close());

elBtnConfirmar.addEventListener('click', () => {
  const nomes = tarefasSelecionadas();
  const peritos = peritosSelecionados();
  const { ok: dataOk } = validarDataPericia();
  if (nomes.length === 0 || peritos.length === 0 || !dataOk) return;
  void iniciarColeta(nomes, peritos, elInputDataPericia.value);
});

async function iniciarColeta(
  nomes: string[],
  peritos: PericiaPerito[],
  dataPericiaISO: string
): Promise<void> {
  totalProcessosAcumulado = 0;
  coletadosAcumulado = 0;
  elLog.innerHTML = '';
  elBarFill.style.width = '0%';
  elBar.classList.add('indeterminada');
  elBarLabel.textContent = 'Preparando...';
  mostrarEstado('progresso');

  const qtdTotal = peritos.reduce((acc, p) => acc + p.quantidadePadrao, 0);
  elProgressoResumo.textContent =
    `Montando pauta para ${peritos.length} perito${peritos.length === 1 ? '' : 's'} ` +
    `(meta de ~${qtdTotal} processo${qtdTotal === 1 ? '' : 's'}). ` +
    'Não feche esta aba — ela carrega o dashboard automaticamente ao final.';
  logLinha(
    `Pedindo ao PJe para varrer ${nomes.length} tarefa(s) de perícia...`
  );

  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.PERICIAS_START_COLETA,
      payload: {
        requestId,
        nomes,
        peritosSelecionados: peritos,
        dataPericiaISO,
        excluirIds: []
      }
    });
    if (!resp?.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao iniciar a montagem.';
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
    // Como a aba-painel também é extension view, ela recebe a mensagem
    // duas vezes: (1) broadcast direto do content via runtime.sendMessage
    // (sender.tab presente), (2) relay do background via tabs.sendMessage
    // (sender.tab ausente). Fica apenas com o relay (canônico).
    if (sender?.tab) return false;
    const payload = message.payload as { requestId?: string } | undefined;
    if (!payload || payload.requestId !== requestId) return false;

    if (message.channel === MESSAGE_CHANNELS.PERICIAS_COLETA_PROG) {
      const msg = (payload as { msg?: string }).msg ?? '';
      logLinha(msg);
      avancarBarra(msg);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.PERICIAS_COLETA_READY) {
      logLinha('Pauta montada — abrindo dashboard...', 'ok');
      const url = chrome.runtime.getURL(
        'pericias-dashboard/pericias-dashboard.html'
      ) + `?rid=${encodeURIComponent(requestId)}`;
      window.setTimeout(() => {
        window.location.replace(url);
      }, 300);
      sendResponse({ ok: true });
      return false;
    }
    if (message.channel === MESSAGE_CHANNELS.PERICIAS_COLETA_FAIL) {
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
 * Padrões de progresso reconhecidos:
 *   - `[setup] N tarefa(s) — total X processo(s)` → define o denominador.
 *   - `[coleta] N/M — <processo>` → atualiza o numerador.
 *   - `[perito] N/M — <nome>` → avança pela quantidade de peritos (fase
 *     de ranking/atribuição, após coleta bruta).
 */
function avancarBarra(msg: string): void {
  const mSetup = msg.match(/\[setup\][^0-9]*(\d+)\s+tarefa.*total\s+(\d+)/i);
  if (mSetup) {
    totalProcessosAcumulado = Number(mSetup[2]);
    elBar.classList.remove('indeterminada');
    atualizarBarra();
    return;
  }
  const mColeta = msg.match(/\[coleta\]\s+(\d+)\/(\d+)\b/i);
  if (mColeta) {
    coletadosAcumulado = Math.max(coletadosAcumulado, Number(mColeta[1]));
    totalProcessosAcumulado = Math.max(
      totalProcessosAcumulado,
      Number(mColeta[2])
    );
    elBar.classList.remove('indeterminada');
    atualizarBarra();
    return;
  }
  const mPerito = msg.match(/\[perito\]\s+(\d+)\/(\d+)\b/i);
  if (mPerito) {
    const atual = Number(mPerito[1]);
    const total = Number(mPerito[2]);
    if (Number.isFinite(atual) && Number.isFinite(total) && total > 0) {
      const pct = Math.min(100, Math.round((atual / total) * 100));
      elBar.classList.remove('indeterminada');
      elBarFill.style.width = `${pct}%`;
      elBarLabel.textContent =
        `${atual} de ${total} perito${total === 1 ? '' : 's'} com pauta pronta · ${pct}%`;
    }
  }
}

function atualizarBarra(): void {
  if (totalProcessosAcumulado <= 0) {
    elBarFill.style.width = '0%';
    elBarLabel.textContent = 'Preparando...';
    return;
  }
  const pct = Math.min(
    100,
    Math.round((coletadosAcumulado / totalProcessosAcumulado) * 100)
  );
  elBarFill.style.width = `${pct}%`;
  elBarLabel.textContent =
    `${coletadosAcumulado} de ${totalProcessosAcumulado} processo${totalProcessosAcumulado === 1 ? '' : 's'} ` +
    `coletado${coletadosAcumulado === 1 ? '' : 's'} · ${pct}%`;
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


void stateAtual;
