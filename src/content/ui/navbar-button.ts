/**
 * Botão do PAIdegua injetado diretamente na navbar do PJe.
 *
 * Diferente do FAB (flutuante, em Shadow DOM), este botão vive no DOM
 * da própria página, como um <li> irmão à esquerda dos elementos nativos:
 *
 *   <ul class="nav navbar-nav navbar-right mr-5">       ← menu-usuario
 *   <ul class="nav navbar-nav navbar-right menu-icones-topo">
 *
 * Fica visível sempre que esses elementos existirem na página,
 * independentemente de estar em uma tela de autos — acionar o pAIdegua
 * a partir de qualquer tela institucional é uma escolha deliberada.
 *
 * Classes são prefixadas com `paidegua-navbtn__*` para evitar vazamento
 * e colisão com o CSS do PJe. Estilos inline complementam onde o reset
 * do PJe for agressivo (o PJe usa bootstrap + tema institucional).
 */

const HOST_CLASS = 'paidegua-navbtn-host';
const HOST_STYLE_ATTR = 'data-paidegua-navbtn-style';

/**
 * Seletores (na ordem de preferência) onde o botão deve ser inserido como
 * irmão imediatamente anterior. Um único match basta — o PJe costuma ter
 * ambos os `<ul>` lado a lado no mesmo header.
 */
const ANCHOR_SELECTORS = [
  'ul.nav.navbar-nav.navbar-right.mr-5',
  'ul.nav.navbar-nav.navbar-right.menu-icones-topo',
  // Fallback genérico: algumas telas do PJe (painel do usuário, tarefa
  // aberta) podem não ter as classes utilitárias mr-5/menu-icones-topo,
  // mas mantêm navbar-right no mesmo header.
  'ul.nav.navbar-nav.navbar-right'
];

const NAVBTN_CSS = `
.paidegua-navbtn-host {
  display: inline-flex;
  align-items: center;
  align-self: center;
  /* Padding vertical replica o 15px dos <a> nativos do .navbar-nav do
     Bootstrap 3 (ajustado para casar com o botão interno de 7px). Assim
     o item fica com a mesma altura total dos demais e "desce" para o
     centro visual do header quando o container é float-based. */
  margin: 0 10px 0 0;
  padding: 9px 0;
  list-style: none;
  float: none;
  height: auto;
  vertical-align: middle;
}
.paidegua-navbtn-host .paidegua-navbtn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  background: transparent;
  color: rgba(255, 255, 255, 0.92);
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: 0.15px;
  line-height: 1.1;
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
  text-decoration: none;
  white-space: nowrap;
  vertical-align: middle;
}
.paidegua-navbtn-host .paidegua-navbtn:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.45);
  color: #ffffff;
}
.paidegua-navbtn-host .paidegua-navbtn:active {
  background: rgba(255, 255, 255, 0.18);
}
.paidegua-navbtn-host .paidegua-navbtn:focus-visible {
  outline: 2px solid rgba(255, 205, 7, 0.8);
  outline-offset: 2px;
}
.paidegua-navbtn-host .paidegua-navbtn__icon {
  width: 17px;
  height: 17px;
  display: block;
  flex-shrink: 0;
}
.paidegua-navbtn-host .paidegua-navbtn__label em {
  font-style: normal;
  color: #FFCD07;
  font-weight: 700;
}

/*
 * Modo "centralizado": usado em telas sem o menu-usuario (painel do usuário,
 * tarefa aberta). Posiciona o botão no centro horizontal e vertical do
 * container do header, desprendendo-o do fluxo normal.
 */
.paidegua-navbtn-host.paidegua-navbtn-host--centered {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  margin: 0;
  padding: 0;
  z-index: 10;
}
`;

const NAVBTN_ICON_SVG = `
<svg class="paidegua-navbtn__icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="6.6" y="4.08" width="2.88" height="17.04" rx="1.2" fill="currentColor"/>
  <circle cx="14.28" cy="10.32" r="4.62" fill="none" stroke="currentColor" stroke-width="2.52"/>
  <circle cx="14.28" cy="10.32" r="2.04" fill="#FFCD07"/>
</svg>
`;

export interface NavbarButtonOptions {
  onClick: () => void;
}

export interface NavbarButtonController {
  /** True sempre que o botão estiver atualmente inserido em algum `<ul>` âncora. */
  isMounted(): boolean;
  destroy(): void;
}

function ensureStyleInjected(): void {
  if (document.head.querySelector(`style[${HOST_STYLE_ATTR}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(HOST_STYLE_ATTR, '');
  style.textContent = NAVBTN_CSS;
  document.head.appendChild(style);
}

function findAnchors(): HTMLElement[] {
  const anchors: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const selector of ANCHOR_SELECTORS) {
    const list = document.querySelectorAll<HTMLElement>(selector);
    list.forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        anchors.push(el);
      }
    });
  }
  return anchors;
}

/**
 * Escolhe o primeiro anchor que seja o mais à esquerda dentro do mesmo
 * container. Na prática, se existirem os dois `<ul>` (usuário + ícones),
 * o "mais à esquerda" é aquele que aparece primeiro no DOM dentro do
 * mesmo pai — inserir antes dele garante o posicionamento desejado.
 */
function pickPrimaryAnchor(anchors: HTMLElement[]): HTMLElement | null {
  if (anchors.length === 0) return null;
  // Ordena os anchors por posição no documento — o primeiro é o alvo.
  anchors.sort((a, b) => {
    const rel = a.compareDocumentPosition(b);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return anchors[0] ?? null;
}

function buildButton(onClick: () => void): HTMLLIElement {
  const host = document.createElement('li');
  host.className = HOST_CLASS;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-navbtn';
  btn.setAttribute('aria-label', 'Abrir pAIdegua');
  btn.innerHTML = `${NAVBTN_ICON_SVG}<span class="paidegua-navbtn__label">p<em>AI</em>degua</span>`;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });

  host.appendChild(btn);
  return host;
}

/**
 * Telas "reduzidas" (painel do usuário, tarefa aberta) marcam o
 * `li.menu-usuario` com `display:none`. Esse é nosso sinal para trocar do
 * modo inline (ao lado do menu do usuário) para o modo centralizado —
 * o botão flutua no meio do header em vez de grudar no canto direito.
 */
function isReducedHeader(): boolean {
  const menuUsuario = document.querySelector<HTMLElement>('li.menu-usuario');
  if (!menuUsuario) return false;
  return window.getComputedStyle(menuUsuario).display === 'none';
}

/**
 * Devolve o container mais alto do header (navbar ou navbar-header) para
 * usar como referência de posicionamento do modo centralizado. Também
 * garante `position: relative` caso esteja como `static`, sem quebrar
 * outros estilos do PJe (o relative é neutro para o fluxo normal).
 */
function resolveHeaderContainer(anchor: HTMLElement): HTMLElement | null {
  const container =
    anchor.closest<HTMLElement>('.navbar-header') ??
    anchor.closest<HTMLElement>('.navbar') ??
    anchor.parentElement;
  if (!container) return null;
  if (window.getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }
  return container;
}

/**
 * Monta o botão na navbar do PJe. Retorna um controller com
 * `isMounted()` — consumidores usam para decidir se escondem o FAB.
 *
 * Observa o DOM: se o PJe reescrever o header (navegação AJAX do PrimeFaces
 * ou troca de tela), reanexa o botão. Também troca entre modo inline e
 * modo centralizado de acordo com a visibilidade do menu-usuario.
 */
export function mountNavbarButton(options: NavbarButtonOptions): NavbarButtonController {
  ensureStyleInjected();

  let hostLi: HTMLLIElement | null = null;
  let currentMode: 'inline' | 'centered' | null = null;

  const attach = (): void => {
    const anchors = findAnchors();
    const anchor = pickPrimaryAnchor(anchors);
    if (!anchor) {
      // Âncora sumiu — limpa referência para permitir remontagem limpa.
      hostLi?.remove();
      hostLi = null;
      currentMode = null;
      return;
    }

    const mode: 'inline' | 'centered' = isReducedHeader() ? 'centered' : 'inline';

    // Se já está montado, conectado E no modo correto, nada a fazer.
    if (hostLi && hostLi.isConnected && currentMode === mode) {
      return;
    }

    // Reconstrói (ou remonta) o botão — garante que o modo atual
    // esteja refletido tanto em classe quanto em posição no DOM.
    hostLi?.remove();
    const next = buildButton(options.onClick);
    if (mode === 'centered') {
      next.classList.add('paidegua-navbtn-host--centered');
      const container = resolveHeaderContainer(anchor);
      (container ?? anchor.parentElement)?.appendChild(next);
    } else {
      anchor.parentElement?.insertBefore(next, anchor);
    }
    hostLi = next;
    currentMode = mode;
  };

  attach();

  const observer = new MutationObserver(() => {
    attach();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  return {
    isMounted(): boolean {
      return Boolean(hostLi && hostLi.isConnected);
    },
    destroy(): void {
      observer.disconnect();
      hostLi?.remove();
      hostLi = null;
      document.head.querySelector(`style[${HOST_STYLE_ATTR}]`)?.remove();
    }
  };
}
