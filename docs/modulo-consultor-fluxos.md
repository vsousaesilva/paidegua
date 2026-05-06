# Módulo "Consultor de fluxos" — pAIdegua v1.4.0 (em desenvolvimento)

Integração do trabalho de mapeamento dos fluxos jBPM do PJe (210 XMLs em `fluxos-pje/`) ao pAIdegua, na forma de uma aba dedicada **"Consultor de fluxos"**.

## Para que serve

Tirar dúvidas sobre como o processo caminha no PJe — entradas, saídas, decisões, caminhos entre tarefas. Atende prioritariamente o **usuário final** (servidor / magistrado) com chat conversacional, e secundariamente os **devs de fluxos** com rastreabilidade reversa e detalhamento estrutural.

Não decide e não publica fluxos. Apenas **revela e explica**.

## Arquitetura

```
fluxos-pje/                                ← projeto irmão
├── *.xml                                   210 XMLs jPDL coletados
├── scripts/
│   ├── parser-jpdl.mjs                     parser → catálogo embarcado
│   ├── heuristicas.mjs                     classificação por lane / fase
│   └── package.json                        dep: fast-xml-parser
└── grafo.json                              grafo dirigido das chamadas

paidegua/
├── assets/fluxos-catalogo.json             ← gerado pelo parser, embarcado
├── src/
│   ├── shared/
│   │   ├── fluxos-types.ts                 schema canônico
│   │   ├── fluxos-store.ts                 loader (fetch sobre runtime.getURL)
│   │   ├── fluxos-grafo.ts                 BFS, DFS, vizinhos, hubs, mermaid
│   │   ├── fluxos-search.ts                busca textual local (sem dep)
│   │   └── fluxos-prompts.ts               system prompt + quick actions
│   ├── content/
│   │   └── fluxos/
│   │       └── fluxos-coordinator.ts       chama background pra abrir aba
│   └── fluxos-consultor/                   ← nova página (entry webpack)
│       ├── consultor.html
│       ├── consultor.css
│       └── consultor.ts                    orquestra UI + chat + mermaid
```

### Pontos de integração no código existente

| Arquivo | O que mudou |
|---------|-------------|
| `src/shared/types.ts` | + `ChatStartPayload.systemPromptOverride` |
| `src/shared/constants.ts` | + `MESSAGE_CHANNELS.FLUXOS_OPEN_CONSULTOR` |
| `src/background/background.ts` | + `case FLUXOS_OPEN_CONSULTOR` no switch · `handleOpenFluxosConsultor()` · uso de `systemPromptOverride` em `handleChatStart` |
| `src/content/ui/sidebar.ts` | + botão "Consultor de fluxos" (sem `data-profile-section`) · `consultorFluxosButton` em `SidebarElements` |
| `src/content/content.ts` | + import `abrirConsultorFluxos` · listener `consultorFluxosButton.click` · `handleConsultorFluxos()` |
| `webpack.config.js` | + entry `fluxos-consultor/consultor` · 3 copy patterns (HTML, CSS, JSON do catálogo) |
| `package.json` | + dependência `mermaid: ^11.4.0` (lazy-loaded, code-split) |

## Como ativar (passo a passo — CMD com Node portátil)

> Pré-requisito: Node portátil em `Claude JF\Nodej\node-v24.14.1-win-x64\` (mesmo que `paidegua\env.bat` espera). Caminho relativo a partir das pastas: `paidegua\` usa `..\Nodej`, `fluxos-pje\scripts\` usa `..\..\Nodej`. Os `.bat` calculam isso sozinhos.

### 1. Gerar o catálogo embarcado

Duplo-clique em `Claude JF\fluxos-pje\scripts\gerar-catalogo.bat`, ou via CMD:

```cmd
cd /d "Claude JF\fluxos-pje\scripts"
gerar-catalogo.bat
```

O `.bat` chama `env.bat` local (Node portátil), faz `npm install` se necessário e roda o parser. Saídas:
- `paidegua\assets\fluxos-catalogo.json` ← **embarcado no build da extensão**
- `fluxos-pje\grafo.json` ← grafo dirigido (análise)
- `fluxos-pje\analise-topologica.md` ← relatório institucional

### 2. Instalar `mermaid` no pAIdegua

```cmd
cd /d "Claude JF\paidegua"
install.bat
```

(O `install.bat` do paidegua chama `env.bat` e faz `npm install` — já vai pegar o `mermaid` adicionado em `package.json`.)

### 3. Build do pAIdegua

```cmd
cd /d "Claude JF\paidegua"
build.bat
```

O `build.bat` faz `typecheck` (`tsc --noEmit`) e em seguida `webpack --mode production`. Se o typecheck passar, o `dist\` é gerado pronto pra carregar.

### 4. Carregar a extensão

`edge://extensions/` → Modo desenvolvedor → **Carregar sem compactação** apontando para `Claude JF\paidegua\dist\`.

Se já estava instalada: botão **Recarregar** na entrada da extensão.

### 5. (opcional) Sincronizar Kanban

Se você quiser refletir os 6 cards `FLUX-01..06` no quadro Kanban online:

```cmd
cd /d "Claude JF\paidegua\docs\kanban-massificacao"
call ..\..\..\fluxos-pje\scripts\env.bat
node scripts\sync-board-from-seed.mjs
rem ↑ gera scripts\board-after-sync.json
rem  então:
wrangler kv key put "board:state" --path=scripts\board-after-sync.json --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote
```

(Faça backup antes — `wrangler kv key get "board:state" --namespace-id=... --remote > scripts\board-backup-AAAA-MM-DD.json` — porque o sync sobrescreve movimentações feitas via UI desde a última sincronização. Ver `docs\kanban-massificacao\scripts\sync-board-from-seed.mjs` para detalhes.)

### 5. Usar

1. Abra qualquer página `*.jus.br` do PJe.
2. Abra o sidebar do pAIdegua (botão flutuante azul).
3. Role a toolbar até a seção **"Conhecimento"** — botão **"Consultor de fluxos"**.
4. Clique. Abre nova aba `fluxos-consultor/consultor.html`.
5. Use as quick actions à esquerda ou digite uma pergunta.

## Comportamento esperado

- **Pergunta de visão geral** ("como funciona o fluxo do JEF?") → o consultor explica em PT-BR formal, citando códigos `JEF_*`.
- **Pergunta de caminho** ("do despacho até o trânsito em julgado nos JEF") → orquestrador detecta dois códigos compatíveis no grafo, **renderiza Mermaid lateralmente ANTES da resposta** do LLM (heurística determinística), e o LLM narra o caminho cobrindo cada nó.
- **Detalhe de fluxo** ("explique `JEF_OPPER`") → resposta com tarefas, decisões, transições e subfluxos chamados.
- **Rastreabilidade reversa** ("quem chama `JEF_ANSECR`?") → lista os fluxos que o referenciam.

## Catálogo: schema resumido

Ver [`paidegua/src/shared/fluxos-types.ts`](../src/shared/fluxos-types.ts) para o tipo TS completo. Em runtime:

```typescript
const cat = await getCatalogo();
// cat.fluxos: FluxoEntrada[]  (210 itens, ~600 KB)
// cat.versao, cat.geradoEm, cat.totalFluxos
```

## Atualização do catálogo

O catálogo é **embarcado**. Para refletir novos fluxos publicados na base:

1. Rodar o coletor (extensão `fluxos-pje/extensao-coletor/` ou script de console) para baixar os XMLs novos.
2. Substituir `fluxos-pje/*.xml`.
3. Rerodar `npm run build:catalogo`.
4. Rerodar `npm run build` no pAIdegua.
5. Distribuir nova versão da extensão.

Cadência sugerida: trimestral, ou disparado por release de fluxos pela SETIC.

## Conformidade LGPD / CNJ 615

- O catálogo NÃO contém dados de processos. Apenas metadata estrutural (códigos, nomes, swimlanes, decisões EL/SQL).
- O chat usa o mesmo provider já configurado pelo usuário (Anthropic / OpenAI / Gemini), com chave do próprio usuário.
- Sem PII transmitida. Sem necessidade de anonimização.
- O `FLUXOS_SYSTEM_PROMPT` orienta o LLM a recusar dados sensíveis.
- Classificação CNJ 615/2025: continua **BR4 (apoio à produção textual)**, sem categoria nova.

## Modo dual — "Para o usuário" × "Para o desenvolvedor"

A página tem um seletor no header (radiogroup com dois pills) que troca o comportamento do consultor entre dois perfis:

| Aspecto | **Para o usuário** (default) | **Para o desenvolvedor** |
|---------|------------------------------|--------------------------|
| Vocabulário | PT-BR fluido, sem siglas, sem códigos | técnico — códigos jBPM entre crases, EL/SQL, swimlanes, transições |
| System prompt | `FLUXOS_SYSTEM_PROMPT_USUARIO` (orientação para esconder códigos e usar nomes legíveis) | `FLUXOS_SYSTEM_PROMPT_DEV` (atual, técnico) |
| Quick actions | 6 em linguagem comum: "Como o processo caminha", "O que significa esta etapa?", "Por que está parado?", "O que vem depois?", "Como termina?" | 6 técnicas: "Visão geral", "Caminho entre fluxos", "Detalhe de um fluxo", "Quem chama este fluxo?", "Pontos de entrada/saída" |
| Resumo no system prompt | `getResumoParaPromptUsuario()` — nomes humanizados (sem `[JEF]`, sem underscores), descreve transições como "daqui costuma seguir para…" | `getResumoParaPrompt()` — código + lane + fase + sub-chamadas |
| Busca lateral | só nome legível, clique gera prompt natural ("Em linguagem simples, me explique…") | código + nome, clique gera prompt técnico (`Explique em detalhe o fluxo \`JEF_OPPER\``) |
| Mermaid renderizado | nó = nome legível só, sem cor por lane | nó = código + nome + lane com cor por pista (azul JEF, amarelo EF, índigo Comum, verde Shared) |
| Mensagem de boas-vindas | "Sou o consultor de tramitação do PJe…" | "Sou o consultor de fluxos do PJe…" |

**Persistência:** preferência salva em `chrome.storage.local` sob `STORAGE_KEYS.FLUXOS_MODO`. Default na primeira abertura = `'usuario'`.

**Troca de modo reinicia a conversa.** Necessário para coerência — o LLM precisa começar com o system prompt novo, senão fica falando metade técnico, metade humano.

Helpers exportados em `src/shared/fluxos-prompts.ts`:
- `getSystemPrompt(modo)`
- `getQuickActions(modo)`
- `getMensagemBoasVindas(modo)`
- `getNomeModo(modo)` / `getSubtituloModo(modo)`

## Layout com scroll interno

A página agora ocupa exatamente `100vh` e nunca rola para baixo. Cada coluna tem scroll próprio:

- `html, body` — `height: 100vh; overflow: hidden`
- `.layout` (grid 3 colunas) — `overflow: hidden`
- `.sidebar`, `.chat-area`, `.diagram-area` — `flex column; min-height: 0; overflow: hidden`
- Dentro da sidebar:
  - `.quick-list` — `max-height: 240px` + `overflow-y: auto`
  - `.busca-list` — `flex: 1` + `overflow-y: auto`
- `.chat-log` — `flex: 1` + `overflow-y: auto`
- `.diagram-host` — `flex: 1` + `overflow: auto`

Scrollbars customizadas (6 px, azul translúcido). Em telas ≤880 px, o seletor de modo quebra para a 2ª linha do header. Em telas ≤760 px, layout vira 1 coluna com 3 linhas.

## Encoding dos XMLs (resolvido)

**Sintoma original:** acentos quebrados na UI ("AnÃ¡lise", "NÃ³ de Desvio").

**Causa raiz:** os XMLs do `fluxos-pje/` declaram `encoding="ISO-8859-1"` no prólogo, mas o coletor JSZip salva strings como **UTF-8** por padrão. O parser jPDL lia como `'latin1'`, gerando double-encoding (cada byte UTF-8 virava um caractere Unicode separado e era reescrito como UTF-8 multi-byte no JSON final).

**Fix:** `parser-jpdl.mjs` — `await readFile(path, 'utf8')`. Comentário explicativo no código.

**Necessário após o fix:** rerodar `gerar-catalogo.bat` para regenerar `paidegua/assets/fluxos-catalogo.json`, depois `build.bat` no paidegua para entrar no `dist/`.

## Próximos passos sugeridos

| Sprint | Conteúdo | Card |
|--------|----------|------|
| Sprint 1 (concluída) | Parser, módulo, integração, build configurável | FLUX-01, FLUX-02 |
| Sprint 1.5 (concluída) | Modo dual + scroll interno + fix UTF-8 + fixes typecheck/CMD | FLUX-07 |
| Sprint 2 | Validação institucional com 3 servidores (1 por lane) — refinar `lane`/`fase` no `catalogo.json` (passar `faseOrigem` para `manual`) | FLUX-03 |
| Sprint 3 | Detector contextual: bubble proativa "Quer entender este fluxo?" quando o usuário estiver em tela de tarefa do PJe | FLUX-04 |
| Sprint 4 | Cache de Q&A frequentes; métricas opt-in de uso | FLUX-05 |
| Futuro | Migrar catálogo para Cloudflare Worker se cadência de mudanças justificar | FLUX-06 |

## Riscos conhecidos

1. **2 fluxos faltam no catálogo** (`JEF_ANSECR`, `JEF_TRIAGIN`) — falharam na coleta. Ver `fluxos-pje/FALHAS-ANALISE.md`.
2. **210 vs 212**: heurística de fase pode errar até ~15% — esperado. Validação humana corrige.
3. **Mermaid pesa ~280 KB no chunk lazy** — só carrega quando o usuário pede um diagrama. OK.
4. **System prompt + catálogo resumo ~30 KB tokens**. Cada conversa custa um pouco mais que uma sessão normal — aceitável para o caso de uso.
