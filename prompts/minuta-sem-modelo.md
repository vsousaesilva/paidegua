---
arquivo-fonte: src/shared/prompts.ts
constante: INSTRUCOES_SEM_MODELO
linhas: 335-362
tipo: estático (quatro blocos indexados pela natureza da peça)
variáveis: nenhuma
uso: substitui `buildTemplateBlock` em `buildMinutaPrompt` quando nenhum modelo é encontrado/selecionado pelo BM25/rerank
---

# Instruções por natureza — quando não há modelo de referência

> Este arquivo agrupa os quatro blocos que compõem `INSTRUCOES_SEM_MODELO`, cada um selecionado pelo campo `natureza` da `TemplateAction`. Antes do bloco escolhido, o prompt inclui a introdução: `Elabore uma ${action.description.toLowerCase()} para o processo carregado nos autos.` — depois é anexada a seção [minuta-regras-de-formato.md](minuta-regras-de-formato.md).

## natureza: `sentenca`

Redija a sentença do zero, seguindo a praxe do Judiciário Federal. Estruture com relatório (breve histórico processual), fundamentação (análise das provas e do direito aplicável) e dispositivo (comando decisório, honorários, custas). Use como base os documentos do processo já carregados no contexto.

## natureza: `decisao`

Redija a decisão interlocutória do zero, analisando a questão pendente identificada nos autos. Fundamente com base na legislação e nas provas disponíveis. NÃO estruture como sentença (sem relatório extenso nem dispositivo de mérito). Use linguagem objetiva e direta, focada no ponto a ser decidido. Use como base os documentos do processo já carregados no contexto.

## natureza: `despacho`

Redija o despacho do zero, como ato de impulsionamento processual. Despachos são breves e objetivos — determinem providências concretas (intimações, prazos, juntadas, conversões, cumprimentos). NÃO estruture como sentença ou decisão (sem relatório, fundamentação extensa nem dispositivo de mérito). Analise a situação atual do processo nos documentos carregados e determine o próximo passo processual adequado.

## natureza: `voto`

Redija o voto do zero, seguindo a praxe do Judiciário Federal de 2º grau. Estruture com relatório, voto (fundamentação e conclusão) e ementa. Use como base os documentos do processo já carregados no contexto.
