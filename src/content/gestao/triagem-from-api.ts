/**
 * Conversão `PJeApiProcesso` (resposta REST normalizada) → `TriagemProcesso`
 * (forma canônica consumida pelos dashboards) + orquestrador de coleta de
 * snapshots por tarefa via API REST.
 *
 * Por que existe: historicamente o Gestão coletava cartões via DOM
 * scraping do painel Angular. Isso trazia dois problemas reais:
 *   1. `idProcesso` escapado como `idTaskInstance`, quebrando a montagem
 *      de URL autenticada (`listAutosDigitais.seam?idProcesso=X&ca=Y`);
 *   2. campos ausentes (`sigiloso` sempre `false`, etiquetas com ruído).
 *
 * A REST `recuperarProcessosTarefaPendenteComCriterios` devolve tudo que
 * o DOM dava — e mais (assuntoPrincipal, descricaoUltimoMovimento,
 * ultimoMovimento ms, cargoJudicial). Com `gerarChaveAcessoProcesso`
 * resolvemos o `ca` necessário para abrir os autos no contexto da tarefa.
 *
 * Este módulo não faz DOM scraping. O `gestao-bridge.ts` decide se usa
 * este caminho (rápido e completo) ou cai no fallback DOM se o snapshot
 * de auth ainda não foi capturado pelo interceptor.
 */

import type {
  PJeApiProcesso,
  TriagemProcesso,
  TriagemTarefaSnapshot
} from '../../shared/types';
import {
  gerarChaveAcesso,
  listarProcessosDaTarefa
} from '../pje-api/pje-api-from-content';
import type { ScanHandle } from '../../shared/telemetry';

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Converte timestamp ms para o formato `dd-mm-aa` usado pelos dashboards
 * (legado do DOM scraping do PJe). Retorna `null` se o número não for
 * um timestamp válido.
 */
function msParaDdMmAa(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const aa = String(d.getFullYear() % 100).padStart(2, '0');
  return `${dd}-${mm}-${aa}`;
}

/**
 * Aceita string numérica (como a REST `dataChegadaTarefa` devolve — ms
 * serializado em texto) ou número já em ms. Retorna ms ou null.
 */
function toMsOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function diasDesdeMs(ms: number | null): number | null {
  if (ms == null) return null;
  const hoje = Date.now();
  if (ms > hoje) return 0;
  return Math.floor((hoje - ms) / (1000 * 60 * 60 * 24));
}

/**
 * Monta o texto de última movimentação combinando data + descrição —
 * mesmo formato aproximado que o DOM rendered usa ("dd/mm/aaaa – texto").
 */
function montarUltimaMovimentacaoTexto(p: PJeApiProcesso): string | null {
  const desc = p.descricaoUltimoMovimento?.trim();
  const ms = p.ultimoMovimento;
  if (!desc && (ms == null || !Number.isFinite(ms))) return null;
  if (!desc) return null;
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return desc;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return desc;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy} – ${desc}`;
}

/**
 * Converte um `PJeApiProcesso` (com URL autenticada já resolvida) em
 * `TriagemProcesso` canônico.
 *
 * Diferenças em relação ao caminho DOM:
 *   - `idProcesso` é o ID real do processo (não o `idTaskInstance`).
 *   - `sigiloso` vem do servidor (não mais `false` fixo).
 *   - `assunto` vem de `assuntoPrincipal` (matéria, não classe).
 *   - `dataUltimoMovimento` / `diasUltimoMovimento` são populados.
 *   - `ultimaMovimentacaoTexto` usa `descricaoUltimoMovimento` com data.
 */
export function triagemProcessoFromApi(
  p: PJeApiProcesso,
  url: string
): TriagemProcesso {
  const chegadaMs = toMsOrNull(p.dataChegadaTarefa);
  return {
    idProcesso: String(p.idProcesso),
    idTaskInstance: p.idTaskInstance != null ? String(p.idTaskInstance) : null,
    numeroProcesso: p.numeroProcesso ?? '',
    assunto: p.assuntoPrincipal ?? '',
    orgao: p.orgaoJulgador ?? '',
    poloAtivo: p.poloAtivo ?? '',
    poloPassivo: p.poloPassivo ?? '',
    dataEntradaTarefa: msParaDdMmAa(chegadaMs),
    diasNaTarefa: diasDesdeMs(chegadaMs),
    dataUltimoMovimento: msParaDdMmAa(p.ultimoMovimento),
    diasUltimoMovimento: diasDesdeMs(p.ultimoMovimento),
    dataConclusao: null,
    diasDesdeConclusao: null,
    ultimaMovimentacaoTexto: montarUltimaMovimentacaoTexto(p),
    prioritario: p.prioridade,
    sigiloso: p.sigiloso,
    etiquetas: p.etiquetas,
    url
  };
}

export interface ColetarSnapshotsViaAPIOptions {
  /** Nomes exatos das tarefas a coletar (mesmos rótulos do painel). */
  nomes: string[];
  /**
   * Origin do PJe legacy usado para montar a URL dos autos. Em iframe
   * cross-origin, o `window.location.origin` aponta para o frontend — o
   * caller deve passar aqui o origin do PJe real (ex. `pje1g.trf5...`).
   */
  pjeOrigin?: string;
  /** Limite de processos por tarefa. */
  maxProcessosPorTarefa?: number;
  /** Paralelismo de resolução de `ca`. Default 10, clamp [1, 10]. */
  concurrencyCa?: number;
  onProgress?: (msg: string) => void;
  /**
   * Handle de telemetria opcional. Quando fornecido, o coletor registra
   * fases (uma por tarefa) e contadores (processos, ca-erros). O caller
   * permanece responsável por `success`/`fail`/`cancel` do handle.
   * Se omitido, o coletor não grava telemetria (útil para testes e para
   * chamadas secundárias que não devem poluir o histórico).
   */
  telemetry?: ScanHandle;
}

export interface ColetarSnapshotsViaAPIResult {
  ok: boolean;
  snapshots: TriagemTarefaSnapshot[];
  error?: string;
}

/**
 * Coleta snapshots de todas as tarefas em `nomes` via REST:
 *   1. Para cada tarefa, lista os processos (pagina até esgotar).
 *   2. Pool de `gerarChaveAcesso` para montar URL autenticada.
 *   3. Converte em `TriagemProcesso` via `triagemProcessoFromApi`.
 *
 * Se o snapshot de auth não estiver disponível, devolve `ok: false` com
 * erro — cabe ao caller cair no fallback DOM.
 */
export async function coletarSnapshotsViaAPI(
  opts: ColetarSnapshotsViaAPIOptions
): Promise<ColetarSnapshotsViaAPIResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const legacyOrigin = (
    opts.pjeOrigin ?? window.location.origin
  ).replace(/\/+$/, '');
  const concurrencyCa = clamp(opts.concurrencyCa ?? 10, 1, 10);

  const snapshots: TriagemTarefaSnapshot[] = [];
  const tele = opts.telemetry;

  for (const nomeTarefa of opts.nomes) {
    onProgress(`Coletando processos da tarefa "${nomeTarefa}" — aguarde...`);
    const endListar = tele?.phase(`listar:${nomeTarefa}`);
    const lista = await listarProcessosDaTarefa({
      nomeTarefa,
      maxProcessos: opts.maxProcessosPorTarefa
    });
    await endListar?.({
      ok: lista.ok,
      total: lista.total,
      lidos: lista.processos.length
    });
    if (!lista.ok) {
      tele?.counter('tarefa-listar-erro');
      return {
        ok: false,
        snapshots,
        error: lista.error ?? `Falha listando "${nomeTarefa}".`
      };
    }
    tele?.counter('processos-listados', lista.processos.length);
    if (lista.processos.length < lista.total) {
      tele?.counter('processos-omitidos', lista.total - lista.processos.length);
    }
    onProgress(
      `Tarefa "${nomeTarefa}": ${lista.processos.length}/${lista.total} processo(s) identificados. Resolvendo autos...`
    );

    const processos: TriagemProcesso[] = new Array(lista.processos.length);
    let proximo = 0;
    let concluidos = 0;
    let errosCa = 0;

    const endResolver = tele?.phase(`resolver-ca:${nomeTarefa}`);
    const worker = async (): Promise<void> => {
      while (true) {
        const idx = proximo++;
        if (idx >= lista.processos.length) return;
        const api = lista.processos[idx];
        let url = '';
        try {
          if (api.idProcesso > 0) {
            const ca = await gerarChaveAcesso(api.idProcesso);
            if (ca.ok && ca.ca) {
              const params = new URLSearchParams();
              params.set('idProcesso', String(api.idProcesso));
              params.set('ca', ca.ca);
              if (api.idTaskInstance != null) {
                params.set('idTaskInstance', String(api.idTaskInstance));
              }
              url =
                `${legacyOrigin}/pje/Processo/ConsultaProcesso/Detalhe/` +
                `listAutosDigitais.seam?${params.toString()}`;
            } else {
              errosCa++;
            }
          }
        } catch {
          errosCa++;
          /* segue com url vazia — dashboard renderiza disabled */
        }
        processos[idx] = triagemProcessoFromApi(api, url);
        concluidos++;
        if (concluidos % 25 === 0 || concluidos === lista.processos.length) {
          onProgress(
            `Resolvendo autos em "${nomeTarefa}": ${concluidos}/${lista.processos.length}...`
          );
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrencyCa, lista.processos.length) },
      () => worker()
    );
    await Promise.all(workers);
    await endResolver?.({ concluidos, errosCa });
    if (errosCa > 0) tele?.counter('ca-erros', errosCa);

    snapshots.push({
      tarefaNome: nomeTarefa,
      totalLido: processos.length,
      truncado: processos.length < lista.total,
      processos
    });
  }

  return { ok: true, snapshots };
}
