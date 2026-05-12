/**
 * Modal de pré-configuração da feature "Resumo dos processos da pauta"
 * (AUD-10), renderizado no shadow root da sidebar do paidegua.
 *
 * UX: ao clicar "Resumo dos processos da pauta" no card-detalhe do botão
 * Audiência, este modal abre SOBRE o PJe (sem trocar de aba) com:
 *   - Data De / Até
 *   - Checkboxes de situações (Designada+Redesignada pré-marcadas)
 *   - Botões "Cancelar" / "Buscar pauta"
 *
 * Ao confirmar, o caller (`handleAbrirResumoPauta` em `content.ts`)
 * recebe os parâmetros e dispara a abertura da aba dedicada já com a
 * busca pronta — a aba pula o seletor interno e vai direto pro estado
 * de progresso/resultado.
 *
 * Promise-based: a função devolve `{dataDe, dataAte, situacoes}` no
 * confirmar ou `null` no cancelar/Esc/clique fora.
 */

export type SituacaoCodigo = 'M' | 'C' | 'R' | 'F' | 'N' | 'D';

export interface ResumoPautaConfig {
  /** Data De no formato `DD/MM/YYYY`. */
  dataDe: string;
  /** Data Até no formato `DD/MM/YYYY`. */
  dataAte: string;
  /** Situações marcadas. */
  situacoes: SituacaoCodigo[];
}

const MODAL_CSS = `
.paidegua-resumo-config-backdrop {
  position: fixed; inset: 0; z-index: 2147483646;
  background: rgba(12, 50, 111, 0.42);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  pointer-events: auto;
  display: flex; align-items: center; justify-content: center;
}

.paidegua-resumo-config-dialog {
  width: min(560px, 92vw);
  background: #fff;
  border-radius: var(--paidegua-radius);
  box-shadow: 0 24px 60px rgba(12, 50, 111, 0.32);
  font-family: var(--paidegua-font);
  font-size: var(--paidegua-font-size-base);
  color: var(--paidegua-text);
  display: flex; flex-direction: column;
  overflow: hidden;
}

.paidegua-resumo-config__header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; padding: 18px 22px 14px;
  border-bottom: 1px solid var(--paidegua-border);
  background: linear-gradient(180deg, rgba(255,255,255,1), rgba(244,247,252,0.7));
}
.paidegua-resumo-config__title {
  margin: 0; font-size: 16px; font-weight: 700;
  color: var(--paidegua-primary-dark); line-height: 1.2;
}
.paidegua-resumo-config__subtitle {
  margin: 4px 0 0; font-size: 12px;
  color: var(--paidegua-text-muted); line-height: 1.45;
}
.paidegua-resumo-config__close {
  background: rgba(19, 81, 180, 0.06);
  color: var(--paidegua-primary-dark);
  width: 30px; height: 30px; border-radius: 8px;
  border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; line-height: 1; flex-shrink: 0;
  transition: background-color 160ms ease, transform 160ms ease;
}
.paidegua-resumo-config__close:hover {
  background: rgba(19, 81, 180, 0.14);
  transform: rotate(90deg);
}

.paidegua-resumo-config__body {
  padding: 18px 22px;
  display: flex; flex-direction: column; gap: 16px;
}

.paidegua-resumo-config__group h4 {
  margin: 0 0 6px; font-size: 12px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.4px;
  color: var(--paidegua-primary-dark);
}

.paidegua-resumo-config__datas {
  display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
}
.paidegua-resumo-config__campo {
  display: flex; flex-direction: column; gap: 4px;
}
.paidegua-resumo-config__campo label {
  font-size: 12px; color: var(--paidegua-text-muted);
}
.paidegua-resumo-config__input {
  font-family: inherit; font-size: 14px;
  padding: 8px 10px; border-radius: var(--paidegua-radius-sm);
  border: 1px solid var(--paidegua-border-strong);
  background: #fff; color: var(--paidegua-text); width: 100%;
  transition: border-color 160ms ease, box-shadow 160ms ease;
  box-sizing: border-box;
}
.paidegua-resumo-config__input:focus {
  outline: none; border-color: var(--paidegua-primary);
  box-shadow: 0 0 0 3px rgba(19, 81, 180, 0.16);
}

.paidegua-resumo-config__situacoes {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 4px 12px;
}
.paidegua-resumo-config__chk {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 6px; border-radius: 4px; cursor: pointer;
  font-size: 13px; color: var(--paidegua-text);
  user-select: none;
}
.paidegua-resumo-config__chk:hover { background: rgba(19,81,180,0.05); }
.paidegua-resumo-config__chk input { margin: 0; cursor: pointer; }

.paidegua-resumo-config__erro {
  padding: 8px 12px; margin-top: -6px;
  border-radius: var(--paidegua-radius-sm);
  background: rgba(192, 57, 43, 0.08);
  color: #b03030; font-size: 12px;
  border-left: 3px solid #c0392b;
}

.paidegua-resumo-config__footer {
  padding: 14px 22px 18px;
  border-top: 1px solid var(--paidegua-border);
  background: rgba(244,247,252,0.55);
  display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;
}
.paidegua-resumo-config__btn {
  font-family: inherit; font-size: 13px;
  padding: 8px 14px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--paidegua-border-strong);
  background: #fff; color: var(--paidegua-primary-dark);
  transition: background-color 160ms ease, transform 160ms ease;
}
.paidegua-resumo-config__btn:hover {
  background: rgba(19, 81, 180, 0.06);
  border-color: var(--paidegua-primary);
}
.paidegua-resumo-config__btn--primary,
.paidegua-resumo-config__btn--primary:hover,
.paidegua-resumo-config__btn--primary:focus,
.paidegua-resumo-config__btn--primary:active {
  /* Gradient inline (sem var) + !important pra blindar contra a regra */
  /* base .btn:hover, que sobrescreve background com quase-branco e quebra */
  /* o visual primário (texto branco em fundo branco = invisível). */
  background: linear-gradient(135deg, #1351B4 0%, #0C326F 100%) !important;
  border-color: transparent !important;
  color: #fff !important;
}
.paidegua-resumo-config__btn--primary {
  box-shadow: 0 6px 16px rgba(19, 81, 180, 0.28);
}
.paidegua-resumo-config__btn--primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 22px rgba(19, 81, 180, 0.36);
  filter: brightness(1.08);
}
`;

interface SituacaoOption {
  value: SituacaoCodigo;
  label: string;
  defaultChecked?: boolean;
}

const SITUACOES: SituacaoOption[] = [
  { value: 'M', label: 'Designada', defaultChecked: true },
  { value: 'R', label: 'Redesignada', defaultChecked: true },
  { value: 'F', label: 'Realizada' },
  { value: 'N', label: 'Não-realizada' },
  { value: 'C', label: 'Cancelada' },
  { value: 'D', label: 'Convertida em diligência' }
];

function ensureStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector('style[data-paidegua="resumo-config-modal"]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-paidegua', 'resumo-config-modal');
  style.textContent = MODAL_CSS;
  shadow.appendChild(style);
}

/**
 * Renderiza o modal dentro do shadow root passado (tipicamente
 * `mountShell().shadow`). Devolve uma Promise que resolve com a
 * configuração escolhida ou `null` se o usuário cancelar.
 */
export function pedirConfiguracaoResumoPauta(
  shadow: ShadowRoot
): Promise<ResumoPautaConfig | null> {
  ensureStyle(shadow);

  return new Promise((resolve) => {
    const hoje = formatarDataIsoLocal(new Date());

    const backdrop = document.createElement('div');
    backdrop.className = 'paidegua-resumo-config-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'paidegua-resumo-config-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    dialog.innerHTML = `
      <header class="paidegua-resumo-config__header">
        <div>
          <h3 class="paidegua-resumo-config__title">Resumo dos processos da pauta</h3>
          <p class="paidegua-resumo-config__subtitle">
            Escolha o período e as situações de audiência. A consulta usa a
            <em>Pauta de audiência</em> nativa do PJe.
          </p>
        </div>
        <button type="button" class="paidegua-resumo-config__close" aria-label="Fechar">×</button>
      </header>
      <div class="paidegua-resumo-config__body">
        <div class="paidegua-resumo-config__group">
          <h4>Período</h4>
          <div class="paidegua-resumo-config__datas">
            <div class="paidegua-resumo-config__campo">
              <label for="paidegua-rc-de">De</label>
              <input id="paidegua-rc-de" class="paidegua-resumo-config__input" type="date" required />
            </div>
            <div class="paidegua-resumo-config__campo">
              <label for="paidegua-rc-ate">Até</label>
              <input id="paidegua-rc-ate" class="paidegua-resumo-config__input" type="date" required />
            </div>
          </div>
        </div>
        <div class="paidegua-resumo-config__group">
          <h4>Situações de audiência</h4>
          <div class="paidegua-resumo-config__situacoes" role="group" aria-label="Situações de audiência">
            ${SITUACOES.map(
              (s) => `
                <label class="paidegua-resumo-config__chk">
                  <input type="checkbox" name="situacao" value="${s.value}"${s.defaultChecked ? ' checked' : ''} />
                  <span>${s.label}</span>
                </label>
              `
            ).join('')}
          </div>
        </div>
        <div class="paidegua-resumo-config__erro" data-role="erro" hidden></div>
      </div>
      <footer class="paidegua-resumo-config__footer">
        <button type="button" class="paidegua-resumo-config__btn" data-role="cancelar">Cancelar</button>
        <button type="button" class="paidegua-resumo-config__btn paidegua-resumo-config__btn--primary" data-role="confirmar">
          Buscar pauta
        </button>
      </footer>
    `;

    backdrop.appendChild(dialog);
    shadow.appendChild(backdrop);

    const inputDe = dialog.querySelector<HTMLInputElement>('#paidegua-rc-de')!;
    const inputAte = dialog.querySelector<HTMLInputElement>('#paidegua-rc-ate')!;
    const erroBox = dialog.querySelector<HTMLElement>('[data-role="erro"]')!;
    const btnFechar = dialog.querySelector<HTMLButtonElement>(
      '.paidegua-resumo-config__close'
    )!;
    const btnCancelar = dialog.querySelector<HTMLButtonElement>(
      '[data-role="cancelar"]'
    )!;
    const btnConfirmar = dialog.querySelector<HTMLButtonElement>(
      '[data-role="confirmar"]'
    )!;

    inputDe.value = hoje;
    inputAte.value = hoje;
    inputDe.focus();

    const finalizar = (resultado: ResumoPautaConfig | null): void => {
      document.removeEventListener('keydown', onKeydown, true);
      backdrop.remove();
      resolve(resultado);
    };
    const onKeydown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        finalizar(null);
      } else if (ev.key === 'Enter') {
        // Enter dentro de input dispara confirmar.
        const t = ev.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t === btnConfirmar)) {
          ev.preventDefault();
          tentarConfirmar();
        }
      }
    };
    document.addEventListener('keydown', onKeydown, true);

    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) finalizar(null);
    });
    btnFechar.addEventListener('click', () => finalizar(null));
    btnCancelar.addEventListener('click', () => finalizar(null));

    inputDe.addEventListener('change', () => {
      if (inputAte.value && inputDe.value && inputAte.value < inputDe.value) {
        inputAte.value = inputDe.value;
      }
    });

    function lerSituacoes(): SituacaoCodigo[] {
      const checks = dialog.querySelectorAll<HTMLInputElement>(
        'input[name="situacao"]:checked'
      );
      const out: SituacaoCodigo[] = [];
      for (const c of Array.from(checks)) {
        const v = c.value as SituacaoCodigo;
        if (
          v === 'M' || v === 'C' || v === 'R' ||
          v === 'F' || v === 'N' || v === 'D'
        ) {
          out.push(v);
        }
      }
      return out;
    }

    function exibirErro(msg: string): void {
      erroBox.textContent = msg;
      erroBox.hidden = false;
    }
    function limparErro(): void {
      erroBox.textContent = '';
      erroBox.hidden = true;
    }

    function tentarConfirmar(): void {
      limparErro();
      const dataDeIso = inputDe.value.trim();
      const dataAteIso = inputAte.value.trim();
      if (!dataDeIso || !dataAteIso) {
        exibirErro('Informe as duas datas (de e até).');
        return;
      }
      if (dataAteIso < dataDeIso) {
        exibirErro('A data "até" não pode ser anterior à data "de".');
        return;
      }
      const situacoes = lerSituacoes();
      if (situacoes.length === 0) {
        exibirErro('Marque ao menos uma situação de audiência.');
        return;
      }
      finalizar({
        dataDe: ptBrFromIso(dataDeIso),
        dataAte: ptBrFromIso(dataAteIso),
        situacoes
      });
    }

    btnConfirmar.addEventListener('click', tentarConfirmar);
  });
}

function formatarDataIsoLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function ptBrFromIso(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}
