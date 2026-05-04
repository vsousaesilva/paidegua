/**
 * Coleta os dados completos de uma Pessoa Física do PJe legacy a
 * partir do CPF, navegando programaticamente a tela JSF em
 * `/pje/PessoaFisica/listView.seam`.
 *
 * Por que JSF e não REST: o REST do PJe TRF5 1g não expõe esse
 * cadastro publicamente — verificado em 2026-05-03 com 4xx em todas
 * as rotas tentadas (`/seam/resource/rest/pessoaFisica/*`,
 * `/processos/{id}/partes`, etc.). A tela administrativa usa Seam +
 * RichFaces com state stateful (`javax.faces.ViewState`), então cada
 * postback exige enviar o ViewState corrente. A dança é:
 *
 *   1. GET inicial em `/pje/PessoaFisica/listView.seam` para capturar
 *      o ViewState e os parâmetros do form de busca.
 *   2. POST do `pessoaFisicaGridSearchForm` com `numeroCPF` mascarado.
 *      O servidor responde com a tabela renderizada via partial render
 *      A4J — o HTML retornado contém um pedaço só da view, com novo
 *      ViewState e a primeira linha resultante (tipicamente uma
 *      pessoa por CPF, mas o servidor pode trazer N).
 *   3. Localiza o `idPessoa` no onclick do botão "Editar" da primeira
 *      linha e POST do form daquela linha com `tab=form&id=N`. A
 *      resposta agora vem com o formulário completo de edição,
 *      incluindo nome, RG, data de nascimento, endereço, nome da mãe.
 *
 * Custo total: 3 requests HTTP por réu. Aceitável on-demand (clique
 * no painel lateral do dashboard); NÃO usar em massa na varredura —
 * a tela é administrativa e varredura batch chama atenção nos logs.
 *
 * Dependência crítica: rodar dentro de um content script de uma aba
 * PJe ativa, para que cookies de sessão acompanhem os fetches. Do
 * background (origin `chrome-extension://`) o servidor responde com
 * tela de login em vez do form.
 */

import { LOG_PREFIX } from '../../shared/constants';

const PESSOA_FISICA_PATH = '/pje/PessoaFisica/listView.seam';
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Resultado público do enriquecimento — todos os campos opcionais,
 * vêm `null` quando o servidor não tem o dado preenchido.
 */
export interface DadosPessoaFisica {
  idPessoa: number;
  nome: string | null;
  cpf: string | null;
  rg: string | null;
  dataNascimento: string | null; // ISO YYYY-MM-DD
  nomeMae: string | null;
  endereco: string | null;
}

export type ResultadoEnriquecimento =
  | { ok: true; dados: DadosPessoaFisica }
  | { ok: false; error: string };

// ── Helpers de parser ───────────────────────────────────────────

/** Extrai o `javax.faces.ViewState` mais recente de um HTML. */
function extrairViewState(doc: Document): string | null {
  const inputs = doc.querySelectorAll<HTMLInputElement>(
    'input[name="javax.faces.ViewState"]'
  );
  // Em postbacks parciais o HTML pode ter o ViewState em qualquer um
  // dos forms re-renderizados — pegamos o último (geralmente o mais
  // recente; o JSF mantém todos sincronizados).
  let last: string | null = null;
  for (const i of Array.from(inputs)) {
    if (i.value) last = i.value;
  }
  return last;
}

/**
 * Tenta achar o `idPessoa` na primeira linha da tabela de resultado
 * — o número aparece dentro do parâmetro `'id':NNNN` do `onclick` do
 * botão "Editar" (`a.btn[title="Editar"]`).
 */
function extrairIdPessoaDoResultado(doc: Document): number | null {
  // Procura todos os botões "Editar" na primeira página de resultado.
  const editLinks = doc.querySelectorAll<HTMLAnchorElement>(
    'a[title="Editar"][onclick]'
  );
  for (const a of Array.from(editLinks)) {
    const onclick = a.getAttribute('onclick') ?? '';
    // O onclick é um JS literal — buscar o padrão `'id':NNNN`
    const m = onclick.match(/'id':\s*(\d+)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * Normaliza um texto pra comparação tolerante (lowercase + remove
 * acentos + colapsa espaços + remove pontuação final).
 */
function normalizarLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos
    .toLowerCase()
    .replace(/[:?.;]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lê o valor textual de um label/input do formulário de edição.
 * Estratégia em cascata para suportar variações entre instâncias do
 * PJe (algumas usam `<label for>` clean, outras embedam o input no
 * próprio `<label>`, outras nem usam `<label>` mas têm `<th>`/`<td>`).
 *
 *   1. `<label>` cujo texto bate (case+acento-insensitive) com o
 *      esperado e tem `for=` apontando para um input/select/span.
 *   2. Mesmo, mas sem `for`: pega o input mais próximo dentro do
 *      `.propertyView` ancestral (ou pai imediato).
 *   3. Tabelas chave-valor: `<th>LABEL</th><td>VALOR</td>`.
 *   4. Fallback bem solto: divs com a label e qualquer input/span
 *      com valor próximo.
 */
function lerCampoForm(doc: Document, labelTextoEsperado: string): string | null {
  const alvo = normalizarLabel(labelTextoEsperado);

  // Estratégia 1+2: <label>
  const labels = doc.querySelectorAll<HTMLLabelElement>('label');
  for (const lbl of Array.from(labels)) {
    const t = normalizarLabel(lbl.textContent ?? '');
    if (t !== alvo) continue;

    const forId = lbl.getAttribute('for');
    if (forId) {
      const el = doc.getElementById(forId);
      const v = lerValorDeElemento(el);
      if (v) return v;
    }

    // Procura input/select dentro do mesmo .propertyView ou pai
    const wrap = lbl.closest('.propertyView, tr, div') ?? lbl.parentElement;
    if (wrap) {
      const input = wrap.querySelector<HTMLInputElement | HTMLSelectElement>(
        'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), select, textarea'
      );
      if (input) {
        const v = lerValorDeElemento(input);
        if (v) return v;
      }
      const valDiv = wrap.querySelector<HTMLElement>('.value');
      if (valDiv) {
        const t2 = (valDiv.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (t2) return t2;
      }
    }
  }

  // Estratégia 3: <th>LABEL</th><td>VALOR</td>
  const ths = doc.querySelectorAll<HTMLElement>('th, td.label, dt');
  for (const th of Array.from(ths)) {
    const t = normalizarLabel(th.textContent ?? '');
    if (t !== alvo) continue;
    const sib = th.nextElementSibling;
    if (!sib) continue;
    const input = sib.querySelector<HTMLInputElement | HTMLSelectElement>(
      'input:not([type="hidden"]), select, textarea'
    );
    if (input) {
      const v = lerValorDeElemento(input);
      if (v) return v;
    }
    const t2 = (sib.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t2) return t2;
  }

  // Estratégia 4: input/select cujo `name` ou `id` "lembra" a label
  // (ex.: `dataNascimento`, `nomeMae`). A heurística usa o alvo como
  // pista — converte para camelCase e procura name/id contendo.
  const palavras = alvo.split(/\s+/).filter(Boolean);
  if (palavras.length > 0) {
    const camelCase =
      palavras[0]! +
      palavras
        .slice(1)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join('');
    const seletor =
      `input[id*="${camelCase}" i]:not([type="hidden"]), ` +
      `input[name*="${camelCase}" i]:not([type="hidden"]), ` +
      `select[id*="${camelCase}" i], select[name*="${camelCase}" i], ` +
      `textarea[id*="${camelCase}" i], textarea[name*="${camelCase}" i]`;
    const el = doc.querySelector<HTMLInputElement | HTMLSelectElement>(seletor);
    if (el) {
      const v = lerValorDeElemento(el);
      if (v) return v;
    }
  }

  return null;
}

function lerValorDeElemento(el: Element | null): string | null {
  if (!el) return null;
  let raw: string | null = null;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
    raw = el.value || null;
  } else if (el instanceof HTMLSelectElement) {
    const opt = el.options[el.selectedIndex];
    raw = opt?.value || opt?.textContent?.trim() || null;
  } else if (el instanceof HTMLTextAreaElement) {
    raw = el.value || null;
  } else {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    raw = t || null;
  }
  return sanitizarValorSeam(raw);
}

/**
 * Filtra valores sentinela do JSF/Seam que não são "valor real".
 *   - `org.jboss.seam.ui.NoSelectionConverter.noSelectionValue` aparece
 *     em selects vazios (placeholder "Selecione...").
 *   - String "noSelection" / "null" também são tokens de campo vazio.
 *   - Strings com mais de 200 chars que NÃO contêm espaço são quase
 *     certo lixo de id JSF, não dado real.
 */
function sanitizarValorSeam(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  if (/^org\.jboss\./i.test(t)) return null;
  if (/noSelection/i.test(t)) return null;
  if (t === 'null' || t === 'undefined') return null;
  if (t.length > 200 && !/\s/.test(t)) return null;
  return t;
}

const REGEX_DATA_BR = /(\d{2})\/(\d{2})\/(\d{4})/;

function dataBrParaIso(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(REGEX_DATA_BR);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Tenta extrair os campos relevantes do formulário de edição já
 * renderizado. As labels variam ligeiramente entre instâncias do
 * PJe — mantemos uma lista de aliases por campo.
 */
function extrairDadosDoFormulario(doc: Document, idPessoa: number): DadosPessoaFisica {
  const naoEncontrados: string[] = [];
  const tentar = (campoLogico: string, ...labels: string[]): string | null => {
    for (const l of labels) {
      const v = sanitizarValorSeam(lerCampoForm(doc, l));
      if (v) return v;
    }
    naoEncontrados.push(campoLogico);
    return null;
  };

  // Lista expandida de aliases para cobrir variações de instâncias do
  // PJe (TRF5 1g pode usar "Mãe" simples, outros usam "Filiação - Mãe").
  const nome = tentar('nome', 'Nome', 'Nome completo', 'Nome civil', 'Nome da pessoa');
  const cpf = tentar('cpf', 'CPF', 'Número do CPF', 'Nº CPF');
  const rg = tentar(
    'rg',
    'RG',
    'Identidade',
    'Documento de identidade',
    'Carteira de identidade',
    'Nº RG',
    'Número do RG',
    'Número da identidade'
  );
  const dataNascStr = tentar(
    'data_nascimento',
    'Data de nascimento',
    'Nascimento',
    'Data nasc.',
    'Dt. nascimento',
    'Dt nascimento'
  );
  const nomeMae = tentar(
    'nome_mae',
    'Nome da mãe',
    'Nome da Mae',
    'Mãe',
    'Mae',
    'Filiação - Mãe',
    'Filiação Mãe',
    'Nome da genitora'
  );

  // Endereço pode aparecer em vários campos — concatena os disponíveis.
  const logradouro = tentar(
    'logradouro',
    'Logradouro',
    'Endereço',
    'Endereco',
    'Rua',
    'Av.',
    'Avenida'
  );
  const numeroEnd = tentar('numero_endereco', 'Número', 'Numero', 'Nº');
  const bairro = tentar('bairro', 'Bairro');
  const municipio = tentar(
    'municipio',
    'Município',
    'Municipio',
    'Cidade',
    'Localidade'
  );
  const uf = tentar('uf', 'UF', 'Estado');
  const cep = tentar('cep', 'CEP');
  const enderecoPartes: string[] = [];
  if (logradouro) {
    enderecoPartes.push(numeroEnd ? `${logradouro}, ${numeroEnd}` : logradouro);
  }
  if (bairro) enderecoPartes.push(bairro);
  if (municipio || uf) {
    enderecoPartes.push([municipio, uf].filter(Boolean).join('/'));
  }
  if (cep) enderecoPartes.push(`CEP ${cep}`);
  const endereco = enderecoPartes.length > 0 ? enderecoPartes.join(' · ') : null;

  // Diagnóstico: SEMPRE loga os campos não encontrados, mesmo quando
  // o parse parcialmente funcionou. Sem isso fica difícil saber se um
  // campo está vazio porque a pessoa não tem aquele dado cadastrado
  // no PJe ou se o parser falhou em achar a label. O log inclui a
  // lista de labels presentes na página, facilitando mapear novos
  // aliases sem precisar inspecionar o DOM manualmente.
  if (naoEncontrados.length > 0) {
    const labelsEncontradas = Array.from(doc.querySelectorAll('label'))
      .map((l) => (l.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 80)
      .slice(0, 50);
    console.debug(
      `${LOG_PREFIX} pessoa-fisica id=${idPessoa}: ` +
        `${naoEncontrados.length} campo(s) não encontrado(s): ` +
        `${naoEncontrados.join(', ')}. ` +
        `Labels presentes na página: [${labelsEncontradas.join(' | ')}]`
    );
  }

  return {
    idPessoa,
    nome: nome?.trim() || null,
    cpf: cpf?.trim() || null,
    rg: rg?.trim() || null,
    dataNascimento: dataBrParaIso(dataNascStr),
    nomeMae: nomeMae?.trim() || null,
    endereco
  };
}

// ── Fetches ─────────────────────────────────────────────────────

async function fetchTextoComTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(
    () => ctrl.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs
  );
  try {
    const resp = await fetch(url, {
      ...init,
      credentials: 'include',
      signal: ctrl.signal
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } finally {
    window.clearTimeout(timer);
  }
}

function digitsOnly(cpf: string): string {
  return cpf.replace(/\D/g, '');
}

function formatarCpfMascarado(cpf: string): string {
  const d = digitsOnly(cpf).padStart(11, '0').slice(-11);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

/**
 * Parsea os campos hidden de um form do JSF (todos os `<input
 * type="hidden">` filhos) — necessário para reenviar o `ViewState`,
 * o `id` do form e qualquer outro state que o JSF precisa.
 */
function colherHiddensDoForm(form: HTMLFormElement): URLSearchParams {
  const out = new URLSearchParams();
  const hiddens = form.querySelectorAll<HTMLInputElement>('input[type="hidden"]');
  for (const h of Array.from(hiddens)) {
    if (!h.name) continue;
    out.append(h.name, h.value);
  }
  return out;
}

// ── Fluxo principal ─────────────────────────────────────────────

/**
 * Orquestra a coleta JSF para um CPF. Retorna `{ ok: true, dados }`
 * com os campos extraídos, ou `{ ok: false, error }` em qualquer
 * falha (sessão expirada, CPF não encontrado, parser quebrado).
 *
 * É idempotente — chamadas repetidas para o mesmo CPF rendem o
 * mesmo `idPessoa` e dados idênticos.
 */
export async function enriquecerPessoaFisicaPorCpf(
  cpf: string
): Promise<ResultadoEnriquecimento> {
  const cpfDigitos = digitsOnly(cpf);
  if (cpfDigitos.length !== 11) {
    return { ok: false, error: `CPF inválido: "${cpf}" (esperado 11 dígitos).` };
  }

  const origem = window.location.origin;

  // ── Etapa 1: GET inicial — captura ViewState + form ──────────
  let url1 = `${origem}${PESSOA_FISICA_PATH}`;
  let resp1: Awaited<ReturnType<typeof fetchTextoComTimeout>>;
  try {
    resp1 = await fetchTextoComTimeout(
      url1,
      { method: 'GET', headers: { Accept: 'text/html' } },
      FETCH_TIMEOUT_MS
    );
  } catch (err) {
    return {
      ok: false,
      error: `Falha no GET inicial de PessoaFisica: ${
        err instanceof Error ? err.message : String(err)
      }`
    };
  }
  if (!resp1.ok) {
    return { ok: false, error: `HTTP ${resp1.status} no GET inicial.` };
  }
  if (resp1.text.length < 1000) {
    return {
      ok: false,
      error:
        'Resposta vazia/curta — provavelmente sessão expirada ou perfil sem ' +
        'permissão de acesso ao cadastro de Pessoa Física.'
    };
  }

  const doc1 = new DOMParser().parseFromString(resp1.text, 'text/html');
  const viewState1 = extrairViewState(doc1);
  if (!viewState1) {
    return {
      ok: false,
      error: 'Não foi possível ler o ViewState inicial do formulário.'
    };
  }

  // ── Etapa 2: POST de busca por CPF ──────────────────────────
  // Nome do form: `pessoaFisicaGridSearchForm`. O campo do CPF tem
  // nome longo (`pessoaFisicaGridSearchForm:j_id167:numeroCPFDecoration:numeroCPF`),
  // o número do `j_id` muda entre versões do PJe — descobrimos pelo
  // sufixo `:numeroCPF` no atributo `name`.
  const formBusca = doc1.getElementById('pessoaFisicaGridSearchForm');
  if (!(formBusca instanceof HTMLFormElement)) {
    return { ok: false, error: 'Form de busca não encontrado no HTML inicial.' };
  }
  const cpfInput = formBusca.querySelector<HTMLInputElement>(
    'input[name$=":numeroCPF"]'
  );
  const searchBtn = formBusca.querySelector<HTMLInputElement>(
    'input[name$=":search"]'
  );
  if (!cpfInput || !searchBtn) {
    return {
      ok: false,
      error: 'Campos numeroCPF/search não localizados no form de busca.'
    };
  }

  const params2 = colherHiddensDoForm(formBusca);
  // Sobrescreve o numeroCPF e adiciona o trigger do botão "Pesquisar"
  // (mesma forma que o JSF dispara via A4J.AJAX.Submit).
  params2.set(cpfInput.name, formatarCpfMascarado(cpfDigitos));
  params2.set(searchBtn.name, searchBtn.name);
  // O form usa `pessoaFisicaGridSearchForm:page=1` em postbacks
  // de pesquisa — preserva o que veio do hidden e força "1".
  params2.set('pessoaFisicaGridSearchForm:page', '1');
  params2.set('pessoaFisicaGridSearchForm:searching', 'true');

  let resp2: Awaited<ReturnType<typeof fetchTextoComTimeout>>;
  try {
    resp2 = await fetchTextoComTimeout(
      `${origem}${PESSOA_FISICA_PATH}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/xml,application/xml,*/*'
        },
        body: params2.toString()
      },
      FETCH_TIMEOUT_MS
    );
  } catch (err) {
    return {
      ok: false,
      error: `Falha no POST de busca: ${
        err instanceof Error ? err.message : String(err)
      }`
    };
  }
  if (!resp2.ok) {
    return { ok: false, error: `HTTP ${resp2.status} no POST de busca.` };
  }

  // A resposta do A4J é XML envolvendo HTML — DOMParser aceita ambos.
  const doc2 = new DOMParser().parseFromString(resp2.text, 'text/html');
  const idPessoa = extrairIdPessoaDoResultado(doc2);
  if (!idPessoa) {
    return {
      ok: false,
      error:
        'Nenhuma pessoa encontrada com este CPF (pode estar inativa ou ' +
        'cadastrada com outro nome no PJe).'
    };
  }

  // ── Etapa 3: GET direto do formulário de edição ─────────────
  // Em vez do POST A4J (que retorna XML envelopado), usamos a URL
  // canônica `?tab=form&id=N` que o próprio PJe expõe — devolve a
  // página completa renderizada com todos os campos da pessoa,
  // bem mais fácil de parsear.
  const url3 = `${origem}${PESSOA_FISICA_PATH}?tab=form&id=${idPessoa}`;
  let resp3: Awaited<ReturnType<typeof fetchTextoComTimeout>>;
  try {
    resp3 = await fetchTextoComTimeout(
      url3,
      { method: 'GET', headers: { Accept: 'text/html' } },
      FETCH_TIMEOUT_MS
    );
  } catch (err) {
    return {
      ok: false,
      error: `Falha no GET de edição: ${
        err instanceof Error ? err.message : String(err)
      }`
    };
  }
  if (!resp3.ok) {
    return { ok: false, error: `HTTP ${resp3.status} no GET de edição.` };
  }
  if (resp3.text.length < 1000) {
    return {
      ok: false,
      error:
        `Resposta do form de edição muito curta (${resp3.text.length} chars). ` +
        'Sessão pode ter expirado ou idPessoa inválido.'
    };
  }

  // ── Etapa 4: parsear formulário ─────────────────────────────
  const doc3 = new DOMParser().parseFromString(resp3.text, 'text/html');
  const dados = extrairDadosDoFormulario(doc3, idPessoa);

  // Sanidade: se nem o nome nem nascimento nem RG vieram, parse falhou.
  if (!dados.nome && !dados.dataNascimento && !dados.rg) {
    // Coleta um diagnóstico no console pra facilitar o debug — lista
    // labels encontradas no HTML para o desenvolvedor mapear novos
    // aliases sem precisar reabrir a tela manualmente.
    const labelsEncontradas = Array.from(doc3.querySelectorAll('label'))
      .map((l) => (l.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 60)
      .slice(0, 30);
    const inputsEncontrados = Array.from(
      doc3.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')
    )
      .map((i) => `${i.name || i.id}=${i.type}`)
      .slice(0, 30);
    console.warn(
      `${LOG_PREFIX} pessoa-fisica: form sem campos reconhecidos. URL=${url3}\n` +
        `Labels: ${labelsEncontradas.join(' | ')}\n` +
        `Inputs: ${inputsEncontrados.join(' | ')}`
    );
    return {
      ok: false,
      error:
        'Formulário de edição não trouxe campos reconhecidos. Abra o console ' +
        '(F12) — gravamos a lista de labels e inputs encontrados para ajuste.'
    };
  }

  return { ok: true, dados };
}
