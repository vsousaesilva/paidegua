/**
 * Bridge para inserir conteúdo do chat no editor do PJe.
 *
 * O PJe historicamente usa **CKEditor 4** (iframe `cke_wysiwyg_frame`) na tela
 * de minutar peças. A partir do PJe 2.9.7+, o TRF3 introduziu o **Badon**
 * (https://www.badon.app/) — um editor baseado em ProseMirror, sem iframe,
 * com paginação client-side. ProseMirror reverte qualquer mutação direta do
 * DOM via MutationObserver, então a inserção *precisa* passar por um evento
 * de paste sintético — não dá para usar `appendChild` ou `insertHTML`.
 *
 * Estratégia de detecção (em ordem):
 *  1. **ProseMirror / Badon**: `.ProseMirror[contenteditable="true"]`. Se
 *     houver várias páginas (paginação do Badon), prioriza a última visível.
 *     Inserção: dispatch de `ClipboardEvent('paste')` com `DataTransfer`
 *     contendo `text/html` e `text/plain` — handler nativo do ProseMirror
 *     faz o parsing pelo schema.
 *  2. **CKEditor 4 (iframe)**: `iframe.cke_wysiwyg_frame`. Inserção via
 *     `execCommand('insertHTML')` no contentDocument do iframe.
 *  3. **Contenteditable genérico**: `[contenteditable="true"]` grande e
 *     visível. Tenta paste sintético e cai para `execCommand`.
 *  4. **Textarea**: último recurso, insere como texto plano (markdown cru).
 *
 * Funções puras, sem estado — cada chamada re-descobre o editor atual.
 */

// ---------------------------------------------------------------------------
// Tipo de ato no seletor do PJe (tela de minutar peça)
// ---------------------------------------------------------------------------

/**
 * Valores do <select> de tipo de documento na tela de minuta do PJe.
 * O seletor é identificado por um `id` que contém "selectMenuTipoDocumento".
 *
 * O valor "noSelection" corresponde ao placeholder "Selecione" e indica que
 * o usuário ainda não escolheu — o editor Badon só é carregado após uma
 * opção real ser selecionada.
 */
type PJeTipoDocumentoValue = '0' | '1' | '2'; // Decisão | Despacho | Sentença

/**
 * Mapeia action IDs do pAIdegua ao valor correspondente do <select> de tipo
 * de ato na tela de minuta do PJe. Ações de 1º e 2º grau são cobertas.
 */
const ACTION_TO_TIPO_DOC: Record<string, PJeTipoDocumentoValue> = {
  // 1º grau
  'sentenca-procedente': '2',
  'sentenca-improcedente': '2',
  'decidir': '0',
  'converter-diligencia': '1',
  'despachar': '1',
  // 2º grau / turmas recursais
  'voto-mantem': '0',
  'voto-reforma': '0',
  'decisao-nega-seguimento': '0',
  'decisao-2g': '0',
  'converter-diligencia-baixa': '1',
  'despachar-2g': '1',
  // Triagem inteligente (Secretaria) — emenda à inicial é ato judicial
  // de impulsionamento, vai como Despacho.
  'emenda-inicial': '1'
};

/**
 * Localiza o <select> de tipo de documento na tela de minuta do PJe.
 * O seletor tem um `id` que contém "selectMenuTipoDocumento" — essa
 * substring é estável entre versões do PJe.
 */
function findTipoDocumentoSelect(): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>(
    'select[id*="selectMenuTipoDocumento"]'
  );
}

/**
 * Garante que o tipo de ato correto esteja selecionado no dropdown do PJe
 * antes de inserir a minuta. Fluxo:
 *
 *  1. Procura o <select> pelo seletor parcial de id.
 *  2. Se o valor já é o desejado → retorna imediatamente (sem AJAX).
 *  3. Se o valor é diferente (ou "Selecione") → altera o valor e dispara
 *     o `onchange` nativo, que aciona o A4J.AJAX.Submit do PJe para
 *     carregar o editor Badon.
 *  4. Aguarda até o editor ProseMirror aparecer no DOM (polling com
 *     timeout de 8s) — o AJAX do PJe é lento em alguns ambientes.
 *
 * Retorna `true` se o tipo já estava correto ou foi selecionado com sucesso
 * e o editor apareceu. Retorna `false` se o select não foi encontrado ou o
 * editor não carregou dentro do timeout (nesse caso, o chamador deve
 * prosseguir sem bloqueio — inserção manual ainda é possível).
 */
export async function ensureTipoDocumentoSelected(actionId: string): Promise<boolean> {
  const targetValue = ACTION_TO_TIPO_DOC[actionId];
  if (!targetValue) return true; // ação não mapeada — não interfere

  const select = findTipoDocumentoSelect();
  if (!select) return true; // select não encontrado — pode ser outra tela

  // Já está no valor certo?
  if (select.value === targetValue) return true;

  // Altera o valor e dispara o onchange nativo para acionar o AJAX do PJe.
  select.value = targetValue;
  select.dispatchEvent(new Event('change', { bubbles: true }));

  // Aguarda o editor Badon (ProseMirror) aparecer após o AJAX. O PJe troca
  // a região "movimentarRegion" e renderiza o editor dentro dela.
  const editorReady = await waitForEditor(8000);
  return editorReady;
}

/**
 * Aguarda até que um editor ProseMirror ou CKEditor apareça no DOM,
 * com polling a cada 300ms até o timeout.
 */
function waitForEditor(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = (): void => {
      // Verifica se algum editor já está disponível
      if (
        document.querySelector('.ProseMirror[contenteditable="true"]') ||
        document.querySelector('iframe.cke_wysiwyg_frame')
      ) {
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 300);
    };
    check();
  });
}

export type PJeEditorKind =
  | 'badon-prosemirror'
  | 'ckeditor4-iframe'
  | 'contenteditable'
  | 'textarea'
  /**
   * Visualização somente-leitura do documento (`div.folha`) — o outro modo
   * pelo qual o magistrado enxerga a minuta no PJe. Só existe para LEITURA
   * (análise preditiva); a inserção nunca mira este alvo.
   */
  | 'folha-visualizacao'
  | 'none';

export interface PJeEditorDetection {
  available: boolean;
  kind: PJeEditorKind;
}

/**
 * Verifica se há um editor do PJe disponível para inserção. Não mantém
 * cache porque o usuário pode navegar entre abas dentro do PJe.
 */
export function detectPJeEditor(): PJeEditorDetection {
  if (findProseMirrorEditor()) {
    return { available: true, kind: 'badon-prosemirror' };
  }
  if (findCkeIframe()) {
    return { available: true, kind: 'ckeditor4-iframe' };
  }
  if (findContentEditable()) {
    return { available: true, kind: 'contenteditable' };
  }
  if (findFocusableTextarea()) {
    return { available: true, kind: 'textarea' };
  }
  return { available: false, kind: 'none' };
}

/**
 * Insere HTML no editor ativo do PJe. Devolve `true` em caso de sucesso.
 * `plainFallback` é usado quando o destino não aceita HTML (textarea).
 */
export function insertIntoPJeEditor(html: string, plainFallback: string): boolean {
  const pm = findProseMirrorEditor();
  if (pm) {
    return insertIntoProseMirror(pm, html, plainFallback);
  }
  const cke = findCkeIframe();
  if (cke) {
    return insertIntoCkeIframe(cke, html);
  }
  const editable = findContentEditable();
  if (editable) {
    return insertIntoContentEditable(editable, html);
  }
  const textarea = findFocusableTextarea();
  if (textarea) {
    return insertIntoTextarea(textarea, plainFallback);
  }
  return false;
}

// ---------------------------------------------------------------------------
// ProseMirror / Badon (PJe 2.9.7+)
// ---------------------------------------------------------------------------

/**
 * Localiza o editor Badon na página. ProseMirror sempre adiciona a classe
 * `ProseMirror` no elemento contenteditable raiz, então esse seletor é
 * estável independentemente do wrapper que o Badon use ao redor.
 *
 * Quando há paginação (várias páginas dentro do mesmo editor), prioriza a
 * última página visível — geralmente é onde o cursor está e onde o usuário
 * espera o conteúdo aparecer.
 */
function findProseMirrorEditor(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('.ProseMirror[contenteditable="true"]')
  );
  if (candidates.length === 0) {
    // Fallback: alguns wrappers podem usar contenteditable="" (string vazia).
    const loose = Array.from(
      document.querySelectorAll<HTMLElement>('.ProseMirror')
    ).filter((el) => el.isContentEditable);
    if (loose.length === 0) {
      return null;
    }
    return loose[loose.length - 1] ?? null;
  }
  // Prioriza a última página visível (paginação Badon).
  for (let i = candidates.length - 1; i >= 0; i--) {
    const el = candidates[i]!;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return el;
    }
  }
  return candidates[candidates.length - 1] ?? null;
}

/**
 * Insere HTML em um editor ProseMirror via paste sintético. ProseMirror tem
 * um handler nativo de `paste` que lê `clipboardData.getData('text/html')`
 * e parseia o HTML pelo schema do editor — esse é o caminho oficial e o que
 * o Badon usa internamente quando o usuário cola conteúdo.
 *
 * Mutações diretas (innerHTML, appendChild, execCommand) NÃO funcionam: o
 * MutationObserver do ProseMirror reverte qualquer mudança que não tenha
 * passado pelo seu pipeline de transactions.
 */
function insertIntoProseMirror(
  editor: HTMLElement,
  html: string,
  plain: string
): boolean {
  try {
    editor.focus();

    // Posiciona o caret no fim do conteúdo atual antes de "colar" — assim
    // o conteúdo gerado pela IA é apendado, não substitui a seleção atual.
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/html', html);
    dataTransfer.setData('text/plain', plain);

    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    });

    // Alguns builds do Chrome ignoram o `clipboardData` passado no construtor
    // do ClipboardEvent (read-only). Como fallback, sobrescrevemos a property
    // diretamente — o ProseMirror lê via `event.clipboardData`.
    if (!pasteEvent.clipboardData) {
      try {
        Object.defineProperty(pasteEvent, 'clipboardData', {
          value: dataTransfer,
          writable: false
        });
      } catch {
        /* ignore */
      }
    }

    editor.dispatchEvent(pasteEvent);

    // Força a scrollbar no iframe do editor. O body do iframe tem
    // overflow:visible por padrão — quando o conteúdo excede a área
    // visível após o paste, setamos overflow-y:auto para a scrollbar
    // nativa aparecer.
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    const enableScrollbar = (el: HTMLElement): void => {
      const doc = el.ownerDocument;
      const body = doc.body;
      if (body && body.scrollHeight > body.clientHeight + 10) {
        body.style.overflowY = 'auto';
      }
      const html = doc.documentElement;
      if (html && html.scrollHeight > html.clientHeight + 10) {
        html.style.overflowY = 'auto';
      }
      let target: HTMLElement | null = el;
      while (target) {
        if (target.scrollHeight > target.clientHeight + 10) {
          target.style.overflowY = 'auto';
        }
        target = target.parentElement;
      }
      window.dispatchEvent(new Event('resize'));
    };

    enableScrollbar(editor);
    requestAnimationFrame(() => enableScrollbar(editor));
    setTimeout(() => enableScrollbar(editor), 300);

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CKEditor 4 (iframe wysiwyg)
// ---------------------------------------------------------------------------

function findCkeIframe(): HTMLIFrameElement | null {
  // Procura no documento atual e em frames aninhados comuns no PJe.
  const iframes = Array.from(
    document.querySelectorAll<HTMLIFrameElement>('iframe.cke_wysiwyg_frame')
  );
  for (const iframe of iframes) {
    try {
      if (iframe.contentDocument?.body) {
        return iframe;
      }
    } catch {
      // Cross-origin — ignora.
    }
  }
  return null;
}

function insertIntoCkeIframe(iframe: HTMLIFrameElement, html: string): boolean {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win || !doc.body) {
    return false;
  }

  try {
    doc.body.focus();

    // Posiciona o caret no final do body antes de inserir.
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    range.collapse(false);
    const sel = win.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // execCommand está deprecated no padrão, mas é a forma oficial de
    // interagir com CKEditor 4 via edição no iframe — o editor monitora
    // mudanças do body e integra no histórico de undo.
    const wrapped = `<div>${html}</div>`;
    const ok = doc.execCommand('insertHTML', false, wrapped);
    if (ok) {
      doc.body.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    // Fallback manual: escreve diretamente no final do body.
    const tmp = doc.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) {
      doc.body.appendChild(tmp.firstChild);
    }
    doc.body.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Contenteditable genérico (CKEditor 5 inline, Quill, etc.)
// ---------------------------------------------------------------------------

function findContentEditable(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[contenteditable="true"], [contenteditable=""]'
    )
  );
  // Preferir elementos visíveis e razoavelmente grandes (filtra rich-text
  // inputs minúsculos de outras partes da UI).
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 80) {
      return el;
    }
  }
  return candidates[0] ?? null;
}

function insertIntoContentEditable(el: HTMLElement, html: string): boolean {
  try {
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const ok = document.execCommand('insertHTML', false, html);
    if (ok) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    // Fallback: append direto.
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) {
      el.appendChild(tmp.firstChild);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Textarea fallback (último recurso — insere como texto plano)
// ---------------------------------------------------------------------------

function findFocusableTextarea(): HTMLTextAreaElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) {
    return active;
  }
  // Heurística fraca: primeiro textarea grande visível.
  const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'));
  for (const t of textareas) {
    const rect = t.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 60 && !t.disabled && !t.readOnly) {
      return t;
    }
  }
  return null;
}

function insertIntoTextarea(textarea: HTMLTextAreaElement, plain: string): boolean {
  try {
    textarea.focus();
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + plain + after;
    const caret = start + plain.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Leitura da minuta (análise preditiva)
// ---------------------------------------------------------------------------

/**
 * Abaixo deste tamanho o conteúdo é tratado como "sem minuta" — editor
 * recém-aberto, vazio ou com apenas o cabeçalho automático do PJe.
 */
export const MINUTA_MIN_CHARS = 200;

/**
 * Teto de leitura (~25k tokens). Minutas acima disso são truncadas
 * preservando início (relatório) e fim (dispositivo), que concentram o
 * que interessa à análise.
 */
export const MINUTA_MAX_CHARS = 100_000;

export interface PJeEditorContent {
  ok: boolean;
  kind: PJeEditorKind;
  /** Texto puro (innerText — preserva quebras visuais de parágrafo). */
  text: string;
  /** HTML bruto do editor, apenas para depuração/uso futuro. */
  html: string;
  chars: number;
  /** true quando o texto foi cortado no teto MINUTA_MAX_CHARS. */
  truncado: boolean;
  /** Quantas "páginas" ProseMirror foram concatenadas (diagnóstico Badon). */
  paginas: number;
}

const CONTEUDO_VAZIO: PJeEditorContent = {
  ok: false,
  kind: 'none',
  text: '',
  html: '',
  chars: 0,
  truncado: false,
  paginas: 0
};

/**
 * O conteúdo lido é suficiente para análise?
 *
 * Editores exigem o piso de `MINUTA_MIN_CHARS`: um editor recém-aberto tem
 * poucos caracteres, e habilitar o botão ali seria ruído. A visualização
 * `folha` não — se há texto renderizado, há um documento de verdade (folha
 * em branco não tem texto algum). De quebra, o piso alto na `folha`
 * inviabilizaria qualquer teste no ambiente evolutiva, onde o conteúdo dos
 * documentos foi substituído por um aviso curto do administrador.
 */
export function minutaSuficiente(c: PJeEditorContent): boolean {
  if (!c.ok) return false;
  return c.kind === 'folha-visualizacao'
    ? c.chars > 0
    : c.chars >= MINUTA_MIN_CHARS;
}

/**
 * Iframes de um documento, incluindo os escondidos em shadow roots ABERTOS.
 *
 * Não é excesso de zelo: no PJe ng2 (TRF5), o componente do editor Badon cria
 * o iframe do conteúdo (`about:blank`) dentro de um shadow root — um
 * `querySelectorAll('iframe')` comum no frame pai devolve zero e o editor
 * fica invisível para a varredura. Shadow root FECHADO continua inalcançável
 * por aqui; esse caso é coberto pelo `match_origin_as_fallback` do manifest,
 * que injeta o content script dentro do próprio frame `about:blank`.
 */
function coletarIframesComShadow(root: ParentNode): HTMLIFrameElement[] {
  const out = Array.from(root.querySelectorAll('iframe'));
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const sombra = (el as HTMLElement).shadowRoot;
    if (sombra) out.push(...coletarIframesComShadow(sombra));
  }
  return out;
}

/**
 * Documento de topo do frame atual + documentos de iframes same-origin,
 * recursivamente (em largura, na ordem do DOM).
 *
 * Indispensável para a LEITURA: no Painel do usuário do PJe
 * (`painel-usuario-interno`), a tarefa — e com ela o editor da minuta — é
 * renderizada dentro de iframes aninhados, e a sidebar vive no frame de topo.
 * Um `querySelectorAll` no `document` de topo nunca encontra o editor, mesmo
 * com ele visível na tela. A escrita não tem esse problema porque chega por
 * mensagem a todos os frames e cada instância tenta localmente; a leitura do
 * gating roda só onde a sidebar está.
 *
 * Iframe cross-origin lança ao tocar `contentDocument` — capturado e ignorado
 * (o botão simplesmente não habilita, mesmo comportamento da inserção).
 */
export function coletarDocumentosAcessiveis(): Document[] {
  const docs: Document[] = [];
  const fila: Document[] = [document];
  // Teto defensivo: páginas do PJe têm poucos iframes; dezenas indicam algo
  // patológico e não vale a pena varrer.
  const MAX_DOCS = 20;
  while (fila.length && docs.length < MAX_DOCS) {
    const doc = fila.shift();
    if (!doc || docs.includes(doc)) continue;
    docs.push(doc);
    for (const iframe of coletarIframesComShadow(doc)) {
      try {
        const interno = iframe.contentDocument;
        if (interno) fila.push(interno);
      } catch {
        /* cross-origin */
      }
    }
  }
  return docs;
}

/**
 * Lê o conteúdo da minuta aberta no editor do PJe — espelho de leitura de
 * `insertIntoPJeEditor`. Ao contrário da escrita (que mira a última página
 * visível do Badon, onde está o cursor), a leitura precisa do documento
 * INTEIRO: coleta todas as páginas ProseMirror na ordem do DOM e concatena.
 * Se o Badon usar um único contenteditable, o resultado é idêntico
 * (`paginas: 1`).
 *
 * A varredura cobre o documento atual e os iframes same-origin — ver
 * `coletarDocumentosAcessiveis`.
 */
export function readFromPJeEditor(): PJeEditorContent {
  const docs = coletarDocumentosAcessiveis();

  // Cada fonte só "vence" se tiver TEXTO. Um editor Badon presente no DOM
  // porém vazio (componente montado com o editor fechado, ou minuta ainda em
  // branco) não pode encerrar a busca — a mesma tela pode ter a visualização
  // `folha` com o documento inteiro logo ao lado.
  const pm = collectProseMirrorPages(docs);
  if (pm.length > 0) {
    const text = pm.map((el) => el.innerText).join('\n\n').trim();
    if (text) {
      const html = pm.map((el) => el.innerHTML).join('\n');
      return montarConteudo('badon-prosemirror', text, html, pm.length);
    }
  }

  for (const doc of docs) {
    for (const iframe of Array.from(
      doc.querySelectorAll<HTMLIFrameElement>('iframe.cke_wysiwyg_frame')
    )) {
      try {
        const body = iframe.contentDocument?.body;
        const text = body?.innerText.trim();
        if (body && text) {
          return montarConteudo('ckeditor4-iframe', text, body.innerHTML, 1);
        }
      } catch {
        /* cross-origin — segue procurando */
      }
    }
  }

  // Visualização somente-leitura (`div.folha`): o PJe renderiza o documento
  // assinado/salvo nesse contêiner quando a tela não está em modo de edição.
  // Para a análise preditiva o conteúdo vale tanto quanto o do editor — o
  // magistrado frequentemente analisa a minuta por esta visão. Uma `folha`
  // por página; concatenamos na ordem do DOM, como no Badon.
  for (const doc of docs) {
    const folhas = Array.from(doc.querySelectorAll<HTMLElement>('div.folha'));
    if (folhas.length) {
      const text = folhas.map((f) => f.innerText).join('\n\n').trim();
      if (text) {
        const html = folhas.map((f) => f.innerHTML).join('\n');
        return montarConteudo('folha-visualizacao', text, html, folhas.length);
      }
    }
  }

  for (const doc of docs) {
    const editable = encontrarContentEditableEm(doc);
    const text = editable?.innerText.trim();
    if (editable && text) {
      return montarConteudo('contenteditable', text, editable.innerHTML, 1);
    }
  }

  for (const doc of docs) {
    const textarea = encontrarTextareaEm(doc);
    const text = textarea?.value.trim();
    if (textarea && text) {
      return montarConteudo('textarea', text, '', 1);
    }
  }

  return CONTEUDO_VAZIO;
}

/**
 * Todas as páginas ProseMirror na ordem dos documentos varridos. Inclui o
 * fallback de `contenteditable=""` usado por alguns wrappers (mesma
 * tolerância de `findProseMirrorEditor`).
 */
function collectProseMirrorPages(docs: Document[]): HTMLElement[] {
  for (const doc of docs) {
    const strict = Array.from(
      doc.querySelectorAll<HTMLElement>('.ProseMirror[contenteditable="true"]')
    );
    if (strict.length > 0) return strict;
    const loose = Array.from(doc.querySelectorAll<HTMLElement>('.ProseMirror')).filter(
      (el) => el.isContentEditable
    );
    if (loose.length > 0) return loose;
  }
  return [];
}

/** Como `findContentEditable`, mas num documento específico. */
function encontrarContentEditableEm(doc: Document): HTMLElement | null {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>('[contenteditable="true"], [contenteditable=""]')
  );
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 80) {
      return el;
    }
  }
  return null;
}

/** Como `findFocusableTextarea`, mas num documento específico e sem exigir foco. */
function encontrarTextareaEm(doc: Document): HTMLTextAreaElement | null {
  const active = doc.activeElement;
  if (active instanceof HTMLTextAreaElement) {
    return active;
  }
  for (const t of Array.from(doc.querySelectorAll<HTMLTextAreaElement>('textarea'))) {
    const rect = t.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 60 && !t.disabled && !t.readOnly) {
      return t;
    }
  }
  return null;
}

function montarConteudo(
  kind: PJeEditorKind,
  text: string,
  html: string,
  paginas: number
): PJeEditorContent {
  const truncado = text.length > MINUTA_MAX_CHARS;
  const finalText = truncado ? truncarPreservandoExtremos(text, MINUTA_MAX_CHARS) : text;
  return {
    ok: finalText.length > 0,
    kind,
    text: finalText,
    html,
    chars: finalText.length,
    truncado,
    paginas
  };
}

/**
 * Trunca preservando início e fim do texto — o relatório e o dispositivo
 * ficam nas extremidades da minuta; o miolo é o que menos falta faz.
 *
 * Exportada porque a análise preditiva aplica o mesmo teto à versão
 * FORMATADA da minuta (markdown derivado do HTML), que é maior que o texto.
 */
export function truncarPreservandoExtremos(text: string, maxChars: number): string {
  const marcador = '\n\n[... trecho intermediário omitido ...]\n\n';
  const orcamento = maxChars - marcador.length;
  const inicio = Math.ceil(orcamento * 0.6);
  const fim = orcamento - inicio;
  return text.slice(0, inicio) + marcador + text.slice(text.length - fim);
}