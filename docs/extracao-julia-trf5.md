# Extração do JULIA — Pesquisa de jurisprudência TRF5

**Projeto:** pAIdegua — plataforma de apoio à atividade e gestão judicial no PJe
**Data:** Julho/2026
**Status:** Fase 0 — **contratos do acervo público confirmados**. Pendente: 1º grau
(exige JULIA autenticado) e vocabulário de alguns filtros.
**Contexto:** o JULIA é o sistema de pesquisa do TRF5 sobre a base do PJe. O objetivo
é consumi-lo a partir do paidegua para (a) um painel de pesquisa próprio e (b)
fundamentar minutas e triagens em jurisprudência real do Tribunal, em vez de
precedente alucinado pelo LLM.

---

## 1. Achado principal: existe API JSON pública, sem autenticação

`juliapesquisa.trf5.jus.br` expõe uma **API REST JSON**, no protocolo
*DataTables server-side*:

```
GET https://juliapesquisa.trf5.jus.br/julia-pesquisa/api/v1/documento:dt/{instancia}
```

**Não exige autenticação.** Verificado em 18/07/2026 a partir de cliente anônimo,
sem cookie, sem `referer` e sem `x-requested-with` — respondeu 200 com o mesmo
`recordsTotal` observado no navegador logado. Os cookies presentes na captura do
navegador (`trf5361cd1e2027`, `5a292a765166d38b90f5e9ce17f2d2c3`) são *stickiness*
de balanceador; `_clck`/`_clsk` são do Microsoft Clarity. **Nenhum é de sessão.**

Consequência para a arquitetura: para o acervo de 2º grau, TR e TRU **não há sessão,
não há credencial e não há cookie a gerenciar**. Toda a discussão sobre armazenar
senha (§2) fica restrita ao 1º grau.

### 1.1 O parâmetro `{instancia}` é composto

Para Turma Recursal o segmento carrega a seccional: **`TR_{UF}`**. É por isso que
`TR` puro responde 400.

| Valor | Resultado |
|---|---|
| `G2` | ✅ 200 |
| `TRU` | ✅ 200 |
| `TR_CE` | ✅ 200 → `orgao: JFCE` |
| `TR_PE` | ✅ 200 → `orgao: JFPE` |
| `TR_AL`, `TR_PB`, `TR_RN`, `TR_SE` | presumidos válidos — a interface oferece as 6 seccionais |
| `G1`, `G1_CE`, `JEF`, `JEF_CE`, `TR`, `TURMA_RECURSAL` | ❌ 400 |

**O segmento da URL não é o mesmo vocabulário dos campos da resposta.** `TR_CE` na
URL retorna `orgao: "JFCE"` + `instancia: "TR"` nos itens. O cliente precisa de um
mapa explícito URL↔resposta; não dá para derivar um do outro por string.

### 1.2 O 1º grau não está na API **pública** — mas está no JULIA autenticado

Na API pública: `G1`, `G1_CE` e `JEF_CE` respondem **400** (rejeição de enum, não
lista vazia), e a interface só oferece Segundo Grau, Turma Recursal e TRU.

No **JULIA autenticado** (`julia.trf5.jus.br`) o 1º grau está presente e confirmado
por duas evidências independentes (§5): o seletor de Instância inclui **Comum** e
**JEF**, e o dropdown de Órgão Julgador lista varas de primeiro grau
(ex.: "35ª VARA FEDERAL CE").

---

## 2. Decisão de arquitetura

O paidegua **não armazenará credenciais do JULIA**. `host_permissions:
https://*.jus.br/*` no [manifest.json](../manifest.json) já cobre os dois hosts —
**nenhuma permissão nova**.

Onde cada cliente roda difere, e a diferença importa:

| | Acervo público (§1) | 1º grau autenticado (§5) |
|---|---|---|
| Contexto | **service worker** | **content script** |
| Por quê | outra origem que a do PJe; em MV3 o content script não herda a isenção de CORS das `host_permissions`, o background herda | precisa do cookie de sessão, que só acompanha requisição same-origin do próprio navegador |
| Cookie | nenhum | `credentials: 'include'` |

Ou seja: o critério não é preferência de estilo, é de onde o cookie precisa vir. O
acervo público não tem sessão a carregar, então nada se perde ao sair do content
script — ao contrário do PJe, cujas chamadas ficam no content justamente por isso
(ver `src/content/pje-api/pje-api-criminal.ts`).

Justificativa: a senha do JULIA é a credencial institucional do servidor (mesma do
portal TRF5). O mecanismo de [crypto.ts](../src/background/crypto.ts) é
declaradamente ofuscação com segredo fixo embutido no build — adequado para chaves
de API, inadequado para credencial funcional numa extensão de distribuição pública.

Observação de campo (17/07/2026), **depois corrigida**: a sessão sobreviveu de um dia
para o outro, o que sugeriu cookie persistente de longa duração. **Não é** — o
`JSESSIONID` é cookie de sessão (`Expires: Session`, §5.15), e o que o preservou foi
a restauração de sessão do Chrome ("Continuar de onde parou").

A conclusão sobre não guardar senha permanece de pé. O que muda é a premissa de
frequência: sessão expirada é evento **comum**, dependente da configuração do
navegador de cada piloto, e não a raridade que eu havia suposto. O tratamento de
reconexão passa a ser requisito de primeira classe, não polimento.

---

## 3. Contrato da API pública

### 3.1 Parâmetros

O *boilerplate* DataTables **é obrigatório** — omitir o bloco `columns[0][...]`
resulta em **400**, inclusive numa `{instancia}` válida. Verificado.

| Parâmetro | Papel | Observação |
|---|---|---|
| `draw` | eco do DataTables | devolvido igual na resposta |
| `columns[0][data]` | `codigoDocumento` | obrigatório |
| `columns[0][name]` | vazio | obrigatório |
| `columns[0][searchable]` | `true` | obrigatório |
| `columns[0][orderable]` | `false` | obrigatório |
| `columns[0][search][value]` | vazio | obrigatório |
| `columns[0][search][regex]` | `false` | obrigatório |
| `search[value]` / `search[regex]` | vazio / `false` | obrigatório |
| `start` | offset (0-based) | paginação |
| `length` | tamanho da página | UI usa 10; ver §3.4 |
| `_` | cache-buster (epoch ms) | provavelmente ignorável |
| **`pesquisaLivre`** | termo de busca | **aceita vazio** — ver §3.3 |
| **`numeroProcesso`** | 20 dígitos, sem máscara | |
| **`orgaoJulgador`** | vocabulário **a confirmar** | |
| **`relator`** | nome | vocabulário a confirmar |
| **`dataIni` / `dataFim`** | `dd/MM/yyyy` | ver §3.2 |

### 3.2 Assimetria de data — atenção na implementação

**Entrada em `dd/MM/yyyy`, saída em ISO `yyyy-MM-dd`.** Verificado:
`dataIni=01/01/2026&dataFim=31/01/2026` → `dataJulgamento: "2026-01-31"`.

O cliente precisa converter nos dois sentidos. É o tipo de detalhe que passa em teste
manual e quebra em produção com data de virada de mês.

### 3.3 Busca por data sem termo

`pesquisaLivre` vazio é aceito: o filtro só por intervalo retornou **3.167** registros
para janeiro/2026. Isso viabiliza varredura sistemática do acervo (ex.: cache local
de precedentes por tema), não apenas busca pontual.

### 3.4 Paginação — e o teto de 10.000

`start`/`length`, com `recordsTotal` na resposta.

**`TR_PE` com `pesquisaLivre=aposentadoria` devolveu `recordsTotal: 10000` exato.**
Número redondo demais para ser contagem real: é quase certamente o
`index.max_result_window` padrão do **Elasticsearch**, o que indica busca indexada
por trás (coerente com os operadores `prox`/`adj`/`$` da interface).

Duas consequências, ambas capazes de gerar bug silencioso:

1. **`recordsTotal` é teto, não contagem.** Ao exibir "10.000 resultados" o painel
   estaria mentindo. Mostrar "mais de 10.000" quando o valor bater exatamente nisso.
2. **Paginação profunda quebra.** `start` além de ~10.000 tende a devolver erro, não
   página vazia. O cliente precisa parar em `start + length > 10000` e orientar o
   usuário a refinar os filtros.

- [ ] Confirmar o comportamento em `start=9999` e `start=10001`.
- [ ] **Verificar no navegador o `length` máximo aceito** (testar 50, 100, 500).
      Define o custo de varredura. Uma tentativa com `length=100` devolveu 16 itens,
      mas isso é provável truncamento da ferramenta de captura — o `texto` é enorme
      (§3.6) — e não teto do servidor. Inconclusivo.

### 3.5 Resposta

```jsonc
{
  "draw": 1,
  "recordsTotal": 420,
  "recordsFiltered": 420,
  "data": [ /* itens */ ]
}
```

Campos de cada item (observados preenchidos):

| Campo | Exemplo / observação |
|---|---|
| `codigoDocumento` | `TRF5:G2:PJE_NACIONAL:120477:11321005:11148155` — `{orgao}:{instancia}:{sistema}:{3 ids}` |
| `sistema` / `instancia` / `orgao` | `PJE` / `G2` / `TRF5` |
| `tipoDocumento` | `EMENTA` (visto em G2), `ACORDAO` (visto em TR) — vocabulário completo a mapear |
| `numeroProcesso` | `08234046520214058300` — 20 dígitos, **sem máscara** |
| `classeJudicial` | `APELAÇÃO CÍVEL` |
| `relator`, `orgaoJulgador` | `GAB 21 - DES. FREDERICO DANTAS` |
| `dataJulgamento`, `dataAssinatura` | ISO `yyyy-MM-dd` |
| `ativo` | boolean |
| **`texto`** | **inteiro teor da ementa** — ver §3.6 |
| **`resumo`** | citação pronta: `(PROCESSO: …, CLASSE, RELATOR, ÓRGÃO, JULGAMENTO: dd/MM/yyyy)` |

Sempre `null`/vazios na amostra: `numeroSequencialClasse`, `siglaClasse`,
`numeroClasse`, `ufClasse`, `revisor`, `relatorAcordao`, `dataAutuacao`, `decisao`,
`indexacao`, `referencia`, `outrasReferencias`, `observacao`, `url`,
`referenciasLegislativas`, `publicacoes`, `votantes`, `doutrinas`, `destaques`.

### 3.6 `texto` já traz o inteiro teor — e vem com HTML

**A busca já devolve a ementa completa.** Não há chamada separada de "obter inteiro
teor" para ementas, o que elimina um round-trip por resultado e simplifica muito o
grounding (§6).

Quatro consequências práticas:

1. **O `texto` contém `<em>…</em>`** marcando os termos buscados
   (`natureza de <em>lucro</em> <em>cessante</em>`). É preciso **sanitizar antes de
   renderizar** (nunca `innerHTML` cru) e **remover as tags antes de enviar ao LLM**,
   ou o modelo trata a marcação como conteúdo.
2. **O `texto` contém PII**: nomes de partes, advogados com OAB, magistrados, números
   de processo reais. Ver §4.
3. **O volume varia MUITO por instância.** Em `G2`, `tipoDocumento: EMENTA` traz só a
   ementa. Em `TR_CE`, `tipoDocumento: ACORDAO` traz o **acórdão inteiro** — ementa +
   relatório + voto + acórdão, com os cabeçalhos repetidos a cada seção. Um único
   documento passou de 15 mil caracteres. Para grounding (§7, Fase 3) isso é proibitivo
   sem recorte: enviar 5 acórdãos de TR ao LLM estoura contexto e custo. **Extrair só
   a seção EMENTA antes de montar o prompt.**
4. **A resposta pode conter duplicatas.** Em `TR_CE`, dois itens vieram com
   `codigoDocumento` byte-idêntico (`JFCE:TR:PJE_NACIONAL:388389:23331069:23172369`) e
   `texto` idêntico. **Deduplicar por `codigoDocumento`** — e cuidado para não confundir
   com o caso legítimo de vários documentos distintos sob o mesmo `numeroProcesso`
   (ED + acórdão originário), que têm `codigoDocumento` diferentes.

---

## 4. LGPD e tratamento de PII

O acervo é público, mas o `texto` traz nome de parte, advogado e número de processo.
Duas obrigações no cliente:

- **Nunca logar `texto` cru** — o gate de PII do CI (INFRA-15) reprova, e com razão.
- **Passar por [anonymizer.ts](../src/shared/anonymizer.ts) antes de enviar a
  provedor de IA externo** (Anthropic/OpenAI/Gemini). Publicidade do dado no site do
  Tribunal não equivale a autorização para transferi-lo a terceiro.

---

## 5. JULIA autenticado — o que a interface já revelou

Reconhecimento visual da área logada em 18/07/2026 (`/julia/consultar#consulta`).

**É SPA, não JSF.** Roteamento por hash (`#consulta`) — quase certamente há API JSON
atrás, como no `juliapesquisa`. O risco de "JSF legado com ViewState", que encareceria
muito esta fase, provavelmente não se concretiza.

### 5.1 Modelo de busca: matriz Unidade × Instância

| Eixo | Valores na interface |
|---|---|
| **Unidade** | TRF5, JFAL, JFCE, JFPB, JFPE, JFRN, JFSE |
| **Instância** | **Comum**, **JEF**, TR, TRU |

`Comum` e `JEF` são o 1º grau. Note que este vocabulário **não é o da API pública**,
que colapsa os dois eixos num segmento composto (`G2`, `TR_CE`, `TRU`). É provável
que o autenticado os receba como parâmetros separados — o que explica por que
`JEF_CE` deu 400 no público: não é só dado ausente, é gramática de outro sistema.

### 5.2 Dois modos: "Documentos" e "Processos"

Abas distintas com campos distintos.

**Documentos** (pesquisa de jurisprudência — este é o escopo do paidegua):
Pesquisa Livre (operadores `e`/`ou`/`nao`/`prox`/`adj`/`$`), Órgão Julgador,
Relator, Documentos assinados por, Classe Judicial, Data de Assinatura (intervalo),
**Temas** (números separados por vírgula + "todos os temas"), **Tarefa**,
Número do documento, **Localização**.

**Processos** (localização de processo — **fora do escopo**, ver §5.5):
Número do processo, Órgão Julgador, Relator, Classe Judicial, Data de distribuição,
**Nome da parte** (+ "termos exatos"), **Número da OAB**, **CPF/CNPJ**,
Processo originário/associado, Assunto, Temas, Tarefa, Localização,
"Em cumprimento de diligência".

Campos que **não existem na API pública** e agregam valor real: `Temas` (repetitivos
— útil para fundamentação e para Metas CNJ), `Tarefa` (amarra ao fluxo do PJe),
`Localização`, `Documentos assinados por`.

### 5.3 Vocabulário de `tipoDocumento`

Do grupo "Pesquisar em": Acórdão, Decisão, Despacho, **Sentença**, Ementa, Voto,
Relatório, Inteiro Teor do Acórdão, Apelação, Recurso Especial, Recurso
Extraordinário. Codificado em `julia-types.ts`.

"Sentença" é mais uma confirmação de que o 1º grau está indexado aqui.

### 5.4 O índice é defasado

A tela exibe **"Data de atualização: 12/07/2026 20:10h"** — seis dias antes da
observação. É carga em lote, não tempo real.

O painel **precisa exibir esse carimbo**. Sem ele, decisão recente que não aparece
será reportada como bug da extensão, e o suporte vai atrás de um problema que não
existe.

- [ ] Verificar se esse carimbo vem de um endpoint próprio (bom: cacheável e exibível)
      ou está embutido no HTML.

### 5.5 Decisão de escopo: só a aba "Documentos"

A aba Processos permite busca por **nome da parte, CPF/CNPJ e OAB**. Recomendação:
**não implementar**.

Não é limitação técnica — é que pesquisar jurisprudência e localizar processos de uma
pessoa por CPF são atividades distintas, com finalidade e controle de acesso
distintos. Replicar busca por CPF numa extensão instalada em várias estações cria
superfície de consulta a dado pessoal sem trilha de auditoria, exatamente o que as
normas do CNJ e a LGPD tratam com rigor. Se vier a ser desejada, que seja decisão
explícita com a DTI — não efeito colateral de "portamos a tela inteira".

### 5.6 Contrato da API autenticada — CAPTURADO

Coletado em 18/07/2026 com [julia-captura-console.js](julia-captura-console.js).
Confirma: **é API JSON, mesmo protocolo DataTables, mesmo boilerplate
`columns[0][...]`**. O cenário JSF/ViewState não se materializou.

#### O 1º grau: `orgao` e `instancia` são parâmetros SEPARADOS

```
GET /api/v1/sumario:dt?…&orgao=JFCE&instancia=G1
```

**`G1` é um valor válido.** O 400 da API pública (§1.2) não indicava dado ausente:
lá o eixo é um segmento composto no caminho (`TR_CE`), aqui são dois parâmetros de
query. Gramáticas diferentes para o mesmo conceito.

#### Família de endpoints

| Endpoint | Uso |
|---|---|
| `api/v1/documentos:dt` | **busca de documentos** — note o plural (a API pública usa `documento:dt`, singular) |
| `api/v1/processos:dt` | busca de processos (fora do escopo, §5.5) |
| `api/v1/sumario:dt` | contagem agregada por tipo de documento |
| `api/v1/documentos/` | documento individual |
| `api/v1/documentos:downloadArquivo/` | binário do documento |
| `api/v1/ementa` | ementa isolada |
| `api/v1/documentos:relatorio`, `processos:relatorio` | relatórios |
| `api/v1/processos:data-atualizacao` | o carimbo de defasagem do índice (§5.4) — **é endpoint próprio, cacheável** |

**Endpoints de vocabulário** — resolvem de uma vez o problema de enumerar filtros:
`api/v1/orgaos-julgadores`, `api/v1/relatores`, `api/v1/classes-judiciais`,
`api/v1/assuntos`, `api/v1/tarefas`, `api/v1/localizacoes`, `api/v1/assinadores`.

#### Parâmetros — nomes diferentes dos da API pública

| API pública | API autenticada |
|---|---|
| `pesquisaLivre` | **`termo`** |
| `dataIni` / `dataFim` | **`dataInicial` / `dataFinal`** |
| `{instancia}` no caminho | **`orgao` + `instancia`** na query |
| — | `tarefa`, `assinador`, `classeJudicial`, `tema`, `todosOsTemas`, `localizacao`, `tiposDocumento`, `numeroDocumento` |
| `orgaoJulgador`, `relator`, `numeroProcesso` | iguais |

Boilerplate DataTables (`draw`, `columns[0][...]`, `start`, `length`,
`search[value]`, `search[regex]`, `_`) é idêntico ao da API pública.

#### `tiposDocumento`: terceiro vocabulário

Valor capturado literalmente:

```
Acórdão#Apelação#Decisão#Despacho#Ementa#Inteiro Teor do Acórdão#Recurso Especial#Recurso Extraordinário#Relatório#Sentença#Voto#
```

Título, **com acento**, separado por `#`, **terminando em `#`**. Não confundir com
o `tipoDocumento` da resposta, que é maiúscula sem acento (`EMENTA`, `ACORDAO`).
Ambos codificados separadamente em `julia-types.ts` justamente porque trocá-los é
erro silencioso.

#### Resposta

Mesma forma da pública (`draw`, `recordsTotal`, `recordsFiltered`, `data`), mais
`error` e `message`. O `sumario:dt` devolve `{descricao, quantidade}` — contagem
por tipo de documento, útil como painel de aferição antes de puxar os resultados.

### 5.7 `documentos:dt` — forma do item (CAPTURADO)

**Não é a mesma forma da API pública.** A pública é plana; esta é aninhada e usa
outros nomes. A interface `JuliaDocumento` serve como saída comum, mas exige
**dois adaptadores**, não um.

```jsonc
{
  "idDocumento": 172619516,          // number
  "idBinario": 192898753,            // number
  "tipo": { "descricao": "Sentença", "quantidade": 0 },
  "formato": "HTML",
  "numero": "172619516",
  "texto": "…568 chars, com <em> e HTML, 2 linhas…",   // TRECHO, ver abaixo
  "url": "https://pje1g.trf5.jus.br/pje",
  "nomeAssinatura": "…magistrado…",
  "dataAssinatura": "2026-07-10T14:39:20",             // ISO com hora
  "julgamento": null,
  "sigiloso": false, "publico": true,                  // ver §5.8
  "score": 0.0,                                        // relevância
  "processo": {
    "orgao": "JFCE", "instancia": "JEF", "sistema": "PJE_NACIONAL",
    "idProcesso": 3643577, "numero": "…", "numeroUnico": "…",
    "sigiloso": false, "orgaoJulgador": {}, "orgaoJulgadorColegiado": null,
    "nomeMagistrado": null, "classeJudicial": {},
    "url": "https://pje1g.trf5.jus.br/pje",
    "identificador": "JFCE:JEF:PJE_NACIONAL:3643577"
  },
  "identificador": "JFCE:JEF:PJE_NACIONAL:3643577:172619516:192898753",
  "ordenacao": 0
}
```

#### O `texto` é trecho de busca, não inteiro teor

**568 caracteres**, com realce `<em>` e HTML, em 2 linhas — para uma *sentença*.
Somados a `score` e `ordenacao`, é objeto de motor de busca: snippet, não documento.

Diferença central em relação à API pública, onde o `texto` traz a ementa/acórdão
completo. Aqui o inteiro teor exige round-trip extra por
`api/v1/documentos/{id}` ou `api/v1/documentos:downloadArquivo/`.

- [ ] Capturar um desses dois (basta abrir um resultado) para fechar a Fase 4.

#### Correspondências com a API pública

| Público | Autenticado |
|---|---|
| `codigoDocumento` | `identificador` (mesmo formato composto) |
| `tipoDocumento` (string) | `tipo.descricao` (objeto) |
| `numeroProcesso` | `processo.numeroUnico` |
| `orgaoJulgador` (string) | `processo.orgaoJulgador` (objeto) |
| `dataAssinatura` (data) | `dataAssinatura` (data **com hora**) |
| `resumo` | — (ausente) |

`url` aponta de volta para o PJe (`pje1g.trf5.jus.br/pje`), tanto no documento
quanto no processo — ponte natural para o cliente PJe que o paidegua já tem.

### 5.8 Sigilo: `sigiloso` e `publico`

O payload traz **`sigiloso`** e **`publico`** como booleanos, no documento e no
processo. O acervo indexado inclui material sob segredo e a API o marca.

O cliente deve tratar essas flags **explicitamente**, nunca por omissão: filtrar
antes de exibir, jamais mandar conteúdo sigiloso a provedor de IA externo, e não
persistir em cache local. Vale mesmo com sessão autenticada — ter acesso não é
autorização para reprocessar.

### 5.9 Dois envelopes na mesma API

| Família | Forma |
|---|---|
| `*:dt` | `{ draw, recordsTotal, recordsFiltered, data[], error, message }` |
| demais | `{ status: "OK", httpStatus, mensagem, resultado }` |

`orgaos-julgadores` devolve `resultado` como **array de strings** (27 itens para
JFCE/JEF), e o filtro `orgaoJulgador` recebe a string literal
(`"35ª VARA FEDERAL CE"`). Vocabulário exato, sem código — casar com precisão.

`processos:data-atualizacao` devolve `"2026-07-12T20:10:11"` em `resultado`, **por
`orgao` + `instancia`** — a defasagem do índice é por unidade, não global.

### 5.10 Vocabulário de `instancia` (autenticado)

Confirmados na captura: **`G1`** e **`JEF`**. O rótulo "Comum" da interface
corresponde a `G1`.

Observação útil: buscar em `35ª VARA FEDERAL CE` com `instancia=G1` devolveu zero;
com `instancia=JEF`, resultados. Os órgãos julgadores são **específicos por
instância** — `orgaos-julgadores` é consultado com `orgao` + `instancia`, e cruzar
os eixos errado devolve vazio silencioso, não erro.

- [ ] Confirmar os valores de TR e TRU.

### 5.11 Estrutura do documento varia por instância — o recorte também

Observado no inteiro teor de uma sentença de JEF (JFCE):

| Instância | Estrutura | Razão de decidir |
|---|---|---|
| G2 (`EMENTA`) | ementa direta | o próprio texto |
| TR (`ACORDAO`) | EMENTA → RELATÓRIO → VOTO → ACÓRDÃO | seção **EMENTA** |
| G1/JEF (`Sentença`) | I. RELATÓRIO → II. FUNDAMENTAÇÃO → III. DISPOSITIVO | seção **FUNDAMENTAÇÃO** |

**Correção de 18/07/2026:** esta tabela apontava o DISPOSITIVO para sentença.
Estava errado. Ementa de acórdão é redigida para condensar a tese; dispositivo de
sentença só informa o desfecho e as cominações. Uma síntese sobre dispositivos
responderia "qual a taxa de procedência", não "qual o entendimento".

O dispositivo segue sendo extraído, mas como **classificador de desfecho**, não
como fonte de tese — ver `julia-segmentador.ts`.

**Sentença não tem ementa.** O `extrairEmenta()` de `julia-client.ts` foi desenhado
sobre acórdãos e, aqui, cai corretamente no caminho seguro (devolve o texto integral
com `ementaFoiRecortada: false`) — mas não recorta, e o problema de custo de contexto
permanece.

A Fase 4 precisa de um segmentador por instância, não de um único extrator. Para
sentença o alvo é o dispositivo (`III. DISPOSITIVO`, ou o `JULGO …` quando a
numeração romana faltar), que é onde está o que foi efetivamente decidido.

O texto vem em **texto puro com quebras de linha** (renderizado em `<textarea>`),
apesar de `formato: "HTML"` no item de `documentos:dt` — o campo provavelmente
descreve o formato de armazenamento, não o da resposta. Confirmar na captura.

### 5.12 Inteiro teor (CAPTURADO)

```
GET /julia/api/v1/documentos/{identificador}
```

Ex.: `/julia/api/v1/documentos/JFCE:JEF:PJE_NACIONAL:3643577:172619516:192898753`
— o **identificador composto inteiro**, com os dois-pontos sem escapar, no
caminho. Não é `idDocumento` nem `idBinario` isolados, embora ambos estejam no
payload como candidatos plausíveis.

Envelope `{status, httpStatus, mensagem, resultado}`, com `mensagem` ecoando
`"documento: {identificador}"`. O `resultado` tem a **mesma forma do item da
lista**, com duas diferenças:

- **`texto` completo** — 6.367 chars / 36 linhas contra 568 chars do snippet,
  e **sem `<em>` e sem HTML**: é texto puro com quebras de linha. O
  `formato: "HTML"` descreve o armazenamento, não a resposta (§5.11 confirmada).
- `processo.orgaoJulgador` e `processo.classeJudicial` vêm expandidos:
  `{id, descricao, numeroVara}` e `{codigoCnj: "436", descricao}`.

#### Base única: `/julia/api/v1/` — a leitura anterior estava errada

Esta seção registrava dois prefixos (`/api/v1/…` e `/julia/api/v1/…`). **Era erro
de instrumentação, não da API.**

O coletor resolvia URL relativa com `new URL(url, location.origin)`; o correto é
`location.href`. Uma chamada relativa `api/v1/sumario:dt` disparada da página
`/julia/consultar` era registrada como `/api/v1/…` quando de fato ia para
`/julia/api/v1/…`. Corrigido em [julia-captura-console.js](julia-captura-console.js).

O cookie confirma: `JSESSIONID` tem **`Path=/julia`** (§5.15). Requisição à raiz
sai sem sessão — não poderia ter respondido 200 com dados. **Todos os endpoints
ficam sob `/julia/api/v1/`.**

Lição de método: quando a captura contradiz o modelo de segurança (chamada
autenticada funcionando sem cookie possível), suspeitar do instrumento antes de
concluir excentricidade do servidor.

### 5.13 O identificador é decomponível — e explica as duplicatas

```
JFCE : JEF : PJE_NACIONAL : 3643577  : 172619516  : 192898753
orgao  inst   sistema       idProcesso idDocumento  idBinario
```

`processo.identificador` é o mesmo truncado em quatro segmentos. **O mesmo
formato vale para o `codigoDocumento` da API pública**
(`TRF5:G2:PJE_NACIONAL:120477:11321005:11148155`), que vinha sendo tratado como
string opaca.

Achado decorrente: dois documentos capturados no mesmo processo —
`…:3643577:172619516:192898753` e `…:3643577:172593124:192898753` — têm
`idDocumento` distintos, **`idBinario` idêntico**, e devolveram texto, assinante
e data de assinatura iguais. São dois registros para o mesmo binário.

Consequência: **deduplicar pelo identificador integral não basta.** A chave de
conteúdo é `idProcesso:idBinario`. Implementado em `julia-identificador.ts` e já
aplicado ao cliente da API pública, onde o mesmo padrão deve ocorrer.

### 5.15 O cookie de sessão (CAPTURADO)

| Atributo | Valor |
|---|---|
| Nome | `JSESSIONID` |
| Domain | `julia.trf5.jus.br` |
| **Path** | **`/julia`** |
| **Expires** | **`Session`** |
| HttpOnly | ✓ |
| Secure | ✓ |
| **SameSite** | **em branco** |

#### `Path=/julia` define a base da API

Requisição fora de `/julia` não leva o cookie. Confirmado empiricamente: um
`fetch` do service worker para `/api/v1/processos:data-atualizacao` devolveu
**503 com HTML**. É o que fixa a base única do cliente (§5.12).

#### `SameSite` em branco = `Lax` — mas **não** bloqueia a extensão

Desde 2020 o Chrome trata cookie sem `SameSite` declarado como **`Lax`**. Em
branco na tabela é o caso restritivo, não o permissivo.

**Testado em 18/07/2026, do console do service worker:**

```js
fetch('https://julia.trf5.jus.br/julia/api/v1/processos:data-atualizacao?orgao=JFCE&instancia=G1',
      { credentials: 'include', headers: { accept: 'application/json' } })
// → 200 | application/json
// → {"status":"OK","httpStatus":200,…,"resultado":"2026-07-12T20:10:10"}
```

✅ **O cookie viaja.** Requisição iniciada por extensão com `host_permissions`
não sofre a restrição `SameSite` aplicada a página comum.

Consequência arquitetural: o cliente autenticado roda no **service worker**, como
o público. Os painéis (`chrome-extension://`) chamam direto — sem encaminhamento
por content script, sem depender de aba do PJe aberta.

> O teste anterior, que devolveu 503, foi inconclusivo: usou `/api/v1/…`, fora do
> escopo `Path=/julia` do cookie. Falharia por `Path` mesmo que o `SameSite`
> permitisse.

#### Não é cookie persistente — a observação de campo estava errada

`Expires: Session` significa que o cookie **morre ao fechar o navegador**. A
observação de 17/07/2026 ("a sessão sobreviveu de um dia para o outro") não
indica cookie de longa duração: o Chrome **restaura cookies de sessão** quando
"Ao iniciar → Continuar de onde parou" está ligado.

Consequências:

1. A durabilidade observada depende de **configuração do navegador do usuário** e
   de não fechar o Chrome de fato. Outros pilotos podem perder a sessão todo dia.
2. A decisão de **não armazenar credenciais** (§2) segue correta — mas o
   tratamento de sessão expirada deixa de ser detalhe de robustez e passa a ser
   caminho frequente. `JuliaSessaoExpiradaError` precisa de UX de reconexão de
   verdade, não de um toast genérico.

### 5.16 Ainda pendente

- [ ] Inteiro teor: `api/v1/documentos/{id}` ou `documentos:downloadArquivo/`.
- [ ] Conteúdo do campo `message` das respostas `:dt` (144 chars, não inspecionado).
- [ ] Ciclo da sessão — `Max-Age`, `SameSite` (**Application → Cookies**).
- [ ] `recordsTotal` também satura em 10.000 aqui?

---

## 6. Limites e etiqueta de uso

- [ ] Rate limiting não testado. Medir cadência tolerada antes de qualquer varredura.
- [ ] Alinhar com a DTI do TRF5 antes de uso em lote — há precedente de consulta em
      [dtic-consulta-suporte-paidegua.md](dtic-consulta-suporte-paidegua.md).

Ainda que a API seja pública e sem autenticação, varredura sistemática do acervo é
carga sobre infraestrutura do Tribunal. Cache local agressivo (IndexedDB, padrão já
usado em `fluxos-store.ts` e `tpu-store.ts`) e backoff conservador.

---

## 7. Fases seguintes

O achado da API pública **inverte a ordem de risco do projeto**: a maior parte do
valor está atrás de zero autenticação.

| Fase | Entrega | Depende de |
|---|---|---|
| 1 | `src/content/julia-api/` — cliente do acervo público (G2/TR/TRU) | §3 ✅ + valor de TR |
| 2 | Painel de Pesquisa JULIA (padrão `pericias-painel/`) | Fase 1 |
| 3 | Grounding: minutas e triagem com jurisprudência real | Fase 1 |
| 4 | 1º grau via JULIA autenticado | §5 |
| 5 | Tool-use nos provedores de IA (refatoração de `providers/base.ts`) | Fases 1–3 |
