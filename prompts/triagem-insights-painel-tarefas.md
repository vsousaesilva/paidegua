---
arquivo-fonte: src/background/background.ts
função: buildTriagemInsightsPrompt
linhas: 1952-1978
tipo: template
variáveis:
  - ${payload.totalProcessos} — contagem total de processos agregados no painel
  - ${payload.tarefas.length} — quantidade de tarefas distintas no agrupamento
  - ${JSON.stringify(payload, null, 2)} — payload JSON completo já anonimizado (polo ativo mascarado como "[POLO ATIVO]"; polo passivo preservado apenas para entes públicos; campo "ref" com o número CNJ real, que é informação pública)
saída esperada: JSON `{"panorama":"...","sugestoes":[{"titulo":"...","detalhe":"...","prioridade":"alta|media|baixa"}]}` (parser em `parseTriagemInsightsResponse`, linhas 1984+)
uso: painel "Analisar tarefas" (dashboard aberto a partir da Triagem Inteligente)
nota-lgpd: este é o único fluxo em que os dados enviados à LLM passam por anonimização prévia (em src/shared/triagem-anonymize.ts) antes do prompt ser montado
---

# Triagem — insights estratégicos sobre o painel de tarefas

> Este é um template dinâmico. O prompt final substitui `${payload.totalProcessos}`, `${payload.tarefas.length}` e serializa `payload` como JSON indentado.

Você está analisando o painel de tarefas de uma secretaria de Vara Federal.

Há ${payload.totalProcessos} processos distribuídos em ${payload.tarefas.length} tarefa(s) de "Analisar inicial" / "Triagem". Os dados abaixo estão em JSON; o campo "ref" contém o número CNJ real do processo (informação pública), o polo ativo foi mascarado como "[POLO ATIVO]" e o polo passivo só foi mantido para entes públicos.

=== DADOS ===
```json
${JSON.stringify(payload, null, 2)}
```

Sua tarefa: produzir (a) um PANORAMA curto (2 a 4 frases) descrevendo o estado geral; (b) entre 3 e 6 SUGESTÕES de próximos passos priorizadas, cada uma com título curto, detalhe (1-3 frases) e prioridade ("alta", "media" ou "baixa").

Critérios para sugerir prioridade alta:
- processos com mais de 60 dias na tarefa;
- processos prioritários (campo "prioritario": true);
- presença de etiquetas indicando ação pendente (ex: "+30 dias", "Tutela");
- volume concentrado num assunto que permita despacho em lote.

Pode citar os números CNJ (campo "ref") nas sugestões quando ajudar a localizar os autos. NÃO invente dados que não estejam no JSON.

Responda APENAS o JSON no formato exato:
{"panorama":"<texto>","sugestoes":[{"titulo":"<curto>","detalhe":"<1-3 frases>","prioridade":"alta|media|baixa"}, ...]}
