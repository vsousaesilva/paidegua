/**
 * Passo 2 da anonimização — substituição dos nomes de pessoas físicas pelo
 * respectivo papel processual, usando os dados ESTRUTURADOS de partes que o
 * próprio PJe fornece (bloco de qualificação de `listAutosDigitais.seam`).
 *
 * 100% LOCAL e DETERMINÍSTICO — nenhum dado pessoal é enviado a modelo de IA
 * para "descobrir" nomes. Substitui a antiga etapa que mandava os primeiros
 * 12k caracteres ao provedor externo. Requisito de conformidade CNJ/LGPD.
 *
 * Este módulo é puro (sem Chrome APIs, sem dependência do content script):
 * recebe uma lista de partes num formato estrutural mínimo — que a interface
 * `ParteExtraida` de `content/pje-api/pje-api-partes.ts` satisfaz — e devolve
 * as substituições prontas. O mapeamento de tipo/polo → papel é feito aqui.
 */

/**
 * Formato mínimo de parte esperado por este módulo. É um subconjunto
 * estrutural de `ParteExtraida` (pje-api-partes.ts), declarado localmente
 * para manter `shared` desacoplado do content script. `tipo` e `polo` são
 * tratados como string e normalizados internamente.
 */
export interface ParteAnonimizavel {
  nome: string;
  /** AUTOR | REU | ADVOGADO | REPRESENTANTE | PROCURADORIA | ORGAO_DE_CUMPRIMENTO | OUTRO */
  tipo: string;
  /** ATIVO | PASSIVO | OUTROS | DESCONHECIDO */
  polo: string;
  documentoTipo?: 'CPF' | 'CNPJ' | 'OAB' | null;
  documentoNumero?: string | null;
  /** Heurística do extrator: nome sugere ente/órgão público. */
  ehOrgaoPublico?: boolean;
}

export interface SubstituicaoNome {
  /** Nome original (como veio da qualificação do PJe). */
  original: string;
  /** Marcador de papel processual (ex.: "[PARTE AUTORA]"). */
  substituto: string;
  /** Regex acento- e caixa-insensível que casa o nome completo no texto. */
  regex: RegExp;
}

/**
 * Entidades públicas/jurídicas notórias que jamais são dado pessoal e cujo
 * nome deve ser preservado no texto (institucional, não PII).
 */
const RE_ENTIDADE_PUBLICA =
  /\b(INSS|INCRA|IBAMA|FUNAI|UNI[ÃA]O|FAZENDA (NACIONAL|P[ÚU]BLICA)|ESTADO D[EOA]|MUNIC[ÍI]PIO|MINIST[ÉE]RIO|PROCURADORIA|DEFENSORIA|CAIXA ECON[ÔO]MICA|BANCO D[OE]|EMPRESA BRASILEIRA|AG[ÊE]NCIA NACIONAL|FUNDA[ÇC][ÃA]O (NACIONAL|P[ÚU]BLICA)|DEPARTAMENTO NACIONAL|UNIVERSIDADE FEDERAL|INSTITUTO FEDERAL|CONSELHO (FEDERAL|REGIONAL))\b/i;

/** Sufixos/termos que caracterizam pessoa jurídica de direito privado. */
const RE_PESSOA_JURIDICA =
  /\b(LTDA|S\.?\s?A\.?|EIRELI|MEI|EPP|CIA|COMPANHIA|COOPERATIVA|ASSOCIA[ÇC][ÃA]O|SINDICATO|CONDOM[ÍI]NIO|SOCIEDADE)\b/i;

/** Normaliza (remove acentos, caixa alta) para comparação de rótulos. */
function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
}

/**
 * `true` quando a parte é pessoa jurídica ou ente público — nesses casos o
 * nome é preservado no texto (não é PII). Advogados e representantes são
 * sempre pessoas físicas, ainda que o nome case por acaso com o regex de PJ.
 */
export function ehPessoaJuridica(parte: ParteAnonimizavel): boolean {
  const tipo = normalizar(parte.tipo);
  if (tipo === 'ADVOGADO' || tipo === 'REPRESENTANTE') return false;
  if (tipo === 'PROCURADORIA' || tipo === 'ORGAO_DE_CUMPRIMENTO') return true;
  if (parte.ehOrgaoPublico) return true;
  if (parte.documentoTipo === 'CNPJ') return true;
  const soDigitos = (parte.documentoNumero ?? '').replace(/\D/g, '');
  if (soDigitos.length === 14) return true;
  if (RE_ENTIDADE_PUBLICA.test(parte.nome)) return true;
  if (RE_PESSOA_JURIDICA.test(parte.nome)) return true;
  return false;
}

/**
 * Mapeia tipo + polo da parte para o papel processual canônico (sem acento,
 * caixa alta), usado como chave dos contadores. O rótulo legível é resolvido
 * depois em `ROTULOS_LEGIVEIS`.
 */
function papelCanonico(parte: ParteAnonimizavel): string {
  const tipo = normalizar(parte.tipo);
  const polo = normalizar(parte.polo);

  if (tipo === 'AUTOR') return 'PARTE AUTORA';
  if (tipo === 'REU') return 'PARTE RE';
  if (tipo === 'ADVOGADO') {
    if (polo === 'ATIVO') return 'ADVOGADO DO POLO ATIVO';
    if (polo === 'PASSIVO') return 'ADVOGADO DO POLO PASSIVO';
    return 'ADVOGADO';
  }
  if (tipo === 'REPRESENTANTE') {
    if (polo === 'ATIVO') return 'REPRESENTANTE DA PARTE AUTORA';
    if (polo === 'PASSIVO') return 'REPRESENTANTE DA PARTE RE';
    return 'REPRESENTANTE';
  }
  // OUTRO / DESCONHECIDO — decide pelo polo.
  if (polo === 'ATIVO') return 'PARTE DO POLO ATIVO';
  if (polo === 'PASSIVO') return 'PARTE DO POLO PASSIVO';
  return 'TERCEIRO INTERESSADO';
}

/** Chaves canônicas (sem acento) → rótulo legível exibido no texto. */
const ROTULOS_LEGIVEIS: Record<string, string> = {
  'PARTE RE': 'PARTE RÉ',
  'REPRESENTANTE DA PARTE RE': 'REPRESENTANTE DA PARTE RÉ'
};

/**
 * Constrói um regex que casa `nome` no texto de forma acento- e
 * caixa-insensível, tolerando espaçamento variável entre os tokens e
 * respeitando fronteiras de palavra Unicode (não casa dentro de outra
 * palavra maior).
 */
export function regexDeNome(nome: string): RegExp {
  const CLASSES: Record<string, string> = {
    a: '[aáàâãä]',
    e: '[eéèêë]',
    i: '[iíìîï]',
    o: '[oóòôõö]',
    u: '[uúùûü]',
    c: '[cç]',
    n: '[nñ]'
  };
  const base = nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  let corpo = '';
  for (const caractere of base) {
    if (caractere === ' ') corpo += '\\s+';
    else if (CLASSES[caractere]) corpo += CLASSES[caractere];
    else if (/[a-z0-9]/.test(caractere)) corpo += caractere;
    else corpo += '\\' + caractere;
  }
  return new RegExp(`(?<!\\p{L})${corpo}(?!\\p{L})`, 'giu');
}

/**
 * Monta a lista de substituições nome → papel processual a partir das partes
 * qualificadas do PJe. Pessoas jurídicas e entes públicos são preservados.
 * Nomes mais longos primeiro, para que "JOSÉ DA SILVA FILHO" seja tratado
 * antes de um eventual "JOSÉ DA SILVA".
 */
export function montarSubstituicoesPartes(
  partes: ParteAnonimizavel[]
): SubstituicaoNome[] {
  const contadores = new Map<string, number>();
  const substituicoes: SubstituicaoNome[] = [];
  const jaVistos = new Set<string>();

  const pessoas = partes
    .filter((p) => p.nome && p.nome.trim().length >= 3 && !ehPessoaJuridica(p))
    .sort((a, b) => b.nome.length - a.nome.length);

  for (const parte of pessoas) {
    const chave = normalizar(parte.nome);
    if (jaVistos.has(chave)) continue;
    jaVistos.add(chave);

    const canonico = papelCanonico(parte);
    const usados = contadores.get(canonico) ?? 0;
    contadores.set(canonico, usados + 1);
    const rotulo = ROTULOS_LEGIVEIS[canonico] ?? canonico;
    const substituto = `[${rotulo}${usados > 0 ? ` ${usados + 1}` : ''}]`;
    substituicoes.push({
      original: parte.nome,
      substituto,
      regex: regexDeNome(parte.nome)
    });
  }
  return substituicoes;
}

/** Aplica as substituições de nome no texto (sem contagem). */
export function aplicarSubstituicoesPartes(
  texto: string,
  substituicoes: SubstituicaoNome[]
): string {
  return aplicarSubstituicoesPartesContado(texto, substituicoes).texto;
}

/**
 * Aplica as substituições de nome e conta quantas ocorrências foram trocadas.
 * Cada regex tem `lastIndex` resetado antes do uso (são globais e reutilizados
 * entre documentos).
 */
export function aplicarSubstituicoesPartesContado(
  texto: string,
  substituicoes: SubstituicaoNome[]
): { texto: string; contagem: number } {
  let resultado = texto;
  let contagem = 0;
  for (const s of substituicoes) {
    s.regex.lastIndex = 0;
    resultado = resultado.replace(s.regex, () => {
      contagem++;
      return s.substituto;
    });
  }
  return { texto: resultado, contagem };
}
