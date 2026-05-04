/**
 * pAIdegua Kanban — Gestão de equipes (admin)
 *
 * UI para gerenciar membros das duas equipes:
 *  - 'kanban'   → quem acessa kanban.paidegua.ia.br (gestão + dev)
 *  - 'extensao' → quem é autorizado a usar a extensão pAIdegua aprovada
 *                 (Chrome/Edge), via futuro endpoint /api/auth/extension/*.
 *
 * Endpoints:
 *  GET    /api/team/members                  — lista
 *  POST   /api/team/members                  — upsert (cria ou atualiza)
 *  DELETE /api/team/members/:email           — remove
 *
 * Acesso: somente usuários com papel='admin' veem o botão e abrem este modal.
 */
(() => {
  'use strict';

  const Team = {
    apiBase: '',
    bearer: null,
    user: null,
    members: [],
    filterKanban: true,
    filterExtensao: true,
    filterInativos: false,
    search: '',
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toast(msg, kind = '') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast is-visible' + (kind ? ' is-' + kind : '');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(() => t.classList.remove('is-visible'), 3200);
  }

  async function apiCall(path, init = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {});
    if (Team.bearer) headers['Authorization'] = `Bearer ${Team.bearer}`;
    const resp = await fetch(Team.apiBase + path, Object.assign({}, init, { headers }));
    if (!resp.ok) {
      let payload = null;
      try { payload = await resp.json(); } catch (_) { /* */ }
      throw new Error(payload?.error || `HTTP ${resp.status}`);
    }
    return resp.json();
  }

  async function load() {
    try {
      const data = await apiCall('/api/team/members');
      Team.members = data.members || [];
      render();
    } catch (err) {
      toast('Falha ao listar membros: ' + err.message, 'error');
    }
  }

  function render() {
    const tbody = $('#team-tbody');
    tbody.innerHTML = '';

    const filtered = Team.members.filter((m) => {
      const equipes = Array.isArray(m.equipes) ? m.equipes : ['kanban'];
      const matchKanban = Team.filterKanban && equipes.includes('kanban');
      const matchExtensao = Team.filterExtensao && equipes.includes('extensao');
      if (!matchKanban && !matchExtensao) return false;
      if (!Team.filterInativos && m.ativo === false) return false;
      if (Team.search) {
        const blob = (m.email + ' ' + (m.nome || '')).toLowerCase();
        if (!blob.includes(Team.search.toLowerCase())) return false;
      }
      return true;
    });

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:18px">Nenhum membro com esses filtros.</td></tr>';
      return;
    }

    filtered.forEach((m) => {
      const tr = document.createElement('tr');
      const equipes = Array.isArray(m.equipes) ? m.equipes : ['kanban'];
      tr.className = m.ativo === false ? 'team__row--inativo' : '';
      tr.dataset.email = m.email;
      tr.innerHTML = `
        <td><code>${escapeHtml(m.email)}</code></td>
        <td><input type="text" data-field="nome" value="${escapeHtml(m.nome || '')}" /></td>
        <td>
          <select data-field="papel">
            <option value="membro" ${m.papel === 'membro' ? 'selected' : ''}>membro</option>
            <option value="admin" ${m.papel === 'admin' ? 'selected' : ''}>admin</option>
          </select>
        </td>
        <td><input type="checkbox" data-field="kanban" ${equipes.includes('kanban') ? 'checked' : ''} /></td>
        <td><input type="checkbox" data-field="extensao" ${equipes.includes('extensao') ? 'checked' : ''} /></td>
        <td><input type="checkbox" data-field="ativo" ${m.ativo !== false ? 'checked' : ''} /></td>
        <td class="team__row-actions">
          <button type="button" class="team__btn-save" data-action="save">Salvar</button>
          <button type="button" class="team__btn-del" data-action="del">Remover</button>
        </td>
      `;

      tr.querySelector('[data-action="save"]').addEventListener('click', () => saveRow(m.email, tr));
      tr.querySelector('[data-action="del"]').addEventListener('click', () => removeRow(m.email));

      tbody.appendChild(tr);
    });
  }

  async function saveRow(email, tr) {
    const nome = tr.querySelector('[data-field="nome"]').value.trim();
    const papel = tr.querySelector('[data-field="papel"]').value;
    const kanban = tr.querySelector('[data-field="kanban"]').checked;
    const extensao = tr.querySelector('[data-field="extensao"]').checked;
    const ativo = tr.querySelector('[data-field="ativo"]').checked;
    const equipes = [];
    if (kanban) equipes.push('kanban');
    if (extensao) equipes.push('extensao');
    if (!equipes.length) {
      toast('Marque ao menos uma equipe.', 'error');
      return;
    }
    try {
      await apiCall('/api/team/members', {
        method: 'POST',
        body: JSON.stringify({ email, nome, papel, equipes, ativo }),
      });
      toast(`Membro ${email} atualizado.`, 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeRow(email) {
    if (!confirm(`Remover ${email} da equipe? Quem está logado continua válido até o token expirar.`)) return;
    try {
      await apiCall(`/api/team/members/${encodeURIComponent(email)}`, { method: 'DELETE' });
      toast(`${email} removido.`, 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function addNew() {
    const email = $('#team-new-email').value.trim().toLowerCase();
    const nome = $('#team-new-nome').value.trim();
    const papel = $('#team-new-papel').value;
    const kanban = $('#team-new-kanban').checked;
    const extensao = $('#team-new-extensao').checked;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('E-mail inválido.', 'error'); return; }
    const equipes = [];
    if (kanban) equipes.push('kanban');
    if (extensao) equipes.push('extensao');
    if (!equipes.length) { toast('Marque ao menos uma equipe.', 'error'); return; }
    try {
      await apiCall('/api/team/members', {
        method: 'POST',
        body: JSON.stringify({ email, nome, papel, equipes, ativo: true }),
      });
      toast(`Membro ${email} adicionado.`, 'success');
      $('#team-new-email').value = '';
      $('#team-new-nome').value = '';
      $('#team-new-papel').value = 'membro';
      $('#team-new-kanban').checked = true;
      $('#team-new-extensao').checked = false;
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function open({ apiBase, bearer, user }) {
    Team.apiBase = apiBase || '';
    Team.bearer = bearer || null;
    Team.user = user || 'anonimo';
    $('#team').hidden = false;
    document.body.style.overflow = 'hidden';
    load();
  }

  function close() {
    $('#team').hidden = true;
    document.body.style.overflow = '';
  }

  function bind() {
    $$('#team [data-team-close]').forEach((el) => el.addEventListener('click', close));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#team').hidden) close();
    });
    $('#team-filter-kanban').addEventListener('change', (e) => { Team.filterKanban = e.target.checked; render(); });
    $('#team-filter-extensao').addEventListener('change', (e) => { Team.filterExtensao = e.target.checked; render(); });
    $('#team-filter-inativos').addEventListener('change', (e) => { Team.filterInativos = e.target.checked; render(); });
    $('#team-search').addEventListener('input', (e) => { Team.search = e.target.value; render(); });
    $('#team-new-add').addEventListener('click', addNew);
  }

  bind();
  window.PaideguaTeam = { open, close };
})();
