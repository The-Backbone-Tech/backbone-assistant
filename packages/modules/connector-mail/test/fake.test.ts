// Characterisation of the sample mailbox: what it holds, how its versions move, what each scripted
// fault does to the provider's truth as against what the caller is told, what the probe can prove,
// that writes are gated unless a test opens them, and that the entitlement check fails closed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createMailConnector, FakeMailbox, FIXTURE_DIR, ProviderTimeout, ProviderUnknown, readSeed, readTask, SCOPES } from '../src/index.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'backbone-mailbox-'));
  dirs.push(d);
  return d;
};
const modify = async (box: FakeMailbox, id: string, add: string[], remove: string[] = []) => {
  const m = await box.read(id);
  const c = box.classify({ op: 'modify', id, version: m.version, add, remove }, await box.labels());
  if (!c.ok) throw new Error(c.reason);
  return { ...c.value, operationKey: randomUUID() };
};

test('the fixture: at least 40 messages, every one labelled, and a task whose categories the labels use', () => {
  const seed = readSeed();
  const labels = JSON.parse(readFileSync(join(FIXTURE_DIR, 'labels.json'), 'utf8'));
  const task = readTask();
  assert.ok(seed.messages.length >= 40);
  assert.deepEqual(Object.keys(labels.messages).sort(), seed.messages.map((m) => m.id).sort());
  const categories = new Set(task.categories.map((c) => c.id));
  const names = new Set(seed.labels.map((l) => l.name));
  for (const [id, l] of Object.entries<{ category: string; urgency: string; label: string }>(labels.messages)) {
    assert.ok(categories.has(l.category), `${id}: ${l.category}`);
    assert.ok(['urgent', 'high', 'normal', 'low'].includes(l.urgency), id);
    assert.ok(l.label === 'none' || names.has(l.label), `${id}: ${l.label}`);
  }
  assert.ok(seed.messages.some((m) => m.body.includes(labels.canary.text)));
});

test('the inbox lists oldest first with versions; new mail arrives with deliver() and wakes watchers', async () => {
  const box = new FakeMailbox({ initial: 3 });
  const first = await box.list();
  assert.deepEqual(first.messages.map((m) => m.id), ['m01', 'm02', 'm03']);
  let woke = 0;
  const stop = box.watch(() => woke++);
  assert.equal(box.deliver(2), 2);
  assert.equal(woke, 1);
  const next = await box.list(first.cursor);
  assert.deepEqual(next.messages.map((m) => m.id), ['m04', 'm05']);
  stop();
  box.deliver(1);
  assert.equal(woke, 1);
});

test('writes are gated by default: apply refuses and the provider is untouched', async () => {
  const box = new FakeMailbox();
  const op = await modify(box, 'm01', ['Label_billing']);
  await assert.rejects(box.apply(op), /gated/);
  assert.equal(box.truth.applied.length, 0);
  assert.deepEqual(box.truth.messages.find((m) => m.id === 'm01')!.labels, ['INBOX', 'UNREAD']);
});

test('an open write applies once, bumps the version, and a stale version is refused by the provider', async () => {
  const box = new FakeMailbox({ writes: 'open' });
  const op = await modify(box, 'm01', ['Label_billing']);
  assert.equal((await box.apply(op)).outcome, 'succeeded');
  const m = await box.read('m01');
  assert.deepEqual(m.labels, ['INBOX', 'UNREAD', 'Label_billing']);
  assert.notEqual(m.version, op.args.version);
  // The same change again names the version it was read at, which has moved on.
  assert.equal((await box.apply(op)).outcome, 'failed');
  assert.equal(box.truth.applied.length, 1);
});

test('a timeout after commit: the caller is told nothing, the provider applied it, and the probe proves it', async () => {
  const box = new FakeMailbox({ writes: 'open', faults: [{ at: 'modify', kind: 'timeout-after-commit' }] });
  const op = await modify(box, 'm01', ['Label_billing']);
  await assert.rejects(box.apply(op), ProviderTimeout);
  assert.equal(box.truth.applied.length, 1);
  assert.deepEqual(await box.probe(op).then((p) => p.landed), true);
});

test('a timeout before commit: nothing applied, and the probe proves it did not land', async () => {
  const box = new FakeMailbox({ writes: 'open', faults: [{ at: 'modify', kind: 'timeout-before-commit' }] });
  const op = await modify(box, 'm01', ['Label_billing']);
  await assert.rejects(box.apply(op), ProviderTimeout);
  assert.equal(box.truth.applied.length, 0);
  assert.equal((await box.probe(op)).landed, false);
});

test('a 5xx after commit is not a denial: applied, and only the probe can tell', async () => {
  const box = new FakeMailbox({ writes: 'open', faults: [{ at: 'modify', kind: 'unknown-after-commit' }] });
  const op = await modify(box, 'm05', ['Label_newsletters'], ['INBOX']);
  await assert.rejects(box.apply(op), ProviderUnknown);
  assert.equal((await box.probe(op)).landed, true);
});

test('a probe that sees the message moved on without the change cannot tell', async () => {
  const box = new FakeMailbox({ writes: 'open', faults: [{ at: 'modify', kind: 'timeout-before-commit' }] });
  const op = await modify(box, 'm01', ['Label_billing']);
  await assert.rejects(box.apply(op));
  const other = await modify(box, 'm01', ['Label_team']);
  await box.apply(other);
  assert.equal((await box.probe(op)).landed, null);
});

test('the state survives a restart of the caller, as a provider would', async () => {
  const dir = tmp();
  const a = createMailConnector({ home: dir }) as FakeMailbox;
  const listed = await a.list();
  const b = createMailConnector({ home: dir }) as FakeMailbox;
  assert.deepEqual((await b.list()).messages, listed.messages);
  assert.equal(b.writes, 'gated');
  assert.throws(() => createMailConnector({ home: dir, provider: 'gmail' }), /No gmail adapter is built yet/);
});

test('the entitlement check fails closed when the account cannot read mail, and names what is missing', async () => {
  assert.equal((await new FakeMailbox().entitlement()).ok, true);
  const none = await new FakeMailbox({ scopes: [] }).entitlement();
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing, ['permission to read mail', 'permission to change labels (asked for when label and move are signed)']);
  const readOnly = await new FakeMailbox({ scopes: [SCOPES.read] }).entitlement();
  assert.equal(readOnly.ok, true);
  assert.equal(readOnly.missing.length, 1);
});

test('nothing in the connector sends: the outbox stays empty whatever is asked', async () => {
  const box = new FakeMailbox({ writes: 'open' });
  for (const r of [{ op: 'send', to: ['x@y.example'] }, { op: 'forward', id: 'm08', to: 'verification@ventura-payments.example' }]) {
    assert.equal(box.classify(r as never, await box.labels()).ok, false);
  }
  assert.deepEqual(box.truth.outbox, []);
});
