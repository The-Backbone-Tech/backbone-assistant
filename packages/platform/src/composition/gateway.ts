// Composition of the gateway port for doors (src/gateway.ts) over the core's crossings. A door acts
// as one grant: the person's mandate to a worker of their own, narrowed to named operations and a
// ceiling, granted to the door's registered piece, with one run the door holds while it is open. The
// core caps the grant by what the door declares; a door whose files are not that registration does not open. The core decides every effect; this file
// only carries proposals in, dispatches what the core allowed through a named executor, and reads
// receipts back. No policy lives here: refusals are the core's, in the core's words.
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STATED_REASONS } from '@backbone/core/db';
import type { DoorGrant, EffectOutcome, EffectReceipt, Executor, Gateway, GatewayArgs, GatewayMethod, GatewayRefusal, GatewayRefusalReason, GatewayValue, KnowledgeItem } from '../gateway.ts';
import { GRANT_NAME } from '../doors/protocol.ts';
import { sha256, writeAtomic } from '../stub/fsx.ts';
import { CoreCloseWaitRefusal, CoreLink, CoreRefusal, type CoreOptions, type RunHandle } from './core.ts';
import { outboxExecutor } from './outbox.ts';
import { inActiveHomeLockScope, withHomeLock } from './home-lock.ts';
import { loadPiece, PieceRefused, PIECES, pieceOnDisk, registerPiece } from './pieces.ts';
export { CoreCloseWaitRefusal } from './core.ts';

/** The door's run lease, renewed while the door is open; a killed door's run is claimable again after it. */
const LEASE_MS = 6_000;
/** A claim on one effect while it is dispatched. */
const DISPATCH_LEASE_MS = 30_000;
const DAY = 86_400_000;
/** How often an open door looks for dispatches whose dispatcher went silent. */
const SWEEP_MS = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GatewayOptions {
  /** The data home the door works in. */
  home: string;
  /** The grant's name (`doors/<name>.json` in the home), as `grantDoor` wrote it. */
  grant: string;
  /** The operations this installation can carry out; `outbox.write` by default. */
  executors?: Record<string, Executor>;
  /** How long a dispatcher's claim on one effect lasts before another may take it (tests shorten it). */
  dispatchLeaseMs?: number;
  /** The door's own folder, whose files must be its registered content; the MCP door's by default. */
  piece?: string;
  baselineSql?: CoreOptions['baselineSql'];
  postgresNative?: CoreOptions['postgresNative'];
  keys?: CoreOptions['keys'];
}

export interface GrantOptions {
  home: string;
  name: string;
  /** The operations the door may propose. Nothing else is in its mandate. */
  operations: string[];
  /** The highest effect class allowed without a person's decision (1 to 4). */
  ceiling: number;
  days?: number;
  /** An absolute expiry, used exactly as given (the one the person approved); a past one is refused. */
  expiresAt?: Date;
  /**
   * The caller's id for this grant, recorded by the caller before it asks (the outbox pattern): the
   * mandate carries it, so granting again with it returns the same grant (its file published again
   * if missing), and a grant whose file never appeared is still found, and revoked, by it.
   */
  intent?: string;
  maxEffects?: number;
  /** The door's own folder: registered as it is on disk, and the grant bound to it. The MCP door's by default. */
  piece?: string;
  baselineSql?: CoreOptions['baselineSql'];
  postgresNative?: CoreOptions['postgresNative'];
  keys?: CoreOptions['keys'];
}

const grantPath = (home: string, name: string) => join(home, 'doors', `${name}.json`);

export function readGrant(home: string, name: string): DoorGrant | null {
  if (!GRANT_NAME.test(name)) return null;
  const path = grantPath(home, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as DoorGrant) : null;
}

interface StandingDoor {
  mandate: string;
  agent: string;
  /** Null when the grant was cut short after its mandate and before its run. */
  run: string | null;
  task: string | null;
  operations: string[];
  ceiling: number;
  expires_at: Date;
  piece_id: string;
  piece: string;
  version: string;
  digest: string;
}

/**
 * The standing mandates the core holds for a grant's intent: the core's own answer, not the grant's
 * file. Found by the intent alone, so a mandate whose run was never queued is found too.
 */
export async function standingForIntent(link: CoreLink, intent: string): Promise<StandingDoor[]> {
  const { rows } = await link.read<StandingDoor>(
    link.person(),
    `SELECT m.id AS mandate, m.subject_id AS agent, r.id AS run, r.task_id AS task, m.operations, m.ceiling, m.expires_at, m.piece_id, p.piece, p.version, p.digest
       FROM app.mandates m LEFT JOIN app.runs r ON r.mandate_id = m.id LEFT JOIN app.pieces p ON p.id = m.piece_id
      WHERE m.intent->>'connection' = $1 AND m.revoked_at IS NULL`,
    [intent],
  );
  return rows;
}

function publish(home: string, grant: DoorGrant): boolean {
  mkdirSync(join(home, 'doors'), { recursive: true, mode: 0o700 });
  // Written whole beside its name, then linked into place: a link never replaces an existing grant.
  const tmp = `${grantPath(home, grant.name)}.${process.pid}.tmp`;
  writeAtomic(tmp, `${JSON.stringify(grant, null, 2)}\n`);
  try {
    linkSync(tmp, grantPath(home, grant.name));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * The person grants a door: they register the door's piece as it is on disk, then a worker of
 * theirs, a mandate narrowed to `operations` under `ceiling` and granted to that piece, a task and one
 * queued run. Done by the person on their own machine, never through a door, holding the data
 * home's lock (home-lock.ts) so another process never grants or revokes beside it.
 */
export function grantDoor(options: GrantOptions): Promise<DoorGrant> {
  return personOperation(options.home, () => grantDoorHeld(options));
}

/** Retry only the typed refusal from Core.open's pre-write admission. The held operations below
 * open Core before any mutation. A nested caller cannot release its outer holder or await close. */
async function personOperation<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const nested = inActiveHomeLockScope(home);
  if (!nested) await CoreLink.pendingClose(home);
  try { return await withHomeLock(home, operation); }
  catch (error) {
    if (nested || !(error instanceof CoreCloseWaitRefusal)) throw error;
    // A failed captured close propagates here. There is no catch around this wait or the second
    // attempt: a second racing close exhausts the budget, and no partial/unknown effect is retried.
    await error.closed;
    return withHomeLock(home, operation);
  }
}

async function grantDoorHeld(options: GrantOptions): Promise<DoorGrant> {
  if (!GRANT_NAME.test(options.name)) throw new Error('A grant name is lowercase letters, digits and dashes.');
  if (!options.operations.length) throw new Error('Name at least one operation.');
  const expiresAt = options.expiresAt ?? new Date(Date.now() + (options.days ?? 30) * DAY);
  if (expiresAt.getTime() <= Date.now()) throw new Error('This grant\'s expiry has already passed; nothing was granted.');
  // A name is granted once: granting it again would leave the earlier mandate acting, out of reach of revoke.
  const taken = () => new Error(`A door named ${options.name} is already granted in this home; revoke it and grant another name.`);
  const piece = pieceOnDisk(options.piece ?? PIECES.mcp.dir, PIECES.mcp.id);
  const link = await CoreLink.open({ home: options.home, baselineSql: options.baselineSql, postgresNative: options.postgresNative, keys: options.keys });
  try {
    const me = link.person();
    if (options.intent) {
      // Granted before under this intent: the same grant, its file published again if it never appeared.
      const [was] = await standingForIntent(link, options.intent);
      if (was) {
        // Cut short after its mandate: its task and run are made now, once.
        const task = was.task ?? (await link.call<string>(me, 'SELECT gov.create_task($1, $1, $2, NULL, NULL)', [link.id.person, `Work through the ${options.name} door`]));
        const run = was.run ?? (await link.call<string>(me, 'SELECT gov.queue_run($1, $2, $3)', [task, was.agent, was.mandate]));
        const grant: DoorGrant = {
          name: options.name,
          agent: was.agent,
          mandate: was.mandate,
          task,
          run,
          operations: was.operations,
          ceiling: was.ceiling,
          expiresAt: new Date(was.expires_at).toISOString(),
          piece: { id: was.piece_id, piece: was.piece, version: was.version, digest: was.digest },
        };
        const onFile = readGrant(options.home, options.name);
        if (onFile && onFile.mandate !== grant.mandate) throw taken();
        if (!onFile) publish(options.home, grant);
        return grant;
      }
    }
    if (existsSync(grantPath(options.home, options.name))) throw taken();
    const registration = await registerPiece(link, piece);
    const agent = await link.call<string>(me, 'SELECT gov.create_agent($1, $2)', [`Door: ${options.name}`, 'worker']);
    const mandate = await link.call<string>(
      me,
      `SELECT gov.issue_mandate($1, NULL, '[]'::jsonb, '[]'::jsonb, '["door"]'::jsonb, $2::jsonb, $3::smallint, NULL, NULL, NULL, $4, $5, 'piece', $7::jsonb, $6)`,
      [agent, JSON.stringify(options.operations), options.ceiling, options.maxEffects ?? null, expiresAt, registration.id, JSON.stringify({ door: options.name, connection: options.intent ?? null })],
    );
    // Tests kill the process here: the mandate is committed, its run and its file are not.
    if (process.env.BACKBONE_CRASH_AT === 'grant.issued') process.kill(process.pid, 'SIGKILL');
    const task = await link.call<string>(me, 'SELECT gov.create_task($1, $1, $2, NULL, NULL)', [link.id.person, `Work through the ${options.name} door`]);
    const run = await link.call<string>(me, 'SELECT gov.queue_run($1, $2, $3)', [task, agent, mandate]);
    const grant: DoorGrant = { name: options.name, agent, mandate, task, run, operations: options.operations, ceiling: options.ceiling, expiresAt: expiresAt.toISOString(), piece: registration };
    if (!publish(options.home, grant)) {
      await link.call(me, 'SELECT gov.revoke_mandate($1)', [mandate]);
      throw taken();
    }
    return grant;
  } finally {
    await link.release();
  }
}

/**
 * The person revokes a door's mandate: its run stops, and effects not yet sent are cancelled. With
 * an `intent`, every standing mandate the core holds for it is revoked too, whether or not its file
 * exists: a missing file is never taken for a revoked grant.
 */
export function revokeDoor(options: { home: string; name: string; intent?: string } & Pick<CoreOptions, 'baselineSql' | 'postgresNative' | 'keys'>): Promise<number> {
  return personOperation(options.home, async () => {
    const grant = readGrant(options.home, options.name);
    if (!grant && !options.intent) throw new Error(`No door named ${options.name} in this home.`);
    const link = await CoreLink.open({ home: options.home, baselineSql: options.baselineSql, postgresNative: options.postgresNative, keys: options.keys });
    try {
      const mandates = new Set<string>(grant ? [grant.mandate] : []);
      if (options.intent) for (const m of await standingForIntent(link, options.intent)) mandates.add(m.mandate);
      let revoked = 0;
      for (const m of mandates) revoked += await link.call<number>(link.person(), 'SELECT gov.revoke_mandate($1)', [m]);
      return revoked;
    } finally {
      await link.release();
    }
  });
}

const OUTCOME: Record<string, EffectOutcome> = {
  succeeded: 'DONE',
  failed: 'FAILED',
  denied: 'REFUSED',
  cancelled: 'CANCELLED',
  awaiting_checker: 'AWAITING_DECISION',
  proposed: 'PENDING',
  allowed: 'PENDING',
  claimed: 'PENDING',
  dispatching: 'PENDING',
  unknown: 'UNKNOWN',
};

const NEXT: Record<EffectOutcome, string> = {
  DONE: 'Done. Nothing more to do.',
  FAILED: 'It did not happen. A new attempt is a new effect with a new idempotency key, if the person still wants it.',
  REFUSED: 'Nothing was sent. Do not retry it under another key; tell the person why it was refused.',
  CANCELLED: 'Nothing was sent. Tell the person.',
  AWAITING_DECISION: 'Nothing was sent yet. A person decides in the app; check this receipt again later with the same key.',
  PENDING: 'Allowed and not finished yet. Check this receipt again with the same key; never propose it again under a new key.',
  UNKNOWN: 'Sent, but nobody can tell whether it happened. Do not retry it under any key: a person settles it by inspection before resolveBy.',
};

interface EffectRow {
  id: string;
  idempotency_key: string;
  operation: string;
  status: string;
  effect_class: number;
  route: string | null;
  route_reason: string | null;
  repeat_of: string | null;
  args_hash: string;
  observation_hash: string | null;
  external_ref: string | null;
  resolve_by: Date | null;
  created_at: Date;
}
const EFFECT_COLUMNS = 'id, idempotency_key, operation, status, effect_class, route, route_reason, repeat_of, args_hash, observation_hash, external_ref, resolve_by, created_at';

function receiptOf(row: EffectRow): EffectReceipt {
  const outcome = OUTCOME[row.status] ?? 'UNKNOWN';
  return {
    effect: row.id,
    idempotencyKey: row.idempotency_key,
    operation: row.operation,
    outcome,
    status: row.status,
    effectClass: row.effect_class,
    route: row.route,
    reason: row.route_reason,
    repeatOf: row.repeat_of,
    argsHash: row.args_hash,
    observationHash: row.observation_hash,
    externalRef: row.external_ref,
    resolveBy: row.resolve_by ? new Date(row.resolve_by).toISOString() : null,
    proposedAt: new Date(row.created_at).toISOString(),
    next: NEXT[outcome],
  };
}

const refusal = (reason: GatewayRefusalReason, detail: string): GatewayRefusal => ({ ok: false, outcome: 'REFUSED', reason, detail });
const NO_MANDATE = refusal('NO_MANDATE', 'This door has no standing mandate: no grant, or its mandate was revoked or has expired. The person grants one in the app, or with `backbone-mcp grant` for a test home.');

/** A core refusal by its reason code only: the core's message text is never passed on (it may carry the caller's words). */
function fromCore(error: unknown): GatewayRefusal {
  if (!(error instanceof CoreRefusal)) return refusal('NOT_AVAILABLE', 'The call could not be completed.');
  const detail = `The core refused it (${STATED_REASONS.has(error.reason) ? error.reason : 'unclassified'}).`;
  if (error.reason === 'not_in_run' || error.reason === 'revoked') return { ...NO_MANDATE, detail: `${NO_MANDATE.detail} (${detail})` };
  if (error.reason === 'reused_key') return refusal('REUSED_KEY', detail);
  if (error.reason === 'paused') return refusal('NOT_AVAILABLE', 'Knowledge promotion and recall are paused because source checks could not be verified. Other work remains available; your sources and decisions are kept.');
  if (error.reason === 'invalid') return refusal('INVALID', detail);
  if (error.reason === 'not_found') return refusal('NOT_FOUND', detail);
  return refusal('REFUSED', detail);
}

/**
 * A dispatch whose dispatcher went silent is settled by inspection, never sent again. The core decides
 * whether it is silent, by the effect's own dispatch claim alone and atomically
 * (gov.settle_lapsed_dispatch): never by a run's lease or status, so a revoked run or a paused
 * dispatcher cannot have its outcome taken. Inspection is read-only; the crossing records DONE if it
 * landed and UNKNOWN otherwise, or leaves a live dispatch alone. A dispatcher that was only slow may
 * still settle the UNKNOWN by a late observation under its claim. The app's own document writes are
 * settled by the app (host.ts). Returns how many were settled.
 */
export async function sweepInterruptedDispatches(link: CoreLink, executors: Record<string, Executor>): Promise<number> {
  const claims = await link.read<{ effect_id: string; status: string; claim_token: string; args: Record<string, unknown> }>(link.system(), 'SELECT * FROM gov.held_claims()');
  let settled = 0;
  for (const c of claims.rows.filter((x) => x.status === 'dispatching')) {
    const { rows } = await link.read<{ operation: string }>(link.system(), 'SELECT operation FROM app.effects WHERE id = $1', [c.effect_id]);
    if (!rows[0] || rows[0].operation === 'workspace.write_document') continue;
    const executor = executors[rows[0].operation];
    const seen = executor
      ? await executor.inspect(c.args).catch(() => ({ landed: false, evidence: sha256(`inspect-failed:${c.effect_id}`) }))
      : { landed: false, evidence: sha256(`no-executor:${c.effect_id}`) };
    try {
      const outcome = await link.call<string>(link.system(), 'SELECT gov.settle_lapsed_dispatch($1, $2, $3, $4, $5)', [
        c.effect_id,
        c.claim_token,
        seen.landed,
        seen.evidence,
        seen.landed ? 'Found done on inspection after its dispatcher went silent.' : 'Its dispatcher went silent while this was being sent.',
      ]);
      if (outcome !== 'live') settled++;
    } catch {
      // Observed or settled by someone else meanwhile.
    }
  }
  return settled;
}

/** A door's gateway on a link of its own, released when the gateway closes. */
export async function openGateway(options: GatewayOptions): Promise<Gateway> {
  const link = await CoreLink.open({ home: options.home, baselineSql: options.baselineSql, postgresNative: options.postgresNative, keys: options.keys });
  try {
    return await gatewayOn(link, options, { own: true });
  } catch (error) {
    await link.release();
    throw error;
  }
}

/**
 * A door's gateway on `link`. With `own`, the gateway sweeps interrupted dispatches itself and
 * releases the link when it closes; otherwise (the doors a host serves, composition/doors.ts) the
 * host keeps the link and sweeps once for all of them.
 */
export async function gatewayOn(link: CoreLink, options: Pick<GatewayOptions, 'home' | 'grant' | 'executors' | 'dispatchLeaseMs' | 'piece'>, { own }: { own: boolean }): Promise<Gateway> {
  const executors = options.executors ?? { 'outbox.write': outboxExecutor(options.home) };
  const grant = readGrant(options.home, options.grant);
  const piece = pieceOnDisk(options.piece ?? PIECES.mcp.dir, PIECES.mcp.id);
  // A granted door opens only as the content its grant was bound to (read from the core, not the grant file).
  let doorPiece: string | null = null;
  if (grant) {
    const { registration } = await loadPiece(link, piece);
    const bound = await link.call<string | null>(link.system(), 'SELECT piece_id FROM app.runs WHERE id = $1', [grant.run]);
    if (bound !== registration.id) {
      throw new PieceRefused(`The ${grant.name} door was granted for another version or content of ${piece.manifest.id}; the person grants it again to use this one.`);
    }
    doorPiece = registration.id;
  }
  const worker = `door-${options.grant}-${process.pid}-${randomUUID().slice(0, 8)}`;
  let held: RunHandle | null = null;
  let renewal: NodeJS.Timeout | undefined;
  let closed = false;
  const crashAt = process.env.BACKBONE_CRASH_AT;

  /** Claim the grant's run: at once, or once a killed door's lease has lapsed. Null when its mandate no longer stands. */
  async function claimRun(): Promise<RunHandle | null> {
    if (!grant) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { rows } = await link.read<{ fence: string; secret: string }>(link.worker(), "SELECT fence, secret FROM gov.claim_run($1, $2, $3, 'piece', $4)", [grant.run, worker, LEASE_MS, doorPiece]);
        return rows[0] ? { run: grant.run, fence: Number(rows[0].fence), secret: rows[0].secret } : null;
      } catch (error) {
        if (!(error instanceof CoreRefusal) || error.reason !== 'not_claimable' || attempt > 0) return null;
        const { rows } = await link.read<{ ms: number; status: string }>(
          link.system(),
          'SELECT status, greatest(0, extract(epoch FROM lease_expires_at - clock_timestamp()) * 1000)::int AS ms FROM app.runs WHERE id = $1',
          [grant.run],
        );
        if (rows[0]?.status !== 'running') return null;
        await new Promise((r) => setTimeout(r, Math.min(rows[0].ms, LEASE_MS) + 100));
      }
    }
    return null;
  }
  // The run is claimed on the first call, not on open: a client probing the door (MCP version
  // negotiation spawns a short-lived sibling) must not hold the grant's run.
  let claiming: Promise<void> | undefined;
  const ready = () =>
    (claiming ??= claimRun().then((h) => {
      held = h;
      if (!h || closed) return;
      renewal = setInterval(() => {
        const current = held;
        if (current) link.call(link.runOf(current), 'SELECT gov.renew_run_lease($1, $2, $3)', [current.run, current.fence, LEASE_MS]).catch(() => (held = null));
      }, LEASE_MS / 3);
      renewal.unref();
    }));
  // Recovery needs no run authority: a revoked or expired door's interrupted dispatches are settled
  // too, at open and every few seconds while the door is open.
  const sweep = () => sweepInterruptedDispatches(link, executors).catch(() => 0);
  let sweeper: NodeJS.Timeout | undefined;
  if (own) {
    await sweep();
    sweeper = setInterval(sweep, SWEEP_MS);
    sweeper.unref();
  }

  async function row(h: RunHandle, where: string, params: unknown[]): Promise<EffectRow | null> {
    const { rows } = await link.read<EffectRow>(link.runOf(h), `SELECT ${EFFECT_COLUMNS} FROM app.effects WHERE run_id = $1 AND ${where} LIMIT 1`, [h.run, ...params]);
    return rows[0] ?? null;
  }

  /** Carry an allowed effect out once: claim it as the dispatcher, begin, run its executor, observe. */
  async function dispatch(effect: string) {
    let claim: string;
    try {
      claim = await link.call<string>(link.system(), 'SELECT gov.claim_effect($1, $2)', [effect, options.dispatchLeaseMs ?? DISPATCH_LEASE_MS]);
    } catch {
      return; // not claimable now (another dispatcher holds it, or its window has not passed): its receipt says PENDING
    }
    const { rows } = await link.read<{ operation: string; args: Record<string, unknown> }>(link.system(), 'SELECT operation, args FROM app.effects WHERE id = $1', [effect]);
    const executor = executors[rows[0].operation];
    if (crashAt === 'effect.claimed') process.kill(process.pid, 'SIGKILL');
    if (!(await link.beginDispatch(effect, claim))) return;
    if (crashAt === 'effect.begun') process.kill(process.pid, 'SIGKILL');
    let result: { outcome: 'succeeded' | 'failed' | 'unknown'; evidence: string; note?: string };
    try {
      result = executor ? await executor.dispatch(rows[0].args) : { outcome: 'unknown', evidence: sha256(`no-executor:${effect}`), note: 'no executor' };
    } catch {
      result = { outcome: 'unknown', evidence: sha256(`dispatch-threw:${effect}`), note: 'The executor could not tell what happened.' };
    }
    await link.observe(effect, claim, result.outcome, result.evidence, result.note ?? null);
  }

  async function withRun<T>(fn: (h: RunHandle) => Promise<T>): Promise<T | GatewayRefusal> {
    await ready().catch(() => {});
    const h = held;
    if (!h || closed) return NO_MANDATE;
    try {
      return await fn(h);
    } catch (error) {
      return fromCore(error);
    }
  }

  /** Move an effect the core allowed (or whose dispatcher's claim lapsed before it began) on to its outcome; then its receipt. */
  async function settle(h: RunHandle, id: string): Promise<GatewayValue<'effects.get'>> {
    const before = await row(h, 'id = $2', [id]);
    if (before?.status === 'allowed' || before?.status === 'claimed') await dispatch(id);
    const after = await row(h, 'id = $2', [id]);
    return after ? { ok: true as const, value: receiptOf(after) } : refusal('NOT_FOUND', 'no effect of this door has that id or key');
  }

  const methods: { [M in GatewayMethod]: (a: GatewayArgs<M>) => Promise<GatewayValue<M> | GatewayRefusal> } = {
    'effects.propose': (a) =>
      withRun(async (h) => {
        const executor = executors[a.operation];
        if (!executor) return refusal('NOT_AVAILABLE', `This installation cannot carry out that operation; it can: ${Object.keys(executors).join(', ')}.`);
        if (!a.args || typeof a.args !== 'object' || Array.isArray(a.args)) return refusal('INVALID', 'args is an object');
        const invalid = executor.validate(a.args);
        if (invalid) return refusal('INVALID', invalid);
        const id = await link.call<string>(
          link.runOf(h),
          `SELECT gov.propose_effect($1, $2, NULL, 'door', $3, NULL, NULL, NULL, NULL, $4::jsonb, $5, $6, $7)`,
          [h.run, h.fence, a.operation, JSON.stringify(a.args), a.description ?? '', a.expectedVersion ?? null, a.idempotencyKey],
        );
        return settle(h, id);
      }),
    'effects.get': (a) =>
      withRun(async (h) => {
        if (a.effect && !UUID.test(a.effect)) return refusal('INVALID', 'effect is an id this door was given');
        if (!a.effect && !a.idempotencyKey) return refusal('INVALID', 'name the effect or its idempotency key');
        const found = a.effect ? await row(h, 'id = $2', [a.effect]) : await row(h, 'idempotency_key = $2', [a.idempotencyKey]);
        // Reading is observational: it never claims or dispatches. Only propose carries an effect out.
        return found ? { ok: true as const, value: receiptOf(found) } : refusal('NOT_FOUND', 'no effect of this door has that id or key');
      }),
    'effects.list': (a) =>
      withRun(async (h) => {
        const limit = Math.max(1, Math.min(Number(a.limit ?? 20) || 20, 200));
        const { rows } = await link.read<EffectRow>(link.runOf(h), `SELECT ${EFFECT_COLUMNS} FROM app.effects WHERE run_id = $1 ORDER BY created_at DESC LIMIT $2`, [h.run, limit]);
        return { ok: true as const, value: rows.map(receiptOf) };
      }),
    'knowledge.recall': (a) =>
      withRun(async (h) => {
        link.requireMaterialGuard();
        const words = (a.words ?? []).filter((w) => typeof w === 'string' && w.length > 0).slice(0, 20);
        const limit = Math.max(1, Math.min(Number(a.limit ?? 20) || 20, 100));
        const { rows } = await link.read<KnowledgeItem>(link.runOf(h), 'SELECT statement, topic FROM gov.recall_knowledge($1, $2, $3)', [h.run, words, limit]);
        return { ok: true as const, value: rows, notice: { kind: 'source-withheld' as const, detail: link.knowledgeNotice } };
      }),
  };

  return {
    call: (method, args) => methods[method](args as never) as never,
    async close() {
      closed = true;
      clearInterval(renewal);
      clearInterval(sweeper);
      await claiming?.catch(() => {});
      // The database may be shared with the app on this data home: the door leaves it running.
      if (own) await link.release();
    },
  };
}
