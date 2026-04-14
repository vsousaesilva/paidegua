/**
 * Renderizador minimalista de Markdown para o chat.
 *
 * Sem libs externas — fazemos parsing simples e geramos HTML escapado.
 * Suporta: parágrafos, **bold**, *italic*, `inline code`, blocos ```code```,
 * listas (- e 1.), e cabeçalhos #/##/###.
 */

export function renderMarkdown(input: string): string {
  if (!input) {
    return '';
  }
  // Extrai blocos de código primeiro para não interferir nos demais regexes.
  const codeBlocks: string[] = [];
  let text = input.replace(/```([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(escapeHtml(code).replace(/\n/g, '<br/>'));
    return `\u0000CODE${idx}\u0000`;
  });

  text = escapeHtml(text);

  // Cabeçalhos
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Listas
  text = text.replace(/^(?:- |\* )(.+)$/gm, '<li>$1</li>');
  text = text.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  text = text.replace(/(?:<li>.*<\/li>\n?)+/g, (m) => `<ul>${m.replace(/\n/g, '')}</ul>`);

  // Bold/italic/code
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Parágrafos: separa por linhas em branco
  text = text
    .split(/\n{2,}/)
    .map((block) => {
      if (/^<(h\d|ul|ol|pre)/.test(block)) {
        return block;
      }
      return `<p>${block.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');

  // Restaura blocos de código
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => {
    return `<pre><code>${codeBlocks[Number(idx)]}</code></pre>`;
  });

  return text;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renderiza texto produzido pela IA em HTML adequado para inserção no editor
 * Badon (ProseMirror) do PJe — sem qualquer marcador de markdown na saída.
 *
 * Diferenças em relação a `renderMarkdown`:
 *  - Parágrafos comuns recebem `text-indent: 2em` (recuo da primeira linha,
 *    estilo padrão de peças do Judiciário Federal) e `text-align: justify`.
 *  - Linhas iniciadas com `> ` viram `<blockquote>` com recuo lateral, sem
 *    text-indent — citações longas seguem o art. 9º da NBR 10520.
 *  - Cabeçalhos markdown (`#`, `##`, `###`) são convertidos em parágrafo em
 *    negrito centralizado, não em `<h1>` etc. (peças não têm hierarquia HTML).
 *  - Itens de lista (`- `, `* `, `1. `) viram parágrafos planos, preservando
 *    apenas o conteúdo (o usuário renumera no editor se necessário).
 *  - `**negrito**` e `*itálico*` são preservados como `<strong>`/`<em>`,
 *    porque ProseMirror reconhece essas marks; o restante dos marcadores
 *    (`` ` ``, `~~`, etc.) é removido.
 *
 * Não emite `<br/>`: quebras simples são fundidas em espaços porque editores
 * judiciais quase sempre tratam parágrafo como unidade de fluxo.
 */
export function renderForPJe(input: string): string {
  if (!input) {
    return '';
  }

  // Remove blocos de código por completo, mantendo só o conteúdo escapado.
  let text = input.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    return code.trim();
  });

  // Quebra em blocos por linha em branco. Cada bloco vira um parágrafo,
  // citação ou item de lista — TODOS passando pelo mesmo construtor de
  // parágrafo recuado. Não há mais branch especial para "heading" porque
  // o ProseMirror do Badon descarta inline-styles e o resultado ficava
  // visualmente inconsistente (alguns parágrafos sem recuo).
  const rawBlocks = text.split(/\n{2,}/);

  const htmlBlocks: string[] = [];
  let pendingQuoteLines: string[] = [];

  const flushQuote = (): void => {
    if (pendingQuoteLines.length === 0) return;
    const inner = pendingQuoteLines
      .map((l) => formatInline(escapeHtml(l)))
      .join(' ');
    htmlBlocks.push(buildCitationParagraph(inner));
    pendingQuoteLines = [];
  };

  for (const rawBlock of rawBlocks) {
    const block = rawBlock.replace(/\r/g, '').trim();
    if (!block) continue;

    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    // Citação: todas as linhas começam com `> `.
    if (lines.every((l) => /^>\s?/.test(l))) {
      const cleaned = lines.map((l) => l.replace(/^>\s?/, '').trim()).join(' ');
      pendingQuoteLines.push(cleaned);
      continue;
    }
    flushQuote();

    // Linhas com marcadores markdown (heading `#`, lista `-`/`*`/`1.`) viram
    // parágrafos comuns após removidos os marcadores. Cada linha é um
    // parágrafo independente quando havia múltiplas linhas (ex.: lista).
    const stripped = lines.map((l) =>
      l
        .replace(/^#{1,6}\s+/, '')
        .replace(/^(?:[-*]|\d+\.)\s+/, '')
        .trim()
    );
    const looksLikeList = lines.some((l) => /^(?:[-*]|\d+\.)\s+/.test(l));

    if (looksLikeList) {
      for (const item of stripped) {
        if (item) {
          htmlBlocks.push(buildIndentedParagraph(formatInline(escapeHtml(item))));
        }
      }
    } else {
      // Parágrafo simples: funde quebras internas em espaço.
      const merged = stripped.join(' ');
      htmlBlocks.push(buildIndentedParagraph(formatInline(escapeHtml(merged))));
    }
  }
  flushQuote();

  return htmlBlocks.join('');
}

/**
 * Recuo implementado via `<blockquote>` aninhado.
 *
 * Histórico completo das tentativas e por que cada uma falhou:
 *
 *  1. `style="text-indent:2cm"` no `<p>` — schema do Badon descarta
 *     `style` inline.
 *  2. `<span style="display:inline-block;width:2cm">` — idem.
 *  3. NBSP (U+00A0), EM SPACE (U+2003), FIGURE SPACE (U+2007) repetidos
 *     como prefixo — todos pertencem aos intervalos que CSS Text spec
 *     define como expansíveis pelo `text-align: justify`, e o Badon
 *     aplica justify. Cada parágrafo recebia stretch diferente, recuos
 *     visualmente desiguais.
 *  4. `<ul><li>` aninhado — recuo perfeito, MAS Badon strippa
 *     `style="list-style:none"` e o bullet ficou visível, descaracterizando
 *     a peça.
 *
 * **Solução final: blockquote aninhado.** É nó padrão do ProseMirror
 * schema (visto na breadcrumb do Badon, junto com `bullet_list`), tem
 * `margin-left` nativo do user-agent stylesheet (~40px ≈ 1cm), NÃO tem
 * marcador visual algum, e é semanticamente neutro. Cada nível de
 * blockquote adiciona ~1cm:
 *  - Parágrafo regular: 2 níveis de blockquote ≈ 2cm
 *  - Citação textual:   4 níveis de blockquote ≈ 4cm + texto em <em>
 *
 * Como o recuo vem da estrutura de bloco (não de texto no fluxo), é
 * imune a justificação e fica pixel-perfect uniforme em todos os
 * parágrafos. Como blockquote é puramente estrutural, não há marcador
 * visual nem itálico/aspas automáticos no Badon (verificado via schema).
 */

/**
 * Formato CANÔNICO do parágrafo do Badon (TRF3, editor padrão do PJe 2.x).
 *
 * Descoberto via inspeção de DOM: o Badon usa a classe `bd-def-pp`
 * ("badon default paragraph") como nó de bloco principal. Quando o usuário
 * digita um parágrafo na peça, o HTML produzido é:
 *
 *   <p class="bd-def-pp" style="font-family: Arial; font-size: 12pt;
 *      text-indent: 0.98in; margin: 5mm 0.02in 5mm 0pt;
 *      line-height: 15.6pt; text-align: justify;">
 *     <span style="color: rgb(0, 0, 0);">texto</span>
 *   </p>
 *
 * Pontos-chave:
 *  - A CLASSE `bd-def-pp` é o que o schema do Badon valida; com ela
 *    presente, o style inline composto é preservado integralmente. Sem a
 *    classe, qualquer style era descartado nas tentativas anteriores.
 *  - `text-indent: 0.98in` ≈ 2,5cm é o recuo de 1ª linha padrão do TRF3
 *    para peças. Vamos manter exatamente esse valor para uniformidade
 *    com o resto da peça (caso o usuário misture parágrafos manuais).
 *  - O conteúdo de texto vai dentro de `<span style="color: rgb(0, 0, 0);">`
 *    — Badon usa essa marca para preservar a cor preta padrão (sem ela
 *    o texto pode herdar cor cinza de algum CSS pai).
 *  - `margin: 5mm 0.02in 5mm 0pt` cria espaçamento vertical de 5mm entre
 *    parágrafos — replicamos para que os parágrafos da IA fiquem com o
 *    mesmo arejamento dos manuais.
 *
 * Para citações longas (jurisprudência, lei): replicamos o `bd-def-pp`
 * mas trocamos `text-indent` por `margin-left` maior, recuando o BLOCO
 * inteiro. O texto ainda fica em `<em>` para diferenciar visualmente,
 * dentro do span de cor preta.
 */

const PARAGRAPH_STYLE =
  'font-family: Arial; font-size: 12pt; text-indent: 0.98in; ' +
  'margin: 5mm 0.02in 5mm 0pt; line-height: 15.6pt; text-align: justify;';

// Citação: réplica EXATA do que o Badon produz quando o usuário aplica
// o estilo de citação manualmente. Verificado por inspeção de DOM:
//
//   <p class="bd-def-citacao" style="font-family: Arial; font-size: 11pt;
//      text-indent: 0pt; margin: 5mm 0pt 5mm 0.98in; line-height: 13.2pt;
//      text-align: justify; font-style: italic;">
//     <span style="background-color: transparent;">
//       <span style="text-transform: inherit;">
//         <span style="color: black;">texto</span>
//       </span>
//     </span>
//   </p>
//
// Observações cruciais:
//  - Classe é `bd-def-citacao` (NÃO `bd-def-pp`). Nó dedicado do schema.
//  - margin-left = 0.98in (mesmo valor do text-indent do parágrafo
//    regular — recuo lateral que casa visualmente com a primeira linha
//    dos parágrafos comuns).
//  - margin-right = 0pt (NÃO recua à direita).
//  - font-style: italic é uma declaração no `<p>`, NÃO no span.
//  - O span tem 3 níveis aninhados: background-color → text-transform →
//    color. Esse é o "skin" que o schema exige; com menos níveis,
//    spans são reagrupados ou strippados.
const CITATION_STYLE =
  'font-family: Arial; font-size: 11pt; text-indent: 0pt; ' +
  'margin: 5mm 0pt 5mm 0.98in; line-height: 13.2pt; ' +
  'text-align: justify; font-style: italic;';

/**
 * Skin de spans aninhados que o Badon usa em todos os textos. Verificado
 * via inspeção: parágrafo manual gera `<span style="color: rgb(0,0,0);">`
 * simples, MAS citação manual gera 3 níveis aninhados
 * (background-color → text-transform → color). Para máxima compatibilidade
 * com o schema, ambos os construtores agora usam o skin completo.
 */
function wrapInBadonSpans(innerHtml: string): string {
  return (
    '<span style="background-color: transparent;">' +
    '<span style="text-transform: inherit;">' +
    '<span style="color: black;">' +
    innerHtml +
    '</span></span></span>'
  );
}

function buildIndentedParagraph(innerHtml: string): string {
  return (
    '<p class="bd-def-pp" style="' + PARAGRAPH_STYLE + '">' +
    wrapInBadonSpans(innerHtml) +
    '</p>'
  );
}

function buildCitationParagraph(innerHtml: string): string {
  return (
    '<p class="bd-def-citacao" style="' + CITATION_STYLE + '">' +
    wrapInBadonSpans(innerHtml) +
    '</p>'
  );
}

/**
 * Aplica formatação inline (negrito/itálico) sobre texto JÁ escapado.
 * Remove marcadores residuais que não viram nada visível.
 */
function formatInline(escaped: string): string {
  let out = escaped;
  // Negrito **...**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Itálico *...*  (cuidado para não casar dentro de **)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Inline code `...` → remove crases, mantém texto.
  out = out.replace(/`([^`]+)`/g, '$1');
  // Remove ~~strike~~ residual.
  out = out.replace(/~~([^~]+)~~/g, '$1');
  return out;
}

/** Converte texto para versão "plain" sem qualquer marcador de markdown. */
export function stripMarkdown(input: string): string {
  if (!input) return '';
  return input
    .replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}
