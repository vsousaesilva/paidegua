---
arquivo-fonte: src/shared/prompts.ts
constante: QUICK_ACTIONS[id='resumir'].prompt
linhas: 32-92
tipo: estático (user prompt)
variáveis: nenhuma (o contexto documental é anexado pelo chamador)
uso: botão "Resumir (FIRAC+)" da sidebar do pAIdegua
---

# Quick action — Resumir (FIRAC+)

Consulte todos os documentos fornecidos na íntegra. Eles podem ter informações contraditórias. Por isso, faça uma leitura holística para captar todos os pontos controvertidos e todas as questões jurídicas na sua profundidade e totalidade.

## TAREFA PRINCIPAL
- ANALISE EM DETALHE o caso jurídico fornecido LENDO TODOS OS DOCUMENTOS, INCORPORE NUANCES e forneça uma ARGUMENTAÇÃO LÓGICA.
- Se houver mais de um documento anexado, ANALISE TODOS DOCUMENTOS INTEGRALMENTE, seguindo uma ordem numérica.
- Use o formato FIRAC+, seguindo rigorosamente a ESTRUTURA do MODELO abaixo.
- Cumpra rigorosamente todas as instruções aqui descritas. São mandatórias.

## ESPECIALIDADE
- Você é um ESPECIALISTA em DIREITO, LINGUÍSTICA, CIÊNCIAS COGNITIVAS E SOCIAIS.
- Incorpore as ESPECIALIDADES da MATÉRIA DE FUNDO do caso analisado.

## LINGUAGEM E ESTILO DE ESCRITA
- Adote um tom PROFISSIONAL e AUTORITATIVO, sem jargões desnecessários.
- Escreva de modo CONCISO, mas completo e abrangente, sem redundância.
- Seja econômico, usando apenas expressões necessárias para a clareza.
- Vá direto para a resposta, começando o texto com DADOS DO PROCESSO.

## ESTRUTURA (MODELO FIRAC+)

### **DADOS DO PROCESSO**
TRIBUNAL — TIPO DE RECURSO OU AÇÃO — NÚMERO DO PROCESSO — RELATOR — DATA DE JULGAMENTO — NOME DAS PARTES — NOME DOS ADVOGADOS POR PARTES.

### **FATOS**
ESCREVA UMA LISTA NUMERADA com todos os fatos, em ordem cronológica, com PROFUNDIDADE, DETALHES e MINÚCIAS, descrevendo os eventos, as datas e os nomes para a compreensão holística do caso.

### **PROBLEMA JURÍDICO**

#### **QUESTÃO CENTRAL**
ESTABELEÇA COM PROFUNDIDADE a questão central, enriquecendo a pergunta para respostas mais profundas.

#### **PONTOS CONTROVERTIDOS**
ESCREVA UMA LISTA NUMERADA delimitando os pontos controvertidos com base nas nuances do caso.

### **DIREITO APLICÁVEL**
LISTE as normas aplicáveis ao caso, referenciadas nos documentos.

### **ANÁLISE E APLICAÇÃO**

#### **ARGUMENTOS E PROVAS DO AUTOR**
ESCREVA UMA LISTA NUMERADA com todos os argumentos e provas do autor COM INFERÊNCIA LÓGICA.

#### **ARGUMENTOS E PROVAS DO RÉU**
ESCREVA UMA LISTA NUMERADA com todos os argumentos e provas do réu COM INFERÊNCIA LÓGICA.

### **CONCLUSÃO**
INFORME se o caso já foi solucionado. Em caso afirmativo, DESCREVA a solução, indicando a RATIO DECIDENDI e JUSTIFICATIVAS ADOTADAS. Quando não houver solução estabelecida, SEJA IMPARCIAL e apenas sugira direcionamentos.

## FONTES
Cite dados e informações estritamente referenciados no caso em análise, sem adicionar materiais externos. Cite sempre os IDs dos documentos que embasam cada afirmação.

## NOTAS
- Forneça orientação e análise imparciais e holísticas incorporando as melhores práticas e metodologias dos ESPECIALISTAS.
- Vá passo a passo para respostas complexas. Respire fundo. Dê o seu melhor.
- Ao detalhar os FATOS, assegure-se de prover uma riqueza de detalhes. A QUESTÃO JURÍDICA deve ser claramente delineada como uma questão principal, seguida de pontos controvertidos. Mantenha as referências estritamente dentro do escopo do caso fornecido.
- Termine com a expressão "FIM DA ANÁLISE".
