import { hangDetector } from '../../../scripts/lib/test-hang.ts';
import { observeChild } from '../../../scripts/lib/test-child.ts';
import { unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';
// Exercises the side-run custody against the real Core, with an isolated test home and cluster.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {randomUUID} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Turn } from '../src/api.ts';
import { CoreLink } from '../src/composition/core.ts';
import { loadPiece, PIECES, pieceOnDisk } from '../src/composition/pieces.ts';
import { createSideCore } from '../src/composition/sidechat-core.ts';
import { createSideChat, type SidePlan } from '../src/composition/sidechat.ts';
import { saveThreadProjection } from '../src/composition/thread-custody.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { freshHome } from './helpers.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';

test('real Core records the bound side task, retains a live lease and settles without another run', async (t) => {
  const home = freshHome();
  const link = await CoreLink.open({ home });
  t.after(() => link.release());
  const projectId=randomUUID();await link.call(link.person(),'SELECT gov.identity_project_create($1)',[projectId]);
  const pi = PIECES['harness-pi'];
  const { registration } = await loadPiece(link, pieceOnDisk(pi.dir, pi.id), { firstUse: true });
  await link.grantPiece(registration.id);
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId, title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  const turn: Turn = { id: 'turn', side: true, user: { text: 'Side question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running' };
  thread.sideTurns.push(turn);
  const plan = { engine: { id: 'harness-pi' }, route: { kind: 'endpoint', provider: 'openai-compatible', model: 'test', baseUrl: 'http://127.0.0.1:1', label: 'local', credential: null } } as SidePlan;
  const manager = createSideCore({ link: async () => link, piece: () => registration.id, ownsHome: () => true, closing: () => false,
    save: () => saveThreadProjection(home, thread), gateway: () => ({ read: unexpectedMaterialRead, write: async () => undefined }),
  });
  const run = await manager.begin(thread, turn, plan, new AbortController().signal);
  assert.ok(turn.sideRun?.runId);
  assert.equal(turn.sideRun.pieceId, registration.id);
  assert.equal(await manager.recoverRun(thread, turn, turn.sideRun), 'pending', 'the live owner renewed its lease');
  turn.status = 'done'; turn.answer = { text: 'SIDE ANSWER', files: [] };
  await run.finish('succeeded');
  assert.equal(await manager.recoverRun(thread, turn, turn.sideRun), 'closed');
  const rows = await link.read<{ status: string; piece_id: string }>(link.system(), 'SELECT status, piece_id FROM app.runs WHERE task_id = $1', [turn.sideRun.taskId]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].status, 'succeeded');
  assert.equal(rows.rows[0].piece_id, registration.id);

  const mandate = await link.pieceMandate(registration.id);
  assert.ok(mandate);
  await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [mandate]);
  const revoked: Turn = { id: 'revoked-turn', side: true, user: { text: 'Another question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running' };
  thread.sideTurns.push(revoked);
  await assert.rejects(manager.begin(thread, revoked, plan, new AbortController().signal), /not granted|mandate|denied/i);
  assert.ok(revoked.sideRun, 'the attempted task identity remains for reconciliation');
  assert.equal(await manager.recoverRun(thread, revoked, revoked.sideRun), 'closed');
  assert.equal(await link.pieceMandate(registration.id), null, 'a revoked grant is never silently restored');
});

test('a killed model call reclaims and settles its exact Core run without sending the question again', async (t) => {
  const home = freshHome();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const model = await startScriptedModel('side-crash', () => ({ text: 'late answer' }), { before: async () => { entered(); await held; } });
  t.after(async () => { release(); await model.close(); });
  const child = spawn(process.execPath, [join(import.meta.dirname, 'sidechat-core-crash.ts'), home], {
    env: { ...process.env, SIDECHAT_TEST_ENDPOINT: model.url, SIDECHAT_TEST_MODEL: model.model }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errorText = '';
  child.stderr.on('data', (value: Buffer) => { errorText += value.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const output = observeChild(child,'side Core crash fixture');
  await hangDetector(Promise.race([started, exited.then((result) => { throw output.diagnostic(`exited before inference: ${JSON.stringify(result)}`); })]),'side Core inference startup',{diagnostic:()=>output.diagnostic('waiting for inference').message});
  child.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  release();
  const count = model.requests.length;
  const thread = JSON.parse(readFileSync(join(home, 'threads', 'side-thread.json'), 'utf8')) as StoredThread;
  const side = thread.sideTurns[0];
  assert.equal(side.status, 'running');
  assert.ok(side.sideRun?.runId);
  const link = await CoreLink.open({ home });
  t.after(() => link.release());
  const projectId=randomUUID();await link.call(link.person(),'SELECT gov.identity_project_create($1)',[projectId]);
  const core = createSideCore({ link: async () => link, piece: () => side.sideRun!.pieceId, ownsHome: () => true, closing: () => false,
    save: () => saveThreadProjection(home, thread), gateway: () => ({ read: unexpectedMaterialRead, write: async () => undefined }),
  });
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => { throw new Error('Recovery must not choose a model'); }, begin: core.begin, recoverRun: core.recoverRun,
    credential: async () => '', closing: () => false, save: () => saveThreadProjection(home, thread),
  });
  await service.recover(thread);
  assert.equal(side.status, 'stopped');
  assert.equal(side.sideRecoveryPending, undefined, 'the exact Core run was settled');
  assert.match(side.answer?.text ?? '', /unknown/);
  const rows = await link.read<{ status: string; piece_id: string }>(link.system(), 'SELECT status, piece_id FROM app.runs WHERE id = $1', [side.sideRun!.runId]);
  assert.equal(rows.rows[0]?.status, 'failed');
  assert.equal(rows.rows[0]?.piece_id, side.sideRun!.pieceId);
  const retry = await service.ask({ threadId: 'side-thread', text: 'Crash test side question', clientKey: 'crash-key' });
  assert.ok(retry.ok && retry.value.id === side.id && retry.value.status === 'stopped');
  assert.equal(model.requests.length, count, 'recovery and retry never re-send the question');
});

test('a lost queue acknowledgement is reconciled by the saved task without starting inference', async (t) => {
  const home = freshHome();
  const link = await CoreLink.open({ home });
  t.after(() => link.release());
  const projectId=randomUUID();await link.call(link.person(),'SELECT gov.identity_project_create($1)',[projectId]);
  const pi = PIECES['harness-pi'];
  const { registration } = await loadPiece(link, pieceOnDisk(pi.dir, pi.id), { firstUse: true });
  await link.grantPiece(registration.id);
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread-lost', projectId, title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  const turn: Turn = { id: 'turn-lost', side: true, user: { text: 'Question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running' };
  thread.sideTurns.push(turn);
  const plan = { engine: { id: 'harness-pi' }, route: { kind: 'endpoint', provider: 'openai-compatible', model: 'test', baseUrl: 'http://127.0.0.1:1', label: 'local', credential: null } } as SidePlan;
  const manager = createSideCore({ link: async () => link, piece: () => registration.id, ownsHome: () => true, closing: () => false,
    save: () => saveThreadProjection(home, thread), gateway: () => ({ read: unexpectedMaterialRead, write: async () => undefined }),
  });
  const start = link.startRun.bind(link);
  link.startRun = async (task, piece) => { await start(task, piece); throw new Error('injected lost acknowledgement'); };
  await assert.rejects(manager.begin(thread, turn, plan, new AbortController().signal), /lost acknowledgement/);
  link.startRun = start;
  assert.ok(turn.sideRun?.queueIntent);
  assert.equal(turn.sideRun.runId, undefined, 'the caller never learned the queued run id');
  const before = await link.read<{ id: string; status: string }>(link.system(), 'SELECT id, status FROM app.runs WHERE task_id = $1', [turn.sideRun.taskId]);
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].status, 'running');
  assert.equal(await manager.recoverRun(thread, turn, turn.sideRun), 'closed');
  const after = await link.read<{ id: string; status: string }>(link.system(), 'SELECT id, status FROM app.runs WHERE task_id = $1', [turn.sideRun.taskId]);
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].id, before.rows[0].id);
  assert.equal(after.rows[0].status, 'failed');
});
