/**
 * Interface base para adaptadores de versões do PJe.
 *
 * Cada versão (legacy/JSF vs. PJe2/Angular) implementa um adapter concreto
 * que sabe como inspecionar o DOM específico daquela versão para:
 *  - Confirmar que a página atual é uma tela de processo (autos digitais)
 *  - Extrair o número único do processo
 *  - (Fase 3) Extrair a lista de documentos processuais
 *
 * Os adapters são descobertos por detector.ts e usados pelo content script.
 */

import type { ProcessoDocumento } from '../../shared/types';

export interface BaseAdapter {
  /** Versão do PJe que este adapter cobre. */
  readonly version: 'legacy' | 'pje2';

  /**
   * Retorna true se o adapter reconhece o ambiente atual como compatível
   * com sua versão do PJe (checagem rápida de marcadores no DOM/window).
   */
  matches(): boolean;

  /**
   * Retorna true se a página atual é uma tela de autos digitais
   * (não é login, não é painel, não é consulta pública vazia).
   */
  isProcessoPage(): boolean;

  /**
   * Extrai o número único do processo da página atual (formato CNJ).
   * Retorna null se não conseguir identificar com segurança.
   */
  extractNumeroProcesso(): string | null;

  /**
   * Extrai a lista de documentos dos autos digitais.
   * Stub na Fase 2; implementação completa na Fase 3.
   */
  extractDocumentos(): ProcessoDocumento[];
}
