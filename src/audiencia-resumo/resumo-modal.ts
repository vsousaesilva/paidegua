/**
 * Modal "Resumo do processo" da aba `audiencia-resumo/resumo.html` (AUD-10).
 *
 * Multi-vista: o mesmo modal hospeda o RESUMO (default) e a SENTENÇA ORAL
 * (gerada sob demanda com radio Procedente/Improcedente/Extinto). Os
 * dois textos ficam preservados em memória durante a sessão do modal —
 * o magistrado pode alternar entre eles via botões "← Voltar ao resumo"
 * e "Gerar sentença oral" sem refazer a coleta dos documentos.
 *
 * Fluxo do RESUMO:
 *   1. Coleta documentos do processo (via background → content script).
 *   2. Lê provider/model das settings.
 *   3. Abre porta CHAT_STREAM, envia prompt do resumo.
 *   4. Renderiza markdown progressivo (cursor piscando).
 *   5. Ao terminar, mostra rodapé com [PDF] [DOCX] [Sentença oral]
 *      [Ler completo] (este último só em modo='filtrado').
 *
 * Fluxo da SENTENÇA ORAL (após resumo gerado):
 *   1. Botão "Gerar sentença oral" abre escolha inline (radios).
 *   2. Confirma → reaproveita os mesmos documentos coletados (não refaz).
 *   3. Abre nova porta CHAT_STREAM com prompt da sentença + julgamento.
 *   4. Streaming substitui o conteúdo do modal (mantém resumo em memória).
 *   5. Ao terminar, rodapé: [PDF] [DOCX] [← Voltar ao resumo].
 *
 * Botões PDF/DOCX disparam geração via `resumo-export.ts` — PDF abre
 * window.print() (usuário escolhe "Salvar como PDF"); DOCX gera Blob
 * via html-docx-js e baixa diretamente.
 */

import {
  CHAT_PORT_MSG,
  MESSAGE_CHANNELS,
  PORT_NAMES,
  STORAGE_KEYS
} from '../shared/constants';
import { renderMarkdown } from '../content/ui/markdown';
import type {
  ChatStartPayload,
  PAIdeguaSettings,
  ProcessoDocumento
} from '../shared/types';
import { exportarDocx, exportarPdf } from './resumo-export';
import {
  montarPromptResumo,
  montarPromptSentencaOral,
  type DadosLinha,
  type SentencaJulgamento
} from './resumo-prompt';
import {
  prepararPromptComModelo,
  type ModeloUsado
} from './sentenca-modelo';

interface ColetarDocsResposta {
  ok: boolean;
  documentos?: ProcessoDocumento[];
  totalListados?: number;
  totalBaixados?: number;
  totalChars?: number;
  error?: string;
}

interface AbrirModalContext {
  /** requestId da aba (rid na query string). */
  requestId: string;
  legacyOrigin: string;
  linha: DadosLinha & { idProcesso: number; ca: string };
  modo: 'filtrado' | 'todos';
}

interface SessaoModal {
  ctx: AbrirModalContext;
  /** provider/model resolvidos pelas settings. */
  provider: string;
  model: string;
  /** Documentos já coletados — reaproveitados pelo fluxo da sentença. */
  documentos: ProcessoDocumento[];
  totalListados: number;
  totalBaixados: number;
  /** Texto markdown do resumo já gerado (preservado entre vistas). */
  resumoMarkdown: string;
  /** Texto markdown da sentença (oral ou com modelo), quando gerada. */
  sentencaMarkdown: string;
  sentencaJulgamento: SentencaJulgamento | null;
  /** Método de geração da sentença atual. */
  sentencaMetodo: 'oral' | 'modelo' | null;
  /** Modelo usado quando `sentencaMetodo === 'modelo'`. */
  sentencaModeloUsado: ModeloUsado | null;
  /** Vista atualmente exibida. */
  vista: 'resumo' | 'sentenca';
}

/**
 * Método selecionado quando o sub-dialog de escolha está aberto. Setado
 * em `mostrarEscolhaSentenca(metodo)` antes de o usuário interagir;
 * lido em "Gerar com/sem orientação" para despachar para o caminho
 * correto (oral / modelo).
 */
let metodoEscolhaAtual: 'oral' | 'modelo' = 'oral';

let sessao: SessaoModal | null = null;
let portaAtiva: chrome.runtime.Port | null = null;

// =====================================================================
// Setup
// =====================================================================

export function instalarFechamentoDoModal(): void {
  const modal = document.getElementById('modal-resumo');
  if (!modal) return;
  modal.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement | null;
    if (t?.hasAttribute('data-modal-close') || t?.closest('[data-modal-close]')) {
      fecharModal();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modal && !modal.hidden) {
      fecharModal();
    }
  });

  // Bind dos botões fixos do modal (sentença oral / com modelo, navegação, exports).
  el<HTMLButtonElement>('modal-btn-sentenca').addEventListener('click', () => {
    mostrarEscolhaSentenca('oral');
  });
  el<HTMLButtonElement>('modal-btn-sentenca-modelo').addEventListener('click', () => {
    mostrarEscolhaSentenca('modelo');
  });
  el<HTMLButtonElement>('modal-btn-sentenca-cancelar').addEventListener('click', () => {
    esconderEscolhaSentenca();
  });
  el<HTMLButtonElement>('modal-btn-sentenca-sem-orientacao').addEventListener('click', () => {
    const julgamento = lerJulgamentoEscolhido();
    if (!julgamento) return;
    despacharGeracaoSentenca(julgamento, '');
  });
  el<HTMLButtonElement>('modal-btn-sentenca-com-orientacao').addEventListener('click', () => {
    const julgamento = lerJulgamentoEscolhido();
    if (!julgamento) return;
    const orientacoes = el<HTMLTextAreaElement>('modal-sentenca-orientacao').value.trim();
    despacharGeracaoSentenca(julgamento, orientacoes);
  });

  function despacharGeracaoSentenca(
    julgamento: SentencaJulgamento,
    orientacoes: string
  ): void {
    if (metodoEscolhaAtual === 'modelo') {
      void iniciarSentencaComModelo(julgamento, orientacoes);
    } else {
      void iniciarSentencaOral(julgamento, orientacoes);
    }
  }

  // Label dinâmica: muda "Julgar [opção] — deseja..." conforme o radio.
  const radios = document.querySelectorAll<HTMLInputElement>(
    '#modal-sentenca-escolha input[name="julgamento"]'
  );
  for (const r of Array.from(radios)) {
    r.addEventListener('change', atualizarLabelOrientacao);
  }
  el<HTMLButtonElement>('modal-btn-voltar-resumo').addEventListener('click', () => {
    voltarParaResumo();
  });
  el<HTMLButtonElement>('modal-btn-pdf').addEventListener('click', () => {
    if (sessao) exportarVistaAtual('pdf');
  });
  el<HTMLButtonElement>('modal-btn-docx').addEventListener('click', () => {
    if (sessao) exportarVistaAtual('docx');
  });
  el<HTMLButtonElement>('modal-btn-completo').addEventListener('click', () => {
    if (!sessao) return;
    const ctxAtual = sessao.ctx;
    void abrirModalResumo({ ...ctxAtual, modo: 'todos' });
  });
}

function fecharModal(): void {
  abortarStreaming();
  sessao = null;
  const modal = document.getElementById('modal-resumo');
  if (modal) modal.hidden = true;
}

function abortarStreaming(): void {
  if (portaAtiva) {
    try {
      portaAtiva.postMessage({ type: CHAT_PORT_MSG.ABORT });
      portaAtiva.disconnect();
    } catch {
      /* já desconectada */
    }
    portaAtiva = null;
  }
}

// =====================================================================
// Fluxo principal: abrir modal + coletar docs + gerar resumo
// =====================================================================

export async function abrirModalResumo(ctx: AbrirModalContext): Promise<void> {
  abortarStreaming();
  esconderEscolhaSentenca();
  resetarUI(`Resumo — ${ctx.linha.cnj}`, ctx);

  el('modal-progresso-label').textContent =
    ctx.modo === 'filtrado'
      ? 'Coletando documentos principais do processo...'
      : 'Coletando TODOS os documentos do processo (pode demorar mais)...';

  // 1. Coletar documentos via background → content. Instala listener de
  // `chrome.storage.onChanged` para refletir as fases (extração / OCR /
  // finalizando) na label do modal em tempo real.
  const progressKey = `pkey-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const storageProgressKey =
    `${STORAGE_KEYS.AUDIENCIA_RESUMO_COLETA_PROGRESS_PREFIX}${progressKey}`;
  const onStorageChange = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ): void => {
    if (areaName !== 'session') return;
    const change = changes[storageProgressKey];
    if (!change) return;
    const novo = change.newValue as { msg?: string } | undefined;
    if (novo?.msg) {
      el('modal-progresso-label').textContent = novo.msg;
    }
  };
  chrome.storage.onChanged.addListener(onStorageChange);

  let coleta: ColetarDocsResposta;
  try {
    coleta = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.AUDIENCIA_RESUMO_COLETAR_DOCS,
      payload: {
        requestId: ctx.requestId,
        legacyOrigin: ctx.legacyOrigin,
        idProcesso: ctx.linha.idProcesso,
        ca: ctx.linha.ca,
        modo: ctx.modo,
        progressKey
      }
    })) as ColetarDocsResposta;
  } catch (err) {
    chrome.storage.onChanged.removeListener(onStorageChange);
    void chrome.storage.session.remove(storageProgressKey);
    return mostrarErro(err instanceof Error ? err.message : String(err));
  }
  // Limpa o listener e a chave temporária — coleta concluída.
  chrome.storage.onChanged.removeListener(onStorageChange);
  void chrome.storage.session.remove(storageProgressKey);

  if (!coleta || !coleta.ok) {
    return mostrarErro(coleta?.error ?? 'Falha ao coletar documentos do processo.');
  }

  const documentos = coleta.documentos ?? [];
  const totalListados = coleta.totalListados ?? 0;
  const totalBaixados = coleta.totalBaixados ?? documentos.length;

  if (documentos.length === 0) {
    return mostrarErro(
      `Nenhum documento ${ctx.modo === 'filtrado' ? 'relevante' : ''} foi extraído do processo` +
        (totalListados > 0
          ? ` (${totalListados} documento(s) listado(s) na timeline).`
          : '.')
    );
  }

  // 2. Lê provider/model das settings
  const cfg = await lerProviderModel();
  if (!cfg.ok) {
    return mostrarErro(cfg.error);
  }

  // 3. Inicializa sessão
  sessao = {
    ctx,
    provider: cfg.provider,
    model: cfg.model,
    documentos,
    totalListados,
    totalBaixados,
    resumoMarkdown: '',
    sentencaMarkdown: '',
    sentencaJulgamento: null,
    sentencaMetodo: null,
    sentencaModeloUsado: null,
    vista: 'resumo'
  };

  // 4. Streaming do resumo
  el('modal-progresso-label').textContent =
    `Gerando resumo (${totalBaixados} documento(s) analisado(s))...`;
  const corpo = el('modal-corpo');
  corpo.hidden = false;
  corpo.classList.add('is-streaming');
  corpo.innerHTML = '';

  iniciarStreaming({
    promptUser: montarPromptResumo(ctx.linha, ctx.modo),
    onChunk: (texto) => {
      if (!sessao) return;
      sessao.resumoMarkdown = texto;
      corpo.innerHTML = renderMarkdown(texto);
      corpo.scrollTop = corpo.scrollHeight;
    },
    onDone: () => {
      finalizarVistaResumo();
    },
    onError: (err) => mostrarErro(err)
  });
}

// =====================================================================
// Fluxo da sentença oral
// =====================================================================

function mostrarEscolhaSentenca(metodo: 'oral' | 'modelo'): void {
  metodoEscolhaAtual = metodo;
  el('modal-sentenca-escolha').hidden = false;
  // Pergunta inicial muda conforme o método.
  el('modal-sentenca-pergunta').textContent =
    metodo === 'modelo'
      ? 'Como julgar este processo? (será usado um modelo do seu acervo)'
      : 'Como julgar este processo?';
  // Reseta textarea e atualiza label conforme radio selecionado.
  el<HTMLTextAreaElement>('modal-sentenca-orientacao').value = '';
  atualizarLabelOrientacao();
  el<HTMLTextAreaElement>('modal-sentenca-orientacao').focus();
}

function esconderEscolhaSentenca(): void {
  el('modal-sentenca-escolha').hidden = true;
}

function lerJulgamentoEscolhido(): SentencaJulgamento | null {
  const radios = document.querySelectorAll<HTMLInputElement>(
    '#modal-sentenca-escolha input[name="julgamento"]:checked'
  );
  const v = radios[0]?.value;
  if (v === 'Procedente' || v === 'Improcedente' || v === 'Extinto') return v;
  return null;
}

/**
 * Atualiza o texto da label "Julgar [opção] — deseja fornecer..."
 * conforme o radio selecionado. Mantém a mensagem em sintonia com a
 * escolha atual sem precisar reabrir o sub-dialog.
 */
function atualizarLabelOrientacao(): void {
  const julg = lerJulgamentoEscolhido();
  if (!julg) return;
  const verbo =
    julg === 'Procedente'
      ? 'Julgar procedente'
      : julg === 'Improcedente'
        ? 'Julgar improcedente'
        : 'Extinguir o processo (sem mérito)';
  el('modal-sentenca-orientacao-label').innerHTML =
    `<strong>${escapeHtml(verbo)}</strong> — deseja fornecer orientações adicionais para a fundamentação?`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function iniciarSentencaOral(
  julgamento: SentencaJulgamento,
  orientacoes: string
): Promise<void> {
  if (!sessao) return;
  esconderEscolhaSentenca();
  abortarStreaming();

  sessao.vista = 'sentenca';
  sessao.sentencaJulgamento = julgamento;
  sessao.sentencaMetodo = 'oral';
  sessao.sentencaModeloUsado = null;
  sessao.sentencaMarkdown = '';

  el('modal-titulo').textContent =
    `Sentença oral (${julgamento}) — ${sessao.ctx.linha.cnj}`;

  // Esconde rodapé acoes / aviso temporariamente; mostra progresso.
  const progresso = el('modal-progresso');
  const progressoLabel = el('modal-progresso-label');
  const corpo = el('modal-corpo');
  const erroBox = el('modal-erro');
  const rodape = el('modal-rodape');
  const rodapeAviso = el('modal-rodape-aviso');

  progresso.hidden = false;
  progressoLabel.textContent =
    orientacoes
      ? `Gerando sentença oral (${julgamento}, com orientações)...`
      : `Gerando sentença oral (${julgamento})...`;
  erroBox.hidden = true;
  rodape.hidden = true;
  rodapeAviso.innerHTML = '';
  esconderTodosBotoesAcao();

  corpo.hidden = false;
  corpo.classList.add('is-streaming');
  corpo.innerHTML = '';

  iniciarStreaming({
    promptUser: montarPromptSentencaOral(sessao.ctx.linha, julgamento, orientacoes || undefined),
    onChunk: (texto) => {
      if (!sessao) return;
      sessao.sentencaMarkdown = texto;
      corpo.innerHTML = renderMarkdown(texto);
      corpo.scrollTop = corpo.scrollHeight;
    },
    onDone: () => {
      finalizarVistaSentenca();
    },
    onError: (err) => mostrarErro(err)
  });
}

async function iniciarSentencaComModelo(
  julgamento: SentencaJulgamento,
  orientacoes: string
): Promise<void> {
  if (!sessao) return;
  esconderEscolhaSentenca();
  abortarStreaming();

  sessao.vista = 'sentenca';
  sessao.sentencaJulgamento = julgamento;
  sessao.sentencaMetodo = 'modelo';
  sessao.sentencaModeloUsado = null;
  sessao.sentencaMarkdown = '';

  el('modal-titulo').textContent =
    `Sentença com modelo (${julgamento}) — ${sessao.ctx.linha.cnj}`;

  const progresso = el('modal-progresso');
  const progressoLabel = el('modal-progresso-label');
  const corpo = el('modal-corpo');
  const erroBox = el('modal-erro');
  const rodape = el('modal-rodape');
  const rodapeAviso = el('modal-rodape-aviso');

  progresso.hidden = false;
  progressoLabel.textContent = `Buscando modelo similar para "${julgamento}"...`;
  erroBox.hidden = true;
  rodape.hidden = true;
  rodapeAviso.innerHTML = '';
  esconderTodosBotoesAcao();

  // 1. Pipeline busca BM25 + rerank + buildMinutaPrompt.
  const r = await prepararPromptComModelo({
    julgamento,
    orientacoes: orientacoes || undefined,
    documentos: sessao.documentos,
    linha: sessao.ctx.linha
  });

  if (!r.ok) {
    // Sem config / sem hits → mostra erro com botão de fallback pra "oral".
    mostrarErroComFallbackOral(r.error, julgamento, orientacoes);
    return;
  }

  sessao.sentencaModeloUsado = r.modeloUsado;

  // 2. Streaming.
  progressoLabel.textContent = r.modeloUsado
    ? `Adaptando modelo "${nomeCurto(r.modeloUsado.relativePath)}"...`
    : `Gerando sentença (sem modelo similar encontrado)...`;
  corpo.hidden = false;
  corpo.classList.add('is-streaming');
  corpo.innerHTML = '';

  iniciarStreaming({
    promptUser: r.prompt,
    onChunk: (texto) => {
      if (!sessao) return;
      sessao.sentencaMarkdown = texto;
      corpo.innerHTML = renderMarkdown(texto);
      corpo.scrollTop = corpo.scrollHeight;
    },
    onDone: () => {
      finalizarVistaSentenca();
    },
    onError: (err) => mostrarErro(err)
  });
}

/**
 * Quando a "Sentença com modelo" falha por falta de config ou hits,
 * mostra erro com botão para gerar oral (sem modelo) com os mesmos
 * julgamento/orientações já preenchidos.
 */
function mostrarErroComFallbackOral(
  msg: string,
  julgamento: SentencaJulgamento,
  orientacoes: string
): void {
  mostrarErro(msg);
  el('modal-rodape').hidden = false;
  // Reaproveita o botão "Gerar sentença oral" do rodapé.
  const btn = el<HTMLButtonElement>('modal-btn-sentenca');
  btn.hidden = false;
  btn.textContent = 'Gerar sentença oral em vez disso';
  btn.onclick = (): void => {
    btn.textContent = 'Gerar sentença oral';
    btn.onclick = null;
    void iniciarSentencaOral(julgamento, orientacoes);
  };
}

function nomeCurto(relativePath: string): string {
  // Mostra só o nome do arquivo (sem caminho de pasta) para o aviso.
  const partes = relativePath.split(/[/\\]/);
  return partes[partes.length - 1] ?? relativePath;
}

function voltarParaResumo(): void {
  if (!sessao) return;
  abortarStreaming();
  sessao.vista = 'resumo';
  el('modal-titulo').textContent = `Resumo — ${sessao.ctx.linha.cnj}`;
  const corpo = el('modal-corpo');
  corpo.classList.remove('is-streaming');
  corpo.hidden = false;
  corpo.innerHTML = renderMarkdown(sessao.resumoMarkdown);
  corpo.scrollTop = 0;
  finalizarVistaResumo();
}

// =====================================================================
// Streaming reutilizável
// =====================================================================

interface StreamingOpts {
  promptUser: string;
  onChunk: (textoAcumulado: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

function iniciarStreaming(opts: StreamingOpts): void {
  if (!sessao) return;
  const payload: ChatStartPayload = {
    provider: sessao.provider as ChatStartPayload['provider'],
    model: sessao.model,
    messages: [
      {
        role: 'user',
        content: opts.promptUser,
        timestamp: Date.now()
      }
    ],
    documents: sessao.documentos,
    numeroProcesso: sessao.ctx.linha.cnj
  };

  try {
    portaAtiva = chrome.runtime.connect({ name: PORT_NAMES.CHAT_STREAM });
  } catch (err) {
    opts.onError(
      'Falha ao abrir conexão de streaming: ' +
        (err instanceof Error ? err.message : String(err))
    );
    return;
  }

  let buffer = '';
  portaAtiva.onMessage.addListener((msg: { type: string; delta?: string; error?: string }) => {
    if (msg.type === CHAT_PORT_MSG.CHUNK && typeof msg.delta === 'string') {
      buffer += msg.delta;
      opts.onChunk(buffer);
    } else if (msg.type === CHAT_PORT_MSG.DONE) {
      opts.onDone();
    } else if (msg.type === CHAT_PORT_MSG.ERROR) {
      opts.onError(msg.error ?? 'Erro desconhecido na geração.');
    }
  });
  portaAtiva.onDisconnect.addListener(() => {
    portaAtiva = null;
  });

  try {
    portaAtiva.postMessage({ type: CHAT_PORT_MSG.START, payload });
  } catch (err) {
    opts.onError(
      'Falha ao iniciar streaming: ' +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

// =====================================================================
// Finalização das vistas (montam o rodapé com aviso + botões adequados)
// =====================================================================

function finalizarVistaResumo(): void {
  if (!sessao) return;
  el('modal-corpo').classList.remove('is-streaming');
  el('modal-progresso').hidden = true;
  el('modal-rodape').hidden = false;

  const aviso = el('modal-rodape-aviso');
  if (sessao.ctx.modo === 'filtrado') {
    aviso.innerHTML =
      `<strong>Foram considerados os principais documentos do processo</strong> ` +
      `(${sessao.totalBaixados} de ${sessao.totalListados} documento(s) listado(s) ` +
      `na timeline). Para um resumo a partir do processo inteiro, clique em ` +
      `<em>"Ler o processo inteiro"</em>.`;
  } else {
    aviso.innerHTML =
      `Resumo gerado a partir de <strong>todos os ${sessao.totalBaixados} ` +
      `documento(s) extraído(s)</strong> da timeline (${sessao.totalListados} listado(s)).`;
  }

  esconderTodosBotoesAcao();
  el<HTMLButtonElement>('modal-btn-pdf').hidden = false;
  el<HTMLButtonElement>('modal-btn-docx').hidden = false;
  el<HTMLButtonElement>('modal-btn-sentenca').hidden = false;
  el<HTMLButtonElement>('modal-btn-sentenca-modelo').hidden = false;
  if (sessao.ctx.modo === 'filtrado') {
    el<HTMLButtonElement>('modal-btn-completo').hidden = false;
  }
}

function finalizarVistaSentenca(): void {
  if (!sessao) return;
  el('modal-corpo').classList.remove('is-streaming');
  el('modal-progresso').hidden = true;
  el('modal-rodape').hidden = false;

  const aviso = el('modal-rodape-aviso');
  if (sessao.sentencaMetodo === 'modelo' && sessao.sentencaModeloUsado) {
    const m = sessao.sentencaModeloUsado;
    const just = m.rerankJustificativa
      ? ` Critério de escolha: ${escapeHtml(m.rerankJustificativa)}`
      : '';
    aviso.innerHTML =
      `<strong>Sentença adaptada do modelo</strong> ` +
      `<em>"${escapeHtml(nomeCurto(m.relativePath))}"</em> ` +
      `do seu acervo. A estrutura do modelo foi preservada; apenas as ` +
      `questões de fato foram adaptadas a este processo.${just} ` +
      `<br/>Confira contra os autos antes da leitura em audiência.`;
  } else {
    aviso.innerHTML =
      `<strong>Sentença oral sugerida</strong> — texto gerado por IA com base nas ` +
      `provas dos autos. Confira contra os autos antes da leitura em audiência.`;
  }

  esconderTodosBotoesAcao();
  el<HTMLButtonElement>('modal-btn-pdf').hidden = false;
  el<HTMLButtonElement>('modal-btn-docx').hidden = false;
  el<HTMLButtonElement>('modal-btn-voltar-resumo').hidden = false;
}

function esconderTodosBotoesAcao(): void {
  for (const id of [
    'modal-btn-pdf',
    'modal-btn-docx',
    'modal-btn-sentenca',
    'modal-btn-sentenca-modelo',
    'modal-btn-voltar-resumo',
    'modal-btn-completo'
  ]) {
    const b = el<HTMLButtonElement>(id);
    b.hidden = true;
  }
}

// =====================================================================
// Export PDF/DOCX
// =====================================================================

function exportarVistaAtual(formato: 'pdf' | 'docx'): void {
  if (!sessao) return;
  const tipo = sessao.vista === 'sentenca' ? 'sentenca-oral' : 'resumo';
  const conteudoMarkdown =
    sessao.vista === 'sentenca' ? sessao.sentencaMarkdown : sessao.resumoMarkdown;
  if (!conteudoMarkdown) {
    alert('Nada para exportar — aguarde o término da geração.');
    return;
  }
  const conteudoHtml = renderMarkdown(conteudoMarkdown);
  const input = {
    tipo: tipo as 'resumo' | 'sentenca-oral',
    julgamento:
      sessao.vista === 'sentenca' && sessao.sentencaJulgamento
        ? sessao.sentencaJulgamento
        : undefined,
    linha: sessao.ctx.linha,
    conteudoHtml
  };
  if (formato === 'pdf') {
    void exportarPdf(input);
  } else {
    exportarDocx(input);
  }
}

// =====================================================================
// Helpers de UI / settings
// =====================================================================

function resetarUI(tituloTexto: string, ctx: AbrirModalContext): void {
  const modal = el('modal-resumo');
  modal.hidden = false;
  el('modal-titulo').textContent = tituloTexto;
  el('modal-subtitulo').textContent =
    `${ctx.linha.tipoAudiencia} • ${ctx.linha.dataHora} • ${ctx.linha.sala}`;
  el('modal-progresso').hidden = false;
  el('modal-corpo').hidden = true;
  el('modal-corpo').innerHTML = '';
  el('modal-corpo').classList.remove('is-streaming');
  el('modal-erro').hidden = true;
  el('modal-erro-msg').textContent = '';
  el('modal-rodape').hidden = true;
  el('modal-rodape-aviso').innerHTML = '';
  esconderTodosBotoesAcao();
  esconderEscolhaSentenca();
}

interface ProviderCfgOk {
  ok: true;
  provider: string;
  model: string;
}
interface ProviderCfgErr {
  ok: false;
  error: string;
}

async function lerProviderModel(): Promise<ProviderCfgOk | ProviderCfgErr> {
  let settings: PAIdeguaSettings;
  try {
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.GET_SETTINGS,
      payload: {}
    });
    settings = resp?.settings as PAIdeguaSettings;
  } catch (err) {
    return {
      ok: false,
      error:
        'Falha ao ler configurações: ' +
        (err instanceof Error ? err.message : String(err))
    };
  }
  if (!settings || !settings.activeProvider) {
    return { ok: false, error: 'Configurações do provedor de IA não encontradas.' };
  }
  const provider = settings.activeProvider;
  const model = settings.models?.[provider];
  if (!model) {
    return { ok: false, error: `Modelo não configurado para o provedor ${provider}.` };
  }
  return { ok: true, provider, model };
}

function mostrarErro(msg: string): void {
  el('modal-progresso').hidden = true;
  el('modal-corpo').hidden = true;
  el('modal-corpo').classList.remove('is-streaming');
  el('modal-erro').hidden = false;
  el('modal-erro-msg').textContent = msg;
  el('modal-rodape').hidden = false;
  el('modal-rodape-aviso').innerHTML = '';
  esconderTodosBotoesAcao();
  abortarStreaming();
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} não encontrado`);
  return e as T;
}
