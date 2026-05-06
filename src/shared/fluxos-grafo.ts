/**
 * Algoritmos sobre o grafo dirigido de chamadas entre fluxos.
 *
 * O grafo é construído a partir das `subfluxosChamados` de cada
 * `FluxoEntrada`. Operações principais:
 *   - caminho mais curto entre dois fluxos (BFS)
 *   - todos os caminhos até profundidade D (DFS limitado)
 *   - vizinhos diretos (in/out)
 *   - ordenação por centralidade (grau total)
 */

import type { CatalogoFluxos, FluxoEdge, FluxoEntrada } from './fluxos-types';

export interface Grafo {
  /** code → entrada (apenas fluxos presentes no catálogo). */
  nos: Map<string, FluxoEntrada>;
  /** code → códigos chamados (out-edges). */
  saidas: Map<string, FluxoEdge[]>;
  /** code → códigos que chamam (in-edges). */
  entradas: Map<string, FluxoEdge[]>;
  /** Códigos referenciados mas ausentes do catálogo. */
  fantasmas: Set<string>;
}

export function construirGrafo(catalogo: CatalogoFluxos): Grafo {
  const nos = new Map<string, FluxoEntrada>();
  const saidas = new Map<string, FluxoEdge[]>();
  const entradas = new Map<string, FluxoEdge[]>();
  const fantasmas = new Set<string>();

  for (const f of catalogo.fluxos) {
    nos.set(f.codigo, f);
    saidas.set(f.codigo, []);
    if (!entradas.has(f.codigo)) entradas.set(f.codigo, []);
  }

  for (const f of catalogo.fluxos) {
    for (const sub of f.subfluxosChamados) {
      const edge: FluxoEdge = { from: f.codigo, to: sub.codigo, contextos: sub.contextos };
      saidas.get(f.codigo)!.push(edge);
      if (!entradas.has(sub.codigo)) entradas.set(sub.codigo, []);
      entradas.get(sub.codigo)!.push(edge);
      if (!nos.has(sub.codigo)) fantasmas.add(sub.codigo);
    }
  }

  return { nos, saidas, entradas, fantasmas };
}

/**
 * BFS — caminho mais curto de `de` até `para`. Retorna sequência de
 * códigos (incluindo extremos) ou null se não houver caminho.
 */
export function caminhoMaisCurto(grafo: Grafo, de: string, para: string): string[] | null {
  if (de === para) return [de];
  if (!grafo.saidas.has(de)) return null;

  const visitados = new Set<string>([de]);
  const fila: Array<{ no: string; caminho: string[] }> = [{ no: de, caminho: [de] }];

  while (fila.length > 0) {
    const { no, caminho } = fila.shift()!;
    const edges = grafo.saidas.get(no) ?? [];
    for (const e of edges) {
      if (visitados.has(e.to)) continue;
      const novoCaminho = [...caminho, e.to];
      if (e.to === para) return novoCaminho;
      visitados.add(e.to);
      fila.push({ no: e.to, caminho: novoCaminho });
    }
  }
  return null;
}

/**
 * DFS limitado — todos os caminhos de `de` até `para` com no máximo
 * `profundidadeMax` arestas. Útil para mostrar variações ao usuário.
 */
export function todosCaminhos(
  grafo: Grafo,
  de: string,
  para: string,
  profundidadeMax = 8
): string[][] {
  const resultados: string[][] = [];

  function dfs(atual: string, caminho: string[], visitados: Set<string>) {
    if (caminho.length - 1 > profundidadeMax) return;
    if (atual === para && caminho.length > 1) {
      resultados.push([...caminho]);
      return;
    }
    const edges = grafo.saidas.get(atual) ?? [];
    for (const e of edges) {
      if (visitados.has(e.to)) continue; // evita ciclo
      visitados.add(e.to);
      caminho.push(e.to);
      dfs(e.to, caminho, visitados);
      caminho.pop();
      visitados.delete(e.to);
    }
  }

  const visitados = new Set<string>([de]);
  dfs(de, [de], visitados);

  // Ordena por tamanho (caminhos mais curtos primeiro).
  resultados.sort((a, b) => a.length - b.length);
  return resultados;
}

/** Vizinhos diretos de saída (fluxos chamados por `code`). */
export function vizinhosSaida(grafo: Grafo, code: string): FluxoEdge[] {
  return grafo.saidas.get(code) ?? [];
}

/** Vizinhos diretos de entrada (fluxos que chamam `code`). */
export function vizinhosEntrada(grafo: Grafo, code: string): FluxoEdge[] {
  return grafo.entradas.get(code) ?? [];
}

/** Top-N por grau total (in + out). */
export function hubs(grafo: Grafo, n = 10): Array<{ codigo: string; grau: number }> {
  const ranking: Array<{ codigo: string; grau: number }> = [];
  for (const code of grafo.nos.keys()) {
    const grau =
      (grafo.saidas.get(code)?.length ?? 0) + (grafo.entradas.get(code)?.length ?? 0);
    ranking.push({ codigo: code, grau });
  }
  ranking.sort((a, b) => b.grau - a.grau);
  return ranking.slice(0, n);
}

/** Pontos de entrada do macro-processo (sem chamadas entrantes). */
export function pontosDeEntrada(grafo: Grafo): string[] {
  const result: string[] = [];
  for (const code of grafo.nos.keys()) {
    const ent = grafo.entradas.get(code) ?? [];
    if (ent.length === 0) result.push(code);
  }
  return result.sort();
}

/** Pontos de saída do macro-processo (sem chamadas saintes). */
export function pontosDeSaida(grafo: Grafo): string[] {
  const result: string[] = [];
  for (const code of grafo.nos.keys()) {
    const sai = grafo.saidas.get(code) ?? [];
    if (sai.length === 0) result.push(code);
  }
  return result.sort();
}

export interface OpcoesMermaid {
  /**
   * Se true, renderiza com código + nome + lane (modo dev).
   * Se false, mostra apenas o nome legível (modo usuário).
   */
  mostrarCodigo: boolean;
}

/**
 * Renderiza um caminho (sequência de códigos) como diagrama Mermaid
 * `flowchart LR`. Em modo dev, cada nó traz código + nome + lane.
 * Em modo usuário, mostra apenas o nome legível, limpo.
 */
export function caminhoParaMermaid(
  grafo: Grafo,
  caminho: string[],
  opcoes: OpcoesMermaid = { mostrarCodigo: true }
): string {
  if (caminho.length === 0) return '';

  const linhas = ['flowchart LR'];
  // Nós
  for (const code of caminho) {
    const f = grafo.nos.get(code);
    const lane = f?.lane ?? '?';
    const nomeLegivel = limparNomeUsuario(f?.nome ?? code);
    const id = sanitizarId(code);
    if (opcoes.mostrarCodigo) {
      linhas.push(
        `  ${id}["${escaparMermaid(code)}<br/><i>${escaparMermaid(
          nomeLegivel
        ).slice(0, 40)}</i><br/>${lane}"]`
      );
    } else {
      linhas.push(`  ${id}["${escaparMermaid(nomeLegivel).slice(0, 50)}"]`);
    }
  }
  // Edges
  for (let i = 0; i < caminho.length - 1; i++) {
    const a = caminho[i];
    const b = caminho[i + 1];
    const edges = grafo.saidas.get(a) ?? [];
    const e = edges.find((ed) => ed.to === b);
    const lbl = e?.contextos[0]
      ? escaparMermaid(extrairLabelDoContexto(e.contextos[0])).slice(0, 30)
      : '';
    const ida = sanitizarId(a);
    const idb = sanitizarId(b);
    linhas.push(lbl ? `  ${ida} -->|${lbl}| ${idb}` : `  ${ida} --> ${idb}`);
  }

  // Estilos por lane (apenas em modo dev — usuário não vê lane)
  if (opcoes.mostrarCodigo) {
    for (const code of caminho) {
      const f = grafo.nos.get(code);
      const lane = f?.lane ?? '?';
      const id = sanitizarId(code);
      const cor = corPorLane(lane);
      linhas.push(`  style ${id} fill:${cor},stroke:#0a4d75,color:#1f2933`);
    }
  } else {
    // No modo usuário, todos os nós têm o mesmo tom suave.
    for (const code of caminho) {
      const id = sanitizarId(code);
      linhas.push(`  style ${id} fill:#e6eef9,stroke:#0a4d75,color:#1f2933`);
    }
  }
  return linhas.join('\n');
}

function limparNomeUsuario(nome: string): string {
  return nome
    .replace(/^\s*\[(?:JEF|EF|COMUM)\]\s*/i, '')
    .replace(/_+/g, ' ')
    .replace(/[\[\]"`]/g, '')
    .trim();
}

function corPorLane(lane: string): string {
  switch (lane) {
    case 'JEF':
      return '#dbeafe';
    case 'EF':
      return '#fef3c7';
    case 'Comum':
      return '#e0e7ff';
    case 'Shared':
      return '#d1fae5';
    default:
      return '#f3f4f6';
  }
}

function sanitizarId(code: string): string {
  // Mermaid não aceita brackets ou espaços em IDs.
  return code.replace(/[^A-Z0-9_]/gi, '_');
}

function escaparMermaid(s: string): string {
  return s.replace(/"/g, "'").replace(/[<>]/g, '').replace(/\|/g, '/');
}

function extrairLabelDoContexto(ctx: string): string {
  // Tentamos pegar o nome do nó "Incluir no fluxo de XXX" para usar como label.
  const m = ctx.match(/Incluir no fluxo de ([^']+)/i);
  if (m) return m[1].trim();
  return ctx.slice(0, 30);
}
