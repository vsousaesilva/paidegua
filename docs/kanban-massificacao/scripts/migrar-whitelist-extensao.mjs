#!/usr/bin/env node
/**
 * Migra a whitelist legada da extensão pAIdegua (Google Sheets via Apps Script)
 * para o KV `team:members` do Worker, com flag equipes inclui 'extensao'.
 *
 * Como funciona:
 *  1. Você exporta a planilha da whitelist como CSV (no Sheets:
 *     Arquivo → Fazer download → CSV) e salva em algum lugar.
 *  2. Roda este script informando o caminho do CSV e (opcionalmente) o
 *     caminho do snapshot atual de team:members exportado do KV.
 *  3. Ele faz o MERGE: e-mails que já existem no KV ganham 'extensao' adicionado
 *     às equipes; e-mails novos são criados como membros (papel='membro',
 *     equipes=['extensao'], ativo=true).
 *  4. Salva o resultado em scripts/team-members-after-migration.json
 *  5. Você sobe ao KV com:
 *       wrangler kv key put "team:members" \
 *         --path=scripts/team-members-after-migration.json \
 *         --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote
 *
 * Uso:
 *   node scripts/migrar-whitelist-extensao.mjs <caminho-do-csv> [caminho-team-members-atual.json]
 *
 * Se o segundo argumento não for passado, lê do arquivo padrão
 *   scripts/team-members-current.json
 * (que você pode gerar com:
 *    wrangler kv key get "team:members" \
 *      --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote \
 *      > scripts/team-members-current.json
 *  — o JSON vem como array direto.)
 *
 * Formato esperado do CSV (1ª linha = cabeçalho):
 *   email,nome,status,observacao
 *   ana@jfce.jus.br,Ana Souza,ativo,Piloto JEF
 *   bruno@trf5.jus.br,,ativo,
 *   carlos@jfpb.jus.br,Carlos,revogado,Saiu do Inovajus
 *
 * Apenas linhas com status="ativo" (case-insensitive) entram. As demais são
 * ignoradas com aviso.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function parseCSV(text) {
  // Parser leve. Não lida com aspas + vírgulas dentro do mesmo campo, mas
  // serve pra whitelists simples (e-mail, nome curto, status, anotação).
  // Para casos complexos, exporte como TSV ou trate manualmente.
  const linhas = text.split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return [];
  const cab = linhas[0].split(',').map((c) => c.trim().toLowerCase());
  const idx = (n) => cab.indexOf(n);
  const iEmail = idx('email');
  const iNome = idx('nome');
  const iStatus = idx('status');
  const iObs = idx('observacao');
  if (iEmail < 0) throw new Error('Coluna "email" obrigatória no CSV');

  return linhas.slice(1).map((l) => {
    const cols = l.split(',').map((c) => c.trim());
    return {
      email: cols[iEmail]?.toLowerCase() || '',
      nome: iNome >= 0 ? cols[iNome] || '' : '',
      status: iStatus >= 0 ? cols[iStatus]?.toLowerCase() || '' : 'ativo',
      observacao: iObs >= 0 ? cols[iObs] || '' : '',
    };
  }).filter((r) => r.email);
}

async function main() {
  const csvPath = process.argv[2];
  const currentPath = process.argv[3] || resolve(__dirname, 'team-members-current.json');
  if (!csvPath) {
    console.error('Uso: node migrar-whitelist-extensao.mjs <caminho-csv> [team-members-current.json]');
    process.exit(2);
  }

  const csvText = await readFile(csvPath, 'utf8');
  const linhas = parseCSV(csvText);
  console.log(`✓ CSV: ${linhas.length} linhas (todas)`);

  const ativos = linhas.filter((r) => r.status === 'ativo' || r.status === '');
  const ignorados = linhas.length - ativos.length;
  console.log(`  ${ativos.length} ativos, ${ignorados} ignorados (status != 'ativo')`);

  let atual = [];
  try {
    const raw = await readFile(currentPath, 'utf8');
    atual = JSON.parse(raw);
    if (!Array.isArray(atual)) throw new Error('current não é array');
    console.log(`✓ team:members atual: ${atual.length} membros`);
  } catch (err) {
    console.warn(`! Não consegui ler ${currentPath} (${err.message}). Continuo com lista vazia.`);
    atual = [];
  }

  const now = new Date().toISOString();
  const autor = 'migracao-extensao/' + now.slice(0, 10);
  let adicionados = 0;
  let promovidos = 0;
  let inalterados = 0;

  for (const reg of ativos) {
    const idx = atual.findIndex((m) => m.email.toLowerCase() === reg.email);
    if (idx < 0) {
      atual.push({
        email: reg.email,
        nome: reg.nome || reg.email.split('@')[0],
        papel: 'membro',
        equipes: ['extensao'],
        ativo: true,
        adicionadoEm: now,
        adicionadoPor: autor,
        observacao: reg.observacao || undefined,
      });
      adicionados++;
    } else {
      const m = atual[idx];
      const equipes = Array.isArray(m.equipes) ? m.equipes : ['kanban'];
      if (!equipes.includes('extensao')) {
        atual[idx] = {
          ...m,
          equipes: [...equipes, 'extensao'],
          atualizadoEm: now,
          atualizadoPor: autor,
        };
        promovidos++;
      } else {
        inalterados++;
      }
    }
  }

  const saida = resolve(__dirname, 'team-members-after-migration.json');
  await writeFile(saida, JSON.stringify(atual), 'utf8');

  console.log('');
  console.log('Resumo:');
  console.log(`  ${adicionados} adicionado(s) (novos membros equipes=['extensao'])`);
  console.log(`  ${promovidos} promovido(s) (já existia, ganhou flag 'extensao')`);
  console.log(`  ${inalterados} inalterado(s) (já tinha 'extensao')`);
  console.log(`  ${ignorados} ignorado(s) por status != ativo`);
  console.log('');
  console.log(`✓ Resultado salvo em ${saida} (${atual.length} membros)`);
  console.log('');
  console.log('Próximo passo (de docs/kanban-massificacao/):');
  console.log('  wrangler kv key put "team:members" \\');
  console.log('    --path=scripts/team-members-after-migration.json \\');
  console.log('    --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
