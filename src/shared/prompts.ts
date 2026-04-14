/**
 * System prompts e templates de quick actions usados pela Fase 4.
 * Centralizados aqui para facilitar iteração sem mexer em UI/lógica.
 */

import type { ProcessoDocumento } from './types';
import { CONTEXT_LIMITS } from './constants';

/** System prompt institucional para o assistente da JFCE. */
export const SYSTEM_PROMPT = `Você é o pAIdegua, um assistente de análise processual para servidores da Justiça Federal no Ceará (JFCE). Atue com rigor técnico, formalidade e precisão jurídica.

Diretrizes de resposta:
- Responda sempre em português brasileiro formal.
- Cite as peças processuais que embasam cada afirmação, indicando o ID e o tipo do documento (ex.: "conforme Laudo Pericial — id 152717156").
- Quando não houver elementos nos autos para responder, declare isso explicitamente em vez de inferir.
- Não invente fatos, datas, partes ou números que não constem dos documentos fornecidos.
- Ao analisar documentos digitalizados sem texto extraído, mencione expressamente que a peça precisa de OCR.
- Mantenha sigilo: trate todos os dados como sensíveis e nunca os reproduza fora do contexto da resposta.
- Quando solicitado a minutar peças, siga o estilo formal do Judiciário Federal e estruture com relatório, fundamentação e dispositivo quando aplicável.`;

/** Quick actions pré-definidas. */
export interface QuickActionDef {
  id: string;
  label: string;
  prompt: string;
}

export const QUICK_ACTIONS: readonly QuickActionDef[] = [
  {
    id: 'resumir',
    label: 'Resumir (FIRAC+)',
    prompt: `Consulte todos os documentos fornecidos na íntegra. Eles podem ter informações contraditórias. Por isso, faça uma leitura holística para captar todos os pontos controvertidos e todas as questões jurídicas na sua profundidade e totalidade.

## TAREFA PRINCIPAL
- ANALISE EM DETALHE o caso jurídico fornecido LENDO TODOS OS DOCUMENTOS, INCORPORE NUANCES e forneça uma ARGUMENTAÇÃO LÓGICA.
- Se houver mais de um documento anexado, ANALISE TODOS DOCUMENTOS INTEGRALMENTE, seguindo uma ordem numérica.
- Use o formato FIRAC+, seguindo rigorosamente a ESTRUTURA do MODELO abaixo.
- Cumpra rigorosamente todas as instruções aqui descritas. São mandatórias.

## ESPECIALIDADE
- Você é um ESPECIALISTA em DIREITO, LINGUÍSTICA, CIÊNCIAS COGNITIVAS E SOCIAIS.
- Incorpore as ESPECIALIDADES da MATÉRIA DE FUNDO do caso analisado.

## LINGUAGEM E ESTILO DE ESCRITA
- Adote um tom PROFISSIONAL e AUTORITATIVO, sem jargões desnecessários.
- Escreva de modo CONCISO, mas completo e abrangente, sem redundância.
- Seja econômico, usando apenas expressões necessárias para a clareza.
- Vá direto para a resposta, começando o texto com DADOS DO PROCESSO.

## ESTRUTURA (MODELO FIRAC+)

### **DADOS DO PROCESSO**
TRIBUNAL — TIPO DE RECURSO OU AÇÃO — NÚMERO DO PROCESSO — RELATOR — DATA DE JULGAMENTO — NOME DAS PARTES — NOME DOS ADVOGADOS POR PARTES.

### **FATOS**
ESCREVA UMA LISTA NUMERADA com todos os fatos, em ordem cronológica, com PROFUNDIDADE, DETALHES e MINÚCIAS, descrevendo os eventos, as datas e os nomes para a compreensão holística do caso.

### **PROBLEMA JURÍDICO**

#### **QUESTÃO CENTRAL**
ESTABELEÇA COM PROFUNDIDADE a questão central, enriquecendo a pergunta para respostas mais profundas.

#### **PONTOS CONTROVERTIDOS**
ESCREVA UMA LISTA NUMERADA delimitando os pontos controvertidos com base nas nuances do caso.

### **DIREITO APLICÁVEL**
LISTE as normas aplicáveis ao caso, referenciadas nos documentos.

### **ANÁLISE E APLICAÇÃO**

#### **ARGUMENTOS E PROVAS DO AUTOR**
ESCREVA UMA LISTA NUMERADA com todos os argumentos e provas do autor COM INFERÊNCIA LÓGICA.

#### **ARGUMENTOS E PROVAS DO RÉU**
ESCREVA UMA LISTA NUMERADA com todos os argumentos e provas do réu COM INFERÊNCIA LÓGICA.

### **CONCLUSÃO**
INFORME se o caso já foi solucionado. Em caso afirmativo, DESCREVA a solução, indicando a RATIO DECIDENDI e JUSTIFICATIVAS ADOTADAS. Quando não houver solução estabelecida, SEJA IMPARCIAL e apenas sugira direcionamentos.

## FONTES
Cite dados e informações estritamente referenciados no caso em análise, sem adicionar materiais externos. Cite sempre os IDs dos documentos que embasam cada afirmação.

## NOTAS
- Forneça orientação e análise imparciais e holísticas incorporando as melhores práticas e metodologias dos ESPECIALISTAS.
- Vá passo a passo para respostas complexas. Respire fundo. Dê o seu melhor.
- Ao detalhar os FATOS, assegure-se de prover uma riqueza de detalhes. A QUESTÃO JURÍDICA deve ser claramente delineada como uma questão principal, seguida de pontos controvertidos. Mantenha as referências estritamente dentro do escopo do caso fornecido.
- Termine com a expressão "FIM DA ANÁLISE".`
  },
  {
    id: 'minutar-despacho',
    label: 'Minutar despacho saneador',
    prompt:
      'Elabore minuta de despacho saneador para este processo, observando o ' +
      'art. 357 do CPC. Inclua: resolução das questões processuais pendentes, ' +
      'fixação dos pontos controvertidos, distribuição do ônus da prova e ' +
      'designação de provas (quando cabíveis). Use linguagem formal do Judiciário Federal.\n\n' +
      'REGRAS DE FORMATO (obrigatórias):\n' +
      '1. Texto em prosa corrida, parágrafos separados por linha em branco.\n' +
      '2. Sem nenhum marcador de markdown: nada de asteriscos, sustenidos, listas com hífen ou número, nem crases.\n' +
      '3. Citações textuais de lei ou doutrina devem aparecer em parágrafo próprio iniciado pelo sinal de maior seguido de espaço (> ), que indica recuo de citação.\n' +
      '4. NÃO inclua cabeçalho, número do processo, identificação das partes nem o título "DESPACHO" — esses elementos já são preenchidos automaticamente pelo editor do PJe. Comece diretamente pelo corpo da peça.\n' +
      '5. Encerre o texto com a linha "Fortaleza/CE, [data por extenso]." sem assinatura, nome ou cargo (também preenchidos pelo PJe).'
  },
  {
    id: 'partes',
    label: 'Listar partes',
    prompt:
      'Liste todas as partes do processo com suas qualificações (autor, réu, ' +
      'litisconsortes, terceiros interessados), CPF/CNPJ quando disponíveis nos autos ' +
      'e seus respectivos advogados/procuradores. Indique o documento de onde extraiu cada informação.'
  }
];

/** Prompt do botão "Resumo em áudio" — versão narrável. */
export const AUDIO_SUMMARY_PROMPT =
  'Produza um resumo narrável em até 8 frases curtas, em tom claro e direto, ' +
  'apropriado para leitura em voz alta. Evite siglas não explicadas, listas ' +
  'numeradas e citações longas. Apresente: partes envolvidas, objeto do pedido, ' +
  'cronologia mínima e situação atual. Não use marcadores nem cabeçalhos.';

// ─────────────────────────────────────────────────────────────────────────
//  AÇÕES DE MINUTA — usadas pelos 5 botões de geração assistida por modelos
// ─────────────────────────────────────────────────────────────────────────

/**
 * Definição de cada ação de minuta. `folderHints` orienta a busca BM25 a
 * priorizar templates que estejam em subpastas com esses nomes (ex.:
 * `procedente/`); `queryHints` é a query padrão usada quando o usuário
 * não fornece termos adicionais — uma frase curta que descreve o tipo de
 * peça e ajuda o BM25 a discriminar entre modelos.
 *
 * O `generationPrompt` é o prompt enviado ao LLM. Ele deve produzir texto
 * sem markdown (vide regras já consagradas em `minutar-despacho`) e
 * incorporar o template escolhido como referência de estilo/estrutura.
 */
export interface TemplateAction {
  id: string;
  /** Rótulo curto do botão na sidebar. */
  label: string;
  /** Descrição usada em tooltip e na bolha de preview. */
  description: string;
  /** Subpastas preferenciais (case-insensitive, contains). */
  folderHints: string[];
  /** Query padrão de busca (BM25). */
  queryHints: string;
  /**
   * Natureza da peça. Controla:
   *  - o prompt de geração (gabarito rígido vs. referência flexível)
   *  - termos que EXCLUEM um modelo da seleção (ex.: "sentença" exclui
   *    um template de ser usado como modelo de despacho)
   */
  natureza: 'sentenca' | 'decisao' | 'despacho' | 'voto';
  /**
   * Termos que, se presentes no caminho ou texto do modelo, indicam que
   * ele NÃO é adequado para esta ação. Serve como filtro negativo no BM25.
   */
  excludeTerms?: string[];
}

/** Conjunto de ações para o 1º grau (sentenças e decisões originárias). */
export const TEMPLATE_ACTIONS_1G: readonly TemplateAction[] = [
  {
    id: 'sentenca-procedente',
    label: 'Julgar procedente',
    description: 'Minuta de sentença julgando procedente o pedido inicial.',
    folderHints: ['procedente', 'procedencia', 'sentenca-procedente'],
    queryHints:
      'sentença julga procedente pedido autor condeno relatório fundamentação dispositivo',
    natureza: 'sentenca',
    excludeTerms: ['despacho', 'decisao interlocutoria', 'diligencia']
  },
  {
    id: 'sentenca-improcedente',
    label: 'Julgar improcedente',
    description: 'Minuta de sentença julgando improcedente o pedido inicial.',
    folderHints: ['improcedente', 'improcedencia', 'sentenca-improcedente'],
    queryHints:
      'sentença julga improcedente pedido autor relatório fundamentação dispositivo',
    natureza: 'sentenca',
    excludeTerms: ['despacho', 'decisao interlocutoria', 'diligencia']
  },
  {
    id: 'decidir',
    label: 'Decidir',
    description: 'Decisão interlocutória sobre questão pendente no processo.',
    folderHints: ['decisao', 'decisoes', 'interlocutoria'],
    queryHints:
      'decisão interlocutória defiro indefiro tutela urgência liminar antecipação',
    natureza: 'decisao',
    excludeTerms: ['sentença', 'julgo procedente', 'julgo improcedente', 'relatório fundamentação dispositivo']
  },
  {
    id: 'converter-diligencia',
    label: 'Converter em diligência',
    description: 'Despacho convertendo o julgamento em diligência.',
    folderHints: ['diligencia', 'diligencias', 'conversao'],
    queryHints:
      'converto julgamento diligência intime parte requerimento documento esclarecimento',
    natureza: 'despacho',
    excludeTerms: ['sentença', 'julgo procedente', 'julgo improcedente']
  },
  {
    id: 'despachar',
    label: 'Despachar',
    description: 'Despacho de impulsionamento processual.',
    folderHints: ['despacho', 'despachos', 'saneador'],
    queryHints:
      'despacho saneador expediente intimação cumprimento prazo manifestação cite intime',
    natureza: 'despacho',
    excludeTerms: ['sentença', 'julgo procedente', 'julgo improcedente', 'relatório fundamentação dispositivo']
  }
];

/**
 * Conjunto de ações para o 2º grau e turmas recursais (votos, decisões
 * monocráticas e despachos relatoriais).
 */
export const TEMPLATE_ACTIONS_2G: readonly TemplateAction[] = [
  {
    id: 'voto-mantem',
    label: 'Voto (mantém sentença)',
    description: 'Minuta de voto que nega provimento ao recurso e mantém a sentença recorrida.',
    folderHints: ['voto-mantem', 'mantem', 'nega-provimento', 'desprovimento', 'voto'],
    queryHints:
      'voto nega provimento recurso mantém sentença improvimento desprovimento relator',
    natureza: 'voto',
    excludeTerms: ['despacho']
  },
  {
    id: 'voto-reforma',
    label: 'Voto (reforma sentença)',
    description: 'Minuta de voto que dá provimento ao recurso e reforma a sentença recorrida.',
    folderHints: ['voto-reforma', 'reforma', 'da-provimento', 'provimento', 'voto'],
    queryHints:
      'voto dá provimento recurso reforma sentença provimento relator acórdão',
    natureza: 'voto',
    excludeTerms: ['despacho']
  },
  {
    id: 'decisao-nega-seguimento',
    label: 'Decisão nega seguimento ao recurso',
    description: 'Decisão monocrática que nega seguimento ao recurso (art. 932 do CPC).',
    folderHints: ['nega-seguimento', 'inadmissao', 'monocratica', 'decisao-monocratica'],
    queryHints:
      'decisão monocrática nega seguimento recurso inadmissibilidade artigo 932 CPC relator',
    natureza: 'decisao',
    excludeTerms: ['despacho', 'voto']
  },
  {
    id: 'decisao-2g',
    label: 'Decisão',
    description: 'Decisão monocrática do relator sobre questão pendente.',
    folderHints: ['decisao', 'decisoes', 'monocratica'],
    queryHints:
      'decisão monocrática relator tutela antecipada efeito suspensivo liminar',
    natureza: 'decisao',
    excludeTerms: ['despacho', 'voto', 'sentença']
  },
  {
    id: 'converter-diligencia-baixa',
    label: 'Converte em diligência com baixa',
    description: 'Despacho convertendo o julgamento em diligência com baixa dos autos à origem.',
    folderHints: ['diligencia-baixa', 'baixa-diligencia', 'baixa', 'diligencia'],
    queryHints:
      'converte julgamento diligência baixa autos origem juízo primeiro grau esclarecimento',
    natureza: 'despacho',
    excludeTerms: ['sentença', 'voto']
  },
  {
    id: 'despachar-2g',
    label: 'Despacho',
    description: 'Despacho de mero expediente do relator.',
    folderHints: ['despacho', 'despachos', 'relator'],
    queryHints:
      'despacho relator expediente intimação cumprimento prazo manifestação',
    natureza: 'despacho',
    excludeTerms: ['sentença', 'voto', 'julgo procedente', 'julgo improcedente']
  }
];

/**
 * Mantido por compatibilidade — equivale ao conjunto de 1º grau.
 * Prefira `getTemplateActionsForGrau` em código novo.
 */
export const TEMPLATE_ACTIONS: readonly TemplateAction[] = TEMPLATE_ACTIONS_1G;

/**
 * Retorna o conjunto de ações de minuta apropriado para o grau detectado.
 * 1º grau usa sentenças/decisões originárias; 2º grau e turmas recursais
 * usam votos, decisões monocráticas e despachos relatoriais.
 */
export function getTemplateActionsForGrau(
  grau: '1g' | '2g' | 'turma_recursal' | 'unknown'
): readonly TemplateAction[] {
  if (grau === '2g' || grau === 'turma_recursal') {
    return TEMPLATE_ACTIONS_2G;
  }
  return TEMPLATE_ACTIONS_1G;
}

/** Regras de formato comuns a todas as minutas geradas. */
const MINUTA_FORMAT_RULES = `REGRAS DE FORMATO (obrigatórias):
1. Texto em prosa corrida, parágrafos separados por linha em branco.
2. Sem nenhum marcador de markdown: nada de asteriscos, sustenidos, listas com hífen ou número, nem crases.
3. Citações textuais de lei ou doutrina devem aparecer em parágrafo próprio iniciado pelo sinal de maior seguido de espaço (> ), que indica recuo de citação.
4. NÃO inclua cabeçalho, número do processo, identificação das partes nem o título do ato — esses elementos já são preenchidos automaticamente pelo editor do PJe. Comece diretamente pelo corpo da peça.
5. Encerre o texto com a linha "[Cidade]/[UF], datado eletronicamente." — identifique a cidade e o estado da vara/seção judiciária a partir dos documentos do processo (ex.: "Maracanaú/CE", "Recife/PE", "São Paulo/SP"). Não use assinatura, nome ou cargo (preenchidos pelo PJe).`;

/**
 * Instruções específicas por natureza de peça, para geração SEM modelo.
 */
const INSTRUCOES_SEM_MODELO: Record<TemplateAction['natureza'], string> = {
  sentenca:
    `Redija a sentença do zero, seguindo a praxe do Judiciário Federal. ` +
    `Estruture com relatório (breve histórico processual), fundamentação ` +
    `(análise das provas e do direito aplicável) e dispositivo (comando ` +
    `decisório, honorários, custas). Use como base os documentos do ` +
    `processo já carregados no contexto.`,
  decisao:
    `Redija a decisão interlocutória do zero, analisando a questão pendente ` +
    `identificada nos autos. Fundamente com base na legislação e nas provas ` +
    `disponíveis. NÃO estruture como sentença (sem relatório extenso nem ` +
    `dispositivo de mérito). Use linguagem objetiva e direta, focada no ` +
    `ponto a ser decidido. Use como base os documentos do processo já ` +
    `carregados no contexto.`,
  despacho:
    `Redija o despacho do zero, como ato de impulsionamento processual. ` +
    `Despachos são breves e objetivos — determinem providências concretas ` +
    `(intimações, prazos, juntadas, conversões, cumprimentos). NÃO ` +
    `estruture como sentença ou decisão (sem relatório, fundamentação ` +
    `extensa nem dispositivo de mérito). Analise a situação atual do ` +
    `processo nos documentos carregados e determine o próximo passo ` +
    `processual adequado.`,
  voto:
    `Redija o voto do zero, seguindo a praxe do Judiciário Federal de 2º ` +
    `grau. Estruture com relatório, voto (fundamentação e conclusão) e ` +
    `ementa. Use como base os documentos do processo já carregados no ` +
    `contexto.`
};

/**
 * Instruções de gabarito por natureza — sentenças e votos usam gabarito
 * rígido (parágrafo a parágrafo); decisões e despachos usam o modelo
 * como referência flexível de estilo.
 */
function buildTemplateBlock(
  action: TemplateAction,
  template: { relativePath: string; text: string }
): string {
  if (action.natureza === 'sentenca' || action.natureza === 'voto') {
    return `ATENÇÃO — PRODUÇÃO EM SÉRIE COM GABARITO FIXO:

O modelo abaixo é um GABARITO (template). Você deve reproduzir a peça PARÁGRAFO A PARÁGRAFO, mantendo:
  - a mesma sequência de seções/tópicos, na mesma ordem;
  - os mesmos fundamentos legais (artigos de lei, súmulas, teses) citados em cada seção;
  - o mesmo estilo de redação, tom, nível de formalidade e extensão de cada parágrafo;
  - as mesmas frases-padrão e fórmulas de estilo (ex.: "Passo a decidir.", "Ante o exposto…");
  - a mesma estrutura do dispositivo (comandos, condenações, honorários, custas).

O QUE VOCÊ DEVE TROCAR (e SOMENTE isto):
  - nomes das partes → usar os nomes do processo em análise;
  - fatos e circunstâncias → adaptar ao caso concreto (laudo, datas, valores, provas);
  - número do processo, datas de audiência, datas de perícia → do processo atual;
  - análise probatória e subsunção → baseadas nas provas dos autos em análise;
  - conclusão (procedência/improcedência parcial) → se os fatos do caso concreto assim exigirem.

NÃO FAÇA:
  - NÃO reorganize as seções; NÃO omita seções presentes no modelo; NÃO acrescente seções que o modelo não tem.
  - NÃO troque os fundamentos legais por outros, a menos que sejam manifestamente inaplicáveis ao caso concreto.
  - NÃO resuma nem encurte o modelo — a peça final deve ter extensão comparável.
  - NÃO copie dados factuais do modelo (nomes, CPF, datas, valores) — esses vêm exclusivamente do processo em análise.

=== GABARITO (modelo de referência): ${template.relativePath} ===
${template.text}
=== FIM DO GABARITO ===

Agora, com base nos documentos do processo em análise (já carregados no contexto), redija a peça reproduzindo fielmente a estrutura do gabarito acima, substituindo apenas os dados do caso concreto.`;
  }

  // Decisões e despachos: modelo como REFERÊNCIA de estilo, não gabarito rígido
  return `MODELO DE REFERÊNCIA (use como inspiração de estilo e tom, NÃO como gabarito rígido):

O modelo abaixo é uma referência de estilo. Use-o para:
  - observar o tom, nível de formalidade e vocabulário típico deste tipo de peça;
  - entender a extensão esperada (despachos são curtos; decisões são moderadas);
  - identificar fórmulas de estilo recorrentes.

NÃO copie a estrutura parágrafo a parágrafo. A peça que você vai redigir deve ser original, baseada exclusivamente nos fatos e nas questões do processo em análise. O modelo é apenas uma referência de como peças deste tipo costumam ser redigidas.

=== REFERÊNCIA DE ESTILO: ${template.relativePath} ===
${template.text}
=== FIM DA REFERÊNCIA ===

Agora, com base nos documentos do processo em análise (já carregados no contexto), redija a peça adequada à situação processual atual.`;
}

/**
 * Constrói o prompt de geração de uma minuta a partir de uma ação e,
 * opcionalmente, de um template-modelo.
 *
 * Sentenças e votos: gabarito rígido (parágrafo a parágrafo).
 * Decisões e despachos: modelo como referência de estilo, com geração
 * orientada pela situação processual concreta.
 */
export function buildMinutaPrompt(
  action: TemplateAction,
  template: { relativePath: string; text: string } | null,
  refinement?: string
): string {
  const intro = `Elabore uma ${action.description.toLowerCase().replace(/\.$/, '')} para o processo carregado nos autos.`;

  const body = template
    ? buildTemplateBlock(action, template)
    : INSTRUCOES_SEM_MODELO[action.natureza];

  const refinementBlock = refinement
    ? `\n\nINSTRUÇÕES ADICIONAIS DO USUÁRIO (devem ser observadas na fundamentação e no resultado):\n${refinement}`
    : '';

  return `${intro}\n\n${body}${refinementBlock}\n\n${MINUTA_FORMAT_RULES}`;
}

// ─────────────────────────────────────────────────────────────────────────
//  TRIAGEM DE MINUTA — decide o melhor ato processual para o momento atual
// ─────────────────────────────────────────────────────────────────────────

/** Resultado estruturado da triagem produzida pelo LLM. */
export interface TriagemResult {
  /** id de uma TemplateAction pertencente ao grau adequado. */
  actionId: string;
  /** Justificativa curta (até 3 linhas) explicando a escolha. */
  justificativa: string;
}

/**
 * Limite de contexto enviado ao LLM de triagem. Aumentado para caber a
 * linha do tempo completa do processo + os últimos 8 documentos em texto
 * integral (ver `buildTriagemContextText` no content). Sem isso, o LLM
 * só enxergava inicial/contestação e recomendava atos já superados em
 * processos longos (ex.: sugerir perícia num processo já em cumprimento).
 */
const TRIAGEM_CASE_CONTEXT_LIMIT = 18_000;

/**
 * Monta o prompt de triagem: apresenta ao LLM o texto dos autos e o
 * conjunto de atos processuais possíveis (já filtrado por grau), pedindo
 * que escolha UM e justifique em até 3 linhas.
 */
export function buildTriagemPrompt(
  actions: readonly TemplateAction[],
  caseContext: string
): string {
  const actionsFmt = actions
    .map(
      (a) =>
        `- id: "${a.id}" — **${a.label}** (${a.natureza}): ${a.description}`
    )
    .join('\n');

  return (
    `Você está ajudando um magistrado a decidir qual é o MELHOR ato processual para o momento atual do processo.\n\n` +
    `COMO LER O CONTEXTO:\n` +
    `O contexto abaixo traz DOIS blocos complementares:\n` +
    `  1) "LINHA DO TEMPO DO PROCESSO" — panorama cronológico de TODAS as movimentações;\n` +
    `  2) "DOCUMENTOS RECENTES" — texto integral dos últimos documentos.\n\n` +
    `PRINCÍPIOS DE ANÁLISE (aplique a QUALQUER caso concreto, sem presumir cenário típico):\n` +
    `- Identifique a fase processual atual a partir da ÚLTIMA movimentação relevante, não da primeira.\n` +
    `- Um ato só é adequado se a providência que ele realiza AINDA NÃO foi efetivada e se não pressupõe etapa posterior à atual.\n` +
    `- Nunca recomende ato incompatível com a fase em que o processo se encontra, em qualquer direção (nem retroceder etapas já cumpridas, nem antecipar etapas ainda não maduras).\n` +
    `- Se houver pedido, requerimento ou manifestação pendente de apreciação, esse é o ponto de partida para escolher o ato.\n` +
    `- Se não houver pendência clara, escolha o ato de impulsionamento mais adequado à fase atual.\n\n` +
    `FATORES A CONSIDERAR:\n` +
    `- fase efetiva do processo (postulatória, saneamento, instrução, julgamento, recurso, cumprimento, arquivamento — ou qualquer outra identificável);\n` +
    `- questões processuais pendentes (citação, intimação, produção de provas, nulidades, preliminares);\n` +
    `- existência ou não de elementos suficientes para o ato pretendido;\n` +
    `- natureza da causa, pretensão deduzida e providências já realizadas.\n\n` +
    `Escolha EXATAMENTE UM dos atos listados. Se NENHUM dos atos disponíveis for apropriado ao momento processual concreto (por exemplo, porque o processo já ultrapassou a fase a que se destinam os atos listados, ou ainda não atingiu fase em que caibam), escolha o ato que menos distorça a realidade dos autos e DEIXE CLARO NA JUSTIFICATIVA essa inadequação, descrevendo qual seria o ato realmente cabível.\n\n` +
    `=== ATOS DISPONÍVEIS ===\n${actionsFmt}\n\n` +
    `=== CONTEXTO DOS AUTOS ===\n` +
    '```\n' +
    caseContext.slice(0, TRIAGEM_CASE_CONTEXT_LIMIT) +
    '\n```\n\n' +
    `Responda SEMPRE em JSON puro, sem markdown, sem comentários, no formato exato:\n` +
    `{"actionId": "<id escolhido, obrigatoriamente um dos listados acima>", "justificativa": "<explicação curta em PT-BR, no máximo 3 linhas, citando o estado do processo que justifica a escolha>"}\n\n` +
    `NÃO inclua mais nada além do JSON.`
  );
}

/**
 * Extrai {actionId, justificativa} de uma resposta bruta do LLM. Tolera
 * markdown ou texto adicional em volta do objeto JSON.
 * Retorna null se o `actionId` não estiver na lista permitida.
 */
export function parseTriagemResponse(
  raw: string,
  allowedActionIds: readonly string[]
): TriagemResult | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      actionId?: unknown;
      justificativa?: unknown;
    };
    const actionId = typeof obj.actionId === 'string' ? obj.actionId.trim() : '';
    if (!actionId || !allowedActionIds.includes(actionId)) return null;
    const justificativa =
      typeof obj.justificativa === 'string' ? obj.justificativa.trim() : '';
    return { actionId, justificativa };
  } catch {
    return null;
  }
}

/**
 * Monta o bloco de contexto com os documentos extraídos. Aplica truncamento
 * conservador para não estourar o context window do modelo. Documentos
 * digitalizados sem texto extraído são incluídos apenas como metadata.
 */
export function buildDocumentContext(
  documentos: ProcessoDocumento[],
  numeroProcesso: string | null
): string {
  const header = numeroProcesso
    ? `Processo: ${numeroProcesso}\n\n=== Documentos disponíveis nos autos ===\n`
    : '=== Documentos disponíveis nos autos ===\n';

  const blocks: string[] = [];
  let totalChars = header.length;
  let truncados = 0;

  for (const doc of documentos) {
    const ocrTag = doc.isScanned && doc.textoExtraido ? ' | texto via OCR' : '';
    const head = `\n--- Documento id ${doc.id} | ${doc.tipo} | ${doc.descricao} ${
      doc.dataMovimentacao ? `(${doc.dataMovimentacao})` : ''
    }${ocrTag} ---\n`;

    let body: string;
    if (doc.isScanned && !doc.textoExtraido) {
      body = '[documento digitalizado — OCR ainda não disponível, conteúdo não extraído]\n';
    } else if (doc.textoExtraido) {
      body = doc.textoExtraido;
      if (body.length > CONTEXT_LIMITS.PER_DOCUMENT_HARD_CAP) {
        body = body.slice(0, CONTEXT_LIMITS.PER_DOCUMENT_HARD_CAP) +
          '\n[…trecho truncado para caber no contexto…]';
      }
    } else {
      body = '[conteúdo não extraído]\n';
    }

    const block = head + body;
    if (totalChars + block.length > CONTEXT_LIMITS.MAX_DOCUMENTS_CHARS) {
      truncados++;
      continue;
    }
    blocks.push(block);
    totalChars += block.length;
  }

  let footer = '';
  if (truncados > 0) {
    footer = `\n\n[Aviso: ${truncados} documento(s) foram omitidos do contexto por excederem o limite de tamanho. Solicite análises focadas para incluí-los.]`;
  }

  return header + blocks.join('') + footer;
}
