import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { plaintextKeys, Vault } from '@backbone-next/platform/keys';
import { cli, daemon, FakeSystemStore, passed } from './system-key-fixture.ts';

const choices = [undefined, 'plaintext', 'system'] as const;
const states = ['fresh', 'plaintext', 'pinned-plaintext', 'system', 'app', 'legacy'] as const;
for (const entry of ['CLI', 'daemon']) for (const state of states) for (const choice of choices) test(`${entry} selector: ${state}, ${choice ?? 'unset'}`, { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-caller-cell-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    if (['plaintext', 'pinned-plaintext', 'legacy', 'system'].includes(state)) passed(await cli(home, ['projects', 'create', 'Selection fixture'], store, state === 'system' ? 'system' : 'plaintext'));
    if (state === 'app') { mkdirSync(join(home, 'keys'), { recursive: true }); writeFileSync(join(home, 'keys', 'vault.json'), JSON.stringify({ format: 1, holder: 'keychain', wrap: 'electron-safeStorage' })); }
    if (state === 'pinned-plaintext') writeFileSync(join(home, 'keys', 'system-id'), randomUUID() + '\n');
    if (state === 'legacy') {
      const vault = await Vault.open(home, plaintextKeys()), passwords = await vault.passwords().read();
      writeFileSync(join(home, 'keys', 'master.key'), await vault.masterKey());
      const { port } = JSON.parse(readFileSync(join(home, 'pg', 'cluster.json'), 'utf8'));
      writeFileSync(join(home, 'pg', 'secrets.json'), JSON.stringify({ ...passwords, port }));
      rmSync(join(home, 'keys', 'vault.json')); rmSync(join(home, 'pg', 'cluster.json')); Vault.forget(home);
    }
    const path = join(home, 'keys', 'vault.json'), before = existsSync(path) ? readFileSync(path) : null, writes = store.writes, probes = store.probes;
    const success = state === 'fresh' || (state === 'plaintext' && choice !== 'system') || (state === 'system' && choice !== 'plaintext') || (state === 'legacy' && choice === 'plaintext');
    let result;
    if (entry === 'CLI') result = await cli(home, state === 'fresh' || state === 'legacy' ? ['projects', 'create', 'New project'] : ['projects', 'list'], store, choice);
    else {
      const running = await daemon(home, store, choice);
      try { if (success) assert.match(running.seen.out, /daemon: serving/, running.seen.err); }
      finally { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGTERM'); result = await running.done; }
    }
    if (success) {
      passed(result);
      const file = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(file.wrap, state === 'system' || (state === 'fresh' && choice !== 'plaintext') ? 'os-keyring-v1' : 'none');
      if (before) assert.deepEqual(readFileSync(path), before, 'an existing vault remains byte for byte');
    } else {
      assert.equal(result.code, entry === 'daemon' && state !== 'app' ? 0 : 1, result.out + result.err);
      assert.match(result.err, state === 'app' ? /app that keeps this data folder is not running/ : state === 'pinned-plaintext' ? /downgrade refused/ : state === 'legacy' ? /legacy plaintext keys/ : state === 'plaintext' ? /not converted/ : /plaintext keys cannot open/i);
      if (before) assert.deepEqual(readFileSync(path), before);
      assert.equal(store.writes, writes);
    }
    if (['plaintext', 'pinned-plaintext', 'app', 'legacy'].includes(state)) assert.equal(store.probes, probes, 'these cells never probe the store');
    if (state === 'plaintext') { assert.equal(existsSync(join(home, 'keys', 'system-id')), false); assert.equal(existsSync(join(home, 'keys', 'system-protected')), false); }
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});

for (const entry of ['CLI', 'daemon']) for (const choice of [undefined, 'system']) test(`${entry} refuses an unavailable fake store (${choice ?? 'unset'})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-caller-unavailable-')), home = join(root, 'home'), store = new FakeSystemStore(); store.usable = false;
  try {
    const result = entry === 'CLI' ? await cli(home, ['projects', 'create', 'No store'], store, choice) : await (await daemon(home, store, choice)).done;
    assert.equal(result.code, entry === 'daemon' ? 0 : 1); assert.match(result.err, /No usable system key store/);
    assert.equal(existsSync(join(home, 'keys')), false); assert.equal(store.writes, 0);
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});

test('read-only CLI commands on absent or empty homes never choose or make keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-caller-empty-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    for (const exists of [false, true]) {
      if (exists) mkdirSync(home);
      for (const args of [['projects', 'list'], ['doctor']]) assert.equal((await cli(home, args, store)).code, 1);
      assert.equal(existsSync(home), exists); assert.equal(existsSync(join(home, 'cli')), false); assert.equal(store.probes, 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('read-only CLI refuses legacy vault migration even with explicit plaintext', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-caller-legacy-read-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    mkdirSync(join(home, 'keys'), { recursive: true }); writeFileSync(join(home, 'keys', 'master.key'), Buffer.alloc(32, 9));
    const result = await cli(home, ['projects', 'list'], store, 'plaintext');
    assert.equal(result.code, 1); assert.match(result.err, /read-only command cannot migrate/);
    assert.equal(existsSync(join(home, 'keys', 'vault.json')), false); assert.equal(existsSync(join(home, 'cli')), false);
    assert.deepEqual(readFileSync(join(home, 'keys', 'master.key')), Buffer.alloc(32, 9)); assert.equal(store.writes, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


for (const entry of ['CLI', 'daemon']) for (const choice of [undefined, 'system']) test(`${entry} refuses an unavailable store for a committed system vault (${choice ?? 'unset'})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-caller-system-unavailable-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    passed(await cli(home, ['projects', 'create', 'Protected'], store));
    const path = join(home, 'keys', 'vault.json'), before = readFileSync(path), writes = store.writes;
    store.usable = false;
    const result = entry === 'CLI' ? await cli(home, ['projects', 'list'], store, choice) : await (await daemon(home, store, choice)).done;
    assert.equal(result.code, entry === 'daemon' ? 0 : 1); assert.match(result.err, /No usable system key store/);
    assert.deepEqual(readFileSync(path), before); assert.equal(store.writes, writes);
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});
