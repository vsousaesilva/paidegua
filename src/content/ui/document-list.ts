/**
 * Componente de lista selecionável de documentos processuais.
 *
 * Montado dentro da área de body do sidebar. Para cada documento descoberto
 * pelo adapter, renderiza uma linha com checkbox, descrição, tipo e data.
 *
 * Estados visíveis por item durante a extração:
 *   - pending  (padrão)
 *   - loading  (com spinner textual)
 *   - done     (com tamanho + marca de OCR quando for scanned)
 *   - error    (com mensagem)
 */

import type { ProcessoDocumento } from '../../shared/types';
import type { DiagnosticEntry } from '../extractor';

type ItemStatus = 'pending' | 'loading' | 'done' | 'error';

interface ItemState {
  documento: ProcessoDocumento;
  status: ItemStatus;
  message?: string;
  element: HTMLElement;
  checkbox: HTMLInputElement;
  statusEl: HTMLElement;
}

export interface DocumentListOptions {
  onExtract: (selectedIds: string[]) => void;
}

export interface DocumentListController {
  setDocuments(documentos: ProcessoDocumento[]): void;
  getSelectedIds(): string[];
  setItemStatus(id: string, status: ItemStatus, message?: string, diagnostics?: DiagnosticEntry[]): void;
  setGlobalStatus(text: string): void;
  setExtractEnabled(enabled: boolean): void;
  destroy(): void;
}

const DOCUMENT_LIST_CSS = `
.paidegua-doclist {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  flex: 1;
}

.paidegua-doclist__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.paidegua-doclist__select-all {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--paidegua-text);
  font-size: 12px;
  cursor: pointer;
}

.paidegua-doclist__count {
  color: var(--paidegua-text-muted);
  font-size: 11px;
}

.paidegua-doclist__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}

.paidegua-doclist__item {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.78);
  border-radius: var(--paidegua-radius-sm);
  border: 1px solid var(--paidegua-border);
  align-items: start;
  transition: background-color 160ms ease, border-color 160ms ease, transform 160ms ease;
}

.paidegua-doclist__item:hover {
  background: rgba(255, 255, 255, 0.95);
  border-color: var(--paidegua-border-strong);
  transform: translateY(-1px);
}

.paidegua-doclist__item.is-loading {
  border-color: var(--paidegua-primary);
  background: rgba(19, 81, 180, 0.05);
}

.paidegua-doclist__item.is-done {
  border-color: rgba(30, 126, 52, 0.45);
  background: rgba(30, 126, 52, 0.05);
}

.paidegua-doclist__item.is-error {
  border-color: rgba(192, 57, 43, 0.55);
  background: rgba(192, 57, 43, 0.05);
}

.paidegua-doclist__item input[type="checkbox"] {
  margin-top: 2px;
  accent-color: var(--paidegua-accent);
}

.paidegua-doclist__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.paidegua-doclist__descricao {
  color: var(--paidegua-text);
  font-size: 13px;
  line-height: 1.3;
  word-break: break-word;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.paidegua-doclist__filename {
  font-weight: 600;
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

.paidegua-doclist__id {
  color: var(--paidegua-text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.paidegua-doclist__id::before {
  content: '| ';
  opacity: 0.5;
}

.paidegua-doclist__sub {
  color: var(--paidegua-text-muted);
  font-size: 11px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.paidegua-doclist__tipo {
  color: var(--paidegua-text-muted);
  font-size: 12px;
  font-style: italic;
}

.paidegua-doclist__status {
  font-size: 11px;
  color: var(--paidegua-text-muted);
  margin-top: 2px;
}

.paidegua-doclist__item.is-loading .paidegua-doclist__status { color: var(--paidegua-primary); }
.paidegua-doclist__item.is-done    .paidegua-doclist__status { color: #1e7e34; }
.paidegua-doclist__item.is-error   .paidegua-doclist__status { color: #b03030; }

.paidegua-doclist__actions {
  display: flex;
  gap: 8px;
}

.paidegua-doclist__extract {
  flex: 1;
  background: var(--paidegua-gradient);
  color: #ffffff;
  padding: 11px 14px;
  border-radius: var(--paidegua-radius-sm);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.2px;
  box-shadow: 0 8px 22px rgba(19, 81, 180, 0.26);
  transition: all 180ms ease;
}

.paidegua-doclist__extract:hover:not(:disabled) {
  background: linear-gradient(135deg, #0C326F 0%, #1351B4 100%);
  transform: translateY(-1px);
  box-shadow: 0 12px 28px rgba(19, 81, 180, 0.34);
}

.paidegua-doclist__extract:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.paidegua-doclist__global-status {
  font-size: 12px;
  color: var(--paidegua-text-muted);
  min-height: 1em;
}

.paidegua-doclist__empty {
  text-align: center;
  color: var(--paidegua-text-muted);
  font-size: 13px;
  padding: 16px 8px;
  line-height: 1.5;
}

.paidegua-doclist__diag-toggle {
  font-size: 10px;
  color: #b03030;
  cursor: pointer;
  text-decoration: underline;
  background: none;
  border: none;
  padding: 0;
  margin-top: 2px;
}

.paidegua-doclist__diag-toggle:hover {
  color: #8b1a1a;
}

.paidegua-doclist__diag {
  display: none;
  margin-top: 4px;
  padding: 6px 8px;
  background: rgba(192, 57, 43, 0.06);
  border: 1px solid rgba(192, 57, 43, 0.18);
  border-radius: 4px;
  font-family: monospace;
  font-size: 10px;
  line-height: 1.5;
  color: #4a2020;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
}

.paidegua-doclist__diag.is-open {
  display: block;
}
`;

function ensureStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector('style[data-paidegua="doclist"]')) {
    return;
  }
  const style = document.createElement('style');
  style.setAttribute('data-paidegua', 'doclist');
  style.textContent = DOCUMENT_LIST_CSS;
  shadow.appendChild(style);
}

function formatSize(bytes?: number): string {
  if (typeof bytes !== 'number') {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function mountDocumentList(
  shadow: ShadowRoot,
  container: HTMLElement,
  options: DocumentListOptions
): DocumentListController {
  ensureStyle(shadow);

  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'paidegua-doclist';

  const header = document.createElement('div');
  header.className = 'paidegua-doclist__header';

  const selectAllLabel = document.createElement('label');
  selectAllLabel.className = 'paidegua-doclist__select-all';
  const selectAllCb = document.createElement('input');
  selectAllCb.type = 'checkbox';
  const selectAllText = document.createElement('span');
  selectAllText.textContent = 'Selecionar todos';
  selectAllLabel.append(selectAllCb, selectAllText);

  const countEl = document.createElement('span');
  countEl.className = 'paidegua-doclist__count';
  countEl.textContent = '0 documentos';

  header.append(selectAllLabel, countEl);

  const list = document.createElement('ul');
  list.className = 'paidegua-doclist__items';

  const empty = document.createElement('div');
  empty.className = 'paidegua-doclist__empty';
  empty.textContent = 'Nenhum documento carregado ainda.';

  const actions = document.createElement('div');
  actions.className = 'paidegua-doclist__actions';
  const extractBtn = document.createElement('button');
  extractBtn.type = 'button';
  extractBtn.className = 'paidegua-doclist__extract';
  extractBtn.textContent = 'Extrair conteúdo selecionados';
  extractBtn.disabled = true;
  actions.append(extractBtn);

  const globalStatus = document.createElement('div');
  globalStatus.className = 'paidegua-doclist__global-status';

  wrap.append(header, list, empty, actions, globalStatus);
  container.append(wrap);

  const items = new Map<string, ItemState>();

  function updateCount(): void {
    const total = items.size;
    const selected = Array.from(items.values()).filter((i) => i.checkbox.checked).length;
    countEl.textContent = `${selected}/${total} selecionados`;
    extractBtn.disabled = selected === 0;
    selectAllCb.checked = total > 0 && selected === total;
  }

  selectAllCb.addEventListener('change', () => {
    for (const item of items.values()) {
      item.checkbox.checked = selectAllCb.checked;
    }
    updateCount();
  });

  extractBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const selected = Array.from(items.values())
      .filter((i) => i.checkbox.checked)
      .map((i) => i.documento.id);
    if (selected.length === 0) {
      return;
    }
    options.onExtract(selected);
  });

  const controller: DocumentListController = {
    setDocuments(documentos): void {
      list.innerHTML = '';
      items.clear();

      if (documentos.length === 0) {
        empty.style.display = 'block';
        list.style.display = 'none';
      } else {
        empty.style.display = 'none';
        list.style.display = 'flex';
      }

      for (const doc of documentos) {
        const li = document.createElement('li');
        li.className = 'paidegua-doclist__item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute(
          'aria-label',
          `Selecionar ${doc.descricao || doc.tipo || `documento ${doc.id}`}`
        );
        checkbox.addEventListener('change', updateCount);

        const meta = document.createElement('div');
        meta.className = 'paidegua-doclist__meta';

        // Linha 1: {nome do arquivo} | {ID do documento}
        const descricao = document.createElement('div');
        descricao.className = 'paidegua-doclist__descricao';

        const filename = document.createElement('span');
        filename.className = 'paidegua-doclist__filename';
        filename.textContent = doc.descricao || `Documento ${doc.id}`;
        descricao.append(filename);

        if (doc.id) {
          const idEl = document.createElement('span');
          idEl.className = 'paidegua-doclist__id';
          idEl.textContent = doc.id;
          descricao.append(idEl);
        }

        // Linha 2: {tipo} (+ data, se disponível)
        const sub = document.createElement('div');
        sub.className = 'paidegua-doclist__sub';
        if (doc.tipo) {
          const tipoEl = document.createElement('span');
          tipoEl.className = 'paidegua-doclist__tipo';
          tipoEl.textContent = doc.tipo;
          sub.append(tipoEl);
        }
        if (doc.dataMovimentacao) {
          const dataEl = document.createElement('span');
          dataEl.textContent = doc.dataMovimentacao;
          sub.append(dataEl);
        }

        const statusEl = document.createElement('div');
        statusEl.className = 'paidegua-doclist__status';

        meta.append(descricao, sub, statusEl);
        li.append(checkbox, meta);
        list.append(li);

        items.set(doc.id, {
          documento: doc,
          status: 'pending',
          element: li,
          checkbox,
          statusEl
        });
      }

      selectAllCb.checked = false;
      updateCount();
    },

    getSelectedIds(): string[] {
      return Array.from(items.values())
        .filter((i) => i.checkbox.checked)
        .map((i) => i.documento.id);
    },

    setItemStatus(id, status, message, diagnostics): void {
      const item = items.get(id);
      if (!item) {
        return;
      }
      item.status = status;
      item.message = message;
      item.element.classList.remove(
        'is-loading',
        'is-done',
        'is-error'
      );
      if (status !== 'pending') {
        item.element.classList.add(`is-${status}`);
      }

      // Remove diagnóstico anterior, se existir
      const oldDiag = item.element.querySelector('.paidegua-doclist__diag-toggle');
      if (oldDiag) oldDiag.remove();
      const oldBlock = item.element.querySelector('.paidegua-doclist__diag');
      if (oldBlock) oldBlock.remove();

      switch (status) {
        case 'loading':
          item.statusEl.textContent = 'extraindo…';
          break;
        case 'done': {
          const size = formatSize(item.documento.tamanho);
          const ocr = item.documento.isScanned ? ' · digitalizado (precisa OCR)' : '';
          item.statusEl.textContent = `concluído${size ? ` · ${size}` : ''}${ocr}`;
          break;
        }
        case 'error': {
          item.statusEl.textContent = `erro: ${message ?? 'desconhecido'}`;

          // Renderiza bloco expansível de diagnóstico se houver entradas
          if (diagnostics && diagnostics.length > 0) {
            const meta = item.element.querySelector('.paidegua-doclist__meta');
            if (meta) {
              const toggle = document.createElement('button');
              toggle.type = 'button';
              toggle.className = 'paidegua-doclist__diag-toggle';
              toggle.textContent = 'ver diagnóstico';

              const block = document.createElement('div');
              block.className = 'paidegua-doclist__diag';
              block.textContent = diagnostics.map(d =>
                `[${d.ms}ms] ${d.etapa}: ${d.ok ? 'OK' : 'FALHA'} — ${d.detalhe}`
              ).join('\n');

              toggle.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const open = block.classList.toggle('is-open');
                toggle.textContent = open ? 'ocultar diagnóstico' : 'ver diagnóstico';
              });

              meta.append(toggle, block);
            }
          }
          break;
        }
        default:
          item.statusEl.textContent = '';
      }
    },

    setGlobalStatus(text): void {
      globalStatus.textContent = text;
    },

    setExtractEnabled(enabled): void {
      extractBtn.disabled = !enabled;
    },

    destroy(): void {
      wrap.remove();
      items.clear();
    }
  };

  return controller;
}
