/**
 * Geração de PDF e DOCX para a aba "Resumo dos processos da pauta".
 *
 * **PDF**: usa `html2pdf.js` (jsPDF + html2canvas) para renderizar o
 * HTML formatado em PDF binário e disparar o download direto, sem
 * abrir diálogo de impressão. Mesma UX do DOCX.
 *
 * **DOCX**: usa `html-docx-js` (~50KB) para gerar um Blob `.docx`
 * puro a partir do mesmo HTML formatado, com download via anchor
 * temporário. Abre nativo no Word/LibreOffice.
 *
 * O HTML usado é o mesmo nos dois caminhos — a partir do markdown
 * já renderizado pela `renderMarkdown`. Aplicamos um wrapper com
 * cabeçalho institucional (CNJ, classe, data da audiência, etc.)
 * para o documento ficar autocontido.
 */

import { asBlob } from 'html-docx-js/dist/html-docx';
import html2pdf from 'html2pdf.js';
import type { DadosLinha } from './resumo-prompt';

export type TipoExport = 'resumo' | 'sentenca-oral';

export interface ExportInput {
  /** Tipo do documento gerado — afeta título e nome do arquivo. */
  tipo: TipoExport;
  /**
   * Quando `tipo === 'sentenca-oral'`, o sentido do julgamento
   * (Procedente / Improcedente / Extinto). Vai para o título.
   */
  julgamento?: 'Procedente' | 'Improcedente' | 'Extinto';
  /** Linha da pauta (CNJ, partes, classe, data, sala…). */
  linha: DadosLinha;
  /** HTML do conteúdo principal (markdown já renderizado pelo `renderMarkdown`). */
  conteudoHtml: string;
}

const ESTILO_PRINT = `
  body { font-family: "Inter", "Helvetica", Arial, sans-serif; font-size: 12pt; color: #16243A; line-height: 1.45; padding: 32px 36px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18pt; color: #0C326F; margin: 0 0 4px; page-break-after: avoid; break-after: avoid; }
  h2 { font-size: 14pt; color: #0C326F; margin: 18px 0 8px; border-bottom: 1px solid #d6dde6; padding-bottom: 3px; page-break-after: avoid; break-after: avoid; }
  h3 { font-size: 12pt; color: #0C326F; margin: 14px 0 6px; page-break-after: avoid; break-after: avoid; }
  p { margin: 0 0 8px; text-align: justify; page-break-inside: avoid; break-inside: avoid; }
  ul, ol { margin: 0 0 10px 22px; }
  li { margin: 2px 0; page-break-inside: avoid; break-inside: avoid; }
  strong { color: #0C326F; }
  blockquote { border-left: 3px solid #b6c4d6; margin: 8px 0; padding: 4px 12px; color: #5B6B82; page-break-inside: avoid; break-inside: avoid; }
  .doc-header { border-bottom: 2px solid #0C326F; padding-bottom: 12px; margin-bottom: 18px; page-break-inside: avoid; break-inside: avoid; page-break-after: avoid; break-after: avoid; }
  .doc-header__titulo { font-size: 16pt; color: #0C326F; font-weight: 700; margin: 0 0 4px; }
  .doc-header__sub { font-size: 10pt; color: #5B6B82; margin: 0; }
  .doc-meta { background: #f4f7fc; border: 1px solid #d6dde6; padding: 10px 14px; margin: 0 0 18px; font-size: 10pt; page-break-inside: avoid; break-inside: avoid; }
  .doc-meta dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
  .doc-meta dt { color: #5B6B82; font-weight: 600; }
  .doc-meta dd { margin: 0; color: #16243A; }
  .doc-footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #d6dde6; font-size: 9pt; color: #5B6B82; text-align: center; page-break-inside: avoid; break-inside: avoid; }
  @media print {
    body { padding: 0; }
    .no-print { display: none; }
  }
`;

function montarTituloDocumento(input: ExportInput): string {
  if (input.tipo === 'sentenca-oral') {
    const j = input.julgamento ?? '';
    return `Sentença oral${j ? ` — ${j}` : ''}`;
  }
  return 'Resumo do processo';
}

function montarNomeArquivo(input: ExportInput, extensao: 'pdf' | 'docx'): string {
  const cnjLimpo = input.linha.cnj.replace(/[^\d.-]/g, '');
  const sufixo =
    input.tipo === 'sentenca-oral'
      ? `sentenca-oral${input.julgamento ? '-' + input.julgamento.toLowerCase() : ''}`
      : 'resumo';
  return `${cnjLimpo}-${sufixo}.${extensao}`;
}

function montarHtmlCompleto(input: ExportInput): string {
  const titulo = montarTituloDocumento(input);
  const subtitulo =
    input.tipo === 'sentenca-oral'
      ? 'Texto sugerido para leitura em audiência — pAIdegua'
      : 'Resumo executivo — pAIdegua';
  const dataGeracao = new Date().toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  const meta = `
    <div class="doc-meta">
      <dl>
        <dt>Processo</dt><dd>${escapeHtml(input.linha.cnj)}</dd>
        <dt>Classe</dt><dd>${escapeHtml(input.linha.classe)}</dd>
        <dt>Audiência</dt><dd>${escapeHtml(input.linha.dataHora)} (${escapeHtml(input.linha.tipoAudiencia)})</dd>
        <dt>Sala</dt><dd>${escapeHtml(input.linha.sala)}</dd>
        <dt>Polo ativo</dt><dd>${escapeHtml(input.linha.autor)}</dd>
        <dt>Polo passivo</dt><dd>${escapeHtml(input.linha.reu)}</dd>
        <dt>Órgão julgador</dt><dd>${escapeHtml(input.linha.orgaoJulgador)}</dd>
      </dl>
    </div>
  `;
  const footer = `
    <div class="doc-footer">
      Documento gerado por pAIdegua em ${escapeHtml(dataGeracao)}.
      Conteúdo gerado por inteligência artificial — confira contra os autos antes de utilizar.
    </div>
  `;
  return `\
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(titulo)} — ${escapeHtml(input.linha.cnj)}</title>
<style>${ESTILO_PRINT}</style>
</head>
<body>
  <header class="doc-header">
    <h1 class="doc-header__titulo">${escapeHtml(titulo)}</h1>
    <p class="doc-header__sub">${escapeHtml(subtitulo)}</p>
  </header>
  ${meta}
  ${input.conteudoHtml}
  ${footer}
</body>
</html>`;
}

/**
 * Gera o PDF binário (via `html2pdf.js`) e dispara o download direto,
 * sem diálogo de impressão. UX idêntica à do DOCX.
 *
 * Construímos um elemento real (`<div>`) com **só o conteúdo do body**
 * + um `<style>` no head do documento principal (scope amplo, removido
 * depois). Não dá pra fazer `innerHTML = htmlCompleto` num div, porque
 * o parser HTML5 simplifica `<html>/<head>/<body>` aninhados — perde
 * todos os filhos.
 *
 * Posicionamento: wrapper VISÍVEL no canto inferior direito, em cima de
 * tudo, durante a renderização. Várias tentativas anteriores com
 * `position: fixed`, `opacity: 0`, `left: -99999px` produziam PDF em
 * branco — o html2canvas no contexto de extensão MV3 falha em rasterizar
 * elementos invisíveis ou off-screen. Com o wrapper visível por ~1-2s
 * (flash branco rápido), html2canvas captura corretamente. UX aceitável.
 */
export async function exportarPdf(input: ExportInput): Promise<void> {
  const corpoHtml = montarCorpoHtml(input);

  // Wrapper TOTALMENTE auto-contido: o <style> vai DENTRO do wrapper,
  // não no document.head. Razão: html2canvas clona o elemento alvo num
  // iframe via document.write() — estilos do head do documento principal
  // podem não chegar (visto na prática: clone com altura 0 mesmo quando
  // o wrapper na página real mede 2112px). Estilo embarcado é capturado
  // junto na clone, o layout reproduz-se idêntico no iframe.
  //
  // Também travamos a altura explicitamente (height: NNNpx) depois do
  // primeiro reflow, para o caso de o html2canvas não conseguir medir
  // do conteúdo no iframe (acontece quando o iframe tem viewport zero).

  const wrapper = document.createElement('div');
  wrapper.dataset.paidegua = 'pdf-export-wrapper';
  wrapper.style.position = 'absolute';
  wrapper.style.top = '0';
  wrapper.style.left = '0';
  wrapper.style.width = '720px';
  wrapper.style.background = '#ffffff';
  wrapper.style.zIndex = '2147483647';
  // Estilo + corpo no MESMO div — clone garantido
  wrapper.innerHTML =
    `<style>${ESTILO_PRINT}\n` +
    // Sobrescreve as regras que originalmente eram em `body { ... }`
    // para que apliquem ao wrapper (que é um div, não um body).
    `[data-paidegua="pdf-export-wrapper"] {` +
      `font-family: "Inter","Helvetica",Arial,sans-serif;` +
      `font-size: 12pt; color: #16243A; line-height: 1.45;` +
      `padding: 32px 36px; box-sizing: border-box;` +
    `}</style>` +
    corpoHtml;
  document.body.appendChild(wrapper);

  // Force layout pra medir altura natural com os estilos aplicados.
  void wrapper.offsetHeight;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Trava a altura explicitamente — html2canvas nem precisa medir.
  const alturaNatural = wrapper.offsetHeight;
  wrapper.style.height = `${alturaNatural}px`;
  wrapper.style.minHeight = `${alturaNatural}px`;

  console.info(
    '[pAIdegua] exportarPdf: wrapper dims',
    wrapper.offsetWidth,
    'x',
    wrapper.offsetHeight,
    'children:',
    wrapper.children.length,
    'innerHTML length:',
    wrapper.innerHTML.length
  );

  try {
    await html2pdf()
      .set({
        margin: [12, 12, 12, 12], // mm
        filename: montarNomeArquivo(input, 'pdf'),
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: true,
          backgroundColor: '#ffffff',
          windowWidth: 720,
          // Força viewport com altura suficiente — sem isso o iframe da
          // clone usa altura padrão (~150px) e content position:absolute
          // sai com bbox 0.
          windowHeight: alturaNatural + 100,
          width: 720,
          height: alturaNatural
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        // `avoid` (lista de seletores) é o que realmente importa aqui:
        // o html2pdf insere `.html2pdf__page-break` ANTES de cada elemento
        // listado SE ele cair em cima de uma quebra de página. Sem isso,
        // li/p/blockquote são cortados ao meio (problema visto na captura
        // de "Coabitação" cortada horizontalmente). `avoid-all` foi removido
        // porque atua só nos filhos diretos do root (header/meta/ul/footer)
        // e ignora os filhos da lista — onde o problema está.
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: [
            'li',
            'p',
            'blockquote',
            'h1',
            'h2',
            'h3',
            '.doc-meta',
            '.doc-header',
            '.doc-footer'
          ]
        }
      })
      .from(wrapper)
      .save();
    console.info('[pAIdegua] exportarPdf: ok');
  } catch (err) {
    console.warn('exportarPdf falhou:', err);
    alert('Falha ao gerar PDF: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    wrapper.remove();
  }
}

/**
 * Monta apenas o conteúdo do `<body>` (sem `<!doctype>`/`<html>`/`<head>`)
 * para uso em `wrapper.innerHTML` no `exportarPdf`. O `<style>` é
 * injetado separado, no `<head>` do documento principal, pelo caller.
 */
function montarCorpoHtml(input: ExportInput): string {
  const titulo = montarTituloDocumento(input);
  const subtitulo =
    input.tipo === 'sentenca-oral'
      ? 'Texto sugerido para leitura em audiência — pAIdegua'
      : 'Resumo executivo — pAIdegua';
  const dataGeracao = new Date().toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  return `\
<header class="doc-header">
  <h1 class="doc-header__titulo">${escapeHtml(titulo)}</h1>
  <p class="doc-header__sub">${escapeHtml(subtitulo)}</p>
</header>
<div class="doc-meta">
  <dl>
    <dt>Processo</dt><dd>${escapeHtml(input.linha.cnj)}</dd>
    <dt>Classe</dt><dd>${escapeHtml(input.linha.classe)}</dd>
    <dt>Audiência</dt><dd>${escapeHtml(input.linha.dataHora)} (${escapeHtml(input.linha.tipoAudiencia)})</dd>
    <dt>Sala</dt><dd>${escapeHtml(input.linha.sala)}</dd>
    <dt>Polo ativo</dt><dd>${escapeHtml(input.linha.autor)}</dd>
    <dt>Polo passivo</dt><dd>${escapeHtml(input.linha.reu)}</dd>
    <dt>Órgão julgador</dt><dd>${escapeHtml(input.linha.orgaoJulgador)}</dd>
  </dl>
</div>
${input.conteudoHtml}
<div class="doc-footer">
  Documento gerado por pAIdegua em ${escapeHtml(dataGeracao)}.
  Conteúdo gerado por inteligência artificial — confira contra os autos antes de utilizar.
</div>`;
}

/**
 * Gera um Blob `.docx` puro via `html-docx-js` e dispara o download.
 */
export function exportarDocx(input: ExportInput): void {
  try {
    const html = montarHtmlCompleto(input);
    const blob = asBlob(html);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = montarNomeArquivo(input, 'docx');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
  } catch (err) {
    console.warn('exportarDocx falhou:', err);
    alert('Falha ao gerar DOCX: ' + (err instanceof Error ? err.message : String(err)));
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
