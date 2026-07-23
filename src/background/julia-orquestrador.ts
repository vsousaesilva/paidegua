/**
 * Orquestração do "Fale com Júlia".
 *
 * Encadeia extração de filtros → recuperação nos dois escopos → síntese, e
 * reporta cada etapa pela porta para que a interface mostre progresso em vez de
 * ficar parada por vários segundos.
 *
 * ## Duas chamadas de LLM, uma recuperação
 *
 *   1. **Extração** (JSON mode, sem streaming): a pergunta vira termos de busca.
 *      Motor full-text recupera mal com frase em linguagem natural.
 *   2. **Recuperação**: `julia-rag.ts`, os dois escopos em paralelo.
 *   3. **Síntese** (streaming): a evidência vira resposta.
 *
 * ## Por que a evidência vai à interface antes do texto
 *
 * O evento `EVIDENCIA` leva os números reais — universo encontrado, quantos
 * foram lidos, quais fontes. A interface renderiza a base contada a partir
 * **desse dado**, não do que o modelo escrever.
 *
 * O prompt já obriga o modelo a declarar a amostra (§ regras 1 e 2 de
 * `julia-prompts.ts`), mas instrução de prompt é probabilística. O número que o
 * usuário vê na tela vem da recuperação, e não depende de o LLM cooperar. As
 * duas camadas juntas: o texto explica, a interface prova.
 */

import { LOG_PREFIX, JULIA_ETAPA, JULIA_PORT_MSG } from '../shared/constants';
import type { ProviderId } from '../shared/constants';
import { SYSTEM_PROMPT } from '../shared/prompts';
import {
  buildAnalisePreditivaExtracaoPrompt,
  buildAnalisePreditivaSintesePrompt,
  buildJuliaExtracaoPrompt,
  buildJuliaSintesePrompt,
  buildReescritaMinutaPrompt,
  parseAnalisePreditivaExtracao,
  parseJuliaExtracaoResponse,
  prepararTextoParaIA,
  removerOperadores,
  termosDePergunta,
  termosSalientesMinuta,
  type AnalisePreditivaExtracao,
  type JuliaExtracao,
  type PrecedenteParaReescrita
} from '../shared/julia/julia-prompts';
import { recuperar, type JuliaRecuperacao } from '../shared/julia/julia-rag';
import type { JuliaDocumento } from '../shared/julia/julia-types';
import { montarUrlDocumentoPje } from '../shared/julia/julia-identificador';
import {
  JuliaSessaoExpiradaError,
  listarOrgaosJulgadores,
  obterDataAtualizacao
} from '../shared/julia/julia-client-autenticado';
import type {
  JuliaInstancia,
  JuliaInstanciaAutenticada,
  JuliaOrgao
} from '../shared/julia/julia-types';
import { getProvider } from './providers';

/**
 * Lista os órgãos julgadores das instâncias pedidas, unidos e ordenados.
 *
 * A lista é **por instância** na Júlia: as varas comuns de uma seccional não são
 * as mesmas do JEF. Unimos porque o seletor da interface é único — e a busca
 * depois casa cada unidade com a instância certa.
 *
 * Instância que falhe individualmente não derruba as demais: melhor um seletor
 * parcial que um seletor vazio.
 */
/**
 * Ordena unidades na ordem que um servidor espera ler: 1ª, 2ª … 35ª, e depois
 * as que não começam por número, em ordem alfabética.
 *
 * Comparação de texto pura erra aqui: em `"10ª"` vs `"1ª"`, o segundo caractere
 * é `0` contra `ª`, e o dígito precede a letra — a lista começava na 10ª Vara e
 * só chegava à 1ª depois da 19ª.
 *
 * Não uso `localeCompare(..., { numeric: true })` porque ele resolveria o
 * número mas deixaria o posicionamento das entradas não numeradas a cargo da
 * collation. Aqui a regra fica explícita.
 */
function compararUnidades(a: string, b: string): number {
  const numeroDe = (s: string): number | null => {
    const m = /^\s*(\d+)/.exec(s);
    return m ? Number(m[1]) : null;
  };
  const na = numeroDe(a);
  const nb = numeroDe(b);

  if (na !== null && nb !== null) {
    return na !== nb ? na - nb : a.localeCompare(b, 'pt-BR');
  }
  // Numeradas primeiro; o resto vai para o fim, em ordem alfabética.
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a.localeCompare(b, 'pt-BR');
}

export async function listarOrgaosJulgadoresUnidos(
  orgao: JuliaOrgao,
  instancias: JuliaInstanciaAutenticada[]
): Promise<string[]> {
  const listas = await Promise.allSettled(
    instancias.map((i) => listarOrgaosJulgadores(orgao, i))
  );
  const uniao = new Set<string>();
  for (const r of listas) {
    if (r.status !== 'fulfilled') continue;
    for (const nome of r.value) if (nome?.trim()) uniao.add(nome.trim());
  }
  return [...uniao].sort(compararUnidades);
}

// ── Sonda de acesso e login assistido ────────────────────────────

/** URL de login da Júlia. */
const URL_LOGIN_JULIA = 'https://julia.trf5.jus.br/julia/entrar';

export type JuliaAcesso = 'autenticado' | 'sessao' | 'indisponivel';

/**
 * Sonda o acesso à Júlia pelo endpoint mais barato do conjunto.
 *
 * Distingue **sessão ausente** de **serviço fora do ar** de propósito: a
 * primeira se resolve logando, a segunda só esperando. Tratá-las igual faz o
 * usuário tentar logar cinco vezes contra um servidor indisponível.
 */
export async function verificarAcessoJulia(
  orgao: JuliaOrgao,
  instancia: JuliaInstanciaAutenticada
): Promise<JuliaAcesso> {
  try {
    await obterDataAtualizacao(orgao, instancia);
    return 'autenticado';
  } catch (err) {
    if (err instanceof JuliaSessaoExpiradaError) return 'sessao';
    console.warn(`${LOG_PREFIX} julia: sonda de acesso falhou:`, err);
    return 'indisponivel';
  }
}

/** Intervalo entre sondagens durante o login assistido. */
const LOGIN_POLL_MS = 3_000;
/** Teto da sondagem. Passado isso, paramos e devolvemos o controle ao usuário. */
const LOGIN_TIMEOUT_MS = 180_000;

let abortarLoginAnterior: (() => void) | null = null;

/**
 * Abre a Júlia em aba nova e acompanha até a autenticação acontecer.
 *
 * ## Por que sondar a API em vez de observar a página
 *
 * Detectar "o login terminou" pelo DOM ou pela URL seria adivinhação — e a
 * Júlia já mostrou que renumera identificadores entre versões. Sondar
 * `processos:data-atualizacao` testa exatamente a capacidade que interessa: a
 * extensão consegue falar com a API autenticada. É prova, não semelhança.
 *
 * Efeito colateral útil: chamar uma API do Chrome a cada 3s mantém o service
 * worker MV3 vivo, o mesmo recurso que o `stream-guard` usa contra o
 * encerramento por ociosidade.
 *
 * ## Guardas ao fechar a aba
 *
 * Fechar guia alheia é intrusivo. Só fechamos a que **nós** abrimos, e só se
 * ainda estiver na Júlia — se a pessoa navegou para outro lugar naquela aba,
 * deixamos aberta e apenas devolvemos o foco.
 */
export async function loginAssistidoJulia(
  orgao: JuliaOrgao,
  instancia: JuliaInstanciaAutenticada,
  tabOrigemId: number | undefined
): Promise<{ autenticado: boolean; motivo?: 'timeout' | 'aba-fechada' }> {
  // Clique novo cancela a sondagem anterior, para não acumular.
  abortarLoginAnterior?.();

  const aba = await chrome.tabs.create({ url: URL_LOGIN_JULIA, active: true });
  const abaId = aba.id;

  let cancelado = false;
  abortarLoginAnterior = () => {
    cancelado = true;
  };

  const inicio = Date.now();
  try {
    while (!cancelado && Date.now() - inicio < LOGIN_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
      if (cancelado) break;

      // Aba fechada pelo usuário = desistência. Não insistimos.
      if (abaId !== undefined && !(await abaExiste(abaId))) {
        return { autenticado: false, motivo: 'aba-fechada' };
      }

      if ((await verificarAcessoJulia(orgao, instancia)) === 'autenticado') {
        await fecharAbaSeAindaNaJulia(abaId);
        await focarAba(tabOrigemId);
        return { autenticado: true };
      }
    }
    return { autenticado: false, motivo: 'timeout' };
  } finally {
    if (abortarLoginAnterior) abortarLoginAnterior = null;
  }
}

async function abaExiste(abaId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(abaId);
    return true;
  } catch {
    return false;
  }
}

async function fecharAbaSeAindaNaJulia(abaId: number | undefined): Promise<void> {
  if (abaId === undefined) return;
  try {
    const aba = await chrome.tabs.get(abaId);
    // `url` vem preenchida por causa do host_permissions em *.jus.br. Se vier
    // vazia, preferimos NÃO fechar a fechar a aba errada.
    if (aba.url?.includes('julia.trf5.jus.br')) {
      await chrome.tabs.remove(abaId);
    }
  } catch {
    /* aba já não existe */
  }
}

async function focarAba(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    // Explícito: ao fechar uma guia o Chrome ativa a vizinha, não a anterior.
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    /* aba de origem já não existe */
  }
}

export interface JuliaStartPayload {
  pergunta: string;
  orgao: JuliaOrgao;
  /** Lista: varas de competência plena têm acervo em `G1` e `JEF`. */
  instancias: JuliaInstanciaAutenticada[];
  /** Unidades selecionadas. Vazio/ausente = toda a seccional. */
  orgaosJulgadores?: string[];
  /** Escolha explícita do usuário — não se infere da redação da pergunta. */
  compararComRevisor?: boolean;
  /**
   * `'publica'` no 2º grau do TRF5: só a API pública, escopo único, sem
   * confronto — não há instância revisora do Tribunal dentro do acervo.
   */
  modo?: 'dupla' | 'publica';
  /** Acervos públicos escolhidos no modo `'publica'`. */
  instanciasPublicas?: JuliaInstancia[];
  /**
   * Termos escritos pelo usuário. Quando presentes, **substituem** a extração
   * por LLM: quem conhece o vocabulário dos próprios julgados acerta mais que
   * qualquer heurística, e sobrescrever a escolha dele seria arrogante.
   */
  termosManuais?: string;
  provider: ProviderId;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface JuliaContexto {
  apiKey: string;
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  emitir: (msg: Record<string, unknown>) => void;
}

/**
 * Teto para a extração de termos.
 *
 * É uma chamada curta (algumas centenas de tokens) — se passar disso, algo
 * travou. Sem teto, o fluxo fica parado em "Interpretando a pergunta…" para
 * sempre, que foi o comportamento observado em campo.
 */
const TIMEOUT_EXTRACAO_MS = 30_000;

/** Teto para a recuperação nos dois escopos. */
const TIMEOUT_RECUPERACAO_MS = 90_000;

/**
 * Combina o sinal do usuário com um prazo.
 *
 * `AbortSignal.any` propaga o primeiro que disparar, então cancelar continua
 * funcionando e o prazo passa a existir.
 */
function comPrazo(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/** Consome o gerador de streaming até o fim e devolve o texto acumulado. */
async function gerarTextoCompleto(
  gen: AsyncGenerator<{ delta: string }, void, void>
): Promise<string> {
  let acc = '';
  for await (const c of gen) acc += c.delta;
  return acc;
}

/**
 * Extrai termos de busca da pergunta.
 *
 * Falha aqui **não derruba a consulta**: sem extração, usamos a pergunta crua
 * como termo. Recupera pior, mas responder mal é melhor que não responder — e o
 * usuário costuma escrever termos jurídicos de qualquer modo.
 */
async function extrair(
  payload: JuliaStartPayload,
  ctx: JuliaContexto
): Promise<JuliaExtracao> {
  // Termos derivados localmente — a pergunta crua num buscador léxico não
  // encontra nada, porque nenhuma sentença contém "qual o entendimento da vara".
  const termosLocais = termosDePergunta(payload.pergunta);
  const fallback: JuliaExtracao = {
    termo: termosLocais,
    termoSimples: termosLocais,
    dataInicial: null,
    dataFinal: null,
    escopos: { unidade: true, revisor: true }
  };

  // Termos escritos à mão passam direto — sem LLM, sem reinterpretação.
  if (payload.termosManuais?.trim()) {
    const manual = payload.termosManuais.trim();
    return {
      termo: manual,
      termoSimples: removerOperadores(manual),
      dataInicial: null,
      dataFinal: null,
      escopos: { unidade: true, revisor: true }
    };
  }

  try {
    const provider = getProvider(payload.provider);
    const prompt = buildJuliaExtracaoPrompt(payload.pergunta, {
      unidade: `${payload.orgao} / ${payload.instancias.join(' + ')}${payload.orgaosJulgadores?.length ? ` / ${payload.orgaosJulgadores.join(', ')}` : ''}`,
      hoje: new Date().toISOString().slice(0, 10)
    });

    const bruto = await gerarTextoCompleto(
      provider.sendMessage({
        apiKey: ctx.apiKey,
        model: payload.model,
        systemPrompt: 'Você converte perguntas em parâmetros de busca. Responde apenas JSON.',
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        // Determinismo: a mesma pergunta deve produzir a mesma busca.
        temperature: 0,
        maxTokens: 500,
        signal: comPrazo(ctx.signal, TIMEOUT_EXTRACAO_MS),
        responseFormat: 'json'
      })
    );

    return parseJuliaExtracaoResponse(bruto) ?? fallback;
  } catch (err) {
    // Cancelamento do usuário sobe; estouro de prazo (`TimeoutError`) não —
    // seguimos com a pergunta crua como termo, que recupera pior mas responde.
    if (err instanceof DOMException && err.name === 'AbortError' && !ctx.signal.aborted) {
      console.warn(`${LOG_PREFIX} julia: extração excedeu o prazo; usando pergunta crua.`);
      return fallback;
    }
    if (ctx.signal.aborted) throw err;
    console.warn(`${LOG_PREFIX} julia: extração falhou, usando pergunta crua:`, err);
    return fallback;
  }
}

/**
 * Referência do julgado, pronta para colar numa minuta.
 *
 * A API pública já entrega isso montado no campo `resumo`, no formato que o
 * próprio Tribunal usa — preferimos ele quando existe, em vez de reconstruir
 * algo parecido e divergir da convenção da casa.
 *
 * Na API autenticada `resumo` não vem, então montamos com os campos
 * disponíveis. Note que `relator` costuma vir vazio em primeiro grau (o
 * `nomeMagistrado` do payload é nulo nas capturas), daí a montagem por partes
 * presentes em vez de gabarito fixo.
 */
function montarReferencia(d: JuliaDocumento): string {
  if (d.resumo?.trim()) return d.resumo.trim();

  const data = (d.dataJulgamento ?? d.dataAssinatura ?? '').slice(0, 10);
  const partes = [
    d.numeroProcessoFormatado ?? d.numeroProcesso,
    d.classeJudicial,
    d.relator,
    d.orgaoJulgador,
    data ? `julgamento: ${data.split('-').reverse().join('/')}` : null
  ].filter((p): p is string => !!p?.trim());

  return partes.length ? `(${partes.join(', ')})` : '';
}

/** Resumo enviado à interface — números reais, sem texto de documento. */
function resumirEvidencia(r: JuliaRecuperacao) {
  // Numeração CONTÍNUA entre os escopos: o prompt cita por número, e numerar
  // cada bloco a partir de 1 tornava `[1]` ambíguo entre unidade e revisor.
  // O painel precisa usar exatamente os mesmos números da resposta.
  let proximo = 0;
  const lado = (e: typeof r.unidade) =>
    e
      ? {
          fontes: e.fontes,
          universo: e.universo,
          universoEhTeto: e.universoEhTeto,
          lidos: e.analisados.length,
          descartados: e.descartadosPorOrcamento,
          falhasLeitura: e.falhasLeitura,
          indisponivel: e.indisponivel?.motivo ?? null,
          processos: e.analisados.map((a) => ({
            n: ++proximo,
            numero: a.documento.numeroProcessoFormatado ?? a.documento.numeroProcesso,
            tipo: a.documento.tipoDocumento,
            orgaoJulgador: a.documento.orgaoJulgador,
            data: a.documento.dataJulgamento ?? a.documento.dataAssinatura,
            secao: a.trecho.secao,
            classe: a.documento.classeJudicial,
            // Trecho e texto integral enviados para a interface exibir e
            // copiar. Ficam na máquina do usuário: a anonimização vale para o
            // que sai ao provedor de IA, não para o que ele já acessa
            // legitimamente.
            trecho: a.trecho.texto,
            textoIntegral: a.documento.texto,
            dispositivo: a.trecho.dispositivo,
            referencia: montarReferencia(a.documento),
            // `urlPje` é só a base da instalação; o link do documento é montado
            // a partir dos ids embutidos no identificador.
            urlPje: montarUrlDocumentoPje(
              a.documento.codigoDocumento,
              a.documento.urlPje
            ),
            // O endpoint de download exige sessão do PJe NAQUELA instalação.
            // Servidor de primeiro grau costuma não ter acesso ao pjett (2º
            // grau), então oferecer o link ali seria beco sem saída — melhor
            // não mostrar do que mostrar quebrado.
            podeAbrirNoPje: /^(G1|JEF)$/i.test(a.documento.instancia ?? '')
          }))
        }
      : null;

  return {
    unidade: lado(r.unidade),
    revisor: lado(r.revisor),
    comparacaoPossivel: r.comparacaoPossivel,
    dataIndice: r.dataIndice
  };
}

export async function executarConsultaJulia(
  payload: JuliaStartPayload,
  ctx: JuliaContexto
): Promise<void> {
  const { emitir } = ctx;

  emitir({ type: JULIA_PORT_MSG.PROGRESSO, etapa: JULIA_ETAPA.EXTRAINDO });
  const extracao = await extrair(payload, ctx);

  emitir({
    type: JULIA_PORT_MSG.PROGRESSO,
    etapa: JULIA_ETAPA.BUSCANDO,
    detalhe: extracao.termo
  });

  const buscarCom = (termo: string): Promise<JuliaRecuperacao> =>
    recuperar({
      termo,
      orgao: payload.orgao,
      instancias: payload.instancias,
      orgaosJulgadores: payload.orgaosJulgadores,
      dataInicial: extracao.dataInicial ?? undefined,
      dataFinal: extracao.dataFinal ?? undefined,
      // Só no modo público: `instanciasPublicas` SOBREPÕE a derivação por
      // rito no RAG, e o contexto padrão da interface traz `['G2']` — passar
      // sempre fazia unidade JEF ser confrontada com o TRF5 em vez da Turma
      // Recursal (o `mapearOrgaoRevisor` nunca chegava a rodar).
      instanciasPublicas:
        payload.modo === 'publica' ? payload.instanciasPublicas : undefined,
      // No modo público não há escopo de unidade a consultar — a base
      // autenticada do 2º grau só cobre o que a pública já cobre.
      escopos:
        payload.modo === 'publica'
          ? { unidade: false, revisor: true }
          : {
              // A escolha do usuário prevalece sobre o que o LLM inferiu.
              unidade: extracao.escopos.unidade,
              revisor: payload.compararComRevisor ?? extracao.escopos.revisor
            },
      signal: comPrazo(ctx.signal, TIMEOUT_RECUPERACAO_MS)
    });

  const semResultado = (r: JuliaRecuperacao): boolean =>
    !r.unidade?.analisados.length && !r.revisor?.analisados.length;

  let termoUsado = extracao.termo;
  let recuperacao = await buscarCom(termoUsado);

  // Rede de segurança: consulta com operadores que volta vazia pode ser sintaxe
  // nossa errada, não ausência de acervo. Repetimos sem operadores antes de
  // afirmar ao usuário que não há nada — o custo é uma busca, e o erro
  // alternativo é dizer "não encontrei" sobre um acervo que tem o material.
  if (semResultado(recuperacao) && extracao.termoSimples !== termoUsado) {
    emitir({
      type: JULIA_PORT_MSG.PROGRESSO,
      etapa: JULIA_ETAPA.BUSCANDO,
      detalhe: extracao.termoSimples
    });
    const segunda = await buscarCom(extracao.termoSimples);
    if (!semResultado(segunda)) {
      termoUsado = extracao.termoSimples;
      recuperacao = segunda;
    }
  }

  emitir({
    type: JULIA_PORT_MSG.EVIDENCIA,
    evidencia: resumirEvidencia(recuperacao),
    termoUsado
  });

  const nadaLido =
    !recuperacao.unidade?.analisados.length &&
    !recuperacao.revisor?.analisados.length;

  if (nadaLido) {
    // Sem evidência não há o que sintetizar. Chamar o LLM aqui produziria
    // resposta a partir do conhecimento próprio dele — exatamente o que esta
    // funcionalidade existe para evitar.
    const sessaoCaiu =
      recuperacao.unidade?.indisponivel?.motivo === 'sessao';
    emitir({
      type: JULIA_PORT_MSG.ERROR,
      error: sessaoCaiu
        ? 'A sessão da Júlia expirou. Abra julia.trf5.jus.br, faça login e repita a pergunta.'
        : `Nenhum documento encontrado para "${termoUsado}". Em "Iniciar outra consulta" você pode editar os termos de busca — o campo já vem preenchido com os que foram usados.`,
      sessaoExpirada: sessaoCaiu
    });
    return;
  }

  // Guardada para permitir refazer só a síntese. A recuperação custou dezenas
  // de requisições ao servidor do TRF5; perdê-la por falha de cota do provedor
  // de IA seria desperdiçar recurso institucional por problema alheio a ele.
  ultimaRecuperacao = { tipo: 'consulta', payload, recuperacao };

  await sintetizar(payload, recuperacao, ctx);
}

/**
 * Última recuperação bem-sucedida, para refazer a síntese sem nova varredura.
 *
 * União discriminada porque a porta é compartilhada entre a consulta comum e a
 * análise preditiva: o `RETENTAR_SINTESE` da interface é único, e é o
 * background que sabe qual foi o último fluxo executado.
 */
let ultimaRecuperacao:
  | {
      tipo: 'consulta';
      payload: JuliaStartPayload;
      recuperacao: JuliaRecuperacao;
    }
  | {
      tipo: 'analise';
      payload: AnalisePreditivaStartPayload;
      minutaParaIA: string;
      extracao: AnalisePreditivaExtracao;
      recuperacao: JuliaRecuperacao;
    }
  | null = null;

/** Refaz a síntese sobre a evidência já recuperada. */
export async function retentarSinteseJulia(ctx: JuliaContexto): Promise<void> {
  if (!ultimaRecuperacao) {
    ctx.emitir({
      type: JULIA_PORT_MSG.ERROR,
      error: 'Não há consulta anterior para refazer. Inicie uma nova.'
    });
    return;
  }
  const anterior = ultimaRecuperacao;
  ctx.emitir({
    type: JULIA_PORT_MSG.EVIDENCIA,
    evidencia: resumirEvidencia(anterior.recuperacao),
    termoUsado:
      anterior.tipo === 'consulta'
        ? (anterior.payload.termosManuais ?? anterior.payload.pergunta)
        : anterior.extracao.termo
  });
  if (anterior.tipo === 'consulta') {
    await sintetizar(anterior.payload, anterior.recuperacao, ctx);
  } else {
    await sintetizarAnalise(
      anterior.payload,
      anterior.minutaParaIA,
      anterior.extracao,
      anterior.recuperacao,
      ctx
    );
  }
}

async function sintetizar(
  payload: JuliaStartPayload,
  recuperacao: JuliaRecuperacao,
  ctx: JuliaContexto
): Promise<void> {
  ctx.emitir({ type: JULIA_PORT_MSG.PROGRESSO, etapa: JULIA_ETAPA.SINTETIZANDO });

  const provider = getProvider(payload.provider);
  const generator = provider.sendMessage({
    apiKey: ctx.apiKey,
    model: payload.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildJuliaSintesePrompt(
          payload.pergunta,
          recuperacao,
          payload.modo ?? 'dupla'
        ),
        timestamp: Date.now()
      }
    ],
    // Temperatura baixa: síntese de jurisprudência não é tarefa criativa, e
    // variação aqui vira afirmação inventada.
    temperature: Math.min(ctx.temperature, 0.3),
    maxTokens: ctx.maxTokens,
    signal: ctx.signal
  });

  for await (const chunk of generator) {
    if (ctx.signal.aborted) break;
    ctx.emitir({ type: JULIA_PORT_MSG.CHUNK, delta: chunk.delta });
  }
  ctx.emitir({ type: JULIA_PORT_MSG.DONE });
}

// ── Análise preditiva de minutas ─────────────────────────────────

export interface AnalisePreditivaStartPayload {
  /** Texto cru lido do editor do PJe. */
  minutaTexto: string;
  /** A leitura cortou o texto no teto? A síntese precisa saber que viu parte. */
  minutaTruncada: boolean;
  /**
   * Anonimizar a minuta antes de enviá-la ao provedor de IA? Escolha do
   * magistrado no formulário (dois botões). A minuta é o rascunho dele, no
   * próprio navegador — quando opta por não anonimizar, envia o texto como
   * está; quando opta por anonimizar, aplica-se `prepararTextoParaIA` (mesma
   * política dos documentos da Júlia).
   */
  anonimizar: boolean;
  orgao: JuliaOrgao;
  instancias: JuliaInstanciaAutenticada[];
  orgaosJulgadores?: string[];
  /** `'publica'` no 2º grau: aderência ao próprio colegiado, sem confronto. */
  modo?: 'dupla' | 'publica';
  instanciasPublicas?: JuliaInstancia[];
  /** Termos escritos pelo usuário — substituem os termos extraídos, não as teses. */
  termosManuais?: string;
  provider: ProviderId;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Teto para a extração de teses da minuta.
 *
 * Maior que o da consulta comum (30s): a entrada não é uma pergunta de duas
 * linhas, é uma minuta que pode ter dezenas de páginas.
 */
const TIMEOUT_EXTRACAO_ANALISE_MS = 60_000;

/**
 * Extrai teses e termos de busca da minuta.
 *
 * Diferente da consulta comum, termos manuais NÃO pulam o LLM: eles substituem
 * apenas a consulta de busca — as teses continuam vindo da extração, porque o
 * confronto ponto a ponto depende delas.
 */
async function extrairDaMinuta(
  payload: AnalisePreditivaStartPayload,
  minutaParaIA: string,
  ctx: JuliaContexto
): Promise<AnalisePreditivaExtracao> {
  // Rede de segurança local, por FREQUÊNCIA sobre o texto inteiro — sem recorte
  // por posição, que cortava no meio de palavra e envenenava a busca E com um
  // fragmento inexistente. `termo` com mais termos; `termoSimples` com menos,
  // para o retro-alargamento do orquestrador (retry com termoSimples) valer.
  const termosLocais = termosSalientesMinuta(minutaParaIA, 3);
  const termosAmplos = termosSalientesMinuta(minutaParaIA, 2);
  const fallback: AnalisePreditivaExtracao = {
    termo: termosLocais || termosDePergunta(minutaParaIA),
    termoSimples: termosAmplos || termosLocais,
    teses: [],
    sentido: null,
    materia: ''
  };

  let extracao: AnalisePreditivaExtracao;
  try {
    const provider = getProvider(payload.provider);
    const prompt = buildAnalisePreditivaExtracaoPrompt(minutaParaIA, {
      unidade: `${payload.orgao} / ${payload.instancias.join(' + ')}${payload.orgaosJulgadores?.length ? ` / ${payload.orgaosJulgadores.join(', ')}` : ''}`,
      hoje: new Date().toISOString().slice(0, 10)
    });

    const bruto = await gerarTextoCompleto(
      provider.sendMessage({
        apiKey: ctx.apiKey,
        model: payload.model,
        systemPrompt:
          'Você decompõe minutas judiciais em teses e parâmetros de busca. Responde apenas JSON.',
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        temperature: 0,
        // As teses ocupam mais espaço que os filtros da consulta comum.
        maxTokens: 1500,
        signal: comPrazo(ctx.signal, TIMEOUT_EXTRACAO_ANALISE_MS),
        responseFormat: 'json'
      })
    );

    extracao = parseAnalisePreditivaExtracao(bruto) ?? fallback;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError' && !ctx.signal.aborted) {
      console.warn(`${LOG_PREFIX} julia: extração da minuta excedeu o prazo; usando termos locais.`);
      extracao = fallback;
    } else if (ctx.signal.aborted) {
      throw err;
    } else {
      console.warn(`${LOG_PREFIX} julia: extração da minuta falhou, usando termos locais:`, err);
      extracao = fallback;
    }
  }

  if (payload.termosManuais?.trim()) {
    const manual = payload.termosManuais.trim();
    return { ...extracao, termo: manual, termoSimples: removerOperadores(manual) };
  }
  return extracao;
}

export async function executarAnalisePreditiva(
  payload: AnalisePreditivaStartPayload,
  ctx: JuliaContexto
): Promise<void> {
  const { emitir } = ctx;

  emitir({ type: JULIA_PORT_MSG.PROGRESSO, etapa: JULIA_ETAPA.EXTRAINDO });

  // Anonimização é escolha do magistrado (dois botões). Quando escolhe
  // anonimizar, aplica-se `prepararTextoParaIA` antes de qualquer chamada de
  // LLM — mesma política dos documentos da Júlia; quando não, o rascunho vai
  // como está. O texto (anonimizado ou não) só sai daqui para o provedor de IA
  // que o próprio usuário configurou.
  const minutaParaIA = payload.anonimizar
    ? prepararTextoParaIA(payload.minutaTexto)
    : payload.minutaTexto;
  const extracao = await extrairDaMinuta(payload, minutaParaIA, ctx);

  emitir({
    type: JULIA_PORT_MSG.PROGRESSO,
    etapa: JULIA_ETAPA.BUSCANDO,
    detalhe: extracao.termo
  });

  const buscarCom = (termo: string): Promise<JuliaRecuperacao> =>
    recuperar({
      termo,
      orgao: payload.orgao,
      instancias: payload.instancias,
      orgaosJulgadores: payload.orgaosJulgadores,
      // Só no modo público — ver comentário homólogo em `executarConsultaJulia`.
      instanciasPublicas:
        payload.modo === 'publica' ? payload.instanciasPublicas : undefined,
      // O confronto com o revisor é a razão de ser da análise — sempre ligado.
      escopos:
        payload.modo === 'publica'
          ? { unidade: false, revisor: true }
          : { unidade: true, revisor: true },
      signal: comPrazo(ctx.signal, TIMEOUT_RECUPERACAO_MS)
    });

  const semResultado = (r: JuliaRecuperacao): boolean =>
    !r.unidade?.analisados.length && !r.revisor?.analisados.length;

  let termoUsado = extracao.termo;
  let recuperacao = await buscarCom(termoUsado);

  if (semResultado(recuperacao) && extracao.termoSimples !== termoUsado) {
    emitir({
      type: JULIA_PORT_MSG.PROGRESSO,
      etapa: JULIA_ETAPA.BUSCANDO,
      detalhe: extracao.termoSimples
    });
    const segunda = await buscarCom(extracao.termoSimples);
    if (!semResultado(segunda)) {
      termoUsado = extracao.termoSimples;
      recuperacao = segunda;
    }
  }

  emitir({
    type: JULIA_PORT_MSG.EVIDENCIA,
    evidencia: resumirEvidencia(recuperacao),
    termoUsado
  });

  if (semResultado(recuperacao)) {
    const sessaoCaiu = recuperacao.unidade?.indisponivel?.motivo === 'sessao';
    emitir({
      type: JULIA_PORT_MSG.ERROR,
      error: sessaoCaiu
        ? 'A sessão da Júlia expirou. Abra julia.trf5.jus.br, faça login e repita a análise.'
        : `Nenhum julgado encontrado para "${termoUsado}". Repita a análise informando termos de busca manuais — o campo já vem preenchido com os que foram usados.`,
      sessaoExpirada: sessaoCaiu
    });
    return;
  }

  ultimaRecuperacao = {
    tipo: 'analise',
    payload,
    minutaParaIA,
    extracao,
    recuperacao
  };

  await sintetizarAnalise(payload, minutaParaIA, extracao, recuperacao, ctx);
}

async function sintetizarAnalise(
  payload: AnalisePreditivaStartPayload,
  minutaParaIA: string,
  extracao: AnalisePreditivaExtracao,
  recuperacao: JuliaRecuperacao,
  ctx: JuliaContexto
): Promise<void> {
  ctx.emitir({ type: JULIA_PORT_MSG.PROGRESSO, etapa: JULIA_ETAPA.SINTETIZANDO });

  const minutaComAviso = payload.minutaTruncada
    ? `${minutaParaIA}\n\n[AVISO AO ANALISTA: a minuta excedeu o limite de leitura e o trecho intermediário foi omitido. Considere isso ao avaliar completude.]`
    : minutaParaIA;

  const provider = getProvider(payload.provider);
  const generator = provider.sendMessage({
    apiKey: ctx.apiKey,
    model: payload.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildAnalisePreditivaSintesePrompt(
          minutaComAviso,
          extracao,
          recuperacao,
          payload.modo ?? 'dupla'
        ),
        timestamp: Date.now()
      }
    ],
    temperature: Math.min(ctx.temperature, 0.3),
    maxTokens: ctx.maxTokens,
    signal: ctx.signal
  });

  for await (const chunk of generator) {
    if (ctx.signal.aborted) break;
    ctx.emitir({ type: JULIA_PORT_MSG.CHUNK, delta: chunk.delta });
  }
  ctx.emitir({ type: JULIA_PORT_MSG.DONE });
}

export interface ReescritaStartPayload {
  /** Texto (markdown) da minuta atual. */
  minutaTexto: string;
  /** Anonimizar antes do LLM? Segue a mesma escolha feita na análise. */
  anonimizar: boolean;
  /** Sugestões escolhidas pelo magistrado, no texto em que apareceram. */
  sugestoes: string[];
  /** Precedentes citados nas sugestões escolhidas (trecho + referência). */
  precedentes: PrecedenteParaReescrita[];
  provider: ProviderId;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Reescreve a minuta aplicando as sugestões escolhidas.
 *
 * Uma única chamada de LLM em streaming — sem tocar a Júlia: os precedentes
 * necessários já foram recuperados na análise e viajam no payload.
 */
export async function executarReescritaMinuta(
  payload: ReescritaStartPayload,
  ctx: JuliaContexto
): Promise<void> {
  ctx.emitir({ type: JULIA_PORT_MSG.PROGRESSO, etapa: JULIA_ETAPA.SINTETIZANDO });

  const provider = getProvider(payload.provider);
  const generator = provider.sendMessage({
    apiKey: ctx.apiKey,
    model: payload.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildReescritaMinutaPrompt(
          payload.anonimizar
            ? prepararTextoParaIA(payload.minutaTexto)
            : payload.minutaTexto,
          payload.sugestoes,
          payload.precedentes
        ),
        timestamp: Date.now()
      }
    ],
    // Ainda mais baixa que a síntese: a tarefa é reprodução literal com
    // enxertos pontuais — variação aqui é infidelidade ao texto.
    temperature: Math.min(ctx.temperature, 0.2),
    // A saída é a minuta INTEIRA: o teto das configurações (pensado para
    // respostas de chat) pode não comportá-la.
    maxTokens: Math.max(ctx.maxTokens, 8192),
    signal: ctx.signal
  });

  for await (const chunk of generator) {
    if (ctx.signal.aborted) break;
    ctx.emitir({ type: JULIA_PORT_MSG.CHUNK, delta: chunk.delta });
  }
  ctx.emitir({ type: JULIA_PORT_MSG.DONE });
}

/** Mensagem de erro legível, distinguindo sessão do resto. */
export function mensagemErroJulia(err: unknown): {
  error: string;
  sessaoExpirada: boolean;
} {
  if (err instanceof JuliaSessaoExpiradaError) {
    return { error: err.message, sessaoExpirada: true };
  }
  return { error: `Falha ao consultar a Júlia: ${String(err)}`, sessaoExpirada: false };
}
