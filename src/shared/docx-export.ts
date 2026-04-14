/**
 * Exportação de minutas para arquivo abrível pelo Microsoft Word.
 *
 * Decisão: NÃO usamos a lib `docx` (precisaria de npm install adicional
 * num ambiente onde o `npm install` é frágil) nem JSZip. Em vez disso,
 * geramos um HTML embrulhado em namespaces Word (formato "Word HTML"),
 * salvamos com extensão `.doc`, e o Word abre nativamente sem alarde.
 *
 * Limitações conhecidas:
 *  - É um .doc HTML, não um .docx OOXML. Para o usuário final é
 *    transparente — o Word abre, edita e salva normalmente. Se quiser
 *    transformar em .docx puro, basta "Salvar como" dentro do Word.
 *  - Estilos complexos (numeração automática, sumário) não vêm; mas
 *    para minutas simples (parágrafos, negrito, itálico, listas) é
 *    mais que suficiente.
 *
 * Entrada: HTML já renderizado pelo `renderMarkdown` da própria UI,
 * mantendo coerência visual com o que o usuário viu na bolha do chat.
 */

const WORD_HTML_HEADER = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>Minuta</title>
<!--[if gte mso 9]>
<xml>
  <w:WordDocument>
    <w:View>Print</w:View>
    <w:Zoom>100</w:Zoom>
    <w:DoNotOptimizeForBrowser/>
  </w:WordDocument>
</xml>
<![endif]-->
<style>
  @page WordSection1 { size: 21cm 29.7cm; margin: 2.5cm 2.5cm 2.5cm 3cm; }
  div.WordSection1 { page: WordSection1; }
  body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.5; color: #000; }
  p { margin: 0 0 10pt 0; text-align: justify; }
  h1, h2, h3 { font-family: "Arial", sans-serif; }
  ul, ol { margin: 6pt 0 6pt 24pt; }
  pre, code { font-family: "Consolas", monospace; font-size: 10pt; }
</style>
</head>
<body>
<div class="WordSection1">
`;

const WORD_HTML_FOOTER = `</div>
</body>
</html>`;

/**
 * Gera o conteúdo do arquivo .doc a partir do HTML da bolha de chat.
 */
export function buildWordDocument(bodyHtml: string): Blob {
  const full = WORD_HTML_HEADER + bodyHtml + WORD_HTML_FOOTER;
  // BOM ajuda o Word a detectar UTF-8 corretamente em alguns locales.
  return new Blob(['\ufeff', full], { type: 'application/msword' });
}

/**
 * Dispara o download via <a download> sintético. Usamos object URL —
 * não há servidor, tudo client-side.
 */
export function downloadWordDocument(bodyHtml: string, filename = 'minuta.doc'): void {
  const safeName = filename.endsWith('.doc') ? filename : `${filename}.doc`;
  const blob = buildWordDocument(bodyHtml);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Libera memória logo em seguida — o download já foi disparado.
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Sugere um nome de arquivo razoável a partir do número de processo
 * (se disponível) e da ação executada.
 */
export function suggestMinutaFilename(
  numeroProcesso: string | null,
  actionLabel: string
): string {
  const slug = actionLabel
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const numero = numeroProcesso ? numeroProcesso.replace(/[^0-9]/g, '') : '';
  const date = new Date().toISOString().slice(0, 10);
  return numero ? `minuta-${slug}-${numero}-${date}.doc` : `minuta-${slug}-${date}.doc`;
}