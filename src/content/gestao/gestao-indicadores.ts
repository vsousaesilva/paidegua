/**
 * Cálculo determinístico dos indicadores do dashboard gerencial.
 *
 * Toda a aritmética roda localmente no navegador — nada é enviado à LLM
 * aqui. Os insights interpretativos (panorama, alertas, sugestões) são
 * gerados depois sobre a versão anonimizada dos dados.
 */

import type {
  GestaoIndicadores,
  TriagemTarefaSnapshot
} from '../../shared/types';

const LIMIAR_ATRASO_PADRAO = 30;

export function computarIndicadoresGestao(
  tarefas: TriagemTarefaSnapshot[],
  limiarAtrasoDias: number = LIMIAR_ATRASO_PADRAO
): GestaoIndicadores {
  let atrasados = 0;
  let prioritarios = 0;
  let sigilosos = 0;
  const porTarefa: Record<string, number> = {};
  const etiquetaCount = new Map<string, number>();

  for (const snap of tarefas) {
    porTarefa[snap.tarefaNome] = snap.totalLido;
    for (const p of snap.processos) {
      if (typeof p.diasNaTarefa === 'number' && p.diasNaTarefa >= limiarAtrasoDias) {
        atrasados += 1;
      }
      if (p.prioritario) prioritarios += 1;
      if (p.sigiloso) sigilosos += 1;
      for (const et of p.etiquetas) {
        etiquetaCount.set(et, (etiquetaCount.get(et) ?? 0) + 1);
      }
    }
  }

  const topEtiquetas = Array.from(etiquetaCount.entries())
    .map(([etiqueta, total]) => ({ etiqueta, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return {
    atrasados,
    limiarAtrasoDias,
    prioritarios,
    sigilosos,
    porTarefa,
    topEtiquetas
  };
}
