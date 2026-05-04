/**
 * Cálculo de gestão (cumprimento) de ANPP por réu.
 *
 * Complementa o farol de prescrição: enquanto a prescrição diz
 * "quanto tempo eu tenho até perder o caso", a gestão de ANPP diz
 * "quem precisa de cobrança esta semana".
 *
 * O ANPP percorre, no caso típico da JFCE, o seguinte ciclo:
 *
 *   Em Negociacao  →  Homologado  →  Remetido MPF  →  Protocolado SEEU
 *                                                  ↓
 *                                          Em Execucao SEEU  →  Cumprido
 *                                                  ↓
 *                                          Execucao Vara   →  Cumprido
 *
 * O "tempo apertado" aparece em dois pontos:
 *
 *   1. **Pós-homologação sem protocolo no SEEU**: depois de
 *      homologado, o MPF leva o termo ao SEEU. Se passa muito tempo
 *      sem `data_protocolo_seeu`, o servidor da vara precisa cobrar.
 *   2. **Comprovação periódica de cumprimento**: enquanto está em
 *      execução (SEEU ou vara), o réu precisa comprovar cumprimento
 *      a cada N dias (por padrão 30 — mensal). Se passa do prazo sem
 *      `ultima_comprovacao_anpp` atualizada, é atraso.
 *
 * Função pura — não acessa IDB. Usa `Reu.status_anpp` + datas.
 */
import type { StatusAnpp } from './criminal-types';

export type StatusGestaoAnpp =
  | 'em_dia'
  | 'proximo'              // 0-7 dias até próxima comprovação
  | 'atrasado'             // próxima comprovação venceu
  | 'pendente_protocolo'   // Homologado/Remetido MPF há tempo sem SEEU
  | 'cumprido'
  | 'nao_aplicavel';

export interface InputGestaoAnpp {
  status_anpp: StatusAnpp;
  data_homologacao_anpp?: string | null;
  data_remessa_mpf?: string | null;
  data_protocolo_seeu?: string | null;
  ultima_comprovacao_anpp?: string | null;
  /** Periodicidade da comprovação em dias. Default 30 (mensal). */
  periodicidade_dias?: number;
  /**
   * Tolerância (em dias) entre homologação/remessa e protocolo no
   * SEEU antes de classificar como `pendente_protocolo`. Default 60.
   */
  tolerancia_protocolo_dias?: number;
}

export interface ResultadoGestaoAnpp {
  status: StatusGestaoAnpp;
  /** Próxima comprovação esperada (ISO YYYY-MM-DD). `null` quando não aplicável. */
  proximaComprovacao: string | null;
  /** Dias até a próxima (negativo se atrasado). `null` se não aplicável. */
  diasParaProxima: number | null;
  /** Última comprovação efetiva considerada. `null` se nunca houve. */
  ultimaConsiderada: string | null;
  /** Mensagem humana (tooltip/sidebar). */
  motivo: string;
}

const DIA = 86_400_000;

function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    0, 0, 0, 0
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
  return Math.floor((b.getTime() - a.getTime()) / DIA);
}

function adicionarDias(d: Date, dias: number): Date {
  return new Date(d.getTime() + dias * DIA);
}

function hojeMeiaNoite(): Date {
  const h = new Date();
  h.setHours(0, 0, 0, 0);
  return h;
}

/** Status que estão em execução (precisam comprovação periódica). */
const STATUS_EM_EXECUCAO: ReadonlySet<StatusAnpp> = new Set([
  'Protocolado SEEU',
  'Em Execucao SEEU',
  'Execucao Vara'
]);

/** Status pré-execução (homologado mas ainda não em SEEU). */
const STATUS_AGUARDANDO_PROTOCOLO: ReadonlySet<StatusAnpp> = new Set([
  'Homologado',
  'Remetido MPF'
]);

export function calcularGestaoAnpp(input: InputGestaoAnpp): ResultadoGestaoAnpp {
  const periodicidade = input.periodicidade_dias ?? 30;
  const tolerancia = input.tolerancia_protocolo_dias ?? 60;

  // Casos terminais — cumprido / não aplicável.
  if (input.status_anpp === 'Cumprido') {
    return {
      status: 'cumprido',
      proximaComprovacao: null,
      diasParaProxima: null,
      ultimaConsiderada: input.ultima_comprovacao_anpp ?? null,
      motivo: 'ANPP cumprido — sem comprovações pendentes.'
    };
  }
  if (input.status_anpp === 'Nao Aplicavel') {
    return {
      status: 'nao_aplicavel',
      proximaComprovacao: null,
      diasParaProxima: null,
      ultimaConsiderada: null,
      motivo: 'ANPP não aplicável a este réu.'
    };
  }
  if (input.status_anpp === 'Em Negociacao') {
    return {
      status: 'nao_aplicavel',
      proximaComprovacao: null,
      diasParaProxima: null,
      ultimaConsiderada: null,
      motivo: 'ANPP em negociação — sem cumprimento ainda.'
    };
  }

  const hoje = hojeMeiaNoite();

  // Aguardando protocolo no SEEU: vira pendente_protocolo se a
  // homologação/remessa já passou da tolerância.
  if (STATUS_AGUARDANDO_PROTOCOLO.has(input.status_anpp)) {
    const marco =
      parseIso(input.data_remessa_mpf) ?? parseIso(input.data_homologacao_anpp);
    if (!marco) {
      return {
        status: 'nao_aplicavel',
        proximaComprovacao: null,
        diasParaProxima: null,
        ultimaConsiderada: null,
        motivo:
          input.status_anpp === 'Homologado'
            ? 'Homologado, mas sem data de homologação registrada.'
            : 'Remetido ao MPF, mas sem data de remessa registrada.'
      };
    }
    const dias = diasEntre(marco, hoje);
    if (dias > tolerancia) {
      return {
        status: 'pendente_protocolo',
        proximaComprovacao: null,
        diasParaProxima: null,
        ultimaConsiderada: toIso(marco),
        motivo:
          input.status_anpp === 'Homologado'
            ? `Homologado há ${dias} dia(s) e ainda sem protocolo no SEEU — cobre o MPF.`
            : `Remetido ao MPF há ${dias} dia(s) sem protocolo no SEEU — cobre o MPF.`
      };
    }
    // Dentro da tolerância — ainda não é prazo de cobrança.
    return {
      status: 'em_dia',
      proximaComprovacao: null,
      diasParaProxima: null,
      ultimaConsiderada: toIso(marco),
      motivo:
        input.status_anpp === 'Homologado'
          ? `Homologado há ${dias} dia(s) — aguardando protocolo no SEEU.`
          : `Remetido ao MPF há ${dias} dia(s) — aguardando protocolo.`
    };
  }

  // Em execução — comprovação periódica.
  if (STATUS_EM_EXECUCAO.has(input.status_anpp)) {
    // Marco preferido: última comprovação. Fallback: data do protocolo SEEU.
    const ultima = parseIso(input.ultima_comprovacao_anpp);
    const protocolo = parseIso(input.data_protocolo_seeu);
    const marco = ultima ?? protocolo;

    if (!marco) {
      // Em execução sem data alguma — trata como atrasado, sinalizando o
      // que precisa preencher para o farol funcionar.
      return {
        status: 'atrasado',
        proximaComprovacao: null,
        diasParaProxima: null,
        ultimaConsiderada: null,
        motivo:
          'Em execução, mas sem data de protocolo SEEU nem última comprovação — preencha para acompanhar o cumprimento.'
      };
    }

    const proxima = adicionarDias(marco, periodicidade);
    const dias = diasEntre(hoje, proxima);
    let status: StatusGestaoAnpp;
    let motivo: string;
    const baseMarco = ultima ? 'última comprovação' : 'protocolo SEEU';
    if (dias < 0) {
      status = 'atrasado';
      const atraso = Math.abs(dias);
      motivo =
        atraso === 1
          ? `Comprovação atrasada em 1 dia (${baseMarco} em ${toIso(marco)}).`
          : `Comprovação atrasada em ${atraso} dias (${baseMarco} em ${toIso(marco)}).`;
    } else if (dias <= 7) {
      status = 'proximo';
      motivo =
        dias === 0
          ? `Comprovação vence hoje (${baseMarco} em ${toIso(marco)}).`
          : `Comprovação vence em ${dias} dia(s) (${baseMarco} em ${toIso(marco)}).`;
    } else {
      status = 'em_dia';
      motivo = `Próxima comprovação em ${dias} dia(s) (${baseMarco} em ${toIso(marco)}).`;
    }
    return {
      status,
      proximaComprovacao: toIso(proxima),
      diasParaProxima: dias,
      ultimaConsiderada: toIso(marco),
      motivo
    };
  }

  // Cobertura total dos status do enum — essa linha é unreachable
  // sob o type checker, mas mantemos para segurança em runtime.
  return {
    status: 'nao_aplicavel',
    proximaComprovacao: null,
    diasParaProxima: null,
    ultimaConsiderada: null,
    motivo: 'Status ANPP não tratado pela gestão.'
  };
}

/**
 * Status agregado do processo (réu mais "à frente" no farol de
 * cobrança). Atrasado > Pendente protocolo > Próximo > Em dia >
 * Cumprido > Não aplicável.
 */
export function statusGestaoAnppAgregado(
  resultados: readonly ResultadoGestaoAnpp[]
): StatusGestaoAnpp {
  if (resultados.some((r) => r.status === 'atrasado')) return 'atrasado';
  if (resultados.some((r) => r.status === 'pendente_protocolo')) return 'pendente_protocolo';
  if (resultados.some((r) => r.status === 'proximo')) return 'proximo';
  if (resultados.some((r) => r.status === 'em_dia')) return 'em_dia';
  if (resultados.some((r) => r.status === 'cumprido')) return 'cumprido';
  return 'nao_aplicavel';
}

/** Texto humano por status (badges/tooltips). */
export const LABEL_STATUS_GESTAO_ANPP: Record<StatusGestaoAnpp, string> = {
  em_dia: 'Em dia',
  proximo: 'Próximo do prazo',
  atrasado: 'Atrasado',
  pendente_protocolo: 'Pendente protocolo SEEU',
  cumprido: 'Cumprido',
  nao_aplicavel: 'Sem cumprimento'
};

/** Ícone unicode para cada status (consistente com o farol). */
export const ICONE_STATUS_GESTAO_ANPP: Record<StatusGestaoAnpp, string> = {
  em_dia: '🟢',
  proximo: '🟡',
  atrasado: '🔴',
  pendente_protocolo: '🟠',
  cumprido: '✓',
  nao_aplicavel: '⚪'
};
