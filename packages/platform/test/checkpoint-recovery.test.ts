// Local recovery copies are inspection data, never proof of an authorised working document.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MaterialStore } from '../src/stub/material.ts';
import { checkpointRun, createCheckpointRecovery, createRecoveryRetries, inspectCheckpoint, projectRecoverySummary, recoveryKind, recoveryRetentionReason, recoverySummary, type CheckpointContext } from '../src/composition/checkpoint-recovery.ts';
import { exportHome, importHome } from '../src/composition/backup.ts';
import type { CoreLink } from '../src/composition/core.ts';
import type { Turn } from '../src/api.ts';

test('recovery retries require enablement, coalesce a turn and back off without overlapping work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retries = createRecoveryRetries(); let calls = 0, duplicate = 0, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); await retries.close(); });
  retries.add('turn', async () => { calls++; if (calls === 1) await blocked; return calls < 2; });
  retries.add('turn', async () => { duplicate++; return true; });
  t.mock.timers.tick(60_000); assert.equal(calls, 0, 'opening is not resuming');
  retries.enable(); t.mock.timers.tick(249); assert.equal(calls, 0);
  t.mock.timers.tick(1); assert.equal(calls, 1);
  t.mock.timers.tick(60_000); assert.equal(calls, 1, 'a slow observation is never overlapped');
  release(); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(499); assert.equal(calls, 1);
  t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  t.mock.timers.tick(60_000); assert.equal(calls, 2, 'a settled observation leaves no recurring job'); assert.equal(duplicate, 0);
});

test('recovery retry delays are capped and close joins an active attempt without rearming it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retries = createRecoveryRetries(); let calls = 0, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); await retries.close(); });
  retries.add('turn', async () => { calls++; if (calls === 10) await blocked; return true; }); retries.enable();
  for (const delay of [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]) {
    const before = calls; t.mock.timers.tick(delay - 1); assert.equal(calls, before);
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, before + 1);
  }
  let joined = false; const closing = retries.close().then(() => { joined = true; });
  t.mock.timers.tick(60_000); await new Promise(resolve => setImmediate(resolve)); assert.equal(joined, false); assert.equal(calls, 10);
  release(); await closing; assert.equal(joined, true);
  retries.add('late', async () => { calls++; return true; }); retries.enable(); t.mock.timers.tick(60_000); assert.equal(calls, 10);
});

test('a recovery copy keeps its data marker and stays unavailable after retirement and Save', async t => {
  const home = mkdtempSync(join(tmpdir(), 'checkpoint-copy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const material = new MaterialStore(home, {}, () => {});
  const recovery = { turnId: 'turn', reason: 'The original run did not import this saved piece.' };
  const entry = material.create('project', 'Saved work.md', 'text/markdown', Buffer.from('Retained bytes.'), 'working', 'agent', 'saved-piece', 'managed', { id: 'turn', name: 'Interrupted work' }, undefined, recovery);
  assert.deepEqual(material.load(entry.id)?.recovery, recovery);
  assert.equal(material.available('project').length, 0);
  material.mark(entry.id, { hidden: true, held: undefined });
  assert.equal(material.available('project').length, 0, 'retiring an inspection copy does not turn it into hidden agent input');
  const saved = await material.save(entry.id, 'Person edit to retained bytes.', 1);
  assert.ok(saved.ok);
  assert.equal(saved.value.hidden, true, 'a recovery copy is always data-only even if a lower-level Save is used');
  assert.deepEqual(saved.value.recovery, recovery);
  assert.equal(material.available('project').length, 0);
  material.create('project', 'Normal intermediate.md', 'text/markdown', Buffer.from('Normal work.'), 'working', 'agent', 'normal', 'managed');
  material.mark('normal', { hidden: true });
  assert.deepEqual(material.available('project').map(item => item.id), ['normal'], 'ordinary hidden intermediates keep their existing behaviour');
});


test('a malformed checkpoint produces a per-turn problem without echoing private parser details', () => {
  const store = { load(): never { throw new Error('PRIVATE-PARSER-DETAIL'); }, save: async () => {}, clear: async () => {} };
  const read = inspectCheckpoint(store);
  assert.equal(read.checkpoint, null); assert.match(read.problem!, /other conversations can continue/);
  assert.equal(read.problem!.includes('PRIVATE-PARSER-DETAIL'), false);
  for (const value of [{ files: 'not files', sources: [] }, { files: [{ name: 'a', body: 'one' }, { name: 'a', body: 'two' }], sources: [] }]) {
    assert.ok(inspectCheckpoint({ ...store, load: () => value as never }).problem);
  }
});

test('recovery data stays inert on export and restore even if an old visibility flag says otherwise', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'); mkdirSync(home);
  const material = new MaterialStore(home, {}, () => {});
  const entry = material.create('project', 'Inspection.md', 'text/markdown', Buffer.from('Unimported bytes.'), 'working', 'agent', 'copy', 'managed', { id: 'turn', name: 'Interrupted work' }, undefined, { turnId: 'turn', reason: 'Not imported.' });
  material.mark(entry.id, { hidden: false, held: undefined });
  assert.deepEqual(material.list('project'), [], 'ordinary consumers never list a recovery copy');
  const version = join(dir, 'v1'); writeFileSync(version, 'Unimported bytes.');
  const to = join(dir, 'export');
  await exportHome({ home, projects: [{ id: 'project', name: 'Project', kind: 'folder' }], documents: () => [material.load(entry.id)!], versionPath: () => version, threads: [], receipts: async () => [], secrets: async () => [] }, { to });
  const meta = JSON.parse(readFileSync(join(to, 'projects/p001/documents/d001/meta.json'), 'utf8'));
  assert.equal(meta.hidden, true, 'the data marker wins over a visibility flag');
  const plan = await importHome({ from: to, home: join(dir, 'restored'), dryRun: true });
  assert.equal(plan.adds.documents, 0); assert.ok(plan.skipped.some(name => name.includes('Inspection.md')));
});


test('an empty recovered checkpoint closes its original run before it can be forgotten', async t => {
  const home = mkdtempSync(join(tmpdir(), 'checkpoint-empty-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'threads'));
  writeFileSync(join(home, 'threads/thread.json'), JSON.stringify({ summary: { id: 'thread', projectId: 'project' }, turns: [], sideTurns: [], clientKeys: [] }));
  const order: string[] = [];
  let checkpoint: { files: []; sources: [] } | null = { files: [], sources: [] };
  const store = { load: () => checkpoint, save: async () => {}, clear: async () => { order.push('clear'); checkpoint = null; } };
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Interrupted', attachments: [], at: '2026-11-06T00:00:00Z' }, work: { startedAt: '2026-11-06T00:00:00Z', steps: [], harness: 'controlled' }, status: 'stopped', effects: [] };
  const link = { system: () => ({}), runOf: () => ({}), read: async (_: unknown, sql: string) => ({ rows: sql.includes('sec.current_run()') ? [{ id: 'run' }] : sql.includes('SELECT status FROM app.runs') ? [{ status: 'failed' }] : [] }), finishRun: async () => { order.push('finish'); return 'failed'; } } as unknown as CoreLink;
  const ctx: CheckpointContext = { home, threadId: 'thread', projectId: 'project', taskId: 'task', turn, link, store, material: new MaterialStore(home, {}, () => {}) };
  const recovery = createCheckpointRecovery(ctx, { run: 'run', fence: 2, secret: 'synthetic' }, true, async () => { order.push('journal'); });
  await recovery.store.clear();
  assert.deepEqual(order, ['finish', 'journal', 'clear'], 'a kill after clear cannot leave an open no-receipt run that restarts the producer');
  assert.equal(recovery.terminal, true);
});


test('a legacy checkpoint without run evidence cannot borrow another open run on the task', async t => {
  const home = mkdtempSync(join(tmpdir(), 'checkpoint-legacy-run-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'threads'));
  writeFileSync(join(home, 'threads/thread.json'), JSON.stringify({ summary: { id: 'thread', projectId: 'project' }, turns: [] }));
  const turn: Turn = { id: 'turn', side: false, user: { text: 'Legacy', attachments: [], at: '2026-11-06T00:00:00Z' }, work: { startedAt: '2026-11-06T00:00:00Z', steps: [], harness: 'controlled' }, status: 'stopped', effects: [] };
  const store = { load: () => ({ files: [{ name: 'note.md', body: 'Saved.', targetVersion: null }], sources: [] }), save: async () => {}, clear: async () => {} };
  const link = { system: () => ({}), read: async (_: unknown, sql: string) => ({ rows: sql.includes("status IN ('queued', 'running', 'waiting')") ? [{ id: 'unrelated-run' }] : [] }) } as unknown as CoreLink;
  await assert.rejects(checkpointRun({ home, threadId: 'thread', projectId: 'project', taskId: 'task', turn, store, link, material: new MaterialStore(home, {}, () => {}) }), /original.run|substitut|unattribut/i);
});


test('recovery summaries are derived for list and detail without changing stored thread state', () => {
  const summary = { id: 'thread', projectId: 'project', title: 'Work', running: false, pinned: false, unread: false, archived: false, updatedAt: '2026-11-06T00:00:00Z' };
  const turn: Turn = { id: 'turn', side: false, status: 'stopped', user: { text: 'Work', attachments: [], at: '' }, work: { startedAt: '', steps: [], harness: 'controlled' }, effects: [] };
  const store = () => ({ load: () => ({ files: [], sources: [] }), save: async () => {}, clear: async () => {} });
  assert.deepEqual(recoverySummary(summary, [turn], store, false).recoveryHold, { turnId: 'turn', kind: 'recovering' });
  turn.effects = [{ key: 'original', kind: 'write-working-copy', target: 'note.md', outcome: 'UNKNOWN' }];
  assert.equal(recoverySummary(summary, [turn], store, false).recoveryHold?.kind, 'recovering', 'a stored effect hint cannot stand in for a current Core receipt');
  assert.equal(recoverySummary(summary, [turn], store, true).recoveryHold?.kind, 'recovering');
  assert.equal(recoverySummary(summary, [turn], store, true).running, true, 'a journalled close is still busy until its carrier finishes and clears the checkpoint');
  assert.equal('recoveryHold' in summary, false);
  const empty = () => ({ load: () => null, save: async () => {}, clear: async () => {} });
  assert.equal(recoverySummary({ ...summary, recoveryHold: { turnId: 'turn', kind: 'recovering' } }, [turn], empty, false).recoveryHold, undefined, 'an old persisted hint cannot keep authority or a hold alive');
});


test('the earliest checkpoint blocks admission and current Core receipts own its decision signal', async () => {
  const summary = { id: 'thread', projectId: 'project', title: 'Work', running: false, pinned: false, unread: false, archived: false, updatedAt: '' };
  const first: Turn = { id: 'first', side: false, status: 'stopped', user: { text: '', attachments: [], at: '' }, work: { startedAt: '', steps: [], harness: 'controlled' }, effects: [{ key: 'old', kind: 'write-working-copy', target: 'note.md', outcome: 'UNKNOWN' }] };
  const turns = [first, { ...first, id: 'later' }];
  const store = () => ({ load: () => ({ files: [], sources: [] }), save: async () => {}, clear: async () => {} });
  let unresolved = false;
  const link = { system: () => ({}), read: async () => ({ rows: unresolved ? [{ status: 'unknown' }] : [] }) } as unknown as CoreLink;
  assert.deepEqual((await projectRecoverySummary(summary, turns, store, false, link, 'task', async () => 'original-run')).recoveryHold, { turnId: 'first', kind: 'recovering' });
  unresolved = true;
  assert.deepEqual((await projectRecoverySummary(summary, turns, store, false, link, 'task', async () => 'original-run')).recoveryHold, { turnId: 'first', kind: 'awaiting-decision' });
});


for (const row of [
  { label: 'ordinary running producer', input: { ordinary: true, active: true, inspection: false, dispatching: false, decision: false }, want: undefined },
  { label: 'active recovery outranks damaged data and decisions', input: { ordinary: false, active: true, inspection: true, dispatching: false, decision: true }, want: 'recovering' },
  { label: 'in-flight dispatch is system work', input: { ordinary: false, active: false, inspection: false, dispatching: true, decision: true }, want: 'recovering' },
  { label: 'damaged or unattributable data outranks a person decision', input: { ordinary: false, active: false, inspection: true, dispatching: false, decision: true }, want: 'inspection' },
  { label: 'healthy original with UNKNOWN or checker hold needs a decision', input: { ordinary: false, active: false, inspection: false, dispatching: false, decision: true }, want: 'awaiting-decision' },
  { label: 'idle healthy checkpoint still awaits reconciliation', input: { ordinary: false, active: false, inspection: false, dispatching: false, decision: false }, want: 'recovering' },
]) test(`recovery hold contract: ${row.label}`, () => assert.equal(recoveryKind(row.input), row.want));

test('an ordinary producer checkpoint is progress; a resumed carrier and a damaged idle turn are recovery', async () => {
  const summary = { id: 'thread', projectId: 'project', title: 'Work', running: true, pinned: false, unread: false, archived: false, updatedAt: '' };
  const turn: Turn = { id: 'turn', side: false, status: 'running', user: { text: '', attachments: [], at: '' }, work: { startedAt: '', steps: [], harness: 'controlled' }, effects: [] };
  const store = () => ({ load: () => ({ files: [], sources: [] }), save: async () => {}, clear: async () => {} });
  assert.equal(recoverySummary(summary, [turn], store, true).recoveryHold, undefined);
  turn.interrupted = true;
  assert.equal(recoverySummary(summary, [turn], store, true).recoveryHold?.kind, 'recovering');
  turn.status = 'stopped';
  const link = { system: () => ({}), read: async () => ({ rows: [{ status: 'unknown' }] }) } as unknown as CoreLink;
  const damaged = () => ({ ...store(), load: () => { throw new Error('private parser detail'); } });
  assert.equal((await projectRecoverySummary({ ...summary, running: false }, [turn], damaged, false, link, 'task', async () => 'original')).recoveryHold?.kind, 'inspection');
  assert.equal((await projectRecoverySummary({ ...summary, running: false }, [turn], store, false, link, 'task', async () => { throw new Error('unattributable'); })).recoveryHold?.kind, 'inspection');
});

test('lifecycle refusals distinguish a checkpoint, private custody and a named UNKNOWN receipt', async t => {
  const home = mkdtempSync(join(tmpdir(), 'recovery-retention-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'threads'));
  const turn: Turn = { id: 'turn', side: false, status: 'stopped', user: { text: '', attachments: [], at: '' }, work: { startedAt: '', steps: [], harness: 'controlled' }, effects: [] };
  const thread = { summary: { id: 'thread', projectId: 'project' }, task: 'task', turns: [turn] } as import('../src/composition/thread-journal.ts').StoredThread;
  const path = join(home, 'threads/thread.json'); writeFileSync(path, JSON.stringify(thread));
  let unknown = false;
  const link = { system: () => ({}), read: async () => ({ rows: unknown ? [{ id: 'effect-id', key: 'turn:note.md', run: 'run', status: 'unknown', args: { title: 'note.md' } }] : [] }) } as unknown as CoreLink;
  const store = () => ({ load: () => ({ files: [], sources: [] }), save: async () => {}, clear: async () => {} });
  assert.match((await recoveryRetentionReason(home, link, thread, store))!, /Turn turn.*checkpoint/);
  const empty = () => ({ ...store(), load: () => null });
  writeFileSync(path, JSON.stringify({ ...thread, writeCustody: { broken: true } }));
  assert.match((await recoveryRetentionReason(home, link, thread, empty))!, /private original-write custody/);
  unknown = true;
  const reason = (await recoveryRetentionReason(home, link, thread, empty))!;
  assert.match(reason, /note.md.*turn turn.*UNKNOWN/); assert.match(reason, /effect-id.*Needs you/);
});
