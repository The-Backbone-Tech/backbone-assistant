// Recall that ranks: BM25 over light stems, near misses at half weight, and, when the person names an
// embeddings model on this computer, similarity by meaning merged in. Only a loopback address is
// taken; with none, nothing is asked anywhere. A line holding a credential is never sent, and a
// forgotten or withdrawn line's vector leaves the cache.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Meaning } from '../src/memory/embeddings.ts';
import { startScriptedModel, type Message, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { nearMiss, rank, stem } from '../src/memory/rank.ts';
import { MemoryStore, type SourceState } from '../src/memory/store.ts';
import { idle, open, settings, value } from './helpers.ts';

const dirs: string[] = [];
const temp = (label: string) => { const d = mkdtempSync(join(tmpdir(), `memory-rank-${label}-`)); dirs.push(d); return d; };
const live: SourceState = () => 'current';
const fakeKey = ['sk', 'live', '0123456789abcdef', 'ABCDEF'].join('-');

// A stand-in embeddings server on the loopback: each text's vector counts the concepts it names.
const CONCEPTS = [/\b(car|cars|automobile|vehicle|drive)\b/i, /\b(invoice|paid|bank|pay|money)\b/i, /\b(plant|plants|water|garden)\b/i];
const vectorOf = (text: string) => [...CONCEPTS.map((c) => (c.test(text) ? 1 : 0)), 0.05];
const asked: string[][] = [];
let server: Server;
let baseUrl = '';
let model: ScriptedModel;
const given: string[] = [];
const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
before(async () => {
  model = await startScriptedModel('scripted-model', (messages) => { given.push(messages.map(words).join('\n')); return { text: 'Noted.' }; });
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const { input } = JSON.parse(body) as { model: string; input: string[] };
      asked.push(input);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
  server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('words are stemmed, a near miss counts at half weight, and a rarer word weighs more', () => {
  assert.equal(stem('paying'), stem('pays'));
  assert.equal(stem('invoices'), 'invoice');
  assert.ok(nearMiss('invoce', 'invoice') && nearMiss('invioce', 'invoice') && nearMiss('invoicex', 'invoice'));
  assert.ok(!nearMiss('car', 'cat'), 'short words must match exactly');
  const lines = ['The office plants need water.', 'The office chairs are grey.', 'The ACME invoice is paid by bank transfer.', 'The ACME office is in Leeds.'];
  assert.deepEqual(rank(lines, (l) => l, 'acme invoce').map((r) => r.item)[0], lines[2], 'a typo still finds it');
  assert.equal(rank(lines, (l) => l, 'office acme')[0].item, lines[3], 'the line with both words first');
  assert.equal(rank(lines.slice(0, 3), (l) => l, 'office acme')[0].item, lines[2], 'the rarer word weighs more than the common one');
  assert.deepEqual(rank(lines, (l) => l, 'zebra'), []);
});

test('the store ranks the best line first, newest first among equals, and leaves a withdrawn source out', () => {
  const store = new MemoryStore(temp('store'));
  const add = (text: string, sources: { id: string; name: string; version: number }[] = []) => store.add({ topic: 'facts', text, origin: { kind: 'person' }, sources }, live)!;
  add('Invoices go to finance.');
  const best = add('The ACME invoice is paid by bank transfer on the first Monday.');
  add('Plants need water on Mondays.', [{ id: 'doc', name: 'care.md', version: 1 }]);
  assert.equal(store.search('how is the acme invoice paid', live)[0].id, best.id);
  const gone: SourceState = (id) => (id === 'doc' ? 'withdrawn' : 'current');
  assert.ok(!store.search('plants water', gone).length, 'a withdrawn source\'s line is not found');
});

test('with an embeddings model on this computer, a line is found by meaning, merged with the words', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const car = value(await host.call('memory.put', { topic: 'facts', text: 'The car is serviced every March.' }));
  value(await host.call('memory.put', { topic: 'facts', text: 'The office plants need water on Mondays.' }));
  asked.length = 0;
  assert.equal((await host.call('memory.search', { query: 'automobile maintenance' })).length, 0, 'words alone find nothing');
  assert.equal(asked.length, 0, 'with no route, nothing is asked anywhere');

  const refused = await host.call('memory.meaning.put', { route: { baseUrl: 'https://embeddings.example.com/v1', model: 'm' } });
  assert.equal(refused.ok, false, 'only an address on this computer is taken');
  value(await host.call('memory.meaning.put', { route: { baseUrl, model: 'stand-in-embed' } }));
  assert.deepEqual((await host.call('memory.get', {})).meaning, { baseUrl, model: 'stand-in-embed' });

  const found = await host.call('memory.search', { query: 'automobile maintenance' });
  assert.deepEqual(found.map((e) => e.id), [car.id], 'found by meaning, and only what means it');
  // A turn is given it too: recall at the moment the model input is built uses the same ranking.
  const projectId = value(await host.call('projects.create', { name: 'P', kind: 'folder' })).id;
  const sent = value(await host.call('turns.send', { projectId, text: 'When is the automobile due for maintenance?', attachments: [], settings, clientKey: 'k' }));
  await idle(host, sent.threadId);
  const turn = value(await host.call('threads.get', { id: sent.threadId })).turns[0];
  assert.deepEqual(turn.memory?.used, [car.id]);
  assert.match(given.at(-1) ?? '', /The car is serviced every March/, 'the model was given the line');

  value(await host.call('memory.meaning.put', { route: null }));
  asked.length = 0;
  assert.equal((await host.call('memory.search', { query: 'automobile maintenance' })).length, 0, 'cleared: words alone again');
  assert.equal(asked.length, 0);
});

const cacheSize = (home: string) => Object.keys((JSON.parse(readFileSync(join(home, 'memory', '.vectors.json'), 'utf8')) as { vectors: Record<string, number[]> }).vectors).length;
const currentOf = (store: MemoryStore, state: () => SourceState, exact: () => string[] = () => [fakeKey]) => async () => ({ lines: store.candidates(state()).map((e) => e.text), exact: exact() });

test('a line holding a credential is never sent, and a forgotten or withdrawn line\'s vector leaves the cache', async () => {
  const home = temp('cache');
  const store = new MemoryStore(home);
  const meaning = new Meaning(home);
  meaning.set({ baseUrl, model: 'stand-in-embed' });
  const car = store.add({ topic: 'facts', text: 'The car is serviced every March.', origin: { kind: 'person' }, sources: [] }, live)!;
  store.add({ topic: 'facts', text: `The garage login is ${fakeKey} for the car.`, origin: { kind: 'person' }, sources: [] }, live);
  const doc = store.add({ topic: 'facts', text: 'Water the garden plants weekly.', origin: { kind: 'person' }, sources: [{ id: 'doc', name: 'care.md', version: 1 }] }, live)!;
  let state: SourceState = live;
  asked.length = 0;
  const near = await meaning.similarity('vehicle upkeep', currentOf(store, () => state));
  assert.ok(near);
  assert.ok(!asked.flat().some((t) => t.includes(fakeKey)), 'the credential line was not sent');
  assert.equal(near!(`The garage login is ${fakeKey} for the car.`), undefined);
  assert.equal(cacheSize(home), 2);

  state = (id) => (id === 'doc' ? 'withdrawn' : 'current');
  meaning.prune(store.candidates(state).map((e) => e.text), [fakeKey]);
  assert.equal(cacheSize(home), 1, 'withdrawn: its vector goes at once, with no search');
  const after = await meaning.similarity('garden', currentOf(store, () => state));
  assert.equal(after!(doc.text), undefined, 'a withdrawn line has no similarity');
  asked.length = 0;
  await meaning.similarity('vehicle upkeep', currentOf(store, () => state));
  assert.deepEqual(asked, [['vehicle upkeep']], 'a kept vector is not asked for again');
  store.forget(car.id);
  meaning.prune(store.candidates(state).map((e) => e.text), [fakeKey]);
  assert.equal(cacheSize(home), 0, 'forgotten: its vector goes');
});

test('what may be sent is asked again before each request: a line withdrawn or found to hold a credential meanwhile is not sent or kept', async () => {
  const home = temp('race');
  const store = new MemoryStore(home);
  store.add({ topic: 'facts', text: 'The car is serviced every March.', origin: { kind: 'person' }, sources: [] }, live);
  const doc = store.add({ topic: 'facts', text: 'Water the garden plants weekly.', origin: { kind: 'person' }, sources: [{ id: 'doc', name: 'care.md', version: 1 }] }, live)!;
  const secret = store.add({ topic: 'facts', text: 'The alarm code is 7731-plum-orbit.', origin: { kind: 'person' }, sources: [] }, live)!;
  let state: SourceState = live;
  let exact = [fakeKey];
  const sent: string[][] = [];
  // The query's request is where the person acts: the source is withdrawn and a credential is learned.
  const slow = (async (url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    sent.push(input);
    if (sent.length === 1) { state = (id) => (id === 'doc' ? 'withdrawn' : 'current'); exact = [fakeKey, '7731-plum-orbit']; }
    return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }));
  }) as typeof fetch;
  const meaning = new Meaning(home, slow);
  meaning.set({ baseUrl, model: 'stand-in-embed' });
  const near = await meaning.similarity('vehicle garden upkeep', currentOf(store, () => state, () => exact));
  assert.ok(!sent.flat().includes(doc.text), 'the withdrawn line was not sent');
  assert.ok(!sent.flat().includes(secret.text), 'nor the line holding a newly known credential');
  assert.equal(near!(doc.text), undefined);
  assert.equal(cacheSize(home), 1, 'only the car line is kept');
});

test('a route cleared while a request is out keeps nothing; only an address, never a name, is taken', async () => {
  const home = temp('cleared');
  const store = new MemoryStore(home);
  store.add({ topic: 'facts', text: 'The car is serviced every March.', origin: { kind: 'person' }, sources: [] }, live);
  let meaning!: Meaning;
  const clearing = (async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    meaning.set(null);
    return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }));
  }) as typeof fetch;
  meaning = new Meaning(home, clearing);
  meaning.set({ baseUrl, model: 'stand-in-embed' });
  assert.equal(await meaning.similarity('vehicle', currentOf(store, () => live)), undefined);
  assert.equal(cacheSize(home), 0);
  assert.throws(() => meaning.set({ baseUrl: 'http://localhost:11434/v1', model: 'm' }), /127\.0\.0\.1/);
  assert.throws(() => meaning.set({ baseUrl: 'http://127.0.0.1.example.com:80/v1', model: 'm' }));
  assert.throws(() => meaning.set({ baseUrl: 'http://[::ffff:7f00:1]:80/v1', model: 'm' }));
});

test('a route cleared and named again during a run sends and keeps nothing more; at most two wait, then words alone', async () => {
  const home = temp('epoch');
  const store = new MemoryStore(home);
  for (let i = 0; i < 70; i++) store.add({ topic: 'facts', text: `Car fact number ${i} about the vehicle.`, origin: { kind: 'person' }, sources: [] }, live);
  let meaning!: Meaning;
  const sent: string[][] = [];
  const flipping = (async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    sent.push(input);
    if (sent.length === 2) { meaning.set(null); meaning.set({ baseUrl, model: 'stand-in-embed' }); }
    return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }));
  }) as typeof fetch;
  meaning = new Meaning(home, flipping);
  meaning.set({ baseUrl, model: 'stand-in-embed' });
  assert.equal(await meaning.similarity('vehicle', currentOf(store, () => live)), undefined);
  assert.equal(sent.length, 2, 'the query and the first batch; nothing after the route changed');
  assert.equal(cacheSize(home), 0, 'and nothing kept');

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = new Meaning(temp('queue'), (async (_url: string, init: RequestInit) => {
    await gate;
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }));
  }) as typeof fetch);
  held.set({ baseUrl, model: 'stand-in-embed' });
  const one = async () => ({ lines: ['The car is red.'], exact: [] });
  const first = held.similarity('car', one);
  const second = held.similarity('car', one);
  assert.equal(await held.similarity('car', one), undefined, 'a third waits for nothing: words alone');
  release();
  assert.ok(await first);
  assert.ok(await second);
});

test('search shows no line holding a known credential, even one written into the files by hand', async () => {
  const { host, home } = open();
  value(await host.call('memory.put', { topic: 'facts', text: 'The garage is open on Saturdays.' }));
  appendFileSync(join(home, 'memory', 'topics', 'facts.md'), `- The garage login is ${fakeKey} for the door.\n`);
  const found = await host.call('memory.search', { query: 'garage' });
  assert.deepEqual(found.map((e) => e.text), ['The garage is open on Saturdays.']);
});

test('pruning drops the vector of a line that now holds a credential', async () => {
  const home = temp('prune-cred');
  const meaning = new Meaning(home);
  meaning.set({ baseUrl, model: 'stand-in-embed' });
  const lines = ['The car is serviced every March.', 'The alarm code is 7731-plum-orbit.'];
  await meaning.similarity('vehicle alarm', async () => ({ lines, exact: [] }));
  assert.equal(cacheSize(home), 2);
  meaning.prune(lines, ['7731-plum-orbit']);
  assert.equal(cacheSize(home), 1);
  meaning.prune(lines, null);
  assert.equal(cacheSize(home), 0, 'with no credentials to check against, none is kept');
});

test('a route that does not answer as asked leaves recall to the words', async () => {
  const home = temp('broken');
  const one = async () => ({ lines: ['The car is red.'], exact: [] });
  const meaning = new Meaning(home, (async () => new Response(JSON.stringify({ data: [{ embedding: ['x'] }] }), { status: 200 })) as typeof fetch);
  meaning.set({ baseUrl, model: 'm' });
  assert.equal(await meaning.similarity('car', one), undefined);
  const down = new Meaning(home, (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
  assert.equal(await down.similarity('car', one), undefined);
});
