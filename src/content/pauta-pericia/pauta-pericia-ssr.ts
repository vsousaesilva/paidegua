/**
 * Coleta da tabela de perícia de UM processo, via fetch SSR + replicação do
 * A4J do link "Perícia" do menu do processo (`navbar:linkAbaPericia`), sem
 * abrir aba. Clone direto do `prevjud-ssr.ts` — mesmo mecanismo, trocando o
 * link e o container:
 *   - link:      `navbar:linkVerificarIntimacoesInss` → `navbar:linkAbaPericia`
 *   - container: `divListaIntimacaoInss` → `processoPericiaNovaPericiaList`
 *
 * Fluxo (roda no content script, same-origin — cookies vão junto):
 *   1. GET `listAutosDigitais.seam?idProcesso&ca` — estabelece a view JSF e
 *      entrega o form `navbar` + ViewState.
 *   2. POST replicando o `A4J.AJAX.Submit` do link "Perícia": campos do form
 *      serializados + `AJAXREQUEST=_viewRoot` + ViewState + o parâmetro do
 *      link + `AJAX:EVENTS_COUNT=1`, com header `X-Requested-With`.
 *   3. A resposta parcial A4J traz a seção `#processoPericiaNovaPericiaList`;
 *      as linhas são extraídas por índice de coluna (0–4).
 *
 * Confirmado em campo (TRF5 1G, jul/2026): 200 `text/xml`, tabela presente,
 * 5 colunas por linha (Data, Periciado, Valor, Perito, Situação).
 */

import type {
  PericiaColetaProcessoResult,
  RawPericiaRow
} from '../../shared/pauta-pericia-types';

const TIMEOUT_MS = 45_000;

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
 * Extrai as linhas da tabela de perícia de um Document (fragmento A4J).
 * Retornos: `null` = seção ausente (erro); `[]` = seção presente sem linhas
 * (processo sem perícia); array = linhas cruas por índice de coluna.
 */
function extrairLinhas(doc: Document): RawPericiaRow[] | null {
  const container = doc.getElementById('processoPericiaNovaPericiaList');
  if (!container) return null;
  const linhas = Array.from(
    container.querySelectorAll('tbody tr.rich-table-row')
  );
  return linhas.map((tr) => {
    const celulas = Array.from(tr.querySelectorAll('td.rich-table-cell')).map(
      (td) => {
        // A célula do valor tem um <script> de maskMoney embutido — remove
        // antes de ler o texto (senão o código do script poluiria a célula).
        const clone = td.cloneNode(true) as Element;
        clone.querySelectorAll('script').forEach((n) => n.remove());
        return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
      }
    );
    return { celulas };
  });
}

/** Serializa os campos do form como o `A4J.AJAX.Submit` faria. */
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

export async function coletarPericiasViaSSR(opts: {
  /** URL completa dos autos (`listAutosDigitais.seam?idProcesso&ca…`). */
  url: string;
  timeoutMs?: number;
}): Promise<PericiaColetaProcessoResult> {
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
    if (!docGet.getElementById('navbar:linkAbaPericia')) {
      return {
        ok: false,
        error: 'Menu "Perícia" ausente na página do processo.'
      };
    }

    // 2) POST A4J replicado. `AJAXREQUEST=_viewRoot` + `X-Requested-With` fazem
    //    o filtro AJAX4JSF processar a requisição no ciclo Ajax e disparar o
    //    action do link (comprovado no `prevjud-ssr` e no recon de perícia).
    const params = serializarForm(form);
    params.set('AJAXREQUEST', '_viewRoot');
    params.set('javax.faces.ViewState', viewState);
    params.set('navbar:linkAbaPericia', 'navbar:linkAbaPericia');
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
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: params.toString()
      },
      timeoutMs
    );
    if (post.status !== 200) {
      return { ok: false, error: `HTTP ${post.status} no POST A4J.` };
    }

    // 3) Localiza a seção por string e parseia SÓ o fragmento da tabela.
    const marker = 'processoPericiaNovaPericiaList';
    const mi = post.text.indexOf(marker);
    if (mi === -1) {
      const t = post.text;
      const pistas = [
        `len=${t.length}`,
        t.includes('javax.faces.ViewState') ? 'temViewState' : 'semViewState',
        t.includes('linkAbaPericia') ? 'temLinkPericia' : 'semLinkPericia',
        /login|autentica|sess[aã]o expir/i.test(t) ? 'PARECE-LOGIN' : ''
      ]
        .filter(Boolean)
        .join(' ');
      return {
        ok: false,
        error: `Resposta A4J sem a seção de perícia (${pistas}).`
      };
    }
    // Recorta do `<span id="processoPericiaNovaPericia">` (ou do `<div`
    // ancestral) até algumas KB depois — evita parsear centenas de KB.
    const inicioSpan = post.text.lastIndexOf('<span', mi);
    const inicioDiv = post.text.lastIndexOf('<div', mi);
    const inicioCorte = Math.max(
      inicioSpan >= 0 ? inicioSpan : 0,
      inicioDiv >= 0 ? inicioDiv : 0
    );
    const fimTabela = post.text.indexOf('</table>', mi);
    const fragmento = post.text.slice(
      inicioCorte,
      fimTabela >= 0 ? fimTabela + 8 : Math.min(post.text.length, mi + 60_000)
    );
    const docPost = new DOMParser().parseFromString(fragmento, 'text/html');
    const linhas = extrairLinhas(docPost);
    if (linhas === null) {
      return {
        ok: false,
        error: 'Seção de perícia localizada, mas sem a tabela esperada.'
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
