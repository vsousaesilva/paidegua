/**
 * Página standalone do Ranking de advogados (RANK-01).
 *
 * Recurso de teste discreto — sem entrada visível no popup ou no PJe.
 * Acesso só por URL direta colada no navegador
 * (chrome-extension://<id>/ranking-advogados/ranking.html).
 *
 * Topologia: carregando → seletor → progresso → resultado.
 *
 * Comunicação:
 *  - LISTAR_TAREFAS, RUN_COLETA, CANCELAR: page → background → content.
 *  - PROGRESSO: content broadcast via runtime — page escuta via
 *    chrome.runtime.onMessage (background ignora).
 */

import { asBlob } from 'html-docx-js/dist/html-docx';
import html2pdf from 'html2pdf.js';
import { LOG_PREFIX, MESSAGE_CHANNELS } from '../shared/constants';
import type { GestaoTarefaInfo } from '../shared/types';

interface ListarTarefasResponse {
  ok: boolean;
  tarefas: GestaoTarefaInfo[];
  hostnamePJe?: string;
  legacyOrigin?: string;
  error?: string;
}

interface RankingItem {
  advogadoNome: string;
  advogadoOab: string | null;
  quantidade: number;
}

interface ParcialRanking {
  totalVarridos: number;
  enriquecidosAteAgora: number;
  totalParaEnriquecer: number;
  semAdvogado: number;
  ranking: RankingItem[];
}

interface ColetarRankingResponse {
  ok: boolean;
  totalVarridos: number;
  semAdvogado: number;
  cancelado: boolean;
  truncadoPorCap: boolean;
  truncadosCount: number;
  tarefasComFalha: Array<{ nome: string; error: string }>;
  ranking: RankingItem[];
  error?: string;
}

const sel = {
  carregando: byId('estado-carregando'),
  erro: byId('estado-erro'),
  seletor: byId('estado-seletor'),
  progresso: byId('estado-progresso'),
  resultado: byId('estado-resultado')
};
const elMeta = byId('meta');
const elErroMsg = byId('erro-msg');
const elBtnRecarregar = byId<HTMLButtonElement>('btn-recarregar');
const elBtnMarcarTodas = byId<HTMLButtonElement>('btn-marcar-todas');
const elBtnDesmarcarTodas = byId<HTMLButtonElement>('btn-desmarcar-todas');
const elBtnColetar = byId<HTMLButtonElement>('btn-coletar');
const elBtnCancelar = byId<HTMLButtonElement>('btn-cancelar');
const elInputCap = byId<HTMLInputElement>('input-cap');
const elListaTarefas = byId<HTMLUListElement>('lista-tarefas');
const elBarLabel = byId('bar-label');
const elTabelaParcialWrap = byId('tabela-parcial-wrap');
const elResultadoResumo = byId('resultado-resumo');
const elResultadoAvisos = byId('resultado-avisos');
const elTabelaWrap = byId('tabela-wrap');
const elBtnBaixarPdf = byId<HTMLButtonElement>('btn-baixar-pdf');
const elBtnBaixarDocx = byId<HTMLButtonElement>('btn-baixar-docx');
const elBtnNovaColeta = byId<HTMLButtonElement>('btn-nova-coleta');

let ultimoResultado: ColetarRankingResponse | null = null;
let hostnamePJe = '';

void main();

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
}

async function main(): Promise<void> {
  elBtnRecarregar.addEventListener('click', () => void carregarTarefas());
  elBtnMarcarTodas.addEventListener('click', () => marcarTodas(true));
  elBtnDesmarcarTodas.addEventListener('click', () => marcarTodas(false));
  elBtnColetar.addEventListener('click', () => void executarColeta());
  elBtnCancelar.addEventListener('click', () => void cancelarColeta());
  elBtnNovaColeta.addEventListener('click', () => void carregarTarefas());
  elBtnBaixarPdf.addEventListener('click', () => void baixarPdf());
  elBtnBaixarDocx.addEventListener('click', () => baixarDocx());

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.channel === MESSAGE_CHANNELS.RANKING_PROGRESSO) {
      atualizarParcial(message.payload as ParcialRanking);
    }
    return false;
  });

  await carregarTarefas();
}

async function carregarTarefas(): Promise<void> {
  mostrarEstado('carregando');
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.RANKING_LISTAR_TAREFAS
    })) as ListarTarefasResponse | undefined;
    if (!resp || !resp.ok) {
      const msg = resp?.error ?? 'Não foi possível listar tarefas do PJe.';
      exibirErro(amigaviarErroConexao(msg));
      return;
    }
    if (resp.tarefas.length === 0) {
      exibirErro(
        'O painel do PJe foi encontrado, mas não há nenhuma tarefa visível. ' +
          'Abra a página do painel da unidade e clique em "Tentar novamente".'
      );
      return;
    }
    hostnamePJe = resp.hostnamePJe ?? '';
    renderizarSeletor(resp.tarefas);
  } catch (err) {
    console.warn(`${LOG_PREFIX} ranking: falha ao listar tarefas`, err);
    exibirErro(amigaviarErroConexao(err instanceof Error ? err.message : String(err)));
  }
}

function amigaviarErroConexao(msg: string): string {
  if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
    return (
      'A aba do PJe está com versão antiga do content script (acontece quando ' +
      'a extensão foi recarregada depois que a aba já estava aberta). Vá na aba ' +
      'do PJe, aperte F5, e volte aqui para tentar novamente.'
    );
  }
  return msg;
}

function renderizarSeletor(tarefas: GestaoTarefaInfo[]): void {
  mostrarEstado('seletor');
  atualizarMeta(`${tarefas.length} tarefa(s) no painel${hostnamePJe ? ` · ${hostnamePJe}` : ''}`);
  elListaTarefas.innerHTML = '';
  tarefas.forEach((t, i) => {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `tarefa-${i}`;
    cb.value = t.nome;
    cb.checked = true;
    cb.addEventListener('change', atualizarBotaoColetar);
    const label = document.createElement('label');
    label.htmlFor = cb.id;
    const nome = document.createElement('span');
    nome.textContent = t.nome;
    const qtd = document.createElement('span');
    qtd.className = 'qtd';
    qtd.textContent = t.quantidade === null ? '' : `(${t.quantidade})`;
    label.append(nome, qtd);
    li.append(cb, label);
    elListaTarefas.appendChild(li);
  });
  atualizarBotaoColetar();
}

function marcarTodas(checked: boolean): void {
  elListaTarefas
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((cb) => {
      cb.checked = checked;
    });
  atualizarBotaoColetar();
}

function atualizarBotaoColetar(): void {
  const alguma = Array.from(
    elListaTarefas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  ).some((cb) => cb.checked);
  elBtnColetar.disabled = !alguma;
}

function tarefasSelecionadas(): string[] {
  return Array.from(
    elListaTarefas.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  )
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);
}

async function executarColeta(): Promise<void> {
  const nomes = tarefasSelecionadas();
  if (nomes.length === 0) return;
  const cap = Math.max(0, Math.trunc(Number(elInputCap.value) || 0));
  mostrarEstado('progresso');
  elBarLabel.textContent = `Listando processos de ${nomes.length} tarefa(s)...`;
  elTabelaParcialWrap.innerHTML = '<p class="hint">Aguardando primeiros resultados...</p>';
  elBtnCancelar.disabled = false;

  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.RANKING_RUN_COLETA,
      payload: { nomesTarefas: nomes, capEnriquecimento: cap }
    })) as ColetarRankingResponse | undefined;

    if (!resp || !resp.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao coletar ranking.';
      exibirErro(amigaviarErroConexao(msg));
      return;
    }
    ultimoResultado = resp;
    renderizarResultado(resp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    exibirErro(amigaviarErroConexao(msg));
  }
}

async function cancelarColeta(): Promise<void> {
  elBtnCancelar.disabled = true;
  elBarLabel.textContent = 'Cancelando — aguardando batch atual terminar...';
  try {
    await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.RANKING_CANCELAR
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} ranking: falha ao cancelar`, err);
  }
}

function atualizarParcial(p: ParcialRanking): void {
  // Só atualiza se estiver no estado progresso — evita atualizar a tabela
  // final após o resultado.
  if (sel.progresso.hidden) return;
  const totalEnriquecer = p.totalParaEnriquecer || 1;
  const pct = Math.round((p.enriquecidosAteAgora / totalEnriquecer) * 100);
  elBarLabel.textContent =
    `${p.totalVarridos} processo(s) varrido(s) · ` +
    `${p.enriquecidosAteAgora}/${p.totalParaEnriquecer} enriquecidos (${pct}%) · ` +
    `${p.ranking.length} advogado(s) identificado(s) até agora`;
  elTabelaParcialWrap.innerHTML = '';
  if (p.ranking.length === 0) {
    elTabelaParcialWrap.innerHTML = '<p class="hint">Nenhum advogado identificado ainda.</p>';
    return;
  }
  // Mostra só top 20 no parcial pra não pesar o DOM em coletas grandes.
  const top20 = p.ranking.slice(0, 20);
  elTabelaParcialWrap.appendChild(montarTabela(top20));
  if (p.ranking.length > 20) {
    const aviso = document.createElement('p');
    aviso.className = 'hint';
    aviso.textContent = `... e mais ${p.ranking.length - 20} advogado(s). Tabela completa aparece quando a coleta terminar.`;
    elTabelaParcialWrap.appendChild(aviso);
  }
}

function renderizarResultado(resp: ColetarRankingResponse): void {
  mostrarEstado('resultado');
  atualizarMeta(
    `${resp.totalVarridos} processo(s) · ${resp.ranking.length} advogado(s) · ` +
      `${resp.semAdvogado} sem advogado`
  );
  const sufixoCancelado = resp.cancelado ? ' (coleta cancelada — resultado parcial)' : '';
  elResultadoResumo.textContent =
    `${resp.totalVarridos} processo(s) único(s) varrido(s)${sufixoCancelado}. ` +
    `${resp.ranking.length} advogado(s) identificado(s); ` +
    `${resp.semAdvogado} processo(s) ficaram sem advogado identificável.`;

  elResultadoAvisos.innerHTML = '';
  if (resp.cancelado) {
    const div = document.createElement('div');
    div.className = 'aviso';
    div.textContent =
      'Coleta cancelada antes do fim. O ranking abaixo é parcial — ' +
      'os processos não enriquecidos contam apenas se a estimativa rápida ' +
      'achou OAB no polo ativo.';
    elResultadoAvisos.appendChild(div);
  }
  if (resp.truncadoPorCap) {
    const div = document.createElement('div');
    div.className = 'aviso';
    div.textContent =
      `${resp.truncadosCount} processo(s) ficaram fora da 2ª passada (HTML) ` +
      `por causa do limite escolhido. Esses só contam se a estimativa rápida ` +
      `achou OAB. Para enriquecer todos, aumente o limite na próxima coleta.`;
    elResultadoAvisos.appendChild(div);
  }
  for (const t of resp.tarefasComFalha) {
    const div = document.createElement('div');
    div.className = 'aviso';
    div.textContent = `Tarefa "${t.nome}" falhou: ${t.error}`;
    elResultadoAvisos.appendChild(div);
  }

  elTabelaWrap.innerHTML = '';
  if (resp.ranking.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Nenhum advogado identificado.';
    elTabelaWrap.appendChild(p);
    elBtnBaixarPdf.disabled = true;
    elBtnBaixarDocx.disabled = true;
    return;
  }
  elBtnBaixarPdf.disabled = false;
  elBtnBaixarDocx.disabled = false;
  elTabelaWrap.appendChild(montarTabela(resp.ranking));
}

function montarTabela(ranking: RankingItem[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'ranking';
  const thead = document.createElement('thead');
  thead.innerHTML =
    '<tr><th>#</th><th>Advogado</th><th>OAB</th><th class="qtd">Processos</th></tr>';
  const tbody = document.createElement('tbody');
  ranking.forEach((r, i) => {
    const tr = document.createElement('tr');
    const tdNum = document.createElement('td');
    tdNum.className = 'numero';
    tdNum.textContent = String(i + 1);
    const tdNome = document.createElement('td');
    tdNome.textContent = r.advogadoNome;
    const tdOab = document.createElement('td');
    tdOab.className = 'oab';
    tdOab.textContent = r.advogadoOab ?? '—';
    const tdQtd = document.createElement('td');
    tdQtd.className = 'qtd';
    tdQtd.textContent = String(r.quantidade);
    tr.append(tdNum, tdNome, tdOab, tdQtd);
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  return table;
}

function mostrarEstado(qual: keyof typeof sel): void {
  for (const k of Object.keys(sel) as Array<keyof typeof sel>) {
    sel[k].hidden = k !== qual;
  }
}

function exibirErro(msg: string): void {
  mostrarEstado('erro');
  elErroMsg.textContent = msg;
}

function atualizarMeta(texto: string): void {
  elMeta.textContent = texto;
}

// =====================================================================
// Export PDF / DOCX
// =====================================================================

function nomeArquivo(extensao: 'pdf' | 'docx'): string {
  const agora = new Date();
  const yyyy = agora.getFullYear();
  const mm = String(agora.getMonth() + 1).padStart(2, '0');
  const dd = String(agora.getDate()).padStart(2, '0');
  return `ranking-advogados-${yyyy}-${mm}-${dd}.${extensao}`;
}

function montarHtmlRelatorio(resp: ColetarRankingResponse): string {
  const dataGeracao = new Date().toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  const linhas = resp.ranking
    .map(
      (r, i) => `
        <tr>
          <td style="text-align:right;">${i + 1}</td>
          <td>${escapeHtml(r.advogadoNome)}</td>
          <td>${escapeHtml(r.advogadoOab ?? '—')}</td>
          <td style="text-align:right;">${r.quantidade}</td>
        </tr>`
    )
    .join('');
  const avisoParcial = resp.cancelado
    ? `<p style="margin:8px 0 16px;padding:8px 12px;background:#fff8e6;border-left:3px solid #F57C00;font-size:10pt;">
        Coleta cancelada antes do fim — resultado parcial.
       </p>`
    : '';
  const avisoTrunc = resp.truncadoPorCap
    ? `<p style="margin:8px 0 16px;padding:8px 12px;background:#fff8e6;border-left:3px solid #F57C00;font-size:10pt;">
        ${resp.truncadosCount} processo(s) não foram enriquecidos via HTML (limite atingido).
       </p>`
    : '';
  return `
<header style="border-bottom:2px solid #0C326F;padding-bottom:8px;margin-bottom:16px;">
  <h1 style="margin:0;color:#0C326F;font-size:18pt;">Ranking de advogados</h1>
  <p style="margin:4px 0 0;color:#5B6B82;font-size:10pt;">
    pAIdegua — caixa do usuário no PJe${hostnamePJe ? ` (${escapeHtml(hostnamePJe)})` : ''} · gerado em ${dataGeracao}
  </p>
</header>
${avisoParcial}
${avisoTrunc}
<div style="background:#f4f7fc;border:1px solid #d6dde6;padding:8px 12px;margin-bottom:16px;font-size:10pt;">
  <strong>${resp.totalVarridos}</strong> processo(s) único(s) varrido(s) ·
  <strong>${resp.ranking.length}</strong> advogado(s) identificado(s) ·
  <strong>${resp.semAdvogado}</strong> sem advogado identificável.
</div>
<table style="width:100%;border-collapse:collapse;font-size:11pt;">
  <thead>
    <tr style="background:#0C326F;color:#fff;">
      <th style="padding:6px 10px;text-align:right;">#</th>
      <th style="padding:6px 10px;text-align:left;">Advogado</th>
      <th style="padding:6px 10px;text-align:left;">OAB</th>
      <th style="padding:6px 10px;text-align:right;">Processos</th>
    </tr>
  </thead>
  <tbody>${linhas}</tbody>
</table>
<p style="margin-top:24px;font-size:9pt;color:#5B6B82;text-align:center;">
  pAIdegua — recurso interno de teste (RANK-01). Caixa do usuário logado.
</p>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function baixarPdf(): Promise<void> {
  if (!ultimoResultado) return;
  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'font-family:"Inter",Arial,sans-serif;color:#16243A;padding:24px;max-width:720px;margin:0 auto;';
  wrapper.innerHTML = montarHtmlRelatorio(ultimoResultado);
  document.body.appendChild(wrapper);
  try {
    await html2pdf()
      .set({
        margin: [12, 12, 12, 12],
        filename: nomeArquivo('pdf'),
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', 'thead'] }
      })
      .from(wrapper)
      .save();
  } catch (err) {
    console.warn('baixarPdf falhou:', err);
    alert('Falha ao gerar PDF: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    wrapper.remove();
  }
}

function baixarDocx(): void {
  if (!ultimoResultado) return;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ranking</title></head><body>${montarHtmlRelatorio(
    ultimoResultado
  )}</body></html>`;
  const blob = asBlob(html);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeArquivo('docx');
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
