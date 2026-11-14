// Confirmed inverses travel through the real governed undo crossing; no provider writes ship open.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeMailbox, readSeed } from '@backbone-next/connector-mail';
import { TriageService, type TriageDeps } from '../src/triage/service.ts';
import { CoreLink } from '../src/composition/core.ts';
import { startScriptedModel, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { open, value } from './helpers.ts';

let model: ScriptedModel;
before(async () => { model = await startScriptedModel(); process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model; });
after(async () => { delete process.env.BACKBONE_MODEL_ENDPOINT; delete process.env.BACKBONE_MODEL_ID; await model.close(); });

async function formed(id: string, confirmed = true) {
  const seed = readSeed();
  const messages = seed.messages.filter((m) => m.id === id);
  if (id === 'm05') messages[0].labels.push('Label_newsletters'); // Existing label must survive restoration.
  const mailbox = new FakeMailbox({ writes: 'open', seed: { ...seed, messages } });
  if (!confirmed) { const apply = mailbox.apply.bind(mailbox); mailbox.apply = async (op) => { const result = await apply(op); return { outcome: result.outcome, evidence: result.evidence }; }; }
  const opened = open(undefined, { harness: 'harness-pi', mail: { connector: mailbox } });
  const { host } = opened;
  value(await host.call('triage.connect', {}));
  value(await host.signCapability({ hash: (await host.call('triage.get', {})).offer!.hash, presence: 'touch-id' }));
  await host.triage!.whenIdle();
  const proposal = (await host.call('triage.get', {})).brief.proposed[0];
  const before = mailbox.truth.messages[0].labels;
  value(await host.call('triage.decide', { effect: proposal.effect, verdict: 'accept' }));
  return { ...opened, mailbox, proposal, before };
}

for (const id of ['m01', 'm05']) test(`R7: ${id} restores the actual change through a bound undo receipt`, async () => {
  const { host, home, mailbox, proposal, before } = await formed(id);
  const post = mailbox.truth.messages[0];
  const undone = value(await host.call('triage.undo', { effect: proposal.effect }));
  assert.equal(undone.outcome, 'DONE');
  assert.deepEqual(mailbox.truth.messages[0].labels.sort(), [...before].sort());
  const link = await CoreLink.open({ home });
  try {
    const { rows: [receipt] } = await link.read<{ undo_of: string; expected_version: string; args_hash: string; hash: string; note: string }>(link.system(), 'SELECT undo_of, expected_version, args_hash, sec.args_hash(args) AS hash, note FROM app.effects WHERE id = $1', [undone.effect]);
    assert.equal(receipt.undo_of, proposal.effect);
    assert.equal(receipt.expected_version, post.version);
    assert.equal(receipt.args_hash, receipt.hash);
    const { rows: [original] } = await link.read<{ note: string }>(link.system(), 'SELECT note FROM app.effects WHERE id = $1', [proposal.effect]);
    assert.equal(JSON.parse(original.note).recovery.request.version, post.version);
  } finally { await link.release(); }
  const n = mailbox.truth.applied.length;
  assert.equal((await host.call('triage.undo', { effect: proposal.effect })).ok, false);
  assert.equal(mailbox.truth.applied.length, n, 'the inverse is never sent again');
});

test('R7: stale inverses fail without changing the newer message', async () => {
  const { host, mailbox, proposal } = await formed('m01');
  const m = mailbox.truth.messages[0];
  const change = mailbox.classify({ op: 'modify', id: m.id, version: m.version, add: ['Label_team'], remove: [] }, await mailbox.labels());
  assert.ok(change.ok); await mailbox.apply(change.value);
  const before = mailbox.truth.messages, n = mailbox.truth.applied.length;
  const result = value(await host.call('triage.undo', { effect: proposal.effect }));
  assert.equal(result.outcome, 'FAILED');
  assert.deepEqual(mailbox.truth.messages, before);
  assert.equal(mailbox.truth.applied.length, n);
});

test('R7: a disconnected account cannot advertise or dispatch undo', async () => {
  const { host, mailbox, proposal } = await formed('m01');
  await host.triage!.disconnect();
  assert.equal((await host.call('triage.get', {})).brief.proposed.find((p) => p.effect === proposal.effect)!.undoable, false);
  const n = mailbox.truth.applied.length;
  assert.equal((await host.call('triage.undo', { effect: proposal.effect })).ok, false);
  assert.equal(mailbox.truth.applied.length, n);
});


test('R7: missing confirmed recovery is downgraded and never dispatched as undo', async () => {
  const { host, mailbox, proposal } = await formed('m01', false);
  const p = (await host.call('triage.get', {})).brief.proposed.find((p) => p.effect === proposal.effect)!;
  assert.equal(p.recovery, null);
  assert.equal(p.undo, null);
  assert.equal(p.undoable, false);
  const n = mailbox.truth.applied.length;
  assert.equal((await host.call('triage.undo', { effect: proposal.effect })).ok, false);
  assert.equal(mailbox.truth.applied.length, n);
});


test('a stale observer cannot hide a completed restoration from the brief', async () => {
  const { host, proposal } = await formed('m01');
  const deps = (host.triage! as unknown as { deps: TriageDeps }).deps;
  const stale = new TriageService(deps);
  try {
    const restored = value(await host.call('triage.undo', { effect: proposal.effect }));
    stale.stop();
    const brief = (await host.call('triage.get', {})).brief;
    assert.ok(brief.proposed.some((p) => p.effect === proposal.effect && p.outcome === 'DONE'));
    assert.ok(brief.proposed.some((p) => p.effect === restored.effect && p.outcome === 'DONE'));
  } finally { stale.close(); }
});
