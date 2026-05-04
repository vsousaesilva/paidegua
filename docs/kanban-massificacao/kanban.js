/**
 * pAIdegua — Kanban de Massificação
 * Frontend SPA. Persistência via Cloudflare Worker (kanban.paidegua.ia.br/api/*).
 * Em modo standalone (file://), cai para localStorage.
 */
(() => {
  'use strict';

  // ===== Config =====
  // Em produção, será kanban.paidegua.ia.br; em dev local, mesmo origin.
  const API_BASE = (() => {
    if (location.protocol === 'file:') return null; // standalone -> localStorage
    if (location.hostname === 'kanban.paidegua.ia.br') return '';
    return ''; // mesma origem (Pages)
  })();

  const STORAGE_KEY_TOKEN = 'paidegua_kanban_token';
  const STORAGE_KEY_USER = 'paidegua_kanban_user';
  const STORAGE_KEY_OFFLINE = 'paidegua_kanban_offline_state';

  // ===== State =====
  const state = {
    token: localStorage.getItem(STORAGE_KEY_TOKEN) || null,
    user: localStorage.getItem(STORAGE_KEY_USER) || null,
    cards: [],
    columns: [],
    categorias: [],
    prioridades: [],
    filters: { search: '', categoria: '', prioridade: '', fase: '' },
    editingId: null,
  };

  // ===== Utils =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast is-visible' + (kind ? ' is-' + kind : '');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(() => { t.classList.remove('is-visible'); }, 3200);
  }

  function setStatus(text, kind = '') {
    const el = $('#auth-status');
    el.textContent = text;
    el.className = 'auth-gate__status' + (kind ? ' is-' + kind : '');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function whoAmI() {
    return state.user || 'anonimo';
  }

  function dateInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function dateInputToIso(value) {
    if (!value) return null;
    return new Date(value + 'T00:00:00').toISOString();
  }

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  }

  function diffDays(iso) {
    if (!iso) return null;
    const due = new Date(iso);
    if (isNaN(due.getTime())) return null;
    const now = new Date();
    const ms = due.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.floor(ms / 86400000);
  }

  function initials(email) {
    if (!email) return '?';
    const local = String(email).split('@')[0];
    const parts = local.replace(/[._-]/g, ' ').trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function recordHistory(card, evento) {
    if (!Array.isArray(card.historico)) card.historico = [];
    card.historico.push({
      id: uid(),
      tipo: evento.tipo,
      autor: evento.autor || whoAmI(),
      data: evento.data || nowIso(),
      ...evento.extras,
    });
  }

  function describeHistoryEvent(ev) {
    switch (ev.tipo) {
      case 'criado': return 'Card criado';
      case 'movido': return `Movido de "${ev.de}" para "${ev.para}"`;
      case 'editado': return `Editado: ${(ev.campos || []).join(', ')}`;
      case 'checklist-add': return `Checklist: + "${ev.texto}"`;
      case 'checklist-marcar': return `Checklist marcado: "${ev.texto}"`;
      case 'checklist-desmarcar': return `Checklist desmarcado: "${ev.texto}"`;
      case 'checklist-remover': return `Checklist: - "${ev.texto}"`;
      case 'comentario': return 'Comentário adicionado';
      case 'link-add': return `Link adicionado: ${ev.label || ev.url}`;
      case 'link-remover': return `Link removido: ${ev.label || ev.url}`;
      case 'gh-issue-criada': return `Issue GitHub criada: #${ev.numero}`;
      case 'bloqueado': return `Bloqueado: ${ev.motivo || 'sem motivo'}`;
      case 'desbloqueado': return 'Desbloqueio';
      default: return ev.tipo;
    }
  }

  async function api(path, opts = {}) {
    if (API_BASE === null) {
      throw new Error('Modo offline — usar localStorage');
    }
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const resp = await fetch(API_BASE + path, Object.assign({}, opts, { headers }));
    if (!resp.ok) {
      let payload = null;
      try { payload = await resp.json(); } catch (_) { /* ignore */ }
      const err = new Error(payload?.error || resp.statusText || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.payload = payload;
      throw err;
    }
    return resp.json();
  }

  // ===== Auth =====
  async function requestOtp() {
    const email = ($('#auth-email').value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus('E-mail inválido.', 'error'); return;
    }
    setStatus('Enviando código…', 'info');
    try {
      if (API_BASE === null) {
        // standalone: aceita qualquer e-mail e usa código fixo "000000"
        await new Promise((r) => setTimeout(r, 350));
        state._pendingEmail = email;
        $('#stage-email').hidden = true;
        $('#stage-otp').hidden = false;
        $('#email-display').textContent = email;
        $('#auth-otp').focus();
        setStatus('Modo offline (file://): use o código 000000.', 'info');
        return;
      }
      await api('/api/auth/request-otp', { method: 'POST', body: JSON.stringify({ email }) });
      state._pendingEmail = email;
      $('#stage-email').hidden = true;
      $('#stage-otp').hidden = false;
      $('#email-display').textContent = email;
      $('#auth-otp').focus();
      setStatus('Código enviado. Verifique sua caixa institucional.', 'ok');
    } catch (err) {
      setStatus(err.message || 'Falha ao enviar código.', 'error');
    }
  }

  async function verifyOtp() {
    const code = ($('#auth-otp').value || '').trim();
    if (!/^\d{6}$/.test(code)) {
      setStatus('Código deve ter 6 dígitos.', 'error'); return;
    }
    setStatus('Validando…', 'info');
    try {
      if (API_BASE === null) {
        if (code !== '000000') {
          setStatus('Em modo offline use 000000.', 'error'); return;
        }
        state.token = 'offline-token';
        state.user = state._pendingEmail;
        localStorage.setItem(STORAGE_KEY_TOKEN, state.token);
        localStorage.setItem(STORAGE_KEY_USER, state.user);
        afterLogin();
        return;
      }
      const result = await api('/api/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email: state._pendingEmail, code }),
      });
      state.token = result.token;
      state.user = result.email;
      localStorage.setItem(STORAGE_KEY_TOKEN, state.token);
      localStorage.setItem(STORAGE_KEY_USER, state.user);
      afterLogin();
    } catch (err) {
      setStatus(err.message || 'Código inválido.', 'error');
    }
  }

  function logout() {
    state.token = null;
    state.user = null;
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_USER);
    location.reload();
  }

  function afterLogin() {
    $('#auth-gate').hidden = true;
    $('#toolbar').hidden = false;
    $('#board').hidden = false;
    $('#btn-logout').hidden = false;
    $('#btn-vault').hidden = false;
    $('#btn-docs').hidden = false;
    $('#header-user').hidden = false;
    $('#header-user').textContent = state.user;
    bootstrap();
    detectAdmin();
  }

  async function detectAdmin() {
    if (API_BASE === null) {
      // Modo offline: assume admin pra permitir explorar
      $('#btn-team').hidden = false;
      state.isAdmin = true;
      return;
    }
    try {
      const me = await api('/api/auth/me');
      state.isAdmin = !!me.isAdmin;
      state.equipes = me.equipes || ['kanban'];
      state.papel = me.papel || 'membro';
      $('#btn-team').hidden = !me.isAdmin;
    } catch (err) {
      // mantém botão escondido em caso de falha
    }
  }

  function openVault() {
    if (!window.PaideguaVault) {
      toast('Módulo do cofre não carregou.', 'error');
      return;
    }
    window.PaideguaVault.open({
      apiBase: API_BASE,
      isOnline: API_BASE !== null,
      bearer: state.token,
      user: state.user,
    });
  }

  function openDocs() {
    if (!window.PaideguaDocs) {
      toast('Módulo de documentos não carregou.', 'error');
      return;
    }
    window.PaideguaDocs.open({
      apiBase: API_BASE,
      isOnline: API_BASE !== null,
      bearer: state.token,
      user: state.user,
    });
  }

  function openTeam() {
    if (!window.PaideguaTeam) {
      toast('Módulo de equipe não carregou.', 'error');
      return;
    }
    if (API_BASE === null) {
      toast('Gestão de equipes só funciona em modo deploy (paidegua.ia.br).', '');
      return;
    }
    window.PaideguaTeam.open({
      apiBase: API_BASE,
      bearer: state.token,
      user: state.user,
    });
  }

  // ===== Bootstrap =====
  async function bootstrap() {
    try {
      let data;
      if (API_BASE === null) {
        const offline = localStorage.getItem(STORAGE_KEY_OFFLINE);
        if (offline) {
          try {
            data = JSON.parse(offline);
            // Se o storage tem um quadro vazio (bug anterior), recarrega do seed.
            if (!data || !Array.isArray(data.cards) || data.cards.length === 0) {
              data = null;
            }
          } catch (_) {
            data = null;
          }
        }
        if (!data) {
          if (window.__PAIDEGUA_SEED__) {
            data = JSON.parse(JSON.stringify(window.__PAIDEGUA_SEED__));
          } else {
            try {
              data = await fetch('seed.json').then((r) => r.json());
            } catch (err) {
              throw new Error('Não consegui carregar seed.json (CORS em file://). Use um servidor local ou abra com seed.js já presente.');
            }
          }
          localStorage.setItem(STORAGE_KEY_OFFLINE, JSON.stringify(data));
        }
      } else {
        data = await api('/api/board');
        // Primeiro acesso a um KV vazio: faz seed automático
        if (!data.cards || data.cards.length === 0) {
          if (window.__PAIDEGUA_SEED__) {
            const seed = JSON.parse(JSON.stringify(window.__PAIDEGUA_SEED__));
            await api('/api/board/replace', { method: 'POST', body: JSON.stringify(seed) });
            data = await api('/api/board');
          }
        }
      }
      state.cards = data.cards || [];
      state.columns = data.colunas || data.columns || [];
      state.categorias = data.categorias || [];
      state.prioridades = data.prioridades || [];
      populateFilters();
      render();
    } catch (err) {
      toast('Falha ao carregar quadro: ' + err.message, 'error');
    }
  }

  function populateFilters() {
    const cat = $('#filter-categoria');
    cat.innerHTML = '<option value="">Todas as categorias</option>' +
      state.categorias.map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join('');

    const prio = $('#filter-prioridade');
    prio.innerHTML = '<option value="">Todas as prioridades</option>' +
      state.prioridades.map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');

    const fases = Array.from(new Set(state.cards.map((c) => c.fase).filter(Boolean))).sort();
    const fase = $('#filter-fase');
    fase.innerHTML = '<option value="">Todas as fases</option>' +
      fases.map((f) => `<option value="${f}">${escapeHtml(f)}</option>`).join('');

    const mCat = $('#m-categoria');
    mCat.innerHTML = state.categorias.map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join('');
    const mPrio = $('#m-prioridade');
    mPrio.innerHTML = state.prioridades.map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}</option>`).join('');
    const mCol = $('#m-coluna');
    mCol.innerHTML = state.columns.map((c) => `<option value="${c.id}">${escapeHtml(c.titulo)}</option>`).join('');
  }

  // ===== Render =====
  function passesFilter(card) {
    const f = state.filters;
    if (f.categoria && card.categoria !== f.categoria) return false;
    if (f.prioridade && card.prioridade !== f.prioridade) return false;
    if (f.fase && card.fase !== f.fase) return false;
    if (f.search) {
      const blob = (card.id + ' ' + card.titulo + ' ' + (card.descricao || '') + ' ' + (card.tags || []).join(' ')).toLowerCase();
      if (!blob.includes(f.search.toLowerCase())) return false;
    }
    return true;
  }

  function render() {
    const board = $('#board');
    board.innerHTML = '';
    const filtered = state.cards.filter(passesFilter);

    state.columns
      .slice()
      .sort((a, b) => (a.ordem || 0) - (b.ordem || 0))
      .forEach((col) => {
        const cards = filtered.filter((c) => c.coluna === col.id);
        const colEl = document.createElement('section');
        colEl.className = 'column column--' + col.id;
        colEl.dataset.colId = col.id;
        colEl.innerHTML = `
          <div class="column__sticky">
            <div class="column__header">
              <h2 class="column__title">${escapeHtml(col.titulo)}</h2>
              <span class="column__count">${cards.length}</span>
            </div>
            ${col.descricao ? `<p class="column__desc">${escapeHtml(col.descricao)}</p>` : ''}
          </div>
          <div class="column__list" data-col-id="${col.id}"></div>
        `;
        const list = colEl.querySelector('.column__list');
        cards
          .slice()
          .sort((a, b) => (a.prioridade || 'P9').localeCompare(b.prioridade || 'P9'))
          .forEach((card) => list.appendChild(renderCard(card)));
        attachDropZone(list);
        board.appendChild(colEl);
      });

    updateStats(filtered);
  }

  function renderCard(card) {
    const el = document.createElement('article');
    el.className = 'card';
    el.dataset.id = card.id;
    el.dataset.prioridade = card.prioridade;
    el.draggable = true;

    const cat = state.categorias.find((c) => c.id === card.categoria);
    const catColor = cat?.cor || 'var(--primary)';
    const catName = cat?.nome || card.categoria || '';

    const checklist = card.checklist || [];
    const total = checklist.length;
    const feitos = checklist.filter((c) => c.feito).length;
    const pct = total ? Math.round((feitos / total) * 100) : 0;

    const allAssignees = [card.owner, ...(card.assignees || [])].filter(Boolean);
    const uniqueAssignees = Array.from(new Set(allAssignees));
    const visibleAssignees = uniqueAssignees.slice(0, 3);
    const moreAssignees = uniqueAssignees.length - visibleAssignees.length;

    let dateChip = '';
    const dueDays = diffDays(card.dataPrevista);
    if (dueDays !== null && card.coluna !== 'lancado' && card.coluna !== 'arquivado') {
      let kind = 'ok';
      let label = `vence ${shortDate(card.dataPrevista)}`;
      if (dueDays < 0) { kind = 'vencido'; label = `vencido há ${-dueDays}d`; }
      else if (dueDays <= 7) { kind = 'proximo'; label = `vence em ${dueDays}d`; }
      dateChip = `<span class="card__date card__date--${kind}" title="${shortDate(card.dataPrevista)}">⏱ ${label}</span>`;
    } else if (card.dataConclusao && card.coluna === 'lancado') {
      dateChip = `<span class="card__date card__date--ok" title="Concluído em ${shortDate(card.dataConclusao)}">✓ ${shortDate(card.dataConclusao)}</span>`;
    }

    const counters = [];
    if (total) counters.push(`<span class="card__counter" title="checklist">☑ ${feitos}/${total}</span>`);
    if ((card.comentarios || []).length) counters.push(`<span class="card__counter" title="comentários">💬 ${card.comentarios.length}</span>`);
    if ((card.links || []).length) counters.push(`<span class="card__counter" title="links">🔗 ${card.links.length}</span>`);
    if (card.issueGithub) counters.push(`<a class="card__issue" href="${escapeHtml(card.issueGithub.url)}" target="_blank" rel="noopener" title="Issue ${card.issueGithub.repo}#${card.issueGithub.number}" onclick="event.stopPropagation()">#${card.issueGithub.number}</a>`);

    el.innerHTML = `
      <div class="card__top">
        <span class="card__id">${escapeHtml(card.id)}</span>
        <span class="card__prio card__prio--${card.prioridade}">${card.prioridade}</span>
      </div>
      <h3 class="card__titulo">${escapeHtml(card.titulo)}</h3>
      <div class="card__meta">
        <span class="card__chip card__chip--cat" style="background:${catColor}">${escapeHtml(catName)}</span>
        ${card.fase ? `<span class="card__chip card__chip--fase">${escapeHtml(card.fase)}</span>` : ''}
        ${card.esforco ? `<span class="card__chip card__chip--esforco">${escapeHtml(card.esforco)}</span>` : ''}
        ${(card.tags || []).slice(0, 2).map((t) => `<span class="card__chip">${escapeHtml(t)}</span>`).join('')}
        ${dateChip}
      </div>
      ${total ? `<div class="card__progress" title="${pct}% concluído"><span style="width:${pct}%"></span></div>` : ''}
      ${(card.depende && card.depende.length) ? `<div class="card__deps">↳ depende de ${card.depende.map(escapeHtml).join(', ')}</div>` : ''}
      <div class="card__footer">
        <span class="card__assignees">
          ${visibleAssignees.map((a) => `<span class="card__avatar" title="${escapeHtml(a)}">${escapeHtml(initials(a))}</span>`).join('')}
          ${moreAssignees > 0 ? `<span class="card__avatar card__avatar--more" title="+${moreAssignees}">+${moreAssignees}</span>` : ''}
        </span>
        <span class="card__counters">${counters.join('')}</span>
      </div>
    `;

    el.addEventListener('click', () => openModal(card.id));
    el.addEventListener('dragstart', (e) => {
      el.classList.add('is-dragging');
      e.dataTransfer.setData('text/plain', card.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
    return el;
  }

  function attachDropZone(list) {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.classList.add('is-drop-target');
    });
    list.addEventListener('dragleave', () => list.classList.remove('is-drop-target'));
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      list.classList.remove('is-drop-target');
      const id = e.dataTransfer.getData('text/plain');
      const newCol = list.dataset.colId;
      const card = state.cards.find((c) => c.id === id);
      if (!card || card.coluna === newCol) return;
      const colunaAnterior = card.coluna;
      card.coluna = newCol;
      card.atualizadoEm = nowIso();
      card.atualizadoPor = whoAmI();
      recordHistory(card, { tipo: 'movido', extras: { de: colunaAnterior, para: newCol } });
      if (newCol === 'dev' && !card.dataInicio) card.dataInicio = nowIso();
      if (newCol === 'lancado' && !card.dataConclusao) card.dataConclusao = nowIso();
      await persistCard(card);
      render();
      toast(`${id} movido para "${state.columns.find((c) => c.id === newCol)?.titulo}"`, 'success');
    });
  }

  function updateStats(filtered) {
    const total = state.cards.length;
    const visiveis = filtered.length;
    const p0 = state.cards.filter((c) => c.prioridade === 'P0').length;
    const lancado = state.cards.filter((c) => c.coluna === 'lancado').length;
    const blocked = state.cards.filter((c) => c.coluna === 'bloqueado').length;
    $('#toolbar-stats').innerHTML = `
      <span class="toolbar__stat"><strong>${visiveis}/${total}</strong> visíveis</span>
      <span class="toolbar__stat"><strong>${p0}</strong> P0</span>
      <span class="toolbar__stat"><strong>${lancado}</strong> lançados</span>
      <span class="toolbar__stat"><strong>${blocked}</strong> bloqueados</span>
    `;
  }

  // ===== Persistência =====
  async function persistCard(card) {
    if (API_BASE === null) {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_OFFLINE) || '{}');
      stored.cards = state.cards;
      localStorage.setItem(STORAGE_KEY_OFFLINE, JSON.stringify(stored));
      return;
    }
    try {
      await api(`/api/cards/${encodeURIComponent(card.id)}`, {
        method: 'PUT',
        body: JSON.stringify(card),
      });
    } catch (err) {
      toast('Falha ao salvar: ' + err.message, 'error');
    }
  }

  async function deleteCard(id) {
    state.cards = state.cards.filter((c) => c.id !== id);
    if (API_BASE === null) {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_OFFLINE) || '{}');
      stored.cards = state.cards;
      localStorage.setItem(STORAGE_KEY_OFFLINE, JSON.stringify(stored));
    } else {
      try {
        await api(`/api/cards/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        toast('Falha ao excluir: ' + err.message, 'error');
      }
    }
    render();
  }

  // ===== Modal =====
  function openModal(id) {
    const card = id ? state.cards.find((c) => c.id === id) : null;
    state.editingId = id;
    state.editingDraft = card
      ? JSON.parse(JSON.stringify(card))
      : {
          id: generateId(),
          titulo: '',
          categoria: state.categorias[0]?.id || '',
          prioridade: 'P2',
          coluna: 'triagem',
          esforco: '',
          fase: '',
          origem: '',
          descricao: '',
          tags: [],
          aceitacao: [],
          depende: [],
          owner: whoAmI(),
          assignees: [],
          dataCriacao: nowIso(),
          dataInicio: null,
          dataPrevista: null,
          dataConclusao: null,
          checklist: [],
          comentarios: [],
          links: [],
          historico: [],
          bloqueadoPor: null,
          issueGithub: null,
        };

    const draft = state.editingDraft;
    $('#modal-title').textContent = card ? `Editar ${card.id}` : 'Novo card';
    $('#m-id').value = draft.id;
    $('#m-titulo').value = draft.titulo || '';
    $('#m-categoria').value = draft.categoria || (state.categorias[0]?.id || '');
    $('#m-prioridade').value = draft.prioridade || 'P2';
    $('#m-coluna').value = draft.coluna || 'triagem';
    $('#m-esforco').value = draft.esforco || '';
    $('#m-fase').value = draft.fase || '';
    $('#m-origem').value = draft.origem || '';
    $('#m-descricao').value = draft.descricao || '';
    $('#m-tags').value = (draft.tags || []).join(', ');
    $('#m-aceitacao').value = (draft.aceitacao || []).join('\n');
    $('#m-depende').value = (draft.depende || []).join(', ');
    $('#m-owner').value = draft.owner || '';
    $('#m-assignees').value = (draft.assignees || []).join(', ');
    $('#m-data-criacao').value = dateInputValue(draft.dataCriacao);
    $('#m-data-inicio').value = dateInputValue(draft.dataInicio);
    $('#m-data-prevista').value = dateInputValue(draft.dataPrevista);
    $('#m-data-conclusao').value = dateInputValue(draft.dataConclusao);
    $('#m-bloqueado-por').value = draft.bloqueadoPor || '';

    renderChecklist();
    renderLinks();
    renderComments();
    renderHistory();
    renderIssue();
    syncBloqueioVisibility();

    $('#m-delete').hidden = !card;
    $('#modal').hidden = false;
    setTimeout(() => $('#m-titulo').focus(), 50);
  }

  function closeModal() {
    $('#modal').hidden = true;
    state.editingId = null;
    state.editingDraft = null;
  }

  function generateId() {
    return 'NEW-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  function syncBloqueioVisibility() {
    $('#m-bloqueio-group').hidden = $('#m-coluna').value !== 'bloqueado';
  }

  function renderChecklist() {
    const container = $('#m-checklist');
    const items = state.editingDraft?.checklist || [];
    const total = items.length;
    const feitos = items.filter((i) => i.feito).length;
    const pct = total ? Math.round((feitos / total) * 100) : 0;
    $('#m-progress').textContent = total ? `${feitos}/${total} (${pct}%)` : '';

    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<p class="modal__hint">Nenhum item ainda. Adicione abaixo.</p>';
      return;
    }
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'checklist__item' + (it.feito ? ' is-done' : '');
      row.innerHTML = `
        <input type="checkbox" class="checklist__check" ${it.feito ? 'checked' : ''} aria-label="Concluído" />
        <span class="checklist__text" contenteditable="true" spellcheck="false">${escapeHtml(it.texto)}</span>
        <button type="button" class="checklist__remove" aria-label="Remover">×</button>
      `;
      row.querySelector('.checklist__check').addEventListener('change', (e) => {
        it.feito = e.target.checked;
        it.feitoPor = e.target.checked ? whoAmI() : null;
        it.feitoEm = e.target.checked ? nowIso() : null;
        recordHistory(state.editingDraft, {
          tipo: e.target.checked ? 'checklist-marcar' : 'checklist-desmarcar',
          extras: { texto: it.texto, itemId: it.id },
        });
        renderChecklist();
        renderHistory();
      });
      row.querySelector('.checklist__text').addEventListener('blur', (e) => {
        const novo = e.target.textContent.trim();
        if (novo && novo !== it.texto) it.texto = novo;
      });
      row.querySelector('.checklist__remove').addEventListener('click', () => {
        const idx = state.editingDraft.checklist.findIndex((i) => i.id === it.id);
        if (idx >= 0) {
          recordHistory(state.editingDraft, { tipo: 'checklist-remover', extras: { texto: it.texto, itemId: it.id } });
          state.editingDraft.checklist.splice(idx, 1);
          renderChecklist();
          renderHistory();
        }
      });
      container.appendChild(row);
    });
  }

  function addChecklistItem() {
    const input = $('#m-checklist-novo');
    const texto = input.value.trim();
    if (!texto) return;
    if (!state.editingDraft.checklist) state.editingDraft.checklist = [];
    const item = { id: uid(), texto, feito: false, feitoPor: null, feitoEm: null };
    state.editingDraft.checklist.push(item);
    recordHistory(state.editingDraft, { tipo: 'checklist-add', extras: { texto, itemId: item.id } });
    input.value = '';
    renderChecklist();
    renderHistory();
    input.focus();
  }

  function renderLinks() {
    const container = $('#m-links');
    const items = state.editingDraft?.links || [];
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<p class="modal__hint">Nenhum link. Adicione abaixo (PRs, ADRs, mockups, etc.).</p>';
      return;
    }
    items.forEach((lk) => {
      const row = document.createElement('div');
      row.className = 'link__item';
      row.innerHTML = `
        <a href="${escapeHtml(lk.url)}" target="_blank" rel="noopener">${escapeHtml(lk.label || lk.url)}</a>
        <button type="button" class="link__remove" aria-label="Remover">×</button>
      `;
      row.querySelector('.link__remove').addEventListener('click', () => {
        const idx = state.editingDraft.links.findIndex((l) => l.id === lk.id);
        if (idx >= 0) {
          recordHistory(state.editingDraft, { tipo: 'link-remover', extras: { label: lk.label, url: lk.url } });
          state.editingDraft.links.splice(idx, 1);
          renderLinks();
          renderHistory();
        }
      });
      container.appendChild(row);
    });
  }

  function addLink() {
    const label = $('#m-link-label').value.trim();
    const url = $('#m-link-url').value.trim();
    if (!url) { toast('URL é obrigatória.', 'error'); return; }
    if (!state.editingDraft.links) state.editingDraft.links = [];
    const link = { id: uid(), label: label || url, url };
    state.editingDraft.links.push(link);
    recordHistory(state.editingDraft, { tipo: 'link-add', extras: { label, url } });
    $('#m-link-label').value = '';
    $('#m-link-url').value = '';
    renderLinks();
    renderHistory();
  }

  function renderComments() {
    const container = $('#m-comments');
    const items = state.editingDraft?.comentarios || [];
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<p class="modal__hint">Sem comentários ainda.</p>';
      return;
    }
    items
      .slice()
      .sort((a, b) => new Date(b.data) - new Date(a.data))
      .forEach((c) => {
        const row = document.createElement('div');
        row.className = 'comment__item';
        row.innerHTML = `
          <div class="comment__head">
            <span class="comment__autor">${escapeHtml(c.autor)}</span>
            <span>${shortDate(c.data)}</span>
          </div>
          <div class="comment__text">${escapeHtml(c.texto)}</div>
        `;
        container.appendChild(row);
      });
  }

  function addComment() {
    const ta = $('#m-comment-novo');
    const texto = ta.value.trim();
    if (!texto) return;
    if (!state.editingDraft.comentarios) state.editingDraft.comentarios = [];
    state.editingDraft.comentarios.push({
      id: uid(),
      autor: whoAmI(),
      texto,
      data: nowIso(),
    });
    recordHistory(state.editingDraft, { tipo: 'comentario' });
    ta.value = '';
    renderComments();
    renderHistory();
  }

  function renderHistory() {
    const container = $('#m-history');
    const items = state.editingDraft?.historico || [];
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<li class="modal__hint">Sem eventos.</li>';
      return;
    }
    items
      .slice()
      .sort((a, b) => new Date(b.data) - new Date(a.data))
      .slice(0, 50)
      .forEach((ev) => {
        const li = document.createElement('li');
        li.innerHTML = `
          ${escapeHtml(describeHistoryEvent(ev))}
          <span class="history__data">por <span class="history__autor">${escapeHtml(ev.autor)}</span> · ${shortDate(ev.data)}</span>
        `;
        container.appendChild(li);
      });
  }

  function renderIssue() {
    const issue = state.editingDraft?.issueGithub;
    const el = $('#m-issue-info');
    if (issue) {
      el.innerHTML = `Issue <a href="${escapeHtml(issue.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(issue.repo)}#${issue.number}</strong></a> criada automaticamente.`;
    } else {
      el.innerHTML = 'Sem issue criada. A issue é criada automaticamente quando o card entra em <code>Desenvolvimento</code> (modo deploy).';
    }
  }

  async function saveModal() {
    const draft = state.editingDraft;
    if (!draft) return;

    // Aplica valores dos campos top-level
    draft.id = $('#m-id').value.trim();
    draft.titulo = $('#m-titulo').value.trim();
    draft.categoria = $('#m-categoria').value;
    draft.prioridade = $('#m-prioridade').value;
    const colunaAnterior = state.cards.find((c) => c.id === state.editingId)?.coluna;
    const novaColuna = $('#m-coluna').value;
    draft.coluna = novaColuna;
    draft.esforco = $('#m-esforco').value || null;
    draft.fase = $('#m-fase').value.trim() || null;
    draft.origem = $('#m-origem').value.trim() || null;
    draft.descricao = $('#m-descricao').value.trim();
    draft.tags = $('#m-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
    draft.aceitacao = $('#m-aceitacao').value.split('\n').map((s) => s.trim()).filter(Boolean);
    draft.depende = $('#m-depende').value.split(',').map((s) => s.trim()).filter(Boolean);
    draft.owner = $('#m-owner').value.trim() || null;
    draft.assignees = $('#m-assignees').value.split(',').map((s) => s.trim()).filter(Boolean);
    draft.dataCriacao = dateInputToIso($('#m-data-criacao').value) || draft.dataCriacao || nowIso();
    draft.dataInicio = dateInputToIso($('#m-data-inicio').value);
    draft.dataPrevista = dateInputToIso($('#m-data-prevista').value);
    draft.dataConclusao = dateInputToIso($('#m-data-conclusao').value);
    draft.bloqueadoPor = novaColuna === 'bloqueado' ? ($('#m-bloqueado-por').value.trim() || null) : null;
    draft.atualizadoEm = nowIso();
    draft.atualizadoPor = whoAmI();

    if (!draft.titulo) { toast('Título é obrigatório.', 'error'); return; }
    if (!draft.id) { toast('ID é obrigatório.', 'error'); return; }

    // Histórico de movimentação e datas auto
    if (state.editingId && colunaAnterior && colunaAnterior !== novaColuna) {
      recordHistory(draft, {
        tipo: 'movido',
        extras: { de: colunaAnterior, para: novaColuna },
      });
      if (novaColuna === 'dev' && !draft.dataInicio) draft.dataInicio = nowIso();
      if (novaColuna === 'lancado' && !draft.dataConclusao) draft.dataConclusao = nowIso();
      if (novaColuna === 'bloqueado') {
        recordHistory(draft, { tipo: 'bloqueado', extras: { motivo: draft.bloqueadoPor } });
      }
    } else if (!state.editingId) {
      recordHistory(draft, { tipo: 'criado' });
    }

    const idx = state.cards.findIndex((c) => c.id === draft.id);
    if (idx >= 0) {
      state.cards[idx] = draft;
    } else {
      state.cards.push(draft);
    }
    await persistCard(draft);
    closeModal();
    render();
    toast('Card salvo.', 'success');
  }

  // ===== Export / Import =====
  function exportJson() {
    const blob = new Blob([JSON.stringify({
      version: 1,
      exportadoEm: new Date().toISOString(),
      cards: state.cards,
      colunas: state.columns,
      categorias: state.categorias,
      prioridades: state.prioridades,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `paidegua-kanban-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.cards)) throw new Error('Arquivo inválido (sem cards)');
        if (!confirm(`Importar ${data.cards.length} cards? Isso substitui o quadro atual.`)) return;
        state.cards = data.cards;
        if (data.colunas) state.columns = data.colunas;
        if (data.categorias) state.categorias = data.categorias;
        if (data.prioridades) state.prioridades = data.prioridades;
        if (API_BASE === null) {
          const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_OFFLINE) || '{}');
          stored.cards = state.cards;
          stored.colunas = state.columns;
          stored.categorias = state.categorias;
          stored.prioridades = state.prioridades;
          localStorage.setItem(STORAGE_KEY_OFFLINE, JSON.stringify(stored));
        } else {
          await api('/api/board/replace', { method: 'POST', body: JSON.stringify(data) });
        }
        populateFilters();
        render();
        toast('Importação concluída.', 'success');
      } catch (err) {
        toast('Falha ao importar: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  // ===== Bind events =====
  function bind() {
    $('#btn-request-otp').addEventListener('click', requestOtp);
    $('#btn-back-email').addEventListener('click', () => {
      $('#stage-email').hidden = false;
      $('#stage-otp').hidden = true;
      setStatus('');
    });
    $('#btn-verify-otp').addEventListener('click', verifyOtp);
    $('#auth-otp').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyOtp(); });
    $('#auth-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') requestOtp(); });

    $('#btn-logout').addEventListener('click', logout);
    $('#btn-vault').addEventListener('click', openVault);
    $('#btn-docs').addEventListener('click', openDocs);
    $('#btn-team').addEventListener('click', openTeam);
    $('#btn-novo').addEventListener('click', () => openModal(null));
    $('#btn-export').addEventListener('click', exportJson);
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (f) importJson(f); e.target.value = '';
    });

    $('#filter-search').addEventListener('input', (e) => { state.filters.search = e.target.value; render(); });
    $('#filter-categoria').addEventListener('change', (e) => { state.filters.categoria = e.target.value; render(); });
    $('#filter-prioridade').addEventListener('change', (e) => { state.filters.prioridade = e.target.value; render(); });
    $('#filter-fase').addEventListener('change', (e) => { state.filters.fase = e.target.value; render(); });

    $$('#modal [data-close]').forEach((el) => el.addEventListener('click', closeModal));
    $('#m-save').addEventListener('click', saveModal);
    $('#m-delete').addEventListener('click', () => {
      const id = $('#m-id').value;
      if (id && confirm(`Excluir ${id}?`)) { deleteCard(id); closeModal(); }
    });

    // Novos campos do modal
    $('#m-coluna').addEventListener('change', syncBloqueioVisibility);

    $('#m-checklist-add').addEventListener('click', addChecklistItem);
    $('#m-checklist-novo').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); }
    });

    $('#m-link-add').addEventListener('click', addLink);
    $('#m-link-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addLink(); }
    });

    $('#m-comment-add').addEventListener('click', addComment);
    $('#m-comment-novo').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addComment(); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
    });
  }

  // ===== Init =====
  bind();
  if (state.token && state.user) {
    afterLogin();
  }
})();
