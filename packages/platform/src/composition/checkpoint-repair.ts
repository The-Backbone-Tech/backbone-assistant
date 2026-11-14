// Explicit person action, never a harness tool or automatic recovery shortcut. File revisions
// bind the selected data, not authority. Fresh handles may only close this conversation's own
// worker runs; no producer, new run, effect or grant is created. Unresolved receipts stay pending.
import { type Stats, constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Args, FileLink, Receipt, Turn } from '../api.ts';
import type { MaterialStore } from '../stub/material.ts';
import { sha256 } from '../stub/fsx.ts';
import type { CoreLink } from './core.ts';
import type { StoredThread } from './thread-journal.ts';
import { withHomeLock } from './home-lock.ts';
import { cancelUncontinuableWrites, originalTurnRun } from './document-writes.ts';
import { releaseRecoveryBookkeeping } from './thread-custody.ts';
import type { CheckpointStore } from './checkpoint-recovery.ts';

// An in-memory inspection limit, not a storage format. Larger files are left untouched for
// the operator's offline recovery; no truncation, lossy decoding or partial metadata reset.
const MAX_INSPECTION_BYTES = 16 * 1024 * 1024;
function checkpointPath(home: string, turn: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(turn)) throw new Error('Invalid recovery identity.');
  const dir = join(home, 'checkpoints');
  const parent = lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Recovery data is not in its own plain directory.');
  return join(dir, `${turn}.json`);
}
function versionOf(stat: Stats) {
  return sha256(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
}
export function checkpointRepairNotice(home: string, turn: string): Turn['recovery'] {
  try {
    const stat = lstatSync(checkpointPath(home, turn));
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_INSPECTION_BYTES) return undefined;
    return { revision: versionOf(stat), detail: 'Cancel unsent document writes, keep the recovery data as inspection copies and end this conversation’s pending work. Nothing will be retried.' };
  } catch { return undefined; }
}
function readCheckpointData(home: string, turn: string) {
  const path = checkpointPath(home, turn), before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Recovery data is not a private plain file.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_INSPECTION_BYTES) throw new Error('Recovery data needs offline inspection; it was left untouched.');
    return { revision: versionOf(stat), bytes: readFileSync(fd) };
  } finally { closeSync(fd); }
}
function keepBytes(material: MaterialStore, thread: StoredThread, turn: Turn, role: string, bytes: Buffer): FileLink {
  if (bytes.length > MAX_INSPECTION_BYTES) throw new Error('Recovery data is too large for in-app inspection; it was left untouched.');
  const digest = createHash('sha256').update(JSON.stringify(['person-recovery-v1', role, thread.summary.id, turn.id, sha256(bytes)])).digest('hex');
  const id = digest.replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, '$1-$2-4$3-8$4-$5');
  let entry = material.load(id);
  if (entry) {
    if (entry.projectId !== thread.summary.projectId || entry.recovery?.turnId !== turn.id || !Buffer.from(material.bytes(id, 1)).equals(bytes)) throw new Error('A recovery-copy identity is occupied; nothing was replaced.');
  } else {
    const text = Buffer.from(bytes.toString('utf8')).equals(bytes);
    const name = material.freeName(thread.summary.projectId, `${role === 'checkpoint' ? 'Recovery checkpoint' : 'Recovery bookkeeping'} (${turn.id.slice(0, 8)}).${text ? 'txt' : 'bin'}`);
    entry = material.create(thread.summary.projectId, name, text ? 'text/plain' : 'application/octet-stream', bytes, 'working', 'agent', id, 'managed',
      { id: turn.id, name: 'Recovery data kept by the person' }, undefined,
      { turnId: turn.id, reason: 'The person kept unimported recovery data for inspection, not as an authorised output.' });
  }
  return { materialId: id, name: entry.name, version: 1 };
}
interface RepairDeps {
  home: string; core(): Promise<CoreLink>; material: MaterialStore;
  thread(id: string): StoredThread | undefined;
  running: Map<string, AbortController>;
  registerCarrier(controller: AbortController, turn: Turn): void;
  busy(thread: StoredThread): boolean;
  store(turn: string): CheckpointStore;
  closed(thread: StoredThread, turn: Turn): Promise<void>;
  save(thread: StoredThread): Promise<void>;
  changed(projectId: string): void;
}
const refused = (reason: 'INVALID' | 'NOT_FOUND' | 'NOT_AVAILABLE' | 'STALE_BASE', detail: string) => ({ ok: false as const, reason, outcome: 'REFUSED' as const, detail });

export function createRecoveryRepair(deps: RepairDeps) {
  return async ({ threadId, turnId, revision }: Args<'turns.keepRecovery'>): Promise<Receipt<{ files: FileLink[]; cleared: boolean; detail: string }>> => {
    const link = await deps.core();
    const prepared = await withHomeLock(deps.home, async () => {
      const thread = deps.thread(threadId), turn = thread?.turns.find(turn => turn.id === turnId);
      if (!thread || !turn) return refused('NOT_FOUND', 'No such conversation or turn.');
      if (thread.summary.running || deps.running.has(threadId) || deps.busy(thread)) return refused('NOT_AVAILABLE', 'Stop this conversation and its linked work before keeping its recovery data.');
      if (!thread.task) return refused('NOT_AVAILABLE', 'The conversation has no recoverable task identity; its data was left untouched.');
      let snapshot: ReturnType<typeof readCheckpointData>;
      try { snapshot = readCheckpointData(deps.home, turnId); }
      catch { return refused('NOT_AVAILABLE', 'This recovery file cannot be copied safely in the app. It was left untouched for offline inspection.'); }
      if (snapshot.revision !== revision) return refused('STALE_BASE', 'Recovery data changed since you saw it. Review it again; nothing changed.');
      const controller = new AbortController();
      deps.running.set(threadId, controller); thread.summary.running = true;
      deps.registerCarrier(controller, turn);
      return { thread, turn, snapshot, controller };
    });
    if ('ok' in prepared) return prepared;
    const { thread, turn, snapshot, controller } = prepared;
    const files: FileLink[] = [];
    const unchanged = () => {
      const current = readCheckpointData(deps.home, turnId);
      if (controller.signal.aborted || current.revision !== snapshot.revision || !current.bytes.equals(snapshot.bytes)) throw new Error('The selected recovery data changed or this action was stopped.');
    };
    try {
      await deps.save(thread); // Notify other consumers while the repair owns its busy reservation.
      files.push(await withHomeLock(deps.home, async () => { unchanged(); return keepBytes(deps.material, thread, turn, 'checkpoint', snapshot.bytes); }));
      // This is the existing task, not a guessed replacement. Core facts supply piece and agent;
      // the holder secret is used only to finish failed, never passed to an engine or effect.
      const { rows: open } = await link.read<{ id: string; piece: string | null; agent: string }>(link.system(),
        "SELECT id, piece_id AS piece, agent_id AS agent FROM app.runs WHERE task_id = $1 AND status IN ('queued', 'running', 'waiting')", [thread.task]);
      if (open.some(run => run.agent !== link.id.agent)) throw new Error('Another worker owns pending work in this conversation.');
      for (const run of open) {
        if (controller.signal.aborted) throw new Error('Stopped.');
        try {
          const handle = await link.reclaimRun(run.id, run.piece); unchanged();
          await cancelUncontinuableWrites(link, run.id, turn.id); unchanged();
          await link.finishRun(handle, 'failed');
        }
        catch {
          const { rows } = await link.read<{ status: string }>(link.system(), 'SELECT status FROM app.runs WHERE id = $1 AND task_id = $2', [run.id, thread.task]);
          if (rows.length !== 1 || !['succeeded', 'failed', 'cancelled'].includes(rows[0].status)) throw new Error('The original work could not be closed.');
        }
      }
      // An earlier closure can leave this turn's unsent receipt behind. Its actual task and
      // worker still have to agree; cancellation never uses the checkpoint as authority.
      const recorded = await originalTurnRun(link, thread.task!, turn.id);
      if (recorded && !open.some(run => run.id === recorded)) {
        const { rows } = await link.read<{ agent: string; status: string }>(link.system(), 'SELECT agent_id AS agent, status FROM app.runs WHERE id = $1 AND task_id = $2', [recorded, thread.task]);
        if (rows.length !== 1 || rows[0].agent !== link.id.agent || !['succeeded', 'failed', 'cancelled'].includes(rows[0].status)) throw new Error('The original receipt has no confirmed closed owner.');
        unchanged(); await cancelUncontinuableWrites(link, recorded, turn.id);
      }
      if (controller.signal.aborted) throw new Error('This recovery action was stopped; its data is retained.');
      const released = await releaseRecoveryBookkeeping({ home: deps.home, thread: threadId, project: thread.summary.projectId, task: thread.task! }, link,
        unchanged, value => {
          const file = keepBytes(deps.material, thread, turn, 'custody', Buffer.from(JSON.stringify(value, null, 2)));
          files.push(file); return file;
        });
      if (!released) return { ok: true, value: { files, cleared: false, detail: 'Recovery data was kept. Original recovery state still needs review; its checkpoint and receipts remain. Nothing was resent.' } };
      turn.status = 'stopped';
      turn.refusal = { reason: 'NOT_AVAILABLE', detail: 'This earlier work was not resumed. Its recovery data was kept for inspection.' };
      const kept = new Map((turn.answer?.files ?? []).map(file => [`${file.materialId}:${file.version}`, file]));
      for (const file of files) kept.set(`${file.materialId}:${file.version}`, file);
      turn.answer = { text: 'The person kept this recovery data for inspection. It is not an authorised output. No old request was retried.', files: [...kept.values()] };
      await deps.closed(thread, turn);
      await withHomeLock(deps.home, async () => { unchanged(); await deps.store(turnId).clear(); });
      return { ok: true, value: { files, cleared: true, detail: 'Recovery data kept for inspection. This conversation can continue; nothing was retried.' } };
    } catch {
      return files.length ? { ok: true, value: { files, cleared: false, detail: 'The data was kept, but its original work could not be closed safely. The checkpoint and receipts remain for review.' } }
        : refused('NOT_AVAILABLE', 'Recovery data could not be kept safely. It was left untouched.');
    } finally {
      if (deps.running.get(threadId) === controller) deps.running.delete(threadId);
      thread.summary.running = false;
      try { await deps.save(thread); } finally { if (files.length) deps.changed(thread.summary.projectId); }
    }
  };
}
