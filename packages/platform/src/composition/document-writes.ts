// The host's document gateway, separated for focused recovery tests. The Kernel still owns
// admission, identity, claims and receipts; material changes use the existing operation.
import { createConnectorMaterialGateway } from './connector-material-read.ts';
import type { ConnectorObservations } from './connector-observations.ts';
import { readMaterialFile } from './material-file-read.ts';
import type { ThreadJournal } from './thread-journal.ts';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { MaterialEntry } from '../api.ts';
import type { Gateway } from '../stub/harness.ts';
import type { MaterialStore } from '../stub/material.ts';
import { sha256 } from '../stub/fsx.ts';
import type { CoreLink, RunHandle } from './core.ts';
import { withHomeLock } from './home-lock.ts';
import { markWritten, writtenVersion, verifiedWrittenVersion, type StoredWrite } from './recovered-writes.ts';
import { originalWrite, retainOriginalWrite } from './thread-custody.ts';

export type WriteCrashPoint = 'write.custodied' | 'write.proposed' | 'write.claimed' | 'write.begun' | 'write.materialised' | 'write.recorded' | 'write.observed' | 'run.closed' | 'write.reconciled' | 'recovery.saved' | 'recovery.ready';
export interface DocumentGatewayOptions {
  home: string;
  link: CoreLink;
  handle: RunHandle;
  turnId: string;
  threadId: string;
  projectId: string;
  material: MaterialStore;
  /** Required for reads; write-only recovery does not manufacture preparation history. */
  journal?: Pick<ThreadJournal, 'append'>;
  observations?: ConnectorObservations;
  projectDir(id: string): string;
  crash(point: WriteCrashPoint): void;
  signal?: AbortSignal;
  /** Host lifetime only: cancel private history lock admission while closing. */
  closeSignal?: AbortSignal;
  recoveryOnly?: true;
  /** Host-only interrupted checkpoint import: no producer runs; only held source preconditions may narrow. */
  checkpointRecovery?: true;
  /** Set in recovery when the turn's read set shows a source withdrawn since: new work lands held. */
  heldFor?: () => { id: string; name: string } | undefined;
  /** Set in recovery: a related thread left this document UNKNOWN, so the original does not continue. */
  relatedHold?: (document: string, body: string) => Promise<boolean>;
  /** The Core task the run works for. A new document is created in it, so Core routes the write as
   * the run's own work rather than as publishing to the whole workspace (gov._route_for_run). */
  task?: string;
}

function rawPathCollision(options: DocumentGatewayOptions, target: Parameters<Gateway['write']>[0]): boolean {
  // Structured managed names identify custody metadata, never a path to inspect through folder links.
  if (target.managed && target.name.includes('/')) return false;
  // A file the store does not know is the person's: a new document never replaces it unread.
  if (target.baseVersion !== null || options.material.list(options.projectId, true).some((entry) => entry.name === target.name)) return false;
  try { lstatSync(join(options.projectDir(options.projectId), target.name)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function createDocumentGateway(options: DocumentGatewayOptions): Gateway {
  const { home, link, handle: h, threadId, turnId, projectId, material, crash } = options;
  const observed = new Map<string, { id: string; name: string; version: number }>();
    return {
      conditionalWrites: true,
      async read(request) {
        if (!options.journal) throw new Error('Material preparation history is unavailable; no source was handed over.');
        const prepared = await readMaterialFile({ ...options, journal: options.journal }, request);
        observed.set(prepared.materialId, { id: prepared.materialId, name: prepared.name, version: prepared.version });
        return prepared;
      },
      ...(options.observations ? { connector: createConnectorMaterialGateway({ ...options, observations: options.observations }) } : {}),
      async write(target, effect, perform) {
        return withHomeLock(home, async () => {
        target = { ...target, sourceVersions: target.sourceVersions ?? [...observed.values()] };
        const key = `${turnId}:${target.name}`;
        // Keep the existing semantic effect arguments unchanged. Source bindings are
        // recorded reads and a private commit precondition, never a new dedupe hash.
        const args: StoredWrite['args'] = { document_id: target.document, title: target.name, content_sha256: sha256(target.body), base_version: target.baseVersion };
        const { rows } = await link.read<StoredWrite>(link.system(), "SELECT id, status, args, idempotency_key AS key, run_id AS run, route_reason AS reason FROM app.effects WHERE run_id = $1 AND idempotency_key = $2 AND operation = 'workspace.write_document'", [h.run, key]);
        const prior = rows[0];
        // A new document lands in the run's task only while that task is private to the run's person
        // alone; otherwise it stays task-less, so Core routes it as publishing. A receipt keeps its task.
        if (prior) { if (prior.args.task_id) args.task_id = prior.args.task_id; }
        else if (target.baseVersion === null && options.task && await link.privateOwnTask(h.run, options.task)) args.task_id = options.task;
        if (!prior && options.recoveryOnly) {
          effect.detail = 'The original receipt could not be found. No substitute write was proposed.';
          return undefined;
        }
        if (prior) {
          effect.key = prior.id;
          if (['unknown', 'dispatching'].includes(prior.status)) {
            effect.outcome = 'UNKNOWN';
            effect.detail = `The earlier write of ${target.name} is UNKNOWN; its original effect is kept and it will not be resent.`;
            return undefined;
          }
          if (prior.status === 'succeeded') {
            if (prior.args.document_id !== args.document_id || prior.args.title !== args.title || prior.args.content_sha256 !== args.content_sha256 || prior.args.base_version !== args.base_version || (prior.args.task_id ?? null) !== (args.task_id ?? null)) {
              effect.outcome = 'REFUSED';
              effect.detail = 'A changed revision cannot reuse the completed write key; inspect its original result and use a new turn.';
              return undefined;
            }
            const landed = await verifiedWrittenVersion(link, prior, material, projectId);
            effect.outcome = landed ? 'DONE' : 'UNKNOWN';
            if (landed) markWritten(effect, landed, prior.args.content_sha256);
            if (!landed) effect.detail = 'The prior receipt succeeded, but its exact artifact version could not be verified; nothing was resent.';
            return landed ?? undefined;
          }
          if (['failed', 'denied', 'cancelled'].includes(prior.status)) {
            effect.outcome = 'REFUSED';
            effect.detail = `The earlier write of ${target.name} was ${prior.status}; a changed revision needs a new turn.`;
            return undefined;
          }
          if (prior.args.document_id !== args.document_id || prior.args.title !== args.title || prior.args.content_sha256 !== args.content_sha256 || prior.args.base_version !== args.base_version || (prior.args.task_id ?? null) !== (args.task_id ?? null)) {
            effect.outcome = 'UNKNOWN';
            effect.detail = `The original write of ${target.name} remains pending. Changed arguments cannot reuse its key; inspect the original receipt before any new attempt.`;
            return undefined;
          }
          const original = await originalWrite(home, threadId, h.run, turnId, projectId, target.name);
          if (!original) {
            effect.outcome = 'UNKNOWN';
            effect.detail = 'The original pending write has missing or invalid private custody. It was not replayed.';
            return undefined;
          }
          try { await retainOriginalWrite(home, threadId, h.run, turnId, projectId, target, options.checkpointRecovery ? { checkpointRecovery: true } : undefined); }
          catch {
            effect.outcome = 'UNKNOWN';
            effect.detail = 'Changed content or source bindings cannot replace the original pending proposal. Nothing was replayed.';
            return undefined;
          }
          target = original.target;
        }
        const entries = material.list(projectId, true);
        const current = entries.find((entry) => entry.name === target.name);
        // Managed native documents never write this filesystem path, including during later Save.
        // Refuse an existing raw path as well, so ordinary name collisions are clear in the UI.
        if (rawPathCollision(options, target)) {
          effect.outcome = prior ? 'UNKNOWN' : 'REFUSED';
          effect.detail = 'A workspace file already uses this name. Nothing was imported; any original pending receipt is preserved.';
          return undefined;
        }
        if (target.sourceVersions && ((current?.current ?? null) !== target.baseVersion || (current && current.id !== target.document)
          || target.sourceVersions.some((source) => !entries.some((entry) => entry.id === source.id && entry.name === source.name && entry.current === source.version && !entry.hidden)))) {
          effect.outcome = prior ? 'UNKNOWN' : 'REFUSED';
          effect.detail = 'A source identity/version or target changed while this draft was being prepared. Nothing was imported; any original pending receipt is preserved.';
          return undefined;
        }
        if (options.signal?.aborted && !prior) { effect.outcome = 'REFUSED'; effect.detail = 'Stopped before proposal. Nothing was imported.'; return undefined; }
        // Definitive local refusals precede custody. From this point a proposal attempt may
        // cross the Kernel boundary, so a lost acknowledgement must retain its exact intent.
        try { await retainOriginalWrite(home, threadId, h.run, turnId, projectId, target, options.checkpointRecovery ? { checkpointRecovery: true } : undefined); }
        catch {
          effect.outcome = prior ? 'UNKNOWN' : 'REFUSED';
          effect.detail = 'The original write proposal could not be retained unchanged. Nothing was proposed or replayed.';
          return undefined;
        }
        crash('write.custodied');
        const proposed = prior ? { ...prior, routeReason: null } : await link.proposeWrite(
          h,
          args,
          `Write ${target.name}`,
          key,
        );
        effect.key = proposed.id;
        crash('write.proposed');
        // Recovery consumes the original receipt; it never creates a replacement proposal.
        if (proposed.status === 'succeeded') {
          const landed = await verifiedWrittenVersion(link, { id: proposed.id, status: proposed.status, args: prior?.args ?? args }, material, projectId);
          effect.outcome = landed ? 'DONE' : 'UNKNOWN';
          if (landed) markWritten(effect, landed, (prior?.args ?? args).content_sha256);
          if (!landed) effect.detail = 'The receipt succeeded, but its exact artifact version could not be verified; nothing was resent.';
          return landed ?? undefined;
        }
        if (proposed.status === 'unknown') {
          effect.detail = `The app stopped during the write of ${target.name}. Its outcome is UNKNOWN and it will not be resent.`;
          return undefined;
        }
        const held = proposed.status === 'claimed' ? (await link.heldClaims()).find((h) => h.effect === proposed.id) : undefined;
        if (proposed.status !== 'allowed' && !held) {
          effect.outcome = 'REFUSED';
          effect.detail = proposed.routeReason === 'repeat_unknown_blocked'
            ? `An identical write of ${target.name} from a stopped turn has an UNKNOWN outcome, so it is not resent. Check ${target.name}, then ask again with a change.`
            : `The gateway did not let this write through (${proposed.routeReason ?? proposed.status}).`;
          return undefined;
        }
        const claim = held?.claim ?? (await link.claimEffect(proposed.id));
        crash('write.claimed');
        if (options.signal?.aborted) {
          await cancelOriginal(link, proposed.id);
          const actual = await readWrite(options, proposed.id);
          effect.outcome = actual?.status === 'cancelled' ? 'REFUSED' : 'UNKNOWN';
          effect.detail = actual?.status === 'cancelled' ? 'Stopped before dispatch; the original receipt is cancelled.' : 'Stopped; cancellation could not be confirmed. The original receipt remains unresolved.';
          return undefined;
        }
        // The task's audience can change after routing: a write Core allowed only because its task was private
        // to this run's person is cancelled before dispatch once that no longer holds (Core checks again under lock).
        if (!(await link.documentAudienceHolds(proposed.id))) {
          await cancelOriginal(link, proposed.id);
          const actual = await readWrite(options, proposed.id);
          effect.outcome = actual?.status === 'cancelled' ? 'REFUSED' : 'UNKNOWN';
          effect.detail = actual?.status === 'cancelled' ? 'The task was shared after this write was routed, so it was cancelled before dispatch. Nothing was written.' : 'Stopped; cancellation could not be confirmed. The original receipt remains unresolved.';
          return undefined;
        }
        if (!(await link.beginDispatch(proposed.id, claim))) {
          const actual = await readWrite(options, proposed.id);
          effect.outcome = actual && ['cancelled', 'denied', 'failed'].includes(actual.status) ? 'REFUSED' : 'UNKNOWN';
          effect.detail = `Dispatch did not begin here. Inspect the original receipt (${actual?.status ?? 'unavailable'}); nothing was resent.`;
          return undefined;
        }
        crash('write.begun');
        let result: Awaited<ReturnType<typeof perform>>;
        try {
          result = await perform();
        } catch (err) {
          const landed = writtenVersion(material, prior?.args ?? args, projectId);
          await link.observe(proposed.id, claim, landed ? 'unknown' : 'failed', sha256(`perform-error:${proposed.id}`), String(err));
          effect.outcome = landed ? 'UNKNOWN' : 'REFUSED';
          effect.detail = landed ? 'The artifact may have committed before reporting failed. Its outcome is UNKNOWN and it will not be resent.' : String(err);
          return undefined;
        }
        crash('write.materialised');
        if (result === 'stopped') {
          await link.observe(proposed.id, claim, 'unknown', sha256(`stopped:${proposed.id}`), 'Stopped during the write.');
          effect.detail = `Stopped during the write of ${target.name}. Its outcome is UNKNOWN and it will not be resent.`;
          return undefined;
        }
        try {
          await link.writeDocument(proposed.id, target.document, target.name, target.body);
        } catch (err) {
          // Core rechecks the task's audience under lock. A task shared during the write keeps the document out of
          // Core; the working copy this write just changed is put back, so the receipt and the project agree.
          if (!/audience_changed/.test(String(err))) throw err;
          let undone: string;
          try {
            if (result.versions.length === 1) {
              material.withdraw(result.id);
              undone = `the new working copy ${target.name} was withdrawn; its content stays in this project's local history on this device and was never recorded in Core`;
            } else {
              const prior = result.versions.at(-2)!.n;
              const back = await material.save(result.id, Buffer.from(material.bytes(result.id, prior)).toString('utf8'), result.current, 'agent');
              if (!back.ok) throw new Error(back.detail);
              undone = `${target.name} was put back to its content at version ${prior}; the refused version stays in this project's local history on this device and was never recorded in Core`;
            }
          } catch (undo) {
            await link.observe(proposed.id, claim, 'unknown', sha256(`audience-changed-undo:${proposed.id}`), `The task was shared during the write; undoing the working copy failed: ${String(undo)}`);
            effect.detail = `The task was shared during the write of ${target.name}; Core did not record it, and the working copy could not be put back. Its outcome is UNKNOWN.`;
            return undefined;
          }
          await link.observe(proposed.id, claim, 'failed', sha256(`audience-changed:${proposed.id}`), `The task was shared during the write; ${undone}.`);
          effect.outcome = 'REFUSED';
          effect.detail = `The task was shared during the write, so Core did not record it and ${undone}.`;
          return undefined;
        }
        crash('write.recorded');
        await link.observe(proposed.id, claim, 'succeeded', result.versions.at(-1)?.sha256 ?? sha256(target.body), null);
        crash('write.observed');
        effect.outcome = 'DONE';
        markWritten(effect, result, result.versions.find((v) => v.n === result.current)?.sha256 ?? sha256(target.body));
        return result;
        });
      },
    };
}

async function readWrite(options: DocumentGatewayOptions, id: string): Promise<StoredWrite | undefined> {
  const { rows } = await options.link.read<StoredWrite>(options.link.system(),
    "SELECT id, status, args, idempotency_key AS key, run_id AS run, route_reason AS reason FROM app.effects WHERE run_id = $1 AND id = $2 AND operation = 'workspace.write_document'", [options.handle.run, id]);
  return rows[0];
}

async function cancelOriginal(link: CoreLink, id: string): Promise<void> {
  try { await link.call(link.system(), 'SELECT gov.cancel_effect($1, $2)', [id, 'Original proposal cannot continue unchanged.']); }
  catch { /* Only the following durable read can establish what actually happened. */ }
}

/** The host continues saved pre-dispatch work, without invoking a resumed model or native client. */
export async function continueOriginalWrites(options: DocumentGatewayOptions, writes: readonly StoredWrite[]): Promise<void> {
  for (const before of writes) {
    if (!['allowed', 'claimed', 'proposed', 'awaiting_checker'].includes(before.status)) continue;
    await withHomeLock(options.home, async () => {
      const row = await readWrite(options, before.id);
      if (!row || !['allowed', 'claimed', 'proposed', 'awaiting_checker'].includes(row.status)) return;
      const original = await originalWrite(options.home, options.threadId, options.handle.run, options.turnId, options.projectId, row.args.title);
      const target = original?.target;
      const entries = options.material.list(options.projectId, true);
      const current = target && entries.find((entry) => entry.name === target.name);
      const valid = target && row.run === options.handle.run && row.key === `${options.turnId}:${target.name}`
        && row.args.document_id === target.document && row.args.title === target.name
        && row.args.content_sha256 === sha256(target.body) && row.args.base_version === target.baseVersion
        && (current?.current ?? null) === target.baseVersion && (!current || current.id === target.document)
        && !rawPathCollision(options, target) && !(target.baseVersion !== null && options.heldFor?.())
        && target.sourceVersions?.every((source) => entries.some((entry) => entry.id === source.id && entry.name === source.name && entry.current === source.version && !entry.hidden));
      if (!valid || options.signal?.aborted || (target && await options.relatedHold?.(target.document, target.body))) {
        await cancelOriginal(options.link, row.id);
        await readWrite(options, row.id); // A lost/refused cancellation is not invented as success.
        return;
      }
      if (!['allowed', 'claimed'].includes(row.status)) return;
      const effect = { key: row.id, kind: 'write-working-copy' as const, target: target.name, outcome: 'UNKNOWN' as const };
      await createDocumentGateway({ ...options, recoveryOnly: true }).write(target, effect, async () => {
        if (options.signal?.aborted) return 'stopped';
        for (const source of target.sourceVersions ?? []) {
          const current = options.material.load(source.id);
          if (!current || current.projectId !== options.projectId || current.name !== source.name || current.current !== source.version || current.hidden) throw new Error('An original source changed before mutation.');
        }
        const existing = options.material.load(target.document);
        if (target.baseVersion !== null) {
          if (!existing || existing.projectId !== options.projectId || existing.name !== target.name || existing.hidden || existing.current !== target.baseVersion) throw new Error('The original target changed.');
          const saved = await options.material.save(target.document, target.body, target.baseVersion, 'agent');
          if (!saved.ok) throw new Error(saved.detail);
          return saved.value;
        }
        if (existing || options.material.list(options.projectId, true).some((entry) => entry.name === target.name)) throw new Error('The original target identity is no longer absent.');
        return options.material.create(options.projectId, target.name, 'text/markdown', Buffer.from(target.body), 'working', 'agent', target.document, target.managed ? 'managed' : undefined, target.held ?? options.heldFor?.());
      });
    });
  }
}

/** Scope recovery to this original turn, even if another turn exists on the same task. */
export async function turnWrites(link: CoreLink, run: string, turn: string): Promise<StoredWrite[]> {
  const { rows } = await link.read<StoredWrite>(link.system(),
    "SELECT id, status, args, idempotency_key AS key, run_id AS run, route_reason AS reason FROM app.effects WHERE run_id = $1 AND left(idempotency_key, length($2)) = $2 AND operation = 'workspace.write_document' ORDER BY created_at, id", [run, `${turn}:`]);
  return rows;
}

export async function originalTurnRun(link: CoreLink, task: string, turn: string, pendingOnly = false): Promise<string | null> {
  const { rows } = await link.read<{ run: string }>(link.system(),
    `SELECT DISTINCT e.run_id AS run FROM app.effects e JOIN app.runs r ON r.id = e.run_id
     WHERE r.task_id = $1 AND left(e.idempotency_key, length($2)) = $2 AND e.operation = 'workspace.write_document'
     ${pendingOnly ? "AND e.status IN ('proposed', 'awaiting_checker', 'allowed', 'claimed')" : ''}`,
    [task, `${turn}:`]);
  if (rows.length > 1) throw new Error('More than one original run names this turn; no run was substituted.');
  return rows[0]?.run ?? null;
}

/** Old finished runs cannot be resurrected. SQL alone decides whether cancellation is still safe. */
export async function cancelUncontinuableWrites(link: CoreLink, run: string, turn: string): Promise<void> {
  for (const row of await turnWrites(link, run, turn)) {
    if (['proposed', 'awaiting_checker', 'allowed', 'claimed'].includes(row.status)) await cancelOriginal(link, row.id);
  }
  await turnWrites(link, run, turn);
}
