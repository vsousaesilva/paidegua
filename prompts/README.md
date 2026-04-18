# Prompts do pAIdegua

Este diretório contém, em texto puro, **todos os prompts** enviados por qualquer fluxo da extensão pAIdegua a modelos de linguagem (LLMs — Anthropic Claude, OpenAI GPT e Google Gemini).

## Finalidade

1. **Auditoria LGPD.** Permite que a equipe jurídica e de TI da JFCE inspecione, em um único local, todo o conteúdo instrucional enviado a provedores externos, facilitando o controle sobre o que é (e o que não é) transmitido junto com os dados de processos.
2. **Otimização.** Serve de base para revisão, refinamento e versionamento dos prompts sem necessidade de ler o código-fonte.
3. **Rastreabilidade.** Cada arquivo indica o caminho e a função/constante de origem no código, permitindo localizar o ponto exato onde o prompt é montado e enviado.

## Importante

- Os arquivos aqui são **extrações documentais** — a fonte canônica continua sendo o código TypeScript. Se um prompt for alterado no código, este diretório deve ser atualizado.
- Onde há placeholders (`%VARIÁVEL%`, `${variavel}`), o texto real é injetado em tempo de execução a partir de dados do processo carregado no PJe ou das configurações do magistrado.
- Prompts que carregam contexto processual (documentos, linha do tempo, metadados) **trafegam dados sensíveis** ao provedor escolhido. A anonimização prévia é aplicada somente em fluxos específicos (painel de triagem) — os demais enviam o conteúdo bruto dos autos, com base no consentimento LGPD aceito pelo usuário na primeira execução.

## Índice

### Sistema
- [sistema-institucional.md](sistema-institucional.md) — Papel, diretrizes e sigilo do assistente pAIdegua (enviado como `system` em toda chamada de chat).

### Ações rápidas do chat
- [resumo-firac-completo.md](resumo-firac-completo.md) — Resumo analítico completo no formato FIRAC+.
- [despacho-saneador.md](despacho-saneador.md) — Minuta de despacho saneador (art. 357 CPC).
- [listar-partes.md](listar-partes.md) — Listagem das partes e procuradores do processo.
- [resumo-audio-narravel.md](resumo-audio-narravel.md) — Resumo curto em até 8 frases para leitura em voz alta (TTS).

### Minutas (gabinete)
- [minuta-regras-de-formato.md](minuta-regras-de-formato.md) — Bloco comum de regras de formatação aplicado a toda minuta gerada.
- [minuta-gabarito-rigido-sentenca-voto.md](minuta-gabarito-rigido-sentenca-voto.md) — Instrução para reproduzir um gabarito parágrafo a parágrafo (sentenças e votos).
- [minuta-referencia-flexivel-decisao-despacho.md](minuta-referencia-flexivel-decisao-despacho.md) — Instrução para usar um modelo apenas como referência de estilo (decisões e despachos).
- [minuta-sem-modelo.md](minuta-sem-modelo.md) — Instruções por natureza de peça quando nenhum modelo é escolhido (sentença, decisão, despacho, voto).

### Triagem Inteligente (secretaria)
- [triagem-escolha-do-ato-processual.md](triagem-escolha-do-ato-processual.md) — Escolha do melhor ato processual para a fase atual do processo.
- [triagem-analise-processo-criterios.md](triagem-analise-processo-criterios.md) — Verificação dos critérios de admissibilidade da inicial contra os documentos dos autos.
- [triagem-criterios-nt-2025.md](triagem-criterios-nt-2025.md) — Conteúdo textual dos 11 critérios da NT 1/2025 do CLI-JFCE injetado dinamicamente.
- [triagem-insights-painel-tarefas.md](triagem-insights-painel-tarefas.md) — Panorama e sugestões priorizadas para o painel "Analisar tarefas" (dados anonimizados).

### Utilitários
- [emenda-inicial.md](emenda-inicial.md) — Gabarito fixo + prompt para emenda à inicial com injeção das providências.
- [rerank-templates-juridico.md](rerank-templates-juridico.md) — Reordenação, com julgamento jurídico, dos top-K modelos selecionados por BM25.
- [anonimizacao-nomes-processuais.md](anonimizacao-nomes-processuais.md) — Identificação exaustiva de pessoas físicas a serem substituídas por papel processual.
- [transcricao-audio-gemini.md](transcricao-audio-gemini.md) — Transcrição de áudio (ditado por voz) pelo Gemini multimodal.

## Prompts do chat livre

Além dos prompts listados acima, o chat livre envia ao LLM **exatamente o texto digitado pelo usuário**, acrescido do `system-institucional` e do bloco `=== Documentos disponíveis nos autos ===` produzido por `buildDocumentContext` (ver [src/shared/prompts.ts:545-591](../src/shared/prompts.ts)). Esse contexto documental não é um prompt em si — é a serialização dos documentos do processo atualmente carregado —, mas integra a mensagem enviada ao provedor e deve ser considerado na auditoria.

## Regra de sincronização

Sempre que um prompt do código-fonte for alterado, o arquivo correspondente neste diretório deve ser atualizado no mesmo commit, preservando o cabeçalho de metadados (arquivo fonte, função/constante, linhas). Em caso de divergência, **o código é a fonte autoritativa**.
