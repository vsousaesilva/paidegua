# Injeção de Minuta no Editor Badon (ProseMirror)

**Projeto:** pAIdegua — Assistente IA para o PJe  
**Data:** Abril/2026  
**Contexto:** Extensão Chrome MV3 para inserção automatizada de minutas geradas por IA no editor Badon do PJe (TRF5/JFCE)

---

## 1. Visão Geral da Arquitetura

### 1.1 O editor: Badon (ProseMirror) no PJe 2.9.7+

A partir do PJe 2.9.7, o TRF3 introduziu o **Badon** (https://www.badon.app/) como editor de minutas. O Badon é construído sobre o **ProseMirror** — um framework de edição rico que controla o DOM via um modelo de estado interno (EditorState) e reverte qualquer mutação externa via MutationObserver.

Diferente do CKEditor 4 (que usava um iframe `cke_wysiwyg_frame` e permitia manipulação direta do DOM), o Badon exige que toda modificação passe por seu pipeline de transactions. Isso significa que **técnicas tradicionais de inserção de HTML simplesmente não funcionam**.

### 1.2 Cadeia de editores suportados (fallback)

A extensão detecta e insere conteúdo em 4 tipos de editor, nesta ordem de prioridade:

```
┌─────────────────────────────────────────────────────┐
│  1. ProseMirror / Badon (PJe 2.9.7+)               │
│     Seletor: .ProseMirror[contenteditable="true"]   │
│     Inserção: ClipboardEvent('paste') sintético     │
├─────────────────────────────────────────────────────┤
│  2. CKEditor 4 (iframe)                             │
│     Seletor: iframe.cke_wysiwyg_frame               │
│     Inserção: execCommand('insertHTML')              │
├─────────────────────────────────────────────────────┤
│  3. Contenteditable genérico                        │
│     Seletor: [contenteditable="true"] (>200×80px)   │
│     Inserção: paste sintético → execCommand fallback │
├─────────────────────────────────────────────────────┤
│  4. Textarea (último recurso)                       │
│     Seletor: textarea visível (>200×60px)            │
│     Inserção: texto plano (markdown cru)             │
└─────────────────────────────────────────────────────┘
```

### 1.3 Fluxo completo de injeção

```
1. SELEÇÃO DE TIPO DE ATO (ensureTipoDocumentoSelected)
   actionId → ACTION_TO_TIPO_DOC → valor do <select>
   ├─ Se já está no valor correto → prossegue
   └─ Se não → altera select.value + dispatchEvent('change')
      └─ PJe dispara A4J.AJAX.Submit → carrega editor Badon
         └─ Polling 300ms até 8s pelo .ProseMirror no DOM

2. DETECÇÃO DE EDITOR (detectPJeEditor)
   Testa ProseMirror → CKEditor4 → contenteditable → textarea
   ↓ Retorna { available: boolean, kind: PJeEditorKind }

3. CONVERSÃO DE CONTEÚDO (renderForPJe)
   Markdown da IA → HTML com classes Badon (bd-def-pp / bd-def-citacao)
   ├─ Parágrafos → <p class="bd-def-pp"> com text-indent 0.98in
   ├─ Citações (> ) → <p class="bd-def-citacao"> com margin-left 0.98in
   └─ Listas/cabeçalhos → parágrafos comuns (sem marcadores)

4. INSERÇÃO (insertIntoPJeEditor)
   ├─ Badon: ClipboardEvent('paste') com DataTransfer
   ├─ CKEditor4: execCommand('insertHTML') no iframe
   ├─ Contenteditable: paste sintético → execCommand fallback
   └─ Textarea: inserção de texto plano no value
```

---

## 2. Descobertas Técnicas (Sacadas)

### 2.1 ProseMirror reverte mutações diretas — o "DOM fantasma"

**Esta foi a descoberta central que definiu toda a estratégia de inserção.**

O ProseMirror mantém um modelo de estado (`EditorState`) que é a fonte de verdade. Qualquer alteração no DOM que não tenha passado pelo pipeline de transactions é detectada pelo MutationObserver interno e **revertida silenciosamente**. Isso significa que:

- `element.innerHTML += '<p>texto</p>'` → é revertido
- `element.appendChild(node)` → é revertido
- `document.execCommand('insertHTML', ...)` → é revertido

O conteúdo aparece por um frame e desaparece. É o "DOM fantasma": visível por milissegundos, depois sumido.

**Solução:** O ProseMirror tem um handler nativo de `paste` que lê `clipboardData.getData('text/html')`, parseia o HTML pelo schema do editor, e cria uma transaction válida. Simular um `ClipboardEvent('paste')` com `DataTransfer` contendo HTML é o **único caminho confiável** para inserção programática sem acesso à instância EditorView.

### 2.2 O paste sintético — construção do ClipboardEvent

A inserção no Badon usa um `ClipboardEvent` fabricado:

```typescript
const dataTransfer = new DataTransfer();
dataTransfer.setData('text/html', html);
dataTransfer.setData('text/plain', plain);

const pasteEvent = new ClipboardEvent('paste', {
  bubbles: true,
  cancelable: true,
  clipboardData: dataTransfer
});

editor.dispatchEvent(pasteEvent);
```

**Problema descoberto:** Alguns builds do Chrome marcam `clipboardData` como read-only no construtor do `ClipboardEvent`, ignorando o valor passado. O fallback é sobrescrever a property via `Object.defineProperty`:

```typescript
if (!pasteEvent.clipboardData) {
  Object.defineProperty(pasteEvent, 'clipboardData', {
    value: dataTransfer,
    writable: false
  });
}
```

Isso garante que `event.clipboardData.getData('text/html')` retorne o HTML da minuta quando o ProseMirror processar o evento.

### 2.3 Posicionamento do cursor — append, não substituição

Antes de disparar o paste, o cursor é posicionado no **final** do conteúdo existente. Se o editor já tiver texto (por exemplo, o cabeçalho da peça), a minuta é adicionada após, sem substituir nada:

```typescript
const sel = window.getSelection();
const range = document.createRange();
range.selectNodeContents(editor);
range.collapse(false); // false = colapsa no final
sel.removeAllRanges();
sel.addRange(range);
```

Sem isso, se o usuário tiver uma seleção ativa, o paste substituiria o trecho selecionado — comportamento indesejado e potencialmente destrutivo.

### 2.4 Paginação do Badon — última página visível

O Badon implementa paginação client-side: o editor renderiza múltiplos elementos `.ProseMirror[contenteditable="true"]`, cada um representando uma "página" da peça. A detecção prioriza a **última página visível** (com `getBoundingClientRect().width > 0`), que é geralmente onde o cursor está:

```typescript
for (let i = candidates.length - 1; i >= 0; i--) {
  const rect = candidates[i].getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return candidates[i];
  }
}
```

Sem essa lógica, a minuta poderia ser injetada na primeira página (frequentemente o cabeçalho ou ementa), que não é onde o conteúdo da decisão deve ficar.

### 2.5 Seleção de tipo de ato — trigger do carregamento do editor

O editor Badon **não está presente na página** quando ela carrega. Ele só é renderizado após o usuário selecionar o tipo de ato (Sentença, Decisão, Despacho) no dropdown `selectMenuTipoDocumento`. Esse dropdown dispara um `A4J.AJAX.Submit` (Ajax4JSF) que recarrega a região `movimentarRegion` com o editor.

A extensão automatiza essa seleção:

1. Mapeia a ação do pAIdegua ao valor do dropdown:
   - `sentenca-procedente` / `sentenca-improcedente` → `'2'` (Sentença)
   - `decidir` / `voto-mantem` / `voto-reforma` → `'0'` (Decisão)
   - `converter-diligencia` / `despachar` → `'1'` (Despacho)
2. Altera `select.value` e dispara `new Event('change', { bubbles: true })`
3. Aguarda o editor aparecer via polling (300ms entre tentativas, timeout de 8 segundos)

**Risco:** Se o AJAX do PJe estiver lento (rede interna congestionada), os 8 segundos podem não ser suficientes. Nesse caso, a função retorna `false` e o chamador prossegue sem bloqueio — o usuário pode selecionar manualmente e reinserir.

### 2.6 Scrollbar após inserção — overflow do Badon

Após a inserção de uma minuta longa, o conteúdo pode exceder a área visível do editor. O Badon/PJe configura `overflow: visible` por padrão no body do iframe, o que significa que o texto simplesmente transborda sem scrollbar.

A solução é forçar `overflow-y: auto` em toda a cadeia de ancestrais do editor:

```typescript
let target = editor;
while (target) {
  if (target.scrollHeight > target.clientHeight + 10) {
    target.style.overflowY = 'auto';
  }
  target = target.parentElement;
}
window.dispatchEvent(new Event('resize'));
```

A chamada é feita 3 vezes (imediatamente, no próximo `requestAnimationFrame`, e após 300ms) para garantir que a scrollbar apareça mesmo que o ProseMirror rearranje o layout após o paste.

---

## 3. Formato HTML do Badon — As Classes Canônicas

### 3.1 O problema: ProseMirror strippa tudo

O schema do ProseMirror no Badon é rigoroso. Ao processar HTML colado, ele valida cada nó e atributo contra seu schema interno. Tudo que não é reconhecido é descartado. Isso invalida abordagens convencionais de formatação.

### 3.2 Histórico de tentativas fracassadas

| # | Abordagem | Resultado |
|---|---|---|
| 1 | `style="text-indent:2cm"` no `<p>` | Schema descarta `style` inline em `<p>` sem classe reconhecida |
| 2 | `<span style="display:inline-block;width:2cm">` | Idem — span com display block é strippado |
| 3 | NBSP (U+00A0), EM SPACE (U+2003), FIGURE SPACE (U+2007) como prefixo | `text-align: justify` do Badon expande esses espaços — recuos ficam desiguais entre parágrafos |
| 4 | `<ul><li style="list-style:none">` | Badon preserva a `<li>` mas strippa `list-style:none` — bullet fica visível, descaracterizando a peça |

### 3.3 A solução: classes `bd-def-pp` e `bd-def-citacao`

Por inspeção do DOM de peças digitadas manualmente no Badon, foram descobertas duas classes canônicas que o schema reconhece e preserva **com todos os seus inline styles**:

#### Parágrafo regular (`bd-def-pp`)

```html
<p class="bd-def-pp" style="font-family: Arial; font-size: 12pt;
   text-indent: 0.98in; margin: 5mm 0.02in 5mm 0pt;
   line-height: 15.6pt; text-align: justify;">
  <span style="background-color: transparent;">
    <span style="text-transform: inherit;">
      <span style="color: black;">
        Texto do parágrafo aqui.
      </span>
    </span>
  </span>
</p>
```

Características:
- **`text-indent: 0.98in`** ≈ 2,5cm — recuo de primeira linha padrão do TRF3
- **`margin: 5mm 0.02in 5mm 0pt`** — espaçamento vertical de 5mm entre parágrafos
- **Arial 12pt** com `text-align: justify`
- **Spans aninhados em 3 níveis** (background-color → text-transform → color) — esse é o "skin" que o schema exige

#### Citação (`bd-def-citacao`)

```html
<p class="bd-def-citacao" style="font-family: Arial; font-size: 11pt;
   text-indent: 0pt; margin: 5mm 0pt 5mm 0.98in;
   line-height: 13.2pt; text-align: justify; font-style: italic;">
  <span style="background-color: transparent;">
    <span style="text-transform: inherit;">
      <span style="color: black;">
        Texto da citação jurisprudencial.
      </span>
    </span>
  </span>
</p>
```

Diferenças em relação ao parágrafo regular:
- Classe é **`bd-def-citacao`** (nó dedicado do schema)
- **`text-indent: 0pt`** — sem recuo de primeira linha
- **`margin-left: 0.98in`** — recuo do bloco inteiro (alinhado visualmente com o text-indent dos parágrafos comuns)
- **`font-size: 11pt`** (1pt menor que o parágrafo regular)
- **`font-style: italic`** — declarado no `<p>`, não no span

### 3.4 O skin de 3 spans — por que é necessário

O schema do Badon exige spans com atributos específicos em uma ordem precisa. Com menos níveis, os spans são "reagrupados" ou descartados pelo parser do ProseMirror. A estrutura canônica é:

```
<span style="background-color: transparent;">    ← nível 1: cor de fundo
  <span style="text-transform: inherit;">        ← nível 2: transformação de texto
    <span style="color: black;">                 ← nível 3: cor do texto
      conteúdo
    </span>
  </span>
</span>
```

Esses 3 níveis foram verificados por inspeção do DOM de citações digitadas manualmente pelo usuário no Badon. Parágrafos comuns podem usar apenas 1 span (`color: rgb(0,0,0)`), mas para máxima compatibilidade, a extensão usa o skin completo em ambos os tipos.

---

## 4. Conversão Markdown → HTML Badon

### 4.1 Pipeline de conversão (`renderForPJe`)

A IA gera respostas em Markdown. A função `renderForPJe` converte esse Markdown para HTML compatível com o schema do Badon:

```
Markdown da IA
    ↓ Remoção de blocos de código (``` ... ```)
    ↓ Divisão em blocos por linha em branco
    ↓ Classificação: citação (> ) vs. parágrafo/lista/heading
    ↓ Escape de HTML (& < > " ')
    ↓ Formatação inline (**bold** → <strong>, *italic* → <em>)
    ↓ Construção com buildIndentedParagraph / buildCitationParagraph
    ↓
HTML com classes bd-def-pp / bd-def-citacao
```

### 4.2 Regras de conversão

| Markdown | Saída HTML |
|---|---|
| Parágrafo simples | `<p class="bd-def-pp">` com text-indent 0.98in |
| `> citação` | `<p class="bd-def-citacao">` com margin-left 0.98in, itálico |
| `# Título` | Parágrafo comum (sem `<h1>`) — peças judiciais não usam hierarquia HTML |
| `- item` / `1. item` | Um parágrafo por item (sem bullet/numeração) |
| `**negrito**` | `<strong>` (preservado pelo ProseMirror) |
| `*itálico*` | `<em>` (preservado pelo ProseMirror) |
| `` `código` `` | Texto puro (crases removidas) |
| `~~tachado~~` | Texto puro (marcadores removidos) |
| Quebra simples de linha | Fundida em espaço (editores judiciais tratam parágrafo como unidade) |
| Bloco ``` ... ``` | Apenas o conteúdo (sem formatação de código) |

### 4.3 Por que não usar elementos HTML semânticos

Peças judiciais digitais no PJe não usam hierarquia semântica (`<h1>`, `<h2>`, `<ul>`, `<ol>`). O conteúdo é formatado exclusivamente com parágrafos (`<p>`) com recuos variados. Usar `<h1>` para um "DISPOSITIVO" causaria:
- Quebra visual de formatação (fonte, tamanho, espaçamento diferente do padrão)
- Possível rejeição pelo schema do Badon
- Inconsistência com o restante da peça digitada manualmente

---

## 5. Riscos Conhecidos

### 5.1 Fragilidade do schema do Badon

As classes `bd-def-pp` e `bd-def-citacao` foram descobertas por inspeção de DOM, não por documentação oficial. Atualizações do Badon podem:
- Renomear as classes
- Alterar a estrutura de spans exigida
- Modificar os estilos inline aceitos

**Mitigação:** Os seletores são verificados a cada inserção. Se o padrão mudar, a extensão cai para `contenteditable` genérico (funciona, mas sem formatação canônica).

### 5.2 ClipboardEvent read-only em futuras versões do Chrome

A técnica de `Object.defineProperty` para sobrescrever `clipboardData` funciona nas versões atuais do Chrome/Edge, mas é um hack que pode ser bloqueado em builds futuros. **Mitigação:** Monitorar changelogs do Chromium e testar a cada release.

### 5.3 Timeout de carregamento do editor

Os 8 segundos de timeout para o editor aparecer após seleção do tipo de ato podem não ser suficientes em redes internas lentas da JFCE. **Mitigação:** O timeout é generoso para a maioria dos cenários; em caso de falha, o usuário pode inserir manualmente via botão "Colar no editor".

### 5.4 Paginação inconsistente

A lógica de "última página visível" assume que a última página é onde o conteúdo deve ser inserido. Em peças pré-preenchidas (modelos com cabeçalho + corpo + rodapé), a página correta pode ser a do meio. **Status:** Não resolvido — o caso não foi observado na prática.

### 5.5 Conflito com paste real do usuário

Se o usuário copiar texto para a área de transferência e a extensão injetar via paste sintético simultaneamente, o conteúdo da área de transferência real do usuário não é afetado — o DataTransfer do ClipboardEvent sintético é independente. Porém, se o ProseMirror processar dois paste events em rápida sucessão, pode haver comportamento inesperado.

### 5.6 Editor Badon fora de iframe

Diferente do CKEditor 4 (que ficava dentro de um `iframe.cke_wysiwyg_frame`), o Badon renderiza diretamente no DOM da página. Isso é uma vantagem (sem problemas de cross-origin), mas também significa que o CSS da extensão pode interferir no editor e vice-versa.

---

## 6. Oportunidades

### 6.1 Acesso direto ao EditorView do ProseMirror

Atualmente a inserção é via paste sintético porque a extensão (isolated world) não tem acesso à instância JavaScript do EditorView. Uma ponte MAIN world (similar à usada na extração de documentos) poderia expor o EditorView e permitir inserção via `view.dispatch(tr)` — o caminho mais limpo e robusto.

### 6.2 Formatação avançada via schema

Com acesso ao EditorView, seria possível inspecionar o schema do Badon em tempo real e descobrir automaticamente os nós e marks disponíveis, em vez de hardcodar `bd-def-pp` e `bd-def-citacao`. Isso tornaria a extensão resistente a mudanças de versão.

### 6.3 Inserção posicional inteligente

Em vez de sempre inserir no final, analisar a estrutura da peça (cabeçalho, relatório, fundamentação, dispositivo) e inserir na seção correta. Isso exigiria parsing do conteúdo existente do editor.

### 6.4 Preview antes da inserção

Mostrar ao usuário como a minuta ficará formatada no Badon antes de inserir, usando as mesmas classes CSS. Isso permitiria revisão e ajustes antes de injetar no editor.

### 6.5 Suporte a modelos com placeholders

Peças-modelo do PJe frequentemente têm placeholders (`[NOME DA PARTE]`, `[NÚMERO DO PROCESSO]`). A extensão poderia detectar e preencher esses placeholders automaticamente com dados extraídos do processo.

### 6.6 Undo integrado

Após a inserção via paste, o ProseMirror registra a operação no histórico de undo. Porém, todo o conteúdo da minuta é uma única entrada de undo. Inserir parágrafos incrementalmente (com pequenos delays) poderia criar múltiplos pontos de undo, dando ao usuário mais controle.

---

## 7. Lições Aprendidas

1. **ProseMirror reverte o que não controla.** Qualquer inserção de DOM fora do pipeline de transactions é revertida pelo MutationObserver. Não há workaround — o paste sintético é o único caminho sem acesso ao EditorView.
2. **Classes CSS são mais importantes que estilos inline.** O schema do Badon preserva styles somente em elementos com classes reconhecidas (`bd-def-pp`, `bd-def-citacao`). Sem a classe, qualquer style é descartado.
3. **O skin de 3 spans não é capricho.** O parser do ProseMirror no Badon espera a estrutura `background-color → text-transform → color`. Reduzir para menos níveis causa reagrupamento ou descarte dos spans.
4. **Caracteres de espaço são traidores com justify.** NBSP, EM SPACE e FIGURE SPACE, embora de largura "fixa", são expandidos por `text-align: justify` do CSS, gerando recuos visualmente desiguais entre parágrafos.
5. **O editor não existe até a seleção do tipo de ato.** O Badon é carregado dinamicamente via AJAX após o dropdown — qualquer tentativa de inserção antes disso falha silenciosamente.
6. **Priorize a última página, não a primeira.** Em editores com paginação, a última página visível é onde o conteúdo normalmente deve ser adicionado. A primeira é geralmente cabeçalho.
7. **`ClipboardEvent.clipboardData` pode ser read-only.** O construtor do Chrome nem sempre honra o parâmetro. O fallback via `Object.defineProperty` é necessário para confiabilidade.
