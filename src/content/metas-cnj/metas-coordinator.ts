/**
 * Orquestrador da varredura "Controle Metas CNJ" (perfil Gestão).
 *
 * Roda no content script da aba PJe (mesmo origin para chamar a API REST
 * do painel + montar a chave `ca` necessária ao fetch SSR dos autos).
 * O upsert no IndexedDB do acervo (`paidegua.metas-cnj`) acontece no
 * BACKGROUND — content e background trocam mensagens via canais
 * `METAS_*` (ver `constants.ts`).
 *
 * Pipeline (por tarefa selecionada):
 *
 *   1. Lista processos da tarefa via `recuperarProcessosTarefaPendente`
 *      (REST, paginado).
 *   2. Para cada processo:
 *      a. Pergunta ao background se precisa fetch profundo (incremental
 *         via `ultimo_movimento_visto`).
 *      b. Se sim: gera `ca` + faz fetch SSR + extrai detalhes (data
 *         distribuição, movimentos, documentos).
 *      c. Envia o patch consolidado ao background, que faz upsert,
 *         classifica via detector + regras das metas e grava.
 *      d. Reporta progresso humano.
 *
 * V1: o caminho incremental existe mas a varredura ainda é sequencial
 * (uma tarefa por vez, processos um a um). Otimizar para pool concorrente
 * é trilho futuro — mesmo padrão do `prazos-fita-coordinator.ts`.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../../shared/constants';
import {
  gerarChaveAcesso,
  listarProcessosDaTarefa
} from '../pje-api/pje-api-from-content';
import type { PJeApiProcesso } from '../../shared/types';
import { coletarDadosMetasDoProcesso } from './metas-extractor';

// =====================================================================
// Tipos públicos
// =====================================================================

export interface VarrerMetasOpts {
  /** Nomes exatos das tarefas selecionadas no painel. */
  nomesTarefas: readonly string[];
  /** Origin completo do PJe legacy (ex.: `https://pje1g.trf5.jus.br`). */
  legacyOrigin: string;
  /** Hostname (auditoria — usado pelo background no `lastSync`). */
  hostnamePJe: string;
  /** ISO da varredura corrente — passado em todos os upserts. */
  ultimaSincronizacaoPje: string;
  /** Reporta uma linha de log à aba-painel. */
  onProgress: (msg: string) => void;
}

export interface ResumoVarredura {
  totalDescobertos: number;
  totalUpserts: number;
  totalFetchProfundo: number;
  totalPulados: number;
  totalErros: number;
  duracaoMs: number;
  tarefasProcessadas: string[];
  tarefasComFalha: Array<{ tarefa: string; error: string }>;
}

/**
 * Patch que o coordinator envia ao background no canal
 * `METAS_UPSERT_PROCESSO`. Espelha `ProcessoVarreduraPatch` do store,
 * porém duplicado aqui em forma "leve" para evitar import cruzado entre
 * content e shared (o shape é um subset).
 */
export interface MetasPatchEnvelope {
  // Identificação
  numero_processo: string;
  id_processo_pje: number;
  id_task_instance_atual: number | null;
  classe_sigla: string;
  assunto_principal: string | null;
  polo_ativo: string | null;
  polo_passivo: string | null;
  orgao_julgador: string | null;
  cargo_judicial: string | null;
  etiquetas_pje: string[];
  tarefa_origem_atual: string | null;
  url: string | null;
  // Datas (preenchidas só quando houve fetch profundo nesta varredura)
  data_distribuicao?: string | null;
  data_autuacao?: string | null;
  // Marca de presença e chave incremental
  presente_ultima_varredura: true;
  ultimo_movimento_visto: string | null;
  // Movimentos e documentos (quando fetch profundo) — passados ao
  // background para o detector classificar status.
  movimentos?: Array<{
    codigoCnj: number | null;
    descricao: string;
    data: string;
  }>;
  documentos?: Array<{
    tipo: string;
    descricao: string;
    dataJuntada: string;
  }>;
  /** True quando esta varredura efetivamente coletou dados profundos. */
  veioComFetchProfundo: boolean;
}

// =====================================================================
// IPC com background
// =====================================================================

/**
 * Pergunta ao background se este processo precisa de fetch profundo.
 * Critério (no background):
 *   - Não está no acervo → precisa
 *   - Está no acervo, mas `ultimo_movimento_visto` mudou → precisa
 *   - Mesmo `ultimo_movimento_visto` → não precisa (incremental)
 */
async function precisaFetchProfundo(
  numeroProcesso: string,
  ultimoMovimentoAtual: string | null
): Promise<boolean> {
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: 'paidegua/metas/precisa-fetch',
      payload: {
        numero_processo: numeroProcesso,
        ultimo_movimento_visto: ultimoMovimentoAtual
      }
    });
    if (resp && typeof resp === 'object' && 'precisa' in resp) {
      return Boolean((resp as { precisa: boolean }).precisa);
    }
    // Sem resposta clara → conservador, faz fetch.
    return true;
  } catch {
    return true;
  }
}

async function enviarUpsert(envelope: MetasPatchEnvelope): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.METAS_UPSERT_PROCESSO,
      payload: envelope
    });
  } catch (err) {
    // Falha de envio = perda do upsert. Loga, mas não interrompe a
    // varredura — o usuário pode rodar de novo.
    console.warn(
      `${LOG_PREFIX} metas-coordinator: enviarUpsert falhou para ${envelope.numero_processo}:`,
      err
    );
  }
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * Constrói uma "assinatura" do `ultimo_movimento_visto` a partir do
 * `PJeApiProcesso`. Usa `descricaoUltimoMovimento + ultimoMovimento` —
 * mudou um, mudou outro.
 */
function montarAssinaturaUltimoMovimento(p: PJeApiProcesso): string | null {
  const desc = p.descricaoUltimoMovimento ?? '';
  const ts = p.ultimoMovimento ?? 0;
  if (!desc && !ts) return null;
  return `${ts}::${desc}`;
}

function montarUrlAutosBase(
  legacyOrigin: string,
  idProcesso: number,
  ca: string,
  idTaskInstance: number | null
): string {
  const params = new URLSearchParams();
  params.set('idProcesso', String(idProcesso));
  params.set('ca', ca);
  if (idTaskInstance != null) {
    params.set('idTaskInstance', String(idTaskInstance));
  }
  return (
    `${legacyOrigin}/pje/Processo/ConsultaProcesso/Detalhe/` +
    `listAutosDigitais.seam?${params.toString()}`
  );
}

function deriveTituloProcesso(p: PJeApiProcesso): string {
  return p.numeroProcesso ?? `id ${p.idProcesso}`;
}

// =====================================================================
// Função principal
// =====================================================================

export async function varrerMetasCnj(
  opts: VarrerMetasOpts
): Promise<ResumoVarredura> {
  const inicio = Date.now();
  const tarefasProcessadas: string[] = [];
  const tarefasComFalha: Array<{ tarefa: string; error: string }> = [];
  let totalDescobertos = 0;
  let totalUpserts = 0;
  let totalFetchProfundo = 0;
  let totalPulados = 0;
  let totalErros = 0;

  for (const tarefaNome of opts.nomesTarefas) {
    opts.onProgress(`Tarefa "${tarefaNome}": listando processos...`);
    let processos: PJeApiProcesso[];
    try {
      const resp = await listarProcessosDaTarefa({
        nomeTarefa: tarefaNome,
        pageSize: 200
      });
      if (!resp.ok) {
        throw new Error(resp.error ?? 'Falha desconhecida na listagem REST.');
      }
      processos = resp.processos;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tarefasComFalha.push({ tarefa: tarefaNome, error: msg });
      opts.onProgress(`Tarefa "${tarefaNome}": ERRO ao listar — ${msg}`);
      continue;
    }

    totalDescobertos += processos.length;
    opts.onProgress(
      `Tarefa "${tarefaNome}": ${processos.length} processo(s) encontrados.`
    );

    let i = 0;
    for (const p of processos) {
      i++;
      if (!p.numeroProcesso) {
        // Sem CNJ não dá pra usar como chave do acervo — descarta.
        totalErros++;
        continue;
      }

      const titulo = deriveTituloProcesso(p);
      const assinatura = montarAssinaturaUltimoMovimento(p);

      const precisaFetch = await precisaFetchProfundo(
        p.numeroProcesso,
        assinatura
      );

      let envelope: MetasPatchEnvelope;
      if (!precisaFetch) {
        // Caminho incremental: só marca presença, não refaz fetch.
        totalPulados++;
        envelope = montarPatchBasico(p, tarefaNome, null, null, null, null, false);
        await enviarUpsert(envelope);
        totalUpserts++;
        if (i % 25 === 0 || i === processos.length) {
          opts.onProgress(
            `Tarefa "${tarefaNome}": ${i}/${processos.length} (${totalPulados} pulados via incremental).`
          );
        }
        continue;
      }

      // Caminho com fetch profundo
      let caValor: string | null = null;
      try {
        const caResp = await gerarChaveAcesso(p.idProcesso);
        if (caResp.ok && caResp.ca) {
          caValor = caResp.ca;
        } else {
          throw new Error(caResp.error ?? 'gerarChaveAcesso devolveu vazio.');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Falha de ca: registra envelope sem dados profundos para não
        // perder presença do processo no acervo.
        envelope = montarPatchBasico(p, tarefaNome, null, null, null, null, false);
        await enviarUpsert(envelope);
        totalUpserts++;
        totalErros++;
        opts.onProgress(
          `${titulo}: erro de chave de acesso — ${msg} (mantendo no acervo sem dados profundos).`
        );
        continue;
      }

      const url = montarUrlAutosBase(
        opts.legacyOrigin,
        p.idProcesso,
        caValor!,
        p.idTaskInstance
      );

      const extracao = await coletarDadosMetasDoProcesso({
        idProcesso: p.idProcesso,
        ca: caValor!,
        idTaskInstance: p.idTaskInstance,
        legacyOrigin: opts.legacyOrigin
      });

      if (!extracao.ok) {
        envelope = montarPatchBasico(p, tarefaNome, url, null, null, null, false);
        await enviarUpsert(envelope);
        totalUpserts++;
        totalErros++;
        opts.onProgress(
          `${titulo}: erro no fetch profundo — ${extracao.error ?? 'desconhecido'}.`
        );
        continue;
      }

      totalFetchProfundo++;
      envelope = montarPatchBasico(
        p,
        tarefaNome,
        url,
        extracao.data_distribuicao ?? null,
        extracao.data_autuacao ?? null,
        extracao.orgao_julgador ?? null,
        true,
        extracao.movimentos,
        extracao.documentos
      );
      await enviarUpsert(envelope);
      totalUpserts++;

      if (i % 10 === 0 || i === processos.length) {
        opts.onProgress(
          `Tarefa "${tarefaNome}": ${i}/${processos.length} ` +
            `(${totalFetchProfundo} fetch profundo, ${totalPulados} pulados).`
        );
      }
    }

    tarefasProcessadas.push(tarefaNome);
  }

  const duracaoMs = Date.now() - inicio;
  opts.onProgress(
    `Varredura concluída em ${(duracaoMs / 1000).toFixed(1)}s — ` +
      `${totalUpserts} upserts (${totalFetchProfundo} fetch profundo, ${totalPulados} pulados via incremental).`
  );

  return {
    totalDescobertos,
    totalUpserts,
    totalFetchProfundo,
    totalPulados,
    totalErros,
    duracaoMs,
    tarefasProcessadas,
    tarefasComFalha
  };
}

// =====================================================================
// Helpers de construção de envelope
// =====================================================================

function montarPatchBasico(
  p: PJeApiProcesso,
  tarefaNome: string,
  url: string | null,
  dataDistribuicao: string | null,
  dataAutuacao: string | null,
  orgaoJulgadorAutos: string | null,
  veioComFetchProfundo: boolean,
  movimentos?: MetasPatchEnvelope['movimentos'],
  documentos?: MetasPatchEnvelope['documentos']
): MetasPatchEnvelope {
  return {
    numero_processo: p.numeroProcesso!,
    id_processo_pje: p.idProcesso,
    id_task_instance_atual: p.idTaskInstance,
    classe_sigla: p.classeJudicial ?? '',
    assunto_principal: p.assuntoPrincipal,
    polo_ativo: p.poloAtivo,
    polo_passivo: p.poloPassivo,
    orgao_julgador: orgaoJulgadorAutos ?? p.orgaoJulgador,
    cargo_judicial: p.cargoJudicial,
    etiquetas_pje: p.etiquetas ?? [],
    tarefa_origem_atual: tarefaNome,
    url,
    data_distribuicao: dataDistribuicao,
    data_autuacao: dataAutuacao,
    presente_ultima_varredura: true,
    ultimo_movimento_visto: montarAssinaturaUltimoMovimento(p),
    movimentos,
    documentos,
    veioComFetchProfundo
  };
}
