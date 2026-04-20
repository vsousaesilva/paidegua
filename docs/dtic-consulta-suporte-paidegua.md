# Minuta — Solicitação de Informações à DTIC/JFCE

---

**À** Diretoria de Tecnologia da Informação e Comunicação (DTIC) — JFCE
**De:** [Unidade solicitante / servidor responsável]
**Assunto:** Consulta técnica sobre serviços Microsoft 365 para estruturação de canal de suporte da extensão *paidegua*
**Data:** 20/04/2026

---

## 1. Contexto

A extensão *paidegua*, desenvolvida para apoiar servidores da JFCE na utilização do PJe e em rotinas de gestão de gabinete e secretaria, encontra-se em uso crescente entre as unidades judiciárias. Na medida em que a base de usuários se amplia, torna-se necessário estruturar um **canal formal e rastreável de suporte técnico** aos usuários.

A concepção do serviço prevê:

- **Canal primário:** botões de suporte integrados à própria extensão (abertura de chamado a partir do contexto de uso, com coleta automática de metadados — versão, URL, ambiente, logs relevantes);
- **Canal alternativo:** caixa postal institucional dedicada (sugestão: `suportepaidegua@jfce.jus.br`), para usuários que prefiram o envio por e-mail ou que não tenham a extensão ativa no momento da solicitação;
- **Retaguarda de atendimento:** painel unificado, no modelo *kanban*, em que as demandas — originadas por qualquer dos dois canais — sejam triadas, priorizadas, tratadas e respondidas pela equipe de suporte, com apoio de inteligência artificial para classificação e sumarização inicial;
- **Notificação de conclusão:** envio automático de resposta ao solicitante ao encerramento do chamado.

A proposta é construir a solução **preferencialmente sobre serviços já licenciados no *tenant* Microsoft 365 da JFCE**, evitando a contratação de novas ferramentas e mantendo a operação dentro do perímetro institucional.

## 2. Objeto da consulta

Solicita-se à DTIC manifestação técnica e, quando aplicável, autorização formal sobre os pontos a seguir:

### 2.1. Caixa postal institucional

a) Viabilidade de criação da *shared mailbox* `suportepaidegua@jfce.jus.br` (ou nome equivalente a ser definido), com delegação aos servidores designados para o suporte;
b) Licenciamento aplicável e eventuais custos.

### 2.2. Microsoft Graph API e autenticação

a) Possibilidade de registro de aplicação (*App Registration*) no Azure Active Directory/Entra ID da JFCE, com as permissões mínimas necessárias para:
 - leitura de e-mails da caixa compartilhada de suporte;
 - envio de e-mails em nome da caixa compartilhada;
 - autenticação de usuários da extensão via SSO institucional (fluxo OAuth 2.0 / OIDC);
b) Política vigente para concessão dessas permissões e rito de aprovação.

### 2.3. Power Automate

a) Disponibilidade de licenciamento Power Automate (Premium, se necessário) para:
 - disparo de fluxo a cada novo e-mail recebido na caixa de suporte;
 - integração com serviço de IA para classificação e extração de metadados;
 - criação e movimentação de cartões no painel kanban;
 - envio automatizado de resposta ao solicitante;
b) Eventuais limites de execução (*API calls*, fluxos concorrentes) no plano atual.

### 2.4. Componente de IA para triagem

a) Existência, no *tenant* da JFCE, de acesso a **Azure OpenAI Service** em região brasileira ou com DPA/contrato que atenda à LGPD e às normativas do CNJ (Resolução CNJ nº 332/2020 e atos correlatos);
b) Alternativamente, disponibilidade do **AI Builder** (Power Platform) para tarefas de classificação e extração;
c) Orientações da DTIC quanto ao tratamento de conteúdo de e-mails institucionais por modelos de IA — em especial sobre dados pessoais, dados de processos e informações cobertas por sigilo.

### 2.5. Painel de gestão (kanban) e base de conhecimento

a) Preferência institucional entre as alternativas nativas: **Microsoft Planner**, **Microsoft Lists**, **SharePoint** ou **Azure DevOps Boards**;
b) Disponibilidade de site SharePoint institucional para armazenar o histórico estruturado de chamados e constituir base de conhecimento auditável;
c) Políticas de retenção, *backup* e classificação de informação aplicáveis.

### 2.6. Integração com a extensão

a) Viabilidade de a extensão *paidegua*, executada no navegador dos servidores, autenticar o usuário via conta institucional e submeter chamados diretamente ao fluxo descrito (sem passar obrigatoriamente pelo e-mail);
b) Eventuais restrições de CSP (*Content Security Policy*), proxy ou firewall corporativo que possam impactar chamadas à Microsoft Graph API a partir do ambiente interno da JFCE.

### 2.7. Conformidade e governança

a) Necessidade de parecer prévio do Encarregado pelo Tratamento de Dados Pessoais (DPO) ou manifestação específica sob a ótica da LGPD;
b) Eventual necessidade de registro da solução no inventário de sistemas / catálogo de serviços da DTIC;
c) Requisitos de logs, auditoria e segurança a serem observados no desenho da solução.

## 3. Informações complementares

- A equipe responsável pela extensão está à disposição para apresentação técnica, em reunião ou por escrito, sobre a arquitetura pretendida;
- Não se pretende, neste momento, contratação ou aquisição de novos serviços — apenas a utilização de recursos já disponíveis no *tenant* institucional;
- Busca-se, como resultado, um serviço de suporte **auditável, em conformidade com a LGPD e com as normativas do CNJ, e operado integralmente dentro da infraestrutura da JFCE**.

## 4. Pedido

Diante do exposto, solicita-se à DTIC:

a) Manifestação técnica sobre os pontos 2.1 a 2.7;
b) Indicação das licenças, permissões e autorizações necessárias, com o respectivo rito formal;
c) Caso pertinente, designação de ponto focal na DTIC para acompanhamento do desenho e da implantação da solução.

Atenciosamente,

**[Nome do servidor]**
[Cargo / Unidade]
Justiça Federal no Ceará
