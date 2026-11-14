import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approvalFixture, approvalServer } from './connector-approval-fixture.ts';
import { value } from './helpers.ts';

for (const name of ['__proto__', 'constructor', 'toString']) test(`a missing ${name} tool never reaches Object.prototype`, async t => {
  const f = await approvalFixture(t), before = Object.getOwnPropertyDescriptors(Object.prototype);
  assert.equal((await f.service.set(approvalServer, { tool: { name, enabled: true } })).ok, false);
  assert.equal(f.service.toolView(approvalServer, name), null); assert.equal(f.service.enableStamp(approvalServer, name), null);
  assert.equal((await f.service.endStoredSignature(approvalServer, name)).ok, false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
});

test('a real own __proto__ tool is listed, enabled and signed without prototype mutation', async t => {
  const f = await approvalFixture(t, ['__proto__']), before = Object.getOwnPropertyDescriptors(Object.prototype);
  assert.equal(Object.hasOwn(f.read().servers[approvalServer].tools, '__proto__'), true);
  assert.equal((await f.call('__proto__', { text: 'Own tool' })).outcome, 'HELD');
  value(await f.sign('__proto__')); assert.equal((await f.call('__proto__', { text: 'Signed own tool' })).outcome, 'SENT');
  assert.deepEqual(f.calls(), [{ name: '__proto__', arguments: { text: 'Signed own tool' } }]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
});

test('a supplied enable stamp is checked against choices under change; absence remains compatible', async t => {
  const f = await approvalFixture(t);
  value(await f.service.set(approvalServer, { tool: { name: 'draft_note', enabled: false } }));
  const before = f.service.enableStamp(approvalServer, 'draft_note')!;
  value(await f.service.set(approvalServer, { tool: { name: 'draft_note', override: 'effect' } }));
  assert.equal((await f.service.set(approvalServer, { enableStamp: before, tool: { name: 'draft_note', enabled: true } })).ok, false);
  assert.equal(f.read().servers[approvalServer].tools.draft_note.enabled, false);
  const current = f.service.enableStamp(approvalServer, 'draft_note')!;
  value(await f.service.set(approvalServer, { enableStamp: current, tool: { name: 'draft_note', enabled: true } }));
  value(await f.service.set(approvalServer, { tool: { name: 'draft_note', enabled: false } }));
  value(await f.service.set(approvalServer, { tool: { name: 'draft_note', enabled: true } }));
});

test('an enable stamp covers complete launch values and does not survive a new Host question owner', async t => {
  const f = await approvalFixture(t), stamp = f.service.enableStamp(approvalServer)!;
  const config = join(f.person, '.claude.json'), s = JSON.parse(readFileSync(config, 'utf8'));
  s.mcpServers.records.env.FAKE_KIND_HANG_ARG = 'anotherValue'; writeFileSync(config, JSON.stringify(s));
  assert.equal((await f.service.set(approvalServer, { enabled: true, enableStamp: stamp })).ok, false);
  const next = f.service.enableStamp(approvalServer)!; await f.reopen();
  assert.notEqual(f.service.enableStamp(approvalServer), next);
  assert.equal((await f.service.set(approvalServer, { enabled: true, enableStamp: next })).ok, false);
});

test('listing exposes exact Core signature identity and immutable call basis across replacement and restart', async t => {
  const f = await approvalFixture(t); value(await f.sign('send_note')); const first = f.read().servers[approvalServer].tools.send_note.standing.id;
  assert.equal(f.service.list().servers[0].tools.find(t => t.name === 'send_note')!.standing!.id, first);
  await f.call('send_note', { unknown: true }); const original = f.service.list().held[0];
  assert.equal(original.standingSignatureId, first);
  value(await f.sign('send_note', true)); const second = f.read().servers[approvalServer].tools.send_note.standing.id; assert.notEqual(second, first);
  await f.call('send_note', { text: 'Paused new signature' }); const held = f.service.list().held[0]; assert.equal(held.standingSignatureId, undefined);
  await f.reopen(); const fileBefore = readFileSync(f.file, 'utf8');
  assert.equal(f.service.list().held.find(h => h.effect === original.effect)!.standingSignatureId, first);
  assert.equal(f.service.list().servers[0].tools.find(t => t.name === 'send_note')!.standing!.id, second);
  assert.deepEqual(f.service.list().signatureEndings, { pending: [], conflicts: [] });
  assert.equal(readFileSync(f.file, 'utf8'), fileBefore);
  assert.equal('approval' in f.service.list().held[0], false); assert.equal('dispatchClaim' in f.service.list().held[0], false);
});

for (const missing of [false, true]) test(`stored-only ending works with unavailable Core and ${missing ? 'disappeared' : 'present'} discovery`, async t => {
  const f = await approvalFixture(t); value(await f.sign('send_note')); const id = f.read().servers[approvalServer].tools.send_note.standing.id;
  let arrive!: (link: typeof f.link) => void; const late = new Promise<typeof f.link>(r => { arrive = r; }); f.options.link = () => late;
  if (missing) writeFileSync(join(f.person, '.claude.json'), '{"mcpServers":{}}');
  assert.deepEqual(value(await f.service.endStoredSignature(approvalServer, 'send_note')), { ended: true });
  assert.equal(f.read().servers[approvalServer].tools.send_note.standing, undefined);
  assert.deepEqual(f.service.list().signatureEndings?.pending, [id]);
  f.options.link = async () => f.link; arrive(f.link); await f.reopen();
  assert.deepEqual(f.service.list().signatureEndings?.pending, []);
  const ended = await f.link.read(f.link.person(), "SELECT subject FROM app.ledger WHERE entry_type='signature.ended' AND subject=$1", [id]); assert.equal(ended.rows.length, 1);
});
