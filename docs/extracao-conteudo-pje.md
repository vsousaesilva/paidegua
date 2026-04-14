# Extração de Conteúdo da Árvore de Documentos do PJe

**Projeto:** pAIdegua — Assistente IA para o PJe  
**Data:** Abril/2026  
**Contexto:** Extensão Chrome MV3 para extração automatizada de documentos processuais no PJe Legacy (TRF5/JFCE)

---

## 1. Visão Geral da Arquitetura

### 1.1 O ambiente: PJe Legacy (JSF/Seam/RichFaces)

O PJe na versão Legacy é uma aplicação Java EE construída sobre **JBoss Seam + JSF + RichFaces/PrimeFaces**. A tela de processo (`listAutosDigitais.seam`) exibe a árvore de documentos dentro de **iframes aninhados** — o frame superior contém o cabeçalho do processo, e um iframe filho contém a listagem real dos anexos.

Cada documento na árvore é um nó do tree component do RichFaces (`rf-trn`, `rich-tree-node`) que, ao ser clicado, dispara uma requisição **A4J (Ajax4JSF)** para "ativar" o documento no servidor. O conteúdo binário é então servido via REST endpoint.

### 1.2 Endpoint REST de documentos

```
/pje/seam/resource/rest/pje-legacy/documento/download/{idProcessoDocumento}
```

Este é o endpoint principal para download de binários no PJe Legacy do TRF5. Ele:

- Retorna o arquivo com `Content-Type` correto (application/pdf, audio/mpeg etc.)
- Requer **cookies de sessão** do usuário autenticado
- Retorna **HTTP 200 com corpo vazio (0 bytes)** para documentos que não foram "ativados" na sessão — este é o comportamento mais traiçoeiro e que consumiu mais tempo de investigação

### 1.3 Arquitetura da extensão

```
┌─────────────────────────────────────────────────────┐
│  Popup (popup.ts)                                   │
│  Configurações, seleção de documentos, UI           │
└──────────────┬──────────────────────────────────────┘
               │ chrome.runtime.sendMessage
┌──────────────▼──────────────────────────────────────┐
│  Content Script — Isolated World (content.ts)       │
│  ├── Adapter (pje-legacy.ts) — detecta docs no DOM  │
│  ├── Extractor (extractor.ts) — baixa e parseia     │
│  ├── PDF Parser (pdf-parser.ts) — pdf.js            │
│  └── OCR (ocr.ts) — Tesseract.js para scans        │
└──────────────┬──────────────────────────────────────┘
               │ CustomEvent bridge (quando necessário)
┌──────────────▼──────────────────────────────────────┐
│  MAIN World (script injetado via <script>)          │
│  Fetch com cookies da página (fallback)             │
└─────────────────────────────────────────────────────┘
```

---

## 2. Descobertas Técnicas (Sacadas)

### 2.1 Isolated World vs. MAIN World — o problema dos 0 bytes

**Esta foi a descoberta mais importante e menos documentada de todo o processo.**

Content scripts de extensões Chrome MV3 rodam em um "isolated world" — compartilham o DOM com a página, mas têm contexto JavaScript separado. Quando o content script faz `fetch()` para o endpoint REST do PJe, ele inclui os cookies (`credentials: 'include'`), mas **o servidor PJe pode retornar 0 bytes** para certos documentos.

O mesmo `fetch()` executado no console da página (MAIN world) retorna o conteúdo completo.

**Causa provável:** O servidor PJe mantém estado de sessão vinculado a parâmetros que o isolated world não replica perfeitamente (possivelmente headers de Referer, ou estado Seam Conversation que depende do contexto de navegação da página).

**Solução:** Uma ponte CustomEvent entre os dois worlds:

1. O content script injeta um `<script>` na página (MAIN world) que escuta eventos `paidegua-fetch-request`
2. O script MAIN world faz o fetch real com o contexto da página
3. O resultado volta via `paidegua-fetch-response` usando Blob URLs (eficiente para binários)

**Importante:** A ponte MAIN world é usada APENAS como fallback. Para ~90% dos documentos, o fetch direto do isolated world funciona perfeitamente e é mais rápido.

### 2.2 Ativação de documentos no PJe — o "clique fantasma"

Alguns documentos (tipicamente 2-3 por processo) retornam 0 bytes mesmo via MAIN world. A causa: **o PJe Legacy exige que o documento seja "ativado" na árvore** antes de servir o binário. No uso normal, isso acontece quando o usuário clica no nó da árvore, que dispara um callback A4J.

A solução foi implementar uma ativação programática:

1. Busca no DOM (incluindo iframes) por elementos cujo texto ou onclick contenha o ID do documento
2. Simula um `.click()` no elemento encontrado
3. Aguarda 2 segundos para o callback A4J completar
4. Retenta o download

Esta ativação é cara (~2s por documento) e por isso é usada apenas como último recurso, após falha do fetch direto e do MAIN world.

### 2.3 pdf.js em extensão MV3 — o worker que não pode ser Worker

O pdf.js (pdfjs-dist v5.6) tenta criar um Web Worker via:

```js
new Worker(workerSrc, { type: "module" })
```

Em extensões Chrome MV3, a **Content Security Policy bloqueia** a criação de module workers a partir de URLs `chrome-extension://`. O pdf.js trata isso internamente:

1. O `new Worker()` falha (CSP)
2. O pdf.js cai no "fake worker" — roda na thread principal
3. O fake worker faz `import()` dinâmico da mesma URL do worker
4. O `import()` **funciona** porque não está sujeito à mesma restrição de CSP

**Requisito crítico:** `GlobalWorkerOptions.workerSrc` **deve** apontar para a URL real do worker (`chrome.runtime.getURL('libs/pdf.worker.min.mjs')`). Setar como string vazia faz o getter interno lançar `No "GlobalWorkerOptions.workerSrc" specified` antes mesmo de tentar o import.

O arquivo `pdf.worker.min.mjs` deve estar listado em `web_accessible_resources` no manifest.json e ser copiado para `dist/libs/` pelo webpack.

### 2.4 Verificação da ponte MAIN world via atributo DOM

A ponte MAIN world injeta um `<script>` inline. Se a CSP da página bloquear scripts inline (raro no PJe, mas possível), a ponte falha silenciosamente. Para detectar isso, o script injetado seta um atributo no `documentElement`:

```js
document.documentElement.setAttribute('data-paidegua-bridge', 'ready');
```

O content script (isolated world) verifica este atributo — se não existe, a ponte não funcionou e o sistema pula direto para ativação, evitando um timeout de 6 segundos por documento.

### 2.5 Detecção de tipo de conteúdo: %PDF signature

Não se pode confiar apenas no `Content-Type` da resposta HTTP. O PJe pode retornar:
- `Content-Type: application/pdf` mas corpo vazio (0 bytes)
- `Content-Type: application/pdf` mas conteúdo HTML (página de login ou erro JSF)
- Corpo com assinatura PDF válida mas Content-Type genérico

A verificação dos primeiros 4 bytes (`%PDF` = `0x25 0x50 0x44 0x46`) é fundamental para determinar se o conteúdo é realmente um PDF antes de enviá-lo ao parser.

### 2.6 Documentos não-textuais

O PJe permite anexar qualquer tipo de arquivo: áudio de audiências (MP3), imagens (JPG/PNG), vídeos. Estes devem ser detectados pelo MIME type e marcados sem erro, porém sem extração de texto.

### 2.7 Ruído do DOM: "Ícone de certidão" e labels poluídos

A árvore de documentos do PJe Legacy inclui elementos de UI (ícones de ação, botões de copiar link, widgets de lembrete) que os scanners podem capturar como documentos falsos. O caso mais recorrente é o "Ícone de certidão" — um elemento visual sem documento associado. A filtragem deve acontecer na saída do adapter.

Os labels dos documentos também são poluídos por texto de elementos vizinhos. O parser de labels sobe até 6 níveis na árvore de ancestrais para encontrar o rótulo canônico e usa heurísticas de boundary (`Juntado por`, `Lembrete`, `Ícone`) para cortar o ruído.

---

## 3. Decisões de Performance

### 3.1 Fetch direto como método primário

O MAIN world fetch tem overhead significativo: injeção de script, serialização via CustomEvent, criação de Blob URL, fetch do Blob. Para um processo com ~42 documentos, usar MAIN world para todos tornava a extração **drasticamente mais lenta**.

A arquitetura correta é: fetch direto (zero overhead) para todos → MAIN world apenas para os ~3 que falharam → ativação PJe apenas para os ~2 que ainda falharam.

### 3.2 Concorrência controlada

A extração usa um pool de workers com concorrência 3. Isso sobrepõe I/O de rede com CPU (parse PDF) sem sobrecarregar o servidor PJe. Concorrência maior causa instabilidade nas respostas do servidor.

### 3.3 Sem pré-ativação em lote

Uma tentativa de pré-ativar todos os documentos na árvore antes do download desperdiçava 8+ segundos (42 docs × 150ms + 2s de espera) para beneficiar apenas 2-3 docs. A ativação sob demanda é muito mais eficiente.

### 3.4 Timeouts diferenciados

- Fetch direto: 30 segundos (padrão generoso para PDFs grandes)
- MAIN world bridge: 6 segundos (se a ponte funciona, responde rápido; se não, fail fast)

---

## 4. Riscos Conhecidos

### 4.1 Fragilidade da ativação PJe

A ativação programática depende de encontrar o elemento correto no DOM pelo ID do documento. Mudanças na estrutura HTML da árvore do PJe (atualização de versão do RichFaces, customização do tribunal) podem quebrar esta detecção. **Mitigação:** os seletores são amplos (`a, span[onclick], div[onclick], .rich-tree-node, .rf-trn`) e a busca inclui texto, onclick e href.

### 4.2 Sessão expirada durante extração

Em processos com muitos documentos, a extração pode levar minutos. Se a sessão PJe expirar durante este período, os fetches começam a retornar HTML de login em vez de PDFs. Atualmente não há detecção específica para este cenário. **Mitigação possível:** verificar periodicamente se a sessão está ativa (HEAD request para um endpoint conhecido) e alertar o usuário.

### 4.3 Encoding de nomes de arquivos (mojibake)

Nomes de documentos com caracteres acentuados (Relatório, Declaração, Dossiê) aparecem com encoding quebrado na interface da extensão (ex.: `Relatï¿½rio`). A causa é a decodificação incorreta de strings Latin-1/ISO-8859-1 como UTF-8. **Status:** não resolvido.

### 4.4 Dependência de CSP do PJe

A ponte MAIN world requer que o PJe não bloqueie scripts inline via CSP. O PJe Legacy atual não implementa CSP restritiva, mas versões futuras podem fazê-lo. **Mitigação:** a verificação via atributo DOM detecta falha da ponte e ativa caminhos alternativos.

### 4.5 Documentos protegidos por sigilo

Documentos sob sigilo processual podem ter restrições adicionais de acesso que não foram testadas. O comportamento pode variar de 0 bytes a HTTP 403.

### 4.6 pdf.js rodando na thread principal

Com o fake worker, o parse de PDF roda na thread principal do content script. Para PDFs muito grandes (centenas de páginas), isso pode causar travamento momentâneo da UI da página. Na prática, documentos processuais raramente excedem 100 páginas, tornando o impacto desprezível.

---

## 5. Oportunidades

### 5.1 Cache de documentos extraídos

Documentos processuais são imutáveis após juntada. Um cache local (IndexedDB) indexado por `idProcessoDocumento` evitaria re-downloads em consultas subsequentes ao mesmo processo. Isso reduziria o tempo de extração de minutos para segundos em processos já visitados.

### 5.2 Extração incremental

Ao revisitar um processo, extrair apenas documentos novos (comparando com o cache). Isso seria particularmente útil para processos em andamento que recebem novos anexos regularmente.

### 5.3 Pré-classificação por MIME type

Antes de baixar o conteúdo, classificar documentos por tipo (PDF, áudio, imagem, HTML) usando heurísticas da URL e metadados do DOM. Isso permitiria priorizar PDFs (que contêm texto útil) e pular arquivos não-textuais sem desperdiçar bandwidth.

### 5.4 Streaming de parse para UI progressiva

Atualmente o texto de cada documento só fica disponível após o parse completo. Uma API de streaming permitiria mostrar texto parcial conforme as páginas são processadas, melhorando a percepção de velocidade.

### 5.5 Concorrência adaptativa

Em vez de concorrência fixa (3), monitorar a taxa de sucesso e latência das respostas para ajustar dinamicamente. Se o servidor está respondendo rápido, aumentar; se começa a retornar erros ou 0 bytes, reduzir.

### 5.6 Compatibilidade com PJe 2.0 (novo)

O PJe 2.0 (baseado em Angular/React, com API REST moderna) tem uma arquitetura completamente diferente. Um adapter dedicado poderia usar a API REST oficial, eliminando a necessidade de scraping DOM e ativação por clique. Isso seria significativamente mais robusto e rápido.

### 5.7 Suporte a OCR inteligente

O sistema atual faz OCR com Tesseract.js para PDFs digitalizados (< 50 caracteres/página em média). Oportunidades de melhoria:
- Detectar páginas mistas (texto + scan) e aplicar OCR apenas às páginas sem texto
- Usar APIs de IA com visão (Gemini, GPT-4o) como alternativa ao Tesseract para melhor qualidade
- Cachear resultados de OCR (processo caro, resultado determinístico por documento)

### 5.8 Extração paralela entre iframes

O PJe Legacy carrega a árvore de documentos em um iframe. Identificar e acessar este iframe diretamente (em vez de varrer todo o DOM) pode acelerar a fase de detecção de documentos.

---

## 6. Fluxo Completo de Extração (Resumo)

```
1. DETECÇÃO (adapter)
   DOM scan → iframes → anchors + onclick + data-url
   ↓ Lista de ProcessoDocumento[] (id, url, tipo, descrição)
   ↓ Filtragem: remove "Ícone", ruído do DOM

2. DOWNLOAD + PARSE (extractor, concorrência 3)
   Para cada documento:
   ├─ Fetch direto (isolated world, ~90% funciona)
   │  └─ Verifica: byteLength > 0 && assinatura %PDF válida
   ├─ [fallback] MAIN world fetch via ponte CustomEvent
   │  └─ Timeout 6s, verifica ponte ativa via data-attribute
   ├─ [último recurso] Ativação PJe + retry
   │  └─ Clique no nó da árvore → espera 2s → fetch direto → MAIN world
   └─ Parse:
      ├─ PDF → pdf.js (fake worker, thread principal)
      ├─ HTML → DOMParser, busca PDF embutido em iframe/embed
      ├─ Audio/Video/Image → marca como não-textual (sem erro)
      └─ Vazio → erro

3. OCR (opcional, para PDFs digitalizados)
   Tesseract.js → worker local → modelo português bundle-ado
   Limite de páginas por documento para controlar tempo
```

---

## 7. Lições Aprendidas

1. **Não confie no Content-Type.** Sempre verifique a assinatura do arquivo.
2. **Isolated world ≠ MAIN world para fetch.** O servidor pode se comportar diferente.
3. **O PJe Legacy tem estado de sessão implícito.** Documentos precisam ser "ativados" antes de serem servidos — HTTP 200 com 0 bytes é o indicador.
4. **Performance vem de evitar o caminho lento, não de otimizar o caminho rápido.** Usar MAIN world para todos os docs é muito pior que usar fetch direto para a maioria.
5. **pdf.js em extensões MV3 precisa de workerSrc real.** String vazia não desabilita o worker — causa erro no getter interno.
6. **Timeouts diferenciados são essenciais.** Um timeout de 30s na ponte MAIN world multiplica o tempo de falha por cada documento problemático.
7. **Verificação ativa de bridges > esperar timeout.** Detectar que a ponte MAIN world não inicializou (via atributo DOM) é instantâneo vs. esperar 6 segundos por documento.