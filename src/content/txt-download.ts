/**
 * Montagem e download de arquivos .txt estruturados a partir dos documentos de
 * um processo — usado tanto pela EXTRAÇÃO (conteúdo bruto) quanto pela
 * ANONIMIZAÇÃO (conteúdo mascarado). Um único formato, com cabeçalho e divisão
 * clara por documento, para que o usuário audite/arquive o que foi lido ou o
 * que foi enviado à IA.
 *
 * Puro do ponto de vista de negócio (só depende de DOM para o download); não
 * conhece o `memory` nem o content script.
 */

/** Subconjunto de `ProcessoDocumento` necessário para montar o .txt. */
export interface DocumentoTxt {
  id: string | number;
  tipo?: string | null;
  descricao?: string | null;
  dataMovimentacao?: string | null;
  textoExtraido?: string | null;
  /** PDF digitalizado (bitmap sem camada de texto), detectado no parse. */
  isScanned?: boolean | null;
  /** MIME do arquivo — distingue mídia não-textual (áudio/vídeo/imagem). */
  mimeType?: string | null;
}

/**
 * Classificação de leitura de um documento, do ponto de vista da EXPORTAÇÃO
 * de texto (offline, sem IA):
 *  - `texto-ok`     — há conteúdo textual útil para incluir no arquivo.
 *  - `pendente-ocr` — PDF digitalizado sem texto reconhecível offline. O
 *                     conteúdo NÃO consta do .txt; precisa de OCR local ou IA.
 *  - `nao-textual`  — áudio/vídeo/imagem: não há texto a extrair por natureza.
 */
export type ClassificacaoLeitura = 'texto-ok' | 'pendente-ocr' | 'nao-textual';

/** Abaixo deste número de caracteres úteis, um scan é "leitura pendente". */
const LIMIAR_TEXTO_UTIL = 50;

const NAO_TEXTUAL_RE = /^(?:audio|video|image)\//i;

/**
 * Remove o "boilerplate" que o PJe carimba em documentos digitalizados —
 * texto REAL e extraível que NÃO é conteúdo do documento e engana qualquer
 * heurística de "tem texto?". Sem descontar isso, uma página 100% escaneada
 * (laudo médico, procuração) "tem" ~70–80 caracteres de rodapé e passa por
 * documento legível, escondendo a lacuna. Cobre:
 *  - marcadores de página do parser (`=== Página N ===`, com `(OCR)`);
 *  - o bloco de certificação ("O documento a seguir foi juntado… ID do
 *    documento: N", cabeçalho da Justiça Federal, "Consulte este documento…");
 *  - o rodapé de autenticação por página ("Autenticado por: Sem dados…",
 *    "Anexo ID: N", "Página N de M", "Emitido em:").
 */
function removerBoilerplatePje(texto: string): string {
  return texto
    .replace(/===\s*Página\s+\d+(?:\s*\([^)]+\))?\s*===/g, ' ')
    .replace(/O documento a seguir foi juntado aos autos[\s\S]*?ID do documento:\s*\d+/gi, ' ')
    .replace(/Justi[çc]a Federal da \d+[ªa]?\s*Regi[ãa]o\s+Processo Judicial Eletr[ôo]nico[^\n]*/gi, ' ')
    .replace(/Consulte este documento em:[^\n]*/gi, ' ')
    .replace(/Voc[êe] pode conferir a autenticidade[\s\S]{0,140}?c[óo]digo\s+[\w-]+/gi, ' ')
    .replace(/Autenticado por:\s*Sem dados de autentica[çc][ãa]o/gi, ' ')
    .replace(/Anexo ID:\s*(?:\d+|\[[^\]]+\])/gi, ' ')
    .replace(/P[áa]gina\s+\d+\s+de\s+\d+/gi, ' ')
    .replace(/Emitido em:/gi, ' ');
}

/**
 * Conta caracteres "úteis" de um texto extraído, descontando os marcadores de
 * página E o boilerplate de autenticação/certificação do PJe. Espelha
 * `conteudoUtilLength` de `extractor.ts` — mantido aqui de forma independente
 * para que este módulo permaneça puro (sem arrastar pdf.js/tesseract via
 * `extractor.ts`). Se um dos dois mudar, ajustar o outro.
 */
function contarConteudoUtil(texto: string | null | undefined): number {
  if (!texto) return 0;
  return removerBoilerplatePje(texto).replace(/\s+/g, ' ').trim().length;
}

/**
 * Classifica um documento quanto à disponibilidade de texto para o .txt.
 *
 * `pendente-ocr` quando o conteúdo útil (sem boilerplate) fica abaixo do limiar
 * E o documento é um PDF (ou está marcado como escaneado) — NÃO depende só do
 * flag `isScanned` do parser: o rodapé carimbado do PJe faz a média de
 * caracteres subir e o parser marca `isScanned=false`, deixando escapar
 * exatamente os escaneados mais importantes (laudo, procuração). O corte por
 * MIME evita marcar documentos-rótulo curtos em HTML.
 */
export function classificarLeitura(doc: DocumentoTxt): ClassificacaoLeitura {
  if (doc.mimeType && NAO_TEXTUAL_RE.test(doc.mimeType)) return 'nao-textual';
  const ehPdf = !!doc.mimeType && /pdf/i.test(doc.mimeType);
  if (
    contarConteudoUtil(doc.textoExtraido) < LIMIAR_TEXTO_UTIL &&
    (doc.isScanned === true || ehPdf)
  ) {
    return 'pendente-ocr';
  }
  return 'texto-ok';
}

/** Documentos digitalizados sem texto reconhecível offline (leitura pendente). */
export function listarPendenciasLeitura(docs: DocumentoTxt[]): DocumentoTxt[] {
  return docs.filter((d) => classificarLeitura(d) === 'pendente-ocr');
}

/**
 * Rótulo do documento combinando o TIPO com a DESCRIÇÃO complementar (o nome do
 * arquivo que o PJe mostra entre parênteses na árvore) quando esta acrescenta
 * informação — ex.: tipo "Documento Comprobatório" + descrição "PROCURACAO"
 * vira "Documento Comprobatório — PROCURACAO". Ajuda o usuário a saber o que é
 * o documento (a procuração, o laudo etc.), não só a categoria genérica.
 */
export function rotuloDocumento(d: DocumentoTxt): string {
  const tipo = (d.tipo ?? '').trim();
  const desc = (d.descricao ?? '').trim();
  if (tipo && desc && desc.toLowerCase() !== tipo.toLowerCase()) {
    return `${tipo} — ${desc}`;
  }
  return tipo || desc || `doc ${d.id}`;
}

/**
 * Situação de sigilo do processo, lida do cabeçalho do PJe:
 *  - `publico`      — "Segredo de justiça? NÃO" (confirmado). Só aqui o código
 *                     de consulta pode ir para o .txt.
 *  - `sigiloso`     — "Segredo de justiça? SIM". Banner de confidencialidade e
 *                     nunca o código.
 *  - `desconhecido` — não foi possível ler o campo. Trata como sigiloso para
 *                     efeito de omitir o código (seguro por omissão).
 */
export type SigiloProcesso = 'publico' | 'sigiloso' | 'desconhecido';

export interface OpcoesTxt {
  /** Título do bloco de cabeçalho (ex.: "CONTEÚDO ANONIMIZADO"). */
  titulo: string;
  /** Número do processo (CNJ), quando conhecido. */
  numeroProcesso?: string | null;
  /** Linhas extras do cabeçalho (ex.: contagem de PII, papéis). */
  resumo?: string[];
  /** Documentos a serializar, na ordem desejada. */
  documentos: DocumentoTxt[];
  /** Sigilo do processo (padrão `desconhecido` → seguro por omissão). */
  sigilo?: SigiloProcesso;
}

const LARGURA = 72;

/**
 * Serializa os documentos em um .txt estruturado: cabeçalho com metadados +
 * um bloco por documento (id, tipo e data), separados por réguas.
 */
export function montarTxtDocumentos(opts: OpcoesTxt): string {
  const { titulo, numeroProcesso, resumo, documentos } = opts;
  const proc = numeroProcesso?.trim() || 'processo';
  const sigilo: SigiloProcesso = opts.sigilo ?? 'desconhecido';

  const cabecalho: string[] = [
    '='.repeat(LARGURA),
    `PROCESSO ${proc} — ${titulo}`,
    '='.repeat(LARGURA),
    `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
    `Total de documentos: ${documentos.length}`,
    ...(resumo ?? [])
  ];

  // Banner de confidencialidade quando o processo está em segredo de justiça.
  if (sigilo === 'sigiloso') {
    cabecalho.push('');
    cabecalho.push('🔒 PROCESSO EM SEGREDO DE JUSTIÇA — este arquivo contém dados sob sigilo.');
    cabecalho.push(
      '   Trate conforme a política de confidencialidade da unidade e não o compartilhe fora do processo.'
    );
  }

  // Seção de pendências: documentos digitalizados que a extração offline não
  // conseguiu ler. São listados de forma explícita no topo para que o usuário
  // saiba que o conteúdo deles NÃO está no arquivo — em vez de sair em branco
  // e passar despercebido.
  const pendencias = listarPendenciasLeitura(documentos);
  if (pendencias.length > 0) {
    cabecalho.push('');
    cabecalho.push(
      `⚠️ LEITURA PENDENTE: ${pendencias.length} documento(s) digitalizado(s) (imagem) sem texto`
    );
    cabecalho.push('   reconhecível na extração offline — o conteúdo destes NÃO está incluído abaixo:');
    for (const p of pendencias) {
      cabecalho.push(`     • id ${p.id} | ${rotuloDocumento(p)}`);
    }
    cabecalho.push(
      '   Cada um traz, no seu bloco abaixo, o caminho para consultar o original nos autos'
    );
    cabecalho.push(
      '   ou lê-lo com IA. O acesso ao original é feito no PJe, em sessão autenticada'
    );
    cabecalho.push('   (respeita eventual sigilo).');
  }
  cabecalho.push('');

  const corpo: string[] = [];
  for (const d of documentos) {
    const tag = rotuloDocumento(d);
    const data = d.dataMovimentacao ? ` | ${d.dataMovimentacao}` : '';
    corpo.push('-'.repeat(LARGURA));
    corpo.push(`### id ${d.id} | ${tag}${data}`);
    corpo.push('-'.repeat(LARGURA));
    corpo.push(corpoDocumento(d, sigilo));
    corpo.push('');
  }

  return [...cabecalho, ...corpo].join('\n');
}

/**
 * Texto do bloco de um documento, conforme sua classificação de leitura. Um
 * escaneado sem texto recebe um bloco de alerta com caminho de solução (nunca
 * sai em branco); um arquivo não-textual mantém seu marcador; os demais trazem
 * o texto extraído.
 */
function corpoDocumento(d: DocumentoTxt, sigilo: SigiloProcesso): string {
  const classe = classificarLeitura(d);
  if (classe === 'pendente-ocr') return blocoPendencia(d, sigilo);
  const texto = (d.textoExtraido ?? '').trim();
  if (classe === 'nao-textual') {
    return texto || '[arquivo não-textual — sem conteúdo de texto]';
  }
  return texto ? filtrarPaginasIlegiveis(texto) : '[conteúdo indisponível]';
}

/**
 * Detecta uma página cujo texto é "sopa de símbolos" — o caso de um PDF
 * escaneado com a camada de texto CORROMPIDA (não ausente), em que o pdf.js
 * extrai fielmente o byte-soup embutido (ex.: `! " # $ % & ' ( ) * v J I w x`).
 *
 * Critério (conservador): a fração de caracteres que pertencem a uma "palavra
 * de verdade" (sequência de 3+ letras) é muito baixa. Dígitos NÃO contam a
 * favor nem contra — assim tabelas numéricas legítimas (que têm rótulos como
 * "Renda", "Nome", "Considerada") não são marcadas, mas a sopa de símbolos,
 * que quase não tem palavras, é. Páginas curtas (< 80 chars úteis) não são
 * julgadas.
 */
function paginaEhIlegivel(corpo: string): boolean {
  const semEspaco = corpo.replace(/\s/g, '');
  if (semEspaco.length < 80) return false;
  const letrasEmPalavras = (corpo.match(/\p{L}{3,}/gu) ?? []).reduce(
    (soma, palavra) => soma + palavra.length,
    0
  );
  return letrasEmPalavras / semEspaco.length < 0.25;
}

/**
 * Percorre o texto de um documento página a página (pelos marcadores
 * `=== Página N ===`) e substitui o corpo das páginas ilegíveis por um aviso,
 * preservando as páginas boas. Não destrutivo: roda só na geração do .txt; a
 * imagem para a IA continua intacta. Documentos sem marcadores de página (HTML)
 * passam sem alteração.
 */
function filtrarPaginasIlegiveis(texto: string): string {
  const MARCADOR = /(===\s*Página\s+\d+(?:\s*\([^)]+\))?\s*===)/g;
  const partes = texto.split(MARCADOR);
  // split com grupo de captura: [pré, marcador, corpo, marcador, corpo, ...].
  for (let i = 1; i + 1 < partes.length; i += 2) {
    const corpo = partes[i + 1];
    if (corpo != null && paginaEhIlegivel(corpo)) {
      partes[i + 1] =
        '\n[página ilegível — imagem com camada de texto corrompida; ' +
        'consulte o original nos autos ou use "Ler com IA".]\n';
    }
  }
  return partes.join('');
}

interface CertificacaoPje {
  juntadoPor?: string;
  dataJuntada?: string;
  /** Código de consulta do documento (token de acesso). Uso condicionado. */
  codigo?: string;
}

/**
 * Extrai, quando presente no texto, os metadados da página de certificação do
 * PJe ("O documento a seguir foi juntado aos autos… em DATA por NOME … usando o
 * código: X"). O código é um TOKEN DE ACESSO ao documento — capturado aqui, mas
 * só impresso no .txt quando o processo é comprovadamente público (ver
 * `blocoPendencia`).
 */
function extrairCertificacaoPje(texto: string | null | undefined): CertificacaoPje {
  if (!texto) return {};
  const out: CertificacaoPje = {};
  const m = texto.match(
    /juntado aos autos do processo[\s\S]*?em\s+([\d/]{8,10}(?:\s+[\d:]{5,8})?)\s+por\s+(.+?)(?:\s+Documento assinado|\s+Consulte este|\s+ID do documento|$)/i
  );
  if (m) {
    out.dataJuntada = m[1]?.trim();
    out.juntadoPor = m[2]?.trim();
  }
  const c = texto.match(/usando o c[óo]digo:\s*([A-Za-z0-9]{8,})/i);
  if (c) out.codigo = c[1];
  return out;
}

/**
 * Bloco de alerta para um documento digitalizado cujo conteúdo não foi lido:
 * diz o que é, quem/quando juntou (quando a certificação foi extraída) e deixa
 * o caminho de solução. O código de consulta só é impresso quando o processo é
 * COMPROVADAMENTE público (`sigilo === 'publico'`); em sigiloso/indeterminado,
 * cai no caminho por ID em sessão autenticada (que respeita o sigilo).
 */
function blocoPendencia(d: DocumentoTxt, sigilo: SigiloProcesso): string {
  const cert = extrairCertificacaoPje(d.textoExtraido);
  const linhas: string[] = [
    '[⚠️ CONTEÚDO NÃO EXTRAÍDO — documento digitalizado (imagem), sem texto legível na extração offline.]'
  ];
  if (cert.juntadoPor) {
    linhas.push(
      `  Juntado por: ${cert.juntadoPor}${cert.dataJuntada ? ` em ${cert.dataJuntada}` : ''}`
    );
  } else if (d.dataMovimentacao) {
    linhas.push(`  Movimentação: ${d.dataMovimentacao}`);
  }
  if (sigilo === 'publico' && cert.codigo) {
    linhas.push(
      `  Consultar o original na Consulta de Documento do PJe — código ${cert.codigo} (id ${d.id}).`
    );
  } else {
    linhas.push(
      `  Para ler o original: localize o documento id ${d.id} na árvore de documentos do ` +
        'processo (Consulta de Documento do PJe, em sessão autenticada).'
    );
  }
  linhas.push(
    '  Para que a IA leia este documento: use "Ler com IA" na barra lateral — isso ENVIA ' +
      'este documento ao provedor de IA (decisão consciente, fora da anonimização offline).'
  );
  return linhas.join('\n');
}

/** Dispara o download de `conteudo` como arquivo de texto UTF-8. */
export function baixarTxt(nomeArquivo: string, conteudo: string): void {
  // BOM UTF-8 (﻿): sem ele, o Bloco de Notas/Word no Windows abrem o
  // arquivo como ANSI (Windows-1252) e mostram mojibake ("CONTEÚDO" vira
  // "CONTEÃDO", "⚠️" vira "â ï¸"). O BOM faz esses editores detectarem UTF-8.
  const blob = new Blob(['﻿' + conteudo], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Normaliza o número do processo para uso seguro em nome de arquivo. */
export function nomeArquivoSeguro(prefixo: string, numeroProcesso?: string | null): string {
  const num = (numeroProcesso ?? 'processo').replace(/[^0-9A-Za-z._-]/g, '_');
  return `${prefixo}-${num}.txt`;
}

/**
 * Cria um botão padronizado de download de .txt. `montar` é chamado no clique
 * (lazily), para que o conteúdo reflita o estado no momento do download.
 */
export function criarBotaoDownloadTxt(
  rotulo: string,
  montar: () => { nomeArquivo: string; conteudo: string }
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-chat__download-btn';
  btn.textContent = rotulo;
  btn.style.cssText =
    'margin-top: 10px; padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(19,81,180,0.35); background: rgba(19,81,180,0.08); color: var(--paidegua-primary-dark); font-size: 12px; cursor: pointer; font-weight: 600;';
  btn.addEventListener('click', () => {
    const { nomeArquivo, conteudo } = montar();
    baixarTxt(nomeArquivo, conteudo);
  });
  return btn;
}
