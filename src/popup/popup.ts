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
import { describeAuthError, validateEmailDomain } from '../shared/auth';
import type {
  AuthRequestCodeResponse,
  AuthStatusResponse,
  AuthVerifyCodeResponse
} from '../shared/types';
import type {
  PAIdeguaSettings,
  PericiaGenero,
  PericiaPerito,
  PericiaPeritosStore,
  PericiaProfissao,
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
  addPerito,
  deletePerito,
  listPeritos,
  loadAssuntosCatalogo,
  loadPericiasStore,
  savePericiasStore,
  updatePerito,
  type PericiaPeritoInput
} from '../shared/pericias-store';
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

function renderPowerCard(enabled: boolean): void {
  const card = document.getElementById('power-card');
  const toggle = document.getElementById('power-toggle') as HTMLInputElement | null;
  const title = document.getElementById('power-title');
  const subtitle = document.getElementById('power-subtitle');
  if (!card || !toggle || !title || !subtitle) return;
  toggle.checked = enabled;
  card.classList.toggle('is-off', !enabled);
  title.textContent = enabled ? 'Extensão Ativada' : 'Extensão Desativada';
  subtitle.textContent = enabled
    ? 'Aproveite e utilize todos os recursos.'
    : 'A extensão não agirá nas páginas do PJe até ser reativada.';
}

async function saveExtensionEnabled(enabled: boolean): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
    payload: { extensionEnabled: enabled }
  })) as { ok: boolean; settings?: PAIdeguaSettings; error?: string };
  if (response?.ok && response.settings) {
    currentSettings = response.settings;
    renderPowerCard(response.settings.extensionEnabled);
  } else {
    const previous = currentSettings?.extensionEnabled ?? true;
    renderPowerCard(previous);
    setStatus(response?.error ?? 'Falha ao alterar estado da extensão.', 'error');
  }
}

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
    renderPowerCard(currentSettings.extensionEnabled);

    renderForProvider(currentSettings.activeProvider);
    renderTriagemCriterios();
    hydrateComunicacaoSettings();
    await applyGrauRestrictions();
    setStatus('');
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} popup loadAll falhou:`, error);
    setStatus('Erro ao comunicar com o service worker.', 'error');
  }
}

function hydrateComunicacaoSettings(): void {
  if (!currentSettings) return;
  const c = currentSettings.comunicacao ?? {
    nomeVara: '',
    emailCeab: '',
    telefoneCeab: '',
    etiquetaCobrancaPerito: '',
    etiquetaCobrancaCeab: ''
  };
  const inNomeVara = document.getElementById('comm-nome-vara') as HTMLInputElement | null;
  const inEmail = document.getElementById('comm-email-ceab') as HTMLInputElement | null;
  const inTelefone = document.getElementById('comm-telefone-ceab') as HTMLInputElement | null;
  const inEtqPer = document.getElementById('comm-etiqueta-perito') as HTMLInputElement | null;
  const inEtqCeab = document.getElementById('comm-etiqueta-ceab') as HTMLInputElement | null;
  if (inNomeVara) inNomeVara.value = c.nomeVara ?? '';
  if (inEmail) inEmail.value = c.emailCeab ?? '';
  if (inTelefone) inTelefone.value = c.telefoneCeab ?? '';
  if (inEtqPer) inEtqPer.value = c.etiquetaCobrancaPerito ?? '';
  if (inEtqCeab) inEtqCeab.value = c.etiquetaCobrancaCeab ?? '';
}

let comunicacaoSaveTimer: number | null = null;
function scheduleSaveComunicacao(): void {
  if (comunicacaoSaveTimer !== null) {
    window.clearTimeout(comunicacaoSaveTimer);
  }
  comunicacaoSaveTimer = window.setTimeout(() => {
    void saveComunicacao();
  }, 500);
}

async function saveComunicacao(): Promise<void> {
  const inNomeVara = document.getElementById('comm-nome-vara') as HTMLInputElement | null;
  const inEmail = document.getElementById('comm-email-ceab') as HTMLInputElement | null;
  const inTelefone = document.getElementById('comm-telefone-ceab') as HTMLInputElement | null;
  const inEtqPer = document.getElementById('comm-etiqueta-perito') as HTMLInputElement | null;
  const inEtqCeab = document.getElementById('comm-etiqueta-ceab') as HTMLInputElement | null;
  const status = document.getElementById('comm-status') as HTMLElement | null;
  const comunicacao = {
    nomeVara: (inNomeVara?.value ?? '').trim(),
    emailCeab: (inEmail?.value ?? '').trim(),
    telefoneCeab: (inTelefone?.value ?? '').trim(),
    etiquetaCobrancaPerito: (inEtqPer?.value ?? '').trim(),
    etiquetaCobrancaCeab: (inEtqCeab?.value ?? '').trim()
  };
  try {
    const response = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
      payload: { comunicacao }
    })) as { ok: boolean; settings?: PAIdeguaSettings; error?: string };
    if (response?.ok && response.settings) {
      currentSettings = response.settings;
      if (status) {
        status.textContent = 'Configurações salvas.';
        status.className = 'paidegua-popup__status is-ok';
        window.setTimeout(() => {
          if (status.textContent === 'Configurações salvas.') {
            status.textContent = '';
            status.className = 'paidegua-popup__status';
          }
        }, 2000);
      }
    } else if (status) {
      status.textContent = response?.error ?? 'Falha ao salvar.';
      status.className = 'paidegua-popup__status is-error';
    }
  } catch (err) {
    if (status) {
      status.textContent = err instanceof Error ? err.message : String(err);
      status.className = 'paidegua-popup__status is-error';
    }
  }
}

/**
 * Consulta a aba ativa e restringe as opções do popup por grau do PJe.
 *
 * Regras:
 *   - Seletor de perfil: gatea por grau porque o perfil determina o
 *     comportamento da sidebar NAQUELE PJe especifico. Secretaria so em
 *     1g; Gestao em todos os graus (por enquanto).
 *   - Abas de configuracao (Triagem, Etiquetas, Pericias): SEMPRE
 *     visiveis. Sao telas onde o usuario configura peritos, criterios e
 *     catalogo de etiquetas — configuracao persistente, nao depende de
 *     onde a aba ativa esta navegando.
 *
 * Em abas que nao sao PJe, nada muda (o seletor mantem todos os perfis
 * e as abas continuam visiveis).
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
  // Em abas que NÃO são PJe (`unknown`), o popup é só configuração global —
  // não faz sentido restringir os perfis pelo conteúdo da aba aleatória que
  // o usuário está vendo, nem sobrescrever o `defaultProfile` salvo. Só
  // entra na trava de grau quando a aba ativa é comprovadamente PJe.
  if (grau === 'unknown') return;

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

  // Persistir perfil padrao como Gabinete se estiver em Secretaria mas
  // nao for permitido no grau atual (evita o sidebar abrir num perfil
  // invalido na proxima navegacao).
  if (!secretariaOk && stored === 'secretaria') {
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

type TabId = 'tab-geral' | 'tab-triagem' | 'tab-etiquetas' | 'tab-pericias' | 'tab-comunicacao';

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
  if (tabId === 'tab-pericias') {
    void loadPericiasTab();
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
  const powerToggle = document.getElementById('power-toggle') as HTMLInputElement | null;
  if (powerToggle) {
    powerToggle.addEventListener('change', () => {
      void saveExtensionEnabled(powerToggle.checked);
    });
  }
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

  // Atalhos para o módulo Sigcrim (acervo criminal local-first).
  // O dashboard lê do IDB e funciona offline — não precisa de aba PJe
  // aberta. Já a varredura, sim — esta continua sendo disparada
  // dentro do PJe via sidebar paidegua.
  const abrirEmAba = (path: string): void => {
    const url = chrome.runtime.getURL(path);
    if (chrome.tabs?.create) {
      void chrome.tabs.create({ url });
    } else {
      window.open(url, '_blank');
    }
  };
  $<HTMLButtonElement>('btn-open-sigcrim-dash').addEventListener('click', () => {
    abrirEmAba('criminal-dashboard/dashboard.html');
  });
  $<HTMLButtonElement>('btn-open-sigcrim-config').addEventListener('click', () => {
    abrirEmAba('criminal-config/criminal-config.html');
  });
  // Abre a página de diagnóstico (histórico local de varreduras). Usa
  // `chrome.tabs.create` em aba nova para não substituir a página atual
  // do usuário. Fallback `window.open` cobre contextos sem `chrome.tabs`.
  const diagLink = document.getElementById('open-diagnostico-link');
  if (diagLink) {
    diagLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      const url = chrome.runtime.getURL('diagnostico/diagnostico.html');
      if (chrome.tabs?.create) {
        void chrome.tabs.create({ url });
      } else {
        window.open(url, '_blank');
      }
    });
  }
  // Formulario de suporte: abre uma aba com o formulario estruturado; ao
  // enviar, a propria pagina monta o mailto: para inovajus@jfce.jus.br.
  const supLink = document.getElementById('open-suporte-link');
  if (supLink) {
    supLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      const url = chrome.runtime.getURL('suporte/suporte.html');
      if (chrome.tabs?.create) {
        void chrome.tabs.create({ url });
      } else {
        window.open(url, '_blank');
      }
    });
  }
}

// =====================================================================
// Tela de login (whitelist Inovajus + OTP)
// =====================================================================
//
// Politica: ate o background confirmar via `AUTH_GET_STATUS` que existe
// uma sessao valida, o overlay `#auth-gate` permanece visivel e nada da
// UI normal e inicializado. Apos sucesso de `verifyCode`, o popup roda
// o mesmo `loadAll()` da inicializacao normal.

let authBootstrapped = false;

function $authEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`PAIdegua popup: elemento #${id} ausente`);
  return el as T;
}

function setAuthStatus(
  elId: 'auth-status-email' | 'auth-status-code',
  text: string,
  kind: 'ok' | 'error' | 'info' | '' = ''
): void {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = 'paidegua-auth-gate__status' + (kind ? ` is-${kind}` : '');
}

function showAuthStage(stage: 'email' | 'code'): void {
  const stageEmail = $authEl<HTMLElement>('auth-stage-email');
  const stageCode = $authEl<HTMLElement>('auth-stage-code');
  if (stage === 'email') {
    stageEmail.removeAttribute('hidden');
    stageCode.setAttribute('hidden', '');
  } else {
    stageEmail.setAttribute('hidden', '');
    stageCode.removeAttribute('hidden');
  }
}

function showAuthGate(): void {
  $authEl<HTMLElement>('auth-gate').removeAttribute('hidden');
}

function hideAuthGate(): void {
  $authEl<HTMLElement>('auth-gate').setAttribute('hidden', '');
}

function renderUserPill(email: string | null): void {
  const pill = document.getElementById('auth-user-pill');
  const emailEl = document.getElementById('auth-user-email');
  if (!pill || !emailEl) return;
  if (email) {
    emailEl.textContent = email;
    pill.removeAttribute('hidden');
  } else {
    emailEl.textContent = '';
    pill.setAttribute('hidden', '');
  }
}

async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const response = (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.AUTH_GET_STATUS
  })) as AuthStatusResponse;
  return response ?? { authenticated: false, reason: 'no_session' };
}

async function requestLoginCode(email: string): Promise<AuthRequestCodeResponse> {
  return (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.AUTH_REQUEST_CODE,
    payload: { email }
  })) as AuthRequestCodeResponse;
}

async function verifyLoginCode(
  email: string,
  code: string
): Promise<AuthVerifyCodeResponse> {
  return (await chrome.runtime.sendMessage({
    channel: MESSAGE_CHANNELS.AUTH_VERIFY_CODE,
    payload: { email, code }
  })) as AuthVerifyCodeResponse;
}

async function requestLogout(): Promise<void> {
  await chrome.runtime.sendMessage({ channel: MESSAGE_CHANNELS.AUTH_LOGOUT });
}

function bindAuthGate(): void {
  const requestBtn = $authEl<HTMLButtonElement>('auth-request-btn');
  const verifyBtn = $authEl<HTMLButtonElement>('auth-verify-btn');
  const backBtn = $authEl<HTMLButtonElement>('auth-back-btn');
  const emailInput = $authEl<HTMLInputElement>('auth-email-input');
  const codeInput = $authEl<HTMLInputElement>('auth-code-input');
  const emailDisplay = $authEl<HTMLSpanElement>('auth-email-display');
  const logoutBtn = document.getElementById('auth-logout-btn') as HTMLButtonElement | null;

  emailInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      requestBtn.click();
    }
  });
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      verifyBtn.click();
    }
  });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
  });

  requestBtn.addEventListener('click', () => {
    void (async () => {
      const email = emailInput.value.trim().toLowerCase();
      if (!validateEmailDomain(email)) {
        setAuthStatus(
          'auth-status-email',
          'E-mail invalido. Use um endereco institucional dos tribunais autorizados.',
          'error'
        );
        return;
      }
      requestBtn.disabled = true;
      setAuthStatus('auth-status-email', 'Enviando codigo...', 'info');
      try {
        const result = await requestLoginCode(email);
        if (result.ok) {
          emailDisplay.textContent = email;
          codeInput.value = '';
          showAuthStage('code');
          setAuthStatus('auth-status-code', '', '');
          codeInput.focus();
        } else {
          setAuthStatus(
            'auth-status-email',
            describeAuthError(result.error),
            'error'
          );
        }
      } finally {
        requestBtn.disabled = false;
      }
    })();
  });

  verifyBtn.addEventListener('click', () => {
    void (async () => {
      const email = (emailDisplay.textContent ?? '').trim().toLowerCase();
      const code = codeInput.value.trim();
      if (!email || code.length !== 6) {
        setAuthStatus(
          'auth-status-code',
          'Cole o codigo de 6 digitos recebido por e-mail.',
          'error'
        );
        return;
      }
      verifyBtn.disabled = true;
      backBtn.disabled = true;
      setAuthStatus('auth-status-code', 'Validando...', 'info');
      try {
        const result = await verifyLoginCode(email, code);
        if (result.ok && result.email) {
          await enterAuthenticatedUI(result.email);
        } else {
          setAuthStatus(
            'auth-status-code',
            describeAuthError(result.error),
            'error'
          );
        }
      } finally {
        verifyBtn.disabled = false;
        backBtn.disabled = false;
      }
    })();
  });

  backBtn.addEventListener('click', () => {
    showAuthStage('email');
    setAuthStatus('auth-status-email', '', '');
    codeInput.value = '';
  });

  logoutBtn?.addEventListener('click', () => {
    void (async () => {
      await requestLogout();
      renderUserPill(null);
      // Sem reload: apenas reabre a tela de login. O usuario pode fechar
      // o popup; na proxima abertura, o gate ja estara ativo de novo.
      showAuthStage('email');
      setAuthStatus('auth-status-email', 'Sessao encerrada.', 'info');
      showAuthGate();
    })();
  });
}

/**
 * Roda quando confirmamos sessao valida — dispara a inicializacao normal
 * do popup. E idempotente: chamar duas vezes nao re-bindeia handlers.
 */
async function enterAuthenticatedUI(email: string): Promise<void> {
  hideAuthGate();
  renderUserPill(email);
  if (authBootstrapped) return;
  authBootstrapped = true;
  bindTabs();
  bindEvents();
  bindTriagemExtras();
  bindEtiquetasEvents();
  bindPericiasEvents();
  bindComunicacaoEvents();
  bindBackupEvents();
  await loadAll();
}

function bindComunicacaoEvents(): void {
  for (const id of [
    'comm-nome-vara',
    'comm-email-ceab',
    'comm-telefone-ceab',
    'comm-etiqueta-perito',
    'comm-etiqueta-ceab'
  ]) {
    document
      .getElementById(id)
      ?.addEventListener('input', () => scheduleSaveComunicacao());
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bindAuthGate();
  void (async () => {
    const status = await fetchAuthStatus();
    if (status.authenticated && status.email) {
      await enterAuthenticatedUI(status.email);
    } else {
      showAuthGate();
      showAuthStage('email');
      const emailInput = document.getElementById('auth-email-input') as HTMLInputElement | null;
      emailInput?.focus();
    }
  })();
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

// =====================================================================
// Perícias pAIdegua — CRUD de peritos (perfil Secretaria)
// =====================================================================

interface PericiasTabState {
  loaded: boolean;
  peritos: PericiaPerito[];
  /** Edição em andamento: null = formulário oculto; '' = novo; id = editando. */
  editingId: string | null;
  /**
   * Catálogo acumulativo de `assuntoPrincipal` observados em coletas
   * anteriores do painel de Perícias. Alimentado pelo coletor (ver
   * `pericias-coletor.ts`) e usado como fonte primária do autocomplete
   * do campo "Assuntos preferenciais".
   */
  assuntosCatalogo: string[];
  form: {
    etiquetas: Array<{ id: number; nomeTag: string; nomeTagCompleto: string }>;
    assuntos: string[];
    /** Índice do item destacado na lista de sugestões de etiquetas. */
    highlight: number;
    /** Índice do item destacado na lista de sugestões de assuntos. */
    highlightAssuntos: number;
  };
}

const periciasState: PericiasTabState = {
  loaded: false,
  peritos: [],
  editingId: null,
  assuntosCatalogo: [],
  form: { etiquetas: [], assuntos: [], highlight: 0, highlightAssuntos: 0 }
};

function rotuloProfissao(p: PericiaProfissao): string {
  switch (p) {
    case 'ASSISTENTE_SOCIAL': return 'Assistente Social';
    case 'ENGENHEIRO': return 'Engenheiro';
    case 'GRAFOTECNICO': return 'Grafotécnico';
    case 'MEDICO':
    default: return 'Médico';
  }
}

function setPericiasStatus(text: string, kind: 'ok' | 'error' | 'info' | '' = ''): void {
  const el = document.getElementById('pericias-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'paidegua-popup__status' + (kind ? ` is-${kind}` : '');
}

async function loadPericiasTab(): Promise<void> {
  try {
    const peritos = await listPeritos();
    // Migração transparente: peritos antigos sem `profissao` assumem
    // MEDICO (preserva o comportamento de etiqueta DR/DRA anterior).
    periciasState.peritos = peritos.map((p) => {
      const anyP = p as unknown as { profissao?: PericiaProfissao };
      if (!anyP.profissao) {
        return { ...p, profissao: 'MEDICO' as PericiaProfissao };
      }
      return p;
    });
    periciasState.loaded = true;
    try {
      const catalogo = await loadAssuntosCatalogo();
      periciasState.assuntosCatalogo = Array.isArray(catalogo.assuntos)
        ? catalogo.assuntos
        : [];
    } catch (errCat) {
      console.warn(`${LOG_PREFIX} loadAssuntosCatalogo:`, errCat);
      periciasState.assuntosCatalogo = [];
    }
    renderPericiasLista();
  } catch (err) {
    console.warn(`${LOG_PREFIX} loadPericiasTab:`, err);
    setPericiasStatus('Falha ao ler peritos do armazenamento local.', 'error');
  }
}

function renderPericiasLista(): void {
  const ul = document.getElementById('pericias-lista') as HTMLUListElement | null;
  const count = document.getElementById('pericias-count');
  if (!ul || !count) return;
  const peritos = periciasState.peritos
    .slice()
    .sort((a, b) => a.nomeCompleto.localeCompare(b.nomeCompleto, 'pt-BR'));
  const total = peritos.length;
  const ativos = peritos.filter((p) => p.ativo).length;
  count.textContent =
    total === 0
      ? '0 peritos cadastrados'
      : `${total} perito(s) · ${ativos} ativo(s)`;
  ul.innerHTML = '';
  if (total === 0) {
    const empty = document.createElement('li');
    empty.className = 'paidegua-popup__hint paidegua-popup__hint--small';
    empty.textContent =
      'Nenhum perito cadastrado. Use "Adicionar perito" para começar.';
    ul.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of peritos) frag.appendChild(buildPericiaItem(p));
  ul.appendChild(frag);
}

function buildPericiaItem(p: PericiaPerito): HTMLElement {
  const li = document.createElement('li');
  li.className = 'paidegua-pericias-lista__item' + (p.ativo ? '' : ' is-inactive');

  const left = document.createElement('div');
  left.style.flex = '1';
  left.style.minWidth = '0';
  const nome = document.createElement('div');
  nome.className = 'paidegua-pericias-lista__nome';
  nome.textContent = p.nomeCompleto;
  const badges = document.createElement('div');
  badges.className = 'paidegua-pericias-lista__badges';
  const bGenero = document.createElement('span');
  bGenero.className = 'paidegua-pericias-badge';
  bGenero.textContent =
    p.profissao === 'ASSISTENTE_SOCIAL'
      ? 'AS'
      : p.genero === 'F'
        ? 'DRA'
        : 'DR';
  badges.appendChild(bGenero);
  const bProf = document.createElement('span');
  bProf.className = 'paidegua-pericias-badge paidegua-pericias-badge--muted';
  bProf.textContent = rotuloProfissao(p.profissao ?? 'MEDICO');
  badges.appendChild(bProf);
  const bEtq = document.createElement('span');
  bEtq.className =
    'paidegua-pericias-badge ' +
    (p.etiquetas.length > 0
      ? 'paidegua-pericias-badge--ok'
      : 'paidegua-pericias-badge--muted');
  bEtq.textContent = `${p.etiquetas.length} etiqueta(s)`;
  badges.appendChild(bEtq);
  const bQtd = document.createElement('span');
  bQtd.className = 'paidegua-pericias-badge paidegua-pericias-badge--muted';
  bQtd.textContent = `qtd. ${p.quantidadePadrao}`;
  badges.appendChild(bQtd);
  if (!p.ativo) {
    const bInativo = document.createElement('span');
    bInativo.className = 'paidegua-pericias-badge paidegua-pericias-badge--muted';
    bInativo.textContent = 'inativo';
    badges.appendChild(bInativo);
  }
  left.append(nome, badges);

  const actions = document.createElement('div');
  actions.className = 'paidegua-pericias-lista__actions';
  const btnEdit = document.createElement('button');
  btnEdit.type = 'button';
  btnEdit.className = 'paidegua-pericias-lista__btn';
  btnEdit.textContent = 'Editar';
  btnEdit.addEventListener('click', () => abrirFormularioPericia(p.id));
  const btnDel = document.createElement('button');
  btnDel.type = 'button';
  btnDel.className =
    'paidegua-pericias-lista__btn paidegua-pericias-lista__btn--danger';
  btnDel.textContent = 'Excluir';
  btnDel.addEventListener('click', () => void removerPericia(p.id));
  actions.append(btnEdit, btnDel);

  li.append(left, actions);
  return li;
}

async function removerPericia(id: string): Promise<void> {
  const alvo = periciasState.peritos.find((p) => p.id === id);
  const nome = alvo?.nomeCompleto ?? 'este perito';
  if (!confirm(`Remover "${nome}" do cadastro?`)) return;
  try {
    await deletePerito(id);
    periciasState.peritos = periciasState.peritos.filter((p) => p.id !== id);
    setPericiasStatus('Perito removido.', 'ok');
    renderPericiasLista();
  } catch (err) {
    setPericiasStatus(
      err instanceof Error ? err.message : 'Falha ao remover perito.',
      'error'
    );
  }
}

function abrirFormularioPericia(id: string | null): void {
  periciasState.editingId = id;
  const form = document.getElementById('pericias-form');
  const titulo = document.getElementById('pericias-form-titulo');
  if (!form || !titulo) return;
  const alvo =
    id === null ? null : periciasState.peritos.find((p) => p.id === id) ?? null;
  titulo.textContent = alvo ? 'Editar perito' : 'Novo perito';
  ($<HTMLInputElement>('per-nome-completo')).value = alvo?.nomeCompleto ?? '';
  ($<HTMLInputElement>('per-nome-etiqueta')).value = alvo?.nomeEtiquetaPauta ?? '';
  ($<HTMLSelectElement>('per-genero')).value = (alvo?.genero as string) ?? 'M';
  ($<HTMLSelectElement>('per-profissao')).value =
    (alvo?.profissao as string) ?? 'MEDICO';
  ($<HTMLInputElement>('per-quantidade')).value = String(
    alvo?.quantidadePadrao ?? 20
  );
  ($<HTMLInputElement>('per-telefone')).value = alvo?.telefone ?? '';
  ($<HTMLInputElement>('per-email')).value = alvo?.email ?? '';
  ($<HTMLInputElement>('per-ativo')).checked = alvo ? alvo.ativo : true;
  periciasState.form.etiquetas = alvo
    ? alvo.etiquetas.map((e) => ({ ...e }))
    : [];
  periciasState.form.assuntos = alvo ? [...alvo.assuntos] : [];
  periciasState.form.highlight = 0;
  periciasState.form.highlightAssuntos = 0;
  ($<HTMLInputElement>('per-etiquetas-input')).value = '';
  ($<HTMLInputElement>('per-assuntos-input')).value = '';
  renderEtiquetasSelecionadasChips();
  renderAssuntosChips();
  hideEtiquetasSugestoes();
  hideAssuntosSugestoes();
  form.removeAttribute('hidden');
  limparAvisoEtiquetas();
  ($<HTMLInputElement>('per-nome-completo')).focus();
}

function fecharFormularioPericia(): void {
  periciasState.editingId = null;
  const form = document.getElementById('pericias-form');
  if (form) form.setAttribute('hidden', '');
  hideEtiquetasSugestoes();
  hideAssuntosSugestoes();
}

function limparAvisoEtiquetas(): void {
  const el = document.getElementById('per-etiquetas-aviso');
  if (el) {
    el.textContent = '';
    el.className = 'paidegua-popup__hint paidegua-popup__hint--small';
  }
}

function mostrarAvisoEtiquetas(texto: string, erro = true): void {
  const el = document.getElementById('per-etiquetas-aviso');
  if (!el) return;
  el.textContent = texto;
  el.className =
    'paidegua-popup__hint paidegua-popup__hint--small' +
    (erro ? ' is-error' : '');
}

function renderEtiquetasSelecionadasChips(): void {
  const ul = document.getElementById('per-etiquetas-selecionadas');
  if (!ul) return;
  ul.innerHTML = '';
  const lista = periciasState.form.etiquetas;
  if (lista.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'paidegua-popup__hint paidegua-popup__hint--small';
    empty.textContent = 'Nenhuma etiqueta vinculada ainda.';
    ul.appendChild(empty);
    return;
  }
  lista.forEach((e, idx) => {
    const li = document.createElement('li');
    li.className = 'paidegua-pericias-chip';
    const ordem = document.createElement('span');
    ordem.className = 'paidegua-pericias-chip__order';
    ordem.textContent = `${idx + 1}.`;
    const nome = document.createElement('span');
    nome.className = 'paidegua-pericias-chip__nome';
    nome.textContent = e.nomeTag;
    nome.title = e.nomeTagCompleto || e.nomeTag;

    const ordemActions = document.createElement('span');
    ordemActions.className = 'paidegua-pericias-chip__order-actions';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'paidegua-pericias-chip__btn';
    up.textContent = '▲';
    up.title = 'Mover para cima (maior prioridade)';
    up.disabled = idx === 0;
    up.addEventListener('click', () => {
      if (idx === 0) return;
      const copia = [...periciasState.form.etiquetas];
      [copia[idx - 1], copia[idx]] = [copia[idx], copia[idx - 1]];
      periciasState.form.etiquetas = copia;
      renderEtiquetasSelecionadasChips();
    });
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'paidegua-pericias-chip__btn';
    down.textContent = '▼';
    down.title = 'Mover para baixo (menor prioridade)';
    down.disabled = idx === lista.length - 1;
    down.addEventListener('click', () => {
      if (idx === lista.length - 1) return;
      const copia = [...periciasState.form.etiquetas];
      [copia[idx + 1], copia[idx]] = [copia[idx], copia[idx + 1]];
      periciasState.form.etiquetas = copia;
      renderEtiquetasSelecionadasChips();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className =
      'paidegua-pericias-chip__btn paidegua-pericias-chip__btn--remove';
    remove.textContent = '×';
    remove.title = 'Remover esta etiqueta';
    remove.addEventListener('click', () => {
      periciasState.form.etiquetas = periciasState.form.etiquetas.filter(
        (_, i) => i !== idx
      );
      renderEtiquetasSelecionadasChips();
    });
    ordemActions.append(up, down, remove);
    li.append(ordem, nome, ordemActions);
    ul.appendChild(li);
  });
}

function renderAssuntosChips(): void {
  const ul = document.getElementById('per-assuntos-selecionados');
  if (!ul) return;
  ul.innerHTML = '';
  const lista = periciasState.form.assuntos;
  if (lista.length === 0) return;
  lista.forEach((texto, idx) => {
    const li = document.createElement('li');
    li.className = 'paidegua-pericias-chip';
    const ordem = document.createElement('span');
    ordem.className = 'paidegua-pericias-chip__order';
    ordem.textContent = `${idx + 1}.`;
    const nome = document.createElement('span');
    nome.className = 'paidegua-pericias-chip__nome';
    nome.textContent = texto;
    nome.title = texto;

    const actions = document.createElement('span');
    actions.className = 'paidegua-pericias-chip__order-actions';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'paidegua-pericias-chip__btn';
    up.textContent = '▲';
    up.title = 'Mover para cima (maior prioridade)';
    up.disabled = idx === 0;
    up.addEventListener('click', () => {
      if (idx === 0) return;
      const copia = [...periciasState.form.assuntos];
      [copia[idx - 1], copia[idx]] = [copia[idx], copia[idx - 1]];
      periciasState.form.assuntos = copia;
      renderAssuntosChips();
    });
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'paidegua-pericias-chip__btn';
    down.textContent = '▼';
    down.title = 'Mover para baixo (menor prioridade)';
    down.disabled = idx === lista.length - 1;
    down.addEventListener('click', () => {
      if (idx === lista.length - 1) return;
      const copia = [...periciasState.form.assuntos];
      [copia[idx + 1], copia[idx]] = [copia[idx], copia[idx + 1]];
      periciasState.form.assuntos = copia;
      renderAssuntosChips();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className =
      'paidegua-pericias-chip__btn paidegua-pericias-chip__btn--remove';
    remove.textContent = '×';
    remove.title = 'Remover este assunto';
    remove.addEventListener('click', () => {
      periciasState.form.assuntos = periciasState.form.assuntos.filter(
        (_, i) => i !== idx
      );
      renderAssuntosChips();
    });
    actions.append(up, down, remove);
    li.append(ordem, nome, actions);
    ul.appendChild(li);
  });
}

function hideAssuntosSugestoes(): void {
  const menu = document.getElementById('per-assuntos-sugestoes');
  if (menu) {
    menu.innerHTML = '';
    menu.setAttribute('hidden', '');
  }
}

/**
 * Fonte das sugestões de assuntos do autocomplete. Une duas origens:
 *   1. Catálogo acumulativo de `assuntoPrincipal` coletados do painel de
 *      Perícias (gravado em `chrome.storage.local` pelo coletor — ver
 *      `pericias-coletor.ts`). É a fonte primária, não depende do usuário.
 *   2. Assuntos já cadastrados em OUTROS peritos do store (peer-reuse).
 * O PJe não expõe endpoint dedicado de catálogo de assuntos; a coleta
 * incremental alimenta o autocomplete com o que aparece de verdade no
 * painel desta unidade.
 */
function fontesDeAssuntos(): string[] {
  const set = new Map<string, string>(); // lowercase → forma original
  for (const a of periciasState.assuntosCatalogo) {
    const v = a.trim();
    if (!v) continue;
    const norm = v.toLowerCase();
    if (!set.has(norm)) set.set(norm, v);
  }
  for (const p of periciasState.peritos) {
    if (p.id === periciasState.editingId) continue;
    for (const a of p.assuntos) {
      const v = a.trim();
      if (!v) continue;
      const norm = v.toLowerCase();
      if (!set.has(norm)) set.set(norm, v);
    }
  }
  return Array.from(set.values()).sort((a, b) =>
    a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })
  );
}

function pesquisarAssuntos(termo: string): string[] {
  const alvo = termo.trim().toLowerCase();
  const escolhidos = new Set(
    periciasState.form.assuntos.map((a) => a.trim().toLowerCase())
  );
  const base = fontesDeAssuntos().filter(
    (a) => !escolhidos.has(a.trim().toLowerCase())
  );
  if (!alvo) return base.slice(0, 20);
  return base.filter((a) => a.toLowerCase().includes(alvo)).slice(0, 20);
}

function atualizarSugestoesAssuntos(): void {
  const input = $<HTMLInputElement>('per-assuntos-input');
  const menu = document.getElementById('per-assuntos-sugestoes');
  if (!menu) return;
  const sugestoes = pesquisarAssuntos(input.value);
  menu.innerHTML = '';
  if (sugestoes.length === 0) {
    const termo = input.value.trim();
    if (!termo) {
      hideAssuntosSugestoes();
      return;
    }
    const empty = document.createElement('li');
    empty.className = 'paidegua-pericias-autocomplete__empty';
    empty.textContent =
      'Sem sugestões. Pressione Enter para criar "' + termo + '".';
    menu.appendChild(empty);
    menu.removeAttribute('hidden');
    return;
  }
  periciasState.form.highlightAssuntos = Math.min(
    periciasState.form.highlightAssuntos,
    sugestoes.length - 1
  );
  sugestoes.forEach((texto, idx) => {
    const li = document.createElement('li');
    li.className =
      'paidegua-pericias-autocomplete__item' +
      (idx === periciasState.form.highlightAssuntos ? ' is-active' : '');
    const nome = document.createElement('div');
    nome.className = 'paidegua-pericias-autocomplete__item-nome';
    nome.textContent = texto;
    li.appendChild(nome);
    li.addEventListener('mouseenter', () => {
      periciasState.form.highlightAssuntos = idx;
      menu.querySelectorAll('.is-active').forEach((n) => n.classList.remove('is-active'));
      li.classList.add('is-active');
    });
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      adicionarAssuntoEscolhido(texto);
    });
    menu.appendChild(li);
  });
  menu.removeAttribute('hidden');
}

function adicionarAssuntoEscolhido(texto: string): void {
  const v = texto.trim();
  if (!v) return;
  const existe = periciasState.form.assuntos.some(
    (a) => a.toLowerCase() === v.toLowerCase()
  );
  if (!existe) {
    periciasState.form.assuntos.push(v);
    renderAssuntosChips();
  }
  const input = $<HTMLInputElement>('per-assuntos-input');
  input.value = '';
  periciasState.form.highlightAssuntos = 0;
  hideAssuntosSugestoes();
  input.focus();
}

function hideEtiquetasSugestoes(): void {
  const menu = document.getElementById('per-etiquetas-sugestoes');
  if (menu) {
    menu.innerHTML = '';
    menu.setAttribute('hidden', '');
  }
}

async function pesquisarEtiquetasCatalogo(
  termo: string
): Promise<EtiquetaRecord[]> {
  if (!etiqState.loaded) {
    try {
      etiqState.catalogo = await listEtiquetas();
      etiqState.loaded = true;
    } catch {
      return [];
    }
  }
  const alvo = termo.trim().toLowerCase();
  if (!alvo) return [];
  const jaEscolhidos = new Set(
    periciasState.form.etiquetas.map((e) => e.id)
  );
  return etiqState.catalogo
    .filter((e) => !jaEscolhidos.has(e.id))
    .filter((e) => {
      const hay =
        e.nomeTag.toLowerCase() + ' ' + (e.nomeTagCompleto ?? '').toLowerCase();
      return hay.includes(alvo);
    })
    .sort((a, b) => a.nomeTag.localeCompare(b.nomeTag, 'pt-BR'))
    .slice(0, 20);
}

async function atualizarSugestoesEtiquetas(): Promise<void> {
  const input = $<HTMLInputElement>('per-etiquetas-input');
  const menu = document.getElementById('per-etiquetas-sugestoes');
  if (!menu) return;
  const termo = input.value;
  if (!termo.trim()) {
    hideEtiquetasSugestoes();
    return;
  }
  const sugestoes = await pesquisarEtiquetasCatalogo(termo);
  menu.innerHTML = '';
  if (sugestoes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'paidegua-pericias-autocomplete__empty';
    empty.textContent = etiqState.catalogo.length === 0
      ? 'Catálogo de etiquetas não carregado. Abra a aba "Etiquetas Inteligentes" e busque o catálogo do PJe.'
      : 'Nenhuma etiqueta encontrada para este termo.';
    menu.appendChild(empty);
    menu.removeAttribute('hidden');
    return;
  }
  periciasState.form.highlight = Math.min(
    periciasState.form.highlight,
    sugestoes.length - 1
  );
  sugestoes.forEach((e, idx) => {
    const li = document.createElement('li');
    li.className =
      'paidegua-pericias-autocomplete__item' +
      (idx === periciasState.form.highlight ? ' is-active' : '');
    const nome = document.createElement('div');
    nome.className = 'paidegua-pericias-autocomplete__item-nome';
    nome.textContent = e.nomeTag + (e.favorita ? ' ★' : '');
    const path = document.createElement('div');
    path.className = 'paidegua-pericias-autocomplete__item-path';
    path.textContent = e.nomeTagCompleto || '';
    li.append(nome, path);
    li.addEventListener('mouseenter', () => {
      periciasState.form.highlight = idx;
      menu.querySelectorAll('.is-active').forEach((n) => n.classList.remove('is-active'));
      li.classList.add('is-active');
    });
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      adicionarEtiquetaEscolhida(e);
    });
    menu.appendChild(li);
  });
  menu.removeAttribute('hidden');
}

function adicionarEtiquetaEscolhida(e: EtiquetaRecord): void {
  const jaTem = periciasState.form.etiquetas.some((x) => x.id === e.id);
  if (!jaTem) {
    periciasState.form.etiquetas.push({
      id: e.id,
      nomeTag: e.nomeTag,
      nomeTagCompleto: e.nomeTagCompleto
    });
    renderEtiquetasSelecionadasChips();
    limparAvisoEtiquetas();
  }
  $<HTMLInputElement>('per-etiquetas-input').value = '';
  periciasState.form.highlight = 0;
  hideEtiquetasSugestoes();
  $<HTMLInputElement>('per-etiquetas-input').focus();
}

function handleEtiquetasInputKeydown(ev: KeyboardEvent): void {
  const menu = document.getElementById('per-etiquetas-sugestoes');
  const hasMenu = menu && !menu.hasAttribute('hidden');
  const items = menu
    ? Array.from(
        menu.querySelectorAll<HTMLLIElement>('.paidegua-pericias-autocomplete__item')
      )
    : [];
  if (ev.key === 'ArrowDown' && hasMenu && items.length > 0) {
    ev.preventDefault();
    periciasState.form.highlight =
      (periciasState.form.highlight + 1) % items.length;
    items.forEach((n, i) =>
      n.classList.toggle('is-active', i === periciasState.form.highlight)
    );
  } else if (ev.key === 'ArrowUp' && hasMenu && items.length > 0) {
    ev.preventDefault();
    periciasState.form.highlight =
      (periciasState.form.highlight - 1 + items.length) % items.length;
    items.forEach((n, i) =>
      n.classList.toggle('is-active', i === periciasState.form.highlight)
    );
  } else if (ev.key === 'Enter') {
    if (hasMenu && items.length > 0) {
      ev.preventDefault();
      items[periciasState.form.highlight]?.dispatchEvent(
        new MouseEvent('mousedown')
      );
    }
  } else if (ev.key === 'Escape' && hasMenu) {
    ev.preventDefault();
    hideEtiquetasSugestoes();
  }
}

function handleAssuntosInputKeydown(ev: KeyboardEvent): void {
  const menu = document.getElementById('per-assuntos-sugestoes');
  const hasMenu = menu && !menu.hasAttribute('hidden');
  const items = menu
    ? Array.from(
        menu.querySelectorAll<HTMLLIElement>('.paidegua-pericias-autocomplete__item')
      )
    : [];

  if (ev.key === 'ArrowDown' && hasMenu && items.length > 0) {
    ev.preventDefault();
    periciasState.form.highlightAssuntos =
      (periciasState.form.highlightAssuntos + 1) % items.length;
    items.forEach((n, i) =>
      n.classList.toggle('is-active', i === periciasState.form.highlightAssuntos)
    );
    return;
  }
  if (ev.key === 'ArrowUp' && hasMenu && items.length > 0) {
    ev.preventDefault();
    periciasState.form.highlightAssuntos =
      (periciasState.form.highlightAssuntos - 1 + items.length) % items.length;
    items.forEach((n, i) =>
      n.classList.toggle('is-active', i === periciasState.form.highlightAssuntos)
    );
    return;
  }
  if (ev.key === 'Escape' && hasMenu) {
    ev.preventDefault();
    hideAssuntosSugestoes();
    return;
  }
  if (ev.key === 'Enter' || ev.key === ',') {
    ev.preventDefault();
    if (hasMenu && items.length > 0) {
      const alvo = items[periciasState.form.highlightAssuntos];
      if (alvo) {
        alvo.dispatchEvent(new MouseEvent('mousedown'));
        return;
      }
    }
    const input = $<HTMLInputElement>('per-assuntos-input');
    const texto = input.value.trim().replace(/,$/, '').trim();
    if (texto) adicionarAssuntoEscolhido(texto);
  }
}

async function salvarPericia(): Promise<void> {
  const nomeCompleto = $<HTMLInputElement>('per-nome-completo').value.trim();
  const nomeEtiquetaPauta = $<HTMLInputElement>('per-nome-etiqueta').value.trim();
  const genero = $<HTMLSelectElement>('per-genero').value as PericiaGenero;
  const profissaoRaw = $<HTMLSelectElement>('per-profissao').value;
  const profissao: PericiaProfissao =
    profissaoRaw === 'ASSISTENTE_SOCIAL' ||
    profissaoRaw === 'ENGENHEIRO' ||
    profissaoRaw === 'GRAFOTECNICO'
      ? profissaoRaw
      : 'MEDICO';
  const quantidadeRaw = parseInt(
    $<HTMLInputElement>('per-quantidade').value,
    10
  );
  const quantidadePadrao =
    Number.isFinite(quantidadeRaw) && quantidadeRaw > 0
      ? Math.min(quantidadeRaw, 500)
      : 20;
  const ativo = $<HTMLInputElement>('per-ativo').checked;
  const telefoneRaw = $<HTMLInputElement>('per-telefone').value.trim();
  const telefone = telefoneRaw ? telefoneRaw : undefined;
  const emailRaw = $<HTMLInputElement>('per-email').value.trim();
  const email = emailRaw ? emailRaw : undefined;
  const etiquetas = [...periciasState.form.etiquetas];
  const assuntos = [...periciasState.form.assuntos];

  if (!nomeCompleto) {
    setPericiasStatus('Informe o nome completo do perito.', 'error');
    $<HTMLInputElement>('per-nome-completo').focus();
    return;
  }
  if (!nomeEtiquetaPauta) {
    setPericiasStatus(
      'Informe o nome que comporá a etiqueta da pauta.',
      'error'
    );
    $<HTMLInputElement>('per-nome-etiqueta').focus();
    return;
  }
  if (etiquetas.length === 0) {
    mostrarAvisoEtiquetas(
      'Vincule ao menos uma etiqueta do catálogo — é obrigatório para gerar pauta.'
    );
    setPericiasStatus('Vincule ao menos uma etiqueta.', 'error');
    return;
  }

  const input: PericiaPeritoInput = {
    nomeCompleto,
    nomeEtiquetaPauta,
    genero,
    profissao,
    etiquetas,
    assuntos,
    quantidadePadrao,
    telefone,
    email,
    ativo
  };

  try {
    if (periciasState.editingId) {
      const atualizado = await updatePerito(periciasState.editingId, input);
      if (!atualizado) {
        setPericiasStatus('Perito não encontrado para atualização.', 'error');
        return;
      }
      const idx = periciasState.peritos.findIndex(
        (p) => p.id === periciasState.editingId
      );
      if (idx >= 0) periciasState.peritos[idx] = atualizado;
    } else {
      const criado = await addPerito(input);
      periciasState.peritos.push(criado);
    }
    setPericiasStatus('Cadastro salvo.', 'ok');
    fecharFormularioPericia();
    renderPericiasLista();
  } catch (err) {
    setPericiasStatus(
      err instanceof Error ? err.message : 'Falha ao salvar perito.',
      'error'
    );
  }
}

function bindPericiasEvents(): void {
  document
    .getElementById('btn-pericias-novo')
    ?.addEventListener('click', () => abrirFormularioPericia(null));
  document
    .getElementById('btn-pericias-salvar')
    ?.addEventListener('click', () => void salvarPericia());
  document
    .getElementById('btn-pericias-cancelar')
    ?.addEventListener('click', () => fecharFormularioPericia());

  const inputEtq = document.getElementById('per-etiquetas-input') as HTMLInputElement | null;
  inputEtq?.addEventListener('input', () => {
    periciasState.form.highlight = 0;
    void atualizarSugestoesEtiquetas();
  });
  inputEtq?.addEventListener('focus', () => {
    if (inputEtq.value.trim()) void atualizarSugestoesEtiquetas();
  });
  inputEtq?.addEventListener('keydown', handleEtiquetasInputKeydown);
  inputEtq?.addEventListener('blur', () => {
    // Fecha o menu com leve atraso para permitir clique nas sugestões.
    window.setTimeout(() => hideEtiquetasSugestoes(), 120);
  });

  const inputAssuntos = document.getElementById(
    'per-assuntos-input'
  ) as HTMLInputElement | null;
  inputAssuntos?.addEventListener('input', () => {
    periciasState.form.highlightAssuntos = 0;
    atualizarSugestoesAssuntos();
  });
  inputAssuntos?.addEventListener('focus', () => {
    atualizarSugestoesAssuntos();
  });
  inputAssuntos?.addEventListener('keydown', handleAssuntosInputKeydown);
  inputAssuntos?.addEventListener('blur', () => {
    // Leve atraso para permitir mousedown em sugestão; depois se ainda
    // houver texto digitado, adiciona como chip livre.
    window.setTimeout(() => {
      hideAssuntosSugestoes();
      const texto = inputAssuntos.value.trim();
      if (
        texto &&
        !periciasState.form.assuntos.some(
          (a) => a.toLowerCase() === texto.toLowerCase()
        )
      ) {
        periciasState.form.assuntos.push(texto);
        renderAssuntosChips();
        inputAssuntos.value = '';
      }
    }, 150);
  });
}

// =====================================================================
// Backup de configurações — export/import
// =====================================================================

/**
 * Versão do pacote de backup. Incrementar se o shape mudar de forma
 * incompatível (ex.: renomear campos). Leitores devem validar antes
 * de mesclar no storage.
 */
const BACKUP_VERSION = 1 as const;

interface BackupPacote {
  pacote: 'paidegua-config';
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  /** Config gerais SEM api keys (nunca exportadas). */
  settings: Partial<PAIdeguaSettings>;
  /** Store completo de peritos (shape versionado internamente). */
  peritos: PericiaPeritosStore;
  /** Etiquetas marcadas como sugestionáveis (idTag). */
  etiquetasSugestionaveis: number[];
}

function setBackupStatus(
  text: string,
  kind: 'ok' | 'error' | 'info' | '' = ''
): void {
  const el = document.getElementById('backup-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'paidegua-popup__status' + (kind ? ` is-${kind}` : '');
}

function sanitizeSettingsParaExport(
  s: PAIdeguaSettings
): Partial<PAIdeguaSettings> {
  // Copia profunda tolerante para evitar arrastar referências.
  // API keys NÃO entram no pacote — ficam exclusivamente em
  // `STORAGE_KEYS.API_KEY_PREFIX` no `chrome.storage.local`.
  const { ...rest } = s;
  return JSON.parse(JSON.stringify(rest));
}

async function exportarConfig(): Promise<void> {
  setBackupStatus('Preparando backup…', 'info');
  try {
    if (!currentSettings) {
      setBackupStatus('Configurações ainda não carregadas.', 'error');
      return;
    }
    const [peritosStore, sugestionaveis] = await Promise.all([
      loadPericiasStore(),
      listSugestionaveis()
    ]);
    const pacote: BackupPacote = {
      pacote: 'paidegua-config',
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      settings: sanitizeSettingsParaExport(currentSettings),
      peritos: peritosStore,
      etiquetasSugestionaveis: sugestionaveis.map((s) => s.idTag)
    };
    const json = JSON.stringify(pacote, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date()
      .toISOString()
      .replace(/[:T]/g, '-')
      .slice(0, 16);
    a.href = url;
    a.download = `paidegua-config-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setBackupStatus(
      'Backup exportado (chaves de API NÃO foram incluídas).',
      'ok'
    );
  } catch (err) {
    console.warn(`${LOG_PREFIX} exportarConfig:`, err);
    setBackupStatus(
      err instanceof Error ? err.message : 'Falha ao exportar backup.',
      'error'
    );
  }
}

function isBackupPacote(v: unknown): v is BackupPacote {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.pacote === 'paidegua-config' &&
    typeof o.version === 'number' &&
    typeof o.exportedAt === 'string' &&
    typeof o.settings === 'object' &&
    typeof o.peritos === 'object' &&
    Array.isArray(o.etiquetasSugestionaveis)
  );
}

async function importarConfig(file: File): Promise<void> {
  setBackupStatus('Lendo arquivo…', 'info');
  try {
    const texto = await file.text();
    const parsed = JSON.parse(texto) as unknown;
    if (!isBackupPacote(parsed)) {
      setBackupStatus(
        'Arquivo inválido: não parece um backup da pAIdegua.',
        'error'
      );
      return;
    }
    if (parsed.version !== BACKUP_VERSION) {
      setBackupStatus(
        `Versão de backup não suportada (${parsed.version}). Esperado: ${BACKUP_VERSION}.`,
        'error'
      );
      return;
    }
    const confirmed = confirm(
      'Importar este backup substituirá:\n' +
        '  • Configurações gerais (exceto chaves de API);\n' +
        '  • Todos os peritos cadastrados;\n' +
        '  • A seleção de etiquetas sugestionáveis.\n\n' +
        'Deseja prosseguir?'
    );
    if (!confirmed) {
      setBackupStatus('');
      return;
    }

    // 1) Settings — grava via canal oficial (sanitizando API keys caso
    // existam no arquivo por engano, pois o shape pode ser manipulado).
    const incoming = { ...parsed.settings } as Record<string, unknown>;
    delete incoming.apiKeys;
    delete incoming.apiKeysPresence;
    const respSet = (await chrome.runtime.sendMessage({
      channel: MESSAGE_CHANNELS.SAVE_SETTINGS,
      payload: incoming
    })) as { ok: boolean; settings?: PAIdeguaSettings; error?: string };
    if (!respSet?.ok || !respSet.settings) {
      setBackupStatus(
        respSet?.error ?? 'Falha ao restaurar configurações.',
        'error'
      );
      return;
    }
    currentSettings = respSet.settings;

    // 2) Peritos — sobrescreve o store completo.
    await savePericiasStore(parsed.peritos);
    periciasState.loaded = false;

    // 3) Etiquetas sugestionáveis.
    await replaceSugestionaveis(parsed.etiquetasSugestionaveis);
    etiqState.selecionados = new Set(parsed.etiquetasSugestionaveis);
    etiqState.selecionadosOriginais = new Set(etiqState.selecionados);
    await notificarInvalidateIndex();

    // Re-renderiza para refletir as novidades.
    populateProviders();
    populateProfiles();
    $<HTMLSelectElement>('provider-select').value = currentSettings.activeProvider;
    $<HTMLSelectElement>('default-profile-select').value = currentSettings.defaultProfile;
    $<HTMLInputElement>('lgpd-accept').checked = currentSettings.lgpdAccepted;
    $<HTMLInputElement>('ocr-auto-run').checked = currentSettings.ocrAutoRun;
    $<HTMLInputElement>('ocr-max-pages').value = String(currentSettings.ocrMaxPages);
    renderPowerCard(currentSettings.extensionEnabled);
    renderForProvider(currentSettings.activeProvider);
    renderTriagemCriterios();
    await applyGrauRestrictions();

    setBackupStatus(
      `Backup importado: ${parsed.peritos.peritos.length} perito(s), ${parsed.etiquetasSugestionaveis.length} etiqueta(s) sugestionável(is). Chaves de API não são restauradas.`,
      'ok'
    );
  } catch (err) {
    console.warn(`${LOG_PREFIX} importarConfig:`, err);
    setBackupStatus(
      err instanceof Error ? err.message : 'Falha ao importar backup.',
      'error'
    );
  }
}

function bindBackupEvents(): void {
  document
    .getElementById('btn-export-config')
    ?.addEventListener('click', () => void exportarConfig());
  const fileInput = document.getElementById(
    'import-config-file'
  ) as HTMLInputElement | null;
  document
    .getElementById('btn-import-config')
    ?.addEventListener('click', () => {
      fileInput?.click();
    });
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void importarConfig(file).finally(() => {
      fileInput.value = '';
    });
  });
}
