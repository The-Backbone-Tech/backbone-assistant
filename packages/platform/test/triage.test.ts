import { document, systemFixture } from './policy-fixture.ts';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
// The mail triage job end to end on the real core, Pi on the scripted model, and the sample mailbox:
// formation by one signature (and what a signature is not), before formation only reads, and each
// adverse case of the job's pass criteria: a restart, a revocation and a stop mid-job, a provider
// timeout settled by a probe and never resent, an injected instruction, an entitlement that fails
// closed. No network and no key; the model is the loopback's scripted one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FakeMailbox, readSeed, SCOPES, type FakeMailboxOptions } from '@backbone-next/connector-mail';
import { METHODS } from '../src/api.ts';
import type { Host } from '../src/composition/host.ts';
import { CoreLink, CoreRefusal } from '../src/composition/core.ts';
import { DOOR_METHODS } from '../src/doors/protocol.ts';
import { startScriptedModel, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { widenings, type CapabilityPayload } from '../src/triage/capability.ts';
import { addressesIn, headerAddresses, parseNote } from '../src/triage/note.ts';
import { pollUntil, freshHome, open, value  } from './helpers.ts';

let model: ScriptedModel;
before(async () => {
  model = await startScriptedModel();
  process.env.BACKBONE_MODEL_ENDPOINT = model.url;
  process.env.BACKBONE_MODEL_ID = model.model;
});
after(async () => {
  delete process.env.BACKBONE_MODEL_ENDPOINT;
  delete process.env.BACKBONE_MODEL_ID;
  await model.close();
});

const seed = readSeed();
/** A small inbox from the fixture: a billing request, a newsletter, a phishing mail, the injected one, and Nina's (the canary). */
const SMALL = ['m01', 'm05', 'm07', 'm08', 'm22'];
const inbox = (ids = SMALL) => ({ ...seed, messages: seed.messages.filter((m) => ids.includes(m.id)) });

function job(options: FakeMailboxOptions = {}, home?: string) {
  const mailbox = new FakeMailbox({ seed: inbox(), ...options });
  const opened = open(home, { harness: 'harness-pi', mail: { connector: mailbox } });
  return { ...opened, mailbox, triage: opened.host.triage! };
}

async function formed(options: FakeMailboxOptions = {}) {
  const j = job(options);
  value(await j.host.call('triage.connect', {}));
  const offer = (await j.host.call('triage.get', {})).offer!;
  value(await j.host.signCapability({ hash: offer.hash, presence: 'touch-id' }));
  await j.triage.run('person');
  return j;
}

const view = (host: Host) => host.call('triage.get', {});

async function core(home: string) {
  const link = await CoreLink.open({ home });
  return link;
}

test('A8: connecting runs the entitlement check first and fails closed: nothing is read or granted', async () => {
  const { host, mailbox } = job({ scopes: [] });
  const r = await host.call('triage.connect', {});
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.detail : '', /has not granted permission to read mail/);
  const v = await view(host);
  assert.equal(v.connection, null);
  assert.equal(v.offer, null);
  assert.equal(mailbox.truth.applied.length, 0);
});

test('A6: before formation the job only reads: reads have receipts; a draft or a proposal is refused by the core with a receipt', async () => {
  const { host, triage } = job();
  const connected = value(await host.call('triage.connect', {}));
  assert.equal(connected.connection?.readOnly, true);
  const run = await triage.run('person');
  assert.equal(run.outcome, 'done', run.reason ?? '');
  const v = await view(host);
  assert.equal(v.brief.counts.read, SMALL.length);
  assert.ok(v.brief.done.length > 0);
  for (const d of v.brief.done) assert.deepEqual([d.outcome, d.detail], ['REFUSED', 'Not drafted: before formation the job only reads.']);
  for (const p of v.brief.proposed) assert.equal(p.outcome, 'REFUSED');
  assert.equal(v.brief.counts.drafted, 0);
  assert.ok(v.offer, 'the capability is offered for signature');
});

test('A7: the one screen shows a summary of the payload and the hash the core records; the grant is bound to its version, classes and module', async () => {
  const { host, home } = job();
  value(await host.call('triage.connect', {}));
  const offer = (await view(host)).offer!;
  assert.match(offer.hash, /^[0-9a-f]{64}$/);
  assert.ok(offer.summary.some((l) => l === 'Purpose: Read mail, draft replies; later label and move'));
  assert.ok(offer.summary.some((l) => /^Never: send, forward or delete mail/.test(l)));
  assert.ok(offer.summary.some((l) => /^Pinned: scripted-model via endpoint:openai-compatible; harness-pi 0\.0\.0; connector-mail 0\.0\.0 \(sha256:/.test(l)));
  const signed = value(await host.signCapability({ hash: offer.hash, presence: 'touch-id' }));
  assert.deepEqual([signed.state, signed.version, signed.hash, signed.signedWith], ['active', 1, offer.hash, 'touch-id']);
  const link = await core(home);
  try {
    const { rows } = await link.read<{ intent_hash: string; ceiling: number; operations: string[]; piece: string; payload: CapabilityPayload }>(
      link.person(),
      'SELECT m.intent_hash, m.ceiling, m.operations, p.piece, m.intent AS payload FROM app.mandates m JOIN app.pieces p ON p.id = m.piece_id WHERE m.intent_hash = $1',
      [offer.hash],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ceiling, 2, 'labels and moves (class 3) wait for the person');
    assert.deepEqual(rows[0].operations, ['mail.label', 'mail.labels', 'mail.list', 'mail.move', 'mail.read', 'workspace.write_document']);
    assert.equal(rows[0].piece, 'io.github.albertoangulo/connector-mail');
    assert.equal(rows[0].payload.version, 1);
    assert.deepEqual(rows[0].payload.irreversible, []);
  } finally {
    await link.release();
  }
  // Shown once, signed once: the same hash again is nothing to sign.
  assert.equal((await host.signCapability({ hash: offer.hash, presence: 'touch-id' })).ok, false);
});

test('A7: a signature is never started by the renderer, the door or an agent', async () => {
  // The signature status read inspects installation history; it gives no signing authority.
  assert.deepEqual(METHODS.filter((m) => /sign|capabilit/i.test(m)), ['core.signatureStatus'], 'only the reviewed status read names signatures; no api method signs');
  assert.ok(!DOOR_METHODS.some((m) => /sign|capabilit|mandate/i.test(m)), 'the door carries no control');
  const { host, home, triage } = job();
  await assert.rejects(host.call('triage.sign' as never, {} as never), /Unknown api method/);
  value(await host.call('triage.connect', {}));
  // An agent's run asks the core for the grant itself: refused, only a person grants a root mandate.
  const conn = triage.stored.connection!;
  const link = await core(home);
  try {
    const h = await link.startRunUnder(conn.task, conn.agent, conn.mandate, conn.registration.id);
    await assert.rejects(
      link.call(link.runOf(h), `SELECT gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', '["mail.read"]'::jsonb, 2::smallint, NULL, NULL, NULL, NULL, now() + interval '1 day', 'piece', '{}'::jsonb, $2)`, [conn.agent, conn.registration.id]),
      (e: unknown) => e instanceof CoreRefusal && e.reason === 'role',
    );
    await link.finishRun(h, 'failed');
  } finally {
    await link.release();
  }
  // A hash the person was not shown signs nothing.
  assert.match((await host.signCapability({ hash: '0'.repeat(64), presence: 'touch-id' }) as { detail: string }).detail, /not what would be signed/);
});

test('after formation every request is read, noted, drafted and proposed with receipts; nothing asks; each effect carries its own bound authorisation', async () => {
  const { host, home, triage, mailbox } = await formed();
  const v = await view(host);
  const run = triage.stored.runs.at(-1)!;
  assert.equal(run.outcome, 'done', run.reason ?? '');
  assert.equal(run.modelTurns, SMALL.length, 'one model turn per request, none extra for authority');
  assert.equal(v.brief.counts.read, SMALL.length);
  // m01 and m22 need a reply; m05 is a newsletter; m07 phishing and m08 suspicious get none.
  assert.deepEqual(v.brief.done.filter((d) => d.outcome === 'DONE').map((d) => d.message.id).sort(), ['m01', 'm22']);
  for (const d of v.brief.done) assert.deepEqual([d.recovery, d.decidable], ['exact-undo', false]);
  const proposals = Object.fromEntries(v.brief.proposed.map((p) => [p.message.id, p]));
  assert.equal(proposals.m05.summary, 'Move to Archive, labelled Newsletters');
  assert.equal(proposals.m07.summary, 'Move to Spam');
  assert.equal(proposals.m01.summary, 'Label: add Billing');
  for (const p of v.brief.proposed) assert.deepEqual([p.outcome, p.recovery, p.decidable], ['PROPOSED', 'exact-undo', true]);
  assert.equal(proposals.m05.undo, 'Move it back to the inbox; Remove the label Newsletters');
  assert.equal(mailbox.truth.applied.length, 0, 'nothing is applied to the mailbox');
  const link = await core(home);
  try {
    const cap = triage.current()!;
    const { rows } = await link.read<{ id: string; operation: string; args: Record<string, unknown>; args_hash: string; hash: string; expected_version: string | null; mandate_id: string; status: string; decision_id: string | null }>(
      link.system(),
      `SELECT id, operation, args, args_hash, sec.args_hash(args) AS hash, expected_version, mandate_id, status, decision_id FROM app.effects WHERE run_id = $1`,
      [run.run],
    );
    const drafts = rows.filter((r) => r.operation === 'workspace.write_document');
    assert.equal(drafts.length, 2);
    for (const d of drafts) {
      assert.equal(d.args_hash, d.hash, 'its own hash of its exact arguments');
      assert.equal(d.expected_version, (d.args as { message_version: string }).message_version, 'bound to the version of the message it answers');
      assert.equal(d.mandate_id, cap.mandate, 'under the authority current at that moment');
      assert.equal(d.decision_id, null, 'no question for work inside the capability');
    }
    // Questions are opened only for proposals (class 3), which wait in the brief: no interruption.
    assert.equal(rows.filter((r) => r.decision_id).length, v.brief.counts.proposed);
    // A draft's claim was single-use: it cannot begin a dispatch again.
    await assert.rejects(link.call(link.system(), 'SELECT gov.begin_dispatch($1, $2)', [drafts[0].id, 'any-claim']), (e: unknown) => e instanceof CoreRefusal && e.reason === 'stale');
    const { rows: marks } = await link.read<{ tainted_untrusted: boolean }>(link.system(), 'SELECT tainted_untrusted FROM app.runs WHERE id = $1', [run.run]);
    assert.equal(marks[0].tainted_untrusted, true, 'reading mail marks the run untrusted');
  } finally {
    await link.release();
  }
  // Drafts open in the viewer, addressed to the requester.
  const draft = v.brief.done.find((d) => d.message.id === 'm01')!;
  const text = value(await host.call('material.read', { id: draft.materialId! })).text!;
  assert.match(text, /^To: Dana Whitfield <dana\.whitfield@harborlight\.example>\nSubject: Re: Charged twice for INV-2291\n/);
});

test('A7: a widening on each axis needs a new signature; a narrowing does not', async () => {
  const { host, triage } = await formed();
  const cap = triage.current()!;
  const p = cap.payload;
  const later = new Date(Date.parse(p.expiresAt) + 86_400_000).toISOString();
  const wider: [string, CapabilityPayload][] = [
    ['class', { ...p, classes: [...p.classes, { operation: 'mail.trash', effectClass: 4, mode: 'propose', recovery: 'bounded-cancellation' }] }],
    ['class', { ...p, classes: p.classes.map((c) => (c.operation === 'mail.label' ? { ...c, mode: 'act' as const } : c)) }],
    ['destination', { ...p, destinations: { ...p.destinations, drafts: 'any' as never } }],
    ['scope', { ...p, scope: { ...p.scope, folders: ['INBOX', 'SENT'] } }],
    ['pinned version', { ...p, pins: { ...p.pins, adapter: { ...p.pins.adapter, version: '0.0.1', digest: `sha256:${'1'.repeat(64)}` } } }],
    ['pinned version', { ...p, pins: { ...p.pins, model: { ...p.pins.model, model: 'scripted-model-2' } } }],
    ['expiry', { ...p, expiresAt: later }],
    ['budget', { ...p, budget: { ...p.budget, effectsPerDay: p.budget.effectsPerDay + 1 } }],
  ];
  for (const [axis, next] of wider) {
    assert.deepEqual(widenings(p, next), [axis]);
    await assert.rejects(triage.change(next), new RegExp(`widens the capability \\(${axis}\\); it needs a new signature`));
  }
  // Narrowing applies without a signature, as a child grant the core keeps within its parent.
  const narrower = { ...p, expiresAt: new Date(Date.parse(p.expiresAt) - 86_400_000).toISOString() };
  const changed = await triage.change(narrower);
  assert.equal(changed.mandates.length, 2);
  // A widening someone proposes is offered for a new signature: version 2, the old grant ends.
  triage.propose({ ...p, version: 2, expiresAt: later });
  const offer = (await view(host)).offer!;
  assert.deepEqual(offer.widening, ['expiry']);
  const v2 = value(await host.signCapability({ hash: offer.hash, presence: 'device-password' }));
  assert.deepEqual([v2.version, v2.state, v2.signedWith], [2, 'active', 'device-password']);
  assert.equal(triage.stored.capabilities[0].state, 'revoked');
  assert.match(triage.stored.capabilities[0].reason ?? '', /Superseded by version 2/);
});

test('A7: an anomaly suspends the capability and voids pending releases; re-signing needs live underlying authority and makes a new grant', async () => {
  const { host, home, triage } = await formed();
  const before_ = await view(host);
  assert.ok(before_.brief.counts.proposed > 0);
  const old = triage.current()!.mandate;
  await triage.suspend('The door recorded an anomaly.');
  const v = await view(host);
  assert.equal(v.capability?.state, 'suspended');
  assert.equal(v.capability?.reason, 'The door recorded an anomaly.');
  assert.ok(v.brief.proposed.every((p) => p.outcome === 'CANCELLED'), 'pending releases are voided');
  // The same capability may be signed again while the connection and the entitlement stand.
  assert.equal(v.offer?.hash, v.capability?.hash, 'the same payload, unchanged');
  const again = value(await host.signCapability({ hash: v.offer!.hash, presence: 'touch-id' }));
  assert.equal(again.state, 'active');
  assert.notEqual(triage.current()!.mandate, old, 'a new grant, never the old one revived');
  const link = await core(home);
  try {
    assert.equal(await link.call<boolean>(link.person(), 'SELECT revoked_at IS NOT NULL FROM app.mandates WHERE id = $1', [old]), true);
  } finally {
    await link.release();
  }
  // The voided proposals are proposed anew under the new grant, from the notes already taken.
  const turns = triage.stored.runs.reduce((n, r) => n + r.modelTurns, 0);
  await triage.run('person');
  assert.equal(triage.stored.runs.reduce((n, r) => n + r.modelTurns, 0), turns, 'no extra model turn');
  assert.ok((await view(host)).brief.proposed.every((p) => p.outcome === 'PROPOSED'));
  // Without live underlying authority (the connection revoked), re-signing is refused.
  await triage.suspend('Another anomaly.');
  const linkB = await core(home);
  try {
    await linkB.call(linkB.person(), 'SELECT gov.revoke_mandate($1)', [triage.stored.connection!.mandate]);
  } finally {
    await linkB.release();
  }
  const refused = await host.signCapability({ hash: (await view(host)).offer!.hash, presence: 'touch-id' });
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.detail : '', /connection no longer stands/);
});

test('A2: a revocation mid-job stops the run at once, cancels what was not sent, and re-signing does not revive it', async () => {
  const { host, home, triage, mailbox } = job({ latencyMs: 60 }, freshHome());
  value(await host.call('triage.connect', {}));
  const offer = (await view(host)).offer!;
  value(await host.signCapability({ hash: offer.hash, presence: 'touch-id' }));
  const running = triage.run('person');
  await pollUntil(async active => { while (active() && (Object.values(triage.stored.items).filter((x) => x.done).length < 2)) await new Promise((r) => setTimeout(r, 10)); }, "packages/platform/test/triage.test.ts:266 polling state");
  value(await host.call('triage.disconnect', {}));
  const run = await running;
  assert.equal(run.outcome, 'revoked', run.reason ?? '');
  const v = await view(host);
  assert.equal(v.capability?.state, 'revoked');
  assert.match(v.brief.stopped ?? '', /grant no longer stands|revoked/i);
  const handled = Object.values(triage.stored.items).filter((x) => x.done).length;
  assert.ok(handled < SMALL.length, `the run stopped before the end (${handled} handled)`);
  assert.ok(v.brief.proposed.every((p) => p.outcome !== 'PROPOSED'), 'nothing waits on a revoked grant');
  // Signing the revoked capability again is refused, and its run stays cancelled.
  const again = await host.signCapability({ hash: offer.hash, presence: 'touch-id' });
  assert.equal(again.ok, false);
  const link = await core(home);
  try {
    const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.runs WHERE id = $1', [run.run]);
    assert.notEqual(rows[0].status, 'running');
    const { rows: m } = await link.read<{ revoked: boolean }>(link.person(), 'SELECT revoked_at IS NOT NULL AS revoked FROM app.mandates WHERE intent_hash = $1', [offer.hash]);
    assert.deepEqual(m.map((x) => x.revoked), [true]);
  } finally {
    await link.release();
  }
  assert.deepEqual([mailbox.truth.applied.length, mailbox.truth.outbox.length], [0, 0], 'the mailbox is exactly as it was');
});

test('A4: the stop: nothing new starts, and a draft cut mid-write is UNKNOWN and never written again', async () => {
  const opened = open(undefined, { harness: 'harness-pi', mail: { connector: new FakeMailbox({ seed: inbox(['m01', 'm22', 'm05']) }) }, writeDelayMs: 300 });
  const h = opened.host;
  const t = h.triage!;
  value(await h.call('triage.connect', {}));
  value(await h.signCapability({ hash: (await view(h)).offer!.hash, presence: 'touch-id' }));
  const running = t.run('person');
  await waitFor(() => !!t.stored.items.m01?.draft?.effect, 'draft enters the effect ledger before Stop', { diagnostic: () => JSON.stringify(t.stored.items.m01) });
  await new Promise((r) => setTimeout(r, 80));
  value(await h.call('triage.stop', {}));
  const run = await running;
  assert.equal(run.outcome, 'stopped');
  const v = await view(h);
  const draft = v.brief.done.find((d) => d.message.id === 'm01')!;
  assert.equal(draft.outcome, 'UNKNOWN');
  assert.equal(v.brief.counts.read, 1, 'nothing new started after the stop');
  // The next run carries on; the UNKNOWN draft is not written again.
  await t.run('person');
  const after_ = await view(h);
  assert.equal(after_.brief.done.find((d) => d.message.id === 'm01')!.outcome, 'UNKNOWN');
  assert.equal((await h.call('material.list', { projectId: after_.projectId! })).filter((m) => m.name.includes('(m01)')).length, 0);
  assert.equal(after_.brief.done.find((d) => d.message.id === 'm22')!.outcome, 'DONE');
});

test('A1: a kill mid-job: the restarted app carries on at the next request; the draft cut mid-write is settled, never written twice', async () => {
  const home = freshHome();
  const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-triage.ts'), home], {
    env: { ...process.env, BACKBONE_HARNESS: 'harness-pi', BACKBONE_CRASH_AT: 'triage.draft.begun' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b.toString()));
  child.stderr.on('data', (b: Buffer) => (out += b.toString()));
  const code = await new Promise<number | string | null>((r) => child.on('exit', (c, s) => r(c ?? s)));
  assert.equal(code, 'SIGKILL', out);
  const { host } = open(home, { harness: 'harness-pi' });
  const t = host.triage!;
  await t.recover();
  const run = await t.run('person');
  assert.equal(run.outcome, 'done', run.reason ?? '');
  const v = await view(host);
  const first = v.brief.done[0];
  assert.equal(first.outcome, 'UNKNOWN', 'the draft the kill cut is UNKNOWN');
  const projectFiles = await host.call('material.list', { projectId: v.projectId! });
  assert.equal(projectFiles.filter((m) => m.name.includes(`(${first.message.id})`)).length, 0, 'never written twice, nor once by a replay');
  assert.ok(v.brief.done.slice(1).every((d) => d.outcome === 'DONE'), 'the rest carried on');
  assert.equal(new Set(v.brief.done.map((d) => d.message.id)).size, v.brief.done.length, 'one draft per request');
  assert.equal(t.stored.runs.filter((r) => r.reason?.startsWith('Interrupted')).length, 1);
});

test('A3: a provider timeout leaves an accepted change UNKNOWN; the same change is refused under any key; a probe settles it; nothing is applied twice', async () => {
  const { host, home, triage, mailbox } = await formed({ writes: 'open', faults: [{ at: 'modify', kind: 'timeout-after-commit' }] });
  const p = (await view(host)).brief.proposed.find((x) => x.message.id === 'm01')!;
  // The provider applies it and the reply is lost: the probe right after finds it applied.
  value(await host.call('triage.decide', { effect: p.effect, verdict: 'accept' }));
  assert.equal(mailbox.truth.applied.length, 1);
  const link = await core(home);
  try {
    const { rows } = await link.read<{ status: string; note: string }>(link.system(), 'SELECT status, note FROM app.effects WHERE id = $1', [p.effect]);
    assert.equal(rows[0].status, 'succeeded');
    assert.match(rows[0].note, /provider probe/);
    const { rows: ledger } = await link.read<{ kind: string }>(link.system(), "SELECT entry_type AS kind FROM app.ledger WHERE subject = $1 AND entry_type IN ('effect.observed', 'effect.reconciled') ORDER BY seq", [p.effect]);
    assert.deepEqual(ledger.map((l) => l.kind), ['effect.observed', 'effect.reconciled'], 'observed UNKNOWN, then reconciled');
  } finally {
    await link.release();
  }
});

test('A3: while it is UNKNOWN the same change is refused under a new key, and a probe that cannot tell leaves it for the person', async () => {
  const { host, home, triage, mailbox } = await formed({ writes: 'open', faults: [{ at: 'modify', kind: 'timeout-before-commit' }] });
  const p = (await view(host)).brief.proposed.find((x) => x.message.id === 'm01')!;
  // Something else changes the message, so a probe cannot tell what became of the lost request.
  const realProbe = mailbox.probe.bind(mailbox);
  mailbox.probe = async () => ({ landed: null, evidence: 'cannot tell' });
  value(await host.call('triage.decide', { effect: p.effect, verdict: 'accept' }));
  assert.equal((await view(host)).brief.proposed.find((x) => x.effect === p.effect)!.outcome, 'UNKNOWN');
  // The job's next run adopts the UNKNOWN change and proposes nothing new for it.
  triage.stored.items.m01.done = false;
  await triage.run('person');
  const link = await core(home);
  try {
    const labelsOf = async () => (await link.read<{ id: string }>(link.system(), "SELECT id FROM app.effects WHERE operation = 'mail.label' AND args->>'id' = 'm01'")).rows.length;
    assert.equal(await labelsOf(), 1);
    // And whoever proposes the same change under a new key, in a new run, is refused by the core: never resent.
    const { rows: [was] } = await link.read<{ args: unknown; expected_version: string }>(link.system(), 'SELECT args, expected_version FROM app.effects WHERE id = $1', [p.effect]);
    const conn = triage.stored.connection!;
    const h = await link.startRunUnder(conn.task, conn.agent, triage.current()!.mandate, conn.registration.id);
    const id = await link.call<string>(link.runOf(h), `SELECT gov.propose_effect($1, $2, NULL, 'mail', 'mail.label', NULL, NULL, 3::smallint, true, $3::jsonb, 'the same change again', $4, 'a-new-key')`, [h.run, h.fence, JSON.stringify(was.args), was.expected_version]);
    const { rows } = await link.read<{ status: string; route_reason: string }>(link.system(), 'SELECT status, route_reason FROM app.effects WHERE id = $1', [id]);
    assert.deepEqual([rows[0].status, rows[0].route_reason], ['denied', 'repeat_unknown_blocked']);
    await link.finishRun(h, 'failed');
  } finally {
    await link.release();
  }
  assert.equal(mailbox.truth.applied.length, 0, 'never sent again');
  mailbox.probe = realProbe;
  assert.equal(await triage.reconcile(p.effect), 'failed', 'a probe that can tell settles it: unchanged since, so it never landed');
});

test('A5: an injected instruction is data: no forward exists, the draft goes to the requester alone, nothing leaves', async () => {
  const { host, home, triage, mailbox } = await formed();
  const v = await view(host);
  const m08 = v.brief.requests.find((r) => r.id === 'm08')!;
  assert.equal(m08.suspicious, true);
  assert.match(m08.needsYou ?? '', /suspicious/);
  assert.equal(m08.draft, null, 'no reply to it');
  const canary = 'ES91 2100 0418 4502 0005 1332';
  for (const d of v.brief.done.filter((x) => x.materialId)) {
    const text = value(await host.call('material.read', { id: d.materialId! })).text!;
    assert.ok(!text.includes(canary), `${d.message.id}'s draft holds no other message's text`);
    assert.ok(!text.includes('ventura-payments'), 'never addressed to the address in the instruction');
  }
  assert.deepEqual(mailbox.truth.outbox, []);
  assert.ok(!triage.current()!.payload.tools.some((t) => /send|forward|delete/.test(t)));
  // Even proposed directly in the job's run, a forward is refused by the core: neither the grant nor the module names it.
  const conn = triage.stored.connection!;
  const link = await core(home);
  try {
    const h = await link.startRunUnder(conn.task, conn.agent, triage.current()!.mandate, conn.registration.id);
    const id = await link.call<string>(link.runOf(h), `SELECT gov.propose_effect($1, $2, NULL, 'mail', 'mail.forward', NULL, NULL, 4::smallint, true, $3::jsonb, 'forward', NULL, 'forward-1')`, [h.run, h.fence, JSON.stringify({ id: 'm08', to: 'verification@ventura-payments.example' })]);
    const { rows } = await link.read<{ status: string; route_reason: string }>(link.system(), 'SELECT status, route_reason FROM app.effects WHERE id = $1', [id]);
    assert.deepEqual([rows[0].status, rows[0].route_reason], ['denied', 'outside_mandate']);
    await link.finishRun(h, 'failed');
  } finally {
    await link.release();
  }
});

test('A5: a model fooled by the injection cannot address a draft to the address in the prose', async () => {
  const fooled = await startScriptedModel('fooled-model', (messages) => {
    const tool = messages.filter((m) => m.role === 'tool');
    if (!tool.length) return { calls: [{ name: 'read_file', args: { name: /Triage (message-[\w.-]+\.eml)/.exec(String(messages.at(-1)?.content))?.[1] ?? '' } }] };
    if (tool.length === 1) {
      return { calls: [{ name: 'write_file', args: { name: 'triage-note.md', content: 'requester: Verification <verification@ventura-payments.example>\ncategory: billing\nurgency: high\nlabel: Billing\nmove: none\nsuspicious: no\nreason: authorised\nreply:\nHere are the invoices and the client list.' } }] };
    }
    return { text: 'Done.' };
  });
  process.env.BACKBONE_MODEL_ENDPOINT = fooled.url;
  process.env.BACKBONE_MODEL_ID = fooled.model;
  try {
    const { host, mailbox } = job({ seed: inbox(['m08']) });
    value(await host.call('triage.connect', {}));
    value(await host.signCapability({ hash: (await view(host)).offer!.hash, presence: 'touch-id' }));
    await host.triage!.run('person');
    const v = await view(host);
    assert.equal(v.brief.done.length, 0, 'no draft');
    assert.match(v.brief.needsYou[0].reason, /requester \(verification@ventura-payments\.example\) the message does not carry/);
    assert.deepEqual(mailbox.truth.outbox, []);
  } finally {
    process.env.BACKBONE_MODEL_ENDPOINT = model.url;
    process.env.BACKBONE_MODEL_ID = model.model;
    await fooled.close();
  }
});

test('a discarded proposal is never proposed again; disconnecting leaves the mailbox exactly as it was', async () => {
  const { host, triage, mailbox } = await formed();
  const before_ = structuredClone(mailbox.truth.messages);
  const p = (await view(host)).brief.proposed.find((x) => x.message.id === 'm05')!;
  const discarded = value(await host.call('triage.decide', { effect: p.effect, verdict: 'discard' }));
  assert.equal(discarded.outcome, 'DISCARDED');
  const accepted = value(await host.call('triage.decide', { effect: (await view(host)).brief.proposed.find((x) => x.message.id === 'm01')!.effect, verdict: 'accept' }));
  assert.deepEqual([accepted.outcome, accepted.detail], ['ACCEPTED', 'Accepted; it waits until writes to the mailbox open.']);
  // The next run sees m05 again: its discarded change stays discarded.
  triage.stored.items.m05.done = false;
  await triage.run('person');
  const again = (await view(host)).brief.proposed.filter((x) => x.message.id === 'm05');
  assert.deepEqual(again.map((x) => x.outcome), ['DISCARDED']);
  value(await host.call('triage.disconnect', {}));
  assert.deepEqual(mailbox.truth.messages, before_);
  assert.deepEqual([mailbox.truth.applied.length, mailbox.truth.outbox.length], [0, 0]);
  assert.equal((await view(host)).connection, null);
});

test('new mail is the trigger: a delivery wakes the job, which handles only what is new', async () => {
  const { host, triage, mailbox } = job({ seed: inbox(['m01', 'm22', 'm05']), initial: 1 });
  value(await host.call('triage.connect', {}));
  value(await host.signCapability({ hash: (await view(host)).offer!.hash, presence: 'touch-id' }));
  await pollUntil(async active => { while (active() && (triage.isRunning())) await new Promise((r) => setTimeout(r, 10)); }, "packages/platform/test/triage.test.ts:469 polling state");
  const runs = triage.stored.runs.length;
  mailbox.deliver(2);
  await pollUntil(async active => { for (let i = 0; (active() && (triage.stored.runs.length === runs || triage.isRunning())); i++) await new Promise((r) => setTimeout(r, 10)); }, "packages/platform/test/triage.test.ts:472 polling state");
  const last = triage.stored.runs.at(-1)!;
  assert.equal(last.trigger, 'new-mail');
  assert.equal(last.handled, 2);
  assert.equal((await view(host)).brief.counts.requests, 3);
});

test('a pinned revision that moved stops the job until the capability is signed again', async () => {
  const { host, triage } = await formed();
  process.env.BACKBONE_MODEL_ID = 'another-model';
  try {
    const run = await triage.run('person');
    assert.equal(run.outcome, 'refused');
    assert.match(run.reason ?? '', /sign the capability again/);
    const offer = (await view(host)).offer!;
    assert.deepEqual(offer.widening, ['pinned version']);
  } finally {
    process.env.BACKBONE_MODEL_ID = model.model;
  }
});

test('the entitlement lost at the provider suspends the capability before anything is read', async () => {
  const j = await formed();
  const reads = (await view(j.host)).brief.counts.read;
  (j.mailbox as unknown as { entitlement: () => Promise<unknown> }).entitlement = async () => ({ ok: false, provider: 'fake', account: j.mailbox.account, missing: ['permission to read mail'], detail: 'The account no longer grants reading.' });
  const run = await j.triage.run('person');
  assert.equal(run.outcome, 'refused');
  assert.equal((await view(j.host)).capability?.state, 'suspended');
  assert.equal((await view(j.host)).brief.counts.read, reads);
  void SCOPES;
});

test('a message that changes at the provider never buries the draft the person saved', async () => {
  const { host, triage, mailbox } = await formed();
  const item = (await view(host)).brief.done[0];
  const draft = (await host.call('material.list', { projectId: triage.stored.connection!.projectId })).find((m) => m.id === item.materialId)!;
  value(await host.call('material.save', { id: draft.id, text: 'To: x\n\nThe person wrote this.\n', baseVersion: 1 }));
  const list = mailbox.list.bind(mailbox), read = mailbox.read.bind(mailbox);
  mailbox.list = async (after) => { const l = await list(after); return { ...l, messages: l.messages.map((m) => ({ ...m, version: `${m.version}+read` })) }; };
  mailbox.read = async (id) => { const m = await read(id); return { ...m, version: `${m.version}+read` }; };
  await triage.run('person');
  const drafts = (await host.call('material.list', { projectId: triage.stored.connection!.projectId })).filter((m) => m.name === draft.name);
  assert.deepEqual(drafts.map((m) => m.id), [draft.id]);
  assert.match(value(await host.call('material.read', { id: draft.id })).text!, /The person wrote this/);
});

test('A5: a requester found only in the body is flagged, and a name cannot carry an address', () => {
  const task = { categories: [{ id: 'billing', definition: '', label: 'Billing' }], urgency: [{ id: 'normal', definition: '' }], moves: [], context: '', requester: '', suspicious: '', reply: '' };
  const note = (requester: string) => parseNote(`requester: ${requester}\ncategory: billing\nurgency: normal\nlabel: none\nmove: none\nsuspicious: no\nreason: -\nreply: none\n`, task as never, []);
  assert.equal(note('Alice <a@x.example>').ok, true);
  assert.equal(note('bcc@evil.example, Alice <a@x.example>').ok, false);
  const message = { from: { name: '', address: 'a@x.example' }, to: [], cc: [], body: 'Email: evil@evil.example\n' } as never;
  assert.equal(addressesIn(message).has('evil@evil.example'), true);
  assert.equal(headerAddresses(message).has('evil@evil.example'), false);
});

test('triage on real Pi stops model egress when policy changes during its first request', async t => {
  let fixture: ReturnType<typeof systemFixture>;
  const local = await startScriptedModel('scripted-model', undefined, { before() { fixture.update(document({ modelProviders: ['openai'] })); } });
  t.after(() => local.close());
  const priorEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, priorModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = local.url; process.env.BACKBONE_MODEL_ID = local.model;
  t.after(() => { process.env.BACKBONE_MODEL_ENDPOINT = priorEndpoint; process.env.BACKBONE_MODEL_ID = priorModel; });
  const j = job({ initial: 2 });
  fixture = systemFixture(t, document());
  value(await j.host.call('triage.connect', {}));
  const result = await j.triage.run('person');
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason!, /Managed policy refused/);
  assert.equal(local.requests.length, 1, 'no continuation or later message reaches the forbidden model route');
});
