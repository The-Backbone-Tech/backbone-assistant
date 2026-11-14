// A side question is a separate read-only run, not a second writer of the main turn.
// The Host supplies the existing Core gateway and the exact eligible route for this thread.
import { randomUUID } from 'node:crypto';
import type { Receipt, Turn } from '../api.ts';
import type { HarnessV1, ModelRoute } from '../ports/harness.ts';
import type { Gateway } from '../stub/harness.ts';
import { sha256 } from '../stub/fsx.ts';
import type { MaterialStore } from '../stub/material.ts';
import { withHomeLock } from './home-lock.ts';
import { runHarnessTurn } from './harness-turn.ts';
import type { TurnRecall } from './memory.ts';
import type { StoredThread } from './thread-journal.ts';

/** The side run's effective scope, without suggesting Pi and Codex share an isolation mechanism. */
export function sideHarnessLabel(engine: Pick<HarnessV1, 'id' | 'label'>): string {
  const label = engine.id === 'harness-codex' ? engine.label.replace(/ · (?:full|contained|bare|readOnly)$/, '') : engine.label;
  return `${label} · read-only`;
}

export type SidePlan = { engine: HarnessV1; route: ModelRoute };
export type SideRun = { gateway: Gateway; lost?: AbortSignal; finish(status: 'succeeded' | 'failed'): Promise<void>; /** Stop lease renewal without asserting settlement. */ abandon(): Promise<void> };
type SideDeps = {
  home: string;
  policyAdmission?(): void;
  material: MaterialStore;
  thread(id: string): StoredThread | undefined;
  /** Resolve and validate the same route eligibility as a normal turn, before admission. */
  plan(thread: StoredThread): Receipt<SidePlan>;
  /** Persist turn.sideRun with its task, piece, scope and route before queueing; start and renew the
   * distinct Core run under the person's grant. Never share the main turn's controller. A task created
   * before its identity is saved may be left orphaned on a crash, but no run or inference may start. */
  begin(thread: StoredThread, turn: Turn, plan: SidePlan, signal: AbortSignal): Promise<SideRun>;
  /** Verify the saved identity against Core; reclaim only after its lease expires, renew while
   * settling, and finish without inference. Return pending on a live lease, mismatch or revocation. */
  recoverRun?(thread: StoredThread, turn: Turn, identity: NonNullable<Turn['sideRun']>): Promise<'closed' | 'pending'>;
  credential(handle: string): Promise<string>;
  /** Reuse the home's source-bound recall; its proposals are not offered to this read-only turn. */
  recall?(projectId: string, text: string, settings?: import('../api-memory.ts').MemoryTaskSettings): Promise<TurnRecall | undefined>;
  save(thread: StoredThread): Promise<void>;
  closing(): boolean;
};
const no = <T>(reason: 'INVALID' | 'NOT_FOUND' | 'NOT_AVAILABLE', detail: string): Receipt<T> => ({ ok: false, reason, detail, outcome: 'REFUSED' });
const stamp = () => new Date().toISOString();
const keyOk = (key: string) => key.length > 0 && key.length <= 160 && !/[\x00-\x1f\x7f]/.test(key);
const uncertain = (turn: Turn, reason: string) => {
  const partial = turn.answer?.text;
  turn.answer = { text: `${reason}${partial ? `\n\nUnconfirmed response retained for you to inspect:\n\n${partial}` : ''}`, files: [] };
};
const holdWithdrawn = (turn: Turn) => {
  turn.withheld = true; turn.status = 'stopped'; delete turn.completed;
  const notice = 'A source was withdrawn before this side question was fully recorded. Its result is withheld from later work and will not be sent again.';
  const unknown = turn.answer?.text.startsWith('The side question finished, but its run could not be recorded.') || turn.answer?.text.startsWith('The side run could not be fully accounted for.');
  if (!unknown && !turn.answer?.text.startsWith(notice)) uncertain(turn, notice);
};
/** Binds the route without persisting a custom endpoint that might embed credentials. */
export const sideRouteDigest = (route: ModelRoute) => sha256(JSON.stringify([route.kind, route.provider, route.baseUrl, route.model, route.label]));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function validRun(thread: StoredThread, turn: Turn): turn is Turn & { sideRun: NonNullable<Turn['sideRun']> } {
  const value = turn.sideRun;
  return !!value && value.version === 1 && value.threadId === thread.summary.id && value.projectId === thread.summary.projectId
    && value.turnId === turn.id && value.scope === 'read-only' && identifier(value.taskId)
    && identifier(value.pieceId) && (value.queueIntent === undefined || value.queueIntent === true) && (value.runId === undefined || identifier(value.runId))
    && typeof value.routeDigest === 'string' && /^[a-f0-9]{64}$/.test(value.routeDigest);
}
type Active = { turn: Turn; controller: AbortController; done: Promise<void>; settle(): void };

export function createSideChat(deps: SideDeps) {
  const active = new Map<string, Active>();
  const coreSettled = new WeakSet<Turn>();
  const recovering = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();
  const pendingByThread = new Map<string, number>();
  let closed = false;
  const track = (threadId: string) => {
    let done!: () => void;
    const promise = new Promise<void>((resolve) => { done = resolve; });
    pending.add(promise);
    pendingByThread.set(threadId, (pendingByThread.get(threadId) ?? 0) + 1);
    return () => {
      pending.delete(promise);
      const left = (pendingByThread.get(threadId) ?? 1) - 1;
      if (left) pendingByThread.set(threadId, left); else pendingByThread.delete(threadId);
      done();
    };
  };

  /** A recovered in-flight question is never sent again automatically. Call once after home ownership. */
  async function recoverNow(thread: StoredThread) {
    if (closed || deps.closing()) return;
    const admitted = await withHomeLock(deps.home, async () => {
      // A delete may have acquired this lock before recovery registered. Never recreate its thread.
      if (closed || deps.closing() || deps.thread(thread.summary.id) !== thread || active.has(thread.summary.id)) return false;
      let changed = false;
      for (const turn of thread.sideTurns) if (turn.status === 'running') {
        turn.status = 'stopped'; turn.interrupted = true; turn.work.endedAt = stamp();
        uncertain(turn, 'This side question was interrupted. Its answer is unknown and it was not sent again.');
        if (turn.sideRun) turn.sideRecoveryPending = true;
        changed = true;
      }
      if (changed) await deps.save(thread);
      return true;
    });
    if (!admitted) return;
    for (const turn of thread.sideTurns) if (turn.sideRecoveryPending && validRun(thread, turn) && deps.recoverRun) {
      const identity = structuredClone(turn.sideRun);
      let settled = false;
      try { settled = await deps.recoverRun(thread, turn, identity) === 'closed'; } catch { /* keep UNKNOWN and retry later */ }
      if (settled) await withHomeLock(deps.home, async () => {
        if (deps.thread(thread.summary.id) !== thread || JSON.stringify(turn.sideRun) !== JSON.stringify(identity)) return;
        delete turn.sideRecoveryPending;
        await deps.save(thread);
      });
    }
  }

  function recover(thread: StoredThread): Promise<void> {
    if (closed || deps.closing()) return Promise.resolve();
    const id = thread.summary.id;
    const prior = recovering.get(id);
    if (prior) return prior;
    // Register before the first await. Deletion checks this in the home lock; close waits for it.
    const job = Promise.resolve().then(() => recoverNow(thread));
    recovering.set(id, job);
    void job.finally(() => { if (recovering.get(id) === job) recovering.delete(id); }).catch(() => {});
    return job;
  }

  async function execute(thread: StoredThread, plan: SidePlan, turn: Turn, controller: AbortController) {
    const markWithdrawn = () => {
      if (!turn.withheld || !controller.signal.aborted) return;
      holdWithdrawn(turn);
    };
    let run: SideRun | undefined;
    let bound = false;
    const lost = () => controller.abort();
    try {
      if (controller.signal.aborted || closed || deps.closing()) throw new Error('Stopped before the side question started.');
      run = await deps.begin(thread, turn, plan, controller.signal);
      run.lost?.addEventListener('abort', lost, { once: true });
      if (run.lost?.aborted) controller.abort();
      if (!validRun(thread, turn)) throw new Error('A side run lacks its bound durable identity.');
      if (turn.sideRun.routeDigest !== sideRouteDigest(plan.route)) throw new Error('The side run route changed.');
      await deps.save(thread);
      bound = true;
      // Unconfirmed partial side responses remain visible to the person, but must not silently
      // become context for another model call as if they were completed work.
      const history = [...thread.turns.filter((t) => t.status !== 'running'), ...thread.sideTurns.filter((t) => t.id !== turn.id && t.status === 'done' && !t.sideRecoveryPending)];
      const memory = await deps.recall?.(thread.summary.projectId, turn.user.text, turn.user.settings);
      // A second boundary underneath the harness prevents a future change in tool filtering from
      // turning a side question into a write or connector effect. Reads keep the real Core record.
      const readOnlyGateway: Gateway = {
        read: (request) => run!.gateway.read(request),
        write: async (_target, effect) => { effect.outcome = 'REFUSED'; effect.detail = 'Side questions are read-only; nothing was written.'; return undefined; },
      };
      let savedPartial = '';
      let forbiddenTool = false;
      const sideEngine: HarnessV1 = {
        ...plan.engine,
        start(request, context) {
          const started = plan.engine.start(request, context);
          return { ...started, events: (async function* () {
            for await (const event of started.events) {
              // Pi's read-only list contains only these tools. Its beforeToolCall blocks any other
              // name; record an actual attempted crossing, not a guess from the person's words.
              if (event.type === 'tool' && event.phase === 'proposed' && !['list_files', 'read_file'].includes(event.tool)) forbiddenTool = true;
              yield event;
            }
          })() };
        },
      };
      await runHarnessTurn({ policyAdmission: deps.policyAdmission, material: deps.material, projectId: thread.summary.projectId, gateway: readOnlyGateway,
        writeDelayMs: 0, signal: controller.signal, threadId: thread.summary.id, harness: sideEngine, route: plan.route,
        credential: deps.credential, history, resumed: false, readOnly: true, ...(memory ? { memory } : {}),
        notice: 'This side question is read-only. You can inspect the available sources, but cannot change files or take actions. If asked to make a change, say so and direct the person to the main conversation; never claim an action happened.',
        progress: () => {
          if (turn.status === 'running' && turn.answer?.text) savedPartial = turn.answer.text;
          return deps.save(thread);
        } }, turn, []);
      if (turn.status === 'stopped' && savedPartial && !turn.answer?.text.includes(savedPartial)) {
        turn.answer = { text: `${turn.answer?.text ?? 'This side question stopped.'}\n\nUnconfirmed response retained for you to inspect:\n\n${savedPartial}`, files: [] };
      }
      if ((forbiddenTool || turn.status === 'refused') && (turn.status === 'done' || turn.status === 'refused')) {
        const earlier = turn.answer?.text;
        const reason = 'This side question is read-only. The requested action was not performed; ask in the main conversation to make changes.';
        const detail = `${reason}${earlier ? `\n\nUnconfirmed model response retained for you to inspect:\n\n${earlier}` : ''}`;
        turn.status = 'refused'; delete turn.completed;
        turn.refusal = { reason: 'SIDE_CHAT_READ_ONLY', detail };
        turn.answer = { text: detail, files: [] };
      }
      markWithdrawn();
      if (turn.status === 'done') turn.completed = true;
    } catch {
      turn.status = 'stopped';
      uncertain(turn, controller.signal.aborted ? 'This side question was stopped. It was not sent again.' : 'This side question could not finish through its runtime. It was not sent again.');
    } finally {
      run?.lost?.removeEventListener('abort', lost);
      if ((run && !bound) || (!run && turn.sideRun)) {
        // The run's identity was not durably bound. Stop its renewal but never finish a possibly
        // mismatched run; the saved task/intent stays available for an independent reconciliation.
        if (run) await run.abandon().catch(() => {});
        turn.sideRecoveryPending = true; turn.status = 'stopped'; delete turn.completed;
        uncertain(turn, 'The side run could not be fully accounted for. Its outcome is unknown and it was not sent again.');
      }
      markWithdrawn();
      if (run && bound) try { await run.finish(turn.status === 'done' ? 'succeeded' : 'failed'); coreSettled.add(turn); delete turn.sideRecoveryPending; }
      catch {
        if (turn.sideRun) turn.sideRecoveryPending = true;
        turn.status = 'stopped'; delete turn.completed;
        uncertain(turn, 'The side question finished, but its run could not be recorded. Its outcome is unknown and it was not sent again.');
      }
      markWithdrawn();
      turn.work.endedAt = stamp();
      try {
        const heldAtSave = !!turn.withheld && controller.signal.aborted;
        await deps.save(thread);
        // Withdrawal can race the final save after settlement. Persist its stopped/withheld state.
        if (!heldAtSave && turn.withheld && controller.signal.aborted) { markWithdrawn(); await deps.save(thread); }
      }
      catch (error) {
        // The reservation was durable before inference, but this completion was not. A same-process
        // retry must not mistake an in-memory answer for a durable result; a cold retry finds the
        // running reservation and recovery makes the same UNKNOWN decision.
        turn.status = 'stopped'; delete turn.completed;
        uncertain(turn, 'The side question result could not be saved. Its outcome is unknown and it was not sent again.');
        await deps.save(thread).catch(() => {});
        throw error;
      }
    }
  }

  async function ask({ threadId, text, clientKey }: { threadId: string; text: string; clientKey?: string }): Promise<Receipt<Turn>> {
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) return no('INVALID', 'Enter a side question of at most 100,000 characters.');
    if (clientKey !== undefined && (typeof clientKey !== 'string' || !keyOk(clientKey))) return no('INVALID', 'Invalid side question identity.');
    if (closed || deps.closing()) return no('NOT_AVAILABLE', 'This app is closing; the question was not sent.');
    // Old clients remain usable, but only a client that retains its key can safely retry a lost reply.
    const key = clientKey ?? randomUUID();
    let admitted: { thread: StoredThread; plan: SidePlan; job: Active } | undefined;
    const endAdmission = track(threadId);
    let result: Receipt<Turn>;
    try { result = await withHomeLock(deps.home, async (): Promise<Receipt<Turn>> => {
      if (closed || deps.closing()) return no('NOT_AVAILABLE', 'This app is closing; the question was not sent.');
      const thread = deps.thread(threadId);
      if (!thread) return no('NOT_FOUND', 'No such conversation.');
      const prior = [...thread.sideTurns, ...(thread.rewinds ?? []).flatMap(record => record.sideTurns ?? [])].find((t) => t.sideClientKey === key);
      if (prior) return prior.user.text === text ? { ok: true, value: prior } : no('INVALID', 'This side question identity was already used for different words.');
      if (thread.rewindPending) return no('NOT_AVAILABLE', 'Finish the interrupted rewind before asking a side question.');
      if (active.has(threadId) || recovering.has(threadId)) return no('NOT_AVAILABLE', 'A side question is running or being recovered in this conversation.');
      const choice = deps.plan(thread);
      if (!choice.ok) return choice;
      // Pi enforces read-only tool selection. The native read-only path remains unqualified for
      // production admission. Never label a model-free stub as a successful answer.
      if (choice.value.engine.id !== 'harness-pi') return no('NOT_AVAILABLE', 'Side questions require a qualified read-only model runtime; this runtime is not yet supported.');
      const now = stamp();
      const turn: Turn = { id: randomUUID(), side: true, sideClientKey: key, user: { text, attachments: [], settings: thread.turns.at(-1)?.user.settings, at: now }, work: { startedAt: now, steps: [], harness: `${sideHarnessLabel(choice.value.engine)} · ${choice.value.route.label}` }, effects: [], status: 'running' };
      let settle!: () => void;
      const job: Active = { turn, controller: new AbortController(), done: new Promise((r) => { settle = r; }), settle: () => settle() };
      thread.sideTurns.push(turn);
      active.set(threadId, job);
      try { await deps.save(thread); }
      catch (error) { active.delete(threadId); thread.sideTurns.splice(thread.sideTurns.indexOf(turn), 1); job.settle(); throw error; }
      admitted = { thread, plan: choice.value, job };
      return { ok: true, value: turn };
    }); } finally { endAdmission(); }
    if (!admitted) return result;
    const { thread, plan, job } = admitted;
    try { await execute(thread, plan, job.turn, job.controller); }
    finally { if (active.get(threadId) === job) active.delete(threadId); job.settle(); }
    return { ok: true, value: job.turn };
  }

  async function stop({ threadId, turnId }: { threadId: string; turnId: string }): Promise<Receipt<{ stopped: boolean }>> {
    if (closed || deps.closing()) return no('NOT_AVAILABLE', 'This app is closing; the stop was not admitted.');
    const job = active.get(threadId);
    if (!job || job.turn.id !== turnId || job.turn.status !== 'running') return { ok: true, value: { stopped: false } };
    const endStop = track(threadId);
    job.turn.stopRequested = true;
    job.controller.abort();
    try {
      const thread = deps.thread(threadId);
      if (thread) await deps.save(thread);
      return { ok: true, value: { stopped: true } };
    } finally { endStop(); }
  }

  /** Stop only side runs that recorded this source, including inherited context. Bytes already
   * delivered to a runtime or provider cannot be retracted by cancellation. The caller invokes
   * this synchronously after the withdrawal is committed under the home's lock. */
  function sourceWithdrawn(projectId: string, materialId: string) {
    for (const [threadId, job] of active) {
      const thread = deps.thread(threadId);
      if (thread?.summary.projectId !== projectId || !job.turn.reads?.some((read) => read.id === materialId)) continue;
      // A progress save may occur before finish. A stopped snapshot with a bound run must retain
      // its recovery obligation, even if the process dies before settlement.
      if (job.turn.sideRun && !coreSettled.has(job.turn)) job.turn.sideRecoveryPending = true;
      holdWithdrawn(job.turn);
      job.controller.abort();
    }
  }
  function close() { closed = true; for (const job of active.values()) job.controller.abort(); }
  async function whenIdle() {
    while (pending.size || active.size || recovering.size) {
      await Promise.allSettled([...pending, ...[...active.values()].map((job) => job.done), ...recovering.values()]);
    }
  }
  // The Host checks this inside the same home lock as admission before deleting a conversation.
  // Waiting for the job while holding that lock would deadlock its final save.
  function isRunning(threadId: string) { return active.has(threadId) || recovering.has(threadId) || pendingByThread.has(threadId); }
  return { ask, stop, recover, sourceWithdrawn, close, whenIdle, isRunning };
}
