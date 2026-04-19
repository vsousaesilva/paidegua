/**
 * Orquestrador da ação "Inserir etiquetas mágicas" (perfil Secretaria →
 * Triagem Inteligente).
 *
 * Fluxo:
 *
 *   1. Recebe o trecho consolidado dos autos e envia ao background, que
 *      pede à LLM uma lista curta de MARCADORES semânticos e em seguida
 *      roda o BM25 contra as etiquetas sugestionáveis selecionadas pelo
 *      usuário na aba "Etiquetas Inteligentes" do popup.
 *   2. Devolve `{ok, markers?, matches?, error?}` para o chamador (content)
 *      renderizar a bolha de sugestões.
 *
 * Este módulo NÃO conhece o catálogo de etiquetas nem executa BM25 — tudo
 * mora no background (same-origin com o IndexedDB do catálogo e o único
 * contexto autorizado a chamar a LLM).
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import type {
  EtiquetaSugerida,
  SugerirEtiquetasResponse
} from '../../shared/types';

export interface SugerirEtiquetasOrchResult {
  ok: boolean;
  markers?: string[];
  matches?: EtiquetaSugerida[];
  error?: string;
}

export interface SugerirEtiquetasOptions {
  /** Trecho consolidado dos autos (já pronto, truncado pelo chamador). */
  caseContext: string;
}

export async function executarSugerirEtiquetas(
  options: SugerirEtiquetasOptions
): Promise<SugerirEtiquetasOrchResult> {
  const caseContext = (options.caseContext ?? '').trim();
  if (!caseContext) {
    return {
      ok: false,
      error:
        'Sem conteúdo textual dos documentos — carregue e extraia os autos antes.'
    };
  }

  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.ETIQUETAS_SUGERIR,
      payload: { caseContext }
    })) as SugerirEtiquetasResponse;

    if (!response?.ok) {
      return {
        ok: false,
        error: response?.error ?? 'Falha ao sugerir etiquetas.'
      };
    }
    return {
      ok: true,
      markers: response.markers ?? [],
      matches: response.matches ?? []
    };
  } catch (err) {
    console.warn(`${LOG_PREFIX} executarSugerirEtiquetas falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
