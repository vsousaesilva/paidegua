/**
 * Ícones SVG e factories de botões compartilhados pelos painéis e
 * dashboards do paidegua. Centralizar evita duplicação dos mesmos SVGs
 * em vários módulos e garante consistência visual.
 *
 * Padrão visual estabelecido pelos dashboards (Triagem, Gestão, Prazos
 * na Fita, Perícias):
 *   - Ícone "copiar" (clipboard) ao lado de cada CNJ.
 *   - Ícone "abrir externo" (square + arrow) para abrir os autos no PJe.
 *   - Ícone maior "copiar lista" no topo de seção (com borda discreta).
 *   - Feedback visual: check verde por 1,2s após sucesso, vermelho em erro.
 */

export const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';

export const CHECK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="20 6 9 17 4 12"/>' +
  '</svg>';

export const EXTERNAL_LINK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
  '<polyline points="15 3 21 3 21 9"/>' +
  '<line x1="10" y1="14" x2="21" y2="3"/>' +
  '</svg>';

export interface CriarBotaoCopiarOptions {
  /** Texto que vai para o clipboard quando o botão for clicado. */
  texto: string;
  /**
   * Função que retorna o texto a copiar. Use quando o conteúdo for
   * dinâmico (ex.: editado pelo usuário antes do clique).
   */
  textoFn?: () => string;
  /** Classe CSS aplicada ao botão. */
  className: string;
  /** Texto do `title`/`aria-label`. */
  titulo: string;
  /** Tamanho do ícone — default 14px. Use 16 para "copiar lista". */
  tamanho?: 14 | 16;
}

/**
 * Cria um botão minimalista de "copiar" usando o COPY_ICON_SVG. Aplica
 * feedback visual (check verde por 1,2s) após sucesso e fica vermelho
 * temporariamente em caso de erro.
 *
 * O caller é responsável por estilizar `className` no CSS — este helper
 * apenas atribui a classe e adiciona/remove `is-ok` / `is-err` durante o
 * feedback. Sugestão de classes: `proc-copy` (inline minúsculo) ou
 * `copy-list-btn` (com borda, no topo de cards).
 */
export function criarBotaoCopiar(opts: CriarBotaoCopiarOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = opts.className;
  btn.title = opts.titulo;
  btn.setAttribute('aria-label', opts.titulo);
  const tamanho = opts.tamanho ?? 14;
  btn.innerHTML = ajustarTamanhoSvg(COPY_ICON_SVG, tamanho);
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const txt = opts.textoFn ? opts.textoFn() : opts.texto;
    if (!txt) return;
    void navigator.clipboard.writeText(txt).then(
      () => {
        btn.classList.add('is-ok');
        btn.innerHTML = ajustarTamanhoSvg(CHECK_ICON_SVG, tamanho);
        window.setTimeout(() => {
          btn.classList.remove('is-ok');
          btn.innerHTML = ajustarTamanhoSvg(COPY_ICON_SVG, tamanho);
        }, 1200);
      },
      () => {
        btn.classList.add('is-err');
        window.setTimeout(() => btn.classList.remove('is-err'), 1500);
      }
    );
  });
  return btn;
}

/**
 * Cria um link minimalista que abre os autos no PJe (target=_blank). Usa
 * o EXTERNAL_LINK_ICON_SVG. Devolve `null` quando `url` não foi resolvida
 * — o caller decide se renderiza algo no lugar (em geral, nada).
 */
export function criarLinkAbrirExterno(opts: {
  url: string | null;
  className: string;
  titulo: string;
}): HTMLAnchorElement | null {
  if (!opts.url) return null;
  const a = document.createElement('a');
  a.className = opts.className;
  a.href = opts.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = opts.titulo;
  a.setAttribute('aria-label', opts.titulo);
  a.innerHTML = EXTERNAL_LINK_ICON_SVG;
  return a;
}

function ajustarTamanhoSvg(svg: string, tamanho: 14 | 16): string {
  if (tamanho === 14) return svg;
  return svg
    .replace('width="14"', `width="${tamanho}"`)
    .replace('height="14"', `height="${tamanho}"`);
}
