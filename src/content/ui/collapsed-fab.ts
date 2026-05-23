/**
 * Botão flutuante de retorno do sidebar.
 *
 * Aparece na lateral direita da viewport, em altura média, com a logo do
 * pAIdegua e transparência. Sem ele, recolher o sidebar para ler um
 * documento do PJe deixaria o usuário sem caminho rápido de volta ao
 * conteúdo (chat, análise) que já está montado no DOM. Clicar reabre
 * o sidebar mantendo todo o estado.
 */

export interface CollapsedFabController {
  show(): void;
  hide(): void;
  destroy(): void;
}

const STYLE_ATTR = 'data-paidegua';
const STYLE_KEY = 'collapsed-fab';

const CSS = `
.paidegua-collapsed-fab {
  position: fixed;
  right: 12px;
  top: 50%;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--paidegua-gradient);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-50%) translateX(8px);
  transition: opacity 220ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 220ms;
  box-shadow: 0 8px 18px rgba(19, 81, 180, 0.28), 0 2px 6px rgba(12, 50, 111, 0.18);
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.4);
  padding: 0;
}

.paidegua-collapsed-fab.is-visible {
  opacity: 0.55;
  visibility: visible;
  transform: translateY(-50%) translateX(0);
  transition: opacity 220ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 0s;
}

.paidegua-collapsed-fab.is-visible:hover,
.paidegua-collapsed-fab.is-visible:focus-visible {
  opacity: 1;
  transform: translateY(-50%) translateX(-2px);
}

.paidegua-collapsed-fab:focus-visible {
  outline: 3px solid rgba(255, 205, 7, 0.85);
  outline-offset: 2px;
}

.paidegua-collapsed-fab__icon {
  width: 24px;
  height: 24px;
  display: block;
}
`;

const ICON_SVG = `
<svg class="paidegua-collapsed-fab__icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="6.6" y="4.08" width="2.88" height="17.04" rx="1.2" fill="currentColor"/>
  <circle cx="14.28" cy="10.32" r="4.62" fill="none" stroke="currentColor" stroke-width="2.52"/>
  <circle cx="14.28" cy="10.32" r="2.04" fill="#FFCD07"/>
</svg>
`;

export function mountCollapsedFab(
  shadow: ShadowRoot,
  onClick: () => void
): CollapsedFabController {
  if (!shadow.querySelector(`style[${STYLE_ATTR}="${STYLE_KEY}"]`)) {
    const style = document.createElement('style');
    style.setAttribute(STYLE_ATTR, STYLE_KEY);
    style.textContent = CSS;
    shadow.appendChild(style);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-collapsed-fab';
  btn.setAttribute('aria-label', 'Reabrir pAIdegua');
  btn.title = 'Reabrir pAIdegua';
  btn.innerHTML = ICON_SVG;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  shadow.appendChild(btn);

  return {
    show(): void {
      btn.classList.add('is-visible');
    },
    hide(): void {
      btn.classList.remove('is-visible');
    },
    destroy(): void {
      btn.remove();
    }
  };
}
