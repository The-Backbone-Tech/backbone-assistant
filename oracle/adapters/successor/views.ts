import { readFileSync } from 'node:fs';
import { type Bindings, type Client, merge, view } from './binding.ts';
import { ruleOfTwoViews } from './rule-of-two.ts';

/** The schemas the successor's core owns. */
export const PRODUCT_SCHEMAS = ['app', 'sec', 'gov', 'ops', 'auth', 'operator', 'crypto'];

export interface StoreWall {
  store: string;
  readable: boolean;
  forced: boolean;
  wall: 'exact' | 'missing' | 'not-restrictive' | 'not-the-workspace';
}

/**
 * Every tenant store and its wall, as the catalogue states it: a restrictive policy named
 * tenant_wall, for every role and command, whose read and write test is the session's workspace.
 */
export async function inventory(c: Client): Promise<StoreWall[]> {
  const { rows } = await c.query<{
    store: string;
    enabled: boolean;
    forced: boolean;
    permissive: string | null;
    cmd: string | null;
    roles: string[] | null;
    qual: string | null;
    with_check: string | null;
    readable: boolean;
  }>(
    `SELECT c.relname AS store, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            p.permissive, p.cmd, p.roles::text[] AS roles, p.qual, p.with_check,
            has_any_column_privilege(c.oid, 'SELECT') AS readable
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname AND p.policyname = 'tenant_wall'
     WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`,
  );
  return rows.map((r) => {
    const key = r.store === 'workspaces' ? 'id' : 'workspace_id';
    const exact = `(${key} = ( SELECT sec.current_workspace() AS current_workspace))`;
    const wall: StoreWall['wall'] =
      r.permissive === null
        ? 'missing'
        : r.permissive !== 'RESTRICTIVE' || r.cmd !== 'ALL' || JSON.stringify(r.roles) !== '["public"]'
          ? 'not-restrictive'
          : r.qual !== exact || r.with_check !== exact
            ? 'not-the-workspace'
            : 'exact';
    return { store: r.store, readable: r.readable, forced: r.enabled && r.forced, wall };
  });
}

/** Run `fn` once per item inside a savepoint, so nothing it does survives; returns each error text or null. */
async function probeEach<T>(c: Client, items: T[], fn: (item: T) => Promise<unknown>) {
  const out: { item: T; refusal: string | null }[] = [];
  for (const item of items) {
    await c.query('SAVEPOINT probe');
    try {
      await fn(item);
      out.push({ item, refusal: null });
    } catch (error) {
      out.push({ item, refusal: (error as Error).message });
    }
    await c.query('ROLLBACK TO SAVEPOINT probe');
  }
  return out;
}

/** The core's own catalogue of tenant stores: the pinned list its structural test holds the schema to. */
const declaredStores = () =>
  (JSON.parse(readFileSync(new URL('../../../packages/core/test/pinned.json', import.meta.url), 'utf8')) as { stores: string[] }).stores;

const catalog: Bindings = {
  'catalog.stores': { kind: 'view', run: (c) => inventory(c) },
  'catalog.declared_stores': { kind: 'view', run: async () => declaredStores().map((store) => ({ store })) },
  /** Functions in the core's schemas; internal ones (gov._* and every ops function) and who may execute them. */
  'catalog.functions': view(
    `SELECT n.nspname AS schema, p.proname AS name, p.oid::regprocedure::text AS signature,
            (n.nspname = 'gov' AND p.proname LIKE '\\_%') OR n.nspname = 'ops' AS internal,
            has_function_privilege(p.oid, 'EXECUTE') AS "serviceExecutes",
            has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExecutes"
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY ($1) ORDER BY 3`,
    () => [PRODUCT_SCHEMAS],
  ),
  /** Try every internal function as this session (each in a rolled-back savepoint); report each refusal. */
  'catalog.call_internals': {
    kind: 'view',
    run: async (c) => {
      const { rows } = await c.query<{ call: string; signature: string }>(
        `SELECT p.oid::regprocedure::text AS signature,
                format('SELECT %s.%s(%s)', n.nspname, quote_ident(p.proname),
                       coalesce((SELECT string_agg(format('NULL::%s', t::regtype), ', ' ORDER BY i)
                                 FROM unnest(p.proargtypes::regtype[]) WITH ORDINALITY AS a(t, i)), '')) AS call
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'gov' AND p.proname LIKE '\\_%' AND p.prokind = 'f' ORDER BY 1`,
      );
      return (await probeEach(c, rows, (r) => c.query(r.call))).map((p) => ({ signature: p.item.signature, refusal: p.refusal }));
    },
  },
  'catalog.run_hidden_columns': view(
    `SELECT a.attname AS column FROM pg_attribute a
     WHERE a.attrelid = 'app.runs'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND NOT has_column_privilege('app.runs', a.attname, 'SELECT') ORDER BY 1`,
  ),
  'run.mark_sources': view('SELECT untrusted_source, sensitive_source, elsewhere_source FROM app.runs WHERE id = $1', (a) => [a.run]),
  'catalog.account_stores': view(
    `SELECT c.relname AS store, pg_get_userbyid(c.relowner) AS owner,
            (SELECT bool_and(has_table_privilege('backbone_app', c.oid, p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p) AS "serviceReaches",
            has_table_privilege('backbone_gov', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') AS "crossingsReach",
            has_table_privilege('public', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') AS "publicReaches"
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  ),
  'catalog.read_operations_stores': {
    kind: 'view',
    run: async (c) => {
      const { rows } = await c.query<{ store: string }>(
        `SELECT c.relname AS store FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'ops' AND c.relkind IN ('r', 'p') ORDER BY 1`,
      );
      return (await probeEach(c, rows, (r) => c.query(`SELECT count(*) FROM ops.${r.store}`))).map((p) => ({
        store: p.item.store,
        refusal: p.refusal,
      }));
    },
  },
  /** Rows of one store visible to the session, counted inside and outside its own workspace. */
  'catalog.rows': {
    kind: 'view',
    run: async (c, a) => {
      const store = String(a.store);
      if (!/^[a-z_][a-z0-9_]*$/.test(store)) throw new Error(`not a store name: ${store}`);
      const key = store === 'workspaces' ? 'id' : 'workspace_id';
      const { rows } = await c.query(
        `SELECT count(*) FILTER (WHERE ${key} = $1::uuid)::int AS mine,
                count(*) FILTER (WHERE ${key} IS DISTINCT FROM $1::uuid)::int AS others, count(*)::int AS total
         FROM app.${store}`,
        [a.workspace ?? null],
      );
      return rows;
    },
  },
  'catalog.roles': view(
    `SELECT rolname AS role, rolsuper AS superuser, rolbypassrls AS "bypassRls" FROM pg_roles WHERE rolname LIKE 'backbone_%' ORDER BY rolname`,
  ),
};

/** Reads as the session sees them: row-level security decides what is there; rows use the oracle's names. */
const core: Bindings = {
  workspace: view('SELECT id, kind FROM app.workspaces'),
  principal: view(
    `SELECT id, kind, agent_role AS "agentRole", owner_id AS owner, status FROM app.principals
     WHERE ($1::uuid IS NULL OR id = $1) ORDER BY created_at`,
    (a) => [a.id ?? null],
  ),
  mandate: view(
    `SELECT id, issuer_id AS issuer, subject_id AS subject, on_behalf_of_id AS "onBehalfOf", parent_id AS parent,
            projects, connections, tools, operations, ceiling, max_tokens::float8 AS "maxTokens",
            max_cost_micros::float8 AS "maxCostMicros", max_duration_ms::float8 AS "maxDurationMs",
            max_effects::float8 AS "maxEffects", expires_at AS "expiresAt", revoked_at IS NOT NULL AS revoked
     FROM app.mandates WHERE ($1::uuid IS NULL OR id = $1) ORDER BY created_at`,
    (a) => [a.id ?? null],
  ),
  task: view('SELECT id, title, status FROM app.tasks WHERE ($1::uuid IS NULL OR id = $1)', (a) => [a.id ?? null]),
  run: view(
    `SELECT id, task_id AS task, agent_id AS agent, mandate_id AS mandate, status, stop_reason AS "stopReason",
            fence::float8 AS fence, tokens_used::float8 AS "tokensUsed", tainted_untrusted AS "taintedUntrusted",
            tainted_sensitive AS "taintedSensitive"
     FROM app.runs WHERE ($1::uuid[] IS NULL OR id = ANY ($1)) ORDER BY created_at, id`,
    (a) => [a.id ? [a.id] : (a.ids ?? null)],
  ),
  step: view('SELECT seq, kind, status, fence::float8 AS fence FROM app.run_steps WHERE run_id = $1 ORDER BY seq', (a) => [a.run]),
  effect: view(
    `SELECT id, status, effect_class AS "effectClass", external_party AS external, decision_id AS decision, route,
            route_reason AS "routeReason", args, args_hash AS "argsHash", undo_of AS "undoOf", idempotency_key AS "idempotencyKey"
     FROM app.effects WHERE ($1::uuid IS NULL OR id = $1) AND ($2::text IS NULL OR idempotency_key = $2) ORDER BY created_at, id`,
    (a) => [a.id ?? null, a.idempotencyKey ?? null],
  ),
  decision: view(
    `SELECT id, subject_kind AS "subjectKind", subject_id AS subject, proposer_id AS proposer, checker_kind AS "checkerKind",
            checker_id AS checker, proposal_hash AS "proposalHash", reason, status, escalation_note AS "escalationNote"
     FROM app.decisions WHERE ($1::uuid IS NULL OR id = $1) AND ($2::uuid IS NULL OR subject_id = $2)
       AND ($3::text IS NULL OR status = $3) ORDER BY created_at`,
    (a) => [a.id ?? null, a.subject ?? null, a.status ?? null],
  ),
  'operation.change': view('SELECT id, status FROM app.operation_changes WHERE id = $1', (a) => [a.id]),
  operation: view('SELECT operation, effect_class AS "effectClass" FROM app.operations ORDER BY operation'),
  ledger: view(
    `SELECT seq::float8 AS seq, entry_type AS type, actor_id AS actor, subject, payload, hash AS text
     FROM app.ledger WHERE ($1::text IS NULL OR subject = $1) ORDER BY seq`,
    (a) => [a.subject ?? null],
  ),
  memory: view('SELECT id, owner_id AS owner, content FROM app.memory ORDER BY created_at'),
  knowledge: view(
    'SELECT id, candidate_id AS candidate, statement, status FROM app.knowledge WHERE ($1::uuid IS NULL OR candidate_id = $1) ORDER BY created_at',
    (a) => [a.candidate ?? null],
  ),
};

const effects: Bindings = {
  'eff.effect_detail': view(
    `SELECT id, status, operation, connection, proposer_id AS proposer, run_id AS run, mandate_id AS mandate,
            effect_class AS "effectClass", external_party AS external, route, route_reason AS "routeReason",
            decision_id AS decision, undo_of AS "undoOf", repeat_of AS "repeatOf", expected_version AS "expectedVersion",
            idempotency_key AS "idempotencyKey"
     FROM app.effects WHERE ($1::uuid[] IS NULL OR id = ANY ($1)) AND ($2::uuid IS NULL OR undo_of = $2)
     ORDER BY created_at, id`,
    (a) => [a.id ? [a.id] : (a.ids ?? null), a.undoOf ?? null],
  ),
  'eff.document': view('SELECT id, content, version::float8 AS version, via_effect AS "viaEffect" FROM app.documents WHERE id = $1', (a) => [a.id]),
  /** Unknown outcomes waiting to be settled (lesson 9): each with its named resolver, its evidence and its deadline. */
  'lesson.unknowns': view(
    `SELECT id AS effect, resolver_id AS resolver, observation_hash AS evidence, resolve_by AS deadline,
            resolve_by <= clock_timestamp() AS overdue
     FROM app.effects WHERE status = 'unknown' ORDER BY updated_at`,
  ),
};

const ledger: Bindings = {
  'led.connection_tool': view('SELECT name FROM app.connection_tools WHERE connection_id = $1 AND removed_at IS NULL ORDER BY name', (a) => [
    a.connection,
  ]),
};

const promotion: Bindings = {
  'pro.knowledge': view(
    `SELECT id, candidate_id AS candidate, decision_id AS decision, owner_id AS owner, statement, topic, status,
            valid_from AS "validFrom", valid_to AS "validTo", retracted_reason AS "retractedReason"
     FROM app.knowledge WHERE ($1::uuid IS NULL OR candidate_id = $1) AND ($2::uuid IS NULL OR id = $2) ORDER BY id`,
    (a) => [a.candidate ?? null, a.id ?? null],
  ),
  'pro.candidate': view(
    `SELECT id, statement, status, proposed_by AS "proposedBy", owner_id AS owner FROM app.knowledge_candidates
     WHERE ($1::uuid IS NULL OR id = $1) AND ($2::text IS NULL OR statement = $2) ORDER BY id`,
    (a) => [a.id ?? null, a.statement ?? null],
  ),
  'pro.source': view(
    `SELECT id, source_kind AS kind, source_ref AS ref, trust, recorded_by AS principal, authored_by AS "authoredBy"
     FROM app.episodes WHERE ($1::text IS NULL OR source_ref = $1) ORDER BY id`,
    (a) => [a.ref ?? null],
  ),
  'pro.memory': view(
    'SELECT id, owner_id AS owner, content, forgotten_at IS NOT NULL AS forgotten FROM app.memory WHERE ($1::uuid IS NULL OR id = $1) ORDER BY id',
    (a) => [a.id ?? null],
  ),
  'pro.time_zone': view(`SELECT current_setting('TimeZone') AS zone`),
};

export const views: Bindings = merge({ catalog, core, effects, ledger, promotion, ruleOfTwo: ruleOfTwoViews });
