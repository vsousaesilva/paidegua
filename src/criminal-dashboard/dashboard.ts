/**
 * Dashboard Sigcrim — listagem do acervo criminal local-first.
 *
 * Responsabilidade desta v1:
 *   - Lê todos os processos do IndexedDB (`paidegua.criminal`) na carga.
 *   - KPIs: total primário/auxiliar, réus, ANPP em cumprimento.
 *   - Filtros locais (sem hit no IDB): trilha (primária/auxiliar),
 *     categoria, status ANPP, busca por número/nome do réu.
 *   - Tabela paginada (50 por página). Click numa linha abre painel
 *     lateral READ-ONLY com detalhes do processo + réus.
 *   - Botões de atalho: "Nova varredura" abre PJe (necessário para o
 *     coordenador disparar `abrirSigcrim`); "Configurações" abre
 *     `criminal-config`.
 *
 * Edição inline + abrir-no-PJe ficam para a próxima rodada.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../shared/constants';
import {
  CATEGORIA_LABELS,
  CLASSES_CRIMINAIS,
  type CategoriaCriminal
} from '../shared/criminal-classes';
import { listAllProcessos } from '../shared/criminal-store';
import type {
  Processo,
  ProcessoPayload,
  Reu,
  ResultadoSerp,
  StatusAnpp,
  TraceEntry
} from '../shared/criminal-types';
import {
  RESULTADO_SERP_VALUES,
  STATUS_ANPP_VALUES
} from '../shared/criminal-types';
import {
  calcularPrescricao,
  formatarTempoRestante,
  LABEL_STATUS_PRESCRICAO,
  statusPrescricaoAgregado,
  type ResultadoPrescricao,
  type StatusPrescricao
} from '../shared/prescricao-calc';
import {
  calcularGestaoAnpp,
  ICONE_STATUS_GESTAO_ANPP,
  LABEL_STATUS_GESTAO_ANPP,
  statusGestaoAnppAgregado,
  type ResultadoGestaoAnpp,
  type StatusGestaoAnpp
} from '../shared/anpp-gestao';
import {
  OPEN_TASK_ICON_SVG,
  podeAbrirTarefa
} from '../shared/pje-task-popup';
import { parsePdf } from '../content/pdf-parser';
import { ocrPdf } from '../content/ocr';

// ── Ícones (SVG inline) ─────────────────────────────────────────

const COPY_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
  '</svg>';

// ── Estado global do dashboard ──────────────────────────────────

interface DashState {
  /** Acervo bruto carregado do IDB. */
  processos: Processo[];
  /** Lista filtrada (resultado da aplicação dos filtros + busca). */
  filtrados: Processo[];
  /** Página corrente (0-based). */
  pagina: number;
  /** Filtros ativos. */
  filtros: {
    busca: string;
    trilha: 'todas' | 'primaria' | 'auxiliar';
    categoria: '' | CategoriaCriminal;
    statusAnpp: '' | StatusAnpp;
    completude: '' | 'completo' | 'incompleto';
    prescricao: '' | StatusPrescricao;
    gestaoAnpp: '' | StatusGestaoAnpp;
  };
}

const PAGE_SIZE = 50;

const state: DashState = {
  processos: [],
  filtrados: [],
  pagina: 0,
  filtros: {
    busca: '',
    trilha: 'primaria',
    categoria: '',
    statusAnpp: '',
    completude: '',
    prescricao: '',
    gestaoAnpp: ''
  }
};

// ── Cache de cálculo de prescrição ─────────────────────────────
//
// Calcular a prescrição é puro mas roda muitas vezes (por linha
// na tabela + agregado para KPI/filtro). Cacheamos por processoId
// e invalidamos quando o processo muda no IDB. Chave inclui um
// hash leve dos dados que afetam o cálculo (datas + penas + 366).
const cachePrescricao = new Map<
  string,
  {
    chave: string;
    resultadosPorReu: ResultadoPrescricao[];
    statusAgregado: StatusPrescricao;
  }
>();

function chaveCachePrescricao(p: Processo): string {
  const partes = [
    p.id,
    p.data_fato ?? '',
    p.data_recebimento_denuncia ?? '',
    ...p.reus.flatMap((r) => [
      r.id,
      r.pena_maxima_abstrato ?? '',
      r.pena_aplicada_concreto ?? '',
      r.data_sentenca ?? '',
      r.suspenso_366 ? '1' : '0',
      r.data_inicio_suspensao ?? '',
      r.data_fim_suspensao ?? '',
      r.reincidente ? '1' : '0',
      r.data_nascimento ?? ''
    ])
  ];
  return partes.join('|');
}

function prescricaoDoProcesso(p: Processo): {
  resultadosPorReu: ResultadoPrescricao[];
  statusAgregado: StatusPrescricao;
} {
  const chave = chaveCachePrescricao(p);
  const cached = cachePrescricao.get(p.id);
  if (cached && cached.chave === chave) return cached;
  const resultadosPorReu = p.reus.map((r) =>
    calcularPrescricao({
      pena_maxima_abstrato: r.pena_maxima_abstrato,
      pena_aplicada_concreto: r.pena_aplicada_concreto,
      data_fato: p.data_fato,
      data_recebimento_denuncia: p.data_recebimento_denuncia,
      data_sentenca: r.data_sentenca,
      suspenso_366: r.suspenso_366,
      data_inicio_suspensao: r.data_inicio_suspensao,
      data_fim_suspensao: r.data_fim_suspensao,
      reincidente: r.reincidente,
      data_nascimento: r.data_nascimento
    })
  );
  const statusAgregado = statusPrescricaoAgregado(resultadosPorReu);
  const out = { chave, resultadosPorReu, statusAgregado };
  cachePrescricao.set(p.id, out);
  return out;
}

// ── Cache de gestão de ANPP ────────────────────────────────────
//
// Mesma estratégia da prescrição: o cálculo é puro mas roda muitas
// vezes (KPI + filtro + painel lateral). Chave inclui apenas os
// campos do réu que afetam a gestão de ANPP.
const cacheGestaoAnpp = new Map<
  string,
  {
    chave: string;
    resultadosPorReu: ResultadoGestaoAnpp[];
    statusAgregado: StatusGestaoAnpp;
  }
>();

function chaveCacheGestaoAnpp(p: Processo): string {
  const partes = [
    p.id,
    ...p.reus.flatMap((r) => [
      r.id,
      r.status_anpp,
      r.data_homologacao_anpp ?? '',
      r.data_remessa_mpf ?? '',
      r.data_protocolo_seeu ?? '',
      r.ultima_comprovacao_anpp ?? ''
    ])
  ];
  return partes.join('|');
}

function gestaoAnppDoProcesso(p: Processo): {
  resultadosPorReu: ResultadoGestaoAnpp[];
  statusAgregado: StatusGestaoAnpp;
} {
  const chave = chaveCacheGestaoAnpp(p);
  const cached = cacheGestaoAnpp.get(p.id);
  if (cached && cached.chave === chave) return cached;
  const resultadosPorReu = p.reus.map((r) =>
    calcularGestaoAnpp({
      status_anpp: r.status_anpp,
      data_homologacao_anpp: r.data_homologacao_anpp,
      data_remessa_mpf: r.data_remessa_mpf,
      data_protocolo_seeu: r.data_protocolo_seeu,
      ultima_comprovacao_anpp: r.ultima_comprovacao_anpp
    })
  );
  const statusAgregado = statusGestaoAnppAgregado(resultadosPorReu);
  const out = { chave, resultadosPorReu, statusAgregado };
  cacheGestaoAnpp.set(p.id, out);
  return out;
}

function badgePrescricao(p: Processo): string {
  const { statusAgregado, resultadosPorReu } = prescricaoDoProcesso(p);
  const cls = `paidegua-dash__badge--presc-${statusAgregado.replace('_', '-')}`;
  const labelCurto = {
    verde: '🟢 Verde',
    amarelo: '🟡 Atenção',
    vermelho: '🔴 Risco',
    dados_insuficientes: '⚪ Sem dados'
  }[statusAgregado];
  // Tooltip com detalhe do réu mais crítico.
  const tooltip =
    resultadosPorReu
      .map((r, i) => {
        const reu = p.reus[i]?.nome_reu ?? `Réu ${i + 1}`;
        if (r.status === 'dados_insuficientes') {
          return `${reu}: ${r.motivoIncompleto ?? 'dados incompletos'}`;
        }
        return `${reu}: ${formatarTempoRestante(r.diasRestantes ?? 0)}`;
      })
      .join('\n') || 'Sem réus';
  return `<span class="paidegua-dash__badge ${cls}" title="${escapeAttr(tooltip)}">${escapeHtml(labelCurto)}</span>`;
}

/**
 * Estado do modo de edição. `processoId` aponta para o processo
 * aberto no painel lateral; quando `editando` é true, o conteúdo do
 * aside é renderizado como form (inputs no lugar dos spans).
 *
 * Re-render durante edição reaproveita o mesmo estado — o usuário
 * mantém o que digitou enquanto a UI se reconstrói.
 */
const editState: {
  processoId: string | null;
  editando: boolean;
} = {
  processoId: null,
  editando: false
};

// ── Helpers ─────────────────────────────────────────────────────

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado.`);
  return el as T;
}

function fmtIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function fmtIsoDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  } catch {
    return iso;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const escapeAttr = escapeHtml;

/**
 * URL de **fallback** (Consulta Pública por número CNJ) usada quando:
 *   - O usuário faz middle-click ou Ctrl+click no `<a>` (a interceptação
 *     do click não acontece — o navegador segue o `href` literal).
 *   - O registro não tem `id_processo_pje` (capturado antes da extensão
 *     de schema gravar o id).
 *
 * O fluxo "bonito" (autos digitais com `ca`) é assíncrono e vive em
 * `abrirProcessoNoPje`, que precisa do background para gerar a `ca`.
 */
function montarUrlAbrirProcesso(p: Processo): string | null {
  if (!p.hostname_pje) return null;
  const numero = (p.numero_processo ?? '').trim();
  if (!numero) return null;
  const m = numero.match(/[\d.\-]+/);
  const num = m ? m[0] : numero;
  return (
    `https://${p.hostname_pje}/pjeconsulta/ConsultaPublica/listView.seam` +
    `?numeroProcesso=${encodeURIComponent(num)}`
  );
}

/**
 * Abre o processo no PJe via background. O background tenta gerar a
 * `ca` (chave de acesso) usando uma aba PJe ativa e abre direto os
 * autos digitais; se não houver aba ou a geração falhar, cai em
 * Consulta Pública.
 *
 * Usado pelos handlers de click do dashboard (tabela, painel lateral,
 * modal SERP). Sempre devolve `void` — o feedback ao usuário é via
 * toast.
 */
async function abrirProcessoNoPje(p: Processo): Promise<void> {
  if (!p.hostname_pje) {
    showToast('Hostname do PJe não capturado neste processo.');
    return;
  }
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.CRIMINAL_ABRIR_PROCESSO,
      payload: {
        idProcesso: p.id_processo_pje,
        hostnamePje: p.hostname_pje,
        numeroProcesso: p.numero_processo
      }
    })) as {
      ok: boolean;
      modo?: 'autos' | 'consulta-publica';
      url?: string;
      error?: string;
    };
    if (!resp?.ok) {
      showToast(resp?.error ?? 'Falha ao abrir o processo.');
      return;
    }
    if (resp.modo === 'consulta-publica') {
      showToast(
        'Sem aba do PJe ativa para gerar chave de acesso — abrindo Consulta Pública.'
      );
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} abrirProcessoNoPje:`, err);
    showToast(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Abre a tela de movimentação da tarefa atual no PJe. Usa a mesma
 * estratégia de gerar `ca` via background.
 *
 * Caveat: o `id_task_instance` é capturado durante a varredura. Se
 * o processo já saiu da tarefa entre a varredura e o clique, o PJe
 * rejeita com "Usuário sem visibilidade" mesmo com `ca` correta.
 * Nesse caso o usuário deve rodar "Atualizar com PJe + IA" antes,
 * para recapturar a tarefa atual.
 */
async function abrirTarefaNoPje(p: Processo): Promise<void> {
  if (!p.hostname_pje || !p.id_processo_pje || !p.id_task_instance) {
    showToast('Dados insuficientes para abrir a tarefa.');
    return;
  }
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.CRIMINAL_ABRIR_TAREFA,
      payload: {
        idProcesso: p.id_processo_pje,
        idTaskInstance: p.id_task_instance,
        hostnamePje: p.hostname_pje
      }
    })) as { ok: boolean; url?: string; error?: string };
    if (!resp?.ok) {
      showToast(resp?.error ?? 'Falha ao abrir a tarefa.');
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} abrirTarefaNoPje:`, err);
    showToast(err instanceof Error ? err.message : String(err));
  }
}

// ── Toast + clipboard ───────────────────────────────────────────

let toastTimer: number | null = null;
let toastEl: HTMLDivElement | null = null;

function showToast(msg: string): void {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'paidegua-dash__toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.remove('paidegua-dash__toast--visible');
  void toastEl.offsetWidth; // reflow para reiniciar a animação
  toastEl.classList.add('paidegua-dash__toast--visible');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl?.classList.remove('paidegua-dash__toast--visible');
  }, 1800);
}

async function copyToClipboard(text: string, msgOk: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msgOk);
  } catch (err) {
    console.error(`${LOG_PREFIX} dashboard: falha ao copiar:`, err);
    showToast('Não foi possível copiar para a área de transferência.');
  }
}

function truncar(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function nomeClasse(codigoCnj: number): { sigla: string; nomeCurto: string } {
  const c = CLASSES_CRIMINAIS.find((x) => x.codigo === codigoCnj);
  if (c) {
    return { sigla: c.sigla, nomeCurto: truncar(c.nome, 60) };
  }
  return { sigla: '?', nomeCurto: `Classe CNJ ${codigoCnj}` };
}

const ANPP_BADGE_CLASS: Record<StatusAnpp, string> = {
  'Nao Aplicavel': 'paidegua-dash__badge--anpp-na',
  'Em Negociacao': 'paidegua-dash__badge--anpp-neg',
  Homologado: 'paidegua-dash__badge--anpp-homo',
  'Remetido MPF': 'paidegua-dash__badge--anpp-mpf',
  'Protocolado SEEU': 'paidegua-dash__badge--anpp-prot',
  'Em Execucao SEEU': 'paidegua-dash__badge--anpp-exec',
  'Execucao Vara': 'paidegua-dash__badge--anpp-vara',
  Cumprido: 'paidegua-dash__badge--anpp-cumprd'
};

const ANPP_BADGE_LABEL: Record<StatusAnpp, string> = {
  'Nao Aplicavel': 'N/A',
  'Em Negociacao': 'Negociação',
  Homologado: 'Homologado',
  'Remetido MPF': 'Remetido MPF',
  'Protocolado SEEU': 'Protocolado SEEU',
  'Em Execucao SEEU': 'Execução SEEU',
  'Execucao Vara': 'Execução Vara',
  Cumprido: 'Cumprido'
};

function badgeAnpp(status: StatusAnpp): string {
  return `<span class="paidegua-dash__badge ${ANPP_BADGE_CLASS[status]}">${escapeHtml(
    ANPP_BADGE_LABEL[status]
  )}</span>`;
}

function badgeSerp(r: ResultadoSerp): string {
  const cls = {
    Pendente: 'paidegua-dash__badge--serp-pend',
    Negativo: 'paidegua-dash__badge--serp-neg',
    Positivo: 'paidegua-dash__badge--serp-pos'
  }[r];
  return `<span class="paidegua-dash__badge ${cls}">${escapeHtml(r)}</span>`;
}

function badgeOrigem(origem: 'pje' | 'manual' | 'ia' | undefined): string {
  if (!origem) return '';
  const cls = {
    pje: 'paidegua-dash__badge--origem-pje',
    manual: 'paidegua-dash__badge--origem-manual',
    ia: 'paidegua-dash__badge--origem-ia'
  }[origem];
  const label = origem === 'pje' ? 'PJe' : origem === 'ia' ? 'IA' : 'Manual';
  return `<span class="paidegua-dash__badge ${cls}" title="Origem do dado: ${label}">${escapeHtml(label)}</span>`;
}

// ── Completude ──────────────────────────────────────────────────

/**
 * Define quando um processo está "pronto pra trabalhar" — os campos
 * essenciais para os controles de prescrição/ANPP estão preenchidos.
 * O usuário usa essa tag pra priorizar o que enriquecer manualmente
 * ou via "Buscar dados na base do PJe".
 *
 * Critério escolhido (conservador, foco no básico operacional):
 *   - Processo: `tipo_crime`, `data_fato`, `data_recebimento_denuncia`
 *   - Cada réu: `cpf_reu`, `data_nascimento`
 *
 * Campos como pena (máxima/aplicada), data da sentença e SERP NÃO
 * entram — dependem do estado processual e são preenchidos ao longo
 * da vida do processo. Se entrassem, a maioria dos processos novos
 * apareceria como incompleta sem ação razoável a tomar.
 */
export interface AnaliseCompletude {
  completo: boolean;
  /** Labels legíveis dos campos faltantes (em PT-BR). */
  faltando: string[];
}

function analisarCompletude(p: Processo): AnaliseCompletude {
  const faltando: string[] = [];
  if (!p.tipo_crime) faltando.push('Tipo de crime');
  if (!p.data_fato) faltando.push('Data do fato');
  if (!p.data_recebimento_denuncia) faltando.push('Recebimento da denúncia');
  if (p.reus.length === 0) {
    faltando.push('Réu(s)');
  } else {
    let semCpf = 0;
    let semNasc = 0;
    for (const r of p.reus) {
      if (!r.cpf_reu || r.cpf_reu.replace(/\D/g, '').length !== 11) semCpf++;
      if (!r.data_nascimento) semNasc++;
    }
    if (semCpf > 0) {
      faltando.push(
        p.reus.length === 1 ? 'CPF do réu' : `CPF de ${semCpf} réu(s)`
      );
    }
    if (semNasc > 0) {
      faltando.push(
        p.reus.length === 1
          ? 'Data de nascimento do réu'
          : `Nascimento de ${semNasc} réu(s)`
      );
    }
  }
  return { completo: faltando.length === 0, faltando };
}

function badgeCompletude(p: Processo): string {
  const a = analisarCompletude(p);
  if (a.completo) {
    return `<span class="paidegua-dash__badge paidegua-dash__badge--completo" title="Todos os dados essenciais preenchidos">✓ Completo</span>`;
  }
  const tooltip = `Faltando: ${a.faltando.join(', ')}`;
  return `<span class="paidegua-dash__badge paidegua-dash__badge--incompleto" title="${escapeAttr(tooltip)}">${a.faltando.length} faltando</span>`;
}

/**
 * Status ANPP "agregado" do processo: pega o réu mais avançado no
 * fluxo (Cumprido é o mais avançado; Não Aplicável é o mais inicial).
 */
function statusAnppDoProcesso(p: Processo): StatusAnpp {
  const ordem: StatusAnpp[] = [
    'Cumprido',
    'Execucao Vara',
    'Em Execucao SEEU',
    'Protocolado SEEU',
    'Remetido MPF',
    'Homologado',
    'Em Negociacao',
    'Nao Aplicavel'
  ];
  for (const s of ordem) {
    if (p.reus.some((r) => r.status_anpp === s)) return s;
  }
  return 'Nao Aplicavel';
}

function resultadoSerpDoProcesso(p: Processo): ResultadoSerp {
  if (p.reus.some((r) => r.resultado_serp === 'Positivo')) return 'Positivo';
  if (p.reus.every((r) => r.resultado_serp === 'Negativo') && p.reus.length > 0) {
    return 'Negativo';
  }
  return 'Pendente';
}

// ── Filtros ─────────────────────────────────────────────────────

function aplicarFiltros(): void {
  const { busca, trilha, categoria, statusAnpp, completude, prescricao, gestaoAnpp } =
    state.filtros;
  const buscaNorm = busca.trim().toLowerCase();

  state.filtrados = state.processos.filter((p) => {
    if (trilha === 'primaria' && !p.is_classe_primaria) return false;
    if (trilha === 'auxiliar' && p.is_classe_primaria) return false;
    if (categoria && p.classe_categoria !== categoria) return false;
    if (statusAnpp && statusAnppDoProcesso(p) !== statusAnpp) return false;
    if (completude) {
      const c = analisarCompletude(p).completo;
      if (completude === 'completo' && !c) return false;
      if (completude === 'incompleto' && c) return false;
    }
    if (prescricao) {
      const sp = prescricaoDoProcesso(p).statusAgregado;
      if (sp !== prescricao) return false;
    }
    if (gestaoAnpp) {
      const sg = gestaoAnppDoProcesso(p).statusAgregado;
      if (sg !== gestaoAnpp) return false;
    }
    if (buscaNorm) {
      const haystack = [
        p.numero_processo.toLowerCase(),
        ...p.reus.map((r) => r.nome_reu.toLowerCase()),
        ...p.reus.map((r) => (r.cpf_reu ?? '').toLowerCase())
      ].join(' | ');
      if (!haystack.includes(buscaNorm)) return false;
    }
    return true;
  });

  // Ordenação: mais recentes primeiro (por data_recebimento_denuncia,
  // fallback para data_atualização).
  state.filtrados.sort((a, b) => {
    const da = a.data_recebimento_denuncia ?? a.atualizado_em;
    const db = b.data_recebimento_denuncia ?? b.atualizado_em;
    return db.localeCompare(da);
  });

  state.pagina = 0;
  renderTabela();
  renderResultadoInfo();
}

function renderResultadoInfo(): void {
  const total = state.processos.length;
  const filtrados = state.filtrados.length;
  $<HTMLElement>('resultado-info').textContent =
    filtrados === total
      ? `${total} processo(s) no acervo.`
      : `${filtrados} de ${total} processo(s) — filtros ativos.`;
}

// ── Renderização da tabela ─────────────────────────────────────

function renderTabela(): void {
  const tbody = $<HTMLTableSectionElement>('tbody-processos');
  const inicio = state.pagina * PAGE_SIZE;
  const pagina = state.filtrados.slice(inicio, inicio + PAGE_SIZE);

  if (pagina.length === 0) {
    tbody.innerHTML = `
      <tr class="paidegua-dash__row-vazio">
        <td colspan="9">
          ${
            state.processos.length === 0
              ? 'Acervo vazio. Clique em "Nova varredura" para popular.'
              : 'Nenhum processo bate com os filtros atuais.'
          }
        </td>
      </tr>
    `;
    renderPaginacao();
    return;
  }

  const linhas: string[] = [];
  for (const p of pagina) {
    const classe = nomeClasse(p.classe_cnj);
    const reu0 = p.reus[0];
    const reuNome = reu0 ? escapeHtml(reu0.nome_reu) : '<em>—</em>';
    const reuExtra =
      p.reus.length > 1
        ? `<span class="paidegua-dash__col-reu-extra">+${p.reus.length - 1}</span>`
        : '';
    const dataRec = fmtIsoDate(p.data_recebimento_denuncia);
    const sync = fmtIsoDateTime(p.ultima_sincronizacao_pje);
    linhas.push(`
      <tr data-id="${escapeHtml(p.id)}">
        <td class="paidegua-dash__col-numero">${renderProcCell(p)}</td>
        <td class="paidegua-dash__col-classe">
          <strong>${escapeHtml(classe.sigla)}</strong>
          <small>${escapeHtml(classe.nomeCurto)}</small>
        </td>
        <td class="paidegua-dash__col-reu">${reuNome}${reuExtra}</td>
        <td class="paidegua-dash__col-presc">${badgePrescricao(p)}</td>
        <td class="paidegua-dash__col-status">${badgeCompletude(p)}</td>
        <td class="paidegua-dash__col-data">${dataRec}</td>
        <td class="paidegua-dash__col-anpp">${badgeAnpp(statusAnppDoProcesso(p))}</td>
        <td class="paidegua-dash__col-serp">${badgeSerp(resultadoSerpDoProcesso(p))}</td>
        <td class="paidegua-dash__col-sync">${sync}</td>
      </tr>
    `);
  }
  tbody.innerHTML = linhas.join('');

  // Click handler nas linhas — só abre detalhe se o clique NÃO foi
  // num botão/link da coluna nº processo (esses têm comportamento próprio).
  for (const tr of Array.from(tbody.querySelectorAll<HTMLTableRowElement>('tr[data-id]'))) {
    tr.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest('.paidegua-dash__proc-cell-actions')) return;
      const id = tr.getAttribute('data-id');
      if (id) abrirDetalhe(id);
    });
  }

  renderPaginacao();
}

/**
 * Célula da coluna "Nº processo": número como hiperlink (abre busca
 * no PJe), botão de copiar, botão de abrir tarefa (quando houver
 * `id_task_instance`). Os botões usam delegation de clique no document.
 */
function renderProcCell(p: Processo): string {
  const numero = p.numero_processo || '—';
  // O `href` aponta sempre para a Consulta Pública por número CNJ —
  // serve de fallback "honrável" para middle-click / Ctrl+click do
  // usuário (que escapam do listener) e para registros antigos sem
  // `id_processo_pje`. O click normal (left-click) é interceptado e
  // chama `abrirProcessoNoPje`, que roteia pelo background para
  // gerar `ca` e abrir os autos digitais direto.
  const urlFallback = montarUrlAbrirProcesso(p);
  const tituloLink = p.id_processo_pje
    ? 'Abrir os autos digitais no PJe'
    : 'Abrir consulta pública (registro antigo, sem idProcesso capturado)';
  const main = urlFallback
    ? `<a class="paidegua-dash__proc-link" href="${escapeAttr(urlFallback)}" target="_blank" rel="noopener noreferrer" data-processo-id="${escapeAttr(p.id)}" title="${escapeAttr(tituloLink)}">${escapeHtml(numero)}</a>`
    : `<span class="paidegua-dash__proc-link paidegua-dash__proc-link--disabled" title="Hostname do PJe não capturado neste processo — refaça a varredura">${escapeHtml(numero)}</span>`;

  const copyBtn =
    `<button type="button" class="paidegua-dash__proc-copy" data-cnj="${escapeAttr(numero)}" ` +
    `title="Copiar número do processo" aria-label="Copiar número do processo ${escapeAttr(numero)}">` +
    `${COPY_ICON_SVG}</button>`;

  let openTaskBtn = '';
  const idProc = p.id_processo_pje != null ? String(p.id_processo_pje) : null;
  const idTask = p.id_task_instance != null ? String(p.id_task_instance) : null;
  if (podeAbrirTarefa(idProc, idTask) && p.hostname_pje) {
    openTaskBtn =
      `<button type="button" class="paidegua-dash__proc-open-task" ` +
      `data-processo-id="${escapeAttr(p.id)}" ` +
      `title="Abrir tarefa no PJe (movimentar)" aria-label="Abrir tarefa do processo ${escapeAttr(numero)}">` +
      `${OPEN_TASK_ICON_SVG}</button>`;
  }

  return (
    `<span class="paidegua-dash__proc-cell">` +
      `${main}` +
      `<span class="paidegua-dash__proc-cell-actions">${copyBtn}${openTaskBtn}</span>` +
    `</span>`
  );
}

/**
 * Delegation única para os atalhos da coluna nº processo: copiar
 * número e abrir tarefa. Instalada uma vez no DOMContentLoaded —
 * evita rebind a cada `renderTabela()`.
 */
function instalarDelegacaoProcCell(): void {
  document.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    const copyBtn = target.closest<HTMLElement>('.paidegua-dash__proc-copy');
    if (copyBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const cnj = copyBtn.dataset.cnj || '';
      if (!cnj) return;
      void copyToClipboard(cnj, `Número copiado: ${cnj}`);
      return;
    }

    // Intercepta o click no link do nº processo: a `href` aponta para
    // a Consulta Pública (fallback). O click normal (left-click sem
    // teclas modificadoras) é redirecionado para o pipeline que
    // gera `ca` e abre os autos digitais direto. Middle-click /
    // Ctrl+click escapam (o navegador ignora preventDefault dessas)
    // e abrem a Consulta Pública diretamente.
    const procLink = target.closest<HTMLAnchorElement>('a.paidegua-dash__proc-link');
    if (
      procLink &&
      ev.button === 0 &&
      !ev.ctrlKey &&
      !ev.metaKey &&
      !ev.shiftKey &&
      !ev.altKey
    ) {
      ev.preventDefault();
      ev.stopPropagation();
      const procId = procLink.dataset.processoId || '';
      const proc = state.processos.find((x) => x.id === procId);
      if (proc) void abrirProcessoNoPje(proc);
      return;
    }

    // Mesma delegation cobre o botão de copiar do aside (título do
    // painel lateral). Classe diferente para permitir estilo próprio,
    // mas comportamento idêntico ao da tabela.
    const copyAsideBtn = target.closest<HTMLElement>('.paidegua-dash__btn-copy-cnj');
    if (copyAsideBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const cnj = copyAsideBtn.dataset.cnj || '';
      if (!cnj) return;
      void copyToClipboard(cnj, `Número copiado: ${cnj}`);
      return;
    }

    const openBtn = target.closest<HTMLElement>('.paidegua-dash__proc-open-task');
    if (openBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const procId = openBtn.dataset.processoId || '';
      const proc = state.processos.find((x) => x.id === procId);
      if (!proc) return;
      void abrirTarefaNoPje(proc);
      return;
    }

    const atualizarBtn = target.closest<HTMLButtonElement>(
      '.paidegua-dash__btn-atualizar'
    );
    if (atualizarBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const processoId = atualizarBtn.dataset.processoId || '';
      if (!processoId) return;
      void atualizarProcessoComPjeEIa(atualizarBtn, processoId);
      return;
    }

    const carregarPdfBtn = target.closest<HTMLButtonElement>(
      '.paidegua-dash__btn-carregar-pdf'
    );
    if (carregarPdfBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const processoId = carregarPdfBtn.dataset.processoId || '';
      if (!processoId) return;
      void carregarPdfManual(carregarPdfBtn, processoId);
      return;
    }

    const limparTraceBtn = target.closest<HTMLButtonElement>(
      '.paidegua-dash__trace-limpar'
    );
    if (limparTraceBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const processoId = limparTraceBtn.dataset.processoId || '';
      if (!processoId) return;
      tracesPorProcesso.delete(processoId);
      // Re-renderiza o painel sem o bloco de trace.
      if (editState.processoId === processoId) abrirDetalhe(processoId);
      return;
    }
  });
}

/**
 * Pipeline "Atualizar com PJe + IA" — agora orquestrado para o
 * processo inteiro (todos os réus + reprocessamento via aba oculta):
 *
 *   1. Para cada réu com CPF válido (11 dígitos): JSF Pessoa Física
 *      → traz nascimento/RG/mãe/endereço com origem `pje`.
 *   2. Reprocessamento do processo via aba oculta dos autos →
 *      ativa PDFs principais, roda IA → traz tipo_crime, data_fato,
 *      pena_aplicada, status_anpp etc. com origem `ia`.
 *
 * As etapas são independentes: cada falha individual NÃO interrompe
 * as demais — registramos os erros e seguimos. No fim, recarregamos
 * o estado do IDB e re-renderizamos o painel para refletir tudo
 * consolidado, com as badges de origem corretas.
 */
/**
 * Trace persistido no estado do dashboard, por processo. Usado para
 * exibir o resultado da última operação "Atualizar com PJe + IA"
 * mesmo após re-render do painel lateral. Sem isso o trace some
 * quando recarregamos os dados do IDB.
 */
const tracesPorProcesso = new Map<
  string,
  { titulo: string; entries: TraceEntry[]; ts: number }
>();

interface SecaoTrace {
  titulo: string;
  entries: TraceEntry[];
}

async function atualizarProcessoComPjeEIa(
  btn: HTMLButtonElement,
  processoId: string
): Promise<void> {
  const labelOriginal = '🔎 Atualizar com PJe + IA';
  btn.disabled = true;

  const proc = state.processos.find((p) => p.id === processoId);
  if (!proc) {
    btn.disabled = false;
    btn.textContent = labelOriginal;
    showToast('Processo não encontrado no estado local.');
    return;
  }

  const secoes: SecaoTrace[] = [];
  let camposGravados = 0;

  // ── Etapa 1: JSF Pessoa Física para CADA réu com CPF ─────────
  const reusComCpf = proc.reus
    .map((r) => ({
      reu: r,
      cpf: (r.cpf_reu ?? '').replace(/\D/g, '')
    }))
    .filter((x) => x.cpf.length === 11);

  if (reusComCpf.length === 0) {
    secoes.push({
      titulo: 'Cadastro PJe',
      entries: [
        {
          etapa: 'sem-cpf',
          status: 'aviso',
          info: 'nenhum réu deste processo tem CPF válido para buscar'
        }
      ]
    });
  } else {
    let i = 0;
    for (const { reu, cpf } of reusComCpf) {
      i++;
      btn.textContent =
        reusComCpf.length > 1
          ? `⏳ Cadastro PJe ${i}/${reusComCpf.length}…`
          : '⏳ Cadastro PJe…';
      const titulo = `Cadastro PJe — ${truncar(reu.nome_reu, 32)} (CPF ${formatarCpfMask(cpf)})`;
      try {
        const respJsf = (await chrome.runtime.sendMessage({
          channel: MESSAGE_CHANNELS.CRIMINAL_ENRIQUECER_REU,
          payload: { reuId: reu.id, cpf }
        })) as {
          ok: boolean;
          reu?: Reu;
          error?: string;
          trace?: TraceEntry[];
        };
        const entries = respJsf?.trace ?? [];
        if (!respJsf?.ok) {
          entries.push({
            etapa: 'resultado',
            status: 'falha',
            info: respJsf?.error ?? 'erro desconhecido'
          });
        } else {
          // Conta quantos campos efetivamente foram gravados (etapa 'gravar-idb' ok).
          if (entries.some((e) => e.etapa === 'gravar-idb' && e.status === 'ok')) {
            camposGravados++;
          }
        }
        secoes.push({ titulo, entries });
      } catch (err) {
        secoes.push({
          titulo,
          entries: [
            {
              etapa: 'exception',
              status: 'falha',
              info: err instanceof Error ? err.message : String(err)
            }
          ]
        });
      }
    }
  }

  // ── Etapa 2: Reprocessamento com IA do processo inteiro ──────
  if (proc.id_processo_pje && proc.hostname_pje) {
    btn.textContent = '⏳ IA dos PDFs (~30s)…';
    try {
      const respIA = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.CRIMINAL_REPROCESSAR_PROCESSO,
        payload: { processoId: proc.id }
      })) as {
        ok: boolean;
        processo?: Processo;
        error?: string;
        trace?: TraceEntry[];
      };
      const entries = respIA?.trace ?? [];
      if (!respIA?.ok) {
        entries.push({
          etapa: 'resultado',
          status: 'falha',
          info: respIA?.error ?? 'erro desconhecido'
        });
      } else {
        if (
          entries.some(
            (e) =>
              (e.etapa === 'gravar-processo' || e.etapa.startsWith('gravar-reu-')) &&
              e.status === 'ok'
          )
        ) {
          camposGravados++;
        }
      }
      secoes.push({ titulo: 'IA dos PDFs principais', entries });
    } catch (err) {
      secoes.push({
        titulo: 'IA dos PDFs principais',
        entries: [
          {
            etapa: 'exception',
            status: 'falha',
            info: err instanceof Error ? err.message : String(err)
          }
        ]
      });
    }
  } else {
    secoes.push({
      titulo: 'IA dos PDFs principais',
      entries: [
        {
          etapa: 'pre-requisito',
          status: 'aviso',
          info: 'processo sem id_processo_pje ou hostname_pje no IDB — refaça a varredura para capturar'
        }
      ]
    });
  }

  // ── Persiste trace no estado e recarrega IDB ────────────────
  tracesPorProcesso.set(processoId, {
    titulo: `Última atualização (${new Date().toLocaleTimeString('pt-BR')})`,
    entries: secoes.flatMap((s) => [
      { etapa: `── ${s.titulo} ──`, status: 'info' as const },
      ...s.entries
    ]),
    ts: Date.now()
  });

  try {
    const procsFrescos = await listAllProcessos();
    state.processos = procsFrescos;
    aplicarFiltros();
    renderKpis();
    abrirDetalhe(proc.id);
  } catch (err) {
    console.warn(`${LOG_PREFIX} dashboard: refresh pós-atualizar falhou:`, err);
  }

  if (camposGravados > 0) {
    showToast(`Atualização concluída — verifique o trace abaixo.`);
  } else {
    showToast('Nada foi atualizado — veja o trace abaixo para entender por quê.');
  }
}

/**
 * Pipeline alternativo: o usuário escolhe um PDF do disco
 * (denúncia/sentença/ANPP/ofício) e a IA extrai os campos do mesmo
 * jeito que faz no reprocessamento automático. Útil quando:
 *
 *   - O processo não tem `id_processo_pje`/`hostname_pje` capturados
 *     (registros antigos pré-extensão de schema).
 *   - O reprocessamento via aba popup falha (sigilo, sessão expirada).
 *   - O usuário tem um PDF externo (ofício do MPF, cópia da denúncia
 *     via email, sentença baixada de outra fonte) que quer alimentar.
 *
 * O texto do PDF é extraído localmente via pdf.js (sem subir o
 * arquivo) e só o TEXTO vai pro background, que chama a IA. A
 * privacidade do PDF (CPFs, nomes) depende do provider de IA escolhido
 * pelo usuário — mesmo trade-off do reprocessamento automático.
 */
async function carregarPdfManual(
  btn: HTMLButtonElement,
  processoId: string
): Promise<void> {
  const labelOriginal = btn.textContent ?? '📄 Carregar PDF…';

  // File picker dinâmico — evita poluir o DOM com inputs invisíveis
  // e funciona bem mesmo após re-renders do painel.
  //
  // Usamos os dois eventos nativos: `change` quando o usuário escolhe
  // um arquivo e `cancel` quando fecha o picker sem selecionar.
  // O `cancel` do <input type="file"> é suportado em Chrome 113+
  // (lançado em 2023) e elimina o hack antigo de detectar cancelamento
  // via `window.focus` com setTimeout — esse hack tinha race condition
  // que ocasionalmente tratava arquivos válidos como cancelamento.
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.style.display = 'none';
  document.body.appendChild(input);

  const arquivo = await new Promise<File | null>((resolve) => {
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
  input.remove();

  if (!arquivo) {
    showToast('Nenhum arquivo selecionado.');
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Lendo PDF…';

  const entries: TraceEntry[] = [];
  const t0 = Date.now();
  const log = (
    etapa: string,
    status: TraceEntry['status'],
    info?: string
  ): void => {
    entries.push({ etapa, status, info, ts: Date.now() - t0 });
  };

  log('arquivo', 'info', `${arquivo.name} (${(arquivo.size / 1024).toFixed(0)}KB)`);

  let texto = '';
  let buf: ArrayBuffer;
  try {
    buf = await arquivo.arrayBuffer();
  } catch (err) {
    log('arquivo-bytes', 'falha', err instanceof Error ? err.message : String(err));
    tracesPorProcesso.set(processoId, {
      titulo: `PDF manual (${new Date().toLocaleTimeString('pt-BR')})`,
      entries,
      ts: Date.now()
    });
    btn.disabled = false;
    btn.textContent = labelOriginal;
    abrirDetalhe(processoId);
    showToast('Falha ao ler o arquivo.');
    return;
  }

  // 1ª tentativa: extração nativa via pdf.js. Em PDFs nativos (gerados
  // pelo PJe / Word / similares) já vem texto rico — sem custo de OCR.
  let pageCount = 0;
  let isScanned = false;
  try {
    // pdf.js consome o ArrayBuffer (transfere ownership), então
    // duplicamos antes — precisamos do buf original para o OCR fallback.
    const parsed = await parsePdf(buf.slice(0));
    pageCount = parsed.pageCount;
    isScanned = parsed.isScanned;
    texto = parsed.text;
    if (parsed.isScanned) {
      log(
        'parse-pdf',
        'aviso',
        `${parsed.pageCount} pág(s) com pouco texto — vai cair no OCR`
      );
    } else {
      log('parse-pdf', 'ok', `${parsed.pageCount} pág(s), ${parsed.text.length} chars`);
    }
  } catch (err) {
    log('parse-pdf', 'falha', err instanceof Error ? err.message : String(err));
    tracesPorProcesso.set(processoId, {
      titulo: `PDF manual (${new Date().toLocaleTimeString('pt-BR')})`,
      entries,
      ts: Date.now()
    });
    btn.disabled = false;
    btn.textContent = labelOriginal;
    abrirDetalhe(processoId);
    showToast('Falha ao ler o PDF — veja o trace.');
    return;
  }

  // 2ª tentativa: OCR (Tesseract). Roda quando a extração nativa
  // identifica digitalização ou devolve texto vazio (PDF gerado por
  // scanner sem camada OCR).
  const precisaOcr = isScanned || !texto.trim();
  if (precisaOcr) {
    btn.textContent = '⏳ OCR (pode levar minutos)…';
    log(
      'ocr-inicio',
      'info',
      `${pageCount} pág(s) — OCR limitado a 30 páginas para evitar travas`
    );
    try {
      const ocr = await ocrPdf(buf.slice(0), (p) => {
        // Atualiza só o label do botão — sem inflar o trace com 1
        // entry por página.
        btn.textContent = `⏳ OCR pág ${p.currentPage}/${p.totalPages}…`;
      });
      texto = ocr.text;
      log(
        'ocr-fim',
        'ok',
        `${ocr.pagesProcessed} pág(s) processadas` +
          (ocr.pagesSkipped > 0 ? `, ${ocr.pagesSkipped} ignoradas (cap)` : '') +
          `, ${texto.length} chars`
      );
    } catch (err) {
      // Em caso de falha, log completo no console e trecho legível
      // no trace para o usuário. O erro frequentemente é silencioso
      // (worker do Tesseract perdeu acesso a um asset), por isso
      // garantimos console.error com stack.
      console.error(`${LOG_PREFIX} OCR falhou:`, err);
      const detalhe = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log('ocr-fim', 'falha', detalhe);
      tracesPorProcesso.set(processoId, {
        titulo: `PDF manual (${new Date().toLocaleTimeString('pt-BR')})`,
        entries,
        ts: Date.now()
      });
      btn.disabled = false;
      btn.textContent = labelOriginal;
      abrirDetalhe(processoId);
      showToast('OCR falhou — veja o trace.');
      return;
    }
  }

  if (!texto.trim()) {
    log('texto-final', 'falha', 'texto vazio mesmo após OCR');
    tracesPorProcesso.set(processoId, {
      titulo: `PDF manual (${new Date().toLocaleTimeString('pt-BR')})`,
      entries,
      ts: Date.now()
    });
    btn.disabled = false;
    btn.textContent = labelOriginal;
    abrirDetalhe(processoId);
    showToast('PDF sem texto extraível, mesmo com OCR.');
    return;
  }

  // Heurística leve para o tipo do documento — ajuda o prompt a se
  // orientar. Apenas dica, a IA decide.
  const txtLower = texto.slice(0, 5000).toLowerCase();
  const tipoDocumento = txtLower.includes('denúncia') || txtLower.includes('denuncia')
    ? 'denúncia'
    : txtLower.includes('sentença') || txtLower.includes('sentenca')
      ? 'sentença'
      : txtLower.includes('anpp') || txtLower.includes('acordo de não persecução')
        ? 'ANPP'
        : '';

  btn.textContent = '⏳ IA processando…';
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.CRIMINAL_PROCESSAR_PDF_MANUAL,
      payload: { processoId, texto, tipoDocumento: tipoDocumento || undefined }
    })) as {
      ok: boolean;
      processo?: Processo;
      error?: string;
      trace?: TraceEntry[];
    };

    const traceBg = resp?.trace ?? [];
    // Concatena trace local (parse-pdf) + trace do background (IA + IDB)
    const todas: TraceEntry[] = [...entries, ...traceBg];
    if (!resp?.ok) {
      todas.push({
        etapa: 'resultado',
        status: 'falha',
        info: resp?.error ?? 'erro desconhecido'
      });
    }
    tracesPorProcesso.set(processoId, {
      titulo: `PDF manual: ${arquivo.name} (${new Date().toLocaleTimeString('pt-BR')})`,
      entries: todas,
      ts: Date.now()
    });

    if (resp?.ok) {
      // Recarrega o IDB para refletir patches.
      try {
        const procs = await listAllProcessos();
        state.processos = procs;
        aplicarFiltros();
        renderKpis();
      } catch (err) {
        console.warn(`${LOG_PREFIX} dashboard: refresh pós-PDF falhou:`, err);
      }
      showToast('PDF processado — verifique o trace.');
    } else {
      showToast(`Falha: ${resp?.error ?? 'erro desconhecido'}`);
    }
    abrirDetalhe(processoId);
  } catch (err) {
    entries.push({
      etapa: 'exception',
      status: 'falha',
      info: err instanceof Error ? err.message : String(err)
    });
    tracesPorProcesso.set(processoId, {
      titulo: `PDF manual: ${arquivo.name} (${new Date().toLocaleTimeString('pt-BR')})`,
      entries,
      ts: Date.now()
    });
    abrirDetalhe(processoId);
    showToast('Erro ao processar o PDF.');
  } finally {
    btn.disabled = false;
    btn.textContent = labelOriginal;
  }
}

function renderBlocoPrescricao(p: Processo): string {
  const { resultadosPorReu, statusAgregado } = prescricaoDoProcesso(p);
  const cls = `paidegua-dash__presc-banner--${statusAgregado.replace('_', '-')}`;
  const tituloAgg = LABEL_STATUS_PRESCRICAO[statusAgregado];
  const linhasReu = p.reus.map((reu, i) => {
    const r = resultadosPorReu[i]!;
    if (r.status === 'dados_insuficientes') {
      return `
        <div class="paidegua-dash__presc-reu paidegua-dash__presc-reu--insuficiente">
          <span class="paidegua-dash__presc-reu-nome">${escapeHtml(truncar(reu.nome_reu, 36))}</span>
          <span class="paidegua-dash__presc-reu-info">⚪ ${escapeHtml(r.motivoIncompleto ?? 'dados incompletos')}</span>
        </div>
      `;
    }
    const icone = r.status === 'verde' ? '🟢' : r.status === 'amarelo' ? '🟡' : '🔴';
    const tempo = formatarTempoRestante(r.diasRestantes ?? 0);
    // Prazo: mostra base CP 109; se houve ajuste, anexa "→ N meses
    // após ajustes" para ficar transparente o resultado final.
    const prazoTxt =
      r.ajustes.length > 0 && r.prazoBaseMeses != null
        ? `prazo ${r.prazoBaseMeses}→${r.prazoPrescricionalMeses}m (CP 109 + ajustes)`
        : `prazo ${r.prazoPrescricionalMeses} meses (CP 109)`;
    const detalhes = [
      `pena ${r.penaConsideradaMeses} meses`,
      prazoTxt,
      `marco ${r.marcoInterruptivo?.tipo} em ${fmtIsoDate(r.marcoInterruptivo?.data ?? null)}`,
      r.diasSuspensos > 0 ? `+${r.diasSuspensos}d suspensão CPP 366` : null,
      `prescreve em ${fmtIsoDate(r.dataLimite)}`
    ]
      .filter(Boolean)
      .join(' · ');
    const ajustesHtml =
      r.ajustes.length > 0
        ? `<span class="paidegua-dash__presc-reu-ajustes">${r.ajustes
            .map(
              (a) =>
                `<span class="paidegua-dash__presc-ajuste paidegua-dash__presc-ajuste--${a.tipo}">${escapeHtml(a.rotulo)}</span>`
            )
            .join('')}</span>`
        : '';
    return `
      <div class="paidegua-dash__presc-reu paidegua-dash__presc-reu--${r.status}">
        <span class="paidegua-dash__presc-reu-nome">${escapeHtml(truncar(reu.nome_reu, 36))}</span>
        <span class="paidegua-dash__presc-reu-info">${icone} ${escapeHtml(tempo)}</span>
        <span class="paidegua-dash__presc-reu-detalhes">${escapeHtml(detalhes)}</span>
        ${ajustesHtml}
      </div>
    `;
  });

  return `
    <section class="paidegua-dash__aside-secao paidegua-dash__presc-secao">
      <h3>Prescrição (farol)</h3>
      <div class="paidegua-dash__presc-banner ${cls}">
        <strong>${escapeHtml(tituloAgg)}</strong>
        ${
          statusAgregado === 'dados_insuficientes'
            ? '<span>Preencha pena máxima ou aplicada para o cálculo.</span>'
            : ''
        }
      </div>
      <div class="paidegua-dash__presc-reus">
        ${linhasReu.join('') || '<em>Nenhum réu cadastrado.</em>'}
      </div>
    </section>
  `;
}

function renderBlocoGestaoAnpp(p: Processo): string {
  const { resultadosPorReu, statusAgregado } = gestaoAnppDoProcesso(p);

  // Se nenhum réu tem ANPP relevante (todos `nao_aplicavel` /
  // `cumprido`), economiza espaço escondendo a seção. Mantemos só
  // se houver pelo menos um cumprido (vale o registro positivo) ou
  // estado ativo (em_dia/atrasado/etc.).
  const todosInativos = resultadosPorReu.every(
    (r) => r.status === 'nao_aplicavel'
  );
  if (todosInativos || resultadosPorReu.length === 0) return '';

  const cls = `paidegua-dash__gestao-anpp-banner--${statusAgregado.replace('_', '-')}`;
  const tituloAgg = LABEL_STATUS_GESTAO_ANPP[statusAgregado];
  const linhasReu = p.reus.map((reu, i) => {
    const r = resultadosPorReu[i]!;
    const icone = ICONE_STATUS_GESTAO_ANPP[r.status];
    const statusLabel = LABEL_STATUS_GESTAO_ANPP[r.status];
    const proxima =
      r.proximaComprovacao != null
        ? `próxima em ${fmtIsoDate(r.proximaComprovacao)}`
        : null;
    const detalhesPartes = [statusLabel, proxima].filter(Boolean) as string[];
    return `
      <div class="paidegua-dash__gestao-anpp-reu paidegua-dash__gestao-anpp-reu--${r.status.replace('_', '-')}">
        <span class="paidegua-dash__gestao-anpp-reu-nome">${escapeHtml(truncar(reu.nome_reu, 36))}</span>
        <span class="paidegua-dash__gestao-anpp-reu-info">${icone} ${escapeHtml(detalhesPartes.join(' · '))}</span>
        <span class="paidegua-dash__gestao-anpp-reu-detalhes">${escapeHtml(r.motivo)}</span>
      </div>
    `;
  });

  return `
    <section class="paidegua-dash__aside-secao paidegua-dash__gestao-anpp-secao">
      <h3>Cumprimento ANPP</h3>
      <div class="paidegua-dash__gestao-anpp-banner ${cls}">
        <strong>${escapeHtml(tituloAgg)}</strong>
        <span class="paidegua-dash__gestao-anpp-banner-hint">
          Periodicidade considerada: 30 dias (mensal). Para alterar,
          edite a "Última comprovação" do réu.
        </span>
      </div>
      <div class="paidegua-dash__gestao-anpp-reus">
        ${linhasReu.join('')}
      </div>
    </section>
  `;
}

function formatarCpfMask(cpfDigits: string): string {
  const d = cpfDigits.padStart(11, '0').slice(-11);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

/**
 * Renderiza o bloco de trace operacional logo abaixo do banner de
 * completude. Cada entrada vira uma linha com ícone de status, etapa
 * e info. Linhas marcadas com `── título ──` viram cabeçalhos de
 * seção.
 */
function renderBlocoTrace(
  titulo: string,
  entries: readonly TraceEntry[],
  processoId: string
): string {
  if (entries.length === 0) return '';

  // ── Resumo honesto no cabeçalho ─────────────────────────────
  // Conta os campos efetivamente gravados nas etapas `gravar-*`
  // e separa falhas/avisos relevantes para um sumário no topo.
  const camposGravados: string[] = [];
  const falhas: string[] = [];
  const avisos: string[] = [];
  for (const e of entries) {
    if (e.etapa.startsWith('── ') && e.etapa.endsWith(' ──')) continue;
    if (e.status === 'ok' && /^gravar-/.test(e.etapa) && e.info) {
      // info típica: "data_nascimento, id_pessoa_pje" ou
      // "2 campo(s): tipo_crime, data_recebimento_denuncia"
      const m = e.info.match(/(?:campo\(s\):\s*)?(.+)$/);
      if (m && m[1]) camposGravados.push(`${e.etapa}: ${m[1]}`);
    }
    if (e.status === 'falha' && e.info) {
      falhas.push(`${e.etapa}: ${e.info}`);
    }
    if (e.status === 'aviso' && e.info) {
      avisos.push(`${e.etapa}: ${e.info}`);
    }
  }
  const totalGravados = camposGravados.length;
  const resumoIcone =
    totalGravados > 0 ? '✓' : falhas.length > 0 ? '✗' : '⚠';
  const resumoTexto =
    totalGravados > 0
      ? `${totalGravados} ação(ões) com gravação no IDB`
      : falhas.length > 0
        ? `Falhou em ${falhas.length} ponto(s)`
        : `Pipeline rodou mas nada foi gravado — provavelmente faltam dados nos PDFs/cadastro`;

  const linhasHtml: string[] = [];
  for (const e of entries) {
    if (e.etapa.startsWith('── ') && e.etapa.endsWith(' ──')) {
      linhasHtml.push(
        `<div class="paidegua-dash__trace-secao">${escapeHtml(
          e.etapa.replace(/^──\s*|\s*──$/g, '')
        )}</div>`
      );
      continue;
    }
    const icone =
      e.status === 'ok'
        ? '✓'
        : e.status === 'falha'
          ? '✗'
          : e.status === 'aviso'
            ? '⚠'
            : '·';
    const ts = e.ts != null ? `<span class="paidegua-dash__trace-ts">${e.ts}ms</span>` : '';
    linhasHtml.push(
      `<div class="paidegua-dash__trace-linha paidegua-dash__trace-${e.status}">` +
        `<span class="paidegua-dash__trace-icone">${icone}</span>` +
        `<span class="paidegua-dash__trace-etapa">${escapeHtml(e.etapa)}</span>` +
        (e.info
          ? `<span class="paidegua-dash__trace-info">${escapeHtml(e.info)}</span>`
          : '') +
        ts +
        `</div>`
    );
  }
  // O <button> de "limpar" fica IRMÃO do <summary> (não filho), porque
  // HTML proíbe elementos interativos aninhados em <summary>. Posicionado
  // absoluto no canto superior direito via CSS — visível com ou sem o
  // <details> aberto.
  return `
    <details class="paidegua-dash__trace-bloco" data-processo-trace="${escapeAttr(processoId)}">
      <summary class="paidegua-dash__trace-titulo paidegua-dash__trace-titulo--${
        totalGravados > 0 ? 'sucesso' : falhas.length > 0 ? 'falha' : 'parcial'
      }">
        <span class="paidegua-dash__trace-resumo">
          <span class="paidegua-dash__trace-resumo-icone">${resumoIcone}</span>
          <span class="paidegua-dash__trace-resumo-texto">${escapeHtml(resumoTexto)}</span>
          <span class="paidegua-dash__trace-resumo-titulo">${escapeHtml(titulo)}</span>
        </span>
      </summary>
      <button type="button" class="paidegua-dash__trace-limpar" data-processo-id="${escapeAttr(processoId)}" title="Esconder este trace">×</button>
      <div class="paidegua-dash__trace-corpo">
        ${linhasHtml.join('')}
      </div>
    </details>
  `;
}

/**
 * Texto pra copiar a "lista de processos do card" — um número CNJ por
 * linha, na ordem da exibição atual (após filtros e ordenação).
 */
function listaProcessosParaTexto(): string {
  return state.filtrados
    .map((p) => p.numero_processo)
    .filter((n) => n && n.trim())
    .join('\n');
}

function renderPaginacao(): void {
  const total = state.filtrados.length;
  const totalPaginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const paginaAtual = state.pagina + 1;
  $<HTMLElement>('paginacao-info').textContent =
    total === 0
      ? ''
      : `Página ${paginaAtual} de ${totalPaginas}`;
  $<HTMLButtonElement>('btn-pagina-anterior').disabled = state.pagina === 0;
  $<HTMLButtonElement>('btn-pagina-proxima').disabled =
    state.pagina + 1 >= totalPaginas;
}

// ── KPIs ────────────────────────────────────────────────────────

function renderKpis(): void {
  const procs = state.processos;
  const totalPrim = procs.filter((p) => p.is_classe_primaria).length;
  const totalAux = procs.length - totalPrim;
  const totalReus = procs.reduce((acc, p) => acc + p.reus.length, 0);
  // ANPP "ativo" = qualquer estado entre Em Negociacao e Em Execucao SEEU
  // (Homologado, Remetido MPF, Protocolado SEEU, Em Execucao SEEU,
  // Execucao Vara). Cumprido conta separado, N/A não conta.
  const STATUS_ANPP_ATIVOS: StatusAnpp[] = [
    'Em Negociacao',
    'Homologado',
    'Remetido MPF',
    'Protocolado SEEU',
    'Em Execucao SEEU',
    'Execucao Vara'
  ];
  const anppAtivos = procs.reduce(
    (acc, p) =>
      acc + p.reus.filter((r) => STATUS_ANPP_ATIVOS.includes(r.status_anpp)).length,
    0
  );
  // Incompletos só conta primários.
  const incompletos = procs.filter(
    (p) => p.is_classe_primaria && !analisarCompletude(p).completo
  ).length;

  // Risco prescricional: processos primários com status 'vermelho'
  // (≤ 6 meses pra prescrever) — esses precisam de atenção imediata.
  const riscoPresc = procs.filter(
    (p) =>
      p.is_classe_primaria &&
      prescricaoDoProcesso(p).statusAgregado === 'vermelho'
  ).length;

  // ANPP atrasados: processos primários com status agregado de
  // gestão = 'atrasado' (alguma comprovação venceu) ou
  // 'pendente_protocolo' (homologado/remetido faz tempo sem SEEU).
  const anppAtrasados = procs.filter((p) => {
    if (!p.is_classe_primaria) return false;
    const s = gestaoAnppDoProcesso(p).statusAgregado;
    return s === 'atrasado' || s === 'pendente_protocolo';
  }).length;

  $<HTMLElement>('kpi-primarios').textContent = String(totalPrim);
  $<HTMLElement>('kpi-auxiliares').textContent = String(totalAux);
  $<HTMLElement>('kpi-reus').textContent = String(totalReus);
  $<HTMLElement>('kpi-anpp-cumpr').textContent = String(anppAtivos);
  $<HTMLElement>('kpi-incompletos').textContent = String(incompletos);
  $<HTMLElement>('kpi-presc-risco').textContent = String(riscoPresc);
  $<HTMLElement>('kpi-anpp-atrasados').textContent = String(anppAtrasados);
}

// ── Painel lateral de detalhe ───────────────────────────────────

function abrirDetalhe(processoId: string): void {
  const p = state.processos.find((x) => x.id === processoId);
  if (!p) return;
  const aside = $<HTMLElement>('aside-detalhe');
  const titulo = $<HTMLElement>('aside-titulo');
  const subtitulo = $<HTMLElement>('aside-subtitulo');
  const conteudo = $<HTMLElement>('aside-conteudo');
  const btnPje = $<HTMLButtonElement>('btn-aside-pje');

  // Sair do modo edição se estava editando outro processo.
  if (editState.processoId !== processoId) {
    editState.editando = false;
  }
  editState.processoId = processoId;
  atualizarBotoesAside();

  const classe = nomeClasse(p.classe_cnj);
  // Título com número do processo + botão de copiar inline. O botão
  // é renderizado via innerHTML porque o `<h2>` é populado a cada
  // abrirDetalhe — usar innerHTML evita rebind manual de listener
  // (a delegation do document captura `.paidegua-dash__btn-copy-cnj`).
  titulo.innerHTML =
    `<span class="paidegua-dash__aside-titulo-numero">${escapeHtml(p.numero_processo)}</span>` +
    `<button type="button" class="paidegua-dash__btn-copy-cnj" data-cnj="${escapeAttr(p.numero_processo)}" ` +
    `title="Copiar número do processo" aria-label="Copiar número do processo ${escapeAttr(p.numero_processo)}">` +
    `${COPY_ICON_SVG}</button>`;
  // Subtítulo: apenas sigla + nome canônico da classe. A categoria
  // interna (`procedimento_comum`, `processo_especial`, etc.) é uma
  // agregação nossa pra organização — não é nome processual e
  // confunde quando aparece concatenada ("...PROCEDIMENTO SUMÁRIO ·
  // Procedimento Comum"). Quem precisa filtrar por categoria usa o
  // dropdown na barra de filtros do dashboard.
  subtitulo.textContent = `${classe.sigla} — ${classe.nomeCurto}`;

  // Botão "Abrir no PJe": habilita quando temos hostname (a rota
  // assíncrona em `abrirProcessoNoPje` decide entre autos diretos —
  // gerando ca via aba PJe — e fallback ConsultaPública).
  const podeAbrir = Boolean(p.hostname_pje);
  btnPje.disabled = !podeAbrir;
  btnPje.dataset.processoId = p.id;
  btnPje.title = podeAbrir
    ? p.id_processo_pje
      ? 'Abrir os autos digitais no PJe'
      : 'Abrir consulta pública (registro antigo sem idProcesso capturado)'
    : 'Hostname do PJe não capturado neste processo';

  conteudo.innerHTML = editState.editando
    ? renderDetalheProcessoEditavel(p)
    : renderDetalheProcesso(p);
  aside.hidden = false;

  // Bind sub-tabs de réus
  const tabs = conteudo.querySelectorAll<HTMLButtonElement>('.paidegua-dash__reus-tab');
  for (const t of Array.from(tabs)) {
    t.addEventListener('click', () => {
      for (const x of Array.from(tabs)) {
        x.classList.remove('paidegua-dash__reus-tab--ativa');
      }
      t.classList.add('paidegua-dash__reus-tab--ativa');
      const idx = Number(t.getAttribute('data-reu-idx') ?? 0);
      const cards = conteudo.querySelectorAll<HTMLElement>('.paidegua-dash__reu-card');
      for (let i = 0; i < cards.length; i++) {
        cards[i]!.hidden = i !== idx;
      }
    });
  }
}

function fecharDetalhe(): void {
  $<HTMLElement>('aside-detalhe').hidden = true;
  editState.processoId = null;
  editState.editando = false;
  atualizarBotoesAside();
}

/**
 * Mostra/oculta os botões de Editar/Salvar/Cancelar conforme o
 * estado de edição atual. Chamado em todas as transições do aside.
 */
function atualizarBotoesAside(): void {
  const btnEditar = $<HTMLButtonElement>('btn-aside-editar');
  const btnSalvar = $<HTMLButtonElement>('btn-aside-salvar');
  const btnCancelar = $<HTMLButtonElement>('btn-aside-cancelar');
  if (editState.editando) {
    btnEditar.hidden = true;
    btnSalvar.hidden = false;
    btnCancelar.hidden = false;
  } else {
    btnEditar.hidden = false;
    btnSalvar.hidden = true;
    btnCancelar.hidden = true;
  }
}

function entrarModoEdicao(): void {
  if (!editState.processoId) return;
  editState.editando = true;
  abrirDetalhe(editState.processoId);
}

function cancelarEdicao(): void {
  if (!editState.processoId) return;
  editState.editando = false;
  abrirDetalhe(editState.processoId);
}

async function salvarEdicao(): Promise<void> {
  if (!editState.processoId || !editState.editando) return;
  const p = state.processos.find((x) => x.id === editState.processoId);
  if (!p) return;

  const conteudo = $<HTMLElement>('aside-conteudo');
  const btnSalvar = $<HTMLButtonElement>('btn-aside-salvar');
  const btnCancelar = $<HTMLButtonElement>('btn-aside-cancelar');
  btnSalvar.disabled = true;
  btnCancelar.disabled = true;
  btnSalvar.textContent = '⏳ Salvando…';

  try {
    // ── Patch do processo ─────────────────────────────────────
    const procPatch = colherPatchProcesso(conteudo, p);
    if (Object.keys(procPatch).length > 0) {
      const resp = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.CRIMINAL_ATUALIZAR_PROCESSO,
        payload: { processoId: p.id, patch: procPatch }
      })) as { ok: boolean; processo?: Processo; error?: string };
      if (!resp?.ok || !resp.processo) {
        throw new Error(resp?.error ?? 'Falha ao salvar processo.');
      }
      // Atualiza state local
      const idx = state.processos.findIndex((x) => x.id === p.id);
      if (idx >= 0) state.processos[idx] = resp.processo;
    }

    // ── Patches de cada réu ───────────────────────────────────
    const procAtualizado =
      state.processos.find((x) => x.id === p.id) ?? p;
    for (const reu of procAtualizado.reus) {
      const patch = colherPatchReu(conteudo, reu);
      if (Object.keys(patch).length === 0) continue;
      const resp = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.CRIMINAL_ATUALIZAR_REU,
        payload: { reuId: reu.id, patch }
      })) as { ok: boolean; reu?: Reu; error?: string };
      if (!resp?.ok || !resp.reu) {
        throw new Error(resp?.error ?? `Falha ao salvar réu ${reu.nome_reu}.`);
      }
      // Atualiza no state
      const reuIdx = procAtualizado.reus.findIndex((r) => r.id === reu.id);
      if (reuIdx >= 0) procAtualizado.reus[reuIdx] = resp.reu;
    }

    showToast('Alterações salvas.');
    editState.editando = false;
    abrirDetalhe(p.id);
    renderKpis();
    aplicarFiltros();
  } catch (err) {
    console.error(`${LOG_PREFIX} dashboard: salvar falhou:`, err);
    showToast(`Falhou: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btnSalvar.disabled = false;
    btnCancelar.disabled = false;
    btnSalvar.textContent = '✓ Salvar';
  }
}

function renderDetalheProcesso(p: Processo): string {
  const partes: string[] = [];

  // ── Tag de completude no topo + botão único de atualização ──
  const a = analisarCompletude(p);
  // Botão "Atualizar com PJe + IA" só aparece se houver pelo menos
  // um réu com CPF válido OU um id_processo_pje + hostname conhecidos
  // (precisa de algum dos dois para ter o que buscar).
  const algumReuComCpf = p.reus.some(
    (r) => (r.cpf_reu ?? '').replace(/\D/g, '').length === 11
  );
  const podeReprocessar = Boolean(p.id_processo_pje && p.hostname_pje);
  const podeAtualizar = algumReuComCpf || podeReprocessar;
  const btnAtualizarHtml = `
      <div class="paidegua-dash__atualizar-row">
        ${
          podeAtualizar
            ? `<button
                type="button"
                class="paidegua-dash__btn paidegua-dash__btn--primary paidegua-dash__btn-atualizar"
                data-processo-id="${escapeAttr(p.id)}"
                title="Busca dados cadastrais dos réus (CPF) na base do PJe e reprocessa os PDFs principais com IA"
              >
                🔎 Atualizar com PJe + IA
              </button>`
            : ''
        }
        <button
          type="button"
          class="paidegua-dash__btn paidegua-dash__btn-carregar-pdf"
          data-processo-id="${escapeAttr(p.id)}"
          title="Selecione um PDF (denúncia, sentença, ANPP, ofício…) para a IA extrair os dados. Faz OCR automaticamente em PDFs digitalizados. Alternativa ao botão acima quando a aba do PJe não está disponível."
        >
          📄 Carregar PDF…
        </button>
        <span class="paidegua-dash__atualizar-status" data-processo-status-id="${escapeAttr(p.id)}"></span>
      </div>
    `;

  if (a.completo) {
    partes.push(`
      <div class="paidegua-dash__completude-banner paidegua-dash__completude-banner--ok">
        <strong>✓ Processo completo.</strong>
        Todos os dados essenciais estão preenchidos.
        ${btnAtualizarHtml}
      </div>
    `);
  } else {
    partes.push(`
      <div class="paidegua-dash__completude-banner paidegua-dash__completude-banner--alerta">
        <strong>⚠ Faltando ${a.faltando.length} dado(s):</strong>
        ${escapeHtml(a.faltando.join(' · '))}
        ${btnAtualizarHtml}
      </div>
    `);
  }

  // Trace da última operação "Atualizar com PJe + IA" para este
  // processo, se houver — mostra o que foi tentado e o que aconteceu.
  const traceSalvo = tracesPorProcesso.get(p.id);
  if (traceSalvo) {
    partes.push(renderBlocoTrace(traceSalvo.titulo, traceSalvo.entries, p.id));
  }

  // Bloco de prescrição (farol): mostra status agregado + detalhe
  // por réu (data limite, dias restantes, marco interruptivo).
  partes.push(renderBlocoPrescricao(p));

  // Bloco de gestão de ANPP: agenda da próxima comprovação por réu
  // (só renderiza se houver pelo menos um réu com cumprimento ativo).
  partes.push(renderBlocoGestaoAnpp(p));

  // ── Seção: Dados do processo ────────────────────────────────
  const o = p.pje_origem;
  // Resolve nome da classe pra exibição amigável: "283 — APOrd:
  // AÇÃO PENAL - PROCEDIMENTO ORDINÁRIO" em vez de só "283".
  const classeInfo = nomeClasse(p.classe_cnj);
  const classeDisplay =
    classeInfo.sigla === '?'
      ? String(p.classe_cnj)
      : `${p.classe_cnj} — ${classeInfo.sigla}: ${classeInfo.nomeCurto}`;
  partes.push(`
    <section class="paidegua-dash__aside-secao">
      <h3>Dados do processo</h3>
      <div class="paidegua-dash__aside-grid">
        ${field('Classe CNJ', classeDisplay, o.classe_cnj)}
        ${field('Categoria', CATEGORIA_LABELS[p.classe_categoria] ?? p.classe_categoria)}
        ${field('Tipo de crime', p.tipo_crime ?? null, o.tipo_crime)}
        ${field('Data do fato', fmtIsoDate(p.data_fato), o.data_fato)}
        ${field('Recebimento da denúncia', fmtIsoDate(p.data_recebimento_denuncia), o.data_recebimento_denuncia)}
        ${field('Vara', p.vara_id ?? null, o.vara_id)}
        ${field('Servidor responsável', p.servidor_responsavel ?? null)}
        ${field('Última sincronização', fmtIsoDateTime(p.ultima_sincronizacao_pje))}
      </div>
      ${
        p.observacoes
          ? `<div class="paidegua-dash__field" style="margin-top:10px;">
               <span class="paidegua-dash__field-label">Observações</span>
               <span class="paidegua-dash__field-value">${escapeHtml(p.observacoes)}</span>
             </div>`
          : ''
      }
    </section>
  `);

  // ── Seção: Réus ─────────────────────────────────────────────
  if (p.reus.length === 0) {
    partes.push(`
      <section class="paidegua-dash__aside-secao">
        <h3>Réus</h3>
        <p class="paidegua-dash__field-value paidegua-dash__field-value--vazio">
          Nenhum réu cadastrado.
        </p>
      </section>
    `);
  } else {
    const tabs = p.reus
      .map(
        (r, i) =>
          `<button type="button" class="paidegua-dash__reus-tab ${
            i === 0 ? 'paidegua-dash__reus-tab--ativa' : ''
          }" data-reu-idx="${i}">${escapeHtml(truncar(r.nome_reu, 28))}</button>`
      )
      .join('');
    const cards = p.reus
      .map((r, i) => renderReuCard(r, i, i !== 0))
      .join('');
    partes.push(`
      <section class="paidegua-dash__aside-secao">
        <h3>Réus (${p.reus.length})</h3>
        <div class="paidegua-dash__reus-tabs">${tabs}</div>
        ${cards}
      </section>
    `);
  }

  return partes.join('');
}

function renderReuCard(reu: Reu, idx: number, hidden: boolean): string {
  const o = reu.pje_origem;
  return `
    <div class="paidegua-dash__reu-card" data-reu-idx="${idx}" ${hidden ? 'hidden' : ''}>
      <div class="paidegua-dash__aside-grid">
        ${field('Nome', reu.nome_reu, o.nome_reu)}
        ${field('CPF', reu.cpf_reu ?? null, o.cpf_reu)}
        ${field('Data de nascimento', fmtIsoDate(reu.data_nascimento), o.data_nascimento)}
        ${field('RG', reu.rg ?? null, o.rg)}
        ${field('Nome da mãe', reu.nome_mae ?? null, o.nome_mae)}
        ${field('Endereço', reu.endereco ?? null, o.endereco)}
      </div>

      <h4 class="paidegua-dash__aside-subsecao">Prescrição</h4>
      <div class="paidegua-dash__aside-grid">
        ${field('Pena máxima (meses)', reu.pena_maxima_abstrato == null ? null : String(reu.pena_maxima_abstrato), o.pena_maxima_abstrato)}
        ${field('Pena aplicada (meses)', reu.pena_aplicada_concreto == null ? null : String(reu.pena_aplicada_concreto), o.pena_aplicada_concreto)}
        ${field('Data da sentença', fmtIsoDate(reu.data_sentenca), o.data_sentenca)}
        ${field('Reincidente (CP 110)', reu.reincidente ? 'Sim' : 'Não', o.reincidente)}
        ${field('Suspenso (CPP 366)', reu.suspenso_366 ? 'Sim' : 'Não', o.suspenso_366)}
        ${
          reu.suspenso_366
            ? field('Início suspensão', fmtIsoDate(reu.data_inicio_suspensao), o.data_inicio_suspensao) +
              field('Fim suspensão', fmtIsoDate(reu.data_fim_suspensao), o.data_fim_suspensao)
            : ''
        }
      </div>

      <h4 class="paidegua-dash__aside-subsecao">ANPP</h4>
      <div class="paidegua-dash__aside-grid">
        ${field('Status', reu.status_anpp, o.status_anpp)}
        ${field('Data homologação', fmtIsoDate(reu.data_homologacao_anpp), o.data_homologacao_anpp)}
        ${field('Remessa MPF', fmtIsoDate(reu.data_remessa_mpf), o.data_remessa_mpf)}
        ${field('Protocolo SEEU', fmtIsoDate(reu.data_protocolo_seeu), o.data_protocolo_seeu)}
        ${field('Nº SEEU', reu.numero_seeu ?? null, o.numero_seeu)}
        ${field('Última comprovação', fmtIsoDate(reu.ultima_comprovacao_anpp), o.ultima_comprovacao_anpp)}
      </div>

      <h4 class="paidegua-dash__aside-subsecao">SERP</h4>
      <div class="paidegua-dash__aside-grid">
        ${field('Resultado', reu.resultado_serp, o.resultado_serp)}
        ${field('Última consulta', fmtIsoDate(reu.ultima_consulta_serp), o.ultima_consulta_serp)}
        ${field('Inquérito (SERP)', reu.serp_inquerito ? 'Sim' : 'Não')}
        ${field('Denúncia (SERP)', reu.serp_denuncia ? 'Sim' : 'Não')}
        ${field('Sentença (SERP)', reu.serp_sentenca ? 'Sim' : 'Não')}
        ${field('Guia (SERP)', reu.serp_guia ? 'Sim' : 'Não')}
      </div>
    </div>
  `;
}

// ── Modo edição: render do form + colheita de patches ────────────

/**
 * Versão "editável" do detalhe — todos os campos viram inputs com
 * atributos `data-edit-*` que o `colherPatchProcesso/Reu` lê na hora
 * de salvar. Apenas campos cujo valor mudar geram entrada no patch.
 */
function renderDetalheProcessoEditavel(p: Processo): string {
  const partes: string[] = [];

  partes.push(`
    <div class="paidegua-dash__completude-banner paidegua-dash__completude-banner--editando">
      <strong>Modo edição</strong>
      Altere os campos e clique em <em>Salvar</em>. Campos não alterados
      preservam a origem original (PJe/IA).
    </div>
  `);

  // ── Processo ────────────────────────────────────────────────
  partes.push(`
    <section class="paidegua-dash__aside-secao" data-edit-scope="processo" data-id="${escapeAttr(p.id)}">
      <h3>Dados do processo</h3>
      <div class="paidegua-dash__aside-grid">
        ${editFieldText('Tipo de crime', 'tipo_crime', p.tipo_crime ?? '')}
        ${editFieldDate('Data do fato', 'data_fato', p.data_fato ?? '')}
        ${editFieldDate('Recebimento da denúncia', 'data_recebimento_denuncia', p.data_recebimento_denuncia ?? '')}
      </div>
      ${editFieldTextarea('Observações', 'observacoes', p.observacoes ?? '')}
    </section>
  `);

  // ── Réus ────────────────────────────────────────────────────
  if (p.reus.length === 0) {
    partes.push(`
      <section class="paidegua-dash__aside-secao">
        <h3>Réus</h3>
        <p class="paidegua-dash__field-value paidegua-dash__field-value--vazio">
          Nenhum réu cadastrado. Adicionar manualmente: implementação futura.
        </p>
      </section>
    `);
    return partes.join('');
  }

  const tabs = p.reus
    .map(
      (r, i) =>
        `<button type="button" class="paidegua-dash__reus-tab ${
          i === 0 ? 'paidegua-dash__reus-tab--ativa' : ''
        }" data-reu-idx="${i}">${escapeHtml(truncar(r.nome_reu, 28))}</button>`
    )
    .join('');
  const cards = p.reus.map((r, i) => renderReuCardEditavel(r, i, i !== 0)).join('');
  partes.push(`
    <section class="paidegua-dash__aside-secao">
      <h3>Réus (${p.reus.length})</h3>
      <div class="paidegua-dash__reus-tabs">${tabs}</div>
      ${cards}
    </section>
  `);

  return partes.join('');
}

function renderReuCardEditavel(reu: Reu, idx: number, hidden: boolean): string {
  return `
    <div class="paidegua-dash__reu-card" data-edit-scope="reu" data-id="${escapeAttr(
      reu.id
    )}" data-reu-idx="${idx}" ${hidden ? 'hidden' : ''}>
      <div class="paidegua-dash__aside-grid">
        ${editFieldText('Nome', 'nome_reu', reu.nome_reu)}
        ${editFieldText('CPF', 'cpf_reu', reu.cpf_reu ?? '')}
        ${editFieldDate('Data de nascimento', 'data_nascimento', reu.data_nascimento ?? '')}
        ${editFieldText('RG', 'rg', reu.rg ?? '')}
        ${editFieldText('Nome da mãe', 'nome_mae', reu.nome_mae ?? '')}
        ${editFieldText('Endereço', 'endereco', reu.endereco ?? '')}
      </div>

      <h4 class="paidegua-dash__aside-subsecao">Prescrição</h4>
      <div class="paidegua-dash__aside-grid">
        ${editFieldNumber('Pena máxima (meses)', 'pena_maxima_abstrato', reu.pena_maxima_abstrato)}
        ${editFieldNumber('Pena aplicada (meses)', 'pena_aplicada_concreto', reu.pena_aplicada_concreto)}
        ${editFieldDate('Data da sentença', 'data_sentenca', reu.data_sentenca ?? '')}
        ${editFieldCheckbox('Reincidente (CP 110, +1/3)', 'reincidente', reu.reincidente ?? false)}
        ${editFieldCheckbox('Suspenso (CPP 366)', 'suspenso_366', reu.suspenso_366)}
        ${editFieldDate('Início suspensão', 'data_inicio_suspensao', reu.data_inicio_suspensao ?? '')}
        ${editFieldDate('Fim suspensão', 'data_fim_suspensao', reu.data_fim_suspensao ?? '')}
      </div>

      <h4 class="paidegua-dash__aside-subsecao">ANPP</h4>
      <div class="paidegua-dash__aside-grid">
        ${editFieldSelect('Status', 'status_anpp', reu.status_anpp, STATUS_ANPP_VALUES)}
        ${editFieldDate('Data homologação', 'data_homologacao_anpp', reu.data_homologacao_anpp ?? '')}
        ${editFieldDate('Remessa MPF', 'data_remessa_mpf', reu.data_remessa_mpf ?? '')}
        ${editFieldDate('Protocolo SEEU', 'data_protocolo_seeu', reu.data_protocolo_seeu ?? '')}
        ${editFieldText('Nº SEEU', 'numero_seeu', reu.numero_seeu ?? '')}
        ${editFieldDate('Última comprovação', 'ultima_comprovacao_anpp', reu.ultima_comprovacao_anpp ?? '')}
      </div>

      <h4 class="paidegua-dash__aside-subsecao">SERP</h4>
      <div class="paidegua-dash__aside-grid">
        ${editFieldSelect('Resultado', 'resultado_serp', reu.resultado_serp, RESULTADO_SERP_VALUES)}
        ${editFieldDate('Última consulta', 'ultima_consulta_serp', reu.ultima_consulta_serp ?? '')}
        ${editFieldCheckbox('Inquérito (SERP)', 'serp_inquerito', reu.serp_inquerito)}
        ${editFieldCheckbox('Denúncia (SERP)', 'serp_denuncia', reu.serp_denuncia)}
        ${editFieldCheckbox('Sentença (SERP)', 'serp_sentenca', reu.serp_sentenca)}
        ${editFieldCheckbox('Guia (SERP)', 'serp_guia', reu.serp_guia)}
      </div>
    </div>
  `;
}

// ── Builders de input por tipo ──────────────────────────────────

function editFieldText(label: string, name: string, value: string): string {
  return `
    <div class="paidegua-dash__field">
      <span class="paidegua-dash__field-label">${escapeHtml(label)}</span>
      <input class="paidegua-dash__edit-input" type="text" data-edit-name="${escapeAttr(name)}" value="${escapeAttr(value)}" />
    </div>
  `;
}

function editFieldTextarea(label: string, name: string, value: string): string {
  return `
    <div class="paidegua-dash__field" style="margin-top:10px;">
      <span class="paidegua-dash__field-label">${escapeHtml(label)}</span>
      <textarea class="paidegua-dash__edit-input paidegua-dash__edit-textarea" data-edit-name="${escapeAttr(
        name
      )}" rows="2">${escapeHtml(value)}</textarea>
    </div>
  `;
}

function editFieldDate(label: string, name: string, value: string): string {
  // value pode estar em ISO YYYY-MM-DD (já é o formato de <input type="date">)
  const v = (value ?? '').slice(0, 10);
  return `
    <div class="paidegua-dash__field">
      <span class="paidegua-dash__field-label">${escapeHtml(label)}</span>
      <input class="paidegua-dash__edit-input" type="date" data-edit-name="${escapeAttr(name)}" value="${escapeAttr(v)}" />
    </div>
  `;
}

function editFieldNumber(
  label: string,
  name: string,
  value: number | null | undefined
): string {
  const v = value == null ? '' : String(value);
  return `
    <div class="paidegua-dash__field">
      <span class="paidegua-dash__field-label">${escapeHtml(label)}</span>
      <input class="paidegua-dash__edit-input" type="number" min="0" step="1" data-edit-name="${escapeAttr(
        name
      )}" value="${escapeAttr(v)}" />
    </div>
  `;
}

function editFieldCheckbox(label: string, name: string, value: boolean): string {
  return `
    <div class="paidegua-dash__field paidegua-dash__field--check">
      <label class="paidegua-dash__field-label paidegua-dash__field-label--check">
        <input class="paidegua-dash__edit-input" type="checkbox" data-edit-name="${escapeAttr(name)}" ${
          value ? 'checked' : ''
        } />
        <span>${escapeHtml(label)}</span>
      </label>
    </div>
  `;
}

function editFieldSelect(
  label: string,
  name: string,
  value: string,
  options: readonly string[]
): string {
  const opts = options
    .map(
      (o) =>
        `<option value="${escapeAttr(o)}" ${o === value ? 'selected' : ''}>${escapeHtml(o)}</option>`
    )
    .join('');
  return `
    <div class="paidegua-dash__field">
      <span class="paidegua-dash__field-label">${escapeHtml(label)}</span>
      <select class="paidegua-dash__edit-input" data-edit-name="${escapeAttr(name)}">
        ${opts}
      </select>
    </div>
  `;
}

// ── Colheita de patches ─────────────────────────────────────────

/**
 * Lê todos os inputs da seção do processo no DOM e devolve um patch
 * contendo APENAS os campos cujo valor difere do atual. Conversões
 * de tipo (string vazia → null para campos de data; number string →
 * number etc.) são aplicadas aqui.
 */
function colherPatchProcesso(
  scope: HTMLElement,
  p: Processo
): Partial<ProcessoPayload> {
  const patch: Partial<ProcessoPayload> = {};
  const sec = scope.querySelector<HTMLElement>('[data-edit-scope="processo"]');
  if (!sec) return patch;

  const ler = (name: string): string => {
    const el = sec.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-edit-name="${name}"]`
    );
    return el?.value ?? '';
  };

  // Strings (vazio → null para preservar consistência)
  setIfChanged(patch, p, 'tipo_crime', ler('tipo_crime') || null);
  setIfChanged(patch, p, 'observacoes', ler('observacoes') || null);
  setIfChanged(patch, p, 'data_fato', ler('data_fato') || null);
  setIfChanged(
    patch,
    p,
    'data_recebimento_denuncia',
    ler('data_recebimento_denuncia') || null
  );

  return patch;
}

function colherPatchReu(scope: HTMLElement, reu: Reu): Partial<Reu> {
  const patch: Partial<Reu> = {};
  const sec = scope.querySelector<HTMLElement>(
    `[data-edit-scope="reu"][data-id="${CSS.escape(reu.id)}"]`
  );
  if (!sec) return patch;

  const lerStr = (name: string): string => {
    const el = sec.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[data-edit-name="${name}"]`
    );
    return el?.value ?? '';
  };
  const lerCheck = (name: string): boolean => {
    const el = sec.querySelector<HTMLInputElement>(
      `[data-edit-name="${name}"][type="checkbox"]`
    );
    return el?.checked ?? false;
  };

  // Identificação
  setIfChanged(patch, reu, 'nome_reu', lerStr('nome_reu') || reu.nome_reu);
  setIfChanged(patch, reu, 'cpf_reu', lerStr('cpf_reu') || null);
  setIfChanged(patch, reu, 'data_nascimento', lerStr('data_nascimento') || null);
  setIfChanged(patch, reu, 'rg', lerStr('rg') || null);
  setIfChanged(patch, reu, 'nome_mae', lerStr('nome_mae') || null);
  setIfChanged(patch, reu, 'endereco', lerStr('endereco') || null);

  // Prescrição
  setIfChanged(
    patch,
    reu,
    'pena_maxima_abstrato',
    parseNumOrNull(lerStr('pena_maxima_abstrato'))
  );
  setIfChanged(
    patch,
    reu,
    'pena_aplicada_concreto',
    parseNumOrNull(lerStr('pena_aplicada_concreto'))
  );
  setIfChanged(patch, reu, 'data_sentenca', lerStr('data_sentenca') || null);
  setIfChanged(patch, reu, 'reincidente', lerCheck('reincidente'));
  setIfChanged(patch, reu, 'suspenso_366', lerCheck('suspenso_366'));
  setIfChanged(
    patch,
    reu,
    'data_inicio_suspensao',
    lerStr('data_inicio_suspensao') || null
  );
  setIfChanged(
    patch,
    reu,
    'data_fim_suspensao',
    lerStr('data_fim_suspensao') || null
  );

  // ANPP
  setIfChanged(patch, reu, 'status_anpp', lerStr('status_anpp') as StatusAnpp);
  setIfChanged(
    patch,
    reu,
    'data_homologacao_anpp',
    lerStr('data_homologacao_anpp') || null
  );
  setIfChanged(patch, reu, 'data_remessa_mpf', lerStr('data_remessa_mpf') || null);
  setIfChanged(
    patch,
    reu,
    'data_protocolo_seeu',
    lerStr('data_protocolo_seeu') || null
  );
  setIfChanged(patch, reu, 'numero_seeu', lerStr('numero_seeu') || null);
  setIfChanged(
    patch,
    reu,
    'ultima_comprovacao_anpp',
    lerStr('ultima_comprovacao_anpp') || null
  );

  // SERP
  setIfChanged(
    patch,
    reu,
    'resultado_serp',
    lerStr('resultado_serp') as ResultadoSerp
  );
  setIfChanged(
    patch,
    reu,
    'ultima_consulta_serp',
    lerStr('ultima_consulta_serp') || null
  );
  setIfChanged(patch, reu, 'serp_inquerito', lerCheck('serp_inquerito'));
  setIfChanged(patch, reu, 'serp_denuncia', lerCheck('serp_denuncia'));
  setIfChanged(patch, reu, 'serp_sentenca', lerCheck('serp_sentenca'));
  setIfChanged(patch, reu, 'serp_guia', lerCheck('serp_guia'));

  return patch;
}

function parseNumOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Aplica `valor` em `patch[campo]` apenas se diferir do `original[campo]`.
 * Usa comparação `===` para primitivos e null. Converte `undefined` no
 * original para `null` na comparação (idempotência com payload do IDB).
 */
function setIfChanged<T extends object, K extends keyof T>(
  patch: Partial<T>,
  original: T,
  campo: K,
  valor: T[K] | null
): void {
  const orig = (original[campo] ?? null) as unknown;
  const novo = (valor ?? null) as unknown;
  if (orig !== novo) {
    patch[campo] = valor as T[K];
  }
}

function field(
  label: string,
  value: string | null,
  origem?: 'pje' | 'manual' | 'ia'
): string {
  const valHtml =
    value && value !== '—'
      ? `<span class="paidegua-dash__field-value">${escapeHtml(value)}</span>`
      : `<span class="paidegua-dash__field-value paidegua-dash__field-value--vazio">—</span>`;
  return `
    <div class="paidegua-dash__field">
      <span class="paidegua-dash__field-label">
        ${escapeHtml(label)} ${badgeOrigem(origem)}
      </span>
      ${valHtml}
    </div>
  `;
}

// ── Modal de revisão SERP em lote ──────────────────────────────
//
// O caso de uso operacional: o servidor abre o SERP, consulta o CPF
// do réu, e tem que voltar ao Sigcrim e marcar Pendente/Negativo/
// Positivo + flags (inquérito/denúncia/sentença/guia). Sem o modal,
// cada réu exige abrir o painel lateral, entrar em modo edição,
// salvar e sair — fluxo lento quando há dezenas de pendentes.
//
// Aqui consolidamos uma tabela compacta com inline-save: alternar um
// radio ou checkbox dispara `CRIMINAL_ATUALIZAR_REU` na hora e marca
// a linha como salva. Mudar `resultado_serp` também atualiza
// `ultima_consulta_serp` para hoje, refletindo o gesto natural de
// quem acabou de consultar o sistema.

type EscopoSerp = 'pendentes_e_antigos' | 'pendentes' | 'todos';

const stateSerp: { escopo: EscopoSerp } = { escopo: 'pendentes_e_antigos' };

interface LinhaSerp {
  processo: Processo;
  reu: Reu;
}

function diasDesde(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return Math.floor((hoje.getTime() - d.getTime()) / 86_400_000);
}

function coletarLinhasSerp(escopo: EscopoSerp): LinhaSerp[] {
  const out: LinhaSerp[] = [];
  // Apenas processos primários: réus de auxiliares geralmente são
  // os mesmos das primárias e não precisam revisão SERP independente.
  for (const p of state.processos) {
    if (!p.is_classe_primaria) continue;
    for (const reu of p.reus) {
      if (escopo === 'todos') {
        out.push({ processo: p, reu });
        continue;
      }
      if (reu.resultado_serp === 'Pendente') {
        out.push({ processo: p, reu });
        continue;
      }
      if (escopo === 'pendentes_e_antigos') {
        const d = diasDesde(reu.ultima_consulta_serp);
        if (d == null || d > 90) {
          out.push({ processo: p, reu });
        }
      }
    }
  }
  // Ordena: pendentes primeiro; entre pendentes, sem consulta antes
  // de consulta antiga.
  out.sort((a, b) => {
    const ap = a.reu.resultado_serp === 'Pendente' ? 0 : 1;
    const bp = b.reu.resultado_serp === 'Pendente' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const ad = a.reu.ultima_consulta_serp ?? '';
    const bd = b.reu.ultima_consulta_serp ?? '';
    return ad.localeCompare(bd);
  });
  return out;
}

function abrirModalSerp(): void {
  const modal = $<HTMLElement>('modal-serp');
  modal.hidden = false;
  renderTabelaSerp();
}

function fecharModalSerp(): void {
  $<HTMLElement>('modal-serp').hidden = true;
}

function hojeIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function renderTabelaSerp(): void {
  const tbody = $<HTMLTableSectionElement>('tbody-serp');
  const linhas = coletarLinhasSerp(stateSerp.escopo);
  const resumo = $<HTMLElement>('serp-resumo');

  resumo.textContent =
    linhas.length === 0
      ? 'Nada para revisar nesse escopo.'
      : `${linhas.length} réu(s) na lista`;

  if (linhas.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="8" class="paidegua-dash__serp-vazio">
        Nenhum réu bate com o escopo atual.
      </td></tr>
    `;
    return;
  }

  const html = linhas.map((l) => renderLinhaSerp(l)).join('');
  tbody.innerHTML = html;
}

function renderLinhaSerp(l: LinhaSerp): string {
  const { reu, processo } = l;
  const reuId = escapeAttr(reu.id);
  const dias = diasDesde(reu.ultima_consulta_serp);
  const ultimaTxt =
    reu.ultima_consulta_serp == null
      ? '<em>nunca</em>'
      : `${fmtIsoDate(reu.ultima_consulta_serp)}${
          dias != null ? ` <span class="paidegua-dash__serp-dias">(${dias}d)</span>` : ''
        }`;

  const radio = (val: ResultadoSerp): string => `
    <label class="paidegua-dash__serp-radio paidegua-dash__serp-radio--${val.toLowerCase()}">
      <input
        type="radio"
        name="serp-res-${reuId}"
        data-serp-action="resultado"
        data-reu-id="${reuId}"
        data-valor="${val}"
        ${reu.resultado_serp === val ? 'checked' : ''}
      />
      <span>${val[0]}</span>
    </label>
  `;

  const flag = (campo: 'serp_inquerito' | 'serp_denuncia' | 'serp_sentenca' | 'serp_guia'): string => {
    const checked = reu[campo] ? 'checked' : '';
    return `
      <td class="paidegua-dash__serp-col-flag">
        <input
          type="checkbox"
          data-serp-action="flag"
          data-reu-id="${reuId}"
          data-campo="${campo}"
          ${checked}
          aria-label="${campo}"
        />
      </td>
    `;
  };

  const procNum = processo.numero_processo || '—';
  const urlProc = montarUrlAbrirProcesso(processo);
  // `data-processo-id` é interceptado pela mesma delegation do
  // dashboard (`a.paidegua-dash__proc-link` usa a mesma classe), de
  // modo que clicar no link aqui também aciona o pipeline com `ca`.
  const procCell = urlProc
    ? `<a class="paidegua-dash__proc-link paidegua-dash__serp-link" href="${escapeAttr(urlProc)}" target="_blank" rel="noopener noreferrer" data-processo-id="${escapeAttr(processo.id)}">${escapeHtml(procNum)}</a>`
    : escapeHtml(procNum);

  return `
    <tr data-reu-id="${reuId}" class="paidegua-dash__serp-row paidegua-dash__serp-row--${reu.resultado_serp.toLowerCase()}">
      <td class="paidegua-dash__serp-col-reu">
        <strong>${escapeHtml(truncar(reu.nome_reu, 40))}</strong>
        ${reu.cpf_reu ? `<small>${escapeHtml(formatarCpfMask(reu.cpf_reu.replace(/\D/g, '')))}</small>` : ''}
      </td>
      <td class="paidegua-dash__serp-col-proc">${procCell}</td>
      <td class="paidegua-dash__serp-col-resultado">
        <div class="paidegua-dash__serp-radios">
          ${radio('Pendente')}
          ${radio('Negativo')}
          ${radio('Positivo')}
        </div>
      </td>
      ${flag('serp_inquerito')}
      ${flag('serp_denuncia')}
      ${flag('serp_sentenca')}
      ${flag('serp_guia')}
      <td class="paidegua-dash__serp-col-ultima">
        ${ultimaTxt}
        <span class="paidegua-dash__serp-status" data-serp-status="${reuId}"></span>
      </td>
    </tr>
  `;
}

/**
 * Atualiza um campo SERP do réu em IDB e no estado local. Devolve o
 * réu atualizado (ou null em falha — caller decide o feedback). Usado
 * tanto no toggle de resultado quanto nos checkboxes de flags.
 */
async function salvarPatchSerp(
  reuId: string,
  patch: Partial<Reu>
): Promise<Reu | null> {
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.CRIMINAL_ATUALIZAR_REU,
      payload: { reuId, patch }
    })) as { ok: boolean; reu?: Reu; error?: string };
    if (!resp?.ok || !resp.reu) {
      console.error(`${LOG_PREFIX} SERP: salvar falhou:`, resp?.error);
      return null;
    }
    // Atualiza estado local
    for (const p of state.processos) {
      const idx = p.reus.findIndex((r) => r.id === reuId);
      if (idx >= 0) {
        p.reus[idx] = resp.reu;
        break;
      }
    }
    return resp.reu;
  } catch (err) {
    console.error(`${LOG_PREFIX} SERP: exception salvando:`, err);
    return null;
  }
}

function flashSerpStatus(reuId: string, ok: boolean): void {
  const el = document.querySelector<HTMLElement>(
    `.paidegua-dash__serp-status[data-serp-status="${CSS.escape(reuId)}"]`
  );
  if (!el) return;
  el.textContent = ok ? '✓ salvo' : '✗ erro';
  el.className = `paidegua-dash__serp-status paidegua-dash__serp-status--${ok ? 'ok' : 'err'}`;
  setTimeout(() => {
    el.textContent = '';
    el.className = 'paidegua-dash__serp-status';
  }, 1500);
}

/**
 * Bind dos controles do modal — instalado uma vez no
 * DOMContentLoaded. Use event delegation para evitar rebind a cada
 * `renderTabelaSerp()`.
 */
function instalarHandlersSerp(): void {
  const tbody = $<HTMLTableSectionElement>('tbody-serp');

  tbody.addEventListener('change', async (ev) => {
    const target = ev.target as HTMLInputElement | null;
    if (!target) return;
    const acao = target.dataset.serpAction;
    if (!acao) return;
    const reuId = target.dataset.reuId;
    if (!reuId) return;

    if (acao === 'resultado' && target.type === 'radio' && target.checked) {
      const valor = target.dataset.valor as ResultadoSerp | undefined;
      if (!valor) return;
      const patch: Partial<Reu> = {
        resultado_serp: valor,
        ultima_consulta_serp: hojeIso()
      };
      const novo = await salvarPatchSerp(reuId, patch);
      flashSerpStatus(reuId, novo !== null);
      if (novo) {
        // Atualiza visual da row sem re-render completo: troca a
        // classe modificadora e atualiza a célula da última consulta.
        const tr = target.closest<HTMLTableRowElement>('tr[data-reu-id]');
        if (tr) {
          tr.className = `paidegua-dash__serp-row paidegua-dash__serp-row--${novo.resultado_serp.toLowerCase()}`;
          const ultimaTd = tr.querySelector<HTMLElement>('.paidegua-dash__serp-col-ultima');
          if (ultimaTd) {
            const dias = diasDesde(novo.ultima_consulta_serp);
            const txt =
              novo.ultima_consulta_serp == null
                ? '<em>nunca</em>'
                : `${fmtIsoDate(novo.ultima_consulta_serp)}${
                    dias != null ? ` <span class="paidegua-dash__serp-dias">(${dias}d)</span>` : ''
                  }`;
            ultimaTd.innerHTML = `${txt}<span class="paidegua-dash__serp-status paidegua-dash__serp-status--ok" data-serp-status="${escapeAttr(reuId)}">✓ salvo</span>`;
            const status = ultimaTd.querySelector<HTMLElement>('.paidegua-dash__serp-status');
            if (status) {
              setTimeout(() => {
                status.textContent = '';
                status.className = 'paidegua-dash__serp-status';
                status.setAttribute('data-serp-status', reuId);
              }, 1500);
            }
          }
        }
        // Os caches dependem só de campos de prescrição/ANPP, então
        // não precisam invalidação aqui. Mas o KPI/filtros do
        // dashboard principal podem refletir a mudança — refresh:
        renderKpis();
        aplicarFiltros();
      }
      return;
    }

    if (acao === 'flag' && target.type === 'checkbox') {
      const campo = target.dataset.campo as
        | 'serp_inquerito'
        | 'serp_denuncia'
        | 'serp_sentenca'
        | 'serp_guia'
        | undefined;
      if (!campo) return;
      const patch: Partial<Reu> = { [campo]: target.checked } as Partial<Reu>;
      const novo = await salvarPatchSerp(reuId, patch);
      flashSerpStatus(reuId, novo !== null);
      if (!novo) {
        // Reverte UI
        target.checked = !target.checked;
      }
      return;
    }
  });
}

// ── Carga inicial ───────────────────────────────────────────────

async function carregarAcervo(): Promise<void> {
  try {
    state.processos = await listAllProcessos();
    state.filtrados = [...state.processos];
    renderKpis();
    aplicarFiltros();
  } catch (err) {
    console.error(`${LOG_PREFIX} dashboard: falha lendo acervo:`, err);
    $<HTMLElement>('resultado-info').textContent =
      `Falha lendo o acervo: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function popularDropdownCategoria(): void {
  const sel = $<HTMLSelectElement>('select-categoria');
  const cats: { value: CategoriaCriminal; label: string }[] = [
    { value: 'procedimento_comum', label: CATEGORIA_LABELS.procedimento_comum },
    { value: 'processo_especial', label: CATEGORIA_LABELS.processo_especial },
    { value: 'anpp', label: CATEGORIA_LABELS.anpp },
    { value: 'execucao_penal', label: CATEGORIA_LABELS.execucao_penal },
    { value: 'cartas', label: CATEGORIA_LABELS.cartas },
    { value: 'medidas_cautelares', label: CATEGORIA_LABELS.medidas_cautelares },
    { value: 'medidas_garantidoras', label: CATEGORIA_LABELS.medidas_garantidoras },
    { value: 'medidas_preparatorias', label: CATEGORIA_LABELS.medidas_preparatorias },
    { value: 'peticao', label: CATEGORIA_LABELS.peticao },
    { value: 'procedimentos_investigatorios', label: CATEGORIA_LABELS.procedimentos_investigatorios },
    { value: 'questoes_incidentes', label: CATEGORIA_LABELS.questoes_incidentes },
    { value: 'recursos', label: CATEGORIA_LABELS.recursos }
  ];
  for (const c of cats) {
    const opt = document.createElement('option');
    opt.value = c.value;
    opt.textContent = c.label;
    sel.appendChild(opt);
  }
}

// ── Bindings ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  popularDropdownCategoria();
  instalarDelegacaoProcCell();
  instalarHandlersSerp();

  // Injeta o ícone no botão "Copiar lista" (definido no HTML sem markup interno)
  const btnCopyList = $<HTMLButtonElement>('btn-copiar-lista');
  btnCopyList.innerHTML = COPY_ICON_SVG;
  btnCopyList.addEventListener('click', () => {
    const text = listaProcessosParaTexto();
    if (!text) {
      showToast('Lista vazia — nada para copiar.');
      return;
    }
    const linhas = text.split('\n').filter((l) => l).length;
    void copyToClipboard(text, `Copiado: ${linhas} processo(s).`);
  });

  void carregarAcervo();

  // Header actions
  $<HTMLButtonElement>('btn-config').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL(
      'criminal-config/criminal-config.html'
    );
  });

  $<HTMLButtonElement>('btn-serp-lote').addEventListener('click', abrirModalSerp);
  $<HTMLButtonElement>('btn-serp-fechar').addEventListener('click', fecharModalSerp);
  $<HTMLElement>('modal-serp-overlay').addEventListener('click', fecharModalSerp);
  $<HTMLSelectElement>('select-serp-escopo').addEventListener('change', (e) => {
    stateSerp.escopo = (e.target as HTMLSelectElement).value as EscopoSerp;
    renderTabelaSerp();
  });

  $<HTMLButtonElement>('btn-varrer').addEventListener('click', () => {
    // O painel de varredura precisa ser disparado a partir de uma aba PJe
    // (depende da sessão autenticada). Aqui apenas instruímos o usuário.
    alert(
      'Para iniciar uma nova varredura, abra o painel-usuário do PJe e ' +
        'clique no botão "Sigcrim" na sidebar do paidegua.'
    );
  });

  // Busca + filtros
  const inputBusca = $<HTMLInputElement>('input-busca');
  let debounce: number | undefined;
  inputBusca.addEventListener('input', () => {
    if (debounce) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      state.filtros.busca = inputBusca.value;
      aplicarFiltros();
    }, 180);
  });

  $<HTMLSelectElement>('select-trilha').addEventListener('change', (e) => {
    state.filtros.trilha = (e.target as HTMLSelectElement).value as DashState['filtros']['trilha'];
    aplicarFiltros();
  });

  $<HTMLSelectElement>('select-categoria').addEventListener('change', (e) => {
    state.filtros.categoria = (e.target as HTMLSelectElement).value as DashState['filtros']['categoria'];
    aplicarFiltros();
  });

  $<HTMLSelectElement>('select-anpp').addEventListener('change', (e) => {
    state.filtros.statusAnpp = (e.target as HTMLSelectElement).value as DashState['filtros']['statusAnpp'];
    aplicarFiltros();
  });

  $<HTMLSelectElement>('select-completude').addEventListener('change', (e) => {
    state.filtros.completude = (e.target as HTMLSelectElement).value as DashState['filtros']['completude'];
    aplicarFiltros();
  });

  $<HTMLSelectElement>('select-prescricao').addEventListener('change', (e) => {
    state.filtros.prescricao = (e.target as HTMLSelectElement).value as DashState['filtros']['prescricao'];
    aplicarFiltros();
  });

  $<HTMLSelectElement>('select-gestao-anpp').addEventListener('change', (e) => {
    state.filtros.gestaoAnpp = (e.target as HTMLSelectElement).value as DashState['filtros']['gestaoAnpp'];
    aplicarFiltros();
  });

  $<HTMLButtonElement>('btn-limpar-filtros').addEventListener('click', () => {
    inputBusca.value = '';
    $<HTMLSelectElement>('select-trilha').value = 'primaria';
    $<HTMLSelectElement>('select-categoria').value = '';
    $<HTMLSelectElement>('select-anpp').value = '';
    $<HTMLSelectElement>('select-completude').value = '';
    $<HTMLSelectElement>('select-prescricao').value = '';
    $<HTMLSelectElement>('select-gestao-anpp').value = '';
    state.filtros = {
      busca: '',
      trilha: 'primaria',
      categoria: '',
      statusAnpp: '',
      completude: '',
      prescricao: '',
      gestaoAnpp: ''
    };
    aplicarFiltros();
  });

  // Paginação
  $<HTMLButtonElement>('btn-pagina-anterior').addEventListener('click', () => {
    if (state.pagina > 0) {
      state.pagina -= 1;
      renderTabela();
    }
  });

  $<HTMLButtonElement>('btn-pagina-proxima').addEventListener('click', () => {
    const total = state.filtrados.length;
    if ((state.pagina + 1) * PAGE_SIZE < total) {
      state.pagina += 1;
      renderTabela();
    }
  });

  // Painel lateral
  $<HTMLButtonElement>('btn-aside-fechar').addEventListener('click', fecharDetalhe);
  $<HTMLElement>('aside-overlay').addEventListener('click', fecharDetalhe);
  $<HTMLButtonElement>('btn-aside-editar').addEventListener('click', entrarModoEdicao);
  $<HTMLButtonElement>('btn-aside-cancelar').addEventListener('click', cancelarEdicao);
  $<HTMLButtonElement>('btn-aside-salvar').addEventListener('click', () => {
    void salvarEdicao();
  });
  $<HTMLButtonElement>('btn-aside-pje').addEventListener('click', (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const procId = btn.dataset.processoId || '';
    const proc = state.processos.find((x) => x.id === procId);
    if (!proc) return;
    void abrirProcessoNoPje(proc);
  });
  document.addEventListener('keydown', (e) => {
    // Esc fecha — mas não enquanto edita (evita perder digitação por
    // engano). Em modo edição o Esc cancela.
    if (e.key === 'Escape') {
      const modalSerp = document.getElementById('modal-serp');
      if (modalSerp && !modalSerp.hidden) {
        fecharModalSerp();
        return;
      }
      if (editState.editando) {
        cancelarEdicao();
      } else {
        fecharDetalhe();
      }
    }
  });
});
