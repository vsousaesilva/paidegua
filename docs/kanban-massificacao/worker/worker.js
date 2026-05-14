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
 *   CWS_URL          string         URL pública do listing na Chrome Web Store
 *                                   (default: https://chromewebstore.google.com/detail/belangijcipajlpcofhljhgjeemkbofk)
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
      if (url.pathname === '/api/team/welcome-extensao' && request.method === 'POST') {
        return await handleWelcomeExtensaoBatch(request, env, auth);
      }
      if (url.pathname === '/api/team/sync-audience' && request.method === 'POST') {
        return await handleSyncAudience(request, env, auth);
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

/**
 * Envia e-mail de boas-vindas para um novo membro da equipe 'extensao'.
 * Não usa OTP — é só um anúncio institucional com identidade gov.br/PJe,
 * link da CWS e instruções de login (saudação fixa "Olá, piloto" — o
 * parâmetro `nome` é ignorado hoje, mantido na assinatura para futura
 * personalização sem mudar callers).
 *
 * Lança em caso de falha; o caller decide se segue em frente ou registra.
 *
 * Para preview visual: abra docs/kanban-massificacao/welcome-extensao-preview.html
 * direto no navegador. O HTML aqui é a versão de produção.
 */
async function sendWelcomeExtensaoEmail(to, nome, env) {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY não configurado no Worker');
  }
  const from = env.MAIL_FROM || 'noreply@paidegua.ia.br';
  const fromName = env.MAIL_FROM_NAME || 'pAIdegua / Inovajus';
  const cwsUrl = env.CWS_URL || 'https://chromewebstore.google.com/detail/belangijcipajlpcofhljhgjeemkbofk';
  const subject = 'Bem-vindo(a) ao pAIdegua — seu acesso ao grupo piloto está liberado';

  const text = [
    'Bem-vindo(a) ao pAIdegua — Inovajus / JFCE',
    '',
    'Olá, piloto,',
    '',
    'Seu e-mail institucional foi autorizado a usar a extensão pAIdegua como',
    'membro do grupo piloto. A pAIdegua é uma extensão para Chrome/Edge',
    'desenvolvida pelo Inovajus/JFCE que integra inteligência artificial,',
    'automações e telas de produtividade diretamente ao PJe — sem instalação',
    'de software fora do navegador e sem envio de dados sensíveis para fora',
    'da Justiça.',
    '',
    'COMO COMEÇAR EM 2 PASSOS',
    '',
    '  1) Instale a extensão na Chrome Web Store',
    `     ${cwsUrl}`,
    '     Funciona em Chrome e Edge. Não exige instalação de software no',
    '     Windows. Após instalar, fixe o ícone na barra do navegador.',
    '',
    '  2) Entre com este e-mail',
    '     Abra o ícone da extensão, informe este mesmo endereço e clique em',
    '     "Entrar". Você receberá um código de 6 dígitos por e-mail (não há',
    '     senha). Digite o código na extensão para confirmar o acesso.',
    '',
    'JÁ USA A VERSÃO DEV (pasta dist)?',
    'Se você já vinha usando o pAIdegua em modo desenvolvedor (carregada da',
    'pasta "dist"), faça este caminho ANTES de instalar pela Chrome Web Store,',
    'para preservar suas configurações:',
    '',
    '  1) Exportar configurações da versão atual: abra o ícone da extensão',
    '     → popup → "Exportar configurações" (gera paidegua-config-*.txt).',
    '  2) Remover a versão antiga: chrome://extensions → localize o pAIdegua',
    '     e clique em "Remover".',
    '  3) Instalar pela Chrome Web Store (link acima).',
    '  4) Importar configurações: abra o ícone da nova extensão → popup →',
    '     "Importar configurações" e selecione o .txt salvo no passo 1.',
    '',
    'PRIVACIDADE E CONFORMIDADE',
    'O pAIdegua opera dentro do navegador do usuário, sob a Resolução CNJ',
    '615/2025 e a LGPD. Dados sensíveis dos autos (CPF, número de processo,',
    'conteúdo) NÃO são enviados para fora da Justiça nem registrados em logs',
    'do Inovajus.',
    '',
    'Dúvidas ou problemas no login? Responda a este e-mail — chega direto',
    'na equipe Inovajus.',
    '',
    '— Inovajus / Justiça Federal no Ceará',
    'paidegua.ia.br · kanban.paidegua.ia.br',
  ].join('\n');

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bem-vindo(a) ao pAIdegua</title></head>
<body style="margin:0;padding:0;background-color:#F6F8FC;font-family:'Segoe UI',Roboto,Arial,sans-serif;color:#16243A;line-height:1.55">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Instale a extensão e entre com seu e-mail institucional. Acesso ao grupo piloto liberado pelo Inovajus/JFCE.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F6F8FC;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 32px rgba(12,50,111,0.10)">
<tr><td style="background-color:#FFCD07;height:6px;line-height:6px;font-size:0">&nbsp;</td></tr>
<tr><td bgcolor="#0C326F" style="background-color:#0C326F;background-image:linear-gradient(135deg,#1351B4 0%,#0C326F 100%);padding:36px 40px 28px 40px;color:#ffffff">
<div style="font-size:12px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#FFCD07;margin-bottom:10px">Inovajus &middot; Justiça Federal no Ceará</div>
<h1 style="margin:0;font-size:28px;line-height:1.25;font-weight:700;color:#ffffff;font-family:'Segoe UI',Roboto,Arial,sans-serif">Bem-vindo(a) ao pAIdegua</h1>
<p style="margin:12px 0 0 0;font-size:15px;color:#E6ECF5">Seu acesso ao grupo piloto da extensão está liberado.</p>
</td></tr>
<tr><td style="padding:32px 40px 8px 40px">
<p style="margin:0 0 16px 0;font-size:16px">Olá, <strong>piloto</strong>,</p>
<p style="margin:0;font-size:15px;color:#16243A">Seu e-mail institucional foi autorizado a usar a extensão <strong>pAIdegua</strong> como membro do <strong>grupo piloto</strong>. A pAIdegua é uma extensão para Chrome/Edge desenvolvida pelo <strong>Inovajus/JFCE</strong> que integra inteligência artificial, automações e telas de produtividade diretamente ao PJe — sem instalação de software fora do navegador e sem envio de dados sensíveis para fora da Justiça.</p>
</td></tr>
<tr><td style="padding:28px 40px 8px 40px">
<h2 style="margin:0 0 18px 0;font-size:17px;color:#0C326F;font-weight:700;font-family:'Segoe UI',Roboto,Arial,sans-serif">Como começar em 2 passos</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px 0"><tr>
<td valign="top" width="50" style="padding-right:14px"><div style="width:36px;height:36px;line-height:36px;text-align:center;background-color:#0C326F;color:#FFCD07;border-radius:50%;font-weight:700;font-size:16px;font-family:'Segoe UI',Arial,sans-serif">1</div></td>
<td valign="top"><p style="margin:0 0 4px 0;font-size:15px;font-weight:600;color:#0C326F">Instale a extensão na Chrome Web Store</p><p style="margin:0;font-size:14px;color:#5B6B82">Funciona em Chrome e Edge. Não exige instalação de software no Windows. Após instalar, fixe o ícone na barra do navegador.</p></td>
</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="top" width="50" style="padding-right:14px"><div style="width:36px;height:36px;line-height:36px;text-align:center;background-color:#0C326F;color:#FFCD07;border-radius:50%;font-weight:700;font-size:16px;font-family:'Segoe UI',Arial,sans-serif">2</div></td>
<td valign="top"><p style="margin:0 0 4px 0;font-size:15px;font-weight:600;color:#0C326F">Entre com este e-mail</p><p style="margin:0;font-size:14px;color:#5B6B82">Abra o ícone da extensão, informe este mesmo endereço e clique em <em>Entrar</em>. Você receberá um código de 6 dígitos por e-mail (não há senha). Digite o código na extensão para confirmar o acesso.</p></td>
</tr></table>
</td></tr>
<tr><td style="padding:24px 40px 0 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FFF8E1;border-left:4px solid #F57C00;border-radius:8px"><tr><td style="padding:16px 18px">
<p style="margin:0 0 8px 0;font-size:12px;font-weight:700;color:#8a5a00;text-transform:uppercase;letter-spacing:0.08em">Já usa a versão dev (pasta dist)?</p>
<p style="margin:0 0 12px 0;font-size:13px;color:#16243A;line-height:1.6">Se você já vinha usando o pAIdegua em modo desenvolvedor (carregada da pasta <code style="background:rgba(245,124,0,0.12);padding:1px 6px;border-radius:4px;font-size:12px">dist</code>), faça este caminho <strong>antes</strong> de clicar em <em>Instalar</em>, para preservar suas configurações:</p>
<ol style="margin:0;padding-left:20px;font-size:13px;color:#16243A;line-height:1.65">
<li style="margin-bottom:6px"><strong>Exportar configurações</strong> da versão atual: abra o ícone da extensão &rarr; popup &rarr; botão <em>Exportar configurações</em>. Será gerado um arquivo <code style="background:rgba(245,124,0,0.12);padding:1px 5px;border-radius:4px;font-size:12px">paidegua-config-*.txt</code>.</li>
<li style="margin-bottom:6px"><strong>Remover</strong> a versão antiga: abra <code style="background:rgba(245,124,0,0.12);padding:1px 5px;border-radius:4px;font-size:12px">chrome://extensions</code>, localize o pAIdegua e clique em <em>Remover</em>.</li>
<li style="margin-bottom:6px"><strong>Instalar</strong> pela Chrome Web Store (botão abaixo).</li>
<li><strong>Importar configurações</strong>: abra o ícone da nova extensão &rarr; popup &rarr; <em>Importar configurações</em> e selecione o arquivo <code style="background:rgba(245,124,0,0.12);padding:1px 5px;border-radius:4px;font-size:12px">.txt</code> salvo no passo 1.</li>
</ol>
</td></tr></table>
</td></tr>
<tr><td style="padding:28px 40px 8px 40px" align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="border-radius:8px"><a href="${cwsUrl}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;background-color:#1351B4;border-radius:8px;text-decoration:none;border:1px solid #0C326F;font-family:'Segoe UI',Arial,sans-serif">Instalar a extensão &rarr;</a></td>
</tr></table>
</td></tr>
<tr><td style="padding:32px 40px 0 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F6F8FC;border-left:4px solid #1351B4;border-radius:8px"><tr><td style="padding:16px 18px">
<p style="margin:0 0 6px 0;font-size:12px;font-weight:700;color:#0C326F;text-transform:uppercase;letter-spacing:0.08em">Privacidade e conformidade</p>
<p style="margin:0;font-size:13px;color:#16243A;line-height:1.6">O pAIdegua opera dentro do navegador do usuário, sob a <strong>Resolução CNJ 615/2025</strong> e a <strong>LGPD</strong>. Dados sensíveis dos autos (CPF, número de processo, conteúdo) <strong>não</strong> são enviados para fora da Justiça nem registrados em logs do Inovajus. A whitelist de e-mails autorizados é gerida pelo time Inovajus no painel institucional <a href="https://kanban.paidegua.ia.br" style="color:#1351B4">kanban.paidegua.ia.br</a>.</p>
</td></tr></table>
</td></tr>
<tr><td style="padding:24px 40px 8px 40px">
<p style="margin:0;font-size:14px;color:#5B6B82">Dúvidas ou problemas no login? <strong style="color:#16243A">Responda a este e-mail</strong> — chega direto na equipe Inovajus.</p>
</td></tr>
<tr><td style="padding:24px 40px 32px 40px;border-top:1px solid rgba(19,81,180,0.14)">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="top" width="60%"><p style="margin:0;font-size:13px;font-weight:700;color:#0C326F">Inovajus &middot; Justiça Federal no Ceará</p>
<p style="margin:4px 0 0 0;font-size:12px;color:#5B6B82"><a href="https://paidegua.ia.br" style="color:#5B6B82;text-decoration:none">paidegua.ia.br</a> &middot; <a href="https://kanban.paidegua.ia.br" style="color:#5B6B82;text-decoration:none">kanban.paidegua.ia.br</a></p></td>
<td valign="top" align="right" width="40%"><p style="margin:0;font-size:11px;color:#8395B0;text-align:right;line-height:1.5">Você recebeu este e-mail porque seu endereço institucional foi adicionado ao grupo piloto da extensão pAIdegua.</p></td>
</tr></table>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

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
      html,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('Resend welcome falhou', resp.status, err);
    throw new Error('Falha ao enviar e-mail de boas-vindas');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ============== Resend Audience (lista de contatos dos pilotos) ==============
// Mantém o audience configurado em RESEND_AUDIENCE_ID espelhando os membros com
// equipes contendo 'extensao' e ativo !== false. Falhas nunca derrubam o fluxo
// principal de gestão de membros — apenas logam.

function splitNome(nome) {
  const clean = String(nome ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return { firstName: '', lastName: '' };
  const idx = clean.indexOf(' ');
  if (idx < 0) return { firstName: clean, lastName: '' };
  return { firstName: clean.slice(0, idx), lastName: clean.slice(idx + 1) };
}

async function addToResendAudience(env, email, nome) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY não configurado');
  if (!env.RESEND_AUDIENCE_ID) throw new Error('RESEND_AUDIENCE_ID não configurado');
  const { firstName, lastName } = splitNome(nome);
  const resp = await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      first_name: firstName,
      last_name: lastName,
      unsubscribed: false,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Resend add contact ${resp.status}: ${err}`);
  }
  return await resp.json().catch(() => ({}));
}

async function removeFromResendAudience(env, email) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY não configurado');
  if (!env.RESEND_AUDIENCE_ID) throw new Error('RESEND_AUDIENCE_ID não configurado');
  const url = `https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts/${encodeURIComponent(email)}`;
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  if (!resp.ok && resp.status !== 404) {
    const err = await resp.text();
    throw new Error(`Resend remove contact ${resp.status}: ${err}`);
  }
}

async function listResendAudienceContacts(env) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY não configurado');
  if (!env.RESEND_AUDIENCE_ID) throw new Error('RESEND_AUDIENCE_ID não configurado');
  const resp = await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Resend list contacts ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return Array.isArray(data?.data) ? data.data : [];
}

// Reflete num único passo o estado do membro no audience: piloto ativo entra,
// resto sai. Sempre seguro chamar — silencia 404/duplicado e nunca lança.
async function reflectMemberInAudience(env, member) {
  if (!env.RESEND_AUDIENCE_ID) return;
  try {
    const equipes = Array.isArray(member.equipes) ? member.equipes : [];
    const devePertencer = member.ativo !== false && equipes.includes('extensao');
    if (devePertencer) {
      await addToResendAudience(env, member.email, member.nome).catch(async (err) => {
        // Resend retorna 409/422 quando o contato já existe; trate como ok.
        if (/already exists|409|422/i.test(err.message)) return;
        throw err;
      });
    } else {
      await removeFromResendAudience(env, member.email);
    }
  } catch (err) {
    console.error('reflectMemberInAudience falhou', member.email, err.message);
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

  // Welcome automático para piloto da extensão (idempotente via flag).
  // Falha do envio não derruba o cadastro — apenas loga.
  const m = list.find((x) => x.email === email);
  if (m && m.ativo !== false && Array.isArray(m.equipes) && m.equipes.includes('extensao') && !m.welcomeExtensaoEnviadoEm) {
    try {
      await sendWelcomeExtensaoEmail(m.email, m.nome, env);
      m.welcomeExtensaoEnviadoEm = new Date().toISOString();
      m.welcomeExtensaoEnviadoPor = 'auto/handleAddMember';
    } catch (err) {
      console.error('welcome extensão falhou', m.email, err.message);
    }
  }

  // Reflete o estado do membro no Resend Audience (piloto ativo entra, resto sai).
  if (m) await reflectMemberInAudience(env, m);

  await saveMembers(env, list);
  return json({ ok: true, members: list });
}

/**
 * Dispara welcome em lote para membros recentes da equipe 'extensao' que
 * ainda não receberam. Idempotente: ignora quem já tem welcomeExtensaoEnviadoEm.
 *
 * Body opcional:
 *   { dias?: number = 3, force?: boolean = false, emails?: string[], dryRun?: boolean }
 * - dias: janela em dias contada do adicionadoEm
 * - force: ignora welcomeExtensaoEnviadoEm (reenvia)
 * - emails: se preenchido, filtra exatamente esta lista (e ignora 'dias')
 * - dryRun: lista alvos sem enviar
 */
async function handleWelcomeExtensaoBatch(request, env, auth) {
  if (!(await isAdmin(auth.email, env))) return json({ error: 'Apenas admin' }, 403);
  const body = await request.json().catch(() => ({}));
  const dias = Number.isFinite(body.dias) && body.dias > 0 ? body.dias : 3;
  const force = body.force === true;
  const dryRun = body.dryRun === true;
  const filtroEmails = Array.isArray(body.emails) && body.emails.length
    ? new Set(body.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))
    : null;

  const list = await loadMembers(env);
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;

  const alvos = list.filter((m) => {
    if (m.ativo === false) return false;
    const equipes = Array.isArray(m.equipes) ? m.equipes : [];
    if (!equipes.includes('extensao')) return false;
    if (filtroEmails) return filtroEmails.has(m.email.toLowerCase());
    if (!force && m.welcomeExtensaoEnviadoEm) return false;
    const adicionadoMs = m.adicionadoEm ? Date.parse(m.adicionadoEm) : 0;
    return adicionadoMs >= limite;
  });

  if (dryRun) {
    return json({
      ok: true,
      dryRun: true,
      dias,
      force,
      totalAlvos: alvos.length,
      alvos: alvos.map((m) => ({
        email: m.email,
        nome: m.nome,
        adicionadoEm: m.adicionadoEm,
        welcomeExtensaoEnviadoEm: m.welcomeExtensaoEnviadoEm || null,
      })),
    });
  }

  const enviados = [];
  const falhas = [];
  for (const m of alvos) {
    try {
      await sendWelcomeExtensaoEmail(m.email, m.nome, env);
      m.welcomeExtensaoEnviadoEm = new Date().toISOString();
      m.welcomeExtensaoEnviadoPor = `batch/${auth.email}`;
      enviados.push(m.email);
    } catch (err) {
      falhas.push({ email: m.email, erro: err.message });
    }
  }
  if (enviados.length) await saveMembers(env, list);
  return json({ ok: true, dias, force, totalAlvos: alvos.length, enviados, falhas });
}

/**
 * Reconcilia o Resend Audience com a lista de pilotos no KV.
 *
 * Espelha: adiciona quem está em team:members com equipes:['extensao'] ativo
 * e remove da audience quem não atende esse critério.
 *
 * Body opcional: { dryRun?: boolean }
 */
async function handleSyncAudience(request, env, auth) {
  if (!(await isAdmin(auth.email, env))) return json({ error: 'Apenas admin' }, 403);
  if (!env.RESEND_AUDIENCE_ID) return json({ error: 'RESEND_AUDIENCE_ID não configurado' }, 500);
  const body = await request.json().catch(() => ({}));
  const dryRun = body.dryRun === true;

  const members = await loadMembers(env);
  const pilotos = new Map(
    members
      .filter((m) => m.ativo !== false && Array.isArray(m.equipes) && m.equipes.includes('extensao'))
      .map((m) => [m.email.toLowerCase(), m]),
  );

  const contatos = await listResendAudienceContacts(env);
  const naAudience = new Set(contatos.map((c) => String(c.email || '').toLowerCase()).filter(Boolean));

  const aAdicionar = [];
  for (const [email, m] of pilotos) {
    if (!naAudience.has(email)) aAdicionar.push({ email, nome: m.nome });
  }
  const aRemover = [];
  for (const email of naAudience) {
    if (!pilotos.has(email)) aRemover.push(email);
  }

  if (dryRun) {
    return json({
      ok: true,
      dryRun: true,
      audience: env.RESEND_AUDIENCE_ID,
      totalPilotos: pilotos.size,
      totalAudience: naAudience.size,
      aAdicionar,
      aRemover,
    });
  }

  const adicionados = [];
  const removidos = [];
  const falhas = [];
  for (const { email, nome } of aAdicionar) {
    try { await addToResendAudience(env, email, nome); adicionados.push(email); }
    catch (err) { falhas.push({ email, op: 'add', erro: err.message }); }
  }
  for (const email of aRemover) {
    try { await removeFromResendAudience(env, email); removidos.push(email); }
    catch (err) { falhas.push({ email, op: 'remove', erro: err.message }); }
  }

  return json({
    ok: true,
    audience: env.RESEND_AUDIENCE_ID,
    totalPilotos: pilotos.size,
    totalAudience: naAudience.size,
    adicionados,
    removidos,
    falhas,
  });
}

async function handleRemoveMember(env, email, auth) {
  if (!(await isAdmin(auth.email, env))) return json({ error: 'Apenas admin' }, 403);
  const target = email.toLowerCase();
  const list = await loadMembers(env);
  const next = list.filter((m) => m.email !== target);
  await saveMembers(env, next);
  // Garante saída da audience também (membro removido nunca pode permanecer lá).
  if (env.RESEND_AUDIENCE_ID) {
    try { await removeFromResendAudience(env, target); }
    catch (err) { console.error('remove audience falhou', target, err.message); }
  }
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
