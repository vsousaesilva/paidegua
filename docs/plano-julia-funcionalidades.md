# Plano — funcionalidades JULIA no pAIdegua

**Projeto:** pAIdegua
**Data:** 18/07/2026
**Status:** planejamento, **não implementado**. Requer aprovação.
**Base técnica:** [extracao-julia-trf5.md](extracao-julia-trf5.md) (contratos) e os
clientes já escritos em `src/shared/julia/`.

---

## 1. Decisão: API pública ou ambiente autenticado?

**Autenticado como primário. Não é preferência — é requisito.**

As três funcionalidades pedidas giram em torno do **entendimento da unidade**, e
unidade é 1º grau. A API pública não tem 1º grau (`G1` responde 400, §1.2 do doc de
extração). A consulta por CPF só existe no autenticado. Não há caminho pela pública.

**A pública permanece**, com papel definido — não por indecisão:

| | Autenticada | Pública |
|---|---|---|
| Cobertura | G1, JEF, TR, TRU (unidade) | G2, TR_*, TRU (precedente vinculante) |
| Inteiro teor | busca devolve trecho; +1 requisição por documento | vem completo na busca |
| Sessão | exige login no JULIA | nenhuma |
| Sigilo | expõe `sigiloso`/`publico` | acervo público por definição |

Para fundamentar minuta com precedente do TRF5, a pública resolve em **1 requisição**
o que a autenticada resolve em **1+N**. Para saber o que a vara decidiu, só a
autenticada serve. Usar as duas não é redundância: é cada uma no que é melhor.

A pública também é o **modo degradado**: sem sessão do JULIA, o Painel de Pesquisa
continua funcionando sobre 2º grau em vez de morrer.

### 1.1 Premissas de segurança (mantidas)

1. **Nenhuma credencial armazenada.** A sessão é a que o usuário já abriu no
   navegador; `credentials: 'include'` a carrega. Não há campo de senha.
2. **Sigilo filtrado por padrão**, não por opção do chamador
   (`filtrarSigilosos()` em `julia-client-autenticado.ts`). Documento sigiloso não
   vai a painel, a cache nem a provedor de IA.
3. **Anonimização antes do LLM** — `shared/anonymizer.ts`, como no resto da extensão.
4. **Nada de PII em log** (gate INFRA-15 do CI).
5. **CPF nunca ao LLM nem a cache** (§4).

### 1.2 Risco arquitetural: RESOLVIDO ✅

Estava em aberto se o cookie do JULIA acompanharia requisição de contexto de
extensão. **Acompanha** — verificado em 18/07/2026 (doc de extração §5.15).

O `JSESSIONID` tem `SameSite` ausente (= `Lax` no Chrome) e `Path=/julia`, o que
apontava para restrição. Mas requisição iniciada por extensão com
`host_permissions` não sofre a restrição aplicada a página comum: o teste do
service worker devolveu 200 e JSON.

Consequência: **os dois clientes rodam no service worker**, os painéis chamam
direto, e não há encaminhamento por content script nem dependência de aba do PJe
aberta. As três funcionalidades ficam livres dessa condicional.

### 1.3 Fragilidade de sessão — requisito, não polimento

O `JSESSIONID` é cookie **de sessão** (`Expires: Session`). Morre ao fechar o
navegador; só atravessa dias quando a restauração de sessão do Chrome está ligada.

A observação inicial de que "a sessão dura muito" reflete a configuração de um
navegador, não o comportamento do sistema. Para os pilotos, sessão expirada será
**evento comum**.

Isso não reabre a decisão de não guardar senha, mas eleva o tratamento de
reconexão: `JuliaSessaoExpiradaError` precisa detectar, preservar o que a pessoa
estava fazendo, abrir o JULIA e retomar a ação — não exibir um toast e perder o
trabalho. Vale para as três funcionalidades, e especialmente para a geração de
minuta, onde a falha ocorreria no meio de um fluxo longo.

---

## 2. "Fale com Júlia" — chat com análise dupla

### 2.0 Os dois escopos, e por que a divisão de APIs serve a eles

O usuário pede duas leituras, conforme a necessidade:

| Escopo | Pergunta | Fonte | API |
|---|---|---|---|
| **Unidade** | "como vem sendo o entendimento da unidade" | G1 / JEF da unidade | **autenticada** |
| **Revisor** | "como vem decidindo a segunda instância" | órgão que revisa a unidade | **pública** |

Usar a **pública** para o escopo revisor é decisão deliberada, por três razões:
traz o inteiro teor em **uma** requisição (a autenticada exige 1+N), **não depende
de sessão** — de modo que a metade recursal continua respondendo mesmo com o
JULIA deslogado — e seus valores de instância estão **verificados**, enquanto
`TR`/`TRU` no autenticado seguem inferidos (§5.10 do doc de extração).

#### O revisor depende do rito — mapeamento obrigatório

| Unidade | Órgão revisor | Instância na API pública |
|---|---|---|
| JEF | Turma Recursal da seccional | `TR_{UF}` (+ `TRU` para uniformização) |
| Comum (G1) | TRF5 | `G2` |

**Errar isso invalida a comparação**: confrontar sentença de JEF com acórdão do
TRF5 é medir a unidade contra um tribunal que não a revisa. O mapeamento não é
configuração do usuário — é derivado da instância da unidade consultada.

#### O valor está no confronto, e o risco também

A entrega não são duas respostas lado a lado: é o **alinhamento ou a divergência**
entre elas. Divergência entre a vara e seu órgão revisor é exatamente o sinal
útil — antecipa reforma.

Mas "a unidade diverge do TRF5" é asserção **mais forte** que "a unidade entende
X", e erra mais feio. Exige as mitigações de §2.3 aplicadas **aos dois lados**, e
uma regra adicional: só afirmar divergência quando houver base contada nos dois
escopos. Faltando um lado, apresentar o que há e **dizer que a comparação não foi
possível** — nunca inferir divergência a partir de ausência.

### Arquitetura

RAG de pipeline fixo, **não agêntico** — `providers/base.ts` não tem tool-use, e
implementá-lo é projeto próprio (Fase 5).

```
pergunta
  → LLM #1: extrai termos + filtros (JSON mode)
  → buscarDocumentos() na unidade
  → obterSumario() para o universo real
  → obterInteiroTeor() dos N melhores (N = 3–5)
  → segmentar por instância (DISPOSITIVO / EMENTA)
  → LLM #2: sintetiza com citação obrigatória
  → render com link de volta ao PJe
```

### Perfil: **Gabinete**

Decidido em 18/07/2026. O ponto de entrada aparece só no perfil Gabinete — é o
perfil que minuta, e pesquisa de jurisprudência serve à fundamentação. Secretaria
e Gestão não expõem a funcionalidade.

### Impacto no estado atual

| Arquivo | Situação |
|---|---|
| `src/shared/julia/julia-segmentador.ts` | ✅ escrito |
| `src/shared/julia/julia-rag.ts` | ✅ escrito |
| `src/shared/julia/julia-prompts.ts` | ✅ escrito |
| `src/background/julia-orquestrador.ts` | ✅ escrito |
| `src/shared/constants.ts` | ✅ `PORT_NAMES.JULIA_STREAM`, `JULIA_PORT_MSG`, `JULIA_ETAPA` |
| `src/background/background.ts` | ✅ porta `JULIA_STREAM` |
| `src/content/ui/chat.ts` (ou superfície própria) | pendente — gating por perfil Gabinete |

**Sem mudança de manifesto.** `https://*.jus.br/*` já cobre. Nenhuma permissão
nova para os pilotos aprovarem.

### Garantia dupla da base contada

O evento `EVIDENCIA` da porta leva os números reais da recuperação (universo,
lidos, descartados, fontes, processos) **antes** do texto começar a chegar.

A interface renderiza a amostra a partir desse dado, não do que o modelo escreve.
O prompt também obriga o modelo a declará-la, mas instrução de prompt é
probabilística — o número na tela vem da recuperação e não depende de o LLM
cooperar. O texto explica; a interface prova.

### Riscos

**Orçamento de contexto — o risco de engenharia.** Cinco sentenças a ~6.400 chars
são ~32 mil caracteres por rodada, antes do histórico. Multi-turno estoura rápido.
Mitigação: recuperar **uma vez**, guardar os trechos segmentados no estado da
conversa e não reinjetar texto integral a cada turno.

**Generalização falsa — o risco profissional, e o maior dos três.** "Qual
entendimento prevalece" é asserção de síntese. Um modelo que lê 5 de 400 decisões e
responde "a unidade entende que X" produz afirmação de aparência autoritativa sobre
base não representativa — e um servidor pode minutar em cima disso.

Mitigações **obrigatórias**, não opcionais:

- Exibir a base: "encontradas N decisões; analisadas as M mais relevantes" — o
  `obterSumario()` dá o N real sem custo de download.
- Citação por afirmação, com link ao inteiro teor.
- Quando houver divergência, **mostrar a divergência** em vez de eleger a maioria.
- Nunca redigir como entendimento pacificado sem base contada.
- Exibir a data de atualização do índice (`obterDataAtualizacao()`): o acervo estava
  ~6 dias defasado em 18/07/2026.

---

## 3. Minutas fundamentadas no que a unidade já julgou

### Princípio: duas fontes, dois papéis — não misturar

Os **modelos indexados** (BM25, `templates-search.ts`) e os **precedentes do JULIA**
respondem perguntas diferentes:

- Modelo → **forma**: estrutura, linguagem, seções do ato.
- Precedente → **substância**: como esta unidade vem decidindo o mérito.

Devem ocupar **slots distintos do prompt, com instruções distintas**. Fundi-los num
único bloco de contexto deixa o modelo copiar a estrutura do precedente por cima do
modelo curado — perdendo exatamente o valor que não se quer abrir mão.

### Arquitetura

Etapa de enriquecimento **compartilhada**, não código por modo. O pedido é "nos
diversos modos que o paidegua faz isso"; N implementações divergem em semanas.

```
enriquecerComJulia(contexto) → { precedentes: JuliaDocumento[], universo: number }
```

Chamada uma vez antes da montagem do prompt, em todos os modos.

### Impacto no estado atual

| Arquivo | Mudança |
|---|---|
| `src/shared/prompts.ts` | novo slot de precedentes, separado do de modelos |
| `src/background/background.ts` | orquestra a busca junto da recuperação BM25 |
| — | novo `julia-enriquecimento.ts` |
| — | novo segmentador por instância (§5.11 do doc de extração) |

**Nada é removido.** A recuperação BM25 de modelos fica intacta.

### Riscos

**Latência.** Geração de minuta ganha +1 busca +N inteiro teor. Paralelizar e
**limitar por tempo**: se o JULIA não responder em X segundos, gerar sem precedente
em vez de travar o fluxo. Degradar, nunca bloquear.

**Contexto.** Modos que já usam modelos grandes podem estourar ao ganhar precedentes.
Por isso o segmentador (DISPOSITIVO em sentença, EMENTA em acórdão) é
**pré-requisito**, não melhoria.

**Regressão.** Flag por modo, para que problema num modo não contamine os demais.

---

## 4. CPF na análise inicial — prevenção

### Revisão de posição

O doc de extração (§5.5) recomendou **não** implementar busca por CPF. Aquela
recomendação supunha busca livre por pessoa, sem finalidade definida.

**A finalidade muda a análise.** Verificação de prevenção é dever processual da
unidade, escopada à própria jurisdição, executada por servidor que já tem acesso aos
autos pelo PJe. Não é vigilância — é a checagem que hoje se faz manualmente.

Retiro a objeção **para este uso**, com as condições abaixo. A objeção permanece de
pé para uma busca livre por pessoa.

### Condições de projeto

1. **Sem caixa de busca por CPF.** Acionado a partir do processo em análise; os CPFs
   vêm das partes **daquele** processo. O usuário não digita CPF — não há pesca.
2. **Escopo da unidade**, não do TRF5 inteiro.
3. **CPF nunca vai ao LLM.** O modelo recebe "a parte tem 3 processos anteriores
   nesta vara", nunca o número.
4. **Sem cache** da relação CPF → processos.
5. **Sinal, não conclusão.** Prevenção é ato decisório. A interface apresenta
   candidatos com link ao PJe; quem conclui é o servidor.
6. **Alinhar com a DTI antes de lançar.** Das três, é a que mais claramente pede
   conversa institucional prévia.

### Impacto no estado atual

| Arquivo | Mudança |
|---|---|
| `src/content/ui/analise-processo-bubble.ts` | novo campo no resultado |
| `src/shared/validacao-cadastro-regras.ts` | possível nova regra |
| — | novo `julia-prevencao.ts` |

### Bloqueio

O endpoint `processos:dt` **não foi capturado**. Sabe-se que existe e que a interface
tem campo CPF/CNPJ, mas não os nomes dos parâmetros nem a forma do item.

- [ ] Capturar: aba **Processos**, busca por CPF, com o coletor ativo.

---

## 5. Sequenciamento sugerido

**Definido com o autor em 18/07/2026:**

| Ordem | Item | Situação |
|---|---|---|
| 1 | **Fale com Júlia** (§2) | em implementação |
| 2 | **Prevenção por CPF** (§4) | em seguida; bloqueada por captura de `processos:dt` |
| — | **Minutas** (§3) | **fora de escopo por ora** |

Minutas ficam de fora por decisão explícita: o fluxo está estável em produção com
os pilotos, e não se mexe no que funciona sem necessidade. O plano da §3 permanece
escrito para quando fizer sentido.

**Consequência de projeto:** o segmentador por instância, que seria construído na
etapa de minutas, passa a ser construído no "Fale com Júlia" — ele é
pré-requisito ali também (acórdão pede EMENTA, sentença pede DISPOSITIVO).

E o módulo de recuperação deve ser escrito **desacoplado do chat**, para que a
etapa de minutas o reuse sem reescrita quando for retomada. Concretamente: a
recuperação e a segmentação não conhecem a interface de conversa; quem monta o
prompt é o chamador.

## 6. Pendências técnicas herdadas

- [ ] `SameSite` e `Max-Age` do cookie (§1.2) — **bloqueante**
- [ ] Parâmetros de `processos:dt` (§4) — bloqueia a etapa 3
- [ ] Valores de `instancia` para TR e TRU no autenticado
- [ ] O teto de 10.000 vale na API autenticada?
- [ ] Conteúdo do campo `message` das respostas `:dt`
