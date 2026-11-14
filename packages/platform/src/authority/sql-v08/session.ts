import type { SqlClient, SqlOutcome, SqlPool } from './types.ts';
import { LOG_POLICY_QUERY, safeLogPolicy } from '../log-policy.ts';

export interface Context {
  readonly workspaceId: string;
  readonly personId?: string; readonly personToken?: string;
  readonly run?: string; readonly secret?: string; readonly fence?: number;
}
const contextSql = (local: boolean) => `SELECT
  set_config('app.workspace_id', $1, ${local}), set_config('app.principal_id', $2, ${local}),
  set_config('app.person_token', $3, ${local}), set_config('app.app_token', $4, ${local}),
  set_config('app.run_id', $5, ${local}), set_config('app.run_token', $6, ${local}),
  set_config('app.run_fence', $7, ${local})`;
const empty = () => ['', '', '', '', '', '', ''];
// Fixed catalog facts for the actual login AND effective role. These are credential configuration
// checks, never a replacement for SQL's per-operation authority. No role or membership is changed.
const privilegedFlags = ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'] as const;
const memberships = ['backbone_owner', 'backbone_gov', 'backbone_app', 'planes_observer', 'planes_identity'] as const;
const subjects = ['login', 'effective'] as const;
const roleFactsSql = `SELECT login.rolname AS login_role, effective.rolname AS effective_role,
  login.rolcanlogin AS login_can_login, effective.rolcanlogin AS effective_can_login,
  ${subjects.flatMap(subject => [
    ...privilegedFlags.map(flag => `${subject}.${flag} AS ${subject}_${flag}`),
    ...memberships.map(role => `pg_has_role(${subject}.rolname, '${role}', 'MEMBER') AS ${subject}_${role}`),
  ]).join(',\n  ')}
  FROM pg_roles AS login CROSS JOIN pg_roles AS effective
  WHERE login.rolname = session_user AND effective.rolname = current_user`;
export type CredentialRole = 'app' | 'observer' | 'identity';
const roleOf = { observer: 'planes_observer', identity: 'planes_identity' } as const;
function credentialRole(facts: Record<string, unknown> | undefined, role: CredentialRole): boolean {
  if (!facts || facts.login_can_login !== true) return false;
  for (const subject of subjects) {
    if (privilegedFlags.some(flag => facts[`${subject}_${flag}`] !== false) ||
      facts[`${subject}_backbone_owner`] !== false || facts[`${subject}_backbone_gov`] !== false) return false;
  }
  if (role === 'app') return facts.login_role === 'backbone_app' && facts.effective_role === 'backbone_app' &&
    facts.effective_can_login === true && subjects.every(subject =>
      facts[`${subject}_planes_observer`] === false && facts[`${subject}_planes_identity`] === false && facts[`${subject}_backbone_app`] === true);
  // No login holds both: the door acts with nobody present, so it must not be able to make a person.
  const other = role === 'observer' ? 'planes_identity' : 'planes_observer';
  return typeof facts.login_role === 'string' && facts.login_role !== 'backbone_app' &&
    facts.effective_role === roleOf[role] && facts.effective_can_login === false && subjects.every(subject =>
      facts[`${subject}_backbone_app`] === false && facts[`${subject}_${other}`] === false && facts[`${subject}_${roleOf[role]}`] === true);
}
const refused = new Set(['42501', '23514', '23503', '40001', 'P0002', '23505', '22023', '22P02', '55006']);
const codeOf = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && refused.has(code) ? code : undefined;
};

/** Internal only: every callback is a fixed bounded SQL operation, never caller/model/FS work.
 * No retries. SQL locks and triggers retain post-wait authority and commit fencing. */
export async function transaction<T>(pool: SqlPool, role: CredentialRole, context: Context,
  operation: (client: SqlClient) => Promise<T>): Promise<SqlOutcome<T>> {
  let client: SqlClient;
  try { client = await pool.connect(); }
  catch { return { status: 'unavailable', reason: 'database-unavailable' }; }
  let beginPending = false; let begun = false; let committing = false; let committed = false; let destroy = false;
  try {
    // Check on every acquired connection before any run or person credential is sent.
    const logging = await client.query(LOG_POLICY_QUERY);
    if (!safeLogPolicy(logging.rows[0])) {
      destroy = true;
      return { status: 'unavailable', reason: 'database-unavailable' };
    }
    // Clear session-level contamination as well as masking every setting inside the transaction.
    await client.query(contextSql(false), empty());
    // Dispatch can open the server transaction even when its response is lost. Never reuse that
    // connection or issue a scrub inside the uncertain transaction; disposal performs no retry.
    beginPending = true;
    await client.query('BEGIN'); begun = true; beginPending = false;
    if (role !== 'app') await client.query(`SET LOCAL ROLE ${roleOf[role]}`);
    const checked = await client.query(roleFactsSql);
    if (!credentialRole(checked.rows[0], role)) {
      await client.query('ROLLBACK'); begun = false;
      return { status: 'unavailable', reason: 'credential-role' };
    }
    await client.query(contextSql(true), [context.workspaceId, context.personId ?? '', context.personToken ?? '',
      '', context.run ?? '', context.secret ?? '', context.fence === undefined ? '' : String(context.fence)]);
    const value = await operation(client);
    committing = true;
    await client.query('COMMIT'); committed = true; begun = false;
    return { status: 'committed', value };
  } catch (error) {
    if (beginPending) destroy = true;
    const code = codeOf(error);
    if (committing) {
      // A server-declared serialization/refusal failure proves no commit; a lost response does not.
      destroy = true;
      if (code) return { status: 'denied', code };
      return { status: 'unknown', reason: 'transaction-outcome-unknown' };
    }
    if (begun) {
      try { await client.query('ROLLBACK'); begun = false; }
      catch { destroy = true; }
    }
    if (code) return { status: 'denied', code };
    return { status: 'unavailable', reason: 'database-unavailable' };
  } finally {
    if (beginPending || (!committed && begun)) destroy = true;
    if (!destroy) {
      try { await client.query(contextSql(false), empty()); }
      catch { destroy = true; }
    }
    // Never attach the original driver error: it can contain secret parameters or content.
    try { client.release(destroy ? new Error('sql-v08 connection discarded') : undefined); }
    catch { /* A driver teardown error cannot rewrite a known committed outcome or disclose diagnostics. */ }
  }
}
