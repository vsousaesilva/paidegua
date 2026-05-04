// @ts-check
/**
 * Gerador do seed TPU/CNJ para o banco `paidegua.tpu`.
 *
 * Lê o JSON exportado por `extract-tpu-from-pje.js` (script de console
 * documentado em `docs/`) e materializa em `src/shared/tpu-seed-data.ts`
 * o snapshot tipado dos movimentos processuais ativos do PJe TRF5.
 *
 * Uso:
 *   node scripts/build-tpu-seed.mjs <round1.json> [round2.json]
 *
 * O segundo arquivo (locais TRF5 isolados) é opcional e usado apenas
 * para validação cruzada da contagem.
 *
 * Princípios:
 *   - Determinístico: mesma entrada → mesma saída byte-a-byte (diff
 *     limpo entre versões da TPU).
 *   - Validação fail-fast: códigos duplicados, hierarquia quebrada,
 *     contagens divergentes abortam o build com mensagem específica.
 *   - Saída compacta mas legível (uma linha por movimento, ordenado
 *     por `codigoCnj`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(PROJECT_ROOT, 'src', 'shared', 'tpu-seed-data.ts');

// ─── 1. Argumentos ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error('Uso: node scripts/build-tpu-seed.mjs <round1.json> [round2.json]');
  process.exit(1);
}
const round1Path = argv[0];
const round2Path = argv[1] ?? null;

// ─── 2. Leitura + parsing tolerante ────────────────────────────────
function lerExtracao(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8').replace(/^﻿/, '');
  const obj = JSON.parse(raw);
  // O script de extração v1 deixou `movimentos` como string serializada
  // em alguns rounds; v2 já corrige. Tolerar ambos.
  const movs =
    typeof obj.movimentos === 'string'
      ? JSON.parse(obj.movimentos)
      : obj.movimentos;
  if (!Array.isArray(movs)) {
    throw new Error(`${filepath}: campo "movimentos" não é array nem string JSON.`);
  }
  return {
    extraidoEm: obj.extraidoEm,
    paginaPje: obj.paginaPje,
    totalEsperado: obj.totalEsperado,
    movimentos: movs
  };
}

console.log(`[tpu-seed] Lendo round 1: ${round1Path}`);
const round1 = lerExtracao(round1Path);
console.log(`           ${round1.movimentos.length}/${round1.totalEsperado} movimentos.`);

if (round1.movimentos.length !== round1.totalEsperado) {
  throw new Error(
    `Round 1: total coletado (${round1.movimentos.length}) ≠ esperado (${round1.totalEsperado}).`
  );
}

// ─── 3. Normalização para o shape MovimentoTpu ─────────────────────
function normalizar(raw) {
  return {
    codigoCnj: Number(raw.codigoCnj),
    descricao: String(raw.descricao ?? '').trim(),
    caminhoCompleto: String(raw.caminhoCompleto ?? '').trim(),
    caminhoCodigos: Array.isArray(raw.caminhoCodigos)
      ? raw.caminhoCodigos.map(Number)
      : [],
    superiorCodigoCnj:
      raw.superiorCodigoCnj == null ? null : Number(raw.superiorCodigoCnj),
    nivel: raw.nivel == null ? null : Number(raw.nivel),
    origem: raw.isSgt === true ? 'SGT' : 'TRF5',
    categorias: [],
    ativo: raw.ativo !== false,
    identificadorInternoPje:
      raw.identificadorInternoPje == null
        ? undefined
        : Number(raw.identificadorInternoPje)
  };
}

// Inclui ativos e inativos — inativos podem aparecer no histórico de
// processos antigos e precisam ser reconhecidos para classificação.
const movimentos = round1.movimentos.map(normalizar);

// ─── 4. Validações fail-fast ───────────────────────────────────────
const codigosVistos = new Map();
for (const m of movimentos) {
  if (codigosVistos.has(m.codigoCnj)) {
    throw new Error(
      `Código CNJ duplicado: ${m.codigoCnj} ` +
        `("${m.descricao}" e "${codigosVistos.get(m.codigoCnj).descricao}").`
    );
  }
  codigosVistos.set(m.codigoCnj, m);
}

// Hierarquia: superiorCodigoCnj deve apontar para um codigoCnj existente
// no catálogo, OU para null. Movimentos cujo superior está fora do
// catálogo (ex.: pai foi descontinuado) viram warning, não erro.
const superioresQuebrados = [];
for (const m of movimentos) {
  if (m.superiorCodigoCnj != null && !codigosVistos.has(m.superiorCodigoCnj)) {
    superioresQuebrados.push({
      codigoCnj: m.codigoCnj,
      descricao: m.descricao,
      superior: m.superiorCodigoCnj
    });
  }
}
if (superioresQuebrados.length > 0) {
  console.warn(
    `[tpu-seed] AVISO: ${superioresQuebrados.length} movimento(s) com superior fora do catálogo:`
  );
  for (const w of superioresQuebrados.slice(0, 10)) {
    console.warn(
      `  - ${w.codigoCnj} "${w.descricao}" → superior ${w.superior} (não existe)`
    );
  }
  if (superioresQuebrados.length > 10) {
    console.warn(`  ... e mais ${superioresQuebrados.length - 10}`);
  }
}

// Contagens
const totalSgt = movimentos.filter((m) => m.origem === 'SGT').length;
const totalLocal = movimentos.filter((m) => m.origem === 'TRF5').length;
const totalAtivos = movimentos.filter((m) => m.ativo).length;
const totalInativos = movimentos.length - totalAtivos;
console.log(
  `[tpu-seed] Origens: ${totalSgt} SGT + ${totalLocal} TRF5 = ${movimentos.length}`
);
console.log(
  `[tpu-seed] Status:  ${totalAtivos} ativos + ${totalInativos} inativos`
);

// Cross-check com round 2 (se fornecido). Round 2 deve ser subset do
// round 1 — todo código nele tem que existir no catálogo principal.
if (round2Path) {
  console.log(`[tpu-seed] Lendo round 2 (cross-check): ${round2Path}`);
  const round2 = lerExtracao(round2Path);
  const ausentes = [];
  for (const m of round2.movimentos) {
    if (!codigosVistos.has(Number(m.codigoCnj))) {
      ausentes.push(m.codigoCnj);
    }
  }
  if (ausentes.length > 0) {
    throw new Error(
      `Cross-check falhou: ${ausentes.length} códigos do round 2 ausentes do round 1: ` +
        ausentes.slice(0, 5).join(', ') +
        (ausentes.length > 5 ? ', ...' : '')
    );
  }
  console.log(
    `           OK — ${round2.movimentos.length} entradas do round 2 presentes no round 1.`
  );
}

// ─── 5. Ordenação determinística ───────────────────────────────────
movimentos.sort((a, b) => a.codigoCnj - b.codigoCnj);

// ─── 6. Geração do arquivo TS ──────────────────────────────────────
function emitirMovimentoLine(m) {
  const parts = [
    `codigoCnj:${m.codigoCnj}`,
    `descricao:${JSON.stringify(m.descricao)}`,
    `caminhoCompleto:${JSON.stringify(m.caminhoCompleto)}`,
    `caminhoCodigos:[${m.caminhoCodigos.join(',')}]`,
    `superiorCodigoCnj:${m.superiorCodigoCnj === null ? 'null' : m.superiorCodigoCnj}`,
    `nivel:${m.nivel === null ? 'null' : m.nivel}`,
    `origem:${JSON.stringify(m.origem)}`,
    `categorias:[]`,
    `ativo:${m.ativo}`
  ];
  if (m.identificadorInternoPje !== undefined) {
    parts.push(`identificadorInternoPje:${m.identificadorInternoPje}`);
  }
  return `  { ${parts.join(', ')} }`;
}

const linhas = movimentos.map(emitirMovimentoLine).join(',\n');

const header = `/**
 * Snapshot do catálogo TPU/CNJ reconhecido pelo PJe TRF5 1G.
 *
 * NÃO EDITAR À MÃO — gerado por \`scripts/build-tpu-seed.mjs\` a partir
 * do JSON exportado do PJe (\`/pje/Evento/listView.seam\`).
 *
 * Para regerar, ver instruções em \`docs/extracao-tpu-pje.md\` (TODO).
 *
 * Extraído em: ${round1.extraidoEm}
 * Origem:      ${round1.paginaPje}
 * Total:       ${movimentos.length} movimentos (${totalAtivos} ativos + ${totalInativos} inativos)
 *              ${totalSgt} SGT (nacionais) + ${totalLocal} TRF5 (locais)
 */

import type { MovimentoTpu, TpuSeedSnapshot } from './tpu-types';

const MOVIMENTOS: readonly MovimentoTpu[] = [
${linhas}
];

export const TPU_SEED: TpuSeedSnapshot = {
  extraidoEm: ${JSON.stringify(round1.extraidoEm)},
  paginaPje: ${JSON.stringify(round1.paginaPje)},
  total: ${movimentos.length},
  contagemPorOrigem: { SGT: ${totalSgt}, TRF5: ${totalLocal} },
  contagemPorStatus: { ativo: ${totalAtivos}, inativo: ${totalInativos} },
  movimentos: MOVIMENTOS
};
`;

fs.writeFileSync(OUT_PATH, header, 'utf8');
console.log(`[tpu-seed] Escrito: ${OUT_PATH}`);
console.log(`[tpu-seed] Tamanho: ${(header.length / 1024).toFixed(1)} KB`);
console.log(`[tpu-seed] OK.`);
