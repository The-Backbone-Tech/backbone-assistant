// Core custody for the independent read-only side run. A task identity is saved before a run is
// queued. Recovery may only settle that task's exact piece-bound run, and never calls a model.
// If queueIntent is durable but no run is visible, this Core has no keyed queue receipt that proves
// the request did not commit later. Keep recovery pending: an operator can inspect all runs for the
// bound task and settle an exact match, but an empty query alone is not proof and must not cause a
// resend. A crash after task creation but before the identity save can leave an empty task; no run
// or inference has been started in that window, and the unbound task is not deleted automatically.
import type { Turn } from '../api.ts';
import { sha256 } from '../stub/fsx.ts';
import type { Gateway } from '../stub/harness.ts';
import type { CoreLink, RunHandle } from './core.ts';
import { sideRouteDigest, type SidePlan, type SideRun } from './sidechat.ts';
import type { StoredThread } from './thread-journal.ts';

type Identity = NonNullable<Turn['sideRun']>;
type SideCoreDeps = {
  link(): Promise<CoreLink>;
  /** Current checked and granted engine registration, never an engine-supplied id. */
  piece(): string | null;
  save(thread: StoredThread): Promise<void>;
  gateway(link: CoreLink, handle: RunHandle, threadId: string, turnId: string, projectId: string, signal: AbortSignal): Gateway;
  /** True only after the new host owns the home and the old owner cannot still admit work. */
  ownsHome(): boolean;
  closing(): boolean;
};
const LEASE_RENEW_MS = 2_000;
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const titleOf = (i: Omit<Identity, 'taskId' | 'runId' | 'queueIntent'>) => `Side question v1 ${sha256(JSON.stringify([i.version, i.threadId, i.projectId, i.turnId, i.pieceId, i.scope, i.routeDigest]))}`;
const same = (thread: StoredThread, turn: Turn, identity: Identity) => thread.summary.id === identity.threadId && thread.summary.projectId === identity.projectId
  && turn.id === identity.turnId && turn.side && identity.version === 1 && identity.scope === 'read-only'
  && !!identity.pieceId && JSON.stringify(turn.sideRun) === JSON.stringify(identity);

/** The timer only keeps the Core lease; loss aborts the side model and never widens authority. */
function lease(link: CoreLink, handle: RunHandle) {
  const lost = new AbortController();
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    if (lost.signal.aborted) return;
    renewal = renewal.then(async () => { await link.renewRun(handle); }).catch(() => { lost.abort(); });
  }, LEASE_RENEW_MS);
  timer.unref();
  return {
    signal: lost.signal,
    async check() { await renewal; if (lost.signal.aborted) throw new Error('The side run lease was lost.'); },
    async stop() { clearInterval(timer); await renewal; if (lost.signal.aborted) throw new Error('The side run lease was lost.'); },
  };
}

export function createSideCore(deps: SideCoreDeps) {
  async function begin(thread: StoredThread, turn: Turn, plan: SidePlan, signal: AbortSignal): Promise<SideRun> {
    if (!deps.ownsHome() || deps.closing() || signal.aborted) throw new Error('The side run was stopped before admission.');
    const pieceId = deps.piece();
    if (!pieceId) throw new Error('The side runtime has no granted registration.');
    const link = await deps.link();
    if (!deps.ownsHome() || deps.closing() || signal.aborted) throw new Error('The side run was stopped before admission.');
    const bound = { version: 1 as const, threadId: thread.summary.id, projectId: thread.summary.projectId, turnId: turn.id,
      pieceId, scope: 'read-only' as const, routeDigest: sideRouteDigest(plan.route) };
    // A process killed between createTask and this save may leave an empty task. It has no queued
    // run and is not deleted without its identity; no model request has been sent.
    const taskId = await link.createTask(titleOf(bound),bound.projectId);
    turn.sideRun = { ...bound, taskId };
    await deps.save(thread);
    if (!deps.ownsHome() || deps.closing() || signal.aborted) throw new Error('The side run was stopped before it was queued.');
    await link.say(taskId, turn.user.text);
    if (!deps.ownsHome() || deps.closing() || signal.aborted) throw new Error('The side run was stopped before it was queued.');
    if (!await link.pieceMandate(pieceId)) throw new Error('The side runtime is not granted.');
    // A lost queue acknowledgement is not proof that no run exists. The intent precedes the call;
    // a recovery finding no run must leave it UNKNOWN rather than race a late database commit.
    turn.sideRun.queueIntent = true;
    await deps.save(thread);
    if (!deps.ownsHome() || deps.closing() || signal.aborted) {
      delete turn.sideRun.queueIntent;
      await deps.save(thread);
      throw new Error('The side run was stopped before it was queued.');
    }
    const handle = await link.startRun(taskId, pieceId);
    const held = lease(link, handle);
    try {
      turn.sideRun.runId = handle.run;
      await deps.save(thread);
    } catch (error) {
      // An acknowledgement can be lost; the already-saved task identity lets recovery inspect Core.
      await held.stop().catch(() => {});
      await link.finishRun(handle, 'failed').catch(() => {});
      throw error;
    }
    let gateway: Gateway;
    try { gateway = deps.gateway(link, handle, thread.summary.id, turn.id, thread.summary.projectId, signal); }
    catch (error) {
      // A failed bridge must not leave an unobserved timer renewing an unreachable run forever.
      await held.stop().catch(() => {});
      await link.finishRun(handle, 'failed').catch(() => {});
      throw error;
    }
    return {
      gateway,
      lost: held.signal,
      async abandon() { await held.stop(); },
      async finish(status) {
        try {
          await held.check();
          // A withdrawn source may remain visible to the person but must not be copied into Core.
          if (status === 'succeeded' && !turn.withheld && turn.answer?.text) await link.answer(handle, taskId, turn.answer.text);
          await held.check();
          await link.finishRun(handle, status);
        } finally { await held.stop(); }
      },
    };
  }

  async function recoverRun(thread: StoredThread, turn: Turn, given: Identity): Promise<'closed' | 'pending'> {
    const identity = structuredClone(given);
    const intact = () => same(thread, turn, identity) && deps.ownsHome() && !deps.closing();
    if (!intact()) return 'pending';
    const link = await deps.link();
    if (!intact()) return 'pending';
    const task = await link.read<{ id: string; title: string; requested_by: string; on_behalf_of: string }>(link.system(),
      'SELECT id, title, requested_by, on_behalf_of FROM app.tasks WHERE id = $1', [identity.taskId]);
    if (!intact() || task.rows.length !== 1 || task.rows[0].title !== titleOf(identity)
      || task.rows[0].requested_by !== link.id.person || task.rows[0].on_behalf_of !== link.id.person) return 'pending';
    const result = await link.read<{ id: string; task_id: string; piece_id: string | null; agent_id: string; status: string }>(link.system(),
      'SELECT id, task_id, piece_id, agent_id, status FROM app.runs WHERE task_id = $1', [identity.taskId]);
    if (!intact() || result.rows.length > 1) return 'pending';
    const row = result.rows[0];
    if (!row) return identity.runId || identity.queueIntent ? 'pending' : 'closed';
    if (row.task_id !== identity.taskId || row.piece_id !== identity.pieceId || row.agent_id !== link.id.agent
      || (identity.runId && row.id !== identity.runId)) return 'pending';
    if (terminal.has(row.status)) return 'closed';
    if (!['queued', 'running', 'waiting'].includes(row.status)) return 'pending';
    let handle: RunHandle;
    try { handle = await link.reclaimRun(row.id, identity.pieceId); } catch { return 'pending'; }
    if (!intact()) return 'pending';
    const held = lease(link, handle);
    try {
      await link.renewRun(handle);
      if (!intact() || held.signal.aborted) return 'pending';
      await link.finishRun(handle, 'failed');
      const settled = await link.read<{ status: string; piece_id: string | null; task_id: string }>(link.system(),
        'SELECT status, piece_id, task_id FROM app.runs WHERE id = $1', [row.id]);
      return intact() && settled.rows.length === 1 && settled.rows[0].status === 'failed'
        && settled.rows[0].piece_id === identity.pieceId && settled.rows[0].task_id === identity.taskId ? 'closed' : 'pending';
    } catch { return 'pending'; }
    finally { await held.stop().catch(() => {}); }
  }
  return { begin, recoverRun };
}
