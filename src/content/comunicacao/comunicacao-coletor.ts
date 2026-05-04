/**
 * Coletor da "Central de Comunicação" (perfil Secretaria).
 *
 * Roda no top frame do PJe legacy, mesmo padrão do `pericias-coletor.ts`.
 * Suporta dois modos de cobrança e dois filtros (tarefa-padrão ou
 * etiqueta configurada pelo usuário). O resultado é um conjunto enxuto
 * de processos (`ComunicacaoProcesso[]`) — o painel monta as mensagens
 * e os botões de disparo.
 *
 * Modo `cobrar-perito`:
 *   - Filtro `tarefa`: lista todas as tarefas do painel e filtra as que
 *     contêm "Cobrar laudo" (regex em `comunicacao-store.ts`); para cada
 *     tarefa, lista os processos pendentes via `listarProcessosDaTarefa`.
 *   - Filtro `etiqueta`: usa `etiquetaCobrancaPerito` das settings;
 *     varre TODAS as tarefas do painel e devolve apenas processos cuja
 *     lista de etiquetas contenha o nome configurado (case-insensitive).
 *   - Em ambos, tenta inferir o perito a partir das etiquetas existentes
 *     no processo (formato "DR/DRA/AS NOME DD.MM.AA").
 *
 * Modo `cobrar-ceab`:
 *   - Filtro `tarefa`: tarefas que contêm "Obrigação de fazer - Sem
 *     manifestação".
 *   - Filtro `etiqueta`: usa `etiquetaCobrancaCeab` das settings.
 *   - Não infere perito (peritoNomeInferido = null).
 *
 * O canal (WhatsApp ou e-mail) NÃO afeta a coleta — o painel decide qual
 * mensagem montar e qual contato usar a partir do mesmo `ComunicacaoColetaResult`.
 */

import { LOG_PREFIX } from '../../shared/constants';
import {
  isTarefaCobrarLaudo,
  isTarefaObrigacaoFazerCeab
} from '../../shared/comunicacao-store';
import type {
  ComunicacaoColetaResult,
  ComunicacaoFiltro,
  ComunicacaoModo,
  ComunicacaoProcesso,
  ComunicacaoSettings,
  PericiaPerito,
  PJeApiProcesso
} from '../../shared/types';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';
import {
  listarProcessosDaTarefa,
  montarUrlAutos
} from '../pje-api/pje-api-from-content';

export interface ColetorComunicacaoInput {
  modo: ComunicacaoModo;
  filtro: ComunicacaoFiltro;
  legacyOrigin: string;
  settings: ComunicacaoSettings;
  /** Snapshot dos peritos cadastrados (para inferir peritoId/Nome). */
  peritos: PericiaPerito[];
  onProgress?: (msg: string) => void;
}

interface ItemComTarefa {
  tarefaNome: string;
  processo: PJeApiProcesso;
}

const LOG = `${LOG_PREFIX} [comunicacao-coletor]`;

export async function coletarComunicacao(
  input: ColetorComunicacaoInput
): Promise<ComunicacaoColetaResult> {
  const progress = input.onProgress ?? (() => {});
  const avisos: string[] = [];

  // --- 1. Resolver lista de tarefas a varrer ---
  progress('Listando tarefas do painel do PJe...');
  const respTarefas = await listarTarefasDoPainel();
  if (!respTarefas.ok) {
    return {
      ok: false,
      modo: input.modo,
      filtro: input.filtro,
      total: 0,
      processos: [],
      avisos,
      error:
        respTarefas.error ?? 'Não foi possível listar as tarefas do painel.'
    };
  }
  const tarefas = respTarefas.tarefas.map((t) => t.nome);

  let nomesAlvo: string[];
  let etiquetaAlvo: string | null = null;
  if (input.filtro === 'etiqueta') {
    const etq =
      input.modo === 'cobrar-perito'
        ? input.settings.etiquetaCobrancaPerito
        : input.settings.etiquetaCobrancaCeab;
    const trimmed = (etq ?? '').trim();
    if (!trimmed) {
      return {
        ok: false,
        modo: input.modo,
        filtro: input.filtro,
        total: 0,
        processos: [],
        avisos,
        error:
          'Nenhuma etiqueta configurada para este modo. Cadastre nas configurações ' +
          'da Central de Comunicação antes de usar o filtro por etiqueta.'
      };
    }
    etiquetaAlvo = trimmed;
    // No modo etiqueta, varremos TODAS as tarefas do painel para garantir
    // que nenhum processo etiquetado fique de fora (a etiqueta substitui
    // a tarefa-alvo, conforme alinhamento com o usuário).
    nomesAlvo = tarefas.slice();
  } else {
    const filtroFn =
      input.modo === 'cobrar-perito'
        ? isTarefaCobrarLaudo
        : isTarefaObrigacaoFazerCeab;
    nomesAlvo = tarefas.filter(filtroFn);
    if (nomesAlvo.length === 0) {
      return {
        ok: false,
        modo: input.modo,
        filtro: input.filtro,
        total: 0,
        processos: [],
        avisos,
        error:
          input.modo === 'cobrar-perito'
            ? 'Nenhuma tarefa contendo "Cobrar laudo" foi encontrada no painel.'
            : 'Nenhuma tarefa contendo "Obrigação de fazer - Sem manifestação" foi encontrada no painel.'
      };
    }
  }

  // --- 2. Listar processos das tarefas selecionadas ---
  const todos: ItemComTarefa[] = [];
  for (const nome of nomesAlvo) {
    progress(`[listar] tarefa "${nome}"...`);
    const r = await listarProcessosDaTarefa({ nomeTarefa: nome });
    if (!r.ok) {
      avisos.push(`Falha ao listar "${nome}": ${r.error ?? 'erro'}`);
      continue;
    }
    for (const p of r.processos) {
      todos.push({ tarefaNome: nome, processo: p });
    }
    progress(
      `[listar] "${nome}": ${r.processos.length}/${r.total} processo(s).`
    );
  }

  // Dedup por idProcesso (mesmo processo pode existir em duas tarefas no
  // modo etiqueta — manter a primeira ocorrência).
  const porId = new Map<number, ItemComTarefa>();
  for (const item of todos) {
    if (item.processo.idProcesso <= 0) continue;
    if (!porId.has(item.processo.idProcesso)) {
      porId.set(item.processo.idProcesso, item);
    }
  }

  // No modo etiqueta, filtra SOMENTE os que tiverem a etiqueta-alvo.
  let unicos = Array.from(porId.values());
  if (etiquetaAlvo) {
    const alvoNorm = etiquetaAlvo.toLowerCase().trim();
    unicos = unicos.filter((it) =>
      it.processo.etiquetas.some((e) => e.trim().toLowerCase() === alvoNorm)
    );
  }
  if (unicos.length === 0) {
    return {
      ok: true,
      modo: input.modo,
      filtro: input.filtro,
      total: 0,
      processos: [],
      avisos
    };
  }

  // --- 3. Inferir perito a partir das etiquetas-pauta (modo WhatsApp) ---
  // O cadastro de cada perito tem `nomeEtiquetaPauta` em uppercase. As
  // etiquetas de pauta aplicadas seguem o formato:
  //   "DR FULANO DD.MM.AA" / "DRA FULANA DD.MM.AA" / "AS FULANA DD.MM.AA"
  // Cobramos: para cada processo, achar a etiqueta que casa com o
  // padrão e bater o nome contra os peritos cadastrados.
  const indicePeritos = construirIndicePeritos(input.peritos);
  const inferirPerito =
    input.modo === 'cobrar-perito'
      ? (etiquetas: string[]): { id: string | null; nome: string | null } =>
          inferirPeritoPorEtiquetas(etiquetas, indicePeritos)
      : (): { id: string | null; nome: string | null } => ({
          id: null,
          nome: null
        });

  const processos: ComunicacaoProcesso[] = [];
  for (const item of unicos) {
    const p = item.processo;
    const inf = inferirPerito(p.etiquetas);
    processos.push({
      idProcesso: p.idProcesso,
      numeroProcesso: p.numeroProcesso,
      idTaskInstance: p.idTaskInstance,
      classeJudicial: p.classeJudicial,
      poloAtivo: p.poloAtivo,
      tarefaNome: item.tarefaNome,
      url: null,
      etiquetas: Array.isArray(p.etiquetas) ? [...p.etiquetas] : [],
      peritoNomeInferido: inf.nome,
      peritoId: inf.id
    });
  }

  // Aviso quando, no modo perito, sobraram processos sem inferência.
  if (input.modo === 'cobrar-perito') {
    const sem = processos.filter((p) => !p.peritoId).length;
    if (sem > 0) {
      avisos.push(
        `${sem} processo(s) sem perito identificável pelas etiquetas — ` +
          `confira o cadastro de peritos ou as etiquetas-pauta dos autos.`
      );
    }
    // Peritos cadastrados sem nenhum contato (nem WhatsApp, nem e-mail)
    // ficam impossíveis de cobrar pelos atalhos. Listá-los ajuda o
    // usuário a perceber falhas no cadastro antes de gerar a mensagem.
    const peritosSemContato = input.peritos
      .filter(
        (p) =>
          p.ativo &&
          !(p.telefone && p.telefone.trim()) &&
          !(p.email && p.email.trim())
      )
      .map((p) => p.nomeCompleto);
    if (peritosSemContato.length > 0) {
      avisos.push(
        `Peritos ativos sem WhatsApp nem e-mail cadastrado: ${peritosSemContato.join(', ')}.`
      );
    }
  }

  // --- 4. Resolver URLs dos autos (best-effort) ---
  progress(`[url] resolvendo links de ${processos.length} processo(s)...`);
  for (let i = 0; i < processos.length; i++) {
    const item = processos[i];
    try {
      const r = await montarUrlAutos({
        legacyOrigin: input.legacyOrigin,
        idProcesso: item.idProcesso,
        idTaskInstance: item.idTaskInstance
      });
      if (r.ok && r.url) item.url = r.url;
    } catch (err) {
      console.warn(
        `${LOG} falha ao resolver URL do processo ${item.idProcesso}:`,
        err
      );
    }
    if ((i + 1) % 10 === 0 || i === processos.length - 1) {
      progress(`[url] ${i + 1}/${processos.length}`);
    }
  }

  return {
    ok: true,
    modo: input.modo,
    filtro: input.filtro,
    total: processos.length,
    processos,
    avisos
  };
}

// =====================================================================
// Inferência de perito por etiquetas-pauta
// =====================================================================

interface IndicePeritos {
  /** Mapa nomeEtiquetaPauta normalizado → perito. */
  porNomeEtiqueta: Map<string, PericiaPerito>;
}

function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function construirIndicePeritos(peritos: PericiaPerito[]): IndicePeritos {
  const porNomeEtiqueta = new Map<string, PericiaPerito>();
  for (const p of peritos) {
    if (!p.ativo) continue;
    const k = normalizar(p.nomeEtiquetaPauta);
    if (k) porNomeEtiqueta.set(k, p);
  }
  return { porNomeEtiqueta };
}

/**
 * Tenta extrair o nome do perito a partir de uma etiqueta-pauta.
 * Aceita prefixos:
 *   - "DR FULANO DD.MM.AA"
 *   - "DRA FULANA DD.MM.AA"
 *   - "AS FULANA DD.MM.AA"
 * Devolve `null` quando o formato não casa.
 */
function extrairNomeDeEtiquetaPauta(etiqueta: string): string | null {
  const m = etiqueta.match(
    /^(DR\.?A?|AS)\s+(.+?)\s+\d{2}\.\d{2}\.\d{2,4}\s*$/i
  );
  if (!m) return null;
  return normalizar(m[2]);
}

function inferirPeritoPorEtiquetas(
  etiquetas: string[],
  indice: IndicePeritos
): { id: string | null; nome: string | null } {
  for (const e of etiquetas) {
    const nome = extrairNomeDeEtiquetaPauta(e);
    if (!nome) continue;
    const perito = indice.porNomeEtiqueta.get(nome);
    if (perito) {
      return { id: perito.id, nome: perito.nomeCompleto };
    }
    // Sem cadastro batido — devolve apenas o nome textualmente. O painel
    // pode mostrar como "perito não cadastrado" e ainda assim deixar o
    // usuário cobrar manualmente (sem o atalho do WhatsApp).
    return { id: null, nome: nome };
  }
  return { id: null, nome: null };
}
