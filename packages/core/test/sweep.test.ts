import { waitFor } from '../../../scripts/lib/test-hang.ts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enter, serviceClient } from '../src/db/session.ts';
import { startTestPostgres, type TestPostgres } from '../src/db/testing.ts';

/**
 * Settling a dispatch whose dispatcher went silent (effect-gateway contract, stale dispatch) is decided by the effect's own
 * dispatch claim alone, atomically in the core: never by a run's lease or status. A late observation
 * under the original claim may still settle what the sweep recorded UNKNOWN; it never resends.
 */
let postgres: TestPostgres;
let service: pg.Client;
let admin: pg.Client;
let ws: string;
let owner: string;
let system: string;
let run: { id: string; secret: string; fence: number };

type Actor = Parameters<typeof enter>[1];
const as = async <T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> => {
  await enter(service, actor);
  try {
    const rows = (await service.query(sql, params)).rows as T[];
    await service.query('COMMIT');
    return rows;
  } catch (error) {
    await service.query('ROLLBACK');
    throw error;
  }
};
const one = async <T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> => (await as<{ v: T }>(actor, `SELECT (${sql}) AS v`, params))[0]?.v as T;
const sys = () => ({ workspace: ws, principal: system });
const effectRow = async (id: string) =>
  (await as<{ status: string; settled_by: string | null; observation_hash: string | null; resolver_id: string | null }>(sys(), 'SELECT status, settled_by, observation_hash, resolver_id FROM app.effects WHERE id = $1', [id]))[0];

let n = 0;
/** An effect proposed by the run, claimed by the system principal and begun: in flight. */
async function inFlight(): Promise<{ id: string; claim: string }> {
  n++;
  const id = await one<string>({ workspace: ws, run }, `gov.propose_effect($1, $2, NULL, 'door', 'outbox.write', NULL, NULL, NULL, NULL, $3::jsonb, 'x', NULL, $4)`, [
    run.id,
    run.fence,
    JSON.stringify({ name: `f${n}.txt`, content: `c${n}` }),
    `sweep-${n}`,
  ]);
  const claim = await one<string>(sys(), 'gov.claim_effect($1, $2)', [id, 60_000]);
  expect(await one<boolean>(sys(), 'gov.begin_dispatch($1, $2)', [id, claim])).toBe(true);
  return { id, claim };
}
/** Time passes for one claim only: its dispatch lease and the grace window lie behind it. */
const lapse = (id: string) => admin.query(`UPDATE ops.effect_queue SET lease_expires_at = clock_timestamp() - interval '31 seconds' WHERE effect_id = $1`, [id]);

beforeAll(async () => {
  postgres = await startTestPostgres();
  await postgres.clone('sweep');
  const operator = new pg.Client({ connectionString: postgres.operatorUrl('sweep') });
  await operator.connect();
  const { rows: [made] } = await operator.query('SELECT * FROM operator.create_workspace($1, $2, $3, $4)', ['Sweep', 'personal', 'Owner', 'o@example.com']);
  await operator.end();
  ws = made.workspace_id;
  owner = made.owner_id;
  system = made.system_id;
  service = new pg.Client({ connectionString: postgres.appUrl('sweep') });
  await service.connect();
  admin = new pg.Client({ connectionString: postgres.adminUrl('sweep') });
  await admin.connect();
  const me = { workspace: ws, principal: owner };
  const agent = await one<string>(me, `gov.create_agent('Door', 'worker')`);
  const mandate = await one<string>(me, `gov.issue_mandate($1, NULL, '[]'::jsonb, '[]'::jsonb, '["door"]'::jsonb, '["outbox.write"]'::jsonb, 3::smallint, NULL, NULL, NULL, NULL, $2, 'direct')`, [
    agent,
    new Date(Date.now() + 3_600_000),
  ]);
  const task = await one<string>(me, `gov.create_task($1, $1, 'Door', NULL, NULL)`, [owner]);
  const queued = await one<string>(me, 'gov.queue_run($1, $2, $3)', [task, agent, mandate]);
  const [claimed] = await as<{ fence: string; secret: string }>({ workspace: ws }, 'SELECT fence, secret FROM gov.claim_run($1, $2, $3, $4)', [queued, 'door-1', 600_000, 'direct']);
  run = { id: queued, secret: claimed.secret, fence: Number(claimed.fence) };
});

afterAll(async () => {
  await service?.end();
  await admin?.end();
  await postgres?.stop();
});

describe('settling a silent dispatch (stale dispatch, effect-gateway contract)', () => {
  it('leaves a dispatch alone while its own claim is live, whatever its run is doing', async () => {
    const { id, claim } = await inFlight();
    // The run's lease lapsing or its mandate's run stopping says nothing about the dispatcher.
    await admin.query(`UPDATE app.runs SET lease_expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1`, [run.id]);
    expect(await one<string>(sys(), `gov.settle_lapsed_dispatch($1, $2, false, 'h-live', 'swept')`, [id, claim])).toBe('live');
    expect((await effectRow(id)).status).toBe('dispatching');
    expect(await one<string>(sys(), `gov.observe_effect($1, $2, 'succeeded', NULL, 'h-done', NULL)`, [id, claim])).toBe('succeeded');
  });

  it('records UNKNOWN once the claim has lapsed, with a resolver; a landed one as succeeded', async () => {
    const lost = await inFlight();
    await lapse(lost.id);
    expect(await one<string>(sys(), `gov.settle_lapsed_dispatch($1, $2, false, 'h-lost', 'swept')`, [lost.id, lost.claim])).toBe('unknown');
    expect(await effectRow(lost.id)).toMatchObject({ status: 'unknown', resolver_id: owner, observation_hash: 'h-lost' });
    const landed = await inFlight();
    await lapse(landed.id);
    expect(await one<string>(sys(), `gov.settle_lapsed_dispatch($1, $2, true, 'h-landed', 'swept')`, [landed.id, landed.claim])).toBe('succeeded');
  });

  it('settles only the claim it was given, and only for the system principal', async () => {
    const { id, claim } = await inFlight();
    await lapse(id);
    await expect(one(sys(), `gov.settle_lapsed_dispatch($1, 'another-claim', false, 'h', 'x')`, [id])).rejects.toThrow(/stale/);
    await expect(one({ workspace: ws, principal: owner }, `gov.settle_lapsed_dispatch($1, $2, false, 'h', 'x')`, [id, claim])).rejects.toThrow();
    expect((await effectRow(id)).status).toBe('dispatching');
  });

  it('a late observation under the original claim settles the swept UNKNOWN, once, and records who settled it', async () => {
    const { id, claim } = await inFlight();
    await lapse(id);
    expect(await one<string>(sys(), `gov.settle_lapsed_dispatch($1, $2, false, 'h-swept', 'swept')`, [id, claim])).toBe('unknown');
    await expect(one(sys(), `gov.observe_effect($1, 'another-claim', 'succeeded', NULL, 'h', NULL)`, [id])).rejects.toThrow(/stale/);
    await expect(one(sys(), `gov.observe_effect($1, $2, 'unknown', NULL, 'h', NULL)`, [id, claim])).rejects.toThrow(/invalid/);
    expect(await one<string>(sys(), `gov.observe_effect($1, $2, 'succeeded', 'ref-1', 'h-late', 'landed late')`, [id, claim])).toBe('succeeded');
    expect(await effectRow(id)).toMatchObject({ status: 'succeeded', settled_by: system, observation_hash: 'h-late' });
    await expect(one(sys(), `gov.observe_effect($1, $2, 'failed', NULL, 'h', NULL)`, [id, claim])).rejects.toThrow(/stale/);
  });

  it('an UNKNOWN the observer itself recorded is not reopened by its claim', async () => {
    const { id, claim } = await inFlight();
    expect(await one<string>(sys(), `gov.observe_effect($1, $2, 'unknown', NULL, 'h-u', NULL)`, [id, claim])).toBe('unknown');
    await expect(one(sys(), `gov.observe_effect($1, $2, 'succeeded', NULL, 'h', NULL)`, [id, claim])).rejects.toThrow(/stale/);
  });

  it('a proposal that was past its fence check when the run closed does not land', async () => {
    const late = await serviceClient(postgres.appUrl('sweep'));
    const closer = new pg.Client({ connectionString: postgres.adminUrl('sweep') });
    await closer.connect();
    try {
      await closer.query('BEGIN');
      await closer.query('SELECT 1 FROM app.ledger_heads WHERE workspace_id = $1 FOR UPDATE', [ws]);
      await enter(late, { workspace: ws, run });
      const proposal = late.query(`SELECT gov.propose_effect($1, $2, NULL, 'door', 'outbox.write', NULL, NULL, NULL, NULL, '{"name":"late.txt","content":"c"}'::jsonb, 'x', NULL, 'late')`, [run.id, run.fence]).then(() => 'landed', (e: Error) => e.message);
      await waitFor(async()=>!!(await closer.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%propose_effect%' AND pid <> pg_backend_pid()`)).rowCount,'proposal reaching the ledger head lock');
      await closer.query(`UPDATE app.runs SET status = 'failed' WHERE id = $1`, [run.id]);
      await closer.query('COMMIT');
      expect(await proposal).toMatch(/stale/);
      await late.query('ROLLBACK');
      expect((await admin.query(`SELECT 1 FROM app.effects WHERE idempotency_key = 'late'`)).rowCount).toBe(0);
    } finally { await late.end(); await closer.end(); }
  }, 240_000);
});
