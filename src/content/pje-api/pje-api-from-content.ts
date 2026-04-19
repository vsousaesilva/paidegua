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
  PJeApiListarRequest,
  PJeApiListarResponse,
  PJeApiProcesso,
  PJeApiResolveCaResponse,
  PJeAuthSnapshot
} from '../../shared/types';

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
 * `fetch` com timeout duro via AbortController. Sem isso, o navegador
 * mantem uma chamada suspensa indefinidamente quando a conexao e aceita
 * pelo servidor mas a resposta nunca chega (ex.: PJe sob estresse em
 * varreduras de 300+ processos). Um worker pendurado bloqueia sua slot
 * do pool de concorrencia e o pipeline parece "travar".
 */
async function fetchComTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs
  );
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
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
    return extrairTexto(o.descricao ?? o.nome);
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
  // 300 e o tamanho que o painel nativo do PJe usa. Tamanhos menores
  // (ex.: 100) fazem o servidor reordenar/repetir entre paginas — vimos
  // count=904 para uma tarefa com 94 processos reais e acumulado
  // estourando 1000. Alinhar com o painel estabiliza a paginacao.
  const pageSize = Math.max(1, Math.min(500, req.pageSize ?? 300));
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

  try {
    for (let pagCount = 0; pagCount < 200; pagCount++) {
      // Body replicado do painel Angular (observado via interceptor).
      // Enviar apenas `{page, maxResults}` faz o servidor responder
      // `count=N entities=N-1` em tarefas pequenas (reproduzido com
      // tarefa de 8 processos). Com o body completo o resultado alinha
      // com o painel nativo.
      const body = {
        numeroProcesso: '',
        classe: null,
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
      const resp = await fetchComTimeout(
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
      const raw = await resp.text();
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
      if (
        entities.length < pageSize ||
        acumulado.length >= total ||
        acumulado.length >= limite
      )
        break;
      page += 1;
    }
    if (duplicatasDescartadas > 0 || idsInvalidosDescartados > 0) {
      console.warn(
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
  const snap = await obterSnapshot();
  if (!snap) {
    return { ok: false, ca: null, error: 'Sem snapshot de auth.' };
  }
  if (!Number.isFinite(idProcesso) || idProcesso <= 0) {
    return { ok: false, ca: null, error: 'idProcesso invalido.' };
  }
  const baseUrl = pjeBaseUrl(snap);
  const url = `${baseUrl}/painelUsuario/gerarChaveAcessoProcesso/${idProcesso}`;
  const headers = montarHeaders(snap);
  try {
    return await comRetryTransiente(async () => {
      const resp = await fetchComTimeout(
        url,
        { method: 'GET', headers, credentials: 'include' },
        20_000
      );
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
      const text = (await resp.text()).trim();
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
              resp.headers.get('content-type') ?? '?'
            }, len ${text.length}).`
          } as PJeApiResolveCaResponse
        };
      }
      return { resultado: { ok: true, ca } as PJeApiResolveCaResponse };
    });
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
