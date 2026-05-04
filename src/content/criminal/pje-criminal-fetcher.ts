/**
 * Fetcher do perfil "Gestão Criminal" do paidegua.
 *
 * Orquestra:
 *   - **Listagem**: REST do painel do usuário (`recuperarProcessosTarefaPendenteComCriterios`)
 *     iterando uma lista de `nomeTarefa` informadas pelo caller. Filtra
 *     opcionalmente por sigla de classe via campo `classe` do body.
 *   - **Detalhamento por processo**: DOM scraping da página
 *     `listAutosDigitais.seam` via `coletarProcessoCriminal`
 *     (background abre aba inativa, content extrai, devolve).
 *   - **Mapeamento**: converte `(painel + partes + movimentos)` em
 *     `ProcessoCapturado` (= `ProcessoPayload + ReuPayload[] + audit`).
 *
 * Streaming: cada processo é entregue via `onCapturado(capturado)`
 * conforme é coletado — o caller (Painel UI / Fase 3) pode persistir
 * incrementalmente e atualizar o dashboard sem aguardar o fim.
 *
 * Resilência: quando o DOM scraping falha ou devolve zero partes, o
 * fetcher faz **fallback** para o `poloPassivo` da resposta do painel,
 * criando um réu único com nome textual + warning. Isso garante que
 * varreduras parciais ainda produzam dados úteis em vez de zeros.
 */

import { LOG_PREFIX } from '../../shared/constants';
import {
  getClasseByCodigo,
  type CategoriaCriminal
} from '../../shared/criminal-classes';
import {
  getMovimentoByCodigo,
  type MovimentoCriminal,
  type TipoMovimentoCriminal
} from '../../shared/criminal-movimentos';
import { isSiglaCriminal } from '../../shared/criminal-siglas';
import type {
  PjeOrigemMap,
  ProcessoPayload,
  ReuPayload,
  StatusAnpp
} from '../../shared/criminal-types';
import type { DadosPdfExtraidos } from '../../shared/criminal-ai-prompts';
import {
  coletarProcessoCriminal,
  listarProcessosDaTarefaCriminal,
  type PJeDetalhesProcesso,
  type PJeMovimento,
  type PJeParte,
  type PJeProcessoListado
} from '../pje-api/pje-api-criminal';

// ── Tipos públicos ───────────────────────────────────────────────

export interface ProcessoCapturado {
  /** Dados do processo prontos para `criarProcesso`/`atualizarProcesso`. */
  payload: ProcessoPayload;
  /** Réus (polo passivo) prontos para serem associados ao processo. */
  reus: ReuPayload[];
  /** Audit por campo do processo (todo campo preenchido pelo PJe = 'pje'). */
  pje_origem: PjeOrigemMap;
  /** Audit por campo de cada réu, alinhado por índice com `reus`. */
  reusOrigem: PjeOrigemMap[];
  /** Carimbo ISO da varredura — vai em `ultima_sincronizacao_pje`. */
  ultima_sincronizacao_pje: string;
  /** Avisos não-fatais (ex.: "réu sem CPF", "duas sentenças"). */
  warnings: string[];
}

export interface VarreduraResumo {
  totalProcessosListados: number;
  /** Processos descartados na Fase 1 por sigla não-criminal. */
  descartadosPorSigla: number;
  /** Processos descartados na Fase 1 por estarem fora da janela de dias. */
  descartadosPorIdade: number;
  /** Processos descartados por excederem o teto. */
  descartadosPorTeto: number;
  /** Histograma de siglas desconhecidas (para reportar e evoluir whitelist). */
  siglasDesconhecidas: Record<string, number>;
  capturados: number;
  erros: number;
  tarefasProcessadas: number;
  tarefasComFalha: { tarefa: string; error: string }[];
  inicioEm: string;
  fimEm: string;
}

export interface OpcoesVarredura {
  /** Tarefas do painel a varrer (uma chamada por tarefa). */
  tarefas: readonly string[];
  /**
   * Sigla(s) de classe a filtrar no servidor. Quando informa 1 sigla,
   * vai como `classe: <sigla>` no body. Quando informa N, faz N chamadas
   * por tarefa. Quando ausente, traz tudo da tarefa.
   */
  siglasAceitas?: readonly string[];
  servidorResponsavel?: string;
  varaId?: string;
  /**
   * Liga IA dos PDFs principais. Default `true` (modo completo). Quando
   * `false`, usa o modo "rápido" — só scraping, sem fetch de PDFs nem
   * chamada à IA.
   */
  runIA?: boolean;
  /** Mensagem de progresso a cada tarefa / processo. */
  onProgress?: (msg: string) => void;
  /** Cada processo conforme é capturado (streaming para o dashboard). */
  onCapturado?: (capturado: ProcessoCapturado) => Promise<void> | void;
  /** Limite duro de processos por tarefa. Default 5000. */
  maxProcessosPorTarefa?: number;
  /**
   * Janela em dias a partir de `dataChegada` da tarefa. Processos com
   * `dataChegada` mais antiga são descartados na Fase 1 (antes de
   * coletar). Útil para varreduras incrementais (ex.: "última semana").
   * `0` ou ausente = sem limite.
   */
  diasMaximos?: number;
  /**
   * Teto absoluto de processos a coletar (após dedupe + filtros).
   * Default 1000 — protege o usuário de varreduras infinitas em
   * varas com acervos grandes. `0` = sem limite.
   */
  tetoProcessos?: number;
  /**
   * Concorrência do pool de coleta. Default 25 — espelha o coordinator
   * de Prazos na fita: HTTP/2 do PJe multiplexa dezenas de streams
   * sobre uma única conexão TCP. Aceita 1–30.
   */
  concorrencia?: number;
  /**
   * Quando `true` (default), aplica o whitelist de siglas criminais
   * (`isSiglaCriminal`) na Fase 1. Siglas desconhecidas são descartadas
   * com log agregado — evita varrer processos não-criminais em varas
   * mistas. Defina `false` apenas para diagnóstico (ex.: investigar
   * por que uma sigla nova não está sendo capturada).
   */
  filtroSigla?: boolean;
}

// ── Helpers de normalização ──────────────────────────────────────

/**
 * Normaliza datas vindas do PJe para `YYYY-MM-DD`. Aceita:
 *   - ISO completo  (`2024-03-15T14:23:00.000Z`)
 *   - ISO date only (`2024-03-15`)
 *   - BR (`15/03/2024`)
 *   - epoch ms      (`1710512580000`)
 */
export function toIsoDate(s: string): string {
  const t = s.trim();
  if (!t) return t;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const br = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const n = Number(t);
  if (Number.isFinite(n) && n > 0) {
    return new Date(n).toISOString().slice(0, 10);
  }
  return t;
}

function reuPayloadVazio(): Omit<
  ReuPayload,
  'nome_reu' | 'cpf_reu' | 'data_nascimento'
> {
  return {
    pena_maxima_abstrato: null,
    pena_aplicada_concreto: null,
    data_sentenca: null,
    suspenso_366: false,
    data_inicio_suspensao: null,
    data_fim_suspensao: null,
    status_anpp: 'Nao Aplicavel',
    numero_seeu: null,
    data_homologacao_anpp: null,
    data_remessa_mpf: null,
    data_protocolo_seeu: null,
    ultima_comprovacao_anpp: null,
    ultima_consulta_serp: null,
    resultado_serp: 'Pendente',
    serp_inquerito: false,
    serp_denuncia: false,
    serp_sentenca: false,
    serp_guia: false
  };
}

function partePassiva(p: PJeParte): boolean {
  if (p.tipoPolo === 'passivo') return true;
  const papel = (p.papel ?? '').toLowerCase();
  if (
    p.tipoPolo === 'outros' &&
    /\b(r[eé]u|denunciado|acusado|investigado)\b/.test(papel)
  ) {
    return true;
  }
  return false;
}

interface MovimentoSelecionado {
  movimento: PJeMovimento;
  meta: MovimentoCriminal;
}

function selecionarMovimentos(
  movimentos: readonly PJeMovimento[]
): MovimentoSelecionado[] {
  const out: MovimentoSelecionado[] = [];
  for (const m of movimentos) {
    const meta = getMovimentoByCodigo(m.codigo);
    if (meta) out.push({ movimento: m, meta });
  }
  return out.sort((a, b) => a.movimento.data.localeCompare(b.movimento.data));
}

function primeiroPorTipo(
  selecionados: readonly MovimentoSelecionado[],
  tipo: TipoMovimentoCriminal
): MovimentoSelecionado | undefined {
  return selecionados.find((s) => s.meta.tipo === tipo);
}

function ultimoPorTipo(
  selecionados: readonly MovimentoSelecionado[],
  tipo: TipoMovimentoCriminal
): MovimentoSelecionado | undefined {
  for (let i = selecionados.length - 1; i >= 0; i--) {
    if (selecionados[i]!.meta.tipo === tipo) return selecionados[i];
  }
  return undefined;
}

function ultimoPorTipos(
  selecionados: readonly MovimentoSelecionado[],
  tipos: readonly TipoMovimentoCriminal[]
): MovimentoSelecionado | undefined {
  for (let i = selecionados.length - 1; i >= 0; i--) {
    if (tipos.includes(selecionados[i]!.meta.tipo)) return selecionados[i];
  }
  return undefined;
}

/**
 * Extrai nome(s) de réu da string `poloPassivo` do painel REST.
 *   - "JOSE DA SILVA"           → ["JOSE DA SILVA"]
 *   - "JOSE DA SILVA e outros (3)" → ["JOSE DA SILVA"]  (+ warning)
 *   - "JOSE; MARIA"             → ["JOSE", "MARIA"]
 *   - null / vazio              → []
 */
function nomesDoPoloPassivoString(s: string | null): {
  nomes: string[];
  truncado: boolean;
} {
  if (!s) return { nomes: [], truncado: false };
  const eOutros = s.match(/^(.+?)\s+e\s+outros?\s*\(\d+\)\s*$/i);
  if (eOutros) {
    return { nomes: [eOutros[1]!.trim()], truncado: true };
  }
  const partes = s
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { nomes: partes.length > 0 ? partes : [s.trim()], truncado: false };
}

// ── Mapeamento (função pura) ─────────────────────────────────────

/**
 * Mapeia processo + partes + movimentos para um `ProcessoCapturado`.
 *
 * Regras:
 *   - Réus = polo passivo (com fallback heurístico para `papel`).
 *   - Quando `partes` vier vazio, usa `proc.poloPassivo` como fallback
 *     (cria 1 ou N réus via parsing da string).
 *   - `data_recebimento_denuncia` = primeiro 391 ou 393.
 *   - `data_sentenca` (por réu) = última sentença observada.
 *   - `suspenso_366` = última ocorrência de 263.
 *   - `status_anpp` = Cumprimento (12735) > Revogação (12734) > Homologação (12733).
 */
export function mapearParaProcessoCapturado(
  proc: PJeProcessoListado,
  partes: readonly PJeParte[],
  movimentos: readonly PJeMovimento[],
  opts: {
    servidorResponsavel?: string;
    varaId?: string;
    /**
     * Detalhes da capa do processo extraídos via DOM scraping. Quando
     * disponível, sobrepõe `proc.classeCnj` e supre `tipo_crime` /
     * vara_id.
     */
    detalhes?: PJeDetalhesProcesso | null;
    /**
     * Dados extraídos via IA dos PDFs principais (denúncia, sentença,
     * decisão de homologação ANPP). Quando presentes, sobrepõem
     * scraping em campos como `data_recebimento_denuncia`,
     * `data_sentenca`, `pena_aplicada_concreto`, ANPP. Marcam origem
     * `'ia'` em `pje_origem`.
     */
    dadosIA?: DadosPdfExtraidos | null;
  }
): ProcessoCapturado {
  const warnings: string[] = [];
  const ts = new Date().toISOString();

  // ── Réus ─────────────────────────────────────────────────────
  const passivos = partes.filter(partePassiva);

  const reus: ReuPayload[] = [];
  const reusOrigem: PjeOrigemMap[] = [];

  if (passivos.length > 0) {
    for (const p of passivos) {
      const origem: PjeOrigemMap = { nome_reu: 'pje' };
      if (p.documento) origem.cpf_reu = 'pje';
      if (p.dataNascimento) origem.data_nascimento = 'pje';

      reus.push({
        nome_reu: p.nome,
        cpf_reu: p.documento,
        data_nascimento: p.dataNascimento,
        ...reuPayloadVazio()
      });
      reusOrigem.push(origem);
    }
  } else {
    // Fallback: scraping não trouxe partes → usa o `poloPassivo` do painel.
    const fallback = nomesDoPoloPassivoString(proc.poloPassivo);
    if (fallback.truncado) {
      warnings.push(
        `Polo passivo truncado em "e outros (N)" e DOM scraping não trouxe ` +
          'partes — apenas o primeiro réu foi capturado, demais devem ser ' +
          'adicionados manualmente.'
      );
    }
    if (fallback.nomes.length === 0) {
      warnings.push('Nenhum réu identificado nem via DOM nem via poloPassivo.');
    }
    for (const nome of fallback.nomes) {
      reus.push({
        nome_reu: nome,
        cpf_reu: null,
        data_nascimento: null,
        ...reuPayloadVazio()
      });
      reusOrigem.push({ nome_reu: 'pje' });
    }
  }

  // ── Movimentos ───────────────────────────────────────────────
  const selecionados = selecionarMovimentos(movimentos);

  const procOrigem: PjeOrigemMap = {
    numero_processo: 'pje',
    id_processo_pje: 'pje'
  };

  // Resolve classe CNJ priorizando os detalhes da capa (mais confiável
  // que a sigla do painel REST). Em última instância usa proc.classeCnj.
  const classeCnjEfetiva = opts.detalhes?.classeCnj ?? proc.classeCnj ?? 0;

  const procPayload: ProcessoPayload = {
    numero_processo: proc.numeroProcesso,
    classe_cnj: classeCnjEfetiva,
    classe_categoria: 'desconhecida' as CategoriaCriminal,
    is_classe_primaria: false,
    tipo_crime: opts.detalhes?.assunto ?? null,
    data_fato: null,
    data_recebimento_denuncia: null,
    observacoes: null,
    id_processo_pje: proc.idProcesso,
    hostname_pje: typeof window !== 'undefined' ? window.location.hostname : null,
    id_task_instance: proc.idTaskInstance,
    vara_id:
      opts.varaId ??
      opts.detalhes?.orgaoJulgador ??
      proc.orgaoJulgador ??
      null,
    servidor_responsavel: opts.servidorResponsavel ?? null
  };

  // Origem dos campos preenchidos pela capa
  if (opts.detalhes?.assunto) procOrigem.tipo_crime = 'pje';
  if (opts.detalhes?.orgaoJulgador && !opts.varaId) procOrigem.vara_id = 'pje';

  // Resolve categoria a partir do código de classe (se reconhecido)
  if (classeCnjEfetiva > 0) {
    const classe = getClasseByCodigo(classeCnjEfetiva);
    if (classe) {
      procPayload.classe_categoria = classe.categoria;
      procPayload.is_classe_primaria = classe.isPrimaria;
      procOrigem.classe_cnj = 'pje';
    } else {
      warnings.push(
        `Classe CNJ ${classeCnjEfetiva} não está no catálogo criminal — ` +
          'pode ser uma classe não criminal (verifique se é vara realmente penal).'
      );
    }
  } else if (proc.classeSigla) {
    warnings.push(
      `Classe veio como sigla "${proc.classeSigla}" — código CNJ não resolvido. ` +
        'Edite manualmente se necessário.'
    );
  }

  // Recebimento de denúncia / queixa
  const recebimento =
    primeiroPorTipo(selecionados, 'recebimento_denuncia') ??
    primeiroPorTipo(selecionados, 'recebimento_queixa');
  if (recebimento) {
    procPayload.data_recebimento_denuncia = toIsoDate(recebimento.movimento.data);
    procOrigem.data_recebimento_denuncia = 'pje';
  }

  // Sentença
  const sentenca = ultimoPorTipos(selecionados, [
    'sentenca_procedencia',
    'sentenca_improcedencia',
    'sentenca_parcial',
    'absolvicao_sumaria',
    'pronuncia',
    'impronuncia'
  ]);
  const sentencas = selecionados.filter((s) =>
    [
      'sentenca_procedencia',
      'sentenca_improcedencia',
      'sentenca_parcial',
      'absolvicao_sumaria'
    ].includes(s.meta.tipo)
  );
  if (sentencas.length > 1) {
    warnings.push(
      `${sentencas.length} sentenças — usando a mais recente; revisar se há réus com sentenças distintas.`
    );
  }

  // Suspensão 366
  const suspensao = ultimoPorTipo(selecionados, 'suspensao_366');

  // ANPP
  const ultHomolog = ultimoPorTipo(selecionados, 'homologacao_anpp');
  const ultRevog = ultimoPorTipo(selecionados, 'revogacao_anpp');
  const ultCumpr = ultimoPorTipo(selecionados, 'cumprimento_anpp');

  let statusAnpp: StatusAnpp | null = null;
  let dataHomologacaoAnpp: string | null = null;
  if (ultCumpr) {
    statusAnpp = 'Cumprido';
  } else if (
    ultRevog &&
    (!ultHomolog ||
      ultRevog.movimento.data.localeCompare(ultHomolog.movimento.data) > 0)
  ) {
    statusAnpp = 'Nao Aplicavel';
  } else if (ultHomolog) {
    statusAnpp = 'Homologado';
    dataHomologacaoAnpp = toIsoDate(ultHomolog.movimento.data);
  }

  for (let i = 0; i < reus.length; i++) {
    const r = reus[i]!;
    const o = reusOrigem[i]!;
    if (sentenca) {
      r.data_sentenca = toIsoDate(sentenca.movimento.data);
      o.data_sentenca = 'pje';
    }
    if (suspensao) {
      r.suspenso_366 = true;
      r.data_inicio_suspensao = toIsoDate(suspensao.movimento.data);
      o.suspenso_366 = 'pje';
      o.data_inicio_suspensao = 'pje';
    }
    if (statusAnpp) {
      r.status_anpp = statusAnpp;
      o.status_anpp = 'pje';
      if (dataHomologacaoAnpp) {
        r.data_homologacao_anpp = dataHomologacaoAnpp;
        o.data_homologacao_anpp = 'pje';
      }
    }
  }

  // ── IA dos PDFs principais (sobrepõe scraping quando aplicável) ──
  // A IA tem acesso ao texto completo dos PDFs (denúncia, sentença,
  // decisão de ANPP), então é mais confiável que os movimentos
  // pós-migração que vêm da timeline. Onde a IA traz valor não-nulo,
  // ele vence o scraping; onde é null, preserva o que o scraping pegou.
  const dadosIA = opts.dadosIA ?? null;
  if (dadosIA) {
    if (dadosIA.tipo_crime) {
      procPayload.tipo_crime = dadosIA.tipo_crime;
      procOrigem.tipo_crime = 'ia';
    }
    if (dadosIA.data_fato) {
      procPayload.data_fato = dadosIA.data_fato;
      procOrigem.data_fato = 'ia';
    }
    if (dadosIA.data_recebimento_denuncia) {
      procPayload.data_recebimento_denuncia = dadosIA.data_recebimento_denuncia;
      procOrigem.data_recebimento_denuncia = 'ia';
    }
    // Campos por réu — aplicados uniformemente quando há um único réu;
    // múltiplos réus mantêm o valor do scraping (a IA não individualiza).
    for (let i = 0; i < reus.length; i++) {
      const r = reus[i]!;
      const o = reusOrigem[i]!;
      if (dadosIA.cpf_reu && !r.cpf_reu) {
        r.cpf_reu = dadosIA.cpf_reu;
        o.cpf_reu = 'ia';
      }
      if (dadosIA.data_nascimento && !r.data_nascimento) {
        r.data_nascimento = dadosIA.data_nascimento;
        o.data_nascimento = 'ia';
      }
      if (dadosIA.data_sentenca) {
        r.data_sentenca = dadosIA.data_sentenca;
        o.data_sentenca = 'ia';
      }
      if (dadosIA.pena_aplicada_concreto != null) {
        r.pena_aplicada_concreto = dadosIA.pena_aplicada_concreto;
        o.pena_aplicada_concreto = 'ia';
      }
      if (dadosIA.suspenso_366 === true) {
        r.suspenso_366 = true;
        o.suspenso_366 = 'ia';
        if (dadosIA.data_inicio_suspensao) {
          r.data_inicio_suspensao = dadosIA.data_inicio_suspensao;
          o.data_inicio_suspensao = 'ia';
        }
        if (dadosIA.data_fim_suspensao) {
          r.data_fim_suspensao = dadosIA.data_fim_suspensao;
          o.data_fim_suspensao = 'ia';
        }
      }
      if (dadosIA.status_anpp && dadosIA.status_anpp !== 'Nao Aplicavel') {
        r.status_anpp = dadosIA.status_anpp;
        o.status_anpp = 'ia';
      }
      if (dadosIA.data_homologacao_anpp) {
        r.data_homologacao_anpp = dadosIA.data_homologacao_anpp;
        o.data_homologacao_anpp = 'ia';
      }
      if (dadosIA.data_remessa_mpf) {
        r.data_remessa_mpf = dadosIA.data_remessa_mpf;
        o.data_remessa_mpf = 'ia';
      }
      if (dadosIA.data_protocolo_seeu) {
        r.data_protocolo_seeu = dadosIA.data_protocolo_seeu;
        o.data_protocolo_seeu = 'ia';
      }
      if (dadosIA.numero_seeu && !r.numero_seeu) {
        r.numero_seeu = dadosIA.numero_seeu;
        o.numero_seeu = 'ia';
      }
    }
    if (dadosIA.observacoes_ia) {
      procPayload.observacoes = procPayload.observacoes
        ? `${procPayload.observacoes}\n[IA] ${dadosIA.observacoes_ia}`
        : `[IA] ${dadosIA.observacoes_ia}`;
    }
  }

  return {
    payload: procPayload,
    reus,
    pje_origem: procOrigem,
    reusOrigem,
    ultima_sincronizacao_pje: ts,
    warnings
  };
}

// ── Captura individual ───────────────────────────────────────────

/**
 * Coleta dados detalhados (partes + movimentos) e mapeia para
 * `ProcessoCapturado`. Quando o DOM scraping falha, registra warning e
 * faz fallback para o `poloPassivo` do painel.
 */
export async function capturarProcesso(
  proc: PJeProcessoListado,
  opts: { servidorResponsavel?: string; varaId?: string; runIA?: boolean }
): Promise<{ ok: true; capturado: ProcessoCapturado } | { ok: false; error: string }> {
  const r = await coletarProcessoCriminal(proc.idProcesso, {
    runIA: opts.runIA !== false
  });
  if (!r.ok) {
    // Mesmo com falha de scraping, produz um capturado básico a partir
    // dos dados do painel (modo MVP relaxado).
    const capturado = mapearParaProcessoCapturado(proc, [], [], opts);
    capturado.warnings.unshift(
      `DOM scraping falhou (${r.error}) — usando apenas dados do painel.`
    );
    return { ok: true, capturado };
  }

  const capturado = mapearParaProcessoCapturado(proc, r.partes, r.movimentos, {
    ...opts,
    detalhes: r.detalhes,
    dadosIA: r.dadosIA as DadosPdfExtraidos | null
  });
  return { ok: true, capturado };
}

// ── Varredura em lote ────────────────────────────────────────────

/**
 * Calcula o limite ISO inferior (inclusive) para o filtro de idade.
 * `diasMaximos = 30` em 2026-05-02 → "2026-04-02".
 */
function calcularDataLimite(diasMaximos: number, agora = new Date()): string {
  const d = new Date(agora.getTime());
  d.setDate(d.getDate() - diasMaximos);
  return d.toISOString().slice(0, 10);
}

/**
 * Itera as tarefas informadas, lista processos via REST do painel,
 * filtra (sigla criminal / janela de dias / teto), captura em pool
 * concorrente (default 25) e emite via `onCapturado` para persistência
 * streaming.
 *
 * Filtragem na Fase 1 (antes de qualquer fetch caro):
 *   1. Sigla criminal — whitelist `isSiglaCriminal`. Em varas mistas
 *      isso elimina dezenas/centenas de processos cíveis/JEF que viriam
 *      junto na tarefa "Triagem Inicial" mas que jamais seriam
 *      relevantes para o painel criminal.
 *   2. Janela de dias — filtra `dataChegada` da tarefa.
 *   3. Teto — corta o restante após dedupe.
 *
 * Pool concorrente substitui o for-loop sequencial: 25 workers fazendo
 * `gerarChaveAcesso` + `fetch(listAutosDigitais.seam)` + `DOMParser`
 * em paralelo. HTTP/2 multiplexa as requisições sobre uma única
 * conexão TCP. Para 100 processos: ~5s vs ~3min do antigo loop seq.
 *
 * Erros por processo são contabilizados mas não interrompem a varredura.
 */
export async function varrerCriminalPorTarefas(
  opts: OpcoesVarredura
): Promise<VarreduraResumo> {
  const inicioEm = new Date().toISOString();
  const onProgress = opts.onProgress ?? (() => {});
  const onCapturado = opts.onCapturado ?? (() => {});
  const maxPorTarefa = Math.max(1, opts.maxProcessosPorTarefa ?? 5000);
  const filtroSigla = opts.filtroSigla !== false;
  const tetoProcessos =
    opts.tetoProcessos === undefined ? 1000 : Math.max(0, opts.tetoProcessos);
  const dataLimite =
    opts.diasMaximos && opts.diasMaximos > 0
      ? calcularDataLimite(opts.diasMaximos)
      : null;
  const concorrencia = Math.min(30, Math.max(1, opts.concorrencia ?? 25));

  const idsVistos = new Set<number>();
  const siglasDesconhecidas: Record<string, number> = {};
  let totalProcessosListados = 0;
  let descartadosPorSigla = 0;
  let descartadosPorIdade = 0;
  let descartadosPorTeto = 0;
  let capturados = 0;
  let erros = 0;
  let tarefasProcessadas = 0;
  const tarefasComFalha: { tarefa: string; error: string }[] = [];

  // ── Fase 1: listagem + filtros (sequencial entre tarefas) ────────
  const candidatos: PJeProcessoListado[] = [];
  for (const nomeTarefa of opts.tarefas) {
    onProgress(`Listando processos da tarefa "${nomeTarefa}"...`);

    const siglasIter: readonly (string | undefined)[] =
      opts.siglasAceitas && opts.siglasAceitas.length > 0
        ? opts.siglasAceitas
        : [undefined];

    let listagensOk = 0;
    const acumuladoTarefa: PJeProcessoListado[] = [];
    let erroTarefa: string | null = null;

    for (const sigla of siglasIter) {
      const lista = await listarProcessosDaTarefaCriminal({
        nomeTarefa,
        sigla,
        maxProcessos: maxPorTarefa
      });
      if (!lista.ok) {
        erroTarefa = lista.error;
        break;
      }
      listagensOk += 1;
      acumuladoTarefa.push(...lista.processos);
    }

    if (erroTarefa && listagensOk === 0) {
      tarefasComFalha.push({ tarefa: nomeTarefa, error: erroTarefa });
      onProgress(`Tarefa "${nomeTarefa}" falhou: ${erroTarefa}`);
      continue;
    }

    tarefasProcessadas += 1;
    totalProcessosListados += acumuladoTarefa.length;

    let aceitos = 0;
    let descartadosTarefaSigla = 0;
    let descartadosTarefaIdade = 0;

    for (const proc of acumuladoTarefa) {
      // Dedupe global (mesmo processo pode aparecer em N tarefas).
      if (idsVistos.has(proc.idProcesso)) continue;
      idsVistos.add(proc.idProcesso);

      // Filtro 1: sigla criminal
      if (filtroSigla) {
        if (!isSiglaCriminal(proc.classeSigla)) {
          descartadosPorSigla += 1;
          descartadosTarefaSigla += 1;
          if (proc.classeSigla) {
            const k = proc.classeSigla.trim().toUpperCase();
            siglasDesconhecidas[k] = (siglasDesconhecidas[k] ?? 0) + 1;
          }
          continue;
        }
      }

      // Filtro 2: janela de dias
      if (dataLimite && proc.dataChegada) {
        const chegadaIso = toIsoDate(proc.dataChegada);
        if (chegadaIso && chegadaIso < dataLimite) {
          descartadosPorIdade += 1;
          descartadosTarefaIdade += 1;
          continue;
        }
      }

      candidatos.push(proc);
      aceitos += 1;
    }

    onProgress(
      `Tarefa "${nomeTarefa}": ${aceitos} aceito(s) ` +
        `(${descartadosTarefaSigla} sigla, ${descartadosTarefaIdade} idade) ` +
        `de ${acumuladoTarefa.length} listado(s).`
    );
  }

  // Filtro 3: teto absoluto
  let aColetar = candidatos;
  if (tetoProcessos > 0 && candidatos.length > tetoProcessos) {
    descartadosPorTeto = candidatos.length - tetoProcessos;
    aColetar = candidatos.slice(0, tetoProcessos);
    onProgress(
      `Teto de ${tetoProcessos} aplicado — ${descartadosPorTeto} processo(s) ` +
        'ficaram fora desta varredura.'
    );
  }

  // Log agregado de siglas desconhecidas (uma vez, no fim da Fase 1).
  const siglasDescStr = Object.entries(siglasDesconhecidas)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  if (siglasDescStr) {
    console.log(
      `${LOG_PREFIX} [criminal-fetcher] siglas descartadas (não criminais ` +
        `ou desconhecidas): ${siglasDescStr}`
    );
  }

  if (aColetar.length === 0) {
    onProgress('Nenhum processo passou pelos filtros.');
    return {
      totalProcessosListados,
      descartadosPorSigla,
      descartadosPorIdade,
      descartadosPorTeto,
      siglasDesconhecidas,
      capturados,
      erros,
      tarefasProcessadas,
      tarefasComFalha,
      inicioEm,
      fimEm: new Date().toISOString()
    };
  }

  onProgress(
    `Pool de ${concorrencia} worker(s) coletando ${aColetar.length} processo(s)...`
  );

  // ── Fase 2: pool concorrente ─────────────────────────────────────
  // Worker pega `proximo++`, coleta, emite. Mesmo padrão do
  // prazos-fita-coordinator (HTTP/2 multiplexa, ~25 streams sobre 1 TCP).
  let proximo = 0;
  let concluidos = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = proximo++;
      if (idx >= aColetar.length) return;
      const proc = aColetar[idx]!;

      try {
        const r = await capturarProcesso(proc, {
          servidorResponsavel: opts.servidorResponsavel,
          varaId: opts.varaId,
          runIA: opts.runIA
        });
        if (!r.ok) {
          erros += 1;
          concluidos += 1;
          console.warn(`${LOG_PREFIX} [criminal-fetcher] ${r.error}`);
          onProgress(
            `[${concluidos}/${aColetar.length}] ${proc.numeroProcesso} — ` +
              `erro: ${r.error}`
          );
          continue;
        }
        capturados += 1;
        concluidos += 1;
        await onCapturado(r.capturado);
        onProgress(
          `[${concluidos}/${aColetar.length}] ${proc.numeroProcesso} — ` +
            `${r.capturado.reus.length} réu(s).`
        );
      } catch (err) {
        erros += 1;
        concluidos += 1;
        console.warn(
          `${LOG_PREFIX} [criminal-fetcher] erro capturando ${proc.numeroProcesso}:`,
          err
        );
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concorrencia, aColetar.length) },
    () => worker()
  );
  await Promise.all(workers);

  return {
    totalProcessosListados,
    descartadosPorSigla,
    descartadosPorIdade,
    descartadosPorTeto,
    siglasDesconhecidas,
    capturados,
    erros,
    tarefasProcessadas,
    tarefasComFalha,
    inicioEm,
    fimEm: new Date().toISOString()
  };
}
