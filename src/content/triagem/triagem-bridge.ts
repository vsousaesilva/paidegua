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

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import type { TriagemDashboardPayload } from '../../shared/types';
import {
  executarAnalisarTarefas,
  TAREFA_REGEX,
  type AnalisarTarefasResult
} from './analisar-tarefas';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';
import { coletarSnapshotsViaAPI } from '../gestao/triagem-from-api';

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

async function pedirAberturaDashboard(
  payload: TriagemDashboardPayload
): Promise<boolean> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TRIAGEM_OPEN_DASHBOARD,
      payload
    });
    return Boolean(resp?.ok);
  } catch (err) {
    console.warn(`${LOG_PREFIX} pedirAberturaDashboard (bridge) falhou:`, err);
    return false;
  }
}

/**
 * Caminho REST-first no top frame — espelha o padrão do Gestão:
 *   1. Pede ao iframe a lista de tarefas do painel (só DOM read).
 *   2. Filtra por `TAREFA_REGEX`.
 *   3. Chama `coletarSnapshotsViaAPI` (REST + gerarChaveAcesso → URL direta
 *      para `listAutosDigitais.seam?idProcesso=X&ca=Y`).
 *   4. Persiste payload + abre dashboard.
 *
 * Retorna `null` quando o REST não está disponível (sem auth snapshot ou
 * nenhuma tarefa match) — caller cai no fallback DOM.
 */
async function tentarViaApiRest(
  onProgress: (msg: string) => void
): Promise<AnalisarTarefasResult | null> {
  const listagem = await listarTarefasDoPainel();
  if (!listagem.ok) {
    onProgress(`Não foi possível listar tarefas (${listagem.error ?? 'sem detalhe'}) — tentando pelo DOM, aguarde...`);
    return null;
  }
  const nomes = listagem.tarefas
    .map((t) => t.nome)
    .filter((n) => TAREFA_REGEX.test(n));
  if (nomes.length === 0) {
    return {
      ok: false,
      totalTarefas: 0,
      totalProcessos: 0,
      error:
        'Nenhuma tarefa contendo "Analisar inicial" ou "Triagem" foi encontrada no painel.'
    };
  }

  onProgress(`Analisando ${nomes.length} tarefa(s) via API REST...`);
  const pjeOrigin = window.location.origin;
  const resultado = await coletarSnapshotsViaAPI({
    nomes,
    pjeOrigin,
    onProgress
  });
  if (!resultado.ok) {
    onProgress(
      `Coleta rápida indisponível (${resultado.error ?? 'sem detalhe'}) — continuando pelo DOM, aguarde...`
    );
    return null;
  }

  const totalProcessos = resultado.snapshots.reduce((s, t) => s + t.totalLido, 0);
  const payload: TriagemDashboardPayload = {
    geradoEm: new Date().toISOString(),
    hostnamePJe: new URL(pjeOrigin).hostname,
    tarefas: resultado.snapshots,
    totalProcessos,
    insightsLLM: null
  };

  onProgress('Abrindo dashboard...');
  const ok = await pedirAberturaDashboard(payload);
  if (!ok) {
    return {
      ok: false,
      totalTarefas: resultado.snapshots.length,
      totalProcessos,
      error: 'Falha ao abrir o dashboard. Veja o console para detalhes.'
    };
  }
  return {
    ok: true,
    totalTarefas: resultado.snapshots.length,
    totalProcessos
  };
}

/**
 * Versão "top" da ação. Estratégia em duas camadas:
 *   1. REST-first (preferido): roda no top frame, devolve URLs autenticadas
 *      diretas para os autos. Mesmo padrão do Gestão/Prazos na Fita.
 *   2. Fallback DOM via postMessage para o iframe do painel quando o
 *      snapshot de auth ainda não foi capturado pelo interceptor.
 */
export async function executarAnalisarTarefasComBridge(opts: {
  onProgress?: (msg: string) => void;
}): Promise<AnalisarTarefasResult> {
  const onProgress = opts.onProgress ?? (() => {});

  // -- Caminho REST (preferido) -----------------------------------------
  try {
    const restResult = await tentarViaApiRest(onProgress);
    if (restResult) return restResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress(`Coleta rápida falhou inesperadamente (${msg}) — continuando pelo DOM, aguarde...`);
  }

  // -- Fallback DOM -----------------------------------------------------
  const iframeWin = localizarIframePainel();
  if (!iframeWin) {
    // Sem iframe — executa direto no contexto atual (compatibilidade).
    return executarAnalisarTarefas(opts);
  }
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
