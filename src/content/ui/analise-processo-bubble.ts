/**
 * Bolha-painel de resultado do "Analisar o processo" (perfil Secretaria).
 *
 * Mostra:
 *   - Cabeçalho com um selo de veredito (verde / amarelo / vermelho).
 *   - Panorama curto (1-2 frases) vindo do LLM.
 *   - Lista de critérios, cada um com indicador de atendimento + bloco
 *     colapsável com a justificativa e, quando for o caso, a providência
 *     sugerida para entrar no ato de emenda à inicial.
 *   - Rodapé com o botão "Gerar ato de emenda à inicial", exibido apenas
 *     quando há ao menos um critério não atendido.
 *
 * O ciclo de vida fica com o chamador — esta função devolve o nó DOM;
 * `content.ts` anexa via `chat.addCustomBubble`.
 */

import type {
  AnaliseCriterio,
  AnaliseProcessoResult
} from '../../shared/types';

export interface AnaliseProcessoBubbleActions {
  /**
   * Disparado quando o usuário clica em "Gerar ato de emenda à inicial".
   * Recebe as providências na ordem em que aparecem na análise (apenas
   * de critérios com `atendido === false`). O chamador é responsável por
   * chamar o fluxo de minuta existente.
   */
  onGerarEmenda: (providencias: string[]) => void;
}

const BUBBLE_CSS = `
.paidegua-analise {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.paidegua-analise__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.paidegua-analise__badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

.paidegua-analise__badge--ok {
  background: rgba(22, 160, 90, 0.12);
  color: #14713f;
  border: 1px solid rgba(22, 160, 90, 0.35);
}

.paidegua-analise__badge--partial {
  background: rgba(219, 154, 4, 0.12);
  color: #8a5a00;
  border: 1px solid rgba(219, 154, 4, 0.4);
}

.paidegua-analise__badge--fail {
  background: rgba(200, 48, 48, 0.12);
  color: #8a1a1a;
  border: 1px solid rgba(200, 48, 48, 0.35);
}

.paidegua-analise__title {
  font-size: 13px;
  font-weight: 700;
  color: var(--paidegua-primary-dark);
  line-height: 1.3;
}

.paidegua-analise__panorama {
  font-size: 12.5px;
  color: var(--paidegua-text);
  line-height: 1.45;
  padding: 10px 12px;
  background: rgba(19, 81, 180, 0.06);
  border-left: 3px solid var(--paidegua-primary);
  border-radius: 4px;
}

.paidegua-analise__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.paidegua-analise__item {
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
  background: rgba(255, 255, 255, 0.95);
  overflow: hidden;
}

.paidegua-analise__item-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 11px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--paidegua-text);
  font-weight: 500;
}

.paidegua-analise__item-head:hover {
  background: rgba(19, 81, 180, 0.05);
}

.paidegua-analise__item-icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
}

.paidegua-analise__item-icon--ok {
  background: #2a9a5a;
}

.paidegua-analise__item-icon--fail {
  background: #c83030;
}

.paidegua-analise__item-label {
  flex: 1;
  min-width: 0;
  line-height: 1.3;
}

.paidegua-analise__item-toggle {
  flex-shrink: 0;
  color: var(--paidegua-text-muted);
  font-size: 11px;
  transition: transform 160ms ease;
}

.paidegua-analise__item.is-open .paidegua-analise__item-toggle {
  transform: rotate(180deg);
}

.paidegua-analise__item-body {
  display: none;
  padding: 0 11px 10px 39px;
  font-size: 12px;
  color: var(--paidegua-text);
  line-height: 1.5;
}

.paidegua-analise__item.is-open .paidegua-analise__item-body {
  display: block;
}

.paidegua-analise__providencia {
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(219, 154, 4, 0.08);
  border-left: 3px solid rgba(219, 154, 4, 0.55);
  border-radius: 4px;
  font-size: 11.5px;
}

.paidegua-analise__providencia-label {
  display: block;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  color: #8a5a00;
  margin-bottom: 3px;
}

.paidegua-analise__footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}

.paidegua-analise__footer-hint {
  font-size: 11px;
  color: var(--paidegua-text-muted);
  line-height: 1.4;
}

.paidegua-analise__cta {
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

.paidegua-analise__cta:hover:not(:disabled) {
  background: var(--paidegua-primary-dark);
  transform: translateY(-1px);
}

.paidegua-analise__cta:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
`;

const VEREDITO_PRESET: Record<
  AnaliseProcessoResult['veredito'],
  { badgeClass: string; badgeText: string; title: string }
> = {
  atendido: {
    badgeClass: 'paidegua-analise__badge--ok',
    badgeText: 'Atendido',
    title: 'Todos os critérios de admissibilidade estão satisfeitos.'
  },
  parcialmente: {
    badgeClass: 'paidegua-analise__badge--partial',
    badgeText: 'Parcial',
    title: 'Há critérios não atendidos que exigem emenda à inicial.'
  },
  nao_atendido: {
    badgeClass: 'paidegua-analise__badge--fail',
    badgeText: 'Não atendido',
    title: 'Os critérios de admissibilidade não estão satisfeitos.'
  }
};

function ensureStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector('style[data-paidegua="analise-processo"]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-paidegua', 'analise-processo');
  style.textContent = BUBBLE_CSS;
  shadow.appendChild(style);
}

function buildCriterioItem(c: AnaliseCriterio, openByDefault: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'paidegua-analise__item';
  if (openByDefault) li.classList.add('is-open');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'paidegua-analise__item-head';

  const icon = document.createElement('span');
  icon.className =
    'paidegua-analise__item-icon ' +
    (c.atendido
      ? 'paidegua-analise__item-icon--ok'
      : 'paidegua-analise__item-icon--fail');
  icon.textContent = c.atendido ? '✓' : '✕';
  icon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'paidegua-analise__item-label';
  label.textContent = c.label;

  const toggle = document.createElement('span');
  toggle.className = 'paidegua-analise__item-toggle';
  toggle.textContent = '▾';
  toggle.setAttribute('aria-hidden', 'true');

  head.append(icon, label, toggle);
  head.addEventListener('click', (event) => {
    event.preventDefault();
    li.classList.toggle('is-open');
  });

  const body = document.createElement('div');
  body.className = 'paidegua-analise__item-body';

  const justif = document.createElement('div');
  justif.className = 'paidegua-analise__item-justif';
  justif.textContent = c.justificativa || '(sem justificativa fornecida pelo modelo)';
  body.append(justif);

  if (!c.atendido && c.providenciaSolicitada) {
    const prov = document.createElement('div');
    prov.className = 'paidegua-analise__providencia';
    const tag = document.createElement('span');
    tag.className = 'paidegua-analise__providencia-label';
    tag.textContent = 'Providência sugerida';
    const txt = document.createElement('span');
    txt.textContent = c.providenciaSolicitada;
    prov.append(tag, txt);
    body.append(prov);
  }

  li.append(head, body);
  return li;
}

/**
 * Monta o nó da bolha de resultado. Não anexa em lugar nenhum — o chamador
 * (content.ts) usa `chat.addCustomBubble` para inserir na timeline.
 */
export function createAnaliseProcessoBubble(
  shadow: ShadowRoot,
  result: AnaliseProcessoResult,
  actions: AnaliseProcessoBubbleActions
): HTMLElement {
  ensureStyle(shadow);

  const root = document.createElement('div');
  root.className = 'paidegua-analise';

  const preset = VEREDITO_PRESET[result.veredito];

  const header = document.createElement('div');
  header.className = 'paidegua-analise__header';
  const badge = document.createElement('span');
  badge.className = `paidegua-analise__badge ${preset.badgeClass}`;
  badge.textContent = preset.badgeText;
  const title = document.createElement('span');
  title.className = 'paidegua-analise__title';
  title.textContent = preset.title;
  header.append(badge, title);
  root.append(header);

  if (result.panorama) {
    const panorama = document.createElement('div');
    panorama.className = 'paidegua-analise__panorama';
    panorama.textContent = result.panorama;
    root.append(panorama);
  }

  const list = document.createElement('ul');
  list.className = 'paidegua-analise__list';
  for (const c of result.criterios) {
    // Critérios não atendidos começam abertos — é o que o usuário precisa ler.
    list.append(buildCriterioItem(c, !c.atendido));
  }
  root.append(list);

  const naoAtendidos = result.criterios.filter(
    (c) => !c.atendido && (c.providenciaSolicitada ?? '').trim()
  );
  if (naoAtendidos.length > 0) {
    const footer = document.createElement('div');
    footer.className = 'paidegua-analise__footer';

    const hint = document.createElement('div');
    hint.className = 'paidegua-analise__footer-hint';
    hint.textContent =
      `${naoAtendidos.length} critério(s) não atendido(s). Gere o ato de emenda ` +
      `à inicial com as providências sugeridas — o rascunho aparecerá aqui no chat ` +
      `e poderá ser inserido diretamente no editor do PJe.`;

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'paidegua-analise__cta';
    cta.textContent = 'Gerar ato de emenda à inicial';
    cta.addEventListener('click', (event) => {
      event.preventDefault();
      cta.disabled = true;
      cta.textContent = 'Gerando…';
      const providencias = naoAtendidos
        .map((c) => (c.providenciaSolicitada ?? '').trim())
        .filter((p) => p.length > 0);
      actions.onGerarEmenda(providencias);
    });

    footer.append(hint, cta);
    root.append(footer);
  }

  return root;
}
