/**
 * Painel de Triagem Inteligente — perfil Secretaria.
 *
 * Renderizado como uma "bolha-painel" dentro do chat (timeline). Não toma
 * a coluna inteira: o chat continua sendo o container scrollável e o
 * histórico (resumos, minutas, mensagens) permanece visível ao rolar.
 *
 * Apresenta duas seções de ações:
 *   - PAINEL   → Analisar tarefas
 *   - PROCESSO → Analisar o processo · Inserir etiquetas mágicas
 *
 * As ações concretas vêm via callbacks; a lógica vive no orquestrador.
 */

export interface TriagemPanelActions {
  onAnalisarTarefas: () => void;
  onAnalisarProcesso: () => void;
  onInserirEtiquetas: () => void;
}

export interface TriagemPanelOptions {
  /**
   * Quando true, exibe o grupo "Painel" (com Analisar tarefas). A ação só faz
   * sentido na tela "painel-usuario-interno" do PJe — em outras telas o grupo
   * é omitido inteiramente para evitar confundir o usuário.
   */
  isPainelUsuario: boolean;
  /**
   * Quando true, exibe o grupo "Processo" (com Analisar o processo /
   * Inserir etiquetas mágicas). Só faz sentido quando há autos digitais
   * abertos na aba — nas demais telas (painel do usuário, lista de
   * tarefas) o grupo inteiro é omitido.
   */
  isProcessoAberto: boolean;
}

const PANEL_CSS = `
.paidegua-triagem {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.paidegua-triagem__header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--paidegua-primary);
}

.paidegua-triagem__header-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--paidegua-primary);
}

.paidegua-triagem__group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
}

.paidegua-triagem__group-title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--paidegua-primary);
  margin: 0 0 2px;
}

.paidegua-triagem__action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 11px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
  color: var(--paidegua-text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease, transform 160ms ease;
}

.paidegua-triagem__action:hover:not(:disabled) {
  background: rgba(19, 81, 180, 0.08);
  border-color: var(--paidegua-border-strong);
  transform: translateY(-1px);
}

.paidegua-triagem__action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.paidegua-triagem__action-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--paidegua-primary);
}

.paidegua-triagem__action-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.paidegua-triagem__action-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--paidegua-primary-dark);
  line-height: 1.2;
}

.paidegua-triagem__action-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--paidegua-text-muted);
  line-height: 1.35;
}
`;

const ICONS = {
  tarefas: `
    <svg class="paidegua-triagem__action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2"></rect>
      <path d="M8 2v4"></path>
      <path d="M16 2v4"></path>
      <path d="M3 10h18"></path>
      <path d="M8 14l2 2 4-4"></path>
    </svg>
  `,
  processo: `
    <svg class="paidegua-triagem__action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <path d="M9 13h6"></path>
      <path d="M9 17h4"></path>
    </svg>
  `,
  etiquetas: `
    <svg class="paidegua-triagem__action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
      <line x1="7" y1="7" x2="7.01" y2="7"></line>
    </svg>
  `
};

interface ActionSpec {
  icon: keyof typeof ICONS;
  label: string;
  hint?: string;
  onClick: () => void;
}

interface GroupSpec {
  title: string;
  actions: ActionSpec[];
}

function ensureStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector('style[data-paidegua="triagem-panel"]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-paidegua', 'triagem-panel');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);
}

function buildActionButton(action: ActionSpec): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-triagem__action';
  btn.innerHTML = `
    ${ICONS[action.icon]}
    <span class="paidegua-triagem__action-body">
      <span class="paidegua-triagem__action-label">${action.label}</span>
      ${action.hint ? `<span class="paidegua-triagem__action-hint">${action.hint}</span>` : ''}
    </span>
  `;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    action.onClick();
  });
  return btn;
}

function buildGroup(spec: GroupSpec): HTMLElement {
  const group = document.createElement('section');
  group.className = 'paidegua-triagem__group';
  const title = document.createElement('h3');
  title.className = 'paidegua-triagem__group-title';
  title.textContent = spec.title;
  group.appendChild(title);
  for (const action of spec.actions) {
    group.appendChild(buildActionButton(action));
  }
  return group;
}

/**
 * Cria o painel de triagem como um nó solto, pronto para ser anexado em
 * qualquer container (tipicamente o `addCustomBubble` do chat). Devolve o
 * elemento; o ciclo de vida (remover, substituir) é do chamador.
 */
export function createTriagemPanel(
  shadow: ShadowRoot,
  actions: TriagemPanelActions,
  options: TriagemPanelOptions
): HTMLElement {
  ensureStyle(shadow);

  const root = document.createElement('div');
  root.className = 'paidegua-triagem';

  const header = document.createElement('div');
  header.className = 'paidegua-triagem__header';
  const dot = document.createElement('span');
  dot.className = 'paidegua-triagem__header-dot';
  const label = document.createElement('span');
  label.textContent = 'Triagem inteligente';
  header.append(dot, label);
  root.appendChild(header);

  const groups: GroupSpec[] = [];

  if (options.isPainelUsuario) {
    groups.push({
      title: 'Painel',
      actions: [
        {
          icon: 'tarefas',
          label: 'Analisar tarefas',
          hint: 'Varre o painel e sugere o próximo passo para cada tarefa.',
          onClick: actions.onAnalisarTarefas
        }
      ]
    });
  }

  if (options.isProcessoAberto) {
    groups.push({
      title: 'Processo',
      actions: [
        {
          icon: 'processo',
          label: 'Analisar o processo',
          hint: 'Lê os autos e destaca o que exige atenção da secretaria.',
          onClick: actions.onAnalisarProcesso
        },
        {
          icon: 'etiquetas',
          label: 'Inserir etiquetas mágicas',
          hint: 'Aplica etiquetas com base no estado atual do processo.',
          onClick: actions.onInserirEtiquetas
        }
      ]
    });
  }

  for (const group of groups) {
    root.appendChild(buildGroup(group));
  }

  if (groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'paidegua-triagem__group';
    const msg = document.createElement('div');
    msg.className = 'paidegua-triagem__action-hint';
    msg.textContent =
      'Abra um processo dos autos digitais ou o painel do usuário do PJe para usar ' +
      'as ações de triagem.';
    empty.appendChild(msg);
    root.appendChild(empty);
  }

  return root;
}
