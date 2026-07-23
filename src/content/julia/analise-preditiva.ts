/**
 * Análise preditiva de minutas — perfil **Gabinete**.
 *
 * O magistrado, com a minuta aberta no editor do PJe (Badon/ProseMirror, ou
 * CKEditor 4 nas instalações antigas), pede um confronto do texto com o que a
 * própria unidade e a instância revisora vêm decidindo, via Júlia (TRF5). O
 * resultado é um relatório qualitativo — prognóstico, divergências ponto a
 * ponto, precedentes favoráveis/contrários e sugestões — apresentado no chat
 * da sidebar, com o mesmo painel de evidência e as mesmas citações `[n]`
 * clicáveis do "Fale com a Júlia".
 *
 * Este módulo é deliberadamente fino: o formulário é o seletor de escopo da
 * consulta comum na variante `'analise'` (mesma seleção de seccional,
 * instâncias e unidades, com a sonda de sessão embutida), e a execução é o
 * `consultarJulia` com o campo `analise` — que troca a mensagem de partida
 * para `START_ANALISE` e leva o texto da minuta em vez de uma pergunta. O que
 * vive aqui é só o que é próprio da feature: a leitura da minuta no momento
 * certo e o bloco de resumo + privacidade do formulário.
 *
 * ## A leitura acontece no clique, não na abertura do formulário
 *
 * Entre abrir o formulário e clicar em "Analisar a minuta" o usuário pode ter
 * continuado editando — ou navegado para outra tela. A leitura exibida na
 * abertura é informativa; a que vai à análise é feita de novo no clique, e se
 * o editor tiver sumido nesse meio-tempo o erro é dito, não silenciado.
 */

import {
  JULIA_PORT_MSG,
  MESSAGE_CHANNELS,
  PORT_NAMES,
  PROVIDER_LABELS
} from '../../shared/constants';
import type { ProviderId } from '../../shared/constants';
import type { PrecedenteParaReescrita } from '../../shared/julia/julia-prompts';
import {
  MINUTA_MAX_CHARS,
  minutaSuficiente,
  readFromPJeEditor,
  truncarPreservandoExtremos,
  type PJeEditorContent
} from '../ckeditor-bridge';
import type { ChatController } from '../ui/chat';
import {
  consultarJulia,
  renderSeletorConsulta,
  renderSeletorPublico,
  type DocumentoCitado,
  type JuliaContextoUnidade
} from './julia-chat';

export interface AnalisePreditivaOpcoes {
  chat: ChatController;
  shadow: ShadowRoot;
  contexto: JuliaContextoUnidade;
  /** `'publica'` no 2º grau: aderência ao próprio colegiado, sem confronto. */
  modo: 'dupla' | 'publica';
  provider: ProviderId;
  model: string;
  /** Pré-preenche o campo de termos — usado ao refazer uma análise. */
  termosIniciais?: string;
}

/** "~12 mil caracteres" / "850 caracteres" — tamanho legível para o resumo. */
function formatarTamanho(chars: number): string {
  return chars >= 1000
    ? `~${Math.round(chars / 1000)} mil caracteres`
    : `${chars} caracteres`;
}

/**
 * Converte o HTML da minuta em Markdown enxuto, preservando o que importa
 * para a reescrita: negrito, itálico, listas e — o mais relevante numa
 * minuta — os **recuos de citação**, que viram blocos `> `.
 *
 * O Markdown é o formato do pipeline: a bolha do chat o renderiza e o
 * "Inserir no PJe" (`renderForPJe`) converte `> ` em blockquotes aninhados
 * do ProseMirror. Mandar o `innerText` puro à reescrita descartava toda a
 * formatação da minuta original.
 *
 * Citação recuada é detectada por classe (recuo/citac/quote) ou por
 * margem/padding esquerdo ≥ 40px no estilo inline — as duas convenções
 * vistas no editor do PJe e na visualização `folha`.
 */
function htmlParaMarkdown(html: string): string {
  if (!html.trim()) return '';
  let corpo: HTMLElement;
  try {
    corpo = new DOMParser().parseFromString(html, 'text/html').body;
  } catch {
    return '';
  }

  const ehCitacaoRecuada = (el: HTMLElement): boolean => {
    if (/recuo|citac|quote/i.test(el.className || '')) return true;
    const esquerda = parseInt(
      el.style?.marginLeft || el.style?.paddingLeft || el.style?.textIndent || '',
      10
    );
    return Number.isFinite(esquerda) && esquerda >= 40;
  };

  const blocoCitacao = (texto: string): string => {
    const t = texto.trim();
    if (!t) return '';
    return (
      t
        .split('\n')
        .map((l) => `> ${l.trim()}`)
        .join('\n') + '\n\n'
    );
  };

  const serializar = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? '').replace(/\s+/g, ' ');
    }
    if (!(node instanceof HTMLElement)) return '';
    const filhos = Array.from(node.childNodes).map(serializar).join('');
    const conteudo = filhos.replace(/\n{3,}/g, '\n\n');
    switch (node.tagName) {
      case 'SCRIPT':
      case 'STYLE':
        return '';
      case 'BR':
        return '\n';
      case 'B':
      case 'STRONG': {
        const t = conteudo.trim();
        return t ? `**${t}** ` : '';
      }
      case 'I':
      case 'EM': {
        const t = conteudo.trim();
        return t ? `*${t}* ` : '';
      }
      case 'LI':
        return `- ${conteudo.trim()}\n`;
      case 'UL':
      case 'OL':
        return `\n${conteudo}\n`;
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4': {
        const t = conteudo.trim();
        return t ? `\n**${t}**\n\n` : '';
      }
      case 'BLOCKQUOTE':
        return blocoCitacao(conteudo);
      case 'P':
      case 'DIV': {
        const t = conteudo.trim();
        if (!t) return '';
        return ehCitacaoRecuada(node) ? blocoCitacao(t) : `${t}\n\n`;
      }
      default:
        return conteudo;
    }
  };

  const md = serializar(corpo)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md.length > MINUTA_MAX_CHARS
    ? truncarPreservandoExtremos(md, MINUTA_MAX_CHARS)
    : md;
}

/**
 * Lê a minuta onde quer que ela esteja: neste frame ou em outro.
 *
 * Primeiro tenta o DOM local (cobre a tela de minutar aberta diretamente).
 * Falhando, pergunta via background a todos os frames da aba
 * (`MINUTA_LER`/`MINUTA_LER_PERFORM`) — é o caminho obrigatório no TRF5, onde
 * o painel do usuário embute o editor num iframe cross-origin
 * (`frontend-prd.trf5.jus.br`) cujo DOM o frame de topo não alcança.
 *
 * `null` = nenhuma minuta com conteúdo em frame algum.
 */
export async function lerMinutaEmQualquerFrame(
  somenteDeteccao = false
): Promise<PJeEditorContent | null> {
  const local = readFromPJeEditor();
  if (minutaSuficiente(local)) return local;

  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.MINUTA_LER,
      payload: { somenteDeteccao }
    })) as (PJeEditorContent & { ok: boolean }) | { ok: false } | undefined;
    return resp?.ok ? (resp as PJeEditorContent) : null;
  } catch {
    return null;
  }
}

/**
 * Resumo da minuta detectada + aviso de privacidade, inseridos no formulário.
 *
 * O aviso não é burocracia: o texto da minuta sai do navegador para o provedor
 * de IA configurado, e quem assina precisa saber disso antes de clicar. Com os
 * dois botões (com e sem anonimização), o aviso explica o que cada um faz.
 */
function montarBlocoMinuta(
  conteudo: PJeEditorContent,
  provider: ProviderId
): HTMLElement {
  const bloco = document.createElement('div');
  bloco.style.display = 'flex';
  bloco.style.flexDirection = 'column';
  bloco.style.gap = '5px';
  bloco.style.marginTop = '6px';

  const resumo = document.createElement('div');
  resumo.className = 'paidegua-julia__contagem';
  const origem =
    conteudo.kind === 'folha-visualizacao'
      ? 'na visualização do documento'
      : 'no editor';
  resumo.textContent = `Minuta detectada ${origem}: ${formatarTamanho(conteudo.chars)}.`;
  bloco.appendChild(resumo);

  if (conteudo.truncado) {
    const aviso = document.createElement('div');
    aviso.className = 'paidegua-julia__alerta';
    aviso.textContent =
      'A minuta excede o limite de leitura — o trecho intermediário será omitido da análise (início e dispositivo são preservados).';
    bloco.appendChild(aviso);
  }

  const privacidade = document.createElement('div');
  privacidade.className = 'paidegua-julia-form__hint';
  privacidade.textContent =
    `O texto da minuta será enviado ao provedor de IA configurado (${PROVIDER_LABELS[provider]}). ` +
    '"Analisar a minuta" envia o texto como está; ' +
    '"Analisar minuta (com texto anonimizado)" mascara antes CPF, contatos e a qualificação das partes ' +
    '(nomes citados no corpo do texto podem permanecer). Em nenhum dos casos a minuta é armazenada.';
  bloco.appendChild(privacidade);

  return bloco;
}

/**
 * Monta o formulário da análise no fim do fio da conversa.
 *
 * Recursiva pelo mesmo motivo do "Fale com a Júlia": cada análise encerrada
 * oferece "Analisar a minuta de novo", que volta aqui com o contexto e os
 * termos já usados.
 */
export async function abrirFormularioAnalise(
  opts: AnalisePreditivaOpcoes
): Promise<void> {
  const conteudo = await lerMinutaEmQualquerFrame(true);
  if (!conteudo) {
    opts.chat.addSystemText(
      'Não encontrei uma minuta no editor do PJe. Abra a tela de minutar peça, escreva ou cole a minuta e tente de novo.'
    );
    return;
  }

  const render =
    opts.modo === 'publica' ? renderSeletorPublico : renderSeletorConsulta;

  opts.chat.addCustomBubble(
    render({
      contexto: opts.contexto,
      shadow: opts.shadow,
      termosIniciais: opts.termosIniciais,
      variante: 'analise',
      blocoExtra: montarBlocoMinuta(conteudo, opts.provider),
      onConsultar: (escolhido, _pergunta, termosManuais, reabilitar, opcoesAnalise) => {
        const anonimizar = opcoesAnalise?.anonimizar ?? false;
        // Releitura fresca (com o texto): o que se analisa é o estado atual
        // do editor, não o do momento em que o formulário abriu.
        void (async () => {
          const fresco = await lerMinutaEmQualquerFrame(false);
          if (!fresco || !fresco.text.trim()) {
            opts.chat.addSystemText(
              'Não encontrei a minuta no editor — a aba mudou de tela? Volte à minuta e clique de novo em "Analisar a minuta".'
            );
            reabilitar();
            return;
          }
          consultarJulia({
            chat: opts.chat,
            shadow: opts.shadow,
            pergunta: `Análise preditiva da minuta em edição (${formatarTamanho(fresco.chars)})`,
            contexto: escolhido,
            termosManuais,
            modo: opts.modo,
            provider: opts.provider,
            model: opts.model,
            analise: {
              minutaTexto: fresco.text,
              minutaTruncada: fresco.truncado,
              anonimizar
            },
            onFim: reabilitar,
            // Sucesso: as ações do rodapé da bolha ("Analisar sugestões…",
            // "Analisar a minuta de novo") são registradas na montagem do
            // chat e não têm closure desta execução — o estado viaja por aqui.
            onAnaliseDone: ({ termosUsados, citaveis }) => {
              ultimaAnalise = {
                chat: opts.chat,
                shadow: opts.shadow,
                contexto: escolhido,
                modo: opts.modo,
                provider: opts.provider,
                model: opts.model,
                // Versão FORMATADA (markdown do HTML) para a reescrita
                // preservar negrito, itálico e recuos de citação; o texto
                // puro fica de reserva para HTML vazio/inconversível.
                minutaFormatada: htmlParaMarkdown(fresco.html) || fresco.text,
                // A reescrita segue a mesma escolha de anonimização da análise.
                anonimizar,
                termosUsados,
                citaveis
              };
            },
            // Erro (busca vazia etc.): sem bolha de resposta não há rodapé de
            // ações — a bolha avulsa continua sendo o caminho de repetição.
            onNovaConsulta: (contextoUsado, termosUsados) =>
              void abrirFormularioAnalise({
                ...opts,
                contexto: contextoUsado,
                termosIniciais: termosUsados
              })
          });
        })();
      }
    })
  );
}

// ── Ações do rodapé da bolha de análise ──────────────────────────

/**
 * Estado da última análise concluída — o que as ações do rodapé da bolha
 * precisam para funcionar (os botões do chat são registrados uma vez na
 * montagem, sem closure da execução).
 *
 * Limite conhecido: com duas análises em sequência, os botões da bolha
 * antiga passam a operar sobre o estado da mais recente — os `[n]` de uma
 * resposta velha podem não casar com os documentos novos. É o mesmo desenho
 * do `lastMinuta` das minutas comuns, e o custo de guardar histórico por
 * bolha não se justifica aqui.
 */
interface UltimaAnalise {
  chat: ChatController;
  shadow: ShadowRoot;
  contexto: JuliaContextoUnidade;
  modo: 'dupla' | 'publica';
  provider: ProviderId;
  model: string;
  /** Minuta em markdown derivado do HTML do editor — preserva a formatação. */
  minutaFormatada: string;
  /** Escolha de anonimização da análise — a reescrita a repete. */
  anonimizar: boolean;
  termosUsados: string;
  citaveis: Map<number, DocumentoCitado>;
}

let ultimaAnalise: UltimaAnalise | null = null;

/**
 * Reabre o formulário da análise com o contexto e os termos da última
 * execução. `false` quando não há análise anterior (o chamador avisa).
 */
export function repetirAnalise(): boolean {
  if (!ultimaAnalise) return false;
  const u = ultimaAnalise;
  void abrirFormularioAnalise({
    chat: u.chat,
    shadow: u.shadow,
    contexto: u.contexto,
    modo: u.modo,
    provider: u.provider,
    model: u.model,
    termosIniciais: u.termosUsados
  });
  return true;
}

/**
 * Extrai os itens da seção "Sugestões de reforço ou distinção" do markdown
 * da resposta.
 *
 * O prompt fixa o título e pede listas, mas parser de saída de LLM precisa de
 * tolerância: aceita marcadores `-`/`*`/`•`/numerados e, se o modelo tiver
 * escrito parágrafos corridos, cai para um item por parágrafo.
 */
function extrairSugestoes(markdown: string): string[] {
  const linhas = markdown.split('\n');
  const inicio = linhas.findIndex((l) =>
    /sugest\S*es de refor\S*o ou distin/i.test(l)
  );
  if (inicio < 0) return [];

  const secao: string[] = [];
  for (let i = inicio + 1; i < linhas.length; i++) {
    const l = linhas[i] ?? '';
    // Próximo título de seção ("**O que esta análise não permite afirmar**"),
    // desde que não seja um item de lista que começa em negrito.
    if (/^\s*\*\*[^*]+\*\*\s*$/.test(l) || /^\s*#{1,4}\s/.test(l)) break;
    secao.push(l);
  }

  const itens: string[] = [];
  let atual = '';
  for (const l of secao) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
    if (m) {
      if (atual.trim()) itens.push(atual.trim());
      atual = m[1] ?? '';
    } else if (l.trim()) {
      atual += (atual ? ' ' : '') + l.trim();
    } else if (!itens.length && atual.trim()) {
      // Sem marcadores de lista: parágrafo em branco separa itens.
      itens.push(atual.trim());
      atual = '';
    }
  }
  if (atual.trim()) itens.push(atual.trim());
  return itens;
}

/** Tira negrito/itálico do texto para exibição no seletor. */
function limparMarcacao(texto: string): string {
  return texto.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
}

/**
 * Abre o seletor de sugestões sobre a resposta da análise e dispara a
 * reescrita com as escolhidas. `false` quando não há análise anterior.
 */
export function abrirSeletorSugestoes(markdown: string): boolean {
  const u = ultimaAnalise;
  if (!u) return false;

  const sugestoes = extrairSugestoes(markdown);
  if (!sugestoes.length) {
    u.chat.addSystemText(
      'Não encontrei a seção "Sugestões de reforço ou distinção" nesta resposta — sem sugestões, não há o que aplicar à minuta.'
    );
    return true;
  }

  const box = document.createElement('div');
  box.className = 'paidegua-julia-form';

  const titulo = document.createElement('div');
  titulo.className = 'paidegua-julia__titulo';
  titulo.textContent = 'Reescrever a minuta com as sugestões';
  box.appendChild(titulo);

  const hint = document.createElement('div');
  hint.className = 'paidegua-julia-form__hint';
  hint.textContent =
    'Escolha uma ou mais sugestões. A minuta será reescrita aplicando SÓ as escolhidas — todo o resto do texto permanece literal.';
  box.appendChild(hint);

  const lista = document.createElement('div');
  lista.className = 'paidegua-julia-form__lista';
  lista.style.maxHeight = '260px';
  const marcadas = new Set<number>();
  sugestoes.forEach((s, i) => {
    const linha = document.createElement('label');
    linha.className = 'paidegua-julia-form__item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => {
      if (cb.checked) marcadas.add(i);
      else marcadas.delete(i);
      btn.disabled = marcadas.size === 0;
    });
    linha.appendChild(cb);
    linha.appendChild(document.createTextNode(limparMarcacao(s)));
    lista.appendChild(linha);
  });
  box.appendChild(lista);

  const aviso = document.createElement('div');
  aviso.className = 'paidegua-julia-form__hint';
  aviso.textContent = u.anonimizar
    ? 'Como a análise foi feita com texto anonimizado, a reescrita parte do texto anonimizado: a qualificação das partes e os dados mascarados não constam do resultado — confira ao levar para o PJe.'
    : 'A reescrita mantém as mesmas partes e dados da minuta original — confira o resultado antes de inserir no PJe.';
  box.appendChild(aviso);

  const acoes = document.createElement('div');
  acoes.className = 'paidegua-julia-form__acoes-esq';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-julia-form__btn';
  btn.textContent = 'Reescrever a minuta';
  btn.disabled = true;
  const cancelar = document.createElement('button');
  cancelar.type = 'button';
  cancelar.className = 'paidegua-julia-form__btn paidegua-julia-form__btn--ghost';
  cancelar.textContent = 'Cancelar';
  acoes.appendChild(btn);
  acoes.appendChild(cancelar);
  box.appendChild(acoes);

  const bolha = u.chat.addCustomBubble(box);
  cancelar.addEventListener('click', () => bolha.remove());
  btn.addEventListener('click', () => {
    const escolhidas = sugestoes.filter((_s, i) => marcadas.has(i));
    if (!escolhidas.length) return;
    bolha.remove();
    executarReescrita(u, escolhidas);
  });

  return true;
}

/**
 * Dispara a reescrita e conduz o streaming até a bolha final.
 *
 * A minuta reescrita sai com as ações padrão de minuta (Copiar / Inserir no
 * PJe / Baixar .doc) — daqui em diante ela é uma minuta como outra qualquer.
 */
function executarReescrita(u: UltimaAnalise, sugestoes: string[]): void {
  // Precedentes citados nas sugestões escolhidas: são o material que o
  // modelo tem permissão de citar por extenso na reescrita.
  const ns = new Set<number>();
  for (const s of sugestoes) {
    for (const m of s.matchAll(/\[(\d+)\]/g)) ns.add(Number(m[1]));
  }
  const precedentes: PrecedenteParaReescrita[] = [...ns]
    .sort((a, b) => a - b)
    .flatMap((n) => {
      const d = u.citaveis.get(n);
      return d ? [{ n, referencia: d.referencia, trecho: d.trecho }] : [];
    });

  u.chat.addUserMessage(
    `Reescrever a minuta aplicando ${sugestoes.length} sugestão(ões) da análise preditiva`
  );
  const statusNode = u.chat.addSystemText('Reescrevendo a minuta…');

  const port = chrome.runtime.connect({ name: PORT_NAMES.JULIA_STREAM });
  let aberto = false;
  let finalizado = false;
  const encerrar = (): void => {
    if (finalizado) return;
    finalizado = true;
    statusNode.remove();
    try {
      port.disconnect();
    } catch {
      /* já desconectada */
    }
  };

  port.onMessage.addListener((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case JULIA_PORT_MSG.CHUNK: {
        if (!aberto) {
          statusNode.remove();
          u.chat.beginAssistantMessage({
            // Rodapé de minuta comum + o reinício do ciclo: analisar de novo
            // (agora sobre a minuta reescrita, se o usuário a inserir).
            allowedActionIds: [
              'copy',
              'insert-pje',
              'download-doc',
              'analise-de-novo'
            ]
          });
          aberto = true;
        }
        u.chat.appendAssistantDelta(String(msg.delta ?? ''));
        break;
      }
      case JULIA_PORT_MSG.DONE: {
        if (aberto) u.chat.endAssistantMessage();
        encerrar();
        break;
      }
      case JULIA_PORT_MSG.ERROR: {
        const erro = String(msg.error ?? 'Falha ao reescrever a minuta.');
        if (aberto) u.chat.failAssistantMessage(erro);
        else {
          statusNode.remove();
          u.chat.addSystemText(erro);
        }
        encerrar();
        break;
      }
    }
  });
  port.onDisconnect.addListener(encerrar);

  port.postMessage({
    type: JULIA_PORT_MSG.START_REESCRITA,
    payload: {
      minutaTexto: u.minutaFormatada,
      anonimizar: u.anonimizar,
      sugestoes,
      precedentes,
      provider: u.provider,
      model: u.model
    }
  });
}
