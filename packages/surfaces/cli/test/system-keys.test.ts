import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ledger, readChannelConfig } from '@backbone-next/channels';
import { fakeProvider } from '../../channels/test/fake-providers.ts';
import { removeDataHome } from '@backbone-next/platform/composition';
import { cli, FakeSystemStore, passed } from './system-key-fixture.ts';

test('real CLI creates and reopens a protected home without a key choice; doctor never publishes a marker', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-cli-system-')), home = join(root, 'home'), store = new FakeSystemStore();
  try {
    passed(await cli(home, ['projects', 'create', 'My project'], store));
    const path = join(home, 'keys', 'vault.json'), file = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(file.wrap, 'os-keyring-v1'); assert.equal(file.holder, 'keychain');
    assert.equal(existsSync(join(home, 'keys', 'system-protected')), false);
    const before = readFileSync(path);
    const doctor = await cli(home, ['doctor', '--json'], store); passed(doctor);
    assert.match(JSON.parse(doctor.out).checks.find((c: { name: string }) => c.name === 'keys').detail, /os-keyring-v1/);
    assert.equal(existsSync(join(home, 'keys', 'system-protected')), false);
    passed(await cli(home, ['models'], store));
    const list = await cli(home, ['projects', 'list'], store); passed(list); assert.match(list.out, /My project/);
    assert.deepEqual(readFileSync(path), before); assert.equal(store.writes, 1);
    assert.equal(existsSync(join(home, 'keys', 'system-protected')), false);
  } finally { await removeDataHome(home); rmSync(root, { recursive: true, force: true }); }
});

test('protected CLI credential setup and daemon channel startup use the chosen provider', { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'backbone-cli-system-credentials-')), home = join(root, 'home'), store = new FakeSystemStore(), fake = await fakeProvider('telegram');
  try {
    passed(await cli(home, ['projects', 'create', 'Credentials fixture'], store));
    const header = await cli(home, ['telemetry', 'header'], store, undefined, JSON.stringify({ authorization: 'synthetic-collector-header' })); passed(header);
    assert.ok(!header.out.includes('synthetic-collector-header'));
    const channel = await cli(home, ['channels', 'connect', 'telegram', '--port', '0'], store, undefined, 'synthetic-bot-token\nsynthetic-verification\n'); passed(channel);
    assert.ok(!channel.out.includes('synthetic-bot-token'));
    const config = readChannelConfig(home)!; const ledger = new Ledger(home);
    try { ledger.set('config', { ...config, baseUrls: { telegram: fake.url } }); } finally { ledger.close(); }
    const { daemon } = await import('./system-key-fixture.ts');
    const running = await daemon(home, store);
    try {
      assert.match(running.seen.out, /daemon: serving/, running.seen.err);
      assert.ok(!running.seen.out.includes('channels: could not start'));
      assert.equal(existsSync(join(home, 'channels', 'listener.json')), true);
    } finally { running.child.kill('SIGTERM'); passed(await running.done); }
  } finally { await removeDataHome(home); await fake.close(); rmSync(root, { recursive: true, force: true }); }
});
