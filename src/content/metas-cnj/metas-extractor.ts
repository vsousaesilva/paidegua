/**
 * Extrator de dados do processo para o módulo "Controle Metas CNJ".
 *
 * Dado o `idProcesso` + `ca`, faz fetch SSR da página dos autos digitais
 * (`listAutosDigitais.seam`) e devolve os campos que o detector de
 * status e o aplicador de regras precisam:
 *
 *   - `data_distribuicao` (e `data_autuacao`)  — chave para Meta 2 e
 *     filtros de data de corte das demais metas
 *   - `movimentos` — para o detector classificar status via códigos TPU
 *   - `documentos` — para o detector inferir julgamento via tipo
 *     "Sentença"/"Acórdão" em processos migrados
 *   - `orgao_julgador`, `cargo_judicial` — auditoria
 *
 * REUSO: importa `extrairDetalhesProcesso`, `extrairMovimentosDoDOM` e
 * `extrairDocumentosFromDoc` do `criminal-extractor.ts` — mesma lógica
 * estável usada pelo Sigcrim. Se essas funções mudarem (refactor do
 * sigcrim), o build acusa e ajustamos aqui.
 *
 * O fetch SSR + parse via DOMParser é o mesmo padrão do Prazos na Fita
 * (ver `prazos-fita-coordinator.ts`): rápido (~200ms por processo),
 * paralelizável (HTTP/2 multiplex), sem custo de criar aba/iframe.
 */

import { LOG_PREFIX } from '../../shared/constants';
import {
  extrairDetalhesProcesso,
  extrairMovimentosDoDOM,
  extrairDocumentosFromDoc
} from '../criminal/criminal-extractor';
import type {
  DocumentoProcessual,
  MovimentoProcessual
} from '../../shared/processo-status-detector';

// =====================================================================
// Tipos
// =====================================================================

export interface DadosMetasDoProcesso {
  /** Sucesso da extração — se `false`, `error` traz a causa. */
  ok: boolean;
  /** URL completa que foi varrida (auditoria). */
  url: string;
  /** Mensagem de erro quando `ok=false`. */
  error?: string;
  /** Duração da coleta em ms (debug/telemetria). */
  duracaoMs: number;

  // Campos extraídos (presentes apenas quando `ok=true`)
  /** Data de autuação (ISO YYYY-MM-DD). null se não localizada. */
  data_autuacao?: string | null;
  /** Data da última distribuição (ISO YYYY-MM-DD). null se não localizada. */
  data_distribuicao?: string | null;
  /** Órgão julgador (texto cru do PJe). */
  orgao_julgador?: string | null;
  /** Movimentos do histórico, prontos pro detector (sem `categorias`). */
  movimentos?: MovimentoProcessual[];
  /** Documentos juntados, prontos pro detector. */
  documentos?: DocumentoProcessual[];
}

export interface ColetarDadosOpts {
  idProcesso: number;
  ca: string;
  idTaskInstance?: number | null;
  /** Origin completo do PJe legacy (ex.: `https://pje1g.trf5.jus.br`). */
  legacyOrigin: string;
  /** Timeout do fetch em ms. Default 45s. */
  timeoutMs?: number;
}

// =====================================================================
// Fetch + parse
// =====================================================================

const DEFAULT_TIMEOUT_MS = 45_000;

function montarUrl(opts: ColetarDadosOpts): string {
  const params = new URLSearchParams();
  params.set('idProcesso', String(opts.idProcesso));
  params.set('ca', opts.ca);
  if (opts.idTaskInstance != null) {
    params.set('idTaskInstance', String(opts.idTaskInstance));
  }
  return (
    `${opts.legacyOrigin}/pje/Processo/ConsultaProcesso/Detalhe/` +
    `listAutosDigitais.seam?${params.toString()}`
  );
}

async function fetchComTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} em ${resp.url}`);
    }
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================================
// Adapters dos tipos do criminal-extractor para o detector
// =====================================================================

function adaptarMovimentos(
  movs: ReturnType<typeof extrairMovimentosDoDOM>
): MovimentoProcessual[] {
  return movs.map((m) => ({
    codigoCnj: m.codigo > 0 ? m.codigo : null,
    descricao: m.nome,
    data: m.data
  }));
}

function adaptarDocumentos(
  docs: ReturnType<typeof extrairDocumentosFromDoc>
): DocumentoProcessual[] {
  return docs.map((d) => ({
    tipo: d.tipo ?? '',
    descricao: d.descricao ?? '',
    dataJuntada: d.dataMovimentacao ?? ''
  }));
}

// =====================================================================
// Função pública
// =====================================================================

/**
 * Coleta os dados do processo necessários para classificá-lo nas Metas
 * CNJ. Roda no content script (mesmo origin do PJe). Não acessa banco
 * — só faz fetch + parse.
 *
 * Devolve `{ ok: true, ... }` mesmo quando a capa não traz
 * `data_distribuicao` (campo opcional null). Só retorna `{ ok: false,
 * error }` em caso de falha de rede / HTTP / parse total.
 */
export async function coletarDadosMetasDoProcesso(
  opts: ColetarDadosOpts
): Promise<DadosMetasDoProcesso> {
  const inicio = Date.now();
  const url = montarUrl(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let html: string;
  try {
    html = await fetchComTimeout(url, timeoutMs);
  } catch (err) {
    return {
      ok: false,
      url,
      error: err instanceof Error ? err.message : String(err),
      duracaoMs: Date.now() - inicio
    };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (err) {
    return {
      ok: false,
      url,
      error: `Falha ao parsear HTML dos autos: ${err instanceof Error ? err.message : String(err)}`,
      duracaoMs: Date.now() - inicio
    };
  }

  // Sentinela: HTML stub (ca expirada, sessão derrubada) costuma vir com
  // <body> minúsculo sem indicadores de processo. O `extrairDetalhesProcesso`
  // já devolve null nesses casos (sem "Classe judicial" no texto).
  let detalhes: ReturnType<typeof extrairDetalhesProcesso> | null = null;
  try {
    detalhes = extrairDetalhesProcesso(doc);
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} metas-extractor: extrairDetalhesProcesso falhou:`,
      err
    );
  }

  let movimentos: MovimentoProcessual[] = [];
  try {
    movimentos = adaptarMovimentos(extrairMovimentosDoDOM(doc));
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} metas-extractor: extrairMovimentosDoDOM falhou:`,
      err
    );
  }

  let documentos: DocumentoProcessual[] = [];
  try {
    documentos = adaptarDocumentos(extrairDocumentosFromDoc(doc));
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} metas-extractor: extrairDocumentosFromDoc falhou:`,
      err
    );
  }

  return {
    ok: true,
    url,
    duracaoMs: Date.now() - inicio,
    data_autuacao: detalhes?.dataAutuacao ?? null,
    data_distribuicao: detalhes?.dataUltimaDistribuicao ?? null,
    orgao_julgador: detalhes?.orgaoJulgador ?? null,
    movimentos,
    documentos
  };
}
