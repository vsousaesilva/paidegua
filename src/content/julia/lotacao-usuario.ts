/**
 * Leitura da lotação (unidade) do usuário logado no PJe, para pré-marcar a
 * unidade do magistrado nos formulários da Júlia — tanto no "Fale com a Júlia"
 * quanto na análise preditiva.
 *
 * O PJe exibe no masthead um cabeçalho no formato
 * `{unidade} / {papel} / {cargo}` — ex.: "35ª Vara Federal CE / Direção de
 * Secretaria / Diretor de Secretaria", "10ª Vara Federal AL / Juiz Federal
 * Titular". O texto vem tanto no atributo `title`/`data-original-title` quanto
 * num `<small>` dentro de `.bloco-va-mid`. A unidade é o primeiro segmento,
 * com a UF ao fim.
 *
 * Não há fonte estruturada limpa dessa informação: o header
 * `X-pje-usuario-localizacao` capturado do tráfego é um ID numérico, e o
 * `nomeVara` das settings é opcional e voltado à Secretaria. Por isso lemos do
 * DOM do masthead, que é estável entre versões do PJe.
 */

import { coletarDocumentosAcessiveis } from '../ckeditor-bridge';
import type { JuliaOrgao } from '../../shared/julia/julia-types';

/** UF (final do primeiro segmento) → seccional da Júlia. */
const UF_PARA_ORGAO: Record<string, JuliaOrgao> = {
  AL: 'JFAL',
  CE: 'JFCE',
  PB: 'JFPB',
  PE: 'JFPE',
  RN: 'JFRN',
  SE: 'JFSE'
};

/** Normaliza para comparação: sem acento, minúsculo, espaços colapsados. */
function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lê a lotação do usuário do masthead do PJe. Devolve o primeiro segmento
 * (o nome da unidade, ex.: "35ª Vara Federal CE") ou `null`.
 *
 * Varre o documento atual e os iframes same-origin (o masthead fica no frame
 * de topo do PJe, então em regra é encontrado direto).
 */
export function lerLotacaoUsuario(): string | null {
  for (const doc of coletarDocumentosAcessiveis()) {
    // Prioriza o atributo (texto íntegro mesmo quando o <small> está truncado
    // por CSS), depois o conteúdo textual.
    const candidatos: string[] = [];
    for (const el of Array.from(
      doc.querySelectorAll<HTMLElement>('[data-original-title], [title], .bloco-va-mid small')
    )) {
      candidatos.push(
        el.getAttribute('data-original-title') ?? el.getAttribute('title') ?? el.textContent ?? ''
      );
    }
    for (const texto of candidatos) {
      const primeiro = texto.split('/')[0]?.trim() ?? '';
      // O primeiro segmento de uma lotação de vara/juizado/turma federal.
      if (
        /\b(vara|juizado|turma)\b/i.test(primeiro) &&
        /\b(federal|recursal)\b/i.test(primeiro) &&
        primeiro.length <= 80
      ) {
        return primeiro;
      }
    }
  }
  return null;
}

/** Seccional derivada da UF ao fim da lotação (ex.: "... CE" → JFCE). */
export function orgaoDaLotacao(lotacao: string): JuliaOrgao | null {
  const m = /\b([A-Za-z]{2})\s*$/.exec(lotacao.trim());
  const uf = m?.[1]?.toUpperCase();
  return uf ? (UF_PARA_ORGAO[uf] ?? null) : null;
}

/**
 * Chave de casamento de uma unidade: número ordinal + tipo. Precisa para não
 * confundir "1ª" com "10ª" (prefixo casaria) nem "Vara" com "Juizado".
 */
function chaveUnidade(nome: string): string | null {
  const n = /(\d+)\s*[ºªoa]?/.exec(nome);
  if (!n) return null;
  const norm = normalizar(nome);
  const tipo = /juizado|jef/.test(norm)
    ? 'jef'
    : /turma recursal|recursal/.test(norm)
      ? 'tr'
      : /vara/.test(norm)
        ? 'vara'
        : null;
  return tipo ? `${n[1]}|${tipo}` : null;
}

/**
 * Casa a lotação lida contra a lista de órgãos julgadores carregada da Júlia.
 * Só devolve quando há **exatamente um** correspondente — casamento ambíguo
 * não pré-marca nada, para nunca escolher a unidade errada em silêncio.
 */
export function casarUnidade(lotacao: string, disponiveis: string[]): string | null {
  const alvo = chaveUnidade(lotacao);
  if (!alvo) return null;
  const hits = disponiveis.filter((u) => chaveUnidade(u) === alvo);
  return hits.length === 1 ? hits[0]! : null;
}
