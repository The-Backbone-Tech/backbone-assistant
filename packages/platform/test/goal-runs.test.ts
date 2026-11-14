// A goal that runs until it is met: the goal text is the completion criterion; after each turn a
// judge turn on the same route checks the work against it and answers met, not met (what is
// missing) or blocked (the decision needed). Not met goes on within the person's turn budget;
// blocked waits for them; met closes with its evidence. The judge waits for the goal's children,
// a person's Stop pauses the run, and the judge's words are an assessment, never authority.
// Threads also fork from any turn, and every thread's words can be searched.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { GoalRun, Thread } from '../src/api.ts';
import { startScriptedModel, type Message, type ScriptedModel, type Step } from '../src/testing/scripted-model.ts';
import { pollUntil, idle, open, settings, value  } from './helpers.ts';

const words = (m: Message) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(''));
/** What the judge says next, per goal, in order; the last repeats. */
const verdicts = new Map<string, string[]>();
let holding = false;
function answering(messages: Message[]): Step {
  const start = messages.findLastIndex((m) => m.role === 'user');
  const asked = words(messages[start]);
  // A check can carry a child's report, whose words may say anything: the check is answered first.
  const goal = /completion criterion:\s*(.+)/.exec(asked)?.[1]?.trim();
  if (goal && /Goal check/.test(asked)) {
    const queue = verdicts.get(goal) ?? ['NOT MET: nothing yet'];
    return { text: queue.length > 1 ? queue.shift()! : queue[0] };
  }
  if (/Hold on/.test(asked)) return holding ? { calls: [{ name: 'list_files', args: {} }] } : { text: 'Held and done.' };
  return { text: 'Worked on it.' };
}

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel('scripted-model', answering);
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

const pi = () => open(undefined, { harness: 'harness-pi' });
type H = ReturnType<typeof pi>['host'];
async function goalThread(host: H, goal: string) {
  const projectId = value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;
  const sent = value(await host.call('turns.send', { projectId, text: 'Start the plan', attachments: [], settings, clientKey: `start:${goal}` }));
  await idle(host, sent.threadId);
  value(await host.call('goals.set', { threadId: sent.threadId, text: goal, baseVersion: 0 }));
  return { projectId, threadId: sent.threadId };
}
const runOf = async (host: H, threadId: string) => value(await host.call('threads.get', { id: threadId })).goalRun;
async function settledRun(host: H, threadId: string, done: (r: GoalRun) => boolean): Promise<Thread> {
  return await pollUntil(async active => {
    while (active()) {
      const t = value(await host.call('threads.get', { id: threadId }));
      if (t.goalRun && done(t.goalRun) && !t.summary.running) return t;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`goal run did not settle: ${JSON.stringify(await runOf(host, threadId))}`);
  }, "packages/platform/test/goal-runs.test.ts settledRun");
}

test('a token budget counts work and checks, stops admission, and Resume cannot increase it', async () => {
  const { host } = pi();
  const { threadId } = await goalThread(host, 'A token bounded plan');
  value(await host.call('goals.run', { threadId, budget: 10, tokenBudget: 1 }));
  const t = await settledRun(host, threadId, r => r.status === 'budget');
  assert.equal(t.goalRun!.used, 1);
  assert.ok(t.goalRun!.tokensUsed! >= 1);
  assert.equal(t.turns.filter(turn => turn.judge).length, 0, 'the check also costs tokens and must not start');
  const resumed = await host.call('goals.resume', { threadId });
  assert.equal(resumed.ok, false, 'a new explicit run is required for another token allowance');
  const rejected = await host.call('goals.run', { threadId, budget: 10, tokenBudget: NaN });
  assert.equal(rejected.ok, false);
});

test('token usage includes judge turns and excludes work before the run', async () => {
  const { host } = pi();
  const goal = 'Count all goal usage';
  verdicts.set(goal, ['MET: counted']);
  const { threadId } = await goalThread(host, goal);
  value(await host.call('goals.run', { threadId, budget: 5, tokenBudget: 1_000_000 }));
  const t = await settledRun(host, threadId, r => r.status === 'met');
  const expected = t.turns.slice(1).reduce((sum, turn) => sum + (turn.work.usage?.input ?? 0) + (turn.work.usage?.output ?? 0), 0);
  assert.equal(t.goalRun!.tokensUsed, expected);
  assert.ok(t.turns.at(-1)!.work.usage!.input > 0);
  value(await host.call('turns.send', { threadId, projectId: t.summary.projectId, text: 'Unrelated later work', attachments: [], settings, clientKey: 'after-goal' }));
  await idle(host, threadId);
  assert.equal((await runOf(host, threadId))!.tokensUsed, expected, 'a completed run never charges later work');
});

test('pausing a goal still reports the usage of its turn in flight', async () => {
  const { host } = pi();
  const { threadId } = await goalThread(host, 'Finish the turn already in flight');
  value(await host.call('goals.run', { threadId, budget: 5, tokenBudget: 1_000_000 }));
  value(await host.call('goals.pause', { threadId }));
  const t = await idle(host, threadId);
  assert.equal(t.goalRun!.status, 'paused');
  assert.ok(t.goalRun!.tokensUsed! > 0, 'the paused turn finished and its reported tokens remain visible');
});

test('three unchanged work/check pairs stop for no progress before spending the remaining budget', async () => {
  const { host } = pi();
  const goal = 'Detect a stalled plan';
  verdicts.set(goal, ['NOT MET: owners missing', 'NOT MET:  Owners   missing ', 'NOT MET: OWNERS MISSING']);
  const { threadId } = await goalThread(host, goal);
  value(await host.call('goals.run', { threadId, budget: 10 }));
  const t = await settledRun(host, threadId, r => r.status !== 'running');
  assert.equal(t.goalRun!.status, 'blocked');
  assert.equal(t.goalRun!.used, 3);
  assert.match(t.goalRun!.detail ?? '', /no progress/i);
  const count = t.turns.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(value(await host.call('threads.get', { id: threadId })).turns.length, count);
  verdicts.set(goal, ['MET: owners supplied']);
  value(await host.call('goals.resume', { threadId }));
  const resumed = await settledRun(host, threadId, r => r.status === 'met');
  assert.equal(resumed.goalRun!.used, 4, 'Resume gives a stalled run another chance');
});

test('a changing missing finding is progress even when the worker answer repeats', async () => {
  const { host } = pi();
  const goal = 'A plan advances';
  verdicts.set(goal, ['NOT MET: needs owners', 'NOT MET: needs dates', 'NOT MET: needs risks', 'MET: all present']);
  const { threadId } = await goalThread(host, goal);
  value(await host.call('goals.run', { threadId, budget: 10 }));
  const t = await settledRun(host, threadId, r => r.status !== 'running');
  assert.equal(t.goalRun!.status, 'met');
  assert.equal(t.goalRun!.used, 4);
});

test('MET cannot complete a rubric goal until every criterion has passing evidence', async () => {
  const { host } = pi();
  const goal = 'A rubric checked plan';
  verdicts.set(goal, [
    'MET: ready\nPASS 1: every step has an owner\nFAIL 2: dates missing',
    'MET: ready\nPASS 1: every step has an owner\nPASS 2: every step has a date',
  ]);
  const { threadId } = await goalThread(host, goal);
  const rubric = ['Every step has an owner', 'Every step has a date'];
  value(await host.call('goals.run', { threadId, budget: 5, rubric }));
  rubric[0] = 'Changed outside the run';
  const t = await settledRun(host, threadId, r => r.status !== 'running');
  assert.equal(t.goalRun!.status, 'met');
  assert.equal(t.goalRun!.used, 2);
  assert.equal(t.turns.filter(turn => turn.judge)[0].judge!.verdict, 'not-met');
  assert.ok(t.goalRun!.rubricResults?.every(result => result.passed && result.evidence));
  assert.match(t.turns[1].user.text, /Every step has an owner/);
  assert.equal(t.goalRun!.rubric![0], 'Every step has an owner', 'the accepted rubric is copied and pinned');
});

test('missing or duplicated rubric evidence never satisfies a criterion', async () => {
  const { host } = pi();
  const goal = 'Rubric evidence must be complete';
  verdicts.set(goal, ['MET: trust me\nPASS 1: first\nPASS 1: duplicate\nPASS 2:']);
  const { threadId } = await goalThread(host, goal);
  value(await host.call('goals.run', { threadId, budget: 1, rubric: ['Owners', 'Dates'] }));
  const t = await settledRun(host, threadId, r => r.status !== 'running');
  assert.equal(t.goalRun!.status, 'budget');
  assert.ok(t.goalRun!.rubricResults?.every(result => !result.passed));
  assert.equal((await host.call('goals.run', { threadId, budget: 5, rubric: [''] })).ok, false);
});

test('a goal runs until the judge finds it met, and closes with the evidence', async () => {
  const { host } = pi();
  const goal = 'Plan has risks and owners';
  verdicts.set(goal, ['NOT MET: the risks section is missing', 'MET: plan.md has risks and owners']);
  const { threadId } = await goalThread(host, goal);
  const started = value(await host.call('goals.run', { threadId, budget: 5 }));
  assert.equal(started.status, 'running');
  const t = await settledRun(host, threadId, (r) => r.status === 'met');
  assert.equal(t.goalRun!.used, 2);
  assert.equal(t.goalRun!.evidence?.detail, 'plan.md has risks and owners');
  const kinds = t.turns.slice(1).map((x) => (x.judge ? `judge:${x.judge.verdict}` : 'work'));
  assert.deepEqual(kinds, ['work', 'judge:not-met', 'work', 'judge:met']);
  assert.match(t.turns[3].user.text, /risks section is missing/, 'the next turn is told what was missing');
  assert.equal((await host.call('goals.runs', {})).some((r) => r.threadId === threadId && r.status === 'running'), false);
});

test('not met stops at the turn budget, and blocked waits for the person', async () => {
  const { host } = pi();
  const never = 'Ship the impossible';
  verdicts.set(never, ['NOT MET: still impossible']);
  const a = await goalThread(host, never);
  value(await host.call('goals.run', { threadId: a.threadId, budget: 2 }));
  let t = await settledRun(host, a.threadId, (r) => r.status === 'budget');
  assert.equal(t.goalRun!.used, 2);
  assert.equal(t.turns.filter((x) => !x.judge).length, 3, 'the first turn plus two the run started');

  const choose = 'Pick the venue';
  verdicts.set(choose, ['BLOCKED: choose between Lisbon and Porto']);
  const b = await goalThread(host, choose);
  value(await host.call('goals.run', { threadId: b.threadId, budget: 5 }));
  t = await settledRun(host, b.threadId, (r) => r.status === 'blocked');
  assert.equal(t.goalRun!.detail, 'choose between Lisbon and Porto');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(value(await host.call('threads.get', { id: b.threadId })).turns.length, t.turns.length, 'nothing more starts while it waits');
  assert.ok((await host.call('goals.runs', {})).some((r) => r.threadId === b.threadId && r.status === 'blocked'));
});

test('pause holds the run after the turn in hand; resume goes on; a Stop pauses it', async () => {
  const { host } = pi();
  const goal = 'Outline the launch';
  verdicts.set(goal, ['MET: the outline is there']);
  const { threadId } = await goalThread(host, goal);
  value(await host.call('goals.run', { threadId, budget: 3 }));
  value(await host.call('goals.pause', { threadId }));
  let t = await settledRun(host, threadId, (r) => r.status === 'paused');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(value(await host.call('threads.get', { id: threadId })).turns.filter((x) => x.judge).length, 0, 'no check starts while paused');
  value(await host.call('goals.resume', { threadId }));
  t = await settledRun(host, threadId, (r) => r.status === 'met');
  assert.equal(t.turns.filter((x) => x.judge).length, 1);

  const stopGoal = 'Hold on and finish';
  verdicts.set(stopGoal, ['NOT MET: more to do']);
  const s = await goalThread(host, stopGoal);
  holding = true;
  value(await host.call('turns.send', { threadId: s.threadId, projectId: s.projectId, text: 'Hold on', attachments: [], settings, clientKey: 'hold' }));
  value(await host.call('goals.run', { threadId: s.threadId, budget: 3 }));
  value(await host.call('turns.stop', { threadId: s.threadId }));
  holding = false;
  t = await settledRun(host, s.threadId, (r) => r.status === 'paused');
  assert.match(t.goalRun!.detail ?? '', /^Stopped by you/);
  assert.equal(t.turns.filter((x) => x.judge).length, 0);
});

test('the judge waits for the goal\'s children before it decides', async () => {
  const { host } = pi();
  const goal = 'Children report back';
  verdicts.set(goal, ['MET: the worker reported']);
  const { threadId } = await goalThread(host, goal);
  holding = true;
  const child = value(await host.call('children.start', { parentThreadId: threadId, text: 'Hold on', role: 'worker', clientKey: 'child' }));
  value(await host.call('goals.run', { threadId, budget: 3 }));
  await idle(host, threadId);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(value(await host.call('threads.get', { id: threadId })).turns.filter((x) => x.judge).length, 0, 'no verdict while a child works');
  holding = false;
  await idle(host, child.threadId);
  const t = await settledRun(host, threadId, (r) => r.status === 'met');
  assert.equal(t.turns.filter((x) => x.judge).length, 1);
});

test('a judge turn is an assessment: no memory is kept from it, and it starts nothing on its own words', async () => {
  const { host } = pi();
  const goal = 'Remember that the judge is not a person';
  verdicts.set(goal, ['MET: done']);
  const { threadId } = await goalThread(host, goal);
  value(await host.call('goals.run', { threadId, budget: 2 }));
  const t = await settledRun(host, threadId, (r) => r.status === 'met');
  const judge = t.turns.find((x) => x.judge)!;
  assert.equal(judge.memory?.remembered?.length ?? 0, 0);
  assert.equal((await host.call('memory.get', {})).entries.length, 0);
});

test('a thread forks from any turn, keeping the history up to it', async () => {
  const { host } = pi();
  const projectId = value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;
  const a = value(await host.call('turns.send', { projectId, text: 'First question', attachments: [], settings, clientKey: 'a' }));
  await idle(host, a.threadId);
  value(await host.call('turns.send', { threadId: a.threadId, projectId, text: 'Second question', attachments: [], settings, clientKey: 'b' }));
  const source = await idle(host, a.threadId);
  const branch = value(await host.call('threads.fork', { id: a.threadId, clientKey: 'branch', turnId: source.turns[0].id }));
  const forked = value(await host.call('threads.get', { id: branch.id }));
  assert.deepEqual(forked.turns.map((x) => x.user.text), ['First question']);
  assert.equal(forked.forkedFrom?.turnId, source.turns[0].id);
  assert.equal((await host.call('threads.fork', { id: a.threadId, clientKey: 'branch', turnId: source.turns[0].id })).ok, true);
  assert.equal((await host.call('threads.fork', { id: a.threadId, clientKey: 'x', turnId: 'nope' })).ok, false);
});

test('every thread\'s titles, words and answers can be searched', async () => {
  const { host } = pi();
  const projectId = value(await host.call('projects.create', { name: 'Ops', kind: 'folder' })).id;
  const a = value(await host.call('turns.send', { projectId, text: 'Draft the zebra crossing memo', attachments: [], settings, clientKey: 'a' }));
  await idle(host, a.threadId);
  const b = value(await host.call('turns.send', { projectId, text: 'Something else', attachments: [], settings, clientKey: 'b' }));
  await idle(host, b.threadId);
  const hits = await host.call('threads.search', { query: 'zebra memo' });
  assert.ok(hits.some((h) => h.threadId === a.threadId && h.field === 'title'));
  assert.ok(hits.some((h) => h.threadId === a.threadId && h.field === 'words' && /zebra/i.test(h.snippet)));
  assert.ok(!hits.some((h) => h.threadId === b.threadId));
  const answers = await host.call('threads.search', { query: 'worked on it' });
  assert.ok(answers.some((h) => h.field === 'answer'));
  assert.deepEqual(await host.call('threads.search', { query: '  ' }), []);
});
