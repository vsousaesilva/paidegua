/**
 * Orquestrador da ação "Validação de cadastro" (perfil Secretaria — item da
 * Triagem Inteligente, ao lado de "Analisar tarefas").
 *
 * Fluxo (roda no TOP frame do PJe, como o caminho REST do "Analisar tarefas"):
 *
 *   1. Lista as tarefas do painel e filtra pelo mesmo `TAREFA_REGEX`
 *      ("Analisar inicial" / "Triagem") usado pelo Analisar tarefas.
 *   2. Coleta os processos de cada tarefa via REST (`coletarSnapshotsViaAPI`,
 *      `skipCaResolution` — rápido, sem resolver `ca`).
 *   3. Para cada processo, baixa os autos digitais (`obterPartesDoProcesso`,
 *      same-origin com o PJe legacy) e extrai partes estruturadas + valor da
 *      causa. Pool concorrente limitado (cada HTML tem ~200-500 KB).
 *   4. Roda o motor determinístico `validarCadastroProcesso` sobre cada um.
 *   5. Devolve o payload consolidado (`ValidacaoCadastroDashboardPayload`).
 *
 * A abertura do relatório (dashboard), o botão do painel e a hidratação
 * progressiva de URLs pertencem à Fase 2 — este módulo entrega a coleta e o
 * veredito. Nada de IA aqui: a única regra que exige IA ("assunto x pedido")
 * fica fora do lote, sob demanda pelo "Analisar o processo".
 */

import { LOG_PREFIX } from '../../shared/constants';
import type {
  TriagemProcesso,
  ValidacaoCadastroDashboardPayload,
  ValidacaoCadastroProcesso
} from '../../shared/types';
import {
  validarCadastroProcesso,
  type ParteCadastro,
  type ProcessoCadastro
} from '../../shared/validacao-cadastro-regras';
import { obterPartesDoProcesso, type ParteExtraida } from '../pje-api/pje-api-partes';
import { coletarSnapshotsViaAPI } from '../gestao/triagem-from-api';
import { listarTarefasDoPainel } from '../gestao/gestao-bridge';
import { TAREFA_REGEX } from './analisar-tarefas';

/** Concorrência do download dos autos. Menor que a do "Analisar tarefas"
 * (que só resolve `ca`) porque aqui cada requisição puxa o HTML inteiro. */
const CONCURRENCY_AUTOS = 6;

export interface ValidarCadastroOptions {
  onProgress?: (msg: string) => void;
  /** Origin do PJe legacy (ex.: https://pje1g.trf5.jus.br). Default: origin atual. */
  pjeOrigin?: string;
  /** Limite de processos por tarefa (repassado ao coletor REST). */
  maxProcessosPorTarefa?: number;
}

export interface ValidarCadastroResult {
  ok: boolean;
  payload?: ValidacaoCadastroDashboardPayload;
  totalProcessos: number;
  error?: string;
}

/** Mapeia uma parte extraída dos autos para a forma consumida pelo motor. */
function paraParteCadastro(p: ParteExtraida): ParteCadastro {
  return {
    nome: p.nome,
    tipo: p.tipo,
    polo: p.polo,
    documentoTipo: p.documentoTipo,
    documentoNumero: p.documentoNumero,
    ehOrgaoPublico: p.ehOrgaoPublico,
    grupoId: p.grupoId,
    ehPrincipal: p.ehPrincipal
  };
}

/**
 * Valida um único processo: baixa os autos, extrai partes + valor da causa e
 * roda o motor. Nunca lança — falhas de coleta viram `status: 'erro'` na
 * linha do relatório.
 */
async function validarUmProcesso(
  proc: TriagemProcesso,
  tarefaNome: string,
  legacyOrigin: string
): Promise<ValidacaoCadastroProcesso> {
  const base = {
    idProcesso: proc.idProcesso,
    idTaskInstance: proc.idTaskInstance,
    numeroProcesso: proc.numeroProcesso,
    assunto: proc.assunto,
    orgao: proc.orgao,
    url: proc.url,
    tarefaNome
  };

  const idProcessoNum = Number(proc.idProcesso);
  if (!Number.isFinite(idProcessoNum) || idProcessoNum <= 0) {
    return {
      ...base,
      valorCausaTexto: null,
      status: 'erro',
      irregularidades: [],
      erro: 'idProcesso ausente ou inválido — autos não puderam ser lidos.'
    };
  }

  const idTaskNum =
    proc.idTaskInstance != null ? Number(proc.idTaskInstance) : null;

  let partes: ParteExtraida[] = [];
  let valorCausaTexto: string | null = null;
  try {
    const r = await obterPartesDoProcesso({
      idProcesso: idProcessoNum,
      idTaskInstance:
        idTaskNum != null && Number.isFinite(idTaskNum) ? idTaskNum : null,
      legacyOrigin
    });
    if (!r.ok) {
      return {
        ...base,
        valorCausaTexto: null,
        status: 'erro',
        irregularidades: [],
        erro: r.error ?? 'Falha ao baixar os autos digitais.'
      };
    }
    partes = r.partes ?? [];
    valorCausaTexto = r.valorCausaTexto ?? null;
    // A URL dos autos já foi resolvida (com `ca`) para baixar o HTML —
    // reaproveitamos como link "abrir processo", sem nova resolução.
    if (r.url) base.url = r.url;
  } catch (err) {
    return {
      ...base,
      valorCausaTexto: null,
      status: 'erro',
      irregularidades: [],
      erro: err instanceof Error ? err.message : String(err)
    };
  }

  const entrada: ProcessoCadastro = {
    numeroProcesso: proc.numeroProcesso,
    assunto: proc.assunto,
    valorCausaTexto,
    partes: partes.map(paraParteCadastro)
  };
  const veredito = validarCadastroProcesso(entrada);

  return {
    ...base,
    valorCausaTexto,
    status: veredito.status,
    irregularidades: veredito.irregularidades,
    erro: null
  };
}

/**
 * Executa a validação de cadastro sobre todas as tarefas de triagem do
 * painel. Devolve o payload pronto para o relatório (Fase 2).
 */
export async function executarValidacaoCadastro(
  options: ValidarCadastroOptions = {}
): Promise<ValidarCadastroResult> {
  const onProgress = options.onProgress ?? (() => {});
  const pjeOrigin = (options.pjeOrigin ?? window.location.origin).replace(/\/+$/, '');

  // 1. Tarefas do painel → filtro de triagem.
  onProgress('Procurando tarefas de análise inicial e triagem...');
  const listagem = await listarTarefasDoPainel();
  if (!listagem.ok) {
    return {
      ok: false,
      totalProcessos: 0,
      error:
        `Não foi possível listar as tarefas do painel (${listagem.error ?? 'sem detalhe'}). ` +
        'Abra o "Painel do usuário" do PJe e tente novamente.'
    };
  }
  const nomes = listagem.tarefas
    .map((t) => t.nome)
    .filter((n) => TAREFA_REGEX.test(n));
  if (nomes.length === 0) {
    return {
      ok: false,
      totalProcessos: 0,
      error:
        'Nenhuma tarefa contendo "Analisar inicial" ou "Triagem" foi encontrada no painel.'
    };
  }

  // 2. Coleta REST dos processos (rápida, sem resolver `ca`).
  onProgress(`Coletando processos de ${nomes.length} tarefa(s) de triagem...`);
  const coleta = await coletarSnapshotsViaAPI({
    nomes,
    pjeOrigin,
    maxProcessosPorTarefa: options.maxProcessosPorTarefa,
    skipCaResolution: true,
    onProgress
  });
  if (!coleta.ok) {
    return {
      ok: false,
      totalProcessos: 0,
      error:
        `Coleta dos processos indisponível (${coleta.error ?? 'sem detalhe'}). ` +
        'A validação de cadastro depende da API REST do painel (snapshot de auth).'
    };
  }

  // Achata (processo, tarefaNome) preservando a ordem de apresentação.
  const itens: Array<{ proc: TriagemProcesso; tarefaNome: string }> = [];
  for (const snap of coleta.snapshots) {
    for (const proc of snap.processos) {
      itens.push({ proc, tarefaNome: snap.tarefaNome });
    }
  }
  const total = itens.length;
  if (total === 0) {
    return {
      ok: false,
      totalProcessos: 0,
      error: 'Nenhum processo encontrado nas tarefas de triagem.'
    };
  }

  // 3. Pool concorrente: baixa autos + valida cada processo.
  const resultados: ValidacaoCadastroProcesso[] = new Array(total);
  let proximo = 0;
  let concluidos = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = proximo++;
      if (idx >= total) return;
      const { proc, tarefaNome } = itens[idx];
      resultados[idx] = await validarUmProcesso(proc, tarefaNome, pjeOrigin);
      concluidos++;
      if (concluidos % 10 === 0 || concluidos === total) {
        onProgress(`Validando cadastro: ${concluidos}/${total} processo(s)...`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY_AUTOS, total) }, () => worker())
  );

  const totalOk = resultados.filter((r) => r.status === 'ok').length;
  const totalIrregular = resultados.filter((r) => r.status === 'irregular').length;
  const totalErro = resultados.filter((r) => r.status === 'erro').length;

  const payload: ValidacaoCadastroDashboardPayload = {
    geradoEm: new Date().toISOString(),
    hostnamePJe: new URL(pjeOrigin).hostname,
    legacyOrigin: pjeOrigin,
    processos: resultados,
    totalProcessos: total,
    totalOk,
    totalIrregular,
    totalErro
  };

  console.log(
    `${LOG_PREFIX} validação de cadastro: ${total} processo(s) — ` +
      `${totalOk} ok, ${totalIrregular} irregular(es), ${totalErro} erro(s).`
  );
  onProgress(
    `Concluído: ${totalOk} regular(es), ${totalIrregular} com apontamentos, ${totalErro} não lido(s).`
  );

  return { ok: true, payload, totalProcessos: total };
}
