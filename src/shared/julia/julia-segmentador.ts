/**
 * Recorte da parte relevante de um documento da Júlia.
 *
 * ## O que se busca em cada tipo de ato
 *
 * A pergunta do "Fale com Júlia" é sobre **entendimento** — a razão de decidir —,
 * não sobre desfecho. Onde essa razão mora depende do ato:
 *
 * | Documento | Estrutura | Razão de decidir |
 * |---|---|---|
 * | Ementa (G2) | ementa direta | o próprio texto |
 * | Acórdão (TR/G2) | EMENTA → RELATÓRIO → VOTO → ACÓRDÃO | **EMENTA** |
 * | Sentença (G1/JEF) | RELATÓRIO → FUNDAMENTAÇÃO → DISPOSITIVO | **FUNDAMENTAÇÃO** |
 *
 * A ementa de acórdão é redigida justamente para condensar a tese. Já o
 * **dispositivo de sentença não serve a esse fim**: diz o resultado (procedente,
 * extinto) e as cominações, mas não diz por quê. Uma síntese construída sobre
 * dispositivos responderia "qual a taxa de procedência", não "qual o
 * entendimento" — verdadeira e inútil.
 *
 * O dispositivo continua sendo extraído, mas como **classificador de desfecho**
 * (campo `dispositivo`), não como fonte de tese. Os dois juntos permitem dizer
 * "a unidade adota a tese X, e nesse sentido julgou procedente em N casos".
 *
 * ## Custo: este módulo economiza pouco em sentença, e isso é aceito
 *
 * A fundamentação é a maior parte do ato — numa sentença de JEF de ~6.400 chars,
 * o dispositivo são ~5 linhas e quase todo o resto é fundamentação. Não há
 * recorte que traga a razão de decidir e corte volume ao mesmo tempo.
 *
 * A resposta ao custo não é truncar: é **reduzir o número de documentos** do
 * escopo da unidade e ler mais de cada um. Poucas sentenças com razão de decidir
 * valem mais que muitas com só o desfecho. O orçamento fica com o chamador, que
 * recebe `charsResultantes` para decidir.
 *
 * ## Atenção: fundamentação é densa em citação alheia
 *
 * Doutrina, ementas do STJ, acórdãos do TRF5, texto de lei — tudo transcrito
 * dentro da fundamentação. **São palavras de terceiros, não o entendimento da
 * unidade.**
 *
 * Este módulo **não** tenta removê-las. Distinguir "o juiz citando o STJ" de "o
 * juiz afirmando sua tese" é análise semântica; regex erraria nos dois sentidos,
 * às vezes apagando o raciocínio próprio. A mitigação fica no prompt —
 * instrução explícita de não atribuir à unidade o que ela apenas citou. Menos
 * elegante, mais robusto.
 *
 * ## Princípio: falhar para o lado seguro
 *
 * Sem estrutura reconhecível, devolve o **texto integral** com `secao:
 * 'integral'`. Nunca fragmento vazio, nunca recorte duvidoso em silêncio: um
 * recorte errado faz o modelo responder sobre um pedaço arbitrário achando que
 * tem a decisão, o que é pior do que responder sobre o todo.
 */

import { extrairEmenta } from './julia-client';
import type { JuliaDocumento } from './julia-types';

export type JuliaSecao = 'ementa' | 'fundamentacao' | 'integral';

export interface JuliaTrecho {
  /** Trecho com a razão de decidir — é o que vai ao prompt. */
  texto: string;
  /** Seção isolada. `'integral'` = estrutura não reconhecida, texto completo. */
  secao: JuliaSecao;
  /**
   * Dispositivo da sentença, quando identificado. Serve para classificar o
   * **desfecho**, não para extrair tese. `null` em acórdão e quando não achado.
   */
  dispositivo: string | null;
  charsOriginais: number;
  charsResultantes: number;
}

// ── Marcadores ───────────────────────────────────────────────────

/**
 * Abertura do dispositivo, em ordem de confiabilidade.
 *
 * Título explícito primeiro. As fórmulas de fecho são o caminho comum sem
 * numeração romana. `JULGO` isolado fica por último: aparece também na
 * fundamentação ao citar precedente.
 */
const MARCADORES_DISPOSITIVO: readonly RegExp[] = [
  /(?:^|\n)\s*(?:[IVX]+\s*[.\-–]\s*)?DISPOSITIVO\s*(?:\n|$)/i,
  /\b(?:Ante o exposto|Diante do exposto|Pelo exposto|Isso posto|Isto posto|Ex positis)\b/i,
  /\bJULGO\s+(?:PROCEDENTE|IMPROCEDENTE|PARCIALMENTE|EXTINTO)\b/i
];

/** Abertura da fundamentação. */
const MARCADORES_FUNDAMENTACAO: readonly RegExp[] = [
  /(?:^|\n)\s*(?:[IVX]+\s*[.\-–]\s*)?FUNDAMENTA[ÇC][ÃA]O\s*(?:\n|$)/i,
  /(?:^|\n)\s*(?:[IVX]+\s*[.\-–]\s*)?M[ÉE]RITO\s*(?:\n|$)/i,
  /\b(?:Passo à fundamentação|passo à fundamentação|É o relat[óo]rio)\b/i
];

/**
 * Última ocorrência de um marcador. A última, e não a primeira, porque as
 * fórmulas de fecho aparecem dentro de citações de precedente na fundamentação —
 * a do próprio ato é sempre a final.
 */
function ultimaOcorrencia(texto: string, marcador: RegExp): number {
  const flags = marcador.flags.includes('g') ? marcador.flags : `${marcador.flags}g`;
  const re = new RegExp(marcador.source, flags);
  let ultimo = -1;
  for (let m = re.exec(texto); m; m = re.exec(texto)) {
    ultimo = m.index;
    if (m.index === re.lastIndex) re.lastIndex++; // largura zero
  }
  return ultimo;
}

function primeiraOcorrencia(texto: string, marcador: RegExp): number {
  const m = new RegExp(marcador.source, marcador.flags.replace('g', '')).exec(texto);
  return m ? m.index + m[0].length : -1;
}

/** Recorte curto demais denuncia falso positivo (ex.: "JULGO" numa citação). */
const MINIMO_RECORTE = 80;

// ── Extratores ───────────────────────────────────────────────────

/**
 * Isola o dispositivo. É a última seção do ato, então basta achar a abertura e
 * ir até o fim.
 */
export function extrairDispositivo(texto: string): {
  dispositivo: string;
  foiRecortado: boolean;
} {
  for (const marcador of MARCADORES_DISPOSITIVO) {
    const inicio = ultimaOcorrencia(texto, marcador);
    if (inicio < 0) continue;
    const recorte = texto.slice(inicio).trim();
    if (recorte.length < MINIMO_RECORTE) continue;
    return { dispositivo: recorte, foiRecortado: true };
  }
  return { dispositivo: texto, foiRecortado: false };
}

/**
 * Isola a fundamentação — do fim do relatório ao início do dispositivo.
 *
 * Sem marcador de abertura reconhecível, começa do início do texto: o relatório
 * costuma ser curto (em JEF é frequentemente dispensado pelo art. 38 da Lei
 * 9.099/95), então incluí-lo custa pouco e é melhor que descartar a seção.
 */
export function extrairFundamentacao(texto: string): {
  fundamentacao: string;
  foiRecortada: boolean;
} {
  let fim = texto.length;
  for (const marcador of MARCADORES_DISPOSITIVO) {
    const i = ultimaOcorrencia(texto, marcador);
    if (i > 0) {
      fim = i;
      break;
    }
  }

  let inicio = 0;
  for (const marcador of MARCADORES_FUNDAMENTACAO) {
    const i = primeiraOcorrencia(texto.slice(0, fim), marcador);
    if (i >= 0) {
      inicio = i;
      break;
    }
  }

  const recorte = texto.slice(inicio, fim).trim();
  // Só vale como recorte se de fato removeu algo relevante.
  if (recorte.length < MINIMO_RECORTE || recorte.length === texto.length) {
    return { fundamentacao: texto, foiRecortada: false };
  }
  return { fundamentacao: recorte, foiRecortada: true };
}

// ── Classificação ────────────────────────────────────────────────

const TIPOS_SENTENCA = /senten[çc]a/i;
const TIPOS_ACORDAO = /ac[óo]rd[ãa]o|ementa|voto|apela[çc][ãa]o|recurso/i;
const INSTANCIAS_PRIMEIRO_GRAU = /^(G1|JEF)$/i;

/**
 * `tipoDocumento` é o sinal primário; `instancia` desempata. Nenhum dos dois é
 * confiável sozinho — os vocabulários divergem entre as duas APIs.
 */
function ehSentenca(doc: JuliaDocumento): boolean {
  const tipo = doc.tipoDocumento ?? '';
  if (TIPOS_SENTENCA.test(tipo)) return true;
  if (TIPOS_ACORDAO.test(tipo)) return false;
  return INSTANCIAS_PRIMEIRO_GRAU.test(doc.instancia ?? '');
}

// ── Entrada pública ──────────────────────────────────────────────

/**
 * Recorta o trecho com a razão de decidir.
 *
 * Pré-requisito: com `doc.textoCompleto === false` o `texto` é o trecho de busca
 * (~500 chars) da API autenticada, não o documento. Segmentar snippet não faz
 * sentido — devolve como está, marcado `'integral'`, sinalizando ao chamador que
 * falta `obterInteiroTeor()`.
 */
export function segmentar(doc: JuliaDocumento): JuliaTrecho {
  const charsOriginais = doc.texto.length;

  if (!doc.textoCompleto) {
    return {
      texto: doc.texto,
      secao: 'integral',
      dispositivo: null,
      charsOriginais,
      charsResultantes: charsOriginais
    };
  }

  if (ehSentenca(doc)) {
    const { fundamentacao, foiRecortada } = extrairFundamentacao(doc.texto);
    const { dispositivo, foiRecortado } = extrairDispositivo(doc.texto);
    return {
      texto: fundamentacao,
      secao: foiRecortada ? 'fundamentacao' : 'integral',
      dispositivo: foiRecortado ? dispositivo : null,
      charsOriginais,
      charsResultantes: fundamentacao.length
    };
  }

  // `tipoDocumento: EMENTA` **já é** a razão de decidir condensada — não há
  // seção a isolar. Sem este caso, o extrator procuraria marcadores de
  // RELATÓRIO/VOTO que não existem, cairia no caminho seguro e marcaria
  // `'integral'`: o orçamento então trataria como não-segmentado um documento
  // que já estava no formato ideal, e um só resultado consumiria a cota
  // inteira do escopo.
  if (/^\s*ementa\s*$/i.test(doc.tipoDocumento ?? '')) {
    return {
      texto: doc.texto,
      secao: 'ementa',
      dispositivo: null,
      charsOriginais,
      charsResultantes: charsOriginais
    };
  }

  const { ementa, foiRecortada } = extrairEmenta(doc.texto);
  return {
    texto: ementa,
    secao: foiRecortada ? 'ementa' : 'integral',
    dispositivo: null,
    charsOriginais,
    charsResultantes: ementa.length
  };
}
