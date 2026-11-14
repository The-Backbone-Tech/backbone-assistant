import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { MaterialStore } from '../src/stub/material.ts';

const WORKSPACE = 'workspace-a';
function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'material-withdrawal-outbox-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new MaterialStore(home, {}, () => {});
  const original = store.create('project-a', 'source.md', 'text/markdown', Buffer.from('original bytes'), 'original', 'person');
  return { home, store, original, reopen: () => new MaterialStore(home, {}, () => {}) };
}

test('withdrawal delivery identity survives reopen without losing versions or receipts', (t) => {
  const { store, original, reopen } = setup(t);
  assert.deepEqual(store.pendingWithdrawals(WORKSPACE), []);
  const withdrawn = store.withdraw(original.id);
  const [event] = store.pendingWithdrawals(WORKSPACE);
  assert.ok(event);
  assert.match(event.id, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...event, id: undefined }, { id: undefined, materialId: original.id, projectId: 'project-a', version: 1, sequence: 1, at: withdrawn.withdrawals![0].at });
  assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), [event]);
  assert.deepEqual(reopen().load(original.id)!.versions, original.versions);
  assert.equal(Buffer.from(reopen().bytes(original.id, 1)).toString(), 'original bytes');
  assert.deepEqual(reopen().available('project-a'), []);
});

test('retrying a withdrawal does not create another event or change its lifecycle', (t) => {
  const { store, original, reopen } = setup(t);
  const first = store.withdraw(original.id);
  assert.deepEqual(store.withdraw(original.id), first);
  assert.deepEqual(reopen().withdraw(original.id), first);
  assert.equal(store.pendingWithdrawals(WORKSPACE).length, 1);
});

test('only the exact event is acknowledged and retries preserve the first receipt', (t) => {
  const { store, original, home, reopen } = setup(t);
  const other = store.create('project-b', 'other.md', 'text/markdown', Buffer.from('other'), 'original', 'person');
  store.withdraw(original.id);
  const [event] = store.pendingWithdrawals(WORKSPACE);
  assert.equal(store.acknowledgeWithdrawal(other.id, event.id, WORKSPACE, 'receipt-a'), false);
  assert.equal(store.acknowledgeWithdrawal(original.id, '0'.repeat(64), WORKSPACE, 'receipt-a'), false);
  assert.equal(store.acknowledgeWithdrawal(original.id, event.id, '', 'receipt-a'), false);
  assert.equal(store.acknowledgeWithdrawal(original.id, event.id, WORKSPACE, '../receipt'), false);
  assert.equal(store.pendingWithdrawals(WORKSPACE).length, 1);
  assert.equal(store.acknowledgeWithdrawal(original.id, event.id, WORKSPACE, 'receipt-a'), true);
  const metadata = readFileSync(join(home, 'material', original.id, 'meta.json'), 'utf8');
  assert.equal(reopen().acknowledgeWithdrawal(original.id, event.id, WORKSPACE, 'receipt-a'), true);
  assert.equal(readFileSync(join(home, 'material', original.id, 'meta.json'), 'utf8'), metadata);
  assert.equal(store.acknowledgeWithdrawal(original.id, event.id, WORKSPACE, 'different-receipt'), false);
  assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), []);
  assert.deepEqual(reopen().pendingWithdrawals('workspace-b'), [event]);
  assert.equal(reopen().load(original.id)!.lifecycle, 1, 'Core acknowledgement is not another person lifecycle act');
});

test('restore and a later withdrawal keep both events and cannot reuse an old acknowledgement', (t) => {
  const { store, original, reopen } = setup(t);
  store.withdraw(original.id);
  const [first] = store.pendingWithdrawals(WORKSPACE);
  store.restore(original.id);
  assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), [first], 'restore never erases an undelivered withdrawal');
  store.withdraw(original.id);
  const events = reopen().pendingWithdrawals(WORKSPACE);
  assert.equal(events.length, 2);
  assert.notEqual(events[0].id, events[1].id);
  assert.equal(events[1].sequence, 2);
  assert.equal(store.acknowledgeWithdrawal(original.id, first.id, WORKSPACE, 'receipt-first'), true);
  assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), [events[1]]);
  assert.equal(store.load(original.id)!.withdrawals!.length, 2);
  assert.ok(store.load(original.id)!.withdrawals![0].restoredAt);
});

test('legacy history is pending, and a copied acknowledgement cannot cover another workspace', (t) => {
  const { store, original, home, reopen } = setup(t);
  const meta = { ...original, hidden: true, withdrawals: [{ at: '2026-01-01T00:00:00.000Z', version: 1 }] };
  writeFileSync(join(home, 'material', original.id, 'meta.json'), JSON.stringify(meta));
  const [legacy] = reopen().pendingWithdrawals(WORKSPACE);
  assert.ok(legacy);
  assert.equal(store.acknowledgeWithdrawal(original.id, legacy.id, WORKSPACE, 'legacy-receipt'), true);
  assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), []);
  assert.deepEqual(reopen().pendingWithdrawals('workspace-b'), [legacy]);
  assert.deepEqual(reopen().load(original.id)!.versions, original.versions);
});

test('an incomplete receipt remains pending and a receipt copied to another material is not accepted', (t) => {
  const { store, original, home, reopen } = setup(t);
  store.withdraw(original.id);
  const [event] = store.pendingWithdrawals(WORKSPACE);
  const path = join(home, 'material', original.id, 'meta.json');
  const incomplete = JSON.parse(readFileSync(path, 'utf8'));
  incomplete.withdrawals[0].coreAcknowledgements = [{ event: event.id, workspace: WORKSPACE }];
  writeFileSync(path, JSON.stringify(incomplete));
  assert.deepEqual(reopen().pendingWithdrawals(WORKSPACE), [event], 'metadata without a receipt is not a confirmation');
  assert.equal(store.acknowledgeWithdrawal(original.id, event.id, WORKSPACE, 'receipt-a'), true);
  const other = store.create('project-b', 'other.md', 'text/markdown', Buffer.from('other'), 'original', 'person');
  store.withdraw(other.id);
  const otherPath = join(home, 'material', other.id, 'meta.json');
  const copied = JSON.parse(readFileSync(otherPath, 'utf8'));
  copied.withdrawals[0].coreAcknowledgements = store.load(original.id)!.withdrawals![0].coreAcknowledgements;
  writeFileSync(otherPath, JSON.stringify(copied));
  const pending = reopen().pendingWithdrawals(WORKSPACE);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].materialId, other.id);
});

test('SIGKILL after withdrawal metadata commits leaves an undelivered event and recoverable projection', async (t) => {
  const { store, original, home, reopen } = setup(t);
  const projected = join(home, 'source.md');
  writeFileSync(projected, 'original bytes');
  const child = spawn(process.execPath, [new URL('fixtures/withdrawal-outbox-crash.ts', import.meta.url).pathname, home, original.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += String(chunk); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.signal, 'SIGKILL', errors);
  const recovered = reopen();
  const [event] = recovered.pendingWithdrawals(WORKSPACE);
  assert.ok(event);
  assert.equal(event.materialId, original.id);
  assert.equal(recovered.load(original.id)!.hidden, true);
  assert.deepEqual(recovered.available('project-a'), []);
  assert.equal(Buffer.from(store.bytes(original.id, 1)).toString(), 'original bytes');
  const folder = new MaterialStore(home, {}, () => {}, () => projected);
  folder.settleProjections();
  assert.deepEqual(folder.pendingWithdrawals(WORKSPACE), [event]);
  assert.equal(folder.load(original.id)!.projecting, undefined);
});
