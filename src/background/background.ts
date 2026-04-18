/**
 * Service worker principal da extensão PAIdegua (Manifest V3) — Fase 4.
 *
 * Responsabilidades:
 *  - Rotear requisições do popup para storage (settings + API keys)
 *  - Testar conexão com cada provedor
 *  - Receber porta long-lived de chat e fazer streaming dos chunks
 *    do provedor ativo de volta ao content script
 *  - Atender pedidos de transcrição de áudio (STT) e síntese de voz (TTS)
 *
 * Toda comunicação com APIs externas sai daqui — a API key NUNCA é
 * exposta ao content script ou à página do PJe.
 */

import {
  CHAT_PORT_MSG,
  LOG_PREFIX,
  MESSAGE_CHANNELS,
  PORT_NAMES,
  STORAGE_KEYS,
  type ProviderId
} from '../shared/constants';
import {
  TRIAGEM_LLM_ANON_NOTICE,
  type TriagemPayloadAnon
} from '../shared/triagem-anonymize';
import {
  SYSTEM_PROMPT,
  buildAnaliseProcessoPrompt,
  buildDocumentContext,
  buildTriagemPrompt,
  parseAnaliseProcessoResponse,
  parseTriagemResponse,
  getTemplateActionsForGrau,
  type CriterioResolvido,
  type TemplateAction,
  type TriagemResult
} from '../shared/prompts';
import {
  buildAnonymizePrompt,
  parseNomesResponse,
  recortarTrechoInicial,
  type NomeAnonimizar
} from '../shared/anonymizer';
import {
  hasAnyTemplate,
  invalidateSearchIndex,
  searchTemplates,
  type SearchOptions
} from '../shared/templates-search';
import type { SaveTemplatePayload } from '../shared/templates-save';
import type {
  AnaliseProcessoResult,
  ChatMessage,
  ChatStartPayload,
  ExtensionMessage,
  GestaoAlerta,
  GestaoDashboardPayload,
  GestaoIndicadores,
  GestaoInsightsLLM,
  GestaoSugestao,
  PAIdeguaSettings,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TestConnectionResult,
  TranscribeAudioPayload,
  TriagemDashboardPayload,
  TriagemInsightsLLM,
  TriagemSugestao
} from '../shared/types';
import { getProvider } from './providers';
import {
  defaultSettings,
  getApiKey,
  getAllApiKeyPresence,
  getSettings,
  hasApiKey,
  removeApiKey,
  saveApiKey,
  saveSettings
} from './storage';

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG_PREFIX} instalada/atualizada:`, details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.log(`${LOG_PREFIX} service worker iniciado`);
});

// =====================================================================
// Mensagens curtas (request/response) — popup e content sem streaming.
// =====================================================================

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    if (!message || typeof message.channel !== 'string') {
      return false;
    }

    switch (message.channel) {
      case MESSAGE_CHANNELS.PING:
        sendResponse({ ok: true, pong: Date.now() });
        return false;

      case MESSAGE_CHANNELS.GET_SETTINGS:
        void handleGetSettings(sendResponse);
        return true;

      case MESSAGE_CHANNELS.SAVE_SETTINGS:
        void handleSaveSettings(message.payload as Partial<PAIdeguaSettings>, sendResponse);
        return true;

      case MESSAGE_CHANNELS.SAVE_API_KEY:
        void handleSaveApiKey(
          message.payload as { provider: ProviderId; apiKey: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.HAS_API_KEY:
        void handleHasApiKey(
          message.payload as { provider: ProviderId },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.REMOVE_API_KEY:
        void handleRemoveApiKey(
          message.payload as { provider: ProviderId },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.TEST_CONNECTION:
        void handleTestConnection(
          message.payload as { provider: ProviderId; model: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.TRANSCRIBE_AUDIO:
        void handleTranscribeAudio(message.payload as TranscribeAudioPayload, sendResponse);
        return true;

      case MESSAGE_CHANNELS.SYNTHESIZE_SPEECH:
        void handleSynthesizeSpeech(message.payload as SynthesizeSpeechPayload, sendResponse);
        return true;

      case MESSAGE_CHANNELS.INSERT_IN_PJE_EDITOR:
        void handleInsertInPJeEditor(
          message.payload as { html: string; plain: string; actionId?: string },
          sender,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.TEMPLATES_HAS_CONFIG:
        void handleTemplatesHasConfig(sendResponse);
        return true;

      case MESSAGE_CHANNELS.TEMPLATES_SEARCH:
        void handleTemplatesSearch(
          message.payload as { query: string; opts?: SearchOptions },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.TEMPLATES_INVALIDATE:
        invalidateSearchIndex();
        sendResponse({ ok: true });
        return false;

      case MESSAGE_CHANNELS.ANONYMIZE_NAMES:
        void handleAnonymizeNames(
          message.payload as { texto: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.TEMPLATES_RERANK:
        void handleTemplatesRerank(
          message.payload as RerankRequest,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.MINUTAR_TRIAGEM:
        void handleMinutarTriagem(
          message.payload as TriagemRequest,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.TRIAGEM_OPEN_DASHBOARD:
        void handleOpenTriagemDashboard(
          message.payload as TriagemDashboardPayload,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.TRIAGEM_INSIGHTS:
        void handleTriagemInsights(
          message.payload as TriagemPayloadAnon,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.GESTAO_OPEN_DASHBOARD:
        void handleOpenGestaoDashboard(
          message.payload as GestaoDashboardPayload,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.GESTAO_INSIGHTS:
        void handleGestaoInsights(
          message.payload as { indicadores: GestaoIndicadores; anon: TriagemPayloadAnon },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.ANALISAR_PROCESSO:
        void handleAnalisarProcesso(
          message.payload as AnalisarProcessoRequest,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.ENCAMINHAR_EMENDA:
        void handleEncaminharEmenda(
          message.payload as EncaminharEmendaRequest,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.TEMPLATES_SAVE_AS_MODEL:
        void handleOpenSaveAsModel(
          message.payload as SaveTemplatePayload,
          sendResponse
        );
        return true;

      default:
        return false;
    }
  }
);

/**
 * Handler do passo 2 do anonimizador: chama o LLM ativo para extrair
 * pares `{original, substituto}` a partir do trecho inicial do texto.
 *
 * Não streama — acumula os chunks e devolve um único JSON. Para o
 * caso de uso (lista curta de nomes), o tempo total fica baixo e o
 * content evita ter que abrir uma porta long-lived.
 */
async function handleAnonymizeNames(
  payload: { texto: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const texto = payload?.texto ?? '';
    if (!texto.trim()) {
      sendResponse({ ok: true, nomes: [] as NomeAnonimizar[] });
      return;
    }

    const settings = await getSettings();
    const providerId = settings.activeProvider;
    const apiKey = await getApiKey(providerId);
    if (!apiKey) {
      sendResponse({
        ok: false,
        error: `API key não cadastrada para ${providerId}.`
      });
      return;
    }

    const provider = getProvider(providerId);
    const trecho = recortarTrechoInicial(texto);
    const prompt = buildAnonymizePrompt(trecho);

    const controller = new AbortController();
    const generator = provider.sendMessage({
      apiKey,
      model: settings.models[providerId],
      systemPrompt:
        'Você é um assistente que extrai dados estruturados de processos judiciais. ' +
        'Responda SEMPRE em JSON puro, sem texto adicional, sem markdown.',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      temperature: 0,
      // Ampliado de 2048 → 4096 para acomodar a lista exaustiva de papéis
      // pedida pelo novo prompt (advogados, procuradores, peritos, MP etc.).
      // Cada entrada no JSON usa ~25 tokens — 4k cobre com folga processos
      // com muitos atores (contestação, laudos, substabelecimentos).
      maxTokens: 4096,
      signal: controller.signal
    });

    let raw = '';
    for await (const chunk of generator) {
      raw += chunk.delta;
    }

    const nomes = parseNomesResponse(raw);
    sendResponse({ ok: true, nomes });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleAnonymizeNames falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleTemplatesHasConfig(
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const has = await hasAnyTemplate();
    sendResponse({ ok: true, hasTemplates: has });
  } catch (error: unknown) {
    sendResponse({ ok: false, hasTemplates: false, error: errorMessage(error) });
  }
}

// =====================================================================
// Re-rank LLM dos candidatos do BM25 (RAG híbrido)
// =====================================================================

/**
 * Pedido de rerank: o content envia o contexto da causa (trecho da
 * petição inicial), o rótulo da ação selecionada e os top-K candidatos
 * já filtrados pelo BM25, cada um com um excerto (~1500 chars).
 *
 * O background pede ao LLM ativo para reordenar os candidatos do mais
 * adequado para o menos adequado e devolver uma justificativa curta.
 */
interface RerankCandidate {
  /** Índice no array original (0..K-1), preservado para o retorno. */
  index: number;
  relativePath: string;
  excerpt: string;
}

interface RerankRequest {
  actionLabel: string;
  caseContext: string;
  candidates: RerankCandidate[];
}

interface RerankResponse {
  ok: boolean;
  /** Nova ordem de índices (referencia o array `candidates` original). */
  ranking?: number[];
  /** Justificativa curta produzida pelo LLM, em PT-BR. */
  justificativa?: string;
  error?: string;
}

const RERANK_EXCERPT_LIMIT = 1500;

function buildRerankPrompt(req: RerankRequest): string {
  const candidatosFmt = req.candidates
    .map((c, i) => {
      const excerpt = c.excerpt.slice(0, RERANK_EXCERPT_LIMIT);
      return (
        `### Candidato ${i} — \`${c.relativePath}\`\n` +
        '```\n' +
        excerpt +
        '\n```'
      );
    })
    .join('\n\n');

  return (
    `Você está ajudando um magistrado a escolher o MELHOR modelo de minuta para uma peça do tipo "${req.actionLabel}".\n\n` +
    `Abaixo estão (a) um trecho do processo em análise — tipicamente a petição inicial — e (b) ${req.candidates.length} candidatos a modelo de referência, cada um com um excerto.\n\n` +
    `Sua tarefa: ordenar os candidatos do MAIS adequado para o MENOS adequado, considerando que o melhor modelo é aquele que trata do MESMO tipo de causa (mesma matéria, mesmo benefício, mesma tese jurídica) E do mesmo tipo de peça. A similaridade lexical pura já foi feita pelo BM25 — você deve usar julgamento jurídico para reordenar.\n\n` +
    `=== TRECHO DO PROCESSO ===\n` +
    '```\n' +
    req.caseContext.slice(0, 3000) +
    '\n```\n\n' +
    `=== CANDIDATOS ===\n${candidatosFmt}\n\n` +
    `Responda SEMPRE em JSON puro, sem markdown, sem comentários, no formato exato:\n` +
    `{"ranking": [<índices na nova ordem, do melhor para o pior>], "justificativa": "<texto curto em PT-BR explicando por que o primeiro foi escolhido — máximo 2 frases>"}\n\n` +
    `Os índices DEVEM ser números inteiros entre 0 e ${req.candidates.length - 1}, cada um aparecendo exatamente uma vez. NÃO inclua mais nada além do JSON.`
  );
}

/**
 * Tolerante a respostas com markdown ou texto extra: extrai o primeiro
 * objeto JSON válido contendo `ranking`. Devolve null se nada bater.
 */
function parseRerankResponse(
  raw: string,
  expectedSize: number
): { ranking: number[]; justificativa: string } | null {
  if (!raw) return null;
  // Tenta pegar o maior bloco { ... } da resposta.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = raw.slice(start, end + 1);
  try {
    const obj = JSON.parse(slice) as {
      ranking?: unknown;
      justificativa?: unknown;
    };
    if (!Array.isArray(obj.ranking)) return null;
    const ranking: number[] = [];
    const seen = new Set<number>();
    for (const r of obj.ranking) {
      const n = typeof r === 'number' ? r : Number(r);
      if (!Number.isInteger(n) || n < 0 || n >= expectedSize) return null;
      if (seen.has(n)) continue;
      seen.add(n);
      ranking.push(n);
    }
    if (ranking.length === 0) return null;
    // Completa com índices ausentes na ordem original (defensivo).
    for (let i = 0; i < expectedSize; i++) {
      if (!seen.has(i)) ranking.push(i);
    }
    const justificativa =
      typeof obj.justificativa === 'string' ? obj.justificativa.trim() : '';
    return { ranking, justificativa };
  } catch {
    return null;
  }
}

// =====================================================================
// Triagem de minuta — decide o melhor ato processual para o momento atual
// =====================================================================

interface TriagemRequest {
  /** Grau detectado na página; determina o conjunto de atos disponíveis. */
  grau: '1g' | '2g' | 'turma_recursal' | 'unknown';
  /** Trecho consolidado dos autos (já truncado pelo content). */
  caseContext: string;
}

interface TriagemResponse {
  ok: boolean;
  result?: TriagemResult;
  /** Atos disponíveis (id + label) para o grau, para a UI oferecer alternativas. */
  availableActions?: Array<{ id: string; label: string; description: string }>;
  error?: string;
}

async function handleMinutarTriagem(
  payload: TriagemRequest,
  sendResponse: (response: TriagemResponse) => void
): Promise<void> {
  // A lista de atos disponíveis é sempre calculável pelo grau — mesmo
  // quando a triagem falha, devolvemos esta lista para a UI oferecer os
  // botões de escolha manual.
  const actions: readonly TemplateAction[] = getTemplateActionsForGrau(
    payload?.grau ?? 'unknown'
  );
  const availableActions = actions.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description
  }));

  try {
    if (!payload?.caseContext || !payload.caseContext.trim()) {
      sendResponse({
        ok: false,
        availableActions,
        error: 'Sem contexto dos autos — carregue e extraia os documentos antes.'
      });
      return;
    }

    const settings = await getSettings();
    const providerId = settings.activeProvider;
    const apiKey = await getApiKey(providerId);
    if (!apiKey) {
      sendResponse({
        ok: false,
        availableActions,
        error: `API key não cadastrada para ${providerId}.`
      });
      return;
    }

    const provider = getProvider(providerId);
    const prompt = buildTriagemPrompt(actions, payload.caseContext);

    const controller = new AbortController();
    const generator = provider.sendMessage({
      apiKey,
      model: settings.models[providerId],
      systemPrompt:
        'Você é um assistente que auxilia magistrados brasileiros na escolha do ato processual mais adequado. ' +
        'Responda SEMPRE em JSON puro, sem texto adicional, sem markdown.',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      temperature: 0,
      maxTokens: 512,
      signal: controller.signal
    });

    let raw = '';
    for await (const chunk of generator) {
      raw += chunk.delta;
    }

    const allowedIds = actions.map((a) => a.id);
    const parsed = parseTriagemResponse(raw, allowedIds);
    if (!parsed) {
      sendResponse({
        ok: false,
        availableActions,
        error: 'Resposta do LLM não pôde ser interpretada como JSON de triagem.'
      });
      return;
    }

    sendResponse({ ok: true, result: parsed, availableActions });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleMinutarTriagem falhou:`, error);
    sendResponse({
      ok: false,
      availableActions,
      error: errorMessage(error)
    });
  }
}

// =====================================================================
// Analisar o processo — checklist dos critérios de admissibilidade
// =====================================================================

interface AnalisarProcessoRequest {
  /** Critérios já resolvidos (NT padrão ou entendimento próprio + livres). */
  criterios: CriterioResolvido[];
  /** Trecho consolidado dos autos (já truncado pelo content). */
  caseContext: string;
}

interface AnalisarProcessoResponse {
  ok: boolean;
  result?: AnaliseProcessoResult;
  error?: string;
}

async function handleAnalisarProcesso(
  payload: AnalisarProcessoRequest,
  sendResponse: (response: AnalisarProcessoResponse) => void
): Promise<void> {
  try {
    if (!payload?.caseContext || !payload.caseContext.trim()) {
      sendResponse({
        ok: false,
        error: 'Sem contexto dos autos — carregue e extraia os documentos antes.'
      });
      return;
    }
    const criterios = Array.isArray(payload.criterios) ? payload.criterios : [];
    if (criterios.length === 0) {
      sendResponse({
        ok: false,
        error:
          'Nenhum critério configurado. Acesse a aba "Triagem Inteligente" do popup para adotar ou descrever critérios.'
      });
      return;
    }

    const settings = await getSettings();
    const providerId = settings.activeProvider;
    const apiKey = await getApiKey(providerId);
    if (!apiKey) {
      sendResponse({
        ok: false,
        error: `API key não cadastrada para ${providerId}.`
      });
      return;
    }

    const provider = getProvider(providerId);
    const prompt = buildAnaliseProcessoPrompt(criterios, payload.caseContext);

    const controller = new AbortController();
    const generator = provider.sendMessage({
      apiKey,
      model: settings.models[providerId],
      systemPrompt:
        'Você é um assistente que auxilia a Secretaria de uma Vara Federal a verificar se uma petição inicial atende aos critérios de admissibilidade adotados pelo magistrado. ' +
        'Responda SEMPRE em JSON puro, sem texto adicional, sem markdown.',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      temperature: 0,
      // Resposta carrega justificativa para cada critério da NT (até 11) +
      // critérios livres. 4096 cobre com folga sem desperdício.
      maxTokens: 4096,
      signal: controller.signal
    });

    let raw = '';
    for await (const chunk of generator) {
      raw += chunk.delta;
    }

    const parsed = parseAnaliseProcessoResponse(raw, criterios);
    if (!parsed) {
      sendResponse({
        ok: false,
        error: 'Resposta do LLM não pôde ser interpretada como JSON de análise.'
      });
      return;
    }

    sendResponse({ ok: true, result: parsed });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleAnalisarProcesso falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

// =====================================================================
// Encaminhar e inserir emenda — automação na aba do processo
// =====================================================================

interface EncaminharEmendaRequest {
  /** HTML renderizado da minuta de emenda (bolha do chat). */
  html: string;
  /** Número do processo detectado no sidebar (CNJ, qualquer formatação). */
  numeroProcesso: string;
}

type EncaminharEmendaStage =
  | 'find-tab'
  | 'click-transition'
  | 'wait-editor'
  | 'inject';

interface EncaminharEmendaResponse {
  ok: boolean;
  error?: string;
  stage?: EncaminharEmendaStage;
}

/**
 * Nome público da transição, como aparece na linha do item no dropdown
 * (`<a>...texto...</a>`). O atributo `title` do anchor costuma vir com o
 * prefixo "Encaminhar para " + quebra de linha, então a identificação
 * robusta passa pelo texto visível.
 */
const TRANSICAO_EMENDA_NOME = 'Comunicação - Elaborar (emenda automática)';

async function handleEncaminharEmenda(
  payload: EncaminharEmendaRequest,
  sendResponse: (response: EncaminharEmendaResponse) => void
): Promise<void> {
  try {
    const html = (payload?.html ?? '').trim();
    const numeroProcesso = (payload?.numeroProcesso ?? '').trim();
    if (!html) {
      sendResponse({ ok: false, error: 'Conteúdo da minuta está vazio.' });
      return;
    }
    if (!numeroProcesso) {
      sendResponse({ ok: false, error: 'Número do processo não informado.' });
      return;
    }
    const numeroDigits = numeroProcesso.replace(/\D+/g, '');
    if (!numeroDigits || numeroDigits.length < 10) {
      sendResponse({ ok: false, error: 'Número do processo inválido.' });
      return;
    }

    // Passo 1 — localiza a aba do PJe com a tarefa do processo aberta.
    const target = await encontrarAbaComTransicao(numeroDigits);
    if (!target) {
      sendResponse({
        ok: false,
        stage: 'find-tab',
        error:
          `Não localizei a tarefa do processo ${numeroProcesso} aberta em outra aba do navegador. ` +
          'Abra a tarefa no PJe (com o botão de transições visível) e tente de novo.'
      });
      return;
    }

    // Passo 2 — clica no item de transição (título exato).
    const clickResult = await clickTransicaoNoFrame(target.tabId, target.frameId);
    if (!clickResult.ok) {
      sendResponse({
        ok: false,
        stage: 'click-transition',
        error:
          clickResult.error ??
          `Transição "${TRANSICAO_EMENDA_NOME}" não encontrada na tarefa.`
      });
      return;
    }

    // Passo 3 — aguarda o editor Badon (iframe appEditorAreaIframe) carregar.
    const editorFrameId = await aguardarEditorBadon(target.tabId, 20000);
    if (editorFrameId === null) {
      sendResponse({
        ok: false,
        stage: 'wait-editor',
        error:
          'Transição acionada, mas o editor Badon não apareceu em 20s. ' +
          'Verifique a aba do PJe e, se o editor estiver aberto, use o ' +
          'botão "Inserir no PJe" manualmente.'
      });
      return;
    }

    // Passo 4 — injeta o HTML no ProseMirror dentro do iframe.
    const injectResult = await injetarMinutaNoBadon(
      target.tabId,
      editorFrameId,
      html
    );
    if (!injectResult.ok) {
      sendResponse({
        ok: false,
        stage: 'inject',
        error: injectResult.error ?? 'Falha ao inserir a minuta no editor.'
      });
      return;
    }

    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleEncaminharEmenda falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Varre todas as abas jus.br procurando a frame que:
 *   (a) tem o botão `#btnTransicoesTarefa` (só existe em visão de tarefa); e
 *   (b) menciona, em qualquer parte do texto visível, o número do processo.
 *
 * Devolve o primeiro casamento, incluindo o `frameId` para que os passos
 * seguintes se prendam àquele frame específico (mais confiável do que
 * re-buscar em allFrames entre passos).
 */
async function encontrarAbaComTransicao(
  numeroDigits: string
): Promise<{ tabId: number; frameId: number } | null> {
  const tabs = await chrome.tabs.query({ url: 'https://*.jus.br/*' });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: probeTransicaoFrame,
        args: [numeroDigits]
      });
      for (const r of results) {
        if (r.result === true && r.frameId !== undefined) {
          return { tabId: tab.id, frameId: r.frameId };
        }
      }
    } catch {
      /* aba sem permissão — ignora */
    }
  }
  return null;
}

function probeTransicaoFrame(numeroDigits: string): boolean {
  if (!document.querySelector('#btnTransicoesTarefa')) return false;
  const text = (document.body?.innerText ?? '') + ' ' + (document.title ?? '');
  const normalized = text.replace(/\D+/g, '');
  return normalized.includes(numeroDigits);
}

async function clickTransicaoNoFrame(
  tabId: number,
  frameId: number
): Promise<{ ok: boolean; error?: string }> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: clickTransicaoProbe,
      args: [TRANSICAO_EMENDA_NOME]
    });
    const first = results[0]?.result as
      | { ok: boolean; error?: string }
      | undefined;
    return first ?? { ok: false, error: 'Frame não respondeu.' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Probe injetada na frame da tarefa. Identifica o anchor da transição
 * pelo **texto visível** (nome público da transição). Algumas versões do
 * PJe/Angular carregam os itens do dropdown depois do clique no toggle,
 * então o probe é assíncrono e faz poll por até ~2 s antes de desistir.
 */
async function clickTransicaoProbe(
  nomeTransicao: string
): Promise<{ ok: boolean; error?: string }> {
  const norm = (s: string | null | undefined): string =>
    (s ?? '').replace(/\s+/g, ' ').trim();
  const alvo = norm(nomeTransicao);

  const findMatch = (): HTMLAnchorElement | null => {
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'ul.dropdown-transicoes a, ul[aria-labelledby="btnTransicoesTarefa"] a, a[title]'
      )
    );
    for (const a of anchors) {
      const txt = norm(a.textContent);
      const tit = norm(a.getAttribute('title'));
      if (
        txt === alvo ||
        tit === alvo ||
        tit === `Encaminhar para ${alvo}`
      ) {
        return a;
      }
    }
    return null;
  };

  let anchor = findMatch();
  if (!anchor) {
    // Abre o dropdown para forçar a renderização dos itens.
    try {
      document.querySelector<HTMLElement>('#btnTransicoesTarefa')?.click();
    } catch {
      /* ignore */
    }
    // Poll de ~2 s (10 × 200 ms) — Angular pode inserir os <a> em ciclos
    // posteriores ao clique síncrono.
    for (let i = 0; i < 10 && !anchor; i++) {
      await new Promise((r) => setTimeout(r, 200));
      anchor = findMatch();
    }
  }
  if (!anchor) {
    return {
      ok: false,
      error: `Transição "${nomeTransicao}" não encontrada no dropdown desta tarefa.`
    };
  }
  try {
    anchor.click();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

async function aguardarEditorBadon(
  tabId: number,
  timeoutMs: number
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: probeEditorDisponivel
      });
      for (const r of results) {
        if (r.result === true && r.frameId !== undefined) {
          return r.frameId;
        }
      }
    } catch {
      /* aba em navegação — segue polling */
    }
  }
  return null;
}

/**
 * Detecta se esta frame tem algum editor conhecido do PJe (Badon/ProseMirror
 * direto, ProseMirror dentro de `#appEditorAreaIframe`, CKEditor 4 ou
 * contenteditable genérico com área útil).
 */
function probeEditorDisponivel(): boolean {
  // 1. ProseMirror direto na própria frame.
  if (document.querySelector('.ProseMirror[contenteditable="true"]')) {
    return true;
  }
  // 2. ProseMirror dentro de appEditorAreaIframe (about:blank same-origin).
  const iframeBadon = document.querySelector<HTMLIFrameElement>(
    '#appEditorAreaIframe'
  );
  if (iframeBadon) {
    try {
      const doc =
        iframeBadon.contentDocument ??
        iframeBadon.contentWindow?.document ??
        null;
      if (doc?.querySelector('.ProseMirror[contenteditable="true"]')) {
        return true;
      }
    } catch {
      /* iframe bloqueado — segue */
    }
  }
  // 3. CKEditor 4 (iframe.cke_wysiwyg_frame).
  const cke = document.querySelector<HTMLIFrameElement>(
    'iframe.cke_wysiwyg_frame'
  );
  if (cke) {
    try {
      if (cke.contentDocument?.body) return true;
    } catch {
      /* ignore */
    }
  }
  // 4. Contenteditable genérico com área útil.
  const ce = document.querySelector<HTMLElement>('[contenteditable="true"]');
  if (ce) {
    const r = ce.getBoundingClientRect();
    if (r.width > 200 && r.height > 80) return true;
  }
  return false;
}

async function injetarMinutaNoBadon(
  tabId: number,
  frameId: number,
  html: string
): Promise<{ ok: boolean; error?: string }> {
  // Texto cru para fallback do paste (text/plain).
  const plain = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: injetarBadonProbe,
      args: [html, plain]
    });
    const first = results[0]?.result as
      | { ok: boolean; error?: string }
      | undefined;
    return first ?? { ok: false, error: 'Frame não respondeu.' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function injetarBadonProbe(
  html: string,
  plain: string
): { ok: boolean; error?: string; kind?: string } {
  /** Paste sintético com limpeza prévia em um ProseMirror identificado. */
  const injectIntoProseMirror = (
    pm: HTMLElement,
    pmDoc: Document,
    pmWin: Window
  ): { ok: boolean; error?: string } => {
    try {
      pm.focus();
      const sel = pmWin.getSelection();
      if (sel) {
        const range = pmDoc.createRange();
        range.selectNodeContents(pm);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      // Limpa template pré-preenchido da transição antes de colar.
      try {
        pmDoc.execCommand('delete', false);
      } catch {
        /* fallback cai no paste substituindo a seleção */
      }
      if (sel && sel.rangeCount === 0) {
        const r = pmDoc.createRange();
        r.selectNodeContents(pm);
        r.collapse(false);
        sel.addRange(r);
      }
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', plain);
      const ev = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      if (!ev.clipboardData) {
        try {
          Object.defineProperty(ev, 'clipboardData', { value: dt });
        } catch {
          /* ignore */
        }
      }
      pm.dispatchEvent(ev);
      pm.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  };

  // 1. ProseMirror direto na frame.
  const pmDirect = document.querySelector<HTMLElement>(
    '.ProseMirror[contenteditable="true"]'
  );
  if (pmDirect) {
    const r = injectIntoProseMirror(pmDirect, document, window);
    return r.ok ? { ok: true, kind: 'prosemirror-direct' } : r;
  }

  // 2. ProseMirror dentro de appEditorAreaIframe (about:blank).
  const iframe = document.querySelector<HTMLIFrameElement>(
    '#appEditorAreaIframe'
  );
  if (iframe) {
    let idoc: Document | null = null;
    let iwin: Window | null = null;
    try {
      idoc = iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
      iwin = iframe.contentWindow;
    } catch {
      return { ok: false, error: 'Iframe do editor bloqueado (cross-origin).' };
    }
    if (idoc && iwin) {
      const pm = idoc.querySelector<HTMLElement>(
        '.ProseMirror[contenteditable="true"]'
      );
      if (pm) {
        const r = injectIntoProseMirror(pm, idoc, iwin);
        return r.ok ? { ok: true, kind: 'prosemirror-iframe' } : r;
      }
    }
  }

  // 3. CKEditor 4 (iframe.cke_wysiwyg_frame) — substitui via execCommand.
  const cke = document.querySelector<HTMLIFrameElement>(
    'iframe.cke_wysiwyg_frame'
  );
  if (cke) {
    try {
      const doc = cke.contentDocument;
      const win = cke.contentWindow;
      if (doc && win && doc.body) {
        doc.body.focus();
        const range = doc.createRange();
        range.selectNodeContents(doc.body);
        const sel = win.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        doc.execCommand('delete', false);
        const ok = doc.execCommand('insertHTML', false, html);
        doc.body.dispatchEvent(new Event('input', { bubbles: true }));
        if (ok) return { ok: true, kind: 'ckeditor4' };
      }
    } catch {
      /* ignore e cai no próximo */
    }
  }

  // 4. Contenteditable genérico com área útil.
  const editables = Array.from(
    document.querySelectorAll<HTMLElement>('[contenteditable="true"]')
  );
  for (const el of editables) {
    const r = el.getBoundingClientRect();
    if (r.width > 200 && r.height > 80) {
      try {
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand('delete', false);
        document.execCommand('insertHTML', false, html);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, kind: 'contenteditable' };
      } catch {
        /* tenta o próximo */
      }
    }
  }

  return { ok: false, error: 'Nenhum editor reconhecido nesta frame.' };
}

async function handleTemplatesRerank(
  payload: RerankRequest,
  sendResponse: (response: RerankResponse) => void
): Promise<void> {
  try {
    if (
      !payload ||
      !Array.isArray(payload.candidates) ||
      payload.candidates.length < 2
    ) {
      // Nada a reordenar — content vai usar a ordem do BM25.
      sendResponse({ ok: true, ranking: [] });
      return;
    }
    if (!payload.caseContext || !payload.caseContext.trim()) {
      // Sem contexto da causa o rerank não traz ganho — pula.
      sendResponse({ ok: true, ranking: [] });
      return;
    }

    const settings = await getSettings();
    const providerId = settings.activeProvider;
    const apiKey = await getApiKey(providerId);
    if (!apiKey) {
      sendResponse({
        ok: false,
        error: `API key não cadastrada para ${providerId}.`
      });
      return;
    }

    const provider = getProvider(providerId);
    const prompt = buildRerankPrompt(payload);

    const controller = new AbortController();
    const generator = provider.sendMessage({
      apiKey,
      model: settings.models[providerId],
      systemPrompt:
        'Você é um assistente que ajuda magistrados brasileiros a selecionar modelos de minuta. ' +
        'Responda SEMPRE em JSON puro, sem texto adicional, sem markdown.',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      temperature: 0,
      maxTokens: 512,
      signal: controller.signal
    });

    let raw = '';
    for await (const chunk of generator) {
      raw += chunk.delta;
    }

    const parsed = parseRerankResponse(raw, payload.candidates.length);
    if (!parsed) {
      sendResponse({
        ok: false,
        error: 'Resposta do LLM não pôde ser interpretada como JSON de rerank.'
      });
      return;
    }

    sendResponse({
      ok: true,
      ranking: parsed.ranking,
      justificativa: parsed.justificativa
    });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleTemplatesRerank falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleTemplatesSearch(
  payload: { query: string; opts?: SearchOptions },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const results = await searchTemplates(payload?.query ?? '', payload?.opts);
    // Devolve apenas os campos necessários para o content (sem texto completo
    // dos demais — só o template VENCEDOR vai precisar de texto completo, e
    // o content vai pedir só o que escolher).
    sendResponse({
      ok: true,
      results: results.map((r) => ({
        id: r.template.id,
        relativePath: r.template.relativePath,
        name: r.template.name,
        ext: r.template.ext,
        charCount: r.template.charCount,
        score: r.score,
        similarity: r.similarity,
        matchedFolderHint: r.matchedFolderHint,
        // Texto completo embutido — para o caso de uso (5 botões com top-3),
        // são no máximo 3 textos. Mais simples que round-trip extra.
        text: r.template.text
      }))
    });
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Roteia uma requisição de inserção do sidebar para o editor do PJe, que
 * pode estar em outra janela do navegador, em outra aba ou — caso comum
 * no PJe novo do TRF5 — dentro de um iframe Angular cross-origin
 * (`#ngFrame` apontando para frontend-prd.trf5.jus.br) onde o content
 * script padrão não chega.
 *
 * Estratégia: usa `chrome.scripting.executeScript` com `allFrames: true`,
 * que injeta a função sob demanda em TODAS as frames de cada aba jus.br
 * aberta — incluindo iframes cross-origin, desde que casem com o
 * `host_permissions` da extensão. A função é auto-contida (sem imports)
 * porque é serializada pelo Chrome para enviar à página.
 *
 * Devolve o primeiro frame que aceitou a inserção, ou erro agregado.
 */
async function handleInsertInPJeEditor(
  payload: { html: string; plain: string; actionId?: string },
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.jus.br/*' });
    const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);

    if (tabIds.length === 0) {
      sendResponse({
        ok: false,
        error: 'Nenhuma aba do PJe aberta. Abra a tela de minutar peça.'
      });
      return;
    }

    const actionId = payload.actionId ?? '';

    // Primeiro passe: tenta inserir diretamente (editor já está visível).
    const firstPassResult = await tryInsertInTabs(tabIds, payload.html, payload.plain);
    if (firstPassResult) {
      sendResponse(firstPassResult);
      return;
    }

    // Segundo passe: se nenhum editor foi encontrado mas há o select de tipo
    // de ato, seleciona o tipo correto e aguarda o editor Badon carregar.
    if (actionId) {
      let tipoSelecionado = false;
      for (const tabId of tabIds) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: tipoDocumentoProbe,
            args: [actionId]
          });
          if (results.some((r) => r.result === true)) {
            tipoSelecionado = true;
            // Aguarda o AJAX do PJe carregar o editor, com poll de ~300 ms
            // por até 6 s. Cada tentativa é uma chamada chrome.* (via
            // tryInsertInTabs -> executeScript), o que mantém o service
            // worker vivo. Uma espera única de 3 s com setTimeout puro não
            // conta como trabalho ativo no MV3 e permitia o SW ser
            // suspenso no meio da operação — fechando o canal do
            // sendMessage do sidebar antes da resposta.
            const deadline = Date.now() + 6000;
            let inserted: Awaited<ReturnType<typeof tryInsertInTabs>> = null;
            while (Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 300));
              inserted = await tryInsertInTabs([tabId], payload.html, payload.plain);
              if (inserted) break;
            }
            if (inserted) {
              sendResponse(inserted);
              return;
            }
            break;
          }
        } catch {
          /* ignora tabs sem permissão */
        }
      }
      if (tipoSelecionado) {
        sendResponse({
          ok: false,
          triedTabs: tabIds.length,
          error:
            'O tipo de ato foi selecionado, mas o editor não carregou a tempo. ' +
            'Aguarde o editor aparecer na tela de minutar peça e tente novamente.'
        });
        return;
      }
    }

    sendResponse({
      ok: false,
      triedTabs: tabIds.length,
      error:
        'Nenhum editor encontrado. Abra a tela de minutar peça no PJe e tente novamente.'
    });
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Tenta inserir conteúdo em todas as tabs fornecidas. Retorna o primeiro
 * resultado bem-sucedido, ou null se nenhum editor foi encontrado.
 */
async function tryInsertInTabs(
  tabIds: number[],
  html: string,
  plain: string
): Promise<{ ok: true; kind: string; tabId: number; frameId?: number } | null> {
  for (const tabId of tabIds) {
    try {
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: insertionProbe,
        args: [html, plain]
      });
      for (const r of injectionResults) {
        const result = r.result as { ok: boolean; kind?: string } | null | undefined;
        if (result?.ok) {
          return { ok: true, kind: result.kind ?? 'unknown', tabId, frameId: r.frameId };
        }
      }
    } catch {
      /* ignora tabs sem permissão */
    }
  }
  return null;
}

/**
 * Probe injetada nas frames de tabs jus.br para selecionar o tipo de ato no
 * dropdown do PJe. Retorna true se encontrou e alterou o select (ou se já
 * estava no valor correto), false se o select não existe nesta frame.
 *
 * Como insertionProbe, esta função é auto-contida — não pode importar nada.
 */
function tipoDocumentoProbe(actionId: string): boolean {
  const ACTION_TO_TIPO: Record<string, string> = {
    'sentenca-procedente': '2',
    'sentenca-improcedente': '2',
    'decidir': '0',
    'converter-diligencia': '1',
    'despachar': '1',
    'voto-mantem': '0',
    'voto-reforma': '0',
    'decisao-nega-seguimento': '0',
    'decisao-2g': '0',
    'converter-diligencia-baixa': '1',
    'despachar-2g': '1'
  };

  const targetValue = ACTION_TO_TIPO[actionId];
  if (!targetValue) return false;

  const select = document.querySelector<HTMLSelectElement>(
    'select[id*="selectMenuTipoDocumento"]'
  );
  if (!select) return false;

  // Já está no valor correto?
  if (select.value === targetValue) return true;

  // Altera e dispara o onchange para acionar o AJAX do PJe.
  select.value = targetValue;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * Função auto-contida injetada via chrome.scripting.executeScript em todas
 * as frames de cada aba jus.br. Tenta detectar e inserir conteúdo em
 * qualquer um dos editores conhecidos do PJe (Badon/ProseMirror, CKEditor 4,
 * contenteditable genérico). Devolve `{ ok, kind }` ou `null` se a frame
 * não tem editor.
 *
 * Não pode importar nada — o Chrome serializa a função e a re-executa em
 * cada frame, sem acesso ao bundle webpack do background.
 */
function insertionProbe(
  html: string,
  plain: string
): { ok: boolean; kind: string } | null {
  // ----- 1. ProseMirror / Badon -----
  const pmCandidates = Array.from(
    document.querySelectorAll<HTMLElement>('.ProseMirror[contenteditable="true"]')
  );
  let pm: HTMLElement | null = null;
  for (let i = pmCandidates.length - 1; i >= 0; i--) {
    const candidate = pmCandidates[i];
    if (!candidate) continue;
    const rect = candidate.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      pm = candidate;
      break;
    }
  }
  if (!pm && pmCandidates.length > 0) {
    pm = pmCandidates[pmCandidates.length - 1] ?? null;
  }
  if (pm) {
    try {
      pm.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(pm);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', plain);
      const ev = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      if (!ev.clipboardData) {
        try {
          Object.defineProperty(ev, 'clipboardData', { value: dt });
        } catch {
          /* ignore */
        }
      }
      pm.dispatchEvent(ev);

      // Força a scrollbar a aparecer após a inserção. O editor do PJe
      // (ProseMirror dentro do iframe appEditorAreaIframe) tem o body com
      // overflow:visible por padrão. Quando o conteúdo excede a área
      // visível (scrollHeight > clientHeight), o body precisa de
      // overflow-y:auto para que a scrollbar nativa apareça. O editor
      // normalmente gerencia isso ao detectar digitação do usuário, mas
      // o paste sintético não dispara esse mecanismo.
      pm.dispatchEvent(new Event('input', { bubbles: true }));

      const enableScrollbar = (editor: HTMLElement): void => {
        const doc = editor.ownerDocument;
        const body = doc.body;
        // Se o conteúdo excede a área visível, habilita overflow-y no body
        if (body && body.scrollHeight > body.clientHeight + 10) {
          body.style.overflowY = 'auto';
        }
        // Também verifica o documentElement (html)
        const html = doc.documentElement;
        if (html && html.scrollHeight > html.clientHeight + 10) {
          html.style.overflowY = 'auto';
        }
        // Percorre ancestrais do editor procurando containers com overflow
        let target: HTMLElement | null = editor;
        while (target) {
          if (target.scrollHeight > target.clientHeight + 10) {
            target.style.overflowY = 'auto';
          }
          target = target.parentElement;
        }
        window.dispatchEvent(new Event('resize'));
      };

      enableScrollbar(pm);
      // Passes assíncronos para cobrir recálculos tardios do editor
      requestAnimationFrame(() => enableScrollbar(pm!));
      setTimeout(() => enableScrollbar(pm!), 300);

      return { ok: true, kind: 'badon-prosemirror' };
    } catch {
      /* fall through */
    }
  }

  // ----- 2. CKEditor 4 (iframe) -----
  const ckes = Array.from(
    document.querySelectorAll<HTMLIFrameElement>('iframe.cke_wysiwyg_frame')
  );
  for (const iframe of ckes) {
    try {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win || !doc.body) continue;
      doc.body.focus();
      const range = doc.createRange();
      range.selectNodeContents(doc.body);
      range.collapse(false);
      const sel = win.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const ok = doc.execCommand('insertHTML', false, '<div>' + html + '</div>');
      doc.body.dispatchEvent(new Event('input', { bubbles: true }));
      if (ok) {
        return { ok: true, kind: 'ckeditor4-iframe' };
      }
    } catch {
      /* tenta o próximo */
    }
  }

  // ----- 3. Contenteditable genérico (CKEditor 5 inline, Quill, etc.) -----
  const editables = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[contenteditable="true"], [contenteditable=""]'
    )
  );
  for (const el of editables) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 80) {
      try {
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand('insertHTML', false, html);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, kind: 'contenteditable' };
      } catch {
        /* tenta o próximo */
      }
    }
  }

  return null;
}

async function handleGetSettings(
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const settings = await getSettings();
    const presence = await getAllApiKeyPresence();
    sendResponse({ ok: true, settings, apiKeyPresence: presence });
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error), settings: defaultSettings() });
  }
}

async function handleSaveSettings(
  partial: Partial<PAIdeguaSettings>,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const current = await getSettings();
    const merged: PAIdeguaSettings = {
      ...current,
      ...partial,
      models: { ...current.models, ...(partial.models ?? {}) }
    };
    await saveSettings(merged);
    sendResponse({ ok: true, settings: merged });
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleSaveApiKey(
  payload: { provider: ProviderId; apiKey: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!payload?.provider || !payload?.apiKey) {
      sendResponse({ ok: false, error: 'provider e apiKey são obrigatórios' });
      return;
    }
    await saveApiKey(payload.provider, payload.apiKey.trim());
    sendResponse({ ok: true });
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleHasApiKey(
  payload: { provider: ProviderId },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const present = await hasApiKey(payload.provider);
    sendResponse({ ok: true, present });
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleRemoveApiKey(
  payload: { provider: ProviderId },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    await removeApiKey(payload.provider);
    sendResponse({ ok: true });
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleTestConnection(
  payload: { provider: ProviderId; model: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const apiKey = await getApiKey(payload.provider);
    if (!apiKey) {
      const result: TestConnectionResult = {
        ok: false,
        error: 'API key não cadastrada para este provedor.'
      };
      sendResponse(result);
      return;
    }
    const provider = getProvider(payload.provider);
    const result = await provider.testConnection(apiKey, payload.model);
    sendResponse(result);
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleTranscribeAudio(
  payload: TranscribeAudioPayload,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const provider = getProvider(payload.provider);
    if (!provider.transcribeAudio) {
      sendResponse({ ok: false, useBrowserFallback: true });
      return;
    }
    const apiKey = await getApiKey(payload.provider);
    if (!apiKey) {
      sendResponse({ ok: false, error: 'API key não cadastrada.' });
      return;
    }
    const audioBytes = base64ToBytes(payload.audioBase64);
    const text = await provider.transcribeAudio(apiKey, audioBytes, payload.mimeType);
    if (!text) {
      sendResponse({ ok: false, error: 'Transcrição vazia.' });
      return;
    }
    sendResponse({ ok: true, text });
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleSynthesizeSpeech(
  payload: SynthesizeSpeechPayload,
  sendResponse: (response: SynthesizeSpeechResult) => void
): Promise<void> {
  try {
    const provider = getProvider(payload.provider);
    if (!provider.synthesizeSpeech) {
      sendResponse({ ok: true, useBrowserFallback: true });
      return;
    }
    const apiKey = await getApiKey(payload.provider);
    if (!apiKey) {
      sendResponse({ ok: false, error: 'API key não cadastrada.' });
      return;
    }
    const result = await provider.synthesizeSpeech(apiKey, payload.text, payload.voice);
    if (!result) {
      sendResponse({ ok: true, useBrowserFallback: true });
      return;
    }
    sendResponse({
      ok: true,
      audioBase64: bytesToBase64(result.audio),
      mimeType: result.mimeType
    });
  } catch (error: unknown) {
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

// =====================================================================
// Porta long-lived: streaming de chat.
// =====================================================================

interface ActiveChat {
  controller: AbortController;
}

const activeChats = new WeakMap<chrome.runtime.Port, ActiveChat>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAMES.CHAT_STREAM) {
    return;
  }
  console.log(`${LOG_PREFIX} chat port conectada`);

  port.onMessage.addListener((msg: { type: string; payload?: unknown }) => {
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (msg.type === CHAT_PORT_MSG.START) {
      void handleChatStart(port, msg.payload as ChatStartPayload);
    } else if (msg.type === CHAT_PORT_MSG.ABORT) {
      const active = activeChats.get(port);
      active?.controller.abort();
    }
  });

  port.onDisconnect.addListener(() => {
    const active = activeChats.get(port);
    active?.controller.abort();
    activeChats.delete(port);
  });
});

async function handleChatStart(
  port: chrome.runtime.Port,
  payload: ChatStartPayload
): Promise<void> {
  // Cancela qualquer chat anterior na mesma porta.
  const previous = activeChats.get(port);
  previous?.controller.abort();

  const controller = new AbortController();
  activeChats.set(port, { controller });

  try {
    const settings = await getSettings();
    const apiKey = await getApiKey(payload.provider);
    if (!apiKey) {
      port.postMessage({
        type: CHAT_PORT_MSG.ERROR,
        error: `API key não cadastrada para ${payload.provider}.`
      });
      return;
    }

    const provider = getProvider(payload.provider);

    // Monta mensagens: contexto dos documentos vai como primeira user message
    // do histórico (não como system, para não inflar o system em provedores
    // que cobram caro pelo system prompt).
    const docContext = buildDocumentContext(
      payload.documents,
      payload.numeroProcesso
    );

    const augmented: ChatMessage[] = [];
    if (payload.documents.length > 0) {
      augmented.push({
        role: 'user',
        content: docContext,
        timestamp: Date.now()
      });
      augmented.push({
        role: 'assistant',
        content:
          'Documentos carregados. Estou pronto para responder com base nos autos.',
        timestamp: Date.now()
      });
    }
    augmented.push(...payload.messages);

    const generator = provider.sendMessage({
      apiKey,
      model: payload.model,
      systemPrompt: SYSTEM_PROMPT,
      messages: augmented,
      temperature: payload.temperature ?? settings.temperature,
      maxTokens: payload.maxTokens ?? settings.maxTokens,
      signal: controller.signal
    });

    for await (const chunk of generator) {
      if (controller.signal.aborted) {
        break;
      }
      port.postMessage({ type: CHAT_PORT_MSG.CHUNK, delta: chunk.delta });
    }
    port.postMessage({ type: CHAT_PORT_MSG.DONE });
  } catch (error: unknown) {
    if ((error as { name?: string }).name === 'AbortError') {
      port.postMessage({ type: CHAT_PORT_MSG.DONE });
      return;
    }
    port.postMessage({
      type: CHAT_PORT_MSG.ERROR,
      error: errorMessage(error)
    });
  } finally {
    activeChats.delete(port);
  }
}

// =====================================================================
// "Analisar tarefas" — abertura do dashboard e geração de insights LLM
// =====================================================================

/**
 * Recebe o payload completo (com PII) do content script, grava em
 * `chrome.storage.session` (volátil — apagada ao fechar o navegador) e
 * abre uma nova aba apontando para a página estática do dashboard.
 *
 * O payload completo NÃO sai da máquina: a chamada à LLM acontece em uma
 * segunda etapa (canal TRIAGEM_INSIGHTS), e a versão sanitizada é
 * preparada pelo dashboard antes do envio.
 */
async function handleOpenTriagemDashboard(
  payload: TriagemDashboardPayload,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!payload || !Array.isArray(payload.tarefas)) {
      sendResponse({ ok: false, error: 'Payload de triagem inválido.' });
      return;
    }
    await chrome.storage.session.set({
      [STORAGE_KEYS.TRIAGEM_DASHBOARD_PAYLOAD]: payload
    });
    const url = chrome.runtime.getURL('dashboard/dashboard.html');
    await chrome.tabs.create({ url });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleOpenTriagemDashboard falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Recebe a minuta a ser salva como modelo pelo content script, estaciona
 * em `chrome.storage.session` e abre a página dedicada em nova aba.
 *
 * A gravação em si (acesso ao FileSystemDirectoryHandle persistido no IDB
 * e write na pasta) não pode acontecer aqui porque o service worker não
 * tem user gesture. Delegamos para a página da extensão.
 */
async function handleOpenSaveAsModel(
  payload: SaveTemplatePayload,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (
      !payload ||
      typeof payload.html !== 'string' ||
      typeof payload.actionLabel !== 'string'
    ) {
      sendResponse({ ok: false, error: 'Payload inválido para salvar modelo.' });
      return;
    }
    await chrome.storage.session.set({
      [STORAGE_KEYS.SAVE_TEMPLATE_PAYLOAD]: payload
    });
    const url = chrome.runtime.getURL('save-template/save.html');
    await chrome.tabs.create({ url });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleOpenSaveAsModel falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Recebe o payload JÁ SANITIZADO (sanitizePayloadForLLM) do dashboard
 * e pede à LLM ativa um panorama + sugestões de próximos passos.
 *
 * REGRA DE PRIVACIDADE: este handler valida que o payload não contém PII
 * no claro — polo ativo deve estar mascarado e o texto das movimentações
 * não pode conter CNJ de OUTROS processos (apenas o do próprio, no campo
 * `ref`, é permitido). Se a verificação falhar, recusa o envio.
 */
async function handleTriagemInsights(
  payload: TriagemPayloadAnon,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!payload || !Array.isArray(payload.tarefas)) {
      sendResponse({ ok: false, error: 'Payload anonimizado inválido.' });
      return;
    }
    const piiAlert = detectPiiInAnonPayload(payload);
    if (piiAlert) {
      console.warn(`${LOG_PREFIX} PII detectada no payload anonimizado:`, piiAlert);
      sendResponse({
        ok: false,
        error:
          'Falha de segurança: o payload contém dados sensíveis no claro. ' +
          'A chamada à IA foi bloqueada. (' + piiAlert + ')'
      });
      return;
    }

    const settings = await getSettings();
    const providerId = settings.activeProvider;
    const apiKey = await getApiKey(providerId);
    if (!apiKey) {
      sendResponse({
        ok: false,
        error: `API key não cadastrada para ${providerId}.`
      });
      return;
    }

    const provider = getProvider(providerId);
    const prompt = buildTriagemInsightsPrompt(payload);

    const controller = new AbortController();
    const generator = provider.sendMessage({
      apiKey,
      model: settings.models[providerId],
      systemPrompt:
        'Você é um assistente que ajuda secretarias de varas judiciais a ' +
        'priorizar tarefas de análise inicial e triagem de processos. ' +
        TRIAGEM_LLM_ANON_NOTICE + ' ' +
        'Responda SEMPRE em JSON puro, sem texto adicional, sem markdown.',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      temperature: 0.2,
      maxTokens: 1500,
      signal: controller.signal
    });

    let raw = '';
    for await (const chunk of generator) {
      raw += chunk.delta;
    }

    const insights = parseTriagemInsightsResponse(raw);
    if (!insights) {
      sendResponse({
        ok: false,
        error: 'Resposta da IA não pôde ser interpretada como JSON de insights.'
      });
      return;
    }

    sendResponse({ ok: true, insights });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleTriagemInsights falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Verifica se o payload sanitizado não contém — por bug — PII no claro.
 * O polo ativo DEVE estar mascarado; o texto das movimentações pode conter
 * o CNJ do próprio processo (permitido, informação pública), mas NÃO pode
 * conter CNJ de outros processos (substituídos por "[OUTRO PROC]").
 */
function detectPiiInAnonPayload(payload: TriagemPayloadAnon): string | null {
  const cnjRe = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;
  for (const t of payload.tarefas) {
    for (const p of t.processos) {
      if (p.poloAtivo !== '[POLO ATIVO]') {
        return `polo ativo não anonimizado em ${p.ref}`;
      }
      if (p.ultimaMovimentacaoTexto) {
        const own = p.ref.match(cnjRe)?.[0] ?? '';
        const matches = p.ultimaMovimentacaoTexto.match(cnjRe) ?? [];
        for (const m of matches) {
          if (m !== own) {
            return `CNJ de outro processo no claro na movimentação de ${p.ref}`;
          }
        }
      }
    }
  }
  return null;
}

function buildTriagemInsightsPrompt(payload: TriagemPayloadAnon): string {
  return (
    `Você está analisando o painel de tarefas de uma secretaria de Vara Federal.\n\n` +
    `Há ${payload.totalProcessos} processos distribuídos em ${payload.tarefas.length} tarefa(s) ` +
    `de "Analisar inicial" / "Triagem". Os dados abaixo estão em JSON; o campo "ref" ` +
    `contém o número CNJ real do processo (informação pública), o polo ativo foi ` +
    `mascarado como "[POLO ATIVO]" e o polo passivo só foi mantido para entes ` +
    `públicos.\n\n` +
    `=== DADOS ===\n` +
    '```json\n' +
    JSON.stringify(payload, null, 2) +
    '\n```\n\n' +
    `Sua tarefa: produzir (a) um PANORAMA curto (2 a 4 frases) ` +
    `descrevendo o estado geral; (b) entre 3 e 6 SUGESTÕES de próximos passos ` +
    `priorizadas, cada uma com título curto, detalhe (1-3 frases) e prioridade ` +
    `("alta", "media" ou "baixa").\n\n` +
    `Critérios para sugerir prioridade alta:\n` +
    `- processos com mais de 60 dias na tarefa;\n` +
    `- processos prioritários (campo "prioritario": true);\n` +
    `- presença de etiquetas indicando ação pendente (ex: "+30 dias", "Tutela");\n` +
    `- volume concentrado num assunto que permita despacho em lote.\n\n` +
    `Pode citar os números CNJ (campo "ref") nas sugestões quando ajudar a ` +
    `localizar os autos. NÃO invente dados que não estejam no JSON.\n\n` +
    `Responda APENAS o JSON no formato exato:\n` +
    `{"panorama":"<texto>","sugestoes":[{"titulo":"<curto>","detalhe":"<1-3 frases>","prioridade":"alta|media|baixa"}, ...]}`
  );
}

/**
 * Aceita o JSON pode vir cercado por ```json ... ``` (alguns provedores
 * insistem em markdown). Faz parse defensivo e valida o shape mínimo.
 */
function parseTriagemInsightsResponse(raw: string): TriagemInsightsLLM | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  // Remove markdown fences se vierem.
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  // Procura o primeiro { até o último } caso o LLM tenha narrado antes.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0) return null;
  const slice = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    const obj = JSON.parse(slice) as Partial<TriagemInsightsLLM>;
    if (typeof obj.panorama !== 'string') return null;
    if (!Array.isArray(obj.sugestoes)) return null;
    const sugestoes: TriagemSugestao[] = [];
    for (const s of obj.sugestoes) {
      if (
        s &&
        typeof s.titulo === 'string' &&
        typeof s.detalhe === 'string' &&
        (s.prioridade === 'alta' || s.prioridade === 'media' || s.prioridade === 'baixa')
      ) {
        sugestoes.push({
          titulo: s.titulo,
          detalhe: s.detalhe,
          prioridade: s.prioridade
        });
      }
    }
    return { panorama: obj.panorama, sugestoes };
  } catch (err) {
    console.warn(`${LOG_PREFIX} parseTriagemInsightsResponse: JSON inválido`, err);
    return null;
  }
}

// =====================================================================
// Painel Gerencial — perfil Gestão
// =====================================================================

/**
 * Grava o payload agregado do Painel Gerencial em `chrome.storage.session`
 * (volátil) e abre a página do dashboard gerencial em uma nova aba. Nenhum
 * dado de processo é persistido em `storage.local` — o payload sai junto
 * com a sessão do navegador.
 */
async function handleOpenGestaoDashboard(
  payload: GestaoDashboardPayload,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!payload || !Array.isArray(payload.tarefas) || !payload.indicadores) {
      sendResponse({ ok: false, error: 'Payload do Painel Gerencial inválido.' });
      return;
    }
    await chrome.storage.session.set({
      [STORAGE_KEYS.GESTAO_DASHBOARD_PAYLOAD]: payload
    });
    const url = chrome.runtime.getURL('gestao-dashboard/gestao-dashboard.html');
    await chrome.tabs.create({ url });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleOpenGestaoDashboard falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Recebe os indicadores agregados + payload já sanitizado
 * (`sanitizePayloadForLLM`) e pede à LLM uma leitura gerencial com alertas
 * e sugestões de organização do trabalho.
 *
 * Reaproveita a mesma checagem de PII do handler de triagem — se qualquer
 * nome de polo ativo passar no claro ou CNJ de outro processo vazar no
 * texto de movimentação, a chamada é bloqueada.
 */
async function handleGestaoInsights(
  payload: { indicadores: GestaoIndicadores; anon: TriagemPayloadAnon },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!payload || !payload.indicadores || !payload.anon) {
      sendResponse({ ok: false, error: 'Payload gerencial inválido.' });
      return;
    }
    const piiAlert = detectPiiInAnonPayload(payload.anon);
    if (piiAlert) {
      console.warn(`${LOG_PREFIX} PII detectada no payload gerencial:`, piiAlert);
      sendResponse({
        ok: false,
        error:
          'Falha de segurança: o payload contém dados sensíveis no claro. ' +
          'A chamada à IA foi bloqueada. (' + piiAlert + ')'
      });
      return;
    }

    const settings = await getSettings();
    const providerId = settings.activeProvider;
    const apiKey = await getApiKey(providerId);
    if (!apiKey) {
      sendResponse({
        ok: false,
        error: `API key não cadastrada para ${providerId}.`
      });
      return;
    }

    const provider = getProvider(providerId);
    const prompt = buildGestaoInsightsPrompt(payload.indicadores, payload.anon);

    const controller = new AbortController();
    const generator = provider.sendMessage({
      apiKey,
      model: settings.models[providerId],
      systemPrompt:
        'Você é um assistente de gestão judiciária ajudando magistrados e ' +
        'diretores de vara a enxergar rapidamente o estado dos processos em ' +
        'cada tarefa do PJe. ' +
        TRIAGEM_LLM_ANON_NOTICE + ' ' +
        'Responda SEMPRE em JSON puro, sem texto adicional, sem markdown.',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      temperature: 0.2,
      maxTokens: 1800,
      signal: controller.signal
    });

    let raw = '';
    for await (const chunk of generator) {
      raw += chunk.delta;
    }

    const insights = parseGestaoInsightsResponse(raw);
    if (!insights) {
      sendResponse({
        ok: false,
        error: 'Resposta da IA não pôde ser interpretada como JSON de insights gerenciais.'
      });
      return;
    }
    sendResponse({ ok: true, insights });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleGestaoInsights falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

function buildGestaoInsightsPrompt(
  indicadores: GestaoIndicadores,
  anon: TriagemPayloadAnon
): string {
  return (
    `Você está analisando o Painel Gerencial de uma unidade judiciária no PJe.\n\n` +
    `INDICADORES AGREGADOS (calculados localmente, sem IA):\n` +
    '```json\n' +
    JSON.stringify(indicadores, null, 2) +
    '\n```\n\n' +
    `PROCESSOS POR TAREFA (anonimizados — nomes de partes removidos):\n` +
    '```json\n' +
    JSON.stringify(anon, null, 2) +
    '\n```\n\n' +
    `Sua tarefa: produzir um JSON com três campos:\n` +
    `  - "panorama": 2 a 4 frases descrevendo o estado gerencial do acervo.\n` +
    `  - "alertas": entre 1 e 5 alertas que exigem atenção imediata do gestor ` +
    `(ex.: concentração de atrasos em uma tarefa, assunto repetitivo em alta ` +
    `quantidade, processos prioritários parados). Cada alerta tem ` +
    `{titulo, detalhe, severidade: "alta"|"media"|"baixa"}.\n` +
    `  - "sugestoes": entre 2 e 5 sugestões de reorganização do trabalho ` +
    `(redistribuir, criar mutirão, adotar despacho em lote, revisar etiquetas). ` +
    `Cada sugestão tem {titulo, detalhe, prioridade: "alta"|"media"|"baixa"}.\n\n` +
    `Pode citar números CNJ (campo "ref") quando útil para localizar os autos. ` +
    `NÃO invente dados fora do JSON fornecido. Responda APENAS com o JSON:\n` +
    `{"panorama":"...","alertas":[{"titulo":"","detalhe":"","severidade":"alta|media|baixa"}],"sugestoes":[{"titulo":"","detalhe":"","prioridade":"alta|media|baixa"}]}`
  );
}

function parseGestaoInsightsResponse(raw: string): GestaoInsightsLLM | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0) return null;
  const slice = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    const obj = JSON.parse(slice) as Partial<GestaoInsightsLLM>;
    if (typeof obj.panorama !== 'string') return null;

    const alertas: GestaoAlerta[] = [];
    if (Array.isArray(obj.alertas)) {
      for (const a of obj.alertas) {
        if (
          a &&
          typeof a.titulo === 'string' &&
          typeof a.detalhe === 'string' &&
          (a.severidade === 'alta' || a.severidade === 'media' || a.severidade === 'baixa')
        ) {
          alertas.push({
            titulo: a.titulo,
            detalhe: a.detalhe,
            severidade: a.severidade
          });
        }
      }
    }

    const sugestoes: GestaoSugestao[] = [];
    if (Array.isArray(obj.sugestoes)) {
      for (const s of obj.sugestoes) {
        if (
          s &&
          typeof s.titulo === 'string' &&
          typeof s.detalhe === 'string' &&
          (s.prioridade === 'alta' || s.prioridade === 'media' || s.prioridade === 'baixa')
        ) {
          sugestoes.push({
            titulo: s.titulo,
            detalhe: s.detalhe,
            prioridade: s.prioridade
          });
        }
      }
    }

    return { panorama: obj.panorama, alertas, sugestoes };
  } catch (err) {
    console.warn(`${LOG_PREFIX} parseGestaoInsightsResponse: JSON inválido`, err);
    return null;
  }
}

// =====================================================================
// Helpers
// =====================================================================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

console.log(`${LOG_PREFIX} background carregado`);
