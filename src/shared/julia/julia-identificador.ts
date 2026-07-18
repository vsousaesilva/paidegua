/**
 * Decomposição do identificador composto de documento da Júlia.
 *
 * O mesmo formato aparece nas duas APIs sob nomes diferentes —
 * `codigoDocumento` na pública, `identificador` na autenticada:
 *
 *   JFCE : JEF : PJE_NACIONAL : 3643577  : 172619516  : 192898753
 *   orgao  inst   sistema       idProcesso idDocumento  idBinario
 *
 * O identificador de **processo** é o mesmo truncado em quatro segmentos
 * (`JFCE:JEF:PJE_NACIONAL:3643577`).
 *
 * ## Por que isso ganhou um módulo
 *
 * Porque `idBinario` é a chave real de conteúdo, e não `idDocumento`. Capturado
 * em 18/07/2026: dois documentos do mesmo processo com `idDocumento` distintos
 * (172619516 e 172593124) e **mesmo `idBinario`** devolveram texto, assinante e
 * data de assinatura idênticos. São dois registros apontando para o mesmo
 * binário — duplicata para quem lê jurisprudência, ainda que registros
 * distintos para o PJe.
 *
 * Deduplicar pelo identificador inteiro não captura esse caso.
 */

export interface JuliaIdentificador {
  orgao: string;
  instancia: string;
  sistema: string;
  idProcesso: string;
  idDocumento: string;
  idBinario: string;
}

const SEGMENTOS_DOCUMENTO = 6;

/**
 * Decompõe o identificador. Devolve `null` quando o formato não bate — nunca
 * lança, porque um identificador inesperado não deve derrubar uma busca
 * inteira.
 */
export function decomporIdentificador(
  identificador: string | null | undefined
): JuliaIdentificador | null {
  if (!identificador) return null;
  const p = identificador.split(':');
  if (p.length !== SEGMENTOS_DOCUMENTO) return null;
  const [orgao, instancia, sistema, idProcesso, idDocumento, idBinario] = p;
  if (!idProcesso || !idDocumento || !idBinario) return null;
  return { orgao, instancia, sistema, idProcesso, idDocumento, idBinario };
}

/**
 * Chave de deduplicação por **conteúdo**.
 *
 * Usa `idProcesso:idBinario` quando o identificador é decomponível — dois
 * registros com o mesmo binário no mesmo processo são o mesmo documento para
 * efeito de pesquisa. Cai para o identificador integral quando o formato foge
 * do esperado, o que preserva o comportamento antigo em vez de colapsar
 * documentos não relacionados sob uma chave degenerada.
 *
 * `idProcesso` entra na chave de propósito: `idBinario` sozinho não é garantido
 * único entre processos, e colapsar por ele isolado esconderia decisões
 * distintas.
 */
export function chaveDeduplicacao(identificador: string): string {
  const d = decomporIdentificador(identificador);
  return d ? `${d.idProcesso}:${d.idBinario}` : identificador;
}

/**
 * Monta o endereço do documento no PJe.
 *
 * O campo `url` que a Júlia devolve é apenas a **base** da instalação
 * (`https://pje1g.trf5.jus.br/pje`), não um link para o documento — repassá-lo
 * direto abre a raiz do sistema, que foi o comportamento observado em campo.
 *
 * O endpoint de download é o documentado em
 * `docs/extracao-ordens-prevjud-pje.md` §1:
 *
 *   /seam/resource/rest/pje-legacy/documento/download/{orgao}/{grau}/{idProcesso}/{idDocumento}
 *
 * **Não verificado para documentos vindos da Júlia** — o padrão foi levantado
 * na extração das ordens PREVJUD, com ids obtidos por outro caminho. Devolve
 * `null` quando o identificador não decompõe, para o chamador exibir texto sem
 * link em vez de um endereço quebrado.
 */
export function montarUrlDocumentoPje(
  identificador: string,
  urlBase: string | null | undefined
): string | null {
  const d = decomporIdentificador(identificador);
  if (!d || !urlBase) return null;

  // `G1`/`JEF` vivem na instalação de 1º grau; recursais, na de 2º.
  const grau = /^(G1|JEF)$/i.test(d.instancia) ? '1g' : '2g';
  const base = urlBase.replace(/\/+$/, '');
  return `${base}/seam/resource/rest/pje-legacy/documento/download/${d.orgao}/${grau}/${d.idProcesso}/${d.idDocumento}`;
}
