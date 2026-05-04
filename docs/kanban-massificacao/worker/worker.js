/**
 * pAIdegua Kanban — Cloudflare Worker
 *
 * Serve API em paidegua.ia.br/api/*. Front estático em Cloudflare Pages.
 *
 * Bindings:
 *   KANBAN_KV (KV Namespace)        chaves:
 *     board:state                   -> JSON consolidado (cards/colunas/categorias/prioridades + lanes)
 *     team:members                  -> JSON [{email, nome, papel, ativo}]
 *     otp:<email>                   -> {code, expiresAt}                (TTL 10 min)
 *     token:<token>                 -> {email, issuedAt}                (TTL 90 dias)
 *
 * Variáveis (wrangler.toml ou Dashboard):
 *   ALLOWED_DOMAINS  string CSV     domínios institucionais aceitos
 *   ALLOWED_EMAILS   string CSV     whitelist exata (gate principal)
 *   ADMIN_EMAILS     string CSV     quem pode gerir equipe e configurações
 *   MAIL_FROM        string         "noreply@paidegua.ia.br"
 *   MAIL_FROM_NAME   string         "pAIdegua / Inovajus"
 *   GH_REPO_DEFAULT  string         "vsousaesilva/paidegua"  (issues nascem aqui)
 *   GH_REPO_KANBAN   string         "vsousaesilva/paidegua-kanban" (cards KAN-*)
 *   GH_AUTO_COLUMN   string         coluna que dispara criação de issue (default "dev")
 *
 * Secrets (wrangler secret put):
 *   RESEND_API_KEY                  chave da Resend (envio de OTP)
 *   GITHUB_TOKEN                    PAT clássico com scope `repo` (criar issue)
 */

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;   // 90 dias
const OTP_TTL_SECONDS = 60 * 10;               // 10 min
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);

    try {
      // ----- Auth (sem token) -----
      if (url.pathname === '/api/auth/request-otp' && request.method === 'POST') {
        return await handleRequestOtp(request, env);
      }
      if (url.pathname === '/api/auth/verify-otp' && request.method === 'POST') {
        return await handleVerifyOtp(request, env);
      }

      // ----- A partir daqui, exige bearer válido -----
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;

      // Sessão atual
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        return json({ ok: true, email: auth.email, isAdmin: isAdmin(auth.email, env) });
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        return await handleLogout(request, env);
      }

      // Board
      if (url.pathname === '/api/board' && request.method === 'GET') {
        return await handleGetBoard(env);
      }
      if (url.pathname === '/api/board/replace' && request.method === 'POST') {
        return await handleReplaceBoard(request, env, auth);
      }

      const cardMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
      if (cardMatch) {
        const id = decodeURIComponent(cardMatch[1]);
        if (request.method === 'PUT') return await handleUpsertCard(request, env, id, auth);
        if (request.method === 'DELETE') return await handleDeleteCard(env, id, auth);
      }

      // Vault (Cofre) — armazena APENAS blobs cifrados; servidor jamais vê plaintext.
      if (url.pathname === '/api/vault' && request.method === 'GET') {
        return await handleListVault(env);
      }
      const vaultMatch = url.pathname.match(/^\/api\/vault\/([^/]+)$/);
      if (vaultMatch) {
        const id = decodeURIComponent(vaultMatch[1]);
        if (request.method === 'PUT') return await handleUpsertVaultItem(request, env, id, auth);
        if (request.method === 'DELETE') return await handleDeleteVaultItem(env, id, auth);
      }

      // Time
      if (url.pathname === '/api/team/members' && request.method === 'GET') {
        return await handleListMembers(env);
      }
      if (url.pathname === '/api/team/members' && request.method === 'POST') {
        return await handleAddMember(request, env, auth);
      }
      const memberMatch = url.pathname.match(/^\/api\/team\/members\/([^/]+)$/);
      if (memberMatch && request.method === 'DELETE') {
        return await handleRemoveMember(env, decodeURIComponent(memberMatch[1]), auth);
      }

      return json({ error: 'Rota não encontrada' }, 404);
    } catch (err) {
      console.error('Worker error', err.stack || err.message || err);
      return json({ error: 'Erro interno', detail: err.message }, 500);
    }
  },
};

// ============== Helpers ==============
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function csvVar(value) {
  return (value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isEmailAllowed(email, env) {
  const lc = email.toLowerCase();
  const exact = csvVar(env.ALLOWED_EMAILS);
  if (exact.length && exact.includes(lc)) return true;
  if (exact.length && !exact.includes(lc)) {
    // Quando whitelist exata existe, ela é gate principal — domínio só vale se vazia
    return false;
  }
  const domains = csvVar(env.ALLOWED_DOMAINS);
  return domains.includes(lc.split('@')[1] || '');
}

function isAdmin(email, env) {
  return csvVar(env.ADMIN_EMAILS).includes(email.toLowerCase());
}

function generateOtp() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const num = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(num % 1000000).padStart(6, '0');
}

function generateToken() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function generateId() {
  return crypto.randomUUID();
}

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return json({ error: 'Não autenticado' }, 401);
  const token = m[1].trim();
  const raw = await env.KANBAN_KV.get(`token:${token}`);
  if (!raw) return json({ error: 'Token inválido ou expirado' }, 401);
  try {
    const session = JSON.parse(raw);
    return { ...session, token };
  } catch (_) {
    return json({ error: 'Token corrompido' }, 401);
  }
}

// ============== Auth handlers ==============
async function handleRequestOtp(request, env) {
  const { email } = await request.json().catch(() => ({}));
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return json({ error: 'E-mail inválido' }, 400);
  }
  if (!isEmailAllowed(cleanEmail, env)) {
    return json({ error: 'E-mail não autorizado para este quadro' }, 403);
  }

  const code = generateOtp();
  await env.KANBAN_KV.put(
    `otp:${cleanEmail}`,
    JSON.stringify({ code, expiresAt: Date.now() + OTP_TTL_SECONDS * 1000 }),
    { expirationTtl: OTP_TTL_SECONDS }
  );

  await sendOtpEmailResend(cleanEmail, code, env);
  return json({ ok: true, message: 'Código enviado.' });
}

async function handleVerifyOtp(request, env) {
  const { email, code } = await request.json().catch(() => ({}));
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanCode = (code || '').trim();
  if (!cleanEmail || !/^\d{6}$/.test(cleanCode)) {
    return json({ error: 'Dados inválidos' }, 400);
  }
  const raw = await env.KANBAN_KV.get(`otp:${cleanEmail}`);
  if (!raw) return json({ error: 'Código expirado ou inexistente' }, 400);
  const stored = JSON.parse(raw);
  if (stored.code !== cleanCode) return json({ error: 'Código inválido' }, 400);
  if (Date.now() > stored.expiresAt) return json({ error: 'Código expirado' }, 400);

  const token = generateToken();
  await env.KANBAN_KV.put(
    `token:${token}`,
    JSON.stringify({ email: cleanEmail, issuedAt: Date.now() }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );
  await env.KANBAN_KV.delete(`otp:${cleanEmail}`);

  // Garante membro ativo no team:members ao primeiro login válido
  await ensureMember(env, cleanEmail);

  return json({ ok: true, token, email: cleanEmail, isAdmin: isAdmin(cleanEmail, env) });
}

async function handleLogout(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (m) await env.KANBAN_KV.delete(`token:${m[1].trim()}`);
  return json({ ok: true });
}

async function sendOtpEmailResend(to, code, env) {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY não configurado no Worker');
  }
  const from = env.MAIL_FROM || 'noreply@paidegua.ia.br';
  const fromName = env.MAIL_FROM_NAME || 'pAIdegua / Inovajus';
  const subject = `pAIdegua Kanban — código de acesso ${code}`;
  const text = [
    'Olá,',
    '',
    `Seu código de acesso ao Kanban de Massificação do pAIdegua é: ${code}`,
    '',
    'O código expira em 10 minutos. Se você não solicitou este acesso, ignore este e-mail.',
    '',
    '— Inovajus / JFCE',
    'paidegua.ia.br',
  ].join('\n');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${fromName} <${from}>`,
      to: [to],
      subject,
      text,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('Resend falhou', resp.status, err);
    throw new Error('Falha ao enviar e-mail OTP');
  }
}

// ============== Team handlers ==============
async function loadMembers(env) {
  const raw = await env.KANBAN_KV.get('team:members');
  return raw ? JSON.parse(raw) : [];
}

async function saveMembers(env, members) {
  await env.KANBAN_KV.put('team:members', JSON.stringify(members));
}

async function ensureMember(env, email) {
  const list = await loadMembers(env);
  if (list.some((m) => m.email === email)) return;
  list.push({
    email,
    nome: email.split('@')[0],
    papel: 'membro',
    ativo: true,
    adicionadoEm: new Date().toISOString(),
  });
  await saveMembers(env, list);
}

async function handleListMembers(env) {
  return json({ ok: true, members: await loadMembers(env) });
}

async function handleAddMember(request, env, auth) {
  if (!isAdmin(auth.email, env)) return json({ error: 'Apenas admin' }, 403);
  const body = await request.json().catch(() => ({}));
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return json({ error: 'E-mail obrigatório' }, 400);
  const list = await loadMembers(env);
  const existing = list.find((m) => m.email === email);
  if (existing) {
    Object.assign(existing, {
      nome: body.nome || existing.nome,
      papel: body.papel || existing.papel,
      ativo: body.ativo !== false,
    });
  } else {
    list.push({
      email,
      nome: body.nome || email.split('@')[0],
      papel: body.papel || 'membro',
      ativo: true,
      adicionadoEm: new Date().toISOString(),
      adicionadoPor: auth.email,
    });
  }
  await saveMembers(env, list);
  return json({ ok: true, members: list });
}

async function handleRemoveMember(env, email, auth) {
  if (!isAdmin(auth.email, env)) return json({ error: 'Apenas admin' }, 403);
  const list = await loadMembers(env);
  const next = list.filter((m) => m.email !== email.toLowerCase());
  await saveMembers(env, next);
  return json({ ok: true });
}

// ============== Board handlers ==============
async function loadBoard(env) {
  const raw = await env.KANBAN_KV.get('board:state');
  return raw
    ? JSON.parse(raw)
    : { cards: [], colunas: [], categorias: [], prioridades: [], lanes: [] };
}

async function saveBoard(env, board, auth) {
  board.atualizadoEm = new Date().toISOString();
  if (auth) board.atualizadoPor = auth.email;
  await env.KANBAN_KV.put('board:state', JSON.stringify(board));
}

async function handleGetBoard(env) {
  return json(await loadBoard(env));
}

async function handleReplaceBoard(request, env, auth) {
  const data = await request.json().catch(() => null);
  if (!data || !Array.isArray(data.cards)) return json({ error: 'JSON inválido' }, 400);
  const payload = {
    cards: data.cards,
    colunas: data.colunas || [],
    categorias: data.categorias || [],
    prioridades: data.prioridades || [],
    lanes: data.lanes || [],
  };
  await saveBoard(env, payload, auth);
  return json({ ok: true });
}

async function handleUpsertCard(request, env, id, auth) {
  const card = await request.json().catch(() => null);
  if (!card || !card.id) return json({ error: 'Card inválido' }, 400);
  if (card.id !== id) return json({ error: 'ID divergente' }, 400);

  const board = await loadBoard(env);
  const idx = board.cards.findIndex((c) => c.id === id);
  const before = idx >= 0 ? board.cards[idx] : null;

  // Histórico automático
  const historico = Array.isArray(card.historico) ? card.historico : (before?.historico || []);
  if (!before) {
    historico.push({
      id: generateId(),
      tipo: 'criado',
      autor: auth.email,
      data: new Date().toISOString(),
    });
  } else if (before.coluna !== card.coluna) {
    historico.push({
      id: generateId(),
      tipo: 'movido',
      de: before.coluna,
      para: card.coluna,
      autor: auth.email,
      data: new Date().toISOString(),
    });
  }

  // Datas automáticas
  const now = new Date().toISOString();
  card.atualizadoEm = now;
  card.atualizadoPor = auth.email;
  if (!card.dataCriacao) card.dataCriacao = before?.dataCriacao || now;
  if (card.coluna === 'dev' && !card.dataInicio) card.dataInicio = now;
  if (card.coluna === 'lancado' && !card.dataConclusao) card.dataConclusao = now;
  card.historico = historico;

  if (idx >= 0) board.cards[idx] = { ...before, ...card };
  else board.cards.push(card);

  await saveBoard(env, board, auth);

  // Integração GitHub: criar issue ao entrar na coluna gatilho (default 'dev')
  const trigger = (env.GH_AUTO_COLUMN || 'dev').toLowerCase();
  if (
    env.GITHUB_TOKEN &&
    card.coluna === trigger &&
    (!before || before.coluna !== trigger) &&
    !card.issueGithub
  ) {
    try {
      const issue = await createGithubIssue(card, env);
      card.issueGithub = issue;
      // Persiste segunda vez para gravar referência da issue
      const board2 = await loadBoard(env);
      const idx2 = board2.cards.findIndex((c) => c.id === id);
      if (idx2 >= 0) {
        board2.cards[idx2].issueGithub = issue;
        board2.cards[idx2].historico = [
          ...(board2.cards[idx2].historico || []),
          {
            id: generateId(),
            tipo: 'gh-issue-criada',
            url: issue.url,
            numero: issue.number,
            autor: 'sistema',
            data: new Date().toISOString(),
          },
        ];
        await saveBoard(env, board2, auth);
      }
    } catch (err) {
      console.error('GH issue falhou:', err.message);
    }
  }

  return json({ ok: true, card });
}

async function handleDeleteCard(env, id, auth) {
  const board = await loadBoard(env);
  board.cards = board.cards.filter((c) => c.id !== id);
  await saveBoard(env, board, auth);
  return json({ ok: true });
}

// ============== Vault handlers ==============
async function loadVault(env) {
  const raw = await env.KANBAN_KV.get('vault:state');
  return raw ? JSON.parse(raw) : { items: [] };
}
async function saveVault(env, vault, auth) {
  vault.atualizadoEm = new Date().toISOString();
  if (auth) vault.atualizadoPor = auth.email;
  await env.KANBAN_KV.put('vault:state', JSON.stringify(vault));
}

async function handleListVault(env) {
  const v = await loadVault(env);
  return json({ ok: true, items: v.items || [] });
}

function isValidVaultItem(item) {
  return item
    && typeof item.id === 'string' && item.id.length > 0
    && typeof item.label === 'string' && item.label.length > 0
    && item.payload
    && typeof item.payload.ciphertext === 'string'
    && typeof item.payload.iv === 'string'
    && typeof item.payload.salt === 'string';
}

async function handleUpsertVaultItem(request, env, id, auth) {
  const item = await request.json().catch(() => null);
  if (!item || !isValidVaultItem(item) || item.id !== id) {
    return json({ error: 'Item inválido' }, 400);
  }
  // O servidor NÃO valida nem decifra o conteúdo — apenas armazena o blob.
  const v = await loadVault(env);
  v.items = v.items || [];
  const idx = v.items.findIndex((x) => x.id === id);
  item.atualizadoPor = auth.email;
  if (idx >= 0) {
    v.items[idx] = { ...v.items[idx], ...item };
  } else {
    item.criadoPor = auth.email;
    v.items.push(item);
  }
  await saveVault(env, v, auth);
  return json({ ok: true });
}

async function handleDeleteVaultItem(env, id, auth) {
  const v = await loadVault(env);
  v.items = (v.items || []).filter((x) => x.id !== id);
  await saveVault(env, v, auth);
  return json({ ok: true });
}

// ============== GitHub integration ==============
async function createGithubIssue(card, env) {
  const repo = pickRepo(card, env);
  if (!repo) throw new Error('Repo destino não definido');

  const labels = [
    `prio:${card.prioridade}`,
    `cat:${card.categoria}`,
    card.fase ? `fase:${card.fase}` : null,
  ].filter(Boolean);

  const body = [
    card.descricao || '_(sem descrição)_',
    '',
    card.aceitacao && card.aceitacao.length
      ? '### Critérios de aceitação\n' + card.aceitacao.map((a) => `- [ ] ${a}`).join('\n')
      : '',
    card.checklist && card.checklist.length
      ? '\n### Checklist\n' + card.checklist.map((c) => `- [${c.feito ? 'x' : ' '}] ${c.texto}`).join('\n')
      : '',
    card.depende && card.depende.length
      ? `\n**Depende de:** ${card.depende.join(', ')}`
      : '',
    card.origem ? `\n**Origem:** ${card.origem}` : '',
    `\n---\n_Issue criada automaticamente pelo Kanban paidegua.ia.br · card ${card.id}_`,
  ].join('\n');

  const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'paidegua-kanban',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `[${card.id}] ${card.titulo}`,
      body,
      labels,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`GitHub ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  return { repo, number: data.number, url: data.html_url };
}

function pickRepo(card, env) {
  // Cards de operacional com prefixo KAN- vão ao repo do próprio Kanban
  if (/^KAN-/.test(card.id)) return env.GH_REPO_KANBAN || env.GH_REPO_DEFAULT || null;
  return env.GH_REPO_DEFAULT || null;
}
