/**
 * Helper genérico para tornar tabelas dos relatórios pAIdegua ordenáveis.
 *
 * Uso: construa a `<table>` normalmente (com `<thead><tr><th>...` e
 * `<tbody>` já populado, linha a linha, na mesma ordem de `items`) e em
 * seguida chame `makeTableSortable(table, items, columns)`. O helper
 * adiciona um botão/ícone em cada `<th>` com definição de coluna e
 * reorganiza as `<tr>` existentes no `<tbody>` ao clicar — sem recriar
 * os nós das linhas.
 *
 * Três tipos de ordenação são suportados:
 *   - 'alpha' (texto, `localeCompare` pt-BR, `numeric:true`)
 *   - 'num'   (numérico, trata strings com `.` ou `,` como decimal)
 *   - 'date'  (data — aceita `dd/mm/yyyy[ hh:mm[:ss]]` ou ISO)
 *
 * Valores nulos/ausentes/traço (`—`) são sempre deslocados para o fim.
 * Colunas sem necessidade de ordenação podem ser marcadas com `null`
 * na posição correspondente de `columns`.
 */

export type SortType = 'alpha' | 'num' | 'date';
export type SortDir = 'asc' | 'desc';

export interface TableSortColumn<T> {
  type: SortType;
  value: (item: T) => string | number | null | undefined;
}

export interface MakeTableSortableOptions {
  initial?: { col: number; dir: SortDir };
}

export function makeTableSortable<T>(
  table: HTMLTableElement,
  items: T[],
  columns: Array<TableSortColumn<T> | null>,
  options: MakeTableSortableOptions = {}
): void {
  const thead = table.tHead;
  const tbody = table.tBodies[0];
  if (!thead || !tbody) return;
  const trHead = thead.rows[0];
  if (!trHead) return;

  const ths = Array.from(trHead.cells);
  if (ths.length !== columns.length) return;

  const originalRows = Array.from(tbody.rows);
  if (originalRows.length !== items.length) return;

  ths.forEach((th, idx) => {
    const col = columns[idx];
    if (!col) return;
    decorarTh(th, idx);
  });

  let state: { col: number; dir: SortDir } | null = options.initial ?? null;

  const applySort = (): void => {
    if (!state) {
      for (const row of originalRows) tbody.appendChild(row);
    } else {
      const col = columns[state.col];
      if (!col) return;
      const sign = state.dir === 'asc' ? 1 : -1;
      const indices = items.map((_, i) => i).sort((ia, ib) =>
        compare(col, items[ia], items[ib]) * sign
      );
      for (const i of indices) tbody.appendChild(originalRows[i]);
    }
    atualizarEstadoCabecalho(ths, state);
  };

  trHead.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest<HTMLButtonElement>('.th-sort-btn');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const idx = Number(btn.dataset.colIdx);
    if (!Number.isFinite(idx)) return;
    if (state && state.col === idx) {
      state = { col: idx, dir: state.dir === 'asc' ? 'desc' : 'asc' };
    } else {
      state = { col: idx, dir: 'asc' };
    }
    applySort();
  });

  if (options.initial) applySort();
}

function decorarTh(th: HTMLTableCellElement, idx: number): void {
  const labelText = (th.textContent || '').trim();
  th.textContent = '';
  th.classList.add('th-sort');
  th.setAttribute('aria-sort', 'none');
  const wrap = document.createElement('span');
  wrap.className = 'th-wrap';
  const lbl = document.createElement('span');
  lbl.className = 'th-label';
  lbl.textContent = labelText;
  wrap.appendChild(lbl);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'th-sort-btn';
  btn.dataset.colIdx = String(idx);
  btn.title = `Ordenar por ${labelText}`;
  btn.setAttribute('aria-label', `Ordenar por ${labelText}`);
  btn.innerHTML = sortIconSvg(null);
  wrap.appendChild(btn);
  th.appendChild(wrap);
}

function atualizarEstadoCabecalho(
  ths: HTMLTableCellElement[],
  state: { col: number; dir: SortDir } | null
): void {
  ths.forEach((th, idx) => {
    if (!th.classList.contains('th-sort')) return;
    const active = !!state && state.col === idx;
    th.classList.toggle('th-sort--active', active);
    const dir = active && state ? state.dir : null;
    th.setAttribute(
      'aria-sort',
      dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'
    );
    const btn = th.querySelector<HTMLButtonElement>('.th-sort-btn');
    if (btn) btn.innerHTML = sortIconSvg(dir);
  });
}

function sortIconSvg(dir: SortDir | null): string {
  const upCls = 'sort-icon__arrow' + (dir === 'asc' ? ' sort-icon__arrow--active' : '');
  const downCls = 'sort-icon__arrow' + (dir === 'desc' ? ' sort-icon__arrow--active' : '');
  return (
    '<svg class="sort-icon" width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">' +
    `<polygon class="${upCls}" points="5,0 10,5 0,5"/>` +
    `<polygon class="${downCls}" points="5,12 10,7 0,7"/>` +
    '</svg>'
  );
}

function compare<T>(col: TableSortColumn<T>, a: T, b: T): number {
  const va = normalize(col, col.value(a));
  const vb = normalize(col, col.value(b));
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), 'pt-BR', {
    numeric: true,
    sensitivity: 'base'
  });
}

function normalize<T>(
  col: TableSortColumn<T>,
  v: string | number | null | undefined
): string | number | null {
  if (v === null || v === undefined) return null;
  if (col.type === 'num') {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const clean = String(v).replace(/[^\d,.\-+]/g, '').replace(',', '.');
    if (clean === '' || clean === '-' || clean === '+') return null;
    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
  }
  if (col.type === 'date') {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    return parseDateLike(String(v));
  }
  if (typeof v === 'number') return String(v);
  const t = v.trim();
  return t === '' || t === '—' || t === '-' ? null : t;
}

function parseDateLike(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed || trimmed === '—' || trimmed === '-') return null;
  const br = trimmed.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (br) {
    const [, dd, mm, aaaa, hh = '00', mi = '00', ss = '00'] = br;
    const t = new Date(
      Number(aaaa),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss)
    ).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}
