import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeDataHome } from '@backbone-next/platform/composition';
import { plaintextKeys, Vault } from '@backbone-next/platform/keys';
import { plistFor } from '../src/daemon.ts';
import { daemonKeyEnvironment } from '../src/daemon-key-environment.ts';
import { daemon, FakeSystemStore, passed } from './system-key-fixture.ts';

test('daemon composition creates a protected home with no choice and closes cleanly', { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-daemon-system-')), home = join(root, 'home'), store = new FakeSystemStore();
  const started = await daemon(home, store);
  try {
    assert.match(started.seen.out, /daemon: serving/, started.seen.err);
    assert.equal(JSON.parse(readFileSync(join(home, 'keys', 'vault.json'), 'utf8')).wrap, 'os-keyring-v1');
    assert.equal(store.writes, 1);
  } finally { started.child.kill('SIGTERM'); await started.done; await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
  passed(await started.done);
});

test('daemon units preserve plaintext homes and never select plaintext for a system home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-daemon-environment-')), plain = join(root, 'plain'), system = join(root, 'system');
  try {
    await Vault.open(plain, plaintextKeys());
    mkdirSync(join(system, 'keys'), { recursive: true });
    writeFileSync(join(system, 'keys', 'vault.json'), JSON.stringify({ format: 1, holder: 'keychain', wrap: 'os-keyring-v1' }));
    assert.deepEqual(daemonKeyEnvironment(plain, {}, 'darwin'), { BACKBONE_HOME: plain, BACKBONE_KEYS: 'plaintext' });
    assert.deepEqual(daemonKeyEnvironment(system, {}, 'darwin'), { BACKBONE_HOME: system, BACKBONE_KEYS: 'system' });
    const linux = daemonKeyEnvironment(system, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000', PRIVATE_VALUE: 'fake-private-value' }, 'linux');
    assert.deepEqual(linux, { BACKBONE_HOME: system, BACKBONE_KEYS: 'system', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000' });
    const systemPlist = plistFor({ label: 'test', node: process.execPath, script: '/opt/cli/main.ts', home: system, logs: join(system, 'logs') });
    assert.match(systemPlist, /<key>BACKBONE_KEYS<\/key>\s*<string>system<\/string>/); assert.ok(!systemPlist.includes('plaintext'));
    const plainPlist = plistFor({ label: 'test', node: process.execPath, script: '/opt/cli/main.ts', home: plain, logs: join(plain, 'logs') });
    assert.ok(plainPlist.includes(`  <dict>\n    <key>BACKBONE_HOME</key>\n    <string>${plain}</string>\n    <key>BACKBONE_KEYS</key>\n    <string>plaintext</string>\n  </dict>`));
    assert.throws(() => daemonKeyEnvironment(system, { BACKBONE_KEYS: 'plaintext' }), /cannot open/);
    assert.throws(() => daemonKeyEnvironment(plain, { BACKBONE_KEYS: 'system' }), /not converted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
