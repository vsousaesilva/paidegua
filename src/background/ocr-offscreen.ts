/**
 * OCR local — lado background (service worker).
 *
 * Garante o offscreen document que hospeda o PP-OCR e faz o relay das páginas.
 * A inferência ORT não pode rodar aqui (o Chrome mata o SW em trabalho pesado)
 * nem no content script (CSP da página do PJe): por isso o offscreen.
 *
 * Só existe UM offscreen document por extensão. Como nenhuma outra feature usa
 * offscreen hoje, este módulo é o dono exclusivo do seu ciclo de vida.
 */

import { MESSAGE_CHANNELS, LOG_PREFIX } from '../shared/constants';
import type {
  OcrRecognizePayload,
  OcrRecognizeResult
} from '../shared/ocr-messages';

const OFFSCREEN_URL = 'offscreen/offscreen.html';

/** Deduplica criações concorrentes do offscreen. */
let criando: Promise<void> | null = null;

async function offscreenExiste(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  return contexts.length > 0;
}

/** Cria o offscreen document se ainda não existir (idempotente). */
async function garantirOffscreen(): Promise<void> {
  if (await offscreenExiste()) return;
  if (!criando) {
    criando = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        // 'WORKERS' é o motivo válido para computação pesada (ONNX/WASM/WebGPU)
        // com acesso a DOM/canvas. O enum NÃO tem 'BLOB_STORAGE'.
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          'OCR local (PP-OCR via ONNX Runtime Web) fora do service worker — a imagem nunca sai da máquina.'
      })
      .catch((err: unknown) => {
        // Corrida: outro caller pode ter criado no intervalo. Se já existe,
        // não é erro; qualquer outra falha propaga.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/single offscreen|already exists|Only a single/i.test(msg)) {
          throw err;
        }
      });
  }
  try {
    await criando;
  } finally {
    criando = null;
  }
}

/**
 * Handler de `OCR_RECOGNIZE` (content/painel → background). Garante o offscreen
 * e repassa a página para inferência, devolvendo o resultado ao chamador.
 */
export async function handleOcrRecognize(
  payload: OcrRecognizePayload | undefined,
  sendResponse: (r: OcrRecognizeResult) => void
): Promise<void> {
  const t0 = performance.now();
  const falha = (error: string): OcrRecognizeResult => ({
    ok: false,
    text: '',
    confidence: 0,
    backend: 'wasm',
    ms: Math.round(performance.now() - t0),
    error
  });

  if (!payload || typeof payload.dataUrl !== 'string') {
    sendResponse(falha('payload de OCR inválido (dataUrl ausente)'));
    return;
  }

  try {
    await garantirOffscreen();
    const resposta = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.OCR_RECOGNIZE_OFFSCREEN,
      payload
    })) as OcrRecognizeResult | undefined;

    if (!resposta) {
      sendResponse(falha('offscreen não respondeu ao OCR'));
      return;
    }
    sendResponse(resposta);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} relay de OCR ao offscreen falhou:`, err);
    sendResponse(falha(`relay de OCR falhou: ${msg}`));
  }
}
