# Fixtures de HTML real do `listAutosDigitais.seam`

Arquivos HTML capturados de respostas reais do PJe ao endpoint
`listAutosDigitais.seam`, anonimizados para commit no repositório público.

Servem como base de **testes determinísticos do parser unificado** (`getAutosSnapshot`,
INFRA-02) contra a matriz mínima de jurisdições prevista na §II.5.3 do
[manual de massificação PJe nacional](../../../docs/manual-massificacao-pje.md).

## Convenção de nomenclatura

```
<escopo>-<jurisdição>-<descritor>.html
```

Onde:

- **`<escopo>`** — `civel`, `criminal`, `jef`, `stub`
- **`<jurisdição>`** — `trf1`..`trf6`, `tjsp`, `tjmg`, `tjrj`, `sintetico` (para casos construídos manualmente)
- **`<descritor>`** — curto, explica o caso (`33-movs`, `com-sigilo`, `timeline-grande`, `32kb`)

Exemplos:

- `civel-trf5-33-movs.html` — processo cível com 33 movimentos (caso analisado no parecer)
- `criminal-trf5-com-sigilo.html` — processo criminal com tags de segredo
- `jef-trf5-padrao.html` — processo do JEF padrão
- `civel-trf5-timeline-grande.html` — timeline > 100 entradas (paginação)
- `stub-sintetico-32kb.html` — stub HTML reduzido (incidente 20/04/2026, anti-regressão)

## Como adicionar uma nova fixture

### 1. Capturar o HTML real

No PJe (qualquer instalação `*.jus.br`), com o processo aberto:

1. Abrir DevTools (`F12`)
2. Aba **Network**
3. Filtrar por `listAutosDigitais.seam`
4. Recarregar a aba do processo (`F5`)
5. Selecionar a request `POST listAutosDigitais.seam`
6. Aba **Response** → click direito → **Save as...**
7. Salvar o arquivo `.html` em um diretório **fora** do repositório (não commitar HTML bruto)

### 2. Anonimizar

A partir da raiz do repo:

```bash
node test/fixtures/anonimizar-html.mjs <caminho-do-html-bruto> > test/fixtures/listAutosDigitais/<nome-final>.html
```

O script substitui automaticamente:

- **CPF** (`000.000.000-00`)
- **CNPJ** (`00.000.000/0001-00`)
- **Número de processo CNJ** (`0000000-00.0000.0.00.0000`)
- **OAB** (`OAB/UF 000000`)
- **E-mail** (`parte@exemplo.com`)
- **Telefone formatado** (`(00) 00000-0000`)

Reporta no `stderr` quantas substituições fez por tipo (não polui o output redirecionado).

### 3. Revisar manualmente — passo OBRIGATÓRIO

O script **não substitui nomes próprios automaticamente** (FP alto sem AST). Antes de
commitar, abra o HTML anonimizado e procure por:

- Nomes de **partes** (autor, réu) — substituir por `PARTE_AUTORA_001`, `PARTE_RE_001`
- Nomes de **advogados** — substituir por `ADVOGADO_001`, `ADVOGADO_002`
- Nomes de **magistrados/servidores** — substituir por `MAGISTRADO_001`, `SERVIDOR_001`
- **Endereços** completos (CEP, rua, número) — substituir por `[ENDERECO_REMOVIDO]`
- **Datas de nascimento** ou outras datas pessoais — substituir por `DD/MM/AAAA`

**NÃO anonimizar** datas processuais (autuação, despachos, decisões) — distorce os testes.

Conferir que o HTML continua válido (abrir no navegador, ver se renderiza).

### 4. Adicionar metadados

Editar este `README.md` adicionando uma linha na tabela "Fixtures registradas" com:

- Nome do arquivo
- Jurisdição (real ou sintético)
- Tipo de processo
- Tamanho aproximado
- Características relevantes

### 5. Commitar

```bash
git add test/fixtures/listAutosDigitais/<nome-final>.html
git add test/fixtures/listAutosDigitais/README.md
git commit -m "test(fixtures): adiciona <nome>"
git push
```

O CI vai exercitar o `scan:pii` em logs (INFRA-15) em cima do PR — mas as fixtures
ficam fora do escopo do scan (só `src/**`).

## Fixtures registradas

| Arquivo | Jurisdição | Tipo | Tamanho | Características |
|---|---|---|---|---|
| `stub-sintetico-32kb.html` | sintético | stub | ~32 KB | Sem `#divTimeLine`, sem `#mais-detalhes`, sem `cbTipoDocumento` — anti-regressão do incidente 20/04/2026 |

## O que NÃO fazer

- ❌ Nunca commitar HTML bruto (sem anonimização) — viola LGPD
- ❌ Nunca incluir CPF, RG, OAB, número de processo CNJ, nome de parte, telefone, e-mail real
- ❌ Nunca anonimizar datas processuais (autuação, despachos, decisões) — distorce os testes
- ❌ Nunca commitar fixtures > 1 MB sem justificativa explícita no PR

## Onde isso é consumido

- **INFRA-14** (parser unitários offline) — em `triagem`. Quando implementado, vai rodar como parte do CI usando estas fixtures.
- **INFRA-02** (`pje-autos-cache.ts` com detecção de stub) — em `spec`. Vai usar o `stub-sintetico-32kb.html` como caso de teste anti-regressão.

## Cards relacionados

- [INFRA-13](../../../docs/kanban-massificacao/seed.json) — este card (infraestrutura + fixtures seed)
- INFRA-13a (sub-card) — TRF5 completo (cível + criminal + JEF + timeline grande) — *a abrir*
- INFRA-13b (sub-card) — outros TRFs federais (TRF1-4, TRF6) — *a abrir*
- INFRA-13c (sub-card) — TJs estaduais (TJSP, TJMG, TJRJ) — *a abrir*
- INFRA-14 — parser unitários offline (depende destas fixtures)
- INFRA-15 — scan PII em logs (✅ `lancado` em 2026-05-10)
- INFRA-01 + INFRA-02 — gateway + cache (consumirão o parser testado por essas fixtures)
