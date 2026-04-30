---
title: Política de Privacidade — pAIdegua
---

# Política de Privacidade — pAIdegua

**Última atualização:** 29 de abril de 2026
**Versão da extensão:** 1.2.0

A extensão **pAIdegua** é desenvolvida pelo **Laboratório de Inovação da Justiça Federal do Ceará (Inovajus / JFCE)** e destina-se ao uso institucional por magistrados e servidores da Justiça Federal da 5ª Região. Este documento descreve, com transparência, quais dados a extensão coleta, processa e transmite, em conformidade com a **Lei nº 13.709/2018 (LGPD)** e com a **Resolução CNJ nº 615/2025**, que regulamenta o uso de Inteligência Artificial no Poder Judiciário.

## 1. Identificação do controlador

- **Controlador:** Justiça Federal de 1º Grau no Ceará — Inovajus / JFCE
- **Contato (encarregado):** [inovajus@jfce.jus.br](mailto:inovajus@jfce.jus.br)
- **Endereço:** Praça Murilo Borges, s/n — Centro, Fortaleza/CE

## 2. Natureza da extensão

O pAIdegua é uma **ferramenta de apoio** que se integra ao Processo Judicial Eletrônico (PJe) para facilitar a redação de minutas, a triagem inicial de processos, a organização de pautas periciais e a consulta a documentos dos autos com auxílio de Inteligência Artificial generativa. **Toda decisão jurídica permanece exclusivamente humana.**

A extensão classifica-se como **ferramenta de baixo risco** segundo o Anexo da Resolução CNJ 615/2025 (itens BR4 e BR8 — produção de textos de apoio e anonimização).

## 3. Dados pessoais tratados

### 3.1 Dados armazenados localmente no navegador do usuário

Ficam exclusivamente em `chrome.storage.local`, **sem transmissão a qualquer servidor do Inovajus**:

- Chave de API do provedor de IA escolhido pelo usuário (Anthropic, OpenAI ou Google Gemini), com proteção básica;
- Preferências de configuração (perfil de trabalho, modelo de IA preferido, parâmetros de OCR);
- Critérios personalizados de triagem inicial e prompts customizados;
- Cadastro local de peritos (nome, etiquetas vinculadas, assuntos preferenciais);
- Pasta local com modelos de minuta, opcionalmente indicada pelo usuário;
- Logs de diagnóstico anônimos (até 50 entradas, sem conteúdo de processos), exibidos apenas na tela de Diagnóstico da extensão.

**Conteúdo de processos judiciais não é persistido** em `storage.local`. Os payloads dos painéis (Triagem, Gestão, Perícias, Prazos na Fita) ficam em `storage.session` ou `IndexedDB` apenas durante o uso e são apagados automaticamente ao fechar o navegador ou a aba do dashboard.

### 3.2 Dados tratados pelo backend de autenticação do Inovajus

Para uso da extensão é necessário login. O backend do Inovajus (Google Apps Script, restrito a domínios institucionais autorizados) recebe e trata:

- **E-mail institucional do usuário** — comparado contra lista de autorização (whitelist) gerida pelo Inovajus;
- **Código numérico de uso único** (OTP) enviado por e-mail — utilizado uma única vez para validar a posse da caixa institucional;
- **JWT (token assinado)** gerado após verificação, com validade de 90 dias, armazenado **somente no navegador do usuário** — o servidor não mantém sessões.

O backend **não armazena** conteúdo de processos, documentos, prompts ou respostas da IA. Os únicos registros mantidos são: a linha do usuário na planilha de whitelist (e-mail, status, data, anotação administrativa) e códigos OTP temporários (descartados após uso ou em até 10 minutos).

### 3.3 Dados transmitidos a provedores externos de IA

Quando o usuário aciona uma funcionalidade que utiliza IA (por exemplo: gerar minuta, analisar processo, sugerir etiquetas), o conteúdo selecionado dos documentos é transmitido **diretamente do navegador do usuário** para o provedor de IA escolhido, autenticado com a chave de API do próprio usuário:

- **Anthropic Claude** — [Política de privacidade](https://www.anthropic.com/legal/privacy)
- **OpenAI** — [Política de privacidade](https://openai.com/policies/privacy-policy)
- **Google Gemini** — [Política de privacidade](https://policies.google.com/privacy)

A extensão **não atua como intermediária** dessa transmissão: o servidor do Inovajus não recebe os dados enviados aos provedores. A política de privacidade do provedor escolhido é aplicável a esse fluxo.

#### Anonimização preventiva

Antes do envio aos provedores, a extensão executa rotina de **anonimização** que oculta CPFs, RGs e dados bancários identificados nos documentos. Nomes próprios são substituídos por placeholders genéricos quando solicitado pelo usuário no fluxo de triagem.

#### Restrição contratual de treinamento

A extensão é configurada para uso com chaves de API vinculadas a planos **Enterprise**, **Business** ou equivalentes que garantem contratualmente que os dados trafegados **não são utilizados para treinamento de modelos** comerciais de terceiros (Art. 19, II, da Resolução CNJ 615/2025). Cabe ao usuário verificar se a chave de API que utiliza está vinculada a esse tipo de plano.

## 4. Finalidades e bases legais

| Finalidade | Base legal (LGPD) |
|---|---|
| Autenticar o servidor/magistrado autorizado a usar a extensão | Art. 7º, II — cumprimento de obrigação legal/regulatória; e Art. 7º, V — execução de políticas públicas |
| Apoio à confecção de atos judiciais e à triagem processual | Art. 7º, III — execução de políticas públicas pelo Poder Judiciário |
| Anonimização preventiva de dados sensíveis dos autos | Art. 7º, IX — interesse legítimo, com adoção de salvaguarda compatível |

## 5. Compartilhamento

O pAIdegua **não compartilha dados pessoais** com terceiros além do que está descrito no item 3.3 (provedores de IA, sob iniciativa do usuário e com a chave de API dele). Não há compartilhamento com fins de marketing, publicidade, análise comportamental ou perfilamento.

## 6. Telemetria

O Inovajus **não coleta telemetria de uso** da extensão. Não há contador de execuções, registro de funcionalidades acionadas, identificadores únicos de instalação ou eventos enviados a servidores do Inovajus. A única comunicação recorrente da extensão com o Inovajus é a revalidação periódica do JWT de login (a cada 12 horas, durante uso ativo) — exclusivamente para verificar se o acesso do usuário foi revogado.

## 7. Retenção

- **Dados locais:** mantidos até que o usuário desinstale a extensão, limpe os dados do navegador ou utilize a função "Remover" da própria extensão (chave de API, configurações etc.).
- **Whitelist no backend:** mantida pelo período em que o usuário fizer parte do piloto institucional. A revogação é feita pela equipe Inovajus mediante desativação da linha — o JWT do usuário deixa de ser aceito na próxima revalidação.
- **Códigos OTP:** descartados após uso bem-sucedido ou em 10 minutos.

## 8. Direitos do titular (LGPD, art. 18)

O usuário/titular pode, a qualquer tempo:

- Confirmar a existência de tratamento;
- Acessar seus dados;
- Corrigir dados incompletos, inexatos ou desatualizados;
- Solicitar a anonimização, bloqueio ou eliminação de dados desnecessários;
- Solicitar a portabilidade dos dados;
- Revogar o consentimento;
- Solicitar informações sobre compartilhamento.

As solicitações devem ser dirigidas a [inovajus@jfce.jus.br](mailto:inovajus@jfce.jus.br).

## 9. Segurança

- Comunicação com o backend de autenticação ocorre exclusivamente sobre **HTTPS** com TLS atualizado.
- O JWT é assinado com chave privada (HS256) gerida exclusivamente pelo Inovajus.
- A chave de API do provedor de IA fica em `chrome.storage.local`, com proteção compatível com o que o navegador oferece (sandbox por extensão); recomenda-se uso somente em estações institucionais de trabalho.
- O acesso ao backend é restrito por domínio institucional (`@trf5.jus.br`, `@jfce.jus.br`, `@jfrn.jus.br`, `@jfpb.jus.br`, `@jfpe.jus.br`, `@jfal.jus.br`, `@jfse.jus.br`) e por whitelist administrada pelo Inovajus.

## 10. Alterações

Esta política pode ser revista para refletir mudanças regulatórias ou novas funcionalidades. Alterações relevantes serão comunicadas aos usuários autorizados pelo e-mail cadastrado na whitelist e refletidas no número de versão acima.

## 11. Conformidade normativa

A extensão e seu tratamento de dados observam:

- **Lei nº 13.709/2018** — Lei Geral de Proteção de Dados Pessoais (LGPD);
- **Resolução CNJ nº 615/2025** — uso de IA no Poder Judiciário;
- **Resolução CNJ nº 363/2021** — Política de Comunicação Social do Poder Judiciário (no que couber);
- Política institucional do TRF da 5ª Região para uso de tecnologias.

---

Em caso de dúvida, sugestão ou denúncia: [inovajus@jfce.jus.br](mailto:inovajus@jfce.jus.br).
