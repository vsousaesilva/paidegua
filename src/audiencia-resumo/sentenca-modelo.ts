/**
 * Pipeline de "Sentença com modelo" para a aba `audiencia-resumo`.
 *
 * Reusa a infraestrutura do paidegua de minutas com modelo:
 *   1. Verifica se o usuário cadastrou modelos (`templatesHasConfig`).
 *   2. Extrai termos do contexto (texto dos documentos do processo).
 *   3. `templatesSearch` (BM25) → top 8 candidatos.
 *   4. `templatesRerank` (LLM) → reordena os candidatos.
 *   5. Pega o top-1 e monta o prompt final via `buildMinutaPrompt`.
 *   6. Devolve `{prompt, modeloUsado}` para o caller (resumo-modal.ts)
 *      abrir a porta CHAT_STREAM e fazer o streaming na UI.
 *
 * Diferente do fluxo da sidebar (que usa `getExtraidosArray` + chat
 * bubbles), este pipeline é puramente funcional: recebe os documentos
 * já coletados pela aba e devolve apenas o prompt pronto.
 */

import {
  buildMinutaPrompt,
  TEMPLATE_ACTIONS_1G,
  type TemplateAction
} from '../shared/prompts';
import {
  templatesHasConfig,
  templatesRerank,
  templatesSearch
} from '../shared/templates-client';
import type { ProcessoDocumento } from '../shared/types';
import type { DadosLinha, SentencaJulgamento } from './resumo-prompt';

/**
 * Action local para "Extinto sem mérito". Não existe no
 * `TEMPLATE_ACTIONS_1G` global — é específica deste fluxo. Os
 * `folderHints` priorizam pastas com nomes ligados a extinção; o LLM
 * ajusta no rerank se o magistrado cadastrar modelos diferentes.
 */
const ACTION_EXTINTO: TemplateAction = {
  id: 'sentenca-extinto',
  label: 'Extinguir sem mérito',
  description:
    'Sentença extintiva do processo sem resolução do mérito (art. 485 do CPC).',
  folderHints: ['extincao', 'extinto', 'sem-merito', 'art-485', 'sentenca-extinta'],
  queryHints:
    'extinção sem mérito art 485 CPC ausência pressuposto ilegitimidade perda objeto abandono carência',
  natureza: 'sentenca',
  excludeTerms: ['despacho', 'decisao interlocutoria', 'procedente', 'improcedente']
};

function actionParaJulgamento(julgamento: SentencaJulgamento): TemplateAction {
  if (julgamento === 'Procedente') {
    return TEMPLATE_ACTIONS_1G.find((a) => a.id === 'sentenca-procedente')!;
  }
  if (julgamento === 'Improcedente') {
    return TEMPLATE_ACTIONS_1G.find((a) => a.id === 'sentenca-improcedente')!;
  }
  return ACTION_EXTINTO;
}

export interface ModeloUsado {
  relativePath: string;
  similarity: number;
  rerankJustificativa?: string;
}

export interface PrepararPromptComModeloOk {
  ok: true;
  prompt: string;
  modeloUsado: ModeloUsado | null;
  /** Quantos candidatos vieram do BM25 antes do rerank. */
  candidatosTotais: number;
}
export interface PrepararPromptComModeloErr {
  ok: false;
  /** Quando true, indica que o usuário não cadastrou modelos — UI pode oferecer fallback "gerar sem modelo". */
  semConfig?: boolean;
  /** Quando true, há config mas a busca não retornou hits para a ação. */
  semHits?: boolean;
  error: string;
}
export type PrepararPromptComModeloResult =
  | PrepararPromptComModeloOk
  | PrepararPromptComModeloErr;

export interface PrepararPromptComModeloInput {
  julgamento: SentencaJulgamento;
  /** Texto livre do magistrado (mesmo campo de "Gerar com orientação"). */
  orientacoes?: string;
  /** Documentos do processo (já com `textoExtraido`). */
  documentos: ProcessoDocumento[];
  /** Linha da pauta — usada como contexto adicional para query/rerank. */
  linha: DadosLinha;
}

/**
 * Pipeline completo: verifica config → busca → rerank → monta prompt.
 * Devolve `prompt` pronto para enviar via `ChatStartPayload.messages`,
 * com `modeloUsado` para a UI exibir qual modelo foi escolhido.
 */
export async function prepararPromptComModelo(
  input: PrepararPromptComModeloInput
): Promise<PrepararPromptComModeloResult> {
  // 1. Há modelos cadastrados?
  const hasCfg = await templatesHasConfig();
  if (!hasCfg) {
    return {
      ok: false,
      semConfig: true,
      error:
        'Você ainda não cadastrou uma pasta de modelos no popup do paidegua. ' +
        'Configure em Modelos antes de usar "Sentença com modelo", ou use ' +
        '"Sentença oral" (sem modelo) por enquanto.'
    };
  }

  // 2. Action e contexto.
  const action = actionParaJulgamento(input.julgamento);
  const contextoTexto = montarContextoBuscaERerank(input);

  // 3. Busca BM25.
  const queryEnriquecida = `${action.queryHints} ${contextoTexto.slice(0, 4_000)}`;
  const hits = await templatesSearch(
    queryEnriquecida,
    [...action.folderHints],
    action.excludeTerms ? [...action.excludeTerms] : undefined
  );
  if (hits.length === 0) {
    return {
      ok: false,
      semHits: true,
      error:
        `Nenhum modelo compatível encontrado para "${action.label}". ` +
        'Cadastre um modelo dessa natureza na pasta de modelos ou use ' +
        '"Sentença oral" (sem modelo).'
    };
  }

  // 4. Rerank LLM (best effort — se falhar, mantém ordem do BM25).
  let ordered = hits;
  let justificativa = '';
  const rerank = await templatesRerank(action.label, contextoTexto, hits);
  if (rerank) {
    ordered = rerank.ordered;
    justificativa = rerank.justificativa;
  }

  const top = ordered[0];
  const tplForPrompt = top
    ? { relativePath: top.relativePath, text: top.text }
    : null;

  // 5. Prompt final via helper compartilhado (mesma função usada na sidebar).
  const prompt = buildMinutaPrompt(action, tplForPrompt, input.orientacoes);

  return {
    ok: true,
    prompt,
    modeloUsado: top
      ? {
          relativePath: top.relativePath,
          similarity: top.similarity ?? 0,
          rerankJustificativa: justificativa || undefined
        }
      : null,
    candidatosTotais: hits.length
  };
}

/**
 * Monta o "contexto do caso" para alimentar a query enriquecida do
 * BM25 e o rerank do LLM. Concatena dados estruturados da linha
 * (classe, partes, tipo de audiência) + amostra do texto dos
 * documentos. Mantemos curto (~5-10k chars) para não estourar o
 * limite do rerank.
 */
function montarContextoBuscaERerank(input: PrepararPromptComModeloInput): string {
  const cabecalho = [
    `Classe: ${input.linha.classe}`,
    `Polo ativo: ${input.linha.autor}`,
    `Polo passivo: ${input.linha.reu}`,
    `Tipo de audiência: ${input.linha.tipoAudiencia}`,
    `Órgão julgador: ${input.linha.orgaoJulgador}`
  ].join('\n');

  // Amostra dos primeiros docs (petição inicial, contestação) — onde
  // costumam estar os termos definidores da matéria. Limita ~4k chars
  // para o conjunto.
  const amostraDocs = input.documentos
    .slice(0, 4)
    .map((d) => {
      const head = `[${d.tipo}] ${d.descricao}`;
      const corpo = (d.textoExtraido ?? '').slice(0, 1_000);
      return `${head}\n${corpo}`;
    })
    .join('\n\n');

  return `${cabecalho}\n\n${amostraDocs}`;
}
