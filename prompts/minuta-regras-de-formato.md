---
arquivo-fonte: src/shared/prompts.ts
função: buildMinutaFormatRules (regra 5 via buildRegraFechoSede)
tipo: bloco anexado a todo prompt de minuta
variáveis: sede do juízo (SedeJuizo | null), resolvida em src/shared/sede-juizo.ts
uso: concatenado ao final por `buildMinutaPrompt` e `buildEmendaInicialPrompt`
---

# Regras de formato comuns a todas as minutas

As regras 1 a 4 são fixas. A regra 5 (fecho da peça) é **gerada** conforme a
sede do juízo que o caller conseguiu resolver — ver `src/shared/sede-juizo.ts`.

> **Não reintroduza exemplos de municípios reais neste prompt.** Até a v1.9.0 a
> regra 5 mandava o modelo deduzir a cidade dos autos e trazia "Maracanaú/CE"
> como primeiro exemplo; quando a cidade não estava clara, o modelo caía no
> exemplo e minutas de outras unidades fechavam em Maracanaú/CE. A sede é dado,
> não inferência.

REGRAS DE FORMATO (obrigatórias):
1. Texto em prosa corrida, parágrafos separados por linha em branco.
2. Sem nenhum marcador de markdown: nada de asteriscos, sustenidos, listas com hífen ou número, nem crases.
3. Citações textuais de lei ou doutrina devem aparecer em parágrafo próprio iniciado pelo sinal de maior seguido de espaço (> ), que indica recuo de citação.
4. NÃO inclua cabeçalho, número do processo, identificação das partes nem o título do ato — esses elementos já são preenchidos automaticamente pelo editor do PJe. Comece diretamente pelo corpo da peça.

## Regra 5 — três variantes

**Sede completa (município + UF conhecidos):**

5. Encerre o texto com EXATAMENTE esta linha, sem alterar nada: "{municipio}/{uf}, datado eletronicamente." Esta é a sede do juízo do processo, já verificada — NÃO a substitua por nenhuma cidade mencionada nos documentos dos autos. Não use assinatura, nome ou cargo (preenchidos pelo PJe).

**Só o município (UF não determinada):**

5. Encerre o texto com a linha "{municipio}/UF, datado eletronicamente.", substituindo UF pela sigla do estado a que pertence o município de {municipio}. O município é a sede do juízo do processo, já verificada — NÃO o substitua por nenhuma cidade mencionada nos documentos dos autos. Não use assinatura, nome ou cargo (preenchidos pelo PJe).

**Sede não resolvida:**

5. Encerre o texto com a linha "[Cidade]/[UF], datado eletronicamente." A sede do juízo não pôde ser determinada automaticamente: mantenha o marcador "[Cidade]/[UF]" LITERALMENTE, entre colchetes, para que o usuário o preencha na revisão. NÃO tente adivinhar a cidade a partir dos documentos dos autos e NÃO invente um município. Não use assinatura, nome ou cargo (preenchidos pelo PJe).
