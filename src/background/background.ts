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
  type ProviderId
} from '../shared/constants';
import {
  SYSTEM_PROMPT,
  buildDocumentContext,
  buildTriagemPrompt,
  parseTriagemResponse,
  getTemplateActionsForGrau,
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
import type {
  ChatMessage,
  ChatStartPayload,
  ExtensionMessage,
  PAIdeguaSettings,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TestConnectionResult,
  TranscribeAudioPayload
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
            // Aguarda o AJAX do PJe carregar o editor (até 6s).
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const retryResult = await tryInsertInTabs([tabId], payload.html, payload.plain);
            if (retryResult) {
              sendResponse(retryResult);
              return;
            }
            // Editor ainda não apareceu — tenta mais uma vez após mais delay.
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const retryResult2 = await tryInsertInTabs([tabId], payload.html, payload.plain);
            if (retryResult2) {
              sendResponse(retryResult2);
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
