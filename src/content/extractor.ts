/**
 * Orquestrador de extração de conteúdo de documentos.
 *
 * Recebe uma lista de `ProcessoDocumento` (com URL + metadados, tipicamente
 * produzida por `BaseAdapter.extractDocumentos()`) e, para cada documento,
 * faz fetch binário com os cookies de sessão do usuário e converte o
 * conteúdo para texto usando pdf-parser.ts.
 *
 * Emite eventos de progresso via callback, permitindo que a UI mostre
 * status "extraindo X de Y..." e erros por documento.
 *
 * Performance:
 *  - Fetch direto (isolated world) como método primário — zero overhead
 *  - MAIN world fetch APENAS como fallback para docs que retornam 0 bytes
 *  - Concorrência 2 para sobrepor I/O e CPU sem irritar o PJe
 *  - Ativação PJe sob demanda (último recurso, ~2 docs por processo)
 */

import { LOG_PREFIX } from '../shared/constants';
import type { ProcessoDocumento } from '../shared/types';
import { parsePdf } from './pdf-parser';
import { MAX_OCR_PAGES, ocrPdf, type OcrOptions, type OcrProgress } from './ocr';

/** Entrada no log de diagnóstico de extração de um documento. */
export interface DiagnosticEntry {
  etapa: string;
  ok: boolean;
  detalhe: string;
  /** Milissegundos desde o início da extração deste documento. */
  ms: number;
}

export type ExtractProgressEvent =
  | { type: 'start'; total: number }
  | { type: 'document-start'; index: number; documento: ProcessoDocumento }
  | { type: 'document-done'; index: number; documento: ProcessoDocumento }
  | { type: 'document-error'; index: number; documento: ProcessoDocumento; error: string; diagnostics: DiagnosticEntry[] }
  | { type: 'done'; extracted: ProcessoDocumento[] };

export type ExtractProgressHandler = (event: ExtractProgressEvent) => void;

const DOCUMENT_FETCH_TIMEOUT_MS = 30_000;
const MAIN_WORLD_TIMEOUT_MS = 6_000;
const DOWNLOAD_CONCURRENCY = 3;

// ============================================================================
// Utilitários
// ============================================================================

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      credentials: 'include',
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timer);
  }
}

function inferMimeType(response: Response, fallback: string): string {
  const header = response.headers.get('content-type');
  if (header) return header.split(';')[0]?.trim() ?? fallback;
  return fallback;
}

function bufferIsPdf(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 10) return false;
  const h = new Uint8Array(buf.slice(0, 4));
  return h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46;
}

function extractDocIdFromUrl(url: string): string | null {
  const paramMatch = url.match(/idProcessoDocumento(?:Bin)?=(\d+)/i);
  if (paramMatch?.[1]) return paramMatch[1];
  const binMatch = url.match(/\/binario\/(\d+)/i);
  if (binMatch?.[1]) return binMatch[1];
  const dlMatch = url.match(/\/documento\/download\/(\d+)/i);
  if (dlMatch?.[1]) return dlMatch[1];
  const docMatch = url.match(/\/documentos?\/(\d+)/i);
  if (docMatch?.[1]) return docMatch[1];
  return null;
}

// ============================================================================
// MAIN world fetch — ponte com o contexto da página (usado APENAS como fallback)
// ============================================================================

/** Estado da ponte: null = não tentou, true = funcionando, false = falhou */
let bridgeState: boolean | null = null;

function ensureMainWorldBridge(): boolean {
  if (bridgeState !== null) return bridgeState;

  try {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        document.documentElement.setAttribute('data-paidegua-bridge', 'ready');
        document.addEventListener('paidegua-fetch-request', async function(e) {
          var d = e.detail || {};
          try {
            var resp = await fetch(d.url, { credentials: 'include' });
            var buf = await resp.arrayBuffer();
            var blob = new Blob([buf]);
            var blobUrl = URL.createObjectURL(blob);
            document.dispatchEvent(new CustomEvent('paidegua-fetch-response', {
              detail: { rid: d.rid, blobUrl: blobUrl, byteLength: buf.byteLength,
                        ct: resp.headers.get('content-type') || '' }
            }));
          } catch(err) {
            document.dispatchEvent(new CustomEvent('paidegua-fetch-response', {
              detail: { rid: d.rid, error: err.message || String(err) }
            }));
          }
        });
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();

    // Verificação: o script MAIN world seta um atributo DOM compartilhado
    bridgeState = document.documentElement.getAttribute('data-paidegua-bridge') === 'ready';
    if (!bridgeState) {
      console.warn(`${LOG_PREFIX} Ponte MAIN world não inicializou (CSP pode estar bloqueando).`);
    } else {
      console.log(`${LOG_PREFIX} Ponte MAIN world ativa.`);
    }
  } catch {
    bridgeState = false;
    console.warn(`${LOG_PREFIX} Erro ao injetar ponte MAIN world.`);
  }

  return bridgeState;
}

function fetchViaMainWorld(
  url: string
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  if (!ensureMainWorldBridge()) {
    return Promise.reject(new Error('Ponte MAIN world indisponível'));
  }
  return new Promise((resolve, reject) => {
    const rid = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = window.setTimeout(() => {
      document.removeEventListener('paidegua-fetch-response', handler);
      reject(new Error('Timeout no fetch via MAIN world'));
    }, MAIN_WORLD_TIMEOUT_MS);

    const handler = async (evt: Event) => {
      const detail = (evt as CustomEvent).detail;
      if (detail?.rid !== rid) return;
      document.removeEventListener('paidegua-fetch-response', handler);
      window.clearTimeout(timer);
      if (detail.error) { reject(new Error(detail.error)); return; }
      try {
        const resp = await fetch(detail.blobUrl);
        const buffer = await resp.arrayBuffer();
        URL.revokeObjectURL(detail.blobUrl);
        resolve({ buffer, contentType: detail.ct ?? '' });
      } catch (e) { reject(e); }
    };

    document.addEventListener('paidegua-fetch-response', handler);
    document.dispatchEvent(
      new CustomEvent('paidegua-fetch-request', { detail: { rid, url } })
    );
  });
}

// ============================================================================
// Ativação de documentos no PJe (sob demanda, último recurso)
// ============================================================================

async function activateDocumentInPje(docId: string): Promise<boolean> {
  const findAndClick = (root: Document): boolean => {
    const candidates = root.querySelectorAll<HTMLElement>(
      'a, span[onclick], div[onclick], td[onclick], .rich-tree-node, .rf-trn'
    );
    for (const el of Array.from(candidates)) {
      const text = el.textContent ?? '';
      const onclick = el.getAttribute('onclick') ?? '';
      const href = el.getAttribute('href') ?? '';
      const hasId = text.includes(`${docId} -`) || text.includes(`${docId} –`) ||
                    onclick.includes(docId) || href.includes(docId);
      if (hasId) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.height < 200) {
          console.log(`${LOG_PREFIX} Ativando doc ${docId} via clique na árvore`);
          el.click();
          return true;
        }
      }
    }
    return false;
  };

  if (findAndClick(document)) return true;
  const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe, frame');
  for (const frame of Array.from(iframes)) {
    try {
      const childDoc = frame.contentDocument;
      if (childDoc?.body && findAndClick(childDoc)) return true;
    } catch { /* cross-origin */ }
  }
  return false;
}

// ============================================================================
// Extração de um documento
// ============================================================================

/**
 * MIME types que não contêm texto extraível. Documentos com esses types
 * são marcados como concluídos sem erro, mas sem texto.
 */
const NON_TEXT_MIME_PREFIXES = ['audio/', 'video/', 'image/'];

function isNonTextMime(mime: string): boolean {
  const lower = mime.toLowerCase();
  return NON_TEXT_MIME_PREFIXES.some(p => lower.startsWith(p));
}

/** Resultado interno de extractOne — documento enriquecido + trilha de diagnóstico. */
interface ExtractOneResult {
  documento: ProcessoDocumento;
  diagnostics: DiagnosticEntry[];
}

/**
 * Baixa e parseia um documento. Fluxo:
 *  1) Fetch direto (rápido, funciona para ~90% dos docs)
 *  2) Se 0 bytes / HTML inválido → fallback MAIN world
 *  3) Se ainda 0 bytes → ativa no PJe + retry via fetch direto
 *
 * Cada etapa é registrada em `diagnostics` para inspeção posterior.
 */
async function extractOne(doc: ProcessoDocumento): Promise<ExtractOneResult> {
  const docId = extractDocIdFromUrl(doc.url) ?? doc.id;
  const t0 = performance.now();
  const diagnostics: DiagnosticEntry[] = [];

  const diag = (etapa: string, ok: boolean, detalhe: string): void => {
    diagnostics.push({ etapa, ok, detalhe, ms: Math.round(performance.now() - t0) });
  };

  // --- Passo 1: fetch direto (rápido, sem overhead) ---
  let response: Response;
  try {
    response = await fetchWithTimeout(doc.url, DOCUMENT_FETCH_TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diag('fetch-direto', false, `exceção: ${msg}`);
    throw new ExtractionError(`Fetch direto falhou: ${msg}`, diagnostics);
  }

  if (!response.ok) {
    diag('fetch-direto', false, `HTTP ${response.status} ${response.statusText}`);
    throw new ExtractionError(
      `HTTP ${response.status} ${response.statusText}`,
      diagnostics
    );
  }

  let buffer = await response.arrayBuffer();
  let mimeType = inferMimeType(response, doc.mimeType || 'application/pdf');

  diag('fetch-direto', true, `${buffer.byteLength} bytes, mime=${mimeType}, isPdf=${bufferIsPdf(buffer)}`);

  // MIME type não-textual (áudio, vídeo, imagem): marca sem erro mas sem texto
  if (isNonTextMime(mimeType)) {
    diag('tipo-nao-textual', true, mimeType);
    return {
      documento: {
        ...doc,
        mimeType,
        tamanho: buffer.byteLength,
        textoExtraido: `[Arquivo ${mimeType} — conteúdo não-textual]`,
        isScanned: false
      },
      diagnostics
    };
  }

  const isUsable = (): boolean => {
    if (buffer.byteLength === 0) return false;
    if (mimeType.includes('pdf') && bufferIsPdf(buffer)) return true;
    if (mimeType.includes('html') || mimeType.includes('text')) return true;
    if (mimeType.includes('pdf') && !bufferIsPdf(buffer)) return false;
    return buffer.byteLength > 0;
  };

  // --- Passo 2: fallback MAIN world (só se o fetch direto falhou) ---
  if (!isUsable()) {
    diag('fetch-direto-inutilizavel', false, `${buffer.byteLength} bytes, mime=${mimeType}, isPdf=${bufferIsPdf(buffer)}`);

    try {
      const mw = await fetchViaMainWorld(doc.url);
      if (mw.buffer.byteLength > 0) {
        buffer = mw.buffer;
        mimeType = mw.contentType || mimeType;
        diag('main-world', true, `${buffer.byteLength} bytes, mime=${mimeType}`);
      } else {
        diag('main-world', false, `0 bytes retornados`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diag('main-world', false, `exceção: ${msg}`);
    }

    // --- Passo 3: ativar no PJe + retry (último recurso) ---
    if (!isUsable() && docId) {
      let activated = false;
      try {
        activated = await activateDocumentInPje(docId);
        diag('ativacao-pje', activated, activated ? 'elemento encontrado e clicado' : 'elemento não encontrado no DOM');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diag('ativacao-pje', false, `exceção: ${msg}`);
      }

      if (activated) {
        await new Promise(r => setTimeout(r, 2000));

        // Após ativação, tenta PRIMEIRO o fetch direto (mais rápido)
        try {
          const retryResp = await fetchWithTimeout(doc.url, DOCUMENT_FETCH_TIMEOUT_MS);
          if (retryResp.ok) {
            const retryBuf = await retryResp.arrayBuffer();
            if (retryBuf.byteLength > 0) {
              buffer = retryBuf;
              mimeType = inferMimeType(retryResp, mimeType);
              diag('retry-fetch-pos-ativacao', true, `${buffer.byteLength} bytes`);
            } else {
              diag('retry-fetch-pos-ativacao', false, '0 bytes');
            }
          } else {
            diag('retry-fetch-pos-ativacao', false, `HTTP ${retryResp.status}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          diag('retry-fetch-pos-ativacao', false, `exceção: ${msg}`);
        }

        // Se fetch direto ainda falhou, tenta MAIN world
        if (!isUsable()) {
          try {
            const mw = await fetchViaMainWorld(doc.url);
            if (mw.buffer.byteLength > 0) {
              buffer = mw.buffer;
              mimeType = mw.contentType || mimeType;
              diag('retry-main-world-pos-ativacao', true, `${buffer.byteLength} bytes`);
            } else {
              diag('retry-main-world-pos-ativacao', false, '0 bytes');
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            diag('retry-main-world-pos-ativacao', false, `exceção: ${msg}`);
          }
        }
      }
    }
  }

  // --- Parse do conteúdo ---
  const enriched: ProcessoDocumento = {
    ...doc,
    mimeType,
    tamanho: buffer.byteLength
  };

  // PDF
  if (bufferIsPdf(buffer)) {
    try {
      const parsed = await parsePdf(buffer);
      enriched.textoExtraido = parsed.text;
      enriched.isScanned = parsed.isScanned;
      enriched.mimeType = 'application/pdf';
      diag('parse-pdf', true, `${parsed.pageCount} páginas, scanned=${parsed.isScanned}`);
      return { documento: enriched, diagnostics };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diag('parse-pdf', false, `exceção: ${msg}`);
      throw new ExtractionError(
        `Falha ao parsear PDF do documento ${doc.id}: ${msg}`,
        diagnostics
      );
    }
  }

  // Resposta vazia após todas as tentativas
  if (buffer.byteLength === 0) {
    diag('resultado-final', false, 'buffer vazio após todas as tentativas');
    throw new ExtractionError(
      `Documento ${doc.id}: não foi possível baixar o conteúdo após todas as tentativas.`,
      diagnostics
    );
  }

  // HTML / texto
  if (mimeType.includes('html') || mimeType.includes('text')) {
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

    if (mimeType.includes('html')) {
      // Tenta extrair PDF embutido em iframe/embed
      const parser = new DOMParser();
      const htmlDoc = parser.parseFromString(decoded, 'text/html');
      const pdfEmbed =
        htmlDoc.querySelector<HTMLIFrameElement>(
          'iframe[src*=".pdf"], iframe[src*="downloadBinario"], iframe[src*="binario"], iframe[src*="download"]'
        ) ??
        htmlDoc.querySelector<HTMLEmbedElement>(
          'embed[src*=".pdf"], embed[src*="downloadBinario"]'
        ) ??
        htmlDoc.querySelector<HTMLObjectElement>(
          'object[data*=".pdf"], object[data*="downloadBinario"]'
        );

      if (pdfEmbed) {
        const pdfSrc = pdfEmbed.getAttribute('src') ?? pdfEmbed.getAttribute('data') ?? '';
        if (pdfSrc) {
          const absolutePdfUrl = new URL(pdfSrc, doc.url).href;
          diag('html-pdf-embutido', true, `encontrado embed/iframe, url=${absolutePdfUrl}`);
          try {
            const pdfResponse = await fetchWithTimeout(absolutePdfUrl, DOCUMENT_FETCH_TIMEOUT_MS);
            if (pdfResponse.ok) {
              const pdfBuffer = await pdfResponse.arrayBuffer();
              if (bufferIsPdf(pdfBuffer)) {
                const parsed = await parsePdf(pdfBuffer);
                enriched.textoExtraido = parsed.text;
                enriched.isScanned = parsed.isScanned;
                enriched.mimeType = 'application/pdf';
                enriched.tamanho = pdfBuffer.byteLength;
                diag('parse-pdf-embutido', true, `${parsed.pageCount} páginas`);
                return { documento: enriched, diagnostics };
              }
              diag('parse-pdf-embutido', false, `conteúdo não é PDF (${pdfBuffer.byteLength} bytes)`);
            } else {
              diag('parse-pdf-embutido', false, `HTTP ${pdfResponse.status}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            diag('parse-pdf-embutido', false, `exceção: ${msg}`);
          }
        }
      }

      // HTML sem PDF embutido — diferenciar três casos:
      //  (a) Desafio anti-bot do F5/BIG-IP (TSPD): HTML grande só com JS
      //      de challenge (`window["loaderConfig"]`, `TSPD`, `window.nRx`).
      //  (b) Interface do PJe (JSF/PrimeFaces/RichFaces): retorno quando
      //      a URL exige autenticação/ViewState — contém marcadores JSF.
      //  (c) Documento-rótulo: nó da árvore que existe só como título
      //      (ex.: "NOVOS DOCUMENTOS MÉDICOS"). HTML curto, SEM marcadores
      //      de chrome. É conteúdo válido — o próprio título é o que há.
      const plain = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const rawLower = decoded.toLowerCase();
      const isTspdChallenge =
        rawLower.includes('tspd') ||
        rawLower.includes('loaderconfig') ||
        rawLower.includes('window.nrx');
      const isPjeChrome =
        plain.includes('javax.faces') || plain.includes('PrimeFaces') ||
        plain.includes('richfaces') || plain.includes('Lembrete');

      if (isTspdChallenge) {
        const snippet = plain.slice(0, 200);
        diag('html-chrome-pje', false, `desafio anti-bot F5/TSPD (${plain.length} chars): "${snippet}…"`);
        throw new ExtractionError(
          `Documento ${doc.id}: URL retornou desafio anti-bot do F5/BIG-IP (TSPD) — a sessão precisa ser revalidada. Recarregue o PJe e tente novamente.`,
          diagnostics
        );
      }
      if (isPjeChrome) {
        const snippet = plain.slice(0, 200);
        diag('html-chrome-pje', false, `conteúdo é interface PJe (${plain.length} chars): "${snippet}…"`);
        throw new ExtractionError(
          `Documento ${doc.id}: URL retornou a interface do PJe em vez do arquivo.`,
          diagnostics
        );
      }
      // HTML curto sem marcador de chrome → documento-rótulo legítimo.
      // Aceita como conteúdo (o próprio texto curto É o descritor/título).
      enriched.textoExtraido = plain;
      enriched.isScanned = false;
      if (plain.length < 100) {
        diag('parse-html', true, `${plain.length} chars (documento-rótulo — sem corpo próprio)`);
      } else {
        diag('parse-html', true, `${plain.length} chars de texto`);
      }
      return { documento: enriched, diagnostics };
    }

    enriched.textoExtraido = decoded;
    enriched.isScanned = false;
    diag('parse-texto', true, `${decoded.length} chars`);
    return { documento: enriched, diagnostics };
  }

  diag('resultado-final', false, `MIME type não suportado: ${mimeType}`);
  throw new ExtractionError(`MIME type não suportado: ${mimeType}`, diagnostics);
}

/**
 * Erro de extração que carrega a trilha de diagnóstico.
 * Permite que o orquestrador repasse os detalhes à UI.
 */
class ExtractionError extends Error {
  diagnostics: DiagnosticEntry[];
  constructor(message: string, diagnostics: DiagnosticEntry[]) {
    super(message);
    this.name = 'ExtractionError';
    this.diagnostics = diagnostics;
  }
}

// ============================================================================
// Orquestrador — extração com concorrência controlada
// ============================================================================

/**
 * Extrai conteúdo de uma lista de documentos.
 * Concorrência 2: sobrepõe I/O de rede com CPU (parse PDF) sem
 * sobrecarregar o servidor do PJe.
 */
export async function extractContents(
  documentos: ProcessoDocumento[],
  onProgress?: ExtractProgressHandler
): Promise<ProcessoDocumento[]> {
  onProgress?.({ type: 'start', total: documentos.length });

  const extracted: ProcessoDocumento[] = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= documentos.length) break;
      const source = documentos[index];
      if (!source) continue;

      onProgress?.({ type: 'document-start', index, documento: source });
      try {
        const result = await extractOne(source);
        extracted.push(result.documento);
        onProgress?.({ type: 'document-done', index, documento: result.documento });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const diagnostics = error instanceof ExtractionError ? error.diagnostics : [];

        // Log estruturado no console para depuração
        console.warn(
          `${LOG_PREFIX} falha ao extrair doc ${source.id} (${source.tipo || 'tipo?'} — "${source.descricao || '?'}"):\n` +
          `  Erro: ${message}\n` +
          `  Diagnóstico (${diagnostics.length} etapas):\n` +
          diagnostics.map(d =>
            `    [${d.ms}ms] ${d.etapa}: ${d.ok ? 'OK' : 'FALHA'} — ${d.detalhe}`
          ).join('\n')
        );

        onProgress?.({
          type: 'document-error',
          index,
          documento: source,
          error: message,
          diagnostics
        });
      }
    }
  };

  const concurrency = Math.min(DOWNLOAD_CONCURRENCY, documentos.length);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  onProgress?.({ type: 'done', extracted });
  return extracted;
}

// ============================================================================
// Fase 5 — OCR de documentos digitalizados
// ============================================================================

export type OcrProgressEvent =
  | { type: 'ocr-start'; total: number }
  | { type: 'ocr-document-start'; index: number; documento: ProcessoDocumento }
  | { type: 'ocr-page'; index: number; documento: ProcessoDocumento; progress: OcrProgress }
  | {
      type: 'ocr-document-done';
      index: number;
      documento: ProcessoDocumento;
      pagesProcessed: number;
      pagesSkipped: number;
    }
  | { type: 'ocr-document-error'; index: number; documento: ProcessoDocumento; error: string }
  | { type: 'ocr-done'; updated: ProcessoDocumento[] };

export type OcrProgressHandler = (event: OcrProgressEvent) => void;

export function getOcrPendingDocuments(
  docs: ProcessoDocumento[]
): ProcessoDocumento[] {
  return docs.filter((doc) => {
    if (!doc.isScanned) return false;
    const text = doc.textoExtraido?.trim() ?? '';
    return text.length < 50;
  });
}

export async function runOcrOnDocuments(
  docs: ProcessoDocumento[],
  onProgress?: OcrProgressHandler,
  options?: OcrOptions
): Promise<ProcessoDocumento[]> {
  const targets = getOcrPendingDocuments(docs);
  onProgress?.({ type: 'ocr-start', total: targets.length });

  const updatedMap = new Map<string, ProcessoDocumento>();

  for (let index = 0; index < targets.length; index++) {
    const doc = targets[index]!;
    onProgress?.({ type: 'ocr-document-start', index, documento: doc });
    try {
      const response = await fetchWithTimeout(doc.url, DOCUMENT_FETCH_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let buffer = await response.arrayBuffer();

      // Se o fetch isolado retorna 0 bytes para OCR, tenta MAIN world
      if (buffer.byteLength === 0) {
        try {
          const mw = await fetchViaMainWorld(doc.url);
          buffer = mw.buffer;
        } catch { /* usa o buffer vazio, ocrPdf dará erro */ }
      }

      const result = await ocrPdf(
        buffer,
        (progress) => {
          onProgress?.({ type: 'ocr-page', index, documento: doc, progress });
        },
        options
      );

      const updated: ProcessoDocumento = {
        ...doc,
        textoExtraido: result.text,
        isScanned: true
      };
      updatedMap.set(doc.id, updated);

      onProgress?.({
        type: 'ocr-document-done',
        index,
        documento: updated,
        pagesProcessed: result.pagesProcessed,
        pagesSkipped: result.pagesSkipped
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${LOG_PREFIX} falha no OCR de ${doc.id}:`, message);
      onProgress?.({
        type: 'ocr-document-error',
        index,
        documento: doc,
        error: message
      });
    }
  }

  const merged = docs.map((d) => updatedMap.get(d.id) ?? d);
  const updatedList = Array.from(updatedMap.values());
  onProgress?.({ type: 'ocr-done', updated: updatedList });

  if (targets.length > 0) {
    console.log(
      `${LOG_PREFIX} OCR concluído. ${updatedList.length}/${targets.length} documentos processados (limite: ${MAX_OCR_PAGES} páginas/doc).`
    );
  }

  return merged;
}