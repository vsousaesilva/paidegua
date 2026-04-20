# Post-mortem — "Prazos na Fita pAIdegua": cascata de falhas e correções

**Datas das investigações:** 2026-04-18 (§§1–7 — cascata de 5 bugs) e
2026-04-20 (§8 — cache de `ca` envenenado).
**Funcionalidade afetada:** Botão *"Prazos na Fita pAIdegua"* (perfil Gestão) — extração
de expedientes em tarefas *"Controle de prazo"* via API REST do PJe legacy.
**Status final:** Resolvido — coleta retoma o comportamento esperado (contagem
completa, sem duplicação de mensagens, dashboard renderiza com dados, contagem
de expedientes abertos bate com a regra de negócio).

---

## 1. Sumário executivo

Usuário reportou que a funcionalidade *"Prazos na Fita"* — que até poucas horas antes
operava normalmente — passou a abrir o dashboard **vazio** instantaneamente após o
clique em *"iniciar coleta"*, sem qualquer log visível no console. A investigação
revelou **cinco problemas distintos**, em camadas diferentes do pipeline, que estavam
mascarados uns pelos outros. Cada correção revelou a próxima falha. Ao final, foram
modificados sete arquivos em quatro camadas (content script page-world,
content script isolated-world, coordinator, painel de progresso).

**Causa raiz da regressão original:** expiração silenciosa do SSO Keycloak do PJe,
que fez o painel Angular cair no fallback de autenticação *Basic dummy*
(`X:12345`). Esse fallback violava um pressuposto implícito do nosso interceptor de
autenticação (que exigia um token *Bearer*) e quebrou em cascata toda a coleta via
API REST.

---

## 2. Linha do tempo da investigação

### Fase 1 — Dashboard vazio, silêncio absoluto

**Sintoma:** usuário clica em *"iniciar coleta"*, o painel de progresso aparece
por uma fração de segundo e, em seguida, abre o dashboard sem linhas. Nenhum log
no console do PJe, nenhum log no service worker, nenhum log no dashboard.

**Hipótese inicial:** a coleta estava rodando mas retornando vazio por algum
motivo silencioso. Procurei pontos onde retornos vazios viam-se convertidos em
"sucesso" sem aviso.

**Achado:** em [prazos-fita-coordinator.ts](../src/content/gestao/prazos-fita-coordinator.ts),
quando **todas** as tarefas listadas via API falhavam, o retorno era
`{ consolidado: [] }` — tratado como sucesso pelo caller. Isso disparava o fluxo
DONE → READY → redirect pro dashboard, que renderizava zerado.

**Ação 1.1:** fazer `coletarPrazosPorTarefasViaAPI` **lançar exceção** quando
todas as tarefas falharem, propagando o erro até a UI.

```ts
if (todos.length === 0 && errosPorTarefa.length > 0) {
  throw new Error(
    `Nenhuma tarefa pode ser lida via API. ${errosPorTarefa.join(' | ')}`
  );
}
```

**Ação 1.2:** em [pje-api-from-content.ts](../src/content/pje-api/pje-api-from-content.ts),
adicionar `console.warn` ao retornar *"Sem snapshot de auth"*, que antes era
silencioso.

**Resultado:** a falha subjacente tornou-se visível — *"Nenhuma tarefa pode ser
lida via API. '...': Sem snapshot de auth — abra o painel do PJe e clique em
qualquer tarefa para capturar."*

---

### Fase 2 — "Sem snapshot de auth" mesmo com painel aberto

**Sintoma:** usuário abria o painel, clicava em tarefas, recarregava — a
mensagem persistia. Contra-argumento crítico do usuário:
> *"Mas como isso, se até 1h atrás funcionava?"*

Esse push-back foi decisivo: impediu que eu aceitasse a primeira explicação
conveniente (regex desatualizada no interceptor) como causa raiz.

**Investigação:** adicionei logs diagnósticos temporários no
[pje-auth-interceptor-page.ts](../src/content/auth/pje-auth-interceptor-page.ts)
para inspecionar cada chamada que atravessava o interceptor.

**Achado:** o interceptor **estava** capturando as chamadas e os headers. Mas o
`Authorization` agora vinha como `Basic WDoxMjM0NQ==` (decodificado: `X:12345`),
não mais como `Bearer <JWT>`. Nossa condição exigia o prefixo *Bearer* para
aceitar o snapshot.

**Causa raiz descoberta:** o SSO Keycloak do TRF5 havia expirado silenciosamente
(observável no URL `silent-check-sso.html#error=login_required`). O PJe caiu no
fallback Basic com credencial dummy `X:12345`. A autenticação real continuava
válida — ela depende do cookie `JSESSIONID` mais os headers `X-pje-cookies`,
`X-pje-legacy-app` e `X-pje-usuario-localizacao`; o header `Authorization`
existe apenas para paridade com o que o Angular envia.

**Ação 2.1:** em [pje-auth-interceptor-page.ts](../src/content/auth/pje-auth-interceptor-page.ts)
e [pje-auth-interceptor.ts](../src/content/auth/pje-auth-interceptor.ts), aceitar
qualquer esquema de autenticação (`Bearer`, `Basic`, etc.) desde que o header
não esteja vazio.

**Ação 2.2 (preventiva):** estender o snapshot para capturar também `X-no-sso`
e `X-pje-authorization` (disponíveis no tráfego original do Angular), com
alterações em [types.ts](../src/shared/types.ts) e no `montarHeaders` do cliente
REST.

**Resultado:** snapshot passa a ser persistido corretamente, mas a próxima falha
aparece imediatamente.

---

### Fase 3 — "Unexpected end of JSON input"

**Sintoma:** após o snapshot ser capturado, a listagem devolvia 200 OK com corpo
**vazio**, e o `resp.json()` lançava exceção.

**Diagnóstico:** o servidor rejeitava silenciosamente nossa chamada porque
estávamos enviando apenas 4 dos 8 headers que o Angular envia. Crítico era o
`X-no-sso`, que sinaliza ao backend *"não tente validar o token no Keycloak, usa
o cookie direto"* — sem ele, com auth Basic dummy, o backend responde 200 vazio
em vez de 401, porque o legacy Seam não sabe lidar com a combinação.

**Ação 3.1:** replicar todos os headers relevantes capturados pelo snapshot no
`montarHeaders`.

**Ação 3.2:** proteção defensiva em `listarProcessosDaTarefa`:

```ts
const raw = await resp.text();
if (!raw) {
  return {
    ok: false, total, processos: acumulado,
    error: `HTTP 200 com corpo vazio listando "${req.nomeTarefa}" — ` +
           `provavel rejeicao silenciosa de auth (headers enviados: ` +
           `${Object.keys(headers).join(', ')}).`
  };
}
const json = JSON.parse(raw);
```

**Resultado:** coleta volta a operar. Próximo problema: mensagens duplicadas no
painel.

---

### Fase 4 — Painel registra cada mensagem 2×

**Sintoma:** no log do painel de progresso, cada linha (*"Coleta iniciada"*,
*"[API] listando..."*, *"[expedientes] N/M"*) aparecia duas vezes.

**Hipóteses descartadas por inspeção:**
- Listener duplicado no content script — grep confirmou único `addListener`.
- Listener duplicado no painel — único `addListener`.
- Content script carregado em múltiplos frames — o handler tem
  `if (window !== window.top) return false`.
- Idempotência por `requestId` — adicionei um `Set<string>` e verifiquei
  via `grep -c "ja em curso" dist/content.js = 1`. Mesmo assim, o duplicado
  persistiu.

**Diagnóstico decisivo:** adicionei logs com contagem e rid em ambos os lados.
O resultado:

- `handlePrazosFitaRunColeta acionado` — **1 vez** no content.
- `painel recebeu PROG rid=...` — **2 vezes** no painel.

Ou seja: o content executa apenas uma vez (o guarda nunca foi acionado),
mas o painel recebe duas cópias da mesma mensagem.

**Causa raiz:** quando o content script chama
`chrome.runtime.sendMessage(msg)` sem destinatário, Chrome **broadcasta** a
mensagem para **todas as extension views abertas**, não apenas para o service
worker. O painel é uma extension view (`chrome-extension://.../painel.html`)
e tem listener em `chrome.runtime.onMessage` — portanto recebe a mensagem
diretamente. Ao mesmo tempo, o background também recebe e relaya via
`chrome.tabs.sendMessage(painelTabId, ...)`. Painel recebe duas cópias:
uma do broadcast direto, outra do relay via aba.

**Ação 4.1:** em [painel.ts:308](../src/gestao-painel/painel.ts#L308), filtrar
pelo `sender.tab`. Mensagens do broadcast direto do content trazem `sender.tab`
preenchido com a aba do PJe. Mensagens do relay via background chegam com
`sender.tab === undefined` (service worker não tem tab). Aceitamos apenas
o caminho (2) — o relay canônico:

```ts
if (sender?.tab) return false;
```

**Resultado:** uma linha por mensagem, como esperado.

---

### Fase 5 — Divergência `count=8 entities=7`

**Sintoma:** tarefa com 8 processos mostrava, após a correção da Fase 4,
resposta do servidor com `count=8` mas apenas 7 entities. Usuário perguntou:
*"Por que count=8 entities=7?"*.

**Investigação estruturada:** apresentei quatro cenários possíveis
(filtro server-side, body incompleto, flag `/false` do path, fallback DOM)
e comecei pelo de custo mais baixo.

**Teste 1 — trocar `/false` por `/true`:** resposta `count=0 entities=0`.
Conclusão: o flag muda o predicado (provavelmente *"apenas prioritários"*
ou similar), não é filtro de visibilidade. Revertido.

**Teste 2 — capturar o body real do Angular:** adicionei captura de body
no interceptor e o usuário colou o payload:

```json
{
  "numeroProcesso": "",
  "classe": null,
  "tags": [],
  "page": 0,
  "maxResults": 300,
  "competencia": "",
  ... (40 campos, todos null exceto page, maxResults, numeroProcesso, tags, competencia)
}
```

Nosso cliente enviava apenas `{page, maxResults}` com **`page: 1`** (1-indexed).
Angular envia o **body completo** com **`page: 0`** (0-indexed).

**Ação 5.1:** em [pje-api-from-content.ts:212](../src/content/pje-api/pje-api-from-content.ts#L212),
replicar fielmente o body do Angular (~40 campos, todos nulos exceto os
poucos setados) e alinhar a paginação para 0-indexed.

**Resultado validado:**

```
[REST] "[JEF] Controle de prazo..." pag 0:
count=8 entities=8 novos=8 acumulado=8 descartados={dup:0, idInvalido:0}
```

Coleta 100% alinhada com o painel nativo.

---

## 3. Arquivos modificados

| Arquivo | Mudança |
|---|---|
| [src/content/auth/pje-auth-interceptor-page.ts](../src/content/auth/pje-auth-interceptor-page.ts) | Regex mais permissiva (`/pje-legacy/` em vez de `/pje-legacy/api/`); aceita qualquer esquema de Authorization; captura `X-no-sso` e `X-pje-authorization` |
| [src/content/auth/pje-auth-interceptor.ts](../src/content/auth/pje-auth-interceptor.ts) | `isAuthSnapshot` não exige mais prefixo `Bearer` |
| [src/shared/types.ts](../src/shared/types.ts) | `PJeAuthSnapshot` estendido com `xNoSso` e `xPjeAuthorization` |
| [src/content/pje-api/pje-api-from-content.ts](../src/content/pje-api/pje-api-from-content.ts) | `montarHeaders` replica todos os headers capturados; body completo alinhado ao Angular; `page: 0` zero-indexed; detecção defensiva de corpo vazio |
| [src/content/gestao/prazos-fita-coordinator.ts](../src/content/gestao/prazos-fita-coordinator.ts) | Lança exceção quando todas as tarefas falham (em vez de retornar silenciosamente vazio) |
| [src/content/content.ts](../src/content/content.ts) | Idempotência por `requestId` em `handlePrazosFitaRunColeta` (defensiva, contra disparo duplicado) |
| [src/gestao-painel/painel.ts](../src/gestao-painel/painel.ts) | Dedupe de mensagens do content — aceita apenas as vindas do relay do background (`sender.tab === undefined`) |

---

## 4. Riscos identificados durante a investigação

### Risco 1 — Falhas silenciosas mascaram causas-raiz

Três dos cinco problemas tinham variação do mesmo padrão: um caminho de erro
retornava sucesso com dado vazio. Isso faz o sistema parecer funcionar enquanto
corrompe silenciosamente os resultados. No caso extremo (Fase 1), o usuário
viria "dashboard vazio" e concluiria que não há processos — diagnóstico
totalmente oposto ao real.

**Mitigação aplicada:** fail loudly. Toda função que listava processos agora
distingue *"zero resultados legítimos"* de *"falha de infraestrutura"* e
propaga o segundo como exceção.

### Risco 2 — Pressupostos implícitos em código defensivo

Três fases (2, 3, 5) vieram do mesmo tipo de bug: **nosso código assumia algo
que o servidor não garante**. Exigir `Bearer`, enviar só 4 headers, mandar body
mínimo — tudo funcionava *"por coincidência"* enquanto o PJe estava numa
configuração específica, e quebrou quando essa configuração mudou.

**Mitigação aplicada:** quando replicamos o comportamento de um cliente
legítimo (Angular do painel), devemos copiar **exatamente** o que ele faz,
não uma versão simplificada. O risco de enviar menos campos é alto; o custo
de enviar os 40 é zero.

### Risco 3 — Broadcasts implícitos do Chrome Extension API

O bug da Fase 4 (2×) é particularmente insidioso porque:
- `chrome.runtime.sendMessage` não parece um broadcast — o nome sugere
  mensagem ponto-a-ponto.
- A documentação menciona o broadcast de passagem, mas não é óbvio.
- O sintoma (duplicação) aparece apenas quando extension views estão abertas
  simultaneamente, o que não acontece em testes unitários nem em fluxos
  simples.

**Mitigação aplicada:** filtro por `sender.tab` no painel. Documentado em
comentário extenso no código — se alguém reintroduzir o mesmo tipo de listener
em outra view, o comentário deve alertar.

### Risco 4 — Aceitação prematura de explicações convenientes

Durante a Fase 2, meu primeiro palpite foi *"a regex está desatualizada"*.
Funcionou como narrativa, mas **não explicava por que funcionou até 1h atrás**.
O usuário rejeitou a explicação, o que forçou uma investigação mais profunda
e revelou a causa raiz (expiração do SSO). Se eu tivesse aceitado o primeiro
palpite, a causa real ficaria oculta e provavelmente voltaria a se manifestar
em outra ocasião.

**Mitigação aplicada:** quando há uma regressão ("funcionava ontem, não
funciona hoje"), toda hipótese precisa responder à pergunta *"o que mudou
desde ontem?"*. Se a hipótese não encaixa com essa linha do tempo, ela
provavelmente está errada.

---

## 5. Oportunidades de aprendizado

### 5.1 Arquitetura de mensagens em extensões Chrome MV3

As extensions do Chrome têm três contextos isolados (content script / background
/ extension page) e três mecanismos de mensagem (`runtime.sendMessage`,
`tabs.sendMessage`, `connect`). Cada mecanismo tem semântica de entrega diferente.
Regras práticas aprendidas:

- **`chrome.runtime.sendMessage` é broadcast**, não unicast. Vai pro service
  worker E todas as extension views abertas.
- **`chrome.tabs.sendMessage`** com frameId omitido entrega a **todos** os
  frames da aba (não só o top).
- Para deduplicar em extension views, filtrar por `sender.tab`: mensagens
  vindas do content script têm tab; vindas do service worker não têm.
- O listener do painel deve ser registrado **uma única vez** por requestId,
  idealmente no `main()` module-level. `addListener` múltiplos na mesma view
  não são idempotentes.

### 5.2 Reverse-engineering de APIs legacy via interceptor

O padrão *"page-world interceptor + isolated-world bridge"* já estava
implementado e provou ser de **altíssimo valor**. A Fase 5 só foi resolvida
em minutos porque estendi o interceptor para capturar o body, permitindo ver
o que o Angular realmente envia. Sem isso, estaríamos tentando adivinhar por
tentativa e erro.

**Para o futuro:** quando uma API legacy se comportar de forma inesperada,
estender temporariamente o interceptor para capturar payload completo é mais
barato do que ler documentação que provavelmente não existe.

### 5.3 Debugging em cascata — anti-padrão e antídoto

Cada fase desta investigação começou com uma afirmação do tipo *"agora
apareceu um novo erro"*. Isso é característico de **falhas em camadas
encadeadas**: uma camada protege a outra da visibilidade do problema.

**Antídoto aprendido:** não celebrar cada correção individual. Depois de
corrigir a visibilidade (Fase 1), seria prudente antecipar que *"vou ver
outros erros que estavam escondidos"* — e preparar o terreno para diagnosticar
rapidamente cada um, em vez de reagir um por um.

### 5.4 Quando diagnósticos temporários valem o investimento

Adicionei logs `[diag-2x]` e `[diag-body]` apenas para esta investigação.
Em ambos os casos, o log resolveu o mistério em um ciclo de teste. Estratégia
que funcionou:

1. **Hipótese com múltiplas explicações concorrentes:** listar as 3-4
   possibilidades antes de codar.
2. **Log que distingue entre elas:** o log `[diag-2x]` tinha informação
   suficiente pra isolar qual dos 4 cenários era o real.
3. **Remoção após resolução:** diagnósticos temporários poluem o console e
   confundem usuários futuros. Remover junto com a resolução é parte do fix.

### 5.5 Memória institucional de regressões

Esta regressão começou com *"até 1h atrás funcionava"* — um sinal que só o
usuário pôde dar. O sistema não tem telemetria, logs persistentes ou alarme
nenhum. Se fosse um sistema crítico em produção:

- Precisaria de observabilidade mínima (ex.: contagem de erros "Sem snapshot"
  agregada por dia).
- Idealmente, teste de smoke diário que faça a coleta de uma tarefa conhecida
  e valide `count === entities`.

Como o pAIdegua opera em ambiente controlado (extensão local, usuário presente),
o risco é aceitável. Mas vale registrar que a regressão teria ficado invisível
se o usuário não tivesse reportado.

---

## 6. Checklist de verificação pós-correção

- [x] Coleta lista todos os processos esperados (`count === entities`).
- [x] Logs do painel mostram cada mensagem uma única vez.
- [x] Dashboard renderiza com dados quando a coleta tem sucesso.
- [x] Dashboard mostra erro visível quando todas as tarefas falham.
- [x] Snapshot de autenticação é capturado tanto em SSO Keycloak vigente
      quanto em fallback Basic dummy pós-expiração.
- [x] Headers `X-no-sso` e `X-pje-authorization` são replicados nas
      chamadas REST.
- [x] Build de produção limpo, sem logs de diagnóstico residuais.

---

## 7. Referências rápidas (para futuras investigações)

- **Endpoint de listagem de tarefa:**
  `POST /pje/seam/resource/rest/pje-legacy/painelUsuario/recuperarProcessosTarefaPendenteComCriterios/{nomeTarefa}/false`
- **Body esperado:** ver template em
  [pje-api-from-content.ts:212](../src/content/pje-api/pje-api-from-content.ts#L212).
- **Headers críticos:** `Authorization`, `X-pje-cookies`, `X-pje-legacy-app`,
  `X-pje-usuario-localizacao`, `X-no-sso`, `X-pje-authorization`.
- **Identificar SSO expirado:** URL do iframe `frontend-prd` contém
  `silent-check-sso.html#error=login_required`.
- **Reabilitar captura de body do Angular (diagnóstico):** reintroduzir o
  bloco `logBodyIfRelevant` que foi removido de
  [pje-auth-interceptor-page.ts](../src/content/auth/pje-auth-interceptor-page.ts)
  (ver histórico git — commit desta investigação).

---

## 8. Regressão de 2026-04-20 — Cache de `ca` envenenado

### 8.1 Sintoma

Usuário reportou que o dashboard, em uma unidade com **1 072 processos em
"Controle de prazo"**, mostrava apenas **8 expedientes abertos**. Regra de
negócio: processos nessas tarefas devem ter pelo menos 1 expediente aberto
(estar em "Controle de prazo" existe *porque* há expediente aberto). Em
sessão anterior (antes das mudanças recentes), o mesmo relatório mostrava
~1 expediente por processo — dado que o usuário considerava confiável.

### 8.2 Hipóteses iniciais descartadas

**Hipótese 1 (incorreta):** `listAutosDigitais.seam?aba=processoExpedienteTab`
não estaria renderizando a aba Expedientes via SSR. Teste com IDs de um
processo real: HTTP 200, 208 KB de HTML, tbody presente com 16 linhas.
**Descartada.**

Push-back do usuário foi decisivo: *"até ontem o dado era confiável — o
que mudou?"* Isso forçou investigação da regressão em vez de aceitar que
"8 faz sentido".

### 8.3 Diagnóstico — teste comparativo

Na console da aba PJe, testei **mesmo `idProcesso`** com duas `ca`
diferentes:

| Origem do `ca`                | HTTP  | Tamanho   | tbody | Linhas |
|-------------------------------|-------|-----------|-------|--------|
| Cacheado em `storage.local`   | 200   | ~32 KB    | ausente| 0      |
| Recém-gerado (`gerarChaveAcesso`) | 200 | ~208 KB   | presente| 16     |

O servidor estava respondendo **HTTP 200 com stub HTML** quando o `ca`
cacheado já não era válido — em vez de 4xx. O parser
`extractExpedientesFromDoc` trata tbody ausente como
`{abertos: [], fechados: 0}`, valor legítimo no modelo de dados (processo
sem expedientes). Nenhuma anomalia disparada.

Contagem do cache na hora do diagnóstico: **1 606 entradas** acumuladas
de varreduras anteriores. Distribuição da varredura envenenada:
**5/1 072 com HTML real (ca fresca), 1 067/1 072 com stub (ca cacheada)**.

### 8.4 Por que a regressão aparece agora

O cache de `ca` foi promovido de `chrome.storage.session` (volátil) para
`chrome.storage.local` (persistente) numa das mudanças recentes, com a
hipótese de que o `ca` seria estável por processo. A hipótese estava
errada: o servidor expira o `ca` **sem** sinalizar erro na resposta.
Enquanto o cache era volátil, o envenenamento não se acumulava entre
sessões; ao persistir, qualquer usuário que rodasse uma varredura na
segunda execução (horas/dias depois) lia dados corrompidos.

### 8.5 Ação

**Ação 8.1:** remover completamente o cache de `ca`. Todo worker da Fase 2
chama `gerarChaveAcesso` diretamente. Rota preservada:
`gerarCaComRetryEmRefresh` com auto-refresh em 403.

**Ação 8.2:** uma rotina one-shot `limparCacheCaLegado` remove
`STORAGE_KEYS.PRAZOS_FITA_CA_CACHE` do `chrome.storage.local` na entrada
do coordinator (idempotente; no-op se vazio). Serve apenas para drenar os
1 000+ itens residuais em instalações antigas. A chave em
`constants.ts` sobrevive marcada como **DEPRECATED** até termos certeza
de que nenhuma instalação antiga retém a entrada — pode ser removida
numa versão futura.

**Ação 8.3:** atualizar
[arquitetura-coleta-prazos-na-fita.md](arquitetura-coleta-prazos-na-fita.md)
§4.1 com o histórico da hipótese incorreta e o novo entendimento;
atualizar §2.2 (tabela de parâmetros), §5.5 (tabela-resumo) e §6
(aprendizado revisado).

### 8.6 Custo e validação

- **Custo em tempo:** `gerarChaveAcesso` é um POST REST leve,
  paralelizado em 25 streams HTTP/2 — absorve-se dentro do mesmo pool da
  Fase 2. Varreduras ficam ~20 % mais lentas no pior caso; ganho é
  correção de dados.
- **Validação:** varredura re-executada pelo usuário na mesma unidade,
  com o build corrigido. Dashboard mostra contagens de expedientes
  abertos consistentes com a regra de negócio.

### 8.7 Riscos revisitados

**Risco 5 — Caches duráveis contra backends que não sinalizam
invalidação.** Toda decisão de cache pressupõe que o backend distingue
"chave inválida" de "recurso vazio". Quando o backend responde **igual**
nos dois casos (como o `listAutosDigitais.seam` faz aqui), cache durável
**envenena** dados sem erro visível. Antes de introduzir qualquer cache
persistente novo, o checklist deve incluir:

1. Existe resposta de erro explícita para a chave expirar/ser revogada?
2. Existe endpoint barato de revalidação (mais barato que a requisição
   que usaria o cache)?

Se a resposta for "não" para alguma, **não cache** — ou cache apenas em
`storage.session` (limpa no fim da sessão) aceitando o custo de recompor
a cada reabertura do Chrome.

### 8.8 Aprendizados agregados

**8.8.1 — Regressões silenciosas de dados são a classe mais perigosa de
bug.** A cascata da Fase 1–5 (SSO Keycloak, headers, body do Angular)
terminava em dashboard vazio ou erro explícito — o usuário percebia. Já
essa regressão de 8.x apresentava um **dashboard aparentemente completo**
com números plausíveis mas errados. Sem o conhecimento da regra de
negócio ("todos os processos aqui têm expediente aberto"), o usuário
poderia ter aceitado o relatório como verdade. A mesma lição da Fase 1
(falhas silenciosas mascaram causas) vale aqui, mas o risco é pior:
o sistema **não parece** falhar — ele reporta um falso consistente.

**8.8.2 — Pergunta "o que mudou desde ontem?" é insubstituível.** Repetiu-se
o padrão da Fase 2: usuário disse *"isso antes era confiável"*. Se eu
tivesse aceitado meu primeiro palpite de que "8 faz sentido", a causa
raiz teria ficado oculta.

**8.8.3 — Sintoma no agregado exige verificação no item.** O dashboard
agregava os 1 072 sem distinguir quais vieram do stub de 32 KB vs. do
HTML real de 208 KB. Só o teste no **item** (um único processo,
comparando duas `ca`) revelou a diferença. Quando o agregado parece
errado, descer ao nível do item é o primeiro passo — não o último.
