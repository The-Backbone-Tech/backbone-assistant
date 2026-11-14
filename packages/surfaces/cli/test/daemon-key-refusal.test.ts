import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { plistFor } from '../src/daemon.ts';
import { cli, FakeSystemStore, passed } from './system-key-fixture.ts';

for (const kind of ['unusable', 'locked', 'missing', 'provider', 'invalid-choice', 'authentication']) test(`daemon key refusal ${kind} is one logged clean stop`, { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-daemon-refusal-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    passed(await cli(home, ['projects', 'create', 'Daemon refusal'], store));
    let choice: string | undefined;
    if (kind === 'unusable') store.usable = false;
    if (kind === 'locked') store.get = async () => { store.reads++; throw Error('synthetic locked store'); };
    if (kind === 'missing') store.items.clear();
    if (kind === 'provider') choice = 'plaintext';
    if (kind === 'invalid-choice') choice = 'invalid';
    if (kind === 'authentication') {
      const path = join(home, 'keys', 'vault.json'), file = JSON.parse(readFileSync(path, 'utf8'));
      const envelope = JSON.parse(Buffer.from(file.key, 'base64').toString());
      envelope.data = Buffer.alloc(32).toString('base64'); file.key = Buffer.from(JSON.stringify(envelope)).toString('base64');
      writeFileSync(path, JSON.stringify(file));
    }
    const reads = store.reads, writes = store.writes;
    const result = await cli(home, ['daemon', 'run'], store, choice);
    assert.equal(result.code, 0, result.err + result.out);
    assert.equal(result.err.trim().split('\n').length, 1, result.err);
    assert.match(result.err, /daemon: stopped .*key refusal/);
    assert.match(result.err, /start the daemon again/);
    const recovery = { unusable: /Unlock or start the system key store/, locked: /Unlock or start the system key store/, missing: /Recover the original store item.*Do not recreate/, provider: /Unset BACKBONE_KEYS or choose BACKBONE_KEYS=system/, 'invalid-choice': /Choose BACKBONE_KEYS=system or BACKBONE_KEYS=plaintext, or leave it unset/, authentication: /Restore the original vault and matching store item.*trusted backup/ };
    assert.match(result.err, recovery[kind as keyof typeof recovery]);
    if (!['unusable', 'locked'].includes(kind)) assert.doesNotMatch(result.err, /Unlock.*log in/);
    if (kind === 'unusable' || kind === 'locked') assert.match(result.err, /BACKBONE_KEYS=plaintext.*plain text/);
    assert.match(result.err, kind === 'unusable' || kind === 'locked' ? /No usable system key store/ : kind === 'missing' ? /keys are gone/ : kind === 'provider' ? /plaintext keys cannot open/i : kind === 'invalid-choice' ? /takes plaintext or system/ : /could not authenticate/);
    assert.ok(store.reads - reads <= 1, 'no retry'); assert.equal(store.writes, writes);
    assert.doesNotMatch(result.out, /daemon: serving/);
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});

test('daemon non-key failures retain a failing exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-daemon-other-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    passed(await cli(home, ['projects', 'create', 'Other failure'], store, 'plaintext'));
    writeFileSync(join(home, 'core.json'), '{invalid');
    const result = await cli(home, ['daemon', 'run'], store);
    assert.equal(result.code, 1); assert.doesNotMatch(result.err, /stopped .*key refusal/);
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});

test('plaintext launch agent bytes match the integration base including KeepAlive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-daemon-plist-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    passed(await cli(home, ['projects', 'create', 'Plain unit'], store, 'plaintext'));
    const text = plistFor({ label: 'test', node: '/node', script: '/main.ts', home, logs: join(home, 'logs') }).replaceAll(home, '/home');
    assert.match(text, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    // SHA-256 of dbbfdd6's plistFor with the same normalized arguments.
    assert.equal(createHash('sha256').update(text).digest('hex'), '96651800e62d40949b7c63d399ade1f3c1d08cb379f30f262b8b3f578c972784');
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});


test('daemon wrapper denial stops cleanly without recommending plaintext', () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-daemon-denial-')), home = join(root, 'home');
  try {
    const result = spawnSync(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, 'daemon', 'run', '--home', home], { encoding: 'utf8', env: { ...process.env, BACKBONE_KEYS: '', BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1', BACKBONE_TEST_SYSTEM_KEYCHAIN: '0' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /BACKBONE_SYSTEM_STORE_UNAVAILABLE=1/);
    assert.doesNotMatch(result.stderr, /plaintext/); assert.equal(existsSync(home), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
