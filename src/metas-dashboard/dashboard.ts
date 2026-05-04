/**
 * Dashboard "Controle Metas CNJ" — perfil Gestão.
 *
 * Roda em extension page (origin chrome-extension://) e tem acesso
 * direto ao IndexedDB do acervo (`paidegua.metas-cnj`) e ao banco TPU
 * (`paidegua.tpu`). NÃO precisa do background para queries de leitura.
 *
 * Funcionalidades V1:
 *   - Carrega o acervo completo na inicialização.
 *   - Exibe resumo com totais (acervo, status, presença).
 *   - Card por meta com:
 *       % cumprimento (julgados / (pendentes+julgados))
 *       contadores (pendentes, julgados, baixados-fora-do-universo)
 *       lista de processos pendentes (até 50 — paginação simples)
 *       formulário "Aplicar etiqueta": input + checkbox favoritar + botão
 *   - Aplicação de etiqueta envia ao background, que repassa ao content
 *     do PJe (mesmo padrão de Perícias).
 *
 * Fora do escopo V1 (ficam para iterações futuras):
 *   - Edição de configuração (datas de corte, classes/assuntos elegíveis)
 *   - Override manual por processo
 *   - Cartões informativos (metas 1, 3, 5, 9)
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../shared/constants';
import {
  getStats,
  listAllProcessos,
  loadConfig,
  loadLastSync
} from '../shared/metas-cnj-store';
import type {
  MetaCnjId,
  MetasCnjConfig,
  ProcessoMetasCnj
} from '../shared/metas-cnj-types';

const META_LABELS: Record<MetaCnjId, { titulo: string; sub: string }> = {
  'meta-2': {
    titulo: 'Meta 2 — Antigos',
    sub: 'Distribuídos até a data de corte (default 31/12/2011 — 15 anos)'
  },
  'meta-4': {
    titulo: 'Meta 4 — Improbidade + Crimes Adm. Pública',
    sub: 'Distribuídos até 31/12/2023 (Faixa JF: 85%)'
  },
  'meta-6': {
    titulo: 'Meta 6 — Ambientais',
    sub: 'TRF5 (Faixa 2): 38% distribuídos até 31/12/2025'
  },
  'meta-7': {
    titulo: 'Meta 7 — Indígenas, Quilombolas, Racismo',
    sub: 'TRF5 (Faixa 2): 35% / 35% / 50% até 31/12/2025'
  },
  'meta-10': {
    titulo: 'Meta 10 — Subtração internacional de crianças',
    sub: '100% distribuídos até 31/12/2025'
  }
};

const elMetaInfo = document.getElementById('meta-info') as HTMLElement;
const elResumo = document.getElementById('meta-resumo') as HTMLElement;
const elOrient = document.getElementById('orientacao') as HTMLElement;
const elMetasContainer = document.getElementById('metas-container') as HTMLElement;
const elVazioCard = document.getElementById('vazio-card') as HTMLElement;

let cacheProcessos: ProcessoMetasCnj[] = [];
let cacheConfig: MetasCnjConfig | null = null;

void main();

async function main(): Promise<void> {
  try {
    cacheConfig = await loadConfig();
    cacheProcessos = await listAllProcessos();
    const lastSync = await loadLastSync();
    if (lastSync) {
      const dt = new Date(lastSync.finishedAt ?? lastSync.startedAt);
      elMetaInfo.innerHTML =
        `<div>Última varredura</div>` +
        `<div><strong>${dt.toLocaleString('pt-BR')}</strong></div>` +
        `<div>${cacheProcessos.length} processo(s) no acervo</div>`;
    } else {
      elMetaInfo.innerHTML = `<div>${cacheProcessos.length} processo(s) no acervo</div>`;
    }

    if (cacheProcessos.length === 0) {
      elVazioCard.hidden = false;
      elOrient.textContent = '';
      return;
    }

    renderResumo();
    renderCardsMetas();
  } catch (err) {
    console.error(`${LOG_PREFIX} metas-dashboard falhou:`, err);
    elOrient.textContent = `Erro ao carregar acervo: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

async function renderResumo(): Promise<void> {
  const stats = await getStats();
  const items: Array<{ v: number; l: string }> = [
    { v: stats.totalProcessos, l: 'No acervo' },
    { v: stats.presentesUltimaVarredura, l: 'Presentes na última varredura' },
    { v: stats.porStatus.pendente, l: 'Pendentes' },
    { v: stats.porStatus.julgado, l: 'Julgados' },
    { v: stats.porStatus.baixado, l: 'Baixados' }
  ];
  elResumo.innerHTML = items
    .map(
      (i) =>
        `<div class="meta-resumo__item"><div class="v">${i.v}</div>` +
        `<span class="l">${escapeHtml(i.l)}</span></div>`
    )
    .join('');
  elOrient.textContent =
    `Use os cartões abaixo para acompanhar cada meta. Aplicação de etiqueta em lote ` +
    `requer aba do PJe aberta (perfil ativo na vara).`;
}

function renderCardsMetas(): void {
  const ids: MetaCnjId[] = ['meta-2', 'meta-4', 'meta-6', 'meta-7', 'meta-10'];
  elMetasContainer.innerHTML = '';
  for (const id of ids) {
    const cfg = cacheConfig?.metas[id];
    if (!cfg?.ativada) continue;
    const card = montarCardMeta(id);
    elMetasContainer.appendChild(card);
  }
}

function montarCardMeta(id: MetaCnjId): HTMLElement {
  const label = META_LABELS[id];
  const cfg = cacheConfig!.metas[id];
  const enquadrados = cacheProcessos.filter(
    (p) => p.metas_aplicaveis.includes(id) && p.status !== 'baixado'
  );
  const julgados = enquadrados.filter((p) => p.status === 'julgado').length;
  const pendentes = enquadrados.filter((p) => p.status === 'pendente').length;
  const total = pendentes + julgados;
  const pct = total > 0 ? Math.round((julgados / total) * 100) : 0;

  const card = document.createElement('section');
  card.className = 'meta-card';

  const head = document.createElement('div');
  head.className = 'meta-card__head';
  head.innerHTML =
    `<div>` +
    `<h3 class="meta-card__title">${escapeHtml(label.titulo)}</h3>` +
    `<p class="meta-card__sub">${escapeHtml(label.sub)}</p>` +
    `</div>` +
    `<div class="meta-card__metric">${pct}% <small>cumprido</small></div>`;
  card.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'meta-card__bar';
  bar.innerHTML = `<div style="width: ${pct}%"></div>`;
  card.appendChild(bar);

  const resumo = document.createElement('div');
  resumo.className = 'meta-resumo';
  resumo.innerHTML =
    `<div class="meta-resumo__item"><div class="v">${total}</div>` +
    `<span class="l">No universo da meta</span></div>` +
    `<div class="meta-resumo__item"><div class="v">${pendentes}</div>` +
    `<span class="l">Pendentes (a julgar)</span></div>` +
    `<div class="meta-resumo__item"><div class="v">${julgados}</div>` +
    `<span class="l">Julgados</span></div>`;
  card.appendChild(resumo);

  // Lista dos pendentes (top 50, ordenado por data_distribuicao asc)
  const pendentesArr = enquadrados
    .filter((p) => p.status === 'pendente')
    .sort((a, b) => {
      const da = a.data_distribuicao ?? '9999';
      const db = b.data_distribuicao ?? '9999';
      return da.localeCompare(db);
    });

  if (pendentesArr.length === 0) {
    const aviso = document.createElement('div');
    aviso.className = 'alerta';
    aviso.textContent =
      total === 0
        ? 'Nenhum processo do acervo se enquadra nesta meta.'
        : 'Nenhum processo pendente nesta meta — todos já foram julgados.';
    card.appendChild(aviso);
  } else {
    const titulo = document.createElement('h4');
    titulo.style.cssText = 'margin: 12px 0 6px; font-size: 13px;';
    titulo.textContent = `Processos pendentes (${pendentesArr.length}, ordenados pelos mais antigos)${pendentesArr.length > 50 ? ' — exibindo os 50 primeiros' : ''}:`;
    card.appendChild(titulo);

    const ul = document.createElement('ul');
    ul.className = 'lista-processos';
    for (const p of pendentesArr.slice(0, 50)) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.textContent = p.numero_processo;
      link.href = p.url ?? '#';
      if (p.url) link.target = '_blank';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = 'copiar';
      copyBtn.addEventListener('click', () => {
        void navigator.clipboard.writeText(p.numero_processo);
        copyBtn.textContent = '✓';
        window.setTimeout(() => (copyBtn.textContent = 'copiar'), 1200);
      });
      const assunto = document.createElement('span');
      assunto.className = 'assunto';
      assunto.textContent = p.assunto_principal ?? p.classe_sigla;
      const distData = document.createElement('span');
      distData.className = 'badge';
      distData.textContent = p.data_distribuicao ?? '?';
      li.append(link, copyBtn, assunto, distData);
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  // Formulário aplicar etiqueta
  const acoes = document.createElement('div');
  acoes.className = 'meta-card__acoes';
  const sugestao = cfg.etiquetaSugerida ?? `META ${id}`;
  acoes.innerHTML =
    `<input type="text" id="etiq-${id}" value="${escapeHtmlAttr(sugestao)}" placeholder="Nome da etiqueta" />` +
    `<label><input type="checkbox" id="fav-${id}" /> Favoritar</label>` +
    `<button class="btn primary" id="apply-${id}" ${pendentesArr.length === 0 ? 'disabled' : ''}>` +
    `Aplicar nos ${pendentesArr.length} pendentes` +
    `</button>` +
    `<span id="status-${id}" style="font-size: 12px; color: var(--muted);"></span>`;
  card.appendChild(acoes);

  // Wire button (depois do appendChild)
  window.setTimeout(() => {
    const btn = document.getElementById(`apply-${id}`) as HTMLButtonElement | null;
    if (btn) {
      btn.addEventListener('click', () => {
        void aplicarEtiquetaLote(id, pendentesArr);
      });
    }
  }, 0);

  return card;
}

async function aplicarEtiquetaLote(
  id: MetaCnjId,
  processos: ProcessoMetasCnj[]
): Promise<void> {
  const inp = document.getElementById(`etiq-${id}`) as HTMLInputElement | null;
  const fav = document.getElementById(`fav-${id}`) as HTMLInputElement | null;
  const status = document.getElementById(`status-${id}`) as HTMLElement | null;
  const btn = document.getElementById(`apply-${id}`) as HTMLButtonElement | null;
  if (!inp || !status || !btn) return;
  const nome = inp.value.trim();
  if (!nome) {
    status.textContent = 'Informe o nome da etiqueta.';
    return;
  }
  const ids = processos.map((p) => p.id_processo_pje).filter((n) => n > 0);
  if (ids.length === 0) {
    status.textContent = 'Nenhum processo elegível.';
    return;
  }
  btn.disabled = true;
  status.textContent = 'Aplicando...';
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.METAS_APLICAR_ETIQUETAS,
      payload: {
        etiquetaPauta: nome,
        idsProcesso: ids,
        favoritarAposCriar: fav?.checked === true
      }
    });
    if (resp?.ok) {
      status.textContent = `Aplicado em ${resp.aplicadas ?? ids.length} processo(s).`;
    } else {
      status.textContent = `Falha: ${resp?.error ?? 'erro desconhecido'}`;
    }
  } catch (err) {
    status.textContent = `Erro: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    btn.disabled = false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s);
}
