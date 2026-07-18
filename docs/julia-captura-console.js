/**
 * Coletor de contratos do JULIA — para colar no console do DevTools.
 *
 * Uso: abra `julia.trf5.jus.br` já autenticado, F12 → Console, cole isto e
 * tecle Enter. Depois use a interface normalmente (uma busca em Documentos com
 * Unidade=JFCE e Instância=Comum) e rode `julia.relatorio()`.
 *
 * ## Por que existe
 *
 * Inspecionar requisição por requisição no Network é lento e, pior, o que se
 * copia de lá vem com cookie de sessão e com dado pessoal dos processos. Este
 * script coleta só o que interessa para escrever um cliente — **a forma dos
 * contratos, não o conteúdo dos autos**.
 *
 * ## O que ele NÃO coleta, por decisão
 *
 *   - Corpo das respostas. Guarda o *esquema* (nomes de campo e tipos), não os
 *     valores longos. Um acórdão de Turma Recursal passa de 15 mil caracteres e
 *     traz nome de parte, advogado e número de processo — nada disso é
 *     necessário para descobrir como a API funciona.
 *   - Headers `cookie`, `authorization`, `x-xsrf-token` e afins.
 *   - Strings longas em geral: acima de 60 caracteres vira `"string(N chars)"`.
 *
 * Valores curtos (ex.: `tipoDocumento: "SENTENCA"`) são preservados de
 * propósito — são o vocabulário dos enums, que é exatamente o que falta mapear.
 * Ainda assim passam pelo redator de CPF/CNPJ/OAB/número de processo.
 *
 * Nada é enviado a lugar nenhum: tudo fica em memória na aba e só sai por
 * `copy()`, quando você mandar.
 */

(() => {
  'use strict';

  const LIMITE_STRING = 60;
  const LIMITE_BUNDLE_BYTES = 4 * 1024 * 1024;
  const HEADERS_PROIBIDOS = /^(cookie|set-cookie|authorization|proxy-authorization|x-xsrf-token|x-csrf-token)$/i;

  const capturas = [];
  const endpointsNoCodigo = new Set();

  // ── Redação de dados pessoais ──────────────────────────────────

  const REDACOES = [
    [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]'],
    [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[CNPJ]'],
    [/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g, '[PROCESSO]'],
    [/\b\d{20}\b/g, '[PROCESSO]'],
    [/\b[A-Z]{2}\d{4,6}(-[A-Z])?\b/g, '[OAB]']
  ];

  function redigir(texto) {
    let saida = String(texto);
    for (const [re, marca] of REDACOES) saida = saida.replace(re, marca);
    return saida;
  }

  // ── Esquema (forma, não conteúdo) ──────────────────────────────

  function esquema(valor, profundidade = 0) {
    if (valor === null) return 'null';
    if (valor === undefined) return 'undefined';

    if (Array.isArray(valor)) {
      if (valor.length === 0) return 'array(0)';
      if (profundidade >= 3) return `array(${valor.length})`;
      // Só o primeiro item: os demais têm a mesma forma e multiplicariam PII.
      return { [`array(${valor.length})`]: esquema(valor[0], profundidade + 1) };
    }

    if (typeof valor === 'object') {
      if (profundidade >= 4) return 'object';
      const saida = {};
      for (const [k, v] of Object.entries(valor)) saida[k] = esquema(v, profundidade + 1);
      return saida;
    }

    if (typeof valor === 'string') {
      // Strings curtas são o vocabulário dos enums — o que mais interessa aqui.
      return valor.length <= LIMITE_STRING
        ? redigir(valor)
        : descreverStringLonga(valor);
    }

    return typeof valor;
  }

  /**
   * Descreve uma string longa por características estruturais, sem devolver
   * nada do conteúdo.
   *
   * Responde de uma vez as perguntas que definem o cliente — o inteiro teor
   * vem embutido? é HTML? traz realce de busca? — sem transportar um acórdão,
   * que é justamente onde mora o nome das partes.
   */
  function descreverStringLonga(s) {
    const marcas = [];
    if (/<em>/i.test(s)) marcas.push('realce <em>');
    if (/<[a-z][^>]*>/i.test(s)) marcas.push('contém HTML');
    const linhas = s.split(/\r?\n/).length;
    if (linhas > 1) marcas.push(`${linhas} linhas`);
    return `string(${s.length} chars)${marcas.length ? ' | ' + marcas.join(', ') : ''}`;
  }

  // ── Normalização de requisições ────────────────────────────────

  function parametros(url) {
    try {
      // Base é `location.href`, NÃO `location.origin`. Com origin, uma chamada
      // relativa (`api/v1/x`) feita de `/julia/consultar` seria registrada como
      // `/api/v1/x` em vez de `/julia/api/v1/x` — reportando um caminho que não
      // existe. Foi exatamente o erro que produziu o falso "prefixo
      // inconsistente" na primeira rodada de capturas.
      const u = new URL(url, location.href);
      const obj = {};
      for (const [k, v] of u.searchParams.entries()) obj[k] = redigir(v);
      return { caminho: u.pathname, query: obj };
    } catch {
      return { caminho: String(url), query: {} };
    }
  }

  function limparHeaders(headers) {
    const obj = {};
    if (!headers) return obj;
    try {
      const entries =
        typeof headers.entries === 'function'
          ? [...headers.entries()]
          : Object.entries(headers);
      for (const [k, v] of entries) {
        obj[k] = HEADERS_PROIBIDOS.test(k) ? '[removido]' : redigir(v);
      }
    } catch {
      /* headers em formato inesperado — ignora */
    }
    return obj;
  }

  function corpoResumido(corpo) {
    if (!corpo) return null;
    if (typeof corpo !== 'string') return `[${corpo.constructor?.name ?? 'binário'}]`;
    try {
      return esquema(JSON.parse(corpo));
    } catch {
      // form-urlencoded ou texto: devolve redigido e truncado.
      return redigir(corpo).slice(0, 800);
    }
  }

  function registrar(entrada) {
    capturas.push({ ...entrada, em: new Date().toISOString() });
    const n = capturas.length;
    console.log(
      `%c[julia] captura #${n}%c ${entrada.metodo} ${entrada.caminho} → ${entrada.status}`,
      'color:#8b1a1a;font-weight:bold',
      'color:inherit'
    );
  }

  async function descreverResposta(resposta) {
    const tipo = resposta.headers?.get?.('content-type') ?? null;
    const base = { status: resposta.status, contentType: tipo };
    if (!tipo || !/json/i.test(tipo)) return base;
    try {
      const texto = await resposta.clone().text();
      return { ...base, esquema: esquema(JSON.parse(texto)), bytes: texto.length };
    } catch {
      return { ...base, esquema: '[falha ao ler]' };
    }
  }

  // ── Intercepta fetch ───────────────────────────────────────────

  const fetchOriginal = window.fetch;
  window.fetch = async function (entrada, init) {
    const url = typeof entrada === 'string' ? entrada : entrada?.url ?? String(entrada);
    const metodo = (init?.method ?? entrada?.method ?? 'GET').toUpperCase();
    const resposta = await fetchOriginal.apply(this, arguments);
    try {
      const { caminho, query } = parametros(url);
      registrar({
        transporte: 'fetch',
        metodo,
        caminho,
        query,
        headers: limparHeaders(init?.headers),
        corpo: corpoResumido(init?.body),
        resposta: await descreverResposta(resposta),
        status: resposta.status
      });
    } catch (err) {
      console.warn('[julia] falha registrando fetch:', err);
    }
    return resposta;
  };

  // ── Intercepta XMLHttpRequest ──────────────────────────────────

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (metodo, url) {
    this.__julia = { metodo: String(metodo).toUpperCase(), url, headers: {} };
    return xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (nome, valor) {
    if (this.__julia) {
      this.__julia.headers[nome] = HEADERS_PROIBIDOS.test(nome)
        ? '[removido]'
        : redigir(valor);
    }
    return xhrSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (corpo) {
    const ctx = this.__julia;
    if (ctx) {
      this.addEventListener('load', () => {
        try {
          const { caminho, query } = parametros(ctx.url);
          const tipo = this.getResponseHeader('content-type');
          let resposta = { status: this.status, contentType: tipo };
          if (tipo && /json/i.test(tipo) && typeof this.responseText === 'string') {
            try {
              resposta = {
                ...resposta,
                esquema: esquema(JSON.parse(this.responseText)),
                bytes: this.responseText.length
              };
            } catch {
              resposta = { ...resposta, esquema: '[JSON inválido]' };
            }
          }
          registrar({
            transporte: 'xhr',
            metodo: ctx.metodo,
            caminho,
            query,
            headers: ctx.headers,
            corpo: corpoResumido(corpo),
            resposta,
            status: this.status
          });
        } catch (err) {
          console.warn('[julia] falha registrando xhr:', err);
        }
      });
    }
    return xhrSend.apply(this, arguments);
  };

  // ── Varredura dos bundles JS ───────────────────────────────────

  /**
   * Procura caminhos de API literais no código carregado. Revela endpoints que
   * a aplicação sabe chamar mesmo sem que a tela os acione — inclusive o
   * `documento:dt`, que se aparecer aqui prova backend compartilhado com o
   * `juliapesquisa`.
   */
  async function varrerBundles() {
    const scripts = performance
      .getEntriesByType('resource')
      .map((r) => r.name)
      .filter((n) => /\.js(\?|$)/i.test(n) && n.startsWith(location.origin));

    const padrao = /["'`](\/?(?:api|rest|services?)\/[A-Za-z0-9/_:.$-]{2,120})["'`]/g;
    const especifico = /documento:dt|[a-z]+:dt\b/gi;

    for (const src of [...new Set(scripts)]) {
      try {
        const r = await fetchOriginal(src);
        const tamanho = Number(r.headers.get('content-length') ?? 0);
        if (tamanho > LIMITE_BUNDLE_BYTES) continue;
        const texto = await r.text();
        for (const m of texto.matchAll(padrao)) endpointsNoCodigo.add(m[1]);
        for (const m of texto.matchAll(especifico)) {
          endpointsNoCodigo.add(`(padrão DataTables) ${m[0]}`);
        }
      } catch {
        /* bundle inacessível — segue */
      }
    }
    return [...endpointsNoCodigo].sort();
  }

  // ── API pública do coletor ─────────────────────────────────────

  window.julia = {
    capturas,

    /** Só as chamadas que parecem de API (descarta assets e telemetria). */
    api: () =>
      capturas.filter((c) => /\/(api|rest|services?)\//i.test(c.caminho)),

    async bundles() {
      console.log('[julia] varrendo bundles…');
      const achados = await varrerBundles();
      console.table(achados.map((e) => ({ endpoint: e })));
      return achados;
    },

    /** Relatório final, pronto para colar. Use `copy(await julia.relatorio())`. */
    async relatorio() {
      const achados = endpointsNoCodigo.size
        ? [...endpointsNoCodigo].sort()
        : await varrerBundles();
      return JSON.stringify(
        {
          gerado: new Date().toISOString(),
          host: location.host,
          rota: location.hash || location.pathname,
          endpointsNoCodigo: achados,
          requisicoes: capturas
        },
        null,
        2
      );
    },

    limpar() {
      capturas.length = 0;
      console.log('[julia] capturas zeradas.');
    }
  };

  console.log(
    '%c[julia] coletor ativo.',
    'color:#8b1a1a;font-weight:bold;font-size:13px'
  );
  console.log(
    'Agora faça UMA busca (Documentos, Unidade=JFCE, Instância=Comum).\n' +
      'Depois rode:  copy(await julia.relatorio())\n' +
      'e cole o resultado no chat. Cookies e dados pessoais já saem redigidos.'
  );
})();
