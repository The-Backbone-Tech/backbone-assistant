// Admission boundaries use isolated homes and scripted in-memory turns, without a Core crossing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import { createGoalRuns } from '../src/composition/goal-runs.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { freshHome, value } from './helpers.ts';

function fixture(child = false) {
  const turn = (id: string): Turn => ({ id, side: false, status: 'running', user: { text: 'work', attachments: [], at: new Date().toISOString() }, work: { startedAt: new Date().toISOString(), harness: 'scripted', steps: [] }, effects: [] });
  const work = turn('work');
  const thread = { summary: { id: 'parent', projectId: 'project', running: true }, turns: [work], clientKeys: ['initial'], goal: { current: { text: 'Finish the work' } } } as unknown as StoredThread;
  const worker = { summary: { id: 'child', projectId: 'project', running: true }, turns: [turn('child-work')], clientKeys: ['child-initial'], child: { parentThreadId: 'parent' } } as unknown as StoredThread;
  const threads = new Map([[thread.summary.id, thread], ...(child ? [[worker.summary.id, worker] as const] : [])]);
  let admissions = 0;
  const goals = createGoalRuns({ home: freshHome(), threads, material: { load: () => null }, closing: () => false,
    childrenRunning: () => child && worker.summary.running,
    admit: async () => { admissions++; return { result: { ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail: 'Unexpected admission' } }; }, emit: () => {},
  });
  const finish = (t: StoredThread, usage?: { input: number; output: number }) => { t.summary.running = false; t.turns.at(-1)!.status = 'done'; t.turns.at(-1)!.work.usage = usage; goals.ended(t); };
  const settle = async () => { for (let i = 0; i < 200; i++) { const r = goals.view('parent')!; if (r.status !== 'running') return r; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('goal did not settle'); };
  return { goals, thread, worker, work, finish, settle, admissions: () => admissions };
}

test('an adopted in-flight turn without usage blocks instead of treating its tokens as free', async () => {
  const f = fixture();
  value(await f.goals.handlers['goals.run']({ threadId: 'parent', budget: 5, tokenBudget: 100 }));
  f.finish(f.thread);
  const run = await f.settle();
  assert.equal(run.status, 'blocked');
  assert.match(run.detail ?? '', /usage/i);
  assert.equal(f.admissions(), 0);
});

test('an existing in-flight child must also report usage before the goal can continue', async () => {
  const f = fixture(true);
  value(await f.goals.handlers['goals.run']({ threadId: 'parent', budget: 5, tokenBudget: 100 }));
  f.finish(f.thread, { input: 1, output: 0 });
  f.finish(f.worker);
  const run = await f.settle();
  assert.equal(run.status, 'blocked');
  assert.match(run.detail ?? '', /usage/i);
  assert.equal(f.admissions(), 0);
});

for (const interrupted of [false, true]) test(`Resume cannot bypass missing usage after a settled turn (interrupted=${interrupted})`, async () => {
  const f = fixture();
  value(await f.goals.handlers['goals.run']({ threadId: 'parent', budget: 5, tokenBudget: 100 }));
  f.finish(f.thread);
  f.work.status = 'stopped';
  f.work.interrupted = interrupted;
  await f.settle();
  const resumed = value(await f.goals.handlers['goals.resume']({ threadId: 'parent' }));
  assert.equal(resumed.status, 'blocked');
  assert.match(resumed.detail ?? '', /usage/i);
  assert.equal(f.admissions(), 0);
});

test('a successful check at the token limit preserves MET and its evidence without another admission', async () => {
  const f = fixture();
  const run = value(await f.goals.handlers['goals.run']({ threadId: 'parent', budget: 5, tokenBudget: 15 }));
  f.work.status = 'done'; f.work.work.usage = { input: 10, output: 0 };
  f.thread.turns.push({ ...structuredClone(f.work), id: 'judge', judge: { verdict: 'met', detail: 'The work is complete' }, work: { ...f.work.work, usage: { input: 10, output: 0 } } });
  f.thread.clientKeys.push(`goal-check:parent:${run.startedAt}:1`);
  f.finish(f.thread, { input: 10, output: 0 });
  const result = await f.settle();
  assert.equal(result.status, 'met');
  assert.equal(result.tokensUsed, 20);
  assert.ok(result.evidence?.detail);
  assert.equal(f.admissions(), 0);
});

test('already-admitted children settle and their final usage is charged before a budget run closes', async () => {
  const f = fixture(true);
  value(await f.goals.handlers['goals.run']({ threadId: 'parent', budget: 5, tokenBudget: 1 }));
  f.finish(f.thread, { input: 1, output: 0 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.goals.view('parent')!.phase, 'children');
  f.finish(f.worker, { input: 100, output: 0 });
  const result = await f.settle();
  assert.equal(result.status, 'budget');
  assert.equal(result.tokensUsed, 101);
  assert.equal(f.admissions(), 0);
});

test('a child that already spent the allowance prevents the first new parent turn', async () => {
  const f = fixture(true);
  f.finish(f.thread, { input: 1, output: 0 });
  f.work.judge = { verdict: 'met', detail: 'Evidence from an earlier run' };
  f.worker.turns[0].work.usage = { input: 100, output: 0 };
  const run = value(await f.goals.handlers['goals.run']({ threadId: 'parent', budget: 5, tokenBudget: 1 }));
  assert.equal(f.admissions(), 0);
  assert.equal(run.phase, 'children');
  f.finish(f.worker, { input: 120, output: 0 });
  const result = await f.settle();
  assert.equal(result.status, 'budget');
  assert.equal(result.used, 0);
  assert.equal(result.tokensUsed, 120);
});
