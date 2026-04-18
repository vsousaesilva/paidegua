---
arquivo-fonte: src/shared/prompts.ts
função: buildTemplateBlock (ramo natureza='sentenca'|'voto')
linhas: 369-401
tipo: template (injeta texto do modelo)
variáveis:
  - ${template.relativePath} — caminho do modelo selecionado
  - ${template.text} — texto integral do modelo
uso: botões "Julgar procedente", "Julgar improcedente", "Voto (mantém)", "Voto (reforma)"
---

# Minuta com gabarito rígido — sentenças e votos

> Este é um template dinâmico. As variáveis `${template.relativePath}` e `${template.text}` são substituídas pelo caminho e pelo conteúdo integral do modelo escolhido pelo orquestrador BM25/rerank. Antes deste bloco, o prompt inclui a introdução: `Elabore uma ${action.description.toLowerCase()} para o processo carregado nos autos.` — depois é anexada a seção [minuta-regras-de-formato.md](minuta-regras-de-formato.md).

ATENÇÃO — PRODUÇÃO EM SÉRIE COM GABARITO FIXO:

O modelo abaixo é um GABARITO (template). Você deve reproduzir a peça PARÁGRAFO A PARÁGRAFO, mantendo:
  - a mesma sequência de seções/tópicos, na mesma ordem;
  - os mesmos fundamentos legais (artigos de lei, súmulas, teses) citados em cada seção;
  - o mesmo estilo de redação, tom, nível de formalidade e extensão de cada parágrafo;
  - as mesmas frases-padrão e fórmulas de estilo (ex.: "Passo a decidir.", "Ante o exposto…");
  - a mesma estrutura do dispositivo (comandos, condenações, honorários, custas).

O QUE VOCÊ DEVE TROCAR (e SOMENTE isto):
  - nomes das partes → usar os nomes do processo em análise;
  - fatos e circunstâncias → adaptar ao caso concreto (laudo, datas, valores, provas);
  - número do processo, datas de audiência, datas de perícia → do processo atual;
  - análise probatória e subsunção → baseadas nas provas dos autos em análise;
  - conclusão (procedência/improcedência parcial) → se os fatos do caso concreto assim exigirem.

NÃO FAÇA:
  - NÃO reorganize as seções; NÃO omita seções presentes no modelo; NÃO acrescente seções que o modelo não tem.
  - NÃO troque os fundamentos legais por outros, a menos que sejam manifestamente inaplicáveis ao caso concreto.
  - NÃO resuma nem encurte o modelo — a peça final deve ter extensão comparável.
  - NÃO copie dados factuais do modelo (nomes, CPF, datas, valores) — esses vêm exclusivamente do processo em análise.

=== GABARITO (modelo de referência): ${template.relativePath} ===
${template.text}
=== FIM DO GABARITO ===

Agora, com base nos documentos do processo em análise (já carregados no contexto), redija a peça reproduzindo fielmente a estrutura do gabarito acima, substituindo apenas os dados do caso concreto.
