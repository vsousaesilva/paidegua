/**
 * Página "Salvar como modelo" do pAIdegua.
 *
 * POR QUE UMA PÁGINA DEDICADA (e não salvamento inline no content script)?
 *  - O `FileSystemDirectoryHandle` persistido no IndexedDB está na origem
 *    da extensão. Content scripts rodam na origem jus.br — não enxergam
 *    esse handle.
 *  - Service workers não têm user gesture → `requestPermission` falha.
 *  - Páginas da extensão (esta) rodam na origem correta, têm DOM e recebem
 *    user gestures por clique.
 *
 * Fluxo:
 *  1. Lê o payload da minuta de `chrome.storage.session`.
 *  2. Carrega o handle da pasta de modelos do IDB.
 *  3. Mostra pasta/subpasta/nome e um único botão "Salvar como modelo".
 *  4. Clique no botão → upgrade de permissão (readwrite) → grava .doc →
 *     atualiza o índice → avisa o service worker → fecha a aba.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS, STORAGE_KEYS } from '../shared/constants';
import { loadDirectoryMeta, type DirectoryMeta } from '../shared/templates-store';
import { ensureReadWritePermission } from '../shared/templates-ingest';
import { buildWordDocument } from '../shared/docx-export';
import {
  saveAsTemplate,
  slugifySubfolder,
  type SaveTemplatePayload
} from '../shared/templates-save';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`save-template: elemento #${id} ausente`);
  }
  return el as T;
};

function setStatus(text: string, kind: '' | 'ok' | 'error' | 'info' = ''): void {
  const el = $<HTMLDivElement>('status');
  el.textContent = text;
  el.className = 'paidegua-save__status' + (kind ? ` is-${kind}` : '');
}

let currentPayload: SaveTemplatePayload | null = null;
let currentDir: DirectoryMeta | null = null;

async function readPayload(): Promise<SaveTemplatePayload | null> {
  const bag = await chrome.storage.session.get(STORAGE_KEYS.SAVE_TEMPLATE_PAYLOAD);
  const raw = bag[STORAGE_KEYS.SAVE_TEMPLATE_PAYLOAD];
  if (!raw || typeof raw !== 'object') return null;
  return raw as SaveTemplatePayload;
}

async function clearPayload(): Promise<void> {
  try {
    await chrome.storage.session.remove(STORAGE_KEYS.SAVE_TEMPLATE_PAYLOAD);
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} save-template: falha ao limpar payload:`, error);
  }
}

async function notifyInvalidateIndex(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TEMPLATES_INVALIDATE,
      payload: null
    });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} save-template: falha ao invalidar índice:`, error);
  }
}

function renderNoDir(): void {
  $<HTMLDivElement>('no-dir-block').hidden = false;
  $<HTMLDListElement>('dest-info').hidden = true;
  $<HTMLDivElement>('actions').hidden = true;
}

function renderDest(meta: DirectoryMeta, payload: SaveTemplatePayload): void {
  const subfolder = slugifySubfolder(payload.actionLabel);
  $<HTMLDivElement>('no-dir-block').hidden = true;
  $<HTMLDListElement>('dest-info').hidden = false;
  $<HTMLDivElement>('actions').hidden = false;

  $<HTMLElement>('dest-folder').textContent = meta.name;
  $<HTMLElement>('dest-subfolder').textContent = subfolder || '(raiz)';
  $<HTMLElement>('dest-filename').textContent = payload.suggestedFilename;
}

async function handleSave(): Promise<void> {
  if (!currentDir || !currentPayload) {
    setStatus('Payload ausente — recarregue a página.', 'error');
    return;
  }

  const btnSave = $<HTMLButtonElement>('btn-save');
  const btnCancel = $<HTMLButtonElement>('btn-cancel');
  btnSave.disabled = true;
  btnCancel.disabled = true;
  setStatus('Verificando permissão de escrita na pasta…', 'info');

  try {
    const ok = await ensureReadWritePermission(currentDir.handle);
    if (!ok) {
      setStatus(
        'Permissão de escrita negada. Reabra a pasta em Opções → Modelos de Minuta.',
        'error'
      );
      btnSave.disabled = false;
      btnCancel.disabled = false;
      return;
    }

    setStatus('Gravando arquivo…', 'info');
    const blob = buildWordDocument(currentPayload.html);
    const result = await saveAsTemplate(currentDir.handle, currentPayload, blob);

    await notifyInvalidateIndex();
    await clearPayload();

    setStatus(
      `Modelo salvo em "${result.relativePath}" (${result.charCount.toLocaleString('pt-BR')} chars indexados). Fechando…`,
      'ok'
    );
    window.setTimeout(() => {
      window.close();
    }, 1400);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`${LOG_PREFIX} save-template: falha ao gravar:`, error);
    setStatus(`Falha ao salvar: ${msg}`, 'error');
    btnSave.disabled = false;
    btnCancel.disabled = false;
  }
}

function wireButtons(): void {
  $<HTMLButtonElement>('btn-save').addEventListener('click', (): void => {
    void handleSave();
  });
  $<HTMLButtonElement>('btn-cancel').addEventListener('click', (): void => {
    void clearPayload().finally(() => window.close());
  });
  $<HTMLButtonElement>('btn-cancel-nodir').addEventListener('click', (): void => {
    void clearPayload().finally(() => window.close());
  });
  $<HTMLButtonElement>('btn-open-options').addEventListener('click', (): void => {
    chrome.runtime.openOptionsPage(() => window.close());
  });
}

async function bootstrap(): Promise<void> {
  wireButtons();

  const payload = await readPayload();
  if (!payload) {
    setStatus(
      'Nenhuma minuta pendente. Esta página é aberta pela extensão após gerar uma minuta.',
      'error'
    );
    renderNoDir();
    $<HTMLDivElement>('no-dir-block').querySelector('p')!.innerHTML =
      'Nenhuma minuta foi enviada para esta página. Volte ao PJe, gere uma minuta e clique em <strong>Salvar como modelo</strong>.';
    return;
  }
  currentPayload = payload;

  const meta = await loadDirectoryMeta();
  if (!meta) {
    setStatus('', '');
    renderNoDir();
    return;
  }
  currentDir = meta;

  renderDest(meta, payload);
  setStatus('', '');
}

void bootstrap();
