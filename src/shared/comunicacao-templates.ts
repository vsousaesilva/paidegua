/**
 * Geradores das mensagens de cobrança (Central de Comunicação).
 *
 * Cada combinação destinatário × canal tem um template próprio:
 *   - WhatsApp: linguagem mais próxima, mensagem curta, parágrafos
 *     enxutos. Sem assunto e sem links nos processos.
 *   - E-mail: linguagem formal, com cumprimento institucional, abertura
 *     e fechamento clássicos. Inclui assunto sugerido.
 *
 * Os processos são listados apenas com o número CNJ (formatado), sem
 * URL — o destinatário busca o processo pelo número no PJe. A URL não
 * é incluída por solicitação institucional (ruído na mensagem e os
 * links extensos do PJe quebram em alguns clientes).
 *
 * A assinatura é composta como "Secretaria da [nomeVara]" quando há
 * `nomeVara` configurado; senão cai para "Secretaria" sozinho.
 */

import type { ComunicacaoProcesso, PericiaPerito } from './types';

// =====================================================================
// Helpers comuns
// =====================================================================

function formatarLinhaProcesso(p: ComunicacaoProcesso, idx: number): string {
  const nro = p.numeroProcesso ?? `id ${p.idProcesso}`;
  return `${idx + 1}. ${nro}`;
}

function formatarListaProcessos(processos: ComunicacaoProcesso[]): string {
  return processos.map(formatarLinhaProcesso).join('\n');
}

/**
 * Devolve a saudação cabível ao perito (ex.: "Dr. Fulano", "Dra. Fulana",
 * "Assistente Social Fulano").
 */
export function saudacaoPerito(perito: PericiaPerito): string {
  const nome = perito.nomeCompleto.trim();
  if (perito.profissao === 'ASSISTENTE_SOCIAL') {
    return `Assistente Social ${nome}`;
  }
  const tratamento = perito.genero === 'F' ? 'Dra.' : 'Dr.';
  return `${tratamento} ${nome}`;
}

/**
 * Compõe a assinatura ("Secretaria da 12ª Vara Federal" ou "Secretaria"
 * quando o nome da vara não está configurado).
 */
export function montarAssinatura(nomeVara: string): string {
  const v = nomeVara.trim();
  return v ? `Secretaria da ${v}` : 'Secretaria';
}

// =====================================================================
// WhatsApp — perito
// =====================================================================

/**
 * Mensagem de cobrança ao perito por WhatsApp. Tom amistoso e direto,
 * sem cabeçalhos formais — espelha o registro típico do canal.
 */
export function montarMensagemWhatsAppPerito(
  perito: PericiaPerito,
  processos: ComunicacaoProcesso[],
  nomeVara: string
): string {
  const saudacao = saudacaoPerito(perito);
  const lista = formatarListaProcessos(processos);
  const assinatura = montarAssinatura(nomeVara);
  const plural = processos.length === 1 ? 'do processo abaixo' : 'dos processos abaixo';
  const verbo = processos.length === 1 ? 'aguarda' : 'aguardam';
  return (
    `Olá, ${saudacao}! Tudo bem?\n\n` +
    `Aqui é da ${assinatura}. Faço contato para lembrar gentilmente ${plural}, ` +
    `que ${verbo} a juntada do laudo pericial:\n\n` +
    `${lista}\n\n` +
    `Quando possível, agradeço a apresentação do laudo para o regular ` +
    `andamento dos feitos. Qualquer dúvida ou necessidade de prazo adicional, ` +
    `estamos à disposição.\n\n` +
    `Obrigado(a) pela atenção!\n` +
    `${assinatura}`
  );
}

// =====================================================================
// E-mail — perito
// =====================================================================

export function montarMensagemEmailPerito(
  perito: PericiaPerito,
  processos: ComunicacaoProcesso[],
  nomeVara: string
): { subject: string; body: string } {
  const saudacao = saudacaoPerito(perito);
  const lista = formatarListaProcessos(processos);
  const assinatura = montarAssinatura(nomeVara);
  const subject =
    `Cobrança de laudo pericial — ${processos.length} processo` +
    (processos.length === 1 ? '' : 's');
  const verbo = processos.length === 1 ? 'permanece pendente' : 'permanecem pendentes';
  const body =
    `Prezado(a) ${saudacao},\n\n` +
    `Cumprimento-o(a) cordialmente.\n\n` +
    `Em consulta ao sistema PJe, identifico os processos relacionados ` +
    `abaixo, nos quais Vossa Senhoria figura como perito designado e cuja ` +
    `juntada do laudo ${verbo}. Solicito gentilmente, em prol da prestação ` +
    `jurisdicional, a apresentação do(s) laudo(s) à maior brevidade ` +
    `possível.\n\n` +
    `${lista}\n\n` +
    `Permaneço à disposição para os esclarecimentos que se fizerem ` +
    `necessários.\n\n` +
    `Atenciosamente,\n` +
    `${assinatura}`;
  return { subject, body };
}

// =====================================================================
// WhatsApp — Ceab
// =====================================================================

export function montarMensagemWhatsAppCeab(
  processos: ComunicacaoProcesso[],
  nomeVara: string
): string {
  const lista = formatarListaProcessos(processos);
  const assinatura = montarAssinatura(nomeVara);
  const plural = processos.length === 1 ? 'do processo abaixo' : 'dos processos abaixo';
  return (
    `Olá! Aqui é da ${assinatura}. Tudo bem?\n\n` +
    `Encaminho a relação ${plural}, em que consta a tarefa ` +
    `"Obrigação de fazer — Sem manifestação" pendente:\n\n` +
    `${lista}\n\n` +
    `Quando possível, agradeço o retorno para o regular andamento dos ` +
    `feitos. Qualquer dúvida, ficamos à disposição.\n\n` +
    `Obrigado(a) pela atenção!\n` +
    `${assinatura}`
  );
}

// =====================================================================
// E-mail — Ceab
// =====================================================================

export function montarMensagemEmailCeab(
  processos: ComunicacaoProcesso[],
  nomeVara: string
): { subject: string; body: string } {
  const lista = formatarListaProcessos(processos);
  const assinatura = montarAssinatura(nomeVara);
  const subject =
    `Obrigação de fazer pendente de manifestação — ${processos.length} processo` +
    (processos.length === 1 ? '' : 's');
  const body =
    `Prezados Senhores,\n\n` +
    `Cumprimento-os cordialmente.\n\n` +
    `Encaminho a relação de processos abaixo, nos quais foi expedida ` +
    `tarefa de "Obrigação de fazer" e cujo prazo decorreu sem manifestação. ` +
    `Solicito, gentilmente, a apresentação das informações ou documentos ` +
    `pendentes para a regular tramitação dos feitos.\n\n` +
    `${lista}\n\n` +
    `Permanecemos à disposição para quaisquer esclarecimentos.\n\n` +
    `Atenciosamente,\n` +
    `${assinatura}`;
  return { subject, body };
}

// =====================================================================
// Helpers de URI (WhatsApp wa.me e mailto)
// =====================================================================

/**
 * Normaliza um telefone brasileiro para o formato esperado pelo wa.me:
 * apenas dígitos, com o DDI 55 quando ausente.
 *
 * Aceita entradas como "(85) 99999-1234", "85999991234", "+55 85 99999 1234"
 * e retorna `5585999991234`. Quando a entrada é inválida, devolve `null`.
 */
export function normalizarTelefoneWhatsApp(raw: string): string | null {
  if (!raw) return null;
  const digitos = raw.replace(/\D+/g, '');
  if (digitos.length < 10) return null;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

/**
 * Constrói a URL `https://wa.me/<telefone>?text=<msg encoded>`.
 * Devolve `null` quando o telefone não pôde ser normalizado.
 */
export function montarUrlWhatsApp(
  telefone: string,
  mensagem: string
): string | null {
  const tel = normalizarTelefoneWhatsApp(telefone);
  if (!tel) return null;
  return `https://wa.me/${tel}?text=${encodeURIComponent(mensagem)}`;
}

/** Constrói o URI `mailto:` para abrir o cliente padrão de e-mail. */
export function montarUrlMailto(
  destinatario: string,
  subject: string,
  body: string
): string {
  const params = new URLSearchParams();
  params.set('subject', subject);
  params.set('body', body);
  // `URLSearchParams` codifica `+` por padrão, mas mailto exige %20 para
  // espaços — substituímos manualmente para evitar que o cliente exiba
  // literalmente "+" entre palavras.
  const qs = params.toString().replace(/\+/g, '%20');
  return `mailto:${encodeURIComponent(destinatario)}?${qs}`;
}
