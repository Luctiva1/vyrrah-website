#!/usr/bin/env node
// Deploy to Vercel via API (project is not git-connected).
// Usage: VERCEL_TOKEN=... node scripts/deploy.mjs
// Uploads every git-tracked file to /v2/files, then creates a production
// deployment via /v13/deployments.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.VERCEL_TOKEN;
const TEAM = 'team_sK83bItKYwFbqE5r48AoNQ78';
const PROJECT = 'prj_Tl99JpWlK191BXx8ey8z311MCuKT';
const NAME = 'vyrrah-website';

if (!TOKEN) {
  console.error('VERCEL_TOKEN env var required');
  process.exit(1);
}

const EXCLUDE = /^(\.git\/|node_modules\/|\.env|\.claude\/|scripts\/)/;
const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(f => f && !EXCLUDE.test(f));

console.log(`Uploading ${files.length} files...`);

const manifest = [];
for (const file of files) {
  const buf = readFileSync(join(ROOT, file));
  const sha = createHash('sha1').update(buf).digest('hex');
  const size = statSync(join(ROOT, file)).size;
  const r = await fetch(`https://api.vercel.com/v2/files?teamId=${TEAM}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'x-vercel-digest': sha,
      'Content-Length': String(size)
    },
    body: buf
  });
  if (!r.ok && r.status !== 409) { // 409 = already uploaded
    console.error(`upload failed ${file}: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  manifest.push({ file, sha, size });
  console.log(`  ${file} (${size}b) ${r.status}`);
}

console.log('Creating deployment...');
const dep = await fetch(`https://api.vercel.com/v13/deployments?teamId=${TEAM}&skipAutoDetectionConfirmation=1`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: NAME,
    project: PROJECT,
    target: 'production',
    files: manifest,
    projectSettings: { framework: null }
  })
});
const data = await dep.json();
if (!dep.ok) {
  console.error('deployment failed:', JSON.stringify(data, null, 2));
  process.exit(1);
}
console.log(`Deployment created: ${data.id}`);
console.log(`URL: https://${data.url}`);

// poll until ready
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const s = await fetch(`https://api.vercel.com/v13/deployments/${data.id}?teamId=${TEAM}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const sd = await s.json();
  console.log(`  state: ${sd.readyState}`);
  if (sd.readyState === 'READY') {
    console.log('DEPLOYED. Aliases:', (sd.alias || []).join(', '));
    process.exit(0);
  }
  if (sd.readyState === 'ERROR' || sd.readyState === 'CANCELED') {
    console.error('Deployment failed:', sd.readyState);
    process.exit(1);
  }
}
console.error('Timed out waiting for deployment');
process.exit(1);
