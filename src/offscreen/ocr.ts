/**
 * Offscreen document para OCR — fix do problema de Chrome throttling
 * tabs em background (Chrome ≥88), que torna o Tesseract irresponsivo
 * quando a aba PJe não é a aba ativa.
 *
 * O offscreen é um contexto HTML invisível, NÃO throttled, com acesso
 * a Web Workers + WASM + fetch com cookies (host_permissions). É o
 * único caminho proper em MV3 para tarefas de longo runtime que
 * precisam ser independentes do estado de visibilidade da aba.
 *
 * Fluxo:
 *  1. Background SW cria este offscreen sob demanda (chrome.offscreen.createDocument)
 *  2. Content script envia OCR_OFFSCREEN_BATCH com array de { id, url }
 *  3. Aqui: para cada url, fetch (com cookies de jus.br) → ocrPdf → texto
 *  4. Devolve map id→{ text, ok, error }
 *
 * Reusa `createOcrWorker` + `ocrPdf` de `content/ocr.ts` — código compartilhado,
 * sem duplicação. Cria UM worker por batch e termina no final (cap de
 * memória; cada worker carrega ~25MB de por.traineddata).
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../shared/constants';
import { createOcrWorker, ocrPdf, type TesseractWorker } from '../content/ocr';

const LOG = `${LOG_PREFIX} [offscreen/ocr]`;

interface OcrBatchRequest {
  type: typeof MESSAGE_CHANNELS.OCR_OFFSCREEN_BATCH;
  docs: Array<{ id: string; url: string }>;
  options?: { maxPages?: number };
}

interface OcrDocResult {
  text: string;
  ok: boolean;
  error?: string;
  pagesProcessed?: number;
  pagesSkipped?: number;
}

type OcrBatchResponse = Record<string, OcrDocResult>;

// Timeout duro por documento — evita pendurar mesmo aqui (improvável,
// mas se um PDF estiver corrompido, a chamada do Tesseract pode hang).
const PER_DOC_TIMEOUT_MS = 90_000;

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
      // Retorna ok=false para todos os docs do batch
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
    for (const doc of req.docs) {
      try {
        const result = await comTimeout(
          processarDoc(doc, worker, req.options),
          PER_DOC_TIMEOUT_MS,
          `OCR doc ${doc.id}`
        );
        out[doc.id] = result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`${LOG} doc ${doc.id} falhou:`, message);
        out[doc.id] = { text: '', ok: false, error: message };
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
  doc: { id: string; url: string },
  worker: TesseractWorker,
  options: { maxPages?: number } | undefined
): Promise<OcrDocResult> {
  // Fetch com cookies de jus.br — funciona porque:
  //  (a) host_permissions inclui https://*.jus.br/*
  //  (b) credentials:'include' faz o navegador enviar cookies do
  //      ORIGIN ALVO (jus.br), não do origin do offscreen (chrome-extension://)
  const resp = await fetch(doc.url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/pdf,application/octet-stream,*/*' }
  });
  if (!resp.ok) {
    return { text: '', ok: false, error: `HTTP ${resp.status}` };
  }
  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength === 0) {
    return { text: '', ok: false, error: '0 bytes' };
  }

  const result = await ocrPdf(buffer, undefined, {
    maxPages: options?.maxPages,
    worker
  });
  return {
    text: result.text,
    ok: true,
    pagesProcessed: result.pagesProcessed,
    pagesSkipped: result.pagesSkipped
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
