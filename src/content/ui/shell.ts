/**
 * Shell da UI injetada pelo content script.
 *
 * Cria um host `<div>` ancorado no body da página do PJe e anexa um
 * Shadow DOM **fechado** (mode: 'closed'), dentro do qual FAB e sidebar
 * são montados. Isso garante:
 *   - Isolamento total de estilos contra o CSS do PJe (sem vazamento).
 *   - Superfície mínima de interferência com scripts da página.
 *   - Um único ponto de ciclo de vida (mount/destroy).
 *
 * O shell é idempotente: múltiplas chamadas a `mountShell` retornam sempre
 * a mesma instância, o que é útil quando o detector reexecuta após mudanças
 * do DOM (MutationObserver) e precisa apenas atualizar a detecção.
 */

const HOST_ID = 'paidegua-root-host';

/** Controlador devolvido por `mountShell`. */
export interface ShellController {
  /** ShadowRoot isolado onde FAB e sidebar vivem. */
  readonly shadow: ShadowRoot;
  /** Remove a UI inteira do DOM. */
  destroy(): void;
}

let singleton: ShellController | null = null;

/**
 * Cria (ou recupera) o shell. Retorna sempre a mesma instância durante
 * o ciclo de vida da página.
 */
export function mountShell(): ShellController {
  if (singleton) {
    return singleton;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  // Reset absoluto para não herdar estilos do PJe no host. O conteúdo real
  // vive dentro do shadow root e é estilizado lá.
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.width = '0';
  host.style.height = '0';
  host.style.zIndex = '2147483647'; // máximo int32 — acima de tudo no PJe
  host.style.pointerEvents = 'none'; // filhos reativam pointerEvents quando precisarem

  const shadow = host.attachShadow({ mode: 'closed' });

  // CSS base comum ao FAB e ao sidebar, injetado diretamente no shadow root.
  const style = document.createElement('style');
  style.textContent = SHELL_BASE_CSS;
  shadow.appendChild(style);

  document.documentElement.appendChild(host);

  singleton = {
    shadow,
    destroy(): void {
      host.remove();
      singleton = null;
    }
  };

  return singleton;
}

/**
 * Variáveis de tema + reset básico. Todo o resto de estilo é adicionado
 * pelos módulos fab.ts e sidebar.ts nos seus próprios <style>.
 */
const SHELL_BASE_CSS = `
:host, * {
  box-sizing: border-box;
}

/*
 * Paleta institucional alinhada ao gov.br / PJe-CNJ.
 * Tom claro, glassmorphism sutil, azul institucional como cor primária.
 */
:host {
  --paidegua-primary: #1351B4;
  --paidegua-primary-dark: #0C326F;
  --paidegua-primary-light: #5992ED;
  --paidegua-accent: #1351B4;
  --paidegua-accent-hover: #0C326F;
  --paidegua-yellow: #FFCD07;
  --paidegua-bg: rgba(255, 255, 255, 0.88);
  --paidegua-bg-elev: rgba(244, 247, 252, 0.78);
  --paidegua-bg-solid: #F8FAFC;
  --paidegua-text: #16243A;
  --paidegua-text-muted: #5B6B82;
  --paidegua-border: rgba(19, 81, 180, 0.14);
  --paidegua-border-strong: rgba(19, 81, 180, 0.26);
  --paidegua-radius: 14px;
  --paidegua-radius-sm: 10px;
  --paidegua-font: "Inter", "Rawline", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --paidegua-shadow: 0 18px 52px rgba(12, 50, 111, 0.22), 0 2px 6px rgba(12, 50, 111, 0.08);
  --paidegua-blur: saturate(180%) blur(18px);
  --paidegua-gradient: linear-gradient(135deg, #1351B4 0%, #0C326F 100%);
}

button {
  font-family: var(--paidegua-font);
  cursor: pointer;
  border: none;
  letter-spacing: 0.1px;
}

::selection {
  background: rgba(19, 81, 180, 0.18);
  color: #0C326F;
}
`;
