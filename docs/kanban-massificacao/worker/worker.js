/**
 * pAIdegua Kanban — Cloudflare Worker
 *
 * Serve API em paidegua.ia.br/api/*. Front estático em Cloudflare Pages.
 *
 * Bindings:
 *   KANBAN_KV (KV Namespace)        chaves:
 *     board:state                   -> JSON consolidado (cards/colunas/categorias/prioridades + lanes)
 *     team:members                  -> JSON [{email, nome, papel, ativo}]
 *     otp:<email>                   -> {code, expiresAt}                (TTL 10 min, kanban)
 *     token:<token>                 -> {email, issuedAt}                (TTL 90 dias, kanban)
 *     ext-otp:<email>               -> {code, expiresAt}                (TTL 10 min, extensão pAIdegua)
 *     ext-token:<token>             -> {email, issuedAt}                (TTL 90 dias, extensão pAIdegua)
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

      // ----- Auth da extensão pAIdegua (compat com contrato Apps Script) -----
      // Endpoint único que despacha por {action} no body. Mesmo contrato que
      // o backend legado (Google Apps Script) — extensão apenas troca a URL.
      if (url.pathname === '/api/auth/extension' && request.method === 'POST') {
        return await handleExtensionAuth(request, env);
      }

      // ----- A partir daqui, exige bearer válido -----
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;

      // Sessão atual
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const admin = await isAdmin(auth.email, env);
        const m = await findMember(env, auth.email);
        return json({
          ok: true,
          email: auth.email,
          isAdmin: admin,
          equipes: m?.equipes || ['kanban'],
          nome: m?.nome || null,
          papel: m?.papel || 'membro',
        });
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

      // Documentos compartilhados — texto plano (manuais, pipelines, runbooks).
      if (url.pathname === '/api/docs' && request.method === 'GET') {
        return await handleListDocs(env);
      }
      const docsMatch = url.pathname.match(/^\/api\/docs\/([^/]+)$/);
      if (docsMatch) {
        const id = decodeURIComponent(docsMatch[1]);
        if (request.method === 'PUT') return await handleUpsertDoc(request, env, id, auth);
        if (request.method === 'DELETE') return await handleDeleteDoc(env, id, auth);
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

/**
 * Lista de membros ao vivo (KV é a fonte de verdade).
 * Bootstrap: na primeira chamada, se o KV estiver vazio, popula com ALLOWED_EMAILS
 * e ADMIN_EMAILS das vars (ambos na equipe 'kanban').
 */
async function loadMembers(env) {
  const raw = await env.KANBAN_KV.get('team:members');
  if (raw) {
    try { return JSON.parse(raw); } catch (_) { /* fallthrough */ }
  }
  // Bootstrap a partir das vars
  const bootstrap = csvVar(env.ALLOWED_EMAILS).map((email) => ({
    email,
    nome: email.split('@')[0],
    papel: csvVar(env.ADMIN_EMAILS).includes(email) ? 'admin' : 'membro',
    equipes: ['kanban'],
    ativo: true,
    adicionadoEm: new Date().toISOString(),
    adicionadoPor: 'bootstrap',
  }));
  if (bootstrap.length) {
    await env.KANBAN_KV.put('team:members', JSON.stringify(bootstrap));
  }
  return bootstrap;
}

async function saveMembers(env, members) {
  await env.KANBAN_KV.put('team:members', JSON.stringify(members));
}

async function findMember(env, email) {
  const list = await loadMembers(env);
  return list.find((m) => m.email.toLowerCase() === email.toLowerCase());
}

/**
 * Autoriza login. `equipe` é o sistema que está autenticando: 'kanban' (default)
 * ou 'extensao' (futuro). O membro precisa estar ativo E pertencer à equipe.
 *
 * Fallback ALLOWED_DOMAINS: aceita qualquer e-mail dos domínios listados se NÃO
 * houver nenhum membro registrado e nenhuma whitelist explícita. Cobre o caso
 * de zero-config inicial. Após o primeiro membro registrado, fica desativado.
 */
async function isEmailAllowed(email, env, equipe = 'kanban') {
  const list = await loadMembers(env);
  if (list.length) {
    const m = list.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!m || !m.ativo) return false;
    const equipes = Array.isArray(m.equipes) ? m.equipes : ['kanban'];
    return equipes.includes(equipe);
  }
  // Lista vazia → fallback domínios (boot inicial extremo)
  const domains = csvVar(env.ALLOWED_DOMAINS);
  return domains.includes((email.toLowerCase().split('@')[1]) || '');
}

async function isAdmin(email, env) {
  const m = await findMember(env, email);
  if (m) return m.papel === 'admin';
  // Fallback à var ADMIN_EMAILS (bootstrap)
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
  const { email, equipe } = await request.json().catch(() => ({}));
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanEquipe = (equipe || 'kanban').trim().toLowerCase();
  if (!['kanban', 'extensao'].includes(cleanEquipe)) {
    return json({ error: 'Equipe inválida' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return json({ error: 'E-mail inválido' }, 400);
  }
  if (!(await isEmailAllowed(cleanEmail, env, cleanEquipe))) {
    return json({ error: `E-mail não autorizado para a equipe '${cleanEquipe}'` }, 403);
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

  // Membro já garantido pelo gate (loadMembers + isEmailAllowed); nada a fazer aqui.
  const admin = await isAdmin(cleanEmail, env);
  return json({ ok: true, token, email: cleanEmail, isAdmin: admin });
}

async function handleLogout(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (m) await env.KANBAN_KV.delete(`token:${m[1].trim()}`);
  return json({ ok: true });
}

// ============== Auth da extensão pAIdegua (compat Apps Script) ==============
//
// Contrato espelhado de docs/backend/apps-script/Code.gs (legado), pra que a
// extensão atual só precise trocar BACKEND_URL em src/shared/auth-config.ts.
// Aceita 3 actions:
//   {action:'requestCode', email}
//   {action:'verifyCode',  email, code}
//   {action:'me',          jwt}
// Erros usam mesmos códigos que a extensão entende (AuthErrorCode em src/shared/types.ts):
//   invalid_email | not_whitelisted | rate_limited | missing_fields | no_code |
//   expired | wrong_code | too_many_attempts | invalid_jwt | revoked | server_error
async function handleExtensionAuth(request, env) {
  // O Apps Script não exige Content-Type específico (extensão envia text/plain
  // pra evitar preflight CORS). Aceitar JSON e text aqui.
  let payload = null;
  try {
    payload = await request.json();
  } catch (_) {
    try {
      const text = await request.clone().text();
      payload = JSON.parse(text);
    } catch (__) { /* */ }
  }
  if (!payload || typeof payload !== 'object') {
    return json({ ok: false, error: 'missing_fields' }, 400);
  }

  const action = String(payload.action || '').trim();
  switch (action) {
    case 'requestCode': return await extRequestCode(payload, env);
    case 'verifyCode':  return await extVerifyCode(payload, env);
    case 'me':          return await extMe(payload, env);
    default:            return json({ ok: false, error: 'missing_fields' }, 400);
  }
}

async function extRequestCode(payload, env) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: 'invalid_email' });
  }

  // Gate: precisa estar em team:members com 'extensao' em equipes E ativo
  const list = await loadMembers(env);
  const m = list.find((x) => x.email.toLowerCase() === email);
  const equipes = Array.isArray(m?.equipes) ? m.equipes : [];
  if (!m || m.ativo === false || !equipes.includes('extensao')) {
    return json({ ok: false, error: 'not_whitelisted' });
  }

  // Rate limit leve: se já existe OTP válido emitido há menos de 30s, recusa
  const existing = await env.KANBAN_KV.get(`ext-otp:${email}`);
  if (existing) {
    try {
      const prev = JSON.parse(existing);
      if (prev?.issuedAt && Date.now() - prev.issuedAt < 30_000) {
        return json({ ok: false, error: 'rate_limited' });
      }
    } catch (_) { /* */ }
  }

  const code = generateOtp();
  await env.KANBAN_KV.put(
    `ext-otp:${email}`,
    JSON.stringify({ code, expiresAt: Date.now() + OTP_TTL_SECONDS * 1000, issuedAt: Date.now(), tentativas: 0 }),
    { expirationTtl: OTP_TTL_SECONDS }
  );

  try {
    await sendOtpEmailResend(email, code, env, /* origem */ 'extensão pAIdegua');
  } catch (err) {
    console.error('Falha Resend (extensão):', err.message);
    return json({ ok: false, error: 'server_error' });
  }
  return json({ ok: true });
}

async function extVerifyCode(payload, env) {
  const email = String(payload.email || '').trim().toLowerCase();
  const code = String(payload.code || '').trim();
  if (!email || !/^\d{6}$/.test(code)) {
    return json({ ok: false, error: 'missing_fields' });
  }

  const raw = await env.KANBAN_KV.get(`ext-otp:${email}`);
  if (!raw) return json({ ok: false, error: 'no_code' });
  let stored;
  try { stored = JSON.parse(raw); } catch (_) { return json({ ok: false, error: 'no_code' }); }
  if (Date.now() > stored.expiresAt) return json({ ok: false, error: 'expired' });

  if (stored.code !== code) {
    const tentativas = (stored.tentativas || 0) + 1;
    if (tentativas >= 5) {
      await env.KANBAN_KV.delete(`ext-otp:${email}`);
      return json({ ok: false, error: 'too_many_attempts' });
    }
    await env.KANBAN_KV.put(
      `ext-otp:${email}`,
      JSON.stringify({ ...stored, tentativas }),
      { expirationTtl: Math.max(60, Math.ceil((stored.expiresAt - Date.now()) / 1000)) }
    );
    return json({ ok: false, error: 'wrong_code' });
  }

  // Revalida que o membro continua ativo na equipe extensão (defesa em
  // profundidade — pode ter sido removido entre requestCode e verifyCode)
  const list = await loadMembers(env);
  const m = list.find((x) => x.email.toLowerCase() === email);
  const equipes = Array.isArray(m?.equipes) ? m.equipes : [];
  if (!m || m.ativo === false || !equipes.includes('extensao')) {
    await env.KANBAN_KV.delete(`ext-otp:${email}`);
    return json({ ok: false, error: 'not_whitelisted' });
  }

  const token = generateToken();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS * 1000;
  await env.KANBAN_KV.put(
    `ext-token:${token}`,
    JSON.stringify({ email, issuedAt }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );
  await env.KANBAN_KV.delete(`ext-otp:${email}`);

  // Resposta no formato que a extensão atual espera (jwt + expiresAt em ms)
  return json({ ok: true, jwt: token, email, expiresAt });
}

async function extMe(payload, env) {
  const token = String(payload.jwt || '').trim();
  if (!token) return json({ ok: false, error: 'invalid_jwt' });
  const raw = await env.KANBAN_KV.get(`ext-token:${token}`);
  if (!raw) return json({ ok: false, error: 'invalid_jwt' });
  let stored;
  try { stored = JSON.parse(raw); } catch (_) { return json({ ok: false, error: 'invalid_jwt' }); }

  // Revalida estado vivo do membro: revogação imediata se ativo=false ou
  // 'extensao' tirado das equipes
  const list = await loadMembers(env);
  const m = list.find((x) => x.email.toLowerCase() === stored.email.toLowerCase());
  const equipes = Array.isArray(m?.equipes) ? m.equipes : [];
  if (!m || m.ativo === false || !equipes.includes('extensao')) {
    await env.KANBAN_KV.delete(`ext-token:${token}`);
    return json({ ok: false, error: 'revoked' });
  }

  const expiresAt = stored.issuedAt + TOKEN_TTL_SECONDS * 1000;
  return json({ ok: true, email: stored.email, expiresAt });
}

async function sendOtpEmailResend(to, code, env, origem) {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY não configurado no Worker');
  }
  const from = env.MAIL_FROM || 'noreply@paidegua.ia.br';
  const fromName = env.MAIL_FROM_NAME || 'pAIdegua / Inovajus';
  const isExtension = origem === 'extensão pAIdegua';
  const subject = isExtension
    ? `pAIdegua — código de acesso ${code}`
    : `pAIdegua Kanban — código de acesso ${code}`;
  const linhaContexto = isExtension
    ? `Seu código de acesso à extensão pAIdegua (Chrome/Edge) é: ${code}`
    : `Seu código de acesso ao Kanban de Massificação do pAIdegua é: ${code}`;
  const text = [
    'Olá,',
    '',
    linhaContexto,
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
async function handleListMembers(env) {
  return json({ ok: true, members: await loadMembers(env) });
}

function normalizeEquipes(input) {
  if (!Array.isArray(input)) return ['kanban'];
  const valid = input.map((s) => String(s).trim().toLowerCase()).filter((s) => ['kanban', 'extensao'].includes(s));
  return valid.length ? Array.from(new Set(valid)) : ['kanban'];
}

async function handleAddMember(request, env, auth) {
  if (!(await isAdmin(auth.email, env))) return json({ error: 'Apenas admin' }, 403);
  const body = await request.json().catch(() => ({}));
  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'E-mail inválido' }, 400);
  }
  const list = await loadMembers(env);
  const existing = list.find((m) => m.email === email);
  if (existing) {
    Object.assign(existing, {
      nome: body.nome != null ? body.nome : existing.nome,
      papel: body.papel || existing.papel,
      equipes: normalizeEquipes(body.equipes ?? existing.equipes),
      ativo: body.ativo !== false,
      atualizadoEm: new Date().toISOString(),
      atualizadoPor: auth.email,
    });
  } else {
    list.push({
      email,
      nome: body.nome || email.split('@')[0],
      papel: body.papel || 'membro',
      equipes: normalizeEquipes(body.equipes),
      ativo: body.ativo !== false,
      adicionadoEm: new Date().toISOString(),
      adicionadoPor: auth.email,
    });
  }
  await saveMembers(env, list);
  return json({ ok: true, members: list });
}

async function handleRemoveMember(env, email, auth) {
  if (!(await isAdmin(auth.email, env))) return json({ error: 'Apenas admin' }, 403);
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

// ============== Docs handlers ==============
async function loadDocs(env) {
  const raw = await env.KANBAN_KV.get('docs:state');
  return raw ? JSON.parse(raw) : { items: [] };
}
async function saveDocs(env, docs, auth) {
  docs.atualizadoEm = new Date().toISOString();
  if (auth) docs.atualizadoPor = auth.email;
  await env.KANBAN_KV.put('docs:state', JSON.stringify(docs));
}

async function handleListDocs(env) {
  const d = await loadDocs(env);
  return json({ ok: true, items: d.items || [] });
}

function isValidDoc(item) {
  return item
    && typeof item.id === 'string' && item.id.length > 0
    && typeof item.titulo === 'string' && item.titulo.length > 0
    && typeof item.conteudo === 'string';
}

async function handleUpsertDoc(request, env, id, auth) {
  const item = await request.json().catch(() => null);
  if (!item || !isValidDoc(item) || item.id !== id) {
    return json({ error: 'Documento inválido' }, 400);
  }
  const d = await loadDocs(env);
  d.items = d.items || [];
  const idx = d.items.findIndex((x) => x.id === id);
  item.atualizadoPor = auth.email;
  item.atualizadoEm = new Date().toISOString();
  if (idx >= 0) {
    d.items[idx] = { ...d.items[idx], ...item };
  } else {
    item.criadoPor = auth.email;
    item.criadoEm = item.criadoEm || item.atualizadoEm;
    d.items.push(item);
  }
  await saveDocs(env, d, auth);
  return json({ ok: true });
}

async function handleDeleteDoc(env, id, auth) {
  const d = await loadDocs(env);
  d.items = (d.items || []).filter((x) => x.id !== id);
  await saveDocs(env, d, auth);
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
