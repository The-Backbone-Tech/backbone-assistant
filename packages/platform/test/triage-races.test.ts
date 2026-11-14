import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FakeMailbox, readSeed } from '@backbone-next/connector-mail';
import { CoreLink } from '../src/composition/core.ts';
import { startScriptedModel, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { TriageService, type TriageDeps } from '../src/triage/service.ts';
import { open, value } from './helpers.ts';
const gate = () => { let release!: () => void; const promise = new Promise<void>((r) => release = r); return { promise, release }; };
let model: ScriptedModel;
before(async () => { model = await startScriptedModel(); process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model; });
after(async () => { delete process.env.BACKBONE_MODEL_ENDPOINT; delete process.env.BACKBONE_MODEL_ID; await model.close(); });
async function setup(form = true) {
  const seed = readSeed(); const mailbox = new FakeMailbox({ writes: 'open', seed: { ...seed, messages: seed.messages.slice(0, 1) } });
  const opened = open(undefined, { harness: 'harness-pi', mail: { connector: mailbox } });
  const triage = opened.host.triage!, deps = (triage as unknown as { deps: TriageDeps }).deps;
  if (form) {
    value(await opened.host.call('triage.connect', {}));
    value(await opened.host.signCapability({ hash: (await opened.host.call('triage.get', {})).offer!.hash, presence: 'touch-id' }));
    await triage.whenIdle();
  }
  return { ...opened, mailbox, triage, deps, link: await deps.link() };
}

test('a late Connect cannot survive a completed Disconnect', async () => {
  const c = await setup(false), entered = gate(), release = gate(); const call = c.link.call.bind(c.link);
  c.link.call = (async (...args: Parameters<typeof c.link.call>) => { const value = await call(...args); if (args[1].includes('gov.issue_mandate')) { entered.release(); await release.promise; } return value; }) as typeof c.link.call;
  try {
    const connecting = c.triage.connect(), rejected = assert.rejects(connecting, /changed|disconnect|ended/i);
    await entered.promise;
    const disconnecting = c.triage.disconnect(); release.release(); await Promise.all([disconnecting, rejected]);
    assert.equal(c.triage.stored.connection, null);
    const rows = (await c.link.read(c.link.person(), "SELECT id FROM app.mandates WHERE intent->>'job' = 'mail-triage' AND revoked_at IS NULL")).rows;
    assert.equal(rows.length, 0);
  } finally { release.release(); }
});

for (const action of ['stop', 'revoke'] as const) test(`undo paused at the core reply cannot dispatch after ${action}`, async () => {
  const c = await setup(), entered = gate(), release = gate();
  const p = (await c.host.call('triage.get', {})).brief.proposed[0];
  value(await c.host.call('triage.decide', { effect: p.effect, verdict: 'accept' }));
  const n = c.mailbox.truth.applied.length, call = c.link.call.bind(c.link);
  c.link.call = (async (...args: Parameters<typeof c.link.call>) => { const value = await call(...args); if (args[1].includes('gov.propose_undo')) { entered.release(); await release.promise; } return value; }) as typeof c.link.call;
  try {
    const undoing = c.host.call('triage.undo', { effect: p.effect }); await entered.promise;
    if (action === 'stop') c.triage.stop(); else await c.triage.revoke();
    release.release(); const result = await undoing;
    assert.ok(!result.ok || result.value.outcome !== 'DONE');
    assert.equal(c.mailbox.truth.applied.length, n);
  } finally { release.release(); }
});

test('UNKNOWN reconciliation never probes a replacement account', async () => {
  const c = await setup(), entered = gate(), release = gate();
  const p = (await c.host.call('triage.get', {})).brief.proposed[0];
  c.mailbox.apply = async () => { entered.release(); await release.promise; throw new Error('no provider answer'); };
  const deciding = c.host.call('triage.decide', { effect: p.effect, verdict: 'accept' });
  try {
    await entered.promise; await c.triage.disconnect();
    const seed = readSeed(); const message = structuredClone(seed.messages[0]); message.labels.push('Label_billing');
    const replacement = new FakeMailbox({ writes: 'open', seed: { ...seed, account: 'other@example.test', messages: [message] } });
    let probes = 0; const probe = replacement.probe.bind(replacement); replacement.probe = async (op) => { probes++; return probe(op); };
    const mail = c.deps.mail.bind(c.deps); c.deps.mail = async (...args) => ({ ...await mail(...args), connector: replacement });
    await c.triage.connect(); release.release(); await deciding;
    assert.equal(probes, 0);
    assert.equal((await c.triage.effects()).get(p.effect)!.status, 'unknown');
  } finally { release.release(); }
});

test('two same-home renewals cannot leave two independently spendable daily roots', async () => {
  const c = await setup();
  const other = new TriageService(c.deps), next = structuredClone(c.triage.current()!.payload);
  next.budget.effectsPerDay = 10;
  try {
    await Promise.allSettled([c.triage.change(next), other.change(next)]);
    const rows = (await c.link.read<{ id: string }>(c.link.person(), 'SELECT id FROM app.mandates WHERE intent_hash = $1 AND revoked_at IS NULL', [c.triage.current()!.hash])).rows;
    assert.equal(rows.length, 1, 'the budget is shared by one live daily root');
  } finally { other.close(); }
});

test('retained UNKNOWN keeps its original binding after the item projection is replaced', async () => {
  const c = await setup(), p = (await c.host.call('triage.get', {})).brief.proposed[0];
  const probe = c.mailbox.probe.bind(c.mailbox);
  c.mailbox.apply = async () => { throw new Error('provider did not receive the request'); };
  c.mailbox.probe = async () => ({ landed: null, evidence: 'initially unavailable' });
  value(await c.host.call('triage.decide', { effect: p.effect, verdict: 'accept' }));
  const statePath = join(c.home, 'triage', 'state.json');
  const lostProjection = JSON.parse(readFileSync(statePath, 'utf8'));
  lostProjection.items = {}; lostProjection.bindings = {};
  writeFileSync(statePath, JSON.stringify(lostProjection));
  rmSync(join(c.home, 'triage', 'items'), { recursive: true, force: true });
  const restarted = new TriageService(c.deps);
  c.mailbox.probe = probe;
  assert.equal(await restarted.reconcile(p.effect), 'failed', 'the original receipt binding permits the read-only probe');
  restarted.close();
  assert.equal(c.mailbox.truth.applied.length, 0);
});


test('recovery finds a core run whose creation reply never reached the home journal', async () => {
  const c = await setup(), conn = c.triage.stored.connection!;
  const link = await CoreLink.open({ home: c.home });
  const orphan = await link.startRunUnder(conn.task, conn.agent, c.triage.current()!.mandate, conn.registration.id);
  await link.release();
  await c.triage.recover(); await c.triage.whenIdle();
  const record = c.triage.stored.runs.find((r) => r.run === orphan.run);
  assert.ok(record?.endedAt, 'a missing creation reply cannot hide the core run from recovery');
  assert.equal(record.outcome, 'failed');
});


test('disconnect/reconnect isolates colliding message IDs and versions through the real host', async () => {
  const c = await setup(), originalMail = c.deps.mail.bind(c.deps);
  await c.triage.whenIdle();
  const firstSubject = c.triage.stored.items.m01.subject, firstProject = c.triage.stored.connection!.projectId;
  await c.triage.disconnect();
  const seed = readSeed(), message = { ...seed.messages[0], subject: 'A distinct message in the second account' };
  const replacement = new FakeMailbox({ seed: { ...seed, account: 'second@example.test', messages: [message] } });
  c.deps.mail = async (...args) => ({ ...await originalMail(...args), connector: replacement });
  await c.triage.connect();
  const offer = (await c.host.call('triage.get', {})).offer!;
  value(await c.host.signCapability({ hash: offer.hash, presence: 'touch-id' }));
  await c.triage.whenIdle();
  assert.equal(c.triage.stored.items.m01.subject, message.subject);
  assert.notEqual(c.triage.stored.items.m01.subject, firstSubject);
  assert.equal(c.triage.stored.items.m01.mailbox!.account, replacement.account);
  assert.notEqual(c.triage.stored.connection!.projectId, firstProject, "mailboxes do not overwrite the same projected draft folder");
  const restarted = new TriageService(c.deps); await restarted.recover(); await restarted.whenIdle();
  try {
    const brief = (await c.host.call('triage.get', {})).brief;
    assert.equal(brief.requests.length, 1);
    assert.equal(brief.requests[0].subject, message.subject);
    assert.equal(restarted.stored.items.m01.subject, message.subject);
  } finally { restarted.close(); }
});


test('a retained UNKNOWN with different reply words survives reconnect without replacing a person edit', async () => {
  const c = await setup(); await c.triage.whenIdle();
  const item = c.triage.stored.items.m01, conn = c.triage.stored.connection!, cap = c.triage.current()!;
  assert.ok(item.draft);
  const original = (await c.link.read<{ args: Record<string, unknown>; expected_version: string }>(c.link.system(), 'SELECT args, expected_version FROM app.effects WHERE id = $1', [item.draft.effect])).rows[0];
  const h = await c.link.startRunUnder(conn.task, conn.agent, cap.mandate, conn.registration.id);
  const args = { ...original.args, content_sha256: createHash('sha256').update('A different regenerated reply').digest('hex') };
  const uncertain = await c.link.call<string>(c.link.runOf(h), `SELECT gov.propose_effect($1, $2, NULL, 'write', 'workspace.write_document', NULL, NULL, 2::smallint, false, $3::jsonb, 'alternate draft interrupted', $4, 'test:alternate-unknown-draft')`, [h.run, h.fence, JSON.stringify(args), original.expected_version]);
  const claim = await c.link.claimEffect(uncertain); assert.equal(await c.link.beginDispatch(uncertain, claim), true);
  await c.link.observe(uncertain, claim, 'unknown', 'a'.repeat(64), 'Synthetic interruption before material observation.');
  await c.link.finishRun(h, 'failed');
  const entry = value(await c.host.call('material.read', { id: item.draft.document })).entry;
  const personText = 'The person replaced these words and keeps the current version.';
  const saved = value(await c.host.call('material.save', { id: item.draft.document, text: personText, baseVersion: entry.current }));
  const before = [...(await c.triage.effects()).values()].filter((e) => e.operation === 'workspace.write_document').length;
  await c.triage.disconnect(); await c.triage.connect();
  const offer = (await c.host.call('triage.get', {})).offer!;
  value(await c.host.signCapability({ hash: offer.hash, presence: 'touch-id' })); await c.triage.whenIdle();
  assert.equal(c.triage.stored.connection!.task, conn.task);
  assert.equal([...(await c.triage.effects()).values()].filter((e) => e.operation === 'workspace.write_document').length, before);
  assert.equal((await c.triage.effects()).get(uncertain)!.status, 'unknown');
  const current = value(await c.host.call('material.read', { id: item.draft.document }));
  assert.ok('text' in current); assert.equal(current.text, personText); assert.equal(current.entry.current, saved.current);
  assert.match(c.triage.stored.items.m01.needsYou!, /unresolved|UNKNOWN/);
});
