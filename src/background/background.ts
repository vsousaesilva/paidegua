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
  PJE_HOST_PATTERNS,
  PORT_NAMES,
  STORAGE_KEYS,
  type ProviderId
} from '../shared/constants';
import {
  AUTH_REVALIDATE_AFTER_MS,
  clearAuthState,
  computeAuthStatus,
  loadAuthState,
  remoteRequestCode,
  remoteVerifyCode,
  revalidateRemote
} from '../shared/auth';
import type {
  AuthRequestCodePayload,
  AuthRequestCodeResponse,
  AuthStatusResponse,
  AuthVerifyCodePayload,
  AuthVerifyCodeResponse
} from '../shared/types';
import {
  TRIAGEM_LLM_ANON_NOTICE,
  type TriagemPayloadAnon,
  type TriagemProcessoAnon,
  type TriagemTarefaAnon
} from '../shared/triagem-anonymize';
import {
  SYSTEM_PROMPT,
  buildAnaliseProcessoPrompt,
  buildDocumentContext,
  buildEtiquetasMarkersPrompt,
  buildTriagemCriteriosBlock,
  buildTriagemPrompt,
  parseAnaliseProcessoResponse,
  parseEtiquetasMarkersResponse,
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
import {
  invalidateSugestionaveisIndex,
  rankEtiquetasSugestionaveis
} from '../shared/etiquetas-matcher';
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
  GestaoTarefaInfo,
  PAIdeguaSettings,
  PericiaPerito,
  PericiaTarefaInfo,
  PericiasDashboardPayload,
  PJeAuthSnapshot,
  PrazosFitaDashboardPayload,
  SugerirEtiquetasRequest,
  SugerirEtiquetasResponse,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TestConnectionResult,
  TranscribeAudioPayload,
  TriagemDashboardPayload,
  TriagemInsightsLLM,
  TriagemSugestao
} from '../shared/types';
import {
  clearGestaoPayloads,
  saveGestaoPayloads
} from '../shared/gestao-indexed-storage';
import {
  clearPrazosFitaDashboardPayload,
  finalizePrazosFitaDashboardStream,
  hydratePrazosFitaSlot,
  initPrazosFitaDashboardStream,
  patchPrazosFitaSlot,
  savePrazosFitaDashboardPayload
} from '../shared/prazos-fita-indexed-storage';
import { gravarAuthSnapshot } from './pje-api-client';
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

/**
 * Abre `chrome.storage.session` para content scripts (default so permite
 * service worker/pages da extensao). Necessario porque o snapshot de auth
 * do PJe e gravado aqui pelo background e lido pelo cliente REST que
 * roda no content script (same-origin com pje1g.trf5.jus.br).
 *
 * Precisa ser chamado em onInstalled/onStartup — o access level nao e
 * persistido entre reinicializacoes do navegador.
 */
function abrirStorageSessionParaContentScripts(): void {
  try {
    void chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    });
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} falha abrindo storage.session para content scripts:`,
      err
    );
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`${LOG_PREFIX} instalada/atualizada:`, details.reason);
  abrirStorageSessionParaContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  console.log(`${LOG_PREFIX} service worker iniciado`);
  abrirStorageSessionParaContentScripts();
  // LGPD: ao abrir o Chrome, qualquer payload do Painel Gerencial
  // residual no IndexedDB (de sessões anteriores) é apagado. Assim o
  // comportamento equivale ao do antigo `storage.session`: os dados não
  // sobrevivem ao encerramento do navegador.
  void clearGestaoPayloads().catch((err) =>
    console.warn(`${LOG_PREFIX} limpeza inicial do IDB gestão falhou:`, err)
  );
  void clearPrazosFitaDashboardPayload().catch((err) =>
    console.warn(
      `${LOG_PREFIX} limpeza inicial do IDB prazos-fita falhou:`,
      err
    )
  );
});

// Se este modulo for reexecutado em uma reinicializacao do service worker
// (sem onStartup/onInstalled disparar), garanta o access level.
abrirStorageSessionParaContentScripts();

// =====================================================================
// Autenticacao (whitelist Inovajus + OTP por e-mail)
// =====================================================================

/**
 * Canais que NAO exigem login. Tudo o que sair daqui e bloqueado pelo
 * `requireAuth()` se a sessao local nao for valida.
 *
 * Politica: o popup precisa renderizar a tela de login mesmo sem sessao,
 * por isso `GET_SETTINGS`/`SAVE_SETTINGS` continuam liberados (ler/gravar
 * preferencias locais nao expoe nenhuma feature de IA). Toda a chamada a
 * provedor externo, qualquer abertura de painel e qualquer manipulacao
 * do PJe ficam atras do gate.
 */
const AUTH_FREE_CHANNELS: ReadonlySet<string> = new Set<string>([
  MESSAGE_CHANNELS.PING,
  MESSAGE_CHANNELS.GET_SETTINGS,
  MESSAGE_CHANNELS.SAVE_SETTINGS,
  MESSAGE_CHANNELS.AUTH_REQUEST_CODE,
  MESSAGE_CHANNELS.AUTH_VERIFY_CODE,
  MESSAGE_CHANNELS.AUTH_GET_STATUS,
  MESSAGE_CHANNELS.AUTH_REVALIDATE,
  MESSAGE_CHANNELS.AUTH_LOGOUT
]);

/**
 * Resolve o status atual com base no JWT salvo. Para nao bater no backend
 * em todo despacho de mensagem, usa apenas `expiresAt` local — a revalidacao
 * remota e disparada de forma oportunistica em outros pontos
 * (`scheduleAuthRevalidation`).
 */
async function isAuthenticatedFast(): Promise<boolean> {
  const state = await loadAuthState();
  return computeAuthStatus(state).authenticated;
}

/**
 * Dispara revalidacao remota se a ultima ja estiver mais antiga que
 * `AUTH_REVALIDATE_AFTER_MS`. Best-effort: erros de rede nao derrubam
 * a sessao local; somente `revoked` / `invalid_jwt` limpam o JWT.
 */
async function scheduleAuthRevalidation(): Promise<void> {
  try {
    const state = await loadAuthState();
    if (!state) return;
    if (Date.now() - state.lastValidatedAt < AUTH_REVALIDATE_AFTER_MS) return;
    await revalidateRemote();
  } catch (err) {
    console.warn(`${LOG_PREFIX} revalidacao remota falhou:`, err);
  }
}

async function handleAuthRequestCode(
  payload: AuthRequestCodePayload | undefined,
  sendResponse: (response: AuthRequestCodeResponse) => void
): Promise<void> {
  const email = String(payload?.email ?? '').trim();
  const result = await remoteRequestCode(email);
  sendResponse(result);
}

async function handleAuthVerifyCode(
  payload: AuthVerifyCodePayload | undefined,
  sendResponse: (response: AuthVerifyCodeResponse) => void
): Promise<void> {
  const email = String(payload?.email ?? '').trim();
  const code = String(payload?.code ?? '').trim();
  const result = await remoteVerifyCode(email, code);
  sendResponse(result);
}

async function handleAuthGetStatus(
  sendResponse: (response: AuthStatusResponse) => void
): Promise<void> {
  const state = await loadAuthState();
  const status = computeAuthStatus(state);
  sendResponse(status);
  // Aproveita a chamada para revalidar em background quando aplicavel.
  void scheduleAuthRevalidation();
}

async function handleAuthRevalidate(
  sendResponse: (response: AuthStatusResponse) => void
): Promise<void> {
  const status = await revalidateRemote();
  sendResponse(status);
}

async function handleAuthLogout(
  sendResponse: (response: { ok: true }) => void
): Promise<void> {
  await clearAuthState();
  sendResponse({ ok: true });
}

// =====================================================================
// Mensagens curtas (request/response) — popup e content sem streaming.
// =====================================================================

/**
 * Dispatcher principal — chamado pelo listener apos passar pelo gate de auth.
 * Mantem a forma de retorno do `chrome.runtime.onMessage.addListener` (true
 * para handler async, false para sync).
 */
function dispatchMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): boolean {
    switch (message.channel) {
      case MESSAGE_CHANNELS.PING:
        sendResponse({ ok: true, pong: Date.now() });
        return false;

      case MESSAGE_CHANNELS.AUTH_REQUEST_CODE:
        void handleAuthRequestCode(
          message.payload as AuthRequestCodePayload | undefined,
          sendResponse as (r: AuthRequestCodeResponse) => void
        );
        return true;

      case MESSAGE_CHANNELS.AUTH_VERIFY_CODE:
        void handleAuthVerifyCode(
          message.payload as AuthVerifyCodePayload | undefined,
          sendResponse as (r: AuthVerifyCodeResponse) => void
        );
        return true;

      case MESSAGE_CHANNELS.AUTH_GET_STATUS:
        void handleAuthGetStatus(sendResponse as (r: AuthStatusResponse) => void);
        return true;

      case MESSAGE_CHANNELS.AUTH_REVALIDATE:
        void handleAuthRevalidate(sendResponse as (r: AuthStatusResponse) => void);
        return true;

      case MESSAGE_CHANNELS.AUTH_LOGOUT:
        void handleAuthLogout(sendResponse as (r: { ok: true }) => void);
        return true;

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

      case MESSAGE_CHANNELS.GESTAO_OPEN_PAINEL:
        void handleOpenGestaoPainel(
          message.payload as {
            tarefas: GestaoTarefaInfo[];
            hostnamePJe: string;
            abertoEm: string;
          },
          sender,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.GESTAO_START_COLETA:
        void handleGestaoStartColeta(
          message.payload as { requestId: string; nomes: string[] },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.GESTAO_COLETA_PROG:
        void handleGestaoColetaProg(
          message.payload as { requestId: string; msg: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.GESTAO_COLETA_DONE:
        void handleGestaoColetaDone(
          message.payload as {
            requestId: string;
            dashboardPayload: GestaoDashboardPayload;
            anonPayload: TriagemPayloadAnon;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.GESTAO_COLETA_FAIL:
        void handleGestaoColetaFail(
          message.payload as { requestId: string; error: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.GESTAO_CLEAR_PAYLOADS:
        void (async () => {
          try {
            await clearGestaoPayloads();
            sendResponse({ ok: true });
          } catch (err) {
            console.warn(`${LOG_PREFIX} clearGestaoPayloads falhou:`, err);
            sendResponse({ ok: false, error: errorMessage(err) });
          }
        })();
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_CLEAR_PAYLOAD:
        void (async () => {
          try {
            await clearPrazosFitaDashboardPayload();
            sendResponse({ ok: true });
          } catch (err) {
            console.warn(
              `${LOG_PREFIX} clearPrazosFitaDashboardPayload falhou:`,
              err
            );
            sendResponse({ ok: false, error: errorMessage(err) });
          }
        })();
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_OPEN_PAINEL:
        void handleOpenPrazosFitaPainel(
          message.payload as {
            tarefas: GestaoTarefaInfo[];
            hostnamePJe: string;
            abertoEm: string;
          },
          sender,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_START_COLETA:
        void handlePrazosFitaStartColeta(
          message.payload as {
            requestId: string;
            nomes: string[];
            diasMinNaTarefa?: number | null;
            maxProcessosTotal?: number | null;
            retomar?: boolean;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_QUERY_SCAN_STATE:
        void handlePrazosFitaQueryScanState(
          message.payload as {
            requestId: string;
            nomes: string[];
            diasMinNaTarefa: number | null;
            maxProcessosTotal: number | null;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_PROG:
        void handlePrazosFitaColetaProg(
          message.payload as { requestId: string; msg: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_DONE:
        void handlePrazosFitaColetaDone(
          message.payload as {
            requestId: string;
            dashboardPayload: PrazosFitaDashboardPayload;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_FAIL:
        void handlePrazosFitaColetaFail(
          message.payload as { requestId: string; error: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_SKELETON_READY:
        void handlePrazosFitaSkeletonReady(
          message.payload as PrazosFitaSkeletonReadyPayload,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_SLOT_PATCH:
        void handlePrazosFitaSlotPatch(
          message.payload as PrazosFitaSlotPatchPayload,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_HYDRATE_SLOT:
        void handlePrazosFitaHydrateSlot(
          message.payload as PrazosFitaSlotPatchPayload,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_FINALIZED:
        void handlePrazosFitaColetaFinalized(
          message.payload as PrazosFitaFinalizedPayload,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PERICIAS_OPEN_PAINEL:
        void handleOpenPericiasPainel(
          message.payload as {
            tarefas: PericiaTarefaInfo[];
            peritos: PericiaPerito[];
            hostnamePJe: string;
            abertoEm: string;
          },
          sender,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PERICIAS_START_COLETA:
        void handlePericiasStartColeta(
          message.payload as {
            requestId: string;
            nomes: string[];
            peritosSelecionados: PericiaPerito[];
            dataPericiaISO: string;
            excluirIds?: number[];
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PERICIAS_COLETA_PROG:
        void handlePericiasColetaProg(
          message.payload as { requestId: string; msg: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PERICIAS_COLETA_DONE:
        void handlePericiasColetaDone(
          message.payload as {
            requestId: string;
            dashboardPayload: PericiasDashboardPayload;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PERICIAS_COLETA_FAIL:
        void handlePericiasColetaFail(
          message.payload as { requestId: string; error: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PERICIAS_APLICAR_ETIQUETAS:
        void handlePericiasAplicarEtiquetas(
          message.payload as {
            etiquetaPauta: string;
            idsProcesso: number[];
            favoritarAposCriar?: boolean;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PERICIAS_CLEAR_PAYLOAD:
        void (async () => {
          try {
            const rid = (message.payload as { requestId?: string } | null)
              ?.requestId;
            if (rid) {
              await chrome.storage.session.remove(
                `${STORAGE_KEYS.PERICIAS_DASHBOARD_PAYLOAD_PREFIX}${rid}`
              );
              // Também apaga a rota aqui — é o ponto "encerrar de vez a
              // sessão de Perícias". O dashboard chama este canal no
              // beforeunload (quando o usuário fecha a aba) e ao criar
              // uma nova pauta.
              await deleteRota(rid);
            }
            sendResponse({ ok: true });
          } catch (err) {
            console.warn(`${LOG_PREFIX} PERICIAS_CLEAR_PAYLOAD falhou:`, err);
            sendResponse({ ok: false, error: errorMessage(err) });
          }
        })();
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

      case MESSAGE_CHANNELS.PRAZOS_FITA_COLETAR_PROCESSO:
        void handlePrazosFitaColetarProcesso(
          message.payload as { url: string; timeoutMs?: number },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PRAZOS_ENCERRAR_RUN:
        void handlePrazosEncerrarRun(
          message.payload as PrazosEncerrarRequest,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.PJE_AUTH_CAPTURED:
        void handlePjeAuthCaptured(
          message.payload as PJeAuthSnapshot,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.ETIQUETAS_FETCH_CATALOG:
        void handleEtiquetasFetchCatalog(
          message.payload as { pageSize?: number } | null,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.ETIQUETAS_INVALIDATE:
        invalidateSugestionaveisIndex();
        sendResponse({ ok: true });
        return true;

      case MESSAGE_CHANNELS.ETIQUETAS_SUGERIR:
        void handleEtiquetasSugerir(
          message.payload as SugerirEtiquetasRequest,
          sendResponse
        );
        return true;

      default:
        return false;
    }
}

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    if (!message || typeof message.channel !== 'string') {
      return false;
    }
    const channel = message.channel;
    if (AUTH_FREE_CHANNELS.has(channel)) {
      return dispatchMessage(message, sender, sendResponse);
    }
    // Canal protegido — checagem assincrona; mantem a porta aberta com return true.
    void (async () => {
      if (!(await isAuthenticatedFast())) {
        sendResponse({ ok: false, error: 'unauthorized' });
        return;
      }
      dispatchMessage(message, sender, sendResponse);
    })();
    return true;
  }
);

/**
 * Recebe o snapshot de auth capturado pelo interceptor page-world e
 * grava em `chrome.storage.session`. O snapshot é lido depois pelo
 * content script (mesma origem do PJe) ao executar as chamadas REST do
 * painel "Prazos na Fita". O background não faz mais essas chamadas.
 */
async function handlePjeAuthCaptured(
  payload: PJeAuthSnapshot,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!payload || typeof payload.authorization !== 'string') {
      sendResponse({ ok: false, error: 'Snapshot invalido.' });
      return;
    }
    await gravarAuthSnapshot(payload);
    sendResponse({ ok: true, capturedAt: payload.capturedAt });
  } catch (err) {
    sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

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
      void (async () => {
        if (!(await isAuthenticatedFast())) {
          port.postMessage({
            type: CHAT_PORT_MSG.ERROR,
            error: 'Sessao nao autenticada. Faca login no popup do pAIdegua.'
          });
          return;
        }
        void handleChatStart(port, msg.payload as ChatStartPayload);
      })();
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

// =====================================================================
// Painel Gerencial — aba intermediária (seletor + progresso)
// =====================================================================

/**
 * Tabela persistida em `chrome.storage.session` relacionando cada
 * `requestId` à aba-painel e à aba do PJe que a disparou. Usada para
 * rotear:
 *   - GESTAO_START_COLETA (painel → PJe)
 *   - GESTAO_COLETA_PROG  (PJe    → painel)
 *   - GESTAO_COLETA_READY (pós-save, painel carrega o dashboard)
 *   - GESTAO_COLETA_FAIL  (PJe    → painel)
 *
 * Persistimos em session storage (e não em Map em memória) porque o
 * service worker do MV3 pode ser suspenso durante a varredura. A
 * chave é `${GESTAO_PAINEL_ROUTE_PREFIX}${requestId}`.
 */
interface GestaoPainelRota {
  painelTabId: number;
  pjeTabId: number;
}

function rotaKey(requestId: string): string {
  return `${STORAGE_KEYS.GESTAO_PAINEL_ROUTE_PREFIX}${requestId}`;
}

async function getRota(requestId: string): Promise<GestaoPainelRota | null> {
  if (!requestId) return null;
  const key = rotaKey(requestId);
  const got = await chrome.storage.session.get(key);
  const val = got?.[key];
  if (
    val &&
    typeof val.painelTabId === 'number' &&
    typeof val.pjeTabId === 'number'
  ) {
    return { painelTabId: val.painelTabId, pjeTabId: val.pjeTabId };
  }
  return null;
}

async function setRota(
  requestId: string,
  rota: GestaoPainelRota
): Promise<void> {
  await chrome.storage.session.set({ [rotaKey(requestId)]: rota });
}

async function deleteRota(requestId: string): Promise<void> {
  if (!requestId) return;
  await chrome.storage.session.remove(rotaKey(requestId));
}

function gerarRequestId(): string {
  return `gestao-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function handleOpenGestaoPainel(
  payload: {
    tarefas: GestaoTarefaInfo[];
    hostnamePJe: string;
    abertoEm: string;
  },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const pjeTabId = sender?.tab?.id;
    if (typeof pjeTabId !== 'number') {
      sendResponse({
        ok: false,
        error: 'Não consegui identificar a aba do PJe que disparou o painel.'
      });
      return;
    }
    if (!payload || !Array.isArray(payload.tarefas)) {
      sendResponse({ ok: false, error: 'Payload de abertura do painel inválido.' });
      return;
    }

    const requestId = gerarRequestId();
    const stateKey = `${STORAGE_KEYS.GESTAO_PAINEL_STATE_PREFIX}${requestId}`;
    await chrome.storage.session.set({
      [stateKey]: {
        requestId,
        tarefas: payload.tarefas,
        hostnamePJe: payload.hostnamePJe ?? '',
        abertoEm: payload.abertoEm ?? new Date().toISOString()
      }
    });

    const url =
      chrome.runtime.getURL('gestao-painel/painel.html') +
      `?rid=${encodeURIComponent(requestId)}`;
    const tab = await chrome.tabs.create({ url });
    if (typeof tab.id !== 'number') {
      await chrome.storage.session.remove(stateKey);
      sendResponse({
        ok: false,
        error: 'Chrome não atribuiu ID à aba do Painel Gerencial.'
      });
      return;
    }
    await setRota(requestId, {
      painelTabId: tab.id,
      pjeTabId
    });
    sendResponse({ ok: true, requestId });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleOpenGestaoPainel falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleGestaoStartColeta(
  payload: { requestId: string; nomes: string[] },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({
        ok: false,
        error:
          'Sessão do Painel Gerencial expirou. Volte ao PJe e abra o painel novamente.'
      });
      return;
    }
    if (!Array.isArray(payload.nomes) || payload.nomes.length === 0) {
      sendResponse({ ok: false, error: 'Nenhuma tarefa selecionada.' });
      return;
    }
    const ack = await chrome.tabs.sendMessage(rota.pjeTabId, {
      channel: MESSAGE_CHANNELS.GESTAO_RUN_COLETA,
      payload: { requestId: payload.requestId, nomes: payload.nomes }
    });
    if (!ack?.ok) {
      sendResponse({
        ok: false,
        error:
          ack?.error ??
          'A aba do PJe não aceitou iniciar a varredura. Confirme que ela continua aberta no Painel do Usuário.'
      });
      return;
    }
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleGestaoStartColeta falhou:`, error);
    sendResponse({
      ok: false,
      error:
        'Falha ao contactar a aba do PJe: ' +
        errorMessage(error) +
        '. Verifique se a aba original ainda está aberta.'
    });
  }
}

async function handleGestaoColetaProg(
  payload: { requestId: string; msg: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({ ok: false, error: 'Rota não encontrada.' });
      return;
    }
    await chrome.tabs
      .sendMessage(rota.painelTabId, {
        channel: MESSAGE_CHANNELS.GESTAO_COLETA_PROG,
        payload
      })
      .catch(() => { /* aba-painel pode ter sido fechada */ });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleGestaoColetaProg falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleGestaoColetaDone(
  payload: {
    requestId: string;
    dashboardPayload: GestaoDashboardPayload;
    anonPayload: TriagemPayloadAnon;
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({ ok: false, error: 'Rota não encontrada.' });
      return;
    }
    if (
      !payload.dashboardPayload ||
      !Array.isArray(payload.dashboardPayload.tarefas) ||
      !payload.dashboardPayload.indicadores ||
      !payload.anonPayload ||
      !Array.isArray(payload.anonPayload.tarefas)
    ) {
      sendResponse({ ok: false, error: 'Payload do dashboard inválido.' });
      return;
    }

    // Persistimos em IndexedDB (sem quota prática) em vez de
    // `storage.session` (10 MB) porque em unidades com milhares de
    // processos o payload estoura a quota e o dashboard fica travado.
    // A limpeza acontece em três gatilhos (ver `gestao-indexed-storage.ts`):
    // onStartup, pagehide da aba do dashboard e sobrescrita na próxima
    // varredura.
    try {
      await saveGestaoPayloads(payload.dashboardPayload, payload.anonPayload);
    } catch (setErr: unknown) {
      const raw = errorMessage(setErr);
      sendResponse({
        ok: false,
        error: 'Falha ao gravar o dashboard no IndexedDB: ' + raw
      });
      return;
    }
    await chrome.storage.session.remove(
      `${STORAGE_KEYS.GESTAO_PAINEL_STATE_PREFIX}${payload.requestId}`
    );

    await chrome.tabs
      .sendMessage(rota.painelTabId, {
        channel: MESSAGE_CHANNELS.GESTAO_COLETA_READY,
        payload: { requestId: payload.requestId }
      })
      .catch(() => { /* aba-painel pode ter sido fechada */ });

    await deleteRota(payload.requestId);
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleGestaoColetaDone falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handleGestaoColetaFail(
  payload: { requestId: string; error: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (rota) {
      await chrome.tabs
        .sendMessage(rota.painelTabId, {
          channel: MESSAGE_CHANNELS.GESTAO_COLETA_FAIL,
          payload
        })
        .catch(() => { /* aba-painel pode ter sido fechada */ });
      await deleteRota(payload.requestId);
    }
    await chrome.storage.session.remove(
      `${STORAGE_KEYS.GESTAO_PAINEL_STATE_PREFIX}${payload?.requestId ?? ''}`
    );
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleGestaoColetaFail falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

// =====================================================================
// Painel "Prazos na Fita pAIdegua" — aba intermediária (seletor + progresso)
// =====================================================================
//
// Mesma orquestração do Painel Gerencial, com canais próprios e modo
// `prazos` na URL do painel. A aba aplica o filtro "Controle de prazo"
// no client e dispara `coletarPrazosPorTarefasViaAPI` na aba do PJe.

function gerarPrazosRequestId(): string {
  return `prazos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function handleOpenPrazosFitaPainel(
  payload: {
    tarefas: GestaoTarefaInfo[];
    hostnamePJe: string;
    abertoEm: string;
  },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const pjeTabId = sender?.tab?.id;
    if (typeof pjeTabId !== 'number') {
      sendResponse({
        ok: false,
        error: 'Não consegui identificar a aba do PJe que disparou o painel.'
      });
      return;
    }
    if (!payload || !Array.isArray(payload.tarefas)) {
      sendResponse({ ok: false, error: 'Payload de abertura do painel inválido.' });
      return;
    }

    const requestId = gerarPrazosRequestId();
    const stateKey = `${STORAGE_KEYS.GESTAO_PAINEL_STATE_PREFIX}${requestId}`;
    await chrome.storage.session.set({
      [stateKey]: {
        requestId,
        tarefas: payload.tarefas,
        hostnamePJe: payload.hostnamePJe ?? '',
        abertoEm: payload.abertoEm ?? new Date().toISOString()
      }
    });

    const url =
      chrome.runtime.getURL('gestao-painel/painel.html') +
      `?rid=${encodeURIComponent(requestId)}&modo=prazos`;
    const tab = await chrome.tabs.create({ url });
    if (typeof tab.id !== 'number') {
      await chrome.storage.session.remove(stateKey);
      sendResponse({
        ok: false,
        error: 'Chrome não atribuiu ID à aba "Prazos na Fita pAIdegua".'
      });
      return;
    }
    await setRota(requestId, {
      painelTabId: tab.id,
      pjeTabId
    });
    sendResponse({ ok: true, requestId });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleOpenPrazosFitaPainel falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handlePrazosFitaStartColeta(
  payload: {
    requestId: string;
    nomes: string[];
    diasMinNaTarefa?: number | null;
    maxProcessosTotal?: number | null;
    retomar?: boolean;
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({
        ok: false,
        error:
          'Sessão do painel "Prazos na Fita" expirou. Volte ao PJe e abra o painel novamente.'
      });
      return;
    }
    if (!Array.isArray(payload.nomes) || payload.nomes.length === 0) {
      sendResponse({ ok: false, error: 'Nenhuma tarefa selecionada.' });
      return;
    }
    const ack = await chrome.tabs.sendMessage(rota.pjeTabId, {
      channel: MESSAGE_CHANNELS.PRAZOS_FITA_RUN_COLETA,
      payload: {
        requestId: payload.requestId,
        nomes: payload.nomes,
        diasMinNaTarefa: payload.diasMinNaTarefa ?? null,
        maxProcessosTotal: payload.maxProcessosTotal ?? null,
        retomar: payload.retomar === true
      }
    });
    if (!ack?.ok) {
      sendResponse({
        ok: false,
        error:
          ack?.error ??
          'A aba do PJe não aceitou iniciar a coleta. Confirme que ela continua aberta no Painel do Usuário.'
      });
      return;
    }
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePrazosFitaStartColeta falhou:`, error);
    sendResponse({
      ok: false,
      error:
        'Falha ao contactar a aba do PJe: ' +
        errorMessage(error) +
        '. Verifique se a aba original ainda está aberta.'
    });
  }
}

async function handlePrazosFitaQueryScanState(
  payload: {
    requestId: string;
    nomes: string[];
    diasMinNaTarefa: number | null;
    maxProcessosTotal: number | null;
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({ hasState: false });
      return;
    }
    const resp = await chrome.tabs.sendMessage(rota.pjeTabId, {
      channel: MESSAGE_CHANNELS.PRAZOS_FITA_QUERY_SCAN_STATE,
      payload: {
        nomes: payload.nomes,
        diasMinNaTarefa: payload.diasMinNaTarefa,
        maxProcessosTotal: payload.maxProcessosTotal
      }
    });
    sendResponse(resp ?? { hasState: false });
  } catch (error: unknown) {
    console.warn(
      `${LOG_PREFIX} handlePrazosFitaQueryScanState falhou:`,
      error
    );
    sendResponse({ hasState: false });
  }
}

async function handlePrazosFitaColetaProg(
  payload: { requestId: string; msg: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({ ok: false, error: 'Rota não encontrada.' });
      return;
    }
    await chrome.tabs
      .sendMessage(rota.painelTabId, {
        channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_PROG,
        payload
      })
      .catch(() => { /* aba-painel pode ter sido fechada */ });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePrazosFitaColetaProg falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handlePrazosFitaColetaDone(
  payload: { requestId: string; dashboardPayload: PrazosFitaDashboardPayload },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({ ok: false, error: 'Rota não encontrada.' });
      return;
    }
    if (
      !payload.dashboardPayload ||
      !payload.dashboardPayload.resultado ||
      !Array.isArray(payload.dashboardPayload.resultado.consolidado)
    ) {
      sendResponse({ ok: false, error: 'Payload do dashboard inválido.' });
      return;
    }

    // O payload final (consolidado + coletas por processo) estoura a
    // quota de 10 MB do `chrome.storage.session` em unidades grandes
    // (reproduzido em 2331 processos). Persistimos em IndexedDB, que
    // compartilha origem (chrome-extension://<id>/) entre o service
    // worker e a página do dashboard.
    await savePrazosFitaDashboardPayload(payload.dashboardPayload);
    await chrome.storage.session.remove(
      `${STORAGE_KEYS.GESTAO_PAINEL_STATE_PREFIX}${payload.requestId}`
    );

    await chrome.tabs
      .sendMessage(rota.painelTabId, {
        channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_READY,
        payload: { requestId: payload.requestId }
      })
      .catch(() => { /* aba-painel pode ter sido fechada */ });

    await deleteRota(payload.requestId);
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePrazosFitaColetaDone falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handlePrazosFitaColetaFail(
  payload: { requestId: string; error: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (rota) {
      await chrome.tabs
        .sendMessage(rota.painelTabId, {
          channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_FAIL,
          payload
        })
        .catch(() => { /* aba-painel pode ter sido fechada */ });
      await deleteRota(payload.requestId);
    }
    await chrome.storage.session.remove(
      `${STORAGE_KEYS.GESTAO_PAINEL_STATE_PREFIX}${payload?.requestId ?? ''}`
    );
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePrazosFitaColetaFail falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

// =====================================================================
// "Perícias pAIdegua" — aba intermediária (seletor de peritos + pauta)
// =====================================================================
//
// Topologia idêntica ao Painel Gerencial, com canais próprios. O
// payload da pauta é pequeno (dezenas de processos no total), então
// usamos `chrome.storage.session` diretamente — não precisa IndexedDB.

function gerarPericiasRequestId(): string {
  return `pericias-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function handleOpenPericiasPainel(
  payload: {
    tarefas: PericiaTarefaInfo[];
    peritos: PericiaPerito[];
    hostnamePJe: string;
    abertoEm: string;
  },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const pjeTabId = sender?.tab?.id;
    if (typeof pjeTabId !== 'number') {
      sendResponse({
        ok: false,
        error: 'Não consegui identificar a aba do PJe que disparou Perícias.'
      });
      return;
    }
    if (!payload || !Array.isArray(payload.tarefas)) {
      sendResponse({
        ok: false,
        error: 'Payload de abertura de Perícias inválido.'
      });
      return;
    }

    const requestId = gerarPericiasRequestId();
    const stateKey =
      `${STORAGE_KEYS.PERICIAS_PAINEL_STATE_PREFIX}${requestId}`;
    await chrome.storage.session.set({
      [stateKey]: {
        requestId,
        tarefas: payload.tarefas,
        peritos: Array.isArray(payload.peritos) ? payload.peritos : [],
        hostnamePJe: payload.hostnamePJe ?? '',
        abertoEm: payload.abertoEm ?? new Date().toISOString()
      }
    });

    const url =
      chrome.runtime.getURL('pericias-painel/painel.html') +
      `?rid=${encodeURIComponent(requestId)}`;
    const tab = await chrome.tabs.create({ url });
    if (typeof tab.id !== 'number') {
      await chrome.storage.session.remove(stateKey);
      sendResponse({
        ok: false,
        error: 'Chrome não atribuiu ID à aba de Perícias pAIdegua.'
      });
      return;
    }
    // Reutilizamos o mesmo `setRota/getRota` do Painel Gerencial. As
    // chaves são prefixadas por `GESTAO_PAINEL_ROUTE_PREFIX`, mas não
    // há colisão porque o `requestId` inclui o prefixo "pericias-".
    await setRota(requestId, { painelTabId: tab.id, pjeTabId });
    sendResponse({ ok: true, requestId });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleOpenPericiasPainel falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handlePericiasStartColeta(
  payload: {
    requestId: string;
    nomes: string[];
    peritosSelecionados: PericiaPerito[];
    dataPericiaISO: string;
    excluirIds?: number[];
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({
        ok: false,
        error:
          'Sessão de Perícias pAIdegua expirou. Volte ao PJe e abra a feature novamente.'
      });
      return;
    }
    if (!Array.isArray(payload.nomes) || payload.nomes.length === 0) {
      sendResponse({ ok: false, error: 'Nenhuma tarefa de perícia selecionada.' });
      return;
    }
    if (
      !Array.isArray(payload.peritosSelecionados) ||
      payload.peritosSelecionados.length === 0
    ) {
      sendResponse({ ok: false, error: 'Nenhum perito selecionado.' });
      return;
    }
    if (typeof payload.dataPericiaISO !== 'string' || !payload.dataPericiaISO) {
      sendResponse({ ok: false, error: 'Data da perícia não informada.' });
      return;
    }
    const ack = await chrome.tabs.sendMessage(rota.pjeTabId, {
      channel: MESSAGE_CHANNELS.PERICIAS_RUN_COLETA,
      payload: {
        requestId: payload.requestId,
        nomes: payload.nomes,
        peritosSelecionados: payload.peritosSelecionados,
        dataPericiaISO: payload.dataPericiaISO,
        excluirIds: Array.isArray(payload.excluirIds) ? payload.excluirIds : []
      }
    });
    if (!ack?.ok) {
      sendResponse({
        ok: false,
        error:
          ack?.error ??
          'A aba do PJe não aceitou iniciar a coleta. Confirme que ela continua aberta no Painel do Usuário.'
      });
      return;
    }
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePericiasStartColeta falhou:`, error);
    sendResponse({
      ok: false,
      error:
        'Falha ao contactar a aba do PJe: ' +
        errorMessage(error) +
        '. Verifique se a aba original ainda está aberta.'
    });
  }
}

async function handlePericiasColetaProg(
  payload: { requestId: string; msg: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({ ok: false, error: 'Rota não encontrada.' });
      return;
    }
    await chrome.tabs
      .sendMessage(rota.painelTabId, {
        channel: MESSAGE_CHANNELS.PERICIAS_COLETA_PROG,
        payload
      })
      .catch(() => { /* aba-painel pode ter sido fechada */ });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePericiasColetaProg falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

async function handlePericiasColetaDone(
  payload: { requestId: string; dashboardPayload: PericiasDashboardPayload },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({ ok: false, error: 'Rota não encontrada.' });
      return;
    }
    if (
      !payload.dashboardPayload ||
      !Array.isArray(payload.dashboardPayload.pautas)
    ) {
      sendResponse({ ok: false, error: 'Payload da pauta inválido.' });
      return;
    }

    const dashKey =
      `${STORAGE_KEYS.PERICIAS_DASHBOARD_PAYLOAD_PREFIX}${payload.requestId}`;
    await chrome.storage.session.set({
      [dashKey]: payload.dashboardPayload
    });
    await chrome.storage.session.remove(
      `${STORAGE_KEYS.PERICIAS_PAINEL_STATE_PREFIX}${payload.requestId}`
    );

    await chrome.tabs
      .sendMessage(rota.painelTabId, {
        channel: MESSAGE_CHANNELS.PERICIAS_COLETA_READY,
        payload: { requestId: payload.requestId }
      })
      .catch(() => { /* aba-painel pode ter sido fechada */ });

    // Mantém a rota viva após a coleta inicial terminar: o dashboard de
    // Perícias usa "Atualizar pauta" (re-disparo de PERICIAS_START_COLETA
    // com `excluirIds`), e esse fluxo precisa encontrar `rota.pjeTabId`
    // para reenviar `PERICIAS_RUN_COLETA`. A rota é limpa em
    // `handlePericiasClearPayload` (usuário fecha/recarrega o dashboard)
    // e naturalmente pela sessão do navegador.
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePericiasColetaDone falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Handler de `PERICIAS_APLICAR_ETIQUETAS` — roteado da aba-dashboard
 * (chrome-extension://...). A rota precisa executar dentro de uma aba do
 * PJe (same-origin) para que o cookie de sessão seja anexado ao fetch;
 * caso contrário o servidor rejeita silenciosamente (padrão já documentado
 * em `pje-api-from-content.ts`).
 *
 * Estratégia: procura qualquer aba aberta em `https://*.jus.br/*` e
 * encaminha o pedido. Se nenhuma aba do PJe estiver aberta, devolve erro
 * pedindo ao usuário para manter uma guia do painel logada.
 */
async function handlePericiasAplicarEtiquetas(
  payload: {
    etiquetaPauta: string;
    idsProcesso: number[];
    favoritarAposCriar?: boolean;
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!payload?.etiquetaPauta || !Array.isArray(payload.idsProcesso)) {
      sendResponse({ ok: false, error: 'Payload inválido.' });
      return;
    }
    const tabs = await chrome.tabs.query({ url: 'https://*.jus.br/*' });
    if (tabs.length === 0 || !tabs[0].id) {
      sendResponse({
        ok: false,
        error:
          'Nenhuma aba do PJe aberta. Abra o painel do PJe (qualquer 1º/2º grau) ' +
          'em uma aba antes de aplicar etiquetas.'
      });
      return;
    }
    // Preferir a primeira aba do domínio certo — idealmente a mesma onde
    // a pauta foi montada (hostnamePJe), mas qualquer aba jus.br serve
    // para o fetch same-origin com cookie.
    const tab = tabs[0];
    const resp = await chrome.tabs.sendMessage(tab.id!, {
      channel: MESSAGE_CHANNELS.PERICIAS_APLICAR_ETIQUETAS,
      payload
    });
    sendResponse(resp ?? { ok: false, error: 'Aba do PJe não respondeu.' });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handlePericiasAplicarEtiquetas falhou:`, err);
    sendResponse({ ok: false, error: errorMessage(err) });
  }
}

async function handlePericiasColetaFail(
  payload: { requestId: string; error: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (rota) {
      await chrome.tabs
        .sendMessage(rota.painelTabId, {
          channel: MESSAGE_CHANNELS.PERICIAS_COLETA_FAIL,
          payload
        })
        .catch(() => { /* aba-painel pode ter sido fechada */ });
      // Não apaga a rota aqui: o usuário pode querer reabrir o painel e
      // tentar de novo. A limpeza canônica é via PERICIAS_CLEAR_PAYLOAD.
    }
    await chrome.storage.session.remove(
      `${STORAGE_KEYS.PERICIAS_PAINEL_STATE_PREFIX}${payload?.requestId ?? ''}`
    );
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePericiasColetaFail falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

// ─── Streaming progressivo do dashboard "Prazos na Fita" ────────────

interface PrazosFitaSkeletonReadyPayload {
  requestId: string;
  meta: {
    total: number;
    totalDescobertos: number;
    hostnamePJe: string;
    tarefasSelecionadas: string[];
    nomeUnidade: string | null;
    geradoEm: string;
    consolidadosInicial?: number;
  };
}

interface PrazosFitaSlotPatchPayload {
  requestId: string;
  idx: number;
  item: PrazosFitaDashboardPayload['resultado']['consolidado'][number];
}

interface PrazosFitaFinalizedPayload {
  requestId: string;
  status: 'done' | 'aborted';
  tempoTotalMs: number;
  abortadoEm?: string;
  erroAbort?: string;
}

/**
 * Fase 1 concluida no content: grava o skeleton no IDB e manda a
 * aba-painel redirecionar pro dashboard. O dashboard abre em status
 * 'running' com cartoes em 0/total.
 *
 * Importante: NAO apaga a rota aqui — o dashboard compartilha o
 * `painelTabId` (redirect via `window.location.replace` preserva o tab
 * id) e precisamos dele para rotear SLOT_PATCH e FINALIZED.
 */
async function handlePrazosFitaSkeletonReady(
  payload: PrazosFitaSkeletonReadyPayload,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({ ok: false, error: 'Rota não encontrada.' });
      return;
    }
    if (!payload.meta || typeof payload.meta.total !== 'number') {
      sendResponse({ ok: false, error: 'Meta do skeleton inválido.' });
      return;
    }
    await initPrazosFitaDashboardStream({
      geradoEm: payload.meta.geradoEm,
      hostnamePJe: payload.meta.hostnamePJe,
      tarefasSelecionadas: payload.meta.tarefasSelecionadas,
      total: payload.meta.total,
      totalDescobertos: payload.meta.totalDescobertos,
      consolidadosInicial: payload.meta.consolidadosInicial
    });
    await chrome.tabs
      .sendMessage(rota.painelTabId, {
        channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_READY,
        payload: { requestId: payload.requestId }
      })
      .catch(() => { /* aba-painel pode ter sido fechada */ });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePrazosFitaSkeletonReady falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Cada processo coletado: grava slot no IDB e repassa para a aba do
 * dashboard (mesmo `painelTabId` pos-redirect). Dashboard faz coalesce
 * de RAF para re-renderizar sem travar em varreduras grandes.
 */
async function handlePrazosFitaSlotPatch(
  payload: PrazosFitaSlotPatchPayload,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      // Dashboard pode ter sido fechado — apenas grava no IDB e segue.
      // A proxima abertura reidrata do IDB.
      if (payload?.item && typeof payload.idx === 'number') {
        await patchPrazosFitaSlot(payload.idx, payload.item);
      }
      sendResponse({ ok: true });
      return;
    }
    await patchPrazosFitaSlot(payload.idx, payload.item);
    await chrome.tabs
      .sendMessage(rota.painelTabId, {
        channel: MESSAGE_CHANNELS.PRAZOS_FITA_SLOT_PATCH,
        payload
      })
      .catch(() => { /* dashboard fechado: tudo bem, ja esta no IDB */ });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePrazosFitaSlotPatch falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Reidratacao de slot em retomada de varredura. Mesma forma que
 * `handlePrazosFitaSlotPatch`, mas escreve no IDB sem incrementar o
 * contador `meta.consolidados` (ja foi refletido no
 * `consolidadosInicial` do skeleton). O dashboard tambem trata esse
 * canal sem incrementar o progresso.
 */
async function handlePrazosFitaHydrateSlot(
  payload: PrazosFitaSlotPatchPayload,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      if (payload?.item && typeof payload.idx === 'number') {
        await hydratePrazosFitaSlot(payload.idx, payload.item);
      }
      sendResponse({ ok: true });
      return;
    }
    await hydratePrazosFitaSlot(payload.idx, payload.item);
    await chrome.tabs
      .sendMessage(rota.painelTabId, {
        channel: MESSAGE_CHANNELS.PRAZOS_FITA_HYDRATE_SLOT,
        payload
      })
      .catch(() => { /* dashboard fechado: tudo bem, ja esta no IDB */ });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handlePrazosFitaHydrateSlot falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Fim da varredura (ok ou abort). Marca status no IDB, encaminha pro
 * dashboard e limpa a rota. Isso substitui o papel do COLETA_DONE
 * legado quando os callbacks de streaming estao ativos — mas o
 * COLETA_DONE legado continua funcional (caso alguem remova os
 * callbacks no futuro, ou para compatibilidade com varreduras que
 * sobreviveram a uma atualizacao de extensao a meio caminho).
 */
async function handlePrazosFitaColetaFinalized(
  payload: PrazosFitaFinalizedPayload,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    await finalizePrazosFitaDashboardStream({
      status: payload.status,
      tempoTotalMs: payload.tempoTotalMs,
      abortadoEm: payload.abortadoEm,
      erroAbort: payload.erroAbort
    });
    const rota = await getRota(payload?.requestId ?? '');
    if (rota) {
      await chrome.tabs
        .sendMessage(rota.painelTabId, {
          channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_FINALIZED,
          payload
        })
        .catch(() => { /* dashboard fechado */ });
      await deleteRota(payload.requestId);
    }
    await chrome.storage.session.remove(
      `${STORAGE_KEYS.GESTAO_PAINEL_STATE_PREFIX}${payload?.requestId ?? ''}`
    );
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(
      `${LOG_PREFIX} handlePrazosFitaColetaFinalized falhou:`,
      error
    );
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

// Limpeza: se a aba-painel ou a aba PJe for fechada antes do fim da
// varredura, removemos a rota e o estado temporário para não vazarmos
// storage.session.
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    try {
      const all = await chrome.storage.session.get(null);
      const toRemove: string[] = [];
      for (const [key, val] of Object.entries(all)) {
        if (!key.startsWith(STORAGE_KEYS.GESTAO_PAINEL_ROUTE_PREFIX)) continue;
        const rota = val as Partial<GestaoPainelRota> | null;
        if (!rota) continue;
        if (rota.painelTabId === tabId || rota.pjeTabId === tabId) {
          const rid = key.slice(STORAGE_KEYS.GESTAO_PAINEL_ROUTE_PREFIX.length);
          toRemove.push(key);
          toRemove.push(`${STORAGE_KEYS.GESTAO_PAINEL_STATE_PREFIX}${rid}`);
        }
      }
      if (toRemove.length) {
        await chrome.storage.session.remove(toRemove);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} onRemoved gestão falhou:`, err);
    }
  })();
});

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
    const { reduced: anonReduzido, amostra } = reduzirAnonParaOrcamento(payload.anon);
    if (amostra.amostrado) {
      console.info(
        `${LOG_PREFIX} Gestão insights: amostra de ${amostra.totalProcessosEnviados}` +
          `/${amostra.totalProcessosOriginal} processos (orçamento de tokens).`
      );
    }
    const prompt = buildGestaoInsightsPrompt(payload.indicadores, anonReduzido, amostra);

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

/**
 * Orçamento de caracteres para o bloco JSON de processos enviado à LLM.
 * Gemini 2.x aceita ~1.048.576 tokens de entrada; em JSON identado (com
 * campos repetidos e muitos dígitos), 1 token costuma valer 2–3 caracteres.
 * Fixamos o teto em ~600 mil caracteres para a amostra de processos,
 * deixando folga para system prompt, indicadores agregados, instruções do
 * usuário e o buffer de saída do modelo.
 */
const GESTAO_INSIGHTS_MAX_CHARS = 600_000;
/** Teto adicional de quantidade, mesmo se houver folga de caracteres. */
const GESTAO_INSIGHTS_MAX_PROCESSOS = 1500;
/** Truncamento do texto da última movimentação (economia de tokens). */
const GESTAO_INSIGHTS_MAX_MOV_CHARS = 280;

interface GestaoAmostraInfo {
  amostrado: boolean;
  totalProcessosOriginal: number;
  totalProcessosEnviados: number;
  criterio: string;
}

/**
 * Pontua a criticidade de um processo anonimizado para priorizá-lo quando
 * a lista não couber inteira no input da LLM. A prioridade processual e o
 * sigilo pesam mais, seguidos pelos dias parados na tarefa e pelos dias
 * desde a última movimentação. A presença de etiquetas também conta.
 */
function scoreProcessoInsights(p: TriagemProcessoAnon): number {
  let score = 0;
  if (p.prioritario) score += 1000;
  if (p.sigiloso) score += 200;
  if (typeof p.diasNaTarefa === 'number' && p.diasNaTarefa > 0) {
    score += Math.min(p.diasNaTarefa, 365) * 2;
  }
  if (typeof p.diasUltimoMovimento === 'number' && p.diasUltimoMovimento > 0) {
    score += Math.min(p.diasUltimoMovimento, 365) * 0.5;
  }
  if (p.etiquetas && p.etiquetas.length > 0) score += 50;
  return score;
}

function truncarMovimentacao(p: TriagemProcessoAnon): TriagemProcessoAnon {
  const texto = p.ultimaMovimentacaoTexto;
  if (!texto || texto.length <= GESTAO_INSIGHTS_MAX_MOV_CHARS) return p;
  return {
    ...p,
    ultimaMovimentacaoTexto:
      texto.slice(0, GESTAO_INSIGHTS_MAX_MOV_CHARS).trimEnd() + '…'
  };
}

/**
 * Se o payload anonimizado couber no orçamento, apenas trunca textos
 * longos de movimentação e devolve. Caso contrário, seleciona os processos
 * mais críticos (`scoreProcessoInsights`) até exaurir o orçamento e
 * remonta a estrutura por tarefa — tarefas que perderam todos os seus
 * processos ainda são enviadas com `processos: []` e `totalLido` original,
 * para que a LLM saiba que aquela fila existe no acervo.
 */
function reduzirAnonParaOrcamento(
  anon: TriagemPayloadAnon
): { reduced: TriagemPayloadAnon; amostra: GestaoAmostraInfo } {
  const totalOriginal = anon.tarefas.reduce(
    (acc, t) => acc + t.processos.length,
    0
  );

  const truncado: TriagemPayloadAnon = {
    ...anon,
    tarefas: anon.tarefas.map((t) => ({
      tarefaNome: t.tarefaNome,
      totalLido: t.totalLido,
      truncado: t.truncado,
      processos: t.processos.map(truncarMovimentacao)
    }))
  };

  const tamanhoAtual = JSON.stringify(truncado, null, 2).length;
  if (
    tamanhoAtual <= GESTAO_INSIGHTS_MAX_CHARS &&
    totalOriginal <= GESTAO_INSIGHTS_MAX_PROCESSOS
  ) {
    return {
      reduced: truncado,
      amostra: {
        amostrado: false,
        totalProcessosOriginal: totalOriginal,
        totalProcessosEnviados: totalOriginal,
        criterio: ''
      }
    };
  }

  interface Candidato {
    tarefaIdx: number;
    score: number;
    proc: TriagemProcessoAnon;
  }
  const candidatos: Candidato[] = [];
  truncado.tarefas.forEach((t, tarefaIdx) => {
    for (const p of t.processos) {
      candidatos.push({ tarefaIdx, score: scoreProcessoInsights(p), proc: p });
    }
  });
  candidatos.sort((a, b) => b.score - a.score);

  const overheadBase = JSON.stringify(
    {
      hostnamePJe: truncado.hostnamePJe,
      totalProcessos: truncado.totalProcessos,
      tarefas: truncado.tarefas.map((t) => ({
        tarefaNome: t.tarefaNome,
        totalLido: t.totalLido,
        truncado: t.truncado,
        processos: []
      }))
    },
    null,
    2
  ).length;

  let charsAcumulados = overheadBase;
  const aceitosPorTarefa: TriagemProcessoAnon[][] = truncado.tarefas.map(
    () => []
  );
  let totalAceitos = 0;
  for (const c of candidatos) {
    if (totalAceitos >= GESTAO_INSIGHTS_MAX_PROCESSOS) break;
    const procChars = JSON.stringify(c.proc, null, 2).length + 4;
    if (charsAcumulados + procChars > GESTAO_INSIGHTS_MAX_CHARS) continue;
    aceitosPorTarefa[c.tarefaIdx].push(c.proc);
    charsAcumulados += procChars;
    totalAceitos += 1;
  }

  const tarefasReduzidas: TriagemTarefaAnon[] = truncado.tarefas.map(
    (t, idx) => ({
      tarefaNome: t.tarefaNome,
      totalLido: t.totalLido,
      truncado: t.truncado,
      processos: aceitosPorTarefa[idx]
    })
  );

  return {
    reduced: {
      hostnamePJe: truncado.hostnamePJe,
      totalProcessos: truncado.totalProcessos,
      tarefas: tarefasReduzidas
    },
    amostra: {
      amostrado: true,
      totalProcessosOriginal: totalOriginal,
      totalProcessosEnviados: totalAceitos,
      criterio:
        'Seleção por criticidade: prioridade processual, sigilo, dias na ' +
        'tarefa, dias sem movimentação e presença de etiquetas (top-N até ' +
        'o limite de tokens do modelo).'
    }
  };
}

function buildGestaoInsightsPrompt(
  indicadores: GestaoIndicadores,
  anon: TriagemPayloadAnon,
  amostra: GestaoAmostraInfo
): string {
  const blocoAmostra = amostra.amostrado
    ? `IMPORTANTE: por restrição do limite de tokens do modelo, apenas ` +
      `${amostra.totalProcessosEnviados} de ${amostra.totalProcessosOriginal} ` +
      `processos foram incluídos na lista abaixo. ${amostra.criterio} ` +
      `Os INDICADORES AGREGADOS acima continuam refletindo o acervo ` +
      `COMPLETO — use-os como base da leitura quantitativa. A amostra ` +
      `abaixo serve apenas para ilustrar os casos mais críticos; ela NÃO ` +
      `é uma média do acervo e o panorama/alertas devem deixar claro ` +
      `quando a observação vem da amostra vs. dos agregados.\n\n`
    : '';
  return (
    `Você está analisando o Painel Gerencial de uma unidade judiciária no PJe.\n\n` +
    `INDICADORES AGREGADOS (calculados localmente, sem IA — refletem TODOS ` +
    `os processos da varredura):\n` +
    '```json\n' +
    JSON.stringify(indicadores, null, 2) +
    '\n```\n\n' +
    blocoAmostra +
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
// Etiquetas Inteligentes — busca do catálogo via content script do PJe
// =====================================================================

/**
 * Localiza uma aba aberta do PJe (qualquer host `*.jus.br` casando com
 * os padrões conhecidos) e devolve seu `tabId`. Escolhe a aba ativa
 * quando houver; do contrário, a primeira aba PJe encontrada. Retorna
 * `null` quando nenhuma aba estiver aberta — nesse caso a página de
 * opções deve orientar o usuário a entrar no PJe antes.
 */
async function localizarAbaPjeParaApi(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ url: 'https://*.jus.br/*' });
  const pjeTabs = tabs.filter((t) => {
    if (t.id === undefined || !t.url) return false;
    try {
      const host = new URL(t.url).hostname;
      return PJE_HOST_PATTERNS.some((re) => re.test(host));
    } catch {
      return false;
    }
  });
  if (pjeTabs.length === 0) return null;
  const ativa = pjeTabs.find((t) => t.active);
  return ativa?.id ?? pjeTabs[0].id ?? null;
}

/**
 * Options → background → content (aba do PJe): pede a listagem completa
 * do catálogo de etiquetas. Encaminha a chamada ao content script da aba
 * PJe (rodar same-origin é o que permite que os cookies + headers
 * `X-pje-*` capturados pelo interceptor sejam aceitos pelo servidor).
 */
async function handleEtiquetasFetchCatalog(
  payload: { pageSize?: number } | null,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const tabId = await localizarAbaPjeParaApi();
    if (tabId == null) {
      sendResponse({
        ok: false,
        total: 0,
        etiquetas: [],
        error:
          'Nenhuma aba do PJe aberta. Abra o painel do usuário no PJe ' +
          '(qualquer tarefa) e tente novamente — o snapshot de auth é ' +
          'capturado a partir da primeira chamada do Angular.'
      });
      return;
    }
    let resp: { ok?: boolean; [k: string]: unknown } | undefined;
    try {
      resp = await sendToTabWithRetry(
        tabId,
        {
          channel: MESSAGE_CHANNELS.ETIQUETAS_RUN_FETCH,
          payload: payload ?? {}
        },
        { attempts: 6, intervalMs: 500 }
      );
    } catch (err) {
      // "Could not establish connection. Receiving end does not exist."
      // significa que o content script não está vivo na aba — tipicamente
      // quando a aba do PJe foi aberta ANTES da instalação/atualização da
      // extensão. Tentamos injetar programaticamente o content.js e
      // repetir; se ainda assim falhar, orientamos o usuário a recarregar.
      const msg = errorMessage(err);
      if (
        msg.includes('Receiving end does not exist') ||
        msg.includes('Could not establish connection')
      ) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            files: ['content.js']
          });
          resp = await sendToTabWithRetry(
            tabId,
            {
              channel: MESSAGE_CHANNELS.ETIQUETAS_RUN_FETCH,
              payload: payload ?? {}
            },
            { attempts: 8, intervalMs: 500 }
          );
        } catch (err2) {
          console.warn(
            `${LOG_PREFIX} handleEtiquetasFetchCatalog: fallback inject falhou:`,
            err2
          );
          sendResponse({
            ok: false,
            total: 0,
            etiquetas: [],
            error:
              'A aba do PJe não está respondendo. Recarregue a aba do PJe ' +
              '(F5) e clique em qualquer tarefa do painel para capturar o ' +
              'snapshot de auth, e então tente novamente.'
          });
          return;
        }
      } else {
        throw err;
      }
    }
    if (!resp) {
      sendResponse({
        ok: false,
        total: 0,
        etiquetas: [],
        error: 'Aba do PJe não respondeu dentro do timeout.'
      });
      return;
    }
    sendResponse(resp);
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleEtiquetasFetchCatalog:`, err);
    sendResponse({
      ok: false,
      total: 0,
      etiquetas: [],
      error: errorMessage(err)
    });
  }
}

/**
 * Content (Triagem Inteligente) → background: pipeline "Inserir etiquetas
 * mágicas".
 *
 * 1. Monta o prompt do extrator de marcadores com o contexto dos autos, as
 *    orientações livres do usuário (`etiquetasPromptCriterios`) e o bloco
 *    de critérios de triagem.
 * 2. Chama a LLM ativa; parseia a resposta JSON em lista de marcadores.
 * 3. Roda o BM25 contra o índice das etiquetas sugestionáveis e devolve o
 *    ranking para a UI exibir.
 *
 * Erros comuns (sem API key, catálogo vazio, contexto vazio) são
 * traduzidos para mensagens humanas — a UI apenas exibe `error`.
 */
async function handleEtiquetasSugerir(
  payload: SugerirEtiquetasRequest,
  sendResponse: (response: SugerirEtiquetasResponse) => void
): Promise<void> {
  try {
    const caseContext = (payload?.caseContext ?? '').trim();
    if (!caseContext) {
      sendResponse({
        ok: false,
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
        error: `API key não cadastrada para ${providerId}.`
      });
      return;
    }

    const criteriosBlock = buildTriagemCriteriosBlock(settings);
    const userHints = settings.etiquetasPromptCriterios ?? '';
    const prompt = buildEtiquetasMarkersPrompt(caseContext, userHints, criteriosBlock);

    const provider = getProvider(providerId);
    const controller = new AbortController();
    const generator = provider.sendMessage({
      apiKey,
      model: settings.models[providerId],
      systemPrompt:
        'Você é um classificador que lê um processo judicial e produz uma lista curta de ' +
        'MARCADORES semânticos (2 a 6 palavras cada). Responda SEMPRE em JSON puro, sem ' +
        'markdown, sem comentários.',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      temperature: 0.1,
      // Marcadores são curtos; 1024 cobre com folga 15 marcadores de 6 palavras.
      maxTokens: 1024,
      signal: controller.signal
    });

    let raw = '';
    for await (const chunk of generator) {
      raw += chunk.delta;
    }

    const markers = parseEtiquetasMarkersResponse(raw);
    if (markers.length === 0) {
      sendResponse({
        ok: false,
        error:
          'A IA não produziu marcadores utilizáveis para este processo. ' +
          'Tente novamente ou ajuste as orientações na aba "Etiquetas Inteligentes".'
      });
      return;
    }

    const ranked = await rankEtiquetasSugestionaveis(markers, { topK: 8 });
    if (ranked.length === 0) {
      sendResponse({
        ok: true,
        markers,
        matches: []
      });
      return;
    }

    sendResponse({
      ok: true,
      markers,
      matches: ranked.map((m) => ({
        id: m.etiqueta.id,
        nomeTag: m.etiqueta.nomeTag,
        nomeTagCompleto: m.etiqueta.nomeTagCompleto,
        favorita: m.etiqueta.favorita,
        similarity: m.similarity,
        score: m.score,
        matchedMarkers: m.matchedMarkers
      }))
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleEtiquetasSugerir:`, err);
    sendResponse({ ok: false, error: errorMessage(err) });
  }
}

// =====================================================================
// Prazos na fita — Fase A2 (coleta por aba isolada)
// =====================================================================

/**
 * Coleta de UM processo: abre a URL em aba inativa, aguarda carregar,
 * pede ao content da aba para extrair os expedientes e fecha a aba ao
 * final. O `chamador` (content do painel ou outro) recebe um
 * `PrazosProcessoColeta` estruturado, com `ok=false` quando algo falha.
 *
 * Tolerância: o content script do PJe pode não estar pronto assim que
 * `status === 'complete'` chega (AJAX pós-load, adapter ainda fazendo
 * detect). Por isso o `sendMessage` tenta N vezes com intervalo curto.
 *
 * A aba sempre é fechada no `finally`, inclusive em caso de erro, para
 * evitar vazamento de abas durante uma varredura em lote.
 */
async function handlePrazosFitaColetarProcesso(
  payload: { url: string; timeoutMs?: number },
  sendResponse: (response: unknown) => void
): Promise<void> {
  const inicio = Date.now();
  const url = payload?.url ?? '';
  if (!url || typeof url !== 'string') {
    sendResponse({
      ok: false,
      url,
      numeroProcesso: null,
      error: 'URL ausente ou inválida.',
      duracaoMs: 0
    });
    return;
  }
  const timeoutMs = payload.timeoutMs ?? 45_000;

  let tabId: number | null = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id == null) {
      sendResponse({
        ok: false,
        url,
        numeroProcesso: null,
        error: 'chrome.tabs.create não retornou tabId.',
        duracaoMs: Date.now() - inicio
      });
      return;
    }
    tabId = tab.id;

    await waitTabComplete(tabId, timeoutMs);

    const resp = await sendToTabWithRetry(
      tabId,
      {
        channel: MESSAGE_CHANNELS.PRAZOS_FITA_EXTRAIR_NA_ABA,
        payload: {}
      },
      { attempts: 12, intervalMs: 500 }
    );

    if (!resp || resp.ok === false) {
      sendResponse({
        ok: false,
        url,
        numeroProcesso: resp?.numeroProcesso ?? null,
        error: resp?.error ?? 'Content script não respondeu.',
        duracaoMs: Date.now() - inicio
      });
      return;
    }

    sendResponse({
      ok: true,
      url,
      numeroProcesso: resp.numeroProcesso ?? null,
      extracao: resp.extracao,
      anomaliasProcesso: resp.anomaliasProcesso,
      duracaoMs: Date.now() - inicio
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handlePrazosFitaColetarProcesso:`, err);
    sendResponse({
      ok: false,
      url,
      numeroProcesso: null,
      error: errorMessage(err),
      duracaoMs: Date.now() - inicio
    });
  } finally {
    if (tabId != null) {
      chrome.tabs.remove(tabId).catch(() => { /* aba já fechada */ });
    }
  }
}

// =====================================================================
// Prazos na fita — Encerrar todos os expedientes da tarefa (main world)
// =====================================================================

interface PrazosEncerrarRequest {
  /** URL `movimentar.seam?idProcesso=X&newTaskId=Y` da tarefa alvo. */
  url: string;
  /** Número CNJ do processo (para o log de auditoria — não é enviado à LLM). */
  numeroProcesso: string;
  idProcesso: string;
  idTaskInstance: string;
}

interface PrazosEncerrarResult {
  ok: boolean;
  /** Estado final a ser pintado na coluna do dashboard. */
  estado: 'sucesso' | 'erro' | 'nada-a-fazer';
  /** Quantos expedientes foram encerrados nesta execução. */
  quantidade: number;
  /** Mensagem de erro (quando `estado === 'erro'`). */
  error?: string;
  /** Timestamp (ms) de quando a tentativa terminou. */
  terminouEm: number;
  duracaoMs: number;
}

interface PrazosEncerrarAuditEntry {
  ts: number;
  numeroProcesso: string;
  idProcesso: string;
  idTaskInstance: string;
  estado: PrazosEncerrarResult['estado'];
  quantidade: number;
  error?: string;
  duracaoMs: number;
}

/** Máximo de entradas no log de auditoria. FIFO — o dashboard pode exibir depois. */
const PRAZOS_ENCERRAR_AUDIT_MAX = 500;

async function handlePrazosEncerrarRun(
  payload: PrazosEncerrarRequest,
  sendResponse: (resp: PrazosEncerrarResult) => void
): Promise<void> {
  const inicio = Date.now();
  const url = payload?.url ?? '';
  const idProcesso = payload?.idProcesso ?? '';
  const idTaskInstance = payload?.idTaskInstance ?? '';

  if (!url || !idProcesso || !idTaskInstance) {
    const result: PrazosEncerrarResult = {
      ok: false,
      estado: 'erro',
      quantidade: 0,
      error: 'Parâmetros ausentes (url / idProcesso / idTaskInstance).',
      terminouEm: Date.now(),
      duracaoMs: Date.now() - inicio
    };
    sendResponse(result);
    return;
  }

  let tabId: number | null = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id == null) {
      const result: PrazosEncerrarResult = {
        ok: false,
        estado: 'erro',
        quantidade: 0,
        error: 'chrome.tabs.create não retornou tabId.',
        terminouEm: Date.now(),
        duracaoMs: Date.now() - inicio
      };
      sendResponse(result);
      return;
    }
    tabId = tab.id;

    await waitTabComplete(tabId, 45_000);

    // Respiro curto: RichFaces inicializa em setTimeout(0) e o tbody de
    // expedientes pode ainda não estar colado quando o tab.status vira
    // 'complete'. 500ms é barato e cobre o caso geral.
    await new Promise<void>((r) => setTimeout(r, 500));

    const [inj] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: encerrarExpedientesNoFrame
    });

    const raw = inj?.result as EncerrarExpedientesOutput | undefined;
    if (!raw) {
      const result: PrazosEncerrarResult = {
        ok: false,
        estado: 'erro',
        quantidade: 0,
        error: 'Injeção main-world não retornou resultado (página sem expedientes?).',
        terminouEm: Date.now(),
        duracaoMs: Date.now() - inicio
      };
      await registrarAuditoriaEncerramento(result, payload);
      sendResponse(result);
      return;
    }

    let result: PrazosEncerrarResult;
    if (raw.ok && raw.empty) {
      result = {
        ok: true,
        estado: 'nada-a-fazer',
        quantidade: 0,
        terminouEm: Date.now(),
        duracaoMs: Date.now() - inicio
      };
    } else if (raw.ok) {
      result = {
        ok: true,
        estado: 'sucesso',
        quantidade: raw.count ?? 0,
        terminouEm: Date.now(),
        duracaoMs: Date.now() - inicio
      };
    } else {
      result = {
        ok: false,
        estado: 'erro',
        quantidade: raw.count ?? 0,
        error: raw.error ?? 'Falha desconhecida na automação.',
        terminouEm: Date.now(),
        duracaoMs: Date.now() - inicio
      };
    }

    await registrarAuditoriaEncerramento(result, payload);
    sendResponse(result);
  } catch (err) {
    console.warn(`${LOG_PREFIX} handlePrazosEncerrarRun:`, err);
    const result: PrazosEncerrarResult = {
      ok: false,
      estado: 'erro',
      quantidade: 0,
      error: errorMessage(err),
      terminouEm: Date.now(),
      duracaoMs: Date.now() - inicio
    };
    await registrarAuditoriaEncerramento(result, payload).catch(() => { /* ignora */ });
    sendResponse(result);
  } finally {
    if (tabId != null) {
      chrome.tabs.remove(tabId).catch(() => { /* aba já fechada */ });
    }
  }

  async function registrarAuditoriaEncerramento(
    res: PrazosEncerrarResult,
    p: PrazosEncerrarRequest
  ): Promise<void> {
    try {
      const key = STORAGE_KEYS.PRAZOS_ENCERRAR_AUDIT;
      const stored = await chrome.storage.local.get([key]);
      const list: PrazosEncerrarAuditEntry[] = Array.isArray(stored[key])
        ? stored[key]
        : [];
      list.unshift({
        ts: res.terminouEm,
        numeroProcesso: p.numeroProcesso ?? '',
        idProcesso: p.idProcesso ?? '',
        idTaskInstance: p.idTaskInstance ?? '',
        estado: res.estado,
        quantidade: res.quantidade,
        error: res.error,
        duracaoMs: res.duracaoMs
      });
      if (list.length > PRAZOS_ENCERRAR_AUDIT_MAX) {
        list.length = PRAZOS_ENCERRAR_AUDIT_MAX;
      }
      await chrome.storage.local.set({ [key]: list });
    } catch (e) {
      console.warn(`${LOG_PREFIX} falha ao registrar auditoria de encerramento:`, e);
    }
  }
}

/** Shape do retorno da função injetada em main world. */
interface EncerrarExpedientesOutput {
  ok: boolean;
  /** `true` quando não havia expedientes abertos (coluna vira "nada-a-fazer"). */
  empty?: boolean;
  /** Quantidade de expedientes que estavam abertos antes da automação. */
  count?: number;
  /** Mensagem de erro legível. */
  error?: string;
}

/**
 * Executada em MAIN world na aba recém-aberta de `movimentar.seam`.
 *
 * Fluxo:
 *   1. Localiza o checkbox do header (`id` termina em `:fechadoHeader`) e
 *      conta os checkboxes de linha (mesma coluna, sem o sufixo Header).
 *   2. Monkey-patch em `window.confirm` para pular o `confirm('Confirma o
 *      encerramento...?')` do botão.
 *   3. Marca o header e dispara o onchange (A4J.AJAX.Submit) — o PJe
 *      replica para as linhas e habilita o botão "Encerrar".
 *   4. Aguarda um respiro curto, clica no botão (o onclick corre
 *      `confirm(...)` — já monkey-patcheado — e dispara o Submit).
 *   5. Polling até os checkboxes de linha zerarem ou o deadline estourar.
 *
 * Todos os resultados (inclusive erro) voltam pelo `resolve` da Promise —
 * `chrome.scripting.executeScript` aceita Promise como retorno.
 */
function encerrarExpedientesNoFrame(): Promise<EncerrarExpedientesOutput> {
  return new Promise((resolve) => {
    const DEADLINE_CONFIRM_MS = 25_000;
    const ORIGINAL_CONFIRM = window.confirm;
    const restaurar = (): void => {
      try {
        window.confirm = ORIGINAL_CONFIRM;
      } catch {
        /* ignora */
      }
    };

    const acabou = (out: EncerrarExpedientesOutput): void => {
      restaurar();
      resolve(out);
    };

    try {
      window.confirm = () => true;

      const header = document.querySelector(
        'input[type="checkbox"][id$=":fechadoHeader"]'
      ) as HTMLInputElement | null;

      if (!header) {
        acabou({
          ok: false,
          error:
            'Checkbox "fechadoHeader" não encontrada — a aba de expedientes pode não ter carregado ou a sessão expirou.'
        });
        return;
      }

      const escopo: ParentNode =
        header.closest('table') ??
        header.closest('form') ??
        document;

      const seletorLinhas =
        'input[type="checkbox"][id*=":fechado"]:not([id$=":fechadoHeader"])';
      const linhasIniciais = Array.from(
        escopo.querySelectorAll<HTMLInputElement>(seletorLinhas)
      );
      const total = linhasIniciais.length;

      if (total === 0) {
        acabou({ ok: true, empty: true, count: 0 });
        return;
      }

      header.checked = true;
      header.dispatchEvent(new Event('change', { bubbles: true }));
      header.dispatchEvent(new Event('click', { bubbles: true }));

      // Algumas versões do RichFaces só respondem ao handler inline.
      const onchangeAttr = header.getAttribute('onchange');
      if (onchangeAttr) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          new Function('event', onchangeAttr).call(header);
        } catch {
          /* ignora — o change/click acima pode ter bastado */
        }
      }

      // Aguarda a AJAX do select-all e então clica no botão Encerrar.
      setTimeout(() => {
        const btn = localizarBotaoEncerrar();
        if (!btn) {
          acabou({
            ok: false,
            count: 0,
            error: 'Botão "Encerrar expedientes selecionados" não encontrado.'
          });
          return;
        }

        try {
          btn.click();
        } catch (err) {
          acabou({
            ok: false,
            count: 0,
            error:
              'Falha ao clicar no botão Encerrar: ' +
              (err instanceof Error ? err.message : String(err))
          });
          return;
        }

        const deadline = Date.now() + DEADLINE_CONFIRM_MS;
        const poll = (): void => {
          const abertas = Array.from(
            escopo.querySelectorAll<HTMLInputElement>(seletorLinhas)
          );
          const restantes = abertas.length;
          if (restantes === 0) {
            acabou({ ok: true, count: total });
            return;
          }
          if (Date.now() > deadline) {
            acabou({
              ok: false,
              count: total - restantes,
              error:
                `Tempo esgotado aguardando encerramento — ` +
                `${restantes}/${total} expedientes ainda aparecem como abertos.`
            });
            return;
          }
          setTimeout(poll, 600);
        };
        setTimeout(poll, 1200);
      }, 1500);

      function localizarBotaoEncerrar(): HTMLElement | null {
        // Tentativa 1: input type=button com value exato.
        const inputs = document.querySelectorAll<HTMLInputElement>(
          'input[type="button"], input[type="submit"]'
        );
        for (const el of Array.from(inputs)) {
          const v = (el.value ?? '').trim();
          if (v === 'Encerrar expedientes selecionados') return el;
        }
        // Tentativa 2: <button> com textContent equivalente.
        const botoes = document.querySelectorAll<HTMLButtonElement>('button');
        for (const el of Array.from(botoes)) {
          const t = (el.textContent ?? '').trim();
          if (t === 'Encerrar expedientes selecionados') return el;
        }
        return null;
      }
    } catch (err) {
      acabou({
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });
}

/**
 * Resolve quando a aba atinge `status === 'complete'` — ou rejeita no
 * `timeoutMs`. Cobre o caso em que a aba já terminou ANTES de
 * registrarmos o listener (chrome.tabs.get inicial).
 */
function waitTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let finalizado = false;
    const timer = setTimeout(() => {
      if (finalizado) return;
      finalizado = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timeout (${timeoutMs}ms) aguardando aba ${tabId}.`));
    }, timeoutMs);
    const listener = (
      updatedId: number,
      info: chrome.tabs.TabChangeInfo
    ): void => {
      if (updatedId !== tabId) return;
      if (info.status !== 'complete') return;
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete' && !finalizado) {
          finalizado = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      })
      .catch(() => { /* segue esperando o evento */ });
  });
}

/**
 * `chrome.tabs.sendMessage` com retry. No PJe, o content script pode
 * não ter registrado o listener ainda no momento do primeiro envio; o
 * Chrome retorna "Could not establish connection" nessa janela.
 */
async function sendToTabWithRetry(
  tabId: number,
  message: unknown,
  opts: { attempts: number; intervalMs: number }
): Promise<{ ok?: boolean; [k: string]: unknown } | undefined> {
  let lastErr: unknown = null;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, message);
      if (resp !== undefined) return resp;
    } catch (err) {
      lastErr = err;
    }
    await new Promise<void>((r) => setTimeout(r, opts.intervalMs));
  }
  if (lastErr) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  return undefined;
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
