/**
 * Coletor de documentos do processo para a feature "Resumo dos processos
 * da pauta" (AUD-10). Usado quando o magistrado clica "Resumir" em uma
 * linha da tabela na aba `audiencia-resumo/resumo.html`.
 *
 * Fluxo:
 *   1. GET `listAutosDigitais.seam?id=X&ca=Y` (same-origin com cookies do PJe).
 *   2. Parse do HTML → `extractDocumentosFromDoc()` devolve a timeline.
 *   3. Filtra por tipo relevante (modo='filtrado') ou mantém tudo (modo='todos').
 *   4. Chama `extractContents()` para baixar o PDF de cada um e extrair texto.
 *   5. Devolve `ProcessoDocumento[]` com `textoExtraido` preenchido + estatísticas.
 *
 * Tipos relevantes (modo filtrado): petição inicial, emenda, contestação,
 * decisão, despacho, sentença, laudo, ata, documento comprobatório e
 * principais petições. Cobre o roteiro de audiência sem baixar trivialidades
 * (citações, intimações, certidões de juntada, recibos, etc.).
 *
 * Sem cache: o magistrado pode pedir o mesmo processo várias vezes
 * (modo filtrado vs. completo) — cada pedido refaz a coleta.
 */

import { LOG_PREFIX, STORAGE_KEYS } from '../../shared/constants';
import type { ProcessoDocumento } from '../../shared/types';
import { extractDocumentosFromDoc } from '../adapters/pje-legacy';
import {
  conteudoUtilLength,
  extractContents,
  getOcrPendingDocuments,
  runOcrOnDocumentsViaOffscreen
} from '../extractor';

/**
 * Caps do OCR para o fluxo de Resumo (AUD-10).
 *
 * Tesseract.js custa ~5s/doc (medido na sidebar: 22 docs em 120s). Com
 * cap de 8 docs × 5 páginas, OCR completo gasta ~40-60s adicionais
 * sobre o tempo de download. Aceitável para o usuário esperar uma vez.
 *
 * Respeitamos a setting `ocrMaxPages` do usuário se for menor que o
 * teto rígido — quem prefere processar menos páginas (ex.: 2-3) não
 * é forçado a esperar mais.
 *
 * O OCR roda no offscreen document (não throttled), via
 * `runOcrOnDocumentsViaOffscreen`. O timeout total deste fluxo é
 * calculado dinamicamente (90s/doc + 30s de folga) na chamada.
 */
const OCR_MAX_PAGES_POR_DOC_HARD = 5;
const OCR_MAX_DOCS = 8;

const LOG = `${LOG_PREFIX} [audiencia-resumo-docs]`;

/**
 * Regex case/acento-insensível para tipos de documento que entram no resumo
 * em modo "filtrado". Aplicada sobre `ProcessoDocumento.tipo`.
 */
const REGEX_TIPOS_RELEVANTES = new RegExp(
  [
    'petição inicial',
    'emenda',
    'contestação|contestacao',
    'despacho',
    'decisão|decisao',
    'sentença|sentenca',
    'acórdão|acordao',
    'laudo',
    'ata',
    'documento comprobatório|documento comprobatorio',
    // Petições genéricas (réplica, manifestação, alegações, juntada de docs)
    'petição|peticao'
  ].join('|'),
  'i'
);

export type ColetarDocsModo = 'filtrado' | 'todos';

export interface ColetarDocsInput {
  legacyOrigin: string;
  idProcesso: number;
  ca: string;
  modo: ColetarDocsModo;
  /**
   * Quando presente, o coletor escreve o status textual da fase atual
   * em `chrome.storage.session` sob a chave
   * `${AUDIENCIA_RESUMO_COLETA_PROGRESS_PREFIX}${progressKey}`. A aba
   * escuta `storage.onChanged` e atualiza a label do modal em tempo
   * real. Sem chave, o coletor opera silencioso.
   */
  progressKey?: string;
}

export interface ColetarDocsResult {
  ok: boolean;
  /** Documentos baixados com `textoExtraido` preenchido (ou stub quando falhou). */
  documentos: ProcessoDocumento[];
  /** Total de documentos listados na timeline (antes do filtro). */
  totalListados: number;
  /** Quantos foram efetivamente baixados (após filtro). */
  totalBaixados: number;
  /** Total de chars de texto extraído somando todos os documentos. */
  totalChars: number;
  error?: string;
}

export async function coletarDocumentosDoProcesso(
  input: ColetarDocsInput
): Promise<ColetarDocsResult> {
  if (!input.idProcesso || !input.ca) {
    return {
      ok: false,
      documentos: [],
      totalListados: 0,
      totalBaixados: 0,
      totalChars: 0,
      error: 'idProcesso/ca ausentes.'
    };
  }

  // Emissor de progresso (no-op se progressKey ausente).
  const setProg = (msg: string): void => {
    if (!input.progressKey) return;
    const key =
      `${STORAGE_KEYS.AUDIENCIA_RESUMO_COLETA_PROGRESS_PREFIX}${input.progressKey}`;
    void chrome.storage.session.set({ [key]: { msg, ts: Date.now() } });
  };
  setProg('Listando documentos do processo...');

  // 1. GET timeline.
  const url =
    `${input.legacyOrigin.replace(/\/$/, '')}` +
    `/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam` +
    `?id=${input.idProcesso}&ca=${encodeURIComponent(input.ca)}`;

  let html: string;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    if (!resp.ok) {
      return {
        ok: false,
        documentos: [],
        totalListados: 0,
        totalBaixados: 0,
        totalChars: 0,
        error: `HTTP ${resp.status} ao baixar listAutosDigitais.`
      };
    }
    html = await resp.text();
  } catch (err) {
    console.warn(`${LOG} GET listAutosDigitais falhou:`, err);
    return {
      ok: false,
      documentos: [],
      totalListados: 0,
      totalBaixados: 0,
      totalChars: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  if (detectarSessaoExpirada(html)) {
    return {
      ok: false,
      documentos: [],
      totalListados: 0,
      totalBaixados: 0,
      totalChars: 0,
      error: 'Sessão do PJe expirada. Faça login novamente.'
    };
  }

  // 2. Parse inicial + paginação da timeline. PJe legacy usa lazy-loading
  // RichFaces 3.x: a página devolve só o primeiro lote (~15-20 docs);
  // os demais entram via POST AJAX disparado pelo auto-scroll. Sem
  // paginar, processos longos (50+ docs) entrariam só com 1/3 da
  // timeline — déficit de docs reportado pelo usuário.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  setProg('Lendo histórico do processo (parte 1)...');
  const todos = await coletarTodasPaginasTimeline({
    legacyOrigin: input.legacyOrigin,
    initialDoc: doc,
    initialHtml: html,
    onPagina: (atual, total) => {
      setProg(`Lendo histórico do processo (parte ${atual} de ${total})...`);
    }
  });
  const totalListados = todos.length;

  // 2.b Auto-scroll do DOM real: quando estamos na aba do processo
  // (`listAutosDigitais.seam`), forçar scroll do container da timeline
  // faz o RichFaces popular TODOS os nós da árvore no DOM. Isso é
  // pré-requisito pra `activateDocumentInPje` (clique fantasma) achar
  // os docs que não vieram no primeiro paint. Sem isso, ~17 docs em
  // processos longos voltam com 0 bytes do REST endpoint mesmo com
  // a aba carregada (fix incompleto antes deste passo).
  if (
    input.modo === 'todos' &&
    typeof window !== 'undefined' &&
    /\/Detalhe\/listAutosDigitais\.seam/i.test(window.location.href)
  ) {
    setProg('Carregando lista completa de documentos do processo...');
    await autoScrollTimelineDom();
  }

  if (todos.length === 0) {
    return {
      ok: true,
      documentos: [],
      totalListados: 0,
      totalBaixados: 0,
      totalChars: 0
    };
  }

  // 3. Filtro por tipo (modo='filtrado').
  const filtrados =
    input.modo === 'filtrado'
      ? todos.filter((d) => REGEX_TIPOS_RELEVANTES.test(d.tipo ?? ''))
      : todos;

  if (filtrados.length === 0) {
    return {
      ok: true,
      documentos: [],
      totalListados,
      totalBaixados: 0,
      totalChars: 0
    };
  }

  // 4. Download + extração de texto. `extractContents` faz fetch+parsePdf
  // por documento com pool interno; tolerante a falhas individuais (doc
  // que falha é descartado). `silent: true` suprime o `console.warn`
  // por documento — falhas são esperadas aqui (estamos baixando docs
  // de processos que o usuário não tem aberto, então `ca` ou
  // permissões podem não cobrir todos).
  setProg(`Lendo conteúdo dos documentos: 0 de ${filtrados.length}...`);
  let extraidos: ProcessoDocumento[];
  let extraidosCountFinal = 0;
  let errosCountFinal = 0;
  // Coleta erros do extract pra log agregado no final — diagnostica
  // padrões (HTTP 403 em sigilosos, MIME inesperado, URL errada).
  const errosExtracao: Array<{ id: string; tipo?: string; descricao?: string; error: string; diagnosticsTail?: string }> = [];
  try {
    let extraidosCount = 0;
    let errosCount = 0;
    extraidos = await extractContents(
      filtrados,
      (ev) => {
        if (ev.type === 'document-done') {
          extraidosCount++;
          setProg(
            `Lendo conteúdo dos documentos: ${extraidosCount + errosCount} de ${filtrados.length}...`
          );
        } else if (ev.type === 'document-error') {
          errosCount++;
          const last = ev.diagnostics?.[ev.diagnostics.length - 1];
          errosExtracao.push({
            id: ev.documento.id,
            tipo: ev.documento.tipo,
            descricao: ev.documento.descricao,
            error: ev.error,
            diagnosticsTail: last
              ? `${last.etapa}: ${last.detalhe}`
              : undefined
          });
          setProg(
            `Lendo conteúdo dos documentos: ${extraidosCount + errosCount} de ${filtrados.length}...`
          );
        }
      },
      { silent: true }
    );
    extraidosCountFinal = extraidosCount;
    errosCountFinal = errosCount;
  } catch (err) {
    console.warn(`${LOG} extractContents falhou:`, err);
    return {
      ok: false,
      documentos: [],
      totalListados,
      totalBaixados: 0,
      totalChars: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  // 5. OCR para documentos digitalizados — best-effort, COM CAP. Tesseract
  // é caro (segundos por página); cap em OCR_MAX_DOCS docs e
  // OCR_MAX_PAGES_POR_DOC páginas evita esperas de 10+ minutos em
  // dossiês gigantes. Sem OCR esses docs chegariam à IA como
  // "[documento digitalizado — OCR ainda não disponível]" — tags
  // técnicas que poluem o prompt e podem vazar para a sentença gerada.
  // A normalização abaixo garante que NENHUMA referência ao OCR (tag
  // "via OCR", flag isScanned, doc sem texto) chegue ao prompt final.
  // OCR via offscreen document — não sofre throttling de tab background
  // (Chrome ≥88), problema crítico do fluxo de Resumo da Pauta porque o
  // usuário fica na aba do resumo, deixando PJe em background.
  try {
    const pendentesTodos = getOcrPendingDocuments(extraidos);
    if (pendentesTodos.length > 0) {
      const userMaxPages = await lerOcrMaxPagesUsuario();
      const maxPages = userMaxPages
        ? Math.min(userMaxPages, OCR_MAX_PAGES_POR_DOC_HARD)
        : OCR_MAX_PAGES_POR_DOC_HARD;

      const pendentes = pendentesTodos.slice(0, OCR_MAX_DOCS);
      const totalOcr = pendentes.length;
      let ocrCount = 0;
      setProg(
        `Reconhecendo texto em ${totalOcr} documento(s) digitalizado(s) ` +
          `(pode levar alguns minutos, mantenha esta aba aberta)...`
      );

      // Timeout total: 90s/doc é o orçamento (offscreen tem timeout
      // próprio de 90s/doc). Soma + 30s de folga para handshake.
      const timeoutMs = totalOcr * 90_000 + 30_000;
      const ocred = await comTimeout(
        runOcrOnDocumentsViaOffscreen(
          pendentes,
          (ev) => {
            if (ev.type === 'ocr-document-done' || ev.type === 'ocr-document-error') {
              ocrCount++;
              setProg(
                `Reconhecendo texto em documentos digitalizados: ${ocrCount} de ${totalOcr}...`
              );
            }
          },
          // skipTabFocus: estamos rodando em aba oculta auxiliar criada
          // pelo background. NÃO podemos pedir para ativar essa aba — isso
          // roubaria o foco do usuário (que está na aba do Resumo da Pauta).
          // O custo de tolerar throttling de timer é menor que o custo de
          // UX de a aba PJe pular para o primeiro plano sem pedido.
          { maxPages, skipTabFocus: true }
        ),
        timeoutMs,
        'OCR offscreen global'
      );
      const mapaOcr = new Map<string, ProcessoDocumento>(
        ocred.map((d) => [d.id, d])
      );
      extraidos = extraidos.map((d) => mapaOcr.get(d.id) ?? d);
    }
  } catch (err) {
    // OCR é best-effort: se falhar OU timeout, segue com o que extraímos antes.
    console.info(`${LOG} OCR best-effort falhou (segue sem OCR):`, err);
    setProg('Continuando sem o reconhecimento de texto em alguns documentos...');
  }
  setProg('Finalizando coleta...');

  // 6. Normalização final para a IA: remove referências técnicas ao OCR
  // (a flag `isScanned` faz `buildDocumentContext` injetar " | texto via
  // OCR" no cabeçalho de cada doc). Como o usuário pode ler o resumo /
  // sentença, qualquer marca como essa pode vazar no texto gerado.
  // Também descartamos docs que ficaram sem texto útil — entrar com
  // "[conteúdo não extraído]" só atrapalha a IA. Atenção: medir CONTEÚDO
  // real (sem os markers `=== Página N ===` que a parsePdf insere), pra
  // não passar batido um PDF digitalizado vazio que tem só os markers
  // (~18 chars/página → 54 chars em 3 páginas, fura o threshold cru e
  // chega na IA com header "Documento de identificação..." sem corpo,
  // levando a IA a inventar "precisa de OCR" no resumo final).
  const documentosLimpos: ProcessoDocumento[] = [];
  const dropadosPorTextoCurto: Array<{ id: string; tipo?: string; isScanned?: boolean; chars: number }> = [];
  for (const doc of extraidos) {
    const texto = (doc.textoExtraido ?? '').trim();
    const conteudoChars = conteudoUtilLength(texto);
    if (conteudoChars < 50) {
      dropadosPorTextoCurto.push({
        id: doc.id,
        tipo: doc.tipo,
        isScanned: doc.isScanned,
        chars: conteudoChars
      });
      continue;
    }
    documentosLimpos.push({
      ...doc,
      isScanned: false,
      textoExtraido: texto
    });
  }

  const totalChars = documentosLimpos.reduce(
    (acc, d) => acc + (d.textoExtraido?.length ?? 0),
    0
  );

  // Diagnóstico detalhado: ajuda a identificar quando o gap entre `listados`
  // e `extraídos com texto útil` é por OCR não-rodado, fetch falho, ou docs
  // genuinamente vazios. Inclui breakdown por etapa e amostra dos dropados.
  console.info(
    `${LOG} processo ${input.idProcesso} — pipeline:\n` +
      `  ${totalListados} listados na timeline (todas as páginas)\n` +
      `  ${filtrados.length} selecionados (modo=${input.modo})\n` +
      `  ${extraidosCountFinal} extraídos OK pelo extractContents (${errosCountFinal} erros de download/parse)\n` +
      `  ${dropadosPorTextoCurto.length} dropados por texto < 50 chars (após OCR)\n` +
      `  ${documentosLimpos.length} restantes com texto útil — total ${totalChars} chars`
  );

  if (errosExtracao.length > 0) {
    // Diagnóstico — info para não poluir o painel "Erros" da extensão
    // (Edge captura console.warn como erro). Útil em DevTools sem
    // alarmar o usuário no chrome://extensions.
    const padroes = new Map<string, number>();
    for (const e of errosExtracao) {
      const k = e.diagnosticsTail ?? e.error;
      padroes.set(k, (padroes.get(k) ?? 0) + 1);
    }
    console.info(
      `${LOG} ${errosExtracao.length} doc(s) falharam no download/parse — padrões:`,
      Array.from(padroes.entries()).map(([padrao, n]) => `${n}× ${padrao}`).join(' | ')
    );
    console.info(
      `${LOG} amostra dos doc(s) que falharam (até 10):`,
      errosExtracao.slice(0, 10)
    );
  }
  if (dropadosPorTextoCurto.length > 0) {
    const scannedSemTexto = dropadosPorTextoCurto.filter((d) => d.isScanned);
    if (scannedSemTexto.length > 0) {
      console.info(
        `${LOG} ${scannedSemTexto.length} doc(s) digitalizado(s) ainda sem texto após OCR — ` +
          `OCR offscreen pode ter falhado para estes. Amostra:`,
        scannedSemTexto.slice(0, 5)
      );
    }
    const naoScannedSemTexto = dropadosPorTextoCurto.filter((d) => !d.isScanned);
    if (naoScannedSemTexto.length > 0) {
      console.info(
        `${LOG} ${naoScannedSemTexto.length} doc(s) não-digitalizado(s) sem texto útil ` +
          `(provavelmente HTML/áudio/vídeo). Amostra:`,
        naoScannedSemTexto.slice(0, 5)
      );
    }
  }

  return {
    ok: true,
    documentos: documentosLimpos,
    totalListados,
    totalBaixados: documentosLimpos.length,
    totalChars
  };
}

// ============================================================================
// Paginação da timeline (RichFaces 3.x lazy-loading)
// ============================================================================

/**
 * O componente do timeline expõe dois inputs hidden no HTML:
 *   <input type="hidden" id="totalPaginas" value="3" />
 *   <input type="hidden" id="paginaAtual" value="1" />
 * Cada AJAX `autoScroll` avança o cursor server-side em 1; o response
 * traz o HTML da próxima página + esses dois inputs atualizados.
 * Loop encerra quando `paginaAtual === totalPaginas` ou quando uma
 * página não traz docs novos (segurança contra loop infinito).
 */
const REGEX_TOTAL_PAGINAS = /id=["']totalPaginas["'][^>]*value=["'](\d+)["']/i;
const REGEX_PAGINA_ATUAL = /id=["']paginaAtual["'][^>]*value=["'](\d+)["']/i;
const REGEX_VIEWSTATE =
  /name=["']javax\.faces\.ViewState["'][^>]*value=["']([^"']+)["']/i;

/**
 * ID do componente RichFaces que dispara o autoScroll. Hardcoded com base no
 * tráfego capturado em pje1g.trf5.jus.br (10/05/2026): `divTimeLine:j_id433`.
 * JSF gera esses IDs deterministicamente pela ordem dos componentes na view,
 * então se o template do PJe mudar isso pode quebrar — fallback aceitável é
 * "loop não roda" e voltamos só com primeira página.
 */
const AUTO_SCROLL_TRIGGER_ID = 'divTimeLine:j_id433';

/** Limite de páginas extras buscadas — proteção contra loop em caso de bug. */
const MAX_PAGINAS_EXTRAS = 30;

interface ColetarTodasInput {
  legacyOrigin: string;
  initialDoc: Document;
  initialHtml: string;
  onPagina?: (paginaAtual: number, totalPaginas: number) => void;
}

async function coletarTodasPaginasTimeline(
  input: ColetarTodasInput
): Promise<ReturnType<typeof extractDocumentosFromDoc>> {
  const acumulado = new Map<string, ReturnType<typeof extractDocumentosFromDoc>[number]>();

  // Adiciona docs da página 1 (já no HTML inicial).
  for (const d of extractDocumentosFromDoc(input.initialDoc)) {
    acumulado.set(d.id, d);
  }

  const totalPaginas = lerNumeroDoHtml(input.initialHtml, REGEX_TOTAL_PAGINAS);
  const paginaInicial = lerNumeroDoHtml(input.initialHtml, REGEX_PAGINA_ATUAL) ?? 1;
  let viewState = lerStringDoHtml(input.initialHtml, REGEX_VIEWSTATE);

  input.onPagina?.(paginaInicial, totalPaginas ?? paginaInicial);

  if (!totalPaginas || totalPaginas <= paginaInicial) {
    return Array.from(acumulado.values());
  }
  if (!viewState) {
    console.warn(
      `${LOG} ViewState não encontrado no HTML inicial — paginação pulada (só primeira página).`
    );
    return Array.from(acumulado.values());
  }

  let paginaAtual = paginaInicial;
  const url =
    `${input.legacyOrigin.replace(/\/$/, '')}` +
    `/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam`;

  for (let i = 0; i < MAX_PAGINAS_EXTRAS && paginaAtual < totalPaginas; i++) {
    let respHtml: string;
    try {
      respHtml = await fetchTimelineProximaPagina(url, viewState);
    } catch (err) {
      console.warn(
        `${LOG} POST autoScroll página ${paginaAtual + 1} falhou (mantém o que coletei):`,
        err
      );
      break;
    }

    // O response é XML wrapper com HTML dentro — DOMParser de 'text/html'
    // ignora o XML wrapper e dá o body como esperado.
    const respDoc = new DOMParser().parseFromString(respHtml, 'text/html');
    const novosDocs = extractDocumentosFromDoc(respDoc);

    let countNovos = 0;
    for (const d of novosDocs) {
      if (!acumulado.has(d.id)) {
        acumulado.set(d.id, d);
        countNovos++;
      }
    }

    const novaPagina = lerNumeroDoHtml(respHtml, REGEX_PAGINA_ATUAL);
    const novoViewState = lerStringDoHtml(respHtml, REGEX_VIEWSTATE);
    if (novoViewState) viewState = novoViewState;

    if (novaPagina !== null && novaPagina > paginaAtual) {
      paginaAtual = novaPagina;
    } else {
      // Servidor não avançou — para evitar loop infinito. Cenário comum
      // (última página) — info, não warn (warn vira "erro" no painel).
      console.info(
        `${LOG} servidor não avançou paginaAtual (era ${paginaAtual}, response trouxe ${novaPagina}). Encerrando paginação.`
      );
      break;
    }

    input.onPagina?.(paginaAtual, totalPaginas);

    // Se a página veio sem novos docs (e ainda não terminou), provavelmente
    // o servidor está repetindo conteúdo — para por segurança.
    if (countNovos === 0) {
      console.info(
        `${LOG} página ${paginaAtual} sem documentos novos — encerrando paginação.`
      );
      break;
    }
  }

  console.info(
    `${LOG} timeline paginada: ${acumulado.size} doc(s) total ` +
      `(${paginaAtual}/${totalPaginas} páginas).`
  );
  return Array.from(acumulado.values());
}

async function fetchTimelineProximaPagina(
  url: string,
  viewState: string
): Promise<string> {
  // Body capturado do tráfego real do PJe ao auto-scroll. Ordem dos
  // campos importa para o RichFaces 3.x reconhecer o evento.
  const body = new URLSearchParams();
  body.set('AJAXREQUEST', '_viewRoot');
  body.set('divTimeLine:txtPesquisa', '');
  body.set('divTimeLine:chkExibirDocumentos', 'on');
  body.set('divTimeLine:chkExibirMovimentos', 'on');
  body.set('divTimeLine:chkExibirAudioVideo', 'on');
  body.set('divTimeLine:modalLembretesOpenedState', '');
  body.set('divTimeLine', 'divTimeLine');
  body.set('autoScroll', '');
  body.set('javax.faces.ViewState', viewState);
  body.set(AUTO_SCROLL_TRIGGER_ID, AUTO_SCROLL_TRIGGER_ID);
  body.set('ajaxSingle', AUTO_SCROLL_TRIGGER_ID);
  body.set('AJAX:EVENTS_COUNT', '1');

  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: '*/*'
    },
    body: body.toString()
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.text();
}

function lerNumeroDoHtml(html: string, regex: RegExp): number | null {
  const m = html.match(regex);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function lerStringDoHtml(html: string, regex: RegExp): string | null {
  const m = html.match(regex);
  return m?.[1] ?? null;
}

/**
 * Auto-scrolla o container da timeline de documentos NO DOM até que
 * todos os nós da árvore RichFaces estejam materializados (lazy-render).
 *
 * Por que: `coletarTodasPaginasTimeline` pega URLs via fetch (server-
 * side), mas o DOM da aba só tem ~20 nós no paint inicial. Quando o
 * `extractContents` precisa fazer fallback de `activateDocumentInPje`
 * (clique fantasma), ele busca o ID no DOM. Se o nó não foi
 * materializado, ativação falha → 0 bytes → doc perdido. Forçando
 * scroll do container, RichFaces dispara seu próprio `autoScroll`
 * AJAX e injeta os nós faltantes no DOM.
 *
 * Convergência: roda até a contagem de docs no DOM ficar estável por
 * 2 ciclos consecutivos OU bater o cap de iterações.
 */
async function autoScrollTimelineDom(): Promise<void> {
  // Container observado: a árvore vive em `<div id="divTimeLine:divEventosTimeLine"
  // class="eventos-timeline scroll-y">`. Tentamos ambos os seletores
  // como segurança caso o ID do RichFaces mude entre versões.
  const container =
    document.querySelector<HTMLElement>('#divTimeLine\\:divEventosTimeLine') ??
    document.querySelector<HTMLElement>('.eventos-timeline.scroll-y') ??
    document.querySelector<HTMLElement>('.eventos-timeline');
  if (!container) {
    console.info(`${LOG} autoScrollTimelineDom: container da timeline não encontrado.`);
    return;
  }

  const contarDocs = (): number =>
    document.querySelectorAll('a[id^="divTimeLine:"][onclick*="A4J.AJAX.Submit"]').length;

  let estavelPor = 0;
  let prev = contarDocs();
  for (let i = 0; i < 25; i++) {
    container.scrollTop = container.scrollHeight;
    // Espera RichFaces processar o autoScroll AJAX e injetar nós novos.
    // 1.2s é um bom balanço — autoScroll responde tipicamente em 400-800ms.
    await new Promise((r) => setTimeout(r, 1_200));
    const atual = contarDocs();
    if (atual === prev) {
      estavelPor++;
      // Dois ciclos seguidos sem mudança = convergiu.
      if (estavelPor >= 2) break;
    } else {
      estavelPor = 0;
      prev = atual;
    }
  }
  console.info(
    `${LOG} autoScrollTimelineDom: ${prev} doc(s) materializado(s) no DOM da aba oculta.`
  );
}

function detectarSessaoExpirada(html: string): boolean {
  return (
    html.includes('viewExpired') ||
    html.includes('Sua sessão expirou') ||
    /location\.replace\(['"][^'"]*\/login\.seam/i.test(html)
  );
}

/**
 * Lê o cap de páginas configurado pelo usuário em `paidegua.settings.ocrMaxPages`.
 * Retorna null se não houver setting (cai no default do chamador).
 */
async function lerOcrMaxPagesUsuario(): Promise<number | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    const settings = result[STORAGE_KEYS.SETTINGS] as
      | { ocrMaxPages?: number }
      | undefined;
    if (settings?.ocrMaxPages && settings.ocrMaxPages > 0) {
      return settings.ocrMaxPages;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Envolve um Promise com timeout — se exceder, rejeita. Importante:
 * o Promise original continua executando em background até naturalmente
 * resolver/rejeitar (não há como abortar Tesseract.js no meio); essa
 * função apenas libera o caller pra seguir adiante.
 */
async function comTimeout<T>(
  p: Promise<T>,
  ms: number,
  rotulo: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${rotulo}: timeout após ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
