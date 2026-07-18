/**
 * Normalização e helpers derivados das ordens PREVJUD (tabela "Intimações
 * INSS" do menu do processo no PJe v11). Funções puras, sem dependência de
 * DOM — a raspagem em si acontece em main world no background
 * (`coletarOrdensPrevjudNoFrame`) e devolve `RawPrevjudRow[]`; aqui só
 * mapeamos por índice de coluna e calculamos os eixos do dashboard.
 *
 * Dicionário de colunas em `docs/extracao-ordens-prevjud-pje.md`.
 */

import type { OrdemPrevjud, RawPrevjudRow } from './types';

function limpar(s: string | undefined | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function ouNull(s: string | undefined | null): string | null {
  const v = limpar(s);
  return v ? v : null;
}

function paraNumero(s: string | undefined | null): number {
  const n = Number(limpar(s));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Grafias canônicas dos status conhecidos. Como o vínculo de etiqueta no PJe
 * é por NOME e nomes duplicados (mesmo texto em caixa diferente) causam
 * HTTP 500 no `/inserir`, canonizamos o status na normalização — assim a
 * etiqueta "Prevjud - [status]" tem sempre a MESMA grafia, sem variantes.
 */
const STATUS_CANONICOS = [
  'Recebida pelo INSS',
  'Recebida com erro',
  'Ordem cumprida',
  'Respondida com justificativa',
  'Em elaboração',
  'Falha no envio ao PrevJud',
  'Erro no PrevJud (tentativas excedidas)',
  'Ordem PrevJud cadastrada'
];
const STATUS_CANONICO_POR_LOWER = new Map(
  STATUS_CANONICOS.map((s) => [s.toLowerCase(), s])
);

/** Devolve a grafia canônica do status (mapeia variantes de caixa); mantém desconhecidos. */
export function canonicalizarStatusPrevjud(raw: string | null | undefined): string {
  const v = limpar(raw);
  if (!v) return '';
  return STATUS_CANONICO_POR_LOWER.get(v.toLowerCase()) ?? v;
}

/**
 * Lista canônica dos status PREVJUD conhecidos — alimenta o seletor
 * "situações a ignorar" da aba-painel (o usuário escolhe quais status não
 * devem entrar no relatório).
 */
export const STATUS_PREVJUD_LISTA: readonly string[] = STATUS_CANONICOS;

/** true quando o status da ordem está na lista a ignorar (comparação canônica). */
export function statusOrdemIgnorado(
  status: string,
  ignorar: string[] | undefined
): boolean {
  if (!ignorar || ignorar.length === 0) return false;
  const s = canonicalizarStatusPrevjud(status).toLowerCase();
  return ignorar.some((i) => canonicalizarStatusPrevjud(i).toLowerCase() === s);
}

/** Mapeia uma linha crua (células por índice 0–9) para `OrdemPrevjud`. */
export function normalizarOrdemPrevjud(raw: RawPrevjudRow): OrdemPrevjud {
  const c = raw.celulas ?? [];
  const g = (i: number): string | null => ouNull(c[i]);
  return {
    ordem: paraNumero(c[0]),
    status: canonicalizarStatusPrevjud(c[1]),
    servico: limpar(c[2]),
    idDocumento: g(3),
    urlDocumento: raw.urlDocumento ?? null,
    protocolo: g(4),
    dataEnvio: g(5),
    idNotificacaoEnvio: g(6),
    idNotificacaoCumprimento: g(7),
    inicioPrazo: g(8),
    finalPrazo: g(9)
  };
}

/**
 * Uma ordem está pendente enquanto não há sinal de cumprimento. Na tela
 * legacy o sinal é a coluna "ID Notificação de Cumprimento"; na API PREVJUD
 * é o status (`ORDEM_CUMPRIDA` → rotulado "Ordem cumprida"). "Respondida
 * com justificativa" segue pendente de propósito — exige análise da vara.
 */
export function ordemPendente(o: OrdemPrevjud): boolean {
  if (o.idNotificacaoCumprimento) return false;
  if (/cumprid/i.test(o.status)) return false;
  return true;
}

// =====================================================================
// Rota A — normalização da API PREVJUD (gateway PDPJ)
// =====================================================================

/**
 * Shape defensivo (campos opcionais/unknown) de uma intimação devolvida
 * por `GET /api/v2/intimacao-judicial/obter-intimacao-numero-processo/…`.
 * Só os campos que consumimos; o resto é ignorado.
 */
export interface IntimacaoApiRaw {
  id?: unknown;
  numeroProcesso?: unknown;
  protocoloPdpj?: unknown;
  numeroProtocoloPdpj?: unknown;
  status?: unknown;
  servico?: unknown;
  creation?: unknown;
  dataCriacao?: unknown;
  dtRecebidoDataprev?: unknown;
  protocoloDataprev?: unknown;
  processo?: unknown;
}

/** Rótulos amigáveis para os enums de status da API (espelham a tela legacy). */
const STATUS_API_LABELS: Record<string, string> = {
  RECEBIDA: 'Recebida pelo INSS',
  RECEBIDA_COM_ERRO: 'Recebida com erro',
  ORDEM_CUMPRIDA: 'Ordem cumprida',
  RESPONDIDA_COM_JUSTIFICATIVA: 'Respondida com justificativa'
};

function rotularStatusApi(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return '';
  const s = v.trim();
  if (STATUS_API_LABELS[s]) return STATUS_API_LABELS[s];
  // Enum desconhecido: "AGUARDANDO_PROCESSAMENTO" → "Aguardando processamento".
  if (/^[A-Z0-9_]+$/.test(s)) {
    const texto = s.replace(/_/g, ' ').toLowerCase();
    return texto.charAt(0).toUpperCase() + texto.slice(1);
  }
  return s;
}

function textoOuNull(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** ISO 8601 → "dd/mm/aaaa hh:mm:ss" (formato da tela legacy, que o resto do módulo já parseia). */
function formatarDataApi(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return v.trim();
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Mapeia uma intimação da API PREVJUD para `OrdemPrevjud` (o formato da
 * tela legacy, que o dashboard consome). Diferenças em relação à raspagem:
 * a API não devolve `idDocumento`/URL do documento local do PJe nem os
 * prazos por linha (ficam null); o cumprimento é detectado pelo status.
 */
export function normalizarOrdemApi(
  raw: IntimacaoApiRaw,
  idx: number
): OrdemPrevjud {
  const processo =
    raw.processo && typeof raw.processo === 'object'
      ? (raw.processo as { ordem?: unknown })
      : null;
  const ordemNum = Number(processo?.ordem);
  const status = canonicalizarStatusPrevjud(rotularStatusApi(raw.status));
  return {
    ordem: Number.isFinite(ordemNum) && ordemNum > 0 ? ordemNum : idx + 1,
    status,
    servico: textoOuNull(raw.servico) ?? '',
    idDocumento: null,
    urlDocumento: null,
    protocolo:
      textoOuNull(raw.protocoloPdpj) ?? textoOuNull(raw.numeroProtocoloPdpj),
    dataEnvio: formatarDataApi(raw.creation) ?? formatarDataApi(raw.dataCriacao),
    idNotificacaoEnvio: textoOuNull(raw.protocoloDataprev),
    idNotificacaoCumprimento: null,
    inicioPrazo: formatarDataApi(raw.dtRecebidoDataprev),
    finalPrazo: null
  };
}

/**
 * Converte "dd/mm/aaaa[ hh:mm[:ss]]" em epoch ms. Retorna null quando não
 * parseia (mantém a ordem fora dos cálculos de prazo/envelhecimento).
 */
export function parseDataPrevjud(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = v
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
  const t = Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`);
  return Number.isNaN(t) ? null : t;
}

/** Dias corridos entre a Data de Envio e agora (null se não houver data). */
export function envelhecimentoDias(
  o: OrdemPrevjud,
  agora: number = Date.now()
): number | null {
  const t = parseDataPrevjud(o.dataEnvio);
  if (t == null) return null;
  return Math.floor((agora - t) / 86_400_000);
}

export type SituacaoPrazoPrevjud =
  | 'sem-prazo'
  | 'a-vencer'
  | 'vence-hoje'
  | 'vencido';

/** Classifica a ordem pelo "Final do Prazo" em relação a hoje. */
export function situacaoPrazo(
  o: OrdemPrevjud,
  agora: number = Date.now()
): SituacaoPrazoPrevjud {
  const t = parseDataPrevjud(o.finalPrazo);
  if (t == null) return 'sem-prazo';
  const hoje = new Date(agora);
  hoje.setHours(0, 0, 0, 0);
  const prazo = new Date(t);
  prazo.setHours(0, 0, 0, 0);
  if (prazo.getTime() < hoje.getTime()) return 'vencido';
  if (prazo.getTime() === hoje.getTime()) return 'vence-hoje';
  return 'a-vencer';
}
