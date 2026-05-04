/**
 * Cliente para extrair partes detalhadas (autor, réu, advogados,
 * representantes) a partir do HTML de `listAutosDigitais.seam`.
 *
 * Por que via HTML?
 * O endpoint REST genérico `recuperarProcessosTarefaPendenteComCriterios`
 * achata o `poloAtivo` em string única (perde estrutura). A página dos
 * autos digitais, por outro lado, traz um bloco `<div id="poloAtivo">`
 * com cada parte e cada advogado/representante em `<small>` separados,
 * com texto legível: `"FULANO - OAB CE12345 - CPF: ... (ADVOGADO)"`.
 *
 * Same-origin: o content script do PJe faz GET nessa URL com `credentials:
 * 'include'` e o servidor anexa o cookie de sessão automaticamente. A
 * `ca` (chave de acesso) é resolvida via `gerarChaveAcesso` antes do
 * fetch — `montarUrlAutos` faz isso para nós.
 *
 * Cache em memória por idProcesso: o Map vive enquanto o content script
 * estiver ativo na aba do PJe (não persiste entre navegações). Isso evita
 * refazer dezenas de chamadas quando o usuário aciona "Atualizar pauta"
 * no painel de Audiência.
 *
 * O HTML de uma página de autos digitais costuma ter ~500KB; para 100
 * processos a varredura puxa ~50MB do servidor. Aceitável para uma única
 * execução institucional, mas o pool é cap em 10 paralelas para evitar
 * disparar timeouts no PJe.
 */

import { LOG_PREFIX } from '../../shared/constants';
import { montarUrlAutos } from './pje-api-from-content';

const LOG = `${LOG_PREFIX} [pje-api-partes]`;

/** Tipos de parte reconhecidos no HTML do PJe. */
export type TipoParte =
  | 'AUTOR'
  | 'REU'
  | 'ADVOGADO'
  | 'REPRESENTANTE'
  | 'PROCURADORIA'
  | 'ORGAO_DE_CUMPRIMENTO'
  | 'OUTRO';

/** Polo onde a parte foi encontrada no HTML. */
export type PoloParte = 'ATIVO' | 'PASSIVO' | 'OUTROS' | 'DESCONHECIDO';

export interface ParteExtraida {
  /** Texto bruto da linha (útil para debug). */
  textoBruto: string;
  /** Nome (ou denominação) da parte. */
  nome: string;
  tipo: TipoParte;
  polo: PoloParte;
  /** Tipo do documento da parte (CPF, CNPJ, OAB) — `null` quando ausente. */
  documentoTipo: 'CPF' | 'CNPJ' | 'OAB' | null;
  documentoNumero: string | null;
  /** Quando documentoTipo=OAB, UF da inscrição (ex.: "CE"). */
  oabUf: string | null;
  /** Quando documentoTipo=OAB, número da inscrição (ex.: "27268"). */
  oabNumero: string | null;
}

const cachePartes = new Map<number, ParteExtraida[]>();

export interface ObterPartesResult {
  ok: boolean;
  partes?: ParteExtraida[];
  error?: string;
}

/**
 * Baixa o HTML de `listAutosDigitais.seam` e extrai as partes.
 * Cacheado em memória por `idProcesso` — chamadas subsequentes são
 * instantâneas até o content script ser recriado.
 */
export async function obterPartesDoProcesso(opts: {
  idProcesso: number;
  idTaskInstance: number | null;
  legacyOrigin: string;
  /** Quando `true`, ignora o cache e refaz a chamada. */
  forcar?: boolean;
}): Promise<ObterPartesResult> {
  if (!opts.forcar) {
    const cached = cachePartes.get(opts.idProcesso);
    if (cached) return { ok: true, partes: cached };
  }

  const r = await montarUrlAutos({
    legacyOrigin: opts.legacyOrigin,
    idProcesso: opts.idProcesso,
    idTaskInstance: opts.idTaskInstance
  });
  if (!r.ok || !r.url) {
    return { ok: false, error: r.error ?? 'Falha ao montar URL dos autos.' };
  }

  let html: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new DOMException('Timeout', 'TimeoutError')),
      30_000
    );
    try {
      const resp = await fetch(r.url, {
        method: 'GET',
        credentials: 'include',
        signal: ctrl.signal
      });
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status} ao baixar autos digitais` };
      }
      html = await resp.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const partes = parsearPartesDoHtml(html);
  cachePartes.set(opts.idProcesso, partes);
  return { ok: true, partes };
}

/**
 * Limpa o cache em memória — útil para "Atualizar pauta" forçando
 * refetch (rarely used; o `forcar: true` por chamada cobre o caso normal).
 */
export function limparCachePartes(): void {
  cachePartes.clear();
}

/**
 * Parser do HTML de autos digitais. Localiza os 3 blocos de polo e
 * extrai cada `<small>` (representantes/advogados) e a linha principal
 * (autor/réu/órgão).
 *
 * Robustez:
 *   - Tolera ausência de qualquer um dos blocos.
 *   - Não quebra com `documento` faltando (procuradoria sem CNPJ, p.ex.).
 *   - Conserva o `textoBruto` para diagnóstico.
 */
export function parsearPartesDoHtml(html: string): ParteExtraida[] {
  const partes: ParteExtraida[] = [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (err) {
    console.warn(`${LOG} DOMParser falhou:`, err);
    return partes;
  }

  const blocos: Array<{ id: string; polo: PoloParte }> = [
    { id: 'poloAtivo', polo: 'ATIVO' },
    { id: 'poloPassivo', polo: 'PASSIVO' },
    { id: 'outrosInteressados', polo: 'OUTROS' }
  ];

  for (const { id, polo } of blocos) {
    const wrap = doc.getElementById(id);
    if (!wrap) continue;

    const tds = wrap.querySelectorAll('td');
    for (const td of Array.from(tds)) {
      // Linha principal: o primeiro <span> de texto direto dentro do <td>.
      // Estrutura observada: <td><span class=""><span class="">TEXTO</span></span> <div...></div></td>
      const principal = td.querySelector(':scope > span');
      if (principal) {
        const txt = obterTextoDireto(principal);
        if (txt) partes.push(parsearLinha(txt, polo));
      }

      // Sub-itens: representantes/advogados em <small class="text-muted">.
      const smalls = td.querySelectorAll('small.text-muted');
      for (const small of Array.from(smalls)) {
        const txt = obterTextoLimpo(small);
        if (txt) partes.push(parsearLinha(txt, polo));
      }
    }
  }

  return partes;
}

/**
 * Extrai o texto de um nó priorizando o conteúdo dos spans aninhados
 * (que contêm o texto puro da parte) — ignora `<div>` filhos (que carregam
 * a sub-árvore de representantes).
 */
function obterTextoDireto(span: Element): string {
  // Preferir o span mais interno (usado pelo PJe para envolver o texto)
  const inner = span.querySelector('span');
  const txt = (inner ?? span).textContent ?? '';
  return txt.replace(/\s+/g, ' ').trim();
}

/**
 * Extrai texto limpo de qualquer elemento (usado para `<small>`),
 * removendo whitespace excedente e o texto do ícone (FontAwesome com
 * texto vazio costuma ficar implícito; aria-hidden cobre).
 */
function obterTextoLimpo(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  // Remove ícones (i.fa) que podem ter title/alt como texto residual.
  for (const i of Array.from(clone.querySelectorAll('i'))) i.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Parser textual de uma linha de parte. Padrões reconhecidos:
 *   - "NOME - CPF: XXX.XXX.XXX-XX (AUTOR)"
 *   - "NOME - CNPJ: XX.XXX.XXX/XXXX-XX (REU)"
 *   - "NOME - OAB CE27268 - CPF: XXX (ADVOGADO)"
 *   - "NOME - OAB CE27268 (ADVOGADO)"        (raro, sem CPF)
 *   - "Procuradoria Geral Federal (PGF/AGU)" (sem documento)
 *   - "TEXTO QUALQUER (TIPO)"                (cai em OUTRO)
 */
export function parsearLinha(texto: string, polo: PoloParte): ParteExtraida {
  const tipoMatch = texto.match(/\(([^()]+)\)\s*$/);
  let tipo: TipoParte = 'OUTRO';
  if (tipoMatch) {
    const t = tipoMatch[1].trim().toUpperCase();
    if (t === 'AUTOR') tipo = 'AUTOR';
    else if (t === 'REU' || t === 'RÉU') tipo = 'REU';
    else if (t === 'ADVOGADO') tipo = 'ADVOGADO';
    else if (t === 'REPRESENTANTE') tipo = 'REPRESENTANTE';
    else if (t.includes('CUMPRIMENTO')) tipo = 'ORGAO_DE_CUMPRIMENTO';
    else tipo = 'OUTRO';
  }
  if (tipo === 'OUTRO' && /procuradoria/i.test(texto)) {
    tipo = 'PROCURADORIA';
  }

  const semTipo = texto.replace(/\([^()]*\)\s*$/, '').trim();

  // OAB + CPF
  const oabCpf = semTipo.match(
    /^(.+?)\s*-\s*OAB\s+([A-Z]{2})\s*(\d+)\s*-\s*CPF:\s*([\d.\-]+)\s*$/i
  );
  if (oabCpf) {
    return {
      textoBruto: texto,
      nome: oabCpf[1].trim(),
      tipo,
      polo,
      documentoTipo: 'OAB',
      documentoNumero: `${oabCpf[2].toUpperCase()}${oabCpf[3]}`,
      oabUf: oabCpf[2].toUpperCase(),
      oabNumero: oabCpf[3]
    };
  }
  // OAB sem CPF
  const oabSomente = semTipo.match(
    /^(.+?)\s*-\s*OAB\s+([A-Z]{2})\s*(\d+)\s*$/i
  );
  if (oabSomente) {
    return {
      textoBruto: texto,
      nome: oabSomente[1].trim(),
      tipo,
      polo,
      documentoTipo: 'OAB',
      documentoNumero: `${oabSomente[2].toUpperCase()}${oabSomente[3]}`,
      oabUf: oabSomente[2].toUpperCase(),
      oabNumero: oabSomente[3]
    };
  }
  // CPF
  const cpfMatch = semTipo.match(/^(.+?)\s*-\s*CPF:\s*([\d.\-]+)\s*$/i);
  if (cpfMatch) {
    return {
      textoBruto: texto,
      nome: cpfMatch[1].trim(),
      tipo,
      polo,
      documentoTipo: 'CPF',
      documentoNumero: cpfMatch[2].trim(),
      oabUf: null,
      oabNumero: null
    };
  }
  // CNPJ
  const cnpjMatch = semTipo.match(/^(.+?)\s*-\s*CNPJ:\s*([\d.\-/]+)\s*$/i);
  if (cnpjMatch) {
    return {
      textoBruto: texto,
      nome: cnpjMatch[1].trim(),
      tipo,
      polo,
      documentoTipo: 'CNPJ',
      documentoNumero: cnpjMatch[2].trim(),
      oabUf: null,
      oabNumero: null
    };
  }

  return {
    textoBruto: texto,
    nome: semTipo,
    tipo,
    polo,
    documentoTipo: null,
    documentoNumero: null,
    oabUf: null,
    oabNumero: null
  };
}

/**
 * Helper para o coletor de Audiência: dada a lista de partes, escolhe o
 * advogado representativo do polo ativo. Quando há múltiplos, devolve o
 * primeiro — isso é estável porque a ordem do HTML do PJe é preservada
 * (o primeiro advogado listado é o principal).
 */
export function escolherAdvogadoAtivo(
  partes: ParteExtraida[]
): { nome: string | null; oab: string | null } {
  for (const p of partes) {
    if (p.tipo === 'ADVOGADO' && p.polo === 'ATIVO') {
      const oab =
        p.oabUf && p.oabNumero ? `OAB ${p.oabUf} ${p.oabNumero}` : null;
      return { nome: p.nome, oab };
    }
  }
  return { nome: null, oab: null };
}
