/**
 * Bolha-painel de resultado do "Inserir etiquetas mágicas" (Triagem
 * Inteligente — perfil Secretaria).
 *
 * Mostra:
 *   - Marcadores semânticos gerados pela LLM (chips) — o "por quê" dos
 *     matches BM25.
 *   - Lista de etiquetas sugestionáveis ranqueadas, com checkbox para o
 *     servidor escolher quais aplicar, barra de similaridade relativa ao
 *     top-1 e os marcadores que contribuíram (explicabilidade).
 *   - Botão "Copiar selecionadas" — abordagem inicial até que a aplicação
 *     via API REST do PJe seja mapeada. Copia o `nomeTag` das etiquetas
 *     marcadas para o clipboard, separadas por quebra de linha.
 *
 * Estado vazio:
 *   - Sem etiquetas sugestionáveis configuradas OU sem matches: mostra
 *     mensagem orientando o usuário a revisar a aba "Etiquetas Inteligentes"
 *     do popup.
 */

import type { EtiquetaSugerida } from '../../shared/types';

export interface EtiquetasSugestoesBubbleActions {
  /**
   * Disparado quando o usuário clica em "Copiar selecionadas". Recebe a
   * lista (pode estar vazia se nenhuma marcada). O chamador cuida do
   * clipboard — deixamos aqui para facilitar trocar por "aplicar no PJe"
   * no futuro sem mexer na UI.
   */
  onCopiarSelecionadas: (etiquetas: EtiquetaSugerida[]) => void;
}

const BUBBLE_CSS = `
.paidegua-etqsug {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.paidegua-etqsug__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.paidegua-etqsug__title {
  font-size: 13px;
  font-weight: 700;
  color: var(--paidegua-primary-dark);
  line-height: 1.3;
}

.paidegua-etqsug__sub {
  font-size: 11.5px;
  color: var(--paidegua-text-muted);
  line-height: 1.45;
}

.paidegua-etqsug__markers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px;
  background: rgba(19, 81, 180, 0.06);
  border-left: 3px solid var(--paidegua-primary);
  border-radius: 4px;
}

.paidegua-etqsug__marker-label {
  display: block;
  width: 100%;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--paidegua-primary-dark);
  margin-bottom: 2px;
}

.paidegua-etqsug__marker {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  font-size: 11px;
  background: rgba(19, 81, 180, 0.12);
  color: var(--paidegua-primary-dark);
  border-radius: 999px;
  line-height: 1.4;
}

.paidegua-etqsug__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.paidegua-etqsug__item {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  gap: 10px;
  align-items: start;
  padding: 9px 11px;
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
  background: rgba(255, 255, 255, 0.95);
}

.paidegua-etqsug__check {
  margin: 2px 0 0 0;
  width: 16px;
  height: 16px;
  accent-color: var(--paidegua-primary);
}

.paidegua-etqsug__body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.paidegua-etqsug__name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--paidegua-text);
  line-height: 1.3;
}

.paidegua-etqsug__fav {
  display: inline-block;
  margin-left: 6px;
  color: #d6a400;
  font-size: 11px;
}

.paidegua-etqsug__path {
  font-size: 11px;
  color: var(--paidegua-text-muted);
  line-height: 1.3;
}

.paidegua-etqsug__reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.paidegua-etqsug__reason {
  font-size: 10.5px;
  color: var(--paidegua-text-muted);
  padding: 1px 6px;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 999px;
}

.paidegua-etqsug__score {
  flex-shrink: 0;
  min-width: 64px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  padding-top: 1px;
}

.paidegua-etqsug__score-pct {
  font-size: 11px;
  font-weight: 700;
  color: var(--paidegua-primary-dark);
}

.paidegua-etqsug__bar {
  width: 60px;
  height: 4px;
  background: rgba(19, 81, 180, 0.12);
  border-radius: 2px;
  overflow: hidden;
}

.paidegua-etqsug__bar-fill {
  height: 100%;
  background: var(--paidegua-primary);
}

.paidegua-etqsug__empty {
  padding: 14px;
  text-align: center;
  font-size: 12px;
  color: var(--paidegua-text-muted);
  border: 1px dashed var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
  line-height: 1.5;
}

.paidegua-etqsug__footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}

.paidegua-etqsug__hint {
  font-size: 11px;
  color: var(--paidegua-text-muted);
  line-height: 1.4;
}

.paidegua-etqsug__cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--paidegua-primary);
  color: #fff;
  border: 0;
  border-radius: var(--paidegua-radius-sm);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 160ms ease, transform 160ms ease;
}

.paidegua-etqsug__cta:hover:not(:disabled) {
  background: var(--paidegua-primary-dark);
  transform: translateY(-1px);
}

.paidegua-etqsug__cta:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
`;

function ensureStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector('style[data-paidegua="etqsug"]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-paidegua', 'etqsug');
  style.textContent = BUBBLE_CSS;
  shadow.appendChild(style);
}

function buildMarkersBlock(markers: readonly string[]): HTMLElement | null {
  if (!markers || markers.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.className = 'paidegua-etqsug__markers';
  const label = document.createElement('span');
  label.className = 'paidegua-etqsug__marker-label';
  label.textContent = 'Marcadores extraídos pela IA';
  wrap.append(label);
  for (const m of markers) {
    const chip = document.createElement('span');
    chip.className = 'paidegua-etqsug__marker';
    chip.textContent = m;
    wrap.append(chip);
  }
  return wrap;
}

function buildItem(
  match: EtiquetaSugerida,
  selectedSet: Set<number>,
  onToggle: () => void
): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'paidegua-etqsug__item';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'paidegua-etqsug__check';
  cb.checked = selectedSet.has(match.id);
  cb.setAttribute('aria-label', `Selecionar etiqueta ${match.nomeTag}`);
  cb.addEventListener('change', () => {
    if (cb.checked) selectedSet.add(match.id);
    else selectedSet.delete(match.id);
    onToggle();
  });

  const body = document.createElement('div');
  body.className = 'paidegua-etqsug__body';

  const name = document.createElement('span');
  name.className = 'paidegua-etqsug__name';
  name.textContent = match.nomeTag;
  if (match.favorita) {
    const fav = document.createElement('span');
    fav.className = 'paidegua-etqsug__fav';
    fav.textContent = '★';
    fav.title = 'Etiqueta favorita no PJe';
    name.append(fav);
  }
  body.append(name);

  if (match.nomeTagCompleto && match.nomeTagCompleto !== match.nomeTag) {
    const path = document.createElement('span');
    path.className = 'paidegua-etqsug__path';
    path.textContent = match.nomeTagCompleto;
    body.append(path);
  }

  if (match.matchedMarkers && match.matchedMarkers.length > 0) {
    const reasons = document.createElement('div');
    reasons.className = 'paidegua-etqsug__reasons';
    for (const r of match.matchedMarkers) {
      const span = document.createElement('span');
      span.className = 'paidegua-etqsug__reason';
      span.textContent = r;
      reasons.append(span);
    }
    body.append(reasons);
  }

  const score = document.createElement('div');
  score.className = 'paidegua-etqsug__score';
  const pct = document.createElement('span');
  pct.className = 'paidegua-etqsug__score-pct';
  pct.textContent = `${Math.max(0, Math.min(100, match.similarity))}%`;
  const bar = document.createElement('div');
  bar.className = 'paidegua-etqsug__bar';
  const fill = document.createElement('div');
  fill.className = 'paidegua-etqsug__bar-fill';
  fill.style.width = `${Math.max(0, Math.min(100, match.similarity))}%`;
  bar.append(fill);
  score.append(pct, bar);

  li.append(cb, body, score);
  return li;
}

/**
 * Monta o nó da bolha de sugestões de etiquetas. O chamador (content.ts)
 * anexa ao timeline via `chat.addCustomBubble`.
 *
 * `matches` pode vir vazio (nenhuma etiqueta sugestionável ou nenhum match
 * BM25 acima do limiar) — nesse caso é exibido um estado vazio orientando
 * o usuário a revisar a configuração.
 */
export function createEtiquetasSugestoesBubble(
  shadow: ShadowRoot,
  markers: readonly string[],
  matches: readonly EtiquetaSugerida[],
  actions: EtiquetasSugestoesBubbleActions
): HTMLElement {
  ensureStyle(shadow);

  const root = document.createElement('div');
  root.className = 'paidegua-etqsug';

  const header = document.createElement('div');
  header.className = 'paidegua-etqsug__header';
  const title = document.createElement('span');
  title.className = 'paidegua-etqsug__title';
  title.textContent = 'Etiquetas sugeridas';
  header.append(title);
  root.append(header);

  const sub = document.createElement('div');
  sub.className = 'paidegua-etqsug__sub';
  sub.textContent =
    matches.length > 0
      ? `${matches.length} etiqueta(s) sugestionável(is) ranqueada(s) pelo de-para semântico contra os marcadores abaixo. Marque as que deseja aplicar.`
      : 'Nenhuma etiqueta sugestionável casou com os marcadores gerados pela IA.';
  root.append(sub);

  const markersBlock = buildMarkersBlock(markers);
  if (markersBlock) root.append(markersBlock);

  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'paidegua-etqsug__empty';
    empty.textContent =
      'Abra o popup da extensão, aba "Etiquetas Inteligentes", baixe o catálogo e marque as etiquetas que devem ser sugestionáveis — o de-para precisa de um subconjunto para filtrar o ruído.';
    root.append(empty);
    return root;
  }

  const selectedSet = new Set<number>();
  // Pré-seleção: o top-1 começa marcado (ganho mais óbvio de ergonomia;
  // o servidor ainda decide antes de clicar em "Copiar selecionadas").
  if (matches[0]) selectedSet.add(matches[0].id);

  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'paidegua-etqsug__cta';

  function refreshCtaLabel(): void {
    cta.disabled = selectedSet.size === 0;
    cta.textContent =
      selectedSet.size === 0
        ? 'Copiar selecionadas'
        : `Copiar ${selectedSet.size} selecionada(s)`;
  }

  const list = document.createElement('ul');
  list.className = 'paidegua-etqsug__list';
  for (const m of matches) {
    list.append(buildItem(m, selectedSet, refreshCtaLabel));
  }
  root.append(list);

  const footer = document.createElement('div');
  footer.className = 'paidegua-etqsug__footer';

  const hint = document.createElement('div');
  hint.className = 'paidegua-etqsug__hint';
  hint.textContent =
    'Nesta versão inicial as etiquetas selecionadas são copiadas para a área de transferência; cole-as no campo de etiquetas do processo no PJe. A aplicação automática via API será habilitada em breve.';

  cta.addEventListener('click', (event) => {
    event.preventDefault();
    const chosen = matches.filter((m) => selectedSet.has(m.id));
    actions.onCopiarSelecionadas(chosen);
  });

  refreshCtaLabel();
  footer.append(hint, cta);
  root.append(footer);

  return root;
}
