import { syntheticMaterialReader } from './fixtures/synthetic-material-reader.ts';
// Regression from Claude-family review of cefda1b; models a crash before Core finish.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSideChat, sideRouteDigest } from '../src/composition/sidechat.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { MaterialStore } from '../src/stub/material.ts';
import type { HarnessV1, ModelRoute, TurnContext } from '../src/ports/harness.ts';
import type { Turn } from '../src/api.ts';

const bind = (thread: StoredThread, turn: Turn, route: ModelRoute) => {
  turn.sideRun = { version: 1, threadId: thread.summary.id, projectId: thread.summary.projectId, turnId: turn.id, taskId: 'side-task', pieceId: 'piece', scope: 'read-only', routeDigest: sideRouteDigest(route), runId: 'side-run' };
};

test('a crash after withdrawal and before Core finish retains the recovery obligation', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'probe-side-withdraw-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const source = material.create('project', 'one.md', 'text/markdown', Buffer.from('one'), 'original', 'person');
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'W', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let readDone!: () => void; const readSeen = new Promise<void>((r) => { readDone = r; });
  let gate!: () => void; const gated = new Promise<void>((r) => { gate = r; });
  let finishEntered!: () => void; const inFinish = new Promise<void>((r) => { finishEntered = r; });
  let resolveOutcome!: (s: 'done' | 'interrupted') => void; const outcome = new Promise<'done' | 'interrupted'>((r) => { resolveOutcome = r; });
  const snapshots: string[] = [];
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: (_r: unknown, context: TurnContext) => ({
    events: (async function* () { await context.tools.read('one.md'); readDone(); await gated; yield { type: 'text', delta: 'partial words' } as never; await outcome; })(),
    outcome: outcome.then((status) => ({ status, answer: 'x', usage: { input: 0, output: 0 } })), stop: () => resolveOutcome('interrupted'), steer: () => {} }) } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', baseUrl: 'http://127.0.0.1:1', label: 'local', credential: null };
  const service = createSideChat({ home, material, thread: () => thread, plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false,
    save: async (th) => { snapshots.push(JSON.stringify(th)); },
    begin: async (_th, turn) => { bind(thread, turn, route); return { gateway: { read: syntheticMaterialReader(home, material, 'project'), write: async () => undefined }, abandon: async () => {}, finish: async () => { finishEntered(); await new Promise(() => {}); } }; } });
  void service.ask({ threadId: 'thread', text: 'Read', clientKey: 'k' });
  await readSeen;
  material.withdraw(source.id); service.sourceWithdrawn('project', source.id);
  gate();
  await inFinish; // "crash" here: Core finish never completes
  const last = JSON.parse(snapshots.at(-1)!) as StoredThread;
  const side = last.sideTurns[0];
  console.log('persisted before finish:', JSON.stringify({ status: side.status, withheld: side.withheld, pending: side.sideRecoveryPending, hasRun: !!side.sideRun, answer: side.answer?.text.slice(0, 60) }));
  let recoveries = 0;
  const restarted = createSideChat({ home, material, thread: () => last, plan: () => ({ ok: false, reason: 'NOT_AVAILABLE', detail: '', outcome: 'REFUSED' }), credential: async () => '', closing: () => false, save: async () => {}, begin: async () => { throw new Error('no'); }, recoverRun: async () => { recoveries++; return 'closed'; } });
  await restarted.recover(last);
  console.log('recoverRun calls after restart:', recoveries, 'status', last.sideTurns[0].status, 'pending', last.sideTurns[0].sideRecoveryPending);
  assert.equal(recoveries, 1, 'the bound Core side run must still be reconciled after a crash');
});
