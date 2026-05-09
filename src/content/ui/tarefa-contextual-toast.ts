/**
 * Toast flutuante do detector contextual de tarefa (FLUX-04).
 *
 * Aparece no canto inferior direito da viewport quando o detector
 * (`tarefa-contextual-detector.ts`) reconhece o nome de uma tarefa
 * conhecida do catálogo na página atual do PJe. Não-intrusivo:
 *   - clique em "Ver tarefa" abre o Mapa de Jornada na rota da
 *     tarefa (?tarefa=<id>) em nova aba e fecha o toast;
 *   - clique em "✕" dispensa (não reaparece nesta sessão);
 *   - sem clique → some sozinho após AUTO_DISMISS_MS.
 *
 * Vive fora do shadow DOM do paidegua para não depender do sidebar
 * estar montado. Usa um shadow root próprio para isolamento de CSS.
 */

const HOST_ID = 'paidegua-tarefa-contextual-toast';
const AUTO_DISMISS_MS = 14000;

interface ToastHandlers {
  onAbrir: () => void;
  onDispensar: () => void;
}

const TOAST_CSS = `
:host {
  all: initial;
  position: fixed;
  bottom: 22px;
  right: 22px;
  z-index: 2147483646;
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
}
.wrap {
  width: 320px;
  max-width: calc(100vw - 44px);
  background: #ffffff;
  color: #1f2933;
  border: 1px solid #c4ccd4;
  border-left: 4px solid #1351b4;
  border-radius: 10px;
  box-shadow: 0 12px 28px rgba(12, 50, 111, 0.22);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: slideIn 220ms ease-out;
}
@keyframes slideIn {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.kicker {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #1351b4;
}
.fechar {
  border: 0;
  background: transparent;
  cursor: pointer;
  color: #6b7785;
  font-size: 16px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  margin: -4px -6px 0 0;
}
.fechar:hover { background: #f4f7fc; color: #1f2933; }
.titulo {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: #0c326f;
  line-height: 1.35;
  word-break: break-word;
}
.descricao {
  margin: 0;
  font-size: 12px;
  color: #4a4a4a;
  line-height: 1.4;
}
.acoes {
  display: flex;
  gap: 6px;
}
.cta {
  flex: 1;
  border: 0;
  background: #1351b4;
  color: #fff;
  padding: 8px 12px;
  border-radius: 6px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 140ms ease, transform 140ms ease;
}
.cta:hover { background: #0c326f; transform: translateY(-1px); }
.ghost {
  border: 1px solid #c4ccd4;
  background: #ffffff;
  color: #1f2933;
  padding: 8px 12px;
  border-radius: 6px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.ghost:hover { background: #f4f7fc; }

@media (max-width: 720px) {
  :host { right: 12px; bottom: 12px; left: 12px; }
  .wrap { width: auto; }
}
`;

let timer: number | null = null;

/**
 * Mostra o toast com a tarefa detectada. Substitui qualquer toast
 * anterior (uma tarefa por vez na tela). Idempotente.
 */
export function mostrarToastTarefaContextual(
  nomeTarefa: string,
  handlers: ToastHandlers
): void {
  removerToastTarefaContextual();
  const host = document.createElement('div');
  host.id = HOST_ID;
  // Posicionamento e isolamento de estilos via shadow root.
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = TOAST_CSS;
  shadow.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-live', 'polite');
  wrap.setAttribute('aria-label', `Tarefa do PJe detectada: ${nomeTarefa}`);

  const head = document.createElement('div');
  head.className = 'head';
  const kicker = document.createElement('span');
  kicker.className = 'kicker';
  kicker.textContent = '⤴ pAIdegua reconheceu esta tarefa';
  const fechar = document.createElement('button');
  fechar.type = 'button';
  fechar.className = 'fechar';
  fechar.setAttribute('aria-label', 'Dispensar (não reaparece nesta sessão)');
  fechar.textContent = '✕';
  fechar.addEventListener('click', () => {
    handlers.onDispensar();
    removerToastTarefaContextual();
  });
  head.append(kicker, fechar);
  wrap.appendChild(head);

  const titulo = document.createElement('p');
  titulo.className = 'titulo';
  titulo.textContent = nomeTarefa;
  wrap.appendChild(titulo);

  const desc = document.createElement('p');
  desc.className = 'descricao';
  desc.textContent = 'Posso te mostrar o que vem a seguir, quem é responsável e os pontos de atenção.';
  wrap.appendChild(desc);

  const acoes = document.createElement('div');
  acoes.className = 'acoes';
  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'cta';
  cta.textContent = 'Ver tarefa no Mapa';
  cta.addEventListener('click', () => {
    handlers.onAbrir();
    removerToastTarefaContextual();
  });
  acoes.appendChild(cta);
  wrap.appendChild(acoes);

  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);

  // Auto-dismiss após AUTO_DISMISS_MS (sem chamar onDispensar — ainda
  // pode reaparecer; só some por inatividade).
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => removerToastTarefaContextual(), AUTO_DISMISS_MS);
}

export function removerToastTarefaContextual(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  document.getElementById(HOST_ID)?.remove();
}
