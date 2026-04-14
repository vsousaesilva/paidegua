/**
 * Componente de chat conversacional renderizado dentro do sidebar.
 *
 * Mantém o histórico em memória (Map de mensagens), renderiza bolhas
 * user/assistant com markdown leve, e expõe métodos para o orquestrador
 * acrescentar chunks de streaming na bolha do assistant em tempo real.
 *
 * O envio para a API é feito pelo content.ts via porta long-lived; este
 * módulo só se preocupa com UI.
 */

import type { ChatMessage } from '../../shared/types';
import { renderMarkdown } from './markdown';

export interface ChatBubbleAction {
  id: string;
  label: string;
  title?: string;
  /** Recebe o HTML renderizado da bolha e o texto cru markdown. */
  onClick: (html: string, markdown: string) => void;
}

export interface ChatOptions {
  /** Ações renderizadas como botões no rodapé de cada bolha do assistant. */
  bubbleActions?: ChatBubbleAction[];
}

/** Botão de uma mensagem interativa do sistema (picker, refinamento, etc.). */
export interface InteractiveChoice {
  id: string;
  label: string;
  /** Se true, renderiza com destaque (cor de acento). */
  primary?: boolean;
  /** Se true, descarta a mensagem após o clique sem desabilitar nada. */
  cancel?: boolean;
}

export interface InteractiveMessage {
  /** Texto principal (markdown leve renderizado). */
  text: string;
  /** Opções clicáveis. */
  choices: InteractiveChoice[];
  /** Callback ao clicar em uma opção. Recebe o id escolhido. */
  onChoose: (choiceId: string) => void;
}

export interface InputPromptOptions {
  /** Texto explicativo (markdown leve renderizado). */
  text: string;
  /** Placeholder do textarea. */
  placeholder?: string;
  /** Rótulo do botão primário (que confirma com o texto digitado). */
  confirmLabel: string;
  /** Rótulo do botão secundário (opcional — avança sem orientação). */
  skipLabel?: string;
  /** Chamado com o texto digitado (trimado). String vazia quando pulou. */
  onConfirm: (value: string) => void;
  /** Chamado se o usuário cancelar a bolha. Opcional. */
  onCancel?: () => void;
}

/** Opções para customizar a próxima bolha do assistant. */
export interface BeginAssistantOptions {
  /**
   * Se presente, o rodapé daquela bolha exibirá apenas as ações cujo `id`
   * estiver na lista (na mesma ordem do array). Útil para distinguir
   * resumos (apenas Copiar/Baixar) de minutas (todos os botões).
   */
  allowedActionIds?: string[];
}

export interface ChatController {
  addUserMessage(text: string): void;
  beginAssistantMessage(opts?: BeginAssistantOptions): void;
  appendAssistantDelta(delta: string): void;
  endAssistantMessage(): void;
  failAssistantMessage(error: string): void;
  /**
   * Insere uma "bolha de sistema" com botões clicáveis. Após o clique,
   * a bolha congela mostrando a opção escolhida e os demais botões somem.
   * Use para fluxos como "Usar modelo similar" / "Gerar do zero".
   * Retorna uma função que remove a bolha (para casos de cancelamento externo).
   */
  addInteractiveMessage(msg: InteractiveMessage): () => void;
  /**
   * Insere uma bolha de sistema com um campo de texto multilinha e
   * botões de ação. Usado para coletar orientações livres do usuário
   * antes de disparar uma ação (ex.: minuta). O callback recebe o texto
   * digitado (trim) ou string vazia se o usuário pular.
   */
  addInputPrompt(opts: InputPromptOptions): () => void;
  /** Insere texto puro de sistema (sem botões), para status passageiros. */
  addSystemText(text: string): HTMLDivElement;
  getMessages(): ChatMessage[];
  clear(): void;
  setSystemNotice(text: string): void;
  destroy(): void;
}

const CHAT_CSS = `
.paidegua-chat {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  flex: 1;
}

.paidegua-chat__notice {
  font-size: 11px;
  color: var(--paidegua-primary-dark);
  background: rgba(19, 81, 180, 0.07);
  border: 1px solid rgba(19, 81, 180, 0.18);
  border-radius: var(--paidegua-radius-sm);
  padding: 9px 12px;
  line-height: 1.4;
  display: none;
}

.paidegua-chat__notice.is-visible { display: block; }

.paidegua-chat__messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(19, 81, 180, 0.25) transparent;
}

.paidegua-chat__bubble {
  max-width: 92%;
  padding: 12px 14px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.5;
  word-wrap: break-word;
  box-shadow: 0 2px 8px rgba(12, 50, 111, 0.06);
}

.paidegua-chat__bubble.is-user {
  align-self: flex-end;
  background: var(--paidegua-gradient);
  color: #ffffff;
  border-bottom-right-radius: 4px;
  box-shadow: 0 6px 18px rgba(19, 81, 180, 0.22);
}

.paidegua-chat__bubble.is-assistant {
  align-self: flex-start;
  background: rgba(255, 255, 255, 0.92);
  color: var(--paidegua-text);
  border: 1px solid var(--paidegua-border);
  border-bottom-left-radius: 4px;
}

.paidegua-chat__bubble.is-error {
  border-color: rgba(192, 57, 43, 0.45);
  background: rgba(192, 57, 43, 0.06);
  color: #b03030;
}

.paidegua-chat__bubble.is-system {
  align-self: stretch;
  max-width: 100%;
  background: rgba(19, 81, 180, 0.05);
  border: 1px dashed rgba(19, 81, 180, 0.32);
  color: var(--paidegua-primary-dark);
  font-size: 12px;
}

.paidegua-chat__bubble.is-system .paidegua-chat__system-text {
  margin-bottom: 8px;
  line-height: 1.5;
}
.paidegua-chat__bubble.is-system .paidegua-chat__system-text:last-child {
  margin-bottom: 0;
}

.paidegua-chat__bubble.is-system .paidegua-chat__system-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.paidegua-chat__bubble.is-system .paidegua-chat__system-choices button {
  background: rgba(255, 255, 255, 0.85);
  color: var(--paidegua-primary-dark);
  border: 1px solid var(--paidegua-border-strong);
  border-radius: var(--paidegua-radius-sm);
  padding: 7px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: all 160ms ease;
}
.paidegua-chat__bubble.is-system .paidegua-chat__system-choices button:hover {
  background: rgba(19, 81, 180, 0.10);
  border-color: var(--paidegua-primary);
  transform: translateY(-1px);
}
.paidegua-chat__bubble.is-system .paidegua-chat__system-choices button.is-primary {
  background: var(--paidegua-gradient);
  color: #ffffff;
  border-color: transparent;
  box-shadow: 0 4px 12px rgba(19, 81, 180, 0.24);
}
.paidegua-chat__bubble.is-system .paidegua-chat__system-resolved {
  font-style: italic;
  color: var(--paidegua-text-muted);
  font-size: 11px;
}

.paidegua-chat__input-prompt {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.paidegua-chat__input-prompt textarea {
  width: 100%;
  min-height: 72px;
  max-height: 200px;
  resize: vertical;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.4;
  border: 1px solid rgba(19, 81, 180, 0.28);
  border-radius: 8px;
  background: #ffffff;
  color: var(--paidegua-text);
  box-sizing: border-box;
}
.paidegua-chat__input-prompt textarea:focus {
  outline: none;
  border-color: var(--paidegua-primary);
  box-shadow: 0 0 0 2px rgba(19, 81, 180, 0.18);
}
.paidegua-chat__input-prompt-resolved {
  margin-top: 6px;
  padding: 8px 10px;
  background: rgba(19, 81, 180, 0.06);
  border-left: 3px solid var(--paidegua-primary);
  border-radius: 4px;
  font-size: 12px;
  white-space: pre-wrap;
  color: var(--paidegua-text);
}
.paidegua-chat__input-prompt-resolved.is-empty {
  font-style: italic;
  color: var(--paidegua-text-muted);
  border-left-color: var(--paidegua-text-muted);
}

.paidegua-chat__bubble p { margin: 0 0 6px 0; }
.paidegua-chat__bubble p:last-child { margin-bottom: 0; }
.paidegua-chat__bubble ul, .paidegua-chat__bubble ol { margin: 4px 0 6px 18px; padding: 0; }
.paidegua-chat__bubble code {
  background: rgba(19, 81, 180, 0.10);
  color: var(--paidegua-primary-dark);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
}
.paidegua-chat__bubble.is-user code { background: rgba(255, 255, 255, 0.22); color: #ffffff; }
.paidegua-chat__bubble pre {
  background: rgba(12, 50, 111, 0.07);
  border: 1px solid rgba(19, 81, 180, 0.14);
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 8px 0;
}
.paidegua-chat__bubble pre code { background: transparent; padding: 0; }

.paidegua-chat__bubble-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--paidegua-border);
  flex-wrap: wrap;
}
.paidegua-chat__bubble-actions button {
  background: rgba(255, 255, 255, 0.6);
  color: var(--paidegua-primary-dark);
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 160ms ease;
}
.paidegua-chat__bubble-actions button:hover {
  background: rgba(19, 81, 180, 0.10);
  border-color: var(--paidegua-primary);
  transform: translateY(-1px);
}
.paidegua-chat__bubble-actions button.is-success {
  color: #1e7e34;
  border-color: #1e7e34;
  background: rgba(30, 126, 52, 0.08);
}

.paidegua-chat__cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  background: currentColor;
  margin-left: 1px;
  animation: paidegua-blink 1s step-start infinite;
  vertical-align: text-bottom;
}

@keyframes paidegua-blink { 50% { opacity: 0; } }

.paidegua-chat__empty {
  text-align: center;
  color: var(--paidegua-text-muted);
  font-size: 12px;
  padding: 20px 8px;
  line-height: 1.5;
}
`;

function ensureStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector('style[data-paidegua="chat"]')) {
    return;
  }
  const style = document.createElement('style');
  style.setAttribute('data-paidegua', 'chat');
  style.textContent = CHAT_CSS;
  shadow.appendChild(style);
}

export function mountChat(
  shadow: ShadowRoot,
  container: HTMLElement,
  options: ChatOptions = {}
): ChatController {
  ensureStyle(shadow);
  const bubbleActions = options.bubbleActions ?? [];

  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'paidegua-chat';

  const notice = document.createElement('div');
  notice.className = 'paidegua-chat__notice';

  const messagesEl = document.createElement('div');
  messagesEl.className = 'paidegua-chat__messages';

  const empty = document.createElement('div');
  empty.className = 'paidegua-chat__empty';
  empty.textContent =
    'Faça uma pergunta sobre o processo, use os botões de ação rápida, ou envie um áudio.';
  messagesEl.append(empty);

  wrap.append(notice, messagesEl);
  container.append(wrap);

  const messages: ChatMessage[] = [];
  let currentAssistantBubble: HTMLDivElement | null = null;
  let currentAssistantText = '';
  let cursorEl: HTMLSpanElement | null = null;
  let currentAssistantOpts: BeginAssistantOptions | null = null;

  function removeEmpty(): void {
    if (empty.parentElement) {
      empty.remove();
    }
  }

  function scrollToBottom(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function makeBubble(role: 'user' | 'assistant'): HTMLDivElement {
    const bubble = document.createElement('div');
    bubble.className = `paidegua-chat__bubble is-${role}`;
    return bubble;
  }

  function appendBubbleActions(
    bubble: HTMLDivElement,
    html: string,
    markdown: string,
    opts: BeginAssistantOptions | null
  ): void {
    let actionsToRender = bubbleActions;
    if (opts?.allowedActionIds && opts.allowedActionIds.length > 0) {
      const allow = new Set(opts.allowedActionIds);
      actionsToRender = opts.allowedActionIds
        .map((id) => bubbleActions.find((a) => a.id === id))
        .filter((a): a is ChatBubbleAction => !!a && allow.has(a.id));
    }
    if (actionsToRender.length === 0) return;
    const bar = document.createElement('div');
    bar.className = 'paidegua-chat__bubble-actions';
    for (const action of actionsToRender) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      if (action.title) {
        btn.title = action.title;
      }
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        action.onClick(html, markdown);
      });
      bar.append(btn);
    }
    bubble.append(bar);
  }

  return {
    addUserMessage(text: string): void {
      removeEmpty();
      const bubble = makeBubble('user');
      bubble.textContent = text;
      messagesEl.append(bubble);
      messages.push({ role: 'user', content: text, timestamp: Date.now() });
      scrollToBottom();
    },

    beginAssistantMessage(opts?: BeginAssistantOptions): void {
      removeEmpty();
      currentAssistantText = '';
      currentAssistantOpts = opts ?? null;
      currentAssistantBubble = makeBubble('assistant');
      cursorEl = document.createElement('span');
      cursorEl.className = 'paidegua-chat__cursor';
      currentAssistantBubble.append(cursorEl);
      messagesEl.append(currentAssistantBubble);
      scrollToBottom();
    },

    appendAssistantDelta(delta: string): void {
      if (!currentAssistantBubble) {
        this.beginAssistantMessage();
      }
      currentAssistantText += delta;
      if (currentAssistantBubble) {
        currentAssistantBubble.innerHTML =
          renderMarkdown(currentAssistantText) +
          '<span class="paidegua-chat__cursor"></span>';
        scrollToBottom();
      }
    },

    endAssistantMessage(): void {
      if (currentAssistantBubble) {
        const renderedHtml = renderMarkdown(currentAssistantText);
        currentAssistantBubble.innerHTML = renderedHtml;
        if (bubbleActions.length > 0 && currentAssistantText.trim().length > 0) {
          appendBubbleActions(
            currentAssistantBubble,
            renderedHtml,
            currentAssistantText,
            currentAssistantOpts
          );
        }
      }
      if (currentAssistantText.length > 0) {
        messages.push({
          role: 'assistant',
          content: currentAssistantText,
          timestamp: Date.now()
        });
      }
      currentAssistantBubble = null;
      currentAssistantText = '';
      currentAssistantOpts = null;
      cursorEl = null;
      scrollToBottom();
    },

    failAssistantMessage(error: string): void {
      if (!currentAssistantBubble) {
        currentAssistantBubble = makeBubble('assistant');
        messagesEl.append(currentAssistantBubble);
      }
      currentAssistantBubble.classList.add('is-error');
      currentAssistantBubble.textContent = `Erro: ${error}`;
      currentAssistantBubble = null;
      currentAssistantText = '';
      cursorEl = null;
      scrollToBottom();
    },

    getMessages(): ChatMessage[] {
      return [...messages];
    },

    clear(): void {
      messages.length = 0;
      messagesEl.innerHTML = '';
      messagesEl.append(empty);
      currentAssistantBubble = null;
      currentAssistantText = '';
      cursorEl = null;
    },

    setSystemNotice(text: string): void {
      if (!text) {
        notice.textContent = '';
        notice.classList.remove('is-visible');
        return;
      }
      notice.textContent = text;
      notice.classList.add('is-visible');
    },

    addInteractiveMessage(msg: InteractiveMessage): () => void {
      removeEmpty();
      const bubble = document.createElement('div');
      bubble.className = 'paidegua-chat__bubble is-system';

      const textEl = document.createElement('div');
      textEl.className = 'paidegua-chat__system-text';
      textEl.innerHTML = renderMarkdown(msg.text);
      bubble.append(textEl);

      const choicesWrap = document.createElement('div');
      choicesWrap.className = 'paidegua-chat__system-choices';
      for (const choice of msg.choices) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = choice.label;
        if (choice.primary) btn.classList.add('is-primary');
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (choice.cancel) {
            bubble.remove();
            return;
          }
          // Substitui os botões pelo "resolvido".
          choicesWrap.remove();
          const resolved = document.createElement('div');
          resolved.className = 'paidegua-chat__system-resolved';
          resolved.textContent = `Você escolheu: ${choice.label}`;
          bubble.append(resolved);
          msg.onChoose(choice.id);
        });
        choicesWrap.append(btn);
      }
      bubble.append(choicesWrap);

      messagesEl.append(bubble);
      scrollToBottom();
      return (): void => bubble.remove();
    },

    addInputPrompt(opts: InputPromptOptions): () => void {
      removeEmpty();
      const bubble = document.createElement('div');
      bubble.className = 'paidegua-chat__bubble is-system';

      const textEl = document.createElement('div');
      textEl.className = 'paidegua-chat__system-text';
      textEl.innerHTML = renderMarkdown(opts.text);
      bubble.append(textEl);

      const wrap = document.createElement('div');
      wrap.className = 'paidegua-chat__input-prompt';

      const textarea = document.createElement('textarea');
      textarea.placeholder = opts.placeholder ?? '';
      textarea.rows = 4;
      wrap.append(textarea);

      const choicesWrap = document.createElement('div');
      choicesWrap.className = 'paidegua-chat__system-choices';

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.textContent = opts.confirmLabel;
      confirmBtn.classList.add('is-primary');

      const finalize = (value: string): void => {
        wrap.remove();
        choicesWrap.remove();
        const resolved = document.createElement('div');
        resolved.className = 'paidegua-chat__input-prompt-resolved';
        if (value) {
          resolved.textContent = value;
        } else {
          resolved.textContent = '(sem orientações adicionais)';
          resolved.classList.add('is-empty');
        }
        bubble.append(resolved);
        opts.onConfirm(value);
      };

      confirmBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        finalize(textarea.value.trim());
      });
      choicesWrap.append(confirmBtn);

      if (opts.skipLabel) {
        const skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.textContent = opts.skipLabel;
        skipBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          finalize('');
        });
        choicesWrap.append(skipBtn);
      }

      if (opts.onCancel) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancelar';
        cancelBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          bubble.remove();
          opts.onCancel?.();
        });
        choicesWrap.append(cancelBtn);
      }

      // Ctrl/Cmd+Enter envia; Enter sozinho faz quebra de linha.
      textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          finalize(textarea.value.trim());
        }
      });

      bubble.append(wrap);
      bubble.append(choicesWrap);

      messagesEl.append(bubble);
      scrollToBottom();
      // Foco no textarea para o usuário digitar direto.
      setTimeout(() => textarea.focus(), 0);
      return (): void => bubble.remove();
    },

    addSystemText(text: string): HTMLDivElement {
      removeEmpty();
      const bubble = document.createElement('div');
      bubble.className = 'paidegua-chat__bubble is-system';
      const textEl = document.createElement('div');
      textEl.className = 'paidegua-chat__system-text';
      textEl.innerHTML = renderMarkdown(text);
      bubble.append(textEl);
      messagesEl.append(bubble);
      scrollToBottom();
      return bubble;
    },

    destroy(): void {
      wrap.remove();
    }
  };
}
