/**
 * Content script do PAIdegua — orquestrador da Fase 4.
 *
 * Fluxo:
 *   1. Detecta página → monta FAB + sidebar
 *   2. Carrega configurações do background (provedor ativo, modelo)
 *   3. "Carregar Documentos" → adapter lista, document-list é montada
 *   4. "Extrair conteúdos" → extractor processa, conteúdos ficam em memória
 *   5. Após extração, desbloqueia chat e botões de áudio/vídeo
 *   6. Chat: envia user message → abre porta long-lived → background faz
 *      streaming do provedor → chunks pintam a bolha do assistant em tempo real
 *   7. Quick actions (Resumir/Minutar) injetam prompts pré-definidos
 *   8. Botão de áudio: gera resumo → TTS → player
 *   9. Botão de vídeo: gera roteiro JSON → render slides + áudio → MediaRecorder
 *
 * Conteúdo de processo nunca persistido. API keys ficam apenas no
 * background script (chrome.storage.local cifrado).
 */

import {
  CHAT_PORT_MSG,
  LOG_PREFIX,
  MESSAGE_CHANNELS,
  PORT_NAMES,
  PROVIDER_LABELS,
  type ProviderId
} from '../shared/constants';
import {
  AUDIO_SUMMARY_PROMPT,
  QUICK_ACTIONS,
  TEMPLATE_ACTIONS_1G,
  TEMPLATE_ACTIONS_2G,
  TEMPLATE_ACTIONS_TRIAGEM,
  getTemplateActionsForGrau,
  buildMinutaPrompt,
  buildEmendaInicialPrompt,
  resolveTriagemCriterios,
  type TemplateAction,
  type TriagemResult
} from '../shared/prompts';
import type {
  ChatMessage,
  ChatStartPayload,
  PJeApiProcesso,
  PJeDetection,
  PAIdeguaSettings,
  ProcessoDocumento,
  SynthesizeSpeechResult,
  TriagemProcesso,
  TriagemTarefaSnapshot
} from '../shared/types';
import {
  sanitizePayloadForLLM,
  type TriagemPayloadAnon
} from '../shared/triagem-anonymize';
import { detect, isPJeHost } from './detector';
import { mountShell } from './ui/shell';
import { mountNavbarButton, type NavbarButtonController } from './ui/navbar-button';
import { mountSidebar, type SidebarController } from './ui/sidebar';
import {
  mountDocumentList,
  type DocumentListController
} from './ui/document-list';
import { mountChat, type ChatBubbleAction, type ChatController } from './ui/chat';
import { createTriagemPanel } from './ui/triagem-panel';
import { createAnaliseProcessoBubble } from './ui/analise-processo-bubble';
import { createEtiquetasSugestoesBubble } from './ui/etiquetas-sugestoes-bubble';
import {
  executarAnalisarTarefasComBridge,
  instalarListenerTriagemNoIframe
} from './triagem/triagem-bridge';
import { executarAnalisarProcesso } from './triagem/analisar-processo';
import { executarSugerirEtiquetas } from './triagem/sugerir-etiquetas';
import {
  coletarTarefasSelecionadas,
  instalarListenerGestaoNoIframe
} from './gestao/gestao-bridge';
import { instalarBridgeInterceptorAuth } from './auth/pje-auth-interceptor';
import { abrirPainelGerencial } from './gestao/gestao-coordinator';
import { abrirPrazosFitaPainel } from './gestao/prazos-fita-painel-coordinator';
import { computarIndicadoresGestao } from './gestao/gestao-indicadores';
import {
  coletarPrazosPorTarefasViaAPI,
  type ConsolidadoViaAPI,
  type StreamingEnumeratedMeta,
  type StreamingFinalizedArgs
} from './gestao/prazos-fita-coordinator';
import { consultarPorAssinatura as consultarPorAssinaturaScanState } from './gestao/prazos-fita-scan-state';
import { listarEtiquetas } from './pje-api/pje-api-from-content';
import { renderForPJe, stripMarkdown } from './ui/markdown';
import { detectPJeEditor, insertIntoPJeEditor, ensureTipoDocumentoSelected } from './ckeditor-bridge';
import { downloadWordDocument, suggestMinutaFilename } from '../shared/docx-export';
import type { SaveTemplatePayload } from '../shared/templates-save';
import {
  aplicarRegexAnonimizacao,
  aplicarSubstituicoesNomes,
  TRECHO_INICIAL_TAMANHO,
  type NomeAnonimizar
} from '../shared/anonymizer';
import {
  extractContents,
  getOcrPendingDocuments,
  runOcrOnDocuments
} from './extractor';
import { startRecording, blobToBase64, type RecorderHandle } from './audio-recorder';
import { recognizeLive, speakLocal, type SpeakHandle } from './web-speech';
import type { BaseAdapter } from './adapters/base-adapter';
import { derivarAnomaliasProcesso } from './adapters/pje-legacy';

interface MountedUI {
  sidebar: SidebarController;
  docList: DocumentListController | null;
  chat: ChatController | null;
}

let mounted: MountedUI | null = null;
/**
 * Botão do header do PJe — vive FORA do ciclo `mountUI/unmountUI` porque
 * deve aparecer também em telas sem processo aberto (painel do usuário,
 * lista de tarefas, etc.). Criado uma única vez no `bootstrap`.
 */
let navbarButton: NavbarButtonController | null = null;
let lastDetectionKey = '';
/**
 * Kill-switch global. Segue o campo `extensionEnabled` de
 * `PAIdeguaSettings`. Quando `false`, nenhum UI é montado no PJe (botão do
 * header, sidebar, painéis). Alternar o toggle no popup grava o novo valor
 * em storage e o listener abaixo reage desmontando/remontando a UI.
 */
let extensionEnabled = true;

const memory: {
  adapter: BaseAdapter | null;
  detection: PJeDetection | null;
  documentos: ProcessoDocumento[];
  extraidos: Map<string, ProcessoDocumento>;
  settings: PAIdeguaSettings | null;
  chatMessages: ChatMessage[];
  activePort: chrome.runtime.Port | null;
  recorder: RecorderHandle | null;
  currentSpeak: SpeakHandle | null;
} = {
  adapter: null,
  detection: null,
  documentos: [],
  extraidos: new Map(),
  settings: null,
  chatMessages: [],
  activePort: null,
  recorder: null,
  currentSpeak: null
};

function detectionKey(detection: PJeDetection): string {
  return [
    detection.isPJe,
    detection.version,
    detection.tribunal,
    detection.grau,
    detection.isProcessoPage,
    detection.numeroProcesso ?? ''
  ].join('|');
}

// =====================================================================
// Documents
// =====================================================================

/**
 * Detecta se a árvore de documentos do PJe tem lazy loading ativo —
 * ou seja, se há conteúdo não carregado abaixo da viewport do container.
 *
 * Heurística: percorre iframes same-origin (onde a árvore costuma morar)
 * e o próprio document procurando containers scrolláveis com scroll
 * restante significativo (>200px). Também verifica a presença de
 * indicadores visuais de "carregando mais" do PJe (spinners, placeholders).
 */
function detectLazyLoadingTree(): boolean {
  const check = (doc: Document): boolean => {
    // Procura containers scrolláveis com conteúdo oculto abaixo.
    const scrollables = doc.querySelectorAll<HTMLElement>(
      '[style*="overflow"], [class*="scroll"], [class*="tree"], [class*="anexo"], [class*="documento"]'
    );
    for (const el of Array.from(scrollables)) {
      const diff = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (el.clientHeight > 50 && diff > 200) {
        return true;
      }
    }
    // Verifica o body do iframe (a árvore inteira pode ser scrollável).
    if (doc.body) {
      const bodyDiff = doc.body.scrollHeight - doc.body.clientHeight - doc.body.scrollTop;
      if (doc.body.clientHeight > 50 && bodyDiff > 200) {
        return true;
      }
    }
    return false;
  };

  // Verifica no document principal.
  if (check(document)) return true;

  // Verifica em iframes same-origin (a árvore do PJe legacy mora lá).
  const frames = document.querySelectorAll<HTMLIFrameElement>('iframe, frame');
  for (const frame of Array.from(frames)) {
    try {
      const childDoc = frame.contentDocument;
      if (childDoc && childDoc.body && check(childDoc)) {
        return true;
      }
    } catch {
      /* cross-origin — ignora */
    }
  }
  return false;
}

async function handleLoadDocuments(): Promise<void> {
  if (!mounted || !memory.adapter) {
    return;
  }
  const sidebar = mounted.sidebar;
  sidebar.setLoadDocsEnabled(false);
  sidebar.setLoadDocsLabel('Carregando…');

  try {
    const documentos = memory.adapter.extractDocumentos();
    memory.documentos = documentos;
    memory.extraidos.clear();

    // Sai do modo "chat" (timeline) e volta para document-list
    if (mounted.chat) {
      mounted.chat.destroy();
      mounted.chat = null;
    }

    const docList = mountDocumentList(
      mountShell().shadow,
      sidebar.elements.body,
      {
        onExtract: (ids) => {
          void handleExtractSelected(ids);
        }
      }
    );
    docList.setDocuments(documentos);

    // Detecta se a árvore de documentos do PJe tem lazy loading (scroll com
    // conteúdo não carregado). O PJe carrega os anexos sob demanda conforme
    // o usuário rola a lista — se não rolou até o final, o DOM contém apenas
    // os primeiros documentos. Verificamos se há container scrollável cujo
    // scrollHeight > clientHeight, indicando conteúdo oculto abaixo.
    const lazyWarning = detectLazyLoadingTree();

    const statusBase =
      documentos.length === 0
        ? 'Nenhum documento encontrado no DOM. Veja o console para detalhes.'
        : `${documentos.length} documento(s) disponível(is). Selecione e extraia para conversar.`;
    const statusFull = lazyWarning
      ? `${statusBase}\n\n⚠ A lista de anexos do PJe pode não estar completa. Role a árvore de documentos até o final e clique em "Recarregar Documentos" para capturar todos.`
      : statusBase;
    docList.setGlobalStatus(statusFull);

    if (mounted.docList) {
      mounted.docList.destroy();
    }
    mounted.docList = docList;

    sidebar.setExtractedFeaturesEnabled(false);
    sidebar.setChatEnabled(false);
    sidebar.setOcrPending(0);
  } catch (error: unknown) {
    console.error(`${LOG_PREFIX} erro ao carregar documentos:`, error);
  } finally {
    sidebar.setLoadDocsEnabled(true);
    sidebar.setLoadDocsLabel('Recarregar Documentos');
  }
}

async function handleExtractSelected(selectedIds: string[]): Promise<void> {
  if (!mounted?.docList) {
    return;
  }
  const docList = mounted.docList;

  const selecionados = memory.documentos.filter((d) =>
    selectedIds.includes(d.id)
  );
  if (selecionados.length === 0) {
    return;
  }

  docList.setExtractEnabled(false);
  docList.setGlobalStatus(`Extraindo 0 de ${selecionados.length}…`);

  let concluidos = 0;
  const extraidosList = await extractContents(selecionados, (event) => {
    switch (event.type) {
      case 'document-start':
        docList.setItemStatus(event.documento.id, 'loading');
        break;
      case 'document-done':
        concluidos++;
        docList.setItemStatus(event.documento.id, 'done');
        docList.setGlobalStatus(
          `Extraindo ${concluidos} de ${selecionados.length}…`
        );
        memory.extraidos.set(event.documento.id, event.documento);
        break;
      case 'document-error':
        concluidos++;
        docList.setItemStatus(event.documento.id, 'error', event.error, event.diagnostics);
        docList.setGlobalStatus(
          `Extraindo ${concluidos} de ${selecionados.length}…`
        );
        break;
      default:
        break;
    }
  });

  const sucesso = extraidosList.length;
  const falhas = selecionados.length - sucesso;
  docList.setGlobalStatus(
    falhas === 0
      ? `Extração concluída — ${sucesso} documento(s) prontos para o chat.`
      : `Extração concluída — ${sucesso} ok, ${falhas} com erro.`
  );
  docList.setExtractEnabled(true);

  if (sucesso > 0 && mounted) {
    mounted.sidebar.setExtractedFeaturesEnabled(true);
    mounted.sidebar.setChatEnabled(true);
    const pending = getOcrPendingDocuments(getExtraidosArray()).length;
    mounted.sidebar.setOcrPending(pending);
    if (pending > 0) {
      if (memory.settings?.ocrAutoRun) {
        mounted.sidebar.setGlobalNotice(
          `${pending} documento(s) digitalizado(s). Iniciando OCR automático…`,
          'info'
        );
        void handleRunOcr();
      } else {
        mounted.sidebar.setGlobalNotice(
          `${pending} documento(s) digitalizado(s) sem texto extraído. Clique em "Rodar OCR pendente" para processá-los localmente.`,
          'warn'
        );
      }
    } else {
      mounted.sidebar.setGlobalNotice('', 'info');
    }
  }
}

// =====================================================================
// OCR
// =====================================================================

async function handleRunOcr(): Promise<void> {
  if (!mounted) {
    return;
  }
  const sidebar = mounted.sidebar;
  const pendentes = getOcrPendingDocuments(getExtraidosArray());
  if (pendentes.length === 0) {
    sidebar.setOcrPending(0);
    return;
  }

  sidebar.setOcrPending(pendentes.length, true);
  sidebar.setGlobalNotice(
    `Iniciando OCR de ${pendentes.length} documento(s)… isto pode levar alguns minutos.`,
    'info'
  );

  try {
    const maxPages = memory.settings?.ocrMaxPages;
    const merged = await runOcrOnDocuments(
      pendentes,
      (event) => {
      // Rótulo identificador do documento — sempre presente nos eventos
      // que carregam `event.documento`. Prioriza tipo/descrição e anexa o
      // id para permitir localizar o doc na árvore do PJe.
      const rotuloDoc = (d: ProcessoDocumento): string => {
        const base = d.tipo || d.descricao || `doc ${d.id}`;
        return `${base} (id ${d.id})`;
      };
      switch (event.type) {
        case 'ocr-document-start':
          sidebar.setGlobalNotice(
            `OCR: ${event.index + 1}/${pendentes.length} — ${rotuloDoc(event.documento)}…`,
            'info'
          );
          break;
        case 'ocr-page':
          sidebar.setGlobalNotice(
            `OCR: ${event.index + 1}/${pendentes.length} ${rotuloDoc(event.documento)} · página ${event.progress.currentPage}/${event.progress.totalPages} (${event.progress.status})`,
            'info'
          );
          break;
        case 'ocr-document-done':
          sidebar.setGlobalNotice(
            `OCR: ${event.index + 1}/${pendentes.length} ${rotuloDoc(event.documento)} concluído (${event.pagesProcessed} páginas${event.pagesSkipped > 0 ? `, ${event.pagesSkipped} puladas` : ''}).`,
            'info'
          );
          break;
        case 'ocr-document-error':
          sidebar.setGlobalNotice(
            `OCR: falha em ${rotuloDoc(event.documento)} — ${event.error}`,
            'warn'
          );
          console.warn(
            `${LOG_PREFIX} OCR falhou no documento:`,
            {
              id: event.documento.id,
              tipo: event.documento.tipo,
              descricao: event.documento.descricao,
              url: event.documento.url,
              erro: event.error
            }
          );
          break;
        default:
          break;
      }
    },
      maxPages ? { maxPages } : undefined
    );

    // Atualiza memory.extraidos com os documentos pós-OCR.
    for (const doc of merged) {
      if (memory.extraidos.has(doc.id)) {
        memory.extraidos.set(doc.id, doc);
      }
    }

    const pendentesApos = getOcrPendingDocuments(getExtraidosArray());
    const stillPending = pendentesApos.length;
    sidebar.setOcrPending(stillPending);
    if (stillPending === 0) {
      sidebar.setGlobalNotice('OCR concluído — todos os documentos digitalizados foram processados.', 'info');
    } else {
      const rotulo = (d: ProcessoDocumento): string => {
        const base = d.tipo || d.descricao || `doc ${d.id}`;
        return `${base} (id ${d.id})`;
      };
      const MAX_EXIBIR = 3;
      const lista = pendentesApos.slice(0, MAX_EXIBIR).map(rotulo).join('; ');
      const sufixo =
        stillPending > MAX_EXIBIR ? `; e mais ${stillPending - MAX_EXIBIR}` : '';
      sidebar.setGlobalNotice(
        `OCR parcial — ${stillPending} documento(s) ainda sem texto: ${lista}${sufixo}. Tente novamente ou revise manualmente.`,
        'warn'
      );
      console.warn(
        `${LOG_PREFIX} OCR parcial — documentos pendentes:`,
        pendentesApos.map((d) => ({
          id: d.id,
          tipo: d.tipo,
          descricao: d.descricao,
          url: d.url
        }))
      );
    }
  } catch (error: unknown) {
    sidebar.setOcrPending(pendentes.length, false);
    sidebar.setGlobalNotice(`Falha no OCR: ${errorMessage(error)}`, 'error');
  }
}

// =====================================================================
// Chat (porta long-lived com streaming)
// =====================================================================

/**
 * Fluxo completo de "Inserir no PJe":
 *  1. Tenta inserir no editor desta mesma janela (caso raro, mas rápido).
 *  2. Caso não haja editor local, pede ao background para encaminhar o
 *     conteúdo a todas as demais tabs jus.br abertas — a janela de "minutar
 *     peça", que o PJe costuma abrir em outra window, é descoberta assim.
 */
async function insertIntoPJeEditorFlow(_html: string, markdown: string): Promise<void> {
  const sidebar = mounted?.sidebar;

  // IMPORTANTE: ignoramos o `_html` renderizado para o chat — aquele HTML
  // contém marcadores de markdown úteis para visualização, mas inadequados
  // para a peça final. Reprocessamos o markdown cru com `renderForPJe`, que
  // gera HTML limpo (parágrafos com recuo de 1ª linha, citações em
  // blockquote recuado, sem marcadores `**`/`#`/`-`).
  const cleanHtml = renderForPJe(markdown);
  const cleanPlain = stripMarkdown(markdown);

  // Tenta auto-selecionar o tipo de ato na tab local (caso raro: editor na
  // mesma aba). O fluxo remoto (via background) cuida da seleção nas demais
  // tabs — vide insertionProbe no background.ts.
  const actionId = lastMinuta.action?.id ?? '';
  if (actionId) {
    await ensureTipoDocumentoSelected(actionId);
  }

  const localDetection = detectPJeEditor();
  if (localDetection.available) {
    const ok = insertIntoPJeEditor(cleanHtml, cleanPlain);
    if (ok) {
      sidebar?.setGlobalNotice(
        'Minuta inserida no editor do PJe.',
        'info'
      );
      window.setTimeout(() => sidebar?.setGlobalNotice('', 'info'), 2500);
      return;
    }
  }

  sidebar?.setGlobalNotice('Inserindo minuta no PJe…', 'info');
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.INSERT_IN_PJE_EDITOR,
      payload: { html: cleanHtml, plain: cleanPlain, actionId }
    })) as {
      ok: boolean;
      kind?: string;
      tabId?: number;
      triedTabs?: number;
      error?: string;
    };

    if (response?.ok) {
      sidebar?.setGlobalNotice(
        'Minuta inserida no editor do PJe.',
        'info'
      );
      window.setTimeout(() => sidebar?.setGlobalNotice('', 'info'), 2500);
      return;
    }

    sidebar?.setGlobalNotice(
      response?.error ??
        'Nenhum editor encontrado. Abra a tela de minutar peça no PJe e tente novamente.',
      'warn'
    );
  } catch (error: unknown) {
    sidebar?.setGlobalNotice(
      `Falha ao contatar outras janelas: ${errorMessage(error)}`,
      'error'
    );
  }
}

/**
 * Fluxo "Salvar como modelo": monta o payload e delega a gravação para a
 * página dedicada da extensão (abre em nova aba). A própria página cuida
 * de: ler o handle da pasta no IndexedDB, pedir readwrite, escrever o
 * .doc e anexar o registro no índice.
 */
async function openSaveAsModelFlow(html: string, markdown: string): Promise<void> {
  const sidebar = mounted?.sidebar;
  const action = lastMinuta.action;
  if (!action) {
    sidebar?.setGlobalNotice('Nenhuma minuta para salvar como modelo.', 'error');
    return;
  }

  const numeroProcesso = memory.detection?.numeroProcesso ?? null;
  const suggestedFilename = suggestMinutaFilename(numeroProcesso, action.label);

  const payload: SaveTemplatePayload = {
    html,
    markdown,
    actionLabel: action.label,
    actionId: action.id,
    numeroProcesso,
    suggestedFilename
  };

  sidebar?.setGlobalNotice('Abrindo página de salvamento…', 'info');
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TEMPLATES_SAVE_AS_MODEL,
      payload
    })) as { ok: boolean; error?: string } | undefined;

    if (!response?.ok) {
      sidebar?.setGlobalNotice(
        response?.error ?? 'Falha ao abrir página de salvamento.',
        'error'
      );
      return;
    }
    sidebar?.setGlobalNotice(
      'Confirme o salvamento na aba aberta. O modelo entra no índice logo após a gravação.',
      'info'
    );
    window.setTimeout(() => sidebar?.setGlobalNotice('', 'info'), 4000);
  } catch (error: unknown) {
    sidebar?.setGlobalNotice(
      `Falha ao iniciar salvamento: ${errorMessage(error)}`,
      'error'
    );
  }
}

function buildChatBubbleActions(): ChatBubbleAction[] {
  return [
    {
      id: 'copy',
      label: 'Copiar',
      title: 'Copiar a resposta para a área de transferência',
      onClick: (_html, markdown) => {
        void navigator.clipboard.writeText(markdown).then(
          () => {
            mounted?.sidebar.setGlobalNotice('Resposta copiada.', 'info');
            window.setTimeout(() => mounted?.sidebar.setGlobalNotice('', 'info'), 1800);
          },
          () => {
            mounted?.sidebar.setGlobalNotice('Falha ao copiar.', 'error');
          }
        );
      }
    },
    {
      id: 'insert-pje',
      label: 'Inserir no PJe',
      title: 'Inserir a resposta no editor aberto do PJe (minutar peça)',
      onClick: (html, markdown) => {
        void insertIntoPJeEditorFlow(html, markdown);
      }
    },
    {
      id: 'download-doc',
      label: 'Baixar .doc',
      title: 'Salvar a resposta como arquivo do Word (.doc)',
      onClick: (html, _markdown) => {
        const label = lastMinuta.action?.label ?? 'minuta';
        const filename = suggestMinutaFilename(
          memory.detection?.numeroProcesso ?? null,
          label
        );
        try {
          downloadWordDocument(html, filename);
          mounted?.sidebar.setGlobalNotice(`Arquivo "${filename}" baixado.`, 'info');
          window.setTimeout(() => mounted?.sidebar.setGlobalNotice('', 'info'), 2000);
        } catch (error: unknown) {
          mounted?.sidebar.setGlobalNotice(
            `Falha ao gerar .doc: ${errorMessage(error)}`,
            'error'
          );
        }
      }
    },
    {
      id: 'save-as-model',
      label: 'Salvar como modelo',
      title:
        'Salvar esta minuta, como está, na pasta de modelos — passa a ser ' +
        'referência para futuras gerações.',
      onClick: (html, markdown) => {
        if (!lastMinuta.action) {
          mounted?.sidebar.setGlobalNotice(
            'Nenhuma minuta para salvar como modelo.',
            'error'
          );
          return;
        }
        void openSaveAsModelFlow(html, markdown);
      }
    },
    {
      id: 'refine-minuta',
      label: 'Refinar minuta',
      title: 'Reaproveitar esta minuta com instruções adicionais de ajuste',
      onClick: (_html, _markdown) => {
        if (!lastMinuta.action) {
          mounted?.sidebar.setGlobalNotice(
            'Nenhuma minuta para refinar. Use os botões de minuta primeiro.',
            'error'
          );
          return;
        }
        promptRefineMinuta();
      }
    },
    {
      id: 'new-minuta',
      label: 'Nova minuta',
      title: 'Gerar uma nova versão da mesma ação, do zero (sem modelo)',
      onClick: (_html, _markdown) => {
        if (!lastMinuta.action) {
          mounted?.sidebar.setGlobalNotice(
            'Nenhuma minuta anterior. Use os botões de minuta primeiro.',
            'error'
          );
          return;
        }
        executeMinutaGeneration(lastMinuta.action, null);
      }
    },
    {
      id: 'encaminhar-emenda',
      label: 'Encaminhar e inserir no PJe',
      title:
        'Aciona a transição "Comunicação - Elaborar (emenda automática)" na aba ' +
        'do processo e injeta a minuta no editor da nova tarefa.',
      onClick: (html, _markdown) => {
        void handleEncaminharEmenda(html, (msg, kind) =>
          mounted?.sidebar.setGlobalNotice(msg, kind ?? 'info')
        );
      }
    }
  ];
}

/**
 * IDs de ações exibidas no rodapé da bolha de **emenda à inicial**.
 *
 * Mantém todos os botões padrão, mas troca "Inserir no PJe"
 * (`insert-pje`) por "Encaminhar e inserir no PJe" (`encaminhar-emenda`):
 * no fluxo de emenda o editor da nova tarefa ainda não existe, então o
 * CTA apropriado é o que encaminha a tarefa e insere em uma só ação.
 */
const EMENDA_BUBBLE_ACTION_IDS = [
  'copy',
  'encaminhar-emenda',
  'download-doc',
  'save-as-model',
  'refine-minuta',
  'new-minuta'
];

/**
 * IDs de ações exibidas no rodapé das bolhas de **minuta** (botão Minutar
 * e minutas com modelo). Mantém todos os botões padrão — apenas omite
 * "Encaminhar e inserir no PJe", que é específico do fluxo de emenda.
 */
const MINUTA_BUBBLE_ACTION_IDS = [
  'copy',
  'insert-pje',
  'download-doc',
  'save-as-model',
  'refine-minuta',
  'new-minuta'
];

/**
 * Pergunta ao usuário, via mensagem interativa no chat, qual instrução
 * adicional aplicar à última minuta. Mostra um campo único de texto e
 * dispara nova geração reaproveitando a mesma ação e (se houver) o mesmo
 * template.
 */
function promptRefineMinuta(): void {
  if (!lastMinuta.action) return;
  const instr = window.prompt(
    'Que ajuste devo aplicar à última minuta?\n' +
      '(ex.: encurtar, mudar tom, citar a Súmula 343 do STJ, reforçar o dispositivo)'
  );
  if (!instr || !instr.trim()) return;
  // Reusa o template original (se havia) — preserva continuidade.
  const tplHit = lastMinuta.template
    ? ({
        id: -1,
        relativePath: lastMinuta.template.relativePath,
        name: lastMinuta.template.relativePath,
        ext: '',
        text: lastMinuta.template.text,
        score: 0,
        similarity: 0,
        charCount: lastMinuta.template.text.length,
        matchedFolderHint: false
      } as TemplateSearchHit)
    : null;
  executeMinutaGeneration(lastMinuta.action, tplHit, instr.trim());
}

function ensureChatMounted(): ChatController {
  if (!mounted) {
    throw new Error('UI não montada.');
  }
  if (mounted.chat) {
    return mounted.chat;
  }
  // Trocamos a área de body do document-list para o chat (timeline)
  if (mounted.docList) {
    mounted.docList.destroy();
    mounted.docList = null;
  }
  const chat = mountChat(mountShell().shadow, mounted.sidebar.elements.body, {
    bubbleActions: buildChatBubbleActions()
  });
  const extraidosCount = memory.extraidos.size;
  if (extraidosCount > 0) {
    chat.setSystemNotice(
      `${extraidosCount} documento(s) carregado(s) no contexto. As respostas serão baseadas nos autos.`
    );
  }
  mounted.chat = chat;
  return chat;
}

function getExtraidosArray(): ProcessoDocumento[] {
  return Array.from(memory.extraidos.values());
}

/**
 * Converte uma `dataMovimentacao` PJe (formato BR `DD/MM/YYYY HH:MM:SS`)
 * em timestamp ms. Documentos sem data válida vão para o final da fila
 * (Number.POSITIVE_INFINITY) para não atropelar peças com data conhecida.
 */
function parseDataMovimentacaoToMs(s: string): number {
  if (!s) return Number.POSITIVE_INFINITY;
  const m = s.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (m) {
    const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = m;
    return new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss)
    ).getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Devolve os documentos extraídos ordenados cronologicamente do mais
 * antigo para o mais novo. A petição inicial — quase sempre a peça
 * mais antiga do feed PJe — fica no topo, garantindo que tanto a
 * anonimização quanto a busca de modelo similar enxerguem primeiro o
 * texto que descreve o tipo de causa e as partes.
 */
function getDocumentosOrdenadosCronologicamente(): ProcessoDocumento[] {
  return [...getExtraidosArray()].sort((a, b) => {
    const da = parseDataMovimentacaoToMs(a.dataMovimentacao);
    const db = parseDataMovimentacaoToMs(b.dataMovimentacao);
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });
}

/** Tamanho do trecho da petição inicial usado para enriquecer a busca BM25. */
const CASE_CONTEXT_TAMANHO = 3000;

/**
 * Tamanhos usados no contexto de TRIAGEM (botão MINUTAR). Separados do
 * `CASE_CONTEXT_TAMANHO` (que serve à busca BM25 e por isso lê só o
 * início) porque a triagem precisa saber o *momento atual* do processo —
 * que mora nos documentos mais recentes. Se reusássemos o mesmo 3k
 * cronológico, o LLM só veria inicial/contestação e recomendaria atos
 * já superados (ex.: "nomear perito" num processo já em cumprimento).
 */
const TRIAGEM_TIMELINE_SNIPPET = 240;
const TRIAGEM_RECENTES_QTD = 8;
const TRIAGEM_CONTEXT_TAMANHO = 18_000;

/**
 * Monta o contexto de TRIAGEM. Dois blocos complementares:
 *
 *  1. **Linha do tempo** (todos os docs, ordem cronológica): `{data} —
 *     {tipo/descricao} — {primeiros ~240 chars}`. Dá ao LLM uma visão
 *     panorâmica da trajetória do processo sem gastar o orçamento inteiro
 *     em texto integral.
 *
 *  2. **Documentos recentes em texto integral** (últimos N): permitem
 *     ao LLM identificar com precisão a última movimentação relevante
 *     (trânsito em julgado, RPV, cumprimento, pedido pendente etc.).
 *
 * O texto é truncado ao final a `TRIAGEM_CONTEXT_TAMANHO`.
 */
function buildTriagemContextText(): string {
  const cronologico = getDocumentosOrdenadosCronologicamente();
  if (cronologico.length === 0) return '';

  const fmt = (d: ProcessoDocumento): string => {
    const dt = d.dataMovimentacao || 's/ data';
    const tipo = (d.tipo || '').trim();
    const desc = (d.descricao || '').trim();
    let rot: string;
    if (tipo && desc && desc.toLowerCase() !== tipo.toLowerCase()) {
      rot = `${tipo} — "${desc}"`;
    } else {
      rot = tipo || desc || `doc ${d.id}`;
    }
    return `${dt} — ${rot} (id ${d.id})`;
  };

  // 1. Linha do tempo compacta.
  const linhaTempo: string[] = ['=== LINHA DO TEMPO DO PROCESSO ==='];
  for (const d of cronologico) {
    const t = (d.textoExtraido ?? '').replace(/\s+/g, ' ').trim();
    const head = t.slice(0, TRIAGEM_TIMELINE_SNIPPET);
    const trunc = t.length > TRIAGEM_TIMELINE_SNIPPET ? '…' : '';
    linhaTempo.push(`- ${fmt(d)}: ${head}${trunc}`);
  }

  // 2. Documentos recentes em texto integral — os que definem o momento
  //    processual atual. Mantém a ordem cronológica para facilitar a
  //    leitura pelo modelo.
  const recentes = cronologico.slice(-TRIAGEM_RECENTES_QTD);
  const blocoRecentes: string[] = [
    '',
    `=== DOCUMENTOS RECENTES (últimos ${recentes.length}, texto integral) ===`
  ];
  for (const d of recentes) {
    const t = d.textoExtraido ?? '';
    if (!t) continue;
    blocoRecentes.push(`--- ${fmt(d)} ---`);
    blocoRecentes.push(t);
    blocoRecentes.push('');
  }

  const total = [...linhaTempo, ...blocoRecentes].join('\n');
  return total.slice(0, TRIAGEM_CONTEXT_TAMANHO);
}

/**
 * Regex de datas encontradas no texto OCR/PDF dos documentos. Captura
 * datas numéricas (DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA, com ano de 2 ou
 * 4 dígitos) e extensas ("DD de MÊS de AAAA"). Usada para montar a
 * lista de "DATAS CANDIDATAS" enviada ao LLM em "Analisar o processo".
 */
const DATAS_NUM_REGEX = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\b/g;
const DATAS_EXT_REGEX =
  /\b(\d{1,2})\s+de\s+(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})\b/gi;

/**
 * Rótulos de documentos para os quais a data de emissão é decisiva na
 * análise de admissibilidade (procuração — prazo de 1 ano; comprovante
 * de endereço — prazo de 1 ano; e variações comuns). Tipo e descrição
 * são checados juntos.
 */
const DOCS_DATA_SENSIVEIS: RegExp[] = [
  /procura[çc][aã]o/i,
  /substabelec/i,
  /comprovante.*endere[çc]o/i,
  /comprovante.*resid[eê]ncia/i,
  /declara[çc][aã]o\s+de\s+(moradia|resid[eê]ncia)/i,
  /conta\s+de\s+(luz|[áa]gua|energia|g[áa]s|telefone|internet)/i,
  /fatura/i,
  /boleto/i
];

function isDocDataSensivel(d: ProcessoDocumento): boolean {
  const hay = `${d.tipo || ''} ${d.descricao || ''}`;
  return DOCS_DATA_SENSIVEIS.some((r) => r.test(hay));
}

interface DataCandidata {
  raw: string;
  trecho: string;
}

/**
 * Palavras no contexto imediato de uma data que indicam se tratar de
 * norma/ato citado no corpo do documento (portarias, leis, decretos,
 * resoluções etc.), e não da data de emissão do documento em análise.
 * Datas com esses marcadores nas proximidades são descartadas para não
 * poluir a lista de "DATAS CANDIDATAS".
 */
const DATA_RUIDO_REGEX =
  /\b(portaria|resolu[çc][aã]o|instru[çc][aã]o\s+normativa|decreto|decreto[- ]lei|lei|lei\s+complementar|medida\s+provis[óo]ria|provimento|s[úu]mula|enunciado|artigo|art\.?|§|inciso|cap[ií]tulo|c[óo]digo|emenda|ac[óo]rd[ãa]o|nasc(imento|ido)|dn|rg|cpf|cnh|identidade|expedi[çc][aã]o|matr[íi]cula)\b/i;

/**
 * Extrai as datas aparentes no texto com ±40 chars de contexto. Cap de
 * 12 entradas por documento para manter o prompt enxuto — números e
 * datas extensas juntos raramente superam isso em comprovantes e
 * procurações. Datas em contexto de norma/ato citado (PORTARIA, LEI,
 * DECRETO etc.) ou de identificação pessoal (RG, CPF, DN) são
 * descartadas, pois não representam a data de emissão do documento.
 *
 * A janela para detecção de ruído (±120) é maior que a janela de
 * exibição (±40) — citações longas como "PORTARIA CONJUNTA
 * Nº3/DIRAT/DIRBEN/INSS, de 08 de dezembro de 2017" deixam o
 * marker "PORTARIA" ~44 chars antes da data, fora da janela curta.
 */
const DATA_TRECHO_WINDOW = 40;
const DATA_RUIDO_WINDOW = 120;

function extrairDatasComContexto(texto: string): DataCandidata[] {
  if (!texto) return [];
  const out: DataCandidata[] = [];
  const vistos = new Set<string>();
  const push = (raw: string, idx: number, len: number): void => {
    const ruidoIni = Math.max(0, idx - DATA_RUIDO_WINDOW);
    const ruidoFim = Math.min(texto.length, idx + len + DATA_RUIDO_WINDOW);
    const janelaRuido = texto.slice(ruidoIni, ruidoFim);
    if (DATA_RUIDO_REGEX.test(janelaRuido)) return;

    const ini = Math.max(0, idx - DATA_TRECHO_WINDOW);
    const fim = Math.min(texto.length, idx + len + DATA_TRECHO_WINDOW);
    const trecho = texto.slice(ini, fim).replace(/\s+/g, ' ').trim();
    const key = `${raw}|${trecho}`;
    if (vistos.has(key)) return;
    vistos.add(key);
    out.push({ raw, trecho });
  };

  DATAS_NUM_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATAS_NUM_REGEX.exec(texto)) !== null) {
    push(m[0], m.index, m[0].length);
    if (out.length >= 12) return out;
  }
  DATAS_EXT_REGEX.lastIndex = 0;
  while ((m = DATAS_EXT_REGEX.exec(texto)) !== null) {
    push(m[0], m.index, m[0].length);
    if (out.length >= 12) return out;
  }
  return out;
}

/**
 * Monta o bloco "DATAS CANDIDATAS" para os documentos data-sensíveis.
 * Documentos sem nenhuma data legível são listados explicitamente com
 * "nenhuma data encontrada" — sinal para o LLM marcar o critério como
 * não atendido sem tentar inferir.
 */
function buildDatasCandidatasBlock(docs: ProcessoDocumento[]): string {
  const alvo = docs.filter(isDocDataSensivel);
  if (alvo.length === 0) return '';

  const lines: string[] = [
    '=== DATAS CANDIDATAS (extração automática do texto extraído) ===',
    'Use SOMENTE estas datas como base factual ao avaliar prazos em documentos data-sensíveis (procuração, comprovante de endereço e congêneres). Não invente datas ausentes.'
  ];
  for (const d of alvo) {
    const desc = d.descricao && d.descricao !== d.tipo ? ` — "${d.descricao}"` : '';
    lines.push('');
    lines.push(`(id ${d.id}) ${d.tipo || '(sem tipo)'}${desc}`);
    const datas = extrairDatasComContexto(d.textoExtraido ?? '');
    if (datas.length === 0) {
      lines.push('  - nenhuma data encontrada no texto extraído');
      continue;
    }
    for (const { raw, trecho } of datas) {
      lines.push(`  - ${raw}  ←  "…${trecho}…"`);
    }
  }
  return lines.join('\n');
}

/**
 * Descobre a data de ajuizamento a partir dos documentos já extraídos.
 * Prefere um documento cujo tipo/descrição sinalize "Petição inicial";
 * na ausência, cai na menor `dataMovimentacao` do feed (o primeiro doc
 * cronológico é quase sempre a inicial no PJe legacy).
 */
function descobrirDataAjuizamento(docs: ProcessoDocumento[]): string | null {
  const inicial = docs.find(
    (d) =>
      /peti[çc][aã]o\s+inicial/i.test(d.tipo || '') ||
      /peti[çc][aã]o\s+inicial/i.test(d.descricao || '')
  );
  const fonte = inicial ?? docs[0];
  const m = (fonte?.dataMovimentacao ?? '').match(/^(\d{2}\/\d{2}\/\d{4})/);
  return m ? m[1] : null;
}

/**
 * Monta o bloco "METADADOS DO PROCESSO" (data de ajuizamento e data de
 * hoje) que ancora o LLM no prazo de 1 ano para procuração e
 * comprovante de endereço, evitando que ele calcule o prazo a partir
 * da data errada.
 */
function buildAnaliseMetadadosBlock(
  docs: ProcessoDocumento[],
  numeroProcesso: string | null
): string {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const anoCNJ = numeroProcesso?.match(/\d{7}-\d{2}\.(\d{4})\./)?.[1] ?? null;
  const dataAjuiz = descobrirDataAjuizamento(docs);

  const lines: string[] = ['=== METADADOS DO PROCESSO ==='];
  if (numeroProcesso) lines.push(`Número: ${numeroProcesso}`);
  if (dataAjuiz) {
    lines.push(
      `Data de ajuizamento (data de juntada da petição inicial): ${dataAjuiz}`
    );
  } else if (anoCNJ) {
    lines.push(`Ano de ajuizamento (extraído do número CNJ): ${anoCNJ}`);
  }
  lines.push(`Data de hoje: ${hoje}`);
  return lines.join('\n');
}

/**
 * Contexto específico do botão "Analisar o processo". Prefixa ao
 * contexto padrão de triagem dois blocos que o LLM precisa para avaliar
 * prazos sem alucinar:
 *
 *  1. METADADOS DO PROCESSO — data de ajuizamento e data de hoje.
 *  2. DATAS CANDIDATAS — para cada documento data-sensível, as datas
 *     aparentes no texto com trecho de contexto. Quando o extractor
 *     não acha data, declara "nenhuma data encontrada", convidando o
 *     LLM a reprovar o critério sem inventar.
 *
 * Os blocos ficam no INÍCIO do contexto, de modo que sobrevivem ao
 * truncamento aplicado em `buildAnaliseProcessoPrompt`.
 */
function buildAnaliseProcessoContextText(
  numeroProcesso: string | null
): string {
  const docs = getDocumentosOrdenadosCronologicamente();
  if (docs.length === 0) return '';

  const metadados = buildAnaliseMetadadosBlock(docs, numeroProcesso);
  const datas = buildDatasCandidatasBlock(docs);
  const base = buildTriagemContextText();

  return [metadados, datas, base].filter((s) => s.length > 0).join('\n\n');
}

/**
 * Monta um trecho do processo (a partir da petição inicial cronológica)
 * para alimentar a busca BM25 de modelos similares. Sem esse contexto a
 * busca usa apenas a `queryHints` fixa da ação (ex.: "sentença julga
 * procedente…") e não consegue distinguir, p.ex., uma sentença
 * procedente de benefício assistencial de uma de auxílio-doença ou
 * revisão de RMI. Com o contexto, termos como "BPC", "LOAS",
 * "deficiência", "miserabilidade" passam a entrar na query e o IDF do
 * BM25 favorece templates que contenham esse mesmo vocabulário.
 *
 * Devolve string vazia se nenhum documento foi extraído.
 */
function buildCaseContextText(): string {
  const sorted = getDocumentosOrdenadosCronologicamente();
  if (sorted.length === 0) return '';
  let texto = '';
  for (const d of sorted) {
    const t = d.textoExtraido ?? '';
    if (!t) continue;
    if (texto.length > 0) texto += '\n\n';
    texto += t;
    if (texto.length >= CASE_CONTEXT_TAMANHO) break;
  }
  return texto.slice(0, CASE_CONTEXT_TAMANHO);
}

/**
 * Vocabulário de termos jurídicos discriminatórios por matéria.
 *
 * Cada entrada mapeia uma expressão (que pode conter espaços — será
 * buscada como substring no texto normalizado) a um ou mais "termos de
 * busca" que devem entrar na query BM25. Termos compostos como "benefício
 * de prestação continuada" são listados junto com suas siglas e sinônimos
 * para que o BM25 encontre templates que usem qualquer variante.
 *
 * A lista não precisa ser exaustiva — precisa cobrir as matérias mais
 * comuns na JFCE (previdenciário, assistencial, tributário, administrativo)
 * com termos suficientes para que o IDF do BM25 discrimine a matéria.
 */
const SUBJECT_VOCABULARY: Array<{ patterns: string[]; searchTerms: string[] }> = [
  // ── Benefício assistencial (BPC / LOAS) ──
  {
    patterns: [
      'bpc', 'loas', 'beneficio de prestacao continuada',
      'beneficio assistencial', 'prestacao continuada',
      'miserabilidade', 'hipossuficiencia', 'vulnerabilidade social',
      'renda per capita', 'renda familiar', 'meio salario minimo',
      'lei 8742', 'lei 8.742', 'deficiencia', 'pessoa com deficiencia',
      'idoso', 'assistencia social'
    ],
    searchTerms: [
      'bpc', 'loas', 'beneficio prestacao continuada assistencial',
      'miserabilidade hipossuficiencia vulnerabilidade',
      'deficiencia idoso renda familiar'
    ]
  },
  // ── Aposentadoria por idade ──
  {
    patterns: [
      'aposentadoria por idade', 'aposentadoria idade urbana',
      'aposentadoria idade rural', 'aposentadoria rural',
      'segurado especial', 'trabalhador rural', 'regime economia familiar',
      'atividade rural', 'labor rural', 'tempo rural'
    ],
    searchTerms: [
      'aposentadoria idade urbana rural',
      'segurado especial trabalhador rural',
      'regime economia familiar labor rural'
    ]
  },
  // ── Aposentadoria por tempo de contribuição ──
  {
    patterns: [
      'aposentadoria por tempo', 'tempo de contribuicao',
      'aposentadoria tempo contribuicao', 'contagem reciproca',
      'averbacao tempo', 'certidao tempo contribuicao'
    ],
    searchTerms: [
      'aposentadoria tempo contribuicao',
      'averbacao contagem reciproca'
    ]
  },
  // ── Aposentadoria por incapacidade / invalidez ──
  {
    patterns: [
      'aposentadoria por invalidez', 'aposentadoria por incapacidade',
      'incapacidade permanente', 'invalidez', 'grande invalidez',
      'aposentadoria incapacidade permanente'
    ],
    searchTerms: [
      'aposentadoria invalidez incapacidade permanente',
      'grande invalidez'
    ]
  },
  // ── Auxílio-doença / Auxílio por incapacidade temporária ──
  {
    patterns: [
      'auxilio doenca', 'auxilio-doenca', 'auxilio por incapacidade temporaria',
      'incapacidade temporaria', 'incapacidade laborativa',
      'pericia medica', 'laudo pericial'
    ],
    searchTerms: [
      'auxilio doenca incapacidade temporaria',
      'pericia medica laudo pericial incapacidade'
    ]
  },
  // ── Pensão por morte ──
  {
    patterns: [
      'pensao por morte', 'pensao morte', 'dependente',
      'obito', 'falecimento', 'instituidor'
    ],
    searchTerms: [
      'pensao morte dependente obito falecimento instituidor'
    ]
  },
  // ── Auxílio-acidente ──
  {
    patterns: [
      'auxilio acidente', 'auxilio-acidente', 'acidente trabalho',
      'sequela', 'reducao capacidade'
    ],
    searchTerms: [
      'auxilio acidente trabalho sequela reducao capacidade'
    ]
  },
  // ── Salário-maternidade ──
  {
    patterns: [
      'salario maternidade', 'salario-maternidade',
      'gestante', 'maternidade', 'parto', 'nascimento filho'
    ],
    searchTerms: [
      'salario maternidade gestante parto'
    ]
  },
  // ── Revisão de benefício / RMI ──
  {
    patterns: [
      'revisao de beneficio', 'revisao beneficio', 'rmi',
      'renda mensal inicial', 'revisao rmi', 'recalculo',
      'salario de beneficio', 'buraco negro', 'revisao da vida toda',
      'vida toda', 'tema 1102'
    ],
    searchTerms: [
      'revisao beneficio renda mensal inicial rmi',
      'recalculo salario beneficio'
    ]
  },
  // ── Tributário ──
  {
    patterns: [
      'imposto de renda', 'irpf', 'irpj', 'isencao tributaria',
      'contribuicao previdenciaria', 'pis', 'cofins', 'csll',
      'execucao fiscal', 'divida ativa', 'credito tributario',
      'compensacao tributaria', 'restituicao', 'indebito tributario',
      'icms', 'ipi', 'iss'
    ],
    searchTerms: [
      'tributario imposto renda isencao contribuicao',
      'execucao fiscal divida ativa credito tributario',
      'compensacao restituicao indebito'
    ]
  },
  // ── Servidor público / Administrativo ──
  {
    patterns: [
      'servidor publico', 'servidor federal', 'funcionalismo',
      'remuneracao', 'gratificacao', 'adicional', 'progressao funcional',
      'anuenio', 'quinquenio', 'regime juridico unico', 'lei 8112',
      'lei 8.112', 'pss', 'funpresp'
    ],
    searchTerms: [
      'servidor publico federal administrativo',
      'gratificacao remuneracao progressao funcional'
    ]
  },
  // ── FGTS ──
  {
    patterns: [
      'fgts', 'fundo de garantia', 'tr', 'expurgos inflacionarios',
      'correcao monetaria fgts'
    ],
    searchTerms: [
      'fgts fundo garantia correcao monetaria expurgos'
    ]
  },
  // ── SFH / Habitacional ──
  {
    patterns: [
      'sfh', 'sistema financeiro habitacao', 'contrato habitacional',
      'mutuario', 'cef', 'caixa economica', 'fcvs',
      'seguro habitacional', 'financiamento imobiliario'
    ],
    searchTerms: [
      'sfh sistema financeiro habitacao mutuario',
      'financiamento imobiliario seguro habitacional'
    ]
  }
];

/**
 * Extrai termos jurídicos discriminatórios do texto do processo.
 *
 * Em vez de alimentar o BM25 com 3000 chars de texto bruto (que contém
 * nomes, CPFs, datas, endereços — tokens irrelevantes que diluem a query),
 * esta função varre o texto à procura de expressões indicativas de matéria
 * jurídica e devolve apenas os termos de busca correspondentes.
 *
 * O resultado é uma string curta e focada que, concatenada ao `queryHints`
 * da ação, permite ao BM25 discriminar templates por assunto. Exemplo:
 *   queryHints: "sentença julga procedente pedido autor…"
 *   subjectTerms: "bpc loas beneficio prestacao continuada assistencial…"
 *   → query final favorece templates de BPC/LOAS em vez de Aposentadoria.
 */
function extractSubjectTerms(caseText: string): string {
  if (!caseText) return '';

  // Normaliza: lowercase + remove diacríticos (mesma lógica do tokenizer BM25)
  const norm = caseText
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const matched = new Set<string>();

  for (const entry of SUBJECT_VOCABULARY) {
    for (const pat of entry.patterns) {
      if (norm.includes(pat)) {
        for (const st of entry.searchTerms) {
          matched.add(st);
        }
        break; // basta casar um pattern do grupo para incluir os searchTerms
      }
    }
  }

  if (matched.size === 0) return '';
  return Array.from(matched).join(' ');
}

/**
 * Lista de IDs de ações que aparecem no rodapé das bolhas de **resumo**.
 * Outros tipos (minutas, perguntas livres) recebem o conjunto completo
 * definido em `buildChatBubbleActions`.
 */
const SUMMARY_BUBBLE_ACTION_IDS = ['copy', 'download-doc'];

function sendChatMessage(
  text: string,
  isQuickAction = false,
  displayLabel?: string,
  bubbleKind: 'summary' | 'minuta' | 'emenda' | 'default' = 'default'
): void {
  if (!mounted || !memory.settings) {
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  const chat = ensureChatMounted();
  // Para quick actions: se um `displayLabel` foi passado, mostra ele na
  // bolha de usuário no lugar do prompt cru (que tipicamente é gigante).
  // Sem label, cai no comportamento antigo: primeira linha truncada.
  const userBubbleText = isQuickAction
    ? displayLabel ?? trimmed.split('\n')[0]?.slice(0, 80) ?? trimmed
    : trimmed;
  chat.addUserMessage(userBubbleText);
  memory.chatMessages.push({
    role: 'user',
    content: trimmed,
    timestamp: Date.now()
  });
  const beginOpts =
    bubbleKind === 'summary'
      ? { allowedActionIds: SUMMARY_BUBBLE_ACTION_IDS }
      : bubbleKind === 'emenda'
        ? { allowedActionIds: EMENDA_BUBBLE_ACTION_IDS }
        : bubbleKind === 'minuta'
          ? { allowedActionIds: MINUTA_BUBBLE_ACTION_IDS }
          : undefined;
  chat.beginAssistantMessage(beginOpts);

  // Encerra qualquer porta anterior
  if (memory.activePort) {
    try {
      memory.activePort.disconnect();
    } catch {
      /* ignore */
    }
    memory.activePort = null;
  }

  const port = chrome.runtime.connect({ name: PORT_NAMES.CHAT_STREAM });
  memory.activePort = port;

  port.onMessage.addListener((msg: { type: string; delta?: string; error?: string }) => {
    if (!mounted?.chat) {
      return;
    }
    if (msg.type === CHAT_PORT_MSG.CHUNK && typeof msg.delta === 'string') {
      mounted.chat.appendAssistantDelta(msg.delta);
    } else if (msg.type === CHAT_PORT_MSG.DONE) {
      mounted.chat.endAssistantMessage();
      const finalMessages = mounted.chat.getMessages();
      memory.chatMessages = finalMessages;
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      memory.activePort = null;
    } else if (msg.type === CHAT_PORT_MSG.ERROR) {
      mounted.chat.failAssistantMessage(msg.error ?? 'Falha desconhecida');
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      memory.activePort = null;
    }
  });

  port.onDisconnect.addListener(() => {
    memory.activePort = null;
  });

  const payload: ChatStartPayload = {
    provider: memory.settings.activeProvider,
    model: memory.settings.models[memory.settings.activeProvider],
    messages: memory.chatMessages,
    documents: getExtraidosArray(),
    numeroProcesso: memory.detection?.numeroProcesso ?? null,
    temperature: memory.settings.temperature,
    maxTokens: memory.settings.maxTokens
  };
  port.postMessage({ type: CHAT_PORT_MSG.START, payload });
}

// =====================================================================
// Quick actions
// =====================================================================

/**
 * Labels exibidos na bolha de "usuário" do chat ao acionar uma quick action.
 * Mais limpos que mostrar o prompt cru (que tem várias linhas e dá poluição
 * visual). O prompt completo continua indo para o modelo, só não aparece no
 * histórico visível.
 */
const QUICK_ACTION_LABELS: Record<string, string> = {
  resumir: 'Resumindo o processo…',
  'minutar-despacho': 'Gerando minuta…',
  partes: 'Listando as partes…'
};

function handleQuickAction(id: string): void {
  const action = QUICK_ACTIONS.find((a) => a.id === id);
  if (!action) {
    return;
  }
  // "resumir" produz um resumo do processo — bolha recebe apenas
  // Copiar e Baixar .doc, sem opções de minuta.
  const kind: 'summary' | 'default' = id === 'resumir' ? 'summary' : 'default';
  sendChatMessage(action.prompt, true, QUICK_ACTION_LABELS[id], kind);
}

// =====================================================================
// Template actions (5 botões "Minutas com modelo")
// =====================================================================

/**
 * Resposta tipada do handler `TEMPLATES_SEARCH` no background.
 * O texto completo do template vem embutido para os top-K resultados —
 * o caso de uso (5 botões com top-3) torna inviável fazer round-trip
 * extra para buscar o texto após o usuário escolher.
 */
interface TemplateSearchHit {
  id: number;
  relativePath: string;
  name: string;
  ext: string;
  charCount: number;
  score: number;
  /** Similaridade normalizada em 0..100. */
  similarity: number;
  matchedFolderHint: boolean;
  text: string;
}

async function templatesHasConfig(): Promise<boolean> {
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TEMPLATES_HAS_CONFIG,
      payload: null
    })) as { ok: boolean; hasTemplates: boolean };
    return Boolean(response?.hasTemplates);
  } catch {
    return false;
  }
}

async function templatesSearch(
  query: string,
  folderHints: string[],
  excludeTerms?: string[]
): Promise<TemplateSearchHit[]> {
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TEMPLATES_SEARCH,
      payload: { query, opts: { folderHints, topK: 8, excludeTerms } }
    })) as { ok: boolean; results?: TemplateSearchHit[]; error?: string };
    return response?.results ?? [];
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} templatesSearch falhou:`, error);
    return [];
  }
}

/**
 * Pede ao background para reordenar os candidatos do BM25 usando o LLM
 * ativo (RAG híbrido). Devolve `null` em caso de falha — o chamador deve
 * cair de volta para a ordem original do BM25 sem barulho.
 */
async function templatesRerank(
  actionLabel: string,
  caseContext: string,
  hits: TemplateSearchHit[]
): Promise<{ ordered: TemplateSearchHit[]; justificativa: string } | null> {
  if (hits.length < 2 || !caseContext) return null;
  try {
    const candidates = hits.map((h, i) => ({
      index: i,
      relativePath: h.relativePath,
      // Excerto do começo do template — onde costumam aparecer relatório,
      // partes e enquadramento da matéria. Suficiente para o LLM decidir.
      excerpt: (h.text ?? '').slice(0, 1500)
    }));
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.TEMPLATES_RERANK,
      payload: { actionLabel, caseContext, candidates }
    })) as {
      ok: boolean;
      ranking?: number[];
      justificativa?: string;
      error?: string;
    };
    if (!response?.ok || !response.ranking || response.ranking.length === 0) {
      if (response?.error) {
        console.warn(`${LOG_PREFIX} rerank LLM falhou: ${response.error}`);
      }
      return null;
    }
    const ordered: TemplateSearchHit[] = [];
    const seen = new Set<number>();
    for (const idx of response.ranking) {
      if (idx >= 0 && idx < hits.length && !seen.has(idx)) {
        seen.add(idx);
        ordered.push(hits[idx]!);
      }
    }
    // Defensivo: completa eventuais faltantes na ordem original.
    for (let i = 0; i < hits.length; i++) {
      if (!seen.has(i)) ordered.push(hits[i]!);
    }
    return { ordered, justificativa: response.justificativa ?? '' };
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} templatesRerank falhou:`, error);
    return null;
  }
}

/**
 * Estado da última geração de minuta — usado pelo botão "Refinar minuta"
 * para reaplicar a mesma ação/template com uma instrução adicional.
 */
const lastMinuta: {
  action: TemplateAction | null;
  template: { relativePath: string; text: string } | null;
} = { action: null, template: null };

/**
 * Dispara a geração propriamente dita: monta o prompt, registra estado
 * para refinamento posterior, e envia ao LLM via sendChatMessage.
 */
function executeMinutaGeneration(
  action: TemplateAction,
  template: TemplateSearchHit | null,
  refinement?: string
): void {
  const tplForPrompt = template
    ? { relativePath: template.relativePath, text: template.text }
    : null;
  lastMinuta.action = action;
  lastMinuta.template = tplForPrompt;

  const prompt = buildMinutaPrompt(action, tplForPrompt, refinement);
  const label = template
    ? `Gerando ${action.label.toLowerCase()} com modelo ${template.relativePath}…`
    : `Gerando ${action.label.toLowerCase()} (sem modelo)…`;
  sendChatMessage(prompt, true, label, 'minuta');
}

// =====================================================================
// Triagem — botão "Minutar": IA sugere o melhor ato para o momento atual
// =====================================================================

/**
 * Fluxo do botão "Minutar":
 *  1. Confere se há documentos extraídos.
 *  2. Chama o LLM de triagem (background) com os atos do grau detectado.
 *  3. Exibe no chat a recomendação + justificativa, com botões:
 *       [Gerar esta minuta]  [Escolher outro ato ▾]
 *  4. Ao escolher "outro ato", abre segunda bolha com todos os atos do grau.
 *  5. Em caso de falha na triagem (sem key, JSON inválido, etc.), abre
 *     direto a bolha de escolha manual, preservando a funcionalidade.
 */
async function handleMinutarTriagem(): Promise<void> {
  if (!mounted) return;
  const sidebar = mounted.sidebar;
  const grau = memory.detection?.grau ?? 'unknown';

  const docs = getExtraidosArray();
  if (docs.length === 0) {
    sidebar.setGlobalNotice(
      'Carregue e extraia documentos antes de solicitar a triagem.',
      'error'
    );
    return;
  }

  // Triagem usa contexto próprio (timeline + docs recentes integrais) —
  // ver buildTriagemContextText. Reutilizar o buildCaseContextText, que é
  // cronológico crescente e pequeno, faria a triagem ignorar as últimas
  // movimentações e recomendar atos já superados.
  const caseContext = buildTriagemContextText();
  if (!caseContext) {
    sidebar.setGlobalNotice(
      'Nenhum conteúdo textual disponível nos documentos extraídos.',
      'error'
    );
    return;
  }

  sidebar.setGlobalNotice('Analisando momento processual com IA…', 'info');

  let triagemResult: TriagemResult | null = null;
  let availableActions: Array<{ id: string; label: string; description: string }> = [];
  let triagemError: string | null = null;

  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.MINUTAR_TRIAGEM,
      payload: { grau, caseContext }
    })) as {
      ok: boolean;
      result?: TriagemResult;
      availableActions?: Array<{ id: string; label: string; description: string }>;
      error?: string;
    };
    availableActions = response?.availableActions ?? [];
    if (response?.ok && response.result) {
      triagemResult = response.result;
    } else {
      triagemError = response?.error ?? 'Triagem indisponível.';
    }
  } catch (err) {
    triagemError = err instanceof Error ? err.message : String(err);
  }

  sidebar.setGlobalNotice('', 'info');

  // Fallback: calcula as ações localmente se o background não devolveu.
  if (availableActions.length === 0) {
    availableActions = getTemplateActionsForGrau(grau).map((a) => ({
      id: a.id,
      label: a.label,
      description: a.description
    }));
  }

  const chat = ensureChatMounted();

  const showEscolherOutro = (): void => {
    chat.addInteractiveMessage({
      text: `**Escolha o ato processual** que deseja minutar:`,
      choices: [
        ...availableActions.map((a) => ({ id: a.id, label: a.label })),
        { id: '__cancel__', label: 'Cancelar', cancel: true }
      ],
      onChoose: (choiceId) => {
        if (choiceId === '__cancel__') return;
        void handleTemplateAction(choiceId);
      }
    });
  };

  if (!triagemResult) {
    // Triagem falhou → abre direto a escolha manual, informando o motivo.
    chat.addSystemText(
      `**Minutar** — não foi possível obter a recomendação automática` +
        (triagemError ? ` (${triagemError})` : '') +
        `. Escolha manualmente o ato abaixo.`
    );
    showEscolherOutro();
    return;
  }

  const recomendada = availableActions.find((a) => a.id === triagemResult.actionId);
  if (!recomendada) {
    // Defensivo: id retornado não pertence ao conjunto — cai no manual.
    showEscolherOutro();
    return;
  }

  // Bolha principal: recomendação + justificativa + 2 botões.
  // Normaliza a justificativa para encaixar após "considerando que ":
  //  - remove pontuação final para não gerar "…autos..";
  //  - se o LLM já começou com "que ", tira para não duplicar;
  //  - torna a primeira letra minúscula (fica "considerando que o INSS…").
  const justRaw = (triagemResult.justificativa || 'a situação dos autos').trim();
  const justNorm = justRaw
    .replace(/[.!?]+\s*$/, '')
    .replace(/^que\s+/i, '')
    .replace(/^./, (c) => c.toLowerCase());

  chat.addInteractiveMessage({
    text:
      `**Análise do momento processual**\n\n` +
      `O melhor para o atual momento processual é **${recomendada.label}**, ` +
      `considerando que ${justNorm}.`,
    choices: [
      { id: '__gerar__', label: `Gerar minuta — ${recomendada.label}`, primary: true },
      { id: '__outro__', label: 'Escolher outro ato' }
    ],
    onChoose: (choiceId) => {
      if (choiceId === '__gerar__') {
        void handleTemplateAction(recomendada.id);
      } else if (choiceId === '__outro__') {
        showEscolherOutro();
      }
    }
  });
}

/**
 * Entry-point dos 5 botões. Fluxo:
 *  (a) Sem pasta configurada → gera do zero, silenciosamente.
 *  (b) Pasta configurada e nenhum match → oferece "Gerar do zero / Cancelar".
 *  (c) Pasta configurada com hits → ADOTA AUTOMATICAMENTE o mais similar,
 *      apresenta ao usuário o caminho do modelo e o percentual de
 *      similaridade calculado, e dispara a geração.
 */
async function handleTemplateAction(
  actionId: string,
  userRefinement?: string
): Promise<void> {
  // Procura nas duas listas para tolerar trocas de grau após o mount.
  const grau = memory.detection?.grau ?? 'unknown';
  const candidates: readonly TemplateAction[] = [
    ...getTemplateActionsForGrau(grau),
    ...TEMPLATE_ACTIONS_1G,
    ...TEMPLATE_ACTIONS_2G
  ];
  const action = candidates.find((a) => a.id === actionId);
  if (!action || !mounted) return;

  // Antes de qualquer busca ou geração, oferece ao usuário a chance de
  // informar orientações adicionais (teses, trechos a enfatizar, tom da
  // redação, súmulas a citar etc.). Se `userRefinement` já veio como
  // parâmetro (recursão após a bolha), segue direto para a geração.
  if (userRefinement === undefined) {
    const chat = ensureChatMounted();
    chat.addInputPrompt({
      text:
        `**${action.label}** — deseja fornecer orientações adicionais para a fundamentação?\n\n` +
        `Você pode indicar teses, trechos a enfatizar, tom da redação, súmulas/precedentes a citar, pedidos específicos a apreciar etc. Se não houver orientação, clique em "Gerar sem orientação".`,
      placeholder:
        'Ex.: reforçar o requisito da miserabilidade com base no laudo social; citar a Súmula 80 da TNU; adotar tom conciso.',
      confirmLabel: 'Gerar com orientação',
      skipLabel: 'Gerar sem orientação',
      onConfirm: (value) => {
        void handleTemplateAction(actionId, value);
      },
      onCancel: () => {
        mounted?.sidebar.setGlobalNotice('Geração de minuta cancelada.', 'info');
      }
    });
    return;
  }

  const hasConfig = await templatesHasConfig();
  if (!hasConfig) {
    executeMinutaGeneration(action, null, userRefinement || undefined);
    return;
  }

  const sidebar = mounted.sidebar;
  sidebar.setGlobalNotice(`Buscando modelo similar para "${action.label}"…`, 'info');

  // Monta a query BM25 em duas camadas:
  //  1. `queryHints` da ação → termos processuais (sentença, procedente…)
  //  2. termos de matéria extraídos do texto do processo → discriminam o
  //     assunto (BPC/LOAS, aposentadoria, auxílio-doença, etc.)
  //
  // Antes esta função jogava até 3000 chars de texto bruto do processo na
  // query, mas isso DILUÍA os termos discriminatórios em centenas de tokens
  // irrelevantes (nomes, CPFs, datas, endereços). O resultado era que o BM25
  // pontuava todos os templates quase igual (~0.5%) e escolhia o errado.
  //
  // Agora `extractSubjectTerms` varre o texto procurando expressões
  // indicativas de matéria jurídica e devolve apenas os termos focados.
  // Exemplo para um caso BPC/LOAS: "bpc loas beneficio prestacao continuada
  // assistencial miserabilidade hipossuficiencia vulnerabilidade deficiencia
  // idoso renda familiar" — poucos tokens, alto IDF, máxima discriminação.
  const caseContext = buildCaseContextText();
  const subjectTerms = extractSubjectTerms(caseContext);
  const enrichedQuery = subjectTerms
    ? `${action.queryHints} ${subjectTerms}`
    : action.queryHints;

  const bm25Hits = await templatesSearch(enrichedQuery, action.folderHints, action.excludeTerms);

  // Re-rank LLM (RAG híbrido): pede ao provedor ativo para reordenar os
  // top-K do BM25 considerando o contexto da causa. BM25 garante
  // recuperação por sobreposição lexical; o LLM aplica julgamento
  // jurídico sobre o pequeno conjunto já filtrado. Em caso de falha
  // (sem API key, parsing inválido, timeout), continuamos com a ordem
  // do BM25 — sem regredir UX.
  let hits = bm25Hits;
  let rerankJustificativa = '';
  let rerankAplicado = false;
  if (bm25Hits.length >= 2 && caseContext) {
    sidebar.setGlobalNotice(
      `Reordenando candidatos com IA para "${action.label}"…`,
      'info'
    );
    const rerank = await templatesRerank(action.label, caseContext, bm25Hits);
    if (rerank) {
      hits = rerank.ordered;
      rerankJustificativa = rerank.justificativa;
      rerankAplicado = true;
    }
  }
  sidebar.setGlobalNotice('', 'info');

  if (hits.length === 0) {
    // Pasta configurada mas nenhum match — pergunta se gera do zero
    // ou cancela (não força nada).
    const chat = ensureChatMounted();
    const aviso = caseContext
      ? ''
      : '\n\n_⚠ Nenhum documento do processo foi carregado, então a busca usou apenas os termos fixos da ação. Carregue os documentos antes para que o pAIdegua selecione um modelo do mesmo tipo de causa._';
    chat.addInteractiveMessage({
      text:
        `**${action.label}** — você tem pasta de modelos configurada, mas nenhum modelo bateu com a busca para esta ação. Quer gerar a peça do zero ou cancelar?` +
        aviso,
      choices: [
        { id: 'no-template', label: 'Gerar do zero', primary: true },
        { id: 'cancel', label: 'Cancelar', cancel: true }
      ],
      onChoose: (choiceId) => {
        if (choiceId === 'no-template') {
          executeMinutaGeneration(action, null, userRefinement || undefined);
        }
      }
    });
    return;
  }

  // Adota automaticamente o modelo mais adequado.
  //
  // Dois cenários distintos para a exibição do percentual:
  //
  //  - Sem rerank: o ordenamento é puramente BM25 (similaridade lexical).
  //    O percentual é informativo — o 1º colocado aparece com 100% e os
  //    demais proporcionalmente.
  //
  //  - Com rerank por IA: o LLM reordena os top-K por adequação jurídica,
  //    mas o campo `similarity` continua refletindo o score BM25 original.
  //    Exibir esse percentual após rerank confunde (o escolhido pode ter
  //    BM25 menor que os reprovados). Nesse caso, omitimos o percentual
  //    e identificamos os candidatos apenas pelo caminho, na ordem final.
  const top = hits[0];
  const fmtPct = (n: number): string => n.toFixed(1).replace('.', ',');
  const subpastaTag = top.matchedFolderHint ? ' _(subpasta sugerida)_' : '';
  const chat = ensureChatMounted();

  let msg: string;
  if (rerankAplicado) {
    msg =
      `**${action.label}** — modelo escolhido pela IA como o mais adequado ao caso:\n\n` +
      `\`${top.relativePath}\`${subpastaTag}\n`;
    if (rerankJustificativa) {
      msg += `\n_Justificativa da escolha:_ ${rerankJustificativa}\n`;
    }
    if (hits.length > 1) {
      msg += `\n**Outros candidatos avaliados** (na ordem de adequação ao caso):\n`;
      for (let i = 1; i < hits.length; i++) {
        const h = hits[i]!;
        msg += `- \`${h.relativePath}\`\n`;
      }
    }
  } else {
    msg =
      `**${action.label}** — modelo escolhido (maior similaridade lexical):\n\n` +
      `\`${top.relativePath}\`${subpastaTag} — **${fmtPct(top.similarity)}% de similaridade**\n`;
    if (hits.length > 1) {
      msg += `\n**Outros candidatos avaliados:**\n`;
      for (let i = 1; i < hits.length; i++) {
        const h = hits[i]!;
        msg += `- \`${h.relativePath}\` — ${fmtPct(h.similarity)}%\n`;
      }
    }
  }

  if (!caseContext) {
    msg +=
      `\n\n_⚠ Nenhum documento do processo foi carregado — a busca usou apenas os termos fixos da ação. ` +
      `Carregue os documentos antes de gerar a peça para que o pAIdegua selecione um modelo do mesmo tipo de causa._`;
  }

  chat.addSystemText(msg);
  executeMinutaGeneration(action, top, userRefinement || undefined);
}

// =====================================================================
// Anonimizador de autos (mesmo modelo do gerador-minutas)
// =====================================================================

/**
 * Roda o anonimizador em duas etapas sobre os documentos já extraídos:
 *
 *  1. Regex local para CPF, CNPJ, CEP, telefone, e-mail, RG e dados
 *     bancários — instantâneo, sem chamada de rede.
 *  2. LLM (via background) para extrair nomes de pessoas físicas a partir
 *     do trecho inicial concatenado, mapeando-os ao papel processual e
 *     aplicando a substituição em todos os documentos.
 *
 * O resultado SUBSTITUI o conteúdo dos documentos em `memory.extraidos`,
 * de modo que qualquer pergunta seguinte ao chat usa o texto já anônimo.
 * O usuário recebe uma bolha de sistema confirmando o que foi feito.
 */
async function handleAnonimizar(): Promise<void> {
  if (!mounted) return;
  const sidebar = mounted.sidebar;

  const docs = getExtraidosArray();
  if (docs.length === 0) {
    sidebar.setGlobalNotice(
      'Carregue e extraia documentos antes de anonimizar.',
      'error'
    );
    return;
  }

  sidebar.setGlobalNotice('Anonimizando autos (etapa 1/2 — regex local)…', 'info');

  // Etapa 1 — regex local em todos os documentos. Síncrono e barato.
  const docsRegex = docs.map((d) => ({
    ...d,
    textoExtraido: aplicarRegexAnonimizacao(d.textoExtraido ?? '')
  }));

  // Seleção inteligente de documentos para o LLM identificar os atores.
  // A estratégia antiga (pegar só os mais antigos em ordem) limitava a
  // detecção ao início da petição inicial — onde quase sempre só aparece
  // o autor qualificado. Advogados, procuradores, curadores, peritos e
  // membros do MP normalmente aparecem em outros docs (contestação,
  // procurações, laudos, substabelecimentos).
  //
  // Agora priorizamos documentos por tipo/descrição, pegando trechos
  // iniciais de cada um. Isso cobre com mais fidelidade os atores.
  const docsCronologicos = [...docsRegex].sort((a, b) => {
    const da = parseDataMovimentacaoToMs(a.dataMovimentacao);
    const db = parseDataMovimentacaoToMs(b.dataMovimentacao);
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });

  /** Palavras-chave que identificam docs onde costumam aparecer atores. */
  const TIPOS_PRIORITARIOS = [
    'inicial', 'peticao inicial', 'petição inicial',
    'contestacao', 'contestação', 'defesa',
    'procuracao', 'procuração', 'substabelecimento',
    'laudo', 'pericia', 'perícia',
    'estudo social', 'assistente social',
    'curatela', 'tutela', 'nomeacao', 'nomeação',
    'manifestacao ministerial', 'manifestação ministerial', 'parecer do mp',
    'qualificacao', 'qualificação'
  ];

  const normalizar = (s: string): string =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const isPrioritario = (d: ProcessoDocumento): boolean => {
    const alvo = normalizar(`${d.tipo ?? ''} ${d.descricao ?? ''}`);
    return TIPOS_PRIORITARIOS.some((kw) => alvo.includes(normalizar(kw)));
  };

  // Dois baldes: prioritários (entram primeiro) e demais (fallback).
  const docsPrioritarios = docsCronologicos.filter(isPrioritario);
  const docsDemais = docsCronologicos.filter((d) => !isPrioritario(d));

  // Por-documento, pegamos até 3000 chars iniciais — suficiente para a
  // qualificação, assinaturas e nomeações, sem estourar o total global.
  const CHARS_POR_DOC = 3000;
  const docsOrdenados = [...docsPrioritarios, ...docsDemais];

  let trechoCombinado = '';
  for (const d of docsOrdenados) {
    const texto = d.textoExtraido ?? '';
    if (!texto) continue;
    const head = texto.slice(0, CHARS_POR_DOC);
    const tag = d.tipo || d.descricao || `doc ${d.id}`;
    const bloco = `=== ${tag} ===\n${head}`;
    if (trechoCombinado.length + bloco.length > TRECHO_INICIAL_TAMANHO) {
      // Ainda tenta encaixar um trecho parcial se sobrar espaço útil.
      const restante = TRECHO_INICIAL_TAMANHO - trechoCombinado.length;
      if (restante > 500) {
        trechoCombinado += (trechoCombinado ? '\n\n' : '') + bloco.slice(0, restante);
      }
      break;
    }
    if (trechoCombinado) trechoCombinado += '\n\n';
    trechoCombinado += bloco;
  }
  trechoCombinado = trechoCombinado.slice(0, TRECHO_INICIAL_TAMANHO);

  sidebar.setGlobalNotice(
    'Anonimizando autos (etapa 2/2 — identificando partes via IA)…',
    'info'
  );

  let nomes: NomeAnonimizar[] = [];
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.ANONYMIZE_NAMES,
      payload: { texto: trechoCombinado }
    })) as { ok: boolean; nomes?: NomeAnonimizar[]; error?: string };

    if (!response?.ok) {
      sidebar.setGlobalNotice(
        `Falha ao identificar nomes: ${response?.error ?? 'erro desconhecido'}`,
        'error'
      );
      // Mesmo sem LLM, mantém o resultado da etapa 1 — não regredimos.
    } else {
      nomes = response.nomes ?? [];
    }
  } catch (error: unknown) {
    sidebar.setGlobalNotice(
      `Falha de comunicação com o background: ${errorMessage(error)}`,
      'error'
    );
  }

  // Etapa 3 — aplica substituições de nomes em todos os documentos.
  const docsFinal = docsRegex.map((d) => ({
    ...d,
    textoExtraido: aplicarSubstituicoesNomes(d.textoExtraido ?? '', nomes)
  }));

  // Substitui o que está em memória — perguntas seguintes usam o anônimo.
  memory.extraidos.clear();
  for (const d of docsFinal) {
    memory.extraidos.set(d.id, d);
  }

  sidebar.setGlobalNotice('', 'info');

  const chat = ensureChatMounted();
  const nomesPreview = nomes.length > 0
    ? nomes
        .slice(0, 8)
        .map((n) => `- \`${n.original}\` → ${n.substituto}`)
        .join('\n') + (nomes.length > 8 ? `\n…e mais ${nomes.length - 8}.` : '')
    : '_(nenhum nome de pessoa física foi identificado pela IA)_';

  const bubble = chat.addSystemText(
    `**Autos anonimizados.** O contexto enviado nas próximas perguntas já está sem dados pessoais.\n\n` +
      `**Etapa 1 — regex local:** CPF, CNPJ, CEP, telefone, e-mail, RG e dados bancários substituídos por marcadores ` +
      `\`[XXX OMITIDO]\`.\n\n` +
      `**Etapa 2 — IA (${nomes.length} nome(s) identificado(s)):**\n${nomesPreview}\n\n` +
      `---\n\n` +
      `⚠️ **Atenção:** a partir deste momento, qualquer pergunta ou comando enviado ao modelo de IA usará **apenas o texto anonimizado** acima — o conteúdo original dos autos não será mais transmitido ao provedor de IA.`
  );

  // Botão para baixar o .txt anonimizado — permite auditar o que foi enviado.
  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'paidegua-chat__download-btn';
  downloadBtn.textContent = '⬇ Baixar .txt anonimizado';
  downloadBtn.style.cssText =
    'margin-top: 10px; padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(19,81,180,0.35); background: rgba(19,81,180,0.08); color: var(--paidegua-primary-dark); font-size: 12px; cursor: pointer; font-weight: 600;';
  downloadBtn.addEventListener('click', () => {
    const numero = memory.detection?.numeroProcesso ?? 'processo';
    const partes: string[] = [
      `PROCESSO ${numero} — TEXTO ANONIMIZADO`,
      `Gerado em ${new Date().toLocaleString('pt-BR')}`,
      `Total de documentos: ${docsFinal.length}`,
      `Nomes identificados pela IA: ${nomes.length}`,
      ''
    ];
    for (const d of docsFinal) {
      const tag = d.tipo || d.descricao || `doc ${d.id}`;
      partes.push('='.repeat(72));
      partes.push(`=== ${tag} (id ${d.id})`);
      if (d.dataMovimentacao) partes.push(`=== ${d.dataMovimentacao}`);
      partes.push('='.repeat(72));
      partes.push('');
      partes.push(d.textoExtraido ?? '');
      partes.push('');
    }
    const blob = new Blob([partes.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeNum = numero.replace(/[^0-9A-Za-z._-]/g, '_');
    a.download = `paidegua-anonimizado-${safeNum}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  bubble.append(downloadBtn);
}

// =====================================================================
// Audio input (microfone)
// =====================================================================

async function handleMicClick(): Promise<void> {
  if (!mounted || !memory.settings) {
    return;
  }
  const sidebar = mounted.sidebar;
  const micButton = sidebar.elements.micButton;

  // Já gravando → parar
  if (memory.recorder) {
    try {
      const result = await memory.recorder.stop();
      memory.recorder = null;
      micButton.classList.remove('is-recording');
      sidebar.setGlobalNotice('Transcrevendo áudio…', 'info');
      const text = await transcribeAudio(result.blob, result.mimeType);
      sidebar.setGlobalNotice('', 'info');
      if (text) {
        sidebar.elements.textarea.value = text;
        sidebar.elements.textarea.focus();
      }
    } catch (error: unknown) {
      console.error(`${LOG_PREFIX} erro ao transcrever:`, error);
      sidebar.setGlobalNotice(`Falha na transcrição: ${errorMessage(error)}`, 'error');
      memory.recorder = null;
      micButton.classList.remove('is-recording');
    }
    return;
  }

  // Provedor sem suporte de STT da API → tenta Web Speech direto do microfone
  if (memory.settings.activeProvider === 'anthropic') {
    try {
      sidebar.setGlobalNotice('Gravando via reconhecimento local… fale agora.', 'info');
      const text = await recognizeLive();
      sidebar.setGlobalNotice('', 'info');
      if (text) {
        sidebar.elements.textarea.value = text;
        sidebar.elements.textarea.focus();
      }
    } catch (error: unknown) {
      sidebar.setGlobalNotice(`Reconhecimento falhou: ${errorMessage(error)}`, 'error');
    }
    return;
  }

  // Inicia gravação via MediaRecorder
  try {
    memory.recorder = await startRecording();
    micButton.classList.add('is-recording');
    sidebar.setGlobalNotice('Gravando… clique no microfone novamente para parar.', 'info');
  } catch (error: unknown) {
    sidebar.setGlobalNotice(`Microfone indisponível: ${errorMessage(error)}`, 'error');
  }
}

async function transcribeAudio(blob: Blob, mimeType: string): Promise<string | null> {
  if (!memory.settings) {
    return null;
  }
  const audioBase64 = await blobToBase64(blob);
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.TRANSCRIBE_AUDIO,
    payload: {
      provider: memory.settings.activeProvider,
      audioBase64,
      mimeType
    }
  })) as { ok: boolean; text?: string; error?: string; useBrowserFallback?: boolean };

  if (response?.ok && response.text) {
    return response.text;
  }
  if (response?.useBrowserFallback) {
    // Provedor não suporta STT — fallback Web Speech só funciona ao vivo,
    // não em blob. Avisamos o usuário.
    throw new Error(
      'Este provedor não transcreve áudio gravado. Use o microfone com Anthropic ou cadastre OpenAI/Gemini.'
    );
  }
  throw new Error(response?.error ?? 'Falha desconhecida');
}

// =====================================================================
// Audio summary (TTS)
// =====================================================================

async function handleAudioSummary(): Promise<void> {
  if (!mounted || !memory.settings || memory.extraidos.size === 0) {
    return;
  }
  const sidebar = mounted.sidebar;
  sidebar.setGlobalNotice('Gerando resumo textual para narração…', 'info');

  try {
    const text = await collectFullResponse(AUDIO_SUMMARY_PROMPT);
    if (!text) {
      sidebar.setGlobalNotice('Resumo vazio.', 'error');
      return;
    }
    sidebar.setGlobalNotice('Sintetizando voz…', 'info');
    await playSynthesizedSpeech(text);
    sidebar.setGlobalNotice('', 'info');
  } catch (error: unknown) {
    sidebar.setGlobalNotice(`Falha no resumo em áudio: ${errorMessage(error)}`, 'error');
  }
}

async function playSynthesizedSpeech(text: string): Promise<void> {
  if (!memory.settings || !mounted) {
    return;
  }
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.SYNTHESIZE_SPEECH,
    payload: {
      provider: memory.settings.activeProvider,
      text,
      voice: memory.settings.ttsVoice || undefined
    }
  })) as SynthesizeSpeechResult;

  if (response?.ok && response.audioBase64 && response.mimeType) {
    const audio = base64ToBlob(response.audioBase64, response.mimeType);
    const url = URL.createObjectURL(audio);
    appendAudioPlayer(url, response.mimeType);
    return;
  }

  if (response?.ok && response.useBrowserFallback) {
    if (memory.currentSpeak) {
      memory.currentSpeak.stop();
    }
    memory.currentSpeak = await speakLocal(text);
    appendSpeakControls(text);
    return;
  }

  throw new Error(response?.error ?? 'TTS indisponível.');
}

function appendAudioPlayer(url: string, mimeType: string): void {
  if (!mounted) {
    return;
  }
  const chat = ensureChatMounted();
  chat.addUserMessage('Gerando resumo em áudio…');
  // Insere "bolha" custom do assistant com o player
  const bubble = document.createElement('div');
  bubble.className = 'paidegua-chat__bubble is-assistant';
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = url;
  audio.style.width = '100%';
  audio.style.marginBottom = '8px';
  const dl = document.createElement('a');
  dl.href = url;
  dl.download = `resumo-paidegua.${mimeType.includes('mpeg') ? 'mp3' : 'audio'}`;
  dl.textContent = '⤓ Baixar áudio';
  dl.style.fontSize = '11px';
  dl.style.color = 'var(--paidegua-accent)';
  dl.style.textDecoration = 'underline';
  bubble.append(audio, dl);
  // injeta no container de mensagens
  const messagesEl = mounted.sidebar.elements.body.querySelector('.paidegua-chat__messages');
  messagesEl?.append(bubble);
  if (messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function appendSpeakControls(text: string): void {
  if (!mounted) {
    return;
  }
  const chat = ensureChatMounted();
  chat.addUserMessage('Gerando resumo em áudio (voz local)…');
  const bubble = document.createElement('div');
  bubble.className = 'paidegua-chat__bubble is-assistant';
  const info = document.createElement('div');
  info.style.fontSize = '11px';
  info.style.color = 'var(--paidegua-text-muted)';
  info.style.marginBottom = '8px';
  info.textContent = 'Reproduzindo via síntese de voz local (pt-BR).';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.textContent = '■ Parar';
  stopBtn.style.marginRight = '6px';
  stopBtn.addEventListener('click', () => memory.currentSpeak?.stop());
  const transcript = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Ver transcrição';
  summary.style.fontSize = '11px';
  summary.style.cursor = 'pointer';
  transcript.append(summary, document.createTextNode(text));
  bubble.append(info, stopBtn, transcript);
  const messagesEl = mounted.sidebar.elements.body.querySelector('.paidegua-chat__messages');
  messagesEl?.append(bubble);
  if (messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// =====================================================================
// Helper: chama o LLM e coleta a resposta completa (não-streaming UI)
// =====================================================================

async function collectFullResponse(prompt: string): Promise<string> {
  if (!memory.settings) {
    throw new Error('Configurações não carregadas.');
  }
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: PORT_NAMES.CHAT_STREAM });
    let buffer = '';
    port.onMessage.addListener((msg: { type: string; delta?: string; error?: string }) => {
      if (msg.type === CHAT_PORT_MSG.CHUNK && typeof msg.delta === 'string') {
        buffer += msg.delta;
      } else if (msg.type === CHAT_PORT_MSG.DONE) {
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        resolve(buffer);
      } else if (msg.type === CHAT_PORT_MSG.ERROR) {
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        reject(new Error(msg.error ?? 'Falha desconhecida'));
      }
    });
    const settings = memory.settings!;
    const payload: ChatStartPayload = {
      provider: settings.activeProvider,
      model: settings.models[settings.activeProvider],
      // Envia apenas o prompt — sem histórico do chat para evitar contaminação.
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      documents: getExtraidosArray(),
      numeroProcesso: memory.detection?.numeroProcesso ?? null,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens
    };
    port.postMessage({ type: CHAT_PORT_MSG.START, payload });
  });
}

// =====================================================================
// Setup
// =====================================================================

async function loadSettings(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.GET_SETTINGS,
      payload: null
    })) as {
      ok: boolean;
      settings: PAIdeguaSettings;
      apiKeyPresence: Record<ProviderId, boolean>;
    };
    memory.settings = response.settings;
    extensionEnabled = response.settings?.extensionEnabled !== false;
    if (mounted && memory.settings) {
      const provider = memory.settings.activeProvider;
      const present = response.apiKeyPresence[provider];
      mounted.sidebar.setProviderLabel(
        `${PROVIDER_LABELS[provider]} · ${memory.settings.models[provider]}`
      );
      // Aplica o perfil padrão persistido. Mudanças feitas na sessão via
      // seletor do sidebar são ephemeral — ao reabrir, volta ao default.
      mounted.sidebar.setProfile(memory.settings.defaultProfile);
      if (!present) {
        mounted.sidebar.setGlobalNotice(
          `Nenhuma chave cadastrada para ${PROVIDER_LABELS[provider]}. Abra o popup da extensão e configure.`,
          'warn'
        );
      } else if (!memory.settings.lgpdAccepted) {
        mounted.sidebar.setGlobalNotice(
          'Aviso LGPD pendente. Abra o popup da extensão para aceitar antes de enviar dados.',
          'warn'
        );
      }
    }
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} falha ao carregar settings:`, error);
  }
}

function wireSidebarEvents(sidebar: SidebarController): void {
  const els = sidebar.elements;

  els.sendButton.addEventListener('click', (event) => {
    event.preventDefault();
    const text = els.textarea.value;
    if (!text.trim()) {
      return;
    }
    els.textarea.value = '';
    sendChatMessage(text);
  });

  els.textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const text = els.textarea.value;
      if (!text.trim()) {
        return;
      }
      els.textarea.value = '';
      sendChatMessage(text);
    }
  });

  els.micButton.addEventListener('click', (event) => {
    event.preventDefault();
    void handleMicClick();
  });

  els.ocrButton.addEventListener('click', (event) => {
    event.preventDefault();
    void handleRunOcr();
  });

  els.resumirButton.addEventListener('click', (event) => {
    event.preventDefault();
    handleQuickAction('resumir');
  });

  els.minutarButton.addEventListener('click', (event) => {
    event.preventDefault();
    void handleMinutarTriagem();
  });

  els.audioButton.addEventListener('click', (event) => {
    event.preventDefault();
    void handleAudioSummary();
  });

  els.anonimizarButton.addEventListener('click', (event) => {
    event.preventDefault();
    void handleAnonimizar();
  });

  els.templateActionButtons.forEach((btn, actionId) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      void handleTemplateAction(actionId);
    });
  });

  els.triagemInteligenteButton.addEventListener('click', (event) => {
    event.preventDefault();
    handleTriagemInteligente();
  });

  els.painelGerencialButton.addEventListener('click', (event) => {
    event.preventDefault();
    void handlePainelGerencial();
  });

  els.prazosFitaButton.addEventListener('click', (event) => {
    event.preventDefault();
    void handlePrazosFita();
  });
}

/**
 * Insere o painel de Triagem Inteligente como uma entrada da linha do
 * tempo (chat). NÃO destrói o histórico anterior — resumos, minutas e
 * mensagens permanecem visíveis ao rolar a coluna. Cada novo clique no
 * botão acrescenta uma nova bolha-painel ao final do timeline.
 *
 * INJEÇÃO DOS CRITÉRIOS DE ANÁLISE: quando cada um dos handlers abaixo
 * (Analisar tarefas / Analisar processo / Inserir etiquetas mágicas) for
 * implementado e chamar o LLM, o prompt enviado DEVE incluir o retorno de
 * `buildTriagemCriteriosBlock(memory.settings)` de `shared/prompts.ts`.
 * Essa função consolida os 11 critérios da NT 1/2025 do CLI-JFCE (com a
 * redação padrão quando o magistrado adota, ou o entendimento próprio
 * quando substitui) mais os critérios livres adicionados na aba "Triagem
 * Inteligente" do popup. A configuração fica em
 * `memory.settings.triagemCriterios` e `memory.settings.triagemCriteriosCustom`.
 */
function handleTriagemInteligente(): void {
  if (!mounted) return;
  const chat = ensureChatMounted();
  const notice = (msg: string, kind: 'info' | 'error' = 'info'): void => {
    mounted?.sidebar.setGlobalNotice(msg, kind);
  };
  // O grupo "Painel" só aparece na tela do painel do usuário do PJe — em
  // outras telas a ação "Analisar tarefas" não tem dados para varrer.
  // No TRF5 o painel é renderizado dentro de um iframe Angular cross-origin;
  // detectamos isso pela URL do top OU pela presença de um iframe cuja src
  // referencia a rota.
  const isPainelUsuario =
    window.location.href.includes('painel-usuario-interno') ||
    Boolean(document.querySelector('iframe[src*="painel-usuario-interno"]'));
  const isProcessoAberto = Boolean(memory.detection?.isProcessoPage);
  const panel = createTriagemPanel(
    mountShell().shadow,
    {
      onAnalisarTarefas: () => {
        void handleAnalisarTarefas(notice);
      },
      onAnalisarProcesso: () => {
        void handleAnalisarProcesso(notice);
      },
      onInserirEtiquetas: () => {
        void handleInserirEtiquetas(notice);
      }
    },
    { isPainelUsuario, isProcessoAberto }
  );
  chat.addCustomBubble(panel);
}

/**
 * Fluxo do botão "Analisar o processo" (perfil Secretaria):
 *
 *   1. Verifica se os autos já foram extraídos (cache em
 *      `memory.extraidos`). Se não, dispara a extração automática com
 *      feedback de progresso — mesmo pipeline do botão "Extrair" da
 *      sidebar, mas sem pedir seleção manual.
 *   2. Resolve a lista de critérios adotados pelo magistrado a partir das
 *      configurações da aba "Triagem Inteligente" do popup.
 *   3. Chama o orquestrador (que delega ao background) para consultar a
 *      LLM. O contexto é construído com `buildTriagemContextText`, mesma
 *      função usada por "Minutar" — linha do tempo + docs integrais
 *      recentes, já truncada em 18k chars.
 *   4. Renderiza a bolha de resultado na timeline do chat. Quando houver
 *      critérios não atendidos, a bolha mostra o botão "Gerar ato de
 *      emenda à inicial", que reutiliza todo o fluxo de minuta existente
 *      (busca de modelo, geração, inserção no editor do PJe).
 */
async function handleAnalisarProcesso(
  notice: (msg: string, kind?: 'info' | 'error') => void
): Promise<void> {
  if (!mounted || !memory.adapter || !memory.detection?.isProcessoPage) {
    notice(
      'Abra os autos digitais de um processo antes de usar "Analisar o processo".',
      'error'
    );
    return;
  }
  if (!memory.settings) {
    notice('Aguarde o carregamento das configurações e tente novamente.', 'error');
    return;
  }

  // Garante que o cache de extração reflita a árvore atual. Se faltar
  // algum documento (ou a lista estiver vazia), dispara extração
  // automática. O usuário vê progresso no globalNotice do sidebar.
  const ok = await ensureDocumentosExtraidosParaAnalise(notice);
  if (!ok) return;

  const criterios = resolveTriagemCriterios(memory.settings);
  if (criterios.length === 0) {
    notice(
      'Nenhum critério de análise configurado. Abra o popup da extensão, ' +
        'aba "Triagem Inteligente", e adote ou cadastre ao menos um critério.',
      'error'
    );
    return;
  }

  const caseContext = buildAnaliseProcessoContextText(
    memory.detection?.numeroProcesso ?? null
  );
  if (!caseContext) {
    notice(
      'Nenhum conteúdo textual disponível nos documentos extraídos.',
      'error'
    );
    return;
  }

  notice('Analisando o processo pelos critérios configurados…', 'info');
  const resp = await executarAnalisarProcesso({ caseContext, criterios });
  if (!resp.ok || !resp.result) {
    notice(resp.error ?? 'Falha ao analisar o processo.', 'error');
    return;
  }
  notice('', 'info');

  const chat = ensureChatMounted();
  const bubble = createAnaliseProcessoBubble(
    mountShell().shadow,
    resp.result,
    {
      onGerarEmenda: (providencias) => {
        void handleGerarEmendaInicial(providencias, notice);
      }
    }
  );
  chat.addCustomBubble(bubble);
}

/**
 * Fluxo do botão "Inserir etiquetas mágicas" (perfil Secretaria →
 * Triagem Inteligente):
 *
 *   1. Garante que os autos estejam extraídos (mesmo pipeline de
 *      `handleAnalisarProcesso`).
 *   2. Monta o contexto dos autos (linha do tempo + docs recentes).
 *   3. Delega ao orquestrador, que envia ao background. O background
 *      consulta a LLM para extrair marcadores semânticos e aplica BM25
 *      contra as etiquetas sugestionáveis que o usuário marcou na aba
 *      "Etiquetas Inteligentes" do popup.
 *   4. Renderiza a bolha de sugestões na timeline. O servidor revisa as
 *      sugestões, marca as que quer aplicar e copia os nomes — a
 *      aplicação via API REST entra numa iteração futura (ainda não há
 *      endpoint mapeado para anexar etiquetas a um processo específico).
 */
async function handleInserirEtiquetas(
  notice: (msg: string, kind?: 'info' | 'error') => void
): Promise<void> {
  if (!mounted || !memory.adapter || !memory.detection?.isProcessoPage) {
    notice(
      'Abra os autos digitais de um processo antes de usar "Inserir etiquetas mágicas".',
      'error'
    );
    return;
  }
  if (!memory.settings) {
    notice('Aguarde o carregamento das configurações e tente novamente.', 'error');
    return;
  }

  const ok = await ensureDocumentosExtraidosParaAnalise(notice);
  if (!ok) return;

  const caseContext = buildAnaliseProcessoContextText(
    memory.detection?.numeroProcesso ?? null
  );
  if (!caseContext) {
    notice(
      'Nenhum conteúdo textual disponível nos documentos extraídos.',
      'error'
    );
    return;
  }

  notice('Sugerindo etiquetas para este processo…', 'info');
  const resp = await executarSugerirEtiquetas({ caseContext });
  if (!resp.ok) {
    notice(resp.error ?? 'Falha ao sugerir etiquetas.', 'error');
    return;
  }
  notice('', 'info');

  const chat = ensureChatMounted();
  const bubble = createEtiquetasSugestoesBubble(
    mountShell().shadow,
    resp.markers ?? [],
    resp.matches ?? [],
    {
      onCopiarSelecionadas: (etiquetas) => {
        if (etiquetas.length === 0) {
          notice('Nenhuma etiqueta selecionada para copiar.', 'error');
          return;
        }
        const texto = etiquetas.map((e) => e.nomeTag).join('\n');
        void navigator.clipboard
          .writeText(texto)
          .then(() => {
            notice(
              `${etiquetas.length} etiqueta(s) copiada(s) para a área de transferência.`,
              'info'
            );
          })
          .catch((err) => {
            console.warn(`${LOG_PREFIX} Falha ao copiar etiquetas:`, err);
            notice('Falha ao copiar etiquetas para a área de transferência.', 'error');
          });
      }
    }
  );
  chat.addCustomBubble(bubble);
}

/**
 * Garante que os documentos estejam extraídos em `memory.extraidos`. Se
 * a lista de documentos ainda não foi carregada, chama o adapter; se há
 * documentos listados mas nem todos extraídos, dispara a extração em
 * lote com feedback de progresso.
 *
 * Retorna true quando há texto utilizável em memória ao final; false se
 * o usuário precisa corrigir algo (p.ex. árvore vazia).
 */
async function ensureDocumentosExtraidosParaAnalise(
  notice: (msg: string, kind?: 'info' | 'error') => void
): Promise<boolean> {
  if (!mounted || !memory.adapter) return false;

  if (memory.documentos.length === 0) {
    try {
      memory.documentos = memory.adapter.extractDocumentos();
    } catch (err) {
      notice(`Falha ao listar documentos: ${errorMessage(err)}`, 'error');
      return false;
    }
  }

  if (memory.documentos.length === 0) {
    notice(
      'Nenhum documento encontrado na árvore de autos. Role a árvore até o ' +
        'final e tente novamente.',
      'error'
    );
    return false;
  }

  const faltam = memory.documentos.filter((d) => !memory.extraidos.has(d.id));
  if (faltam.length === 0) return true;

  notice(
    `Extraindo ${faltam.length} documento(s) dos autos — pode levar alguns minutos…`,
    'info'
  );

  let concluidos = 0;
  try {
    await extractContents(faltam, (event) => {
      switch (event.type) {
        case 'document-start':
          notice(
            `Extraindo ${concluidos + 1}/${faltam.length}: ${
              event.documento.tipo || event.documento.descricao || `doc ${event.documento.id}`
            }…`,
            'info'
          );
          break;
        case 'document-done':
          concluidos += 1;
          memory.extraidos.set(event.documento.id, event.documento);
          notice(
            `Extraindo ${concluidos}/${faltam.length}…`,
            'info'
          );
          break;
        case 'document-error':
          concluidos += 1;
          console.warn(
            `${LOG_PREFIX} falha ao extrair doc ${event.documento.id}:`,
            event.error
          );
          break;
        default:
          break;
      }
    });
  } catch (err) {
    notice(`Falha na extração: ${errorMessage(err)}`, 'error');
    return false;
  }

  if (memory.extraidos.size === 0) {
    notice(
      'Nenhum documento pôde ser extraído — o modelo não terá conteúdo dos autos ' +
        'para analisar.',
      'error'
    );
    return false;
  }

  // Se houver documentos digitalizados pendentes e OCR automático estiver
  // ligado, roda em background sem bloquear o fluxo. Sem OCR auto-run, a
  // análise segue com o que já foi extraído (documentos digitais legíveis).
  const pendentes = getOcrPendingDocuments(getExtraidosArray());
  if (pendentes.length > 0 && memory.settings?.ocrAutoRun) {
    notice(
      `${pendentes.length} documento(s) digitalizado(s). Rodando OCR antes de analisar…`,
      'info'
    );
    try {
      await handleRunOcr();
    } catch (err) {
      console.warn(`${LOG_PREFIX} OCR antes da análise falhou:`, err);
      // Segue em frente com o que já há — análise parcial é melhor que falha.
    }
  }

  if (mounted) {
    mounted.sidebar.setExtractedFeaturesEnabled(true);
    mounted.sidebar.setChatEnabled(true);
  }
  return true;
}

/**
 * Dispara a geração do ato de emenda à inicial a partir das providências
 * sugeridas pelo LLM na análise. Reaproveita todo o pipeline de minuta
 * existente — busca de modelo (BM25 + rerank), inserção no editor do
 * PJe, botões de copiar/baixar/refinar — apenas trocando o prompt pelo
 * gabarito fixo com as providências injetadas.
 */
async function handleGerarEmendaInicial(
  providencias: string[],
  notice: (msg: string, kind?: 'info' | 'error') => void
): Promise<void> {
  if (!mounted) return;
  const action = TEMPLATE_ACTIONS_TRIAGEM.find((a) => a.id === 'emenda-inicial');
  if (!action) {
    notice('Ação "Emenda à inicial" não configurada.', 'error');
    return;
  }
  const prompt = buildEmendaInicialPrompt(providencias);
  lastMinuta.action = action;
  lastMinuta.template = null;
  sendChatMessage(prompt, true, `Gerando ${action.label.toLowerCase()}…`, 'emenda');
}

/**
 * Fluxo de "Encaminhar e inserir no PJe" do ato de emenda à inicial.
 *
 * 1. Pergunta ao usuário via bolha interativa do chat se pode prosseguir,
 *    lembrando que a **tarefa do processo precisa estar aberta em outra
 *    aba** — a transição só pode ser acionada lá.
 * 2. No "Prosseguir": dispara a automação no background, que procura a
 *    aba do PJe com o processo aberto, aciona a transição "Comunicação -
 *    Elaborar (emenda automática)" e injeta o HTML da emenda no editor
 *    Badon da nova tarefa.
 * 3. **Salvar** e **Assinar documento(s)** ficam com o usuário — esta
 *    sprint para na injeção.
 */
async function handleEncaminharEmenda(
  html: string,
  notice: (msg: string, kind?: 'info' | 'error') => void
): Promise<void> {
  if (!mounted) return;
  const chat = mounted.chat;
  if (!chat) return;

  const numeroProcesso = memory.detection?.numeroProcesso ?? null;
  if (!numeroProcesso) {
    notice('Número do processo não identificado nesta aba.', 'error');
    return;
  }

  chat.addInteractiveMessage({
    text:
      'Vou acionar a transição **Comunicação - Elaborar (emenda automática)** ' +
      'na aba do PJe onde este processo está aberto e inserir a minuta no ' +
      'editor da nova tarefa.\n\n' +
      '**Pré-requisito:** a tarefa do processo (`' +
      numeroProcesso +
      '`) precisa estar aberta em outra aba do navegador — a transição ' +
      'só existe na tela da tarefa, não no painel.\n\n' +
      'Depois que o texto for inserido no editor, **revise, clique em ' +
      'Salvar e em Assinar documento(s) manualmente** — esta etapa ainda ' +
      'não é automatizada.',
    choices: [
      { id: 'prosseguir', label: 'Prosseguir', primary: true },
      { id: 'cancelar', label: 'Cancelar', cancel: true }
    ],
    onChoose: (choiceId) => {
      if (choiceId !== 'prosseguir') return;
      void dispatchEncaminharEmenda(html, numeroProcesso, notice);
    }
  });
}

async function dispatchEncaminharEmenda(
  html: string,
  numeroProcesso: string,
  notice: (msg: string, kind?: 'info' | 'error') => void
): Promise<void> {
  notice('Encaminhando para emenda automática…');
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.ENCAMINHAR_EMENDA,
      payload: { html, numeroProcesso }
    })) as { ok: boolean; error?: string; stage?: string };

    if (!response?.ok) {
      const stage = response?.stage ? ` (${response.stage})` : '';
      notice(
        `Falha ao encaminhar${stage}: ${
          response?.error ?? 'erro desconhecido'
        }. Conclua manualmente na aba do PJe.`,
        'error'
      );
      return;
    }
    notice(
      'Minuta inserida no editor da nova tarefa. Revise, salve e assine ' +
        'manualmente no PJe.'
    );
    window.setTimeout(() => notice('', 'info'), 5000);
  } catch (err) {
    console.warn(`${LOG_PREFIX} dispatchEncaminharEmenda falhou:`, err);
    notice(`Falha ao encaminhar: ${errorMessage(err)}.`, 'error');
  }
}

/**
 * Dispara o coletor de tarefas e abre o dashboard. O coletor é totalmente
 * client-side; a chamada à LLM acontece dentro do dashboard, sob demanda.
 *
 * Nota de UX: a varredura navega entre tarefas usando `history.back()` —
 * o usuário verá o painel do PJe oscilando. Mantemos o sidebar com um
 * notice de progresso para deixar claro o que está acontecendo.
 */
async function handleAnalisarTarefas(
  notice: (msg: string, kind?: 'info' | 'error') => void
): Promise<void> {
  notice(
    'Analisando tarefas — pode levar alguns minutos. ' +
      'Aguarde sem fechar a aba. O painel ficará indisponível durante a varredura.'
  );
  try {
    const result = await executarAnalisarTarefasComBridge({
      onProgress: (msg) => notice(msg)
    });
    if (!result.ok) {
      notice(result.error ?? 'Falha ao analisar tarefas.', 'error');
      return;
    }
    notice(
      `Dashboard aberto: ${result.totalTarefas} tarefa(s), ` +
        `${result.totalProcessos} processo(s).`
    );
    window.setTimeout(() => notice('', 'info'), 3500);
  } catch (err) {
    console.warn(`${LOG_PREFIX} handleAnalisarTarefas falhou:`, err);
    notice(`Falha ao analisar tarefas: ${errorMessage(err)}`, 'error');
  }
}

/**
 * Fluxo do botão "Abrir Painel Gerencial" (perfil Gestão):
 *   1. Lista as tarefas disponíveis (via iframe ou localmente).
 *   2. Pede ao background para abrir a aba intermediária do painel.
 *
 * A seleção em si, a barra de progresso e a abertura do dashboard ao
 * final acontecem DENTRO daquela aba — o sidebar do PJe fica limpo. Esta
 * função termina assim que a aba é criada; a varredura posterior é
 * disparada pelo listener de `GESTAO_RUN_COLETA` no mesmo content script.
 */
async function handlePainelGerencial(): Promise<void> {
  if (!mounted) return;
  const notice = (msg: string, kind: 'info' | 'error' = 'info'): void => {
    mounted?.sidebar.setGlobalNotice(msg, kind);
  };

  notice('Abrindo Painel Gerencial em nova aba...');
  try {
    const result = await abrirPainelGerencial({
      onProgress: (msg) => notice(msg)
    });
    if (!result.ok) {
      notice(result.error ?? 'Falha ao abrir o Painel Gerencial.', 'error');
      return;
    }
    notice(
      `Painel Gerencial aberto em nova aba (${result.totalTarefas} tarefa(s) disponíveis).`
    );
    window.setTimeout(() => notice('', 'info'), 3500);
  } catch (err) {
    console.warn(`${LOG_PREFIX} handlePainelGerencial falhou:`, err);
    notice(`Falha no Painel Gerencial: ${errorMessage(err)}`, 'error');
  }
}

/**
 * Handler do `GESTAO_RUN_COLETA` — disparado pelo background quando a
 * aba-painel confirma a seleção. Executa a varredura no contexto desta
 * aba (PJe), reporta progresso e devolve o payload final ao background
 * para que ele grave em `storage.session` e mande a aba-painel navegar
 * para o dashboard.
 *
 * Respondemos de forma ASSÍNCRONA: o listener faz `sendResponse({ok:true})`
 * imediatamente para liberar o remetente e segue a varredura em outro
 * microtask — progresso e resultado finais vão por mensagens separadas
 * (`GESTAO_COLETA_PROG`, `GESTAO_COLETA_DONE`, `GESTAO_COLETA_FAIL`).
 */
/**
 * Espera o content script desta aba estar totalmente pronto para uma
 * coleta isolada da Fase A2: `memory.adapter` populado E detecção
 * indicando tela de processo. Polling curto porque o content pode ter
 * bootstrapado antes do handler ser chamado.
 */
async function waitAdapterPronto(
  timeoutMs: number
): Promise<BaseAdapter | null> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (
      memory.adapter &&
      memory.detection?.isProcessoPage === true
    ) {
      return memory.adapter;
    }
    await new Promise<void>((r) => setTimeout(r, 150));
  }
  return memory.adapter;
}

/**
 * Fluxo do botão "Prazos na Fita pAIdegua" (perfil Gestão):
 *   1. Lista as tarefas disponíveis (mesma rotina do Painel Gerencial).
 *   2. Pede ao background para abrir a aba intermediária em modo `prazos`,
 *      que aplica o filtro "Controle de prazo" antes de renderizar.
 *
 * A coleta posterior (via API REST) é disparada por
 * `PRAZOS_FITA_RUN_COLETA` — ver `handlePrazosFitaRunColeta`.
 */
async function handlePrazosFita(): Promise<void> {
  if (!mounted) return;
  const notice = (msg: string, kind: 'info' | 'error' = 'info'): void => {
    mounted?.sidebar.setGlobalNotice(msg, kind);
  };

  notice('Abrindo "Prazos na Fita pAIdegua" em nova aba...');
  try {
    const result = await abrirPrazosFitaPainel({
      onProgress: (msg) => notice(msg)
    });
    if (!result.ok) {
      notice(result.error ?? 'Falha ao abrir "Prazos na Fita pAIdegua".', 'error');
      return;
    }
    notice(
      `"Prazos na Fita pAIdegua" aberto em nova aba (${result.totalTarefas} tarefa(s) disponíveis).`
    );
    window.setTimeout(() => notice('', 'info'), 3500);
  } catch (err) {
    console.warn(`${LOG_PREFIX} handlePrazosFita falhou:`, err);
    notice(`Falha em "Prazos na Fita pAIdegua": ${errorMessage(err)}`, 'error');
  }
}

/**
 * Handler do `PRAZOS_FITA_RUN_COLETA` — gêmeo do `handleGestaoRunColeta`,
 * mas dispara `coletarPrazosPorTarefasViaAPI` (caminho via REST) e
 * empacota o resultado como `PrazosFitaDashboardPayload` para o
 * dashboard "Prazos na Fita pAIdegua".
 */
// Idempotencia: chrome.tabs.sendMessage pode, em cenarios pontuais,
// disparar o handler duas vezes (observado: "Coleta iniciada" e
// "[API] listando..." aparecendo duplicados no registro do painel).
// O trabalho pesado — listar 300+ processos e depois abrir um fetch por
// processo para extrair expedientes — e caro e nao-idempotente do lado
// do servidor (gerarChaveAcesso gasta recursos). Um Set de requestIds
// em curso descarta entradas repetidas com o mesmo identificador.
const prazosFitaEmCurso = new Set<string>();

async function handlePrazosFitaRunColeta(
  payload: {
    requestId: string;
    nomes: string[];
    diasMinNaTarefa?: number | null;
    maxProcessosTotal?: number | null;
    retomar?: boolean;
  }
): Promise<void> {
  const { requestId, nomes, diasMinNaTarefa, maxProcessosTotal, retomar } = payload;
  if (prazosFitaEmCurso.has(requestId)) {
    console.warn(
      `${LOG_PREFIX} handlePrazosFitaRunColeta: requestId ${requestId} ja em curso — ignorando disparo duplicado.`
    );
    return;
  }
  prazosFitaEmCurso.add(requestId);
  try {
    const postProg = (msg: string): void => {
      chrome.runtime
        .sendMessage({
          channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_PROG,
          payload: { requestId, msg }
        })
        .catch(() => { /* aba-painel pode ter fechado; ignoramos */ });
    };

    postProg(
      `Coleta iniciada em ${nomes.length} tarefa(s) "Controle de prazo". Pode levar alguns minutos.`
    );

    // Streaming: empacota meta + slots em eventos separados, permitindo
    // ao dashboard abrir em ~2s com cartoes 0/N e preencher
    // progressivamente. O caminho legado (DONE com payload completo) e
    // preservado como finalizador — serve como snapshot canonico caso o
    // dashboard perca um patch.
    const postSkeleton = async (meta: StreamingEnumeratedMeta): Promise<void> => {
      try {
        await chrome.runtime.sendMessage({
          channel: MESSAGE_CHANNELS.PRAZOS_FITA_SKELETON_READY,
          payload: { requestId, meta }
        });
      } catch {
        /* aba-painel pode ter sido fechada */
      }
    };
    const postSlot = async (idx: number, item: ConsolidadoViaAPI): Promise<void> => {
      try {
        await chrome.runtime.sendMessage({
          channel: MESSAGE_CHANNELS.PRAZOS_FITA_SLOT_PATCH,
          payload: {
            requestId,
            idx,
            item: {
              ...item,
              processoApi: enxugarProcessoApiParaDashboard(item.processoApi)
            }
          }
        });
      } catch {
        /* dashboard pode ter sido fechado */
      }
    };
    const postHydrateSlot = async (idx: number, item: ConsolidadoViaAPI): Promise<void> => {
      try {
        await chrome.runtime.sendMessage({
          channel: MESSAGE_CHANNELS.PRAZOS_FITA_HYDRATE_SLOT,
          payload: {
            requestId,
            idx,
            item: {
              ...item,
              processoApi: enxugarProcessoApiParaDashboard(item.processoApi)
            }
          }
        });
      } catch {
        /* dashboard pode ter sido fechado */
      }
    };
    const postFinalizado = async (args: StreamingFinalizedArgs): Promise<void> => {
      try {
        await chrome.runtime.sendMessage({
          channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_FINALIZED,
          payload: { requestId, ...args }
        });
      } catch {
        /* dashboard pode ter sido fechado */
      }
    };

    const resultado = await coletarPrazosPorTarefasViaAPI({
      nomesTarefas: nomes,
      diasMinNaTarefa,
      maxProcessosTotal,
      retomar: retomar === true,
      onProgress: postProg,
      onEnumerated: postSkeleton,
      onSlot: postSlot,
      onHydrateSlot: postHydrateSlot,
      onFinalized: postFinalizado
    });

    // Caminho de streaming: o dashboard ja foi aberto no SKELETON_READY,
    // preenchido pelos SLOT_PATCH e finalizado pelo FINALIZED (emitido
    // dentro do coordinator). A mensagem final aqui so serve para o
    // log textual do painel/dashboard.
    postProg(
      `Coleta concluída: ${resultado.consolidado.length} processo(s) únicos em ${(resultado.tempoTotalMs / 1000).toFixed(1)}s.`
    );
  } catch (err) {
    if (isContextInvalidatedError(err)) {
      // Extensao recarregada no meio da coleta: a aba-painel ja foi
      // reiniciada junto, nao ha para quem reportar. Silencio total.
      return;
    }
    console.warn(`${LOG_PREFIX} handlePrazosFitaRunColeta falhou:`, err);
    try {
      await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.PRAZOS_FITA_COLETA_FAIL,
        payload: { requestId, error: errorMessage(err) }
      });
    } catch {
      /* aba-painel pode ter sido fechada */
    }
  } finally {
    prazosFitaEmCurso.delete(requestId);
  }
}

/**
 * Trunca o texto da última movimentação em cada processo do anonPayload.
 * Em unidades com milhares de processos, esse campo é quem mais pesa no
 * `storage.session` (limite de 10 MB). ~240 chars preservam a informação
 * essencial para a LLM (verbo + complemento) sem estourar a quota.
 */
function truncarMovimentacaoDoAnon(
  anon: TriagemPayloadAnon,
  max: number
): TriagemPayloadAnon {
  return {
    ...anon,
    tarefas: anon.tarefas.map((t) => ({
      ...t,
      processos: t.processos.map((p) => {
        const txt = p.ultimaMovimentacaoTexto;
        if (txt && txt.length > max) {
          return { ...p, ultimaMovimentacaoTexto: txt.slice(0, max) + '…' };
        }
        return p;
      })
    }))
  };
}

/**
 * Zera os campos de PII pesada de um `TriagemProcesso` para a versão que
 * vai ao `chrome.storage.session` — o dashboard gerencial não renderiza
 * `poloAtivo`, `ultimaMovimentacaoTexto`, nem as datas brutas (usa apenas
 * os `diasNa*` derivados, e só `diasNaTarefa` é exibido). Mantemos os
 * demais campos para que o tipo continue válido e o dashboard funcione
 * sem `any`.
 */
function enxugarProcessoParaDashboard(p: TriagemProcesso): TriagemProcesso {
  return {
    ...p,
    poloAtivo: '',
    dataEntradaTarefa: null,
    dataUltimoMovimento: null,
    diasUltimoMovimento: null,
    dataConclusao: null,
    diasDesdeConclusao: null,
    ultimaMovimentacaoTexto: null
  };
}

/**
 * Analogo de `enxugarProcessoParaDashboard`, porem para `PJeApiProcesso`
 * (usado pelo Prazos na Fita). O dashboard so le 4 campos: `idProcesso`,
 * `idTaskInstance`, `numeroProcesso`, `orgaoJulgador`. Os demais sao
 * zerados para caber na quota de 10 MB do `storage.session` em unidades
 * com milhares de processos.
 */
function enxugarProcessoApiParaDashboard(p: PJeApiProcesso): PJeApiProcesso {
  return {
    ...p,
    classeJudicial: null,
    poloAtivo: null,
    poloPassivo: null,
    dataChegadaTarefa: null,
    prioridade: false,
    sigiloso: false,
    etiquetas: [],
    assuntoPrincipal: null,
    descricaoUltimoMovimento: null,
    ultimoMovimento: null,
    cargoJudicial: null
  };
}

async function handleGestaoRunColeta(
  payload: { requestId: string; nomes: string[] }
): Promise<void> {
  const { requestId, nomes } = payload;
  try {
    const postProg = (msg: string): void => {
      chrome.runtime
        .sendMessage({
          channel: MESSAGE_CHANNELS.GESTAO_COLETA_PROG,
          payload: { requestId, msg }
        })
        .catch(() => { /* aba-painel pode ter fechado; ignoramos */ });
    };

    postProg(
      `Varredura iniciada em ${nomes.length} tarefa(s). Pode levar alguns minutos.`
    );

    const { ok, snapshots, error, urlHydrationScanId, legacyOrigin } =
      await coletarTarefasSelecionadas({
        nomes,
        onProgress: postProg
      });
    if (!ok) {
      await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.GESTAO_COLETA_FAIL,
        payload: {
          requestId,
          error: error ?? 'Falha na varredura das tarefas selecionadas.'
        }
      });
      return;
    }

    const totalProcessos = snapshots.reduce((s, t) => s + t.totalLido, 0);
    const indicadores = computarIndicadoresGestao(snapshots);
    const geradoEm = new Date().toISOString();
    const hostnamePJe = new URL(window.location.origin).hostname;

    // Payload anonimizado para a LLM — calculado AQUI, com acesso aos
    // snapshots completos. Depois desta linha podemos descartar os campos
    // pesados (última movimentação etc.) do payload que vai ao storage.
    const anonPayloadFull = sanitizePayloadForLLM({
      geradoEm,
      hostnamePJe,
      tarefas: snapshots,
      totalProcessos,
      insightsLLM: null
    });

    // Em unidades com milhares de processos, o texto da última
    // movimentação é o maior contribuinte de tamanho do anonPayload.
    // Truncamos em ~240 chars: dá pra LLM pegar o verbo/complemento
    // principal ("Juntada de Petição por ...") e mantém o payload dentro
    // da quota de 10 MB do `storage.session` mesmo em 8k+ processos.
    const anonPayload = truncarMovimentacaoDoAnon(anonPayloadFull, 240);

    // Em unidades com muitos processos, guardar os snapshots completos no
    // `chrome.storage.session` (quota 10 MB) estoura o limite e trava a
    // abertura do dashboard. O dashboard só renderiza um subset dos campos
    // do processo, então zeramos aqui os campos pesados que só servem à
    // LLM — esses já viajam no `anonPayload` ao lado.
    const snapshotsLeve: TriagemTarefaSnapshot[] = snapshots.map((t) => ({
      ...t,
      processos: t.processos.map(enxugarProcessoParaDashboard)
    }));

    const dashboardPayload = {
      geradoEm,
      hostnamePJe,
      ...(legacyOrigin ? { legacyOrigin } : {}),
      ...(urlHydrationScanId ? { urlHydrationScanId } : {}),
      tarefasSelecionadas: nomes,
      tarefas: snapshotsLeve,
      totalProcessos,
      indicadores,
      insightsLLM: null
    };

    postProg(`Varredura concluída: ${totalProcessos} processo(s) em ${snapshots.length} tarefa(s).`);

    // Se o background recusar a gravação (ex.: quota do storage.session
    // estourada em unidades muito grandes), `resp.ok` volta false. Sem
    // esse tratamento a aba-painel ficava esperando indefinidamente pelo
    // READY que nunca chega. Convertendo em COLETA_FAIL, o painel mostra
    // a mensagem de erro em vez de travar.
    const resp = await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.GESTAO_COLETA_DONE,
      payload: { requestId, dashboardPayload, anonPayload }
    });
    if (!resp?.ok) {
      const msg = resp?.error ?? 'Falha desconhecida ao gravar o dashboard.';
      await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.GESTAO_COLETA_FAIL,
        payload: { requestId, error: msg }
      }).catch(() => { /* aba-painel pode ter sido fechada */ });
    }
  } catch (err) {
    if (isContextInvalidatedError(err)) {
      return;
    }
    console.warn(`${LOG_PREFIX} handleGestaoRunColeta falhou:`, err);
    try {
      await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.GESTAO_COLETA_FAIL,
        payload: { requestId, error: errorMessage(err) }
      });
    } catch {
      /* aba-painel pode ter sido fechada */
    }
  }
}

function mountUI(detection: PJeDetection, adapter: BaseAdapter): void {
  memory.adapter = adapter;
  memory.detection = detection;
  const shell = mountShell();

  const sidebar = mountSidebar(shell.shadow, detection, {
    onLoadDocuments: () => {
      void handleLoadDocuments();
    },
    onClose: () => {
      /* nada a fazer — sem FAB, o botão do header continua sempre visível */
    }
  });
  mounted = { sidebar, docList: null, chat: null };
  wireSidebarEvents(sidebar);
  void loadSettings();
  console.log(
    `${LOG_PREFIX} UI montada para processo`,
    detection.numeroProcesso
  );
}

function unmountUI(): void {
  if (!mounted) {
    return;
  }
  if (memory.activePort) {
    try {
      memory.activePort.disconnect();
    } catch {
      /* ignore */
    }
    memory.activePort = null;
  }
  if (memory.recorder) {
    memory.recorder.cancel();
    memory.recorder = null;
  }
  if (memory.currentSpeak) {
    memory.currentSpeak.stop();
    memory.currentSpeak = null;
  }
  mounted.docList?.destroy();
  mounted.chat?.destroy();
  mounted.sidebar.destroy();
  mounted = null;
  memory.adapter = null;
  memory.detection = null;
  memory.documentos = [];
  memory.extraidos.clear();
  memory.chatMessages = [];
  console.log(`${LOG_PREFIX} UI desmontada`);
}

function runDetection(): void {
  // Kill-switch: com a extensão desativada, nada é detectado/montado.
  // Se houver UI pendurada de uma sessão ativa anterior, aplyExtensionState
  // já tratou o desmonte; aqui só prevenimos remontagem.
  if (!extensionEnabled) {
    return;
  }
  const { detection, adapter } = detect();
  const key = detectionKey(detection);
  if (key === lastDetectionKey) {
    return;
  }
  lastDetectionKey = key;

  console.log(`${LOG_PREFIX} detection:`, detection);

  // Monta a UI (FAB + sidebar) em QUALQUER tela do PJe onde um adapter
  // reconhece o ambiente — inclui painel do usuário, lista de tarefas,
  // tarefa aberta, etc. O botão do header agora precisa conseguir abrir
  // o sidebar mesmo quando não há processo carregado; botões que exigem
  // documentos (carregar, resumir, minutar) permanecem desabilitados até
  // `setExtractedFeaturesEnabled(true)` ser chamado.
  const shouldMount = detection.isPJe && adapter !== null;

  if (shouldMount && !mounted && adapter) {
    mountUI(detection, adapter);
    return;
  }

  if (shouldMount && mounted && adapter) {
    mounted.sidebar.updateDetection(detection);
    memory.adapter = adapter;
    memory.detection = detection;
    return;
  }

  if (!shouldMount && mounted) {
    unmountUI();
  }
}

function debounce(fn: () => void, delayMs: number): () => void {
  let timer: number | null = null;
  return () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = null;
      fn();
    }, delayMs);
  };
}

function observeDom(): void {
  const scheduled = debounce(runDetection, 400);
  const observer = new MutationObserver(() => scheduled());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  const onUrlChange = (): void => {
    lastDetectionKey = '';
    scheduled();
  };
  window.addEventListener('popstate', onUrlChange);

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args: Parameters<typeof history.pushState>): void {
    origPush(...args);
    onUrlChange();
  };
  history.replaceState = function (...args: Parameters<typeof history.replaceState>): void {
    origReplace(...args);
    onUrlChange();
  };
}

function pingBackground(): void {
  chrome.runtime
    .sendMessage({ channel: MESSAGE_CHANNELS.PING, payload: null })
    .then((response) => {
      console.log(`${LOG_PREFIX} ping -> background OK:`, response);
    })
    .catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} falha ao pingar background:`, error);
    });
}

// Listener de inserção no editor — registrado no topo de CADA content script,
// mesmo em páginas que não montam a UI (ex.: janela de "minutar peça" que o
// PJe abre em outra window). O background roteia o pedido do sidebar para
// todas as outras tabs jus.br; a que contém o editor responde com sucesso.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.channel !== 'string') {
    return false;
  }

  if (message.channel === MESSAGE_CHANNELS.INSERT_IN_PJE_EDITOR_PERFORM) {
    try {
      const payload = message.payload as { html: string; plain: string };
      const detection = detectPJeEditor();
      if (!detection.available) {
        sendResponse({ ok: false, error: 'sem editor nesta aba' });
        return false;
      }
      const ok = insertIntoPJeEditor(payload.html, payload.plain);
      sendResponse({ ok, kind: detection.kind });
    } catch (error: unknown) {
      sendResponse({ ok: false, error: errorMessage(error) });
    }
    return false;
  }

  // Disparo do painel gerencial: a aba-painel chama o background e o
  // background encaminha para ESTA aba (a que tem o PJe aberto). Só o top
  // frame da aba PJe roda a coleta — iframes e outras abas ignoram.
  if (message.channel === MESSAGE_CHANNELS.GESTAO_RUN_COLETA) {
    if (window !== window.top) return false;
    if (!isPJeHost(window.location.hostname)) return false;
    const payload = message.payload as { requestId: string; nomes: string[] };
    if (!payload || !payload.requestId || !Array.isArray(payload.nomes)) {
      sendResponse({ ok: false, error: 'Payload de coleta inválido.' });
      return false;
    }
    sendResponse({ ok: true });
    void handleGestaoRunColeta(payload);
    return false;
  }

  // Prazos na Fita pAIdegua: gêmeo de GESTAO_RUN_COLETA, dispara o
  // pipeline via API REST (`coletarPrazosPorTarefasViaAPI`).
  if (message.channel === MESSAGE_CHANNELS.PRAZOS_FITA_RUN_COLETA) {
    if (window !== window.top) return false;
    if (!isPJeHost(window.location.hostname)) return false;
    const payload = message.payload as {
      requestId: string;
      nomes: string[];
      diasMinNaTarefa?: number | null;
      maxProcessosTotal?: number | null;
      retomar?: boolean;
    };
    if (!payload || !payload.requestId || !Array.isArray(payload.nomes)) {
      sendResponse({ ok: false, error: 'Payload de coleta inválido.' });
      return false;
    }
    sendResponse({ ok: true });
    void handlePrazosFitaRunColeta(payload);
    return false;
  }

  // Painel -> content (aba PJe): consulta se existe checkpoint de
  // "Prazos na Fita" compativel com a assinatura da selecao atual.
  if (message.channel === MESSAGE_CHANNELS.PRAZOS_FITA_QUERY_SCAN_STATE) {
    if (window !== window.top) return false;
    if (!isPJeHost(window.location.hostname)) return false;
    const payload = message.payload as {
      nomes: string[];
      diasMinNaTarefa: number | null;
      maxProcessosTotal: number | null;
    } | null;
    if (!payload || !Array.isArray(payload.nomes)) {
      sendResponse({ hasState: false });
      return false;
    }
    void (async () => {
      try {
        const info = await consultarPorAssinaturaScanState({
          host: window.location.hostname,
          nomes: payload.nomes,
          filtros: {
            diasMinNaTarefa: payload.diasMinNaTarefa,
            maxProcessosTotal: payload.maxProcessosTotal
          }
        });
        sendResponse(info);
      } catch {
        sendResponse({ hasState: false });
      }
    })();
    return true;
  }

  // Prazos na fita (Fase A2): background abriu esta aba apenas para
  // extrair os expedientes; extraímos e respondemos para o background
  // fechar a aba. Apenas no top frame e em host PJe.
  // Etiquetas Inteligentes: background pede a listagem do catálogo do
  // PJe. Rodamos same-origin (aba do PJe) porque o servidor exige o
  // cookie JSESSIONID + headers X-pje-* que só são aceitos vindos do
  // próprio domínio. Apenas o top frame da aba PJe executa.
  if (message.channel === MESSAGE_CHANNELS.ETIQUETAS_RUN_FETCH) {
    if (window !== window.top) return false;
    if (!isPJeHost(window.location.hostname)) return false;
    void (async () => {
      try {
        const payload = message.payload as { pageSize?: number } | null;
        const resp = await listarEtiquetas({
          pageSize: payload?.pageSize,
          onProgress: () => { /* reportado depois via canal separado */ }
        });
        sendResponse(resp);
      } catch (err) {
        sendResponse({
          ok: false,
          total: 0,
          etiquetas: [],
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();
    return true;
  }

  if (message.channel === MESSAGE_CHANNELS.PRAZOS_FITA_EXTRAIR_NA_ABA) {
    if (window !== window.top) return false;
    if (!isPJeHost(window.location.hostname)) return false;
    void (async () => {
      try {
        const adapter = await waitAdapterPronto(8000);
        if (!adapter) {
          sendResponse({
            ok: false,
            error: 'Adapter não ficou pronto nesta aba dentro do timeout.'
          });
          return;
        }
        const numeroProcesso = adapter.extractNumeroProcesso();
        const okAba = await adapter.ensureAbaExpedientes();
        if (!okAba) {
          sendResponse({
            ok: false,
            numeroProcesso,
            error: 'Aba Expedientes não carregou.'
          });
          return;
        }
        const extracao = adapter.extractExpedientes();
        const anomaliasProcesso = derivarAnomaliasProcesso(extracao);
        sendResponse({
          ok: true,
          numeroProcesso,
          extracao,
          anomaliasProcesso
        });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();
    return true; // resposta assíncrona
  }

  return false;
});

// Reage a mudanças de settings vindas do popup (provedor/modelo).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return;
  }
  if (Object.keys(changes).some((k) => k.startsWith('paidegua.'))) {
    void loadSettings().then(() => {
      applyExtensionEnabledState();
    });
  }
});

/**
 * Aplica o estado atual de `extensionEnabled` ao DOM: se estiver desligada,
 * desmonta sidebar e remove o botão do header; se estiver ligada e a página
 * for PJe, garante a remontagem. Roda após cada `loadSettings`, que é
 * disparado pelo listener de `chrome.storage.onChanged`.
 */
function applyExtensionEnabledState(): void {
  if (window !== window.top) return;
  if (!isPJeHost(window.location.hostname)) return;
  if (extensionEnabled) {
    if (!navbarButton) mountGlobalNavbarButton();
    // Force redetection: runDetection short-circuita quando a chave não
    // muda, então limpamos para garantir que a UI reapareça.
    lastDetectionKey = '';
    runDetection();
  } else {
    if (mounted) unmountUI();
    if (navbarButton) {
      navbarButton.destroy();
      navbarButton = null;
    }
    lastDetectionKey = '';
  }
}

async function bootstrap(): Promise<void> {
  // Com `all_frames: true` no manifest, este script roda também dentro
  // dos iframes do PJe (ex.: o Angular do painel-usuario-interno servido
  // em frontend-prd.trf5.jus.br). Em iframes NÃO montamos UI; instalamos
  // apenas o listener da ponte para a ação "Analisar tarefas" quando o
  // iframe é o do painel.
  //
  // Importante: o iframe do painel NÃO casa com `isPJeHost` (o hostname
  // não começa com "pje"), então a checagem de host fica condicional ao
  // top frame.
  const ehTopFrame = window === window.top;
  if (!ehTopFrame) {
    if (window.location.href.includes('painel-usuario-interno')) {
      console.log(
        `${LOG_PREFIX} content script (iframe painel) em`,
        window.location.href
      );
      instalarListenerTriagemNoIframe();
      instalarListenerGestaoNoIframe();
      // Bridge isolated-world: relaya o snapshot de auth do PJe que o
      // interceptor page-world (pje-auth-page.js) dispara via CustomEvent.
      instalarBridgeInterceptorAuth();
    }
    return;
  }

  if (!isPJeHost(window.location.hostname)) {
    return;
  }

  console.log(`${LOG_PREFIX} content script carregado em`, window.location.href);
  // Bridge isolated-world (tambem instalada aqui no top frame) — relaya o
  // snapshot de auth despachado pelo interceptor page-world e persiste o
  // relatorio do probe Keycloak do `pje-auth-probe-page.ts`, que roda
  // apenas no top frame.
  instalarBridgeInterceptorAuth();
  pingBackground();
  // Lê o estado do kill-switch antes de montar qualquer UI para evitar
  // piscar o botão do header quando o usuário já deixou a extensão
  // desativada. Um timeout curto garante fallback caso o service worker
  // esteja em cold start.
  await loadSettingsGate();
  if (extensionEnabled) {
    mountGlobalNavbarButton();
    runDetection();
  }
  observeDom();
}

async function loadSettingsGate(): Promise<void> {
  try {
    await Promise.race([
      loadSettings(),
      new Promise<void>((resolve) => window.setTimeout(resolve, 500))
    ]);
  } catch {
    /* best-effort: em caso de falha, mantém default (ligada) */
  }
}

/**
 * Monta o botão do header uma única vez por content script. Vive fora do
 * ciclo mountUI/unmountUI, então segue visível mesmo em páginas sem
 * processo aberto (painel do usuário, lista de tarefas, etc.).
 *
 * O clique alterna o sidebar. Como `runDetection` agora monta a UI em
 * qualquer tela PJe, quando o usuário clica aqui o sidebar quase sempre
 * já está pronto — há um fallback para montagem tardia caso a detecção
 * ainda não tenha concluído (primeiros milissegundos da página).
 */
function mountGlobalNavbarButton(): void {
  if (navbarButton) return;
  if (!extensionEnabled) return;
  navbarButton = mountNavbarButton({
    onClick: () => {
      // Fallback: se o sidebar ainda não está montado (detecção tardia),
      // roda uma detecção síncrona antes de alternar.
      if (!mounted) {
        runDetection();
      }
      if (!mounted) {
        console.info(
          `${LOG_PREFIX} pAIdegua ainda inicializando — tente novamente em instantes.`
        );
        return;
      }
      const wasOpen = mounted.sidebar.isOpen();
      mounted.sidebar.toggle();
      // Auto-carregamento: ao abrir o pAIdegua dentro de um processo,
      // dispara a listagem de documentos sem exigir clique no botão. Se o
      // usuário perceber que a árvore do PJe estava com lazy loading (lista
      // incompleta), ele clica em "Recarregar Documentos" para refazer.
      const abriuAgora = !wasOpen && mounted.sidebar.isOpen();
      const emProcesso = memory.detection?.isProcessoPage === true;
      const semDocsCarregados = !mounted.docList;
      if (abriuAgora && emProcesso && semDocsCarregados && memory.adapter) {
        void handleLoadDocuments();
      }
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Detecta o erro "Extension context invalidated" que o Chrome emite quando
 * a extensao e recarregada/atualizada com um content script ainda rodando.
 * Nao e um bug do nosso codigo — apenas a aba antiga que perdeu o runtime.
 * Evita poluir o console com stacks vermelhos em um cenario esperado.
 */
function isContextInvalidatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /extension context invalidated/i.test(msg);
}

function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

void bootstrap();
