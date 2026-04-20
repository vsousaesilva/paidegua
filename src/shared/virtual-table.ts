/**
 * Tabela virtualizada minima — renderiza apenas as linhas visiveis (mais um
 * buffer acima/abaixo) para tabelas longas, mantendo o espaco total do
 * scroll via um "spacer" com altura calculada.
 *
 * Por que virtualizar em "Prazos na Fita": varreduras grandes (milhares
 * de processos) geram dashboards que antes demoravam dezenas de segundos
 * para pintar, com cada SLOT_PATCH forcando re-render de milhares de
 * <tr>. Renderizando apenas a janela visivel, o tempo de pintura volta a
 * ser constante (~10ms) independente do N.
 *
 * Pressupostos (simplificacoes aceitas):
 *   - Todas as linhas tem a mesma altura (`rowHeight`). O valor e fixado
 *     no CSS via `height` + `line-height` para garantir isso — linhas
 *     com conteudo maior sao clippadas, nao quebradas.
 *   - A tabela nao usa sticky headers HTML proprios (eles ficam fora do
 *     viewport virtualizado — renderizados normalmente em cima).
 *   - Ordenacao e de responsabilidade do chamador: ele recalcula `items`
 *     e chama `setItems`. A virtual list nao sabe ordenar.
 *
 * Uso tipico:
 *   const vt = createVirtualTable({
 *     container, rowHeight: 36, buffer: 8,
 *     renderRow: (item, idx) => '<tr>...</tr>'
 *   });
 *   vt.setItems(linhas);
 *   // depois de um patch:
 *   vt.setItems(linhasAtualizadas);
 *   // ao destruir o card:
 *   vt.destroy();
 */

export interface VirtualTableOptions<T> {
  /** Div com overflow-y:auto + altura fixa (via CSS). */
  container: HTMLElement;
  /** Altura de cada linha em px. Precisa bater com o CSS. */
  rowHeight: number;
  /** Linhas extras renderizadas acima/abaixo do viewport. Default 8. */
  buffer?: number;
  /** Funcao que produz o HTML de UMA linha (ex.: "<tr>...</tr>"). */
  renderRow: (item: T, absoluteIndex: number) => string;
  /** Classe do elemento wrapper. Default: `vlist`. */
  wrapperClass?: string;
}

export interface VirtualTableHandle<T> {
  setItems(items: T[]): void;
  /** Forca redesenho sem trocar `items` (uso: mudanca de tema/estilo). */
  refresh(): void;
  destroy(): void;
}

export function createVirtualTable<T>(
  opts: VirtualTableOptions<T>
): VirtualTableHandle<T> {
  const { container, rowHeight } = opts;
  const buffer = opts.buffer ?? 8;
  const wrapperClass = opts.wrapperClass ?? 'vlist';

  container.classList.add(wrapperClass);
  container.innerHTML = '';

  // Estrutura: um spacer com altura total (para barras de rolagem) e um
  // buffer absolute-positioned com as linhas visiveis. O buffer se move
  // via `transform: translateY(...)` ao rolar — mais barato que `top`.
  const spacer = document.createElement('div');
  spacer.className = 'vlist__spacer';
  spacer.style.position = 'relative';
  spacer.style.width = '100%';

  const viewport = document.createElement('div');
  viewport.className = 'vlist__viewport';
  viewport.style.position = 'absolute';
  viewport.style.top = '0';
  viewport.style.left = '0';
  viewport.style.right = '0';
  viewport.style.willChange = 'transform';

  spacer.appendChild(viewport);
  container.appendChild(spacer);

  let items: T[] = [];
  let rafPending = false;

  const scheduleRender = (): void => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderVisible();
    });
  };

  const renderVisible = (): void => {
    const total = items.length;
    spacer.style.height = total * rowHeight + 'px';
    if (total === 0) {
      viewport.innerHTML = '';
      viewport.style.transform = 'translateY(0)';
      return;
    }
    const viewportH = container.clientHeight || 0;
    const scrollTop = container.scrollTop;
    const firstVisible = Math.floor(scrollTop / rowHeight);
    const lastVisible =
      viewportH > 0
        ? Math.ceil((scrollTop + viewportH) / rowHeight)
        : firstVisible + 20;
    const start = Math.max(0, firstVisible - buffer);
    const end = Math.min(total, lastVisible + buffer);
    const html: string[] = [];
    for (let i = start; i < end; i++) {
      html.push(opts.renderRow(items[i], i));
    }
    // As linhas renderizadas sao <tr>; colocamos-as dentro de uma
    // pseudo-tabela interna para preservar a semantica e o reset do
    // zebrado. `table-layout: fixed` + widths no CSS garantem colunas.
    viewport.innerHTML =
      '<table class="vlist__table"><tbody>' + html.join('') + '</tbody></table>';
    viewport.style.transform = 'translateY(' + start * rowHeight + 'px)';
  };

  const onScroll = (): void => scheduleRender();
  container.addEventListener('scroll', onScroll, { passive: true });

  // Observa mudancas de tamanho do container (janela redimensionada,
  // card colapsado/expandido). Sem isso, lastVisible ficaria cacheado
  // num valor errado apos resize.
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => scheduleRender());
    ro.observe(container);
  }

  return {
    setItems(next: T[]): void {
      items = next;
      scheduleRender();
    },
    refresh(): void {
      scheduleRender();
    },
    destroy(): void {
      container.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      container.innerHTML = '';
      container.classList.remove(wrapperClass);
    }
  };
}
