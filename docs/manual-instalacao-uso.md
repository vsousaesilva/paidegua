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

1. LGPD: Leia o aviso de privacidade e marque a caixa de ciencia. A extensao envia o conteudo dos documentos para a API do provedor de IA escolhido. Confirme que esta ciente.

2. Provedor e modelo: Selecione o provedor de IA (Google Gemini, Anthropic ou OpenAI) e o modelo desejado.

3. Chave de API: Cole a chave de API do provedor selecionado no campo indicado. Clique em "Salvar" e depois em "Testar" para verificar se a conexao esta funcionando. A chave fica armazenada apenas no navegador local.

4. OCR (opcional): Marque "Rodar OCR automaticamente" se deseja que documentos digitalizados (imagens sem texto) sejam processados por reconhecimento optico de caracteres. O OCR roda localmente, sem enviar imagens ao provedor de IA. Ajuste o limite de paginas por documento conforme necessario.

5. Modelos de minuta (opcional): Clique em "Gerenciar modelos" para abrir a pagina de configuracao. Ali voce pode selecionar uma pasta do seu computador com seus modelos de minutas (sentencas, decisoes, despachos). A extensao aceita arquivos .docx, .doc, .odt, .rtf, .pdf, .txt e .md. Organize por subpastas (ex.: "procedente", "improcedente", "despachos", "decisoes") para melhor selecao automatica.

6. Termos de uso e governanca: No popup ha a secao "Termos de uso e Governanca (Res. CNJ 615/2025)" com o enquadramento da ferramenta como de baixo risco (Anexo BR4/BR8), a obrigacao de supervisao humana (art. 19, IV e art. 34), a politica de privacidade/anonimizacao (art. 30), a trilha de auditoria (art. 19, par. 6 e art. 27 - EM DESENVOLVIMENTO, ainda nao implementada na versao atual) e a identificacao de conteudo gerado com apoio de IA (art. 21). Leia antes do uso em producao.

---

## PARTE 2 - USO

### Acessando o pAIdegua

1. Acesse o PJe e abra um processo (tela de autos digitais).
2. O botao flutuante do pAIdegua aparecera no canto da pagina.
3. Clique no botao para abrir o painel lateral.

### Painel lateral

O painel exibe:
- Nome da extensao e provedor/modelo em uso
- Numero do processo detectado e o grau identificado automaticamente (1G, 2G ou turma recursal)
- Barra de ferramentas com os botoes de acao, ja adaptados ao grau do processo
- Area de chat para interacao livre com a IA

A deteccao de grau e feita pelo dominio do PJe (pje1g.trf5.jus.br = 1o grau; pje2g.trf5.jus.br = turma recursal/2o grau) e altera automaticamente o conjunto de botoes de minuta exibidos.

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

Abaixo de cada resposta da IA (em especial minutas) aparecem botoes de acao rapida:

- Copiar: copia a resposta (markdown) para a area de transferencia.
- Inserir no PJe: insere o texto diretamente no editor CKEditor do PJe aberto em outra aba, sem copiar e colar manualmente.
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

- Extensao nao aparece no PJe: Verifique se a extensao esta ativa em chrome://extensions ou edge://extensions. Recarregue a pagina do PJe.

- Erro ao extrair documentos: Alguns documentos podem retornar vazio na primeira tentativa. A extensao faz ate 3 tentativas automaticas com estrategias diferentes. Se persistir, recarregue a pagina do PJe e tente novamente.

- Documentos de audio/video: Arquivos de midia (MP3, MP4, etc.) sao detectados automaticamente e marcados como conteudo nao-textual, sem gerar erro.

- OCR lento: O OCR roda localmente no navegador. Documentos com muitas paginas podem demorar. Ajuste o limite de paginas nas configuracoes.

- Minuta usando modelo errado: A busca automatica usa o conteudo do processo para encontrar o modelo mais similar. Se o resultado nao for adequado, voce pode refinar reorganizando seus modelos em subpastas mais especificas ou gerando do zero.

- Chave de API invalida: Use o botao "Testar" nas configuracoes para verificar. Cada provedor tem seu formato de chave. Certifique-se de que a chave corresponde ao provedor selecionado.

- Atualizacao da extensao: Quando receber uma nova versao do "dist.zip", extraia o arquivo sobrescrevendo a pasta "dist" ja existente e depois va em chrome://extensions ou edge://extensions e clique no botao de atualizar (seta circular) no card da extensao.