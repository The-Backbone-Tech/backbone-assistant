import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHost } from '../src/composition/host.ts';
import { PolicyRefused } from '../src/policy/index.ts';
import { freshHome, open, value } from './helpers.ts';
import { document, systemFixture } from './policy-fixture.ts';

test('real Host admits the required engine and refuses environment, home and option bypasses', async t => {
  const fixture = systemFixture(t, document({ harnesses: ['harness-stub'] }));
  const home = freshHome();
  const { host } = open(home);
  value(await host.call('projects.create', { name: 'Managed fixture', kind: 'folder' }));
  assert.equal((await host.call('settings.policy.get', {})).state, 'verified');
  assert.throws(() => createHost({ home: freshHome(), harness: 'harness-pi' }), PolicyRefused);
  const prior = process.env.BACKBONE_HARNESS;
  process.env.BACKBONE_HARNESS = 'pi';
  try { assert.throws(() => createHost({ home: freshHome() }), PolicyRefused); }
  finally { if (prior === undefined) delete process.env.BACKBONE_HARNESS; else process.env.BACKBONE_HARNESS = prior; }
  const personal = freshHome(); writeFileSync(join(personal, 'settings.json'), JSON.stringify({ harness: 'pi' }));
  assert.throws(() => createHost({ home: personal }), PolicyRefused);
  const refused = freshHome();
  fixture.tamper();
  await assert.rejects(host.call('projects.create', { name: 'Never created', kind: 'folder' }), PolicyRefused);
  assert.throws(() => createHost({ home: refused }), PolicyRefused);
  assert.equal(existsSync(join(refused, 'threads')), false);
});

test('real Host applies a fixed telemetry destination over the saved personal setting', async t => {
  const home = freshHome();
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ telemetry: { endpoint: 'https://personal.test/v1/traces' } }));
  systemFixture(t, document({ telemetryEndpoint: 'https://fixed.test/v1/traces' }));
  const { host } = open(home);
  value(await host.call('projects.create', { name: 'Fixed destination', kind: 'folder' }));
  const { readTelemetrySettings } = await import('../src/credentials/telemetry.ts');
  assert.equal(readTelemetrySettings(home)?.endpoint, 'https://fixed.test/v1/traces');
  assert.match(readFileSync(join(home, 'settings.json'), 'utf8'), /personal.test/);
});

test('required telemetry starts inside the Host before work, shares one exporter, and overrides personal off', async t => {
  const { fakeCollector } = await import('./fake-telemetry-collector.ts');
  const { startConfiguredTelemetry } = await import('../src/composition/telemetry.ts');
  const { idle, settings } = await import('./helpers.ts');
  const collector = await fakeCollector(); t.after(() => collector.close());
  const home = freshHome();
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ telemetry: false }));
  systemFixture(t, document({ telemetryRequired: true, telemetryEndpoint: collector.endpoint }));
  const { host } = open(home);
  const project = value(await host.call('projects.create', { name: 'Required telemetry', kind: 'folder' }));
  const first = await startConfiguredTelemetry(host, home);
  assert.equal(first.status, 'on');
  assert.equal(await startConfiguredTelemetry(host, home), first);
  const sent = value(await host.call('turns.send', { projectId: project.id, text: 'A local stub turn.', attachments: [], settings, clientKey: 'required-telemetry' }));
  await idle(host, sent.threadId);
  await first.flush();
  assert.equal(collector.spans().filter(span => span.name === 'invoke_agent').length, 1);
});

test('required telemetry failure refuses Host work and recovery before Core initialization', async t => {
  const { mkdirSync } = await import('node:fs');
  const home = freshHome();
  mkdirSync(join(home, 'credentials'), { recursive: true });
  writeFileSync(join(home, 'credentials', 'telemetry.json'), JSON.stringify({ authorization: 'invalid handle' }));
  systemFixture(t, document({ telemetryRequired: true, telemetryEndpoint: 'http://127.0.0.1:4318/v1/traces' }));
  const { host } = open(home);
  await assert.rejects(host.call('projects.create', { name: 'Never created', kind: 'folder' }), /Required telemetry could not start \(credentials\)/);
  await assert.rejects(host.resumeInterrupted(), PolicyRefused);
  assert.equal(existsSync(join(home, 'core.json')), false);
  assert.equal(existsSync(join(home, 'projects.json')), false);
});

test('vault admission rejects plaintext at open and on retained handles without invoking a key store', async t => {
  const { Vault, plaintextKeys } = await import('../src/keys/vault.ts');
  const home = freshHome(), fixture = systemFixture(t, document({ keyHolders: ['plaintext', 'keychain'] }));
  const vault = await Vault.open(home, plaintextKeys());
  await vault.put('test-only', Buffer.from('fake secret'));
  fixture.update(document({ keyHolders: ['keychain'] }));
  let unwraps = 0;
  const keys = { holder: 'keychain' as const, wrap: 'test-only', wrapKey: async (b: Buffer) => b, unwrapKey: async (b: Buffer) => { unwraps++; return { key: b, rewrap: false }; } };
  await assert.rejects(Vault.open(home, keys), PolicyRefused);
  assert.throws(() => vault.get('test-only'), PolicyRefused);
  assert.throws(() => vault.put('test-only', Buffer.from('replacement')), PolicyRefused);
  assert.equal(unwraps, 0);
});

for (const requirements of [{ standingSignatures: false }, { standingServers: [] }]) test(`Host standing signatures obey ${Object.keys(requirements)[0]} at creation and after a policy change`, async t => {
  const { freshDir } = await import('./helpers.ts');
  const { defaultToolEnv } = await import('../src/tools/places.ts');
  const { enableConnector } = await import('../src/testing/connectors.ts');
  const home = freshHome(), person = freshDir('policy-signatures-');
  writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [join(import.meta.dirname, 'fake-mcp-server.ts')] } } }));
  const fixture = systemFixture(t, document());
  const { host } = open(home, { connectors: { env: defaultToolEnv({ HOME: person, PATH: process.env.PATH }), sources: ['claude-code'] } });
  const id = 'claude-code:notes';
  value(await host.call('connectors.refresh', { serverId: id }));
  value(await enableConnector(host, id)); value(await enableConnector(host, id, 'draft_note'));
  value(await host.openConnectorDoor(id, host.connectorDoorSeal(id)!));
  let shown = host.connectorToolView(id, 'draft_note')!;
  value(await host.signConnectorTool(id, 'draft_note', shown.seal, shown.stamp, false));
  assert.ok((await host.call('connectors.list', {})).servers[0].tools.find(tool => tool.name === 'draft_note')?.standing);
  fixture.update(document(requirements));
  assert.equal((await host.call('connectors.list', {})).servers[0].tools.find(tool => tool.name === 'draft_note')?.standing, undefined);
  shown = host.connectorToolView(id, 'draft_note')!;
  const { ConnectorService } = await import('../src/connectors/service.ts');
  const originalSet = ConnectorService.prototype.set;
  let refusal: unknown;
  t.mock.method(ConnectorService.prototype, 'set', async function(this: InstanceType<typeof ConnectorService>, ...args: Parameters<typeof originalSet>) {
    try { return await originalSet.apply(this, args); } catch (error) { refusal = error; throw error; }
  });
  await assert.rejects(host.signConnectorTool(id, 'draft_note', shown.seal, shown.stamp, false), /signature could not be confirmed/);
  assert.ok(refusal instanceof PolicyRefused);
  assert.equal(refusal.code, 'requirement');
  assert.match(refusal.message, /standing signatures for this connector server are forbidden by policy/);
  value(await host.endConnectorSignature(id, 'draft_note'));
});
