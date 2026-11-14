// File and bookkeeping guard controls only. Actual authority/closure is exercised by the
// public Host/Core tests in managed-paths.test.ts, never established by these fake links.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { linkSync, lstatSync, mkdirSync, renameSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CoreLink } from '../src/composition/core.ts';
import { checkpointRepairNotice, createRecoveryRepair } from '../src/composition/checkpoint-repair.ts';
import { releaseRecoveryBookkeeping } from '../src/composition/thread-custody.ts';
import type { StoredThread } from '../src/composition/thread-journal.ts';
import { sha256 } from '../src/stub/fsx.ts';
import { MaterialStore } from '../src/stub/material.ts';

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'person-recovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'threads')); mkdirSync(join(home, 'checkpoints'));
  const thread: StoredThread = { summary: { id: 'thread', projectId: 'project', title: 'Recovery', running: false, unread: false, archived: false, pinned: false, updatedAt: '2026-11-06T00:00:00Z' }, task: 'task', turns: [{ id: 'turn', side: false, status: 'stopped', user: { text: 'Old work', attachments: [], at: '2026-11-06T00:00:00Z' }, work: { startedAt: '2026-11-06T00:00:00Z', steps: [], harness: 'controlled' }, effects: [] }], sideTurns: [], clientKeys: ['key'] };
  const path = join(home, 'threads/thread.json'), checkpoint = join(home, 'checkpoints/turn.json');
  const original = { ...thread, writeCustody: { broken: 'Original private bytes are retained.' } };
  writeFileSync(path, JSON.stringify(original));
  return { home, thread, path, checkpoint, original, context: { home, thread: 'thread', project: 'project', task: 'task' }, material: new MaterialStore(home, {}, () => {}) };
}
for (const kind of ['symlink', 'hardlink'] as const) test(`${kind} recovery data cannot copy another file into inspection material`, async t => {
  const s = setup(t), target = join(s.home, 'unrelated.txt'); writeFileSync(target, 'Unrelated canary data.');
  if (kind === 'symlink') symlinkSync(target, s.checkpoint); else linkSync(target, s.checkpoint);
  assert.equal(checkpointRepairNotice(s.home, 'turn'), undefined);
  let reads = 0;
  const core = { read: async () => { reads++; return { rows: [] }; } } as unknown as CoreLink;
  const repair = createRecoveryRepair({ registerCarrier: () => {}, home: s.home, core: async () => core, material: s.material, thread: () => s.thread, running: new Map(), busy: () => false,
    store: () => ({ load: () => null, save: async () => {}, clear: async () => {} }), closed: async () => {}, save: async () => {}, changed: () => {} });
  const result = await repair({ threadId: 'thread', turnId: 'turn', revision: (() => { const stat = lstatSync(s.checkpoint); return sha256(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])); })() });
  assert.ok(!result.ok); assert.equal(reads, 0); assert.deepEqual(s.material.list('project', true), []);
  assert.equal(readFileSync(target, 'utf8'), 'Unrelated canary data.');
});

test('a stale recovery revision changes no Core or local data', async t => {
  const s = setup(t); writeFileSync(s.checkpoint, 'First damaged data.');
  const before = checkpointRepairNotice(s.home, 'turn')!; writeFileSync(s.checkpoint, 'Different damaged data, with a different size.');
  let reads = 0;
  const core = { read: async () => { reads++; return { rows: [] }; } } as unknown as CoreLink;
  const repair = createRecoveryRepair({ registerCarrier: () => {}, home: s.home, core: async () => core, material: s.material, thread: () => s.thread, running: new Map(), busy: () => false,
    store: () => ({ load: () => null, save: async () => {}, clear: async () => {} }), closed: async () => {}, save: async () => {}, changed: () => {} });
  const result = await repair({ threadId: 'thread', turnId: 'turn', revision: before.revision });
  assert.ok(!result.ok); assert.equal(result.reason, 'STALE_BASE'); assert.equal(reads, 0);
  assert.deepEqual(s.material.list('project', true), []);
});

for (const state of ['task-missing', 'run-open', 'unknown', 'held', 'final'] as const) test(`person bookkeeping release preserves ${state} Core boundary`, async t => {
  const s = setup(t), before = readFileSync(s.path, 'utf8'); let preserved: unknown;
  const core = { system: () => ({}), read: async (_: unknown, sql: string) => ({ rows: sql.includes('FROM app.tasks') ? state === 'task-missing' ? [] : [{ id: 'task' }]
    : sql.includes('SELECT status FROM app.runs') ? [{ status: state === 'run-open' ? 'running' : 'failed' }]
    : [{ status: state === 'unknown' ? 'unknown' : state === 'held' ? 'awaiting_checker' : 'cancelled' }] }) } as unknown as CoreLink;
  const result = await releaseRecoveryBookkeeping(s.context, core, () => {}, value => { preserved = value; return { materialId: 'inspection-copy' }; });
  assert.deepEqual(preserved, s.original.writeCustody, 'even unresolved data remains available to the person');
  assert.equal(result, state === 'final');
  if (state !== 'final') assert.equal(readFileSync(s.path, 'utf8'), before, 'no active key is reset without final Core facts');
  else {
    const stored = JSON.parse(readFileSync(s.path, 'utf8'));
    assert.deepEqual(stored.writeCustody, { version: 1, writes: {}, unproposed: {}, inspectionCopy: 'inspection-copy' });
  }
});

test('failure to keep private metadata cannot reset it', async t => {
  const s = setup(t), before = readFileSync(s.path, 'utf8');
  const core = { system: () => ({}), read: async () => ({ rows: [] }) } as unknown as CoreLink;
  await assert.rejects(releaseRecoveryBookkeeping(s.context, core, () => {}, () => { throw new Error('Synthetic storage failure.'); }), /storage failure/);
  assert.equal(readFileSync(s.path, 'utf8'), before);
});


test('a checkpoint swapped between lstat and open cannot copy the replacement with a valid shown revision', async t => {
  const s = setup(t); writeFileSync(s.checkpoint, 'Original damaged checkpoint.');
  const shown = checkpointRepairNotice(s.home, 'turn')!;
  const open = fs.openSync;
  let swapped = false, reads = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (!swapped && args[0] === s.checkpoint) {
      swapped = true; renameSync(s.checkpoint, s.checkpoint + '.before'); writeFileSync(s.checkpoint, 'Unrelated replacement bytes.');
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const core = { system: () => ({}), read: async () => { reads++; return { rows: [] }; } } as unknown as CoreLink;
  const repair = createRecoveryRepair({ registerCarrier: () => {}, home: s.home, core: async () => core, material: s.material, thread: () => s.thread, running: new Map(), busy: () => false,
    store: () => ({ load: () => null, save: async () => {}, clear: async () => {} }), closed: async () => {}, save: async () => {}, changed: () => {} });
  const result = await repair({ threadId: 'thread', turnId: 'turn', revision: shown.revision });
  assert.equal(swapped, true); assert.ok(!result.ok); assert.equal(reads, 0); assert.deepEqual(s.material.list('project', true), []);
});

for (const blocked of ['summary', 'carrier', 'linked-work', 'foreign-worker', 'changed-during-core-read'] as const) test(`person recovery preserves original state for ${blocked}`, async t => {
  const s = setup(t); writeFileSync(s.checkpoint, 'Original damaged checkpoint.');
  const shown = checkpointRepairNotice(s.home, 'turn')!, before = readFileSync(s.path, 'utf8');
  const running = new Map<string, AbortController>();
  if (blocked === 'summary') s.thread.summary.running = true;
  if (blocked === 'carrier') running.set('thread', new AbortController());
  let reads = 0, cleared = false, finished = false;
  const core = { id: { agent: 'own' }, system: () => ({}), read: async (_: unknown, sql: string) => {
    reads++;
    if (blocked === 'changed-during-core-read' && reads === 1) writeFileSync(s.checkpoint, 'Changed after the person selected it, while Core was being read.');
    return { rows: sql.includes('agent_id AS agent') && blocked === 'foreign-worker' ? [{ id: 'foreign', piece: 'piece', agent: 'other' }]
      : sql.includes('FROM app.tasks') ? [{ id: 'task' }] : [] };
  }, reclaimRun: async () => { finished = true; throw new Error('Must not reclaim a foreign worker.'); } } as unknown as CoreLink;
  const repair = createRecoveryRepair({ registerCarrier: () => {}, home: s.home, core: async () => core, material: s.material, thread: () => s.thread, running, busy: () => blocked === 'linked-work',
    store: () => ({ load: () => null, save: async () => {}, clear: async () => { cleared = true; } }), closed: async () => {}, save: async () => {}, changed: () => {} });
  const result = await repair({ threadId: 'thread', turnId: 'turn', revision: shown.revision });
  assert.ok(!result.ok || !result.value.cleared); assert.equal(cleared, false); assert.equal(finished, false);
  assert.equal(readFileSync(s.path, 'utf8'), before, 'original private bookkeeping is not reset');
  if (['summary', 'carrier', 'linked-work'].includes(blocked)) { assert.equal(reads, 0); assert.deepEqual(s.material.list('project', true), []); }
  else assert.equal(s.material.list('project', true).length, 1, 'the already-kept original checkpoint remains inspection data only');
});


test('person recovery notifies consumers while its reservation is busy and again after release', async t => {
  const s = setup(t); writeFileSync(s.checkpoint, 'Original damaged checkpoint.');
  const shown = checkpointRepairNotice(s.home, 'turn')!, running = new Map<string, AbortController>(), states: boolean[] = [];
  const core = { id: { agent: 'own' }, system: () => ({}), read: async (_: unknown, sql: string) => ({ rows: sql.includes('FROM app.tasks') ? [] : [] }) } as unknown as CoreLink;
  const repair = createRecoveryRepair({ registerCarrier: () => {}, home: s.home, core: async () => core, material: s.material, thread: () => s.thread, running, busy: () => false,
    store: () => ({ load: () => null, save: async () => {}, clear: async () => {} }), closed: async () => {}, save: async () => { states.push(running.has('thread')); }, changed: () => {} });
  const result = await repair({ threadId: 'thread', turnId: 'turn', revision: shown.revision });
  assert.ok(result.ok && !result.value.cleared);
  assert.deepEqual(states, [true, false], 'other clients refresh recovering before Core reads and refresh the retained hold after the person action ends');
});
