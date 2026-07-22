---
name: extracao-documentos-pje
description: Extrai o conteúdo (texto) de documentos processuais do PJe Legacy (TRF5/JFCE) a partir de uma extensão Chrome MV3 ou script no navegador. Use quando precisar baixar binários de documentos do PJe, converter PDFs em texto, tratar respostas de 0 bytes, ativar documentos na árvore ou lidar com pdf.js em extensão MV3.
---

# Extração de Conteúdo de Documentos do PJe

Conhecimento consolidado do projeto pAIdegua (JFCE) sobre como baixar e extrair
texto de documentos processuais no **PJe Legacy** (JBoss Seam + JSF +
RichFaces), a partir de um content script de extensão Chrome MV3 rodando na
página do processo (`listAutosDigitais.seam`).

## 1. O endpoint de download

```
GET /pje/seam/resource/rest/pje-legacy/documento/download/{idProcessoDocumento}
```

- Retorna o binário com `Content-Type` correto (`application/pdf`, `audio/mpeg` etc.).
- **Exige os cookies de sessão** do usuário autenticado (`credentials: 'include'`).
- **Armadilha principal:** documentos não "ativados" na sessão retornam
  **HTTP 200 com corpo de 0 bytes**. Não é erro HTTP — é sucesso vazio.

## 2. Pipeline em cascata (do rápido para o caro)

Ordem obrigatória — nunca comece pelo caminho lento:

1. **Fetch direto no content script (isolated world)** — funciona para ~90% dos
   documentos, custo zero. Timeout de 30 s.
2. **Fallback: fetch no MAIN world** — o mesmo `fetch()` que devolve 0 bytes no
   isolated world pode devolver o conteúdo completo quando executado no
   contexto da página (provável dependência de estado Seam/Referer). Ponte via
   `CustomEvent`: o content injeta um `<script>` que escuta
   `meu-fetch-request`, faz o fetch e devolve um Blob URL em
   `meu-fetch-response`. Timeout curto (6 s) — se a ponte funciona, responde
   rápido.
3. **Último recurso: ativação programática + retry** — o PJe exige que o
   documento seja "ativado" (clique no nó da árvore dispara callback A4J).
   Procure no DOM (incluindo iframes) elemento cujo texto/`onclick`/`href`
   contenha o id do documento, simule `.click()`, aguarde ~2 s, retente o
   fetch. Custa ~2 s por documento — só para os 2–3 que restaram.

Regras da ponte MAIN world:

- Injete só no **top frame** (`window === window.top`) — o content roda em
  todos os iframes e injetar em cada um gera N erros de CSP idênticos.
- **Verifique se a ponte inicializou** via atributo DOM
  (`document.documentElement.setAttribute('data-xxx-bridge', 'ready')` no
  script injetado). Se o atributo não aparecer, a CSP bloqueou o inline script:
  pule direto para a ativação em vez de esperar timeout por documento.
- Se a página declara CSP via `<meta http-equiv="Content-Security-Policy">`
  com `script-src` sem `'unsafe-inline'` nem nonce, nem tente injetar.

## 3. Validação do conteúdo — nunca confie no Content-Type

O PJe pode responder `application/pdf` com corpo vazio, com HTML de login ou
com a interface JSF. Valide sempre:

- **Assinatura `%PDF`** nos 4 primeiros bytes (`0x25 0x50 0x44 0x46`) antes de
  mandar ao parser.
- **HTML recebido no lugar do arquivo** — distinguir três casos:
  - *Desafio anti-bot F5/BIG-IP (TSPD)*: HTML contém `tspd`, `loaderconfig` ou
    `window.nrx` → sessão precisa ser revalidada (recarregar o PJe).
  - *Interface do PJe*: contém `javax.faces`, `PrimeFaces`, `richfaces` → a URL
    exigiu autenticação/ViewState; trate como erro.
  - *Documento-rótulo*: HTML curto sem marcadores acima (nó da árvore que é só
    um título, ex.: "NOVOS DOCUMENTOS MÉDICOS") → o texto curto É o conteúdo.
- **HTML com PDF embutido**: procure `iframe`/`embed`/`object` com `src`
  contendo `.pdf`, `binario` ou `download`, resolva a URL relativa e baixe o
  PDF de dentro.
- **MIME não-textual** (`audio/`, `video/`, `image/`): marque como concluído
  sem erro, sem texto.

## 4. Parse de PDF com pdf.js em extensão MV3

- Empacote `pdfjs-dist` e o worker (`pdf.worker.min.mjs`) na extensão, com o
  worker em `web_accessible_resources`.
- `GlobalWorkerOptions.workerSrc` **deve** apontar para a URL real
  (`chrome.runtime.getURL(...)`). String vazia lança erro no getter interno.
  Em MV3 a CSP bloqueia o module worker; o pdf.js cai no "fake worker" (thread
  principal) e faz `import()` dinâmico da mesma URL — que funciona.
- Passe `isEvalSupported: false` ao `getDocument` — sem isso o pdf.js tenta
  `Function(...)` e a CSP da extensão quebra a abertura do PDF.
- **Detecção de PDF digitalizado (scanned):** se a média de caracteres
  extraíveis por página é muito baixa, é bitmap sem camada de texto.
  **Armadilha:** o PJe carimba em toda página um rodapé de ~250 caracteres
  ("Num. NNN - Pág. N", "Assinado eletronicamente por…") que É texto
  extraível — meça o conteúdo *útil* descontando esses carimbos, senão o scan
  passa como "documento com texto". Para o tratamento de scans, ver a skill
  `ocr-extracao-texto-imagens`.

## 5. Performance

- **Concorrência 3** no download+parse (sobrepõe I/O com CPU sem irritar o
  servidor; mais que isso gera instabilidade).
- **Sem pré-ativação em lote** — ativar todos os documentos antecipadamente
  desperdiça segundos para beneficiar 2–3 docs. Ative sob demanda.
- **Timeouts diferenciados**: 30 s no fetch direto, 6 s na ponte.
- Mantenha uma **trilha de diagnóstico por documento** (etapa, ok/falha,
  detalhe, ms) — é o que torna depurável um pipeline com 3 fallbacks.

## 6. Riscos conhecidos

- Seletores da ativação dependem do HTML da árvore RichFaces
  (`a, span[onclick], .rich-tree-node, .rf-trn`) — atualização do PJe pode
  quebrar; use seletores amplos.
- Sessão pode expirar no meio de extração longa → fetches passam a devolver
  HTML de login.
- A árvore contém ruído ("Ícone de certidão", widgets de lembrete) que vira
  documento falso se o scanner do DOM não filtrar.
- Documentos sob sigilo podem responder de 0 bytes a HTTP 403.
- LGPD: nunca logar conteúdo de documento (nomes, CPF, número de processo) em
  console ou telemetria.
