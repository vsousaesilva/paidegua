---
arquivo-fonte: src/shared/prompts.ts
função: buildTriagemPrompt
linhas: 472-510
tipo: template
variáveis:
  - ${actionsFmt} — lista formatada das TemplateAction disponíveis para o grau detectado
  - ${caseContext} — linha do tempo + últimos documentos integrais (truncado em 18.000 chars por TRIAGEM_CASE_CONTEXT_LIMIT)
saída esperada: JSON puro `{"actionId":"...","justificativa":"..."}` (parser em `parseTriagemResponse`, linhas 517-538)
uso: botão "Minutar" → etapa prévia que decide qual `TemplateAction` executar
---

# Triagem — escolha do melhor ato processual para a fase atual

> Este é um template dinâmico. O prompt final concatena as seções abaixo, substituindo `${actionsFmt}` e `${caseContext}`.

Você está ajudando um magistrado a decidir qual é o MELHOR ato processual para o momento atual do processo.

COMO LER O CONTEXTO:
O contexto abaixo traz DOIS blocos complementares:
  1) "LINHA DO TEMPO DO PROCESSO" — panorama cronológico de TODAS as movimentações;
  2) "DOCUMENTOS RECENTES" — texto integral dos últimos documentos.

PRINCÍPIOS DE ANÁLISE (aplique a QUALQUER caso concreto, sem presumir cenário típico):
- Identifique a fase processual atual a partir da ÚLTIMA movimentação relevante, não da primeira.
- Um ato só é adequado se a providência que ele realiza AINDA NÃO foi efetivada e se não pressupõe etapa posterior à atual.
- Nunca recomende ato incompatível com a fase em que o processo se encontra, em qualquer direção (nem retroceder etapas já cumpridas, nem antecipar etapas ainda não maduras).
- Se houver pedido, requerimento ou manifestação pendente de apreciação, esse é o ponto de partida para escolher o ato.
- Se não houver pendência clara, escolha o ato de impulsionamento mais adequado à fase atual.

FATORES A CONSIDERAR:
- fase efetiva do processo (postulatória, saneamento, instrução, julgamento, recurso, cumprimento, arquivamento — ou qualquer outra identificável);
- questões processuais pendentes (citação, intimação, produção de provas, nulidades, preliminares);
- existência ou não de elementos suficientes para o ato pretendido;
- natureza da causa, pretensão deduzida e providências já realizadas.

Escolha EXATAMENTE UM dos atos listados. Se NENHUM dos atos disponíveis for apropriado ao momento processual concreto (por exemplo, porque o processo já ultrapassou a fase a que se destinam os atos listados, ou ainda não atingiu fase em que caibam), escolha o ato que menos distorça a realidade dos autos e DEIXE CLARO NA JUSTIFICATIVA essa inadequação, descrevendo qual seria o ato realmente cabível.

=== ATOS DISPONÍVEIS ===
${actionsFmt}

=== CONTEXTO DOS AUTOS ===
```
${caseContext}
```

Responda SEMPRE em JSON puro, sem markdown, sem comentários, no formato exato:
{"actionId": "<id escolhido, obrigatoriamente um dos listados acima>", "justificativa": "<explicação curta em PT-BR, no máximo 3 linhas, citando o estado do processo que justifica a escolha>"}

NÃO inclua mais nada além do JSON.
