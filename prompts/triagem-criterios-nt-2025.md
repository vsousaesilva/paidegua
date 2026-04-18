---
arquivo-fonte: src/shared/constants.ts (TRIAGEM_CRITERIOS, linhas 220-326)
função-auxiliar: src/shared/prompts.ts (buildTriagemCriteriosBlock, linhas 605-644; resolveTriagemCriterios, linhas 672-705)
tipo: base de dados textual injetada dinamicamente
variáveis: o magistrado pode (1) manter o texto padrão, (2) substituir por redação própria ou (3) descartar cada critério em `Opções → Triagem Inteligente`. Pode ainda acrescentar critérios livres (`settings.triagemCriteriosCustom`).
uso: alimenta `${criteriosFmt}` em [triagem-analise-processo-criterios.md](triagem-analise-processo-criterios.md)
---

# Critérios de admissibilidade da inicial — NT 1/2025 do CLI-JFCE

> Cada entrada abaixo é um critério `TriagemCriterio` com `id`, `label` e `defaultText`. O `defaultText` é enviado ao LLM quando o magistrado adota a redação padrão da NT. Quando o magistrado fornece entendimento próprio, o texto é substituído por aquele texto; quando descarta o critério sem redigir alternativa, o critério é omitido do bloco.

## 1. `peticao-nomeacao` — Nomeação correta da petição inicial e dos documentos

Nomeação correta da petição inicial e dos documentos que a acompanham, de modo que cada peça anexada permita identificação imediata pelo nome do arquivo no PJe.

## 2. `renuncia-teto` — Renúncia ao teto dos JEFs

Declaração de renúncia ao teto dos JEFs (60 salários-mínimos), exigida sempre que houver possibilidade de o valor da causa ultrapassar o limite de alçada do Juizado Especial Federal.

## 3. `procuracao` — Procuração

Procuração pública ou particular, emitida há no máximo um ano do ajuizamento da ação. No caso de autor analfabeto ou impossibilitado de assinar, é válida a procuração particular lavrada a rogo, contendo (i) marcador textual de rogo (expressões como "a rogo", "assina o rogado", "a pedido de", "por não saber/poder assinar"), (ii) identificação do rogado (nome e CPF ou RG) e (iii) assinatura de ao menos duas testemunhas com nome e CPF ou RG, dispensado o instrumento público.

## 4. `documentos-pessoais` — Documentos pessoais

Documento oficial de identificação pessoal e CPF da parte autora.

## 5. `comprovante-endereco` — Comprovante de endereço

Comprovante de endereço emitido há no máximo um ano do ajuizamento da ação: contas de água, gás, energia elétrica, telefone (fixo ou móvel) ou fatura de cartão de crédito. Para comprovantes em nome de terceiros, declaração de moradia, exceto no caso de cônjuge (mediante certidão de casamento) ou de genitor (em caso de menores ou incapazes).

## 6. `aposentadorias` — Aposentadorias

Para ações de aposentadoria: comprovante de indeferimento do requerimento administrativo ou de requerimento com decurso de prazo sem análise; provas de qualidade de segurado e cumprimento da carência; indicação dos períodos e categoria de segurado do RGPS; autodeclaração de tempo de labor (em caso de segurado especial), com indicação de períodos e locais de trabalho; provas da exposição a agentes nocivos (PPPs, laudos técnicos etc.) quando houver alegação de tempo submetido a condições especiais de trabalho.

## 7. `salario-maternidade` — Salário-maternidade

Para ações de salário-maternidade: comprovante de indeferimento do requerimento administrativo ou de requerimento com decurso de prazo sem análise; provas de qualidade de segurada do RGPS; certidão de nascimento.

## 8. `incapacidade` — Benefícios previdenciários por incapacidade

Para benefícios por incapacidade: comprovante de indeferimento do requerimento administrativo ou de requerimento com decurso de prazo sem análise; pedido de prorrogação ou demonstração da impossibilidade do protocolo de prorrogação, em caso de alta programada ou concessão pelo INSS para período pretérito; provas de qualidade de segurado do RGPS; documentos médicos (atestados, laudos, exames etc.).

## 9. `amparo-assistencial` — Amparo assistencial (BPC/LOAS)

Para amparo assistencial: comprovante de indeferimento do requerimento administrativo ou de requerimento com decurso de prazo sem análise; declaração de composição e renda familiar conforme modelo disponibilizado no sítio eletrônico da Justiça Federal; CPF de todos os membros do grupo familiar informado na declaração; CadÚnico atualizado e correspondente ao grupo familiar declarado.

## 10. `pensao-morte` — Pensão por morte

Para pensão por morte: comprovante de indeferimento do requerimento administrativo ou de requerimento com decurso de prazo sem análise; provas de qualidade de segurado do RGPS do instituidor; certidão de óbito; prova da condição de dependente.

## 11. `auxilio-reclusao` — Auxílio-reclusão

Para auxílio-reclusão: comprovante de indeferimento do requerimento administrativo ou de requerimento com decurso de prazo sem análise; provas de qualidade de segurado do RGPS do instituidor; certidão judicial que ateste o efetivo recolhimento à prisão.

---

## Preâmbulo injetado (quando usado em prompts gerais)

Quando `buildTriagemCriteriosBlock` é usado (função definida em `src/shared/prompts.ts:605-644`), os critérios acima são prefixados pelo seguinte cabeçalho:

```
## CRITÉRIOS DE ANÁLISE INICIAL ADOTADOS POR ESTE MAGISTRADO
(Base: Nota Técnica nº 1/2025 do CLI-JFCE, com personalizações onde indicado)
```

E cada critério aparece como uma linha numerada no formato:
- `N. {label}: {texto adotado}`
- `N. {label} (entendimento próprio do magistrado): {texto customizado}` — quando o magistrado redigiu versão própria
- `N. {label}: este critério NÃO é adotado por este magistrado.` — quando descartado sem texto alternativo
- `N. (Critério adicional do magistrado): {texto livre}` — quando acrescentado pelo magistrado
