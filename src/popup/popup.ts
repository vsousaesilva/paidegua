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
  PROVIDER_IDS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  type ProviderId
} from '../shared/constants';
import type { PAIdeguaSettings, TestConnectionResult } from '../shared/types';

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
    $<HTMLSelectElement>('provider-select').value = currentSettings.activeProvider;
    $<HTMLInputElement>('lgpd-accept').checked = currentSettings.lgpdAccepted;
    $<HTMLInputElement>('ocr-auto-run').checked = currentSettings.ocrAutoRun;
    $<HTMLInputElement>('ocr-max-pages').value = String(currentSettings.ocrMaxPages);

    renderForProvider(currentSettings.activeProvider);
    setStatus('');
  } catch (error: unknown) {
    console.warn(`${LOG_PREFIX} popup loadAll falhou:`, error);
    setStatus('Erro ao comunicar com o service worker.', 'error');
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

function bindEvents(): void {
  $<HTMLSelectElement>('provider-select').addEventListener('change', () => {
    const provider = getActiveProvider();
    renderForProvider(provider);
    void saveProviderSelection();
  });
  $<HTMLSelectElement>('model-select').addEventListener('change', () => {
    void saveProviderSelection();
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
  bindEvents();
  void loadAll();
});
