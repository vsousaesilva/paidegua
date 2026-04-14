/**
 * Anonimizador de textos de processo — implementação no mesmo modelo do
 * sistema `gerador-minutas` (TI/JFCE).
 *
 * Estratégia em DOIS passos, complementares:
 *
 *  1. **Regex local (instantâneo, offline):** substitui dados estruturados
 *     que seguem padrões fixos — CPF, CNPJ, CEP, telefone, e-mail, RG e
 *     dados bancários — por marcadores `[XXX OMITIDO]`. Não depende de
 *     LLM e roda no próprio content script.
 *
 *  2. **LLM (apenas o início do documento):** envia ao modelo só os
 *     primeiros ~3000 caracteres do texto extraído (onde costumam estar
 *     identificadas as partes), pedindo um JSON com pares
 *     `{original, substituto}` — pessoas físicas → papel processual.
 *     A resposta é aplicada no texto INTEIRO via `String.replace`.
 *
 * O passo 2 não envia o conteúdo completo dos autos a nenhum servidor
 * externo — só o cabeçalho que contém qualificação. Isso minimiza a
 * exposição e mantém a operação compatível com a LGPD.
 *
 * Este arquivo expõe utilitários puros (sem chamar Chrome APIs), para
 * que possam ser invocados pelo content script ou pelo background sem
 * dependência cruzada de contexto.
 */

/**
 * Aplica as substituições por regex (passo 1). Roda 100% local.
 *
 * Cuidados conhecidos:
 *  - O padrão de RG é genérico e pode colidir com números de processo;
 *    detectamos a presença de barra para descartar esses casos.
 *  - "Agência" e "conta" usam ancoragem por palavra-chave para evitar
 *    falsos positivos com números soltos no texto.
 */
export function aplicarRegexAnonimizacao(texto: string): string {
  return texto
    // CPF: 000.000.000-00
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[CPF OMITIDO]')
    // CNPJ: 00.000.000/0000-00
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '[CNPJ OMITIDO]')
    // CEP: 00000-000
    .replace(/\b\d{5}-\d{3}\b/g, '[CEP OMITIDO]')
    // Telefone: (00) 00000-0000 ou (00) 0000-0000
    .replace(/\(?\d{2}\)?\s?\d{4,5}-\d{4}\b/g, '[TELEFONE OMITIDO]')
    // E-mail
    .replace(/\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g, '[EMAIL OMITIDO]')
    // RG: padrões comuns (ex: 0.000.000, 00.000.000-0)
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}-?[\dXx]\b/g, (match) => {
      // Evita substituir números de processo (que têm barra).
      if (match.includes('/')) return match;
      return '[RG OMITIDO]';
    })
    // Dados bancários: agência 0000-0 / conta 00000-0
    .replace(/\bagência\s*n?[º°.]?\s*\d{3,5}[-.]?\d?\b/gi, 'agência [DADO BANCÁRIO OMITIDO]')
    .replace(
      /\bconta\s*(?:corrente|poupança)?\s*n?[º°.]?\s*\d{5,12}[-.]?\d?\b/gi,
      'conta [DADO BANCÁRIO OMITIDO]'
    );
}

/**
 * Par de substituição retornado pelo LLM no passo 2.
 */
export interface NomeAnonimizar {
  original: string;
  substituto: string;
}

/**
 * Trecho enviado ao LLM — aumentado de 3.000 para 12.000 chars.
 * Motivo: com 3k, só cabia a primeira página da petição inicial (quase
 * sempre o autor qualificado). Com 12k, entra a qualificação completa
 * das partes, nomeação de procuradores, advogados com OAB, curadores
 * e representantes — aumentando drasticamente o recall do anonimizador.
 * Custo da chamada LLM cresce linearmente, mas a anonimização roda 1x
 * por processo — o custo absoluto continua baixo.
 */
export const TRECHO_INICIAL_TAMANHO = 12_000;

/** Recorta o cabeçalho do texto para alimentar o LLM no passo 2. */
export function recortarTrechoInicial(texto: string): string {
  return texto.slice(0, TRECHO_INICIAL_TAMANHO);
}

/**
 * Prompt usado pelo LLM para extrair nomes próprios e mapeá-los a um
 * papel processual. Exatamente o mesmo do `gerador-minutas`, ajustado
 * para indicar que o trecho já vem recortado pelo chamador.
 */
export function buildAnonymizePrompt(trechoInicial: string): string {
  return `Analise o trecho de processo judicial abaixo e identifique EXAUSTIVAMENTE todos os nomes de pessoas físicas que devem ser anonimizados. É CRÍTICO capturar TODOS os atores processuais — não apenas o autor.

Retorne APENAS um objeto JSON válido, sem texto adicional, sem markdown, sem explicações. Formato:
{"nomes": [{"original": "Nome Completo da Pessoa", "substituto": "[PAPEL PROCESSUAL]"}]}

Papéis possíveis (use o que melhor descrever o papel da pessoa no processo):
- [PARTE AUTORA] / [PARTE RÉ] / [LITISCONSORTE ATIVO] / [LITISCONSORTE PASSIVO] / [TERCEIRO INTERESSADO]
- [REPRESENTANTE LEGAL DA PARTE AUTORA] / [REPRESENTANTE LEGAL DA PARTE RÉ]
- [CURADOR] / [TUTOR] / [ASSISTENTE] (quando houver incapacidade ou menoridade)
- [ADVOGADO DA PARTE AUTORA] / [ADVOGADO DA PARTE RÉ] (inclui estagiários e advogados substabelecidos)
- [PROCURADOR FEDERAL] / [PROCURADOR DO ESTADO] / [PROCURADOR DO MUNICÍPIO]
- [DEFENSOR PÚBLICO]
- [MEMBRO DO MINISTÉRIO PÚBLICO]
- [PERITO MÉDICO] / [PERITO SOCIAL] / [PERITO CONTÁBIL] / [PERITO ENGENHEIRO] / [PERITO]
- [ASSISTENTE TÉCNICO DA PARTE AUTORA] / [ASSISTENTE TÉCNICO DA PARTE RÉ]
- [TESTEMUNHA 1] / [TESTEMUNHA 2] / [TESTEMUNHA 3] (numerar na ordem em que aparecem)
- [INFORMANTE]

ONDE PROCURAR (não se limite à qualificação inicial do autor):
1. Qualificação das partes na petição inicial (nome, RG, CPF, endereço, profissão).
2. Nomes de advogados com inscrição na OAB — geralmente aparecem em "Por seus advogados", "representado por", em procurações, substabelecimentos ou ao final da peça (assinatura).
3. Contestação/defesa — procurador federal/INSS, advogado do réu, nome do servidor.
4. Representantes legais, curadores, tutores — comuns em casos de incapacidade, interdição, menoridade.
5. Laudos periciais — nome do perito, CRM/CREA/CFESS/CRC, assistentes técnicos indicados pelas partes.
6. Ministério Público — promotor/procurador da República que oficiou nos autos.
7. Nomeações constantes em despachos (ex.: "nomeio como curador provisório Fulano de Tal").
8. Substabelecimentos — advogado substabelecente E advogado substabelecido.

Regras:
- Incluir TODAS as pessoas físicas identificadas, por mais secundárias que pareçam.
- Incluir estagiários, advogados auxiliares, peritos de todas as especialidades.
- NÃO incluir: órgãos públicos (INSS, União, Município), autarquias, empresas, escritórios de advocacia como pessoa jurídica.
- NÃO incluir: magistrados e servidores do Judiciário no exercício da função (juiz, desembargador, relator, escrivão, chefe de secretaria).
- Se o mesmo nome aparecer com variações (com/sem acentos, com/sem sobrenomes, abreviado, tudo maiúsculo, com título "Dr.", "Sr."), incluir TODAS as variações encontradas como entradas separadas com o mesmo substituto.
- Seja generoso: é preferível anonimizar um nome a menos do que deixar um nome sensível passar.

TRECHO DO PROCESSO:
${trechoInicial}`;
}

/**
 * Aplica os pares `{original, substituto}` retornados pelo LLM em todo
 * o texto. Os nomes são escapados antes de virarem regex e a substituição
 * é case-insensitive global.
 */
export function aplicarSubstituicoesNomes(
  texto: string,
  nomes: NomeAnonimizar[]
): string {
  let resultado = texto;
  for (const { original, substituto } of nomes) {
    if (!original || !substituto) continue;
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    resultado = resultado.replace(new RegExp(escaped, 'gi'), substituto);
  }
  return resultado;
}

/**
 * Tenta parsear a resposta JSON do LLM. Aceita variações comuns:
 *  - JSON puro;
 *  - JSON dentro de bloco markdown ```json ... ```;
 *  - texto com lixo antes/depois (extrai o primeiro objeto `{...}`).
 *
 * Devolve um array (possivelmente vazio) — nunca lança.
 */
export function parseNomesResponse(raw: string): NomeAnonimizar[] {
  if (!raw) return [];
  let candidate = raw.trim();
  // Remove cerca de markdown se presente.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fence) {
    candidate = fence[1].trim();
  }
  // Se ainda não começa com {, tenta extrair o primeiro objeto.
  if (!candidate.startsWith('{')) {
    const m = /\{[\s\S]*\}/.exec(candidate);
    if (m) candidate = m[0];
  }
  try {
    const parsed = JSON.parse(candidate) as { nomes?: NomeAnonimizar[] };
    if (parsed && Array.isArray(parsed.nomes)) {
      return parsed.nomes.filter((n) => n && n.original && n.substituto);
    }
  } catch {
    /* fallthrough */
  }
  return [];
}