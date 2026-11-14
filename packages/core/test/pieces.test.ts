import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enter, reasonOf } from '../src/db/session.ts';
import { startTestPostgres, type TestPostgres } from '../src/db/testing.ts';

/**
 * Pieces (docs/repo-design.md, Manifests): what a module or a surface declares is enforced by the
 * core. A piece is registered by the person or an admin, never by itself; a run carried by a piece
 * is bound to its registration when queued; the gateway refuses an effect outside that declaration
 * whatever the mandate allows; a piece with an UNKNOWN effect cannot be unregistered; and an upgrade
 * is a new registration that widens nothing already bound.
 */
let postgres: TestPostgres;
let service: pg.Client;
let admin: pg.Client;
let ws: string;
let owner: string;
let system: string;
let agent: string;
let task: string;

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
/** The reason a crossing refused with, in the core's words. */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    return reasonOf(error as Error);
  }
  throw new Error('expected a refusal');
};
const me = () => ({ workspace: ws, principal: owner });
const sys = () => ({ workspace: ws, principal: system });

let n = 0;
/** A manifest as scripts/manifests.mjs accepts it, with a fresh digest each time unless one is given. */
function manifest(capabilities: { operations: string[]; effectClasses: number[]; planes?: string[] }, extra: Record<string, unknown> = {}) {
  n++;
  return {
    manifest: 1,
    id: 'io.github.someone/door',
    kind: 'surface',
    version: '1.0.0',
    licence: 'Apache-2.0',
    capabilities: { planes: ['personal'], network: [], secrets: 'none', ...capabilities },
    removal: { refusedWhileUnknown: true, rule: 'settle UNKNOWNs first' },
    digest: `sha256:${n.toString(16).padStart(64, '0')}`,
    ...extra,
  };
}
const register = (m: object, actor: Actor = me()) => one<string>(actor, 'gov.register_piece($1::jsonb)', [JSON.stringify(m)]);
/** A mandate the person grants (operations '*', class ceiling 4), optionally to a piece. */
const grant = (piece: string | null) =>
  one<string>(me(), `gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', '"*"', 4::smallint, NULL, NULL, NULL, NULL, $2, $3, '{}'::jsonb, $4)`, [
    agent,
    new Date(Date.now() + 3_600_000),
    piece ? 'piece' : 'direct',
    piece,
  ]);
/** A run queued under `mandate` (bound to `piece` when given) and claimed: its id, fence and secret. */
async function claimed(mandate: string, piece: string | null = null) {
  const run = await one<string>(me(), 'gov.queue_run($1, $2, $3, NULL, $4)', [task, agent, mandate, piece]);
  // The worker states what it runs: the kind and piece the run is bound to.
  const [bound] = await as<{ carrier: string; piece_id: string | null }>(me(), 'SELECT carrier, piece_id FROM app.runs WHERE id = $1', [run]);
  const [c] = await as<{ fence: string; secret: string }>({ workspace: ws }, 'SELECT fence, secret FROM gov.claim_run($1, $2, $3, $4, $5)', [run, 'w', 600_000, bound.carrier, bound.piece_id]);
  return { id: run, secret: c.secret, fence: Number(c.fence) };
}
/** Propose through the run; returns the receipt's status and route reason. */
async function propose(run: { id: string; secret: string; fence: number }, operation: string, classHint: number | null = null) {
  n++;
  const id = await one<string>({ workspace: ws, run }, `gov.propose_effect($1, $2, NULL, 'door', $3, NULL, NULL, $4::smallint, NULL, $5::jsonb, 'x', NULL, $6)`, [
    run.id,
    run.fence,
    operation,
    classHint,
    JSON.stringify({ n }),
    `piece-${n}`,
  ]);
  const [row] = await as<{ id: string; status: string; route_reason: string | null }>(sys(), 'SELECT id, status, route_reason FROM app.effects WHERE id = $1', [id]);
  return row;
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await postgres.clone('pieces');
  const operator = new pg.Client({ connectionString: postgres.operatorUrl('pieces') });
  await operator.connect();
  const { rows: [made] } = await operator.query('SELECT * FROM operator.create_workspace($1, $2, $3, $4)', ['Pieces', 'personal', 'Owner', 'o@example.com']);
  await operator.end();
  ws = made.workspace_id;
  owner = made.owner_id;
  system = made.system_id;
  service = new pg.Client({ connectionString: postgres.appUrl('pieces') });
  await service.connect();
  admin = new pg.Client({ connectionString: postgres.adminUrl('pieces') });
  await admin.connect();
  agent = await one<string>(me(), `gov.create_agent('Door', 'worker')`);
  task = await one<string>(me(), `gov.create_task($1, $1, 'Work', NULL, NULL)`, [owner]);
});

afterAll(async () => {
  await service?.end();
  await admin?.end();
  await postgres?.stop();
});

describe('registering a piece', () => {
  it('is the person\'s or an admin\'s act: the piece, acting as its run, its agent or the system, is refused', async () => {
    const door = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const run = await claimed(await grant(door), door);
    expect(await refusal(register(manifest({ operations: ['outbox.write'], effectClasses: [3] }), { workspace: ws, run }))).toBe('not_by_runs');
    expect(await refusal(register(manifest({ operations: ['outbox.write'], effectClasses: [3] }), { workspace: ws, principal: agent }))).toBe('role');
    expect(await refusal(register(manifest({ operations: ['outbox.write'], effectClasses: [3] }), sys()))).toBe('role');
    expect(await refusal(one({ workspace: ws, run }, 'gov.unregister_piece($1)', [door]))).toBe('not_by_runs');
  });

  it('records the declaration once; the same content again is the same registration; a git reference is never a digest', async () => {
    const m = manifest({ operations: ['outbox.write'], effectClasses: [2, 3] });
    const id = await register(m);
    expect(await register(m)).toBe(id);
    const [row] = await as<Record<string, unknown>>(me(), 'SELECT piece, version, digest, operations, effect_classes, effect_ceiling FROM app.pieces WHERE id = $1', [id]);
    expect(row).toMatchObject({ piece: m.id, version: '1.0.0', digest: m.digest, operations: ['outbox.write'], effect_classes: [2, 3], effect_ceiling: 3 });
    expect(await refusal(register({ ...m, digest: 'refs/heads/main' }))).toBe('invalid');
    expect(await refusal(register({ ...m, digest: `sha256:${'a'.repeat(40)}` }))).toBe('invalid');
    expect(await refusal(register({ ...m, kind: 'core' }))).toBe('invalid');
    await expect(admin.query(`UPDATE app.pieces SET operations = '["outbox.write", "outbox.delete"]' WHERE id = $1`, [id])).rejects.toThrow(/frozen/);
    await expect(admin.query('DELETE FROM app.pieces WHERE id = $1', [id])).rejects.toThrow(/frozen/);
  });

  it('a member registers nothing, and a piece is bound only in a plane it declares', async () => {
    const operator = new pg.Client({ connectionString: postgres.operatorUrl('pieces') });
    await operator.connect();
    const { rows: [team] } = await operator.query('SELECT * FROM operator.create_workspace($1, $2, $3, $4)', ['Team', 'team', 'Lead', 'l@example.com']);
    await operator.end();
    const lead = { workspace: team.workspace_id, principal: team.owner_id };
    const member = await one<string>(lead, `gov.identity_add_person('Mia', 'm@example.com', 'member')`);
    expect(await refusal(register(manifest({ operations: ['outbox.write'], effectClasses: [3] }), { workspace: team.workspace_id, principal: member }))).toBe('role');
    const personalOnly = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }), lead);
    const worker = await one<string>(lead, `gov.create_agent('Door', 'worker')`);
    expect(
      await refusal(one(lead, `gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', '"*"', 3::smallint, NULL, NULL, NULL, NULL, $2, 'piece', '{}'::jsonb, $3)`, [worker, new Date(Date.now() + 3_600_000), personalOnly])),
    ).toBe('denied');
  });
});

describe('the act-time ceiling: the mandate intersected with the piece\'s declaration', () => {
  it('an operation the piece did not declare is refused, although the mandate allows every operation', async () => {
    const door = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const run = await claimed(await grant(door));
    expect(await propose(run, 'outbox.write')).toMatchObject({ status: 'allowed', route_reason: null });
    expect(await propose(run, 'outbox.delete')).toMatchObject({ status: 'denied', route_reason: 'outside_piece' });
    // The same proposal from a run no piece carries answers to the mandate alone.
    const plain = await claimed(await grant(null));
    expect((await propose(plain, 'outbox.delete')).status).toBe('allowed');
  });

  it('a class above the piece\'s declared ceiling is refused, although the mandate allows it', async () => {
    const door = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const run = await claimed(await grant(door));
    expect(await propose(run, 'outbox.write', 4)).toMatchObject({ status: 'denied', route_reason: 'above_piece_ceiling' });
    const plain = await claimed(await grant(null));
    expect((await propose(plain, 'outbox.write', 4)).route_reason).not.toBe('above_piece_ceiling');
    expect((await propose(plain, 'outbox.write', 4)).status).toBe('allowed');
  });

  it('a run keeps the piece it was queued with; a mandate granted to a piece keeps its runs and children with it', async () => {
    const door = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const other = await register(manifest({ operations: ['outbox.write', 'outbox.delete'], effectClasses: [3] }));
    const mandate = await grant(door);
    const run = await claimed(mandate);
    expect((await as<{ piece_id: string }>(me(), 'SELECT piece_id FROM app.runs WHERE id = $1', [run.id]))[0].piece_id).toBe(door);
    await expect(admin.query('UPDATE app.runs SET piece_id = $2 WHERE id = $1', [run.id, other])).rejects.toThrow(/frozen/);
    await expect(admin.query('UPDATE app.mandates SET piece_id = NULL WHERE id = $1', [mandate])).rejects.toThrow(/frozen/);
    expect(await refusal(one(me(), 'gov.queue_run($1, $2, $3, NULL, $4)', [task, agent, mandate, other]))).toBe('other_piece');
    expect(
      await refusal(one(me(), `gov.issue_mandate($1, $2, '"*"', '"*"', '"*"', '"*"', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}'::jsonb, $3)`, [agent, mandate, other])),
    ).toBe('other_piece');
    const child = await one<string>(me(), `gov.issue_mandate($1, $2, '"*"', '"*"', '"*"', '"*"', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, [agent, mandate]);
    expect((await as<{ piece_id: string }>(me(), 'SELECT piece_id FROM app.mandates WHERE id = $1', [child]))[0].piece_id).toBe(door);
  });
});

describe('removing and upgrading a piece', () => {
  it('unregistering is refused while an effect it carried is UNKNOWN; once settled, its work is refused', async () => {
    const door = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const mandate = await grant(door);
    const run = await claimed(mandate);
    const effect = await propose(run, 'outbox.write');
    const claim = await one<string>(sys(), 'gov.claim_effect($1, $2)', [effect.id, 60_000]);
    expect(await one<boolean>(sys(), 'gov.begin_dispatch($1, $2)', [effect.id, claim])).toBe(true);
    expect(await refusal(one(me(), 'gov.unregister_piece($1)', [door]))).toBe('unsettled');
    expect(await one<string>(sys(), `gov.observe_effect($1, $2, 'unknown', NULL, 'h-u', NULL)`, [effect.id, claim])).toBe('unknown');
    expect(await refusal(one(me(), 'gov.unregister_piece($1)', [door]))).toBe('unsettled');
    expect((await as<{ unregistered_at: Date | null }>(me(), 'SELECT unregistered_at FROM app.pieces WHERE id = $1', [door]))[0].unregistered_at).toBeNull();
    // Settled by inspection, it may go: its run stops and anything it proposes or queues is refused.
    expect(await one<string>(me(), `gov.reconcile_effect($1, 'failed', NULL, 'h-f', 'checked: not sent')`, [effect.id])).toBe('failed');
    expect(await one<boolean>(me(), 'gov.unregister_piece($1)', [door])).toBe(true);
    expect(await one<boolean>(me(), 'gov.unregister_piece($1)', [door])).toBe(false);
    expect((await as<{ status: string }>(me(), 'SELECT status FROM app.runs WHERE id = $1', [run.id]))[0].status).toBe('cancelled');
    expect(await refusal(one(me(), 'gov.queue_run($1, $2, $3)', [task, agent, mandate]))).toBe('not_registered');
    expect(await refusal(grant(door))).toBe('not_registered');
  });

  it('an upgrade with a wider declaration is a new registration, and does not widen a live run or its mandate', async () => {
    const v1 = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const mandate = await grant(v1);
    const live = await claimed(mandate);
    const v2 = await register(manifest({ operations: ['outbox.write', 'outbox.delete'], effectClasses: [3, 4] }, { version: '1.1.0' }));
    expect(v2).not.toBe(v1);
    expect(await propose(live, 'outbox.delete')).toMatchObject({ status: 'denied', route_reason: 'outside_piece' });
    expect(await propose(live, 'outbox.write', 4)).toMatchObject({ status: 'denied', route_reason: 'above_piece_ceiling' });
    // The running mandate stays with v1: only a new grant from the person takes v2's wider declaration.
    expect(await refusal(one(me(), 'gov.queue_run($1, $2, $3, NULL, $4)', [task, agent, mandate, v2]))).toBe('other_piece');
    const regranted = await claimed(await grant(v2));
    expect((await propose(regranted, 'outbox.delete')).status).toBe('allowed');
  });
});

describe('what carries a run: a registered piece, or the recorded direct kind, never a missing piece', () => {
  it('a root mandate states its kind; an unstated or inconsistent kind is refused', async () => {
    const door = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const issue = (carrier: string | null, piece: string | null) =>
      one(me(), `gov.issue_mandate($1, NULL, '"*"', '"*"', '"*"', '"*"', 4::smallint, NULL, NULL, NULL, NULL, $2, $3, '{}'::jsonb, $4)`, [agent, new Date(Date.now() + 3_600_000), carrier, piece]);
    expect(await refusal(issue(null, null))).toBe('invalid');
    expect(await refusal(issue(null, door))).toBe('invalid');
    expect(await refusal(issue('piece', null))).toBe('invalid');
    expect(await refusal(issue('direct', door))).toBe('invalid');
    expect(await refusal(issue('anything', null))).toBe('invalid');
  });

  it('the kind is recorded on the mandate and the run, inherited by children, and never changes', async () => {
    const direct = await grant(null);
    const run = await one<string>(me(), 'gov.queue_run($1, $2, $3)', [task, agent, direct]);
    expect((await as(me(), 'SELECT carrier, piece_id FROM app.runs WHERE id = $1', [run]))[0]).toEqual({ carrier: 'direct', piece_id: null });
    await expect(admin.query(`UPDATE app.runs SET carrier = 'piece' WHERE id = $1`, [run])).rejects.toThrow();
    await expect(admin.query(`UPDATE app.mandates SET carrier = 'piece' WHERE id = $1`, [direct])).rejects.toThrow();
    const door = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    expect(await refusal(one(me(), 'gov.queue_run($1, $2, $3, NULL, $4)', [task, agent, direct, door]))).toBe('other_piece');
    const child = await one<string>(me(), `gov.issue_mandate($1, $2, '"*"', '"*"', '"*"', '"*"', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`, [agent, await grant(door)]);
    expect((await as(me(), 'SELECT carrier, piece_id FROM app.mandates WHERE id = $1', [child]))[0]).toEqual({ carrier: 'piece', piece_id: door });
    expect(
      await refusal(one(me(), `gov.issue_mandate($1, $2, '"*"', '"*"', '"*"', '"*"', NULL, NULL, NULL, NULL, NULL, NULL, 'direct')`, [agent, child])),
    ).toBe('other_piece');
  });
});

describe('claiming a run', () => {
  it('a worker claims a run only for what it is bound to: a piece worker never an unbound run, a direct worker never a bound one', async () => {
    const door = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const other = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const queue = (mandate: string) => one<string>(me(), 'gov.queue_run($1, $2, $3)', [task, agent, mandate]);
    const claim = (run: string, carrier: string | null, piece: string | null) =>
      as({ workspace: ws }, 'SELECT fence, secret FROM gov.claim_run($1, $2, $3, $4, $5)', [run, 'w', 600_000, carrier, piece]);
    const bound = await queue(await grant(door));
    const unbound = await queue(await grant(null));
    expect(await refusal(claim(bound, 'direct', null))).toBe('other_piece');
    expect(await refusal(claim(bound, 'piece', other))).toBe('other_piece');
    expect(await refusal(claim(unbound, 'piece', door))).toBe('other_piece');
    expect(await refusal(claim(unbound, null, null))).toBe('invalid');
    expect(await refusal(claim(bound, 'piece', null))).toBe('invalid');
    expect((await claim(bound, 'piece', door)).length).toBe(1);
    expect((await claim(unbound, 'direct', null)).length).toBe(1);
  });

  it('the queue hands a worker only runs of what it runs, and never locks the others', async () => {
    const door = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    await one<string>(me(), 'gov.queue_run($1, $2, $3)', [task, agent, await grant(null)]);
    const doorRun = await one<string>(me(), 'gov.queue_run($1, $2, $3)', [task, agent, await grant(door)]);
    const next = async (client: pg.Client, carrier: string, piece: string | null) =>
      (await client.query<{ run_id: string }>('SELECT run_id FROM gov.claim_next_run($1, $2, $3, $4)', ['w', 600_000, carrier, piece])).rows.map((r) => r.run_id);
    // A worker for a piece with nothing queued looks and holds its transaction open: it took no
    // lock on the others' runs, so the direct worker and the door's worker still get theirs.
    const idle = await register(manifest({ operations: ['outbox.write'], effectClasses: [3] }));
    const idleWorker = new pg.Client({ connectionString: postgres.appUrl('pieces') });
    await idleWorker.connect();
    try {
      await idleWorker.query('BEGIN');
      expect(await next(idleWorker, 'piece', idle)).toEqual([]);
      await service.query('BEGIN');
      const got = await next(service, 'direct', null);
      await service.query('COMMIT');
      // It gets the oldest direct run queued in this file (directRun or an earlier one), never the door's.
      expect(got).toHaveLength(1);
      expect((await as<{ carrier: string }>(me(), 'SELECT carrier FROM app.runs WHERE id = $1', [got[0]]))[0].carrier).toBe('direct');
      expect(got).not.toContain(doorRun);
      await service.query('BEGIN');
      expect(await next(service, 'piece', door)).toEqual([doorRun]);
      await service.query('COMMIT');
    } finally {
      await idleWorker.query('ROLLBACK').catch(() => {});
      await idleWorker.end();
    }
  });
});
