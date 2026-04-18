/**
 * Modal de seleção múltipla de tarefas para o perfil Gestão.
 *
 * Renderizado em shadow-DOM próprio no top frame (isola os estilos do
 * PJe). Mostra checkboxes com nome e quantidade por tarefa, botões
 * "Selecionar todas" e "Limpar", e um rodapé com Cancelar/Confirmar.
 *
 * A persistência da seleção (para reabrir já marcando o que o usuário
 * escolheu da última vez) fica a cargo do chamador via
 * `STORAGE_KEYS.GESTAO_TAREFAS_SELECIONADAS`.
 */

import type { GestaoTarefaInfo } from '../../shared/types';

interface PickerOptions {
  tarefas: GestaoTarefaInfo[];
  preSelecionadas: string[];
}

export function mostrarSeletorTarefas(opts: PickerOptions): Promise<string[] | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.id = 'paidegua-gestao-picker-host';
    host.style.cssText = 'all: initial;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing: border-box; font-family: Segoe UI, Arial, sans-serif; }
      .backdrop {
        position: fixed; inset: 0; z-index: 2147483646;
        background: rgba(15, 23, 42, 0.55);
        display: flex; align-items: center; justify-content: center;
      }
      .modal {
        background: #fff; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        width: min(560px, 92vw); max-height: 82vh; display: flex; flex-direction: column;
        overflow: hidden;
      }
      header {
        padding: 14px 18px; border-bottom: 1px solid #e2e8f0;
        background: #1e3a8a; color: #fff;
      }
      header h2 { margin: 0; font-size: 16px; font-weight: 600; }
      header p { margin: 4px 0 0; font-size: 12px; opacity: 0.85; }
      .toolbar {
        padding: 10px 18px; border-bottom: 1px solid #e2e8f0;
        display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
        background: #f8fafc;
      }
      .toolbar button {
        border: 1px solid #cbd5e1; background: #fff; color: #0f172a;
        padding: 6px 12px; font-size: 12px; border-radius: 4px; cursor: pointer;
      }
      .toolbar button:hover { background: #f1f5f9; }
      .count { margin-left: auto; font-size: 12px; color: #475569; }
      .lista {
        padding: 8px 10px; overflow-y: auto; flex: 1 1 auto;
      }
      .item {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 10px; border-radius: 4px;
      }
      .item:hover { background: #f1f5f9; }
      .item label {
        flex: 1 1 auto; font-size: 13px; cursor: pointer;
        display: flex; justify-content: space-between; gap: 10px;
      }
      .item .qtd { color: #64748b; font-variant-numeric: tabular-nums; }
      .vazio { padding: 24px; text-align: center; color: #64748b; font-size: 13px; }
      footer {
        padding: 12px 18px; border-top: 1px solid #e2e8f0;
        display: flex; gap: 10px; justify-content: flex-end;
        background: #f8fafc;
      }
      footer button {
        padding: 8px 16px; font-size: 13px; border-radius: 4px;
        border: 1px solid #cbd5e1; background: #fff; color: #0f172a;
        cursor: pointer;
      }
      footer button.primary {
        background: #1e3a8a; color: #fff; border-color: #1e3a8a;
      }
      footer button.primary:disabled {
        background: #94a3b8; border-color: #94a3b8; cursor: not-allowed;
      }
    `;
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal';

    const header = document.createElement('header');
    header.innerHTML = `
      <h2>Selecionar tarefas para o Painel Gerencial</h2>
      <p>Marque as tarefas cujos processos devem entrar no dashboard. Você pode refinar depois.</p>
    `;

    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    const btnTodos = document.createElement('button');
    btnTodos.textContent = 'Selecionar todas';
    const btnNenhum = document.createElement('button');
    btnNenhum.textContent = 'Limpar';
    const contador = document.createElement('span');
    contador.className = 'count';
    toolbar.append(btnTodos, btnNenhum, contador);

    const lista = document.createElement('div');
    lista.className = 'lista';

    const pre = new Set(opts.preSelecionadas);
    const checkboxes: HTMLInputElement[] = [];

    if (opts.tarefas.length === 0) {
      const vazio = document.createElement('div');
      vazio.className = 'vazio';
      vazio.textContent =
        'Nenhuma tarefa encontrada no painel atual. Confirme que você está no Painel do Usuário do PJe.';
      lista.appendChild(vazio);
    } else {
      for (const t of opts.tarefas) {
        const item = document.createElement('div');
        item.className = 'item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = `paidegua-tarefa-${checkboxes.length}`;
        cb.checked = pre.has(t.nome);
        checkboxes.push(cb);
        const label = document.createElement('label');
        label.htmlFor = cb.id;
        const nome = document.createElement('span');
        nome.textContent = t.nome;
        const qtd = document.createElement('span');
        qtd.className = 'qtd';
        qtd.textContent = t.quantidade === null ? '' : `(${t.quantidade})`;
        label.append(nome, qtd);
        item.append(cb, label);
        lista.appendChild(item);
        cb.addEventListener('change', atualizarContador);
      }
    }

    const footer = document.createElement('footer');
    const btnCancelar = document.createElement('button');
    btnCancelar.textContent = 'Cancelar';
    const btnConfirmar = document.createElement('button');
    btnConfirmar.className = 'primary';
    btnConfirmar.textContent = 'Confirmar seleção';
    footer.append(btnCancelar, btnConfirmar);

    modal.append(header, toolbar, lista, footer);
    backdrop.appendChild(modal);
    shadow.appendChild(backdrop);
    document.body.appendChild(host);

    function selecionadas(): string[] {
      return checkboxes
        .map((cb, i) => (cb.checked ? opts.tarefas[i]?.nome ?? '' : ''))
        .filter((s) => s.length > 0);
    }

    function atualizarContador(): void {
      const n = selecionadas().length;
      contador.textContent = `${n} selecionada${n === 1 ? '' : 's'}`;
      btnConfirmar.disabled = n === 0;
    }

    btnTodos.addEventListener('click', () => {
      for (const cb of checkboxes) cb.checked = true;
      atualizarContador();
    });
    btnNenhum.addEventListener('click', () => {
      for (const cb of checkboxes) cb.checked = false;
      atualizarContador();
    });

    function fechar(resultado: string[] | null): void {
      host.remove();
      resolve(resultado);
    }

    btnCancelar.addEventListener('click', () => fechar(null));
    btnConfirmar.addEventListener('click', () => fechar(selecionadas()));
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) fechar(null);
    });

    atualizarContador();
  });
}
