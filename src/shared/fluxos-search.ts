/**
 * Busca textual local sobre o catálogo de fluxos.
 *
 * Implementação minimalista (sem deps): tokenização por palavra,
 * normalização (lower + remoção de acentos), pontuação por ocorrência
 * em campos com peso decrescente: codigo > nome > fase > descricao >
 * subfluxosChamados > variaveis.
 *
 * Suficiente para 210 fluxos. Migração para `MiniSearch` futura é
 * trivial — ambos compartilham a mesma assinatura `buscar(consulta) → resultados`.
 */

import type { CatalogoFluxos, FluxoEntrada } from './fluxos-types';

export interface ResultadoBusca {
  fluxo: FluxoEntrada;
  score: number;
  motivos: string[];
}

const PESOS = {
  codigoExato: 100,
  codigoParcial: 40,
  nome: 20,
  fase: 12,
  descricao: 6,
  subChamado: 8,
  variavel: 4
};

export function buscar(catalogo: CatalogoFluxos, consulta: string, limite = 15): ResultadoBusca[] {
  const tokens = tokenizar(consulta);
  if (tokens.length === 0) return [];

  const resultados: ResultadoBusca[] = [];

  for (const f of catalogo.fluxos) {
    let score = 0;
    const motivos: string[] = [];

    const codNorm = normalizar(f.codigo);
    const nomeNorm = normalizar(f.nome);
    const faseNorm = normalizar(f.fase);
    const descNorm = normalizar(f.descricao);

    for (const t of tokens) {
      // Código exato
      if (codNorm === t) {
        score += PESOS.codigoExato;
        motivos.push(`código exato: ${f.codigo}`);
        continue;
      }
      if (codNorm.includes(t)) {
        score += PESOS.codigoParcial;
        motivos.push(`código contém ${t}`);
      }
      if (nomeNorm.includes(t)) {
        score += PESOS.nome;
        motivos.push(`nome menciona ${t}`);
      }
      if (faseNorm.includes(t)) {
        score += PESOS.fase;
      }
      if (descNorm.includes(t)) {
        score += PESOS.descricao;
      }
      for (const sub of f.subfluxosChamados) {
        if (normalizar(sub.codigo).includes(t)) {
          score += PESOS.subChamado;
          break;
        }
      }
      for (const v of [...f.variaveis.lidas, ...f.variaveis.gravadas]) {
        if (normalizar(v).includes(t)) {
          score += PESOS.variavel;
          break;
        }
      }
    }

    if (score > 0) {
      resultados.push({ fluxo: f, score, motivos });
    }
  }

  resultados.sort((a, b) => b.score - a.score);
  return resultados.slice(0, limite);
}

/**
 * Identifica o(s) candidato(s) a ponto de partida e ponto de chegada
 * em uma pergunta como "do despacho até a certidão de trânsito em julgado".
 * Retorna os 3 melhores para cada extremo.
 */
export function inferirExtremos(
  catalogo: CatalogoFluxos,
  consulta: string
): { partidas: ResultadoBusca[]; chegadas: ResultadoBusca[] } {
  const norm = normalizar(consulta);

  // Heurística simples — quebra a consulta em duas partes "até" / "ate" / "para".
  let antes = norm;
  let depois = '';
  for (const sep of [' ate ', ' até ', ' para ', ' a ', '->', '=>']) {
    const idx = norm.indexOf(sep);
    if (idx >= 0) {
      antes = norm.slice(0, idx);
      depois = norm.slice(idx + sep.length);
      break;
    }
  }

  return {
    partidas: buscar(catalogo, antes, 3),
    chegadas: depois ? buscar(catalogo, depois, 3) : []
  };
}

function tokenizar(s: string): string[] {
  return normalizar(s)
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
}

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
