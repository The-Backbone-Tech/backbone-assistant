import { hangDetector } from '../../../scripts/lib/test-hang.ts';
import { unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import type { CoreLink, RunHandle } from '../src/composition/core.ts';
import { createSideCore } from '../src/composition/sidechat-core.ts';
import type { SidePlan } from '../src/composition/sidechat.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';

function fixture() {
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  const turn: Turn = { id: 'turn', side: true, user: { text: 'Question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running' };
  thread.sideTurns.push(turn);
  const plan = { engine: { id: 'harness-pi' }, route: { kind: 'endpoint', provider: 'openai-compatible', model: 'test', baseUrl: 'https://user:fake-password@example.invalid/v1?token=fake-token', label: 'local', credential: 'secret-handle' } } as SidePlan;
  const calls: string[] = [];
  const state: { title?: string; row?: { id: string; task_id: string; piece_id: string | null; agent_id: string; status: string }; rejectClaim?: boolean; rejectSay?: boolean; rejectQueue?: boolean; rejectGateway?: boolean; rejectRenew?: boolean; owner: boolean; saves: string[] } = { owner: true, saves: [] };
  const handle: RunHandle = { run: 'run', fence: 1, secret: 'never-persist' };
  const link = {
    id: { person: 'person', agent: 'agent' }, system: () => ({}),
    createTask: async (title: string) => { calls.push('create'); state.title = title; return 'task'; },
    say: async () => { calls.push('say'); if (state.rejectSay) throw new Error('injected'); return 'message'; },
    pieceMandate: async () => 'mandate',
    startRun: async (task: string, piece: string) => {
      calls.push('start'); assert.equal(task, 'task'); assert.equal(piece, 'piece');
      assert.ok(state.saves.some((saved) => JSON.parse(saved).sideRun?.taskId === task), 'task identity was saved before queue');
      assert.ok(state.saves.some((saved) => JSON.parse(saved).sideRun?.queueIntent === true), 'queue intent was saved before queue');
      if (state.rejectQueue) throw new Error('acknowledgement lost');
      state.row = { id: 'run', task_id: task, piece_id: piece, agent_id: 'agent', status: 'running' }; return handle;
    },
    renewRun: async () => { calls.push('renew'); if (state.rejectRenew) throw new Error('lease lost'); return 'running'; },
    answer: async () => { calls.push('answer'); return 'message'; },
    finishRun: async (_handle: RunHandle, status: string) => { calls.push(`finish:${status}`); if (state.row) state.row.status = status; return status; },
    reclaimRun: async () => { calls.push('reclaim'); if (state.rejectClaim) throw new Error('lease live or revoked'); return handle; },
    read: async (_actor: unknown, sql: string) => {
      if (sql.includes('FROM app.tasks')) return { rows: state.title ? [{ id: 'task', title: state.title, requested_by: 'person', on_behalf_of: 'person' }] : [] };
      if (sql.includes('FROM app.runs')) return { rows: state.row ? [state.row] : [] };
      throw new Error('unexpected query');
    },
  } as unknown as CoreLink;
  const service = createSideCore({ link: async () => link, piece: () => 'piece', ownsHome: () => state.owner, closing: () => false,
    save: async () => { calls.push('save'); state.saves.push(JSON.stringify(turn)); },
    gateway: () => { if (state.rejectGateway) throw new Error('gateway failed'); return { read: unexpectedMaterialRead, write: async () => undefined }; },
  });
  return { thread, turn, plan, service, state, calls };
}

test('Core identity is durable before queueing and does not include credentials', async () => {
  const f = fixture();
  const run = await f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal);
  assert.ok(f.calls.indexOf('save') < f.calls.indexOf('start'));
  assert.equal(f.turn.sideRun?.taskId, 'task');
  assert.equal(f.turn.sideRun?.runId, 'run');
  assert.doesNotMatch(JSON.stringify(f.turn.sideRun), /secret-handle|never-persist|fake-password|fake-token/);
  assert.doesNotMatch(f.state.title ?? '', /fake-password|fake-token/);
  f.turn.answer = { text: 'Answer', files: [] };
  await run.finish('succeeded');
  assert.ok(f.calls.indexOf('answer') < f.calls.indexOf('finish:succeeded'));
});

test('a withheld side answer is not copied into the Core conversation', async () => {
  const f = fixture();
  const run = await f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal);
  f.turn.withheld = true;
  f.turn.answer = { text: 'withdrawn source content', files: [] };
  await run.finish('succeeded');
  assert.equal(f.calls.includes('answer'), false);
  assert.ok(f.calls.includes('finish:succeeded'));
});

test('a gateway failure after claim stops renewal and settles the owned run', async () => {
  const f = fixture(); f.state.rejectGateway = true;
  await assert.rejects(f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal), /gateway failed/);
  assert.ok(f.turn.sideRun?.runId);
  assert.equal(f.state.row?.status, 'failed');
  assert.ok(f.calls.includes('finish:failed'));
  assert.equal(await f.service.recoverRun(f.thread, f.turn, f.turn.sideRun), 'closed');
});

test('a lost queue acknowledgement remains pending even when no run is yet visible', async () => {
  const f = fixture(); f.state.rejectQueue = true;
  await assert.rejects(f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal));
  assert.ok(f.turn.sideRun?.queueIntent);
  assert.equal(f.turn.sideRun.runId, undefined);
  assert.equal(await f.service.recoverRun(f.thread, f.turn, f.turn.sideRun), 'pending');
  assert.equal(f.calls.includes('reclaim'), false);
});

test('a crash after task custody but before queue settles without starting inference', async () => {
  const f = fixture(); f.state.rejectSay = true;
  await assert.rejects(f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal));
  assert.ok(f.turn.sideRun);
  assert.equal(await f.service.recoverRun(f.thread, f.turn, f.turn.sideRun), 'closed');
  assert.equal(f.calls.includes('start'), false);
  assert.equal(f.calls.includes('reclaim'), false);
});

test('a live lease or revoked grant keeps recovery pending without a finish', async () => {
  const f = fixture();
  const old = await f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal);
  f.state.rejectClaim = true;
  assert.equal(await f.service.recoverRun(f.thread, f.turn, f.turn.sideRun!), 'pending');
  assert.equal(f.calls.includes('finish:failed'), false);
  await old.finish('failed');
});

test('a legacy task title stays pending and never claims or settles the run', async () => {
  const f = fixture();
  const run = await f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal);
  assert.match(f.state.title!, /^Side question v1 /);
  f.state.title = f.state.title!.replace(/^Side question v1 /, 'Backbone side v1 ');
  assert.equal(await f.service.recoverRun(f.thread, f.turn, f.turn.sideRun!), 'pending');
  assert.equal(f.calls.includes('reclaim'), false);
  assert.equal(f.calls.includes('finish:failed'), false);
  await run.finish('failed');
});

test('loss of a live lease signals cancellation and never finishes with a stale fence', async () => {
  const f = fixture();
  const run = await f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal);
  f.state.rejectRenew = true;
  assert.ok(run.lost);
  await hangDetector(new Promise<void>(resolve => { if (run.lost!.aborted) resolve(); else run.lost!.addEventListener('abort', () => resolve(), { once: true }); }), 'side lease-loss cancellation signal', { diagnostic: () => JSON.stringify(f.calls) });
  assert.equal(run.lost.aborted, true);
  await assert.rejects(run.finish('succeeded'), /lease was lost/);
  assert.equal(f.calls.some((call) => call.startsWith('finish:')), false);
  assert.ok(f.turn.sideRun?.runId, 'the original identity remains for reconciliation');
});

test('an expired lease is reclaimed and settled without inference', async () => {
  const f = fixture();
  const old = await f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal);
  assert.equal(await f.service.recoverRun(f.thread, f.turn, f.turn.sideRun!), 'closed');
  assert.ok(f.calls.indexOf('reclaim') < f.calls.indexOf('renew'));
  assert.ok(f.calls.indexOf('renew') < f.calls.indexOf('finish:failed'));
  assert.equal(f.state.row?.status, 'failed');
  await old.finish('failed');
});

test('cross-project, task, piece, agent and run mismatches cannot claim another run', async () => {
  const f = fixture();
  const old = await f.service.begin(f.thread, f.turn, f.plan, new AbortController().signal);
  const identity = structuredClone(f.turn.sideRun!);
  f.thread.summary.projectId = 'other';
  assert.equal(await f.service.recoverRun(f.thread, f.turn, identity), 'pending');
  f.thread.summary.projectId = 'project';
  f.state.title = 'other task';
  assert.equal(await f.service.recoverRun(f.thread, f.turn, identity), 'pending');
  f.state.title = undefined;
  assert.equal(await f.service.recoverRun(f.thread, f.turn, identity), 'pending');
  // Recreate the exact title by starting a fresh controlled fixture for each changed Core row.
  for (const field of ['piece_id', 'agent_id', 'id', 'task_id'] as const) {
    const g = fixture();
    const held = await g.service.begin(g.thread, g.turn, g.plan, new AbortController().signal);
    g.state.row![field] = 'other';
    assert.equal(await g.service.recoverRun(g.thread, g.turn, g.turn.sideRun!), 'pending', field);
    assert.equal(g.calls.includes('reclaim'), false);
    await held.finish('failed');
  }
  assert.equal(f.calls.includes('reclaim'), false);
  await old.finish('failed');
});
