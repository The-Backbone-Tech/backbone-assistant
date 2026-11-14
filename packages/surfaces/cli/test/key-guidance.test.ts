import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { install, type Launchd } from '../src/daemon.ts';
import { daemonKeyEnvironment } from '../src/daemon-key-environment.ts';
import { cli, FakeSystemStore } from './system-key-fixture.ts';

test('CLI non-home refusals name projects create and never send standalone data to the app', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-key-guidance-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    mkdirSync(home);
    const empty = await cli(home, ['send', 'hello'], store);
    assert.equal(empty.code, 1); assert.match(empty.err, /backbone projects create/); assert.doesNotMatch(empty.err, /Only host creates/);
    writeFileSync(join(home, 'projects.json'), '[]');
    const data = await cli(home, ['send', 'hello'], store);
    assert.equal(data.code, 1); assert.match(data.err, /has data but no vault/); assert.doesNotMatch(data.err, /Open the app/);
    assert.match(data.err, /backbone restore <backup-folder> --home <new-empty-home>/); assert.deepEqual(readdirSync(home), ['projects.json']);
    assert.equal(store.probes, 0); assert.equal(store.writes, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const state of ['legacy', 'pinned-plaintext']) test(`daemon install refuses ${state} before touching agents or logs`, () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-install-refusal-')), home = join(root, 'home'), agents = join(root, 'agents');
  const oldChoice = process.env.BACKBONE_KEYS; delete process.env.BACKBONE_KEYS;
  try {
    mkdirSync(join(home, 'keys'), { recursive: true });
    if (state === 'legacy') writeFileSync(join(home, 'keys', 'master.key'), Buffer.alloc(32, 8));
    else {
      writeFileSync(join(home, 'keys', 'vault.json'), JSON.stringify({ format: 1, holder: 'plaintext', wrap: 'none' }));
      writeFileSync(join(home, 'keys', 'system-id'), randomUUID() + '\n');
    }
    const expected = state === 'legacy' ? /legacy plaintext keys/ : /downgrade refused/;
    assert.throws(() => daemonKeyEnvironment(home, {}), expected);
    let calls = 0;
    const at: Launchd = { agents, uid: 1, node: process.execPath, script: '/main.ts', launchctl() { calls++; return { code: 113, out: 'not found' }; } };
    assert.throws(() => install(home, at), expected); assert.equal(calls, 0);
    assert.equal(existsSync(agents), false); assert.equal(existsSync(join(home, 'logs')), false);
    if (state === 'legacy') assert.equal(daemonKeyEnvironment(home, { BACKBONE_KEYS: 'plaintext' }).BACKBONE_KEYS, 'plaintext');
    else for (const choice of ['plaintext', 'system']) assert.throws(() => daemonKeyEnvironment(home, { BACKBONE_KEYS: choice }), /downgrade refused/);
  } finally {
    if (oldChoice === undefined) delete process.env.BACKBONE_KEYS; else process.env.BACKBONE_KEYS = oldChoice;
    rmSync(root, { recursive: true, force: true });
  }
});
