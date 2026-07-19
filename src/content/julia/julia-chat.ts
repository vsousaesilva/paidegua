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
  processos: Array<{
    numero: string | null;
    tipo: string | null;
    orgaoJulgador: string | null;
    data: string | null;
    secao: string;
    urlPje: string | null;
  }>;
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

.paidegua-julia__og { color: var(--paidegua-text-muted); }

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

function renderLado(lado: LadoEvidencia | null, titulo: string): HTMLElement {
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
  lado.processos.forEach((p, i) => {
    const li = document.createElement('li');
    const rotulo = `[${i + 1}] ${p.numero ?? 's/n'} · ${p.tipo ?? '—'} · ${SECAO_LABEL[p.secao] ?? p.secao}`;
    if (p.urlPje) {
      const a = document.createElement('a');
      a.href = p.urlPje;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = rotulo;
      li.appendChild(a);
    } else {
      li.textContent = rotulo;
    }
    if (p.orgaoJulgador) {
      li.appendChild(el('span', 'paidegua-julia__og', ` — ${p.orgaoJulgador}`));
    }
    lista.appendChild(li);
  });
  box.appendChild(lista);
  return box;
}

function renderEvidencia(ev: Evidencia, termo: string): HTMLElement {
  const root = el('div', 'paidegua-julia');
  root.appendChild(el('div', 'paidegua-julia__titulo', 'Base consultada'));
  root.appendChild(el('div', 'paidegua-julia__termo', `Busca: "${termo}"`));

  root.appendChild(renderLado(ev.unidade, 'Decisões da própria unidade'));
  root.appendChild(renderLado(ev.revisor, 'Decisões de quem revisa a unidade'));

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
  /** Termos escritos à mão; vazio deixa o background derivar da pergunta. */
  termosManuais?: string;
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
  chat.addUserMessage(pergunta);

  const statusNode = chat.addSystemText('');
  const statusTexto = document.createElement('span');
  statusTexto.textContent = 'Interpretando a pergunta…';
  statusNode.appendChild(statusTexto);

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
    btn.textContent = 'Iniciar outra consulta';
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
        statusTexto.textContent = ETAPA_TEXTO[etapa] ?? 'Processando…';
        break;
      }

      case JULIA_PORT_MSG.EVIDENCIA: {
        termosUsados = String(msg.termoUsado ?? termosUsados);
        const ev = msg.evidencia as Evidencia;
        // Entra ANTES da resposta: o usuário vê a base antes de ler qualquer
        // afirmação construída sobre ela.
        chat.addCustomBubble(renderEvidencia(ev, String(msg.termoUsado ?? pergunta)));

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
          chat.beginAssistantMessage({ allowedActionIds: ['copiar'] });
          assistantAberto = true;
        }
        chat.appendAssistantDelta(String(msg.delta ?? ''));
        break;
      }

      case JULIA_PORT_MSG.DONE: {
        if (assistantAberto) {
          chat.endAssistantMessage();
          oferecerNovaConsulta();
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
                `${erro} Depois de entrar, clique novamente em "Consultar a Júlia".`,
                () => window.open(URL_LOGIN_JULIA, '_blank', 'noopener')
              )
            );
          } else {
            chat.addSystemText(erro);
          }
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

  port.postMessage({
    type: JULIA_PORT_MSG.START,
    payload: {
      pergunta,
      orgao: contexto.orgao,
      instancias: contexto.instancias,
      orgaosJulgadores: contexto.orgaosJulgadores,
      compararComRevisor: contexto.compararComRevisor,
      termosManuais: opts.termosManuais,
      provider: opts.provider,
      model: opts.model
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
   * `reabilitar` devolve o formulário ao estado editável. O chamador **deve**
   * invocá-lo ao fim da consulta, inclusive em erro — senão uma sessão expirada
   * deixa o formulário travado e obriga a reabrir tudo para tentar de novo.
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

  const c: JuliaContextoUnidade = {
    ...opts.contexto,
    instancias: [...opts.contexto.instancias],
    orgaosJulgadores: [...opts.contexto.orgaosJulgadores]
  };

  // Definida adiante, quando a lista de unidades é montada. Os chips de
  // instância precisam acioná-la, e são criados antes.
  let recarregarUnidades: () => void = () => {};

  const root = el('div', 'paidegua-julia-form');
  root.appendChild(el('div', 'paidegua-julia__titulo', 'Fale com a Júlia'));
  root.appendChild(
    el(
      'div',
      'paidegua-julia-form__hint',
      'Compara o que a sua unidade vem entendendo com o que a instância revisora vem decidindo.'
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

  // ── Pergunta
  root.appendChild(el('div', 'paidegua-julia-form__label', 'Sua pergunta ou tema'));
  const ta = document.createElement('textarea');
  ta.className = 'paidegua-julia-form__textarea';
  ta.rows = 3;
  ta.placeholder = 'Ex.: auxílio-doença sem pedido de prorrogação';
  root.appendChild(ta);

  // ── Termos de busca (sobrepõem a derivação automática)
  root.appendChild(
    el('div', 'paidegua-julia-form__label', 'Termos de busca (opcional)')
  );
  const termos = document.createElement('input');
  termos.type = 'text';
  termos.className = 'paidegua-julia-form__input';
  termos.placeholder = 'Em branco: derivados da pergunta';
  termos.value = opts.termosIniciais ?? '';
  root.appendChild(termos);
  root.appendChild(
    el(
      'div',
      'paidegua-julia-form__hint',
      'A busca da Júlia casa palavras, não sentidos. Operadores: $ trunca (prorroga$), adj exige adjacência (auxílio adj doença), e/ou/nao combinam.'
    )
  );

  const acoes = el('div', 'paidegua-julia-form__acoes');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-julia-form__btn';
  btn.textContent = 'Consultar a Júlia';
  acoes.appendChild(btn);
  root.appendChild(acoes);

  const aviso = el('div', 'paidegua-julia-form__aviso');
  root.appendChild(aviso);

  function atualizarBotao(): void {
    const semInstancia = c.instancias.length === 0;
    btn.disabled = semInstancia || !ta.value.trim();
    aviso.textContent = semInstancia
      ? 'Selecione ao menos uma instância.'
      : '';
  }

  ta.addEventListener('input', atualizarBotao);
  btn.addEventListener('click', () => {
    const pergunta = ta.value.trim();
    if (!pergunta || !c.instancias.length) return;
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
