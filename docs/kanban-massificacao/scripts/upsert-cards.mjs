/**
 * Envia cards ao Kanban um a um, via `PUT /api/cards/{id}` (upsert).
 *
 * POR QUE NÃO USAR O "IMPORTAR" DO PAINEL: aquele botão chama
 * `POST /api/board/replace`, que substitui o quadro INTEIRO. Importar um
 * arquivo contendo apenas os cards novos apagaria todo o restante do board.
 * O endpoint por card é aditivo e preserva o que já existe.
 *
 * O servidor cuida do histórico automaticamente: registra "criado" quando o
 * card é novo e "movido" quando a coluna muda. Não envie `historico` à mão.
 *
 * Uso (cmd.exe):
 *   set KANBAN_TOKEN=<token>
 *   "C:\Portatil\node-v24.16.0-win-x64\node.exe" upsert-cards.mjs cards-doc-site-2026-07-19.json
 *
 * Acrescente --dry-run para apenas listar o que seria enviado, sem gravar.
 */

import { readFile } from 'node:fs/promises';

const API = 'https://kanban.paidegua.ia.br/api/cards';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const arquivo = args.find((a) => !a.startsWith('--'));

if (!arquivo) {
  console.error('Informe o arquivo JSON com os cards.');
  process.exit(1);
}

const token = process.env.KANBAN_TOKEN;
if (!token && !dryRun) {
  console.error(
    'Defina KANBAN_TOKEN antes de rodar. No Kanban logado, abra o console do\n' +
      'navegador (F12) e execute:\n\n' +
      "  localStorage.getItem('paidegua_kanban_token')\n"
  );
  process.exit(1);
}

const cards = JSON.parse(await readFile(arquivo, 'utf8'));
if (!Array.isArray(cards)) {
  console.error('O arquivo deve conter um array de cards.');
  process.exit(1);
}

console.log(`${cards.length} card(s) em ${arquivo}${dryRun ? ' (simulação)' : ''}\n`);

let ok = 0;
let falhas = 0;

for (const card of cards) {
  if (!card?.id) {
    console.error('  card sem id — ignorado');
    falhas++;
    continue;
  }

  if (dryRun) {
    console.log(`  [simulado] ${card.id} → coluna "${card.coluna}"  ${card.titulo}`);
    ok++;
    continue;
  }

  // `atualizadoPor` fica no card para dar rastro de origem no histórico do board.
  const corpo = {
    ...card,
    atualizadoPor: card.atualizadoPor ?? 'sessao/2026-07-19-site-manual'
  };

  try {
    const resp = await fetch(`${API}/${encodeURIComponent(card.id)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(corpo)
    });

    if (resp.ok) {
      console.log(`  ok  ${card.id} → "${card.coluna}"`);
      ok++;
    } else {
      const texto = await resp.text().catch(() => '');
      console.error(`  ERRO ${card.id} — HTTP ${resp.status} ${texto}`);
      falhas++;
    }
  } catch (err) {
    console.error(`  ERRO ${card.id} — ${err.message}`);
    falhas++;
  }
}

console.log(`\n${ok} enviado(s), ${falhas} com falha.`);
process.exit(falhas > 0 ? 1 : 0);
