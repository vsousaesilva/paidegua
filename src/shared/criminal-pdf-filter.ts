/**
 * Identificação de documentos "principais" para a Gestão Criminal —
 * aqueles que carregam dados-chave do processo (datas, penas, ANPP)
 * e merecem extração via IA.
 *
 * O PJe legacy não traz códigos TPU dos documentos no DOM dos autos
 * digitais; só o `tipo` (ex.: "Sentença", "Petição inicial") e a
 * `descricao` (texto livre escrito pelo registrador, ex.: "DENÚNCIA MPF",
 * "SENTENÇA HOMOLOGATÓRIA"). Esses dois campos juntos são o que usamos
 * para filtrar.
 *
 * Por que isso importa: a maioria dos processos criminais hoje em
 * andamento foi migrada de outros sistemas e os movimentos canônicos
 * (recebimento, sentença, ANPP) só existem dentro dos PDFs anexados.
 * O scraping puro da timeline pega só movimentos pós-migração; a IA
 * sobre os PDFs principais cobre o histórico anterior.
 */

import type { ProcessoDocumento } from './types';

export type TipoDocumentoPrincipal =
  | 'denuncia'
  | 'recebimento_denuncia'
  | 'sentenca'
  | 'homologacao_anpp'
  | 'acordo_anpp'
  | 'suspensao_366'
  | 'decisao_generica'
  | 'documento_migrado';

interface FiltroPrincipal {
  tipo: TipoDocumentoPrincipal;
  /** Regex aplicada em (`tipo + descricao`) lowercase do documento. */
  regex: RegExp;
  /** Prioridade (maior = mais importante). Usada na ordenação. */
  prioridade: number;
}

/**
 * Padrões de identificação. Aplicados na concatenação `tipo descricao`.
 * Ordem importa: o primeiro filtro a casar define o `tipoPrincipal`,
 * mesmo que padrões mais específicos pudessem casar adiante. Por isso
 * patrons mais específicos vêm primeiro.
 *
 * Cada tipo tem dois grupos de filtros:
 *   - Keyword explícito (palavra completa, ex.: "denúncia", "sentença")
 *   - Marcador de migração — abreviações curtas (3-4 letras maiúsculas)
 *     seguidas de número, comuns em docs migrados de outros sistemas
 *     no TRF5: "DEN 0817354 36.2024.4.05.8100", "SENT 12345", etc.
 *
 * O usuário escreveu o nome — pode estar errado, abreviado ou misturado.
 * Casamos pelos dois caminhos pra reduzir falsos negativos.
 */
const FILTROS: readonly FiltroPrincipal[] = [
  // ── Homologação ANPP ───────────────────────────────────────────
  {
    tipo: 'homologacao_anpp',
    regex: /(homolog|decis[aã]o).{0,40}(anpp|persecu[cç][aã]o\s+penal|persecutor)/i,
    prioridade: 100
  },
  {
    tipo: 'homologacao_anpp',
    regex: /\b(HOM|HOMOL)\b.{0,5}(ANPP|PERSEC)/i,
    prioridade: 95
  },

  // ── Acordo ANPP ────────────────────────────────────────────────
  {
    tipo: 'acordo_anpp',
    regex: /\bacordo\b.{0,30}\bpersecu[cç][aã]o/i,
    prioridade: 92
  },
  {
    tipo: 'acordo_anpp',
    regex: /\bANPP\b/i,
    prioridade: 90
  },

  // ── Recebimento da denúncia ────────────────────────────────────
  {
    tipo: 'recebimento_denuncia',
    regex: /(recebimento.{0,15}den[uú]ncia|recebid[oa]\s+a\s+den[uú]ncia)/i,
    prioridade: 88
  },

  // ── Suspensão pelo art. 366 CPP ────────────────────────────────
  {
    tipo: 'suspensao_366',
    regex: /suspens[aã]o.{0,30}366/i,
    prioridade: 85
  },

  // ── Sentença ───────────────────────────────────────────────────
  {
    tipo: 'sentenca',
    regex: /\bsenten[cç]a\b/i,
    prioridade: 80
  },
  // Marcador de migração: SENT seguido de número (ex.: "SENT 12345")
  {
    tipo: 'sentenca',
    regex: /\bSENT\b\s*\d/,
    prioridade: 75
  },

  // ── Denúncia ───────────────────────────────────────────────────
  {
    tipo: 'denuncia',
    regex: /\bden[uú]ncia\b/i,
    prioridade: 70
  },
  // Marcador de migração: DEN seguido de número/processo (ex.: "DEN 0817354 36.2024.4.05.8100")
  {
    tipo: 'denuncia',
    regex: /\bDEN\b\s*\d/,
    prioridade: 65
  },

  // ── Decisão genérica ───────────────────────────────────────────
  {
    tipo: 'decisao_generica',
    regex: /\bdecis[aã]o\b/i,
    prioridade: 30
  },
  // Marcador de migração: DEC seguido de número
  {
    tipo: 'decisao_generica',
    regex: /\bDEC\b\s*\d/,
    prioridade: 25
  },

  // ── Documento de Comprovação migrado (catch-all com sinal) ─────
  // Captura "Documento de Comprovação <ABREV> <numero>" — padrão típico
  // de migração no TRF5, onde a descrição é só uma sigla cripta seguida
  // do número do doc/processo de origem (ex.: "INQ 12345", "DSP 99999").
  // Prioridade baixa porque é um catch-all; o conteúdo é validado pela
  // detecção de stub (texto > 500 chars) e pela IA depois.
  {
    tipo: 'documento_migrado',
    regex: /comprova[cç][aã]o.{0,40}\b[A-ZÁÉÍÓÚ]{3,5}\b\s*\d/i,
    prioridade: 20
  }
];

export interface DocumentoPrincipalIdentificado {
  /** Documento original. */
  documento: ProcessoDocumento;
  /** Classificação atribuída pelo filtro. */
  tipoPrincipal: TipoDocumentoPrincipal;
  /** Prioridade (para ordenação). */
  prioridade: number;
}

/**
 * Filtra a lista de documentos do processo deixando apenas os
 * "principais" — aqueles que casam algum dos padrões definidos.
 *
 * Cada documento é avaliado contra os filtros em ordem de prioridade;
 * o primeiro que casar define o `tipoPrincipal`.
 *
 * Retorna a lista ordenada por prioridade (mais relevante primeiro)
 * e, dentro do mesmo tipo, do mais recente para o mais antigo (pela
 * `dataMovimentacao` do documento).
 */
export function filtrarDocumentosPrincipais(
  documentos: readonly ProcessoDocumento[]
): DocumentoPrincipalIdentificado[] {
  const out: DocumentoPrincipalIdentificado[] = [];
  for (const doc of documentos) {
    const haystack = `${doc.tipo ?? ''} ${doc.descricao ?? ''}`.toLowerCase();
    for (const filtro of FILTROS) {
      if (filtro.regex.test(haystack)) {
        out.push({
          documento: doc,
          tipoPrincipal: filtro.tipo,
          prioridade: filtro.prioridade
        });
        break; // primeiro match vence
      }
    }
  }

  // Ordena: prioridade desc, depois data desc (mais recente primeiro).
  out.sort((a, b) => {
    if (a.prioridade !== b.prioridade) return b.prioridade - a.prioridade;
    const dataA = a.documento.dataMovimentacao ?? '';
    const dataB = b.documento.dataMovimentacao ?? '';
    return dataB.localeCompare(dataA);
  });

  // Heurística: quando há docs de tipo "rico" (denúncia, sentença,
  // homologação ANPP, acordo ANPP, recebimento, suspensão), descartar
  // `documento_migrado` e `decisao_generica` para focar a IA no
  // conteúdo que a denúncia/sentença trazem (tipo_crime, data_fato,
  // pena, etc.). Migrados são metadata curta (<2k chars) que polui
  // a mesclagem com `null`s; decisões genéricas costumam ser
  // intimações/audiências sem dados estruturados.
  //
  // Quando NÃO há doc rico (caso típico de processo migrado de
  // 2013+ onde só sobraram decisões genéricas e referências), mantém
  // o que tem — é o melhor que conseguimos.
  const TIPOS_RICOS = new Set<TipoDocumentoPrincipal>([
    'denuncia',
    'sentenca',
    'recebimento_denuncia',
    'homologacao_anpp',
    'acordo_anpp',
    'suspensao_366'
  ]);
  const temDocRico = out.some((p) => TIPOS_RICOS.has(p.tipoPrincipal));
  if (temDocRico) {
    return out.filter(
      (p) =>
        p.tipoPrincipal !== 'documento_migrado' &&
        p.tipoPrincipal !== 'decisao_generica'
    );
  }
  return out;
}
