---
arquivo-fonte: src/shared/anonymizer.ts
função: buildAnonymizePrompt
linhas: 91-130
tipo: template
variáveis:
  - ${trechoInicial} — primeiros 12.000 caracteres do texto extraído do(s) documento(s) (TRECHO_INICIAL_TAMANHO)
saída esperada: JSON `{"nomes":[{"original":"Nome","substituto":"[PAPEL PROCESSUAL]"}]}` (parser em `parseNomesResponse`, linhas 158-180)
uso: passo 2 da anonimização em dois estágios — roda após `aplicarRegexAnonimizacao` (CPF/CNPJ/RG/telefone/email/CEP/dados bancários)
nota-lgpd: apenas os primeiros 12.000 caracteres vão ao provedor externo — documento completo NÃO é enviado neste fluxo
---

# Anonimização — identificação exaustiva de pessoas físicas

> Este é um template dinâmico. O prompt final é a string abaixo, interpolada com `${trechoInicial}` no final. O resultado do LLM é aplicado com `aplicarSubstituicoesNomes` em todo o texto (não só no trecho).

Analise o trecho de processo judicial abaixo e identifique EXAUSTIVAMENTE todos os nomes de pessoas físicas que devem ser anonimizados. É CRÍTICO capturar TODOS os atores processuais — não apenas o autor.

Retorne APENAS um objeto JSON válido, sem texto adicional, sem markdown, sem explicações. Formato:
{"nomes": [{"original": "Nome Completo da Pessoa", "substituto": "[PAPEL PROCESSUAL]"}]}

Papéis possíveis (use o que melhor descrever o papel da pessoa no processo):
- [PARTE AUTORA] / [PARTE RÉ] / [LITISCONSORTE ATIVO] / [LITISCONSORTE PASSIVO] / [TERCEIRO INTERESSADO]
- [REPRESENTANTE LEGAL DA PARTE AUTORA] / [REPRESENTANTE LEGAL DA PARTE RÉ]
- [CURADOR] / [TUTOR] / [ASSISTENTE] (quando houver incapacidade ou menoridade)
- [ADVOGADO DA PARTE AUTORA] / [ADVOGADO DA PARTE RÉ] (inclui estagiários e advogados substabelecidos)
- [PROCURADOR FEDERAL] / [PROCURADOR DO ESTADO] / [PROCURADOR DO MUNICÍPIO]
- [DEFENSOR PÚBLICO]
- [MEMBRO DO MINISTÉRIO PÚBLICO]
- [PERITO MÉDICO] / [PERITO SOCIAL] / [PERITO CONTÁBIL] / [PERITO ENGENHEIRO] / [PERITO]
- [ASSISTENTE TÉCNICO DA PARTE AUTORA] / [ASSISTENTE TÉCNICO DA PARTE RÉ]
- [TESTEMUNHA 1] / [TESTEMUNHA 2] / [TESTEMUNHA 3] (numerar na ordem em que aparecem)
- [INFORMANTE]

ONDE PROCURAR (não se limite à qualificação inicial do autor):
1. Qualificação das partes na petição inicial (nome, RG, CPF, endereço, profissão).
2. Nomes de advogados com inscrição na OAB — geralmente aparecem em "Por seus advogados", "representado por", em procurações, substabelecimentos ou ao final da peça (assinatura).
3. Contestação/defesa — procurador federal/INSS, advogado do réu, nome do servidor.
4. Representantes legais, curadores, tutores — comuns em casos de incapacidade, interdição, menoridade.
5. Laudos periciais — nome do perito, CRM/CREA/CFESS/CRC, assistentes técnicos indicados pelas partes.
6. Ministério Público — promotor/procurador da República que oficiou nos autos.
7. Nomeações constantes em despachos (ex.: "nomeio como curador provisório Fulano de Tal").
8. Substabelecimentos — advogado substabelecente E advogado substabelecido.

Regras:
- Incluir TODAS as pessoas físicas identificadas, por mais secundárias que pareçam.
- Incluir estagiários, advogados auxiliares, peritos de todas as especialidades.
- NÃO incluir: órgãos públicos (INSS, União, Município), autarquias, empresas, escritórios de advocacia como pessoa jurídica.
- NÃO incluir: magistrados e servidores do Judiciário no exercício da função (juiz, desembargador, relator, escrivão, chefe de secretaria).
- Se o mesmo nome aparecer com variações (com/sem acentos, com/sem sobrenomes, abreviado, tudo maiúsculo, com título "Dr.", "Sr."), incluir TODAS as variações encontradas como entradas separadas com o mesmo substituto.
- Seja generoso: é preferível anonimizar um nome a menos do que deixar um nome sensível passar.

TRECHO DO PROCESSO:
${trechoInicial}
