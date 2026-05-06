#!/usr/bin/env node
/**
 * Regenera `seed.js` a partir de `seed.json`.
 *
 * O kanban tem dois modos de carregar o backlog inicial:
 *   - HTTP (servidor local ou Cloudflare Pages): fetch direto em `seed.json`.
 *   - file:// (abrir `index.html` clicando duas vezes): fetch é bloqueado por
 *     CORS/origin null. Nesse caso o `kanban.js` lê de `window.__PAIDEGUA_SEED__`,
 *     que é populado pelo `seed.js` carregado no `<script>` da página.
 *
 * Toda vez que `seed.json` muda (sprint planning, edição manual, criação de cards
 * via Claude Code) é necessário regerar `seed.js` para que o modo file:// reflita.
 *
 * Uso (a partir de docs/kanban-massificacao/):
 *   node scripts/regenerar-seed-js.mjs
 *
 * Ou pelo `.bat` wrapper:
 *   regenerar-seed-js.bat
 *
 * Saída: `seed.js` atualizado.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SEED_JSON = resolve(__dirname, '..', 'seed.json');
const SEED_JS = resolve(__dirname, '..', 'seed.js');

async function main() {
  const raw = await readFile(SEED_JSON, 'utf8');
  const data = JSON.parse(raw);

  if (!Array.isArray(data?.cards) || !Array.isArray(data?.colunas)) {
    throw new Error('seed.json com schema inválido (esperado { colunas: [], cards: [], ... }).');
  }

  const header =
    '// Auto-gerado a partir de seed.json — fallback para uso em file:// onde fetch é bloqueado.\n' +
    `// Última regeração: ${new Date().toISOString()}\n` +
    '// Para regerar manualmente: regenerar-seed-js.bat (ou node scripts/regenerar-seed-js.mjs).\n';

  // JSON inline em uma única linha — formato idêntico ao histórico do arquivo.
  const body = `window.__PAIDEGUA_SEED__ = ${JSON.stringify(data)};\n`;

  await writeFile(SEED_JS, header + body, 'utf8');

  const tamanhoKb = (Buffer.byteLength(body, 'utf8') / 1024).toFixed(1);
  console.log(`✓ seed.js regenerado (${tamanhoKb} KB).`);
  console.log(`  ${data.cards.length} cards · ${data.colunas.length} colunas`);
  console.log('');
  console.log('Próximo passo:');
  console.log('  Abra (ou recarregue) o index.html no navegador.');
  console.log('  ⚠ Se você já abriu antes em file://, o localStorage tem uma cópia antiga.');
  console.log('     Limpe em DevTools > Application > Storage > Clear site data,');
  console.log('     ou abra em janela anônima.');
}

main().catch((e) => {
  console.error('💥 Falha:', e.message);
  process.exit(1);
});
