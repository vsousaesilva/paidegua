---
name: ocr-extracao-texto-imagens
description: Extrai texto de documentos digitalizados (PDFs escaneados e imagens) no navegador. Use quando precisar escolher entre OCR local determinístico (PP-OCR via ONNX Runtime Web, WebGPU→WASM, em offscreen document) e leitura direta por IA multimodal, detectar se um PDF é digitalizado, renderizar páginas de PDF como imagem com pdf.js, ou configurar OCR local offline em extensão Chrome MV3.
---

# OCR — Extração de Texto de Imagens e PDFs Digitalizados

Conhecimento consolidado do projeto pAIdegua (JFCE). A tese evoluiu (ver §0):
hoje o padrão é **transcrever localmente com um OCR determinístico** (PP-OCR),
porque isso ficou barato **e** é pré-requisito para anonimizar antes da IA.

## 0. Como a decisão evoluiu (não pule)

A resposta certa mudou com a tecnologia — a skill guarda as duas eras:

- **2026-05 (v1.6.5):** a pergunta era "preciso transcrever?" e a resposta foi
  **não**. Transcrever um processo de 120+ páginas gera ~150 mil tokens de
  *saída* — lento em QUALQUER tecnologia (Tesseract ou API de visão). Solução:
  não transcrever; mandar a **imagem** direto à IA multimodal (imagem-direto).
- **2026-07 (v1.12.0):** a premissa caiu. O **PP-OCR** (detecção DB +
  reconhecimento CTC) via **ONNX Runtime Web (WebGPU→WASM)** transcreve
  ~0,8 s/página em WebGPU, é **determinístico** (sem alucinação) e roda **100%
  local**. A resposta virou **"sim, localmente"** — porque (a) ficou barato e
  (b) ter o texto local é pré-requisito para **anonimizar antes de qualquer IA**
  (a imagem-direto mandava o scan com CPF/nome sem mascarar). Imagem-direto
  virou **fallback** para o que o OCR local não lê (manuscrito, carimbo pesado).

**Regra prática hoje: OCR local determinístico primeiro; imagem-direto como
fallback.**

## 1. Estratégia recomendada — OCR local PP-OCR (ONNX/WebGPU→WASM) no offscreen

Determinístico — por isso **NÃO** se usa modelo generativo (Florence-2/TrOCR)
para o texto: o risco de alucinação é inaceitável em documento jurídico.

**Onde roda (divisão de contexto obrigatória em MV3):**

- **Render** do PDF→imagem: sempre no **content script** (`pdf.js`). Ver §4
  (BUG-21: `page.render` do pdf.js v5 trava em offscreen).
- **Reconhecimento** (inferência ONNX): num **offscreen document** — não no
  service worker (o Chrome o mata em tarefa longa) nem no content (CSP da
  página hospedeira). O content manda o **dataURL** de cada página ao
  background, que garante o offscreen (`chrome.offscreen.createDocument`,
  `reasons: ['WORKERS']`) e faz o relay.

**Motor** (`ppu-paddle-ocr@^5.8.3`, o build `/web` — a 2.x é **Node-only**,
importa `onnxruntime-node`+`fs`, sem subpath `/web`):

```js
import * as ort from 'onnxruntime-web';
import { PaddleOcrService } from 'ppu-paddle-ocr/web';

// .wasm E .mjs do ORT embarcados na extensão — nunca CDN (CSP MV3). Copiar só o
// .wasm dá "no available backend found": inclua ort-*.{wasm,mjs} no build.
ort.env.wasm.wasmPaths = chrome.runtime.getURL('assets/');

const [detection, recognition, charactersDictionary] = await Promise.all(
  ['det.onnx', 'rec.onnx', 'dict.txt'].map((f) =>
    fetch(chrome.runtime.getURL(`assets/paddle-ocr/${f}`)).then((r) => r.arrayBuffer())
  )
);
const svc = new PaddleOcrService({
  model: { detection, recognition, charactersDictionary }, // ArrayBuffers locais
  processing: { engine: 'canvas-native' },  // sem OpenCV wasm (ppu-ocv)
  // sem WebGPU → fixa WASM; com WebGPU, deixa a lib decidir
  ...(temWebGPU ? {} : { session: { executionProviders: ['wasm'] } })
});
await svc.initialize();                 // 1ª vez paga o warm-up (~3-4 s)
const { text } = await svc.recognize(canvas); // OffscreenCanvas | HTMLCanvasElement
```

Pontos que quebram se ignorados:

- **Modelos embarcados, nunca CDN** (CSP MV3). Tier tiny PP-OCRv6 (~6 MB:
  det+rec+dict) do repo `PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models`. Os
  `.onnx` são **Git LFS** → baixe por `media.githubusercontent.com/media/...`
  (o `raw.githubusercontent.com` devolve só o ponteiro LFS, poucos bytes).
- **Manifest MV3**: permissão `offscreen`; CSP `script-src 'self'
  'wasm-unsafe-eval'; worker-src 'self'; object-src 'self'`. O
  `wasm-unsafe-eval` executa WASM **local** — não é "código remoto" (importa na
  justificativa da permissão na CWS).
- **Motor único e quente**: um offscreen por extensão → uma instância
  `PaddleOcrService`. Inicialize uma vez; não recrie por documento (o custo é o
  warm-up). Clientes no content e em páginas de extensão são proxies do mesmo
  motor via mensagem.
- **WebGPU não é garantido**: sem GPU/driver compatível, `navigator.gpu` não
  existe e cai para WASM (single-thread se não houver cross-origin isolation —
  mais lento, mas funciona; **a acurácia é a mesma**). Detecte por
  `navigator.gpu?.requestAdapter()` e reporte o backend para diagnóstico.
- **Tipos WebGPU** (`GPU`, `GPUAdapter`) não estão na lib DOM padrão do TS (vêm
  de `@webgpu/types`) — faça *duck typing* de `navigator.gpu` em vez de tipá-lo.

**Portão de qualidade:** o PP-OCR é determinístico e não gera o "texto
embaralhado" do Tesseract. Se o resultado expõe score por linha, use a média
(normalizada a 0–100); senão, com texto presente, trate como confiável (piso
alto). Mantenha o corte por **conteúdo útil** (< 50 chars ⇒ não lido) para o
resíduo cair no fallback.

## 2. Estratégia fallback — "Imagem-direto" (IA multimodal)

Para o que o OCR local não lê com confiança (manuscrito, carimbo pesado) OU
quando não há motor local. Renderize a página como **imagem JPEG** e anexe à
mensagem do modelo multimodal (Claude/Gemini/GPT-4o), que a lê como *entrada*.
Custo vira input (rápido); a única etapa local é o render (~2 s/doc).

⚠️ **LGPD**: a imagem **não** é anonimizável — vai o scan com dados pessoais ao
provedor. Por isso é fallback, não padrão. E depois de anonimizar os autos, as
`paginasImagem` originais devem ser **descartadas** — senão um Resumir/Analisar
posterior reanexa o original NÃO mascarado ao contexto e vaza à IA.

Parâmetros de render (compartilhados com a Estratégia 1):

- **Escala 1.5** (~108 DPI em A4) — suficiente para impresso e manuscrito; mais
  que isso só encarece sem ganho de acurácia. É a mesma escala do PP-OCR.
- **JPEG qualidade ~0.82** — muito menor que PNG, qualidade suficiente.
- **Data URL** (`canvas.toDataURL`), não Blob — em extensão, Blob vira `{}`
  vazio ao atravessar `chrome.runtime.sendMessage`; base64 atravessa (+~33%).
- **Limite de páginas por documento** (ex.: 30) para conter custo/tempo.
- No prompt, instrua o modelo a ler as imagens anexadas e a NÃO responder que o
  documento "precisa de OCR".

## 3. Detectar se um PDF é digitalizado

Heurística: extraia o texto com pdf.js; se a média de caracteres por página é
muito baixa, é bitmap sem camada de texto.

**Armadilha (caso PJe, vale para qualquer sistema que carimba páginas):** o
rodapé de assinatura eletrônica (~250 caracteres por página: "Num. NNN -
Pág. N", "Assinado eletronicamente por…", URL de validação) É texto extraível.
Uma página 100% escaneada "tem texto" para a heurística ingênua. Meça o
**conteúdo útil**: remova marcadores de página e carimbos antes de contar
(ex.: limiar < 50 caracteres úteis ⇒ digitalizado). O mesmo corte serve de
portão de qualidade do OCR (§1) — mantenha as duas regex de boilerplate em
sincronia.

## 4. Armadilhas de plataforma (Chrome/MV3)

- **Throttling de aba em background** é real (desde o Chrome 88): timers e
  `postMessage` de abas em segundo plano são estrangulados. Rodar a inferência
  no **offscreen document** resolve isso — outro motivo, além da CSP, para o
  OCR não viver no content script.
- **Render fica no content, reconhecimento no offscreen.** O `page.render()` do
  pdf.js v5 **trava silenciosamente** dentro de offscreen documents (BUG-21).
  Padrão: content renderiza a página (`pdf.js`) → manda o **dataURL** JPEG ao
  offscreen → offscreen roda o OCR. Nunca renderize no offscreen.
- **pdf.js em MV3**: passe `isEvalSupported: false` ao `getDocument` (a CSP
  bloqueia `Function(...)`) e aponte `GlobalWorkerOptions.workerSrc` para a URL
  real do worker via `chrome.runtime.getURL` (string vazia lança erro).
- **Canvas**: no content, use `<canvas>` criado com `document.createElement`
  (sem `appendChild`). No offscreen, `OffscreenCanvas` funciona para alimentar
  o `recognize()` (desenhe o `ImageBitmap` da imagem recebida nele).
- **Mensageria do relay**: o content emite um canal (ex.: `OCR_RECOGNIZE`); o
  background garante o offscreen e reencaminha num canal interno
  (ex.: `OCR_RECOGNIZE_OFFSCREEN`) que só o offscreen escuta. O offscreen também
  recebe o canal externo — filtre por `message.channel` para ignorá-lo.

## 5. LGPD

Documentos digitalizados de processos contêm dados pessoais. **A grande razão do
OCR local:** ele produz o **texto** localmente, que então passa pela
anonimização (regex + máscara de nomes das partes) **antes** de qualquer envio à
IA — o que a imagem-direto não permite (a imagem vai ao provedor sem máscara).

- Não logar texto transcrito nem data URLs.
- Preferir SEMPRE o caminho local (texto anonimizável) ao imagem-direto.
- No imagem-direto (fallback), tratar como envio consciente de dado sensível e
  descartar as imagens após a anonimização (ver §2).

## Apêndice — Legado: Tesseract.js (removido na v1.12.0)

Motor anterior. **Removido** do pAIdegua na v1.12.0 (sofria com ruído visual —
carimbos, assinaturas, baixa resolução — e marcava documentos legíveis como
"leitura pendente"; substituído pelo PP-OCR). Mantido aqui como referência para
ambientes onde um OCR CPU-only sem baixar modelos ainda faça sentido.

```js
const base = chrome.runtime.getURL('libs/tesseract/');
const worker = await Tesseract.createWorker('por', 1 /* LSTM_ONLY */, {
  workerPath: chrome.runtime.getURL('libs/tesseract/worker.min.js'),
  corePath: base,
  langPath: base,
  gzip: false,
  workerBlobURL: false, // CRÍTICO em MV3 (ver abaixo)
});
```

- **`workerBlobURL: false` é obrigatório em MV3**: por padrão o Tesseract.js v5
  embrulha o worker num blob URL; o worker roda em origin `blob:` e todo
  `importScripts` para `chrome-extension://` vira cross-origin e falha, mesmo
  com `web_accessible_resources` liberado.
- `oem=1` (LSTM_ONLY) é o modo do `tessdata_fast`; `por.traineddata` ~25 MB.
- Reutilize o worker entre documentos (criar custa 3–5 s). Roda no realm de
  página de extensão ou offscreen — **não** no content injetado (construir
  `Worker` de `chrome-extension://` a partir do origin da página é bloqueado
  pela same-origin policy).
