#!/usr/bin/env node
/**
 * Backfill manual dos GitHub Releases para versões v1.0.1 .. v1.6.2 que
 * foram publicadas na Chrome Web Store sem criar tag/Release no GitHub
 * (consequência do incidente v1.3.1, ver docs/publicacao-marketplace.md).
 *
 * Para cada versão na lista:
 *  1. Cria tag git via API (ref refs/tags/vX.Y.Z apontando para o SHA do bump).
 *  2. Cria GitHub Release apontando para a tag, com nota explicando que é
 *     backfill retroativo e que o asset é o zip que foi a produção.
 *  3. Faz upload do zip correspondente em versoes/ como asset.
 *
 * Idempotente: pula versões cuja tag ou Release já existe.
 *
 * Pré-requisitos:
 *  - GITHUB_TOKEN no env (PAT classic com scope `repo`, ou fine-grained com
 *    permission Contents: Read and write no repo paidegua).
 *  - Workflow .github/workflows/release-extension.yml DESATIVADO antes de
 *    rodar (renomear para .yml.disabled). Caso contrário, cada tag criada
 *    via API dispara o workflow e rebuilda em commits antigos (provavelmente
 *    falhando por mudanças nas deps/webpack).
 *
 * Uso (a partir da raiz do repo):
 *
 *   set GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
 *   node scripts\backfill-github-releases.mjs
 *
 * v1.1.0, v1.1.1 e v1.6.0 NÃO entram no backfill — têm zip em versoes/ mas
 * o commit de bump não aparece com 'vX.Y.Z' explícito no git log. Ficam só
 * como zip arquivado.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'vsousaesilva/paidegua';

const VERSIONS = [
  { v: '1.0.1', sha: 'd2c79b7', zip: 'versoes/dist v1.0.1.zip' },
  { v: '1.2.0', sha: '3186220', zip: 'versoes/dist v1.2.0.zip' },
  { v: '1.2.1', sha: '32fa881', zip: 'versoes/dist v1.2.1.zip' },
  { v: '1.3.2', sha: 'b4c2437', zip: 'versoes/dist v1.3.2.zip' },
  { v: '1.4.0', sha: '5f34510', zip: 'versoes/dist v1.4.0.zip' },
  { v: '1.5.0', sha: 'a5d64e8', zip: 'versoes/dist v1.5.0.zip' },
  { v: '1.5.1', sha: '3662d7e', zip: 'versoes/dist v1.5.1.zip' },
  { v: '1.6.1', sha: '6445027', zip: 'versoes/dist v1.6.1.zip' },
  { v: '1.6.2', sha: 'b618c53', zip: 'versoes/dist v1.6.2.zip' },
];

async function api(path, opts = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const resp = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  return { status: resp.status, ok: resp.ok, body: await resp.text() };
}

async function ensureTag(version, sha) {
  const ref = `refs/tags/v${version}`;
  const check = await api(`/repos/${REPO}/git/ref/tags/v${version}`);
  if (check.ok) {
    console.log(`  [tag] v${version} já existe — ok`);
    return;
  }
  const create = await api(`/repos/${REPO}/git/refs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, sha }),
  });
  if (!create.ok) throw new Error(`falha criar tag v${version}: ${create.status} ${create.body}`);
  console.log(`  [tag] v${version} criada → ${sha}`);
}

async function ensureRelease(version, sha, zipPath) {
  const tagName = `v${version}`;
  const check = await api(`/repos/${REPO}/releases/tags/${tagName}`);
  if (check.ok) {
    const existing = JSON.parse(check.body);
    if ((existing.assets || []).some((a) => a.name.includes(`v${version}`))) {
      console.log(`  [release] v${version} já existe com asset — pulando`);
      return existing;
    }
    console.log(`  [release] v${version} existe mas sem asset — só uploado zip`);
    await uploadAsset(existing.upload_url, version, zipPath);
    return existing;
  }
  const body = [
    `# v${version}`,
    '',
    'Release retroativo criado por backfill — versão publicada na Chrome Web Store em produção. O asset abaixo é o zip autoritativo (validado em produção, idêntico ao que foi para a CWS).',
    '',
    `Commit de bump: \`${sha}\``,
  ].join('\n');
  const create = await api(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tagName,
      target_commitish: sha,
      name: tagName,
      body,
      draft: false,
      prerelease: false,
      make_latest: 'false',
    }),
  });
  if (!create.ok) throw new Error(`falha criar release v${version}: ${create.status} ${create.body}`);
  const release = JSON.parse(create.body);
  console.log(`  [release] v${version} criada → id ${release.id}`);
  await uploadAsset(release.upload_url, version, zipPath);
  return release;
}

async function uploadAsset(uploadUrlTemplate, version, zipPath) {
  const assetName = `dist v${version}.zip`;
  const url = uploadUrlTemplate.replace('{?name,label}', `?name=${encodeURIComponent(assetName)}`);
  const zipBuf = await readFile(zipPath);
  const upload = await api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: zipBuf,
  });
  if (!upload.ok) throw new Error(`falha upload asset v${version}: ${upload.status} ${upload.body}`);
  console.log(`  [asset] ${assetName} → ${zipBuf.length} bytes`);
}

async function main() {
  if (!TOKEN) {
    console.error('ERRO: defina GITHUB_TOKEN (PAT classic com scope repo, ou fine-grained com Contents: Write).');
    process.exit(1);
  }
  console.log(`Backfill GitHub Releases — ${REPO}`);
  console.log(`${VERSIONS.length} versões a processar.\n`);
  let ok = 0, falhas = 0;
  for (const v of VERSIONS) {
    console.log(`→ v${v.v} (commit ${v.sha})`);
    try {
      await ensureTag(v.v, v.sha);
      await ensureRelease(v.v, v.sha, resolve(v.zip));
      ok++;
    } catch (err) {
      console.error(`  FALHA em v${v.v}: ${err.message}`);
      falhas++;
    }
    console.log('');
  }
  console.log(`Fim. ok=${ok} falhas=${falhas}`);
  if (falhas > 0) process.exit(2);
}

main().catch((err) => { console.error(err); process.exit(1); });
