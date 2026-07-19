/**
 * Cliente da API pública de jurisprudência da Júlia (TRF5).
 *
 *   GET https://juliapesquisa.trf5.jus.br/julia-pesquisa/api/v1/documento:dt/{instancia}
 *
 * **Não exige autenticação.** Verificado em 18/07/2026 a partir de cliente
 * anônimo, sem cookie, sem `referer` e sem `x-requested-with`. Não há sessão,
 * credencial ou cookie a gerenciar — ver `docs/extracao-julia-trf5.md` §1.
 *
 * ## Onde este código roda
 *
 * No **service worker**, não no content script. A API é de outra origem que a
 * do PJe, e em MV3 o content script não herda a isenção de CORS das
 * `host_permissions` — o background herda. Como não há cookie a carregar, não
 * se perde nada com isso (o inverso do que vale para o PJe, cujas chamadas
 * precisam da sessão e por isso ficam no content — ver `pje-api-criminal.ts`).
 *
 * `https://*.jus.br/*` já está em `host_permissions`; nenhuma permissão nova.
 *
 * ## Armadilhas do protocolo que este cliente encapsula
 *
 * O endpoint fala *DataTables server-side*, e três detalhes dele geram bug
 * silencioso se tratados de forma ingênua:
 *
 *   1. **O bloco `columns[0][...]` é obrigatório.** Omiti-lo devolve 400,
 *      mesmo com `{instancia}` válida. Não é enfeite do jQuery.
 *   2. **`recordsTotal` satura em 10.000** — teto de janela de resultados do
 *      backend de busca, não contagem real. Paginar além disso falha.
 *   3. **A resposta pode repetir `codigoDocumento`.** Observado em `TR_CE`:
 *      dois itens byte-idênticos na mesma página.
 */

import { LOG_PREFIX } from '../constants';
import { chaveDeduplicacao } from './julia-identificador';
import {
  type JuliaDocumento,
  type JuliaDocumentoBruto,
  type JuliaFiltros,
  type JuliaRespostaBruta,
  type JuliaResultado
} from './julia-types';

const JULIA_BASE_URL =
  'https://juliapesquisa.trf5.jus.br/julia-pesquisa/api/v1/documento:dt';

/**
 * Teto de janela de resultados do backend de busca. `recordsTotal` satura
 * exatamente neste valor e a paginação além dele tende a devolver erro em vez
 * de página vazia.
 */
export const JULIA_MAX_RESULT_WINDOW = 10_000;

/** Tamanho de página usado pela interface oficial. */
export const JULIA_PAGE_SIZE_PADRAO = 10;

export class JuliaApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string
  ) {
    super(message);
    this.name = 'JuliaApiError';
  }
}

// ── Datas ────────────────────────────────────────────────────────

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * ISO `yyyy-MM-dd` → `dd/MM/yyyy`, formato que a API exige na entrada.
 *
 * Feito por manipulação de string, deliberadamente: `new Date('2026-01-31')`
 * interpreta como UTC e, em fuso negativo (BRT), `getDate()` devolve o dia
 * anterior. Data de virada de mês viraria bug de um dia.
 */
export function dataIsoParaJulia(iso: string): string {
  const m = ISO_DATE_REGEX.exec(iso.trim());
  if (!m) {
    throw new RangeError(`Data fora do formato ISO yyyy-MM-dd: "${iso}"`);
  }
  const [, ano, mes, dia] = m;
  return `${dia}/${mes}/${ano}`;
}

// ── Texto ────────────────────────────────────────────────────────

const TAG_REALCE_REGEX = /<\/?em>/gi;

/**
 * Remove as tags `<em>` que a API insere nos termos buscados.
 *
 * Sempre aplicar antes de mandar texto ao LLM: sem isso o modelo lê a marcação
 * como conteúdo do acórdão. Remove apenas `<em>`/`</em>` — nada mais foi
 * observado, e um strip genérico de `<...>` mutilaria texto jurídico legítimo.
 */
export function removerRealce(texto: string): string {
  return texto.replace(TAG_REALCE_REGEX, '');
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/**
 * Escapa o texto integralmente e depois restaura só os `<em>` de realce.
 *
 * É o único caminho seguro para exibir o realce da busca: o `texto` da API é
 * conteúdo de terceiro e não pode ir cru para `innerHTML`.
 */
export function realceSeguroHtml(texto: string): string {
  return texto
    .replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)
    .replace(/&lt;em&gt;/gi, '<em>')
    .replace(/&lt;\/em&gt;/gi, '</em>');
}

/** Início das seções que sucedem a ementa num acórdão. */
const MARCADOR_POS_EMENTA = /\b(RELAT[ÓO]RIO|VOTO(?:\s+VENCEDOR)?)\b/i;

/**
 * Recorta a seção EMENTA do texto integral.
 *
 * Necessário porque o volume varia por instância: em `G2` o `tipoDocumento`
 * `EMENTA` já vem enxuto, mas em `TR` o `ACORDAO` traz ementa + relatório +
 * voto + acórdão, com cabeçalhos repetidos, passando de 15 mil caracteres.
 * Cinco desses num prompt estouram contexto e custo.
 *
 * Heurística: corta no primeiro marcador de seção posterior e retrocede até a
 * última ocorrência de "EMENTA" antes dele — os acórdãos observados repetem o
 * cabeçalho do órgão entre o título "EMENTA" e a ementa propriamente dita.
 *
 * **Falha para o lado seguro:** sem marcadores reconhecíveis, devolve o texto
 * inteiro com `foiRecortada: false`. Nunca devolve fragmento vazio.
 */
export function extrairEmenta(texto: string): {
  ementa: string;
  foiRecortada: boolean;
} {
  const fim = MARCADOR_POS_EMENTA.exec(texto);
  if (!fim || fim.index <= 0) {
    return { ementa: texto, foiRecortada: false };
  }

  const antes = texto.slice(0, fim.index);
  // Regex com /g construída aqui dentro, e não no escopo do módulo: `lastIndex`
  // é estado mutável, e uma instância compartilhada faria chamadas sucessivas
  // interferirem umas nas outras.
  const marcadorEmenta = /\bEMENTA\b/gi;
  let inicio = -1;
  for (let m = marcadorEmenta.exec(antes); m; m = marcadorEmenta.exec(antes)) {
    inicio = m.index + m[0].length;
  }
  if (inicio < 0) {
    return { ementa: texto, foiRecortada: false };
  }

  const recorte = antes.slice(inicio).replace(/^[\s:.-]+/, '').trim();
  if (!recorte) {
    return { ementa: texto, foiRecortada: false };
  }
  return { ementa: recorte, foiRecortada: true };
}

// ── Número de processo ───────────────────────────────────────────

/** 20 dígitos → máscara CNJ `NNNNNNN-DD.AAAA.J.TR.OOOO`. */
export function formatarNumeroProcesso(numero: string | null): string | null {
  if (!numero) return null;
  const d = numero.replace(/\D/g, '');
  if (d.length !== 20) return null;
  return `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16)}`;
}

// ── Montagem da query ────────────────────────────────────────────

/**
 * Monta os parâmetros, incluindo o boilerplate DataTables obrigatório.
 *
 * O bloco `columns[0][...]` parece descartável e não é: sem ele o servidor
 * devolve 400 mesmo numa instância válida (verificado).
 */
function montarQuery(filtros: JuliaFiltros): URLSearchParams {
  const start = Math.max(0, filtros.start ?? 0);
  const length = Math.max(1, filtros.length ?? JULIA_PAGE_SIZE_PADRAO);

  const p = new URLSearchParams({
    draw: '1',
    'columns[0][data]': 'codigoDocumento',
    'columns[0][name]': '',
    'columns[0][searchable]': 'true',
    'columns[0][orderable]': 'false',
    'columns[0][search][value]': '',
    'columns[0][search][regex]': 'false',
    start: String(start),
    length: String(length),
    'search[value]': '',
    'search[regex]': 'false',
    pesquisaLivre: filtros.pesquisaLivre?.trim() ?? '',
    numeroProcesso: filtros.numeroProcesso?.replace(/\D/g, '') ?? '',
    orgaoJulgador: filtros.orgaoJulgador?.trim() ?? '',
    relator: filtros.relator?.trim() ?? '',
    dataIni: filtros.dataIni ? dataIsoParaJulia(filtros.dataIni) : '',
    dataFim: filtros.dataFim ? dataIsoParaJulia(filtros.dataFim) : ''
  });
  p.set('_', String(Date.now()));
  return p;
}

// ── Normalização ─────────────────────────────────────────────────

function normalizarDocumento(bruto: JuliaDocumentoBruto): JuliaDocumento {
  const original = bruto.texto ?? '';
  const limpo = removerRealce(original);
  const { ementa, foiRecortada } = extrairEmenta(limpo);

  return {
    codigoDocumento: bruto.codigoDocumento,
    sistema: bruto.sistema,
    instancia: bruto.instancia,
    orgao: bruto.orgao,
    tipoDocumento: bruto.tipoDocumento,
    numeroProcesso: bruto.numeroProcesso,
    numeroProcessoFormatado: formatarNumeroProcesso(bruto.numeroProcesso),
    classeJudicial: bruto.classeJudicial,
    relator: bruto.relator,
    orgaoJulgador: bruto.orgaoJulgador,
    dataJulgamento: bruto.dataJulgamento,
    dataAssinatura: bruto.dataAssinatura,
    texto: limpo,
    ementa,
    ementaFoiRecortada: foiRecortada,
    resumo: bruto.resumo,
    textoRealcadoHtml: realceSeguroHtml(original),
    origem: 'publica',
    // A API pública devolve o documento inteiro na própria busca — ao
    // contrário da autenticada, que devolve trecho.
    textoCompleto: true,
    // A API pública não traz base de URL (o campo `url` vem `null`), então o
    // link é derivado da instância embutida no `codigoDocumento`. Sem isso os
    // documentos do escopo revisor ficavam sem link.
    urlPje: null
  };
}

/**
 * Remove documentos repetidos, preservando a ordem.
 *
 * A chave é `idProcesso:idBinario` (ver `julia-identificador.ts`), não o
 * `codigoDocumento` integral: dois registros do mesmo processo podem ter
 * `idDocumento` distintos e apontar para o **mesmo binário**, devolvendo texto
 * idêntico. Deduplicar pelo código inteiro deixaria esses passarem.
 *
 * Cuidado ao mexer: documentos distintos sob o mesmo **`numeroProcesso`** são
 * legítimos (embargos de declaração + acórdão originário) e têm binários
 * diferentes. A deduplicação nunca é pelo número do processo.
 */
function deduplicar(itens: JuliaDocumentoBruto[]): {
  unicos: JuliaDocumentoBruto[];
  removidas: number;
} {
  const vistos = new Set<string>();
  const unicos: JuliaDocumentoBruto[] = [];
  for (const item of itens) {
    const chave = chaveDeduplicacao(item.codigoDocumento);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    unicos.push(item);
  }
  return { unicos, removidas: itens.length - unicos.length };
}

// ── Busca ────────────────────────────────────────────────────────

export interface JuliaBuscaOpcoes {
  signal?: AbortSignal;
}

/**
 * Executa uma busca e devolve os resultados já normalizados.
 *
 * @throws {JuliaApiError} em erro de rede, status não-2xx, JSON inválido ou
 *   pedido de paginação além do teto (§ `JULIA_MAX_RESULT_WINDOW`).
 * @throws {RangeError} quando `dataIni`/`dataFim` não estão em ISO.
 */
export async function buscarJulia(
  filtros: JuliaFiltros,
  opcoes: JuliaBuscaOpcoes = {}
): Promise<JuliaResultado> {
  const start = Math.max(0, filtros.start ?? 0);
  const length = Math.max(1, filtros.length ?? JULIA_PAGE_SIZE_PADRAO);

  // Barra antes de sair pela rede: além do teto o backend responde erro, não
  // página vazia — falhar aqui produz mensagem útil em vez de 500 opaco.
  if (start >= JULIA_MAX_RESULT_WINDOW) {
    throw new JuliaApiError(
      `A pesquisa da Júlia só permite navegar até ${JULIA_MAX_RESULT_WINDOW.toLocaleString('pt-BR')} resultados. Refine os filtros (período, órgão julgador ou relator).`,
      null,
      ''
    );
  }

  const url = `${JULIA_BASE_URL}/${filtros.instancia}?${montarQuery({ ...filtros, start, length })}`;

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: opcoes.signal
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new JuliaApiError(
      `Falha de rede ao consultar a Júlia: ${String(err)}`,
      null,
      url
    );
  }

  if (!resposta.ok) {
    // 400 aqui é quase sempre `{instancia}` inválida — o backend rejeita o
    // valor do enum em vez de devolver lista vazia.
    const dica =
      resposta.status === 400
        ? ` Verifique se "${filtros.instancia}" é uma instância válida (o 1º grau não existe nesta API).`
        : '';
    throw new JuliaApiError(
      `JULIA respondeu HTTP ${resposta.status}.${dica}`,
      resposta.status,
      url
    );
  }

  let bruta: JuliaRespostaBruta;
  try {
    bruta = (await resposta.json()) as JuliaRespostaBruta;
  } catch (err) {
    throw new JuliaApiError(
      `Resposta da Júlia não é JSON válido: ${String(err)}`,
      resposta.status,
      url
    );
  }

  const itens = Array.isArray(bruta.data) ? bruta.data : [];
  const { unicos, removidas } = deduplicar(itens);
  if (removidas > 0) {
    console.debug(
      `${LOG_PREFIX} julia-client: ${removidas} duplicata(s) por codigoDocumento descartada(s).`
    );
  }

  const total = bruta.recordsTotal ?? 0;
  const totalEhTeto = total >= JULIA_MAX_RESULT_WINDOW;

  return {
    documentos: unicos.map(normalizarDocumento),
    total,
    totalEhTeto,
    start,
    length,
    duplicatasRemovidas: removidas,
    temMais:
      start + length < Math.min(total, JULIA_MAX_RESULT_WINDOW) &&
      unicos.length > 0
  };
}
