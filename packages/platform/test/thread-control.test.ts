import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withHomeLock, assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { ThreadJournal, type StoredThread } from '../src/composition/thread-journal.ts';
import type { Thread, Turn } from '../src/api.ts';
import { createThreadControl } from '../src/composition/thread-control.ts';
const turn = (id = 'old'): Turn => ({ id, side: false, status: 'running', user: { text: 'Do the job', attachments: [], at: '', settings: { permission: 'full', effort: 3, mode: 'chat', runsOn: 'this-computer', model: 'scripted' } }, effects: [], work: { harness: 'Scripted', startedAt: '', steps: [] } });
function fixture() {
  const thread = { summary: { id: 'chat', projectId: 'project', running: true }, turns: [turn()], children: [] } as unknown as Thread;
  const threads = new Map([['chat', thread]]);
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const sends: unknown[] = [], stops: unknown[] = [];
  const control = createThreadControl({
    get: async ({ id }) => threads.has(id) ? { ok: true, value: threads.get(id)! } : { ok: false, reason: 'NOT_FOUND', detail: 'No thread', outcome: 'REFUSED' },
    stop: async args => { stops.push(args); return { ok: true, value: { stopped: true } }; },
    settled: async () => settled,
    canRestart: () => true,
    send: async args => { sends.push(args); return { ok: true, value: { threadId: 'chat', turnId: 'continued' } }; },
  });
  return { control, thread, threads, sends, stops, settle: () => { thread.summary.running = false; thread.turns[0].status = 'stopped'; settle(); } };
}
test('restart stops first, joins the original worker and continues once with the original settings and history', async () => {
  const f = fixture();
  const first = f.control.restart({ threadId: 'chat', turnId: 'old' });
  const retry = f.control.restart({ threadId: 'chat', turnId: 'old' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.stops.length, 1);
  assert.equal(f.sends.length, 0);
  f.settle();
  assert.deepEqual(await first, await retry);
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.thread.turns.map(t => t.id), ['old']);
  const sent = f.sends[0] as Record<string, unknown>;
  assert.deepEqual(sent.settings, f.thread.turns[0].user.settings);
  assert.notEqual(sent.text, f.thread.turns[0].user.text);
  assert.deepEqual(sent.attachments, []);
  assert.equal(sent.afterTurnId, 'old');
  assert.deepEqual(f.stops, [{ threadId: 'chat', turnId: 'old' }]);
});
test('restart refuses stale views before stopping a newer turn', async () => {
  const f = fixture(); f.thread.turns.push(turn('new'));
  const result = await f.control.restart({ threadId: 'chat', turnId: 'old' });
  assert.equal(result.ok, false); assert.equal(f.stops.length, 0); assert.equal(f.sends.length, 0);
});
test('restart never continues an uncertain write or unresolved recovery', async () => {
  for (const held of ['effect', 'recovery', 'child', 'native'] as const) {
    const f = fixture();
    if (held === 'effect') f.thread.turns[0].effects.push({ key: 'write', kind: 'write-working-copy', target: 'brief.md', outcome: 'UNKNOWN', detail: 'Receipt missing' });
    if (held === 'native') f.thread.turns[0].unknownOutcome = true;
    if (held === 'recovery') f.thread.summary.recoveryHold = { kind: 'inspection', turnId: 'old' };
    if (held === 'child') f.thread.children = [{ handover: { receipts: [{ outcome: 'UNKNOWN' }] } }] as unknown as Thread['children'];
    const pending = f.control.restart({ threadId: 'chat', turnId: 'old' }); f.settle();
    assert.equal((await pending).ok, false); assert.equal(f.sends.length, 0);
  }
});
test('a turn admitted while restart settles is never replaced', async () => {
  const f = fixture(); const pending = f.control.restart({ threadId: 'chat', turnId: 'old' });
  await Promise.resolve(); await Promise.resolve();
  f.thread.turns.push(turn('new')); f.settle();
  assert.equal((await pending).ok, false); assert.equal(f.sends.length, 0);
});


test('a stopped child with only an uncertain native or connector action holds parent restart', async () => {
  const f = fixture();
  const child = { summary: { id: 'child', running: false }, turns: [{ ...turn('worker'), status: 'stopped', unknownOutcome: true }] } as unknown as Thread;
  f.threads.set('child', child);
  f.thread.children = [{ threadId: 'child', running: false, handover: { receipts: [] } }] as unknown as Thread['children'];
  const pending = f.control.restart({ threadId: 'chat', turnId: 'old' }); f.settle();
  assert.equal((await pending).ok, false); assert.equal(f.sends.length, 0);
});

test('a lost continuation receipt is recovered from its original turn marker without stopping or sending again', async () => {
  const original = turn('old'); original.status = 'stopped';
  const thread = { summary: { id: 'chat', projectId: 'project', running: false }, turns: [original] } as unknown as Thread;
  let sends = 0, stops = 0;
  const control = createThreadControl({
    get: async () => ({ ok: true, value: thread }), canRestart: () => true, settled: async () => {},
    stop: async () => { stops++; return { ok: true, value: { stopped: false } }; },
    send: async args => { sends++; thread.turns.push({ ...turn('continued'), restartOf: args.afterTurnId }); throw new Error('response lost'); },
  });
  await assert.rejects(control.restart({ threadId: 'chat', turnId: 'old' }), /response lost/);
  assert.deepEqual(await control.restart({ threadId: 'chat', turnId: 'old' }), { ok: true, value: { threadId: 'chat', turnId: 'continued' } });
  assert.deepEqual([sends, stops], [1, 1]);
});

test('goal work uses its own Resume and a completed turn is not restarted', async () => {
  for (const kind of ['goal', 'done'] as const) {
    const f = fixture();
    if (kind === 'goal') f.thread.goalRun = { status: 'interrupted' } as Thread['goalRun'];
    else f.thread.turns[0].status = 'done';
    assert.equal((await f.control.restart({ threadId: 'chat', turnId: 'old' })).ok, false);
    assert.deepEqual([f.stops.length, f.sends.length], [0, 0]);
  }
});

test('a worker that does not stop never gains a second carrier', async () => {
  const f = fixture();
  const control = createThreadControl({ get: async () => ({ ok: true, value: f.thread }), stop: async () => ({ ok: true, value: { stopped: true } }),
    canRestart: () => true, settled: () => new Promise(() => {}), send: async () => { throw new Error('must not start'); } }, 1);
  assert.equal((await control.restart({ threadId: 'chat', turnId: 'old' })).ok, false);
});


test('unknown native outcomes survive rebuilding a lost thread cache from the journal', async t => {
  const home = mkdtempSync(join(tmpdir(), 'thread-control-journal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const journal = new ThreadJournal(home);
  await withHomeLock(home, async () => {
    assertHomeWriteAdmission(home);
    journal.append({ kind: 'turn.reserved', threadId: 'chat', turn: turn(), clientKey: 'first', created: {
      summary: { id: 'chat', projectId: 'project', title: 'Work', running: true, pinned: false, unread: false, archived: false, updatedAt: '' },
    } });
    assertHomeWriteAdmission(home);
    journal.append({ kind: 'turn.closed', threadId: 'chat', turnId: 'old', state: { status: 'stopped', effects: [], unknownOutcome: true } });
  });
  const rebuilt = new Map<string, StoredThread>(); journal.rebuild(rebuilt);
  assert.equal(rebuilt.get('chat')?.turns[0].unknownOutcome, true);
});


test('restart admission checks the original engine provenance after a Host engine switch', async () => {
  const f = fixture(); f.thread.turns[0].work.harness = 'ACP (experimental)';
  let checked: Turn | undefined, stopped = false;
  const control = createThreadControl({
    get: async () => ({ ok: true, value: f.thread }),
    canRestart: original => { checked = original; return original.work.harness.startsWith('ACP') ? 'Original native effects cannot be attested' : true; },
    settled: async () => {}, stop: async () => { stopped = true; return { ok: true, value: { stopped: false } }; },
    send: async () => { throw new Error('must not continue'); },
  });
  assert.equal((await control.restart({ threadId: 'chat', turnId: 'old' })).ok, false);
  assert.equal(checked, f.thread.turns[0]); assert.equal(stopped, false);
});

test('a known hold on an ended turn refuses Restart without pausing its queue or pool', async () => {
  for (const held of ['effect', 'recovery', 'native', 'child'] as const) {
    const f = fixture(); f.settle();
    if (held === 'effect') f.thread.turns[0].effects.push({ key: 'write', kind: 'write-working-copy', target: 'brief.md', outcome: 'UNKNOWN' });
    if (held === 'native') f.thread.turns[0].unknownOutcome = true;
    if (held === 'recovery') f.thread.summary.recoveryHold = { kind: 'inspection', turnId: 'old' };
    if (held === 'child') {
      const child = { summary: { id: 'child', running: false }, turns: [{ ...turn('worker'), status: 'stopped', unknownOutcome: true }] } as unknown as Thread;
      f.threads.set('child', child);
      f.thread.children = [{ threadId: 'child', running: false, handover: { receipts: [] } }] as unknown as Thread['children'];
    }
    assert.equal((await f.control.restart({ threadId: 'chat', turnId: 'old' })).ok, false);
    assert.equal(f.stops.length, 0, `${held}: Stop would pause both the queue and pool`);
    assert.equal(f.sends.length, 0);
  }
});

test('durable unmarked connector holds are checked on the parent and every child before Stop', async () => {
  for (const heldId of ['chat', 'child']) {
    const f = fixture(); f.settle();
    const child = { summary: { id: 'child', running: false }, turns: [{ ...turn('worker'), status: 'stopped' }] } as unknown as Thread;
    f.threads.set('child', child);
    f.thread.children = [{ threadId: 'child', running: false, handover: { receipts: [] } }] as unknown as Thread['children'];
    const checked: string[] = [];
    const control = createThreadControl({
      get: async ({ id }) => ({ ok: true, value: f.threads.get(id)! }),
      stop: async () => { throw Error('A refused Restart must not pause queues or pools'); },
      send: async () => { throw Error('No continuation may be admitted'); },
      canRestart: () => true, settled: async () => {},
      unresolved: async id => { checked.push(id); return id === heldId; },
    });
    assert.equal((await control.restart({ threadId: 'chat', turnId: 'old' })).ok, false);
    assert.ok(checked.includes(heldId));
  }
});

test('native activity observed while Stop settles is rechecked before restart', async () => {
  const current = turn();
  const thread = { summary: { id: 'chat', projectId: 'project', running: true }, turns: [current], children: [] } as unknown as Thread;
  let sends = 0;
  const control = createThreadControl({
    get: async () => ({ ok: true, value: structuredClone(thread) }),
    stop: async () => { current.nativeAccountActivity = true; current.status = 'stopped'; thread.summary.running = false; return { ok: true, value: { stopped: true } }; },
    settled: async () => {},
    canRestart: t => t.nativeAccountActivity && t.status !== 'done' ? 'Native account activity needs inspection.' : true,
    send: async () => { sends++; return { ok: true, value: { threadId: 'chat', turnId: 'continued' } }; },
  });
  const result = await control.restart({ threadId: 'chat', turnId: current.id });
  assert.equal(result.ok, false); assert.equal(sends, 0);
  if (!result.ok) assert.match(result.detail, /Native account activity/);
});


for (const status of ['done', 'refused'] as const) test(`checking an ended ${status} turn does not add Restart`, async () => {
  const { unknownRevision } = await import('../src/composition/unknown-checks.ts');
  const f = fixture(); f.settle();
  const target = f.thread.turns[0]; target.status = status; target.unknownOutcome = true;
  target.unknownChecked = { revision: unknownRevision(target), by: 'owner', at: '', steps: [] };
  const control = createThreadControl({ get: async () => ({ ok: true, value: f.thread }), canRestart: () => true, unresolved: async () => false, settled: async () => {},
    stop: async args => { f.stops.push(args); return { ok: true, value: { stopped: false } }; },
    send: async args => { f.sends.push(args); return { ok: true, value: { threadId: 'chat', turnId: 'continued' } }; } });
  const result = await control.restart({ threadId: 'chat', turnId: 'old' });
  assert.equal(result.ok, false); assert.equal(f.sends.length, 0); assert.equal(f.stops.length, 0);
});
