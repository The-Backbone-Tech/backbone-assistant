// Try the core alone, with no app and no platform: a workspace, a mandate, a run, one effect through
// the gateway and its receipt, then a revoke and the refusal that follows.
//   node packages/core/examples/try-core.mjs
// It starts an embedded PostgreSQL 18 in a temporary folder, talks to it only through the core's
// gov.* crossings, and stops and removes everything at the end, even when a step fails. The database
// listens on 127.0.0.1: a sandbox that blocks local listening fails at step 1 with `listen EPERM`.
// Exit 0 means every step behaved as described; any mismatch exits 1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildBaseline, enter, openPersonalDatabase, reasonOf, serviceClient } from '@backbone/core/db';

const home = mkdtempSync(join(tmpdir(), 'backbone-try-core-'));
const say = (step, text) => console.log(`${step}. ${text}`);
let db;
let service;

// One transaction acting as `actor`; the crossings take identity from it and nothing else.
async function as(actor, sql, params = []) {
  await enter(service, actor);
  try {
    const { rows } = await service.query(sql, params);
    await service.query('COMMIT');
    return rows;
  } catch (error) {
    await service.query('ROLLBACK');
    throw error;
  }
}
const one = async (actor, sql, params) => Object.values((await as(actor, sql, params))[0])[0];

try {
  // The cluster's passwords are kept by whoever opens it: here only this process holds them, so
  // nothing is written in the clear and the throwaway cluster cannot be opened after the run.
  let kept = null;
  const passwords = { read: async () => kept, write: async (p) => void (kept = p) };
  db = await openPersonalDatabase({ dir: join(home, 'pg'), baselineSql: buildBaseline().sql, passwords });
  const operator = new pg.Client({ connectionString: db.operatorUrl });
  await operator.connect();
  const { rows: [made] } = await operator.query('SELECT * FROM operator.create_workspace($1, $2, $3, $4)', ['Try', 'personal', 'Owner', 'owner@example.com']);
  await operator.end();
  service = await serviceClient(db.appUrl);
  const ws = made.workspace_id;
  const person = { workspace: ws, principal: made.owner_id };
  const system = { workspace: ws, principal: made.system_id };
  say(1, `Workspace created in an embedded PostgreSQL; its owner and its system principal exist.`);

  const agent = await one(person, `SELECT gov.create_agent('Example worker', 'worker')`);
  const expires = new Date(Date.now() + 3_600_000);
  const mandate = await one(person, `SELECT gov.issue_mandate($1, NULL, '[]'::jsonb, '[]'::jsonb, '["example"]'::jsonb, '["outbox.write"]'::jsonb, 3::smallint, NULL, NULL, NULL, NULL, $2, 'direct')`, [agent, expires]);
  say(2, `Mandate issued to a worker: outbox.write only, up to class 3, for one hour.`);

  const task = await one(person, `SELECT gov.create_task($1, $1, 'Leave a note', NULL, NULL)`, [made.owner_id]);
  const queued = await one(person, 'SELECT gov.queue_run($1, $2, $3)', [task, agent, mandate]);
  const [claimed] = await as({ workspace: ws }, "SELECT fence, secret FROM gov.claim_run($1, $2, $3, 'direct')", [queued, 'example-worker', 600_000]);
  const run = { workspace: ws, run: { id: queued, secret: claimed.secret } };
  say(3, `Run queued under the mandate and claimed by a worker (fence ${claimed.fence}).`);

  const args = { name: 'hello.txt', content: 'hello from the core' };
  const propose = (key, a) =>
    one(run, `SELECT gov.propose_effect($1, $2, NULL, 'example', 'outbox.write', NULL, NULL, NULL, NULL, $3::jsonb, 'Leave a note in the outbox.', NULL, $4)`, [
      queued, Number(claimed.fence), JSON.stringify(a), key,
    ]);
  const effect = await propose('try-core-1', args);
  const proposed = (await as(run, 'SELECT status, effect_class FROM app.effects WHERE id = $1', [effect]))[0];
  assert.equal(proposed.status, 'allowed', JSON.stringify(proposed));
  say(4, `Effect proposed through the gateway: class ${proposed.effect_class}, ${proposed.status}.`);

  // The dispatcher is the system principal: it claims, begins, acts, then records what it observed.
  const claim = await one(system, 'SELECT gov.claim_effect($1, $2)', [effect, 60_000]);
  assert.equal(await one(system, 'SELECT gov.begin_dispatch($1, $2)', [effect, claim]), true);
  mkdirSync(join(home, 'outbox'));
  writeFileSync(join(home, 'outbox', args.name), args.content);
  const observed = createHash('sha256').update(readFileSync(join(home, 'outbox', args.name))).digest('hex');
  assert.equal(await one(system, `SELECT gov.observe_effect($1, $2, 'succeeded', NULL, $3, NULL)`, [effect, claim, observed]), 'succeeded');
  const [receipt] = await as(run, 'SELECT id, idempotency_key, operation, status, args_hash, observation_hash FROM app.effects WHERE id = $1', [effect]);
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.observation_hash, observed);
  say(5, `Receipt ${receipt.id}: ${receipt.operation} ${receipt.status}, key ${receipt.idempotency_key}, observation ${observed.slice(0, 12)}…`);

  const again = await propose('try-core-1', args);
  assert.equal(again, effect, 'the same key is the same effect');
  say(6, `The same idempotency key names the same effect: nothing is sent twice.`);

  const revoked = await one(person, 'SELECT gov.revoke_mandate($1)', [mandate]);
  say(7, `Mandate revoked (${revoked} mandate(s)); its run stops.`);

  let reason = null;
  try {
    await propose('try-core-2', { name: 'later.txt', content: 'too late' });
  } catch (error) {
    reason = reasonOf(error);
  }
  assert.ok(reason, 'a proposal after the revoke was accepted');
  const count = Number(await one(system, 'SELECT count(*) FROM app.effects WHERE run_id = $1', [queued]));
  assert.equal(count, 1, 'a refused proposal left an effect behind');
  say(8, `After the revoke the run's next proposal is refused: ${reason}. No effect was recorded.`);
  console.log('OK: workspace, mandate, run, effect, receipt, revoke and refusal all behaved as documented.');
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await service?.end().catch(() => {});
  await db?.stop().catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
