// Offline store contracts: a terminal Core conflict is evidence, never an acknowledgement or grant.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { withHomeLock } from '../src/composition/home-lock.ts';
import { MaterialStore } from '../src/stub/material.ts';

const WORKSPACE = 'workspace-a';
const OTHER = 'workspace-b';
const AT = '2026-11-09T12:00:00.000Z';
async function fixture(t: TestContext, run: (f: {
  home: string; store: MaterialStore; source: ReturnType<MaterialStore['create']>;
  reopen(): MaterialStore; metadata(): string; putConflicts(value: unknown): void;
}) => Promise<void> | void) {
  const home = mkdtempSync(join(tmpdir(), 'material-withdrawal-conflicts-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new MaterialStore(home, {}, () => {});
  await withHomeLock(home, async () => {
    const source = store.create('project-a', 'source.md', 'text/markdown', Buffer.from('immutable original bytes'), 'original', 'person');
    const path = join(home, 'material', source.id, 'meta.json');
    await run({ home, store, source, reopen: () => new MaterialStore(home, {}, () => {}),
      metadata: () => readFileSync(path, 'utf8'),
      putConflicts(value) {
        const entry = JSON.parse(readFileSync(path, 'utf8'));
        entry.withdrawals[0].coreConflicts = value;
        writeFileSync(path, JSON.stringify(entry));
      },
    });
  });
}

test('only an exact committed withdrawal can acquire conflict evidence, which remains pending rather than acknowledged', async (t) => fixture(t, ({ store, source, metadata }) => {
  assert.equal(store.recordWithdrawalConflict(source.id, '0'.repeat(64), WORKSPACE), false);
  store.withdraw(source.id);
  const [event] = store.pendingWithdrawals(WORKSPACE);
  const other = store.create('project-b', 'other.md', 'text/markdown', Buffer.from('other bytes'), 'original', 'person');
  const before = metadata();
  for (const [id, key, workspace] of [
    [other.id, event.id, WORKSPACE], ['unknown-material', event.id, WORKSPACE],
    ['../outside', event.id, WORKSPACE], [source.id, '0'.repeat(64), WORKSPACE],
    [source.id, event.id.toUpperCase(), WORKSPACE], [source.id, event.id, ''],
    [source.id, event.id, '../outside'],
  ]) {
    assert.equal(store.recordWithdrawalConflict(id, key, workspace), false);
    assert.equal(store.withdrawalConflict(id, key, workspace), false);
    assert.equal(metadata(), before);
  }
  assert.equal(store.recordWithdrawalConflict(source.id, event.id, WORKSPACE), true);
  assert.equal(store.withdrawalConflict(source.id, event.id, WORKSPACE), true);
  assert.deepEqual(store.withdrawalConflicts(WORKSPACE), [event]);
  assert.deepEqual(store.pendingWithdrawals(WORKSPACE), [event], 'terminal conflict never consumes the durable delivery event');
  assert.deepEqual(store.pendingWithdrawals(WORKSPACE).filter(e => !store.withdrawalConflict(e.materialId, e.id, WORKSPACE)), [], 'the worker can suppress automatic retries without pretending there is an acknowledgement');
}));

test('conflict recording is idempotent across reopen and preserves bytes, lifecycle, availability and exact event identity', async (t) => fixture(t, ({ store, source, reopen, metadata }) => {
  const withdrawn = store.withdraw(source.id);
  const [event] = store.pendingWithdrawals(WORKSPACE);
  assert.equal(store.recordWithdrawalConflict(source.id, event.id, WORKSPACE), true);
  const before = metadata();
  assert.equal(reopen().recordWithdrawalConflict(source.id, event.id, WORKSPACE), true);
  assert.equal(metadata(), before);
  const record = reopen().load(source.id)!;
  assert.equal(record.lifecycle, withdrawn.lifecycle);
  assert.deepEqual(record.versions, source.versions);
  assert.equal(Buffer.from(reopen().bytes(source.id, 1)).toString(), 'immutable original bytes');
  assert.deepEqual(reopen().available(source.projectId), []);
  assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), [event]);
  assert.deepEqual(reopen().withdrawalConflicts(WORKSPACE), [event]);
}));

test('conflicts belong to the exact workspace and cannot be transferred by a copied marker', async (t) => fixture(t, ({ store, source, putConflicts }) => {
  store.withdraw(source.id);
  const [event] = store.pendingWithdrawals(WORKSPACE);
  putConflicts([{ event: event.id, workspace: OTHER, at: AT }]);
  assert.equal(store.withdrawalConflict(source.id, event.id, WORKSPACE), false);
  assert.deepEqual(store.withdrawalConflicts(WORKSPACE), []);
  assert.deepEqual(store.pendingWithdrawals(WORKSPACE), [event]);
  assert.equal(store.withdrawalConflict(source.id, event.id, OTHER), true);
  assert.equal(store.acknowledgeWithdrawal(source.id, event.id, WORKSPACE, 'receipt-a'), true);
  assert.equal(store.recordWithdrawalConflict(source.id, event.id, WORKSPACE), false, 'a confirmed event refuses a later conflict in that workspace');
  assert.equal(store.acknowledgeWithdrawal(source.id, event.id, OTHER, 'receipt-b'), false);
  assert.deepEqual(store.pendingWithdrawals(WORKSPACE), []);
  assert.deepEqual(store.pendingWithdrawals(OTHER), [event]);
}));

test('a confirmed event refuses conflict evidence; a recorded conflict refuses every late automatic acknowledgement', async (t) => fixture(t, ({ store, source, metadata }) => {
  store.withdraw(source.id);
  const [first] = store.pendingWithdrawals(WORKSPACE);
  assert.equal(store.acknowledgeWithdrawal(source.id, first.id, WORKSPACE, 'receipt-first'), true);
  const confirmed = metadata();
  assert.equal(store.recordWithdrawalConflict(source.id, first.id, WORKSPACE), false);
  assert.equal(metadata(), confirmed);
  store.restore(source.id); store.withdraw(source.id);
  const [second] = store.pendingWithdrawals(WORKSPACE);
  assert.equal(second.sequence, 2);
  assert.equal(store.recordWithdrawalConflict(source.id, second.id, WORKSPACE), true);
  const conflicted = metadata();
  for (const receipt of ['receipt-late', 'receipt-first']) {
    assert.equal(store.acknowledgeWithdrawal(source.id, second.id, WORKSPACE, receipt), false);
    assert.equal(metadata(), conflicted);
  }
  assert.equal(store.acknowledgeWithdrawal(source.id, first.id, WORKSPACE, 'receipt-first'), true);
  assert.deepEqual(store.withdrawalConflicts(WORKSPACE), [second]);
  assert.deepEqual(store.pendingWithdrawals(WORKSPACE), [second]);
}));

test('restore and a later withdrawal retain the earlier terminal event without applying it to the new generation', async (t) => fixture(t, ({ store, source, reopen }) => {
  store.withdraw(source.id);
  const [first] = store.pendingWithdrawals(WORKSPACE);
  store.recordWithdrawalConflict(source.id, first.id, WORKSPACE);
  const restored = store.restore(source.id);
  assert.equal(restored.id, source.id);
  assert.equal(reopen().withdrawalConflict(source.id, first.id, WORKSPACE), true);
  assert.equal(reopen().available(source.projectId).length, 1, 'conflict evidence never decides local restored access');
  store.withdraw(source.id);
  const events = reopen().pendingWithdrawals(WORKSPACE);
  const second = events.find(e => e.sequence === 2)!;
  assert.notEqual(second.id, first.id);
  assert.equal(reopen().withdrawalConflict(source.id, second.id, WORKSPACE), false);
  assert.equal(store.acknowledgeWithdrawal(source.id, second.id, WORKSPACE, 'receipt-second'), true);
  assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), [first]);
  assert.deepEqual(reopen().withdrawalConflicts(WORKSPACE), [first]);
  const current = reopen().load(source.id)!;
  assert.equal(current.withdrawals!.length, 2);
  assert.ok(current.withdrawals![0].restoredAt);
  assert.deepEqual(current.versions, source.versions);
}));

test('malformed conflict collections and invalid marker dates do not hide pending work or rewrite metadata on read', async (t) => fixture(t, ({ store, source, reopen, metadata, putConflicts }) => {
  store.withdraw(source.id);
  const [event] = store.pendingWithdrawals(WORKSPACE);
  for (const markers of [null, {}, 'not markers', 42, [null, false, 17, {},
    { event: event.id, workspace: WORKSPACE },
    { event: event.id, workspace: WORKSPACE, at: null },
    { event: event.id, workspace: WORKSPACE, at: 123 },
    { event: event.id, workspace: WORKSPACE, at: 'not-a-date' },
    { event: event.id, workspace: WORKSPACE, at: 'Infinity' },
    { event: '0'.repeat(64), workspace: WORKSPACE, at: AT },
    { event: event.id, workspace: '../outside', at: AT },
  ]]) {
    putConflicts(markers);
    const before = metadata();
    assert.equal(reopen().withdrawalConflict(source.id, event.id, WORKSPACE), false);
    assert.deepEqual(reopen().withdrawalConflicts(WORKSPACE), []);
    assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), [event]);
    assert.equal(metadata(), before);
  }
  putConflicts([null, { event: event.id, workspace: WORKSPACE, at: AT }, { event: 'stale', workspace: WORKSPACE, at: AT }]);
  assert.equal(reopen().withdrawalConflict(source.id, event.id, WORKSPACE), true);
  assert.equal(reopen().acknowledgeWithdrawal(source.id, event.id, WORKSPACE, 'receipt-late'), false);
  assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), [event]);
}));

test('contradictory stored conflict and acknowledgement evidence stays UNKNOWN rather than silently healing', async (t) => fixture(t, ({ home, store, source, metadata, putConflicts }) => {
  store.withdraw(source.id);
  const [event] = store.pendingWithdrawals(WORKSPACE);
  assert.equal(store.acknowledgeWithdrawal(source.id, event.id, WORKSPACE, 'receipt-a'), true);
  // Adverse disk fixture: ordinary serialized methods cannot produce both valid markers.
  putConflicts([{ event: event.id, workspace: WORKSPACE, at: AT }]);
  const before = metadata();
  assert.equal(store.acknowledgeWithdrawal(source.id, event.id, WORKSPACE, 'receipt-a'), false);
  assert.equal(metadata(), before);
  assert.deepEqual(store.withdrawalConflicts(WORKSPACE), [event]);
  assert.deepEqual(store.pendingWithdrawals(WORKSPACE), [event]);
  assert.equal(readFileSync(join(home, 'material', source.id, 'versions', '1'), 'utf8'), 'immutable original bytes');
}));

test('archive-style import cannot carry withdrawal conflicts or confirmations into a new material identity', async (t) => fixture(t, async ({ store, source }) => {
  store.withdraw(source.id);
  const [event] = store.pendingWithdrawals(WORKSPACE);
  store.recordWithdrawalConflict(source.id, event.id, WORKSPACE);
  const layout = { projection: 'managed' as const, original: true, versionAuthors: ['person' as const], withdrawals: store.load(source.id)!.withdrawals };
  const restored = await store.importDocument('project-b', 'restored.md', 'text/markdown', [store.bytes(source.id, 1)], layout);
  assert.equal(restored.ok, true);
  assert.notEqual(restored.value.id, source.id);
  assert.equal(restored.value.withdrawals, undefined);
  store.withdraw(restored.value.id);
  const own = store.pendingWithdrawals(WORKSPACE).find(e => e.materialId === restored.value.id)!;
  assert.equal(store.withdrawalConflict(restored.value.id, own.id, WORKSPACE), false);
  assert.equal(store.acknowledgeWithdrawal(restored.value.id, own.id, WORKSPACE, 'restored-receipt'), true);
  assert.deepEqual(store.withdrawalConflicts(WORKSPACE), [event]);
  assert.deepEqual(store.pendingWithdrawals(WORKSPACE), [event]);
}));
