// harness-hermes against a fake Hermes host: no Hermes, no model, no network beyond the loopback.
// The ToolHost is a fake that records what the engine proposed; canary keys are random per run.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HarnessEvent, HarnessTurn, ModelRoute, ToolFile, ToolHost, TurnRequest, WriteOutcome } from '@backbone-next/platform/ports';
import { createHermesHarness, type HermesHarnessOptions } from '../src/index.ts';
import { TurnGate } from '../src/gate.ts';
import type { Journal, JournalEntry } from '../src/journal.ts';
import { FakeHermes, DOORS, gateRequest, replayGate, type FakeOptions } from './fake-hermes.ts';

import { context, fakeHost, freePort, note, request, route, run, setup, tools, write } from './support.ts';

test('a write crosses once through the ToolHost; the answer, usage and text come from Hermes', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([note]);
  s.hermes.queue(write(), { say: 'Wrote ' }, { say: 'it.' }, { end: 'completed', output: 'Wrote it.' });
  const { events, outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'done', outcome.error ?? '');
  assert.equal(outcome.answer, 'Wrote it.');
  assert.deepEqual(outcome.usage, { input: 21, output: 8 });
  assert.deepEqual(writes, [{ name: 'brief.md', body: '# Brief', base: { targetVersion: null, sources: [] } }]);
  assert.deepEqual(tools(events).map((e) => e.phase), ['proposed', 'done']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'Wrote it.');
  assert.ok(events.some((e) => e.type === 'usage' && e.input === 21));
  assert.match(s.hermes.toldModel[0], /brief\.md v1/);
  await s.done();
});

test('the run carries Backbone\'s history, a per-turn session and an idempotency key; nothing else', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  await run(s.harness.start(request({ history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }], attachments: ['note.md'], system: 'Job rules.' }), context(host)));
  await run(s.harness.start(request({ turnId: 'turn-2' }), context(host)));
  const [first, second] = s.hermes.posts;
  assert.deepEqual(first.body.conversation_history, [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }]);
  assert.match(first.body.input, /Draft a brief[\s\S]*note\.md/);
  assert.match(first.body.instructions, /Job rules\./);
  assert.equal(first.body.model, 'scripted-1');
  assert.ok(first.key && second.key && first.key !== second.key);
  assert.notEqual(first.body.session_id, second.body.session_id, 'an unknown turn must not fence the next one');
  await s.done();
});

test('the run is sent with the history recall gives, and the send-time gate can refuse it before it is created', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  const stale = [{ role: 'user' as const, text: 'Hi' }, { role: 'assistant' as const, text: 'withdrawn-canary' }];
  await run(s.harness.start(request({ history: stale, recall: () => ({ history: stale.slice(0, 1) }) }), context(host)));
  assert.deepEqual(s.hermes.posts[0].body.conversation_history, [{ role: 'user', content: 'Hi' }]);
  const reason = 'A source behind this request was withdrawn before it was sent, so nothing was sent. Send it again.';
  const outcome = await s.harness.start(request({ turnId: 'turn-2', stillAllowed: () => reason }), context(host)).outcome;
  assert.equal(s.hermes.posts.length, 1, 'no second run was created');
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.error, reason);
  await s.done();
});


test('a refused tool is named, never runs, and the turn goes on', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ tool: 'terminal', args: { command: 'rm -rf /' } }, { end: 'completed', output: 'Could not.' });
  const { events, outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'done');
  assert.deepEqual(s.hermes.ran, []);
  assert.match(s.hermes.toldModel[0], /terminal is not granted/);
  const [refused] = tools(events, 'refused');
  assert.equal(refused.tool, 'terminal');
  await s.done();
});

test('policy tightened mid-run reaches the live run at the next call, though Hermes still offers the tool', async () => {
  let tightened = false;
  const s = await setup({}, { narrow: () => (tightened ? 'Writes were withdrawn from this thread.' : null) });
  const { host, writes } = fakeHost([]);
  s.hermes.queue(write('a.md'), { hold: 'tighten' }, write('b.md'), { end: 'completed', output: 'Stopped writing.' });
  const turn = s.harness.start(request(), context(host));
  const running = run(turn);
  await s.hermes.reached('tighten');
  tightened = true;
  s.hermes.release('tighten');
  const { events } = await running;
  assert.deepEqual(writes.map((w) => w.name), ['a.md']);
  assert.match(s.hermes.toldModel.at(-1)!, /withdrawn/);
  assert.equal(tools(events, 'refused').length, 1);
  await s.done();
});

test('authority only narrows: the narrowing policy cannot admit a tool the mandate does not grant', async () => {
  const s = await setup({}, { narrow: () => null });
  const { host } = fakeHost([]);
  s.hermes.queue({ tool: 'terminal', args: { command: 'id' } }, { tool: 'delegate_task', args: {} }, { end: 'completed', output: 'No.' });
  const { events } = await run(s.harness.start(request(), context(host)));
  assert.deepEqual(s.hermes.ran, []);
  assert.equal(tools(events, 'refused').length, 2);
  await s.done();
});

test('a door call with no hook decision is refused: a skipped hook cannot reach the gateway', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ doorOnly: 'door_write_file', args: { name: 'x.md', content: 'y' } }, { end: 'completed', output: 'Done.' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(writes.length, 0);
  assert.match(s.hermes.toldModel[0], /gate/);
  assert.equal(outcome.status, 'failed', 'a skipped hook is a broken boundary, not a finished turn');
  await s.done();
});

test('a ticket cannot be spent twice', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue(write('a.md'), { doorOnly: 'door_write_file', args: write('a.md').args, replayTicket: true }, { end: 'completed', output: 'Done.' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(writes.length, 1);
  assert.equal(outcome.status, 'failed');
  await s.done();
});

test('a decision is good for one call: the same arguments cannot cross twice on one hook', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue(write(), { doorOnly: 'door_write_file', args: write().args }, { end: 'completed', output: 'Done.' });
  await run(s.harness.start(request(), context(host)));
  assert.equal(writes.length, 1);
  await s.done();
});

test('arguments changed after the hook are refused', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ tool: 'door_write_file', args: { name: 'a.md', content: 'x' }, doorArgs: { name: 'other.md', content: 'x' } }, { end: 'completed', output: 'Done.' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(writes.length, 0);
  assert.equal(outcome.status, 'failed');
  await s.done();
});

test('a tool Hermes ran without the hook lands as UNKNOWN: the run is stopped and the turn fails', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ unhooked: 'terminal', args: { command: 'touch x' } }, { hold: 'after' }, write(), { end: 'completed', output: 'All good.' });
  const { events, outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /gate/);
  assert.deepEqual(tools(events, 'unknown').map((e) => e.tool), ['terminal']);
  assert.equal(s.hermes.stops.length, 1);
  await s.done();
});

test('an approval request is never answered: the run is stopped', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ event: 'approval.request', fields: { request_id: 'p1', execution_generation: 1 } }, { hold: 'waiting' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.notEqual(outcome.status, 'done');
  assert.deepEqual(s.hermes.approvals, []);
  assert.equal(s.hermes.stops.length, 1);
  await s.done();
});

test('Stop during a write leaves it UNKNOWN, and nothing crosses after it', async () => {
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const s = await setup();
  const { host, writes } = fakeHost([], (signal) => {
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'UNKNOWN', detail: 'Stopped during the write. Its outcome is UNKNOWN and it will not be resent.' }), { once: true }));
  });
  s.hermes.queue(write(), write('late.md'), { end: 'completed', output: 'Should not matter.' });
  const turn = s.harness.start(request(), context(host));
  const running = run(turn);
  await writing;
  turn.stop();
  const { events, outcome } = await running;
  assert.equal(outcome.status, 'interrupted');
  assert.equal(writes.length, 1, 'never resent');
  assert.equal(tools(events, 'unknown').length, 1);
  assert.equal(s.hermes.stops.length, 1);
  await s.done();
});

test('Stop is honest when Hermes will not stop: bounded, interrupted, and the gate stays shut', async () => {
  for (const fake of [{ stopFails: true }, { stopIgnored: true }]) {
    const s = await setup(fake);
    const { host, writes } = fakeHost([]);
    s.hermes.queue({ hold: 'running' }, write());
    const turn = s.harness.start(request(), context(host));
    const running = run(turn);
    await s.hermes.reached('running');
    turn.stop();
    const { outcome } = await running;
    assert.equal(outcome.status, 'interrupted');
    assert.match(outcome.error ?? '', /stop/i, 'says Hermes did not confirm');
    s.hermes.release('running');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(writes.length, 0, 'a late call from a run that ignored Stop does not cross');
    await s.done();
  }
});

test('an UNKNOWN write is never success: the run stops and nothing further crosses', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([], async () => ({ outcome: 'UNKNOWN', detail: 'Outcome UNKNOWN; it will not be resent.' }));
  s.hermes.queue(write('a.md'), { say: 'Everything worked.' }, write('b.md'), { end: 'completed', output: 'Everything worked.' });
  const { events, outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(writes.length, 1);
  assert.notEqual(outcome.status, 'done');
  assert.equal(tools(events, 'unknown').length, 1);
  assert.match(s.hermes.toldModel[0], /UNKNOWN/);
  await s.done();
});

test('a ToolHost that throws during a write is UNKNOWN, not a refusal and not success', async () => {
  const s = await setup();
  const { host } = fakeHost([], async () => { throw new Error('socket closed'); });
  s.hermes.queue(write(), { end: 'completed', output: 'Done.' });
  const { events, outcome } = await run(s.harness.start(request(), context(host)));
  assert.notEqual(outcome.status, 'done');
  assert.equal(tools(events, 'unknown').length, 1);
  await s.done();
});

test('a write the gateway refuses is told to the model and closes further writes', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([], async () => ({ outcome: 'REFUSED', detail: 'A person edited brief.md.' }));
  s.hermes.queue(write(), write('other.md'), { end: 'completed', output: 'Could not write.' });
  const { events, outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(writes.length, 1);
  assert.match(s.hermes.toldModel[0], /person edited/);
  assert.equal(outcome.status, 'done', 'the turn reports the refusal; it is not a failure');
  assert.equal(tools(events, 'refused').length, 2);
  await s.done();
});

test('a kill during a tool lands as UNKNOWN on our side, though Hermes keeps only a turn-level warning', async () => {
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const s = await setup();
  const { host, writes } = fakeHost([], (signal) => {
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'UNKNOWN', detail: 'Lost during the write; UNKNOWN.' }), { once: true }));
  });
  s.hermes.queue(write(), { end: 'completed', output: 'never' });
  const running = run(s.harness.start(request(), context(host)));
  await writing;
  await s.hermes.kill();
  const { events, outcome } = await running;
  assert.equal(outcome.status, 'interrupted');
  assert.equal(writes.length, 1);
  assert.equal(s.hermes.posts.length, 1, 'no replay');
  assert.deepEqual(tools(events, 'unknown').map((e) => e.tool), ['door_write_file']);
  await s.done();
});

test('the kill path stays bounded when the ToolHost ignores the abort', async () => {
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const s = await setup();
  const { host } = fakeHost([], () => {
    started();
    return new Promise(() => undefined);
  });
  s.hermes.queue(write(), { end: 'completed', output: 'never' });
  const running = run(s.harness.start(request(), context(host)));
  await writing;
  await s.hermes.kill();
  const { events, outcome } = await running;
  assert.equal(outcome.status, 'interrupted');
  assert.equal(tools(events, 'unknown').length, 1);
  await s.done();
});

test('a gateway that restarts quickly reports the run unknown; that is interrupted, never done', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ hold: 'mid' });
  const running = run(s.harness.start(request(), context(host)));
  await s.hermes.reached('mid');
  await s.hermes.kill();
  await s.hermes.restart();
  const { outcome } = await running;
  assert.equal(outcome.status, 'interrupted');
  assert.match(outcome.error ?? '', /unknown/i);
  assert.equal(s.hermes.posts.length, 1);
  await s.done();
});

test('a dropped event stream reattaches from its last sequence with nothing repeated', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ say: 'one ' }, { hold: 'drop' }, { say: 'two' }, write(), { end: 'completed', output: 'one two' });
  const running = run(s.harness.start(request(), context(host)));
  await s.hermes.reached('drop');
  await new Promise((r) => setTimeout(r, 30));
  s.hermes.dropStreams();
  await new Promise((r) => setTimeout(r, 30));
  s.hermes.release('drop');
  const { events, outcome } = await running;
  assert.equal(outcome.status, 'done', outcome.error ?? '');
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'one two');
  assert.equal(writes.length, 1);
  await s.done();
});

/** The record a process leaves when it dies at that point: nothing ran after these lines. */
test('Hermes refusing to stop after an UNKNOWN cannot hold the turn open', async () => {
  const s = await setup({ stopIgnored: true });
  const { host, writes } = fakeHost([], async () => ({ outcome: 'UNKNOWN', detail: 'UNKNOWN.' }));
  s.hermes.queue(write(), { hold: 'forever' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'interrupted');
  assert.equal(writes.length, 1);
  await s.done();
});

test('a run whose creation is unknown is not retried, and its tools find the gate shut', async () => {
  const s = await setup({ dropRunResponse: true });
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ hold: 'ghost' }, write(), { end: 'completed', output: 'ghost' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'failed');
  assert.equal(s.hermes.posts.length, 1, 'an unknown is never resent');
  s.hermes.release('ghost');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(writes.length, 0);
  assert.deepEqual(s.hermes.ran, []);
  await s.done();
});

test('a run lost at creation cannot leave a write behind the outcome: it settles first and the queue never dispatches', async () => {
  const s = await setup({ dropRunResponse: true, dropAfterMs: 60 });
  const { host, writes } = fakeHost([], () => new Promise(() => undefined));
  s.hermes.queue(write('a.md'), { end: 'completed', output: 'ghost' });
  const turn = s.harness.start(request(), context(host));
  const { events, outcome } = await run(turn);
  assert.equal(outcome.status, 'failed');
  assert.equal(tools(events, 'unknown').length, 1, 'the write in flight is accounted for before the outcome');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(writes.length, 1);
  await s.done();
});

test('a credential that never resolves cannot hold a turn or a Stop open', async () => {
  const s = await setup({}, { apiKey: () => new Promise(() => undefined), requestTimeoutMs: 100 });
  const { host } = fakeHost([]);
  const started = Date.now();
  assert.equal((await run(s.harness.start(request(), context(host)))).outcome.status, 'failed');
  const turn = s.harness.start(request({ turnId: 't2' }), context(host));
  turn.stop();
  assert.equal((await run(turn)).outcome.status, 'interrupted');
  const resumed = await run(s.harness.start(request({ turnId: 't3', resumed: true }), context(host)));
  assert.notEqual(resumed.outcome.status, 'done');
  assert.ok(Date.now() - started < 3000);
  assert.equal(s.hermes.posts.length, 0);
  await s.done();
});

test('admission refuses before any run: wrong version, missing features, missing door tools', async () => {
  const cases: Partial<FakeOptions>[] = [
    { version: '0.22.6' },
    { capabilities: { run_submission: true } },
    { capabilities: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_unknown_resolution: true, runs_idempotency: { supported: true, durable: false } } },
    { toolsets: [{ name: 'terminal', enabled: true, tools: ['terminal'] }] },
    { toolsets: [{ name: 'door', enabled: false, tools: DOORS }] },
    { toolsets: [{ name: 'door', enabled: true, tools: DOORS }, { name: 'terminal', enabled: true, tools: ['terminal'] }] },
    { toolsets: [{ name: 'door', enabled: true, tools: DOORS.slice(0, 2) }] },
    { toolsets: [{ name: 'door', enabled: true, tools: [...DOORS, 'terminal'] }] },
    { toolsets: 'not a list' as unknown as unknown[] },
  ];
  for (const fake of cases) {
    const s = await setup(fake);
    const { outcome } = await run(s.harness.start(request(), context(fakeHost([]).host)));
    assert.equal(outcome.status, 'failed', JSON.stringify(fake));
    assert.equal(s.hermes.posts.length, 0, JSON.stringify(fake));
    await s.done();
  }
});

test('a toolset read that fails during boot is read again; one that keeps failing still refuses', async () => {
  const s = await setup({ toolsetsFail: 1 }, { admissionRetryMs: 10 });
  assert.equal((await run(s.harness.start(request(), context(fakeHost([]).host)))).outcome.status, 'done');
  await s.done();
  const t = await setup({ toolsetsFail: 99 }, { admissionRetryMs: 10 });
  assert.equal((await run(t.harness.start(request(), context(fakeHost([]).host)))).outcome.status, 'failed');
  assert.equal(t.hermes.posts.length, 0);
  await t.done();
});

test('a credentialed route is refused: no secret crosses into the engine in this cut', async () => {
  const s = await setup();
  let resolved = false;
  const { outcome } = await run(s.harness.start(request(), context(fakeHost([]).host, { route: { ...route, credential: 'handle-1' }, credential: async () => ((resolved = true), 'x') })));
  assert.equal(outcome.status, 'failed');
  assert.equal(resolved, false);
  assert.equal(s.hermes.posts.length, 0);
  await s.done();
});

test('the gate refuses a wrong token, and another turn\'s session reaches nothing', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ hold: 'open' });
  const running = run(s.harness.start(request(), context(host)));
  await s.hermes.reached('open');
  const url = `http://127.0.0.1:${s.gatePort}`;
  const session_id = s.hermes.posts[0].body.session_id;
  const args = { name: 'x.md', content: 'y' };
  assert.equal((await gateRequest(url, 'wrong', '/decide', { session_id, tool_call_id: 'c', tool_name: 'door_write_file', args })).status, 401);
  const foreign = await gateRequest(url, s.gateToken, '/decide', { session_id: 'someone-else', tool_call_id: 'c', tool_name: 'door_write_file', args });
  assert.equal(foreign.json?.action, 'block');
  const door = await gateRequest(url, s.gateToken, '/call', { session_id: 'someone-else', tool_call_id: 'c', tool_name: 'door_write_file', args });
  assert.equal(door.json?.ok, false);
  assert.equal((await gateRequest(url, s.gateToken, '/decide', '{not json')).status, 200);
  s.hermes.release('open');
  await running;
  assert.equal(writes.length, 0);
  await s.done();
});

test('failures and refusals map honestly, and no key reaches an event or an outcome', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ end: 'failed', error: `provider said ${s.apiKey} and ${s.gateToken}` });
  const failed = await run(s.harness.start(request(), context(host)));
  assert.equal(failed.outcome.status, 'failed');
  assert.ok(!JSON.stringify(failed).includes(s.apiKey));
  assert.ok(!JSON.stringify(failed).includes(s.gateToken));
  s.hermes.queue({ end: 'cancelled' });
  assert.equal((await run(s.harness.start(request({ turnId: 'turn-2' }), context(host)))).outcome.status, 'interrupted');
  s.hermes.queue({ end: 'interrupted', error: 'Gateway shutdown interrupted the run.' });
  assert.equal((await run(s.harness.start(request({ turnId: 'turn-3' }), context(host)))).outcome.status, 'interrupted');
  await s.done();
});

test('door arguments of the wrong shape are refused before anything is proposed', async () => {
  const s = await setup();
  const { host, writes, reads } = fakeHost([note]);
  s.hermes.queue({ tool: 'door_write_file', args: { name: 'a.md' } }, { tool: 'door_write_file', args: { name: 7, content: 'x' } }, { tool: 'door_read_file', args: {} }, { end: 'completed', output: 'No.' });
  const { events } = await run(s.harness.start(request(), context(host)));
  assert.equal(writes.length, 0, 'a missing body is not the text "undefined"');
  assert.equal(reads.length, 0);
  assert.equal(tools(events, 'refused').length, 3);
  assert.equal(tools(events, 'proposed').length, 0);
  await s.done();
});

test('Stop before the run exists starts nothing', async () => {
  const s = await setup();
  const turn = s.harness.start(request(), context(fakeHost([]).host));
  turn.stop();
  const { outcome } = await run(turn);
  assert.equal(outcome.status, 'interrupted');
  assert.equal(s.hermes.posts.length, 0);
  await s.done();
});

test('a gate that could not bind fails that turn and can bind on the next', async () => {
  const s = await setup();
  const { createServer } = await import('node:net');
  const squatter = createServer();
  await new Promise<void>((r) => squatter.listen(s.gatePort, '127.0.0.1', r));
  const { host } = fakeHost([]);
  assert.equal((await run(s.harness.start(request(), context(host)))).outcome.status, 'failed');
  assert.equal(s.hermes.posts.length, 0);
  await new Promise((r) => squatter.close(r));
  assert.equal((await run(s.harness.start(request({ turnId: 'turn-2' }), context(host)))).outcome.status, 'done');
  await s.done();
});

function directGate(journal: Pick<Journal, 'record'>, onWrite: () => Promise<WriteOutcome>, narrow?: (call: { tool: string; args: Record<string, unknown> }) => string | null, writeTimeoutMs?: number) {
  const events: HarnessEvent[] = [];
  const log = { unknown: 0, breach: 0 };
  const { host, writes } = fakeHost([], onWrite);
  const gate = new TurnGate(host, journal as Journal, narrow, { emit: (e) => events.push(e), breach: () => (log.breach += 1), unknown: () => (log.unknown += 1) }, writeTimeoutMs);
  const pass = async (id: string, name: string) => {
    const d = gate.decide(id, 'door_write_file', { name, content: 'x' });
    return d.action === 'allow' ? gate.call(d.ticket ?? '', 'door_write_file', { name, content: 'x' }) : { ok: false, text: d.message };
  };
  return { gate, events, log, writes, pass };
}

// Open at park, item 3: a refusal from `narrow` or the queue left later writes open.
test('a write refused by policy, at the hook or in the queue, closes further writes', async () => {
  let refuse: (name: string) => boolean = (name) => name === 'a.md';
  const atHook = directGate({ record: () => undefined }, async () => ({ outcome: 'DONE', name: 'b.md', version: 1 }), ((call: { args: Record<string, unknown> }) => (refuse(String(call.args.name)) ? 'Not a.md.' : null)));
  assert.equal((await atHook.pass('a', 'a.md')).ok, false);
  assert.equal((await atHook.pass('b', 'b.md')).ok, false);
  assert.equal(atHook.writes.length, 0);

  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  refuse = () => false;
  const queued = directGate({ record: () => undefined }, async () => (await held, { outcome: 'DONE', name: 'x.md', version: 1 }), ((call: { args: Record<string, unknown> }) => (refuse(String(call.args.name)) ? 'Withdrawn.' : null)));
  const first = queued.pass('x', 'x.md');
  const second = queued.pass('y', 'y.md');
  await new Promise((r) => setTimeout(r, 10));
  refuse = (name) => name === 'y.md';
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, false, 'refused in the queue');
  refuse = () => false;
  assert.equal((await queued.pass('z', 'z.md')).ok, false, 'a later permitted write does not reach the ToolHost');
  assert.deepEqual(queued.writes.map((w) => w.name), ['x.md']);
});

test('a journal that fails after a write cannot hide its UNKNOWN or reopen writes', async () => {
  const journal = { record: (e: JournalEntry) => { if (e.kind === 'settled') throw new Error('disk full'); } };
  const g = directGate(journal, async () => ({ outcome: 'UNKNOWN', detail: 'UNKNOWN.' }));
  assert.equal((await g.pass('a', 'a.md')).ok, false);
  await g.pass('b', 'b.md');
  assert.equal(g.writes.length, 1);
  assert.equal(g.log.unknown, 1);
  assert.equal(tools(g.events, 'unknown').length, 1);
});

test('a journal that cannot record the intent stops the write before it is proposed', async () => {
  const g = directGate({ record: () => { throw new Error('disk full'); } }, async () => ({ outcome: 'DONE', name: 'a.md', version: 1 }));
  assert.equal((await g.pass('a', 'a.md')).ok, false);
  assert.equal(g.writes.length, 0);
});

test('policy withdrawn between the decision and the crossing still stops the write', async () => {
  let tight = false;
  const g = directGate({ record: () => undefined }, async () => ({ outcome: 'DONE', name: 'a.md', version: 1 }), () => (tight ? 'Withdrawn.' : null));
  const d = g.gate.decide('a', 'door_write_file', { name: 'a.md', content: 'x' });
  assert.equal(d.action, 'allow');
  tight = true;
  const r = await g.gate.call(d.action === 'allow' ? (d.ticket ?? '') : '', 'door_write_file', { name: 'a.md', content: 'x' });
  assert.equal(r.ok, false);
  assert.equal(g.writes.length, 0);
});

test('the active route must be the plane\'s declared route, on loopback, before anything is sent', async () => {
  for (const other of [{ ...route, baseUrl: 'http://127.0.0.1:2/v1' }, { ...route, model: 'other' }, { ...route, baseUrl: 'https://models.example.com/v1' }]) {
    const s = await setup({}, other.baseUrl.startsWith('https') ? { planeModel: { baseUrl: other.baseUrl, model: other.model } } : {});
    const { outcome } = await run(s.harness.start(request(), context(fakeHost([]).host, { route: other })));
    assert.equal(outcome.status, 'failed', other.baseUrl);
    assert.equal(s.hermes.posts.length, 0);
    await s.done();
  }
});

test('a key split across stream frames, and keys in tool metadata and the journal, never surface', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  const mid = Math.floor(s.apiKey.length / 2);
  s.hermes.queue({ say: `before ${s.apiKey.slice(0, mid)}` }, { say: `${s.apiKey.slice(mid)} after` }, { tool: s.gateToken, args: {} }, write(`${s.apiKey}.md`), { end: 'completed', output: 'ok' });
  const { events } = await run(s.harness.start(request(), context(host)));
  const texts = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
  assert.ok(!texts.includes(s.apiKey));
  assert.ok(texts.startsWith('before '), 'text before the key is released');
  assert.ok(!texts.includes(' after'), 'the chunk that completed the key is withheld whole, not rewritten');
  assert.ok(!JSON.stringify(events).includes(s.gateToken));
  assert.ok(!JSON.stringify(events).includes(s.apiKey));
  assert.equal(writes.length, 0, 'a key in a name or a body is refused before the ToolHost');
  const { readFile } = await import('node:fs/promises');
  const [file] = await readdir(s.journalDir);
  assert.ok(!(await readFile(join(s.journalDir, file), 'utf8')).includes(s.apiKey));
  await s.done();
});

test('a text that only looks like the start of a key is released, not swallowed', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ say: `x ${s.apiKey.slice(0, 7)}` }, { end: 'completed', output: 'ok' });
  const { events } = await run(s.harness.start(request(), context(host)));
  assert.ok(events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('').includes(s.apiKey.slice(0, 7)));
  await s.done();
});

test('a stalled event stream cannot outlive a lost Hermes: the turn ends within its deadline', async () => {
  const s = await setup({ stallStreams: true });
  const { host } = fakeHost([]);
  s.hermes.queue({ hold: 'stalled' });
  const running = run(s.harness.start(request(), context(host)));
  await s.hermes.reached('stalled');
  await s.hermes.kill();
  const { outcome } = await running;
  assert.equal(outcome.status, 'interrupted');
  await s.done();
});

test('an approval is not an execution: a write that never reached the door cannot end done', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ skipsDoor: 'door_write_file', args: write().args }, { end: 'completed', output: 'Wrote it.' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(writes.length, 0);
  assert.notEqual(outcome.status, 'done');
  await s.done();
});

test('an approved call with no completion and no door call cannot end done either', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ hold: 'approved' }, { end: 'completed', output: 'Done.' });
  const turn = s.harness.start(request(), context(host));
  const running = run(turn);
  await s.hermes.reached('approved');
  await gateRequest(`http://127.0.0.1:${s.gatePort}`, s.gateToken, '/decide', { session_id: s.hermes.posts[0].body.session_id, tool_call_id: 'c', tool_name: 'door_list_files', args: {} });
  s.hermes.release('approved');
  assert.notEqual((await running).outcome.status, 'done');
  await s.done();
});

test('a key with quotes or backslashes is caught on its decoded value, in bodies, ids and the journal', async () => {
  const gateSecret = `canary"\\${randomUUID()}`;
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'backbone-hermes-test-'));
  const hermes = await new FakeHermes({ apiKey: 'k', gateUrl: `http://127.0.0.1:${port}`, gateToken: gateSecret }).listen();
  const h = createHermesHarness({ baseUrl: hermes.url, apiKey: async () => 'k', gate: { host: '127.0.0.1', port, token: gateSecret }, journalDir: dir, planeModel: { baseUrl: route.baseUrl, model: route.model } });
  const { host, writes } = fakeHost([]);
  hermes.queue(write('a.md', `x ${gateSecret} y`), write(`${gateSecret}.md`), { end: 'completed', output: 'ok' });
  await run(h.start(request(), context(host)));
  assert.equal(writes.length, 0);
  await h.close();
  await hermes.close();
  await rm(dir, { recursive: true, force: true });
});

test('an admission refusal is sanitized at the same boundary as any outcome', async () => {
  const key = `canary-${randomUUID()}`;
  const t = await setup({ apiKey: key, anyKey: true, toolsets: [{ name: 'door', enabled: true, tools: DOORS }, { name: key, enabled: true, tools: [] }] }, { apiKey: async () => key });
  const result = await run(t.harness.start(request(), context(fakeHost([]).host)));
  assert.equal(result.outcome.status, 'failed');
  assert.ok(!JSON.stringify(result).includes(key));
  await t.done();
});

test('a wedged run whose status still says running ends at the turn deadline', async () => {
  const s = await setup({ stallStreams: true, stopIgnored: true }, { turnTimeoutMs: 150 });
  const { host } = fakeHost([]);
  s.hermes.queue({ hold: 'wedged' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'interrupted');
  assert.match(outcome.error ?? '', /time/i);
  assert.equal(s.hermes.stops.length, 1);
  await s.done();
});

test('a second start of a live turn cannot take over its gate or its ToolHost', async () => {
  const s = await setup();
  const first = fakeHost([]);
  const second = fakeHost([]);
  s.hermes.queue({ hold: 'live' }, write(), { end: 'completed', output: 'ok' });
  const running = run(s.harness.start(request(), context(first.host)));
  await s.hermes.reached('live');
  const duplicate = await run(s.harness.start(request(), context(second.host)));
  assert.equal(duplicate.outcome.status, 'failed');
  s.hermes.release('live');
  assert.equal((await running).outcome.status, 'done');
  assert.equal(first.writes.length, 1);
  assert.equal(second.writes.length, 0);
  assert.equal(s.hermes.posts.length, 1);
  await s.done();
});

test('a write the host never answers ends at its own deadline, and closes further writes', async () => {
  const g = directGate({ record: () => undefined }, () => new Promise(() => undefined), undefined, 30);
  assert.match((await g.pass('a', 'a.md')).text, /UNKNOWN/);
  await g.pass('b', 'b.md');
  assert.equal(g.writes.length, 1);
  assert.equal(g.log.unknown, 1);
  assert.equal(tools(g.events, 'unknown').length, 1);
});

test('a door connection lost during a write latches UNKNOWN, and a late DONE does not reopen writes', async () => {
  let finish!: (o: WriteOutcome) => void;
  const g = directGate({ record: () => undefined }, () => new Promise((r) => (finish = r)));
  const first = g.pass('a', 'a.md');
  await new Promise((r) => setTimeout(r, 5));
  g.gate.callLost();
  await first;
  finish({ outcome: 'DONE', name: 'a.md', version: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await g.pass('b', 'b.md');
  assert.equal(g.writes.length, 1);
  assert.equal(g.log.unknown, 1);
});

test('the gate notices a door connection that drops while a write is held', async () => {
  const s = await setup();
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const { host, writes } = fakeHost([], (signal) => {
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'UNKNOWN', detail: 'Aborted.' }), { once: true }));
  });
  s.hermes.queue({ hold: 'open' });
  const running = run(s.harness.start(request(), context(host)));
  await s.hermes.reached('open');
  const url = `http://127.0.0.1:${s.gatePort}`;
  const session_id = s.hermes.posts[0].body.session_id;
  const args = { name: 'x.md', content: 'y' };
  const d = (await gateRequest(url, s.gateToken, '/decide', { session_id, tool_call_id: 'c', tool_name: 'door_write_file', args })).json!;
  const dropped = new AbortController();
  const call = gateRequest(url, s.gateToken, '/call', { session_id, ticket: d.ticket, tool_name: 'door_write_file', args }, { signal: dropped.signal }).catch(() => undefined);
  await writing;
  dropped.abort();
  await call;
  const { outcome, events } = await running;
  assert.notEqual(outcome.status, 'done');
  assert.equal(tools(events, 'unknown').length, 1);
  assert.equal(writes.length, 1);
  await s.done();
});

test('every key a rotating source returns is scrubbed, not only the first', async () => {
  const keys = [`canary-${randomUUID()}`, `canary-${randomUUID()}`, `canary-${randomUUID()}`];
  const returned: string[] = [];
  const s = await setup({ anyKey: true }, { apiKey: async () => { const key = keys[Math.min(returned.length, keys.length - 1)]; returned.push(key); return key; } });
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ end: 'completed', output: 'first' });
  await run(s.harness.start(request({ turnId: 'turn-a' }), context(host)));
  assert.equal(returned.length, 1, 'one resolution for the first turn');
  s.hermes.queue({ end: 'completed', output: 'second' });
  await run(s.harness.start(request({ turnId: 'turn-b' }), context(host)));
  assert.equal(returned.length, 2, 'one resolution for the second turn');
  s.hermes.queue(write(`${keys[0]}.md`), { end: 'failed', error: keys.join(' ') });
  const result = await run(s.harness.start(request({ turnId: 'turn-c' }), context(host)));
  assert.equal(returned.length, 3, 'one resolution for the third turn');
  assert.equal(new Set(returned).size, 3, 'and each turn got the next key');
  for (const key of new Set(returned)) assert.ok(!JSON.stringify(result).includes(key), 'a key the source returned surfaced');
  assert.equal(writes.length, 0);
  await s.done();
});

test('a write whose call id carries a key is refused before the ToolHost, and its event passes the same sanitizer', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ ...write(), id: `id-${s.apiKey}` }, { end: 'completed', output: 'ok' });
  const { events } = await run(s.harness.start(request(), context(host)));
  assert.equal(writes.length, 0, 'an id that carries a key cannot be journaled, so the write is not proposed');
  assert.ok(tools(events, 'refused').length >= 1);
  assert.ok(!JSON.stringify(events).includes(s.apiKey));
  await s.done();
});

test('steering reaches the live run', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ hold: 'steer' }, { end: 'completed', output: 'ok' });
  const turn = s.harness.start(request(), context(host));
  const running = run(turn);
  await s.hermes.reached('steer');
  turn.steer('Shorter, please.');
  await new Promise((r) => setTimeout(r, 30));
  s.hermes.release('steer');
  await running;
  assert.deepEqual(s.hermes.steers, ['Shorter, please.']);
  await s.done();
});

// Open at park, item 2: a steer waiting on its key was sent after Stop.
test('a steer waiting on its key when Stop comes settles NOT_DELIVERED, and nothing is sent', async () => {
  const s = await setup();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let calls = 0;
  const harness = s.make({ apiKey: async () => (calls++ === 0 ? s.apiKey : held.then(() => s.apiKey)) });
  s.hermes.queue({ hold: 'steer' }, { end: 'completed', output: 'ok' });
  const turn = harness.start(request(), context(fakeHost([]).host));
  const running = run(turn);
  await s.hermes.reached('steer');
  turn.steer('Shorter, please.');
  const delivered = turn.deliver?.('And in Spanish.');
  turn.stop();
  release();
  await new Promise((r) => setTimeout(r, 50));
  s.hermes.release('steer');
  await running;
  assert.deepEqual(s.hermes.steers, []);
  assert.equal((await delivered)?.outcome, 'NOT_DELIVERED');
  assert.equal((await turn.deliver!('Too late.')).outcome, 'NOT_DELIVERED');
  await harness.close();
  await s.done();
});

// Restored: a write that outlives settlement emits its UNKNOWN later, and a key learned meanwhile is withheld from it.
test('an event from a write that outlives settlement passes the same sanitizer, with keys learned after the decision', async () => {
  const later = `canary-${randomUUID()}`;
  let calls = 0;
  const s = await setup({ anyKey: true }, { apiKey: async () => (calls++ === 0 ? `canary-${randomUUID()}` : later) });
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const { host } = fakeHost([], () => {
    started();
    return new Promise(() => undefined);
  });
  s.hermes.queue(write(`${later}.md`), { end: 'completed', output: 'never' });
  const turn = s.harness.start(request(), context(host));
  const running = run(turn);
  await writing;
  // A steer resolves the key again: the source has rotated to the text the write was decided on.
  await turn.deliver!('Go on.');
  await s.hermes.kill();
  const { events } = await running;
  const late = tools(events, 'unknown');
  assert.ok(late.length >= 1);
  // The proposal went out before the key was known, and cannot be recalled; what comes after it is sanitized.
  assert.ok(tools(events, 'proposed')[0].label.includes(later), 'the text only became sensitive after the decision');
  assert.ok(!JSON.stringify(late).includes(later));
  await s.done();
});

test('the journal is evidence only: names and digests, never document bodies or keys', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  const body = `body-${randomUUID()}`;
  s.hermes.queue(write('a.md', body), { end: 'completed', output: 'ok' });
  await run(s.harness.start(request(), context(host)));
  const { readFile } = await import('node:fs/promises');
  const files = await readdir(s.journalDir);
  assert.equal(files.length, 1);
  const text = await readFile(join(s.journalDir, files[0]), 'utf8');
  assert.match(text, /a\.md/);
  assert.ok(!text.includes(body));
  assert.ok(!text.includes(s.apiKey));
  await s.done();
});

test('DONE from the host with its reply lost before the plugin keeps its receipt, but the turn is not done', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ ...write(), lostReply: true }, { end: 'completed', output: 'All fine.' });
  const { events, outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'interrupted');
  assert.equal(writes.length, 1);
  assert.deepEqual(tools(events).map((e) => e.phase), ['proposed', 'done'], 'the outcome is the receipt, and the receipt said DONE');
  await s.done();
});

test('a read whose reply never reached the plugin keeps the turn from done', async () => {
  const s = await setup();
  const { host } = fakeHost([note]);
  s.hermes.queue({ tool: 'door_read_file', args: { name: 'note.md' }, lostReply: true }, { end: 'completed', output: 'Read it.' });
  assert.equal((await run(s.harness.start(request(), context(host)))).outcome.status, 'interrupted');
  await s.done();
});

test('an approved call that never reached the door is UNKNOWN by construction', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ hold: 'approved' }, { end: 'completed', output: 'Done.' });
  const running = run(s.harness.start(request(), context(host)));
  await s.hermes.reached('approved');
  await gateRequest(`http://127.0.0.1:${s.gatePort}`, s.gateToken, '/decide', { session_id: s.hermes.posts[0].body.session_id, tool_call_id: 'c', tool_name: 'door_list_files', args: {} });
  s.hermes.release('approved');
  const { events, outcome } = await running;
  assert.notEqual(outcome.status, 'done');
  assert.deepEqual(tools(events, 'unknown').map((e) => e.id), ['c']);
  await s.done();
});

test('a finish behind a stalled stream keeps its answer but is not done: the stream never reached its clean end', async () => {
  const s = await setup({ stallStreams: true });
  s.hermes.queue(write(), { end: 'completed', output: 'Finished unseen.' });
  const { outcome } = await run(s.harness.start(request(), context(fakeHost([]).host)));
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.answer, 'Finished unseen.');
  await s.done();
});

test('a gap in the event sequence keeps the turn from done', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ say: 'a' }, { hold: 'gap' }, { say: 'b' }, { end: 'completed', output: 'ab' });
  const running = run(s.harness.start(request(), context(host)));
  await s.hermes.reached('gap');
  s.hermes.skipNextSeq();
  s.hermes.release('gap');
  assert.notEqual((await running).outcome.status, 'done');
  await s.done();
});

test('a truncated event record keeps the turn from done', async () => {
  const s = await setup();
  s.hermes.queue({ event: 'replay.truncated' }, { end: 'completed', output: 'Fine.' });
  assert.notEqual((await run(s.harness.start(request(), context(fakeHost([]).host)))).outcome.status, 'done');
  await s.done();
});

test('a write dispatched at Stop is UNKNOWN though the host then says DONE, and that receipt is kept alongside', async () => {
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const s = await setup();
  const { host, writes } = fakeHost([], (signal) => {
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'DONE', name: 'brief.md', version: 3 }), { once: true }));
  });
  s.hermes.queue(write(), { end: 'completed', output: 'never' });
  const turn = s.harness.start(request(), context(host));
  const running = run(turn);
  await writing;
  turn.stop();
  const { events, outcome } = await running;
  assert.equal(outcome.status, 'interrupted');
  assert.equal(writes.length, 1);
  assert.equal(tools(events, 'done').length, 0, 'the late receipt never raises the outcome');
  const unknown = tools(events, 'unknown');
  assert.ok(unknown.length >= 1);
  assert.match(unknown.at(-1)!.label, /host later reported DONE/);
  assert.match(s.hermes.toldModel[0], /UNKNOWN/);
  const { readFile } = await import('node:fs/promises');
  const [file] = await readdir(s.journalDir);
  assert.match(await readFile(join(s.journalDir, file), 'utf8'), /"kind":"late"/);
  await s.done();
});

test('a DONE arriving after a write was given up on is kept as evidence and changes nothing', async () => {
  let finish!: (o: WriteOutcome) => void;
  const records: JournalEntry[] = [];
  const g = directGate({ record: (e: JournalEntry) => void records.push(e) }, () => new Promise((r) => (finish = r)));
  const first = g.pass('a', 'a.md');
  await new Promise((r) => setTimeout(r, 5));
  g.gate.callLost();
  await first;
  finish({ outcome: 'DONE', name: 'a.md', version: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(tools(g.events, 'done').length, 0);
  assert.ok(records.some((e) => e.kind === 'late' && e.id === 'a' && e.outcome === 'DONE'));
  assert.equal(g.gate.balanced, false);
});

test('the claim is durable before the run is submitted', async () => {
  const s = await setup();
  const { readdirSync } = await import('node:fs');
  let claims = -1;
  s.hermes.onPost = () => {
    claims = readdirSync(s.journalDir).length;
  };
  await run(s.harness.start(request(), context(fakeHost([]).host)));
  assert.equal(claims, 1);
  await s.done();
});

test('a turn refused at admission was never submitted, so it holds no claim', async () => {
  const s = await setup({ version: '0.22.6' });
  assert.equal((await run(s.harness.start(request(), context(fakeHost([]).host)))).outcome.status, 'failed');
  assert.deepEqual(await readdir(s.journalDir), []);
  await s.done();
});

test('a retry after a lost create only recovers: the possible run never meets a new ToolHost', async () => {
  const s = await setup({ dropRunResponse: true });
  const first = fakeHost([]);
  const second = fakeHost([]);
  s.hermes.queue({ hold: 'ghost' }, write(), { end: 'completed', output: 'ghost' });
  assert.equal((await run(s.harness.start(request(), context(first.host)))).outcome.status, 'failed');
  const retry = await run(s.harness.start(request(), context(second.host)));
  assert.equal(retry.outcome.status, 'interrupted');
  assert.equal(s.hermes.posts.length, 1, 'never resent');
  s.hermes.release('ghost');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(first.writes.length + second.writes.length, 0);
  await s.done();
});

test('a later start of a finished turn only recovers, whatever resumed says', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue(write(), { end: 'completed', output: 'Done.' });
  assert.equal((await run(s.harness.start(request(), context(host)))).outcome.status, 'done');
  const again = await run(s.harness.start(request(), context(host)));
  assert.equal(again.outcome.status, 'interrupted');
  assert.equal(s.hermes.posts.length, 1);
  assert.equal(writes.length, 1);
  await s.done();
});

test('a second process starting a claimed turn cannot submit it or reach its ToolHost', async () => {
  const s = await setup();
  const first = fakeHost([]);
  const second = fakeHost([]);
  s.hermes.queue({ hold: 'live' }, { end: 'completed', output: 'ok' });
  const running = run(s.harness.start(request(), context(first.host)));
  await s.hermes.reached('live');
  const other = s.make({ gate: { host: '127.0.0.1', port: await freePort(), token: s.gateToken } });
  assert.equal((await run(other.start(request(), context(second.host)))).outcome.status, 'interrupted');
  assert.equal(s.hermes.posts.length, 1);
  assert.equal(second.writes.length, 0);
  await other.close();
  await running;
  await s.done();
});

function heldRead(narrow?: () => string | null) {
  let answer!: (f: ToolFile & { text: string }) => void;
  const { host } = fakeHost([]);
  host.read = () => new Promise((r) => (answer = r));
  const events: HarnessEvent[] = [];
  const journal = { record: () => undefined } as unknown as Journal;
  const gate = new TurnGate(host, journal, narrow, { emit: (e) => events.push(e), breach: () => undefined, unknown: () => undefined });
  const args = { name: 'note.md' };
  const d = gate.decide('r', 'door_read_file', args);
  assert.equal(d.action, 'allow');
  const reply = gate.call(d.action === 'allow' ? (d.ticket ?? '') : '', 'door_read_file', args);
  return { gate, events, reply, answer: () => answer(note) };
}

test('a read pending at Stop returns no material', async () => {
  const h = heldRead();
  await new Promise((r) => setTimeout(r, 5));
  h.gate.close();
  h.answer();
  const reply = await h.reply;
  assert.equal(reply.ok, false);
  assert.ok(!reply.text.includes('Up 4%'));
  assert.deepEqual(tools(h.events).map((e) => e.phase), ['proposed', 'refused']);
});

test('a read pending at withdrawal returns no material', async () => {
  let withdrawn = false;
  const h = heldRead(() => (withdrawn ? 'This file was withdrawn.' : null));
  await new Promise((r) => setTimeout(r, 5));
  withdrawn = true;
  h.answer();
  const reply = await h.reply;
  assert.equal(reply.ok, false);
  assert.ok(!reply.text.includes('Up 4%'));
  assert.match(reply.text, /withdrawn/);
});

test('a read-only turn is refused before any run: Hermes cannot limit what it offers per run', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([note]);
  const { outcome } = await run(s.harness.start(request({ readOnly: true }), context(host)));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /read-only/);
  assert.equal(s.hermes.posts.length, 0);
  assert.equal(writes.length, 0);
  assert.deepEqual(await readdir(s.journalDir), [], 'never submitted, so never claimed');
  await s.done();
});

test('a second process on the same gate leaves a live run alone', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ hold: 'live' }, { end: 'completed', output: 'ok' });
  const running = run(s.harness.start(request(), context(host)));
  await s.hermes.reached('live');
  const other = s.make();
  const duplicate = await run(other.start(request(), context(fakeHost([]).host)));
  assert.notEqual(duplicate.outcome.status, 'done');
  assert.equal(s.hermes.stops.length, 0, 'the gate is held, so the run has an owner');
  await other.close();
  s.hermes.release('live');
  assert.equal((await running).outcome.status, 'done');
  await s.done();
});

test('a read the host never answers cannot hold a stopped turn open', async () => {
  const s = await setup();
  let started!: () => void;
  const reading = new Promise<void>((r) => (started = r));
  const { host } = fakeHost([]);
  host.read = () => {
    started();
    return new Promise(() => undefined);
  };
  s.hermes.queue({ tool: 'door_read_file', args: { name: 'note.md' } }, { end: 'completed', output: 'never' });
  const turn = s.harness.start(request(), context(host));
  const running = run(turn);
  await reading;
  turn.stop();
  assert.equal((await running).outcome.status, 'interrupted');
  await s.done();
});

test('a call blocked because the gate was unreachable keeps the turn from done', async () => {
  const s = await setup();
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ unreachable: 'door_write_file', args: write().args }, { end: 'completed', output: 'Blocked.' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.notEqual(outcome.status, 'done');
  assert.equal(writes.length, 0);
  assert.match(outcome.error ?? '', /could not reach the gate|blocked/i);
  await s.done();
});

test('a turn whose plugin never reported is not done, though Hermes completed it and the ledger is empty', async () => {
  const s = await setup({ noReport: true });
  s.hermes.queue({ end: 'completed', output: 'Nothing to do.' });
  const { outcome } = await run(s.harness.start(request(), context(fakeHost([]).host)));
  assert.notEqual(outcome.status, 'done');
  assert.equal(outcome.answer, 'Nothing to do.');
  await s.done();
});

test('a report that is not a count lowers the turn, and a report can never raise it', async () => {
  const s = await setup();
  s.hermes.queue({ hold: 'open' }, { end: 'completed', output: 'ok' });
  const running = run(s.harness.start(request(), context(fakeHost([]).host)));
  await s.hermes.reached('open');
  await gateRequest(`http://127.0.0.1:${s.gatePort}`, s.gateToken, '/report', { session_id: s.hermes.posts[0].body.session_id, failed: 'none' });
  s.hermes.release('open');
  assert.notEqual((await running).outcome.status, 'done', 'a later zero does not undo a bad report');
  await s.done();
});

test('a tool that started and was never accounted for keeps the turn from done', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ event: 'tool.started', fields: { tool: 'terminal', tool_call_id: 'orphan' } }, { end: 'completed', output: 'Fine.' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.notEqual(outcome.status, 'done');
  await s.done();
});

test('a tool that ran under a refused call\'s id is still caught', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ tool: 'terminal', id: 'same' }, { unhooked: 'terminal', id: 'same' }, { end: 'completed', output: 'Fine.' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'failed');
  await s.done();
});

test('a completion naming another tool than the one decided is caught', async () => {
  const s = await setup();
  const { host } = fakeHost([]);
  s.hermes.queue({ tool: 'door_list_files', id: 'same' }, { unhooked: 'terminal', id: 'same' }, { end: 'completed', output: 'Fine.' });
  const { outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'failed');
  await s.done();
});

// Finding 1: the plane's secret never travels, and nothing reaches or leaves the gate without proof.
test('a gate request signed for another turn, or replayed, is refused', async () => {
  const s = await setup();
  s.hermes.queue({ hold: 'open' }, { end: 'completed', output: 'ok' });
  const running = run(s.harness.start(request(), context(fakeHost([]).host)));
  await s.hermes.reached('open');
  const url = `http://127.0.0.1:${s.gatePort}`;
  const session_id = s.hermes.posts[0].body.session_id;
  const body = { session_id, tool_call_id: 'x1', tool_name: 'terminal', args: {} };
  assert.equal((await gateRequest(url, s.gateToken, '/decide', body, { session: 'another-turn' })).status, 401, 'a key is good for one turn');
  const first = await gateRequest(url, s.gateToken, '/decide', body);
  assert.equal(first.status, 200);
  assert.equal(first.verified, true, 'the gate proves it holds the key');
  assert.equal((await gateRequest(url, s.gateToken, '/decide', { ...body, tool_call_id: 'x2' }, { nonce: first.nonce })).status, 401, 'a nonce is good once');
  s.hermes.release('open');
  await running;
  await s.done();
});

// Finding 2: a clean report covers only what came before it.
test('a decision after a clean report needs a new report', async () => {
  const s = await setup({ noReport: true });
  s.hermes.queue({ hold: 'open' }, { end: 'completed', output: 'ok' });
  const running = run(s.harness.start(request(), context(fakeHost([]).host)));
  await s.hermes.reached('open');
  const url = `http://127.0.0.1:${s.gatePort}`;
  const session_id = s.hermes.posts[0].body.session_id;
  await gateRequest(url, s.gateToken, '/report', { session_id, failed: 0 });
  await gateRequest(url, s.gateToken, '/decide', { session_id, tool_call_id: 'late', tool_name: 'terminal', args: {} });
  s.hermes.release('open');
  assert.notEqual((await running).outcome.status, 'done');
  await s.done();
});

// Finding 3: every frame is numbered, and the stream is read to its real end.
test('a completion with no sequence number is not done', async () => {
  const s = await setup();
  s.hermes.queue({ raw: JSON.stringify({ event: 'run.completed', output: 'unnumbered' }) }, { hold: 'after' });
  const running = run(s.harness.start(request(), context(fakeHost([]).host)));
  await s.hermes.reached('after');
  s.hermes.release('after');
  assert.notEqual((await running).outcome.status, 'done');
  await s.done();
});

test('a frame after the completion lowers the turn', async () => {
  const s = await setup();
  s.hermes.queue({ end: 'completed', output: 'ok', trailing: { event: 'replay.truncated' } });
  assert.notEqual((await run(s.harness.start(request(), context(fakeHost([]).host)))).outcome.status, 'done');
  await s.done();
});

test('a malformed frame lowers the turn', async () => {
  const s = await setup();
  s.hermes.queue({ raw: '{not json' }, { end: 'completed', output: 'ok' });
  assert.notEqual((await run(s.harness.start(request(), context(fakeHost([]).host)))).outcome.status, 'done');
  await s.done();
});

// Finding 4: a write dispatched at Stop is UNKNOWN whatever arrives later.
test('a write dispatched at Stop is UNKNOWN though the host then says REFUSED, and that answer is kept alongside', async () => {
  let started!: () => void;
  const writing = new Promise<void>((r) => (started = r));
  const s = await setup();
  const { host } = fakeHost([], (signal) => {
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'REFUSED', detail: 'Refused late.' }), { once: true }));
  });
  s.hermes.queue(write(), { end: 'completed', output: 'never' });
  const turn = s.harness.start(request(), context(host));
  const running = run(turn);
  await writing;
  turn.stop();
  const { events, outcome } = await running;
  assert.equal(outcome.status, 'interrupted');
  assert.deepEqual(tools(events, 'refused'), [], 'the late answer never stands as the outcome');
  assert.match(tools(events, 'unknown').at(-1)!.label, /host later reported REFUSED/);
  assert.match(s.hermes.toldModel[0], /UNKNOWN/);
  await s.done();
});

// Finding 5: nothing on a path to the model carries a known key.
/** A key as it may be written: literally, and in the encodings the adapter checks. */
const encodings = (key: string) => {
  const b64 = Buffer.from(key).toString('base64');
  const b64url = Buffer.from(key).toString('base64url');
  return [key, b64, b64.replace(/=+$/, ''), b64url, `${b64url}==`.slice(0, b64.length), Buffer.from(key).toString('hex'), Buffer.from(key).toString('hex').toUpperCase(), [...Buffer.from(key)].map((c) => `%${c.toString(16).padStart(2, '0').toUpperCase()}`).join(''), [...Buffer.from(key)].map((c) => `%${c.toString(16).padStart(2, '0')}`).join('')];
};

test('a read result carrying a known key, literally or encoded, reaches the model scrubbed', async () => {
  const s = await setup();
  const forms = [...encodings(s.apiKey), ...encodings(s.gateToken)];
  const file = { ...note, name: 'notes.md', text: forms.map((f, i) => `form ${i}: ${f}`).join('\n') };
  const { host } = fakeHost([file]);
  s.hermes.queue({ tool: 'door_read_file', args: { name: 'notes.md' } }, { end: 'completed', output: 'ok' });
  await run(s.harness.start(request(), context(host)));
  const told = s.hermes.toldModel.join('\n');
  assert.match(told, /\[withheld\]/, 'the read was allowed and its body was withheld whole');
  assert.ok(!told.includes('form 0:'), 'nothing of a body that carries a key reaches the model');
  for (const form of forms) assert.ok(!told.includes(form), `the body still carries ${form}`);
  await s.done();
});

test('a request carrying a known key in a common encoding is not submitted', async () => {
  for (const form of encodings('placeholder').map((_, i) => i).slice(1)) {
    const s = await setup();
    const encoded = encodings(s.apiKey)[form];
    const { outcome } = await run(s.harness.start(request({ text: `use ${encoded}` }), context(fakeHost([]).host)));
    assert.equal(outcome.status, 'failed', `encoding ${form}`);
    assert.equal(s.hermes.posts.length, 0);
    await s.done();
  }
});

test('a request whose text, instructions or history carries a known key is not submitted', async () => {
  for (const extra of [(k: string) => ({ text: `use ${k}` }), (k: string) => ({ system: `key ${k}` }), (k: string) => ({ history: [{ role: 'user' as const, text: k }] }), (k: string) => ({ attachments: [`${k}.md`] })]) {
    const s = await setup();
    const { outcome } = await run(s.harness.start(request(extra(s.apiKey)), context(fakeHost([]).host)));
    assert.equal(outcome.status, 'failed');
    assert.equal(s.hermes.posts.length, 0);
    assert.ok(!JSON.stringify(outcome).includes(s.apiKey));
    await s.done();
  }
});

// Second review, item 1: a record cut off after the end is not a clean end.
test('a record cut off after the run\'s end keeps the turn from done', async () => {
  const s = await setup();
  s.hermes.queue({ end: 'completed', output: 'ok', cutTail: 'data: {"seq": 99, "event": "tool.completed"' });
  assert.notEqual((await run(s.harness.start(request(), context(fakeHost([]).host)))).outcome.status, 'done');
  await s.done();
});

// Second review, item 3: replay protection outlives a gate.
test('a request captured before a gate restart is refused after it', async () => {
  const s = await setup();
  s.hermes.queue({ hold: 'first' }, { end: 'completed', output: 'ok' });
  const first = run(s.harness.start(request(), context(fakeHost([]).host)));
  await s.hermes.reached('first');
  const url = `http://127.0.0.1:${s.gatePort}`;
  const session_id = s.hermes.posts[0].body.session_id;
  const captured = await gateRequest(url, s.gateToken, '/report', { session_id, failed: 0 });
  assert.equal(captured.status, 200);
  s.hermes.release('first');
  await first;
  await s.harness.close();
  const again = s.make();
  s.hermes.queue({ hold: 'second' }, { end: 'completed', output: 'ok' });
  const second = run(again.start(request({ turnId: 'turn-2' }), context(fakeHost([]).host)));
  await s.hermes.reached('second');
  assert.equal(await replayGate(url, captured.sent), 401, 'the same bytes, into a gate that started again');
  s.hermes.release('second');
  await second;
  await again.close();
  await s.done();
});

test('a request delayed past its deadline is refused, even on first delivery', async () => {
  const s = await setup();
  s.hermes.queue({ hold: 'open' }, { end: 'completed', output: 'ok' });
  const running = run(s.harness.start(request(), context(fakeHost([]).host)));
  await s.hermes.reached('open');
  const url = `http://127.0.0.1:${s.gatePort}`;
  const session_id = s.hermes.posts[0].body.session_id;
  const stale = await gateRequest(url, s.gateToken, '/report', { session_id, failed: 0 }, { time: Date.now() - 5 * 60_000 });
  assert.equal(stale.status, 401);
  s.hermes.release('open');
  await running;
  await s.done();
});

// Third review, item 1: a key in any mix of percent-encoding and case is still that key.
const mixed = (key: string) => {
  const hex = Buffer.from(key).toString('hex');
  const mixedHex = [...hex].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
  const partly = [...key].map((c, i) => (i % 3 === 0 ? `%${c.charCodeAt(0).toString(16)}` : c)).join('');
  const partlyUpper = [...key].map((c, i) => (i % 4 === 1 ? `%${c.charCodeAt(0).toString(16).toUpperCase()}` : c)).join('');
  const twice = partly.replace(/%/g, '%25');
  const b64Partly = [...Buffer.from(key).toString('base64')].map((c, i) => (i === 2 ? `%${c.charCodeAt(0).toString(16)}` : c)).join('');
  return [mixedHex, partly, partlyUpper, twice, b64Partly];
};

test('a read body carrying a key in mixed-case hex or partly percent-encoded reaches the model scrubbed', async () => {
  const s = await setup();
  const forms = mixed(s.apiKey);
  const file = { ...note, name: 'notes.md', text: forms.map((f, i) => `form ${i}: ${f}`).join('\n') };
  const { host } = fakeHost([file]);
  s.hermes.queue({ tool: 'door_read_file', args: { name: 'notes.md' } }, { end: 'completed', output: 'ok' });
  await run(s.harness.start(request(), context(host)));
  const told = s.hermes.toldModel.join('\n');
  assert.match(told, /\[withheld\]/);
  assert.ok(!told.includes('form 0:'));
  for (const form of forms) assert.ok(!told.includes(form), `the body still carries ${form}`);
  await s.done();
});

test('a request carrying a key in mixed-case hex or partly percent-encoded is not submitted', async () => {
  for (const i of [0, 1, 2, 3, 4]) {
    const s = await setup();
    const { outcome } = await run(s.harness.start(request({ text: `use ${mixed(s.apiKey)[i]}` }), context(fakeHost([]).host)));
    assert.equal(outcome.status, 'failed', `form ${i}`);
    assert.equal(s.hermes.posts.length, 0);
    await s.done();
  }
});

// Third review, item 2: the key a turn submits with is the key its text was checked against.
test('a key that rotates before submission is the one checked: the run goes with the resolved key', async () => {
  const keys = [`canary-${randomUUID()}`, `canary-${randomUUID()}`];
  let n = 0;
  const s = await setup({ anyKey: true }, { apiKey: async () => keys[Math.min(n++, 1)] });
  s.hermes.queue({ end: 'completed', output: 'ok' });
  await run(s.harness.start(request({ text: `mention ${keys[1]}` }), context(fakeHost([]).host)));
  for (const post of s.hermes.posts) assert.ok(!post.body.input.includes(post.auth.replace(/^Bearer /, '')), 'the text sent carries the very key it was sent with');
  await s.done();
});

test('a steer is checked against the key it is sent with, even when the key rotated', async () => {
  const keys = [`canary-${randomUUID()}`, `canary-${randomUUID()}`];
  let rotated = false;
  const s = await setup({ anyKey: true }, { apiKey: async () => (rotated ? keys[1] : keys[0]) });
  s.hermes.queue({ hold: 'steer' }, { end: 'completed', output: 'ok' });
  const turn = s.harness.start(request(), context(fakeHost([]).host));
  const running = run(turn);
  await s.hermes.reached('steer');
  rotated = true;
  turn.steer(`here is ${keys[1]}`);
  await new Promise((r) => setTimeout(r, 50));
  s.hermes.release('steer');
  await running;
  for (const [i, text] of s.hermes.steers.entries()) assert.ok(!text.includes(s.hermes.steerAuth[i].replace(/^Bearer /, '')), 'a steer carried the key it was sent with');
  await s.done();
});

// Third review, item 3: any record after the end lowers the turn, an empty one too.
test('an empty record after the run\'s end keeps the turn from done', async () => {
  const s = await setup();
  s.hermes.queue({ end: 'completed', output: 'ok', cutTail: 'data:\n\n' });
  assert.notEqual((await run(s.harness.start(request(), context(fakeHost([]).host)))).outcome.status, 'done');
  await s.done();
});

// Fourth review, item 2: a key is found in the raw text and at every decoding stage, and by its bytes.
test('a key holding %41, and a non-ASCII key, are found raw and percent-encoded, in a read body and a request', async () => {
  const apiKey = `canary-%41-${randomUUID()}`;
  const gateSecret = `ключ-${randomUUID()}`;
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'backbone-hermes-test-'));
  const hermes = await new FakeHermes({ apiKey, gateUrl: `http://127.0.0.1:${port}`, gateToken: gateSecret, anyKey: true }).listen();
  const make = () => createHermesHarness({ baseUrl: hermes.url, apiKey: async () => apiKey, gate: { host: '127.0.0.1', port, token: gateSecret }, journalDir: dir, planeModel: { baseUrl: route.baseUrl, model: route.model }, settleMs: 200, lostAfterMs: 300, stopTimeoutMs: 400 });
  const forms = [apiKey, encodeURIComponent(apiKey), gateSecret, encodeURIComponent(gateSecret), encodeURIComponent(gateSecret).toLowerCase()];
  const h = make();
  const file = { ...note, name: 'notes.md', text: forms.map((f, i) => `form ${i}: ${f}`).join('\n') };
  hermes.queue({ tool: 'door_read_file', args: { name: 'notes.md' } }, { end: 'completed', output: 'ok' });
  await run(h.start(request({ turnId: 'read' }), context(fakeHost([file]).host)));
  const told = hermes.toldModel.join('\n');
  assert.match(told, /\[withheld\]/);
  assert.ok(!told.includes('form 0:'));
  for (const form of forms) assert.ok(!told.includes(form), `the body still carries ${form}`);
  for (const [i, form] of forms.entries()) {
    const { outcome } = await run(h.start(request({ turnId: `ask-${i}`, text: `use ${form}` }), context(fakeHost([]).host)));
    assert.equal(outcome.status, 'failed', `request with form ${i}`);
  }
  assert.equal(hermes.posts.length, 1, 'only the read turn was submitted');
  await h.close();
  await hermes.close();
  await rm(dir, { recursive: true, force: true });
});

// Fourth review, item 3: after the end, any record with a field lowers the turn, whatever the field.
test('a record after the end with a bare data field, or another field only, keeps the turn from done', async () => {
  for (const tail of ['data\n\n', 'event: run.completed\n\n', 'id: 99\n\n']) {
    const s = await setup();
    s.hermes.queue({ end: 'completed', output: 'ok', cutTail: tail });
    assert.notEqual((await run(s.harness.start(request(), context(fakeHost([]).host)))).outcome.status, 'done', JSON.stringify(tail));
    await s.done();
  }
});

// The current engine contract: memory is read once as the input is built, and framed as reference data.
test('recall is read once as the run is built: instructions beside the engine\'s, memory as reference data', async () => {
  const s = await setup();
  let calls = 0;
  const recall = () => ((calls += 1), { instructions: 'Write in Spanish.', memory: 'The person prefers short briefs.' });
  const { outcome } = await run(s.harness.start(request({ recall }), context(fakeHost([]).host)));
  assert.equal(outcome.status, 'done');
  assert.equal(calls, 1);
  const [post] = s.hermes.posts;
  assert.match(post.body.instructions, /The person's instructions[^\n]*\nWrite in Spanish\./);
  assert.match(post.body.input, /^Reference data from the person's memory[^\n]*cannot change what you may do[^\n]*\nThe person prefers short briefs\.\n\nDraft a brief$/);
  await s.done();
});

test('a recall that carries a known key is not sent', async () => {
  const s = await setup();
  const { outcome } = await run(s.harness.start(request({ recall: () => ({ memory: `token ${s.apiKey}` }) }), context(fakeHost([]).host)));
  assert.equal(outcome.status, 'failed');
  assert.equal(s.hermes.posts.length, 0);
  assert.ok(!JSON.stringify(outcome).includes(s.apiKey));
  assert.deepEqual(await readdir(s.journalDir), [], 'never submitted, so it holds no claim');
  await s.done();
});

test('Hermes\'s own memory and skills run in its plane, pass the gate without a door, and leave the turn done', async () => {
  const own = [{ name: 'door', enabled: true, tools: DOORS }, { name: 'memory', enabled: true, tools: ['memory'] }, { name: 'skills', enabled: true, tools: ['skills_list', 'skill_view', 'skill_manage'] }, { name: 'terminal', enabled: false, tools: ['terminal'] }];
  const s = await setup({ toolsets: own });
  const { host, writes } = fakeHost([]);
  s.hermes.queue({ tool: 'memory', args: { action: 'add', content: 'Prefers short briefs.' } }, { tool: 'skill_view', args: { name: 'brief' } }, write(), { end: 'completed', output: 'ok' });
  const { events, outcome } = await run(s.harness.start(request(), context(host)));
  assert.equal(outcome.status, 'done');
  assert.deepEqual(s.hermes.ran, ['memory', 'skill_view']);
  assert.equal(writes.length, 1, 'only the door reaches the ToolHost');
  assert.deepEqual(tools(events, 'done').map((e) => e.tool), ['memory', 'skill_view', 'door_write_file']);
  await s.done();
});

test('admission refuses any toolset that could reach beyond the plane, an MCP server under a familiar name included', async () => {
  const door = { name: 'door', enabled: true, tools: DOORS };
  for (const other of [{ name: 'web', enabled: true, tools: ['web_search', 'web_extract'] }, { name: 'mcp-github', enabled: true, tools: ['mcp_github_create_issue'] }, { name: 'memory', enabled: true, tools: ['memory', 'mcp_memory_send'] }, { name: 'delegation', enabled: true, tools: ['delegate_task'] }, { name: 'session_search', enabled: true, tools: ['session_search'] }, { name: 'hermes-telegram', enabled: true, tools: ['terminal'] }]) {
    const s = await setup({ toolsets: [door, other] });
    const { outcome } = await run(s.harness.start(request(), context(fakeHost([]).host)));
    assert.equal(outcome.status, 'failed', other.name);
    assert.match(outcome.error ?? '', new RegExp(other.name));
    assert.equal(s.hermes.posts.length, 0);
    await s.done();
  }
});
