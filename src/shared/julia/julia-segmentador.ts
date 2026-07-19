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

// ── Cabeçalho ────────────────────────────────────────────────────

/**
 * Linhas de cabeçalho do ato: órgão, autuação e qualificação das partes.
 *
 * Sempre no topo e sempre reconhecíveis — ao contrário do relatório, que nem
 * sempre tem título e por isso é tolerado quando não se identifica.
 */
const LINHA_CABECALHO =
  /^[ \t]*(?:PODER JUDICI[ÁA]RIO|JUSTI[ÇC]A FEDERAL|SE[ÇC][ÃA]O JUDICI[ÁA]RIA|TRIBUNAL REGIONAL FEDERAL|\d+[ªa]?\s+(?:VARA|TURMA|RELATORIA)[^\n]*|(?:AUTOR|R[ÉE]U|REQUERENTE|REQUERIDO|RECORRENTE|RECORRIDO|APELANTE|APELADO|AGRAVANTE|AGRAVADO|EMBARGANTE|EMBARGADO|IMPETRANTE|IMPETRADO|EXEQUENTE|EXECUTADO|ADVOGADO|PROCURADOR|MAGISTRADO|JUIZ|RELATOR)[^\n:]*:[^\n]*|[^\n]*\(\d+\)\s*N[ºo°][^\n]*|SENTEN[ÇC]A|DECIS[ÃA]O|AC[ÓO]RD[ÃA]O)[ \t]*$/i;

/** Só procuramos cabeçalho no começo — ele nunca está no meio do ato. */
const JANELA_CABECALHO = 3_000;

/**
 * Remove o cabeçalho do ato.
 *
 * Corta até a **última** linha de cabeçalho encontrada na janela inicial, o que
 * dá conta da ordem variável (às vezes o título SENTENÇA vem antes das partes,
 * às vezes depois).
 *
 * Fail-safe duplo: não corta se o resultado ficar curto demais ou se for
 * remover mais que a janela — cabeçalho é dezenas de linhas, não metade do
 * documento.
 */
export function removerCabecalho(texto: string): string {
  const janela = texto.slice(0, JANELA_CABECALHO);
  const linhas = janela.split(/\r?\n/);

  let corte = -1;
  let posicao = 0;
  for (const linha of linhas) {
    posicao += linha.length + 1;
    if (linha.trim() && LINHA_CABECALHO.test(linha)) corte = posicao;
  }
  if (corte <= 0) return texto;

  const resto = texto.slice(corte).trim();
  return resto.length >= MINIMO_RECORTE ? resto : texto;
}

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
    // Sem marcador de fundamentação, ao menos tiramos o cabeçalho: ele é
    // sempre identificável, ao contrário do relatório, que muitas vezes não
    // tem título e por isso é tolerado.
    return { fundamentacao: removerCabecalho(texto), foiRecortada: false };
  }
  return { fundamentacao: removerCabecalho(recorte), foiRecortada: true };
}

// ── Ementa pura ──────────────────────────────────────────────────

/** Linha que contém só a palavra EMENTA — o título da seção. */
const TITULO_EMENTA = /(?:^|\n)[ \t]*EMENTA[ \t]*:?[ \t]*(?=\n|$)/gi;

/** Abaixo disso o que veio depois do título não é a ementa, é sobra. */
const MINIMO_EMENTA = 200;

/**
 * Isola a ementa do cabeçalho que a precede.
 *
 * Documento do tipo `EMENTA` no acervo do TRF5 não é só a ementa: vem com o
 * cabeçalho do órgão (tribunal, turma, classe, número) e a qualificação das
 * partes, e só então o título EMENTA e o texto. Devolver esse conjunto como
 * "a ementa" suja a cópia para minuta e torna a aba de texto completo idêntica
 * à de ementa.
 *
 * Pegamos a **última** ocorrência do título que ainda deixe conteúdo
 * substancial depois: acórdãos costumam repetir o cabeçalho e o título, e a
 * ementa verdadeira vem após a última repetição. O piso de caracteres evita
 * cair num "EMENTA" citado dentro de precedente transcrito no fim do texto.
 */
export function extrairEmentaPura(texto: string): {
  ementa: string;
  foiRecortada: boolean;
} {
  const re = new RegExp(TITULO_EMENTA.source, TITULO_EMENTA.flags);
  let inicio = -1;
  for (let m = re.exec(texto); m; m = re.exec(texto)) {
    const fim = m.index + m[0].length;
    if (texto.length - fim >= MINIMO_EMENTA) inicio = fim;
  }
  if (inicio < 0) return { ementa: texto, foiRecortada: false };

  const recorte = texto.slice(inicio).trim();
  return recorte.length >= MINIMO_EMENTA
    ? { ementa: recorte, foiRecortada: true }
    : { ementa: texto, foiRecortada: false };
}

// ── Descarte de transcrições ─────────────────────────────────────

/**
 * Fecho de citação usado no acervo do TRF5 e nos tribunais superiores.
 *
 * É o marcador mais confiável de que o que veio antes são palavras de OUTRO
 * órgão: um juiz não encerra o próprio raciocínio com a referência do julgado
 * que acabou de proferir.
 */
const FECHO_CITACAO =
  /\((?:PROCESSO:|TRF5\.|REsp|AgRg|AgInt|EDcl|PEDILEF|RE |AI |ADI )[^)]{10,400}\)/gi;

/** Introdução típica de transcrição: linha terminada em dois-pontos. */
const ABERTURA_TRANSCRICAO = /:\s*$/;

/** Abaixo disso não vale remover — é referência curta, não bloco transcrito. */
const MINIMO_TRANSCRICAO = 300;

/**
 * Proporção máxima do texto que aceitamos descartar.
 *
 * Passar disso indica que a heurística se perdeu — melhor devolver o texto
 * íntegro e gastar orçamento do que entregar ao modelo um documento mutilado
 * achando que é a fundamentação.
 */
const MAX_PROPORCAO_REMOVIDA = 0.7;

/**
 * Remove blocos transcritos de doutrina, ementas e precedentes alheios.
 *
 * ## Por que agora, tendo eu recusado antes
 *
 * Recusei fazer isso por regex argumentando que separar "citar" de "decidir" é
 * análise semântica. O argumento vale no geral e falhou no caso concreto: em
 * temas citação-pesados (medicamento off-label, por exemplo) uma sentença
 * chega a 24 mil caracteres e o orçamento se esgota em cinco documentos de 775
 * encontrados. O custo de não recortar passou a ser maior que o risco de
 * recortar.
 *
 * ## A regra, e por que ela é conservadora
 *
 * Só removemos um trecho quando ele tem **as duas** marcas ao mesmo tempo:
 * abertura por linha terminada em dois-pontos (a introdução clássica de
 * transcrição) e fecho por referência de julgado. Texto próprio do juiz
 * raramente termina com a referência de um acórdão alheio.
 *
 * Exigir as duas marcas reduz muito o alcance — várias transcrições escapam —
 * mas erra para o lado seguro: o que passa custa orçamento, o que é removido
 * por engano custaria razão de decidir.
 *
 * ## Fail-safe
 *
 * Se o resultado ficar abaixo de 30% do original, devolvemos o texto íntegro:
 * remoção dessa magnitude é sinal de heurística perdida, não de documento
 * citação-pesado.
 */
export function removerTranscricoes(texto: string): {
  texto: string;
  charsRemovidos: number;
} {
  const linhas = texto.split(/\r?\n/);
  const manter: string[] = [];
  let buffer: string[] = [];
  let bufferAberto = false;

  const descarregar = (transcricao: boolean): void => {
    const bloco = buffer.join('\n');
    // Bloco curto não compensa remover, mesmo casando as duas marcas.
    if (!transcricao || bloco.length < MINIMO_TRANSCRICAO) manter.push(bloco);
    buffer = [];
    bufferAberto = false;
  };

  for (const linha of linhas) {
    if (bufferAberto) {
      buffer.push(linha);
      FECHO_CITACAO.lastIndex = 0;
      if (FECHO_CITACAO.test(linha)) descarregar(true);
      // Bloco longo demais sem fecho: provavelmente não é transcrição.
      else if (buffer.join('\n').length > 12_000) descarregar(false);
      continue;
    }
    if (ABERTURA_TRANSCRICAO.test(linha)) {
      buffer.push(linha);
      bufferAberto = true;
      continue;
    }
    manter.push(linha);
  }
  if (bufferAberto) descarregar(false);

  const limpo = manter
    .join('\n')
    // Remove também as referências soltas que ficaram no meio do texto próprio.
    .replace(FECHO_CITACAO, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (limpo.length < texto.length * (1 - MAX_PROPORCAO_REMOVIDA)) {
    return { texto, charsRemovidos: 0 };
  }
  return { texto: limpo, charsRemovidos: texto.length - limpo.length };
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
    // Só na fundamentação: é onde se acumulam doutrina e precedente alheio. O
    // dispositivo é curto e não transcreve.
    const { texto: enxuto } = removerTranscricoes(fundamentacao);
    return {
      texto: enxuto,
      secao: foiRecortada ? 'fundamentacao' : 'integral',
      dispositivo: foiRecortado ? dispositivo : null,
      charsOriginais,
      charsResultantes: enxuto.length
    };
  }

  // `tipoDocumento: EMENTA` dispensa a busca por RELATÓRIO/VOTO, que não
  // existem ali — mas o documento **não é só a ementa**: traz antes o
  // cabeçalho do órgão e a qualificação das partes. Isolamos a ementa de fato,
  // para que a cópia sirva a uma minuta e para que a aba de texto completo
  // tenha conteúdo distinto.
  if (/^\s*ementa\s*$/i.test(doc.tipoDocumento ?? '')) {
    const { ementa } = extrairEmentaPura(doc.texto);
    return {
      texto: ementa,
      secao: 'ementa',
      dispositivo: null,
      charsOriginais,
      charsResultantes: ementa.length
    };
  }

  // Acórdão completo: recorta a seção EMENTA de dentro dele e, em seguida,
  // descarta o cabeçalho que ainda vier junto.
  const { ementa, foiRecortada } = extrairEmenta(doc.texto);
  const puro = extrairEmentaPura(ementa).ementa;
  return {
    texto: puro,
    secao: foiRecortada ? 'ementa' : 'integral',
    dispositivo: null,
    charsOriginais,
    charsResultantes: puro.length
  };
}
