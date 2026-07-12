/**
 * "Aplicar etiquetas" da pauta de Perícias.
 *
 * Fluxo (duas etapas de escrita):
 *   1. Carrega o catálogo atual com `listarEtiquetas`.
 *   2. Procura a etiqueta-pauta pelo `nomeTag` (case-insensitive, trim).
 *   3. Se não existe, CRIA via POST `/painelUsuario/tags`.
 *   4. Para cada `idProcesso` do lote, vincula via POST
 *      `/painelUsuario/processoTags/inserir`.
 *
 * Histórico (2026-07): a atualização do PJe quebrou o fluxo. Captura no
 * DevTools (TRF5 1G) mostrou que o `/tags` continua sendo o endpoint de
 * criação e funciona (200 + entidade), mas o CORPO mudou — passou a exigir
 *   { marcado, possuiFilhos, visivelPublicamente, nomeTag, nomeTagCompleto }
 * e a rejeitar silenciosamente (200 sem corpo) o antigo `{ id:null, ... }`.
 * A vinculação NÃO cria on-the-fly: `/processoTags/inserir` com nome
 * inexistente devolve HTTP 500 ("Erro ao vincular a etiqueta ... ao
 * processo"). Por isso a criação explícita é obrigatória.
 *
 * As escritas rodam no page world do iframe Angular (via
 * `pericias-etiqueta-page-bridge`) para que o `Origin: frontend-prd` bata
 * com a whitelist do PJe — do isolated world o servidor rejeita a escrita
 * silenciosamente (200 sem corpo). Ambas usam `minimalAuth` (sem `X-no-sso`
 * nem `X-pje-authorization`, ausentes nos requests que funcionam). TODA
 * resposta é logada com URL, status e tamanho do corpo para diagnóstico.
 */

import { LOG_PREFIX, STORAGE_KEYS } from '../../shared/constants';
import type {
  PJeApiEtiqueta,
  PJeAuthSnapshot
} from '../../shared/types';
import { listarEtiquetas } from '../pje-api/pje-api-from-content';
import { fetchVincularEtiquetaNoPageWorld } from './pericias-etiqueta-page-bridge';

const LOG = `${LOG_PREFIX} [pericias-etiqueta-applier]`;

const MSG_SEM_LOCALIZACAO =
  'Sem localização (lotação) do usuário para escrever a etiqueta. Abra/atualize ' +
  'o Painel do Usuário do seu perfil no PJe e tente novamente.';

/**
 * Resolve a localização efetiva do header `X-pje-usuario-localizacao`: o
 * override (contexto de coleta do PREVJUD) tem precedência sobre a do snapshot
 * global. Vazia = a escrita será rejeitada com HTTP 500 (endpoint escopado por
 * perfil) — os chamadores abortam antes com `MSG_SEM_LOCALIZACAO`.
 */
function resolverLocalizacao(
  override: string | null | undefined,
  snap: PJeAuthSnapshot
): string {
  return (override ?? snap.pjeUsuarioLocalizacao ?? '').trim();
}

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
  /**
   * Localização (lotação) do usuário a usar no header
   * `X-pje-usuario-localizacao`. Quando informada, tem PRECEDÊNCIA sobre a
   * do snapshot global — a escrita de etiqueta é escopada por perfil no PJe,
   * e o snapshot global (last-writer-wins) pode refletir OUTRO perfil aberto,
   * causando HTTP 500. O dashboard PREVJUD passa a localização capturada no
   * contexto em que os processos foram coletados. `undefined` = usa o
   * snapshot (comportamento das Perícias/Triagem).
   */
  localizacaoOverride?: string | null;
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

// Rota de criação de etiqueta — POST /painelUsuario/tags. Confirmada em
// campo (DevTools TRF5 1G, 2026-07): criar etiqueta nova pela UI dispara
// este endpoint e ele responde 200 com a entidade criada (id definitivo).
const ENDPOINT_CRIAR_ETIQUETA = (base: string): string =>
  `${base}/painelUsuario/tags`;

// Única rota usada para vincular etiquetas (já existentes) a processos —
// POST /painelUsuario/processoTags/inserir com body
// `{ tag: "<nomeTag>", idProcesso: "<id como string>" }` (a etiqueta é
// identificada pelo NOME; o `/remover` é que usa `idTag`). NÃO cria
// on-the-fly.
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

  // Localização (lotação) dinâmica do usuário: override do contexto de coleta
  // com precedência sobre o snapshot global. Sem ela, o `/inserir` (escopado
  // por perfil) devolveria HTTP 500 — aborta com mensagem clara.
  const localizacao = resolverLocalizacao(input.localizacaoOverride, snap);
  if (!localizacao) {
    return { ok: false, aplicadas: 0, error: MSG_SEM_LOCALIZACAO, detalhes: [] };
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
  // A criação é um POST separado para `/painelUsuario/tags` (a vinculação NÃO
  // cria on-the-fly — devolve HTTP 500 para nome inexistente). Confirmado em
  // campo (DevTools TRF5 1G, 2026-07).
  let foiCriada = false;
  if (!etiqueta) {
    progress(`Etiqueta "${nome}" não existe — criando no PJe...`);
    const criada = await criarEtiqueta(snap, nome, localizacao);
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
  // Só quando a etiqueta foi criada agora. Falha de favoritar é degradação
  // graciosa: a pauta segue sendo vinculada normalmente.
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
  // O primeiro request é marcado como "debug": loga body e headers da
  // requisição/resposta, para comparar com uma captura manual no DevTools.
  const detalhes: AplicarEtiquetasResult['detalhes'] = [];
  let aplicadas = 0;
  for (let i = 0; i < input.idsProcesso.length; i++) {
    const idProcesso = input.idsProcesso[i];
    progress(`Vinculando ${i + 1}/${input.idsProcesso.length}...`);
    const r = await vincularEtiquetaAoProcesso(
      snap,
      etiqueta,
      idProcesso,
      localizacao,
      i === 0
    );
    if (r.ok) {
      aplicadas += 1;
      detalhes.push({ idProcesso, ok: true });
    } else {
      detalhes.push({ idProcesso, ok: false, error: r.error });
    }
  }

  const falhas = detalhes.filter((d) => !d.ok).length;
  if (aplicadas === 0) {
    // Surfaça o erro real do servidor (o primeiro) em vez de uma mensagem
    // genérica — é o que permite ver o motivo (ex.: corpo de um HTTP 500)
    // sem precisar abrir o console.
    const primeiro = detalhes.find((d) => !d.ok);
    return {
      ok: false,
      aplicadas,
      idEtiqueta: etiqueta.id,
      error:
        `Nenhum processo vinculado (${falhas}/${detalhes.length} falha(s)). ` +
        (primeiro
          ? `Erro do servidor no processo ${primeiro.idProcesso}: ${primeiro.error}`
          : `Verifique no console os logs com "[pericias-etiqueta-applier]".`),
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
  /** Ver `AplicarEtiquetasInput.localizacaoOverride`. */
  localizacaoOverride?: string | null;
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
  const localizacao = resolverLocalizacao(input.localizacaoOverride, snap);
  if (!localizacao) {
    return { ok: false, aplicadas: 0, error: MSG_SEM_LOCALIZACAO };
  }
  const base = pjeBaseUrl(snap);
  const headers = montarHeaders(snap, {
    withJsonBody: true,
    minimalAuth: true,
    localizacao
  });
  const url = ENDPOINT_VINCULAR_ETIQUETA(base);
  console.log(
    `${LOG} [vincular-lote] contexto=${window.location.href} headers=`,
    resumoHeaders(headers)
  );

  // Endpoint `/painelUsuario/processoTags/inserir` espera UMA etiqueta por
  // request: `{ tag: "<nomeTag>", idProcesso: "<id como string>" }` — a
  // etiqueta é identificada pelo NOME (o `/remover` é que usa `idTag`).
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
// Remover (desvincular) etiquetas de processos em lote
// =====================================================================

// POST /painelUsuario/processoTags/remover com body `{ idTag, idProcesso }`
// — a remoção identifica a etiqueta pelo ID (diferente do /inserir, que usa
// o nome). Documentado em docs/migracao-etiquetas-pje-v11.md.
const ENDPOINT_REMOVER_ETIQUETA = (base: string): string =>
  `${base}/painelUsuario/processoTags/remover`;

export interface RemoverEtiquetasInput {
  remocoes: Array<{ idProcesso: number; idTag: number; nomeTag?: string }>;
  /** Ver `AplicarEtiquetasInput.localizacaoOverride`. */
  localizacaoOverride?: string | null;
  onProgress?: (msg: string) => void;
}

export interface RemoverEtiquetasResult {
  ok: boolean;
  removidas: number;
  detalhes: Array<{ idProcesso: number; idTag: number; ok: boolean; error?: string }>;
  error?: string;
}

/**
 * Desvincula etiquetas de processos em lote (uma chamada por par
 * idProcesso×idTag). Roda no page world do iframe (mesmo motivo de Origin
 * do /inserir). A remoção é tolerante: HTTP 2xx conta como sucesso — o pior
 * caso é uma etiqueta antiga sobreviver, sem corromper o relatório.
 */
export async function removerEtiquetaEmLote(
  input: RemoverEtiquetasInput
): Promise<RemoverEtiquetasResult> {
  const progress = input.onProgress ?? (() => {});
  const detalhes: RemoverEtiquetasResult['detalhes'] = [];
  if (input.remocoes.length === 0) return { ok: true, removidas: 0, detalhes };

  const snap = await obterSnapshot();
  if (!snap) {
    return {
      ok: false,
      removidas: 0,
      detalhes,
      error: 'Sem snapshot de auth para remover etiquetas.'
    };
  }
  const localizacao = resolverLocalizacao(input.localizacaoOverride, snap);
  if (!localizacao) {
    return { ok: false, removidas: 0, detalhes, error: MSG_SEM_LOCALIZACAO };
  }
  const base = pjeBaseUrl(snap);
  const headers = montarHeaders(snap, {
    withJsonBody: true,
    minimalAuth: true,
    localizacao
  });
  const url = ENDPOINT_REMOVER_ETIQUETA(base);

  let removidas = 0;
  for (let i = 0; i < input.remocoes.length; i++) {
    const r = input.remocoes[i];
    progress(`Removendo etiqueta antiga ${i + 1}/${input.remocoes.length}...`);
    // Contrato do `/remover`: `{idTag: <número>, idProcesso: <número>}` — AMBOS
    // números (docs/migracao-etiquetas-pje-v11.md §4.2/§6). Diferente do
    // `/inserir`, que usa `idProcesso` como STRING. Enviar `idProcesso` como
    // string aqui fazia o PJe devolver HTTP 500 (corpo vazio) em TODA remoção.
    const body = JSON.stringify({
      idTag: r.idTag,
      idProcesso: r.idProcesso
    });
    const resp = await fetchVincularEtiquetaNoPageWorld({ url, headers, body });
    const text = resp.bodyText ?? '';
    console.log(
      `${LOG} POST ${url} [remover idTag=${r.idTag} de ${r.idProcesso}] -> ` +
        `${resp.status ?? '—'} (len=${text.length})`
    );
    if (!resp.ok) {
      detalhes.push({
        idProcesso: r.idProcesso,
        idTag: r.idTag,
        ok: false,
        error: resp.error ?? `HTTP ${resp.status} ${text.slice(0, 120)}`
      });
      continue;
    }
    removidas += 1;
    detalhes.push({ idProcesso: r.idProcesso, idTag: r.idTag, ok: true });
  }
  return { ok: removidas > 0, removidas, detalhes };
}

// =====================================================================
// Criar etiqueta (POST /painelUsuario/tags)
// =====================================================================

interface CriarEtiquetaResult {
  ok: boolean;
  etiqueta?: PJeApiEtiqueta;
  error?: string;
}

async function criarEtiqueta(
  snap: PJeAuthSnapshot,
  nome: string,
  localizacao: string
): Promise<CriarEtiquetaResult> {
  const base = pjeBaseUrl(snap);
  // Page world + `minimalAuth`: a criação é escrita e, do isolated world (ou
  // com `X-no-sso`/`X-pje-authorization`), o PJe responde 200 sem corpo
  // (rejeição silenciosa). No page world, com os headers que o Angular usa,
  // o servidor grava e devolve a entidade.
  const headers = montarHeaders(snap, {
    withJsonBody: true,
    minimalAuth: true,
    localizacao
  });
  // Body confirmado em campo (DevTools TRF5 1G, 2026-07). O PJe atualizado
  // EXIGE estes campos e rejeita silenciosamente (200 sem corpo) o antigo
  // `{ id:null, nomeTag, nomeTagCompleto }`. `nomeTagCompleto` = `nomeTag`
  // para etiqueta de primeiro nível (sem hierarquia).
  const body = JSON.stringify({
    marcado: false,
    possuiFilhos: false,
    visivelPublicamente: false,
    nomeTag: nome,
    nomeTagCompleto: nome
  });
  const url = ENDPOINT_CRIAR_ETIQUETA(base);
  const resp = await fetchVincularEtiquetaNoPageWorld({ url, headers, body });
  const text = resp.bodyText ?? '';
  console.log(
    `${LOG} POST ${url} -> ${resp.status ?? '—'} (len=${text.length}, ct=${resp.contentType ?? ''})`
  );
  if (!resp.ok) {
    console.warn(`${LOG} criação HTTP ${resp.status} em ${url}. Body bruto: ${text}`);
    return {
      ok: false,
      error:
        `Falha ao criar etiqueta em ${url}: ` +
        `${resp.error ?? `HTTP ${resp.status} ${text.slice(0, 200)}`}.`
    };
  }
  if (!text) {
    // 200 sem corpo = rejeição silenciosa (body/headers fora do esperado).
    return {
      ok: false,
      error:
        `Servidor devolveu HTTP ${resp.status} sem corpo ao criar "${nome}" — ` +
        `criação não confirmada. Verifique o console.`
    };
  }
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
            typeof json.nomeTagCompleto === 'string' ? json.nomeTagCompleto : nome,
          favorita: Boolean(json.favorita),
          possuiFilhos: Boolean(json.possuiFilhos),
          idTagFavorita: toNumberOrNull(json.idTagFavorita)
        }
      };
    }
    return {
      ok: false,
      error: `Resposta de criação sem \`id\` válido em ${url} — corpo: ${text.slice(0, 200)}.`
    };
  } catch (err) {
    console.warn(`${LOG} JSON parse falhou em ${url}:`, err, text);
    return {
      ok: false,
      error: `Resposta de criação não é JSON em ${url}: ${text.slice(0, 200)}.`
    };
  }
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
  localizacao: string,
  debug: boolean = false
): Promise<{ ok: boolean; error?: string }> {
  const base = pjeBaseUrl(snap);
  const headers = montarHeaders(snap, {
    withJsonBody: true,
    minimalAuth: true,
    localizacao
  });
  // Body `{ tag: "<nomeTag>", idProcesso: "<id como string>" }` — o
  // `/inserir` identifica a etiqueta pelo NOME (`tag`), não pelo id (o
  // `/remover` é que usa `idTag`). Confirmado pelo tamanho do request manual
  // (content-length 47 = este shape).
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
    console.log(`${LOG} [debug] response body:`, text.slice(0, 600));
  }
  if (!resp.ok) {
    // Loga o corpo bruto do erro — em HTTP 500 o PJe devolve um JSON curto
    // com a causa, essencial para diagnosticar (ex.: campo faltando, tag
    // inválida, conflito). Sem isso o motivo real fica invisível.
    console.warn(
      `${LOG} vinculação HTTP ${resp.status} em ${url}. Body bruto: ${text}`
    );
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
 *
 * Formatos observados em campo:
 *   - Antigo: array de objetos, cada um com `idProcessoTag` populado.
 *   - Novo (PJe 2026-07): a resposta deixou de ser o array antigo — a
 *     vinculação bem-sucedida devolve um OBJETO (ou array de objetos) com
 *     shape diferente. Aceitamos ambos.
 *   - Erro do PJe: array de STRINGS (ex.: `["Erro ao vincular a etiqueta
 *     ... ao processo"]`), que já vem como HTTP 500, mas defendemos aqui
 *     também caso venha com 200.
 *
 * Proteções mantidas contra "sucesso fantasma": corpo vazio (200 sem body =
 * rejeição silenciosa) e resposta não-JSON (HTML de login/erro).
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

  if (Array.isArray(parsed)) {
    if (parsed.length < minItens) {
      return {
        ok: false,
        error: `Servidor devolveu array vazio — vinculação não confirmada.`
      };
    }
    // Array de strings = mensagem de erro do PJe (assinatura conhecida).
    if (parsed.every((it) => typeof it === 'string')) {
      return { ok: false, error: parsed.join(' | ') };
    }
    // Array de objetos = associação(ões) criada(s). Aceita.
    return { ok: true };
  }

  // Objeto (formato novo). Rejeita só se houver marcador explícito de erro.
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const marcadorErro =
      (typeof o.erro === 'string' && o.erro) ||
      (typeof o.mensagemErro === 'string' && o.mensagemErro) ||
      (typeof o.error === 'string' && o.error);
    if (marcadorErro) {
      return { ok: false, error: String(marcadorErro) };
    }
    return { ok: true };
  }

  // Primitivo (string/number/boolean solto) — inesperado.
  return {
    ok: false,
    error: 'Resposta em formato inesperado — vinculação não confirmada.'
  };
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
    /**
     * Localização (lotação) a usar no header `X-pje-usuario-localizacao`.
     * Tem precedência sobre a do snapshot — ver
     * `AplicarEtiquetasInput.localizacaoOverride`. `undefined`/vazio = usa a
     * do snapshot.
     */
    localizacao?: string | null;
  }
): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: snap.authorization,
    Accept: 'application/json, text/plain, */*'
  };
  if (opts?.withJsonBody) h['Content-Type'] = 'application/json';
  if (snap.pjeCookies) h['X-pje-cookies'] = snap.pjeCookies;
  if (snap.pjeLegacyApp) h['X-pje-legacy-app'] = snap.pjeLegacyApp;
  const localizacao =
    (opts?.localizacao ?? snap.pjeUsuarioLocalizacao ?? '').trim();
  if (localizacao) h['X-pje-usuario-localizacao'] = localizacao;
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
