# Telemetria local e plano de escala até 50k processos

Este documento descreve (a) o plano de providências para operar o paidegua com risco mínimo em unidades com 10k–50k processos e (b) o subsistema de telemetria local que foi entregue como **Fase 0** desse plano, junto com (c) o estado atual da **Fase 1**.

## 1. Plano de providências por fases

O diagnóstico completo está em [arquitetura-coleta-prazos-na-fita.md](arquitetura-coleta-prazos-na-fita.md). O resumo das ações para atender unidades grandes:

| Fase | Objetivo | Arquivos envolvidos | Entrega |
|---|---|---|---|
| **0** | Observabilidade local das varreduras | [`src/shared/telemetry.ts`](../src/shared/telemetry.ts), [`src/diagnostico/`](../src/diagnostico) | **concluída** |
| **1** | Painel Gerencial via API REST com fallback para DOM | [`src/content/gestao/triagem-from-api.ts`](../src/content/gestao/triagem-from-api.ts), [`src/content/gestao/gestao-bridge.ts`](../src/content/gestao/gestao-bridge.ts) | **concluída** |
| 2 | Estabilidade em coletas longas (heartbeat anti-suspensão, concorrência adaptativa, aviso de ETA) | a definir | pendente |
| 3 | Render e export para 50k linhas (virtualização, export em streaming) | a definir | pendente |
| 4 | LLM robusto em unidades grandes (resumo estatístico pré-LLM, amostragem) | a definir | pendente |
| 5 | Polimento operacional (pré-flight de tamanho, dedup em memória, GC de checkpoints) | a definir | pendente |

Princípios de isolamento aplicados em todas as fases:

- Mudanças **aditivas**, em arquivos novos sempre que possível.
- Caminhos antigos **permanecem** acessíveis como fallback.
- **Feature flags** e `try/catch` silencioso onde há risco de regressão.
- Telemetria nunca interrompe a coleta — se o storage falhar, a varredura continua.

## 2. Fase 0 — Telemetria local

### 2.1. Por que

Sem medição, as próximas fases são chute. Precisamos saber, por varredura real de cada unidade:

- Qual caminho foi usado (REST ou fallback DOM).
- Quanto tempo cada fase levou.
- Quantos processos foram lidos, omitidos, falharam.
- Se o token Keycloak expirou e se a retomada foi usada.

Tudo **fica no navegador do usuário** (`chrome.storage.local`) e nunca é enviado a nenhum servidor. Não há PII registrada — apenas métricas e nomes de tarefas.

### 2.2. O que foi entregue

- [`src/shared/telemetry.ts`](../src/shared/telemetry.ts) — API standalone:
  - `startScan(kind, meta)` abre uma varredura.
  - `scan.phase(nome)` devolve um `end(extra?)` para marcar duração de fase.
  - `scan.counter(nome, delta?)` incrementa contadores nomeados.
  - `scan.mergeMeta(partial)` adiciona campos à descrição da varredura.
  - `scan.success()` / `scan.fail(err)` / `scan.cancel(reason)` encerram.
  - `listRecentScans()` / `clearScans()` para consulta/limpeza.
  - **Buffer circular de 30 varreduras**; persistência `last-write-wins`.
  - **Nunca lança**: todos os métodos tratam erro internamente.

- Página [`src/diagnostico/`](../src/diagnostico) acessível em `chrome-extension://<id>/diagnostico/diagnostico.html`:
  - Resumo (total, sucessos, erros, quantas caíram em fallback DOM).
  - Cartão por varredura com fases + contadores + meta.
  - Botões "Atualizar" e "Limpar histórico" (com confirmação).
  - Link "Diagnóstico" adicionado ao rodapé do popup da extensão.

- Pontos instrumentados:
  - [`triagem-from-api.ts`](../src/content/gestao/triagem-from-api.ts) — rota REST do Painel Gerencial. Fases `listar:<tarefa>` e `resolver-ca:<tarefa>`, contadores `processos-listados`, `processos-omitidos`, `ca-erros`.
  - [`gestao-bridge.ts`](../src/content/gestao/gestao-bridge.ts) — ponto de decisão REST↔DOM. Marca `meta.viaUsada` (`rest`, `dom-top`, `dom-iframe`), contadores `fallback-dom`, `tarefas-truncadas`.
  - [`prazos-fita-coordinator.ts`](../src/content/gestao/prazos-fita-coordinator.ts) — Prazos na Fita via API. Fases `listar-tarefas` e `fetch-expedientes`, contadores `auth-expired`, `retomada`, `tarefas-listar-erro`. *Obs.: o contador `ca-cache-hits` existia até 2026-04-20 e foi removido junto com o cache persistente de `ca` (ver [arquitetura §4.1](arquitetura-coleta-prazos-na-fita.md#41-cache-persistente-de-ca--removido-abril2026) e [post-mortem §8](post-mortem-prazos-na-fita.md#8-regressão-de-2026-04-20--cache-de-ca-envenenado)).*

### 2.3. Como consultar

Ação do usuário:

1. Clicar no ícone do pAIdegua → rodapé do popup → link **Diagnóstico**.
2. A aba aberta mostra as 30 últimas varreduras, mais recentes em cima.
3. Cada cartão traz kind, status, duração total, fases com tempo e contadores relevantes.
4. Dado sensível **não** aparece — só nomes de tarefa, contagens e durações.

Para limpar manualmente, o botão "Limpar histórico" apaga `paidegua.telemetry.scans` do `chrome.storage.local`.

### 2.4. Privacidade e conformidade

- A telemetria é **apenas local**. Nenhum dado sai do navegador.
- Não há números de processo, nomes de partes, CPFs ou conteúdo de autos.
- O campo `meta.nomes` contém apenas os rótulos das tarefas do PJe (públicos, por natureza).
- A janela de retenção é curta (buffer de 30 varreduras, aproximadamente alguns dias de uso).
- Compatível com a postura LGPD já estabelecida para o Painel Gerencial (ver [`gestao-indexed-storage.ts`](../src/shared/gestao-indexed-storage.ts)).

## 3. Fase 1 — Painel Gerencial via API REST

### 3.1. O que existia antes

O Painel Gerencial coletava cartões por DOM scraping do painel Angular do PJe, com teto rígido de 50 páginas por tarefa. Em tarefas com mais de ~2.500 processos, o coletor marcava `truncado=true` e seguia, mas não havia alternativa — o usuário perdia os processos acima do teto.

### 3.2. O que está em produção agora

- [`coletarSnapshotsViaAPI`](../src/content/gestao/triagem-from-api.ts) é a rota **preferida**. Usa `recuperarProcessosTarefaPendenteComCriterios` (REST) com `pageSize=1000` e limite interno de 200 páginas (= até 200k processos por tarefa). Resolve `ca` em pool de até 10 workers.
- [`coletarTarefasSelecionadas`](../src/content/gestao/gestao-bridge.ts) tenta REST primeiro; se `ok=false` ou exceção, cai para o caminho DOM histórico sem intervenção do usuário. O dashboard continua exibindo o aviso amarelo de truncamento quando o DOM trunca.
- A telemetria registra qual via foi efetivamente usada em `meta.viaUsada`, permitindo observar em produção quando o fallback DOM é acionado e por quê (`meta.restError`).

### 3.3. O que ainda não foi feito nesta fase

- Pré-flight de tamanho (mostrar ao usuário uma estimativa de duração antes de iniciar) fica para a Fase 2.
- Concorrência adaptativa (AIMD em cima do pool de `ca`) também fica para a Fase 2.
- Eliminar o cap de 50 páginas do DOM só faz sentido se o fallback virar caminho principal, o que não é o plano.

## 4. Como validar localmente

Dependências de build:

```bash
export PATH="/c/Users/vsousaesilva/Downloads/node-v24.14.1-win-x64 (1)/node-v24.14.1-win-x64:$PATH"
npm run typecheck
npm run build
```

Uma vez gerado o `dist/`:

1. Carregar a extensão via `chrome://extensions/` → **Carregar sem compactação** → apontar para `dist/`.
2. Abrir o painel do PJe, fazer uma coleta do Painel Gerencial ou Prazos na Fita.
3. Clicar no ícone da extensão → rodapé → **Diagnóstico**.
4. Verificar a varredura mais recente no topo da página.

Para testar o fallback REST → DOM, basta forçar um erro na rota REST (por exemplo, fechar a aba do PJe no meio de uma varredura); o cartão de diagnóstico registra `counters.fallback-dom = 1` e `meta.viaUsada = "dom-top"` ou `"dom-iframe"`.

## 5. Próximos passos recomendados

Após rodar a telemetria em uma amostra de unidades de diferentes tamanhos, os dados vão indicar qual gargalo morde primeiro. A ordem sugerida é:

1. Analisar por ~1 semana os cartões de diagnóstico de 3-5 unidades de tamanhos diferentes.
2. Priorizar Fase 2 ou Fase 3 conforme o dado mostrar (tempo total vs. render travando).
3. Manter Fases 4 e 5 para depois da estabilização.
