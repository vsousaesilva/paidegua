/**
 * Ponte top ↔ iframe para o perfil Gestão.
 *
 * Mesmo princípio de `triagem-bridge.ts`: quando o painel do PJe roda em
 * iframe cross-origin (caso TRF5), só o content script injetado no iframe
 * consegue ler o DOM do painel. Aqui expomos duas RPCs postMessage:
 *
 *   1. `gestao-listar` → iframe devolve a lista de tarefas disponíveis
 *      (todas, sem filtro) para alimentar o seletor múltiplo.
 *   2. `gestao-coletar` → iframe varre apenas as tarefas escolhidas pelo
 *      usuário e devolve o vetor de snapshots.
 *
 * O top orquestra: chama (1), mostra o picker, chama (2), computa os
 * indicadores determinísticos, e pede ao background para abrir a página
 * do dashboard gerencial.
 */

import { LOG_PREFIX } from '../../shared/constants';
import type { GestaoTarefaInfo } from '../../shared/types';
import type { TriagemTarefaSnapshot } from '../../shared/types';
import {
  capturarTarefas,
  coletarSnapshots,
  listarTodasTarefas
} from '../triagem/analisar-tarefas';

const MSG_LISTAR_REQ = 'paidegua/gestao-listar-req';
const MSG_LISTAR_RES = 'paidegua/gestao-listar-res';
const MSG_COLETAR_REQ = 'paidegua/gestao-coletar-req';
const MSG_COLETAR_PROG = 'paidegua/gestao-coletar-prog';
const MSG_COLETAR_RES = 'paidegua/gestao-coletar-res';

interface MsgListarReq {
  type: typeof MSG_LISTAR_REQ;
  requestId: string;
}
interface MsgListarRes {
  type: typeof MSG_LISTAR_RES;
  requestId: string;
  tarefas: GestaoTarefaInfo[];
  error?: string;
}
interface MsgColetarReq {
  type: typeof MSG_COLETAR_REQ;
  requestId: string;
  nomes: string[];
  pjeOrigin: string;
}
interface MsgColetarProg {
  type: typeof MSG_COLETAR_PROG;
  requestId: string;
  msg: string;
}
interface MsgColetarRes {
  type: typeof MSG_COLETAR_RES;
  requestId: string;
  snapshots: TriagemTarefaSnapshot[];
  error?: string;
}

type AnyMsg =
  | MsgListarReq
  | MsgListarRes
  | MsgColetarReq
  | MsgColetarProg
  | MsgColetarRes;

function isAnyMsg(x: unknown): x is AnyMsg {
  if (!x || typeof x !== 'object') return false;
  const t = (x as { type?: unknown }).type;
  return (
    t === MSG_LISTAR_REQ ||
    t === MSG_LISTAR_RES ||
    t === MSG_COLETAR_REQ ||
    t === MSG_COLETAR_PROG ||
    t === MSG_COLETAR_RES
  );
}

/**
 * Chamado pelo bootstrap do content script quando detectamos que estamos
 * dentro do iframe do painel. Registra o listener que responde às duas
 * RPCs do Gestão.
 */
export function instalarListenerGestaoNoIframe(): void {
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!isAnyMsg(data)) return;
    const origin = ev.origin;
    const sender = ev.source as Window | null;
    if (!sender) return;

    if (data.type === MSG_LISTAR_REQ) {
      try {
        const tarefas = listarTodasTarefas();
        const res: MsgListarRes = {
          type: MSG_LISTAR_RES,
          requestId: data.requestId,
          tarefas
        };
        sender.postMessage(res, origin);
      } catch (err) {
        const res: MsgListarRes = {
          type: MSG_LISTAR_RES,
          requestId: data.requestId,
          tarefas: [],
          error: err instanceof Error ? err.message : String(err)
        };
        sender.postMessage(res, origin);
      }
      return;
    }

    if (data.type === MSG_COLETAR_REQ) {
      const { requestId, nomes, pjeOrigin } = data;
      const setNomes = new Set(nomes);
      void (async () => {
        let snapshots: TriagemTarefaSnapshot[] = [];
        let errorMsg: string | undefined;
        try {
          const tarefas = capturarTarefas((nome) => setNomes.has(nome));
          const progress = (msg: string): void => {
            const m: MsgColetarProg = {
              type: MSG_COLETAR_PROG,
              requestId,
              msg
            };
            try {
              sender.postMessage(m, origin);
            } catch {
              /* ignore */
            }
          };
          snapshots = await coletarSnapshots(tarefas, pjeOrigin, progress);
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : String(err);
        }
        const res: MsgColetarRes = {
          type: MSG_COLETAR_RES,
          requestId,
          snapshots,
          ...(errorMsg ? { error: errorMsg } : {})
        };
        try {
          sender.postMessage(res, origin);
        } catch (err) {
          console.warn(`${LOG_PREFIX} gestao resultado postMessage falhou:`, err);
        }
        // Mesma mitigação adotada na triagem: após a varredura o painel
        // Angular costuma ficar em branco. Recarregar o iframe devolve a
        // UI ao usuário em estado consistente.
        window.setTimeout(() => {
          try { window.location.reload(); } catch { /* ignore */ }
        }, 300);
      })();
      return;
    }
  });
  console.log(`${LOG_PREFIX} gestao-bridge: listener iframe instalado.`);
}

/** Procura o iframe do painel no DOM do top. */
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
 * RPC "listar" — top pede ao iframe (ou executa local se o painel não
 * está em iframe) a lista de tarefas do painel. Timeout curto porque
 * envolve só leitura síncrona do DOM.
 */
export async function listarTarefasDoPainel(): Promise<{
  ok: boolean;
  tarefas: GestaoTarefaInfo[];
  error?: string;
}> {
  const iframeWin = localizarIframePainel();
  if (!iframeWin) {
    try {
      return { ok: true, tarefas: listarTodasTarefas() };
    } catch (err) {
      return {
        ok: false,
        tarefas: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  const requestId = `gestao-listar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const TIMEOUT_MS = 8_000;
    let finalizado = false;
    const timer = window.setTimeout(() => {
      if (finalizado) return;
      finalizado = true;
      window.removeEventListener('message', handler);
      resolve({
        ok: false,
        tarefas: [],
        error: 'Timeout aguardando iframe do painel responder a listagem.'
      });
    }, TIMEOUT_MS);

    const handler = (ev: MessageEvent): void => {
      const data = ev.data;
      if (!isAnyMsg(data)) return;
      if (data.type !== MSG_LISTAR_RES) return;
      if (data.requestId !== requestId) return;
      if (finalizado) return;
      finalizado = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve({
        ok: !data.error,
        tarefas: data.tarefas,
        ...(data.error ? { error: data.error } : {})
      });
    };
    window.addEventListener('message', handler);
    const m: MsgListarReq = { type: MSG_LISTAR_REQ, requestId };
    iframeWin.postMessage(m, '*');
  });
}

/**
 * RPC "coletar" — top pede ao iframe (ou local) para varrer apenas as
 * tarefas cujos nomes estão em `nomes`. Sem timeout: pode levar minutos
 * em painéis grandes.
 */
export async function coletarTarefasSelecionadas(opts: {
  nomes: string[];
  onProgress?: (msg: string) => void;
}): Promise<{
  ok: boolean;
  snapshots: TriagemTarefaSnapshot[];
  error?: string;
}> {
  const onProgress = opts.onProgress ?? (() => {});
  const iframeWin = localizarIframePainel();

  if (!iframeWin) {
    // Painel no próprio top — executa local.
    try {
      const setNomes = new Set(opts.nomes);
      const tarefas = capturarTarefas((nome) => setNomes.has(nome));
      const snapshots = await coletarSnapshots(
        tarefas,
        window.location.origin,
        onProgress
      );
      return { ok: true, snapshots };
    } catch (err) {
      return {
        ok: false,
        snapshots: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  const requestId = `gestao-coletar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const handler = (ev: MessageEvent): void => {
      const data = ev.data;
      if (!isAnyMsg(data)) return;
      if (data.requestId !== requestId) return;
      if (data.type === MSG_COLETAR_PROG) {
        onProgress(data.msg);
        return;
      }
      if (data.type === MSG_COLETAR_RES) {
        window.removeEventListener('message', handler);
        resolve({
          ok: !data.error,
          snapshots: data.snapshots,
          ...(data.error ? { error: data.error } : {})
        });
      }
    };
    window.addEventListener('message', handler);
    const m: MsgColetarReq = {
      type: MSG_COLETAR_REQ,
      requestId,
      nomes: opts.nomes,
      pjeOrigin: window.location.origin
    };
    iframeWin.postMessage(m, '*');
  });
}
