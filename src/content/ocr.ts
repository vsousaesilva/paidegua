/**
 * Render de PDFs e OCR local via PP-OCR (ONNX Runtime Web, WebGPU→WASM) + pdf.js.
 *
 * MIGRAÇÃO (23/07/2026): o motor de OCR deixou de ser o Tesseract.js e passou a
 * ser o PP-OCR rodando num offscreen document (ver `content/ocr-motor.ts`,
 * `background/ocr-offscreen.ts`, `offscreen/offscreen.ts`). Motivos: o Tesseract
 * sofria com ruído visual (carimbos, assinaturas, baixa resolução) e marcava
 * documentos legíveis como "LEITURA PENDENTE"; o PP-OCR (determinístico —
 * detecção DB + reconhecimento CTC) lê esses casos e é mais rápido (~0,8 s/página
 * em WebGPU). A imagem continua 100% local (regra CNJ/LGPD).
 *
 * Divisão de contexto (respeitando o BUG-21: `pdf.js page.render` trava em
 * offscreen documents):
 *  - RENDER (pdf.js) roda no contexto chamador (content script / painel criminal);
 *  - RECONHECIMENTO (ONNX) roda no offscreen, alcançado pelo motor via background.
 *
 * Funções principais:
 *  - `renderPdfToImages(buffer)` — renderiza as páginas como data URLs JPEG.
 *    É a base tanto do OCR imagem-direto (IA multimodal) quanto do OCR local.
 *  - `ocrPdf(buffer)` — pipeline completo render + transcrição PP-OCR. Usado
 *    pelo painel criminal e por `transcreverPendenciaOffline`.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { getMotorOcr } from './ocr-motor';

/** Número máximo de páginas processadas por documento (fallback). */
export const MAX_OCR_PAGES = 30;

export interface OcrOptions {
  /** Override do cap de páginas. Zero ou negativo cai no fallback. */
  maxPages?: number;
}

/**
 * Fator de escala aplicado ao render do PDF antes do OCR.
 * 1.5 (~108 DPI numa folha A4) atende tanto o PP-OCR quanto a leitura por IA
 * multimodal (ambos consomem o mesmo render). Acima disso a imagem só fica mais
 * pesada (mais memória e tempo) sem ganho proporcional de acurácia.
 */
const RENDER_SCALE = 1.5;

export interface OcrProgress {
  /** Página atual (1-indexed) sendo processada. */
  currentPage: number;
  /** Total de páginas que serão processadas (respeita MAX_OCR_PAGES). */
  totalPages: number;
  /** Fração 0..1 do progresso dentro da página atual. */
  pageProgress: number;
  /** Status textual da etapa (ex.: "rendering", "recognizing"). */
  status: string;
}

export interface OcrResult {
  text: string;
  pagesProcessed: number;
  pagesSkipped: number;
  totalPages: number;
  /**
   * Confiança média (0–100) reportada pelo PP-OCR nas páginas lidas. Usada como
   * portão de qualidade: transcrição de baixa confiança é tratada como "não
   * lida" pelos fluxos sob demanda, evitando que texto ruim (que fura o regex de
   * anonimização) seja aceito. 0 quando não há páginas com texto. Ver
   * `OcrRecognizeResult.confidence` sobre como o valor é derivado.
   */
  meanConfidence: number;
}

/**
 * Executa OCR em um PDF. Não assume que o documento é scanned — o chamador
 * decide quando invocar (tipicamente quando `parsePdf` retornou `isScanned=true`).
 *
 * Renderiza as páginas localmente (pdf.js) e transcreve cada uma via PP-OCR no
 * offscreen (motor). Mantém a assinatura histórica (`buffer → OcrResult`) para os
 * chamadores existentes (painel criminal e `transcreverPendenciaOffline`).
 */
export async function ocrPdf(
  buffer: ArrayBuffer,
  onProgress?: (p: OcrProgress) => void,
  options?: OcrOptions
): Promise<OcrResult> {
  const effectiveCap =
    options?.maxPages && options.maxPages > 0 ? options.maxPages : MAX_OCR_PAGES;

  // RENDER local (respeita BUG-21). Reaproveita o mesmo pipeline do imagem-direto.
  const rendered = await renderPdfToImages(buffer, { maxPages: effectiveCap });
  const pagesToProcess = rendered.images.length;

  if (pagesToProcess === 0) {
    return {
      text: '',
      pagesProcessed: 0,
      pagesSkipped: rendered.pagesSkipped,
      totalPages: rendered.totalPages,
      meanConfidence: 0
    };
  }

  onProgress?.({
    currentPage: 0,
    totalPages: pagesToProcess,
    pageProgress: 0,
    status: 'rendering'
  });

  // RECONHECIMENTO no offscreen, uma página por vez (para reportar progresso e
  // manter cada mensagem pequena).
  const motor = getMotorOcr();
  const paginas = rendered.images.map((img) => img.dataUrl);

  const resultados = await motor.transcrever(paginas, (indice, total, r) => {
    onProgress?.({
      currentPage: indice + 1,
      totalPages: total,
      pageProgress: 1,
      status: `recognizing (${r.backend})`
    });
  });

  const pageTexts = resultados.map((r) => (r.text || '').trim());
  const pageConfidences = resultados
    .filter((r) => r.text.trim().length > 0 && r.confidence >= 0)
    .map((r) => r.confidence);

  const text = pageTexts
    .map((t, i) => `=== Página ${i + 1} (OCR) ===\n${t}`)
    .join('\n\n');

  const meanConfidence =
    pageConfidences.length > 0
      ? pageConfidences.reduce((soma, c) => soma + c, 0) / pageConfidences.length
      : 0;

  return {
    text,
    pagesProcessed: pagesToProcess,
    pagesSkipped: rendered.pagesSkipped,
    totalPages: rendered.totalPages,
    meanConfidence
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
 * É a base do OCR imagem-direto E do OCR local: o content renderiza as páginas
 * e (a) as anexa à mensagem para a IA multimodal ler, ou (b) as envia ao
 * offscreen para o PP-OCR transcrever. Render é sempre no content script —
 * pdf.js v5 trava em offscreen documents (BUG-21).
 *
 * JPEG (qualidade ~0.82) reduz drasticamente o tamanho do data URL
 * em comparação com PNG, mantendo qualidade suficiente para os modelos
 * de visão e para o PP-OCR lerem texto impresso e manuscrito.
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
