# pAIdegua — Manual de Instalação e Uso

Versão: **1.6.1** · Atualizado em 13/05/2026 · Mantido pelo **Inovajus / JFCE**.

Plataforma de apoio à atividade e à gestão judicial no PJe — triagem inteligente, minutas com IA, pauta de audiência e perícia, controle criminal (Sigcrim), Central de Comunicação, Metas CNJ, Painel Gerencial, Prazos na Fita, Consultor de Fluxos e chat livre sobre os autos. Operação em conformidade com a **LGPD** e a **Resolução CNJ 615/2025**.

---

## SUMÁRIO

1. Instalação
2. Primeiro acesso (login + configurações iniciais)
3. O popup da extensão (configurações por aba)
4. Perfis de trabalho (Gabinete / Secretaria / Gestão)
5. Painel lateral e ferramentas
6. Organização da pasta de modelos
7. Solução de problemas

---

## PARTE 1 — INSTALAÇÃO

### Navegadores suportados

- **Chrome / Edge** (versão 110 ou superior) — versão oficial, indicada para uso diário nas unidades.
- **Firefox** (versão 115 ou superior) — em desenvolvimento, disponibilizada separadamente para testes. **Não use em produção.**

### Requisitos

- Acesso ao PJe institucional (pje1g.trf5.jus.br, pje2g.trf5.jus.br ou pjett.trf5.jus.br).
- E-mail institucional autorizado pelo Inovajus (a equipe libera o acesso conforme ingresso no grupo piloto).
- Chave de API de um dos provedores de IA: **Google Gemini**, **Anthropic Claude** ou **OpenAI**.

### Como instalar

1. Acesse o listing oficial: <https://chromewebstore.google.com/detail/belangijcipajlpcofhljhgjeemkbofk>.
2. Clique em **Usar no Chrome** (ou **Obter** no Edge) e confirme a instalação.
3. Fixe o ícone na barra do navegador (ícone de quebra-cabeça → alfinete ao lado de **pAIdegua**).
4. Atualizações futuras são automáticas — o navegador atualiza a extensão silenciosamente quando o Inovajus publica uma nova versão.

### Migração da versão de desenvolvedor para a Chrome Web Store

Quem já vinha usando o pAIdegua em modo desenvolvedor (extensão carregada de uma pasta `dist`) deve migrar para a versão da Chrome Web Store sem perder as configurações:

1. Abra o ícone da extensão atual → popup → **Exportar configurações**. É gerado um arquivo `paidegua-config-AAAA-MM-DDTHH-mm.txt`.
2. Em `chrome://extensions`, **Remover** a versão antiga.
3. Instale pela Chrome Web Store (passos da seção *Como instalar* acima).
4. Abra o ícone da nova extensão → popup → **Importar configurações** e selecione o arquivo `.txt` salvo no passo 1.

O backup atual está em **versão 2** e cobre: configurações gerais, peritos cadastrados, etiquetas sugestionáveis, toggles de UI e opt-in de telemetria de jornadas. Chaves de API **não** são exportadas e devem ser reinformadas após a importação.

---

## PARTE 2 — PRIMEIRO ACESSO

### Login com e-mail institucional

A extensão exige autenticação institucional. Na primeira abertura ou após o token expirar (90 dias), o pAIdegua mostra a tela de boas-vindas:

1. Informe seu e-mail institucional (`@jfce.jus.br`, `@trf5.jus.br` ou domínios autorizados).
2. Clique em **Entrar**. O Inovajus envia um código de 6 dígitos para a sua caixa institucional (válido por 10 minutos, uma única vez).
3. Digite o código na extensão para confirmar o acesso.

Se o e-mail não estiver autorizado, a extensão informa "não autorizado". Nesse caso, entre em contato com o Inovajus (link **Suporte** no rodapé do popup) para liberação.

### Configuração inicial

Clique no ícone do pAIdegua na barra do navegador. O popup é aberto. No topo há o cartão **Extensão Ativada** com um interruptor mestre:

- **Ligado (padrão):** o pAIdegua funciona normalmente e aparece dentro do PJe.
- **Desligado:** desaparece de todo o PJe (nenhum painel, botão ou injeção). Use quando precisar do PJe sem qualquer interferência. Após alterar o estado, recarregue a aba do PJe.

Em seguida, percorra as abas do popup e ajuste os pontos descritos na PARTE 3.

---

## PARTE 3 — O POPUP DA EXTENSÃO

O popup tem **sete abas** navegáveis no topo. Cada aba controla um aspecto da operação.

### 3.1 Aba Geral

- **Aviso LGPD.** Leia o aviso de privacidade e marque a caixa de ciência. A extensão envia o conteúdo dos documentos para a API do provedor de IA escolhido — confirme que está ciente.
- **Perfil de trabalho.** Defina o perfil padrão (**Gabinete**, **Secretaria** ou **Gestão**) que será carregado automaticamente ao abrir o PJe. A troca pode ser feita na sessão pelo seletor no cabeçalho do painel lateral; ao reabrir o navegador, volta a vigorar o padrão definido aqui.
- **Provedor e modelo.** Selecione o provedor (**Google Gemini**, **Anthropic Claude** ou **OpenAI**) e o modelo desejado. A recomendação atual para uso diário é **Gemini 3 Flash** pela combinação de qualidade/custo.
- **Chave de API.** Cole a chave no campo indicado, clique em **Salvar** e em **Testar** para verificar a conexão. A chave fica armazenada apenas no seu navegador.
- **OCR de digitalizados.** Marque **Rodar OCR automaticamente** se quiser que documentos digitalizados (PDFs de imagem) sejam reconhecidos por OCR após a extração. O OCR roda **localmente** no navegador (sem enviar imagens à IA). Ajuste o **máximo de páginas por documento** conforme necessário.
- **Sigcrim.** Configurações básicas do módulo criminal (matrícula do servidor, vara responsável), usadas pelo Painel Criminal.
- **Modelos de minuta.** Botão **Gerenciar modelos** abre a página de opções, onde se aponta a pasta do computador com os modelos (sentenças, decisões, despachos). Formatos aceitos: `.docx`, `.doc`, `.odt`, `.rtf`, `.pdf`, `.txt`, `.md`. Veja a PARTE 6.
- **Backup.** Botões **Exportar configurações** e **Importar configurações** (formato `paidegua-config-*.txt`, versão 2).
- **Termos de uso e Governança (Res. CNJ 615/2025).** Enquadramento da ferramenta como de baixo risco (Anexo BR4/BR8), obrigação de supervisão humana (art. 19, IV e art. 34), política de privacidade/anonimização (art. 30), trilha de auditoria (art. 19, §6º e art. 27 — em desenvolvimento) e identificação de conteúdo gerado com apoio de IA (art. 21).

### 3.2 Aba Triagem Inteligente

Define os critérios de análise inicial usados pela funcionalidade de Triagem Inteligente nos processos previdenciários e assistenciais. A base é a **Nota Técnica n. 1/2025 do CLI-JFCE**, que uniformizou as exigências entre os 16 Juizados Especiais Federais do Ceará.

Para cada critério (emenda à inicial, gratuidade de justiça, representação processual, interesse de agir, competência, prevenção, entre outros) há duas opções:

- Manter a redação padrão da NT 1/2025 (chave **Adoto a NT** marcada); ou
- Desmarcar a adoção e descrever, em campo livre, como sua unidade aplica aquele critério.

O bloco **Deseja incluir outros critérios customizados?** permite ligar o toggle **Sim** e adicionar critérios próprios da unidade não previstos na NT 1/2025. Os critérios escolhidos são injetados nos prompts da Triagem Inteligente. As alterações são salvas automaticamente.

### 3.3 Aba Etiquetas Inteligentes

Configura o catálogo de etiquetas do PJe usado pela ação **Inserir etiquetas mágicas** da Triagem Inteligente.

1. Clique em **Buscar catálogo do PJe** — o pAIdegua traz a lista completa de etiquetas da sua unidade direto do PJe e guarda no navegador.
2. No painel **Catálogo completo**, use o filtro por nome, marque **Apenas favoritas** ou utilize os botões **Marcar visíveis**, **Desmarcar visíveis** e **Marcar todas favoritas** para seleção em lote.
3. As etiquetas marcadas formam o painel superior **Sugestionáveis (selecionadas)** — são as únicas que a Triagem Inteligente considera.
4. O campo **Orientações para a IA extrair marcadores do processo** é texto livre, enviado junto com as instruções da IA; use para guiar foco (matéria, benefício, fase processual).
5. **Salvar seleção** confirma os ajustes. **Reindexar agora** atualiza a comparação com o processo. **Remover catálogo** apaga a lista guardada.

### 3.4 Aba Perícias

Cadastra os peritos cuja agenda será montada pelo painel **Perícias pAIdegua**. Para cada perito:

- Nome.
- Gênero (para concordância nos textos gerados).
- Profissão (autocomplete multisseleção — por exemplo, médico psiquiatra, médico ortopedista, assistente social).
- Etiquetas PJe associadas a esse perito (sugeridas a partir do catálogo de etiquetas).
- Assuntos preferenciais (chips reordenáveis, definem prioridade).

Use **Novo perito** para abrir o formulário, **Salvar** para persistir. A lista é usada pelo painel de pauta de perícia e pela Central de Comunicação (cobrança automática).

### 3.5 Aba Central de Comunicação

Configura os dados institucionais usados pelas cobranças automáticas geradas pelo módulo **Central de Comunicação**:

- Nome da vara.
- E-mail e telefone do CEAB (Central de Apoio).
- Etiquetas de cobrança para perito e para o CEAB (texto que o painel aplica nos processos cobrados).

Salvo automaticamente.

### 3.6 Aba Mapas de Jornada

Telemetria local **opt-in** dos fluxos do PJe (Painel Gerencial, Prazos na Fita, Triagem). Quando ligado, o pAIdegua passa a registrar — apenas no seu navegador — o caminho percorrido em cada varredura para fins de diagnóstico e melhoria da ferramenta. **Nenhum dado de processo é enviado para fora da Justiça.** Pode ser desligado a qualquer momento.

### 3.7 Aba Mais opções

Toggles de UI passiva que controlam quais funcionalidades **automáticas** o pAIdegua injeta no PJe sem você precisar pedir (todas vêm ligadas por padrão). São pequenos auxiliares que sentam dentro do próprio PJe — ao desligar um toggle aqui, a UI correspondente some sem afetar o painel lateral nem os módulos principais.

Use esta aba para personalizar o nível de interferência da extensão na interface do PJe.

### Rodapé do popup

- **Diagnóstico** — abre a página com o histórico das últimas 30 varreduras (Painel Gerencial, Prazos na Fita, Triagem Inteligente). Para cada uma: quando foi feita, em qual unidade, processos lidos / com erro, tempo total, se a sessão do PJe precisou ser renovada, blocos **Probe Keycloak** e **Histórico HTTP 403**. Os dados ficam apenas no seu navegador. Botão **Limpar histórico** apaga o registro local.
- **Suporte** — abre formulário para registrar dúvidas, erros ou sugestões. Preencha nome, unidade, e-mail, tipo de contato e descrição; ao clicar em **Preparar e-mail de suporte**, o cliente de e-mail abre com a mensagem pronta para `inovajus@jfce.jus.br`. A opção **Incluir informações técnicas** (marcada por padrão) anexa versão, navegador, sistema e endereço do PJe — sem dados do processo.
- **Versão** e **e-mail logado** — versão atual e identificação do usuário autenticado, com opção de **Sair**.

---

## PARTE 4 — PERFIS DE TRABALHO

O pAIdegua apresenta conjuntos diferentes de ferramentas conforme o perfil:

| Perfil | Foco | Disponível em | Ferramentas principais |
|---|---|---|---|
| **Gabinete** (padrão) | Análise dos autos e produção de minutas | Todos os graus | Resumir, Resumir em áudio, Anonimizar, Minutar (triagem automática), Minutas com modelo, Audiência pAIdegua |
| **Secretaria** | Triagem, pauta e organização | 1º grau apenas | Analisar tarefas, Analisar o processo, Inserir etiquetas mágicas, Audiência pAIdegua, Perícias pAIdegua, Central de Comunicação, Sigcrim |
| **Gestão** | Visão da diretoria de secretaria | Todos os graus | Painel Gerencial, Prazos na Fita, Controle Metas CNJ |

O perfil padrão é definido em **Geral → Perfil de trabalho**; a troca na sessão corrente é feita pelo seletor no cabeçalho do painel lateral. Em instâncias de 2º grau e turma recursal, o perfil Secretaria não está disponível e o seletor oculta essa opção.

Há ainda a seção **Conhecimento**, sem perfil específico, que dá acesso ao **Consultor de Fluxos**.

---

## PARTE 5 — PAINEL LATERAL E FERRAMENTAS

### 5.1 Acessando o pAIdegua

1. Abra qualquer tela do PJe (painel do usuário, lista de tarefas, autos de um processo).
2. Clique no botão **pAIdegua** que a extensão injeta na barra superior do PJe — o painel lateral abre à direita.
3. As funcionalidades que dependem de autos abertos (Carregar Documentos, Resumir, Resumir em áudio, Anonimizar, Minutar, Minutas com modelo) ficam automaticamente ocultas enquanto você não está em uma tela de processo — reaparecem assim que os autos forem abertos.

O painel exibe:

- Nome da extensão, provedor e modelo em uso.
- Número do processo detectado e grau (1G, 2G ou turma recursal), quando aplicável.
- Seletor de perfil no canto superior.
- Barra de ferramentas adaptada ao perfil, ao grau e ao tipo de tela do PJe.
- Área de chat para interação livre com a IA.

A detecção de grau é feita pelo domínio do PJe (`pje1g.trf5.jus.br` = 1º grau; `pje2g.trf5.jus.br` = turma recursal/2º grau) e altera automaticamente o conjunto de botões.

### 5.2 Carregar Documentos

**Passo obrigatório antes de qualquer ação sobre os autos.** Clique em **Carregar Documentos** para que a extensão:

- Detecte todos os documentos da árvore de anexos.
- Exiba a lista com checkbox para seleção individual.
- Permita marcar/desmarcar todos.

Depois clique em **Extrair conteúdo selecionados**. O progresso é exibido em tempo real (ex.: *"Extração concluída — 39 ok, 2 com erro"*). Arquivos de mídia (MP3, MP4 etc.) são marcados como conteúdo não-textual e não geram erro.

### 5.3 Ferramentas do perfil Gabinete

#### Resumir

Gera uma análise completa do processo no formato **FIRAC+**: dados do processo (partes, tribunal, número), fatos em ordem cronológica, problema jurídico, direito aplicável, argumentos e provas do autor e do réu, conclusão.

#### Resumir em áudio

Produz um resumo narrado em voz sintetizada. Útil para visão geral rápida em deslocamento.

#### Anonimizar autos

Substitui dados sensíveis nos documentos extraídos:

- CPF, CNPJ, CEP, telefones, e-mails, RG e dados bancários — substituição **local**, por regex, sem envio à IA.
- Nomes de pessoas físicas — substituição via IA.

Os dados viram marcadores genéricos (ex.: `PARTE_AUTORA`, `CPF_OCULTO`).

#### Rodar OCR

Aparece automaticamente quando há documentos digitalizados (PDFs de imagem). Processa as páginas localmente com Tesseract.js (sem envio à IA). Documentos com muitas páginas podem demorar; ajuste o limite na aba **Geral**.

#### Minutar (com triagem automática)

Funciona como assistente de triagem:

1. Monta um contexto priorizando a timeline e os atos recentes do processo.
2. Consulta a IA para recomendar qual ato é mais adequado ao momento processual (ex.: *julgar procedente*, *converter em diligência*, *decisão sobre tutela*, *despacho saneador*).
3. Exibe a recomendação no chat com justificativa breve e dois botões:
   - **Gerar esta minuta** — produz a minuta recomendada diretamente.
   - **Escolher outro ato** — abre menu com todos os atos disponíveis no grau detectado.
4. Se a triagem falhar (sem chave de API, resposta inválida etc.), a escolha manual é aberta imediatamente.

#### Minutas com modelo

Botões de geração assistida por modelos de referência. Funciona plenamente se você apontou uma pasta de modelos na aba **Geral**.

**1º grau:** Julgar procedente · Julgar improcedente · Decidir · Converter em diligência · Despachar.

**2º grau / turma recursal:** Voto (mantém sentença) · Voto (reforma sentença) · Decisão nega seguimento ao recurso · Decisão · Converte em diligência com baixa · Despacho.

Comportamento da busca de modelos:

- Pasta configurada **com** modelo compatível: seleciona o mais similar e informa caminho + percentual de similaridade.
- Pasta configurada **sem** modelo compatível: pergunta se quer gerar do zero ou cancelar.
- Sem pasta configurada: gera do zero, silenciosamente.

> Decisões usam apenas modelos de **decisão**, e despachos apenas modelos de **despacho** — nunca caem em modelos de sentença.

#### Audiência pAIdegua

Disponível também em Gabinete (e em Secretaria). Funcionalidade nova na **v1.6.1**, com dois usos integrados:

- **Pauta de audiência:** o painel lê as tarefas de **Audiência — Designar** do PJe, agrupa os processos por advogado e por data/hora, e abre uma aba dedicada com a pauta pronta para imprimir ou conferir antes da audiência.
- **Resumo de audiência:** durante a coleta, gera para cada processo um resumo curto (partes, pedido, fase atual, pontos controvertidos) — entregue ao magistrado antes do início da pauta.

Fluxo: no Painel do usuário do PJe, clique em **Audiência pAIdegua**, defina o período (data/hora), marque as tarefas e clique em **Iniciar coleta**. A pauta + resumos abrem no dashboard ao final.

### 5.4 Ferramentas do perfil Secretaria

#### Triagem Inteligente

No perfil Secretaria, a seção **Ações da secretaria** exibe botões distribuídos em dois grupos:

**Grupo Painel** (aparece na tela do Painel do usuário / lista de tarefas):

- **Analisar tarefas** — lê a fila de tarefas exibida, classifica cada uma pelo tipo de providência necessária e abre o **Painel de Triagem Inteligente pAIdegua** com um quadro resumo para orientar a priorização do dia. As tabelas são ordenáveis pelos cabeçalhos (clique para alternar asc/desc) e cada linha de processo traz três ícones ao lado do número: hiperlink para os autos, copiar CNJ e abrir a tarefa no PJe.

**Grupo Processo** (aparece quando há autos abertos):

- **Analisar o processo** — executa uma análise guiada pelos critérios configurados na aba **Triagem Inteligente** do popup. Por padrão, adota os critérios da NT 1/2025 do CLI-JFCE; cada critério pode ser personalizado ou substituído por redação própria, e critérios customizados podem ser incluídos.
- **Inserir etiquetas mágicas** — usa o catálogo selecionado na aba **Etiquetas Inteligentes**. A IA lê os autos, extrai os principais assuntos e temas (marcadores), compara com as etiquetas sugestionáveis e abre uma bolha mostrando: os marcadores encontrados, a lista das etiquetas mais parecidas com caixa de seleção e barra de similaridade, e o botão **Copiar selecionadas** (a aplicação automática no PJe está prevista para versões futuras).

**Gerar ato de emenda à inicial:** quando a análise indica necessidade de emenda, a extensão oferece a geração da minuta diretamente no chat. A bolha traz o botão **Encaminhar e inserir no PJe** (no lugar de **Inserir no PJe**), que encaminha a tarefa e insere o texto da minuta no editor da nova tarefa em uma única ação.

> Antes do primeiro uso da Triagem Inteligente, revise os critérios e o catálogo de etiquetas no popup. Esses ajustes alimentam tanto os prompts quanto a comparação das etiquetas com o processo, e definem o resultado.

#### Perícias pAIdegua

Disponível apenas em 1º grau. Acelera a montagem da pauta de perícia agrupando os processos por perito cadastrado.

1. Pré-requisito: cadastrar peritos na aba **Perícias** do popup (nome, gênero, profissão, etiquetas e assuntos preferenciais).
2. No Painel do usuário do PJe, clique em **Perícias pAIdegua**.
3. O painel filtra as tarefas de **Perícia — Designar** e **Perícia — Agendar e administrar**, lista os peritos ativos e abre a aba intermediária.
4. Marque as tarefas e os peritos desejados; clique em **Iniciar coleta**.
5. Ao final, abre o dashboard com a pauta organizada por perito.

#### Central de Comunicação

Disponível apenas em 1º grau. Automatiza cobranças a peritos (mensagem) e ao CEAB (e-mail), com base nos processos de perícia em atraso.

1. Pré-requisito: preencher a aba **Central de Comunicação** do popup (nome da vara, e-mail e telefone do CEAB, etiquetas de cobrança).
2. No Painel do usuário do PJe, clique em **Central de Comunicação**.
3. O painel carrega as configurações e a lista de peritos. Filtre por perito ou por dias de atraso; escolha o modo (mensagem para perito, e-mail para CEAB).
4. Veja o preview, selecione os processos e clique em **Gerar cobrança**.
5. Envie pela ação correspondente (clipboard, e-mail direto ou abertura do app de mensagens) e acompanhe os logs.

#### Sigcrim / Painel Criminal

Disponível apenas em 1º grau. Acervo persistente de processos criminais com controle de **prescrição**, **ANPP** e **SERP**.

1. Pré-requisito: preencher matrícula e vara na aba **Geral → Sigcrim** do popup.
2. No Painel do usuário do PJe, clique em **Sigcrim**.
3. Marque as tarefas a varrer e escolha o modo: **Rápido** (apenas prescrição) ou **Completo** (movimentos + ANPP).
4. Acompanhe o progresso. Os processos são salvos incrementalmente no acervo local (apenas seu navegador).
5. O dashboard abre com lista filtrável por status, alertas de prescrição e ações de etiqueta.

### 5.5 Ferramentas do perfil Gestão

> Os botões do perfil Gestão aparecem somente quando você está no **Painel do usuário** do PJe. Em outras telas, é exibido um aviso orientando a abrir o Painel do usuário.

#### Painel Gerencial pAIdegua

Disponível em todos os graus.

1. Detecta as tarefas visíveis no painel do PJe e pergunta quais devem entrar no relatório.
2. Busca diretamente no PJe os processos de cada tarefa selecionada, com progresso em tempo real. O cabeçalho do relatório já mostra o nome da unidade desde o início.
3. Abre uma aba com o dashboard, contendo:
   - Indicadores determinísticos da unidade (total de processos, distribuição por tarefa, *10 mais antigos por tarefa* etc.).
   - Lista por tarefa, com tabelas ordenáveis e três ícones por processo (autos, copiar CNJ, abrir tarefa).
   - Botão **Gerar insights** — envia ao provedor de IA os dados **com número do processo e nomes das partes ocultados** (anonimização local antes do envio); a resposta traz alertas, relacionamentos entre tarefas e sugestões de ação.

O propósito é dar à diretoria de secretaria uma visão consolidada da carga de trabalho sem precisar rodar relatórios no PJe.

#### Prazos na Fita pAIdegua

Disponível em todos os graus. Foca nas tarefas cujo nome contém **Controle de prazo** — onde ficam os expedientes com prazo correndo.

1. Liste as tarefas **Controle de prazo** visíveis e marque quais coletar.
2. O dashboard abre em poucos segundos, mesmo antes da coleta terminar, com cartões zerados (*0 de X processos*) e indicação de **coleta em andamento**. Enquanto a varredura avança, o dashboard preenche os dados em tempo real.
3. Ao final, o dashboard fica completo com:
   - Cartões no topo (total de processos, total de expedientes abertos, prazos correndo, vencimentos nos próximos 7 dias).
   - Uma tabela por tarefa, com cabeçalhos ordenáveis e a coluna **Dias** destacando vencimentos próximos.
   - Blocos colapsáveis para processos sem expedientes abertos e falhas de coleta.
   - Os três ícones por linha (autos, copiar CNJ, abrir tarefa) + a coluna **Encerrar** (ver mais abaixo).

**Varredura interrompida e retomada:** se a aba for fechada, o navegador cair ou a sessão expirar, o dashboard mostra um aviso *"Coleta interrompida — retome pelo painel"* com o resumo do que já foi coletado. O trabalho feito não é perdido. Ao voltar ao Painel do usuário e clicar de novo em **Prazos na Fita** com as mesmas tarefas, o pAIdegua avisa: *"Detectei uma varredura anterior interrompida"*. Escolha:

- **OK** = continuar de onde parou.
- **Cancelar** = começar do zero.

Se a interrupção for antiga (>30 minutos), o aviso destaca que os dados podem estar desatualizados — geralmente vale começar do zero.

**Encerrar expedientes em lote.** Última coluna da tabela. Um clique no ícone de lixeira executa, em aba invisível, o mesmo fluxo que o PJe normalmente exige em três cliques + confirmação:

1. Abrir a tela de movimentação da tarefa.
2. Marcar o cabeçalho **Fechado** que seleciona todos os expedientes abertos.
3. Clicar em **Encerrar expedientes selecionados** e confirmar o popup.

A automação fecha **todos** os expedientes abertos daquela tarefa. Para encerramento parcial, use o ícone **Abrir tarefa** e trate no PJe.

Estados do botão (persistem entre recargas): pronto · executando · sucesso · erro · nada a fazer. Múltiplos cliques entram em fila — um por vez, evitando que disputem a mesma aba/sessão.

#### Controle Metas CNJ

Em homologação. Materializa acervo persistente de processos classificados pelas cinco metas mensuráveis do CNJ 2026 (Meta 2 — antiguidade > 15 anos, Meta 4 — improbidade e crimes administrativos, Meta 6 — ambientais, Meta 7 — indígenas/quilombolas/racismo, Meta 10 — subtração internacional de crianças). Detecta status automático (julgado/baixado) via hierarquia de movimentos da TPU. Permite acompanhamento mensal/semanal do cumprimento sem re-varrer tudo. Configuração avançada feita atualmente pelo Inovajus — fale conosco pelo Suporte para ativar.

### 5.6 Seção Conhecimento — Consultor de Fluxos

Disponível em qualquer perfil. Botão **Consultor de fluxos** na seção **Conhecimento** do painel lateral, com o subtítulo *Como o processo caminha no PJe*. Abre uma nova aba com chat dedicado sobre os 210 fluxos do PJe (JEF, EF, Comum, Shared).

Usos típicos:

- *"Como funciona o JEF previdenciário?"*
- *"Explique o fluxo OPPER da Vara de Execução."*
- *"O que acontece após a tarefa de conclusão para sentença?"*

A interface tem três áreas:

- **Esquerda:** ações rápidas predefinidas + busca textual no catálogo.
- **Centro:** chat com a IA.
- **Direita:** diagrama Mermaid do fluxo conversado (renderizado sob demanda).

Há dois modos:

- **Para usuário** — linguagem natural, sem códigos, foco no que o operador vê na tela.
- **Para desenvolvedor** — linguagem técnica, códigos jBPM, swimlanes coloridas.

A troca de modo reinicia a conversa atual. Tudo opera dentro do navegador — não há envio de dados de processo concretos para fora.

### 5.7 Painéis comuns — ícones por linha

Em todas as listas de processo dos dashboards (Triagem Inteligente, Painel Gerencial, Prazos na Fita, Audiência, Perícias) há três ícones ao lado de cada número de processo:

1. **Hiperlink para os autos** — abre o processo em nova aba.
2. **Copiar CNJ** — copia apenas o número CNJ, removendo prefixos como `PJEC`, `JEF`, `PROCAUT`.
3. **Abrir tarefa no PJe** — vai direto para a tela de movimentação da tarefa corrente do processo (mesmo destino do link **Abrir tarefa** do widget *Documentos pendentes* do PJe nativo).

A janela popup do **Abrir tarefa** é nomeada por processo; cliques subsequentes na mesma linha reaproveitam a aba aberta. Se o popup for bloqueado, libere o endereço do PJe no ícone de popup bloqueado da barra de endereços. Quando a coleta daquela linha não conseguiu todos os identificadores necessários, o ícone simplesmente não aparece — é intencional, para evitar abrir tarefa errada.

### 5.8 Chat livre

A área de chat na parte inferior do painel permite perguntas livres sobre o processo carregado:

- *Qual o pedido principal do autor?*
- *Existe laudo pericial nos autos? O que conclui?*
- *Resuma as provas documentais.*
- *Há questões preliminares a resolver?*
- *Liste todos os prazos mencionados.*

O chat também suporta entrada por voz pelo botão do microfone:

- Se o provedor selecionado tem API de transcrição (OpenAI Whisper, Gemini), o áudio é enviado para transcrição remota.
- Caso contrário, a extensão cai para o **Web Speech API local** do navegador.

Com Anthropic, a transcrição via API não está disponível — use o Web Speech do navegador ou selecione OpenAI / Gemini.

### 5.9 Ações disponíveis em cada resposta/minuta

Abaixo de cada resposta da IA (em especial minutas) aparecem botões de ação rápida:

- **Copiar** — copia a resposta (markdown) para a área de transferência.
- **Inserir no PJe** — insere o texto diretamente no editor de minutas do PJe aberto em outra aba.
- **Encaminhar e inserir no PJe** — substitui *Inserir no PJe* no fluxo de emenda à inicial: encaminha a tarefa e insere a minuta no editor da nova tarefa em uma só ação.
- **Baixar .doc** — salva como arquivo do Word, com nome sugerido a partir do número do processo e do tipo de ato.
- **Refinar minuta** — reaproveita a última minuta com uma instrução adicional (*encurtar*, *mudar o tom*, *citar a Súmula 343 do STJ*, *reforçar o dispositivo*), preservando o template.
- **Nova minuta** — gera uma nova versão da mesma ação, do zero, sem modelo de referência.

---

## PARTE 6 — ORGANIZAÇÃO DA PASTA DE MODELOS

Para melhor aproveitamento da busca automática de modelos pelo botão **Minutas com modelo**, organize os arquivos em subpastas:

```
Modelos/
  procedente/
    bpc-loas-procedente.docx
    aposentadoria-procedente.docx
    auxilio-doenca-procedente.docx
  improcedente/
    bpc-loas-improcedente.docx
    aposentadoria-improcedente.docx
  decisao/
    tutela-urgencia.docx
    liminar-bloqueio.docx
  despacho/
    saneador.docx
    intimacao-pericia.docx
    cite-se.docx
  diligencia/
    conversao-diligencia.docx
```

Dicas:

- Use nomes descritivos (a busca considera o nome e o conteúdo).
- Subpastas com nomes como `procedente`, `improcedente`, `decisao`, `despacho` recebem prioridade automática na busca do botão correspondente.
- Formatos aceitos: `.docx`, `.doc`, `.odt`, `.rtf`, `.pdf`, `.txt`, `.md`.
- Após adicionar ou alterar modelos, clique em **Reindexar agora** na página de opções.

---

## PARTE 7 — SOLUÇÃO DE PROBLEMAS

**Extensão não aparece no PJe.** Verifique primeiro se o interruptor **Extensão Ativada** no topo do popup está ligado — se estiver desligado, o pAIdegua fica invisível no PJe de propósito. Se estiver ligado, confirme se a extensão está ativa em `chrome://extensions` ou `edge://extensions`. Após qualquer mudança, recarregue a página do PJe.

**Não consigo fazer login (e-mail não autorizado).** A liberação é feita pelo Inovajus para os membros do grupo piloto. Solicite via formulário **Suporte** (rodapé do popup) informando seu e-mail institucional, vara/unidade e papel (servidor, magistrado, diretor).

**Não recebo o código de 6 dígitos.** Verifique a caixa de spam / lixo eletrônico. O código vem do remetente **pAIdegua / Inovajus** (`noreply@paidegua.ia.br`) e é válido por 10 minutos. Se persistir, solicite reenvio pelo Suporte.

**Erro ao extrair documentos.** Alguns documentos podem retornar vazio na primeira tentativa. A extensão faz até 3 tentativas automáticas com estratégias diferentes. Se persistir, recarregue a página do PJe e tente novamente.

**OCR lento.** O OCR roda localmente no navegador. Documentos com muitas páginas podem demorar. Ajuste o limite de páginas nas configurações.

**Minuta usando modelo errado.** A busca automática usa o conteúdo do processo para encontrar o modelo mais similar. Se o resultado não for adequado, reorganize seus modelos em subpastas mais específicas ou gere do zero.

**Chave de API inválida.** Use o botão **Testar** nas configurações. Cada provedor tem seu formato de chave — certifique-se de que a chave corresponde ao provedor selecionado.

**Atualização da extensão.** A atualização é automática — o navegador atualiza o pAIdegua silenciosamente quando o Inovajus publica uma nova versão na Chrome Web Store. Para forçar a verificação, acesse `chrome://extensions` ou `edge://extensions`, ligue o **Modo do desenvolvedor** e clique em **Atualizar** no topo da página.

**Painel Gerencial, Prazos na Fita ou Sigcrim abrem vazios ou com erro "Sem credenciais de acesso".** Abra o Painel do usuário do PJe e clique em qualquer tarefa antes de acionar os botões — essa primeira interação captura a chave de sessão. Se a sessão do PJe tiver expirado, refaça o login. Em varreduras longas, o pAIdegua renova a sessão automaticamente em segundo plano. Se a coleta parar, abra a página de **Diagnóstico** para conferir bloqueios (HTTP 403) ou problema de sessão (Probe Keycloak).

**Varredura de Prazos na Fita parou no meio.** O trabalho já feito fica salvo. Volte ao Painel do usuário, clique de novo em **Prazos na Fita**, selecione as mesmas tarefas, e quando aparecer o aviso *"Detectei uma varredura anterior interrompida"*, escolha **OK** para continuar. Se a interrupção for antiga (>30 minutos), comece do zero.

**Ícone "Abrir tarefa" não aparece em alguma linha.** A coleta não conseguiu todos os identificadores necessários. Recarregue o painel do PJe, abra uma tarefa para capturar as credenciais e rode a coleta de novo.

**Popup "Abrir tarefa" bloqueado.** O navegador bloqueou a janela. Clique no ícone de popup bloqueado na barra de endereços e libere o endereço do PJe.

**"Encerrar expedientes" fica em erro.** Verifique se a sessão do PJe está ativa (abra o PJe em outra aba). Se o PJe tiver mudado a estrutura da tela de movimentação, reporte ao Inovajus pelo Suporte — enquanto isso, faça o encerramento manualmente pelo ícone **Abrir tarefa**.

**"Inserir etiquetas mágicas" não traz sugestões.** Confirme na aba **Etiquetas Inteligentes** do popup que (a) o catálogo foi buscado (botão **Buscar catálogo do PJe**) e (b) há etiquetas marcadas no painel **Sugestionáveis (selecionadas)**. Sem etiquetas sugestionáveis, não há o que sugerir.

**Perícias pAIdegua não mostra peritos.** Cadastre os peritos na aba **Perícias** do popup. Sem peritos cadastrados, o painel não tem por quem agrupar.

**Central de Comunicação não gera cobrança.** Preencha a aba **Central de Comunicação** do popup (nome da vara, e-mail e telefone CEAB, etiquetas) e confirme que há peritos ativos cadastrados na aba **Perícias**.

**Sigcrim não inicia ou não classifica corretamente.** Confirme na aba **Geral → Sigcrim** que a matrícula e a vara estão preenchidas. Para casos atípicos, abra o Suporte com o número do processo (sem dados pessoais).

---

**Dúvidas?** Use o link **Suporte** no rodapé do popup ou envie e-mail para `inovajus@jfce.jus.br`.
