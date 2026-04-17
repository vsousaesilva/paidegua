/**
 * Ponte top ↔ iframe para a ação "Analisar tarefas".
 *
 * Por que existe: no TRF5 (e provavelmente em outras instâncias do PJe), o
 * painel-usuario-interno é renderizado dentro de um `<iframe>` cross-origin
 * (`https://frontend-prd.trf5.jus.br/`). O content script roda em ambos os
 * frames graças a `all_frames: true` no manifest, mas eles NÃO podem ler
 * o DOM um do outro — apenas trocar mensagens via `window.postMessage`.
 *
 * Estratégia:
 *   - O iframe registra um listener que executa `executarAnalisarTarefas()`
 *     localmente (com acesso direto ao DOM do painel) e devolve progresso
 *     e resultado para o top.
 *   - O top, ao iniciar a ação, primeiro tenta achar um iframe cujo
 *     `src` contém `painel-usuario-interno`; se encontrar, delega a
 *     execução para lá via postMessage. Caso contrário, executa local
 *     (ambiente onde o painel não está em iframe).
 */

import { LOG_PREFIX } from '../../shared/constants';
import {
  executarAnalisarTarefas,
  type AnalisarTarefasResult
} from './analisar-tarefas';

const MSG_INICIAR = 'paidegua/triagem-iniciar';
const MSG_PROGRESSO = 'paidegua/triagem-progresso';
const MSG_RESULTADO = 'paidegua/triagem-resultado';

interface MsgIniciar {
  type: typeof MSG_INICIAR;
  requestId: string;
  /**
   * Origin do PJe principal (ex.: https://pje1g.trf5.jus.br). O iframe do
   * painel está em outro origin (frontend-prd...) e não tem como descobrir
   * o do PJe sozinho. Usado para montar as URLs dos autos.
   */
  pjeOrigin: string;
}
interface MsgProgresso {
  type: typeof MSG_PROGRESSO;
  requestId: string;
  msg: string;
}
interface MsgResultado {
  type: typeof MSG_RESULTADO;
  requestId: string;
  result: AnalisarTarefasResult;
}

type AnyMsg = MsgIniciar | MsgProgresso | MsgResultado;

function isAnyMsg(x: unknown): x is AnyMsg {
  if (!x || typeof x !== 'object') return false;
  const t = (x as { type?: unknown }).type;
  return (
    t === MSG_INICIAR || t === MSG_PROGRESSO || t === MSG_RESULTADO
  );
}

/**
 * Chamado pelo bootstrap quando o content script roda em um iframe cuja
 * URL contém `painel-usuario-interno`. Registra o listener que aceita
 * pedidos do top e executa o orquestrador localmente.
 */
export function instalarListenerTriagemNoIframe(): void {
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!isAnyMsg(data)) return;
    if (data.type !== MSG_INICIAR) return;
    const { requestId } = data;
    const origin = ev.origin; // pode ser '*' não recomendado — usar o origin do solicitante
    const sender = ev.source as Window | null;
    if (!sender) return;

    void (async () => {
      let result: AnalisarTarefasResult;
      try {
        result = await executarAnalisarTarefas({
          pjeOrigin: data.pjeOrigin,
          onProgress: (msg) => {
            const m: MsgProgresso = {
              type: MSG_PROGRESSO,
              requestId,
              msg
            };
            try {
              sender.postMessage(m, origin);
            } catch (err) {
              console.warn(`${LOG_PREFIX} progresso postMessage falhou:`, err);
            }
          }
        });
      } catch (err) {
        result = {
          ok: false,
          totalTarefas: 0,
          totalProcessos: 0,
          error: err instanceof Error ? err.message : String(err)
        };
      }
      const m: MsgResultado = { type: MSG_RESULTADO, requestId, result };
      try {
        sender.postMessage(m, origin);
      } catch (err) {
        console.warn(`${LOG_PREFIX} resultado postMessage falhou:`, err);
      }
      // Cleanup: o painel Angular costuma ficar em branco depois de várias
      // navegações back/forward. Como o resultado já foi entregue ao top,
      // recarregar o iframe é seguro e devolve a UI ao usuário em estado
      // consistente.
      window.setTimeout(() => {
        try {
          console.log(`${LOG_PREFIX} triagem: recarregando iframe pós-execução.`);
          window.location.reload();
        } catch (err) {
          console.warn(`${LOG_PREFIX} reload do iframe falhou:`, err);
        }
      }, 300);
    })();
  });
  console.log(`${LOG_PREFIX} triagem-bridge: listener iframe instalado.`);
}

/**
 * Procura no DOM do top um `<iframe>` cuja URL parece ser o painel
 * Angular do PJe. Retorna a janela do iframe ou `null`.
 */
export function localizarIframePainel(): Window | null {
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
 * Versão "top" da ação: se o painel estiver em iframe, delega via
 * postMessage; senão roda local.
 */
export async function executarAnalisarTarefasComBridge(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AnalisarTarefasResult> {
  const iframeWin = localizarIframePainel();
  if (!iframeWin) {
    // Sem iframe — executa direto no contexto atual (compatibilidade).
    return executarAnalisarTarefas(opts);
  }
  const onProgress = opts.onProgress ?? (() => {});
  const requestId = `triagem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<AnalisarTarefasResult>((resolve) => {
    const handler = (ev: MessageEvent) => {
      const data = ev.data;
      if (!isAnyMsg(data)) return;
      if (data.requestId !== requestId) return;
      if (data.type === MSG_PROGRESSO) {
        onProgress(data.msg);
        return;
      }
      if (data.type === MSG_RESULTADO) {
        window.removeEventListener('message', handler);
        resolve(data.result);
      }
    };
    window.addEventListener('message', handler);
    const m: MsgIniciar = {
      type: MSG_INICIAR,
      requestId,
      pjeOrigin: window.location.origin
    };
    // Usamos '*' aqui porque o iframe é cross-origin e não temos forma
    // segura de saber o origin exato (apenas o src). O conteúdo da
    // mensagem é inerte: tem só um tipo e um id sem dados sensíveis.
    iframeWin.postMessage(m, '*');
  });
}
