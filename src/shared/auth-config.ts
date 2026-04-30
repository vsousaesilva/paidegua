/**
 * Configuracao do backend de autenticacao do pAIdegua.
 *
 * Apos implantar o Apps Script (ver `backend/apps-script/Code.gs`),
 * cole a URL gerada (termina em `.../exec`) na constante abaixo.
 *
 * IMPORTANTE: este arquivo e o unico ponto da extensao que conhece a URL
 * do backend. Mude aqui se um dia o backend migrar para outro endereco —
 * o resto do codigo continua funcionando sem alteracao.
 */

export const BACKEND_URL = 'COLE_AQUI_A_URL_DO_APPS_SCRIPT';

/**
 * Heuristica leve para detectar configuracao incompleta — usada pelo cliente
 * de auth para devolver um erro claro em vez de uma falha de rede genrica.
 */
export function isBackendConfigured(): boolean {
  return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(BACKEND_URL);
}
