import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { engineLabel, selectedHarness, setEngine } from '../src/composition/engine-settings.ts';
import { assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { CredentialStore } from '../src/credentials/store.ts';
import { ModelRoutes } from '../src/models/route.ts';

test('engine changes preserve other home settings and environment selection still wins', async t => {
  const home = mkdtempSync(join(tmpdir(), 'engine-setting-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  assertHomeWriteAdmission(home);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ harnesses: { 'harness-acp': { agent: 'example' } }, unrelated: 42 }));
  let changes = 0;
  assert.ok((await setEngine(home, 'codex', () => changes++)).ok);
  const stored = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  assert.equal(stored.harness, 'harness-codex'); assert.equal(stored.unrelated, 42); assert.equal(stored.harnesses['harness-acp'].agent, 'example');
  assert.equal(changes, 1); assert.equal(selectedHarness(home, 'harness-pi', {}), 'harness-codex');
  assert.equal(selectedHarness(home, 'harness-pi', { BACKBONE_HARNESS: 'stub' }), 'harness-stub');
  assert.match(engineLabel(selectedHarness(home, 'harness-pi', {})), /Codex/);
  assert.equal((await setEngine(home, 'unknown', () => changes++)).ok, false);
  assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).harness, 'harness-codex'); assert.equal(changes, 1);
});

test('the explicit Codex environment model overrides the shared stored model', async t => {
  const home = mkdtempSync(join(tmpdir(), 'native-model-override-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const credentials = new CredentialStore(home, async () => { throw Error('A native route must not open credentials'); });
  const routes = new ModelRoutes(home, credentials, {}, true);
  await routes.change({ route: 'native', provider: 'codex', model: 'stored-model' });
  assert.equal(routes.resolve()?.model, 'stored-model');
  assert.equal(new ModelRoutes(home, credentials, { BACKBONE_CODEX_MODEL: 'session-model' }, true).resolve()?.model, 'session-model');
});

test('the app and terminal get separate no-route instructions from the same route state', async t => {
  const { terminalModelHint } = await import('../src/api.ts');
  const home = mkdtempSync(join(tmpdir(), 'route-hints-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const credentials = new CredentialStore(home, async () => { throw Error('No credential'); });
  const appHint = new ModelRoutes(home, credentials, {}).settings().hint!;
  assert.match(appHint, /Open Settings/); assert.doesNotMatch(appHint, /backbone engine/);
  const terminalHint = terminalModelHint(appHint); assert.match(terminalHint, /backbone engine codex/); assert.doesNotMatch(terminalHint, /gear in the sidebar/);
  assert.equal(terminalModelHint('An unrelated refusal.'), 'An unrelated refusal.');
});

test('Settings shows the no-route hint without sending the person to Settings, and the other surfaces keep theirs', async t => {
  const { settingsModelHint, terminalModelHint } = await import('../src/api.ts');
  const home = mkdtempSync(join(tmpdir(), 'route-hints-settings-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const credentials = new CredentialStore(home, async () => { throw Error('No credential'); });
  const appHint = new ModelRoutes(home, credentials, {}).settings().hint!;
  assert.match(appHint, /Open Settings \(the gear in the sidebar\)/, 'chat and turn refusals keep the sentence that sends the person to Settings');
  for (const place of ['own', 'shared'] as const) {
    const shown = settingsModelHint(appHint, place);
    assert.doesNotMatch(shown, /Open Settings|gear/); assert.match(shown, /paste your own Anthropic or OpenAI key/); assert.match(shown, /Nothing was sent\.$/);
  }
  assert.match(settingsModelHint(appHint, 'own'), /Change your model/); assert.match(settingsModelHint(appHint, 'shared'), /Configure shared work/);
  assert.equal(settingsModelHint('An unrelated refusal.', 'own'), 'An unrelated refusal.');
  assert.match(terminalModelHint(appHint), /backbone engine codex/);
});
