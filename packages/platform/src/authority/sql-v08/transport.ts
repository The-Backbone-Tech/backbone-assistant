import { transaction, type Context } from './session.ts';
export { transaction };
import type { AttemptRequest, AuthenticatedPersonalSession, ContractTerms, CrossingRecord, EffectAttempt, EffectDoor, LandingFile, PersonalInstallation, PersonAuthority, PersonRequest, RunAuthority,
  RunHandle, SqlClient, SqlOutcome, SqlPool, SqlV08PersonalRuntime, TrustedExecutionObserver,
  TrustedPersonalSessionOwner } from './types.ts';
export type * from './types.ts';

const uuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s);
const text = (s: unknown): s is string => typeof s === 'string' && s.length > 0;
const validHandle = (h: RunHandle) => h && uuid(h.run) && Number.isSafeInteger(h.fence) && h.fence > 0 && text(h.secret);
const invalid = (): SqlOutcome<never> => ({ status: 'denied', code: 'invalid-input' });
const required = () => ({ status: 'dependency' as const, dependency: 'trusted-personal-session-owner' as const });
/** A lifetime in exact units, so the person reads the grant SQL receives, never a rounding of it. */
const lifetime = (ms: number) => {
  const parts: string[] = []; let rest = ms;
  for (const [unit, size] of [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000], ['second', 1_000], ['millisecond', 1]] as const) {
    const n = Math.floor(rest / size); rest -= n * size;
    if (n) parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`);
  }
  return parts.join(' ') || '0 milliseconds';
};
/** What forming a contract grants, in the words the person confirms. Derived from the terms SQL receives; list entries are quoted so distinct sets read differently. */
export const contractStatement = (plane: string, t: ContractTerms) => {
  const list = (xs: readonly string[]) => (xs.length ? xs.map((x) => JSON.stringify(x)).join(', ') : 'none');
  return `Give plane ${plane} a contract for task ${t.purpose}, for ${lifetime(t.ttlMs)}: data ${list(t.data)}; tools ${list(t.tools)}; destinations ${list(t.destinations)}; models ${list(t.models)}; budget ${t.budget}; effects up to class ${t.ceiling}${t.checker ? '; it may check other work' : '; it may not check other work'}.`;
};
export const scalar = async (client: SqlClient, sql: string, values: unknown[] = []) =>
  (await client.query(sql, values)).rows[0]?.value;
const identifier = (value: unknown): string => {
  if (!uuid(value)) throw new Error('invalid SQL result'); return value;
};
const optionalIdentifier = (value: unknown) => value === null ? null : identifier(value);
const validBase64 = (value: string): boolean => {
  // Fixed-state scan: bounded stack and no decoded/normalised copy, even for large landed files.
  let length = 0; let padding = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13 || code === 32) continue;
    if (code === 61) { if (++padding > 2) return false; }
    else if (padding !== 0 || !((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
    length++;
  }
  return length % 4 === 0;
};
const landingFiles = (value: unknown): readonly LandingFile[] | null => {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error('invalid SQL result');
  return Object.freeze(Array.from(value, file => {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.bytes !== 'string') {
      throw new Error('invalid SQL result');
    }
    // PostgreSQL base64 may contain line wrapping. Validate without changing the observed payload.
    if (!validBase64(file.bytes)) throw new Error('invalid SQL result');
    return Object.freeze({ path: file.path, bytes: file.bytes });
  }));
};
const handleResult = (value: unknown): RunHandle => {
  if (!value || typeof value !== 'object') throw new Error('invalid SQL result');
  const r = value as Record<string, unknown>;
  const handle = { run: identifier(r.runId), fence: Number(r.fence), secret: r.secret as string };
  if (!validHandle(handle)) throw new Error('invalid SQL result');
  return Object.freeze(handle);
};
const runContext = (workspaceId: string, h: RunHandle): Context =>
  ({ workspaceId, run: h.run, fence: h.fence, secret: h.secret });
const hex = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const slug = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9._-]{1,64}$/.test(s);
const validAttempt = (a: AttemptRequest) => a && ['document', 'external', 'irreversible'].includes(a.class) && slug(a.tool) && slug(a.operation) &&
  hex(a.target) && hex(a.args) && hex(a.key) && Number.isFinite(a.cost) && a.cost >= 0;
const attemptRow = (value: unknown): EffectAttempt => {
  if (!value || typeof value !== 'object') throw new Error('invalid SQL result');
  const r = value as Record<string, unknown>;
  return Object.freeze({ id: identifier(r.id), run: identifier(r.run_id), fence: Number(r.fence), class: r.class as EffectAttempt['class'],
    tool: r.tool as string, operation: r.operation as string, target: r.target_sha256 as string, args: r.args_sha256 as string,
    key: r.key as string, cost: Number(r.cost), status: r.status as EffectAttempt['status'],
    reconciliation: (r.reconciliation_sha256 ?? null) as string | null });
};
const validObserved = (observed: string) => ['approved-executed', 'execution-error'].includes(observed);
function validTerms(terms: ContractTerms) {
  return terms && uuid(terms.purpose) && [terms.data, terms.tools, terms.destinations, terms.models]
    .every(set => Array.isArray(set) && set.every(text)) && [1, 2, 3, 4].includes(terms.ceiling) && Number.isSafeInteger(terms.budget) &&
    terms.budget >= 0 && Number.isSafeInteger(terms.ttlMs) && terms.ttlMs > 0 && typeof terms.checker === 'boolean';
}

/**
 * The `recordUnknown` a promotion crossing's trusted binding must carry: the door's own call, on its
 * own login, for when the checker lost its response. It throws so the crossing keeps both errors.
 */
export const crossingDoor = (door: Pick<EffectDoor, 'recordUnknownCrossing'>) => ({
  recordUnknown: async (intent: string, snapshot: string, iteration: number) => {
    const recorded = await door.recordUnknownCrossing(intent, snapshot, iteration);
    if (recorded.status !== 'committed') throw new Error(`The door could not record this unknown (${recorded.status}).`);
  },
});

/** Trusted composition entrypoint only. No renderer/agent request may supply these dependencies.
 * This transport does not implement human authentication, provisioning or person-session issuance.
 * The identity owner must supply an actual authenticated SQL session for the fixed installation. */
export async function openSqlV08PersonalRuntime(input: {
  readonly appPool: SqlPool; readonly observerPool: SqlPool;
  readonly binding: PersonalInstallation; readonly sessions?: TrustedPersonalSessionOwner;
  /** One call's bound. Past it the outcome is unknown: the call may yet commit, and nothing retries it. */
  readonly timeoutMs?: number;
}): Promise<{ readonly status: 'ready'; readonly runtime: SqlV08PersonalRuntime } |
  ReturnType<typeof required> | Exclude<SqlOutcome<never>, { status: 'committed' }>> {
  const binding = Object.freeze({ workspaceId: input.binding.workspaceId, personId: input.binding.personId,
    accountId: input.binding.accountId });
  if (!input.sessions || !uuid(binding.workspaceId) || !uuid(binding.personId) || !text(binding.accountId)) return required();
  if (input.appPool === input.observerPool) return { status: 'unavailable', reason: 'credential-role' };
  const app = input.appPool; const observer = input.observerPool; const sessions = input.sessions;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const bounded = async <T>(call: Promise<SqlOutcome<T>>): Promise<SqlOutcome<T>> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<SqlOutcome<T>>((resolve) => { timer = setTimeout(() => resolve({ status: 'unknown', reason: 'transaction-outcome-unknown' }), timeoutMs); });
    try { return await Promise.race([call, late]); } finally { clearTimeout(timer); }
  };
  const session = async (request: PersonRequest): Promise<AuthenticatedPersonalSession | null> => {
    try {
      const current = await sessions.current(request);
      if (current.status !== 'authenticated' || current.workspaceId !== binding.workspaceId ||
        current.personId !== binding.personId || current.accountId !== binding.accountId || !text(current.personToken)) return null;
      return { ...current };
    } catch { return null; }
  };
  // The bound covers the kernel call, not the person: a confirmation waits for its answer.
  const person = <T>(op: (c: SqlClient) => Promise<T>, request: PersonRequest = { act: 'routine' }): Promise<SqlOutcome<T>> => (async (): Promise<SqlOutcome<T>> => {
    const s = await session(request);
    if (!s) return { status: 'denied', code: 'personal-session-required' };
    return bounded(transaction(app, 'app', { workspaceId: binding.workspaceId, personId: binding.personId,
      personToken: s.personToken }, op));
  })();
  if (!await session({ act: 'open' })) return required();
  // SQL validates the supplied session; a broker's claimed identity alone cannot open the runtime.
  const authenticated = await person(c => scalar(c, 'SELECT sec.effective_principal() AS value'), { act: 'open' });
  if (authenticated.status !== 'committed') return authenticated;
  if (authenticated.value !== binding.personId) return required();
  const control = (run: string, operation: 'reclaim' | 'cancel' | 'erase', statement?: string) => {
    if (!uuid(run)) return Promise.resolve(invalid());
    return person(async c => handleResult(await scalar(c,
      'SELECT gov.control_run($1::uuid,$2::text,false) AS value', [run, operation])), statement ? { act: operation, statement } : { act: operation });
  };
  const door = <T>(op: (c: SqlClient) => Promise<T>) => bounded(transaction(observer, 'observer', { workspaceId: binding.workspaceId }, op));
  const effects: EffectDoor = Object.freeze<EffectDoor>({
    attempt: async (presented, request) => {
      const h = { ...presented }; const a = { ...request };
      if (!validHandle(h) || !validAttempt(a)) return invalid();
      return door(async c => identifier(await scalar(c,
        'SELECT gov.attempt_effect($1::uuid,$2::bigint,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::numeric) AS value',
        [h.run, h.fence, a.class, a.tool, a.operation, a.target, a.args, a.key, a.cost])));
    },
    claim: async (attempt, leaseMs) => !uuid(attempt) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 ? invalid() :
      door(async c => (await scalar(c, 'SELECT gov.claim_attempt($1::uuid,$2::int) AS value', [attempt, leaseMs])) as string | null),
    begin: async (attempt, claim, args, target) => !uuid(attempt) || !text(claim) || !hex(args) || !hex(target) ? invalid() :
      door(async c => (await scalar(c, 'SELECT gov.begin_attempt($1::uuid,$2::text,$3::text,$4::text) AS value', [attempt, claim, args, target])) === true),
    settle: async (attempt, claim, outcome) => !uuid(attempt) || !text(claim) ? invalid() :
      door(async c => { await c.query('SELECT gov.settle_attempt($1::uuid,$2::text,$3::text)', [attempt, claim, outcome]); }),
    sweep: () => door(async c => Number(await scalar(c, 'SELECT gov.sweep_attempts() AS value'))),
    reconcile: async (attempt, outcome, observation) => !uuid(attempt) || !hex(observation) ? invalid() :
      door(async c => { await c.query('SELECT gov.reconcile_attempt($1::uuid,$2::text,$3::text)', [attempt, outcome, observation]); }),
    attempts: async run => !uuid(run) ? invalid() : door(async c => {
      const rows = await scalar(c, 'SELECT gov.read_attempts($1::uuid) AS value', [run]);
      if (!Array.isArray(rows)) throw new Error('invalid SQL result');
      return Object.freeze(rows.map(attemptRow));
    }),
    attemptsOf: async runs => !runs.every(uuid) ? invalid() : door(async c => {
      const rows = await scalar(c, `SELECT coalesce(jsonb_agg(a),'[]'::jsonb) AS value
        FROM unnest($1::uuid[]) r, jsonb_array_elements(gov.read_attempts(r)) a`, [[...runs]]);
      if (!Array.isArray(rows)) throw new Error('invalid SQL result');
      return Object.freeze(rows.map(attemptRow));
    }),
    // A revoke leaves the status running. effect_cap asks whether the run still holds its authority for this write.
    mayLand: async (run, fence, attempt) => !uuid(run) || !Number.isSafeInteger(fence) || fence < 1 || !uuid(attempt) ? invalid() : door(async c => (await scalar(c,
      `SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(gov.read_attempts($1::uuid)) a WHERE a->>'id'=$3::text AND a->>'status'='dispatching'
        AND gov.effect_cap($1::uuid,$2::bigint,a->>'tool',a->>'operation') IS NOT NULL) AS value`, [run, fence, attempt])) === true),
    recordUnknownCrossing: async (intent, snapshot, iteration) => !uuid(intent) || !uuid(snapshot) || !Number.isSafeInteger(iteration) || iteration < 1 ? invalid() :
      door(async c => { await c.query('SELECT gov.record_unknown_crossing($1::uuid,$2::uuid,$3::int)', [intent, snapshot, iteration]); }),
    crossingRecords: () => door(async c => {
      const rows = await scalar(c, `SELECT gov.dump_crossing_rows()->'verifier_attempts' AS value`);
      if (!Array.isArray(rows)) throw new Error('invalid SQL result');
      return Object.freeze(rows.map((r): CrossingRecord => Object.freeze({ intent: identifier(r.intent_id), snapshot: identifier(r.snapshot_id),
        disposition: String(r.disposition), reconciliation: (r.reconciliation_sha256 ?? null) as string | null })));
    }),
    closeRun: async (run, fence, status) => !uuid(run) || !Number.isSafeInteger(fence) || fence < 1 ? invalid() :
      door(async c => { await c.query('SELECT gov.close_run($1::uuid,$2::bigint,$3::text)', [run, fence, status]); }),
    readRun: async run => !uuid(run) ? invalid() : door(async c => {
      const r = await scalar(c, 'SELECT gov.read_run($1::uuid) AS value', [run]) as Record<string, unknown> | null;
      return r ? Object.freeze({ id: identifier(r.id), status: String(r.status), fence: Number(r.fence) }) : null;
    }),
    database: () => door(async c => String(await scalar(c, `SELECT (SELECT system_identifier::text FROM pg_control_system())||'/'||current_database() AS value`))),
    runs: async task => !uuid(task) ? invalid() : door(async c => {
      const rows = await scalar(c, `SELECT coalesce(jsonb_agg(jsonb_build_object('id',r->>'id','status',r->>'status','fence',(r->>'fence')::bigint)),'[]'::jsonb) AS value
        FROM jsonb_array_elements(gov.dump_crossing_rows()->'runs') r WHERE r->>'task_id'=$1::text`, [task]);
      if (!Array.isArray(rows)) throw new Error('invalid SQL result');
      return Object.freeze(rows.map(r => Object.freeze({ id: identifier(r.id), status: String(r.status), fence: Number(r.fence) })));
    }),
    allRuns: () => door(async c => {
      const rows = await scalar(c, `SELECT coalesce(jsonb_agg(jsonb_build_object('id',r->>'id','task',r->>'task_id','status',r->>'status','fence',(r->>'fence')::bigint)),'[]'::jsonb) AS value
        FROM jsonb_array_elements(gov.dump_crossing_rows()->'runs') r`);
      if (!Array.isArray(rows)) throw new Error('invalid SQL result');
      return Object.freeze(rows.map(r => Object.freeze({ id: identifier(r.id), task: String(r.task), status: String(r.status), fence: Number(r.fence) })));
    }),
  });
  const runtime: SqlV08PersonalRuntime = {
    door: effects,
    person: Object.freeze<PersonAuthority>({
      principal: () => person(async c => identifier(await scalar(c, 'SELECT sec.effective_principal() AS value'))),
      confirm: (act, statement) => !text(act) || !text(statement) ? Promise.resolve(invalid()) :
        person(async c => identifier(await scalar(c, 'SELECT sec.effective_principal() AS value')), { act, statement }),
      // Each act that releases, settles, grants or destroys asks its own words, which name what it executes.
      acceptAttempt: (attempt, target, args, statement) => !uuid(attempt) || !hex(target) || !hex(args) || !text(statement) ? Promise.resolve(invalid()) : person(async c => {
        await c.query('SELECT gov.accept_attempt($1::uuid,$2::text,$3::text)', [attempt, target, args]); },
        { act: 'accept-held', statement: `${statement}\n\nAttempt ${attempt}, target ${target}, arguments ${args}.` }),
      denyAttempt: (attempt, statement) => !uuid(attempt) || !text(statement) ? Promise.resolve(invalid()) : person(async c => {
        await c.query('SELECT gov.deny_attempt($1::uuid)', [attempt]); }, { act: 'deny-held', statement: `${statement}\n\nAttempt ${attempt}.` }),
      reconcilePromotionAsOwner: (intent, snapshot, observed, observation) => !uuid(intent) || !uuid(snapshot) || !validObserved(observed) || !hex(observation) ? Promise.resolve(invalid()) :
        person(async c => String(await scalar(c, 'SELECT gov.reconcile_promotion_as_owner($1::uuid,$2::uuid,$3::text,$4::text) AS value', [intent, snapshot, observed, observation])),
          { act: 'settle-promotion', statement: `Promotion ${intent}, snapshot ${snapshot}: its landing is UNKNOWN. Record it as ${observed}? SQL cannot check this, and nothing is resent.` }),
      readLanding: artifactId => !uuid(artifactId) ? Promise.resolve(invalid()) : person(async c => landingFiles(
        await scalar(c, 'SELECT gov.read_landing($1::uuid) AS value', [artifactId]))),
      createPlane: name => !text(name) ? Promise.resolve(invalid()) : person(async c => identifier(await scalar(c,
        'SELECT gov.create_plane($1::text,NULL::uuid,NULL::uuid[],false) AS value', [name]))),
      createTask: (plane, title) => !uuid(plane) || !text(title) ? Promise.resolve(invalid()) : person(async c => identifier(await scalar(c,
        'SELECT gov.create_task($1::uuid,$2::text) AS value', [plane, title]))),
      formContract: (plane, terms) => {
        if (!uuid(plane) || !validTerms(terms)) return Promise.resolve(invalid());
        // These finite terms describe SQL's envelope only. No consent/account/tool meaning is invented here.
        const sqlTerms = { data: [...terms.data], tools: [...terms.tools], destinations: [...terms.destinations],
          models: [...terms.models], budget: terms.budget, ceiling: terms.ceiling };
        const purpose = terms.purpose; const checker = terms.checker; const ttlMs = terms.ttlMs;
        return person(async c => identifier(await scalar(c,
          'SELECT gov.set_contract($1::uuid,$2::uuid,$3::jsonb,$4::bool,$5::uuid,$6::float8) AS value',
          [plane, purpose, JSON.stringify(sqlTerms), checker, binding.personId, ttlMs])),
          { act: 'form-contract', statement: contractStatement(plane, terms) });
      },
      admitRun: args => {
        if (!uuid(args.plane) || !uuid(args.task)) return Promise.resolve(invalid());
        // Admission attributes are provenance claims, never authority or a caller-selected lineage root.
        const a = args.attributes;
        if (a && [a.model, a.family, a.provider].some(v => v !== undefined && !text(v))) return Promise.resolve(invalid());
        const attributes = a ? { model: a.model, family: a.family, provider: a.provider } : {};
        const plane = args.plane; const task = args.task;
        return person(async c => handleResult(await scalar(c,
          'SELECT gov.admit_run($1::uuid,$2::uuid,$3::jsonb) AS value',
          [plane, task, JSON.stringify(attributes)])));
      },
      reclaim: run => control(run, 'reclaim'),
      cancel: async run => { const r = await control(run, 'cancel'); return r.status === 'committed' ?
        { status: 'committed', value: undefined } : r; },
      erase: async run => { const r = await control(run, 'erase', `Erase run ${run}: its content is destroyed and cannot be read again. This cannot be undone.`); return r.status === 'committed' ?
        { status: 'committed', value: undefined } : r; },
      revokeContract: plane => !uuid(plane) ? Promise.resolve(invalid()) : person(async c => identifier(await scalar(c,
        'SELECT gov.revoke_contract($1::uuid,false) AS value', [plane]))),
    }),
    run: presented => {
      const h = Object.freeze({ ...presented });
      return Object.freeze<RunAuthority>({
        writeContent: async args => {
          if (!validHandle(h) || !uuid(args.execution) || !text(args.key) || !(args.bytes instanceof Uint8Array)) return invalid();
          const key = args.key; const execution = args.execution; const note = args.note === true;
          const bytes = Buffer.from(args.bytes);
          return transaction(app, 'app', runContext(binding.workspaceId, h), async c => {
            await scalar(c, 'SELECT gov.write_content($1::text,$2::bytea,$3::bool,$4::uuid) AS value',
              [key, bytes, note, execution]);
          });
        },
        reconcilePromotion: async (intent, snapshot, observed) => {
          if (!validHandle(h) || !uuid(intent) || !uuid(snapshot) || !validObserved(observed)) return invalid();
          return transaction(app, 'app', runContext(binding.workspaceId, h), async c => String(await scalar(c,
            'SELECT gov.reconcile_promotion($1::uuid,$2::uuid,$3::text) AS value', [intent, snapshot, observed])));
        },
        readContent: async (key, note = false) => {
          if (!validHandle(h) || !text(key)) return invalid();
          return transaction(app, 'app', runContext(binding.workspaceId, h), async c => {
            // Lock and authenticate the run before a single explicit key read; no inventory surface.
            await c.query('SELECT * FROM gov.open_scratch()');
            const doc = await scalar(c, `SELECT doc AS value FROM app.scratch_items
              WHERE run_id=$1::uuid AND collection=$2::text AND key=$3::text AND run_id=sec.current_run()`,
            [h.run, note ? 'protocol_notes' : 'protocol_files', key]);
            if (doc === undefined) return null;
            if (!doc || typeof doc !== 'object') throw new Error('invalid SQL result');
            const d = doc as Record<string, unknown>;
            if (typeof d.bytes !== 'string') throw new Error('invalid SQL result');
            return { bytes: Buffer.from(d.bytes, 'base64'), execution: identifier(d.execution) };
          });
        },
      });
    },
    observer: Object.freeze<TrustedExecutionObserver>({
      observeExecution: async (presented, observed) => {
        const h = { ...presented }; const o = { ...observed };
        if (!validHandle(h) || ![o.model, o.pin, o.family, o.provider, o.region, o.harness].every(text)) return invalid();
        return transaction(observer, 'observer', runContext(binding.workspaceId, h), async c => optionalIdentifier(await scalar(c,
          'SELECT gov.observe_execution($1::uuid,$2::bigint,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text) AS value',
          [h.run, h.fence, o.model, o.pin, o.family, o.provider, o.region, o.harness, h.secret])));
      },
      issueOutboundLease: async presented => {
        const h = { ...presented }; if (!validHandle(h)) return invalid();
        return transaction(observer, 'observer', runContext(binding.workspaceId, h), async c => optionalIdentifier(await scalar(c,
          'SELECT gov.issue_outbound_lease($1::uuid,$2::bigint,$3::text) AS value', [h.run, h.fence, h.secret])));
      },
    }),
  };
  return { status: 'ready', runtime: Object.freeze(runtime) };
}
