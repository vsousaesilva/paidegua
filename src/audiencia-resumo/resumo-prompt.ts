/**
 * Prompt adaptativo para o "Resumo dos processos da pauta" (AUD-10).
 *
 * O magistrado precisa de um resumo executivo do processo na pauta,
 * focado no que importa para conduzir a audiência. O prompt é
 * **adaptativo** ao tipo de processo:
 *
 *   - JEF previdenciário (rural, salário-maternidade, pensão por morte,
 *     união estável, benefício por incapacidade): replica o roteiro
 *     "Roteiro para auxiliar as audiências" da JFCE — checklist de
 *     documentos do art. 106 da Lei 8213/91, CADúnico, CNIS, CTPS,
 *     certidões.
 *   - Outros tipos (cível, criminal, etc.): monta seções pertinentes
 *     dinamicamente (partes, pedido, ponto controvertido, provas,
 *     contestação, preliminares).
 *
 * O modelo decide qual estrutura aplicar a partir da CLASSE e do
 * conteúdo dos documentos — não impomos hard-coded; passamos o
 * roteiro como REFERÊNCIA e instrução de adaptação.
 */

export interface DadosLinha {
  cnj: string;
  dataHora: string;
  autor: string;
  reu: string;
  classe: string;
  tipoAudiencia: string;
  sala: string;
  situacao: string;
  orgaoJulgador: string;
}

const ROTEIRO_JEF_PREVIDENCIARIO = `\
ROTEIRO PARA AUXILIAR AS AUDIÊNCIAS — JEF PREVIDENCIÁRIO (REFERÊNCIA)

BENEFÍCIOS RURAIS GERAIS:
- Autor (qualificação completa)
- Data de nascimento
- Benefício solicitado na petição inicial
- DER do benefício e motivo de indeferimento administrativo
- Contestação: há preliminar? Qual o mérito — ponto controvertido?
- Estado civil do autor
- Certidão de casamento do autor: data da expedição, data da celebração,
  nome do cônjuge, profissões dos nubentes
- Documentos listados no artigo 106 da Lei 8213/91:
  Para cada um — data de emissão e nome do titular:
  · Contrato de arrendamento, parceria ou comodato rural
  · DAP/PRONAF
  · Bloco de notas do produtor rural
  · CADASTRO DE AGRICULTURA FAMILIAR
  · Documentos fiscais de entrega de produção (cooperativa, entreposto)
  · Licença/permissão do INCRA
  · Certidão do INCRA
  · Declaração de exercício de atividade rural (sindicato/colônia)
  · Carteira de sindicato ou colônia de pescadores
  · Programa de recebimento de sementes
  · Programa de corte da terra
  · Ficha de cadastro escolar dos filhos
  · Ficha da Secretaria de Saúde do Município
  · Cadastro do imóvel rural e ITR
  · Carteira de pescador profissional / da Marinha
  · Participação em programa de emergência
  · Benefício previdenciário (segurado especial) do autor / do grupo familiar
  · Certidão do TRE
- CADúnico: grupo familiar
- Benefícios em favor do autor / do grupo familiar (período)
- CNIS: vínculos e contribuições do autor e do grupo familiar
- CTPS: vínculos do autor e do grupo familiar

EM SALÁRIO-MATERNIDADE: Certidão de nascimento — nome do filho, data e
local de nascimento, nomes dos pais.

EM PENSÃO POR MORTE: Certidão de óbito — nome do falecido, data do óbito,
profissão, endereço, declarante, referência a cônjuge e filhos. Data de
nascimento do demandante (verificar pensão vitalícia). União estável:
declaração em cartório (data e período), sentença estadual reconhecendo
união estável (trânsito em julgado e período), comprovantes de endereço
dos cônjuges (datas e endereços), CADúnico.

EM BENEFÍCIO POR INCAPACIDADE: patologia, CID, DII (data início da
incapacidade), DCB (data de cessação do benefício).
`;

const ESTRUTURA_GENERICA = `\
Quando o processo NÃO for JEF previdenciário (verifique pela CLASSE e
ASSUNTO), monte um resumo executivo com as seguintes seções, adaptando
ao caso:

  1. **Identificação** — nº CNJ, classe, partes principais, valor da
     causa (se houver), órgão julgador.
  2. **Pedido** — o que o autor quer (em uma frase) e a fundamentação
     central. Listar pedidos secundários se houver.
  3. **Ponto controvertido** — o que efetivamente está em disputa após
     a contestação.
  4. **Provas relevantes** — síntese do que foi juntado (laudos,
     documentos, depoimentos, perícias) com o que cada um demonstra.
  5. **Posição da defesa** — preliminares e mérito da contestação.
  6. **Decisões / despachos** — saneador, despachos relevantes,
     decisões interlocutórias.
  7. **Ponto de atenção para a audiência** — o que o magistrado precisa
     esclarecer/perguntar/decidir hoje.

Mantenha o tom técnico e enxuto. Evite repetir o que já está em outras
seções. Cite o número do documento entre colchetes quando relevante
(ex.: "[doc 145331095]").
`;

export type SentencaJulgamento = 'Procedente' | 'Improcedente' | 'Extinto';

/**
 * Prompt para gerar uma SENTENÇA ORAL — texto pronto para o magistrado
 * ler em audiência, fundamentado nas provas dos autos. O `julgamento`
 * (Procedente/Improcedente/Extinto) é escolhido pelo magistrado ANTES
 * da geração; o modelo deve montar a fundamentação a partir das provas
 * encontradas no contexto.
 *
 * `orientacoes` (opcional): texto livre do magistrado com fatos
 * apurados em audiência (DIP, DIB, DCB, CIDs, declarações de
 * testemunhas, teses a destacar, etc.). Quando presente, o modelo
 * deve INCORPORAR essas orientações como fatos consolidados na
 * fundamentação — elas têm precedência sobre o conteúdo dos autos
 * em caso de conflito (são informações orais não-documentadas que
 * só o magistrado tem acesso direto).
 */
export function montarPromptSentencaOral(
  linha: DadosLinha,
  julgamento: SentencaJulgamento,
  orientacoes?: string
): string {
  const orientacaoEspecifica = (() => {
    switch (julgamento) {
      case 'Procedente':
        return `\
JULGAMENTO: PROCEDENTE.
Estruture a sentença oral acolhendo o pedido principal do autor. Funde
nas provas encontradas no contexto (documentos, laudos, depoimentos,
CNIS, certidões, dossiê INSS, etc.). Explique objetivamente por que
cada elemento essencial do direito foi reconhecido. Cite o número do
documento entre colchetes quando relevante (ex.: "[doc 145331107]").
Termine com o dispositivo: "Pelo exposto, JULGO PROCEDENTE o pedido,
para CONDENAR a parte ré a [...]". Defina prazos e parâmetros usuais
(juros, correção, honorários quando cabíveis no rito).`;
      case 'Improcedente':
        return `\
JULGAMENTO: IMPROCEDENTE.
Estruture a sentença oral rejeitando o pedido. Aponte qual elemento do
direito invocado não restou comprovado, com base nas provas dos autos.
Cite o número do documento entre colchetes para fundamentar
(ex.: "[doc 145498503]"). Seja objetivo na ratio decidendi. Termine
com o dispositivo: "Pelo exposto, JULGO IMPROCEDENTE o pedido,
extinguindo o processo com resolução do mérito (art. 487, I, do CPC)."`;
      case 'Extinto':
        return `\
JULGAMENTO: EXTINTO (sem resolução do mérito).
Estruture o decisum reconhecendo a hipótese de extinção que se aplica
ao caso (art. 485 do CPC) — identifique a partir do contexto qual
fundamento se sustenta (ex.: ausência de pressuposto processual,
inadequação da via, ilegitimidade, perda de objeto, abandono, etc.).
Cite o documento que evidencia a causa entre colchetes.
Termine com o dispositivo: "Pelo exposto, JULGO EXTINTO o processo,
sem resolução do mérito, com fundamento no art. 485, [inciso], do CPC."`;
    }
  })();

  return `\
Você vai gerar uma SENTENÇA ORAL pronta para o magistrado ler em
audiência, fundamentada nas provas dos autos contidos no contexto.

DADOS DA AUDIÊNCIA:
- Processo: ${linha.cnj}
- Data/hora: ${linha.dataHora}
- Tipo: ${linha.tipoAudiencia}
- Sala: ${linha.sala}
- Órgão julgador: ${linha.orgaoJulgador}
- Classe: ${linha.classe}
- Polo ativo: ${linha.autor}
- Polo passivo: ${linha.reu}

${orientacaoEspecifica}
${montarBlocoOrientacoes(orientacoes)}
ESTRUTURA OBRIGATÓRIA:
1. **Relatório oral mínimo** (1 parágrafo): identifica processo, partes,
   pedido e principais ocorrências processuais (citação, contestação,
   produção de provas).
2. **Fundamentação** (3 a 6 parágrafos): aplicação do direito ao caso
   concreto, baseada NAS PROVAS dos autos. Cite o tipo do documento e
   o id entre colchetes (ex.: "Conforme indeferimento administrativo
   [doc 145331107]..."). Não invente provas.
3. **Dispositivo**: na linha do julgamento escolhido (Procedente /
   Improcedente / Extinto) — vide instrução acima.
4. **Comandos finais**: trânsito em julgado a critério do(a) Sr(a).
   Magistrado(a), publicação em audiência, intimação das partes
   presentes, prazos recursais quando cabíveis.

REGRAS DE FORMA:
- Linguagem para LEITURA EM VOZ ALTA: períodos curtos a médios, sem
  abreviações excessivas, sem "etc." Pronuncia clara.
- Saída em **Markdown** (cabeçalhos com #, **negrito** para datas e
  pontos cruciais).
- Datas no formato DD/MM/AAAA. Períodos como "DD/MM/AAAA a DD/MM/AAAA".
- NÃO invente fatos ou documentos. Se um elemento essencial não estiver
  nos autos, registre "Conforme se infere dos autos" ou indique a
  ausência objetivamente.
- NUNCA mencione aspectos técnicos da extração de texto: OCR, qualidade
  de digitalização, "documento ilegível", "trecho truncado", limites
  de leitura ou similares. Esses são problemas da APLICAÇÃO, não do
  processo — não cabem em peça processual. Se o conteúdo de algum
  documento estiver insuficiente para fundamentar um ponto, simplesmente
  não cite aquele ponto (em vez de explicar por que não citou).
- Termine com a frase exata: "É a sentença, que será publicada em audiência."

Comece a sentença oral agora.`;
}

/**
 * Monta o bloco "ORIENTAÇÕES DO MAGISTRADO" para injetar no prompt da
 * sentença oral. Quando vazio/ausente, devolve string vazia (o prompt
 * segue só com as provas dos autos).
 */
function montarBlocoOrientacoes(orientacoes?: string): string {
  const t = (orientacoes ?? '').trim();
  if (!t) return '';
  return `\n\
ORIENTAÇÕES DO MAGISTRADO (informações apuradas em audiência —
prevalecem sobre os autos em caso de conflito; trate como FATOS
CONSOLIDADOS na fundamentação, sem questionar):
"""
${t}
"""
Incorpore esses fatos na fundamentação. Quando relevante, registre
explicitamente que decorrem do colhido em audiência (ex.: "Em
inquirição, restou esclarecido que..."). NÃO copie literalmente o
texto acima — reformule em linguagem técnica de sentença.
`;
}

export function montarPromptResumo(
  linha: DadosLinha,
  modo: 'filtrado' | 'todos'
): string {
  const aviso =
    modo === 'filtrado'
      ? '⚠️ Você recebeu apenas os documentos PRINCIPAIS do processo (petição inicial, emendas, contestação, despachos, decisões, sentenças, laudos, atas e principais petições). Algumas peças de menor relevância foram omitidas.'
      : 'Você recebeu TODOS os documentos do processo (sem filtro de tipo).';

  return `\
Você é um assistente para o magistrado conduzir uma audiência. Vai
gerar um RESUMO EXECUTIVO do processo abaixo, lendo TODOS os documentos
fornecidos no contexto e adaptando a estrutura ao tipo do processo.

${aviso}

DADOS DA PAUTA (preenchidos pelo PJe — confira contra os autos):
- Processo: ${linha.cnj}
- Data/hora da audiência: ${linha.dataHora}
- Tipo de audiência: ${linha.tipoAudiencia}
- Sala: ${linha.sala}
- Situação: ${linha.situacao}
- Órgão julgador: ${linha.orgaoJulgador}
- Classe: ${linha.classe}
- Polo ativo: ${linha.autor}
- Polo passivo: ${linha.reu}

REGRA DE ADAPTAÇÃO:
Se a CLASSE indicar JEF (Procedimento do Juizado Especial Cível,
Procedimento Comum Cível com competência JEF, etc.) E o assunto for
PREVIDENCIÁRIO ou ASSISTENCIAL (rural, salário-maternidade, pensão
por morte, benefício por incapacidade, BPC/LOAS, etc.), use o
ROTEIRO ABAIXO como CHECKLIST estrutural. Para cada item do
roteiro, preencha com o que ENCONTROU nos documentos — quando NÃO
encontrar, escreva "Não localizado nos autos" (sem inventar).

${ROTEIRO_JEF_PREVIDENCIARIO}

${ESTRUTURA_GENERICA}

REGRAS DE FORMA:
- Saída em **Markdown** (cabeçalhos com #, listas com -, **negrito**
  para destaques importantes como datas, CIDs, valores e CNIS).
- Datas no formato DD/MM/AAAA. Períodos como "DD/MM/AAAA a DD/MM/AAAA".
- NÃO invente dados. Se algum item do roteiro não estiver nos autos,
  diga "Não localizado nos autos".
- Cite o número do documento entre colchetes quando importante para
  rastreabilidade (ex.: "Indeferimento da DER em 12/03/2024 [doc 145331107]").
- NÃO faça juízo de mérito. NÃO sugira procedência/improcedência —
  isso será gerado em outro fluxo (sentença oral).
- NUNCA mencione aspectos técnicos da extração de texto: OCR,
  qualidade de digitalização, "documento ilegível", "trecho truncado",
  limites de leitura ou similares. Esses são problemas da APLICAÇÃO,
  não do processo. Se o conteúdo de algum documento estiver
  insuficiente, simplesmente não cite aquele ponto (em vez de explicar
  por que não citou).
- Termine com uma seção curta **"Pontos de atenção para a audiência"**
  com 3 a 6 itens objetivos do que o magistrado deve perguntar,
  esclarecer ou decidir hoje.

Comece o resumo agora.`;
}
