// Recovery against a fake Hermes host: what a later start of a claimed turn reads from the journal,
// and what the journal keeps so that reading stays true. No Hermes, no model, no network beyond the loopback.
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TurnGate } from '../src/gate.ts';
import { Journal, readJournal, type JournalEntry } from '../src/journal.ts';
import { context, fakeHost, freePort, request, run, setup, tools, write } from './support.ts';

function crashedRecord(s: { journalDir: string }, ...entries: JournalEntry[]) {
  const journal = new Journal(s.journalDir, request().threadId, request().turnId);
  for (const entry of entries) journal.record(entry);
  journal.close();
}

test('restart: a resumed turn never starts a run and an unsettled write lands as UNKNOWN', async () => {
  const s = await setup();
  crashedRecord(s, { kind: 'admitting' }, { kind: 'run', runId: 'run_gone' }, { kind: 'intent', id: 'c1', tool: 'door_write_file', name: 'brief.md' });
  const { host, writes } = fakeHost([]);
  const resumed = await run(s.harness.start(request({ resumed: true }), context(host)));
  assert.equal(resumed.outcome.status, 'interrupted');
  assert.deepEqual(tools(resumed.events, 'unknown').map((e) => [e.tool, e.label, e.id]), [['door_write_file', 'Write brief.md', 'c1']]);
  assert.equal(s.hermes.posts.length, 0, 'no replay');
  assert.equal(writes.length, 0);
  await s.done();
});

test('restart: a settled write stays settled; only what never settled is UNKNOWN', async () => {
  const s = await setup();
  crashedRecord(s, { kind: 'admitting' }, { kind: 'run', runId: 'run_gone' }, { kind: 'intent', id: 'c1', tool: 'door_write_file', name: 'a.md' }, { kind: 'settled', id: 'c1', outcome: 'done' }, { kind: 'intent', id: 'c2', tool: 'door_write_file', name: 'b.md' });
  const resumed = await run(s.harness.start(request({ resumed: true }), context(fakeHost([]).host)));
  assert.deepEqual(tools(resumed.events, 'unknown').map((e) => e.id), ['c2']);
  await s.done();
});

test('restart: a torn last journal line is read as never committed, not as a corrupt attempt', async () => {
  const s = await setup();
  crashedRecord(s, { kind: 'admitting' }, { kind: 'run', runId: 'run_gone' }, { kind: 'intent', id: 'c1', tool: 'door_write_file', name: 'a.md' });
  const [file] = await readdir(s.journalDir);
  await appendFile(join(s.journalDir, file), '{"kind":"settled","id":"c1","outc');
  const resumed = await run(s.harness.start(request({ resumed: true }), context(fakeHost([]).host)));
  assert.deepEqual(tools(resumed.events, 'unknown').map((e) => e.id), ['c1']);
  await s.done();
});

test('restart: a run Hermes is still executing is stopped, not joined and not repeated', async () => {
  const s = await setup();
  s.hermes.queue({ hold: 'alive' });
  void run(s.harness.start(request({ turnId: 'first' }), context(fakeHost([]).host))).catch(() => undefined);
  await s.hermes.reached('alive');
  crashedRecord(s, { kind: 'admitting' }, { kind: 'run', runId: s.hermes.runs[0].id });
  const after = s.make({ gate: { host: '127.0.0.1', port: await freePort(), token: s.gateToken } });
  const resumed = await run(after.start(request({ resumed: true }), context(fakeHost([]).host)));
  assert.equal(resumed.outcome.status, 'interrupted');
  assert.equal(s.hermes.stops.length, 1);
  assert.equal(s.hermes.posts.length, 1);
  await after.close();
  await s.done();
});

test('restart: with no record of the attempt nothing is started', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  const { outcome } = await run(s.harness.start(request({ resumed: true }), context(host)));
  assert.equal(outcome.status, 'failed');
  assert.equal(s.hermes.posts.length, 0);
  assert.equal(writes.length, 0);
  await s.done();
});

test('the journal withholds a name on its decoded value and refuses an id that carries a key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backbone-hermes-test-'));
  const secret = 'canary"quoted';
  const journal = new Journal(dir, 't', 'u', (text) => (text.includes(secret) ? '[withheld]' : text));
  journal.record({ kind: 'intent', id: 'c1', tool: 'door_write_file', name: `${secret}.md` });
  assert.throws(() => journal.record({ kind: 'intent', id: `id-${secret}`, tool: 'door_write_file', name: 'a.md' }));
  assert.throws(() => journal.record({ kind: 'run', runId: `run-${secret}` }));
  journal.close();
  const [file] = await readdir(dir);
  const text = await readFile(join(dir, file), 'utf8');
  assert.ok(!text.includes('quoted'));
  assert.deepEqual(readJournal(dir, 't', 'u')?.open, [{ id: 'c1', tool: 'door_write_file', name: '[withheld]' }]);
  await rm(dir, { recursive: true, force: true });
});

// Open at park, item 1: withholding rewrote structural fields, so recovery dropped an unsettled write.
test('a key equal to a journal kind cannot erase an unsettled write: recovery still reports it UNKNOWN', async () => {
  const s = await setup({ anyKey: true }, { apiKey: async () => 'intent' });
  const { host } = fakeHost([], () => new Promise(() => undefined));
  s.hermes.queue(write(), { end: 'completed', output: 'never' });
  const turn = s.harness.start(request(), context(host));
  const running = run(turn);
  for (let i = 0; i < 200 && !readJournal(s.journalDir, 'thread-1', 'turn-1')?.open.length; i += 1) await new Promise((r) => setTimeout(r, 10));
  // A second process after a crash: it reads the journal the first one left.
  const other = s.make();
  const recovered = await run(other.start(request({ resumed: true }), context(fakeHost([]).host)));
  assert.deepEqual(tools(recovered.events, 'unknown').map((e) => e.label), ['Write brief.md']);
  await other.close();
  turn.stop();
  await running;
  await s.done();
});

test('restart: a key source that is down does not hide an UNKNOWN write', async () => {
  const s = await setup({}, { apiKey: async () => { throw new Error('vault down'); } });
  crashedRecord(s, { kind: 'admitting' }, { kind: 'run', runId: 'run_gone' }, { kind: 'intent', id: 'c1', tool: 'door_write_file', name: 'a.md' });
  const resumed = await run(s.harness.start(request({ resumed: true }), context(fakeHost([]).host)));
  assert.equal(resumed.outcome.status, 'interrupted');
  assert.deepEqual(tools(resumed.events, 'unknown').map((e) => e.id), ['c1']);
  await s.done();
});

test('restart: a write already known UNKNOWN stays UNKNOWN', async () => {
  const s = await setup();
  crashedRecord(s, { kind: 'admitting' }, { kind: 'run', runId: 'run_gone' }, { kind: 'intent', id: 'c1', tool: 'door_write_file', name: 'a.md' }, { kind: 'settled', id: 'c1', outcome: 'unknown' });
  const resumed = await run(s.harness.start(request({ resumed: true }), context(fakeHost([]).host)));
  assert.deepEqual(tools(resumed.events, 'unknown').map((e) => e.id), ['c1']);
  await s.done();
});

test('restart: a late DONE stays UNKNOWN and is shown alongside', async () => {
  const s = await setup();
  crashedRecord(s, { kind: 'admitting' }, { kind: 'run', runId: 'run_gone' }, { kind: 'intent', id: 'c1', tool: 'door_write_file', name: 'a.md' }, { kind: 'settled', id: 'c1', outcome: 'unknown' }, { kind: 'late', id: 'c1', outcome: 'DONE' });
  const resumed = await run(s.harness.start(request({ resumed: true }), context(fakeHost([]).host)));
  assert.deepEqual(tools(resumed.events, 'unknown').map((e) => e.id), ['c1']);
  assert.match(resumed.outcome.error ?? '', /a\.md/);
  assert.match(resumed.outcome.error ?? '', /DONE/);
  await s.done();
});

test('restart: a write the gateway finished is named, so the recovered account keeps its receipt', async () => {
  const s = await setup();
  crashedRecord(s, { kind: 'admitting' }, { kind: 'run', runId: 'run_gone' }, { kind: 'intent', id: 'c1', tool: 'door_write_file', name: 'landed.md' }, { kind: 'settled', id: 'c1', outcome: 'done' });
  const resumed = await run(s.harness.start(request({ resumed: true }), context(fakeHost([]).host)));
  assert.equal(resumed.outcome.status, 'interrupted');
  assert.match(resumed.outcome.error ?? '', /landed\.md/);
  assert.deepEqual(tools(resumed.events, 'unknown'), []);
  await s.done();
});

test('restart: a write approved at the hook and lost before the door is UNKNOWN, not forgotten', async () => {
  const s = await setup();
  const journal = new Journal(s.journalDir, request().threadId, request().turnId);
  const gate = new TurnGate(fakeHost([]).host, journal, undefined, { emit: () => undefined, breach: () => undefined, unknown: () => undefined });
  assert.equal(gate.decide('c1', 'door_write_file', { name: 'a.md', content: 'x' }).action, 'allow');
  journal.close();
  const resumed = await run(s.harness.start(request({ resumed: true }), context(fakeHost([]).host)));
  assert.deepEqual(tools(resumed.events, 'unknown').map((e) => e.id), ['c1']);
  await s.done();
});
