/**
 * Coletor da "Audiência pAIdegua" (perfil Secretaria).
 *
 * Espelha o padrão do `pericias-coletor.ts`:
 *   1. Lista os processos das tarefas que contêm "Audiência - Designar"
 *      (o usuário pode marcar/desmarcar tarefas no painel).
 *   2. Deduplica por idProcesso.
 *   3. Para cada processo, tenta extrair o advogado do `poloAtivo` via
 *      `extrairAdvogadoDoPoloAtivo` (heurística baseada na presença de
 *      "OAB" como documento).
 *   4. Agrupa por advogado, ordena cada grupo por antiguidade na tarefa
 *      e aplica o cap `quantidadePorPauta` por grupo.
 *   5. Resolve URL dos autos para os itens em pauta (best-effort).
 *
 * Limitação conhecida: o `poloAtivo` é uma string achatada pelo normalizador
 * em `pje-api-from-content.ts`. Quando a representação não inclui "OAB",
 * o processo é classificado como "sem advogado identificável" e cai em
 * `naoAgrupados`. Uma evolução futura pode buscar o advogado via endpoint
 * dedicado do PJe (capturado por DevTools) — fora do escopo deste módulo.
 */

import { LOG_PREFIX } from '../../shared/constants';
import {
  chaveAgrupamentoAdvogado,
  extrairAdvogadoDoPoloAtivo,
  isTarefaDesignarAudiencia,
  montarEtiquetaPautaAudiencia
} from '../../shared/audiencia-helpers';
import type {
  AudienciaColetaResult,
  AudienciaPauta,
  AudienciaPautaItem,
  PJeApiProcesso
} from '../../shared/types';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';
import {
  listarProcessosDaTarefa,
  montarUrlAutos
} from '../pje-api/pje-api-from-content';
import {
  escolherAdvogadoAtivo,
  obterPartesDoProcesso
} from '../pje-api/pje-api-partes';

export interface ColetorAudienciaInput {
  legacyOrigin: string;
  /**
   * Nomes das tarefas selecionadas pelo usuário no painel. Default: todas
   * as tarefas que casarem com a regex de "Audiência - Designar" (resolvido
   * pelo coordinator antes de chamar este coletor).
   */
  nomesTarefas: string[];
  /** Quantidade-cap por advogado (mesma para todos os grupos). */
  quantidadePorPauta: number;
  /** Data da audiência (Date local) — usada para montar a etiqueta-pauta. */
  dataAudiencia: Date;
  onProgress?: (msg: string) => void;
}

interface ItemComTarefa {
  tarefaNome: string;
  processo: PJeApiProcesso;
  advogadoNome: string | null;
  advogadoOab: string | null;
}

const LOG = `${LOG_PREFIX} [audiencia-coletor]`;

function antiguidadeMs(p: PJeApiProcesso): number {
  const raw = p.dataChegadaTarefa;
  if (!raw) return Number.MAX_SAFE_INTEGER;
  const trimmed = raw.trim();
  if (!trimmed) return Number.MAX_SAFE_INTEGER;
  if (/^\d{10,}$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const direto = Date.parse(trimmed);
  if (!Number.isNaN(direto)) return direto;
  const m = trimmed.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (m) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
    const t = Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`);
    if (!Number.isNaN(t)) return t;
  }
  return Number.MAX_SAFE_INTEGER;
}

function montarItem(it: ItemComTarefa): AudienciaPautaItem {
  const p = it.processo;
  return {
    idProcesso: p.idProcesso,
    numeroProcesso: p.numeroProcesso,
    idTaskInstance: p.idTaskInstance,
    classeJudicial: p.classeJudicial,
    assuntoPrincipal: p.assuntoPrincipal,
    poloAtivo: p.poloAtivo,
    dataChegadaTarefa: p.dataChegadaTarefa,
    url: null,
    tarefaNome: it.tarefaNome,
    etiquetasProcesso: Array.isArray(p.etiquetas) ? [...p.etiquetas] : []
  };
}

export async function coletarAudienciaPorAdvogado(
  input: ColetorAudienciaInput
): Promise<AudienciaColetaResult> {
  const progress = input.onProgress ?? (() => {});
  const avisos: string[] = [];
  const cap = Math.max(1, Math.min(500, Math.trunc(input.quantidadePorPauta) || 1));

  // --- 1. Validar tarefas pedidas (defesa em profundidade) ---
  const respTarefas = await listarTarefasDoPainel();
  if (!respTarefas.ok) {
    return {
      ok: false,
      tarefasVarridas: [],
      totalVarridos: 0,
      pautas: [],
      naoAgrupados: [],
      dataAudienciaISO: '',
      avisos,
      error: respTarefas.error ?? 'Falha ao listar tarefas do painel.'
    };
  }
  const tarefasDisponiveis = new Set(respTarefas.tarefas.map((t) => t.nome));
  const nomesAlvo = input.nomesTarefas.filter(
    (n) => tarefasDisponiveis.has(n) && isTarefaDesignarAudiencia(n)
  );
  if (nomesAlvo.length === 0) {
    return {
      ok: false,
      tarefasVarridas: [],
      totalVarridos: 0,
      pautas: [],
      naoAgrupados: [],
      dataAudienciaISO: '',
      avisos,
      error:
        'Nenhuma tarefa válida de "Audiência - Designar" foi selecionada — ' +
        'verifique se o painel do PJe está aberto na unidade correta.'
    };
  }

  // --- 2. Listar processos por tarefa (sem advogado ainda) ---
  const todos: ItemComTarefa[] = [];
  for (const nome of nomesAlvo) {
    progress(`[listar] tarefa "${nome}"...`);
    const r = await listarProcessosDaTarefa({ nomeTarefa: nome });
    if (!r.ok) {
      avisos.push(`Falha ao listar "${nome}": ${r.error ?? 'erro'}`);
      continue;
    }
    for (const p of r.processos) {
      todos.push({
        tarefaNome: nome,
        processo: p,
        advogadoNome: null,
        advogadoOab: null
      });
    }
    progress(
      `[listar] "${nome}": ${r.processos.length}/${r.total} processo(s).`
    );
  }

  // Dedup por idProcesso (mesmo processo em múltiplas tarefas).
  const porId = new Map<number, ItemComTarefa>();
  for (const it of todos) {
    if (it.processo.idProcesso <= 0) continue;
    if (!porId.has(it.processo.idProcesso)) porId.set(it.processo.idProcesso, it);
  }
  const unicos = Array.from(porId.values()).sort(
    (a, b) => antiguidadeMs(a.processo) - antiguidadeMs(b.processo)
  );

  // --- 2.5. Enriquecer com nome+OAB do advogado via HTML dos autos ---
  // O `poloAtivo` da REST é uma string achatada; para obter o advogado
  // estruturado, baixamos o HTML de `listAutosDigitais.seam` e parseamos
  // os blocos #poloAtivo/#poloPassivo. Pool de 10 paralelas, cache em
  // memória (ver pje-api-partes.ts).
  await enriquecerComAdvogados(unicos, input.legacyOrigin, progress);

  // Após o fetch, os processos sem advogado identificável são marcados
  // — fallback é o parser heurístico do `poloAtivo` (raramente acerta,
  // mas mantém compatibilidade com instalações sem acesso aos autos).
  let falhasAdvogado = 0;
  for (const it of unicos) {
    if (!it.advogadoNome) {
      const adv = extrairAdvogadoDoPoloAtivo(it.processo.poloAtivo);
      it.advogadoNome = adv.nome;
      it.advogadoOab = adv.oab;
      if (!adv.nome) falhasAdvogado += 1;
    }
  }
  if (falhasAdvogado > 0) {
    avisos.push(
      `${falhasAdvogado} processo(s) sem advogado identificável no polo ativo — ` +
        `verifique se os autos têm advogado cadastrado ou se a sessão do PJe está válida.`
    );
  }

  // --- 3. Agrupar por advogado ---
  const grupos = new Map<
    string,
    { nomeOriginal: string; oab: string | null; itens: ItemComTarefa[] }
  >();
  const semAdvogado: ItemComTarefa[] = [];
  for (const it of unicos) {
    if (!it.advogadoNome) {
      semAdvogado.push(it);
      continue;
    }
    const chave = chaveAgrupamentoAdvogado(it.advogadoNome);
    let g = grupos.get(chave);
    if (!g) {
      g = { nomeOriginal: it.advogadoNome, oab: it.advogadoOab, itens: [] };
      grupos.set(chave, g);
    }
    g.itens.push(it);
  }
  if (semAdvogado.length > 0 && falhasAdvogado === 0) {
    // Caso raro — chegou aqui sem advogadoNome mesmo após enriquecimento.
    // Mantemos o aviso para o usuário enxergar o resíduo na tela.
    avisos.push(
      `${semAdvogado.length} processo(s) ficaram fora do agrupamento.`
    );
  }

  // --- 4. Aplicar cap por grupo, montar pautas ---
  const pautas: AudienciaPauta[] = [];
  const overflow: ItemComTarefa[] = [];
  const etiquetaPauta = montarEtiquetaPautaAudiencia(input.dataAudiencia);
  for (const [, g] of grupos) {
    const itensCap = g.itens.slice(0, cap);
    const sobra = g.itens.slice(cap);
    overflow.push(...sobra);
    pautas.push({
      advogadoNome: chaveAgrupamentoAdvogado(g.nomeOriginal),
      advogadoOab: g.oab,
      etiquetaPauta,
      quantidadePedida: cap,
      quantidadeAtingida: itensCap.length,
      itens: itensCap.map(montarItem)
    });
  }
  // Ordena pautas por advogado (alfabético).
  pautas.sort((a, b) => a.advogadoNome.localeCompare(b.advogadoNome, 'pt-BR'));

  // --- 5. Resolver URLs dos autos (best-effort) ---
  const itensEmPauta = pautas.flatMap((p) => p.itens);
  progress(`[url] resolvendo links de ${itensEmPauta.length} processo(s)...`);
  for (let i = 0; i < itensEmPauta.length; i++) {
    const item = itensEmPauta[i];
    try {
      const r = await montarUrlAutos({
        legacyOrigin: input.legacyOrigin,
        idProcesso: item.idProcesso,
        idTaskInstance: item.idTaskInstance
      });
      if (r.ok && r.url) item.url = r.url;
    } catch (err) {
      console.warn(`${LOG} falha URL ${item.idProcesso}:`, err);
    }
    if ((i + 1) % 10 === 0 || i === itensEmPauta.length - 1) {
      progress(`[url] ${i + 1}/${itensEmPauta.length}`);
    }
  }

  return {
    ok: true,
    tarefasVarridas: nomesAlvo,
    totalVarridos: unicos.length,
    pautas,
    naoAgrupados: [...semAdvogado, ...overflow].map(montarItem),
    dataAudienciaISO: input.dataAudiencia.toISOString(),
    avisos
  };
}

/**
 * Enriquece cada item com nome + OAB do advogado do polo ativo, baixando
 * o HTML de `listAutosDigitais.seam` em paralelo (pool de 10). Mutação
 * direta nos itens — quando o fetch falha, o item permanece sem advogado
 * e o caller cai no fallback heurístico.
 */
async function enriquecerComAdvogados(
  itens: ItemComTarefa[],
  legacyOrigin: string,
  progress: (msg: string) => void
): Promise<void> {
  if (itens.length === 0) return;
  progress(`[advogado] resolvendo advogados em ${itens.length} processo(s)...`);
  const POOL = 10;
  let ok = 0;
  let falhou = 0;
  for (let i = 0; i < itens.length; i += POOL) {
    const batch = itens.slice(i, i + POOL);
    await Promise.all(
      batch.map(async (it) => {
        try {
          const r = await obterPartesDoProcesso({
            idProcesso: it.processo.idProcesso,
            idTaskInstance: it.processo.idTaskInstance,
            legacyOrigin
          });
          if (!r.ok || !r.partes) {
            falhou += 1;
            return;
          }
          const adv = escolherAdvogadoAtivo(r.partes);
          if (adv.nome) {
            it.advogadoNome = adv.nome;
            it.advogadoOab = adv.oab;
            ok += 1;
          } else {
            falhou += 1;
          }
        } catch (err) {
          console.warn(
            `${LOG} falha ao enriquecer advogado de ${it.processo.idProcesso}:`,
            err
          );
          falhou += 1;
        }
      })
    );
    progress(
      `[advogado] ${Math.min(i + POOL, itens.length)}/${itens.length} ` +
        `(ok=${ok}, sem=${falhou})`
    );
  }
}
