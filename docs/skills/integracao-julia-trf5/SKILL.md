---
name: integracao-julia-trf5
description: Conecta uma aplicação à Júlia (pesquisa de jurisprudência do TRF5) para consumir acórdãos, ementas e sentenças via API JSON. Use quando precisar buscar jurisprudência do TRF5/Turmas Recursais/TRU (API pública, sem autenticação) ou do 1º grau (API autenticada), montar o boilerplate DataTables, paginar, deduplicar resultados ou fazer grounding de minutas com precedentes reais.
---

# Integração com a Júlia (Pesquisa de Jurisprudência TRF5)

Conhecimento consolidado do projeto pAIdegua (JFCE) sobre as duas APIs da
Júlia. Contratos verificados empiricamente em julho/2026.

## 1. API pública — sem autenticação (G2, TR, TRU)

```
GET https://juliapesquisa.trf5.jus.br/julia-pesquisa/api/v1/documento:dt/{instancia}
```

**Não exige autenticação** — sem cookie, sem sessão, sem credencial. Protocolo
*DataTables server-side*.

### 1.1 `{instancia}` é um segmento composto

| Valor | Resultado |
|---|---|
| `G2`, `TRU` | ✅ |
| `TR_CE`, `TR_PE`, `TR_AL`, `TR_PB`, `TR_RN`, `TR_SE` | ✅ (Turma Recursal exige a UF) |
| `G1`, `JEF`, `TR` puro | ❌ 400 — o 1º grau NÃO existe na API pública |

O vocabulário da URL não é o da resposta: `TR_CE` na URL devolve
`orgao: "JFCE"` + `instancia: "TR"` nos itens. Mantenha um mapa explícito.

### 1.2 Parâmetros — o boilerplate DataTables é OBRIGATÓRIO

Omitir o bloco `columns[0][...]` devolve **400** mesmo com instância válida:

```
draw=1
columns[0][data]=codigoDocumento
columns[0][name]=
columns[0][searchable]=true
columns[0][orderable]=false
columns[0][search][value]=
columns[0][search][regex]=false
search[value]=&search[regex]=false
start={offset}&length={tamanho}          ← paginação, UI oficial usa 10
pesquisaLivre={termo}                    ← aceita vazio (varredura só por data)
numeroProcesso={20 dígitos sem máscara}
orgaoJulgador={string}&relator={nome}
dataIni={dd/MM/yyyy}&dataFim={dd/MM/yyyy}
```

**Assimetria de datas:** entrada em `dd/MM/yyyy`, saída em ISO `yyyy-MM-dd`.
Converta por manipulação de string — `new Date('2026-01-31')` interpreta como
UTC e, em fuso BRT, devolve o dia anterior (bug de virada de mês).

### 1.3 Resposta

Envelope `{ draw, recordsTotal, recordsFiltered, data: [...] }`. Campos úteis
de cada item: `codigoDocumento`, `tipoDocumento` (`EMENTA` em G2, `ACORDAO` em
TR), `numeroProcesso` (20 dígitos sem máscara), `classeJudicial`, `relator`,
`orgaoJulgador`, `dataJulgamento`/`dataAssinatura` (ISO), `texto`
(**inteiro teor, já na busca** — sem round-trip extra) e `resumo` (citação
pronta para referência).

### 1.4 Armadilhas verificadas (geram bug silencioso)

1. **`recordsTotal` satura em 10.000** — é o `max_result_window` do
   Elasticsearch, não contagem real. Exiba "mais de 10.000" quando bater
   exatamente nisso, e **bloqueie paginação com `start + length > 10.000`**
   (além do teto o backend devolve erro, não página vazia).
2. **O `texto` vem com `<em>…</em>`** marcando os termos buscados. Remova as
   tags antes de enviar a um LLM (senão o modelo lê a marcação como conteúdo)
   e **nunca renderize com `innerHTML` cru** — escape tudo e restaure só os
   `<em>`.
3. **A resposta pode repetir documentos.** A chave de deduplicação correta é
   `idProcesso:idBinario` extraída do `codigoDocumento` (formato decomponível
   `{orgao}:{instancia}:{sistema}:{idProcesso}:{idDocumento}:{idBinario}`) —
   dois registros com `idDocumento` distintos podem apontar para o mesmo
   binário. NÃO deduplique por `numeroProcesso`: vários documentos legítimos
   (ED + acórdão originário) compartilham o número.
4. **O volume do `texto` varia por instância.** Em TR, o `ACORDAO` traz ementa
   + relatório + voto + acórdão (>15 mil caracteres). Para prompts de LLM,
   recorte só a seção EMENTA (heurística: corte no primeiro marcador
   `RELATÓRIO`/`VOTO` e retroceda à última ocorrência de "EMENTA"; se não achar
   marcadores, devolva o texto inteiro — nunca fragmento vazio).

## 2. API autenticada — 1º grau (`julia.trf5.jus.br`)

Mesmo protocolo DataTables, **mas contrato diferente**. Base única:
**`/julia/api/v1/`** (o cookie `JSESSIONID` tem `Path=/julia` — requisição fora
desse caminho sai sem sessão e devolve 503).

| API pública | API autenticada |
|---|---|
| `documento:dt/{instancia}` (singular, path) | `documentos:dt` (plural) + `orgao=JFCE&instancia=G1` na query |
| `pesquisaLivre` | `termo` |
| `dataIni`/`dataFim` | `dataInicial`/`dataFinal` |
| `texto` = inteiro teor | `texto` = **snippet** (~570 chars); inteiro teor via `GET /julia/api/v1/documentos/{identificador-composto-inteiro}` |
| item plano | item aninhado (`tipo.descricao`, `processo.numeroUnico`…) |

- `instancia` válidas: `G1` (rótulo "Comum") e `JEF`; órgãos julgadores são
  **específicos por instância** — cruzar errado devolve vazio silencioso.
- Endpoints de vocabulário prontos: `orgaos-julgadores`, `relatores`,
  `classes-judiciais`, `assuntos`, `tarefas`, `localizacoes`, `assinadores`.
- Filtro `tiposDocumento` usa um TERCEIRO vocabulário: título com acento,
  separado e terminado por `#` (`Acórdão#Sentença#…#`). Não confundir com o
  `tipoDocumento` da resposta (`EMENTA`, maiúscula sem acento).
- `processos:data-atualizacao` devolve o carimbo de defasagem do índice (a
  carga é em lote, ~dias de atraso) — **exiba esse carimbo na UI**, senão
  decisão recente ausente será reportada como bug.
- O payload traz flags `sigiloso`/`publico`: trate **explicitamente** — não
  exibir, não cachear e não enviar a provedor de IA externo conteúdo sigiloso.
- Sentença (G1/JEF) não tem ementa: estrutura é RELATÓRIO → FUNDAMENTAÇÃO →
  DISPOSITIVO. Para tese, extraia a FUNDAMENTAÇÃO; o dispositivo serve como
  classificador de desfecho, não como fonte de entendimento.

### 2.1 Sessão e credenciais

- **Não armazene a senha do usuário** — é a credencial institucional do
  servidor. Deixe o usuário logar na Júlia no navegador e reutilize o cookie
  (`credentials: 'include'`).
- `JSESSIONID` é cookie **de sessão** (`Expires: Session`): morre ao fechar o
  navegador (a menos que "Continuar de onde parou" o restaure). Sessão
  expirada é evento comum — trate com UX de reconexão de primeira classe.
- Em extensão Chrome MV3 com `host_permissions: https://*.jus.br/*`, o fetch
  do **service worker** com `credentials: 'include'` carrega o cookie
  normalmente (a restrição SameSite=Lax não se aplica). Cliente público e
  autenticado podem ambos rodar no background.

## 3. Onde o cliente roda (extensão MV3)

No **service worker**, não no content script: a Júlia é de outra origem que a
do PJe e, em MV3, o content script não herda a isenção de CORS das
`host_permissions` — o background herda.

## 4. LGPD e etiqueta de uso

- O `texto` traz PII (partes, advogados com OAB, números de processo). Nunca
  logar cru; anonimizar antes de enviar a provedor de IA externo — dado
  público no site do Tribunal não autoriza transferência a terceiro.
- Não implementar busca por nome de parte/CPF/OAB sem decisão explícita com a
  DTI — cria superfície de consulta a dado pessoal sem trilha de auditoria.
- Varredura em lote é carga sobre infraestrutura do Tribunal: cache local
  agressivo (IndexedDB), backoff conservador e alinhamento prévio com a DTI.
