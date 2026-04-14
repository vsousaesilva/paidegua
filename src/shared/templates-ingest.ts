/**
 * Ingestão de modelos de minuta a partir de um FileSystemDirectoryHandle.
 *
 * Roda APENAS em contexto de página da extensão (opções), porque depende de:
 *   - File System Access API (showDirectoryPicker / handle.values())
 *   - DOM (FileReader, document indireto via libs)
 *
 * Extensões suportadas:
 *   .txt / .md           → leitura direta como UTF-8
 *   .docx                → mammoth.extractRawText
 *   .pdf                 → pdfjs-dist
 *
 * Arquivos com extensões não suportadas são ignorados silenciosamente
 * (relatados em `skipped`). Documentos digitalizados sem texto extraível
 * (PDFs scanned) entram como skipped também — modelos de minuta devem
 * ser sempre texto editável.
 */

import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import { LOG_PREFIX } from './constants';
import type { TemplateRecord } from './templates-store';

export interface IngestProgress {
  /** Arquivos processados (sucesso ou erro) até agora. */
  processed: number;
  /** Total estimado (atualizado conforme a varredura descobre arquivos). */
  total: number;
  /** Caminho relativo do arquivo atual sendo processado. */
  current: string;
}

export interface IngestResult {
  records: TemplateRecord[];
  skipped: { path: string; reason: string }[];
  errors: { path: string; error: string }[];
}

const SUPPORTED_EXTS = new Set(['txt', 'md', 'docx', 'doc', 'odt', 'rtf', 'pdf']);
/** Limite por arquivo individual para evitar travar a UI com PDFs gigantes. */
const MAX_BYTES_PER_FILE = 25 * 1024 * 1024; // 25 MB

let pdfWorkerConfigured = false;

function ensurePdfWorker(): void {
  if (pdfWorkerConfigured) return;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
      'libs/pdf.worker.min.mjs'
    );
    pdfWorkerConfigured = true;
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} ingest: falha ao configurar pdf worker:`, error);
  }
}

function getExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // colapsa runs longos de espaços em 1, mas preserva quebras de linha
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractTxt(file: File): Promise<string> {
  const text = await file.text();
  return normalizeText(text);
}

async function extractDocx(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  // mammoth.extractRawText devolve { value, messages }. Aceita ArrayBuffer
  // diretamente via { arrayBuffer } no browser.
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return normalizeText(result.value ?? '');
}

/**
 * Extrai texto de .rtf removendo comandos RTF e mantendo o texto puro.
 * Abordagem leve sem dependências externas.
 */
async function extractRtf(file: File): Promise<string> {
  const raw = await file.text();
  let text = raw;

  // Remove header e grupos de fontes/cores/stylesheet
  text = text.replace(/\{\\fonttbl[^}]*\}/gi, '');
  text = text.replace(/\{\\colortbl[^}]*\}/gi, '');
  text = text.replace(/\{\\stylesheet[^}]*\}/gi, '');
  text = text.replace(/\{\\info[^}]*\}/gi, '');
  text = text.replace(/\{\\header[^}]*\}/gi, '');
  text = text.replace(/\{\\footer[^}]*\}/gi, '');
  text = text.replace(/\{\\pict[\s\S]*?\}/gi, '');

  // Converte quebras de parágrafo e linha
  text = text.replace(/\\par\b/gi, '\n');
  text = text.replace(/\\line\b/gi, '\n');
  text = text.replace(/\\tab\b/gi, '\t');

  // Converte caracteres unicode RTF: \'XX (hex) e \uNNNN
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  text = text.replace(/\\u(\d+)\s?\??/g, (_m, code) =>
    String.fromCodePoint(parseInt(code, 10))
  );

  // Remove todos os comandos RTF restantes (\keyword, \keywordN)
  text = text.replace(/\\[a-z]+[-]?\d*\s?/gi, '');
  // Remove chaves e caracteres de controle RTF
  text = text.replace(/[{}]/g, '');
  // Remove o marcador inicial \rtf1 caso sobreviva
  text = text.replace(/rtf1/g, '');

  return normalizeText(text);
}

/**
 * Extrai texto de .odt (OpenDocument Text).
 * ODT é um ZIP contendo content.xml com o texto em tags <text:p>.
 */
async function extractOdt(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const entries = await unzipFile(buffer);
  const contentXml = entries['content.xml'];
  if (!contentXml) {
    return '';
  }

  const decoder = new TextDecoder('utf-8');
  const xml = decoder.decode(contentXml);

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const textPs = doc.getElementsByTagNameNS(
    'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
    'p'
  );
  const parts: string[] = [];
  for (let i = 0; i < textPs.length; i++) {
    const p = textPs[i];
    if (p?.textContent) {
      parts.push(p.textContent);
    }
  }
  return normalizeText(parts.join('\n'));
}

/**
 * Descompacta um arquivo ZIP em memória (sem dependências externas).
 * Retorna um mapa de nome_do_arquivo → Uint8Array.
 * Implementação mínima que suporta o subset necessário para ODT.
 */
async function unzipFile(buffer: ArrayBuffer): Promise<Record<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const entries: Record<string, Uint8Array> = {};

  let offset = 0;
  while (offset < bytes.length - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // PK\x03\x04 = local file header

    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    // offset+22 = uncompressedSize (não usado diretamente)
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    const nameBytes = bytes.slice(offset + 30, offset + 30 + nameLen);
    const name = new TextDecoder().decode(nameBytes);

    const dataStart = offset + 30 + nameLen + extraLen;
    const rawData = bytes.slice(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      // Stored (sem compressão)
      entries[name] = rawData;
    } else if (compressionMethod === 8) {
      // Deflate — usa DecompressionStream nativo
      try {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();

        const writePromise = writer.write(rawData).then(() => writer.close());
        const chunks: Uint8Array[] = [];
        let totalLen = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalLen += value.length;
        }
        await writePromise;

        const result = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of chunks) {
          result.set(chunk, pos);
          pos += chunk.length;
        }
        entries[name] = result;
      } catch {
        // Se descompressão falhar, pula o entry
      }
    }

    offset = dataStart + compressedSize;
  }

  return entries;
}

/**
 * Extrai texto de .doc (formato binário OLE2 / Compound File Binary).
 * Abordagem simplificada: busca runs de texto legível no binário.
 * Não parseia a estrutura OLE2 completa — foca em extrair o texto
 * visível que é o que importa para modelos de minuta.
 */
async function extractDoc(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // O Word Binary Format armazena o texto principal logo após o header.
  // Tentamos decodificar como UTF-16LE e filtrar partes legíveis.
  const utf16Text = extractUtf16Runs(bytes);
  if (utf16Text.length > 20) {
    return normalizeText(utf16Text);
  }

  // Estratégia 2: fallback para ASCII/Latin-1 runs
  const asciiText = extractAsciiRuns(bytes);
  return normalizeText(asciiText);
}

function extractUtf16Runs(bytes: Uint8Array): string {
  const parts: string[] = [];
  let run = '';

  for (let i = 0; i < bytes.length - 1; i += 2) {
    const code = bytes[i]! | (bytes[i + 1]! << 8);
    // Caracteres imprimíveis, incluindo acentos (Latin Extended)
    if (
      (code >= 0x20 && code <= 0x7e) ||    // ASCII imprimível
      (code >= 0xa0 && code <= 0x24f) ||    // Latin Extended
      code === 0x0a || code === 0x0d ||     // quebras de linha
      code === 0x09                          // tab
    ) {
      run += String.fromCharCode(code);
    } else {
      if (run.length >= 3) {
        parts.push(run);
      }
      run = '';
    }
  }
  if (run.length >= 3) parts.push(run);

  return parts.join(' ');
}

function extractAsciiRuns(bytes: Uint8Array): string {
  const parts: string[] = [];
  let run = '';

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (
      (b >= 0x20 && b <= 0x7e) ||    // ASCII imprimível
      (b >= 0xa0 && b <= 0xff) ||     // Latin-1 Supplement
      b === 0x0a || b === 0x0d || b === 0x09
    ) {
      run += String.fromCharCode(b);
    } else {
      if (run.length >= 5) {
        parts.push(run);
      }
      run = '';
    }
  }
  if (run.length >= 5) parts.push(run);

  return parts.join(' ');
}

async function extractPdf(file: File): Promise<string> {
  ensurePdfWorker();
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false
  });
  const doc = await loadingTask.promise;
  try {
    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items) {
        if (
          typeof item === 'object' &&
          item !== null &&
          'str' in item &&
          typeof (item as { str: unknown }).str === 'string'
        ) {
          parts.push((item as { str: string }).str);
        }
      }
      pageTexts.push(parts.join(' '));
      page.cleanup();
    }
    return normalizeText(pageTexts.join('\n\n'));
  } finally {
    await doc.cleanup();
    await doc.destroy();
  }
}

/**
 * Varre recursivamente o diretório retornando todos os FileSystemFileHandle
 * encontrados, com seu caminho relativo (para preservar a "categoria" das
 * subpastas, ex.: procedente/, improcedente/).
 */
async function* walkDirectory(
  dir: FileSystemDirectoryHandle,
  prefix = ''
): AsyncGenerator<{ handle: FileSystemFileHandle; relativePath: string }> {
  // FileSystemDirectoryHandle.values() é AsyncIterable mas não está nos
  // typings padrão do TS — fazemos cast para AsyncIterable.
  const entries = (dir as unknown as {
    values: () => AsyncIterable<FileSystemHandle>;
  }).values();

  for await (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      yield { handle: entry as FileSystemFileHandle, relativePath: path };
    } else if (entry.kind === 'directory') {
      yield* walkDirectory(entry as FileSystemDirectoryHandle, path);
    }
  }
}

/**
 * Garante que temos permissão de leitura no handle. Re-pede caso necessário.
 * Retorna `true` se a permissão está concedida ao final.
 */
export async function ensureReadPermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  // queryPermission/requestPermission não estão nos typings padrão.
  const permHandle = handle as unknown as {
    queryPermission: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  };
  const opts = { mode: 'read' as const };
  let state = await permHandle.queryPermission(opts);
  if (state === 'granted') return true;
  state = await permHandle.requestPermission(opts);
  return state === 'granted';
}

/**
 * Ingere todos os arquivos suportados encontrados sob o diretório raiz.
 * Reporta progresso via callback opcional. Não persiste — devolve os
 * `TemplateRecord` para o chamador salvar via templates-store.
 */
export async function ingestDirectory(
  root: FileSystemDirectoryHandle,
  onProgress?: (p: IngestProgress) => void
): Promise<IngestResult> {
  const result: IngestResult = { records: [], skipped: [], errors: [] };

  // Primeira passada: coletar todos os file handles para saber o total.
  const fileEntries: { handle: FileSystemFileHandle; relativePath: string }[] = [];
  for await (const entry of walkDirectory(root)) {
    fileEntries.push(entry);
  }
  const total = fileEntries.length;

  let processed = 0;
  for (const entry of fileEntries) {
    const ext = getExt(entry.handle.name);
    onProgress?.({ processed, total, current: entry.relativePath });

    if (!SUPPORTED_EXTS.has(ext)) {
      result.skipped.push({ path: entry.relativePath, reason: `extensão .${ext || 'sem'} não suportada` });
      processed++;
      continue;
    }

    try {
      const file = await entry.handle.getFile();
      if (file.size > MAX_BYTES_PER_FILE) {
        result.skipped.push({
          path: entry.relativePath,
          reason: `arquivo > ${(MAX_BYTES_PER_FILE / 1024 / 1024).toFixed(0)} MB`
        });
        processed++;
        continue;
      }

      let text: string;
      if (ext === 'txt' || ext === 'md') {
        text = await extractTxt(file);
      } else if (ext === 'docx') {
        text = await extractDocx(file);
      } else if (ext === 'doc') {
        text = await extractDoc(file);
      } else if (ext === 'odt') {
        text = await extractOdt(file);
      } else if (ext === 'rtf') {
        text = await extractRtf(file);
      } else {
        text = await extractPdf(file);
      }

      if (!text) {
        result.skipped.push({
          path: entry.relativePath,
          reason: 'não foi possível extrair texto do arquivo'
        });
        processed++;
        continue;
      }

      const record: TemplateRecord = {
        relativePath: entry.relativePath,
        name: entry.handle.name,
        ext,
        size: file.size,
        lastModified: file.lastModified,
        text,
        charCount: text.length,
        ingestedAt: new Date().toISOString()
      };
      result.records.push(record);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push({ path: entry.relativePath, error: msg });
    }

    processed++;
  }

  onProgress?.({ processed, total, current: '' });
  return result;
}