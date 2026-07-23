/**
 * Anonimizador de textos de processo — passo 1 (máscara de dados pessoais
 * estruturados por regex). 100% LOCAL e DETERMINÍSTICO: nenhum dado sai da
 * máquina neste passo.
 *
 * Substitui dados que seguem padrões fixos — CPF, CNPJ, RG, OAB, CEP,
 * telefone, e-mail e dados bancários — por marcadores `[XXX OMITIDO]`.
 *
 * O passo 2 (nomes de pessoas físicas → papel processual) vive em
 * `anonymizer-partes.ts` e usa os dados ESTRUTURADOS de partes que o próprio
 * PJe fornece — também 100% local, sem chamada a modelo de IA. A antiga
 * etapa que enviava o cabeçalho dos autos ao provedor externo foi removida.
 *
 * Este arquivo expõe utilitários puros (sem Chrome APIs), invocáveis tanto
 * pelo content script quanto pelo background. É também consumido por
 * `julia-prompts.ts` e `triagem-anonymize.ts` — a assinatura de
 * `aplicarRegexAnonimizacao(texto): string` é mantida por compatibilidade.
 *
 * ATENÇÃO — número CNJ NÃO é mascarado aqui de propósito: `triagem-anonymize`
 * precisa preservar o CNJ do próprio processo (informação pública) e trata os
 * CNJs de terceiros por conta própria. Máscara de CNJ, quando desejada, é
 * responsabilidade do chamador.
 */

// =====================================================================
// Passo 1 — regex de dados pessoais estruturados
// =====================================================================

/** Tipos de dado pessoal estruturado reconhecidos pelo passo 1. */
export type TipoPII =
  | 'CPF'
  | 'CNPJ'
  | 'RG'
  | 'OAB'
  | 'CEP'
  | 'telefone'
  | 'email'
  | 'bancario';

export type ContagemPII = Record<TipoPII, number>;

export function contagemPiiZerada(): ContagemPII {
  return {
    CPF: 0,
    CNPJ: 0,
    RG: 0,
    OAB: 0,
    CEP: 0,
    telefone: 0,
    email: 0,
    bancario: 0
  };
}

// CPF pontuado canônico: 000.000.000-00
const RE_CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
// CPF ancorado por rótulo, tolerando pontuação ausente: "CPF nº 00000000000"
const RE_CPF_ANCORADO =
  /\b(?:CPF|C\.P\.F\.?)\s*(?:n[º°o.]*)?\s*:?\s*\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/gi;
// CNPJ com ou sem pontuação: 00.000.000/0000-00
const RE_CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g;
// OAB: "OAB/CE 12345", "OAB CE12345", "OAB-SP 123456"
const RE_OAB = /\bOAB\s*[-/]?\s*[A-Z]{2}\s*\.?\s*\d{3,6}\b/gi;
// CEP: 00000-000
const RE_CEP = /\b\d{5}-\d{3}\b/g;
// E-mail
const RE_EMAIL = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;
// Telefone: (00) 00000-0000 | 00 0000-0000 | 00000-0000. Guarda de dígitos
// no callback descarta faixas curtas (datas/protocolos "0000-0000").
const RE_TELEFONE = /(?:\(\d{2}\)\s?|\b\d{2}\s)?\b\d{4,5}-\d{4}\b/g;
// RG pontuado: exige os pontos reais (0.000.000 / 00.000.000-0). O callback
// descarta matches colados a "/" ou "." (números de processo, protocolos,
// referências de lei) para evitar falsos positivos.
const RE_RG = /\b\d{1,2}\.\d{3}\.\d{3}-?[\dXx]?\b/g;
// Dados bancários ancorados por rótulo — preserva o rótulo, mascara o número.
const RE_BANCARIO =
  /\b(ag[êe]ncia|conta(?:\s+corrente)?|conta\s+poupan[çc]a)\s*(?:n[º°o.]*)?\s*:?\s*[\d][\d.\-]{2,14}\b/gi;

/** Aplica `regex` substituindo por `marcador` e soma no contador por tipo. */
function mascarar(
  texto: string,
  regex: RegExp,
  marcador: string,
  contagem: ContagemPII,
  tipo: TipoPII
): string {
  return texto.replace(regex, () => {
    contagem[tipo]++;
    return marcador;
  });
}

/**
 * Aplica todas as máscaras de dados pessoais estruturados, acumulando as
 * contagens por tipo. A ordem importa: padrões mais específicos primeiro; RG
 * por último (o mais genérico) para não comer fragmentos de CPF/CNPJ.
 */
export function aplicarRegexAnonimizacaoContado(
  texto: string,
  contagem: ContagemPII = contagemPiiZerada()
): { texto: string; contagem: ContagemPII } {
  let r = texto;

  r = mascarar(r, RE_CNPJ, '[CNPJ OMITIDO]', contagem, 'CNPJ');
  r = mascarar(r, RE_CPF_ANCORADO, '[CPF OMITIDO]', contagem, 'CPF');
  r = mascarar(r, RE_CPF, '[CPF OMITIDO]', contagem, 'CPF');
  r = mascarar(r, RE_OAB, '[OAB OMITIDA]', contagem, 'OAB');
  r = mascarar(r, RE_EMAIL, '[EMAIL OMITIDO]', contagem, 'email');
  r = mascarar(r, RE_CEP, '[CEP OMITIDO]', contagem, 'CEP');

  // Telefone: descarta matches com menos de 8 dígitos (datas, protocolos).
  r = r.replace(RE_TELEFONE, (m) => {
    if (m.replace(/\D/g, '').length < 8) return m;
    contagem.telefone++;
    return '[TELEFONE OMITIDO]';
  });

  // Bancário: preserva o rótulo (agência/conta), mascara só o número.
  r = r.replace(RE_BANCARIO, (_m, rotulo: string) => {
    contagem.bancario++;
    return `${rotulo} [DADO BANCÁRIO OMITIDO]`;
  });

  // RG por último e com cautela: descarta matches colados a "/" ou "."
  // (números de processo antigos, protocolos, referências de leis).
  r = r.replace(RE_RG, (m, indice: number, todo: string) => {
    const antes = todo[indice - 1] ?? '';
    const depois = todo[indice + m.length] ?? '';
    if (antes === '/' || depois === '/' || antes === '.' || depois === '.') {
      return m;
    }
    contagem.RG++;
    return '[RG OMITIDO]';
  });

  return { texto: r, contagem };
}

/**
 * Aplica as substituições por regex (passo 1). Roda 100% local. Wrapper de
 * `aplicarRegexAnonimizacaoContado` que descarta a contagem — assinatura
 * mantida por compatibilidade com `julia-prompts.ts` e `triagem-anonymize.ts`.
 */
export function aplicarRegexAnonimizacao(texto: string): string {
  return aplicarRegexAnonimizacaoContado(texto).texto;
}

/**
 * Verificação de auditoria: devolve a lista de tipos de PII cujo padrão ainda
 * aparece no texto (rede de segurança pós-anonimização). Não modifica nada.
 */
export function verificarResiduosPii(texto: string): string[] {
  const residuos: string[] = [];
  const checagens: Array<[string, RegExp]> = [
    ['CPF', /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/],
    ['CNPJ', /\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/],
    ['e-mail', /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/],
    ['CEP', /\b\d{5}-\d{3}\b/]
  ];
  for (const [nome, rgx] of checagens) {
    if (rgx.test(texto)) residuos.push(nome);
  }
  return residuos;
}
