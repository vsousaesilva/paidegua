/**
 * OCR de PDFs digitalizados usando Tesseract.js + pdf.js.
 *
 * Roda inteiramente no content script (isolated world) — sem dependência de
 * rede. Todos os assets (worker, core wasm, por.traineddata) são empacotados
 * na extensão e servidos via chrome.runtime.getURL (web_accessible_resources
 * `libs/*` no manifest).
 *
 * Pipeline:
 *  1. pdf.js abre o PDF e, para cada página (até MAX_OCR_PAGES), renderiza
 *     em um OffscreenCanvas 2x (DPI maior → melhor acurácia de OCR).
 *  2. Tesseract.js (language=por, OEM=LSTM, SIMD) reconhece o canvas e
 *     devolve o texto.
 *  3. Texto de todas as páginas é concatenado no mesmo formato do pdf-parser.ts
 *     (`=== Página N ===\n<texto>`) para o modelo ver uma estrutura consistente.
 *
 * O worker Tesseract pode ser criado externamente e reutilizado entre vários
 * documentos via `createOcrWorker` + `ocrPdf({ worker })` — isso elimina o
 * overhead de ~3-5s por documento de carregar `por.traineddata` (~25MB)
 * cada vez. O orquestrador `runOcrOnDocuments` em extractor.ts faz isso
 * automaticamente em batch.
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

/** Fator de escala aplicado ao render do PDF antes do OCR. */
const RENDER_SCALE = 2.0;

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

      // OffscreenCanvas é mais barato que <canvas> no DOM e não é afetado
      // por CSS da página hospedeira.
      const canvas = new OffscreenCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      );
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('OffscreenCanvas 2d context indisponível');
      }

      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        canvas: canvas as unknown as HTMLCanvasElement
      }).promise;
      page.cleanup();

      onProgress?.({
        currentPage: pageIndex,
        totalPages: pagesToProcess,
        pageProgress: 0,
        status: 'rendering'
      });

      // Tesseract aceita OffscreenCanvas diretamente em v5.
      const { data } = await worker.recognize(
        canvas as unknown as HTMLCanvasElement
      );
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
    // responsabilidade do chamador (típico em batches via runOcrOnDocuments).
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