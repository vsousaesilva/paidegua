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
import { coletarSnapshotsViaAPI, hidratarUrlsViaAPI } from './triagem-from-api';
import { startScan } from '../../shared/telemetry';

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
 *
 * Caminho preferencial: REST (`recuperarProcessosTarefaPendenteComCriterios`
 * + `gerarChaveAcessoProcesso`). Roda no top frame, não depende do iframe
 * do painel, e traz campos que o DOM não entrega (assuntoPrincipal,
 * descricaoUltimoMovimento, ultimoMovimento, sigiloso real, idProcesso
 * real). Só cai no DOM se o snapshot de auth ainda não foi capturado —
 * nesse caso o usuário precisa abrir uma tarefa uma vez para o
 * interceptor gravar o snapshot.
 */
export async function coletarTarefasSelecionadas(opts: {
  nomes: string[];
  onProgress?: (msg: string) => void;
}): Promise<{
  ok: boolean;
  snapshots: TriagemTarefaSnapshot[];
  /**
   * Quando a coleta foi feita via REST com hidratação progressiva de URLs
   * (`gerarChaveAcesso` em segundo plano), o bridge devolve o scanId
   * usado como sufixo da chave de `chrome.storage.session` onde a
   * resolução parcial é publicada. O caller propaga esse id ao payload
   * do dashboard para que a aba escute `storage.onChanged` e atualize
   * os links. Quando a coleta caiu no fallback DOM (que já traz `p.url`
   * pronto), retorna `undefined`.
   */
  urlHydrationScanId?: string;
  /**
   * Origin do PJe legacy usado na montagem das URLs. Acompanha
   * `urlHydrationScanId` para o caller propagar ao payload. Ausente no
   * fallback DOM.
   */
  legacyOrigin?: string;
  error?: string;
}> {
  const onProgress = opts.onProgress ?? (() => {});

  // Telemetria: uma varredura por chamada de `coletarTarefasSelecionadas`.
  // A via escolhida (rest/dom/dom-iframe) é marcada em `meta.viaUsada`;
  // fallback REST→DOM incrementa `fallback-dom`. Tudo tolerante a erro —
  // se o storage falhar, a coleta segue normalmente.
  const scan = startScan('painel-gerencial', {
    tarefas: opts.nomes.length,
    nomes: opts.nomes
  });

  // -- Caminho REST (preferido) ------------------------------------------
  try {
    const endRest = scan.phase('rest');
    const pjeOrigin = window.location.origin;
    // Hidratação progressiva: a coleta termina em segundos (sem worker
    // pool O(n) de `gerarChaveAcesso`). As URLs dos autos entram depois,
    // em segundo plano via `hidratarUrlsViaAPI`, e o dashboard atualiza
    // os links conforme cada `ca` resolve. Antes, o usuário via "25 em
    // 25" segurando o relatório até o fim da resolução.
    const resultadoApi = await coletarSnapshotsViaAPI({
      nomes: opts.nomes,
      pjeOrigin,
      onProgress,
      telemetry: scan,
      skipCaResolution: true
    });
    await endRest({ ok: resultadoApi.ok });
    if (resultadoApi.ok) {
      const totalProc = resultadoApi.snapshots.reduce(
        (acc, s) => acc + s.processos.length,
        0
      );
      scan.mergeMeta({ viaUsada: 'rest', totalProcessos: totalProc });
      await scan.success();
      const urlHydrationScanId = `gestao-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Fire-and-forget: continua rodando no content script mesmo depois
      // de `coletarTarefasSelecionadas` retornar.
      void hidratarUrlsViaAPI(resultadoApi.snapshots, {
        scanId: urlHydrationScanId,
        legacyOrigin: pjeOrigin
      }).catch((err) => {
        console.warn(`${LOG_PREFIX} hidratacao gestao falhou:`, err);
      });
      return {
        ok: true,
        snapshots: resultadoApi.snapshots,
        urlHydrationScanId,
        legacyOrigin: pjeOrigin
      };
    }
    scan.counter('fallback-dom');
    scan.mergeMeta({ restError: resultadoApi.error ?? 'sem detalhe' });
    onProgress(
      `Coleta rápida indisponível (${resultadoApi.error ?? 'sem detalhe'}) — continuando pelo DOM, aguarde...`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    scan.counter('fallback-dom');
    scan.mergeMeta({ restError: msg });
    onProgress(`Coleta rápida falhou inesperadamente (${msg}) — continuando pelo DOM, aguarde...`);
  }

  // -- Fallback DOM ------------------------------------------------------
  const iframeWin = localizarIframePainel();

  if (!iframeWin) {
    // Painel no próprio top — executa local.
    const endDom = scan.phase('dom-top');
    try {
      const setNomes = new Set(opts.nomes);
      const tarefas = capturarTarefas((nome) => setNomes.has(nome));
      const snapshots = await coletarSnapshots(
        tarefas,
        window.location.origin,
        onProgress
      );
      const totalProc = snapshots.reduce(
        (acc, s) => acc + s.processos.length,
        0
      );
      const truncadas = snapshots.filter((s) => s.truncado).length;
      await endDom({ totalProcessos: totalProc, truncadas });
      scan.mergeMeta({
        viaUsada: 'dom-top',
        totalProcessos: totalProc,
        tarefasTruncadas: truncadas
      });
      if (truncadas > 0) scan.counter('tarefas-truncadas', truncadas);
      await scan.success();
      return { ok: true, snapshots };
    } catch (err) {
      await endDom({ erro: true });
      await scan.fail(err);
      return {
        ok: false,
        snapshots: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  const requestId = `gestao-coletar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const endDomIframe = scan.phase('dom-iframe');
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
        const totalProc = data.snapshots.reduce(
          (acc, s) => acc + s.processos.length,
          0
        );
        const truncadas = data.snapshots.filter((s) => s.truncado).length;
        void (async () => {
          await endDomIframe({
            totalProcessos: totalProc,
            truncadas,
            erro: Boolean(data.error)
          });
          scan.mergeMeta({
            viaUsada: 'dom-iframe',
            totalProcessos: totalProc,
            tarefasTruncadas: truncadas
          });
          if (truncadas > 0) scan.counter('tarefas-truncadas', truncadas);
          if (data.error) {
            await scan.fail(data.error);
          } else {
            await scan.success();
          }
        })();
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
