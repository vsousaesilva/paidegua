# Correção da aplicação de etiquetas em lote — Ordens PREVJUD (2026-07)

**Data:** 2026-07-12
**Módulo:** Dashboard de Ordens PREVJUD — "Aplicar etiquetas de status"
**Perfil:** Gestão (GES-10)
**Arquivos centrais:**
[`src/background/background.ts`](../src/background/background.ts) ·
[`src/background/pje-api-client.ts`](../src/background/pje-api-client.ts) ·
[`src/content/prevjud/prevjud-coletor.ts`](../src/content/prevjud/prevjud-coletor.ts) ·
[`src/content/prevjud/prevjud-etiqueta-orquestrador.ts`](../src/content/prevjud/prevjud-etiqueta-orquestrador.ts) ·
[`src/content/content.ts`](../src/content/content.ts) ·
[`src/content/pericias/pericias-etiqueta-applier.ts`](../src/content/pericias/pericias-etiqueta-applier.ts) ·
[`src/content/pericias/pericias-etiqueta-bridge.ts`](../src/content/pericias/pericias-etiqueta-bridge.ts) ·
[`src/prevjud-dashboard/prevjud-dashboard.ts`](../src/prevjud-dashboard/prevjud-dashboard.ts)

Complementa [`migracao-etiquetas-pje-v11.md`](migracao-etiquetas-pje-v11.md) —
aqui tratamos especificamente da **escrita de etiquetas em LOTE** disparada pelo
dashboard de Ordens PREVJUD, que foi a primeira a exercer caminhos que as
Perícias nunca tinham exercido (remoção, múltiplos perfis, aba dedicada).

---

## 1. Sintomas relatados

Dois sintomas, aparentemente do mesmo problema, mas com causas distintas:

1. **Todos os usuários piloto:** ao clicar em "Aplicar etiquetas de status", o
   toast retornava:
   > Falha ao aplicar etiquetas: **Could not establish connection. Receiving end
   > does not exist.**

2. **Na máquina do relator** (que já havia aplicado etiquetas antes):
   > Nada aplicado. Recebidos: 405 · já com a etiqueta: 402 · a aplicar: 3 · a
   > remover: 4. Erro: Prevjud - Recebida pelo INSS: Nenhum processo vinculado.
   > Erro do servidor: **HTTP 500** em `.../painelUsuario/processoTags/inserir`:
   > `["Erro ao vincular a etiqueta Prevjud - Recebida pelo INSS ao processo "]`

---

## 2. Diagnóstico — frente 1 (mensageria, todos os pilotos)

O erro *"Receiving end does not exist"* é de **mensageria do Chrome**, não da API
do PJe: é lançado no `chrome.tabs.sendMessage` quando a aba-alvo **não tem o
content script escutando**.

A causa estava no handler `PREVJUD_APLICAR_ETIQUETAS` do background, que
escolhia a aba do PJe por uma query genérica e pegava a **primeira** que tivesse
id:

```js
const tabs = await chrome.tabs.query({ url: 'https://*.jus.br/*' });
const tab = tabs.find((t) => typeof t.id === 'number');
await chrome.tabs.sendMessage(tab.id, { ... }); // podia cair numa aba sem o CS
```

Contraste com o caminho da **coleta**, que sempre funcionou: ele usa
`rota.pjeTabId` — o id **exato** da aba que abriu a feature. A query `*.jus.br`
casava com qualquer aba (SEI, consulta pública, PDPJ, ou uma aba do PJe carregada
antes da atualização da extensão), nenhuma delas com o content script → o
`sendMessage` lançava exatamente aquele erro. Agravante: o dashboard sequer
enviava o `requestId`, então o background não tinha como recuperar a aba correta.

---

## 3. Diagnóstico — frente 2 (HTTP 500 na escrita)

Esta frente teve **dois becos sem saída** antes da causa real — ficam
registrados porque o raciocínio errado custa tempo.

### 3.1 Beco 1 — "é etiqueta duplicada" (ERRADO)

Primeira hipótese: nome de etiqueta duplicado → HTTP 500 por ambiguidade (causa
conhecida da migração v11). **Refutada** por dois motivos:

- O catálogo do usuário não tinha nenhuma etiqueta "Prevjud -" repetida (imagem
  anexada por ele).
- **Contradição lógica:** o diagnóstico dizia "já com a etiqueta: 402", ou seja,
  a extensão já havia vinculado a mesma etiqueta a 402 processos com sucesso. Se
  o nome fosse ambíguo, **aquela** rodada teria falhado também. Logo, a etiqueta
  funcionava; o problema estava nos poucos processos que faltavam.

### 3.2 Beco 2 — "o processo em branco significa idProcesso inválido" (ERRADO)

A mensagem `["...ao processo "]` com o processo em branco **induz** a caçar um
problema de campo/tipo no `idProcesso`. Mas a própria doc da migração (§4.3) já
registrava: essa string é um **eco-template inútil** do PJe — não indica
idProcesso vazio. O `idProcesso` enviado estava correto e preenchido.

### 3.3 A comparação que fechou o diagnóstico

O passo decisivo foi capturar, no Network, o request que a **interface nativa do
PJe** faz ao aplicar a MESMA etiqueta no MESMO processo — e ele **funciona
(200)**. Comparando com o request da extensão:

- **Mesma URL, mesmo método, mesmo corpo** `{tag, idProcesso}`, mesmo conjunto
  `minimalAuth`. **O contrato é idêntico** → não é mudança de contrato.
- A única diferença relevante estava num header de contexto:
  `x-pje-usuario-localizacao: 162284`.

O interceptor da extensão **captura** esse header do tráfego real e o guarda num
snapshot **global e único** (`PJE_AUTH_SNAPSHOT`), com política
**last-writer-wins**. O applier depois reinjeta essa localização em toda escrita.

### 3.4 Causa-raiz (frente 2)

> **A escrita de etiqueta no PJe é escopada por localização/perfil.** O
> `X-pje-usuario-localizacao` precisa ser o do perfil que **possui** o processo.
> Como o snapshot é global e last-writer-wins, ele podia refletir **outro perfil
> aberto** (ex.: o painel de Perícia, cujo iframe apareceu na URL de debug) — ou
> uma localização nula, se o último request capturado não trouxesse o header.
> Quando a localização não bate com o perfil dono do processo, o servidor não o
> resolve e devolve **HTTP 500**.

Isso explica tudo: a coleta (leitura) funciona sob qualquer localização; a
escrita (escopada) falha; a interface nativa acerta porque o usuário opera no
perfil certo. E como **cada usuário tem sua própria lotação**, a localização
jamais pode ser fixa/assumida — tem de ser **dinâmica** e do contexto certo.

---

## 4. Solução implementada

### 4.1 Medida 1 — mirar a aba certa (mensageria)

- O dashboard passa o `requestId` no `PREVJUD_APLICAR_ETIQUETAS`.
- O novo `handlePrevjudAplicarEtiquetas` (background) mira **`rota.pjeTabId`** — a
  aba que abriu a feature, que tem o Painel/iframe. Fallback restrito a abas cuja
  URL contém `/pje/`, tentando cada candidato **até um responder** (nunca uma
  `*.jus.br` qualquer). Mensagem clara quando não há aba do PJe.

### 4.2 Medida 2 — localização dinâmica na escrita

- **2a — Preservar a última localização válida** (`gravarAuthSnapshot`): quando um
  novo snapshot chega sem `X-pje-usuario-localizacao`, mantém-se a última não-nula
  em vez de sobrescrever com `null`.
- **2b — Capturar na coleta:** o coletor lê a localização do snapshot **no momento
  da coleta** (perfil correto, antes de qualquer poluição) e a envia no
  `SKELETON_READY`; o background a guarda em `rota.localizacaoEtiqueta`.
- **2c — Threading do override:** dashboard → background → content → orquestrador →
  bridge → applier. O applier usa essa localização como
  `X-pje-usuario-localizacao`, com **precedência** sobre a do snapshot global.
- **2d — Guarda + diagnóstico:** se a localização efetiva for vazia, aborta com
  mensagem clara ("abra/atualize o Painel do seu perfil") em vez de disparar 500
  em série; e o erro passou a citar o processo que falhou.

### 4.3 Medida 3 — idempotência da reaplicação

Após a primeira aplicação bem-sucedida, um novo clique reenviava **tudo**, porque
o `etiquetasAtuais` do dashboard era o da coleta (anterior à marcação). Como o PJe
devolve **HTTP 500 ao revincular uma etiqueta que o processo já tem** (associação
duplicada — mesma assinatura de erro), a reaplicação virava uma tempestade de
500s e, no lote grande, derrubava o canal de mensagens.

- O orquestrador devolve os processos **efetivamente escritos**
  (`aplicadasProcessos` / `removidasProcessos`, a partir de `detalhes.ok`).
- O dashboard **atualiza as etiquetas por processo** (memória + storage + cache).
  O clique seguinte reconhece os já-etiquetados pelo check `jaTem` e **não
  reenvia**; e mostra mensagem benigna *"Tudo já estava atualizado"*.
- **Decisão consciente:** NÃO tratar o 500 como sucesso — ele é indistinguível do
  500 de localização errada, e mascará-lo traria de volta o "sucesso fantasma"
  que o código combate. A idempotência vem de **não reenviar duplicata**.

### 4.4 Correção do `/remover` (idProcesso como número)

Após as medidas acima, **toda remoção** continuava dando HTTP 500 (corpo vazio).
Como a remoção estava marcada "(não usada)" na doc e o PREVJUD foi o primeiro a
exercê-la, ela herdou o tipo errado do `/inserir`:

- `/inserir` → `{ tag: "<nome>", idProcesso: "<string>" }` (idProcesso **string**).
- `/remover` → `{ idTag: <número>, idProcesso: <número>}` (idProcesso **número**).

O código enviava `idProcesso: String(r.idProcesso)` no remover → 500 em **toda**
remoção. Corrigido para número. A mensagem de falha de remoção também deixou de
ser silenciosa e passou a citar o **número CNJ** + o nome da etiqueta.

---

## 5. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `background/pje-api-client.ts` | 2a — preserva a última localização não-nula no snapshot |
| `content/prevjud/prevjud-coletor.ts` | 2b — captura a localização na coleta e envia no `SKELETON_READY` |
| `background/background.ts` | 1 + 2b — rota guarda `localizacaoEtiqueta`; `handlePrevjudAplicarEtiquetas` mira `rota.pjeTabId` com fallback `/pje/` |
| `content/prevjud/prevjud-etiqueta-orquestrador.ts` | 2c/2d/3 — threading da localização; retorno de aplicados/removidos; erro de remoção com CNJ |
| `content/content.ts` | 2c — handler repassa `localizacao` |
| `content/pericias/pericias-etiqueta-bridge.ts` | 2c — `localizacaoOverride` nas mensagens do iframe |
| `content/pericias/pericias-etiqueta-applier.ts` | 2c/2d + `/remover` — header dinâmico; guarda de localização vazia; erro por processo; **idProcesso número no remover** |
| `prevjud-dashboard/prevjud-dashboard.ts` | 1 + 3 — envia `requestId`; atualiza estado por processo; mensagem benigna |

Como o applier é **compartilhado** com Perícias e Triagem, essas features herdam
a localização mais robusta e a guarda — sem regressão (elas usam o snapshot, sem
override).

---

## 6. Validação em campo (2026-07-12)

Todos os cenários testados na máquina do relator, após build de produção:

| # | Cenário | Resultado |
|---|---|---|
| 1 | Sem etiquetas → novo relatório → Aplicar | **426 aplicada(s), 1 removida(s)** ✅ |
| 2 | Com etiquetas → Aplicar de novo | *"Tudo já estava atualizado…"* ✅ |
| 3 | F5 no PJe → mesmo relatório → Aplicar | *"Tudo já estava atualizado…"* ✅ |
| 4 | Novo relatório sem excluir etiquetas → Aplicar | *"Tudo já estava atualizado…"* ✅ |

Item observável no uso real (não bloqueante): a **transição de status** (mudar o
status → nova varredura → aplicar) não foi exercida com uma mudança real, mas
todos os seus blocos estão provados isoladamente (inserção idempotente + remoção
funcionando + o orquestrador já agenda remove-antiga/insere-nova).

---

## 7. Aprendizados

1. **Contrato idêntico ⇒ o problema é de contexto.** Capturar o request nativo
   bem-sucedido e diferenciá-lo do da extensão é o método mais rápido para
   isolar "mudou o contrato" de "mudou o contexto (header/perfil)".
2. **A escrita de etiqueta é escopada por localização.** Snapshot de auth global
   com last-writer-wins não serve para escrita quando há múltiplos perfis; a
   localização tem de ser **dinâmica** e capturada do contexto que **possui** o
   processo, passada explicitamente.
3. **`["...ao processo "]` é eco-template inútil** — não induza a caçar idProcesso
   inválido (repetimos o mesmo erro que a doc da migração já alertava).
4. **`/inserir` e `/remover` têm DTOs diferentes:** idProcesso é **string** no
   inserir e **número** no remover. Caminho "nunca usado" acumula bug latente.
5. **Nunca mascarar HTTP 500 como sucesso.** Quando o mesmo 500 pode ter causas
   distintas (localização errada × associação duplicada), idempotência tem de vir
   de **não reenviar**, não de ignorar o erro.
6. **Diagnóstico primeiro, código depois.** As duas hipóteses erradas (duplicata,
   idProcesso vazio) foram descartadas por dados concretos (catálogo, Network),
   não por tentativa-e-erro no código.

---

## 8. Referências

- [`migracao-etiquetas-pje-v11.md`](migracao-etiquetas-pje-v11.md) — contrato dos
  endpoints de etiqueta (criar/listar/inserir/remover/favoritar) e a migração v4→v11.
- [`extracao-ordens-prevjud-pje.md`](extracao-ordens-prevjud-pje.md) — coleta das
  ordens PREVJUD (rotas api/ssr/aba).
