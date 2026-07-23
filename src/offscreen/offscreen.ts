/**
 * O MOTOR de OCR local. Roda no offscreen document (origin chrome-extension://).
 *
 * Mantém o serviço PP-OCR "quente" (inicializa uma vez; a 1ª página paga o
 * warm-up de carregar det+rec+dict e aquecer a GPU) e responde a cada
 * `OCR_RECOGNIZE_OFFSCREEN` com `{ text, confidence, backend, ms }`.
 *
 * API confirmada no protótipo NexIA (ppu-paddle-ocr v5, build /web), 23/07/2026:
 *  - `import { PaddleOcrService } from 'ppu-paddle-ocr/web'` (NÃO 'ppu-paddle-ocr',
 *    cuja 2.x é Node-only: importa onnxruntime-node + fs, sem subpath /web);
 *  - opções: `model: { detection, recognition, charactersDictionary }`, cada uma
 *    string(URL) | ArrayBuffer; `processing: { engine: 'canvas-native' }`
 *    (sem OpenCV wasm); `session: { executionProviders }` opcional;
 *  - em MV3 o modelo NÃO pode vir de CDN (CSP) nem de ~/.cache: carregamos os
 *    arquivos LOCAIS embarcados como ArrayBuffer via `fetch(getURL(...))`;
 *  - `recognize()` aceita OffscreenCanvas/HTMLCanvasElement e devolve `.text`;
 *  - backend: a lib escolhe WebGPU→WASM sozinha; fixamos 'wasm' via `session`
 *    quando não há WebGPU, só para evitar o probe de GPU.
 *
 * A imagem nunca sai da máquina — tudo local (regra CNJ/LGPD).
 */

import * as ort from 'onnxruntime-web';
import { PaddleOcrService } from 'ppu-paddle-ocr/web';
import { MESSAGE_CHANNELS, LOG_PREFIX } from '../shared/constants';
import type {
  OcrBackend,
  OcrRecognizePayload,
  OcrRecognizeResult
} from '../shared/ocr-messages';

// Aponta o ONNX Runtime para os .wasm/.mjs embarcados na extensão — nunca CDN
// (proibido em MV3). A lib PP-OCR compartilha esta mesma instância de
// onnxruntime-web (import deduplicado pelo webpack), então o ajuste vale para
// a inferência dela.
ort.env.wasm.wasmPaths = chrome.runtime.getURL('assets/');

/** Caminhos dos arquivos de modelo embarcados (ver assets/paddle-ocr/README.md). */
const MODELO = {
  deteccao: 'assets/paddle-ocr/det.onnx',
  reconhecimento: 'assets/paddle-ocr/rec.onnx',
  dicionario: 'assets/paddle-ocr/dict.txt'
} as const;

/** Piso de confiança quando a lib não expõe score por linha (texto ⇒ confiável). */
const CONFIANCA_PADRAO = 90;

interface Capacidade {
  webgpu: boolean;
  backend: OcrBackend;
}

let servico: PaddleOcrService | null = null;
let capacidade: Capacidade | null = null;
/** Garante inicialização única mesmo sob mensagens concorrentes. */
let inicializando: Promise<{ svc: PaddleOcrService; cap: Capacidade }> | null = null;

async function detectarCapacidade(): Promise<Capacidade> {
  // Duck typing: os tipos WebGPU (`GPU`, `GPUAdapter`) vêm do pacote
  // `@webgpu/types`, que não está na lib DOM padrão do TS — por isso não os
  // referenciamos por nome, só checamos a presença de `navigator.gpu`.
  const gpu = (navigator as unknown as {
    gpu?: { requestAdapter(): Promise<unknown> };
  }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) return { webgpu: true, backend: 'webgpu' };
    } catch {
      /* sem WebGPU — cai para WASM */
    }
  }
  return { webgpu: false, backend: 'wasm' };
}

async function carregarBuffer(caminho: string): Promise<ArrayBuffer> {
  const res = await fetch(chrome.runtime.getURL(caminho));
  if (!res.ok) {
    throw new Error(`falha ao carregar ${caminho}: HTTP ${res.status}`);
  }
  return res.arrayBuffer();
}

async function obterServico(): Promise<{ svc: PaddleOcrService; cap: Capacidade }> {
  if (servico && capacidade) return { svc: servico, cap: capacidade };
  if (inicializando) return inicializando;

  inicializando = (async () => {
    const cap = await detectarCapacidade();
    const [detection, recognition, charactersDictionary] = await Promise.all([
      carregarBuffer(MODELO.deteccao),
      carregarBuffer(MODELO.reconhecimento),
      carregarBuffer(MODELO.dicionario)
    ]);

    const svc = new PaddleOcrService({
      model: { detection, recognition, charactersDictionary },
      // canvas-native: pré/pós-processamento com Canvas puro, sem OpenCV wasm
      // (ppu-ocv) — evita embarcar mais um .wasm.
      processing: { engine: 'canvas-native' },
      // Sem WebGPU → fixa WASM (evita probe de GPU). Com WebGPU, deixa a lib decidir.
      ...(cap.webgpu ? {} : { session: { executionProviders: ['wasm'] } })
    } as ConstructorParameters<typeof PaddleOcrService>[0]);

    await svc.initialize();
    servico = svc;
    capacidade = cap;
    console.log(
      `${LOG_PREFIX} [offscreen] PP-OCR inicializado (backend ${cap.backend}).`
    );
    return { svc, cap };
  })();

  try {
    return await inicializando;
  } finally {
    inicializando = null;
  }
}

async function dataUrlParaCanvas(dataUrl: string): Promise<OffscreenCanvas> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('contexto 2d indisponível no OffscreenCanvas');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/**
 * Extrai a confiança média (0–100) do resultado, quando a lib expõe score por
 * linha/box. O PP-OCR é determinístico, então na ausência de score tratamos
 * texto-presente como leitura confiável (piso). Best-effort: a forma exata do
 * resultado da v5 não é documentada, por isso a leitura é defensiva.
 */
function extrairConfianca(resultado: unknown, texto: string): number {
  const r = resultado as {
    lines?: Array<{ score?: number; confidence?: number }>;
    regions?: Array<{ score?: number; confidence?: number }>;
    boxes?: Array<{ score?: number; confidence?: number }>;
  };
  const linhas = r?.lines ?? r?.regions ?? r?.boxes;
  if (Array.isArray(linhas) && linhas.length > 0) {
    const scores = linhas
      .map((l) => (typeof l.score === 'number' ? l.score : l.confidence))
      .filter((s): s is number => typeof s === 'number');
    if (scores.length > 0) {
      const media = scores.reduce((a, b) => a + b, 0) / scores.length;
      // Scores do PP-OCR vêm 0–1; normaliza para 0–100.
      return Math.round((media <= 1 ? media * 100 : media));
    }
  }
  return texto.trim().length > 0 ? CONFIANCA_PADRAO : 0;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.channel !== MESSAGE_CHANNELS.OCR_RECOGNIZE_OFFSCREEN) {
    return false;
  }

  (async () => {
    const t0 = performance.now();
    try {
      const { dataUrl } = message.payload as OcrRecognizePayload;
      const { svc, cap } = await obterServico();
      const canvas = await dataUrlParaCanvas(dataUrl);
      const resultado = await svc.recognize(canvas);
      const texto = (resultado as { text?: string })?.text ?? '';
      const resposta: OcrRecognizeResult = {
        ok: true,
        text: texto,
        confidence: extrairConfianca(resultado, texto),
        backend: cap.backend,
        ms: Math.round(performance.now() - t0)
      };
      sendResponse(resposta);
    } catch (err) {
      const resposta: OcrRecognizeResult = {
        ok: false,
        text: '',
        confidence: 0,
        backend: capacidade?.backend ?? 'wasm',
        ms: Math.round(performance.now() - t0),
        error: err instanceof Error ? err.message : String(err)
      };
      console.error(`${LOG_PREFIX} [offscreen] OCR falhou:`, err);
      sendResponse(resposta);
    }
  })();

  return true; // resposta assíncrona
});

console.log(`${LOG_PREFIX} [offscreen] pronto para OCR local.`);
