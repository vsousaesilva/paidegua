---
arquivo-fonte: src/shared/prompts.ts
constante: QUICK_ACTIONS[id='minutar-despacho'].prompt
linhas: 93-107
tipo: estático (user prompt)
variáveis: nenhuma (o contexto documental é anexado pelo chamador)
uso: botão "Minutar despacho saneador" da sidebar do pAIdegua
---

# Quick action — Minutar despacho saneador

Elabore minuta de despacho saneador para este processo, observando o art. 357 do CPC. Inclua: resolução das questões processuais pendentes, fixação dos pontos controvertidos, distribuição do ônus da prova e designação de provas (quando cabíveis). Use linguagem formal do Judiciário Federal.

REGRAS DE FORMATO (obrigatórias):
1. Texto em prosa corrida, parágrafos separados por linha em branco.
2. Sem nenhum marcador de markdown: nada de asteriscos, sustenidos, listas com hífen ou número, nem crases.
3. Citações textuais de lei ou doutrina devem aparecer em parágrafo próprio iniciado pelo sinal de maior seguido de espaço (> ), que indica recuo de citação.
4. NÃO inclua cabeçalho, número do processo, identificação das partes nem o título "DESPACHO" — esses elementos já são preenchidos automaticamente pelo editor do PJe. Comece diretamente pelo corpo da peça.
5. Encerre o texto com a linha "Fortaleza/CE, [data por extenso]." sem assinatura, nome ou cargo (também preenchidos pelo PJe).
