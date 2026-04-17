# Extração de Processos do Painel do Usuário Interno (PJe TRF5)

**Projeto:** pAIdegua — Assistente IA para o PJe
**Data:** Abril/2026
**Contexto:** Funcionalidade "Analisar tarefas" do perfil Secretaria — varre múltiplas tarefas (Analisar inicial, Triagem, etc.) do painel do usuário interno do PJe TRF5, paginando até esgotar e agregando os processos em um dashboard local.

---

## 1. O problema

A Secretaria precisa de uma visão consolidada de **todos os processos pendentes** nas tarefas de triagem ("Analisar inicial", "Analisar inicial – Audiência", "Analisar inicial – Perícia", etc.) para priorizar o trabalho. O PJe TRF5 expõe cada tarefa como uma lista paginada separada — o usuário precisa entrar uma a uma, percorrer as páginas e copiar manualmente.

A funcionalidade "Analisar tarefas" automatiza isso: o content script entra em cada tarefa, lê todas as páginas, agrega os dados e abre um dashboard estático com métricas (mais antigos, faixas de tempo, agrupamento por assunto, etiquetas, prioritários, sigilosos) e opção de gerar insights por LLM (com payload anonimizado).

**Critério de sucesso:** o total mostrado no dashboard tem que **bater 100%** com o que o usuário vê manualmente em cada tarefa do PJe. Diferenças de 1 processo já são problema — significa que algum cartão foi pulado ou contado em duplicidade.

---

## 2. O ambiente: PJe TRF5 (Angular SPA em iframe cross-origin)

### 2.1 Estrutura DOM

A página de painel do PJe TRF5 é uma URL como:

```
https://pje1g.trf5.jus.br/pje/ng2/dev.seam#/painel-usuario-interno
```

O `dev.seam` é um wrapper Seam mínimo que monta um **iframe cross-origin** apontando para a aplicação Angular real:

```
https://frontend-prd.trf5.jus.br/#/painel-usuario-interno
```

O Angular usa **`HashLocationStrategy`** — toda a navegação fica no `location.hash`, a URL "real" não muda. Isso tem implicações importantes (ver §3 e §6).

A extensão precisa rodar **dentro do iframe** (`frontend-prd.trf5.jus.br`) para acessar o DOM do Angular. Isso é configurado no manifesto via `"all_frames": true` no content script. A comunicação com o top frame (que segura o origin do PJe e os cookies de sessão dos autos) é feita por `window.postMessage` — `triagem-bridge`.

### 2.2 Anatomia do painel

Quando o usuário abre `#/painel-usuario-interno`, o Angular monta dois componentes que listam as tarefas:

1. **Widget principal** — área central, mostra todas as tarefas com hrefs **completos**:
   ```
   #/painel-usuario-interno/lista-processos-tarefa/<nome-tarefa>/<filtro-base64>
   ```
   O `<filtro-base64>` é a string `eyJudW1lcm9Qcm9jZXNzbyI6IiIsImNvbXBldGVuY2lhIjoiIiwiZXRpcXVldGFzIjpbXX0=` (que decodifica para `{"numeroProcesso":"","competencia":"","etiquetas":[]}` — o "filtro vazio"). É **obrigatório** — sem ele o roteador Angular rejeita com `Cannot match any routes`.

2. **Sidebar lateral** — mostra um subconjunto das tarefas com hrefs **truncados**, sem o filtro:
   ```
   #/painel-usuario-interno/lista-processos-tarefa/<nome-tarefa>/
   ```

**Crucial:** quando o usuário entra em uma tarefa, **o widget principal é desmontado** (Angular destrói o componente). Restam apenas os links da sidebar — e eles **não funcionam** para entrar numa tarefa diferente da atual.

### 2.3 Anatomia da lista de processos

Dentro de uma tarefa, o DOM tem:

- `ul.ui-datalist-data` — a lista de cartões (PrimeNG datalist)
- `processo-datalist-card` — cada cartão é um componente Angular
- Dentro de cada cartão: número do processo (`PJEC 0000000-00.0000.4.05.0000`), assunto, polos, data de entrada, etiquetas, ícones de prioridade/sigilo, última movimentação
- Paginador PrimeNG no rodapé: `a.ui-paginator-next.ui-paginator-element` (desabilitado vira `ui-state-disabled`)

Cada cartão tem um `<span class="hidden" id="…">` com o `idTaskInstance` — usamos isso como "assinatura" do cartão para detectar substituição da lista.

---

## 3. A jornada — abordagens que falharam

A funcionalidade passou por 4 ondas de problemas. Documento cada uma porque cada uma ensinou algo.

### 3.1 Onda 1 — `location.hash` para entrar em tarefa (não funciona)

**Tentativa inicial:** capturar o `href` do link de cada tarefa e fazer `window.location.hash = href` para navegar.

**Falhou.** O motivo levou um tempo para entender:

- Os primeiros hrefs capturados eram da sidebar — **3 segmentos**, sem o filtro base64.
- O Angular Router rejeita: `Error: Cannot match any routes. URL Segment: 'painel-usuario-interno/lista-processos-tarefa/[JEF] Analisar inicial'`.
- A lista não é montada.

**Lição parcial:** o `href` de 3 segmentos é inútil para navegação programática. Precisamos do de 4 segmentos (com filtro).

### 3.2 Onda 2 — `link.click()` (funciona às vezes)

**Tentativa:** se a navegação por hash falha, deixar o handler `(click)` do Angular fazer o trabalho — ele atualiza o estado interno do componente lista mesmo quando o roteador erra a rota.

**Funcionou para a primeira tarefa.** Mas:

- Audiência (1ª): 31 processos lidos ✓
- Perícia (2ª): 668 lidos, mas com **+31 de overlap** da Audiência → total errado, 699 em vez de 668
- Analisar inicial (3ª): **0 processos**, exceção `Cannot read properties of null (reading 'entities')` no Angular

Dois bugs distintos descobertos aqui:

#### 3.2.1 Bug do overlap (UL antiga não foi substituída a tempo)

Após `link.click()`, esperávamos `ul.ui-datalist-data` aparecer. Mas o Angular **deixa a UL anterior no DOM por alguns ms** enquanto a nova é montada. Se lermos nesse instante, lemos a lista antiga.

**Tentativa de fix 1:** esperar a UL ser **diferente** (via `===` de referência). Frágil — Angular reusa a mesma referência.

**Fix definitivo (em produção):** capturar os IDs dos cartões ANTES do click (`idsAntes: Set<string>`), e esperar até que **a maioria dos cartões visíveis seja nova**:

```ts
const ulAntes = document.querySelector(SELETOR_LISTA_PROCESSOS);
const idsAntes = ulAntes ? colherIdsDosCartoes(ulAntes) : new Set();
link.click();
await waitForCondition(() => {
  const idsAgora = colherIdsDosCartoes(novoUl);
  let novos = 0;
  for (const id of idsAgora) if (!idsAntes.has(id)) novos += 1;
  return novos >= Math.max(1, Math.floor(idsAgora.size / 2));
}, TIMEOUT_DOM_MS);
```

Esse "majority new IDs" é robusto a qualquer estratégia que o framework use para reaproveitar nodes.

#### 3.2.2 Bug da terceira tarefa (widget desmontado, sidebar quebrada)

Depois de Perícia (que tem 668 processos e 3 páginas), o widget principal já tinha sido desmontado **antes mesmo da iteração 2** — provavelmente desde a navegação para Audiência. Sobrou só a sidebar.

Para a terceira tarefa, `acharMelhorLinkTarefa("Analisar inicial")` achou o link da sidebar (3 segmentos). O click chamou o handler `(click)` mas o roteador não conseguiu casar a rota e jogou `Cannot read properties of null (reading 'entities')`. A lista não foi atualizada — ficou com os 67 cartões da última página da Perícia.

**Por que a 2ª tarefa funcionou e a 3ª não?** Provavelmente sorte de timing: o componente lista da 2ª tarefa conseguiu reaproveitar o estado mesmo sem o roteador, mas em algum ponto do ciclo de vida o componente fica em um estado inconsistente. Empiricamente, **clicar em link de 3 segmentos é uma bomba relógio**.

### 3.3 Onda 3 — `voltarAoPainel()` ingênuo

Depois de cada tarefa precisamos voltar ao painel para entrar na próxima. A primeira versão era:

```ts
async function voltarAoPainel() {
  if (encontrarLinksTarefa().length > 0) return; // short-circuit
  // ... clicar em botão "voltar" ...
}
```

**O short-circuit é o erro.** A sidebar tem links de tarefa, então `encontrarLinksTarefa().length > 0` é `true` mesmo quando o widget não está montado. A função retorna sem fazer nada e a próxima `entrarNaTarefa` cai exatamente no bug 3.2.2.

**Outras tentativas falhas:**
- Adicionar fallback `history.back()` → vai longe demais, sai do painel.
- `location.hash = '#/__pai_void__'` antes do hash real para forçar `hashchange` → o "void hash" tropeça no roteador Angular e gera erro adicional.

---

## 4. A solução em produção

A solução final, em [`src/content/triagem/analisar-tarefas.ts`](../src/content/triagem/analisar-tarefas.ts), tem **três invariantes**:

### Invariante 1 — só consideramos "no painel" quando o widget está montado

```ts
function temWidgetPainel(): boolean {
  return encontrarLinksTarefa().some(
    (a) => contarSegmentos(a.getAttribute('href') ?? '') >= 4
  );
}
```

`voltarAoPainel(forced=false)` short-circuita **só se** `temWidgetPainel()` for `true`. Senão, navega de verdade.

### Invariante 2 — voltar ao painel é uma cadeia de fallbacks

```
[1] Click em botão/breadcrumb "voltar"
   ↓ se não remontar o widget em 8s
[2] history.back()
   ↓ se não remontar em 4s
[3] location.hash = painelHashInicial   (capturado no início da execução)
   ↓ se não remontar em 8s
[X] erro com dump de DOM
```

O `painelHashInicial` é uma snapshot tomada **antes de qualquer navegação**, na primeira linha de `executarAnalisarTarefas`. Não pode ser recapturado depois — a essa altura o hash já mudou.

### Invariante 3 — antes de cada tarefa, garantir o widget e clicar em link de 4 segmentos

```ts
async function entrarNaTarefa(nome: string) {
  if (!temWidgetPainel()) {
    await voltarAoPainel(true);
    await waitForCondition(() => temWidgetPainel(), TIMEOUT_VOLTA_MS);
  }
  const link = acharMelhorLinkTarefa(nome);
  if (!link || contarSegmentos(link.getAttribute('href') ?? '') < 4) {
    throw new Error('Link 4-seg não encontrado mesmo com widget montado.');
  }
  // ... captura idsAntes, link.click(), espera lista substituída ...
}
```

`acharMelhorLinkTarefa` ordena candidatos por número de segmentos descendente — sempre prefere o do widget.

### Resultado

Dashboard mostra exatamente o número que o usuário vê manualmente nas três tarefas (31 + 668 + 86 = 785). Sem overlap, sem perda.

---

## 5. Lições aprendidas — o que NÃO fazer

### 5.1 NÃO confie em "qualquer link da tarefa" no DOM

A presença de um link com o nome certo não significa que ele funciona. Sempre verifique a **quantidade de segmentos** do `href` (≥4 para navegação confiável no PJe TRF5). A sidebar é uma mentira útil para o usuário humano, mas inútil para automação.

### 5.2 NÃO use `location.hash` para entrar em tarefa

Mesmo com 4 segmentos, depende do componente lista atualizar via roteador. Em vários estados ele não atualiza — só o handler `(click)` do Angular dispara o refresh interno. **Use `link.click()`** e tenha o widget montado para garantir que o link clicável é o de 4 segmentos.

`location.hash` **funciona** apenas para voltar ao painel raiz (`#/painel-usuario-interno`) — porque essa rota não exige o "click handler internal state update".

### 5.3 NÃO espere a UL aparecer — espere ela ser **substituída**

A UL antiga fica no DOM por uns ms após a navegação. Sempre capture `idsAntes: Set<string>` e exija "majority new" antes de ler.

### 5.4 NÃO trate "navegou" como "DOM pronto"

`hashchange` dispara muito antes do componente Angular renderizar. Use `waitForCondition` com um teste sobre o DOM real (cartões presentes + maioria nova).

### 5.5 NÃO use truques de navegação artificial

`location.hash = '#/__pai_void__'` antes do hash real **gera erros adicionais no Angular** que mascaram o erro real. Setar hash igual ao atual é no-op (não dispara `hashchange`); se precisa retriggar, prefira clicar no link.

### 5.6 NÃO assuma que `voltarAoPainel` sempre tem botão "voltar"

Em alguns estados (depois de erro do roteador, depois de hot-reload da extensão, etc.) os botões/breadcrumbs somem. **Sempre tenha a cadeia de fallbacks** (botão → history.back → location.hash do painel inicial).

### 5.7 NÃO faça `voltarAoPainel` short-circuitar pela presença de "qualquer link"

A presença de links da sidebar é a armadilha clássica. Short-circuit só pelo widget completo.

### 5.8 NÃO confie em `URL` redirect-friendly para abrir os autos

`/pje/ConsultaPublica/?numeroProcesso=X` redireciona para `/pjeconsulta/...` perdendo o parâmetro. Sempre use `/pjeconsulta/ConsultaPublica/listView.seam?numeroProcesso=X` (URL canônica, sem redirect).

### 5.9 NÃO tente passar dados sensíveis pela URL

O dashboard recebe o payload via `chrome.storage.session`, não query string. Mantém URL limpa, suporta F5 (recarrega lê do storage), e não vaza dados pelo histórico.

---

## 6. Heurísticas e padrões reusáveis

### 6.1 Detecção de "lista substituída" via majority-new IDs

Aplicável a qualquer SPA com listas paginadas:

```ts
const idsAntes = new Set(getCardIds());
triggerNavigation();
await waitFor(() => {
  const ids = getCardIds();
  let novos = 0;
  for (const id of ids) if (!idsAntes.has(id)) novos += 1;
  return novos >= Math.max(1, Math.floor(ids.size / 2));
});
```

Robusto contra: reuso de DOM nodes, flicker entre estados, listas que crescem ou diminuem entre páginas.

### 6.2 Detecção de fim de paginação

PrimeNG usa `ui-state-disabled` no botão "next" quando estamos na última página. Mas há corner cases:

- Botão **inexistente** (lista cabe em uma página) → `null`
- Botão presente mas **clicar não muda nada** → time out curto (5s) para detectar fim normal sem esperar 12s

```ts
if (!btnNext || btnNext.classList.contains('ui-state-disabled')) {
  return { motivo: 'paginador inexistente ou desabilitado' };
}
```

### 6.3 Cadeia de fallbacks para navegação SPA

Sempre estruture tentativas em camadas com curto-circuito + dump diagnóstico no fim:

```
[selector preferido]
  ↓ falhou
[selector alternativo]
  ↓ falhou
[primitiva do navegador (history.back, location.hash)]
  ↓ falhou
[dump diagnóstico + erro descritivo]
```

Não tente uma única estratégia "que sempre funciona" — não existe em SPAs reais.

### 6.4 Anonimização em duas camadas

O dashboard local (na máquina do usuário) preserva PII para facilitar trabalho. **Apenas o payload enviado ao LLM** é anonimizado. A função `sanitizePayloadForLLM` é idempotente, não muta o payload original, e tem validador correspondente no background (`detectPiiInAnonPayload`) que lança se algo PII vazar — defesa em profundidade.

CNJ é informação pública (Resolução CNJ 121/2010) — **mantemos no claro** para que a LLM possa referenciar processos concretos nas sugestões. O que sai ofuscado: nome de pessoas físicas, CPF/CNPJ/CEP/email/telefone, números CNJ de OUTROS processos citados na movimentação.

### 6.5 Diagnóstico de cartões descartados

Quando o parser de cartão devolve `null`, dumpar o `outerHTML` dos primeiros 2-3 cartões problemáticos no console. Isso ajuda a identificar variações de estrutura (cartão sigiloso, cartão sem polo, etc.) sem precisar de DevTools manual em cada caso.

---

## 7. Ganhos

- **100% de fidelidade** entre o número que aparece no dashboard e o que o usuário vê manualmente — nas 3 tarefas testadas, sem perda nem duplicidade.
- **Tempo de triagem reduzido** — em vez de abrir cada tarefa, paginar manualmente e anotar, a Secretaria vê o consolidado em ~30s para ~800 processos (medido em produção).
- **Insights por LLM com referência precisa** — preservar CNJ no payload anonimizado deixa as sugestões da IA acionáveis ("priorize 0001234-56.2026.4.05.8109 porque está há 67 dias parado") em vez de genéricas.
- **Privacidade preservada** — a regra "PII só sai da máquina via LLM, e ofuscada" é aplicada nas duas pontas (front sanitiza, background valida).
- **Diagnóstico de coleta sempre visível no dashboard** — usuária consegue auditar se algum cartão deu errado sem precisar abrir DevTools.

---

## 8. Oportunidades / próximos passos

### 8.1 Generalizar para outras instâncias do PJe

A solução foi calibrada no TRF5 (`pje1g.trf5.jus.br` + `frontend-prd.trf5.jus.br`). Outras instâncias (TRF1-4, JFCE 2º grau) podem ter:
- Estrutura de iframe diferente ou ausente
- Nomes de tarefas distintos (regex `(analisar inicial|triagem)` pode não cobrir)
- Versão do Angular/PrimeNG diferente, com seletores ligeiramente diferentes

Vale generalizar `pje-host.ts` para detecção mais robusta de variantes e adicionar testes contra cada uma.

### 8.2 Lista de tarefas configurável pelo usuário

Hoje o regex `TAREFA_REGEX = /(analisar\s+inicial|triagem)/i` é hard-coded. Cada vara pode ter nomes próprios ("Petição inicial", "Despacho saneador", "Análise CGJ", etc.). Configuração no popup permitiria adoção por outras unidades.

### 8.3 Detecção de scroll infinito

Algumas instâncias do PJe usam scroll infinito em vez de paginador. Já existe estrutura para isso (`MAX_SCROLLS_INFINITOS`, `SCROLL_WAIT_MS`), mas o caminho ainda não foi exercitado em produção. Vale validar quando houver caso real.

### 8.4 Cache do payload entre execuções

A execução leva ~30s para ~800 processos. Se o usuário fechar o dashboard por engano, hoje precisa rodar tudo de novo. Poderíamos manter o último payload em `chrome.storage.local` (com timestamp e expiração de 30min) e oferecer "reabrir último relatório".

### 8.5 Comparação entre execuções

Com cache histórico, dá para mostrar "novos processos desde a última triagem", "tempo médio de fila aumentou X% na semana", etc. Útil para indicadores gerenciais da vara.

### 8.6 Retry resiliente por cartão

Hoje, se um cartão dá erro de parsing, ele é descartado silenciosamente (com log). Em produção real seria útil capturar a HTML bruta dos descartados em um campo separado do payload, exibir contagem no diagnóstico e permitir o usuário denunciar para gerar issue.

### 8.7 Sinalização visual no PJe quando o cache está fresco

Quando há um relatório recente em cache, exibir um badge no botão "Analisar tarefas" (ex.: "↻ atualizado há 5min"). Estimula uso e dá pista do estado.

### 8.8 Robustez a Extension Context Invalidated

Quando o usuário recarrega a extensão durante a execução, o `chrome.runtime.sendMessage` final que abre o dashboard falha com `Extension context invalidated`. O usuário perde os dados coletados. Possível mitigação:
- Detectar o erro e exibir mensagem específica ("recarregue a página do PJe e rode de novo")
- Persistir o payload em `chrome.storage.local` ANTES de chamar o background, e oferecer "recuperar relatório" no popup

---

## 9. Referências internas

- Código principal: [`src/content/triagem/analisar-tarefas.ts`](../src/content/triagem/analisar-tarefas.ts)
- Anonimização: [`src/shared/triagem-anonymize.ts`](../src/shared/triagem-anonymize.ts)
- Dashboard: [`src/dashboard/dashboard.ts`](../src/dashboard/dashboard.ts), [`src/dashboard/dashboard.css`](../src/dashboard/dashboard.css)
- Bridge iframe ↔ top: [`src/content/content.ts`](../src/content/content.ts) (busca por `triagem-bridge`)
- Documento irmão sobre extração da árvore de documentos: [`extracao-conteudo-pje.md`](./extracao-conteudo-pje.md)
