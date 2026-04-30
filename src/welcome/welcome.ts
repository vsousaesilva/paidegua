/**
 * Pagina de boas-vindas + login do pAIdegua.
 *
 * Aberta automaticamente em uma aba nova quando a extensao e instalada
 * pela primeira vez (`chrome.runtime.onInstalled` com reason='install').
 * Tambem pode ser reaberta manualmente pelo botao "Abrir configuracoes"
 * do popup, mas nao ha entry point publico para ela.
 *
 * Usa os mesmos canais do popup (`AUTH_REQUEST_CODE`, `AUTH_VERIFY_CODE`,
 * `AUTH_GET_STATUS`) — toda a fonte de verdade do login fica no service
 * worker; este arquivo so renderiza UI.
 */

import { MESSAGE_CHANNELS } from '../shared/constants';
import { describeAuthError, validateEmailDomain } from '../shared/auth';
import type {
  AuthRequestCodeResponse,
  AuthStatusResponse,
  AuthVerifyCodeResponse
} from '../shared/types';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Welcome: elemento #${id} ausente`);
  return el as T;
}

function setStatus(
  elId: 'welcome-status-email' | 'welcome-status-code',
  text: string,
  kind: 'ok' | 'error' | 'info' | '' = ''
): void {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = 'welcome__status' + (kind ? ` is-${kind}` : '');
}

function showStage(stage: 'email' | 'code'): void {
  const stageEmail = $<HTMLElement>('welcome-stage-email');
  const stageCode = $<HTMLElement>('welcome-stage-code');
  if (stage === 'email') {
    stageEmail.removeAttribute('hidden');
    stageCode.setAttribute('hidden', '');
  } else {
    stageEmail.setAttribute('hidden', '');
    stageCode.removeAttribute('hidden');
  }
}

function showSuccess(email: string): void {
  $<HTMLElement>('welcome-login').setAttribute('hidden', '');
  $<HTMLElement>('welcome-success').removeAttribute('hidden');
  $<HTMLSpanElement>('welcome-success-email').textContent = email;
}

async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.AUTH_GET_STATUS
  })) as AuthStatusResponse;
  return response ?? { authenticated: false, reason: 'no_session' };
}

async function requestLoginCode(email: string): Promise<AuthRequestCodeResponse> {
  return (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.AUTH_REQUEST_CODE,
    payload: { email }
  })) as AuthRequestCodeResponse;
}

async function verifyLoginCode(
  email: string,
  code: string
): Promise<AuthVerifyCodeResponse> {
  return (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.AUTH_VERIFY_CODE,
    payload: { email, code }
  })) as AuthVerifyCodeResponse;
}

/**
 * Detecta se ja ha alguma aba do PJe aberta no navegador. Se sim, mostra
 * o aviso de "atualize a pagina do PJe" para que a sidebar reconheca a
 * sessao recem-criada.
 */
async function maybeShowReloadHint(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.jus.br/*' });
    if (tabs.length > 0) {
      $<HTMLElement>('welcome-postlogin-warning').removeAttribute('hidden');
    }
  } catch {
    // tabs.query pode falhar se nao houver permissao — silencioso
  }
}

function bindUi(): void {
  const requestBtn = $<HTMLButtonElement>('welcome-request-btn');
  const verifyBtn = $<HTMLButtonElement>('welcome-verify-btn');
  const backBtn = $<HTMLButtonElement>('welcome-back-btn');
  const emailInput = $<HTMLInputElement>('welcome-email-input');
  const codeInput = $<HTMLInputElement>('welcome-code-input');
  const emailDisplay = $<HTMLSpanElement>('welcome-email-display');
  const closeTabBtn = $<HTMLButtonElement>('welcome-close-tab');

  emailInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      requestBtn.click();
    }
  });
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      verifyBtn.click();
    }
  });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
  });

  requestBtn.addEventListener('click', () => {
    void (async () => {
      const email = emailInput.value.trim().toLowerCase();
      if (!validateEmailDomain(email)) {
        setStatus(
          'welcome-status-email',
          'E-mail invalido. Use um endereco institucional dos tribunais autorizados.',
          'error'
        );
        return;
      }
      requestBtn.disabled = true;
      setStatus('welcome-status-email', 'Enviando codigo...', 'info');
      try {
        const result = await requestLoginCode(email);
        if (result.ok) {
          emailDisplay.textContent = email;
          codeInput.value = '';
          showStage('code');
          setStatus('welcome-status-code', '', '');
          codeInput.focus();
        } else {
          setStatus(
            'welcome-status-email',
            describeAuthError(result.error),
            'error'
          );
        }
      } finally {
        requestBtn.disabled = false;
      }
    })();
  });

  verifyBtn.addEventListener('click', () => {
    void (async () => {
      const email = (emailDisplay.textContent ?? '').trim().toLowerCase();
      const code = codeInput.value.trim();
      if (!email || code.length !== 6) {
        setStatus(
          'welcome-status-code',
          'Cole o codigo de 6 digitos recebido por e-mail.',
          'error'
        );
        return;
      }
      verifyBtn.disabled = true;
      backBtn.disabled = true;
      setStatus('welcome-status-code', 'Validando...', 'info');
      try {
        const result = await verifyLoginCode(email, code);
        if (result.ok && result.email) {
          showSuccess(result.email);
          await maybeShowReloadHint();
        } else {
          setStatus(
            'welcome-status-code',
            describeAuthError(result.error),
            'error'
          );
        }
      } finally {
        verifyBtn.disabled = false;
        backBtn.disabled = false;
      }
    })();
  });

  backBtn.addEventListener('click', () => {
    showStage('email');
    setStatus('welcome-status-email', '', '');
    codeInput.value = '';
  });

  closeTabBtn.addEventListener('click', () => {
    void (async () => {
      try {
        const tab = await chrome.tabs.getCurrent();
        if (tab?.id !== undefined) {
          await chrome.tabs.remove(tab.id);
        } else {
          window.close();
        }
      } catch {
        window.close();
      }
    })();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindUi();
  void (async () => {
    const status = await fetchAuthStatus();
    if (status.authenticated && status.email) {
      showSuccess(status.email);
      await maybeShowReloadHint();
    } else {
      showStage('email');
      $<HTMLInputElement>('welcome-email-input').focus();
    }
  })();
});
