// A key the person stored in the Keychain makes an OpenRouter route, for a host told to read it, and
// for no other. A stand-in reader; the real `security` tool is never called here.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CredentialStore } from '../src/credentials/store.ts';
import type { KeychainReader } from '../src/credentials/keychain.ts';
import { ModelRoutes } from '../src/models/route.ts';
import { personKeychainRoutes } from '../src/credentials/keychain.ts';

const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
const CANARY = 'sk-or-canary-7f3a';

function setup(stored: Record<string, string>, reads: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'keychain-route-')); homes.push(home);
  const keychain: KeychainReader = {
    has: (service) => service in stored,
    read: async (service) => { reads.push(service); if (!(service in stored)) throw new Error('none'); return stored[service]; },
  };
  const master = randomBytes(32);
  return { home, keychain, reads, store: (withKeychain = true) => new CredentialStore(home, async () => master, withKeychain ? keychain : undefined) };
}

test('a stored key routes Pi through OpenRouter, read only when a turn asks for it', async () => {
  const s = setup({ 'backbone-openrouter': CANARY });
  const store = s.store();
  const route = new ModelRoutes(s.home, store, {}, false, true).resolve();
  assert.equal(route?.kind, 'gateway');
  assert.equal(route?.provider, 'openrouter');
  assert.equal(route?.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(route?.credential, 'keychain:backbone-openrouter');
  assert.match(route!.label, /Keychain/);
  assert.equal(s.reads.length, 0, 'choosing the route reads no value');
  assert.equal(await store.resolve(route!.credential!), CANARY);
  assert.deepEqual(s.reads, ['backbone-openrouter']);
  assert.deepEqual(readdirSync(s.home), [], 'nothing about the key is written to the home');
  assert.doesNotMatch(JSON.stringify(new ModelRoutes(s.home, store, {}, false, true).settings()), new RegExp(CANARY));
});

test('no stored key, no route: the turn says so and nothing is sent', () => {
  const s = setup({});
  assert.equal(new ModelRoutes(s.home, s.store(), {}, false, true).resolve(), null);
});

test('a host not told to read the Keychain never finds the key, as tests and journeys are not', async () => {
  const s = setup({ 'backbone-openrouter': CANARY });
  assert.equal(new ModelRoutes(s.home, s.store(), {}, false, false).resolve(), null, 'routes off');
  const blind = s.store(false);
  assert.equal(blind.has('keychain:backbone-openrouter'), false);
  await assert.rejects(blind.resolve('keychain:backbone-openrouter'), /does not read the Keychain/);
  assert.equal(s.reads.length, 0);
});

test('only the named service can be reached, and the person\'s own choices come first', async () => {
  const s = setup({ 'backbone-openrouter': CANARY, 'other-service': 'x' });
  const store = s.store();
  assert.equal(store.has('keychain:other-service'), false);
  await assert.rejects(store.resolve('keychain:other-service'), /removed|handle/);
  assert.deepEqual(s.reads, [], 'an unnamed service is never read');
  const routes = new ModelRoutes(s.home, store, {}, false, true);
  await routes.change({ route: 'own', provider: 'openai', key: 'sk-own', model: 'gpt-x' });
  assert.equal(routes.resolve()?.kind, 'own', 'a key pasted in Settings wins');
  await routes.change({ route: 'own', clear: true });
  await routes.change({ route: 'gateway', provider: 'openrouter', key: 'sk-pasted', model: 'some/model' });
  assert.equal(routes.resolve()?.credential?.startsWith('cred_'), true, 'so does a gateway key pasted in Settings');
  await routes.change({ route: 'gateway', clear: true });
  assert.equal(routes.resolve()?.credential, 'keychain:backbone-openrouter');
  assert.equal(routes.resolve()?.model, 'anthropic/claude-sonnet-5.5');
  const codex = new ModelRoutes(s.home, store, { BACKBONE_CODEX_MODEL: 'gpt-6.1-terra' }, true, true).resolve();
  assert.equal(codex?.kind, 'native', 'the installed Codex stays the default where it runs');
  assert.doesNotMatch(codex!.label, /ChatGPT|plan/i, 'the route label does not infer subscription billing from client sign-in');
});

test('only the person\'s own app launch reads Keychain routes; every test or journey launch is told apart', () => {
  assert.equal(personKeychainRoutes({}, 'darwin'), true, 'the person\'s app: no named home, no scripted model');
  assert.equal(personKeychainRoutes({ BACKBONE_HOME: '/tmp/journey-home' }, 'darwin'), false);
  assert.equal(personKeychainRoutes({ BACKBONE_MODEL_ENDPOINT: 'http://127.0.0.1:1/v1' }, 'darwin'), false);
  assert.equal(personKeychainRoutes({ BACKBONE_KEYS: 'plaintext' }, 'darwin'), false);
  assert.equal(personKeychainRoutes({}, 'linux'), false);
});

// Stack 25 correction: an ambient endpoint does not override a person's stored key.
// Real test launches disable Keychain discovery; this explicitly opted-in reader is fake.
test('an opted-in stored Keychain key precedes an ambient endpoint and survives an empty or unset endpoint', () => {
  const s = setup({ 'backbone-openrouter': CANARY });
  for (const endpoint of ['http://127.0.0.1:9/v1', '', undefined]) {
    const route = new ModelRoutes(s.home, s.store(), { BACKBONE_MODEL_ENDPOINT: endpoint }, false, true).resolve();
    assert.deepEqual({ kind: route?.kind, credential: route?.credential }, { kind: 'gateway', credential: 'keychain:backbone-openrouter' });
  }
});
