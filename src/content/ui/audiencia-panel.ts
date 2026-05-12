/**
 * Painel inline de Ações da "Audiência pAIdegua" (perfil Secretaria).
 *
 * Substitui o comportamento antigo, em que clicar no botão "Audiência
 * pAIdegua" da sidebar abria diretamente uma nova aba (`audiencia-painel/
 * painel.html`). Agora o clique renderiza um card-detalhe na coluna direita
 * (mesmo padrão visual do `triagem-panel.ts`), oferecendo duas escolhas:
 *
 *   • Monte a pauta de audiência   → fluxo legado (abre painel.html)
 *   • Resumo dos processos da pauta → nova aba `audiencia-resumo/resumo.html`
 *
 * Estilo, classes e markup são propositalmente isolados (prefixo
 * `paidegua-audiencia__*`) para não acoplar com o painel da Triagem —
 * cada feature gerencia o próprio estado visual.
 */
export interface AudienciaPanelActions {
  onMontarPauta: () => void;
  onResumoPauta: () => void;
}

export interface AudienciaPanelOptions {
  /**
   * Quando true, o painel do usuário do PJe está aberto. Ambas as ações
   * dependem da varredura das tarefas do painel (designar audiência /
   * filtragem por data); fora dele, o card mostra um aviso contextual.
   */
  isPainelUsuario: boolean;
}

const PANEL_CSS = `
.paidegua-audiencia__detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
}

.paidegua-audiencia__detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--paidegua-primary);
}

.paidegua-audiencia__detail-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--paidegua-primary);
  flex-shrink: 0;
}

.paidegua-audiencia__detail-subtitle {
  font-size: 12px;
  font-weight: 500;
  color: var(--paidegua-text-muted);
  margin: -4px 0 2px;
  line-height: 1.35;
}

.paidegua-audiencia__action {
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

.paidegua-audiencia__action:hover:not(:disabled) {
  background: rgba(19, 81, 180, 0.08);
  border-color: var(--paidegua-border-strong);
  transform: translateY(-1px);
}

.paidegua-audiencia__action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.paidegua-audiencia__action-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--paidegua-primary);
}

.paidegua-audiencia__action-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.paidegua-audiencia__action-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--paidegua-primary-dark);
  line-height: 1.2;
}

.paidegua-audiencia__action-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--paidegua-text-muted);
  line-height: 1.35;
}

.paidegua-audiencia__empty {
  font-size: 11px;
  font-weight: 400;
  color: var(--paidegua-text-muted);
  line-height: 1.35;
}
`;

const ICONS = {
  pauta: `
    <svg class="paidegua-audiencia__action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      <rect x="4" y="7" width="16" height="14" rx="2"></rect>
      <path d="M9 12h6"></path>
      <path d="M9 16h4"></path>
    </svg>
  `,
  resumo: `
    <svg class="paidegua-audiencia__action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="8" y1="13" x2="16" y2="13"></line>
      <line x1="8" y1="17" x2="13" y2="17"></line>
    </svg>
  `
};

interface ActionSpec {
  icon: keyof typeof ICONS;
  label: string;
  hint?: string;
  onClick: () => void;
}

function ensureStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector('style[data-paidegua="audiencia-panel"]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-paidegua', 'audiencia-panel');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);
}

function buildActionButton(action: ActionSpec): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-audiencia__action';
  btn.innerHTML = `
    ${ICONS[action.icon]}
    <span class="paidegua-audiencia__action-body">
      <span class="paidegua-audiencia__action-label">${action.label}</span>
      ${action.hint ? `<span class="paidegua-audiencia__action-hint">${action.hint}</span>` : ''}
    </span>
  `;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    action.onClick();
  });
  return btn;
}

/**
 * Renderiza o card-detalhe da Audiência pAIdegua. O ciclo de vida (onde
 * inserir, quando substituir) fica com o chamador — tipicamente a sidebar
 * (painel do usuário) ou uma bolha do chat (janela de processo).
 */
export function createAudienciaPanel(
  shadow: ShadowRoot,
  actions: AudienciaPanelActions,
  options: AudienciaPanelOptions
): HTMLElement {
  ensureStyle(shadow);

  const detail = document.createElement('section');
  detail.className = 'paidegua-audiencia__detail';

  const header = document.createElement('div');
  header.className = 'paidegua-audiencia__detail-header';
  const dot = document.createElement('span');
  dot.className = 'paidegua-audiencia__detail-dot';
  const title = document.createElement('span');
  title.textContent = 'Audiência pAIdegua';
  header.append(dot, title);
  detail.appendChild(header);

  const subtitle = document.createElement('div');
  subtitle.className = 'paidegua-audiencia__detail-subtitle';
  subtitle.textContent = 'Agilize sua parte nas audiências!';
  detail.appendChild(subtitle);

  if (!options.isPainelUsuario) {
    const empty = document.createElement('div');
    empty.className = 'paidegua-audiencia__empty';
    empty.textContent =
      'Abra o painel do usuário do PJe para usar as ações da Audiência pAIdegua.';
    detail.appendChild(empty);
    return detail;
  }

  const acoes: ActionSpec[] = [
    {
      icon: 'pauta',
      label: 'Monte a pauta de audiência',
      hint: 'Agrupa os processos das tarefas de "Audiência - Designar" por advogado.',
      onClick: actions.onMontarPauta
    },
    {
      icon: 'resumo',
      label: 'Resumo dos processos da pauta',
      hint: 'Filtra a pauta por data e gera resumos dos processos com apoio de IA.',
      onClick: actions.onResumoPauta
    }
  ];

  for (const a of acoes) {
    detail.appendChild(buildActionButton(a));
  }

  return detail;
}
