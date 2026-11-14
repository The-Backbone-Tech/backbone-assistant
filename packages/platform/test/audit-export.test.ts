import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAudit, verifyAudit } from '../src/audit.ts';
import { coreAuditSource, exportAudit } from './fixtures/audit-collect.ts';
import { AUDIT_PERIOD, auditActivity } from './fixtures/audit-activity.ts';

test('a disposable home exports Core receipts for person release, signed send, refusal, failure, unknown and a revoked signature gap', { timeout: TEST_HANG_MS * 2 }, async () => {
  const activity = await auditActivity();
  try {
    const { link } = activity;
    const made = await exportAudit(coreAuditSource(link), AUDIT_PERIOD);
    assert.equal(verifyAudit(made.jsonl).valid, true);
    const read = readAudit(made.jsonl);
    assert.equal(read.header.includeContent, false);
    assert.deepEqual(read.header.exportedBy, {kind:'home-person',personId:link.id.person});
    assert.ok(read.header.gaps.includes('standing-signature-creation-revocation-and-id-not-in-core'));
    const held = read.events.filter(e => e.effect?.id === activity.held);
    assert.deepEqual(held.map(e => e.disposition).filter(Boolean), ['held', 'approved', 'dispatch-started', 'succeeded']);
    const approved = held.find(e => e.disposition === 'approved')!;
    assert.equal(approved.actorId, link.id.person);
    assert.equal(approved.authority?.method, 'core-decision');
    assert.ok(approved.authority?.decisionId);
    assert.ok(approved.omitted.includes('signatureId'));
    assert.equal(activity.signed.outcome,'SENT');
    const signedId=activity.signed.outcome==='SENT'?activity.signed.effect:assert.fail('fixture signed call was not sent');
    const signedApproval=read.events.find(e=>e.effect?.id===signedId&&e.kind==='decision.answered')!;
    assert.equal(signedApproval.authority!.method,approved.authority!.method,'the exporter still projects both bases as core-decision; the Core records their checked basis');
    assert.equal(signedApproval.actorId,approved.actorId);
    assert.ok(read.header.gaps.includes('human-release-versus-standing-signature-not-structured-in-core'));
    // Generic event export already preserves these new kinds and identities; basis projection is separate.
    const signatures = read.events.filter(e=>e.kind.startsWith('signature.'));
    assert.deepEqual(signatures.map(e=>e.kind), ['signature.given','signature.given','signature.given','signature.ended']);
    const coreSignatures = (await link.read(link.person(), "SELECT entry_type,subject,actor_id FROM app.ledger WHERE entry_type IN ('signature.given','signature.ended') ORDER BY seq")).rows;
    assert.deepEqual(signatures.map(e=>[e.kind,e.subjectId,e.actorId]),coreSignatures.map(e=>[e.entry_type,e.subject,e.actor_id]),'every real signature receipt survives export exactly once');
    assert.ok(read.events.every(e=>!('signatureId' in e.data)));

    assert.ok(read.events.some(e => e.disposition === 'refused' && e.data.reason === 'repeat_unknown_blocked'));
    assert.ok(read.events.some(e => e.disposition === 'unknown'));
    assert.ok(read.events.some(e => e.disposition === 'failed'));
    const knownNonDelivery = read.events.filter(e => e.effect?.id === activity.failed.id);
    assert.deepEqual(knownNonDelivery.map(e => e.disposition).filter(Boolean), ['held', 'approved', 'dispatch-started', 'failed'], 'the admitted but uninvoked call retains its real FAILED lifecycle');
    assert.ok(activity.postCallError.outcome === 'SENT');
    const errorEffect = activity.postCallError.effect;
    const errorReply = read.events.filter(e => e.effect?.id === errorEffect);
    assert.deepEqual(errorReply.map(e => e.disposition).filter(Boolean), ['held', 'approved', 'dispatch-started', 'unknown'], 'an invoked server error is exported as UNKNOWN, not invented non-delivery');
    assert.ok(read.events.some(e => e.kind === 'run.claimed' && e.run?.mandateId));
    assert.ok(read.events.some(e => e.kind === 'run.finished' && e.data.outcome === 'succeeded'));
    const proposals = read.events.filter(e => e.kind === 'effect.proposed');
    const receipts = (await link.read<{ id: string }>(link.person(), 'SELECT id FROM app.effects ORDER BY id')).rows;
    assert.deepEqual(proposals.map(e => e.effect!.id).sort(), receipts.map(r => r.id).sort(), 'one proposed event per Core receipt');
    const ledger = (await link.read<{ seq: string; hash: string }>(link.person(), 'SELECT seq::text, hash FROM app.ledger ORDER BY app.ledger.seq')).rows;
    assert.deepEqual(read.events.map(e => [e.sequence, e.receipt.hash]), await Promise.all(ledger.map(async row => [row.seq, await coreAuditSource(link).digester().redigest(row.hash)])), 'every ledger row exactly once');
    assert.ok(read.events.every(e => !('receiptStatement' in e)));
    assert.equal(made.trailer.cursor?.sequence, ledger.at(-1)!.seq);
  } finally { await activity.close(); }
});
