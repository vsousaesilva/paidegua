/**
 * Helpers compartilhados da feature "Audiência pAIdegua" (perfil Secretaria).
 *
 * Concentra:
 *   - Regex de tarefa-alvo ("designar audiência").
 *   - Geração da etiqueta-pauta no formato "Audiência de Instrução DD.MM.AA".
 *   - Parser do advogado a partir da string `poloAtivo` achatada do
 *     `PJeApiProcesso` — heurística baseada em "OAB" como documento.
 */

// Tarefa-alvo no PJe: "Audiência - Designar" (formato real observado na
// JFCE). Tolerante a acento ausente, espaço variável e hífen Unicode
// (- – —). Mantida ampla por simetria com REGEX_PERICIA_DESIGNAR.
const REGEX_TAREFA_DESIGNAR_AUDIENCIA = /audi[eê]ncia\s*[-–—]\s*designar/i;

export function isTarefaDesignarAudiencia(nome: string): boolean {
  return Boolean(nome) && REGEX_TAREFA_DESIGNAR_AUDIENCIA.test(nome);
}

/**
 * Monta a etiqueta-pauta de audiência. Formato:
 *   "Audiência de Instrução DD.MM.AA"
 *
 * `quando` é a data da audiência escolhida pelo usuário no painel.
 */
export function montarEtiquetaPautaAudiencia(quando: Date): string {
  const dd = String(quando.getDate()).padStart(2, '0');
  const mm = String(quando.getMonth() + 1).padStart(2, '0');
  const aa = String(quando.getFullYear()).slice(-2);
  return `Audiência de Instrução ${dd}.${mm}.${aa}`;
}

/**
 * Tenta extrair o nome e a OAB do advogado a partir da string `poloAtivo`
 * achatada do `PJeApiProcesso`.
 *
 * O `poloAtivo` é normalizado por `extrairTexto` em
 * `pje-api-from-content.ts`: quando o servidor devolve um array com partes
 * e advogados, vira algo como `"FULANO DE TAL; ICRANO MARQUES (OAB CE 12345)"`.
 * O separador `;` é usado pela normalização para itens múltiplos.
 *
 * Heurística:
 *   1. Quebra a string por `;` e procura o primeiro item que contenha
 *      a palavra "OAB" (case-insensitive).
 *   2. Extrai o documento (UF + número) com regex permissiva.
 *   3. O nome é o trecho antes do parêntese ou hífen que precede a OAB.
 *
 * Quando nenhuma OAB é encontrada, devolve `{ nome: null, oab: null }` —
 * o coletor sinaliza esses processos como "sem advogado identificável".
 */
export function extrairAdvogadoDoPoloAtivo(
  poloAtivo: string | null
): { nome: string | null; oab: string | null } {
  if (!poloAtivo) return { nome: null, oab: null };

  // Tenta primeiro o split por `;` (formato típico do array achatado).
  const itens = poloAtivo.split(';').map((s) => s.trim()).filter(Boolean);
  // Se não houver `;`, processa a string inteira como item único — alguns
  // tribunais entregam o polo ativo já em uma única string.
  if (itens.length === 0) itens.push(poloAtivo.trim());

  for (const item of itens) {
    const r = parseItemComOab(item);
    if (r.nome && r.oab) return r;
  }
  // Segundo passe: aceita item com OAB mesmo sem nome bem isolado.
  for (const item of itens) {
    const r = parseItemComOab(item);
    if (r.oab) return r;
  }
  return { nome: null, oab: null };
}

/**
 * Quebra um item em (nome, oab). Aceita formatos:
 *   - "ICRANO MARQUES (OAB CE 12345)"
 *   - "ICRANO MARQUES - OAB/CE 12345"
 *   - "ICRANO MARQUES OAB CE 12345"
 */
function parseItemComOab(
  item: string
): { nome: string | null; oab: string | null } {
  const normalizado = item.replace(/\s+/g, ' ').trim();
  if (!/oab/i.test(normalizado)) return { nome: null, oab: null };

  // Extrai a OAB: aceita "OAB CE 12345", "OAB/CE 12345", "OAB-CE-12345".
  const matchOab = normalizado.match(
    /OAB[\s./\-_]*([A-Z]{2})[\s./\-_]*(\d{2,7})/i
  );
  const oab = matchOab
    ? `OAB ${matchOab[1].toUpperCase()} ${matchOab[2]}`
    : null;

  // Nome: o trecho ANTES da palavra "OAB", limpando parênteses/hífens
  // residuais e cortando títulos jurídicos comuns (Dr./Dra./Adv.).
  const idxOab = normalizado.toUpperCase().indexOf('OAB');
  let trecho = idxOab > 0 ? normalizado.slice(0, idxOab) : '';
  trecho = trecho
    .replace(/[(){}\[\]]/g, ' ')
    .replace(/\s*[-–—]\s*$/g, '')
    .replace(/^\s*(Dr|Dra|Adv|Advogad[ao])\.?\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const nome = trecho ? trecho : null;
  return { nome, oab };
}

/**
 * Normaliza o nome do advogado para servir como chave de agrupamento
 * (uppercase, sem acentos, espaços simples).
 */
export function chaveAgrupamentoAdvogado(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}
