import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { approvalFixture } from './connector-approval-fixture.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import { readAudit, verifyAudit } from '../src/audit.ts';
import { coreAuditSource, exportAudit } from './fixtures/audit-collect.ts';
import { AUDIT_PERIOD } from './fixtures/audit-activity.ts';
import { value } from './helpers.ts';

test('a person releases one listed send with exactly the displayed arguments once, with a Core receipt', async t => {
  const f = await approvalFixture(t), args = { body: 'Original words.', send: true, options: { publish: true }, to: ['one@example.test'] };
  const expected = structuredClone(args);
  assert.equal((await f.call('send_note', args)).outcome, 'HELD'); args.body = 'Changed by caller';
  const held = f.service.list().held[0];
  assert.equal(held.statement, `Call send_note on records with exactly: ${JSON.stringify(expected)}`);
  const sent = value(await f.service.decide(held.effect, held.argsHash, 'release'));
  assert.equal(sent.state, 'sent'); assert.ok(sent.personReleasedAt); assert.equal(sent.standing, undefined);
  assert.deepEqual(f.calls(), [{ name: 'send_note', arguments: expected }]);
  value(await f.service.decide(held.effect, held.argsHash, 'release')); assert.equal(f.calls().length, 1);
  const rows = await f.link.read<{ entry_type: string }>(f.link.person(), "SELECT entry_type FROM app.ledger WHERE subject = $1 AND entry_type IN ('effect.dispatched','effect.observed') ORDER BY seq", [held.effect]);
  assert.deepEqual(rows.rows.map(r => r.entry_type), ['effect.dispatched', 'effect.observed']);
  assert.equal((await f.call('send_note', { body: 'Another send' })).outcome, 'HELD');
});

for (const when of ['before approval', 'after approval', 'after begin'] as const) for (const field of ['args', 'statement'] as const)
  test(`a changed ${field} ${when} refuses the person’s release without provider dispatch`, async t => {
    const f = await approvalFixture(t); await f.call('send_note', { body: 'Shown' }); const held = f.service.list().held[0];
    const mutate = () => { const s = f.read(), h = s.held.find((h: { effect: string }) => h.effect === held.effect); if (field === 'args') h.args.body = 'Not shown'; else h.statement = 'Not the shown statement'; writeFileSync(f.file, JSON.stringify(s)); };
    if (when === 'before approval') mutate();
    else if (when === 'after approval') {
      const call = f.link.call.bind(f.link);
      f.link.call = (async (...args: Parameters<typeof call>) => { const result = await call(...args); if (String(args[1]).includes('answer_decision_with_basis')) mutate(); return result; }) as typeof call;
    } else {
      const begin = f.link.beginDispatch.bind(f.link); f.link.beginDispatch = async (...args) => { const result = await begin(...args); mutate(); return result; };
    }
    const result = await f.service.decide(held.effect, held.argsHash, 'release');
    assert.equal(result.ok && result.value.state === 'sent', false); assert.deepEqual(f.calls(), []);
  });

test('a fresh person release sends a previously standing-approved held call despite that tool’s unresolved UNKNOWN', async t => {
  const f = await approvalFixture(t); value(await f.sign('draft_note'));
  const begin = f.link.beginConnectorDispatch.bind(f.link); let once = true;
  f.link.beginConnectorDispatch = async (...args) => { if (once) { once = false; await f.call('draft_note', { unknown: true }); } return begin(...args); };
  assert.equal((await f.call('draft_note', { text: 'Person can inspect this' }, 'held')).outcome, 'HELD');
  const held = f.service.list().held.find(h => h.args.text)!;
  const s = f.read(); s.held.find((h: { effect: string }) => h.effect === held.effect).personReleasedAt = 'forged'; writeFileSync(f.file, JSON.stringify(s));
  assert.equal((await f.call('draft_note', { text: 'Person can inspect this' }, 'held')).outcome, 'HELD');
  const sent = value(await f.service.decide(held.effect, held.argsHash, 'release'));
  assert.equal(sent.state, 'sent'); assert.equal(sent.standing, undefined); assert.ok(sent.personReleasedAt);
  // 10 November 2026, security-review direction: the override must be a Core person answer, not a local dispatch hint.
  assert.notEqual(sent.effect, held.effect); assert.equal(sent.standingSignatureId, undefined);
  assert.deepEqual(f.calls()[1].arguments, held.args);
  assert.equal(await f.link.connectorStatementMatches(sent.effect, sent.argsHash, held.args, held.statement), true);
  const basis = await f.link.read<{ method: string }>(f.link.person(), "SELECT l.payload->'basis'->>'method' AS method FROM app.effects e JOIN app.ledger l ON l.subject = e.decision_id::text WHERE e.id=$1 AND l.entry_type='decision.answered'", [sent.effect]);
  assert.deepEqual(basis.rows.map(r => r.method), ['person']);
  assert.equal((await f.link.effect(held.effect)).status, 'cancelled');
  const exported = await exportAudit(coreAuditSource(f.link), AUDIT_PERIOD);
  assert.equal(verifyAudit(exported.jsonl).valid, true);
  const events = readAudit(exported.jsonl).events;
  assert.equal(events.find(e => e.effect?.id === held.effect && e.kind === 'decision.answered')!.data.approval_method, 'standing_signature');
  assert.equal(events.find(e => e.effect?.id === held.effect && e.kind === 'effect.cancelled')!.actorId, f.link.id.person);
  const person = events.find(e => e.effect?.id === sent.effect && e.kind === 'decision.answered')!;
  assert.equal(person.actorId, f.link.id.person); assert.equal(person.data.approval_method, 'person');
  assert.equal(events.filter(e => e.effect?.id === sent.effect && e.kind === 'effect.dispatched').length, 1);
  assert.equal(events.filter(e => e.effect?.id === held.effect && e.kind === 'effect.dispatched').length, 0);

  assert.equal(f.service.list().held.find(h => h.args.unknown)?.state, 'unknown');
  assert.equal(f.calls().length, 2);
  assert.equal((await f.call('draft_note', { text: 'Still paused' })).outcome, 'HELD');
});

test('a backend refusal discloses no backend text through a call receipt', async t => {
  const f = await approvalFixture(t), native = f.link.proposeConnectorEffect.bind(f.link), text = 'opaque-private-backend-diagnostic-132';
  f.link.proposeConnectorEffect = async () => { throw Error(text); };
  const result = await f.call('send_note', { text: 'Not dispatched' }); assert.equal(result.outcome, 'REFUSED');
  assert.equal(JSON.stringify(result).includes(text), false); assert.equal(f.calls().length, 0);
  f.link.proposeConnectorEffect = native;
});

async function standingHeld(f: Awaited<ReturnType<typeof approvalFixture>>) {
  value(await f.sign('draft_note')); const begin = f.link.beginDispatch.bind(f.link);
  f.link.beginDispatch = async () => false;
  try { assert.equal((await f.call('draft_note', { text: 'Exact person replacement' })).outcome, 'HELD'); }
  finally { f.link.beginDispatch = begin; }
  return f.service.list().held[0];
}

test('two person releases in separate services cancel the old standing effect once and dispatch only one replacement', async t => {
  const f = await approvalFixture(t), held = await standingHeld(f), other = new ConnectorService(f.options); t.after(() => other.close());
  const answers = await Promise.all([f.service.decide(held.effect, held.argsHash, 'release'), other.decide(held.effect, held.argsHash, 'release')]);
  assert.equal(answers.filter(r => r.ok && r.value.state === 'sent').length, 1);
  assert.deepEqual(f.calls(), [{ name: 'draft_note', arguments: held.args }]);
  assert.equal((await f.link.read(f.link.person(), "SELECT seq FROM app.ledger WHERE entry_type='effect.cancelled' AND subject=$1", [held.effect])).rows.length, 1);
});

test('a standing-approved effect already dispatching gets no replacement or second dispatch', async t => {
  const f = await approvalFixture(t), held = await standingHeld(f), claim = f.read().held[0].dispatchClaim;
  assert.equal(await f.link.beginDispatch(held.effect, claim, true), true);
  const result = value(await f.service.decide(held.effect, held.argsHash, 'release'));
  assert.equal(result.effect, held.effect); assert.equal(result.state, 'waiting'); assert.match(result.detail, /still dispatching/);
  assert.equal((await f.link.read(f.link.person(), 'SELECT id FROM app.effects')).rows.length, 1); assert.equal(f.calls().length, 0);
});

test('a lost cancellation reply never creates or dispatches a person replacement', async t => {
  const f = await approvalFixture(t), held = await standingHeld(f), call = f.link.call.bind(f.link);
  f.link.call = (async (...args: Parameters<typeof call>) => { const result = await call(...args); if (String(args[1]).includes('cancel_effect')) throw Error('private backend cancel text'); return result; }) as typeof call;
  const result = await f.service.decide(held.effect, held.argsHash, 'release');
  assert.equal(JSON.stringify(result).includes('private backend'), false); assert.equal(f.calls().length, 0);
  assert.equal((await f.link.effect(held.effect)).status, 'cancelled');
  assert.equal((await f.link.read(f.link.person(), 'SELECT id FROM app.effects')).rows.length, 1);
});

test('a failed fresh proposal stays closed and exposes no backend diagnostic', async t => {
  const f = await approvalFixture(t), held = await standingHeld(f);
  f.link.proposeConnectorEffect = async () => { throw Error('private backend replacement text'); };
  const result = await f.service.decide(held.effect, held.argsHash, 'release');
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('private backend'), false);
  assert.equal((await f.link.effect(held.effect)).status, 'cancelled'); assert.equal(f.calls().length, 0);
});

for (const field of ['args', 'statement'] as const) test(`a changed original ${field} during cancellation refuses the replacement`, async t => {
  const f = await approvalFixture(t), held = await standingHeld(f), call = f.link.call.bind(f.link);
  f.link.call = (async (...args: Parameters<typeof call>) => {
    const result = await call(...args);
    if (String(args[1]).includes('cancel_effect') && args[2]?.[0] === held.effect) {
      const s = f.read(), original = s.held.find((h: { effect: string }) => h.effect === held.effect);
      if (field === 'args') original.args.text = 'Changed while cancelling'; else original.statement = 'Changed while cancelling';
      writeFileSync(f.file, JSON.stringify(s));
    }
    return result;
  }) as typeof call;
  assert.equal((await f.service.decide(held.effect, held.argsHash, 'release')).ok, false); assert.equal(f.calls().length, 0);
  assert.ok((await f.link.read<{ status: string }>(f.link.person(), 'SELECT status FROM app.effects')).rows.every(r => r.status === 'cancelled'));
});

test('a crash after the replacement proposal is recoverable before an identical later call, without dispatching the orphan', async t => {
  const f = await approvalFixture(t), held = await standingHeld(f), propose = f.link.proposeConnectorEffect.bind(f.link);
  let orphan = '';
  f.link.proposeConnectorEffect = async (...args) => {
    const made = await propose(...args); orphan = made.effect;
    assert.equal(typeof f.read().held.find((h: { effect: string }) => h.effect === held.effect).replacementKey, 'string', 'the replacement identity is retained before Core proposes');
    throw Error('crash after proposal before local save');
  };
  assert.equal((await f.service.decide(held.effect, held.argsHash, 'release')).ok, false);
  assert.equal(f.calls().length, 0); assert.ok(orphan);
  f.link.proposeConnectorEffect = propose; await f.reopen();
  assert.equal((await f.call('draft_note', held.args)).outcome, 'SENT');
  assert.equal((await f.link.effect(orphan)).status, 'cancelled');
  assert.deepEqual(f.calls(), [{ name: 'draft_note', arguments: held.args }]);
});

test('recovering an orphan replacement does not settle an earlier UNKNOWN or bypass its standing pause', async t => {
  const f = await approvalFixture(t); value(await f.sign('draft_note'));
  const begin = f.link.beginConnectorDispatch.bind(f.link); let once = true;
  f.link.beginConnectorDispatch = async (...args) => { if (once) { once = false; await f.call('draft_note', { unknown: true }); } return begin(...args); };
  await f.call('draft_note', { text: 'Paused replacement' }); f.link.beginConnectorDispatch = begin;
  const held = f.service.list().held.find(h => h.args.text)!;
  const propose = f.link.proposeConnectorEffect.bind(f.link); let orphan = '';
  f.link.proposeConnectorEffect = async (...args) => { const p = await propose(...args); orphan = p.effect; throw Error('crash before local save'); };
  assert.equal((await f.service.decide(held.effect, held.argsHash, 'release')).ok, false);
  f.link.proposeConnectorEffect = propose; await f.reopen();
  assert.equal((await f.call('draft_note', held.args)).outcome, 'HELD');
  assert.equal((await f.link.effect(orphan)).status, 'cancelled'); assert.equal(f.calls().length, 1);
  assert.equal(f.service.list().held.find(h => h.args.unknown)?.state, 'unknown');
  assert.equal('replacementKey' in f.service.list().held.find(h => h.effect === held.effect)!, false);
});
