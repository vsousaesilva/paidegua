# Manual — Operar o Kanban por conversa (modo A)

Este manual documenta como você instrui o **Claude Code** (esta sessão) a operar o quadro Kanban por linguagem natural, durante o desenvolvimento. É o **modo A** descrito no chat — você fala, eu executo edições direto no `seed.json` (offline) ou via Worker (deploy).

> **Para o modo B** (chat embutido na própria página `kanban.paidegua.ia.br`, sempre disponível para a equipe Inovajus): ainda não está implementado. Quando estiver, o vocabulário deste manual continuará válido.

---

## 1. O que entra de fato no quadro

Quando você dá um comando, eu executo um destes efeitos no `seed.json` (modo offline) ou na API (`PUT /api/cards/:id`) e regenero `seed.js`:

| Operação | Campo afetado | Histórico automático |
|---|---|---|
| Mover card | `coluna` | sim — registra `de`/`para`/autor/data |
| Criar card | tudo | sim — registra `criado` |
| Editar título/descrição | `titulo`, `descricao` | sim — registra `editado` |
| Mudar prioridade | `prioridade` | sim — registra `prioridade-alterada` |
| Mudar categoria | `categoria` | sim |
| Atribuir | `owner`, `assignees[]` | sim |
| Datas | `dataInicio`, `dataPrevista`, `dataConclusao` | sim |
| Esforço | `esforco` (S/M/L/XL) | sim |
| Fase | `fase` (F1..F7) | sim |
| Tags | `tags[]` | sim |
| Critérios de aceitação | `aceitacao[]` | sim |
| Checklist (criar/marcar) | `checklist[]` | sim |
| Comentário | `comentarios[]` | sim |
| Links/anexos | `links[]` | sim |
| Marcar bloqueio | `coluna: 'bloqueado'` + `bloqueadoPor: '...'` | sim |
| Excluir | remove do `cards[]` | (registrado no audit log) |
| Reverter última ação | restaura snapshot | sim |

---

## 2. Vocabulário básico — você escreve livre

Não precisa decorar comando. Eu interpreto português natural. Os **verbos** que reconheço com 100 % de confiança:

### Movimentação
- *mova / mover / passa / passe / leva / leve* + ID + para + coluna
- *empurra / arrasta / move pra trás*

**Colunas válidas** (use o nome em português, mesmo informal):
| Termo aceito | Coluna real |
|---|---|
| triagem, backlog | `triagem` |
| discovery, investigação, investigação técnica | `discovery` |
| spec, especificação, ADR | `spec` |
| dev, desenvolvimento, em desenvolvimento, codando | `dev` |
| qa, testes, em revisão, code review | `qa` |
| validação, homologação, comitê, inovajus | `validacao` |
| piloto, vara-piloto, em produção piloto | `piloto` |
| lançado, produção, prod, released | `lancado` |
| bloqueado, travado, parado | `bloqueado` |
| arquivado, descartado, postergado | `arquivado` |

### Criação / edição
- *cria / crie / adicione / novo card*
- *edita / altera / muda / renomeia / atualiza*
- *remove / exclui / apaga / arquiva*

### Atribuição e datas
- *atribui / atribua / assign / dá pra / responsável é*
- *deadline / prazo / data prevista / até*
- *começou em / iniciou em / data de início*

### Listagem (eu mostro, não modifico)
- *lista / liste / mostra / quais são / quero ver*
- *quantos / contagem / resumo / status*

---

## 3. Como referenciar cards

**Por ID** (sempre o caminho mais seguro):
> *"Move CONF-01 e CONF-02 pra spec"*

**Por título parcial** (quando não sabe o ID):
> *"Move o card de pauta inteligente pra dev"*
> *"Bloqueia o card de transcrição de áudio com motivo: aguardando licença da OpenAI"*

**Por filtro** (quando quer atingir vários):
> *"Move todos os cards P0 de infraestrutura da fase F1 pra spec"*
> *"Atribui pro vsousaesilva todos os cards de Metas CNJ"*
> *"Marca como concluído todo o checklist do CONF-01"*

**Por categoria + prioridade**:
> *"Quais P0 estão em triagem?"*
> *"Mostra os cards de Audiência que estão em dev"*

---

## 4. Exemplos prontos

### 4.1 Movimentação simples
```
"Move CONF-01 para spec."
```
→ Edito `coluna`, registro evento de histórico, regenero `seed.js`. Recarrega no navegador (Ctrl+F5) e o card está na nova coluna.

### 4.2 Movimentação em lote
```
"Move INFRA-01, INFRA-02 e INFRA-13 para dev — atribui pra mim,
data de início hoje, dataPrevista 31/05/2026."
```
→ 3 cards transitam, ganham `owner: vsousaesilva@jfce.jus.br`, `dataInicio` e `dataPrevista` preenchidas.

### 4.3 Criar card novo
```
"Cria um card P1 em Infraestrutura: 'Painel de erros do PJe (HTTP 5xx) com tendência'.
Descrição: histórico de erros agregado por tarefa, alerta quando dispara acima da média.
Origem: gap-pesquisa. Tags: diagnóstico, alerta. Esforço M. Depende de INFRA-01."
```
→ Crio com ID auto-incrementado da categoria (ex.: `INFRA-20`), todos os campos preenchidos.

### 4.4 Quebrar card em checklist
```
"Para INFRA-01, cria checklist:
1. Esqueleto da classe pjeGateway
2. Implementar fila com prioridade
3. Implementar jitter aleatório
4. Reusar retry de pje-api-from-content.ts
5. Escrever testes de carga (50 paralelos)
6. Migrar primeiro consumidor (pje-api-partes.ts)"
```

### 4.5 Marcar item de checklist
```
"INFRA-01 item 3 do checklist concluído."
```
ou
```
"Marca como feito 'Implementar jitter aleatório' do INFRA-01."
```

### 4.6 Comentar
```
"Comenta no CONF-01: 'Falei com o Inovajus, ADR aprovado em reunião de 15/05.'"
```

### 4.7 Bloquear
```
"Bloqueia INT-05 com motivo: aguardando convênio formal com a Dataprev/INSS."
```
→ Move para `bloqueado` e preenche `bloqueadoPor`.

### 4.8 Listar
```
"Quais cards P0 ainda estão em triagem?"
```
→ Eu respondo com tabela markdown listando ID, título, categoria, fase.

### 4.9 Resumir status
```
"Me dá um resumo do quadro: quantos por coluna, quantos P0/P1, fases."
```
→ Tabela consolidada.

### 4.10 Reverter
```
"Reverte a última ação."
```
ou
```
"Desfaz a movimentação do CONF-01."
```
→ Eu uso `git diff` para identificar minha alteração mais recente em `seed.json` e reverto.

---

## 5. Como confirmar o que aconteceu

Após cada comando eu te respondo com um bloco curto:

> ✅ **CONF-01** movido `triagem → spec`
> ✅ owner = `vsousaesilva@jfce.jus.br`
> ✅ checklist criada (5 itens)
> ✅ aceitacao preenchida (5 critérios)
> ✅ histórico registrado (2 eventos)
> ✅ seed.js regenerado

Para conferir visualmente, **Ctrl+F5** no navegador. O card aparece na coluna nova com os ícones de checklist (X/Y) e prioridade.

---

## 6. Dois "espaços" diferentes

| Onde | Como atualizar | Quem vê |
|---|---|---|
| **`seed.json` + `seed.js`** | Eu edito direto. Você vê com Ctrl+F5. | Você abrindo `index.html` em `file://` (offline) |
| **Cloudflare KV** (deploy) | Eu chamaria `curl -X PUT /api/cards/:id` autenticado | Toda a equipe Inovajus em kanban.paidegua.ia.br |

Enquanto não fizer deploy, eu opero **só no modo offline**. As edições ficam no Git da pasta `docs/kanban-massificacao/` e você pode dar `git diff` a qualquer momento para ver tudo que mudou.

Quando fizermos deploy, basta você me avisar:
> *"O Worker já está em kanban.paidegua.ia.br/api. Quando eu mandar comando, sincroniza com o KV também."*

E eu passo a executar comandos via `curl` autenticado pelo seu token bearer (que você me passa uma vez).

---

## 7. Limites importantes — leia

1. **Memória de sessão**: nesta sessão eu lembro tudo que executei até agora. Em uma **nova sessão**, eu não lembro — você precisa me reapresentar o contexto (ou peço para eu ler `seed.json` e `MEMORY.md`).
2. **Operações destrutivas**: para `excluir`, `arquivar` e `reverter` eu **sempre confirmo** antes de executar. Não saio apagando por interpretação ambígua.
3. **Conflitos**: se você der dois comandos contraditórios em sequência (ex.: *"Move CONF-01 pra spec"* e logo depois *"Não, deixa em triagem"*), o segundo prevalece.
4. **Escala de comando**: para mais de ~50 cards de uma vez, vou pedir confirmação ("Vou afetar 67 cards. Pode prosseguir?").
5. **Auditoria**: cada modificação minha entra em `card.historico` com `autor: "claude-code/sessao-<data>"`. Você consegue diferenciar do que membros da equipe fizerem (autor seria o e-mail deles).
6. **Git**: depois de uma sessão produtiva, dê `git diff docs/kanban-massificacao/seed.json` para revisar tudo. E `git commit` para preservar.
7. **Modo deploy** (Cloudflare): quando eu operar no KV via API, **toda a equipe vê em tempo real** ao recarregar. Use com cuidado em horário de trabalho deles.

---

## 8. Fluxos típicos

### 8.1 Sprint planning de quinta de manhã
```
Você: "Mostra os P0 em triagem da fase F1."
Eu: <tabela com 8 cards>
Você: "Move INFRA-01, INFRA-02 e INFRA-13 pra spec, atribui a você,
       dataPrevista 17/05."
Eu: ✅ 3 cards atualizados.
Você: "Pra INFRA-01 cria checklist com 6 itens: ..."
Eu: ✅ checklist criada.
```

### 8.2 Daily de segunda
```
Você: "Resumo do que mudou desde sexta."
Eu: <lista das movimentações + comentários novos + cards criados>
Você: "Bloqueia INT-05 com motivo: convênio Dataprev pendente."
Eu: ✅ bloqueado.
```

### 8.3 Após uma reunião com Inovajus
```
Você: "Da reunião de hoje:
       - CONF-07 aprovado, mover pra dev.
       - Comentar em CONF-07: 'Comitê aprovou submissão. Próxima quinta o doc final.'
       - Criar card P1 em Conformidade: 'Submeter ADR de auditoria ao CNIAJ',
         depende de CONF-07."
Eu: ✅ 3 ações executadas.
```

### 8.4 Refatoração de prioridades
```
Você: "Tira a fase F1 dos cards de calculadoras e marca como F5."
Eu: ✅ 7 cards reclassificados.
Você: "Reduz prioridade dos cards de acessibilidade pra P3."
Eu: ✅ 3 cards rebaixados.
```

---

## 9. Atalho mental: o "frame" pra dar comandos

Toda vez que for me pedir algo, pense em **três coisas**:

1. **Qual card(s)?** ID, título, ou filtro
2. **Qual ação?** Verbo claro
3. **Qual valor?** Coluna, prazo, pessoa, texto

Exemplo travado em uma frase:
> *"[INFRA-01] [pra dev] [com data prevista 17/05]"*

Eu interpreto sempre. Se faltar um pedaço, eu pergunto.

---

## 10. O que estou pronto pra fazer agora (ações reais que você pode pedir)

- ✅ Mover, criar, editar, atribuir, datear, comentar, bloquear, arquivar, excluir, reverter
- ✅ Criar e marcar checklists
- ✅ Listar e resumir
- ✅ Aplicar mudança em lote por filtro
- ✅ Manter histórico automático em todos os cards
- ✅ Regerar `seed.js` automaticamente
- ✅ Sugerir mudanças quando faz sentido (ex.: "movi pra dev mas você não definiu owner — quer me atribuir?")

## 11. O que ainda não dá pra fazer (e quando vai dar)

| Não dá ainda | Quando dá |
|---|---|
| Operar via kanban.paidegua.ia.br pra equipe inteira | Após o deploy do Worker |
| Notificar por e-mail quando atribuído | Onda 2 do Worker (~2 semanas) |
| Webhook GitHub → mover card automático | Modalidade "B" (próximo turno se você pedir) |
| Chat embutido no Kanban (modo B) | Próximo turno |
| Exportar para CSV / planilha | Faço manual sob demanda; export nativo na próxima |

---

**Pronto para usar.** Manda o próximo comando.
