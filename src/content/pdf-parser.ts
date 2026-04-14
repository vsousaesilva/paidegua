/**
 * Parser de PDF baseado em pdf.js (pdfjs-dist).
 *
 * Roda dentro do content script (isolated world). Em Chrome MV3 a CSP
 * bloqueia `new Worker(url, {type:"module"})` para URLs de extensão,
 * mas o pdf.js trata isso internamente: ao falhar o Worker real, ele
 * recai no "fake worker" que faz `import()` dinâmico do mesmo URL —
 * e `import()` funciona normalmente. Precisamos apenas garantir que
 * `GlobalWorkerOptions.workerSrc` aponta para a URL correta do worker
 * via `chrome.runtime.getURL`.
 *
 * Heurística de "scanned":
 *   - Se a média de caracteres extraídos por página for menor que 50,
 *     presumimos que o PDF é uma digitalização (bitmap sem texto real).
 *     Nesse caso a Fase 5 aplicará OCR com Tesseract.js.
 */

import * as pdfjsLib from 'pdfjs-dist';

// Configura o workerSrc apontando para o arquivo copiado pelo webpack
// em dist/libs/. O new Worker() vai falhar (CSP de MV3), mas o pdf.js
// cai automaticamente no fake worker que usa import() dinâmico — e
// import() funciona porque o arquivo está em web_accessible_resources.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  'libs/pdf.worker.min.mjs'
);

export interface ParsedPdf {
  text: string;
  pageCount: number;
  isScanned: boolean;
}

/**
 * Concatena o texto de uma lista de items do pdf.js (TextItem | TextMarkedContent).
 * Usa `in` + checagem runtime em vez de type guard para evitar problemas de
 * narrow com o union type exportado pela lib.
 */
function itemsToText(items: ReadonlyArray<unknown>): string {
  const parts: string[] = [];
  for (const item of items) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'str' in item &&
      typeof (item as { str: unknown }).str === 'string'
    ) {
      parts.push((item as { str: string }).str);
    }
  }
  return parts.join(' ');
}

export async function parsePdf(buffer: ArrayBuffer): Promise<ParsedPdf> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    // Evita requisições externas a fontes e cmaps que causam ruído na
    // intranet da JFCE (sem internet).
    disableFontFace: true,
    useSystemFonts: false,
    // Suprime warnings do parser de fontes TrueType (ex.: "TT: undefined
    // function: 21") que poluem a página de erros da extensão sem impacto
    // funcional. VerbosityLevel.ERRORS = 0 (só erros fatais).
    verbosity: 0,
    // Desabilita eval/Function (CSP de extensão MV3 bloqueia).
    isEvalSupported: false
  });

  const doc = await loadingTask.promise;
  const pageCount = doc.numPages;
  const pageTexts: string[] = [];

  for (let pageIndex = 1; pageIndex <= pageCount; pageIndex++) {
    const page = await doc.getPage(pageIndex);
    const content = await page.getTextContent();
    const pageText = itemsToText(content.items)
      .replace(/\s+/g, ' ')
      .trim();
    pageTexts.push(pageText);
    page.cleanup();
  }

  await doc.cleanup();
  await doc.destroy();

  const text = pageTexts
    .map((t, i) => `=== Página ${i + 1} ===\n${t}`)
    .join('\n\n');
  const totalChars = pageTexts.reduce((sum, t) => sum + t.length, 0);
  const avgPerPage = pageCount > 0 ? totalChars / pageCount : 0;
  const isScanned = avgPerPage < 50;

  return { text, pageCount, isScanned };
}
