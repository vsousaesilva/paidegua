#!/usr/bin/env node
/**
 * Reconcilia o Resend Audience configurado em RESEND_AUDIENCE_ID com a lista
 * atual de pilotos da extensão (membros em team:members com equipes contendo
 * 'extensao' e ativo !== false).
 *
 * Espelha em duas direções:
 *   - adiciona quem é piloto e não está na audience
 *   - remove da audience quem não é mais piloto
 *
 * Quem mexe na audience é o Worker (endpoint admin). Este script só dispara.
 *
 * Uso (a partir de docs/kanban-massificacao/):
 *
 *   # Pré-visualizar (não escreve nada na audience):
 *   PAIDEGUA_BEARER=<token-admin> \
 *     node scripts/sync-audience-resend.mjs --dry-run
 *
 *   # Disparo real:
 *   PAIDEGUA_BEARER=<token-admin> \
 *     node scripts/sync-audience-resend.mjs
 *
 * Como obter o token bearer:
 *   - Abra https://kanban.paidegua.ia.br, faça login como admin.
 *   - DevTools → Application → Local Storage → paidegua_kanban_token.
 *
 * Variáveis de ambiente:
 *   PAIDEGUA_BEARER   token bearer de um admin (obrigatório)
 *   PAIDEGUA_API      base da API (default https://kanban.paidegua.ia.br)
 */

const API_BASE = process.env.PAIDEGUA_API || 'https://kanban.paidegua.ia.br';
const BEARER = process.env.PAIDEGUA_BEARER;

function parseArgs() {
  const out = { dryRun: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run' || arg === '--dryRun') out.dryRun = true;
  }
  return out;
}

async function main() {
  if (!BEARER) {
    console.error('ERRO: defina PAIDEGUA_BEARER com um token admin.');
    process.exit(1);
  }
  const args = parseArgs();
  const payload = { dryRun: args.dryRun };

  console.log(`[sync-audience] POST ${API_BASE}/api/team/sync-audience`);
  console.log('  payload:', JSON.stringify(payload));

  const resp = await fetch(`${API_BASE}/api/team/sync-audience`, {
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
    const add = (data.aAdicionar || []).length;
    const rem = (data.aRemover || []).length;
    console.log(`\nDry-run — ${add} a adicionar · ${rem} a remover (pilotos=${data.totalPilotos}, audience=${data.totalAudience}). Rode sem --dry-run para aplicar.`);
  } else if (data) {
    const add = (data.adicionados || []).length;
    const rem = (data.removidos || []).length;
    const fal = (data.falhas || []).length;
    console.log(`\nAdicionados: ${add} · Removidos: ${rem} · Falhas: ${fal} · Pilotos: ${data.totalPilotos} · Audience: ${data.totalAudience}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
