# Manual de massificação do pAIdegua para usuários do PJe nacional

**Projeto:** pAIdegua — Assistente IA para o PJe
**Versão da extensão na data de redação:** 1.2.1
**Última revisão:** 03/05/2026
**Autoria:** Inovajus / JFCE
**Status:** Documento normativo de arquitetura. Plano de execução com prazos a serem definidos pelo time de desenvolvimento.

Documentos companheiros:
- [`controle-metas-cnj.md`](./controle-metas-cnj.md) — pipeline e camadas do módulo Metas CNJ
- [`arquitetura-coleta-prazos-na-fita.md`](./arquitetura-coleta-prazos-na-fita.md) — pool concorrente e checkpoint
- [`extracao-tarefas-painel-pje.md`](./extracao-tarefas-painel-pje.md) — REST do painel e dedup
- [`extracao-conteudo-pje.md`](./extracao-conteudo-pje.md) — DOM scraping de documentos, OCR
- [`post-mortem-prazos-na-fita.md`](./post-mortem-prazos-na-fita.md) — incidentes de 18 e 20 de abril de 2026
- [`telemetria-local-e-escala.md`](./telemetria-local-e-escala.md) — política de telemetria
- [`index.md`](./index.md) — política de privacidade

---

## 0. Como ler este manual

Este documento foi consolidado a partir de duas análises produzidas em sequência:

1. **Parte I — Parecer técnico** sobre a resposta HTTP do endpoint `listAutosDigitais.seam`, identificando o que o PJe entrega num único hit e que hoje é subutilizado pela extensão.
2. **Parte II — Plano de otimização** que prescreve, com base no parecer, alterações executáveis no código atual, considerando auditoria sênior independente, LGPD, institucionalização nacional e riscos de refatoração.

A Parte III consolida o roadmap, os anti-padrões e a checklist de aceitação. Cada recomendação está atrelada ao arquivo concreto a alterar; os caminhos são clicáveis.

---

# Parte I — Parecer técnico sobre `listAutosDigitais.seam`

## I.1. Caracterização da resposta

A requisição inspecionada é uma submissão JSF/RichFaces (Seam) ao endpoint canônico de detalhe dos autos. O servidor devolveu **um único HTML monolítico (~200 KB)** contendo, sem qualquer chamada secundária, a totalidade dos dados estruturados do processo:

| Bloco | Localização no DOM | Já consumido pelo paidegua? |
|---|---|---|
| Cabeçalho com nº CNJ, classe, polos, valor da causa, jurisdição, prioridade, OAB, CPF/CNPJ | `.navbar .dropdown-menu` do `mais-detalhes` | parcial (partes via [pje-api-partes.ts](../src/content/pje-api/pje-api-partes.ts)) |
| Órgão julgador, cargo judicial, competência | `dl.dl-horizontal` | sim |
| Etiquetas ativas e badge de contagem | `nav-Etiquetas .dropdown-menu` (`navbar:iconeNovaEtiquetaBadge`) | parcial |
| Situação atual + data de início (ex.: `Andamento desde 18 fev 2026`) | `menu-alertas .dropdown-menu` | **não** |
| Combo "Tipo de documento" com todos os tipos presentes nos autos e seus IDs internos do PJe | `select#navbar:cbTipoDocumento` | **não** |
| Cronologia completa (movimentos + documentos + anexos hierárquicos) — `totalPaginas=1` no caso típico | `#divTimeLine:eventosTimeLineElement` | sim, parcial |
| Origem do evento (Polo Ativo / Passivo / Interno / Sistema) | `span.icon-auto` com classes `PA`, `PP`, `I`, `sistema` | parcial |
| Tipo do item (documento × movimento) | `div.media.interno.tipo-D` ou `tipo-M` | sim |
| Texto literal do movimento CNJ | `span.text-upper.texto-movimento` | sim |
| `idProcessoDocumento` + label canônico do PJe | links da timeline | sim |
| `idProcessoTrf` (distinto de `idProcesso`) | `popupRetificarAutuacao()`, `lembretes.seam?idProcessoTrf=` | sim |
| Assinaturas digitais completas do documento ativo (CN, emissor, OU, data) | `dropdown-assinaturas dl.dl-vertical` | **não** |
| URL REST direta para HTML do documento: `/pje/seam/resource/rest/pje-legacy/documento/download/{idProcessoDocumento}` | `iframe#frameHtml[src]` | sim |
| URL assinada (`ca=…&idProcessoDoc=…&idBin=…`) para download visual | `detalheDocumento:j_id429` | sim |
| URL de **certidão PDF** com `idBin` já resolvido | `detalheDocumento:j_id448` (`reportCertidaoPDF.seam?idBin=…`) | **não** |
| Lista de abas habilitadas (Audiência, Perícia, Características, Segredo, Redistribuição, Acessos de terceiros, PDPJ, Push) | `.rich-tab-header` | parcial |

## I.2. Achados com impacto direto em performance

### I.2.1. O HTML é a "API documental" do PJe legacy
Para o caso analisado (33 movimentos), `totalPaginas=1`. A paginação só aparece via `bindPaginacaoInfinita` em processos extensos. Conclusão: **uma única chamada cobre 80–90 % dos casos do TRF5**, e nenhum coordenador deveria precisar de mais de uma chamada por processo por sessão.

### I.2.2. Sobreposição de chamadas entre módulos do paidegua
Hoje, no mesmo processo, podem disparar de forma independente:
- [metas-coordinator.ts:185](../src/content/metas-cnj/metas-coordinator.ts#L185)
- [prazos-fita-coordinator.ts:1014](../src/content/gestao/prazos-fita-coordinator.ts#L1014)
- [pje-criminal-fetcher.ts:631](../src/content/criminal/pje-criminal-fetcher.ts#L631)
- [pje-api-partes.ts:71](../src/content/pje-api/pje-api-partes.ts#L71)
- [audiencia-coletor.ts:285](../src/content/audiencia/audiencia-coletor.ts#L285)
- [triagem-from-api.ts:355](../src/content/gestao/triagem-from-api.ts#L355)

Cada um faz seu próprio `fetch(listAutosDigitais.seam?idProcesso=X&ca=Y)`. **O mesmo IP, o mesmo usuário e o mesmo `idProcesso` em janela curta — esse é, hoje, o sinal mais barulhento que o paidegua emite no log do mantenedor do PJe.**

### I.2.3. URL REST do documento é pública por sessão
`/pje/seam/resource/rest/pje-legacy/documento/download/{idProcessoDocumento}` retorna o conteúdo do documento sem exigir o hash `ca`, apenas o cookie de sessão do usuário. O paidegua já usa em [extractor.ts](../src/content/extractor.ts); cabe formalizar como caminho preferencial.

### I.2.4. Combo `cbTipoDocumento` revela o universo de tipos
O `<select id="navbar:cbTipoDocumento">` lista, com IDs canônicos do PJe, **apenas os tipos efetivamente presentes nos autos**. Para perguntas como "este processo tem laudo pericial?", "tem contestação?", "tem emenda?", basta inspecionar esse select — sem varrer a timeline. Beneficia [processo-status-detector.ts](../src/shared/processo-status-detector.ts) e [criminal-pdf-filter.ts](../src/shared/criminal-pdf-filter.ts).

### I.2.5. Situação processual atual em texto
O bloco `menu-alertas` revela `Andamento desde 18 fev 2026` — informação útil para o módulo Metas CNJ (janela de cumprimento) e para o detector de status, hoje obtida indiretamente.

### I.2.6. Assinaturas do documento ativo
O DOM entrega CN completo, OU, emissor e timestamp da assinatura. Hoje não é capturado.

## I.3. Riscos de detecção e mitigação

O mantenedor do PJe consegue, pelos logs de aplicação:

- contar `GET listAutosDigitais.seam` por usuário/IP/janela;
- identificar a ausência de hits em recursos estáticos (JS/CSS) que um navegador real carregaria — um `fetch` puro deixa esse rastro, gerando uma **assinatura comportamental** distinguível;
- inspecionar `Referer`, `Sec-Fetch-Site`, `Sec-Fetch-Mode`;
- verificar `cid` do Seam (conversation ID): valores estranhos ou inexistentes podem disparar warnings.

Mitigações já parcialmente implementadas (validar) e a implementar:

1. **Cache compartilhado** `idProcesso → AutosSnapshot` com TTL curto (5–10 min), com single-flight (se há fetch em voo, aguarda o promise existente).
2. **Throttle global por origem** com fila e jitter (300–800 ms aleatório) entre requests do mesmo `tabId`.
3. **Reuso da aba aberta**: se o usuário já está na página dos autos, parsear o `document` da aba via `chrome.scripting.executeScript`. Generalizar o que [pje-task-popup.ts](../src/shared/pje-task-popup.ts) já faz.
4. **Honrar `Referer`**: o `fetch` do content script já carrega o referer da aba; manter assim. No background, garantir referer não-vazio (o `pje-api-from-content.ts` foi escrito justamente por isso — manter).
5. **`Sec-Fetch-Site: same-origin`**: vem automático do content script. Manter as chamadas a partir do content world.
6. **Não usar POST quando GET serve**: a requisição capturada é POST por interação JSF; paidegua já usa GET com `?idProcesso=X&ca=Y`. Manter.
7. **Não anexar `cid`**: o `cid=25403` é Seam conversation ID e **não é exigido** para a recuperação por GET com `ca`. Não anexar e não tentar reusar `cid` antigo.

## I.4. Síntese da Parte I

`listAutosDigitais.seam` é, na prática, um **endpoint "tudo-em-um"** subutilizado: vários módulos fazem leituras parciais e independentes do mesmo HTML, multiplicando hits sem justificativa funcional. A maior alavanca é a unificação por trás de um snapshot tipado consumido por todos os coordenadores.

---

# Parte II — Plano de otimização executável

A Parte I prescreve a direção. Esta parte concretiza em quatro alterações coordenadas, com aderência estrita aos requisitos não-funcionais elencados na seção II.5.

## II.1. Estado atual relevante (não inventar — relatar)

- **Não existe cache compartilhado** do HTML de `listAutosDigitais` entre módulos. Cada coordenador refaz fetch.
- **Não existe gateway/throttle centralizado**. Cada módulo aplica seu próprio retry com backoff exponencial (1 s → 3 s → 9 s, máx. 4 tentativas) em [pje-api-from-content.ts:246](../src/content/pje-api/pje-api-from-content.ts#L246) e seu próprio pool concorrente de até 25 workers.
- **Cache de `ca` foi removido em 20/04/2026** após incidente de envenenamento documentado em [post-mortem-prazos-na-fita.md §8](./post-mortem-prazos-na-fita.md). O servidor responde **HTTP 200 com stub HTML reduzido** quando o `ca` cacheado expirou silenciosamente. Qualquer cache futuro precisa **detectar stub** e invalidar. **NÃO recriar cache do `ca`.**
- **Reaproveitamento de parser** entre Criminal e Metas CNJ já existe ([metas-extractor.ts:29](../src/content/metas-cnj/metas-extractor.ts#L29) reutiliza funções de [criminal-extractor.ts](../src/content/criminal/criminal-extractor.ts)). Boa base para consolidar.
- **Snapshot de auth** persistido em `chrome.storage.session` ([STORAGE_KEYS.PJE_AUTH_SNAPSHOT](../src/shared/constants.ts#L668)); refresh silencioso Keycloak já implementado em [pje-auth-refresh-bridge.ts](../src/content/auth/pje-auth-refresh-bridge.ts).
- **Manifest** já cobre `https://*.jus.br/*` em `host_permissions` e `content_scripts.matches` — institucionalização nacional já está coberta no nível de permissão.

## II.2. As quatro alterações

### II.2.1. Alteração A — Camada `pje-autos-cache.ts` com single-flight + detecção de stub

**Arquivo a criar:** `src/content/pje-api/pje-autos-cache.ts`.

**Contrato exposto:**

```ts
export interface AutosSnapshot {
  readonly idProcesso: number;
  readonly idProcessoTrf: number | null;
  readonly numeroCnj: string;
  readonly fetchedAt: number;          // epoch ms
  readonly htmlBytes: number;          // tamanho original do HTML
  readonly cabecalho: AutosCabecalho;
  readonly partes: AutosPartes;
  readonly etiquetas: readonly string[];
  readonly situacaoAtual: AutosSituacao | null;
  readonly tiposDocumentoPresentes: readonly AutosTipoDocumento[];
  readonly timeline: readonly AutosEvento[];
  readonly assinaturasDocumentoAtivo: readonly AutosAssinatura[] | null;
  readonly abasHabilitadas: readonly string[];
}

export async function getAutosSnapshot(
  idProcesso: number,
  opts?: { ttlMs?: number; preferTabDom?: chrome.tabs.Tab; idTaskInstance?: number }
): Promise<AutosSnapshot>;

export function invalidateAutos(idProcesso: number): void;
```

**Comportamento:**

1. **Cache em memória** (`Map<idProcesso, { snapshot, expiresAt }>`) **no content script**, **não em `chrome.storage.local`**. Persistir HTML em disco viola §3 da [política de privacidade](./index.md) (CPFs, nomes, valores).
2. **TTL default = 300 000 ms** (5 min) — janela curta o suficiente para evitar dados estagnados em sessão de gabinete; longa o suficiente para absorver as 6+ chamadas que módulos diferentes fazem ao mesmo processo na mesma tarefa do usuário.
3. **Single-flight**: se há um `Promise<AutosSnapshot>` em voo para o mesmo `idProcesso`, retornar o mesmo Promise.
4. **Detecção de stub** (defesa contra a regressão de 20/04/2026):
   - rejeitar e invalidar se `htmlBytes < 50 000`;
   - rejeitar se ausente o seletor `#divTimeLine:eventosTimeLineElement` ou `#mais-detalhes`;
   - em qualquer rejeição, **forçar regeneração do `ca`** (não cachear `ca`) e refazer **uma única vez**;
   - persistir o evento no diagnóstico ([logs anônimos](./telemetria-local-e-escala.md)).
5. **Reuso de aba aberta**: se `opts.preferTabDom` aponta para uma aba do PJe já carregada com o `idProcesso` desejado, executar `chrome.scripting.executeScript` para parsear o DOM ali — **zero novo hit no servidor**.

**Por que não usar `chrome.storage.session` para o cache:**
- conteúdo do HTML inclui CPFs, nomes de partes, números bancários ocasionais — manter em memória do content script (escopo da aba) limita o ciclo de vida ao que a LGPD chama de "estritamente necessário";
- `chrome.storage.session` sobrevive a hibernação do service worker e fica visível à extension API toda — superfície maior do que precisa.

### II.2.2. Alteração B — Gateway `pje-gateway.ts` com fila e jitter

**Arquivo a criar:** `src/content/pje-api/pje-gateway.ts`.

**Contrato:**

```ts
export interface PjeGatewayOptions {
  origin: string;                       // ex: "https://pje1g.trf5.jus.br"
  maxRequestsPerSecond?: number;        // default 4
  jitterRangeMs?: [number, number];     // default [120, 480]
  maxConcurrent?: number;               // default 6
}

export const pjeGateway = {
  fetch(url: string, init?: RequestInit & { critical?: boolean }): Promise<Response>;
};
```

**Comportamento:**

1. Bucket por origem (1g/2g de cada TRF é bucket distinto).
2. **Fila FIFO** com prioridade baixa para `critical: false` (varreduras massivas em background) e prioridade alta para `critical: true` (clique do usuário em "abrir processo"). Varreduras nunca devem bloquear interação.
3. **Jitter aleatório** entre 120 e 480 ms antes do dispatch — só nas varreduras (`critical: false`); cliques diretos não esperam.
4. Reaproveitar o **retry exponencial** já implementado em [pje-api-from-content.ts:246](../src/content/pje-api/pje-api-from-content.ts#L246), movendo-o para o gateway.
5. **Não logar URL completa** em nenhum erro/warning (URL contém `idProcesso` e `ca`; o `ca` vence em minutos, mas o `idProcesso` é PII de processo). Logar apenas o `idProcesso` em campo separado e a categoria do erro.

**Pool concorrente por módulo permanece**, mas passa a chamar `pjeGateway.fetch` em vez de `fetch` global. O gateway aplica o teto de concorrência por origem; o pool do módulo aplica o teto por tarefa do usuário. As duas camadas são complementares.

### II.2.3. Alteração C — Refatoração incremental dos call-sites

**Estratégia:** **strangler fig**, não big-bang. Cada módulo migra para `getAutosSnapshot()` em PR independente, com flag de fallback ao caminho atual. Ordem proposta (do menor risco ao maior):

1. [pje-api-partes.ts](../src/content/pje-api/pje-api-partes.ts) — extração de partes. Superfície pequena, alto valor de validação.
2. [metas-extractor.ts](../src/content/metas-cnj/metas-extractor.ts) — Metas CNJ. Fluxo de varredura batch ideal para validar throttle.
3. [criminal-extractor.ts](../src/content/criminal/criminal-extractor.ts) e [pje-criminal-fetcher.ts](../src/content/criminal/pje-criminal-fetcher.ts).
4. [audiencia-coletor.ts](../src/content/audiencia/audiencia-coletor.ts).
5. [triagem-from-api.ts](../src/content/gestao/triagem-from-api.ts).
6. [prazos-fita-coordinator.ts](../src/content/gestao/prazos-fita-coordinator.ts) — **último**, porque é o que sofreu os incidentes de abril/2026 e é o módulo onde a detecção de stub mais importa. Migrar com revisão dedicada.

Cada PR deve preservar o comportamento observável (mesmos campos extraídos, mesmas anomalias sinalizadas), com testes de regressão sobre o HTML capturado em fixtures (ver II.4).

### II.2.4. Alteração D — Enriquecer o `AutosSnapshot` com dados hoje desperdiçados

Implementar, dentro do parser unificado, a extração de:

1. **Situação atual + data desde** (alimenta Metas CNJ e detector de status).
2. **Universo de tipos presentes** a partir de `select#navbar:cbTipoDocumento` (decisão O(1) substituindo varredura completa em [processo-status-detector.ts](../src/shared/processo-status-detector.ts)).
3. **Assinaturas do documento ativo** (futura sinalização de auditoria).
4. **`idProcessoTrf`** (já parcialmente capturado; consolidar no snapshot).
5. **Abas habilitadas** (`Audiência`, `Perícia` etc.) — útil para ramificação condicional sem precisar abrir aba.

Sem novo fetch — tudo já vem no mesmo HTML.

## II.3. Boas práticas de comunicação com o PJe

Estas regras tornam-se **invariantes do projeto**, verificáveis por revisão de código:

| Invariante | Justificativa |
|---|---|
| Toda chamada a `*.jus.br` passa por `pjeGateway.fetch`. | Único ponto de throttle, jitter e retry; auditável em uma busca. |
| Toda leitura de `listAutosDigitais.seam` passa por `getAutosSnapshot`. | Cache, single-flight e detecção de stub não podem ser bypassados. |
| Nunca cachear `ca` em storage. | Regressão 20/04/2026. |
| Nunca usar `cid` da página do PJe em chamadas próprias. | Conversation ID Seam é específico do contexto JSF do usuário; reutilizar gera warnings. |
| Nunca anexar headers que o navegador real não envie nesse contexto. | `x-requested-with` etc. são fingerprint trivial. |
| Nunca pré-fetchar processos especulativamente. | Crawler sem evento UI é o sinal mais reconhecível. |
| Toda varredura batch usa `critical: false`. | Cliques diretos do usuário sempre têm prioridade. |
| Toda chamada deve ser feita do content script (same-origin), não do background. | Same-origin via cookie de sessão; evita CORS e mantém Referer correto. |
| URL com `ca` ou `idProcesso` jamais aparece em log textual; somente o `idProcesso` em campo separado. | LGPD §6 — minimização. |
| TTL do cache em memória ≤ 600 000 ms; cache persistido em disco proibido. | Necessidade × retenção; ciclo de vida da aba. |
| Detecção de stub em toda resposta (tamanho mínimo + presença de marcadores DOM). | Defesa em profundidade contra resposta degradada do servidor. |

## II.4. Testes que dão garantia ao revisor sênior

Sem CI ainda configurado para esses testes (registrar como pendência), mas o projeto deve passar a ter:

1. **Fixtures de HTML real** (anonimizadas) em `test/fixtures/listAutosDigitais/`, capturadas de:
   - processo cível com 33 movimentos (caso analisado);
   - processo criminal com sigilo;
   - processo do JEF;
   - processo com timeline > 100 entradas (paginação).
2. **Testes de parser unitários** que rodam offline contra essas fixtures, sem rede.
3. **Teste de detecção de stub** que pega o stub de 32 KB do incidente de 20/04/2026 (capturar e anonimizar) e confirma rejeição.
4. **Teste de single-flight** que dispara 50 `getAutosSnapshot(123)` paralelos e verifica que houve **um único** `fetch` real.
5. **Teste de throttle** que injeta `Date.now()` e verifica que o gateway respeita `maxRequestsPerSecond`.
6. **Teste de invalidação por TTL**.
7. **Teste de privacidade**: scan estático que falha se houver `console.log` ou `console.warn` contendo template literals que incluam variáveis cujo nome contém `cpf`, `ca`, `url`, `htmlBruto`.

## II.5. Requisitos não-funcionais e como cada alteração os endereça

### II.5.1. Auditabilidade por desenvolvedor sênior independente

| Necessidade | Como o plano endereça |
|---|---|
| Pontos de I/O concentrados, não espalhados | Gateway único + cache único; busca por `pjeGateway.fetch` ou `getAutosSnapshot` lista todos os call-sites em segundos. |
| Contratos tipados, não strings | `AutosSnapshot` em TypeScript com `readonly` em todos os campos. |
| Ausência de dead branches e magic numbers | Todos os limiares declarados em [`constants.ts`](../src/shared/constants.ts) com nome semântico. |
| Reversibilidade da refatoração | Strangler fig com flag de fallback por módulo. |
| Testes determinísticos | Fixtures de HTML real, sem rede. |
| Política de logs verificável | Scan estático na CI rejeita logs com PII. |

### II.5.2. LGPD e Resolução CNJ 615/2025

| Princípio | Aplicação concreta |
|---|---|
| Adequação (art. 6º, II) | Cache só para a finalidade de extração processual da sessão atual; TTL ≤ 10 min. |
| Necessidade (art. 6º, III) | Snapshot retém apenas campos do parser; HTML bruto não é persistido após o parse. |
| Minimização | Logs nunca contêm CPF, OAB, nome de parte, URL com `ca` ou HTML. Já existe rotina de [anonimização](./index.md#anonimizacao-preventiva) para envio à IA — não enfraquecer. |
| Segurança (art. 46) | Cache em memória do content script (escopo da aba). Sem `chrome.storage.local`. |
| Eliminação (art. 16) | Cache se esvazia ao fechar a aba; nada a apagar manualmente. |
| Transparência (art. 9º) | Atualizar [política de privacidade](./index.md) §3 para citar explicitamente o cache em memória, sua finalidade e retenção. |
| Resolução CNJ 615/2025, art. 19, II (vedação ao uso para treino) | Inalterado — o cache é local; nada vai a provedor de IA sem ação do usuário. |

**Atualização normativa requerida na política de privacidade** (item §3.1):
> "Durante o uso ativo da extensão, dados estruturais do processo (partes, classes, timeline) são mantidos em memória da aba pelo tempo necessário para a operação solicitada, com retenção máxima de 10 minutos por processo, descartados automaticamente ao final da sessão."

### II.5.3. Institucionalização nacional (todos os tribunais que usam PJe)

| Pressuposto | Validação |
|---|---|
| `host_permissions: https://*.jus.br/*` cobre todos os tribunais | Já presente no [manifest.json](../manifest.json). |
| Variações regionais do PJe (1G/2G, TRFs, TJs) compartilham a mesma estrutura JSF/RichFaces | Validar contra fixtures de pelo menos: TRF1, TRF2, TRF3, TRF4, TRF5, TRF6, e três TJs grandes (SP, MG, RJ). Estabelecer no PR de validação que **a versão `2.x.x` requer essa matriz mínima**. |
| Diferenças de tema/skin não quebram seletores | Usar seletores **estruturais** (`[id*="divTimeLine"]`, `[class~="texto-movimento"]`), não de tema. |
| Eproc, PROJUDI e demais não-PJe | **Fora do escopo desta versão.** Bandeira explícita no [adapter](../src/content/adapters/pje-legacy.ts): se o detector identificar não-PJe, devolver `null` e nenhum coordenador deve cair em path otimizado. |
| Versões de PJe legacy diferentes (TJSP usa fork; TRFs usam linha CNJ) | O parser deve **falhar de forma controlada** (devolver `ParseAnomaly` em vez de crashar) e enviar o caso ao log local de Diagnóstico. Sem fixtures, o módulo afetado degrada para o caminho atual via flag de fallback (II.2.3). |
| Distribuição massificada exige mais cuidado com perfil no log do mantenedor | O ponto de revisão obrigatória antes da v2.0 é: **com 10 000 usuários ativos, a distribuição estatística de chamadas da extensão deve ser indistinguível de uso humano normal**. Throttle + jitter + reuso de aba são as três alavancas. |

**Pré-condições institucionais para a v2.0 (massificação nacional):**

1. **Comunicação formal com o CNJ/DTI** apresentando a extensão, suas chamadas ao PJe e seu padrão de uso. Pedir parecer ou ciência. Sem isso, a operação em massa pode ser interpretada como uso indevido de API.
2. **Adesão por convite institucional** (TRF/TJ que assinar o termo) — não distribuição aberta na Chrome Web Store enquanto não houver alinhamento.
3. **Fingerprint distinguível**: o `User-Agent` da extensão **não** é alterado, mas pode-se incluir um header documentado **acordado com o CNJ** (ex.: `X-Tool-Identifier: paidegua/2.0`) que permita ao mantenedor identificar e excluir do alarme — transparência troca-se por estabilidade. Decisão depende da resposta do item 1.
4. **Plano de incident response**: canal direto com o time do PJe para receber pedidos de redução de tráfego; o gateway deve aceitar configuração remota de `maxRequestsPerSecond` recebida do backend Inovajus (parâmetro institucional).

### II.5.4. Mitigação de riscos de refatoração

| Risco | Mitigação |
|---|---|
| Quebrar fluxo de Metas CNJ ou Prazos na Fita em produção | Strangler fig com flag por módulo; cada PR testa contra fixtures antes de migrar. |
| Recriar incidente do `ca` envenenado | Detecção de stub é requisito do `getAutosSnapshot` desde o primeiro commit; não há cache de `ca`. |
| Cache invalidando dados que o usuário acabou de modificar (ex.: nova etiqueta) | TTL ≤ 5 min; `invalidateAutos(idProcesso)` chamado por toda mutação que a extensão dispara (criar etiqueta, juntar documento, etc.). |
| Duplicação de parser entre Criminal e Metas CNJ aumentar pela refatoração | Parser único, exportado pelo cache; Criminal e Metas CNJ consomem `AutosSnapshot`. |
| Perda de informação que algum módulo extraía e o snapshot não cobre | Exigir, antes de cada PR de migração, **revisão do extractor antigo** com checklist explícito de campos. Documentar campos cobertos no `AutosSnapshot` versus campos legados. |
| Quebra silenciosa por mudança no HTML do PJe | Detecção de stub + parser que devolve `ParseAnomaly` em vez de `null`/`undefined`. Anomalias contadas no painel de Diagnóstico. |
| Logs de `console.log` vazando PII durante o desenvolvimento | Scan estático (II.4 #7) bloqueia merge. |
| Refatoração se arrastar e a base ficar com dois caminhos coexistindo indefinidamente | Cronograma rígido por módulo (1 sprint cada); flag de fallback removida na v2.0. |
| Regressão de performance por single-flight serializar acidentalmente | Testes de carga locais (50 chamadas paralelas a 50 processos distintos) antes do merge. |

### II.5.5. Outros riscos mapeados

| Risco | Mitigação |
|---|---|
| Sessão do usuário expira durante varredura longa (1 000+ processos) | Refresh silencioso já existe ([pje-auth-refresh-bridge.ts](../src/content/auth/pje-auth-refresh-bridge.ts)). Garantir que o gateway aguarde o refresh em vez de falhar a fila. |
| Aba em background, Chrome suspende rede | Comportamento documentado em [post-mortem-prazos-na-fita.md §1](./post-mortem-prazos-na-fita.md). Alertar o usuário, não recuperar silenciosamente — varredura batch deve indicar progresso a cada N processos. |
| Mudança do PJe em produção quebra parser | Anomalias agregadas + canal de comunicação com Inovajus (não há telemetria; depende de o usuário reportar). Cada anomalia inclui versão da extensão e hash dos seletores que falharam. |
| Extensão alvo de scraping reverso por terceiros | Código está sob controle do Inovajus; build de produção minificado; chave de assinatura institucional. Fora do escopo da extensão impedir reverse engineering — assumir adversário com acesso ao bundle. |
| Conflito com outras extensões que usam `executeScript` na mesma aba | Namespace único nas variáveis injetadas (`window.__paidegua_v2_*`). |
| Conformidade com LGPD em caso de chamado regulatório | Documentar este manual + política de privacidade como artefatos vinculados. Toda decisão técnica tem rastreabilidade ao princípio. |

---

# Parte III — Roadmap, anti-padrões e checklist de aceitação

## III.1. Roadmap proposto

| Fase | Entregável | Critério de saída |
|---|---|---|
| **F1** — Infraestrutura | `pje-gateway.ts` + `pje-autos-cache.ts` com cobertura de testes da seção II.4. | Testes verdes; nenhum call-site migrado ainda; flag global desligada. |
| **F2** — Validação interna | Migração do call-site de `pje-api-partes.ts` (menor superfície). | Comportamento observável idêntico em 30 processos reais; 0 incidentes em 1 semana de uso interno. |
| **F3** — Massa pequena | Migração de Metas CNJ + Criminal. | Redução medível de chamadas a `listAutosDigitais` (esperado: 60–85 % em rotinas que cruzam módulos). Métrica medida via [Diagnóstico](../src/diagnostico/) — contagem local. |
| **F4** — Massa grande | Migração de Audiência + Triagem + Prazos na Fita. | Pool ainda em 25 workers; throttle de gateway em 4 req/s/origem. Validar com varredura de 1 000+ processos sem 4xx/5xx. |
| **F5** — Enriquecimento | Adição dos campos II.2.4 ao snapshot e consumo por detector de status, Metas CNJ, futura sinalização de auditoria. | Detector de status reduz tempo médio de classificação. |
| **F6** — Pré-massificação nacional | Comunicação formal CNJ/DTI; ajuste do header `X-Tool-Identifier` se acordado; remoção de flags de fallback. | Parecer/ciência do CNJ; 4 TRFs e 3 TJs validados em fixtures. |
| **F7** — Massificação nacional (v2.0) | Lançamento institucional. | Plano de incident response ativo; canal direto com mantenedor do PJe; documentação publicada. |

## III.2. Anti-padrões — o que não fazer

1. **Não recriar cache de `ca`.** Resposta degradada do servidor não dispara erro; alimenta dados falsos. Já documentado em [post-mortem-prazos-na-fita.md §8](./post-mortem-prazos-na-fita.md).
2. **Não pré-fetchar processos especulativamente.** Worker que varre lista do painel só "para esquentar cache" é o sinal mais reconhecível pelo log do mantenedor.
3. **Não anexar headers que o navegador real não envia** nesse contexto (`x-requested-with`, custom). Cria fingerprint trivial.
4. **Não construir URLs com `cid` reaproveitado.** Conversation ID Seam é específico do estado JSF do usuário.
5. **Não baixar PDFs/anexos quando o objetivo é só metadado.** O extractor já é sob demanda — manter.
6. **Não persistir HTML de processo em `chrome.storage.local`.** Viola minimização LGPD.
7. **Não logar URL completa nem corpo de resposta** em `console.warn`/`error`.
8. **Não usar POST quando GET serve.** O paidegua já usa GET; a requisição capturada que deu origem a este manual é POST porque vem de interação JSF do usuário, não da extensão.
9. **Não fazer chamadas a partir do background script** quando o content script same-origin pode fazer. Same-origin via cookie é o caminho institucionalmente correto.
10. **Não distribuir versão massificada na Chrome Web Store antes da F6.** Risco de bloqueio institucional pelo CNJ por uso não comunicado da API.

## III.3. Checklist de aceitação para v2.0 (massificação nacional)

Itens que precisam estar verdes antes da release:

- [ ] `pje-gateway.ts` cobrindo 100 % das chamadas a `*.jus.br`.
- [ ] `getAutosSnapshot` cobrindo 100 % das leituras de `listAutosDigitais.seam`.
- [ ] Detecção de stub testada contra fixture do incidente 20/04/2026.
- [ ] Throttle por origem em ≤ 4 req/s default; configurável por backend Inovajus.
- [ ] Jitter em varreduras (não em cliques).
- [ ] Reuso de aba aberta como prioridade em todos os fluxos que admitem.
- [ ] TTL do cache em memória ≤ 600 000 ms; sem persistência em disco.
- [ ] Scan estático bloqueando logs com PII no merge.
- [ ] Política de privacidade ([index.md](./index.md)) atualizada com o item de cache em memória.
- [ ] Comunicação formal ao CNJ/DTI realizada e parecer/ciência arquivados.
- [ ] Plano de incident response com contato direto do mantenedor do PJe.
- [ ] Fixtures de pelo menos 4 TRFs e 3 TJs validadas.
- [ ] Detecção de não-PJe (Eproc/PROJUDI) devolvendo `null` no detector.
- [ ] Nenhum cache de `ca` em parte alguma do código.
- [ ] Flags de fallback removidas; um único caminho ativo em produção.
- [ ] Manual atualizado refletindo o estado pós-massificação.

## III.4. Como manter este manual vivo

- **Toda alteração estrutural** em `pje-gateway.ts` ou `pje-autos-cache.ts` deve atualizar a Parte II e referenciar o commit aqui.
- **Todo incidente** envolvendo o PJe vira anexo (post-mortem) e atualiza o anti-padrão correspondente.
- **Toda revisão da Resolução CNJ 615 ou da LGPD** que afete o tratamento de dados pessoais aciona revisão obrigatória da §II.5.2.
- **A cada release maior**, revisar a Parte III §1 (Roadmap) e §3 (Checklist) como fonte de verdade do estado.

---

**Fim do manual.**
Em caso de dúvida sobre interpretação institucional: [inovajus@jfce.jus.br](mailto:inovajus@jfce.jus.br).
