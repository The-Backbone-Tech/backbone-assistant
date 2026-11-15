import { spawnSyncHang, TEST_HANG_MS } from '../../../../scripts/lib/test-hang.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { plaintextKeys, Vault } from '@backbone-next/platform/keys';

const main = new URL('../src/main.ts', import.meta.url).pathname;
const run = (home: string, op: string, choice?: string) => spawnSyncHang(process.execPath, [main, op, '--home', home, '--name', 'admission-test', '--grant', 'admission-test'], {
  env: { ...process.env, BACKBONE_KEYS: choice ?? '', BACKBONE_HARNESS: 'stub' }, encoding: 'utf8', input: '', timeout: TEST_HANG_MS,
});
for (const op of ['grant', 'revoke']) for (const choice of [undefined, 'plaintext', 'system']) for (const absent of [true, false]) test(`${op} never creates a home (${choice ?? 'unset'}, ${absent ? 'absent' : 'empty'})`, () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-mcp-admission-')), home = join(root, 'home');
  try {
    if (!absent) mkdirSync(home);
    const result = run(home, op, choice);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /not an existing data folder/);
    assert.equal(existsSync(home), !absent);
    if (!absent) assert.deepEqual(readdirSync(home), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MCP explicit plaintext preserves the base legacy master and PostgreSQL migration', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-mcp-legacy-'));
  try {
    const host = createHost({ home, keys: plaintextKeys(), harness: 'stub' });
    try { assert.equal((await host.call('projects.create', { name: 'Before the vault', kind: 'folder' })).ok, true); }
    finally { host.close(); await hostClosed(home); }
    const vault = await Vault.open(home, plaintextKeys()), master = await vault.masterKey(), passwords = await vault.passwords().read();
    const { port } = JSON.parse(readFileSync(join(home, 'pg', 'cluster.json'), 'utf8'));
    writeFileSync(join(home, 'keys', 'master.key'), master, { mode: 0o600 });
    writeFileSync(join(home, 'pg', 'secrets.json'), JSON.stringify({ ...passwords, port }), { mode: 0o600 });
    rmSync(join(home, 'keys', 'vault.json')); rmSync(join(home, 'pg', 'cluster.json')); Vault.forget(home);
    const refused = run(home, 'grant');
    assert.equal(refused.status, 2); assert.match(refused.stderr, /legacy plaintext keys/);
    assert.ok(!existsSync(join(home, 'keys', 'vault.json'))); assert.ok(!existsSync(join(home, 'keys', 'system-id')));
    const migrated = run(home, 'grant', 'plaintext');
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    assert.ok(!existsSync(join(home, 'keys', 'master.key'))); assert.ok(!existsSync(join(home, 'pg', 'secrets.json')));
    Vault.forget(home);
    const after = await Vault.open(home, plaintextKeys());
    assert.deepEqual(await after.masterKey(), master); assert.deepEqual(await after.passwords().read(), passwords);
    assert.equal(JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8')).holder, 'plaintext');
  } finally { await removeDataHome(home); }
});


for (const state of ['missing', 'empty', 'data-without-vault']) test(`serve starts without keys on a ${state} home`, { timeout: TEST_HANG_MS }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-mcp-serve-')), home = join(root, 'home');
  const client = new Client({ name: 'unstarted-home', version: '0.0.0' });
  try {
    if (state !== 'missing') mkdirSync(home);
    if (state === 'data-without-vault') writeFileSync(join(home, 'settings.json'), '{}');
    const before = state === 'missing' ? null : readdirSync(home);
    // Fail even on importing the selector: serve has no reason to select or probe keys.
    const hook = `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){if(s==='@backbone-next/platform/system-keys')throw new Error('serve attempted key selection');return next(s,c)}});`;
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'data:text/javascript,' + encodeURIComponent(hook), main, 'serve', '--home', home, '--grant', 'not-yet-granted'],
      env: { ...process.env, BACKBONE_KEYS: 'system' } as Record<string, string>, stderr: 'pipe' });
    await client.connect(transport);
    for (const name of ['list_projects', 'effect_status']) {
      const result = await client.callTool({ name, arguments: name === 'effect_status' ? { effectId: 'not-created' } : {} });
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as { reason: string }).reason, 'NOT_AVAILABLE');
    }
    assert.equal(existsSync(home), state !== 'missing');
    if (before) assert.deepEqual(readdirSync(home), before);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});
