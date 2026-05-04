/**
 * Cliente das APIs REST do PJe legacy, executado DENTRO do content
 * script — isto e, no mesmo origin da pagina hospedeira (`pje1g.trf5.
 * jus.br`, `pje2g...`, etc.).
 *
 * Motivacao: quando essas mesmas chamadas saem do service worker
 * (origin `chrome-extension://...`) o PJe legacy trata como cross-origin
 * e devolve 200 OK com corpo vazio no `gerarChaveAcessoProcesso`.
 * Rodando a partir do content script o cookie real do dominio e anexado
 * automaticamente e o servidor responde o hash `ca` esperado.
 *
 * O snapshot de auth continua sendo capturado pelo interceptor page-world
 * e persistido em `chrome.storage.session` pelo background — aqui apenas
 * lemos esse snapshot.
 *
 * Endpoints utilizados:
 *   - POST {base}/painelUsuario/recuperarProcessosTarefaPendenteComCriterios/{nomeTarefa}/false
 *     body { page, maxResults } -> { count, entities[] }
 *   - GET  {base}/painelUsuario/gerarChaveAcessoProcesso/{idProcesso}
 *     -> string (chave 'ca')
 */

import { LOG_PREFIX, STORAGE_KEYS } from '../../shared/constants';
import type {
  Http403Diagnostic,
  PJeApiEtiqueta,
  PJeApiEtiquetaRaw,
  PJeApiEtiquetasListResponse,
  PJeApiListarRequest,
  PJeApiListarResponse,
  PJeApiProcesso,
  PJeApiResolveCaResponse,
  PJeAuthSnapshot
} from '../../shared/types';
import {
  decodeJwtExp,
  registrar403Diag,
  solicitarRefreshSilent
} from '../auth/pje-auth-refresh-bridge';

async function obterSnapshot(): Promise<PJeAuthSnapshot | null> {
  try {
    const r = await chrome.storage.session.get(STORAGE_KEYS.PJE_AUTH_SNAPSHOT);
    const s = r[STORAGE_KEYS.PJE_AUTH_SNAPSHOT];
    if (s && typeof s === 'object') return s as PJeAuthSnapshot;
  } catch (err) {
    console.warn(`${LOG_PREFIX} pje-api-from-content: falha lendo snapshot:`, err);
  }
  return null;
}

/**
 * Le o `capturedAt` (epoch ms) do snapshot de auth corrente. Usado pelo
 * coordinator de Prazos na Fita para detectar quando o Angular renovou o
 * token Keycloak em background e um retry vale a pena.
 */
export async function lerCapturadoEmSnapshot(): Promise<number | null> {
  const s = await obterSnapshot();
  return s ? s.capturedAt : null;
}

/**
 * Le o snapshot de auth completo. Usado pelo coordinator de Prazos na Fita
 * para inspecionar `jwtExp` e disparar refresh proativo antes do token
 * expirar (em varreduras 2k+, a aba pode ficar em background e o Angular
 * nao renova sozinho — proativo evita o storm de 403).
 */
export async function lerSnapshotAuth(): Promise<PJeAuthSnapshot | null> {
  return obterSnapshot();
}

/**
 * Aguarda o snapshot de auth ser atualizado para um `capturedAt` maior
 * que `desdeMs`. Retorna true quando detecta; false em timeout.
 *
 * Usa `chrome.storage.onChanged` (reativo, sem polling) — quando o Angular
 * faz a proxima chamada REST apos o Keycloak renovar o token, o
 * interceptor grava o novo snapshot e todos os workers esperando sao
 * acordados de uma vez.
 *
 * Checa o estado atual no inicio para cobrir a janela entre o timestamp
 * anterior ter sido lido e o listener ter sido registrado.
 */
export function aguardarNovoSnapshot(
  desdeMs: number,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName
    ): void => {
      if (done || area !== 'session') return;
      const ch = changes[STORAGE_KEYS.PJE_AUTH_SNAPSHOT];
      if (!ch) return;
      const nv = ch.newValue as PJeAuthSnapshot | undefined;
      if (nv && typeof nv.capturedAt === 'number' && nv.capturedAt > desdeMs) {
        done = true;
        clearTimeout(timer);
        chrome.storage.onChanged.removeListener(listener);
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.storage.onChanged.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    chrome.storage.onChanged.addListener(listener);
    // Pode ter sido atualizado entre a leitura do `desdeMs` e este ponto.
    void obterSnapshot().then((s) => {
      if (done) return;
      if (s && s.capturedAt > desdeMs) {
        done = true;
        clearTimeout(timer);
        chrome.storage.onChanged.removeListener(listener);
        resolve(true);
      }
    });
  });
}

/**
 * `fetch` com timeout duro que cobre TODO o ciclo — handshake, headers
 * E leitura do body. O padrao "cobrir so o fetch e ler o texto depois"
 * (que usavamos antes) deixa buraco: com servidor PJe saturado em
 * varreduras grandes, a resposta chega com headers mas o stream do body
 * fica pendurado, e `resp.text()` espera indefinidamente porque o
 * AbortController ja foi limpo. Workers pendurados nesse ponto congelam
 * todos os slots do pool e a varredura parece "parar".
 *
 * Devolve direto `{ ok, status, text, contentType }` para forcar que o
 * consumidor leia o corpo dentro da janela protegida.
 */
async function fetchTextoComTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{
  ok: boolean;
  status: number;
  text: string;
  contentType: string | null;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs
  );
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      text,
      contentType: resp.headers.get('content-type')
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrai ":jsessionId" do `document.cookie`. Usado pela instrumentacao
 * de 403 pra apontar se a causa e sessao Seam legacy expirada (e nao
 * Bearer expirado). O JSESSIONID do PJe e same-origin, entao temos
 * acesso via `document.cookie`.
 */
function jsessionIdPresente(): boolean {
  try {
    return /(^|;)\s*JSESSIONID=/.test(document.cookie);
  } catch {
    return false;
  }
}

/**
 * Registra diagnostico de um 403 e tenta silent refresh do Bearer UMA VEZ.
 * Em sucesso, o snapshot atualizado ja esta em `chrome.storage.session` —
 * o caller deve re-executar a chamada (os headers serao relidos). Em
 * falha, apenas loga e segue (caller trata como 403 definitivo).
 */
async function diagnosticarERefrescar403(
  snap: PJeAuthSnapshot,
  url: string,
  status: number,
  body: string
): Promise<{ refreshOk: boolean; refreshError?: string }> {
  const agora = Date.now();
  const jwtExp = decodeJwtExp(snap.authorization);
  const diag: Http403Diagnostic = {
    capturedAt: agora,
    url,
    status,
    snapshotAgeMs: snap.capturedAt ? agora - snap.capturedAt : null,
    jwtExp,
    jwtExpiredAtRequest:
      jwtExp != null ? jwtExp * 1000 <= agora : null,
    jsessionIdPresent: jsessionIdPresente(),
    bodySnippet: body.slice(0, 500),
    silentRefreshAttempted: false,
    silentRefreshOk: null
  };

  const r = await solicitarRefreshSilent();
  diag.silentRefreshAttempted = true;
  diag.silentRefreshOk = r.ok;
  if (!r.ok) diag.silentRefreshError = r.error;
  await registrar403Diag(diag);

  return {
    refreshOk: r.ok,
    refreshError: r.error
  };
}

/**
 * Classifica o erro de um `fetch` como transiente (retry faz sentido) ou
 * definitivo (HTTP 4xx que nao seja 429). `TypeError` e o erro generico
 * que o `fetch` lança em falhas de rede ("Failed to fetch"); `AbortError`/
 * `TimeoutError` sao do nosso timeout; `429` e rate limit explicito; `5xx`
 * e erro de servidor, tipicamente transiente.
 */
function eErroTransiente(err: unknown, httpStatus?: number): boolean {
  if (typeof httpStatus === 'number') {
    if (httpStatus === 429) return true;
    if (httpStatus >= 500 && httpStatus < 600) return true;
    return false;
  }
  if (err instanceof DOMException) {
    return err.name === 'AbortError' || err.name === 'TimeoutError';
  }
  if (err instanceof TypeError) return true;
  return false;
}

/**
 * Executa `fn` com retry e backoff exponencial quando o erro for
 * classificado como transiente. Os delays sao 1s, 3s, 9s (3 tentativas
 * alem da primeira = ate 4 tentativas no total). Usado em varreduras
 * longas onde falhas pontuais de rede/servidor sao esperadas.
 */
async function comRetryTransiente<T>(
  fn: () => Promise<{ resultado: T; httpStatus?: number; transiente?: boolean }>,
  opts: { tentativas?: number; baseMs?: number } = {}
): Promise<T> {
  const tentativas = Math.max(1, opts.tentativas ?? 4);
  const baseMs = opts.baseMs ?? 1_000;
  let ultimoErr: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fn();
      if (r.transiente && i < tentativas - 1) {
        await new Promise((res) => setTimeout(res, baseMs * Math.pow(3, i)));
        continue;
      }
      return r.resultado;
    } catch (err) {
      ultimoErr = err;
      if (!eErroTransiente(err) || i === tentativas - 1) throw err;
      await new Promise((res) => setTimeout(res, baseMs * Math.pow(3, i)));
    }
  }
  throw ultimoErr ?? new Error('retry esgotou sem sucesso');
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
  opts?: { withJsonBody?: boolean }
): HeadersInit {
  const h: Record<string, string> = {
    Authorization: snap.authorization,
    // `gerarChaveAcessoProcesso` responde string crua — Accept: */* evita 406.
    Accept: '*/*'
  };
  if (opts?.withJsonBody) h['Content-Type'] = 'application/json';
  if (snap.pjeCookies) h['X-pje-cookies'] = snap.pjeCookies;
  if (snap.pjeLegacyApp) h['X-pje-legacy-app'] = snap.pjeLegacyApp;
  if (snap.pjeUsuarioLocalizacao)
    h['X-pje-usuario-localizacao'] = snap.pjeUsuarioLocalizacao;
  // X-no-sso e X-pje-authorization sao replicados quando presentes: sem
  // X-no-sso o backend do PJe pode responder 200 com corpo vazio quando
  // o Authorization nao e Bearer (fallback Basic pos-expiracao do SSO).
  if (snap.xNoSso) h['X-no-sso'] = snap.xNoSso;
  if (snap.xPjeAuthorization)
    h['X-pje-authorization'] = snap.xPjeAuthorization;
  return h;
}

interface ApiEntityAninhada {
  descricao?: unknown;
  nome?: unknown;
  // `nomeTag` aparece nos itens de `tagsProcessoList` na resposta da REST
  // `recuperarProcessosTarefaPendenteComCriterios` (shape observado:
  // `{ id, idProcesso, idProcessoTag, nomeTag, nomeTagCompleto }`). Os
  // demais DTOs (polo, orgao, classe) usam `descricao`/`nome`.
  nomeTag?: unknown;
}
interface ApiEntity {
  idProcesso?: number | string;
  numeroProcesso?: string;
  idTaskInstance?: number | string;
  classeJudicial?: string | ApiEntityAninhada | null;
  poloAtivo?: string | ApiEntityAninhada | Array<string | ApiEntityAninhada> | null;
  poloPassivo?: string | ApiEntityAninhada | Array<string | ApiEntityAninhada> | null;
  orgaoJulgador?: string | ApiEntityAninhada | null;
  dataChegada?: string | number;
  dataChegadaTarefa?: string | number;
  prioridade?: boolean;
  sigiloso?: boolean;
  tagsProcessoList?: Array<string | ApiEntityAninhada>;
  assuntoPrincipal?: string | ApiEntityAninhada | null;
  descricaoUltimoMovimento?: string | null;
  ultimoMovimento?: number | string | null;
  cargoJudicial?: string | ApiEntityAninhada | null;
}

function extrairTexto(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const partes = v
      .map((x) => extrairTexto(x))
      .filter((s): s is string => !!s);
    return partes.length > 0 ? partes.join('; ') : null;
  }
  if (typeof v === 'object') {
    const o = v as ApiEntityAninhada;
    return (
      extrairTexto(o.descricao) ??
      extrairTexto(o.nome) ??
      extrairTexto(o.nomeTag)
    );
  }
  return null;
}

function extrairEtiquetas(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => extrairTexto(x))
    .filter((s): s is string => !!s);
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizarDataChegada(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function normalizarEntity(e: ApiEntity): PJeApiProcesso {
  return {
    idProcesso: toNumberOrNull(e.idProcesso) ?? 0,
    numeroProcesso: e.numeroProcesso ?? null,
    idTaskInstance: toNumberOrNull(e.idTaskInstance),
    classeJudicial: extrairTexto(e.classeJudicial),
    poloAtivo: extrairTexto(e.poloAtivo),
    poloPassivo: extrairTexto(e.poloPassivo),
    orgaoJulgador: extrairTexto(e.orgaoJulgador),
    dataChegadaTarefa:
      normalizarDataChegada(e.dataChegadaTarefa) ??
      normalizarDataChegada(e.dataChegada),
    prioridade: Boolean(e.prioridade),
    sigiloso: Boolean(e.sigiloso),
    etiquetas: extrairEtiquetas(e.tagsProcessoList),
    assuntoPrincipal: extrairTexto(e.assuntoPrincipal),
    descricaoUltimoMovimento: extrairTexto(e.descricaoUltimoMovimento),
    ultimoMovimento: toNumberOrNull(e.ultimoMovimento),
    cargoJudicial: extrairTexto(e.cargoJudicial)
  };
}

/**
 * Lista todos os processos pendentes em uma tarefa, paginando ate o
 * `count` reportado pelo servidor (ou ate `maxProcessos`, se passado).
 *
 * Limite duro de seguranca: 200 paginas (= 20k processos com pageSize
 * 100). Acima disso aborta para evitar tempestade de chamadas se o
 * servidor reportar um count absurdo.
 */
export async function listarProcessosDaTarefa(
  req: PJeApiListarRequest
): Promise<PJeApiListarResponse> {
  const snap = await obterSnapshot();
  if (!snap) {
    const msg =
      'Sem snapshot de auth — abra o painel do PJe e clique em qualquer tarefa para capturar.';
    console.warn(
      `${LOG_PREFIX} [REST] listarProcessosDaTarefa "${req.nomeTarefa}": ${msg}`
    );
    return {
      ok: false,
      total: 0,
      processos: [],
      error: msg
    };
  }
  const baseUrl = pjeBaseUrl(snap);
  const tarefaEnc = encodeURIComponent(req.nomeTarefa);
  // O boolean final do path e um flag do endpoint; `false` e o que o painel
  // Angular usa. Testamos trocar por `true` e o servidor devolveu `count=0`,
  // ou seja, o flag muda o predicado (provavelmente "apenas prioritarios"
  // ou similar). Mantemos `false` e investigamos a divergencia via body.
  const url = `${baseUrl}/painelUsuario/recuperarProcessosTarefaPendenteComCriterios/${tarefaEnc}/false`;
  const headers = montarHeaders(snap, { withJsonBody: true }) as Record<
    string,
    string
  >;
  // Historicamente usavamos pageSize=300 (mesmo do painel Angular). Mas
  // tarefas grandes (ex.: "[JEF] Analisar inicial - Pericia", 678 proc)
  // tem paginacao quebrada no servidor: pag 2+ so devolve 1 ID novo por
  // iter, nunca converge para o `total`. Solucao: pedir pageSize grande
  // o bastante para caber a tarefa inteira na primeira chamada.
  // Tamanhos menores (ex.: 100) ja foram testados e PIORAM (count=904
  // para 94 processos reais). Tamanhos grandes nao tem esse problema —
  // e quando a tarefa cabe em 1 pagina, nao ha "paginacao" a quebrar.
  const pageSize = Math.max(1, Math.min(2000, req.pageSize ?? 1000));
  const limite = Math.max(1, req.maxProcessos ?? Number.MAX_SAFE_INTEGER);
  // IMPORTANTE: o painel Angular envia `page: 0` (zero-indexed) e o
  // servidor pagina a partir dai. Com `page: 1` o servidor estava
  // entregando `count=8 entities=7` — provavel efeito colateral de
  // interpretar "1" como offset >=1 em 1-indexed, perdendo o ultimo
  // registro. Default agora alinhado ao Angular.
  let page = Math.max(0, req.page ?? 0);

  const acumulado: PJeApiProcesso[] = [];
  const idsVistos = new Set<number>();
  let total = 0;
  let duplicatasDescartadas = 0;
  let idsInvalidosDescartados = 0;
  // O endpoint tem paginacao instavel em tarefas grandes: paginas consecutivas
  // podem repetir blocos inteiros sem avancar o cursor. Em vez de depender do
  // cap de 200 iter (que gera dezenas de milhares de dupes), encerramos cedo
  // assim que a paginacao vira essencialmente improdutiva.
  //
  // "Improdutiva" = novos/pageSize <= 5% (e.g., <=15 IDs novos em pagina de
  // 300). Observamos servidor devolvendo exatamente `novos=1` por pagina em
  // tarefas grandes — isso burlava o antigo detector `novos===0`.
  const LIMIAR_NOVIDADE_RATIO = 0.05;
  const MAX_PAGINAS_IMPRODUTIVAS_SEGUIDAS = 2;
  let paginasImprodutivasSeguidas = 0;

  try {
    for (let pagCount = 0; pagCount < 200; pagCount++) {
      // Body replicado do painel Angular (observado via interceptor).
      // Enviar apenas `{page, maxResults}` faz o servidor responder
      // `count=N entities=N-1` em tarefas pequenas (reproduzido com
      // tarefa de 8 processos). Com o body completo o resultado alinha
      // com o painel nativo.
      const body = {
        numeroProcesso: '',
        // `req.classe` permite filtrar pela sigla (ex.: "APN", "PJEC")
        // — o painel Angular faz o mesmo. Quando ausente, mantém `null`
        // (comportamento histórico, traz todas as classes da tarefa).
        classe: req.classe ?? null,
        tags: [],
        tagsString: null,
        poloAtivo: null,
        poloPassivo: null,
        orgao: null,
        ordem: null,
        page,
        maxResults: pageSize,
        idTaskInstance: null,
        apelidoSessao: null,
        idTipoSessao: null,
        dataSessao: null,
        somenteFavoritas: null,
        objeto: null,
        semEtiqueta: null,
        assunto: null,
        dataAutuacao: null,
        nomeParte: null,
        nomeFiltro: null,
        numeroDocumento: null,
        competencia: '',
        relator: null,
        orgaoJulgador: null,
        somenteLembrete: null,
        somenteSigiloso: null,
        somenteLiminar: null,
        eleicao: null,
        estado: null,
        municipio: null,
        prioridadeProcesso: null,
        cpfCnpj: null,
        porEtiqueta: null,
        conferidos: null,
        orgaoJulgadorColegiado: null,
        naoLidos: null,
        tipoProcessoDocumento: null,
        somenteComTodasTags: null
      };
      const resp = await fetchTextoComTimeout(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          credentials: 'include'
        },
        45_000
      );
      if (!resp.ok) {
        return {
          ok: false,
          total,
          processos: acumulado,
          error: `HTTP ${resp.status} listando processos da tarefa "${req.nomeTarefa}"`
        };
      }
      const raw = resp.text;
      if (!raw) {
        // PJe as vezes devolve 200 com corpo vazio quando um header
        // esperado esta faltando (ex.: X-no-sso quando o fallback Basic
        // esta ativo). Diagnostico explicito em vez de JSON-parse-error.
        return {
          ok: false,
          total,
          processos: acumulado,
          error:
            `HTTP 200 com corpo vazio listando "${req.nomeTarefa}" — ` +
            `provavel rejeicao silenciosa de auth (headers enviados: ` +
            `${Object.keys(headers).join(', ')}).`
        };
      }
      const json = JSON.parse(raw) as {
        count?: number;
        entities?: ApiEntity[];
      };
      total = typeof json.count === 'number' ? json.count : total;
      const entities = Array.isArray(json.entities) ? json.entities : [];
      let novosNestaPagina = 0;
      for (const e of entities) {
        if (acumulado.length >= limite) break;
        const id = toNumberOrNull(e.idProcesso) ?? 0;
        if (id <= 0) {
          // Fallback: ainda adiciona (caminhos antigos podem depender
          // do processamento mesmo sem idProcesso valido). Apenas
          // registra para diagnostico.
          idsInvalidosDescartados += 1;
          acumulado.push(normalizarEntity(e));
          novosNestaPagina += 1;
          continue;
        }
        if (idsVistos.has(id)) {
          duplicatasDescartadas += 1;
          continue;
        }
        idsVistos.add(id);
        acumulado.push(normalizarEntity(e));
        novosNestaPagina += 1;
      }
      console.log(
        `${LOG_PREFIX} [REST] "${req.nomeTarefa}" pag ${page}: ` +
          `count=${total} entities=${entities.length} novos=${novosNestaPagina} ` +
          `acumulado=${acumulado.length} ` +
          `descartados={dup:${duplicatasDescartadas}, idInvalido:${idsInvalidosDescartados}}`
      );
      // Condicoes de parada:
      //  - entities vazio  = servidor nao tem mais nada.
      //  - acumulado >= total = ja pegamos tudo que o servidor diz existir.
      //  - acumulado >= limite = atingimos o max pedido pelo caller.
      //
      // NAO usamos `entities.length < pageSize` como "ultima pagina" porque
      // o servidor pode capar silenciosamente em pageSize maiores que 300
      // (ex.: pedir 1000 e receber 300). Nesse caso, so o acumulado/total
      // diz se acabou.
      if (
        entities.length === 0 ||
        acumulado.length >= total ||
        acumulado.length >= limite
      )
        break;
      // Safety net para paginacao instavel: se a pagina trouxe itens mas
      // quase nenhum era novo, contamos como "improdutiva". Base do ratio
      // e `entities.length` (nao `pageSize`) para tolerar ultima pagina
      // pequena legitima.
      const razaoNovos = novosNestaPagina / Math.max(1, entities.length);
      if (razaoNovos <= LIMIAR_NOVIDADE_RATIO) {
        paginasImprodutivasSeguidas += 1;
        if (paginasImprodutivasSeguidas >= MAX_PAGINAS_IMPRODUTIVAS_SEGUIDAS) {
          console.debug(
            `${LOG_PREFIX} [REST] "${req.nomeTarefa}" encerrando paginacao: ` +
              `${paginasImprodutivasSeguidas} paginas consecutivas com ` +
              `novos/entities <= ${(LIMIAR_NOVIDADE_RATIO * 100).toFixed(0)}% ` +
              `(cursor do servidor travou). Acumulado=${acumulado.length}/${total}.`
          );
          break;
        }
      } else {
        paginasImprodutivasSeguidas = 0;
      }
      page += 1;
    }
    if (total > 0 && acumulado.length < total) {
      console.debug(
        `${LOG_PREFIX} [REST] "${req.nomeTarefa}" resultado PARCIAL: ` +
          `${acumulado.length}/${total} processo(s) coletados ` +
          `(faltam ${total - acumulado.length}). Pagina instavel no servidor.`
      );
    }
    if (duplicatasDescartadas > 0 || idsInvalidosDescartados > 0) {
      console.debug(
        `${LOG_PREFIX} [REST] "${req.nomeTarefa}" encerrou com descartes: ` +
          `${duplicatasDescartadas} duplicata(s), ` +
          `${idsInvalidosDescartados} id(s) invalido(s).`
      );
    }
    return { ok: true, total, processos: acumulado };
  } catch (err) {
    return {
      ok: false,
      total,
      processos: acumulado,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Resolve a chave de acesso (`ca`) para um processo.
 *
 * Rodando same-origin (content script em `pje1g.trf5.jus.br`), o cookie
 * de sessao real (JSESSIONID etc.) e anexado pelo navegador, o PJe
 * reconhece a origem e devolve a string hex esperada.
 */
export async function gerarChaveAcesso(
  idProcesso: number
): Promise<PJeApiResolveCaResponse> {
  let snap = await obterSnapshot();
  if (!snap) {
    return { ok: false, ca: null, error: 'Sem snapshot de auth.' };
  }
  if (!Number.isFinite(idProcesso) || idProcesso <= 0) {
    return { ok: false, ca: null, error: 'idProcesso invalido.' };
  }
  const baseUrl = pjeBaseUrl(snap);
  const url = `${baseUrl}/painelUsuario/gerarChaveAcessoProcesso/${idProcesso}`;
  let headers = montarHeaders(snap);
  // Single-shot: so tentamos silent refresh uma vez por chamada. Se o 403
  // persistir, e sinal de causa nao relacionada a Bearer (JSESSIONID, auth
  // de recurso, etc) — o diag em storage.local vai mostrar os detalhes.
  let tentouRefresh403 = false;
  try {
    return await comRetryTransiente(async () => {
      let resp = await fetchTextoComTimeout(
        url,
        { method: 'GET', headers, credentials: 'include' },
        20_000
      );
      if (resp.status === 403 && !tentouRefresh403 && snap) {
        tentouRefresh403 = true;
        const r = await diagnosticarERefrescar403(
          snap,
          url,
          resp.status,
          resp.text
        );
        if (r.refreshOk) {
          const novo = await obterSnapshot();
          if (novo && novo.authorization !== snap.authorization) {
            snap = novo;
            headers = montarHeaders(snap);
            resp = await fetchTextoComTimeout(
              url,
              { method: 'GET', headers, credentials: 'include' },
              20_000
            );
          }
        }
      }
      if (!resp.ok) {
        return {
          resultado: {
            ok: false,
            ca: null,
            error: `HTTP ${resp.status}`
          } as PJeApiResolveCaResponse,
          httpStatus: resp.status,
          transiente: eErroTransiente(null, resp.status)
        };
      }
      const text = resp.text.trim();
      let ca: string;
      try {
        const parsed: unknown = JSON.parse(text);
        ca = typeof parsed === 'string' ? parsed : text;
      } catch {
        ca = text.replace(/^"|"$/g, '');
      }
      if (!ca) {
        return {
          resultado: {
            ok: false,
            ca: null,
            error: `Resposta vazia ou inesperada (Content-Type: ${
              resp.contentType ?? '?'
            }, len ${text.length}).`
          } as PJeApiResolveCaResponse
        };
      }
      return { resultado: { ok: true, ca } as PJeApiResolveCaResponse };
    }, { tentativas: 2 });
    // Retry agressivo (4 tentativas com backoff exponencial) foi reduzido
    // para 2 porque em varreduras grandes o servidor PJe pode retornar
    // transiente em ondas — cada worker travado 90s impedia o pool de
    // avancar. 2 tentativas (1+20s base) cobrem falha pontual sem
    // penalizar o throughput.
  } catch (err) {
    return {
      ok: false,
      ca: null,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Helper: monta a URL do legacy para abrir os autos digitais com
 * `idProcesso + ca + idTaskInstance`. Ja resolve a `ca` chamando
 * `gerarChaveAcesso` quando nao for fornecida.
 */
export async function montarUrlAutos(opts: {
  legacyOrigin: string;
  idProcesso: number;
  idTaskInstance: number | null;
  ca?: string | null;
}): Promise<{ ok: boolean; url?: string; error?: string }> {
  let ca = opts.ca ?? null;
  if (!ca) {
    const r = await gerarChaveAcesso(opts.idProcesso);
    if (!r.ok || !r.ca) {
      return {
        ok: false,
        error: r.error ?? 'Nao foi possivel resolver a chave de acesso.'
      };
    }
    ca = r.ca;
  }
  const params = new URLSearchParams();
  params.set('idProcesso', String(opts.idProcesso));
  params.set('ca', ca);
  if (opts.idTaskInstance != null) {
    params.set('idTaskInstance', String(opts.idTaskInstance));
  }
  const url = `${opts.legacyOrigin.replace(/\/+$/, '')}/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam?${params.toString()}`;
  return { ok: true, url };
}

function normalizarEtiquetaRaw(raw: PJeApiEtiquetaRaw): PJeApiEtiqueta {
  const id = toNumberOrNull(raw.id) ?? 0;
  return {
    id,
    nomeTag: typeof raw.nomeTag === 'string' ? raw.nomeTag.trim() : '',
    nomeTagCompleto:
      typeof raw.nomeTagCompleto === 'string' && raw.nomeTagCompleto.trim()
        ? raw.nomeTagCompleto.trim()
        : typeof raw.nomeTag === 'string'
          ? raw.nomeTag.trim()
          : '',
    favorita: raw.favorita === true,
    possuiFilhos: raw.possuiFilhos === true,
    idTagFavorita: toNumberOrNull(raw.idTagFavorita)
  };
}

/**
 * Lista o catálogo completo de etiquetas disponíveis ao usuário autenticado.
 *
 * Estratégia: fazer UMA chamada com `maxResults` grande o suficiente para
 * caber todo o catálogo. O endpoint legacy do PJe tem paginação instável —
 * pedindo `maxResults` pequeno, páginas seguintes repetem blocos ou trazem
 * poucos IDs novos por iteração e nunca convergem para o `count`. Mesmo
 * problema documentado em `listarProcessosDaTarefa` ("Tamanhos menores ja
 * foram testados e PIORAM"). Como o count observado é da ordem de 3k, um
 * primeiro disparo com `maxResults` grande geralmente cabe tudo em uma
 * resposta e elimina a paginação. Se ainda faltar, continuamos paginando,
 * mas com detecção de páginas improdutivas para não girar no vazio.
 *
 * O `count` do servidor pode somar sub-itens (árvore de tags) maior do
 * que os `entities` únicos retornados — nesse caso devolvemos o que
 * conseguimos coletar como sucesso parcial.
 */
export async function listarEtiquetas(opts?: {
  pageSize?: number;
  onProgress?: (processed: number, total: number) => void;
}): Promise<PJeApiEtiquetasListResponse> {
  const snap = await obterSnapshot();
  if (!snap) {
    const msg =
      'Sem snapshot de auth — abra o painel do PJe e clique em qualquer tarefa para capturar.';
    console.warn(`${LOG_PREFIX} [REST] listarEtiquetas: ${msg}`);
    return { ok: false, total: 0, etiquetas: [], error: msg };
  }
  const baseUrl = pjeBaseUrl(snap);
  const url = `${baseUrl}/painelUsuario/etiquetas`;
  const headers = montarHeaders(snap, { withJsonBody: true }) as Record<
    string,
    string
  >;
  // Default agora é 5000 — cobre um catálogo grande (3k+) em um único
  // disparo. O servidor costuma silenciosamente capar em 500/1000; quando
  // capa, detectamos via `entities.length < pageSize` e tentamos paginação
  // convencional como fallback.
  const pageSize = Math.max(1, Math.min(10_000, opts?.pageSize ?? 5000));
  const MAX_PAGINAS = 60;
  const LIMIAR_NOVIDADE_RATIO = 0.05;
  const MAX_PAGINAS_IMPRODUTIVAS_SEGUIDAS = 2;

  const acumulado: PJeApiEtiqueta[] = [];
  const idsVistos = new Set<number>();
  let total = 0;
  let page = 0;
  let paginasImprodutivasSeguidas = 0;

  try {
    for (let pagCount = 0; pagCount < MAX_PAGINAS; pagCount++) {
      const body = {
        page,
        maxResults: pageSize,
        tagsString: null,
        somenteFavoritas: null
      };
      const resp = await fetchTextoComTimeout(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          credentials: 'include'
        },
        60_000
      );
      if (!resp.ok) {
        return {
          ok: false,
          total,
          etiquetas: acumulado,
          error: `HTTP ${resp.status} listando etiquetas`
        };
      }
      const raw = resp.text;
      if (!raw) {
        return {
          ok: false,
          total,
          etiquetas: acumulado,
          error:
            `HTTP 200 com corpo vazio listando etiquetas — provável ` +
            `rejeição silenciosa de auth (headers: ${Object.keys(headers).join(', ')}).`
        };
      }
      const json = JSON.parse(raw) as {
        count?: number;
        entities?: PJeApiEtiquetaRaw[];
      };
      total = typeof json.count === 'number' ? json.count : total;
      const entities = Array.isArray(json.entities) ? json.entities : [];
      let novos = 0;
      for (const e of entities) {
        const norm = normalizarEtiquetaRaw(e);
        if (norm.id <= 0 || !norm.nomeTag) continue;
        if (idsVistos.has(norm.id)) continue;
        idsVistos.add(norm.id);
        acumulado.push(norm);
        novos += 1;
      }
      opts?.onProgress?.(acumulado.length, total);
      console.log(
        `${LOG_PREFIX} [REST] etiquetas pag ${page}: ` +
          `count=${total} entities=${entities.length} novos=${novos} ` +
          `acumulado=${acumulado.length} (pageSize=${pageSize})`
      );
      // Condições de parada:
      //  - `entities` vazio: servidor não tem mais o que devolver.
      //  - `acumulado >= total`: já cobrimos o total reportado.
      if (entities.length === 0 || acumulado.length >= total) break;
      // Safety net: páginas consecutivas quase sem IDs novos indicam cursor
      // travado no servidor (mesmo padrão observado em tarefas grandes).
      const razaoNovos = novos / Math.max(1, entities.length);
      if (razaoNovos <= LIMIAR_NOVIDADE_RATIO) {
        paginasImprodutivasSeguidas += 1;
        if (paginasImprodutivasSeguidas >= MAX_PAGINAS_IMPRODUTIVAS_SEGUIDAS) {
          console.debug(
            `${LOG_PREFIX} [REST] etiquetas: encerrando paginação — ` +
              `${paginasImprodutivasSeguidas} páginas com ≤${(LIMIAR_NOVIDADE_RATIO * 100).toFixed(0)}% de IDs novos. ` +
              `Acumulado=${acumulado.length}/${total}.`
          );
          break;
        }
      } else {
        paginasImprodutivasSeguidas = 0;
      }
      page += 1;
    }
    return { ok: true, total, etiquetas: acumulado };
  } catch (err) {
    return {
      ok: false,
      total,
      etiquetas: acumulado,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
