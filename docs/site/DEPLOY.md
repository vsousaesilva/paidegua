# Site público do pAIdegua — deploy em paidegua.ia.br

Documento operacional. Publica o conteúdo de `docs/site/` (página inicial + manual)
no **domínio raiz** `https://paidegua.ia.br`, via Cloudflare Pages.

> **Não confundir com o Kanban.** `kanban.paidegua.ia.br` é outro projeto, com repo,
> Pages e Worker próprios (ver `docs/kanban-massificacao/DEPLOY.md`). Os dois convivem
> na mesma zona DNS sem conflito: o Kanban ocupa o subdomínio, o site ocupa a raiz.

---

## 1. Arquitetura

```
                        zona paidegua.ia.br (Cloudflare)
                                    │
            ┌───────────────────────┴───────────────────────┐
            ▼                                               ▼
   paidegua.ia.br                              kanban.paidegua.ia.br
   (Pages: paidegua-site)                      (Pages + Worker, já existente)
            │                                               │
   repo paidegua-site                          repo paidegua-kanban
   conteúdo de docs/site/                      quadro Kanban + /api/*
```

O site é **estático puro**: nenhum servidor, nenhum banco, nenhuma autenticação.
Não há Worker envolvido e nada a proteger com segredo.

---

## 2. O que vai ao ar

```
docs/site/
├── index.html          página inicial
├── 404.html            página de erro
├── _headers            cabeçalhos de segurança (lido pelo Pages)
├── robots.txt
├── sitemap.xml
├── manual/
│   └── index.html      manual — FONTE ÚNICA (ver §6)
└── assets/
    ├── logo.png
    ├── site.css
    └── manual.js
```

---

## 3. Criar o repositório do site

O conteúdo mora hoje dentro do repo da extensão (`vsousaesilva/paidegua`), que é
privado e tem ciclo de release próprio. O site vai para repo separado, espelhando
o que já funciona no Kanban.

### 3.1 Criar o repo no GitHub

1. Abra <https://github.com/new>.
2. **Repository name:** `paidegua-site`
3. **Description:** `Site público do pAIdegua — Inovajus / JFCE`
4. Marque **Public** (é um site público; não há nada sigiloso aqui).
5. **Não** marque README, .gitignore nem licença.
6. **Create repository**.

### 3.2 Enviar o conteúdo

No **cmd.exe**, uma linha por vez. Copiamos `docs/site` para uma pasta fora do repo
da extensão, para que o repo do site contenha apenas o site:

```cmd
robocopy "C:\Users\vsousaesilva\OneDrive - Justica Federal no Ceara\Área de Trabalho\Claude JF\paidegua\docs\site" "%USERPROFILE%\paidegua-site" /E /XF DEPLOY.md

cd /d "%USERPROFILE%\paidegua-site"

"C:\Portatil\PortableGit\cmd\git.exe" init
"C:\Portatil\PortableGit\cmd\git.exe" add .
"C:\Portatil\PortableGit\cmd\git.exe" commit -m "Site publico do pAIdegua - pagina inicial e manual v1.10.2"
"C:\Portatil\PortableGit\cmd\git.exe" branch -M main
"C:\Portatil\PortableGit\cmd\git.exe" remote add origin https://github.com/vsousaesilva/paidegua-site.git
"C:\Portatil\PortableGit\cmd\git.exe" push -u origin main
```

> `robocopy` devolve código de saída 1 quando copiou arquivos com sucesso — isso é
> normal, não é erro.

---

## 4. Cloudflare Pages

### 4.1 Criar o projeto

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**.
2. Autorize o acesso a `paidegua-site`.
3. Configuração de build:

| Campo | Valor |
|---|---|
| Production branch | `main` |
| Framework preset | None |
| Build command | _(vazio)_ |
| Build output directory | `/` |
| Root directory | _(vazio)_ |

4. **Save and Deploy.** O primeiro deploy sai em `paidegua-site.pages.dev`.
   **Confira nesse endereço antes de apontar o domínio** — é a chance de ver o site
   no ar sem afetar nada.

### 4.2 Apontar o domínio raiz

1. No projeto Pages → **Custom domains** → **Set up a custom domain**.
2. Informe `paidegua.ia.br` (a raiz, **sem** `www`).
3. A Cloudflare cria sozinha o registro DNS na zona. Como a zona já está na
   Cloudflare, não há nada a fazer no registro.br.
4. Aguarde o certificado ficar **Active** (normalmente poucos minutos).

### 4.3 Opcional — `www` redirecionando para a raiz

1. **Custom domains** → adicionar `www.paidegua.ia.br`.
2. Zona `paidegua.ia.br` → **Rules** → **Redirect Rules** → criar regra:
   se hostname igual a `www.paidegua.ia.br`, redirecionar 301 para
   `https://paidegua.ia.br/${http.request.uri.path}`.

---

## 5. Verificação pós-deploy

- [ ] `https://paidegua.ia.br` abre a página inicial
- [ ] `https://paidegua.ia.br/manual/` abre o manual
- [ ] O índice lateral do manual navega e a busca (`/`) funciona
- [ ] `https://paidegua.ia.br/qualquer-coisa` cai no 404 estilizado
- [ ] O cadeado do navegador mostra certificado válido
- [ ] **`https://kanban.paidegua.ia.br` continua funcionando** — o subdomínio não
      pode ter sido afetado pelo domínio raiz
- [ ] O e-mail de OTP do Kanban continua chegando (o domínio `paidegua.ia.br` é o
      remetente verificado na Resend; publicar o site **não** mexe em SPF/DKIM, mas
      vale conferir uma vez)

---

## 6. Manutenção do manual

O manual tem **fonte única**: `manual/index.html` neste repo (originado de
`docs/site/manual/index.html` no repo da extensão). As antigas cópias em
`docs/manual-instalacao-uso.md` e `.html` foram descontinuadas e hoje apenas
apontam para cá.

Ao publicar uma nova versão da extensão:

> **Ao alterar `assets/site.css` ou `assets/manual.js`, incremente o `?v=` nos
> links das três páginas** (`index.html`, `manual/index.html`, `404.html`).
> Os assets têm nome fixo: sem trocar a URL, navegadores que já visitaram o site
> continuam servindo a versão antiga do cache e a mudança não aparece — foi
> exatamente o que aconteceu em 19/07/2026, quando o HTML novo subiu com o CSS
> velho e a página apareceu sem estilo.

1. Edite `manual/index.html`.
2. Atualize a versão e a data no topo (`<p class="manual-meta">`).
3. Se acrescentou seção, inclua o item no índice lateral (`<ul class="toc__list">`)
   — a numeração é manual.
4. Atualize `sitemap.xml` (`<lastmod>`).
5. `git push` → o Pages republica sozinho em ~1 minuto.

### Convenção de escrita

O manual é lido por pessoas com níveis muito diferentes de familiaridade com o PJe e
com tecnologia. **Não use termos técnicos.** Descreva o que o usuário vê e faz na
tela. Quando um detalhe técnico for inevitável, explique o efeito prático em vez do
mecanismo.

### Sincronização entre os dois repos

O conteúdo existe em dois lugares (repo da extensão, para histórico junto do código;
repo do site, para publicação). Depois de editar no repo da extensão:

```cmd
robocopy "C:\Users\vsousaesilva\OneDrive - Justica Federal no Ceara\Área de Trabalho\Claude JF\paidegua\docs\site" "%USERPROFILE%\paidegua-site" /E /PURGE /XF DEPLOY.md /XD .git
cd /d "%USERPROFILE%\paidegua-site"
"C:\Portatil\PortableGit\cmd\git.exe" add -A
"C:\Portatil\PortableGit\cmd\git.exe" commit -m "Atualiza manual para vX.Y.Z"
"C:\Portatil\PortableGit\cmd\git.exe" push
```

> Se essa dupla manutenção incomodar, a alternativa é apontar o Pages direto para o
> repo da extensão com *root directory* = `docs/site`. Foi descartada aqui para não
> acoplar a publicação do site ao ciclo de release da extensão, mas continua viável.

---

## 7. Custos

Cloudflare Pages no plano Free: 500 builds/mês, requisições e banda ilimitadas.
O site não usa Worker nem KV. **Custo adicional: zero** — o domínio (~R$40/ano) já é
pago por conta do Kanban.

---

## 8. Pendências conhecidas

- **URL da política na Chrome Web Store.** A política foi revisada e publicada em
  `https://paidegua.ia.br/privacidade/` (fonte única: `privacidade/index.html`).
  Falta **atualizar o campo de política de privacidade no painel da Chrome Web
  Store** para esse endereço. Enquanto isso não for feito, o listing aponta para o
  documento antigo, que continha afirmações incorretas sobre anonimização e sobre
  o token de sessão.
- **Token da Cloudflare no CI.** O segredo `CLOUDFLARE_API_TOKEN` do GitHub está
  expirado (o workflow do Kanban falha por isso). Não afeta este site, que faz deploy
  pela integração Git do Pages, sem token. Fica registrado por proximidade.

---

**Fim.** Dúvidas operacionais: `inovajus@jfce.jus.br`.
