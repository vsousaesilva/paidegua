/**
 * Transforma menções a IDs de documentos do PJe (formato "(id 12345678)"
 * ou "id 12345678") em botões clicáveis que ativam o documento no painel
 * do processo via `activateDocumentInPje`.
 *
 * Usado em qualquer resultado do sidebar que possa citar IDs (análise de
 * critérios, resumo do chat etc.). O CSS é injetado uma vez por shadow
 * root via `ensureDocLinkStyle`.
 */

import { activateDocumentInPje } from '../extractor';

const DOC_ID_RE = /\b([iI][dD])\s+(\d{4,12})\b/g;
const HAS_DOC_ID_RE = /\b[iI][dD]\s+\d{4,12}\b/;
const STYLE_ATTR = 'data-paidegua';
const STYLE_KEY = 'doc-id-link';

const DOC_LINK_CSS = `
.paidegua-doc-link {
  color: #2563eb;
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  line-height: inherit;
}
.paidegua-doc-link:hover { color: #1d4ed8; }
.paidegua-doc-link:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; border-radius: 2px; }
.paidegua-doc-link:disabled { opacity: 0.55; cursor: progress; }
`;

export function ensureDocLinkStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector(`style[${STYLE_ATTR}="${STYLE_KEY}"]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, STYLE_KEY);
  style.textContent = DOC_LINK_CSS;
  shadow.appendChild(style);
}

function makeLink(label: string, docId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-doc-link';
  btn.textContent = label;
  btn.title = `Abrir documento ${docId} no PJe`;
  btn.dataset.docId = docId;
  btn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await activateDocumentInPje(docId);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Converte uma string em DocumentFragment, substituindo ocorrências de
 * "id 12345678" por botões clicáveis. Caller anexa o fragment em vez de
 * usar `textContent = text`.
 */
export function linkifyDocIdsInText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!text) return frag;
  let lastIdx = 0;
  DOC_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOC_ID_RE.exec(text)) !== null) {
    const before = text.slice(lastIdx, m.index);
    if (before) frag.append(document.createTextNode(before));
    frag.append(makeLink(m[0], m[2]));
    lastIdx = m.index + m[0].length;
  }
  const rest = text.slice(lastIdx);
  if (rest) frag.append(document.createTextNode(rest));
  return frag;
}

/**
 * Varre TextNodes do elemento e linkifica IDs in place, preservando o HTML
 * existente. Ignora text nodes que já estão dentro de links/botões.
 */
export function linkifyDocIdsInElement(el: HTMLElement): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, button, .paidegua-doc-link')) {
        return NodeFilter.FILTER_REJECT;
      }
      return HAS_DOC_ID_RE.test((node as Text).data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    }
  });
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    targets.push(node as Text);
  }
  for (const t of targets) {
    const frag = linkifyDocIdsInText(t.data);
    t.parentNode?.replaceChild(frag, t);
  }
}
