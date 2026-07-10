/**
 * Rota B rápida da coleta PREVJUD — fetch SSR + replicação do POST A4J,
 * sem abrir aba (GES-10).
 *
 * Fluxo (roda no content script do PJe, same-origin — cookies vão junto):
 *   1. GET `listAutosDigitais.seam?idProcesso&ca` — estabelece a view JSF
 *      no servidor e devolve o HTML com o form `navbar` + ViewState.
 *   2. POST no mesmo endereço replicando o `A4J.AJAX.Submit('navbar', …)`
 *      do link "Verificar ordens PREVJUD": todos os campos do form
 *      serializados (como o A4J faz) + o parâmetro do link + ViewState +
 *      `AJAX:EVENTS_COUNT=1`.
 *   3. A resposta parcial A4J traz o HTML re-renderizado com a seção
 *      `#divListaIntimacaoInss`; as linhas são extraídas por índice de
 *      coluna 0–9 (mesma lógica do scraper em aba invisível).
 *
 * ~0,5–1s por processo vs ~2–3s da aba. Mesma semântica de resultado
 * (`PrevjudColetaProcessoResult`): `vazio` quando a seção renderiza sem
 * linhas; erro quando a seção não aparece (ViewState rejeitado, sessão
 * expirada, menu ausente) — o coletor então cai para a aba invisível.
 *
 * Padrão fetch SSR + DOMParser já provado no Metas CNJ e Prazos na Fita.
 * Contexto completo: docs/extracao-ordens-prevjud-pje.md.
 */

import type {
  PrevjudColetaProcessoResult,
  RawPrevjudRow
} from '../../shared/types';

const TIMEOUT_MS = 30_000;

async function fetchTexto(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...init,
      credentials: 'include',
      signal: ctrl.signal
    });
    const text = await resp.text();
    return { status: resp.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrai as linhas da tabela "Intimações INSS" de um Document.
 * Retornos: `null` = seção ausente (erro); `[]` = seção presente sem
 * linhas (processo sem ordem); array = linhas cruas por índice de coluna.
 */
function extrairLinhas(doc: Document): RawPrevjudRow[] | null {
  const container = doc.getElementById('divListaIntimacaoInss');
  if (!container) return null;
  const tabela = container.querySelector('table.rich-table');
  if (!tabela) return [];
  const linhas = Array.from(
    tabela.querySelectorAll('tbody tr.rich-table-row')
  );
  return linhas.map((tr) => {
    const celulas = Array.from(tr.querySelectorAll('td.rich-table-cell')).map(
      (td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()
    );
    let urlDocumento: string | null = null;
    const a = tr.querySelector('a.link-processo-documento');
    if (a) {
      const m = (a.getAttribute('onclick') ?? '').match(
        /window\.open\('([^']+)'/
      );
      if (m) urlDocumento = m[1];
    }
    return { celulas, urlDocumento };
  });
}

/**
 * Serializa os campos do form como o `A4J.AJAX.Submit` faria: todos os
 * inputs/selects/textareas com `name`, pulando checkboxes/radios
 * desmarcados e botões.
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

export async function coletarOrdensPrevjudViaSSR(opts: {
  /** URL completa dos autos (`listAutosDigitais.seam?idProcesso&ca…`). */
  url: string;
  timeoutMs?: number;
}): Promise<PrevjudColetaProcessoResult> {
  const inicio = Date.now();
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  try {
    // 1) GET da página dos autos — cria a view JSF e entrega o ViewState.
    const get = await fetchTexto(opts.url, { method: 'GET' }, timeoutMs);
    if (get.status !== 200) {
      return { ok: false, error: `HTTP ${get.status} no GET dos autos.` };
    }
    const docGet = new DOMParser().parseFromString(get.text, 'text/html');
    const form = docGet.querySelector('form[id="navbar"]');
    const viewState =
      docGet
        .querySelector<HTMLInputElement>('input[name="javax.faces.ViewState"]')
        ?.value ?? '';
    if (!form || !viewState) {
      return {
        ok: false,
        error:
          'Página dos autos sem form navbar/ViewState — sessão expirada ou layout inesperado.'
      };
    }
    if (!docGet.getElementById('navbar:linkVerificarIntimacoesInss')) {
      return {
        ok: false,
        error: 'Menu "Verificar ordens PREVJUD" ausente na página do processo.'
      };
    }

    // 2) POST A4J replicado. `AJAXREQUEST=_viewRoot` é o marcador que faz o
    //    filtro AJAX4JSF processar a requisição no ciclo Ajax e disparar o
    //    action do link — sem ele o servidor trata como postback comum,
    //    devolve a página inteira e NÃO renderiza a seção (sintoma
    //    observado: len grande, temViewState/temLinkPrevjud, sem a tabela).
    const params = serializarForm(form);
    params.set('AJAXREQUEST', '_viewRoot');
    params.set('javax.faces.ViewState', viewState);
    params.set(
      'navbar:linkVerificarIntimacoesInss',
      'navbar:linkVerificarIntimacoesInss'
    );
    params.set('AJAX:EVENTS_COUNT', '1');
    const action =
      form.getAttribute('action') ??
      '/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam';
    const postUrl = new URL(action, opts.url).toString();

    const post = await fetchTexto(
      postUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          // Sem este header o filtro AJAX4JSF (RichFaces 3.3.3) NÃO trata a
          // requisição como Ajax e não dispara o action do link — devolve a
          // página sem re-renderizar a seção. É o que o A4J.AJAX.Submit
          // manda por baixo dos panos (via XMLHttpRequest).
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: params.toString()
      },
      timeoutMs
    );
    if (post.status !== 200) {
      return { ok: false, error: `HTTP ${post.status} no POST A4J.` };
    }

    // 3) A resposta traz a página inteira re-renderizada (~248KB). Em vez
    //    de jogar tudo no DOMParser (caro por processo × alta concorrência),
    //    localiza a seção por string e parseia SÓ o fragmento da tabela.
    const marker = 'divListaIntimacaoInss';
    const mi = post.text.indexOf(marker);
    if (mi === -1) {
      // Seção ausente = action A4J não disparou / sessão / layout mudou.
      const t = post.text;
      const pistas = [
        `len=${t.length}`,
        t.includes('javax.faces.ViewState') ? 'temViewState' : 'semViewState',
        t.includes('linkVerificarIntimacoesInss') ? 'temLinkPrevjud' : 'semLinkPrevjud',
        /login|autentica|sess[aã]o expir/i.test(t) ? 'PARECE-LOGIN' : '',
        /Intima[çc][õo]es INSS/i.test(t) ? 'temTituloIntimacoes' : ''
      ]
        .filter(Boolean)
        .join(' ');
      return {
        ok: false,
        error: `Resposta A4J sem a seção "Intimações INSS" (${pistas}).`
      };
    }
    // Recorta do `<div ...id="divListaIntimacaoInss">` até o fim do form que
    // envolve a tabela — algumas KB em vez de centenas.
    const inicioDiv = post.text.lastIndexOf('<div', mi);
    const fimForm = post.text.indexOf('</form>', mi);
    const fragmento = post.text.slice(
      inicioDiv >= 0 ? inicioDiv : mi,
      fimForm >= 0 ? fimForm + 7 : Math.min(post.text.length, mi + 40_000)
    );
    const docPost = new DOMParser().parseFromString(fragmento, 'text/html');
    const linhas = extrairLinhas(docPost);
    if (linhas === null) {
      // Fragmento recortado mas sem a tabela esperada — layout inesperado.
      return {
        ok: false,
        error: 'Seção "Intimações INSS" localizada, mas sem a tabela esperada.'
      };
    }
    return linhas.length === 0
      ? { ok: true, vazio: true, linhas: [], duracaoMs: Date.now() - inicio }
      : { ok: true, linhas, duracaoMs: Date.now() - inicio };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
