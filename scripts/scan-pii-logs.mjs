#!/usr/bin/env node
/**
 * INFRA-15 — Scan estático de PII em logs (CI gate, LGPD).
 *
 * Procura por chamadas a console.{log|warn|error|info|debug|trace} cujo
 * argumento seja um template literal (`...`) contendo, dentro de uma
 * interpolação `${...}`, alguma variável de nome proibido (CPF, HTML cru
 * dos autos, número de processo).
 *
 * Falha o processo (exit code 1) se houver violação. CI gate em
 * .github/workflows/ci-extension.yml bloqueia merge.
 *
 * Para suprimir um caso legítimo (raro, justificar no PR), adicione um
 * comentário marker `// pii-allow` na MESMA linha do console.* call.
 *
 * Uso:
 *   node scripts/scan-pii-logs.mjs            # scan src/ (default)
 *   node scripts/scan-pii-logs.mjs src extra  # paths customizados
 *
 * Saída: cada violação como `arquivo:linha:col  console.METHOD com ${...termo...}`.
 *
 * Card: INFRA-15 (P0, fase F1 da massificação PJe nacional v2.0).
 * Origem: docs/manual-massificacao-pje.md §II.4 #7, §II.5.2.
 *
 * Limitações conhecidas:
 *   - Não cobre template literals multi-linha (matching baseado em linha única).
 *     Casos raros — se aparecer, refatorar para uma linha ou usar pii-allow.
 *   - Não cobre concatenação com `+` (ex.: `console.log('cpf=' + cpf)`).
 *     Convenção do projeto já usa template literals; FP raro.
 *   - Word-boundary (\\b) significa que `cpfBuscado` NÃO é detectado.
 *     Variações comuns estão na lista PROIBIDOS abaixo (cpfFormatado etc.);
 *     adicionar conforme necessário.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * Lista de identificadores proibidos dentro de `${...}` em logs de console.
 * Adicionar termo gera trabalho de revisão — fazer com cautela e PR dedicado.
 *
 * Nota deliberada sobre EXCLUSÕES:
 *   - `url` — muitos logs legítimos referenciam URLs (dev tooling, fetch
 *     diagnostics). FP alto. URLs com `ca` ou `idProcesso` embutidos são
 *     pegos pelos termos `ca`, `idProcesso`. Se `url` virar problema,
 *     reabrir discussão.
 *   - `ca` (chave de acesso PJe, 2 letras) — palavra muito curta;
 *     gera FP em variáveis legítimas (caCert, cache, calculo). Deixar
 *     fora; pegar via patterns mais específicos abaixo se necessário.
 */
const PROIBIDOS = [
  'cpf',
  'cpfCnpj',
  'cpfFormatado',
  'cpfDoAutor',
  'cpfDaParte',
  'htmlBruto',
  'htmlBytes',
  'htmlContent',
  'htmlPagina',
  'rawHtml',
  'numeroProcesso',
  'nrProcesso',
  'numeroProcessoCnj'
];

/** Termos que devem aparecer dentro de `${...}` para flagar como violação. */
const TERMOS_REGEX = new RegExp('\\b(' + PROIBIDOS.join('|') + ')\\b', 'i');

/** Match: console.METHOD( ... `template literal` ... */
const CONSOLE_REGEX = /console\.(log|warn|error|info|debug|trace)\s*\(\s*`([^`]*)/i;

/** Marker pra suprimir uma linha (uso raro, justificar). */
const ALLOW_MARKER = /\/\/\s*pii-allow\b/;

const EXTENSOES = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PASTAS_IGNORAR = new Set([
  'node_modules',
  'dist',
  '.git',
  '.cache',
  'versoes',
  'scripts' // não escanear este próprio script
]);

async function listarArquivos(diretorio) {
  const entradas = await readdir(diretorio, { withFileTypes: true });
  const arquivos = [];
  for (const e of entradas) {
    if (PASTAS_IGNORAR.has(e.name)) continue;
    const caminho = join(diretorio, e.name);
    if (e.isDirectory()) {
      arquivos.push(...(await listarArquivos(caminho)));
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf('.');
      const ext = dot >= 0 ? e.name.slice(dot) : '';
      if (EXTENSOES.has(ext)) arquivos.push(caminho);
    }
  }
  return arquivos;
}

function escanear(conteudo, caminho) {
  const linhas = conteudo.split('\n');
  const violacoes = [];
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (ALLOW_MARKER.test(linha)) continue;
    const match = CONSOLE_REGEX.exec(linha);
    if (!match) continue;
    const corpo = match[2];
    let inicio = 0;
    while (true) {
      const a = corpo.indexOf('${', inicio);
      if (a === -1) break;
      const b = corpo.indexOf('}', a + 2);
      if (b === -1) break;
      const interp = corpo.slice(a + 2, b);
      const termo = TERMOS_REGEX.exec(interp);
      if (termo) {
        violacoes.push({
          arquivo: caminho,
          linha: i + 1,
          coluna: match.index + 1,
          metodo: match[1],
          termo: termo[1],
          trecho: linha.trim().slice(0, 200)
        });
        break;
      }
      inicio = b + 1;
    }
  }
  return violacoes;
}

async function main() {
  const argDirs = process.argv.slice(2);
  const dirs = argDirs.length > 0 ? argDirs : ['src'];
  const targets = dirs.map((d) => resolve(REPO_ROOT, d));

  const arquivos = [];
  for (const t of targets) {
    try {
      const s = await stat(t);
      if (s.isDirectory()) {
        const lista = await listarArquivos(t);
        arquivos.push(...lista);
      } else if (s.isFile()) {
        arquivos.push(t);
      }
    } catch {
      console.error(`[scan-pii] ignorando alvo inexistente: ${t}`);
    }
  }

  console.log(`[scan-pii] escaneando ${arquivos.length} arquivo(s)...`);

  let violacoes = [];
  for (const arquivo of arquivos) {
    try {
      const conteudo = await readFile(arquivo, 'utf8');
      violacoes = violacoes.concat(escanear(conteudo, arquivo));
    } catch (err) {
      console.error(`[scan-pii] falha ao ler ${arquivo}:`, err.message);
    }
  }

  if (violacoes.length === 0) {
    console.log('[scan-pii] OK -- nenhuma violacao encontrada.');
    process.exit(0);
  }

  console.error(`\n[scan-pii] FALHA -- ${violacoes.length} violacao(oes) encontrada(s):\n`);
  for (const v of violacoes) {
    const rel = relative(REPO_ROOT, v.arquivo).split(sep).join('/');
    console.error(`  ${rel}:${v.linha}:${v.coluna}  console.${v.metodo} com '\${...${v.termo}...}'`);
    console.error(`    ${v.trecho}\n`);
  }
  console.error('Para suprimir um caso legitimo (raro), adicione "// pii-allow" na linha.');
  console.error('Termos proibidos: ' + PROIBIDOS.join(', '));
  process.exit(1);
}

main().catch((err) => {
  console.error('[scan-pii] erro inesperado:', err);
  process.exit(2);
});
