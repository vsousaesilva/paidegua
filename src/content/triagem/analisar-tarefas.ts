/**
 * Orquestrador da ação "Analisar tarefas" (perfil Secretaria).
 *
 * Pré-requisito: a página atual deve ser o painel-usuario-interno do PJe.
 * Quando o painel é renderizado em iframe cross-origin (caso TRF5), esta
 * função roda DENTRO do iframe (acionada pelo bridge). Caso contrário,
 * roda direto no top frame.
 *
 * Fluxo:
 *
 *   1. Captura todos os links de tarefa cujo nome bate com
 *      `/(analisar inicial|triagem)/i`. Deduplicação por nome — o painel
 *      pode listar a mesma tarefa em mais de um lugar (widget + menu).
 *   2. Para cada tarefa: navega via `location.hash = href`, aguarda a
 *      lista renderizar, lê TODAS as páginas do paginador (clicando em
 *      "next" até esgotar).
 *   3. Volta ao painel ao final, agrega o snapshot e devolve.
 *
 * Decisões deliberadas:
 *
 *   - **Navegação por `location.hash`** em vez de `history.back()`. Mais
 *     determinística no Angular do PJe e evita a "tela branca" que o
 *     history.back() causava ao terminar a varredura.
 *   - **URL dos autos** é capturada do próprio cartão quando possível
 *     (atributo `href` do link `selecionarProcesso`, que carrega `ca` e
 *     `idTaskInstance`). Sem isso, alguns processos não abrem.
 *   - **Origin do PJe** vem do top via `pjeOrigin`. No iframe,
 *     `window.location.origin` aponta para `frontend-prd.trf5.jus.br`,
 *     que NÃO é onde os autos vivem.
 *   - **Sem chamada à LLM aqui.** A LLM é chamada pelo dashboard.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import type {
  TriagemDashboardPayload,
  TriagemProcesso,
  TriagemTarefaSnapshot
} from '../../shared/types';

const TAREFA_REGEX = /(analisar\s+inicial|triagem)/i;
const SELETOR_LINK_TAREFA = 'a[href*="painel-usuario-interno/lista-processos-tarefa"]';
const SELETOR_LISTA_PROCESSOS = 'ul.ui-datalist-data';
const SELETOR_CARTAO = 'processo-datalist-card';
const TIMEOUT_DOM_MS = 12_000;
// Quando o paginador "está lá" mas estamos na última página, o clique
// não muda nada. Timeout curto evita esperar 12s para detectar fim normal.
const TIMEOUT_PAGINACAO_MS = 5_000;
const TIMEOUT_VOLTA_MS = 8_000;
const MAX_PAGINAS_POR_TAREFA = 50;
const MAX_SCROLLS_INFINITOS = 30;
const SCROLL_WAIT_MS = 1_500;

export interface AnalisarTarefasResult {
  ok: boolean;
  totalTarefas: number;
  totalProcessos: number;
  error?: string;
}

export interface AnalisarTarefasOptions {
  onProgress?: (msg: string) => void;
  /**
   * Origin do PJe principal (ex.: https://pje1g.trf5.jus.br). Necessário
   * quando esta função roda dentro de um iframe cross-origin — sem isso,
   * URLs dos autos sairiam apontando para o origin do iframe.
   */
  pjeOrigin?: string;
}

export interface TarefaInfo {
  nome: string;
  href: string;
}

let debugCartaoLogado = 0;
let debugCartaoBrutoLogado = 0;

/**
 * Hash da página do painel no momento em que `executarAnalisarTarefas` é
 * iniciada. Usado como fallback de navegação em `voltarAoPainel` quando
 * nenhum botão "voltar" está presente no DOM.
 *
 * Tipicamente algo como `#/painel-usuario-interno`. Capturado uma única
 * vez por execução porque, durante a leitura das tarefas, o hash pode
 * mudar para refletir a tarefa atual e perder a referência original.
 */
let painelHashInicial = '';

export async function executarAnalisarTarefas(
  options: AnalisarTarefasOptions = {}
): Promise<AnalisarTarefasResult> {
  const progress = options.onProgress ?? (() => {});
  const pjeOrigin = options.pjeOrigin ?? window.location.origin;

  if (!window.location.href.includes('painel-usuario-interno')) {
    return {
      ok: false,
      totalTarefas: 0,
      totalProcessos: 0,
      error: 'Abra o "Painel do usuário" do PJe antes de usar Analisar tarefas.'
    };
  }

  // Guarda o hash do painel ANTES de qualquer navegação para usar como
  // fallback em voltarAoPainel (caso o DOM perca os botões de voltar).
  painelHashInicial = window.location.hash || '#/painel-usuario-interno';
  console.log(`${LOG_PREFIX} hash inicial do painel: "${painelHashInicial}"`);

  progress('Analisando tarefas — pode levar alguns minutos. Aguarde.');

  progress('Procurando tarefas de análise inicial e triagem...');
  const tarefas = capturarTarefas((nome) => TAREFA_REGEX.test(nome));
  if (tarefas.length === 0) {
    debugDumpDom();
    return {
      ok: false,
      totalTarefas: 0,
      totalProcessos: 0,
      error:
        'Nenhuma tarefa contendo "Analisar inicial" ou "Triagem" foi encontrada no painel. ' +
        'Veja [pAIdegua][debug-tarefas] no console (F12).'
    };
  }

  console.log(
    `${LOG_PREFIX} tarefas alvo:`,
    tarefas.map((t) => t.nome)
  );

  const tarefasSnapshot = await coletarSnapshots(tarefas, pjeOrigin, progress);
  const totalProcessos = tarefasSnapshot.reduce((s, t) => s + t.totalLido, 0);

  const payload: TriagemDashboardPayload = {
    geradoEm: new Date().toISOString(),
    hostnamePJe: new URL(pjeOrigin).hostname,
    tarefas: tarefasSnapshot,
    totalProcessos,
    insightsLLM: null
  };

  progress('Abrindo dashboard...');
  const ok = await pedirAberturaDashboard(payload);

  if (!ok) {
    return {
      ok: false,
      totalTarefas: tarefasSnapshot.length,
      totalProcessos,
      error: 'Falha ao abrir o dashboard. Veja o console para detalhes.'
    };
  }

  return { ok: true, totalTarefas: tarefasSnapshot.length, totalProcessos };
}

// =====================================================================
// Captura e navegação
// =====================================================================

function encontrarLinksTarefa(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>(SELETOR_LINK_TAREFA));
}

/**
 * "Widget principal" do painel é o componente que renderiza TODAS as
 * tarefas com hrefs completos (4+ segmentos, com filtro base64 obrigatório
 * para o roteador Angular). A sidebar lateral também lista tarefas, mas
 * com hrefs truncados em 3 segmentos — clicar nesses faz o roteador
 * falhar com "Cannot match any routes" e a lista NÃO atualiza.
 *
 * Esta função detecta a presença do widget pela existência de pelo menos
 * um link com 4+ segmentos.
 */
function temWidgetPainel(): boolean {
  return encontrarLinksTarefa().some(
    (a) => contarSegmentos(a.getAttribute('href') ?? '') >= 4
  );
}

/**
 * Captura `{ nome, href }` de cada tarefa que passa no `filtro`. Há
 * tipicamente DOIS links por tarefa (menu lateral + widget principal).
 * Eles têm o MESMO `nome`, mas o `href` pode divergir — o widget
 * principal costuma trazer o segmento de filtros base64 na 4ª posição,
 * sem o qual o roteador Angular falha com "Cannot match any routes".
 *
 * Estratégia: agrupar por nome e escolher o href com mais segmentos
 * (proxy razoável para "tem o filtro").
 *
 * Exportado para uso pelo perfil Gestão, que passa um filtro baseado
 * na seleção do usuário em vez do regex fixo da Triagem.
 */
export function capturarTarefas(filtro: (nome: string) => boolean): TarefaInfo[] {
  const candidatos: TarefaInfo[] = [];
  for (const link of encontrarLinksTarefa()) {
    const nome = getTaskName(link);
    if (!nome || !filtro(nome)) continue;
    const href = link.getAttribute('href') ?? '';
    if (!href) continue;
    candidatos.push({ nome, href });
  }

  console.log(
    `${LOG_PREFIX} candidatos a tarefa (${candidatos.length}):\n` +
      candidatos
        .map(
          (c, i) =>
            `  [${i}] segs=${contarSegmentos(c.href)} | nome="${c.nome}"\n      href=${c.href}`
        )
        .join('\n')
  );

  const porNome = new Map<string, TarefaInfo>();
  for (const c of candidatos) {
    const atual = porNome.get(c.nome);
    if (!atual) {
      porNome.set(c.nome, c);
      continue;
    }
    if (contarSegmentos(c.href) > contarSegmentos(atual.href)) {
      porNome.set(c.nome, c);
    }
  }

  return Array.from(porNome.values());
}

/**
 * Lista todas as tarefas disponíveis no painel com quantidades — base
 * para o seletor múltiplo do perfil Gestão. Deduplica por nome (mesma
 * tarefa pode aparecer no widget principal e na sidebar) e mantém a
 * ordem do DOM para preservar a que o PJe já apresenta ao usuário.
 *
 * A quantidade é extraída do texto do link (padrão `Nome (N)`). Quando
 * não encontrada, devolve `null`.
 */
export function listarTodasTarefas(): Array<{ nome: string; quantidade: number | null }> {
  const vistos = new Map<string, { nome: string; quantidade: number | null }>();
  for (const link of encontrarLinksTarefa()) {
    const nome = getTaskName(link);
    if (!nome) continue;
    if (vistos.has(nome)) continue;
    const raw = (link.textContent ?? '').replace(/\s+/g, ' ').trim();
    const m = raw.match(/\((\d+)\)\s*$/);
    const quantidade = m ? Number(m[1]) : null;
    vistos.set(nome, { nome, quantidade: Number.isFinite(quantidade) ? quantidade : null });
  }
  return Array.from(vistos.values());
}

/**
 * Loop principal de varredura: para cada tarefa da lista, navega,
 * lê todas as páginas e volta ao painel. Extraído para reuso pelo
 * perfil Gestão (seleção arbitrária de tarefas) — a Triagem
 * (perfil Secretaria) continua chamando através de `executarAnalisarTarefas`
 * com o filtro fixo `TAREFA_REGEX`.
 */
export async function coletarSnapshots(
  tarefas: TarefaInfo[],
  pjeOrigin: string,
  progress: (msg: string) => void
): Promise<TriagemTarefaSnapshot[]> {
  const tarefasSnapshot: TriagemTarefaSnapshot[] = [];

  for (let i = 0; i < tarefas.length; i += 1) {
    const t = tarefas[i];
    progress(`Tarefa ${i + 1}/${tarefas.length}: ${t.nome} — entrando...`);

    try {
      await entrarNaTarefa(t.nome, t.href);
    } catch (err) {
      console.warn(`${LOG_PREFIX} falhou ao entrar em "${t.nome}":`, err);
      tarefasSnapshot.push({
        tarefaNome: t.nome,
        totalLido: 0,
        truncado: false,
        processos: []
      });
      try { await voltarAoPainel(); } catch { /* segue */ }
      continue;
    }

    let processos: TriagemProcesso[] = [];
    let truncado = false;
    let paginasLidas = 0;
    let motivoFimPaginacao = 'erro antes de ler qualquer página';
    try {
      const r = await lerTodasAsPaginas(
        (msg) => progress(`Tarefa ${i + 1}/${tarefas.length}: ${t.nome} — ${msg}`),
        pjeOrigin
      );
      processos = r.processos;
      truncado = r.truncado;
      paginasLidas = r.paginasLidas;
      motivoFimPaginacao = r.motivo;
    } catch (err) {
      console.warn(`${LOG_PREFIX} leitura da tarefa "${t.nome}" falhou:`, err);
      motivoFimPaginacao = err instanceof Error ? err.message : String(err);
    }

    tarefasSnapshot.push({
      tarefaNome: t.nome,
      totalLido: processos.length,
      truncado,
      paginasLidas,
      motivoFimPaginacao,
      processos
    });

    progress(
      `Tarefa ${i + 1}/${tarefas.length}: ${processos.length} processo(s) lido(s)` +
        (truncado ? ' (truncado)' : '') +
        '.'
    );

    progress(`Tarefa ${i + 1}/${tarefas.length}: voltando ao painel...`);
    try {
      await voltarAoPainel();
    } catch (err) {
      console.warn(`${LOG_PREFIX} voltar ao painel falhou:`, err);
      break;
    }
  }

  return tarefasSnapshot;
}

function contarSegmentos(href: string): number {
  // Remove o '#' inicial se houver e a query string. Conta segmentos
  // separados por '/' não-vazios. Ex.:
  //   #/painel-usuario-interno/lista-processos-tarefa/<nome>/<filtroB64>
  //   → 4 segmentos
  const sem = href.replace(/^#/, '').split('?')[0];
  return sem.split('/').filter((s) => s.length > 0).length;
}

function getTaskName(el: HTMLElement): string {
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();
  const nomeEl = el.querySelector<HTMLElement>('.nome');
  if (nomeEl?.textContent) return nomeEl.textContent.replace(/\s+/g, ' ').trim();
  const raw = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return raw.replace(/[\s(]+\d+\)?\s*$/, '').trim();
}

/**
 * Entra em uma tarefa disparando `link.click()`.
 *
 * Histórico das abordagens testadas:
 *   - `location.hash = href` → falha. O `href` do `<a>` é incompleto
 *     (3 segmentos, sem o filtro). O roteador Angular rejeita com
 *     "Cannot match any routes".
 *   - `link.click()` → ROUTERLINK também rejeita (mesmo erro), MAS o
 *     handler `(click)` do componente atualiza o estado interno e a
 *     lista renderiza assim mesmo. A URL não muda — o PJe TRF5 faz a
 *     navegação por estado, não por rota.
 *
 * Conclusão: o erro de roteador no console é INERENTE ao fluxo (acontece
 * inclusive quando o usuário clica manualmente). Ignoramos e esperamos
 * o DOM da lista aparecer.
 *
 * Pré-condição: estar no painel raiz (com os links visíveis no DOM).
 */
/**
 * Busca o melhor link para uma tarefa pelo nome. Prefere o link com mais
 * segmentos no href — tipicamente o do widget principal, que inclui o
 * filtro base64 obrigatório para o roteador Angular aceitar a rota.
 * Links da sidebar têm href truncado e, em alguns estados, também não
 * estão visíveis para toda tarefa (ex.: enquanto o usuário está dentro
 * de outra tarefa, a sidebar só expõe as mais usadas).
 */
function acharMelhorLinkTarefa(nome: string): HTMLAnchorElement | undefined {
  const candidatos = encontrarLinksTarefa().filter(
    (a) => getTaskName(a) === nome
  );
  if (candidatos.length === 0) return undefined;
  candidatos.sort(
    (a, b) =>
      contarSegmentos(b.getAttribute('href') ?? '') -
      contarSegmentos(a.getAttribute('href') ?? '')
  );
  return candidatos[0];
}

async function entrarNaTarefa(
  nome: string,
  _hrefCapturado?: string
): Promise<void> {
  // Pré-condição estrita: o widget principal precisa estar montado para
  // termos um link de 4+ segmentos disponível. Sem isso, qualquer click
  // em link de sidebar (3 segmentos) causa "Cannot read properties of
  // null (reading 'entities')" e a lista não atualiza. Forçamos sempre,
  // mesmo entre tarefas, porque entrar em uma tarefa desmonta o widget.
  if (!temWidgetPainel()) {
    console.log(
      `${LOG_PREFIX} entrar tarefa "${nome}": widget não está no DOM, ` +
        `voltando ao painel forçado.`
    );
    await voltarAoPainel(true);
    try {
      await waitForCondition(() => temWidgetPainel(), TIMEOUT_VOLTA_MS);
    } catch {
      debugDumpTarefasPresentes(nome);
      throw new Error(
        `Widget do painel não remontou após voltar — sem links de 4 segmentos.`
      );
    }
  }

  const link = acharMelhorLinkTarefa(nome);
  if (!link || contarSegmentos(link.getAttribute('href') ?? '') < 4) {
    debugDumpTarefasPresentes(nome);
    throw new Error(
      `Link 4-seg da tarefa "${nome}" não encontrado mesmo com widget montado.`
    );
  }

  // Captura a "assinatura" da lista atual (IDs dos cartões presentes) ANTES
  // do click. O PJe TRF5 às vezes deixa a UL da tarefa anterior no DOM por
  // uns ms após a navegação — se pegarmos a lista nesse instante, os
  // cartões antigos vazam para a nova tarefa. Esperamos que a maioria dos
  // IDs seja NOVA (lista substituída) antes de considerar pronto.
  const ulAntes = document.querySelector<HTMLElement>(SELETOR_LISTA_PROCESSOS);
  const idsAntes = ulAntes ? colherIdsDosCartoes(ulAntes) : new Set<string>();

  console.log(
    `${LOG_PREFIX} entrar tarefa "${nome}": click no link 4-seg ` +
      `(idsAntes=${idsAntes.size}, segs=${contarSegmentos(link.getAttribute('href') ?? '')}).`
  );
  link.click();

  await waitForCondition(() => {
    const ul = document.querySelector<HTMLElement>(SELETOR_LISTA_PROCESSOS);
    if (!ul) return false;
    const cards = ul.querySelectorAll(SELETOR_CARTAO);
    if (cards.length === 0) return false;
    if (idsAntes.size === 0) return true;
    const idsAgora = colherIdsDosCartoes(ul);
    let novos = 0;
    for (const id of idsAgora) {
      if (!idsAntes.has(id)) novos += 1;
    }
    // Exige que metade+ dos cartões visíveis sejam da nova tarefa.
    return novos >= Math.max(1, Math.floor(idsAgora.size / 2));
  }, TIMEOUT_DOM_MS).catch((err) => {
    console.warn(
      `${LOG_PREFIX} timeout aguardando lista após click. Hash atual=${window.location.hash}`
    );
    debugDumpListaNaoApareceu();
    throw err;
  });
}

/**
 * Quando o link de uma tarefa não está no DOM, dumpa a lista de nomes/hrefs
 * de TODAS as tarefas presentes — assim conseguimos ver se o nome divergiu,
 * se está faltando o widget, ou se só a sidebar restou.
 */
function debugDumpTarefasPresentes(nomeProcurado: string): void {
  const tag = '[pAIdegua][debug-tarefa-ausente]';
  const links = encontrarLinksTarefa();
  console.log(
    `${tag} procurando "${nomeProcurado}". Total de links de tarefa no DOM: ${links.length}`
  );
  console.log(
    `${tag} nomes presentes:`,
    links.map((a, i) => ({
      i,
      nome: getTaskName(a),
      segs: contarSegmentos(a.getAttribute('href') ?? ''),
      href: a.getAttribute('href') ?? ''
    }))
  );
}

/**
 * Quando a lista não renderiza após click, dumpa o que TEM no DOM —
 * ajuda a entender se o componente entrou em algum estado inesperado.
 */
function debugDumpListaNaoApareceu(): void {
  const tag = '[pAIdegua][debug-lista]';
  const ul = document.querySelector(SELETOR_LISTA_PROCESSOS);
  const cards = document.querySelectorAll(SELETOR_CARTAO);
  const allUls = document.querySelectorAll('ul');
  const datalist = document.querySelectorAll('[class*="datalist"]');
  console.log(
    `${tag} ul=${Boolean(ul)} cards=${cards.length} allUls=${allUls.length} datalist=${datalist.length}`
  );
  // Lista todas as classes únicas de elementos de container que apareceram
  const containers = document.querySelectorAll('main, section, .container, .panel, [role="main"]');
  console.log(
    `${tag} containers=${containers.length}, sample classes:`,
    Array.from(containers).slice(0, 5).map((el) => el.className).filter(Boolean)
  );
}

/**
 * Volta ao painel raiz. Estratégia em camadas, para ser resiliente a
 * estados em que o DOM atual não expõe um botão "voltar":
 *
 *   1. Curto-circuito: se já há links de tarefa no DOM, estamos no
 *      painel — só retornar (a menos que `forced=true`).
 *   2. Tenta seletores conhecidos de "voltar/breadcrumb".
 *   3. Fallback: `history.back()`.
 *   4. Último recurso: setar `location.hash` para o hash inicial do
 *      painel (capturado no começo de `executarAnalisarTarefas`).
 *
 * O comentário antigo afirmava que `location.hash` não funcionava — isso
 * vale para ENTRAR em uma tarefa (a URL não muda nesse fluxo). Para
 * VOLTAR ao painel, a URL original era um hash válido e o roteador
 * Angular o aceita normalmente.
 */
async function voltarAoPainel(forced: boolean = false): Promise<void> {
  // Só consideramos "no painel" quando o WIDGET principal está montado
  // (links de 4+ segmentos disponíveis). Apenas a sidebar não basta —
  // os hrefs dela são truncados e quebram o roteador Angular ao clicar.
  if (!forced && temWidgetPainel()) return;

  const seletoresVoltar = [
    'button[aria-label*="oltar" i]',
    'a[aria-label*="oltar" i]',
    'button[title*="oltar" i]',
    'a[title*="oltar" i]',
    'button.btn-voltar',
    'a.btn-voltar',
    // Breadcrumb "Painel"
    'a[href*="painel-usuario-interno"]:not([href*="lista-processos-tarefa"])',
    // Ícone de seta para a esquerda
    'i.fa-arrow-left',
    'i.fa-chevron-left',
    '[class*="back"] button',
    '[class*="voltar"] button'
  ];

  let clicado: HTMLElement | null = null;
  for (const sel of seletoresVoltar) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) {
      // Para ícones (i.fa-...), clicamos no ancestral clicável.
      const alvo = el.tagName === 'I'
        ? (el.closest('button, a') as HTMLElement | null) ?? el
        : el;
      console.log(`${LOG_PREFIX} voltar ao painel: clicando em "${sel}".`);
      alvo.click();
      clicado = alvo;
      break;
    }
  }

  if (clicado) {
    try {
      await waitForCondition(
        () => temWidgetPainel(),
        TIMEOUT_VOLTA_MS
      );
      return;
    } catch {
      console.warn(
        `${LOG_PREFIX} clique em "voltar" não remontou o widget; ` +
          `tentando fallbacks de navegação.`
      );
    }
  } else {
    console.warn(
      `${LOG_PREFIX} nenhum seletor de "voltar" bateu; ` +
        `tentando fallbacks de navegação.`
    );
  }

  // Fallback 1: history.back()
  try {
    console.log(`${LOG_PREFIX} voltar ao painel: history.back().`);
    window.history.back();
    await waitForCondition(
      () => temWidgetPainel(),
      TIMEOUT_VOLTA_MS / 2
    );
    return;
  } catch {
    console.warn(`${LOG_PREFIX} history.back() não trouxe os links.`);
  }

  // Fallback 2: setar hash para o painel inicial (captured em
  // executarAnalisarTarefas). Funciona porque o roteador Angular aceita
  // a rota raiz; só "entrar em tarefa" é que precisa do click handler.
  if (painelHashInicial) {
    try {
      console.log(
        `${LOG_PREFIX} voltar ao painel: location.hash = "${painelHashInicial}".`
      );
      window.location.hash = painelHashInicial;
      await waitForCondition(
        () => temWidgetPainel(),
        TIMEOUT_VOLTA_MS
      );
      return;
    } catch {
      console.warn(
        `${LOG_PREFIX} location.hash="${painelHashInicial}" não trouxe os links.`
      );
    }
  }

  debugDumpVoltarPainel();
  throw new Error(
    'Não consegui voltar ao painel — sem botão e fallbacks de navegação falharam.'
  );
}

function debugDumpVoltarPainel(): void {
  const tag = '[pAIdegua][debug-voltar]';
  const allButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
  console.log(`${tag} botões=${allButtons.length} links=${allLinks.length}`);
  console.log(
    `${tag} primeiros 8 botões:`,
    allButtons.slice(0, 8).map((b) => ({
      cls: b.className,
      title: b.title,
      aria: b.getAttribute('aria-label'),
      txt: (b.textContent ?? '').replace(/\s+/g, ' ').trim().substring(0, 40)
    }))
  );
  console.log(
    `${tag} primeiros 8 links:`,
    allLinks.slice(0, 8).map((a) => ({
      href: a.getAttribute('href'),
      title: a.title,
      txt: (a.textContent ?? '').replace(/\s+/g, ' ').trim().substring(0, 40)
    }))
  );
}

// =====================================================================
// Paginação
// =====================================================================

async function aguardarLista(): Promise<HTMLElement> {
  await waitForCondition(() => {
    const ul = document.querySelector<HTMLElement>(SELETOR_LISTA_PROCESSOS);
    return Boolean(ul && ul.querySelector(SELETOR_CARTAO));
  }, TIMEOUT_DOM_MS);
  const ul = document.querySelector<HTMLElement>(SELETOR_LISTA_PROCESSOS);
  if (!ul) throw new Error('Lista de processos não encontrada após espera.');
  return ul;
}

/**
 * Localiza o botão "próxima página" do paginador. Tenta múltiplos
 * seletores porque PrimeFaces (`a.ui-paginator-next`) e PrimeNG
 * (`button.ui-paginator-next` ou `.p-paginator-next`) divergem; sem
 * acesso ao HTML real do painel ainda, cobrimos os dois mundos.
 */
function localizarBotaoProximaPagina(): HTMLElement | null {
  const seletores = [
    'a.ui-paginator-next',
    'button.ui-paginator-next',
    '.ui-paginator-next',
    '.p-paginator-next',
    'button[aria-label*="Próxim" i]',
    'a[aria-label*="Próxim" i]',
    'button[aria-label*="Next" i]',
    'a[aria-label*="Next" i]',
    'button[title*="Próxim" i]',
    'a[title*="Próxim" i]',
    '[class*="paginator"] [class*="next"]',
    '[class*="paginator"] a[class*="next"]',
    '[class*="paginator"] button[class*="next"]'
  ];
  for (const sel of seletores) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

function temProximaPagina(): boolean {
  const btn = localizarBotaoProximaPagina();
  if (!btn) return false;
  if (btn.classList.contains('ui-state-disabled')) return false;
  if (btn.classList.contains('p-disabled')) return false;
  if (btn.hasAttribute('disabled')) return false;
  if (btn.getAttribute('aria-disabled') === 'true') return false;
  return true;
}

/**
 * Lê todas as páginas da tarefa atual. Estratégia:
 *   1. Lê os cartões da página atual.
 *   2. Se há "próxima" no paginador, captura o ID do primeiro cartão,
 *      clica em next, e aguarda o primeiro cartão MUDAR (sinal de que
 *      a nova página renderizou).
 *   3. Repete até esgotar o paginador ou bater o limite de segurança.
 *
 * Deduplica por `idProcesso` — proteção contra páginas idênticas
 * (acontece quando o paginador "trava" sem trocar conteúdo).
 */
async function lerTodasAsPaginas(
  progress: (msg: string) => void,
  pjeOrigin: string
): Promise<{
  processos: TriagemProcesso[];
  truncado: boolean;
  paginasLidas: number;
  motivo: string;
}> {
  const todos: TriagemProcesso[] = [];
  const idsVistos = new Set<string>();
  let truncado = false;
  let pagina = 1;
  let motivo = 'sem mais páginas';

  while (true) {
    progress(`lendo página ${pagina}...`);
    const ul = await aguardarLista();
    const ulCount = ul.querySelectorAll(SELETOR_CARTAO).length;
    const desta = lerCartoes(ul, pjeOrigin);
    // Diagnóstico de divergência: se o DOM tem N cartões mas só lemos M,
    // significa que `lerCartao` descartou (N-M) cartões — normalmente por
    // não achar `idTaskInstance`. Importa para fechar a conta do total.
    if (desta.length !== ulCount) {
      console.warn(
        `${LOG_PREFIX} página ${pagina}: DOM tinha ${ulCount} cartões, ` +
          `lemos ${desta.length} (${ulCount - desta.length} descartados).`
      );
      debugDumpCartoesDescartados(ul);
    }
    if (pagina === 1) {
      const btn = localizarBotaoProximaPagina();
      console.log(
        `${LOG_PREFIX} página 1: cartões=${ulCount} lidos=${desta.length} btnNext=`,
        btn ? `<${btn.tagName.toLowerCase()} class="${btn.className}">` : 'null'
      );
      if (!btn) debugDumpPaginador();
    }

    let novos = 0;
    for (const p of desta) {
      if (idsVistos.has(p.idProcesso)) continue;
      idsVistos.add(p.idProcesso);
      todos.push(p);
      novos += 1;
    }

    if (!temProximaPagina()) {
      motivo = `paginador inexistente ou desabilitado após página ${pagina}`;
      break;
    }

    if (pagina >= MAX_PAGINAS_POR_TAREFA) {
      console.warn(
        `${LOG_PREFIX} paginação interrompida: limite de ${MAX_PAGINAS_POR_TAREFA} páginas.`
      );
      truncado = true;
      motivo = `limite de ${MAX_PAGINAS_POR_TAREFA} páginas atingido`;
      break;
    }

    if (novos === 0) {
      console.warn(`${LOG_PREFIX} paginação parada: nenhum processo novo na página ${pagina}.`);
      motivo = `nenhum processo novo na página ${pagina}`;
      break;
    }

    const idsAntes = colherIdsDosCartoes(ul);
    const ok = await clicarProximaPagina(idsAntes);
    if (!ok) {
      // Botão existe mas o conteúdo não mudou: tratamos como fim natural,
      // não como truncamento. PrimeNG/PrimeFaces às vezes deixam o "next"
      // visível na última página sem desabilitá-lo formalmente.
      motivo = `clique em "próxima" não avançou (página ${pagina} é a última)`;
      break;
    }
    pagina += 1;
  }

  // Fallback de SCROLL: alguns painéis carregam preguiçosamente — sem
  // paginador, ou com paginador que esgota antes do final real. Após o
  // loop principal, tentamos rolar a lista até parar de aparecer cartão
  // novo. Operação READ-ONLY (não clica em nada).
  const extras = await tentarScrollInfinito(
    todos,
    idsVistos,
    pjeOrigin,
    progress
  );
  if (extras > 0) {
    motivo += ` | scroll-infinito coletou +${extras} cartões`;
  }

  return { processos: todos, truncado, paginasLidas: pagina, motivo };
}

/**
 * Após o loop de paginação, tenta carregar mais cartões via scroll —
 * cobre o caso de painéis com lazy-load infinito (sem paginador). Rola
 * vários candidatos a container de rolagem (a própria UL, pais, body)
 * e aguarda até o número de cartões parar de crescer.
 */
async function tentarScrollInfinito(
  todos: TriagemProcesso[],
  idsVistos: Set<string>,
  pjeOrigin: string,
  progress: (msg: string) => void
): Promise<number> {
  let extras = 0;
  let semProgresso = 0;
  for (let i = 0; i < MAX_SCROLLS_INFINITOS; i += 1) {
    const ul = document.querySelector<HTMLElement>(SELETOR_LISTA_PROCESSOS);
    if (!ul) break;
    const antesCount = ul.querySelectorAll(SELETOR_CARTAO).length;

    // Tenta vários alvos de scroll — não sabemos qual é o container real.
    const alvos: Array<HTMLElement | Window> = [];
    let n: HTMLElement | null = ul;
    while (n) {
      alvos.push(n);
      n = n.parentElement;
    }
    alvos.push(window);
    for (const alvo of alvos) {
      try {
        if (alvo instanceof Window) {
          alvo.scrollTo(0, document.body.scrollHeight);
        } else {
          alvo.scrollTop = alvo.scrollHeight;
        }
      } catch {
        /* ignore */
      }
    }

    await new Promise<void>((r) => window.setTimeout(r, SCROLL_WAIT_MS));

    const ulAgora = document.querySelector<HTMLElement>(SELETOR_LISTA_PROCESSOS);
    if (!ulAgora) break;
    const depoisCount = ulAgora.querySelectorAll(SELETOR_CARTAO).length;
    if (depoisCount <= antesCount) {
      semProgresso += 1;
      if (semProgresso >= 2) break; // 2 tentativas sem progresso = fim
      continue;
    }
    semProgresso = 0;

    // Lê apenas os cartões cujo ID ainda não vimos.
    for (const c of Array.from(
      ulAgora.querySelectorAll<HTMLElement>(SELETOR_CARTAO)
    )) {
      const id = idDoCartao(c);
      if (!id || idsVistos.has(id)) continue;
      const p = lerCartao(c, pjeOrigin);
      if (!p) continue;
      idsVistos.add(p.idProcesso);
      todos.push(p);
      extras += 1;
    }
    progress(`scroll: +${extras} cartões`);
  }
  return extras;
}

/**
 * Extrai o id de identificação de um cartão. Usa as MESMAS heurísticas
 * que `lerCartao` para se manter sincronizado:
 *   1. <span class="hidden" id="..."> dentro do cartão
 *   2. qualquer <span id="..."> dentro do cartão
 *   3. atributo `id` do próprio cartão
 */
function idDoCartao(cartao: Element): string {
  const a = cartao.querySelector<HTMLElement>('span.hidden[id]')?.id;
  if (a) return a;
  const b = cartao.querySelector<HTMLElement>('span[id]')?.id;
  if (b) return b;
  return (cartao as HTMLElement).id ?? '';
}

function colherIdsDosCartoes(ul: HTMLElement): Set<string> {
  const out = new Set<string>();
  for (const c of Array.from(ul.querySelectorAll<HTMLElement>(SELETOR_CARTAO))) {
    const id = idDoCartao(c);
    if (id) out.add(id);
  }
  return out;
}

async function clicarProximaPagina(idsAntes: Set<string>): Promise<boolean> {
  const btn = localizarBotaoProximaPagina();
  if (!btn) {
    console.log(`${LOG_PREFIX} paginador: botão "próxima" NÃO encontrado.`);
    return false;
  }
  if (
    btn.classList.contains('ui-state-disabled') ||
    btn.classList.contains('p-disabled') ||
    btn.hasAttribute('disabled') ||
    btn.getAttribute('aria-disabled') === 'true'
  ) {
    console.log(`${LOG_PREFIX} paginador: "próxima" desabilitado.`);
    return false;
  }
  console.log(
    `${LOG_PREFIX} paginador: clicando próxima (idsAntes=${idsAntes.size}, btn.class="${btn.className}").`
  );
  btn.click();

  // Estratégia de espera: o conjunto de IDs dos cartões precisa MUDAR
  // significativamente. Tolerância: pelo menos metade dos IDs novos não
  // estavam no conjunto anterior.
  try {
    await waitForCondition(() => {
      const ul = document.querySelector<HTMLElement>(SELETOR_LISTA_PROCESSOS);
      if (!ul) return false;
      const idsAgora = colherIdsDosCartoes(ul);
      if (idsAgora.size === 0) return false;
      let novos = 0;
      for (const id of idsAgora) {
        if (!idsAntes.has(id)) novos += 1;
      }
      return novos >= Math.max(1, Math.floor(idsAgora.size / 2));
    }, TIMEOUT_PAGINACAO_MS);
    return true;
  } catch {
    console.warn(
      `${LOG_PREFIX} paginação: conjunto de cartões não mudou após clicar próxima.`
    );
    return false;
  }
}

// =====================================================================
// Leitura dos cartões
// =====================================================================

function lerCartoes(ul: HTMLElement, pjeOrigin: string): TriagemProcesso[] {
  const cartoes = Array.from(ul.querySelectorAll<HTMLElement>(SELETOR_CARTAO));
  const out: TriagemProcesso[] = [];
  for (const cartao of cartoes) {
    const proc = lerCartao(cartao, pjeOrigin);
    if (proc) out.push(proc);
  }
  return out;
}

function lerCartao(cartao: HTMLElement, pjeOrigin: string): TriagemProcesso | null {
  // Log diagnóstico do PRIMEIRO cartão (HTML bruto) — útil quando o parser
  // está retornando null para todos. Removível depois que o parser
  // estabilizar.
  if (debugCartaoBrutoLogado < 1) {
    debugCartaoBrutoLogado += 1;
    const html = cartao.outerHTML;
    console.log(
      `${LOG_PREFIX} cartão BRUTO (primeiros 4000 chars):`,
      html.length > 4000 ? html.substring(0, 4000) + '... [+truncado]' : html
    );
    const todosSpansComId = Array.from(
      cartao.querySelectorAll<HTMLElement>('span[id]')
    );
    console.log(
      `${LOG_PREFIX} span[id] no cartão:`,
      todosSpansComId.map((s) => ({
        id: s.id,
        cls: s.className,
        hidden: s.classList.contains('hidden')
      }))
    );
  }

  // Tenta múltiplas heurísticas para encontrar o idTaskInstance:
  //   1. <span class="hidden" id="..."> — assumido inicialmente
  //   2. qualquer <span id="..."> dentro do cartão (a classe pode ter mudado)
  //   3. atributo `id` do próprio cartão
  let idTaskInstance =
    cartao.querySelector<HTMLElement>('span.hidden[id]')?.id?.trim() ?? '';
  if (!idTaskInstance) {
    idTaskInstance =
      cartao.querySelector<HTMLElement>('span[id]')?.id?.trim() ?? '';
  }
  if (!idTaskInstance && cartao.id) {
    idTaskInstance = cartao.id.trim();
  }
  if (!idTaskInstance) return null;

  // <span class="tarefa-numero-processo process"> aparece DUAS vezes:
  // 1ª: número CNJ (ex.: "PJEC 0003020-32.2026.4.05.8109")
  // 2ª: assunto (ex.: "Pessoa com Deficiência")
  const spans = Array.from(
    cartao.querySelectorAll<HTMLElement>('span.tarefa-numero-processo')
  );
  const numeroProcesso = limparTexto(spans[0]?.textContent);
  const assunto = limparTexto(spans[1]?.textContent);

  const orgao = limparTexto(cartao.querySelector<HTMLElement>('.orgao')?.textContent);

  // POLOS: ficam dentro de UM `.local` que NÃO tem `.tituloNegrito` (esse
  // último é da "Última movimentação:"). Polo passivo ali é o real.
  const locais = Array.from(cartao.querySelectorAll<HTMLElement>('.local'));
  const localPolos = locais.find((el) => !el.querySelector('.tituloNegrito'));
  const poloAtivo = limparTexto(
    localPolos?.querySelector<HTMLElement>('.dtPoloAtivo')?.textContent,
    { stripTrailingX: true }
  );
  const poloPassivo = limparTexto(
    localPolos?.querySelector<HTMLElement>('.dtPoloPassivo')?.textContent
  );

  // ÚLTIMA MOVIMENTAÇÃO: `.local` que CONTÉM `.tituloNegrito`. O texto
  // descritivo está no `.dtPoloPassivo` (reuso da classe).
  const localMov = locais.find((el) => el.querySelector('.tituloNegrito'));
  const ultimaMov = limparTexto(
    localMov?.querySelector<HTMLElement>('.dtPoloPassivo')?.textContent
  );

  // DATA na tarefa: única, formato `dd-mm-aa`, dentro de `<div class="date">`
  // — pegamos o último `<span>` direto. Não há indicador `(N)` de dias;
  // calculamos a diferença em relação a hoje.
  let dataEntradaTarefa: string | null = null;
  let diasNaTarefa: number | null = null;
  const dateDiv = cartao.querySelector<HTMLElement>('div.date');
  if (dateDiv) {
    const dateSpans = Array.from(dateDiv.querySelectorAll<HTMLElement>(':scope > span'));
    const dateSpan = dateSpans[dateSpans.length - 1];
    const txt = limparTexto(dateSpan?.textContent);
    if (/^\d{2}-\d{2}-\d{2}$/.test(txt)) {
      dataEntradaTarefa = txt;
      diasNaTarefa = calcularDiasDesde(txt);
    }
  }

  // PRIORITÁRIO: ícone `fa-arrow-circle-up` (com title "Processo prioritário"
  // garantido pelo PJe).
  const prioritario = Boolean(
    cartao.querySelector('i.fa-arrow-circle-up[title="Processo prioritário"]')
  );

  // SIGILOSO: o HTML do PJe TRF5 não traz indicador visual confiável no
  // cartão da listagem (o `.sr-only` "Processo sigiloso" é descritor de
  // acessibilidade presente em TODOS os cartões). Mantemos `false` para
  // não distorcer métricas.
  const sigiloso = false;

  // ETIQUETAS: primeiro `<span>` direto de cada `.label-etiqueta`. O
  // segundo span é o ícone "x" de remover (`.icon-desvincular-tag`).
  const etiquetas = Array.from(
    cartao.querySelectorAll<HTMLElement>('.label-etiqueta')
  )
    .map((el) => {
      const primeiro = el.querySelector<HTMLElement>(
        ':scope > span:not(.icon-desvincular-tag)'
      ) ?? el.querySelector<HTMLElement>(':scope > span:first-child');
      return limparTexto(primeiro?.textContent);
    })
    .filter((t): t is string => Boolean(t));

  const url = extrairUrlAutos(cartao, idTaskInstance, pjeOrigin, numeroProcesso);

  if (debugCartaoLogado < 2) {
    debugCartaoLogado += 1;
    console.log(
      `${LOG_PREFIX} cartão exemplo:`,
      JSON.stringify({
        idTaskInstance,
        numeroProcesso,
        assunto,
        dataEntradaTarefa,
        diasNaTarefa,
        prioritario,
        etiquetas,
        url
      })
    );
  }

  return {
    idProcesso: idTaskInstance,
    numeroProcesso,
    assunto,
    orgao,
    poloAtivo,
    poloPassivo,
    dataEntradaTarefa,
    diasNaTarefa,
    dataUltimoMovimento: null,
    diasUltimoMovimento: null,
    dataConclusao: null,
    diasDesdeConclusao: null,
    ultimaMovimentacaoTexto: ultimaMov || null,
    prioritario,
    sigiloso,
    etiquetas,
    url
  };
}

/**
 * Calcula dias decorridos desde uma data no formato `dd-mm-aa` (PJe usa
 * 2 dígitos no ano). Heurística: anos 70–99 → 1970-1999; 00–69 → 2000-2069.
 */
function calcularDiasDesde(dataDdMmAa: string): number | null {
  const m = dataDdMmAa.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const aa = Number(m[3]);
  const ano = aa >= 70 ? 1900 + aa : 2000 + aa;
  const data = new Date(ano, mes - 1, dia);
  if (Number.isNaN(data.getTime())) return null;
  const hoje = new Date();
  const diff = hoje.getTime() - data.getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

/**
 * Monta a URL de consulta do processo.
 *
 * NÃO CLICAR EM BOTÃO ALGUM AQUI: o handler Angular do
 * `<pje-link-autos-digitais>` dispara `window.open` assincronamente (não
 * dá pra interceptar com swap síncrono) e clicar em todos os cartões
 * abre dezenas de abas reais.
 *
 * Estratégia:
 *   1) Se o cartão contém um `<a href>` apontando para um endpoint do
 *      PJe (ConsultaProcesso, documentos.seam, DetalheProcesso...),
 *      usamos esse href diretamente — é o deep-link "oficial" que já
 *      inclui `idProcesso`/`ca`.
 *   2) Caso contrário, fallback para a Consulta Pública do `pjeconsulta`
 *      com o número CNJ. IMPORTANTE: usamos `/pjeconsulta/` direto (sem
 *      redirect a partir de `/pje/`) — no redirect o PJe TRF5 solta o
 *      parâmetro `numeroProcesso` e o usuário cai na busca em branco.
 */
function extrairUrlAutos(
  cartao: HTMLElement,
  _idTaskInstance: string,
  pjeOrigin: string,
  numeroProcessoBruto: string
): string {
  const href = procurarHrefNoCartao(cartao, pjeOrigin);
  if (href) return href;

  const m = numeroProcessoBruto.match(/[\d.\-]+/);
  const num = m ? m[0] : numeroProcessoBruto;
  return (
    `${pjeOrigin}/pjeconsulta/ConsultaPublica/listView.seam?numeroProcesso=` +
    encodeURIComponent(num)
  );
}

/**
 * Busca dentro do cartão um `<a href>` que aponte para a página do
 * processo. Aceita tanto href absoluto quanto relativo (normaliza com
 * `pjeOrigin`). Retorna null se nada aproveitável for encontrado.
 */
function procurarHrefNoCartao(cartao: HTMLElement, pjeOrigin: string): string | null {
  const anchors = Array.from(cartao.querySelectorAll<HTMLAnchorElement>('a[href]'));
  if (debugAnchorsLogado < 2) {
    debugAnchorsLogado += 1;
    console.log(
      `${LOG_PREFIX} anchors no cartão (${anchors.length}):`,
      anchors.slice(0, 8).map((a) => ({
        href: a.getAttribute('href'),
        cls: a.className,
        txt: (a.textContent ?? '').replace(/\s+/g, ' ').trim().substring(0, 60)
      }))
    );
  }
  const padroesUteis = /ConsultaProcesso|DetalheProcesso|documentos\.seam|autos-digitais|painel-usuario-interno\/detalhe/i;
  for (const a of anchors) {
    const raw = a.getAttribute('href') ?? '';
    if (!raw) continue;
    if (raw.startsWith('#') || raw === 'javascript:void(0)') continue;
    if (!padroesUteis.test(raw)) continue;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('/')) return pjeOrigin + raw;
    return `${pjeOrigin}/${raw}`;
  }
  return null;
}

let debugAnchorsLogado = 0;

function limparTexto(
  raw: string | null | undefined,
  opts: { stripTrailingX?: boolean } = {}
): string {
  if (!raw) return '';
  let t = raw.replace(/\s+/g, ' ').trim();
  if (opts.stripTrailingX) {
    t = t.replace(/\s+X\s*$/i, '').trim();
  }
  return t;
}

// =====================================================================
// Diagnóstico
// =====================================================================

/**
 * Dumpa o outerHTML de cartões que NÃO geraram processo (lerCartao
 * devolveu null). Executa no máximo 2 amostras por tarefa para não
 * poluir o console.
 */
let debugDescartadoLogado = 0;
function debugDumpCartoesDescartados(ul: HTMLElement): void {
  if (debugDescartadoLogado >= 2) return;
  const cartoes = Array.from(ul.querySelectorAll<HTMLElement>(SELETOR_CARTAO));
  for (const c of cartoes) {
    if (lerCartao(c, '') !== null) continue;
    debugDescartadoLogado += 1;
    const html = c.outerHTML;
    console.log(
      `${LOG_PREFIX} cartão DESCARTADO (sem idTaskInstance reconhecível):`,
      html.length > 2000 ? html.substring(0, 2000) + '... [+truncado]' : html
    );
    if (debugDescartadoLogado >= 2) break;
  }
}

/**
 * Quando o paginador não é encontrado, dumpa candidatos — qualquer
 * elemento cuja classe contenha "paginat" ou que tenha aria-label
 * referindo "próxim/next".
 */
function debugDumpPaginador(): void {
  const tag = '[pAIdegua][debug-paginador]';
  const porClasse = Array.from(
    document.querySelectorAll<HTMLElement>('[class*="paginat" i]')
  );
  const porAria = Array.from(
    document.querySelectorAll<HTMLElement>('[aria-label*="próxim" i], [aria-label*="next" i]')
  );
  console.log(
    `${tag} elementos com classe contendo "paginat" (${porClasse.length}):`,
    porClasse.slice(0, 10).map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: el.className,
      aria: el.getAttribute('aria-label'),
      disabled:
        el.classList.contains('ui-state-disabled') ||
        el.classList.contains('p-disabled') ||
        el.hasAttribute('disabled')
    }))
  );
  console.log(
    `${tag} elementos com aria-label "próxim/next" (${porAria.length}):`,
    porAria.slice(0, 10).map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: el.className,
      aria: el.getAttribute('aria-label')
    }))
  );
}

function debugDumpDom(): void {
  const tag = '[pAIdegua][debug-tarefas]';
  console.log(`${tag} URL atual:`, window.location.href);
  const links = document.querySelectorAll(SELETOR_LINK_TAREFA);
  const todosNome = document.querySelectorAll('.nome');
  const todosAnchors = document.querySelectorAll('a[href]');
  console.log(
    `${tag} linksTarefa=`,
    links.length,
    ' totalAnchors=',
    todosAnchors.length,
    ' .nome=',
    todosNome.length
  );
  if (todosNome.length > 0) {
    console.log(
      `${tag} amostra .nome:`,
      Array.from(todosNome).slice(0, 5).map((el) => el.textContent?.trim())
    );
  }
}

// =====================================================================
// Utilitários
// =====================================================================

async function waitForCondition(
  cond: () => boolean,
  timeoutMs: number,
  pollMs = 120
): Promise<void> {
  const start = Date.now();
  if (cond()) return;
  await new Promise<void>((resolve, reject) => {
    const id = window.setInterval(() => {
      if (cond()) {
        window.clearInterval(id);
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        window.clearInterval(id);
        reject(new Error(`Timeout (${timeoutMs}ms) aguardando condição DOM.`));
      }
    }, pollMs);
  });
}

async function pedirAberturaDashboard(
  payload: TriagemDashboardPayload
): Promise<boolean> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TRIAGEM_OPEN_DASHBOARD,
      payload
    });
    return Boolean(resp?.ok);
  } catch (err) {
    console.warn(`${LOG_PREFIX} pedirAberturaDashboard falhou:`, err);
    return false;
  }
}
