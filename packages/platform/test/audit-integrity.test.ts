import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditInvalid, auditCursor, auditOptions, readAudit, verifyAudit } from '../src/audit.ts';
import { coreAuditSource, exportAudit, type AuditSource } from './fixtures/audit-collect.ts';
import { CoreLink } from '../src/composition/core.ts';
import { freshHome } from './helpers.ts';
import { AUDIT_PERIOD, auditActivity } from './fixtures/audit-activity.ts';

const lines = (text: string) => text.trimEnd().split('\n');
const jsonl = (rows: string[]) => rows.join('\n') + '\n';
test('offline verification detects removed, swapped, edited and truncated event lines, header edits, and truncated trailer', { timeout: TEST_HANG_MS * 2 }, async () => {
  const activity = await auditActivity();
  try {
    const made = await exportAudit(coreAuditSource(activity.link), AUDIT_PERIOD), rows = lines(made.jsonl);
    assert.ok(rows.length > 10);
    const removed = [...rows]; removed.splice(4, 1);
    const swapped = [...rows]; [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    const edited = [...rows], event = JSON.parse(edited[3]); event.actorId = '00000000-0000-0000-0000-000000000000'; edited[3] = JSON.stringify(event);
    const header = [...rows], h = JSON.parse(header[0]); h.includeContent = true; header[0] = JSON.stringify(h);
    for (const bad of [jsonl(removed), jsonl(swapped), jsonl(edited), jsonl(header), jsonl(rows.slice(0, -1)), made.jsonl.slice(0, -7), made.jsonl.slice(0, -1), made.jsonl + '{}\n', made.jsonl.replaceAll('\n', '\r\n')]) assert.throws(() => verifyAudit(bad), AuditInvalid);
    assert.equal(verifyAudit(made.jsonl).count, made.header.count);
    for(const mutate of [(tail:string)=>tail+' ',(tail:string)=>JSON.stringify({...JSON.parse(tail),extra:true}),
      (tail:string)=>JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(tail)).reverse()))]){
      const changed=[...rows];changed[changed.length-1]=mutate(changed.at(-1)!);assert.throws(()=>verifyAudit(jsonl(changed)),/canonical form/);
    }

  } finally { await activity.close(); }
});

test('resumption emits exactly the remaining events and joins source receipt anchors, including an empty remainder', { timeout: TEST_HANG_MS * 2 }, async () => {
  const activity = await auditActivity();
  try {
    const { link } = activity, source = coreAuditSource(link);
    const first = await exportAudit(source, AUDIT_PERIOD);
    for (let i = 0; i < 3; i++) await link.createTask(`Later task ${i}`);
    const remainder = await exportAudit(source, { ...AUDIT_PERIOD, after: first.trailer.cursor!.id });
    const all = readAudit((await exportAudit(source, AUDIT_PERIOD)).jsonl), read = readAudit(remainder.jsonl, first.jsonl);
    assert.equal(verifyAudit(remainder.jsonl, first.jsonl).joined, true);
    assert.deepEqual(read.events, all.events.slice(first.header.count).map((e, i) => ({ ...e, previousHash: read.events[i].previousHash })), 'all remaining facts, with the new file byte chain');
    assert.deepEqual(read.header.after, first.trailer.cursor);
    assert.equal(read.events[0].receipt.previousHash, first.trailer.cursor!.receiptHash, 'first resumed receipt chains from the predecessor Core head');
    const empty = await exportAudit(source, { ...AUDIT_PERIOD, after: remainder.trailer.cursor!.id });
    assert.equal(readAudit(empty.jsonl, remainder.jsonl).events.length, 0);
    const changedPeriod = await exportAudit(source, { since: '2001-01-01T00:00:00Z', until: AUDIT_PERIOD.until, after: first.trailer.cursor!.id });
    assert.throws(() => readAudit(changedPeriod.jsonl, first.jsonl), /do not join/);
    const changedContent = await exportAudit(source, { ...AUDIT_PERIOD, includeContent: true, after: first.trailer.cursor!.id });
    assert.throws(() => readAudit(changedContent.jsonl, first.jsonl), /do not join/);
    await assert.rejects(exportAudit(source, { ...AUDIT_PERIOD, after: auditCursor('00000000-0000-0000-0000-000000000000', '1') }), /another data folder/);
    await assert.rejects(exportAudit(source, { ...AUDIT_PERIOD, after: auditCursor(link.id.workspace, '9000000') }), /no committed/);
    const future = await exportAudit(source, { since: '2090-01-01T00:00:00Z', until: AUDIT_PERIOD.until });
    assert.equal(future.header.count, 0); assert.ok(future.trailer.cursor, 'even a filtered empty file advances only the scanned source head');
    assert.equal(readAudit(future.jsonl).events.length, 0);
  } finally { await activity.close(); }
});

test('periods reject missing zones, invalid dates, reversed intervals and malformed cursors', () => {
  for (const options of [
    { ...AUDIT_PERIOD, since: '2026-11-10' }, { ...AUDIT_PERIOD, since: '2026-11-10T24:00:00Z' }, { ...AUDIT_PERIOD, since: '2026-02-30T00:00:00Z' },
    { ...AUDIT_PERIOD, since: AUDIT_PERIOD.until }, { ...AUDIT_PERIOD, after: 'garbage' },
    { ...AUDIT_PERIOD, includeContent: 'true' as never },
  ]) assert.throws(() => auditOptions(options), AuditInvalid);
  assert.equal(auditOptions({ since: '2026-11-10T01:00:00+01:00', until: '2026-11-11T00:00:00Z' }).since, '2026-11-10T00:00:00.000Z');
});

test('ledger export uses the existing owner/admin person boundary, never worker or system authority', { timeout: TEST_HANG_MS * 2 }, async () => {
  const link = await CoreLink.open({ home: freshHome() });
  try {
    const source = coreAuditSource(link);
    const member = await link.call<string>(link.person(), "SELECT gov.identity_add_person('Member','member@example.test','member')");
    const as = (principal: string): AuditSource => ({ ...source, personId: principal,
      snapshot: async (sql, args) => (await link.read({ workspace: link.id.workspace, principal }, sql, args)).rows[0] as never });
    for (const principal of [member, link.id.agent, link.id.system]) await assert.rejects(exportAudit(as(principal), AUDIT_PERIOD), /owner or admin/);
    await link.call(link.person(), "SELECT gov.identity_change_role($1, 'admin')", [member]);
    assert.deepEqual((await exportAudit(as(member), AUDIT_PERIOD)).header.exportedBy, {kind:'home-person',personId:member});
    const h = await link.startRun(await link.createTask('Run must not export'));
    const inRun: AuditSource = { ...source, snapshot: async (sql, args) => (await link.read(link.runOf(h), sql, args)).rows[0] as never };
    await assert.rejects(exportAudit(inRun, AUDIT_PERIOD), /owner or admin/);
    await link.finishRun(h, 'succeeded');
  } finally { await link.close(); }
});


test('piece registrations, grants and revocations keep original identities and run engine bindings', { timeout: TEST_HANG_MS * 2 }, async () => {
  const link = await CoreLink.open({ home: freshHome() });
  try {
    const manifest = { manifest: 1, id: 'test.invalid/private-piece-label', kind: 'module', version: '1.0.0-private-version-label', digest: 'sha256:' + 'a'.repeat(64),
      capabilities: { planes: ['personal'], operations: ['workspace.write_document'], effectClasses: [2], network: [], secrets: 'none' } };
    const registration = await link.call<string>(link.person(), 'SELECT gov.register_piece($1::jsonb)', [JSON.stringify(manifest)]);
    const mandate = await link.grantPiece(registration), run = await link.startRun(await link.createTask('Piece work'), registration);
    await link.finishRun(run, 'succeeded');
    await link.call(link.person(), 'SELECT gov.revoke_mandate($1)', [mandate]);
    await link.call(link.person(), 'SELECT gov.unregister_piece($1)', [registration]);
    const made = await exportAudit(coreAuditSource(link), AUDIT_PERIOD), record = readAudit(made.jsonl);
    assert.equal(made.jsonl.includes('private-piece-label'), false); assert.equal(made.jsonl.includes('private-version-label'), false);
    assert.deepEqual(record.events.filter(e => e.subjectId === registration).map(e => e.kind), ['piece.registered', 'piece.unregistered']);
    assert.equal(record.events.find(e => e.kind === 'piece.registered')!.data.digest, manifest.digest);
    assert.equal(record.events.find(e => e.kind === 'piece.unregistered')!.data.digest,manifest.digest);
    assert.ok(record.events.some(e => e.kind === 'mandate.issued' && e.subjectId === mandate));
    assert.ok(record.events.some(e => e.kind === 'mandate.revoked' && e.subjectId === mandate));
    for (const event of record.events.filter(e => e.subjectId === run.run)) assert.equal(event.run!.engineId, registration);
  } finally { await link.close(); }
});
