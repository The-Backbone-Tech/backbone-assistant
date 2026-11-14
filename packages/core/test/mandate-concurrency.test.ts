import { waitFor } from '../../../scripts/lib/test-hang.ts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enter, reasonOf, serviceClient } from '../src/db/session.ts';
import { startTestPostgres, type TestPostgres } from '../src/db/testing.ts';

let postgres: TestPostgres;
let service: pg.Client;
let monitor: pg.Client;
let workspace: string;
let owner: string;
let system: string;
let worker: string;
let root: string;

beforeAll(async () => {
  postgres = await startTestPostgres();
  await postgres.clone('mandate_concurrency');
  const operator = new pg.Client({ connectionString: postgres.operatorUrl('mandate_concurrency') });
  try {
    await operator.connect();
    const { rows: [made] } = await operator.query('SELECT * FROM operator.create_workspace($1, $2, $3, $4)',
      ['Mandate concurrency', 'personal', 'Owner', 'owner@example.com']);
    workspace = made.workspace_id;
    owner = made.owner_id;
    system = made.system_id;
  } finally {
    await operator.end();
  }
  service = await serviceClient(postgres.appUrl('mandate_concurrency'));
  monitor = new pg.Client({ connectionString: postgres.adminUrl('mandate_concurrency') });
  await monitor.connect();
  await enter(service, { workspace, principal: owner });
  try {
    const created = await service.query<{ id: string }>(`SELECT gov.create_agent('Worker', 'worker') AS id`);
    worker = created.rows[0].id;
    const issued = await service.query<{ id: string }>(
      `SELECT gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', '"*"', 4::smallint,
        NULL, NULL, NULL, NULL, $2, 'direct') AS id`,
      [worker, new Date(Date.now() + 3_600_000)],
    );
    root = issued.rows[0].id;
    await service.query('COMMIT');
  } catch (error) {
    await service.query('ROLLBACK');
    throw error;
  }
});

afterAll(async () => {
  try {
    await service?.end();
    await monitor?.end();
  } finally {
    await postgres?.stop();
  }
});

/** Poll server-observed wait state; a delay alone is not evidence that issuance reached the lock. */
async function waitForBlock(blockedPid: number, blockerPid: number): Promise<void> {
  await waitFor(async()=>{
    const { rows: [state] } = await monitor.query<{ blocked: boolean }>(
      `SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1`, [blockedPid, blockerPid]);
    return !!state?.blocked;
  }, 'issuance reaching the revoker lock', {diagnostic:()=>`blocked pid=${blockedPid}; blocker pid=${blockerPid}`});
}

describe('concurrent mandate revocation', () => {
  it('refuses a child when revocation holds the workspace lock first', async () => {
    // The installer may take the test lock directly; after that, the revocation crossing runs as
    // the ordinary service role with the owner's session, exactly like the issuer.
    const revoker = new pg.Client({ connectionString: postgres.adminUrl('mandate_concurrency') });
    const issuer = await serviceClient(postgres.appUrl('mandate_concurrency'));
    let issuance: Promise<{ ok: true; id: string } | { ok: false; error: Error }> | undefined;
    let revokerConnected = false;
    try {
      await revoker.connect();
      revokerConnected = true;
      await enter(revoker, { workspace, principal: owner });
      await revoker.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      await revoker.query('SELECT 1 FROM app.ledger_heads WHERE workspace_id = $1 FOR UPDATE', [workspace]);
      await revoker.query('SET LOCAL ROLE backbone_app');
      await enter(issuer, { workspace, principal: owner });
      await issuer.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      const { rows: [a] } = await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const { rows: [b] } = await issuer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      issuance = issuer.query<{ id: string }>(
        `SELECT gov.issue_mandate($1, $2, '"*"', '"*"', '"*"', '"*"',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL) AS id`, [worker, root],
      ).then((result) => ({ ok: true as const, id: result.rows[0].id }),
        (error: Error) => ({ ok: false as const, error }));
      await waitForBlock(b.pid, a.pid);
      const revoked = await revoker.query<{ count: number }>('SELECT gov.revoke_mandate($1) AS count', [root]);
      expect(revoked.rows[0].count).toBe(1);
      await revoker.query('COMMIT');
      const outcome = await issuance;
      await issuer.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');

      await enter(service, { workspace, principal: owner });
      const descendants = await service.query<{ id: string }>(
        `WITH RECURSIVE descendants AS (
           SELECT id, revoked_at FROM app.mandates WHERE workspace_id = $1 AND parent_id = $2
           UNION ALL
           SELECT m.id, m.revoked_at FROM app.mandates m JOIN descendants d ON m.parent_id = d.id
           WHERE m.workspace_id = $1
         ) SELECT id FROM descendants WHERE revoked_at IS NULL`, [workspace, root],
      );
      await service.query('COMMIT');
      expect.soft(descendants.rows, 'revocation must leave no live descendant').toEqual([]);
      expect.soft(outcome.ok ? 'issued' : reasonOf(outcome.error), 'the child request must be refused as revoked').toBe('revoked');
    } finally {
      // Release A first, so a still-pending B can finish before its connection is closed.
      if (revokerConnected) await revoker.query('ROLLBACK').catch(() => {});
      if (issuance) await issuance;
      await issuer.query('ROLLBACK').catch(() => {});
      await service.query('ROLLBACK').catch(() => {});
      await revoker.end().catch(() => {});
      await issuer.end().catch(() => {});
    }
  }, 300_000);

  it('finishing a run and revoking its mandate never invert workspace and run locks', async () => {
    await enter(service, { workspace, principal: owner });
    const mandate = (await service.query<{ id: string }>(`SELECT gov.issue_mandate($1,NULL,'"*"','"*"','"*"','"*"',4::smallint,NULL,NULL,NULL,NULL,$2,'direct') AS id`, [worker, new Date(Date.now() + 3_600_000)])).rows[0].id;
    const task = (await service.query<{ id: string }>(`SELECT gov.create_task($1,$1,'Concurrent finish',NULL,NULL) AS id`, [owner])).rows[0].id;
    const run = (await service.query<{ id: string }>('SELECT gov.queue_run($1,$2,$3) AS id', [task, worker, mandate])).rows[0].id;
    await service.query('COMMIT');
    await enter(service, { workspace });
    const claim = (await service.query<{ fence: string; secret: string }>(`SELECT * FROM gov.claim_run($1,'finisher',60000,'direct')`, [run])).rows[0];
    await service.query('COMMIT');
    const revoker = new pg.Client({ connectionString: postgres.adminUrl('mandate_concurrency') });
    const finisher = await serviceClient(postgres.appUrl('mandate_concurrency'));
    let finishing: Promise<{ ok: boolean; error?: { code?: string; message?: string } }> | undefined;
    const settle = async (client: pg.Client, sql: string, args: unknown[]) => {
      try { await client.query(sql, args); await client.query('COMMIT'); return { ok: true }; }
      catch (error) { await client.query('ROLLBACK'); return { ok: false, error: error as { code?: string; message?: string } }; }
    };
    try {
      await revoker.connect(); await enter(revoker, { workspace, principal: owner });
      await revoker.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      await revoker.query('SELECT 1 FROM app.ledger_heads WHERE workspace_id=$1 FOR UPDATE', [workspace]);
      await revoker.query('SET LOCAL ROLE backbone_app');
      await enter(finisher, { workspace, run: { id: run, secret: claim.secret } });
      await finisher.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      const a = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const b = (await finisher.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      finishing = settle(finisher, `SELECT gov.finish_run($1,$2,'failed')`, [run, claim.fence]);
      await waitForBlock(b, a);
      const revoking = await settle(revoker, 'SELECT gov.revoke_mandate($1)', [mandate]);
      const finished = await finishing;
      expect.soft(revoking.ok, JSON.stringify(revoking.error)).toBe(true);
      expect.soft(finished.error?.code).not.toBe('40P01');
      if (!finished.ok) expect.soft(reasonOf(finished.error!)).toBe('stale');
    } finally {
      await revoker.query('ROLLBACK').catch(() => {});
      if (finishing) await finishing;
      await finisher.query('ROLLBACK').catch(() => {});
      await revoker.end().catch(() => {}); await finisher.end().catch(() => {});
    }
  }, 300_000);

  it('claiming a run by id and revoking its mandate never invert workspace and run locks', async () => {
    await enter(service, { workspace, principal: owner });
    const mandate = (await service.query<{ id: string }>(`SELECT gov.issue_mandate($1,NULL,'"*"','"*"','"*"','"*"',4::smallint,NULL,NULL,NULL,NULL,$2,'direct') AS id`, [worker, new Date(Date.now() + 3_600_000)])).rows[0].id;
    const task = (await service.query<{ id: string }>(`SELECT gov.create_task($1,$1,'Concurrent finish',NULL,NULL) AS id`, [owner])).rows[0].id;
    const run = (await service.query<{ id: string }>('SELECT gov.queue_run($1,$2,$3) AS id', [task, worker, mandate])).rows[0].id;
    await service.query('COMMIT');
    const revoker = new pg.Client({ connectionString: postgres.adminUrl('mandate_concurrency') });
    const finisher = await serviceClient(postgres.appUrl('mandate_concurrency'));
    let finishing: Promise<{ ok: boolean; error?: { code?: string; message?: string } }> | undefined;
    const settle = async (client: pg.Client, sql: string, args: unknown[]) => {
      try { await client.query(sql, args); await client.query('COMMIT'); return { ok: true }; }
      catch (error) { await client.query('ROLLBACK'); return { ok: false, error: error as { code?: string; message?: string } }; }
    };
    try {
      await revoker.connect(); await enter(revoker, { workspace, principal: owner });
      await revoker.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      await revoker.query('SELECT 1 FROM app.ledger_heads WHERE workspace_id=$1 FOR UPDATE', [workspace]);
      await revoker.query('SET LOCAL ROLE backbone_app');
      await enter(finisher, { workspace });
      await finisher.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      const a = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const b = (await finisher.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      finishing = settle(finisher, `SELECT * FROM gov.claim_run($1,'concurrent-claimer',60000,'direct')`, [run]);
      await waitForBlock(b, a);
      const revoking = await settle(revoker, 'SELECT gov.revoke_mandate($1)', [mandate]);
      const finished = await finishing;
      expect.soft(revoking.ok, JSON.stringify(revoking.error)).toBe(true);
      expect.soft(finished.error?.code).not.toBe('40P01');
      if (!finished.ok) expect.soft(reasonOf(finished.error!)).toBe('not_claimable');
    } finally {
      await revoker.query('ROLLBACK').catch(() => {});
      if (finishing) await finishing;
      await finisher.query('ROLLBACK').catch(() => {});
      await revoker.end().catch(() => {}); await finisher.end().catch(() => {});
    }
  }, 300_000);

  it('recording an in-flight source never inverts revocation lock order', async () => {
    await enter(service, { workspace, principal: owner });
    const mandate = (await service.query<{ id: string }>(`SELECT gov.issue_mandate($1,NULL,'"*"','"*"','"*"','"*"',4::smallint,NULL,NULL,NULL,NULL,$2,'direct') AS id`, [worker, new Date(Date.now() + 3_600_000)])).rows[0].id;
    const task = (await service.query<{ id: string }>(`SELECT gov.create_task($1,$1,'Concurrent finish',NULL,NULL) AS id`, [owner])).rows[0].id;
    const run = (await service.query<{ id: string }>('SELECT gov.queue_run($1,$2,$3) AS id', [task, worker, mandate])).rows[0].id;
    await service.query('COMMIT');
    const revoker = new pg.Client({ connectionString: postgres.adminUrl('mandate_concurrency') });
    const finisher = await serviceClient(postgres.appUrl('mandate_concurrency'));
    let finishing: Promise<{ ok: boolean; error?: { code?: string; message?: string } }> | undefined;
    const settle = async (client: pg.Client, sql: string, args: unknown[]) => {
      try { await client.query(sql, args); await client.query('COMMIT'); return { ok: true }; }
      catch (error) { await client.query('ROLLBACK'); return { ok: false, error: error as { code?: string; message?: string } }; }
    };
    try {
      await revoker.connect(); await enter(revoker, { workspace, principal: owner });
      await revoker.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      await revoker.query('SELECT 1 FROM app.ledger_heads WHERE workspace_id=$1 FOR UPDATE', [workspace]);
      await revoker.query('SET LOCAL ROLE backbone_app');
      await enter(finisher, { workspace, principal: system });
      await finisher.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      const a = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const b = (await finisher.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      finishing = settle(finisher, `SELECT gov.record_source('message','concurrency-source','Observed message',NULL,$1,NULL)`, [run]);
      await waitForBlock(b, a);
      const revoking = await settle(revoker, 'SELECT gov.revoke_mandate($1)', [mandate]);
      const finished = await finishing;
      expect.soft(revoking.ok, JSON.stringify(revoking.error)).toBe(true);
      expect.soft(finished.error?.code).not.toBe('40P01');
      expect.soft(finished.ok, JSON.stringify(finished.error)).toBe(true);
    } finally {
      await revoker.query('ROLLBACK').catch(() => {});
      if (finishing) await finishing;
      await finisher.query('ROLLBACK').catch(() => {});
      await revoker.end().catch(() => {}); await finisher.end().catch(() => {});
    }
  }, 300_000);

  it('claiming the next queued run never inverts revocation lock order', async () => {
    await enter(service, { workspace, principal: owner });
    const mandate = (await service.query<{ id: string }>(`SELECT gov.issue_mandate($1,NULL,'"*"','"*"','"*"','"*"',4::smallint,NULL,NULL,NULL,NULL,$2,'direct') AS id`, [worker, new Date(Date.now() + 3_600_000)])).rows[0].id;
    const task = (await service.query<{ id: string }>(`SELECT gov.create_task($1,$1,'Concurrent finish',NULL,NULL) AS id`, [owner])).rows[0].id;
    const run = (await service.query<{ id: string }>('SELECT gov.queue_run($1,$2,$3) AS id', [task, worker, mandate])).rows[0].id;
    await service.query('COMMIT');
    const revoker = new pg.Client({ connectionString: postgres.adminUrl('mandate_concurrency') });
    const finisher = await serviceClient(postgres.appUrl('mandate_concurrency'));
    let finishing: Promise<{ ok: boolean; rowCount?: number | null; error?: { code?: string; message?: string } }> | undefined;
    const settle = async (client: pg.Client, sql: string, args: unknown[]) => {
      try { const result = await client.query(sql, args); await client.query('COMMIT'); return { ok: true, rowCount: result.rowCount }; }
      catch (error) { await client.query('ROLLBACK'); return { ok: false, error: error as { code?: string; message?: string } }; }
    };
    try {
      await revoker.connect(); await enter(revoker, { workspace, principal: owner });
      await revoker.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      await revoker.query('SELECT 1 FROM app.ledger_heads WHERE workspace_id=$1 FOR UPDATE', [workspace]);
      await revoker.query('SET LOCAL ROLE backbone_app');
      await enter(finisher, {});
      await finisher.query(`SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'`);
      const a = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const b = (await finisher.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let settled = false, blocked = false;
      finishing = settle(finisher, `SELECT * FROM gov.claim_next_run('queue-worker',60000,'direct')`, []).then((result) => { settled = true; return result; });

      await waitFor(async()=>{
        blocked = (await monitor.query<{ blocked: boolean }>(`SELECT $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1`, [b, a])).rows[0]?.blocked;
        if (!blocked && !settled) await new Promise((resolve) => setTimeout(resolve, 20));

return !!blocked || settled;},'mandate-concurrency: SQL lock observation',{diagnostic:()=>`blocked=${blocked}; settled=${settled}`});
      expect(blocked || settled).toBe(true);
      const revoking = await settle(revoker, 'SELECT gov.revoke_mandate($1)', [mandate]);
      const finished = await finishing;
      expect.soft(finished.rowCount).toBe(0);
      expect.soft(revoking.ok, JSON.stringify(revoking.error)).toBe(true);
      expect.soft(finished.error?.code).not.toBe('40P01');
      if (!finished.ok) expect.soft(reasonOf(finished.error!)).toBe('not_claimable');
    } finally {
      await revoker.query('ROLLBACK').catch(() => {});
      if (finishing) await finishing;
      await finisher.query('ROLLBACK').catch(() => {});
      await revoker.end().catch(() => {}); await finisher.end().catch(() => {});
    }
  }, 300_000);

});
