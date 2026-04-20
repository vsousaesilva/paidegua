# pAIdegua - Manual de Instalacao e Uso

Assistente de IA integrado ao PJe para analise de processos, geracao de minutas e extracao de informacoes.

---

## PARTE 1 - INSTALACAO

### Navegadores suportados

O pAIdegua e oferecido em duas versoes:

- **pAIdegua para Chrome/Edge** - versao oficial, indicada para uso diario nas unidades judiciarias.
- **pAIdegua para Firefox** - versao em desenvolvimento, disponibilizada separadamente para testes.

RECOMENDACAO: para a elaboracao de minutas no dia a dia, utilize a versao para Google Chrome ou Microsoft Edge. A versao para Firefox ainda esta em ajustes e nao deve ser utilizada em producao.

### Requisitos

- Navegador: Google Chrome ou Microsoft Edge (versao 110 ou superior) - ou Mozilla Firefox 115+ para a versao experimental
- Acesso ao PJe (pje1g.trf5.jus.br, pje2g.trf5.jus.br ou pjett.trf5.jus.br)
- Chave de API de um dos provedores: Google Gemini, Anthropic (Claude) ou OpenAI (GPT)

### Passo a passo

1. Obtenha o arquivo "dist.zip" da extensao (fornecido pelo desenvolvedor ou gerado via build).

2. IMPORTANTE - Extraia o arquivo antes de instalar: clique com o botao direito sobre "dist.zip" e escolha "Extrair tudo" (Windows) ou use o descompactador de sua preferencia. O resultado sera uma pasta chamada "dist" com todos os arquivos da extensao. O navegador NAO aceita carregar a extensao a partir do arquivo compactado - e obrigatorio descompactar primeiro.

3. Guarde a pasta "dist" extraida em um local permanente (ex.: Documentos\pAIdegua\dist). Se a pasta for apagada ou movida apos a instalacao, a extensao deixara de funcionar.

4. Abra a pagina de extensoes do navegador:
   - Chrome: digite chrome://extensions na barra de endereco
   - Edge: digite edge://extensions na barra de endereco
   - Firefox (versao experimental): digite about:debugging#/runtime/this-firefox

5. Ative o "Modo do desenvolvedor" (interruptor no canto superior direito da pagina). No Firefox, este passo nao e necessario.

6. Clique em "Carregar sem compactacao" (Chrome) ou "Carregar descompactada" (Edge). No Firefox, clique em "Carregar extensao temporaria..." e selecione o arquivo manifest.json dentro da pasta "dist".

7. Selecione a pasta "dist" extraida do pAIdegua (nao selecione o arquivo .zip). No Firefox, selecione o manifest.json dentro da pasta.

8. A extensao aparecera na barra de ferramentas do navegador com o icone do pAIdegua.

9. Fixe a extensao na barra (clique no icone de quebra-cabeca e depois no alfinete ao lado de "pAIdegua").

### Configuracao inicial

Clique no icone do pAIdegua na barra de ferramentas. O popup de configuracoes sera aberto.

No topo do popup fica o cartao "Extensao Ativada" com um interruptor. Ele serve para ligar e desligar o pAIdegua de uma vez:
   - Ligado (padrao): o pAIdegua funciona normalmente e aparece dentro do PJe.
   - Desligado: o pAIdegua deixa de aparecer na tela do PJe — nenhum botao, painel ou analise e injetado. Util quando voce quer usar o PJe sem qualquer interferencia da extensao, sem precisar desinstalar. Basta voltar ao popup e ligar o interruptor de novo para retomar. Apos trocar o estado, recarregue a aba do PJe que ja estava aberta para que a mudanca tenha efeito.

1. LGPD: Leia o aviso de privacidade e marque a caixa de ciencia. A extensao envia o conteudo dos documentos para a API do provedor de IA escolhido. Confirme que esta ciente.

2. Provedor e modelo: Selecione o provedor de IA (Google Gemini, Anthropic ou OpenAI) e o modelo desejado.

3. Chave de API: Cole a chave de API do provedor selecionado no campo indicado. Clique em "Salvar" e depois em "Testar" para verificar se a conexao esta funcionando. A chave fica armazenada apenas no navegador local.

4. OCR (opcional): Marque "Rodar OCR automaticamente" se deseja que documentos digitalizados (imagens sem texto) sejam processados por reconhecimento optico de caracteres. O OCR roda localmente, sem enviar imagens ao provedor de IA. Ajuste o limite de paginas por documento conforme necessario.

5. Modelos de minuta (opcional): Clique em "Gerenciar modelos" para abrir a pagina de configuracao. Ali voce pode selecionar uma pasta do seu computador com seus modelos de minutas (sentencas, decisoes, despachos). A extensao aceita arquivos .docx, .doc, .odt, .rtf, .pdf, .txt e .md. Organize por subpastas (ex.: "procedente", "improcedente", "despachos", "decisoes") para melhor selecao automatica.

6. Perfil padrao ao abrir: na aba "Geral" do popup, na secao "Perfil de trabalho", escolha qual perfil sera carregado automaticamente quando o PJe for aberto (Gabinete, Secretaria ou Gestao). O seletor no cabecalho do painel lateral continua permitindo alternar o perfil dentro da sessao, mas ao reabrir o navegador o padrao definido aqui volta a vigorar.

7. Criterios da Triagem Inteligente (perfil Secretaria): na aba "Triagem Inteligente" do popup voce define os criterios de analise inicial usados pela funcionalidade de Triagem Inteligente nos processos previdenciarios e assistenciais. A base e a Nota Tecnica n 1/2025 do CLI-JFCE, que uniformizou as exigencias entre os 16 Juizados Especiais Federais do Ceara. Para cada criterio (emenda a inicial, gratuidade de justica, representacao processual, interesse de agir, competencia, prevencao etc.) voce pode:
   - Manter a redacao padrao da NT 1/2025 (chave "Adoto a NT" marcada); ou
   - Desmarcar a adocao e descrever no campo livre como voce entende e aplica aquele criterio na sua unidade.
   Ha ainda o bloco "Deseja incluir outros criterios customizados?" — ligue o toggle "Sim" para adicionar criterios proprios da sua unidade que nao constam da NT 1/2025. Os criterios escolhidos (padronizados, personalizados e customizados) sao injetados nos prompts da Triagem Inteligente. As alteracoes sao salvas automaticamente.

8. Etiquetas Inteligentes (perfil Secretaria): a aba "Etiquetas Inteligentes" do popup configura o catalogo de etiquetas do PJe usado pela acao "Inserir etiquetas magicas" da Triagem Inteligente. Fluxo:
   - Clique em "Buscar catalogo do PJe" — o pAIdegua traz a lista completa de etiquetas da sua unidade direto do PJe e guarda no seu navegador, sem sair da estacao.
   - No painel "Catalogo completo" voce ve todas as etiquetas da unidade. Use o filtro por nome, marque "Apenas favoritas" ou use os botoes "Marcar visiveis", "Desmarcar visiveis" e "Marcar todas favoritas" para selecao em lote.
   - As etiquetas marcadas formam o painel superior "Sugestionaveis (selecionadas)" — sao as unicas que a Triagem Inteligente considera quando sugere etiquetas magicas para um processo.
   - O campo "Orientacoes para a IA extrair marcadores do processo" e um texto livre enviado junto com as instrucoes da IA; use para guiar o foco (materia, beneficio, fase processual) e melhorar a comparacao com as etiquetas.
   - Clique em "Salvar selecao" ao final. "Reindexar agora" atualiza a comparacao com o processo. "Remover catalogo" apaga a lista guardada no navegador.

9. Termos de uso e governanca: No popup ha a secao "Termos de uso e Governanca (Res. CNJ 615/2025)" com o enquadramento da ferramenta como de baixo risco (Anexo BR4/BR8), a obrigacao de supervisao humana (art. 19, IV e art. 34), a politica de privacidade/anonimizacao (art. 30), a trilha de auditoria (art. 19, par. 6 e art. 27 - EM DESENVOLVIMENTO, ainda nao implementada na versao atual) e a identificacao de conteudo gerado com apoio de IA (art. 21). Leia antes do uso em producao.

---

## PARTE 2 - USO

### Acessando o pAIdegua

1. Acesse o PJe. O pAIdegua agora pode ser aberto em qualquer tela do sistema (painel do usuario, lista de tarefas, autos de um processo etc.), nao apenas quando houver processo aberto.
2. O painel lateral e aberto pelo botao "PAIDEGUA" que a extensao injeta na barra superior do proprio PJe.
3. As funcionalidades que dependem de autos abertos (Carregar Documentos, Resumir, Resumir em audio, Anonimizar, Minutar e a secao "Minutas com modelo") ficam automaticamente ocultas enquanto voce nao estiver em uma tela de processo — reaparecem assim que os autos forem abertos.

### Painel lateral

O painel exibe:
- Nome da extensao e provedor/modelo em uso
- Numero do processo detectado e o grau identificado automaticamente (1G, 2G ou turma recursal), quando aplicavel
- Seletor de perfil (Gabinete / Secretaria / Gestao) no canto superior do painel
- Barra de ferramentas com os botoes de acao, ja adaptados ao perfil em uso, ao grau do processo e ao tipo de tela do PJe (autos abertos, painel do usuario, lista de tarefas etc.)
- Area de chat para interacao livre com a IA

A deteccao de grau e feita pelo dominio do PJe (pje1g.trf5.jus.br = 1o grau; pje2g.trf5.jus.br = turma recursal/2o grau) e altera automaticamente o conjunto de botoes de minuta exibidos.

### Perfis de trabalho (Gabinete / Secretaria / Gestao)

O pAIdegua apresenta conjuntos diferentes de ferramentas conforme o perfil:

- Gabinete (padrao): foco em analise dos autos e producao de minutas — mostra os botoes de Resumir, Resumir em audio, Anonimizar, Minutar e a secao "Minutas com modelo" (quando ha processo aberto). Disponivel em todos os graus.
- Secretaria: foco em triagem e organizacao de tarefas — mostra a secao "Acoes da secretaria" com os botoes "Analisar tarefas", "Analisar o processo" e "Inserir etiquetas magicas" (ver secao propria adiante). Disponivel apenas no 1o grau.
- Gestao: perfil do diretor de secretaria. Quando o usuario esta no "Painel do usuario" do PJe, exibe a secao "Recursos para a Gestao" com os botoes "Painel Gerencial pAIdegua" e "Prazos na Fita pAIdegua". Fora dessa tela, aparece um aviso orientando a abrir o Painel do usuario. Disponivel em todos os graus.

O perfil padrao e definido nas configuracoes (popup da extensao, aba "Geral"); a troca na sessao corrente e feita pelo seletor no cabecalho do painel. Em instancias de 2o grau e turma recursal, o perfil Secretaria nao esta disponivel e o seletor oculta essa opcao.

### Carregar Documentos

Primeiro passo obrigatorio antes de qualquer acao. Clique em "Carregar Documentos" para que a extensao:
- Detecte todos os documentos na arvore de anexos do processo
- Exiba a lista com checkbox para selecao individual
- Permita marcar/desmarcar todos

Depois clique em "Extrair conteudo selecionados". A extensao baixa e extrai o texto de cada documento selecionado. O progresso e exibido em tempo real (ex.: "Extracao concluida - 39 ok, 2 com erro").

### Resumir

Gera uma analise completa do processo no formato FIRAC+:
- Dados do processo (partes, tribunal, numero)
- Fatos em ordem cronologica
- Problema juridico (questao central e pontos controvertidos)
- Direito aplicavel
- Argumentos e provas do autor e do reu
- Conclusao

### Minutar (com triagem automatica)

O botao "Minutar" passou a funcionar como assistente de triagem. Ao ser acionado, a extensao:

1. Monta um contexto priorizando a timeline e os atos recentes do processo.
2. Consulta a IA para recomendar qual ato e mais adequado ao momento processual (ex.: "julgar procedente", "converter em diligencia", "decisao sobre tutela", "despacho saneador").
3. Exibe no chat a recomendacao com breve justificativa e os botoes:
   - "Gerar esta minuta" - produz a minuta recomendada diretamente.
   - "Escolher outro ato" - abre uma segunda bolha com todos os atos disponiveis no grau detectado, para escolha manual.
4. Caso a triagem falhe (sem chave de API, resposta invalida, etc.), a escolha manual e aberta imediatamente, preservando a funcionalidade.

### Resumo em audio

Produz um resumo narrado em voz sintetizada. Util para ter uma visao geral rapida do processo em audio.

### Anonimizar autos

Substitui dados sensiveis nos documentos extraidos:
- CPF, CNPJ, CEP, telefones, e-mails, RG e dados bancarios (via regex local, sem envio a IA)
- Nomes de pessoas fisicas (via IA)

Os dados sao substituidos por marcadores genericos (ex.: "PARTE_AUTORA", "CPF_OCULTO").

### Rodar OCR

Aparece automaticamente quando ha documentos digitalizados (PDFs de imagem). Processa as paginas localmente com Tesseract.js para extrair o texto. Nao envia imagens ao provedor de IA.

### Minutas com modelo

Secao com botoes para geracao de minutas assistida por modelos de referencia. So funciona plenamente se voce configurou uma pasta de modelos na pagina de opcoes.

Botoes disponiveis (1o grau):

- Julgar procedente: Gera sentenca de procedencia. Busca automaticamente o modelo mais similar na sua pasta e usa como gabarito, reproduzindo estrutura, fundamentos e estilo. Adapta os fatos ao caso concreto.

- Julgar improcedente: Mesmo funcionamento, para sentenca de improcedencia.

- Decidir: Gera decisao interlocutoria sobre questao pendente (tutela de urgencia, liminar, etc.). Busca modelos de decisao na sua pasta. NAO usa modelos de sentenca como referencia. A decisao e focada no ponto especifico a decidir, sem estrutura de sentenca.

- Converter em diligencia: Gera despacho de conversao do julgamento em diligencia, determinando providencias para instrucao complementar.

- Despachar: Gera despacho de impulsionamento processual. Busca modelos de despacho na sua pasta. NAO usa modelos de sentenca. Despachos sao breves e objetivos, determinando providencias concretas (intimacoes, prazos, juntadas).

Para o 2o grau e turma recursal, os botoes se adaptam automaticamente:

- Voto (mantem sentenca): nega provimento ao recurso.
- Voto (reforma sentenca): da provimento ao recurso.
- Decisao nega seguimento ao recurso: decisao monocratica de inadmissibilidade, com base no art. 932 do CPC.
- Decisao: decisao monocratica do relator sobre questao pendente (tutela antecipada, efeito suspensivo, liminar).
- Converte em diligencia com baixa: despacho de conversao em diligencia com baixa dos autos a origem.
- Despacho: mero expediente do relator.

Comportamento da busca de modelos:
- Se ha pasta configurada e modelos compativeis: a extensao seleciona automaticamente o mais similar e informa o caminho e percentual de similaridade.
- Se ha pasta mas nenhum modelo compativel: pergunta se deseja gerar do zero ou cancelar.
- Se nao ha pasta configurada: gera do zero silenciosamente.

### Triagem Inteligente (perfil Secretaria)

Funcionalidade dedicada ao trabalho de secretaria no 1o grau. No perfil Secretaria, a secao "Acoes da secretaria" exibe tres botoes, distribuidos em dois grupos:

Grupo "Painel" (aparece na tela do Painel do usuario / lista de tarefas do PJe):

1. Analisar tarefas: le a fila de tarefas exibida no painel do PJe, classifica cada uma pelo tipo de providencia necessaria e abre o "Painel de Triagem Inteligente pAIdegua" com um quadro resumo para orientar a priorizacao do dia. As tabelas do painel sao ordenaveis pelos cabecalhos (clique no cabecalho para alternar asc/desc) e cada linha de processo traz tres icones ao lado do numero: hiperlink para os autos, copiar CNJ e abrir a tarefa no PJe (ver secao "Abrir tarefa no PJe").

Grupo "Processo" (aparece quando ha autos abertos):

2. Analisar o processo: executa uma analise guiada pelos criterios configurados na aba "Triagem Inteligente" do popup da extensao (ver passo 7 da Configuracao inicial). Por padrao, adota os criterios da Nota Tecnica n 1/2025 do CLI-JFCE — emenda a inicial, gratuidade de justica, representacao processual, interesse de agir, competencia, prevencao e outros — mas cada criterio pode ser personalizado ou substituido por redacao propria da unidade, e criterios customizados adicionais podem ser incluidos. O status exibido durante a execucao e "Analisando o processo pelos criterios configurados...".

3. Inserir etiquetas magicas: usa o catalogo de etiquetas selecionado na aba "Etiquetas Inteligentes" do popup (ver passo 8 da Configuracao inicial) para sugerir quais etiquetas aplicar ao processo. A IA le os autos, extrai os principais assuntos e temas (chamados aqui de marcadores), compara com as etiquetas que voce marcou como sugestionaveis e abre uma bolha mostrando:
   - Os marcadores encontrados no processo (explicam o "por que" das sugestoes).
   - A lista das etiquetas mais parecidas — cada uma com caixa de selecao e uma barrinha indicando o quanto combina com o processo.
   - Botao "Copiar selecionadas" — copia os nomes das etiquetas marcadas para a area de transferencia, para colar no campo de etiquetas do PJe (a aplicacao automatica no PJe esta prevista para versoes futuras).

Gerar ato de emenda a inicial: quando a analise de processo indicar necessidade de emenda, a extensao oferece a geracao da minuta de ato de emenda a inicial diretamente no chat, ja contemplando os pontos identificados na triagem.

IMPORTANTE: antes do primeiro uso da Triagem Inteligente, revise os criterios na aba "Triagem Inteligente" e o catalogo na aba "Etiquetas Inteligentes" do popup. Esses ajustes alimentam tanto as instrucoes enviadas a IA quanto a comparacao das etiquetas com o processo, e definem o resultado produzido pelas acoes.

O fluxo de emenda a inicial e integrado com o PJe: a bolha da minuta gerada traz o botao "Encaminhar e inserir no PJe" (no lugar do habitual "Inserir no PJe"), que faz o encaminhamento da tarefa e insere o texto da minuta no editor de minutas da nova tarefa, em uma unica acao.

### Painel Gerencial pAIdegua (perfil Gestao)

Disponivel no perfil Gestao quando o usuario esta no "Painel do usuario" do PJe (qualquer grau). Ao clicar em "Painel Gerencial pAIdegua", a extensao:

1. Detecta as tarefas visiveis no painel do PJe e pergunta quais delas devem entrar no relatorio.
2. Busca diretamente no PJe os processos de cada tarefa selecionada, com progresso em tempo real. O cabecalho do relatorio ja mostra o nome da unidade desde o inicio da varredura, para voce ter certeza de qual vara ou juizado esta sendo analisado.
3. Abre uma aba propria com o dashboard gerencial, contendo:
   - Indicadores deterministicos da unidade (total de processos, distribuicao por tarefa, "10 mais antigos por tarefa" etc.).
   - Lista por tarefa, com tabelas ordenaveis e os tres icones por processo (autos, copiar CNJ, abrir tarefa).
   - Botao "Gerar insights" que envia os dados ao servico de IA configurado com os dados sensiveis removidos (o numero do processo e os nomes das partes sao ocultados antes de sair do navegador) e traz de volta alertas, relacionamentos entre tarefas e sugestoes de acao.

O proposito e dar ao diretor de secretaria uma visao consolidada da carga de trabalho da unidade sem precisar rodar relatorios no PJe.

### Prazos na Fita pAIdegua (perfil Gestao)

Tambem disponivel no perfil Gestao quando o usuario esta no "Painel do usuario" do PJe. Foca especificamente nas tarefas cujo nome contem "Controle de prazo" — onde ficam os expedientes com prazo correndo.

Fluxo ao clicar em "Prazos na Fita pAIdegua":

1. A extensao lista as tarefas "Controle de prazo" visiveis e pergunta quais coletar.
2. O dashboard "Prazos na Fita" ja abre em poucos segundos, mesmo antes da coleta terminar, com os cartoes zerados ("0 de X processos") e indicacao de "coleta em andamento". Enquanto o pAIdegua vai buscando os processos no PJe, o dashboard preenche os dados em tempo real — voce ve a tabela crescer e os numeros dos cartoes subirem conforme a varredura avanca.
3. Ao final, o dashboard fica completo com:
   - Cartoes no topo (total de processos, total de expedientes abertos, prazos correndo, vencimentos nos proximos 7 dias).
   - Uma tabela por tarefa, com cabecalhos ordenaveis e coluna "Dias" destacando vencimentos proximos.
   - Blocos colapsaveis para processos sem expedientes abertos e falhas de coleta.
   - Os tres icones usuais por linha (autos, copiar CNJ, abrir tarefa) + a coluna "Encerrar" (ver secao "Encerrar expedientes em lote").

Varredura interrompida e retomada: se a aba do dashboard for fechada, se o navegador cair ou se a sessao do PJe expirar no meio, o dashboard mostra um aviso "Coleta interrompida — retome pelo painel" com o resumo do que ja foi coletado (ex.: "Varredura interrompida em 507 de 2402 processo(s)"). O trabalho feito nao e perdido. Ao voltar ao Painel do usuario do PJe e clicar de novo em "Prazos na Fita pAIdegua" com as mesmas tarefas, o pAIdegua avisa: "Detectei uma varredura anterior interrompida: 507 de 2402 ja coletados; 1895 restam." Voce escolhe:
   - OK = continuar de onde parou (aproveita os 507 ja feitos e coleta so os restantes).
   - Cancelar = comecar do zero (perde o trabalho anterior e refaz tudo).
Se a varredura interrompida tiver mais de 30 minutos, o aviso destaca que os dados dos processos ja coletados podem estar desatualizados — nesse caso, "comecar do zero" e geralmente a escolha certa.

### Abrir tarefa no PJe

Em todas as linhas de processo dos tres paineis (Triagem Inteligente, Painel Gerencial e Prazos na Fita) ha um terceiro icone (seta para fora de uma caixa) ao lado do hiperlink dos autos e do botao de copiar CNJ. O icone abre diretamente a tela de movimentacao da tarefa corrente do processo no PJe — o mesmo destino do link "Abrir tarefa" do widget "Documentos pendentes" do painel nativo.

A janela popup e nomeada por processo, de modo que cliques subsequentes na mesma linha reaproveitam a aba aberta. Se o popup for bloqueado pelo navegador, libere o endereco do PJe no icone de popup bloqueado da barra de enderecos.

Quando a coleta daquela linha nao conseguiu todos os identificadores que o PJe exige para abrir a tarefa correta, o icone nao aparece — e comportamento intencional para evitar abrir tarefa errada.

### Encerrar expedientes em lote (Prazos na Fita)

Ultima coluna da tabela do dashboard "Prazos na Fita". Um clique no icone de lixeira executa, em aba invisivel, o mesmo fluxo que o PJe normalmente exige em tres cliques + confirmacao:

1. Abrir a tela de movimentacao da tarefa.
2. Marcar o cabecalho "Fechado" que seleciona todos os expedientes abertos.
3. Clicar em "Encerrar expedientes selecionados" e confirmar o popup.

A automacao fecha TODOS os expedientes abertos daquela tarefa de uma so vez — use-a quando a providencia padrao for justamente essa (p. ex., "ciencia vencida nao encerrada"). Para encerramento parcial, use o icone "Abrir tarefa" e trate o caso no PJe.

Estados visuais do botao (ficam salvos no navegador e sobrevivem ao recarregar a pagina):

- pronto (lixeira, neutra): clique para fechar todos os expedientes da tarefa.
- executando (spinner, azul): aba invisivel em andamento — aguarde.
- sucesso (check, verde): "Encerrado as HH:MM — N expediente(s)".
- erro (triangulo de aviso, amarelo): clique novamente para tentar de novo; a mensagem indica a causa (sessao expirada, botao nao encontrado etc.).
- nada-a-fazer (traco, cinza): todos os expedientes da tarefa ja estavam fechados.

Execucao uma de cada vez: se voce clicar em varias linhas, o pAIdegua enfileira e processa uma por vez, evitando que disputem a mesma aba/sessao. Multiplas linhas do mesmo processo+tarefa compartilham o estado, mas apenas a linha clicada exibe o rotulo completo — as demais ficam em modo compacto (so o icone) para deixar claro qual foi a linha acionada.

### Falar com o Inovajus (Suporte)

No rodape do popup da extensao ha um link chamado "Suporte". Ele abre uma aba com um formulario simples para registrar duvidas, erros ou sugestoes. Preencha:
- Seu nome.
- Sua unidade (vara, juizado, secretaria).
- Seu e-mail para resposta.
- Tipo de contato (Erro, Duvida, Sugestao, Outro).
- Descricao com suas palavras — se for erro, vale contar o que voce estava tentando fazer e o que apareceu na tela.

A opcao "Incluir informacoes tecnicas" (marcada por padrao) anexa automaticamente a versao do pAIdegua, qual navegador voce esta usando, o sistema e o endereco do PJe aberto no momento. Isso ajuda a equipe a reproduzir o problema mais rapido. Nenhum dado do processo e enviado.

Ao clicar em "Preparar e-mail de suporte", o seu cliente de e-mail (Outlook, em geral) abre com a mensagem pronta e o destinatario ja preenchido (inovajus@jfce.jus.br). Basta conferir e clicar em "Enviar". Caso nada abra, e sinal de que o Outlook nao esta configurado como cliente de e-mail padrao do seu sistema — nesse caso, copie os campos manualmente e envie pelo Outlook Web.

### Pagina de Diagnostico

No rodape do popup da extensao ha um link chamado "Diagnostico". Ele abre uma aba com o historico das ultimas 30 varreduras feitas neste navegador — Painel Gerencial, Prazos na Fita e Triagem Inteligente. Para cada varredura, a pagina mostra:
- Quando foi feita e em qual unidade.
- Quantos processos foram lidos, quantos deram erro e qual foi o tempo total.
- Se a sessao do PJe precisou ser renovada durante a coleta e se a varredura foi retomada.

Esses dados ficam apenas no seu navegador e nunca sao enviados para fora. Servem para voce e o Inovajus entenderem por que uma varredura demorou ou falhou, sem precisar refazer o trabalho so para reproduzir o problema.

Ha tambem dois blocos uteis no topo da pagina de Diagnostico:
- Probe Keycloak: indica se o pAIdegua esta conseguindo ler a sessao autenticada do PJe (serve para diagnosticar problemas de autenticacao).
- Historico HTTP 403: lista as ultimas requisicoes ao PJe que retornaram "acesso negado" — ajuda a identificar se a sessao expirou no meio da coleta.

O botao "Limpar historico" apaga o registro local a qualquer momento.

### Copiar numero CNJ

Ao clicar no icone de copiar ao lado do numero do processo (em qualquer um dos tres paineis), apenas o numero CNJ e copiado — prefixos como "PJEC", "JEF", "PROCAUT" etc. sao removidos automaticamente. Isso vale tambem para as acoes de copia em massa dos relatorios.

### Chat livre

A area de chat na parte inferior permite fazer perguntas livres sobre o processo. Exemplos:
- "Qual o pedido principal do autor?"
- "Existe laudo pericial nos autos? O que conclui?"
- "Resuma as provas documentais"
- "Ha questoes preliminares a resolver?"
- "Liste todos os prazos mencionados"

O chat tambem suporta entrada por voz pelo botao do microfone. A transcricao segue duas estrategias:

- Se o provedor selecionado tem API de transcricao (ex.: OpenAI Whisper, Gemini), o audio gravado e enviado para transcricao remota.
- Caso contrario, a extensao cai para o Web Speech API local do navegador (reconhecimento ao vivo via microfone).

Com Anthropic, a transcricao via API nao esta disponivel; nesse caso use o Web Speech do navegador ou selecione OpenAI/Gemini.

### Acoes disponiveis em cada resposta/minuta

Abaixo de cada resposta da IA (em especial minutas) aparecem botoes de acao rapida. O conjunto de botoes e praticamente o mesmo em todas as bolhas; o que muda e apenas qual botao de insercao no PJe aparece, conforme o contexto:

- Em minutas produzidas pelos botoes de "Minutas com modelo" e pelo "Minutar" (triagem automatica), o rodape traz o botao "Inserir no PJe".
- Em minutas de ato de emenda a inicial geradas pela Triagem Inteligente, o botao "Inserir no PJe" e substituido por "Encaminhar e inserir no PJe" — apropriado para o fluxo de emenda, em que o editor da nova tarefa ainda nao foi criado no momento da geracao.

Os demais botoes seguem disponiveis em ambos os casos:

- Copiar: copia a resposta (markdown) para a area de transferencia.
- Inserir no PJe: insere o texto diretamente no editor de minutas do PJe aberto em outra aba, sem copiar e colar manualmente.
- Encaminhar e inserir no PJe: presente apenas no fluxo de emenda a inicial da Triagem Inteligente — encaminha a tarefa e insere a minuta no editor em uma mesma acao.
- Baixar .doc: salva a resposta como arquivo do Word (.doc), ja com nome sugerido a partir do numero do processo e do tipo de ato.
- Refinar minuta: reaproveita a ultima minuta gerada com uma instrucao adicional digitada pelo usuario (ex.: "encurtar", "mudar o tom", "citar a Sumula 343 do STJ", "reforcar o dispositivo"), preservando o template usado.
- Nova minuta: gera uma nova versao da mesma acao, do zero, sem modelo de referencia.

---

## PARTE 3 - ORGANIZACAO DA PASTA DE MODELOS

Para melhor aproveitamento da busca automatica de modelos, organize seus arquivos em subpastas:

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
- Use nomes descritivos nos arquivos (a busca considera o nome e o conteudo).
- Subpastas com nomes como "procedente", "improcedente", "decisao", "despacho" recebem prioridade automatica na busca do botao correspondente.
- Formatos aceitos: .docx, .doc, .odt, .rtf, .pdf, .txt, .md
- Apos adicionar ou alterar modelos, clique em "Reindexar agora" na pagina de opcoes.

---

## PARTE 4 - DICAS E SOLUCAO DE PROBLEMAS

- Extensao nao aparece no PJe: Verifique primeiro se o interruptor "Extensao Ativada" no topo do popup do pAIdegua esta ligado — se estiver desligado, o pAIdegua fica invisivel no PJe de proposito. Se estiver ligado, confirme tambem se a extensao esta ativa em chrome://extensions ou edge://extensions. Apos qualquer mudanca, recarregue a pagina do PJe.

- Erro ao extrair documentos: Alguns documentos podem retornar vazio na primeira tentativa. A extensao faz ate 3 tentativas automaticas com estrategias diferentes. Se persistir, recarregue a pagina do PJe e tente novamente.

- Documentos de audio/video: Arquivos de midia (MP3, MP4, etc.) sao detectados automaticamente e marcados como conteudo nao-textual, sem gerar erro.

- OCR lento: O OCR roda localmente no navegador. Documentos com muitas paginas podem demorar. Ajuste o limite de paginas nas configuracoes.

- Minuta usando modelo errado: A busca automatica usa o conteudo do processo para encontrar o modelo mais similar. Se o resultado nao for adequado, voce pode refinar reorganizando seus modelos em subpastas mais especificas ou gerando do zero.

- Chave de API invalida: Use o botao "Testar" nas configuracoes para verificar. Cada provedor tem seu formato de chave. Certifique-se de que a chave corresponde ao provedor selecionado.

- Atualizacao da extensao: Quando receber uma nova versao do "dist.zip", extraia o arquivo sobrescrevendo a pasta "dist" ja existente e depois va em chrome://extensions ou edge://extensions e clique no botao de atualizar (seta circular) no card da extensao.

- Painel Gerencial ou Prazos na Fita abrem vazios ou com erro "Sem credenciais de acesso": abra o Painel do usuario do PJe e clique em qualquer tarefa antes de acionar os botoes do perfil Gestao. Essa primeira interacao captura a chave de sessao que o pAIdegua usa para buscar os dados no PJe. Se a sessao do PJe tiver expirado, refaca o login e tente novamente. Em varreduras longas, o pAIdegua renova a sessao do PJe automaticamente em segundo plano quando percebe que ela esta prestes a expirar — por isso, na maioria dos casos, a coleta segue ate o fim mesmo em unidades grandes. Se ainda assim a varredura parar, abra a pagina de Diagnostico (rodape do popup) para conferir se houve bloqueios (bloco "Historico HTTP 403") ou problema de sessao (bloco "Probe Keycloak").

- Varredura de Prazos na Fita parou no meio: o trabalho ja feito fica salvo. Vá ao Painel do usuario do PJe, clique de novo em "Prazos na Fita pAIdegua", selecione as mesmas tarefas, e quando aparecer o aviso "Detectei uma varredura anterior interrompida" escolha OK para continuar de onde parou. Se a interrupcao for antiga (mais de 30 minutos), o aviso recomenda comecar do zero para capturar movimentacoes novas.

- Icone "Abrir tarefa" nao aparece em alguma linha: a coleta daquela linha nao conseguiu todos os identificadores que o PJe exige para abrir a tarefa correta. Recarregue o painel do PJe, abra uma tarefa para que o pAIdegua capture as credenciais de acesso e rode a coleta de novo.

- Popup "Abrir tarefa" bloqueado: o navegador bloqueou a janela popup. Clique no icone de popup bloqueado na barra de enderecos do navegador e libere o endereco do PJe.

- "Encerrar expedientes" fica em erro: verifique se a sessao do PJe esta ativa (abra o PJe em outra aba). Se o PJe tiver mudado a estrutura da tela de movimentacao da tarefa, reporte ao Inovajus — a manutencao envolve ajustar a automacao. Enquanto isso, o encerramento pode ser feito manualmente a partir do icone "Abrir tarefa".

- "Inserir etiquetas magicas" nao traz sugestoes: confirme na aba "Etiquetas Inteligentes" do popup que (a) o catalogo foi buscado (botao "Buscar catalogo do PJe") e (b) ha etiquetas marcadas no painel "Sugestionaveis (selecionadas)". Sem etiquetas sugestionaveis, nao ha o que sugerir.