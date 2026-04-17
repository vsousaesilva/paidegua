/**
 * Orquestrador da ação "Analisar o processo" (perfil Secretaria).
 *
 * Fluxo:
 *
 *   1. Recebe o contexto textual dos autos já consolidado pelo content
 *      (linha do tempo + documentos recentes) e a lista de critérios
 *      resolvidos (NT 1/2025 + livres do magistrado).
 *   2. Dispara a chamada ao background, que constrói o prompt e consulta
 *      a LLM ativa. A resposta volta já parseada como
 *      `AnaliseProcessoResult`.
 *   3. Devolve um envelope `{ok, result?, error?}` para o chamador
 *      renderizar a bolha de resultado no chat.
 *
 * A extração dos documentos (caso não estejam em cache) é responsabilidade
 * do chamador em `content.ts`, que já tem toda a UI de progresso e o
 * pipeline de OCR auto-run. Aqui lidamos apenas com a parte "analisar".
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import type { CriterioResolvido } from '../../shared/prompts';
import type { AnaliseProcessoResult } from '../../shared/types';

export interface AnalisarProcessoResult {
  ok: boolean;
  result?: AnaliseProcessoResult;
  error?: string;
}

export interface AnalisarProcessoOptions {
  /** Trecho consolidado dos autos (já pronto, truncado pelo chamador). */
  caseContext: string;
  /** Lista de critérios efetivamente adotados pelo magistrado. */
  criterios: readonly CriterioResolvido[];
}

export async function executarAnalisarProcesso(
  options: AnalisarProcessoOptions
): Promise<AnalisarProcessoResult> {
  const caseContext = (options.caseContext ?? '').trim();
  if (!caseContext) {
    return {
      ok: false,
      error: 'Sem conteúdo textual dos documentos — carregue e extraia os autos antes.'
    };
  }
  if (!options.criterios || options.criterios.length === 0) {
    return {
      ok: false,
      error:
        'Nenhum critério de análise configurado. Acesse a aba "Triagem Inteligente" do popup ' +
        'para adotar critérios da NT 1/2025 ou cadastrar critérios próprios.'
    };
  }

  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.ANALISAR_PROCESSO,
      payload: {
        caseContext,
        criterios: options.criterios
      }
    })) as {
      ok: boolean;
      result?: AnaliseProcessoResult;
      error?: string;
    };

    if (!response?.ok || !response.result) {
      return {
        ok: false,
        error: response?.error ?? 'Falha ao analisar o processo.'
      };
    }
    return { ok: true, result: response.result };
  } catch (err) {
    console.warn(`${LOG_PREFIX} executarAnalisarProcesso falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
