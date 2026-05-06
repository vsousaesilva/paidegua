# Publicação do pAIdegua no Chrome Web Store e Edge Add-ons

Guia operacional para disponibilizar a extensão nas lojas oficiais e
manter o ciclo de atualização pós-publicação.

> **Status atual (04/05/2026):**
> - Chrome Web Store: **publicada** com ID
>   `belangijcipajlpcofhljhgjeemkbofk` (versão atual no store: v1.2.0).
>   Listing: https://chromewebstore.google.com/detail/belangijcipajlpcofhljhgjeemkbofk/preview
> - Edge Add-ons: ainda não submetida.
> - Publicação automática via GitHub Actions: configurada em
>   `.github/workflows/release-extension.yml` job `publish-cws`. Cada
>   `git tag v*.*.*` empacota o zip + sobe na CWS + submete pra revisão.
>   Setup OAuth da Google Cloud descrito na §1.5 abaixo.

---

## 1. Chrome Web Store

### Conta de desenvolvedor

- Acesse https://chrome.google.com/webstore/devconsole
- Entre com conta Google institucional (recomendado: conta @jfce.jus.br
  ou @trf5.jus.br para vínculo institucional)
- **Taxa única de US$ 5,00** (cartão internacional) — paga uma vez por
  conta, vale para todas as extensões
- Verifique identidade (Google pode pedir documento) e e-mail

### Preparação do pacote

1. Ajuste o `manifest.json`:
   - `version`: `"1.0.0"` (obrigatório bumpar a cada upload)
   - `name`, `description`, `author`, `homepage_url`
   - Remova `"key"`, permissões não usadas, URLs de `content_scripts`
     que não forem necessárias
2. Rode o build de produção: `npm run build`
3. Compacte a pasta `dist/` em `.zip` (só o conteúdo — sem a pasta pai)

### Materiais obrigatórios

- **Ícone** 128×128 PNG
- **Pelo menos 1 screenshot** 1280×800 ou 640×400 PNG
- **Descrição curta** (até 132 caracteres) e longa
- **Política de privacidade** publicada em URL pública (exige porque a
  extensão envia dados a APIs de IA — LGPD/CWS). Pode ser página
  estática no site da JFCE/TRF5
- **Categoria** (Productivity)
- **Idioma principal** (Português – Brasil)

### Submissão

1. Dashboard → "Novo item" → upload do `.zip`
2. Preencha ficha: descrição, screenshots, categoria, país
3. **Declare "Single purpose"** — descreva o propósito único
   (assistente de IA para análise de processos PJe)
4. **Justificativas de permissão** — uma por uma (`activeTab`,
   `storage`, `scripting`, hosts `pje1g.trf5.jus.br` /
   `pje2g.trf5.jus.br`). Seja específico: *"acesso a pje1g/pje2g porque
   a extensão lê a árvore de documentos para extrair o texto
   processual"*
5. **Data handling disclosure**: declare que envia conteúdo processual
   a APIs de IA do provedor escolhido pelo usuário, com chave fornecida
   por ele
6. **Visibilidade**: considere **"Não listada"** (Unlisted) — só
   instala quem tem o link. Para uso interno institucional é o mais
   adequado; evita escrutínio público e uso externo indevido.
   Alternativa mais restrita: **"Privada"** para um Google Workspace
   específico (exige domínio Workspace da JFCE — se houver)

### Revisão

- Prazo típico: 1 a 7 dias úteis (primeira submissão costuma demorar
  mais)
- Rejeições comuns: permissões não justificadas, política de privacidade
  ausente, screenshots fora do padrão, descrição genérica

---

## 1.5 Publicação automática via GitHub Actions (configurada)

A partir de 04/05/2026, cada `git tag v*.*.*` no repositório
`vsousaesilva/paidegua` dispara o workflow
`.github/workflows/release-extension.yml` que:

1. Empacota `dist/` em `dist vX.Y.Z.zip`
2. Cria GitHub Release com o zip como asset
3. **Faz upload + submete pra revisão na Chrome Web Store automaticamente**
   (job `publish-cws`)

### Setup único (faça apenas uma vez)

Você precisa cadastrar 4 secrets no repositório GitHub
(Settings → Secrets and variables → Actions → New repository secret):

#### A) `CWS_EXTENSION_ID`

Valor: `belangijcipajlpcofhljhgjeemkbofk` (o ID público da extensão).

#### B–D) OAuth tokens da Google Cloud

A Chrome Web Store API exige autenticação OAuth 2.0. Setup em 4 passos:

##### Passo 1 — Habilitar a API

1. Acesse https://console.cloud.google.com/
2. Selecione (ou crie) um projeto — o mesmo da conta de desenvolvedor da CWS
3. **APIs & Services** → **Library** → busca "Chrome Web Store API"
4. **Enable**

##### Passo 2 — Criar OAuth Client ID

1. **APIs & Services** → **Credentials** → **+ CREATE CREDENTIALS** →
   **OAuth client ID**
2. Application type: **Desktop app**
3. Name: `paidegua-cws-publish`
4. **Create**
5. Copie o **Client ID** (algo como
   `xxxxxxxxxxxx-yyyyyyyyyyyyyyyy.apps.googleusercontent.com`) e o
   **Client secret** (`GOCSPX-...`). Você usará estes valores adiante.

##### Passo 3 — Gerar refresh token (uma vez só)

A forma mais simples no Windows:

```cmd
:: Substitua CLIENT_ID e CLIENT_SECRET pelos valores do passo 2.
:: Vai abrir uma URL no navegador — autorize com a conta Google
:: associada à conta de desenvolvedor da CWS.

set CLIENT_ID=xxxx-yyyy.apps.googleusercontent.com
set CLIENT_SECRET=GOCSPX-zzzzzz

:: 1. Cole no navegador (em uma linha):
:: https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=%CLIENT_ID%&redirect_uri=urn:ietf:wg:oauth:2.0:oob

:: 2. Após autorizar, copie o "código de autorização" exibido na tela.
:: 3. Troca o código por refresh_token via curl:
curl "https://accounts.google.com/o/oauth2/token" -d "client_id=%CLIENT_ID%&client_secret=%CLIENT_SECRET%&code=COLE_O_CODIGO_AQUI&grant_type=authorization_code&redirect_uri=urn:ietf:wg:oauth:2.0:oob"
```

A resposta JSON traz `"refresh_token": "1//0gxxxxxxxxxx"`. **Copie esse
refresh_token** — é ele que vai pro GitHub Secret. (O `access_token` da
mesma resposta dura só 1h e não precisa salvar.)

> Alternativa visual: https://developer.chrome.com/docs/webstore/using-api
> tem um passo a passo com prints. O Google OAuth Playground também
> funciona, mas exige adicionar `developers.google.com/oauthplayground`
> como redirect URI no client.

##### Passo 4 — Cadastrar os 4 secrets no GitHub

Em https://github.com/vsousaesilva/paidegua/settings/secrets/actions:

| Secret | Valor |
|---|---|
| `CWS_EXTENSION_ID` | `belangijcipajlpcofhljhgjeemkbofk` |
| `CWS_CLIENT_ID` | `xxxx-yyyy.apps.googleusercontent.com` (do passo 2) |
| `CWS_CLIENT_SECRET` | `GOCSPX-zzzzzz` (do passo 2) |
| `CWS_REFRESH_TOKEN` | `1//0gxxxxxxxxxx` (do passo 3) |

### Variável opcional `SUBMIT_FOR_REVIEW`

Por padrão, o job `publish-cws` faz **upload + submit pra revisão**. Se
quiser apenas **upload em modo draft** (sem submeter), defina como
variável de repo (não secret):

- Settings → Secrets and variables → Actions → **Variables** → New
- Name: `SUBMIT_FOR_REVIEW`
- Value: `false`

Aí você submete manualmente pelo Developer Dashboard quando quiser.

### Como rodar

Após o setup acima:

```cmd
:: 1. Bumpar versão em manifest.json e package.json
:: 2. Commit + push em main
git add manifest.json package.json
git commit -m "v1.X.Y: ..."
git push origin main

:: 3. Tag e push da tag
git tag v1.X.Y
git push origin v1.X.Y
```

Em ~5 min: tag → release-extension empacota → publish-cws sobe na CWS.
Acompanhe em https://github.com/vsousaesilva/paidegua/actions e em
https://chrome.google.com/webstore/devconsole/.

### Permissões alteradas exigem nova justificativa

Se a versão nova mudou `host_permissions` ou `permissions`, a CWS
**bloqueia a submissão automática** até você atualizar a justificativa
manualmente no Developer Dashboard. O upload sobe normalmente, mas o
submit fica pendente "Aguardando revisão de permissões". Veja no
Dashboard e responda às perguntas da Google.

A v1.3.0 ganhou `https://kanban.paidegua.ia.br/*` em `host_permissions`
(backend de auth do Inovajus) — na primeira publicação, justifique:

> "Backend institucional de autenticação do Inovajus / JFCE. Recebe
> e-mail e código OTP para validar acesso de servidores autorizados à
> extensão. Não envia conteúdo processual. Substitui backend legado em
> Google Apps Script."

---

## 2. Microsoft Edge Add-ons

### Conta de desenvolvedor

- https://partner.microsoft.com/dashboard/microsoftedge → "Registrar"
- **Gratuito** (sem taxa)
- Conta Microsoft institucional

### Submissão

- O mesmo `.zip` do Chrome serve (MV3 é compatível)
- Materiais análogos (ícones, screenshots, política de privacidade)
- Não há "Unlisted" como no Chrome, mas há **"Hidden"** (equivalente)
- Justifique permissões igual ao Chrome

### Revisão

- Mais rápida em média (1 a 3 dias úteis), tende a seguir a aprovação
  do Chrome

---

## 3. Processo de atualização (pós-publicação)

### Chrome e Edge funcionam igual

1. Faça a alteração no código
2. **Bumpe `version`** no `manifest.json` (regra semântica:
   `1.0.0` → `1.0.1` para bugfix, `1.1.0` para feature, `2.0.0` para
   mudança quebrada). Versão é obrigatoriamente **maior que a
   anterior** — não aceita reupload com mesmo número
3. `npm run build` → gerar novo `.zip`
4. Dashboard → selecionar extensão → "Upload new version"
5. Se mudou permissões, escopo de hosts ou descrição, refazer
   justificativas
6. Passa por **nova revisão** (geralmente mais rápida que a inicial,
   horas a 1-2 dias)

### Distribuição automática

- Após aprovada, Chrome/Edge empurram a atualização para todos os
  usuários **automaticamente** em até ~24h (o navegador checa updates
  periodicamente)
- Nenhuma ação do usuário é necessária — a extensão atualiza sozinha
  em background
- Usuários podem forçar: `chrome://extensions` → ativar "Modo
  desenvolvedor" → "Atualizar"

### Estratégias úteis

- **Versões de teste**: mantenha uma listagem separada "Unlisted" com
  builds beta para equipe piloto antes de promover ao canal principal
- **Rollback**: a loja não tem botão de "rollback" — se uma versão ruim
  for ao ar, a correção é publicar **outra versão maior** com o bug
  corrigido. Por isso teste bem antes
- **Canary interno**: antes de subir, instale o `.zip` localmente para
  alguns usuários via "Carregar sem compactação" para validar em
  produção real

---

## 4. Alternativa para ambiente JFCE (recomendação)

Dado o caráter institucional e o risco de exposição de dados
processuais, **considere não publicar publicamente**:

- **Chrome Web Store "Unlisted"** + link distribuído internamente —
  instala como qualquer extensão da loja (inclusive com auto-update),
  mas não aparece em busca
- **Política de grupo (GPO) do Active Directory** — se a TI da JFCE
  gerencia os navegadores dos servidores, pode forçar instalação e
  atualização via GPO, apontando para o CRX hospedado na intranet ou
  para o ID da extensão na loja. Esse é o caminho mais controlado e
  auditável para uso institucional
- **Edge** tem mecanismo equivalente via Intune/GPO

Converse com a STI antes de publicar — a política institucional pode
exigir aprovação formal, revisão de segurança e hospedagem interna do
pacote.
