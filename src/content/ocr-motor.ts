/**
 * Motor de OCR local — lado cliente.
 *
 * Substitui o motor Tesseract (`createOcrWorker`/`ocrPdf` antigo). Não roda
 * inferência aqui: apenas empacota cada página (dataURL) e a envia ao background,
 * que garante o offscreen document e faz o relay para o PP-OCR (ONNX Runtime Web,
 * WebGPU→WASM). Ver `shared/ocr-messages.ts` e `offscreen/offscreen.ts`.
 *
 * Roda tanto no content script (origin da página do PJe) quanto em página de
 * extensão (painel criminal): ambos podem `chrome.runtime.sendMessage`. É essa a
 * razão de a inferência ter saído do content — no realm da página a CSP do PJe e
 * a same-origin policy bloqueiam Worker/WebGPU; no offscreen (origin
 * chrome-extension://) rodam livremente.
 *
 * A imagem NUNCA sai da máquina: content → background → offscreen são todos
 * contextos locais do navegador (regra CNJ/LGPD). Nenhuma chamada de rede.
 */

import { MESSAGE_CHANNELS, LOG_PREFIX } from '../shared/constants';
import type {
  OcrBackend,
  OcrRecognizePayload,
  OcrRecognizeResult
} from '../shared/ocr-messages';

/** Resultado de OCR de uma página. */
export interface PaginaTranscrita {
  text: string;
  /** Confiança 0–100 (ver `OcrRecognizeResult.confidence`). */
  confidence: number;
  backend: OcrBackend;
  ms: number;
}

/**
 * Interface do motor de OCR local. Preserva o espírito do contrato histórico
 * (`transcrever(paginas)` / `destruir()`); `transcrever` devolve dados por
 * página (texto + confiança) porque o chamador (`ocrPdf`) precisa deles para o
 * portão de qualidade e para os marcadores `=== Página N (OCR) ===`.
 */
export interface MotorOcr {
  /**
   * Transcreve uma lista de páginas (cada uma um dataURL de imagem). Emite
   * `onPagina` a cada página concluída, para o chamador atualizar progresso.
   * Rejeita se uma página falhar de forma dura (ex.: modelo não carregou) —
   * o chamador trata como "OCR falhou".
   */
  transcrever(
    paginas: string[],
    onPagina?: (indice: number, total: number, resultado: PaginaTranscrita) => void
  ): Promise<PaginaTranscrita[]>;
  /**
   * Libera o motor. O offscreen document é um recurso compartilhado e caro de
   * aquecer (~3–4s para carregar det+rec+dict), então NÃO o destruímos entre
   * documentos: mantê-lo quente é o principal acelerador de lotes. Este método
   * apenas solta a referência local do singleton; o offscreen segue vivo e
   * pronto para o próximo uso. Mantido por compatibilidade de interface.
   */
  destruir(): void;
}

class MotorOcrOffscreen implements MotorOcr {
  async transcrever(
    paginas: string[],
    onPagina?: (indice: number, total: number, resultado: PaginaTranscrita) => void
  ): Promise<PaginaTranscrita[]> {
    const total = paginas.length;
    const resultados: PaginaTranscrita[] = [];

    for (let i = 0; i < total; i++) {
      const dataUrl = paginas[i]!;
      const payload: OcrRecognizePayload = { dataUrl };

      let resposta: OcrRecognizeResult;
      try {
        resposta = (await chrome.runtime.sendMessage({
          channel: MESSAGE_CHANNELS.OCR_RECOGNIZE,
          payload
        })) as OcrRecognizeResult;
      } catch (err) {
        // Falha de canal (SW reiniciou, offscreen não subiu) — erro duro.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`OCR local indisponível: ${msg}`);
      }

      if (!resposta || !resposta.ok) {
        throw new Error(resposta?.error || 'OCR local falhou (resposta vazia)');
      }

      const pagina: PaginaTranscrita = {
        text: resposta.text ?? '',
        confidence: typeof resposta.confidence === 'number' ? resposta.confidence : 0,
        backend: resposta.backend,
        ms: resposta.ms
      };
      resultados.push(pagina);
      onPagina?.(i, total, pagina);
    }

    return resultados;
  }

  destruir(): void {
    // Ver doc da interface: mantemos o offscreen quente de propósito.
    motorSingleton = null;
  }
}

let motorSingleton: MotorOcr | null = null;

/**
 * Devolve o motor de OCR local (singleton). Um único motor cliente basta — ele
 * é sem estado; o estado quente (modelo carregado) vive no offscreen.
 */
export function getMotorOcr(): MotorOcr {
  if (!motorSingleton) {
    motorSingleton = new MotorOcrOffscreen();
    console.log(`${LOG_PREFIX} motor OCR local (PP-OCR/ONNX) inicializado no cliente.`);
  }
  return motorSingleton;
}
