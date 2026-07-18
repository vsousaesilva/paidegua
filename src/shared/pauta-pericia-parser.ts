/**
 * Normalização da tabela de perícia (`#processoPericiaNovaPericiaList`, 5
 * colunas). Funções puras, sem DOM — a raspagem devolve `RawPericiaRow[]` e
 * aqui mapeamos por índice de coluna e derivamos os eixos do dashboard.
 *
 * Colunas: 0 Data · 1 Periciado · 2 Valor · 3 Perito (nome - CPF) · 4 Situação.
 */

import type { PericiaItem, RawPericiaRow } from './pauta-pericia-types';

function limpar(s: string | undefined | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function ouNull(s: string | undefined | null): string | null {
  const v = limpar(s);
  return v ? v : null;
}

/** CPF no formato "503.369.083-34" (separa nome × CPF do perito). */
const CPF_RE = /\d{3}\.\d{3}\.\d{3}-\d{2}/;

/** Separa "NOME - 503.369.083-34" em nome e CPF. Sem CPF, tudo vira nome. */
export function separarPerito(texto: string | null | undefined): {
  nome: string | null;
  cpf: string | null;
} {
  const t = limpar(texto);
  if (!t) return { nome: null, cpf: null };
  const m = t.match(CPF_RE);
  if (!m) return { nome: t, cpf: null };
  const cpf = m[0];
  const nome = limpar(t.slice(0, m.index).replace(/[-–\s]+$/, ''));
  return { nome: nome || null, cpf };
}

/** "R$ 1.234,56" → 1234.56 (null quando vazio/não parseável). */
export function parseValorReais(texto: string | null | undefined): number | null {
  const t = limpar(texto);
  if (!t) return null;
  const limpo = t
    .replace(/r\$/i, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .trim();
  if (!limpo) return null;
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

/**
 * Grafias canônicas das situações conhecidas. Canoniza a caixa/variação para
 * a etiqueta de status (fase futura) e para o agrupamento do dashboard ficar
 * estável. Situações desconhecidas passam adiante com `limpar`.
 */
const SITUACOES_CANONICAS = [
  'Designada',
  'Redesignada',
  'Realizada',
  'Não realizada',
  'Cancelada',
  'Aguardando laudo',
  'Laudo entregue',
  'Laudo juntado',
  'Enviado para pagamento',
  'Pago',
  'Devolvida'
];
const SITUACAO_CANONICA_POR_LOWER = new Map(
  SITUACOES_CANONICAS.map((s) => [s.toLowerCase(), s])
);

export function canonicalizarSituacao(raw: string | null | undefined): string {
  const v = limpar(raw);
  if (!v) return '';
  return SITUACAO_CANONICA_POR_LOWER.get(v.toLowerCase()) ?? v;
}

/** Mapeia uma linha crua (células por índice) para `PericiaItem`. */
export function normalizarPericia(raw: RawPericiaRow): PericiaItem {
  const c = raw.celulas ?? [];
  const { nome, cpf } = separarPerito(c[3]);
  const valorTexto = ouNull(c[2]);
  return {
    dataHora: ouNull(c[0]),
    periciado: ouNull(c[1]),
    valor: parseValorReais(valorTexto),
    valorTexto,
    peritoNome: nome,
    peritoCpf: cpf,
    situacao: canonicalizarSituacao(c[4])
  };
}

/** Converte "dd/mm/aaaa[ hh:mm[:ss]]" em epoch ms (null se não parsear). */
export function parseDataHoraPericia(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = v
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
  const t = Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`);
  return Number.isNaN(t) ? null : t;
}

/** true quando a situação da perícia está na lista a ignorar (case-insensitive). */
export function situacaoIgnorada(
  situacao: string,
  ignorar: string[] | undefined
): boolean {
  if (!ignorar || ignorar.length === 0) return false;
  const s = limpar(situacao).toLowerCase();
  return ignorar.some((i) => limpar(i).toLowerCase() === s);
}
