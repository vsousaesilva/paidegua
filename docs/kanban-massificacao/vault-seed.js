/**
 * pAIdegua Kanban — Seed do Cofre
 *
 * Pacote inicial de documentos e credenciais-template para o repositório
 * centralizado do projeto. Carregado pelo botão "📦 Carregar pacote inicial"
 * que aparece quando o cofre está vazio.
 *
 * IMPORTANTE: este arquivo contém TEXTO EM CLARO. É carregado em RAM no momento
 * do clique, cifrado localmente com a passphrase do usuário, e os itens cifrados
 * são salvos no KV / localStorage. O texto-claro nunca é persistido.
 *
 * Após o carregamento, REMOVA `vault-seed.js` do deploy de produção (basta
 * apagar o `<script src="vault-seed.js">` do index.html). Mantém apenas no
 * repositório como referência.
 */
window.__PAIDEGUA_VAULT_SEED__ = [
  // ========== DOCUMENTOS (📄 doc-md) ==========
  {
    tipo: 'doc-md',
    label: '📋 Índice do Cofre — comece por aqui',
    tags: ['indice', 'leia-primeiro'],
    conteudo: `# 📋 Índice do Cofre do pAIdegua

Bem-vindo ao Cofre do projeto. Tudo aqui é cifrado com **AES-GCM 256** derivado
da sua passphrase via PBKDF2-SHA256 com 600.000 iterações. Nem o servidor
(Cloudflare KV), nem o Inovajus, nem este Worker conseguem ler o conteúdo
sem a passphrase.

## O que está aqui

### 📚 Documentos
- **Manual de massificação** — roadmap F1-F7 (espelho de \`docs/manual-massificacao-pje.md\`)
- **Manual de comandos do Kanban (modo A)** — atalho rápido
- **Boas práticas de comunicação com o PJe** — invariantes do projeto
- **Anti-padrões** — o que NÃO fazer
- **Pipeline de build da extensão** — gerar dist.zip
- **Pipeline de release** — versionamento e changelog
- **Pipeline de deploy do Kanban** — kanban.paidegua.ia.br
- **Onboarding novo membro Inovajus** — checklist
- **Reuniões e ritos** — daily, planning, retro
- **Política de privacidade pAIdegua** — espelho de \`docs/index.md\`

### 🔑 Credenciais (templates)
Substitua os placeholders pelos valores reais. Eu não preencho com chaves
reais — você importa o template e cola sua chave.

- Anthropic API key (Claude)
- OpenAI API key (GPT)
- Google Gemini API key
- GitHub Personal Access Token (paidegua-kanban-worker)
- Cloudflare API Token (deploy do Worker)
- Resend API key (envio de OTP)
- PJe TRF5 — login institucional
- Inovajus / JFCE — e-mail e backend de auth

## Como manter este cofre saudável

1. **Não compartilhe a passphrase em chat institucional ou e-mail.**
2. **Use uma passphrase específica** — não reaproveite a do PJe ou Windows.
3. **Combine com a equipe** se vai usar passphrase compartilhada (operacional)
   ou cofres individuais (mais seguro). Para Inovajus pequeno, compartilhada é OK.
4. **Rotacione a passphrase a cada 6 meses** — anote a próxima rotação aqui.
5. **Backup**: \`wrangler kv:key get --binding=KANBAN_KV "vault:state"\` cria backup.
   O backup já vem cifrado — só funciona com a passphrase atual.

---

_Pacote inicial gerado em 03/05/2026 pela sessão de bootstrap do Cofre._
`,
  },
  {
    tipo: 'doc-md',
    label: 'Manual de Massificação do pAIdegua (resumo)',
    tags: ['manual', 'roadmap', 'massificacao', 'f1-f7'],
    conteudo: `# Manual de Massificação do pAIdegua — resumo

> Documento original (autoridade): \`docs/manual-massificacao-pje.md\`
> Política normativa de arquitetura para institucionalização nacional.

## Roadmap em 7 fases

| Fase | Entregável | Critério de saída |
|---|---|---|
| **F1** | \`pje-gateway.ts\` + \`pje-autos-cache.ts\` + testes | Suite verde, nenhum call-site migrado, flag global desligada |
| **F2** | Migrar \`pje-api-partes.ts\` (menor superfície) | Comportamento idêntico em 30 processos reais; 0 incidentes em 1 semana |
| **F3** | Migrar Metas CNJ + Criminal | Redução medível de 60–85% das chamadas a listAutosDigitais |
| **F4** | Migrar Audiência + Triagem + Prazos na Fita | Pool 25 workers; throttle 4 req/s/origem; varredura 1.000+ sem 4xx/5xx |
| **F5** | Enriquecer AutosSnapshot (situação, tipos, assinaturas, abas) | Detector de status mais rápido |
| **F6** | Comunicação CNJ/DTI; X-Tool-Identifier; remoção de fallbacks | Parecer/ciência do CNJ; 4 TRFs e 3 TJs validados |
| **F7** | Lançamento institucional v2.0 | Plano de incident response ativo; canal direto com PJe |

## Invariantes verificáveis (não-negociáveis)

- Toda chamada a \`*.jus.br\` passa por \`pjeGateway.fetch\`.
- Toda leitura de \`listAutosDigitais.seam\` passa por \`getAutosSnapshot\`.
- **Nunca cachear \`ca\`** em storage. (Regressão 20/04/2026.)
- Nunca usar \`cid\` da página em chamadas próprias.
- Nunca pré-fetchar processos especulativamente.
- Toda varredura batch usa \`critical: false\`.
- Toda chamada feita do content script (same-origin), não do background.
- URL com \`ca\`/\`idProcesso\` jamais aparece em log textual.
- TTL do cache em memória ≤ 600.000 ms; cache em disco proibido.
- Detecção de stub em toda resposta.

## Pré-condições para v2.0 (massificação nacional)

1. Comunicação formal CNJ/DTI apresentando a extensão.
2. Adesão por convite institucional (TRF/TJ).
3. Header \`X-Tool-Identifier: paidegua/2.0\` se acordado.
4. Plano de incident response com canal direto do mantenedor PJe.

## Quando atualizar

- Toda alteração estrutural em gateway/cache → atualizar §II.
- Todo incidente → vira post-mortem anexo + atualiza anti-padrão.
- Toda revisão da Res. CNJ 615 ou da LGPD → revisar §II.5.2.
`,
  },
  {
    tipo: 'doc-md',
    label: 'Boas práticas de comunicação com o PJe',
    tags: ['boas-praticas', 'pje', 'invariantes'],
    conteudo: `# Boas práticas de comunicação com o PJe

Invariantes verificáveis por revisão de código.

## Pontos de I/O concentrados

- Toda chamada a \`*.jus.br\` passa pelo gateway único.
- Toda leitura de \`listAutosDigitais.seam\` passa pelo cache único.
- Buscar por \`pjeGateway.fetch\` ou \`getAutosSnapshot\` lista todos os call-sites.

## Throttle e jitter

- Default: 4 req/s por origem, 6 concurrent max.
- Jitter aleatório 120–480ms apenas em varreduras (\`critical: false\`).
- Cliques diretos do usuário sempre têm prioridade alta.

## Identidade da chamada

- **Mesma assinatura comportamental** que um navegador real:
  - \`Referer\` sempre presente (vem do content script automaticamente).
  - \`Sec-Fetch-Site: same-origin\` natural.
  - Sem headers customizados (\`x-requested-with\` etc.).
  - Sem \`cid\` reaproveitado de Seam.

## Cache e privacidade

- TTL em memória ≤ 5 min (default 300_000 ms).
- **Single-flight**: chamadas paralelas para mesmo \`idProcesso\` compartilham Promise.
- Detecção de stub: rejeita HTML < 50KB ou sem marcadores essenciais.
- HTML bruto **NÃO** persiste após o parse.
- Nunca \`chrome.storage.local\` para conteúdo de processo.

## Sessão

- Refresh silencioso Keycloak espera o gateway, não falha a fila.
- Sessão expirada: alerta o usuário, não recupera silenciosamente.

## Logs

- Nunca \`console.log\` com URL completa, \`ca\`, ou conteúdo de processo.
- Logar apenas \`idProcesso\` em campo separado e categoria do erro.
- Scan estático de PII no CI bloqueia merge.
`,
  },
  {
    tipo: 'doc-md',
    label: '⚠️ Anti-padrões — o que NÃO fazer',
    tags: ['anti-padroes', 'cuidado', 'incidentes'],
    conteudo: `# ⚠️ Anti-padrões — o que NÃO fazer

Lições aprendidas. Cada item tem custo histórico.

## 1. Não recriar cache de \`ca\`
Resposta degradada do servidor (HTTP 200 com stub HTML reduzido) não dispara
erro — alimenta dados falsos. **Incidente de 20/04/2026** documentado em
\`docs/post-mortem-prazos-na-fita.md §8\`.

## 2. Não pré-fetchar processos especulativamente
Worker que varre lista do painel só "para esquentar cache" é o sinal mais
reconhecível pelo log do mantenedor do PJe.

## 3. Não anexar headers que o navegador real não envia
\`x-requested-with\`, headers customizados — fingerprint trivial. Cria
assinatura distinguível.

## 4. Não construir URLs com \`cid\` reaproveitado
Conversation ID Seam é específico do estado JSF do usuário. Reutilizar gera
warnings no servidor.

## 5. Não baixar PDFs/anexos quando o objetivo é só metadado
O extractor já é sob demanda — manter assim.

## 6. Não persistir HTML de processo em \`chrome.storage.local\`
Viola minimização LGPD (CPF, nomes, valores nos autos).

## 7. Não logar URL completa nem corpo de resposta
\`console.warn\`/\`error\` com template literal vazando \`ca\`/\`idProcesso\`/
\`htmlBruto\` é PII em log. Scan estático bloqueia no CI.

## 8. Não usar POST quando GET serve
A requisição capturada é POST porque vem de interação JSF do usuário, não
da extensão. Manter o paidegua usando GET com \`?idProcesso=X&ca=Y\`.

## 9. Não fazer chamadas a partir do background script
Same-origin via cookie é o caminho institucionalmente correto. Background
gera CORS e perde Referer.

## 10. Não distribuir versão massificada na Chrome Web Store antes da F6
Risco de bloqueio institucional pelo CNJ por uso não comunicado da API.
`,
  },
  {
    tipo: 'doc-md',
    label: 'Pipeline — Build da extensão pAIdegua',
    tags: ['pipeline', 'build', 'extensao', 'dist-zip'],
    conteudo: `# Pipeline — Build da extensão pAIdegua

## Pré-requisitos

- Node.js 20+ (use o portátil em \`PATH-DO-NODE-PORTABLE\` se a estação não tem PATH global).
- Pasta do projeto: \`C:\\Users\\vsousaesilva\\OneDrive - Justica Federal no Ceara\\Área de Trabalho\\Claude JF\\paidegua\`

## Passos

\`\`\`cmd
cd /d "C:\\Users\\vsousaesilva\\OneDrive - Justica Federal no Ceara\\Área de Trabalho\\Claude JF\\paidegua"

npm install
npm run typecheck
npm run build
\`\`\`

Saída esperada: pasta \`dist/\` populada com \`manifest.json\`, \`background.js\`,
\`content.js\`, \`popup/\`, \`options/\`, \`icons/\`, e demais bundles.

## Empacotar dist.zip

O zip vai para \`paidegua/versoes/\` (não para a raiz nem Downloads).

\`\`\`cmd
cd /d "C:\\Users\\vsousaesilva\\OneDrive - Justica Federal no Ceara\\Área de Trabalho\\Claude JF\\paidegua"
powershell -Command "Compress-Archive -Path 'dist\\*' -DestinationPath 'versoes\\dist v1.X.Y.zip' -Force"
\`\`\`

## Validação manual

1. \`chrome://extensions\` → Modo desenvolvedor → "Carregar sem compactação" → \`dist/\`
2. Abrir o PJe em outra aba → confirmar que botão "PAIDEGUA" aparece na barra superior
3. Testar fluxo crítico: Carregar Documentos → Resumir
4. Página de Diagnóstico (rodapé do popup) → confirmar Probe Keycloak OK

## Erros comuns

- **typecheck falha em metas-cnj**: ver \`docs/controle-metas-cnj.md\` (camadas P0/P1).
- **webpack out of memory**: aumentar \`NODE_OPTIONS=--max-old-space-size=4096\`.
`,
  },
  {
    tipo: 'doc-md',
    label: 'Pipeline — Release e versionamento',
    tags: ['pipeline', 'release', 'versionamento', 'changelog'],
    conteudo: `# Pipeline — Release e versionamento

## Convenção de versão

- **MAJOR** — quebra de compatibilidade (perfis renomeados, fluxo de auth alterado, etc.)
- **MINOR** — nova feature ou módulo (novo painel, novo perfil)
- **PATCH** — bugfix, refinamento de UX, atualização de seletor PJe

## Passos

1. Atualizar \`manifest.json\` (\`"version": "1.X.Y"\`).
2. Atualizar \`docs/manual-instalacao-uso.md\` se houve mudança de UX/comportamento.
3. Rodar typecheck + build (\`npm run build\`).
4. Empacotar \`versoes/dist v1.X.Y.zip\`.
5. Commit: \`vX.Y.Z: <resumo da release>\`.
6. Criar tag: \`git tag v1.X.Y && git push --tags\`.
7. **GitHub release**: subir o zip como asset, body com changelog.

## Changelog

Sempre inclua:
- ✨ **Novo**: features adicionadas
- 🛠 **Melhorado**: ajustes de UX/performance
- 🐛 **Corrigido**: bugs
- ⚠️ **Quebra**: incompatibilidades (em MAJOR)
- 📜 **Conformidade**: ajustes Res. CNJ 615 / LGPD

## Distribuição

Até a F6 (massificação): apenas convite institucional. NÃO publicar na
Chrome Web Store antes de comunicação formal CNJ/DTI.

## Pré-flight checklist

- [ ] typecheck verde
- [ ] testes (quando existirem) verdes
- [ ] manual atualizado se houve mudança de UX
- [ ] privacy policy revista se houve novo dado tratado
- [ ] zip salvo em \`versoes/\`
- [ ] tag criada
- [ ] release no GitHub
- [ ] e-mail aos pilotos com zip + changelog
`,
  },
  {
    tipo: 'doc-md',
    label: 'Pipeline — Deploy do Kanban (kanban.paidegua.ia.br)',
    tags: ['pipeline', 'deploy', 'cloudflare', 'kanban'],
    conteudo: `# Pipeline — Deploy do Kanban (kanban.paidegua.ia.br)

> Documento original (autoridade): \`docs/kanban-massificacao/DEPLOY.md\`
> Resumo aqui — para passos detalhados, veja o original.

## Atalho rápido (após primeiro setup)

### Front (Pages — auto-deploy)
Push em \`main\` do repo \`vsousaesilva/paidegua-kanban\`:
\`\`\`cmd
cd /d "C:\\Users\\vsousaesilva\\...\\docs\\kanban-massificacao"
git add .
git commit -m "ajuste no kanban"
git push
\`\`\`
Cloudflare Pages detecta e faz deploy em ~2min.

### Worker (manual)
\`\`\`cmd
cd /d "C:\\Users\\vsousaesilva\\...\\docs\\kanban-massificacao\\worker"
wrangler deploy
\`\`\`

### Bumpar versão de cache (front)
Editar \`index.html\`: trocar \`?v=N\` para \`?v=N+1\` em \`kanban.css\`, \`kanban.js\`, \`vault.js\`.
Garantir reload em quem já tem aba aberta.

## Adicionar membro à equipe

**Caminho A — wrangler.toml**: editar \`ALLOWED_EMAILS\` no \`worker/wrangler.toml\`:
\`\`\`toml
ALLOWED_EMAILS = "vsousaesilva@jfce.jus.br,ana@jfce.jus.br"
\`\`\`
Depois \`wrangler deploy\`.

**Caminho B — sem redeploy** (interface web Cloudflare): Workers & Pages →
seu Worker → Settings → Variables → editar \`ALLOWED_EMAILS\`.

**Caminho C — via API** (admin):
\`\`\`cmd
curl -X POST https://kanban.paidegua.ia.br/api/team/members ^
  -H "Authorization: Bearer SEU_BEARER" ^
  -H "Content-Type: application/json" ^
  -d "{\\"email\\": \\"ana@jfce.jus.br\\", \\"nome\\": \\"Ana Souza\\", \\"papel\\": \\"membro\\"}"
\`\`\`

## Troubleshooting

| Sintoma | Diagnóstico | Solução |
|---|---|---|
| OTP não chega | Resend → Logs (api.resend.com/logs) | Verificar SPF/DKIM no DNS |
| 401 nas APIs | Token expirado (>90d) | Re-login |
| Issue não cria no GH | Token GH expirado/revogado | Renovar PAT em github.com/settings/tokens |
| Card não move | Drag-drop bloqueado por modal aberto | Fechar modal antes |

## Backup

\`\`\`cmd
wrangler kv:key get --binding=KANBAN_KV "board:state" > backup-board-%date:~6,4%-%date:~3,2%-%date:~0,2%.json
wrangler kv:key get --binding=KANBAN_KV "vault:state" > backup-vault-%date:~6,4%-%date:~3,2%-%date:~0,2%.json
\`\`\`
`,
  },
  {
    tipo: 'doc-md',
    label: 'Manual de Comandos do Kanban (modo A) — cheatsheet',
    tags: ['manual', 'comandos', 'kanban', 'modo-a'],
    conteudo: `# Manual de Comandos — cheatsheet

> Documento original (autoridade): \`docs/kanban-massificacao/MANUAL-COMANDOS.md\`

## Atalho mental

\`\`\`
[ID ou filtro] [verbo] [valor]
\`\`\`

## 10 comandos prontos

\`\`\`
"Move CONF-01 para spec."

"Move INFRA-01, INFRA-02 e INFRA-13 para dev,
 atribui pra mim, dataPrevista 31/05/2026."

"Cria um card P1 em Audiência:
 'Importador de pauta TRF5'."

"Para INFRA-01, cria checklist:
 1. Esqueleto da classe
 2. Fila com prioridade
 3. Jitter
 4. Reusar retry
 5. Testes
 6. Migrar primeiro consumidor"

"INFRA-01 item 3 do checklist concluído."

"Comenta no CONF-01: 'ADR aprovado em reunião 15/05.'"

"Bloqueia INT-05 com motivo: aguardando convênio Dataprev."

"Quais cards P0 ainda estão em triagem?"

"Resumo do quadro: por coluna, por prioridade, por fase."

"Reverte a última ação."
\`\`\`

## Colunas (use em PT informal)

triagem · discovery · spec · dev · qa · validacao · piloto · lancado · bloqueado · arquivado

## Limites

- Memória só na sessão atual (reapresento contexto em nova sessão).
- Operações destrutivas (\`excluir\`, \`arquivar\`) sempre confirmo antes.
- ≥50 cards de uma vez → peço confirmação.
- Cada modificação registra autor + timestamp em \`historico\`.
- Em modo deploy: edições aparecem em tempo real para a equipe.
`,
  },
  {
    tipo: 'doc-md',
    label: 'Onboarding — novo membro Inovajus',
    tags: ['onboarding', 'inovajus', 'checklist'],
    conteudo: `# Onboarding — novo membro Inovajus

## Dia 1

### Acessos
- [ ] E-mail \`@jfce.jus.br\` ativo
- [ ] Adicionar e-mail em \`ALLOWED_EMAILS\` do Worker (peça ao admin)
- [ ] Login em kanban.paidegua.ia.br via OTP
- [ ] Receber a passphrase do Cofre por canal seguro (presencial / 1Password compartilhado)
- [ ] Acessar Cofre → carregar pacote inicial se ainda não tiver sido feito

### Repositórios
- [ ] Acesso de leitura ao \`vsousaesilva/paidegua\` (extensão)
- [ ] Acesso de leitura ao \`vsousaesilva/paidegua-kanban\` (este Kanban)
- [ ] Configurar Git local (\`git config --global user.name/email\`)

### Ferramentas
- [ ] Node.js 20+ (\`node --version\`)
- [ ] Chrome ou Edge para testar a extensão
- [ ] Editor (VS Code recomendado)
- [ ] (opcional) wrangler + gh CLI

## Semana 1 — leituras obrigatórias

- [ ] \`docs/manual-instalacao-uso.md\` — entender o produto
- [ ] \`docs/manual-massificacao-pje.md\` — entender o roadmap F1-F7
- [ ] \`docs/index.md\` — política de privacidade (LGPD + Res. CNJ 615)
- [ ] Cofre → "Boas práticas de comunicação com o PJe"
- [ ] Cofre → "Anti-padrões"
- [ ] Pelo menos 1 ADR existente

## Semana 1 — leituras recomendadas

- [ ] \`docs/extracao-conteudo-pje.md\`
- [ ] \`docs/post-mortem-prazos-na-fita.md\` (lições do incidente abr/2026)
- [ ] \`docs/telemetria-local-e-escala.md\`
- [ ] Manual de comandos do Kanban (modo A)

## Primeira contribuição (sugestão)

Pegar um card P3 da coluna **Triagem** com tag \`bom-pra-onboarding\` (se houver),
ou criar um novo card pequeno e fechar o ciclo: Triagem → Spec → Dev → QA → PR → Merge.

## Quem procurar

- **Produto / arquitetura**: vsousaesilva@jfce.jus.br
- **Conformidade / LGPD / CNJ 615**: inovajus@jfce.jus.br
- **DTI / infraestrutura**: dti-suporte@trf5.jus.br
`,
  },
  {
    tipo: 'doc-md',
    label: 'Reuniões e ritos do projeto',
    tags: ['reunioes', 'ritos', 'agile'],
    conteudo: `# Reuniões e ritos do projeto

## Daily — diária (15min)

- Quando: terça a sexta, 9:00
- Quem: dev ativo + product owner
- Pauta:
  - O que fiz desde a última daily
  - O que vou fazer hoje
  - Algum bloqueio?
- Sem agenda fixa fora isso. Não vira reunião de design.

## Sprint planning — quinzenal (1h)

- Quando: segunda da semana ímpar, 10:00
- Quem: equipe Inovajus + convidados conforme tema
- Pauta:
  - Revisar lista de cards P0 ainda em triagem
  - Decidir o que entra na sprint (mover para spec ou dev)
  - Atribuir owner e dataPrevista
  - Identificar bloqueios externos (CNJ, DTI, INSS)

## Retrospectiva — quinzenal (45min)

- Quando: sexta da semana par, 16:00
- Quem: equipe Inovajus
- Pauta:
  - O que funcionou bem
  - O que pode melhorar
  - 1 ação concreta para a próxima sprint

## Comitê institucional — mensal (1h)

- Quando: última quinta do mês, 14:00
- Quem: Inovajus + Diretor de Foro + representante CLI-JFCE
- Pauta:
  - Status de Metas CNJ
  - Cards de Conformidade em validação
  - Decisões institucionais (uso em outras varas, etc.)

## Convenções

- Atas em markdown nos comentários do card correspondente da Sprint Planning.
- Decisões institucionais viram ADR no repositório \`docs/adr/\`.
- Bloqueios identificados em retro viram cards na coluna \`bloqueado\` com \`bloqueadoPor\`.
`,
  },
  {
    tipo: 'doc-md',
    label: 'Política de Privacidade pAIdegua (resumo)',
    tags: ['lgpd', 'privacidade', 'res-615', 'compliance'],
    conteudo: `# Política de Privacidade pAIdegua — resumo

> Documento original (autoridade): \`docs/index.md\`
> Versão da extensão na data de redação: 1.2.1

## Controlador
**JFCE / Inovajus** — \`inovajus@jfce.jus.br\`

## Dados armazenados localmente (chrome.storage.local)
- Chave de API do provedor de IA escolhido
- Preferências de configuração
- Critérios personalizados de triagem
- Cadastro local de peritos
- Pasta local de modelos
- Logs de diagnóstico anônimos (até 50 entradas, sem PII)

> **Conteúdo de processos NÃO é persistido** em storage.local.
> Payloads ficam em storage.session ou IndexedDB apenas durante uso.

## Backend de auth do Inovajus
- E-mail institucional (whitelist)
- OTP temporário (descartado em 10 min)
- JWT 90 dias armazenado **só no navegador**

## Provedores externos de IA
Conteúdo selecionado é transmitido **diretamente do navegador** com a chave de API
do próprio usuário. Inovajus **não atua como intermediário**.

### Anonimização preventiva (antes do envio)
- CPF, RG, dados bancários: regex local
- Nomes próprios: substituídos por placeholders quando solicitado

### Restrição contratual de treinamento
Use chave Enterprise/Business — vedação contratual de uso para treino
(Art. 19, II, Res. CNJ 615/2025).

## Telemetria
**Inovajus NÃO coleta telemetria** de uso. Único contato recorrente é a
revalidação do JWT a cada 12h.

## Conformidade
- LGPD (Lei 13.709/2018)
- Res. CNJ 615/2025 (uso de IA no Judiciário)
- Res. CNJ 363/2021 (no que couber)
`,
  },

  // ========== CREDENCIAIS — TEMPLATES (🔑/🗝/📜/🔌) ==========
  {
    tipo: 'api-key',
    label: 'Anthropic API key (Claude)',
    tags: ['ia', 'anthropic', 'claude', 'enterprise'],
    usuario: 'vsousaesilva@jfce.jus.br',
    url: 'https://console.anthropic.com/settings/keys',
    conteudo: `(SUBSTITUA PELA SUA CHAVE)
sk-ant-api03-...

Plano: Enterprise / API (vedação de uso para treino — Art. 19 II Res. 615/2025)
Renovação: anual
Onde obter: https://console.anthropic.com/settings/keys
Modelo padrão: claude-opus-4-7 (Opus 4.7)
Modelos para tool-use leve: claude-haiku-4-5-20251001
`,
  },
  {
    tipo: 'api-key',
    label: 'OpenAI API key (GPT)',
    tags: ['ia', 'openai', 'gpt', 'whisper'],
    usuario: 'vsousaesilva@jfce.jus.br',
    url: 'https://platform.openai.com/api-keys',
    conteudo: `(SUBSTITUA PELA SUA CHAVE)
sk-proj-...

Plano: Business / Enterprise
Onde obter: https://platform.openai.com/api-keys
Uso: transcrição (Whisper) + GPT
`,
  },
  {
    tipo: 'api-key',
    label: 'Google Gemini API key',
    tags: ['ia', 'gemini', 'google'],
    usuario: 'vsousaesilva@jfce.jus.br',
    url: 'https://aistudio.google.com/apikey',
    conteudo: `(SUBSTITUA PELA SUA CHAVE)
AIzaSy...

Onde obter: https://aistudio.google.com/apikey
Plano: Workspace / Education (vedação de uso para treino)
`,
  },
  {
    tipo: 'api-key',
    label: 'GitHub PAT — paidegua-kanban-worker',
    tags: ['github', 'pat', 'worker', 'integracao'],
    usuario: 'vsousaesilva',
    url: 'https://github.com/settings/tokens',
    conteudo: `(SUBSTITUA PELO SEU TOKEN)
ghp_...

Scope: repo (Full control of private repositories)
Expiração: 1 ano
Uso: criar issues automáticas no Worker quando card cai em "dev"
Onde está usado: secret GITHUB_TOKEN do Worker paidegua-kanban-api
Renovar até: (preencha após criar)
`,
  },
  {
    tipo: 'api-key',
    label: 'Cloudflare API Token — deploy do Worker',
    tags: ['cloudflare', 'wrangler', 'ci', 'deploy'],
    usuario: 'vsousaesilva',
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    conteudo: `(SUBSTITUA PELO SEU TOKEN)

Template usado: "Edit Cloudflare Workers"
Permissões: Account · Workers Scripts · Edit; Account · Workers KV Storage · Edit
Account ID: (cole aqui)
Onde está usado: GitHub Actions secret CLOUDFLARE_API_TOKEN para deploy automático do Worker
Onde obter: https://dash.cloudflare.com/profile/api-tokens
`,
  },
  {
    tipo: 'api-key',
    label: 'Resend API key',
    tags: ['resend', 'email', 'otp'],
    usuario: 'vsousaesilva@jfce.jus.br',
    url: 'https://resend.com/api-keys',
    conteudo: `(SUBSTITUA PELA SUA CHAVE)
re_...

Domínio verificado: paidegua.ia.br
SPF/DKIM/DMARC: configurados no DNS de paidegua.ia.br
Uso: envio de OTP do Cofre/Login do Kanban
Onde está usado: secret RESEND_API_KEY do Worker
Limite Free: 3.000 e-mails/mês, 100/dia
`,
  },
  {
    tipo: 'senha',
    label: 'PJe TRF5 1G — login institucional',
    tags: ['pje', 'trf5', '1g', 'producao'],
    usuario: '(matricula institucional)',
    url: 'https://pje1g.trf5.jus.br',
    conteudo: `(SUBSTITUA PELA SUA SENHA)

Sistemas afetados:
- pje1g.trf5.jus.br (1º grau)
- pje2g.trf5.jus.br (2º grau)
- pjett.trf5.jus.br (turma recursal)

Política: troca a cada 90 dias
Política de complexidade: 8+ caracteres com número, letra e símbolo
Recuperação: portal de senha do TRF5 ou DTI
`,
  },
  {
    tipo: 'conexao',
    label: 'Inovajus / JFCE — backend de auth (GAS)',
    tags: ['inovajus', 'jfce', 'auth', 'jwt'],
    usuario: 'service account Apps Script',
    url: 'https://script.google.com',
    conteudo: `Backend de autenticação da extensão pAIdegua.

Tipo: Google Apps Script (script.google.com)
Endpoints:
  - request-otp: gera código de 6 dígitos
  - verify-otp: valida e emite JWT (HS256, 90 dias)
  - validate: revalida JWT
Whitelist: planilha Google Sheets em /drive/inovajus
Chave HS256: (anote o ID do segredo no GAS, não a chave em si)
Domínios autorizados: jfce.jus.br, trf5.jus.br, jfrn.jus.br, jfpb.jus.br, jfpe.jus.br, jfal.jus.br, jfse.jus.br

Quem opera: Inovajus / JFCE (revogação por desativar linha na whitelist)
Documentação interna: docs/dtic-consulta-suporte-paidegua.md
`,
  },
  {
    tipo: 'conexao',
    label: 'Cofre — passphrase mestra (lembrete)',
    tags: ['cofre', 'passphrase', 'mestra', 'critico'],
    usuario: 'compartilhada-equipe-inovajus',
    conteudo: `⚠️ LEIA COM ATENÇÃO

Esta entrada é apenas para anotar METADADOS sobre a passphrase do Cofre,
NÃO a passphrase em si.

NÃO ESCREVA A PASSPHRASE AQUI dentro do próprio Cofre — se você esquecer
e o cofre estiver bloqueado, esta entrada também estará indisponível.

Em vez disso, anote em GERENCIADOR DE SENHAS PESSOAL (Bitwarden, 1Password)
ou cofre físico (papel guardado em local seguro).

## Metadados

- **Estratégia**: passphrase compartilhada (todo Inovajus usa a mesma)
- **Onde está guardada**:
  - 1Password compartilhado: vault "Inovajus / pAIdegua"
  - Backup físico: (anote local)
- **Última rotação**: (preencha — ex.: 2026-05-03)
- **Próxima rotação prevista**: (preencha — ex.: 2026-11-03)
- **Quem tem acesso**: (lista de e-mails)

## Procedimento de rotação

1. Combine data e hora com a equipe
2. Cada membro abre o cofre com a passphrase atual
3. Backup do estado: \`wrangler kv:key get --binding=KANBAN_KV "vault:state" > backup-pre-rotacao.json\`
4. (Pendente automatizar) re-export plain → re-cifragem com nova passphrase → re-import
5. Distribuir nova passphrase pelo canal seguro
6. Marcar próxima rotação no calendário institucional
`,
  },
];
