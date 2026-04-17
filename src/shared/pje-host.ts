/**
 * Utilitário compartilhado para inferir o grau do PJe a partir do hostname.
 *
 * A lógica aqui é a mesma aplicada no detector do content script, mas fica
 * isolada em `shared/` para também ser consumida pelo popup, que precisa
 * decidir a visibilidade do perfil "Secretaria" antes de qualquer conexão
 * com o content.
 *
 * Convenção institucional (TRF5):
 *   - pje1g.trf5.jus.br  → 1º grau (varas federais)
 *   - pje2g.trf5.jus.br  → Turma Recursal dos Juizados Especiais Federais
 *   - pjett.trf5.jus.br  → Tribunal Regional Federal (2º grau ordinário)
 */

export type PJeGrau = '1g' | '2g' | 'turma_recursal' | 'unknown';

const KNOWN_HOSTS: Record<string, PJeGrau> = {
  'pje1g.trf5.jus.br': '1g',
  'pje2g.trf5.jus.br': 'turma_recursal',
  'pjett.trf5.jus.br': '2g'
};

export function detectGrauFromHostname(hostname: string): PJeGrau {
  const host = hostname.toLowerCase();
  const known = KNOWN_HOSTS[host];
  if (known) return known;

  // Padrão genérico com grau embutido: pje1g.trf5.jus.br, pje2g.trt7.jus.br.
  const comGrau = host.match(
    /^pje(\d)g\.((?:trf|trt|tj[a-z]{2}|tse|stj|stf)[a-z0-9]*)\.jus\.br$/i
  );
  if (comGrau) {
    const digit = comGrau[1];
    if (digit === '1') return '1g';
    if (digit === '2') return '2g';
    return 'unknown';
  }

  if (/^pjett\.((?:trf)[a-z0-9]*)\.jus\.br$/i.test(host)) {
    return '2g';
  }

  return 'unknown';
}

/**
 * True quando o perfil "Secretaria" deve ficar disponível para a URL do
 * host — regra atual: apenas primeiro grau. Turma recursal e 2º grau
 * ordinário ficam restritos ao perfil "Gabinete".
 */
export function isSecretariaProfileAvailable(grau: PJeGrau): boolean {
  return grau === '1g';
}
