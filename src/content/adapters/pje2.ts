/**
 * Adapter para PJe2 (frontend Angular).
 *
 * Stub inicial: a maioria dos tribunais ainda usa PJe legacy, então este
 * adapter fica como placeholder com detecção mínima e será expandido
 * conforme encontrarmos instâncias PJe2 em produção. TRF5 na data da
 * Fase 2 ainda é legacy.
 */

import { NUMERO_PROCESSO_REGEX } from '../../shared/constants';
import type { ProcessoDocumento } from '../../shared/types';
import type { BaseAdapter } from './base-adapter';

export class PJe2Adapter implements BaseAdapter {
  readonly version = 'pje2' as const;

  matches(): boolean {
    // Marcadores do Angular/PJe2. Nenhum deles sozinho é garantia absoluta,
    // por isso o detector principal dá preferência ao legacy quando ambos
    // batem (o legacy é maioria esmagadora na base instalada).
    const hasNgApp = Boolean(document.querySelector('[ng-app], [ng-version]'));
    const hasAngularRoot = Boolean(document.querySelector('app-root'));
    const hasPje2Marker = Boolean(document.querySelector('[class*="pje2"], [id*="pje2"]'));

    return hasNgApp || hasAngularRoot || hasPje2Marker;
  }

  isProcessoPage(): boolean {
    const path = window.location.pathname.toLowerCase();
    return path.includes('/processo/') || path.includes('/autos/');
  }

  extractNumeroProcesso(): string | null {
    const fromTitle = document.title.match(NUMERO_PROCESSO_REGEX);
    if (fromTitle) {
      return fromTitle[0];
    }
    const bodyText = (document.body?.innerText ?? '').slice(0, 20000);
    const match = bodyText.match(NUMERO_PROCESSO_REGEX);
    return match ? match[0] : null;
  }

  extractDocumentos(): ProcessoDocumento[] {
    // Implementação completa na Fase 3.
    return [];
  }
}
