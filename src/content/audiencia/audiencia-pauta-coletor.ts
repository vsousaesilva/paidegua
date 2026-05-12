/**
 * Coletor da pauta de audiência via endpoint nativo do PJe
 * (`/pje/ProcessoAudiencia/PautaAudiencia/listView.seam`).
 *
 * Usado pela feature "Resumo dos processos da pauta" (AUD-10) — substitui
 * a abordagem de varrer N tarefas do painel + abrir cada processo só para
 * descobrir a data da audiência. Aqui o próprio PJe filtra por período e
 * devolve uma tabela já com tudo: CNJ, partes, classe, tipo, sala,
 * situação e — bônus — o link "Detalhe do processo" com `id` interno e
 * `ca` cifrado, prontos para acessar os autos sem nova autenticação.
 *
 * Padrão JSF/Seam exige um GET inicial para obter o `javax.faces.ViewState`
 * (token vinculado à sessão+página). Reutilizar valor de outra sessão dá
 * `viewExpired`. O coletor faz GET → parse → POST → parse, tudo same-origin
 * a partir do content script (cookies do PJe são incluídos automaticamente).
 *
 * Sem cache: cada chamada é independente. Magistrado pode pedir várias
 * datas seguidas, e a UI não deve servir lista velha (pauta muda durante
 * o dia conforme cancelamentos/redesignações).
 */

import { LOG_PREFIX } from '../../shared/constants';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';
import { listarProcessosDaTarefa } from '../pje-api/pje-api-from-content';

const LOG = `${LOG_PREFIX} [audiencia-pauta-coletor]`;
const ENDPOINT_PATH = '/pje/ProcessoAudiencia/PautaAudiencia/listView.seam';

/**
 * Tarefas-alvo para resolver `idTaskInstance` por processo. O endpoint
 * `listView.seam` devolve apenas `idProcesso + ca`, sem `idTaskInstance`
 * — então não dá pra montar a URL `movimentar.seam?idProcesso=X&newTaskId=Y`
 * direto da pauta. Para suprir, descobrimos dinamicamente todas as tarefas
 * que contêm "Audiência" no nome (via `listarTarefasDoPainel`, lendo o DOM
 * do painel do usuário do PJe), varremos em paralelo via REST
 * (`recuperarProcessosTarefaPendenteComCriterios`) e construímos um
 * Map idProcesso→idTaskInstance que enriquece os itens da pauta.
 *
 * Fallback: quando o painel do usuário não está aberto na aba PJe ativa
 * (caso comum: usuário disparou a feature da própria página
 * `Pauta de audiência`), `listarTarefasDoPainel` devolve lista vazia.
 * Caímos para a lista canônica fixa abaixo — cobre o fluxo padrão JFCE.
 *
 * Caixa REST: `listarProcessosDaTarefa` lista apenas os processos da
 * caixa do usuário logado. Se um processo da pauta não estiver em
 * nenhuma das tarefas varridas, `idTaskInstance` fica `null` e a UI
 * desabilita o botão "abrir tarefa".
 */
const NOMES_TAREFAS_AUDIENCIA_FALLBACK = [
  'Audiência - Aguardar',
  'Audiência - Elaborar ata',
  'Audiência - Do dia',
  'Audiência - Minutar ata'
] as const;

const REGEX_TAREFA_AUDIENCIA = /audi[eê]ncia/i;

/**
 * Códigos das situações de audiência aceitos pelo form do PJe. Ver
 * memória `pje_pauta_audiencia_endpoint`. Atenção: M = Designada (não D),
 * D = Convertida em Diligência. Default da feature é M+R (Designada +
 * Redesignada) — audiências futuras + remarcadas.
 */
export type AudienciaSituacaoCodigo = 'M' | 'C' | 'R' | 'F' | 'N' | 'D';

export interface AudienciaPautaItem {
  /** Nº CNJ formatado (NNNNNNN-DD.AAAA.J.TR.OOOO). */
  cnj: string;
  /** Data e hora exibidas pelo PJe (DD/MM/YYYY HH:MM). */
  dataHora: string;
  /** Órgão julgador. */
  orgaoJulgador: string;
  /** Texto do polo ativo (autor), tal como vem antes do `X` na coluna. */
  autor: string;
  /** Texto do polo passivo (réu), tal como vem após o `X`. */
  reu: string;
  /** Texto bruto da coluna Partes (com sufixos "e outros (N)" preservados). */
  partesBrutas: string;
  /** Classe judicial — `NOME (codigo)`. */
  classe: string;
  /** Tipo de audiência (Instrução, Conciliação, …). */
  tipoAudiencia: string;
  /** Sala de audiência. */
  sala: string;
  /** Situação textual ("Designada", "Redesignada", …). */
  situacao: string;
  /** ID interno do processo no PJe (campo `id` do link de detalhe). */
  idProcesso: number;
  /** Token cifrado de acesso aos autos (campo `ca` do link de detalhe). */
  ca: string;
  /** URL absoluta para abrir o detalhe do processo (já com id+ca). */
  urlDetalhe: string;
  /**
   * `idTaskInstance` resolvido pela varredura paralela das tarefas de
   * audiência. `null` quando o processo não está em nenhuma das 4
   * tarefas conhecidas na caixa do usuário (e por isso o botão "abrir
   * tarefa" fica desabilitado na UI).
   */
  idTaskInstance: number | null;
}

export interface ColetarPautaInput {
  /** Origin do PJe (ex.: `https://pje1g.trf5.jus.br`). */
  legacyOrigin: string;
  /** Data inicial DD/MM/YYYY. */
  dataDe: string;
  /** Data final DD/MM/YYYY (igual a `dataDe` para um único dia). */
  dataAte: string;
  /**
   * Situações marcadas. Default sugerido pela feature é `['M', 'R']`
   * (Designada + Redesignada).
   */
  situacoes: AudienciaSituacaoCodigo[];
  /**
   * IDs de jurisdição e órgão julgador. Quando ausentes, são lidos do
   * próprio form (PJe pré-preenche com os valores da sessão do magistrado).
   */
  jurisdicaoId?: number;
  orgaoJulgadorId?: number;
  /**
   * Lista de nomes de tarefas a varrer para resolver `idTaskInstance`
   * por processo. Default: `NOMES_TAREFAS_AUDIENCIA_DEFAULT`.
   */
  nomesTarefasResolverIdTask?: string[];
}

export interface ColetarPautaResult {
  ok: boolean;
  itens?: AudienciaPautaItem[];
  /** Total informado pelo PJe ("N resultados encontrados") — pode diferir de `itens.length` em caso de paginação futura. */
  totalInformado?: number;
  error?: string;
}

/**
 * Faz GET → parseia ViewState e defaults → POST com filtros → parseia
 * tabela de resultados. Same-origin: precisa rodar no content script ou
 * em página da extensão com permissões para o domínio do PJe.
 */
export async function coletarPautaPorPeriodo(
  input: ColetarPautaInput
): Promise<ColetarPautaResult> {
  if (!input.dataDe || !input.dataAte) {
    return { ok: false, error: 'Período (de/até) é obrigatório.' };
  }
  if (!input.situacoes || input.situacoes.length === 0) {
    return { ok: false, error: 'Marque ao menos uma situação de audiência.' };
  }

  const url = `${input.legacyOrigin.replace(/\/$/, '')}${ENDPOINT_PATH}`;

  // 1. GET inicial para extrair ViewState e defaults da sessão.
  let initialHtml: string;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} no GET inicial da pauta.` };
    }
    initialHtml = await resp.text();
  } catch (err) {
    console.warn(`${LOG} GET inicial falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  if (detectarSessaoExpirada(initialHtml)) {
    return { ok: false, error: 'Sessão do PJe expirada. Faça login novamente.' };
  }

  const viewState = extrairViewState(initialHtml);
  if (!viewState) {
    return {
      ok: false,
      error: 'ViewState não encontrado no HTML inicial — layout do PJe pode ter mudado.'
    };
  }
  const defaultsForm = extrairDefaultsForm(initialHtml);
  const jurisdicao = input.jurisdicaoId ?? defaultsForm.jurisdicaoId;
  const orgao = input.orgaoJulgadorId ?? defaultsForm.orgaoJulgadorId;
  if (!jurisdicao || !orgao) {
    return {
      ok: false,
      error: 'Jurisdição/Órgão julgador não pré-preenchidos pela sessão.'
    };
  }

  // 2. POST com os filtros do magistrado.
  const body = montarBodySearch({
    viewState,
    jurisdicaoId: jurisdicao,
    orgaoJulgadorId: orgao,
    dataDe: input.dataDe,
    dataAte: input.dataAte,
    situacoes: input.situacoes
  });

  let respHtml: string;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: '*/*'
      },
      body
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} no POST da pesquisa.` };
    }
    respHtml = await resp.text();
  } catch (err) {
    console.warn(`${LOG} POST falhou:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  if (detectarSessaoExpirada(respHtml)) {
    return { ok: false, error: 'Sessão do PJe expirada. Faça login novamente.' };
  }

  const parsed = parsearTabelaPauta(respHtml, input.legacyOrigin);

  // Enriquecimento: resolver `idTaskInstance` por processo varrendo em
  // paralelo todas as tarefas que contenham "Audiência" no nome. Se a
  // varredura falhar por completo (sem snapshot, painel não aberto, etc.),
  // os itens ficam com `idTaskInstance: null` e a UI desabilita o botão.
  const nomesTarefas =
    input.nomesTarefasResolverIdTask ?? (await descobrirTarefasDeAudiencia());
  const mapaIdTask = await resolverIdTaskInstancePorProcesso(nomesTarefas);
  for (const item of parsed.itens) {
    item.idTaskInstance = mapaIdTask.get(item.idProcesso) ?? null;
  }

  return {
    ok: true,
    itens: parsed.itens,
    totalInformado: parsed.totalInformado ?? undefined
  };
}

/**
 * Descobre dinamicamente os nomes das tarefas de audiência presentes no
 * painel do usuário (qualquer tarefa cujo nome contenha "Audiência",
 * acento-tolerante). Quando o painel não está aberto na aba PJe ativa
 * — `listarTarefasDoPainel` retorna `[]` — cai para a lista canônica
 * `NOMES_TAREFAS_AUDIENCIA_FALLBACK`.
 */
async function descobrirTarefasDeAudiencia(): Promise<string[]> {
  try {
    const r = await listarTarefasDoPainel();
    if (r.ok && r.tarefas.length > 0) {
      const nomes = r.tarefas
        .map((t) => t.nome)
        .filter((n) => REGEX_TAREFA_AUDIENCIA.test(n));
      if (nomes.length > 0) {
        console.info(
          `${LOG} descobriu ${nomes.length} tarefa(s) de audiência no painel: ${nomes.join(' | ')}`
        );
        return nomes;
      }
    }
  } catch (err) {
    console.warn(`${LOG} listarTarefasDoPainel falhou:`, err);
  }
  console.info(
    `${LOG} caindo para lista de fallback (${NOMES_TAREFAS_AUDIENCIA_FALLBACK.length} tarefas).`
  );
  return [...NOMES_TAREFAS_AUDIENCIA_FALLBACK];
}

/**
 * Para cada nome de tarefa em `nomes`, dispara em paralelo
 * `listarProcessosDaTarefa` e consolida `idProcesso → idTaskInstance`
 * em um único Map. Tolerante a falhas: se uma tarefa específica falhar
 * (não existe na caixa, sem snapshot, etc.), ignora silenciosamente
 * e segue com as demais. Retorna Map vazio se todas falharem.
 */
async function resolverIdTaskInstancePorProcesso(
  nomes: string[]
): Promise<Map<number, number>> {
  const mapa = new Map<number, number>();
  if (nomes.length === 0) return mapa;
  const resultados = await Promise.allSettled(
    nomes.map((nomeTarefa) =>
      listarProcessosDaTarefa({
        nomeTarefa,
        pageSize: 1000,
        maxProcessos: 5000
      })
    )
  );
  for (const r of resultados) {
    if (r.status !== 'fulfilled') continue;
    if (!r.value.ok) continue;
    for (const proc of r.value.processos) {
      if (proc.idTaskInstance != null && proc.idProcesso > 0) {
        // Prioriza o primeiro encontrado — em caso de duplicidade entre
        // tarefas (improvável), mantém o já mapeado.
        if (!mapa.has(proc.idProcesso)) {
          mapa.set(proc.idProcesso, proc.idTaskInstance);
        }
      }
    }
  }
  console.info(
    `${LOG} resolveu idTaskInstance para ${mapa.size} processo(s) varrendo ${nomes.length} tarefa(s).`
  );
  return mapa;
}

function extrairViewState(html: string): string | null {
  const m = html.match(
    /<input[^>]+name="javax\.faces\.ViewState"[^>]+value="([^"]+)"/i
  );
  return m ? m[1] : null;
}

interface DefaultsForm {
  jurisdicaoId: number | null;
  orgaoJulgadorId: number | null;
}

function extrairDefaultsForm(html: string): DefaultsForm {
  return {
    jurisdicaoId: extrairOptionSelected(
      html,
      'processoAudienciaSearchForm:jurisdicaoDecoration:jurisdicao'
    ),
    orgaoJulgadorId: extrairOptionSelected(
      html,
      'processoAudienciaSearchForm:orgaoJulgadorDecoration:orgaoJulgador'
    )
  };
}

function extrairOptionSelected(html: string, selectId: string): number | null {
  const idEsc = selectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reSelect = new RegExp(
    `<select[^>]+id="${idEsc}"[^>]*>([\\s\\S]*?)<\\/select>`,
    'i'
  );
  const block = html.match(reSelect);
  if (!block) return null;
  const reOption = /<option[^>]+value="(\d+)"[^>]*selected="selected"/i;
  const opt = block[1].match(reOption);
  if (!opt) return null;
  const n = Number.parseInt(opt[1], 10);
  return Number.isFinite(n) ? n : null;
}

function detectarSessaoExpirada(html: string): boolean {
  return (
    html.includes('viewExpired') ||
    html.includes('Sua sessão expirou') ||
    /location\.replace\(['"][^'"]*\/login\.seam/i.test(html)
  );
}

interface BodySearchInput {
  viewState: string;
  jurisdicaoId: number;
  orgaoJulgadorId: number;
  dataDe: string;
  dataAte: string;
  situacoes: AudienciaSituacaoCodigo[];
}

function montarBodySearch(i: BodySearchInput): string {
  const params = new URLSearchParams();
  params.append(
    'AJAXREQUEST',
    'processoAudienciaSearchForm:j_id146'
  );
  params.append(
    'processoAudienciaSearchForm:jurisdicaoDecoration:jurisdicao',
    String(i.jurisdicaoId)
  );
  params.append(
    'processoAudienciaSearchForm:orgaoJulgadorDecoration:orgaoJulgador',
    String(i.orgaoJulgadorId)
  );
  params.append('processoAudienciaSearchForm:magistradoDecoration:magistrado', '');
  params.append('processoAudienciaSearchForm:conciliadorDecoration:conciliador', '');
  for (const s of i.situacoes) {
    params.append('processoAudienciaSearchForm:listaSituacoes', s);
  }
  const mesAno = i.dataDe.slice(3); // MM/YYYY
  params.append(
    'processoAudienciaSearchForm:dtInicioDecoration:dtInicioFromFormInputDate',
    i.dataDe
  );
  params.append(
    'processoAudienciaSearchForm:dtInicioDecoration:dtInicioFromFormInputCurrentDate',
    mesAno
  );
  params.append(
    'processoAudienciaSearchForm:dtInicioDecoration:dtInicioToFormInputDate',
    i.dataAte
  );
  params.append(
    'processoAudienciaSearchForm:dtInicioDecoration:dtInicioToFormInputCurrentDate',
    i.dataAte.slice(3)
  );
  params.append(
    'processoAudienciaSearchForm:tipoAudienciaDecoration:tipoAudiencia',
    'org.jboss.seam.ui.NoSelectionConverter.noSelectionValue'
  );
  params.append(
    'processoAudienciaSearchForm:salaAudienciaDecoration:salaAudiencia',
    'org.jboss.seam.ui.NoSelectionConverter.noSelectionValue'
  );
  params.append('processoAudienciaSearchForm:parteDecoration:parte', '');
  params.append('processoAudienciaSearchForm:nomeAdvogadoDecoration:nomeAdvogado', '');
  params.append(
    'processoAudienciaSearchForm:processoAudienciaSearchFormclasseJudicialTreeDecoration:processoAudienciaSearchFormclasseJudicialPanel',
    ''
  );
  params.append(
    'processoAudienciaSearchForm:processoAudienciaSearchFormclasseJudicialTreeDecoration:processoAudienciaSearchFormclasseJudicialTree:input',
    ''
  );
  params.append(
    'processoAudienciaSearchForm:processoAudienciaSearchFormassuntoTrfTreeDecoration:processoAudienciaSearchFormassuntoTrfPanel',
    ''
  );
  params.append(
    'processoAudienciaSearchForm:processoAudienciaSearchFormassuntoTrfTreeDecoration:processoAudienciaSearchFormassuntoTrfTree:input',
    ''
  );
  params.append(
    'processoAudienciaSearchForm:idProcessoAudienciaDecoration:idProcessoAudienciaNumeroSequencial',
    ''
  );
  params.append(
    'processoAudienciaSearchForm:idProcessoAudienciaDecoration:idProcessoAudienciaNumeroDigitoVerificador',
    ''
  );
  params.append(
    'processoAudienciaSearchForm:idProcessoAudienciaDecoration:idProcessoAudienciaAno',
    ''
  );
  params.append(
    'processoAudienciaSearchForm:idProcessoAudienciaDecoration:labelJusticaFederal',
    '4'
  );
  params.append(
    'processoAudienciaSearchForm:idProcessoAudienciaDecoration:labelTribunalRespectivo',
    '05'
  );
  params.append(
    'processoAudienciaSearchForm:idProcessoAudienciaDecoration:idProcessoAudienciaNumeroOrgaoJustica',
    ''
  );
  params.append(
    'processoAudienciaSearchForm_link_hidden_',
    'processoAudienciaSearchForm:clearButton'
  );
  params.append('processoAudienciaSearchForm', 'processoAudienciaSearchForm');
  params.append('autoScroll', '');
  params.append('javax.faces.ViewState', i.viewState);
  params.append(
    'processoAudienciaSearchForm:searchButton',
    'processoAudienciaSearchForm:searchButton'
  );
  params.append('processoAudienciaSearchForm:j_id329', '1');
  params.append('AJAX:EVENTS_COUNT', '1');
  return params.toString();
}

interface ParseResult {
  itens: AudienciaPautaItem[];
  totalInformado: number | null;
}

function parsearTabelaPauta(html: string, legacyOrigin: string): ParseResult {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tabela = doc.querySelector('table#idProcessoAudiencia');
  if (!tabela) {
    return { itens: [], totalInformado: 0 };
  }
  const linhas = Array.from(tabela.querySelectorAll('tbody > tr.rich-table-row'));
  const itens: AudienciaPautaItem[] = [];
  for (const tr of linhas) {
    const item = parsearLinha(tr, legacyOrigin);
    if (item) itens.push(item);
  }
  const total = parsearTotal(doc);
  return { itens, totalInformado: total };
}

function parsearLinha(
  tr: Element,
  legacyOrigin: string
): AudienciaPautaItem | null {
  const cells = Array.from(tr.querySelectorAll(':scope > td.rich-table-cell'));
  if (cells.length < 9) return null;
  const linkAcao = cells[0].querySelector(
    'a[href*="listProcessoCompleto"]'
  ) as HTMLAnchorElement | null;
  if (!linkAcao) return null;
  const href = linkAcao.getAttribute('href') ?? '';
  const idMatch = href.match(/[?&]id=(\d+)/);
  const caMatch = href.match(/[?&]ca=([^&#]+)/);
  if (!idMatch || !caMatch) return null;
  const idProcesso = Number.parseInt(idMatch[1], 10);
  const ca = caMatch[1];
  const urlDetalhe = href.startsWith('http')
    ? href
    : `${legacyOrigin.replace(/\/$/, '')}${href.startsWith('/') ? href : `/${href}`}`;

  const textoCelula = (i: number): string => {
    const span = cells[i].querySelector('span.text-left');
    return (span?.textContent ?? cells[i].textContent ?? '').trim().replace(/\s+/g, ' ');
  };

  const partes = parsearPartes(cells[4]);

  return {
    cnj: textoCelula(2),
    dataHora: textoCelula(1),
    orgaoJulgador: textoCelula(3),
    autor: partes.autor,
    reu: partes.reu,
    partesBrutas: partes.brutas,
    classe: textoCelula(5),
    tipoAudiencia: textoCelula(6),
    sala: textoCelula(7),
    situacao: textoCelula(8),
    idProcesso,
    ca,
    urlDetalhe,
    // Preenchido pela varredura paralela de tarefas em coletarPautaPorPeriodo.
    idTaskInstance: null
  };
}

function parsearPartes(cell: Element): { autor: string; reu: string; brutas: string } {
  const span = cell.querySelector('span.text-left');
  if (!span) return { autor: '', reu: '', brutas: '' };
  // Estrutura típica: "AUTOR<br> X<br> RÉU" — usamos innerHTML para
  // separar pelo <br> antes de remover tags.
  const html = span.innerHTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const partes = html
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Esperado: [autor, "X", reu] — mas as vezes "X" vem grudado.
  let autor = '';
  let reu = '';
  if (partes.length >= 3) {
    autor = partes[0];
    reu = partes.slice(2).join(' ');
  } else if (partes.length === 2) {
    autor = partes[0];
    reu = partes[1];
  } else if (partes.length === 1) {
    autor = partes[0];
  }
  const brutas = partes.join(' ').replace(/\s+/g, ' ').trim();
  return { autor, reu, brutas };
}

function parsearTotal(doc: Document): number | null {
  const span = Array.from(doc.querySelectorAll('span.text-muted')).find((el) =>
    /resultados? encontrad/i.test(el.textContent ?? '')
  );
  if (!span) return null;
  const m = (span.textContent ?? '').match(/(\d+)/);
  return m ? Number.parseInt(m[1], 10) : null;
}
