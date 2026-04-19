# Abrir tarefa do processo no PJe (popup `movimentar.seam`)

**Status:** implementado em abril/2026. Disponível nos três painéis do `paidegua`: **Triagem Inteligente (perfil Secretaria)**, **Painel Gerencial (perfil Gestão)** e **Prazos na Fita (perfil Gestão)**.

**Audiência:** mantenedores do `paidegua` e quem for implementar integrações futuras que dependam do mesmo endpoint.

---

## 1. O que é

Em cada linha de processo dos três painéis, ao lado do hiperlink dos autos e do ícone de copiar CNJ, agora há um **terceiro ícone** (seta para fora de uma caixa) que abre diretamente **a tarefa corrente do processo** no PJe — não os autos digitais, e não a consulta pública. O comportamento é idêntico ao do link "Abrir tarefa" que o PJe exibe no widget "Documentos pendentes" do painel do usuário interno:

```
onclick="openPopUp('{idProcesso}popUpFluxo',
                   '/pje/Processo/movimentar.seam?idProcesso=X&newTaskId=Y')"
```

Uma janela popup **nomeada** (`{idProcesso}popUpFluxo`) é aberta no origin do PJe, levando o usuário direto à tela de movimentação da tarefa. Se o usuário clicar em duas linhas do mesmo processo, a segunda reaproveita a janela aberta — mesmo comportamento do painel nativo.

---

## 2. Motivação

Antes dessa feature, fluxo típico do servidor no painel `paidegua`:

1. Ver um processo que precisa de atenção (ex.: prazo vencendo, processo atrasado em "Controle de prazo").
2. Clicar no link dos autos → abre `listAutosDigitais.seam` em aba nova.
3. Para *agir* na tarefa, precisa voltar ao painel do PJe, procurar o processo na lista da tarefa correspondente, clicar nele.

Passo 3 é **atrito puro** — o servidor já sabe qual processo, qual tarefa, e qual ação precisa tomar. O `paidegua` tinha toda a informação necessária para oferecer o atalho, mas não oferecia.

A nova feature encurta o caminho: do painel `paidegua` direto para a tela de movimentação, preservando a sessão PJe do usuário.

---

## 3. Como o PJe resolve "abrir tarefa" — o elemento investigado

O ponto de partida foi o elemento HTML que o PJe renderiza na aba "Documentos pendentes" do painel do usuário interno:

```html
<a href="#"
   id="processoDocumentoNaoLidoForm:processoDocumentoNaoLidoDataTable:156909830:j_id351:0:j_id357"
   onclick="openPopUp('2669589popUpFluxo',
                      '/pje/Processo/movimentar.seam?idProcesso=2669589&amp;newTaskId=2799353679');;
            A4J.AJAX.Submit('processoDocumentoNaoLidoForm', event, { … });
            return false;"
   target="2669589popUpFluxo"
   title="Abrir tarefa">
  [JEF] Controle de prazo para contrarrazões do recurso - Em curso
  <i class="fa fa-external-link"></i>
</a>
```

Três pontos importantes:

- **URL da tarefa:** `/pje/Processo/movimentar.seam?idProcesso=X&newTaskId=Y`
- **Nome da janela popup:** `{idProcesso}popUpFluxo` (determinístico — permite reuso entre cliques).
- **`A4J.AJAX.Submit`:** bookkeeping interno do PJe (RichFaces/AJAX4JSF) para atualizar o próprio widget "Documentos pendentes". **Não é necessário** para abrir a tarefa — é apenas a atualização visual da lista de onde o clique saiu.

### 3.1 O parâmetro `newTaskId`

A hipótese testada — e validada — é que **`newTaskId` da URL é o mesmo `idTaskInstance` que a API REST `recuperarProcessosTarefaPendenteComCriterios` devolve** em cada entidade de processo. Ver [`PJeApiProcesso.idTaskInstance`](../src/shared/types.ts) e o coletor em [`src/content/pje-api/pje-api-from-content.ts`](../src/content/pje-api/pje-api-from-content.ts).

Exemplo (do elemento de referência acima):

| Fonte                                 | Campo            | Valor         |
|---------------------------------------|------------------|---------------|
| URL do link `openPopUp`               | `idProcesso`     | `2669589`     |
| URL do link `openPopUp`               | `newTaskId`      | `2799353679`  |
| API `recuperar…CriteriosTarefaPend…`  | `idProcesso`     | `2669589`     |
| API `recuperar…CriteriosTarefaPend…`  | `idTaskInstance` | `2799353679`  |

Com isso **os dois dados que o PJe precisa para abrir a tarefa já vinham sendo coletados** pelos pipelines de API — a feature foi basicamente *"esse valor que a gente já tinha serve como `newTaskId`"*.

---

## 4. Implementação

### 4.1 Helper compartilhado

Toda a lógica foi isolada em [`src/shared/pje-task-popup.ts`](../src/shared/pje-task-popup.ts):

```ts
export function montarUrlTarefa(opts: AbrirTarefaOpts): string | null
export function abrirTarefaPopup(opts: AbrirTarefaOpts): boolean
export function podeAbrirTarefa(idProcesso, idTaskInstance): boolean
export const OPEN_TASK_ICON_SVG: string
```

Decisão de desenho importante: **o helper não recebe o origin do PJe como parâmetro**. Em vez disso, pede uma `referenciaUrlAutos` — tipicamente a URL de `listAutosDigitais.seam` que o painel já carrega para cada linha — e extrai o origin via `new URL(url).origin`.

Por que:
- Evita propagar `legacyOrigin` por toda a cadeia *payload → storage.session → dashboard*.
- O origin já está implícito na URL dos autos que cada linha carrega.
- Se a URL dos autos for inválida (linha vinda de fallback DOM sem autenticação), `podeAbrirTarefa` + `montarUrlTarefa` falham com `false`/`null` e o botão nem aparece — política "falhar em silêncio, não mostrar botão quebrado".

### 4.2 `podeAbrirTarefa` — por que o guard

```ts
export function podeAbrirTarefa(idProcesso, idTaskInstance): boolean {
  if (!idProcesso || !idTaskInstance) return false;
  if (idProcesso === idTaskInstance) return false;
  return true;
}
```

O *check* `idProcesso === idTaskInstance` não é paranoia: o **fallback DOM do `analisar-tarefas.ts`** historicamente grava `idProcesso := idTaskInstance` (o `<span class="hidden" id="…">` do cartão Angular expõe apenas o `idTaskInstance`, não o `idProcesso` real). Esse conflito é *conhecido* e tratado por exclusão: nessa linha o botão não aparece. Só renderiza quando os dois valores existem **e são distintos** — condição que só a API REST satisfaz.

### 4.3 Propagação do `idTaskInstance` até `TriagemProcesso`

O caminho API já tinha `idTaskInstance` em [`PJeApiProcesso`](../src/shared/types.ts) (usado para montar `listAutosDigitais.seam?…&idTaskInstance=Y`). Mas o tipo [`TriagemProcesso`](../src/shared/types.ts), que é o formato canônico consumido pelos dashboards Triagem e Gestão, **não carregava o campo**.

Mudanças:

1. [`TriagemProcesso`](../src/shared/types.ts) ganhou `idTaskInstance: string | null`.
2. [`triagemProcessoFromApi`](../src/content/gestao/triagem-from-api.ts) popula `String(p.idTaskInstance)` quando disponível.
3. [`analisar-tarefas.ts`](../src/content/triagem/analisar-tarefas.ts) (caminho DOM) explicitamente deixa `null` — documentado in-line como *"ambos saem do mesmo span, não dá para diferenciar"*.

O payload do dashboard **Prazos na Fita** é diferente — ele carrega `PJeApiProcesso` inteiro dentro de `consolidado[i].processoApi`, então o botão é montado direto a partir daí sem precisar mexer em tipos compartilhados.

### 4.4 Integração em cada dashboard

Cada um dos três dashboards tem seu próprio padrão de rendering da célula do processo, então a integração foi feita caso a caso mas seguindo o mesmo shape visual:

| Dashboard                                                                           | Estilo de render         | Estratégia de clique                    |
|-------------------------------------------------------------------------------------|--------------------------|-----------------------------------------|
| [`prazos-fita-dashboard`](../src/prazos-fita-dashboard/prazos-fita-dashboard.ts)    | HTML string (innerHTML)  | Event delegation em `document`          |
| [`dashboard`](../src/dashboard/dashboard.ts) (Triagem)                              | DOM (`createElement`)    | `addEventListener` no próprio botão     |
| [`gestao-dashboard`](../src/gestao-dashboard/gestao-dashboard.ts)                   | DOM (`createElement`)    | `addEventListener` no próprio botão     |

CSS: `.proc-open-task` replica exatamente o visual de `.proc-copy` (borda, hover primary, focus-visible) em cada um dos três arquivos CSS, para manter coerência.

### 4.5 Janela nomeada e reuso

O `window.open(url, '{idProcesso}popUpFluxo', …)` usa **o mesmo nome** que o PJe usa. Consequências:

- Se o usuário já tem uma janela do PJe aberta com esse nome (via clique no painel nativo), o navegador **reaproveita**.
- Cliques subsequentes no mesmo processo no `paidegua` também reaproveitam.
- Cliques em **processos diferentes** abrem janelas diferentes — cada `idProcesso` vira um nome distinto.

**Não usamos `noopener`** intencionalmente — `noopener` quebra o reuso de janela nomeada em alguns navegadores. Segurança: a URL aberta é do próprio PJe, usando os cookies de sessão do usuário; o risco de reverse tabnabbing é o mesmo que clicar no link nativo.

---

## 5. Limitações e casos-limite

### 5.1 Fallback DOM não oferece o botão

Quando o usuário roda "Analisar tarefas" **sem ter capturado antes o snapshot de auth REST** (ex.: primeira vez na sessão, veio direto sem abrir tarefa alguma), o `paidegua` ainda consegue coletar via DOM scraping — mas aí `idTaskInstance` fica `null` e o botão não aparece. **Decisão consciente:** preferimos ausência silenciosa a um botão que abre a tarefa *errada*.

Se isso virar um atrito recorrente, a solução é investir na captura antecipada do snapshot (ver §6.2), não em tentar inferir `idProcesso` a partir do DOM Angular — o `<span id>` do cartão só expõe `idTaskInstance`, não o `idProcesso`.

### 5.2 Popup bloqueado

Se o navegador bloquear a janela (alguns users têm "block all pop-ups" agressivo), `window.open` retorna `null` e o `paidegua` mostra toast `"Não foi possível abrir a tarefa (popup bloqueado?)"`. Ação do usuário: liberar o origin do PJe no ícone de popup bloqueado da barra.

Não tentamos fallback para `target="_blank"` em `<a>` porque perderíamos o nome de janela e portanto o reuso — e o cenário real é suficientemente raro.

### 5.3 Sessão expirada no PJe

Se a sessão PJe do usuário expirou, o popup abre mas o PJe redireciona para o fluxo de login. O usuário autentica normalmente e volta à tarefa. Nenhum tratamento especial é necessário — a extensão não gerencia autenticação PJe.

### 5.4 Cross-origin

A extensão roda em páginas próprias (`chrome-extension://…`). O `window.open` para `https://pje1g.trf5.jus.br/…` é cross-origin — o que **significa apenas** que não temos acesso à janela filha via `w.document`. Não precisamos acessar: só queremos que o PJe faça seu trabalho lá. Cookies da sessão PJe são enviados pelo navegador automaticamente (são cookies do próprio domínio do PJe, não da extensão).

---

## 6. Impactos — o que esse conhecimento destrava

Agora que está validado que a tríade **`{idProcesso, idTaskInstance, origin}`** é suficiente para **navegar programaticamente dentro do fluxo de tarefas do PJe**, abrem-se várias oportunidades de produto.

### 6.1 Ações diretas de tarefa (além de "abrir")

`movimentar.seam` é o ponto de entrada da *máquina de estados de tarefa* do PJe. Possíveis extensões:

- **"Marcar como conferido"** direto do painel — se o PJe expõe um endpoint REST para transição de estado simples (ex.: "Dar por conferido"), o `paidegua` poderia oferecer uma ação em lote. Precisa de investigação: o Angular do painel provavelmente chama esse endpoint ao clicar no botão "Confere" do cartão; se for REST com mesmo snapshot de auth que já capturamos, funciona.
- **"Encaminhar para triagem"** em lote — mesmo princípio.

**Risco institucional:** ações em lote sem confirmação visual do PJe podem ser vistas com desconfiança. Idealmente, essas ações "em massa" só seriam oferecidas para perfis de Gestão e sempre com dialog de confirmação listando os processos afetados.

### 6.2 Pré-aquecimento do snapshot de auth

O fallback DOM (e a consequente ausência do botão "Abrir tarefa") acontece quando o snapshot de auth ainda não foi capturado. Hoje depende de o usuário *acidentalmente* abrir uma tarefa primeiro. Com o conhecimento de que `movimentar.seam` é seguro de chamar, poderíamos:

- **Disparar uma chamada trivial** à API REST assim que o painel é detectado, para provocar a captura do snapshot (endpoint `gerarChaveAcessoProcesso/0` ou outro inofensivo). Evita o estado "primeira vez, sem botões úteis".

### 6.3 Deep links para tarefa em relatórios

Hoje os relatórios `.docx`/CSV gerados pelo `paidegua` linkam **aos autos**. A existência de um link estável `movimentar.seam?idProcesso=X&newTaskId=Y` permite oferecer uma **segunda coluna de links** que leva direto à tarefa — útil para relatórios de triagem distribuídos por e-mail/Teams, onde o destinatário clica e já cai no lugar de agir.

Atenção: o link de tarefa *expira* quando a tarefa muda de estado (o `idTaskInstance` é da instância corrente; ao mover para outra tarefa, vira outro ID). Autos digitais não têm esse problema — a URL dos autos permanece válida. Portanto os dois tipos de link **coexistem**, não substituem.

### 6.4 Detecção de inconsistência `idProcesso` ↔ `idTaskInstance`

Com os dois IDs lado a lado, dá para cruzar: se a API devolve um `idTaskInstance` mas o PJe recusa o `movimentar.seam` (HTTP 404 ou redirect pra painel), isso é **sinal forte** de que a tarefa já foi movimentada por outro servidor entre a coleta e a ação. Valendo:

- Como **alerta de concorrência** em cenários de múltiplos servidores na mesma vara.
- Como **gatilho de refresh** automático do dashboard.

Ainda não implementado — só faz sentido a partir do momento em que o `paidegua` oferecer ações (não só links).

### 6.5 Uniformização do `proc-cell`

Três dashboards hoje re-implementam `procNumberSpan` / `renderProcCell` com leves variações (HTML vs DOM, event delegation vs listener direto). Com o terceiro botão agora presente em todos eles, o custo de manter três versões *sincronizadas* cresce. Oportunidade de refactor futuro:

- Extrair `proc-cell` para um componente utilitário compartilhado em `src/shared/proc-cell.ts`.
- Parametrizar: `(numero, url, idProcesso?, idTaskInstance?) → HTMLElement`.
- Os três dashboards chamam a mesma função.

Não feito agora porque o padrão atual está funcionando e um refactor prematuro custa mais que três diffs pequenos. Fica como *refactor oportunístico* para quando um quarto local precisar do mesmo bloco.

### 6.6 Integração com a Triagem Inteligente (botão "Analisar o processo")

Hoje o botão "Analisar o processo" do perfil Secretaria funciona **dentro da tela dos autos**. Como o `movimentar.seam` é a tela onde o servidor de fato **decide** o despacho, faria sentido injetar o botão de análise também lá. Isso exige estender o `content script` para detectar a página `movimentar.seam` além de `listAutosDigitais.seam` — mudança pequena no `pje-host.ts` mais um novo *adapter* para o DOM dessa tela.

### 6.7 Referência para documentação do usuário

O [`manual-instalacao-uso.md`](./manual-instalacao-uso.md) deve ser atualizado com uma seção sobre o novo ícone, especialmente destacando:

- **Quando ele aparece** (só em dados coletados via API — o que na prática é *sempre*, porque o pipeline atual já é API-first).
- **Por que às vezes não aparece** (fallback DOM — raro).
- **O que fazer se o popup não abrir** (popup blocker).

---

## 7. Validação

Validação manual realizada em abril/2026 em [pje1g.trf5.jus.br](https://pje1g.trf5.jus.br), perfil Secretaria (com tarefas de análise inicial) e perfil Gestão (com tarefas de controle de prazo). Os três dashboards renderizaram o terceiro ícone ao lado do copiar, e o clique em cada um deles levou à tela `movimentar.seam` correta para o processo + tarefa da linha.

Caso teste pontual:
- Processo `idProcesso=2669589`, tarefa `idTaskInstance=2799353679` (exemplo da referência inicial).
- Origin extraído automaticamente da URL dos autos (`https://pje1g.trf5.jus.br`).
- Popup aberto como `2669589popUpFluxo`, tela da tarefa carregada sem redirect adicional.

---

## 8. Referências internas

- Helper central: [`src/shared/pje-task-popup.ts`](../src/shared/pje-task-popup.ts)
- Tipos: [`TriagemProcesso`](../src/shared/types.ts), [`PJeApiProcesso`](../src/shared/types.ts)
- Propagação API → canônico: [`src/content/gestao/triagem-from-api.ts`](../src/content/gestao/triagem-from-api.ts)
- Integrações: [`src/dashboard/dashboard.ts`](../src/dashboard/dashboard.ts), [`src/gestao-dashboard/gestao-dashboard.ts`](../src/gestao-dashboard/gestao-dashboard.ts), [`src/prazos-fita-dashboard/prazos-fita-dashboard.ts`](../src/prazos-fita-dashboard/prazos-fita-dashboard.ts)
- Documento irmão sobre a API REST usada para descobrir `idTaskInstance`: [`extracao-tarefas-painel-pje.md`](./extracao-tarefas-painel-pje.md)

---

## 9. Extensão: Encerrar expedientes em lote (coluna "Encerrar" — Prazos na Fita)

A primeira aplicação concreta do par `(idProcesso, idTaskInstance)` além da simples navegação é a coluna **Encerrar** na última posição da tabela do painel "Prazos na Fita pAIdegua". Ela realiza, sem abrir janela visível ao usuário, o fluxo que no PJe nativo exige três cliques e um `confirm()`:

1. Abrir a `movimentar.seam` da tarefa.
2. Marcar o checkbox do header "Fechado" (seleciona todos os expedientes abertos).
3. Clicar em **Encerrar expedientes selecionados** e confirmar o popup.

### 9.1. Por que só neste painel?

O painel de "Prazos na Fita" é o único que sabe *previamente* que a tarefa tem expedientes pendentes — a própria coleta depende disso. Quando surge uma anomalia como *"ciência vencida não encerrada"* ou *"prazo sem data-limite"*, a providência padrão é justamente fechar todos os pendentes. Replicar esse botão nos outros dashboards (Triagem, Gestão) não agrega valor porque eles não olham expedientes.

### 9.2. Arquitetura

- **Dashboard → Background (`PRAZOS_ENCERRAR_RUN`)** — `chrome.runtime.sendMessage` com `{ url: movimentarSeamURL, idProcesso, idTaskInstance, numeroProcesso }`. A URL é montada com o mesmo `montarUrlTarefa` do Feature 1 (reuso total do parsing de origin).
- **Background** (`handlePrazosEncerrarRun` em [`src/background/background.ts`](../src/background/background.ts)):
  - `chrome.tabs.create({ url, active: false })` — aba invisível, mesmo origin do PJe, reutilizando cookies de sessão do usuário.
  - `waitTabComplete` — promessa que resolve no `status === 'complete'` (45 s de timeout).
  - `chrome.scripting.executeScript({ world: 'MAIN', func: encerrarExpedientesNoFrame })` — injeta no *main world* da página (necessário para monkey-patch do `window.confirm` e para disparar handlers inline do RichFaces/A4J que rodam no escopo da própria página).
  - `chrome.tabs.remove(tabId)` no `finally` — garante que a aba é fechada mesmo em erro.
- **Main world** (`encerrarExpedientesNoFrame`):
  1. Salva a referência original de `window.confirm` e substitui por `() => true`.
  2. Seleciona `input[type="checkbox"][id$=":fechadoHeader"]` — se não existir, a aba de expedientes provavelmente não carregou ou a sessão expirou (retorna erro estruturado).
  3. Conta os checkboxes de linha (`[id*=":fechado"]:not([id$=":fechadoHeader"])`) no mesmo escopo (tabela ou form). Zero → `nada-a-fazer` (todos já fechados).
  4. Marca o header (`.checked = true`) e dispara `change` + `click`. Como *fallback*, executa o conteúdo do atributo inline `onchange` via `new Function('event', onchangeAttr).call(header)` — suficiente para RichFaces/A4J recuperarem o `A4J.AJAX.Submit`.
  5. Aguarda ~1,5 s pela AJAX do select-all e localiza o botão **Encerrar expedientes selecionados** por `value`/`textContent` exatos.
  6. `btn.click()` — o `confirm()` inline já retorna `true` automaticamente.
  7. Polling (intervalo 600 ms, teto 25 s) até os checkboxes de linha zerarem. Sucesso → `{ ok, count }`; timeout → `erro` com contagem parcial.
  8. Restaura `window.confirm` no `finally` — a aba será fechada de toda forma, mas é boa higiene.
- **Background → Dashboard** — resposta síncrona do `sendResponse` com `{ ok, estado, quantidade, error? }`. Nada é persistido em cloud; log de auditoria local em `storage.local` (FIFO de 500 entradas, chave `STORAGE_KEYS.PRAZOS_ENCERRAR_AUDIT`).

### 9.3. Experiência no dashboard

- **Cabeçalho da coluna**: "Encerrar" + um `?` com tooltip (`title=`) deixando claro que o clique fecha **todos** os expedientes pendentes da tarefa. Isso substitui um `confirm()` por clique — o usuário já sabe, antes de acionar, qual é o contrato da coluna. Para encerramento parcial, o usuário clica no ícone "Abrir tarefa" (Feature 1) e usa o PJe.
- **Cinco estados visuais**, com chave por tarefa (`${idProcesso}:${idTaskInstance}`) e diferenciação entre a linha clicada e as demais:
  - O estado (executando/sucesso/erro/nada-a-fazer) é *compartilhado* por todas as linhas da mesma tarefa — ação de fato é tarefa-inteira, então todas precisam refletir o andamento.
  - Mas apenas a **linha clicada** (`state.iniciadoPor === idDocumento`) exibe o botão no modo **full** (ícone + rótulo explícito + tooltip detalhado). As demais linhas da mesma tarefa entram em modo **compact** (só ícone, sem rótulo, opacidade reduzida), deixando claro para o usuário qual foi a ação que ele disparou. Design solicitado em abril/2026 após feedback de que "um clique pintava todas as linhas como se o usuário tivesse clicado em cada uma".
  - Enquanto o estado é `pronto` (ninguém clicou ainda), todas as linhas aparecem no modo full — o usuário escolhe em qualquer delas.
  | Estado | Ícone | Cor | Clicável? | Tooltip |
  |---|---|---|---|---|
  | `pronto` | lixeira | neutra | sim | "Fechar todos os expedientes desta tarefa no PJe." |
  | `executando` | spinner | primária | não | "Fechando expedientes no PJe — aguarde." |
  | `sucesso` | check | verde | não | "Encerrado às HH:MM — N expediente(s)." |
  | `erro` | triângulo de aviso | amarelo | sim (re-tentativa) | "Falhou às HH:MM: \<erro\>. Clique para tentar de novo." |
  | `nada-a-fazer` | traço | cinza | não | "Todos os expedientes desta tarefa já estavam fechados." |
- **Fila serial**: apenas uma execução simultânea (`encerrarRunningKey`). Cliques em outras linhas enquanto há trabalho em andamento vão para `encerrarQueue` e são drenados em ordem, evitando competição por aba/sessão.
- **Persistência do estado**: `chrome.storage.local` em `STORAGE_KEYS.PRAZOS_ENCERRAMENTOS`. Sobrevive a F5 do dashboard — entradas em `executando` no momento do recarregamento são rebaixadas a `erro` com mensagem explicativa (não ficam presas no spinner).

### 9.4. Limitações e riscos

- **Sessão expirada**: se o cookie do PJe expirar, `movimentar.seam` cai na tela de login e os seletores não serão encontrados → estado `erro` com mensagem sugerindo reautenticação. A aba é fechada de todo jeito.
- **Mudanças no DOM do PJe**: se o PJe renomear `:fechadoHeader` ou mudar o rótulo do botão, a automação falha por "não encontrou". A manutenção é trivial (um seletor), mas vale monitorar.
- **Sem paralelismo**: para encerrar em lote (varredura inteira do painel), o fluxo atual leva N×tempo-de-aba. Pode ser paralelizado no futuro (pool de 2-3 abas), mas a complexidade compensa pouco num painel que normalmente tem poucas anomalias a resolver.
- **Monkey-patch de `confirm` é escopado à própria aba efêmera** — não vaza para nenhuma outra aba PJe do usuário, porque a automação roda em uma tab isolada criada só para isso.

### 9.5. Impactos futuros

- **Outras ações em lote na `movimentar.seam`**: qualquer ação do PJe que hoje pede um `confirm()` (ex.: "Encerrar tarefa", "Remover ciência", "Enviar para arquivo") pode ser automatizada pelo mesmo esqueleto (aba invisível + monkey-patch + clique). Cada ação é um novo `encerrarExpedientesNoFrame`-like.
- **Visão auditável**: o log em `STORAGE_KEYS.PRAZOS_ENCERRAR_AUDIT` habilita uma futura seção "Últimos encerramentos automáticos" no painel, com filtros por data/tarefa — útil para o diretor/secretário acompanhar o que foi feito sem sair do pAIdegua.
- **Ponte com os outros painéis**: nada impede que a Triagem ou a Gestão chamem o mesmo canal `PRAZOS_ENCERRAR_RUN` — o canal é agnóstico à origem do clique, só exige `(idProcesso, idTaskInstance)`. Caso surja a necessidade de encerrar expedientes durante a triagem, o botão pode ser replicado sem novo handler.

### 9.6. Validação

- Pipeline end-to-end compilado com `tsc --noEmit` limpo e `webpack --mode production` sem warnings.
- O fluxo depende de: (a) `idTaskInstance` populado no payload (já é — introduzido no Feature 1); (b) URL dos autos disponível (para derivar o origin); (c) sessão do PJe ativa na mesma origin. As três condições são as mesmas do botão "Abrir tarefa", então qualquer linha onde aquele botão aparece também pode receber o botão "Encerrar".

### 9.7. Referências internas

- Handler no service worker: `handlePrazosEncerrarRun` em [`src/background/background.ts`](../src/background/background.ts)
- Automação main-world: `encerrarExpedientesNoFrame` em [`src/background/background.ts`](../src/background/background.ts)
- UI da coluna: `renderEncerrarCell`, `renderEncerrarBtn`, fila serial e persistência em [`src/prazos-fita-dashboard/prazos-fita-dashboard.ts`](../src/prazos-fita-dashboard/prazos-fita-dashboard.ts)
- Canais e chaves de storage: [`MESSAGE_CHANNELS.PRAZOS_ENCERRAR_RUN`](../src/shared/constants.ts), [`STORAGE_KEYS.PRAZOS_ENCERRAMENTOS`](../src/shared/constants.ts), [`STORAGE_KEYS.PRAZOS_ENCERRAR_AUDIT`](../src/shared/constants.ts)
