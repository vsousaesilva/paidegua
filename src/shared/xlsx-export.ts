/**
 * Export de tabelas dos dashboards do paidegua para arquivo .xlsx (Excel).
 *
 * Espelha attachCopyButton de cada dashboard: o caller passa uma seção,
 * uma função getRows e a definição de colunas tipadas; este helper cria
 * o botão `.xlsx-btn` ao lado do `.copy-btn` e dispara o download.
 *
 * SheetJS Community (xlsx@^0.18.5) — funciona 100% offline, gera arquivo
 * .xlsx real (não CSV) com tipos preservados por coluna.
 */

import * as XLSX from 'xlsx';
import { EXCEL_ICON_SVG, CHECK_ICON_SVG } from './icons';

export type ExcelCellType = 'string' | 'number' | 'date';

export interface ExcelColumn<T> {
  header: string;
  /** Chave do objeto ou função extratora para obter o valor da linha. */
  key: keyof T | ((row: T) => unknown);
  /** Largura em caracteres (aproximada, usada pelo Excel). Default 18. */
  width?: number;
  /**
   * Tipo da célula no Excel.
   * - 'string': padrão; preserva zeros à esquerda e máscara (ideal para CNJ).
   * - 'number': permite SUM/AVG no Excel.
   * - 'date': data nativa do Excel (não texto).
   */
  type?: ExcelCellType;
  /** Formato Excel (z), ex.: 'dd/mm/yyyy', '#,##0', '0.00'. Opcional. */
  format?: string;
}

export interface DownloadExcelOptions {
  /** Nome da aba dentro do workbook. Default 'Dados'. */
  sheetName?: string;
  /** Se true, congela a primeira linha (cabeçalhos) ao rolar. Default true. */
  freezeHeader?: boolean;
}

/**
 * Resolve o valor da coluna `col` na linha `row`. Aceita `keyof T` ou
 * função extratora.
 */
function getCellValue<T>(row: T, col: ExcelColumn<T>): unknown {
  if (typeof col.key === 'function') {
    return (col.key as (r: T) => unknown)(row);
  }
  return row[col.key as keyof T];
}

/**
 * Converte um valor + tipo de coluna em uma célula SheetJS ({v, t, z?}).
 * Tolerante a `null`/`undefined` (devolve célula em branco).
 */
function buildCell(value: unknown, col: ExcelColumn<unknown>): XLSX.CellObject | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const type = col.type ?? 'string';
  if (type === 'date') {
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) return { v: String(value), t: 's' };
    return { v: d, t: 'd', z: col.format ?? 'dd/mm/yyyy' };
  }
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(n)) return { v: String(value), t: 's' };
    const cell: XLSX.CellObject = { v: n, t: 'n' };
    if (col.format) cell.z = col.format;
    return cell;
  }
  return { v: String(value), t: 's' };
}

/**
 * Gera um arquivo .xlsx em memória e dispara o download no navegador.
 */
export function downloadExcel<T>(
  rows: T[],
  columns: ExcelColumn<T>[],
  fileName: string,
  options?: DownloadExcelOptions
): void {
  const sheetName = (options?.sheetName ?? 'Dados').slice(0, 31);
  const freezeHeader = options?.freezeHeader !== false;

  type Cell = XLSX.CellObject | string | null;
  const header: Cell[] = columns.map((c) => c.header);
  const dataMatrix: Cell[][] = [header];

  for (const row of rows) {
    const line: Cell[] = columns.map((col) =>
      buildCell(getCellValue(row, col), col as ExcelColumn<unknown>)
    );
    dataMatrix.push(line);
  }

  const ws = XLSX.utils.aoa_to_sheet(dataMatrix);

  ws['!cols'] = columns.map((c) => ({ wch: c.width ?? 18 }));
  if (freezeHeader) {
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    (ws as { [k: string]: unknown })['!views'] = [{ state: 'frozen', ySplit: 1 }];
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const finalName = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  XLSX.writeFile(wb, finalName);
}

/**
 * Gera o nome de arquivo padrão pAIdegua_<modulo>_<YYYY-MM-DD_HHmm>.xlsx
 * a partir de um slug de módulo.
 */
export function defaultFileName(moduleSlug: string, date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return `pAIdegua_${moduleSlug}_${yyyy}-${mm}-${dd}_${hh}${mi}.xlsx`;
}

export interface AttachExcelButtonOptions {
  /** Texto do title/aria-label. Default 'Baixar Excel'. */
  label?: string;
  /** Nome da aba. Default 'Dados'. */
  sheetName?: string;
  /** Mensagem opcional quando a lista está vazia. */
  emptyMessage?: string;
  /** Toast callback (showToast do dashboard). Opcional. */
  onToast?: (msg: string) => void;
}

/**
 * Cria um botão .xlsx-btn ao final da seção (irmão do .copy-btn) que,
 * ao ser clicado, gera e baixa um arquivo Excel com as linhas atuais.
 *
 * Padrão de uso (espelha attachCopyButton):
 *
 *   attachExcelButton(
 *     sec,
 *     () => ord,
 *     COLUNAS_MAIS_ANTIGOS,
 *     'painel-gerencial_mais-antigos',
 *     { label: 'Baixar lista em Excel' }
 *   );
 */
export function attachExcelButton<T>(
  sec: HTMLElement,
  getRows: () => T[],
  columns: ExcelColumn<T>[],
  moduleSlug: string,
  options?: AttachExcelButtonOptions
): HTMLButtonElement {
  sec.classList.add('section--copy');
  const label = options?.label ?? 'Baixar Excel';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'xlsx-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = EXCEL_ICON_SVG;

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const rows = getRows();
    if (!rows || rows.length === 0) {
      options?.onToast?.(options?.emptyMessage ?? 'Lista vazia — nada para exportar.');
      return;
    }
    try {
      const fileName = defaultFileName(moduleSlug);
      downloadExcel(rows, columns, fileName, { sheetName: options?.sheetName });
      btn.classList.add('is-ok');
      btn.innerHTML = CHECK_ICON_SVG;
      window.setTimeout(() => {
        btn.classList.remove('is-ok');
        btn.innerHTML = EXCEL_ICON_SVG;
      }, 1200);
      options?.onToast?.(`Excel gerado: ${rows.length} linha(s).`);
    } catch (err) {
      btn.classList.add('is-err');
      window.setTimeout(() => btn.classList.remove('is-err'), 1500);
      options?.onToast?.('Falha ao gerar Excel. Veja o console.');
      console.error('[pAIdegua] downloadExcel failed', err);
    }
  });

  sec.appendChild(btn);
  return btn;
}
