import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { verifyPolicy, PolicyRefused, ENFORCEMENT_GAPS } from '../src/policy/index.ts';
import { pinnedRoute, pinFor, turnRoute } from '../src/selection/pin.ts';
import { Meaning } from '../src/memory/embeddings.ts';
import { document, signed, systemFixture } from './policy-fixture.ts';
import { freshDir, open, value } from './helpers.ts';

const samples: Record<keyof typeof ENFORCEMENT_GAPS, unknown> = { harnesses: ['harness-pi'], keyHolders: ['keychain'], standingSignatures: false, standingServers: [], telemetryRequired: true };
for (const section of ['requirements', 'defaults'] as const) for (const [key, value] of Object.entries(samples)) test(`${section}.${key} verifies now that its product hooks are installed`, () => {
  const p = document({}, {});
  p[section] = { [key]: value, ...(key === 'telemetryRequired' && section === 'requirements' ? { telemetryHost: 'collector.test' } : {}) };
  const result = verifyPolicy(signed(p));
  assert.equal(result.status, 'verified', JSON.stringify(result));
  assert.deepEqual(Object.keys(ENFORCEMENT_GAPS), []);
});
test('mandatory telemetry cannot use a personal sink without a required endpoint or host', () => {
  const result = verifyPolicy(signed(document({ telemetryRequired: true })));
  assert.equal(result.status, 'refused');
  if (result.status === 'refused') { assert.equal(result.code, 'format'); assert.match(result.detail, /endpoint or host in requirements/); }
});
test('defaults cannot choose unrestricted rights or plaintext, while restricted rights remains usable', () => {
  for (const defaults of [{ personRights: true }, { keyHolders: ['plaintext'] }, { keyHolders: ['keychain', 'plaintext'] }]) {
    const result = verifyPolicy(signed(document({}, defaults))); assert.equal(result.status, 'refused');
    if (result.status === 'refused') assert.equal(result.code, 'weakening-default');
  }
  assert.equal(verifyPolicy(signed(document({}, { personRights: false }))).status, 'verified');
  const stricterHolder = verifyPolicy(signed(document({}, { keyHolders: ['keychain'] })));
  assert.equal(stricterHolder.status, 'verified');
});
test('a pinned local route cannot bypass a required own route or provider', t => {
  systemFixture(t, document({ modelRoutes: ['own'], modelProviders: ['openai'] }));
  const pinned = { kind: 'endpoint' as const, provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9000/v1', model: 'fake', label: 'local fixture' };
  const selection = { routeId: 'local:fake:model', task: { needs: ['model' as const], network: true, spend: 'metered' as const }, reasons: [], pinned };
  assert.ok('refused' in pinnedRoute(selection, null));
  assert.ok('refused' in turnRoute(selection, undefined, null, false)!);
  const local = { runtimes: [{ provider: 'ollama' as const, name: 'fake', baseUrl: pinned.baseUrl, models: ['fake'] }] };
  assert.ok('refused' in pinFor({ id: 'local:ollama:fake', kind: 'local-model', label: 'fake' } as never, [], selection.task, local as never, null));
});
test('embeddings refuse before fetch and recheck policy immediately before later batches', async t => {
  const home = freshDir('policy-embedding-');
  const { mkdirSync } = await import('node:fs'); mkdirSync(join(home, 'memory'));
  const fixture = systemFixture(t, document({ modelRoutes: ['own'] }));
  writeFileSync(join(home, 'memory', '.meaning.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'fake' }));
  let requests = 0;
  const meaning = new Meaning(home, async () => { requests++; return new Response('{}'); });
  assert.equal(await meaning.similarity('words', async () => ({ lines: ['remembered'], exact: [] })), undefined);
  assert.equal(requests, 0);
  assert.throws(() => meaning.set({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'fake' }), PolicyRefused);
  fixture.update(document({ modelRoutes: ['endpoint'] }));
  const changed = new Meaning(home, async () => { requests++; fixture.update(document({ modelProviders: ['openai'] })); return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] })); });
  await assert.rejects(changed.similarity('words', async () => ({ lines: ['remembered'], exact: [] })), PolicyRefused);
  assert.equal(requests, 1);
});

test('a forbidden saved embeddings route leaves memory visible and searchable by words without requests', async t => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const { host, home } = open();
  const remembered = value(await host.call('memory.put', { topic: 'facts', text: 'The garage opens on Saturdays.' }));
  const route = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'fake' };
  value(await host.call('memory.meaning.put', { route }));
  const fixture = systemFixture(t, document({ modelRoutes: ['own'] }));
  const view = await host.call('memory.get', {});
  assert.equal(view.meaning, null);
  assert.ok(view.entries.some(entry => entry.id === remembered.id));
  assert.deepEqual((await host.call('memory.search', { query: 'garage' })).map(entry => entry.id), [remembered.id]);
  assert.equal(requests, 0);
  assert.equal(new Meaning(home).route(), null);
  fixture.tamper();
  assert.throws(() => new Meaning(home).route(), PolicyRefused, 'an invalid policy is never word-only fallback');
  await assert.rejects(host.call('memory.get', {}), PolicyRefused);
  await assert.rejects(host.call('memory.search', { query: 'garage' }), PolicyRefused);
  assert.equal(requests, 0);
});
