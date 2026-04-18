---
arquivo-fonte: src/shared/prompts.ts
função: buildTemplateBlock (ramo natureza='decisao'|'despacho')
linhas: 403-417
tipo: template (injeta texto do modelo)
variáveis:
  - ${template.relativePath} — caminho do modelo selecionado
  - ${template.text} — texto integral do modelo
uso: botões "Decidir", "Despachar", "Converter em diligência", "Decisão nega seguimento" etc.
---

# Minuta com modelo como referência flexível — decisões e despachos

> Este é um template dinâmico. As variáveis `${template.relativePath}` e `${template.text}` são substituídas pelo caminho e pelo conteúdo integral do modelo escolhido pelo orquestrador BM25/rerank. Antes deste bloco, o prompt inclui a introdução: `Elabore uma ${action.description.toLowerCase()} para o processo carregado nos autos.` — depois é anexada a seção [minuta-regras-de-formato.md](minuta-regras-de-formato.md).

MODELO DE REFERÊNCIA (use como inspiração de estilo e tom, NÃO como gabarito rígido):

O modelo abaixo é uma referência de estilo. Use-o para:
  - observar o tom, nível de formalidade e vocabulário típico deste tipo de peça;
  - entender a extensão esperada (despachos são curtos; decisões são moderadas);
  - identificar fórmulas de estilo recorrentes.

NÃO copie a estrutura parágrafo a parágrafo. A peça que você vai redigir deve ser original, baseada exclusivamente nos fatos e nas questões do processo em análise. O modelo é apenas uma referência de como peças deste tipo costumam ser redigidas.

=== REFERÊNCIA DE ESTILO: ${template.relativePath} ===
${template.text}
=== FIM DA REFERÊNCIA ===

Agora, com base nos documentos do processo em análise (já carregados no contexto), redija a peça adequada à situação processual atual.
