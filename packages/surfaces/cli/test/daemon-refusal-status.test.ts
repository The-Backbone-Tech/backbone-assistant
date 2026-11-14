import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { install, status, type Launchd } from '../src/daemon.ts';
import { cli, FakeSystemStore, passed } from './system-key-fixture.ts';

test('daemon status shows the actual last refusal kind and time without showing log content or reading keys', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-refusal-status-')), home = join(root, 'home'), store = new FakeSystemStore();
  const at: Launchd = { agents: join(root, 'agents'), uid: 1, node: process.execPath, script: '/main.ts', launchctl: args => ({ code: args[0] === 'bootstrap' ? 0 : args[0] === 'bootout' ? 3 : 113, out: '' }) };
  try {
    passed(await cli(home, ['projects', 'create', 'Daemon status'], store));
    install(home, at);
    assert.deepEqual(status(home, at), { installed: true, running: false });
    store.items.clear();
    const refused = await cli(home, ['daemon', 'run'], store); passed(refused);
    const match = refused.err.match(/\[missing-item at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\]/);
    assert.ok(match, refused.err);
    // launchd sends stderr to the installed plist's StandardErrorPath; simulate only that delivery.
    const log = join(home, 'logs', 'daemon.log'); writeFileSync(log, refused.err);
    const marker = 'PRIVATE_LOG_VALUE_97f';
    appendFileSync(log, `unrelated ${marker} /outside-the-home/private\ndaemon: stopped after key refusal (no-keys): ${marker} [not-a-known-kind at 2026-11-10T00:00:00.000Z]\n`);
    const before = readFileSync(log), reads = store.reads, probes = store.probes;
    const summary = status(home, at);
    assert.equal(summary.installed, true); assert.equal(summary.running, false);
    assert.deepEqual(summary.lastRefusal, { kind: 'missing-item', at: match[1] });
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_LOG_VALUE|outside-the-home/);
    if (process.platform === 'darwin') {
      const shown = await cli(home, ['daemon', 'status'], store); passed(shown);
      assert.ok(shown.out.includes(`last key refusal: missing-item at ${match[1]}`));
      const json = await cli(home, ['daemon', 'status', '--json'], store); passed(json);
      assert.deepEqual(JSON.parse(json.out).lastRefusal, summary.lastRefusal);
      assert.doesNotMatch(shown.out + json.out, /PRIVATE_LOG_VALUE|outside-the-home/);
    }
    const running = status(home, { ...at, launchctl: () => ({ code: 0, out: 'state = running\npid = 4242\n' }) });
    assert.deepEqual(running, { installed: true, running: true, pid: 4242 });
    assert.equal(Object.hasOwn(running, 'lastRefusal'), false);
    if (process.platform === 'darwin') {
      const shown = await cli(home, ['daemon', 'status'], store, undefined, '', true); passed(shown);
      assert.doesNotMatch(shown.out, /last key refusal/);
      const json = await cli(home, ['daemon', 'status', '--json'], store, undefined, '', true); passed(json);
      assert.equal(JSON.parse(json.out).running, true);
      assert.equal(Object.hasOwn(JSON.parse(json.out), 'lastRefusal'), false);
    }
    assert.equal(store.reads, reads); assert.equal(store.probes, probes); assert.deepEqual(readFileSync(log), before);
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});
