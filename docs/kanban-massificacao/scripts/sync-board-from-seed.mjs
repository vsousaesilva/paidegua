#!/usr/bin/env node
/**
 * Gera scripts/board-after-sync.json a partir do seed.json atual,
 * pronto para subir ao KV via wrangler kv key put board:state.
 *
 * Útil quando edicoes manuais no seed.json (sprint planning, movimentacao
 * de cards via commit) precisam ser refletidas no Kanban em producao.
 *
 * ATENCAO: sobrescreve o board:state inteiro. Movimentacoes feitas pela
 * UI desde a ultima sincronizacao SAO PERDIDAS. Se houver duvida, faca
 * backup antes:
 *
 *   wrangler kv key get "board:state" \
 *     --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote \
 *     > scripts/board-backup-YYYY-MM-DD.json
 *
 * Uso (a partir de docs/kanban-massificacao/):
 *   node scripts/sync-board-from-seed.mjs
 *
 * Saida: scripts/board-after-sync.json
 *
 * Em seguida:
 *   wrangler kv key put "board:state" \
 *     --path=scripts/board-after-sync.json \
 *     --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SEED = resolve(__dirname, '..', 'seed.json');
const OUT = resolve(__dirname, 'board-after-sync.json');

async function main() {
  const seed = JSON.parse(await readFile(SEED, 'utf8'));
  const now = new Date().toISOString();
  const boardState = {
    cards: seed.cards,
    colunas: seed.colunas,
    categorias: seed.categorias,
    prioridades: seed.prioridades,
    lanes: seed.lanes || [],
    atualizadoEm: now,
    atualizadoPor: 'sync-board-from-seed/' + now.slice(0, 10),
  };
  await writeFile(OUT, JSON.stringify(boardState), 'utf8');
  console.log(`✓ ${OUT}`);
  console.log(`  cards: ${seed.cards.length}`);
  const porColuna = {};
  seed.cards.forEach((c) => { porColuna[c.coluna] = (porColuna[c.coluna] || 0) + 1; });
  console.log('  por coluna:', porColuna);
  console.log('');
  console.log('Para subir ao KV (a partir de docs/kanban-massificacao/):');
  console.log('  wrangler kv key put "board:state" \\');
  console.log('    --path=scripts/board-after-sync.json \\');
  console.log('    --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote');
}

main().catch((err) => { console.error(err); process.exit(1); });
