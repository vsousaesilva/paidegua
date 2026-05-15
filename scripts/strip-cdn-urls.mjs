#!/usr/bin/env node
/**
 * Pós-processamento do dist/ para política MV3 da Chrome Web Store.
 *
 * O MV3 proíbe "remotely hosted code" — qualquer URL absoluta para
 * JavaScript externo no bundle dispara rejeição automatizada (Blue Argon),
 * mesmo se for dead code que nunca executamos.
 *
 * Caso real (v1.6.3, 14/05/2026): o `html2pdf.js` importa o `jsPDF`, que
 * tem uma feature opcional `pdfobjectnewwindow` referenciando
 * `https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js`
 * como string literal. Nunca chamamos essa feature, mas a string
 * sobrevive no bundle minificado → rejeição na CWS.
 *
 * Solução: este script varre dist/ e substitui qualquer URL para CDNs
 * públicos conhecidos por uma string inerte. Como o código que usaria
 * essas URLs nunca executa em runtime, a substituição é segura.
 *
 * Roda automaticamente após `npm run build` (chamado pelo build.bat).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(__dirname, '..', 'dist');

// CDNs públicos cujas URLs absolutas no bundle disparam o detector MV3.
// Substituímos pela string `blocked-mv3` que sinaliza no console se algum
// código tentar usar (não deve acontecer — é dead code).
const CDN_PATTERN = /https?:\/\/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|raw\.githubusercontent\.com|code\.jquery\.com|maxcdn\.bootstrapcdn\.com|cdn\.tailwindcss\.com)\/[^\s"'`)\\]+/g;
const REPLACEMENT = 'blocked-mv3';

/** Extensões de arquivo a processar (texto). */
const EXTS = /\.(m?js|html|css)$/i;

let totalReplacements = 0;
let totalFiles = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full);
    } else if (EXTS.test(entry)) {
      const orig = readFileSync(full, 'utf8');
      const matches = orig.match(CDN_PATTERN);
      if (!matches) continue;
      const next = orig.replace(CDN_PATTERN, REPLACEMENT);
      writeFileSync(full, next, 'utf8');
      totalReplacements += matches.length;
      totalFiles++;
      const uniq = [...new Set(matches)];
      console.log(`[strip-cdn-urls] ${full}: ${matches.length} URL(s)`);
      for (const u of uniq) console.log(`    - ${u}`);
    }
  }
}

console.log(`[strip-cdn-urls] varrendo ${DIST_DIR}`);
walk(DIST_DIR);
console.log(
  `[strip-cdn-urls] ${totalReplacements} substituicao(oes) em ${totalFiles} arquivo(s).`
);
