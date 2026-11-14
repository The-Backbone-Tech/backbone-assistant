// The commands against a stand-in api: what each receipt and turn status becomes on stdout, stderr and
// the exit code. The real host and the second-process cases are in cli.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Thread, Turn } from '@backbone-next/platform';
import { EXIT, parse, runCommand, type Api, type Io } from '../src/commands.ts';

const settled = (over: Partial<Turn>): Turn => ({
  id: 't1',
  side: false,
  user: { text: 'hello', attachments: [], at: '2026-11-01T00:00:00.000Z' },
  work: { startedAt: '2026-11-01T00:00:00.000Z', steps: [{ kind: 'read', label: 'Read note.md v1' }], harness: 'fake' },
  effects: [],
  status: 'done',
  answer: { text: 'the answer', files: [] },
  ...over,
});
const threadOf = (turn: Turn): Thread => ({
  summary: { id: 'th1', projectId: 'p1', title: 'hello', pinned: false, unread: false, archived: false, running: turn.status === 'running', updatedAt: '2026-11-01T00:00:00.000Z' },
  turns: [turn],
  sideTurns: [],
  card: { project: 'One', changes: { added: 0, removed: 0, files: 0 }, subagents: { active: 0, done: 0 }, sources: [] },
});
const PROJECT = { id: 'p1', name: 'One', kind: 'folder' as const, createdAt: '2026-11-01T00:00:00.000Z' };
const EMPTY_NOW = { running: [], needsYou: [], progress: [], current: [], temporary: [], retired: [], withdrawn: [] };

function fake(answers: Record<string, (args: never) => unknown>) {
  const calls: string[] = [];
  const api = {
    async call(method: string, args: never) {
      calls.push(method);
      const fallback: Record<string, () => unknown> = { 'projects.list': () => [PROJECT], 'models.list': () => [{ id: 'm', label: 'm', efforts: [3] }] };
      const answer = answers[method] ?? fallback[method];
      if (!answer) throw new Error(`no answer for ${method}`);
      return answer(args);
    },
  } as unknown as Api;
  return { api, calls };
}
function io() {
  const lines = { out: '', err: '' };
  const interrupts: (() => void)[] = [];
  const held: string[] = [];
  const value: Io = {
    out: (t) => void (lines.out += `${t}\n`),
    err: (t) => void (lines.err += `${t}\n`),
    onInterrupt: (fn) => void interrupts.push(fn),
    holding: (thread) => void held.push(thread),
    pollMs: 1,
    stopWaitMs: 200,
  };
  return { value, lines, interrupts, held };
}
const run = (argv: string[], api: Api, i: Io) => runCommand(parse(['--home', '/nowhere', ...argv]), api, i);
const sent = { ok: true, value: { threadId: 'th1', turnId: 't1' } };

test('a finished turn prints its steps and answer and exits 0', async () => {
  const { api } = fake({ 'turns.send': () => sent, 'threads.get': () => ({ ok: true, value: threadOf(settled({})) }) });
  const i = io();
  assert.equal(await run(['send', 'hello'], api, i.value), EXIT.OK);
  assert.match(i.lines.out, /Read note\.md v1/);
  assert.match(i.lines.out, /the answer/);
  assert.deepEqual(i.held, ['th1'], 'the thread is named to whoever holds the home, for stop');
});

test('streamed assistant text is printed once when it settles, not as growing prefixes', async () => {
  const note = (label: string) => settled({ status: 'running', answer: undefined, work: { startedAt: '', harness: 'fake', steps: [{ kind: 'note', label }] } });
  const seen = [note('I will calculate'), note('I will calculate revenue'), note('I will calculate revenue by region'), note('I will calculate revenue by region'), settled({ work: { startedAt: '', harness: 'fake', steps: [{ kind: 'note', label: 'I will calculate revenue by region' }] } })];
  let n = 0;
  const { api } = fake({ 'turns.send': () => sent, 'threads.get': () => ({ ok: true, value: threadOf(seen[Math.min(n++, seen.length - 1)]) }) });
  const i = io();
  assert.equal(await run(['send', 'hello'], api, i.value), EXIT.OK);
  const printed = i.lines.out.split('\n').filter((l) => l.includes('I will calculate'));
  assert.deepEqual(printed, ['  I will calculate revenue by region']);
});

test('a note that settles while the turn is still running is printed once and not again at the end', async () => {
  const running = settled({ status: 'running', answer: undefined, work: { startedAt: '', harness: 'fake', steps: [{ kind: 'read', label: 'Read a.md v1' }, { kind: 'note', label: 'Held for you: send. Nothing was sent.' }] } });
  const { api } = fake({ 'turns.send': () => sent, 'threads.get': (() => { let n = 0; return () => ({ ok: true, value: threadOf(n++ < 3 ? running : settled({ work: running.work })) }); })() });
  const i = io();
  await run(['send', 'hello'], api, i.value);
  assert.equal(i.lines.out.split('\n').filter((l) => l.includes('Held for you')).length, 1);
});

for (const [status, code, word] of [['stopped', EXIT.STOPPED, /STOPPED/], ['refused', EXIT.REFUSED, /REFUSED/]] as const) {
  test(`a ${status} turn exits non-zero`, async () => {
    const turn = settled({ status, ...(status === 'refused' ? { refusal: { reason: 'NOT_AVAILABLE' as const, detail: 'no model set up' } } : {}) });
    const { api } = fake({ 'turns.send': () => sent, 'threads.get': () => ({ ok: true, value: threadOf(turn) }) });
    const i = io();
    assert.equal(await run(['send', 'hello'], api, i.value), code);
    assert.match(i.lines.err, word);
  });
}

test('a turn that reads as done with an UNKNOWN write prints UNKNOWN and is never exit 0', async () => {
  const turn = settled({ effects: [{ key: 'k', kind: 'write-working-copy', target: 'brief.md', outcome: 'UNKNOWN', detail: 'stopped mid-write' }] });
  const { api } = fake({ 'turns.send': () => sent, 'threads.get': () => ({ ok: true, value: threadOf(turn) }) });
  const i = io();
  assert.equal(await run(['send', 'hello'], api, i.value), EXIT.UNKNOWN);
  assert.match(i.lines.err, /brief\.md/);
});

test('a receipt whose outcome is UNKNOWN prints UNKNOWN, not a refusal', async () => {
  const { api } = fake({ 'turns.send': () => ({ ok: false, reason: 'UNKNOWN_OUTCOME_HELD', detail: 'held', outcome: 'UNKNOWN' }) });
  const i = io();
  assert.equal(await run(['send', 'hello'], api, i.value), EXIT.UNKNOWN);
  assert.match(i.lines.err, /\(UNKNOWN_OUTCOME_HELD\)/m);
});

test('a send that throws is UNKNOWN and is not sent again', async () => {
  const { api, calls } = fake({
    'turns.send': () => {
      throw new Error('link lost');
    },
  });
  const i = io();
  assert.equal(await run(['send', 'hello'], api, i.value), EXIT.UNKNOWN);
  assert.equal(calls.filter((m) => m === 'turns.send').length, 1);
  assert.match(i.lines.err, /read it back/i);
});

test('Ctrl-C during a send asks the platform to stop, once, and reports what came of it', async () => {
  let turn = settled({ status: 'running', answer: undefined });
  let stops = 0;
  const { api } = fake({
    'turns.send': () => sent,
    'threads.get': () => ({ ok: true, value: threadOf(turn) }),
    'turns.stop': () => {
      stops++;
      turn = settled({ status: 'stopped', answer: undefined });
      return { ok: true, value: { stopped: true } };
    },
  });
  const i = io();
  const done = run(['send', 'hello'], api, i.value);
  while (!i.interrupts.length) await new Promise((r) => setTimeout(r, 1));
  i.interrupts[0]();
  assert.equal(await done, EXIT.STOPPED);
  assert.equal(stops, 1);
});

test('a stop that never settles is UNKNOWN, not success', async () => {
  const { api } = fake({
    'turns.send': () => sent,
    'threads.get': () => ({ ok: true, value: threadOf(settled({ status: 'running', answer: undefined })) }),
    'turns.stop': () => ({ ok: true, value: { stopped: true } }),
  });
  const i = io();
  const done = run(['send', 'hello'], api, i.value);
  while (!i.interrupts.length) await new Promise((r) => setTimeout(r, 1));
  i.interrupts[0]();
  assert.equal(await done, EXIT.UNKNOWN);
});

test('on a running app a running turn is live, not left by a kill, and either way it is not settled', async () => {
  const turn = settled({ status: 'running', answer: undefined });
  const { api } = fake({ 'threads.get': () => ({ ok: true, value: threadOf(turn) }) });
  const live = io();
  assert.equal(await run(['threads', 'show', 'th1'], api, { ...live.value, live: true }), EXIT.UNKNOWN);
  assert.doesNotMatch(live.lines.out, /did not finish/);
  assert.match(live.lines.out, /still running in the app/);
  const held = io();
  assert.equal(await run(['threads', 'show', 'th1'], api, held.value), EXIT.UNKNOWN);
  assert.match(held.lines.out, /did not finish here/);
});

test('threads show exits 4 while a turn holds an UNKNOWN write, with --json too', async () => {
  const turn = settled({ effects: [{ key: 'k', kind: 'write-working-copy', target: 'brief.md', outcome: 'UNKNOWN' }] });
  const { api } = fake({ 'threads.get': () => ({ ok: true, value: threadOf(turn) }) });
  const i = io();
  assert.equal(await run(['threads', 'show', 'th1', '--json'], api, i.value), EXIT.UNKNOWN);
  assert.equal(JSON.parse(i.lines.out).turns[0].effects[0].outcome, 'UNKNOWN');
});

test('now exits 4 when something is UNKNOWN and says so in those words', async () => {
  const needsYou = [{ kind: 'unknown', threadId: 'th1', title: 'hello', detail: 'write of brief.md' }];
  const { api } = fake({ 'work.now': () => ({ ...EMPTY_NOW, needsYou }) });
  const i = io();
  assert.equal(await run(['now'], api, i.value), EXIT.UNKNOWN);
  assert.match(i.lines.out, /hello/);
});

test('the only project is the default one; with several, it must be named', async () => {
  const { api } = fake({ 'projects.list': () => [PROJECT, { ...PROJECT, id: 'p2', name: 'Two' }], 'files.list': () => [] });
  const i = io();
  assert.equal(await run(['files'], api, i.value), EXIT.USAGE);
  assert.match(i.lines.err, /--project/);
  assert.equal(await run(['files', '--project', 'Two'], api, io().value), EXIT.OK);
});

test('usage mistakes are exit 2', () => {
  for (const argv of [['nonsense'], ['threads'], ['threads', 'show'], ['send'], ['projects', 'create'], ['send', 'x', '--effort', '9'], ['send', 'x', '--permission', 'all'], ['send', 'x', '--bad']]) {
    assert.equal(parse(['--home', '/nowhere', ...argv]).usage !== undefined, true, argv.join(' '));
  }
  assert.ok(parse(['projects', 'list'], {}).usage, 'no home named');
});

// /goal on the command line: the same contract as the app's composer.
const goalThread = (status: 'running' | 'met' | 'blocked', judge?: Turn['judge']): Thread => ({
  ...threadOf(settled({ id: judge ? 't2' : 't1', ...(judge ? { judge, answer: { text: judge.verdict === 'met' ? `MET: ${judge.detail}` : `BLOCKED: ${judge.detail}`, files: [] } } : {}) })),
  goal: { current: { text: 'Ship it', at: 'a', by: 'person' } as never, version: 1, proposals: [], history: [] },
  goalRun: { threadId: 'th1', status, budget: 5, used: 1, phase: 'judge', startedAt: 'a', updatedAt: 'a', ...(status === 'met' ? { evidence: { turnId: 't2', detail: 'it shipped' } } : {}), ...(status === 'blocked' ? { detail: 'pick a date' } : {}) },
});

test('goal on a thread sets it, runs it until met, and exits 0', async () => {
  let reads = 0;
  const { api, calls } = fake({
    'threads.get': () => ({ ok: true, value: reads++ < 1 ? { ...goalThread('running'), goal: undefined } : goalThread('met', { verdict: 'met', detail: 'it shipped' }) }),
    'goals.set': (a: { text: string }) => (assert.equal(a.text, 'Ship it'), { ok: true, value: { current: { text: 'Ship it' }, version: 1, proposals: [], history: [] } }),
    'goals.run': (a: { budget: number }) => (assert.equal(a.budget, 3), { ok: true, value: goalThread('running').goalRun }),
  });
  const i = io();
  assert.equal(await run(['goal', 'Ship it', '--thread', 'th1', '--budget', '3'], api, i.value), EXIT.OK);
  assert.deepEqual(calls.filter((c) => c.startsWith('goals.')), ['goals.set', 'goals.run']);
  assert.match(i.lines.out, /MET/);
  assert.match(i.lines.out, /it shipped/);
});

test('send /goal starts a chat with those words, then sets and runs the goal; blocked waits for the person', async () => {
  const { api, calls } = fake({
    'turns.send': (a: { text: string }) => (assert.equal(a.text, 'Ship it'), sent),
    'threads.get': () => ({ ok: true, value: goalThread('blocked', { verdict: 'blocked', detail: 'pick a date' }) }),
    'goals.set': () => ({ ok: true, value: { current: { text: 'Ship it' }, version: 1, proposals: [], history: [] } }),
    'goals.run': () => ({ ok: true, value: goalThread('running').goalRun }),
  });
  const i = io();
  assert.equal(await run(['send', '/goal Ship it'], api, i.value), EXIT.STOPPED);
  assert.deepEqual(calls.filter((c) => c === 'turns.send' || c.startsWith('goals.')), ['turns.send', 'goals.set', 'goals.run']);
  assert.match(i.lines.err, /pick a date/);
});

test('goal pause and resume name a thread; a budget is 1 to 50', async () => {
  const { api, calls } = fake({ 'goals.pause': () => ({ ok: true, value: goalThread('running').goalRun }) });
  const i = io();
  assert.equal(await run(['goal', 'pause', 'th1'], api, i.value), EXIT.OK);
  assert.deepEqual(calls, ['goals.pause']);
  assert.match(parse(['--home', '/x', 'goal', 'Ship it', '--budget', '0']).usage ?? '', /budget/);
});

// The person's ordinary writes beyond a send: each its own command, so it can go over the app's line.
const goalState = (version: number) => ({ current: { text: 'Ship it', by: 'person', at: 'a' }, version, proposals: [], history: [] });

test('goal set sets the words as the thread\'s goal, on the version it read, and starts nothing', async () => {
  const { api, calls } = fake({
    'threads.get': () => ({ ok: true, value: { ...goalThread('running'), goalRun: undefined } }),
    'goals.set': (a: { threadId: string; text: string; baseVersion: number }) => (assert.deepEqual(a, { threadId: 'th1', text: 'Ship it', baseVersion: 1 }), { ok: true, value: goalState(2) }),
  });
  const i = io();
  assert.equal(await run(['goal', 'set', 'Ship it', '--thread', 'th1'], api, i.value), EXIT.OK);
  assert.deepEqual(calls, ['threads.get', 'goals.set']);
  assert.match(i.lines.out, /Goal set on th1: Ship it/);
  assert.match(parse(['--home', '/x', 'goal', 'set', 'Ship it']).usage ?? '', /--thread/);
});

test('goal set that the app refuses exits 1 with its words', async () => {
  const { api } = fake({
    'threads.get': () => ({ ok: true, value: goalThread('running') }),
    'goals.set': () => ({ ok: false, reason: 'NOT_AVAILABLE', detail: 'The person has not allowed this.', outcome: 'REFUSED' }),
  });
  const i = io();
  assert.equal(await run(['goal', 'set', 'Ship it', '--thread', 'th1'], api, i.value), EXIT.REFUSED);
  assert.match(i.lines.err, /REFUSED \(NOT_AVAILABLE\): The person has not allowed this/);
});

test('goal run runs the thread\'s goal within its budget and follows it until met', async () => {
  let reads = 0;
  const { api, calls } = fake({
    'goals.run': (a: { threadId: string; budget: number }) => (assert.deepEqual(a, { threadId: 'th1', budget: 4 }), { ok: true, value: goalThread('running').goalRun }),
    'threads.get': () => ({ ok: true, value: reads++ < 1 ? goalThread('running') : goalThread('met', { verdict: 'met', detail: 'it shipped' }) }),
  });
  const i = io();
  assert.equal(await run(['goal', 'run', 'th1', '--budget', '4'], api, i.value), EXIT.OK);
  assert.deepEqual(calls.filter((c) => c.startsWith('goals.')), ['goals.run']);
  assert.match(i.lines.out, /up to 4 turns/);
  assert.match(i.lines.out, /MET/);
  assert.match(parse(['--home', '/x', 'goal', 'run']).usage ?? '', /thread/);
});

test('queue adds a message to a thread\'s queue with its settings, and says when it goes', async () => {
  const { api, calls } = fake({
    'queue.add': (a: { threadId: string; text: string; attachments: unknown[]; settings: { model: string; effort: number; permission: string; mode: string; runsOn: string } }) => {
      assert.equal(a.threadId, 'th1');
      assert.equal(a.text, 'And then the tides');
      assert.deepEqual(a.attachments, []);
      assert.deepEqual(a.settings, { permission: 'full', model: 'm', effort: 2, runsOn: 'this-computer', mode: 'plan' });
      return { ok: true, value: { id: 'q1', threadId: 'th1', text: a.text, attachments: [], settings: a.settings, clientKey: 'k', createdAt: 'a', version: 1 } };
    },
  });
  const i = io();
  assert.equal(await run(['queue', 'And then the tides', '--thread', 'th1', '--permission', 'full', '--effort', '2', '--plan'], api, i.value), EXIT.OK);
  assert.deepEqual(calls, ['models.list', 'queue.add']);
  assert.match(i.lines.out, /Queued q1 in th1/);
  assert.match(parse(['--home', '/x', 'queue', 'hello']).usage ?? '', /--thread/);
});

test('schedule add makes a schedule from the person\'s words for when, and says when it next runs', async () => {
  const { api, calls } = fake({
    'schedules.create': (a: { projectId: string; threadId?: string; text: string; when: string; settings: { model: string }; clientKey: string }) => {
      assert.equal(a.projectId, 'p1');
      assert.equal(a.threadId, undefined);
      assert.equal(a.text, 'Check the tides');
      assert.equal(a.when, 'every day at 9:00');
      assert.equal(a.settings.model, 'm');
      assert.ok(a.clientKey);
      return { ok: true, value: { id: 's1', kind: 'schedule', projectId: 'p1', threadId: null, text: a.text, when: a.when, summary: 'every day at 09:00', settings: a.settings, paused: false, createdAt: 'a', nextAt: '2026-11-05T09:00:00.000Z', lastRunAt: null, version: 1 } };
    },
  });
  const i = io();
  assert.equal(await run(['schedule', 'add', 'Check the tides', '--when', 'every day at 9:00'], api, i.value), EXIT.OK);
  assert.deepEqual(calls, ['projects.list', 'models.list', 'schedules.create']);
  assert.match(i.lines.out, /Scheduled s1: every day at 09:00, next 2026-11-05T09:00:00.000Z/);
  assert.match(parse(['--home', '/x', 'schedule', 'add', 'Check']).usage ?? '', /--when/);
  assert.match(parse(['--home', '/x', 'send', 'hi', '--when', 'now']).usage ?? '', /--when is for schedule add/);
});

for (const [reason, word, code] of [['length', 'UNFINISHED', 7], ['missing', 'UNFINISHED', 7], ['broken-stream', 'UNFINISHED', 7], ['error', 'FAILED', 6], [undefined, 'FAILED', 6]] as const) test(`failure classification: ${reason}`, async () => {
  const turn = settled({ status: 'stopped', failure: { detail: 'Provider refused the request.' }, work: { startedAt: '', harness: 'fake', steps: [], finishReason: reason } });
  const { api } = fake({ 'turns.send': () => sent, 'threads.get': () => ({ ok: true, value: threadOf(turn) }) });
  const i = io(); assert.equal(await run(['send', 'hello'], api, i.value), code);
  assert.match(i.lines.err, new RegExp(`^${word}: Provider refused the request\\.`, 'm'));
});

test('team commands name what they need in plain words', () => {
  const usage = (...argv: string[]) => parse(['--home', '/x', ...argv]).usage ?? '';
  for (const argv of [['team', 'share', '--person', 'p1', '--access', 'viewer'], ['team', 'share', '', '--person', 'p1', '--access', 'viewer']]) {
    assert.match(usage(...argv), /^team share needs a project id\.$/);
  }
  assert.match(usage('team', 'share', 'a', 'b', '--person', 'p1', '--access', 'viewer'), /^team share takes one project id\.$/);
  assert.match(usage('team', 'remove'), /^team remove needs a person id\.$/);
  assert.match(usage('team', 'remove', ''), /^team remove needs a person id\.$/);
  assert.match(usage('team', 'remove', 'a', 'b'), /^team remove takes one person id\.$/);
  assert.equal(parse(['--home', '/x', 'team', 'share', 'proj', '--person', 'p1', '--access', 'viewer']).usage, undefined);
  assert.match(usage('goal', 'run'), /needs a thread/);
});
