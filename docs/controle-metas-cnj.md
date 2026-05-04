# Controle Metas CNJ — arquitetura, estado e pendências

**Projeto:** pAIdegua — Assistente IA para o PJe
**Perfil:** Gestão → *Controle Metas CNJ*
**Última revisão:** 03/05/2026
**Status:** V1 funcional — camada de dados, coleta, classificação e UI mínima entregues e compilando. Falta tela de configuração, listas oficiais de classes/assuntos por meta, override manual na UI e pool concorrente de fetch.

Documentos companheiros:
- [`extracao-tpu-pje.md`](./extracao-tpu-pje.md) — extração e regeração da Tabela Processual Unificada (TPU/CNJ) embarcada
- [`extracao-tarefas-painel-pje.md`](./extracao-tarefas-painel-pje.md) — padrão de varredura por tarefa do painel
- [`arquitetura-coleta-prazos-na-fita.md`](./arquitetura-coleta-prazos-na-fita.md) — pool concorrente + checkpoint que o Metas CNJ pretende absorver na próxima evolução

---

## 1. O que é e por que existe

O módulo materializa, no perfil Gestão do pAIdegua, um **acervo persistente** dos processos da vara classificados segundo as **Metas Nacionais 2026 do Conselho Nacional de Justiça** (aprovadas no 19º ENPJ — Florianópolis/SC, 1-2 dez/2025).

Diferente dos demais painéis da extensão — todos efêmeros (`storage.session` apagado ao fechar a aba) — o controle de metas precisa **manter os dados entre sessões**: o painel é consultado várias vezes por mês para acompanhamento, e cada nova varredura deve **atualizar incrementalmente** o que já foi coletado, sem refazer trabalho. A varredura ideal é semanal ou mensal; rodar a cada acesso seria caro e dispensável.

Essa diferença — acervo durável + atualização incremental — guia todas as escolhas arquiteturais documentadas adiante.

---

## 2. Quais metas valem para JFCE (TRF5 / 1º grau)

Das 10 metas aprovadas, **5 são mensuráveis** pelo painel (dependem de filtros sobre processos individuais) e **3 são informativas** (dependem de indicadores agregados oficiais — entrada manual). As demais não se aplicam à JF 1G.

| Meta | Texto resumido (JF 1G, TRF5 = Faixa 2) | Mensurável? |
|---|---|---|
| 1 | Julgar > distribuído no ano | Não — indicador de fluxo |
| **2** | 100% pendentes distribuídos há 15 anos (2011); 85% até 31/12/2022; 100% JEF/TR até 31/12/2023 | **Sim — depende de `data_distribuicao`** |
| 3 | Conciliação +0,5pp (cláusula 8%) | Não — indicador agregado |
| **4** | 85% improbidade + 85% crimes Adm. Pública distribuídos até 31/12/2023 | **Sim — classe + assunto + data** |
| 5 | Congestionamento −0,5pp (cláusula 46%) | Não — indicador agregado |
| **6** | 38% ações ambientais distribuídas até 31/12/2025 | **Sim — assunto + data** |
| **7** | 35% indígenas, 35% quilombolas, 50% racismo até 31/12/2025 | **Sim — assunto + data** |
| 8 | Feminicídio | N/A (só JE) |
| 9 | Plano de inovação | Não — institucional |
| **10** | 100% subtração internacional de crianças até 31/12/2025 | **Sim — assunto + data** |

A configuração **default** ([defaultMetasCnjConfig](../src/shared/metas-cnj-types.ts)) deixa as metas mensuráveis ativadas com a data de corte preenchida; **as listas de classes/assuntos elegíveis estão vazias** — sem elas, Meta 4/6/7/10 não enquadram ninguém. Pendência crítica para a entrega final.

---

## 3. Princípios arquiteturais (decisões com seus porquês)

### 3.1 Banco IndexedDB próprio, separado dos demais

Acervo vai para `paidegua.metas-cnj` — **banco distinto** dos `paidegua.criminal` (sigcrim) e `paidegua.tpu` (catálogo TPU). Razões:

1. **Propósitos distintos**: criminal carrega réus/ANPP/SERP; TPU é catálogo estático nacional; metas é acervo de classificação operacional. Misturar acopla ciclos de vida que devem ser independentes (`Apagar acervo de metas` não pode tocar no acervo criminal e vice-versa).
2. **Export/import independente** — backups e transferência entre servidores são por banco.
3. **Versionamento de schema isolado** — a evolução de um não força migração dos outros.

Trade-off aceito: três handles de IDB abertos simultaneamente em algumas operações. Custo desprezível.

### 3.2 Chave natural por número CNJ + upsert

Chave primária = `numero_processo` (formato CNJ). Cada nova varredura faz **upsert por essa chave** preservando origem manual. Isso permite que reexecutar a varredura seja seguro: dados que vieram do PJe são atualizados; campos que o usuário editou (origem `manual`) são mantidos.

A lógica de "manual vence sobre PJe" foi importada do sigcrim ([criminal-store.ts:upsertProcessoFromPje](../src/shared/criminal-store.ts)) — padrão já validado em produção naquele módulo.

### 3.3 Atualização incremental via `ultimo_movimento_visto`

A varredura semanal/mensal do usuário não pode refazer fetch profundo dos autos para todos os processos do acervo a cada execução. Estratégia:

1. A listagem REST do painel (`recuperarProcessosTarefaPendenteComCriterios`) já devolve o **último movimento** de cada processo (`descricaoUltimoMovimento` + `ultimoMovimento` timestamp).
2. Construímos uma assinatura `${ts}::${desc}` e gravamos como `ultimo_movimento_visto` no acervo.
3. Antes do fetch profundo de UM processo, o coordinator **pergunta ao background**: "este processo já está no acervo com esta assinatura?". Se sim, pula o fetch (`presente_ultima_varredura: true` apenas) — segundos vs minutos.

Sem esse atalho, o usuário pagaria fetch dos autos para processos que não tiveram mudança nenhuma — desperdício total. Com ele, varreduras subsequentes ficam dramaticamente mais rápidas.

### 3.4 Detecção de status sem ação manual no caminho feliz

Quando um processo desaparece da varredura (foi julgado, baixado ou redistribuído), precisamos classificá-lo. A regra aceita pelo usuário foi explícita: **zero ação manual no caminho feliz**. A hierarquia implementada em [`processo-status-detector.ts`](../src/shared/processo-status-detector.ts) é:

1. Override manual sempre vence
2. **Movimento oficial de baixa** no histórico (categoria `baixa` na TPU — ex.: código 22)
3. **Movimento oficial de julgamento** (categorias `julgamento_merito | julgamento_sem_merito | homologacao_acordo | extincao_punibilidade`)
4. **Documento anexo "Sentença"/"Acórdão"** (cobre processos migrados sem histórico) — com filtro de ruído (descrição contendo "minuta", "embargos", "anexo" etc. é descartada)
5. **Tarefa atual indica fase pós-julgamento** — substring CI configurável (`Cumprimento de sentença`, `Execução`, `Apelação` etc.)
6. Sumiço inferido — mantém status anterior, marca `origem_status: 'inferido_sumico'`
7. Default: `pendente`

A tabela TPU embarcada (677 movimentos, [`tpu-seed-data.ts`](../src/shared/tpu-seed-data.ts)) classifica cada movimento via [`tpu-categorias-julgamento.ts`](../src/shared/tpu-categorias-julgamento.ts):

- `julgamento_merito`: descendentes de 385 ("Magistrado | Julgamento | Com Resolução do Mérito")
- `julgamento_sem_merito`: descendentes de 218
- `extincao_punibilidade`: descendentes de 973 (acumula com `julgamento_merito`, pois 973 fica sob 385)
- `homologacao_acordo`: whitelist explícita {466, 377, 12738, 12733, 14099, 15244, 14776}
- `baixa`: whitelist explícita {22} — apenas Baixa Definitiva (arquivamento NÃO é baixa)

### 3.5 Aplicador de regras por meta — declarativo

Cada meta tem uma função pura `aplicaMetaN(processo, configMeta) => boolean` em [`metas-cnj-regras.ts`](../src/shared/metas-cnj-regras.ts). A decisão de incluir um processo em uma meta é:

1. Se `meta_override_manual[metaId] === true` → inclui
2. Se `=== false` → exclui
3. Senão, se `cfg.ativada === false` → exclui
4. Senão, aplica a função pura

Funções puras facilitam revisar contra o texto da norma. Alterações de regras = uma função, nunca espalhadas.

### 3.6 Aplicação de etiqueta em lote — reuso

Reusa **integralmente** o aplicador do módulo Perícias ([`pericias-etiqueta-applier.ts`](../src/content/pericias/pericias-etiqueta-applier.ts) via `aplicarEtiquetaEmLoteComBridge`). Os endpoints REST do PJe TRF5 (`POST /painelUsuario/tags`, `POST /painelUsuario/processoTags/inserir`, favoritar via `tagSessaoUsuario/adicionar/<id>`) já estão confirmados em campo. Zero código novo de aplicação.

O dashboard envia ao background, o background escolhe uma aba do PJe aberta e roteia (mesma estratégia de `handlePericiasAplicarEtiquetas`).

### 3.7 Catálogo TPU embarcado vs. consulta REST

A Tabela Processual Unificada do CNJ (677 movimentos no TRF5, 503 SGT + 174 locais) é **embarcada como seed** no bundle ([`tpu-seed-data.ts`](../src/shared/tpu-seed-data.ts), 222KB) e populada no banco `paidegua.tpu` na primeira execução do módulo de Metas (idempotente — ver `garantirSeed`).

Razões:
- TPU SGT muda raramente (revisões anuais do CNJ);
- Endpoint de consulta não é estável nem público;
- Fetch zero na inicialização — UI fica responsiva imediatamente.

Quando o CNJ revisar a TPU, o builder [`scripts/build-tpu-seed.mjs`](../scripts/build-tpu-seed.mjs) regenera o seed a partir de uma extração via console no PJe (instruções em [`extracao-tpu-pje.md`](./extracao-tpu-pje.md)).

### 3.8 Sem polling — service worker reativo

O service worker MV3 pode ser suspenso entre mensagens. A topologia segue o padrão consagrado dos outros painéis (Painel Gerencial, Prazos na Fita, Sigcrim, Perícias):

- Aba intermediária + aba do PJe falam **através do background**, que mantém a rota `requestId → {painelTabId, pjeTabId}` em `chrome.storage.session`.
- A rota é persistida porque o service worker pode hibernar entre eventos longos.
- Listener do `chrome.storage.onChanged` substitui polling em casos como aguardar refresh de token (já implementado em outros módulos).

---

## 4. Modelo de dados — banco `paidegua.metas-cnj`

Schema definido em [`metas-cnj-store.ts`](../src/shared/metas-cnj-store.ts). Versão 1.

**Object store `processos`** — keyPath `numero_processo`:

| Índice | Tipo | Uso |
|---|---|---|
| `classe_sigla` | não-único | Filtro Meta 4 |
| `ano_distribuicao` | não-único | Filtro Meta 2 |
| `status` | não-único | Pendentes / julgados / baixados |
| `meta_aplicavel` | multiEntry | Lista por meta — query O(log n) |
| `presente_ultima_varredura` | não-único | Sumidos vs presentes |
| `id_processo_pje` | não-único | Cross-reference com PJe |

Campos principais:
- Identificação: `numero_processo`, `id_processo_pje`, `id_task_instance_atual`
- Classificação: `classe_sigla`, `assunto_principal`, `polo_ativo`, `polo_passivo`, `orgao_julgador`, `cargo_judicial`
- Datas críticas: `data_distribuicao`, `data_autuacao`, `ano_distribuicao` (derivado, indexável)
- Metas: `metas_aplicaveis: MetaCnjId[]`, `meta_override_manual: Partial<Record<MetaCnjId, boolean>>`
- Status: `status`, `origem_status`, `status_definido_em`, `data_julgamento`, `data_baixa`
- Auditoria: `presente_ultima_varredura`, `ultimo_movimento_visto` (chave incremental), `origem_dados: Record<campo, 'pje' | 'manual' | 'ia'>`
- Carimbos: `capturado_em`, `atualizado_em`, `ultima_sincronizacao_pje`

**Object store `meta`** — keyPath `key`:
- `{ key: 'config', value: MetasCnjConfig }`
- `{ key: 'last_sync', value: MetasCnjLastSync }`
- `{ key: 'schema_version', value: 1 }` (reservado para migrações futuras)

---

## 5. Pipeline de coleta (sequência completa)

Topologia idêntica ao Prazos na Fita / Painel Gerencial.

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. Sidebar (perfil Gestão) → clique no botão "Controle Metas CNJ" │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. content.handleMetasCnj() →                                     │
│     abrirMetasPainel() → listarTarefasDoPainel() →                 │
│     METAS_OPEN_PAINEL                                              │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. background.handleOpenMetasPainel() →                           │
│     garantirSeed TPU (idempotente) →                               │
│     grava state em storage.session →                               │
│     abre `metas-painel/painel.html?rid=...`                         │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. metas-painel/painel.ts (aba intermediária):                    │
│     lê state do session → renderiza checkboxes →                   │
│     usuário marca tarefas + "Iniciar varredura" →                  │
│     METAS_START_COLETA                                              │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  5. background.handleMetasStartColeta() →                          │
│     resetarPresencaVarredura() (todos → false) →                   │
│     METAS_RUN_COLETA → content da aba PJe                          │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  6. content.handleMetasRunColeta() → varrerMetasCnj():             │
│                                                                     │
│  Para cada tarefa selecionada:                                      │
│    listarProcessosDaTarefa() (REST, paginado)                      │
│                                                                     │
│  Para cada processo:                                                │
│    a. Consulta background: precisa fetch profundo?                 │
│       (pergunta: já está no acervo com este ultimo_movimento?)     │
│    b. Se SIM:                                                       │
│         gerarChaveAcesso()                                          │
│         coletarDadosMetasDoProcesso() — fetch SSR + parse          │
│         envelope com data_distribuicao + movimentos + documentos   │
│    c. Se NÃO:                                                       │
│         envelope leve só com presence: true                        │
│    d. METAS_UPSERT_PROCESSO ao background                          │
│    METAS_COLETA_PROG (linha de log)                                │
│                                                                     │
│  METAS_COLETA_DONE com resumo                                       │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  7. background.handleMetasUpsertProcesso() (chamado N vezes):      │
│     upsert no acervo (preserva origem manual);                     │
│     se veio com fetch profundo:                                    │
│       enriquecerMovimentos com categorias TPU;                     │
│       detectarStatus (hierarquia 1A→1B→2→...);                     │
│       calcularMetasAplicaveis (regras por meta);                   │
│       segundo upsert com status + metas_aplicaveis.                │
└─────────────────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  8. background.rotearEventoMetas(DONE):                            │
│     saveLastSync() + METAS_COLETA_READY → aba intermediária        │
│     limpa storage.session + deleteRota                              │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  9. metas-painel.ts: window.location.replace(metas-dashboard)      │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 10. metas-dashboard/dashboard.ts:                                  │
│     listAllProcessos() (lê IDB direto — extension origin)          │
│     loadConfig() / loadLastSync()                                   │
│     renderiza cards por meta + lista de pendentes                  │
│     formulário "Aplicar etiqueta" → METAS_APLICAR_ETIQUETAS        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Mapa de arquivos (ondem-natural ler em sequência)

### Camada compartilhada (`src/shared/`)

| Arquivo | Responsabilidade |
|---|---|
| [`metas-cnj-types.ts`](../src/shared/metas-cnj-types.ts) | Tipos do domínio: `MetaCnjId`, `StatusProcessoMeta`, `OrigemStatusMeta`, `ProcessoMetasCnj`, `MetasCnjConfig`, `MetasCnjLastSync`, `defaultMetasCnjConfig()` |
| [`metas-cnj-regras.ts`](../src/shared/metas-cnj-regras.ts) | Aplicador de regras: `calcularMetasAplicaveis(processo, config)`. Uma função pura por meta. |
| [`metas-cnj-store.ts`](../src/shared/metas-cnj-store.ts) | Banco `paidegua.metas-cnj`: open/withTx, CRUD, `upsertProcesso` (preserva manual), `setOverrideMeta`, `getStats`, `apagarAcervo` |
| [`processo-status-detector.ts`](../src/shared/processo-status-detector.ts) | Detector puro: hierarquia 1A→1B→2→... + `enriquecerMovimentos` (consulta TPU) |
| [`tpu-types.ts`](../src/shared/tpu-types.ts) | Tipos do catálogo TPU: `MovimentoTpu`, `TpuOrigem`, `TpuCategoria`, `TpuSeedSnapshot` |
| [`tpu-seed-data.ts`](../src/shared/tpu-seed-data.ts) | Snapshot dos 677 movimentos TPU (gerado, ~220KB). NÃO editar à mão. |
| [`tpu-store.ts`](../src/shared/tpu-store.ts) | Banco `paidegua.tpu`: seed idempotente + queries hierárquicas |
| [`tpu-categorias-julgamento.ts`](../src/shared/tpu-categorias-julgamento.ts) | Mapeamento semântico: códigos TPU → `TpuCategoria[]` |

### Camada do content script (`src/content/metas-cnj/`)

| Arquivo | Responsabilidade |
|---|---|
| [`abrir-metas-painel.ts`](../src/content/metas-cnj/abrir-metas-painel.ts) | Lista tarefas via gestao-bridge + dispara `METAS_OPEN_PAINEL` |
| [`metas-extractor.ts`](../src/content/metas-cnj/metas-extractor.ts) | `coletarDadosMetasDoProcesso()` — fetch SSR + parse via `criminal-extractor` |
| [`metas-coordinator.ts`](../src/content/metas-cnj/metas-coordinator.ts) | `varrerMetasCnj()` — pipeline tarefa-por-tarefa, processo-por-processo, com incremental |

### Background (`src/background/background.ts`)

Adições no FINAL do arquivo (minimiza conflito com sigcrim em paralelo):

- `handleOpenMetasPainel` — abre aba intermediária
- `handleMetasStartColeta` — dispatch ao content + reset de presença
- `handleMetasPrecisaFetch` — pergunta incremental
- `handleMetasUpsertProcesso` — upsert + reclassificação (status + metas)
- `rotearEventoMetas` — encaminha PROG/DONE/FAIL para a aba intermediária
- `handleMetasAplicarEtiquetas` — escolhe aba PJe e roteia para o aplicador (mesmo padrão do Perícias)

### Telas (`src/metas-painel/`, `src/metas-dashboard/`)

- `metas-painel/painel.{html,css,ts}` — aba intermediária: estados carregando → seletor → progresso → erro. Redireciona para o dashboard ao receber `METAS_COLETA_READY`.
- `metas-dashboard/dashboard.{html,css,ts}` — extension page que lê direto do IDB (mesma origem). Card por meta com `% cumprimento`, contadores, lista de pendentes ordenada por antiguidade, formulário aplicar etiqueta.

### Botão e wiring

- [`src/content/ui/sidebar.ts`](../src/content/ui/sidebar.ts) — botão "Controle Metas CNJ" no perfil Gestão (após Prazos na Fita)
- [`src/content/content.ts`](../src/content/content.ts) — `handleMetasCnj` (clique do botão), `handleMetasRunColeta` (recebe RUN_COLETA), handler de aplicar etiqueta

### Build

- [`webpack.config.js`](../webpack.config.js) — entries `metas-painel/painel` e `metas-dashboard/dashboard` + cópias HTML/CSS

### Constants e canais

[`src/shared/constants.ts`](../src/shared/constants.ts) — adições no FINAL dos blocos `MESSAGE_CHANNELS` e `STORAGE_KEYS`:

| Canal | Direção | Função |
|---|---|---|
| `METAS_OPEN_PAINEL` | content → bg | Abre aba intermediária |
| `METAS_START_COLETA` | painel → bg → content | Inicia varredura |
| `METAS_RUN_COLETA` | bg → content (PJe) | Dispara `varrerMetasCnj` |
| `paidegua/metas/precisa-fetch` | content → bg | Pergunta incremental (string literal — não está em MESSAGE_CHANNELS) |
| `METAS_UPSERT_PROCESSO` | content → bg | Upsert + reclassificação |
| `METAS_COLETA_PROG` | content → bg → painel | Linha de log |
| `METAS_COLETA_DONE` | content → bg → painel | Resumo final |
| `METAS_COLETA_READY` | bg → painel | Pronto para abrir dashboard |
| `METAS_COLETA_FAIL` | content → bg → painel | Erro |
| `METAS_APLICAR_ETIQUETAS` | dashboard → bg → content (PJe) | Aplica etiqueta em lote |
| `METAS_OVERRIDE_MANUAL` | dashboard → bg | (Reservado — handler ainda não implementado) |

`STORAGE_KEYS`:
- `METAS_PAINEL_STATE_PREFIX` = `paidegua.metas.painelState.`
- `METAS_PAINEL_ROUTE_PREFIX` = `paidegua.metas.painelRoute.`
- `METAS_TAREFAS_SELECIONADAS` = `paidegua.metas.tarefasSelecionadas`

---

## 7. Como rodar / como debugar

### Build e instalação

```bash
# Build
export PATH="/c/Users/vsousaesilva/Downloads/node-v24.14.1-win-x64 (1)/node-v24.14.1-win-x64:$PATH"
cd paidegua
npm run build

# Carregar
chrome://extensions/ → "Carregar sem compactação" → paidegua/dist
```

### Fluxo completo de teste

1. Abra o painel do PJe TRF5 logado.
2. Mude para perfil **Gestão** na barra do pAIdegua.
3. Clique em **Controle Metas CNJ**.
4. Aba intermediária abre — marque algumas tarefas com poucos processos (≤50) para o primeiro teste.
5. Clique **Iniciar varredura**. Acompanhe o log:
   - `Tarefa "X": listando processos...`
   - `Tarefa "X": N processo(s) encontrados.`
   - `Tarefa "X": K/N (...).`
6. Ao concluir, redireciona automaticamente para o dashboard.
7. Cards por meta aparecem com `0% cumprido` (esperado — sem listas elegíveis configuradas, ninguém enquadra).

### Inspeção do acervo via DevTools

```js
// No console do dashboard (extension page)
const db = await indexedDB.open('paidegua.metas-cnj');
// ou usar diretamente as funções do store:
const { listAllProcessos, getStats, loadConfig } = await import(
  chrome.runtime.getURL('shared/metas-cnj-store.js')
);
console.table(await listAllProcessos());
console.log(await getStats());
console.log(await loadConfig());
```

### Edição emergencial de config (até a tela de configuração existir)

```js
// No console do dashboard
const { saveConfig, loadConfig } = await import(chrome.runtime.getURL('shared/metas-cnj-store.js'));
const cfg = await loadConfig();
cfg.metas['meta-4'].classesElegiveis = ['APN', 'ProcAd', 'AcrPen'];
cfg.metas['meta-4'].assuntosElegiveis = ['Improbidade Administrativa', 'Crimes contra a Administração'];
await saveConfig(cfg);
location.reload();
```

### Reset do acervo

```js
const { apagarAcervo } = await import(chrome.runtime.getURL('shared/metas-cnj-store.js'));
await apagarAcervo({ manterConfig: true });
```

---

## 8. Limitações conhecidas (V1)

1. **Listas vazias por padrão** — Meta 4/6/7/10 não enquadram ninguém até o usuário configurar `classesElegiveis` e/ou `assuntosElegiveis`. Bloqueio crítico para entrega.
2. **Sem tela de configuração** — config tem que ser editada via console (snippet acima). Próxima iteração.
3. **Sem override manual na UI** — funções existem (`setOverrideMeta`, `setCampoManual`), botões não.
4. **Varredura sequencial** — sem pool concorrente. Em tarefa com 500+ processos novos, pode levar minutos. Solução conhecida: importar o padrão do prazos-fita-coordinator.
5. **Sem checkpoint/retomada** — fechar a aba PJe no meio perde o progresso. Acervo preserva o que foi capturado, mas a varredura recomeça do zero.
6. **Cartões informativos das metas 1/3/5/9** ausentes do dashboard.
7. **Sumiço sem reclassificação** — processos que sumiram da varredura ficam com `presente_ultima_varredura: false` mas não sofrem reclassificação automática. Implementar varredura final que aplica detector com `sumiuDaVarredura: true` aos sumidos.
8. **Conflito de merge esperado com sigcrim** — `constants.ts`, `content.ts`, `background.ts`, `sidebar.ts`, `webpack.config.js` foram tocados pelos dois trilhos. Como adicionei tudo no fim dos blocos, deve ser resolvível, mas não trivial.

---

## 9. Pendências em ordem de prioridade

### P0 — Bloqueios para entrega real
1. **Listas oficiais de classes/assuntos por meta** (precisa validação do usuário, conforme §10).
2. **Tela `metas-config`** — edição visual da config (datas de corte, listas elegíveis, etiquetas sugeridas, cartões 1/3/5/9). Sem isso, a operação real depende do console.
3. **Reclassificação dos sumidos** — laço final na varredura que itera processos com `presente_ultima_varredura: false`, roda detector com `sumiuDaVarredura: true` e atualiza status (deve usar regra `inferido_sumico`).

### P1 — Robustez operacional
4. **Pool concorrente** no `varrerMetasCnj` — copiar padrão do `prazos-fita-coordinator` (concorrência 25, refresh em 403).
5. **Checkpoint/retomada** — espelhar `prazos-fita-scan-state.ts` para o módulo de Metas.
6. **Override manual no dashboard** — botão "marcar como julgado" / "excluir desta meta" / "incluir nesta meta" por processo.

### P2 — Funcionalidades de gestão
7. **Cartões informativos** das metas 1/3/5/9 (entrada manual com data de apuração).
8. **Filtros adicionais** no dashboard (por classe, por ano, por órgão julgador).
9. **Export/import do acervo** — análogo ao do sigcrim. Útil para backup e transferência entre servidores.
10. **Visão "histórico de varreduras"** — comparar duas datas e mostrar deltas.

### P3 — Evoluções de visualização
11. **Linha do tempo** do processo (consumindo categorias TPU) — feature transversal já discutida.
12. **Gráficos de evolução** — % cumprimento ao longo das varreduras.
13. **Distribuição de seed por tribunal** — `tpu-seed-trf1.ts`, etc., quando a extensão for a outras seções da JF.

---

## 10. Decisões abertas — esperando validação

Listadas aqui para não se perderem. **Nenhuma é bloqueio para o build, mas todas são bloqueio para a operação real.**

### 10.1 Listas oficiais por meta (P0)

A configuração default está com listas vazias. Preciso confirmar com você:

- **Meta 4 — Improbidade + Crimes Adm. Pública**:
  - Classes (sigla PJe): candidatas iniciais APN, ProcAd, ImpAdm, AcrPen — confirmar contra catálogo de classes da JFCE.
  - Assuntos (substrings CNJ): "Improbidade Administrativa", "Crimes contra a Administração Pública" — refinar.
  - Data de corte: padrão `2023-12-31` (do texto da meta).

- **Meta 6 — Ambientais**:
  - Classes: tipicamente Procedimento Comum + assuntos ambientais; ou ações ambientais específicas (ACP, MS, ANP).
  - Assuntos: lista CNJ de "Direito Ambiental" — confirmar quais subcategorias entram.
  - Data de corte: `2025-12-31`.

- **Meta 7 — Indígenas / Quilombolas / Racismo**:
  - Assuntos: "Direito das Comunidades Indígenas" / "Quilombolas" / "Racismo" / "Injúria Racial" — confirmar nomenclatura usada pelo PJe TRF5.
  - Texto da meta separa em 3 percentuais (35% / 35% / 50%); na implementação atual estão fundidos em uma só meta. Decidir se queremos sub-metas separadas ou tudo junto.

- **Meta 10 — Subtração Internacional**:
  - Assunto: "Subtração Internacional de Crianças" (CNJ) — confirmar nomenclatura exata.

### 10.2 Tarefas que indicam julgado/baixado

Default em `defaultMetasCnjConfig`:
- `tarefasIndicamJulgado`: `'cumprimento de sentença'`, `'execução'`, `'liquidação'`, `'aguardando trânsito'`, `'apelação'`, `'recursos'`, `'embargos de declaração'`, `'recurso especial'`, `'recurso extraordinário'`
- `tarefasIndicamBaixa`: `'arquivar definitivamente'`, `'baixa definitiva'`

Confirmar se cobre as nomenclaturas usadas na JFCE ou se precisa adicionar/retirar.

### 10.3 Tipos de documento que comprovam julgamento (regra 1B)

Default: `documentosTiposPositivos = ['Sentença', 'Acórdão']`. Na conversa de gênese ficou acordado **focar em "Sentença"** (1º grau) — Acórdão fora para evitar confusão com migrados que tiveram recurso. Decidir: removo "Acórdão" do default?

### 10.4 Foco da Meta 2

A meta CNJ tem 3 faixas (15 anos / 31/12/2022 / JEF até 31/12/2023). Implementação atual usa **uma data de corte por meta** (default 2011-12-31). O usuário precisa configurar conforme o tipo de vara (JEF vs comum). Decidir: oferecemos sub-metas separadas para cada faixa?

---

## 11. Cronologia da gênese (resumo da conversa)

A construção foi resultado de uma conversa longa que vale resumir para reconstruir o porquê das decisões.

1. **Avaliação inicial**: 3 features pediram análise paralela (Central de Comunicação, Controle Metas CNJ, Audiência pAIdegua) frente ao trilho Sigcrim em paralelo. Decisão: começar pelo **Controle Metas CNJ** porque era a feature de **menor atrito** com o sigcrim (perfil Gestão, área diferente do sidebar Secretaria que o sigcrim modifica).

2. **Análise das Metas Nacionais 2026**: das 10 metas, 5 são mensuráveis para JF 1G (2/4/6/7/10), 3 são informativas (1/3/5), 2 não se aplicam (8/9). TRF5 = Faixa 2 nas metas 6/7.

3. **Persistência durável** (acervo) decidida cedo — usuário enfatizou que a varredura é semanal/mensal, não a cada acesso. Modelo do sigcrim foi adotado como referência.

4. **Modelo de status**: discussão longa convergiu para "zero ação manual no caminho feliz". Hierarquia: movimento oficial > documento anexo > tarefa atual indireta > sumiço inferido > default. Override manual sempre vence.

5. **Tabela TPU**: o usuário pediu para extrair os 677 movimentos do PJe e embarcar como asset reusável (não só para Metas — também para Sigcrim, Audiência pAIdegua, futuras features de timeline). Extração one-shot via console JS, builder Node, seed embarcado. Documento próprio: [`extracao-tpu-pje.md`](./extracao-tpu-pje.md).

6. **Bancos separados**: TPU, Metas, Criminal — cada um seu IndexedDB. Export/import por banco para backup independente.

7. **Filtragem incremental** via `ultimo_movimento_visto`: discutida e implementada para evitar refazer fetch profundo quando nada mudou.

8. **Para processos migrados** (sem histórico de movimentos): o usuário ofereceu a regra "se há documento anexo do tipo Sentença/Acórdão, considera julgado" — implementada como regra 1B do detector com filtro de ruído (`minuta`, `embargos`, `anexo`).

9. **Listas elegíveis em aberto**: o usuário se comprometeu a passar as listas oficiais por meta. Default ficou com listas vazias para não enquadrar erroneamente.

---

## 12. Convenções de código herdadas

- Padrão de banco IndexedDB (open/withTx/reqAsPromise) — adotado de [`criminal-store.ts`](../src/shared/criminal-store.ts).
- Padrão de upsert preservando origem `manual` — adotado de [`upsertProcessoFromPje`](../src/shared/criminal-store.ts).
- Padrão de canais MESSAGE_CHANNELS / STORAGE_KEYS — segue convenção `paidegua/<dominio>/<acao>`.
- Padrão de aba intermediária + dashboard — adotado do Painel Gerencial / Prazos na Fita.
- Padrão de aplicador de etiqueta — reuso direto de [`pericias-etiqueta-applier.ts`](../src/content/pericias/pericias-etiqueta-applier.ts).
- Adições nos arquivos compartilhados (constants/content/background/sidebar/webpack) sempre **no final** dos blocos para minimizar conflito de merge com features paralelas.

---

## 13. Referências internas

- Tipos:                    [`src/shared/metas-cnj-types.ts`](../src/shared/metas-cnj-types.ts)
- Banco do acervo:          [`src/shared/metas-cnj-store.ts`](../src/shared/metas-cnj-store.ts)
- Aplicador de regras:      [`src/shared/metas-cnj-regras.ts`](../src/shared/metas-cnj-regras.ts)
- Detector de status:       [`src/shared/processo-status-detector.ts`](../src/shared/processo-status-detector.ts)
- TPU (catálogo):           [`src/shared/tpu-types.ts`](../src/shared/tpu-types.ts), [`src/shared/tpu-seed-data.ts`](../src/shared/tpu-seed-data.ts), [`src/shared/tpu-store.ts`](../src/shared/tpu-store.ts)
- Categorias de julgamento: [`src/shared/tpu-categorias-julgamento.ts`](../src/shared/tpu-categorias-julgamento.ts)
- Coordinator (content):    [`src/content/metas-cnj/metas-coordinator.ts`](../src/content/metas-cnj/metas-coordinator.ts)
- Extractor (content):      [`src/content/metas-cnj/metas-extractor.ts`](../src/content/metas-cnj/metas-extractor.ts)
- Abridor (content):        [`src/content/metas-cnj/abrir-metas-painel.ts`](../src/content/metas-cnj/abrir-metas-painel.ts)
- Aba intermediária:        [`src/metas-painel/`](../src/metas-painel/)
- Dashboard:                [`src/metas-dashboard/`](../src/metas-dashboard/)
- Documentação TPU:         [`docs/extracao-tpu-pje.md`](./extracao-tpu-pje.md)
- Builder TPU:              [`scripts/build-tpu-seed.mjs`](../scripts/build-tpu-seed.mjs)
- Padrão de varredura:      [`docs/extracao-tarefas-painel-pje.md`](./extracao-tarefas-painel-pje.md)
- Pool concorrente alvo:    [`docs/arquitetura-coleta-prazos-na-fita.md`](./arquitetura-coleta-prazos-na-fita.md)
