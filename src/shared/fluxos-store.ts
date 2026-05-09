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
 * Resumo do catálogo para o modo DEV — TAREFA HUMANA como unidade
 * primária (FLUX-17 / decisão owner em 2026-05-07: "pouco importa os
 * nomes dos fluxos e subfluxos, o que importa é o que o usuário vê").
 *
 * Cada linha do resumo é UMA TAREFA. O fluxo (etapa container) e o
 * código jBPM aparecem entre parênteses para o desenvolvedor poder
 * navegar a topologia. Tarefas sem swimlane (~76) e nós de desvio
 * (~134) ficam de fora — não são tarefas que aparecem na fila do PJe.
 */
export async function getResumoParaPrompt(): Promise<string> {
  const cat = await getCatalogo();
  const tarefas = extrairTarefasHumanas(cat);
  const linhas = [
    '# Catálogo de tarefas humanas do PJe (resumo técnico)',
    `Total: ${tarefas.length} tarefas em ${cat.totalFluxos} fluxos.`,
    '',
    '> Cada item abaixo é uma TAREFA HUMANA — um nome que aparece na fila',
    '> de trabalho do servidor no PJe. O fluxo container (etapa) e o',
    '> código jBPM aparecem entre parênteses para rastreamento técnico.',
    ''
  ];
  for (const t of tarefas) {
    const proximas = t.transicoes.length
      ? t.transicoes.map((tr) => tr.nome || tr.para).slice(0, 6).join('; ')
      : '—';
    linhas.push(
      `- **${t.nome}**  _(responsável: ${t.swimlane} · lane ${t.lane} · fase ${t.fase})_` +
        `\n  fluxo container: ${t.fluxoNome} \`${t.fluxoCodigo}\`` +
        `\n  saídas possíveis: ${proximas}`
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
/**
 * Resumo do catálogo para o modo USUÁRIO — TAREFA HUMANA como
 * unidade primária. O servidor vê tarefas na fila do PJe; ele NÃO
 * vê fluxos. Aqui o LLM trabalha em cima das mesmas tarefas que ele.
 *
 * O conceito de "etapa/fluxo" é apresentado apenas como rotina
 * sistêmica que agrupa tarefas relacionadas, sem código nem nome
 * jBPM. Códigos NUNCA aparecem para o usuário (decisão owner: "Os
 * nomes dos fluxos vamos deixar para o acesso dos desenvolvedores").
 */
export async function getResumoParaPromptUsuario(): Promise<string> {
  const cat = await getCatalogo();
  const tarefas = extrairTarefasHumanas(cat);
  const linhas = [
    '# Mapa das tarefas do PJe (versão para usuário final)',
    `Total: ${tarefas.length} tarefas humanas mapeadas.`,
    '',
    '> **Importante:** cada item abaixo é uma TAREFA — um nome que aparece',
    '> exatamente como na fila de trabalho do servidor no PJe (exemplo:',
    '> "[JEF] Analisar inicial", "[JEF] Ato do magistrado - Despacho").',
    '> Você (assistente) DEVE referenciar a tarefa por esse NOME OFICIAL,',
    '> com prefixo entre colchetes, sem aspas e sem markdown.',
    '>',
    '> NÃO mencione códigos de fluxo (JEF, JEF_OPPER, EF_PERICIA, etc.) —',
    '> esses são identificadores internos do sistema, invisíveis para o',
    '> usuário. Se o usuário pedir contexto ("de onde vem essa tarefa"),',
    '> descreva a rotina em palavras (ex.: "rotina de análise da',
    '> secretaria") sem citar código.',
    '',
    '## Pistas processuais',
    '',
    '- **JEF (Juizados Especiais Federais):** tarefas com prefixo "[JEF]".',
    '- **EF (Execução Fiscal):** tarefas com prefixo "[EF]" ou ligadas a cobrança.',
    '- **Cível e Criminal:** tarefas das varas comuns federais (sem prefixo, ou com prefixos como [PREVJUD]).',
    '- **Compartilhadas:** valem para qualquer pista (ex.: elaboração de comunicação genérica).',
    '',
    '## Tarefas mapeadas',
    ''
  ];
  for (const t of tarefas) {
    const proximas = t.transicoes.length
      ? t.transicoes.map((tr) => limparNomeTransicao(tr.nome || tr.para)).slice(0, 6).join('; ')
      : 'finaliza a rotina';
    linhas.push(
      `- **${t.nome}** _(responsável: ${t.swimlane})_` +
        `\n  saídas possíveis: ${proximas}`
    );
  }
  return linhas.join('\n');
}

/**
 * Extrai a lista plana de tarefas humanas do catálogo, aplicando o
 * mesmo critério validado em 2026-05-07: tem swimlane + não começa
 * com "Nó de Desvio". Resultado: ~583 tarefas no catálogo atual.
 *
 * Nota: NÃO filtrar por `endTasks: true` — em jPDL 3.2 esse atributo
 * é o comportamento padrão de task-nodes humanas (ver tarefas-indice.ts).
 */
interface TarefaResumo {
  nome: string;
  fluxoCodigo: string;
  fluxoNome: string;
  lane: string;
  fase: string;
  swimlane: string;
  transicoes: Array<{ nome: string; para: string }>;
}
function extrairTarefasHumanas(cat: CatalogoFluxos): TarefaResumo[] {
  const lista: TarefaResumo[] = [];
  for (const f of cat.fluxos) {
    for (const tn of f.taskNodes ?? []) {
      const swim = tn.tasks?.find((t) => t.swimlane)?.swimlane ?? '';
      if (!swim) continue;
      if (/^N. de Desvio/i.test(tn.nome)) continue;
      lista.push({
        nome: nomeOficialDaTarefa(tn.nome),
        fluxoCodigo: f.codigo,
        fluxoNome: f.nome,
        lane: f.lane,
        fase: f.fase,
        swimlane: swim,
        transicoes: tn.transicoes ?? []
      });
    }
  }
  // Ordena por nome para o LLM achar mais rápido por busca textual.
  lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return lista;
}

/**
 * Limpa nomes de transição que vêm com prefixo "Incluir no fluxo de"
 * (jBPM technicalese) ou códigos jBPM. Usado no resumo do modo usuário.
 */
function limparNomeTransicao(nome: string): string {
  return nome
    .replace(/^Incluir no fluxo de\s+/i, '')
    .replace(/_+/g, ' ')
    .trim();
}

/**
 * Retorna o nome OFICIAL da tarefa, exatamente como aparece na tela do PJe
 * para o servidor — incluindo o prefixo entre colchetes ("[JEF] Análise
 * inicial"). Diferente de uma versão "humanizada", esta preserva o prefixo
 * porque é a pista que o usuário usa para casar o que o consultor diz com
 * o que ele vê na tela. Apenas higieniza espaços extras e underscores
 * literais que possam ter vindo do XML do fluxo.
 */
function nomeOficialDaTarefa(nome: string): string {
  return nome.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Recarrega o catálogo do disco. Útil em cenários de hot-reload em dev.
 * Em produção, o cache persiste durante a sessão da página.
 */
export function invalidarCache(): void {
  _catalogoCache = null;
  _indicePorCodigo = null;
}
