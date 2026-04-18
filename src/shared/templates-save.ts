/**
 * Gravação de uma minuta como novo modelo na pasta configurada pelo usuário
 * e registro correspondente no IndexedDB de templates.
 *
 * Fluxo (sempre a partir de um user gesture, em contexto de página da
 * extensão — NÃO funciona em service worker nem em content script):
 *
 *   1. Resolver subpasta com `resolveSubdirectory`
 *   2. Escrever o .doc via FileSystemWritableFileStream
 *   3. Extrair texto plano via `stripMarkdownHtml` para o índice BM25
 *   4. Remover (se existir) registro antigo com mesmo relativePath
 *   5. Salvar `TemplateRecord` novo em IDB
 *
 * A limpeza do índice BM25 é responsabilidade do chamador — precisa enviar
 * `TEMPLATES_INVALIDATE` ao background depois do append.
 */

import type { TemplateRecord } from './templates-store';
import { openTemplatesDb, TEMPLATES_STORES } from './templates-store';

/** Payload trocado entre content → background → página save-template. */
export interface SaveTemplatePayload {
  /** HTML renderizado para o .doc (mesmo usado no "Baixar .doc"). */
  html: string;
  /** Markdown cru, usado para o índice BM25 (texto buscável). */
  markdown: string;
  /** Rótulo da ação (ex.: "Sentença procedente"), usado na subpasta. */
  actionLabel: string;
  /** Id interno da ação (ex.: "sentenca-procedente"). */
  actionId: string;
  /** Número de processo, se detectado. Usado só no nome do arquivo. */
  numeroProcesso: string | null;
  /** Nome do arquivo sugerido (já com extensão .doc). */
  suggestedFilename: string;
}

/**
 * Normaliza um rótulo para virar nome de subpasta.
 * "Sentença Procedente" → "sentenca-procedente"
 */
export function slugifySubfolder(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'geral';
}

/**
 * Converte o HTML (Word-HTML gerado por `buildWordDocument`) em texto
 * aproximadamente plano, para alimentar o índice BM25. Mantém quebras
 * de parágrafo — não precisa ser perfeito, só preservar termos.
 */
export function htmlToIndexableText(html: string): string {
  // Remove scripts/styles e tags Office que possam ter sobrado.
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // Quebras em blocos estruturais
  t = t
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n');
  // Remove todas as demais tags
  t = t.replace(/<[^>]+>/g, '');
  // Decodifica entidades mínimas
  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return t
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Obtém (ou cria) uma subpasta dentro da raiz de modelos.
 */
async function resolveSubdirectory(
  root: FileSystemDirectoryHandle,
  subfolder: string
): Promise<FileSystemDirectoryHandle> {
  if (!subfolder) return root;
  return root.getDirectoryHandle(subfolder, { create: true });
}

/**
 * Grava um arquivo no diretório. Se já existir, sobrescreve.
 */
async function writeFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob
): Promise<void> {
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  // `createWritable` não está nos typings padrão do TS.
  const handle = fileHandle as unknown as {
    createWritable: () => Promise<{
      write: (data: Blob | BufferSource | string) => Promise<void>;
      close: () => Promise<void>;
    }>;
  };
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

export interface SaveTemplateResult {
  /** Caminho relativo final, ex.: "sentenca-procedente/minuta-....doc". */
  relativePath: string;
  /** Nome só do arquivo. */
  filename: string;
  /** Subpasta resolvida (ou string vazia se foi salvo na raiz). */
  subfolder: string;
  /** Tamanho em bytes do arquivo gravado. */
  size: number;
  /** Quantidade de caracteres indexados. */
  charCount: number;
}

/**
 * Grava o .doc na pasta de modelos e anexa um `TemplateRecord` ao IDB.
 *
 * Pré-condições:
 *  - `root` já com permissão `readwrite` garantida pelo chamador
 *    (ver `ensureReadWritePermission`).
 *  - Estamos em contexto de página da extensão (IndexedDB da origem da
 *    extensão — o mesmo que options.ts usa).
 */
export async function saveAsTemplate(
  root: FileSystemDirectoryHandle,
  payload: SaveTemplatePayload,
  blob: Blob
): Promise<SaveTemplateResult> {
  const subfolder = slugifySubfolder(payload.actionLabel);
  const dir = await resolveSubdirectory(root, subfolder);
  const filename = payload.suggestedFilename.endsWith('.doc')
    ? payload.suggestedFilename
    : `${payload.suggestedFilename}.doc`;

  await writeFile(dir, filename, blob);

  const relativePath = subfolder ? `${subfolder}/${filename}` : filename;
  const size = blob.size;
  const text = htmlToIndexableText(payload.html);
  const now = new Date();

  const record: TemplateRecord = {
    relativePath,
    name: filename,
    ext: 'doc',
    size,
    lastModified: now.getTime(),
    text,
    charCount: text.length,
    ingestedAt: now.toISOString()
  };

  await upsertTemplateRecord(record);

  return {
    relativePath,
    filename,
    subfolder,
    size,
    charCount: text.length
  };
}

/**
 * Insere ou substitui um TemplateRecord pelo `relativePath`. Usamos um
 * upsert porque, ao gravar de novo uma minuta com o mesmo nome, queremos
 * atualizar o índice em vez de quebrar na constraint de unicidade.
 */
async function upsertTemplateRecord(record: TemplateRecord): Promise<void> {
  const db = await openTemplatesDb();
  try {
    const tx = db.transaction(TEMPLATES_STORES.TEMPLATES, 'readwrite');
    const store = tx.objectStore(TEMPLATES_STORES.TEMPLATES);
    const index = store.index('relativePath');

    const existingKey = await new Promise<IDBValidKey | undefined>((resolve, reject) => {
      const req = index.getKey(record.relativePath);
      req.onsuccess = (): void => resolve(req.result ?? undefined);
      req.onerror = (): void =>
        reject(req.error ?? new Error('Falha ao consultar índice'));
    });

    if (existingKey !== undefined) {
      // Reusa o id autoincrement já existente.
      store.put({ ...record, id: existingKey as number });
    } else {
      store.put(record);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void =>
        reject(tx.error ?? new Error('Falha ao gravar TemplateRecord'));
      tx.onabort = (): void =>
        reject(tx.error ?? new Error('Transação abortada'));
    });
  } finally {
    db.close();
  }
}
