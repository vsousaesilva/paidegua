/**
 * Coletor de expedientes via iframe oculto — substitui o caminho via
 * `chrome.tabs.create` no background para o pipeline "Prazos na fita".
 *
 * Motivacao: a aba Expedientes do PJe legacy carrega via RichFaces A4J
 * (postback ao proprio `.seam`), nao expondo endpoint REST para
 * substituicao direta. Entao optamos pelo caminho intermediario: em vez
 * de abrir uma `chrome.tabs.create` por processo (com overhead de
 * criacao/destruicao de tab + bridge ida-e-volta ao service worker),
 * abrimos um `<iframe>` same-origin no DOM do proprio painel PJe. A
 * pagina carrega, clicamos no link da aba via `.click()` (mesmo mecanismo
 * do adapter), esperamos o tbody popular, lemos o DOM e destruimos o
 * iframe.
 *
 * Ganhos:
 *  - Elimina IPC de `chrome.tabs.create`/`remove` por processo.
 *  - Elimina message-roundtrip com service worker (`PRAZOS_FITA_EXTRAIR_NA_ABA`).
 *  - O iframe nao disputa recursos de render do navegador tao agressivamente
 *    quanto N tabs paralelas (permite concorrencia maior com menos estresse).
 *
 * Pre-condicoes:
 *  - Rodar no top frame de uma pagina same-origin com `listAutosDigitais.seam`
 *    (i.e., o painel do PJe legacy — `pje1g.trf5.jus.br`, `pje2g...`, etc.).
 *  - Cookie `JSESSIONID` presente no mesmo origin (ja esta, por construcao).
 */

import type { PrazosProcessoColeta } from '../../shared/types';
import {
  derivarAnomaliasProcesso,
  ensureAbaExpedientesInDoc,
  extractExpedientesFromDoc,
  extractNumeroProcessoFromDoc
} from '../adapters/pje-legacy';

interface Opts {
  url: string;
  /** Timeout para load + render + aba Expedientes abrir. Default 45s. */
  timeoutMs?: number;
}

export async function coletarExpedientesViaIframe(
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
  const timeoutMs = opts.timeoutMs ?? 45_000;

  const iframe = document.createElement('iframe');
  // Atributos conservadores: invisivel, zero area, sem bordas. Nao usamos
  // `display: none` porque algumas paginas PJe dependem de layout/JS
  // rodar durante o load; `visibility: hidden` + dimensoes mantem o render
  // "normal" sem exibir nada para o usuario.
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.style.cssText =
    'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;' +
    'visibility:hidden;pointer-events:none;border:0;';

  try {
    document.body.appendChild(iframe);

    const loaded = esperarLoad(iframe, timeoutMs);
    iframe.src = url;
    await loaded;

    const doc = iframe.contentDocument;
    if (!doc) {
      return {
        url,
        ok: false,
        numeroProcesso: null,
        error: 'iframe.contentDocument indisponivel (cross-origin?).',
        duracaoMs: Date.now() - inicio
      };
    }

    // Pequeno jitter apos o load — algumas inicializacoes de A4J/RichFaces
    // rodam em `setTimeout(..., 0)` e so ficam prontas no proximo tick.
    await pausa(120);

    const numeroProcesso = extractNumeroProcessoFromDoc(doc);
    const abaOk = await ensureAbaExpedientesInDoc(
      doc,
      Math.min(timeoutMs, 10_000)
    );
    if (!abaOk) {
      return {
        url,
        ok: false,
        numeroProcesso,
        error: 'Aba Expedientes nao carregou no iframe.',
        duracaoMs: Date.now() - inicio
      };
    }

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
  } catch (err) {
    return {
      url,
      ok: false,
      numeroProcesso: null,
      error: err instanceof Error ? err.message : String(err),
      duracaoMs: Date.now() - inicio
    };
  } finally {
    try {
      iframe.src = 'about:blank';
    } catch {
      /* ignore */
    }
    iframe.remove();
  }
}

function esperarLoad(iframe: HTMLIFrameElement, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
      window.clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const onLoad = (): void => finish();
    const onError = (): void => finish(new Error('iframe disparou `error`.'));
    const timer = window.setTimeout(
      () => finish(new Error(`Timeout (${timeoutMs}ms) aguardando load do iframe.`)),
      timeoutMs
    );
    iframe.addEventListener('load', onLoad);
    iframe.addEventListener('error', onError);
  });
}

function pausa(ms: number): Promise<void> {
  return new Promise((res) => window.setTimeout(res, ms));
}
