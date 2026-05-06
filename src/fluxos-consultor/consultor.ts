/**
 * Consultor de fluxos — entry da página `fluxos-consultor/consultor.html`.
 *
 * Orquestra:
 *   - carregamento do catálogo embarcado (fluxos-store)
 *   - busca textual local + sugestões de quick actions
 *   - chat com streaming via porta CHAT_STREAM
 *   - injeção do system prompt do modo atual (usuário | dev) como override
 *   - detecção de bloco mermaid na resposta e render lateral
 *   - persistência da preferência de modo em chrome.storage.local
 */

import {
  CHAT_PORT_MSG,
  PORT_NAMES,
  PROVIDER_MODELS,
  STORAGE_KEYS,
  type ProviderId
} from '../shared/constants';
import type {
  ChatMessage,
  ChatStartPayload,
  PAIdeguaSettings
} from '../shared/types';
import {
  CONSULTOR_MODO_DEFAULT,
  type ConsultorModo
} from '../shared/fluxos-types';
import {
  getMensagemBoasVindas,
  getQuickActions,
  getSubtituloModo,
  getSystemPrompt
} from '../shared/fluxos-prompts';
import {
  getCatalogo,
  getResumoParaPrompt,
  getResumoParaPromptUsuario
} from '../shared/fluxos-store';
import { buscar } from '../shared/fluxos-search';
import {
  caminhoMaisCurto,
  caminhoParaMermaid,
  construirGrafo,
  type Grafo
} from '../shared/fluxos-grafo';

interface MemoriaConsultor {
  grafo: Grafo | null;
  /** Resumo do catálogo no formato adequado ao modo atual. */
  catalogoResumo: string;
  /** Resumos pré-carregados para cada modo (cache). */
  catalogoResumoUsuario: string | null;
  catalogoResumoDev: string | null;
  conversa: ChatMessage[];
  port: chrome.runtime.Port | null;
  bubbleEmCurso: HTMLElement | null;
  bufferAssistant: string;
  inFlight: boolean;
  modo: ConsultorModo;
}

const memoria: MemoriaConsultor = {
  grafo: null,
  catalogoResumo: '',
  catalogoResumoUsuario: null,
  catalogoResumoDev: null,
  conversa: [],
  port: null,
  bubbleEmCurso: null,
  bufferAssistant: '',
  inFlight: false,
  modo: CONSULTOR_MODO_DEFAULT
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} ausente.`);
  return el as T;
};

async function inicializar(): Promise<void> {
  memoria.modo = await carregarModoPersistido();
  bindModoSeletor();
  bindBuscaInput();
  bindFormulario();
  bindLimpar();

  aplicarModoNaUi(memoria.modo, { silencioso: true });
  renderBoasVindas();

  try {
    const cat = await getCatalogo();
    memoria.grafo = construirGrafo(cat);
    // Pré-carrega ambos os resumos (cache local).
    memoria.catalogoResumoUsuario = await getResumoParaPromptUsuario();
    memoria.catalogoResumoDev = await getResumoParaPrompt();
    memoria.catalogoResumo =
      memoria.modo === 'usuario' ? memoria.catalogoResumoUsuario : memoria.catalogoResumoDev;
    $('catalogo-info').textContent = `${cat.totalFluxos} etapas · v${cat.versao}`;
  } catch (e) {
    setStatus(
      e instanceof Error ? e.message : 'Falha ao carregar catálogo.',
      'is-error'
    );
    $('catalogo-info').textContent = 'catálogo indisponível';
    desabilitarComposer(true);
  }
}

// =====================================================================
// Modo (usuário | dev)
// =====================================================================

async function carregarModoPersistido(): Promise<ConsultorModo> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.FLUXOS_MODO, (data) => {
      const v = data?.[STORAGE_KEYS.FLUXOS_MODO];
      resolve(v === 'dev' ? 'dev' : 'usuario');
    });
  });
}

function persistirModo(modo: ConsultorModo): void {
  chrome.storage.local.set({ [STORAGE_KEYS.FLUXOS_MODO]: modo });
}

function bindModoSeletor(): void {
  const pills = document.querySelectorAll<HTMLButtonElement>('.modo-pill');
  for (const p of Array.from(pills)) {
    p.addEventListener('click', () => {
      const m = p.dataset.modo as ConsultorModo | undefined;
      if (!m || m === memoria.modo) return;
      trocarModo(m);
    });
  }
}

function trocarModo(novoModo: ConsultorModo): void {
  if (novoModo === memoria.modo) return;
  memoria.modo = novoModo;
  persistirModo(novoModo);
  if (novoModo === 'usuario' && memoria.catalogoResumoUsuario) {
    memoria.catalogoResumo = memoria.catalogoResumoUsuario;
  } else if (novoModo === 'dev' && memoria.catalogoResumoDev) {
    memoria.catalogoResumo = memoria.catalogoResumoDev;
  }
  aplicarModoNaUi(novoModo, { silencioso: false });

  // Reinicia conversa: o LLM precisa começar com o system prompt novo,
  // senão fica falando metade técnico, metade humano. UX coerente.
  memoria.conversa = [];
  $('chat-log').innerHTML = '';
  renderBoasVindas();
  $('diagram-host').innerHTML = '<p class="muted center">O desenho do caminho aparecerá aqui<br>quando você pedir um trajeto.</p>';
  setStatus('');
}

function aplicarModoNaUi(modo: ConsultorModo, opts: { silencioso: boolean }): void {
  // Pills
  for (const p of Array.from(document.querySelectorAll<HTMLButtonElement>('.modo-pill'))) {
    const ativo = p.dataset.modo === modo;
    p.classList.toggle('is-active', ativo);
    p.setAttribute('aria-checked', ativo ? 'true' : 'false');
  }
  // Subtítulo do header
  $('brand-subtitulo').textContent = getSubtituloModo(modo);
  // Placeholder do textarea
  const ta = $('input') as HTMLTextAreaElement;
  ta.placeholder =
    modo === 'usuario'
      ? 'Pergunte com suas palavras… (Enter para enviar, Shift+Enter para nova linha)'
      : 'Pergunte algo… (Enter para enviar, Shift+Enter para nova linha)';
  // Título e placeholder da busca lateral
  const buscaTit = $('busca-titulo');
  const buscaInput = $('busca') as HTMLInputElement;
  if (modo === 'usuario') {
    buscaTit.textContent = 'Buscar etapa';
    buscaInput.placeholder = 'digite parte do nome…';
  } else {
    buscaTit.textContent = 'Buscar fluxo';
    buscaInput.placeholder = 'código, nome, fase…';
  }
  // Quick actions
  renderQuickActions();
  void opts; // reservado para uso futuro
}

function renderQuickActions(): void {
  const ul = $('quick-actions') as HTMLUListElement;
  ul.innerHTML = '';
  for (const qa of getQuickActions(memoria.modo)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = qa.label;
    btn.title = qa.description;
    btn.addEventListener('click', () => {
      const ta = $('input') as HTMLTextAreaElement;
      ta.value = qa.prompt;
      ta.focus();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function renderBoasVindas(): void {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = 'bubble bubble--assistant';
  div.innerHTML = getMensagemBoasVindas(memoria.modo)
    .map((p) => `<p>${escaparHtml(p)}</p>`)
    .join('');
  log.appendChild(div);
}

function bindBuscaInput(): void {
  const input = $('busca') as HTMLInputElement;
  const lista = $('busca-resultados') as HTMLUListElement;

  let timer: number | null = null;
  input.addEventListener('input', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => void executarBusca(input.value, lista), 180);
  });
}

async function executarBusca(consulta: string, lista: HTMLUListElement): Promise<void> {
  lista.innerHTML = '';
  const termo = consulta.trim();
  if (termo.length < 2) return;
  const cat = await getCatalogo();
  const resultados = buscar(cat, termo, 8);
  if (resultados.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = `<small>Nenhuma etapa encontrada.</small>`;
    lista.appendChild(li);
    return;
  }
  for (const r of resultados) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    if (memoria.modo === 'dev') {
      btn.innerHTML = `<strong>${r.fluxo.codigo}</strong> <small>${escaparHtml(
        r.fluxo.nome
      )}</small>`;
      btn.title = `${r.fluxo.lane} · ${r.fluxo.fase} · score ${r.score}`;
      btn.addEventListener('click', () => {
        const ta = $('input') as HTMLTextAreaElement;
        ta.value = `Explique em detalhe o fluxo \`${r.fluxo.codigo}\`.`;
        ta.focus();
      });
    } else {
      const nomeLegivel = limparNomeUsuario(r.fluxo.nome);
      btn.innerHTML = `<strong>${escaparHtml(nomeLegivel)}</strong>`;
      btn.title = 'Clique para perguntar sobre esta etapa em linguagem simples.';
      btn.addEventListener('click', () => {
        const ta = $('input') as HTMLTextAreaElement;
        ta.value =
          `Em linguagem simples, me explique o que acontece na etapa "${nomeLegivel}". ` +
          `O que o sistema está fazendo, o que provavelmente vem depois, e o que eu (servidor/parte) preciso saber sobre ela?`;
        ta.focus();
      });
    }
    li.appendChild(btn);
    lista.appendChild(li);
  }
}

/** Espelha a função de fluxos-grafo.ts — usado na UI da busca. */
function limparNomeUsuario(nome: string): string {
  return nome
    .replace(/^\s*\[(?:JEF|EF|COMUM)\]\s*/i, '')
    .replace(/_+/g, ' ')
    .replace(/[\[\]"`]/g, '')
    .trim();
}

function bindFormulario(): void {
  const form = $('form') as HTMLFormElement;
  const ta = $('input') as HTMLTextAreaElement;

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = ta.value.trim();
    if (!texto || memoria.inFlight) return;
    ta.value = '';
    void enviarPergunta(texto);
  });
}

function bindLimpar(): void {
  $('btn-limpar').addEventListener('click', () => {
    memoria.conversa = [];
    $('chat-log').innerHTML = '';
    renderBoasVindas();
    $('diagram-host').innerHTML = '<p class="muted center">O desenho do caminho aparecerá aqui<br>quando você pedir um trajeto.</p>';
    setStatus('');
  });
}

async function enviarPergunta(texto: string): Promise<void> {
  desabilitarComposer(true);
  setStatus('Consultando…');

  // Tenta detectar pedido de "caminho de X até Y" e injeta diagrama Mermaid
  // gerado deterministicamente ANTES da resposta do LLM (mais confiável).
  const dica = tentarRenderizarCaminho(texto);

  addBubble('user', texto);
  memoria.conversa.push({ role: 'user', content: texto, timestamp: Date.now() });

  // Monta system prompt: prompt do modo atual + resumo do catálogo no formato compatível.
  const sysPrompt = `${getSystemPrompt(memoria.modo)}\n\n---\n\n${memoria.catalogoResumo}`;

  // Mensagens enviadas: histórico + (opcionalmente) hint sobre caminho já desenhado.
  const messages: ChatMessage[] = [...memoria.conversa];
  if (dica) {
    messages.push({
      role: 'user',
      content:
        '_(o orquestrador já desenhou um caminho candidato no painel lateral; ' +
        'use-o como ponto de partida e explique cada etapa)_',
      timestamp: Date.now()
    });
  }

  try {
    const settings = await carregarSettings();
    if (!settings) {
      finalizarComErro(
        'Configurações ausentes. Abra a tela de Opções do pAIdegua e configure provedor + chave.'
      );
      return;
    }
    const port = chrome.runtime.connect({ name: PORT_NAMES.CHAT_STREAM });
    memoria.port = port;
    memoria.bufferAssistant = '';

    const bubble = addBubble('assistant', '');
    bubble.classList.add('is-streaming');
    memoria.bubbleEmCurso = bubble;

    port.onMessage.addListener((msg: { type: string; delta?: string; error?: string }) => {
      switch (msg.type) {
        case CHAT_PORT_MSG.CHUNK: {
          if (msg.delta) {
            memoria.bufferAssistant += msg.delta;
            atualizarBolha(memoria.bubbleEmCurso!, memoria.bufferAssistant);
          }
          break;
        }
        case CHAT_PORT_MSG.DONE: {
          finalizarStreaming();
          break;
        }
        case CHAT_PORT_MSG.ERROR: {
          finalizarComErro(msg.error || 'Erro desconhecido.');
          break;
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (memoria.inFlight) finalizarComErro('Conexão com o background interrompida.');
    });

    const payload: ChatStartPayload = {
      provider: settings.activeProvider,
      model: settings.models[settings.activeProvider],
      messages,
      documents: [],
      numeroProcesso: null,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      systemPromptOverride: sysPrompt
    };
    port.postMessage({ type: CHAT_PORT_MSG.START, payload });
  } catch (e) {
    finalizarComErro(e instanceof Error ? e.message : 'Falha ao iniciar conversa.');
  }
}

function finalizarStreaming(): void {
  const bubble = memoria.bubbleEmCurso;
  if (bubble) {
    bubble.classList.remove('is-streaming');
    // detecta mermaid e renderiza
    const mermaidSrc = extrairMermaid(memoria.bufferAssistant);
    if (mermaidSrc) {
      void renderizarMermaid(mermaidSrc);
    }
  }
  memoria.conversa.push({
    role: 'assistant',
    content: memoria.bufferAssistant,
    timestamp: Date.now()
  });
  memoria.bubbleEmCurso = null;
  memoria.bufferAssistant = '';
  desabilitarComposer(false);
  setStatus('');
  if (memoria.port) {
    try {
      memoria.port.disconnect();
    } catch {
      /* ignore */
    }
    memoria.port = null;
  }
  memoria.inFlight = false;
}

function finalizarComErro(msg: string): void {
  if (memoria.bubbleEmCurso) {
    memoria.bubbleEmCurso.classList.remove('is-streaming');
    if (memoria.bufferAssistant.length === 0) {
      memoria.bubbleEmCurso.textContent = `(falha: ${msg})`;
    }
  }
  memoria.bubbleEmCurso = null;
  memoria.bufferAssistant = '';
  desabilitarComposer(false);
  setStatus(msg, 'is-error');
  if (memoria.port) {
    try {
      memoria.port.disconnect();
    } catch {
      /* ignore */
    }
    memoria.port = null;
  }
  memoria.inFlight = false;
}

function desabilitarComposer(d: boolean): void {
  memoria.inFlight = d;
  ($('btn-enviar') as HTMLButtonElement).disabled = d;
  ($('input') as HTMLTextAreaElement).disabled = d;
}

function setStatus(msg: string, kind?: 'is-error'): void {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status muted small';
  if (kind) el.classList.add(kind);
}

// =====================================================================
// Renderização de bolhas e markdown leve
// =====================================================================

function addBubble(role: 'user' | 'assistant', text: string): HTMLElement {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = `bubble bubble--${role}`;
  if (text) atualizarBolha(div, text);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function atualizarBolha(bubble: HTMLElement, conteudo: string): void {
  bubble.innerHTML = renderizarMarkdownLeve(conteudo);
  // mantém o scroll grudado embaixo enquanto streama
  const log = $('chat-log');
  log.scrollTop = log.scrollHeight;
}

/**
 * Markdown leve: parágrafos, code inline, **negrito**, listas com hífen.
 * Suficiente para respostas do consultor; não suporta tabelas/imagens.
 * Blocos ```mermaid``` viram um chip visual apontando para o painel lateral
 * (o diagrama em si é renderizado pela função renderizarMermaid).
 */
const DIAGRAM_HINT_TOKEN = '@@PAIDEGUA_DIAGRAM_HINT@@';

function renderizarMarkdownLeve(s: string): string {
  // Substitui blocos mermaid por um sentinela único (vai virar chip no final).
  let texto = s.replace(/```mermaid[\s\S]*?```/g, '\n' + DIAGRAM_HINT_TOKEN + '\n');

  // escape básico de HTML
  texto = texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // code inline `x`
  texto = texto.replace(/`([^`]+)`/g, '<code>$1</code>');

  // **negrito**
  texto = texto.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // *itálico*
  texto = texto.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // listas e parágrafos por linha
  const linhas = texto.split('\n');
  const html: string[] = [];
  let dentroLista = false;
  for (const linha of linhas) {
    const t = linha.trim();
    const itemList = t.match(/^[-*]\s+(.*)$/);
    if (itemList) {
      if (!dentroLista) {
        html.push('<ul style="margin:6px 0 6px 18px; padding-left:6px;">');
        dentroLista = true;
      }
      html.push(`<li>${itemList[1]}</li>`);
      continue;
    }
    if (dentroLista) {
      html.push('</ul>');
      dentroLista = false;
    }
    if (t.length === 0) {
      html.push('<br>');
      continue;
    }
    html.push(`<p>${t}</p>`);
  }
  if (dentroLista) html.push('</ul>');

  // Substitui o sentinela pelo chip visual (HTML cru — não escapado).
  return html.join('').split(DIAGRAM_HINT_TOKEN).join(buildDiagramHintHtml(memoria.modo));
}

/** Pequeno chip que aparece na bolha quando há diagrama lateral. */
function buildDiagramHintHtml(modo: ConsultorModo): string {
  const texto =
    modo === 'usuario'
      ? 'Veja o caminho desenhado ao lado'
      : 'Diagrama do caminho ao lado';
  // Ícone de "esquema/grafo" — sem emoji.
  const icon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="5" cy="6" r="2.2"/>
    <circle cx="19" cy="6" r="2.2"/>
    <circle cx="12" cy="18" r="2.2"/>
    <path d="M7 7l3.5 9"/>
    <path d="M17 7l-3.5 9"/>
  </svg>`;
  return `<span class="bubble__diagram-hint" role="note">${icon}<span>${escaparHtml(texto)}</span><span class="arrow" aria-hidden="true">→</span></span>`;
}

function escaparHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =====================================================================
// Mermaid lateral (lazy-loaded)
// =====================================================================

function extrairMermaid(s: string): string | null {
  const m = s.match(/```mermaid\s*\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

async function renderizarMermaid(src: string): Promise<void> {
  const host = $('diagram-host');
  host.innerHTML = '<p class="muted center">Renderizando diagrama…</p>';
  try {
    const mod = await import(/* webpackChunkName: "mermaid" */ 'mermaid');
    const mermaid = (mod as { default: typeof import('mermaid')['default'] }).default;
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
    const id = `mmd-${Math.random().toString(36).slice(2, 9)}`;
    const { svg } = await mermaid.render(id, src);
    host.innerHTML = svg;
  } catch (e) {
    host.innerHTML = `<pre class="muted small">${escaparHtml(src)}</pre>
      <p class="muted small">Falha ao renderizar diagrama: ${escaparHtml(
        (e as Error).message ?? 'erro desconhecido'
      )}</p>`;
  }
}

/**
 * Heurística: se a pergunta tem padrão "X até Y" e o grafo tem caminho
 * entre os dois, renderiza ANTES da resposta do LLM. Aumenta confiança
 * (LLM pode errar na ordem do caminho — o grafo é determinístico).
 *
 * No modo usuário, o diagrama sai sem códigos jBPM, só com nomes legíveis.
 */
function tentarRenderizarCaminho(consulta: string): boolean {
  if (!memoria.grafo) return false;

  // Tenta capturar dois códigos de fluxo na consulta (formato JEF_XXX, EF_XXX, ou texto)
  const matches = [...consulta.matchAll(/`?([A-Z][A-Z0-9_]{2,30})`?/g)].map((m) => m[1]);
  const codigos = matches.filter((c) => memoria.grafo!.nos.has(c));
  if (codigos.length < 2) return false;

  const [de, para] = codigos;
  const caminho = caminhoMaisCurto(memoria.grafo, de, para);
  if (!caminho) return false;

  const mermaidSrc = caminhoParaMermaid(memoria.grafo, caminho, {
    mostrarCodigo: memoria.modo === 'dev'
  });
  void renderizarMermaid(mermaidSrc);
  return true;
}

// =====================================================================
// Settings (lê chrome.storage.local diretamente — leitura simples)
// =====================================================================

async function carregarSettings(): Promise<PAIdeguaSettings | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS.SETTINGS, (data) => {
      const s = data?.[STORAGE_KEYS.SETTINGS] as PAIdeguaSettings | undefined;
      if (!s) {
        resolve(null);
        return;
      }
      // garante que models está populado para o provider ativo
      const provider: ProviderId = s.activeProvider;
      if (!s.models?.[provider]) {
        const m = PROVIDER_MODELS[provider]?.find((m) => m.recommended) ?? PROVIDER_MODELS[provider]?.[0];
        if (m) {
          s.models = { ...(s.models ?? ({} as Record<ProviderId, string>)), [provider]: m.id };
        }
      }
      resolve(s);
    });
  });
}

void inicializar();
