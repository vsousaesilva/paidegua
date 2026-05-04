/**
 * Tipos do perfil "Gestão Criminal" do paidegua.
 *
 * Schema portado de sigcrim/lib/types.ts (Next.js + Supabase) e adaptado
 * para o cenário local-first da extensão:
 *
 *   - sem multi-tenant server-side (single-user por vara)
 *   - identificação do servidor é texto livre vindo das configurações
 *   - audit de origem por campo (`pje | manual | ia`) para distinguir o
 *     que veio da varredura PJe do que foi inserido manualmente
 *   - classe CNJ obrigatória em cada processo (filtra o que entra no
 *     dashboard primário vs. auxiliar)
 */

import type { CategoriaCriminal } from './criminal-classes';

export type StatusAnpp =
  | 'Nao Aplicavel'
  | 'Em Negociacao'
  | 'Homologado'
  | 'Remetido MPF'
  | 'Protocolado SEEU'
  | 'Em Execucao SEEU'
  | 'Execucao Vara'
  | 'Cumprido';

export const STATUS_ANPP_VALUES = [
  'Nao Aplicavel',
  'Em Negociacao',
  'Homologado',
  'Remetido MPF',
  'Protocolado SEEU',
  'Em Execucao SEEU',
  'Execucao Vara',
  'Cumprido'
] as const satisfies readonly StatusAnpp[];

export type ResultadoSerp = 'Negativo' | 'Positivo' | 'Pendente';

/**
 * Entrada de trace operacional. Cada handler longo (busca JSF de
 * Pessoa Física, reprocessamento via aba oculta, ativação de PDF, IA)
 * acumula entradas e devolve no response. O dashboard renderiza o
 * trace abaixo do botão de "Atualizar com PJe + IA" — assim o
 * usuário vê EXATAMENTE o que aconteceu (e onde parou) sem precisar
 * abrir o devtools do service worker. Crítico para depurar pipelines
 * que envolvem múltiplas abas e mensagens cross-context.
 */
export interface TraceEntry {
  /** Identificador curto da etapa (ex.: "gerar-ca", "ativar-doc-12345"). */
  etapa: string;
  /** Status: ok = passou, falha = parou aqui, info = passo neutro. */
  status: 'ok' | 'falha' | 'info' | 'aviso';
  /** Detalhe humano-legível (ex.: "idPessoa=2623137", "0 bytes"). */
  info?: string;
  /** Duração em ms desde o início do handler (não da etapa). */
  ts?: number;
}

export const RESULTADO_SERP_VALUES = [
  'Negativo',
  'Positivo',
  'Pendente'
] as const satisfies readonly ResultadoSerp[];

/**
 * Origem de cada campo, para audit/UX.
 *   - 'pje': veio da varredura REST do PJe
 *   - 'manual': digitado pelo servidor na sidebar
 *   - 'ia': pré-preenchido por IA a partir de PDF anexado
 */
export type OrigemCampo = 'pje' | 'manual' | 'ia';

/** Mapa de campo → origem. Chave é o nome do campo de Processo ou Reu. */
export type PjeOrigemMap = Record<string, OrigemCampo>;

// ── Réu ─────────────────────────────────────────────────────────

export interface Reu {
  /** UUID local. */
  id: string;

  // Identificação
  nome_reu: string;
  cpf_reu?: string | null;
  data_nascimento?: string | null; // ISO YYYY-MM-DD
  /** RG (livre, sem máscara fixa). Vem do enriquecimento JSF. */
  rg?: string | null;
  /** Nome da mãe — útil para confirmação de identidade na SERP. */
  nome_mae?: string | null;
  /** Endereço (livre, formatado para leitura). */
  endereco?: string | null;
  /**
   * `idPessoa` interno do cadastro de Pessoa Física do PJe (mesmo
   * `id` que aparece no botão "Editar" da tela
   * `/pje/PessoaFisica/listView.seam`). Usado para evitar nova busca
   * por CPF em re-enriquecimentos.
   */
  id_pessoa_pje?: number | null;

  // Prescrição
  pena_maxima_abstrato?: number | null;     // meses
  pena_aplicada_concreto?: number | null;   // meses
  data_sentenca?: string | null;            // ISO
  suspenso_366: boolean;
  data_inicio_suspensao?: string | null;
  data_fim_suspensao?: string | null;
  /**
   * Réu reincidente — aumenta o prazo prescricional em 1/3 (CP art.
   * 110 caput). Marcação manual pelo servidor (a IA não decide
   * reincidência por padrão, é juízo do magistrado/servidor).
   */
  reincidente?: boolean;

  // ANPP
  status_anpp: StatusAnpp;
  numero_seeu?: string | null;
  data_homologacao_anpp?: string | null;
  data_remessa_mpf?: string | null;
  data_protocolo_seeu?: string | null;
  ultima_comprovacao_anpp?: string | null;

  // SERP
  ultima_consulta_serp?: string | null;
  resultado_serp: ResultadoSerp;
  serp_inquerito: boolean;
  serp_denuncia: boolean;
  serp_sentenca: boolean;
  serp_guia: boolean;

  // Audit
  pje_origem: PjeOrigemMap;
  criado_em: string;    // ISO
  atualizado_em: string;
}

export type ReuPayload = Omit<Reu, 'id' | 'pje_origem' | 'criado_em' | 'atualizado_em'>;

// ── Processo ────────────────────────────────────────────────────

export interface Processo {
  /** UUID local. */
  id: string;
  /** Número CNJ (NNNNNNN-DD.AAAA.J.TT.OOOO). */
  numero_processo: string;

  // Classificação CNJ — chave para a trilha primária/auxiliar
  classe_cnj: number;
  classe_categoria: CategoriaCriminal;
  is_classe_primaria: boolean;

  // Dados processuais (vêm do PJe quando possível)
  tipo_crime?: string | null;
  data_fato?: string | null;                 // não está no PJe — manual/IA
  data_recebimento_denuncia?: string | null; // movimento 26
  observacoes?: string | null;

  // Identificação no PJe (úteis para abrir os autos)
  id_processo_pje?: number | null;
  /**
   * Hostname do PJe onde o processo foi capturado (ex.:
   * `pje1g.trf5.jus.br`). Usado para montar URL "abrir processo"/
   * "abrir tarefa" no dashboard. Pode ficar `null` em registros
   * antigos capturados antes desta extensão de schema — nesse caso
   * o link é renderizado desabilitado.
   */
  hostname_pje?: string | null;
  /**
   * ID da TaskInstance corrente do processo na varredura. Se ainda
   * estiver na mesma tarefa, o link `movimentar.seam?newTaskId=X`
   * abre direto na tarefa. Pode ficar desatualizado entre varreduras
   * (a tarefa muda quando o processo é despachado), por isso é
   * mantido como informação "best-effort".
   */
  id_task_instance?: number | null;
  vara_id?: string | null; // configurado nas opções; texto livre

  // Audit
  pje_origem: PjeOrigemMap;
  ultima_sincronizacao_pje?: string | null;
  servidor_responsavel?: string | null;
  criado_em: string;
  atualizado_em: string;

  /**
   * Réus do processo. Inline aqui (no objeto principal) quando lido em
   * massa do store; no IndexedDB ficam em object store separado para
   * permitir índices.
   */
  reus: Reu[];
}

export type ProcessoPayload = Omit<
  Processo,
  | 'id'
  | 'pje_origem'
  | 'ultima_sincronizacao_pje'
  | 'criado_em'
  | 'atualizado_em'
  | 'reus'
>;

// ── Dados extraídos via IA (PDF) ────────────────────────────────

/**
 * Campos que a IA pode extrair de um PDF da denúncia / sentença.
 * Subset de `Processo` + `Reu`. `pena_maxima_abstrato` fica de fora —
 * é definição legal (Art. 109 CP), não consta no processo.
 */
export interface DadosPdf {
  // Processo
  numero_processo?: string;
  tipo_crime?: string;
  data_fato?: string;
  data_recebimento_denuncia?: string;
  // Réu — identificação
  nome_reu?: string;
  cpf_reu?: string;
  data_nascimento?: string;
  // Réu — prescrição
  pena_aplicada_concreto?: number;
  data_sentenca?: string;
  suspenso_366?: boolean;
  data_inicio_suspensao?: string;
  data_fim_suspensao?: string;
  // Réu — ANPP
  status_anpp?: StatusAnpp;
  numero_seeu?: string;
  data_homologacao_anpp?: string;
  data_remessa_mpf?: string;
  data_protocolo_seeu?: string;
  // Réu — SERP
  ultima_consulta_serp?: string;
  resultado_serp?: ResultadoSerp;
  serp_inquerito?: boolean;
  serp_denuncia?: boolean;
  serp_sentenca?: boolean;
  serp_guia?: boolean;
}

// ── Configuração local ──────────────────────────────────────────

/**
 * Configurações do perfil Gestão Criminal, persistidas em
 * `chrome.storage.local`.
 *
 * Postura de segurança alinhada às demais stores do paidegua (peritos,
 * etiquetas, templates): texto puro, confiando na autenticação do SO da
 * estação institucional. Cifragem opcional fica reservada para o arquivo
 * de export (Fase 6), onde o artefato sai da máquina.
 */
export type PeriodicidadeAutoExport = 'desligado' | 'diario' | 'semanal';

export interface UltimoExportStatus {
  /** ISO timestamp da tentativa. */
  ts: string;
  /** `true` se o arquivo foi gravado com sucesso. */
  ok: boolean;
  /** Mensagem humana — sucesso traz nome do arquivo; falha traz motivo. */
  mensagem?: string;
  /** Nome do arquivo gravado (presente quando ok=true). */
  arquivo?: string;
  /** Como foi disparado: agendamento, botão "Exportar agora" ou outro. */
  origem?: 'agendamento' | 'manual';
}

export interface CriminalConfig {
  schemaVersion: 1;
  /** Identificação livre do servidor (matrícula/email) — vai em audit. */
  servidor_responsavel?: string;
  /** Nome/código da vara para agrupamento (rótulo livre). */
  vara_id?: string;
  /**
   * Subset de classes ativas para varredura. Se omisso, usa
   * `CODIGOS_PRIMARIOS` da `criminal-classes.ts`.
   */
  classes_ativas?: readonly number[];
  /** Última varredura PJe bem-sucedida. */
  ultima_varredura?: string;
  /** Quando foi feito o último export — usado para alerta de 7 dias. */
  ultimo_export?: string;
  /**
   * Periodicidade do auto-export agendado. `'desligado'` = não roda
   * (default). `'diario'` = todo dia no `auto_export_horario`.
   * `'semanal'` = uma vez por semana, no mesmo dia da semana e horário.
   */
  auto_export_periodicidade?: PeriodicidadeAutoExport;
  /**
   * Horário do agendamento no formato local `HH:MM` (24h). Default
   * sugerido: `'19:00'` (final do expediente).
   */
  auto_export_horario?: string;
  /** Status da última tentativa de export (sucesso ou falha). */
  ultimo_export_status?: UltimoExportStatus;
}

export function emptyCriminalConfig(): CriminalConfig {
  return {
    schemaVersion: 1
  };
}

// ── Resultado de operações do store ─────────────────────────────

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ── Snapshot agregado para o dashboard ──────────────────────────

/**
 * Forma do payload entregue ao dashboard. Cada par (processo, réu) é
 * "expandido" do mesmo jeito que o sigcrim faz na page principal.
 */
export interface DashboardSnapshot {
  geradoEm: string;
  totalProcessos: number;
  totalReus: number;
  processos: Processo[]; // sempre populados com `reus`
}
