/**
 * Extração via DOM scraping da página de autos digitais do PJe legacy.
 *
 * Roda no content script da aba aberta em
 *   /pje/Processo/ConsultaProcesso/Detalhe/listAutosDigitais.seam?idProcesso=X&ca=Y
 *
 * Estrutura observada empiricamente nos prints de validação:
 *
 *   - As partes (autor, réu, advogados, procuradorias) aparecem em um
 *     painel "Detalhes do processo" que é OVERLAY na página. Esse
 *     painel pode estar fechado por padrão e exigir clique num gatilho
 *     (ícone tipo pin no header dos autos) para carregar/exibir.
 *
 *   - O texto formatado é `NOME - TIPODOC: NUMERO (PAPEL)`, geralmente
 *     em `<span class="text-bold">` mas o padrão pode aparecer em
 *     outros elementos.
 *
 *   - A timeline lateral esquerda lista os movimentos com data + título.
 *
 * Estratégia da extração:
 *
 *   1. Tentar abrir o painel "Detalhes" programaticamente (múltiplos
 *      seletores candidatos para o gatilho).
 *   2. Aguardar render usando um conjunto de heurísticas (texto
 *      reconhecível em qualquer elemento).
 *   3. Extrair partes via duas estratégias em cascata: regex direto em
 *      `span.text-bold`, depois varredura de TextNodes.
 *   4. Extrair movimentos via múltiplos seletores candidatos.
 *
 * Se nada disso bater, devolve diagnóstico detalhado para debug.
 */

import { LOG_PREFIX } from '../../shared/constants';
import {
  MOVIMENTOS_CRIMINAIS,
  type MovimentoCriminal
} from '../../shared/criminal-movimentos';
import type { ProcessoDocumento } from '../../shared/types';
import { extractDocumentosFromDoc as extractDocumentosFromDocLegacy } from '../adapters/pje-legacy';
import type {
  PJeDetalhesProcesso,
  PJeMovimento,
  PJeParte
} from '../pje-api/pje-api-criminal';

/**
 * Re-exporta a extração de documentos do `pje-legacy` (mesmas estratégias
 * do fluxo de Prazos na fita) sob o nome em PT esperado pela coleta
 * criminal. Garante que a varredura criminal use a MESMA lógica testada
 * de identificação de documentos (anchors, iframes, onclick) em vez de
 * uma versão paralela mais frágil.
 */
export function extrairDocumentosFromDoc(doc: Document): ProcessoDocumento[] {
  return extractDocumentosFromDocLegacy(doc);
}

/**
 * Regex para "FRANCISCA - CPF: 014.970.433-01 (AUTOR)" e variantes.
 *   1: nome
 *   2: tipo doc (CPF, CNPJ, RG, OAB)
 *   3: numero do documento
 *   4: papel
 */
const REGEX_PARTE =
  /(.+?)\s*[-–]\s*(CPF|CNPJ|RG|OAB)[:\s]+([\w./\-\s]+?)\s*\(([^)]+)\)/i;

/** Versão "âncora no fim" para validação estrita de spans. */
const REGEX_PARTE_STRICT =
  /^(.+?)\s*[-–]\s*(CPF|CNPJ|RG|OAB)[:\s]+([\w./\-\s]+?)\s*\(([^)]+)\)\s*$/i;

// ── Espera + abertura de painel ──────────────────────────────────

/**
 * Detecta se o DOM já contém a marca "(AUTOR)" / "(REU)" / "(DENUNCIADO)"
 * em algum lugar — sinal forte de que o painel de partes carregou.
 */
function temMarcadoresDePartes(doc: Document = document): boolean {
  const txt = doc.body?.textContent ?? '';
  return /\((AUTOR|REU|R[ÉE]U|DENUNCIADO|ACUSADO|INVESTIGADO|EXEQUENTE|ADVOGADO)\)/i.test(
    txt
  );
}

/**
 * Detecta se há indícios da timeline de movimentos no DOM. Aceita
 * várias estruturas (lista vertical, cards, agrupamentos por data).
 */
function temIndiciosDeMovimentos(doc: Document = document): boolean {
  const seletores = [
    '.movimentos-processuais',
    '.timeline-processo',
    '[id*="movimentosProcesso"]',
    '[id*="listaMovimentos"]',
    'li.movimento',
    'li[class*="movimento"]'
  ];
  for (const s of seletores) {
    if (doc.querySelector(s)) return true;
  }
  // Fallback bem fraco: qualquer texto com "JUNTADA DE" ou "PROFERIDO"
  const txt = doc.body?.textContent ?? '';
  return /\b(JUNTADA DE|PROFERIDO|DECORRIDO PRAZO|RECEBID[OA]S OS AUTOS)\b/.test(
    txt
  );
}

/**
 * Tenta clicar em gatilhos comuns para abrir o painel de detalhes
 * (que carrega as partes). Estratégia best-effort — várias tentativas.
 */
function tentarAbrirPainelDetalhes(doc: Document = document): boolean {
  const candidatos: string[] = [
    // Botões com texto "Detalhes do processo" ou similar
    'button[title*="Detalhes do processo" i]',
    'a[title*="Detalhes do processo" i]',
    'button[aria-label*="Detalhes" i]',
    '[role="button"][aria-label*="Detalhes" i]',
    // Ícones na navbar dos autos digitais
    '#tabbedPanePartesProcesso',
    '#botaoExibirCabecalho',
    '#cabecalhoTrigger',
    // Pin/star icon (linguagem de domínio do PJe)
    '[id*="pin"][onclick]',
    '[class*="pin"][onclick]'
  ];
  for (const sel of candidatos) {
    const el = doc.querySelector<HTMLElement>(sel);
    if (el && typeof el.click === 'function') {
      el.click();
      return true;
    }
  }
  return false;
}

/**
 * Aguarda a presença de partes ou movimentos no DOM. Tenta abrir o
 * painel de detalhes uma vez no início para o caso de estar fechado.
 */
export async function waitAutosDigitaisReady(
  timeoutMs = 12_000
): Promise<boolean> {
  const intervalMs = 250;
  const deadline = Date.now() + timeoutMs;

  // Primeira passada: já tem dados?
  if (temMarcadoresDePartes() || temIndiciosDeMovimentos()) return true;

  // Tenta abrir o painel de detalhes (caso esteja fechado por default).
  const tentou = tentarAbrirPainelDetalhes();
  if (tentou) {
    console.debug(`${LOG_PREFIX} criminal-extractor: gatilho de painel clicado.`);
  }

  while (Date.now() < deadline) {
    if (temMarcadoresDePartes() || temIndiciosDeMovimentos()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── Partes ──────────────────────────────────────────────────────

function papelToTipoPolo(papel: string): PJeParte['tipoPolo'] {
  const p = (papel ?? '').toLowerCase().trim();
  if (
    p.includes('autor') ||
    p.includes('exequente') ||
    p.includes('requerente') ||
    p.includes('querelante')
  ) {
    return 'ativo';
  }
  if (
    p.includes('reu') ||
    p.includes('réu') ||
    p.includes('denunciado') ||
    p.includes('acusado') ||
    p.includes('investigado') ||
    p.includes('executado') ||
    p.includes('requerido') ||
    p.includes('querelado')
  ) {
    return 'passivo';
  }
  return 'outros';
}

/**
 * Casa "NOME - OAB CE39001" no início de strings de advogado e devolve
 * `{ nome, oab }` separados. Quando não há OAB, devolve apenas `nome`.
 */
const REGEX_OAB_NO_NOME = /^(.+?)\s*[-–]\s*OAB\s+([\w-]+)\s*$/i;

function separarOabDoNome(nome: string): { nome: string; oab: string | null } {
  const m = nome.match(REGEX_OAB_NO_NOME);
  if (!m) return { nome, oab: null };
  return { nome: (m[1] ?? '').trim(), oab: (m[2] ?? '').trim() };
}

function parseLinhaParte(text: string, strict: boolean): PJeParte | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const re = strict ? REGEX_PARTE_STRICT : REGEX_PARTE;
  const m = t.match(re);
  if (!m) return null;
  const [, nomeRaw, , numeroDoc, papelRaw] = m;
  const nomeBruto = (nomeRaw ?? '').trim();
  const papel = (papelRaw ?? '').trim();
  if (!nomeBruto || !papel) return null;
  // Rejeita "nomes" que claramente vieram da timeline do processo —
  // textos de movimento como "Recebida a denúncia contra X - CPF: Y
  // (ACUSADO)" casam o regex de parte e poluem a lista. O nome real
  // do réu nunca começa com palavras de movimento processual.
  if (pareceTextoDeMovimento(nomeBruto)) return null;
  // Quando o regex casa pelo CPF mas o nome ainda tem "- OAB XXXX" colado
  // (caso comum em advogados), separa para um campo dedicado.
  const { nome, oab } = separarOabDoNome(nomeBruto);
  return {
    tipoPolo: papelToTipoPolo(papel),
    papel,
    nome,
    documento: (numeroDoc ?? '').trim() || null,
    dataNascimento: null,
    oab
  };
}

/**
 * Heurística para descartar "nomes" que são na verdade fragmentos
 * de movimento processual ou cabeçalho. Pega prefixos típicos da
 * timeline do PJe ("Recebida a denúncia contra X", "Juntada de
 * petição da parte X", "Decisão proferida em ...").
 */
const REGEX_PREFIXO_MOVIMENTO =
  /^\s*(recebid[ao]|juntad[ao]|decorrid[ao]|proferid[ao]|expedid[ao]|expeção|decis[ãa]o|senten[çc]a|despacho|certid[ãa]o|conclusos|conclus[ãa]o|intima[çc][ãa]o|cita[çc][ãa]o|p[ée]ricia|peti[çc][ãa]o|requerimento|atos? ordinat[óo]rio|determin[oa]|requer[oe])\b/i;

function pareceTextoDeMovimento(texto: string): boolean {
  return REGEX_PREFIXO_MOVIMENTO.test(texto);
}

/**
 * Estratégia 1: spans com classe `text-bold` (formato canônico do PJe).
 */
function extrairPartesViaSpans(doc: Document): PJeParte[] {
  const out: PJeParte[] = [];
  const spans = doc.querySelectorAll<HTMLElement>('span.text-bold');
  for (const span of spans) {
    const p = parseLinhaParte(span.textContent ?? '', true);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Estratégia 2: varre TODOS os elementos buscando o padrão de parte no
 * texto direto (não recursivo). Cobre casos onde o PJe não usa
 * `text-bold`.
 */
function extrairPartesViaVarreduraGeral(doc: Document): PJeParte[] {
  const out: PJeParte[] = [];
  const seen = new Set<string>();
  // Pega elementos folha (sem filhos com texto) — evita pegar o texto
  // concatenado de containers grandes.
  const todos = doc.querySelectorAll<HTMLElement>('*');
  for (const el of todos) {
    if (el.children.length > 0) continue;
    const t = (el.textContent ?? '').trim();
    if (!t || t.length > 400) continue;
    const p = parseLinhaParte(t, false);
    if (!p) continue;
    const key = `${p.nome}|${p.documento}|${p.papel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function extrairPartesDoDOM(doc: Document = document): PJeParte[] {
  const viaSpans = extrairPartesViaSpans(doc);
  const partes = viaSpans.length > 0 ? viaSpans : extrairPartesViaVarreduraGeral(doc);
  return deduplicarPartes(partes);
}

/**
 * Dedup por documento (CPF/CNPJ): se o mesmo documento aparece em
 * múltiplas partes (ex.: capa + timeline + retificação de autuação),
 * preserva apenas uma — preferindo o nome "mais limpo" (mais curto +
 * sem prefixos de movimento). Partes sem documento ficam todas (não
 * dá pra deduplicar com segurança).
 */
function deduplicarPartes(partes: readonly PJeParte[]): PJeParte[] {
  const porDoc = new Map<string, PJeParte>();
  const semDoc: PJeParte[] = [];
  for (const p of partes) {
    const docKey = (p.documento ?? '').replace(/\D/g, '');
    if (!docKey) {
      semDoc.push(p);
      continue;
    }
    const existing = porDoc.get(docKey);
    if (!existing) {
      porDoc.set(docKey, p);
      continue;
    }
    // Mantém o nome mais curto (heurística: nomes longos vieram de
    // textos de movimento como "Recebida a denúncia contra...").
    if (p.nome.length < existing.nome.length) {
      porDoc.set(docKey, p);
    }
  }
  return [...porDoc.values(), ...semDoc];
}

// ── Detalhes da capa (classe, assunto, autuação, vara, etc.) ─────

/**
 * Texto observado na capa do processo (sequencial no body):
 *
 *   Detalhes Detalhes Polo Ativo Polo Passivo
 *   Classe judicial AÇÃO PENAL - PROCEDIMENTO ORDINÁRIO (283)
 *   Assunto Estelionato Majorado (3432)
 *   Jurisdição CE / Fortaleza
 *   Autuação 28 abr 2026
 *   Última distribuição 28 abr 2026
 *   Valor da causa 0,00
 *   Segredo de justiça? NÃO
 *   Justiça gratuita? NÃO
 *   Tutela/liminar? NÃO
 *   Prioridade? NÃO
 *   Órgão julgador 32ª Vara Federal CE
 *   Cargo judicial Juiz Federal Substituto
 *   Competência PENAL
 *
 * Cada par é "label valor" adjacente. Como os labels são únicos no body,
 * regex sobre `body.textContent` funciona sem ambiguidade.
 */

const MESES_REGEX_PT = /\b(\d{1,2})\s+(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s+(\d{4})\b/i;

function dataExtenseParaIso(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = s.match(MESES_REGEX_PT);
  if (!m) return null;
  const mes = MESES_PT[m[2]!.toLowerCase().slice(0, 3)];
  if (!mes) return null;
  return `${m[3]}-${mes}-${m[1]!.padStart(2, '0')}`;
}

function simNaoToBool(s: string | undefined | null): boolean | null {
  if (!s) return null;
  const t = s.trim().toUpperCase();
  if (t === 'SIM') return true;
  if (t === 'NÃO' || t === 'NAO') return false;
  return null;
}

/**
 * Extrai detalhes da capa do processo via regex sobre `body.textContent`.
 * Os labels são únicos e aparecem em ordem fixa no DOM da capa, então
 * regex funciona como heurística simples e estável.
 */
export function extrairDetalhesProcesso(
  doc: Document = document
): PJeDetalhesProcesso | null {
  const txt = (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!txt) return null;

  // Sentinela: se nem "Classe judicial" aparece, a capa não carregou.
  if (!/Classe judicial\s/i.test(txt)) return null;

  // Pega o texto de uma label até a próxima label conhecida.
  // O conjunto de labels seguintes é o stop-set para evitar greedy match.
  // "Polo ativo"/"Polo passivo" entram no stop-set porque aparecem
  // imediatamente DEPOIS de "Competência" (último label da capa) — sem
  // eles, o regex de Competência come o resto inteiro do body.
  const labels = [
    'Classe judicial',
    'Assunto',
    'Jurisdição',
    'Autuação',
    'Última distribuição',
    'Valor da causa',
    'Segredo de justiça\\?',
    'Justiça gratuita\\?',
    'Tutela/liminar\\?',
    'Prioridade\\?',
    'Órgão julgador',
    'Cargo judicial',
    'Competência',
    'Polo ativo',
    'Polo passivo'
  ];
  const stopSet = labels.join('|');

  function pickAfter(label: string): string | null {
    const re = new RegExp(`${label}\\s+(.+?)(?=\\s+(?:${stopSet})|$)`, 'i');
    const m = txt.match(re);
    return m ? m[1]!.trim() : null;
  }

  const classeStr = pickAfter('Classe judicial');
  let classeCnj: number | null = null;
  let classeNome: string | null = null;
  if (classeStr) {
    const m = classeStr.match(/^(.+?)\s*\((\d+)\)\s*$/);
    if (m) {
      classeNome = m[1]!.trim();
      classeCnj = Number(m[2]);
    } else {
      classeNome = classeStr;
    }
  }

  const assuntoStr = pickAfter('Assunto');
  let assunto: string | null = null;
  let assuntoCodigo: number | null = null;
  if (assuntoStr) {
    const m = assuntoStr.match(/^(.+?)\s*\((\d+)\)\s*$/);
    if (m) {
      assunto = m[1]!.trim();
      assuntoCodigo = Number(m[2]);
    } else {
      assunto = assuntoStr;
    }
  }

  return {
    classeCnj,
    classeNome,
    assunto,
    assuntoCodigo,
    dataAutuacao: dataExtenseParaIso(pickAfter('Autuação')),
    dataUltimaDistribuicao: dataExtenseParaIso(pickAfter('Última distribuição')),
    orgaoJulgador: pickAfter('Órgão julgador'),
    competencia: pickAfter('Competência'),
    jurisdicao: pickAfter('Jurisdição'),
    segredoJustica: simNaoToBool(pickAfter('Segredo de justiça\\?')),
    justicaGratuita: simNaoToBool(pickAfter('Justiça gratuita\\?')),
    tutelaLiminar: simNaoToBool(pickAfter('Tutela/liminar\\?')),
    prioridade: pickAfter('Prioridade\\?')
  };
}

// ── Lazy-loading da timeline ────────────────────────────────────

/**
 * O PJe legacy usa **lazy loading** na timeline de movimentos/
 * documentos: a página inicial carrega só os primeiros N itens e
 * adiciona mais conforme o usuário scrolla até o fim. Em processos
 * com muitos anexos (50+ peças), uma extração feita logo após o
 * load da página perde a maioria dos documentos — incluindo a
 * denúncia inicial, que normalmente está "lá embaixo" no fluxo
 * cronológico.
 *
 * Esta função força o carregamento completo da árvore antes da
 * extração, scrollando programaticamente o container scrollável até
 * que o número de links de documento `<a href*="/documento/download/">`
 * estabilize (3 ciclos consecutivos sem novos elementos).
 *
 * Estratégia:
 *   1. Localiza o container scrollável (timeline ou ancestral
 *      `overflow-y` auto/scroll).
 *   2. Loop de scroll: `el.scrollTop = el.scrollHeight`. Aguarda
 *      `intervaloMs` para o JS do PJe carregar a próxima página.
 *   3. Conta links a cada ciclo. Se cresceu, continua; se ficou
 *      igual em 3 ciclos seguidos, considera estável e para.
 *   4. Timeout duro de `timeoutMs` independente de estabilidade.
 *
 * Idempotente — chamar de novo após a árvore estar completa
 * retorna rapidamente (já estável no 1º ciclo).
 */
export interface ResultadoCarregarTimeline {
  /** Quantidade de docs visíveis ANTES de qualquer scroll. */
  docsAntes: number;
  /** Quantidade de docs visíveis APÓS estabilização. */
  docsDepois: number;
  /** Ciclos de scroll executados. */
  ciclos: number;
  /** True se parou por estabilidade; false se parou por timeout. */
  estabilizou: boolean;
  /** Container scrollável encontrado (descrição leve para diagnóstico). */
  containerInfo: string;
}

const SELETOR_LINK_DOC =
  'a[href*="/documento/download/"], a[href*="ConsultaDocumento"], ' +
  'a[href*="downloadBinario"], a[href*="idProcessoDocumento"]';

function contarLinksDocumento(): number {
  return document.querySelectorAll(SELETOR_LINK_DOC).length;
}

/**
 * Acha um container scrollável: começa pela timeline conhecida e
 * sobe até achar um ancestral cujo `overflow-y` permita scroll.
 * Cai no `document.scrollingElement` (window) se nada bater.
 */
function localizarContainerScrollavel(): HTMLElement {
  const timeline = document.getElementById('divTimeLine');
  let cur: HTMLElement | null = timeline ?? document.querySelector('.eventos-timeline');
  while (cur) {
    const style = window.getComputedStyle(cur);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) {
      return cur;
    }
    cur = cur.parentElement;
  }
  // Fallback: o body/html
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

export async function carregarTimelineCompleta(
  timeoutMs = 15_000,
  intervaloMs = 800
): Promise<ResultadoCarregarTimeline> {
  const docsAntes = contarLinksDocumento();
  const container = localizarContainerScrollavel();
  const containerInfo =
    container.id ? `#${container.id}` :
    container.className ? `.${container.className.split(/\s+/)[0]}` :
    container.tagName.toLowerCase();

  const inicio = Date.now();
  let docsDepois = docsAntes;
  let ciclosEstaveis = 0;
  let ciclos = 0;
  let estabilizou = false;
  const ESTAVEL_LIMITE = 3;

  while (Date.now() - inicio < timeoutMs) {
    // Scroll até o fim do container.
    try {
      container.scrollTop = container.scrollHeight;
    } catch {
      /* container pode não aceitar scroll programático */
    }
    // Em alguns layouts, scrollar a window também ajuda (PJe usa
    // ambos — body scroll + container interno).
    try {
      window.scrollTo(0, document.documentElement.scrollHeight);
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, intervaloMs));
    ciclos++;
    const docsAtual = contarLinksDocumento();
    if (docsAtual === docsDepois) {
      ciclosEstaveis++;
      if (ciclosEstaveis >= ESTAVEL_LIMITE) {
        estabilizou = true;
        break;
      }
    } else {
      ciclosEstaveis = 0;
      docsDepois = docsAtual;
    }
  }

  // Scroll de volta ao topo pra não atrapalhar quem use a aba depois.
  try {
    container.scrollTop = 0;
    window.scrollTo(0, 0);
  } catch {
    /* ignore */
  }

  return { docsAntes, docsDepois, ciclos, estabilizou, containerInfo };
}

// ── Movimentos ──────────────────────────────────────────────────

function classificarMovimentoPorTexto(
  texto: string
): MovimentoCriminal | undefined {
  const t = texto.toLowerCase();
  if (!t) return undefined;
  let melhor: MovimentoCriminal | undefined;
  let melhorTamanho = 0;
  for (const mov of MOVIMENTOS_CRIMINAIS) {
    if (mov.isAgrupador) continue;
    const nomeNorm = mov.nome.toLowerCase();
    if (t.includes(nomeNorm) && nomeNorm.length > melhorTamanho) {
      melhor = mov;
      melhorTamanho = nomeNorm.length;
    }
  }
  return melhor;
}

const MESES_PT: Record<string, string> = {
  jan: '01', fev: '02', mar: '03', abr: '04',
  mai: '05', jun: '06', jul: '07', ago: '08',
  set: '09', out: '10', nov: '11', dez: '12'
};

function tentarExtrairData(textos: string[]): string | null {
  for (const t of textos) {
    if (!t) continue;
    const br = t.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    const ext = t.match(/(\d{1,2})\s+([a-z]{3,4})\s+(\d{4})/i);
    if (ext) {
      const mes = MESES_PT[ext[2]!.toLowerCase().slice(0, 3)];
      if (mes) {
        const dia = ext[1]!.padStart(2, '0');
        return `${ext[3]}-${mes}-${dia}`;
      }
    }
  }
  return null;
}

/**
 * Heurística para rejeitar items que são DOCUMENTOS, não MOVIMENTOS.
 * Documentos no PJe legacy aparecem com prefixo `<NUMERO_LONGO> - `,
 * ex.: "147222786 - Petição (outras) (...)". Já movimentos são frases
 * em caixa alta como "DECORRIDO PRAZO DE...", "JUNTADA DE CERTIDÃO".
 */
function pareceItemDeDocumento(texto: string): boolean {
  return /^\d{6,}\s*[-–]\s*/.test(texto);
}

/**
 * Conta ocorrências de timestamp `HH:MM` num texto. Usado pra detectar
 * "match de wrapper" — quando o seletor DOM acerta o container ao invés
 * de cada item, o textContent contém múltiplos timestamps.
 */
function contarTimestamps(texto: string): number {
  const m = texto.match(/\b\d{2}:\d{2}\b/g);
  return m ? m.length : 0;
}

/**
 * Localiza o container DOM da timeline da capa do processo. Restringe
 * a extração de movimentos a esse subtree — evita que labels da capa
 * ("Última distribuição 28 abr 2026", "Autuação 28 abr 2026") sejam
 * confundidos com headers de data da timeline.
 */
function localizarTimelineRoot(doc: Document): Element | null {
  return (
    doc.getElementById('divTimeLine') ??
    doc.querySelector('.eventos-timeline') ??
    doc.querySelector('[id^="divTimeLine"]') ??
    null
  );
}

/**
 * Extrai movimentos da timeline lateral via DOM. Usa múltiplos
 * seletores como fallback (a estrutura JSF/RichFaces do PJe legacy
 * pode mudar entre versões).
 *
 * Validação anti-wrapper: rejeita elementos cujo `textContent` contém
 * mais de UM timestamp HH:MM — sinal claro de que o seletor pegou um
 * container, não um item-folha.
 */
function extrairMovimentosViaDOM(doc: Document): PJeMovimento[] {
  const movs: PJeMovimento[] = [];
  // Restringe ao container da timeline. Sem isso, seletores genéricos
  // ("li", etc.) batem em itens da capa do processo (ex.: "Última
  // distribuição 28 abr 2026") e geram falsos movimentos.
  const root = localizarTimelineRoot(doc);
  if (!root) return movs;

  const seletoresRelativos = [
    'li',
    '[class*="evento"]',
    '[id^="divTimeLine:event"]',
    '.item',
    '.movimento'
  ];
  let candidatos: Element[] = [];
  for (const sel of seletoresRelativos) {
    const els = root.querySelectorAll(sel);
    if (els.length > 0) {
      const validos = Array.from(els).filter((el) => {
        const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        return t.length > 0 && contarTimestamps(t) <= 1 && t.length < 500;
      });
      if (validos.length > 0 && validos.length >= els.length * 0.5) {
        candidatos = validos;
        break;
      }
    }
  }
  if (candidatos.length === 0) return movs;

  let dataAtual: string | null = null;
  for (const el of candidatos) {
    const texto = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!texto) continue;
    const dataExtraida = tentarExtrairData([texto]);
    if (dataExtraida && texto.length < 24) {
      dataAtual = dataExtraida;
      continue;
    }
    const dataItem = dataExtraida ?? dataAtual;
    if (!dataItem) continue;
    if (pareceItemDeDocumento(texto)) continue;
    const meta = classificarMovimentoPorTexto(texto);
    movs.push({
      codigo: meta?.codigo ?? 0,
      nome: meta?.nome ?? texto.slice(0, 200),
      data: dataItem,
      complemento: null
    });
  }
  return movs;
}

/**
 * Localiza onde, no `body.textContent`, começam os scripts inline (que
 * vêm como texto após o conteúdo visível). Devolve o índice do primeiro
 * marcador encontrado ou -1.
 */
function indiceInicioScripts(body: string): number {
  const marcadores = [
    '//<![CDATA[',
    'function clear_',
    'A4J.AJAX.Poll',
    'new Richfaces.',
    'new ModalPanel',
    'window.addEventListener',
    'document.getElementById'
  ];
  let menor = -1;
  for (const m of marcadores) {
    const i = body.indexOf(m);
    if (i !== -1 && (menor === -1 || i < menor)) menor = i;
  }
  return menor;
}

/**
 * Fallback de varredura por texto puro do body. Estratégia:
 *
 *   1. Recorta o body até o primeiro marcador de script JS (timeline
 *      sempre vem ANTES do código injetado).
 *   2. Localiza data headers no padrão `DD <mês> YYYY`.
 *   3. Para cada seção entre dois headers, divide por `HH:MM` (que
 *      delimita itens). Para cada chunk antes de um timestamp:
 *      - Se contém um padrão de documento `<NUMERO> - <Tipo>`, pega só
 *        o trecho ANTES do número (que é o movimento — o resto vira
 *        documento atrelado).
 *      - Se o chunk em si parece documento, pula.
 *      - Caso contrário, registra como movimento.
 */
function extrairMovimentosViaTexto(doc: Document): PJeMovimento[] {
  // Restringe ao container da timeline (mesmo motivo do extrator DOM).
  // Sem isso, datas da capa ("Autuação", "Última distribuição") viram
  // falsos headers e poluem o resultado.
  const root = localizarTimelineRoot(doc);
  let body = ((root ?? doc.body)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return [];

  // Corta na primeira ocorrência de script — timeline está sempre antes.
  const scriptStart = indiceInicioScripts(body);
  if (scriptStart > 0) body = body.slice(0, scriptStart);

  const movs: PJeMovimento[] = [];

  const dateRe = /\b(\d{1,2})\s+(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\s+(\d{4})\b/gi;
  type DateMatch = { iso: string; index: number; raw: string };
  const dateHeaders: DateMatch[] = [];
  for (const m of body.matchAll(dateRe)) {
    const mes = MESES_PT[m[2]!.toLowerCase().slice(0, 3)];
    if (!mes) continue;
    dateHeaders.push({
      iso: `${m[3]}-${mes}-${m[1]!.padStart(2, '0')}`,
      index: m.index ?? 0,
      raw: m[0]
    });
  }
  if (dateHeaders.length === 0) return [];

  for (let i = 0; i < dateHeaders.length; i++) {
    const inicio = dateHeaders[i]!.index + dateHeaders[i]!.raw.length;
    const fim = i + 1 < dateHeaders.length ? dateHeaders[i + 1]!.index : body.length;
    const trecho = body.slice(inicio, fim);

    // Quebra a seção em pedaços antes de cada HH:MM.
    // Cada pedaço é "<descrição>" do item que termina naquele timestamp.
    const partes = trecho.split(/\s+(\d{2}:\d{2})\s+/);
    // partes alterna: [desc, hh:mm, desc, hh:mm, desc] (último sem hh:mm)
    for (let j = 0; j < partes.length; j += 2) {
      let desc = (partes[j] ?? '').trim();
      if (!desc) continue;

      // Se a descrição contém um marcador de documento no meio
      // ("<NUMERO_LONGO> - "), o que vem ANTES é o movimento e o que
      // vem DEPOIS é documento atrelado. Capturamos só o movimento.
      const docMarker = desc.match(/^(.+?)\s+\d{6,}\s*[-–]\s*/);
      if (docMarker) desc = docMarker[1]!.trim();

      if (!desc || desc.length > 300) continue;
      if (pareceItemDeDocumento(desc)) continue;

      const meta = classificarMovimentoPorTexto(desc);
      movs.push({
        codigo: meta?.codigo ?? 0,
        nome: meta?.nome ?? desc,
        data: dateHeaders[i]!.iso,
        complemento: null
      });
    }
  }
  return movs;
}

export function extrairMovimentosDoDOM(doc: Document = document): PJeMovimento[] {
  const viaDom = extrairMovimentosViaDOM(doc);
  if (viaDom.length > 0) return viaDom;
  return extrairMovimentosViaTexto(doc);
}

// ── Diagnóstico ──────────────────────────────────────────────────

export interface ExtractorDiagnostic {
  partesEncontradas: number;
  movimentosEncontrados: number;
  movimentosClassificados: number;
  partesPolos: { ativo: number; passivo: number; outros: number };
  alertas: string[];
  /** Diagnóstico cru do DOM para debug — só preenchido quando há falha. */
  domDebug?: DomDebug;
}

interface DomDebug {
  url: string;
  title: string;
  bodyLength: number;
  tituloDosAutos: string | null;
  /** Menção textual de papéis processuais (AUTOR, REU, etc.) na página. */
  hasParteMarcadores: boolean;
  /** 5 primeiros textos curtos contendo "CPF" ou "CNPJ". */
  amostraComDocumento: string[];
  /** Total de elementos do DOM (sanidade). */
  totalElementos: number;
  /** Quantidade de spans com classe text-bold. */
  totalSpansTextBold: number;
  /** Trecho inicial do body.textContent (primeiros 1000 chars). */
  textoInicialBody: string;
}

function coletarDomDebug(doc: Document = document): DomDebug {
  const body = doc.body;
  const bodyText = (body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const tituloDosAutos =
    doc
      .querySelector<HTMLElement>('[id*="tituloProcesso"], h1.titulo-autos, .pje-title')
      ?.textContent?.trim() ?? null;

  const amostra: string[] = [];
  const todos = doc.querySelectorAll<HTMLElement>('*');
  for (const el of todos) {
    if (amostra.length >= 5) break;
    if (el.children.length > 0) continue;
    const t = (el.textContent ?? '').trim();
    if (!t || t.length > 200) continue;
    if (/\b(CPF|CNPJ)[:\s]+/i.test(t)) amostra.push(t);
  }

  return {
    url: window.location.href,
    title: doc.title,
    bodyLength: bodyText.length,
    tituloDosAutos,
    hasParteMarcadores: temMarcadoresDePartes(doc),
    amostraComDocumento: amostra,
    totalElementos: todos.length,
    totalSpansTextBold: doc.querySelectorAll('span.text-bold').length,
    textoInicialBody: bodyText.slice(0, 1000)
  };
}

export function diagnosticarExtractor(
  doc: Document = document
): ExtractorDiagnostic {
  const partes = extrairPartesDoDOM(doc);
  const movimentos = extrairMovimentosDoDOM(doc);
  const alertas: string[] = [];
  if (partes.length === 0) {
    alertas.push(
      'Nenhuma parte extraída — provavelmente o painel "Detalhes do processo" ' +
        'não está aberto ou os seletores não bateram.'
    );
  }
  if (movimentos.length === 0) {
    alertas.push(
      'Nenhum movimento extraído — DOM da timeline não foi reconhecido pelos seletores.'
    );
  }
  const polos = partes.reduce(
    (acc, p) => {
      acc[p.tipoPolo] = (acc[p.tipoPolo] ?? 0) + 1;
      return acc;
    },
    { ativo: 0, passivo: 0, outros: 0 } as Record<PJeParte['tipoPolo'], number>
  );
  const diag: ExtractorDiagnostic = {
    partesEncontradas: partes.length,
    movimentosEncontrados: movimentos.length,
    movimentosClassificados: movimentos.filter((m) => m.codigo !== 0).length,
    partesPolos: polos,
    alertas
  };
  // Inclui dump do DOM quando algo falhou — facilita debug remoto.
  if (partes.length === 0 || movimentos.length === 0) {
    diag.domDebug = coletarDomDebug(doc);
  }
  return diag;
}

console.debug(`${LOG_PREFIX} criminal-extractor carregado`);
