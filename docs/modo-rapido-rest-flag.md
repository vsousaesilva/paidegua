# Modo rápido (REST direto) para coleta de expedientes — desenho com flag opcional

**Status:** documento de desenho (registro de decisão). **Não implementado.**
Guardado aqui para referência futura quando/se a JFCE decidir adotar o modo
REST de forma generalizada.

**Audiência:** mantenedores do `paidegua` e TI-JFCE responsáveis pela política
de distribuição.

**Contexto atual (abril/2026):** a coleta de expedientes do painel "Prazos
na fita" atualmente é feita de forma **incondicional** via chamada REST
direta ao PJe (a mesma que o painel Angular usa internamente). Esta
substituição foi feita a partir da discussão consolidada neste documento.
O desenho de *flag opcional* registrado aqui está preservado porque pode
voltar a ser necessário caso: (a) surja uma restrição institucional que
exija um modo "conservador" (tab-scraping) como fallback, ou (b) o PJe
introduza um endpoint similar cuja adoção deva ser negociada caso a caso.

---

## 1. Motivação do modo rápido

O caminho tradicional de coleta abria uma aba em `listAutosDigitais.seam`
por processo, esperava o DOM carregar, rodava o scraper e fechava a aba.
Em lotes de 300+ processos esse pipeline demora **≈3 s por processo**,
dominado por:

- `chrome.tabs.create` + navegação completa do legacy;
- `waitTabComplete` aguardando `status === 'complete'`;
- scraping síncrono do `tbody` de expedientes;
- `chrome.tabs.remove` e housekeeping.

Trocar a aba por uma chamada REST direta (o mesmo endpoint que o Angular
do painel usa para popular a aba "Expedientes") cai para **≈0,2 s por
processo** — **redução de ~15×** — porque elimina o custo de
render/navegação e deixa apenas a latência HTTP + parse JSON.

---

## 2. Riscos institucionais de adotar REST sem opt-in

O `paidegua` é distribuído para **centenas de servidores e magistrados**
da JFCE. Mesmo sendo o mesmo endpoint que o painel nativo usa, o uso
programático em escala tem implicações que podem não ser aceitas por
default em todas as localizações:

1. **Políticas locais de segurança.** Algumas varas têm políticas internas
   que restringem chamadas automatizadas a sistemas judiciais — mesmo que
   autenticadas com o próprio usuário — sem prévia aprovação da TI.
2. **Rate/load no servidor PJe.** Um pool de 2–4 concorrências × 100
   usuários simultâneos = até 400 chamadas concorrentes contra o cluster
   PJe. O painel nativo não gera esse padrão; a TI precisa estar ciente.
3. **Dependência de endpoint não-público.** O endpoint de expedientes
   não faz parte da API publicada do PJe (apenas do frontend Angular).
   Atualizações de versão podem quebrá-lo sem aviso.
4. **Auditoria/logs do PJe.** Chamadas REST ficam nos logs do servidor
   como tráfego do usuário autenticado — não há rastro de que vieram
   da extensão. Se um comportamento anômalo for detectado, a TI precisa
   conseguir identificar a origem.

Por esses motivos, um desenho alternativo é manter o scraping como
default seguro e liberar o modo REST via **flag explícita**, com
consentimento do usuário e possibilidade de **política managed** pela
TI-JFCE.

---

## 3. Desenho da flag

### 3.1. Schema em `storage.local`

Estender o objeto de configurações do `paidegua`:

```ts
interface Settings {
  // ... campos existentes ...
  modoRapidoExpedientes: {
    /** Quando true, a coleta usa REST direto em vez de tab-scraping. */
    ativo: boolean;
    /** Confirma que o aviso de primeira ativação foi aceito. Trava o toggle
     *  até o usuário ler e aceitar. */
    avisoAceito: boolean;
    /** ms epoch de quando o aviso foi aceito (auditoria local). */
    avisoAceitoEm: number | null;
  };
}
```

Default: `{ ativo: false, avisoAceito: false, avisoAceitoEm: null }`.

### 3.2. Override via `chrome.storage.managed` (política TI-JFCE)

A TI-JFCE pode pré-configurar o comportamento via policy template do
Chrome (arquivo `.json` com `ExtensionInstallForcelist` + managed
storage schema). Isso permite:

- **Forçar ativado** em varas onde a TI homologou o modo rápido;
- **Forçar desativado** em varas onde a política local não permite;
- **Deixar em modo usuário** (default) — permite o opt-in individual.

Schema do managed storage:

```json
{
  "modoRapidoExpedientes": {
    "modo": "forcado-ativo" | "forcado-desativo" | "usuario-decide"
  }
}
```

Precedência: `managed` > `local`. Se TI definir `forcado-ativo`, o
toggle na página de opções aparece **bloqueado e marcado**, com texto
"Definido pela TI-JFCE". Simétrico para `forcado-desativo`.

### 3.3. Três opções de UI para o usuário

**Opção A — Página de opções (preferida para distribuição ampla).**
Checkbox dedicado numa seção "Coleta de prazos" com:

- Rótulo: "Modo rápido (REST direto ao PJe)";
- Texto de advertência acima do checkbox com os 4 riscos do §2;
- Botão "Li e aceito" que desbloqueia o checkbox — sem clicar no
  aceite, o checkbox fica disabled;
- Indicador "Definido pela TI-JFCE" quando managed storage trava.

**Opção B — Apenas managed storage (sem UI).** A flag não aparece
para o usuário; só é ativável por policy da TI. Mais seguro para
ambientes muito restritos, mas perde a flexibilidade do opt-in
individual.

**Opção C — Popup compacto > "Avançado".** Um collapsible no popup
principal com o mesmo checkbox. Descartada para esse caso específico
porque o popup é o caminho rápido para o uso cotidiano; colocar uma
flag sensível ali aumenta o risco de ativação acidental.

### 3.4. Modal de primeira ativação

Ao clicar em "Li e aceito" pela primeira vez, exibir modal com:

```
┌─────────────────────────────────────────────────────────────┐
│ Ativar Modo Rápido — Coleta de expedientes                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Este modo substitui a abertura de aba por chamada direta   │
│  à API interna do PJe. É ~15× mais rápido, mas:             │
│                                                             │
│  • Usa um endpoint não-público (pode quebrar após           │
│    atualizações do PJe);                                    │
│  • Gera tráfego REST em volume maior do que o uso manual;   │
│  • Recomenda-se aprovação prévia da TI da sua seção.        │
│                                                             │
│  Ao ativar, o comportamento continua o mesmo — apenas a     │
│  forma de obter os dados muda.                              │
│                                                             │
│              [ Cancelar ]    [ Ativar ]                     │
└─────────────────────────────────────────────────────────────┘
```

Só registra `avisoAceito: true` + `avisoAceitoEm` quando o usuário
clica em "Ativar". Cancelar reverte o checkbox.

---

## 4. Runtime — onde a branch entra

No `coletarPrazosPorTarefasViaAPI` do
[prazos-fita-coordinator.ts](../src/content/gestao/prazos-fita-coordinator.ts),
substituir o trecho do worker pool que chama
`PRAZOS_FITA_COLETAR_PROCESSO` por um roteador:

```ts
const modoRapido = await lerFlagModoRapido(); // lê managed ∪ local
if (modoRapido) {
  coleta = await coletarExpedientesViaREST({
    idProcesso: processoApi.idProcesso,
    timeoutMs: opts.timeoutPorProcessoMs
  });
} else {
  // caminho atual via tab-scraping (preservado)
  const raw = await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETAR_PROCESSO,
    payload: { url, timeoutMs: opts.timeoutPorProcessoMs }
  });
  coleta = normalizarResposta(raw, url);
}
```

A função `coletarExpedientesViaREST` mora em
`pje-api-from-content.ts`, reusa `obterSnapshot` + `montarHeaders` +
`fetchComTimeout` + `comRetryTransiente`, e devolve a **mesma shape**
`PrazosProcessoColeta` — isso preserva todos os consumidores a jusante
(dashboard, relatórios, métricas).

---

## 5. Telemetria local (opcional)

Contador simples em `storage.local` para apoio a decisões:

```ts
interface TelemetriaModoRapido {
  totalExecucoes: number;
  execucoesPorModo: {
    rapidoAtivo: number;
    tabScraping: number;
  };
  falhasRapidoConsecutivas: number;
  ultimaFalhaRapido: { ts: number; erro: string } | null;
}
```

**Sem envio externo** — apenas leitura sob demanda na página de opções,
para mostrar ao usuário "Você já rodou 42 coletas em modo rápido, sem
falhas." Ajuda no diagnóstico de regressões sem expor nenhum dado
processual.

---

## 6. Tratamento de falhas — sem fallback automático

**Decisão:** quando o modo rápido está ativo e a chamada REST falha
(HTTP 5xx persistente após retry, ou parse quebrando por mudança de
schema), **não caímos automaticamente** para tab-scraping. Motivos:

1. Fallback silencioso mascararia regressão real do PJe — queremos
   que o problema apareça para disparar investigação.
2. Um pipeline que ora usa REST ora usa DOM produz resultados sutilmente
   diferentes (ordenação, campos truncados) — inconsistência de dados
   é pior que uma falha explícita.
3. O usuário ainda pode desativar a flag manualmente e re-executar.

Quando falha, a mensagem no painel deve indicar o modo usado:
`"expedientes (modo rápido): HTTP 500 persistente após 3 retries"`.

---

## 7. Diagrama arquitetural

```
┌─────────────┐    ┌──────────────────────┐    ┌─────────────────┐
│  TI-JFCE    │───▶│ chrome.storage       │    │  Usuário        │
│ (policy     │    │ .managed             │    │ (página de      │
│  JSON)      │    │   modo: forcado-*    │    │  opções)        │
└─────────────┘    │   | usuario-decide   │◀───│ checkbox + aviso│
                   └──────────┬───────────┘    └─────────────────┘
                              │
                              ▼
                   ┌──────────────────────┐
                   │ lerFlagModoRapido()  │
                   │ managed ∪ local      │
                   └──────────┬───────────┘
                              │
          ┌───────────────────┴────────────────────┐
          ▼                                        ▼
┌──────────────────────┐               ┌─────────────────────────┐
│ coletarExpedientes   │               │ PRAZOS_FITA_COLETAR_    │
│ ViaREST              │               │ PROCESSO (scraping)     │
│ (~0,2s/processo)     │               │ (~3s/processo)          │
│                      │               │ • abre aba              │
│ • fetch REST         │               │ • waitTabComplete       │
│ • parse JSON         │               │ • extractExpedientes    │
│ • mapeia shape       │               │ • fecha aba             │
└──────────┬───────────┘               └──────────┬──────────────┘
           │                                      │
           └──────────────┬───────────────────────┘
                          ▼
               ┌──────────────────────┐
               │ PrazosProcessoColeta │
               │ (mesma shape p/ os   │
               │  consumidores)       │
               └──────────────────────┘
```

---

## 8. Critérios para revisitar esta decisão

Este desenho volta à mesa se:

- TI-JFCE publicar política formal sobre uso programático do PJe;
- O endpoint REST de expedientes começar a falhar em varredura
  (indicando mudança no backend);
- For necessário suportar tribunais além do TRF5 cujo PJe tenha
  endpoints REST distintos e heterogêneos;
- A comunidade Inovajus/CNJ publicar orientação sobre automações
  cliente-side em sistemas judiciais.

---

## 9. Referências

- [prazos-fita-coordinator.ts](../src/content/gestao/prazos-fita-coordinator.ts) — onde entra a branch.
- [pje-api-from-content.ts](../src/content/pje-api/pje-api-from-content.ts) — abriga helpers REST + `fetchComTimeout` + `comRetryTransiente`.
- [post-mortem-prazos-na-fita.md](post-mortem-prazos-na-fita.md) — incidentes da fase atual (dedup de mensagens, body do Angular, timeouts).
- [chrome.storage.managed (docs MV3)](https://developer.chrome.com/docs/extensions/reference/api/storage#property-managed) — mecanismo de política empresarial.
