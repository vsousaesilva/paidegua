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
import { addRegistro as addComunicacaoRegistro } from '../shared/comunicacao-store';
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
  AudienciaTarefaInfo,
  ComunicacaoSettings,
  PericiaPerito,
  PericiaTarefaInfo,
  PericiasDashboardPayload,
  RegistroCobranca,
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
  PROMPT_SISTEMA_DADOS_PDF,
  MAX_CHARS_PARA_IA,
  type DadosPdfExtraidos
} from '../shared/criminal-ai-prompts';
import {
  atualizarProcesso,
  atualizarReu,
  CRIMINAL_DB_NAME,
  CRIMINAL_DB_VERSION,
  CRIMINAL_STORES,
  getProcessoById,
  limparDadosPoluidos,
  loadCriminalConfig,
  previewLimpezaPoluidos,
  upsertProcessoFromPje
} from '../shared/criminal-store';
import {
  executarAutoExport,
  minutosAteProximoExport
} from '../shared/criminal-export';
import type {
  PjeOrigemMap,
  Processo,
  ProcessoPayload,
  Reu,
  ReuPayload,
  TraceEntry
} from '../shared/criminal-types';
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
  // Boas-vindas: na primeira instalacao, abre uma aba com a tela de
  // login + apresentacao da extensao. Em updates ou reload local nao
  // dispara — evita atrapalhar quem ja conhece o sistema.
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') })
      .catch((err) => console.warn(`${LOG_PREFIX} falha abrindo welcome:`, err));
  }
  // Sincroniza o alarm de auto-export com a config persistida.
  // Importante em updates da extensão (o navegador limpa alarms
  // quando a versão do SW muda).
  void agendarAutoExportFromConfig().catch((err) =>
    console.warn(`${LOG_PREFIX} reagendar auto-export pós-install falhou:`, err)
  );
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
  // Reagenda o auto-export — o SW pode ter sido reciclado e os alarms
  // sobrevivem, mas reagendar é idempotente e cobre edge cases.
  void agendarAutoExportFromConfig().catch((err) =>
    console.warn(`${LOG_PREFIX} reagendar auto-export no startup falhou:`, err)
  );
});

// =====================================================================
// Auto-export agendado do acervo criminal
// =====================================================================

const ALARM_AUTO_EXPORT = 'paidegua/criminal/auto-export';

/**
 * Lê a config do acervo criminal e (re)cria o `chrome.alarms` que
 * dispara o auto-export. `'desligado'` ou faltando horário ⇒ alarm é
 * removido. Idempotente: pode ser chamado várias vezes sem efeito
 * colateral.
 */
/**
 * Abre os autos digitais de um processo no PJe em uma nova aba.
 *
 * Estratégia:
 *   1. Se temos `idProcesso` + `hostnamePje`: tenta achar uma aba
 *      PJe ativa (mesmo hostname preferencialmente, qualquer
 *      `*.jus.br` como segunda opção) e pedir a `ca` via
 *      `CRIMINAL_FETCH_CA` ao content script. Com `ca`, monta a URL
 *      completa `Detalhe/listAutosDigitais.seam?idProcesso=X&ca=Y` —
 *      essa rota abre direto os autos. Sem `ca`, o PJe redireciona
 *      para `error.seam` (foi exatamente o sintoma reportado).
 *   2. Fallback: abre a Consulta Pública por número CNJ
 *      (`pjeconsulta/ConsultaPublica/listView.seam?numeroProcesso=X`),
 *      que dispensa `ca` mas exige um clique adicional do usuário.
 *      Usado quando não há aba PJe ativa ou a geração da `ca` falha.
 *
 * Devolve `{ ok, modo, url, error? }` para a UI exibir feedback
 * (toast) sobre qual rota foi usada.
 */
async function handleCriminalAbrirProcesso(
  payload: {
    idProcesso?: number | null;
    hostnamePje?: string | null;
    idTaskInstance?: number | null;
    numeroProcesso?: string | null;
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  const { idProcesso, hostnamePje, numeroProcesso } = payload;
  if (!hostnamePje) {
    sendResponse({
      ok: false,
      error: 'Hostname do PJe não capturado neste processo.'
    });
    return;
  }

  // 1. Tenta abrir os autos diretos (precisa de ca).
  if (idProcesso) {
    try {
      const tabs = await chrome.tabs.query({});
      // Prioridade 1: aba do MESMO hostname (sessão já válida).
      // Prioridade 2: qualquer aba *.jus.br (a sessão pode estar lá
      // se for o mesmo TRF — content responde ou erra rápido).
      const candidatos = tabs
        .filter((t) => {
          if (!t.id || !t.url) return false;
          try {
            const u = new URL(t.url);
            return /\.jus\.br$/i.test(u.hostname) && /^https?:$/.test(u.protocol);
          } catch {
            return false;
          }
        })
        .sort((a, b) => {
          const aPrio = a.url?.includes(hostnamePje) ? 0 : 1;
          const bPrio = b.url?.includes(hostnamePje) ? 0 : 1;
          if (aPrio !== bPrio) return aPrio - bPrio;
          return (
            ((b as { lastAccessed?: number }).lastAccessed ?? 0) -
            ((a as { lastAccessed?: number }).lastAccessed ?? 0)
          );
        });

      const tabPje = candidatos[0];
      if (tabPje?.id) {
        const respCa = (await chrome.tabs.sendMessage(tabPje.id, {
          channel: MESSAGE_CHANNELS.CRIMINAL_FETCH_CA,
          payload: { idProcesso }
        })) as { ok: boolean; ca?: string; error?: string };

        if (respCa?.ok && respCa.ca) {
          // Só `idProcesso + ca` — propositalmente NÃO incluímos
          // `idTaskInstance` porque ele foi capturado na varredura
          // anterior e pode estar defasado (o processo costuma
          // mudar de tarefa entre varreduras). PJe rejeita combinações
          // `idProcesso + idTaskInstance` inválidas com a mensagem
          // "Usuário sem visibilidade", mesmo com `ca` correta.
          // Para abrir os autos basta `ca`. Para ir direto numa
          // tarefa específica, há o botão "abrir tarefa" separado.
          const url =
            `https://${hostnamePje}/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam` +
            `?idProcesso=${idProcesso}&ca=${encodeURIComponent(respCa.ca)}`;
          await chrome.tabs.create({ url });
          sendResponse({ ok: true, modo: 'autos', url });
          return;
        }
      }
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} abrir-processo: falha gerando ca, caindo em ConsultaPublica:`,
        err
      );
    }
  }

  // 2. Fallback: Consulta Pública por número CNJ.
  if (!numeroProcesso) {
    sendResponse({
      ok: false,
      error:
        'Não foi possível gerar chave de acesso do PJe (sem aba PJe ativa) e o número CNJ não está disponível para o fallback.'
    });
    return;
  }
  const m = numeroProcesso.match(/[\d.\-]+/);
  const num = m ? m[0] : numeroProcesso;
  const url =
    `https://${hostnamePje}/pjeconsulta/ConsultaPublica/listView.seam` +
    `?numeroProcesso=${encodeURIComponent(num)}`;
  await chrome.tabs.create({ url });
  sendResponse({ ok: true, modo: 'consulta-publica', url });
}

/**
 * Abre a tela de movimentação da tarefa corrente no PJe — mesma
 * estratégia do `handleCriminalAbrirProcesso`, mas a URL é
 * `movimentar.seam?idProcesso=X&newTaskId=Y&ca=Z`.
 *
 * O `idTaskInstance` é o capturado na última varredura. Se o
 * processo já saiu da tarefa (foi movimentado), o PJe rejeita com
 * "Usuário sem visibilidade" mesmo com `ca` correta — a UI deve
 * orientar o usuário a clicar em "Atualizar com PJe + IA" para
 * recapturar a tarefa atual.
 */
async function handleCriminalAbrirTarefa(
  payload: {
    idProcesso?: number | null;
    idTaskInstance?: number | null;
    hostnamePje?: string | null;
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  const { idProcesso, idTaskInstance, hostnamePje } = payload;
  if (!hostnamePje || !idProcesso || !idTaskInstance) {
    sendResponse({
      ok: false,
      error: 'Dados insuficientes (hostname, idProcesso ou idTaskInstance ausentes).'
    });
    return;
  }

  try {
    const tabs = await chrome.tabs.query({});
    const candidatos = tabs
      .filter((t) => {
        if (!t.id || !t.url) return false;
        try {
          const u = new URL(t.url);
          return /\.jus\.br$/i.test(u.hostname) && /^https?:$/.test(u.protocol);
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        const aPrio = a.url?.includes(hostnamePje) ? 0 : 1;
        const bPrio = b.url?.includes(hostnamePje) ? 0 : 1;
        if (aPrio !== bPrio) return aPrio - bPrio;
        return (
          ((b as { lastAccessed?: number }).lastAccessed ?? 0) -
          ((a as { lastAccessed?: number }).lastAccessed ?? 0)
        );
      });

    const tabPje = candidatos[0];
    if (!tabPje?.id) {
      sendResponse({
        ok: false,
        error:
          'Nenhuma aba do PJe aberta. Abra qualquer processo no PJe e tente novamente.'
      });
      return;
    }

    const respCa = (await chrome.tabs.sendMessage(tabPje.id, {
      channel: MESSAGE_CHANNELS.CRIMINAL_FETCH_CA,
      payload: { idProcesso }
    })) as { ok: boolean; ca?: string; error?: string };

    if (!respCa?.ok || !respCa.ca) {
      sendResponse({
        ok: false,
        error: `Não foi possível gerar chave de acesso: ${respCa?.error ?? 'sem detalhes'}.`
      });
      return;
    }

    const params = new URLSearchParams();
    params.set('idProcesso', String(idProcesso));
    params.set('newTaskId', String(idTaskInstance));
    params.set('ca', respCa.ca);
    const url =
      `https://${hostnamePje}/pje/Processo/movimentar.seam?${params.toString()}`;
    await chrome.tabs.create({ url });
    sendResponse({ ok: true, url });
  } catch (err) {
    console.warn(`${LOG_PREFIX} abrir-tarefa:`, err);
    sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function agendarAutoExportFromConfig(): Promise<void> {
  try {
    const config = await loadCriminalConfig();
    const periodicidade = config.auto_export_periodicidade ?? 'desligado';
    const horario = config.auto_export_horario ?? '';
    if (periodicidade === 'desligado' || !horario) {
      await chrome.alarms.clear(ALARM_AUTO_EXPORT);
      console.log(`${LOG_PREFIX} auto-export: agendamento desligado.`);
      return;
    }
    const minutosAteProx = minutosAteProximoExport(periodicidade, horario);
    const periodoMinutos = periodicidade === 'diario' ? 24 * 60 : 7 * 24 * 60;
    await chrome.alarms.create(ALARM_AUTO_EXPORT, {
      delayInMinutes: minutosAteProx,
      periodInMinutes: periodoMinutos
    });
    console.log(
      `${LOG_PREFIX} auto-export agendado: ${periodicidade} às ${horario} ` +
        `(próxima execução em ${minutosAteProx}min).`
    );
  } catch (err) {
    console.warn(`${LOG_PREFIX} agendarAutoExportFromConfig falhou:`, err);
    throw err;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_AUTO_EXPORT) return;
  console.log(`${LOG_PREFIX} auto-export disparado pelo alarm.`);
  // Disparo do SW: NÃO podemos pedir permissão (não há gesto). Se a
  // permissão foi revogada, executarAutoExport registra falha em
  // `ultimo_export_status` e a UI da config exibe um aviso.
  void executarAutoExport({
    permitirRequestPermission: false,
    origem: 'agendamento'
  })
    .then((r) => {
      if (r.ok) {
        console.log(
          `${LOG_PREFIX} auto-export concluído: ${r.arquivo} (${r.bytes} bytes).`
        );
      } else {
        console.warn(
          `${LOG_PREFIX} auto-export falhou (${r.motivoCurto}): ${r.error}`
        );
      }
    })
    .catch((err) => {
      console.error(`${LOG_PREFIX} auto-export exception:`, err);
    });
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

      case MESSAGE_CHANNELS.COMUNICACAO_OPEN_PAINEL:
        void handleOpenComunicacaoPainel(
          message.payload as {
            peritos: PericiaPerito[];
            settings: ComunicacaoSettings;
            hostnamePJe: string;
            legacyOrigin: string;
            abertoEm: string;
          },
          sender,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.COMUNICACAO_RUN_COLETA:
        void handleComunicacaoRunColeta(
          message.payload as {
            requestId: string;
            modo: 'cobrar-perito-whatsapp' | 'cobrar-ceab-email';
            filtro: 'tarefa' | 'etiqueta';
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.COMUNICACAO_REGISTRAR_COBRANCA:
        void handleComunicacaoRegistrarCobranca(
          message.payload as Omit<RegistroCobranca, 'id' | 'geradoEm'>,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.AUDIENCIA_OPEN_PAINEL:
        void handleOpenAudienciaPainel(
          message.payload as {
            tarefas: AudienciaTarefaInfo[];
            hostnamePJe: string;
            legacyOrigin: string;
            abertoEm: string;
          },
          sender,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.AUDIENCIA_RUN_COLETA:
        void handleAudienciaRunColeta(
          message.payload as {
            requestId: string;
            nomesTarefas: string[];
            quantidadePorPauta: number;
            dataAudienciaISO: string;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.AUDIENCIA_APLICAR_ETIQUETAS:
        void handleAudienciaAplicarEtiquetas(
          message.payload as {
            etiquetaPauta: string;
            idsProcesso: number[];
            favoritarAposCriar?: boolean;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.FLUXOS_OPEN_CONSULTOR:
        void handleOpenFluxosConsultor(sendResponse);
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

      case MESSAGE_CHANNELS.CRIMINAL_COLETAR_PROCESSO:
        void handleCriminalColetarProcesso(
          message.payload as {
            url: string;
            idProcesso?: number;
            timeoutMs?: number;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_AI_EXTRAIR_PDF:
        void handleCriminalAiExtrairPdf(
          message.payload as {
            texto: string;
            tipoDocumento?: string;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_OPEN_PAINEL:
        void handleOpenCriminalPainel(
          message.payload as {
            tarefas: Array<{ nome: string; quantidade: number | null }>;
            config: unknown;
            hostnamePJe: string;
            abertoEm: string;
          },
          sender,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_START_COLETA:
        void handleCriminalStartColeta(
          message.payload as {
            requestId: string;
            nomesTarefas: string[];
            modo: 'rapido' | 'completo';
            config: unknown;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_ENRIQUECER_REU:
        void handleCriminalEnriquecerReu(
          message.payload as { reuId: string; cpf: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_REPROCESSAR_PROCESSO:
        void handleCriminalReprocessarProcesso(
          message.payload as { processoId: string },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_PROCESSAR_PDF_MANUAL:
        void handleCriminalProcessarPdfManual(
          message.payload as {
            processoId: string;
            texto: string;
            tipoDocumento?: string;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_REAGENDAR_AUTO_EXPORT:
        void agendarAutoExportFromConfig()
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_ABRIR_PROCESSO:
        void handleCriminalAbrirProcesso(
          message.payload as {
            idProcesso?: number | null;
            hostnamePje?: string | null;
            idTaskInstance?: number | null;
            numeroProcesso?: string | null;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_ABRIR_TAREFA:
        void handleCriminalAbrirTarefa(
          message.payload as {
            idProcesso?: number | null;
            idTaskInstance?: number | null;
            hostnamePje?: string | null;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_AUTO_EXPORT_NOW:
        // Disparado pelo botão "Exportar agora" da página de config.
        // A própria página tem gesto do usuário e poderia chamar a
        // função local — usar este canal centraliza o registro do
        // status e permite reusar a mesma rotina do alarm.
        void executarAutoExport({
          permitirRequestPermission: false,
          origem: 'manual'
        })
          .then((r) => sendResponse(r))
          .catch((err) =>
            sendResponse({
              ok: false,
              error: errorMessage(err),
              motivoCurto: 'falha-escrita'
            })
          );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_PREVIEW_LIMPEZA:
        void (async () => {
          try {
            const itens = await previewLimpezaPoluidos();
            sendResponse({ ok: true, itens });
          } catch (err) {
            sendResponse({ ok: false, error: errorMessage(err) });
          }
        })();
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_APLICAR_LIMPEZA:
        void (async () => {
          try {
            const stats = await limparDadosPoluidos();
            sendResponse({ ok: true, ...stats });
          } catch (err) {
            sendResponse({ ok: false, error: errorMessage(err) });
          }
        })();
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_ATUALIZAR_PROCESSO:
        void handleCriminalAtualizarProcesso(
          message.payload as {
            processoId: string;
            patch: Partial<ProcessoPayload>;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_ATUALIZAR_REU:
        void handleCriminalAtualizarReu(
          message.payload as {
            reuId: string;
            patch: Partial<Reu>;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.CRIMINAL_COLETA_SLOT:
        // Upsert no IndexedDB do origin da extensão (background) +
        // roteamento de versão slim pro painel.
        void handleCriminalColetaSlot(
          message.payload as {
            requestId: string;
            capturado: {
              payload: ProcessoPayload;
              reus: ReuPayload[];
              pje_origem: PjeOrigemMap;
              reusOrigem: PjeOrigemMap[];
              ultima_sincronizacao_pje: string;
              warnings: string[];
            };
          }
        );
        sendResponse({ ok: true });
        return false;

      case MESSAGE_CHANNELS.CRIMINAL_COLETA_PROG:
      case MESSAGE_CHANNELS.CRIMINAL_COLETA_DONE:
      case MESSAGE_CHANNELS.CRIMINAL_COLETA_FAIL:
        void rotearEventoCriminal(
          message.channel,
          message.payload as { requestId?: string; [k: string]: unknown }
        );
        sendResponse({ ok: true });
        return false;

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

      // ── Controle Metas CNJ (perfil Gestão) ────────────────────
      case MESSAGE_CHANNELS.METAS_OPEN_PAINEL:
        void handleOpenMetasPainel(
          message.payload as {
            tarefas: Array<{ nome: string; quantidade: number | null }>;
            hostnamePJe: string;
            abertoEm: string;
          },
          sender,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.METAS_START_COLETA:
        void handleMetasStartColeta(
          message.payload as {
            requestId: string;
            nomes: string[];
          },
          sendResponse
        );
        return true;

      case 'paidegua/metas/precisa-fetch':
        void handleMetasPrecisaFetch(
          message.payload as {
            numero_processo: string;
            ultimo_movimento_visto: string | null;
          },
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.METAS_UPSERT_PROCESSO:
        void handleMetasUpsertProcesso(
          message.payload as MetasPatchEnvelopeBg,
          sendResponse
        );
        return true;

      case MESSAGE_CHANNELS.METAS_COLETA_PROG:
      case MESSAGE_CHANNELS.METAS_COLETA_DONE:
      case MESSAGE_CHANNELS.METAS_COLETA_FAIL:
        void rotearEventoMetas(
          message.channel,
          message.payload as { requestId?: string; [k: string]: unknown }
        );
        sendResponse({ ok: true });
        return false;

      case MESSAGE_CHANNELS.METAS_APLICAR_ETIQUETAS:
        void handleMetasAplicarEtiquetas(
          message.payload as {
            etiquetaPauta: string;
            idsProcesso: number[];
            favoritarAposCriar?: boolean;
          },
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
      systemPrompt: payload.systemPromptOverride ?? SYSTEM_PROMPT,
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

/**
 * Abre a aba do "Consultor de fluxos". Sem state nem rota — a página
 * é autossuficiente: lê o catálogo embarcado, conversa via porta
 * CHAT_STREAM (mesma do chat normal) com `systemPromptOverride`.
 */
async function handleOpenFluxosConsultor(
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const url = chrome.runtime.getURL('fluxos-consultor/consultor.html');
    const tab = await chrome.tabs.create({ url });
    if (typeof tab.id !== 'number') {
      sendResponse({
        ok: false,
        error: 'Chrome não atribuiu ID à aba do Consultor de fluxos.'
      });
      return;
    }
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleOpenFluxosConsultor falhou:`, error);
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

function gerarCriminalRequestId(): string {
  return `criminal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Handler de abertura da aba do Sigcrim. Espelha
 * `handleOpenPericiasPainel`: grava `{ tarefas, config }` em
 * `chrome.storage.session` indexado por `requestId` e cria a aba
 * `criminal-painel/painel.html?rid=<requestId>`. Usa o mesmo `setRota`
 * do Painel Gerencial — o prefixo "criminal-" no requestId evita
 * colisão com outras features.
 */
async function handleOpenCriminalPainel(
  payload: {
    tarefas: Array<{ nome: string; quantidade: number | null }>;
    config: unknown;
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
        error: 'Não consegui identificar a aba do PJe que disparou Sigcrim.'
      });
      return;
    }
    if (!payload || !Array.isArray(payload.tarefas)) {
      sendResponse({
        ok: false,
        error: 'Payload de abertura do Sigcrim inválido.'
      });
      return;
    }

    const requestId = gerarCriminalRequestId();
    const stateKey =
      `${STORAGE_KEYS.CRIMINAL_PAINEL_STATE_PREFIX}${requestId}`;
    await chrome.storage.session.set({
      [stateKey]: {
        requestId,
        tarefas: payload.tarefas,
        config: payload.config ?? null,
        hostnamePJe: payload.hostnamePJe ?? '',
        abertoEm: payload.abertoEm ?? new Date().toISOString()
      }
    });

    const url =
      chrome.runtime.getURL('criminal-painel/painel.html') +
      `?rid=${encodeURIComponent(requestId)}`;
    const tab = await chrome.tabs.create({ url });
    if (typeof tab.id !== 'number') {
      await chrome.storage.session.remove(stateKey);
      sendResponse({
        ok: false,
        error: 'Chrome não atribuiu ID à aba do Sigcrim.'
      });
      return;
    }
    await setRota(requestId, { painelTabId: tab.id, pjeTabId });
    sendResponse({ ok: true, requestId });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleOpenCriminalPainel falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Painel → background: usuário confirmou seleção e clicou "Iniciar".
 * Background olha a rota gravada (qual aba PJe disparou o painel) e
 * dispatcha `CRIMINAL_RUN_COLETA` para o content script daquela aba.
 * Não bloqueia esperando a varredura terminar — eventos de progresso
 * vêm via canais separados (rotearEventoCriminal).
 */
async function handleCriminalStartColeta(
  payload: {
    requestId: string;
    nomesTarefas: string[];
    modo: 'rapido' | 'completo';
    config: unknown;
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload.requestId);
    if (!rota) {
      sendResponse({
        ok: false,
        error: 'Rota não encontrada — recarregue o painel a partir do Sigcrim.'
      });
      return;
    }
    // Fire-and-forget. O content responde via eventos próprios.
    chrome.tabs.sendMessage(rota.pjeTabId, {
      channel: MESSAGE_CHANNELS.CRIMINAL_RUN_COLETA,
      payload
    }).catch((err) => {
      console.warn(`${LOG_PREFIX} criminal: dispatch RUN_COLETA falhou:`, err);
      void rotearEventoCriminal(MESSAGE_CHANNELS.CRIMINAL_COLETA_FAIL, {
        requestId: payload.requestId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
    sendResponse({ ok: true });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleCriminalStartColeta falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Dashboard → background: enriquece UM réu via tela JSF de Pessoa
 * Física do PJe. O background:
 *
 *   1. Encontra uma aba PJe ativa (qualquer hostname `*.jus.br`).
 *   2. Dispatcha `CRIMINAL_FETCH_PESSOA_FISICA` para o content
 *      daquela aba — só ele tem cookies de sessão pra navegar a
 *      tela administrativa.
 *   3. Quando o content responde com os campos extraídos, persiste
 *      no IDB via `atualizarReu` (sem mexer nos demais réus do
 *      processo) e devolve o resultado para o dashboard.
 *
 * Se nenhuma aba PJe estiver aberta, devolve erro acionável para o
 * dashboard avisar o usuário ("abra uma aba do PJe e tente de novo").
 */
async function handleCriminalEnriquecerReu(
  payload: { reuId: string; cpf: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  // Trace passo-a-passo enviado de volta ao dashboard. Cada mudança
  // de estado é registrada para que o usuário veja exatamente o que
  // aconteceu no fluxo JSF (inclusive sucesso "vazio" — quando o
  // cadastro PJe existe mas não tem RG/mãe/endereço preenchidos).
  const trace: TraceEntry[] = [];
  const t0 = Date.now();
  const log = (
    etapa: string,
    status: TraceEntry['status'],
    info?: string
  ): void => {
    trace.push({ etapa, status, info, ts: Date.now() - t0 });
  };
  try {
    const reuId = payload.reuId;
    const cpf = payload.cpf;
    if (!reuId || !cpf) {
      log('validar-payload', 'falha', 'reuId ou cpf ausentes');
      sendResponse({ ok: false, error: 'Pedido inválido (reuId/cpf ausentes).', trace });
      return;
    }
    log('validar-payload', 'ok', `cpf=${cpf}`);

    // Procura uma aba PJe ativa.
    const tabs = await chrome.tabs.query({});
    const candidatas = tabs
      .filter((t) => {
        if (!t.id || !t.url) return false;
        try {
          const u = new URL(t.url);
          return /\.jus\.br$/i.test(u.hostname) && /^https?:$/.test(u.protocol);
        } catch {
          return false;
        }
      })
      .sort(
        (a, b) =>
          ((b as { lastAccessed?: number }).lastAccessed ?? 0) -
          ((a as { lastAccessed?: number }).lastAccessed ?? 0)
      );

    const tabPJe = candidatas[0];
    if (!tabPJe?.id) {
      log('encontrar-aba-pje', 'falha', 'nenhuma aba *.jus.br aberta');
      sendResponse({
        ok: false,
        error:
          'Nenhuma aba do PJe aberta. Abra qualquer processo no PJe e tente novamente.',
        trace
      });
      return;
    }
    log('encontrar-aba-pje', 'ok', `tab #${tabPJe.id}`);

    let resp: unknown;
    try {
      resp = await chrome.tabs.sendMessage(tabPJe.id, {
        channel: MESSAGE_CHANNELS.CRIMINAL_FETCH_PESSOA_FISICA,
        payload: { cpf }
      });
    } catch (err) {
      log(
        'fetch-pessoa-fisica',
        'falha',
        err instanceof Error ? err.message : String(err)
      );
      sendResponse({
        ok: false,
        error:
          'Não foi possível falar com a aba do PJe (' +
          (err instanceof Error ? err.message : String(err)) +
          '). Recarregue a aba do PJe e tente novamente.',
        trace
      });
      return;
    }

    const r = resp as
      | {
          ok: true;
          dados: {
            idPessoa: number;
            nome: string | null;
            cpf: string | null;
            rg: string | null;
            dataNascimento: string | null;
            nomeMae: string | null;
            endereco: string | null;
          };
        }
      | { ok: false; error: string };

    if (!r || r.ok !== true) {
      const err = r && r.ok === false ? r.error : 'Erro desconhecido no enriquecimento.';
      log('fetch-pessoa-fisica', 'falha', err);
      sendResponse({ ok: false, error: err, trace });
      return;
    }
    log(
      'fetch-pessoa-fisica',
      'ok',
      `idPessoa=${r.dados.idPessoa}, nome=${r.dados.nome ?? 'null'}, ` +
        `nasc=${r.dados.dataNascimento ?? 'null'}, rg=${r.dados.rg ?? 'null'}, ` +
        `mãe=${r.dados.nomeMae ? 'sim' : 'null'}, endereço=${r.dados.endereco ? 'sim' : 'null'}`
    );

    // Monta patch + carimba origem 'pje' para os campos preenchidos.
    const patch: Partial<Reu> = {
      id_pessoa_pje: r.dados.idPessoa
    };
    const origem: PjeOrigemMap = { id_pessoa_pje: 'pje' };
    const camposPreenchidos: string[] = ['id_pessoa_pje'];
    if (r.dados.dataNascimento) {
      patch.data_nascimento = r.dados.dataNascimento;
      origem.data_nascimento = 'pje';
      camposPreenchidos.push('data_nascimento');
    }
    if (r.dados.rg) {
      patch.rg = r.dados.rg;
      origem.rg = 'pje';
      camposPreenchidos.push('rg');
    }
    if (r.dados.nomeMae) {
      patch.nome_mae = r.dados.nomeMae;
      origem.nome_mae = 'pje';
      camposPreenchidos.push('nome_mae');
    }
    if (r.dados.endereco) {
      patch.endereco = r.dados.endereco;
      origem.endereco = 'pje';
      camposPreenchidos.push('endereco');
    }

    if (camposPreenchidos.length === 1) {
      // Só o id_pessoa_pje veio — os demais estão vazios no cadastro.
      log(
        'gravar-idb',
        'aviso',
        'cadastro PJe encontrado mas sem dados preenchidos (apenas idPessoa)'
      );
    }

    const atualizado = await atualizarReu(reuId, patch, origem);
    if (!atualizado) {
      log('gravar-idb', 'falha', `réu ${reuId} sumiu do IDB`);
      sendResponse({
        ok: false,
        error: `Réu ${reuId} não encontrado no IDB.`,
        trace
      });
      return;
    }
    if (camposPreenchidos.length > 1) {
      log('gravar-idb', 'ok', `${camposPreenchidos.join(', ')}`);
    }

    sendResponse({ ok: true, reu: atualizado, trace });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleCriminalEnriquecerReu falhou:`, error);
    log('exception', 'falha', errorMessage(error));
    sendResponse({ ok: false, error: errorMessage(error), trace });
  }
}

/**
 * Reprocessamento sob demanda de um processo já capturado. O dashboard
 * dispara um clique e o background:
 *
 *   1. Lê `id_processo_pje` + `hostname_pje` do IDB.
 *   2. Pede `chaveAcesso` (`ca`) à aba PJe ativa via `CRIMINAL_FETCH_CA`.
 *   3. Abre uma aba **inativa** (background) com a URL dos autos digitais
 *      e a `ca` fresca. A aba carrega o DOM vivo, o que permite ao
 *      content ativar links de documentos via clique — passo crítico
 *      para o PJe legacy entregar os bytes do PDF (fetch direto retorna
 *      0 bytes até que alguém clique).
 *   4. Aguarda `tabs.onUpdated` com `status === 'complete'`.
 *   5. Manda `CRIMINAL_EXTRAIR_NA_ABA` para essa aba — o handler já
 *      existente extrai partes/movimentos/detalhes/documentos, ativa
 *      cada PDF principal, lê o conteúdo e chama IA.
 *   6. Fecha a aba.
 *   7. Aplica os campos extraídos pela IA com origem `'ia'`,
 *      preservando edições manuais e dados do PJe que não estão na IA.
 *   8. Devolve o processo atualizado.
 *
 * Em paralelo a este reprocessamento (orquestrado pelo dashboard),
 * o JSF Pessoa Física continua sendo chamado por réu via
 * `CRIMINAL_ENRIQUECER_REU` — fluxos independentes, marcam origens
 * diferentes (`pje` para JSF, `ia` para PDF→IA).
 */
/**
 * Aplica `dadosIA` extraídos por IA num processo já carregado do IDB,
 * gravando com origem `'ia'` apenas nos campos que não tenham sido
 * marcados como `'manual'` pelo usuário. Compartilhado entre o
 * reprocessamento automático (`handleCriminalReprocessarProcesso`) e
 * o upload manual de PDF (`handleCriminalProcessarPdfManual`).
 *
 * Para réus em processos multi-réu, o mesmo dado vai para todos —
 * a IA não individualiza réus a partir do texto. Caso especial:
 * `cpf_reu` / `data_nascimento` / `numero_seeu` só preenchem se o réu
 * estiver vazio no campo (evita sobrescrever dados específicos por
 * réu já capturados pelo PJe).
 */
async function aplicarDadosIaNoProcesso(
  proc: Processo,
  dadosIA: DadosPdfExtraidos,
  log: (etapa: string, status: TraceEntry['status'], info?: string) => void
): Promise<void> {
  // PROCESSO
  const patchProc: Partial<ProcessoPayload> = {};
  const origemProc: PjeOrigemMap = {};
  const origAtual = proc.pje_origem ?? {};

  if (dadosIA.tipo_crime && origAtual.tipo_crime !== 'manual') {
    patchProc.tipo_crime = dadosIA.tipo_crime;
    origemProc.tipo_crime = 'ia';
  }
  if (dadosIA.data_fato && origAtual.data_fato !== 'manual') {
    patchProc.data_fato = dadosIA.data_fato;
    origemProc.data_fato = 'ia';
  }
  if (
    dadosIA.data_recebimento_denuncia &&
    origAtual.data_recebimento_denuncia !== 'manual'
  ) {
    patchProc.data_recebimento_denuncia = dadosIA.data_recebimento_denuncia;
    origemProc.data_recebimento_denuncia = 'ia';
  }
  if (Object.keys(patchProc).length > 0) {
    await atualizarProcesso(proc.id, patchProc);
    const novaOrigem: PjeOrigemMap = { ...origAtual, ...origemProc };
    await aplicarOrigemProcesso(proc.id, novaOrigem);
    log(
      'gravar-processo',
      'ok',
      `${Object.keys(patchProc).length} campo(s): ${Object.keys(patchProc).join(', ')}`
    );
  } else {
    log(
      'gravar-processo',
      'aviso',
      'nenhum campo da IA passou pelos filtros (todos null ou já manuais)'
    );
  }

  // RÉUS
  for (const reu of proc.reus) {
    const patchReu: Partial<Reu> = {};
    const origemReu: PjeOrigemMap = {};
    const origAtualReu = reu.pje_origem ?? {};

    if (
      dadosIA.cpf_reu &&
      !reu.cpf_reu &&
      origAtualReu.cpf_reu !== 'manual'
    ) {
      patchReu.cpf_reu = dadosIA.cpf_reu;
      origemReu.cpf_reu = 'ia';
    }
    if (
      dadosIA.data_nascimento &&
      !reu.data_nascimento &&
      origAtualReu.data_nascimento !== 'manual'
    ) {
      patchReu.data_nascimento = dadosIA.data_nascimento;
      origemReu.data_nascimento = 'ia';
    }
    if (
      dadosIA.data_sentenca &&
      origAtualReu.data_sentenca !== 'manual'
    ) {
      patchReu.data_sentenca = dadosIA.data_sentenca;
      origemReu.data_sentenca = 'ia';
    }
    if (
      dadosIA.pena_aplicada_concreto != null &&
      origAtualReu.pena_aplicada_concreto !== 'manual'
    ) {
      patchReu.pena_aplicada_concreto = dadosIA.pena_aplicada_concreto;
      origemReu.pena_aplicada_concreto = 'ia';
    }
    if (
      dadosIA.suspenso_366 === true &&
      origAtualReu.suspenso_366 !== 'manual'
    ) {
      patchReu.suspenso_366 = true;
      origemReu.suspenso_366 = 'ia';
      if (dadosIA.data_inicio_suspensao) {
        patchReu.data_inicio_suspensao = dadosIA.data_inicio_suspensao;
        origemReu.data_inicio_suspensao = 'ia';
      }
      if (dadosIA.data_fim_suspensao) {
        patchReu.data_fim_suspensao = dadosIA.data_fim_suspensao;
        origemReu.data_fim_suspensao = 'ia';
      }
    }
    if (
      dadosIA.status_anpp &&
      dadosIA.status_anpp !== 'Nao Aplicavel' &&
      origAtualReu.status_anpp !== 'manual'
    ) {
      patchReu.status_anpp = dadosIA.status_anpp;
      origemReu.status_anpp = 'ia';
    }
    if (
      dadosIA.data_homologacao_anpp &&
      origAtualReu.data_homologacao_anpp !== 'manual'
    ) {
      patchReu.data_homologacao_anpp = dadosIA.data_homologacao_anpp;
      origemReu.data_homologacao_anpp = 'ia';
    }
    if (
      dadosIA.data_remessa_mpf &&
      origAtualReu.data_remessa_mpf !== 'manual'
    ) {
      patchReu.data_remessa_mpf = dadosIA.data_remessa_mpf;
      origemReu.data_remessa_mpf = 'ia';
    }
    if (
      dadosIA.data_protocolo_seeu &&
      origAtualReu.data_protocolo_seeu !== 'manual'
    ) {
      patchReu.data_protocolo_seeu = dadosIA.data_protocolo_seeu;
      origemReu.data_protocolo_seeu = 'ia';
    }
    if (
      dadosIA.numero_seeu &&
      !reu.numero_seeu &&
      origAtualReu.numero_seeu !== 'manual'
    ) {
      patchReu.numero_seeu = dadosIA.numero_seeu;
      origemReu.numero_seeu = 'ia';
    }
    if (Object.keys(patchReu).length > 0) {
      await atualizarReu(reu.id, patchReu, origemReu);
      log(
        `gravar-reu-${reu.id.slice(0, 8)}`,
        'ok',
        `${Object.keys(patchReu).length} campo(s): ${Object.keys(patchReu).join(', ')}`
      );
    }
  }
}

async function handleCriminalReprocessarProcesso(
  payload: { processoId: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  let abaCriada: number | null = null;
  let janelaCriada: number | null = null;
  const trace: TraceEntry[] = [];
  const t0 = Date.now();
  const log = (
    etapa: string,
    status: TraceEntry['status'],
    info?: string
  ): void => {
    trace.push({ etapa, status, info, ts: Date.now() - t0 });
    // Mantém o log no console do SW pra debug, mas a fonte de verdade
    // visível ao usuário é o `trace[]` retornado.
    console.log(`${LOG_PREFIX} reprocessar [${etapa}] ${status}${info ? ': ' + info : ''}`);
  };
  try {
    log('inicio', 'info', `processoId=${payload.processoId}`);
    const proc = await getProcessoById(payload.processoId);
    if (!proc) {
      sendResponse({ ok: false, error: 'Processo não encontrado no acervo.' });
      return;
    }
    if (!proc.id_processo_pje) {
      sendResponse({
        ok: false,
        error:
          'Processo sem `id_processo_pje` no acervo — refaça a varredura ' +
          'para capturar o ID do PJe e tente novamente.'
      });
      return;
    }
    if (!proc.hostname_pje) {
      sendResponse({
        ok: false,
        error:
          'Hostname do PJe não conhecido para este processo. Refaça a ' +
          'varredura para capturar.'
      });
      return;
    }

    // 1. Encontra uma aba PJe ativa para gerar `ca`.
    const tabs = await chrome.tabs.query({});
    const tabPJe = tabs
      .filter((t) => {
        if (!t.id || !t.url) return false;
        try {
          const u = new URL(t.url);
          return /\.jus\.br$/i.test(u.hostname) && /^https?:$/.test(u.protocol);
        } catch {
          return false;
        }
      })
      .sort(
        (a, b) =>
          ((b as { lastAccessed?: number }).lastAccessed ?? 0) -
          ((a as { lastAccessed?: number }).lastAccessed ?? 0)
      )[0];

    if (!tabPJe?.id) {
      sendResponse({
        ok: false,
        error:
          'Nenhuma aba do PJe aberta. Abra qualquer processo no PJe e ' +
          'tente novamente.'
      });
      return;
    }

    // 2. Pede `ca` para o content da aba PJe.
    const respCa = (await chrome.tabs.sendMessage(tabPJe.id, {
      channel: MESSAGE_CHANNELS.CRIMINAL_FETCH_CA,
      payload: { idProcesso: proc.id_processo_pje }
    })) as { ok: boolean; ca?: string; error?: string };

    if (!respCa?.ok || !respCa.ca) {
      log('gerar-ca', 'falha', respCa?.error ?? 'sem ca');
      sendResponse({
        ok: false,
        error: `Falha ao gerar chave de acesso: ${respCa?.error ?? 'sem detalhes'}.`,
        trace
      });
      return;
    }
    log('gerar-ca', 'ok', `len=${respCa.ca.length}`);

    // 3. Abre janela popup SEM FOCO. Histórico de tentativas:
    //    - `state: 'minimized'`: Chrome rejeita ('Invalid value for state')
    //      quando combinado com width/height; sem dimensões pausa o JS
    //      do Angular do PJe (árvore de documentos não monta).
    //    - `top: -2000` (offscreen): Chrome rejeita com "Bounds must be
    //      at least 50% within visible screen space".
    //    Solução: deixar o Chrome decidir a posição (sem top/left),
    //    `focused: false` para não roubar foco. A janela aparece
    //    visivelmente por ~30s, mas não interrompe o trabalho do
    //    usuário. Custo aceitável em troca da garantia de execução.
    const url =
      `https://${proc.hostname_pje}` +
      `/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam` +
      `?idProcesso=${proc.id_processo_pje}&ca=${encodeURIComponent(respCa.ca)}`;

    log('abrir-janela', 'info', `popup sem foco, url=${url.slice(0, 80)}…`);
    const novaJanela = await chrome.windows.create({
      url,
      focused: false,
      type: 'popup',
      width: 1024,
      height: 768
    });
    janelaCriada = novaJanela.id ?? null;
    abaCriada = novaJanela.tabs?.[0]?.id ?? null;
    if (!abaCriada) {
      log('abrir-janela', 'falha', 'Chrome não atribuiu ID');
      sendResponse({
        ok: false,
        error: 'Chrome não atribuiu ID à aba da janela auxiliar.',
        trace
      });
      return;
    }
    log('abrir-janela', 'ok', `janela=${janelaCriada}, aba=${abaCriada}`);

    // 4. Aguarda load completo da aba.
    await aguardarTabComplete(abaCriada, 30_000);
    log('aguardar-load', 'ok', 'tab.status=complete + 1.5s espera');

    // 5. Manda CRIMINAL_EXTRAIR_NA_ABA — handler existente extrai,
    //    ativa PDFs e chama IA. Trace dele é mesclado no nosso.
    // Capturado ANTES do await: ms desde o início do handler quando
    // a mensagem foi emitida. Usado para deslocar os timestamps
    // relativos do trace do content na timeline final.
    const offsetAba = Date.now() - t0;
    const respExt = (await chrome.tabs.sendMessage(abaCriada, {
      channel: MESSAGE_CHANNELS.CRIMINAL_EXTRAIR_NA_ABA,
      payload: { runIA: true }
    })) as {
      ok: boolean;
      dadosIA?: DadosPdfExtraidos | null;
      dadosIAFontes?: unknown[];
      documentosPrincipais?: unknown[];
      detalhes?: { classeCnj?: number | null; assunto?: string | null } | null;
      trace?: TraceEntry[];
      error?: string;
    };
    // Mescla trace do content preservando timestamps relativos.
    if (respExt?.trace && Array.isArray(respExt.trace)) {
      // O `respExt.trace[0].ts` ≈ 0 (início do handler do content).
      // Subtrai esse base pra normalizar antes de somar o offset.
      const baseAba = respExt.trace[0]?.ts ?? 0;
      for (const t of respExt.trace) {
        trace.push({
          ...t,
          etapa: `aba.${t.etapa}`,
          ts: offsetAba + ((t.ts ?? 0) - baseAba)
        });
      }
    }

    if (!respExt?.ok) {
      log('extrair-na-aba', 'falha', respExt?.error ?? 'sem detalhes');
      sendResponse({
        ok: false,
        error: `Falha na extração: ${respExt?.error ?? 'sem detalhes'}.`,
        trace
      });
      return;
    }
    log(
      'extrair-na-aba',
      'ok',
      `principais=${respExt.documentosPrincipais?.length ?? 0}, ` +
        `fontesIA=${respExt.dadosIAFontes?.length ?? 0}`
    );

    const dadosIA = respExt.dadosIA ?? null;
    if (!dadosIA) {
      const principais = respExt.documentosPrincipais?.length ?? 0;
      log(
        'analisar-ia',
        'aviso',
        principais === 0
          ? 'nenhum documento principal identificado'
          : `${principais} doc(s) principal(is) mas IA retornou vazio (stub?)`
      );
      sendResponse({
        ok: false,
        error:
          principais === 0
            ? 'Nenhum documento principal (denúncia/sentença/ANPP) identificado nos autos.'
            : 'IA não retornou dados — provavelmente os PDFs principais ' +
              'vieram vazios ou stub. Verifique se a chave de acesso ainda ' +
              'é válida e se há aba do PJe ativa.',
        trace
      });
      return;
    }
    log('analisar-ia', 'ok', 'dadosIA consolidado disponível');

    // 6. Aplica patches no IDB com origem 'ia'.
    if (dadosIA) {
      await aplicarDadosIaNoProcesso(proc, dadosIA, log);
    }

    const atualizado = await getProcessoById(proc.id);
    log('concluido', 'ok', `total=${Date.now() - t0}ms`);
    sendResponse({ ok: true, processo: atualizado, dadosIA, trace });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleCriminalReprocessarProcesso falhou:`, error);
    log('exception', 'falha', errorMessage(error));
    sendResponse({ ok: false, error: errorMessage(error), trace });
  } finally {
    // 7. Sempre fecha a JANELA auxiliar inteira (a aba sai junto),
    //    mesmo em caso de erro, para não deixar lixo. Se só a janela
    //    falhou em criar mas a aba existir solta (improvável), tenta
    //    remover a aba como fallback.
    if (janelaCriada !== null) {
      try {
        await chrome.windows.remove(janelaCriada);
      } catch (err) {
        console.warn(`${LOG_PREFIX} reprocessar: falha fechando janela:`, err);
      }
    } else if (abaCriada !== null) {
      try {
        await chrome.tabs.remove(abaCriada);
      } catch (err) {
        console.warn(`${LOG_PREFIX} reprocessar: falha fechando aba:`, err);
      }
    }
  }
}

/**
 * Espera uma aba terminar de carregar (status === 'complete') ou um
 * timeout. Resolve mesmo quando o timer estoura — o caller decide se
 * tenta usar a aba mesmo assim.
 */
function aguardarTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  // CRÍTICO: service worker (MV3 background) não tem `window`. Usamos
  // os globals `setTimeout`/`clearTimeout` que existem em todos os
  // contextos JS (worker + page). Tipos vêm de `@types/chrome` /
  // lib.dom.d.ts.
  return new Promise((resolve) => {
    let resolvido = false;
    let timer: number | undefined;
    const finish = (): void => {
      if (resolvido) return;
      resolvido = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const listener = (
      updatedId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ): void => {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        // Pequena espera adicional para JS da página inicializar
        // (o `complete` do Chrome dispara antes do JSF terminar de
        // montar a árvore de documentos).
        setTimeout(finish, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(finish, timeoutMs) as unknown as number;
  });
}

/**
 * Edição manual de um processo a partir do dashboard. Aplica `patch`
 * em `criminal-store` e carimba `manual` em `pje_origem` apenas nos
 * campos que vêm no patch — preservando a origem dos demais.
 */
async function handleCriminalAtualizarProcesso(
  payload: { processoId: string; patch: Partial<ProcessoPayload> },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const { processoId, patch } = payload;
    if (!processoId || !patch || typeof patch !== 'object') {
      sendResponse({ ok: false, error: 'Pedido inválido.' });
      return;
    }
    const proc = await atualizarProcesso(processoId, patch);
    // Carimba origem manual nos campos que vieram no patch.
    const novaOrigem: PjeOrigemMap = { ...proc.pje_origem };
    for (const k of Object.keys(patch)) {
      novaOrigem[k] = 'manual';
    }
    // Persiste a origem atualizada via novo patch vazio (atualizarProcesso
    // não toca pje_origem). Reaproveitando upsert seria custoso; em vez
    // disso, manipulamos o registro via store já que pje_origem não é
    // ProcessoPayload — mantemos o helper inline aqui.
    // Como atualizarProcesso já gravou o resto, basta carregar e regravar
    // só com origem nova.
    if (Object.keys(patch).length > 0) {
      await aplicarOrigemProcesso(processoId, novaOrigem);
    }
    const atualizado = await getProcessoById(processoId);
    sendResponse({ ok: true, processo: atualizado });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleCriminalAtualizarProcesso falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Helper: regrava `pje_origem` de um processo sem mexer nos demais
 * campos. Usado pelo handler de edição manual.
 */
async function aplicarOrigemProcesso(
  processoId: string,
  novaOrigem: PjeOrigemMap
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(CRIMINAL_DB_NAME, CRIMINAL_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction([CRIMINAL_STORES.PROCESSOS], 'readwrite');
      const store = tx.objectStore(CRIMINAL_STORES.PROCESSOS);
      const get = store.get(processoId);
      get.onsuccess = () => {
        const cur = get.result;
        if (!cur) {
          tx.abort();
          reject(new Error(`Processo ${processoId} não encontrado.`));
          return;
        }
        cur.pje_origem = novaOrigem;
        cur.atualizado_em = new Date().toISOString();
        store.put(cur);
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

/**
 * Edição manual de um réu pelo dashboard. Carimba `manual` em
 * `pje_origem` para cada campo do patch.
 */
async function handleCriminalAtualizarReu(
  payload: { reuId: string; patch: Partial<Reu> },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const { reuId, patch } = payload;
    if (!reuId || !patch || typeof patch !== 'object') {
      sendResponse({ ok: false, error: 'Pedido inválido.' });
      return;
    }
    const origemPatch: PjeOrigemMap = {};
    for (const k of Object.keys(patch)) {
      origemPatch[k] = 'manual';
    }
    const atualizado = await atualizarReu(reuId, patch, origemPatch);
    if (!atualizado) {
      sendResponse({ ok: false, error: `Réu ${reuId} não encontrado.` });
      return;
    }
    sendResponse({ ok: true, reu: atualizado });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleCriminalAtualizarReu falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Content (aba PJe) → background: cada processo capturado vem aqui com
 * o `ProcessoCapturado` completo. O background:
 *
 *   1. Persiste no IndexedDB da extensão via `upsertProcessoFromPje`
 *      (CRÍTICO — content scripts abrem IDB no origin do PJe; só o
 *      background tem acesso ao IDB do origin chrome-extension://).
 *   2. Roteia uma versão SLIM (apenas numero + nReus + warnings) para
 *      o painel atualizar a UI sem trafegar o objeto completo.
 *   3. Em caso de erro de upsert, ainda assim roteia pro painel para
 *      a UI registrar a tentativa.
 */
async function handleCriminalColetaSlot(payload: {
  requestId: string;
  capturado: {
    payload: ProcessoPayload;
    reus: ReuPayload[];
    pje_origem: PjeOrigemMap;
    reusOrigem: PjeOrigemMap[];
    ultima_sincronizacao_pje: string;
    warnings: string[];
  };
}): Promise<void> {
  const { requestId, capturado } = payload;
  if (!requestId || !capturado) {
    console.warn(`${LOG_PREFIX} criminal: SLOT sem requestId ou capturado`);
    return;
  }
  let upsertOk = true;
  let upsertError: string | null = null;
  try {
    await upsertProcessoFromPje(capturado.payload, capturado.reus, {
      pje_origem: capturado.pje_origem,
      reus_origem: capturado.reusOrigem,
      ultima_sincronizacao_pje: capturado.ultima_sincronizacao_pje
    });
  } catch (err) {
    upsertOk = false;
    upsertError = err instanceof Error ? err.message : String(err);
    console.warn(
      `${LOG_PREFIX} criminal: upsert falhou para ` +
        `${capturado.payload.numero_processo}:`,
      err
    );
  }
  // Roteia versão slim pro painel (sempre, mesmo em erro de upsert).
  await rotearEventoCriminal(MESSAGE_CHANNELS.CRIMINAL_COLETA_SLOT, {
    requestId,
    numero: capturado.payload.numero_processo,
    nReus: capturado.reus.length,
    warnings: capturado.warnings,
    upsertOk,
    upsertError
  });
}

/**
 * Content (aba PJe) → background → aba-painel. Recebe evento de
 * progresso/slot/done/fail com o `requestId` no payload, localiza a
 * `painelTabId` e repassa via `tabs.sendMessage`.
 */
async function rotearEventoCriminal(
  channel: string,
  payload: { requestId?: string; [k: string]: unknown }
): Promise<void> {
  const requestId = payload?.requestId;
  if (typeof requestId !== 'string' || !requestId) {
    console.warn(`${LOG_PREFIX} criminal: evento ${channel} sem requestId`);
    return;
  }
  try {
    const rota = await getRota(requestId);
    if (!rota) {
      console.warn(
        `${LOG_PREFIX} criminal: rota ausente para ${requestId} ao rotear ${channel}`
      );
      return;
    }
    chrome.tabs
      .sendMessage(rota.painelTabId, { channel, payload })
      .catch((err) => {
        // Painel pode ter sido fechado — não é fatal
        console.debug(
          `${LOG_PREFIX} criminal: rota ${channel} → painel falhou (aba fechada?):`,
          err
        );
      });
  } catch (err) {
    console.warn(`${LOG_PREFIX} criminal: rotearEvento falhou:`, err);
  }
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

// =====================================================================
// Central de Comunicação (perfil Secretaria)
// =====================================================================

function gerarComunicacaoRequestId(): string {
  return `comunicacao-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function gerarAudienciaRequestId(): string {
  return `audiencia-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function handleOpenComunicacaoPainel(
  payload: {
    peritos: PericiaPerito[];
    settings: ComunicacaoSettings;
    hostnamePJe: string;
    legacyOrigin: string;
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
        error: 'Não consegui identificar a aba do PJe que disparou a Central de Comunicação.'
      });
      return;
    }
    if (!payload || !payload.settings) {
      sendResponse({ ok: false, error: 'Payload inválido.' });
      return;
    }
    const requestId = gerarComunicacaoRequestId();
    const stateKey =
      `${STORAGE_KEYS.COMUNICACAO_PAINEL_STATE_PREFIX}${requestId}`;
    await chrome.storage.session.set({
      [stateKey]: {
        requestId,
        peritos: Array.isArray(payload.peritos) ? payload.peritos : [],
        settings: payload.settings,
        hostnamePJe: payload.hostnamePJe ?? '',
        legacyOrigin: payload.legacyOrigin ?? '',
        abertoEm: payload.abertoEm ?? new Date().toISOString()
      }
    });
    const url =
      chrome.runtime.getURL('comunicacao-painel/painel.html') +
      `?rid=${encodeURIComponent(requestId)}`;
    const tab = await chrome.tabs.create({ url });
    if (typeof tab.id !== 'number') {
      await chrome.storage.session.remove(stateKey);
      sendResponse({
        ok: false,
        error: 'Chrome não atribuiu ID à aba da Central de Comunicação.'
      });
      return;
    }
    await setRota(requestId, { painelTabId: tab.id, pjeTabId });
    sendResponse({ ok: true, requestId });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleOpenComunicacaoPainel falhou:`, err);
    sendResponse({ ok: false, error: errorMessage(err) });
  }
}

async function handleComunicacaoRunColeta(
  payload: {
    requestId: string;
    modo: 'cobrar-perito-whatsapp' | 'cobrar-ceab-email';
    filtro: 'tarefa' | 'etiqueta';
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!payload || !payload.requestId || !payload.modo || !payload.filtro) {
      sendResponse({ ok: false, error: 'Payload inválido.' });
      return;
    }
    const rota = await getRota(payload.requestId);
    if (!rota) {
      sendResponse({
        ok: false,
        error:
          'Sessão da Central de Comunicação expirou. Volte ao PJe e abra a feature novamente.'
      });
      return;
    }
    // Lê o snapshot do state para entregar ao content (peritos + settings).
    const stateKey =
      `${STORAGE_KEYS.COMUNICACAO_PAINEL_STATE_PREFIX}${payload.requestId}`;
    const snap = await chrome.storage.session.get(stateKey);
    const state = snap[stateKey] as
      | {
          peritos: PericiaPerito[];
          settings: ComunicacaoSettings;
        }
      | undefined;
    if (!state) {
      sendResponse({
        ok: false,
        error: 'Estado da Central de Comunicação não encontrado.'
      });
      return;
    }
    const resp = await chrome.tabs.sendMessage(rota.pjeTabId, {
      channel: MESSAGE_CHANNELS.COMUNICACAO_RUN_COLETA,
      payload: {
        modo: payload.modo,
        filtro: payload.filtro,
        peritos: state.peritos,
        settings: state.settings
      }
    });
    sendResponse(resp ?? { ok: false, error: 'Aba do PJe não respondeu.' });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleComunicacaoRunColeta falhou:`, err);
    sendResponse({
      ok: false,
      error:
        'Falha ao contactar a aba do PJe: ' +
        errorMessage(err) +
        '. Verifique se a aba original ainda está aberta.'
    });
  }
}

async function handleComunicacaoRegistrarCobranca(
  payload: Omit<RegistroCobranca, 'id' | 'geradoEm'>,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (
      !payload ||
      !payload.modo ||
      !payload.destinatario ||
      !Array.isArray(payload.numerosProcesso)
    ) {
      sendResponse({ ok: false, error: 'Payload de registro inválido.' });
      return;
    }
    const reg = await addComunicacaoRegistro(payload);
    sendResponse({ ok: true, registro: reg });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleComunicacaoRegistrarCobranca falhou:`, err);
    sendResponse({ ok: false, error: errorMessage(err) });
  }
}

// =====================================================================
// Audiência pAIdegua (perfil Secretaria)
// =====================================================================

async function handleOpenAudienciaPainel(
  payload: {
    tarefas: AudienciaTarefaInfo[];
    hostnamePJe: string;
    legacyOrigin: string;
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
        error: 'Não consegui identificar a aba do PJe que disparou a Audiência pAIdegua.'
      });
      return;
    }
    if (!payload || !Array.isArray(payload.tarefas)) {
      sendResponse({ ok: false, error: 'Payload inválido.' });
      return;
    }
    const requestId = gerarAudienciaRequestId();
    const stateKey =
      `${STORAGE_KEYS.AUDIENCIA_PAINEL_STATE_PREFIX}${requestId}`;
    await chrome.storage.session.set({
      [stateKey]: {
        requestId,
        tarefas: payload.tarefas,
        hostnamePJe: payload.hostnamePJe ?? '',
        legacyOrigin: payload.legacyOrigin ?? '',
        abertoEm: payload.abertoEm ?? new Date().toISOString()
      }
    });
    const url =
      chrome.runtime.getURL('audiencia-painel/painel.html') +
      `?rid=${encodeURIComponent(requestId)}`;
    const tab = await chrome.tabs.create({ url });
    if (typeof tab.id !== 'number') {
      await chrome.storage.session.remove(stateKey);
      sendResponse({
        ok: false,
        error: 'Chrome não atribuiu ID à aba da Audiência pAIdegua.'
      });
      return;
    }
    await setRota(requestId, { painelTabId: tab.id, pjeTabId });
    sendResponse({ ok: true, requestId });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleOpenAudienciaPainel falhou:`, err);
    sendResponse({ ok: false, error: errorMessage(err) });
  }
}

async function handleAudienciaRunColeta(
  payload: {
    requestId: string;
    nomesTarefas: string[];
    quantidadePorPauta: number;
    dataAudienciaISO: string;
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!payload || !payload.requestId || !Array.isArray(payload.nomesTarefas)) {
      sendResponse({ ok: false, error: 'Payload inválido.' });
      return;
    }
    const rota = await getRota(payload.requestId);
    if (!rota) {
      sendResponse({
        ok: false,
        error:
          'Sessão da Audiência pAIdegua expirou. Volte ao PJe e abra a feature novamente.'
      });
      return;
    }
    const resp = await chrome.tabs.sendMessage(rota.pjeTabId, {
      channel: MESSAGE_CHANNELS.AUDIENCIA_RUN_COLETA,
      payload: {
        nomesTarefas: payload.nomesTarefas,
        quantidadePorPauta: payload.quantidadePorPauta,
        dataAudienciaISO: payload.dataAudienciaISO
      }
    });
    sendResponse(resp ?? { ok: false, error: 'Aba do PJe não respondeu.' });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleAudienciaRunColeta falhou:`, err);
    sendResponse({
      ok: false,
      error:
        'Falha ao contactar a aba do PJe: ' +
        errorMessage(err) +
        '. Verifique se a aba original ainda está aberta.'
    });
  }
}

async function handleAudienciaAplicarEtiquetas(
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
          'Nenhuma aba do PJe aberta. Abra o painel do PJe em uma aba antes de aplicar etiquetas.'
      });
      return;
    }
    const tab = tabs[0];
    const resp = await chrome.tabs.sendMessage(tab.id!, {
      channel: MESSAGE_CHANNELS.AUDIENCIA_APLICAR_ETIQUETAS,
      payload
    });
    sendResponse(resp ?? { ok: false, error: 'Aba do PJe não respondeu.' });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleAudienciaAplicarEtiquetas falhou:`, err);
    sendResponse({ ok: false, error: errorMessage(err) });
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
// Gestão Criminal — coleta de partes + movimentos via DOM scraping
// =====================================================================

/**
 * Coleta de UM processo criminal: abre `listAutosDigitais.seam` em aba
 * inativa, aguarda render, dispara `CRIMINAL_EXTRAIR_NA_ABA` para o
 * content script da nova aba (que faz o scraping do DOM via
 * `criminal-extractor.ts`) e fecha a aba ao final.
 *
 * Espelha o pattern de `handlePrazosFitaColetarProcesso` — diferenças:
 *   - Canal de extração distinto (`CRIMINAL_EXTRAIR_NA_ABA`).
 *   - Resposta carrega `partes` + `movimentos` em vez de expedientes.
 *   - Sem `idTaskInstance` no fluxo (não estamos dentro de uma tarefa).
 */
async function handleCriminalColetarProcesso(
  payload: {
    url: string;
    idProcesso?: number;
    timeoutMs?: number;
    runIA?: boolean;
  },
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
        channel: MESSAGE_CHANNELS.CRIMINAL_EXTRAIR_NA_ABA,
        payload: {
          idProcesso: payload.idProcesso ?? null,
          runIA: payload.runIA !== false
        }
      },
      { attempts: 12, intervalMs: 500 }
    );

    if (!resp || resp.ok === false) {
      sendResponse({
        ok: false,
        url,
        numeroProcesso: resp?.numeroProcesso ?? null,
        error: resp?.error ?? 'Content script não respondeu ao CRIMINAL_EXTRAIR_NA_ABA.',
        duracaoMs: Date.now() - inicio
      });
      return;
    }

    sendResponse({
      ok: true,
      url,
      numeroProcesso: resp.numeroProcesso ?? null,
      partes: resp.partes ?? [],
      movimentos: resp.movimentos ?? [],
      detalhes: resp.detalhes ?? null,
      documentos: resp.documentos ?? [],
      documentosPrincipais: resp.documentosPrincipais ?? [],
      dadosIA: resp.dadosIA ?? null,
      dadosIAFontes: resp.dadosIAFontes ?? [],
      diagnostic: resp.diagnostic,
      duracaoMs: Date.now() - inicio
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleCriminalColetarProcesso:`, err);
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
// Gestão Criminal — extração estruturada de UM PDF via IA
// =====================================================================

/**
 * Recebe o texto de um PDF (já extraído pelo `extractContents` da camada
 * de content) e devolve o `DadosPdfExtraidos` parseado pelo provider de
 * IA ativo. Caller decide o que fazer com o resultado (mesclar entre
 * múltiplos PDFs do mesmo processo, etc.).
 *
 * Reusa a infra existente: `getSettings`, `getApiKey`, `getProvider`,
 * `provider.sendMessage` — exatamente como `handleAnonymizeNames` faz.
 */
/**
 * Chama a IA com o texto de um PDF criminal e devolve `DadosPdfExtraidos`.
 * Compartilhada entre `CRIMINAL_AI_EXTRAIR_PDF` (usado pelo content
 * durante varredura/reprocessamento automático) e
 * `CRIMINAL_PROCESSAR_PDF_MANUAL` (upload manual pelo dashboard).
 *
 * Retorna `{ ok, dadosIA, providerId, raw? }`. Em caso de falha, `raw`
 * traz os primeiros 500 chars da resposta crua para debug.
 */
async function extrairDadosPdfComIa(
  texto: string,
  tipoDocumento?: string
): Promise<
  | { ok: true; dadosIA: DadosPdfExtraidos; providerId: string }
  | { ok: false; error: string; raw?: string }
> {
  const t = (texto ?? '').trim();
  if (!t) return { ok: false, error: 'Texto vazio.' };

  const settings = await getSettings();
  const providerId = settings.activeProvider;
  const apiKey = await getApiKey(providerId);
  if (!apiKey) {
    return { ok: false, error: `API key não cadastrada para ${providerId}.` };
  }
  const provider = getProvider(providerId);

  const trecho = t.slice(0, MAX_CHARS_PARA_IA);
  const tipoDoc = (tipoDocumento ?? '').trim();
  const userMsg =
    (tipoDoc ? `Tipo do documento: ${tipoDoc}\n\n` : '') +
    `TEXTO DO DOCUMENTO:\n${trecho}`;

  const controller = new AbortController();
  const generator = provider.sendMessage({
    apiKey,
    model: settings.models[providerId],
    systemPrompt: PROMPT_SISTEMA_DADOS_PDF,
    messages: [{ role: 'user', content: userMsg, timestamp: Date.now() }],
    temperature: 0.05,
    maxTokens: 2048,
    signal: controller.signal
  });

  let raw = '';
  for await (const chunk of generator) {
    raw += chunk.delta;
  }

  raw = raw.trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch?.[1]) raw = fenceMatch[1];

  const jsonMatch = raw.match(/\{[\s\S]+\}/);
  if (!jsonMatch) {
    return {
      ok: false,
      error: 'Resposta da IA não contém JSON.',
      raw: raw.slice(0, 500)
    };
  }

  try {
    const dadosIA = JSON.parse(jsonMatch[0]) as DadosPdfExtraidos;
    return { ok: true, dadosIA, providerId };
  } catch (parseErr) {
    return {
      ok: false,
      error: `Falha parseando JSON da IA: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      raw: raw.slice(0, 500)
    };
  }
}

async function handleCriminalAiExtrairPdf(
  payload: { texto: string; tipoDocumento?: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const r = await extrairDadosPdfComIa(payload?.texto ?? '', payload?.tipoDocumento);
    sendResponse(r);
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleCriminalAiExtrairPdf falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Processa um PDF carregado manualmente pelo usuário no dashboard.
 * O texto já vem extraído (pelo pdf.js no contexto do dashboard); aqui
 * apenas chamamos a IA + aplicamos os patches no IDB usando a mesma
 * função compartilhada com o reprocessamento automático.
 *
 * Vantagens desta rota vs. `handleCriminalReprocessarProcesso`:
 *   - Não depende de aba PJe autenticada nem de janela auxiliar.
 *   - Funciona para PDFs externos (denúncia recebida por email,
 *     sentença baixada de outra fonte, ofício do MPF).
 *   - Funciona em processos sigilosos onde a aba oculta não consegue
 *     ativar PDFs.
 */
async function handleCriminalProcessarPdfManual(
  payload: { processoId: string; texto: string; tipoDocumento?: string },
  sendResponse: (response: unknown) => void
): Promise<void> {
  const trace: TraceEntry[] = [];
  const t0 = Date.now();
  const log = (
    etapa: string,
    status: TraceEntry['status'],
    info?: string
  ): void => {
    trace.push({ etapa, status, info, ts: Date.now() - t0 });
    console.log(
      `${LOG_PREFIX} pdf-manual [${etapa}] ${status}${info ? ': ' + info : ''}`
    );
  };

  try {
    log('inicio', 'info', `processoId=${payload?.processoId}`);
    const proc = await getProcessoById(payload.processoId);
    if (!proc) {
      sendResponse({ ok: false, error: 'Processo não encontrado no acervo.', trace });
      return;
    }

    const texto = (payload?.texto ?? '').trim();
    if (!texto) {
      log('texto-pdf', 'falha', 'texto do PDF vazio');
      sendResponse({ ok: false, error: 'Texto do PDF vazio.', trace });
      return;
    }
    log('texto-pdf', 'ok', `${texto.length} chars`);

    const r = await extrairDadosPdfComIa(texto, payload.tipoDocumento);
    if (!r.ok) {
      log('rodar-ia', 'falha', r.error);
      sendResponse({ ok: false, error: r.error, raw: r.raw, trace });
      return;
    }
    const camposPreench = (
      Object.keys(r.dadosIA) as (keyof DadosPdfExtraidos)[]
    ).filter(
      (k) => r.dadosIA[k] !== null && r.dadosIA[k] !== undefined && r.dadosIA[k] !== ''
    );
    log(
      'rodar-ia',
      'ok',
      `${camposPreench.length} campo(s) extraído(s): ${camposPreench.join(', ')}`
    );

    await aplicarDadosIaNoProcesso(proc, r.dadosIA, log);

    const atualizado = await getProcessoById(proc.id);
    log('concluido', 'ok', `total=${Date.now() - t0}ms`);
    sendResponse({ ok: true, processo: atualizado, dadosIA: r.dadosIA, trace });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleCriminalProcessarPdfManual falhou:`, error);
    log('exception', 'falha', errorMessage(error));
    sendResponse({ ok: false, error: errorMessage(error), trace });
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

// =====================================================================
// Controle Metas CNJ (perfil Gestão) — handlers
// =====================================================================
//
// Topologia espelhada do Painel Gerencial / Sigcrim. O service worker:
//   1. abre a aba intermediária (`metas-painel`) gravando o estado em
//      `chrome.storage.session` indexado por `requestId`;
//   2. dispara a varredura no content da aba PJe original quando o
//      usuário confirma a seleção;
//   3. responde a perguntas pontuais do coordinator (precisa fetch?) e
//      faz upsert no acervo (`paidegua.metas-cnj`) a cada processo
//      capturado;
//   4. roteia eventos de progresso/conclusão para a aba-painel.

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  garantirSeed as garantirSeedTpu,
  getCategoriasDe as getCategoriasTpu
} from '../shared/tpu-store';
import { buildCategoriasJulgamento } from '../shared/tpu-categorias-julgamento';
import {
  getProcesso as getProcessoMetas,
  loadConfig as loadConfigMetas,
  resetarPresencaVarredura,
  saveLastSync,
  upsertProcesso as upsertProcessoMetas
} from '../shared/metas-cnj-store';
import {
  detectarStatus,
  enriquecerMovimentos,
  type DetectorInput,
  type MovimentoProcessual
} from '../shared/processo-status-detector';
import { calcularMetasAplicaveis } from '../shared/metas-cnj-regras';
import type {
  MetasCnjLastSync,
  ProcessoMetasCnj
} from '../shared/metas-cnj-types';
import { META_CNJ_IDS } from '../shared/metas-cnj-types';

// Shape do envelope que o coordinator do content envia (espelha
// `MetasPatchEnvelope` em `src/content/metas-cnj/metas-coordinator.ts`).
interface MetasPatchEnvelopeBg {
  numero_processo: string;
  id_processo_pje: number;
  id_task_instance_atual: number | null;
  classe_sigla: string;
  assunto_principal: string | null;
  polo_ativo: string | null;
  polo_passivo: string | null;
  orgao_julgador: string | null;
  cargo_judicial: string | null;
  etiquetas_pje: string[];
  tarefa_origem_atual: string | null;
  url: string | null;
  data_distribuicao?: string | null;
  data_autuacao?: string | null;
  presente_ultima_varredura: true;
  ultimo_movimento_visto: string | null;
  movimentos?: Array<{
    codigoCnj: number | null;
    descricao: string;
    data: string;
  }>;
  documentos?: Array<{
    tipo: string;
    descricao: string;
    dataJuntada: string;
  }>;
  veioComFetchProfundo: boolean;
}

function gerarMetasRequestId(): string {
  return `metas-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Garante TPU seed populado antes da primeira coleta. Idempotente.
 */
async function garantirTpuParaMetas(): Promise<void> {
  try {
    const mapas = [buildCategoriasJulgamento()];
    await garantirSeedTpu(mapas);
  } catch (err) {
    console.warn(`${LOG_PREFIX} metas: garantirSeed TPU falhou:`, err);
  }
}

/**
 * Handler de abertura da aba `metas-painel`. Espelha
 * `handleOpenPrazosFitaPainel` — só muda a URL alvo e o canal.
 */
async function handleOpenMetasPainel(
  payload: {
    tarefas: Array<{ nome: string; quantidade: number | null }>;
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
        error: 'Não consegui identificar a aba do PJe que disparou Metas CNJ.'
      });
      return;
    }
    if (!payload || !Array.isArray(payload.tarefas)) {
      sendResponse({ ok: false, error: 'Payload inválido.' });
      return;
    }

    // Garante seed TPU antes da varredura — idempotente, custo zero
    // quando já carregado.
    await garantirTpuParaMetas();

    const requestId = gerarMetasRequestId();
    const stateKey = `${STORAGE_KEYS.METAS_PAINEL_STATE_PREFIX}${requestId}`;
    await chrome.storage.session.set({
      [stateKey]: {
        requestId,
        tarefas: payload.tarefas,
        hostnamePJe: payload.hostnamePJe ?? '',
        abertoEm: payload.abertoEm ?? new Date().toISOString()
      }
    });

    const url =
      chrome.runtime.getURL('metas-painel/painel.html') +
      `?rid=${encodeURIComponent(requestId)}`;
    const tab = await chrome.tabs.create({ url });
    if (typeof tab.id !== 'number') {
      await chrome.storage.session.remove(stateKey);
      sendResponse({
        ok: false,
        error: 'Chrome não atribuiu ID à aba do Metas CNJ.'
      });
      return;
    }
    await setRota(requestId, { painelTabId: tab.id, pjeTabId });
    sendResponse({ ok: true, requestId });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} handleOpenMetasPainel falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Aba-painel → background: usuário clicou Iniciar. Despacha
 * `METAS_RUN_COLETA` para o content da aba PJe.
 */
async function handleMetasStartColeta(
  payload: { requestId: string; nomes: string[] },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const rota = await getRota(payload?.requestId ?? '');
    if (!rota) {
      sendResponse({
        ok: false,
        error:
          'Sessão do painel Metas CNJ expirou. Volte ao PJe e abra o painel novamente.'
      });
      return;
    }
    if (!Array.isArray(payload.nomes) || payload.nomes.length === 0) {
      sendResponse({ ok: false, error: 'Nenhuma tarefa selecionada.' });
      return;
    }
    // Antes de iniciar: marca todos os processos do acervo como
    // "ausentes desta varredura" — o coordinator restaura a presença em
    // cada upsert. Os que ficarem com `presente_ultima_varredura: false`
    // ao final são candidatos à regra de `inferido_sumico`.
    try {
      await resetarPresencaVarredura();
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} metas: resetarPresencaVarredura falhou (seguindo):`,
        err
      );
    }

    const ack = await chrome.tabs.sendMessage(rota.pjeTabId, {
      channel: MESSAGE_CHANNELS.METAS_RUN_COLETA,
      payload: {
        requestId: payload.requestId,
        nomesTarefas: payload.nomes
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
    console.warn(`${LOG_PREFIX} handleMetasStartColeta falhou:`, error);
    sendResponse({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Coordinator → background: precisa fetch profundo deste processo?
 * Critério incremental: se já está no acervo com o mesmo
 * `ultimo_movimento_visto`, não precisa.
 */
async function handleMetasPrecisaFetch(
  payload: {
    numero_processo: string;
    ultimo_movimento_visto: string | null;
  },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const atual = await getProcessoMetas(payload.numero_processo);
    if (!atual) {
      sendResponse({ precisa: true });
      return;
    }
    // Se ainda não temos data_distribuicao, sempre faz fetch profundo.
    if (!atual.data_distribuicao) {
      sendResponse({ precisa: true });
      return;
    }
    const igual =
      atual.ultimo_movimento_visto === payload.ultimo_movimento_visto;
    sendResponse({ precisa: !igual });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleMetasPrecisaFetch falhou:`, err);
    sendResponse({ precisa: true });
  }
}

/**
 * Coordinator → background: upsert de UM processo no acervo. Sequência:
 *
 *   1. Faz upsert no IDB (`upsertProcessoMetas`) — preserva campos com
 *      origem `manual`.
 *   2. Se veio com fetch profundo (movimentos + documentos), enriquece
 *      movimentos com categorias TPU, roda detector de status, atualiza
 *      o registro com `status` + `data_julgamento`/`data_baixa` +
 *      `origem_status`.
 *   3. Calcula `metas_aplicaveis` via regras + config; persiste.
 */
async function handleMetasUpsertProcesso(
  envelope: MetasPatchEnvelopeBg,
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const ts = new Date().toISOString();

    // Patch básico (sem campos de status — esses vêm na 2ª passagem).
    const patchBasico = {
      numero_processo: envelope.numero_processo,
      id_processo_pje: envelope.id_processo_pje,
      id_task_instance_atual: envelope.id_task_instance_atual,
      classe_sigla: envelope.classe_sigla,
      assunto_principal: envelope.assunto_principal,
      polo_ativo: envelope.polo_ativo,
      polo_passivo: envelope.polo_passivo,
      orgao_julgador: envelope.orgao_julgador,
      cargo_judicial: envelope.cargo_judicial,
      etiquetas_pje: envelope.etiquetas_pje,
      tarefa_origem_atual: envelope.tarefa_origem_atual,
      url: envelope.url,
      presente_ultima_varredura: true as const,
      ultimo_movimento_visto: envelope.ultimo_movimento_visto,
      // Datas: só preenche se veio com fetch profundo.
      ...(envelope.veioComFetchProfundo
        ? {
            data_distribuicao: envelope.data_distribuicao ?? null,
            data_autuacao: envelope.data_autuacao ?? null,
            ano_distribuicao: extrairAno(envelope.data_distribuicao ?? null)
          }
        : {})
    };

    await upsertProcessoMetas(patchBasico, {
      ultimaSincronizacaoPje: ts
    });

    // Se houve fetch profundo, processa status + metas
    if (envelope.veioComFetchProfundo) {
      await reclassificarProcesso(envelope);
    }

    sendResponse({ ok: true });
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} metas: upsert falhou para ${envelope.numero_processo}:`,
      err
    );
    sendResponse({ ok: false, error: errorMessage(err) });
  }
}

function extrairAno(iso: string | null): number | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/**
 * Re-roda detector de status + regras das metas para um processo
 * recém-coletado. Lê o estado atual do acervo (após upsert básico),
 * computa novos campos, faz segundo upsert para gravar.
 */
async function reclassificarProcesso(
  envelope: MetasPatchEnvelopeBg
): Promise<void> {
  const proc = await getProcessoMetas(envelope.numero_processo);
  if (!proc) return; // safety

  // Enriquece movimentos com categorias TPU
  const movimentosBase: MovimentoProcessual[] = (envelope.movimentos ?? []).map(
    (m) => ({
      codigoCnj: m.codigoCnj,
      descricao: m.descricao,
      data: m.data
    })
  );
  const movimentosEnriquecidos = await enriquecerMovimentos(movimentosBase);

  const config = await loadConfigMetas();

  // Detector
  const detectorInput: DetectorInput = {
    movimentos: movimentosEnriquecidos,
    documentos: envelope.documentos,
    tarefaAtual: envelope.tarefa_origem_atual ?? null,
    override: null, // override manual aplicado direto via setOverrideMeta
    tarefasIndicamJulgado: config.tarefasIndicamJulgado,
    tarefasIndicamBaixa: config.tarefasIndicamBaixa,
    detectaJulgadoPorDocumento: config.detectaJulgadoPorDocumento,
    documentosTiposPositivos: config.documentosTiposPositivos,
    documentosDescricoesNegativas: config.documentosDescricoesNegativas
  };
  const status = detectarStatus(detectorInput);

  // Regras das metas — usa o snapshot atual do acervo + config
  const procAtualizadoParaRegras: ProcessoMetasCnj = {
    ...proc,
    status: status.status,
    data_distribuicao: envelope.data_distribuicao ?? proc.data_distribuicao
  };
  const metasAplicaveis = calcularMetasAplicaveis(
    procAtualizadoParaRegras,
    config
  );

  // Suprime aviso "lint:no-unused" sobre META_CNJ_IDS (importado para
  // garantir que o conjunto fechado está disponível no runtime do
  // background — útil em logs/diagnóstico futuro).
  void META_CNJ_IDS;

  await upsertProcessoMetas(
    {
      numero_processo: envelope.numero_processo,
      status: status.status,
      origem_status: status.origem,
      status_definido_em: new Date().toISOString(),
      data_julgamento:
        status.status === 'julgado' ? status.data ?? null : null,
      data_baixa: status.status === 'baixado' ? status.data ?? null : null,
      metas_aplicaveis: metasAplicaveis
    },
    { ultimaSincronizacaoPje: new Date().toISOString() }
  );

  // Mantém referências usadas nos sites — silencia lint
  void getCategoriasTpu;
}

/**
 * Coordinator → background → aba-painel: encaminha eventos de progresso/
 * conclusão. Espelha `rotearEventoCriminal`.
 */
async function rotearEventoMetas(
  channel: string,
  payload: { requestId?: string; [k: string]: unknown }
): Promise<void> {
  const requestId = payload?.requestId;
  if (typeof requestId !== 'string' || !requestId) {
    return;
  }
  try {
    const rota = await getRota(requestId);
    if (!rota) return;

    chrome.tabs
      .sendMessage(rota.painelTabId, { channel, payload })
      .catch(() => { /* aba-painel pode ter sido fechada */ });

    // Em DONE: grava lastSync, navega painel para o dashboard, limpa rota
    if (channel === MESSAGE_CHANNELS.METAS_COLETA_DONE) {
      const resumo = payload as {
        requestId: string;
        totalUpserts?: number;
        totalFetchProfundo?: number;
        totalPulados?: number;
        totalErros?: number;
        tarefasProcessadas?: string[];
        startedAt?: string;
      };
      await registrarLastSync(resumo).catch((err) => {
        console.warn(`${LOG_PREFIX} metas: saveLastSync falhou:`, err);
      });
      await chrome.tabs
        .sendMessage(rota.painelTabId, {
          channel: MESSAGE_CHANNELS.METAS_COLETA_READY,
          payload: { requestId }
        })
        .catch(() => { /* fechada */ });
      await chrome.storage.session.remove(
        `${STORAGE_KEYS.METAS_PAINEL_STATE_PREFIX}${requestId}`
      );
      await deleteRota(requestId);
    } else if (channel === MESSAGE_CHANNELS.METAS_COLETA_FAIL) {
      await chrome.storage.session.remove(
        `${STORAGE_KEYS.METAS_PAINEL_STATE_PREFIX}${requestId}`
      );
      await deleteRota(requestId);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} metas: rotearEvento falhou:`, err);
  }
}

/**
 * Aplica etiqueta em lote nos processos selecionados — encaminha para
 * uma aba do PJe (same-origin para o cookie de sessão funcionar). Mesma
 * estratégia do `handlePericiasAplicarEtiquetas`.
 */
async function handleMetasAplicarEtiquetas(
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
          'Nenhuma aba do PJe aberta. Abra o painel do PJe em uma aba antes de aplicar etiquetas.'
      });
      return;
    }
    const tab = tabs[0];
    const resp = await chrome.tabs.sendMessage(tab.id!, {
      channel: MESSAGE_CHANNELS.METAS_APLICAR_ETIQUETAS,
      payload
    });
    sendResponse(resp ?? { ok: false, error: 'Aba do PJe não respondeu.' });
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleMetasAplicarEtiquetas falhou:`, err);
    sendResponse({ ok: false, error: errorMessage(err) });
  }
}

async function registrarLastSync(resumo: {
  totalUpserts?: number;
  totalFetchProfundo?: number;
  totalPulados?: number;
  totalErros?: number;
  tarefasProcessadas?: string[];
  startedAt?: string;
}): Promise<void> {
  // Contagens por meta — query simples por status no acervo é mais
  // confiável que tentar contar incrementalmente durante a varredura.
  const sync: MetasCnjLastSync = {
    startedAt: resumo.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    totalNoAcervo: 0, // calculado via getStats num próximo passo
    novosNoAcervo: 0,
    atualizados: resumo.totalUpserts ?? 0,
    sumidos: 0,
    contagemPorMeta: {
      'meta-2': { pendentes: 0, julgados: 0 },
      'meta-4': { pendentes: 0, julgados: 0 },
      'meta-6': { pendentes: 0, julgados: 0 },
      'meta-7': { pendentes: 0, julgados: 0 },
      'meta-10': { pendentes: 0, julgados: 0 }
    },
    tarefasVarridas: resumo.tarefasProcessadas ?? [],
    error: null
  };
  await saveLastSync(sync);
}
