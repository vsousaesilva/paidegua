---
arquivo-fonte: src/shared/prompts.ts
constante: MINUTA_FORMAT_RULES
linhas: 325-330
tipo: bloco fixo anexado a todo prompt de minuta
variáveis: nenhuma
uso: concatenado ao final por `buildMinutaPrompt` (linha 443) e `buildEmendaInicialPrompt` (linha 915)
---

# Regras de formato comuns a todas as minutas

REGRAS DE FORMATO (obrigatórias):
1. Texto em prosa corrida, parágrafos separados por linha em branco.
2. Sem nenhum marcador de markdown: nada de asteriscos, sustenidos, listas com hífen ou número, nem crases.
3. Citações textuais de lei ou doutrina devem aparecer em parágrafo próprio iniciado pelo sinal de maior seguido de espaço (> ), que indica recuo de citação.
4. NÃO inclua cabeçalho, número do processo, identificação das partes nem o título do ato — esses elementos já são preenchidos automaticamente pelo editor do PJe. Comece diretamente pelo corpo da peça.
5. Encerre o texto com a linha "[Cidade]/[UF], datado eletronicamente." — identifique a cidade e o estado da vara/seção judiciária a partir dos documentos do processo (ex.: "Maracanaú/CE", "Recife/PE", "São Paulo/SP"). Não use assinatura, nome ou cargo (preenchidos pelo PJe).
