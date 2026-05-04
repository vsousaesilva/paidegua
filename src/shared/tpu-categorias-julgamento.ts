/**
 * Mapeamento de categorias semânticas relacionadas a JULGAMENTO,
 * EXTINÇÃO e BAIXA — usado pelo detector de status do processo
 * (`processo-status-detector.ts`) e pelo painel de Metas CNJ.
 *
 * Estratégia de cobertura:
 *   - Hierárquica: tudo que descende de um nó-raiz reconhecido herda a
 *     categoria. Ex.: qualquer descendente de 385 ("Com Resolução do
 *     Mérito") ganha `julgamento_merito`.
 *   - Pontual: códigos específicos (homologações de acordo, baixa
 *     definitiva) entram por whitelist explícita.
 *
 * O resultado é uma `TpuCategoriasMap` consumida por
 * `garantirSeed(...)` em `tpu-store.ts`.
 *
 * Convenção de regras:
 *   - `julgamento_merito` ⇔ descendente de 385.
 *   - `julgamento_sem_merito` ⇔ descendente de 218.
 *   - `extincao_punibilidade` ⇔ descendente de 973 (também é julgamento
 *     de mérito por estar sob 385 — ganha as duas categorias).
 *   - `homologacao_acordo` ⇔ whitelist abaixo. O detector trata estes
 *     códigos como "julgado" para Metas CNJ, ainda que tecnicamente
 *     fiquem sob "Decisão" e não "Julgamento" no PJe.
 *   - `baixa` ⇔ Baixa Definitiva (22) — único movimento que retira o
 *     processo do acervo da vara em definitivo. Arquivamento (provisório
 *     ou definitivo) NÃO entra: arquivado ainda é processo da vara.
 *
 * Para acrescentar novos códigos: adicionar à whitelist correspondente
 * e regerar via `garantirSeed`. Não há repopulação automática — é
 * preciso reabrir o banco (ou chamar `garantirSeed` quando o seed mudar).
 */

import { TPU_SEED } from './tpu-seed-data';
import type { TpuCategoria } from './tpu-types';
import type { TpuCategoriasMap } from './tpu-store';

// Códigos-raiz para inferência hierárquica.
const RAIZ_JULGAMENTO_MERITO = 385;
const RAIZ_JULGAMENTO_SEM_MERITO = 218;
const RAIZ_EXTINCAO_PUNIBILIDADE = 973;

/**
 * Códigos de homologação de acordo, em qualquer modalidade. Diretiva do
 * domínio: para fins de Metas CNJ, todos contam como julgamento.
 *
 * - 466   — Homologada a Transação (CPC, Magistrado | Julgamento | Mérito)
 * - 377   — Homologado Acordo em execução ou cumprimento de sentença
 * - 12738 — Homologada Transação Penal (Lei 9.099)
 * - 12733 — Homologado o Acordo de Não Persecução Penal (ANPP, CPP 28-A)
 * - 14099 — Homologado o Acordo em Execução ou em Cumprimento de Sentença
 * - 15244 — Homologado o acordo parcial em execução ou cumprimento
 * - 14776 — Homologação em Parte (genérico — costuma ser usado para
 *           acordo parcial fora do shape específico do 15244)
 */
const HOMOLOGACAO_ACORDO_CODIGOS: readonly number[] = [
  466,
  377,
  12738,
  12733,
  14099,
  15244,
  14776
];

/**
 * Códigos que indicam BAIXA do processo (sai definitivamente do acervo
 * da vara). Conservador — só inclui o que tem efeito definitivo:
 *
 * - 22 — Baixa Definitiva (Serventuário | Distribuidor | Baixa Definitiva)
 *
 * NÃO INCLUÍDO (e por quê):
 *   - 245/246 — Arquivamento Provisório/Definitivo: processo ainda é da
 *     vara, pode ser desarquivado. Não conta como baixa para Metas.
 *   - 228 — Arquivamento (sob Julgamento sem mérito): é o ato judicial
 *     de extinção, não a baixa cartorária.
 */
const BAIXA_CODIGOS: readonly number[] = [22];

// =====================================================================
// Construção do mapa
// =====================================================================

function add(
  mapa: Map<number, TpuCategoria[]>,
  codigo: number,
  cat: TpuCategoria
): void {
  const lista = mapa.get(codigo);
  if (lista) {
    if (!lista.includes(cat)) lista.push(cat);
  } else {
    mapa.set(codigo, [cat]);
  }
}

/**
 * Constrói o mapeamento `codigoCnj → TpuCategoria[]` para os domínios
 * de julgamento/extinção/baixa, expandindo as raízes hierárquicas via
 * `caminhoCodigos`.
 *
 * Função pura — chamada uma vez no startup, antes de `garantirSeed`.
 */
export function buildCategoriasJulgamento(): TpuCategoriasMap {
  const mapa = new Map<number, TpuCategoria[]>();

  for (const mov of TPU_SEED.movimentos) {
    // Hierárquico: descendentes de 385 ganham julgamento_merito;
    // descendentes de 218 ganham julgamento_sem_merito;
    // descendentes de 973 ganham extincao_punibilidade (e também
    // julgamento_merito, já que 973 está dentro de 385).
    if (mov.caminhoCodigos.includes(RAIZ_JULGAMENTO_MERITO)) {
      add(mapa, mov.codigoCnj, 'julgamento_merito');
    }
    if (mov.caminhoCodigos.includes(RAIZ_JULGAMENTO_SEM_MERITO)) {
      add(mapa, mov.codigoCnj, 'julgamento_sem_merito');
    }
    if (mov.caminhoCodigos.includes(RAIZ_EXTINCAO_PUNIBILIDADE)) {
      add(mapa, mov.codigoCnj, 'extincao_punibilidade');
    }
  }

  // Whitelist explícita
  for (const c of HOMOLOGACAO_ACORDO_CODIGOS) {
    add(mapa, c, 'homologacao_acordo');
  }
  for (const c of BAIXA_CODIGOS) {
    add(mapa, c, 'baixa');
  }

  return mapa;
}

/**
 * Helper para inspeção/diagnóstico — quantos movimentos estão em cada
 * categoria coberta por este arquivo.
 */
export function contagemPorCategoriaJulgamento(): Record<string, number> {
  const mapa = buildCategoriasJulgamento();
  const cont: Record<string, number> = {};
  for (const cats of mapa.values()) {
    for (const c of cats) {
      cont[c] = (cont[c] ?? 0) + 1;
    }
  }
  return cont;
}
