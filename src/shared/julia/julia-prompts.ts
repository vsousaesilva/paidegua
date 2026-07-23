/**
 * Prompts do "Fale com Júlia" — extração de filtros e síntese da análise dupla.
 *
 * Duas chamadas de LLM por pergunta:
 *
 *   1. **Extração** (JSON mode): pergunta em linguagem natural → termos de busca
 *      e escopos. Motor de busca full-text vai mal com frase inteira; precisa de
 *      termos jurídicos.
 *   2. **Síntese**: evidência recuperada → resposta com as travas de §2.3 do
 *      `docs/plano-julia-funcionalidades.md`.
 *
 * ## As travas não são estilo — são o que impede a feature de enganar
 *
 * A pergunta "qual o entendimento que prevalece" convida à generalização. Um
 * modelo que lê 4 sentenças de um universo de 300 e responde "a vara entende que
 * X" produz afirmação de aparência autoritativa sobre base não representativa —
 * e alguém minuta em cima disso.
 *
 * Daí as regras inegociáveis do prompt de síntese: base contada, citação por
 * afirmação, divergência relatada em vez de maioria eleita, e linguagem de
 * indício quando a amostra é pequena.
 *
 * ## A trava mais sutil: citação alheia
 *
 * Fundamentação de sentença transcreve doutrina, súmula e acórdão do STJ/TRF5.
 * São palavras de **terceiros**. Sem instrução explícita, o modelo lê a ementa do
 * STJ dentro da sentença e reporta como entendimento da vara — atribuição errada,
 * não apenas imprecisão. O segmentador não remove essas transcrições de
 * propósito (regex não distingue citar de decidir); a separação é feita aqui.
 */

import { aplicarRegexAnonimizacao } from '../anonymizer';
import { tryParseLooseJson } from '../prompts';
import { montarUrlDocumentoPje } from './julia-identificador';
import type { JuliaEscopoResultado, JuliaRecuperacao } from './julia-rag';

// ── Anonimização específica deste corpus ─────────────────────────

/**
 * Rótulos de qualificação das partes nos documentos do PJe.
 *
 * Capturam a linha inteira até a quebra — é onde ficam nome de parte, de
 * advogado e número de OAB.
 */
const ROTULOS_PARTES =
  /^[ \t]*(AUTOR|R[ÉE]U|REQUERENTE|REQUERIDO|RECORRENTE|RECORRIDO|APELANTE|APELADO|AGRAVANTE|AGRAVADO|EMBARGANTE|EMBARGADO|IMPETRANTE|IMPETRADO|EXEQUENTE|EXECUTADO|ADVOGADO(?:\(A\))?(?:\s+do\(a\)[^:]*)?|PROCURADOR(?:\(A\))?)[^\n:]*:[^\n]*/gim;

/**
 * Prepara texto de documento para envio a provedor de IA externo.
 *
 * Duas passagens locais, nesta ordem:
 *
 *   1. Remove as linhas de qualificação das partes. É a maior concentração de
 *      dado pessoal do documento e **não contribui em nada** para a pergunta —
 *      quem litigou é irrelevante para saber qual tese o juízo adota.
 *   2. `aplicarRegexAnonimizacao` para CPF, RG, e-mail, telefone e dados
 *      bancários que tenham escapado no corpo.
 *
 * **Limite conhecido:** nome de parte citado no corpo do texto ("a autora,
 * Sr.ª Fulana, alega…") não é capturado. Detectar nome próprio sem LLM é
 * inviável, e uma chamada de anonimização por documento inviabilizaria o custo.
 * O acervo é jurisprudência pública — os nomes constam dos acórdãos publicados
 * pelo próprio Tribunal —, mas o resíduo existe e está registrado aqui de
 * propósito, para ser decisão consciente e não descuido.
 */
export function prepararTextoParaIA(texto: string): string {
  return aplicarRegexAnonimizacao(texto.replace(ROTULOS_PARTES, '')).trim();
}

// ── 1. Extração de filtros ───────────────────────────────────────

export interface JuliaExtracao {
  /** Consulta com operadores da Júlia. */
  termo: string;
  /**
   * A mesma consulta sem operadores, como rede de segurança.
   *
   * A sintaxe dos operadores foi levantada dos rótulos da interface, não de
   * documentação — se algum estiver errado, a busca pode voltar vazia. Nesse
   * caso o orquestrador repete com esta versão em vez de devolver "nada
   * encontrado" por erro de sintaxe nosso.
   */
  termoSimples: string;
  dataInicial: string | null;
  dataFinal: string | null;
  escopos: { unidade: boolean; revisor: boolean };
}

export function buildJuliaExtracaoPrompt(
  pergunta: string,
  contexto: { unidade: string; hoje: string }
): string {
  return `Você prepara consultas à Júlia, o sistema de pesquisa de jurisprudência do TRF5.

Converta a pergunta do servidor em parâmetros de busca. A Júlia é um motor de busca por palavras — frases longas em linguagem natural recuperam mal. Extraia os TERMOS JURÍDICOS centrais.

Unidade consultada: ${contexto.unidade}
Data de hoje: ${contexto.hoje}

Pergunta:
"""
${pergunta}
"""

A busca é LÉXICA: casa palavras, não significados. Documento que não contenha as palavras buscadas não aparece, por mais pertinente que seja. Por isso os operadores abaixo são decisivos.

## Operadores da Júlia

- \`$\` — truncamento. \`prorroga$\` casa prorrogação, prorrogar, prorrogado,
  prorrogados. **Use com generosidade**: o português flexiona muito, e sem
  truncamento a busca perde variações óbvias do mesmo conceito.
- \`adj\` — palavras adjacentes, nesta ordem. \`auxílio adj doença\` casa a
  expressão, não as duas palavras espalhadas pelo texto.
- \`prox\` — palavras próximas, em qualquer ordem.
- \`e\`, \`ou\`, \`nao\` — booleanos.

Responda SOMENTE com JSON válido, neste formato:

{
  "termo": "consulta com operadores",
  "termoSimples": "as mesmas palavras, sem operador nenhum",
  "dataInicial": "yyyy-MM-dd ou null",
  "dataFinal": "yyyy-MM-dd ou null",
  "escopos": { "unidade": true, "revisor": true }
}

Regras:

1. **Vocabulário do documento, não da pergunta.** Use os termos como apareceriam
   numa sentença ou acórdão. "gente que pede auxílio-doença de novo" →
   "restabelecimento". Nunca inclua metalinguagem — "entendimento",
   "jurisprudência", "como decide", "posicionamento" — nem o nome da unidade:
   são palavras da sua pergunta, não do texto julgado.
2. **Trunque os radicais.** Todo termo cuja flexão importe deve levar \`$\`.
   Prefira \`conced$\` a \`concessão\`, \`incapacida$\` a \`incapacidade\`.
3. **Agrupe expressões com \`adj\`.** Termos compostos do direito
   (auxílio-doença, lucro cessante, dano moral) rendem mais como expressão.
4. **Seja enxuto.** De 2 a 5 conceitos. Consulta longa restringe demais e
   devolve vazio — na dúvida, tire um termo.
5. \`nao\` só quando a pergunta excluir algo explicitamente.
6. **"termoSimples"**: as mesmas palavras sem \`$\`, \`adj\`, \`prox\` ou
   booleanos. É a rede de segurança caso a sintaxe falhe.
7. **Datas**: só preencha se a pergunta delimitar período ("nos últimos dois
   anos", "desde 2024"). Caso contrário, null nos dois.
8. **"escopos"**: deixe **ambos true**, salvo exclusão inequívoca — frases como
   "apenas na minha vara", "só em primeiro grau", "somente no TRF5".
   Mencionar "a vara" ou "o juízo" como **sujeito** da pergunta NÃO é exclusão:
   "como a vara vem decidindo X" quer saber da vara, e a comparação com quem a
   revisa continua útil. Na dúvida, mantenha os dois.

Exemplo — pergunta: "a vara vem exigindo pedido de prorrogação antes da ação de restabelecimento de auxílio-doença?"

{
  "termo": "prorroga$ e restabelecim$ e auxílio adj doença",
  "termoSimples": "prorrogação restabelecimento auxílio-doença",
  "dataInicial": null,
  "dataFinal": null,
  "escopos": { "unidade": true, "revisor": true }
}

Nenhum texto fora do JSON.`;
}

/**
 * Retira operadores da Júlia, deixando só as palavras.
 *
 * Usada quando a busca com operadores não devolve nada — sintaxe errada da
 * nossa parte não deve virar "nenhum documento encontrado" para o usuário.
 */
export function removerOperadores(consulta: string): string {
  return consulta
    .replace(/\$/g, '')
    .replace(/\b(e|ou|nao|não|adj|prox)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Palavras que não existem no texto de uma sentença — ou existem em todas.
 *
 * Metalinguagem da pergunta ("entendimento", "posição", "vem decidindo"),
 * referências ao órgão ("vara", "juízo", "unidade") e palavras funcionais. Um
 * buscador léxico não ignora nada: mandar a pergunta inteira faz cada uma delas
 * virar exigência de casamento.
 */
const PALAVRAS_DESCARTAVEIS = new Set([
  'a','à','às','ao','aos','as','o','os','um','uma','uns','umas',
  'de','da','do','das','dos','em','no','na','nos','nas','por','para','pelo','pela',
  'com','sem','sob','sobre','entre','até','após','e','ou','que','se','como','qual',
  'quais','quando','onde','porque','é','são','foi','ser','tem','têm','há','vem','vêm',
  'meu','minha','seu','sua','este','esta','esse','essa','aquele','aquela','isso',
  'entendimento','entendimentos','posição','posicionamento','jurisprudência',
  'decidindo','decide','decidem','decidiu','julgando','julga','julgam',
  'vara','varas','juízo','juizo','juiz','unidade','unidades','selecionada',
  'selecionadas','turma','tribunal','instância','instancia','grau',
  'caso','casos','sobre','acerca','respeito','tema','assunto','favor','contra'
]);

/**
 * Extrai termos de busca localmente, sem LLM.
 *
 * Rede de segurança para quando a extração por modelo falha ou estoura o prazo.
 * Antes, o fallback era a **pergunta inteira** — que num buscador léxico garante
 * zero resultados, porque nenhuma sentença contém "qual o entendimento das
 * varas selecionadas".
 *
 * Heurística simples de propósito: remove pontuação e palavras descartáveis,
 * mantém as 6 primeiras restantes. Não é bom quanto o LLM; é muito melhor que
 * mandar a frase crua.
 */
export function termosDePergunta(pergunta: string): string {
  const palavras = pergunta
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 2 && !PALAVRAS_DESCARTAVEIS.has(p.toLowerCase()));
  return palavras.slice(0, 6).join(' ') || pergunta.trim();
}

/**
 * Termos salientes de uma MINUTA, sem LLM — fallback da extração da análise
 * preditiva quando a chamada ao modelo falha ou estoura o prazo.
 *
 * Frequência sobre o texto INTEIRO (não um recorte por posição): o recorte por
 * offset fixo cortava no meio de uma palavra e produzia fragmentos como "nção"
 * (de "manutenção"), que num buscador léxico com semântica E zeram a consulta
 * inteira — nenhum documento contém a palavra quebrada.
 *
 * Palavra que se repete numa minuta é o tema dela: auxílio-doença, incapacidade,
 * segurado, invalidez, perícia. Os `max` mais frequentes (palavras completas,
 * sem descartáveis) dão uma consulta com recall razoável, muito melhor que um
 * recorte arbitrário.
 */
const BOILERPLATE_MINUTA = new Set([
  'parte','autor','autora','autores','réu','reu','requerido','requerida',
  'requerente','pedido','pedidos','processo','processos','autos','juízo',
  'juizo','juiz','sentença','sentenca','decisão','decisao','despacho',
  'ação','acao','presente','exposto','ante','face','razão','razao','termos',
  'artigo','artigos','inciso','parágrafo','paragrafo','caput','lei','leis',
  'norma','dispositivo','conforme','ainda','sobre','assim','portanto',
  'contudo','todavia','entretanto','forma','caso','casos','sendo','demais'
]);

export function termosSalientesMinuta(texto: string, max: number): string {
  const freq = new Map<string, number>();
  for (const bruto of texto.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/)) {
    const p = bruto.replace(/^-+|-+$/g, '').trim();
    if (p.length < 4) continue; // corta fragmentos e palavras funcionais curtas
    if (/^\d+$/.test(p)) continue;
    if (PALAVRAS_DESCARTAVEIS.has(p) || BOILERPLATE_MINUTA.has(p)) continue;
    freq.set(p, (freq.get(p) ?? 0) + 1);
  }
  const ordenadas = [...freq.entries()]
    // Mais frequentes primeiro; empate desfeito pela palavra mais longa, que
    // tende a ser a mais específica (auxílio-doença > doença).
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([p]) => p);
  return ordenadas.slice(0, Math.max(1, max)).join(' ');
}

export function parseJuliaExtracaoResponse(raw: string): JuliaExtracao | null {
  const obj = tryParseLooseJson(raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return null;

  const termo = typeof obj.termo === 'string' ? obj.termo.trim() : '';
  if (!termo) return null;

  const iso = (v: unknown): string | null =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

  const esc = (obj.escopos ?? {}) as Record<string, unknown>;
  // Ambos falsos não recuperaria nada — cai para o padrão em vez de devolver
  // uma consulta inútil.
  const unidade = esc.unidade !== false;
  const revisor = esc.revisor !== false;

  // Sem `termoSimples` do modelo, derivamos removendo os operadores — a rede de
  // segurança não pode depender de o LLM ter cooperado.
  const simples =
    typeof obj.termoSimples === 'string' && obj.termoSimples.trim()
      ? obj.termoSimples.trim()
      : removerOperadores(termo);

  return {
    termo,
    termoSimples: simples,
    dataInicial: iso(obj.dataInicial),
    dataFinal: iso(obj.dataFinal),
    escopos:
      unidade || revisor
        ? { unidade, revisor }
        : { unidade: true, revisor: true }
  };
}

// ── 2. Síntese ───────────────────────────────────────────────────

const ROTULO_SECAO: Record<string, string> = {
  ementa: 'EMENTA (razão de decidir condensada)',
  fundamentacao: 'FUNDAMENTAÇÃO (razão de decidir)',
  integral: 'TEXTO INTEGRAL (seção não identificada)'
};

/**
 * Título da seção, nomeando as fontes concretas.
 *
 * Nomear ("35ª VARA FEDERAL CE", "G2") em vez de rotular ("Escopo 1") importa
 * porque o modelo tende a ecoar os rótulos do prompt na resposta — e "Escopo 1"
 * não diz nada a quem lê. Com o nome real, o eco é informativo.
 */
function tituloEscopo(base: string, e: JuliaEscopoResultado | null): string {
  if (!e?.fontes.length) return base;
  return `${base} — ${e.fontes.join(', ')}`;
}

function formatarEscopo(
  e: JuliaEscopoResultado | null,
  titulo: string,
  /** Número da primeira citação deste bloco — a numeração é contínua entre os escopos. */
  offset = 0
): string {
  if (!e) return `### ${titulo}\n\nNão consultado.\n`;

  if (e.indisponivel) {
    const motivo =
      e.indisponivel.motivo === 'sessao'
        ? 'sessão da Júlia expirada'
        : 'falha na consulta';
    return `### ${titulo}\n\nINDISPONÍVEL (${motivo}). Nenhum documento deste escopo foi lido.\n`;
  }

  if (!e.analisados.length) {
    return `### ${titulo}\n\nNenhum documento encontrado para os filtros usados.\n`;
  }

  // Intervalo coberto: sem ele o modelo não tem como qualificar "recente", e a
  // análise de evolução vira impressão em vez de constatação.
  const datas = e.analisados
    .map((a) => a.documento.dataJulgamento ?? a.documento.dataAssinatura)
    .filter((d): d is string => !!d)
    .sort();
  let periodo = '';
  if (datas.length >= 2) {
    const de = datas[0]?.slice(0, 10) ?? '';
    const ate = datas[datas.length - 1]?.slice(0, 10) ?? '';
    const meses =
      (new Date(ate).getTime() - new Date(de).getTime()) /
      (1000 * 60 * 60 * 24 * 30.4);
    periodo =
      `Período coberto pelos documentos lidos: ${de} a ${ate}` +
      // O alerta é calculado, não deixado à percepção do modelo: ele tende a
      // narrar evolução mesmo quando o intervalo não a comporta.
      (meses < 12
        ? ` — intervalo de aproximadamente ${Math.max(1, Math.round(meses))} mês(es). AMOSTRA TEMPORALMENTE CONCENTRADA: não avalie evolução do entendimento a partir dela.`
        : '') +
      `\n`;
  }

  const cabecalho =
    `### ${titulo}\n\n` +
    `Fontes: ${e.fontes.join(', ')}\n` +
    `Universo: ${e.universo}${e.universoEhTeto ? '+ (teto do motor de busca)' : ''} documento(s) encontrado(s).\n` +
    `Lidos integralmente: ${e.analisados.length}` +
    (e.descartadosPorOrcamento > 0
      ? ` (${e.descartadosPorOrcamento} não lido(s) por limite de espaço)`
      : '') +
    `\n` +
    periodo +
    `Ordem: do mais recente para o mais antigo.\n`;

  const blocos = e.analisados.map((ev, i) => {
    const d = ev.documento;
    const n = offset + i + 1;
    const url = montarUrlDocumentoPje(d.codigoDocumento, d.urlPje);
    const partes = [
      `[${n}] Processo ${d.numeroProcessoFormatado ?? d.numeroProcesso ?? 's/n'}`,
      `Tipo: ${d.tipoDocumento ?? '—'}`,
      `Órgão julgador: ${d.orgaoJulgador ?? '—'}`,
      `Data: ${d.dataJulgamento ?? d.dataAssinatura ?? '—'}`,
      `Trecho: ${ROTULO_SECAO[ev.trecho.secao] ?? ev.trecho.secao}`,
      // URL entregue ao modelo para que ele produza a citação já clicável.
      url ? `URL: ${url}` : 'URL: (indisponível)',
      '',
      prepararTextoParaIA(ev.trecho.texto)
    ];
    if (ev.trecho.dispositivo) {
      partes.push('', 'DESFECHO (dispositivo):', prepararTextoParaIA(ev.trecho.dispositivo));
    }
    return partes.join('\n');
  });

  return `${cabecalho}\n${blocos.join('\n\n---\n\n')}\n`;
}

/**
 * Síntese de escopo único, para quem trabalha no 2º grau.
 *
 * Mantém as travas que continuam valendo — base contada, linguagem de indício,
 * citação por afirmação, divergência relatada, não atribuir citação alheia — e
 * remove as que só fazem sentido na análise dupla: nada de comparar escopos
 * nem de avisar que falta uma metade, porque ali não falta.
 */
function buildSintesePublica(pergunta: string, r: JuliaRecuperacao): string {
  const dataIndice = r.dataIndice
    ? `O índice da Júlia foi atualizado pela última vez em ${r.dataIndice}. Decisões posteriores não constam.`
    : 'A data de atualização do índice não pôde ser obtida.';

  return `Você é o pAIdegua analisando jurisprudência do TRF5 para um servidor da Justiça Federal.

Responda à pergunta abaixo usando EXCLUSIVAMENTE os documentos fornecidos. Você não tem outra fonte, e não deve recorrer a conhecimento próprio sobre o tema.

PERGUNTA:
"""
${pergunta}
"""

${dataIndice}

## REGRAS INEGOCIÁVEIS

1. **Base contada.** Informe quantos documentos foram encontrados e quantos
   foram lidos. Nunca escreva como se os lidos fossem o universo.

2. **Amostra pequena exige linguagem de indício.** Com poucos documentos lidos
   frente ao universo, escreva "nos julgados analisados". NUNCA "é o
   entendimento consolidado" ou "prevalece o entendimento".

3. **Citação por afirmação.** Pelo número entre colchetes: [3], [7]. Escreva
   apenas o número, sem markdown de link — a interface torna cada [n] clicável.

4. **Não atribua ao órgão o que ele apenas citou.** Os documentos transcrevem
   doutrina e acórdãos de outros tribunais. Distinga "o acórdão adota a tese X"
   de "o acórdão cita precedente do STJ no sentido de X".

5. **Divergência se relata, não se resolve.** Apontando os julgados em direções
   diferentes, apresente a divergência e quem sustenta cada posição.

6. **Divergência no tempo tem tratamento próprio.** Compare as datas: decisões
   recentes divergindo das anteriores é mudança de posicionamento, e deve ser
   destacada. Divergência entre julgados da mesma época é dissenso entre
   órgãos, não evolução.

7. **Se a evidência não responde à pergunta, diga isso.**

8. **Escreva para um servidor.** Nada de rótulos internos deste prompt, nomes
   de parâmetro ou referências ao funcionamento da consulta.

## DOCUMENTOS

${formatarEscopo(r.revisor, tituloEscopo('JURISPRUDÊNCIA CONSULTADA', r.revisor), 0)}

## FORMATO DA RESPOSTA

Use exatamente estes títulos, omitindo as seções sem dados:

**Resposta** — dois ou três parágrafos respondendo à pergunta, com as citações [n].

**O que os julgados decidem** — tese(s) identificada(s), com citações.

**Mudou com o tempo?** — o entendimento se manteve ou mudou ao longo das datas?
Cite as datas. Se não houve variação relevante, diga que se manteve estável no
período coberto.

**O que esta análise não permite afirmar** — os limites da base consultada.
Sempre presente.`;
}

export function buildJuliaSintesePrompt(
  pergunta: string,
  r: JuliaRecuperacao,
  /**
   * `'publica'` no 2º grau: escopo único, sem confronto. Ali a ausência do
   * segundo bloco é o desenho, não uma falha — e as travas que existem para
   * impedir comparação indevida se tornariam ressalvas sem sentido.
   */
  modo: 'dupla' | 'publica' = 'dupla'
): string {
  if (modo === 'publica') return buildSintesePublica(pergunta, r);
  const dataIndice = r.dataIndice
    ? `O índice da Júlia foi atualizado pela última vez em ${r.dataIndice}. Decisões posteriores a essa data não constam.`
    : 'A data de atualização do índice não pôde ser obtida.';

  return `Você é o pAIdegua analisando jurisprudência do TRF5 para um servidor da Justiça Federal.

Responda à pergunta abaixo usando EXCLUSIVAMENTE os documentos fornecidos. Você não tem outra fonte, e não deve recorrer a conhecimento próprio sobre o tema.

PERGUNTA:
"""
${pergunta}
"""

${dataIndice}

## REGRAS INEGOCIÁVEIS

1. **Base contada.** Sempre informe quantos documentos foram encontrados e
   quantos foram efetivamente lidos. Nunca escreva como se os lidos fossem o
   universo. Se foram lidos 4 de 300, isso precisa estar visível na resposta.

2. **Amostra pequena exige linguagem de indício.** Com poucos documentos lidos
   frente ao universo, escreva "nos casos analisados", "os documentos lidos
   apontam". NUNCA "a unidade entende", "é o entendimento consolidado",
   "prevalece o entendimento" — essas formulações afirmam representatividade que
   a amostra não sustenta.

3. **Citação por afirmação.** Toda afirmação sobre entendimento deve remeter aos
   documentos que a embasam, pelo número entre colchetes: [3], [7]. A numeração
   é **contínua entre os dois blocos**, então cada número é único em toda a
   resposta — não reinicie a contagem no segundo bloco.

   Escreva apenas o número entre colchetes, sem markdown de link e sem URL: a
   interface transforma cada [n] em elemento clicável. Vários numa citação só
   ficam assim: [3][7].

   Afirmação sem lastro em documento fornecido não entra na resposta.

4. **Não atribua ao juízo o que ele apenas citou.** Os documentos transcrevem
   doutrina, súmulas e acórdãos de outros tribunais (STJ, STF, TRF5). Isso é o
   que o julgador CITOU. Distinga com clareza: "a sentença adota a tese X" é
   diferente de "a sentença cita precedente do STJ no sentido de X". Quando não
   for possível distinguir, diga que não é possível.

5. **Divergência se relata, não se resolve.** Se os documentos apontam em
   direções diferentes, APRESENTE A DIVERGÊNCIA e indique quais documentos
   sustentam cada posição. Não eleja a maioria como "o entendimento".

5.1. **Divergência no TEMPO tem tratamento próprio, e depende do intervalo.**
   Cada documento traz sua data, e o cabeçalho de cada bloco informa o período
   coberto.

   **Antes de analisar evolução, olhe o intervalo.** Se os documentos lidos se
   concentram em poucos meses, NÃO responda se o entendimento mudou ou se
   manteve — diga que a amostra é temporalmente concentrada e que o período não
   permite avaliar evolução. Afirmar estabilidade a partir de seis semanas é
   conclusão sem base, e soa a achado quando é ausência de dados.

   Havendo intervalo suficiente (um ano ou mais), compare cronologicamente:
   decisões recentes divergindo das anteriores é **mudança de posicionamento** e
   deve ser destacada com as datas — é a informação mais valiosa desta análise,
   porque muda o que se deve escrever hoje. Estabilidade ao longo de período
   amplo também é achado, e deve ser dita.

   Cuidado com o inverso: divergência entre decisões **da mesma época** é
   dissenso entre julgadores, não evolução. Não confunda os dois.

6. **Comparação entre escopos só com os dois lados.** ${
    r.comparacaoPossivel
      ? 'Os dois escopos têm documentos lidos — a comparação é possível.'
      : 'ATENÇÃO: os dois escopos NÃO estão disponíveis. É PROIBIDO afirmar alinhamento ou divergência entre unidade e instância revisora. Apresente o que há e declare explicitamente que a comparação não foi possível.'
  }${
    r.unidade?.indisponivel?.motivo === 'sessao'
      ? '\n\n6.1. **ABRA A RESPOSTA AVISANDO** que as decisões da própria unidade não foram consultadas porque a Júlia não está autenticada neste navegador, e que o que segue reflete apenas a instância revisora. Isso vem ANTES de qualquer análise — quem lê precisa saber que está vendo metade antes de formar juízo, não depois.'
      : ''
  }

7. **Fundamentação e desfecho são coisas distintas.** A tese está na
   fundamentação/ementa; o dispositivo indica apenas o resultado. Não trate
   "julgou procedente" como se fosse um entendimento jurídico.

8. **Se a evidência não responde à pergunta, diga isso.** É resposta legítima e
   preferível a preencher a lacuna.

9. **Escreva para um servidor, não para o sistema.** Nunca use os rótulos
   internos deste prompt — nada de "Escopo 1", "Escopo 2", "escopo unidade",
   "escopo revisor". Refira-se pelo nome: "a 35ª Vara Federal", "a Turma
   Recursal do Ceará", "o TRF5" — ou, se o nome não estiver disponível, "a
   unidade" e "a instância revisora". Também não mencione parâmetros de busca,
   nomes de campo nem o funcionamento da consulta.

## DOCUMENTOS

${formatarEscopo(r.unidade, tituloEscopo('DECISÕES DA PRÓPRIA UNIDADE (primeiro grau)', r.unidade), 0)}

${formatarEscopo(r.revisor, tituloEscopo('DECISÕES DA INSTÂNCIA QUE REVISA A UNIDADE', r.revisor), r.unidade?.analisados.length ?? 0)}

## FORMATO DA RESPOSTA

Use exatamente estes títulos, omitindo as seções sem dados:

**Resposta** — dois ou três parágrafos respondendo à pergunta, com as
citações [n].

**Como a unidade vem decidindo** — tese(s) identificada(s) e desfechos, com
citações.

**Como a instância revisora vem decidindo** — idem.

**Mudou com o tempo?** — o entendimento se manteve ou mudou ao longo das datas
dos documentos? Cite as datas. Se não houve variação relevante, diga que se
manteve estável no período coberto.

**Unidade e instância revisora convergem?** — ${
    r.comparacaoPossivel
      ? 'alinhamento ou divergência entre as duas. Se houver divergência, destaque: é o sinal mais útil desta análise, porque antecipa reforma.'
      : 'nesta consulta, escreva apenas que não foi possível comparar, e por quê.'
  }

**O que esta análise não permite afirmar** — os limites da base consultada.
Sempre presente.`;
}

// ── 3. Análise preditiva de minutas ──────────────────────────────

/**
 * Extração para a análise preditiva: a entrada não é uma pergunta, é a
 * própria MINUTA. Além dos termos de busca, o modelo decompõe a minuta em
 * teses — insumo do confronto ponto a ponto na síntese.
 */
export interface AnalisePreditivaExtracao {
  /** Consulta com operadores da Júlia. */
  termo: string;
  /** Rede de segurança sem operadores (mesmo papel de JuliaExtracao). */
  termoSimples: string;
  /** Teses jurídicas centrais da minuta (2 a 6). */
  teses: Array<{ id: number; resumo: string; fundamento: string }>;
  /** Sentido do dispositivo da minuta. */
  sentido: 'procedente' | 'improcedente' | 'parcial' | 'outro' | null;
  /** Rótulo curto do tema (ex.: "auxílio-doença — restabelecimento"). */
  materia: string;
}

export function buildAnalisePreditivaExtracaoPrompt(
  minutaAnonimizada: string,
  contexto: { unidade: string; hoje: string }
): string {
  return `Você prepara consultas à Júlia, o sistema de pesquisa de jurisprudência do TRF5.

O texto abaixo é uma MINUTA de ato judicial (sentença, decisão ou voto) em elaboração. Sua tarefa tem duas partes:

1. Identificar as TESES JURÍDICAS em que a minuta se apoia — as questões de direito que decidem o caso, não os fatos do processo.
2. Derivar termos de busca que recuperem julgados sobre as MESMAS questões, para confrontar a minuta com a jurisprudência.

Unidade que elabora a minuta: ${contexto.unidade}
Data de hoje: ${contexto.hoje}

MINUTA:
"""
${minutaAnonimizada}
"""

A busca é LÉXICA: casa palavras, não significados. Documento que não contenha as palavras buscadas não aparece, por mais pertinente que seja. Por isso os operadores abaixo são decisivos.

## Operadores da Júlia

- \`$\` — truncamento. \`prorroga$\` casa prorrogação, prorrogar, prorrogado,
  prorrogados. **Use com generosidade**: o português flexiona muito, e sem
  truncamento a busca perde variações óbvias do mesmo conceito.
- \`adj\` — palavras adjacentes, nesta ordem. \`auxílio adj doença\` casa a
  expressão, não as duas palavras espalhadas pelo texto.
- \`prox\` — palavras próximas, em qualquer ordem.
- \`e\`, \`ou\`, \`nao\` — booleanos.

Responda SOMENTE com JSON válido, neste formato:

{
  "termo": "consulta com operadores",
  "termoSimples": "as mesmas palavras, sem operador nenhum",
  "teses": [
    { "id": 1, "resumo": "uma frase com a tese", "fundamento": "em que a minuta a apoia (lei, súmula, precedente, prova)" }
  ],
  "sentido": "procedente | improcedente | parcial | outro | null",
  "materia": "rótulo curto do tema"
}

Regras:

1. **Teses, não fatos.** "A parte estava incapacitada em 2023" é fato; "a DIB
   deve retroagir à data do requerimento administrativo" é tese. De 2 a 6
   teses — as que decidem o caso, na ordem de importância da minuta.
2. **Vocabulário do documento julgado, não da minuta.** Use os termos como
   apareceriam num acórdão sobre o mesmo tema. Nunca inclua metalinguagem nem
   o nome da unidade.
3. **Trunque os radicais** (\`conced$\`, \`incapacida$\`) e **agrupe expressões
   com \`adj\`** (auxílio adj doença).
4. **Seja enxuto.** De 2 a 5 conceitos na consulta — os que atravessam as
   teses. Consulta longa devolve vazio; na dúvida, tire um termo.
5. **"termoSimples"**: as mesmas palavras sem \`$\`, \`adj\`, \`prox\` ou
   booleanos. É a rede de segurança caso a sintaxe falhe.
6. **"sentido"**: o desfecho que a minuta dá ao pedido, lido do dispositivo.
   Use null se a minuta não tiver dispositivo reconhecível.

Nenhum texto fora do JSON.`;
}

export function parseAnalisePreditivaExtracao(
  raw: string
): AnalisePreditivaExtracao | null {
  const obj = tryParseLooseJson(raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return null;

  const termo = typeof obj.termo === 'string' ? obj.termo.trim() : '';
  if (!termo) return null;

  const simples =
    typeof obj.termoSimples === 'string' && obj.termoSimples.trim()
      ? obj.termoSimples.trim()
      : removerOperadores(termo);

  const tesesBrutas = Array.isArray(obj.teses) ? obj.teses : [];
  const teses: AnalisePreditivaExtracao['teses'] = [];
  for (const t of tesesBrutas) {
    if (!t || typeof t !== 'object') continue;
    const tt = t as Record<string, unknown>;
    const resumo = typeof tt.resumo === 'string' ? tt.resumo.trim() : '';
    if (!resumo) continue;
    teses.push({
      id: teses.length + 1,
      resumo,
      fundamento: typeof tt.fundamento === 'string' ? tt.fundamento.trim() : ''
    });
    if (teses.length >= 6) break;
  }

  const sentidos = ['procedente', 'improcedente', 'parcial', 'outro'] as const;
  const sentido = sentidos.find((s) => s === obj.sentido) ?? null;

  return {
    termo,
    termoSimples: simples,
    teses,
    sentido,
    materia: typeof obj.materia === 'string' ? obj.materia.trim() : ''
  };
}

function formatarTeses(teses: AnalisePreditivaExtracao['teses']): string {
  if (!teses.length) {
    return (
      'As teses da minuta NÃO puderam ser estruturadas previamente. ' +
      'Identifique-as você mesmo a partir do texto da minuta antes de fazer o confronto.'
    );
  }
  return teses
    .map(
      (t) =>
        `${t.id}. ${t.resumo}` + (t.fundamento ? ` (apoiada em: ${t.fundamento})` : '')
    )
    .join('\n');
}

/** Precedente entregue ao prompt de reescrita, já com a referência pronta. */
export interface PrecedenteParaReescrita {
  n: number;
  referencia: string;
  trecho: string;
}

/**
 * Reescrita da minuta aplicando APENAS as sugestões escolhidas.
 *
 * A regra central é a literalidade: a tentação do modelo é "melhorar" o texto
 * inteiro, e o magistrado pediu o oposto — o que ele já escreveu está
 * decidido, e mudança fora do pedido é retrabalho de conferência. Por isso a
 * regra 1 é a primeira e a mais enfática.
 */
export function buildReescritaMinutaPrompt(
  minutaAnonimizada: string,
  sugestoes: string[],
  precedentes: PrecedenteParaReescrita[]
): string {
  const listaSugestoes = sugestoes
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n');

  const blocoPrecedentes = precedentes.length
    ? precedentes
        .map(
          (p) =>
            `[${p.n}] Referência: ${p.referencia || '(sem referência montada)'}\nTrecho:\n${prepararTextoParaIA(p.trecho)}`
        )
        .join('\n\n---\n\n')
    : 'Nenhum precedente fornecido — as sugestões escolhidas não citam documentos.';

  return `Você reescreve uma MINUTA judicial aplicando EXCLUSIVAMENTE as sugestões listadas, para o magistrado que a assina.

MINUTA ATUAL (anonimizada, em Markdown — a formatação é parte do documento):
"""
${minutaAnonimizada}
"""

SUGESTÕES A APLICAR (e nenhuma outra):
${listaSugestoes}

PRECEDENTES DISPONÍVEIS PARA CITAÇÃO:
${blocoPrecedentes}

## REGRAS INEGOCIÁVEIS

1. **LITERALIDADE.** Fora dos pontos diretamente alcançados pelas sugestões,
   reproduza o texto EXATAMENTE como está — mesma redação, mesma ordem de
   parágrafos, mesmos títulos, mesma pontuação. É PROIBIDO melhorar estilo,
   resumir, reordenar, padronizar ou corrigir qualquer coisa que as sugestões
   não peçam. O texto atual está decidido; cada alteração não pedida vira
   retrabalho de conferência para quem assina.

2. **A FORMATAÇÃO É PARTE DA LITERALIDADE.** Preserve exatamente a marcação
   Markdown existente: negrito (**), itálico (*), listas e — sobretudo — os
   blocos de citação recuados (linhas iniciadas com "> "). Citação que está
   recuada permanece recuada, com o mesmo conteúdo. Não acrescente nem remova
   formatação do texto que não foi alterado.

3. **Cada sugestão entra no ponto pertinente da fundamentação**, integrada com
   naturalidade à redação existente — não como apêndice ao final.

4. **Citação de precedente usa o material fornecido e a convenção do
   documento**: transcreva a ementa ou o trecho pertinente como bloco recuado
   (linhas com "> ") seguido da referência POR EXTENSO, no formato fornecido.
   NÃO use marcadores numéricos como [3] — minuta não cita por número de
   sistema. Só cite precedentes da lista acima.

5. **Proibido inventar** precedente, dispositivo legal, fato ou prova que não
   esteja na minuta atual ou nos precedentes fornecidos.

6. **O texto foi anonimizado**: linhas de qualificação foram removidas e dados
   pessoais mascarados. Preserve os marcadores exatamente como estão, não
   tente reconstituir dados, e se houver o marcador
   "[... trecho intermediário omitido ...]", mantenha-o no mesmo lugar.

7. **Responda SOMENTE com o texto integral da minuta reescrita, em
   Markdown** — sem comentários antes ou depois, sem explicar o que mudou e
   sem cercas de código.`;
}

/**
 * Síntese da análise preditiva: confronta a minuta com a evidência
 * recuperada e produz o relatório de 4 blocos para o magistrado.
 *
 * A trava nova mais importante é a proibição de probabilidade numérica: o
 * prognóstico é qualitativo e condicionado à base lida. "70% de chance de
 * manutenção" seria a pior alucinação possível aqui — número inventado com
 * aparência de estatística, lido por quem decide.
 */
export function buildAnalisePreditivaSintesePrompt(
  minutaAnonimizada: string,
  extracao: AnalisePreditivaExtracao,
  r: JuliaRecuperacao,
  /**
   * `'publica'` no 2º grau: não há "instância revisora" a antecipar — o
   * relatório vira aderência ao entendimento do próprio colegiado.
   */
  modo: 'dupla' | 'publica' = 'dupla'
): string {
  const dataIndice = r.dataIndice
    ? `O índice da Júlia foi atualizado pela última vez em ${r.dataIndice}. Decisões posteriores não constam.`
    : 'A data de atualização do índice não pôde ser obtida.';

  const publica = modo === 'publica';
  const tituloPrognostico = publica
    ? 'Aderência ao entendimento do colegiado'
    : 'Prognóstico';

  const documentos = publica
    ? formatarEscopo(r.revisor, tituloEscopo('JURISPRUDÊNCIA CONSULTADA', r.revisor), 0)
    : `${formatarEscopo(r.unidade, tituloEscopo('DECISÕES DA PRÓPRIA UNIDADE (primeiro grau)', r.unidade), 0)}

${formatarEscopo(r.revisor, tituloEscopo('DECISÕES DA INSTÂNCIA QUE REVISA A UNIDADE', r.revisor), r.unidade?.analisados.length ?? 0)}`;

  return `Você é o pAIdegua analisando uma MINUTA em elaboração contra a jurisprudência recuperada da Júlia (TRF5), para o magistrado que a revisa antes de assinar.

Use EXCLUSIVAMENTE os documentos fornecidos. Você não tem outra fonte, e não deve recorrer a conhecimento próprio sobre o tema.

MINUTA SOB ANÁLISE${extracao.materia ? ` (tema: ${extracao.materia})` : ''}:
"""
${minutaAnonimizada}
"""

TESES IDENTIFICADAS NA MINUTA:
${formatarTeses(extracao.teses)}

${dataIndice}

## REGRAS INEGOCIÁVEIS

1. **Base contada.** Sempre informe quantos documentos foram encontrados e
   quantos foram efetivamente lidos. Nunca escreva como se os lidos fossem o
   universo. Se foram lidos 4 de 300, isso precisa estar visível.

2. **PROIBIDO percentual ou probabilidade numérica** de manutenção ou reforma
   ("70% de chance", "alta probabilidade estatística"). O prognóstico é
   QUALITATIVO e sempre condicionado à base lida: "nos N acórdãos lidos, a
   tese X foi acolhida em ...", nunca "a minuta será mantida". Com poucos
   documentos frente ao universo, use linguagem de indício ("os julgados
   analisados sugerem") — NUNCA "entendimento consolidado" ou "prevalece".

3. **Citação por afirmação.** Toda afirmação sobre entendimento remete aos
   documentos que a embasam, pelo número entre colchetes: [3], [7]. Numeração
   contínua entre os blocos — cada número é único em toda a resposta. Escreva
   apenas o número, sem markdown de link: a interface torna cada [n]
   clicável. Vários numa citação só: [3][7]. Afirmação sem lastro em
   documento fornecido não entra na resposta.

4. **Não atribua ao órgão o que ele apenas citou.** Os documentos transcrevem
   doutrina, súmulas e acórdãos de outros tribunais. Distinga "o acórdão
   adota a tese X" de "o acórdão cita precedente do STJ no sentido de X".
   Quando não for possível distinguir, diga que não é possível.

5. **Divergência se relata, não se resolve.** Se os documentos apontam em
   direções diferentes, apresente a divergência e quem sustenta cada posição.
   Divergência no tempo depende do intervalo: com documentos concentrados em
   poucos meses, NÃO avalie evolução do entendimento — diga que o período não
   permite. Divergência entre decisões da mesma época é dissenso, não
   evolução.
${
    publica
      ? ''
      : `
6. **Comparação entre escopos só com os dois lados.** ${
          r.comparacaoPossivel
            ? 'Os dois escopos têm documentos lidos — a comparação é possível.'
            : 'ATENÇÃO: os dois escopos NÃO estão disponíveis. É PROIBIDO afirmar alinhamento ou divergência entre unidade e instância revisora. Apresente o que há e declare explicitamente que a comparação não foi possível.'
        }${
          r.unidade?.indisponivel?.motivo === 'sessao'
            ? '\n\n6.1. **ABRA A RESPOSTA AVISANDO** que as decisões da própria unidade não foram consultadas porque a Júlia não está autenticada neste navegador, e que a análise reflete apenas a instância revisora. Isso vem ANTES de qualquer avaliação — quem lê precisa saber que está vendo metade antes de formar juízo.'
            : ''
        }
`
  }
7. **Ausência de evidência não é convergência nem divergência.** Se nenhum
   documento tratar de uma tese da minuta, escreva "não localizei julgados
   sobre este ponto na base consultada" — e nada além disso.

8. **PROIBIDO inventar precedente.** Só os documentos fornecidos existem.

9. **Sugestões com lastro.** Cada sugestão de reforço ou distinção deve citar
   [n] ou declarar-se expressamente como sugestão redacional sem lastro em
   precedente.

10. **Fundamentação e desfecho são coisas distintas.** A tese está na
    fundamentação/ementa; o dispositivo indica apenas o resultado.

11. **Escreva para o magistrado, não para o sistema.** Nada de rótulos
    internos deste prompt ("Escopo 1", "escopo revisor", "extração"), nomes
    de parâmetro nem funcionamento da consulta. Refira-se aos órgãos pelo
    nome ou como "a unidade" e "a instância revisora". Tom técnico e direto —
    quem lê decide, não precisa de rodeios.

## DOCUMENTOS

${documentos}

## FORMATO DA RESPOSTA

Use exatamente estes títulos, omitindo apenas seções sem qualquer dado:

**${tituloPrognostico}** — avaliação qualitativa de como ${
    publica
      ? 'a minuta se alinha ao que o colegiado vem decidindo'
      : 'a instância revisora tende a receber a minuta'
  }, sempre abrindo com a base ("com base em N de M acórdãos lidos...").

**Divergências ponto a ponto** — para CADA tese da minuta: a tese → o que os
julgados vêm decidindo sobre ela [n] → convergência, divergência ou "sem
julgado localizado".

**Precedentes favoráveis e contrários** — duas listas ("Favoráveis à minuta"
e "Contrários à minuta"), cada item com [n] e uma linha explicando o porquê.

**Sugestões de reforço ou distinção** — como robustecer a fundamentação:
citar precedente favorável ainda não citado [n]; distinguir expressamente o
caso do precedente contrário [n]; ajustes redacionais (declarados como tal).

**O que esta análise não permite afirmar** — os limites da base consultada.
Sempre presente.`;
}
