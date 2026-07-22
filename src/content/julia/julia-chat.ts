/**
 * Superfície do "Fale com Júlia" dentro do chat — perfil **Gabinete**.
 *
 * Monta a conversa sobre o `ChatController` existente em vez de criar painel
 * próprio: reaproveita bolhas, streaming, markdown e histórico.
 *
 * ## O painel de evidência não é enfeite
 *
 * Antes do texto começar a chegar, o background emite `EVIDENCIA` com os números
 * reais da recuperação. Este módulo os renderiza numa bolha própria: universo
 * encontrado, quantos foram lidos, fontes e a lista de processos.
 *
 * O prompt também manda o modelo declarar a amostra — mas instrução de prompt é
 * probabilística. Este painel vem da recuperação e **não depende de o LLM
 * cooperar**. Se o modelo escrever "a unidade entende que X" sem ressalva, o
 * usuário ainda vê "4 de 312 lidas" logo acima. É a camada que não falha em
 * silêncio.
 *
 * ## Contexto da unidade: inferido, trocável
 *
 * O órgão sai do domínio institucional do usuário autenticado (jfce.jus.br →
 * JFCE). A **instância é palpite** — `pje1g` hospeda vara comum e JEF, e o
 * hostname não distingue —, então o chip fica visível e clicável. Assumir errado
 * em silêncio produziria "nenhum resultado" sem explicar o motivo.
 */

import {
  JULIA_ETAPA,
  JULIA_PORT_MSG,
  LOG_PREFIX,
  MESSAGE_CHANNELS,
  PORT_NAMES
} from '../../shared/constants';
import type { ProviderId } from '../../shared/constants';
import type {
  JuliaInstancia,
  JuliaInstanciaAutenticada,
  JuliaOrgao
} from '../../shared/julia/julia-types';
import {
  JULIA_INSTANCIA_AUTENTICADA_LABELS,
  JULIA_ORGAOS
} from '../../shared/julia/julia-types';
import type { ChatController } from '../ui/chat';

// ── Contexto da unidade ──────────────────────────────────────────

export interface JuliaContextoUnidade {
  orgao: JuliaOrgao;
  /**
   * Instâncias a consultar — **lista**, não valor único.
   *
   * Varas de **competência plena** têm acervo em `G1` e `JEF` ao mesmo tempo.
   * Escolher um dos eixos devolveria metade das decisões da unidade sem
   * qualquer sinal de que faltou algo — a resposta pareceria completa.
   */
  instancias: JuliaInstanciaAutenticada[];
  /** Unidades marcadas. Vazio = toda a seccional. */
  orgaosJulgadores: string[];
  /**
   * Consultar também a instância revisora.
   *
   * Escolha do usuário, não inferência do LLM: quando era derivada da redação
   * da pergunta, "como a vara vem decidindo…" desligava a comparação — e é ela
   * que dá o sinal mais útil da análise.
   */
  compararComRevisor: boolean;
  /**
   * Instâncias da API pública a consultar — só no modo `'publica'` (2º grau).
   * Sobrepõe a derivação por rito, que ali não se aplica.
   */
  instanciasPublicas?: JuliaInstancia[];
  /** `true` quando algum campo foi presumido — a interface deve sinalizar. */
  inferido: boolean;
}

const DOMINIO_PARA_ORGAO: Record<string, JuliaOrgao> = {
  'trf5.jus.br': 'TRF5',
  'jfal.jus.br': 'JFAL',
  'jfce.jus.br': 'JFCE',
  'jfpb.jus.br': 'JFPB',
  'jfpe.jus.br': 'JFPE',
  'jfrn.jus.br': 'JFRN',
  'jfse.jus.br': 'JFSE'
};

/**
 * Infere a unidade a partir do e-mail institucional do usuário autenticado.
 *
 * O órgão sai do domínio com confiança alta. A **instância não** — `pje1g`
 * atende vara comum e JEF no mesmo host, e nada no contexto do navegador
 * distingue. Assumimos `G1` e marcamos como inferido.
 *
 * Resolver isso de verdade exige cruzar a lotação do usuário com
 * `api/v1/orgaos-julgadores`, que só roda no background — melhoria natural,
 * mas que não deve atrasar a entrega: o chip trocável já cobre o caso.
 */
/**
 * Seccional usada quando o domínio não identifica nenhuma.
 *
 * É um chute, e por isso o contexto sai marcado como `inferido` e o formulário
 * traz o seletor de seccional visível. Sem essa saída, um servidor da Paraíba
 * cujo e-mail não fosse reconhecido receberia jurisprudência do Ceará sem
 * qualquer sinal de que estava consultando a seccional errada.
 */
const ORGAO_PADRAO: JuliaOrgao = 'JFCE';

export async function inferirContexto(): Promise<JuliaContextoUnidade> {
  // Padrão `G1 + JEF`: cobre a vara de competência plena, que tem acervo nos
  // dois eixos. Marcar só um erraria por omissão em toda unidade plena — e o
  // usuário não teria como perceber, porque a resposta viria completa em
  // aparência. Marcar os dois erra, no máximo, por excesso: uma vara sem JEF
  // devolve zero naquele eixo, e o painel de evidência mostra isso.
  const padrao: JuliaContextoUnidade = {
    orgao: ORGAO_PADRAO,
    instancias: ['G1', 'JEF'],
    orgaosJulgadores: [],
    compararComRevisor: true,
    instanciasPublicas: ['G2'],
    inferido: true
  };
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: MESSAGE_CHANNELS.AUTH_GET_STATUS
    })) as { email?: string } | undefined;

    const dominio = resp?.email?.split('@')[1]?.toLowerCase();
    const orgao = dominio ? DOMINIO_PARA_ORGAO[dominio] : undefined;
    // Domínio reconhecido é identificação, não palpite — daí `inferido: false`,
    // que remove o "(presumido)" do rótulo.
    return orgao ? { ...padrao, orgao, inferido: false } : padrao;
  } catch (err) {
    console.warn(`${LOG_PREFIX} julia: falha inferindo unidade:`, err);
    return padrao;
  }
}

// ── Painel de evidência ──────────────────────────────────────────

interface LadoEvidencia {
  fontes: string[];
  universo: number;
  universoEhTeto: boolean;
  lidos: number;
  descartados: number;
  falhasLeitura: number;
  indisponivel: string | null;
  processos: DocumentoCitado[];
}

export interface DocumentoCitado {
  /** Número da citação, contínuo entre os escopos — bate com o `[n]` da resposta. */
  n: number;
  numero: string | null;
  tipo: string | null;
  classe: string | null;
  orgaoJulgador: string | null;
  data: string | null;
  secao: string;
  /** Trecho lido — é o que a citação clicável exibe. */
  trecho: string;
  /** Documento completo, para o botão de cópia integral. */
  textoIntegral: string;
  dispositivo: string | null;
  /** Referência pronta para colar numa minuta. */
  referencia: string;
  urlPje: string | null;
  /** `false` quando o PJe daquela instância exige acesso que o usuário não tem. */
  podeAbrirNoPje: boolean;
}

interface Evidencia {
  unidade: LadoEvidencia | null;
  revisor: LadoEvidencia | null;
  comparacaoPossivel: boolean;
  dataIndice: string | null;
}

const SECAO_LABEL: Record<string, string> = {
  ementa: 'ementa',
  fundamentacao: 'fundamentação',
  integral: 'texto integral'
};

/**
 * Estilo do painel de evidência.
 *
 * A contagem (`__contagem`) é o elemento com maior peso visual do painel, e não
 * por capricho: é a informação que impede o usuário de ler a síntese como se
 * fosse censo do acervo. Se algo tiver de sobreviver a uma leitura rápida, é ela.
 */
const PANEL_CSS = `
.paidegua-julia {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
  line-height: 1.45;
}

.paidegua-julia__titulo {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 700;
  color: var(--paidegua-primary-dark);
}

.paidegua-julia__termo {
  color: var(--paidegua-text-muted);
  font-style: italic;
}

.paidegua-julia__lado {
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
  padding: 9px 11px;
  background: rgba(255, 255, 255, 0.6);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.paidegua-julia__lado-titulo {
  font-weight: 600;
  color: var(--paidegua-primary-dark);
}

.paidegua-julia__contagem {
  font-weight: 700;
  font-size: 13px;
}

.paidegua-julia__fontes,
.paidegua-julia__nota,
.paidegua-julia__vazio {
  color: var(--paidegua-text-muted);
  font-size: 11px;
}

.paidegua-julia__alerta {
  background: rgba(200, 120, 0, 0.10);
  border: 1px solid rgba(200, 120, 0, 0.30);
  border-radius: var(--paidegua-radius-sm);
  padding: 7px 10px;
  font-size: 11px;
}

.paidegua-julia__docs {
  margin: 2px 0 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.paidegua-julia__docs li { font-size: 11px; }

.paidegua-julia__docs a {
  color: var(--paidegua-primary-dark);
  text-decoration: none;
}

.paidegua-julia__docs a:hover { text-decoration: underline; }

/* Entrada da lista de fontes: abre o painel sobreposto, não o PJe. */
.paidegua-julia__doc-link {
  border: 0;
  background: transparent;
  padding: 0;
  font: inherit;
  font-size: 11px;
  color: var(--paidegua-primary-dark);
  cursor: pointer;
  text-align: left;
}

.paidegua-julia__doc-link:hover { text-decoration: underline; }

.paidegua-julia__og { color: var(--paidegua-text-muted); }

/* Citação clicável no corpo da resposta. Discreta: não deve competir com o
   texto, só sinalizar que há o documento por trás. */
.paidegua-julia__cit {
  display: inline;
  border: 0;
  background: rgba(19, 81, 180, 0.10);
  color: var(--paidegua-primary-dark);
  border-radius: 4px;
  padding: 0 5px;
  margin: 0 1px;
  font: inherit;
  font-size: 0.9em;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
}

.paidegua-julia__cit:hover {
  background: rgba(19, 81, 180, 0.20);
  text-decoration: underline;
}

/* ── Painel sobreposto do documento citado ── */

/* Espelha o padrão de modal do projeto (audiencia-resumo-config-modal.ts):
   mesmo z-index, mesmo backdrop e as variáveis de fonte no diálogo.
   O pointer-events: auto é indispensável — o contêiner da barra lateral usa
   none para manter o PJe clicável fora dela, e a sobreposição herdava isso.
   (Sem crases neste comentário: o CSS vive numa template literal.) */
.paidegua-julia-modal {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  background: rgba(12, 50, 111, 0.42);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
}

.paidegua-julia-modal__painel {
  pointer-events: auto;
  background: #fff;
  border-radius: var(--paidegua-radius);
  box-shadow: 0 24px 60px rgba(12, 50, 111, 0.32);
  width: min(760px, 92vw);
  max-height: min(85vh, 780px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: var(--paidegua-font);
  font-size: var(--paidegua-font-size-base);
  color: var(--paidegua-text);
}

.paidegua-julia-modal__cab {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--paidegua-border);
}

.paidegua-julia-modal__titulo {
  flex: 1;
  font-weight: 700;
  font-size: 15px;
  color: var(--paidegua-primary-dark);
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  word-break: break-all;
}

.paidegua-julia-modal__tag {
  background: rgba(19, 81, 180, 0.12);
  border-radius: 5px;
  padding: 1px 7px;
  font-size: 12px;
  flex: none;
}

.paidegua-julia-modal__fechar {
  background: rgba(19, 81, 180, 0.06);
  color: var(--paidegua-primary-dark);
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  line-height: 1;
  flex-shrink: 0;
  transition: background-color 160ms ease, transform 160ms ease;
}

.paidegua-julia-modal__fechar:hover {
  background: rgba(19, 81, 180, 0.14);
  transform: rotate(90deg);
}

.paidegua-julia-modal__meta {
  padding: 8px 16px 0;
  font-size: 11.5px;
  color: var(--paidegua-text-muted);
  line-height: 1.4;
}

.paidegua-julia-modal__acoes {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  padding: 12px 16px;
}

.paidegua-julia-modal__abas {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--paidegua-border);
}

.paidegua-julia-modal__aba {
  border: 0;
  background: transparent;
  padding: 8px 12px;
  font: inherit;
  font-size: 12px;
  color: var(--paidegua-text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.paidegua-julia-modal__aba.is-on {
  color: var(--paidegua-primary-dark);
  font-weight: 600;
  border-bottom-color: var(--paidegua-primary-dark);
}

.paidegua-julia-modal__corpo {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  white-space: pre-wrap;
  font-size: 12.5px;
  line-height: 1.55;
  scrollbar-width: thin;
}

.paidegua-julia-modal__rodape {
  padding: 10px 16px;
  border-top: 1px solid var(--paidegua-border);
  font-size: 12px;
}

.paidegua-julia-modal__rodape a { color: var(--paidegua-primary-dark); }

/* ── Formulário de consulta ── */

.paidegua-julia-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.paidegua-julia-form .paidegua-julia__titulo { margin-bottom: 1px; }

.paidegua-julia-form__hint {
  color: var(--paidegua-text-muted);
  font-size: 11px;
  line-height: 1.4;
}

.paidegua-julia-form__label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--paidegua-text-muted);
  margin-top: 5px;
}

.paidegua-julia-form__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.paidegua-julia-form__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--paidegua-border);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.7);
  user-select: none;
}

.paidegua-julia-form__chip.is-on {
  border-color: var(--paidegua-primary-dark);
  background: rgba(19, 81, 180, 0.09);
  color: var(--paidegua-primary-dark);
  font-weight: 600;
}

.paidegua-julia-form__chip input { margin: 0; cursor: pointer; }

.paidegua-julia-form__input,
.paidegua-julia-form__textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
  padding: 7px 9px;
  font: inherit;
  font-size: 12px;
  background: #fff;
  resize: vertical;
}

.paidegua-julia-form__lista {
  max-height: 150px;
  overflow-y: auto;
  border: 1px solid var(--paidegua-border);
  border-radius: var(--paidegua-radius-sm);
  padding: 5px 7px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 3px;
  scrollbar-width: thin;
}

.paidegua-julia-form__item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.3;
  cursor: pointer;
}

.paidegua-julia-form__item input { margin: 1px 0 0; flex: none; cursor: pointer; }

.paidegua-julia-form__acoes {
  display: flex;
  justify-content: flex-end;
  margin-top: 3px;
}

.paidegua-julia-form__acoes-esq {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}

.paidegua-julia-form__btn--ghost {
  background: transparent;
  color: var(--paidegua-primary-dark);
  border: 1px solid var(--paidegua-border);
}

.paidegua-julia-form__btn {
  border: 0;
  border-radius: var(--paidegua-radius-sm);
  padding: 7px 16px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: var(--paidegua-primary-dark);
  cursor: pointer;
}

.paidegua-julia-form__btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.paidegua-julia-form__aviso {
  color: #b45309;
  font-size: 11px;
  text-align: right;
}
`;

function ensureStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector('style[data-paidegua="julia-panel"]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-paidegua', 'julia-panel');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);
}

function el(tag: string, cls: string, texto?: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  if (texto) n.textContent = texto;
  return n;
}

function renderLado(
  lado: LadoEvidencia | null,
  titulo: string,
  /**
   * Abre o documento no painel sobreposto.
   *
   * A lista de fontes apontava para o PJe, o que exigia sessão na instalação
   * daquele grau — inviável no 2º grau para servidor de 1º. Com o popup, todo
   * caminho até a decisão usa o texto que já temos em mãos.
   */
  aoAbrir: (d: DocumentoCitado) => void
): HTMLElement {
  const box = el('div', 'paidegua-julia__lado');
  box.appendChild(el('div', 'paidegua-julia__lado-titulo', titulo));

  if (!lado) {
    box.appendChild(el('div', 'paidegua-julia__vazio', 'Não consultado.'));
    return box;
  }
  if (lado.indisponivel) {
    box.appendChild(
      el(
        'div',
        'paidegua-julia__alerta',
        lado.indisponivel === 'sessao'
          ? 'Indisponível — sessão da Júlia expirada.'
          : 'Indisponível — falha na consulta.'
      )
    );
    return box;
  }

  // A frase que sustenta a honestidade da amostra. Vem da recuperação.
  const universo = `${lado.universo}${lado.universoEhTeto ? '+' : ''}`;
  const resumo = `${lado.lidos} lida(s) de ${universo} encontrada(s)`;
  box.appendChild(el('div', 'paidegua-julia__contagem', resumo));

  if (lado.descartados > 0) {
    box.appendChild(
      el(
        'div',
        'paidegua-julia__nota',
        `${lado.descartados} não lida(s) por limite de espaço.`
      )
    );
  }
  // Separado do limite de espaço: falha de leitura tem outra causa (rede ou
  // sigilo) e outra correção. Somar os dois esconderia o diagnóstico.
  if (lado.falhasLeitura > 0) {
    box.appendChild(
      el(
        'div',
        'paidegua-julia__nota',
        `${lado.falhasLeitura} documento(s) sem inteiro teor acessível (falha ou sigilo).`
      )
    );
  }

  box.appendChild(
    el('div', 'paidegua-julia__fontes', `Fontes: ${lado.fontes.join(', ')}`)
  );

  const lista = el('ul', 'paidegua-julia__docs');
  lado.processos.forEach((p) => {
    const li = document.createElement('li');
    // Usa o número vindo do background, não o índice: a numeração é contínua
    // entre os escopos para casar com as citações da resposta.
    const rotulo = `[${p.n}] ${p.numero ?? 's/n'} · ${p.tipo ?? '—'} · ${SECAO_LABEL[p.secao] ?? p.secao}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'paidegua-julia__doc-link';
    btn.textContent = rotulo;
    btn.addEventListener('click', () => aoAbrir(p));
    li.appendChild(btn);
    if (p.orgaoJulgador) {
      li.appendChild(el('span', 'paidegua-julia__og', ` — ${p.orgaoJulgador}`));
    }
    lista.appendChild(li);
  });
  box.appendChild(lista);
  return box;
}

function renderEvidencia(
  ev: Evidencia,
  termo: string,
  aoAbrir: (d: DocumentoCitado) => void,
  /** No 2º grau não há confronto: o escopo é único e os rótulos mudam. */
  modo: 'dupla' | 'publica' = 'dupla'
): HTMLElement {
  const root = el('div', 'paidegua-julia');
  root.appendChild(el('div', 'paidegua-julia__titulo', 'Base consultada'));
  root.appendChild(el('div', 'paidegua-julia__termo', `Busca: "${termo}"`));

  if (modo === 'publica') {
    root.appendChild(renderLado(ev.revisor, 'Decisões encontradas', aoAbrir));
    if (ev.dataIndice) {
      root.appendChild(
        el(
          'div',
          'paidegua-julia__nota',
          `Índice da Júlia atualizado em ${ev.dataIndice.slice(0, 10).split('-').reverse().join('/')}.`
        )
      );
    }
    return root;
  }

  root.appendChild(renderLado(ev.unidade, 'Decisões da própria unidade', aoAbrir));
  root.appendChild(
    renderLado(ev.revisor, 'Decisões de quem revisa a unidade', aoAbrir)
  );

  if (!ev.comparacaoPossivel) {
    root.appendChild(
      el(
        'div',
        'paidegua-julia__alerta',
        'Não foi possível comparar a unidade com a instância revisora nesta consulta.'
      )
    );
  }
  if (ev.dataIndice) {
    root.appendChild(
      el(
        'div',
        'paidegua-julia__nota',
        `Índice da Júlia atualizado em ${ev.dataIndice.slice(0, 10).split('-').reverse().join('/')}. Decisões posteriores não constam.`
      )
    );
  }
  return root;
}

// ── Citações clicáveis ───────────────────────────────────────────

/**
 * Converte cada `[n]` do texto da resposta em botão.
 *
 * Feito no DOM depois do fim do streaming, e não por markdown no prompt: pedir
 * ao modelo que escrevesse `[[3](url)]` funcionava, mas poluía a leitura e
 * dependia de ele copiar a URL certa. Aqui o modelo escreve `[3]` limpo e o
 * comportamento do clique fica sob nosso controle.
 *
 * Percorre apenas nós de texto e ignora os que já estão dentro de link ou
 * código, para não reescrever citação que o próprio documento continha.
 */
function tornarCitacoesClicaveis(
  raiz: HTMLElement,
  aoClicar: (n: number) => void
): void {
  const walker = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
  const alvos: Text[] = [];
  for (let no = walker.nextNode(); no; no = walker.nextNode()) {
    const pai = no.parentElement;
    if (!pai || pai.closest('a, code, pre')) continue;
    if (/\[\d+\]/.test(no.nodeValue ?? '')) alvos.push(no as Text);
  }

  for (const no of alvos) {
    const partes = (no.nodeValue ?? '').split(/(\[\d+\])/g);
    const frag = document.createDocumentFragment();
    for (const parte of partes) {
      const m = /^\[(\d+)\]$/.exec(parte);
      if (!m) {
        frag.appendChild(document.createTextNode(parte));
        continue;
      }
      const n = Number(m[1]);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'paidegua-julia__cit';
      btn.textContent = String(n);
      btn.title = `Ver o documento ${n}`;
      btn.addEventListener('click', () => aoClicar(n));
      frag.appendChild(btn);
    }
    no.parentNode?.replaceChild(frag, no);
  }
}

/**
 * Botão de cópia com confirmação no próprio rótulo.
 *
 * Sem o retorno visual, copiar é ação sem evidência: a pessoa clica, nada
 * muda na tela, e ela clica de novo sem saber se funcionou.
 */
function botaoCopiar(
  rotulo: string,
  obterTexto: () => string,
  primario = false
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = primario
    ? 'paidegua-julia-form__btn'
    : 'paidegua-julia-form__btn paidegua-julia-form__btn--ghost';
  btn.textContent = rotulo;
  btn.addEventListener('click', () => {
    const texto = obterTexto();
    if (!texto.trim()) return;
    void navigator.clipboard
      .writeText(texto)
      .then(() => {
        btn.textContent = 'Copiado';
        window.setTimeout(() => (btn.textContent = rotulo), 1500);
      })
      .catch((err) => {
        console.warn(`${LOG_PREFIX} julia: falha ao copiar:`, err);
        btn.textContent = 'Falhou';
        window.setTimeout(() => (btn.textContent = rotulo), 1500);
      });
  });
  return btn;
}

/**
 * Painel sobreposto com o documento citado.
 *
 * Sobreposição, e não bolha no fio da conversa: consultar uma citação é ato
 * passageiro, e empilhar um documento a cada clique transformaria o chat num
 * depósito onde a própria resposta se perde. Aqui abre, consulta e fecha.
 *
 * Abas em vez de tudo empilhado porque o texto integral chega a 20 mil
 * caracteres — junto com o trecho e a referência, viraria uma parede de
 * rolagem.
 */
function abrirDocumento(shadow: ShadowRoot, d: DocumentoCitado): void {
  ensureStyle(shadow);

  const overlay = el('div', 'paidegua-julia-modal');
  const painel = el('div', 'paidegua-julia-modal__painel');
  overlay.appendChild(painel);

  const fechar = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', aoTeclar);
  };
  const aoTeclar = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') fechar();
  };
  document.addEventListener('keydown', aoTeclar);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) fechar();
  });

  // ── Cabeçalho
  const cab = el('div', 'paidegua-julia-modal__cab');
  const titulo = el('div', 'paidegua-julia-modal__titulo');
  titulo.appendChild(el('span', 'paidegua-julia-modal__tag', `[${d.n}]`));
  titulo.appendChild(
    document.createTextNode(d.numero ?? 'processo não informado')
  );
  cab.appendChild(titulo);

  const btnFechar = document.createElement('button');
  btnFechar.type = 'button';
  btnFechar.className = 'paidegua-julia-modal__fechar';
  btnFechar.setAttribute('aria-label', 'Fechar');
  btnFechar.textContent = '×';
  btnFechar.addEventListener('click', fechar);
  cab.appendChild(btnFechar);
  painel.appendChild(cab);

  const meta = [d.tipo, d.classe, d.orgaoJulgador, d.data]
    .filter(Boolean)
    .join(' · ');
  if (meta) painel.appendChild(el('div', 'paidegua-julia-modal__meta', meta));

  // ── Ações de cópia
  //
  // O rótulo acompanha a seção realmente extraída: em acórdão é ementa, em
  // sentença é fundamentação. Chamar as duas de "ementa" seria falso —
  // sentença não tem ementa, distinção que o segmentador já faz.
  const rotuloTrecho =
    d.secao === 'ementa'
      ? 'Copiar a ementa'
      : d.secao === 'fundamentacao'
        ? 'Copiar a fundamentação'
        : 'Copiar o trecho';

  /**
   * O trecho com a referência ao pé.
   *
   * É a unidade que se cola numa minuta: ementa seguida do julgado que a
   * originou. Separadas, obrigam a duas cópias e a montagem manual — e citação
   * sem referência não serve para fundamentar.
   */
  const trechoCitavel = d.referencia
    ? `${d.trecho.trim()}\n\n${d.referencia}`
    : d.trecho;

  const acoes = el('div', 'paidegua-julia-modal__acoes');
  // Copia o que está na tela: a aba mostra a referência ao pé, então a cópia
  // a inclui. Divergir disso surpreende quem confere antes de colar.
  acoes.appendChild(botaoCopiar(rotuloTrecho, () => trechoCitavel, true));
  acoes.appendChild(
    botaoCopiar('Copiar o texto completo', () => d.textoIntegral || d.trecho)
  );
  if (d.referencia) {
    acoes.appendChild(botaoCopiar('Copiar a referência', () => d.referencia));
  }
  painel.appendChild(acoes);

  // ── Abas
  const abas = el('div', 'paidegua-julia-modal__abas');
  const corpo = el('div', 'paidegua-julia-modal__corpo');

  // Ordem definida com o owner: Texto completo, o trecho analisado
  // (Fundamentação em sentença, Ementa em acórdão), Dispositivo e Referência.
  const rotuloAba = SECAO_LABEL[d.secao] ?? 'Trecho';
  const paineis: Array<{ rotulo: string; texto: string }> = [];

  if (d.textoIntegral && d.textoIntegral !== d.trecho) {
    paineis.push({ rotulo: 'Texto completo', texto: d.textoIntegral });
  }
  paineis.push({
    // SECAO_LABEL é minúsculo por vir de frase corrida ("trecho: ementa");
    // como título de aba precisa de inicial maiúscula.
    rotulo: rotuloAba.charAt(0).toUpperCase() + rotuloAba.slice(1),
    texto: trechoCitavel
  });
  // "Dispositivo" é o nome técnico da parte que decide — "desfecho" era
  // paráfrase minha, e num sistema para servidor da Justiça o termo do ofício
  // vale mais que a explicação.
  if (d.dispositivo) paineis.push({ rotulo: 'Dispositivo', texto: d.dispositivo });
  if (d.referencia) {
    paineis.push({ rotulo: 'Referência', texto: d.referencia });
  }

  const mostrar = (i: number): void => {
    corpo.textContent = paineis[i]?.texto ?? '';
    [...abas.children].forEach((b, j) =>
      b.classList.toggle('is-on', i === j)
    );
    corpo.scrollTop = 0;
  };

  paineis.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'paidegua-julia-modal__aba';
    b.textContent = p.rotulo;
    b.addEventListener('click', () => mostrar(i));
    abas.appendChild(b);
  });
  painel.appendChild(abas);
  painel.appendChild(corpo);
  mostrar(0);

  // Só onde o usuário tem acesso: o download do PJe exige sessão naquela
  // instalação, e servidor de 1º grau em regra não a tem no 2º.
  if (d.podeAbrirNoPje && d.urlPje) {
    const rodape = el('div', 'paidegua-julia-modal__rodape');
    const a = document.createElement('a');
    a.href = d.urlPje;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Abrir o documento no PJe';
    rodape.appendChild(a);
    painel.appendChild(rodape);
  }

  shadow.appendChild(overlay);
  btnFechar.focus();
}

// ── Execução ─────────────────────────────────────────────────────

const ETAPA_TEXTO: Record<string, string> = {
  [JULIA_ETAPA.EXTRAINDO]: 'Interpretando a pergunta…',
  [JULIA_ETAPA.BUSCANDO]: 'Consultando a Júlia…',
  [JULIA_ETAPA.LENDO]: 'Lendo os documentos…',
  [JULIA_ETAPA.SINTETIZANDO]: 'Analisando…'
};

export interface JuliaExecOpcoes {
  chat: ChatController;
  /** Shadow root da sidebar — destino do `<style>` do painel de evidência. */
  shadow: ShadowRoot;
  pergunta: string;
  contexto: JuliaContextoUnidade;
  provider: ProviderId;
  model: string;
  /**
   * `'publica'` no 2º grau do TRF5: a Júlia que serve àquele grau só consulta
   * o próprio 2º grau, que a API pública já cobre por inteiro. Sem escopo de
   * unidade, sem autenticação e sem confronto — ali não há instância revisora
   * dentro do acervo.
   */
  modo?: 'dupla' | 'publica';
  /** Termos escritos à mão; vazio deixa o background derivar da pergunta. */
  termosManuais?: string;
  /**
   * Análise preditiva de minuta: quando presente, o que vai ao background é o
   * texto da minuta (`START_ANALISE`), e `pergunta` vira apenas o rótulo
   * exibido no fio da conversa. Todo o resto do fluxo — etapas, evidência,
   * streaming, citações, retentativa — é o mesmo da consulta comum.
   */
  analise?: { minutaTexto: string; minutaTruncada: boolean };
  /**
   * Chamado quando a análise preditiva termina com sucesso, com o material
   * que as ações do rodapé da bolha precisam (os botões do chat são
   * registrados na montagem, então o estado viaja por aqui, não por closure).
   */
  onAnaliseDone?: (info: {
    termosUsados: string;
    citaveis: Map<number, DocumentoCitado>;
  }) => void;
  /**
   * Refaz só a síntese sobre a evidência já recuperada, sem consultar a Júlia
   * de novo. Usado quando a falha foi do provedor de IA (cota, rede).
   */
  retentarSintese?: boolean;
  /** Chamado ao terminar (sucesso ou erro), para a UI reabilitar o input. */
  onFim?: () => void;
  /**
   * Monta um formulário novo ao fim do fio da conversa.
   *
   * Recebe o contexto usado nesta consulta para que o próximo já venha com as
   * mesmas instâncias e unidades — quem pesquisa jurisprudência costuma fazer
   * várias perguntas sobre o mesmo acervo, e reconfigurar a cada vez seria
   * trabalho repetido.
   */
  onNovaConsulta?: (
    contextoUsado: JuliaContextoUnidade,
    termosUsados: string
  ) => void;
}

/**
 * Dispara a consulta e conduz a conversa até o fim.
 *
 * @returns função que aborta a consulta em andamento.
 */
export function consultarJulia(opts: JuliaExecOpcoes): () => void {
  const { chat, pergunta, contexto } = opts;

  ensureStyle(opts.shadow);
  // Na retentativa a pergunta já está no fio da conversa — repeti-la sugeriria
  // que o usuário perguntou duas vezes.
  if (!opts.retentarSintese) chat.addUserMessage(pergunta);

  const statusNode = chat.addSystemText('');
  const statusTexto = document.createElement('span');
  statusTexto.textContent = opts.analise
    ? 'Lendo a minuta…'
    : 'Interpretando a pergunta…';
  statusNode.appendChild(statusTexto);

  // A etapa de extração muda de natureza na análise preditiva — o rótulo
  // acompanha, senão o usuário lê "Interpretando a pergunta" sem ter feito uma.
  const etapaTexto: Record<string, string> = opts.analise
    ? {
        ...ETAPA_TEXTO,
        [JULIA_ETAPA.EXTRAINDO]: 'Lendo a minuta e identificando as teses…'
      }
    : ETAPA_TEXTO;

  // Botão de cancelar dentro da própria linha de status. `consultarJulia` já
  // devolvia uma função de aborto, mas ninguém a usava — na prática não havia
  // como interromper uma consulta travada a não ser fechando a barra lateral.
  const btnCancelar = document.createElement('button');
  btnCancelar.type = 'button';
  btnCancelar.className = 'paidegua-julia-form__btn paidegua-julia-form__btn--ghost';
  btnCancelar.style.marginLeft = '8px';
  btnCancelar.textContent = 'Cancelar';
  statusNode.appendChild(btnCancelar);

  const port = chrome.runtime.connect({ name: PORT_NAMES.JULIA_STREAM });
  let assistantAberto = false;
  let finalizado = false;
  // Guardado do evento EVIDENCIA para pré-preencher a próxima consulta: refazer
  // uma busca quase sempre começa por ajustar os termos que foram usados.
  let termosUsados = opts.termosManuais ?? '';
  /** Documentos citáveis, indexados pelo número da citação. */
  const citaveis = new Map<number, DocumentoCitado>();

  /**
   * Liga os `[n]` da resposta ao documento correspondente.
   *
   * Roda só no fim do streaming: durante a digitação o markdown ainda está
   * sendo remontado a cada chunk, e reescrever o DOM no meio disso perderia os
   * botões já criados.
   */
  const ativarCitacoes = (): void => {
    if (!citaveis.size) return;
    const bolhas = opts.shadow.querySelectorAll<HTMLElement>(
      '.paidegua-chat__bubble'
    );
    const ultima = bolhas[bolhas.length - 1];
    if (!ultima) return;
    tornarCitacoesClicaveis(ultima, (n) => {
      const doc = citaveis.get(n);
      if (doc) abrirDocumento(opts.shadow, doc);
    });
  };

  const encerrar = (): void => {
    if (finalizado) return;
    finalizado = true;
    statusNode.remove();
    try {
      port.disconnect();
    } catch {
      /* já desconectada */
    }
    opts.onFim?.();
  };

  /**
   * Botão de nova consulta ao pé da resposta.
   *
   * O formulário original fica acima da resposta, muitas vezes fora da área
   * visível — voltar até ele exigiria rolagem. O botão monta um novo no fim do
   * fio e some depois de usado, para não acumular botões mortos na conversa.
   */
  let novaConsultaOferecida = false;
  const oferecerNovaConsulta = (): void => {
    if (!opts.onNovaConsulta || novaConsultaOferecida) return;
    novaConsultaOferecida = true;
    const box = el('div', 'paidegua-julia-form__acoes-esq');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'paidegua-julia-form__btn';
    btn.textContent = opts.analise
      ? 'Analisar a minuta de novo'
      : 'Iniciar outra consulta';
    btn.addEventListener('click', () => {
      bolha.remove();
      opts.onNovaConsulta?.(contexto, termosUsados);
    });
    box.appendChild(btn);
    const bolha = chat.addCustomBubble(box);
  };

  port.onMessage.addListener((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case JULIA_PORT_MSG.PROGRESSO: {
        const etapa = String(msg.etapa ?? '');
        statusTexto.textContent = etapaTexto[etapa] ?? 'Processando…';
        break;
      }

      case JULIA_PORT_MSG.EVIDENCIA: {
        termosUsados = String(msg.termoUsado ?? termosUsados);
        const ev = msg.evidencia as Evidencia;
        for (const p of [
          ...(ev.unidade?.processos ?? []),
          ...(ev.revisor?.processos ?? [])
        ]) {
          citaveis.set(p.n, p);
        }
        // Entra ANTES da resposta: o usuário vê a base antes de ler qualquer
        // afirmação construída sobre ela.
        chat.addCustomBubble(
          renderEvidencia(
            ev,
            String(msg.termoUsado ?? pergunta),
            (d) => abrirDocumento(opts.shadow, d),
            opts.modo ?? 'dupla'
          )
        );

        // Sessão caída derruba SÓ o escopo da unidade — o revisor usa a API
        // pública e responde sempre. Sem este bloco, a consulta seguia e
        // produzia resposta de aparência completa sobre metade da evidência,
        // com a falta anunciada apenas como uma linha no painel.
        //
        // É o caso de todo navegador onde a Júlia nunca foi aberta, ou seja, de
        // todo piloto que instala a extensão agora. Precisa ser confronto, não
        // nota de rodapé.
        if (ev.unidade?.indisponivel === 'sessao') {
          chat.addCustomBubble(
            blocoReconectar(
              'As decisões da sua unidade NÃO entraram nesta resposta: a Júlia não está autenticada neste navegador. O que vem abaixo vale apenas para a instância revisora.',
              () => window.open(URL_LOGIN_JULIA, '_blank', 'noopener')
            )
          );
        }
        break;
      }

      case JULIA_PORT_MSG.CHUNK: {
        if (!assistantAberto) {
          statusNode.remove();
          chat.beginAssistantMessage({
            // Na análise preditiva o rodapé da bolha carrega as ações da
            // feature (registradas em `buildChatBubbleActions`), na ordem
            // pedida pelo owner. Na consulta comum, nenhum id registrado
            // casa — a bolha sai sem botões, comportamento histórico.
            allowedActionIds: opts.analise
              ? [
                  'analise-download-doc',
                  'copy',
                  'analise-sugestoes',
                  'analise-de-novo'
                ]
              : ['copiar']
          });
          assistantAberto = true;
        }
        chat.appendAssistantDelta(String(msg.delta ?? ''));
        break;
      }

      case JULIA_PORT_MSG.DONE: {
        if (assistantAberto) {
          chat.endAssistantMessage();
          ativarCitacoes();
          if (opts.analise) {
            // O material das ações do rodapé (docs citáveis, termos usados)
            // sai por aqui; "Analisar a minuta de novo" virou ação da bolha,
            // então a bolha avulsa não é oferecida no sucesso.
            opts.onAnaliseDone?.({ termosUsados, citaveis });
          } else {
            oferecerNovaConsulta();
          }
        }
        encerrar();
        break;
      }

      case JULIA_PORT_MSG.ERROR: {
        const erro = String(msg.error ?? 'Falha na consulta à Júlia.');
        if (assistantAberto) {
          chat.failAssistantMessage(erro);
        } else {
          statusNode.remove();
          // Sessão expirada tem ação corretiva clara — oferecemos o caminho em
          // vez de só informar o problema. Com o `JSESSIONID` morrendo ao fechar
          // o navegador, este é caminho comum, não excepcional.
          if (msg.sessaoExpirada) {
            // O formulário já foi reabilitado pelo `encerrar()`; aqui só damos o
            // caminho para reconectar. Repetir a pergunta fica com o usuário —
            // reenviar sozinho gastaria tokens sem ele pedir.
            chat.addCustomBubble(
              blocoReconectar(
                `${erro} Depois de entrar, clique novamente em "${opts.analise ? 'Analisar a minuta' : 'Consultar a Júlia'}".`,
                () => window.open(URL_LOGIN_JULIA, '_blank', 'noopener')
              )
            );
          } else {
            chat.addSystemText(erro);
          }
        }

        // Evidência já recuperada: a falha foi na geração da resposta, não na
        // Júlia. Refazer só a síntese poupa dezenas de requisições ao servidor
        // do TRF5 — que não tem culpa da cota do provedor de IA ter estourado.
        if (citaveis.size) {
          const box = el('div', 'paidegua-julia-form__acoes-esq');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'paidegua-julia-form__btn';
          btn.textContent = 'Gerar a resposta de novo';
          // Nova conexão, não `port.postMessage`: o `encerrar()` logo abaixo
          // desconecta esta porta, e a mensagem cairia no vazio.
          btn.addEventListener('click', () => {
            btn.disabled = true;
            consultarJulia({ ...opts, retentarSintese: true });
          });
          box.appendChild(btn);
          box.appendChild(
            el(
              'div',
              'paidegua-julia-form__hint',
              'Reaproveita os documentos já lidos — não consulta a Júlia de novo.'
            )
          );
          chat.addCustomBubble(box);
        }
        // Também em erro. A mensagem de "nenhum documento encontrado" orienta a
        // editar os termos por aqui — sem o botão, a orientação apontaria para
        // algo inexistente.
        oferecerNovaConsulta();
        encerrar();
        break;
      }
    }
  });

  port.onDisconnect.addListener(encerrar);

  const cancelar = (): void => {
    if (finalizado) return;
    try {
      port.postMessage({ type: JULIA_PORT_MSG.ABORT });
    } catch {
      /* porta já caiu */
    }
    if (assistantAberto) {
      chat.endAssistantMessage();
    } else {
      chat.addSystemText('Consulta cancelada.');
    }
    encerrar();
  };

  btnCancelar.addEventListener('click', cancelar);

  const payloadBase = {
    orgao: contexto.orgao,
    instancias: contexto.instancias,
    orgaosJulgadores: contexto.orgaosJulgadores,
    modo: opts.modo ?? 'dupla',
    instanciasPublicas: contexto.instanciasPublicas,
    termosManuais: opts.termosManuais,
    provider: opts.provider,
    model: opts.model
  };

  port.postMessage({
    type: opts.retentarSintese
      ? JULIA_PORT_MSG.RETENTAR_SINTESE
      : opts.analise
        ? JULIA_PORT_MSG.START_ANALISE
        : JULIA_PORT_MSG.START,
    payload: opts.analise
      ? {
          ...payloadBase,
          minutaTexto: opts.analise.minutaTexto,
          minutaTruncada: opts.analise.minutaTruncada
        }
      : {
          ...payloadBase,
          pergunta,
          compararComRevisor: contexto.compararComRevisor
        }
  });

  return cancelar;
}

/** Rótulo do contexto, para exibição. */
export function rotuloContexto(c: JuliaContextoUnidade): string {
  const inst = c.instancias
    .map((i) => JULIA_INSTANCIA_AUTENTICADA_LABELS[i])
    .join(' + ');
  const unidades = c.orgaosJulgadores.length
    ? `${c.orgaosJulgadores.length} unidade(s)`
    : c.orgao;
  const base = `${unidades} · ${inst}`;
  return c.inferido ? `${base} (presumido)` : base;
}

// ── Formulário do 2º grau (API pública) ──────────────────────────

const INSTANCIAS_PUBLICAS: Array<{ id: JuliaInstancia; rotulo: string }> = [
  { id: 'G2', rotulo: 'TRF5' },
  { id: 'TRU', rotulo: 'TRU' },
  { id: 'TR_CE', rotulo: 'TR Ceará' },
  { id: 'TR_PE', rotulo: 'TR Pernambuco' },
  { id: 'TR_PB', rotulo: 'TR Paraíba' },
  { id: 'TR_RN', rotulo: 'TR R. G. do Norte' },
  { id: 'TR_AL', rotulo: 'TR Alagoas' },
  { id: 'TR_SE', rotulo: 'TR Sergipe' }
];

/**
 * Formulário para quem trabalha no 2º grau do TRF5.
 *
 * A Júlia que serve àquele grau consulta apenas o próprio 2º grau — e esse
 * acervo a API pública cobre por inteiro. Logo: sem autenticação, sem escopo de
 * unidade e sem confronto, porque dentro da Júlia não há instância que revise
 * o Tribunal.
 *
 * Some tudo que não se aplica: seccional, instâncias autenticadas, unidades e
 * o marcador de comparação. Fica a escolha do acervo público e a pergunta.
 */
export function renderSeletorPublico(opts: SeletorOpcoes): HTMLElement {
  ensureStyle(opts.shadow);
  const analise = opts.variante === 'analise';

  const c: JuliaContextoUnidade = {
    ...opts.contexto,
    instancias: [],
    orgaosJulgadores: [],
    compararComRevisor: false,
    instanciasPublicas: [...(opts.contexto.instanciasPublicas ?? ['G2'])]
  };

  const root = el('div', 'paidegua-julia-form');
  root.appendChild(
    el(
      'div',
      'paidegua-julia__titulo',
      analise ? 'Análise preditiva da minuta' : 'Fale com a Júlia'
    )
  );
  root.appendChild(
    el(
      'div',
      'paidegua-julia-form__hint',
      analise
        ? 'Confronta a minuta aberta no editor com a jurisprudência do colegiado escolhido.'
        : 'Pesquisa a jurisprudência do TRF5, das Turmas Recursais e da TRU.'
    )
  );

  root.appendChild(el('div', 'paidegua-julia-form__label', 'Acervo'));
  const chips = el('div', 'paidegua-julia-form__chips');
  for (const inst of INSTANCIAS_PUBLICAS) {
    const wrap = document.createElement('label');
    wrap.className = 'paidegua-julia-form__chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = c.instanciasPublicas!.includes(inst.id);
    cb.addEventListener('change', () => {
      c.instanciasPublicas = cb.checked
        ? [...c.instanciasPublicas!, inst.id]
        : c.instanciasPublicas!.filter((i) => i !== inst.id);
      wrap.classList.toggle('is-on', cb.checked);
      atualizar();
    });
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(inst.rotulo));
    wrap.classList.toggle('is-on', cb.checked);
    chips.appendChild(wrap);
  }
  root.appendChild(chips);

  const ta = document.createElement('textarea');
  ta.className = 'paidegua-julia-form__textarea';
  ta.rows = 3;
  ta.placeholder = 'Ex.: pensão por morte a companheira em união estável';
  if (!analise) {
    root.appendChild(
      el('div', 'paidegua-julia-form__label', 'Sua pergunta ou tema')
    );
    root.appendChild(ta);
  }

  root.appendChild(
    el('div', 'paidegua-julia-form__label', 'Termos de busca (opcional)')
  );
  const termos = document.createElement('input');
  termos.type = 'text';
  termos.className = 'paidegua-julia-form__input';
  termos.placeholder = analise
    ? 'Em branco: derivados das teses da minuta'
    : 'Em branco: derivados da pergunta';
  termos.value = opts.termosIniciais ?? '';
  root.appendChild(termos);
  root.appendChild(
    el(
      'div',
      'paidegua-julia-form__hint',
      'A busca da Júlia casa palavras, não sentidos. Operadores: $ trunca (prorroga$), adj exige adjacência (auxílio adj doença), e/ou/nao combinam.'
    )
  );

  if (opts.blocoExtra) root.appendChild(opts.blocoExtra);

  const acoes = el('div', 'paidegua-julia-form__acoes');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-julia-form__btn';
  btn.textContent = analise ? 'Analisar a minuta' : 'Consultar a Júlia';
  acoes.appendChild(btn);
  root.appendChild(acoes);

  const aviso = el('div', 'paidegua-julia-form__aviso');
  root.appendChild(aviso);

  function atualizar(): void {
    const semAcervo = !c.instanciasPublicas?.length;
    btn.disabled = semAcervo || (!analise && !ta.value.trim());
    aviso.textContent = semAcervo ? 'Selecione ao menos um acervo.' : '';
  }

  ta.addEventListener('input', atualizar);
  btn.addEventListener('click', () => {
    const pergunta = ta.value.trim();
    if ((!analise && !pergunta) || !c.instanciasPublicas?.length) return;
    btn.disabled = true;
    ta.disabled = true;
    opts.onConsultar(
      { ...c, instanciasPublicas: [...c.instanciasPublicas] },
      pergunta,
      termos.value.trim(),
      () => {
        ta.disabled = false;
        atualizar();
      }
    );
  });

  atualizar();
  return root;
}

// ── Porta de entrada: acesso à Júlia ─────────────────────────────

export type JuliaAcesso = 'autenticado' | 'sessao' | 'indisponivel';

/** Teto da sonda inicial. Verificação inconclusiva não deve travar o trabalho. */
const TIMEOUT_SONDA_MS = 10_000;

/**
 * Verifica o acesso antes de montar o formulário.
 *
 * Estourando o prazo, devolve `'autenticado'` — deliberadamente otimista. Uma
 * sonda inconclusiva não é motivo para bloquear: se a sessão estiver mesmo
 * caída, o aviso na hora da consulta pega o caso. Travar a tela em
 * "Verificando…" seria trocar um problema por outro pior.
 */
export async function verificarAcesso(
  contexto: JuliaContextoUnidade
): Promise<JuliaAcesso> {
  const instancia = contexto.instancias[0] ?? 'G1';
  try {
    const resp = (await Promise.race([
      chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.JULIA_VERIFICAR_SESSAO,
        payload: { orgao: contexto.orgao, instancia }
      }),
      new Promise((r) => setTimeout(() => r(null), TIMEOUT_SONDA_MS))
    ])) as { ok: boolean; acesso: JuliaAcesso } | null;

    return resp?.ok ? resp.acesso : 'autenticado';
  } catch (err) {
    console.warn(`${LOG_PREFIX} julia: sonda de acesso falhou:`, err);
    return 'autenticado';
  }
}

export interface PortaEntradaOpcoes {
  acesso: Exclude<JuliaAcesso, 'autenticado'>;
  contexto: JuliaContextoUnidade;
  shadow: ShadowRoot;
  /** Chamado quando o acesso é obtido — a interface então monta o formulário. */
  onLiberado: () => void;
  /** Seguir sem a base da unidade, consultando só a instância revisora. */
  onSomenteRevisor: () => void;
}

/**
 * Bloqueia a entrada enquanto o acesso à Júlia não estiver de pé.
 *
 * O formulário **não é montado** antes disso. Antes da v1.10.2 ele abria
 * sempre, e a falta de sessão virava um aviso no meio de um formulário
 * plenamente utilizável — o usuário digitava a pergunta, gastava uma chamada de
 * LLM e recebia metade da resposta. Se a expectativa é consultar a base da
 * própria unidade, tentar sem ela é desperdício garantido.
 *
 * A saída "só a segunda instância" existe porque o acervo recursal é público e
 * tem valor próprio: com a Júlia fora do ar, bloquear tudo mataria também o que
 * continua funcionando. Fica secundária, nunca como caminho padrão.
 */
export function renderPortaEntrada(opts: PortaEntradaOpcoes): HTMLElement {
  ensureStyle(opts.shadow);
  const root = el('div', 'paidegua-julia-form');
  root.appendChild(el('div', 'paidegua-julia__titulo', 'Fale com a Júlia'));

  const indisponivel = opts.acesso === 'indisponivel';
  root.appendChild(
    el(
      'div',
      'paidegua-julia__alerta',
      indisponivel
        ? 'A Júlia não respondeu. Pode estar fora do ar ou fora do alcance da rede — não é problema de login.'
        : 'A Júlia não está autenticada neste navegador. Sem isso não há acesso às decisões da sua unidade, que é o que esta consulta se propõe a comparar.'
    )
  );

  const acoes = el('div', 'paidegua-julia-form__acoes-esq');

  // Serviço fora do ar não se resolve logando — oferecer "Entrar" ali seria
  // mandar o usuário bater numa porta que não existe.
  if (!indisponivel) {
    const entrar = document.createElement('button');
    entrar.type = 'button';
    entrar.className = 'paidegua-julia-form__btn';
    entrar.textContent = 'Entrar na Júlia';
    entrar.addEventListener('click', () => {
      entrar.disabled = true;
      entrar.textContent = 'Aguardando o login…';
      estado.textContent =
        'Abrimos a Júlia em outra aba. Faça o login — assim que ele valer, a aba fecha e você volta para cá automaticamente.';
      void assistirLogin();
    });
    acoes.appendChild(entrar);
  }

  const reverificar = document.createElement('button');
  reverificar.type = 'button';
  reverificar.className =
    'paidegua-julia-form__btn paidegua-julia-form__btn--ghost';
  reverificar.textContent = indisponivel ? 'Tentar de novo' : 'Já entrei — verificar';
  reverificar.addEventListener('click', () => void reverificarAcesso());
  acoes.appendChild(reverificar);

  root.appendChild(acoes);

  const estado = el('div', 'paidegua-julia-form__hint');
  root.appendChild(estado);

  const secundaria = document.createElement('button');
  secundaria.type = 'button';
  secundaria.className =
    'paidegua-julia-form__btn paidegua-julia-form__btn--ghost';
  secundaria.style.marginTop = '4px';
  secundaria.textContent = 'Consultar apenas a segunda instância';
  secundaria.addEventListener('click', () => opts.onSomenteRevisor());
  root.appendChild(secundaria);
  root.appendChild(
    el(
      'div',
      'paidegua-julia-form__hint',
      'A jurisprudência do TRF5, Turmas Recursais e TRU é pública e não depende de login — mas a comparação com a sua unidade fica de fora.'
    )
  );

  async function reverificarAcesso(): Promise<void> {
    estado.textContent = 'Verificando…';
    const acesso = await verificarAcesso(opts.contexto);
    if (acesso === 'autenticado') {
      root.remove();
      opts.onLiberado();
      return;
    }
    estado.textContent =
      acesso === 'sessao'
        ? 'Ainda sem autenticação. Confira se o login na Júlia foi concluído.'
        : 'A Júlia continua sem responder.';
  }

  async function assistirLogin(): Promise<void> {
    try {
      const r = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.JULIA_LOGIN_ASSISTIDO,
        payload: {
          orgao: opts.contexto.orgao,
          instancia: opts.contexto.instancias[0] ?? 'G1'
        }
      })) as { ok: boolean; autenticado: boolean; motivo?: string } | undefined;

      if (r?.autenticado) {
        root.remove();
        opts.onLiberado();
        return;
      }
      estado.textContent =
        r?.motivo === 'aba-fechada'
          ? 'A aba da Júlia foi fechada antes do login. Use "Entrar na Júlia" para tentar de novo.'
          : 'Não detectamos o login. Se você entrou, use "Já entrei — verificar".';
    } catch (err) {
      console.warn(`${LOG_PREFIX} julia: login assistido falhou:`, err);
      estado.textContent = 'Falha ao acompanhar o login. Use "Já entrei — verificar".';
    } finally {
      const entrar = acoes.querySelector('button');
      if (entrar instanceof HTMLButtonElement && entrar.disabled) {
        entrar.disabled = false;
        entrar.textContent = 'Entrar na Júlia';
      }
    }
  }

  return root;
}

// ── Seletor de escopo ────────────────────────────────────────────

const INSTANCIAS_SELECIONAVEIS: JuliaInstanciaAutenticada[] = [
  'G1',
  'JEF',
  'TR',
  'TRU'
];

export interface SeletorOpcoes {
  contexto: JuliaContextoUnidade;
  /**
   * Shadow root — o formulário injeta o próprio estilo ao ser montado.
   *
   * Não dá para deixar isso a cargo do `consultarJulia()`: ele só roda quando o
   * usuário clica em "Consultar", e até lá o formulário já apareceu na tela sem
   * folha de estilo nenhuma.
   */
  shadow: ShadowRoot;
  /** Pré-preenche o campo de termos — usado ao refazer uma consulta. */
  termosIniciais?: string;
  /**
   * `'analise'` monta o formulário da análise preditiva de minutas: mesma
   * seleção de escopo (seccional, instâncias, unidades), mas sem o campo de
   * pergunta — a entrada é a minuta lida do editor — e sem o marcador de
   * comparação, que ali é sempre ligada. Reuso em vez de duplicação: o bloco
   * de unidades embute a sonda de sessão e não deve existir duas vezes.
   */
  variante?: 'consulta' | 'analise';
  /**
   * Bloco extra entre os campos e o botão — a variante `'analise'` injeta o
   * resumo da minuta detectada e o aviso de privacidade.
   */
  blocoExtra?: HTMLElement;
  /**
   * `reabilitar` devolve o formulário ao estado editável. O chamador **deve**
   * invocá-lo ao fim da consulta, inclusive em erro — senão uma sessão expirada
   * deixa o formulário travado e obriga a reabrir tudo para tentar de novo.
   *
   * Na variante `'analise'`, `pergunta` chega vazia.
   */
  onConsultar: (
    contexto: JuliaContextoUnidade,
    pergunta: string,
    termosManuais: string,
    reabilitar: () => void
  ) => void;
}

const URL_LOGIN_JULIA = 'https://julia.trf5.jus.br/julia/entrar';

/**
 * Bloco de reconexão: explica e oferece a ação.
 *
 * Sessão da Júlia é cookie de sessão — morre ao fechar o navegador. Para os
 * pilotos isso será rotina, não exceção, então reconectar precisa estar a um
 * clique de onde o erro apareceu, e não escondido numa mensagem.
 */
function blocoReconectar(mensagem: string, aoRetentar: () => void): HTMLElement {
  const box = el('div', 'paidegua-julia__alerta');
  box.appendChild(el('div', 'paidegua-julia-form__hint', mensagem));

  const acoes = el('div', 'paidegua-julia-form__acoes-esq');

  const abrir = document.createElement('button');
  abrir.type = 'button';
  abrir.className = 'paidegua-julia-form__btn';
  abrir.textContent = 'Abrir a Júlia';
  abrir.addEventListener('click', () => {
    window.open(URL_LOGIN_JULIA, '_blank', 'noopener');
  });

  const retentar = document.createElement('button');
  retentar.type = 'button';
  retentar.className = 'paidegua-julia-form__btn paidegua-julia-form__btn--ghost';
  retentar.textContent = 'Já entrei — tentar de novo';
  retentar.addEventListener('click', aoRetentar);

  acoes.appendChild(abrir);
  acoes.appendChild(retentar);
  box.appendChild(acoes);

  // Voltar para esta aba depois de logar é o gesto natural — aproveitamos para
  // tentar sozinho, uma única vez, em vez de exigir mais um clique.
  const aoVoltar = (): void => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', aoVoltar);
    aoRetentar();
  };
  document.addEventListener('visibilitychange', aoVoltar);

  return box;
}

/** Rótulos curtos para os chips — o painel do chat é estreito. */
const INSTANCIA_CHIP: Record<JuliaInstanciaAutenticada, string> = {
  G1: 'Comum',
  JEF: 'JEF',
  TR: 'Turma Recursal',
  TRU: 'TRU'
};

/**
 * Formulário de consulta: instâncias, órgão julgador e pergunta num só lugar.
 *
 * As instâncias são **caixas de seleção múltipla**, não um seletor único, e essa
 * é a diferença que importa: vara de competência plena precisa consultar `G1` e
 * `JEF` na mesma pergunta. Um `<select>` de valor único tornaria impossível
 * responder corretamente para essas unidades.
 */
export function renderSeletorConsulta(opts: SeletorOpcoes): HTMLElement {
  ensureStyle(opts.shadow);
  const analise = opts.variante === 'analise';

  const c: JuliaContextoUnidade = {
    ...opts.contexto,
    instancias: [...opts.contexto.instancias],
    orgaosJulgadores: [...opts.contexto.orgaosJulgadores]
  };

  // Definida adiante, quando a lista de unidades é montada. Os chips de
  // instância precisam acioná-la, e são criados antes.
  let recarregarUnidades: () => void = () => {};

  const root = el('div', 'paidegua-julia-form');
  root.appendChild(
    el(
      'div',
      'paidegua-julia__titulo',
      analise ? 'Análise preditiva da minuta' : 'Fale com a Júlia'
    )
  );
  root.appendChild(
    el(
      'div',
      'paidegua-julia-form__hint',
      analise
        ? 'Confronta a minuta aberta no editor com o que a sua unidade e a instância revisora vêm decidindo.'
        : 'Compara o que a sua unidade vem entendendo com o que a instância revisora vem decidindo.'
    )
  );

  // ── Seccional
  //
  // Exposta como seletor, e não fixada pelo e-mail: a inferência por domínio
  // acerta no caso comum, mas quando falha o usuário cairia em outra seccional
  // sem perceber — os resultados viriam plausíveis e errados. Também habilita
  // consultar outra seccional de propósito, para comparar entendimentos.
  root.appendChild(el('div', 'paidegua-julia-form__label', 'Seccional'));
  const selOrgao = document.createElement('select');
  selOrgao.className = 'paidegua-julia-form__input';
  for (const o of JULIA_ORGAOS) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    opt.selected = o === c.orgao;
    selOrgao.appendChild(opt);
  }
  selOrgao.addEventListener('change', () => {
    c.orgao = selOrgao.value as JuliaOrgao;
    c.inferido = false;
    // Unidades e revisor dependem da seccional — a lista precisa ser refeita.
    c.orgaosJulgadores = [];
    recarregarUnidades();
  });
  root.appendChild(selOrgao);

  // ── Instâncias
  root.appendChild(el('div', 'paidegua-julia-form__label', 'Instâncias'));
  const chips = el('div', 'paidegua-julia-form__chips');
  for (const inst of INSTANCIAS_SELECIONAVEIS) {
    const wrap = document.createElement('label');
    wrap.className = 'paidegua-julia-form__chip';
    wrap.title = JULIA_INSTANCIA_AUTENTICADA_LABELS[inst];

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = c.instancias.includes(inst);
    cb.addEventListener('change', () => {
      c.instancias = cb.checked
        ? [...c.instancias, inst]
        : c.instancias.filter((i) => i !== inst);
      c.inferido = false;
      wrap.classList.toggle('is-on', cb.checked);
      atualizarBotao();
      // A lista de unidades é por instância — precisa refletir a nova seleção.
      recarregarUnidades();
    });

    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(INSTANCIA_CHIP[inst]));
    wrap.classList.toggle('is-on', cb.checked);
    chips.appendChild(wrap);
  }
  root.appendChild(chips);
  root.appendChild(
    el(
      'div',
      'paidegua-julia-form__hint',
      'Competência plena tem acervo em Comum e JEF — deixe os dois marcados.'
    )
  );

  // Controle explícito da comparação. Antes isso era inferido pelo LLM a partir
  // da redação da pergunta, e "como a vara vem decidindo…" desligava o escopo
  // revisor — justamente a metade que dá valor à análise.
  //
  // Na análise preditiva o marcador não aparece: o confronto com o revisor é a
  // razão de ser da funcionalidade, e desligá-lo produziria um "prognóstico"
  // sem a instância que o justifica.
  if (!analise) {
    const cmpWrap = document.createElement('label');
    cmpWrap.className = 'paidegua-julia-form__chip is-on';
    cmpWrap.style.marginTop = '6px';
    const cmpCb = document.createElement('input');
    cmpCb.type = 'checkbox';
    cmpCb.checked = c.compararComRevisor;
    cmpCb.addEventListener('change', () => {
      c.compararComRevisor = cmpCb.checked;
      cmpWrap.classList.toggle('is-on', cmpCb.checked);
    });
    cmpWrap.appendChild(cmpCb);
    cmpWrap.appendChild(
      document.createTextNode('Comparar com a instância que revisa')
    );
    root.appendChild(cmpWrap);
  } else {
    c.compararComRevisor = true;
  }

  // ── Unidades (carregadas do própria Júlia)
  root.appendChild(
    el('div', 'paidegua-julia-form__label', 'Unidades (nenhuma = toda a seccional)')
  );

  const filtro = document.createElement('input');
  filtro.type = 'search';
  filtro.className = 'paidegua-julia-form__input';
  filtro.placeholder = 'Filtrar unidades…';
  root.appendChild(filtro);

  const listaUnidades = el('div', 'paidegua-julia-form__lista');
  listaUnidades.textContent = 'Carregando unidades…';
  root.appendChild(listaUnidades);

  const resumoUnidades = el('div', 'paidegua-julia-form__hint');
  root.appendChild(resumoUnidades);

  let disponiveis: string[] = [];

  function atualizarResumo(): void {
    const n = c.orgaosJulgadores.length;
    resumoUnidades.textContent =
      n === 0
        ? 'Nenhuma marcada — a busca cobrirá toda a seccional.'
        : `${n} unidade(s) marcada(s).`;
  }

  function pintarLista(): void {
    const termo = filtro.value.trim().toLowerCase();
    const visiveis = termo
      ? disponiveis.filter((u) => u.toLowerCase().includes(termo))
      : disponiveis;

    listaUnidades.textContent = '';
    if (!visiveis.length) {
      listaUnidades.appendChild(
        el('div', 'paidegua-julia-form__hint', 'Nenhuma unidade encontrada.')
      );
      return;
    }
    for (const nome of visiveis) {
      const linha = document.createElement('label');
      linha.className = 'paidegua-julia-form__item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.orgaosJulgadores.includes(nome);
      cb.addEventListener('change', () => {
        c.orgaosJulgadores = cb.checked
          ? [...c.orgaosJulgadores, nome]
          : c.orgaosJulgadores.filter((u) => u !== nome);
        c.inferido = false;
        atualizarResumo();
      });
      linha.appendChild(cb);
      linha.appendChild(document.createTextNode(nome));
      listaUnidades.appendChild(linha);
    }
  }

  /**
   * Recarrega a lista sempre que as instâncias mudam — na Júlia os órgãos
   * julgadores são por instância, e as varas comuns de uma seccional não são as
   * mesmas do JEF.
   */
  async function carregarUnidades(): Promise<void> {
    if (!c.instancias.length) {
      disponiveis = [];
      listaUnidades.textContent = '';
      listaUnidades.appendChild(
        el('div', 'paidegua-julia-form__hint', 'Selecione uma instância primeiro.')
      );
      return;
    }
    listaUnidades.textContent = 'Carregando unidades…';
    try {
      // Esta chamada é também a sonda de sessão do formulário: é a primeira
      // coisa que toca a API autenticada, então uma sessão morta aparece aqui,
      // antes de o usuário escrever a pergunta.
      const resp = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.JULIA_ORGAOS_JULGADORES,
        payload: { orgao: c.orgao, instancias: c.instancias }
      })) as
        | { ok: boolean; orgaos?: string[]; error?: string; sessaoExpirada?: boolean }
        | undefined;

      if (!resp?.ok) {
        disponiveis = [];
        listaUnidades.textContent = '';
        listaUnidades.appendChild(
          resp?.sessaoExpirada
            ? blocoReconectar(
                'A Júlia não está autenticada neste navegador. Sem isso, a consulta responde apenas pela instância revisora — as decisões da sua unidade ficam de fora.',
                () => void carregarUnidades()
              )
            : el(
                'div',
                'paidegua-julia__alerta',
                resp?.error ??
                  'Não foi possível carregar as unidades. A busca cobrirá toda a seccional.'
              )
        );
        return;
      }
      disponiveis = resp.orgaos ?? [];
      // Descarta seleções que não existem na nova combinação de instâncias.
      c.orgaosJulgadores = c.orgaosJulgadores.filter((u) => disponiveis.includes(u));
      pintarLista();
      atualizarResumo();
    } catch (err) {
      console.warn(`${LOG_PREFIX} julia: falha carregando unidades:`, err);
      listaUnidades.textContent = '';
      listaUnidades.appendChild(
        el('div', 'paidegua-julia__alerta', 'Falha ao carregar as unidades.')
      );
    }
  }

  filtro.addEventListener('input', pintarLista);
  recarregarUnidades = carregarUnidades;
  void carregarUnidades();
  atualizarResumo();

  // ── Pergunta (na análise preditiva a entrada é a minuta, não uma pergunta)
  const ta = document.createElement('textarea');
  ta.className = 'paidegua-julia-form__textarea';
  ta.rows = 3;
  ta.placeholder = 'Ex.: auxílio-doença sem pedido de prorrogação';
  if (!analise) {
    root.appendChild(
      el('div', 'paidegua-julia-form__label', 'Sua pergunta ou tema')
    );
    root.appendChild(ta);
  }

  // ── Termos de busca (sobrepõem a derivação automática)
  root.appendChild(
    el('div', 'paidegua-julia-form__label', 'Termos de busca (opcional)')
  );
  const termos = document.createElement('input');
  termos.type = 'text';
  termos.className = 'paidegua-julia-form__input';
  termos.placeholder = analise
    ? 'Em branco: derivados das teses da minuta'
    : 'Em branco: derivados da pergunta';
  termos.value = opts.termosIniciais ?? '';
  root.appendChild(termos);
  root.appendChild(
    el(
      'div',
      'paidegua-julia-form__hint',
      'A busca da Júlia casa palavras, não sentidos. Operadores: $ trunca (prorroga$), adj exige adjacência (auxílio adj doença), e/ou/nao combinam.'
    )
  );

  if (opts.blocoExtra) root.appendChild(opts.blocoExtra);

  const acoes = el('div', 'paidegua-julia-form__acoes');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-julia-form__btn';
  btn.textContent = analise ? 'Analisar a minuta' : 'Consultar a Júlia';
  acoes.appendChild(btn);
  root.appendChild(acoes);

  const aviso = el('div', 'paidegua-julia-form__aviso');
  root.appendChild(aviso);

  function atualizarBotao(): void {
    const semInstancia = c.instancias.length === 0;
    btn.disabled = semInstancia || (!analise && !ta.value.trim());
    aviso.textContent = semInstancia
      ? 'Selecione ao menos uma instância.'
      : '';
  }

  ta.addEventListener('input', atualizarBotao);
  btn.addEventListener('click', () => {
    const pergunta = ta.value.trim();
    if ((!analise && !pergunta) || !c.instancias.length) return;
    btn.disabled = true;
    ta.disabled = true;
    opts.onConsultar(
      {
        ...c,
        instancias: [...c.instancias],
        orgaosJulgadores: [...c.orgaosJulgadores]
      },
      pergunta,
      termos.value.trim(),
      () => {
        ta.disabled = false;
        atualizarBotao();
      }
    );
  });

  atualizarBotao();
  return root;
}
