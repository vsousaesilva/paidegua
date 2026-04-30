/**
 * pAIdegua — Backend de Autenticação (Google Apps Script)
 * ========================================================
 *
 * Tres endpoints expostos via Web App, todos POST com JSON em text/plain:
 *
 *   { action: 'requestCode', email }
 *     → { ok: true } | { ok: false, error }
 *
 *   { action: 'verifyCode', email, code }
 *     → { ok: true, jwt, email, expiresAt } | { ok: false, error }
 *
 *   { action: 'me', jwt }
 *     → { ok: true, email, expiresAt } | { ok: false, error }
 *
 * Codigos de erro previstos:
 *   invalid_email | not_whitelisted | rate_limited |
 *   missing_fields | no_code | expired | wrong_code |
 *   too_many_attempts | invalid_jwt | revoked | server_error
 *
 * --------------------------------------------------------
 * Setup (uma vez)
 * --------------------------------------------------------
 *
 * 1. Crie uma planilha Google nova. Renomeie a primeira aba para
 *    "Whitelist" e adicione cabecalhos:
 *      A1 = email
 *      B1 = active   (TRUE / FALSE)
 *      C1 = added_at (data ISO)
 *      D1 = notes    (livre — quem autorizou, unidade, etc.)
 *
 * 2. No menu da planilha, va em Extensoes -> Apps Script. Apague o
 *    `Code.gs` padrao e cole este arquivo. Salve.
 *
 * 3. Em Configuracoes do projeto -> Propriedades do script, adicione:
 *      JWT_SECRET = <string aleatoria de 32+ caracteres>
 *      SHEET_ID   = <ID da planilha — esta na URL da planilha>
 *      ADMIN_EMAIL = <opcional — recebe copia em caso de erro>
 *
 *    Para gerar um secret robusto, rode em qualquer terminal:
 *      node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
 *
 * 4. Implantar -> Nova implantacao -> Tipo: Web App.
 *      - Descricao: "pAIdegua auth v1"
 *      - Executar como: Eu (a conta do Inovajus)
 *      - Quem pode acessar: Qualquer pessoa
 *    Copie a URL gerada — ela termina em ".../exec".
 *
 * 5. Cole essa URL em src/shared/auth-config.ts (campo BACKEND_URL).
 *
 * 6. Para autorizar usuarios, adicione linhas na planilha. Exemplo:
 *      vsousaesilva@trf5.jus.br | TRUE | 2026-04-29 | Inovajus / piloto
 *    Para revogar, basta marcar B como FALSE ou apagar a linha — a
 *    proxima chamada de /me devolvera "revoked" e a extensao fara logout.
 */

// ------------------------------------------------------------------
// Configuracao fixa
// ------------------------------------------------------------------

var ALLOWED_DOMAINS = [
  'trf5.jus.br',
  'jfce.jus.br',
  'jfrn.jus.br',
  'jfpb.jus.br',
  'jfpe.jus.br',
  'jfal.jus.br',
  'jfse.jus.br'
];

var CODE_TTL_MIN = 10;
var MAX_CODE_ATTEMPTS = 5;
var REQUEST_THROTTLE_SEC = 60;
var JWT_TTL_DAYS = 90;

// ------------------------------------------------------------------
// HTTP entrypoints
// ------------------------------------------------------------------

function doGet(e) {
  return jsonResponse({ ok: true, service: 'paidegua-auth', version: 1 });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = String(body.action || '');
    switch (action) {
      case 'requestCode': return jsonResponse(handleRequestCode(body));
      case 'verifyCode':  return jsonResponse(handleVerifyCode(body));
      case 'me':          return jsonResponse(handleMe(body));
      default:            return jsonResponse({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    notifyAdmin('doPost', err);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------

function handleRequestCode(body) {
  var email = normalizeEmail(body.email);
  if (!email || !isDomainAllowed(email)) {
    return { ok: false, error: 'invalid_email' };
  }
  if (!isWhitelisted(email)) {
    return { ok: false, error: 'not_whitelisted' };
  }
  // Rate limit por email — evita abuso e custo de envio.
  var props = PropertiesService.getScriptProperties();
  var lastKey = 'lastReq:' + email;
  var lastRaw = props.getProperty(lastKey);
  var now = Date.now();
  if (lastRaw) {
    var last = Number(lastRaw);
    if (!isNaN(last) && now - last < REQUEST_THROTTLE_SEC * 1000) {
      return { ok: false, error: 'rate_limited' };
    }
  }
  props.setProperty(lastKey, String(now));

  var code = generateCode();
  var expiresAt = now + CODE_TTL_MIN * 60 * 1000;
  props.setProperty(
    'otp:' + email,
    JSON.stringify({ code: code, expiresAt: expiresAt, attempts: 0 })
  );

  MailApp.sendEmail({
    to: email,
    name: 'Inovajus/JFCE',
    subject: 'pAIdegua — codigo de acesso',
    body:
      'Seu codigo de acesso ao pAIdegua e: ' + code + '\n\n' +
      'Validade: ' + CODE_TTL_MIN + ' minutos. Maximo de ' +
      MAX_CODE_ATTEMPTS + ' tentativas.\n\n' +
      'Se voce nao solicitou este codigo, ignore este e-mail.\n\n' +
      'Justica Federal — Inovajus / pAIdegua'
  });

  return { ok: true };
}

function handleVerifyCode(body) {
  var email = normalizeEmail(body.email);
  var code = String(body.code || '').trim();
  if (!email || !code) return { ok: false, error: 'missing_fields' };

  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('otp:' + email);
  if (!raw) return { ok: false, error: 'no_code' };

  var stored;
  try { stored = JSON.parse(raw); } catch (e) { stored = null; }
  if (!stored) {
    props.deleteProperty('otp:' + email);
    return { ok: false, error: 'no_code' };
  }

  if (Date.now() > stored.expiresAt) {
    props.deleteProperty('otp:' + email);
    return { ok: false, error: 'expired' };
  }
  if ((stored.attempts || 0) >= MAX_CODE_ATTEMPTS) {
    props.deleteProperty('otp:' + email);
    return { ok: false, error: 'too_many_attempts' };
  }
  if (stored.code !== code) {
    stored.attempts = (stored.attempts || 0) + 1;
    props.setProperty('otp:' + email, JSON.stringify(stored));
    return { ok: false, error: 'wrong_code' };
  }

  // Defesa em profundidade: re-verifica whitelist no momento da troca.
  if (!isWhitelisted(email)) {
    props.deleteProperty('otp:' + email);
    return { ok: false, error: 'not_whitelisted' };
  }

  props.deleteProperty('otp:' + email);
  var nowSec = Math.floor(Date.now() / 1000);
  var expSec = nowSec + JWT_TTL_DAYS * 24 * 60 * 60;
  var jwt = signJwt({ sub: email, iat: nowSec, exp: expSec });
  return { ok: true, jwt: jwt, email: email, expiresAt: expSec * 1000 };
}

function handleMe(body) {
  var jwt = String(body.jwt || '').trim();
  if (!jwt) return { ok: false, error: 'missing_jwt' };
  var payload = verifyJwt(jwt);
  if (!payload) return { ok: false, error: 'invalid_jwt' };
  var email = String(payload.sub || '').toLowerCase();
  // Revogacao: a planilha e a fonte da verdade. Se o email foi removido
  // ou desativado, o token ainda assinado deixa de ser aceito.
  if (!isWhitelisted(email)) return { ok: false, error: 'revoked' };
  return { ok: true, email: email, expiresAt: payload.exp * 1000 };
}

// ------------------------------------------------------------------
// Whitelist (planilha)
// ------------------------------------------------------------------

function getWhitelistSheet_() {
  var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) throw new Error('SHEET_ID nao configurado');
  var ss = SpreadsheetApp.openById(sheetId);
  var sheet = ss.getSheetByName('Whitelist');
  if (!sheet) throw new Error('Aba "Whitelist" nao encontrada');
  return sheet;
}

function isWhitelisted(email) {
  var sheet = getWhitelistSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var i = 0; i < data.length; i++) {
    var rowEmail = String(data[i][0] || '').trim().toLowerCase();
    var activeRaw = data[i][1];
    var active =
      activeRaw === true ||
      String(activeRaw).toUpperCase() === 'TRUE' ||
      String(activeRaw) === '1';
    if (rowEmail === email && active) return true;
  }
  return false;
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function isDomainAllowed(email) {
  var idx = email.lastIndexOf('@');
  if (idx < 0) return false;
  var domain = email.slice(idx + 1);
  for (var i = 0; i < ALLOWED_DOMAINS.length; i++) {
    if (ALLOWED_DOMAINS[i] === domain) return true;
  }
  return false;
}

// ------------------------------------------------------------------
// JWT (HS256)
// ------------------------------------------------------------------

function getJwtSecret_() {
  var secret = PropertiesService.getScriptProperties().getProperty('JWT_SECRET');
  if (!secret || secret.length < 16) throw new Error('JWT_SECRET ausente ou curto demais');
  return secret;
}

function base64UrlEncode_(input) {
  var encoded;
  if (typeof input === 'string') {
    encoded = Utilities.base64EncodeWebSafe(input, Utilities.Charset.UTF_8);
  } else {
    encoded = Utilities.base64EncodeWebSafe(input);
  }
  return encoded.replace(/=+$/, '');
}

function base64UrlDecodeToString_(s) {
  var pad = (4 - (s.length % 4)) % 4;
  var padded = s + new Array(pad + 1).join('=');
  var bytes = Utilities.base64DecodeWebSafe(padded);
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}

function signJwt(payload) {
  var header = { alg: 'HS256', typ: 'JWT' };
  var headerB64 = base64UrlEncode_(JSON.stringify(header));
  var payloadB64 = base64UrlEncode_(JSON.stringify(payload));
  var data = headerB64 + '.' + payloadB64;
  var sig = Utilities.computeHmacSha256Signature(data, getJwtSecret_());
  return data + '.' + base64UrlEncode_(sig);
}

function verifyJwt(token) {
  var parts = String(token).split('.');
  if (parts.length !== 3) return null;
  var data = parts[0] + '.' + parts[1];
  var expectedSig = base64UrlEncode_(
    Utilities.computeHmacSha256Signature(data, getJwtSecret_())
  );
  if (expectedSig !== parts[2]) return null;
  try {
    var payload = JSON.parse(base64UrlDecodeToString_(parts[1]));
    if (!payload || !payload.exp) return null;
    if (Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------
// Utilitarios
// ------------------------------------------------------------------

function generateCode() {
  // 6 digitos, sempre com o primeiro != 0 para nao perder em copia/cola.
  var n = Math.floor(100000 + Math.random() * 900000);
  return String(n);
}

function notifyAdmin(context, err) {
  try {
    Logger.log('[' + context + '] ' + (err && err.stack ? err.stack : err));
    var admin = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
    if (!admin) return;
    MailApp.sendEmail({
      to: admin,
      subject: 'pAIdegua auth — erro em ' + context,
      body: String(err && err.stack ? err.stack : err)
    });
  } catch (_) {
    // engole — nao deixar erro de notificacao mascarar o erro original
  }
}

// ------------------------------------------------------------------
// Diagnostico (use no editor do Apps Script para validar o setup)
// ------------------------------------------------------------------

function diag() {
  var props = PropertiesService.getScriptProperties();
  Logger.log('JWT_SECRET configurado? ' + Boolean(props.getProperty('JWT_SECRET')));
  Logger.log('SHEET_ID configurado?   ' + Boolean(props.getProperty('SHEET_ID')));
  try {
    var s = getWhitelistSheet_();
    Logger.log('Planilha OK. Linhas: ' + s.getLastRow());
  } catch (e) {
    Logger.log('Planilha FALHOU: ' + e.message);
  }
}
