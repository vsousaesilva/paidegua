---
name: injecao-minuta-badon
description: Insere programaticamente texto/minutas no editor Badon (ProseMirror) do PJe 2.9.7+ a partir de extensão Chrome ou script. Use quando precisar injetar conteúdo em editor ProseMirror que reverte mutações de DOM, montar o paste sintético via ClipboardEvent, gerar HTML com as classes canônicas do Badon (bd-def-pp/bd-def-citacao) ou converter Markdown para o formato de peça judicial.
---

# Injeção de Minuta no Editor Badon (ProseMirror) do PJe

Conhecimento consolidado do projeto pAIdegua (JFCE) sobre inserção
programática de minutas no **Badon** — o editor introduzido no PJe 2.9.7+
(TRF5/JFCE), construído sobre **ProseMirror**.

## 1. A regra de ouro: ProseMirror reverte o que não controla

O ProseMirror mantém um `EditorState` como fonte de verdade e um
MutationObserver que **reverte silenciosamente** qualquer mutação externa de
DOM. Não funcionam: `innerHTML +=`, `appendChild`,
`document.execCommand('insertHTML')` — o conteúdo aparece por um frame e some
("DOM fantasma").

**O único caminho confiável sem acesso à instância EditorView é o paste
sintético**: o ProseMirror tem handler nativo de `paste` que lê
`clipboardData.getData('text/html')`, valida contra o schema e cria uma
transaction legítima.

```ts
const dt = new DataTransfer();
dt.setData('text/html', html);
dt.setData('text/plain', plain);
const evt = new ClipboardEvent('paste', {
  bubbles: true, cancelable: true, clipboardData: dt
});
// Alguns builds do Chrome ignoram clipboardData no construtor:
if (!evt.clipboardData) {
  Object.defineProperty(evt, 'clipboardData', { value: dt, writable: false });
}
editor.dispatchEvent(evt);
```

## 2. Preparação antes do paste

1. **O editor não existe até selecionar o tipo de ato.** O Badon é carregado
   via `A4J.AJAX.Submit` depois que o usuário escolhe
   Sentença/Decisão/Despacho no dropdown `selectMenuTipoDocumento`. Para
   automatizar: setar `select.value` + `dispatchEvent(new Event('change',
   {bubbles:true}))` e aguardar `.ProseMirror[contenteditable="true"]`
   aparecer por polling (300 ms, timeout ~8 s).
2. **Paginação: mire a última página visível.** O Badon renderiza um
   `.ProseMirror` por "página"; itere os candidatos de trás para frente e use
   o primeiro com `getBoundingClientRect().width > 0`. A primeira página
   costuma ser o cabeçalho.
3. **Posicione o cursor no final antes de colar** (append, não substituição):
   `range.selectNodeContents(editor); range.collapse(false)` — sem isso, uma
   seleção ativa do usuário seria sobrescrita pelo paste.
4. **Após inserir texto longo**, force `overflow-y: auto` na cadeia de
   ancestrais cujo `scrollHeight > clientHeight` e dispare `resize` (repita
   imediatamente, no próximo `requestAnimationFrame` e após 300 ms) — o Badon
   usa `overflow: visible` e o texto transborda sem scrollbar.

## 3. O HTML precisa das classes canônicas do Badon

O schema é rigoroso: descarta todo nó/atributo não reconhecido. Fracassam:
`style` inline em `<p>` sem classe reconhecida, spans com `display:
inline-block`, recuo por NBSP/EM SPACE (o `text-align: justify` expande esses
espaços e os recuos ficam desiguais), `<li style="list-style:none">` (o style
é strippado e o bullet aparece).

O que o schema preserva **com os inline styles** são as classes descobertas
por inspeção de peças digitadas manualmente:

### Parágrafo (`bd-def-pp`)

```html
<p class="bd-def-pp" style="font-family: Arial; font-size: 12pt;
   text-indent: 0.98in; margin: 5mm 0.02in 5mm 0pt;
   line-height: 15.6pt; text-align: justify;">
  <span style="background-color: transparent;"><span
    style="text-transform: inherit;"><span style="color: black;">
    Texto do parágrafo.
  </span></span></span>
</p>
```

### Citação (`bd-def-citacao`)

```html
<p class="bd-def-citacao" style="font-family: Arial; font-size: 11pt;
   text-indent: 0pt; margin: 5mm 0pt 5mm 0.98in;
   line-height: 13.2pt; text-align: justify; font-style: italic;">
  <span style="background-color: transparent;"><span
    style="text-transform: inherit;"><span style="color: black;">
    Texto da citação.
  </span></span></span>
</p>
```

- `text-indent: 0.98in` (~2,5 cm) é o recuo de primeira linha; a citação troca
  por `margin-left: 0.98in` (bloco inteiro recuado), 11 pt e itálico.
- **O "skin" de 3 spans aninhados** (`background-color` → `text-transform` →
  `color`) não é capricho: com menos níveis o parser reagrupa ou descarta os
  spans.

## 4. Conversão Markdown → HTML de peça judicial

Regras que funcionam (a IA gera Markdown; peça judicial não usa hierarquia
HTML semântica):

| Markdown | Saída |
|---|---|
| Parágrafo | `<p class="bd-def-pp">` |
| `> citação` | `<p class="bd-def-citacao">` |
| `# Título`, `- item`, `1. item` | parágrafo comum (sem `<h1>`, sem bullet) |
| `**negrito**` / `*itálico*` | `<strong>` / `<em>` (o schema preserva) |
| `` `código` ``, `~~tachado~~`, blocos ``` | texto puro, marcadores removidos |
| quebra simples de linha | fundida em espaço (parágrafo é a unidade) |

Escape de HTML (`& < > " '`) antes da formatação inline.

## 5. Cadeia de fallback de editores

Detecte nesta ordem e insira conforme o tipo:

1. **Badon/ProseMirror** (`.ProseMirror[contenteditable="true"]`) → paste
   sintético (acima).
2. **CKEditor 4** (`iframe.cke_wysiwyg_frame`, PJe antigo) →
   `execCommand('insertHTML')` no documento do iframe.
3. **Contenteditable genérico** (> 200×80 px) → paste sintético, com
   `execCommand` como fallback.
4. **Textarea visível** (último recurso) → texto plano no `value`.

## 6. Riscos conhecidos

- As classes `bd-def-*` e o skin de spans vieram de inspeção de DOM, não de
  documentação — atualização do Badon pode mudá-los. Verifique os seletores a
  cada inserção e caia no contenteditable genérico se o padrão sumir.
- O `Object.defineProperty` sobre `clipboardData` é um hack que builds futuros
  do Chrome podem bloquear.
- Timeout de 8 s pode ser curto em rede interna lenta — em falha, retorne
  controle ao usuário (inserção manual) em vez de bloquear.
- Evolução possível: expor o `EditorView` via ponte MAIN world e inserir com
  `view.dispatch(tr)` — caminho mais robusto que o paste sintético.
