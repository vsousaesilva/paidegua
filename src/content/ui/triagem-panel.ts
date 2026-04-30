/**
 * Painel de Ações da Secretaria — bolha do chat (perfil Secretaria).
 *
 * Layout master-detail dentro da bolha:
 *
 *   ┌──────────────────────────┬───────────────────────────────────┐
 *   │ AÇÕES DA SECRETARIA      │ TRIAGEM INTELIGENTE               │
 *   │                          │ Aqui é uma análise!               │
 *   │ • Triagem Inteligente    │                                   │
 *   │   Varre e analisa tarefas│ [ Analisar tarefas ]              │
 *   │                          │ [ Analisar o processo ]           │
 *   │ • Perícias pAIdegua      │ [ Inserir etiquetas mágicas ]     │
 *   │   Organize a sua pauta   │                                   │
 *   └──────────────────────────┴───────────────────────────────────┘
 *
 * A coluna esquerda lista os dois "grupos de ação" (Triagem / Perícias)
 * como itens selecionáveis, cada um com título + subtítulo. A coluna
 * direita mostra o detalhe do grupo selecionado (título, subtítulo e
 * botões de ação). O primeiro grupo vem selecionado por padrão.
 *
 * As ações concretas vêm via callbacks; a lógica vive no orquestrador
 * (content.ts). "Criar pauta" abre uma aba dedicada.
 */

export interface TriagemPanelActions {
  onAnalisarTarefas: () => void;
  onAnalisarProcesso: () => void;
  onInserirEtiquetas: () => void;
  onAbrirPericias: () => void;
}

export interface TriagemPanelOptions {
  /**
   * Quando true, o painel do usuário do PJe está aberto na aba. Habilita
   * "Analisar tarefas" (Triagem) e "Criar pauta" (Perícias) — ambos
   * dependem da lista de tarefas do painel como ponto de partida.
   */
  isPainelUsuario: boolean;
  /**
   * Quando true, há autos digitais abertos. Habilita "Analisar o processo"
   * e "Inserir etiquetas mágicas".
   */
  isProcessoAberto: boolean;
  /**
   * Quando definido, restringe o painel a um único grupo — usado para abrir
   * a bolha diretamente no grupo correspondente ao botão clicado na toolbar
   * do sidebar ("Triagem Inteligente" → 'triagem';
   * "Perícias pAIdegua" → 'pericias'). Sem esse campo, todos os grupos
   * disponíveis aparecem (comportamento legado).
   */
  focusGroup?: 'triagem' | 'pericias';
}

const PANEL_CSS = `
.paidegua-triagem {
  display: grid;
  grid-template-columns: minmax(210px, 240px) 1fr;
  gap: 14px;
  align-items: stretch;
  min-height: 220px;
}

.paidegua-triagem__master {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
}

.paidegua-triagem__master-header {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--paidegua-text-muted);
  margin-bottom: 2px;
}

.paidegua-triagem__master-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  text-align: left;
  padding: 10px 11px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid var(--paidegua-border);
  border-left: 3px solid transparent;
  border-radius: var(--paidegua-radius-sm);
  color: var(--paidegua-text);
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease, transform 160ms ease;
}

.paidegua-triagem__master-item:hover {
  background: rgba(19, 81, 180, 0.06);
  border-color: var(--paidegua-border-strong);
}

.paidegua-triagem__master-item[aria-selected="true"] {
  background: rgba(19, 81, 180, 0.10);
  border-color: var(--paidegua-border-strong);
  border-left-color: var(--paidegua-primary);
}

.paidegua-triagem__master-item-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--paidegua-primary);
}

.paidegua-triagem__master-item-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--paidegua-primary);
  flex-shrink: 0;
}

.paidegua-triagem__master-item-subtitle {
  font-size: 11px;
  font-weight: 500;
  color: var(--paidegua-text-muted);
  line-height: 1.35;
  padding-left: 14px;
}

.paidegua-triagem__detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
}

.paidegua-triagem__detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--paidegua-primary);
}

.paidegua-triagem__detail-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--paidegua-primary);
  flex-shrink: 0;
}

.paidegua-triagem__detail-subtitle {
  font-size: 12px;
  font-weight: 500;
  color: var(--paidegua-text-muted);
  margin: -4px 0 2px;
  line-height: 1.35;
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

.paidegua-triagem__empty {
  font-size: 11px;
  font-weight: 400;
  color: var(--paidegua-text-muted);
  line-height: 1.35;
}

@media (max-width: 520px) {
  .paidegua-triagem {
    grid-template-columns: 1fr;
  }
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
  `,
  pauta: `
    <svg class="paidegua-triagem__action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      <rect x="4" y="7" width="16" height="14" rx="2"></rect>
      <path d="M9 12h6"></path>
      <path d="M9 16h4"></path>
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
  id: string;
  title: string;
  masterSubtitle: string;
  detailSubtitle: string;
  actions: ActionSpec[];
  emptyHint: string;
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

function renderDetail(detail: HTMLElement, group: GroupSpec): void {
  detail.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'paidegua-triagem__detail-header';
  const dot = document.createElement('span');
  dot.className = 'paidegua-triagem__detail-dot';
  const title = document.createElement('span');
  title.textContent = group.title;
  header.append(dot, title);
  detail.appendChild(header);

  const subtitle = document.createElement('div');
  subtitle.className = 'paidegua-triagem__detail-subtitle';
  subtitle.textContent = group.detailSubtitle;
  detail.appendChild(subtitle);

  if (group.actions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'paidegua-triagem__empty';
    empty.textContent = group.emptyHint;
    detail.appendChild(empty);
    return;
  }

  for (const action of group.actions) {
    detail.appendChild(buildActionButton(action));
  }
}

/**
 * Cria o painel de ações da secretaria como um nó solto, pronto para ser
 * anexado em qualquer container (tipicamente o `addCustomBubble` do chat).
 * Devolve o elemento; o ciclo de vida (remover, substituir) é do chamador.
 */
function buildGroups(
  actions: TriagemPanelActions,
  options: TriagemPanelOptions
): GroupSpec[] {
  const triagemActions: ActionSpec[] = [];
  if (options.isPainelUsuario) {
    triagemActions.push({
      icon: 'tarefas',
      label: 'Analisar tarefas',
      hint: 'Varre o painel e sugere o próximo passo para cada tarefa.',
      onClick: actions.onAnalisarTarefas
    });
  }
  if (options.isProcessoAberto) {
    triagemActions.push({
      icon: 'processo',
      label: 'Analisar o processo',
      hint: 'Lê os autos e destaca o que exige atenção da secretaria.',
      onClick: actions.onAnalisarProcesso
    });
    triagemActions.push({
      icon: 'etiquetas',
      label: 'Inserir etiquetas mágicas',
      hint: 'Aplica etiquetas com base no estado atual do processo.',
      onClick: actions.onInserirEtiquetas
    });
  }

  const periciasActions: ActionSpec[] = [];
  if (options.isPainelUsuario) {
    periciasActions.push({
      icon: 'pauta',
      label: 'Criar pauta',
      hint: 'Organiza os processos das tarefas de perícia em uma pauta por perito.',
      onClick: actions.onAbrirPericias
    });
  }

  const groups: GroupSpec[] = [
    {
      id: 'triagem',
      title: 'Triagem Inteligente',
      masterSubtitle: 'Varre e analisa tarefas e processos.',
      detailSubtitle: 'Aqui é uma análise!',
      actions: triagemActions,
      emptyHint:
        'Abra um processo dos autos digitais ou o painel do usuário do PJe ' +
        'para usar as ações de triagem.'
    }
  ];
  if (options.isPainelUsuario) {
    groups.push({
      id: 'pericias',
      title: 'Perícias pAIdegua',
      masterSubtitle: 'Organize a sua pauta por perito.',
      detailSubtitle: 'Organize aqui a sua pauta!',
      actions: periciasActions,
      emptyHint:
        'Abra o painel do usuário do PJe para organizar a pauta de perícias.'
    });
  }
  return groups;
}

/**
 * Renderiza um card que contém SOMENTE a seção "detalhe" (o lado direito
 * do antigo layout master-detail) — sem coluna master, sem lista de
 * grupos. Usado pelos botões do sidebar ("Triagem Inteligente" e
 * "Perícias pAIdegua"): cada botão é o seletor; o card mostra apenas as
 * ações do grupo selecionado.
 *
 * O chamador escolhe onde montar:
 *   - No painel do usuário: insere no `sidebar.body` substituindo o
 *     conteúdo anterior (sem feed).
 *   - Em uma janela de processo: encapsula em uma bolha do chat — aí o
 *     comportamento de feed fica herdado da timeline.
 *
 * Retorna o elemento pronto para inserir. Ciclo de vida (remover,
 * substituir) fica com o chamador.
 */
export function createTriagemPanel(
  shadow: ShadowRoot,
  actions: TriagemPanelActions,
  options: TriagemPanelOptions
): HTMLElement {
  ensureStyle(shadow);

  const groups = buildGroups(actions, options);
  const focus = options.focusGroup ?? 'triagem';
  const group = groups.find((g) => g.id === focus) ?? groups[0];

  const detail = document.createElement('section');
  detail.className = 'paidegua-triagem__detail';
  detail.dataset.focusGroup = group.id;
  renderDetail(detail, group);
  return detail;
}
