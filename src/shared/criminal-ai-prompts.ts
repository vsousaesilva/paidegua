/**
 * Prompt e tipos para extração de dados criminais via IA, portado de
 * `sigcrim/lib/ai-extract.ts`.
 *
 * O prompt é o mesmo usado pelo sigcrim original — comprovado em
 * processo real. As únicas diferenças aqui:
 *
 *   - Não inclui mais `pena_maxima_abstrato` (definição legal CP, não
 *     consta no processo).
 *   - Inclui campo `tipo_documento_origem` no schema esperado para
 *     facilitar o merge quando processamos múltiplos PDFs.
 *
 * Como usar: cada PDF principal extraído tem seu texto enviado a este
 * prompt; o IA devolve um JSON parcial (campos que não aplicam ao tipo
 * do documento ficam null). Depois mesclamos os JSONs por prioridade
 * (sentença > decisão ANPP > denúncia para campos sobrepostos).
 */

import { CLASSES_CRIMINAIS } from './criminal-classes';
import type { ResultadoSerp, StatusAnpp } from './criminal-types';

/**
 * Resultado da extração via IA — superset do sigcrim. Todos os campos
 * são opcionais; quando ausentes/null no PDF, vêm como `null`.
 */
export interface DadosPdfExtraidos {
  // Identificação
  numero_processo: string | null;
  nome_reu: string | null;
  cpf_reu: string | null;
  data_nascimento: string | null;
  data_fato: string | null;
  tipo_crime: string | null;

  // Prescrição
  pena_aplicada_concreto: number | null;
  data_recebimento_denuncia: string | null;
  data_sentenca: string | null;
  suspenso_366: boolean | null;
  data_inicio_suspensao: string | null;
  data_fim_suspensao: string | null;

  // ANPP
  status_anpp: StatusAnpp | null;
  numero_seeu: string | null;
  data_homologacao_anpp: string | null;
  data_remessa_mpf: string | null;
  data_protocolo_seeu: string | null;

  // SERP
  ultima_consulta_serp: string | null;
  resultado_serp: ResultadoSerp | null;
  serp_inquerito: boolean | null;
  serp_denuncia: boolean | null;
  serp_sentenca: boolean | null;
  serp_guia: boolean | null;

  // Meta — observações e tipo de documento detectado
  observacoes_ia: string | null;
}

/**
 * Prompt de sistema (português jurídico técnico). Mantido próximo ao
 * original do sigcrim — a única adaptação são as instruções de robustez
 * que a IA pode ignorar campos não aplicáveis ao tipo de documento que
 * está vendo.
 */
export const PROMPT_SISTEMA_DADOS_PDF = `Você é um assistente especializado em análise de processos judiciais criminais federais brasileiros.

Analise o texto fornecido (que pode ser uma denúncia, sentença, decisão de homologação de ANPP, ou documento similar) e extraia APENAS os campos listados abaixo, com precisão máxima.

REGRAS GERAIS:
1. Retorne APENAS um objeto JSON válido — sem markdown, sem texto adicional, sem explicações
2. Use null para campos não encontrados OU com menos de 90% de certeza
3. Não invente dados — na dúvida, sempre use null
4. observacoes_ia: registre brevemente o que não encontrou ou qualquer ambiguidade relevante (ou null)
5. Se o documento for de um TIPO específico (denúncia, sentença, decisão), preencha apenas os campos que aquele tipo tipicamente carrega; deixe os demais null

═══════════════════════════════════════
DADOS BÁSICOS
═══════════════════════════════════════

numero_processo:
- Padrão CNJ obrigatório: NNNNNNN-DD.AAAA.J.TT.OOOO (ex: "0000123-45.2020.4.05.8101")
- Procure no cabeçalho, capa, autuação ou rodapé do documento

nome_reu / cpf_reu / data_nascimento:
- Extraia da qualificação do réu na denúncia ou no interrogatório
- cpf_reu: formato "000.000.000-00"
- data_nascimento: formato YYYY-MM-DD

data_fato:
- Data em que o crime foi praticado, conforme narrado na denúncia
- Formato YYYY-MM-DD. Se for período, use a data inicial

tipo_crime:
- Descrição sucinta do crime e artigo legal (ex: "Estelionato previdenciário — Art. 171, §3º, CP")

═══════════════════════════════════════
PRESCRIÇÃO
═══════════════════════════════════════

pena_aplicada_concreto:
- SOMENTE extraia se o documento contiver uma SENTENÇA CONDENATÓRIA com pena fixada
- Procure expressões como "condeno o réu a X anos e Y meses" ou "fixo a pena em X anos"
- Converta para meses inteiros (ex: "3 anos e 6 meses" → 42)
- Se o documento não for uma sentença, retorne null
- NÃO confunda com pena máxima legal nem com pena de ANPP

data_recebimento_denuncia:
- Data em que o juiz recebeu/aceitou a denúncia do MPF
- Procure por expressões como "recebo a denúncia", "recebimento da denúncia"
- Formato YYYY-MM-DD
- NÃO confunda com a data de oferecimento da denúncia pelo MPF

data_sentenca:
- Data da prolação da sentença condenatória (não da publicação, não do trânsito em julgado)
- Formato YYYY-MM-DD

suspenso_366:
- true se o processo estiver suspenso com base no Art. 366 do CPP (réu revel citado por edital)
- false se não houver menção de suspensão por Art. 366

data_inicio_suspensao:
- Data da decisão que decretou a suspensão pelo Art. 366 CPP
- Formato YYYY-MM-DD. Retorne null se suspenso_366 for false

data_fim_suspensao:
- Data da decisão que encerrou/levantou a suspensão
- Formato YYYY-MM-DD. Retorne null se a suspensão ainda estiver em vigor

═══════════════════════════════════════
ANPP — ACORDO DE NÃO PERSECUÇÃO PENAL
═══════════════════════════════════════

status_anpp:
- Analise o documento e classifique em EXATAMENTE um dos valores (string exata):
  "Nao Aplicavel"    → sem menção de ANPP, ou crime não elegível
  "Em Negociacao"    → há menção de proposta ou tratativas de ANPP
  "Homologado"       → há decisão de homologação do ANPP
  "Remetido MPF"     → processo/acordo remetido ao MPF após homologação
  "Protocolado SEEU" → acordo protocolado no SEEU
  "Em Execucao SEEU" → em execução no SEEU
  "Execucao Vara"    → em execução na própria vara federal
  "Cumprido"         → acordo integralmente cumprido
- Na dúvida, use "Nao Aplicavel"

numero_seeu:
- Número do processo de execução no SEEU (classe 12729)
- Retorne null se não encontrado

data_homologacao_anpp:
- Data da decisão homologatória do ANPP
- Formato YYYY-MM-DD

data_remessa_mpf:
- Data em que o processo/acordo foi remetido ao MPF após homologação
- Formato YYYY-MM-DD

data_protocolo_seeu:
- Data em que o acordo foi protocolado no SEEU
- Formato YYYY-MM-DD

═══════════════════════════════════════
SERP / ÓBITO
═══════════════════════════════════════

ultima_consulta_serp:
- Data da consulta mais recente ao SERP (Sistema de Registro de Pessoas) ou similar (SIRC, RFB)
- Formato YYYY-MM-DD

resultado_serp:
- Use EXATAMENTE um dos valores:
  "Negativo"  → consulta realizada, réu vivo
  "Positivo"  → óbito registrado
  "Pendente"  → consulta não realizada ou não mencionada

serp_inquerito / serp_denuncia / serp_sentenca / serp_guia:
- true se o documento mencionar consulta SERP no momento correspondente

═══════════════════════════════════════

RESPONDA COM EXATAMENTE ESTE JSON (sem mais nada):
{
  "numero_processo": "...",
  "nome_reu": "...",
  "cpf_reu": "...",
  "data_nascimento": "YYYY-MM-DD",
  "data_fato": "YYYY-MM-DD",
  "tipo_crime": "...",
  "pena_aplicada_concreto": null,
  "data_recebimento_denuncia": "YYYY-MM-DD",
  "data_sentenca": "YYYY-MM-DD",
  "suspenso_366": false,
  "data_inicio_suspensao": null,
  "data_fim_suspensao": null,
  "status_anpp": "Nao Aplicavel",
  "numero_seeu": null,
  "data_homologacao_anpp": null,
  "data_remessa_mpf": null,
  "data_protocolo_seeu": null,
  "ultima_consulta_serp": null,
  "resultado_serp": "Pendente",
  "serp_inquerito": false,
  "serp_denuncia": false,
  "serp_sentenca": false,
  "serp_guia": false,
  "observacoes_ia": "..."
}`;

/**
 * Limite máximo de caracteres a enviar ao provider. O sigcrim original
 * usa 60k; mantemos o mesmo. Para PDFs maiores, o caller trunca antes.
 */
export const MAX_CHARS_PARA_IA = 60_000;

/**
 * Set normalizado de nomes de classes criminais — usado para
 * filtrar respostas onde a IA confundiu "classe processual" com
 * "tipo de crime". Comparação case+acento-insensitive.
 */
const NOMES_CLASSES_NORMALIZADOS: ReadonlySet<string> = new Set(
  CLASSES_CRIMINAIS.map((c) =>
    c.nome
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .trim()
  )
);

/**
 * Detecta resposta ruim da IA no campo `tipo_crime`: às vezes,
 * quando a denúncia não traz tipificação clara, a IA preenche com
 * o nome da CLASSE PROCESSUAL ("AÇÃO PENAL - PROCEDIMENTO ORDINÁRIO")
 * em vez do crime tipificado ("Estelionato — Art. 171 CP"). Esse é
 * um falso positivo — a classe não diz nada sobre o crime cometido.
 *
 * Heurísticas:
 *   1. String idêntica ao nome de uma classe criminal do catálogo.
 *   2. String começando com prefixos típicos de classe processual
 *      ("AÇÃO PENAL", "PROCEDIMENTO", "INQUÉRITO POLICIAL", "CARTA",
 *      "MEDIDA", "EXCEÇÃO", "EMBARGOS", "RECURSO", "AGRAVO",
 *      "APELAÇÃO", "EXECUÇÃO DA PENA").
 *
 * Em qualquer dos casos, devolve `null` — preferimos campo vazio
 * (que mostra "—" no painel + permite edição manual) a campo com
 * valor enganoso.
 */
function sanitizarTipoCrimeIa(s: string | null | undefined): string | null {
  if (!s) return null;
  const norm = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
  if (!norm) return null;
  if (NOMES_CLASSES_NORMALIZADOS.has(norm)) return null;
  const prefixosClasse = [
    'ACAO PENAL',
    'PROCEDIMENTO ',
    'INQUERITO',
    'CARTA ',
    'MEDIDA',
    'MEDIDAS ',
    'EXCECAO',
    'EXCECOES',
    'EMBARGOS',
    'RECURSO ',
    'AGRAVO',
    'APELACAO',
    'EXECUCAO ',
    'PETICAO',
    'HABEAS '
  ];
  for (const p of prefixosClasse) {
    if (norm.startsWith(p)) return null;
  }
  return s.trim();
}

/**
 * Mescla múltiplos `DadosPdfExtraidos` num só, preferindo o valor
 * NÃO-NULO mais recente para cada campo. Quando todos são null, mantém
 * null. Útil quando processamos N PDFs principais e queremos consolidar.
 *
 * Os arrays devem vir em ordem de prioridade (mais relevante primeiro);
 * o primeiro valor não-nulo encontrado para cada campo vence.
 */
export function mesclarDadosPdf(
  fontes: readonly DadosPdfExtraidos[]
): DadosPdfExtraidos {
  const out: DadosPdfExtraidos = {
    numero_processo: null,
    nome_reu: null,
    cpf_reu: null,
    data_nascimento: null,
    data_fato: null,
    tipo_crime: null,
    pena_aplicada_concreto: null,
    data_recebimento_denuncia: null,
    data_sentenca: null,
    suspenso_366: null,
    data_inicio_suspensao: null,
    data_fim_suspensao: null,
    status_anpp: null,
    numero_seeu: null,
    data_homologacao_anpp: null,
    data_remessa_mpf: null,
    data_protocolo_seeu: null,
    ultima_consulta_serp: null,
    resultado_serp: null,
    serp_inquerito: null,
    serp_denuncia: null,
    serp_sentenca: null,
    serp_guia: null,
    observacoes_ia: null
  };
  const observacoes: string[] = [];
  for (const fonte of fontes) {
    for (const k of Object.keys(out) as (keyof DadosPdfExtraidos)[]) {
      if (k === 'observacoes_ia') continue;
      // só preenche se ainda for null e o fonte tem valor
      const cur = out[k];
      const novo = fonte[k];
      if ((cur === null || cur === undefined) && novo !== null && novo !== undefined) {
        // Type-safe assignment via reassignment based on field
        // (TS não consegue inferir corretamente sem cast).
        (out as unknown as Record<string, unknown>)[k] = novo;
      }
    }
    if (fonte.observacoes_ia) observacoes.push(fonte.observacoes_ia);
  }
  if (observacoes.length > 0) out.observacoes_ia = observacoes.join(' | ');
  // Sanitiza tipo_crime depois de consolidar — evita propagar nomes
  // de classes processuais que a IA possa ter colocado como crime.
  out.tipo_crime = sanitizarTipoCrimeIa(out.tipo_crime);
  return out;
}
