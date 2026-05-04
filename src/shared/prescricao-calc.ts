/**
 * Cálculo de prescrição penal por réu (Código Penal Brasileiro,
 * arts. 109, 110, 115, 117, 118).
 *
 * Esta v1.1 cobre os casos majoritários da JFCE. Não cobre:
 *   - Prescrição da pretensão executória pós-trânsito (foco aqui é
 *     pretensão punitiva — antes do trânsito).
 *   - Crime continuado / concurso de crimes (cada crime tem prazo
 *     independente — aqui usamos a pena máxima do crime principal).
 *
 * Regras implementadas:
 *
 *   1. **Tabela de prazos (CP art. 109)**, baseada na pena máxima:
 *      - Pena > 12 anos          → 20 anos
 *      - Pena > 8 e ≤ 12 anos    → 16 anos
 *      - Pena > 4 e ≤ 8 anos     → 12 anos
 *      - Pena > 2 e ≤ 4 anos     →  8 anos
 *      - Pena > 1 e ≤ 2 anos     →  4 anos
 *      - Pena ≤ 1 ano            →  3 anos
 *
 *   2. **Marco interruptivo (CP art. 117)**:
 *      - Antes da sentença → recebimento da denúncia (`data_recebimento_denuncia`).
 *      - Depois da sentença condenatória recorrível → publicação
 *        da sentença (`data_sentenca`).
 *
 *   3. **Pena base do cálculo**:
 *      - Antes da sentença → pena máxima abstrata (CP do crime).
 *      - Depois da sentença → pena aplicada concreta (CP art. 110, §1º).
 *
 *   4. **Reincidência (CP art. 110, caput)**: aumenta o prazo
 *      prescricional em 1/3. Aplicada apenas após sentença
 *      condenatória — antes da sentença não há reincidência
 *      reconhecida. Marcação manual no campo `reincidente` do `Reu`.
 *
 *   5. **Redução pela idade (CP art. 115)**: reduz à metade os
 *      prazos quando o réu, ao tempo do CRIME, era menor de 21 anos
 *      OU, na data da SENTENÇA, era maior de 70 anos. Calculada a
 *      partir de `data_nascimento` + (`data_fato` ou `data_sentenca`).
 *
 *   Ordem de aplicação dos ajustes (entendimento majoritário):
 *   prazo CP 109 → +1/3 (reincidência) → ÷2 (idade). A redução por
 *   idade incide sobre o prazo já com aumento.
 *
 *   6. **Suspensão CPP 366**: período entre `data_inicio_suspensao` e
 *      `data_fim_suspensao` (ou hoje, se ainda aberto) é **descontado**
 *      do tempo decorrido. Equivale a "parar o relógio" — réu citado
 *      por edital, processo suspenso, prescrição não corre.
 *
 * Status devolvido:
 *   - `verde`     → > 12 meses até prescrever
 *   - `amarelo`   → 6 a 12 meses
 *   - `vermelho`  → ≤ 6 meses ou já prescrito (calcular prioridade!)
 *   - `dados_insuficientes` → falta pena máxima/aplicada e/ou marco
 *
 * Função pura — não acessa IDB. Use os dados do `Reu` + `Processo`
 * que vêm do dashboard.
 */

export type StatusPrescricao =
  | 'verde'
  | 'amarelo'
  | 'vermelho'
  | 'dados_insuficientes';

export interface AjustePrescricao {
  /** Tipo do ajuste aplicado ao prazo CP 109. */
  tipo: 'reincidencia' | 'idade-menor-21' | 'idade-maior-70';
  /** Multiplicador aplicado (4/3 para reincidência, 1/2 para idade). */
  fator: number;
  /** Descrição humana ("+1/3 reincidência", "÷2 idade <21 ao tempo do crime"). */
  rotulo: string;
}

export interface ResultadoPrescricao {
  status: StatusPrescricao;
  /** Data ISO em que prescreve (YYYY-MM-DD), ou `null` se status_insuficiente. */
  dataLimite: string | null;
  /** Dias até prescrever. Negativo se já prescreveu. `null` se insuficiente. */
  diasRestantes: number | null;
  /** Pena considerada no cálculo (em meses), ou `null`. */
  penaConsideradaMeses: number | null;
  /** Marco interruptivo usado (data ISO). */
  marcoInterruptivo: { tipo: 'recebimento' | 'sentenca'; data: string } | null;
  /**
   * Prazo prescricional CP 109 base — antes de aplicar ajustes de
   * reincidência ou idade. Útil pra mostrar a tabela original no UI.
   */
  prazoBaseMeses: number | null;
  /**
   * Prazo prescricional FINAL aplicado (em meses), após reincidência
   * e/ou idade. Igual a `prazoBaseMeses` quando não há ajuste.
   */
  prazoPrescricionalMeses: number | null;
  /** Lista dos ajustes aplicados (vazia quando nenhum incide). */
  ajustes: AjustePrescricao[];
  /** Dias adicionados ao prazo por suspensão CPP 366 (se houver). */
  diasSuspensos: number;
  /** Mensagem humana sobre o que falta, se status='dados_insuficientes'. */
  motivoIncompleto?: string;
}

/**
 * Entrada compacta para o cálculo. Aceita os campos diretamente
 * vindos do `Reu` + `Processo` do IDB. Todos opcionais — função
 * é tolerante e devolve `dados_insuficientes` quando falta.
 */
export interface InputPrescricao {
  // Pena (em meses)
  pena_maxima_abstrato?: number | null;
  pena_aplicada_concreto?: number | null;
  // Marcos
  data_fato?: string | null;
  data_recebimento_denuncia?: string | null;
  data_sentenca?: string | null;
  // Suspensão CPP 366
  suspenso_366?: boolean;
  data_inicio_suspensao?: string | null;
  data_fim_suspensao?: string | null;
  // Ajustes CP 110 / CP 115
  reincidente?: boolean;
  data_nascimento?: string | null;
}

/**
 * Tabela CP art. 109 — pena máxima (em meses) → prazo prescricional
 * (em meses). A função usa busca linear porque são 6 entradas.
 */
function prazoPrescricionalCP109(penaMeses: number): number {
  if (penaMeses > 144) return 20 * 12; // > 12 anos → 20 anos
  if (penaMeses > 96) return 16 * 12; // > 8 a 12 → 16 anos
  if (penaMeses > 48) return 12 * 12; // > 4 a 8  → 12 anos
  if (penaMeses > 24) return 8 * 12; //  > 2 a 4  →  8 anos
  if (penaMeses > 12) return 4 * 12; //  > 1 a 2  →  4 anos
  return 3 * 12; // ≤ 1 ano → 3 anos
}

function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    0,
    0,
    0,
    0
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function diasEntre(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

function adicionarMeses(d: Date, meses: number): Date {
  const novo = new Date(d.getTime());
  novo.setMonth(novo.getMonth() + meses);
  return novo;
}

/**
 * Idade completa (anos) entre `nascimento` e `referencia`. Considera
 * mês/dia para descontar aniversário ainda não atingido na data de
 * referência. Devolve `null` quando faltam dados.
 */
function idadeAnosNaData(
  dataNascimento: string | null | undefined,
  dataReferencia: string | null | undefined
): number | null {
  const nasc = parseIso(dataNascimento);
  const ref = parseIso(dataReferencia);
  if (!nasc || !ref) return null;
  let anos = ref.getFullYear() - nasc.getFullYear();
  const mesDelta = ref.getMonth() - nasc.getMonth();
  const diaDelta = ref.getDate() - nasc.getDate();
  if (mesDelta < 0 || (mesDelta === 0 && diaDelta < 0)) anos -= 1;
  return anos;
}

export function calcularPrescricao(input: InputPrescricao): ResultadoPrescricao {
  const sentencaDate = parseIso(input.data_sentenca);
  const recebimentoDate = parseIso(input.data_recebimento_denuncia);
  const temSentenca = sentencaDate !== null;

  // Escolha do marco interruptivo (CP art. 117)
  const marco = temSentenca
    ? sentencaDate
    : recebimentoDate;
  if (!marco) {
    return {
      status: 'dados_insuficientes',
      dataLimite: null,
      diasRestantes: null,
      penaConsideradaMeses: null,
      marcoInterruptivo: null,
      prazoBaseMeses: null,
      prazoPrescricionalMeses: null,
      ajustes: [],
      diasSuspensos: 0,
      motivoIncompleto: temSentenca
        ? 'sem data da sentença'
        : 'sem data de recebimento da denúncia (e sem sentença)'
    };
  }

  // Pena base (CP art. 110, §1º): após sentença, usa pena concreta;
  // antes, usa pena máxima abstrata.
  const penaConsiderada = temSentenca
    ? input.pena_aplicada_concreto ?? null
    : input.pena_maxima_abstrato ?? null;

  if (!penaConsiderada || penaConsiderada <= 0) {
    return {
      status: 'dados_insuficientes',
      dataLimite: null,
      diasRestantes: null,
      penaConsideradaMeses: null,
      marcoInterruptivo: {
        tipo: temSentenca ? 'sentenca' : 'recebimento',
        data: toIso(marco)
      },
      prazoBaseMeses: null,
      prazoPrescricionalMeses: null,
      ajustes: [],
      diasSuspensos: 0,
      motivoIncompleto: temSentenca
        ? 'sem pena aplicada concreta (em meses)'
        : 'sem pena máxima abstrata do crime (em meses)'
    };
  }

  const prazoBaseMeses = prazoPrescricionalCP109(penaConsiderada);
  const ajustes: AjustePrescricao[] = [];
  let prazoMeses = prazoBaseMeses;

  // CP 110 caput — reincidência aumenta o prazo prescricional em 1/3.
  // Aplicada apenas após sentença condenatória; antes não há
  // reincidência reconhecida.
  if (input.reincidente && temSentenca) {
    prazoMeses = prazoMeses * 4 / 3;
    ajustes.push({
      tipo: 'reincidencia',
      fator: 4 / 3,
      rotulo: '+1/3 reincidência (CP 110)'
    });
  }

  // CP 115 — réu menor de 21 ao tempo do crime: reduz à metade.
  // Referência: data_fato (preferencial) ou data_recebimento_denuncia
  // como aproximação (a denúncia é normalmente ofertada perto do fato
  // em ações de crimes recentes).
  const refMenor21 =
    input.data_fato ?? input.data_recebimento_denuncia ?? null;
  const idadeAoCrime = idadeAnosNaData(input.data_nascimento, refMenor21);
  if (idadeAoCrime != null && idadeAoCrime < 21) {
    prazoMeses = prazoMeses / 2;
    ajustes.push({
      tipo: 'idade-menor-21',
      fator: 1 / 2,
      rotulo: `÷2 menor de 21 ao tempo do crime (${idadeAoCrime} anos)`
    });
  }

  // CP 115 — réu maior de 70 na data da sentença: reduz à metade.
  // Só aplica se a redução por idade <21 já não tiver incidido (a lei
  // prevê alternativa: "menor de 21 ao tempo do crime OU maior de 70
  // na data da sentença"). A jurisprudência majoritária permite só
  // uma das reduções.
  if (
    temSentenca &&
    !ajustes.some((a) => a.tipo === 'idade-menor-21')
  ) {
    const idadeNaSentenca = idadeAnosNaData(
      input.data_nascimento,
      input.data_sentenca
    );
    if (idadeNaSentenca != null && idadeNaSentenca > 70) {
      prazoMeses = prazoMeses / 2;
      ajustes.push({
        tipo: 'idade-maior-70',
        fator: 1 / 2,
        rotulo: `÷2 maior de 70 na sentença (${idadeNaSentenca} anos)`
      });
    }
  }

  // Arredondamento: o prazo é em meses; reincidência fracionada
  // (4/3) gera valor não-inteiro. Usamos `Math.floor` para favorecer
  // o réu (prazo menor → prescreve antes), entendimento doutrinário
  // mais comum quando há divergência sobre arredondamento.
  prazoMeses = Math.floor(prazoMeses);

  const dataLimiteSemSusp = adicionarMeses(marco, prazoMeses);

  // Suspensão CPP 366: descontamos o período (efeito = somar à data limite).
  let diasSuspensos = 0;
  if (input.suspenso_366 && input.data_inicio_suspensao) {
    const ini = parseIso(input.data_inicio_suspensao);
    const fim =
      parseIso(input.data_fim_suspensao) ?? new Date(); // se aberto, conta até hoje
    if (ini && fim && fim.getTime() > ini.getTime()) {
      diasSuspensos = diasEntre(ini, fim);
    }
  }

  const dataLimite = new Date(
    dataLimiteSemSusp.getTime() + diasSuspensos * 86_400_000
  );
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const diasRestantes = diasEntre(hoje, dataLimite);

  let status: StatusPrescricao;
  if (diasRestantes < 180) status = 'vermelho'; // < 6 meses (ou já passou)
  else if (diasRestantes < 365) status = 'amarelo'; // 6-12 meses
  else status = 'verde';

  return {
    status,
    dataLimite: toIso(dataLimite),
    diasRestantes,
    penaConsideradaMeses: penaConsiderada,
    marcoInterruptivo: {
      tipo: temSentenca ? 'sentenca' : 'recebimento',
      data: toIso(marco)
    },
    prazoBaseMeses,
    prazoPrescricionalMeses: prazoMeses,
    ajustes,
    diasSuspensos
  };
}

/**
 * Status agregado do processo (réu mais "à frente" no farol).
 * Vermelho > Amarelo > Verde > Insuficiente.
 */
export function statusPrescricaoAgregado(
  resultados: readonly ResultadoPrescricao[]
): StatusPrescricao {
  if (resultados.some((r) => r.status === 'vermelho')) return 'vermelho';
  if (resultados.some((r) => r.status === 'amarelo')) return 'amarelo';
  if (resultados.some((r) => r.status === 'verde')) return 'verde';
  return 'dados_insuficientes';
}

/**
 * Texto humano do status — usado em badges e tooltips.
 */
export const LABEL_STATUS_PRESCRICAO: Record<StatusPrescricao, string> = {
  verde: 'Sem risco',
  amarelo: 'Atenção',
  vermelho: 'Risco iminente',
  dados_insuficientes: 'Dados incompletos'
};

/**
 * Formata `diasRestantes` em string humana ("3 anos e 4 meses" /
 * "120 dias" / "PRESCRITO há 30 dias"). Útil em tooltip.
 */
export function formatarTempoRestante(diasRestantes: number): string {
  if (diasRestantes < 0) {
    const dias = Math.abs(diasRestantes);
    if (dias < 60) return `prescrito há ${dias} dia(s)`;
    const meses = Math.floor(dias / 30);
    return `prescrito há ${meses} mês(es)`;
  }
  if (diasRestantes < 60) return `${diasRestantes} dia(s) restantes`;
  const meses = Math.floor(diasRestantes / 30);
  if (meses < 24) return `~${meses} mês(es) restantes`;
  const anos = Math.floor(meses / 12);
  const mesesResto = meses % 12;
  return mesesResto === 0
    ? `~${anos} ano(s) restantes`
    : `~${anos} ano(s) e ${mesesResto} mês(es)`;
}
