// The journal and the one tell chokepoint: goal and child-tree state are events and thread files a
// cache of them; whatever a turn is told from outside is on record, by source version, first.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { Turn } from '../src/api.ts';
import { createParallelWork, type ParallelDeps } from '../src/composition/parallel-work.ts';
import { runHarnessTurn } from '../src/composition/harness-turn.ts';
import { ThreadJournal, type StoredThread } from '../src/composition/thread-journal.ts';
import { replay } from '../src/composition/withdrawal.ts';
import { readJson, sha256, writeJson } from '../src/stub/fsx.ts';
import { startScriptedModel, scriptedStep, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { b64, freshHome, idle, open, settings, value } from './helpers.ts';

const text = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
function script(messages: Message[]): Step {
  const start = messages.findLastIndex((m) => m.role === 'user');
  if (/Read the note/.test(text(messages[start]))) return messages.slice(start + 1).some((m) => m.role === 'tool') ? { text: 'The note says secret.' } : { calls: [{ name: 'read_file', args: { name: 'note.md' } }] };
  return scriptedStep(messages);
}
let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel('scripted-model', script);
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

const journalOf = (home: string) => new ThreadJournal(home).read();
const threadFile = (home: string, id: string) => join(home, 'threads', `${id}.json`);

async function setup(options: Parameters<typeof open>[1] = {}) {
  const s = open(undefined, options);
  const p = value(await s.host.call('projects.create', { name: 'P', kind: 'folder' }));
  const sent = value(await s.host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'first' }));
  await idle(s.host, sent.threadId);
  return { ...s, p, threadId: sent.threadId };
}
async function closed(s: Awaited<ReturnType<typeof setup>>) {
  s.host.close();
  await (await import('../src/composition/host.ts')).hostClosed(s.home);
}

test('a goal is events: a stale or lost cache is rebuilt from the journal', async () => {
  const s = await setup();
  value(await s.host.call('goals.set', { threadId: s.threadId, text: 'Ship', baseVersion: 0 }));
  value(await s.host.call('goals.set', { threadId: s.threadId, text: 'Ship well', baseVersion: 1 }));
  assert.deepEqual(journalOf(s.home).filter((e) => e.kind === 'goal.changed').map((e) => (e as { change: { text: string } }).change.text), ['Ship', 'Ship well']);
  await closed(s);
  const stale = readJson<Record<string, unknown>>(threadFile(s.home, s.threadId), {});
  delete stale.goal;
  writeJson(threadFile(s.home, s.threadId), stale);
  const { host } = open(s.home);
  const goal = value(await host.call('threads.get', { id: s.threadId })).goal;
  assert.deepEqual([goal?.current?.text, goal?.version, goal?.history.length], ['Ship well', 2, 2]);
});

test('a child lost from the cache is rebuilt: same mandate, same link, and it cannot be started twice', async () => {
  const s = await setup();
  const kid = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', clientKey: 'c' }));
  await idle(s.host, kid.threadId);
  const before = readJson<{ child: { mandate: string } }>(threadFile(s.home, kid.threadId), null as never);
  await closed(s);
  rmSync(threadFile(s.home, kid.threadId));
  const { host } = open(s.home);
  const up = value(await host.call('threads.get', { id: s.threadId }));
  assert.deepEqual(up.children?.map((c) => [c.threadId, c.handover?.status]), [[kid.threadId, 'done']]);
  assert.equal(readJson<{ child: { mandate: string } }>(threadFile(s.home, kid.threadId), null as never).child.mandate, before.child.mandate, 'the cache is written back');
  assert.deepEqual(value(await host.call('children.start', { parentThreadId: s.threadId, text: 'Write an editable brief', role: 'worker', clientKey: 'c' })).threadId, kid.threadId);
});

test('a thread file written for a child the journal never committed is not a child', async () => {
  const s = await setup();
  await closed(s);
  const at = new Date().toISOString();
  writeJson(threadFile(s.home, 'ghost'), { summary: { id: 'ghost', projectId: s.p.id, title: 'Ghost', pinned: false, unread: false, parentId: s.threadId, archived: false, running: true, updatedAt: at },
    turns: [{ id: 'g', side: false, user: { text: 'x', attachments: [], at }, work: { startedAt: at, steps: [], harness: 'h' }, effects: [], status: 'running' }], sideTurns: [], clientKeys: ['g'],
    child: { parentThreadId: s.threadId, role: 'worker', startedBy: 'person', settings, at, mandate: '', key: 'g' } });
  const { host } = open(s.home);
  assert.ok(!(await host.call('threads.list', {})).some((t) => t.id === 'ghost'));
  assert.equal(await host.resumeInterrupted(), 0);
});

test('resume comes from the journal: a turn it holds open is interrupted whatever the cache says, and a closed one is not', async () => {
  const s = await setup();
  const events = journalOf(s.home);
  assert.deepEqual(events.filter((e) => e.threadId === s.threadId).map((e) => e.kind), ['turn.reserved', 'turn.closed']);
  await closed(s);
  const cache = readJson<{ turns: { status: string }[] }>(threadFile(s.home, s.threadId), null as never);
  cache.turns[0].status = 'running';
  writeJson(threadFile(s.home, s.threadId), cache);
  const reopened = open(s.home);
  assert.equal(value(await reopened.host.call('threads.get', { id: s.threadId })).turns[0].status, 'done', 'closed in the journal');
});

test('a stop is an event: on the journal before it is acknowledged, and honoured from there', async () => {
  const s = await setup({ writeDelayMs: 3_000 });
  const sent = value(await s.host.call('turns.send', { threadId: s.threadId, projectId: s.p.id, text: 'Write an editable brief', attachments: [], settings, clientKey: 'w' }));
  value(await s.host.call('turns.stop', { threadId: s.threadId }));
  assert.ok(journalOf(s.home).some((e) => e.kind === 'turn.stop' && e.turnId === sent.turnId));
});

test('a torn last line is dropped once, and a damaged line in the middle stops the host rather than guess', (t: TestContext) => {
  const home = mkdtempSync(join(tmpdir(), 'journal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const journal = new ThreadJournal(home);
  journal.append({ kind: 'turn.stop', threadId: 'a', turnId: 'a' });
  appendFileSync(journal.path, '{"kind":"turn.st');
  assert.equal(new ThreadJournal(home).read().length, 1);
  journal.append({ kind: 'turn.stop', threadId: 'b', turnId: 'b' });
  assert.deepEqual(new ThreadJournal(home).read().map((e) => e.threadId), ['a', 'b']);
  const lines = readFileSync(journal.path, 'utf8').split('\n');
  writeFileSync(journal.path, ['{bad', ...lines].join('\n'));
  assert.throws(() => new ThreadJournal(home).read(), /journal/i);
});

const blank = (id: string, extra: Partial<Turn> = {}): Turn => ({ id, side: false, reads: [], user: { text: 'q', attachments: [], at: 'a' }, work: { startedAt: 'a', steps: [], harness: 'h' }, effects: [], status: 'running', ...extra });
const summary = (id: string) => ({ id, projectId: 'p', title: id, pinned: false, unread: false, archived: false, running: false, updatedAt: 'a' });
function unit(t: TestContext, threads: StoredThread[], withdrawals: Record<string, { at: string; version: number; restoredAt?: string }[]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tell-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const journal = new ThreadJournal(home);
  const material = { load: (id: string) => ({ id, withdrawals: withdrawals[id] }), list: () => Object.keys(withdrawals).map((id) => ({ id, withdrawals: withdrawals[id] })) } as unknown as ParallelDeps['material'];
  const work = createParallelWork({ home, journal, material, threads: new Map(threads.map((x) => [x.summary.id, x])), running: new Map(), native: () => false, saveThread: async () => {} } as unknown as ParallelDeps);
  return { work, journal };
}
const read = (id: string, withdrawals = 0) => ({ id, name: `${id}.md`, version: 1, withdrawals });
const goalWith = (reads: Turn['reads']) => ({ current: { text: 'the goal', by: 'person' as const, at: 'a', reads }, version: 1, proposals: [], history: [] });
const kid = (turns: Turn[]): StoredThread => ({ summary: summary('kid'), turns, sideTurns: [], clientKeys: [], child: { parentThreadId: 'top', role: 'worker', startedBy: 'person', settings, at: 'a', mandate: 'm', key: 'k' } });

test('tell records the exact digest and each source by version before it returns the words', (t) => {
  const turn = blank('t');
  const top: StoredThread = { summary: summary('top'), turns: [turn], sideTurns: [], clientKeys: [], goal: goalWith([read('s')]) };
  const report = blank('A', { status: 'done', reads: [read('r')], answer: { text: 'found it', files: [] } });
  const { work, journal } = unit(t, [top, kid([report])]);
  const told = work.tell(top, turn);
  assert.match(told.text!, /the goal/);
  assert.match(told.text!, /found it/);
  const record = journal.read().filter((e) => e.kind === 'turn.told').at(-1) as Extract<ReturnType<ThreadJournal['read']>[number], { kind: 'turn.told' }>;
  assert.equal(record.digest, sha256(told.text!));
  assert.deepEqual(record.items.map((i) => [i.kind, i.sources.map((x) => [x.id, x.version, x.withdrawals]), sha256.length > 0 && !!i.digest]), [['goal', [['s', 1, 0]], true], ['report', [['r', 1, 0]], true]]);
  assert.deepEqual(turn.reads?.map((r) => [r.id, r.told]), [['s', true], ['r', true]], 'what it was told counts as read');
  assert.deepEqual(turn.handovers, [{ threadId: 'kid', turnId: 'A' }]);
});

test('a resumed turn is bound to the report it recorded, not a later one', (t) => {
  const turn = blank('t', { handovers: [{ threadId: 'kid', turnId: 'A' }] });
  const top: StoredThread = { summary: summary('top'), turns: [turn], sideTurns: [], clientKeys: [] };
  const { work } = unit(t, [top, kid([blank('A', { status: 'done', answer: { text: 'first report', files: [] } }), blank('B', { status: 'done', answer: { text: 'later report', files: [] } })])]);
  const told = work.tell(top, turn).text!;
  assert.match(told, /first report/);
  assert.doesNotMatch(told, /later report/);
});

for (const [name, state] of [['while withdrawn', [{ at: 'a', version: 1 }]], ['withdrawn then restored', [{ at: 'a', version: 1, restoredAt: 'b' }]]] as const) {
  test(`a source ${name} keeps its record dead: goal, report and brief stay back`, (t) => {
    const turn = blank('t');
    const top: StoredThread = { summary: summary('top'), turns: [turn], sideTurns: [], clientKeys: [], goal: goalWith([read('s')]) };
    const report = blank('A', { status: 'done', reads: [read('s')], answer: { text: 'it says so', files: [] }, effects: [{ key: 'e', kind: 'write-working-copy', target: 'x.md', outcome: 'DONE' }] });
    const { work, journal } = unit(t, [top, kid([report])], { s: [...state] });
    const told = work.tell(top, turn).text!;
    assert.doesNotMatch(told, /the goal/);
    assert.doesNotMatch(told, /it says so/);
    assert.match(told, /x\.md: DONE/, 'the receipts still travel');
    assert.deepEqual(turn.reads, [], 'nothing it was not given is counted as read');
    const items = (journal.read().at(-1) as Extract<ReturnType<ThreadJournal['read']>[number], { kind: 'turn.told' }>).items;
    assert.ok(items.every((i) => i.withheld), 'the record says so');

    const briefed = blank('c', { brief: 'agent', user: { text: 'quoted', attachments: [], at: 'a' } });
    const brief: StoredThread = { ...kid([briefed]), child: { ...kid([]).child!, briefSources: [read('s')] } };
    assert.ok(unit(t, [top, brief], { s: [...state] }).work.tell(brief, briefed).blocked);
  });
}

test('a read made after a restore cites the new source version, and that record is live', (t) => {
  const turn = blank('t');
  const top: StoredThread = { summary: summary('top'), turns: [turn], sideTurns: [], clientKeys: [] };
  const report = blank('A', { status: 'done', reads: [read('s', 1)], answer: { text: 'read since', files: [] } });
  const { work } = unit(t, [top, kid([report])], { s: [{ at: 'a', version: 1, restoredAt: 'b' }] });
  assert.match(work.tell(top, turn).text!, /read since/);
});

test('what a person restored stays out through the whole path: a told parent answer does not return to history', async () => {
  const { host } = open(undefined, { harness: 'harness-pi' });
  const p = value(await host.call('projects.create', { name: 'P', kind: 'folder' }));
  const source = value(await host.call('material.attach', { projectId: p.id, name: 'note.md', base64: b64('secret'), mediaType: 'text/markdown' }));
  const top = value(await host.call('turns.send', { projectId: p.id, text: 'Hello', attachments: [], settings, clientKey: 'a' }));
  await idle(host, top.threadId);
  const child = value(await host.call('children.start', { parentThreadId: top.threadId, text: 'Read the note', role: 'worker', clientKey: 'b' }));
  await idle(host, child.threadId);
  value(await host.call('turns.send', { threadId: top.threadId, projectId: p.id, text: 'Quote the report', attachments: [], settings, clientKey: 'c' }));
  const after = await idle(host, top.threadId);
  assert.ok(after.turns.at(-1)!.reads?.some((r) => r.name === 'note.md' && r.told));
  const out = value(await host.call('material.lifecycle', { id: source.id, version: 1, state: 'withdrawn', lifecycle: 0 }));
  value(await host.call('material.lifecycle', { id: source.id, version: 1, state: 'current', lifecycle: out.lifecycle }));
  const mark = model.requests.length;
  value(await host.call('turns.send', { threadId: top.threadId, projectId: p.id, text: 'And now?', attachments: [], settings, clientKey: 'd' }));
  await idle(host, top.threadId);
  assert.ok(model.requests.slice(mark).every((q) => !q.body.includes('The note says secret')), 'neither the report nor an answer built on it');
});

test('the engine starts only after the record is on the journal, and nothing is told past a blocked brief', async (t) => {
  const turn = blank('t');
  const home = mkdtempSync(join(tmpdir(), 'order-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const journal = new ThreadJournal(home);
  const material = { load: () => ({ withdrawals: [] }), list: () => [] };
  const base = { material, projectId: 'p', gateway: {}, writeDelayMs: 0, signal: new AbortController().signal, threadId: 'x', history: [], resumed: false, route: { label: 'r', kind: 'endpoint' }, credential: async () => '', progress: () => {} };
  let at = -1;
  let given = '';
  await runHarnessTurn({ ...base, tell: () => { journal.append({ kind: 'turn.told', threadId: 'x', turnId: 't', digest: 'd', items: [] }); return { text: 'told' }; },
    harness: { start: (r: { text: string }) => { at = journal.read().length; given = r.text; throw new Error('enough'); } } } as never, turn, []);
  assert.equal(at, 1);
  assert.match(given, /^told\n\nq$/);
  let started = false;
  const stopped = blank('b', { brief: 'agent' });
  await runHarnessTurn({ ...base, tell: () => ({ blocked: true }), harness: { start: () => { started = true; throw new Error('no'); } } } as never, stopped, []);
  assert.deepEqual([started, stopped.status, /withdrawn/.test(stopped.answer!.text)], [false, 'stopped', true]);
});

test('a fork of a briefed child keeps the brief under its sources', (t) => {
  const briefed = blank('c', { brief: 'agent', status: 'done', user: { text: 'quoted-brief', attachments: [], at: 'a' } });
  const next = blank('n');
  const fork: StoredThread = { summary: summary('fork'), turns: [briefed, next], sideTurns: [], clientKeys: [], briefSources: [read('s')] };
  assert.doesNotMatch(unit(t, [fork], { s: [{ at: 'a', version: 1, restoredAt: 'b' }] }).work.tell(fork, next).text ?? '', /quoted-brief/);
});

test('forking through the api carries the brief\'s sources', async () => {
  const s = await setup();
  const home = s.home;
  const journal = new ThreadJournal(home);
  const k = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Hello again', role: 'worker', clientKey: 'c' }));
  await idle(s.host, k.threadId);
  await closed(s);
  const event = journal.read().find((e) => e.kind === 'turn.reserved' && e.threadId === k.threadId) as Extract<ReturnType<ThreadJournal['read']>[number], { kind: 'turn.reserved' }>;
  const line = JSON.stringify(event);
  const edited = JSON.stringify({ ...event, created: { ...event.created, child: { ...event.created!.child, briefSources: [read('s')] } } });
  writeFileSync(journal.path, readFileSync(journal.path, 'utf8').replace(line, edited));
  const { host } = open(home);
  const fork = value(await host.call('threads.fork', { id: k.threadId, clientKey: 'f' }));
  assert.deepEqual(readJson<StoredThread>(threadFile(home, fork.id), null as never).briefSources?.map((x) => x.id), ['s']);
});

test('a parent stop reaches a child interrupted and not yet resumed, on the journal', async (t) => {
  const waiting = blank('c');
  const interrupted: StoredThread = { ...kid([waiting]), summary: { ...summary('kid'), running: true } };
  const top: StoredThread = { summary: summary('top'), turns: [blank('t', { status: 'done' })], sideTurns: [], clientKeys: [] };
  const { work, journal } = unit(t, [top, interrupted]);
  journal.append({ kind: 'turn.reserved', threadId: 'kid', turn: waiting, clientKey: 'k' });
  work.replayed();
  assert.equal(await work.stopChildren('top'), 1);
  assert.equal(waiting.stopRequested, true);
  assert.ok(journal.read().some((e) => e.kind === 'turn.stop' && e.turnId === 'c'));
});

test('a direct reread does not cost a told source its record', () => {
  const told = { ...read('s'), inherited: true, told: true };
  const turn = blank('a', { status: 'done', reads: [told, read('s')], answer: { text: 'from the report', files: [] } });
  const restored = { load: () => ({ withdrawals: [{ at: 'a', version: 1, restoredAt: 'b' }] }), list: () => [] };
  assert.equal(replay([turn], restored as never, 'p').history.some((h) => h.role === 'assistant'), false, 'its own answer stays out');
  const before = { load: () => ({ withdrawals: [] }), list: () => [] };
  const { inherited } = replay([turn], before as never, 'p');
  const next = blank('b', { status: 'done', reads: inherited, answer: { text: 'repeats the report', files: [] } });
  assert.equal(replay([next], restored as never, 'p').history.some((h) => h.role === 'assistant'), false, 'nor does one that inherited it');
});

test('a new host replays after the old one has let go, so its last events count', async () => {
  const s = await setup();
  s.host.close();
  const next = open(s.home);
  // The closing host's last act, after the new one was constructed and before it holds the home.
  new ThreadJournal(s.home).append({ kind: 'goal.changed', threadId: s.threadId, change: { action: 'set', text: 'Late', by: 'person', at: 'a' } });
  assert.equal(value(await next.host.call('threads.get', { id: s.threadId })).goal?.current?.text, 'Late');
});

test('a withdrawn source version stays dead after a restore, for a direct read too, and only a fresh read brings the source back', () => {
  const restored = { load: () => ({ withdrawals: [{ at: 'a', version: 1, restoredAt: 'b' }] }), list: () => [] };
  const before = blank('a', { status: 'done', reads: [read('s')], answer: { text: 'pre-withdrawal words', files: [] } });
  const first = replay([before], restored as never, 'p');
  assert.deepEqual(first.history, [{ role: 'user', text: 'q' }], 'the person\'s words stay and the answer does not');
  assert.deepEqual(first.inherited, [], 'nothing is inherited that hides the withdrawal');
  const afresh = blank('b', { status: 'done', reads: [read('s', 1)], answer: { text: 'read afresh', files: [] } });
  const second = replay([before, afresh], restored as never, 'p');
  assert.ok(second.history.some((h) => h.text === 'read afresh'));
  assert.deepEqual(second.inherited.map((r) => [r.id, r.withdrawals]), [['s', 1]]);
});

test('an inherited read keeps the count it was read at, so the withdrawal after it still counts', () => {
  const withdrawnLater = { load: () => ({ withdrawals: [{ at: 'a', version: 1, restoredAt: 'b' }] }), list: () => [] };
  const inheritedOnly = blank('b', { status: 'done', reads: [{ ...read('s'), inherited: true }], answer: { text: 'built on the old answer', files: [] } });
  assert.equal(replay([inheritedOnly], withdrawnLater as never, 'p').history.some((h) => h.role === 'assistant'), false);
});

test('what is not enforced is on the child for the person to see', async () => {
  const s = await setup();
  const k = value(await s.host.call('children.start', { parentThreadId: s.threadId, text: 'Hello again', role: 'worker', clientKey: 'c' }));
  await idle(s.host, k.threadId);
  const view = value(await s.host.call('threads.get', { id: s.threadId })).children![0];
  assert.deepEqual(view.notEnforced?.map((n) => n.axis), ['permission', 'token-budget']);
  assert.ok(view.notEnforced?.every((n) => n.detail.length > 0));
  assert.deepEqual(value(await s.host.call('threads.get', { id: k.threadId })).child?.notEnforced, view.notEnforced);
});
