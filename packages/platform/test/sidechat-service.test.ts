import { syntheticMaterialReader, unexpectedMaterialRead } from './fixtures/synthetic-material-reader.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPiHarness } from '../../modules/harness-pi/src/index.ts';
import { createCodexHarness } from '../../modules/harness-codex/src/index.ts';
import { fileURLToPath } from 'node:url';
import { createSideChat, sideHarnessLabel, sideRouteDigest } from '../src/composition/sidechat.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { MaterialStore } from '../src/stub/material.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import type { HarnessV1, ModelRoute, TurnContext } from '../src/ports/harness.ts';
import type { Turn } from '../src/api.ts';
import { saveThreadProjection } from '../src/composition/thread-custody.ts';
import { withHomeLock } from '../src/composition/home-lock.ts';

const bind = (thread: StoredThread, turn: Turn, route: ModelRoute) => {
  turn.sideRun = { version: 1, threadId: thread.summary.id, projectId: thread.summary.projectId, turnId: turn.id, taskId: 'side-task', pieceId: 'piece', scope: 'read-only', routeDigest: sideRouteDigest(route), runId: 'side-run' };
};

test('a keyed side question reaches Pi read-only, uses current project and main history, and is not sent twice', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const model = await startScriptedModel('side-service', (messages) => {
    const result = messages.findLast((m) => m.role === 'tool');
    if (!result) return { calls: [{ name: 'read_file', args: { name: 'source.md' } }] };
    return { text: `MODEL ANSWER ${result.content}` };
  });
  t.after(() => model.close());
  const material = new MaterialStore(home, {}, () => {});
  material.create('project', 'source.md', 'text/markdown', Buffer.from('current source'), 'original', 'person');
  material.create('other', 'secret.md', 'text/markdown', Buffer.from('other project secret'), 'original', 'person');
  const main: StoredThread = {
    summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: new Date().toISOString() },
    turns: [{ id: 'main', side: false, user: { text: 'MAIN QUESTION', attachments: [], at: new Date().toISOString() }, work: { startedAt: new Date().toISOString(), steps: [], harness: 'test' }, effects: [], status: 'done', reads: [], answer: { text: 'MAIN ANSWER', files: [] } }], sideTurns: [], clientKeys: [],
  };
  let reads = 0, finishes = 0, writes = 0;
  const engine = createPiHarness();
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: model.model, label: 'local test model', baseUrl: model.url, credential: null };
  const service = createSideChat({ home, material, thread: (id) => id === 'thread' ? main : undefined,
    plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false,
    begin: async (_thread, turn) => { bind(main, turn, route); return { gateway: { read: syntheticMaterialReader(home, material, 'project', { onRead: async () => { reads++; } }), write: async () => { writes++; return undefined; } }, abandon: async () => {}, finish: async () => { finishes++; } }; },
    save: async () => {},
  });
  const answer = await service.ask({ threadId: 'thread', text: 'How does change control relate to the source?', clientKey: 'question-1' });
  assert.ok(answer.ok);
  assert.equal(answer.value.status, 'done');
  assert.match(answer.value.work.harness, /^Pi .* · read-only · local test model$/);
  assert.match(answer.value.answer?.text ?? '', /current source/);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.equal(finishes, 1);
  const posts = model.requests.filter((request) => request.body.includes('"messages"')).map((request) => JSON.parse(request.body));
  assert.ok(posts.length > 0);
  assert.match(JSON.stringify(posts[0].messages), /MAIN QUESTION/);
  assert.match(JSON.stringify(posts[0].messages), /MAIN ANSWER/);
  assert.doesNotMatch(JSON.stringify(posts), /other project secret/);
  assert.ok(!posts[0].tools.some((tool: { function?: { name?: string } }) => tool.function?.name === 'write_file'));
  const again = await service.ask({ threadId: 'thread', text: 'How does change control relate to the source?', clientKey: 'question-1' });
  assert.ok(again.ok);
  assert.equal(again.value.id, answer.value.id);
  assert.equal(model.requests.filter((request) => request.body.includes('"messages"')).length, posts.length);
  const reused = await service.ask({ threadId: 'thread', text: 'Different words', clientKey: 'question-1' });
  assert.equal(reused.ok, false);
  service.close();
  await service.whenIdle();
});

test('stopping a side question cannot start its model or stop the main turn; a retry keeps the same result', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-stop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const main: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: true, updatedAt: new Date().toISOString() }, turns: [], sideTurns: [], clientKeys: [] };
  let entered!: () => void, release!: () => void, starts = 0;
  const beginning = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled Pi', start: () => { starts++; throw new Error('should not start'); } } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', label: 'local', baseUrl: 'http://127.0.0.1:1', credential: null };
  const service = createSideChat({ home, material, thread: () => main, plan: () => ({ ok: true, value: { engine, route } }),
    credential: async () => '', closing: () => false, save: async () => {},
    begin: async (_thread, turn) => { bind(main, turn, route); entered(); await held; return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; },
  });
  const pending = service.ask({ threadId: 'thread', text: 'Read only', clientKey: 'stable-key' });
  await beginning;
  const sideId = main.sideTurns[0].id;
  assert.equal(service.isRunning('thread'), true, 'a deletion can be refused until the side run has drained');
  await service.recover(main);
  assert.equal(main.sideTurns[0].status, 'running', 'a live side run is never treated as an interrupted one');
  const duplicate = await service.ask({ threadId: 'thread', text: 'Read only', clientKey: 'stable-key' });
  assert.ok(duplicate.ok && duplicate.value.id === sideId && duplicate.value.status === 'running');
  const other = await service.ask({ threadId: 'thread', text: 'Another question', clientKey: 'different' });
  assert.equal(other.ok, false, 'another side question cannot replace the running one');
  const wrong = await service.stop({ threadId: 'thread', turnId: 'main' });
  assert.ok(wrong.ok && !wrong.value.stopped);
  const stopped = await service.stop({ threadId: 'thread', turnId: sideId });
  assert.ok(stopped.ok && stopped.value.stopped);
  release();
  const result = await pending;
  assert.ok(result.ok);
  assert.equal(result.value.status, 'stopped');
  assert.equal(starts, 0);
  assert.equal(service.isRunning('thread'), false);
  assert.equal(main.summary.running, true, 'main turn remains running');
  const retry = await service.ask({ threadId: 'thread', text: 'Read only', clientKey: 'stable-key' });
  assert.ok(retry.ok && retry.value.id === sideId);
  assert.equal(starts, 0);
});

test('close waits for a side run to drain before the host may close Core', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-close-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: true, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let entered!: () => void, release!: () => void, starts = 0;
  const starting = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: () => { starts++; throw new Error('should not start'); } } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', label: 'local', baseUrl: 'http://127.0.0.1:1', credential: null };
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false, save: async () => {},
    begin: async (_thread, turn) => { bind(thread, turn, route); entered(); await held; return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; },
  });
  const pending = service.ask({ threadId: 'thread', text: 'Question', clientKey: 'side-key' });
  await starting;
  service.close();
  const idle = service.whenIdle();
  assert.equal(await Promise.race([idle.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20))]), false);
  release();
  await idle;
  const result = await pending;
  assert.ok(result.ok && result.value.status === 'stopped');
  assert.equal(starts, 0);
  assert.equal(thread.summary.running, true);
});

test('close drains an admission waiting for the home lock before the home can be removed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-admission-close-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let entered!: () => void, release!: () => void, plans = 0;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const blocker = withHomeLock(home, async () => { entered(); await held; });
  await acquired;
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => { plans++; return { ok: false, reason: 'NOT_AVAILABLE', detail: 'not used', outcome: 'REFUSED' }; },
    begin: async () => { throw new Error('not used'); }, credential: async () => '', closing: () => false, save: async () => {},
  });
  const pending = service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' });
  service.close();
  const idle = service.whenIdle();
  assert.equal(await Promise.race([idle.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20))]), false);
  release();
  await blocker;
  const result = await pending;
  assert.equal(result.ok, false);
  await idle;
  assert.equal(plans, 0);
  assert.equal(thread.sideTurns.length, 0);
});

test('close waits for an admitted Stop save even if the side run already drained', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-stop-close-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let entered!: () => void, releaseBegin!: () => void, stopSaving!: () => void, releaseStop!: () => void, heldOnce = false;
  const starting = new Promise<void>((resolve) => { entered = resolve; });
  const beginHeld = new Promise<void>((resolve) => { releaseBegin = resolve; });
  const saving = new Promise<void>((resolve) => { stopSaving = resolve; });
  const stopHeld = new Promise<void>((resolve) => { releaseStop = resolve; });
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: () => { throw new Error('must not start'); } } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', label: 'local', baseUrl: 'http://127.0.0.1:1', credential: null };
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false,
    save: async () => { if (thread.sideTurns[0]?.stopRequested && !heldOnce) { heldOnce = true; stopSaving(); await stopHeld; } },
    begin: async (_thread, turn) => { bind(thread, turn, route); entered(); await beginHeld; return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; },
  });
  const question = service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' });
  await starting;
  const stopping = service.stop({ threadId: 'thread', turnId: thread.sideTurns[0].id });
  await saving;
  releaseBegin();
  const result = await question;
  assert.ok(result.ok && result.value.status === 'stopped');
  assert.equal(service.isRunning('thread'), true, 'a pending Stop save must still prevent deletion');
  service.close();
  const idle = service.whenIdle();
  assert.equal(await Promise.race([idle.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20))]), false);
  releaseStop();
  await Promise.all([stopping, idle]);
  assert.equal(service.isRunning('thread'), false);
});

test('an interrupted saved side question is marked unknown and not retried with its key', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-recovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], clientKeys: [], sideTurns: [{ id: 'side', side: true, sideClientKey: 'key', user: { text: 'Question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running', answer: { text: 'PARTIAL ANSWER', files: [] } }] };
  let saves = 0, planned = 0;
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => { planned++; return { ok: false, reason: 'NOT_AVAILABLE', detail: 'no route', outcome: 'REFUSED' }; },
    begin: async () => { throw new Error('not used'); }, credential: async () => '', closing: () => false, save: async () => { saves++; },
  });
  await service.recover(thread);
  assert.equal(saves, 1);
  const retry = await service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' });
  assert.ok(retry.ok);
  assert.equal(retry.value.status, 'stopped');
  assert.match(retry.value.answer?.text ?? '', /unknown/);
  assert.match(retry.value.answer?.text ?? '', /PARTIAL ANSWER/);
  assert.equal(planned, 0);
});

test('recovery keeps an interrupted Core run pending until its bound identity is settled', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-run-recovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], clientKeys: [], sideTurns: [{ id: 'side', side: true, sideClientKey: 'key', user: { text: 'Question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running' }] };
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'model', label: 'local', baseUrl: 'http://127.0.0.1:1', credential: null };
  bind(thread, thread.sideTurns[0], route);
  let calls = 0;
  const saved: string[] = [];
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: false, reason: 'NOT_AVAILABLE', detail: 'not used', outcome: 'REFUSED' }), begin: async () => { throw new Error('not used'); },
    credential: async () => '', closing: () => false, save: async () => { saved.push(JSON.stringify(thread)); },
    recoverRun: async (_thread, turn, identity) => {
      assert.equal(turn.status, 'stopped');
      assert.equal(turn.sideRecoveryPending, true);
      assert.match(saved.at(-1) ?? '', /"sideRecoveryPending":true/, 'unknown was saved before touching Core');
      assert.equal(identity.taskId, 'side-task');
      assert.equal(identity.pieceId, 'piece');
      assert.equal(identity.scope, 'read-only');
      return ++calls === 1 ? 'pending' : 'closed';
    },
  });
  await service.recover(thread);
  assert.equal(thread.sideTurns[0].sideRecoveryPending, true);
  assert.equal(calls, 1);
  await service.recover(thread);
  assert.equal(thread.sideTurns[0].sideRecoveryPending, undefined);
  assert.equal(calls, 2);
  assert.equal(thread.sideTurns[0].status, 'stopped');
  assert.match(thread.sideTurns[0].answer?.text ?? '', /unknown/);
  const retry = await service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' });
  assert.ok(retry.ok && retry.value.status === 'stopped');
});

test('a mismatched recovered identity is never handed to Core', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-run-mismatch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], clientKeys: [], sideTurns: [{ id: 'side', side: true, sideClientKey: 'key', user: { text: 'Question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running' }] };
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'model', label: 'local', baseUrl: 'http://127.0.0.1:1', credential: null };
  bind(thread, thread.sideTurns[0], route);
  thread.sideTurns[0].sideRun!.projectId = 'different-project';
  let calls = 0;
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: false, reason: 'NOT_AVAILABLE', detail: 'not used', outcome: 'REFUSED' }), begin: async () => { throw new Error('not used'); },
    credential: async () => '', closing: () => false, save: async () => {}, recoverRun: async () => { calls++; return 'closed'; },
  });
  await service.recover(thread);
  assert.equal(calls, 0);
  assert.equal(thread.sideTurns[0].status, 'stopped');
  assert.equal(thread.sideTurns[0].sideRecoveryPending, true);
});

test('an active recovery blocks side admission and deletion, and close waits for its final save', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-recovery-close-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], clientKeys: [], sideTurns: [{ id: 'side', side: true, sideClientKey: 'old-key', user: { text: 'Question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running' }] };
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'model', label: 'local', baseUrl: 'http://127.0.0.1:1', credential: null };
  bind(thread, thread.sideTurns[0], route);
  let entered!: () => void, release!: () => void, recoveries = 0, saves = 0;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: false, reason: 'NOT_AVAILABLE', detail: 'not used', outcome: 'REFUSED' }), begin: async () => { throw new Error('not used'); },
    credential: async () => '', closing: () => false, save: async () => { saves++; },
    recoverRun: async () => { recoveries++; entered(); await held; return 'closed'; },
  });
  const first = service.recover(thread);
  const duplicate = service.recover(thread);
  await started;
  assert.equal(service.isRunning('thread'), true, 'the Host must refuse deletion while this is true');
  const another = await service.ask({ threadId: 'thread', text: 'New', clientKey: 'new-key' });
  assert.equal(another.ok, false);
  service.close();
  const idle = service.whenIdle();
  assert.equal(await Promise.race([idle.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20))]), false);
  release();
  await Promise.all([first, duplicate, idle]);
  assert.equal(recoveries, 1);
  assert.equal(saves, 2, 'both unknown and settled states were saved before idle');
  assert.equal(service.isRunning('thread'), false);
});

test('a deletion that acquired the home lock first cannot be undone by a late recovery', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-delete-race-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], clientKeys: [], sideTurns: [{ id: 'side', side: true, user: { text: 'Question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running' }] };
  let current: StoredThread | undefined = thread, saves = 0, entered!: () => void, release!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const deleting = withHomeLock(home, async () => { entered(); await held; current = undefined; });
  await acquired;
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => current,
    plan: () => ({ ok: false, reason: 'NOT_AVAILABLE', detail: 'not used', outcome: 'REFUSED' }), begin: async () => { throw new Error('not used'); },
    credential: async () => '', closing: () => false, save: async () => { saves++; },
  });
  const recovering = service.recover(thread);
  release();
  await Promise.all([deleting, recovering]);
  assert.equal(saves, 0, 'a deleted thread must not be saved back');
  assert.equal(current, undefined);
  assert.equal(service.isRunning('thread'), false);
});

test('an unsolicited model tool call cannot write a working file', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-write-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const model = await startScriptedModel('side-write', (messages) => messages.some((m) => m.role === 'tool')
    ? { text: 'The attempted write was unavailable.' }
    : { calls: [{ name: 'write_file', args: { name: 'working.md', content: 'changed' } }] });
  t.after(() => model.close());
  const material = new MaterialStore(home, {}, () => {});
  const original = material.create('project', 'working.md', 'text/markdown', Buffer.from('human work'), 'working', 'person');
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let writes = 0;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: model.model, label: 'local', baseUrl: model.url, credential: null };
  const service = createSideChat({ home, material, thread: () => thread, plan: () => ({ ok: true, value: { engine: createPiHarness(), route } }),
    credential: async () => '', closing: () => false, save: async () => {},
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => { writes++; return undefined; } }, abandon: async () => {}, finish: async () => {} }; },
  });
  const result = await service.ask({ threadId: 'thread', text: 'Inspect the file', clientKey: 'attempt' });
  assert.ok(result.ok);
  assert.equal(writes, 0);
  assert.equal(material.load(original.id)?.current, 1);
  assert.equal(Buffer.from(material.bytes(original.id, 1)).toString(), 'human work');
  assert.ok(model.requests.some((request) => request.body.includes('write_file')), 'the model actually requested the forbidden tool');
  assert.equal(result.value.status, 'refused');
  assert.equal(result.value.refusal?.reason, 'SIDE_CHAT_READ_ONLY');
  assert.match(result.value.answer?.text ?? '', /unavailable|could not finish|unknown|refused/i);
});

test('the Host read-only crossing refuses a write even if an engine bypasses its own tool filter', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-host-boundary-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let hostWrites = 0, engineResult: string | undefined;
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: (_request: unknown, context: TurnContext) => ({
    events: (async function* () { const result = await context.tools.write('working.md', 'new text', new AbortController().signal); engineResult = result.outcome; })(),
    outcome: Promise.resolve({ status: 'done', answer: 'Done', usage: { input: 0, output: 0 } }), stop: () => {}, steer: () => {},
  }) } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', baseUrl: 'http://127.0.0.1:1', label: 'local', credential: null };
  const service = createSideChat({ home, material, thread: () => thread, plan: () => ({ ok: true, value: { engine, route } }),
    credential: async () => '', closing: () => false, save: async () => {},
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => { hostWrites++; return undefined; } }, abandon: async () => {}, finish: async () => {} }; },
  });
  const result = await service.ask({ threadId: 'thread', text: 'Inspect', clientKey: 'key' });
  assert.ok(result.ok);
  assert.equal(engineResult, 'REFUSED');
  assert.equal(hostWrites, 0);
  assert.equal(result.value.status, 'refused');
  assert.equal(result.value.refusal?.reason, 'SIDE_CHAT_READ_ONLY');
  assert.match(result.value.answer?.text ?? '', /does not write|read.only/i);
});

test('an unqualified native runtime is refused before a side question is admitted', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-native-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let begun = 0;
  const engine = { specificationVersion: 'v1', id: 'harness-codex', label: 'native', start: () => { throw new Error('not used'); } } as HarnessV1;
  const route = { kind: 'native' as const, provider: 'codex' as const, model: 'test', label: 'native', baseUrl: '', credential: null };
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: true, value: { engine, route } }), begin: async () => { begun++; throw new Error('not used'); },
    credential: async () => '', closing: () => false, save: async () => {},
  });
  const result = await service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' });
  assert.ok(!result.ok);
  assert.match(result.detail, /read-only/);
  assert.equal(begun, 0);
  assert.equal(thread.sideTurns.length, 0);
});

test('a failed Core finish is unknown even if the model answered', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-finish-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const model = await startScriptedModel('side-finish', () => ({ text: 'MODEL ANSWER' }));
  t.after(() => model.close());
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: model.model, label: 'local', baseUrl: model.url, credential: null };
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: true, value: { engine: createPiHarness(), route } }), credential: async () => '', closing: () => false, save: async () => {},
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => { throw new Error('failed'); } }; },
  });
  const result = await service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' });
  assert.ok(result.ok);
  assert.equal(result.value.status, 'stopped');
  assert.notEqual(result.value.completed, true);
  assert.match(result.value.answer?.text ?? '', /unknown/);
  assert.match(result.value.answer?.text ?? '', /MODEL ANSWER/);
});

test('a save failure after begin abandons lease renewal without finishing an unbound run', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-bind-failure-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let saves = 0, abandoned = 0, finishes = 0, starts = 0;
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: () => { starts++; throw new Error('must not start'); } } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', label: 'local', baseUrl: 'http://127.0.0.1:1', credential: null };
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false,
    save: async () => { if (++saves === 2) throw new Error('injected identity save failure'); },
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => { abandoned++; }, finish: async () => { finishes++; } }; },
  });
  const result = await service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' });
  assert.ok(result.ok);
  assert.equal(result.value.status, 'stopped');
  assert.equal(result.value.sideRecoveryPending, true);
  assert.match(result.value.answer?.text ?? '', /unknown/i);
  assert.equal(starts, 0);
  assert.equal(abandoned, 1);
  assert.equal(finishes, 0, 'a possibly unbound run must not be finished');
});

test('a failed final save never turns an in-memory answer into a durable success on retry', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-save-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const model = await startScriptedModel('side-save', () => ({ text: 'MODEL ANSWER' }));
  t.after(() => model.close());
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: model.model, label: 'local', baseUrl: model.url, credential: null };
  let finished = false, failed = false;
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: true, value: { engine: createPiHarness(), route } }), credential: async () => '', closing: () => false,
    save: async () => { if (finished && !failed) { failed = true; throw new Error('injected save failure'); } },
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => { finished = true; } }; },
  });
  await assert.rejects(service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' }), /injected save failure/);
  const count = model.requests.length;
  const retry = await service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' });
  assert.ok(retry.ok);
  assert.equal(retry.value.status, 'stopped');
  assert.notEqual(retry.value.completed, true);
  assert.match(retry.value.answer?.text ?? '', /unknown/);
  assert.match(retry.value.answer?.text ?? '', /MODEL ANSWER/);
  assert.equal(model.requests.length, count, 'a retry must not start another model request');
});

test('a retained unconfirmed side response is not replayed as model context', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-partial-context-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const model = await startScriptedModel('side-partial', () => ({ text: 'NEW ANSWER' }));
  t.after(() => model.close());
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], clientKeys: [], sideTurns: [{ id: 'old', side: true, sideClientKey: 'old-key', user: { text: 'Old question', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'stopped', interrupted: true, answer: { text: 'UNKNOWN PARTIAL RESPONSE', files: [] } }] };
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: model.model, label: 'local', baseUrl: model.url, credential: null };
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: true, value: { engine: createPiHarness(), route } }), credential: async () => '', closing: () => false, save: async () => {},
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; },
  });
  const result = await service.ask({ threadId: 'thread', text: 'New question', clientKey: 'new-key' });
  assert.ok(result.ok && result.value.status === 'done');
  const posts = model.requests.filter((request) => request.body.includes('"messages"'));
  assert.ok(posts.length > 0);
  assert.doesNotMatch(posts.map((request) => request.body).join('\n'), /UNKNOWN PARTIAL RESPONSE/);
  assert.equal(thread.sideTurns[0].answer?.text, 'UNKNOWN PARTIAL RESPONSE', 'the person can still inspect it');
});

test('a streamed partial answer survives a model failure as explicitly unconfirmed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-partial-failure-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: () => ({
    events: (async function* () { yield { type: 'text' as const, delta: 'PARTIAL MODEL WORDS' }; })(),
    outcome: Promise.resolve({ status: 'failed', error: 'network lost', answer: '', usage: { input: 0, output: 0 } }), stop: () => {}, steer: () => {},
  }) } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', baseUrl: 'http://127.0.0.1:1', label: 'local', credential: null };
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false, save: async () => {},
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; },
  });
  const result = await service.ask({ threadId: 'thread', text: 'Question', clientKey: 'key' });
  assert.ok(result.ok);
  assert.equal(result.value.status, 'stopped');
  assert.match(result.value.answer?.text ?? '', /unconfirmed/i);
  assert.match(result.value.answer?.text ?? '', /PARTIAL MODEL WORDS/);
});

test('concurrent main and side progress retain both turns in the durable projection', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-concurrent-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const model = await startScriptedModel('side-concurrent', () => ({ text: 'SIDE ANSWER' }), { before: async () => { entered(); await held; } });
  t.after(() => model.close());
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: true, updatedAt: now }, turns: [{ id: 'main', side: false, user: { text: 'Main', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'running' }], sideTurns: [], clientKeys: ['main'] };
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: model.model, label: 'local', baseUrl: model.url, credential: null };
  const service = createSideChat({ home, material: new MaterialStore(home, {}, () => {}), thread: () => thread,
    plan: () => ({ ok: true, value: { engine: createPiHarness(), route } }), credential: async () => '', closing: () => false,
    save: () => saveThreadProjection(home, thread),
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; },
  });
  const pending = service.ask({ threadId: 'thread', text: 'Side', clientKey: 'side-key' });
  await started;
  thread.turns[0].answer = { text: 'MAIN PROGRESS', files: [] };
  await saveThreadProjection(home, thread);
  release();
  const side = await pending;
  assert.ok(side.ok && side.value.status === 'done');
  const stored = JSON.parse(readFileSync(join(home, 'threads', 'thread.json'), 'utf8')) as StoredThread;
  assert.equal(stored.turns[0].answer?.text, 'MAIN PROGRESS');
  assert.equal(stored.sideTurns[0].answer?.text, 'SIDE ANSWER');
  assert.equal(stored.sideTurns[0].sideClientKey, 'side-key');
});

test('a source withdrawn before the model request removes the dependent prior answer', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-withdrawn-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const model = await startScriptedModel('side-withdrawn', () => ({ text: 'ANSWER' }));
  t.after(() => model.close());
  const material = new MaterialStore(home, {}, () => {});
  const source = material.create('project', 'source.md', 'text/markdown', Buffer.from('PRIVATE SOURCE'), 'original', 'person');
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [{ id: 'main', side: false, user: { text: 'Explain', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'done', reads: [{ id: source.id, name: source.name, version: 1, withdrawals: 0 }], answer: { text: 'PRIVATE DERIVED ANSWER', files: [] } }], sideTurns: [], clientKeys: ['main'] };
  let entered!: () => void, release!: () => void;
  const starting = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: model.model, label: 'local', baseUrl: model.url, credential: null };
  const service = createSideChat({ home, material, thread: () => thread, plan: () => ({ ok: true, value: { engine: createPiHarness(), route } }),
    credential: async () => '', closing: () => false, save: async () => {},
    begin: async (_thread, turn) => { bind(thread, turn, route); entered(); await held; return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; },
  });
  const pending = service.ask({ threadId: 'thread', text: 'What now?', clientKey: 'side-key' });
  await starting;
  material.withdraw(source.id);
  release();
  const result = await pending;
  assert.ok(result.ok);
  const posts = model.requests.filter((request) => request.body.includes('"messages"'));
  assert.ok(posts.length > 0, 'the local model was reached');
  assert.doesNotMatch(posts.map((request) => request.body).join('\n'), /PRIVATE SOURCE|PRIVATE DERIVED ANSWER/);
});

test('withdrawal after history is recorded but before dispatch never sends the dependent answer', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-send-gate-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const model = await startScriptedModel('side-gate', () => ({ text: 'ANSWER' }));
  t.after(() => model.close());
  const material = new MaterialStore(home, {}, () => {});
  const source = material.create('project', 'source.md', 'text/markdown', Buffer.from('PRIVATE SOURCE'), 'original', 'person');
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [{ id: 'main', side: false, user: { text: 'Explain', attachments: [], at: now }, work: { startedAt: now, steps: [], harness: 'test' }, effects: [], status: 'done', reads: [{ id: source.id, name: source.name, version: 1, withdrawals: 0 }], answer: { text: 'PRIVATE DERIVED ANSWER', files: [] } }], sideTurns: [], clientKeys: ['main'] };
  let entered!: () => void, release!: () => void, blocked = false;
  const recording = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: model.model, label: 'local', baseUrl: model.url, credential: null };
  const service = createSideChat({ home, material, thread: () => thread, plan: () => ({ ok: true, value: { engine: createPiHarness(), route } }),
    credential: async () => '', closing: () => false,
    save: async () => { if (!blocked && thread.sideTurns[0]?.reads?.some((read) => read.id === source.id)) { blocked = true; entered(); await held; } },
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; },
  });
  const pending = service.ask({ threadId: 'thread', text: 'What now?', clientKey: 'side-key' });
  await recording;
  material.withdraw(source.id);
  release();
  const result = await pending;
  assert.ok(result.ok);
  const posts = model.requests.filter((request) => request.body.includes('"messages"'));
  assert.doesNotMatch(posts.map((request) => request.body).join('\n'), /PRIVATE SOURCE|PRIVATE DERIVED ANSWER/);
});


test('a denied native action overrides a false model claim and retains it as unconfirmed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-native-refusal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const source = material.create('project', 'note.md', 'text/markdown', Buffer.from('human original'), 'working', 'person');
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  const fixture = fileURLToPath(new URL('../../modules/harness-codex/test/fixtures/native.mjs', import.meta.url));
  const native = createCodexHarness({ command: [process.execPath, fixture, 'readonly-false'], temporaryRoot: home, requestTimeoutMs: 1500, turnTimeoutMs: 3000 });
  // Only this isolated test bypasses admission; the production guard still rejects native until qualified.
  const engine = { ...native, id: 'harness-pi' };
  const route = { kind: 'native' as const, provider: 'codex' as const, model: 'test-model', label: 'test native', baseUrl: '', credential: null };
  let effects = 0;
  const service = createSideChat({ home, material, thread: () => thread, plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false, save: async () => {},
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: unexpectedMaterialRead, write: async () => { effects++; return undefined; } }, abandon: async () => {}, finish: async () => {} }; },
  });
  const result = await service.ask({ threadId: 'thread', text: 'Update the note', clientKey: 'key' });
  assert.ok(result.ok);
  assert.equal(result.value.status, 'refused');
  assert.equal(result.value.refusal?.reason, 'SIDE_CHAT_READ_ONLY');
  assert.match(result.value.answer?.text ?? '', /not performed/);
  assert.match(result.value.answer?.text ?? '', /Unconfirmed model response[\s\S]*I changed the file/);
  assert.equal(Buffer.from(material.bytes(source.id, 1)).toString(), 'human original');
  assert.equal(material.load(source.id)?.current, 1);
  assert.equal(effects, 0);
  service.close(); await service.whenIdle();
});

test('withdrawing a read source cancels only affected side runs and never resends', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-withdraw-cancel-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const source = material.create('project', 'one.md', 'text/markdown', Buffer.from('one'), 'original', 'person');
  material.create('project', 'two.md', 'text/markdown', Buffer.from('two'), 'original', 'person');
  const now = new Date().toISOString();
  const makeThread = (id: string): StoredThread => ({ summary: { id, projectId: 'project', title: id, pinned: false, unread: false, archived: false, running: true, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] });
  const first = makeThread('first'), second = makeThread('second');
  const entered = new Map<string, () => void>(), resumed = new Map<string, (status: 'done' | 'interrupted') => void>();
  const seen = (id: string) => new Promise<void>((resolve) => entered.set(id, resolve));
  const firstRead = seen('first'), secondRead = seen('second');
  let starts = 0;
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: (request: { threadId: string }, context: TurnContext) => {
    starts++;
    const result = new Promise<'done' | 'interrupted'>((resolve) => resumed.set(request.threadId, resolve));
    return { events: (async function* () { await context.tools.read(request.threadId === 'first' ? 'one.md' : 'two.md'); entered.get(request.threadId)!(); await result; })(), outcome: result.then((status) => ({ status, answer: status === 'done' ? 'Independent result' : 'Partial', usage: { input: 0, output: 0 } })), stop: () => resumed.get(request.threadId)!('interrupted'), steer: () => {} };
  } } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', baseUrl: 'http://127.0.0.1:1', label: 'local', credential: null };
  const service = createSideChat({ home, material, thread: (id) => id === first.summary.id ? first : id === second.summary.id ? second : undefined, plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false, save: async () => {}, begin: async (thread, turn) => { bind(thread, turn, route); return { gateway: { read: syntheticMaterialReader(home, material, 'project'), write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; } });
  const a = service.ask({ threadId: 'first', text: 'First', clientKey: 'first' });
  const b = service.ask({ threadId: 'second', text: 'Second', clientKey: 'second' });
  await Promise.all([firstRead, secondRead]);
  service.sourceWithdrawn('other-project', source.id); assert.equal(service.isRunning('first'), true);
  material.withdraw(source.id); service.sourceWithdrawn('project', source.id);
  const stopped = await a; assert.ok(stopped.ok); assert.equal(stopped.value.status, 'stopped'); assert.equal(stopped.value.withheld, true);
  assert.match(stopped.value.answer?.text ?? '', /withdrawn/); assert.equal(first.summary.running, true);
  assert.equal(service.isRunning('second'), true); resumed.get('second')!('done');
  const unaffected = await b; assert.ok(unaffected.ok); assert.equal(unaffected.value.status, 'done');
  const retry = await service.ask({ threadId: 'first', text: 'First', clientKey: 'first' }); assert.ok(retry.ok && retry.value.id === stopped.value.id); assert.equal(starts, 2);
  service.close(); await service.whenIdle();
});

test('withdrawal while Core settlement is in flight does not present the side result as successful', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-withdraw-finish-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const source = material.create('project', 'one.md', 'text/markdown', Buffer.from('one'), 'original', 'person');
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let finishEntered!: () => void, releaseFinish!: () => void, submitted: string | undefined;
  const entered = new Promise<void>((resolve) => { finishEntered = resolve; });
  const held = new Promise<void>((resolve) => { releaseFinish = resolve; });
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: (_request: unknown, context: TurnContext) => ({ events: (async function* () { await context.tools.read('one.md'); })(), outcome: Promise.resolve({ status: 'done', answer: 'Unconfirmed answer', usage: { input: 0, output: 0 } }), stop: () => {}, steer: () => {} }) } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', baseUrl: 'http://127.0.0.1:1', label: 'local', credential: null };
  const service = createSideChat({ home, material, thread: () => thread, plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false, save: async () => {}, begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: syntheticMaterialReader(home, material, 'project'), write: async () => undefined }, abandon: async () => {}, finish: async (status) => { submitted = status; finishEntered(); await held; } }; } });
  const pending = service.ask({ threadId: 'thread', text: 'Read', clientKey: 'key' });
  await entered; material.withdraw(source.id); service.sourceWithdrawn('project', source.id);
  assert.equal(thread.sideTurns[0].status, 'stopped'); assert.equal(thread.sideTurns[0].sideRecoveryPending, true);
  releaseFinish();
  const result = await pending; assert.ok(result.ok); assert.equal(submitted, 'succeeded', 'settlement was already in flight: cancellation cannot retract it');
  assert.equal(result.value.status, 'stopped'); assert.equal(result.value.withheld, true); assert.notEqual(result.value.completed, true); assert.match(result.value.answer?.text ?? '', /withdrawn/);
  service.close(); await service.whenIdle();
});

test('withdrawal does not hide an unknown Core settlement under model text', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-withdraw-unknown-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const source = material.create('project', 'one.md', 'text/markdown', Buffer.from('one'), 'original', 'person');
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let finishEntered!: () => void, releaseFinish!: () => void;
  const entered = new Promise<void>((resolve) => { finishEntered = resolve; });
  const held = new Promise<void>((resolve) => { releaseFinish = resolve; });
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: (_request: unknown, context: TurnContext) => ({ events: (async function* () { await context.tools.read('one.md'); })(), outcome: Promise.resolve({ status: 'done', answer: 'Model answer', usage: { input: 0, output: 0 } }), stop: () => {}, steer: () => {} }) } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', baseUrl: 'http://127.0.0.1:1', label: 'local', credential: null };
  const service = createSideChat({ home, material, thread: () => thread, plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false, save: async () => {}, begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: syntheticMaterialReader(home, material, 'project'), write: async () => undefined }, abandon: async () => {}, finish: async () => { finishEntered(); await held; throw new Error('connection lost'); } }; } });
  const pending = service.ask({ threadId: 'thread', text: 'Read', clientKey: 'key' });
  await entered; material.withdraw(source.id); service.sourceWithdrawn('project', source.id); releaseFinish();
  const result = await pending; assert.ok(result.ok); assert.equal(result.value.status, 'stopped'); assert.equal(result.value.withheld, true); assert.equal(result.value.sideRecoveryPending, true);
  assert.match(result.value.answer?.text ?? '', /^The side question finished, but its run could not be recorded/);
  service.close(); await service.whenIdle();
});

test('withdrawal during the final save persists the stopped and withheld side result', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'backbone-side-withdraw-save-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const source = material.create('project', 'one.md', 'text/markdown', Buffer.from('one'), 'original', 'person');
  const now = new Date().toISOString();
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Work', pinned: false, unread: false, archived: false, running: false, updatedAt: now }, turns: [], sideTurns: [], clientKeys: [] };
  let saveEntered!: () => void, releaseSave!: () => void, blocked = false;
  const entered = new Promise<void>((resolve) => { saveEntered = resolve; });
  const held = new Promise<void>((resolve) => { releaseSave = resolve; });
  const snapshots: string[] = [];
  const engine = { specificationVersion: 'v1', id: 'harness-pi', label: 'controlled', start: (_request: unknown, context: TurnContext) => ({ events: (async function* () { await context.tools.read('one.md'); })(), outcome: Promise.resolve({ status: 'done', answer: 'Model answer', usage: { input: 0, output: 0 } }), stop: () => {}, steer: () => {} }) } as HarnessV1;
  const route = { kind: 'endpoint' as const, provider: 'openai-compatible' as const, model: 'test', baseUrl: 'http://127.0.0.1:1', label: 'local', credential: null };
  const service = createSideChat({ home, material, thread: () => thread, plan: () => ({ ok: true, value: { engine, route } }), credential: async () => '', closing: () => false,
    save: async (value) => { if (!blocked && value.sideTurns[0]?.status === 'done') { blocked = true; saveEntered(); await held; } snapshots.push(JSON.stringify(value)); },
    begin: async (_thread, turn) => { bind(thread, turn, route); return { gateway: { read: syntheticMaterialReader(home, material, 'project'), write: async () => undefined }, abandon: async () => {}, finish: async () => {} }; } });
  const pending = service.ask({ threadId: 'thread', text: 'Read', clientKey: 'key' });
  await entered; material.withdraw(source.id); service.sourceWithdrawn('project', source.id); releaseSave();
  const result = await pending; assert.ok(result.ok); assert.equal(result.value.status, 'stopped'); assert.equal(result.value.withheld, true);
  const saved = (JSON.parse(snapshots.at(-1)!) as StoredThread).sideTurns[0]; assert.equal(saved.status, 'stopped'); assert.equal(saved.withheld, true); assert.notEqual(saved.sideRecoveryPending, true);
  service.close(); await service.whenIdle();
});


test('side work labels the effective read-only scope while preserving the engine identity', () => {
  assert.equal(sideHarnessLabel({ id: 'harness-pi', label: 'Pi 1.0' }), 'Pi 1.0 · read-only');
  assert.equal(sideHarnessLabel({ id: 'harness-codex', label: 'Codex 0.165.0 · full' }), 'Codex 0.165.0 · read-only');
  assert.equal(sideHarnessLabel({ id: 'harness-codex', label: 'Codex 0.165.0 · contained' }), 'Codex 0.165.0 · read-only');
});
