/**
 * Sidebar (painel lateral) do PAIdegua — Fase 4.
 *
 * Estrutura:
 *   header  → marca + número do processo + botão fechar
 *   toolbar → Carregar Documentos · Resumir · Minutar · Resumo Áudio · Resumo Vídeo
 *   body    → área dinâmica (document-list ou chat, montados externamente)
 *   footer  → textarea + botão microfone + botão enviar
 *
 * O sidebar expõe getters para os elementos interativos do footer
 * (textarea, botões, status do provedor) — o orquestrador (content.ts)
 * conecta os listeners e a lógica de chamada à API.
 */

import type { PJeDetection } from '../../shared/types';
import { getTemplateActionsForGrau } from '../../shared/prompts';

export interface SidebarElements {
  body: HTMLElement;
  textarea: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  micButton: HTMLButtonElement;
  loadDocsButton: HTMLButtonElement;
  ocrButton: HTMLButtonElement;
  resumirButton: HTMLButtonElement;
  minutarButton: HTMLButtonElement;
  audioButton: HTMLButtonElement;
  anonimizarButton: HTMLButtonElement;
  /** Mapa actionId → botão. Para os 5 botões de minuta com modelos. */
  templateActionButtons: Map<string, HTMLButtonElement>;
  providerLabel: HTMLElement;
  globalNotice: HTMLElement;
}

export interface SidebarController {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  updateDetection(detection: PJeDetection): void;
  setLoadDocsLabel(label: string): void;
  setLoadDocsEnabled(enabled: boolean): void;
  /** Habilita/desabilita os botões que dependem de ter documentos carregados. */
  setExtractedFeaturesEnabled(enabled: boolean): void;
  /** Habilita/desabilita os botões e textarea de chat. */
  setChatEnabled(enabled: boolean): void;
  /**
   * Ajusta o botão "Rodar OCR pendente": oculto quando `count` é 0, visível
   * e rotulado com a contagem caso contrário. `running` bloqueia o clique
   * enquanto um OCR já está em andamento.
   */
  setOcrPending(count: number, running?: boolean): void;
  setProviderLabel(label: string): void;
  setGlobalNotice(text: string, kind?: 'info' | 'warn' | 'error'): void;
  /** Retorna referências aos elementos para o orquestrador conectar. */
  readonly elements: SidebarElements;
  destroy(): void;
}

export interface SidebarOptions {
  onLoadDocuments: () => void;
  onClose?: () => void;
}

const SIDEBAR_CSS = `
.paidegua-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  height: 100dvh;
  max-height: 100vh;
  max-height: 100dvh;
  width: clamp(560px, 68vw, 880px);
  max-width: 100vw;
  background: var(--paidegua-bg);
  backdrop-filter: var(--paidegua-blur);
  -webkit-backdrop-filter: var(--paidegua-blur);
  color: var(--paidegua-text);
  font-family: var(--paidegua-font);
  font-size: 14px;
  box-shadow: var(--paidegua-shadow);
  transform: translateX(100%);
  transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: auto;
  border-left: 1px solid var(--paidegua-border-strong);
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  grid-template-areas:
    "header  header"
    "notice  chat"
    "toolbar chat"
    "footer  chat";
  overflow: hidden;
}

.paidegua-sidebar::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(900px 320px at 100% 0%, rgba(89, 146, 237, 0.10), transparent 60%),
    radial-gradient(700px 240px at 0% 100%, rgba(255, 205, 7, 0.06), transparent 60%);
  z-index: 0;
}

.paidegua-sidebar > * { position: relative; z-index: 1; }

.paidegua-sidebar.is-open { transform: translateX(0); }

.paidegua-sidebar__header  { grid-area: header; }
.paidegua-sidebar__toolbar {
  grid-area: toolbar;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(19, 81, 180, 0.25) transparent;
}
.paidegua-sidebar__toolbar::-webkit-scrollbar { width: 6px; }
.paidegua-sidebar__toolbar::-webkit-scrollbar-thumb {
  background: rgba(19, 81, 180, 0.22);
  border-radius: 6px;
}
.paidegua-sidebar__notice  { grid-area: notice; }
.paidegua-sidebar__body    {
  grid-area: chat;
  border-left: 1px solid var(--paidegua-border);
  background: rgba(255, 255, 255, 0.55);
  min-height: 0;
}
.paidegua-sidebar__footer  {
  grid-area: footer;
  border-top: 1px solid var(--paidegua-border);
}

@media (max-width: 768px) {
  .paidegua-sidebar {
    width: 100vw;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto minmax(0, 1fr) auto;
    grid-template-areas:
      "header"
      "notice"
      "toolbar"
      "chat"
      "footer";
  }
  .paidegua-sidebar__toolbar { max-height: 38vh; }
}

.paidegua-sidebar__header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px 16px;
  border-bottom: 1px solid var(--paidegua-border);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.85), rgba(244, 247, 252, 0.62));
}

.paidegua-sidebar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.paidegua-sidebar__logo {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--paidegua-gradient);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  box-shadow: 0 6px 18px rgba(19, 81, 180, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.25);
  flex-shrink: 0;
}

.paidegua-sidebar__logo svg { display: block; }

.paidegua-sidebar__title {
  margin: 0;
  font-size: 17px;
  color: var(--paidegua-primary-dark);
  letter-spacing: -0.2px;
  font-weight: 700;
  line-height: 1;
}

.paidegua-sidebar__title em {
  font-style: normal;
  color: var(--paidegua-primary);
  font-weight: 800;
}

.paidegua-sidebar__processo {
  font-size: 11px;
  color: var(--paidegua-text-muted);
  margin-top: 6px;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
}

.paidegua-sidebar__provider {
  font-size: 9.5px;
  color: var(--paidegua-primary);
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  font-weight: 600;
}

.paidegua-sidebar__header-info { flex: 1; min-width: 0; }

.paidegua-sidebar__close {
  background: rgba(19, 81, 180, 0.06);
  color: var(--paidegua-primary-dark);
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  line-height: 1;
  transition: background-color 180ms ease, color 180ms ease, transform 180ms ease;
}

.paidegua-sidebar__close:hover {
  background: rgba(19, 81, 180, 0.14);
  transform: rotate(90deg);
}

.paidegua-sidebar__toolbar {
  display: grid;
  grid-template-columns: 1fr;
  gap: 7px;
  padding: 14px 14px 14px;
}

.paidegua-sidebar__toolbar button {
  background: rgba(255, 255, 255, 0.62);
  color: var(--paidegua-text);
  padding: 10px 12px;
  border-radius: var(--paidegua-radius-sm);
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--paidegua-border);
  transition: all 180ms ease;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 8px;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.paidegua-sidebar__toolbar button:hover:not(:disabled) {
  background: rgba(19, 81, 180, 0.08);
  border-color: var(--paidegua-border-strong);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(19, 81, 180, 0.10);
}

.paidegua-sidebar__toolbar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.paidegua-sidebar__toolbar button.is-primary {
  background: var(--paidegua-gradient);
  color: #ffffff;
  border-color: transparent;
  justify-content: center;
  font-weight: 600;
  font-size: 13px;
  padding: 12px;
  letter-spacing: 0.2px;
  box-shadow: 0 8px 22px rgba(19, 81, 180, 0.28);
}

.paidegua-sidebar__toolbar button.is-primary:hover:not(:disabled) {
  background: linear-gradient(135deg, #0C326F 0%, #1351B4 100%);
  transform: translateY(-1px);
  box-shadow: 0 12px 28px rgba(19, 81, 180, 0.35);
}

.paidegua-sidebar__notice {
  font-size: 11px;
  padding: 8px 18px;
  line-height: 1.4;
  display: none;
}
.paidegua-sidebar__notice.is-visible { display: block; }
.paidegua-sidebar__notice.is-info  { background: rgba(19, 81, 180, 0.08);  color: var(--paidegua-primary-dark); border-left: 3px solid var(--paidegua-primary); }
.paidegua-sidebar__notice.is-warn  { background: rgba(255, 205, 7, 0.14); color: #8a6d00;            border-left: 3px solid var(--paidegua-yellow); }
.paidegua-sidebar__notice.is-error { background: rgba(220, 80, 80, 0.10); color: #b03030;            border-left: 3px solid #c0392b; }

.paidegua-sidebar__body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(19, 81, 180, 0.25) transparent;
}

.paidegua-sidebar__body::-webkit-scrollbar { width: 8px; }
.paidegua-sidebar__body::-webkit-scrollbar-thumb {
  background: rgba(19, 81, 180, 0.22);
  border-radius: 8px;
}
.paidegua-sidebar__body::-webkit-scrollbar-thumb:hover {
  background: rgba(19, 81, 180, 0.38);
}

.paidegua-sidebar__footer {
  padding: 12px 14px 14px;
  border-top: 1px solid var(--paidegua-border);
  background: linear-gradient(0deg, rgba(244, 247, 252, 0.85), rgba(255, 255, 255, 0.65));
  display: grid;
  grid-template-columns: 1fr auto auto;
  grid-template-rows: auto auto;
  grid-template-areas:
    "input input input"
    ".     mic   send";
  gap: 9px;
  align-items: stretch;
}

.paidegua-sidebar__footer .paidegua-sidebar__mic  { grid-area: mic; }
.paidegua-sidebar__footer .paidegua-sidebar__send { grid-area: send; }

.paidegua-sidebar__input {
  grid-area: input;
  width: 100%;
  background: rgba(255, 255, 255, 0.85);
  color: var(--paidegua-text);
  border: 1px solid var(--paidegua-border-strong);
  border-radius: var(--paidegua-radius-sm);
  padding: 11px 13px;
  font-family: var(--paidegua-font);
  font-size: 13.5px;
  line-height: 1.45;
  resize: none;
  min-height: 64px;
  max-height: 180px;
  outline: none;
  transition: border-color 180ms ease, box-shadow 180ms ease, background-color 180ms ease;
}

.paidegua-sidebar__input:focus {
  border-color: var(--paidegua-primary);
  background: #ffffff;
  box-shadow: 0 0 0 4px rgba(19, 81, 180, 0.14);
}
.paidegua-sidebar__input:disabled { opacity: 0.6; }
.paidegua-sidebar__input::placeholder { color: var(--paidegua-text-muted); }

.paidegua-sidebar__mic, .paidegua-sidebar__send {
  width: 40px;
  height: 40px;
  border-radius: var(--paidegua-radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
  transition: background-color 180ms ease, color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
}

.paidegua-sidebar__mic {
  background: rgba(255, 255, 255, 0.85);
  color: var(--paidegua-primary-dark);
  border: 1px solid var(--paidegua-border-strong);
}
.paidegua-sidebar__mic:hover:not(:disabled) {
  background: rgba(19, 81, 180, 0.10);
  transform: translateY(-1px);
}
.paidegua-sidebar__mic.is-recording {
  background: #c0392b;
  color: #ffffff;
  border-color: #c0392b;
  animation: paidegua-pulse 1.2s ease-in-out infinite;
}
@keyframes paidegua-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(192, 57, 43, 0.55); }
  50% { box-shadow: 0 0 0 7px rgba(192, 57, 43, 0); }
}

.paidegua-sidebar__send {
  background: var(--paidegua-gradient);
  color: #ffffff;
  box-shadow: 0 6px 16px rgba(19, 81, 180, 0.28);
}
.paidegua-sidebar__send:hover:not(:disabled) {
  background: linear-gradient(135deg, #0C326F 0%, #1351B4 100%);
  transform: translateY(-1px);
  box-shadow: 0 10px 22px rgba(19, 81, 180, 0.36);
}
.paidegua-sidebar__send:disabled, .paidegua-sidebar__mic:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}
`;

function formatDetectionLabel(detection: PJeDetection): string {
  const tribunal = detection.tribunal;
  const grau = detection.grau === 'unknown' ? '' : ` · ${detection.grau.toUpperCase()}`;
  const numero = detection.numeroProcesso ?? '—';
  return `${tribunal}${grau} · ${numero}`;
}

export function mountSidebar(
  shadow: ShadowRoot,
  detection: PJeDetection,
  options: SidebarOptions
): SidebarController {
  if (!shadow.querySelector('style[data-paidegua="sidebar"]')) {
    const style = document.createElement('style');
    style.setAttribute('data-paidegua', 'sidebar');
    style.textContent = SIDEBAR_CSS;
    shadow.appendChild(style);
  }

  const aside = document.createElement('aside');
  aside.className = 'paidegua-sidebar';
  aside.setAttribute('role', 'complementary');
  aside.setAttribute('aria-label', 'pAIdegua');

  aside.innerHTML = `
    <header class="paidegua-sidebar__header">
      <div class="paidegua-sidebar__header-info">
        <div class="paidegua-sidebar__brand">
          <span class="paidegua-sidebar__logo" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <rect x="6.6" y="4.08" width="2.88" height="17.04" rx="1.2" fill="currentColor"/>
              <circle cx="14.28" cy="10.32" r="4.62" fill="none" stroke="currentColor" stroke-width="2.52"/>
              <circle cx="14.28" cy="10.32" r="2.04" fill="#FFCD07"/>
            </svg>
          </span>
          <h2 class="paidegua-sidebar__title">p<em>AI</em>degua</h2>
        </div>
        <div class="paidegua-sidebar__processo" data-paidegua="processo-label"></div>
        <div class="paidegua-sidebar__provider" data-paidegua="provider-label"></div>
      </div>
      <button type="button" class="paidegua-sidebar__close" aria-label="Fechar pAIdegua">×</button>
    </header>

    <div class="paidegua-sidebar__toolbar">
      <button type="button" class="is-primary" data-paidegua="load-documents">Carregar Documentos</button>
      <button type="button" disabled style="display:none; grid-column: 1 / -1; justify-content: center;" data-paidegua="ocr-pendentes">Rodar OCR pendente</button>
      <button type="button" disabled data-paidegua="resumir">Resumir</button>
      <button type="button" disabled data-paidegua="audio-summary">Resumir em áudio</button>
      <button type="button" disabled data-paidegua="anonimizar" title="Substitui CPF, CNPJ, e-mails, telefones e nomes de partes por marcadores genéricos">Anonimizar autos</button>
      <button type="button" disabled data-paidegua="minutar">Minutar</button>
      <div class="paidegua-sidebar__toolbar-divider" style="grid-column: 1 / -1; height: 1px; background: var(--paidegua-border); margin: 4px 0 2px;"></div>
      <div class="paidegua-sidebar__toolbar-label" style="grid-column: 1 / -1; font-size: 10px; text-transform: uppercase; color: var(--paidegua-text-muted); letter-spacing: 0.4px; margin-bottom: 2px;">Minutas com modelo</div>
      ${getTemplateActionsForGrau(detection.grau)
        .map(
          (a) =>
            `<button type="button" disabled data-paidegua="template-action" data-action-id="${a.id}" title="${a.description}">${a.label}</button>`
        )
        .join('')}
    </div>

    <div class="paidegua-sidebar__notice" data-paidegua="global-notice"></div>

    <div class="paidegua-sidebar__body" data-paidegua="body"></div>

    <footer class="paidegua-sidebar__footer">
      <button type="button" class="paidegua-sidebar__mic" aria-label="Gravar áudio" title="Gravar áudio" disabled data-paidegua="mic">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3"></rect>
          <path d="M5 10v2a7 7 0 0 0 14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="22"></line>
          <line x1="8" y1="22" x2="16" y2="22"></line>
        </svg>
      </button>
      <textarea
        class="paidegua-sidebar__input"
        rows="1"
        placeholder="Digite sua pergunta ou clique no microfone…"
        disabled
        data-paidegua="input"
      ></textarea>
      <button type="button" class="paidegua-sidebar__send" aria-label="Enviar" title="Enviar" disabled data-paidegua="send">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </footer>
  `;

  const q = <T extends HTMLElement>(name: string): T => {
    const el = aside.querySelector<T>(`[data-paidegua="${name}"]`);
    if (!el) {
      throw new Error(`PAIdegua: elemento data-paidegua="${name}" ausente.`);
    }
    return el;
  };

  const processoLabel = q<HTMLElement>('processo-label');
  const providerLabel = q<HTMLElement>('provider-label');
  const loadDocsButton = q<HTMLButtonElement>('load-documents');
  const ocrButton = q<HTMLButtonElement>('ocr-pendentes');
  const resumirButton = q<HTMLButtonElement>('resumir');
  const minutarButton = q<HTMLButtonElement>('minutar');
  const audioButton = q<HTMLButtonElement>('audio-summary');
  const anonimizarButton = q<HTMLButtonElement>('anonimizar');
  const templateActionButtons = new Map<string, HTMLButtonElement>();
  for (const btn of Array.from(
    aside.querySelectorAll<HTMLButtonElement>('[data-paidegua="template-action"]')
  )) {
    const id = btn.dataset.actionId;
    if (id) templateActionButtons.set(id, btn);
  }
  const bodyEl = q<HTMLElement>('body');
  const textarea = q<HTMLTextAreaElement>('input');
  const sendButton = q<HTMLButtonElement>('send');
  const micButton = q<HTMLButtonElement>('mic');
  const globalNotice = q<HTMLElement>('global-notice');

  processoLabel.textContent = formatDetectionLabel(detection);

  // Placeholder inicial até carregar documentos.
  bodyEl.innerHTML =
    '<p style="color: var(--paidegua-text-muted); font-size: 13px; text-align:center; margin: auto 0; line-height:1.5;">' +
    'Clique em <strong>Carregar Documentos</strong> para listar as peças<br/>' +
    'dos autos digitais.' +
    '</p>';

  loadDocsButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onLoadDocuments();
  });

  const closeButton = aside.querySelector<HTMLButtonElement>('.paidegua-sidebar__close');
  closeButton?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    aside.classList.remove('is-open');
    options.onClose?.();
  });

  shadow.appendChild(aside);

  const elements: SidebarElements = {
    body: bodyEl,
    textarea,
    sendButton,
    micButton,
    loadDocsButton,
    ocrButton,
    resumirButton,
    minutarButton,
    audioButton,
    anonimizarButton,
    templateActionButtons,
    providerLabel,
    globalNotice
  };

  return {
    open(): void {
      aside.classList.add('is-open');
    },
    close(): void {
      aside.classList.remove('is-open');
    },
    toggle(): void {
      aside.classList.toggle('is-open');
    },
    isOpen(): boolean {
      return aside.classList.contains('is-open');
    },
    updateDetection(next: PJeDetection): void {
      processoLabel.textContent = formatDetectionLabel(next);
    },
    setLoadDocsLabel(label: string): void {
      loadDocsButton.textContent = label;
    },
    setLoadDocsEnabled(enabled: boolean): void {
      loadDocsButton.disabled = !enabled;
    },
    setExtractedFeaturesEnabled(enabled: boolean): void {
      resumirButton.disabled = !enabled;
      minutarButton.disabled = !enabled;
      audioButton.disabled = !enabled;
      anonimizarButton.disabled = !enabled;
      for (const btn of templateActionButtons.values()) {
        btn.disabled = !enabled;
      }
    },
    setChatEnabled(enabled: boolean): void {
      textarea.disabled = !enabled;
      sendButton.disabled = !enabled;
      micButton.disabled = !enabled;
    },
    setOcrPending(count: number, running = false): void {
      if (count <= 0) {
        ocrButton.style.display = 'none';
        ocrButton.disabled = true;
        return;
      }
      ocrButton.style.display = '';
      ocrButton.disabled = running;
      ocrButton.textContent = running
        ? `Rodando OCR…`
        : `Rodar OCR em ${count} doc${count > 1 ? 's' : ''} pendente${count > 1 ? 's' : ''}`;
    },
    setProviderLabel(label: string): void {
      providerLabel.textContent = label;
    },
    setGlobalNotice(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
      globalNotice.classList.remove('is-info', 'is-warn', 'is-error', 'is-visible');
      if (!text) {
        globalNotice.textContent = '';
        return;
      }
      globalNotice.textContent = text;
      globalNotice.classList.add('is-visible', `is-${kind}`);
    },
    get elements(): SidebarElements {
      return elements;
    },
    destroy(): void {
      aside.remove();
    }
  };
}
