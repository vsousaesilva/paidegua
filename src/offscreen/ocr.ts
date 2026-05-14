/**
 * Offscreen document para OCR — recebe imagens JÁ renderizadas pelo
 * content script e roda apenas o Tesseract.
 *
 * Por que offscreen: tabs em background (Chrome ≥88) são throttled
 * — postMessage main↔worker é atrasado e o Tesseract (uso intensivo
 * de mensagens main↔worker) pendura. Offscreen documents NÃO são
 * throttled.
 *
 * Por que NÃO rodar o pdf.js aqui: tentamos na v1.6.1/1.6.2 e
 * `page.render()` trava silenciosamente em offscreen documents
 * — algo no canal interno de decodificação de imagem do pdf.js
 * (provavelmente `Image.decode()` ou rAF) não responde quando
 * o document não tem composição visual. Render fica no content
 * script (onde sempre funcionou); offscreen recebe JPEGs prontos.
 *
 * Fluxo:
 *  1. Background SW cria este offscreen sob demanda.
 *  2. Content script envia OCR_OFFSCREEN_BATCH com:
 *     docs: [{ id, pageImages: Blob[] }]  (já renderizado lá)
 *  3. Aqui: para cada doc, para cada Blob, createImageBitmap →
 *     canvas → worker.recognize → texto.
 *  4. Devolve map id→{ text, ok, error }.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../shared/constants';
import { createOcrWorker, type TesseractWorker } from '../content/ocr';

const LOG = `${LOG_PREFIX} [offscreen/ocr]`;

interface OcrDocInput {
  id: string;
  /**
   * Páginas como data URLs `data:image/jpeg;base64,…` (geradas no content
   * via canvas.toDataURL). Blobs não atravessam chrome.runtime.sendMessage
   * intactos — serialização JSON entre contextos os transforma em `{}`.
   */
  pageImages: string[];
}

interface OcrBatchRequest {
  type: typeof MESSAGE_CHANNELS.OCR_OFFSCREEN_BATCH;
  docs: OcrDocInput[];
  /**
   * IDs para streaming de progresso (start/done/error por doc).
   * Quando ambos presentes, o offscreen emite OCR_OFFSCREEN_PROGRESS
   * ao background, que repassa via chrome.tabs.sendMessage(tabId, …).
   */
  batchId?: string;
  tabId?: number;
}

interface OcrDocResult {
  text: string;
  ok: boolean;
  error?: string;
  pagesProcessed?: number;
  pagesSkipped?: number;
}

type OcrBatchResponse = Record<string, OcrDocResult>;

/**
 * Timeout duro por documento. Cada página leva ~2-5s no Tesseract LSTM-PT
 * (PDF imagem). 30 páginas × 5s = 150s + buffer. 300s dá folga 2× sobre
 * o pior caso prático.
 */
const PER_DOC_TIMEOUT_MS = 300_000;

function emitProgress(
  batchId: string | undefined,
  tabId: number | undefined,
  event: Record<string, unknown>
): void {
  if (!batchId || tabId == null) return;
  // fire-and-forget: o background é quem entrega ao tab; se o tab fechou
  // antes do progress chegar, o erro é silencioso (não afeta o batch).
  // Usamos `channel` (não `type`) porque o switch do background ouvinte
  // discrimina por message.channel; type é usado pelo handler do BATCH
  // dentro deste mesmo offscreen.
  void chrome.runtime
    .sendMessage({
      channel: MESSAGE_CHANNELS.OCR_OFFSCREEN_PROGRESS,
      batchId,
      tabId,
      event
    })
    .catch(() => {
      /* ignore */
    });
}

console.info(`${LOG} carregado, aguardando batches.`);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== MESSAGE_CHANNELS.OCR_OFFSCREEN_BATCH) return false;

  const req = msg as OcrBatchRequest;
  console.info(`${LOG} batch recebido: ${req.docs.length} doc(s)`);

  handleBatch(req)
    .then((response) => sendResponse(response))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG} batch falhou globalmente:`, message);
      const fallback: OcrBatchResponse = {};
      for (const d of req.docs) {
        fallback[d.id] = { text: '', ok: false, error: message };
      }
      sendResponse(fallback);
    });

  return true; // resposta assíncrona
});

async function handleBatch(req: OcrBatchRequest): Promise<OcrBatchResponse> {
  const out: OcrBatchResponse = {};
  if (req.docs.length === 0) return out;

  // Logger no-op é OBRIGATÓRIO — Tesseract chama logger(...) de dentro
  // do wasm; se for undefined, "TypeError: v is not a function" centenas
  // de vezes (uma por callback de progresso por página).
  let worker: TesseractWorker | null = null;
  try {
    worker = await createOcrWorker(() => {});
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG} falha ao inicializar worker compartilhado:`, message);
    for (const d of req.docs) {
      out[d.id] = { text: '', ok: false, error: `worker init: ${message}` };
    }
    return out;
  }

  try {
    for (let index = 0; index < req.docs.length; index++) {
      const doc = req.docs[index]!;
      emitProgress(req.batchId, req.tabId, {
        type: 'ocr-document-start',
        index,
        documento: { id: doc.id }
      });
      try {
        const result = await comTimeout(
          processarDoc(doc, worker),
          PER_DOC_TIMEOUT_MS,
          `OCR doc ${doc.id}`
        );
        out[doc.id] = result;
        if (result.ok) {
          emitProgress(req.batchId, req.tabId, {
            type: 'ocr-document-done',
            index,
            documento: { id: doc.id },
            pagesProcessed: result.pagesProcessed ?? 0,
            pagesSkipped: result.pagesSkipped ?? 0
          });
        } else {
          emitProgress(req.batchId, req.tabId, {
            type: 'ocr-document-error',
            index,
            documento: { id: doc.id },
            error: result.error ?? 'erro desconhecido'
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`${LOG} doc ${doc.id} falhou:`, message);
        out[doc.id] = { text: '', ok: false, error: message };
        emitProgress(req.batchId, req.tabId, {
          type: 'ocr-document-error',
          index,
          documento: { id: doc.id },
          error: message
        });
      }
    }
  } finally {
    try {
      await worker.terminate();
    } catch {
      /* ignore */
    }
  }

  return out;
}

async function processarDoc(
  doc: OcrDocInput,
  worker: TesseractWorker
): Promise<OcrDocResult> {
  if (!doc.pageImages || doc.pageImages.length === 0) {
    return { text: '', ok: false, error: 'sem páginas para OCR' };
  }

  const pageTexts: string[] = [];
  for (let i = 0; i < doc.pageImages.length; i++) {
    const dataUrl = doc.pageImages[i]!;
    // Decodifica a data URL em ImageBitmap via fetch (que aceita data: URLs
    // sem fricção e devolve Blob) — caminho mais simples e que evita o
    // bloqueio cross-origin que img.src/createObjectURL tem entre o
    // content (origem page) e este offscreen (origem extensão).
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { text: '', ok: false, error: 'canvas 2d context indisponível' };
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const { data } = await worker.recognize(canvas);
    pageTexts.push((data.text || '').trim());
  }

  const text = pageTexts
    .map((t, i) => `=== Página ${i + 1} (OCR) ===\n${t}`)
    .join('\n\n');

  return {
    text,
    ok: true,
    pagesProcessed: doc.pageImages.length,
    pagesSkipped: 0
  };
}

async function comTimeout<T>(p: Promise<T>, ms: number, rotulo: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${rotulo}: timeout ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
