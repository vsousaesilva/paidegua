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
  TestConnectionResult,
  TriagemCriterioCustom
} from '../shared/types';
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
    // Aba "Triagem Inteligente" é específica da Secretaria.
    const tabTriagem = document.getElementById('tab-triagem');
    if (tabTriagem) tabTriagem.setAttribute('hidden', '');
    const triagemSelected = tabTriagem?.getAttribute('aria-selected') === 'true';
    if (triagemSelected) setActiveTab('tab-geral');
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

function setActiveTab(tabId: 'tab-geral' | 'tab-triagem'): void {
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
}

function bindTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.paidegua-popup__tab').forEach((t) => {
    t.addEventListener('click', () => {
      setActiveTab(t.id as 'tab-geral' | 'tab-triagem');
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
  void loadAll();
});
