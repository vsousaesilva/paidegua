/**
 * Página de configuração do perfil "Gestão Criminal" do paidegua.
 *
 * Responsabilidades (Fase 1):
 *   - Identificação do servidor (matrícula + vara) — gravada como audit
 *     em cada processo cadastrado posteriormente.
 *   - Pasta de auto-export — registra um FileSystemDirectoryHandle no
 *     IndexedDB para a futura ativação do agendamento (Fase 6).
 *   - Estatísticas do acervo (processos primários/auxiliares + réus).
 *   - Botão de "apagar todo o acervo" para reset / suporte.
 *
 * O service worker e os outros módulos do paidegua não dependem desta
 * página — ela é puramente de configuração. Por enquanto não é exposta
 * via popup; abre-se diretamente em
 *   chrome-extension://<id>/criminal-config/criminal-config.html
 * O entry point no popup será adicionado na Fase 3.
 */

import { LOG_PREFIX, MESSAGE_CHANNELS } from '../shared/constants';
import {
  apagarAcervoCompleto,
  clearExportFolderHandle,
  getCriminalStats,
  getExportFolderHandle,
  loadCriminalConfig,
  patchCriminalConfig,
  setExportFolderHandle
} from '../shared/criminal-store';
import { executarAutoExport } from '../shared/criminal-export';
import type {
  CriminalConfig,
  PeriodicidadeAutoExport,
  UltimoExportStatus
} from '../shared/criminal-types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`criminal-config: elemento #${id} ausente`);
  return el as T;
};

function setStatus(
  el: HTMLElement,
  text: string,
  kind: 'ok' | 'error' | '' = ''
): void {
  el.textContent = text;
  el.className = 'paidegua-criminal__status' + (kind ? ` is-${kind}` : '');
}

// ── Identificação do servidor ────────────────────────────────────

async function carregarConfig(): Promise<void> {
  const config = await loadCriminalConfig();
  $<HTMLInputElement>('input-matricula').value = config.servidor_responsavel ?? '';
  $<HTMLInputElement>('input-vara').value = config.vara_id ?? '';
}

async function salvarConfig(): Promise<void> {
  const matricula = $<HTMLInputElement>('input-matricula').value.trim();
  const vara = $<HTMLInputElement>('input-vara').value.trim();
  const status = $<HTMLSpanElement>('config-status');

  try {
    const patch: Partial<CriminalConfig> = {
      servidor_responsavel: matricula || undefined,
      vara_id: vara || undefined
    };
    await patchCriminalConfig(patch);
    setStatus(status, 'Configuração salva.', 'ok');
    setTimeout(() => setStatus(status, '', ''), 2500);
  } catch (err) {
    console.error(`${LOG_PREFIX} criminal-config: erro ao salvar config:`, err);
    setStatus(
      status,
      err instanceof Error ? err.message : 'Erro ao salvar.',
      'error'
    );
  }
}

// ── Pasta de auto-export ─────────────────────────────────────────

/**
 * `window.showDirectoryPicker` é parte da File System Access API. Em
 * contexto de extensão MV3 está disponível em páginas (não em service
 * worker). Tipagem ainda não está em lib.dom padrão — declaração local
 * cobre o uso necessário.
 */
declare global {
  interface Window {
    showDirectoryPicker?: (opts?: {
      mode?: 'read' | 'readwrite';
      id?: string;
      startIn?: string | FileSystemHandle;
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

async function carregarPastaExport(): Promise<void> {
  const status = $<HTMLDivElement>('export-status');
  const btnClear = $<HTMLButtonElement>('btn-pasta-clear');
  try {
    const reg = await getExportFolderHandle();
    if (!reg) {
      setStatus(status, 'Nenhuma pasta configurada.', '');
      btnClear.disabled = true;
      return;
    }
    const ts = new Date(reg.registeredAt).toLocaleString('pt-BR');
    setStatus(status, `Pasta configurada: ${reg.handle.name}  ·  registrada em ${ts}`, 'ok');
    btnClear.disabled = false;
  } catch (err) {
    console.error(`${LOG_PREFIX} criminal-config: erro lendo handle:`, err);
    setStatus(
      status,
      err instanceof Error ? err.message : 'Erro ao ler configuração.',
      'error'
    );
    btnClear.disabled = true;
  }
}

async function configurarPastaExport(): Promise<void> {
  const status = $<HTMLDivElement>('export-status');
  if (!window.showDirectoryPicker) {
    setStatus(
      status,
      'Seu navegador não suporta seleção de pasta (File System Access API).',
      'error'
    );
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite',
      id: 'paidegua-criminal-export'
    });
    await setExportFolderHandle(handle);
    await carregarPastaExport();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Usuário cancelou o picker — não é erro.
      return;
    }
    console.error(`${LOG_PREFIX} criminal-config: erro selecionando pasta:`, err);
    setStatus(
      status,
      err instanceof Error ? err.message : 'Erro ao selecionar pasta.',
      'error'
    );
  }
}

async function removerPastaExport(): Promise<void> {
  const status = $<HTMLDivElement>('export-status');
  const ok = confirm('Remover a configuração da pasta de auto-export?');
  if (!ok) return;
  try {
    await clearExportFolderHandle();
    await carregarPastaExport();
  } catch (err) {
    console.error(`${LOG_PREFIX} criminal-config: erro removendo handle:`, err);
    setStatus(
      status,
      err instanceof Error ? err.message : 'Erro ao remover.',
      'error'
    );
  }
}

// ── Agendamento do auto-export ──────────────────────────────────

async function carregarAgendamento(): Promise<void> {
  const config = await loadCriminalConfig();
  $<HTMLSelectElement>('select-periodicidade').value =
    config.auto_export_periodicidade ?? 'desligado';
  $<HTMLInputElement>('input-horario').value =
    config.auto_export_horario ?? '19:00';
  renderUltimoExport(config.ultimo_export_status);
}

function renderUltimoExport(status: UltimoExportStatus | undefined): void {
  const el = $<HTMLDivElement>('ultimo-export-info');
  if (!status) {
    el.textContent = 'Nenhuma execução de auto-export registrada ainda.';
    el.className = 'paidegua-criminal__hint paidegua-criminal__hint--small';
    return;
  }
  const ts = new Date(status.ts).toLocaleString('pt-BR');
  const origem =
    status.origem === 'agendamento' ? 'agendamento' : 'manual';
  if (status.ok) {
    el.innerHTML =
      `<strong>Última execução (${origem}):</strong> ✓ ${ts} — ${status.mensagem ?? ''}`;
    el.className =
      'paidegua-criminal__hint paidegua-criminal__hint--small is-ok';
  } else {
    el.innerHTML =
      `<strong>Última execução (${origem}):</strong> ✗ ${ts} — ${status.mensagem ?? 'falha desconhecida'}`;
    el.className =
      'paidegua-criminal__hint paidegua-criminal__hint--small is-error';
  }
}

async function salvarAgendamento(): Promise<void> {
  const status = $<HTMLSpanElement>('agendar-status');
  const periodicidade = $<HTMLSelectElement>('select-periodicidade')
    .value as PeriodicidadeAutoExport;
  const horario = $<HTMLInputElement>('input-horario').value;

  if (periodicidade !== 'desligado' && !/^\d{2}:\d{2}$/.test(horario)) {
    setStatus(status, 'Horário inválido (use HH:MM).', 'error');
    return;
  }

  // Sanity check: agendar com pasta não configurada é inútil — avisa
  // antes de salvar.
  if (periodicidade !== 'desligado') {
    const reg = await getExportFolderHandle();
    if (!reg) {
      setStatus(
        status,
        'Configure a pasta de auto-export antes de agendar.',
        'error'
      );
      return;
    }
  }

  try {
    await patchCriminalConfig({
      auto_export_periodicidade: periodicidade,
      auto_export_horario: horario
    });
    // Pede ao background para recriar o `chrome.alarms`.
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.CRIMINAL_REAGENDAR_AUTO_EXPORT
    })) as { ok: boolean; error?: string };
    if (!resp?.ok) {
      throw new Error(resp?.error ?? 'Falha reagendando alarm.');
    }
    setStatus(
      status,
      periodicidade === 'desligado'
        ? 'Agendamento desligado.'
        : `Agendado: ${periodicidade} às ${horario}.`,
      'ok'
    );
    setTimeout(() => setStatus(status, '', ''), 3000);
  } catch (err) {
    console.error(`${LOG_PREFIX} criminal-config: salvar agendamento:`, err);
    setStatus(
      status,
      err instanceof Error ? err.message : 'Erro ao salvar.',
      'error'
    );
  }
}

async function exportarAgora(): Promise<void> {
  const status = $<HTMLSpanElement>('agendar-status');
  const btn = $<HTMLButtonElement>('btn-export-now');
  btn.disabled = true;
  btn.textContent = '⏳ Exportando…';
  try {
    // Chamada local: a página tem gesto do usuário (clique no botão),
    // então pode pedir permissão se o navegador tiver revogado o
    // acesso à pasta. O SW não consegue fazer isso.
    const r = await executarAutoExport({
      permitirRequestPermission: true,
      origem: 'manual'
    });
    if (r.ok) {
      setStatus(
        status,
        `Exportado: ${r.arquivo} (${(r.bytes / 1024).toFixed(1)} KB).`,
        'ok'
      );
    } else {
      setStatus(status, r.error, 'error');
    }
  } catch (err) {
    setStatus(
      status,
      err instanceof Error ? err.message : 'Erro ao exportar.',
      'error'
    );
  } finally {
    btn.disabled = false;
    btn.textContent = 'Exportar agora';
    await carregarAgendamento();
  }
}

// ── Estatísticas do acervo ───────────────────────────────────────

async function carregarStats(): Promise<void> {
  try {
    const s = await getCriminalStats();
    $<HTMLElement>('stat-primarios').textContent = String(s.totalProcessosPrimarios);
    $<HTMLElement>('stat-auxiliares').textContent = String(
      s.totalProcessos - s.totalProcessosPrimarios
    );
    $<HTMLElement>('stat-reus').textContent = String(s.totalReus);
  } catch (err) {
    console.error(`${LOG_PREFIX} criminal-config: erro lendo stats:`, err);
  }
}

async function apagarAcervo(): Promise<void> {
  const status = $<HTMLSpanElement>('acervo-status');
  const passo1 = confirm(
    'ATENÇÃO: isto vai apagar TODOS os processos e réus cadastrados no acervo criminal local.\n\n' +
      'A configuração de identificação e a pasta de export NÃO serão apagadas.\n\n' +
      'Deseja continuar?'
  );
  if (!passo1) return;
  const passo2 = prompt(
    'Para confirmar, digite APAGAR (em maiúsculas) e clique em OK.'
  );
  if (passo2 !== 'APAGAR') {
    setStatus(status, 'Operação cancelada — confirmação não corresponde.', '');
    return;
  }
  try {
    await apagarAcervoCompleto({ manterConfig: true });
    await carregarStats();
    setStatus(status, 'Acervo apagado.', 'ok');
    setTimeout(() => setStatus(status, '', ''), 4000);
  } catch (err) {
    console.error(`${LOG_PREFIX} criminal-config: erro apagando acervo:`, err);
    setStatus(
      status,
      err instanceof Error ? err.message : 'Erro ao apagar.',
      'error'
    );
  }
}

// ── Inicialização ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  void carregarConfig();
  void carregarPastaExport();
  void carregarAgendamento();
  void carregarStats();

  $<HTMLButtonElement>('btn-salvar-config').addEventListener('click', () => {
    void salvarConfig();
  });
  $<HTMLButtonElement>('btn-pasta-pick').addEventListener('click', () => {
    void configurarPastaExport();
  });
  $<HTMLButtonElement>('btn-pasta-clear').addEventListener('click', () => {
    void removerPastaExport();
  });
  $<HTMLButtonElement>('btn-agendar-salvar').addEventListener('click', () => {
    void salvarAgendamento();
  });
  $<HTMLButtonElement>('btn-export-now').addEventListener('click', () => {
    void exportarAgora();
  });
  $<HTMLButtonElement>('btn-abrir-dashboard').addEventListener('click', () => {
    window.location.href = chrome.runtime.getURL(
      'criminal-dashboard/dashboard.html'
    );
  });
  $<HTMLButtonElement>('btn-acervo-apagar').addEventListener('click', () => {
    void apagarAcervo();
  });
  $<HTMLButtonElement>('btn-revisar-poluidos').addEventListener('click', () => {
    void abrirModalPoluidos();
  });
  $<HTMLButtonElement>('btn-modal-fechar').addEventListener('click', fecharModalPoluidos);
  $<HTMLButtonElement>('btn-modal-cancelar').addEventListener('click', fecharModalPoluidos);
  $<HTMLElement>('modal-poluidos-overlay').addEventListener('click', fecharModalPoluidos);
  $<HTMLButtonElement>('btn-modal-aplicar').addEventListener('click', () => {
    void aplicarLimpezaPoluidos();
  });
});

// ── Modal "Revisar dados inválidos" ───────────────────────────────

interface ItemPreviewLimpeza {
  tipo: 'processo' | 'reu';
  id: string;
  rotulo: string;
  campo: string;
  valorAtual: string;
  motivo: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function abrirModalPoluidos(): Promise<void> {
  const modal = $<HTMLElement>('modal-poluidos');
  const status = $<HTMLElement>('modal-poluidos-status');
  const lista = $<HTMLElement>('modal-poluidos-lista');
  const btnAplicar = $<HTMLButtonElement>('btn-modal-aplicar');
  modal.hidden = false;
  status.textContent = 'Carregando…';
  status.classList.remove('is-error');
  lista.hidden = true;
  lista.innerHTML = '';
  btnAplicar.disabled = true;
  btnAplicar.textContent = 'Limpar campos…';

  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.CRIMINAL_PREVIEW_LIMPEZA
    })) as {
      ok: boolean;
      itens?: ItemPreviewLimpeza[];
      error?: string;
    };
    if (!resp?.ok || !resp.itens) {
      status.textContent = `Falha ao carregar: ${resp?.error ?? 'erro desconhecido'}.`;
      status.classList.add('is-error');
      return;
    }
    const itens = resp.itens;
    if (itens.length === 0) {
      status.textContent =
        '✓ Nenhum dado inválido encontrado no acervo. Tudo certo.';
      return;
    }
    status.textContent = `${itens.length} campo(s) detectado(s) como inválido(s):`;
    lista.hidden = false;
    lista.innerHTML = itens
      .map((it) => {
        const tipoLabel = it.tipo === 'processo' ? 'Processo' : 'Réu';
        return `
          <div class="paidegua-criminal__poluido-item">
            <span class="paidegua-criminal__poluido-titulo">
              <span class="paidegua-criminal__poluido-tipo-badge">${escapeHtml(tipoLabel)}</span>
              ${escapeHtml(it.rotulo)}
            </span>
            <span class="paidegua-criminal__poluido-campo">
              Campo <code>${escapeHtml(it.campo)}</code> →
              será apagado e ficará disponível para preenchimento.
            </span>
            <div class="paidegua-criminal__poluido-valor">${escapeHtml(it.valorAtual)}</div>
            <span class="paidegua-criminal__poluido-motivo">${escapeHtml(it.motivo)}</span>
          </div>
        `;
      })
      .join('');
    btnAplicar.disabled = false;
    btnAplicar.textContent = `Limpar ${itens.length} campo(s)…`;
  } catch (err) {
    console.error(`${LOG_PREFIX} criminal-config: preview falhou:`, err);
    status.textContent =
      err instanceof Error ? err.message : 'Erro inesperado.';
    status.classList.add('is-error');
  }
}

function fecharModalPoluidos(): void {
  $<HTMLElement>('modal-poluidos').hidden = true;
}

async function aplicarLimpezaPoluidos(): Promise<void> {
  const btnAplicar = $<HTMLButtonElement>('btn-modal-aplicar');
  const status = $<HTMLElement>('modal-poluidos-status');
  if (
    !confirm(
      'Confirma a limpeza dos campos listados? A ação não pode ser desfeita ' +
        '(mas você pode preencher manualmente ou via nova varredura/IA depois).'
    )
  ) {
    return;
  }
  btnAplicar.disabled = true;
  btnAplicar.textContent = 'Aplicando…';
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.CRIMINAL_APLICAR_LIMPEZA
    })) as {
      ok: boolean;
      processosLimpos?: number;
      reusLimpos?: number;
      error?: string;
    };
    if (!resp?.ok) {
      status.textContent = `Falha ao aplicar: ${resp?.error ?? 'erro'}.`;
      status.classList.add('is-error');
      btnAplicar.disabled = false;
      btnAplicar.textContent = 'Limpar campos…';
      return;
    }
    const proc = resp.processosLimpos ?? 0;
    const reu = resp.reusLimpos ?? 0;
    status.textContent = `✓ Limpeza concluída: ${proc} processo(s) e ${reu} réu(s).`;
    status.classList.remove('is-error');
    status.classList.add('is-ok');
    $<HTMLElement>('modal-poluidos-lista').innerHTML = '';
    $<HTMLElement>('modal-poluidos-lista').hidden = true;
    btnAplicar.disabled = true;
    btnAplicar.textContent = 'Concluído';
    // Atualiza stats da página principal (totais não mudam, mas
    // mantém UX consistente).
    void carregarStats();
  } catch (err) {
    console.error(`${LOG_PREFIX} criminal-config: aplicar limpeza falhou:`, err);
    status.textContent =
      err instanceof Error ? err.message : 'Erro inesperado.';
    status.classList.add('is-error');
    btnAplicar.disabled = false;
    btnAplicar.textContent = 'Limpar campos…';
  }
}
