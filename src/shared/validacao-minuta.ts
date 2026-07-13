/**
 * Gerador da minuta de sentença da "Validação de cadastro".
 *
 * Monta a peça de extinção sem resolução de mérito (art. 485 do CPC) a
 * partir do modelo institucional, preenchendo a seção
 * "[HIPÓTESES VERIFICADAS]" com as irregularidades detectadas no processo.
 *
 * Puro e sem dependências de DOM/rede: recebe as irregularidades e devolve
 * `{ html, plain }` — `html` para inserir no editor do PJe (Badon/CKEditor)
 * e `plain` para cópia à área de transferência / fallback.
 *
 * O lançamento do movimento 459 e o encaminhamento à tarefa "minutar
 * sentença" são da Fase 4 (automação do postback JSF) — aqui só se produz e
 * insere o texto.
 */

import type {
  IrregularidadeCadastro,
  IrregularidadeId
} from './validacao-cadastro-regras';

/**
 * Frase da hipótese, por código de irregularidade, como deve aparecer na
 * lista de "irregularidades estruturais no cadastro processual" da sentença.
 * Redação genérica e impessoal (sem nomes de partes), alinhada às hipóteses
 * da NT/proposta.
 */
const HIPOTESE_POR_ID: Record<IrregularidadeId, string> = {
  'cpf-autor-ausente': 'ausência do CPF da parte autora;',
  'advogado-ausente':
    'ausência de advogado regularmente vinculado a todos os autores ou aos ' +
    'respectivos representantes legais;',
  'representante-menor-ausente':
    'ausência de cadastro de representante legal do autor menor;',
  'representante-nao-autor':
    'cadastro incorreto de representante legal — representante vinculado a ' +
    'parte que não figura no polo ativo;',
  'mpf-ausente':
    'ausência de cadastro do Ministério Público Federal como fiscal da lei, ' +
    'quando exigível (autor menor);',
  'inss-cnpj-incorreto':
    'cadastro incorreto do INSS — CNPJ diverso do correto ' +
    '(29.979.036/0001-40);',
  'inss-terceiro-interessado':
    'cadastro incorreto do INSS como terceiro interessado, quando deveria ' +
    'figurar no polo passivo;',
  'ceab-ausente':
    'ausência de cadastro da CEAB-DJ INSS (CNPJ 29.979.036/0014-65) como ' +
    'órgão de cumprimento em Outros interessados;',
  'ceab-cadastro-incorreto':
    'cadastro incorreto da CEAB no polo processual — erro no CNPJ, ausência ' +
    'de procuradoria vinculada ou localização indevida fora de Outros ' +
    'interessados;',
  'polo-passivo-vazio':
    'ausência de cadastro de réu no polo passivo;',
  'orgao-sem-procuradoria':
    'ausência de procuradoria vinculada a parte cadastrada como órgão ' +
    'público;',
  'valor-causa-ausente': 'protocolo sem cadastro do valor da causa;'
};

/** Parágrafos de abertura ANTES da citação do art. 1º. */
const PARAGRAFOS_ANTES_CITACAO: string[] = [
  'Dispensado o relatório, conforme autorização do art. 38 da Lei nº 9.099/1995, cuja incidência foi recepcionada pelo art. 1º da Lei nº 10.259/2001.',
  'Trata-se de petição inicial protocolada no sistema Processo Judicial Eletrônico – PJe 2.x, na qual se verificam inconsistências relevantes no cadastramento eletrônico do feito, incompatíveis com o conteúdo efetivo da peça inaugural e com as normas que regem a correta utilização do sistema judicial digital.',
  'A correta utilização do Sistema PJe 2.x constitui dever processual das partes e de seus procuradores, sendo condição indispensável para a regular formação da relação processual.',
  'Nos termos do art. 10 da Lei nº 11.419/2006, o protocolo e a distribuição da petição inicial podem ser realizados diretamente pelos advogados, com autuação automática, sem intervenção da secretaria judicial, sendo-lhes atribuída a responsabilidade pelo correto cadastramento da demanda.',
  'No mesmo sentido, a Resolução nº 10/2016 do TRF da 5ª Região reafirma essa lógica ao estabelecer que compete ao próprio usuário do sistema o adequado preenchimento das informações processuais no momento do cadastramento. Dispõe o art. 1º que incumbe ao usuário, por ocasião do registro do feito, preencher corretamente os campos relativos às características do processo, em conformidade com o requerimento formulado, inclusive quanto ao assunto da demanda e ao CPF do advogado constituído:'
];

/**
 * Citação da Resolução nº 10/2016 do TRF5. Deve aparecer RECUADA (bloco de
 * citação) na peça — ver `montarMinutaValidacao`, que a emite prefixada por
 * `> ` para o `renderForPJe` produzir `bd-def-citacao` no editor do PJe.
 */
const CITACAO_ART1 =
  'Art. 1º Incumbe ao usuário, por ocasião do cadastramento do feito, preencher adequadamente os campos referentes às características do processo, em conformidade com o seu requerimento, aí incluídos o assunto objeto da demanda e o CPF do advogado constituído.';

/** Parágrafos de abertura APÓS a citação, até a chamada da lista. */
const PARAGRAFOS_APOS_CITACAO: string[] = [
  'Observa-se, portanto, que ambas as normas seguem o mesmo raciocínio: ao permitir que o protocolo e a autuação ocorram de forma direta e automatizada, transferem ao advogado a responsabilidade integral pela correta inserção dos dados processuais, afastando qualquer atribuição prévia da secretaria quanto à conferência ou retificação dessas informações.',
  'No caso concreto, verificam-se as seguintes irregularidades estruturais no cadastro processual:'
];

/** Itens fixos da lista "Tais inconsistências comprometem:". */
const COMPROMETEM: string[] = [
  'a correta autuação do feito;',
  'a regular distribuição;',
  'a tramitação automatizada do sistema PJe 2.x;',
  'a formação válida da relação processual.'
];

/** Parágrafos fixos de fechamento, do "Com isso..." ao "Arquivem-se.". */
const PARAGRAFOS_FECHO: string[] = [
  'As falhas apontadas não dizem respeito ao conteúdo jurídico da petição inicial, mas ao ato técnico de protocolo eletrônico.',
  'Com isso, a extinção do processo se constitui medida juridicamente adequada quando constatada irregularidade estrutural no protocolo eletrônico apta a impedir o regular processamento do feito, conforme anteriormente demonstrado.',
  'De outro lado, os arts. 4º e 6º do CPC asseguram às partes o direito à solução integral do mérito em prazo razoável e impõem a todos os sujeitos do processo o dever de cooperação, de modo a garantir tramitação regular, eficiente e adequada. A manutenção de processo com vício estrutural de cadastramento compromete a racionalidade do fluxo processual e contraria tais princípios.',
  'Por sua vez, o art. 139, I, do CPC confere ao magistrado o poder-dever de dirigir o processo conforme as disposições legais, velando pela regularidade da marcha processual. Assim, ao extinguir o processo diante de vício originário no protocolo eletrônico, o Juízo atua no exercício legítimo de sua função de controle da regularidade formal do feito.',
  'A intervenção judicial para corrigir ou reclassificar o cadastro implicaria substituição indevida da atividade técnica do advogado e comprometeria as rotinas automatizadas do sistema.',
  'Mostra-se, portanto, adequada a extinção do feito, facultando-se à parte autora novo protocolo regular.',
  'Diante do exposto, julgo extinto sem resolução do mérito, nos moldes do art. 485 do CPC.',
  'Após as anotações pertinentes no sistema, proceda-se ao arquivamento.',
  'A presente decisão é irrecorrível, por não se tratar de sentença nos termos do art. 203, §1º, do CPC, nem se enquadrar nas hipóteses recursais previstas no art. 5º da Lei nº 10.259/2001.',
  'Intimem-se.',
  'Arquivem-se.'
];

export interface MinutaValidacao {
  /**
   * Fonte da minuta em markdown-lite para `renderForPJe` (content/ui/markdown):
   * parágrafos separados por linha em branco, citação prefixada por `> `
   * (vira `bd-def-citacao` recuado no editor Badon do PJe). O chamador passa
   * isto por `renderForPJe` para obter o HTML final e por `stripMarkdown`
   * quando precisar do texto limpo.
   */
  markdown: string;
  /**
   * Texto plano legível (para prévia e cópia). A citação do art. 1º é
   * recuada com tabulação, preservando visualmente o recuo ao copiar.
   */
  plain: string;
  /** Hipóteses (frases) efetivamente listadas, na ordem de apresentação. */
  hipoteses: string[];
}

/**
 * Deriva as frases das hipóteses a partir das irregularidades, deduplicando
 * por código e preservando a ordem de detecção.
 */
function hipotesesDeIrregularidades(irrs: IrregularidadeCadastro[]): string[] {
  const vistos = new Set<IrregularidadeId>();
  const out: string[] = [];
  for (const irr of irrs) {
    if (vistos.has(irr.id)) continue;
    vistos.add(irr.id);
    const frase = HIPOTESE_POR_ID[irr.id];
    if (frase) out.push(frase);
  }
  return out;
}

/**
 * Monta a minuta de sentença de extinção para um processo com irregularidades
 * de cadastro. Devolve o `markdown` (para `renderForPJe` gerar o HTML do
 * editor do PJe, com a citação recuada) e o `plain` (prévia/cópia).
 *
 * Bullets usam o caractere `•` (não o marcador markdown `-`), porque o
 * `renderForPJe` remove marcadores de lista — com `•` literal o item vira um
 * parágrafo recuado normal do Badon, mantendo o ponto visível.
 */
export function montarMinutaValidacao(
  irregularidades: IrregularidadeCadastro[]
): MinutaValidacao {
  const hipoteses = hipotesesDeIrregularidades(irregularidades);

  // ----- Markdown (fonte para renderForPJe) -----
  const md: string[] = [];
  md.push(...PARAGRAFOS_ANTES_CITACAO);
  md.push(`> ${CITACAO_ART1}`); // recuo lateral (bd-def-citacao)
  md.push(...PARAGRAFOS_APOS_CITACAO);
  md.push(...hipoteses.map((h) => `• ${h}`));
  md.push('Tais inconsistências comprometem:');
  md.push(...COMPROMETEM.map((c) => `• ${c}`));
  md.push(...PARAGRAFOS_FECHO);
  const markdown = md.join('\n\n');

  // ----- Texto plano (prévia / cópia) -----
  const txt: string[] = [];
  txt.push(...PARAGRAFOS_ANTES_CITACAO);
  txt.push(`\t${CITACAO_ART1}`); // recuo por tabulação na cópia
  txt.push(...PARAGRAFOS_APOS_CITACAO);
  txt.push(...hipoteses.map((h) => `• ${h}`));
  txt.push('Tais inconsistências comprometem:');
  txt.push(...COMPROMETEM.map((c) => `• ${c}`));
  txt.push(...PARAGRAFOS_FECHO);
  const plain = txt.join('\n\n');

  return { markdown, plain, hipoteses };
}
