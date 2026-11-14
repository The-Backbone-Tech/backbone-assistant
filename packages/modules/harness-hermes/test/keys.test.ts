// How the adapter finds a known key and what it does then: every decoding stage is compared, by
// bytes, and a text that carries a key is withheld whole, never rewritten.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHermesHarness } from '../src/index.ts';
import { FakeHermes } from './fake-hermes.ts';
import { context, fakeHost, freePort, note, request, route, run } from './support.ts';

/** A harness whose gate secret is `gateSecret`, with its fake Hermes, for keys a header could not carry. */
async function withGateKey(gateSecret: string) {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'backbone-hermes-test-'));
  // A long random API key, so the only key a short text can carry is the one under test.
  const apiKey = `canary-${randomUUID()}`;
  const hermes = await new FakeHermes({ apiKey, gateUrl: `http://127.0.0.1:${port}`, gateToken: gateSecret }).listen();
  const harness = createHermesHarness({ baseUrl: hermes.url, apiKey: async () => apiKey, gate: { host: '127.0.0.1', port, token: gateSecret }, journalDir: dir, planeModel: { baseUrl: route.baseUrl, model: route.model }, settleMs: 200, lostAfterMs: 300, stopTimeoutMs: 400 });
  return {
    hermes,
    harness,
    async read(text: string, turnId: string) {
      hermes.queue({ tool: 'door_read_file', args: { name: 'data.md' } }, { end: 'completed', output: 'ok' });
      const before = hermes.toldModel.length;
      const result = await run(harness.start(request({ turnId }), context(fakeHost([{ ...note, name: 'data.md', text }]).host)));
      return { result, told: hermes.toldModel.slice(before).join('\n') };
    },
    async done() {
      await harness.close();
      await hermes.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Fifth review, (a): decoding goes bytes to bytes, so a key encoded at mixed depths is still that key.
test('a key encoded at mixed depths, é as %C3%A9 and A as %2541, is found in a read body and a request', async () => {
  const key = `é-${randomUUID()}-A`;
  const encoded = `%C3%A9${key.slice(1, -1)}%2541`;
  const g = await withGateKey(key);
  const { told } = await g.read(`token ${encoded} end`, 'read');
  assert.ok(!told.includes(encoded) && !told.includes(key), 'the mixed-depth key reached the model');
  const asked = await run(g.harness.start(request({ turnId: 'ask', text: `use ${encoded}` }), context(fakeHost([]).host)));
  assert.equal(asked.outcome.status, 'failed');
  assert.equal(g.hermes.posts.length, 1, 'only the read turn was submitted');
  await g.done();
});

// Fifth review, (b): nothing is rewritten, so a key that is, or sits inside, a marker cannot loop or leak.
test('a key that is the old marker, the placeholder, or inside either, never reaches the model and never hangs', async () => {
  for (const key of ['[credential]', 'credential', '[withheld]', 'withheld']) {
    const g = await withGateKey(key);
    const started = Date.now();
    const { result, told } = await g.read(`before ${key} after`, `read-${key}`);
    assert.ok(Date.now() - started < 5000, `${key}: the turn settled`);
    assert.ok(!told.includes(key), `${key}: the key reached the model as ${JSON.stringify(told)}`);
    assert.ok(!JSON.stringify(result).includes(key) || key === 'credential', `${key}: the key surfaced in the result`);
    await g.done();
  }
});

// Fifth review, (c): a key that is also a common word costs the text, not the key.
test('a key that is a substring of ordinary text withholds that whole text, and that is accepted', async () => {
  const g = await withGateKey('note');
  const { told } = await g.read('Revenue note: up 4% this quarter.', 'read');
  assert.ok(!told.includes('note'), 'the key reached the model');
  assert.ok(!told.includes('Revenue'), 'the rest of a text that carries a key is withheld too, not rewritten around it');
  await g.done();
});
