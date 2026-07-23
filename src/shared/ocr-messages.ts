/**
 * Tipos das mensagens de OCR local (PP-OCR via ONNX Runtime Web).
 *
 * Compartilhado por três contextos, por isso vive em `shared/` (sem depender de
 * nenhum realm específico):
 *  - o motor cliente no content/painel (`content/ocr-motor.ts`);
 *  - o relay no background (`background/ocr-offscreen.ts`);
 *  - o motor de inferência no offscreen (`offscreen/offscreen.ts`).
 *
 * Uma requisição = UMA página. O chamador (ex.: `ocrPdf`) itera as páginas para
 * poder reportar progresso e manter cada mensagem pequena.
 */

/** Backend efetivo escolhido pelo ONNX Runtime na máquina do usuário. */
export type OcrBackend = 'webgpu' | 'wasm';

/** Payload de `OCR_RECOGNIZE` / `OCR_RECOGNIZE_OFFSCREEN`: a página a transcrever. */
export interface OcrRecognizePayload {
  /**
   * Imagem da página como data URL (`data:image/jpeg;base64,…`). Data URL — e
   * não Blob — porque `chrome.runtime.sendMessage` serializa via JSON e Blob
   * vira `{}` ao cruzar contextos.
   */
  dataUrl: string;
}

/** Resposta do offscreen para uma página. */
export interface OcrRecognizeResult {
  ok: boolean;
  /** Texto reconhecido (vazio quando `ok === false`). */
  text: string;
  /**
   * Confiança 0–100. O PP-OCR é determinístico (detecção DB + reconhecimento
   * CTC) e não produz o "texto embaralhado" do Tesseract, então quando há score
   * por linha usamos a média; quando a lib não o expõe, devolvemos um piso alto
   * (texto presente ⇒ leitura confiável). Preserva o portão de qualidade que
   * protege o regex de anonimização em `transcreverPendenciaOffline`.
   */
  confidence: number;
  /** Backend usado nesta página (para telemetria/diagnóstico). */
  backend: OcrBackend;
  /** Tempo total desta página em ms (inclui warm-up na 1ª chamada). */
  ms: number;
  /** Mensagem de erro quando `ok === false`. */
  error?: string;
}
