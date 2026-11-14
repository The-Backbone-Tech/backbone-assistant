import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';

const homes: string[] = [];
after(async () => { for (const h of homes) await removeDataHome(h); });
async function doctor(home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, BACKBONE_HARNESS: 'stub' }; delete env.BACKBONE_KEYS;
  // A regression in selection must fail safely, before any platform tool can reach the login store.
  const guard = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const original=cp.spawn; cp.spawn=function(file,...args) {
      if (file==='/usr/bin/security'||file==='/usr/bin/secret-tool') throw new Error('Doctor test refused real store access');
      return original.call(this,file,...args);
    }; syncBuiltinESMExports();`;
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(guard), new URL('../src/main.ts', import.meta.url).pathname, 'doctor', '--home', home, '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.once('close', r));
  assert.ok(out, err);
  const result = JSON.parse(out);
  return { code, result, keys: result.checks.find((c: { name: string }) => c.name === 'keys') };
}

test('doctor names plaintext even with no key choice; it stays plaintext', async () => {
  const h = freshDataHome('doctor-keys'); homes.push(h);
  const made = spawnSync(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, 'projects', 'create', 'Doctor fixture', '--home', h], { encoding: 'utf8', env: { ...process.env, BACKBONE_KEYS: 'plaintext', BACKBONE_HARNESS: 'stub' } });
  assert.equal(made.status, 0, made.stderr);
  const path = join(h, 'keys', 'vault.json'), before = readFileSync(path);
  const d = await doctor(h);
  assert.equal(d.code, 0); assert.equal(d.keys.status, 'warn'); assert.match(d.keys.detail, /plaintext.*none/);
  assert.deepEqual(readFileSync(path), before);
});

for (const wrap of ['os-keyring-v1', 'electron-safeStorage']) test(`doctor reports recorded ${wrap} without accessing a key store`, async () => {
  const h = mkdtempSync(join(tmpdir(), 'backbone-doctor-provider-')); homes.push(h);
  mkdirSync(join(h, 'keys'));
  const path = join(h, 'keys', 'vault.json');
  writeFileSync(path, JSON.stringify({ format: 1, holder: 'keychain', wrap }));
  const before = readFileSync(path), d = await doctor(h);
  assert.equal(d.keys.status, 'ok'); assert.match(d.keys.detail, new RegExp(wrap));
  assert.match(d.keys.detail, /recorded/); assert.deepEqual(readFileSync(path), before);
  // Recorded metadata cannot prove that a store is available or that this synthetic vault opens.
  assert.equal(d.code, 1);
  assert.ok(d.result.checks.some((c: { name: string; status: string; detail: string }) => c.name === 'home' && c.status === 'fail' && c.detail.includes('first run did not finish')));
});
