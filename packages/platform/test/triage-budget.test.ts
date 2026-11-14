// The signed daily allowance is enforced at the core crossing, including another consumer.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeMailbox, readSeed } from '@backbone-next/connector-mail';
import { CoreLink } from '../src/composition/core.ts';
import { startScriptedModel, type ScriptedModel } from '../src/testing/scripted-model.ts';
import { open, value } from './helpers.ts';

let model: ScriptedModel;
before(async () => { model = await startScriptedModel(); process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model; });
after(async () => { delete process.env.BACKBONE_MODEL_ENDPOINT; delete process.env.BACKBONE_MODEL_ID; await model.close(); });

test('R4: daily grants expire at the window boundary and narrowing subtracts spent effects', async () => {
  const seed = readSeed();
  const { host, home } = open(undefined, { harness: 'harness-pi', mail: { connector: new FakeMailbox({ seed: { ...seed, messages: [] } }) } });
  const triage = host.triage!;
  value(await host.call('triage.connect', {}));
  const offer = (await host.call('triage.get', {})).offer!;
  value(await host.signCapability({ hash: offer.hash, presence: 'touch-id' }));
  await triage.whenIdle();
  const link = await CoreLink.open({ home });
  try {
    const cap = triage.current()!;
    const old = cap.mandate;
    const grant = await link.read<{ max_effects: string; expires_at: Date }>(link.person(), 'SELECT max_effects, expires_at FROM app.mandates WHERE id = $1', [old]);
    assert.ok(Number(grant.rows[0].max_effects) <= cap.payload.budget.effectsPerDay, 'one day cannot spend the lifetime allowance');
    const tomorrow = new Date(); tomorrow.setUTCHours(24, 0, 0, 0);
    assert.ok(grant.rows[0].expires_at <= tomorrow, 'today’s authority cannot carry into tomorrow');
    const { rows: [used] } = await link.read<{ n: string }>(link.system(), "SELECT count(*) AS n FROM app.effects WHERE task_id = $1 AND status NOT IN ('denied','cancelled')", [triage.stored.connection!.task]);
    const next = structuredClone(cap.payload); next.budget.effectsPerDay = Number(used.n) + 3;
    await triage.change(next);
    const narrowed = (await link.read<{ max_effects: string }>(link.person(), 'SELECT max_effects FROM app.mandates WHERE id = $1', [cap.mandate])).rows[0];
    assert.equal(Number(narrowed.max_effects), 3, 'past spend is not reset by a narrower grant');
    const conn = triage.stored.connection!;
    await assert.rejects(link.startRunUnder(conn.task, conn.agent, old, conn.registration.id), /revoked/);
    // Another consumer uses the current grant directly, bypassing the triage loop.
    const h = await link.startRunUnder(conn.task, conn.agent, cap.mandate, conn.registration.id);
    for (let n = 0; n < 5; n++) await link.call(link.runOf(h), `SELECT gov.propose_effect($1,$2,NULL,'mail','mail.labels',NULL,NULL,1::smallint,true,'{}'::jsonb,'budget test',NULL,$3)`, [h.run, h.fence, `budget-${n}`]);
    const rows = (await link.read<{ status: string; route_reason: string }>(link.system(), 'SELECT status, route_reason FROM app.effects WHERE run_id = $1 ORDER BY created_at, id', [h.run])).rows;
    assert.equal(rows.filter((r) => r.status !== 'denied').length, 3);
    assert.equal(rows.filter((r) => r.route_reason === 'budget_exhausted').length, 2);
    await link.finishRun(h, 'failed');
  } finally { await link.release(); }
});

test('a pin-only replacement signature preserves the UTC day’s spent allowance', async () => {
  const seed = readSeed();
  const { host, home } = open(undefined, { harness: 'harness-pi', mail: { connector: new FakeMailbox({ seed: { ...seed, messages: [] } }) } });
  const triage = host.triage!;
  value(await host.call('triage.connect', {}));
  value(await host.signCapability({ hash: (await host.call('triage.get', {})).offer!.hash, presence: 'touch-id' }));
  await triage.whenIdle();
  const link = await CoreLink.open({ home }), previousModel = process.env.BACKBONE_MODEL_ID;
  try {
    const { rows: [used] } = await link.read<{ n: string }>(link.system(), "SELECT count(*) AS n FROM app.effects WHERE task_id = $1 AND status NOT IN ('denied','cancelled')", [triage.stored.connection!.task]);
    assert.ok(Number(used.n) > 0);
    process.env.BACKBONE_MODEL_ID = `${model.model}-replacement`;
    const offer = (await triage.offer())!;
    await triage.sign({ hash: offer.hash, presence: 'touch-id' });
    const cap = triage.current()!;
    const { rows: [grant] } = await link.read<{ max_effects: string }>(link.person(), 'SELECT max_effects FROM app.mandates WHERE id = $1', [cap.mandate]);
    assert.equal(Number(grant.max_effects), cap.payload.budget.effectsPerDay - Number(used.n));
  } finally { process.env.BACKBONE_MODEL_ID = previousModel; await link.release(); }
});
