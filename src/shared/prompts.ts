/**
 * System prompts e templates de quick actions usados pela Fase 4.
 * Centralizados aqui para facilitar iteração sem mexer em UI/lógica.
 */

import type {
  AnaliseProcessoResult,
  PAIdeguaSettings,
  ProcessoDocumento
} from './types';
import { CONTEXT_LIMITS, TRIAGEM_CRITERIOS } from './constants';

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
 * Ações de minuta exclusivas da Triagem Inteligente (perfil Secretaria).
 * Não entram no botão "Minutar" do Gabinete nem no menu de escolha manual,
 * são chamadas diretamente pelo orquestrador de "Analisar o processo".
 */
export const TEMPLATE_ACTIONS_TRIAGEM: readonly TemplateAction[] = [
  {
    id: 'emenda-inicial',
    label: 'Emenda à inicial',
    description:
      'Ato de emenda à inicial determinando à parte autora que sane os critérios não atendidos identificados na triagem.',
    folderHints: ['emenda', 'emenda-inicial'],
    queryHints:
      'emenda inicial intimação parte autora prazo correção petição inicial indeferimento',
    natureza: 'despacho',
    excludeTerms: ['sentença', 'voto', 'julgo procedente', 'julgo improcedente']
  }
];

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

/**
 * Monta o bloco de critérios de análise inicial adotados pelo magistrado,
 * para injeção dinâmica nos prompts das ações da Triagem Inteligente
 * (Analisar tarefas, Analisar processo, Inserir etiquetas mágicas).
 *
 * Para cada critério da NT 1/2025 do CLI-JFCE, usa a redação padrão se
 * `adopted=true`, ou o entendimento próprio do magistrado em caso contrário.
 * Critérios customizados (livres, definidos pelo usuário) entram ao final.
 *
 * Devolve string vazia quando não há nada para emitir — o chamador decide
 * se concatena ao system prompt ou omite.
 */
export function buildTriagemCriteriosBlock(settings: PAIdeguaSettings): string {
  const lines: string[] = [];
  let idx = 1;
  for (const criterio of TRIAGEM_CRITERIOS) {
    const setting = settings.triagemCriterios?.[criterio.id];
    if (setting && setting.adopted === false) {
      const custom = (setting.customText ?? '').trim();
      if (custom) {
        lines.push(
          `${idx}. ${criterio.label} (entendimento próprio do magistrado): ${custom}`
        );
      } else {
        // Adoção retirada e sem texto próprio: o magistrado descartou o
        // critério. Sinalize explicitamente para a IA não voltar a invocá-lo.
        lines.push(
          `${idx}. ${criterio.label}: este critério NÃO é adotado por este magistrado.`
        );
      }
    } else {
      lines.push(`${idx}. ${criterio.label}: ${criterio.defaultText}`);
    }
    idx += 1;
  }

  const customs = (settings.triagemCriteriosCustom ?? [])
    .map((c) => (c.text ?? '').trim())
    .filter((t) => t.length > 0);
  for (const text of customs) {
    lines.push(`${idx}. (Critério adicional do magistrado): ${text}`);
    idx += 1;
  }

  if (lines.length === 0) return '';

  return (
    `## CRITÉRIOS DE ANÁLISE INICIAL ADOTADOS POR ESTE MAGISTRADO\n` +
    `(Base: Nota Técnica nº 1/2025 do CLI-JFCE, com personalizações onde indicado)\n\n` +
    lines.join('\n')
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  ANALISAR O PROCESSO — checklist dos critérios contra os autos
// ─────────────────────────────────────────────────────────────────────────

/**
 * Critério resolvido na configuração do magistrado: `id` estável,
 * `label` curto e o `texto` que deve ser usado pelo LLM (NT padrão ou
 * entendimento próprio). Critérios marcados como descartados (adoção
 * retirada e sem texto próprio) NÃO entram nesta lista — não há o que
 * verificar nos autos.
 */
export interface CriterioResolvido {
  id: string;
  label: string;
  texto: string;
}

/**
 * Devolve a lista plana de critérios efetivamente adotados por este
 * magistrado, na ordem em que devem aparecer na resposta do LLM.
 *
 * - Critérios da NT 1/2025 marcados como adotados → texto padrão.
 * - Critérios da NT com adoção retirada mas com texto próprio → texto próprio.
 * - Critérios da NT descartados sem texto próprio → omitidos.
 * - Critérios livres (não vazios) → adicionados ao final com id `custom-N`.
 */
export function resolveTriagemCriterios(
  settings: PAIdeguaSettings
): CriterioResolvido[] {
  const out: CriterioResolvido[] = [];
  for (const criterio of TRIAGEM_CRITERIOS) {
    const setting = settings.triagemCriterios?.[criterio.id];
    if (setting && setting.adopted === false) {
      const custom = (setting.customText ?? '').trim();
      if (!custom) continue;
      out.push({ id: criterio.id, label: criterio.label, texto: custom });
    } else {
      out.push({
        id: criterio.id,
        label: criterio.label,
        texto: criterio.defaultText
      });
    }
  }
  let idx = 1;
  for (const c of settings.triagemCriteriosCustom ?? []) {
    const txt = (c.text ?? '').trim();
    if (!txt) {
      idx += 1;
      continue;
    }
    out.push({
      id: `custom-${idx}`,
      label: `Critério adicional ${idx}`,
      texto: txt
    });
    idx += 1;
  }
  return out;
}

/**
 * Limite de contexto enviado ao LLM de análise. Maior que o da triagem
 * de minuta porque precisa absorver, além da linha do tempo + últimos
 * documentos integrais, os blocos "METADADOS DO PROCESSO" e "DATAS
 * CANDIDATAS" prefixados pelo content em `buildAnaliseProcessoContextText`.
 */
const ANALISE_CASE_CONTEXT_LIMIT = 22_000;

/**
 * Monta o prompt de análise do processo contra o checklist de critérios.
 * Espera resposta JSON puro (sem markdown), validada por
 * `parseAnaliseProcessoResponse`.
 */
export function buildAnaliseProcessoPrompt(
  criterios: readonly CriterioResolvido[],
  caseContext: string
): string {
  const criteriosFmt = criterios
    .map(
      (c) =>
        `- id: "${c.id}" — **${c.label}**\n  texto do critério: ${c.texto}`
    )
    .join('\n');

  return (
    `Você é um assistente técnico que auxilia a Secretaria ou Gabinete de uma unidade judiciária na análise inicial de processos. Sua tarefa é verificar, de forma sistemática e conservadora, se a petição inicial e os documentos que a acompanham atendem aos critérios de admissibilidade adotados pelo magistrado — critérios que lhe serão apresentados adiante.\n\n` +
    `Você não decide o que é admissível em abstrato. Você apenas verifica, contra a lista de critérios dada, o que cada documento dos autos demonstra. A definição do que importa para esta causa específica já foi feita por quem configurou a lista de critérios.\n\n` +
    `## PRINCÍPIOS FUNDAMENTAIS — leia antes de qualquer regra técnica\n\n` +
    `1. Supervisão humana é obrigatória, não sugestiva. Você NÃO decide nada. Você produz uma hipótese de trabalho que será lida, conferida e assumida por um servidor ou magistrado. Suas conclusões alimentam o raciocínio humano — jamais o substituem. Escreva sempre em linguagem que admita conferência e correção, nunca em tom sentencial.\n` +
    `2. In dubio, remeta ao humano. Diante de dúvida razoável (texto truncado, OCR degradado, documento presente mas ilegível, datas ambíguas, campos manuscritos não extraídos), NÃO marque "não atendido" com base em inferência desfavorável à parte. Marque como atendido e registre a dúvida no campo "pontosDeConferenciaHumana". Uma emenda indevida gera retrabalho, atrasa a causa e prejudica quem tem razão.\n` +
    `3. Zero alucinação de IDs e fatos. JAMAIS cite um id de documento que não esteja literalmente no contexto dos autos fornecido. JAMAIS invente datas, nomes, números ou quaisquer dados. Se não houver base textual no contexto, diga isso explicitamente na justificativa.\n` +
    `4. Prioridade do conteúdo sobre a forma. Se o documento materialmente supre a exigência — ainda que com nome de arquivo genérico, leiaute não-canônico, ou OCR parcial — considere atendido e, quando necessário, aponte conferência visual. Não rejeite por detalhes formais quando o substrato material está presente.\n` +
    `5. Proporcionalidade na providência. Quando um critério não está atendido, peça APENAS o que resolve o problema concretamente identificado. Não amontoe exigências, não repita documentos que já estão nos autos, não exija forma mais solene quando o critério admite forma menos solene.\n` +
    `6. Fidelidade ao critério, não ao seu senso pessoal. Os critérios listados são a lei do seu trabalho. Não inclua exigências adicionais que você julgue razoáveis mas que não constem ali. Não dispense exigências que você julgue excessivas mas que constem ali. Sua função é aplicar os critérios, não revisá-los.\n` +
    `7. Sigilo de dados sensíveis na resposta. Nas justificativas e nos campos textuais, NÃO transcreva documentos de identificação, números externos, endereços completos nem nomes por extenso. Use iniciais para pessoas físicas (ex.: "F.S.") e mascare números quando precisar referenciá-los. O servidor vê os dados originais no sistema; o seu resumo não precisa replicá-los.\n\n` +
    `## ESTRUTURA DOS DOCUMENTOS NO CONTEXTO\n\n` +
    `Cada documento aparece como \`{data} — {TIPO} — "{DESCRIÇÃO/NOME DO ARQUIVO}" (id N)\`.\n` +
    `- TIPO é a categoria canônica atribuída pelo sistema processual (frequentemente genérica, ex.: "Outros Documentos", "Petição").\n` +
    `- DESCRIÇÃO é o nome do arquivo atribuído por quem o juntou (ex.: um nome descritivo ou apenas "documento.pdf").\n` +
    `- Quando um critério exigir "nomeação correta" ou identificação do documento, considere ATENDIDO quando TIPO **ou** DESCRIÇÃO permita identificar imediatamente o conteúdo. Só marque como NÃO atendido se AMBOS forem genéricos a ponto de impedir a identificação (ex.: TIPO "Outros Documentos" e DESCRIÇÃO "documento.pdf", sem qualquer outra pista). Não rejeite por convenção estética: rótulos equivalentes em palavras diferentes servem ao mesmo propósito.\n\n` +
    `## METADADOS E DATAS\n\n` +
    `### Blocos prefixados ao contexto\n` +
    `- O bloco "METADADOS DO PROCESSO" traz, entre outras informações, a data de ajuizamento e a data de hoje. Use a data de ajuizamento (ou, na falta, o ano do número CNJ) como MARCO INICIAL para a contagem de qualquer prazo definido no critério aplicável (ex.: prazos típicos de 1 ano para procurações e comprovantes de endereço, quando o critério assim dispuser).\n` +
    `- NUNCA use a data de juntada ao sistema processual (aquela do cabeçalho \`{data} — TIPO —\`) como data de emissão do documento. A data de juntada é quando o arquivo foi subido ao sistema; a data de emissão é o que consta no conteúdo do documento. São coisas distintas, e confundi-las é fonte recorrente de emendas indevidas.\n` +
    `- O bloco "DATAS CANDIDATAS", quando presente, lista todas as datas aparentes no texto extraído de documentos data-sensíveis. Ao avaliar esses critérios, escolha a data relevante APENAS entre as datas dessa lista. Não invente nem transcreva datas fora dela.\n` +
    `- Se um documento aparecer em "DATAS CANDIDATAS" com "nenhuma data encontrada", considere o critério correspondente como NÃO atendido e solicite documento com data legível. EXCEÇÃO: quando o OCR claramente falhou mas o conteúdo material do documento é identificável a partir do restante do texto extraído, trate como atendido e recomende conferência visual no PDF original em "pontosDeConferenciaHumana" — templates com preenchimento manuscrito frequentemente escapam ao OCR automático.\n\n` +
    `### Regras para datas em procurações\n` +
    `- A data relevante é a da assinatura do outorgante, tipicamente ao final do documento, imediatamente antes ou depois do bloco de assinatura, no padrão "Cidade/UF, DD de mês de AAAA" ou "Cidade/UF, DD/MM/AAAA".\n` +
    `- Havendo várias datas candidatas, escolha a que está ao lado de um topônimo (cidade/UF) e, em empate, a mais recente/posterior no texto.\n` +
    `- JAMAIS use datas que apareçam dentro do corpo dos poderes citando normas, portarias, leis, decretos, resoluções, instruções normativas, artigos, súmulas, acórdãos, ou datas de documentos pessoais (RG, CPF, nascimento). Essas datas são apenas citadas, não são data de emissão.\n` +
    `- Se NENHUMA data candidata for plausível (todas são citações ou a lista está vazia) mas a procuração tiver estrutura identificável, NÃO rejeite pelo prazo: marque como atendido, mencione na justificativa que "a data de assinatura não foi extraída pelo OCR" e registre em "pontosDeConferenciaHumana" a necessidade de verificação no PDF original.\n` +
    `- Em caso de substabelecimento, a procuração de referência para o prazo é a do outorgante originário, NÃO a do substabelecimento.\n\n` +
    `### Regras para datas em documentos data-sensíveis (ex.: contas, faturas, boletos, declarações)\n` +
    `- Prefira, em geral, a data de emissão, leitura ou competência em vez da data de vencimento.\n` +
    `- Havendo várias datas candidatas do mesmo tipo, prefira a mais recente (que tende a ser a mais favorável à parte).\n` +
    `- Em qualquer caso, cite na justificativa a data escolhida e o id do documento (ex.: "documento datado de 10/10/2025 — id 154216406").\n\n` +
    `### Regras para procuração a rogo (parte impossibilitada de assinar)\n` +
    `Estas regras valem quando o critério aplicável contemplar a hipótese de parte analfabeta ou impossibilitada de assinar. Se o critério não mencionar essa hipótese, ignore esta subseção.\n` +
    `- A procuração particular a rogo, com duas testemunhas, é plenamente válida. NÃO exija instrumento público, cartório, nem reconhecimento de firma salvo se o critério expressamente o fizer.\n` +
    `- Considere o critério ATENDIDO sob a forma a rogo quando houver, no texto extraído, QUALQUER evidência dos seguintes elementos: (a) marcador de rogo — qualquer ocorrência de termos como "rogo", "a rogo", "assina a rogo", "assina o rogado", "ragado" (erro comum de digitação), "rogante", "a pedido de", "por não saber/poder assinar", "declaro-me analfabeto(a)", ou equivalentes, mesmo isolados, em caixa alta, ou dentro de template impresso; (b) presença de rogado — nome ou linha destinada a quem assina pelo outorgante; (c) duas testemunhas — qualquer ocorrência de duas rotulações "Testemunha", "Test.:", "Test. 1", "Test. 2", ou pares de rótulos "CPF:"/"RG:" no bloco de assinaturas.\n` +
    `- Tolerância ampla ao OCR. Procurações em papel são frequentemente templates impressos com preenchimento manuscrito — o OCR captura o template mas falha nos nomes e números escritos à mão. Quando o TEMPLATE contiver marcadores de rogo e rótulos de testemunhas, mas os preenchimentos forem ilegíveis, PRESUMA o critério atendido e registre em "pontosDeConferenciaHumana" a verificação dos nomes manuscritos.\n` +
    `- Variações ortográficas e erros de digitação ("Ragado", "Rogante", "arrogo", "Rogádo") NÃO descaracterizam a procuração a rogo. Valorize o sentido sobre a forma.\n` +
    `- Só marque como NÃO atendido se NÃO houver NENHUM marcador de rogo no texto extraído OU quando houver apenas UMA testemunha evidente sem qualquer outra indicação.\n` +
    `- NÃO rejeite pela simples ausência de cópias dos documentos pessoais de rogado/testemunhas — a menos que o critério aplicável as exija textualmente. Se os três elementos estruturais estiverem presentes, considere atendido.\n\n` +
    `## VALIDAÇÃO CRUZADA DE IDENTIDADE\n\n` +
    `Quando o contexto trouxer o bloco de METADADOS DO PROCESSO com dados cadastrais das partes e os documentos pessoais estiverem anexos:\n` +
    `- Verifique se o nome registrado no cadastro do sistema processual é coerente com o nome dos documentos pessoais anexos. Pequenas variações de acento, abreviação ou ordem de sobrenomes são toleradas e NÃO devem gerar alerta.\n` +
    `- Verifique se eventuais números identificadores (CPF, CNPJ, RG) registrados no cadastro coincidem com os dos documentos anexos.\n` +
    `- Se houver invocação de representação (menor, curatelado, guardião, procurador de pessoa jurídica etc.), verifique se há documento que comprove o vínculo (termo de guarda, curatela, contrato social, ata de eleição, certidão que comprove parentesco).\n` +
    `- Divergências relevantes entram no campo "divergenciasCadastrais" da saída, descritas de forma objetiva (ex.: "CPF do cadastro do sistema difere do CPF constante no documento de identificação anexo (id 12345)").\n` +
    `- Divergências cadastrais NÃO devem, por si só, contaminar o veredito global — elas são alerta para conferência humana, não rejeição automática.\n\n` +
    `## HEURÍSTICAS GERAIS DE AVALIAÇÃO\n\n` +
    `### Critérios com formas alternativas de prova\n` +
    `Quando um critério admite múltiplas formas alternativas de comprovação (ex.: "documento A OU documento B"), considere-o atendido se QUALQUER uma das formas estiver presente nos autos. Não exija mais de uma quando o critério prevê alternativas.\n\n` +
    `### Critérios inaplicáveis à causa concreta\n` +
    `Se um critério só se aplica a um tipo de situação que não é a dos autos (ex.: um critério específico de certidão de óbito em uma causa que não envolve falecimento; ou um critério específico de representação legal quando o autor é maior e capaz), marque-o como ATENDIDO (campo "atendido": true) com a justificativa "critério não aplicável a esta causa concreta". Isso mantém o veredito global limpo e impede pedidos de emenda sem propósito.\n\n` +
    `### Critérios aplicáveis com documentação suficiente\n` +
    `Marque como atendido e cite o id do documento que o comprova. Uma linha de justificativa basta.\n\n` +
    `### Critérios aplicáveis com documentação insuficiente\n` +
    `Marque como NÃO atendido e descreva objetivamente o que falta — sem rodeios, sem jargão, sem duplicar exigências já presentes em outros critérios do mesmo processo.\n` +
    `Para critérios não atendidos, preencha "providenciaSolicitada" com texto IMPERATIVO formal pronto para entrar como tópico do ato de emenda à inicial (ex.: "apresentar documento de identificação oficial do(a) autor(a) com foto"). Não use marcadores, cabeçalhos ou saudações — apenas a frase imperativa.\n` +
    `Quando um critério tiver vários sub-requisitos e apenas parte estiver faltando, especifique na "providenciaSolicitada" qual sub-requisito precisa ser suprido. Não peça "juntar a documentação" quando falta apenas um item específico dela.\n\n` +
    `### Veredito global ("veredito")\n` +
    `- "atendido" se TODOS os critérios da lista estiverem com "atendido": true (incluindo os marcados como atendidos por inaplicabilidade).\n` +
    `- "nao_atendido" se NENHUM critério da lista estiver atendido.\n` +
    `- "parcialmente" nos demais casos.\n\n` +
    `## ALERTAS ESPECIAIS\n\n` +
    `Use o campo "alertasEspeciais" para sinalizar — sem gerar providência de emenda — situações que merecem a atenção do servidor ou magistrado mas que fogem do binário atendido/não atendido da lista de critérios. O campo é uma lista de strings curtas e descritivas. Use SOMENTE se houver sinal claro no contexto; na dúvida, deixe vazio. Sugestões de texto (adapte conforme o caso concreto):\n` +
    `- "possível incompetência territorial ou material" — quando o contexto indicar que a causa pode não pertencer a esta unidade judiciária.\n` +
    `- "possível tramitação em segredo de justiça recomendada" — quando houver sinais de dados sensíveis (saúde, violência, menores, relações familiares, dados fiscais protegidos etc.) que justifiquem análise de sigilo. NÃO especifique a natureza do dado sensível no alerta — apenas sinalize.\n` +
    `- "valor da causa ausente ou incompatível com a competência da Vara" — quando houver sinais de incompatibilidade com o limite de alçada ou ausência de valor atribuído.\n` +
    `- "representação processual sem documento comprobatório" — quando alguém atua em nome de outrem sem a juntada do termo/certidão/instrumento que comprove o poder de representação.\n` +
    `- "prevenção ou conexão possível" — quando o contexto mencionar outro processo que pode gerar prevenção ou conexão.\n` +
    `Esses alertas NÃO afetam o veredito global. São metadados para o servidor.\n\n` +
    `=== CRITÉRIOS A VERIFICAR ===\n${criteriosFmt}\n\n` +
    `=== CONTEXTO DOS AUTOS ===\n` +
    '```\n' +
    caseContext.slice(0, ANALISE_CASE_CONTEXT_LIMIT) +
    '\n```\n\n' +
    `## FORMATO DE RESPOSTA\n\n` +
    `Responda SEMPRE em JSON puro, sem markdown, sem comentários, sem texto fora do JSON, no formato exato abaixo:\n` +
    `{\n` +
    `  "veredito": "atendido" | "parcialmente" | "nao_atendido",\n` +
    `  "panorama": "<1-2 frases curtas sobre o estado da inicial, sem nomes por extenso e sem números identificadores completos>",\n` +
    `  "criterios": [\n` +
    `    {\n` +
    `      "id": "<id exato de um critério listado acima>",\n` +
    `      "label": "<o mesmo label do critério>",\n` +
    `      "atendido": true | false,\n` +
    `      "justificativa": "<1-3 linhas, citando ids de documentos como (id 12345678) quando aplicável; datas no formato DD/MM/AAAA>",\n` +
    `      "providenciaSolicitada": "<frase imperativa; obrigatória quando atendido=false; ausente quando atendido=true>"\n` +
    `    }\n` +
    `  ],\n` +
    `  "pontosDeConferenciaHumana": [\n` +
    `    "<item objetivo que o servidor deve verificar no PDF original por limitação do OCR ou da análise automatizada>"\n` +
    `  ],\n` +
    `  "divergenciasCadastrais": [\n` +
    `    "<divergência entre cadastro do sistema e documentos anexos, se houver>"\n` +
    `  ],\n` +
    `  "alertasEspeciais": [\n` +
    `    "<string curta descrevendo a situação; ver seção ALERTAS ESPECIAIS>"\n` +
    `  ]\n` +
    `}\n\n` +
    `### Regras finais sobre a saída\n` +
    `- Use os "id" EXATAMENTE como aparecem na lista de critérios. Inclua TODOS os critérios da lista no array "criterios", na mesma ordem em que aparecem.\n` +
    `- Os campos "pontosDeConferenciaHumana", "divergenciasCadastrais" e "alertasEspeciais" devem ser arrays, possivelmente vazios ([]). Nunca null, nunca omitidos.\n` +
    `- O campo "providenciaSolicitada" deve estar AUSENTE do objeto quando atendido=true. Deve estar PRESENTE e não-vazio quando atendido=false.\n` +
    `- NÃO use aspas curvas/tipográficas (U+2018, U+2019, U+201C, U+201D). Use apenas aspas retas (") e apóstrofo reto ('), que são as únicas compatíveis com JSON.\n` +
    `- NÃO inclua nada além do JSON. Nem texto introdutório, nem explicação final, nem bloco markdown. A resposta é o JSON puro.`
  );
}

/**
 * Extrai o objeto `AnaliseProcessoResult` da resposta crua do LLM.
 * Tolera markdown ou texto antes/depois do JSON. Filtra entradas com id
 * desconhecido e normaliza tipos básicos. Retorna null se nada utilizável
 * puder ser extraído.
 */
export function parseAnaliseProcessoResponse(
  raw: string,
  criterios: readonly CriterioResolvido[]
): AnaliseProcessoResult | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const allowedIds = new Set(criterios.map((c) => c.id));
  const labelById = new Map(criterios.map((c) => [c.id, c.label]));

  const veredito = String(obj.veredito ?? '').trim();
  const vereditoOk =
    veredito === 'atendido' ||
    veredito === 'parcialmente' ||
    veredito === 'nao_atendido';

  const rawCriterios = Array.isArray(obj.criterios) ? obj.criterios : [];
  const criteriosOut = rawCriterios
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => {
      const id = typeof c.id === 'string' ? c.id.trim() : '';
      if (!allowedIds.has(id)) return null;
      const atendido = c.atendido === true;
      const label =
        (typeof c.label === 'string' && c.label.trim()) || labelById.get(id) || id;
      const justificativa =
        typeof c.justificativa === 'string' ? c.justificativa.trim() : '';
      const providencia =
        typeof c.providenciaSolicitada === 'string'
          ? c.providenciaSolicitada.trim()
          : '';
      return {
        id,
        label,
        atendido,
        justificativa,
        ...(atendido ? {} : { providenciaSolicitada: providencia })
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (criteriosOut.length === 0) return null;

  // Recalcula veredito a partir dos critérios para evitar inconsistência:
  // se o LLM disser "atendido" mas houver algum item com atendido=false,
  // a UI deve refletir o estado real.
  const algumNao = criteriosOut.some((c) => !c.atendido);
  const todosNao = criteriosOut.every((c) => !c.atendido);
  const vereditoFinal: AnaliseProcessoResult['veredito'] = todosNao
    ? 'nao_atendido'
    : algumNao
    ? 'parcialmente'
    : 'atendido';

  return {
    veredito: vereditoOk
      ? (algumNao && veredito === 'atendido' ? vereditoFinal : (veredito as AnaliseProcessoResult['veredito']))
      : vereditoFinal,
    panorama: typeof obj.panorama === 'string' ? obj.panorama.trim() : '',
    criterios: criteriosOut,
    pontosDeConferenciaHumana: toStringArray(obj.pontosDeConferenciaHumana),
    divergenciasCadastrais: toStringArray(obj.divergenciasCadastrais),
    alertasEspeciais: toStringArray(obj.alertasEspeciais)
  };
}

/**
 * Normaliza um valor bruto em array de strings não-vazias e trimadas.
 * Usado pelos três campos auxiliares da resposta de "Analisar o processo"
 * (`pontosDeConferenciaHumana`, `divergenciasCadastrais`, `alertasEspeciais`),
 * que o prompt exige como arrays, mas que podem vir ausentes ou malformados.
 */
function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────
//  EMENDA À INICIAL — gabarito fixo + injeção das providências
// ─────────────────────────────────────────────────────────────────────────

/**
 * Gabarito do ato de emenda à inicial aprovado pela JFCE. Os tópicos a
 * serem inseridos no marcador `[PREENCHER...]` vêm das providências
 * sugeridas pelo LLM em "Analisar o processo" — uma por critério não
 * atendido, em forma imperativa.
 */
export const EMENDA_INICIAL_GABARITO =
  `De ordem do(a) MM.(a) Juiz(a) Federal, e com amparo no art. 93, inc. XIV, ` +
  `da CF/88, c/c o art. 203, § 4º, do CPC/2015, fica a parte autora ` +
  `intimada para, no prazo constante no menu "Expedientes":\n\n` +
  `[PREENCHER COM A PROVIDÊNCIA A SER SOLICITADA PARA CORRIGIR OS CRITÉRIOS QUE NÃO FORAM ATENDIDOS EM TÓPICOS]\n\n` +
  `O não cumprimento total ou parcial das determinações acima ` +
  `estabelecidas ensejará o indeferimento liminar da petição inicial.\n\n` +
  `Em respeito ao princípio da celeridade, esclarece-se que eventual ` +
  `pedido de prorrogação do prazo somente será deferido excepcionalmente ` +
  `e desde que acompanhado de justificação objetiva e específica, ` +
  `comprovada documentalmente. Meros pedidos genéricos de prorrogação de ` +
  `prazo serão sumariamente indeferidos.\n\n` +
  `[município sede do juízo], datado eletronicamente.`;

/**
 * Monta o prompt de geração do ato de emenda à inicial. Diferente das
 * minutas regulares, o ato tem corpo fixo — a única coisa que o modelo
 * deve produzir é o bloco de tópicos imperativos que substitui o
 * marcador `[PREENCHER...]`. Para garantir consistência com as outras
 * minutas, o resultado segue as mesmas `MINUTA_FORMAT_RULES` (sem
 * markdown, parágrafos separados por linha em branco, etc.).
 *
 * `providencias` é a lista já consolidada pelo orquestrador a partir das
 * `AnaliseCriterio` cujo `atendido === false`.
 */
export function buildEmendaInicialPrompt(
  providencias: readonly string[]
): string {
  const providenciasFmt = providencias.length
    ? providencias.map((p) => `- ${p}`).join('\n')
    : '- (nenhuma providência específica identificada)';

  return (
    `Elabore o ato de emenda à inicial reproduzindo INTEGRALMENTE o gabarito abaixo, substituindo APENAS o marcador "[PREENCHER COM A PROVIDÊNCIA A SER SOLICITADA PARA CORRIGIR OS CRITÉRIOS QUE NÃO FORAM ATENDIDOS EM TÓPICOS]" pelas providências listadas mais adiante.\n\n` +
    `IMPORTANTE:\n` +
    `- Mantenha o restante do gabarito EXATAMENTE como está (mesma redação, mesma ordem dos parágrafos, mesma fórmula final).\n` +
    `- Substitua "[município sede do juízo]" pelo município da vara/seção judiciária responsável pelo processo, identificado a partir dos documentos dos autos (ex.: "Maracanaú/CE", "Fortaleza/CE"). NÃO mantenha o marcador entre colchetes na peça final.\n` +
    `- O bloco de providências deve ser apresentado em forma de tópicos numerados (1., 2., 3., ...), um tópico por providência, redigidos no IMPERATIVO formal e iniciados por verbo (ex.: "Apresentar...", "Juntar...", "Esclarecer..."). Cada tópico em um parágrafo separado, terminando em ponto-final.\n` +
    `- NÃO acrescente cabeçalho, número do processo, identificação das partes nem assinatura — esses elementos são preenchidos automaticamente pelo editor do PJe.\n\n` +
    `EXCEÇÃO DE FORMATO: as regras de formato gerais aplicáveis às demais minutas PROÍBEM marcadores de lista; aqui, os tópicos numerados (1., 2., ...) do bloco de providências são OBRIGATÓRIOS e a única exceção permitida. O restante do texto (cabeçalho, parágrafos do meio e fecho) segue as regras normais de prosa corrida sem marcadores.\n\n` +
    `=== GABARITO ===\n${EMENDA_INICIAL_GABARITO}\n=== FIM DO GABARITO ===\n\n` +
    `=== PROVIDÊNCIAS A INCLUIR (uma por tópico, na ordem dada) ===\n${providenciasFmt}\n=== FIM DAS PROVIDÊNCIAS ===\n\n` +
    `${MINUTA_FORMAT_RULES}`
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  ETIQUETAS INTELIGENTES — extração de MARCADORES semânticos do processo
// ─────────────────────────────────────────────────────────────────────────

/** Limite de contexto enviado ao LLM para extrair marcadores. */
const MARCADORES_CASE_CONTEXT_LIMIT = 16_000;

/**
 * Monta o prompt que pede à LLM uma lista curta de MARCADORES semânticos
 * sobre o processo — termos/frases curtos que descrevem o caso (matéria,
 * benefício, fase, providência central). Esses marcadores são depois
 * mapeados pelo BM25 para as etiquetas sugestionáveis que o usuário
 * selecionou no popup.
 *
 * O prompt NÃO conhece o catálogo de etiquetas — produz marcadores
 * livres em vocabulário natural do Judiciário, para o BM25 fazer o
 * casamento. Isso mantém o LLM desvinculado do catálogo (não precisa
 * re-enviar milhares de nomes) e o matcher explicável.
 *
 * `userHints` é o texto livre que o usuário escreveu na aba "Etiquetas
 * Inteligentes" do popup (`etiquetasPromptCriterios`). Quando presente,
 * orienta o foco dos marcadores. Vazio = comportamento padrão.
 */
export function buildEtiquetasMarkersPrompt(
  caseContext: string,
  userHints: string,
  criteriosBlock: string
): string {
  const hints = (userHints ?? '').trim();
  const hintsBlock = hints
    ? `\n## ORIENTAÇÕES DO USUÁRIO (prioridade na escolha dos marcadores)\n${hints}\n`
    : '';
  const critBlock = (criteriosBlock ?? '').trim() ? `\n${criteriosBlock}\n` : '';

  return (
    `Você é um assistente que LÊ o processo e produz uma lista curta de MARCADORES semânticos descrevendo-o — termos ou frases curtas (2 a 6 palavras cada) que resumem a natureza da causa, o benefício pleiteado, a fase processual, as providências pendentes e outros aspectos relevantes para CLASSIFICAÇÃO do processo.\n\n` +
    `Os marcadores serão depois casados automaticamente com um catálogo de etiquetas do PJe — NÃO tente adivinhar os nomes exatos das etiquetas. Sua saída é a descrição DO CASO em vocabulário jurídico natural; o casamento fica com um algoritmo determinístico posterior.\n\n` +
    `## PRINCÍPIOS\n` +
    `- Produza entre 5 e 15 marcadores. Nem menos (perde recall), nem mais (gera ruído).\n` +
    `- Cada marcador deve ser CURTO (2 a 6 palavras), em minúsculas, sem artigo/preposição inicial, sem pontuação final. Ex.: "aposentadoria por idade rural", "revisão da vida toda", "indeferimento de tutela de urgência".\n` +
    `- Vocabulário em PT-BR forense; evite abreviações idiossincráticas.\n` +
    `- Use somente o que estiver FUNDAMENTADO no contexto dos autos abaixo. Não invente fatos.\n` +
    `- Não inclua dados pessoais (nomes, CPFs, números de benefício) — marcadores descrevem a natureza do caso, não identificam partes.\n` +
    `- Quando a fase processual for clara, inclua UM marcador sobre a fase (ex.: "fase postulatória", "cumprimento de sentença", "fase recursal").\n` +
    `- Quando houver providência central pendente, inclua UM marcador sobre ela (ex.: "decisão sobre tutela", "despacho de saneamento", "sentença de mérito").\n` +
    hintsBlock +
    critBlock +
    `\n## CONTEXTO DOS AUTOS\n` +
    '```\n' +
    caseContext.slice(0, MARCADORES_CASE_CONTEXT_LIMIT) +
    '\n```\n\n' +
    `## FORMATO DE RESPOSTA\n` +
    `Responda SEMPRE em JSON puro, sem markdown, sem comentários, no formato exato:\n` +
    `{"marcadores": ["marcador 1", "marcador 2", "..."]}\n\n` +
    `NÃO inclua nada além do JSON.`
  );
}

/**
 * Extrai o array de marcadores da resposta bruta do LLM. Tolera markdown
 * ou texto em volta. Normaliza cada marcador (lowercase, trim, colapsa
 * espaços). Descarta entradas vazias, duplicadas ou longas demais.
 */
export function parseEtiquetasMarkersResponse(raw: string): string[] {
  if (!raw) return [];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = (obj as { marcadores?: unknown })?.marcadores;
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const norm = item.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!norm || norm.length > 80) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.slice(0, 20); // cap de segurança
}
