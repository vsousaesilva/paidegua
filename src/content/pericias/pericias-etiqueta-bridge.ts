/**
 * Ponte top ↔ iframe para as ações de etiquetas de Perícias e da Triagem
 * "Inserir etiquetas mágicas".
 *
 * Por que existe: o endpoint `/painelUsuario/processoTags/inserir` do PJe
 * legacy valida o header `Origin` da requisição. O Angular do painel roda
 * em `https://frontend-prd.trf5.jus.br` (iframe cross-origin), então suas
 * chamadas ficam com `Origin: https://frontend-prd...`. Já o content script
 * no top frame (`https://pje1g.trf5.jus.br`) envia `Origin: https://pje1g...`,
 * o que o servidor SILENCIOSAMENTE rejeita — devolve HTTP 200 com corpo
 * vazio, sem inserir a associação. A pauta ficava "aplicada" só na mensagem.
 *
 * Solução: delegar a chamada ao content script que roda no iframe — mesmo
 * padrão de `triagem-bridge.ts`. Lá, o fetch sai com o Origin do Angular
 * e o PJe aceita.
 */

import { LOG_PREFIX } from '../../shared/constants';
import {
  aplicarEtiquetaEmLote,
  aplicarEtiquetasNoProcesso,
  type AplicarEtiquetasInput,
  type AplicarEtiquetasResult,
  type AplicarEtiquetasNoProcessoInput,
  type AplicarEtiquetasNoProcessoResult
} from './pericias-etiqueta-applier';

const MSG_APLICAR_LOTE_REQ = 'paidegua/etiqueta-aplicar-lote-req';
const MSG_APLICAR_LOTE_PROG = 'paidegua/etiqueta-aplicar-lote-prog';
const MSG_APLICAR_LOTE_RESP = 'paidegua/etiqueta-aplicar-lote-resp';

const MSG_APLICAR_PROC_REQ = 'paidegua/etiqueta-aplicar-processo-req';
const MSG_APLICAR_PROC_RESP = 'paidegua/etiqueta-aplicar-processo-resp';

interface MsgAplicarLoteReq {
  type: typeof MSG_APLICAR_LOTE_REQ;
  requestId: string;
  payload: {
    etiquetaPauta: string;
    idsProcesso: number[];
    favoritarAposCriar?: boolean;
  };
}
interface MsgAplicarLoteProg {
  type: typeof MSG_APLICAR_LOTE_PROG;
  requestId: string;
  msg: string;
}
interface MsgAplicarLoteResp {
  type: typeof MSG_APLICAR_LOTE_RESP;
  requestId: string;
  result: AplicarEtiquetasResult;
}

interface MsgAplicarProcReq {
  type: typeof MSG_APLICAR_PROC_REQ;
  requestId: string;
  payload: {
    etiquetas: AplicarEtiquetasNoProcessoInput['etiquetas'];
    idProcesso: number;
  };
}
interface MsgAplicarProcResp {
  type: typeof MSG_APLICAR_PROC_RESP;
  requestId: string;
  result: AplicarEtiquetasNoProcessoResult;
}

type AnyMsg =
  | MsgAplicarLoteReq
  | MsgAplicarLoteProg
  | MsgAplicarLoteResp
  | MsgAplicarProcReq
  | MsgAplicarProcResp;

function isAnyMsg(x: unknown): x is AnyMsg {
  if (!x || typeof x !== 'object') return false;
  const t = (x as { type?: unknown }).type;
  return (
    t === MSG_APLICAR_LOTE_REQ ||
    t === MSG_APLICAR_LOTE_PROG ||
    t === MSG_APLICAR_LOTE_RESP ||
    t === MSG_APLICAR_PROC_REQ ||
    t === MSG_APLICAR_PROC_RESP
  );
}

/**
 * Registra, no iframe do painel, o listener que aceita pedidos do top e
 * executa as chamadas REST localmente — de onde o `Origin` bate com a
 * whitelist do PJe.
 */
export function instalarListenerEtiquetaNoIframe(): void {
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!isAnyMsg(data)) return;
    const origin = ev.origin;
    const sender = ev.source as Window | null;
    if (!sender) return;

    if (data.type === MSG_APLICAR_LOTE_REQ) {
      const { requestId, payload } = data;
      void (async () => {
        let result: AplicarEtiquetasResult;
        try {
          result = await aplicarEtiquetaEmLote({
            etiquetaPauta: payload.etiquetaPauta,
            idsProcesso: payload.idsProcesso,
            favoritarAposCriar: payload.favoritarAposCriar,
            onProgress: (msg) => {
              const m: MsgAplicarLoteProg = {
                type: MSG_APLICAR_LOTE_PROG,
                requestId,
                msg
              };
              try {
                sender.postMessage(m, origin);
              } catch (err) {
                console.warn(`${LOG_PREFIX} etiqueta-bridge progresso postMessage falhou:`, err);
              }
            }
          });
        } catch (err) {
          result = {
            ok: false,
            aplicadas: 0,
            error: err instanceof Error ? err.message : String(err),
            detalhes: []
          };
        }
        const m: MsgAplicarLoteResp = {
          type: MSG_APLICAR_LOTE_RESP,
          requestId,
          result
        };
        try {
          sender.postMessage(m, origin);
        } catch (err) {
          console.warn(`${LOG_PREFIX} etiqueta-bridge resultado (lote) postMessage falhou:`, err);
        }
      })();
      return;
    }

    if (data.type === MSG_APLICAR_PROC_REQ) {
      const { requestId, payload } = data;
      void (async () => {
        let result: AplicarEtiquetasNoProcessoResult;
        try {
          result = await aplicarEtiquetasNoProcesso({
            etiquetas: payload.etiquetas,
            idProcesso: payload.idProcesso
          });
        } catch (err) {
          result = {
            ok: false,
            aplicadas: 0,
            error: err instanceof Error ? err.message : String(err)
          };
        }
        const m: MsgAplicarProcResp = {
          type: MSG_APLICAR_PROC_RESP,
          requestId,
          result
        };
        try {
          sender.postMessage(m, origin);
        } catch (err) {
          console.warn(`${LOG_PREFIX} etiqueta-bridge resultado (processo) postMessage falhou:`, err);
        }
      })();
      return;
    }
  });
  console.log(`${LOG_PREFIX} etiqueta-bridge: listener iframe instalado.`);
}

function localizarIframePainel(): Window | null {
  const iframes = Array.from(document.querySelectorAll('iframe'));
  for (const f of iframes) {
    const src = f.getAttribute('src') ?? '';
    if (/painel-usuario-interno/i.test(src) && f.contentWindow) {
      return f.contentWindow;
    }
  }
  return null;
}

/**
 * Versão "top" de `aplicarEtiquetaEmLote`: delega ao iframe do painel (onde
 * o Origin bate com a whitelist do PJe). Cai no caminho local só se o
 * iframe não for encontrado — nesse caso, a chamada provavelmente vai
 * falhar pelo mesmo motivo de Origin, mas deixamos o usuário ver o erro
 * real em vez de esconder a situação.
 */
export async function aplicarEtiquetaEmLoteComBridge(
  input: AplicarEtiquetasInput
): Promise<AplicarEtiquetasResult> {
  const iframeWin = localizarIframePainel();
  if (!iframeWin) {
    console.warn(
      `${LOG_PREFIX} etiqueta-bridge: iframe do painel não encontrado — executando no top frame (pode falhar por Origin).`
    );
    return aplicarEtiquetaEmLote(input);
  }
  const onProgress = input.onProgress ?? (() => {});
  const requestId = `etq-lote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<AplicarEtiquetasResult>((resolve) => {
    const handler = (ev: MessageEvent) => {
      const data = ev.data;
      if (!isAnyMsg(data)) return;
      if (!('requestId' in data) || data.requestId !== requestId) return;
      if (data.type === MSG_APLICAR_LOTE_PROG) {
        onProgress(data.msg);
        return;
      }
      if (data.type === MSG_APLICAR_LOTE_RESP) {
        window.removeEventListener('message', handler);
        resolve(data.result);
      }
    };
    window.addEventListener('message', handler);
    const m: MsgAplicarLoteReq = {
      type: MSG_APLICAR_LOTE_REQ,
      requestId,
      payload: {
        etiquetaPauta: input.etiquetaPauta,
        idsProcesso: input.idsProcesso,
        favoritarAposCriar: input.favoritarAposCriar
      }
    };
    iframeWin.postMessage(m, '*');
  });
}

/**
 * Versão "top" de `aplicarEtiquetasNoProcesso`: delega ao iframe do painel.
 * Para a ação "Inserir etiquetas mágicas" da Triagem.
 */
export async function aplicarEtiquetasNoProcessoComBridge(
  input: AplicarEtiquetasNoProcessoInput
): Promise<AplicarEtiquetasNoProcessoResult> {
  const iframeWin = localizarIframePainel();
  if (!iframeWin) {
    console.warn(
      `${LOG_PREFIX} etiqueta-bridge: iframe do painel não encontrado — executando no top frame (pode falhar por Origin).`
    );
    return aplicarEtiquetasNoProcesso(input);
  }
  const requestId = `etq-proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<AplicarEtiquetasNoProcessoResult>((resolve) => {
    const handler = (ev: MessageEvent) => {
      const data = ev.data;
      if (!isAnyMsg(data)) return;
      if (!('requestId' in data) || data.requestId !== requestId) return;
      if (data.type === MSG_APLICAR_PROC_RESP) {
        window.removeEventListener('message', handler);
        resolve(data.result);
      }
    };
    window.addEventListener('message', handler);
    const m: MsgAplicarProcReq = {
      type: MSG_APLICAR_PROC_REQ,
      requestId,
      payload: {
        etiquetas: input.etiquetas,
        idProcesso: input.idProcesso
      }
    };
    iframeWin.postMessage(m, '*');
  });
}
