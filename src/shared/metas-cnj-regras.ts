/**
 * Aplicador de regras das Metas Nacionais 2026 (CNJ).
 *
 * Função pura que recebe um `ProcessoMetasCnj` + `MetasCnjConfig` e
 * devolve a lista de metas aplicáveis ao processo. As regras aqui
 * implementadas refletem o texto das Metas Nacionais 2026 aprovadas no
 * 19º ENPJ (Florianópolis/SC, 1-2 dez/2025) para a JF 1G TRF5.
 *
 * Princípio: as regras são DECLARATIVAS (uma função por meta), o que
 * facilita revisar/auditar contra o texto da norma. Cada função recebe
 * o processo + a config da meta e devolve `true` se enquadra.
 *
 * O override manual (`processo.meta_override_manual[metaId]`) sempre
 * vence: `true` força inclusão; `false` força exclusão.
 */

import type {
  ConfigMetaIndividual,
  MetaCnjId,
  MetasCnjConfig,
  ProcessoMetasCnj
} from './metas-cnj-types';
import { META_CNJ_IDS } from './metas-cnj-types';

// =====================================================================
// Helpers
// =====================================================================

/** Match case-insensitive de substring. */
function contemCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** True se o assunto do processo bate com algum item da lista (substring CI). */
function assuntoBate(
  assuntoProcesso: string | null,
  assuntosElegiveis: readonly string[]
): boolean {
  if (assuntosElegiveis.length === 0) return true; // vazio = qualquer assunto
  if (!assuntoProcesso) return false;
  return assuntosElegiveis.some((a) => contemCI(assuntoProcesso, a));
}

/** True se a sigla da classe está na lista (match exato CI). */
function classeBate(
  classeProcesso: string,
  classesElegiveis: readonly string[]
): boolean {
  if (classesElegiveis.length === 0) return true; // vazio = qualquer classe
  const c = classeProcesso.trim().toUpperCase();
  return classesElegiveis.some((x) => x.trim().toUpperCase() === c);
}

/**
 * True se a data do processo é menor ou igual à data de corte (ambas
 * em ISO `YYYY-MM-DD`). Comparação lexicográfica funciona para esse
 * formato.
 */
function dataDistribuicaoAteCorte(
  dataDistribuicao: string | null,
  dataCorte: string
): boolean {
  if (!dataDistribuicao) return false; // sem data → não incluir (defensivo)
  if (!dataCorte) return false; // sem corte → conservador, não incluir
  return dataDistribuicao <= dataCorte;
}

// =====================================================================
// Regras por meta
// =====================================================================

/**
 * Meta 2 — Antigos: distribuídos até a data de corte.
 *
 * Texto: "Justiça Federal: todos os processos distribuídos há 15 anos
 * (2011) e 85% dos processos distribuídos até 31/12/2022 no 1º e 2º grau;
 * e 100% dos processos distribuídos até 31/12/2023 nos JEFs e TRs."
 *
 * Implementação: incluir o processo se `data_distribuicao <= dataCorte`.
 * O painel pode ser configurado com diferentes datas de corte para cada
 * "faixa" da meta (15 anos, 31/12/2022, 31/12/2023). Default é a faixa
 * mais ampla (31/12/2022 — cobre os 15 anos automaticamente).
 *
 * Note: a regra do JEF (até 31/12/2023) cobre processos mais novos. O
 * painel atual usa UMA data de corte; o usuário ajusta na configuração
 * conforme o tipo de vara (JEF vs comum).
 */
function aplicaMeta2(
  p: ProcessoMetasCnj,
  c: ConfigMetaIndividual
): boolean {
  return dataDistribuicaoAteCorte(p.data_distribuicao, c.dataCorte);
}

/**
 * Meta 4 — Improbidade + crimes Adm. Pública.
 *
 * Texto: "Justiça Federal: 85% das ações de improbidade administrativa
 * e 85% das ações penais relativas aos crimes contra a Administração
 * Pública distribuídas até 31/12/2023."
 *
 * Implementação: data_distribuicao <= dataCorte AND classe está em
 * `classesElegiveis` (ex.: ProcAd, APN, AcrPen, ImpAdm) OR assunto
 * em `assuntosElegiveis` (categorias CNJ correspondentes).
 *
 * Lógica AND vs OR entre classe/assunto: usamos OR — se a classe é
 * elegível OU o assunto é elegível, o processo entra. Isso porque há
 * processos cuja classe é genérica (Procedimento Comum) mas o assunto
 * é específico (ex.: "Improbidade Administrativa") e vice-versa.
 */
function aplicaMeta4(
  p: ProcessoMetasCnj,
  c: ConfigMetaIndividual
): boolean {
  if (!dataDistribuicaoAteCorte(p.data_distribuicao, c.dataCorte)) return false;
  const classeOk = classeBate(p.classe_sigla, c.classesElegiveis);
  const assuntoOk = assuntoBate(p.assunto_principal, c.assuntosElegiveis);
  // Se ambas listas estão vazias (config padrão), não há filtro semântico
  // — recusamos por segurança. Para Meta 4 o usuário PRECISA configurar
  // ao menos uma das listas.
  if (c.classesElegiveis.length === 0 && c.assuntosElegiveis.length === 0) {
    return false;
  }
  return classeOk || assuntoOk;
}

/**
 * Meta 6 — Ambientais.
 *
 * Texto (Faixa 2 = TRF5): "38% dos processos que tenham por objeto
 * matéria ambiental, distribuídos até 31/12/2025."
 *
 * Implementação: data_distribuicao <= dataCorte AND assunto bate com
 * lista de assuntos ambientais (CNJ).
 */
function aplicaMeta6(
  p: ProcessoMetasCnj,
  c: ConfigMetaIndividual
): boolean {
  if (!dataDistribuicaoAteCorte(p.data_distribuicao, c.dataCorte)) return false;
  if (c.assuntosElegiveis.length === 0) return false; // sem lista = não incluir
  return assuntoBate(p.assunto_principal, c.assuntosElegiveis);
}

/**
 * Meta 7 — Indígenas, quilombolas, racismo/injúria racial.
 *
 * Texto (Faixa 2 = TRF5): "35% dos processos relacionados aos direitos
 * das comunidades indígenas, 35% dos processos relacionados aos direitos
 * das comunidades quilombolas, e 50% dos processos relacionados ao
 * crime de racismo e de injúria racial, distribuídos até 31/12/2025."
 *
 * Implementação: data_distribuicao <= dataCorte AND assunto bate com
 * lista (que cobre os 3 grupos — o usuário pode separar em sub-metas no
 * futuro se quiser percentuais distintos).
 */
function aplicaMeta7(
  p: ProcessoMetasCnj,
  c: ConfigMetaIndividual
): boolean {
  if (!dataDistribuicaoAteCorte(p.data_distribuicao, c.dataCorte)) return false;
  if (c.assuntosElegiveis.length === 0) return false;
  return assuntoBate(p.assunto_principal, c.assuntosElegiveis);
}

/**
 * Meta 10 — Subtração internacional de crianças.
 *
 * Texto: "Justiça Federal: 100% dos casos de subtração internacional
 * de crianças distribuídos até 31/12/2025, em cada uma das instâncias."
 *
 * Implementação: data_distribuicao <= dataCorte AND assunto contém
 * "subtração internacional de crianças".
 */
function aplicaMeta10(
  p: ProcessoMetasCnj,
  c: ConfigMetaIndividual
): boolean {
  if (!dataDistribuicaoAteCorte(p.data_distribuicao, c.dataCorte)) return false;
  if (c.assuntosElegiveis.length === 0) return false;
  return assuntoBate(p.assunto_principal, c.assuntosElegiveis);
}

const APLICADORES: Record<
  MetaCnjId,
  (p: ProcessoMetasCnj, c: ConfigMetaIndividual) => boolean
> = {
  'meta-2': aplicaMeta2,
  'meta-4': aplicaMeta4,
  'meta-6': aplicaMeta6,
  'meta-7': aplicaMeta7,
  'meta-10': aplicaMeta10
};

// =====================================================================
// Função pública
// =====================================================================

/**
 * Calcula as metas aplicáveis a um processo dado o snapshot atual e a
 * configuração do módulo. Considera override manual.
 *
 * Função pura — não acessa banco nem rede.
 */
export function calcularMetasAplicaveis(
  processo: ProcessoMetasCnj,
  config: MetasCnjConfig
): MetaCnjId[] {
  const aplicaveis: MetaCnjId[] = [];

  for (const metaId of META_CNJ_IDS) {
    // Override manual sempre vence
    const override = processo.meta_override_manual[metaId];
    if (override === true) {
      aplicaveis.push(metaId);
      continue;
    }
    if (override === false) {
      continue; // exclusão explícita
    }

    // Caminho normal: a meta precisa estar ativada na config
    const cfg = config.metas[metaId];
    if (!cfg.ativada) continue;

    if (APLICADORES[metaId](processo, cfg)) {
      aplicaveis.push(metaId);
    }
  }

  return aplicaveis;
}
