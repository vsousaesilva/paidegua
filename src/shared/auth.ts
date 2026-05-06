/**
 * Cliente de autenticacao do pAIdegua.
 *
 * Quem usa o que:
 *   - Background: TODAS as funcoes deste modulo (handlers de mensagem,
 *     validacao remota periodica, gate de IA via `requireAuth`).
 *   - Popup / content scripts: APENAS as helpers `loadAuthState`,
 *     `computeAuthStatus`, `validateEmailDomain` e `describeAuthError`.
 *     Para iniciar login eles enviam mensagens via `MESSAGE_CHANNELS.AUTH_*`
 *     ao background, que e quem fala com o backend.
 *
 * Por que centralizar fetch no background:
 *   - Service worker tem ciclo de vida estavel para retry/timeout;
 *   - Mantem a URL do backend e a logica de erro fora dos contextos UI;
 *   - Simplifica futura migracao do backend (so o background muda).
 */

import {
  AUTH_ALLOWED_DOMAINS,
  AUTH_REVALIDATE_INTERVAL_MS,
  LOG_PREFIX,
  STORAGE_KEYS
} from './constants';
import { BACKEND_URL, isBackendConfigured } from './auth-config';
import type {
  AuthErrorCode,
  AuthRequestCodeResponse,
  AuthState,
  AuthStatusResponse,
  AuthVerifyCodeResponse
} from './types';

// ------------------------------------------------------------------
// Storage helpers
// ------------------------------------------------------------------

/** Le o estado salvo. Retorna `null` se nao houver sessao. */
export async function loadAuthState(): Promise<AuthState | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.AUTH);
  const value = raw[STORAGE_KEYS.AUTH];
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AuthState>;
  if (
    typeof candidate.jwt !== 'string' ||
    typeof candidate.email !== 'string' ||
    typeof candidate.expiresAt !== 'number' ||
    typeof candidate.lastValidatedAt !== 'number'
  ) {
    return null;
  }
  return {
    jwt: candidate.jwt,
    email: candidate.email,
    expiresAt: candidate.expiresAt,
    lastValidatedAt: candidate.lastValidatedAt
  };
}

export async function saveAuthState(state: AuthState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.AUTH]: state });
}

export async function clearAuthState(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.AUTH);
}

// ------------------------------------------------------------------
// Derivacao de status (sem rede)
// ------------------------------------------------------------------

/**
 * Decide se a sessao local ainda e valida. NAO consulta o backend — usa
 * apenas `expiresAt` do JWT. Para revogacao remota use `revalidateRemote`.
 */
export function computeAuthStatus(
  state: AuthState | null,
  nowMs: number = Date.now()
): AuthStatusResponse {
  if (!state) return { authenticated: false, reason: 'no_session' };
  if (state.expiresAt <= nowMs) {
    return { authenticated: false, reason: 'expired_local' };
  }
  return {
    authenticated: true,
    email: state.email,
    expiresAt: state.expiresAt
  };
}

/** Heuristica simples para o e-mail digitado pelo usuario no popup. */
export function validateEmailDomain(email: string): boolean {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 1) return false;
  const domain = trimmed.slice(at + 1);
  return AUTH_ALLOWED_DOMAINS.includes(domain);
}

// ------------------------------------------------------------------
// Chamadas ao backend (somente do background)
// ------------------------------------------------------------------

interface BackendOk {
  ok: true;
  [key: string]: unknown;
}
interface BackendErr {
  ok: false;
  error?: string;
}
type BackendResponse = BackendOk | BackendErr;

async function callBackend(payload: object): Promise<BackendResponse> {
  if (!isBackendConfigured()) {
    return { ok: false, error: 'backend_not_configured' };
  }
  try {
    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      // Mantem o request "simples" (sem preflight CORS): nao seta
      // Content-Type explicito; o Worker (mesmo padrao do GAS legado)
      // trata como text/plain e faz JSON.parse no body.
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    if (!response.ok) {
      console.warn(`${LOG_PREFIX} backend HTTP ${response.status}`);
      return { ok: false, error: 'server_error' };
    }
    const data = (await response.json()) as BackendResponse;
    return data;
  } catch (err) {
    console.warn(`${LOG_PREFIX} falha de rede no backend de auth:`, err);
    return { ok: false, error: 'network_error' };
  }
}

function asAuthError(value: unknown): AuthErrorCode {
  const known: AuthErrorCode[] = [
    'invalid_email',
    'not_whitelisted',
    'rate_limited',
    'missing_fields',
    'no_code',
    'expired',
    'wrong_code',
    'too_many_attempts',
    'invalid_jwt',
    'revoked',
    'server_error',
    'network_error',
    'backend_not_configured'
  ];
  return known.includes(value as AuthErrorCode)
    ? (value as AuthErrorCode)
    : 'server_error';
}

export async function remoteRequestCode(
  email: string
): Promise<AuthRequestCodeResponse> {
  const trimmed = email.trim().toLowerCase();
  if (!validateEmailDomain(trimmed)) {
    return { ok: false, error: 'invalid_email' };
  }
  const result = await callBackend({ action: 'requestCode', email: trimmed });
  if (result.ok) return { ok: true };
  return { ok: false, error: asAuthError(result.error) };
}

export async function remoteVerifyCode(
  email: string,
  code: string
): Promise<AuthVerifyCodeResponse> {
  const trimmedEmail = email.trim().toLowerCase();
  const trimmedCode = code.trim();
  if (!trimmedEmail || !trimmedCode) {
    return { ok: false, error: 'missing_fields' };
  }
  const result = await callBackend({
    action: 'verifyCode',
    email: trimmedEmail,
    code: trimmedCode
  });
  if (
    result.ok &&
    typeof (result as Record<string, unknown>).jwt === 'string' &&
    typeof (result as Record<string, unknown>).expiresAt === 'number'
  ) {
    const jwt = (result as Record<string, unknown>).jwt as string;
    const expiresAt = (result as Record<string, unknown>).expiresAt as number;
    const emailFromBackend =
      ((result as Record<string, unknown>).email as string | undefined) ??
      trimmedEmail;
    const state: AuthState = {
      jwt,
      email: emailFromBackend,
      expiresAt,
      lastValidatedAt: Date.now()
    };
    await saveAuthState(state);
    return { ok: true, email: emailFromBackend, expiresAt };
  }
  return { ok: false, error: asAuthError((result as BackendErr).error) };
}

/**
 * Bate em /me para revalidar o JWT atual contra a planilha. Atualiza
 * `lastValidatedAt` no caso de sucesso; em caso de revogacao/expiracao,
 * limpa a sessao local.
 *
 * Retorna o status final (com o eventual motivo da queda da sessao).
 */
export async function revalidateRemote(): Promise<AuthStatusResponse> {
  const state = await loadAuthState();
  if (!state) return { authenticated: false, reason: 'no_session' };
  const result = await callBackend({ action: 'me', jwt: state.jwt });
  if (result.ok) {
    const expiresAt =
      typeof (result as Record<string, unknown>).expiresAt === 'number'
        ? ((result as Record<string, unknown>).expiresAt as number)
        : state.expiresAt;
    const updated: AuthState = {
      ...state,
      expiresAt,
      lastValidatedAt: Date.now()
    };
    await saveAuthState(updated);
    return {
      authenticated: true,
      email: updated.email,
      expiresAt: updated.expiresAt
    };
  }
  const err = asAuthError((result as BackendErr).error);
  // Erros transitorios (rede, server_error) NAO derrubam a sessao —
  // confiamos no `expiresAt` local. Apenas revogacao/JWT invalido
  // limpam a sessao.
  if (err === 'revoked' || err === 'invalid_jwt') {
    await clearAuthState();
    return { authenticated: false, reason: err };
  }
  return computeAuthStatus(state);
}

// ------------------------------------------------------------------
// Mensagens humanas
// ------------------------------------------------------------------

export function describeAuthError(code: AuthErrorCode | undefined): string {
  switch (code) {
    case 'invalid_email':
      return 'E-mail invalido. Use um endereco de um dos tribunais autorizados.';
    case 'not_whitelisted':
      return 'Este e-mail ainda nao foi autorizado pelo Inovajus. Solicite o cadastro.';
    case 'rate_limited':
      return 'Aguarde um minuto antes de pedir um novo codigo.';
    case 'missing_fields':
      return 'Preencha e-mail e codigo.';
    case 'no_code':
      return 'Nenhum codigo pendente. Solicite um novo.';
    case 'expired':
      return 'O codigo expirou. Solicite um novo.';
    case 'wrong_code':
      return 'Codigo incorreto. Tente novamente.';
    case 'too_many_attempts':
      return 'Muitas tentativas erradas. Solicite um novo codigo.';
    case 'invalid_jwt':
      return 'Sessao invalida. Faca login novamente.';
    case 'revoked':
      return 'Acesso revogado pelo Inovajus.';
    case 'backend_not_configured':
      return 'Backend de autenticacao nao configurado. Avise o Inovajus.';
    case 'network_error':
      return 'Falha de rede. Verifique sua conexao e tente de novo.';
    case 'server_error':
    default:
      return 'Erro no servidor de autenticacao. Tente novamente em instantes.';
  }
}

/**
 * Janela maxima entre revalidacoes. O background dispara a verificao
 * remota se passou mais que isso desde a ultima — evita revalidar em toda
 * abertura de popup mas nao deixa um token revogado vivo por dias.
 */
export const AUTH_REVALIDATE_AFTER_MS = AUTH_REVALIDATE_INTERVAL_MS;
