---
arquivo-fonte: src/shared/prompts.ts
função: buildEmendaInicialPrompt (linhas 898-917) + constante EMENDA_INICIAL_GABARITO (linhas 873-885)
tipo: template + gabarito fixo
variáveis:
  - ${providenciasFmt} — lista com hífen das providências derivadas das `AnaliseCriterio` com `atendido=false` (lista precedida pelo orquestrador)
uso: botão "Elaborar emenda" na Triagem Inteligente após "Analisar processo" identificar pendências
---

# Emenda à inicial — gabarito + prompt de geração

> Este é um template dinâmico. O prompt final concatena: introdução + gabarito fixo (abaixo) + lista de providências injetada em `${providenciasFmt}` + [minuta-regras-de-formato.md](minuta-regras-de-formato.md). O gabarito é reproduzido integralmente na saída; apenas o marcador `[PREENCHER COM A PROVIDÊNCIA...]` e `[município sede do juízo]` são substituídos.

## Gabarito fixo (constante `EMENDA_INICIAL_GABARITO`)

De ordem do(a) MM.(a) Juiz(a) Federal, e com amparo no art. 93, inc. XIV, da CF/88, c/c o art. 203, § 4º, do CPC/2015, fica a parte autora intimada para, no prazo constante no menu "Expedientes":

[PREENCHER COM A PROVIDÊNCIA A SER SOLICITADA PARA CORRIGIR OS CRITÉRIOS QUE NÃO FORAM ATENDIDOS EM TÓPICOS]

O não cumprimento total ou parcial das determinações acima estabelecidas ensejará o indeferimento liminar da petição inicial.

Em respeito ao princípio da celeridade, esclarece-se que eventual pedido de prorrogação do prazo somente será deferido excepcionalmente e desde que acompanhado de justificação objetiva e específica, comprovada documentalmente. Meros pedidos genéricos de prorrogação de prazo serão sumariamente indeferidos.

[município sede do juízo], datado eletronicamente.

## Prompt de geração (concatenado)

Elabore o ato de emenda à inicial reproduzindo INTEGRALMENTE o gabarito abaixo, substituindo APENAS o marcador "[PREENCHER COM A PROVIDÊNCIA A SER SOLICITADA PARA CORRIGIR OS CRITÉRIOS QUE NÃO FORAM ATENDIDOS EM TÓPICOS]" pelas providências listadas mais adiante.

IMPORTANTE:
- Mantenha o restante do gabarito EXATAMENTE como está (mesma redação, mesma ordem dos parágrafos, mesma fórmula final).
- Substitua "[município sede do juízo]" pelo município da vara/seção judiciária responsável pelo processo, identificado a partir dos documentos dos autos (ex.: "Maracanaú/CE", "Fortaleza/CE"). NÃO mantenha o marcador entre colchetes na peça final.
- O bloco de providências deve ser apresentado em forma de tópicos numerados (1., 2., 3., ...), um tópico por providência, redigidos no IMPERATIVO formal e iniciados por verbo (ex.: "Apresentar...", "Juntar...", "Esclarecer..."). Cada tópico em um parágrafo separado, terminando em ponto-final.
- NÃO acrescente cabeçalho, número do processo, identificação das partes nem assinatura — esses elementos são preenchidos automaticamente pelo editor do PJe.

EXCEÇÃO DE FORMATO: as regras de formato gerais aplicáveis às demais minutas PROÍBEM marcadores de lista; aqui, os tópicos numerados (1., 2., ...) do bloco de providências são OBRIGATÓRIOS e a única exceção permitida. O restante do texto (cabeçalho, parágrafos do meio e fecho) segue as regras normais de prosa corrida sem marcadores.

=== GABARITO ===
{conteúdo de `EMENDA_INICIAL_GABARITO` reproduzido acima}
=== FIM DO GABARITO ===

=== PROVIDÊNCIAS A INCLUIR (uma por tópico, na ordem dada) ===
${providenciasFmt}
=== FIM DAS PROVIDÊNCIAS ===

{conteúdo de MINUTA_FORMAT_RULES — ver [minuta-regras-de-formato.md](minuta-regras-de-formato.md)}
