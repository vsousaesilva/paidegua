---
arquivo-fonte: src/background/background.ts
função: buildRerankPrompt
linhas: 342-368
tipo: template
variáveis:
  - ${req.actionLabel} — rótulo da ação de minuta selecionada (ex.: "Julgar procedente")
  - ${req.caseContext} — trecho do processo em análise (truncado em 3.000 chars dentro do prompt)
  - ${req.candidates.length} — número de candidatos a modelo
  - ${candidatosFmt} — K modelos candidatos, cada um com `relativePath` e `excerpt` (truncado em 1.500 chars via RERANK_EXCERPT_LIMIT)
saída esperada: JSON `{"ranking":[<índices>], "justificativa":"..."}` (parser em `parseRerankResponse`, linhas 374+)
uso: orquestrador de seleção de modelos — após BM25 produzir top-K, o LLM reordena com julgamento jurídico
---

# Rerank de modelos candidatos — julgamento jurídico após BM25

> Este é um template dinâmico. O prompt final substitui `${req.actionLabel}`, `${req.candidates.length}`, `${req.caseContext}` e `${candidatosFmt}`.

Você está ajudando um magistrado a escolher o MELHOR modelo de minuta para uma peça do tipo "${req.actionLabel}".

Abaixo estão (a) um trecho do processo em análise — tipicamente a petição inicial — e (b) ${req.candidates.length} candidatos a modelo de referência, cada um com um excerto.

Sua tarefa: ordenar os candidatos do MAIS adequado para o MENOS adequado, considerando que o melhor modelo é aquele que trata do MESMO tipo de causa (mesma matéria, mesmo benefício, mesma tese jurídica) E do mesmo tipo de peça. A similaridade lexical pura já foi feita pelo BM25 — você deve usar julgamento jurídico para reordenar.

=== TRECHO DO PROCESSO ===
```
${req.caseContext}
```

=== CANDIDATOS ===
${candidatosFmt}

Responda SEMPRE em JSON puro, sem markdown, sem comentários, no formato exato:
{"ranking": [<índices na nova ordem, do melhor para o pior>], "justificativa": "<texto curto em PT-BR explicando por que o primeiro foi escolhido — máximo 2 frases>"}

Os índices DEVEM ser números inteiros entre 0 e ${req.candidates.length - 1}, cada um aparecendo exatamente uma vez. NÃO inclua mais nada além do JSON.

---

## Formato de cada candidato em `${candidatosFmt}`

Cada candidato é renderizado como:

```
### Candidato {i} — `{relativePath}`
\`\`\`
{excerpt (até 1500 chars)}
\`\`\`
```
