import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { approvalFixture, approvalServer } from './connector-approval-fixture.ts';
import { value } from './helpers.ts';

for (const signed of [false, true]) test(`UNKNOWN shows retained dispatch time, statement and ${signed ? 'signature identity' : 'person release'} without resolving`, async t => {
  const f = await approvalFixture(t); if (signed) value(await f.sign('send_note'));
  const args = { body: 'The exact original statement', unknown: true };
  await f.call('send_note', args); const first = f.service.list().held[0];
  if (!signed) value(await f.service.decide(first.effect, first.argsHash, 'release'));
  const h = f.service.list().held[0]; assert.equal(h.state, 'unknown');
  assert.equal(h.statement, `Call send_note on records with exactly: ${JSON.stringify(args)}`);
  assert.match(h.dispatchedAt!, /^\d{4}-\d\d-\d\dT/); assert.ok(h.dispatchReceipt?.hash);
  if (signed) assert.equal(h.standingSignatureId, f.read().servers[approvalServer].tools.send_note.standing.id);
  else { assert.equal(h.standingSignatureId, undefined); assert.ok(h.personReleasedAt); }
  const dispatch = (await f.link.read<{ seq: string; hash: string; at: string }>(f.link.person(), "SELECT seq::text, hash, at::text FROM app.ledger WHERE subject=$1 AND entry_type='effect.dispatched'", [h.effect])).rows[0];
  assert.deepEqual(h.dispatchReceipt, { seq: dispatch.seq, hash: dispatch.hash }); assert.equal(h.dispatchedAt, new Date(dispatch.at).toISOString());
  value(await f.service.resolveUnknown(h.effect, h.argsHash, 'keep_closed')); await f.reopen();
  const retained = f.service.list().held[0]; assert.equal(retained.state, 'unknown'); assert.equal(retained.dispatchedAt, h.dispatchedAt);
  assert.equal(retained.standingSignatureId, h.standingSignatureId); assert.equal(retained.statement, h.statement);
  assert.equal((await f.link.read<{ status: string }>(f.link.person(), 'SELECT status FROM app.effects WHERE id=$1', [h.effect])).rows[0].status, 'unknown');
  assert.equal(f.calls().length, 1);
});

test('listing a historical unknown invents no dispatch time or receipt and performs no Core work', async t => {
  const f = await approvalFixture(t); value(await f.sign('send_note')); await f.call('send_note', { unknown: true });
  const s = f.read(); delete s.held[0].dispatchedAt; delete s.held[0].dispatchReceipt; writeFileSync(f.file, JSON.stringify(s));
  const bytes = JSON.stringify(f.read()); let opens = 0; f.options.link = async () => { opens++; throw Error('Backend text must never be shown'); };
  const h = f.service.list().held[0]; assert.equal(h.dispatchedAt, undefined); assert.equal(h.dispatchReceipt, undefined);
  assert.equal(opens, 0); assert.equal(JSON.stringify(f.read()), bytes); assert.equal(f.calls().length, 1);
});

test('blocked plugin history with dispatch evidence still withholds its name, ID, arguments and statement', async t => {
  const f = await approvalFixture(t); value(await f.sign('send_note')); await f.call('send_note', { unknown: true });
  const s = f.read(), secret = 'opaque-blocked-history-credential-131', h = s.held[0];
  h.serverId = `codex-plugin:${secret}`; h.serverName = secret; h.tool = secret; h.args = { value: secret }; h.statement = secret; h.detail = secret;
  writeFileSync(f.file, JSON.stringify(s)); const shown = f.service.list().held[0];
  assert.equal(JSON.stringify(shown).includes(secret), false); assert.ok(shown.dispatchedAt); assert.ok(shown.standingSignatureId);
  const refused = await f.service.unknownQuestion(h.effect, h.argsHash); assert.equal(refused.ok, false); assert.equal(JSON.stringify(refused).includes(secret), false);
});

test('person resolution refuses edited evidence rather than settling a different statement', async t => {
  const f = await approvalFixture(t); value(await f.sign('send_note')); await f.call('send_note', { unknown: true });
  const s = f.read(), h = s.held[0]; h.statement = 'A different statement'; writeFileSync(f.file, JSON.stringify(s));
  assert.equal((await f.service.resolveUnknown(h.effect, h.argsHash, 'happened')).ok, false);
  assert.equal((await f.link.read<{ status: string }>(f.link.person(), 'SELECT status FROM app.effects WHERE id=$1', [h.effect])).rows[0].status, 'unknown');
  assert.equal(f.calls().length, 1);
});
