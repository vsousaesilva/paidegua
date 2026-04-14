/**
 * Página de opções da extensão PAIdegua — gerenciamento dos modelos de minuta.
 *
 * Fluxo:
 *  1. Ao abrir, lê meta do IndexedDB e tenta restaurar a permissão da pasta.
 *  2. Botão "Configurar pasta…" abre o picker, persiste o handle e dispara
 *     a primeira ingestão.
 *  3. Botão "Reindexar agora" limpa templates e roda a ingestão novamente.
 *  4. Botão "Remover configuração" apaga handle + templates do IndexedDB.
 *
 * Persistência: chrome.storage NÃO é usado aqui — handles ficam no
 * IndexedDB porque chrome.storage descarta tipos não-serializáveis.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../shared/constants';
import {
  clearAllTemplates,
  clearDirectoryMeta,
  countTemplates,
  listTemplates,
  loadDirectoryMeta,
  saveDirectoryMeta,
  saveTemplates,
  type DirectoryMeta,
  type TemplateRecord
} from '../shared/templates-store';
import {
  ensureReadPermission,
  ingestDirectory,
  type IngestProgress,
  type IngestResult
} from '../shared/templates-ingest';

/**
 * Notifica o service worker que o índice BM25 deve ser invalidado. Chamado
 * após qualquer operação que altere o conjunto de templates indexados
 * (reindexação, remoção da configuração).
 *
 * Best-effort: se o SW não estiver acordado por algum motivo, o próximo
 * search vai detectar via fallback de versão na próxima reconstrução. Não
 * bloqueamos a UI se a notificação falhar.
 */
async function notifyInvalidateIndex(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TEMPLATES_INVALIDATE,
      payload: null
    });
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} options: falha ao invalidar índice:`, error);
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`PAIdegua options: elemento #${id} ausente`);
  }
  return el as T;
};

let currentMeta: DirectoryMeta | null = null;

function setStatus(text: string, kind: 'ok' | 'error' | 'info' | '' = ''): void {
  const el = $<HTMLDivElement>('dir-status');
  el.textContent = text;
  el.className = 'paidegua-options__status' + (kind ? ` is-${kind}` : '');
}

function setProgress(visible: boolean, processed = 0, total = 0, current = ''): void {
  const wrap = $<HTMLDivElement>('progress-wrap');
  if (!visible) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const fill = $<HTMLDivElement>('progress-fill');
  const text = $<HTMLParagraphElement>('progress-text');
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  fill.style.width = `${pct}%`;
  text.textContent = current
    ? `Processando ${processed}/${total} — ${current}`
    : `Processados ${processed}/${total} arquivos.`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshTemplatesView(): Promise<void> {
  const templates = await listTemplates();
  const summary = $<HTMLParagraphElement>('templates-summary');
  const list = $<HTMLUListElement>('templates-list');

  list.innerHTML = '';

  if (templates.length === 0) {
    summary.textContent = 'Nenhum modelo indexado ainda.';
    return;
  }

  const totalChars = templates.reduce((sum, t) => sum + t.charCount, 0);
  summary.textContent = `${templates.length} modelo(s) indexado(s) — ${totalChars.toLocaleString('pt-BR')} caracteres no total.`;

  // Mostra todos, ordenados por caminho relativo, com tamanho.
  const sorted = templates
    .slice()
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'pt-BR'));

  for (const t of sorted) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = t.relativePath;
    const meta = document.createElement('span');
    meta.textContent = `${t.charCount.toLocaleString('pt-BR')} chars · ${formatBytes(t.size)} · .${t.ext}`;
    li.append(name, meta);
    list.append(li);
  }
}

function setButtonsForState(hasDir: boolean): void {
  $<HTMLButtonElement>('btn-reindex').disabled = !hasDir;
  $<HTMLButtonElement>('btn-clear').disabled = !hasDir;
}

async function loadInitial(): Promise<void> {
  try {
    currentMeta = await loadDirectoryMeta();
    if (!currentMeta) {
      setStatus('Nenhuma pasta configurada.');
      setButtonsForState(false);
      await refreshTemplatesView();
      return;
    }
    const count = await countTemplates();
    setStatus(
      `Pasta configurada: ${currentMeta.name} — ${count} modelo(s) indexado(s).`,
      'ok'
    );
    setButtonsForState(true);
    await refreshTemplatesView();
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} options loadInitial:`, error);
    setStatus('Erro ao carregar configuração local.', 'error');
  }
}

async function performIngest(handle: FileSystemDirectoryHandle): Promise<void> {
  setProgress(true, 0, 0, 'preparando…');
  let lastResult: IngestResult | null = null;
  try {
    lastResult = await ingestDirectory(handle, (p: IngestProgress) => {
      setProgress(true, p.processed, p.total, p.current);
    });

    await clearAllTemplates();
    await saveTemplates(lastResult.records);

    const count = lastResult.records.length;
    const skippedCount = lastResult.skipped.length;
    const errorCount = lastResult.errors.length;

    let statusMsg = `${count} modelo(s) indexado(s).`;
    if (skippedCount > 0) statusMsg += ` ${skippedCount} ignorado(s).`;
    if (errorCount > 0) statusMsg += ` ${errorCount} com erro.`;
    setStatus(
      `Pasta: ${currentMeta?.name ?? '(?)'} — ${statusMsg}`,
      errorCount > 0 ? 'error' : 'ok'
    );

    const skippedEl = $<HTMLParagraphElement>('skipped-summary');
    const issues: string[] = [];
    if (skippedCount > 0) {
      issues.push(
        `Ignorados (${skippedCount}): ` +
          lastResult.skipped
            .slice(0, 5)
            .map((s) => `${s.path} — ${s.reason}`)
            .join(' · ') +
          (skippedCount > 5 ? ` …(+${skippedCount - 5})` : '')
      );
    }
    if (errorCount > 0) {
      issues.push(
        `Erros (${errorCount}): ` +
          lastResult.errors
            .slice(0, 3)
            .map((e) => `${e.path} — ${e.error}`)
            .join(' · ') +
          (errorCount > 3 ? ` …(+${errorCount - 3})` : '')
      );
    }
    skippedEl.textContent = issues.join(' | ');

    await refreshTemplatesView();
    setButtonsForState(true);
    // Avisa o service worker para invalidar o índice BM25 — qualquer
    // próxima busca vai reconstruir do IDB já com os novos textos.
    await notifyInvalidateIndex();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`${LOG_PREFIX} performIngest falhou:`, error);
    setStatus(`Falha na ingestão: ${msg}`, 'error');
  } finally {
    setProgress(false);
  }
}

async function pickDirectory(): Promise<void> {
  // showDirectoryPicker não está nos typings padrão (DOM lib).
  const picker = (window as unknown as {
    showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;

  if (!picker) {
    setStatus(
      'Este navegador não suporta File System Access API. Use Chrome/Edge atualizado.',
      'error'
    );
    return;
  }

  try {
    const handle = await picker({ id: 'paidegua-templates', mode: 'read' });
    const meta: DirectoryMeta = {
      handle,
      name: handle.name,
      configuredAt: new Date().toISOString()
    };
    await saveDirectoryMeta(meta);
    currentMeta = meta;
    setStatus(`Pasta configurada: ${handle.name}. Iniciando ingestão…`, 'info');
    setButtonsForState(true);
    await performIngest(handle);
  } catch (error: unknown) {
    // AbortError quando o usuário cancela o picker — não é erro real.
    if (error instanceof DOMException && error.name === 'AbortError') {
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`${LOG_PREFIX} pickDirectory:`, error);
    setStatus(`Falha ao selecionar pasta: ${msg}`, 'error');
  }
}

async function reindex(): Promise<void> {
  if (!currentMeta) {
    setStatus('Configure uma pasta antes de reindexar.', 'error');
    return;
  }
  setStatus('Verificando permissão da pasta…', 'info');
  const ok = await ensureReadPermission(currentMeta.handle);
  if (!ok) {
    setStatus(
      'Permissão negada. Clique em "Configurar pasta…" para reativar o acesso.',
      'error'
    );
    return;
  }
  setStatus(`Reindexando ${currentMeta.name}…`, 'info');
  await performIngest(currentMeta.handle);
}

async function clearAll(): Promise<void> {
  const confirmed = confirm(
    'Remover a configuração da pasta e apagar todos os modelos indexados? ' +
      'A pasta original no disco não será modificada.'
  );
  if (!confirmed) return;

  await clearDirectoryMeta();
  await clearAllTemplates();
  currentMeta = null;
  setStatus('Configuração removida.', 'info');
  setButtonsForState(false);
  $<HTMLParagraphElement>('skipped-summary').textContent = '';
  await refreshTemplatesView();
  await notifyInvalidateIndex();
}

function bindEvents(): void {
  $<HTMLButtonElement>('btn-pick').addEventListener('click', () => {
    void pickDirectory();
  });
  $<HTMLButtonElement>('btn-reindex').addEventListener('click', () => {
    void reindex();
  });
  $<HTMLButtonElement>('btn-clear').addEventListener('click', () => {
    void clearAll();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  void loadInitial();
});

// Evita warning de import não-utilizado em verificações estritas — o tipo
// é referenciado apenas em assinaturas internas.
export type { TemplateRecord };