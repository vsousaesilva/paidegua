/**
 * Utilitários para lidar com o erro "Extension context invalidated" do Chrome.
 *
 * Esse erro acontece quando a extensão é recarregada/atualizada (manualmente
 * via chrome://extensions, ou automaticamente pela CWS) com um content script
 * ainda vivo numa aba aberta. O content script "velho" perde o `chrome.runtime`
 * mas continua vivo até a aba ser recarregada — e qualquer chamada subsequente
 * a `chrome.*` (listeners, timers, port handlers, MutationObserver callbacks)
 * dispara o erro.
 *
 * NÃO é bug do nosso código — é cenário esperado do ciclo de vida de extensões.
 */

export function isExtensionContextInvalidated(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /extension context invalidated/i.test(msg);
}

/**
 * Instala handlers globais de `error` e `unhandledrejection` que **silenciam
 * apenas** o erro "Extension context invalidated", deixando todos os outros
 * passarem normalmente. Chame uma única vez no início de cada content script.
 *
 * Em vez do stack vermelho, registra um log discreto (uma única vez) sinalizando
 * que a aba precisa ser recarregada para retomar a extensão.
 */
export function installExtensionContextSilencer(opts?: {
  onInvalidated?: () => void;
}): void {
  let avisado = false;
  const aviso = (): void => {
    if (avisado) return;
    avisado = true;
    if (opts?.onInvalidated) {
      try {
        opts.onInvalidated();
      } catch {
        // Defesa: nunca propagar erro do próprio handler.
      }
    }
  };

  window.addEventListener(
    'error',
    (ev: ErrorEvent) => {
      if (isExtensionContextInvalidated(ev.error ?? ev.message)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        aviso();
      }
    },
    true
  );

  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    if (isExtensionContextInvalidated(ev.reason)) {
      ev.preventDefault();
      aviso();
    }
  });
}
