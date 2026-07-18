/**
 * Recuperação de evidência na Júlia para a análise dupla do "Fale com Júlia".
 *
 * ## Escopo deste módulo
 *
 * Busca, seleciona e segmenta. **Não monta prompt e não conhece a interface de
 * conversa** — devolve estrutura, e quem chama decide como apresentar.
 *
 * O desacoplamento é deliberado: a etapa de minutas (hoje fora de escopo, ver
 * `docs/plano-julia-funcionalidades.md` §3) precisará exatamente desta
 * recuperação, e não deve exigir reescrita quando for retomada.
 *
 * ## Os dois escopos
 *
 * | Escopo | Pergunta | Fonte |
 * |---|---|---|
 * | `unidade` | como a unidade vem entendendo | API autenticada (G1/JEF) |
 * | `revisor` | como o órgão revisor vem decidindo | API pública (G2/TR/TRU) |
 *
 * O revisor **deriva do rito**, não é escolha do usuário: JEF é revisado pela
 * Turma Recursal da seccional, vara comum pelo TRF5. Confrontar sentença de JEF
 * com acórdão do TRF5 mede a unidade contra um tribunal que não a revisa.
 *
 * ## Orçamento assimétrico — de propósito
 *
 * No escopo revisor, ementas são curtas e densas: dá para ler muitas. No escopo
 * da unidade, a razão de decidir está na fundamentação, que é longa e não
 * comprime (ver `julia-segmentador.ts`). Poucas sentenças lidas a fundo valem
 * mais que muitas reduzidas a desfecho.
 *
 * Quando o teto de caracteres é atingido, **descartamos documentos inteiros** em
 * vez de truncar texto — e o contador de analisados cai junto. Truncar produziria
 * razão de decidir pela metade; e um contador que não reflete o que foi lido
 * quebra a honestidade da base contada, que é a mitigação central da feature.
 */

import { LOG_PREFIX } from '../constants';
import { buscarJulia } from './julia-client';
import { chaveDeduplicacao } from './julia-identificador';
import { tiposPorInstancia } from './julia-types';
import {
  JuliaSessaoExpiradaError,
  buscarDocumentos,
  obterDataAtualizacao,
  obterInteiroTeor,
  obterSumario
} from './julia-client-autenticado';
import { segmentar, type JuliaTrecho } from './julia-segmentador';
import type {
  JuliaDocumento,
  JuliaInstancia,
  JuliaInstanciaAutenticada,
  JuliaOrgao,
  JuliaSeccional
} from './julia-types';

// ── Orçamentos ───────────────────────────────────────────────────

/**
 * Quanto ler por escopo.
 *
 * Os valores iniciais (4 documentos / 26 mil chars na unidade) eram
 * conservadores demais e produziram "1 lida de 241" em campo — amostra que não
 * sustenta afirmação nenhuma sobre entendimento. Foram calibrados por receio do
 * tamanho da fundamentação, não pela capacidade real dos modelos: 26 mil
 * caracteres são ~6,5 mil tokens, uma fração do que qualquer modelo atual
 * comporta.
 *
 * ## Por que os dois escopos têm tetos diferentes
 *
 * O revisor usa a API pública, que devolve o **inteiro teor na própria busca**:
 * 24 documentos custam **uma** requisição. O escopo da unidade usa a API
 * autenticada, cuja busca devolve apenas trecho — cada inteiro teor é uma
 * requisição a mais ao servidor de produção do TRF5.
 *
 * Por isso o revisor é mais generoso: ampliá-lo é quase de graça, enquanto
 * ampliar a unidade tem custo linear em carga para o Tribunal.
 *
 * ## Por que não subir mais
 *
 * Não é contexto nem custo — ~55 mil tokens de entrada cabem folgados em
 * qualquer provedor suportado e custam frações de centavo. São dois outros
 * fatores:
 *
 *   1. **Carga.** 16 documentos na unidade são 16 requisições de inteiro teor
 *      por pergunta, somadas às buscas.
 *   2. **Qualidade não é monotônica.** O ganho é grande até ~10 documentos,
 *      decrescente até ~20, e acima de ~30 tende a piorar: modelos atendem
 *      menos ao miolo de contextos longos, e documentos marginais diluem o
 *      sinal. Reconhecer um padrão de entendimento pede dezenas, não centenas.
 */
const ORCAMENTO = {
  unidade: { documentos: 16, maxChars: 120_000 },
  revisor: { documentos: 24, maxChars: 90_000 }
} as const;

/** Quantos resultados pedir por escopo antes de selecionar. */
const CANDIDATOS_POR_ESCOPO = 25;

/**
 * Teto de buscas (instância × unidade) no escopo da unidade.
 *
 * Cada combinação são **duas** requisições (busca + sumário) a um servidor de
 * produção do TRF5. Sem teto, marcar 2 instâncias e 10 unidades dispararia 40
 * requisições numa pergunta — carga desproporcional para uma consulta
 * interativa. O excedente é reportado, não silenciado.
 */
const MAX_COMBINACOES = 8;

// ── Mapeamento do órgão revisor ──────────────────────────────────

const UF_POR_ORGAO: Partial<Record<JuliaOrgao, JuliaSeccional>> = {
  JFAL: 'AL',
  JFCE: 'CE',
  JFPB: 'PB',
  JFPE: 'PE',
  JFRN: 'RN',
  JFSE: 'SE'
};

/**
 * Instâncias da API pública que revisam as instâncias consultadas.
 *
 * Recebe **lista**, não valor único, porque varas de **competência plena** têm
 * acervo em `G1` e `JEF` ao mesmo tempo — e são revisadas pelos dois caminhos,
 * conforme o rito de cada processo. Mapear só um eixo perderia metade das
 * decisões e compararia a unidade com um tribunal que revisa só parte delas.
 *
 * Devolve lista vazia quando não há revisor a consultar — caso de `TRF5`, que já
 * é a segunda instância. Nesse cenário a feature responde só o escopo da
 * unidade, e a comparação não se aplica (não é falha).
 */
export function mapearOrgaoRevisor(
  orgao: JuliaOrgao,
  instancias: readonly JuliaInstanciaAutenticada[]
): JuliaInstancia[] {
  if (orgao === 'TRF5') return [];

  const uf = UF_POR_ORGAO[orgao];
  const saida = new Set<JuliaInstancia>();

  for (const inst of instancias) {
    if (inst === 'JEF') {
      // Turma Recursal da seccional; a TRU uniformiza acima dela.
      if (uf) saida.add(`TR_${uf}` as JuliaInstancia);
      saida.add('TRU');
    } else if (inst === 'G1') {
      saida.add('G2');
    }
    // `TR`/`TRU` como unidade consultada: já são recursais, nada acima no acervo.
  }
  return [...saida];
}

// ── Formas de saída ──────────────────────────────────────────────

export interface JuliaEvidencia {
  documento: JuliaDocumento;
  trecho: JuliaTrecho;
}

export interface JuliaEscopoResultado {
  escopo: 'unidade' | 'revisor';
  /** Instâncias efetivamente consultadas. */
  fontes: string[];
  /** Total de documentos que casaram com os filtros — a base contada. */
  universo: number;
  /** `true` quando `universo` bateu no teto do motor de busca e é um piso. */
  universoEhTeto: boolean;
  /** O que de fato foi lido e vai ao prompt. */
  analisados: JuliaEvidencia[];
  /** Descartados por não caberem no orçamento de caracteres. */
  descartadosPorOrcamento: number;
  /**
   * Documentos cujo inteiro teor não pôde ser lido — falha de rede ou sigilo.
   *
   * Contado à parte de `descartadosPorOrcamento` de propósito: "não coube" e
   * "não consegui ler" têm causas e correções distintas, e somá-los esconde
   * exatamente o diagnóstico de que se precisa quando a amostra vem pequena.
   */
  falhasLeitura: number;
  charsTotal: number;
  /** Preenchido quando o escopo não pôde ser consultado. */
  indisponivel?: { motivo: 'sessao' | 'erro'; detalhe: string };
}

export interface JuliaRecuperacao {
  unidade: JuliaEscopoResultado | null;
  revisor: JuliaEscopoResultado | null;
  /**
   * `true` só quando **os dois** escopos têm base contada e ao menos um
   * documento lido.
   *
   * Regra do plano (§2.0): divergência nunca se infere de ausência. Com um lado
   * indisponível, apresenta-se o que há e diz-se que a comparação não foi
   * possível — jamais "a unidade diverge".
   */
  comparacaoPossivel: boolean;
  /** Data da última carga do índice da unidade. Exibir sempre. */
  dataIndice: string | null;
}

export interface JuliaConsulta {
  termo: string;
  orgao: JuliaOrgao;
  /**
   * Instâncias da unidade — **lista**, porque varas de competência plena têm
   * acervo em `G1` e `JEF` simultaneamente.
   */
  instancias: readonly JuliaInstanciaAutenticada[];
  /**
   * Unidades a consultar. Vazio/ausente = seccional inteira.
   *
   * Cada unidade vira uma busca por instância — ver `MAX_COMBINACOES`.
   */
  orgaosJulgadores?: readonly string[];
  dataInicial?: string;
  dataFinal?: string;
  escopos?: { unidade?: boolean; revisor?: boolean };
  signal?: AbortSignal;
}

// ── Seleção sob orçamento ────────────────────────────────────────

/**
 * Corta a lista no teto de caracteres, descartando documentos inteiros.
 *
 * Percorre na ordem de relevância e **pula** o que não couber, seguindo para o
 * próximo, em vez de parar na primeira não-couber.
 *
 * Isso reverte uma decisão anterior. A versão original parava no primeiro
 * documento que estourasse, para não subverter a ordenação por relevância em
 * favor de tamanho. O argumento era coerente, mas o resultado em campo foi
 * "1 lida de 3.195": um acórdão longo consumia a cota e nada mais entrava.
 *
 * Sintetizar entendimento a partir de um documento é base fraca demais — e essa
 * fraqueza custa mais que a leve distorção de ordem. Cinco documentos um pouco
 * menos relevantes valem mais que um muito relevante.
 *
 * O que **não** mudou: nada é truncado. Documento que não cabe fica de fora
 * inteiro e é contado em `descartadas`, para a base contada seguir verdadeira.
 */
function aplicarOrcamento(
  evidencias: JuliaEvidencia[],
  maxChars: number
): { selecionadas: JuliaEvidencia[]; descartadas: number; chars: number } {
  const selecionadas: JuliaEvidencia[] = [];
  let chars = 0;
  for (const e of evidencias) {
    const custo = e.trecho.texto.length;
    // O primeiro entra sempre, mesmo estourando: melhor uma evidência longa
    // que nenhuma.
    if (chars + custo > maxChars && selecionadas.length > 0) continue;
    selecionadas.push(e);
    chars += custo;
  }
  return {
    selecionadas,
    descartadas: evidencias.length - selecionadas.length,
    chars
  };
}

// ── Escopo da unidade (API autenticada) ──────────────────────────

/**
 * Recupera no escopo da unidade, percorrendo **todas** as instâncias
 * selecionadas.
 *
 * Vara de competência plena tem acervo em `G1` e `JEF`; consultar só um eixo
 * devolveria metade do que ela decidiu, sem qualquer sinal de que faltou algo —
 * o pior tipo de erro nesta funcionalidade, porque a resposta pareceria
 * completa.
 */
async function recuperarUnidade(c: JuliaConsulta): Promise<JuliaEscopoResultado> {
  const base: JuliaEscopoResultado = {
    escopo: 'unidade',
    fontes: c.orgaosJulgadores?.length
      ? c.orgaosJulgadores.map((u) => u)
      : c.instancias.map((i) => `${c.orgao}/${i}`),
    universo: 0,
    universoEhTeto: false,
    analisados: [],
    descartadosPorOrcamento: 0,
    falhasLeitura: 0,
    charsTotal: 0
  };

  try {
    // Produto instância × unidade. Sem unidade selecionada, `undefined` busca a
    // seccional inteira — que é o comportamento da interface do própria Júlia.
    const unidades: Array<string | undefined> = c.orgaosJulgadores?.length
      ? [...c.orgaosJulgadores]
      : [undefined];

    const combinacoes: Array<{
      instancia: JuliaInstanciaAutenticada;
      orgaoJulgador: string | undefined;
    }> = [];
    for (const instancia of c.instancias) {
      for (const orgaoJulgador of unidades) {
        combinacoes.push({ instancia, orgaoJulgador });
      }
    }

    const excedentes = Math.max(0, combinacoes.length - MAX_COMBINACOES);
    if (excedentes > 0) {
      console.warn(
        `${LOG_PREFIX} julia-rag: ${combinacoes.length} combinações pedidas; consultando ${MAX_COMBINACOES}.`
      );
    }

    const porInstancia = await Promise.all(
      combinacoes.slice(0, MAX_COMBINACOES).map(async ({ instancia, orgaoJulgador }) => {
        const filtros = {
          orgao: c.orgao,
          instancia,
          termo: c.termo,
          orgaoJulgador,
          dataInicial: c.dataInicial,
          dataFinal: c.dataFinal,
          // Dois filtros num só: exclui peça de parte (petição, contestação) e
          // exclui ato de outra instância. A Júlia indexa por processo, então
          // sem isto o acórdão do recurso vem junto com a sentença da vara.
          tiposDocumento: tiposPorInstancia(instancia),
          length: CANDIDATOS_POR_ESCOPO
        };

        // O sumário dá o universo real sem baixar documento — é o que sustenta
        // o "de N encontradas, analisadas M" exigido pelo plano.
        const [busca, sumario] = await Promise.all([
          buscarDocumentos(filtros, { signal: c.signal }),
          obterSumario(filtros, { signal: c.signal }).catch(() => [])
        ]);
        const universoSumario = sumario.reduce((s, i) => s + (i.quantidade ?? 0), 0);
        return {
          universo: universoSumario || busca.total,
          ehTeto: busca.totalEhTeto,
          documentos: busca.documentos
        };
      })
    );

    for (const r of porInstancia) {
      base.universo += r.universo;
      base.universoEhTeto ||= r.ehTeto;
    }

    // Mantém a ordem de relevância que o própria Júlia monta — o motor de busca
    // do Tribunal conhece o acervo melhor que qualquer reordenação nossa.
    // Intercalamos apenas para que uma instância com acervo maior não
    // monopolize as vagas, e deduplicamos entre as buscas antes de cortar.
    const candidatos = deduplicarEntreBuscas(
      intercalarListas(porInstancia.map((r) => r.documentos))
    ).slice(0, ORCAMENTO.unidade.documentos);

    // A busca autenticada devolve trecho; a razão de decidir exige o inteiro
    // teor. Paralelo e tolerante: documento que falhe individualmente não
    // derruba o escopo.
    const completos = await Promise.allSettled(
      candidatos.map((d) => obterInteiroTeor(d.codigoDocumento, { signal: c.signal }))
    );

    const evidencias: JuliaEvidencia[] = [];
    let falhas = 0;
    for (const r of completos) {
      // `null` = sigiloso recusado pelo cliente, ou ausente.
      if (r.status !== 'fulfilled' || !r.value) {
        falhas++;
        continue;
      }
      evidencias.push({ documento: r.value, trecho: segmentar(r.value) });
    }
    base.falhasLeitura = falhas;
    if (falhas > 0) {
      console.warn(
        `${LOG_PREFIX} julia-rag: ${falhas} de ${candidatos.length} inteiro(s) teor(es) não lido(s).`
      );
    }

    const { selecionadas, descartadas, chars } = aplicarOrcamento(
      evidencias,
      ORCAMENTO.unidade.maxChars
    );
    base.analisados = selecionadas;
    base.descartadosPorOrcamento = descartadas;
    base.charsTotal = chars;
    return base;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (err instanceof JuliaSessaoExpiradaError) {
      base.indisponivel = { motivo: 'sessao', detalhe: err.message };
      return base;
    }
    console.warn(`${LOG_PREFIX} julia-rag: escopo unidade falhou:`, err);
    base.indisponivel = { motivo: 'erro', detalhe: String(err) };
    return base;
  }
}

// ── Escopo revisor (API pública) ─────────────────────────────────

async function recuperarRevisor(
  c: JuliaConsulta,
  instancias: JuliaInstancia[]
): Promise<JuliaEscopoResultado> {
  const base: JuliaEscopoResultado = {
    escopo: 'revisor',
    fontes: instancias,
    universo: 0,
    universoEhTeto: false,
    analisados: [],
    descartadosPorOrcamento: 0,
    falhasLeitura: 0,
    charsTotal: 0
  };

  try {
    const buscas = await Promise.allSettled(
      instancias.map((inst) =>
        buscarJulia(
          {
            instancia: inst,
            pesquisaLivre: c.termo,
            dataIni: c.dataInicial,
            dataFim: c.dataFinal,
            length: CANDIDATOS_POR_ESCOPO
          },
          { signal: c.signal }
        )
      )
    );

    const evidencias: JuliaEvidencia[] = [];
    for (const r of buscas) {
      if (r.status !== 'fulfilled') continue;
      base.universo += r.value.total;
      base.universoEhTeto ||= r.value.totalEhTeto;
      // A API pública já entrega o documento completo — sem round-trip extra.
      for (const d of r.value.documentos) {
        evidencias.push({ documento: d, trecho: segmentar(d) });
      }
    }

    if (!evidencias.length && buscas.every((r) => r.status === 'rejected')) {
      base.indisponivel = { motivo: 'erro', detalhe: 'Todas as buscas falharam.' };
      return base;
    }

    // Intercala as instâncias para não deixar uma monopolizar o orçamento
    // quando devolve muitos resultados; deduplica entre elas em seguida.
    const unicos = new Set<string>();
    const intercaladas = intercalarPorFonte(evidencias, instancias).filter((e) => {
      const chave = chaveDeduplicacao(e.documento.codigoDocumento);
      if (unicos.has(chave)) return false;
      unicos.add(chave);
      return true;
    });
    const { selecionadas, descartadas, chars } = aplicarOrcamento(
      intercaladas.slice(0, ORCAMENTO.revisor.documentos),
      ORCAMENTO.revisor.maxChars
    );
    base.analisados = selecionadas;
    base.descartadosPorOrcamento =
      descartadas + Math.max(0, intercaladas.length - ORCAMENTO.revisor.documentos);
    base.charsTotal = chars;
    return base;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    console.warn(`${LOG_PREFIX} julia-rag: escopo revisor falhou:`, err);
    base.indisponivel = { motivo: 'erro', detalhe: String(err) };
    return base;
  }
}

/**
 * Remove documentos repetidos **entre** as buscas de um mesmo escopo.
 *
 * Cada busca já deduplica internamente, mas o escopo da unidade junta várias
 * combinações (instância × unidade) e o revisor junta várias instâncias — o
 * mesmo documento aparece em mais de uma e passava duas vezes, ocupando duas
 * vagas do orçamento com o mesmo conteúdo.
 *
 * Usa a mesma chave de conteúdo do cliente (`idProcesso:idBinario`), e não o
 * identificador integral: dois registros do mesmo binário são o mesmo documento.
 */
function deduplicarEntreBuscas(docs: JuliaDocumento[]): JuliaDocumento[] {
  const vistos = new Set<string>();
  const saida: JuliaDocumento[] = [];
  for (const d of docs) {
    const chave = chaveDeduplicacao(d.codigoDocumento);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(d);
  }
  return saida;
}

/** Alterna entre listas, uma de cada vez, até esgotar todas. */
function intercalarListas<T>(listas: T[][]): T[] {
  const saida: T[] = [];
  const maior = Math.max(0, ...listas.map((l) => l.length));
  for (let i = 0; i < maior; i++) {
    for (const l of listas) {
      const item = l[i];
      if (item) saida.push(item);
    }
  }
  return saida;
}

/**
 * Alterna documentos entre as instâncias consultadas.
 *
 * Sem isso, uma Turma Recursal com acervo grande ocuparia todas as vagas e a TRU
 * — que uniformiza, e por isso pesa mais — ficaria de fora.
 */
function intercalarPorFonte(
  evidencias: JuliaEvidencia[],
  instancias: JuliaInstancia[]
): JuliaEvidencia[] {
  const grupos = instancias.map((inst) =>
    evidencias.filter((e) => (e.documento.instancia ?? '').startsWith(inst.split('_')[0]!))
  );
  const saida: JuliaEvidencia[] = [];
  const maior = Math.max(0, ...grupos.map((g) => g.length));
  for (let i = 0; i < maior; i++) {
    for (const g of grupos) {
      const item = g[i];
      if (item) saida.push(item);
    }
  }
  // Nenhum documento pode sumir por falha do agrupamento acima.
  for (const e of evidencias) if (!saida.includes(e)) saida.push(e);
  return saida;
}

// ── Entrada pública ──────────────────────────────────────────────

/**
 * Recupera evidência nos escopos pedidos.
 *
 * Os dois escopos rodam em paralelo e **falham de forma independente**: sessão
 * da Júlia expirada derruba o escopo da unidade, mas o revisor continua
 * respondendo pela API pública, que não usa sessão.
 */
export async function recuperar(c: JuliaConsulta): Promise<JuliaRecuperacao> {
  const querUnidade = c.escopos?.unidade ?? true;
  const querRevisor = c.escopos?.revisor ?? true;
  const instanciasRevisor = mapearOrgaoRevisor(c.orgao, c.instancias);

  const [unidade, revisor, datas] = await Promise.all([
    querUnidade ? recuperarUnidade(c) : Promise.resolve(null),
    querRevisor && instanciasRevisor.length
      ? recuperarRevisor(c, instanciasRevisor)
      : Promise.resolve(null),
    Promise.all(
      c.instancias.map((i) =>
        obterDataAtualizacao(c.orgao, i, { signal: c.signal }).catch(() => null)
      )
    )
  ]);

  // Com várias instâncias, exibimos a carga MAIS ANTIGA. Anunciar a mais
  // recente sugeriria um acervo mais atual do que o consultado de fato.
  const dataIndice = datas.filter((d): d is string => !!d).sort()[0] ?? null;

  const ladoOk = (e: JuliaEscopoResultado | null): boolean =>
    !!e && !e.indisponivel && e.analisados.length > 0;

  return {
    unidade,
    revisor,
    comparacaoPossivel: ladoOk(unidade) && ladoOk(revisor),
    dataIndice
  };
}
