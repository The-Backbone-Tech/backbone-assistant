import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CredentialStore } from '../src/credentials/store.ts';
import { ModelRoutes } from '../src/models/route.ts';
import { assertHomeWriteAdmission, withHomeLock } from '../src/composition/home-lock.ts';

test('a chosen local model outranks stored own, gateway and Keychain credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'local-choice-'));
  try {
    let reads = 0;
    const master = randomBytes(32);
    const credentials = new CredentialStore(home, async () => master, { has: () => true, read: async () => { reads++; return 'fake-keychain-key'; } });
    const routes = new ModelRoutes(home, credentials, {}, false, true);
    await routes.change({ route: 'own', provider: 'openai', key: 'fake-own-key', model: 'paid-own' });
    await routes.change({ route: 'gateway', provider: 'openrouter', key: 'fake-gateway-key', model: 'paid-gateway' });
    await routes.change({ route: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'chosen-local' });
    const chosen = routes.snapshot();
    assert.equal(chosen.route?.model, 'chosen-local'); assert.equal(chosen.route?.credential, null);
    assert.equal(chosen.settings.active?.kind, 'endpoint'); assert.equal(reads, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid stored local settings refuse resolution before any paid credential lookup and expose a repair hint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'invalid-local-choice-'));
  try {
    let keychainChecks = 0;
    const master = randomBytes(32);
    const credentials = new CredentialStore(home, async () => master, { has: () => { keychainChecks++; return true; }, read: async () => { throw new Error('No key may be read'); } });
    const routes = new ModelRoutes(home, credentials, {}, false, true);
    const good = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'chosen-local' };
    for (const local of [null, false, 'invalid', {}, { ...good, model: null }, { ...good, model: '' }, { ...good, provider: 'unknown' }, { ...good, baseUrl: 'https://remote.invalid/v1' }]) {
      await withHomeLock(home, async () => {
        assertHomeWriteAdmission(home);
        await writeFile(join(home, 'model-route.json'), JSON.stringify({ local }));
      });
      keychainChecks = 0;
      assert.throws(() => routes.resolve(), /local model setting.*invalid/i);
      assert.throws(() => routes.snapshot(), /local model setting.*invalid/i);
      const settings = routes.settings();
      assert.equal(settings.active, null); assert.match(settings.hint ?? '', /local model setting.*invalid/i);
      assert.equal(keychainChecks, 0, 'an invalid local selection must not consult the paid fallback');
    }
    // Correcting the setting through the same API repairs the refusal without losing other routes.
    await routes.change({ route: 'local', ...good } as Parameters<ModelRoutes['change']>[0]);
    assert.equal(routes.resolve()?.model, good.model);
    assert.equal(JSON.parse(await readFile(join(home, 'model-route.json'), 'utf8')).local.model, good.model);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid environment endpoints refuse instead of selecting stored paid routes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'invalid-endpoint-choice-'));
  try {
    let keychainChecks = 0;
    const master = randomBytes(32);
    const credentials = new CredentialStore(home, async () => master, { has: () => { keychainChecks++; return true; }, read: async () => { throw new Error('No key may be read'); } });
    const env: NodeJS.ProcessEnv = {};
    const routes = new ModelRoutes(home, credentials, env, false, true);
    await routes.change({ route: 'own', provider: 'openai', key: 'fake-own-key', model: 'paid-own' });
    await routes.change({ route: 'gateway', provider: 'openrouter', key: 'fake-gateway-key', model: 'paid-gateway' });
    // Empty means unset. Only nonempty invalid endpoints are refusals (Stack 25 correction).
    for (const endpoint of ['http://192.168.1.20:11434/v1', 'https://remote.invalid/v1', 'invalid']) {
      env.BACKBONE_MODEL_ENDPOINT = endpoint; keychainChecks = 0;
      assert.throws(() => routes.resolve(), /model endpoint.*loopback/i);
      assert.throws(() => routes.snapshot(), /model endpoint.*loopback/i);
      const settings = routes.settings();
      assert.equal(settings.active, null); assert.match(settings.hint ?? '', /model endpoint.*loopback/i);
      assert.equal(keychainChecks, 0, 'a refused endpoint must not consult the paid Keychain fallback');
    }
    env.BACKBONE_MODEL_ENDPOINT = 'http://127.0.0.1:11434/v1';
    assert.equal(routes.resolve()?.model, 'paid-own', 'a valid ambient endpoint cannot override the saved key');
    env.BACKBONE_MODEL_ENDPOINT = '';
    assert.equal(routes.resolve()?.model, 'paid-own', 'an empty override is unset');
    delete env.BACKBONE_MODEL_ENDPOINT;
    assert.equal(routes.resolve()?.model, 'paid-own', 'explicitly unsetting the override restores the saved route');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an empty environment endpoint with no saved route is unset and settings remain available', async () => {
  const home = await mkdtemp(join(tmpdir(), 'empty-endpoint-choice-'));
  try {
    const master = randomBytes(32);
    const routes = new ModelRoutes(home, new CredentialStore(home, async () => master), { BACKBONE_MODEL_ENDPOINT: '' });
    assert.equal(routes.resolve(), null);
    assert.equal(routes.snapshot().route, null);
    assert.equal(routes.settings().active, null);
    assert.doesNotMatch(routes.settings().hint ?? '', /model endpoint.*loopback/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});
