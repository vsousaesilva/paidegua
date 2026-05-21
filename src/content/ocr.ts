/**
 * Render de PDFs e OCR local via Tesseract.js + pdf.js.
 *
 * O fluxo principal da extensão (extração de documentos do PJe) NÃO
 * transcreve mais documentos digitalizados: ele renderiza as páginas
 * como imagem e as envia direto à IA multimodal (ver `runOcrViaIA` em
 * `extractor.ts`). Render é sempre no content script — pdf.js `page.render`
 * trava silenciosamente em offscreen documents (descoberta da
 * investigação BUG-21).
 *
 * Funções principais:
 *  - `renderPdfToImages(buffer)` — renderiza o PDF para data URLs JPEG,
 *    uma por página. É a base do OCR imagem-direto.
 *  - `ocrPdf(buffer)` — pipeline completo render + transcrição Tesseract.
 *    Usado apenas pelo painel do sistema criminal (`criminal-dashboard`),
 *    que tem seu próprio fluxo de OCR local.
 *  - `createOcrWorker` — fábrica do worker Tesseract reutilizável.
 */

import * as pdfjsLib from 'pdfjs-dist';
import Tesseract from 'tesseract.js';
import { LOG_PREFIX } from '../shared/constants';

export type TesseractWorker = Tesseract.Worker;

/** Número máximo de páginas processadas por documento (fallback). */
export const MAX_OCR_PAGES = 30;

export interface OcrOptions {
  /** Override do cap de páginas. Zero ou negativo cai no fallback. */
  maxPages?: number;
  /**
   * Worker Tesseract pré-criado para reutilização entre documentos. Quando
   * presente, `ocrPdf` NÃO cria nem termina o worker — apenas usa. Esse é o
   * principal acelerador para batches: criar um worker custa ~3-5s
   * (carregamento de `por.traineddata` ~25MB), então passar o mesmo worker
   * para 10 docs economiza ~30-50s.
   */
  worker?: TesseractWorker;
}

/**
 * Fator de escala aplicado ao render do PDF antes do OCR.
 * 1.5 (~108 DPI numa folha A4) é suficiente para o modelo de visão ler
 * texto impresso e manuscrito; acima disso a imagem só fica mais pesada
 * (upload mais lento, mais tiles de visão) sem ganho de acurácia.
 */
const RENDER_SCALE = 1.5;

export interface OcrProgress {
  /** Página atual (1-indexed) sendo processada. */
  currentPage: number;
  /** Total de páginas que serão processadas (respeita MAX_OCR_PAGES). */
  totalPages: number;
  /** Fração 0..1 do progresso dentro da página atual (status do Tesseract). */
  pageProgress: number;
  /** Status textual vindo do Tesseract (ex.: "recognizing text"). */
  status: string;
}

export interface OcrResult {
  text: string;
  pagesProcessed: number;
  pagesSkipped: number;
  totalPages: number;
}

/**
 * Executa OCR em um PDF. Não assume que o documento é scanned — o chamador
 * decide quando invocar (tipicamente quando `parsePdf` retornou `isScanned=true`).
 */
export async function ocrPdf(
  buffer: ArrayBuffer,
  onProgress?: (p: OcrProgress) => void,
  options?: OcrOptions
): Promise<OcrResult> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    // Em MV3 a CSP da extension page bloqueia eval/Function — sem
    // este flag o pdf.js cai num path interno que tenta `Function(...)`
    // e quebra a abertura do PDF antes mesmo do OCR começar.
    isEvalSupported: false,
    verbosity: 0
  });
  const doc = await loadingTask.promise;
  const totalPages = doc.numPages;
  const effectiveCap =
    options?.maxPages && options.maxPages > 0 ? options.maxPages : MAX_OCR_PAGES;
  const pagesToProcess = Math.min(totalPages, effectiveCap);

  const externalWorker = options?.worker ?? null;
  let worker: TesseractWorker | null = externalWorker;
  const pageTexts: string[] = [];

  // Estado mutável compartilhado entre o logger do Tesseract e o loop
  // de páginas (o logger roda async dentro do worker e não sabe qual
  // página está sendo processada).
  let lastStatus = 'initializing';
  let lastProgress = 0;

  try {
    if (!worker) {
      worker = await createOcrWorker((m) => {
        lastStatus = m.status ?? lastStatus;
        lastProgress = typeof m.progress === 'number' ? m.progress : lastProgress;
      });
    }

    for (let pageIndex = 1; pageIndex <= pagesToProcess; pageIndex++) {
      const page = await doc.getPage(pageIndex);
      const viewport = page.getViewport({ scale: RENDER_SCALE });

      // <canvas> HTML "solto" (sem appendChild): funciona em ambos os
      // contextos. OffscreenCanvas no offscreen document fazia page.render
      // pendurar — ver doc do módulo.
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('canvas 2d context indisponível');
      }

      await page.render({
        canvasContext: context,
        viewport,
        canvas
      }).promise;
      page.cleanup();

      onProgress?.({
        currentPage: pageIndex,
        totalPages: pagesToProcess,
        pageProgress: 0,
        status: 'rendering'
      });

      const { data } = await worker.recognize(canvas);
      pageTexts.push((data.text || '').trim());

      onProgress?.({
        currentPage: pageIndex,
        totalPages: pagesToProcess,
        pageProgress: lastProgress,
        status: lastStatus
      });
    }
  } finally {
    // Só terminamos o worker se NÓS o criamos. Worker externo é
    // responsabilidade do chamador.
    if (worker && !externalWorker) {
      try {
        await worker.terminate();
      } catch (err: unknown) {
        console.warn(`${LOG_PREFIX} falha ao terminar worker Tesseract:`, err);
      }
    }
    try {
      await doc.cleanup();
      await doc.destroy();
    } catch {
      /* ignore */
    }
  }

  const text = pageTexts
    .map((t, i) => `=== Página ${i + 1} (OCR) ===\n${t}`)
    .join('\n\n');

  return {
    text,
    pagesProcessed: pagesToProcess,
    pagesSkipped: Math.max(0, totalPages - pagesToProcess),
    totalPages
  };
}

export interface RenderedPdfImage {
  /**
   * Data URL `data:image/jpeg;base64,…` da página renderizada.
   * Formato escolhido (em vez de Blob direto) porque chrome.runtime.sendMessage
   * serializa via JSON entre contextos — Blobs viram `{}` vazios. Data URL é
   * string, atravessa runtime msg sem perda. Overhead ~33% no tamanho vs Blob.
   */
  dataUrl: string;
  /** Largura da imagem em pixels (após escala). */
  width: number;
  /** Altura da imagem em pixels (após escala). */
  height: number;
}

export interface RenderPdfResult {
  images: RenderedPdfImage[];
  pagesProcessed: number;
  pagesSkipped: number;
  totalPages: number;
}

/**
 * Renderiza um PDF para uma lista de imagens JPEG (uma por página),
 * cada uma como data URL.
 *
 * É a base do OCR imagem-direto: o content renderiza as páginas e o
 * background as anexa à mensagem para a IA multimodal ler. Render é
 * sempre no content script — pdf.js v5 trava em offscreen documents.
 *
 * JPEG (qualidade ~0.82) reduz drasticamente o tamanho do data URL
 * em comparação com PNG, mantendo qualidade suficiente para os modelos
 * de visão lerem texto impresso e manuscrito.
 */
export async function renderPdfToImages(
  buffer: ArrayBuffer,
  options?: { maxPages?: number; jpegQuality?: number }
): Promise<RenderPdfResult> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0
  });
  const doc = await loadingTask.promise;
  const totalPages = doc.numPages;
  const effectiveCap =
    options?.maxPages && options.maxPages > 0 ? options.maxPages : MAX_OCR_PAGES;
  const pagesToProcess = Math.min(totalPages, effectiveCap);
  const jpegQuality = options?.jpegQuality ?? 0.82;

  const images: RenderedPdfImage[] = [];

  try {
    for (let pageIndex = 1; pageIndex <= pagesToProcess; pageIndex++) {
      const page = await doc.getPage(pageIndex);
      const viewport = page.getViewport({ scale: RENDER_SCALE });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('canvas 2d context indisponível');
      }

      await page.render({
        canvasContext: context,
        viewport,
        canvas
      }).promise;
      page.cleanup();

      // toDataURL retorna string base64 — atravessa chrome.runtime.sendMessage
      // sem ser serializada como objeto vazio (problema com Blob).
      const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
      images.push({ dataUrl, width: canvas.width, height: canvas.height });
    }
  } finally {
    try {
      await doc.cleanup();
      await doc.destroy();
    } catch {
      /* ignore */
    }
  }

  return {
    images,
    pagesProcessed: pagesToProcess,
    pagesSkipped: Math.max(0, totalPages - pagesToProcess),
    totalPages
  };
}

/**
 * Cria um worker Tesseract configurado para rodar 100% offline, carregando
 * worker.js, core wasm e por.traineddata a partir de chrome.runtime.getURL.
 *
 * Exportado para permitir reutilização entre múltiplos documentos no mesmo
 * batch. Crie uma vez antes do loop de docs e passe o mesmo worker para
 * `ocrPdf({ worker })` em cada iteração — depois `terminate()` no final.
 * Cada criação custa ~3-5s (carregamento de `por.traineddata` ~25MB),
 * então reutilização economiza ordens de grandeza em batches.
 */
export async function createOcrWorker(
  logger?: (m: { status?: string; progress?: number }) => void
): Promise<TesseractWorker> {
  const base = chrome.runtime.getURL('libs/tesseract/');

  // oem=1 (LSTM_ONLY) é o modo suportado pelo tessdata_fast.
  // `workerBlobURL: false` é CRÍTICO em MV3: por padrão, Tesseract.js v5
  // envolve o worker.min.js num blob URL antes de criar o Worker. Isso
  // faz o worker rodar em origin `blob:` e qualquer `importScripts`
  // subsequente para `chrome-extension://...` vira cross-origin → falha
  // ("Failed to execute 'importScripts' on 'WorkerGlobalScope'") mesmo
  // com web_accessible_resources liberado. Forçando false, o Worker é
  // criado direto da URL chrome-extension://... e fica same-origin com
  // os arquivos de wasm/lang.
  const worker = await Tesseract.createWorker('por', 1, {
    workerPath: chrome.runtime.getURL('libs/tesseract/worker.min.js'),
    corePath: base,
    langPath: base,
    gzip: false, // nosso por.traineddata não está comprimido
    workerBlobURL: false,
    logger
  });

  return worker;
}