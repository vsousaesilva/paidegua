/**
 * Adapter para PJe Legacy (versão JSF/PrimeFaces/RichFaces).
 *
 * É a versão usada pela maior parte dos tribunais, incluindo TRF5 (tanto
 * pje1g.trf5.jus.br quanto pje2g.trf5.jus.br na data desta fase).
 *
 * Fase 2: detecção de versão + identificação de página de processo +
 * extração do número único. A extração de documentos entra na Fase 3.
 */

import { LOG_PREFIX, NUMERO_PROCESSO_REGEX } from '../../shared/constants';
import type { ProcessoDocumento } from '../../shared/types';
import type { BaseAdapter } from './base-adapter';

/**
 * Substrings (case-insensitive) que um href/src deve conter para ser
 * reconhecido como link de documento processual do PJe legacy.
 */
const DOCUMENT_HREF_HINTS: readonly string[] = [
  '/ConsultaDocumento/',
  '/downloadBinario',
  'idProcessoDocumentoBin',
  '/binario/',
  '/documento/download/',
  '/pje-legacy/documento/download/',
  '/api/v1/documentos/',
  'ConsultaPublica/DetalheProcessoConsultaPublica/listDocumentos'
];

/**
 * URLs que contêm estes padrões NÃO são documentos — são páginas do PJe
 * que por acaso possuem parâmetros como idProcessoDocumento na query string.
 * Devem ser rejeitadas antes de testar os hints positivos.
 */
const DOCUMENT_HREF_EXCLUDES: readonly string[] = [
  'lembretes.seam',
  'lembrete.seam',
  'tarefas.seam',
  'painel_usuario',
  'movimentacao.seam',
  'intimacao.seam',
  'audiencia.seam',
  'peticao.seam',
  'listAutosDigitais.seam'
];

/**
 * Regexes para extrair um ID numérico de uma URL de documento. A ordem
 * importa: vamos do mais específico para o mais genérico. Inclui o REST
 * endpoint do PJe legacy do TRF5 (`/pje-legacy/documento/download/{id}`).
 */
// IDs reais de documento no PJe têm 5+ dígitos (geralmente 7-9). Exigir
// esse piso elimina falsos positivos como `?id=498` (páginas de ajuda,
// abas com query param genérica, ícones de navegação), que vazavam como
// "documento fantasma" na listagem.
const DOCUMENT_ID_REGEXES: readonly RegExp[] = [
  /idProcessoDocumentoBin=(\d{5,})/i,
  /idProcessoDocumento=(\d{5,})/i,
  /idBin=(\d{5,})/i,
  /\/documento\/download\/(\d{5,})(?:[/?#]|$)/i,
  /\/download\/(\d{5,})(?:[/?#]|$)/i,
  /\/documentos?\/(\d{5,})(?:[/?#]|$)/i,
  /\/binario\/(\d{5,})(?:[/?#]|$)/i,
  /[?&]id=(\d{5,})/i
];

/** Regex para localizar datas no formato dd/mm/aaaa no texto do contexto. */
const DATA_BR_REGEX = /\b(\d{2}\/\d{2}\/\d{4})(?:\s+\d{2}:\d{2}(?::\d{2})?)?/;

/**
 * Regexes para parsear o rótulo padrão do PJe.
 *
 * Formato canônico:
 *   "{ID} - {Tipo} ({hash} {Nome do arquivo.ext})"
 * Exemplos reais capturados no TRF5:
 *   "152717156 - Laudo Pericial (79291937304 Extrato CNIS.pdf)"
 *   "98434763 - Contestação (10 CONTESTAÇÃO INSS LOAS INCAPAC SEM LAUDO ...)"
 *
 * Importante: os regexes NÃO são ancorados (`^...$`). O texto bruto que
 * extraímos do DOM frequentemente inclui conteúdo adicional dos elementos
 * vizinhos (ícones de copiar link, pin de fixação, botões de ação etc.)
 * que quebrariam um match ancorado. A busca não-ancorada localiza o
 * padrão mesmo quando há ruído ao redor.
 *
 * Exige ID com 5+ dígitos para reduzir falsos positivos em textos que
 * contenham pequenos números no meio.
 */
const PJE_LABEL_REGEX_WITH_PARENS =
  /(\d{5,})\s*-\s*([^()\n\r]+?)\s*\(([^()\n\r]*)\)/;

const PJE_LABEL_REGEX_NO_PARENS =
  /(\d{5,})\s*-\s*([^()\n\r]{3,}?)(?=\s*(?:$|[\u2022|•📋📌]|\s{2,}))/;

/** Dentro dos parênteses, remove um hash numérico inicial e espaços. */
const HASH_PREFIX_REGEX = /^\d+\s+/;

interface ParsedPjeLabel {
  id: string | null;
  tipo: string | null;
  filename: string | null;
  raw: string;
}

/**
 * Resultado de uma tentativa de construir um ProcessoDocumento a partir
 * de um elemento do DOM. `quality` reflete quanto do label do PJe foi
 * efetivamente identificado e serve para desambiguar hits duplicados
 * vindos de scanners distintos:
 *   0 = nada parseado, só o ID (fallback "Documento {id}")
 *   1 = tipo parseado a partir do label padrão
 *   2 = tipo + nome de arquivo parseados (parse completo do label)
 */
interface BuildResult {
  documento: ProcessoDocumento;
  quality: 0 | 1 | 2;
}

/**
 * Normaliza o texto do DOM antes do parse: remove caracteres de controle
 * e zero-width, colapsa whitespace.
 */
function normalizeLabel(text: string): string {
  return (text ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Marcadores que indicam onde termina o rótulo "limpo" do PJe e começa o
 * ruído do DOM circundante. Surgem quando o card que envolve o documento
 * inclui também botões de ação, widget de lembrete, paginação e
 * `aria-label` de ícones — particularmente comum no PRIMEIRO documento
 * da listagem (que vem expandido por padrão).
 *
 * Cortamos o texto parseado no PRIMEIRO match — o que vem depois é noise
 * do PJe e nunca faz parte do tipo/nome do documento.
 */
const PJE_LABEL_NOISE_BOUNDARY =
  /\b(?:Juntado\s+por|Ícone|Lembrete|Novo\s+Lembrete|em\s+\d{2}\/\d{2}\/\d{4}|\d+\s+de\s+\d+)\b/i;

/** Sequência de marcadores cuja simples presença invalida o token. */
const PJE_LABEL_NOISE_TOKENS = /(?:Ícone|Lembrete|Juntado\s+por)/i;

/**
 * Limpa um campo (tipo ou filename) parseado removendo o ruído típico do
 * DOM do PJe. Devolve `null` quando o resíduo é curto demais, longo
 * demais ou contém tokens de ruído residual — nesse caso o chamador
 * deve cair para a heurística de contexto.
 */
function sanitizeParsedField(
  value: string | null,
  opts: { maxLen: number; minLen: number }
): string | null {
  if (!value) return null;
  let v = value;
  const boundary = v.search(PJE_LABEL_NOISE_BOUNDARY);
  if (boundary >= 0) {
    v = v.slice(0, boundary);
  }
  v = v.trim();
  if (v.length < opts.minLen) return null;
  if (v.length > opts.maxLen) return null;
  if (PJE_LABEL_NOISE_TOKENS.test(v)) return null;
  return v;
}

/**
 * Parseia um rótulo do PJe em seus componentes. Se o formato não bater
 * completamente, retorna o máximo que conseguiu identificar.
 *
 * Pós-processa os campos `tipo` e `filename` com `sanitizeParsedField`
 * para evitar capturar texto de UI vizinha — bug observado no primeiro
 * documento da listagem, cujo card inclui também widgets de paginação,
 * lembrete e botões de ação.
 */
function parsePjeLabel(text: string): ParsedPjeLabel {
  const raw = normalizeLabel(text);

  // Tentativa 1: formato canônico com parênteses.
  const full = raw.match(PJE_LABEL_REGEX_WITH_PARENS);
  if (full) {
    const id = full[1] ?? null;
    const rawTipo = (full[2] ?? '').trim() || null;
    const insideParens = (full[3] ?? '').trim();
    let rawFilename: string | null = null;
    if (insideParens) {
      rawFilename =
        insideParens.replace(HASH_PREFIX_REGEX, '').trim() || insideParens;
    }
    const tipo = sanitizeParsedField(rawTipo, { minLen: 2, maxLen: 80 });
    const filename = sanitizeParsedField(rawFilename, { minLen: 3, maxLen: 200 });
    return { id, tipo, filename, raw };
  }

  // Tentativa 2: só "{ID} - {Tipo}" (documento sem nome de arquivo nos parênteses).
  const simple = raw.match(PJE_LABEL_REGEX_NO_PARENS);
  if (simple) {
    const rawTipo = (simple[2] ?? '').trim() || null;
    const tipo = sanitizeParsedField(rawTipo, { minLen: 2, maxLen: 80 });
    return {
      id: simple[1] ?? null,
      tipo,
      filename: null,
      raw
    };
  }

  return { id: null, tipo: null, filename: null, raw };
}

/**
 * Fragmentos de URL (path) que indicam que estamos em uma tela de processo.
 * A lista intencionalmente inclui variações conhecidas do PJe TRF5 e de
 * outros tribunais legacy. É avaliada como substring case-insensitive.
 */
const PROCESSO_PATH_HINTS: readonly string[] = [
  '/Processo/ConsultaProcesso/Detalhe/',
  '/Processo/ConsultaProcesso/listView',
  '/Processo/ConsultaDocumento/',
  '/ConsultaPublica/DetalheProcessoConsultaPublica/',
  '/Painel/painel_usuario/'
];

/** Parâmetros de query que tipicamente acompanham uma tela de processo. */
const PROCESSO_QUERY_KEYS: readonly string[] = [
  'idProcesso',
  'idProcessoTrf',
  'ca',
  'id'
];

export class PJeLegacyAdapter implements BaseAdapter {
  readonly version = 'legacy' as const;

  matches(): boolean {
    // Marcadores clássicos de JSF + PrimeFaces/RichFaces que o PJe legacy usa.
    const hasJsfResource = Boolean(
      document.querySelector('script[src*="javax.faces.resource"]')
    );
    const hasPrimeFaces = typeof (window as { PrimeFaces?: unknown }).PrimeFaces !== 'undefined';
    const hasSeamUrl = window.location.pathname.includes('.seam');
    const hasRichFaces = Boolean(document.querySelector('[class*="rf-"], [id^="j_id"]'));

    return hasJsfResource || hasPrimeFaces || hasSeamUrl || hasRichFaces;
  }

  isProcessoPage(): boolean {
    const { pathname, search } = window.location;
    const fullUrl = (pathname + search).toLowerCase();

    const pathMatch = PROCESSO_PATH_HINTS.some((hint) =>
      fullUrl.includes(hint.toLowerCase())
    );
    if (pathMatch) {
      return true;
    }

    // Fallback: query string com parâmetros típicos de detalhe de processo.
    const params = new URLSearchParams(search);
    const hasProcessoParam = PROCESSO_QUERY_KEYS.some((key) => params.has(key));
    if (hasProcessoParam && this.extractNumeroProcesso() !== null) {
      return true;
    }

    return false;
  }

  extractNumeroProcesso(): string | null {
    // Estratégia 1: título da página (PJe legacy quase sempre inclui o número).
    const fromTitle = this.matchNumeroProcesso(document.title);
    if (fromTitle) {
      return fromTitle;
    }

    // Estratégia 2: elementos que costumam conter o cabeçalho do processo.
    const headerSelectors = [
      '#nomeProcesso',
      '[id*="numeroProcesso"]',
      '[id*="processoTitulo"]',
      '.numeroProcesso',
      '.processo-numero',
      'h1, h2, h3'
    ];
    for (const selector of headerSelectors) {
      const elements = document.querySelectorAll<HTMLElement>(selector);
      for (const el of Array.from(elements)) {
        const match = this.matchNumeroProcesso(el.textContent ?? '');
        if (match) {
          return match;
        }
      }
    }

    // Estratégia 3: varredura do texto do body como último recurso.
    // Limitamos o tamanho para evitar processar páginas enormes por inteiro.
    const bodyText = (document.body?.innerText ?? '').slice(0, 20000);
    return this.matchNumeroProcesso(bodyText);
  }

  extractDocumentos(): ProcessoDocumento[] {
    // Cada entrada é um BuildResult (documento + score de qualidade do parse),
    // de forma que hits duplicados do mesmo ID são consolidados pelo de maior
    // qualidade (ex.: o scanner que achou o label completo substitui o que
    // achou só o ícone).
    const seen = new Map<string, BuildResult>();
    let framesScanned = 0;
    let framesSkipped = 0;

    const scan = (doc: Document): void => {
      framesScanned++;
      this.scanAnchors(doc, seen);
      this.scanIframes(doc, seen);
      this.scanOnclickElements(doc, seen);

      // Recursão: descer nos iframes same-origin. Em PJe legacy a árvore
      // de documentos quase sempre vive em um iframe filho
      // (ex.: /pje/Processo/ConsultaDocumento/listView.seam), separado
      // do frame superior que contém o cabeçalho do processo.
      const childFrames = doc.querySelectorAll<HTMLIFrameElement>('iframe, frame');
      for (const frame of Array.from(childFrames)) {
        try {
          const childDoc = frame.contentDocument;
          if (childDoc && childDoc.body) {
            scan(childDoc);
          } else {
            framesSkipped++;
          }
        } catch {
          framesSkipped++;
        }
      }
    };

    scan(document);

    const results = Array.from(seen.values())
      .map((r) => r.documento)
      .filter((d) => {
        // Exclui entradas que são ruído do DOM do PJe (ex.: "Ícone de certidão",
        // elementos de UI capturados por engano pelos scanners).
        const desc = (d.descricao ?? '').toLowerCase();
        if (desc.startsWith('ícone') || desc.startsWith('icone')) return false;
        return true;
      });
    console.log(
      `${LOG_PREFIX} extractDocumentos (legacy): ${results.length} documento(s) ` +
        `encontrado(s) — frames escaneados: ${framesScanned}, ignorados: ${framesSkipped}`
    );
    return results;
  }

  /**
   * Mescla um resultado novo no mapa de vistos, preferindo sempre o de
   * maior qualidade de parse. Isso resolve o caso em que múltiplos
   * scanners encontram o mesmo documento por elementos DOM distintos
   * (um ícone sem texto + um link com o label completo, por exemplo).
   */
  private mergeResult(
    seen: Map<string, BuildResult>,
    result: BuildResult
  ): void {
    const existing = seen.get(result.documento.id);
    if (!existing || result.quality > existing.quality) {
      seen.set(result.documento.id, result);
    }
  }

  /** Estratégia 1: âncoras com href apontando para documentos. */
  private scanAnchors(doc: Document, seen: Map<string, BuildResult>): void {
    const anchors = doc.querySelectorAll<HTMLAnchorElement>('a[href]');
    for (const anchor of Array.from(anchors)) {
      const href = anchor.getAttribute('href') ?? '';
      if (!this.isDocumentHref(href)) {
        continue;
      }
      const absoluteUrl = this.toAbsoluteUrl(href, doc);
      if (!absoluteUrl) {
        continue;
      }
      this.mergeResult(seen, this.buildDocumento(anchor, absoluteUrl));
    }
  }

  /** Estratégia 2: iframes com src de PDF/documento. */
  private scanIframes(doc: Document, seen: Map<string, BuildResult>): void {
    const iframes = doc.querySelectorAll<HTMLIFrameElement>('iframe[src]');
    for (const iframe of Array.from(iframes)) {
      const src = iframe.getAttribute('src') ?? '';
      if (!this.isDocumentHref(src)) {
        continue;
      }
      const absoluteUrl = this.toAbsoluteUrl(src, doc);
      if (!absoluteUrl) {
        continue;
      }
      // Para iframes geralmente não temos o label padrão do PJe; usamos
      // o título/nome do iframe como descrição bruta e deixamos o
      // buildDocumento parsear se houver algo parseável.
      const label = iframe.title || iframe.name || '';
      this.mergeResult(
        seen,
        this.buildDocumentoFromLabel(label, absoluteUrl, iframe)
      );
    }
  }

  /**
   * Estratégia 3: elementos clicáveis (tree nodes PrimeFaces/RichFaces,
   * <span> com onclick etc.) que carregam IDs de documento via onclick,
   * data-url, data-href, ou atributos id/name contendo o ID.
   */
  private scanOnclickElements(doc: Document, seen: Map<string, BuildResult>): void {
    const candidates = doc.querySelectorAll<HTMLElement>(
      '[onclick], [data-url], [data-href], ' +
        '[id*="processoDocumento"], [id*="documento"], ' +
        '[name*="processoDocumento"], [name*="documento"]'
    );
    for (const node of Array.from(candidates)) {
      // Primeiro tenta data-url / data-href explícitos.
      let candidateHref =
        node.getAttribute('data-url') ??
        node.getAttribute('data-href') ??
        '';

      // Depois tenta o atributo onclick (regex para achar URL parcial).
      if (!candidateHref) {
        const onclick = node.getAttribute('onclick') ?? '';

        // 1) URL explícita no onclick (ConsultaDocumento, downloadBinario etc.)
        const urlMatch = onclick.match(/['"]([^'"]*(?:ConsultaDocumento|downloadBinario|binario|pje-legacy\/documento\/download)[^'"]*)['"]/i);
        if (urlMatch && urlMatch[1]) {
          candidateHref = urlMatch[1];
        }

        // 2) copyToClipboard(event, 'ID') — botão de copiar ID do documento
        if (!candidateHref) {
          const copyMatch = onclick.match(/copyToClipboard\s*\([^,]*,\s*['"](\d{5,})['"]\s*\)/i);
          if (copyMatch && copyMatch[1]) {
            candidateHref = `/pje/seam/resource/rest/pje-legacy/documento/download/${copyMatch[1]}`;
          }
        }

        // 3) idProcessoDocumento em parâmetro genérico do onclick
        if (!candidateHref) {
          const idMatch = onclick.match(/idProcessoDocumento(?:Bin)?['"]?\s*[:=,]\s*['"]?(\d+)/i);
          if (idMatch && idMatch[1]) {
            candidateHref = `/pje/seam/resource/rest/pje-legacy/documento/download/${idMatch[1]}`;
          }
        }
      }

      // Último recurso: ID contido no próprio id/name do elemento.
      if (!candidateHref) {
        const idAttr = node.getAttribute('id') ?? node.getAttribute('name') ?? '';
        const idMatch = idAttr.match(/(?:processoDocumento(?:Bin)?|documento)[^0-9]*(\d+)/i);
        if (idMatch && idMatch[1]) {
          candidateHref = `/pje/seam/resource/rest/pje-legacy/documento/download/${idMatch[1]}`;
        }
      }

      if (!candidateHref || !this.isDocumentHref(candidateHref)) {
        continue;
      }
      const absoluteUrl = this.toAbsoluteUrl(candidateHref, doc);
      if (!absoluteUrl) {
        continue;
      }
      this.mergeResult(seen, this.buildDocumento(node, absoluteUrl));
    }
  }

  /**
   * Constrói um BuildResult a partir de um elemento + URL absoluta.
   * Usa o texto do elemento como fonte primária do label do PJe. Se o
   * texto direto não bater com o padrão, sobe na árvore de ancestrais
   * buscando um nó cujo texto contenha o label canônico "{id} - ..."
   * — isso resolve o caso de ícones clicáveis sem texto próprio, cujo
   * label verdadeiro mora no card pai.
   */
  private buildDocumento(element: Element, absoluteUrl: string): BuildResult {
    const rawLabel = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return this.buildDocumentoFromLabel(rawLabel, absoluteUrl, element);
  }

  private buildDocumentoFromLabel(
    rawLabel: string,
    absoluteUrl: string,
    contextElement: Element
  ): BuildResult {
    const idFromHref = this.extractIdFromHref(absoluteUrl);

    // Primeiro, tenta parsear o texto direto do elemento.
    let parsed = parsePjeLabel(rawLabel);

    // Se não obteve nada útil (sem tipo/filename), tenta encontrar o label
    // canônico em algum ancestral usando o ID conhecido da URL como âncora.
    if ((!parsed.tipo || !parsed.filename) && idFromHref) {
      const contextLabel = this.extractLabelFromContext(
        contextElement,
        idFromHref
      );
      if (contextLabel) {
        const parsedFromContext = parsePjeLabel(contextLabel);
        // Só substitui se o parse de contexto for estritamente melhor.
        if (
          (parsedFromContext.filename && !parsed.filename) ||
          (parsedFromContext.tipo && !parsed.tipo)
        ) {
          parsed = parsedFromContext;
        }
      }
    }

    // ID: preferir o parseado (do label visível), depois o da URL.
    const id = parsed.id ?? idFromHref ?? absoluteUrl;

    // Tipo: preferir o parseado, depois heurística de contexto.
    const tipo = parsed.tipo ?? this.guessTipoFromContext(contextElement);

    // Descrição a exibir: nome do arquivo quando disponível; senão tipo;
    // senão raw; senão fallback genérico.
    const descricao =
      parsed.filename ||
      parsed.tipo ||
      (rawLabel.length > 0 && rawLabel.length <= 120 ? rawLabel : '') ||
      `Documento ${id}`;

    // Score de qualidade: 2 = filename parseado, 1 = só tipo, 0 = fallback.
    let quality: 0 | 1 | 2 = 0;
    if (parsed.filename) {
      quality = 2;
    } else if (parsed.tipo) {
      quality = 1;
    }

    const documento: ProcessoDocumento = {
      id,
      tipo,
      descricao,
      dataMovimentacao: this.extractDateFromContext(contextElement) ?? '',
      mimeType: 'application/pdf',
      url: absoluteUrl
    };

    return { documento, quality };
  }

  /**
   * Sobe até 6 níveis na árvore de ancestrais do `element` procurando um
   * nó cujo `textContent` contenha o label canônico `{knownId} -`. Quando
   * encontra, retorna o trecho a partir do ID (normalizado), truncado em
   * 400 caracteres para evitar empurrar ruído para o parser.
   *
   * Uso típico: o scanner pegou um ícone/âncora sem texto próprio, mas o
   * label real ("152717156 - Laudo Pericial (...)") está no card pai.
   */
  private extractLabelFromContext(
    element: Element,
    knownId: string
  ): string | null {
    const needle = `${knownId} -`;
    let current: Element | null = element.parentElement;
    for (let depth = 0; depth < 6 && current; depth++) {
      const text = normalizeLabel(current.textContent ?? '');
      const idx = text.indexOf(needle);
      if (idx >= 0) {
        return text.slice(idx, idx + 400);
      }
      current = current.parentElement;
    }
    return null;
  }

  private isDocumentHref(href: string): boolean {
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
      return false;
    }
    const lower = href.toLowerCase();
    // Rejeita URLs de páginas do PJe que não são documentos
    if (DOCUMENT_HREF_EXCLUDES.some((ex) => lower.includes(ex.toLowerCase()))) {
      return false;
    }
    if (!DOCUMENT_HREF_HINTS.some((hint) => lower.includes(hint.toLowerCase()))) {
      return false;
    }
    // Endpoints .seam (ex.: ConsultaDocumento/listView.seam) são genéricos:
    // a MESMA URL serve tanto a listagem quanto um documento específico —
    // o que distingue é o parâmetro de ID na query. Sem ID, cairia na
    // listagem (que hoje volta o desafio F5/TSPD). Exigimos ID extraível.
    if (lower.includes('.seam') && !this.extractIdFromHref(href)) {
      return false;
    }
    return true;
  }

  private toAbsoluteUrl(href: string, doc: Document): string | null {
    try {
      // Usa a URL base do documento efetivo (pode ser um iframe filho),
      // não a do top frame, para resolver hrefs relativos corretamente.
      const base = doc.baseURI || doc.location?.href || window.location.href;
      return new URL(href, base).href;
    } catch {
      return null;
    }
  }

  private extractIdFromHref(href: string): string | null {
    for (const regex of DOCUMENT_ID_REGEXES) {
      const match = href.match(regex);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }

  private guessTipoFromContext(element: Element): string {
    // Percorre até 4 ancestrais buscando um rótulo de tipo (ex.: "Petição",
    // "Decisão", "Sentença") em elementos irmãos ou classes.
    const tipos = [
      'Petição Inicial',
      'Petição',
      'Contestação',
      'Réplica',
      'Sentença',
      'Acórdão',
      'Decisão',
      'Despacho',
      'Certidão',
      'Manifestação',
      'Laudo',
      'Parecer',
      'Ofício',
      'Embargos',
      'Recurso',
      'Agravo',
      'Apelação'
    ];
    let current: Element | null = element;
    for (let depth = 0; depth < 4 && current; depth++) {
      const text = (current.textContent ?? '').toLowerCase();
      for (const tipo of tipos) {
        if (text.includes(tipo.toLowerCase())) {
          return tipo;
        }
      }
      current = current.parentElement;
    }
    return 'Documento';
  }

  private extractDateFromContext(element: Element): string | null {
    let current: Element | null = element;
    for (let depth = 0; depth < 5 && current; depth++) {
      const text = current.textContent ?? '';
      const match = text.match(DATA_BR_REGEX);
      if (match && match[1]) {
        return match[1];
      }
      current = current.parentElement;
    }
    return null;
  }

  private matchNumeroProcesso(text: string): string | null {
    if (!text) {
      return null;
    }
    const match = text.match(NUMERO_PROCESSO_REGEX);
    return match ? match[0] : null;
  }
}
