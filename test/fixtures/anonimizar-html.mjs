#!/usr/bin/env node
/**
 * INFRA-13 — Anonimizador de HTML do `listAutosDigitais.seam`.
 *
 * Recebe um HTML bruto (capturado via DevTools → Network), aplica
 * substituições estruturais para PII e cospe HTML anonimizado pronto
 * para revisão manual + commit em `test/fixtures/listAutosDigitais/`.
 *
 * Uso (a partir da raiz do repo):
 *   node test/fixtures/anonimizar-html.mjs <input.html> > test/fixtures/listAutosDigitais/<nome-final>.html
 *
 * Stats das substituições vão para stderr (não poluem o output redirecionado).
 *
 * NÃO substitui nomes próprios automaticamente (FP alto sem AST). Sempre
 * REVISAR MANUALMENTE o output antes de commitar (instruções no README).
 *
 * Convenção: este script tem zero dependências (Node ESM puro) para
 * minimizar fricção. Pode rodar com qualquer Node 18+.
 *
 * Card: INFRA-13 (P0, F1 da massificação PJe nacional v2.0).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('uso: node test/fixtures/anonimizar-html.mjs <input.html> > <output.html>');
    process.exit(1);
  }

  const input = resolve(arg);
  let html;
  try {
    html = await readFile(input, 'utf8');
  } catch (err) {
    console.error(`Falha ao ler ${input}: ${err.message}`);
    process.exit(1);
  }

  const tamanhoOriginal = Buffer.byteLength(html, 'utf8');

  let out = html;
  const stats = {
    cpfFormatado: 0,
    cpfBruto: 0,
    cnpj: 0,
    processoCnj: 0,
    oab: 0,
    email: 0,
    telefone: 0
  };

  // CPF formatado: 000.000.000-00
  out = out.replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, () => {
    stats.cpfFormatado++;
    return '000.000.000-00';
  });

  // CPF não-formatado: precedido por "CPF" no contexto próximo
  // (evita FP em outros números de 11 dígitos, ex.: protocolos)
  out = out.replace(/(CPF[^0-9<]{0,15})(\d{11})\b/gi, (_m, prefixo) => {
    stats.cpfBruto++;
    return `${prefixo}00000000000`;
  });

  // CNPJ: 00.000.000/0001-00
  out = out.replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, () => {
    stats.cnpj++;
    return '00.000.000/0001-00';
  });

  // Número de processo CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO
  out = out.replace(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g, () => {
    stats.processoCnj++;
    return '0000000-00.0000.0.00.0000';
  });

  // OAB: OAB/UF NNNNN ou OAB UF NNNNN ou OAB-UF NNNNN
  out = out.replace(/\bOAB[\s\/-]*([A-Z]{2})[\s\/-]*(\d{3,7})\b/gi, () => {
    stats.oab++;
    return 'OAB/UF 000000';
  });

  // E-mail
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => {
    stats.email++;
    return 'parte@exemplo.com';
  });

  // Telefone formatado: (NN) NNNN-NNNN ou (NN) NNNNN-NNNN
  out = out.replace(/\(\d{2}\)\s*\d{4,5}[-\s]?\d{4}/g, () => {
    stats.telefone++;
    return '(00) 00000-0000';
  });

  // Saída — HTML limpo no stdout
  process.stdout.write(out);

  // Stats no stderr
  const tamanhoFinal = Buffer.byteLength(out, 'utf8');
  console.error('--- anonimizar-html.mjs ---');
  console.error(`Entrada:               ${input}`);
  console.error(`Tamanho original:      ${(tamanhoOriginal / 1024).toFixed(1)} KB`);
  console.error(`Tamanho anonimizado:   ${(tamanhoFinal / 1024).toFixed(1)} KB`);
  console.error('');
  console.error('Substituicoes feitas:');
  console.error(`  CPF formatado:       ${stats.cpfFormatado}`);
  console.error(`  CPF (bruto, c/ ctx): ${stats.cpfBruto}`);
  console.error(`  CNPJ:                ${stats.cnpj}`);
  console.error(`  Processo CNJ:        ${stats.processoCnj}`);
  console.error(`  OAB:                 ${stats.oab}`);
  console.error(`  E-mail:              ${stats.email}`);
  console.error(`  Telefone:            ${stats.telefone}`);
  console.error('');
  console.error('!! IMPORTANTE: revise MANUALMENTE o arquivo gerado antes de commitar.');
  console.error('   Nomes proprios NAO sao substituidos automaticamente. Procure por:');
  console.error('   - Nomes de partes (autor, reu) -> PARTE_AUTORA_001 / PARTE_RE_001');
  console.error('   - Nomes de advogados -> ADVOGADO_001');
  console.error('   - Nomes de magistrados/servidores -> MAGISTRADO_001 / SERVIDOR_001');
  console.error('   - Enderecos completos -> [ENDERECO_REMOVIDO]');
  console.error('   Veja test/fixtures/listAutosDigitais/README.md secao "Revisar manualmente".');
}

main().catch((err) => {
  console.error('Erro inesperado:', err);
  process.exit(2);
});
