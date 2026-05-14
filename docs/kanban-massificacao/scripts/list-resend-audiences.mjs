#!/usr/bin/env node
/**
 * Lista todas as audiences da conta Resend (id + nome + total de contatos)
 * usando a key informada em RESEND_API_KEY.
 *
 * Útil para identificar qual audience configurar em RESEND_AUDIENCE_ID quando
 * o painel web esconde o id na URL.
 *
 * Uso (a partir de docs/kanban-massificacao/):
 *
 *   set RESEND_API_KEY=re_...
 *   node scripts/list-resend-audiences.mjs
 */

const API_KEY = process.env.RESEND_API_KEY;

async function main() {
  if (!API_KEY) {
    console.error('ERRO: defina RESEND_API_KEY (a mesma com Full Access que está no Worker).');
    process.exit(1);
  }

  const resp = await fetch('https://api.resend.com/audiences', {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }

  if (!resp.ok) {
    console.error(`HTTP ${resp.status}:`, data);
    process.exit(2);
  }

  const audiences = Array.isArray(data?.data) ? data.data : [];
  console.log(`\n${audiences.length} audience(s) na conta:\n`);

  for (const a of audiences) {
    let total = '?';
    try {
      const r = await fetch(`https://api.resend.com/audiences/${a.id}/contacts`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (r.ok) {
        const j = await r.json();
        total = String((j.data || []).length);
      } else {
        total = `erro ${r.status}`;
      }
    } catch (err) {
      total = `erro ${err.message}`;
    }
    console.log(`  id:        ${a.id}`);
    console.log(`  name:      ${a.name}`);
    console.log(`  created:   ${a.created_at}`);
    console.log(`  contatos:  ${total}`);
    console.log('  ---');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
