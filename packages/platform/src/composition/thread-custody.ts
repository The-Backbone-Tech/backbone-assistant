// Immutable write proposals live in the existing private thread file, never renderer drafts or
// public Turn. This is recovery provenance; only the Kernel receipt can authorize execution.
import { join } from 'node:path';
import type { Gateway } from '../stub/harness.ts';
import { managedPathProblem } from '../stub/material.ts';
import { readJson, sha256, writeJson } from '../stub/fsx.ts';
import { withHomeLock } from './home-lock.ts';
import { ThreadJournal } from './thread-journal.ts';
import type { StoredWrite } from './recovered-writes.ts';
import type { CoreLink, RunHandle } from './core.ts';

export type WriteTarget = Parameters<Gateway['write']>[0];
export interface OriginalWrite {
  version: 1;
  run: string;
  turn: string;
  project: string;
  target: WriteTarget;
  digest: string;
}
interface Custody { version: 1; writes: Record<string, OriginalWrite>; /** Inert originals removed from active recovery, keyed by turn/name, then their immutable digest. */ unproposed?: Record<string, Record<string, OriginalWrite>> }
type ThreadProjection = { summary: { id: string; projectId: string } };
const FIELD = 'writeCustody';
// The current text-import limit is also the recovery-body limit. Larger formats need a separate
// artifact operation, rather than an unbounded private JSON recovery payload.
const MAX_BODY_BYTES = 2_000_000;
const MAX_SOURCES = 2_000;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const name = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !/[\0\r\n]/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const pathOf = (home: string, thread: string) => {
  if (!identifier(thread)) throw new Error('Invalid private thread identity.');
  return join(home, 'threads', `${thread}.json`);
};

function originalPayload(run: string, turn: string, project: string, input: WriteTarget): Omit<OriginalWrite, 'digest'> {
  const sources = input.sourceVersions ?? [];
  return { version: 1, run, turn, project, target: { document: input.document, name: input.name, body: input.body, baseVersion: input.baseVersion,
    sourceVersions: sources.map((s) => ({ id: s.id, name: s.name, version: s.version })).sort((a, b) => a.id.localeCompare(b.id)),
    ...(input.managed ? { managed: true as const } : {}), ...(input.held ? { held: { id: input.held.id, name: input.held.name, ...(input.held.changed ? { changed: true as const } : {}) } } : {}) } };
}

function normalize(run: string, turn: string, project: string, input: WriteTarget): Omit<OriginalWrite, 'digest'> {
  if (![run, turn, project, input.document].every(identifier) || !name(input.name)
    || (input.managed ? !!managedPathProblem(input.name, []) : /[\\/]/.test(input.name) || input.name.startsWith('.'))
    || typeof input.body !== 'string' || Buffer.byteLength(input.body) > MAX_BODY_BYTES || input.body.includes('\0') || Buffer.from(input.body).toString('utf8') !== input.body
    || (input.baseVersion !== null && (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1))
    || (input.managed !== undefined && input.managed !== true)
    || (input.held !== undefined && (!object(input.held) || !identifier(input.held.id) || !name(input.held.name)))) throw new Error('The write is not a bounded recoverable text proposal. Nothing was proposed.');
  const sources = input.sourceVersions ?? [];
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES || sources.some((s) => !object(s) || !identifier(s.id) || !name(s.name) || !Number.isSafeInteger(s.version) || s.version < 1)
    || new Set(sources.map((s) => s.id)).size !== sources.length) throw new Error('Invalid original source identities or versions. Nothing was proposed.');
  return originalPayload(run, turn, project, input);
}

function parseOriginal(value: unknown): OriginalWrite | null {
  if (!object(value) || value.version !== 1 || !object(value.target) || typeof value.digest !== 'string') return null;
  try {
    const normalized = normalize(value.run as string, value.turn as string, value.project as string, value.target as unknown as WriteTarget);
    if (sha256(JSON.stringify(normalized)) !== value.digest) return null;
    return { ...normalized, digest: value.digest };
  } catch { return null; }
}

/** Verify the v1 data checksum without applying today's file eligibility or size policy. Never grants authority. */
function historicalOriginal(value: unknown): OriginalWrite | null {
  if (!object(value) || value.version !== 1 || typeof value.digest !== 'string' || !object(value.target)) return null;
  const target = value.target;
  if (![value.run, value.turn, value.project, target.document, target.name, target.body].every(v => typeof v === 'string')
    || !(target.baseVersion === null || Number.isSafeInteger(target.baseVersion))
    || (target.managed !== undefined && target.managed !== true)
    || !Array.isArray(target.sourceVersions ?? []) || (target.sourceVersions as unknown[] | undefined)?.some(v => !object(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || !Number.isSafeInteger(v.version))
    || (target.held !== undefined && (!object(target.held) || typeof target.held.id !== 'string' || typeof target.held.name !== 'string'))) return null;
  try {
    const data = originalPayload(value.run as string, value.turn as string, value.project as string, target as unknown as WriteTarget);
    return sha256(JSON.stringify(data)) === value.digest ? { ...data, digest: value.digest } : null;
  } catch { return null; }
}

/** Recovery can drop obsolete commit preconditions only for the same private held intent. */
function sameHeldIntent(original: OriginalWrite, proposal: OriginalWrite): boolean {
  const a = original.target, b = proposal.target;
  return !!a.held && !!b.held && a.held.id === b.held.id && a.held.name === b.held.name && a.held.changed === b.held.changed
    && a.document === b.document && a.name === b.name && a.body === b.body
    && a.baseVersion === b.baseVersion && a.managed === b.managed
    && (b.sourceVersions ?? []).every(source => (a.sourceVersions ?? []).some(before => before.id === source.id && before.name === source.name && before.version === source.version));
}

function owner(home: string, thread: string, project?: string): Record<string, unknown> {
  let value: unknown;
  try { value = readJson<unknown>(pathOf(home, thread), null); }
  catch { throw new Error('Stored conversation metadata could not be read; the original file is preserved.'); }
  if (!object(value) || !object(value.summary) || value.summary.id !== thread || (project !== undefined && value.summary.projectId !== project)) {
    throw new Error('The original thread owner could not be verified. Nothing was proposed.');
  }
  return value;
}

function envelope(value: unknown): Custody | null {
  if (!object(value) || value.version !== 1 || !object(value.writes)) return null;
  return value as unknown as Custody;
}

/** Ordinary projections cannot replace or erase private custody, even from a stale process. */
export async function saveThreadProjection<T extends ThreadProjection>(home: string, projection: T): Promise<void> {
  await withHomeLock(home, async () => {
    const path = pathOf(home, projection.summary.id);
    let previous: Record<string, unknown> | null;
    try { previous = readJson<Record<string, unknown> | null>(path, null); }
    catch { throw new Error('Stored conversation metadata could not be read; the original file is preserved.'); }
    const next: Record<string, unknown> = { ...projection };
    if (previous?.task !== undefined) {
      if (next.task !== undefined && next.task !== previous.task) throw new Error('The original thread task cannot be replaced by a projection.');
      next.task = previous.task;
    }
    if (Array.isArray(previous?.turns) && Array.isArray(next.turns)) {
      const ids = new Set(next.turns.filter(object).map((turn) => turn.id));
      const missing = previous.turns.filter(turn => !object(turn) || !ids.has(turn.id));
      // A completed rewind retains work in an exact journal-bound archive. An
      // ordinary stale projection cannot manufacture that authority or lose custody.
      const archived = missing.length ? new ThreadJournal(home).read().filter(event => event.kind === 'thread.rewound' && event.threadId === projection.summary.id) : [];
      if (missing.some(turn => !object(turn) || !archived.some(event => event.kind === 'thread.rewound' && event.record.turns.some(kept => kept.id === turn.id) &&
        Array.isArray(next.rewinds) && next.rewinds.some(record => JSON.stringify(record) === JSON.stringify(event.record))))) throw new Error('A stale projection cannot remove stored work. Reload the conversation.');
    }
    if (previous && Object.hasOwn(previous, FIELD)) next[FIELD] = previous[FIELD];
    else delete next[FIELD];
    writeJson(path, next);
  });
}

/**
 * Persist before Kernel proposal. Active turn/name intent is immutable, including its sources.
 * Retired intent remains checksum-bound. Only Host checkpoint recovery may narrow old source
 * preconditions for the identical private held body; this grants no Core authority or receipt replay.
 */
export async function retainOriginalWrite(home: string, thread: string, run: string, turn: string, project: string, target: WriteTarget, options?: { checkpointRecovery?: true }): Promise<OriginalWrite> {
  const normalized = normalize(run, turn, project, target);
  const proposal = { ...normalized, digest: sha256(JSON.stringify(normalized)) };
  return withHomeLock(home, async () => {
    const stored = owner(home, thread, project);
    const custody = stored[FIELD] === undefined ? { version: 1 as const, writes: {} as Record<string, OriginalWrite> } : envelope(stored[FIELD]);
    if (!custody) throw new Error('Original write custody is invalid. Nothing was proposed.');
    const key = `${turn}:${target.name}`;
    if (Object.hasOwn(custody.writes, key)) {
      const original = parseOriginal(custody.writes[key]);
      if (!original || original.digest !== proposal.digest) throw new Error('A changed proposal cannot replace its original body or source binding. Nothing was proposed.');
      return original;
    }
    if (custody.unproposed !== undefined) {
      if (!object(custody.unproposed)) throw new Error('The archived original history is invalid. Nothing was proposed.');
      const history = custody.unproposed[key];
      if (history !== undefined) {
        if (!object(history)) throw new Error('The archived original history is invalid. Nothing was proposed.');
        for (const [digest, raw] of Object.entries(history)) {
          const original = historicalOriginal(raw);
          if (!original || original.digest !== digest || original.run !== run || original.turn !== turn || original.project !== project || original.target.name !== target.name
            || (original.digest !== proposal.digest && !(options?.checkpointRecovery && sameHeldIntent(original, proposal)))) {
            throw new Error('An archived original cannot be replaced by a changed intent or wider source binding. Nothing was proposed.');
          }
        }
      }
    }
    custody.writes[key] = proposal;
    stored[FIELD] = custody;
    writeJson(pathOf(home, thread), stored);
    return proposal;
  });
}

/** Invalid/missing historical custody is data to reconcile, never a new authority grant. */
export async function originalWrite(home: string, thread: string, run: string, turn: string, project: string, targetName: string): Promise<OriginalWrite | null> {
  return withHomeLock(home, async () => {
    try {
      const custody = envelope(owner(home, thread, project)[FIELD]);
      const value = custody?.writes[`${turn}:${targetName}`];
      const original = parseOriginal(value);
      return original && original.run === run && original.turn === turn && original.project === project && original.target.name === targetName ? original : null;
    } catch { return null; }
  });
}

/** Private provenance can identify the original run even when proposal acknowledgement was lost. */
export async function custodyRun(home: string, thread: string, turn: string, project: string, checkpointRecovery = false): Promise<string | null> {
  return withHomeLock(home, async () => {
    const custody = envelope(owner(home, thread, project)[FIELD]);
    const runs = new Set<string>();
    for (const [key, value] of Object.entries(custody?.writes ?? {})) {
      if (!key.startsWith(`${turn}:`)) continue;
      const original = parseOriginal(value);
      if (!original || original.turn !== turn || original.project !== project || key !== `${turn}:${original.target.name}`) return null;
      runs.add(original.run);
    }
    // Historical intent is only a locator for an existing checkpoint's original run. It never
    // makes a write active or grants a reclaim; Core still authenticates the actual holder.
    if (checkpointRecovery && custody?.unproposed !== undefined) {
      if (!object(custody.unproposed)) throw new Error('The checkpoint original run history is invalid.');
      for (const [key, bucket] of Object.entries(custody.unproposed)) {
        if (!key.startsWith(`${turn}:`)) continue;
        if (!object(bucket)) throw new Error('The checkpoint original run history is invalid.');
        for (const [digest, value] of Object.entries(bucket)) {
          const original = historicalOriginal(value);
          if (!original || original.digest !== digest || original.turn !== turn || original.project !== project
            || key !== `${turn}:${original.target.name}` || !identifier(original.run)) throw new Error('The checkpoint original run history is invalid.');
          runs.add(original.run);
        }
      }
    }
    if (runs.size > 1) {
      if (checkpointRecovery) throw new Error('The checkpoint original run is ambiguous.');
      return null;
    }
    return [...runs][0] ?? null;
  });
}

/** Counts describe active private custody, never the outcome or settlement of an effect. */
export type CustodyReconciliation =
  | { status: 'reconciled'; removed: number; retained: number; receipts: number }
  | { status: 'not-closed' | 'not-current' | 'invalid' };
type CustodyContext = { home: string; thread: string; run: string; turn: string; project: string };
type RetainedCheckpoint = { files: readonly { name: string; body: string }[]; imports?: readonly { name: string; target: string; requested?: string }[] };

/** A saved file must retain the exact bytes and the Host-owned route to this original. */
function checkpointRetains(original: OriginalWrite, checkpoint?: RetainedCheckpoint | null): boolean {
  if (!checkpoint) return false;
  for (const file of checkpoint.files) {
    if (file.body !== original.target.body) continue;
    const seen = new Set<string>();
    let current = file.name, reached = false;
    for (;;) {
      if (seen.has(current) || managedPathProblem(current, [])) break;
      seen.add(current); reached ||= current === original.target.name;
      const next = (checkpoint.imports ?? []).filter(binding => binding.name === current && (binding.requested ?? binding.name) === file.name);
      if (!next.length) { if (reached) return true; break; }
      if (next.length !== 1) break;
      current = next[0].target;
    }
  }
  return false;
}

/** The caller holds the home lock and has established the original proposals' receipt boundary. */
function removeUnproposed(context: CustodyContext, recorded: ReadonlySet<string>, archive = false, checkpoint?: RetainedCheckpoint | null, closedBoundary = false): CustodyReconciliation {
  const { home, thread, run, turn, project } = context;
  const stored = owner(home, thread, project);
  // A native checkpoint may precede its first gateway reservation. After authenticated
  // reclaim there is then nothing to retire; a present malformed envelope remains invalid.
  if ((archive || closedBoundary) && stored[FIELD] === undefined) return { status: 'reconciled', removed: 0, retained: 0, receipts: recorded.size };
  const custody = stored[FIELD] === undefined ? undefined : envelope(stored[FIELD]);
  if (!custody) return { status: 'invalid' };
  const keys = Object.keys(custody.writes).filter((key) => key.startsWith(`${turn}:`));
  if (!keys.every((key) => {
    const original = parseOriginal(custody.writes[key]);
    return original?.run === run && original.turn === turn && original.project === project && key === `${turn}:${original.target.name}`;
  })) return { status: 'invalid' };
  const unproposed = keys.filter((key) => !recorded.has(key));
  if (archive && unproposed.length) {
    if (custody.unproposed !== undefined && !object(custody.unproposed)) return { status: 'invalid' };
    const history = { ...custody.unproposed };
    for (const key of unproposed) {
      const original = parseOriginal(custody.writes[key])!;
      if (!closedBoundary && !checkpointRetains(original, checkpoint)) return { status: 'invalid' };
      const previous = history[key];
      if (previous !== undefined && (!object(previous) || Object.entries(previous).some(([digest, raw]) => {
        const saved = historicalOriginal(raw);
        return !saved || saved.digest !== digest || saved.run !== run || saved.turn !== turn || saved.project !== project || saved.target.name !== original.target.name;
      }))) return { status: 'invalid' };
      if (previous && Object.hasOwn(previous, original.digest) && JSON.stringify(previous[original.digest]) !== JSON.stringify(custody.writes[key])) return { status: 'invalid' };
      // Unrelated inert history stays opaque; preserve exact current data without overwriting evidence.
      history[key] = { ...previous, [original.digest]: custody.writes[key] };
    }
    custody.unproposed = history;
  }
  for (const key of unproposed) delete custody.writes[key];
  if (unproposed.length) writeJson(pathOf(home, thread), { ...stored, [FIELD]: custody });
  return { status: 'reconciled', removed: unproposed.length, retained: keys.length - unproposed.length, receipts: recorded.size };
}

/**
 * Legacy no-row crossing: the caller already closed the run and read zero receipts. Current callers
 * use true only for that case. Receipt-aware callers use reconcileClosedCustody, never a partial list.
 * @deprecated New callers use the Core-checked reconcileClosedCustody crossing.
 */
export async function settleUnproposedWrites(home: string, thread: string, run: string, turn: string, project: string): Promise<boolean> {
  return withHomeLock(home, async () => {
    const result = removeUnproposed({ home, thread, run, turn, project }, new Set());
    return result.status === 'reconciled' && result.retained === 0;
  });
}

/**
 * The Core, not a supplied snapshot, establishes closure and the complete receipt list. A closed run
 * accepts no later proposal under the Core workspace lock. Every recorded key stays, including UNKNOWN
 * and mismatched receipts. Read failures change nothing. The result never says an effect did not run.
 */
export async function reconcileClosedCustody(context: CustodyContext, core: Pick<CoreLink, 'system' | 'read'>, retainHistory = false): Promise<CustodyReconciliation> {
  return withHomeLock(context.home, async (lost) => {
    const stillHeld = () => { if (lost.aborted) throw new Error('The home lock was lost; custody is unchanged.'); };
    const { rows: runs } = await core.read<{ status: string }>(core.system(), 'SELECT status FROM app.runs WHERE id = $1', [context.run]);
    stillHeld();
    if (runs.length !== 1 || !['succeeded', 'failed', 'cancelled'].includes(runs[0].status)) return { status: 'not-closed' };
    const prefix = `${context.turn}:`;
    const { rows } = await core.read<{ run: string; key: string }>(core.system(),
      'SELECT run_id AS run, idempotency_key AS key FROM app.effects WHERE run_id = $1', [context.run]);
    stillHeld();
    if (rows.some(row => row.run !== context.run || typeof row.key !== 'string')) return { status: 'invalid' };
    return removeUnproposed(context, new Set(rows.filter(row => row.key.startsWith(prefix)).map(row => row.key)), retainHistory, undefined, true);
  });
}

/**
 * Host recovery calls this immediately after reclaim, before this holder starts a producer or proposal,
 * outside any outer home lock, while owning the Host's lifetime home socket (the old Host is gone).
 * Reclaim fenced the prior holder; this home lock serializes the complete
 * receipt read with every document gateway proposal. Both authenticated reads must still name this
 * claim. System reads include even kept/private receipts; no caller supplies a partial effect list.
 * Only originals whose exact bytes and identity remain in the checkpoint leave active recovery.
 * Their private history stays inert until the thread is deleted, as other private custody does;
 * it is neither encrypted nor portable backup. A recovered held write may only narrow old sources.
 * This is not a general cleanup operation for a live producer or a substitute for Core receipts.
 */
export async function reconcileReclaimedCustody(context: CustodyContext, core: Pick<CoreLink, 'system' | 'runOf' | 'read'>, handle: RunHandle, checkpoint?: RetainedCheckpoint | null): Promise<CustodyReconciliation> {
  if (handle.run !== context.run || !Number.isSafeInteger(handle.fence) || handle.fence < 2 || !handle.secret) return { status: 'not-current' };
  return withHomeLock(context.home, async lost => {
    const stillHeld = () => { if (lost.aborted) throw new Error('The home lock was lost; custody is unchanged.'); };
    const current = async () => {
      const { rows } = await core.read<{ id: string }>(core.runOf(handle),
        "SELECT id FROM app.runs WHERE id = $1 AND status = 'running' AND fence = $2 AND sec.current_run() = $1", [context.run, handle.fence]);
      stillHeld();
      return rows.length === 1 && rows[0].id === context.run;
    };
    if (!await current()) return { status: 'not-current' };
    const { rows } = await core.read<{ run: string; key: string }>(core.system(),
      'SELECT run_id AS run, idempotency_key AS key FROM app.effects WHERE run_id = $1', [context.run]);
    stillHeld();
    if (rows.some(row => row.run !== context.run || typeof row.key !== 'string')) return { status: 'invalid' };
    if (!await current()) return { status: 'not-current' };
    return removeUnproposed(context, new Set(rows.filter(row => row.key.startsWith(context.turn + ':')).map(row => row.key)), true, checkpoint);
  });
}

export async function unconfirmedCustody(home: string, thread: string, run: string | null, turn: string, project: string, writes: readonly StoredWrite[]): Promise<boolean> {
  return withHomeLock(home, async () => {
    const value = owner(home, thread, project)[FIELD];
    if (value === undefined) return false;
    const custody = envelope(value);
    if (!custody) return true;
    for (const [key, value] of Object.entries(custody?.writes ?? {})) {
      if (!key.startsWith(`${turn}:`)) continue;
      const targetName = key.slice(turn.length + 1);
      const receipt = writes.find((row) => row.run === run && row.key === key && row.args.title === targetName);
      const original = parseOriginal(value);
      // A corrupt body can still be safely cancelled through its exact original SQL receipt.
      // A matching title alone cannot settle a different proposal, run or turn.
      if (!original) {
        if (receipt && ['failed', 'denied', 'cancelled'].includes(receipt.status)) continue;
        return true;
      }
      if (original.run !== run || original.turn !== turn || original.target.name !== targetName) return true;
      if (!receipt || receipt.args.document_id !== original.target.document || receipt.args.title !== original.target.name
        || receipt.args.content_sha256 !== sha256(original.target.body) || receipt.args.base_version !== original.target.baseVersion) return true;
      // Completed conversations may be moved by the person. That never rebinds pending work.
      if (original.project !== project && !['succeeded', 'failed', 'denied', 'cancelled'].includes(receipt.status)) return true;
    }
    return false;
  });
}

/** Explicit person repair only. Every run of the conversation must be closed and every receipt
 * final before opaque local bookkeeping can leave active custody. The synchronous callback
 * keeps its old value for the person even when unresolved receipts prevent release. No Core row or receipt is changed here.
 */
export async function releaseRecoveryBookkeeping(context: { home: string; thread: string; project: string; task: string }, core: Pick<CoreLink, 'system' | 'read'>,
  unchanged: () => void, preserve: (value: unknown) => { materialId: string }): Promise<boolean> {
  return withHomeLock(context.home, async lost => {
    const held = () => { if (lost.aborted) throw new Error('Recovery lock was lost; bookkeeping is retained.'); };
    const stored = owner(context.home, context.thread, context.project);
    if (stored.task !== context.task) throw new Error('The conversation task changed; bookkeeping is retained.');
    unchanged();
    const kept = Object.hasOwn(stored, FIELD) ? preserve(stored[FIELD]) : undefined;
    const { rows: tasks } = await core.read<{ id: string }>(core.system(), 'SELECT id FROM app.tasks WHERE id = $1', [context.task]);
    held();
    if (tasks.length !== 1 || tasks[0].id !== context.task) return false;
    const { rows: runs } = await core.read<{ status: string }>(core.system(), 'SELECT status FROM app.runs WHERE task_id = $1', [context.task]);
    held();
    if (runs.some(run => !['succeeded', 'failed', 'cancelled'].includes(run.status))) return false;
    const { rows } = await core.read<{ status: string }>(core.system(), 'SELECT e.status FROM app.effects e JOIN app.runs r ON r.id = e.run_id WHERE r.task_id = $1', [context.task]);
    held();
    if (rows.some(row => !['succeeded', 'failed', 'denied', 'cancelled'].includes(row.status))) return false;
    unchanged();
    held();
    writeJson(pathOf(context.home, context.thread), { ...stored, [FIELD]: { version: 1, writes: {}, unproposed: {}, ...(kept ? { inspectionCopy: kept.materialId } : {}) } });
    return true;
  });
}
