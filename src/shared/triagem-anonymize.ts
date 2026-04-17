/**
 * Anonimização dos agregados do dashboard "Analisar tarefas" antes do envio
 * à LLM (Anthropic / OpenAI / Gemini).
 *
 * REGRA EXPRESSA — POLÍTICA DE PRIVACIDADE DA EXTENSÃO:
 *
 *   Os dados exibidos no dashboard local (aberto na aba do navegador do
 *   usuário) preservam números de processo, nomes das partes e textos
 *   completos das movimentações — porque essa informação NUNCA sai da
 *   máquina e é necessária para o usuário trabalhar (links clicáveis,
 *   identificação de quem é quem).
 *
 *   Quando esses mesmos dados são enviados à LLM externa para gerar
 *   insights (panorama + sugestões), os identificadores pessoais são
 *   substituídos; o número CNJ é MANTIDO porque é essencial para que a
 *   secretaria consiga localizar os autos referenciados nas sugestões
 *   (o número CNJ é informação pública via Consulta Processual):
 *
 *     - Número CNJ ........ preservado no campo `ref` (ex.: "0001019-74.2026.4.05.8109")
 *     - Polo ativo ........ "[POLO ATIVO]"  (pessoa física → papel processual)
 *     - Polo passivo ...... "[POLO PASSIVO]" (preserva entes públicos: INSS, União, FN)
 *     - Última movimentação tem CPF/CNPJ/CEP/telefone/email substituídos pelo
 *       regex de `aplicarRegexAnonimizacao`. Números CNJ de OUTROS processos
 *       citados no texto da movimentação são trocados por "[OUTRO PROC]"
 *       (apenas o CNJ do próprio processo permanece no claro).
 *
 *   Órgão julgador, assunto, datas, etiquetas, prioridade e sigilo são
 *   mantidos — não identificam pessoas físicas e são imprescindíveis para
 *   a análise estatística. O ID interno do PJe (idProcesso) também é
 *   removido (não é PII, mas não tem utilidade para o LLM e expõe a
 *   instância).
 *
 * Esta regra é aplicada tanto no front (content script, antes da chamada)
 * quanto verificada no back (background, antes de chamar o provedor).
 * Se uma estrutura nova for criada, MANTER a anonimização nos dois lados.
 */

import { aplicarRegexAnonimizacao } from './anonymizer';
import type {
  TriagemDashboardPayload,
  TriagemProcesso,
  TriagemTarefaSnapshot
} from './types';

/**
 * Versão "limpa" de um processo, segura para enviar à LLM. Mesmos campos
 * estatísticos do `TriagemProcesso`, mas sem PII e com chaves curtas para
 * economizar tokens.
 */
export interface TriagemProcessoAnon {
  /**
   * Número CNJ do processo (ex.: "PJEC 0001019-74.2026.4.05.8109").
   * MANTIDO no claro para que a LLM possa referenciar os autos de forma
   * que a secretaria consiga localizá-los. CNJ é informação pública.
   */
  ref: string;
  assunto: string;
  orgao: string;
  /** "[POLO ATIVO]" — não envia o nome real. */
  poloAtivo: string;
  /** Preservado se for ente público conhecido; caso contrário "[POLO PASSIVO]". */
  poloPassivo: string;
  diasNaTarefa: number | null;
  diasUltimoMovimento: number | null;
  diasDesdeConclusao: number | null;
  ultimaMovimentacaoTexto: string | null;
  prioritario: boolean;
  sigiloso: boolean;
  etiquetas: string[];
}

export interface TriagemTarefaAnon {
  tarefaNome: string;
  totalLido: number;
  truncado: boolean;
  processos: TriagemProcessoAnon[];
}

export interface TriagemPayloadAnon {
  hostnamePJe: string;
  totalProcessos: number;
  tarefas: TriagemTarefaAnon[];
}

/**
 * Lista de entes públicos cujo nome é informação institucional, não PII.
 * Mantemos no claro para que a LLM consiga sugerir cortes adequados
 * ("processos contra o INSS costumam ser benefícios por incapacidade…").
 *
 * Comparação é case-insensitive e por substring — basta o nome aparecer
 * no polo passivo. Cobre as variações usuais do TRF5.
 */
const ENTES_PUBLICOS_PASSIVO: readonly string[] = [
  'INSS',
  'INSTITUTO NACIONAL DO SEGURO SOCIAL',
  'UNIÃO',
  'FAZENDA NACIONAL',
  'CAIXA ECONÔMICA FEDERAL',
  'CEF',
  'BANCO DO BRASIL',
  'IBAMA',
  'ANATEL',
  'ANAC',
  'ANEEL',
  'CONSELHO REGIONAL',
  'CRM',
  'CRO',
  'CREA',
  'OAB',
  'AGU',
  'DNIT',
  'INCRA',
  'FUNAI',
  'IFCE',
  'UFC',
  'IFPE',
  'UFPE',
  'IFPB',
  'UFPB'
];

/** Regex do número CNJ — duplicado aqui para evitar dependência circular. */
const CNJ_RE = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;

function detectaEntePublico(polo: string): string | null {
  const upper = polo.toUpperCase();
  for (const ente of ENTES_PUBLICOS_PASSIVO) {
    if (upper.includes(ente)) return ente;
  }
  return null;
}

/**
 * Sanitiza um único processo. O `ref` é o próprio número CNJ — preservado
 * no claro porque é a referência que a secretaria precisa para localizar
 * os autos nas sugestões da LLM (CNJ é informação pública).
 *
 * Substituições aplicadas no texto da última movimentação:
 *  1. Regex genérico (CPF, CNPJ, CEP, telefone, email, RG, banco).
 *  2. CNJ de OUTROS processos citados no texto (ações conexas etc.)
 *     → "[OUTRO PROC]". O CNJ do próprio processo é mantido.
 */
function sanitizeProcesso(
  proc: TriagemProcesso,
  ref: string
): TriagemProcessoAnon {
  const entePassivo = detectaEntePublico(proc.poloPassivo);
  const passivo = entePassivo ?? '[POLO PASSIVO]';

  let mov = proc.ultimaMovimentacaoTexto;
  if (mov) {
    mov = aplicarRegexAnonimizacao(mov);
    const numProprio = proc.numeroProcesso.match(CNJ_RE)?.[0];
    mov = mov.replace(CNJ_RE, (match) =>
      numProprio && match === numProprio ? match : '[OUTRO PROC]'
    );
  }

  return {
    ref,
    assunto: proc.assunto,
    orgao: proc.orgao,
    poloAtivo: '[POLO ATIVO]',
    poloPassivo: passivo,
    diasNaTarefa: proc.diasNaTarefa,
    diasUltimoMovimento: proc.diasUltimoMovimento,
    diasDesdeConclusao: proc.diasDesdeConclusao,
    ultimaMovimentacaoTexto: mov,
    prioritario: proc.prioritario,
    sigiloso: proc.sigiloso,
    etiquetas: proc.etiquetas
  };
}

/**
 * Recebe o payload completo (com PII, como exibido no dashboard) e devolve
 * a versão pronta para a LLM. O número CNJ é MANTIDO no campo `ref` —
 * informação pública, essencial para a secretaria localizar cada processo
 * nas sugestões. Nomes das partes (pessoa física) são que são substituídos
 * por marcadores genéricos.
 *
 * Esta função é idempotente e não modifica o `payload` recebido.
 */
export function sanitizePayloadForLLM(
  payload: TriagemDashboardPayload
): TriagemPayloadAnon {
  const tarefas: TriagemTarefaAnon[] = payload.tarefas.map(
    (t: TriagemTarefaSnapshot) => ({
      tarefaNome: t.tarefaNome,
      totalLido: t.totalLido,
      truncado: t.truncado,
      processos: t.processos.map((p) => sanitizeProcesso(p, p.numeroProcesso))
    })
  );

  return {
    hostnamePJe: payload.hostnamePJe,
    totalProcessos: payload.totalProcessos,
    tarefas
  };
}

/**
 * Aviso curto que pode ser injetado no system prompt da LLM e exibido no
 * dashboard, para auditoria.
 */
export const TRIAGEM_LLM_ANON_NOTICE =
  'Os dados enviados contêm o número CNJ real no campo "ref" (informação ' +
  'pública, útil para referenciar os autos nas sugestões). Polo ativo foi ' +
  'substituído por "[POLO ATIVO]", polo passivo preservado apenas para ' +
  'entes públicos, CNJ de outros processos citados na movimentação foi ' +
  'trocado por "[OUTRO PROC]". Dados estruturados (assunto, datas, ' +
  'etiquetas, prioridade, sigilo) foram mantidos para análise.';
