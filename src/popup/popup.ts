/**
 * Script do popup da extensão PAIdegua — Fase 4.
 *
 * Permite ao usuário:
 *   - Aceitar o aviso LGPD
 *   - Selecionar o provedor ativo (Anthropic / OpenAI / Gemini)
 *   - Selecionar o modelo do provedor selecionado
 *   - Cadastrar/testar/remover a API key (uma por provedor, persistente)
 */

import {
  LOG_PREFIX,
  MESSAGE_CHANNELS,
  PROFILE_IDS,
  PROFILE_LABELS,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  TRIAGEM_CRITERIOS,
  type ProfileId,
  type ProviderId,
  type TriagemCriterioId,
  type TriagemCriterioSetting
} from '../shared/constants';
import type {
  PAIdeguaSettings,
  PJeApiEtiqueta,
  PJeApiEtiquetasListResponse,
  TestConnectionResult,
  TriagemCriterioCustom
} from '../shared/types';
import {
  clearAllEtiquetas,
  clearCatalogMeta,
  countEtiquetas,
  listEtiquetas,
  listSugestionaveis,
  loadCatalogMeta,
  replaceSugestionaveis,
  saveCatalogMeta,
  saveEtiquetas,
  type EtiquetaRecord
} from '../shared/etiquetas-store';
import {
  detectGrauFromHostname,
  isGestaoProfileAvailable,
  isSecretariaProfileAvailable
} from '../shared/pje-host';

interface SettingsResponse {
  ok: boolean;
  settings: PAIdeguaSettings;
  apiKeyPresence: Record<ProviderId, boolean>;
  error?: string;
}

let currentSettings: PAIdeguaSettings | null = null;
let currentPresence: Record<ProviderId, boolean> = {
  anthropic: false,
  openai: false,
  gemini: false
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`PAIdegua popup: elemento #${id} ausente`);
  }
  return el as T;
};

function setStatus(text: string, kind: 'ok' | 'error' | 'info' | '' = ''): void {
  const el = $<HTMLParagraphElement>('popup-status');
  el.textContent = text;
  el.className = 'paidegua-popup__status' + (kind ? ` is-${kind}` : '');
}

function setKeyStatus(text: string, kind: 'ok' | 'error' | '' = ''): void {
  const el = $<HTMLParagraphElement>('key-status');
  el.textContent = text;
  el.className = 'paidegua-popup__hint' + (kind ? ` is-${kind}` : '');
}

function getActiveProvider(): ProviderId {
  const select = $<HTMLSelectElement>('provider-select');
  return select.value as ProviderId;
}

function populateProviders(): void {
  const select = $<HTMLSelectElement>('provider-select');
  select.innerHTML = '';
  for (const id of PROVIDER_IDS) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = PROVIDER_LABELS[id];
    select.append(option);
  }
}

function populateProfiles(allowed?: readonly ProfileId[]): void {
  const select = $<HTMLSelectElement>('default-profile-select');
  const ids = allowed ?? PROFILE_IDS;
  select.innerHTML = '';
  for (const id of ids) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = PROFILE_LABELS[id];
    select.append(option);
  }
}

function populateModels(provider: ProviderId, selected?: string): void {
  const select = $<HTMLSelectElement>('model-select');
  select.innerHTML = '';
  for (const m of PROVIDER_MODELS[provider]) {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.label + (m.recommended ? ' (recomendado)' : '');
    if (selected && selected === m.id) {
      option.selected = true;
    }
    select.append(option);
  }
}

function renderForProvider(provider: ProviderId): void {
  if (!currentSettings) {
    return;
  }
  populateModels(provider, currentSettings.models[provider]);
  const present = currentPresence[provider];
  if (present) {
    setKeyStatus(`Chave ${PROVIDER_LABELS[provider]} cadastrada.`, 'ok');
  } else {
    setKeyStatus(`Nenhuma chave cadastrada para ${PROVIDER_LABELS[provider]}.`, 'error');
  }
  $<HTMLInputElement>('api-key-input').value = '';
}

async function loadAll(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.GET_SETTINGS,
      payload: null
    })) as SettingsResponse;

    if (!response?.ok) {
      setStatus(response?.error ?? 'Falha ao carregar configurações.', 'error');
      return;
    }

    currentSettings = response.settings;
    currentPresence = response.apiKeyPresence;

    populateProviders();
    populateProfiles();
    $<HTMLSelectElement>('provider-select').value = currentSettings.activeProvider;
    $<HTMLSelectElement>('default-profile-select').value = currentSettings.defaultProfile;
    $<HTMLInputElement>('lgpd-accept').checked = currentSettings.lgpdAccepted;
    $<HTMLInputElement>('ocr-auto-run').checked = currentSettings.ocrAutoRun;
    $<HTMLInputElement>('ocr-max-pages').value = String(currentSettings.ocrMaxPages);

    renderForProvider(currentSettings.activeProvider);
    renderTriagemCriterios();
    await applyGrauRestrictions();
    setStatus('');
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} popup loadAll falhou:`, error);
    setStatus('Erro ao comunicar com o service worker.', 'error');
  }
}

/**
 * Consulta a aba ativa e restringe as opções do popup por grau do PJe.
 *
 * Regras (a seção "Perfil de trabalho" fica sempre visível — Gabinete e
 * Gestão são válidos em qualquer grau):
 *   - Secretaria: disponível apenas em 1º grau (pje1g). Em 2g/TR a
 *     opção é removida do seletor, a aba "Triagem Inteligente" do popup
 *     (que é específica da Secretaria) é ocultada e, se o perfil padrão
 *     persistido for "secretaria", forçamos volta para "gabinete".
 *   - Gestão: disponível em todos os graus (regra atual). Pode ser
 *     restringida no futuro em `isGestaoProfileAvailable`.
 *
 * Em abas que não são PJe, nada muda (o seletor mantém todos os perfis).
 */
async function applyGrauRestrictions(): Promise<void> {
  if (!currentSettings) return;
  let hostname = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      hostname = new URL(tab.url).hostname;
    }
  } catch {
    return;
  }
  if (!hostname) return;
  const grau = detectGrauFromHostname(hostname);
  const secretariaOk = isSecretariaProfileAvailable(grau);
  const gestaoOk = isGestaoProfileAvailable(grau);

  // Repopula o seletor só com os perfis permitidos para o grau atual.
  const allowed = PROFILE_IDS.filter((id) => {
    if (id === 'secretaria') return secretariaOk;
    if (id === 'gestao') return gestaoOk;
    return true;
  });
  populateProfiles(allowed);
  // Restaura o valor selecionado se continuar válido; senão, cai em Gabinete.
  const stored = currentSettings.defaultProfile;
  const valorInicial: ProfileId = (allowed as readonly string[]).includes(stored)
    ? stored
    : 'gabinete';
  $<HTMLSelectElement>('default-profile-select').value = valorInicial;

  if (!secretariaOk) {
    // Abas "Triagem Inteligente" e "Etiquetas Inteligentes" são específicas da Secretaria.
    const tabTriagem = document.getElementById('tab-triagem');
    if (tabTriagem) tabTriagem.setAttribute('hidden', '');
    const tabEtiquetas = document.getElementById('tab-etiquetas');
    if (tabEtiquetas) tabEtiquetas.setAttribute('hidden', '');
    const secretariaTabSelected =
      tabTriagem?.getAttribute('aria-selected') === 'true' ||
      tabEtiquetas?.getAttribute('aria-selected') === 'true';
    if (secretariaTabSelected) setActiveTab('tab-geral');
    // Persistir perfil padrão como Gabinete se estiver em Secretaria.
    if (stored === 'secretaria') {
      const response = (await chrome.runtime.sendMessage({
        channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
        payload: { defaultProfile: 'gabinete' as ProfileId }
      })) as { ok: boolean; settings?: PAIdeguaSettings };
      if (response?.ok && response.settings) {
        currentSettings = response.settings;
        $<HTMLSelectElement>('default-profile-select').value = 'gabinete';
      }
    }
  }
}

async function saveProviderSelection(): Promise<void> {
  if (!currentSettings) {
    return;
  }
  const provider = getActiveProvider();
  const model = $<HTMLSelectElement>('model-select').value;
  const next: Partial<PAIdeguaSettings> = {
    activeProvider: provider,
    models: { ...currentSettings.models, [provider]: model }
  };
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
    payload: next
  })) as { ok: boolean; settings?: PAIdeguaSettings; error?: string };
  if (response?.ok && response.settings) {
    currentSettings = response.settings;
    setStatus('Configurações salvas.', 'ok');
  } else {
    setStatus(response?.error ?? 'Falha ao salvar.', 'error');
  }
}

async function saveOcrSettings(): Promise<void> {
  if (!currentSettings) {
    return;
  }
  const autoRun = $<HTMLInputElement>('ocr-auto-run').checked;
  const rawPages = parseInt($<HTMLInputElement>('ocr-max-pages').value, 10);
  const maxPages = Number.isFinite(rawPages) && rawPages > 0 ? Math.min(rawPages, 200) : 30;
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
    payload: { ocrAutoRun: autoRun, ocrMaxPages: maxPages }
  })) as { ok: boolean; settings?: PAIdeguaSettings };
  if (response?.ok && response.settings) {
    currentSettings = response.settings;
    $<HTMLInputElement>('ocr-max-pages').value = String(currentSettings.ocrMaxPages);
  }
}

async function saveDefaultProfile(): Promise<void> {
  if (!currentSettings) {
    return;
  }
  const profile = $<HTMLSelectElement>('default-profile-select').value as ProfileId;
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
    payload: { defaultProfile: profile }
  })) as { ok: boolean; settings?: PAIdeguaSettings; error?: string };
  if (response?.ok && response.settings) {
    currentSettings = response.settings;
    setStatus(`Perfil padrão: ${PROFILE_LABELS[profile]}.`, 'ok');
  } else {
    setStatus(response?.error ?? 'Falha ao salvar perfil padrão.', 'error');
  }
}

async function saveLgpd(): Promise<void> {
  if (!currentSettings) {
    return;
  }
  const accepted = $<HTMLInputElement>('lgpd-accept').checked;
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
    payload: { lgpdAccepted: accepted }
  })) as { ok: boolean; settings?: PAIdeguaSettings };
  if (response?.ok && response.settings) {
    currentSettings = response.settings;
  }
}

async function saveApiKey(): Promise<void> {
  const provider = getActiveProvider();
  const apiKey = $<HTMLInputElement>('api-key-input').value.trim();
  if (!apiKey) {
    setStatus('Cole uma chave antes de salvar.', 'error');
    return;
  }
  setStatus('Salvando chave…', 'info');
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.SAVE_API_KEY,
    payload: { provider, apiKey }
  })) as { ok: boolean; error?: string };
  if (response?.ok) {
    currentPresence[provider] = true;
    renderForProvider(provider);
    setStatus(`Chave ${PROVIDER_LABELS[provider]} salva.`, 'ok');
  } else {
    setStatus(response?.error ?? 'Falha ao salvar chave.', 'error');
  }
}

async function testApiKey(): Promise<void> {
  const provider = getActiveProvider();
  const model = $<HTMLSelectElement>('model-select').value;
  setStatus(`Testando ${PROVIDER_LABELS[provider]}…`, 'info');
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.TEST_CONNECTION,
    payload: { provider, model }
  })) as TestConnectionResult;
  if (response?.ok) {
    setStatus(`${PROVIDER_LABELS[provider]} OK (${response.modelEcho ?? model}).`, 'ok');
  } else {
    setStatus(`Falha: ${response?.error ?? 'desconhecida'}`, 'error');
  }
}

async function removeApiKey(): Promise<void> {
  const provider = getActiveProvider();
  const confirmed = confirm(
    `Remover a chave ${PROVIDER_LABELS[provider]} do armazenamento local?`
  );
  if (!confirmed) {
    return;
  }
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.REMOVE_API_KEY,
    payload: { provider }
  })) as { ok: boolean; error?: string };
  if (response?.ok) {
    currentPresence[provider] = false;
    renderForProvider(provider);
    setStatus(`Chave ${PROVIDER_LABELS[provider]} removida.`, 'ok');
  } else {
    setStatus(response?.error ?? 'Falha ao remover chave.', 'error');
  }
}

// =====================================================================
// Abas (Geral / Triagem Inteligente)
// =====================================================================

type TabId = 'tab-geral' | 'tab-triagem' | 'tab-etiquetas';

function setActiveTab(tabId: TabId): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.paidegua-popup__tab');
  const panels = document.querySelectorAll<HTMLElement>('.paidegua-popup__tabpanel');
  tabs.forEach((t) => {
    const isActive = t.id === tabId;
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  panels.forEach((p) => {
    const isActive = p.getAttribute('aria-labelledby') === tabId;
    p.classList.toggle('is-active', isActive);
    if (isActive) {
      p.removeAttribute('hidden');
    } else {
      p.setAttribute('hidden', '');
    }
  });
  // Carregamento lazy: o catálogo de etiquetas só é lido do IndexedDB
  // quando o usuário abre a aba. Renderizar ~3k linhas toda vez que o
  // popup abre seria desperdício.
  if (tabId === 'tab-etiquetas') {
    void loadEtiquetasTab();
  }
}

function bindTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.paidegua-popup__tab').forEach((t) => {
    t.addEventListener('click', () => {
      setActiveTab(t.id as TabId);
    });
  });
}

// =====================================================================
// Triagem Inteligente — critérios (NT 1/2025 do CLI-JFCE)
// =====================================================================

const triagemDebounce = new Map<TriagemCriterioId, number>();

function setTriagemStatus(text: string, kind: 'ok' | 'error' | '' = ''): void {
  const el = document.getElementById('triagem-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'paidegua-triagem-status' + (kind ? ` is-${kind}` : '');
}

async function saveTriagemCriterio(
  id: TriagemCriterioId,
  partial: Partial<TriagemCriterioSetting>
): Promise<void> {
  if (!currentSettings) return;
  const current = currentSettings.triagemCriterios[id] ?? { adopted: true, customText: '' };
  const next: TriagemCriterioSetting = { ...current, ...partial };
  const nextMap = { ...currentSettings.triagemCriterios, [id]: next };
  setTriagemStatus('Salvando…');
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
    payload: { triagemCriterios: nextMap }
  })) as { ok: boolean; settings?: PAIdeguaSettings; error?: string };
  if (response?.ok && response.settings) {
    currentSettings = response.settings;
    setTriagemStatus('Critério salvo.', 'ok');
  } else {
    setTriagemStatus(response?.error ?? 'Falha ao salvar critério.', 'error');
  }
}

function buildTriagemCard(
  criterio: (typeof TRIAGEM_CRITERIOS)[number],
  setting: TriagemCriterioSetting
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'paidegua-triagem-card';
  if (!setting.adopted) card.classList.add('is-custom');

  const toggleId = `triagem-toggle-${criterio.id}`;
  const textareaId = `triagem-text-${criterio.id}`;

  card.innerHTML = `
    <header class="paidegua-triagem-card__header">
      <h3 class="paidegua-triagem-card__title">${criterio.label}</h3>
      <label class="paidegua-triagem-card__toggle" for="${toggleId}">
        <input type="checkbox" id="${toggleId}" ${setting.adopted ? 'checked' : ''} />
        <span>Adoto a NT</span>
      </label>
    </header>
    <p class="paidegua-triagem-card__default">
      <span class="paidegua-triagem-card__default-label">Reda&#231;&#227;o padr&#227;o (NT 1/2025)</span>
      ${escapeHtml(criterio.defaultText)}
    </p>
    <div class="paidegua-triagem-card__custom" ${setting.adopted ? 'hidden' : ''}>
      <label class="paidegua-triagem-card__custom-label" for="${textareaId}">
        Seu entendimento sobre este crit&#233;rio
      </label>
      <textarea id="${textareaId}" placeholder="Descreva como voc&#234; entende e aplica este crit&#233;rio."
        >${escapeHtml(setting.customText)}</textarea>
    </div>
  `;

  const toggle = card.querySelector<HTMLInputElement>(`#${CSS.escape(toggleId)}`);
  const customWrapper = card.querySelector<HTMLElement>('.paidegua-triagem-card__custom');
  const textarea = card.querySelector<HTMLTextAreaElement>(`#${CSS.escape(textareaId)}`);

  toggle?.addEventListener('change', () => {
    const adopted = toggle.checked;
    card.classList.toggle('is-custom', !adopted);
    if (customWrapper) {
      if (adopted) customWrapper.setAttribute('hidden', '');
      else customWrapper.removeAttribute('hidden');
    }
    void saveTriagemCriterio(criterio.id, { adopted });
  });

  textarea?.addEventListener('input', () => {
    const id = criterio.id;
    const existing = triagemDebounce.get(id);
    if (existing) window.clearTimeout(existing);
    const handle = window.setTimeout(() => {
      triagemDebounce.delete(id);
      void saveTriagemCriterio(id, { customText: textarea.value });
    }, 400);
    triagemDebounce.set(id, handle);
  });

  return card;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTriagemCriterios(): void {
  if (!currentSettings) return;
  const list = document.getElementById('triagem-criterios-list');
  if (!list) return;
  list.innerHTML = '';
  for (const criterio of TRIAGEM_CRITERIOS) {
    const setting =
      currentSettings.triagemCriterios[criterio.id] ?? { adopted: true, customText: '' };
    list.appendChild(buildTriagemCard(criterio, setting));
  }
  renderTriagemExtras();
  setTriagemStatus('');
}

// =====================================================================
// Critérios livres (criados pelo magistrado)
// =====================================================================

const customDebounce = new Map<string, number>();

function generateCustomId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function persistTriagemExtras(items: TriagemCriterioCustom[]): Promise<void> {
  if (!currentSettings) return;
  setTriagemStatus('Salvando…');
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
    payload: { triagemCriteriosCustom: items }
  })) as { ok: boolean; settings?: PAIdeguaSettings; error?: string };
  if (response?.ok && response.settings) {
    currentSettings = response.settings;
    setTriagemStatus('Critérios atualizados.', 'ok');
  } else {
    setTriagemStatus(response?.error ?? 'Falha ao salvar critérios livres.', 'error');
  }
}

function renderTriagemExtras(): void {
  if (!currentSettings) return;
  const enable = document.getElementById('triagem-extras-enable') as HTMLInputElement | null;
  const body = document.getElementById('triagem-extras-body') as HTMLElement | null;
  if (!enable || !body) return;

  const items = currentSettings.triagemCriteriosCustom ?? [];
  const enabled = items.length > 0;
  enable.checked = enabled;
  if (enabled) body.removeAttribute('hidden');
  else body.setAttribute('hidden', '');

  body.innerHTML = '';
  for (const item of items) body.appendChild(buildExtraItem(item));
  if (enabled) body.appendChild(buildAddButton());
}

function buildExtraItem(item: TriagemCriterioCustom): HTMLElement {
  const row = document.createElement('div');
  row.className = 'paidegua-triagem-extras__item';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Descreva o critério adicional que você adota.';
  textarea.value = item.text;
  textarea.addEventListener('input', () => {
    const existing = customDebounce.get(item.id);
    if (existing) window.clearTimeout(existing);
    const handle = window.setTimeout(() => {
      customDebounce.delete(item.id);
      const items = (currentSettings?.triagemCriteriosCustom ?? []).map((c) =>
        c.id === item.id ? { ...c, text: textarea.value } : c
      );
      void persistTriagemExtras(items);
    }, 400);
    customDebounce.set(item.id, handle);
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'paidegua-triagem-extras__remove';
  removeBtn.setAttribute('aria-label', 'Remover critério');
  removeBtn.title = 'Remover este critério';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    const items = (currentSettings?.triagemCriteriosCustom ?? []).filter(
      (c) => c.id !== item.id
    );
    void persistTriagemExtras(items).then(() => renderTriagemExtras());
  });

  row.appendChild(textarea);
  row.appendChild(removeBtn);
  return row;
}

function buildAddButton(): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'paidegua-triagem-extras__add';
  btn.innerHTML = `<span class="paidegua-triagem-extras__add-icon">+</span><span>Adicionar critério</span>`;
  btn.addEventListener('click', () => {
    const items = [...(currentSettings?.triagemCriteriosCustom ?? [])];
    items.push({ id: generateCustomId(), text: '' });
    void persistTriagemExtras(items).then(() => {
      renderTriagemExtras();
      const body = document.getElementById('triagem-extras-body');
      const last = body?.querySelector<HTMLTextAreaElement>(
        '.paidegua-triagem-extras__item:last-of-type textarea'
      );
      last?.focus();
    });
  });
  return btn;
}

function bindTriagemExtras(): void {
  const enable = document.getElementById('triagem-extras-enable') as HTMLInputElement | null;
  if (!enable) return;
  enable.addEventListener('change', () => {
    if (enable.checked) {
      // Abrir pela primeira vez já cria um item vazio para o usuário escrever.
      const items = currentSettings?.triagemCriteriosCustom ?? [];
      if (items.length === 0) {
        void persistTriagemExtras([{ id: generateCustomId(), text: '' }]).then(() =>
          renderTriagemExtras()
        );
      } else {
        renderTriagemExtras();
      }
    } else {
      // Desligar limpa todos os critérios livres (ação destrutiva — confirma).
      const items = currentSettings?.triagemCriteriosCustom ?? [];
      const hasContent = items.some((i) => i.text.trim().length > 0);
      if (hasContent && !confirm('Remover todos os critérios customizados?')) {
        enable.checked = true;
        return;
      }
      void persistTriagemExtras([]).then(() => renderTriagemExtras());
    }
  });
}

function bindEvents(): void {
  $<HTMLSelectElement>('provider-select').addEventListener('change', () => {
    const provider = getActiveProvider();
    renderForProvider(provider);
    void saveProviderSelection();
  });
  $<HTMLSelectElement>('model-select').addEventListener('change', () => {
    void saveProviderSelection();
  });
  $<HTMLSelectElement>('default-profile-select').addEventListener('change', () => {
    void saveDefaultProfile();
  });
  $<HTMLInputElement>('lgpd-accept').addEventListener('change', () => {
    void saveLgpd();
  });
  $<HTMLInputElement>('ocr-auto-run').addEventListener('change', () => {
    void saveOcrSettings();
  });
  $<HTMLInputElement>('ocr-max-pages').addEventListener('change', () => {
    void saveOcrSettings();
  });
  $<HTMLButtonElement>('save-key-btn').addEventListener('click', () => {
    void saveApiKey();
  });
  $<HTMLButtonElement>('test-key-btn').addEventListener('click', () => {
    void testApiKey();
  });
  $<HTMLButtonElement>('remove-key-btn').addEventListener('click', () => {
    void removeApiKey();
  });
  $<HTMLButtonElement>('open-options-btn').addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options/options.html'), '_blank');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindTabs();
  bindEvents();
  bindTriagemExtras();
  bindEtiquetasEvents();
  void loadAll();
});

// =====================================================================
// Etiquetas Inteligentes — catálogo + seleção de sugestionáveis
// =====================================================================

/**
 * Estado local da aba. Mantido em memória porque o popup é curto
 * (fecha ao perder foco); persistência real fica no IndexedDB
 * (`paidegua.etiquetas`).
 */
interface EtiquetasTabState {
  /** Já carregamos o catálogo do IndexedDB nesta abertura do popup? */
  loaded: boolean;
  /** Catálogo completo em memória, indexado por id. */
  catalogo: EtiquetaRecord[];
  /** Set com os ids marcados como sugestionáveis (coluna B). */
  selecionados: Set<number>;
  /** Estado inicial dos selecionados — usado para detectar dirty. */
  selecionadosOriginais: Set<number>;
}

const etiqState: EtiquetasTabState = {
  loaded: false,
  catalogo: [],
  selecionados: new Set(),
  selecionadosOriginais: new Set()
};

function setEtiqStatus(text: string, kind: 'ok' | 'error' | 'info' | '' = ''): void {
  const el = document.getElementById('etiq-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'paidegua-etiquetas-status' + (kind ? ` is-${kind}` : '');
}

function setEtiqProgress(visible: boolean, processed = 0, total = 0, hint = ''): void {
  const wrap = document.getElementById('etiq-progress-wrap');
  const fill = document.getElementById('etiq-progress-fill');
  const text = document.getElementById('etiq-progress-text');
  if (!wrap || !fill || !text) return;
  if (!visible) {
    wrap.setAttribute('hidden', '');
    return;
  }
  wrap.removeAttribute('hidden');
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  fill.style.width = `${pct}%`;
  text.textContent = hint || `Coletados ${processed}/${total} etiquetas.`;
}

function setEtiqButtonsForState(hasCatalogo: boolean, dirty: boolean): void {
  const btnReindex = document.getElementById('btn-etiq-reindex') as HTMLButtonElement | null;
  const btnClear = document.getElementById('btn-etiq-clear') as HTMLButtonElement | null;
  const btnSave = document.getElementById('btn-etiq-save') as HTMLButtonElement | null;
  if (btnReindex) btnReindex.disabled = !hasCatalogo;
  if (btnClear) btnClear.disabled = !hasCatalogo;
  if (btnSave) btnSave.disabled = !hasCatalogo || !dirty;
}

function etiqSelecionadosEstaoDirty(): boolean {
  if (etiqState.selecionados.size !== etiqState.selecionadosOriginais.size) {
    return true;
  }
  for (const id of etiqState.selecionados) {
    if (!etiqState.selecionadosOriginais.has(id)) return true;
  }
  return false;
}

async function loadEtiquetasTab(): Promise<void> {
  hydrateEtiqPromptCriterios();
  if (etiqState.loaded) {
    renderEtiquetas();
    return;
  }
  try {
    const [catalogo, meta, selecionados] = await Promise.all([
      listEtiquetas(),
      loadCatalogMeta(),
      listSugestionaveis()
    ]);
    etiqState.catalogo = catalogo;
    etiqState.selecionados = new Set(selecionados.map((s) => s.idTag));
    etiqState.selecionadosOriginais = new Set(etiqState.selecionados);
    etiqState.loaded = true;
    if (catalogo.length === 0) {
      setEtiqStatus('Nenhum catálogo carregado ainda.');
    } else {
      const quando = meta?.lastFetchedAt
        ? new Date(meta.lastFetchedAt).toLocaleString('pt-BR')
        : '—';
      setEtiqStatus(
        `${catalogo.length} etiqueta(s) no catálogo · última busca: ${quando}.`,
        'ok'
      );
    }
    renderEtiquetas();
    setEtiqButtonsForState(catalogo.length > 0, false);
  } catch (err) {
    console.warn(`${LOG_PREFIX} popup loadEtiquetasTab:`, err);
    setEtiqStatus('Falha ao carregar catálogo local.', 'error');
  }
}

function obterFiltroColA(): { termo: string; apenasFavoritas: boolean } {
  const inputTermo = document.getElementById('etiq-col-a-filter') as HTMLInputElement | null;
  const inputFav = document.getElementById('etiq-col-a-only-favoritas') as HTMLInputElement | null;
  return {
    termo: (inputTermo?.value ?? '').trim().toLowerCase(),
    apenasFavoritas: inputFav?.checked === true
  };
}

function etiquetasFiltradas(): EtiquetaRecord[] {
  const { termo, apenasFavoritas } = obterFiltroColA();
  let lista = etiqState.catalogo;
  if (apenasFavoritas) lista = lista.filter((e) => e.favorita);
  if (termo) {
    lista = lista.filter((e) => {
      const hay =
        e.nomeTag.toLowerCase() + ' ' + (e.nomeTagCompleto ?? '').toLowerCase();
      return hay.includes(termo);
    });
  }
  return lista
    .slice()
    .sort((a, b) => a.nomeTag.localeCompare(b.nomeTag, 'pt-BR'));
}

function renderEtiquetas(): void {
  renderColA();
  renderColB();
  setEtiqButtonsForState(
    etiqState.catalogo.length > 0,
    etiqSelecionadosEstaoDirty()
  );
}

function renderColA(): void {
  const list = document.getElementById('etiq-col-a-list') as HTMLUListElement | null;
  const count = document.getElementById('etiq-col-a-count');
  if (!list || !count) return;
  const filtradas = etiquetasFiltradas();
  count.textContent = String(filtradas.length);
  list.innerHTML = '';
  // 3000+ linhas com innerHTML direto é pesado mas aceitável (~80ms em
  // máquina típica). Filtros rápidos reduzem bastante; virtualização é
  // melhoria futura se necessário.
  const frag = document.createDocumentFragment();
  for (const e of filtradas) {
    const li = document.createElement('li');
    li.className = 'paidegua-etiquetas-col__item';
    const label = document.createElement('label');
    label.className = 'paidegua-popup__checkbox paidegua-popup__checkbox--inline';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.idTag = String(e.id);
    input.checked = etiqState.selecionados.has(e.id);
    input.addEventListener('change', () => {
      if (input.checked) etiqState.selecionados.add(e.id);
      else etiqState.selecionados.delete(e.id);
      renderColB();
      setEtiqButtonsForState(true, etiqSelecionadosEstaoDirty());
    });
    const span = document.createElement('span');
    const nome = e.nomeTag + (e.favorita ? ' ★' : '');
    span.textContent = nome;
    span.title = e.nomeTagCompleto || e.nomeTag;
    label.append(input, span);
    li.append(label);
    frag.append(li);
  }
  list.append(frag);
}

function renderColB(): void {
  const list = document.getElementById('etiq-col-b-list') as HTMLUListElement | null;
  const count = document.getElementById('etiq-col-b-count');
  if (!list || !count) return;
  count.textContent = String(etiqState.selecionados.size);
  list.innerHTML = '';
  const byId = new Map(etiqState.catalogo.map((e) => [e.id, e]));
  const selecionadas = Array.from(etiqState.selecionados)
    .map((id) => byId.get(id))
    .filter((x): x is EtiquetaRecord => !!x)
    .sort((a, b) => a.nomeTag.localeCompare(b.nomeTag, 'pt-BR'));
  const frag = document.createDocumentFragment();
  for (const e of selecionadas) {
    const li = document.createElement('li');
    li.className = 'paidegua-etiquetas-col__item paidegua-etiquetas-col__item--pill';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'paidegua-etiquetas-pill';
    btn.textContent = e.nomeTag + ' ×';
    btn.title = `Remover "${e.nomeTag}"`;
    btn.addEventListener('click', () => {
      etiqState.selecionados.delete(e.id);
      // Refletir no checkbox da coluna A se estiver visível.
      const colA = document.getElementById('etiq-col-a-list');
      const inp = colA?.querySelector<HTMLInputElement>(
        `input[data-id-tag="${e.id}"]`
      );
      if (inp) inp.checked = false;
      renderColB();
      setEtiqButtonsForState(true, etiqSelecionadosEstaoDirty());
    });
    li.append(btn);
    frag.append(li);
  }
  list.append(frag);
}

async function fetchCatalogoEtiquetas(): Promise<void> {
  const btnFetch = document.getElementById('btn-etiq-fetch') as HTMLButtonElement | null;
  const btnReindex = document.getElementById('btn-etiq-reindex') as HTMLButtonElement | null;
  if (btnFetch) btnFetch.disabled = true;
  if (btnReindex) btnReindex.disabled = true;
  setEtiqProgress(true, 0, 0, 'Consultando PJe…');
  setEtiqStatus('Buscando catálogo no PJe…', 'info');
  try {
    const resp = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.ETIQUETAS_FETCH_CATALOG,
      payload: { pageSize: 5000 }
    })) as PJeApiEtiquetasListResponse | undefined;
    if (!resp || !resp.ok) {
      setEtiqStatus(resp?.error ?? 'Falha na busca do catálogo.', 'error');
      return;
    }
    setEtiqProgress(true, resp.etiquetas.length, resp.total, 'Gravando local…');
    const now = new Date().toISOString();
    const records: EtiquetaRecord[] = resp.etiquetas.map(
      (e: PJeApiEtiqueta) => ({
        id: e.id,
        nomeTag: e.nomeTag,
        nomeTagCompleto: e.nomeTagCompleto,
        favorita: e.favorita,
        possuiFilhos: e.possuiFilhos,
        idTagFavorita: e.idTagFavorita,
        ingestedAt: now
      })
    );
    // Sobrescreve catálogo: o clear também zera sugestionáveis (documento
    // na camada de storage). Fica explícito para o usuário no status.
    await clearAllEtiquetas();
    await saveEtiquetas(records);
    await saveCatalogMeta({
      lastFetchedAt: now,
      count: records.length,
      ojLocalizacao: null
    });
    etiqState.catalogo = records;
    etiqState.selecionados = new Set();
    etiqState.selecionadosOriginais = new Set();
    setEtiqStatus(
      `${records.length} etiqueta(s) salva(s) localmente.` +
        (resp.total > records.length
          ? ` O servidor reportou ${resp.total}; diferença indica duplicatas ou truncamento.`
          : ''),
      'ok'
    );
    renderEtiquetas();
    await notificarInvalidateIndex();
  } catch (err) {
    console.warn(`${LOG_PREFIX} fetchCatalogoEtiquetas:`, err);
    setEtiqStatus(
      err instanceof Error ? err.message : 'Falha desconhecida.',
      'error'
    );
  } finally {
    setEtiqProgress(false);
    if (btnFetch) btnFetch.disabled = false;
    setEtiqButtonsForState(etiqState.catalogo.length > 0, false);
  }
}

async function salvarSugestionaveis(): Promise<void> {
  try {
    await replaceSugestionaveis(Array.from(etiqState.selecionados));
    etiqState.selecionadosOriginais = new Set(etiqState.selecionados);
    setEtiqStatus(
      `${etiqState.selecionados.size} etiqueta(s) sugestionável(is) salva(s).`,
      'ok'
    );
    setEtiqButtonsForState(true, false);
    await notificarInvalidateIndex();
  } catch (err) {
    setEtiqStatus(
      err instanceof Error ? err.message : 'Falha ao salvar.',
      'error'
    );
  }
}

async function removerCatalogo(): Promise<void> {
  const confirmed = confirm(
    'Remover o catálogo de etiquetas e a seleção de sugestionáveis? ' +
      'Você pode buscar novamente a qualquer momento.'
  );
  if (!confirmed) return;
  try {
    await clearAllEtiquetas();
    await clearCatalogMeta();
    etiqState.catalogo = [];
    etiqState.selecionados = new Set();
    etiqState.selecionadosOriginais = new Set();
    setEtiqStatus('Catálogo removido.', 'ok');
    renderEtiquetas();
    setEtiqButtonsForState(false, false);
    await notificarInvalidateIndex();
  } catch (err) {
    setEtiqStatus(
      err instanceof Error ? err.message : 'Falha ao remover catálogo.',
      'error'
    );
  }
}

async function notificarInvalidateIndex(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.ETIQUETAS_INVALIDATE,
      payload: null
    });
  } catch (err) {
    // Best-effort — se o service worker não tiver handler ainda, não é
    // crítico: na próxima busca o índice é reconstruído sob demanda.
    console.debug(`${LOG_PREFIX} notificarInvalidateIndex:`, err);
  }
}

function hydrateEtiqPromptCriterios(): void {
  const ta = document.getElementById('etiq-prompt-criterios') as HTMLTextAreaElement | null;
  if (!ta || !currentSettings) return;
  // Só sobrescreve se o usuário ainda não começou a digitar nesta abertura.
  if (!ta.dataset.hydrated) {
    ta.value = currentSettings.etiquetasPromptCriterios ?? '';
    ta.dataset.hydrated = '1';
  }
  const enable = document.getElementById('etiq-prompt-enable') as HTMLInputElement | null;
  const body = document.getElementById('etiq-prompt-body') as HTMLElement | null;
  const hasText = ta.value.trim().length > 0;
  if (enable) enable.checked = hasText;
  if (body) {
    if (hasText) body.removeAttribute('hidden');
    else body.setAttribute('hidden', '');
  }
  atualizarContadorEtiqPrompt();
}

function atualizarContadorEtiqPrompt(): void {
  const ta = document.getElementById('etiq-prompt-criterios') as HTMLTextAreaElement | null;
  const el = document.getElementById('etiq-prompt-count');
  if (!ta || !el) return;
  const len = ta.value.length;
  el.textContent = len === 1 ? '1 caractere' : `${len} caracteres`;
}

let etiqPromptSaveTimer: number | null = null;
function scheduleSaveEtiqPromptCriterios(): void {
  if (etiqPromptSaveTimer !== null) {
    window.clearTimeout(etiqPromptSaveTimer);
  }
  etiqPromptSaveTimer = window.setTimeout(() => {
    void saveEtiqPromptCriterios();
  }, 500);
}

async function saveEtiqPromptCriterios(): Promise<void> {
  if (!currentSettings) return;
  const ta = document.getElementById('etiq-prompt-criterios') as HTMLTextAreaElement | null;
  const statusEl = document.getElementById('etiq-prompt-status') as HTMLElement | null;
  if (!ta) return;
  const value = ta.value;
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
      payload: { etiquetasPromptCriterios: value }
    })) as { ok: boolean; settings?: PAIdeguaSettings; error?: string };
    if (response?.ok && response.settings) {
      currentSettings = response.settings;
      if (statusEl) {
        statusEl.textContent = 'Orientações salvas.';
        statusEl.className = 'paidegua-popup__status is-ok';
        window.setTimeout(() => {
          if (statusEl.textContent === 'Orientações salvas.') {
            statusEl.textContent = '';
            statusEl.className = 'paidegua-popup__status';
          }
        }, 2000);
      }
    } else if (statusEl) {
      statusEl.textContent = response?.error ?? 'Falha ao salvar orientações.';
      statusEl.className = 'paidegua-popup__status is-error';
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} saveEtiqPromptCriterios:`, err);
  }
}

function bindEtiquetasEvents(): void {
  document.getElementById('etiq-prompt-criterios')?.addEventListener('input', () => {
    atualizarContadorEtiqPrompt();
    scheduleSaveEtiqPromptCriterios();
  });
  document.getElementById('etiq-prompt-enable')?.addEventListener('change', () => {
    const enable = document.getElementById('etiq-prompt-enable') as HTMLInputElement | null;
    const body = document.getElementById('etiq-prompt-body') as HTMLElement | null;
    const ta = document.getElementById('etiq-prompt-criterios') as HTMLTextAreaElement | null;
    if (!enable || !body || !ta) return;
    if (enable.checked) {
      body.removeAttribute('hidden');
      window.setTimeout(() => ta.focus(), 0);
    } else {
      const hasContent = ta.value.trim().length > 0;
      if (hasContent && !confirm('Remover orientações customizadas?')) {
        enable.checked = true;
        return;
      }
      ta.value = '';
      atualizarContadorEtiqPrompt();
      body.setAttribute('hidden', '');
      void saveEtiqPromptCriterios();
    }
  });
  document.getElementById('btn-etiq-fetch')?.addEventListener('click', () => {
    void fetchCatalogoEtiquetas();
  });
  document.getElementById('btn-etiq-reindex')?.addEventListener('click', () => {
    void fetchCatalogoEtiquetas();
  });
  document.getElementById('btn-etiq-save')?.addEventListener('click', () => {
    void salvarSugestionaveis();
  });
  document.getElementById('btn-etiq-clear')?.addEventListener('click', () => {
    void removerCatalogo();
  });
  document.getElementById('etiq-col-a-filter')?.addEventListener('input', () => {
    renderColA();
  });
  document
    .getElementById('etiq-col-a-only-favoritas')
    ?.addEventListener('change', () => {
      renderColA();
    });
  document
    .getElementById('etiq-col-a-select-visible')
    ?.addEventListener('click', () => {
      for (const e of etiquetasFiltradas()) etiqState.selecionados.add(e.id);
      renderEtiquetas();
    });
  document
    .getElementById('etiq-col-a-deselect-visible')
    ?.addEventListener('click', () => {
      for (const e of etiquetasFiltradas()) etiqState.selecionados.delete(e.id);
      renderEtiquetas();
    });
  document
    .getElementById('etiq-col-a-select-favoritas')
    ?.addEventListener('click', () => {
      for (const e of etiqState.catalogo)
        if (e.favorita) etiqState.selecionados.add(e.id);
      renderEtiquetas();
    });
}

async function _debugCountEtiquetas(): Promise<number> {
  // Helper reservado para diagnóstico pelo console.
  return countEtiquetas();
}
void _debugCountEtiquetas;
