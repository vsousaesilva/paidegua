# Arquitetura da coleta "Prazos na Fita" — jornada, comparações e aprendizados

**Projeto:** pAIdegua — Assistente IA para o PJe
**Perfil:** Gestão → *Prazos na Fita pAIdegua*
**Última revisão:** 20/04/2026 (remoção do cache de `ca` envenenado)
**Documento companheiro:** `docs/post-mortem-prazos-na-fita.md` — bugs
pontuais, a regressão de 18/04/2026 (SSO Keycloak) e a regressão de
20/04/2026 (cache de `ca` envenenado). Este aqui descreve a *arquitetura*:
por que chegamos à configuração atual, quais caminhos foram descartados,
e como ela se compara com os outros relatórios da extensão.

---

## 1. O que torna "Prazos na Fita" estruturalmente diferente

Todos os relatórios da extensão pAIdegua agregam dados do PJe, mas só *um*
deles trabalha na granularidade "um round-trip por processo". Esta é a
diferença que governa todas as decisões arquiteturais descritas neste
documento:

| Relatório                     | Granularidade | Complexidade |
|-------------------------------|---------------|--------------|
| Painel Gerencial (Gestão)     | por tarefa    | O(tarefas)   |
| Analisar tarefas (Secretaria) | por tarefa    | O(tarefas)   |
| Etiquetas Inteligentes        | por página    | O(páginas de catálogo) |
| Triagem Inteligente           | por processo único (o aberto) | O(1) |
| **Prazos na Fita**            | **por processo**  | **O(processos)** |

Uma vara com 15 tarefas tem ~15 requisições para o Painel Gerencial.
A mesma vara com 10 000 processos em "Controle de prazo" precisa de até
20 000 requisições para "Prazos na Fita" (uma para resolver a chave de
acesso, outra para carregar a aba Expedientes). Essa assimetria de ordem de
grandeza é o pano de fundo de tudo que se segue.

---

## 2. Estado atual da coleta

### 2.1 Pipeline resumido

```
┌────────────────────────────────────────────────────────────────────┐
│  Painel (aba intermediária) — seleção + filtros + retomada         │
└──────────────────────┬─────────────────────────────────────────────┘
                       │ requestId + nomes + filtros + retomar?
                       ▼
┌────────────────────────────────────────────────────────────────────┐
│  Background (service worker) — roteamento painel ↔ PJe             │
└──────────────────────┬─────────────────────────────────────────────┘
                       │ PRAZOS_FITA_RUN_COLETA
                       ▼
┌────────────────────────────────────────────────────────────────────┐
│  Content script (aba do PJe) — coletarPrazosPorTarefasViaAPI       │
│                                                                    │
│   Fase 1: listar processos (uma tarefa por vez)                    │
│     POST /pje-comum-api/api/paineis/.../recuperarProcessos...      │
│                                                                    │
│   ↓ dedup por idProcesso, filtro por dias, corte no teto           │
│                                                                    │
│   Fase 2: pool concorrente (25 workers):                           │
│     a) ca = await gerarChaveAcesso(id)   [sempre fresca]           │
│     b) fetch(listAutosDigitais.seam?ca=...&aba=expedienteTab)      │
│     c) DOMParser → extractExpedientes(html)                        │
│     d) checkpoint a cada 100 concluídos                            │
└────────────────────────────────────────────────────────────────────┘
```

### 2.2 Configurações-chave

| Parâmetro                  | Valor     | Motivação                          |
|----------------------------|-----------|------------------------------------|
| Concorrência default       | 25        | HTTP/2 multiplex ~ 100 streams/TCP |
| Concorrência máxima (clamp)| 30        | Margem antes de rate-limit visível |
| Intervalo de checkpoint    | 100 proc. | Overhead ~0.1%, perda máx. ~20 s   |
| TTL do checkpoint          | 24 h      | Evita lixo se o usuário abandonar  |
| Timeout de refresh 403     | 60 s      | Cobre renovação Keycloak em bg     |
| Cache de `ca`              | **removido** (Abril/2026) | Ver §4.1 — expiração silenciosa no servidor |
| Teto default do seletor    | 2 000     | Varredura em ~4–8 min              |

---

## 3. Jornada — tentativas abandonadas e por quê

As decisões acima não surgiram prontas. Cada uma substituiu uma tentativa
anterior que falhou por um motivo específico. Documentar o *porquê da
rejeição* é o que evita que a mesma ideia volte travestida de "otimização".

### 3.1 v0 — Aba por processo (descartado)

**O que era:** para cada processo, o background abria uma aba inativa com
a URL dos autos digitais e disparava o content script da aba nova, que
extraía os expedientes via adapter DOM. Conceitualmente idêntico ao fluxo
"Analisar tarefas" do perfil Secretaria, mas escalado para o número de
processos.

**Por que caiu:**

1. Cada `chrome.tabs.create` custa ~1–3 s de overhead do Chrome mesmo
   antes do Angular bootar. Para 2 000 processos, isso por si só já é
   40 minutos de *puro overhead de Chrome*.
2. O Chrome estrangula abas inativas para economizar CPU, o que estende
   ainda mais o boot do Angular.
3. O sidebar do PJe ficava empilhado com indicações de "aba aberta",
   confundindo o usuário.
4. `chrome.tabs.remove` após cada extração é assíncrono e deixava abas
   fantasma em cenários de falha.

**Resíduo arquitetural:** o canal `PRAZOS_FITA_COLETAR_PROCESSO` continua
no `constants.ts` por compatibilidade e por ser genuinamente útil em
cenários *ad-hoc* de 1 processo — não foi removido quando migramos o
pipeline de varredura em lote.

**Lição:** `chrome.tabs.create` não é um HTTP GET disfarçado. O custo de
bootstrap é duas ordens de grandeza maior.

### 3.2 v1 — Iframe oculto por processo (descartado)

**O que era:** substituir a aba por um `<iframe>` oculto na própria aba
do PJe, apontando para `listAutosDigitais.seam`. A ideia era pular o
custo de criar aba e manter tudo no mesmo processo.

**Por que caiu:**

1. O PJe legacy carrega toda a infraestrutura JSF/RichFaces em cada
   request — mesmo num iframe, cada carga puxa ~300 KB de JS/CSS.
2. O clique sintético na aba "Expedientes" era flaky: dependia de
   escolhas internas do RichFaces sobre quando re-renderizar o DOM.
3. A aba "Expedientes" era montada apenas via postback A4J (AJAX JSF)
   após o clique — ou seja, mesmo no iframe precisávamos sintetizar o
   clique e esperar o round-trip.
4. Memória: 2 000 iframes em sequência causavam pressão sobre o GC e,
   eventualmente, o Chrome reclamava.

**Resíduo arquitetural:** `prazos-fita-iframe-collector.ts` chegou a
existir no repositório e foi *deletado* junto com a migração para fetch
(aparece como *deleted* no `git status`).

**Lição:** iframe é abstração para *documento inteiro*. Se o que
queremos é uma string HTML, é mais barato pedir a string.

### 3.3 v2 — REST para expedientes (investigado, inexistente no TRF5)

**O que era:** investigar se existe um endpoint REST no PJe 2.0 Angular
que devolva os expedientes de um processo em JSON.

**Como foi verificado:** usuário capturou requisições via DevTools em
dois fluxos distintos (clique na aba Expedientes; reload do processo com
a aba já montada). Ambas as capturas mostraram **POST para
`listAutosDigitais.seam` com formulário A4J** (parâmetros
`AJAXREQUEST`, `javax.faces.ViewState`, `ajaxSingle` etc.) — não há
endpoint REST para esta informação no PJe TRF5.

**Consequência:** qualquer tentativa de "modernizar" a coleta de
expedientes para REST está condenada enquanto o PJe não evoluir o
backend. A camada Angular do PJe 2.0 é, para efeitos desta coleta,
apenas um cliente de uma aplicação Seam/JSF de 2014.

**Lição:** no TRF5 o PJe é *híbrido*: frontend Angular moderno,
backend Seam/JSF legacy. REST existe para *subconjuntos* de
funcionalidades (painel, etiquetas, chave de acesso) — não presumir
cobertura total.

### 3.4 v3 — Fetch do SSR (estado atual)

**O que é:** a URL `listAutosDigitais.seam?aba=processoExpedienteTab`
força o servidor a já renderizar a aba Expedientes no HTML inicial
(SSR), eliminando o postback A4J. Basta um `fetch` GET com os cookies
da sessão + headers `X-pje-*` capturados pelo interceptor, e obtemos
um HTML completo que o `DOMParser` digere no próprio content script.

**Por que foi a opção vencedora:**

1. Sem `chrome.tabs.create` → sem overhead de boot.
2. Sem iframe → sem duplicação de JS/CSS por requisição.
3. Mesma origem que a aba do PJe → os cookies de sessão acompanham o
   fetch naturalmente; os headers `X-pje-*` entram pelo interceptor.
4. HTTP/2 do PJe TRF5 aceita dezenas de streams sobre *uma* conexão
   TCP — concorrência 25 não abre 25 conexões, abre 25 streams.
5. `DOMParser` no content script isolated world é barato: ~5–15 ms
   por documento, contra ~500–1 000 ms de boot Angular.

**Lição:** quando o servidor consegue renderizar o que você precisa,
pedir via `fetch` é quase sempre barato demais para não fazer.

---

## 4. Sofisticações empilhadas depois do v3

A migração para fetch resolveu o gargalo de latência. Mas expôs uma
segunda classe de problemas — os que só aparecem quando a coleta é *rápida
o suficiente para ser longa*.

### 4.1 Cache persistente de `ca` — **removido (Abril/2026)**

**Hipótese original (incorreta):** o `ca` (`chaveAcessoProcesso`) seria
estável enquanto o processo existisse no servidor. Com base nisso, o
cache foi movido de `chrome.storage.session` (volátil) para
`chrome.storage.local` (persistente entre sessões), pulando a chamada
`gerarChaveAcesso` em ~99% dos processos após a primeira varredura.

**O que realmente acontece:** o `ca` expira no servidor **sem devolver
erro**. Em vez de responder 4xx à requisição `listAutosDigitais.seam`,
o PJe devolve **HTTP 200 com um stub HTML de ~32 KB** em que o `tbody`
da tabela de expedientes simplesmente não existe. O extrator
`extractExpedientesFromDoc` trata `tbody` ausente como "processo sem
expedientes" (`{abertos: [], fechados: 0}`) — um valor legítimo no
modelo de dados.

**Cadeia de envenenamento observada:**

1. Primeira varredura: todas as 1 072 `ca` geradas frescas, tudo bem.
2. Segunda varredura (horas depois): 1 067 `ca` vêm do cache, 5 novas.
3. As 1 067 `ca` cacheadas já não valem no servidor → todas devolvem
   o stub de 32 KB em vez do HTML de ~208 KB.
4. Relatório mostra **8 expedientes abertos em 1 072 processos** (em
   "Controle de prazo"!), quando a regra de negócio exige o oposto.

**Como foi diagnosticado:** teste comparativo na console — mesmo id,
duas `ca` (cacheada + recém-gerada) → a cacheada retorna 32 KB sem
tbody; a fresca retorna 208 KB com 16 linhas de expediente.

**Por que o cache não pôde ser "revalidado":** revalidar o `ca` custaria
a mesma requisição que usa o `ca` — ou seja, a revalidação *é* o próprio
fetch dos autos. Não há endpoint de validação barato. O cache passou a
custar mais do que economizava.

**Correção:** `ca` agora é gerada fresca em cada varredura. Limpeza
one-shot do cache residual em `limparCacheCaLegado` na entrada do
coordinator (idempotente; no-op quando vazio). A chave
`STORAGE_KEYS.PRAZOS_FITA_CA_CACHE` sobrevive em `constants.ts`
**apenas** como alvo dessa limpeza; pode ser removida numa versão
futura quando nenhuma instalação antiga conservar a chave.

**Custo real da remoção:** ~300 ms adicionais por processo
(`gerarChaveAcesso` é um POST REST barato, paralelizado em 25 streams
HTTP/2 — absorvido dentro do mesmo pool). Varreduras ficam ~20 %
mais lentas no pior caso; ganho é correção de dados.

**Lição (revisada):** "token estável por processo" só é verdade quando
o servidor *confirma* isso por resposta de erro. Cache persistente
contra um backend que não distingue `ca` expirada de `ca` válida
produz **resultado silenciosamente errado** — classe de bug
especialmente perigosa porque o sistema continua "operando".
Entre otimização e correção, escolher correção e medir o custo
depois.

### 4.2 Auto-refresh em 403

**O problema original:** um 403 de Keycloak no meio da varredura
cancelava *toda* a operação e mandava o usuário "clicar numa tarefa no
PJe para renovar". Em unidades grandes, isso significava perder 10+
minutos de trabalho acumulado.

**Solução atual:**

1. Worker detecta 403 em `gerarChaveAcesso`.
2. Lê `capturadoEm` do snapshot atual do interceptor.
3. Registra um listener em `chrome.storage.onChanged` que dispara
   quando o Angular renova o snapshot em background.
4. Repete a chamada. Sucesso → retoma. Timeout 60 s → aborta, mas o
   checkpoint fica preservado para retomada futura.

**Não é polling.** O listener de `chrome.storage.onChanged` acorda *todos
os workers simultaneamente* no momento em que o token é renovado, sem N
timers concorrentes.

**Lição:** pouca coisa é tão cara quanto abortar uma operação longa por
uma falha transitória conhecida. Quando o estado é recuperável, *espere*.

### 4.3 Filtros e teto (Stage 1)

Em unidades com 10 000–20 000 processos em "Controle de prazo", mesmo
com concorrência 25 a varredura levaria 15–25 min. Pior: nem todos os
processos têm *prazo real vencendo* — muitos estão na tarefa há 30, 60,
90 dias sem movimento.

**Solução:** antes da Fase 2, aplicar duas podas:

- **"N dias na tarefa"** — filtra pelo `dataChegadaTarefa` da API.
  Ex.: em "Controle de prazo - INSS" (15 dias típicos), configurar 10
  deixa só os críticos.
- **Teto total** — após dedup e filtro, ordena *ascendente por data de
  chegada* (mais antigos primeiro) e corta no teto. Garante que o teto
  nunca exclui os processos *mais* críticos.

**Lição:** filtro sem ordenação pode jogar fora o que importa.
Ordenação antes do corte é barata e muda quem fica de fora.

### 4.4 Varredura retomável (Stage 2)

**O problema residual:** mesmo com filtro + teto, um usuário pode
precisar fechar o Chrome no meio de uma varredura de 2 000 processos
(meeting, fim de expediente, queda de rede). Perder 40% do trabalho é
tão frustrante quanto abortar por 403.

**Solução:** checkpoints em `chrome.storage.local`, indexados por
`scanId` = SHA-256(host + nomes ordenados + filtros). Assinatura
determinística → relançar a mesma seleção reconhece o checkpoint
anterior.

- Checkpoint salvo **antes** da Fase 2 começar (preserva `unicos` se
  o crash for imediato).
- Checkpoint atualizado a cada 100 processos concluídos
  (fire-and-forget; não bloqueia workers).
- Checkpoint **preservado** ao abortar por 403 persistente.
- Checkpoint **apagado** apenas no sucesso total.
- GC oportunista: entradas com mais de 24 h são apagadas na próxima
  consulta.

No painel, o clique em "Iniciar varredura" consulta via
`PRAZOS_FITA_QUERY_SCAN_STATE`; se houver checkpoint, oferece
"Continuar X/Y · Começar do zero".

**Lição:** assinatura determinística resolve o problema de identidade
(qual seleção é "a mesma"?) sem precisar de fluxo de UI adicional. O
usuário simplesmente *relança a mesma coisa* e reconhecemos.

---

## 5. Comparação com os outros relatórios

A comparação a seguir destaca *por que* as escolhas para "Prazos na
Fita" são diferentes — e não imitáveis a partir dos outros.

### 5.1 Painel Gerencial (perfil Gestão)

- **Caminho de dados:** DOM scraping via `gestao-bridge` (postMessage
  entre isolated world ↔ page world) lendo o estado já montado do
  Angular do painel.
- **Granularidade:** O(tarefas). Uma varredura típica é 10–30 tarefas.
- **Durabilidade:** a varredura inteira cabe em ~10 s. Não há espaço
  para 403 (token não vence) nem necessidade de checkpoint.
- **Por que a abordagem não serve para prazos:** a aba Expedientes não
  é carregada pelo painel Angular. Teríamos que abrir cada processo
  só para ter acesso à aba — ou seja, cairíamos de volta no v0/v1.

### 5.2 Analisar tarefas (perfil Secretaria)

- **Caminho de dados:** DOM scraping dentro do iframe Angular do
  painel, com postMessage para o top frame.
- **Granularidade:** O(tarefas × páginas). Cada tarefa tem paginação
  (50/100 processos por página), mas o total por tarefa é da ordem de
  centenas, não milhares.
- **Durabilidade:** ~30 s para 5–7 tarefas de triagem. Confortável sem
  checkpoints.
- **Por que a abordagem não serve para prazos:** "Analisar tarefas"
  devolve *metadados*. Para expedientes, precisaríamos abrir cada
  processo — v0 de novo.

### 5.3 Etiquetas Inteligentes

- **Caminho de dados:** REST via `listarEtiquetas` (endpoint REST
  do painel, parte do subconjunto que o PJe TRF5 *sim* expõe).
- **Granularidade:** O(páginas de catálogo). O catálogo inteiro raramente
  passa de 2 000 etiquetas — duas dezenas de requisições.
- **Durabilidade:** ~5–10 s. Sem checkpoints.
- **Paralelismo com prazos:** aqui sim temos REST real, porque a
  etiqueta é um recurso de primeira classe da API. Expediente não é.

### 5.4 Triagem Inteligente

- **Caminho de dados:** DOM da aba já aberta pelo usuário. Nenhuma
  chamada ao PJe — só lê o que já está na tela.
- **Granularidade:** O(1) — um processo por vez, por construção.
- **Não compara diretamente** com Prazos na Fita, mas fecha o espectro:
  o único relatório sem round-trip nenhum.

### 5.5 Tabela-resumo

| Relatório            | Transporte         | Checkpoint? | Refresh 403? | Cache durável? |
|----------------------|--------------------|-------------|--------------|----------------|
| Painel Gerencial     | DOM scrape (bridge)| não         | n/a          | n/a            |
| Analisar tarefas     | DOM scrape (iframe)| não         | n/a          | n/a            |
| Etiquetas            | REST               | não         | n/a          | IndexedDB (catálogo) |
| Triagem              | DOM da aba ativa   | não         | n/a          | n/a            |
| **Prazos na Fita**   | **REST + SSR fetch**| **sim**     | **sim**      | **não** (ver §4.1) |

Toda a complexidade extra está concentrada na última linha, e ela vem
*inteiramente* da assimetria descrita na §1.

---

## 6. Aprendizados consolidados

1. **Granularidade determina arquitetura.** Antes de decidir
   transporte, cache ou checkpoint, calcule o *pior caso de
   round-trips*. Abaixo de ~500, quase qualquer abordagem serve. Acima
   de ~2 000, todas as decisões ficam subordinadas a esse eixo.

2. **HTTP/2 multiplexa; aba não.** Concorrência alta em fetch same-
   origin é barata (25 streams, 1 TCP). Concorrência alta em
   `chrome.tabs.create` é literalmente abrir 25 abas. Não são
   equivalentes.

3. **SSR + `?aba=` > postback A4J + iframe.** Quando o servidor
   legacy aceita render parcial via query string, é quase sempre a
   rota mais barata. Vale procurar essas chaves (`aba=`, `tab=`,
   `view=`) antes de sintetizar cliques.

4. **Cache durável exige erro explícito de invalidação.** Só faz
   sentido cachear contra um backend que distingue "chave inválida"
   de "recurso vazio". O PJe TRF5 responde HTTP 200 + stub para `ca`
   expirada, igualando os dois cenários — cache persistente vira
   envenenamento silencioso (§4.1). Regra prática: sem rota barata de
   revalidação, não cache.

5. **Interceptor page-world é a única forma honesta de reaproveitar
   auth do Angular.** Qualquer tentativa de "chutar" headers quebra
   em alguma evolução do PJe. O interceptor se adapta ao que o
   Angular estiver mandando, seja Bearer, Basic dummy, ou
   `X-pje-cookies`.

6. **`storage.onChanged` > polling.** Para acordar workers ao redor
   de um evento raro (token renovado), o listener reativo é mais
   barato e mais correto que N timers concorrentes.

7. **Dedup → filtro → ordenação → corte.** Essa ordem não é arbitrária:
   dedup primeiro para não filtrar duas vezes; filtro antes de
   ordenar para não pagar a ordenação em coisas que vão sair; corte
   por último para nunca excluir o que importa.

8. **Idempotência por assinatura determinística.** O `scanId` via
   SHA-256 de (host, nomes, filtros) resolve "é a mesma varredura?"
   sem fluxo de UI. O usuário relança; o sistema reconhece.

9. **Fire-and-forget para writes não críticos.** Checkpoints a cada
   100 processos não podem bloquear o pool. Se um write falhar, o
   próximo absorve a perda.

10. **Abortar em falha transitória conhecida é maltratar o usuário.**
    Quando o estado é recuperável (403 + token vai renovar), *espere*
    em vez de cancelar 10 min de trabalho.

---

## 7. Oportunidades identificadas

Registradas para não perder, sem compromisso de implementação.

### 7.1 Checkpoint incremental por `ultimoMovimento`

Hoje o checkpoint persiste o resultado bruto. Uma segunda varredura
da mesma tarefa, dias depois, refaz 100% dos processos. Se guardássemos
`ultimoMovimento` por processo, poderíamos pular processos sem
movimento novo desde a última coleta — conversaria muito bem com o
caso de uso "rodar o relatório toda segunda-feira".

**Custo:** baixo — um índice `idProcesso → lastUltimoMovimento` em
`storage.local` ou IndexedDB. Pior caso: `ultimoMovimento` vem `null`
e perdemos a otimização para aquele processo.

### 7.2 IndexedDB para estados grandes

`chrome.storage.local` tem quota de 10 MB. Para o teto default de 2 000
processos, ficamos confortavelmente abaixo; para "Sem limite" em 10 000+
processos, o checkpoint pode estourar. IndexedDB não tem essa quota
prática e já é usado para o catálogo de etiquetas (`shared/gestao-
indexed-storage.ts`).

**Custo:** médio — migrar o helper `prazos-fita-scan-state.ts` para
IndexedDB exige serialização cuidadosa mas é trabalho localizado.

### 7.3 Adaptive concurrency

Hoje a concorrência é fixa em 25 (clamp 1–30). Um loop simples
—medir latência das últimas N respostas e subir/descer a concorrência
em 5— permitiria extrair mais em horários de folga do servidor e
recuar em horário de pico sem configuração manual do usuário.

**Custo:** médio — é simples implementar; mais trabalhoso é *medir
direito* em campo antes de tornar default.

### 7.4 Pré-aquecimento de `ca` (sem cache durável)

Após a remoção do cache persistente (§4.1), toda varredura paga
`gerarChaveAcesso` em 100 % dos processos. Se a listagem da Fase 1
disparasse um pool de `gerarChaveAcesso` em paralelo, os tokens
ficariam disponíveis **em memória** (dicionário local à varredura
corrente) no momento em que a Fase 2 começar — sobrepondo o custo de
auth com o de listagem e ganhando ~30 s de varredura inicial.

**Por que não é o antigo cache disfarçado:** o dicionário existiria
apenas dentro do escopo de uma única varredura (nasce em
`coletarPrazosPorTarefasViaAPI`, morre com ela). Uma varredura =
uma geração de `ca` por processo. Não há reaproveitamento entre
execuções — a fonte do envenenamento.

**Custo:** baixo — segundo pool de workers durante a Fase 1,
resultados escritos num `Map<idProcesso, string>` local. Atenção
principal: evitar 403 em rajada — o pool de pré-aquecimento precisa
respeitar o mesmo `gerarCaComRetryEmRefresh` usado na Fase 2.

### 7.5 Coleta agendada via `chrome.alarms`

Varreduras recorrentes (ex.: toda segunda às 8 h) poderiam rodar em
background via `chrome.alarms` + service worker. Combinado com 7.1
(incremental), viraria um "crontab de relatórios".

**Custo:** alto — mudar o pipeline de "usuário-iniciado na aba PJe
aberta" para "service-worker-iniciado, abre aba se necessário"
implica reescrever o contrato de auth (interceptor depende da aba
estar aberta).

### 7.6 Compressão do checkpoint

Um processo coletado tem ~1.5 KB. Para 5 000 processos, 7.5 MB. Há
campos repetitivos (URLs, órgão julgador) que compactam bem com
dicionário. `pako` (LZ4/deflate em JS) resolveria. Útil se decidirmos
não migrar para IndexedDB (oportunidade 7.2).

**Custo:** baixo — uma camada de encode/decode no helper. Principal
risco é latência extra por checkpoint (medir antes).

---

## 8. Fontes e referências cruzadas

- `docs/post-mortem-prazos-na-fita.md` — detalhes das regressões:
  18/04/2026 (SSO Keycloak, fallback Basic dummy, cascata de 5 bugs);
  20/04/2026 (cache de `ca` envenenado, "8 expedientes em 1 072
  processos").
- `docs/extracao-tarefas-painel-pje.md` — arquitetura DOM do painel
  Angular usada pelos relatórios O(tarefas).
- `docs/extracao-conteudo-pje.md` — adapter PJe legacy e acesso ao
  DOM dos autos (útil para comparar com a abordagem de fetch).
- `docs/modo-rapido-rest-flag.md` — investigação que confirmou que
  não existe REST para Expedientes no TRF5.
- `src/content/gestao/prazos-fita-coordinator.ts` — implementação
  atual do pipeline.
- `src/content/gestao/prazos-fita-scan-state.ts` — helpers de
  checkpoint.
- `src/content/pje-api/pje-api-from-content.ts` — `aguardarNovoSnapshot`
  e cliente REST usados na Fase 1 + Fase 2.
