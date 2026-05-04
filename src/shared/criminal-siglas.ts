/**
 * Whitelist de siglas criminais — derivado do catálogo canônico em
 * `criminal-classes.ts`.
 *
 * Não há mais lista hardcoded aqui: o `Set` de siglas vem direto do
 * catálogo (que por sua vez veio do dump da tela de administração de
 * classes do PJe TRF5 1g). Se uma sigla aparece em
 * `recuperarProcessosTarefaPendenteComCriterios` mas não está no
 * catálogo, é descartada com log agregado para o usuário reportar.
 *
 * Comparação case-insensitive: a sigla recebida é normalizada com
 * `.toUpperCase()` antes do match — o `Set` derivado já está em UPPER.
 *
 * Para evoluir o whitelist, atualize `criminal-classes.ts` (a fonte
 * de verdade); o `Set` aqui rebaseia automaticamente.
 */

import {
  CLASSES_CRIMINAIS,
  SIGLAS_CRIMINAIS_UPPER,
  normalizarSigla
} from './criminal-classes';

export function isSiglaCriminal(sigla: string | null | undefined): boolean {
  if (!sigla) return false;
  return SIGLAS_CRIMINAIS_UPPER.has(normalizarSigla(sigla));
}

/**
 * Lista pública (cópia ordenada) das siglas criminais conhecidas.
 * Útil para exibir na UI ou para o usuário inspecionar.
 */
export function listarSiglasCriminais(): readonly string[] {
  return Array.from(SIGLAS_CRIMINAIS_UPPER).sort();
}

/**
 * Retorna a sigla canônica (CamelCase do PJe) para uma sigla de
 * entrada — útil pra logs onde queremos mostrar o nome bonito ao
 * invés do UPPER usado no match.
 */
export function siglaCanonica(sigla: string): string | null {
  const norm = normalizarSigla(sigla);
  if (!SIGLAS_CRIMINAIS_UPPER.has(norm)) return null;
  for (const c of CLASSES_CRIMINAIS) {
    if (normalizarSigla(c.sigla) === norm) return c.sigla;
  }
  return null;
}
