import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshHome } from './helpers.ts';
import { plaintextKeys } from '../src/keys/vault.ts';
import { Vault } from '../src/keys/vault.ts';
import { CredentialStore } from '../src/credentials/store.ts';
import { collectorEndpoint, collectorHeaders, putTelemetryEndpoint, putTelemetryHeaders, readTelemetrySettings, resolveTelemetryHeaders } from '../src/credentials/telemetry.ts';

const files = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);

test('telemetry is configured only by the home and preserves its other settings', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ harness: 'harness-pi', other: { kept: true } }));
  assert.equal(readTelemetrySettings(home), undefined);
  await putTelemetryEndpoint(home, 'http://127.0.0.1:4318/v1/traces');
  assert.deepEqual(readTelemetrySettings(home), { endpoint: 'http://127.0.0.1:4318/v1/traces' });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')), { harness: 'harness-pi', other: { kept: true }, telemetry: { endpoint: 'http://127.0.0.1:4318/v1/traces' } });
  await putTelemetryEndpoint(home, undefined);
  assert.equal(readTelemetrySettings(home), undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')), { harness: 'harness-pi', other: { kept: true } });
});

test('collector URLs reject credentials, queries, fragments and non-HTTP schemes without echoing input', () => {
  const marker = 'collector-secret-marker';
  for (const value of [`https://${marker}@example.test/v1/traces`, `https://example.test/?key=${marker}`, `https://example.test/#${marker}`, 'https://example.test/?', 'https://example.test/#', `file:///${marker}`, marker]) {
    assert.throws(() => collectorEndpoint(value), error => error instanceof Error && !error.message.includes(marker));
  }
  assert.equal(collectorEndpoint('https://example.test/v1/traces'), 'https://example.test/v1/traces');
});

test('collector HTTP is confined to loopback and every collector URL names an explicit path', () => {
  for (const value of [
    'http://localhost:4318/v1/traces', 'http://LOCALHOST:4318/v1/traces',
    'http://127.0.0.1:4318/v1/traces', 'http://127.42.99.5:4318/v1/traces',
    'http://[::1]:4318/v1/traces', 'http://[0:0:0:0:0:0:0:1]:4318/v1/traces',
    'https://collector.example/v1/traces', 'https://collector.example/custom/traces',
  ]) assert.equal(collectorEndpoint(value), new URL(value).href);
  const marker = 'unsafe-collector-marker';
  for (const value of [
    `http://${marker}.example/v1/traces`, 'http://10.0.0.1/v1/traces',
    'http://192.168.1.2/v1/traces', 'http://172.16.0.1/v1/traces',
    'http://0.0.0.0/v1/traces', 'http://128.0.0.1/v1/traces',
    'http://localhost.example/v1/traces', 'http://localhost./v1/traces',
    'http://127.0.0.1.example/v1/traces', 'http://[::]/v1/traces',
    'http://[::ffff:127.0.0.1]/v1/traces', 'http://[fe80::1]/v1/traces',
    'https://collector.example', 'https://collector.example/',
    'http://127.0.0.1:4318', 'http://localhost:4318/',
    'https://collector.example/path/..',
  ]) assert.throws(() => collectorEndpoint(value), error => error instanceof Error && !error.message.includes(marker));
});

test('collector headers are sealed, rotated and absent from home settings', async () => {
  const home = freshHome(), marker = 'collector-header-secret-marker';
  await putTelemetryHeaders(home, { Authorization: `Bearer ${marker}` }, plaintextKeys());
  assert.equal((await resolveTelemetryHeaders(home, plaintextKeys())).authorization, `Bearer ${marker}`);
  assert.equal(readTelemetrySettings(home), undefined);
  const vault = await Vault.open(home, plaintextKeys()), store = new CredentialStore(home, () => vault.masterKey());
  assert.ok((await store.values()).includes(`Bearer ${marker}`), 'Existing credential scrubbers can see the individual sealed header value.');
  const prior = JSON.parse(readFileSync(join(home, 'credentials', 'telemetry.json'), 'utf8')).authorization as string;
  await putTelemetryHeaders(home, { 'x-api-key': marker }, plaintextKeys());
  assert.equal((await resolveTelemetryHeaders(home, plaintextKeys()))['x-api-key'], marker);
  assert.ok(!readdirSync(join(home, 'credentials')).includes(`${prior}.json`));
  for (const path of files(join(home, 'credentials'))) assert.ok(!readFileSync(path).includes(Buffer.from(marker)));
});

test('invalid header objects are rejected before anything is sealed', async () => {
  const home = freshHome();
  for (const value of [null, [], { Authorization: 4 }, { Authorization: 'line\r\nbreak' }, { 'content-type': 'text/plain' }, { Host: 'elsewhere' }, { 'not a header': 'x' }, { Authorization: 'a', authorization: 'b' }]) {
    assert.throws(() => collectorHeaders(value));
    await assert.rejects(putTelemetryHeaders(home, value, plaintextKeys()));
  }
  assert.deepEqual(await resolveTelemetryHeaders(home, plaintextKeys()), {});
});

test('disabling telemetry deletes only its sealed credentials and index without opening the vault', async () => {
  const home = freshHome(), vault = await Vault.open(home, plaintextKeys());
  const store = new CredentialStore(home, () => vault.masterKey());
  const unrelated = await store.put('unrelated-credential-fixture', 'unrelated credential');
  await putTelemetryEndpoint(home, 'https://collector.example/v1/traces');
  await putTelemetryHeaders(home, { Authorization: 'Bearer collector-removal-fixture', 'x-api-key': 'collector-removal-key' }, plaintextKeys()); // public-tree: synthetic
  const index = join(home, 'credentials', 'telemetry.json');
  const handles = Object.values(JSON.parse(readFileSync(index, 'utf8'))) as string[];
  const vaultBefore = readFileSync(join(home, 'keys', 'vault.json'));
  Vault.forget(home);
  await putTelemetryEndpoint(home, undefined);
  assert.equal(readTelemetrySettings(home), undefined);
  assert.equal(existsSync(index), false);
  for (const handle of handles) assert.equal(store.has(handle), false);
  assert.equal(await store.resolve(unrelated), 'unrelated-credential-fixture');
  assert.deepEqual(readFileSync(join(home, 'keys', 'vault.json')), vaultBefore);
  assert.deepEqual(await resolveTelemetryHeaders(home), {});
  await putTelemetryEndpoint(home, undefined);
  assert.equal(store.has(unrelated), true);
});
