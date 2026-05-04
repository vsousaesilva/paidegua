#!/usr/bin/env node
/**
 * Importa todos os .md de docs/ (do repo paidegua) para docs:state do KV
 * do Worker paidegua-kanban-api. Gera um arquivo JSON pronto para
 * `wrangler kv key put "docs:state" --path=import-docs-state.json`.
 *
 * Uso:
 *   cd docs/kanban-massificacao/scripts
 *   node import-docs.mjs
 *
 * Saída: ./import-docs-state.json (na mesma pasta).
 *
 * Em seguida:
 *   wrangler kv key put "docs:state" --path=scripts/import-docs-state.json \
 *     --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote
 *
 * (rode dentro de docs/kanban-massificacao/)
 *
 * Reproduzível: cada arquivo gera um id estável (doc-<slug>) — rerodar não
 * duplica, sobrescreve com a versão atual do .md no repo.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DOCS_DIR = resolve(__dirname, '..', '..'); // → paidegua/docs/
const OUT_PATH = resolve(__dirname, 'import-docs-state.json');

// Tags por arquivo (curadoria mínima — facilita busca no Kanban).
const TAGS_POR_ARQUIVO = {
  'abrir-tarefa-pje-popup': ['pje', 'popup', 'tarefa', 'ux'],
  'arquitetura-coleta-prazos-na-fita': ['arquitetura', 'prazos-na-fita', 'pool', 'checkpoint'],
  'controle-metas-cnj': ['metas-cnj', 'roadmap', 'modulo', 'p0-p1'],
  'dtic-consulta-suporte-paidegua': ['dtic', 'suporte', 'institucional'],
  'extracao-conteudo-pje': ['pje', 'extracao', 'dom-scraping', 'ocr'],
  'extracao-tarefas-painel-pje': ['pje', 'extracao', 'painel', 'rest'],
  'extracao-tpu-pje': ['pje', 'tpu', 'extracao', 'siglas'],
  'index': ['lgpd', 'privacidade', 'res-615', 'compliance', 'autoridade'],
  'injecao-minuta-editor-badon': ['pje', 'minuta', 'editor', 'badon'],
  'manual-instalacao-uso': ['manual', 'instalacao', 'uso', 'usuario-final', 'autoridade'],
  'manual-massificacao-pje': ['manual', 'massificacao', 'roadmap', 'f1-f7', 'autoridade'],
  'modo-rapido-rest-flag': ['modo-rapido', 'rest', 'flag', 'performance'],
  'post-mortem-prazos-na-fita': ['post-mortem', 'incidente', 'prazos-na-fita', 'abr-2026'],
  'publicacao-marketplace': ['marketplace', 'release', 'chrome-web-store'],
  'recuperacao-versoes-github': ['github', 'release', 'versoes'],
  'telemetria-local-e-escala': ['telemetria', 'lgpd', 'escala'],
};

function tituloDoMarkdown(md, fallback) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (m) {
    const tm = m[1].match(/^title:\s*(.+)$/m);
    if (tm) return tm[1].trim().replace(/^["']|["']$/g, '');
  }
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
}

async function main() {
  const arquivos = (await readdir(DOCS_DIR))
    .filter((n) => n.endsWith('.md'))
    .sort();

  const items = [];
  const now = new Date().toISOString();
  const autor = `import-docs/${now.slice(0, 10)}`;

  // Documento 0: índice apontando para a fonte canônica
  items.push({
    id: 'doc-00-indice',
    titulo: '📋 Bem-vindo aos Documentos do projeto',
    tags: ['indice', 'leia-primeiro'],
    conteudo: [
      '# 📋 Documentos do pAIdegua',
      '',
      'Espelho dos arquivos `.md` em `docs/` do repo `vsousaesilva/paidegua`.',
      'Atualizado por `scripts/import-docs.mjs` — re-rodar sobrescreve.',
      '',
      `Última importação: **${now}**.`,
      '',
      '## Como funciona',
      '',
      '- A fonte da verdade continua sendo o repositório no GitHub.',
      '- Esta lista é uma **cópia consultável dentro do Kanban**, com busca por tag e título.',
      '- Edição feita aqui no Kanban **não** vai pro Git — fica só no KV. Para alterar de forma duradoura, edite no repo e rode `node scripts/import-docs.mjs` + `wrangler kv key put`.',
      '',
      '## Convenções',
      '',
      '- Markdown puro, mesmo do repo.',
      '- Tags em kebab-case minúsculo.',
      '- Documentos com tag `autoridade` = fonte normativa do projeto (manual, política, massificação).',
      '',
      '## O que NÃO colocar aqui',
      '',
      '- ❌ Senhas, API keys, tokens → vão no **🔐 Cofre**.',
      '- ❌ Conteúdo de processos judiciais (CPF, partes) → fora de escopo desta ferramenta.',
      '- ❌ Notas pessoais de servidores → use seu próprio Drive.',
      '',
      '## Backup',
      '',
      '```cmd',
      'wrangler kv key get "docs:state" --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote > backup-docs.json',
      '```',
    ].join('\n'),
    criadoEm: now,
    criadoPor: autor,
    atualizadoEm: now,
    atualizadoPor: autor,
  });

  for (const arq of arquivos) {
    const slug = basename(arq, extname(arq));
    const caminho = resolve(DOCS_DIR, arq);
    const conteudo = await readFile(caminho, 'utf8');
    const tituloRaw = tituloDoMarkdown(conteudo, slug);
    const tituloPrefix = `📄 ${tituloRaw} (docs/${arq})`;
    items.push({
      id: `doc-${slug}`,
      titulo: tituloPrefix,
      tags: TAGS_POR_ARQUIVO[slug] || ['paidegua'],
      conteudo: conteudo,
      criadoEm: now,
      criadoPor: autor,
      atualizadoEm: now,
      atualizadoPor: autor,
    });
  }

  const board = {
    items,
    atualizadoEm: now,
    atualizadoPor: autor,
  };

  await writeFile(OUT_PATH, JSON.stringify(board), 'utf8');

  console.log(`✓ ${items.length} documentos exportados em ${OUT_PATH}`);
  console.log(`  Tamanho: ${(JSON.stringify(board).length / 1024).toFixed(1)} KB`);
  console.log('');
  console.log('Para subir ao KV (a partir de docs/kanban-massificacao/):');
  console.log('  wrangler kv key put "docs:state" \\');
  console.log('    --path=scripts/import-docs-state.json \\');
  console.log('    --namespace-id=9002dc0915f84842bf98ea894257d0a9 --remote');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
