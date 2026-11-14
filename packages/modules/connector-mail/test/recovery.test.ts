import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeMailbox } from '../src/index.ts';
import type { MailRequest } from '@backbone-next/platform/ports/mail';

for (const destination of ['Archive', 'Spam', 'Trash']) {
  test(`F8: ${destination} has a confirmed, version-bound restoration round trip`, async () => {
    const box = new FakeMailbox({ writes: 'open' });
    const before = await box.read('m01');
    const labels = await box.labels();
    const change = box.classify({ op: 'modify', id: before.id, version: before.version, add: destination === 'Archive' ? [] : [destination === 'Spam' ? 'SPAM' : 'TRASH'], remove: ['INBOX'] }, labels);
    assert.ok(change.ok);
    const result = await box.apply(change.value);
    assert.equal(result.outcome, 'succeeded');
    const undo = (result as typeof result & { undo?: MailRequest }).undo;
    assert.ok(undo && undo.op === 'modify', 'a confirmed write supplies its executable inverse');
    assert.equal(undo.version, (await box.read('m01')).version);
    const restoration = box.classify(undo, labels);
    assert.ok(restoration.ok, restoration.ok ? '' : restoration.reason);
    assert.equal((await box.apply(restoration.value)).outcome, 'succeeded');
    assert.deepEqual((await box.read('m01')).labels.sort(), before.labels.sort());
  });
}

test('F8: recovery preserves pre-existing labels and refuses a stale inverse', async () => {
  const box = new FakeMailbox({ writes: 'open' });
  const labels = await box.labels();
  const apply = async (request: MailRequest) => { const c = box.classify(request, labels); assert.ok(c.ok); return box.apply(c.value); };
  let m = await box.read('m01');
  await apply({ op: 'modify', id: m.id, version: m.version, add: ['Label_billing'], remove: [] });
  m = await box.read('m01');
  const result = await apply({ op: 'modify', id: m.id, version: m.version, add: ['Label_billing'], remove: ['INBOX'] });
  const undo = (result as typeof result & { undo?: MailRequest }).undo;
  assert.ok(undo && undo.op === 'modify');
  assert.ok(!undo.remove.includes('Label_billing'));
  const newer = await box.read('m01');
  await apply({ op: 'modify', id: newer.id, version: newer.version, add: ['Label_team'], remove: [] });
  assert.equal((await apply(undo)).outcome, 'failed');
  assert.ok((await box.read('m01')).labels.includes('Label_team'));
});
