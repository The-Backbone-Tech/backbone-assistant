import { acceptAcpTestConfiguration } from '../src/testing/acp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { freshHome } from './helpers.ts';
import { document, systemFixture } from './policy-fixture.ts';
import { PolicyRefused } from '../src/policy/index.ts';
import { HARNESSES, harnessConfiguration, selectHarness, loadHarness } from '../src/composition/harnesses.ts';
import { createHost } from '../src/composition/host.ts';
import { ModelRoutes } from '../src/models/route.ts';
import type { CredentialStore } from '../src/credentials/store.ts';
import { readTelemetrySettings, putTelemetryEndpoint } from '../src/credentials/telemetry.ts';
import { startConfiguredTelemetry } from '../src/composition/telemetry.ts';
import { chooseKeys } from '../src/system-keys/selection.ts';
import { exportAuditHome } from '../src/composition/audit-home.ts';

const save = (home: string, name: string, value: unknown) => writeFileSync(join(home, name), JSON.stringify(value));
const credentials = { has: () => true } as unknown as CredentialStore;

test('engine requirement cannot be weakened by a personal choice, environment or settings file', t => {
  const home = freshHome(); systemFixture(t, document({ harnesses: ['harness-pi'] }));
  for (const choice of ['harness-codex', 'scripted', 'stub']) assert.throws(() => selectHarness(home, choice), PolicyRefused);
  const prior = process.env.BACKBONE_HARNESS;
  process.env.BACKBONE_HARNESS = 'harness-acp';
  t.after(() => { if (prior === undefined) delete process.env.BACKBONE_HARNESS; else process.env.BACKBONE_HARNESS = prior; });
  assert.throws(() => selectHarness(home, process.env.BACKBONE_HARNESS), PolicyRefused);
  save(home, 'settings.json', { harness: 'harness-codex' });
  assert.throws(() => harnessConfiguration(home, HARNESSES['harness-codex']), PolicyRefused);
  assert.equal(selectHarness(home, 'pi'), 'harness-pi');
});
test('a harness default yields to an explicit personal choice', t => {
  const home = freshHome(); systemFixture(t, document({}, { harnesses: ['harness-pi'] }));
  assert.equal(selectHarness(home), 'harness-pi');
  assert.equal(selectHarness(home, 'harness-codex'), 'harness-codex');
});
test('ACP personal acceptance and person-rights cannot override policy', t => {
  const home = freshHome(), fixture = systemFixture(t, document({ acceptsProcessVisibility: false }));
  save(home, 'settings.json', { harnesses: { 'harness-acp': { acceptsProcessVisibility: true, agent: 'fake', command: '/bin/echo', environment: 'person-rights' } } });
  assert.throws(() => harnessConfiguration(home, HARNESSES['harness-acp']), PolicyRefused);
  fixture.update(document({ personRights: false }));
  assert.throws(() => harnessConfiguration(home, HARNESSES['harness-acp']), PolicyRefused);
});
test('environment model endpoint, home route, native and agent selections meet the same provider and kind restrictions', t => {
  const home = freshHome(); const fixture = systemFixture(t, document({ modelProviders: ['openai'] }));
  assert.throws(() => new ModelRoutes(home, credentials, { BACKBONE_MODEL_ENDPOINT: 'http://127.0.0.1:9999/v1' }).resolve(), PolicyRefused);
  save(home, 'model-route.json', { own: { provider: 'anthropic', model: 'fake', credential: 'fake' } });
  assert.throws(() => new ModelRoutes(home, credentials, {}).resolve(), PolicyRefused);
  save(home, 'model-route.json', { own: { provider: 'openai', model: 'fake', credential: 'fake' } });
  assert.equal(new ModelRoutes(home, credentials, {}).resolve()?.provider, 'openai');
  assert.throws(() => new ModelRoutes(home, credentials, { BACKBONE_CODEX_MODEL: 'fake' }, true).resolve(), PolicyRefused);
  assert.throws(() => new ModelRoutes(home, credentials, {}, false, false, { kind: 'agent', provider: 'acp:fake', baseUrl: '', model: 'chosen-by-agent', label: 'fake', credential: null }).resolve(), PolicyRefused);
  fixture.update(document({ modelRoutes: ['gateway'] }));
  assert.throws(() => new ModelRoutes(home, credentials, {}).snapshot(), PolicyRefused);
});
test('forbidden model change is refused before sealing a key or writing settings', async t => {
  const home = freshHome(); systemFixture(t, document({ modelProviders: ['openai'] }));
  const routes = new ModelRoutes(home, credentials, {});
  await assert.rejects(routes.change({ route: 'own', provider: 'anthropic', key: 'fake-test-only', model: 'fake' }), PolicyRefused);
  assert.equal(existsSync(join(home, 'model-route.json')), false);
});
test('telemetry requirement overrides a personal file; changing or disabling it refuses without writes', async t => {
  const home = freshHome(); systemFixture(t, document({ telemetryHost: 'fixed.test', telemetryEndpoint: 'https://fixed.test/v1/traces' }));
  save(home, 'settings.json', { telemetry: { endpoint: 'https://personal.test/v1/traces' } });
  assert.equal(readTelemetrySettings(home)?.endpoint, 'https://fixed.test/v1/traces');
  const prior = readFileSync(join(home, 'settings.json'), 'utf8');
  await assert.rejects(putTelemetryEndpoint(home, undefined), PolicyRefused);
  await assert.rejects(putTelemetryEndpoint(home, 'https://personal.test/v1/traces'), PolicyRefused);
  assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), prior);
});
test('telemetry default yields to a personal endpoint and explicit off persists across reads', async t => {
  const home = freshHome(); systemFixture(t, document({}, { telemetryEndpoint: 'https://default.test/v1/traces' }));
  assert.equal(readTelemetrySettings(home)?.endpoint, 'https://default.test/v1/traces');
  await putTelemetryEndpoint(home, 'https://personal.test/v1/traces');
  assert.equal(readTelemetrySettings(home)?.endpoint, 'https://personal.test/v1/traces');
  await putTelemetryEndpoint(home, undefined);
  assert.equal(readTelemetrySettings(home), undefined);
});
test('key environment cannot select plaintext when policy requires a keychain holder', async t => {
  const home = freshHome(); systemFixture(t, document({ keyHolders: ['keychain'] }));
  await assert.rejects(chooseKeys(home, { BACKBONE_KEYS: 'plaintext' }), PolicyRefused);
});
test('audit with content refuses before opening the home or copying data', async t => {
  const home = freshHome(); systemFixture(t, document({ auditContent: false }));
  let emitted = false;
  await assert.rejects(exportAuditHome(home, { includeContent: true, since: '2026-01-01T00:00:00Z', until: '2027-01-01T00:00:00Z' }, async () => { emitted = true; }), PolicyRefused);
  assert.equal(emitted, false);
});
test('tampered policy stops actual Host construction before writes, model resolution and optional telemetry startup', async t => {
  const home = freshHome(), fixture = systemFixture(t); fixture.tamper();
  assert.throws(() => createHost({ home }), PolicyRefused);
  assert.equal(existsSync(join(home, 'threads')), false);
  assert.throws(() => new ModelRoutes(home, credentials, {}).resolve(), PolicyRefused);
  await assert.rejects(startConfiguredTelemetry({} as never, home), PolicyRefused);
});

test('an enforced engine restriction stops forbidden registered loading before imports', async t => {
  const home = freshHome(); systemFixture(t, document({ harnesses: ['harness-pi'] }));
  const piece = { manifest: { id: 'io.github.albertoangulo/harness-pi' } } as Parameters<typeof loadHarness>[1];
  assert.equal((await loadHarness({} as never, piece, home, HARNESSES['harness-pi'], { blocked: 'test gate before imports' }, [])).registration, null);
  await assert.rejects(loadHarness({} as never, piece, home, HARNESSES['harness-codex'], { blocked: 'test gate before imports' }, []), PolicyRefused);
});

test('a restricted ACP default yields to an explicit personal environment', t => {
  const home = freshHome(); systemFixture(t, document({}, { personRights: false }));
  save(home, 'settings.json', { harnesses: { 'harness-acp': acceptAcpTestConfiguration(home, { acceptsProcessVisibility: true, agent: 'fake', command: '/bin/echo' }) } });
  assert.equal((harnessConfiguration(home, HARNESSES['harness-acp']).options as { environment: string }).environment, 'restricted-writes');
  save(home, 'settings.json', { harnesses: { 'harness-acp': acceptAcpTestConfiguration(home, { acceptsProcessVisibility: true, agent: 'fake', command: '/bin/echo', environment: 'person-rights' }) } });
  assert.equal((harnessConfiguration(home, HARNESSES['harness-acp']).options as { environment: string }).environment, 'person-rights');
});

test('Settings projection names fixed keys without policy values or public trust material', async t => {
  const fixture = systemFixture(t, document({ telemetryEndpoint: 'https://collector.test/v1/traces', auditContent: false }));
  const { policyView } = await import('../src/policy/index.ts');
  const view = policyView('unused'); assert.equal(view.state, 'verified');
  assert.ok(!JSON.stringify(view).includes('collector.test')); assert.ok(!JSON.stringify(view).includes('PUBLIC KEY'));
  if (view.state === 'verified') assert.deepEqual(view.fixed, ['telemetryEndpoint', 'auditContent']);
  fixture.tamper(); assert.equal(policyView('unused').state, 'refused');
});
