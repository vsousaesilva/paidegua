# Investigação — Gemini: falhas silenciosas e cotas de Nível 1

**Datas:** 2026-06-13 a 2026-06-19  
**Funcionalidades afetadas:** Resumir e Gerar Minuta (chat via `CHAT_STREAM`) com provedor Google Gemini  
**Status:** Parcialmente resolvido — raiz identificada (cota de Nível 1), comportamento alterado para visível; decisão sobre ferramentas de diagnóstico pendente

---

## 1. Sumário executivo

Usuária Danielle reportou que o Resumir com gemini-2.5-flash não produzia saída e não exibia nenhuma mensagem de erro. Investigação revelou **dois problemas independentes**, em camadas diferentes:

1. **Bug de código** — `thinkingConfig` ausente causava travamento silencioso nos modelos Flash.
2. **Limite de infraestrutura** — chaves de API de Nível 1 (Google AI Studio gratuito/básico) têm cota de 1 M tokens/min. Processos com muitos documentos ultrapassam esse limite a meio do stream; o servidor fecha a conexão sem enviar `finishReason`, o código tratava como sucesso silencioso.

Além disso, foram identificados dois bugs de parsing adicionais durante a investigação.

---

## 2. Contexto técnico: como o Gemini é consumido

O pAIdegua usa o endpoint de streaming SSE da API Gemini:

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={API_KEY}
```

A chave de API vai como query param `?key=`. A resposta é uma stream de eventos SSE, cada um contendo um JSON com `candidates[0].content.parts` (texto gerado) e, no evento final, `candidates[0].finishReason` (`"STOP"` para conclusão normal).

O pipeline no service worker é:
```
handleChatStart → provider.sendMessage → fetchWithRetry → parseSseStream → yield chunks → port.postMessage(CHUNK) → UI
```

O `sendMessage` do Gemini é um async generator com `try/catch/finally`. O `finally` registra métricas de uso em `chrome.storage.local`.

---

## 3. Bug 1 — `thinkingConfig` ausente (gemini-2.5-flash travava)

### Sintoma
Danielle clicava em Resumir com gemini-2.5-flash. Nada aparecia na tela. Nenhuma mensagem de erro. A extensão parecia congelada por 30–60 segundos.

### Causa raiz
Os modelos Gemini Flash têm um modo de "pensamento interno" (thinking mode) que pode consumir dezenas de segundos processando antes de emitir o primeiro token visível. Sem o parâmetro `thinkingConfig: { thinkingBudget: 0 }` na requisição, o modelo ficava "pensando" silenciosamente.

O parâmetro havia sido removido em algum momento anterior à investigação.

### Correção aplicada (revisada em 2026-06-23)
Em `src/background/providers/gemini.ts`, função `buildThinkingConfig(model)`:

- Flash-Lite: `thinkingBudget: 0` (desabilita thinking)
- Gemini 2.5 Flash não-lite: `thinkingBudget: 0` (aceito segundo Firebase docs)
- Gemini 2.5 Pro: `thinkingBudget: -1` (dinâmico, não aceita 0)
- Gemini 3.x Flash: `thinkingLevel: 'MINIMAL'` (API thinkingLevel, não thinkingBudget)
- Gemini 3.x Pro: `thinkingLevel: 'LOW'` (MINIMAL não suportado em Pro)

**Nota:** a regex original `/flash/i` enviava `thinkingBudget: 0` para gemini-3-flash-preview, que usa a API thinkingLevel e rejeita thinkingBudget. Esse era o erro "Budget 0 is invalid". A correção de 2026-06-19 usou `/flash-lite/i` (correta para o problema, mas insuficiente: modelos 2.5/3.5 sem nenhum thinkingConfig passaram a consumir todos os maxOutputTokens em tokens de raciocínio, gerando respostas vazias silenciosas).

### Resultado
gemini-2.5-flash passou a responder normalmente.

---

## 4. Bug 2 — Tokens de raciocínio (`thought: true`) exibidos como texto

### Sintoma
Modelos com thinking mode ativo (quando `thinkingBudget` não é 0 ou não é suportado) emitem partes do JSON com `"thought": true`. Esses tokens são o raciocínio interno do modelo, não a resposta.

### Causa raiz
O tipo `GeminiStreamPayload` não declarava o campo `thought` nas parts. O código passava por todas as parts sem filtro:

```typescript
// Antes:
if (typeof part.text === 'string' && part.text.length > 0) {
  yield { delta: part.text };
}
```

Tokens de raciocínio teriam aparecido como texto na resposta ao usuário.

### Correção aplicada
Adicionado `thought?: boolean` ao tipo e filtro antes do yield:

```typescript
// Depois:
if (part.thought) continue;  // ignora raciocínio interno
if (typeof part.text === 'string' && part.text.length > 0) {
  yield { delta: part.text };
}
```

---

## 5. Bug 3 — Paradas prematuras silenciosas (`finishReason` não tratado)

### Sintoma
Quando o modelo parava antes de concluir (por qualquer motivo com texto já emitido), o usuário via o texto parar no meio sem nenhum aviso. A UI recebia `DONE` como se tivesse sido uma conclusão normal.

### Causa raiz
O código só tratava `MAX_TOKENS` explicitamente. Todos os outros casos de parada prematura eram silenciosos:

```
finishReason === 'MAX_TOKENS' → aviso (existia)
finishReason === undefined    → silêncio ← PROBLEMA PRINCIPAL (ver §6)
finishReason === 'SAFETY'     → silêncio
finishReason === 'RECITATION' → silêncio
finishReason === 'OTHER'      → silêncio
finishReason === 'STOP'       → correto
```

### Correção aplicada
Bloco `else if` após o tratamento de `MAX_TOKENS`:

```typescript
} else if (!lastFinishReason) {
  // sem finishReason = conexão fechada antes do evento final (cota TPM)
  usageError = 'stream encerrado sem finishReason (cota ou conexão)';
  yield { delta: '\n\n---\n⚠️ **Resposta incompleta:** ...' };
} else if (lastFinishReason !== 'STOP') {
  // SAFETY, RECITATION, OTHER, etc.
  usageError = `finishReason inesperado: ${lastFinishReason}`;
  yield { delta: `\n\n---\n⚠️ **Geração interrompida:** código: \`${lastFinishReason}\`...` };
}
```

O `usageError` é definido **antes** do `yield` para garantir que o `finally` registre `ok: false` mesmo que o consumer abandone o generator após receber o aviso.

---

## 6. Causa raiz do "parou no meio" — cotas de Nível 1 do Google AI Studio

### Investigação

Após os bugs de código serem corrigidos, gemini-2.5-flash passou a funcionar para Danielle, mas gemini-3-flash-preview ainda "parava no meio do caminho". O Testador de Modelos (ferramenta criada na investigação) mostrava resultados diferentes dos observados em produção com prompts grandes.

Análise das telas do Google AI Studio das duas contas revelou a causa:

| Conta | Nível | TPM (Flash) | Acesso a modelos preview |
|-------|-------|-------------|--------------------------|
| vsousaesilva2@gmail.com | **Nível 2 · Pré-pagamento** | 4 M tokens/min | Amplo |
| Chave da Danielle | **Nível 1 · Pós-pagamento** | 1 M tokens/min | Restrito |

### Mecanismo de falha
1. Usuário clica Resumir com processo grande (10–30 documentos → 50–200 k chars de prompt)
2. Gemini recebe a requisição, retorna HTTP 200, inicia stream
3. A geração consome a cota de TPM do Nível 1 antes de concluir
4. O servidor fecha a conexão TCP sem enviar o evento final com `finishReason: "STOP"`
5. `parseSseStream` detecta `reader.read()` → `done: true`
6. O loop SSE termina com `lastFinishReason === undefined`
7. **Antes da correção do Bug 3:** código trata como sucesso → DONE sem aviso
8. **Após a correção:** código detecta `!lastFinishReason` → exibe aviso de cota

### Por que o Testador não reproduzia o problema
O Testador de Modelos usa um prompt de 6 palavras ("Responda com as palavras 'teste ok' apenas"). Um processo real usa 10.000–100.000× mais tokens. A cota de Nível 1 não é atingida no teste sintético, mas é atingida facilmente na produção.

### Solução para o usuário final
Não há correção de código possível para o limite de cota. As opções são:

1. **Upgrade para Nível 2** — habilitar conta de faturamento no Google AI Studio com cartão de crédito. O Nível 2 é ativado após uso e pagamento, elevando o TPM de 1 M para 4 M (Flash) e desbloqueando modelos preview.
2. **Usar apenas modelos estáveis (não-preview)** com Nível 1 — gemini-2.5-flash e gemini-2.5-pro têm limites mais tolerantes e funcionam normalmente para documentos de tamanho médio.
3. **Reduzir o contexto enviado** — selecionar menos documentos por Resumir.

---

## 7. Monitoramento de uso real (ferramenta criada)

### Motivação
A discrepância entre resultados do Testador (sintético) e comportamento em produção levou à criação de um sistema de monitoramento que captura dados reais de cada chamada ao Gemini.

### Implementação
Em `src/background/providers/gemini.ts`, o bloco `try/catch/finally` do loop SSE grava em `chrome.storage.local` (chave `paidegua.gemini.usageLog`, anel de 500 entradas):

```typescript
interface GeminiUsageEntry {
  ts: number;           // timestamp Unix
  model: string;
  inChars: number;      // chars do prompt (proxy do tamanho)
  ttft: number | null;  // ms até o primeiro token
  totalMs: number;      // ms total da operação
  outChars: number;     // chars gerados
  finishReason: string | null;
  ok: boolean;
  errorSnippet: string | null;
}
```

### Leitura dos dados
A página Diagnóstico (`src/diagnostico/`) exibe o log na seção "Uso Real — Google Gemini" (visível apenas para `ADMIN_EMAILS`). A seção mostra:
- Tabela agregada por modelo: chamadas, taxa de sucesso, TTFT médio, tempo total médio, input/output médios
- Tabela detalhada das últimas 200 entradas (mais recente no topo)
- Botões Atualizar e Limpar

---

## 8. Ferramentas de diagnóstico criadas na investigação

### 8.1 Testador de Modelos (`diagnostico.html`)

Testa conexão + geração real em todos os provedores e modelos configurados. Apenas para `ADMIN_EMAILS`.

**O que faz:**
1. Verifica se cada provedor tem chave cadastrada
2. Para cada modelo com chave: testa conexão (`testConnection`) e geração real (`TEST_MODEL_GENERATE` com prompt mínimo)
3. Exibe tabela com: provedor, modelo, chave presente, tempo de conexão, TTFT, tempo total, chars gerados, status

**Limitação confirmada:** resultados sintéticos não refletem comportamento com prompts grandes de produção.

### 8.2 Log de Uso Real (`diagnostico.html`)

Lê e agrega o log gravado por `gemini.ts`. Permite comparar o que o Testador mostrou com o que aconteceu em produção real.

---

## 9. Arquivos modificados

| Arquivo | Mudanças |
|---------|----------|
| `src/background/providers/gemini.ts` | `thinkingConfig`, filtro `thought`, blocos `finishReason`, `try/catch/finally` com `GeminiUsageEntry` / `appendGeminiUsage` / `estimateInputChars` |
| `src/shared/constants.ts` | `ADMIN_EMAILS`, `MESSAGE_CHANNELS.TEST_MODEL_GENERATE` |
| `src/background/background.ts` | `handleTestModelGenerate` (handler do canal de teste) |
| `src/diagnostico/diagnostico.html` | Seções `#model-tester-section` e `#gemini-usage-section` |
| `src/diagnostico/diagnostico.ts` | Funções `isAdmin`, `hasApiKey`, `runModelTests`, `setupModelTester`, `renderUsageStats`, `renderUsageLog`, `setupGeminiUsageLog` |
| `src/diagnostico/diagnostico.css` | Estilos das seções admin (`.diag-tester-*`, `.diag-usage-*`) |

---

## 10. Decisões pendentes

### 10.1 Manter o Testador de Modelos e o Log de Uso Real?

**Pró manter:**
- Permite diagnóstico rápido quando um usuário reporta problema ("qual modelo funciona com essa chave?")
- O log de uso real captura dados que não existem em nenhum outro lugar
- Overhead em produção: apenas uma escrita async no `finally` de cada chamada Gemini

**Contra / alternativas:**
- Aumenta o tamanho do `diagnostico.js` compilado
- O log mistura chamadas reais com chamadas do Testador (sem diferenciação de origem)
- Após confirmação da causa raiz (cota de Nível 1), a ferramenta pode ter valor decrescente

### 10.2 Preview models na lista de modelos disponíveis?

Os modelos `gemini-3.1-pro-preview`, `gemini-3-flash-preview` e `gemini-3.1-flash-lite-preview` estão em `PROVIDER_MODELS` e são exibidos para todos os usuários. Chaves de Nível 1 não têm acesso pleno a eles.

**Opções:**
- Remover preview models da lista padrão e torná-los "avançado/experimental"
- Manter mas adicionar aviso na UI de seleção de modelo ("requer Nível 2")
- Manter sem alteração (o aviso de `finishReason` agora informa o usuário)

### 10.3 Alertar na UI quando a cota for atingida de forma mais proativa?

Atualmente o aviso aparece inline no chat como texto. Uma alternativa seria detectar o padrão (`ok: false` + `errorSnippet` contendo "cota") no log e exibir um banner persistente ou badge no popup.

---

## 11. Cronologia da investigação

| Data | Evento |
|------|--------|
| 2026-06-13 | Danielle reporta: gemini-2.5-flash não resume, sem erro |
| 2026-06-13 | Identificado: `thinkingConfig` ausente → Flash pensa 30–60 s em silêncio |
| 2026-06-13 | Correção do `thinkingConfig` aplicada; 2.5-flash passa a funcionar |
| 2026-06-14 | Criado Testador de Modelos (diagnóstico admin) |
| 2026-06-14 | Criado sistema de monitoramento de uso real (log em storage) |
| 2026-06-17 | Identificados bugs de parsing: `thought: true` e `finishReason` silencioso |
| 2026-06-18 | Screenshots do AI Studio revelam Nível 1 vs Nível 2 como causa raiz |
| 2026-06-18 | Correção aplicada: aviso inline quando stream fecha sem `finishReason` |
| 2026-06-19 | Confirmado: gemini-2.5-flash funciona com chave Nível 1; preview models ainda instáveis |
| 2026-06-19 | Este relatório gerado para suportar decisão sobre o que manter ou regredir |
