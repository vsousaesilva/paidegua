/**
 * Toggles de UI passiva no PJe — convenção pAIdegua.
 *
 * **Critério para uma feature entrar aqui:** a feature insere algum
 * elemento visual na tela do PJe automaticamente (sem o usuário pedir).
 * Exemplo canônico: o toast "pAIdegua reconheceu esta tarefa" do FLUX-04,
 * disparado por MutationObserver quando o nome de uma tarefa conhecida
 * aparece no DOM.
 *
 * **Para futuras implementações:** toda nova feature de UI passiva no PJe
 * deve (1) adicionar um nome aqui em `UI_TOGGLE_DEFAULTS`, (2) consultar
 * `getUiToggle(name)` antes de criar DOM, e (3) ser exposta na aba
 * "Mais opções" do popup. Default sempre `true` (preserva comportamento).
 *
 * **Por que single key + objeto:** load atômico no boot, subscribe único
 * pra mudanças de qualquer toggle, e fica fácil exportar/importar todos
 * os toggles juntos no futuro.
 *
 * **Memória da convenção:** `~/.claude/.../memory/paidegua_ui_toggle_pattern.md`.
 */

import { LOG_PREFIX, STORAGE_KEYS } from './constants';

export const UI_TOGGLE_DEFAULTS = {
  /** Toast canto inferior direito quando o pAIdegua reconhece uma tarefa
   *  conhecida no DOM do PJe (FLUX-04). */
  tarefaContextualToast: true
} as const;

export type UiToggleName = keyof typeof UI_TOGGLE_DEFAULTS;

type StoredToggles = Partial<Record<UiToggleName, boolean>>;

async function readStored(): Promise<StoredToggles> {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.UI_TOGGLES);
    const raw = data[STORAGE_KEYS.UI_TOGGLES];
    return raw && typeof raw === 'object' ? (raw as StoredToggles) : {};
  } catch (err: unknown) {
    console.warn(`${LOG_PREFIX} ui-toggles: falha ao ler storage:`, err);
    return {};
  }
}

/** Lê o valor atual de um toggle, caindo no default se ausente. */
export async function getUiToggle(name: UiToggleName): Promise<boolean> {
  const stored = await readStored();
  const valor = stored[name];
  return typeof valor === 'boolean' ? valor : UI_TOGGLE_DEFAULTS[name];
}

/** Lê todos os toggles de uma vez (útil pra popup/options). */
export async function getAllUiToggles(): Promise<Record<UiToggleName, boolean>> {
  const stored = await readStored();
  const result = {} as Record<UiToggleName, boolean>;
  for (const key of Object.keys(UI_TOGGLE_DEFAULTS) as UiToggleName[]) {
    const valor = stored[key];
    result[key] = typeof valor === 'boolean' ? valor : UI_TOGGLE_DEFAULTS[key];
  }
  return result;
}

/** Persiste um toggle. */
export async function setUiToggle(name: UiToggleName, value: boolean): Promise<void> {
  const stored = await readStored();
  stored[name] = value;
  await chrome.storage.local.set({ [STORAGE_KEYS.UI_TOGGLES]: stored });
}

/**
 * Subscribe pra mudanças num toggle específico. Útil quando uma feature
 * quer reagir em runtime (ex.: remover UI já visível quando o usuário
 * desliga o toggle). Devolve função de unsubscribe.
 */
export function subscribeUiToggle(
  name: UiToggleName,
  callback: (value: boolean) => void
): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName
  ): void => {
    if (area !== 'local') return;
    const change = changes[STORAGE_KEYS.UI_TOGGLES];
    if (!change) return;
    const novo = (change.newValue ?? {}) as StoredToggles;
    const valor = novo[name];
    callback(typeof valor === 'boolean' ? valor : UI_TOGGLE_DEFAULTS[name]);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
