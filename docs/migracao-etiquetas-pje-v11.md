# Migração das etiquetas de Perícias — PJe v4 → v11 (2026-07)

**Data:** 2026-07-07
**Módulo:** Perícias — "Aplicar etiquetas na pauta" e Triagem "Inserir etiquetas mágicas"
**Arquivos centrais:**
[`src/content/pericias/pericias-etiqueta-applier.ts`](../src/content/pericias/pericias-etiqueta-applier.ts),
[`src/content/pericias/pericias-etiqueta-page.ts`](../src/content/pericias/pericias-etiqueta-page.ts),
[`src/content/pericias/pericias-etiqueta-page-bridge.ts`](../src/content/pericias/pericias-etiqueta-page-bridge.ts),
[`src/content/pericias/pericias-etiqueta-bridge.ts`](../src/content/pericias/pericias-etiqueta-bridge.ts)

---

## 1. Contexto

A atualização do PJe do TRF5 (1º grau) da **versão 4 para a versão 11** quebrou a
funcionalidade da extensão que **cria** uma etiqueta-pauta, **vincula** um lote de
processos a ela e (opcionalmente) a **favorita**. O sintoma inicial relatado foi:

> "Todas as tentativas de criar etiqueta falharam. Último erro:
> `.../painelUsuario/etiqueta: Failed to fetch`. (…) ajuste ENDPOINT_CRIAR_ETIQUETA."

O erro apontava para o endpoint errado — foi só o começo de uma cadeia de três
mudanças de contrato somadas a um efeito colateral de teste (duplicidade de nomes).

### Arquitetura relevante (não mudou com a atualização)

O painel de Perícias do PJe roda **dentro de um iframe** cujo origin é
`https://frontend-prd.trf5.jus.br`, enquanto a API REST legacy vive em
`https://pje1g.trf5.jus.br/pje/seam/resource/rest/pje-legacy`. As chamadas de
**escrita** de etiquetas precisam sair com `Origin: https://frontend-prd...`
(a whitelist que o PJe aceita). Por isso:

- As escritas são executadas no **page world** (mundo da própria SPA Angular),
  via `pericias-etiqueta-page.ts` + `pericias-etiqueta-page-bridge.ts`. Do
  **isolated world** do content script o servidor **rejeita silenciosamente**
  (HTTP 200 com corpo vazio).
- Todo o fluxo é delegado ao iframe do painel por `postMessage`
  (`pericias-etiqueta-bridge.ts`), pois é lá que o `Origin` bate.

---

## 2. Estado ANTERIOR (PJe v4) — o que a extensão fazia

| Passo | Método / rota | Corpo enviado | Resposta esperada |
|---|---|---|---|
| Listar catálogo | `POST /painelUsuario/etiquetas` | `{page, maxResults, tagsString, somenteFavoritas}` | `{count, entities[]}` |
| Criar etiqueta | `POST /painelUsuario/tags` | `{id: null, nomeTag, nomeTagCompleto}` | entidade criada com `id` |
| Vincular a processo | `POST /painelUsuario/processoTags/inserir` | `{tag: "<nome>", idProcesso: "<string>"}` | **array** com `idProcessoTag` populado |
| Favoritar | `GET /painelUsuario/tagSessaoUsuario/adicionar/{idEtiqueta}` | — | `204 No Content` |

---

## 3. O que a atualização (v11) mudou — diagnóstico confirmado

Foram **três** mudanças de contrato reais, descobertas comparando cada request da
extensão com o request equivalente feito manualmente pela interface do PJe (DevTools,
"Copiar como cURL" / abas Carga útil e Resposta):

### 3.1 Corpo da criação (`POST /painelUsuario/tags`)

O corpo mínimo antigo passou a ser **rejeitado silenciosamente** (HTTP 200 com corpo
vazio, `len=0`). O corpo aceito agora exige campos adicionais:

```json
{ "marcado": false, "possuiFilhos": false, "visivelPublicamente": false,
  "nomeTag": "<nome>", "nomeTagCompleto": "<nome>" }
```

- Confirmado capturando o `POST /tags` que a própria interface do PJe dispara ao criar
  uma etiqueta.
- A resposta de sucesso é a entidade criada, com `id` definitivo.

### 3.2 Execução das escritas: page world + `minimalAuth` (endurecimento)

Do isolated world (e/ou com os headers `X-no-sso` e `X-pje-authorization`
presentes), o servidor v11 responde `200` com **corpo vazio** — rejeição silenciosa.
A escrita precisa:

- Rodar no **page world** (via `fetchVincularEtiquetaNoPageWorld`), para carregar o
  `Origin: frontend-prd` e os metadados de request da própria SPA.
- Usar **`minimalAuth`**: apenas `Authorization`, `Content-Type`, `X-pje-cookies`,
  `X-pje-legacy-app`, `X-pje-usuario-localizacao`. **Sem** `X-no-sso` e **sem**
  `X-pje-authorization` (confirmado: esses dois não aparecem no request que funciona).

### 3.3 Forma da resposta da vinculação (`/processoTags/inserir`)

A resposta deixou de ser o **array** antigo e passou a ser um **objeto único**:

```json
{ "id": 372815, "nomeTag": "DR PEDRO 30.07.26", "idUsuario": 13623,
  "idProcesso": 3566585, "idProcessoTag": 239046127 }
```

O validador antigo (`validarRespostaVinculacao`) exigia um array com `idProcessoTag`
em cada item e por isso **rejeitava um sucesso legítimo** ("Servidor devolveu array
inesperado"). Foi relaxado para aceitar **objeto** ou **array de objetos**, mantendo
as proteções contra "sucesso fantasma" (corpo vazio, corpo não-JSON, e array de
**strings** — que é a assinatura de erro do PJe, ex.: `["Erro ao vincular ..."]`).

> **Observação:** o corpo da **vinculação** (`{tag: "<nome>", idProcesso: "<string>"}`)
> **NÃO mudou**. A etiqueta continua sendo identificada pelo **nome** no `/inserir`.

---

## 4. Becos sem saída e aprendizados (o que *parecia* ser, mas não era)

Vários sinais enganosos custaram tempo. Ficam registrados para não repetir:

1. **A mensagem de erro do endpoint era pista falsa.** O erro
   `.../painelUsuario/etiqueta: Failed to fetch` apontava para um endpoint que **não
   existe**. A rotina antiga tentava 4 rotas (`/tags`, `/etiquetas`, `/tag`,
   `/etiqueta`) e reportava apenas a **última**. Realidade:
   - `/tags` = criação (existe, respondia `200 len=0` por causa do corpo velho);
   - `/etiquetas` = **listagem** (responde a lista inteira a um POST);
   - `/tag` e `/etiqueta` (singular) = **não existem** → preflight OPTIONS sem `2xx`
     → o Chrome bloqueia por CORS → `TypeError: Failed to fetch`.
   Os fallbacks foram removidos; hoje cada operação tem **rota única**.

2. **`/inserir` e `/remover` têm DTOs diferentes.** A remoção usa
   `{idTag: <número>, idProcesso: <número>}`; a inserção usa
   `{tag: "<nome>", idProcesso: "<string>"}`. Tentar `idTag` no `/inserir` foi um
   erro meu — piorou o sintoma.

3. **A mensagem `["Erro ao vincular a etiqueta X ao processo Y"]` só ecoa os campos
   enviados.** Quando o processo aparecia em branco ("...ao processo "), não
   significava necessariamente id inválido — o template apenas repete o que recebe.
   Isso induziu a caçar problema de campo/tipo onde não havia.

4. **Duplicidade de nome quebra o `/inserir`.** Como a vinculação identifica a
   etiqueta pelo **nome**, se existir mais de uma etiqueta com o mesmo `nomeTag`, o
   servidor não sabe qual usar e responde **HTTP 500**. Durante os testes iterativos,
   rodadas repetidas (às vezes com a listagem do catálogo falhando por CORS/503)
   criaram etiquetas com o mesmo nome — o que gerou 500 persistentes numa
   etiqueta específica ("DR MARCOS 27.07.26"), enquanto etiquetas **únicas**
   ("DR MARCOS 28.07.26", "DR PEDRO 30.07.26") vinculavam sem erro. **A causa raiz
   dos 500 finais foi ambiguidade por nome, não contrato.**

5. **Isolated world ≠ page world para escrita.** Reforço de um aprendizado que já
   existia em `docs/extracao-conteudo-pje.md`: o servidor pode se comportar de forma
   diferente conforme o mundo de onde parte o `fetch`.

---

## 5. Solução final (estado do código)

Fluxo em [`pericias-etiqueta-applier.ts`](../src/content/pericias/pericias-etiqueta-applier.ts):

1. **Listar** catálogo (`listarEtiquetas`) e procurar a etiqueta-pauta pelo nome.
2. Se **não existe**, **criar** via `POST /painelUsuario/tags` com o corpo novo
   (§3.1), no page world + `minimalAuth`.
3. Se `favoritarAposCriar` e recém-criada, **favoritar** via GET.
4. Para cada processo, **vincular** via `POST /painelUsuario/processoTags/inserir`
   com `{tag, idProcesso}`, no page world + `minimalAuth`.
5. **Validar** a resposta aceitando objeto/array de objetos (§3.3) e surfaçar o erro
   real do servidor quando `aplicadas === 0`.

Instrumentação de diagnóstico adicionada: log do corpo bruto da resposta em erro
(`Body bruto: ...`) e do corpo/headers do primeiro request (`[debug]`), essenciais
para comparar com capturas manuais em produção.

### Validação de aceite (2026-07-07)

- **Etiqueta existente e única** aplicada a 10 processos pela extensão → todos `200`,
  etiqueta apareceu em todos.
- **Fluxo completo** (criar + favoritar + vincular) com nome novo
  "DR PEDRO 30.07.26" → criação `200`, favoritada, vinculação em lote `200`
  (`idProcessoTag` populado). Conferido no PJe: etiqueta nos processos, **criada uma
  única vez** (sem duplicata) e favoritada.

---

## 6. Contrato consolidado dos endpoints (referência)

Base: `https://pje1g.trf5.jus.br/pje/seam/resource/rest/pje-legacy`
Execução: **page world** do iframe `frontend-prd.trf5.jus.br`, headers `minimalAuth`.

| Operação | Método / rota | Corpo | Resposta |
|---|---|---|---|
| Listar | `POST /painelUsuario/etiquetas` | `{page, maxResults, tagsString, somenteFavoritas}` | `{count, entities[]}` |
| Criar | `POST /painelUsuario/tags` | `{marcado:false, possuiFilhos:false, visivelPublicamente:false, nomeTag, nomeTagCompleto}` | entidade com `id` |
| Vincular | `POST /painelUsuario/processoTags/inserir` | `{tag: "<nome>", idProcesso: "<string>"}` | objeto `{id, nomeTag, idUsuario, idProcesso, idProcessoTag}` |
| Remover | `POST /painelUsuario/processoTags/remover` | `{idTag: <número>, idProcesso: <número>}` | `<idTag>` (número) |
| Favoritar | `GET /painelUsuario/tagSessaoUsuario/adicionar/{idEtiqueta}` | — | `204 No Content` |

**Headers (`minimalAuth`):** `Authorization`, `Accept`, `Content-Type`,
`X-pje-cookies`, `X-pje-legacy-app`, `X-pje-usuario-localizacao`.
**Não enviar:** `X-no-sso`, `X-pje-authorization` (presentes → rejeição silenciosa).

---

## 7. Recomendações de robustez (futuro)

1. **Evitar criar duplicatas.** A criação só deve ocorrer quando a listagem do
   catálogo tiver sido **bem-sucedida e completa**. Se a listagem falhar
   (CORS/503/parcial), é mais seguro **abortar** com mensagem clara do que criar às
   cegas — criar duplicata volta a quebrar a vinculação por ambiguidade de nome.
2. **Considerar vincular por `idTag`** caso uma versão futura do PJe passe a aceitá-lo
   no `/inserir` (hoje o `/inserir` é por nome; só o `/remover` usa `idTag`). Isso
   eliminaria de vez a ambiguidade por nome.
3. **Monitorar novas quebras de contrato.** A instrumentação (`Body bruto`, `[debug]`)
   já está pronta: em qualquer regressão, reproduzir com DevTools no iframe
   `frontend-prd` e comparar o request da extensão com o request manual da interface.
4. **Outras instâncias.** A solução foi calibrada no TRF5 1G. TRF1–4 / 2º grau podem
   ter hosts (`frontend-prd.*`) e contratos ligeiramente diferentes.
