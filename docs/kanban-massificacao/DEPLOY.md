# pAIdegua Kanban — Deploy em paidegua.ia.br

Documento operacional. Conecta **Claude Code** ↔ **GitHub** ↔ **Cloudflare** ↔ **Resend** ↔ **GitHub API** para servir o quadro Kanban em `https://kanban.paidegua.ia.br` com autenticação por OTP institucional, integração com issues do `vsousaesilva/paidegua` e gestão completa de cards (datas, checklist, comentários, histórico).

> **Importante:** este Kanban é projeto **separado** da extensão pAIdegua. A extensão continua sendo um sistema de banco integrado ao navegador (`chrome.storage.session` / `IndexedDB`). O Cloudflare KV armazena **somente** o estado do quadro.

---

## 1. Visão geral da arquitetura

```
┌──────────────────────┐        ┌──────────────────────────────────┐
│  Navegador do user   │  HTTPS │  kanban.paidegua.ia.br           │
│  (servidor JFCE)     ├───────▶│   (Cloudflare)                   │
└──────────────────────┘        │  ┌─Pages──────────┐              │
                                │  │ index.html     │             │  estático
                                │  │ kanban.css/.js │             │
                                │  │ seed.js        │             │
                                │  └────────────────┘             │
                                │  ┌─Worker─────────┐             │
                                │  │ /api/*         │             │  rota: kanban.paidegua.ia.br/api/*
                                │  │ auth + KV      │             │
                                │  └─┬───┬───┬──────┘             │
                                └────┼───┼───┼────────────────────┘
                                     │   │   │
                            ┌────────┘   │   └────────┐
                            ▼            ▼            ▼
                     ┌────────────┐ ┌─────────┐ ┌──────────┐
                     │ KV         │ │ Resend  │ │ GitHub   │
                     │ KANBAN_KV  │ │ (OTP)   │ │ Issues   │
                     │            │ │         │ │ API      │
                     │ board      │ └─────────┘ └──────────┘
                     │ team       │
                     │ otp/token  │
                     └────────────┘
```

---

## 2. Pré-requisitos

1. **Conta GitHub** com acesso de push em `vsousaesilva/paidegua`.
2. **Conta Cloudflare** (Free) e propriedade do domínio `paidegua.ia.br`.
3. **Conta Resend** (Free 3.000 e-mails/mês) — https://resend.com
4. **Node.js 20+** instalado — baixe em https://nodejs.org/pt e instale com Next/Next.

### Ferramentas CLI

Abra o **cmd.exe** (Iniciar → `cmd` → Enter) e cole:

```cmd
npm install -g wrangler
wrangler login
```

A janela do navegador abre para autenticar no Cloudflare. Aceite.

Para o GitHub CLI:
```cmd
winget install --id GitHub.cli
gh auth login
```

Escolha **GitHub.com** → **HTTPS** → **Yes** (autenticar git) → **Login with a web browser** → cole o código que aparece na tela do navegador.

> **Alternativa sem CLI**: você pode pular `wrangler` e `gh` e operar **100 % pela interface web** do Cloudflare e GitHub. Os comandos ficam mais lentos mas funcionam — em cada seção abaixo eu indico o caminho web quando aplicável.

---

## 3. Repositório separado para o Kanban

Mantém `vsousaesilva/paidegua` (extensão) isolado e cria `paidegua-kanban` para o quadro. Você pode escolher **um dos dois caminhos**:

### Caminho A — Pela interface web do GitHub (sem CLI)

1. Abra https://github.com/new no navegador (já logado).
2. **Repository name**: `paidegua-kanban`
3. **Description** (opcional): `Kanban de acompanhamento do projeto pAIdegua — Inovajus / JFCE`.
4. Marque **Private**.
5. **Não** marque "Add a README", "Add .gitignore" nem "Choose a license" — você vai subir o conteúdo já existente.
6. Clique **Create repository**.
7. Na tela seguinte, em "**…or push an existing repository from the command line**", o GitHub mostra dois comandos. Você usará o nosso fluxo abaixo (cmd) — não copie esses, são equivalentes.

### Caminho B — Pelo cmd.exe (Prompt de Comando)

Abra o **cmd.exe** (Iniciar → digite `cmd` → Enter). Cole **uma linha por vez**:

```cmd
cd /d "C:\Users\vsousaesilva\OneDrive - Justica Federal no Ceara\Área de Trabalho\Claude JF\paidegua\docs\kanban-massificacao"

git init
git add .
git commit -m "Backlog inicial do Kanban de acompanhamento"
```

Agora, para criar o repo no GitHub e enviar:

**B.1 — Se você tem o GitHub CLI (`gh`) instalado** (recomendado):
```cmd
gh repo create paidegua-kanban --private --source=. --remote=origin --push
```

**B.2 — Se NÃO tem `gh` (sem instalar nada)**: crie o repo pela interface web (Caminho A passos 1–6), depois no cmd:
```cmd
git remote add origin https://github.com/vsousaesilva/paidegua-kanban.git
git branch -M main
git push -u origin main
```
> Na primeira vez que você fizer `git push`, o Windows abre uma janela do navegador para autenticar via GitHub Desktop / token OAuth. Aceite e o push prossegue.

### Verificar
Acesse `https://github.com/vsousaesilva/paidegua-kanban` — deve listar `index.html`, `kanban.css`, `kanban.js`, `seed.json`, `worker/`, etc.

> **Como Claude Code participa.** Eu gero/edito arquivos e executo comandos `git`/`gh` quando você autoriza no terminal. Já o `gh auth login` exige fluxo OAuth no navegador — você executa **uma vez**, depois o token fica em `%USERPROFILE%\AppData\Roaming\GitHub CLI\` e é reaproveitado.

---

## 4. Cloudflare — DNS + Pages

### 4.1 Adicionar zona

> ✅ Zona `paidegua.ia.br` já está cadastrada na Cloudflare. **Pule para 4.2.**

(Para futura referência, o passo seria: Cloudflare Dashboard → **Add Site** → `paidegua.ia.br` → Plan **Free**, atualizar nameservers no registro.br, aguardar ativação.)

### 4.2 Conectar Pages ao GitHub

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Autorize Cloudflare a acessar `paidegua-kanban`.
3. Configuração de build:

| Campo | Valor |
|---|---|
| Production branch | `main` |
| Build command | _(vazio)_ |
| Build output directory | `/` |
| Root directory | _(vazio)_ |

4. Após o primeiro deploy, **Custom domains** → adicionar `kanban.paidegua.ia.br`. A Cloudflare cria automaticamente o CNAME no DNS da zona `paidegua.ia.br`.

---

## 5. Resend — envio do OTP

### 5.1 Criar conta + API key

1. https://resend.com → cadastre-se (e-mail institucional).
2. **Domains** → **Add Domain** → `paidegua.ia.br` (sim, o **domínio raiz** — assim o e-mail sai como `noreply@paidegua.ia.br`, mais limpo institucionalmente).
3. Resend lista 3 registros DNS (SPF, DKIM, DMARC). Adicione todos no Cloudflare DNS da zona `paidegua.ia.br`:

| Tipo | Nome | Valor |
|---|---|---|
| TXT | `send.paidegua.ia.br` | `v=spf1 include:amazonses.com ~all` (exemplo — copie do painel Resend) |
| TXT (DKIM) | `resend._domainkey.paidegua.ia.br` | `(chave longa fornecida pela Resend)` |
| MX | `send.paidegua.ia.br` | `feedback-smtp.us-east-1.amazonses.com` priority `10` |

> Os valores exatos vêm do próprio Resend. Não copie do exemplo acima — copie do painel.

4. Aguarde verificação (até 30 min).
5. **API Keys** → **Create API Key** → escopo "**Sending access**" para o domínio. Guarde a chave (`re_xxxxx`).

### 5.2 Salvar como secret no Worker

**Pelo cmd.exe:**
```cmd
cd /d "C:\Users\vsousaesilva\OneDrive - Justica Federal no Ceara\Área de Trabalho\Claude JF\paidegua\docs\kanban-massificacao\worker"
wrangler secret put RESEND_API_KEY
```
Cole a chave `re_xxxxx` quando solicitado e Enter.

**Pela interface web** (sem CLI): Cloudflare Dashboard → Workers & Pages → seu Worker `paidegua-kanban-api` → Settings → **Variables and Secrets** → **Add variable** → tipo **Encrypt** → Name: `RESEND_API_KEY` → Value: `re_xxxxx` → **Save and deploy**.

---

## 6. GitHub — token para criar issues automáticas

### 6.1 Personal Access Token

1. https://github.com/settings/tokens → **Generate new token (classic)**.
2. Nome: `paidegua-kanban-worker`.
3. Expiração: 1 ano (renovar manualmente — é o trade-off).
4. Scopes: marcar **`repo`** (Full control of private repositories).
5. Gerar e copiar (`ghp_xxxxx`).

### 6.2 Salvar como secret

**Pelo cmd.exe:**
```cmd
cd /d "C:\Users\vsousaesilva\OneDrive - Justica Federal no Ceara\Área de Trabalho\Claude JF\paidegua\docs\kanban-massificacao\worker"
wrangler secret put GITHUB_TOKEN
```
Cole `ghp_xxxxx` e Enter.

**Pela interface web**: idem 5.2, mas com Name: `GITHUB_TOKEN`.

### 6.3 Como funciona a integração

- Quando um card move para a coluna **Desenvolvimento** (`dev`), o Worker chama a GitHub API e cria uma issue **automaticamente** no repo definido em `GH_REPO_DEFAULT` (`vsousaesilva/paidegua`).
- Cards com prefixo `KAN-*` viram issues em `GH_REPO_KANBAN` (`vsousaesilva/paidegua-kanban`).
- A issue inclui descrição, critérios de aceitação como checklist e referências ao card.
- O número da issue é gravado em `card.issueGithub` e aparece no badge do card no quadro.
- Mover novamente o card de fora pra dentro de `dev` **não** cria issue duplicada (idempotente — só dispara na primeira transição).

A coluna gatilho é configurável: `GH_AUTO_COLUMN` no `wrangler.toml`. Default `dev`. Se quiser que crie já em `spec`, mude para `spec`.

---

## 7. KV namespace + Worker deploy

### 7.1 Criar KV

**Pelo cmd.exe:**
```cmd
cd /d "C:\Users\vsousaesilva\OneDrive - Justica Federal no Ceara\Área de Trabalho\Claude JF\paidegua\docs\kanban-massificacao\worker"
wrangler kv:namespace create KANBAN_KV
```
A saída exibe um `id`. Abra `wrangler.toml` no Bloco de Notas e cole:
```toml
[[kv_namespaces]]
binding = "KANBAN_KV"
id = "abc123def456..."
```

**Pela interface web**: Cloudflare Dashboard → Workers & Pages → **KV** → **Create a namespace** → Name: `KANBAN_KV` → Add. Copie o ID exibido e cole no `wrangler.toml` igual acima.

### 7.2 Deploy

**Pelo cmd.exe:**
```cmd
cd /d "C:\Users\vsousaesilva\OneDrive - Justica Federal no Ceara\Área de Trabalho\Claude JF\paidegua\docs\kanban-massificacao\worker"
wrangler deploy
```
Worker fica em `paidegua-kanban-api.<sua-conta>.workers.dev`.

**Pela interface web** (mais trabalhoso): Workers & Pages → **Create application** → **Worker** → cole o conteúdo de `worker.js` no editor → **Deploy** → depois **Settings → Variables** para colar o conteúdo de `wrangler.toml [vars]` à mão. Recomendo o cmd.exe para esta etapa.

### 7.3 Roteamento custom

Cloudflare Dashboard → Worker → **Triggers** → **Add Route**:
- Pattern: `kanban.paidegua.ia.br/api/*`
- Zone: `paidegua.ia.br`

Como a rota é mais específica que o root do Pages, `/api/*` vai ao Worker e o resto vai ao Pages.

---

## 8. Variáveis (não-secrets) no `wrangler.toml`

Já vêm preenchidas:

```toml
[vars]
ALLOWED_DOMAINS = "jfce.jus.br,trf5.jus.br,jfrn.jus.br,jfpb.jus.br,jfpe.jus.br,jfal.jus.br,jfse.jus.br,kanban.paidegua.ia.br"
ALLOWED_EMAILS = "vsousaesilva@jfce.jus.br"  # gate principal — adicione membros aqui
ADMIN_EMAILS = "vsousaesilva@jfce.jus.br"
MAIL_FROM = "noreply@paidegua.ia.br"
MAIL_FROM_NAME = "pAIdegua / Inovajus"
GH_REPO_DEFAULT = "vsousaesilva/paidegua"
GH_REPO_KANBAN = "vsousaesilva/paidegua-kanban"
GH_AUTO_COLUMN = "dev"
```

Para adicionar membros à equipe Inovajus, três caminhos:

**A — direto no wrangler.toml (gate via variável):**
```toml
ALLOWED_EMAILS = "vsousaesilva@jfce.jus.br,ana@jfce.jus.br,bruno@trf5.jus.br"
```
Depois `wrangler deploy`.

**B — pelo dashboard Cloudflare** (sem redeploy): Workers & Pages → seu Worker → Settings → Variables → editar `ALLOWED_EMAILS`.

**C — pela API (após você ser admin):**
```powershell
$token = "SEU_BEARER"
Invoke-RestMethod -Uri "https://kanban.paidegua.ia.br/api/team/members" -Method POST `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body '{ "email": "ana@jfce.jus.br", "nome": "Ana Souza", "papel": "membro" }'
```

> Nota: o registro em `team:members` (KV) é **registro de equipe** (nome, papel) — quem **autentica** continua sendo controlado por `ALLOWED_EMAILS`. Para revogar acesso, **remova de `ALLOWED_EMAILS`**.

---

## 9. Carregar o backlog inicial

Após primeiro login (e-mail → OTP → token), o KV está vazio. Duas opções:

**A — Frontend faz seed automático** (já implementado): no primeiro acesso autenticado, se o board vier vazio, o JS chama `POST /api/board/replace` com `window.__PAIDEGUA_SEED__` (do `seed.js`).

**B — Via interface (recomendado se A falhar)**: faça login em kanban.paidegua.ia.br, clique em **Importar** na toolbar e escolha `seed.json`.

**C — Manual via curl** no cmd.exe:
```cmd
curl -X POST "https://kanban.kanban.paidegua.ia.br/api/board/replace" ^
  -H "Authorization: Bearer SEU_BEARER" ^
  -H "Content-Type: application/json" ^
  --data-binary @seed.json
```
> No cmd.exe, use `^` para quebrar linha (e nada de `\`).

---

## 10. CI/CD

### 10.1 Frontend (Pages)

Cloudflare Pages **já faz auto-deploy** a cada push em `main` (configurado em §4.2). Sem GitHub Actions adicional.

### 10.2 Worker (deploy manual ou GH Actions)

**Manual** no cmd.exe (cada vez que mudar `worker.js`):
```cmd
cd /d "C:\Users\vsousaesilva\OneDrive - Justica Federal no Ceara\Área de Trabalho\Claude JF\paidegua\docs\kanban-massificacao\worker"
wrangler deploy
```

**Automático via GH Actions**: crie `.github/workflows/deploy-worker.yml`:

```yaml
name: Deploy Worker
on:
  push:
    branches: [main]
    paths: [ "worker/**" ]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: worker
```

Em **GitHub → Settings → Secrets and variables → Actions → New repository secret**:
- `CLOUDFLARE_API_TOKEN` → Cloudflare My Profile → API Tokens → "Edit Cloudflare Workers"
- `CLOUDFLARE_ACCOUNT_ID` → canto inferior direito do dashboard Cloudflare

---

## 11. Modo standalone (sem Cloudflare)

Abra `index.html` direto no navegador. JS detecta `file://` e:
- aceita qualquer e-mail no login
- aceita o código fixo `000000`
- persiste em `localStorage` (chave `paidegua_kanban_offline_state`)
- carrega o seed via `window.__PAIDEGUA_SEED__` (de `seed.js`)
- todas as funcionalidades (drag-drop, checklist, comentários, datas, histórico) funcionam **localmente**

Útil para validar o backlog antes do deploy real.

---

## 12. Custos

| Recurso | Limite Free | Suficiente? |
|---|---|---|
| Cloudflare Pages | 500 builds/mês, requests ilimitados | sim |
| Cloudflare Workers | 100k requests/dia | sim |
| Cloudflare KV | 100k reads/dia, 1k writes/dia, 1GB | sim |
| Resend | 3.000 e-mails/mês, 100/dia | sim — ~10 OTPs/dia esperados |
| GitHub API | 5.000 requests/hora (com PAT) | sim |
| Domínio `.ia.br` | ~R$40/ano | externo a tudo isso |

**Custo operacional anual: R$40** (apenas o domínio).

---

## 13. Checklist final de operação

- [x] Zona `paidegua.ia.br` ativa no Cloudflare
- [ ] Repositório `vsousaesilva/paidegua-kanban` criado (privado)
- [ ] Pages conectado ao repo, custom domain `kanban.paidegua.ia.br`
- [ ] KV `KANBAN_KV` criado e bindado em `wrangler.toml`
- [ ] Worker deployado com rota `kanban.paidegua.ia.br/api/*`
- [ ] Resend domain verificado (SPF/DKIM/DMARC no DNS)
- [ ] Secret `RESEND_API_KEY` configurado
- [ ] Secret `GITHUB_TOKEN` configurado (PAT com scope `repo`)
- [ ] `ALLOWED_EMAILS` ajustado para a equipe Inovajus
- [ ] Primeiro login feito, seed automaticamente carregado
- [ ] Mover um card de teste para `dev` e confirmar issue criada em `vsousaesilva/paidegua`
- [ ] (opcional) GH Actions deploy automático do Worker

---

## 14. Comandos úteis no dia a dia (cmd.exe)

```cmd
:: Ver chaves no KV
wrangler kv:key list --binding=KANBAN_KV

:: Ler o board atual
wrangler kv:key get --binding=KANBAN_KV "board:state"

:: Listar membros do time
wrangler kv:key get --binding=KANBAN_KV "team:members"

:: Listar itens do cofre (apenas blobs cifrados — servidor nunca vê plaintext)
wrangler kv:key get --binding=KANBAN_KV "vault:state"

:: Backup do board (data no nome)
for /f "tokens=2 delims==" %i in ('wmic os get localdatetime /value') do set DT=%i
set HOJE=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%
wrangler kv:key get --binding=KANBAN_KV "board:state" > backup-board-%HOJE%.json

:: Logs do Worker em tempo real
wrangler tail
```

> Pela interface web: Cloudflare Dashboard → Workers & Pages → **KV** → seu namespace → **View** para inspecionar/editar chaves visualmente.

---

## 15. Cofre do projeto (Vault)

Botão **🔐 Cofre** no header da aplicação (visível após login) abre um repositório central para:

- **📚 Documentos** (manuais, dicas, pipelines, runbooks) em markdown
- **🔑 Credenciais** (senhas, API keys, certificados, conexões)

### 15.1 Criptografia

- **Algoritmo**: AES-GCM 256
- **Derivação de chave**: PBKDF2-SHA256 com **600.000 iterações**
- **Salt**: 16 bytes aleatórios por item
- **IV**: 12 bytes aleatórios por cifragem
- A passphrase **nunca** sai do navegador. O servidor (Cloudflare KV) recebe e armazena **somente o blob cifrado** + metadados não-sensíveis (label, tags, kind). Nem o Inovajus, nem a Cloudflare, nem este Worker conseguem ler o conteúdo sem a passphrase.
- A passphrase fica em `sessionStorage` enquanto a aba está aberta. Botão **Bloquear** no header do cofre limpa imediatamente. Auto-bloqueio por inatividade após **15 minutos**.

### 15.2 Primeiro uso

1. Logue na aplicação como de costume.
2. Clique em **🔐 Cofre** no header.
3. **Crie a passphrase mestra**: mínimo 12 caracteres. Recomenda-se gerador de senha (Bitwarden, 1Password) ou frase com 4 palavras aleatórias + número + símbolo.
4. **Guarde a passphrase em um gerenciador de senhas pessoal**. Se você esquecer, **o conteúdo cifrado é irrecuperável** — não há recuperação por e-mail.
5. Clique em **+ Novo** e adicione seus primeiros itens (ex.: "Senha PJe", "Chave Anthropic", "Pipeline build extensão").

### 15.3 Operação para a equipe

Cada membro precisa **logar com seu e-mail** e **conhecer a passphrase do cofre** para descriptografar. Você tem duas estratégias:

**A — Passphrase compartilhada do time** (operacional simples): combine uma única passphrase com a equipe Inovajus, transmita por canal seguro (1Password compartilhado, presencial). Todos abrem o mesmo cofre. Vantagem: ninguém perde acesso a nada. Desvantagem: se vazar, vaza tudo.

**B — Cofres separados por pessoa** (mais seguro mas burocrático): cada membro mantém **seu** cofre individual. Exige replicação manual de itens compartilhados.

> Para uso institucional pequeno (≤10 membros) e em rede confiável, **caminho A é o recomendado**. Documente a rotação da passphrase a cada 6 meses no próprio cofre.

### 15.4 Tipos de item

| Tipo | Quando usar |
|---|---|
| 📄 **Documento (markdown)** | Manuais, runbooks, dicas, pipelines, ADRs internos |
| 🔑 **Senha** | Senhas de sistema (PJe, e-mail, AD, etc.) |
| 🗝 **API key** | Chaves Anthropic, OpenAI, Resend, GitHub PAT, etc. |
| 📜 **Certificado** | Certificados PFX, PEM, certificados digitais |
| 🔌 **Conexão** | Strings de conexão (host:porta:user) |
| 📦 **Outro** | Qualquer outro segredo |

### 15.5 Segurança operacional

- ⚠ **Nunca compartilhe a passphrase em chat institucional ou e-mail**.
- ⚠ **Não use a mesma passphrase do PJe ou Windows** — use uma específica do cofre.
- ⚠ **Trocar de e-mail institucional não invalida o cofre** — basta o novo e-mail estar em `ALLOWED_EMAILS` e conhecer a passphrase.
- ✅ Use o botão **📋 Copiar (limpa em 30s)** ao invés de copiar manualmente — limpa a área de transferência depois para evitar exposição.
- ✅ Use **👁 Mostrar/ocultar** para checar uma senha sem deixá-la visível no editor.
- ✅ Anote em "Tags" para facilitar busca (ex.: `pje, gabinete, producao`).

### 15.6 Backup do cofre

```cmd
wrangler kv:key get --binding=KANBAN_KV "vault:state" > backup-vault-%HOJE%.json
```

O backup já vem cifrado. Você pode armazená-lo em qualquer lugar — ele é inútil sem a passphrase. Para restaurar:

```cmd
wrangler kv:key put --binding=KANBAN_KV "vault:state" --path=backup-vault-2026-05-03.json
```

### 15.7 Modo offline (sem deploy)

Em `file://` o cofre funciona com `localStorage` (chave `paidegua_kanban_vault`). Mesma criptografia. Sem sincronização entre máquinas até fazer deploy.

---

**Fim.** Em caso de dúvida operacional: `inovajus@jfce.jus.br`.
