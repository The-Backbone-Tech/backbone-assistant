// Finished checkpoint bytes are recovery data. Only the document gateway imports them as work.
// An inspection copy never acquires the original run's authority, trust or privacy standing.
import { createHash } from 'node:crypto';
import type { FileLink, ThreadSummary, Turn } from '../api.ts';
import type { MaterialStore } from '../stub/material.ts';
import { sha256 } from '../stub/fsx.ts';
import { CoreRefusal, type CoreLink, type RunHandle } from './core.ts';
import type { Checkpoint } from './harness-turn.ts';
import { cancelUncontinuableWrites, originalTurnRun, turnWrites } from './document-writes.ts';
import { verifiedRecoveredWrites, type StoredWrite } from './recovered-writes.ts';
import { custodyRun, reconcileClosedCustody, reconcileReclaimedCustody, unconfirmedCustody } from './thread-custody.ts';
import { withHomeLock } from './home-lock.ts';
import type { StoredThread } from './thread-journal.ts';

export interface CheckpointStore { load(): Checkpoint | null; save(value: Checkpoint): Promise<void>; clear(): Promise<void> }
type Owner = { version: 1; run: string; thread: string; turn: string; project: string };
type OwnedCheckpoint = Checkpoint & { recoveryOwner?: Owner };
export interface CheckpointContext {
  home: string; threadId: string; projectId: string; taskId: string; turn: Turn;
  link: CoreLink; material: MaterialStore; store: CheckpointStore;
}

type InterruptedTurn = { thread: StoredThread; turn: Turn };
class RecoveryUnavailable extends Error {}
/** Identity/data refusals and person-owned states cannot be repaired by waiting. */
export const retryableRecoveryError = (error: unknown) => !(error instanceof RecoveryUnavailable)
  && (!(error instanceof CoreRefusal) || error.reason === 'unclassified');
/** Re-observe original records, including a discovery which previously failed before admission.
 * A false return means no read failure needs retrying; it does not mean the work succeeded. */
export async function discoverRecovery(ctx: CheckpointContext, thread: StoredThread, pending: InterruptedTurn[],
  hooks: { closed(): Promise<void>; save(): Promise<void>; ended(): void; now(): string }): Promise<boolean> {
  const { turn, link, store, home, projectId } = ctx, state = inspectCheckpoint(store);
  const remove = () => { const index = pending.findIndex(entry => entry.turn === turn); if (index >= 0) pending.splice(index, 1); };
  try {
    if (state.problem) throw new Error(state.problem);
    const run = state.checkpoint ? await checkpointRun(ctx) : await custodyRun(home, thread.summary.id, turn.id, projectId);
    const open = run && (await link.read(link.system(), "SELECT id FROM app.runs WHERE id = $1 AND status IN ('queued', 'running', 'waiting')", [run])).rows.length > 0;
    if (state.checkpoint && !open && await preserveClosedCheckpoint(ctx, run, hooks.closed)) {
      remove(); thread.summary.running = pending.some(entry => entry.thread === thread); turn.work.endedAt = hooks.now();
      hooks.ended(); await hooks.save(); return false;
    }
    if (pending.some(entry => entry.turn === turn)) return false;
    if ((state.checkpoint && open) || (thread.task && await originalTurnRun(link, thread.task, turn.id, true))
      || (run && await unconfirmedCustody(home, thread.summary.id, run, turn.id, projectId, await turnWrites(link, run, turn.id)))) pending.push({ thread, turn });
    return false;
  } catch (error) {
    if (!state.problem && !state.checkpoint) return false;
    remove(); turn.status = 'stopped'; thread.summary.running = pending.some(entry => entry.thread === thread);
    turn.refusal = { reason: 'NOT_AVAILABLE', detail: 'Saved recovery data needs inspection. It is retained; other conversations can continue.' };
    turn.answer = { text: turn.refusal.detail, files: turn.answer?.files ?? [] }; await hooks.save();
    return !!state.checkpoint && !state.problem && retryableRecoveryError(error);
  }
}

/** An automatic retry settles only the existing run and receipts. In particular it must not
 * enter the ordinary carrier, which may propose an original write that was never dispatched. */
export async function retryCheckpoint(ctx: CheckpointContext, thread: StoredThread, hooks: {
  running: Map<string, AbortController>; register(controller: AbortController, turn: Turn): void;
  closing(): boolean; busy(): boolean; piece(): string | null; save(): Promise<void>; closed(): Promise<void>;
}): Promise<boolean> {
  if (hooks.closing()) return false;
  const state = inspectCheckpoint(ctx.store);
  if (state.problem || !state.checkpoint) return false;
  if (hooks.busy()) return true;
  let controller: AbortController | undefined, run: string | null = null;
  try {
    run = await checkpointRun(ctx);
    const pending = async () => {
      if (!run || ctx.turn.stopRequested) return false;
      const { rows } = await ctx.link.read<{ status: string }>(ctx.link.system(), 'SELECT status FROM app.effects WHERE run_id = $1', [run]);
      const observed = await imports(ctx, run, state.checkpoint!);
      return rows.some(row => !['succeeded', 'failed', 'denied', 'cancelled'].includes(row.status)) || observed.verified.effects.some(effect => effect.outcome === 'UNKNOWN');
    };
    if (await pending() || hooks.closing()) return false;
    if (hooks.busy()) return true;
    controller = new AbortController();
    hooks.running.set(ctx.threadId, controller); hooks.register(controller, ctx.turn); thread.summary.running = true;
    await hooks.save();
    if (hooks.closing()) return false;
    if (run) {
      const { rows } = await ctx.link.read<{ status: string }>(ctx.link.system(), 'SELECT status FROM app.runs WHERE id = $1 AND task_id = $2', [run, ctx.taskId]);
      if (rows.length !== 1) return false;
      if (['queued', 'running', 'waiting'].includes(rows[0].status)) {
        const handle = await ctx.link.reclaimRun(run, hooks.piece());
        if (hooks.closing()) return false;
        const current = inspectCheckpoint(ctx.store);
        if (current.problem || !current.checkpoint || JSON.stringify(current.checkpoint) !== JSON.stringify(state.checkpoint)) return false;
        const result = await reconcileReclaimedCustody({ home: ctx.home, thread: ctx.threadId, run, turn: ctx.turn.id, project: ctx.projectId }, ctx.link, handle, current.checkpoint);
        if (result.status !== 'reconciled' || await pending() || hooks.closing()) return false;
        // Closing failed narrows the old run; no producer, proposal or replacement handle is made.
        await ctx.link.finishRun(handle, 'failed');
      }
    }
    await preserveClosedCheckpoint(ctx, run, async () => { ctx.turn.refusal = undefined; await hooks.closed(); });
    return false;
  } catch (error) {
    // A revocation can close the original after our status read and before its reclaim.
    // Re-observe only that exact original; a failed claim grants no authority to continue it.
    if (!hooks.closing() && run && error instanceof CoreRefusal && error.reason === 'not_claimable') {
      try {
        const { rows } = await ctx.link.read<{ status: string }>(ctx.link.system(), 'SELECT status FROM app.runs WHERE id = $1 AND task_id = $2', [run, ctx.taskId]);
        return rows.length === 1 && ['succeeded', 'failed', 'cancelled'].includes(rows[0].status);
      } catch (readError) { return !hooks.closing() && retryableRecoveryError(readError); }
    }
    return !hooks.closing() && retryableRecoveryError(error);
  }
  finally {
    if (controller) {
      if (hooks.running.get(ctx.threadId) === controller) hooks.running.delete(ctx.threadId);
      thread.summary.running = hooks.running.has(ctx.threadId); await hooks.save();
    }
  }
}

/** One deferred attempt per turn, enabled only by the Host's explicit resume step.
 * Each callback rechecks source data and returns whether another observation is needed. */
export function createRecoveryRetries() {
  type Entry = { attempt(): Promise<boolean>; delay: number; timer?: NodeJS.Timeout; active?: Promise<void> };
  const entries = new Map<string, Entry>(); let enabled = false, closed = false;
  const arm = (key: string, entry: Entry) => {
    if (!enabled || closed || entry.timer || entry.active || entries.get(key) !== entry) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (closed || entries.get(key) !== entry) return;
      const active = (async () => {
        let again = true;
        try { again = await entry.attempt(); } catch { /* Unknown is retained and observed later. */ }
        finally {
          entry.active = undefined;
          if (!again || closed) { if (entries.get(key) === entry) entries.delete(key); }
          else { entry.delay = Math.min(entry.delay * 2, 30_000); arm(key, entry); }
        }
      })();
      entry.active = active;
    }, entry.delay);
    entry.timer.unref();
  };
  return {
    add(key: string, attempt: Entry['attempt']) {
      if (closed || entries.has(key)) return;
      const entry: Entry = { attempt, delay: 250 }; entries.set(key, entry); arm(key, entry);
    },
    enable() { if (closed) return; enabled = true; for (const [key, entry] of entries) arm(key, entry); },
    async close() {
      closed = true;
      for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
      const active = [...entries.values()].flatMap(entry => entry.active ? [entry.active] : []);
      entries.clear(); await Promise.allSettled(active);
    },
  };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Read failures stay with their turn, never taking down every conversation in the home. */
export function inspectCheckpoint(store: CheckpointStore): { checkpoint: OwnedCheckpoint | null; problem?: string } {
  try {
    const value: unknown = store.load();
    if (value === null) return { checkpoint: null };
    if (!object(value) || !Array.isArray(value.files) || !Array.isArray(value.sources)
      || value.files.some(file => !object(file) || typeof file.name !== 'string' || !file.name || typeof file.body !== 'string'
        || Buffer.byteLength(file.body) > 2_000_000 || Buffer.from(file.body).toString('utf8') !== file.body)
      || new Set(value.files.map(file => file.name)).size !== value.files.length
      || value.sources.some(source => !object(source) || typeof source.name !== 'string' || !Number.isSafeInteger(source.version))
      || (value.imports !== undefined && (!Array.isArray(value.imports) || value.imports.some(binding => !object(binding)
        || typeof binding.name !== 'string' || typeof binding.target !== 'string' || (binding.requested !== undefined && typeof binding.requested !== 'string'))))) throw new Error('invalid');
    return { checkpoint: value as unknown as OwnedCheckpoint };
  } catch { return { checkpoint: null, problem: 'Saved work could not be read safely. Its checkpoint is retained; other conversations can continue.' }; }
}

/** Visible state only. Core receipts and checkpoint attribution still own their facts. */
export function recoveryKind(input: { active: boolean; ordinary: boolean; inspection: boolean; dispatching: boolean; decision: boolean }): NonNullable<ThreadSummary['recoveryHold']>['kind'] | undefined {
  if (input.ordinary) return undefined;
  if (input.active || input.dispatching) return 'recovering';
  if (input.inspection) return 'inspection';
  return input.decision ? 'awaiting-decision' : 'recovering';
}
function firstCheckpoint(turns: readonly Turn[], store: (turn: string) => CheckpointStore, active: boolean) {
  for (const turn of turns) {
    // A normal producer's checkpoint is progress, not interrupted work. A resumed carrier
    // has turn.interrupted; a person's repair operates on a stopped turn.
    if (active && !turn.interrupted && turn.status !== 'stopped') continue;
    const state = inspectCheckpoint(store(turn.id));
    if (state.problem || state.checkpoint) return { turn, state };
  }
  return null;
}
/** Cheap fallback for a receipt read failure; never persists a derived hold. */
export function recoverySummary(summary: ThreadSummary, turns: readonly Turn[], store: (turn: string) => CheckpointStore, active: boolean): ThreadSummary {
  const { recoveryHold: _prior, ...stored } = summary;
  const plain = { ...stored, running: stored.running || active }, first = firstCheckpoint(turns, store, active);
  if (!first) return plain;
  return { ...plain, recoveryHold: { turnId: first.turn.id, kind: recoveryKind({ active, ordinary: false, inspection: !!first.state.problem, dispatching: false, decision: false })! } };
}
/** The earliest checkpoint and current Core facts supply the list/detail signal, never hints. */
export async function projectRecoverySummary(summary: ThreadSummary, turns: readonly Turn[], store: (turn: string) => CheckpointStore, active: boolean, link: CoreLink, task: string | undefined, locate: (turn: Turn) => Promise<string | null>): Promise<ThreadSummary> {
  const projected = recoverySummary(summary, turns, store, active), first = firstCheckpoint(turns, store, active);
  if (!projected.recoveryHold || !first || active) return projected;
  let inspection = !!first.state.problem, dispatching = false, decision = false;
  if (!inspection) {
    try { inspection = !task || !await locate(first.turn); }
    catch { inspection = true; }
  }
  if (task) try {
    const { rows } = await link.read<{ status: string }>(link.system(), `SELECT e.status FROM app.effects e JOIN app.runs r ON r.id = e.run_id
      WHERE r.task_id = $1 AND e.status IN ('unknown', 'dispatching', 'awaiting_checker', 'proposed', 'allowed', 'claimed')`, [task]);
    dispatching = rows.some(row => row.status === 'dispatching');
    decision = rows.some(row => ['unknown', 'awaiting_checker', 'proposed', 'allowed', 'claimed'].includes(row.status));
  } catch { /* A read failure cannot clear a hold or convert a stored hint into authority. */ }
  projected.recoveryHold.kind = recoveryKind({ active, ordinary: false, inspection, dispatching, decision })!;
  return projected;
}

/** Lifecycle refusals explain the retained owner instead of implying data is safe to remove. */
export async function recoveryRetentionReason(home: string, link: CoreLink, thread: StoredThread, store: (turn: string) => CheckpointStore): Promise<string | null> {
  if (thread.task) {
    const { rows } = await link.read<StoredWrite>(link.system(), `SELECT e.id, e.status, e.args, e.idempotency_key AS key, e.run_id AS run FROM app.effects e JOIN app.runs r ON r.id = e.run_id
      WHERE r.task_id = $1 AND e.operation = 'workspace.write_document' AND e.status NOT IN ('succeeded', 'failed', 'denied', 'cancelled')
      ORDER BY CASE WHEN e.status = 'unknown' THEN 0 ELSE 1 END, e.created_at, e.id LIMIT 1`, [thread.task]);
    if (rows.length) {
      const row = rows[0], turn = thread.turns.find(turn => row.key?.startsWith(`${turn.id}:`));
      return `The write of ${row.args.title}${turn ? ` in turn ${turn.id}` : ''} ${row.status === 'unknown' ? 'has an UNKNOWN outcome' : `is still ${row.status}`}. Inspect its original effect receipt ${row.id} in Needs you before moving or deleting this conversation. Nothing was resent.`;
    }
  }
  for (const turn of thread.turns) {
    const saved = inspectCheckpoint(store(turn.id));
    if (saved.problem || saved.checkpoint) return `Turn ${turn.id} retains ${saved.problem ? 'a checkpoint that needs inspection' : 'a checkpoint awaiting recovery'}. Open this conversation to recover it or keep its data for inspection before moving or deleting it.`;
    const run = await custodyRun(home, thread.summary.id, turn.id, thread.summary.projectId)
      ?? (thread.task ? await originalTurnRun(link, thread.task, turn.id) : null);
    if (await unconfirmedCustody(home, thread.summary.id, run, turn.id, thread.summary.projectId, run ? await turnWrites(link, run, turn.id) : [])) return `Turn ${turn.id} retains private original-write custody without a matching complete receipt. Its recovery record must remain available before this conversation can be moved or deleted.`;
  }
  return null;
}

/** A locator, never permission: the actual Core task binding and reclaim still have to agree. */
export async function checkpointRun(ctx: CheckpointContext): Promise<string | null> {
  const state = inspectCheckpoint(ctx.store);
  if (state.problem) throw new Error(state.problem);
  const owner = state.checkpoint?.recoveryOwner;
  let run: string | null = null;
  if (owner !== undefined) {
    if (!object(owner) || owner.version !== 1 || typeof owner.run !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner.run)
      || owner.thread !== ctx.threadId || owner.turn !== ctx.turn.id || owner.project !== ctx.projectId) throw new RecoveryUnavailable('The saved original-run identity does not match this turn. Recovery data is retained.');
    run = owner.run;
  } else {
    run = await custodyRun(ctx.home, ctx.threadId, ctx.turn.id, ctx.projectId, true)
      ?? await originalTurnRun(ctx.link, ctx.taskId, ctx.turn.id);
    if (!run) {
      const { rows } = await ctx.link.read<{ id: string }>(ctx.link.system(), "SELECT id FROM app.runs WHERE task_id = $1 AND status IN ('queued', 'running', 'waiting')", [ctx.taskId]);
      if (rows.length) throw new RecoveryUnavailable('The legacy checkpoint has no verified original-run identity. No open task run was substituted.');
    }
  }
  if (run) {
    const { rows } = await ctx.link.read<{ id: string }>(ctx.link.system(), 'SELECT id FROM app.runs WHERE id = $1 AND task_id = $2', [run, ctx.taskId]);
    if (rows.length !== 1) throw new RecoveryUnavailable('The saved run does not belong to this conversation. Recovery data is retained.');
  }
  return run;
}

function destination(file: Checkpoint['files'][number], checkpoint: Checkpoint): string | null {
  let target = file.name;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(target)) return null;
    seen.add(target);
    const next = (checkpoint.imports ?? []).filter(binding => binding.name === target && (binding.requested ?? binding.name) === file.name);
    if (!next.length) return target;
    if (next.length !== 1) return null;
    target = next[0].target;
  }
}
async function imports(ctx: CheckpointContext, run: string, checkpoint: Checkpoint) {
  const rows = await turnWrites(ctx.link, run, ctx.turn.id);
  const verified = await verifiedRecoveredWrites(ctx.link, rows, ctx.material, ctx.projectId);
  const confirmed = (file: Checkpoint['files'][number]) => rows.some(row => row.args.title === destination(file, checkpoint)
    && row.args.content_sha256 === sha256(file.body)
    && verified.effects.some(effect => effect.key === row.id && effect.outcome === 'DONE' && effect.materialId && effect.sha256 === row.args.content_sha256));
  return { rows, verified, confirmed };
}
const uncertain = (rows: StoredWrite[]) => rows.some(row => !['succeeded', 'failed', 'denied', 'cancelled'].includes(row.status));

/** Local private copies only. They are never projected to the project directory or admitted to a turn. */
async function inspectionCopies(ctx: CheckpointContext, files: Checkpoint['files']): Promise<FileLink[]> {
  return withHomeLock(ctx.home, async () => {
    const kept: FileLink[] = [];
    for (const file of files) {
      const digest = createHash('sha256').update(JSON.stringify([ctx.projectId, ctx.threadId, ctx.turn.id, file.name, file.body])).digest('hex');
      const id = digest.replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, '$1-$2-4$3-8$4-$5');
      let entry = ctx.material.load(id);
      if (entry) {
        if (entry.projectId !== ctx.projectId || entry.recovery?.turnId !== ctx.turn.id || entry.versions[0]?.sha256 !== sha256(file.body)
          || sha256(ctx.material.bytes(id, 1)) !== sha256(file.body)) throw new RecoveryUnavailable('A recovery-copy identity is already occupied; nothing was replaced.');
      } else {
        const name = ctx.material.freeName(ctx.projectId, `Saved piece ${kept.length + 1} (${ctx.turn.id.slice(0, 8)}).md`);
        entry = ctx.material.create(ctx.projectId, name, 'text/markdown', Buffer.from(file.body), 'working', 'agent', id, 'managed',
          { id: ctx.turn.id, name: 'Work that was not imported' }, undefined,
          { turnId: ctx.turn.id, reason: `The saved piece ${file.name} was not imported under its original run.` });
      }
      kept.push({ materialId: entry.id, name: entry.name, version: 1 });
    }
    return kept;
  });
}
function showCopies(ctx: CheckpointContext, files: FileLink[], confirmed: FileLink[] = []) {
  const known = new Map((ctx.turn.answer?.files ?? []).map(file => [`${file.materialId}:${file.version}`, file]));
  for (const file of [...confirmed, ...files]) known.set(`${file.materialId}:${file.version}`, file);
  ctx.turn.status = 'stopped';
  ctx.turn.answer = { text: files.length ? 'This work was interrupted. Unimported saved pieces are kept locally for you to inspect or retire; these inspection copies are not authorised outputs. No replacement write was proposed.' : `This work was interrupted. ${confirmed.length ? 'Recovered the completed artifact versions. Nothing was resent.' : 'No document was imported.'}`, files: [...known.values()] };
}

function showStopped(ctx: CheckpointContext, files: FileLink[]) {
  ctx.turn.status = 'stopped';
  const known = new Map((ctx.turn.answer?.files ?? []).map(file => [`${file.materialId}:${file.version}`, file]));
  for (const file of files) known.set(`${file.materialId}:${file.version}`, file);
  ctx.turn.answer = { text: 'Stopped. Unfinished saved pieces were not imported. Recorded effects keep their original outcomes; an unknown outcome is not success.', files: [...known.values()] };
}

/** Closure is established by Core before reservations retire. A closed/revoked run is never reopened. */
export async function preserveClosedCheckpoint(ctx: CheckpointContext, run: string | null, closeProjection: () => Promise<void>): Promise<boolean> {
  const state = inspectCheckpoint(ctx.store);
  if (state.problem) throw new Error(state.problem);
  if (!state.checkpoint) return false;
  if (!run) {
    const { rows } = await ctx.link.read(ctx.link.system(), "SELECT id FROM app.runs WHERE task_id = $1 AND status IN ('queued', 'running', 'waiting')", [ctx.taskId]);
    if (rows.length || await custodyRun(ctx.home, ctx.threadId, ctx.turn.id, ctx.projectId, true) || await originalTurnRun(ctx.link, ctx.taskId, ctx.turn.id)) return false;
    if (ctx.turn.stopRequested) showStopped(ctx, []);
    else showCopies(ctx, await inspectionCopies(ctx, state.checkpoint.files));
    await closeProjection();
    await ctx.store.clear();
    return true;
  }
  const { rows: status } = await ctx.link.read<{ status: string }>(ctx.link.system(), 'SELECT status FROM app.runs WHERE id = $1 AND task_id = $2', [run, ctx.taskId]);
  if (status.length !== 1 || !['succeeded', 'failed', 'cancelled'].includes(status[0].status)) return false;
  await cancelUncontinuableWrites(ctx.link, run, ctx.turn.id);
  const observed = await imports(ctx, run, state.checkpoint);
  if (ctx.turn.stopRequested) {
    const result = await reconcileClosedCustody({ home: ctx.home, thread: ctx.threadId, run, turn: ctx.turn.id, project: ctx.projectId }, ctx.link, true);
    if (result.status !== 'reconciled') throw new RecoveryUnavailable(`The stopped run retains unresolved custody (${result.status}).`);
    ctx.turn.effects = observed.verified.effects;
    showStopped(ctx, observed.verified.files);
    await closeProjection();
    await ctx.store.clear();
    return true;
  }
  if (uncertain(observed.rows) || observed.verified.effects.some(effect => effect.outcome === 'UNKNOWN')) return false;
  const copies = await inspectionCopies(ctx, state.checkpoint.files.filter(file => !observed.confirmed(file)));
  const result = await reconcileClosedCustody({ home: ctx.home, thread: ctx.threadId, run, turn: ctx.turn.id, project: ctx.projectId }, ctx.link, true);
  if (result.status !== 'reconciled') throw new RecoveryUnavailable(`The closed run retains unresolved custody (${result.status}).`);
  ctx.turn.effects = observed.verified.effects;
  showCopies(ctx, copies, observed.verified.files);
  await closeProjection();
  await ctx.store.clear();
  return true;
}

/** Used only by the single lifetime-owned Host carrier, outside any outer home lock.
 * `persist` journals turn.closed and saves its projection before checkpoint clear. The caller
 * keeps its in-process busy reservation until the carrier ends, even after that journal event.
 */
export function createCheckpointRecovery(ctx: CheckpointContext, handle: RunHandle, resumed: boolean, persist: () => Promise<void>) {
  const initial = inspectCheckpoint(ctx.store);
  if (initial.problem) throw new Error(initial.problem);
  const importing = resumed && !!initial.checkpoint;
  let terminal = false;
  const reconcile = async () => {
    const state = inspectCheckpoint(ctx.store);
    if (state.problem || !state.checkpoint) throw new RecoveryUnavailable(state.problem ?? 'The interrupted checkpoint is missing; no producer was started.');
    const result = await reconcileReclaimedCustody({ home: ctx.home, thread: ctx.threadId, run: handle.run, turn: ctx.turn.id, project: ctx.projectId }, ctx.link, handle, state.checkpoint);
    if (result.status !== 'reconciled') throw new RecoveryUnavailable(`Saved work could not be reconciled (${result.status}); its recovery data is retained.`);
  };
  const owner: Owner = { version: 1, run: handle.run, thread: ctx.threadId, turn: ctx.turn.id, project: ctx.projectId };
  const store: CheckpointStore = {
    load() {
      const state = inspectCheckpoint(ctx.store);
      if (state.problem || (importing && !state.checkpoint)) throw new RecoveryUnavailable(state.problem ?? 'The interrupted checkpoint is missing; no producer was started.');
      return state.checkpoint;
    },
    save(value) { const owned: OwnedCheckpoint = { ...value, recoveryOwner: owner }; return ctx.store.save(owned); },
    async clear() {
      if (!importing) return ctx.store.clear();
      if (ctx.turn.stopRequested) { await stop(); return; }
      await reconcile();
      const checkpoint = store.load()!;
      const observed = await imports(ctx, handle.run, checkpoint);
      if (uncertain(observed.rows) || observed.verified.effects.some(effect => effect.outcome === 'UNKNOWN')) {
        ctx.turn.work.steps.push({ kind: 'note', label: 'The import has an unresolved outcome. Its checkpoint and original receipts are retained; nothing is resent.' });
        return;
      }
      // The importer has drained. Close at the Core boundary before clearing data, so a crash
      // cannot restart this producer or accept a late proposal under the old run.
      await ctx.link.finishRun(handle, 'failed');
      terminal = await preserveClosedCheckpoint(ctx, handle.run, persist);
      if (!terminal) throw new Error('The finished import still needs reconciliation. Its checkpoint is retained.');
    },
  };
  const stop = async () => {
    if (!ctx.turn.stopRequested || !initial.checkpoint) return false;
    await cancelUncontinuableWrites(ctx.link, handle.run, ctx.turn.id);
    try { await ctx.link.finishRun(handle, 'failed'); }
    catch { /* A concurrent closure is accepted only by the task-bound Core read below. */ }
    terminal = await preserveClosedCheckpoint(ctx, handle.run, persist);
    if (!terminal) throw new Error('The stopped original run is not confirmed closed; its checkpoint is retained.');
    return terminal;
  };
  return { store, importing, reconcile, stop, get terminal() { return terminal; } };
}
