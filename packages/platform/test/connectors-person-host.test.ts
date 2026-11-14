// The extracted native boundary uses real service/Core receipts, never a renderer-supplied answer basis.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectorPerson } from '../src/composition/connector-person.ts';
import { approvalFixture } from './connector-approval-fixture.ts';
import { value } from './helpers.ts';
for (const answer of ['happened', 'did_not_happen', 'keep_closed'] as const) test(`person Host capability records ${answer} without resending`, async t => {
  const f = await approvalFixture(t); value(await f.sign('send_note')); await f.call('send_note', { unknown: true }); const held = f.service.list().held[0];
  const person = connectorPerson({ connectors: f.service, owner: Promise.resolve(), core: Promise.resolve(f.link), unavailable: () => undefined, enter: () => () => {} });
  assert.equal(value(await person.connectorEffectDecisions.question(held.effect, held.argsHash)).statement, held.statement);
  const receipt = value(await person.connectorEffectDecisions.resolve({ effect: held.effect, argsHash: held.argsHash, answer }));
  assert.equal(receipt.answer, answer); assert.equal(f.calls().length, 1);
  assert.equal((await person.connectorEffectDecisions.question('invalid', held.argsHash)).ok, false);
});

test('closing, read-only and import guards refuse all native grants and unknown decisions before touching Core', async t => {
  const f = await approvalFixture(t), before = f.read();
  for (const reason of ['Closing', 'Read-only', 'Importing']) {
    const person = connectorPerson({ connectors: f.service, owner: Promise.resolve(), core: new Promise(() => {}), unavailable: () => reason, enter: () => { throw Error('must refuse before entering'); } });
    for (const r of [await person.releaseConnectorCall('10000000-0000-4000-8000-000000000001', 'a'.repeat(64)),
      await person.connectorEffectDecisions.question('10000000-0000-4000-8000-000000000001', 'a'.repeat(64)),
      await person.openConnectorDoor('server', 'seal'), await person.signConnectorTool('server', 'tool', 'seal', 'stamp', false),
      await person.endConnectorSignature('server', 'tool')]) assert.equal(r.ok, false);
  }
  assert.deepEqual(f.read(), before);
});

test('native ending waits for ownership but not an unavailable Core; a late close refuses the write', async t => {
  const f = await approvalFixture(t); value(await f.sign('send_note'));
  f.options.link = () => new Promise(() => {});
  const person = connectorPerson({ connectors: f.service, owner: Promise.resolve(), core: new Promise(() => {}), unavailable: () => undefined, enter: () => () => {} });
  assert.deepEqual(value(await person.endConnectorSignature('claude-code:records', 'send_note')), { ended: true });
  assert.equal(f.read().servers['claude-code:records'].tools.send_note.standing, undefined);
  let release!: () => void, closed = false;
  const late = connectorPerson({ connectors: f.service, owner: new Promise<void>(r => { release = r; }), core: Promise.resolve(), unavailable: () => closed ? 'Closing' : undefined, enter: () => () => {} });
  const ending = late.endConnectorSignature('claude-code:records', 'draft_note'); closed = true; release(); assert.equal((await ending).ok, false);
});
