#!/usr/bin/env node
/**
 * Dispara o e-mail de boas-vindas para membros da equipe 'extensao' que
 * foram cadastrados nos últimos N dias e ainda não receberam (catch-up).
 *
 * O Worker faz tudo (lista members, envia via Resend, marca flag de
 * idempotência). Este script só chama o endpoint admin.
 *
 * Uso (a partir de docs/kanban-massificacao/):
 *
 *   # Pré-visualizar (não envia):
 *   PAIDEGUA_BEARER=<token-admin> \
 *     node scripts/enviar-welcome-extensao.mjs --dias=3 --dry-run
 *
 *   # Disparo real (últimos 3 dias):
 *   PAIDEGUA_BEARER=<token-admin> \
 *     node scripts/enviar-welcome-extensao.mjs --dias=3
 *
 *   # Reenviar para e-mails específicos (ignora janela e flag):
 *   PAIDEGUA_BEARER=<token-admin> \
 *     node scripts/enviar-welcome-extensao.mjs --emails=a@x.br,b@y.br --force
 *
 * Como obter o token bearer:
 *   - Abra https://kanban.paidegua.ia.br, faça login.
 *   - Em DevTools → Application → Local Storage, copie o valor de
 *     paidegua_kanban_token (ou similar).
 *
 * Variáveis de ambiente:
 *   PAIDEGUA_BEARER   token bearer de um admin (obrigatório)
 *   PAIDEGUA_API      base da API (default https://kanban.paidegua.ia.br)
 */

const API_BASE = process.env.PAIDEGUA_API || 'https://kanban.paidegua.ia.br';
const BEARER = process.env.PAIDEGUA_BEARER;

function parseArgs() {
  const out = { dias: 3, dryRun: false, force: false, emails: null };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'dias') out.dias = Number(v);
    else if (k === 'dry-run' || k === 'dryRun') out.dryRun = true;
    else if (k === 'force') out.force = true;
    else if (k === 'emails') out.emails = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

async function main() {
  if (!BEARER) {
    console.error('ERRO: defina PAIDEGUA_BEARER com um token admin.');
    process.exit(1);
  }
  const args = parseArgs();
  const payload = {
    dias: args.dias,
    force: args.force,
    dryRun: args.dryRun,
  };
  if (args.emails) payload.emails = args.emails;

  console.log(`[welcome-extensao] POST ${API_BASE}/api/team/welcome-extensao`);
  console.log('  payload:', JSON.stringify(payload));

  const resp = await fetch(`${API_BASE}/api/team/welcome-extensao`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BEARER}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }

  if (!resp.ok) {
    console.error(`HTTP ${resp.status}:`, data);
    process.exit(2);
  }

  console.log('\nResultado:');
  console.log(JSON.stringify(data, null, 2));

  if (data && data.dryRun) {
    console.log(`\nDry-run — ${data.totalAlvos} alvo(s). Rode sem --dry-run para enviar.`);
  } else if (data) {
    const enviados = (data.enviados || []).length;
    const falhas = (data.falhas || []).length;
    console.log(`\nEnviados: ${enviados} · Falhas: ${falhas} · Total alvos: ${data.totalAlvos}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
