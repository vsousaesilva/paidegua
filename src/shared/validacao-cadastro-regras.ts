/**
 * Motor de regras da "Validação de cadastro" (perfil Secretaria — item da
 * Triagem Inteligente ao lado de "Analisar tarefas").
 *
 * Aponta inconsistências no cadastro eletrônico dos processos das tarefas de
 * triagem, quanto ao Polo ativo, Polo passivo e Outros interessados, a partir
 * dos dados estruturados extraídos dos autos digitais.
 *
 * Este módulo é PURO e determinístico: recebe `ProcessoCadastro` (forma
 * desacoplada da camada de conteúdo) e devolve as irregularidades. Não faz
 * fetch, não toca no DOM, não chama IA — o que o torna trivialmente testável
 * e independente do PJe. O mapeamento `ParteExtraida` → `ParteCadastro` fica
 * no orquestrador (`content/triagem/validar-cadastro.ts`).
 *
 * Escopo (decisão de projeto): a regra "assunto processual incompatível com o
 * pedido da inicial" NÃO é avaliada aqui — exige leitura da petição inicial
 * (IA + documento) e é tratada fora do lote, sob demanda pelo "Analisar o
 * processo". Todas as demais hipóteses da proposta são determinísticas e
 * ficam implementadas neste motor.
 */

// =====================================================================
// Modelo de entrada (desacoplado de pje-api-partes.ts)
// =====================================================================

export type TipoParteCadastro =
  | 'AUTOR'
  | 'REU'
  | 'ADVOGADO'
  | 'REPRESENTANTE'
  | 'PROCURADORIA'
  | 'ORGAO_DE_CUMPRIMENTO'
  | 'OUTRO';

export type PoloCadastro = 'ATIVO' | 'PASSIVO' | 'OUTROS' | 'DESCONHECIDO';

export interface ParteCadastro {
  nome: string;
  tipo: TipoParteCadastro;
  polo: PoloCadastro;
  documentoTipo: 'CPF' | 'CNPJ' | 'OAB' | null;
  documentoNumero: string | null;
  /** Heurística: parte é ente/órgão público. */
  ehOrgaoPublico: boolean;
  /** Agrupa a parte principal e seus vínculos (mesmo `<td>` do HTML). */
  grupoId: number;
  /** `true` para a parte principal; `false` para vínculos (adv/rep/proc). */
  ehPrincipal: boolean;
}

export interface ProcessoCadastro {
  numeroProcesso: string;
  /** Assunto cadastrado (do cartão da tarefa). Guardado para o relatório. */
  assunto: string;
  /** Texto do valor da causa (ex.: "R$ 20.309,00"), `null` se ausente. */
  valorCausaTexto: string | null;
  partes: ParteCadastro[];
}

// =====================================================================
// Modelo de saída
// =====================================================================

export type GravidadeIrregularidade = 'alta' | 'media' | 'baixa';

/** Códigos estáveis das irregularidades — usados em UI, Excel e telemetria. */
export type IrregularidadeId =
  | 'mpf-ausente'
  | 'inss-cnpj-incorreto'
  | 'orgao-sem-procuradoria'
  | 'ceab-ausente'
  | 'ceab-cadastro-incorreto'
  | 'polo-passivo-vazio'
  | 'inss-terceiro-interessado'
  | 'cpf-autor-ausente'
  | 'representante-menor-ausente'
  | 'advogado-ausente'
  | 'representante-nao-autor'
  | 'valor-causa-ausente';

export interface IrregularidadeCadastro {
  id: IrregularidadeId;
  /** Rótulo curto para exibição em lista/etiqueta. */
  titulo: string;
  /** Descrição da inconsistência no processo concreto. */
  detalhe: string;
  gravidade: GravidadeIrregularidade;
}

export interface ResultadoValidacaoCadastro {
  status: 'ok' | 'irregular';
  irregularidades: IrregularidadeCadastro[];
}

// =====================================================================
// Constantes institucionais (CNPJs canônicos)
// =====================================================================

/**
 * Cadastro canônico dos entes com identificação conhecida. Fonte única da
 * verdade: usado tanto na detecção (comparação de CNPJ) quanto — na Fase 3 —
 * para a minuta de sentença apontar EXPLICITAMENTE qual é o cadastro correto
 * (ex.: "o INSS correto é ... CNPJ 29.979.036/0001-40 ..."). Exportado para
 * o gerador de minuta reaproveitar sem redigitar valores.
 */
export const ENTES_CANONICOS = {
  INSS: {
    nome: 'INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS',
    cnpj: '29.979.036/0001-40',
    procuradoria: 'Procuradoria Geral Federal (PGF/AGU)'
  },
  CEAB: {
    nome: 'CEAB-DJ INSS',
    cnpj: '29.979.036/0014-65',
    procuradoria: 'Procuradoria da CEAB-DJ INSS'
  },
  MPF: {
    nome: 'MINISTÉRIO PÚBLICO FEDERAL - MPF',
    cnpj: '26.989.715/0011-84'
  }
} as const;

/** INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS (CNPJ normalizado). */
const CNPJ_INSS = '29979036000140';
/** CEAB-DJ INSS (Central Especializada de Análise de Benefícios — cumprimento). */
const CNPJ_CEAB = '29979036001465';

// =====================================================================
// Helpers de identificação
// =====================================================================

function soDigitos(v: string | null | undefined): string {
  return (v ?? '').replace(/\D+/g, '');
}

/**
 * Autor menor identificado pela grafia por iniciais (proteção do nome de
 * menor no PJe), ex.: "L. C. A. D. S.". Considera menor quando o nome é uma
 * sequência de ao menos duas iniciais (uma letra, com ou sem ponto),
 * eventualmente com "de/da/dos" por extenso entre elas.
 */
export function ehNomeDeMenor(nome: string): boolean {
  const limpo = (nome ?? '').trim();
  if (!limpo) return false;
  const tokens = limpo.split(/\s+/);
  const conectivos = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
  let iniciais = 0;
  for (const tok of tokens) {
    const t = tok.toLowerCase().replace(/\.$/, '');
    if (conectivos.has(t)) continue;
    // Cada token relevante precisa ser uma única letra (inicial).
    if (/^[a-zà-ú]\.?$/i.test(tok)) {
      iniciais += 1;
      continue;
    }
    return false;
  }
  return iniciais >= 2;
}

function ehCEAB(nome: string): boolean {
  return /\bCEAB\b/i.test(nome);
}

/**
 * Identifica o INSS autarquia (réu). Atenção: "CEAB-DJ INSS" e
 * "Procuradoria da CEAB-DJ INSS" também contêm a sigla "INSS" — mas são a
 * central de cumprimento e sua procuradoria, não a autarquia. Por isso a
 * CEAB é explicitamente excluída, senão a CEAB regular em Outros
 * interessados seria apontada como "INSS cadastrado como terceiro".
 */
function ehINSS(nome: string): boolean {
  if (ehCEAB(nome)) return false;
  return /instituto nacional do seguro social|\bINSS\b/i.test(nome);
}

function ehMPF(nome: string): boolean {
  return /minist[ée]rio\s+p[úu]blico\s+federal|\bMPF\b/i.test(nome);
}

/** Rótulo legível do polo para mensagens de irregularidade. */
function nomePolo(polo: PoloCadastro): string {
  switch (polo) {
    case 'ATIVO':
      return 'polo ativo';
    case 'PASSIVO':
      return 'polo passivo';
    case 'OUTROS':
      return 'Outros interessados';
    default:
      return 'polo indefinido';
  }
}

// =====================================================================
// Motor
// =====================================================================

/**
 * Avalia todas as regras determinísticas sobre um processo e devolve as
 * irregularidades encontradas. Sem irregularidades ⇒ `status: 'ok'`.
 */
export function validarCadastroProcesso(
  proc: ProcessoCadastro
): ResultadoValidacaoCadastro {
  const irregularidades: IrregularidadeCadastro[] = [];
  const add = (i: IrregularidadeCadastro): void => {
    irregularidades.push(i);
  };

  const partes = proc.partes ?? [];
  const principais = partes.filter((p) => p.ehPrincipal);
  const autores = principais.filter((p) => p.tipo === 'AUTOR' || p.polo === 'ATIVO');
  const vinculosDoGrupo = (grupoId: number): ParteCadastro[] =>
    partes.filter((p) => p.grupoId === grupoId && !p.ehPrincipal);

  const algumAutorMenor = autores.some((a) => ehNomeDeMenor(a.nome));
  const inssNoPassivo = partes.some((p) => p.polo === 'PASSIVO' && ehINSS(p.nome));

  // --- Regra 6: ausência do CPF do autor -----------------------------
  for (const autor of autores) {
    // Autor pessoa jurídica (CNPJ) não tem CPF — não é irregularidade.
    if (autor.documentoTipo === 'CNPJ') continue;
    const temCpf = autor.documentoTipo === 'CPF' && soDigitos(autor.documentoNumero).length >= 11;
    if (!temCpf) {
      add({
        id: 'cpf-autor-ausente',
        titulo: 'CPF do autor ausente',
        detalhe: `O autor "${autor.nome}" está sem CPF no cadastro do polo ativo.`,
        gravidade: 'alta'
      });
    }
  }

  // --- Regra 10: advogado vinculado a cada autor (ou seu representante) ---
  // O advogado pode estar vinculado ao autor ou ao representante legal —
  // ambos ficam no mesmo grupo do `<td>`. Basta haver um ADVOGADO no grupo.
  for (const autor of autores) {
    const vinc = vinculosDoGrupo(autor.grupoId);
    const temAdvogado = vinc.some((v) => v.tipo === 'ADVOGADO');
    if (!temAdvogado) {
      add({
        id: 'advogado-ausente',
        titulo: 'Advogado não vinculado',
        detalhe:
          `O autor "${autor.nome}" não tem advogado regularmente vinculado ` +
          `(a ele ou ao respectivo representante legal).`,
        gravidade: 'alta'
      });
    }
  }

  // --- Regras do autor menor: representante legal + MPF fiscal da lei ---
  if (algumAutorMenor) {
    // Regra 9: representante legal cadastrado para o autor menor.
    for (const autor of autores) {
      if (!ehNomeDeMenor(autor.nome)) continue;
      const temRepresentante = vinculosDoGrupo(autor.grupoId).some(
        (v) => v.tipo === 'REPRESENTANTE'
      );
      if (!temRepresentante) {
        add({
          id: 'representante-menor-ausente',
          titulo: 'Representante legal do menor ausente',
          detalhe:
            `O autor menor "${autor.nome}" está sem representante legal ` +
            `vinculado no cadastro.`,
          gravidade: 'alta'
        });
      }
    }

    // Regra 1 / 5: MPF como fiscal da lei em Outros interessados.
    const temMPF = partes.some((p) => p.polo === 'OUTROS' && ehMPF(p.nome));
    if (!temMPF) {
      add({
        id: 'mpf-ausente',
        titulo: 'MPF ausente (autor menor)',
        detalhe:
          'Autor menor identificado: o Ministério Público Federal (MPF, ' +
          'CNPJ 26.989.715/0011-84) deve constar como fiscal da lei em ' +
          'Outros interessados.',
        gravidade: 'alta'
      });
    }
  }

  // --- Regra 11: representante cujo representado não é autor ----------
  // Um REPRESENTANTE vinculado a uma parte principal que não é AUTOR indica
  // cadastro incorreto (o representado deveria figurar no polo ativo).
  for (const principal of principais) {
    if (principal.tipo === 'AUTOR' || principal.polo === 'ATIVO') continue;
    const temRepresentante = vinculosDoGrupo(principal.grupoId).some(
      (v) => v.tipo === 'REPRESENTANTE'
    );
    if (temRepresentante) {
      add({
        id: 'representante-nao-autor',
        titulo: 'Representante de parte que não é autora',
        detalhe:
          `Há representante legal vinculado a "${principal.nome}", que não ` +
          `está cadastrada no polo ativo.`,
        gravidade: 'media'
      });
    }
  }

  // --- Regra 2: CNPJ do INSS correto ---------------------------------
  for (const p of partes) {
    if (!ehINSS(p.nome)) continue;
    if (p.documentoTipo !== 'CNPJ') continue;
    if (soDigitos(p.documentoNumero) !== CNPJ_INSS) {
      add({
        id: 'inss-cnpj-incorreto',
        titulo: 'CNPJ do INSS incorreto',
        detalhe:
          `O INSS está cadastrado com CNPJ ${p.documentoNumero}; o correto é ` +
          `29.979.036/0001-40.`,
        gravidade: 'alta'
      });
      break; // uma ocorrência basta
    }
  }

  // --- Regra 7: INSS cadastrado como terceiro interessado ------------
  if (partes.some((p) => p.polo === 'OUTROS' && ehINSS(p.nome))) {
    add({
      id: 'inss-terceiro-interessado',
      titulo: 'INSS em Outros interessados',
      detalhe:
        'O INSS está cadastrado em Outros interessados; deveria figurar no ' +
        'polo passivo (réu).',
      gravidade: 'media'
    });
  }

  // --- Regra 4: CEAB presente quando INSS no passivo -----------------
  // Só apontamos "ausente" quando NÃO há CEAB alguma no processo. Se a CEAB
  // existe mas está mal cadastrada (polo errado, sem procuradoria, CNPJ
  // divergente), quem cuida disso é a regra 8 — evita apontamento duplo.
  const ceabPrincipal = principais.find((p) => ehCEAB(p.nome));
  if (inssNoPassivo && !ceabPrincipal) {
    add({
      id: 'ceab-ausente',
      titulo: 'CEAB ausente',
      detalhe:
        'INSS no polo passivo: a CEAB-DJ INSS (CNPJ 29.979.036/0014-65) ' +
        'deve constar como órgão de cumprimento em Outros interessados.',
      gravidade: 'alta'
    });
  }

  // --- Regra 8: cadastro da CEAB (localização, procuradoria e CNPJ) ---
  // A CEAB deve SEMPRE figurar em "Outros interessados" (como órgão de
  // cumprimento) e ter procuradoria vinculada. São problemas independentes:
  // localização no polo ativo/passivo, ausência de procuradoria e CNPJ
  // divergente — todos reunidos num único apontamento com o detalhe.
  if (ceabPrincipal) {
    const problemas: string[] = [];
    if (ceabPrincipal.polo !== 'OUTROS') {
      problemas.push(
        `cadastrada no ${nomePolo(ceabPrincipal.polo)}, mas deve figurar em ` +
          `Outros interessados`
      );
    }
    const temProcuradoria = vinculosDoGrupo(ceabPrincipal.grupoId).some(
      (v) => v.tipo === 'PROCURADORIA'
    );
    if (!temProcuradoria) {
      problemas.push('sem procuradoria vinculada');
    }
    if (
      ceabPrincipal.documentoTipo === 'CNPJ' &&
      soDigitos(ceabPrincipal.documentoNumero) !== CNPJ_CEAB
    ) {
      problemas.push(
        `CNPJ ${ceabPrincipal.documentoNumero} divergente do correto ` +
          `(29.979.036/0014-65)`
      );
    }
    if (problemas.length > 0) {
      add({
        id: 'ceab-cadastro-incorreto',
        titulo: 'Cadastro da CEAB incorreto',
        detalhe: `CEAB no processo: ${problemas.join('; ')}.`,
        gravidade: 'media'
      });
    }
  }

  // --- Polo passivo materialmente vazio ------------------------------
  // Quando o polo passivo só contém a CEAB (que pertence a Outros
  // interessados), ao corrigir a localização o polo passivo fica sem réu.
  // Isso é uma segunda irregularidade além do "Cadastro da CEAB incorreto":
  // falta o réu no polo passivo.
  const passivoPrincipais = principais.filter((p) => p.polo === 'PASSIVO');
  const passivoReusLegitimos = passivoPrincipais.filter((p) => !ehCEAB(p.nome));
  if (passivoPrincipais.length > 0 && passivoReusLegitimos.length === 0) {
    add({
      id: 'polo-passivo-vazio',
      titulo: 'Ausência de cadastro no polo passivo',
      detalhe:
        'O polo passivo contém apenas a CEAB, que deve figurar em Outros ' +
        'interessados — logo, não há réu regularmente cadastrado no polo ' +
        'passivo.',
      gravidade: 'alta'
    });
  }

  // --- Regra 3: órgão público deve ter procuradoria vinculada --------
  // Cobre INSS, União e demais entes públicos. A CEAB é tratada na regra 8
  // (mais específica) para não duplicar o apontamento.
  for (const p of principais) {
    if (!p.ehOrgaoPublico) continue;
    if (ehCEAB(p.nome)) continue;
    const temProcuradoria = vinculosDoGrupo(p.grupoId).some(
      (v) => v.tipo === 'PROCURADORIA'
    );
    if (!temProcuradoria) {
      let detalhe =
        `A parte "${p.nome}" é órgão público e está sem procuradoria ` +
        `vinculada no cadastro.`;
      // INSS é o réu mais comum: a minuta deve apontar explicitamente o
      // cadastro correto (nome + CNPJ + procuradoria esperada).
      if (ehINSS(p.nome)) {
        detalhe +=
          ` O INSS correto é ${ENTES_CANONICOS.INSS.nome} ` +
          `(CNPJ ${ENTES_CANONICOS.INSS.cnpj}), com a ` +
          `${ENTES_CANONICOS.INSS.procuradoria} vinculada.`;
      }
      add({
        id: 'orgao-sem-procuradoria',
        titulo: 'Órgão público sem procuradoria',
        detalhe,
        gravidade: 'media'
      });
    }
  }

  // --- Regra final: valor da causa ausente ---------------------------
  if (!temValorCausa(proc.valorCausaTexto)) {
    add({
      id: 'valor-causa-ausente',
      titulo: 'Valor da causa ausente',
      detalhe: 'O processo foi protocolado sem cadastro do valor da causa.',
      gravidade: 'media'
    });
  }

  return {
    status: irregularidades.length === 0 ? 'ok' : 'irregular',
    irregularidades
  };
}

/**
 * `true` quando há um valor da causa cadastrado e diferente de zero. Aceita
 * o texto bruto do PJe (ex.: "R$ 20.309,00"); trata "R$ 0,00" como ausência
 * material de valor.
 */
function temValorCausa(texto: string | null): boolean {
  if (!texto) return false;
  const num = texto.replace(/[^\d]/g, '');
  if (!num) return false;
  return Number(num) > 0;
}
