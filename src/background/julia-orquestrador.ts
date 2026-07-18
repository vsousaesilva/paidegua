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
  buildJuliaExtracaoPrompt,
  buildJuliaSintesePrompt,
  parseJuliaExtracaoResponse,
  removerOperadores,
  termosDePergunta,
  type JuliaExtracao
} from '../shared/julia/julia-prompts';
import { recuperar, type JuliaRecuperacao } from '../shared/julia/julia-rag';
import { montarUrlDocumentoPje } from '../shared/julia/julia-identificador';
import {
  JuliaSessaoExpiradaError,
  listarOrgaosJulgadores
} from '../shared/julia/julia-client-autenticado';
import type {
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

/** Resumo enviado à interface — números reais, sem texto de documento. */
function resumirEvidencia(r: JuliaRecuperacao) {
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
            numero: a.documento.numeroProcessoFormatado ?? a.documento.numeroProcesso,
            tipo: a.documento.tipoDocumento,
            orgaoJulgador: a.documento.orgaoJulgador,
            data: a.documento.dataJulgamento ?? a.documento.dataAssinatura,
            secao: a.trecho.secao,
            // `urlPje` é só a base da instalação; o link do documento é montado
            // a partir dos ids embutidos no identificador.
            urlPje: montarUrlDocumentoPje(
              a.documento.codigoDocumento,
              a.documento.urlPje
            )
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
      // A escolha do usuário prevalece sobre o que o LLM inferiu da redação.
      escopos: {
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

  emitir({ type: JULIA_PORT_MSG.PROGRESSO, etapa: JULIA_ETAPA.SINTETIZANDO });

  const provider = getProvider(payload.provider);
  const generator = provider.sendMessage({
    apiKey: ctx.apiKey,
    model: payload.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildJuliaSintesePrompt(payload.pergunta, recuperacao),
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
    emitir({ type: JULIA_PORT_MSG.CHUNK, delta: chunk.delta });
  }
  emitir({ type: JULIA_PORT_MSG.DONE });
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
