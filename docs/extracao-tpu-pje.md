# Extração da TPU/CNJ a partir do cadastro de movimentos do PJe

**Projeto:** pAIdegua — Assistente IA para o PJe
**Audiência:** mantenedores do `paidegua` que precisam atualizar o catálogo TPU embarcado
**Documento companheiro:** [`extracao-tarefas-painel-pje.md`](./extracao-tarefas-painel-pje.md) — padrão de extração via console que este script segue.

---

## 1. O que é e por que catalogar

A **Tabela Processual Unificada (TPU)** do CNJ é o vocabulário oficial dos movimentos processuais (sentença, despacho, juntada, audiência etc.). Cada movimento tem um **código numérico estável** (ex.: 386 = "Sentença") que aparece no histórico de movimentos de qualquer processo do PJe.

O `paidegua` embarca um snapshot completo da TPU reconhecida pelo PJe TRF5 1G em [`src/shared/tpu-seed-data.ts`](../src/shared/tpu-seed-data.ts). Esse snapshot alimenta:

- **Detector de status do processo** — saber se um histórico contém sentença, baixa, suspensão etc. via código (não regex sobre descrição).
- **Painel Metas CNJ** — classificar processos como julgados/baixados de forma autoritativa.
- **Etiquetas Inteligentes / Triagem** — contextualizar a IA com a semântica oficial dos movimentos.
- **Sigcrim** — detecção de prescrição, ANPP, sentença criminal usando códigos canônicos.
- **Linha do tempo do processo** (futuro) — agrupar movimentos por fase e pintar com cores.

A tabela tem 677 entradas no TRF5 (503 SGT nacionais + 174 locais). Atualização é rara (revisão anual da CNJ); regerar manualmente quando necessário, conforme abaixo.

---

## 2. Quando regerar

- O CNJ publicou nova versão da TPU (anuncio no portal do CNJ ou nota técnica do TRF5).
- O detector de status começou a falhar para movimentos novos que não constam do seed.
- Migração da extensão para outro tribunal (TRF1-4, TRF6) — gerar seed específico daquela instância.

A varredura cotidiana de processos NÃO depende de regerar; o seed atual cobre tudo que o PJe TRF5 reconhece hoje.

---

## 3. Como extrair (5 a 10 min)

### 3.1 Pré-requisitos

- Login ativo no PJe TRF5 com qualquer perfil que enxergue o menu de configuração (em geral, perfil de Diretor de Secretaria ou Administrador).
- Chrome ou Edge com DevTools (F12).

### 3.2 Passo a passo

1. **Abrir a tela de Movimentações processuais:**

   ```
   https://pje1g.trf5.jus.br/pje/Evento/listView.seam
   ```

   (ou via menu Configuração → Tabelas judiciais → Movimentações → Movimentações processuais)

2. **Aplicar filtros no formulário lateral esquerdo:**
   - **Situação:** `Todos` (queremos ativos E inativos — processos antigos podem referenciar movimentos descontinuados).
   - **Padrão SGT:** `Todos` (queremos os nacionais E os locais TRF5 misturados — o script separa via `isSgt`).
   - Demais filtros vazios.

3. **Clicar em `Pesquisar`.** Confirmar que o paginador no rodapé mostra ~46 páginas e o contador "X resultados encontrados" aparece.

4. **Abrir DevTools** (F12 → aba Console).

5. **Limpar estado de extração anterior** (se já rodou antes):

   ```js
   localStorage.removeItem('paidegua-tpu-extract-state-v1')
   ```

6. **Colar o script** de extração ([`scripts/extract-tpu-from-pje.js`](../scripts/extract-tpu-from-pje.js)) e dar Enter.

7. Aguardar ~1-2 min. O script percorre todas as páginas, mostra progresso no console e baixa um arquivo `tpu-extract-YYYY-MM-DDTHHMMSS.json`.

### 3.3 O que esperar

- Saída no console: `[pAIdegua tpu-extract] Página N/46: +15 (acum X)`
- Arquivo baixado em `~/Downloads/tpu-extract-...json`
- O JSON contém os 677 movimentos com `codigoCnj`, `descricao`, `caminhoCompleto`, `caminhoCodigos`, `superiorCodigoCnj`, `nivel`, `isSgt`, `ativo`, `identificadorInternoPje`.

### 3.4 Se algo der errado

| Sintoma | Causa provável | Resolução |
|---|---|---|
| `Aplique a pesquisa primeiro...` no alerta | Filtros não aplicados | Clicar `Pesquisar` no formulário, mesmo sem mexer em nada |
| Script para no meio | Sessão PJe expirou OU rede instável | Re-rodar — script detecta o estado salvo e oferece retomar |
| Total coletado < esperado | Bug de paginação ou linha malformada | Reportar com diff exato (qual página, qual linha) |

---

## 4. Como regerar o seed embarcado

A partir do JSON baixado:

```bash
# Caminho do node portátil neste ambiente — ver memory/node_portable.md
NODE="/c/Users/vsousaesilva/Downloads/node-v24.14.1-win-x64 (1)/node-v24.14.1-win-x64/node.exe"

cd paidegua

# Round único (preferido):
"$NODE" scripts/build-tpu-seed.mjs "$HOME/Downloads/tpu-extract-YYYY-MM-DDTHHMMSS.json"

# Com cross-check opcional (round 2 com filtro `Padrão SGT = Não`):
"$NODE" scripts/build-tpu-seed.mjs round1.json round2.json
```

O script:
1. Lê o JSON, decodifica BOM, parseia tolerante a `movimentos` como string ou array.
2. Normaliza o shape (renomeia `isSgt` → `origem`, deriva `ativo`).
3. Valida: códigos únicos, hierarquia coerente, contagens batem com cross-check.
4. Escreve `src/shared/tpu-seed-data.ts` (~220 KB, uma linha por movimento, ordenado por `codigoCnj`).
5. Reporta contagens (SGT/TRF5, ativos/inativos).

Em seguida:

```bash
# Confirmar que o TS compila (estrutura do seed bate com tpu-types.ts)
export PATH="/c/Users/vsousaesilva/Downloads/node-v24.14.1-win-x64 (1)/node-v24.14.1-win-x64:$PATH"
npx tsc --noEmit

# Build da extensão
npm run build
```

Commit o `tpu-seed-data.ts` regerado. O `garantirSeed()` em [`tpu-store.ts`](../src/shared/tpu-store.ts) detecta a mudança via `extraidoEm` e repopula o IndexedDB no próximo uso.

---

## 5. Estrutura do JSON de extração

```json
{
  "extraidoEm": "2026-05-03T10:35:36.304Z",
  "paginaPje": "https://pje1gta.trf5.jus.br/pje/Evento/listView.seam",
  "totalEsperado": 677,
  "totalColetado": 677,
  "movimentos": [
    {
      "codigoCnj": 386,
      "descricao": "Sentença",
      "caminhoCompleto": "Magistrado (1) | Julgamento (193) | Com Resolução do Mérito (385) | Sentença (386)",
      "caminhoCodigos": [1, 193, 385, 386],
      "superiorCodigoCnj": 385,
      "nivel": 4,
      "isSgt": true,
      "ativo": true,
      "identificadorInternoPje": 154
    }
  ]
}
```

Versões antigas do script de console (pré-2026-05) podem ter `movimentos` como string JSON — o builder tolera ambos.

---

## 6. Lições aprendidas

### 6.1 BOM UTF-8 é essencial
Sem `﻿` no início, alguns leitores (incluindo a UI de visualização de uploads do Anthropic) interpretam UTF-8 como Latin-1 e geram mojibake (`Réu` → `RÃ©u`). O builder em Node lê os bytes corretamente em ambos os casos, mas a inspeção visual dos JSONs fica ilegível sem o BOM.

### 6.2 Filtro "Padrão SGT" é informativo, não excludente
Numa primeira tentativa, o plano era extrair em duas rodadas (SGT + locais separados). Verificou-se que extrair tudo de uma vez com o filtro vazio é mais simples e o flag `isSgt` no parser separa o que importa.

### 6.3 Movimentos inativos não são lixo
37 dos 677 são `ativo: false`. São movimentos descontinuados pelo CNJ ou pelo TRF5, mas processos antigos os referenciam no histórico. Manter no seed permite reconhecimento retroativo (ex.: classificar a sentença de um processo de 2018 que usou um código depois aposentado).

### 6.4 Identificador interno é específico por instância
O campo `identificadorInternoPje` muda entre TRF5 1G, TRF5 2G, outros TRFs. NÃO usar para cross-reference. Está no seed só para auditoria/diagnóstico em logs.

### 6.5 ViewState do JSF precisa ser tratado pelo próprio framework
Tentar manipular o `j_id258:j_id259` (slider de paginação) via setar valor + click é frágil. O caminho que funciona é chamar `A4J.AJAX.Submit` diretamente — o RichFaces serializa o input com o ViewState atual e o servidor responde.

---

## 7. Próximas evoluções (registradas, sem compromisso)

- **Categorização semântica completa**: hoje só temos categorias de julgamento ([`tpu-categorias-julgamento.ts`](../src/shared/tpu-categorias-julgamento.ts)). Falta cobrir audiência, criminal (sigcrim), execução, conciliação como atos próprios.
- **Distribuição de seed por tribunal**: arquivo `tpu-seed-trf1.ts`, `tpu-seed-trf2.ts` etc. quando a extensão for adotada por outras seções da JF.
- **Atualização one-click**: botão na tela de Diagnóstico que dispara o script de extração e o builder automaticamente, sem passar por shell.

---

## 8. Referências internas

- Script de extração (console): [`scripts/extract-tpu-from-pje.js`](../scripts/extract-tpu-from-pje.js) (não checked-in — o snippet do console está aqui no §3.2 e na conversa de gênese, fase abr/mai 2026)
- Builder do seed: [`scripts/build-tpu-seed.mjs`](../scripts/build-tpu-seed.mjs)
- Tipos do catálogo: [`src/shared/tpu-types.ts`](../src/shared/tpu-types.ts)
- Snapshot embarcado: [`src/shared/tpu-seed-data.ts`](../src/shared/tpu-seed-data.ts)
- Banco IndexedDB: [`src/shared/tpu-store.ts`](../src/shared/tpu-store.ts)
- Categorias de julgamento: [`src/shared/tpu-categorias-julgamento.ts`](../src/shared/tpu-categorias-julgamento.ts)
