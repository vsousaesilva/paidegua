# pAIdegua — Kanban de Massificação

Quadro Kanban institucional para acompanhamento das **~130 ações** que levarão o pAIdegua à condição de protagonista nacional em **IA + gestão + automação no PJe**.

## Estrutura

```
docs/kanban-massificacao/
  index.html         ← página única (Cloudflare Pages)
  kanban.css         ← identidade visual gov.br/PJe-CNJ (espelha popup/welcome do paidegua)
  kanban.js          ← SPA com drag-drop, filtros, modal, auth gate
  seed.json          ← backlog inicial completo (cards + colunas + categorias)
  README.md          ← este arquivo
  DEPLOY.md          ← passo a passo Claude Code ↔ GitHub ↔ Cloudflare ↔ kanban.paidegua.ia.br
  worker/
    worker.js        ← Cloudflare Worker (auth OTP + API de cards + KV)
    wrangler.toml    ← configuração do Worker (KV binding, vars, rotas)
```

## Modo de uso

- **Online** (após deploy): acesse `https://kanban.paidegua.ia.br`. Login por e-mail institucional → OTP de 6 dígitos.
- **Offline / standalone** (para validar antes do deploy): abra `index.html` direto no navegador. Use código `000000`. Persistência em `localStorage`.

## O que NÃO é

- **NÃO** é a extensão pAIdegua. A extensão continua usando `chrome.storage.session` / `IndexedDB`.
- **NÃO** envia dados de processo a lugar nenhum. O KV armazena **apenas o estado do quadro Kanban** (cards, colunas, status).

## Estrutura do backlog

### Colunas (10)
1. Triagem
2. Discovery
3. Especificação
4. Desenvolvimento
5. QA & Testes
6. Validação institucional
7. Piloto em vara
8. Lançado
9. Bloqueado
10. Arquivado

### Categorias (17)
Infraestrutura PJe · Conformidade CNJ 615/LGPD · Gabinete · Secretaria · Gestão · Audiência · Criminal · Comunicação · Metas CNJ · Calculadoras · Pesquisa jurídica · Integrações externas · Ergonomia/UX · Acessibilidade · Diretor de Foro/Corregedoria · Operacional/Release · Atendimento

### Prioridades
- **P0** — bloqueante regulatório ou release
- **P1** — alto impacto institucional
- **P2** — diferencial competitivo
- **P3** — evolução incremental

### Fases (do roadmap do manual de massificação)
- **F1** Infraestrutura
- **F2** Validação interna
- **F3** Massa pequena
- **F4** Massa grande
- **F5** Enriquecimento do snapshot
- **F6** Pré-massificação nacional
- **F7** Massificação nacional v2.0

## Próximos passos

Ver [`DEPLOY.md`](./DEPLOY.md).
