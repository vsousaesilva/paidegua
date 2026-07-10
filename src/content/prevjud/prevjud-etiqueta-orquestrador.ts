/**
 * Orquestrador da aplicação da etiqueta "Prevjud - [status]" em lote
 * (dashboard PREVJUD, item 4). Roda no TOP frame da aba PJe:
 *
 *   1. Lê o catálogo de etiquetas (`listarEtiquetas`) para mapear nome→id
 *      (necessário para a remoção, que identifica a etiqueta pelo id).
 *   2. Para cada processo, calcula a etiqueta-alvo `Prevjud - <status>` e:
 *        - marca para REMOÇÃO as etiquetas "Prevjud - *" atuais que não são
 *          a alvo (mantém o padrão "uma etiqueta de status por processo");
 *        - agenda o VÍNCULO da alvo se o processo ainda não a tem.
 *   3. Remove as antigas e aplica as novas (agrupadas por status) delegando
 *      ao iframe do painel (`*ComBridge` — Origin frontend-prd).
 *
 * As escritas (criar/vincular/remover) rodam no page world do iframe, pelos
 * mesmos motivos de Origin das Perícias (ver pericias-etiqueta-bridge).
 */

import { LOG_PREFIX } from '../../shared/constants';
import { listarEtiquetas } from '../pje-api/pje-api-from-content';
import {
  aplicarEtiquetaEmLoteComBridge,
  removerEtiquetaEmLoteComBridge
} from '../pericias/pericias-etiqueta-bridge';
import type {
  PrevjudAplicarEtiquetasProcesso,
  PrevjudAplicarEtiquetasResult
} from '../../shared/types';

/** Prefixo (minúsculo) que identifica as etiquetas de status geridas aqui. */
const PREFIXO_STATUS = 'prevjud -';

export async function atualizarEtiquetasStatus(input: {
  processos: PrevjudAplicarEtiquetasProcesso[];
  onProgress?: (msg: string) => void;
}): Promise<PrevjudAplicarEtiquetasResult> {
  const progress = input.onProgress ?? ((): void => {});
  const procs = (input.processos ?? []).filter(
    (p) => p.idProcesso > 0 && (p.statusEtiqueta ?? '').trim().length > 0
  );
  if (procs.length === 0) {
    return {
      ok: false,
      vinculadas: 0,
      removidas: 0,
      gruposAplicados: 0,
      error: 'Nenhum processo com status para etiquetar.'
    };
  }

  progress('Lendo catálogo de etiquetas do PJe...');
  const cat = await listarEtiquetas({ pageSize: 5000 });
  if (!cat.ok) {
    return {
      ok: false,
      vinculadas: 0,
      removidas: 0,
      gruposAplicados: 0,
      error: `Falha ao listar etiquetas: ${cat.error ?? 'erro'}.`
    };
  }
  const idPorNome = new Map<string, number>();
  for (const e of cat.etiquetas) {
    const k = e.nomeTag.trim().toLowerCase();
    if (k && !idPorNome.has(k)) idPorNome.set(k, e.id);
  }

  const remocoes: Array<{ idProcesso: number; idTag: number; nomeTag?: string }> = [];
  const grupos = new Map<string, number[]>();
  let jaComEtiqueta = 0;
  const exemploTarget = `Prevjud - ${procs[0].statusEtiqueta.trim()}`;
  const exemploAtuais = (procs[0].etiquetasAtuais ?? []).slice(0, 8);

  for (const p of procs) {
    const target = `Prevjud - ${p.statusEtiqueta.trim()}`;
    const targetLower = target.toLowerCase();
    const atuais = (p.etiquetasAtuais ?? [])
      .map((s) => s.trim())
      .filter(Boolean);

    for (const nome of atuais) {
      const nl = nome.toLowerCase();
      if (nl.startsWith(PREFIXO_STATUS) && nl !== targetLower) {
        const idTag = idPorNome.get(nl);
        if (idTag) remocoes.push({ idProcesso: p.idProcesso, idTag, nomeTag: nome });
      }
    }

    const jaTem = atuais.some((n) => n.toLowerCase() === targetLower);
    if (jaTem) {
      jaComEtiqueta += 1;
    } else {
      const arr = grupos.get(target) ?? [];
      arr.push(p.idProcesso);
      grupos.set(target, arr);
    }
  }

  const aAplicar = Array.from(grupos.values()).reduce((a, ids) => a + ids.length, 0);
  const diag = {
    recebidos: procs.length,
    jaComEtiqueta,
    aAplicar,
    aRemover: remocoes.length,
    gruposDistintos: grupos.size,
    exemploTarget,
    exemploAtuais
  };
  console.log(`${LOG_PREFIX} [prevjud-etiquetas] diag`, diag);

  // -- Remoção das etiquetas de status antigas --
  let removidas = 0;
  if (remocoes.length > 0) {
    progress(`Removendo ${remocoes.length} etiqueta(s) Prevjud antiga(s)...`);
    const r = await removerEtiquetaEmLoteComBridge({ remocoes, onProgress: progress });
    removidas = r.removidas;
  }

  // -- Aplicação da etiqueta-alvo, agrupada por status --
  let vinculadas = 0;
  let gruposAplicados = 0;
  const erros: string[] = [];
  for (const [target, ids] of grupos) {
    progress(`Aplicando "${target}" em ${ids.length} processo(s)...`);
    const r = await aplicarEtiquetaEmLoteComBridge({
      etiquetaPauta: target,
      idsProcesso: ids,
      favoritarAposCriar: false,
      onProgress: progress
    });
    vinculadas += r.aplicadas;
    gruposAplicados += 1;
    if (r.aplicadas === 0 && r.error) erros.push(`${target}: ${r.error}`);
  }

  const nada = grupos.size === 0 && remocoes.length === 0;
  console.log(
    `${LOG_PREFIX} [prevjud-etiquetas] ${vinculadas} vinculada(s), ` +
      `${removidas} removida(s), ${gruposAplicados} grupo(s), ${erros.length} erro(s).`
  );
  return {
    ok: nada || vinculadas > 0 || removidas > 0,
    vinculadas,
    removidas,
    gruposAplicados,
    error: erros.length > 0 ? erros.join(' | ') : undefined,
    diag
  };
}
