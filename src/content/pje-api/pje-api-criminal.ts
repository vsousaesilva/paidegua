/**
 * Coleta criminal — fetch direto + DOMParser (sem `chrome.tabs.create`).
 *
 * Padrão arquitetural espelhado de `prazos-fita-coordinator.ts`:
 *
 *   - **Listagem**: REST do painel
 *     (`recuperarProcessosTarefaPendenteComCriterios`).
 *   - **Detalhamento por processo**: `gerarChaveAcesso` (REST barato) +
 *     `fetch(listAutosDigitais.seam?id=X&ca=Y)` no mesmo content script
 *     (same-origin do PJe → cookies de sessão acompanham). O HTML é
 *     parseado com `DOMParser` e os mesmos extractors aceitam o
 *     `Document` resultante. Sem boot Angular, sem aba inativa.
 *   - **IA dos PDFs principais**: `extractContents` (já existe) +
 *     mensagem `CRIMINAL_AI_EXTRAIR_PDF` para o background.
 *
 * Por que essa decisão: o caminho "abre uma aba por processo" foi
 * descartado em prazos-na-fita por custar 1–3 s só de overhead do Chrome
 * antes de qualquer dado ser extraído. Para 1 000 processos isso são
 * ~30–50 minutos de overhead puro. Fetch + DOMParser executam em
 * ~50–200 ms por processo. Detalhes em
 * `docs/arquitetura-coleta-prazos-na-fita.md` §3.
 *
 * Limitações conhecidas (vs. abertura de aba):
 *   - Não conseguimos "ativar" documentos que o PJe legacy serve com
 *     0 bytes até serem clicados (extracao-conteudo-pje.md §2.2). Esses
 *     casos (~2-3 docs por processo, geralmente certidões pequenas)
 *     ficam sem texto. Os PDFs principais (denúncia, sentença) tendem
 *     a vir corretos via fetch direto + MAIN world fallback (~95%).
 *   - Caso o usuário relate "denúncia/sentença não foi processada",
 *     reavaliamos com fallback para tab única.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import {
  filtrarDocumentosPrincipais,
  type DocumentoPrincipalIdentificado
} from '../../shared/criminal-pdf-filter';
import {
  mesclarDadosPdf,
  type DadosPdfExtraidos
} from '../../shared/criminal-ai-prompts';
import type { ProcessoDocumento } from '../../shared/types';
import {
  diagnosticarExtractor,
  extrairDetalhesProcesso,
  extrairDocumentosFromDoc,
  extrairMovimentosDoDOM,
  extrairPartesDoDOM
} from '../criminal/criminal-extractor';
import { extractContents } from '../extractor';
import {
  gerarChaveAcesso,
  listarProcessosDaTarefa
} from './pje-api-from-content';

// ── Tipos públicos (forma normalizada — estável para o fetcher) ──

export interface PJeProcessoListado {
  idProcesso: number;
  numeroProcesso: string;
  classeCnj: number | null;
  /** Sigla do PJe (ex.: "PJEC", "APN", "INQ"). */
  classeSigla: string | null;
  classeNome: string | null;
  orgaoJulgador: string | null;
  dataChegada: string | null;
  nomeTarefa: string | null;
  poloAtivo: string | null;
  poloPassivo: string | null;
  descricaoUltimoMovimento: string | null;
  /**
   * ID da TaskInstance corrente — usado para montar URL
   * `movimentar.seam?newTaskId=X` que abre direto na tarefa.
   */
  idTaskInstance: number | null;
}

export interface PJeParte {
  tipoPolo: 'ativo' | 'passivo' | 'outros';
  papel: string | null;
  nome: string;
  documento: string | null;
  dataNascimento: string | null;
  oab: string | null;
}

export interface PJeDetalhesProcesso {
  classeCnj: number | null;
  classeNome: string | null;
  assunto: string | null;
  assuntoCodigo: number | null;
  dataAutuacao: string | null;
  dataUltimaDistribuicao: string | null;
  orgaoJulgador: string | null;
  competencia: string | null;
  jurisdicao: string | null;
  segredoJustica: boolean | null;
  justicaGratuita: boolean | null;
  tutelaLiminar: boolean | null;
  prioridade: string | null;
}

export interface PJeMovimento {
  codigo: number;
  nome: string;
  data: string;
  complemento: string | null;
}

// ── Listagem via painel REST ─────────────────────────────────────

export interface OpcoesListagem {
  nomeTarefa: string;
  /** Sigla a filtrar no body. Quando ausente, traz tudo da tarefa. */
  sigla?: string;
  maxProcessos?: number;
}

export async function listarProcessosDaTarefaCriminal(
  opts: OpcoesListagem
): Promise<{ ok: true; processos: PJeProcessoListado[]; total: number } | { ok: false; error: string }> {
  const r = await listarProcessosDaTarefa({
    nomeTarefa: opts.nomeTarefa,
    classe: opts.sigla,
    maxProcessos: opts.maxProcessos ?? 5000
  });
  if (!r.ok) {
    return { ok: false, error: r.error ?? 'Falha listando processos da tarefa.' };
  }
  const processos: PJeProcessoListado[] = r.processos.map((p) => ({
    idProcesso: p.idProcesso,
    numeroProcesso: p.numeroProcesso ?? '',
    classeCnj: null,
    classeSigla: p.classeJudicial ?? null,
    classeNome: p.classeJudicial ?? null,
    orgaoJulgador: p.orgaoJulgador,
    dataChegada: p.dataChegadaTarefa,
    nomeTarefa: opts.nomeTarefa,
    poloAtivo: p.poloAtivo,
    poloPassivo: p.poloPassivo,
    descricaoUltimoMovimento: p.descricaoUltimoMovimento,
    idTaskInstance: p.idTaskInstance
  }));
  return { ok: true, processos, total: r.total };
}

// ── Coleta detalhada (fetch + DOMParser, sem aba) ────────────────

const AUTOS_DIGITAIS_PATH =
  '/pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam';

const FETCH_TIMEOUT_MS = 30_000;
const NUMERO_PROCESSO_REGEX = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;

function montarUrlAutosDigitais(idProcesso: number, ca: string): string {
  const origem = window.location.origin;
  return `${origem}${AUTOS_DIGITAIS_PATH}?idProcesso=${idProcesso}&ca=${encodeURIComponent(ca)}`;
}

async function fetchTextoComTimeout(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; text: string }> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(
    () => ctrl.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs
  );
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal: ctrl.signal
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Coleta detalhada de UM processo via fetch direto da página de autos
 * digitais. Roda no content script same-origin com PJe — cookies
 * acompanham automaticamente.
 *
 * Etapas:
 *   1. `gerarChaveAcesso` (caller pode passar `caCached` para pular)
 *   2. `fetch` da URL de autos com timeout
 *   3. `DOMParser` parseia o HTML em `Document`
 *   4. Extractors puros (`extrairPartesDoDOM`, etc.) operam sobre o doc
 *   5. (opcional) IA dos PDFs principais
 */
export async function coletarProcessoCriminal(
  idProcesso: number,
  opts: { runIA?: boolean; caCached?: string; timeoutMs?: number } = {}
): Promise<
  | {
      ok: true;
      partes: PJeParte[];
      movimentos: PJeMovimento[];
      detalhes: PJeDetalhesProcesso | null;
      documentos: ProcessoDocumento[];
      documentosPrincipais: DocumentoPrincipalIdentificado[];
      dadosIA: DadosPdfExtraidos | null;
      dadosIAFontes: DadosPdfExtraidos[];
      numeroProcesso: string | null;
      diagnostic?: unknown;
    }
  | { ok: false; error: string; diagnostic?: unknown }
> {
  if (!Number.isFinite(idProcesso) || idProcesso <= 0) {
    return { ok: false, error: 'idProcesso inválido.' };
  }

  // 1. ca: usa cache da pré-aquecida ou gera fresca
  let ca = opts.caCached;
  if (!ca) {
    const caResp = await gerarChaveAcesso(idProcesso);
    if (!caResp.ok || !caResp.ca) {
      return {
        ok: false,
        error: `Falha gerando chaveAcesso de ${idProcesso}: ${caResp.error ?? 'sem detalhes'}`
      };
    }
    ca = caResp.ca;
  }

  // 2. Fetch direto same-origin (cookies acompanham)
  const url = montarUrlAutosDigitais(idProcesso, ca);
  let html: string;
  try {
    const resp = await fetchTextoComTimeout(url, opts.timeoutMs ?? FETCH_TIMEOUT_MS);
    if (!resp.ok) {
      return {
        ok: false,
        error: `HTTP ${resp.status} ao buscar autos digitais.`
      };
    }
    if (!resp.text || resp.text.length < 1000) {
      return {
        ok: false,
        error: `Resposta vazia ou stub (${resp.text?.length ?? 0} chars) — ca pode ter expirado.`
      };
    }
    html = resp.text;
  } catch (err) {
    return {
      ok: false,
      error: `fetch falhou: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // 3. Parse HTML
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 4. Extractors operam sobre o `doc`
  const partes = extrairPartesDoDOM(doc);
  const movimentos = extrairMovimentosDoDOM(doc);
  const detalhes = extrairDetalhesProcesso(doc);
  const documentos = extrairDocumentosFromDoc(doc);
  const documentosPrincipais = filtrarDocumentosPrincipais(documentos);

  // Número CNJ no header da página
  let numeroProcesso: string | null = null;
  const headerText = doc.body?.textContent ?? '';
  const m = headerText.match(NUMERO_PROCESSO_REGEX);
  if (m) numeroProcesso = m[0];

  // 5. IA dos PDFs principais (opcional)
  let dadosIA: DadosPdfExtraidos | null = null;
  const dadosIAFontes: DadosPdfExtraidos[] = [];
  if (opts.runIA !== false && documentosPrincipais.length > 0) {
    try {
      const docsParaExtrair = documentosPrincipais.map((p) => p.documento);
      // No fluxo via fetch, NÃO ativamos no DOM (live document é o painel,
      // não os autos). extractContents só usa fetch direto + MAIN world.
      // ~95% dos PDFs principais (denúncia, sentença) vêm corretos.
      const extraidos = await extractContents(
        docsParaExtrair,
        () => { /* sem progresso por enquanto */ }
      );
      const MIN_CHARS_PARA_IA = 500;
      for (let i = 0; i < extraidos.length; i++) {
        const docExtraido = extraidos[i]!;
        const tipoPrincipal = documentosPrincipais[i]?.tipoPrincipal;
        const texto = (docExtraido.textoExtraido ?? '').trim();
        if (!texto || texto.length < MIN_CHARS_PARA_IA) {
          console.debug(
            `${LOG_PREFIX} criminal: doc ${docExtraido.id} pulado ` +
              `(${texto.length} chars, stub provável)`
          );
          continue;
        }
        try {
          const respIA = (await chrome.runtime.sendMessage({
            channel: MESSAGE_CHANNELS.CRIMINAL_AI_EXTRAIR_PDF,
            payload: { texto, tipoDocumento: tipoPrincipal ?? null }
          })) as { ok: boolean; dadosIA?: DadosPdfExtraidos; error?: string };
          if (respIA?.ok && respIA.dadosIA) {
            dadosIAFontes.push(respIA.dadosIA);
          }
        } catch (err) {
          console.warn(
            `${LOG_PREFIX} criminal: IA falhou em ${docExtraido.id}:`,
            err
          );
        }
      }
      if (dadosIAFontes.length > 0) {
        dadosIA = mesclarDadosPdf(dadosIAFontes);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} criminal: pipeline IA falhou:`, err);
    }
  }

  return {
    ok: true,
    partes,
    movimentos,
    detalhes,
    documentos,
    documentosPrincipais,
    dadosIA,
    dadosIAFontes,
    numeroProcesso,
    diagnostic: diagnosticarExtractor(doc)
  };
}
