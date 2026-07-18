/**
 * Cliente da Júlia autenticada (`julia.trf5.jus.br`) — inclui o 1º grau.
 *
 * Contratos em `docs/extracao-julia-trf5.md` §5. Complementa
 * `julia-client.ts` (API pública, só 2º grau/TR/TRU) e devolve o mesmo
 * `JuliaDocumento`, para que a interface e o grounding não precisem saber de
 * qual API o resultado veio.
 *
 * ## Onde este código roda
 *
 * No **service worker**, igual ao cliente público.
 *
 * Isso foi verificado, não presumido. O `JSESSIONID` da Júlia tem `SameSite`
 * ausente — que o Chrome trata como `Lax` — e `Path=/julia`, o que sugeria que
 * só uma aba em `*.jus.br` conseguiria carregá-lo. Teste direto do service
 * worker em 18/07/2026 devolveu 200 e JSON: requisição iniciada por extensão
 * com `host_permissions` não sofre a restrição `SameSite` aplicada a página
 * comum.
 *
 * Consequência: os painéis (`chrome-extension://`) chamam direto, sem
 * encaminhar por content script e sem depender de aba do PJe aberta.
 *
 * Nenhuma credencial é armazenada — a sessão é a que o usuário já abriu no
 * navegador. Mas o cookie é **de sessão** (`Expires: Session`): morre ao fechar
 * o Chrome, e sobrevive entre dias apenas quando a restauração de sessão está
 * ligada. Tratar `JuliaSessaoExpiradaError` como caminho comum, não excepcional.
 *
 * ## Quatro diferenças em relação à API pública que este módulo encapsula
 *
 *   1. **Eixos separados.** `orgao` + `instancia` como parâmetros, não um
 *      segmento composto no caminho. `instancia=G1` é o 1º grau comum.
 *   2. **Dois envelopes.** Os `*:dt` devolvem forma DataTables; os demais
 *      devolvem `{status, httpStatus, mensagem, resultado}`.
 *   3. **Dois prefixos de caminho.** Observado: `:dt` e vocabulário em
 *      `/api/v1/…`, inteiro teor em `/julia/api/v1/…`. Ambos respondem 200.
 *      Replicamos o que foi capturado por endpoint em vez de presumir base
 *      única — presumir daria 404 em metade das chamadas.
 *   4. **A busca devolve trecho, não documento.** ~500 chars com realce, contra
 *      6 mil do inteiro teor. Texto completo exige `obterInteiroTeor()`.
 */

import { LOG_PREFIX } from '../constants';
import { chaveDeduplicacao } from './julia-identificador';
import {
  extrairEmenta,
  formatarNumeroProcesso,
  realceSeguroHtml,
  removerRealce,
  dataIsoParaJulia,
  JULIA_PAGE_SIZE_PADRAO,
  JuliaApiError
} from './julia-client';
import type {
  JuliaDocumento,
  JuliaInstanciaAutenticada,
  JuliaOrgao,
  JuliaResultado,
  JuliaTipoDocumentoFiltro
} from './julia-types';

const HOST = 'https://julia.trf5.jus.br';

/**
 * Base única, sob `/julia`.
 *
 * O cookie `JSESSIONID` tem **`Path=/julia`** (capturado em 18/07/2026), então
 * requisição para a raiz (`/api/v1/…`) sai **sem sessão** — o servidor responde
 * 503 com HTML. Todo endpoint tem de ficar sob este prefixo.
 *
 * Uma versão anterior deste arquivo tinha duas bases, por causa de um erro no
 * coletor de captura: ele resolvia URL relativa contra `location.origin` em vez
 * de `location.href`, e registrava `/api/v1/…` onde a chamada real fora
 * `/julia/api/v1/…`. Não há prefixo inconsistente na API.
 */
const BASE_API = `${HOST}/julia/api/v1`;

// ── Erros de sessão ──────────────────────────────────────────────

export class JuliaSessaoExpiradaError extends Error {
  constructor() {
    super(
      'Sessão da Júlia expirada ou ausente. Abra julia.trf5.jus.br, faça login e tente novamente.'
    );
    this.name = 'JuliaSessaoExpiradaError';
  }
}

// ── Filtros ──────────────────────────────────────────────────────

export interface JuliaFiltrosAutenticado {
  orgao: JuliaOrgao;
  instancia: JuliaInstanciaAutenticada;
  /** Termo livre (na API pública o parâmetro se chama `pesquisaLivre`). */
  termo?: string;
  /** String literal do órgão julgador, ex.: "35ª VARA FEDERAL CE". */
  orgaoJulgador?: string;
  relator?: string;
  tarefa?: string;
  assinador?: string;
  classeJudicial?: string;
  /** ISO `yyyy-MM-dd` — convertido para `dd/MM/yyyy` na saída. */
  dataInicial?: string;
  dataFinal?: string;
  /** Números de tema separados por vírgula. */
  tema?: string;
  todosOsTemas?: boolean;
  localizacao?: string;
  tiposDocumento?: readonly JuliaTipoDocumentoFiltro[];
  numeroProcesso?: string;
  numeroDocumento?: string;
  start?: number;
  length?: number;
}

// ── Formas brutas ────────────────────────────────────────────────

interface EnvelopeResultado<T> {
  status: string;
  httpStatus: number;
  mensagem: string;
  resultado: T;
}

interface EnvelopeDataTables<T> {
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
  data: T[];
  error: string | null;
  message: string | null;
}

interface DocumentoAutenticadoBruto {
  idDocumento: number;
  idBinario: number;
  tipo: { descricao: string | null } | null;
  formato: string | null;
  numero: string | null;
  texto: string | null;
  url: string | null;
  nomeAssinatura: string | null;
  dataAssinatura: string | null;
  sigiloso: boolean | null;
  publico: boolean | null;
  score: number | null;
  processo: {
    orgao: string | null;
    instancia: string | null;
    sistema: string | null;
    numeroUnico: string | null;
    sigiloso: boolean | null;
    orgaoJulgador: { descricao: string | null } | null;
    nomeMagistrado: string | null;
    classeJudicial: { codigoCnj: string | null; descricao: string | null } | null;
    url: string | null;
    identificador: string | null;
  } | null;
  identificador: string;
}

// ── Montagem da query ────────────────────────────────────────────

/**
 * O separador de `tiposDocumento` é `#`, mas o **sufixo varia por endpoint**:
 * `sumario:dt` foi capturado com `#` final, `documentos:dt` sem. Montamos
 * conforme o destino em vez de normalizar — um dos dois pode gerar item vazio
 * ao dar `split('#')` e filtrar por tipo inexistente, devolvendo zero
 * resultados sem erro.
 */
function montarTiposDocumento(
  tipos: readonly string[] | undefined,
  comSufixo: boolean
): string {
  if (!tipos?.length) return '';
  return tipos.join('#') + (comSufixo ? '#' : '');
}

function montarQuery(
  f: JuliaFiltrosAutenticado,
  opcoes: { colunaOrdenacao: string; sufixoTipos: boolean }
): URLSearchParams {
  const start = Math.max(0, f.start ?? 0);
  const length = Math.max(1, f.length ?? JULIA_PAGE_SIZE_PADRAO);

  const p = new URLSearchParams({
    draw: '1',
    'columns[0][data]': opcoes.colunaOrdenacao,
    'columns[0][name]': '',
    'columns[0][searchable]': 'true',
    'columns[0][orderable]': 'false',
    'columns[0][search][value]': '',
    'columns[0][search][regex]': 'false',
    start: String(start),
    length: String(length),
    'search[value]': '',
    'search[regex]': 'false',
    termo: f.termo?.trim() ?? '',
    orgaoJulgador: f.orgaoJulgador?.trim() ?? '',
    relator: f.relator?.trim() ?? '',
    tarefa: f.tarefa?.trim() ?? '',
    assinador: f.assinador?.trim() ?? '',
    classeJudicial: f.classeJudicial?.trim() ?? '',
    dataInicial: f.dataInicial ? dataIsoParaJulia(f.dataInicial) : '',
    dataFinal: f.dataFinal ? dataIsoParaJulia(f.dataFinal) : '',
    tema: f.tema?.trim() ?? '',
    todosOsTemas: String(f.todosOsTemas ?? true),
    localizacao: f.localizacao?.trim() ?? '',
    tiposDocumento: montarTiposDocumento(f.tiposDocumento, opcoes.sufixoTipos),
    numeroProcesso: f.numeroProcesso?.replace(/\D/g, '') ?? '',
    numeroDocumento: f.numeroDocumento?.trim() ?? '',
    orgao: f.orgao,
    instancia: f.instancia
  });
  p.set('_', String(Date.now()));
  return p;
}

// ── Transporte ───────────────────────────────────────────────────

/**
 * `credentials: 'include'` leva o cookie de sessão do próprio navegador —
 * nenhuma credencial é armazenada pela extensão.
 *
 * A Júlia responde a sessão ausente com redirect para a tela de login, o que o
 * `fetch` segue de forma transparente e entrega HTML com status 200. Por isso
 * a detecção de sessão é pelo **content-type**, não pelo status: confiar no
 * status daria "JSON inválido" como diagnóstico de um problema de login.
 */
async function pedirJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      signal
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new JuliaApiError(`Falha de rede ao consultar a Júlia: ${String(err)}`, null, url);
  }

  if (r.status === 401 || r.status === 403) throw new JuliaSessaoExpiradaError();

  const tipo = r.headers.get('content-type') ?? '';
  if (!/json/i.test(tipo)) {
    if (/html/i.test(tipo)) throw new JuliaSessaoExpiradaError();
    throw new JuliaApiError(`Resposta não-JSON da Júlia (${tipo || 'sem tipo'}).`, r.status, url);
  }
  if (!r.ok) throw new JuliaApiError(`JULIA respondeu HTTP ${r.status}.`, r.status, url);

  try {
    return (await r.json()) as T;
  } catch (err) {
    throw new JuliaApiError(`JSON inválido da Júlia: ${String(err)}`, r.status, url);
  }
}

// ── Adaptação para a forma comum ─────────────────────────────────

/**
 * Converte a forma aninhada da API autenticada no `JuliaDocumento` comum.
 *
 * `textoCompleto` distingue o trecho de busca do inteiro teor — sem isso o
 * grounding montaria prompt com 500 caracteres de snippet achando que tem o
 * documento, e o modelo responderia sobre um recorte arbitrário.
 */
function adaptar(
  b: DocumentoAutenticadoBruto,
  opcoes: { textoCompleto: boolean }
): JuliaDocumento {
  const original = b.texto ?? '';
  const limpo = removerRealce(original);
  const { ementa, foiRecortada } = extrairEmenta(limpo);
  const numero = b.processo?.numeroUnico ?? null;

  return {
    codigoDocumento: b.identificador,
    sistema: b.processo?.sistema ?? null,
    instancia: b.processo?.instancia ?? null,
    orgao: b.processo?.orgao ?? null,
    tipoDocumento: b.tipo?.descricao ?? null,
    numeroProcesso: numero,
    numeroProcessoFormatado: formatarNumeroProcesso(numero),
    classeJudicial: b.processo?.classeJudicial?.descricao ?? null,
    relator: b.processo?.nomeMagistrado ?? null,
    orgaoJulgador: b.processo?.orgaoJulgador?.descricao ?? null,
    // A autenticada não tem data de julgamento; a de assinatura vem com hora.
    dataJulgamento: null,
    dataAssinatura: b.dataAssinatura ?? null,
    texto: limpo,
    ementa,
    ementaFoiRecortada: foiRecortada,
    resumo: null,
    textoRealcadoHtml: realceSeguroHtml(original),
    origem: 'autenticada',
    sigiloso: b.sigiloso ?? undefined,
    publico: b.publico ?? undefined,
    textoCompleto: opcoes.textoCompleto,
    urlPje: b.url ?? null,
    nomeAssinatura: b.nomeAssinatura ?? null,
    score: b.score ?? null
  };
}

/**
 * Descarta o que estiver sob segredo, no documento ou no processo.
 *
 * Aplicado **por padrão**, e não como opção do chamador: o acervo autenticado
 * inclui material sigiloso, e a decisão de expô-lo não deve depender de alguém
 * lembrar de passar uma flag. Ter acesso pela sessão não é autorização para
 * reprocessar, exibir em painel ou enviar a provedor de IA externo.
 */
function filtrarSigilosos(itens: DocumentoAutenticadoBruto[]): {
  publicos: DocumentoAutenticadoBruto[];
  removidos: number;
} {
  const publicos = itens.filter(
    (i) => i.sigiloso !== true && i.processo?.sigiloso !== true
  );
  return { publicos, removidos: itens.length - publicos.length };
}

function deduplicar(itens: DocumentoAutenticadoBruto[]): {
  unicos: DocumentoAutenticadoBruto[];
  removidas: number;
} {
  const vistos = new Set<string>();
  const unicos: DocumentoAutenticadoBruto[] = [];
  for (const item of itens) {
    const chave = chaveDeduplicacao(item.identificador);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    unicos.push(item);
  }
  return { unicos, removidas: itens.length - unicos.length };
}

// ── Operações ────────────────────────────────────────────────────

export interface JuliaResultadoAutenticado extends JuliaResultado {
  /** Quantos itens a busca descartou por sigilo. Exibir ao usuário. */
  sigilososRemovidos: number;
}

/**
 * Busca documentos. O `texto` de cada resultado é **trecho**; use
 * `obterInteiroTeor()` para o documento completo.
 */
export async function buscarDocumentos(
  filtros: JuliaFiltrosAutenticado,
  opcoes: { signal?: AbortSignal } = {}
): Promise<JuliaResultadoAutenticado> {
  const start = Math.max(0, filtros.start ?? 0);
  const length = Math.max(1, filtros.length ?? JULIA_PAGE_SIZE_PADRAO);
  const query = montarQuery(
    { ...filtros, start, length },
    { colunaOrdenacao: 'processo.numero', sufixoTipos: false }
  );

  const env = await pedirJson<EnvelopeDataTables<DocumentoAutenticadoBruto>>(
    `${BASE_API}/documentos:dt?${query}`,
    opcoes.signal
  );

  const itens = Array.isArray(env.data) ? env.data : [];
  const { publicos, removidos } = filtrarSigilosos(itens);
  const { unicos, removidas } = deduplicar(publicos);

  if (removidos > 0) {
    console.debug(`${LOG_PREFIX} julia-autenticado: ${removidos} documento(s) sigiloso(s) descartado(s).`);
  }

  const total = env.recordsTotal ?? 0;
  return {
    documentos: unicos.map((b) => adaptar(b, { textoCompleto: false })),
    total,
    // Não confirmado se o teto de 10.000 da API pública vale aqui; a checagem é
    // barata e falha para o lado conservador.
    totalEhTeto: total >= 10_000,
    start,
    length,
    duplicatasRemovidas: removidas,
    sigilososRemovidos: removidos,
    temMais: start + length < total && unicos.length > 0
  };
}

/**
 * Busca o inteiro teor pelo identificador composto.
 *
 * A chave é o identificador **inteiro** (`JFCE:JEF:PJE_NACIONAL:…:…:…`), com os
 * dois-pontos no caminho — não `idDocumento` nem `idBinario`, embora ambos
 * estejam no payload como candidatos plausíveis.
 *
 * @returns `null` quando o documento é sigiloso — inteiro teor sob segredo não
 *   é entregue nem ao chamador que pediu explicitamente.
 */
export async function obterInteiroTeor(
  identificador: string,
  opcoes: { signal?: AbortSignal } = {}
): Promise<JuliaDocumento | null> {
  // `encodeURIComponent` escaparia os `:`, que o servidor espera literais.
  const env = await pedirJson<EnvelopeResultado<DocumentoAutenticadoBruto>>(
    `${BASE_API}/documentos/${identificador}`,
    opcoes.signal
  );
  const b = env.resultado;
  if (!b) return null;
  if (b.sigiloso === true || b.processo?.sigiloso === true) {
    console.debug(`${LOG_PREFIX} julia-autenticado: inteiro teor sigiloso recusado.`);
    return null;
  }
  return adaptar(b, { textoCompleto: true });
}

/** Órgãos julgadores da unidade — específicos por `orgao` + `instancia`. */
export async function listarOrgaosJulgadores(
  orgao: JuliaOrgao,
  instancia: JuliaInstanciaAutenticada,
  opcoes: { signal?: AbortSignal } = {}
): Promise<string[]> {
  const env = await pedirJson<EnvelopeResultado<string[]>>(
    `${BASE_API}/orgaos-julgadores?orgao=${orgao}&instancia=${instancia}`,
    opcoes.signal
  );
  return Array.isArray(env.resultado) ? env.resultado : [];
}

/**
 * Data da última carga do índice, **por unidade**.
 *
 * O índice é atualizado em lote e ficava ~6 dias atrás na observação de
 * 18/07/2026. Exibir sempre: sem isso, decisão recente que não aparece é
 * reportada como bug da extensão.
 */
export async function obterDataAtualizacao(
  orgao: JuliaOrgao,
  instancia: JuliaInstanciaAutenticada,
  opcoes: { signal?: AbortSignal } = {}
): Promise<string | null> {
  const env = await pedirJson<EnvelopeResultado<string>>(
    `${BASE_API}/processos:data-atualizacao?orgao=${orgao}&instancia=${instancia}`,
    opcoes.signal
  );
  return env.resultado ?? null;
}

/** Contagem por tipo de documento, sem puxar resultados. */
export async function obterSumario(
  filtros: JuliaFiltrosAutenticado,
  opcoes: { signal?: AbortSignal } = {}
): Promise<Array<{ descricao: string; quantidade: number }>> {
  const query = montarQuery(filtros, {
    colunaOrdenacao: 'descricao',
    sufixoTipos: true
  });
  const env = await pedirJson<
    EnvelopeDataTables<{ descricao: string; quantidade: number }>
  >(`${BASE_API}/sumario:dt?${query}`, opcoes.signal);
  return Array.isArray(env.data) ? env.data : [];
}

/**
 * Sessão viva? Usa o endpoint mais barato conhecido.
 *
 * Sem valor padrão de propósito: um `orgao` implícito faria a verificação
 * consultar uma seccional que não é a do usuário.
 */
export async function verificarSessao(
  orgao: JuliaOrgao,
  instancia: JuliaInstanciaAutenticada
): Promise<boolean> {
  try {
    await obterDataAtualizacao(orgao, instancia);
    return true;
  } catch (err) {
    if (err instanceof JuliaSessaoExpiradaError) return false;
    throw err;
  }
}
