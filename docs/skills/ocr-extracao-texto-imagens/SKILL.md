---
name: ocr-extracao-texto-imagens
description: Extrai texto de documentos digitalizados (PDFs escaneados e imagens) no navegador. Use quando precisar decidir entre OCR local (Tesseract.js) e leitura direta por IA multimodal, detectar se um PDF é digitalizado, renderizar páginas de PDF como imagem com pdf.js, ou configurar Tesseract.js offline em extensão Chrome MV3.
---

# OCR — Extração de Texto de Imagens e PDFs Digitalizados

Conhecimento consolidado do projeto pAIdegua (JFCE). A lição central: **a
pergunta certa não é "qual OCR usar", é "preciso transcrever?"** — na maioria
dos fluxos com IA, a resposta é não.

## 1. Decisão de arquitetura: duas estratégias

### Estratégia A — "Imagem-direto" (recomendada quando há IA multimodal)

Não transcreva. Renderize cada página do PDF digitalizado como **imagem JPEG**
e anexe as imagens à mensagem enviada ao modelo multimodal (Claude, Gemini,
GPT-4o). O modelo lê a imagem como *entrada* ao responder.

Por quê: transcrever um processo de 120+ páginas gera ~150 mil tokens de
*saída* — lento em qualquer tecnologia (Tesseract ou API de visão). Com
imagem-direto, o custo vira *input* (rápido) e a única etapa local é o render
(~2 s por documento). Resultado medido no pAIdegua: preparar 120 páginas caiu
de ~230 s para ~10,7 s, com leitura correta inclusive de manuscritos (CTPS).

Parâmetros de render que funcionam:

- **Escala 1.5** (~108 DPI em A4) — suficiente para texto impresso e
  manuscrito; mais que isso só encarece o upload sem ganho de acurácia.
- **JPEG qualidade ~0.82** — drasticamente menor que PNG, qualidade suficiente.
- **Data URL** (`canvas.toDataURL`), não Blob — em extensão, Blob vira `{}`
  vazio ao atravessar `chrome.runtime.sendMessage`; string base64 atravessa
  (overhead ~33%).
- **Limite de páginas por documento** (ex.: 30) para conter custo.
- Instrua o modelo, no prompt, a ler o conteúdo nas imagens anexadas — e a NÃO
  responder que o documento "precisa de OCR".

### Estratégia B — Tesseract.js local (quando o texto precisa existir)

Use quando a transcrição em si é o produto (indexação, busca local, ambiente
sem IA multimodal / 100% offline). Pipeline: pdf.js renderiza a página num
`<canvas>` → `worker.recognize(canvas)` → concatene com marcadores
`=== Página N (OCR) ===`.

Configuração para rodar **offline em extensão Chrome MV3** (arquivos
`worker.min.js`, core WASM e `por.traineddata` empacotados na extensão):

```js
const base = chrome.runtime.getURL('libs/tesseract/');
const worker = await Tesseract.createWorker('por', 1 /* LSTM_ONLY */, {
  workerPath: chrome.runtime.getURL('libs/tesseract/worker.min.js'),
  corePath: base,
  langPath: base,
  gzip: false,          // se o .traineddata não estiver comprimido
  workerBlobURL: false, // CRÍTICO em MV3 — ver abaixo
});
```

- **`workerBlobURL: false` é obrigatório em MV3**: por padrão o Tesseract.js
  v5 embrulha o worker num blob URL; o worker então roda em origin `blob:` e
  todo `importScripts` para `chrome-extension://` vira cross-origin e falha,
  mesmo com `web_accessible_resources` liberado.
- `oem=1` (LSTM_ONLY) é o modo suportado pelo `tessdata_fast`.
- **Reutilize o worker entre documentos**: criar um custa 3–5 s (carrega
  ~25 MB de `traineddata`). Crie uma vez antes do loop, passe a mesma
  instância, `terminate()` no final.

## 2. Detectar se um PDF é digitalizado

Heurística: extraia o texto com pdf.js; se a média de caracteres por página é
muito baixa, é bitmap sem camada de texto.

**Armadilha (caso PJe, vale para qualquer sistema que carimba páginas):** o
rodapé de assinatura eletrônica (~250 caracteres por página: "Num. NNN -
Pág. N", "Assinado eletronicamente por…", URL de validação) É texto extraível.
Uma página 100% escaneada "tem texto" para a heurística ingênua. Meça o
**conteúdo útil**: remova marcadores de página e carimbos antes de contar
(ex.: limiar < 50 caracteres úteis ⇒ digitalizado).

## 3. Armadilhas de plataforma (Chrome/MV3)

- **Throttling de aba em background**: desde o Chrome 88, timers e
  `postMessage` de abas em segundo plano são estrangulados. Tesseract.js
  depende de troca intensa main↔worker e **pendura** — um OCR de 12 s vira
  minutos. Se o fluxo roda com a aba do sistema em background, não use OCR
  local nela.
- **Offscreen documents não são a saída completa**: resolvem o throttling,
  mas o `page.render()` do pdf.js v5 **trava silenciosamente** dentro deles.
  Se usar offscreen, divida: render sempre no content script; o offscreen
  recebe só os JPEGs prontos.
- **pdf.js em MV3**: passe `isEvalSupported: false` ao `getDocument` (a CSP
  bloqueia `Function(...)`) e aponte `GlobalWorkerOptions.workerSrc` para a
  URL real do worker via `chrome.runtime.getURL` (string vazia lança erro).
- Use `<canvas>` comum criado com `document.createElement` (sem appendChild);
  OffscreenCanvas em offscreen document faz o render pendurar.

## 4. LGPD

Documentos digitalizados de processos contêm dados pessoais. Não logar texto
transcrito nem data URLs; ao usar a Estratégia A com provedor de IA externo,
observar as mesmas regras de anonimização do texto comum.
