# Análise preditiva de minutas (perfil Gabinete)

Funcionalidade dirigida ao **magistrado**: com a minuta aberta no editor do PJe
(Badon/ProseMirror, ou CKEditor 4 nas instalações antigas), a extensão lê o
texto do editor, consulta o banco de decisões via Júlia (TRF5) e apresenta na
sidebar — no mesmo formato do "Fale com a Júlia" (streaming, painel de
evidência, citações `[n]` clicáveis) — um relatório com cinco blocos:

1. **Prognóstico** (no 2º grau: "Aderência ao entendimento do colegiado") —
   avaliação **qualitativa** de como a instância revisora tende a receber a
   minuta, sempre condicionada à base lida. Percentual/probabilidade numérica
   é proibido por prompt.
2. **Divergências ponto a ponto** — cada tese da minuta confrontada com o que
   os julgados vêm decidindo.
3. **Precedentes favoráveis e contrários** — com acesso ao inteiro teor e
   copiar trecho+referência (modal já existente da Júlia).
4. **Sugestões de reforço ou distinção** — com lastro em `[n]` ou declaradas
   como sugestão redacional.
5. **O que esta análise não permite afirmar** — sempre presente.

## Arquitetura: reuso do subsistema Júlia

O pipeline é o mesmo do "Fale com a Júlia" — extração (LLM) → `recuperar()`
nos dois escopos → síntese (LLM streaming) pela porta `JULIA_STREAM` — com as
duas pontas trocadas: a entrada é a **minuta** (não uma pergunta) e os prompts
são próprios. Um discriminador de partida (`JULIA_PORT_MSG.START_ANALISE`)
basta; os eventos de saída (`PROGRESSO`/`EVIDENCIA`/`CHUNK`/`DONE`/`ERROR`) e
o `RETENTAR_SINTESE` são os mesmos.

| Peça | Arquivo | O que faz |
|---|---|---|
| Leitura do editor | `src/content/ckeditor-bridge.ts` | `readFromPJeEditor()` concatena **todas** as páginas ProseMirror na ordem do DOM (a escrita mira só a última). Lê também a **visualização somente-leitura** do documento (`div.folha`, uma por página — kind `folha-visualizacao`), o outro modo pelo qual o magistrado enxerga a minuta; prioridade: Badon → CKE4 → folha → contenteditable → textarea, e **cada fonte só vence se tiver texto** (Badon montado porém vazio não encerra a busca). Piso de conteúdo em `minutaSuficiente()`: editores exigem `MINUTA_MIN_CHARS` (200); a `folha` exige apenas texto não vazio — folha renderizada é documento real, e o piso alto inviabilizaria o teste na evolutiva (docs com conteúdo apagado pelo admin, ~81 chars). A varredura desce a **iframes same-origin** (`coletarDocumentosAcessiveis`). Teto de 100k chars com truncamento preservando início e dispositivo. |
| Leitura cross-frame | `src/content/julia/analise-preditiva.ts` + `background.ts` + `content.ts` | `lerMinutaEmQualquerFrame()`: tenta o DOM local; falhando, `MINUTA_LER` → background reenvia à mesma aba (`MINUTA_LER_PERFORM`, todos os frames) → **só responde o frame que tem minuta** (os demais ficam calados para não vencer a corrida com um "não"). Obrigatório no TRF5: o painel embute `#ngFrame` → `frontend-prd.trf5.jus.br` (**cross-origin**) e o editor vive lá dentro. O gating do botão usa o modo `somenteDeteccao` (sem trafegar o texto a cada 3s). |
| Frame `about:blank` do Badon | `manifest.json` + `ckeditor-bridge.ts` | **Achado de campo (diagnóstico 21/07/2026):** no PJe ng2 do TRF5, o conteúdo do Badon vive num iframe **`about:blank`** criado **dentro de um shadow root** do componente do editor (classe `ProseMirror appEditorAreaConteudoInner`), aninhado em `movimentar.seam` → `frontend-prd` → topo. Duas defesas: (a) `match_origin_as_fallback: true` no content script — injeta o pAIdegua dentro do próprio frame `about:blank`, que então responde ao broadcast; (b) `coletarIframesComShadow` — a descida por iframes atravessa shadow roots abertos. |
| Extração | `src/shared/julia/julia-prompts.ts` | `buildAnalisePreditivaExtracaoPrompt` decompõe a minuta em **teses** (2–6) + termos de busca com operadores da Júlia. Termos manuais substituem a busca, **não** as teses. Fallback local: `termosDePergunta` sobre um trecho a ~40% do texto. |
| Síntese | `src/shared/julia/julia-prompts.ts` | `buildAnalisePreditivaSintesePrompt` — 5 blocos, travas herdadas (base contada, citação por afirmação, não atribuir citação alheia, comparação só com os dois lados) + novas (sem probabilidade numérica; ausência de evidência ≠ divergência; sugestão com lastro). |
| Orquestração | `src/background/julia-orquestrador.ts` | `executarAnalisePreditiva` — anonimiza a minuta (`prepararTextoParaIA`) **antes de qualquer LLM**, timeout de extração próprio (60s), retry com `termoSimples`. `ultimaRecuperacao` virou união discriminada (`consulta`/`analise`) para o "Gerar a resposta de novo". |
| Porta | `src/background/background.ts` | `handleJuliaStart(port, payload, fluxo)` parametrizado: `'consulta' \| 'analise' \| 'sintese'`. |
| Formulário | `src/content/julia/julia-chat.ts` | `renderSeletorConsulta`/`renderSeletorPublico` ganharam a variante `'analise'`: mesma seleção de seccional/instâncias/unidades (com sonda de sessão), sem campo de pergunta, com `blocoExtra` (resumo da minuta + aviso de privacidade). |
| Execução UI | `src/content/julia/julia-chat.ts` | `consultarJulia` aceita `analise: { minutaTexto, minutaTruncada }` — muda a mensagem de partida e os rótulos; todo o resto (evidência, citações, reconexão, retentativa) é compartilhado. |
| Módulo da feature | `src/content/julia/analise-preditiva.ts` | `abrirFormularioAnalise` — leitura exibida na abertura, **releitura fresca no clique** de "Analisar a minuta". |
| Botão | `src/content/ui/sidebar.ts` + `src/content/content.ts` | Seção Pesquisa, `data-profile-section="gabinete"`, nasce desabilitado; `content.ts` habilita via polling de 3s (só com a sidebar aberta) quando `detectMinutaAberta()`. |

## Ações sobre o resultado

A bolha do relatório sai com o rodapé padrão do chat (`allowedActionIds`), na
ordem: **Baixar .doc** (`analise-download-doc`), **Copiar** (`copy`),
**Analisar sugestões de reforço ou distinção** (`analise-sugestoes`) e
**Analisar a minuta de novo** (`analise-de-novo`). As ações são registradas em
`buildChatBubbleActions` (content.ts) e operam sobre o estado módulo-nível
`ultimaAnalise` (analise-preditiva.ts) — mesmo desenho do `lastMinuta`.

**Reescrita com sugestões** (`analise-sugestoes`): o seletor lista os itens da
seção "Sugestões de reforço ou distinção" (parser tolerante: bullets,
numeração ou parágrafos) com checkboxes; as escolhidas vão ao fluxo
`START_REESCRITA` (mesma porta `JULIA_STREAM`) junto com a minuta original e
os precedentes `[n]` citados nas sugestões (trecho + referência do
`citaveis`). A minuta viaja **formatada**: `htmlParaMarkdown` converte o HTML
capturado em Markdown preservando negrito, itálico, listas e os **recuos de
citação** (classe recuo/citac/quote ou margem esquerda ≥ 40px → blocos `> `);
a bolha renderiza o Markdown e o `renderForPJe` devolve os recuos como
blockquotes aninhados na inserção. O prompt (`buildReescritaMinutaPrompt`)
impõe **literalidade de texto E de formatação**: fora dos pontos das
sugestões, redação e marcação são reproduzidas exatamente; citações novas
entram como bloco `> ` + referência por extenso (nunca `[n]`); marcadores de
anonimização preservados. A minuta reescrita chega como bolha padrão com
Copiar / Inserir no PJe / Baixar .doc / **Analisar a minuta de novo** (reinicia
o ciclo de análise, útil após inserir a versão nova no editor). Aviso ao
usuário no seletor: o resultado parte do texto anonimizado (qualificação das
partes e dados mascarados não constam).

## Escopos e graus

- **1º grau / TR / unknown** → modo `dupla`: unidade (API autenticada da
  Júlia, exige sessão) + revisor (derivado por rito em
  `mapearOrgaoRevisor`). Sem sessão: porta de entrada existente
  (login assistido) ou "seguir só com a revisora" — nesse caso o relatório
  **abre avisando** que reflete só a instância revisora (regra 6.1 do prompt).
  **Correção 21/07/2026:** `instanciasPublicas` só é repassada ao RAG no modo
  `publica` — o contexto padrão da UI traz `['G2']` e, como esse campo
  sobrepõe a derivação por rito no `recuperar()`, unidade JEF era confrontada
  com o TRF5 em vez da TR + TRU (afetava também o "Fale com a Júlia").
- **2º grau (`pjett`)** → modo `publica`: só API pública, relatório vira
  aderência ao entendimento do próprio colegiado, sem prognóstico de reforma.

## Privacidade (LGPD)

- Anonimização no background antes de qualquer chamada de LLM
  (`prepararTextoParaIA`: remoção da qualificação das partes + regex de CPF,
  RG, e-mail, telefone, dados bancários). Limite conhecido: nome citado no
  corpo do texto permanece — declarado no aviso do formulário.
- Nenhuma persistência: a minuta vive só no payload da porta e em
  `ultimaRecuperacao` (memória volátil do service worker).

## Teste manual

1. Tela minutar (1º grau), minuta com >200 caracteres → botão habilita em
   ≤3s; no painel do usuário → desabilitado com tooltip.
2. Minuta Badon com várias páginas → conferir no relatório/log que o campo
   `paginas` da leitura reflete o real e que não há texto duplicado.
3. Sessão Júlia ativa → relatório com os 5 títulos, painel "X lida(s) de Y
   encontrada(s)" por escopo, `[n]` abrindo o modal com abas.
4. Sessão derrubada → porta de entrada; "Consultar apenas a segunda
   instância" → relatório degradado abre com o aviso.
5. Chave de IA inválida → "Gerar a resposta de novo" refaz só a síntese.
6. **Regressão**: "Fale com a Júlia" completo (modo dupla e público),
   inclusive "Iniciar outra consulta" e retentar síntese.
