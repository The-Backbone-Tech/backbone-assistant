// The v0.8 suites' cluster is the kernel package's disposable one (its pinned, digest-checked SQL);
// what stays here are the platform tests' own fixtures on top of it.
import pg from 'pg';
import { type KernelCluster, startKernelCluster } from '@backbone-next/kernel/testing';
import type { PresenceAnswer, PresenceCheck } from '../src/authority/sql-v08/session-owner.ts';
import type { PersonRequest } from '../src/authority/sql-v08/types.ts';

export type V08Cluster = KernelCluster;

/** A labelled stand-in for the person: it answers every question with `answer` and attests nothing. */
export const scriptedPresence = (answer: PresenceAnswer = 'confirmed', asked: PersonRequest[] = []): PresenceCheck => ({
  attests: 'fixture', confirm: async (request) => { asked.push(request); return answer; },
});
export const startV08Cluster = startKernelCluster;

/** The privileged workspace bootstrap the lab's own helpers use. The kernel package installs the SQL and logins; no production workspace bootstrap exists yet. */
export async function bootstrapWorkspace(adminUrl: string, name: string, ids?: { workspaceId: string; ownerId: string }) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const w = ids ?? (await c.query('SELECT uuidv7() AS "workspaceId",uuidv7() AS "ownerId"')).rows[0] as { workspaceId: string; ownerId: string };
    await c.query("SELECT set_config('app.workspace_id',$1,true)", [w.workspaceId]);
    await c.query('SET LOCAL ROLE backbone_gov');
    await c.query('INSERT INTO app.workspaces(id,name) VALUES($1,$2)', [w.workspaceId, name]);
    await c.query('INSERT INTO app.people(workspace_id,id,name) VALUES($1,$2,$3)', [w.workspaceId, w.ownerId, `${name} owner`]);
    await c.query("INSERT INTO app.members(workspace_id,principal_id,role) VALUES($1,$2,'owner')", [w.workspaceId, w.ownerId]);
    await c.query('INSERT INTO app.ledgers(workspace_id) VALUES($1)', [w.workspaceId]);
    await c.query('INSERT INTO app.crossing_inputs(workspace_id) VALUES($1)', [w.workspaceId]);
    await c.query('COMMIT');
    return w;
  } finally { await c.end(); }
}

/** A landing record's rows, written directly: no crossing runs on this path. The kernel's own functions then act on it. */
export async function crossingRows(adminUrl: string, s: { workspaceId: string; run: string; checkerRun: string }) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const run = (await c.query('SELECT task_id AS task, plane_id AS plane FROM app.runs WHERE id = $1', [s.run])).rows[0];
    const ids = (await c.query('SELECT uuidv7() AS target, uuidv7() AS intent, uuidv7() AS snapshot, uuidv7() AS reservation')).rows[0];
    const digest = 'a'.repeat(64);
    await c.query('INSERT INTO app.targets(workspace_id,id,task_id,plane_id) VALUES($1,$2,$3,$4)', [s.workspaceId, ids.target, run.task, run.plane]);
    await c.query(`INSERT INTO app.intents(workspace_id,id,run_id,fence,target_id,checker_run,checker_fence,makers,checkers,rubric_digest)
      VALUES($1,$2,$3,1,$4,$5,1,'{}','{}',$6)`, [s.workspaceId, ids.intent, s.run, ids.target, s.checkerRun, digest]);
    await c.query(`INSERT INTO app.snapshots(workspace_id,id,intent_id,reservation_id,base_version,run_id,plane_id,payload,tree_hash,content_sha256,manifest_digest,authority_vector,expires_at,hot)
      VALUES($1,$2,$3,$4,0,$5,$6,'\\x00',$7,$7,$7,'{}',now(),false)`, [s.workspaceId, ids.snapshot, ids.intent, ids.reservation, s.run, run.plane, digest]);
    await c.query('COMMIT');
    return { intent: ids.intent as string, snapshot: ids.snapshot as string };
  } finally { await c.end(); }
}

/** A labelled synthetic identity: the identity role's session call. It is not human authentication. */
export function fixtureSessions(adminUrl: string, binding: { workspaceId: string; personId: string; accountId: string }) {
  return { current: async () => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.workspace_id',$1,true)", [binding.workspaceId]);
      await c.query('SET LOCAL ROLE planes_identity');
      const token = (await c.query('SELECT gov.authenticate_person($1::uuid) AS value', [binding.personId])).rows[0]?.value as string;
      await c.query('COMMIT');
      return { status: 'authenticated' as const, ...binding, personToken: token };
    } finally { await c.end(); }
  } };
}
