import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { approvalFixture, approvalServer } from './connector-approval-fixture.ts';
import { sendingArgs, coverageDigest } from '../src/connectors/signature-coverage.ts';
import { value } from './helpers.ts';

test('plain and blockedToo signature records built through product functions retain their UUID, pins and normal releases after reopening', async t => {
  const f = await approvalFixture(t);
  await f.signLegacy('draft_note'); await f.signLegacy('send_note', true);
  const before = f.read().servers[approvalServer].tools;
  assert.equal(before.draft_note.standing.blockedToo, undefined); assert.equal(before.send_note.standing.blockedToo, true);
  assert.equal((await f.call('draft_note', { text: 'Plain before restart' })).outcome, 'SENT');
  assert.equal((await f.call('send_note', { text: 'Strong before restart' })).outcome, 'SENT');
  await f.reopen(); const after = f.read().servers[approvalServer].tools;
  assert.deepEqual(after.draft_note.standing, before.draft_note.standing); assert.deepEqual(after.send_note.standing, before.send_note.standing);
  assert.equal((await f.call('draft_note', { text: 'Plain after restart' })).outcome, 'SENT');
  assert.equal((await f.call('send_note', { text: 'Strong after restart' })).outcome, 'SENT');
  assert.equal((await f.call('archive_note', { text: 'Unsigned still held' })).outcome, 'HELD');
  const grants = await f.link.read<{ subject: string }>(f.link.person(), "SELECT subject FROM app.ledger WHERE entry_type='signature.given' ORDER BY seq");
  assert.deepEqual(grants.rows.map(g => g.subject), [before.draft_note.standing.id, before.send_note.standing.id]);
  assert.equal(await f.link.call(f.link.person(), 'SELECT gov.verify_ledger()'), null);
  assert.deepEqual(f.calls().map(c => c.arguments.text), ['Plain before restart', 'Strong before restart', 'Plain after restart', 'Strong after restart']);
});

test('a new plain signature suffices for a listed name while unsigned tools remain held', async t => {
  const f = await approvalFixture(t); value(await f.sign('send_note'));
  assert.equal(f.read().servers[approvalServer].tools.send_note.standing.blockedToo, undefined);
  assert.equal((await f.call('send_note', { text: 'One ordinary signature' })).outcome, 'SENT');
  assert.equal((await f.call('draft_note', { text: 'No signature on this tool' })).outcome, 'HELD');
  const send = f.service.list().servers[0].tools.find(t => t.name === 'send_note')!;
  const archive = f.service.list().servers[0].tools.find(t => t.name === 'archive_note')!;
  assert.equal(send.blocklisted, true); assert.equal(archive.blocklisted, undefined); assert.equal(archive.destructive, true);
  assert.equal(f.service.toolView(approvalServer, 'archive_note')?.destructive, true);
});

// 10 November 2026, security-review direction: existing signatures never gain sending-argument reach silently.
test('legacy plain signatures retain old argument reach; a person can release once or sign again with the new meaning', async t => {
  const f = await approvalFixture(t); await f.signLegacy('draft_note'); const sig = f.read().servers[approvalServer].tools.draft_note.standing;
  await f.reopen(); assert.deepEqual(f.read().servers[approvalServer].tools.draft_note.standing, sig);
  assert.equal((await f.call('draft_note', { send: false, text: 'Old reach' })).outcome, 'SENT');
  const args = { send: true, nested: { publish: true }, text: 'Defined arguments' };
  const result = await f.call('draft_note', args); assert.equal(result.outcome, 'HELD');
  assert.match(result.detail, /signature was given before it covered sending arguments/i);
  assert.equal(f.calls().length, 1);
  const held = f.service.list().held.find(h => h.args.send === true)!;
  assert.equal(value(await f.service.decide(held.effect, held.argsHash, 'release')).state, 'sent');
  assert.deepEqual(f.calls()[1].arguments, args);
  assert.equal((await f.call('draft_note', args)).outcome, 'HELD');
  value(await f.sign('draft_note')); const next = f.read().servers[approvalServer].tools.draft_note.standing;
  assert.equal(next.coverageVersion, 1); assert.notEqual(next.id, sig.id);
  assert.equal(await f.link.call(f.link.person(), "SELECT gov.ledger_words_match(seq, 'definition_digest', $2) FROM app.ledger WHERE entry_type='signature.given' AND subject=$1", [next.id, coverageDigest(next.signedDefinition)]), true);
  await f.reopen(); assert.equal((await f.call('draft_note', { ...args, text: 'Newly signed arguments' })).outcome, 'SENT');
});

test('legacy blockedToo signatures retain sending arguments and a file-only version cannot widen a legacy plain signature', async t => {
  const f = await approvalFixture(t); await f.signLegacy('send_note', true); await f.signLegacy('draft_note');
  assert.equal((await f.call('send_note', { send: true })).outcome, 'SENT');
  const s = f.read(), signature = s.servers[approvalServer].tools.draft_note.standing;
  signature.coverageVersion = 1; signature.signedDefinition = signature.definition; writeFileSync(f.file, JSON.stringify(s));
  assert.equal((await f.call('draft_note', { nested: [{ sendNow: true }] })).outcome, 'HELD');
  assert.equal(f.calls().length, 1);
});

test('the compatibility rule preserves nested flags, false-like exceptions and the released depth bound', () => {
  for (const key of ['send', 'sendNow', 'auto_send', 'sendImmediately', 'publish', 'post', 'share', 'deliver', 'notify', 'broadcast']) {
    assert.equal(sendingArgs({ nested: [{ [key]: true }] }), true, key);
    for (const value of [false, null, 0, '', 'false']) assert.equal(sendingArgs({ nested: { [key]: value } }), false);
  }
  let deep: Record<string, unknown> = {}; for (let i = 0; i < 33; i++) deep = { nested: deep };
  assert.equal(sendingArgs(deep), true); assert.equal(sendingArgs({ sender: true, published: true }), false);
});
