/**
 * Coletor de expedientes via `fetch` direto — substitui o caminho via
 * iframe oculto.
 *
 * Descoberta que viabiliza este caminho: a URL
 * `listAutosDigitais.seam?idProcesso=X&ca=Y&idTaskInstance=Z&aba=processoExpedienteTab`
 * retorna o HTML ja renderizado no servidor com a aba Expedientes ativa
 * (SSR JSF). Nao precisamos do postback A4J para popular a tabela; o
 * fragmento completo ja vem no HTML inicial.
 *
 * Ganhos vs iframe:
 *  - ~10x mais rapido por processo (300-500ms vs 3-5s): sem render, sem
 *    postback, sem esperar evento `load`.
 *  - Determinismo: elimina a classe inteira de bugs relacionados a iframe
 *    pendurado, eventos `load` tardios e session state de RichFaces.
 *  - Custo de memoria baixo: so strings + um Document transiente, sem
 *    manter iframes vivos no DOM.
 *
 * Pre-condicoes:
 *  - Rodar no content script same-origin com o PJe legacy (para que
 *    cookies JSESSIONID sejam enviados pelo browser).
 *  - URL construida com `aba=processoExpedienteTab` (o coordinator faz).
 */

import type { PrazosProcessoColeta } from '../../shared/types';
import {
  derivarAnomaliasProcesso,
  extractExpedientesFromDoc,
  extractNumeroProcessoFromDoc
} from '../adapters/pje-legacy';

interface Opts {
  url: string;
  /** Timeout duro para o GET completo (handshake + body). Default 30s. */
  timeoutMs?: number;
}

/**
 * Classifica erros de `fetch`/HTTP como transientes. `TypeError` e o que
 * o browser emite para "Failed to fetch" (rede caiu, conexao resetada,
 * DNS falhou, CORS trocou) — reproduzivel em varreduras longas quando o
 * servidor do PJe rate-limita ou quando a aba fica em memory pressure.
 * `AbortError`/`TimeoutError` sao do nosso proprio timeout. `429` e rate
 * limit explicito; `5xx`, erro de servidor.
 */
function eErroTransiente(err: unknown, httpStatus?: number): boolean {
  if (typeof httpStatus === 'number') {
    if (httpStatus === 429) return true;
    if (httpStatus >= 500 && httpStatus < 600) return true;
    return false;
  }
  if (err instanceof DOMException) {
    return err.name === 'AbortError' || err.name === 'TimeoutError';
  }
  if (err instanceof TypeError) return true;
  return false;
}

/**
 * Uma unica passada: fetch + parse. Separada do retry para que a logica
 * de backoff/reclassificacao fique limpa.
 */
async function tentarUmaVez(
  url: string,
  timeoutMs: number
): Promise<
  | { kind: 'ok'; html: string }
  | { kind: 'http'; status: number }
  | { kind: 'transiente'; error: unknown }
  | { kind: 'definitivo'; error: unknown }
> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs
  );
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal: ctrl.signal
    });
    if (!resp.ok) {
      // Drena corpo para liberar a conexao mesmo em erro.
      await resp.text().catch(() => '');
      return { kind: 'http', status: resp.status };
    }
    const html = await resp.text();
    return { kind: 'ok', html };
  } catch (err) {
    return eErroTransiente(err)
      ? { kind: 'transiente', error: err }
      : { kind: 'definitivo', error: err };
  } finally {
    clearTimeout(timer);
  }
}

export async function coletarExpedientesViaFetch(
  opts: Opts
): Promise<PrazosProcessoColeta> {
  const inicio = Date.now();
  const url = opts.url;
  if (!url || typeof url !== 'string') {
    return {
      url: String(url ?? ''),
      ok: false,
      numeroProcesso: null,
      error: 'URL ausente ou invalida.',
      duracaoMs: 0
    };
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // Retry com backoff exponencial: 1s, 3s, 9s (ate 4 tentativas totais).
  // Cobre "Failed to fetch" (TypeError) em varreduras longas, quando o
  // servidor do PJe rejeita por burst ou a rede oscila. Mesmo orcamento
  // usado em `comRetryTransiente` do pje-api-from-content.
  const tentativas = 4;
  const baseMs = 1_000;
  let ultimoErro: unknown = null;
  let ultimoHttp: number | null = null;
  let htmlOk: string | null = null;

  for (let i = 0; i < tentativas; i++) {
    const r = await tentarUmaVez(url, timeoutMs);
    if (r.kind === 'ok') {
      htmlOk = r.html;
      break;
    }
    if (r.kind === 'http') {
      ultimoHttp = r.status;
      if (eErroTransiente(null, r.status) && i < tentativas - 1) {
        await new Promise((res) => setTimeout(res, baseMs * Math.pow(3, i)));
        continue;
      }
      break;
    }
    if (r.kind === 'transiente' && i < tentativas - 1) {
      ultimoErro = r.error;
      await new Promise((res) => setTimeout(res, baseMs * Math.pow(3, i)));
      continue;
    }
    ultimoErro = r.error;
    break;
  }

  if (htmlOk == null) {
    if (ultimoHttp != null) {
      return {
        url,
        ok: false,
        numeroProcesso: null,
        error: `HTTP ${ultimoHttp} carregando autos digitais.`,
        duracaoMs: Date.now() - inicio
      };
    }
    return {
      url,
      ok: false,
      numeroProcesso: null,
      error:
        ultimoErro instanceof Error
          ? ultimoErro.message
          : String(ultimoErro ?? 'falha desconhecida'),
      duracaoMs: Date.now() - inicio
    };
  }

  if (!htmlOk) {
    return {
      url,
      ok: false,
      numeroProcesso: null,
      error: 'Resposta vazia do PJe.',
      duracaoMs: Date.now() - inicio
    };
  }

  const doc = new DOMParser().parseFromString(htmlOk, 'text/html');
  const numeroProcesso = extractNumeroProcessoFromDoc(doc);
  const extracao = extractExpedientesFromDoc(doc);
  const anomaliasProcesso = derivarAnomaliasProcesso(extracao);
  return {
    url,
    ok: true,
    numeroProcesso,
    extracao,
    anomaliasProcesso,
    duracaoMs: Date.now() - inicio
  };
}
