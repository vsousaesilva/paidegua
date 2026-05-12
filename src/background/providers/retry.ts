/**
 * fetchWithRetry — wrapper de `fetch` com retry exponencial para erros
 * transitórios das APIs dos provedores de LLM (Gemini, OpenAI, Anthropic).
 *
 * Repete APENAS quando o provedor responde com um status HTTP transitório
 * (sobrecarga 5xx, limite temporário 429). Falhas de rede — host bloqueado
 * por proxy/firewall, DNS, offline — NÃO são repetidas: nesse cenário,
 * comum em intranet, repetir só atrasaria a mensagem de erro útil. A
 * exceção do `fetch` (TypeError) é propagada na hora, e `friendlyChatError`
 * a transforma em "verifique sua conexão / firewall".
 *
 * Quando o status não é retriável, ou as tentativas se esgotam, o caller
 * recebe um `ProviderHttpError` cuja `.message` JÁ é a mensagem amigável
 * final — cita o provedor (rótulo legível), o código HTTP e a ação
 * recomendada —, de modo que qualquer ponto que apenas exiba
 * `error.message` mostre algo compreensível ao usuário.
 *
 * O número de tentativas depende do modelo: ids `-preview` (que sofrem mais
 * com picos de fila do provedor) ganham uma tentativa a mais.
 */

import { PROVIDER_LABELS, type ProviderId } from '../../shared/constants';

/** Status HTTP transitórios — vale nova tentativa. */
const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

/** Tentativas (inclui a 1ª). Modelos `-preview` caem mais → +1 tentativa. */
const MAX_ATTEMPTS_DEFAULT = 3;
const MAX_ATTEMPTS_PREVIEW = 4;

const BACKOFF_BASE_MS = 800;
const BACKOFF_CAP_MS = 8_000;
/** Teto para `Retry-After` enviado pelo provedor — não bloquear indefinidamente. */
const RETRY_AFTER_CAP_MS = 30_000;

/** Tamanho máximo da mensagem da API repassada na mensagem de erro. */
const API_DETAIL_MAX_CHARS = 400;

/**
 * Erro HTTP definitivo de um provedor de IA. `.message` é a mensagem
 * amigável (pronta para exibir); `.apiBody`/`.status`/`.attempts` ficam
 * disponíveis para logs e diagnóstico.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly provider: ProviderId;
  readonly apiBody: string;
  readonly attempts: number;

  constructor(opts: {
    status: number;
    provider: ProviderId;
    apiBody: string;
    attempts: number;
    friendlyMessage: string;
  }) {
    super(opts.friendlyMessage);
    this.name = 'ProviderHttpError';
    this.status = opts.status;
    this.provider = opts.provider;
    this.apiBody = opts.apiBody;
    this.attempts = opts.attempts;
  }
}

export interface FetchWithRetryOptions {
  provider: ProviderId;
  /** id do modelo — usado só para decidir o nº de tentativas (`-preview` → +1). */
  model: string;
  /**
   * Rótulo do recurso para a mensagem de fallback de erros HTTP não
   * mapeados (ex.: "transcrição de áudio", "síntese de voz"). Default:
   * "solicitação".
   */
  resourceLabel?: string;
}

/** Signal "dummy" para quando o caller não passa um — nunca aborta. */
const NEVER_ABORTS: AbortSignal = new AbortController().signal;

/**
 * Faz `fetch(url, init)` repetindo em caso de status HTTP transitório.
 * Em sucesso devolve a `Response` (garantidamente `response.ok`). Em
 * erro definitivo lança `ProviderHttpError`. Falhas de rede e aborts
 * são propagados sem retry.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions
): Promise<Response> {
  const signal = init.signal ?? NEVER_ABORTS;
  const maxAttempts = /-preview\b/i.test(opts.model)
    ? MAX_ATTEMPTS_PREVIEW
    : MAX_ATTEMPTS_DEFAULT;
  const resourceLabel = opts.resourceLabel ?? 'solicitação';

  let attempt = 0;
  while (true) {
    attempt++;
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Falha de rede / abort: propaga de imediato (ver doc do módulo).
    const response = await fetch(url, init);
    if (response.ok) {
      return response;
    }

    const lastAttempt = attempt >= maxAttempts;
    if (!RETRIABLE_STATUS.has(response.status) || lastAttempt) {
      const apiBody = await safeReadText(response);
      throw new ProviderHttpError({
        status: response.status,
        provider: opts.provider,
        apiBody,
        attempts: attempt,
        friendlyMessage: describeHttpError(
          opts.provider,
          response.status,
          attempt,
          apiBody,
          resourceLabel
        )
      });
    }

    // Status transitório e ainda há tentativas: espera e tenta de novo.
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    await safeReadText(response); // drena o corpo p/ liberar a conexão
    await delay(backoffMs(attempt, retryAfterMs), signal);
  }
}

/**
 * Monta a mensagem amigável a partir do status HTTP. Não cita versão de
 * modelo (a lista de modelos muda com o tempo) — sugere ações genéricas.
 */
function describeHttpError(
  provider: ProviderId,
  status: number,
  attempts: number,
  apiBody: string,
  resourceLabel: string
): string {
  const name = PROVIDER_LABELS[provider];

  // A) Sobrecarga / instabilidade transitória do provedor.
  if (
    status === 503 ||
    status === 529 ||
    status === 500 ||
    status === 502 ||
    status === 504
  ) {
    const tries =
      attempts === 1 ? '1 tentativa automática' : `${attempts} tentativas automáticas`;
    return (
      `O provedor de IA (${name}) está sobrecarregado neste momento e não respondeu após ` +
      `${tries} (erro ${status}). Isso costuma se resolver em poucos minutos. Aguarde cerca de ` +
      `um minuto e tente novamente. Se persistir, você pode selecionar outro modelo no popup do ` +
      `pAIdegua ou usar outro provedor de IA configurado.`
    );
  }

  // B) Limite de uso / cota da chave.
  if (status === 429) {
    return (
      `A chave de API do provedor de IA (${name}) atingiu o limite de uso no momento (erro 429). ` +
      `Aguarde alguns instantes antes de tentar de novo. Se o erro continuar, verifique o limite ou ` +
      `o plano associado a essa chave no painel do provedor.`
    );
  }

  // C) Chave recusada (inválida, sem permissão, expirada).
  if (status === 401 || status === 403) {
    return (
      `A chave de API do provedor de IA (${name}) foi recusada (erro ${status}). ` +
      `Verifique se a chave está correta e ativa nas configurações do pAIdegua.`
    );
  }

  // D) Demais erros HTTP — repassa a mensagem da API com rótulo legível.
  const detail = extractApiErrorText(apiBody);
  return (
    `O provedor de IA (${name}) recusou a ${resourceLabel} (erro ${status})` +
    (detail ? `: ${detail}` : '') +
    '.'
  );
}

/** Extrai a mensagem de erro do corpo (JSON dos provedores ou texto cru). */
function extractApiErrorText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const msg =
      typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error?.message ?? parsed.message);
    if (typeof msg === 'string' && msg.trim()) {
      return truncate(msg.trim(), API_DETAIL_MAX_CHARS);
    }
  } catch {
    /* corpo não-JSON — cai no texto cru abaixo */
  }
  return truncate(trimmed, API_DETAIL_MAX_CHARS);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Backoff exponencial com jitter; respeita `Retry-After` quando vier. */
function backoffMs(attempt: number, retryAfterMs: number | undefined): number {
  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  const exp = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * BACKOFF_BASE_MS;
  return Math.min(exp + jitter, BACKOFF_CAP_MS);
}

/** Interpreta `Retry-After` (segundos ou data HTTP) em ms. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) {
    return Math.max(0, at - Date.now());
  }
  return undefined;
}

/** `setTimeout` como Promise, abortável via `AbortSignal`. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
