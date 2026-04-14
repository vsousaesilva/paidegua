/**
 * Detector de ambiente PJe.
 *
 * Observa URL, hostname e DOM para produzir um `PJeDetection` informando
 * se estamos em uma instância do PJe, qual versão, tribunal, grau, e se
 * a página atual é uma tela de autos digitais com número de processo
 * identificável.
 *
 * Modo de operação: RESTRITIVO — o FAB só será exibido quando
 * `isProcessoPage` for true E `numeroProcesso` for extraído com sucesso
 * (decisão confirmada na Fase 2).
 */

import { PJE_HOST_PATTERNS } from '../shared/constants';
import type { PJeDetection } from '../shared/types';
import type { BaseAdapter } from './adapters/base-adapter';
import { PJeLegacyAdapter } from './adapters/pje-legacy';
import { PJe2Adapter } from './adapters/pje2';

/**
 * Tabela de hosts conhecidos que queremos tratar de forma especial.
 * Serve principalmente para distinguir 1º e 2º grau no TRF5 e garantir
 * um nome amigável de tribunal mesmo quando o regex genérico falhar.
 */
/**
 * Tabela de hosts conhecidos do TRF5. Atenção à convenção institucional:
 *   - pje1g  → 1º grau (varas federais)
 *   - pje2g  → Turma Recursal dos Juizados Especiais Federais (NÃO é o TRF)
 *   - pjett  → Tribunal Regional Federal (2º grau ordinário)
 */
const KNOWN_HOSTS: Record<string, { tribunal: string; grau: PJeDetection['grau'] }> = {
  'pje1g.trf5.jus.br': { tribunal: 'TRF5',   grau: '1g' },
  'pje2g.trf5.jus.br': { tribunal: 'TRF5',   grau: 'turma_recursal' },
  'pjett.trf5.jus.br': { tribunal: 'TRF5',   grau: '2g' }
};

export function isPJeHost(hostname: string): boolean {
  return PJE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

/**
 * Descobre tribunal e grau a partir do hostname.
 * Primeiro consulta a tabela de hosts conhecidos; depois aplica um regex
 * genérico para capturar padrões como `pje1g.trf<N>.jus.br`, `pje.tj<UF>.jus.br`,
 * `pje<N>g.trt<N>.jus.br`, etc.
 */
function identifyTribunal(hostname: string): { tribunal: string; grau: PJeDetection['grau'] } {
  const known = KNOWN_HOSTS[hostname.toLowerCase()];
  if (known) {
    return known;
  }

  // Padrão genérico com grau embutido: pje1g.trf5.jus.br, pje2g.trt7.jus.br, etc.
  const comGrau = hostname.match(
    /^pje(\d)g\.((?:trf|trt|tj[a-z]{2}|tse|stj|stf)[a-z0-9]*)\.jus\.br$/i
  );
  if (comGrau) {
    const grauDigit = comGrau[1];
    const tribunal = comGrau[2];
    if (grauDigit && tribunal) {
      const grau = (grauDigit === '1' || grauDigit === '2'
        ? (`${grauDigit}g` as '1g' | '2g')
        : 'unknown') as PJeDetection['grau'];
      return { tribunal: tribunal.toUpperCase(), grau };
    }
  }

  // pjett.trf<N>.jus.br → Tribunal Regional Federal (2º grau ordinário).
  const trfPjett = hostname.match(
    /^pjett\.((?:trf)[a-z0-9]*)\.jus\.br$/i
  );
  if (trfPjett && trfPjett[1]) {
    return { tribunal: trfPjett[1].toUpperCase(), grau: '2g' };
  }

  // Padrão sem grau: pje.trf5.jus.br, pje.tjsp.jus.br, etc.
  const semGrau = hostname.match(
    /^pje\.((?:trf|trt|tj[a-z]{2}|tse|stj|stf)[a-z0-9]*)\.jus\.br$/i
  );
  if (semGrau && semGrau[1]) {
    return { tribunal: semGrau[1].toUpperCase(), grau: 'unknown' };
  }

  return { tribunal: 'DESCONHECIDO', grau: 'unknown' };
}

/**
 * Seleciona o adapter mais apropriado para o DOM atual.
 * Prioridade: legacy primeiro (base instalada dominante), depois pje2.
 * Retorna null se nenhum reconhecer o ambiente.
 */
export function selectAdapter(): BaseAdapter | null {
  const legacy = new PJeLegacyAdapter();
  if (legacy.matches()) {
    return legacy;
  }
  const pje2 = new PJe2Adapter();
  if (pje2.matches()) {
    return pje2;
  }
  return null;
}

/**
 * Executa a detecção completa. Chamada uma vez no bootstrap do content
 * script e sempre que o DOM mudar significativamente (SPAs e updates
 * AJAX do PJe legacy via PrimeFaces).
 */
export function detect(): { detection: PJeDetection; adapter: BaseAdapter | null } {
  const { hostname, protocol, host } = window.location;

  const baseDetection: PJeDetection = {
    isPJe: false,
    version: 'unknown',
    tribunal: 'DESCONHECIDO',
    grau: 'unknown',
    isProcessoPage: false,
    numeroProcesso: null,
    baseUrl: `${protocol}//${host}`
  };

  if (!isPJeHost(hostname)) {
    return { detection: baseDetection, adapter: null };
  }

  const { tribunal, grau } = identifyTribunal(hostname);
  const adapter = selectAdapter();

  const detection: PJeDetection = {
    ...baseDetection,
    isPJe: true,
    tribunal,
    grau,
    version: adapter?.version ?? 'unknown',
    isProcessoPage: adapter ? adapter.isProcessoPage() : false,
    numeroProcesso: adapter ? adapter.extractNumeroProcesso() : null
  };

  return { detection, adapter };
}
