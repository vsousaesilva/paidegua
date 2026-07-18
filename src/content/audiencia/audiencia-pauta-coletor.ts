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
 * IMPORTANTE — não voltar a escrever o corpo do POST à mão. A versão
 * original montava os parâmetros com caminhos JSF completos e IDs
 * `j_idNNN` fixos; a atualização de versão do PJe renumerou esses IDs e a
 * busca passou a devolver a página sem tabela, o que a UI exibia como
 * "Nenhum processo encontrado" — falha silenciosa. Hoje o corpo sai da
 * serialização do form real (`serializarForm`) e os campos são resolvidos
 * por sufixo estável (`nomePorSufixo`), com `AJAXREQUEST=_viewRoot` e
 * `X-Requested-With` — mesmo padrão de `prevjud-ssr.ts`.
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

  const docInicial = new DOMParser().parseFromString(initialHtml, 'text/html');
  const form = localizarFormBusca(docInicial);
  if (!form) {
    return {
      ok: false,
      error:
        'Form de pesquisa da pauta não encontrado no HTML inicial — layout do PJe pode ter mudado.'
    };
  }
  const viewState =
    form.querySelector<HTMLInputElement>('input[name="javax.faces.ViewState"]')
      ?.value ||
    docInicial.querySelector<HTMLInputElement>(
      'input[name="javax.faces.ViewState"]'
    )?.value ||
    '';
  if (!viewState) {
    return {
      ok: false,
      error: 'ViewState não encontrado no HTML inicial — layout do PJe pode ter mudado.'
    };
  }

  // 2. POST com os filtros do magistrado.
  const montagem = montarBodySearch({
    form,
    viewState,
    jurisdicaoId: input.jurisdicaoId,
    orgaoJulgadorId: input.orgaoJulgadorId,
    dataDe: input.dataDe,
    dataAte: input.dataAte,
    situacoes: input.situacoes
  });
  if (!montagem.ok) {
    return { ok: false, error: montagem.error };
  }

  const action = form.getAttribute('action');
  const postUrl = action ? new URL(action, url).toString() : url;

  let respHtml: string;
  try {
    const resp = await fetch(postUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: '*/*',
        // Sem este header o filtro AJAX4JSF (RichFaces 3.3.3) não trata a
        // requisição como Ajax e não dispara o action do botão Pesquisar —
        // devolve a página do form em branco, sem a tabela de resultados.
        // Mesma lição já aplicada em prevjud-ssr.ts e pauta-pericia-ssr.ts.
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: montagem.body
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

  // Tabela ausente ≠ pauta vazia. Quando o PJe devolve a resposta sem a
  // tabela de resultados, o action não disparou (contrato quebrado por
  // mudança de versão) — reportar como erro, e não como "nenhum processo
  // encontrado", que foi exatamente o sintoma que mascarou a quebra da v11.
  if (parsed.tabelaAusente) {
    const pistas = [
      `len=${respHtml.length}`,
      respHtml.includes('javax.faces.ViewState') ? 'temViewState' : 'semViewState',
      /searchButton/i.test(respHtml) ? 'temBotaoPesquisar' : 'semBotaoPesquisar',
      /login|autentica|sess[aã]o expir/i.test(respHtml) ? 'PARECE-LOGIN' : ''
    ]
      .filter(Boolean)
      .join(' ');
    console.warn(`${LOG} resposta do POST sem tabela de resultados (${pistas}).`);
    return {
      ok: false,
      error: `O PJe respondeu sem a tabela de resultados (${pistas}). O layout da Pauta de audiência pode ter mudado.`
    };
  }

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

/**
 * Localiza o form de pesquisa da pauta. O `id` canônico é
 * `processoAudienciaSearchForm`, mas versões do PJe já mudaram prefixos de
 * naming container — por isso há dois fallbacks: `id` parcial e, por último,
 * qualquer form que contenha o campo de data inicial da pauta.
 */
function localizarFormBusca(doc: Document): HTMLFormElement | null {
  const exato = doc.querySelector<HTMLFormElement>(
    'form[id="processoAudienciaSearchForm"]'
  );
  if (exato) return exato;
  const parcial = doc.querySelector<HTMLFormElement>(
    'form[id*="processoAudienciaSearchForm"]'
  );
  if (parcial) return parcial;
  const campoData = doc.querySelector('[name$=":dtInicioFromFormInputDate"]');
  return campoData?.closest('form') ?? null;
}

/**
 * Resolve o `name` completo de um campo pelo sufixo estável. Os IDs JSF são
 * caminhos de naming container (`form:decoration:campo`) cujos segmentos
 * `j_idNNN` são renumerados a cada versão do PJe — só o sufixo final é
 * contrato. Nunca escreva o caminho completo à mão aqui.
 */
function nomePorSufixo(form: Element, sufixo: string): string | null {
  const el = form.querySelector<HTMLElement>(`[name$="${sufixo}"]`);
  return el?.getAttribute('name') ?? null;
}

/**
 * Serializa os campos do form como o `A4J.AJAX.Submit` faria: todos os
 * inputs/selects/textareas com `name`, pulando checkboxes/radios
 * desmarcados e botões. Preserva automaticamente os hidden voláteis
 * (`j_id*`) e os defaults de jurisdição/órgão julgador já selecionados
 * pela sessão do magistrado — que antes eram raspados por regex.
 */
function serializarForm(form: Element): URLSearchParams {
  const params = new URLSearchParams();
  const campos = form.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('input[name], select[name], textarea[name]');
  for (const el of Array.from(campos)) {
    if (el instanceof HTMLInputElement) {
      const tipo = el.type.toLowerCase();
      if ((tipo === 'checkbox' || tipo === 'radio') && !el.checked) continue;
      if (['submit', 'button', 'image', 'reset', 'file'].includes(tipo)) {
        continue;
      }
    }
    params.append(el.name, el.value ?? '');
  }
  return params;
}

function detectarSessaoExpirada(html: string): boolean {
  return (
    html.includes('viewExpired') ||
    html.includes('Sua sessão expirou') ||
    /location\.replace\(['"][^'"]*\/login\.seam/i.test(html)
  );
}

interface BodySearchInput {
  form: HTMLFormElement;
  viewState: string;
  jurisdicaoId?: number;
  orgaoJulgadorId?: number;
  dataDe: string;
  dataAte: string;
  situacoes: AudienciaSituacaoCodigo[];
}

type BodySearchResult =
  | { ok: true; body: string }
  | { ok: false; error: string };

/**
 * Monta o POST partindo da serialização do form real, e não de um corpo
 * escrito à mão. Motivo: o corpo hardcoded quebrava a cada versão do PJe
 * (os `j_idNNN` são renumerados) e ainda mandava
 * `_link_hidden_=…:clearButton` — ou seja, dizia ao Seam que o último link
 * acionado tinha sido *Limpar*, não *Pesquisar*.
 *
 * Só sobrescrevemos os campos que o magistrado escolheu; todo o resto
 * (jurisdição/órgão pré-selecionados pela sessão, combos "sem seleção",
 * campos de CNJ vazios, hidden voláteis) vem do próprio HTML.
 */
function montarBodySearch(i: BodySearchInput): BodySearchResult {
  const { form } = i;
  const params = serializarForm(form);

  const nomeDataDe = nomePorSufixo(form, ':dtInicioFromFormInputDate');
  const nomeDataAte = nomePorSufixo(form, ':dtInicioToFormInputDate');
  const nomeSituacoes = nomePorSufixo(form, ':listaSituacoes');
  if (!nomeDataDe || !nomeDataAte || !nomeSituacoes) {
    const faltando = [
      !nomeDataDe && 'data inicial',
      !nomeDataAte && 'data final',
      !nomeSituacoes && 'situações'
    ]
      .filter(Boolean)
      .join(', ');
    return {
      ok: false,
      error: `Campos do form da pauta não localizados (${faltando}) — layout do PJe mudou.`
    };
  }

  params.set(nomeDataDe, i.dataDe);
  params.set(nomeDataAte, i.dataAte);
  // Campos-espelho do rich:calendar (MM/YYYY do mês exibido).
  const nomeDataDeAtual = nomePorSufixo(form, ':dtInicioFromFormInputCurrentDate');
  const nomeDataAteAtual = nomePorSufixo(form, ':dtInicioToFormInputCurrentDate');
  if (nomeDataDeAtual) params.set(nomeDataDeAtual, i.dataDe.slice(3));
  if (nomeDataAteAtual) params.set(nomeDataAteAtual, i.dataAte.slice(3));

  // Situações: a serialização trouxe as marcadas por default no HTML.
  // Zera e reaplica exatamente as escolhidas pelo magistrado.
  params.delete(nomeSituacoes);
  for (const s of i.situacoes) {
    params.append(nomeSituacoes, s);
  }

  // Overrides opcionais — quando ausentes, valem os defaults da sessão que
  // já vieram serializados do form.
  if (i.jurisdicaoId != null) {
    const nome = nomePorSufixo(form, ':jurisdicao');
    if (nome) params.set(nome, String(i.jurisdicaoId));
  }
  if (i.orgaoJulgadorId != null) {
    const nome = nomePorSufixo(form, ':orgaoJulgador');
    if (nome) params.set(nome, String(i.orgaoJulgadorId));
  }

  // Aciona o botão Pesquisar. `AJAXREQUEST=_viewRoot` é o marcador que faz
  // o filtro AJAX4JSF processar o ciclo Ajax e disparar o action.
  const idBotao = localizarSearchButton(form);
  if (!idBotao) {
    return {
      ok: false,
      error: 'Botão "Pesquisar" da pauta não localizado no form — layout do PJe mudou.'
    };
  }
  params.set('AJAXREQUEST', '_viewRoot');
  // Marcador JSF de "este form foi submetido". Só faz sentido com id.
  if (form.id) params.set(form.id, form.id);
  params.set(idBotao, idBotao);
  params.set('autoScroll', '');
  params.set('javax.faces.ViewState', i.viewState);
  params.set('AJAX:EVENTS_COUNT', '1');
  return { ok: true, body: params.toString() };
}

/**
 * Descobre o `name`/`id` do botão Pesquisar. Sufixo `:searchButton` é o
 * contrato estável; o fallback varre submits pelo rótulo para o caso de
 * uma renomeação futura.
 */
function localizarSearchButton(form: Element): string | null {
  const porSufixo = nomePorSufixo(form, ':searchButton');
  if (porSufixo) return porSufixo;
  const submits = Array.from(
    form.querySelectorAll<HTMLInputElement>(
      'input[type="submit"][name], input[type="button"][name]'
    )
  );
  const alvo = submits.find((el) => /pesquis|buscar/i.test(el.value ?? ''));
  return alvo?.getAttribute('name') ?? null;
}

interface ParseResult {
  itens: AudienciaPautaItem[];
  totalInformado: number | null;
  /**
   * `true` quando a tabela de resultados sequer apareceu na resposta —
   * distinto de "apareceu vazia". Sem essa distinção, uma quebra de
   * contrato com o PJe se disfarça de "nenhum processo no período".
   */
  tabelaAusente?: boolean;
}

/**
 * Localiza a tabela de resultados. `idProcessoAudiencia` pode vir prefixado
 * por naming container em versões novas do PJe, então casamos por sufixo do
 * `id`; o último fallback é a tabela que contém os links de detalhe.
 */
function localizarTabelaPauta(doc: Document): Element | null {
  return (
    doc.querySelector('table#idProcessoAudiencia') ??
    doc.querySelector('table[id$=":idProcessoAudiencia"]') ??
    doc.querySelector('table[id*="idProcessoAudiencia"]') ??
    doc.querySelector('a[href*="listProcessoCompleto"]')?.closest('table') ??
    null
  );
}

function parsearTabelaPauta(html: string, legacyOrigin: string): ParseResult {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tabela = localizarTabelaPauta(doc);
  if (!tabela) {
    return { itens: [], totalInformado: 0, tabelaAusente: true };
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
