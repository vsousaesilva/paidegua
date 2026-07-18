/**
 * Decorator de streaming aplicado a TODOS os provedores no registry.
 *
 * Resolve dois modos de falha que se manifestam igual para o usuario — a UI
 * pisca o indicador de digitacao para sempre e nenhuma resposta aparece:
 *
 * 1. Service worker MV3 morto no meio do stream. O Chromium encerra o worker
 *    apos 30s sem receber evento algum. Um stream HTTP aberto mas silencioso
 *    (tipico de modelo de raciocinio pensando antes do primeiro token) nao
 *    dispara evento de extensao nenhum, entao o worker e derrubado e o
 *    generator morre sem erro. Chamar periodicamente uma API de extensao
 *    reseta esse timer ocioso.
 *
 * 2. Stream que nunca produz o primeiro token. Sem limite, o caller espera
 *    indefinidamente. Aqui abortamos e lancamos erro explicito, para que a UI
 *    mostre uma mensagem em vez de piscar sem fim.
 *
 * O watchdog vale so ate o primeiro chunk: depois disso o proprio fluxo de
 * chunks e a prova de que o stream esta vivo, e respostas longas nao devem
 * ser interrompidas.
 */

import type { LLMProvider, SendMessageParams, StreamChunk } from './base';

/** Abaixo dos 30s do timer ocioso do service worker MV3. */
const KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * Teto para o primeiro token. Generoso de proposito: cobre o pior caso de um
 * modelo de raciocinio com prompt institucional longo sem cortar trabalho
 * legitimo.
 */
const FIRST_TOKEN_TIMEOUT_MS = 90_000;

function startKeepalive(): () => void {
  const timer = setInterval(() => {
    // Qualquer chamada a uma API de extensao reseta o timer ocioso do worker.
    // getPlatformInfo e barata e nao tem efeito colateral em storage.
    chrome.runtime.getPlatformInfo().catch(() => {
      /* worker ja encerrando — nada a fazer */
    });
  }, KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function* guardStream(
  provider: LLMProvider,
  params: SendMessageParams
): AsyncGenerator<StreamChunk, void, void> {
  // Controller proprio encadeado ao signal externo: permite ao watchdog
  // cortar o fetch subjacente sem interferir no abort do caller.
  const controller = new AbortController();
  const abortExterno = () => controller.abort();
  if (params.signal.aborted) {
    return;
  }
  params.signal.addEventListener('abort', abortExterno, { once: true });

  const pararKeepalive = startKeepalive();
  const generator = provider.sendMessage({ ...params, signal: controller.signal });
  let recebeuPrimeiroChunk = false;

  try {
    while (true) {
      const proximo = generator.next();
      const resultado = recebeuPrimeiroChunk
        ? await proximo
        : await comTimeoutPrimeiroToken(proximo, controller, params.model);
      if (resultado.done) {
        return;
      }
      recebeuPrimeiroChunk = true;
      yield resultado.value;
    }
  } finally {
    pararKeepalive();
    params.signal.removeEventListener('abort', abortExterno);
    await generator.return(undefined).catch(() => {
      /* generator ja encerrado */
    });
  }
}

async function comTimeoutPrimeiroToken(
  proximo: Promise<IteratorResult<StreamChunk, void>>,
  controller: AbortController,
  model: string
): Promise<IteratorResult<StreamChunk, void>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `O modelo ${model} nao devolveu nenhum texto em ` +
            `${Math.round(FIRST_TOKEN_TIMEOUT_MS / 1000)}s. ` +
            'Tente novamente ou selecione um modelo mais rapido nas configuracoes.'
        )
      );
    }, FIRST_TOKEN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([proximo, estouro]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Devolve o provedor com o streaming protegido por keepalive + watchdog. */
export function withStreamGuard(provider: LLMProvider): LLMProvider {
  return {
    ...provider,
    sendMessage: (params: SendMessageParams) => guardStream(provider, params)
  };
}
