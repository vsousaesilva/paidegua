/**
 * pAIdegua Kanban — Cofre (Vault)
 *
 * Repositório centralizado do projeto: manuais, dicas, pipelines, senhas e API keys.
 * Conteúdo é cifrado client-side com AES-GCM 256, chave derivada da passphrase do usuário
 * via PBKDF2-SHA256 com 600.000 iterações. Servidor (Cloudflare KV) armazena APENAS o blob
 * cifrado + metadados não-sensíveis (label, tags, kind). Sem passphrase, é irrecuperável.
 *
 * Storage:
 *   - Online (kanban.paidegua.ia.br): GET/PUT/DELETE /api/vault/:id  (com bearer token)
 *   - Offline (file://):       localStorage["paidegua_kanban_vault"]
 *
 * Modelo de item:
 *   {
 *     id,                      // uuid
 *     kind: "doc" | "credencial",
 *     tipo: "doc-md" | "senha" | "api-key" | "cert" | "conexao" | "outro",
 *     label,                   // título — em CLARO (para listagem/busca)
 *     tags: [],                // em CLARO
 *     usuario,                 // em CLARO (opcional, só para credencial)
 *     url,                     // em CLARO (opcional)
 *     payload: {               // CIFRADO
 *       ciphertext, iv, salt
 *     },
 *     algoritmo: "AES-GCM",
 *     kdf: "PBKDF2-SHA256-600000",
 *     criadoEm, atualizadoEm,
 *     autor
 *   }
 */
(() => {
  'use strict';

  const PBKDF2_ITERATIONS = 600000;
  const STORAGE_KEY_OFFLINE = 'paidegua_kanban_vault';
  const SESSION_KEY_PASS = '__paidegua_vault_pass__';   // só sessionStorage
  const AUTOLOCK_MS = 15 * 60 * 1000;                    // 15 min

  // Espera state do kanban.js ficar disponível (afterLogin chama vault.init)
  const Vault = {
    items: [],
    passphrase: null,    // mantido na memória da aba
    autolockTid: null,
    selectedId: null,
    searchTerm: '',
    apiBase: '',         // setado por kanban.js
    isOnline: false,
    bearer: null,
    user: null,
  };

  // ============== Crypto ==============
  function bufToB64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBuf(s) {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(passphrase, saltBytes) {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptPayload(plaintext, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    return {
      ciphertext: bufToB64(ciphertext),
      iv: bufToB64(iv),
      salt: bufToB64(salt),
    };
  }

  async function decryptPayload(payload, passphrase) {
    const key = await deriveKey(passphrase, b64ToBuf(payload.salt));
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(payload.iv) },
      key,
      b64ToBuf(payload.ciphertext)
    );
    return new TextDecoder().decode(decrypted);
  }

  // ============== Storage ==============
  async function loadFromBackend() {
    if (Vault.isOnline) {
      const resp = await fetch(Vault.apiBase + '/api/vault', {
        headers: { Authorization: `Bearer ${Vault.bearer}` },
      });
      if (!resp.ok) throw new Error(`Falha ao carregar cofre (HTTP ${resp.status})`);
      const data = await resp.json();
      return data.items || [];
    }
    const raw = localStorage.getItem(STORAGE_KEY_OFFLINE);
    return raw ? JSON.parse(raw) : [];
  }

  async function saveItem(item) {
    if (Vault.isOnline) {
      const resp = await fetch(Vault.apiBase + `/api/vault/${encodeURIComponent(item.id)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${Vault.bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (!resp.ok) throw new Error(`Falha ao salvar (HTTP ${resp.status})`);
    } else {
      localStorage.setItem(STORAGE_KEY_OFFLINE, JSON.stringify(Vault.items));
    }
  }

  async function removeItem(id) {
    if (Vault.isOnline) {
      const resp = await fetch(Vault.apiBase + `/api/vault/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${Vault.bearer}` },
      });
      if (!resp.ok) throw new Error(`Falha ao excluir (HTTP ${resp.status})`);
    } else {
      localStorage.setItem(STORAGE_KEY_OFFLINE, JSON.stringify(Vault.items));
    }
  }

  // ============== Sessão / autolock ==============
  function rememberPassphrase(p) {
    Vault.passphrase = p;
    try { sessionStorage.setItem(SESSION_KEY_PASS, p); } catch (_) {}
    resetAutolock();
  }

  function recoverPassphraseFromSession() {
    try {
      const p = sessionStorage.getItem(SESSION_KEY_PASS);
      if (p) Vault.passphrase = p;
    } catch (_) {}
  }

  function lock() {
    Vault.passphrase = null;
    Vault.selectedId = null;
    try { sessionStorage.removeItem(SESSION_KEY_PASS); } catch (_) {}
    if (Vault.autolockTid) clearTimeout(Vault.autolockTid);
    showLockStage();
  }

  function resetAutolock() {
    if (Vault.autolockTid) clearTimeout(Vault.autolockTid);
    Vault.autolockTid = setTimeout(() => {
      lock();
      toast('Cofre bloqueado por inatividade.', '');
    }, AUTOLOCK_MS);
  }

  // ============== Toast (compartilhado com kanban.js) ==============
  function toast(msg, kind = '') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast is-visible' + (kind ? ' is-' + kind : '');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(() => t.classList.remove('is-visible'), 3200);
  }

  // ============== UI helpers ==============
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function tipoToKind(_tipo) {
    return 'credencial';
  }

  function tipoIcone(tipo) {
    return ({
      'senha': '🔑',
      'api-key': '🗝',
      'cert': '📜',
      'conexao': '🔌',
      'outro': '📦',
    })[tipo] || '🔑';
  }

  // ============== Tela 1: Lock ==============
  function showLockStage() {
    $('#vault-main').hidden = true;
    $('#vault-lock-stage').hidden = false;
    $('#vault-lock').hidden = true;
    const isFirstUse = Vault.items.length === 0;
    if (isFirstUse) {
      $('#vault-lock-title').textContent = 'Definir passphrase do cofre';
      $('#vault-lock-intro').innerHTML =
        'Crie uma <strong>passphrase mestra</strong> para cifrar seus itens. ' +
        'Ela <strong>nunca</strong> sai do navegador. Recomenda-se mínimo de 12 caracteres com mistura de tipos.';
      $('#vault-pass2-label').hidden = false;
      $('#vault-pass2').hidden = false;
      $('#vault-pass-submit').textContent = 'Criar cofre';
      $('#vault-pass-hint').textContent = '';
    } else {
      $('#vault-lock-title').textContent = 'Cofre bloqueado';
      $('#vault-lock-intro').innerHTML =
        `Informe a <strong>passphrase</strong> para descriptografar ${Vault.items.length} item(ns). ` +
        'Ela fica apenas na memória da sua aba (limpa ao fechar ou bloquear). O servidor nunca a recebe.';
      $('#vault-pass2-label').hidden = true;
      $('#vault-pass2').hidden = true;
      $('#vault-pass-submit').textContent = 'Desbloquear';
      $('#vault-pass-hint').textContent = '';
    }
    $('#vault-pass').value = '';
    $('#vault-pass2').value = '';
    setTimeout(() => $('#vault-pass').focus(), 50);
  }

  async function attemptUnlock() {
    const pass = $('#vault-pass').value;
    const isFirstUse = Vault.items.length === 0;
    if (isFirstUse) {
      const pass2 = $('#vault-pass2').value;
      if (pass.length < 12) {
        $('#vault-pass-hint').textContent = 'Use no mínimo 12 caracteres.';
        return;
      }
      if (pass !== pass2) {
        $('#vault-pass-hint').textContent = 'As passphrases não conferem.';
        return;
      }
      rememberPassphrase(pass);
      showMainStage();
      toast('Cofre criado. Use sempre a mesma passphrase.', 'success');
      return;
    }

    // Validação: tenta descriptografar o primeiro item para conferir
    try {
      const first = Vault.items[0];
      await decryptPayload(first.payload, pass);
      rememberPassphrase(pass);
      showMainStage();
      toast('Cofre desbloqueado.', 'success');
    } catch (err) {
      $('#vault-pass-hint').textContent = 'Passphrase incorreta.';
      $('#vault-pass').focus();
      $('#vault-pass').select();
    }
  }

  // ============== Tela 2: Main (lista + editor) ==============
  function showMainStage() {
    $('#vault-lock-stage').hidden = true;
    $('#vault-main').hidden = false;
    $('#vault-lock').hidden = false;
    syncSeedButton();
    renderList();
    showPlaceholder();
    resetAutolock();
  }

  function syncSeedButton() {
    const seed = window.__PAIDEGUA_VAULT_SEED__;
    const btn = $('#vault-seed-btn');
    if (!btn) return;
    if (Vault.items.length === 0 && Array.isArray(seed) && seed.length) {
      $('#vault-seed-count').textContent = seed.length;
      btn.hidden = false;
    } else {
      btn.hidden = true;
    }
  }

  async function populateFromSeed() {
    const seed = window.__PAIDEGUA_VAULT_SEED__;
    if (!Array.isArray(seed) || !seed.length) {
      toast('Pacote inicial não encontrado.', 'error');
      return;
    }
    if (!Vault.passphrase) {
      toast('Cofre bloqueado.', 'error');
      return;
    }
    if (Vault.items.length > 0 && !confirm('Já existem itens no cofre. Adicionar o pacote inicial mesmo assim?')) return;

    const btn = $('#vault-seed-btn');
    btn.disabled = true;
    btn.textContent = `Cifrando ${seed.length} itens…`;

    let ok = 0;
    let falhas = 0;
    for (const tpl of seed) {
      try {
        const payload = await encryptPayload(tpl.conteudo, Vault.passphrase);
        const now = new Date().toISOString();
        const item = {
          id: uuid(),
          kind: tipoToKind(tpl.tipo),
          tipo: tpl.tipo,
          label: tpl.label,
          tags: tpl.tags || [],
          usuario: tpl.usuario || null,
          url: tpl.url || null,
          payload,
          algoritmo: 'AES-GCM',
          kdf: 'PBKDF2-SHA256-' + PBKDF2_ITERATIONS,
          criadoEm: now,
          atualizadoEm: now,
          autor: Vault.user,
          atualizadoPor: Vault.user,
        };
        await saveItem(item);
        Vault.items.push(item);
        if (!Vault.isOnline) localStorage.setItem(STORAGE_KEY_OFFLINE, JSON.stringify(Vault.items));
        ok++;
      } catch (err) {
        console.error('Falha ao seedar item', tpl.label, err);
        falhas++;
      }
      btn.textContent = `Cifrando ${ok + falhas}/${seed.length}…`;
    }

    btn.disabled = false;
    btn.textContent = `📦 Carregar pacote inicial (${seed.length} itens)`;
    syncSeedButton();
    renderList();
    toast(`Pacote carregado: ${ok} ok, ${falhas} falhas.`, falhas ? 'error' : 'success');
    resetAutolock();
  }

  function renderList() {
    const ul = $('#vault-list');
    const filtered = Vault.items
      .filter((it) => {
        if (!Vault.searchTerm) return true;
        const blob = (it.label + ' ' + (it.tags || []).join(' ') + ' ' + (it.usuario || '') + ' ' + (it.url || '')).toLowerCase();
        return blob.includes(Vault.searchTerm.toLowerCase());
      })
      .sort((a, b) => (a.label || '').localeCompare(b.label || '', 'pt-BR'));

    ul.innerHTML = '';

    if (!filtered.length) {
      $('#vault-empty').hidden = false;
      $('#vault-empty').textContent = Vault.searchTerm ? 'Nenhuma credencial bate com a busca.' : 'Nenhuma credencial. Clique em "+ Nova credencial".';
      return;
    }
    $('#vault-empty').hidden = true;

    filtered.forEach((it) => {
      const li = document.createElement('li');
      li.className = 'vault__item' + (it.id === Vault.selectedId ? ' is-active' : '');
      li.dataset.id = it.id;
      li.innerHTML = `
        <span class="vault__item-icon">${tipoIcone(it.tipo)}</span>
        <span class="vault__item-body">
          <span class="vault__item-label">${escapeHtml(it.label)}</span>
          <span class="vault__item-meta">
            ${it.usuario ? escapeHtml(it.usuario) + ' · ' : ''}${(it.tags || []).slice(0, 3).map(escapeHtml).join(' · ')}
          </span>
        </span>
      `;
      li.addEventListener('click', () => openItem(it.id));
      ul.appendChild(li);
    });
  }

  function showPlaceholder() {
    $('#vault-placeholder').hidden = false;
    $('#vault-form').hidden = true;
    Vault.selectedId = null;
    renderList();
  }

  async function openItem(id) {
    const it = Vault.items.find((x) => x.id === id);
    if (!it) return;
    let plain = '';
    try {
      plain = await decryptPayload(it.payload, Vault.passphrase);
    } catch (err) {
      toast('Falha ao descriptografar (passphrase divergente?).', 'error');
      return;
    }
    Vault.selectedId = id;
    showForm({
      id: it.id,
      tipo: it.tipo,
      label: it.label,
      tags: it.tags || [],
      usuario: it.usuario || '',
      url: it.url || '',
      conteudo: plain,
      criadoEm: it.criadoEm,
      atualizadoEm: it.atualizadoEm,
      autor: it.autor,
    });
    renderList();
    resetAutolock();
  }

  function newItem() {
    Vault.selectedId = null;
    showForm({
      id: '',
      tipo: 'senha',
      label: '',
      tags: [],
      usuario: '',
      url: '',
      conteudo: '',
      criadoEm: null,
      atualizadoEm: null,
      autor: Vault.user,
    });
    renderList();
  }

  function showForm(data) {
    $('#vault-placeholder').hidden = true;
    $('#vault-form').hidden = false;
    $('#v-label').value = data.label;
    $('#v-tipo').value = data.tipo;
    $('#v-tags').value = (data.tags || []).join(', ');
    $('#v-usuario').value = data.usuario || '';
    $('#v-url').value = data.url || '';
    $('#v-conteudo').value = data.conteudo || '';
    $('#v-conteudo').dataset.id = data.id || '';
    $('#v-excluir').hidden = !data.id;
    syncFormByTipo();
    $('#v-meta').textContent = data.id
      ? `criado ${shortDate(data.criadoEm)} · atualizado ${shortDate(data.atualizadoEm)} · ${data.autor || ''}`
      : 'novo item';
    setTimeout(() => $('#v-label').focus(), 50);
  }

  function syncFormByTipo() {
    $('#v-credfields').style.display = '';
    $('#v-conteudo-label').firstChild.nodeValue = 'Conteúdo (cifrado)';
    $('#v-conteudo').rows = 8;
    $('#v-conteudo').classList.add('vault__textarea--secret');
    if (!$('#v-conteudo').dataset.revelado) {
      $('#v-conteudo').classList.add('is-mask');
    } else {
      $('#v-conteudo').classList.remove('is-mask');
    }
  }

  function toggleReveal() {
    const ta = $('#v-conteudo');
    if (ta.dataset.revelado) {
      delete ta.dataset.revelado;
      ta.classList.add('is-mask');
    } else {
      ta.dataset.revelado = '1';
      ta.classList.remove('is-mask');
    }
  }

  async function copyConteudo() {
    const text = $('#v-conteudo').value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copiado. Será limpo da área de transferência em 30s.', 'success');
      clearTimeout(copyConteudo._tid);
      copyConteudo._tid = setTimeout(async () => {
        try {
          const cur = await navigator.clipboard.readText();
          if (cur === text) await navigator.clipboard.writeText('');
        } catch (_) { /* ignora */ }
      }, 30000);
    } catch (err) {
      toast('Falha ao copiar (permissão da clipboard).', 'error');
    }
    resetAutolock();
  }

  async function saveForm() {
    const label = $('#v-label').value.trim();
    if (!label) { toast('Título é obrigatório.', 'error'); return; }
    const tipo = $('#v-tipo').value;
    const conteudo = $('#v-conteudo').value;
    if (!conteudo) { toast('Conteúdo vazio.', 'error'); return; }

    const payload = await encryptPayload(conteudo, Vault.passphrase);
    const now = new Date().toISOString();
    const id = $('#v-conteudo').dataset.id || uuid();

    const existente = Vault.items.find((x) => x.id === id);
    const item = {
      id,
      kind: tipoToKind(tipo),
      tipo,
      label,
      tags: $('#v-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
      usuario: $('#v-usuario').value.trim() || null,
      url: $('#v-url').value.trim() || null,
      payload,
      algoritmo: 'AES-GCM',
      kdf: 'PBKDF2-SHA256-' + PBKDF2_ITERATIONS,
      criadoEm: existente?.criadoEm || now,
      atualizadoEm: now,
      autor: existente?.autor || Vault.user,
      atualizadoPor: Vault.user,
    };

    try {
      await saveItem(item);
      const idx = Vault.items.findIndex((x) => x.id === id);
      if (idx >= 0) Vault.items[idx] = item;
      else Vault.items.push(item);
      if (!Vault.isOnline) localStorage.setItem(STORAGE_KEY_OFFLINE, JSON.stringify(Vault.items));
      Vault.selectedId = item.id;
      renderList();
      toast('Item salvo.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    resetAutolock();
  }

  async function deleteForm() {
    const id = $('#v-conteudo').dataset.id;
    if (!id) return;
    const it = Vault.items.find((x) => x.id === id);
    if (!confirm(`Excluir "${it?.label || id}"? Isto é irreversível.`)) return;
    try {
      await removeItem(id);
      Vault.items = Vault.items.filter((x) => x.id !== id);
      if (!Vault.isOnline) localStorage.setItem(STORAGE_KEY_OFFLINE, JSON.stringify(Vault.items));
      showPlaceholder();
      toast('Item excluído.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    resetAutolock();
  }

  // ============== Open / Close do modal ==============
  async function openVault({ apiBase, isOnline, bearer, user }) {
    Vault.apiBase = apiBase || '';
    Vault.isOnline = !!isOnline;
    Vault.bearer = bearer || null;
    Vault.user = user || 'anonimo';

    try {
      Vault.items = await loadFromBackend();
    } catch (err) {
      toast('Falha ao carregar cofre: ' + err.message, 'error');
      Vault.items = [];
    }
    $('#vault').hidden = false;
    document.body.style.overflow = 'hidden';
    recoverPassphraseFromSession();
    if (Vault.passphrase && Vault.items.length) {
      // Tenta validar; se falhar, volta ao stage de lock
      try {
        await decryptPayload(Vault.items[0].payload, Vault.passphrase);
        showMainStage();
      } catch (_) {
        Vault.passphrase = null;
        showLockStage();
      }
    } else {
      showLockStage();
    }
  }

  function closeVault() {
    $('#vault').hidden = true;
    document.body.style.overflow = '';
  }

  // ============== Bind ==============
  function bind() {
    $('#vault-pass-submit').addEventListener('click', attemptUnlock);
    $('#vault-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptUnlock(); });
    $('#vault-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptUnlock(); });
    $('#vault-pass-toggle').addEventListener('click', () => {
      const t = $('#vault-pass').type === 'password' ? 'text' : 'password';
      $('#vault-pass').type = t;
      $('#vault-pass2').type = t;
      $('#vault-pass-toggle').textContent = t === 'password' ? 'Mostrar' : 'Ocultar';
    });
    $('#vault-lock').addEventListener('click', lock);

    $$('#vault [data-vault-close]').forEach((el) => el.addEventListener('click', closeVault));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#vault').hidden) closeVault();
    });

    $$('.vault__tab').forEach((el) => el.addEventListener('click', () => {
      $$('.vault__tab').forEach((x) => x.classList.remove('is-active'));
      el.classList.add('is-active');
      Vault.activeTab = el.dataset.vaultTab;
      Vault.selectedId = null;
      showPlaceholder();
    }));

    $('#vault-search').addEventListener('input', (e) => {
      Vault.searchTerm = e.target.value;
      renderList();
      resetAutolock();
    });

    $('#vault-new').addEventListener('click', newItem);
    const seedBtn = $('#vault-seed-btn');
    if (seedBtn) seedBtn.addEventListener('click', populateFromSeed);
    $('#v-tipo').addEventListener('change', syncFormByTipo);
    $('#v-mostrar-toggle').addEventListener('click', toggleReveal);
    $('#v-copiar').addEventListener('click', copyConteudo);
    $('#v-salvar').addEventListener('click', saveForm);
    $('#v-cancelar').addEventListener('click', showPlaceholder);
    $('#v-excluir').addEventListener('click', deleteForm);

    document.addEventListener('mousemove', () => { if (Vault.passphrase) resetAutolock(); }, { passive: true });
    document.addEventListener('keydown', () => { if (Vault.passphrase) resetAutolock(); }, { passive: true });
  }

  bind();

  // Expor API mínima para o kanban.js disparar a abertura do cofre
  window.PaideguaVault = {
    open: openVault,
    close: closeVault,
    lock,
  };
})();
