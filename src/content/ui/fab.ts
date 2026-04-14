/**
 * Floating Action Button (FAB) do PAIdegua.
 *
 * Botão circular fixo no canto inferior direito da página do PJe. Ao ser
 * clicado, dispara o callback fornecido pelo content script (tipicamente:
 * alternar a visibilidade do sidebar).
 *
 * Renderizado dentro do Shadow DOM criado por shell.ts — estilos isolados
 * via <style> próprio no shadow root.
 */

export interface FabController {
  setVisible(visible: boolean): void;
  setTooltip(text: string): void;
  destroy(): void;
}

export interface FabOptions {
  onClick: () => void;
  tooltip?: string;
}

const FAB_CSS = `
.paidegua-fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: var(--paidegua-gradient);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 14px 32px rgba(19, 81, 180, 0.40), 0 4px 10px rgba(12, 50, 111, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.25);
  pointer-events: auto;
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 220ms ease, opacity 220ms ease;
  opacity: 0;
  transform: translateY(12px) scale(0.95);
}

.paidegua-fab::after {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  background: radial-gradient(closest-side, rgba(89, 146, 237, 0.45), transparent 70%);
  z-index: -1;
  opacity: 0;
  transition: opacity 220ms ease;
}

.paidegua-fab.is-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.paidegua-fab:hover {
  transform: translateY(-3px) scale(1.04);
  box-shadow: 0 20px 44px rgba(19, 81, 180, 0.48), 0 6px 14px rgba(12, 50, 111, 0.24);
}

.paidegua-fab:hover::after { opacity: 1; }

.paidegua-fab:active {
  transform: translateY(0) scale(0.97);
}

.paidegua-fab:focus-visible {
  outline: 3px solid rgba(255, 205, 7, 0.85);
  outline-offset: 3px;
}

.paidegua-fab__icon {
  width: 28px;
  height: 28px;
  display: block;
}

.paidegua-fab__tooltip {
  position: absolute;
  right: 70px;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: var(--paidegua-blur);
  -webkit-backdrop-filter: var(--paidegua-blur);
  color: var(--paidegua-primary-dark);
  padding: 7px 12px;
  border-radius: var(--paidegua-radius-sm);
  border: 1px solid var(--paidegua-border);
  font-family: var(--paidegua-font);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 180ms ease, transform 180ms ease;
  box-shadow: 0 10px 24px rgba(12, 50, 111, 0.16);
}

.paidegua-fab:hover .paidegua-fab__tooltip,
.paidegua-fab:focus-visible .paidegua-fab__tooltip {
  opacity: 1;
  transform: translateY(-50%) translateX(-2px);
}
`;

/**
 * SVG da logo do pAIdegua — monograma "p" com nucleo de IA em amarelo.
 * A haste e o anel sao desenhados em currentColor (branco no FAB), e o
 * nucleo amarelo (#FFCD07) marca o "AI" embutido no nome.
 */
const FAB_ICON_SVG = `
<svg class="paidegua-fab__icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="6.6" y="4.08" width="2.88" height="17.04" rx="1.2" fill="currentColor"/>
  <circle cx="14.28" cy="10.32" r="4.62" fill="none" stroke="currentColor" stroke-width="2.52"/>
  <circle cx="14.28" cy="10.32" r="2.04" fill="#FFCD07"/>
</svg>
`;

export function mountFab(shadow: ShadowRoot, options: FabOptions): FabController {
  // Anexa o CSS do FAB ao shadow root uma única vez.
  if (!shadow.querySelector('style[data-paidegua="fab"]')) {
    const style = document.createElement('style');
    style.setAttribute('data-paidegua', 'fab');
    style.textContent = FAB_CSS;
    shadow.appendChild(style);
  }

  const button = document.createElement('button');
  button.className = 'paidegua-fab';
  button.type = 'button';
  button.setAttribute('aria-label', 'Abrir pAIdegua');

  button.innerHTML = FAB_ICON_SVG;

  const tooltip = document.createElement('span');
  tooltip.className = 'paidegua-fab__tooltip';
  tooltip.textContent = options.tooltip ?? 'pAIdegua — Assistente com IA';
  button.appendChild(tooltip);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onClick();
  });

  shadow.appendChild(button);

  // Pequeno atraso para permitir a transição de entrada.
  requestAnimationFrame(() => {
    button.classList.add('is-visible');
  });

  return {
    setVisible(visible: boolean): void {
      button.classList.toggle('is-visible', visible);
    },
    setTooltip(text: string): void {
      tooltip.textContent = text;
    },
    destroy(): void {
      button.remove();
    }
  };
}
