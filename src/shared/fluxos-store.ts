/**
 * Loader do catálogo de fluxos.
 *
 * Estratégia atual: **embarcado** — `assets/fluxos-catalogo.json` é
 * empacotado no build (copy-webpack-plugin) e lido via `fetch()` sobre
 * `chrome.runtime.getURL`. Cache em memória durante a vida da página.
 *
 * Migração futura para Worker (Cloudflare): basta trocar a URL em
 * `CatalogoSourceRemoto` e plugar nele em `getCatalogo()`. Schema é o
 * mesmo (`CatalogoFluxos`).
 */

import type { CatalogoFluxos, FluxoEntrada } from './fluxos-types';

const ASSET_URL = 'assets/fluxos-catalogo.json';

let _catalogoCache: CatalogoFluxos | null = null;
let _indicePorCodigo: Map<string, FluxoEntrada> | null = null;

/**
 * Carrega o catálogo (embarcado). Chamadas subsequentes retornam do cache.
 * Lança se o asset não estiver disponível.
 */
export async function getCatalogo(): Promise<CatalogoFluxos> {
  if (_catalogoCache) return _catalogoCache;

  const url = chrome.runtime.getURL(ASSET_URL);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Catálogo de fluxos indisponível (${ASSET_URL}). ` +
        `HTTP ${resp.status}. Garantir que o build copia o asset e que o parser jPDL foi executado.`
    );
  }
  const data = (await resp.json()) as CatalogoFluxos;
  if (!data || !Array.isArray(data.fluxos)) {
    throw new Error('Catálogo de fluxos com schema inválido (esperado { fluxos: [] }).');
  }
  _catalogoCache = data;
  _indicePorCodigo = new Map(data.fluxos.map((f) => [f.codigo, f]));
  return data;
}

/** Retorna fluxo pelo código exato. */
export async function getFluxo(codigo: string): Promise<FluxoEntrada | null> {
  await getCatalogo();
  return _indicePorCodigo?.get(codigo) ?? null;
}

/** Retorna metadata sem precisar carregar todo o catálogo. */
export function getCatalogoEmCache(): CatalogoFluxos | null {
  return _catalogoCache;
}

/**
 * Resumo técnico do catálogo para o modo DEV (~30 KB).
 * Inclui código, nome, lane, fase, sub-chamadas e fins.
 */
export async function getResumoParaPrompt(): Promise<string> {
  const cat = await getCatalogo();
  const linhas = ['# Catálogo de fluxos PJe (resumo)', `Total: ${cat.totalFluxos} fluxos.`, ''];
  for (const f of cat.fluxos) {
    const subs = f.subfluxosChamados.map((s) => s.codigo).join(', ') || '—';
    const fins = f.fins.map((e) => e.nome).join(', ') || '—';
    linhas.push(
      `- **${f.codigo}** [${f.lane} · ${f.fase}] — ${f.nome}\n  chama: ${subs}\n  fins: ${fins}`
    );
  }
  return linhas.join('\n');
}

/**
 * Resumo humanizado para o modo USUÁRIO. Esconde códigos jBPM e
 * vocabulário técnico. Cada fluxo vira uma linha do tipo:
 *
 *   - "Operação de perícia" — etapa típica de perícia em juizado especial.
 *     Daqui costuma seguir para: análise da secretaria, intimação da
 *     designação, aguardo de laudo, ou cancelamento.
 *
 * O LLM usa isso para identificar etapas e descrever caminhos sem
 * vazar siglas / códigos para o usuário final.
 */
export async function getResumoParaPromptUsuario(): Promise<string> {
  const cat = await getCatalogo();
  const linhas = [
    '# Mapa das etapas de tramitação do PJe (versão para usuário final)',
    `Total: ${cat.totalFluxos} etapas mapeadas.`,
    '',
    '> **Importante:** os códigos abaixo são identificadores internos do sistema.',
    '> Você (assistente) NÃO deve mencioná-los na resposta ao usuário. Use sempre',
    '> os nomes legíveis. Os códigos servem apenas para você localizar os caminhos',
    '> entre etapas no mapa interno.',
    '',
    '## Pistas processuais',
    '',
    '- **Juizados Especiais Federais (JEF):** etapas com prefixo "[JEF]" no nome.',
    '- **Execução Fiscal:** etapas relacionadas à cobrança da Fazenda Pública.',
    '- **Cível e Criminal Comum:** etapas das varas comuns federais.',
    '- **Etapas compartilhadas:** valem para qualquer pista (ex.: elaboração de despacho, sentença, comunicação).',
    '',
    '## Etapas mapeadas',
    ''
  ];
  for (const f of cat.fluxos) {
    const nomeLimpo = limparNomeParaUsuario(f.nome);
    const seguintes = f.subfluxosChamados
      .map((s) => {
        const destino = cat.fluxos.find((x) => x.codigo === s.codigo);
        return destino ? limparNomeParaUsuario(destino.nome) : null;
      })
      .filter((x): x is string => Boolean(x));
    const seguintesStr = seguintes.length ? seguintes.slice(0, 6).join('; ') : 'fim da cadeia';
    linhas.push(
      `- **${nomeLimpo}** _(código interno: ${f.codigo})_ → ${seguintesStr}`
    );
  }
  return linhas.join('\n');
}

/** Remove "[JEF] ", "[EF] " e similares para deixar o nome humano. */
function limparNomeParaUsuario(nome: string): string {
  return nome
    .replace(/^\s*\[(?:JEF|EF|COMUM)\]\s*/i, '')
    .replace(/_+/g, ' ')
    .trim();
}

/**
 * Recarrega o catálogo do disco. Útil em cenários de hot-reload em dev.
 * Em produção, o cache persiste durante a sessão da página.
 */
export function invalidarCache(): void {
  _catalogoCache = null;
  _indicePorCodigo = null;
}
