# Extração de Ordens PREVJUD (Intimações INSS) — PJe v11 TRF5

**Projeto:** pAIdegua — plataforma de apoio à atividade e gestão judicial no PJe
**Data:** Julho/2026
**Status:** documento de descoberta (Fase 0). Base para o futuro painel "Ordens PREVJUD".
**Contexto:** o PJe v11 do TRF5 incorporou ao menu do processo a ação **Outras
ações → Verificar ordens PREVJUD**, que exibe a tabela "Intimações INSS" com o
ciclo de vida das ordens de implantação de benefício enviadas ao INSS. O objetivo
é consolidar essas ordens de todos os processos de uma vara num dashboard de
acompanhamento (cobrança de cumprimento pelo INSS, prazos vencidos etc.).

---

## 1. Achado principal: NÃO existe endpoint REST

Ao clicar em "Verificar ordens PREVJUD", a captura de rede mostrou:

- **POST** `https://pje1g.trf5.jus.br/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam`
- **Content-Type de resposta:** `text/xml` — é um **partial-render RichFaces**
  (`A4J.AJAX.Submit('navbar', …)`), não JSON.

Ou seja, **a tabela vem como HTML embutido na resposta A4J**; não há o caminho
REST rápido que existiu para expedientes (ver [modo-rapido-rest-flag.md](modo-rapido-rest-flag.md)).
A única sub-chamada REST envolvida é o **download do documento** de cada ordem:

```
/pje/seam/resource/rest/pje-legacy/documento/download/TRF5/1g/{idProcesso}/{idDocumento}
```

— que serve só o binário da intimação, não os dados da tabela.

### 1.1 Restrição do "chamar o POST direto"

A resposta é um re-render amarrado a `javax.faces.ViewState` (observado: `j_id17`),
que é **por-view + sessão Seam**. Não dá para disparar o POST às cegas para um
`idProcesso` arbitrário: é preciso **primeiro carregar a página do processo**
(`listAutosDigitais.seam?idProcesso=X&ca=Y`), que estabelece a conversation Seam
(`cid`) e o ViewState, e só então repetir o POST do menu `navbar:linkVerificarIntimacoesInss`.

---

## 2. Estratégia de coleta adotada

**MVP — scraping por aba invisível** (padrão já provado no *Encerrar expedientes*,
ver [abrir-tarefa-pje-popup.md](abrir-tarefa-pje-popup.md) §9):

1. `chrome.tabs.create({ url: listAutosDigitais.seam?idProcesso&ca, active: false })`.
2. `chrome.scripting.executeScript({ world: 'MAIN' })` que dispara o link
   `#navbar\\:linkVerificarIntimacoesInss` (ou executa o `A4J.AJAX.Submit` inline).
3. *Poll* até `#divListaIntimacaoInss table.rich-table tbody tr.rich-table-row`
   aparecer.
4. Raspa as linhas (ver §4) e fecha a aba.

**Otimização futura (opcional, não implementar já) — replicar o POST A4J via
`fetch` same-origin:** GET da página → extrai `ViewState`/`cid` → POST do menu →
parseia o XML. ~0,3 s/processo vs ~2–3 s da aba, mas frágil (gestão de ViewState /
conversation Seam). Documentar quando/se o volume justificar.

### 2.2 Descoberta posterior (jul/2026): API REST oficial no gateway PDPJ 🎯

Em varreduras grandes (600+ processos) a aba invisível é lenta demais (~8 min
com pool de 3). Investigação no gateway da PDPJ encontrou a **API oficial do
PREVJUD**, separada da `previdenciario-api` (que cobre apenas dossiês):

- **Base:** `https://gateway.cloud.pje.jus.br/prevjud-intimacao-judicial/`
  (spec pública em `/v2/api-docs`; Swagger 2.0). Há também
  `previdenciario-intimacao-penhora-judicial` (penhoras).
- **Endpoints-chave:**
  - `GET /api/v2/intimacao-judicial/obter-intimacao-numero-processo/{numeroProcesso}`
    → array de intimações do processo (status, serviço, protocoloPdpj,
    dataCriacao, dtRecebidoDataprev, benefício, erro).
  - `POST /api/v2/intimacao-judicial/pesquisar?page&size` com
    `IntimacaoFiltro {numeroProcesso?, numeroProtocolo?, cpf?, nome?,
    dataCriacaoInicial?, dataCriacaoFinal?}` → `Page«IntimacaoOutput»`.
    **Testar filtro só por período** — se o escopo vier do token (unidade),
    o painel inteiro sai em UMA chamada.
  - `POST /api/v2/intimacao-judicial/servico-prazo-dias` → prazo (dias) por
    serviço, para derivar o "Final do Prazo" da tela legacy.
- **Status é enum:** `RECEBIDA`, `RECEBIDA_COM_ERRO`, `ORDEM_CUMPRIDA`,
  `RESPONDIDA_COM_JUSTIFICATIVA`, … — mapeia direto o pendente/cumprida.
- **Auth:** JWT no `Authorization` + header obrigatório
  `X-PDPJ-CPF-USUARIO-OPERADOR` (CPF do operador — extraível do payload do
  próprio JWT). **Hipótese a validar:** o Bearer capturado pelo interceptor
  no PJe v11 (integrado à PDPJ) é aceito pelo gateway. `gateway.cloud.pje.jus.br`
  é `*.jus.br` (host_permissions ok); chamar do service worker evita CORS.
- **Ganho estimado:** ~0,2 s/processo sem aba e sem `ca` → 600 processos em
  ~20–30 s (pool 6). `montarUrlAutos`/`gerarChaveAcesso` passam a rodar só
  para os processos COM ordem (link do dashboard).
- **Limitações:** a API não devolve `idDocumento`/URL de download do
  documento local do PJe (coluna 3 da tela legacy); prazos derivados por
  serviço, não por linha.
- **Estratégia recomendada:** API-first com fallback automático — 401/403 na
  primeira chamada ⇒ volta ao caminho de aba invisível e registra no
  diagnóstico.
- **Status: IMPLEMENTADA (jul/2026).** Sonda de rota no primeiro candidato
  (`prevjud-coletor.ts`); handler `handlePrevjudColetarProcessoApi` no
  background (Bearer do interceptor + CPF extraído do JWT para o header
  `X-PDPJ-CPF-USUARIO-OPERADOR`); normalização em `normalizarOrdemApi`
  (`prevjud-parser.ts`); rota efetiva (`api`/`aba`/`mista`) exibida no
  diagnóstico do dashboard. Concorrência: 6 na rota API, 3 na rota aba.
  `gerarChaveAcesso` roda apenas para processos COM ordem (Fase 3b).
- **Validação em produção (TRF5, jul/2026) — estado: BLOQUEADA no gateway.**
  Fatos observados com o Bearer capturado do PJe v11:
  - Sem token: 401 (endpoint existe). Com token: **passa da autenticação**.
  - `POST /pesquisar` → **403** (RBAC por rota; o perfil comum não tem a
    role desse endpoint).
  - `GET obter-intimacao-numero-processo/{n}` → **HTTP 500** com corpo
    `{"status":500,"error":"Internal Server Error","message":""}` —
    **inclusive para processo COM ordem real** (testado em
    0012328-29.2025.4.05.8109). Ou seja, NÃO é "processo sem registro";
    hipóteses em aberto: formato do número (com/sem máscara), claim/perfil
    ausente no token (CPF não provisionado no PREVJUD pelo Administrador
    Regional?), header adicional exigido pelo controller.
  - Heurística "500 = sem registro" foi testada e **revertida** — dava
    relatório vazio para processo com ordem.
  - Comportamento atual do código: a sonda só valida a rota API com
    200/204 real; enquanto o gateway responder 500, a varredura desce para
    a rota SSR (§2.3). A sonda custa ~4 chamadas (~2s) por varredura.
  - `GET obter-dados-intimacao/{n}` responde **200**, mas devolve apenas o
    **cadastro para pré-preencher uma nova intimação** (vara, beneficiário,
    endereço) — sem lista de ordens/status. Não serve para acompanhamento.
  - Não há endpoint acessível ao perfil comum que liste as intimações **da
    unidade** (o filtro do `/pesquisar` — 403 — nem tem `idOrgaoJulgador`).
    O "índice local" da unidade continua sendo o painel de tarefas do PJe
    (ex.: a tarefa "[PREVJUD] Aguardar cumprimento de demanda judicial") +
    o filtro de etiquetas do usuário.

### 2.3 Rota B rápida — fetch SSR + POST A4J replicado (IMPLEMENTADA) ⚡

Sem depender do gateway: o content script (same-origin, cookies juntos)
faz **(1)** GET da `listAutosDigitais.seam?idProcesso&ca` — cria a view JSF
e entrega o `javax.faces.ViewState` + o form `navbar`; **(2)** POST no
mesmo endereço replicando o `A4J.AJAX.Submit` do link
`navbar:linkVerificarIntimacoesInss` (todos os campos do form serializados
+ parâmetro do link + ViewState + `AJAX:EVENTS_COUNT=1`); **(3)** parseia a
resposta parcial com DOMParser e extrai `#divListaIntimacaoInss` (mesma
lógica de índice de coluna do scraper em aba).

- Implementação: `src/content/prevjud/prevjud-ssr.ts`
  (`coletarOrdensPrevjudViaSSR`). ~0,5–1s/processo, concorrência 4.
- Cadeia de rotas do coletor: sonda API → sonda SSR (2 candidatos) → abas.
  Falha pontual desce um degrau só para o processo afetado; 3 falhas SSR
  consecutivas rebaixam a varredura para abas.
- Semântica de vazio: seção presente sem linhas = processo sem ordem;
  seção ausente = erro (ViewState rejeitado/sessão expirada) → aba decide.
- Mesmo padrão SSR provado no Metas CNJ (`metas-extractor.ts`) e Prazos na
  Fita.
- Documentação institucional: https://docs.pdpj.jus.br/servicos-negociais/previdenciario/

### 2.1 Pré-filtro barato por etiqueta 🎯

A vara **já etiqueta** os processos intimados: no HTML capturado o processo tinha
a etiqueta **"INSS intimado em 02/07/2026"** (além de "LOAS Idoso", "AADJ"). Como
PREVJUD só tem dados em processos com ordem enviada, o coletor deve **abrir aba
apenas para processos com etiqueta `INSS intimado em…`** (ou classe/assunto
previdenciário-assistencial), reduzindo o universo de "aba por processo" de
milhares para dezenas. As etiquetas já vêm no `tagsProcessoList` do
`listarProcessosDaTarefa` ([pje-api-from-content.ts](../src/content/pje-api/pje-api-from-content.ts)),
então o filtro é aplicado **antes** de abrir qualquer aba.

Universo candidato (decisão do usuário): **tarefa(s) do PJe** selecionáveis, via
`listarProcessosDaTarefa`, com o pré-filtro de etiqueta acima.

---

## 3. Dicionário de colunas (thead real)

A tabela `#divListaIntimacaoInss table.rich-table` tem **10 colunas**. Os `j_id…`
são voláteis — mapear por **índice de coluna**, ancorado no `<div id="divListaIntimacaoInss">`
(id estável).

| Índice | Coluna (thead) | Campo sugerido | Exemplo | Observação |
|---|---|---|---|---|
| 0 | Ordem | `ordem` | `1` | sequencial na tabela |
| 1 | Status | `status` | `Recebida pelo INSS` | eixo de agrupamento principal |
| 2 | Serviço | `servico` | `Conceder Benefício Assistencial ao Idoso` | tipo da ordem |
| 3 | ID Documento | `idDocumento` + `urlDocumento` | `170530859` | link REST de download (§1) |
| 4 | Protocolo | `protocolo` | `dcb24230-46a7-23a2-b713-dbd6defe3c15` | UUID da ordem |
| 5 | Data de Envio | `dataEnvio` | `02/07/2026 10:25:18` | início do envelhecimento |
| 6 | ID Notificação de Envio | `idNotifEnvio` | *(vazio)* | confirmação de envio |
| 7 | ID Notificação de Cumprimento | `idNotifCumprimento` | *(vazio)* | **vazio = ordem ainda pendente** |
| 8 | Início do Prazo | `inicioPrazo` | *(vazio)* | janela de cumprimento |
| 9 | Final do Prazo | `finalPrazo` | *(vazio)* | **vencimento — prazos a vencer/vencidos** |

Regra de negócio para o dashboard: ordem **pendente** enquanto
`idNotifCumprimento` vazio; **envelhecimento** = hoje − `dataEnvio`; **prazo**
vencido/a vencer por `finalPrazo`.

---

## 4. Anatomia do HTML a raspar

Âncora estável: `<h5>Intimações INSS</h5>` seguido de
`<div id="divListaIntimacaoInss">`. Dentro, o form `j_id…` (volátil) e a tabela:

```html
<div id="divListaIntimacaoInss" class="col-sm-12">
  <form ...>
    <table class="rich-table col-sm-12" id="j_id3317:j_id3318">
      <thead class="rich-table-thead">... 10 <th class="rich-table-subheadercell"> ...</thead>
      <tbody id="j_id3317:j_id3318:tb">
        <tr class="rich-table-row rich-table-firstrow">
          <td class="rich-table-cell">1</td>
          <td class="rich-table-cell">Recebida pelo INSS</td>
          <td class="rich-table-cell">Conceder Benefício Assistencial ao Idoso</td>
          <td class="rich-table-cell">
            <a class="link-processo-documento"
               onclick="window.open('/pje/seam/resource/rest/pje-legacy/documento/download/TRF5/1g/3293122/170530859','_blank');...">
              <span>170530859 <i class="fa fa-external-link"></i></span>
            </a>
          </td>
          <td class="rich-table-cell">dcb24230-46a7-23a2-b713-dbd6defe3c15</td>
          <td class="rich-table-cell">02/07/2026 10:25:18</td>
          <td class="rich-table-cell"></td>  <!-- ID Notif. Envio -->
          <td class="rich-table-cell"></td>  <!-- ID Notif. Cumprimento -->
          <td class="rich-table-cell"></td>  <!-- Início do Prazo -->
          <td class="rich-table-cell"></td>  <!-- Final do Prazo -->
        </tr>
      </tbody>
    </table>
  </form>
</div>
```

Seletores robustos:
- Container: `#divListaIntimacaoInss`
- Linhas: `#divListaIntimacaoInss table.rich-table tbody tr.rich-table-row`
- Células: `td.rich-table-cell` por **índice 0–9**
- `idDocumento` + URL: dentro da célula 3, `a.link-processo-documento` → parsear o
  `onclick` para extrair a URL `/documento/download/…` e o número do texto.
- Tabela **vazia** (`tbody` sem `tr.rich-table-row`) → processo **sem ordem** →
  descartar do payload (não entra no relatório).

`idProcesso` aparece no próprio caminho de download (`.../1g/3293122/...`) e no
link de lembretes (`idProcessoTrf=3293122`) — mas já o teremos do
`listarProcessosDaTarefa`, então não depende do scraping.

---

## 5. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Sem REST → coleta mais lenta | Aba invisível + **pré-filtro por etiqueta** derruba o volume |
| `j_id…` voláteis | Ancorar em `#divListaIntimacaoInss`, ler células por índice |
| Sessão Seam / ViewState (se optar por replicar POST) | GET da página antes do POST; MVP evita o problema usando a aba |
| Rate/carga no PJe em varredura | Concorrência baixa (2), teto de processos, eventual flag opt-in ([modo-rapido-rest-flag.md](modo-rapido-rest-flag.md)) |
| LGPD | CNJ é público (fica no claro); nome/CPF só saem para LLM ofuscados, se houver insights por IA |

---

## 6. Próximas fases (resumo do plano)

- **Fase 1** — tipos `OrdemPrevjud` / `ProcessoOrdensPrevjud` em `types.ts`;
  coletor `src/content/prevjud/prevjud-coletor.ts` (tarefa → pré-filtro etiqueta →
  aba invisível → parse §4 → descarta vazios); canal
  `PREVJUD_COLETAR_PROCESSO` no background.
- **Fase 2** — painel dedicado `src/prevjud-painel/` (molde `pericias-painel`;
  payload via `chrome.storage.session`); visões: por Status, por Serviço,
  envelhecimento, prazos vencidos/a vencer; tabela detalhada com link para autos
  (`montarUrlAutos`) e para o documento da ordem.
- **Fase 3** — export Excel (`xlsx`), cache do último relatório em
  `storage.local`, diagnóstico de coleta visível.

---

## 7. Referências internas

- Coleta same-origin e `listarProcessosDaTarefa`: [../src/content/pje-api/pje-api-from-content.ts](../src/content/pje-api/pje-api-from-content.ts)
- Padrão aba invisível + main world: [abrir-tarefa-pje-popup.md](abrir-tarefa-pje-popup.md) §9
- Coletor irmão (universo por tarefa): [../src/content/pericias/pericias-coletor.ts](../src/content/pericias/pericias-coletor.ts)
- Riscos de coleta em escala: [modo-rapido-rest-flag.md](modo-rapido-rest-flag.md)
- Migração v11 e etiquetas: [migracao-etiquetas-pje-v11.md](migracao-etiquetas-pje-v11.md)
