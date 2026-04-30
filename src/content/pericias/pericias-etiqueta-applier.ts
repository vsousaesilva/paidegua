/**
 * "Aplicar etiquetas" da pauta de Perícias.
 *
 * Fluxo:
 *   1. Carrega o catálogo atual com `listarEtiquetas`.
 *   2. Procura a etiqueta-pauta pelo `nomeTag` (case-insensitive, trim).
 *   3. Se não existir, cria via REST do PJe legacy.
 *   4. Para cada `idProcesso` do lote, vincula a etiqueta ao processo.
 *
 * ATENÇÃO — ENDPOINTS ASSUMIDOS (requerem confirmação em campo):
 *   As rotas de criação e vinculação de etiquetas NÃO são oficialmente
 *   documentadas e foram inferidas a partir do padrão Seam REST do PJe
 *   legacy (`/painelUsuario/etiquetas` já é conhecido para listagem). Cada
 *   helper (`criarEtiqueta`, `vincularEtiquetaAoProcesso`) tenta a rota
 *   mais provável primeiro e cai em alternativas quando o servidor
 *   responde 404/405. TODA resposta não-2xx é logada com a URL completa,
 *   o status, e o corpo bruto — isso permite diagnosticar rapidamente em
 *   produção qual é o endpoint correto e ajustar o código de ENDPOINT_*.
 *
 * Se o primeiro uso em ambiente real falhar, abra as DevTools no painel
 * Angular do PJe, execute a ação manualmente (criar uma etiqueta,
 * vincular a um processo) e compare as requisições observadas com as
 * tentativas aqui — a URL/body correta deve substituir a primeira
 * alternativa de cada array.
 */

import { LOG_PREFIX, STORAGE_KEYS } from '../../shared/constants';
import type {
  PJeApiEtiqueta,
  PJeAuthSnapshot
} from '../../shared/types';
import { listarEtiquetas } from '../pje-api/pje-api-from-content';
import { fetchVincularEtiquetaNoPageWorld } from './pericias-etiqueta-page-bridge';

const LOG = `${LOG_PREFIX} [pericias-etiqueta-applier]`;

export interface AplicarEtiquetasInput {
  /** Nome da etiqueta-pauta (ex.: "DR FULANO 20.04.26"). */
  etiquetaPauta: string;
  /** IDs dos processos onde a etiqueta será vinculada. */
  idsProcesso: number[];
  /**
   * Quando `true`, após criar a etiqueta (somente se não existia) dispara
   * GET `/painelUsuario/tagSessaoUsuario/adicionar/<id>` para marcá-la como
   * favorita do usuário. Falhas ao favoritar não derrubam a vinculação.
   */
  favoritarAposCriar?: boolean;
  onProgress?: (msg: string) => void;
}

export interface AplicarEtiquetasResult {
  ok: boolean;
  /** Quantidade de processos vinculados com sucesso. */
  aplicadas: number;
  /** Mensagem consolidada — em caso de erro, explica o que ocorreu. */
  error?: string;
  /** Detalhe por processo (sucesso/falha), para diagnóstico. */
  detalhes: Array<{ idProcesso: number; ok: boolean; error?: string }>;
  /** ID da etiqueta usada (recuperada ou criada). */
  idEtiqueta?: number;
}

// Tentativas de rotas — a primeira é a rota oficial confirmada em campo
// (DevTools no PJe TRF5 1G): POST /painelUsuario/tags. As demais são
// fallbacks para tribunais que possam usar variação do path.
const ENDPOINT_CRIAR_ETIQUETA: Array<(base: string) => string> = [
  (b) => `${b}/painelUsuario/tags`,
  (b) => `${b}/painelUsuario/etiquetas`,
  (b) => `${b}/painelUsuario/tag`,
  (b) => `${b}/painelUsuario/etiqueta`
];

// Única rota usada para vincular etiquetas a processos — confirmada em
// campo (DevTools TRF5 1G): POST /painelUsuario/processoTags/inserir com
// body como array de { id, nomeTag, nomeTagCompleto, idProcesso }. A
// resposta é o mesmo array, agora com `idProcessoTag` populado.
//
// Não usamos fallbacks: se o endpoint falhar, é mais seguro surfaçar o
// erro do que tentar rotas alternativas que possam retornar 200 com
// corpo inesperado (o que já causou "sucesso fantasma" em produção).
const ENDPOINT_VINCULAR_ETIQUETA = (base: string): string =>
  `${base}/painelUsuario/processoTags/inserir`;

// Favoritar etiqueta (adicioná-la à sessão do usuário no painel do PJe).
// Confirmado via DevTools (TRF5 1G): GET sem body, resposta 204 No Content.
// Idempotente — repetir para uma etiqueta já favoritada continua devolvendo
// 204 sem efeito colateral. Ver `favoritarEtiqueta` abaixo.
const ENDPOINT_FAVORITAR_ETIQUETA = (base: string, idEtiqueta: number): string =>
  `${base}/painelUsuario/tagSessaoUsuario/adicionar/${idEtiqueta}`;

// =====================================================================
// Entry point
// =====================================================================

export async function aplicarEtiquetaEmLote(
  input: AplicarEtiquetasInput
): Promise<AplicarEtiquetasResult> {
  const progress = input.onProgress ?? (() => {});
  const nome = input.etiquetaPauta.trim();
  if (!nome) {
    return {
      ok: false,
      aplicadas: 0,
      error: 'Nome da etiqueta-pauta vazio.',
      detalhes: []
    };
  }
  if (input.idsProcesso.length === 0) {
    return {
      ok: false,
      aplicadas: 0,
      error: 'Lista de processos vazia.',
      detalhes: []
    };
  }

  const snap = await obterSnapshot();
  if (!snap) {
    return {
      ok: false,
      aplicadas: 0,
      error:
        'Sem snapshot de auth — abra o painel do PJe e clique em qualquer ' +
        'tarefa para capturar antes de aplicar etiquetas.',
      detalhes: []
    };
  }

  // -- Passo 1: buscar etiqueta no catálogo --
  progress('Procurando etiqueta no catálogo do PJe...');
  const lista = await listarEtiquetas({ pageSize: 5000 });
  if (!lista.ok) {
    return {
      ok: false,
      aplicadas: 0,
      error: `Não foi possível listar etiquetas: ${lista.error ?? 'erro'}.`,
      detalhes: []
    };
  }
  const alvo = nome.toLowerCase();
  let etiqueta: PJeApiEtiqueta | undefined = lista.etiquetas.find(
    (e) => e.nomeTag.trim().toLowerCase() === alvo
  );

  // -- Passo 2: criar etiqueta se ainda não existe --
  let foiCriada = false;
  if (!etiqueta) {
    progress(`Etiqueta "${nome}" não existe — criando no PJe...`);
    const criada = await criarEtiqueta(snap, nome);
    if (!criada.ok || !criada.etiqueta) {
      return {
        ok: false,
        aplicadas: 0,
        error:
          criada.error ??
          'Falha ao criar a etiqueta-pauta (endpoint não respondeu como esperado).',
        detalhes: []
      };
    }
    etiqueta = criada.etiqueta;
    foiCriada = true;
    progress(`Etiqueta criada (id=${etiqueta.id}).`);
  } else {
    progress(`Etiqueta encontrada no catálogo (id=${etiqueta.id}).`);
  }

  // -- Passo 2.1: favoritar (opt-in) --
  // Só faz sentido quando a etiqueta foi criada agora — se o usuário quiser
  // favoritar uma pré-existente, faz pelo PJe. Falha de favoritar é
  // degradação graciosa: a pauta segue sendo vinculada normalmente.
  if (input.favoritarAposCriar && foiCriada) {
    progress(`Favoritando etiqueta "${nome}"...`);
    const fav = await favoritarEtiqueta(snap, etiqueta.id);
    if (!fav.ok) {
      progress(`Aviso: falha ao favoritar — ${fav.error ?? 'erro desconhecido'}.`);
      console.warn(
        `${LOG} favoritar falhou (id=${etiqueta.id}): ${fav.error ?? 'erro'}`
      );
    } else {
      progress('Etiqueta favoritada.');
    }
  }

  // -- Passo 3: vincular a cada processo --
  // O primeiro request é marcado como "debug": loga body, headers da
  // requisição e da resposta. Assim, na primeira falha em campo, temos
  // material para comparar com uma captura manual no DevTools.
  const detalhes: AplicarEtiquetasResult['detalhes'] = [];
  let aplicadas = 0;
  for (let i = 0; i < input.idsProcesso.length; i++) {
    const idProcesso = input.idsProcesso[i];
    progress(`Vinculando ${i + 1}/${input.idsProcesso.length}...`);
    const r = await vincularEtiquetaAoProcesso(snap, etiqueta, idProcesso, i === 0);
    if (r.ok) {
      aplicadas += 1;
      detalhes.push({ idProcesso, ok: true });
    } else {
      detalhes.push({ idProcesso, ok: false, error: r.error });
    }
  }

  const falhas = detalhes.filter((d) => !d.ok).length;
  if (aplicadas === 0) {
    return {
      ok: false,
      aplicadas,
      idEtiqueta: etiqueta.id,
      error:
        `Nenhum processo vinculado. O endpoint de vinculação pode estar ` +
        `diferente do assumido — verifique no console os logs com ` +
        `"[pericias-etiqueta-applier]" para URL e status das tentativas.`,
      detalhes
    };
  }
  return {
    ok: true,
    aplicadas,
    idEtiqueta: etiqueta.id,
    error:
      falhas > 0
        ? `${aplicadas} vinculada(s), ${falhas} falha(s). Veja o console do PJe para detalhes.`
        : undefined,
    detalhes
  };
}

// =====================================================================
// Inserir (vincular) um conjunto de etiquetas já existentes no processo
// atual. Usado pela ação "Inserir etiquetas mágicas" da Triagem.
// =====================================================================

export interface AplicarEtiquetasNoProcessoInput {
  etiquetas: ReadonlyArray<
    Pick<PJeApiEtiqueta, 'id' | 'nomeTag' | 'nomeTagCompleto'> &
      Partial<Pick<PJeApiEtiqueta, 'favorita' | 'possuiFilhos' | 'idTagFavorita'>>
  >;
  idProcesso: number;
}

export interface AplicarEtiquetasNoProcessoResult {
  ok: boolean;
  aplicadas: number;
  error?: string;
}

/**
 * Vincula um lote de etiquetas (já existentes no catálogo) ao `idProcesso`
 * informado via POST `/painelUsuario/processoTags/inserir`. O endpoint
 * aceita um array de etiquetas num único request — não é necessário
 * fazer N chamadas.
 */
export async function aplicarEtiquetasNoProcesso(
  input: AplicarEtiquetasNoProcessoInput
): Promise<AplicarEtiquetasNoProcessoResult> {
  if (input.etiquetas.length === 0) {
    return { ok: false, aplicadas: 0, error: 'Nenhuma etiqueta selecionada.' };
  }
  if (!Number.isFinite(input.idProcesso) || input.idProcesso <= 0) {
    return {
      ok: false,
      aplicadas: 0,
      error: 'idProcesso inválido — abra os autos digitais do processo e tente novamente.'
    };
  }
  const snap = await obterSnapshot();
  if (!snap) {
    return {
      ok: false,
      aplicadas: 0,
      error:
        'Sem snapshot de auth — abra uma tarefa no painel do PJe para capturar e tente de novo.'
    };
  }
  const base = pjeBaseUrl(snap);
  const headers = montarHeaders(snap, { withJsonBody: true, minimalAuth: true });
  const url = ENDPOINT_VINCULAR_ETIQUETA(base);
  console.log(
    `${LOG} [vincular-lote] contexto=${window.location.href} headers=`,
    resumoHeaders(headers)
  );

  // Endpoint `/painelUsuario/processoTags/inserir` espera UMA etiqueta por
  // request: `{ tag: "<nomeTag>", idProcesso: "<id como string>" }`.
  // Body confirmado via DevTools em vinculação manual (TRF5 1G). Ver
  // commit que introduziu este laço e docs/ para o protocolo completo.
  let aplicadas = 0;
  const erros: string[] = [];
  for (const e of input.etiquetas) {
    const body = JSON.stringify({
      tag: e.nomeTag,
      idProcesso: String(input.idProcesso)
    });
    const resp = await fetchVincularEtiquetaNoPageWorld({ url, headers, body });
    const text = resp.bodyText ?? '';
    console.log(
      `${LOG} POST ${url} [${e.nomeTag}] -> ${resp.status ?? '—'} (len=${text.length}, ct=${resp.contentType ?? ''})`
    );
    if (!resp.ok) {
      erros.push(
        `${e.nomeTag}: ${resp.error ?? `HTTP ${resp.status} ${text.slice(0, 120)}`}`
      );
      continue;
    }
    const v = validarRespostaVinculacao(text, 1);
    if (!v.ok) {
      console.warn(
        `${LOG} vinculação rejeitada pelo servidor (${e.nomeTag}): ${v.error}. Body=${text.slice(0, 400)}`
      );
      erros.push(`${e.nomeTag}: ${v.error}`);
      continue;
    }
    aplicadas += 1;
  }
  if (aplicadas === 0) {
    return {
      ok: false,
      aplicadas: 0,
      error: erros.join(' | ') || 'Nenhuma etiqueta vinculada.'
    };
  }
  return {
    ok: true,
    aplicadas,
    error: erros.length > 0 ? erros.join(' | ') : undefined
  };
}

// =====================================================================
// Criar etiqueta
// =====================================================================

interface CriarEtiquetaResult {
  ok: boolean;
  etiqueta?: PJeApiEtiqueta;
  error?: string;
}

async function criarEtiqueta(
  snap: PJeAuthSnapshot,
  nome: string
): Promise<CriarEtiquetaResult> {
  const base = pjeBaseUrl(snap);
  const headers = montarHeaders(snap, { withJsonBody: true });
  // Body confirmado em campo via DevTools no PJe TRF5 1G (POST /painelUsuario/tags).
  // Formato mínimo: { id: null, nomeTag, nomeTagCompleto }. O servidor
  // devolve a entidade criada com o `id` definitivo.
  const body = JSON.stringify({
    id: null,
    nomeTag: nome,
    nomeTagCompleto: nome
  });
  let lastErr = '';
  for (const buildUrl of ENDPOINT_CRIAR_ETIQUETA) {
    const url = buildUrl(base);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body,
        credentials: 'include'
      });
      const text = await resp.text().catch(() => '');
      console.log(
        `${LOG} POST ${url} -> ${resp.status} (len=${text.length})`
      );
      if (resp.ok && text) {
        try {
          const json = JSON.parse(text);
          const id = toNumber(json?.id);
          if (id > 0) {
            return {
              ok: true,
              etiqueta: {
                id,
                nomeTag: typeof json.nomeTag === 'string' ? json.nomeTag : nome,
                nomeTagCompleto:
                  typeof json.nomeTagCompleto === 'string'
                    ? json.nomeTagCompleto
                    : nome,
                favorita: Boolean(json.favorita),
                possuiFilhos: Boolean(json.possuiFilhos),
                idTagFavorita: toNumberOrNull(json.idTagFavorita)
              }
            };
          }
        } catch (err) {
          console.warn(`${LOG} JSON parse falhou em ${url}:`, err, text);
        }
      }
      // 404/405 indica endpoint errado; outros códigos geralmente são
      // definitivos (403 auth, 400 body) — mesmo assim registramos e
      // tentamos a próxima rota.
      lastErr = `HTTP ${resp.status} em ${url}: ${text.slice(0, 200)}`;
    } catch (err) {
      lastErr = `${url}: ${errMsg(err)}`;
      console.warn(`${LOG} exception ao criar etiqueta em ${url}:`, err);
    }
  }
  return {
    ok: false,
    error:
      `Todas as tentativas de criar etiqueta falharam. Último erro: ${lastErr}. ` +
      `Verifique o console para detalhes das rotas testadas e ajuste ` +
      `ENDPOINT_CRIAR_ETIQUETA em pericias-etiqueta-applier.ts.`
  };
}

// =====================================================================
// Favoritar etiqueta (tagSessaoUsuario/adicionar)
// =====================================================================

/**
 * Marca a etiqueta como favorita para o usuário (aparece no topo do painel
 * do PJe). Endpoint confirmado via DevTools (TRF5 1G):
 *   GET /painelUsuario/tagSessaoUsuario/adicionar/<idEtiqueta>
 *   Resposta: 204 No Content (sem corpo). Idempotente.
 *
 * Fetch plain (isolated world do iframe) basta — o endpoint é GET e o
 * PJe já aceita esse Origin. A silent-rejection observada era específica
 * do POST /processoTags/inserir e foi endereçada no page-world bridge.
 */
async function favoritarEtiqueta(
  snap: PJeAuthSnapshot,
  idEtiqueta: number
): Promise<{ ok: boolean; error?: string }> {
  const base = pjeBaseUrl(snap);
  const url = ENDPOINT_FAVORITAR_ETIQUETA(base, idEtiqueta);
  const headers = montarHeaders(snap, { withJsonBody: false });
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include'
    });
    console.log(`${LOG} GET ${url} -> ${resp.status}`);
    if (resp.status === 204 || resp.ok) return { ok: true };
    const text = await resp.text().catch(() => '');
    return {
      ok: false,
      error: `HTTP ${resp.status}: ${text.slice(0, 200)}`
    };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

// =====================================================================
// Vincular etiqueta a processo
// =====================================================================

async function vincularEtiquetaAoProcesso(
  snap: PJeAuthSnapshot,
  etiqueta: PJeApiEtiqueta,
  idProcesso: number,
  debug: boolean = false
): Promise<{ ok: boolean; error?: string }> {
  const base = pjeBaseUrl(snap);
  const headers = montarHeaders(snap, { withJsonBody: true, minimalAuth: true });
  // Body confirmado em campo (DevTools TRF5 1G): array de etiquetas
  // anotadas com `idProcesso`. O servidor devolve a lista com
  // `idProcessoTag` populado para cada item.
  // Endpoint `/painelUsuario/processoTags/inserir` espera
  // `{ tag: "<nomeTag>", idProcesso: "<id como string>" }` — NÃO um array
  // de entidades como `/painelUsuario/tags` (criar) retorna. Body confirmado
  // via DevTools em vinculação manual bem-sucedida (TRF5 1G).
  const body = JSON.stringify({
    tag: etiqueta.nomeTag,
    idProcesso: String(idProcesso)
  });
  const url = ENDPOINT_VINCULAR_ETIQUETA(base);
  if (debug) {
    console.log(`${LOG} [debug] contexto=${window.location.href}`);
    console.log(`${LOG} [debug] request body:`, body);
    console.log(`${LOG} [debug] request headers:`, resumoHeaders(headers));
  }
  const resp = await fetchVincularEtiquetaNoPageWorld({ url, headers, body });
  const text = resp.bodyText ?? '';
  const contentType = resp.contentType ?? '';
  console.log(
    `${LOG} POST ${url} -> ${resp.status ?? '—'} (len=${text.length}, ct=${contentType})`
  );
  if (debug) {
    console.log(
      `${LOG} [debug] response headers:`,
      JSON.stringify(resp.responseHeaders ?? {})
    );
  }
  if (!resp.ok) {
    return {
      ok: false,
      error:
        resp.error ??
        `HTTP ${resp.status} em ${url}: ${text.slice(0, 200)}`
    };
  }
  const v = validarRespostaVinculacao(text, 1);
  if (!v.ok) {
    console.warn(
      `${LOG} vinculação rejeitada pelo servidor: ${v.error}. Body=${text.slice(0, 400)}`
    );
    return { ok: false, error: v.error };
  }
  return { ok: true };
}

/** Copia os headers removendo o valor do Authorization (só mostra o esquema). */
function resumoHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'authorization') {
      const m = v.match(/^(\w+)\s/);
      out[k] = m ? `${m[1]} <jwt truncado>` : '<truncado>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Valida o corpo retornado por `/painelUsuario/processoTags/inserir`.
 * Resposta real é um array com `idProcessoTag` populado em cada item —
 * se vier vazio/malformado, o servidor aceitou a chamada (HTTP 200) mas
 * não inseriu a associação (caso clássico de token auxiliar ausente ou
 * duplicidade silenciosa).
 */
function validarRespostaVinculacao(
  text: string,
  minItens: number
): { ok: true } | { ok: false; error: string } {
  if (!text) {
    return {
      ok: false,
      error: 'Servidor devolveu HTTP 200 sem corpo — vinculação não confirmada.'
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: 'Resposta não é JSON — servidor pode ter devolvido HTML de login/erro.'
    };
  }
  if (!Array.isArray(parsed) || parsed.length < minItens) {
    return {
      ok: false,
      error: `Servidor devolveu array ${Array.isArray(parsed) ? `com ${parsed.length} item(ns)` : 'inesperado'} — vinculação não confirmada.`
    };
  }
  const semIdProcessoTag = parsed.filter(
    (it) =>
      !it ||
      typeof it !== 'object' ||
      !Number.isFinite(
        Number((it as { idProcessoTag?: unknown }).idProcessoTag)
      ) ||
      Number((it as { idProcessoTag?: unknown }).idProcessoTag) <= 0
  ).length;
  if (semIdProcessoTag > 0) {
    return {
      ok: false,
      error: `${semIdProcessoTag} item(ns) da resposta sem idProcessoTag — vinculação não efetivada.`
    };
  }
  return { ok: true };
}

// =====================================================================
// Helpers locais (duplicam o mínimo do pje-api-from-content para não
// obrigar aquele módulo a exportar internos).
// =====================================================================

async function obterSnapshot(): Promise<PJeAuthSnapshot | null> {
  try {
    const r = await chrome.storage.session.get(STORAGE_KEYS.PJE_AUTH_SNAPSHOT);
    const s = r[STORAGE_KEYS.PJE_AUTH_SNAPSHOT];
    if (s && typeof s === 'object') return s as PJeAuthSnapshot;
  } catch (err) {
    console.warn(`${LOG} falha ao ler snapshot:`, err);
  }
  return null;
}

function pjeBaseUrl(snap: PJeAuthSnapshot): string {
  const m = snap.url.match(
    /^(https?:\/\/[^/]+\/pje\/seam\/resource\/rest\/pje-legacy)/i
  );
  return m
    ? m[1]
    : `${window.location.origin}/pje/seam/resource/rest/pje-legacy`;
}

function montarHeaders(
  snap: PJeAuthSnapshot,
  opts?: {
    withJsonBody?: boolean;
    /**
     * Se true, espelha EXATAMENTE o conjunto que o Angular envia em
     * `/painelUsuario/processoTags/inserir` — sem `X-no-sso` nem
     * `X-pje-authorization`. Confirmado em captura manual do DevTools:
     * esses dois headers extras não apareciam no request que funcionou.
     * Se enviados, o servidor responde 200 com corpo vazio (rejeição
     * silenciosa típica desse endpoint).
     */
    minimalAuth?: boolean;
  }
): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: snap.authorization,
    Accept: 'application/json, text/plain, */*'
  };
  if (opts?.withJsonBody) h['Content-Type'] = 'application/json';
  if (snap.pjeCookies) h['X-pje-cookies'] = snap.pjeCookies;
  if (snap.pjeLegacyApp) h['X-pje-legacy-app'] = snap.pjeLegacyApp;
  if (snap.pjeUsuarioLocalizacao)
    h['X-pje-usuario-localizacao'] = snap.pjeUsuarioLocalizacao;
  if (!opts?.minimalAuth) {
    if (snap.xNoSso) h['X-no-sso'] = snap.xNoSso;
    if (snap.xPjeAuthorization) h['X-pje-authorization'] = snap.xPjeAuthorization;
  }
  return h;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
