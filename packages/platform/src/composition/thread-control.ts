import type { Args, Receipt, Thread, Turn } from '../api.ts';
import type { ThreadRestartReceipt, ThreadRestartRequest } from '../api-thread-control.ts';

interface ThreadControlDeps {
  get(args: Args<'threads.get'>): Promise<Receipt<Thread>>;
  stop(args: Args<'turns.stop'>): Promise<Receipt<{ stopped: boolean }>>;
  send(args: Args<'turns.send'>): Promise<ThreadRestartReceipt>;
  /** Join the original worker outside the home lock, including its pending writes. */
  settled(threadId: string): Promise<void>;
  /** Native effects without a receipt cannot be declared safe by a missing Host record. */
  canRestart(turn: Turn): true | string;
  unresolved?(threadId: string, turn: Turn): Promise<boolean>;
}
const refused = (detail: string, reason: 'NOT_AVAILABLE' | 'STALE_BASE' = 'NOT_AVAILABLE'): ThreadRestartReceipt => ({ ok: false, reason, detail, outcome: 'REFUSED' });
const continuation = 'Continue this conversation from its recorded progress. Inspect completed work before doing more. Do not repeat any action whose outcome is unknown.';

/** Restart is a new continuation through the ordinary admission path, never replay of an old write. */
export function createThreadControl(deps: ThreadControlDeps, settleTimeoutMs = 30_000) {
  const attempts = new Map<string, Promise<ThreadRestartReceipt>>();
  const safetySnapshot = (value: Thread) => JSON.stringify([value.summary.running, value.summary.recoveryHold, value.turns.map(turn => [turn.id, turn.status, turn.unknownOutcome, turn.unknownEvidence, turn.unknownChecked, turn.nativeAccountActivity, turn.effects, turn.work.harness]), value.children]);
  async function holdReason(thread: Thread, checkedChildren: [string, string][] = []): Promise<string | undefined> {
    const unresolved = async (id: string, turn: Turn) => deps.unresolved ? await deps.unresolved(id, turn).catch(() => true) : !!turn.unknownOutcome;
    const mainUnknown = await Promise.all(thread.turns.map(turn => unresolved(thread.summary.id, turn)));
    if (thread.summary.recoveryHold || thread.turns.some((turn, i) => turn.effects.some(effect => effect.outcome === 'UNKNOWN') || mainUnknown[i])
      || thread.children?.some(child => child.running || child.handover?.receipts.some(receipt => receipt.outcome === 'UNKNOWN'))) {
      return 'Saved work or an unknown outcome needs inspection. Nothing was resent.';
    }
    // A child view contains document receipts, not all connector/native outcomes.
    // Read each child's full record rather than treating absent document receipts as safety.
    for (const child of thread.children ?? []) {
      const result = await deps.get({ id: child.threadId });
      const childSnapshot = result.ok ? safetySnapshot(result.value) : '';
      const childUnknown = result.ok ? await Promise.all(result.value.turns.map(turn => unresolved(child.threadId, turn))) : [];
      if (!result.ok || result.value.summary.running || result.value.summary.recoveryHold
        || result.value.turns.some((turn, i) => turn.status === 'running' || childUnknown[i] || turn.effects.some(effect => effect.outcome === 'UNKNOWN') || (turn.status !== 'done' && deps.canRestart(turn) !== true))) {
        return 'A worker has unresolved work or an unknown outcome. Nothing was resent.';
      }
      checkedChildren.push([child.threadId, childSnapshot]);
    }
  }
  async function perform({ threadId, turnId }: ThreadRestartRequest, before: Thread, generation: string): Promise<ThreadRestartReceipt> {
    const admitted = before.turns.find(turn => turn.restartOf === turnId);
    if (admitted) return { ok: true, value: { threadId, turnId: admitted.id } };
    const target = before.turns.at(-1);
    if (!target || target.id !== turnId) return refused('The conversation moved on. Reload it before restarting.', 'STALE_BASE');
    const allowed = deps.canRestart(target);
    if (allowed !== true) return refused(allowed);
    if (target.status === 'done' || target.status === 'refused') return refused('This turn already finished. Send a new message to continue.');
    if ((before.goalRun && before.goalRun.status !== 'met') || !target.user.settings || target.merge || target.judge) return refused('Restart an ordinary conversation turn. Goal runs have their own Resume control.');
    // Refusing an already ended turn must not pause unrelated queued or pooled work.
    if (target.status !== 'running') {
      const hold = await holdReason(before);
      if (hold) return refused(hold);
    }
    // Stop holds the existing queue and goal/worker activity before the carrier is joined.
    // Even an already stopped thread uses Stop so a waiting message cannot race continuation.
    const stopped = await deps.stop({ threadId, turnId });
    if (!stopped.ok) return stopped;
    let timer: NodeJS.Timeout | undefined;
    try {
      const joined = await Promise.race([deps.settled(threadId).then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), settleTimeoutMs); })]);
      if (!joined) return refused('The previous worker has not stopped. No second worker was started. Reopen the app to recover its recorded work.');
    } finally { clearTimeout(timer); }
    const current = await deps.get({ id: threadId });
    if (!current.ok) return current;
    const thread = current.value;
    if ((thread.rewinds?.at(-1)?.id ?? '') !== generation) return refused('The conversation was rewound while stopping. Reload it before restarting.', 'STALE_BASE');
    if (thread.turns.at(-1)?.id !== turnId) return refused('The conversation moved on while stopping. Nothing else was started.', 'STALE_BASE');
    if (thread.summary.running || thread.turns.some(turn => turn.status === 'running')) return refused('The previous worker has not stopped. No second worker was started.');
    const allowedAfterStop = deps.canRestart(thread.turns.at(-1)!);
    if (allowedAfterStop !== true) return refused(allowedAfterStop);
    const mainSnapshot = safetySnapshot(thread);
    const checkedChildren: [string, string][] = [];
    const hold = await holdReason(thread, checkedChildren);
    if (hold) return refused(hold);
    const latest = await deps.get({ id: threadId });
    if (!latest.ok || safetySnapshot(latest.value) !== mainSnapshot) return refused('The conversation changed while its receipts were checked. Reload it before restarting.', 'STALE_BASE');
    for (const [id, snapshot] of checkedChildren) {
      const latestChild = await deps.get({ id });
      if (!latestChild.ok || safetySnapshot(latestChild.value) !== snapshot) return refused('A worker changed while its receipts were checked. Nothing was resent.');
    }
    return deps.send({ threadId, afterTurnId: turnId, projectId: thread.summary.projectId, text: continuation, attachments: [], settings: target.user.settings,
      clientKey: `thread-restart:${threadId}:${turnId}${generation ? `:${generation}` : ''}` });
  }
  return {
    async restart(args: ThreadRestartRequest): Promise<ThreadRestartReceipt> {
      if (!args.threadId || !args.turnId) return Promise.resolve(refused('Choose the conversation and exact turn to restart.'));
      const initial = await deps.get({ id: args.threadId });
      if (!initial.ok) return initial;
      // Archived continuations keep their custody; a new branch gets its own admission.
      const generation = initial.value.rewinds?.at(-1)?.id ?? '';
      const key = JSON.stringify([args.threadId, args.turnId, generation]);
      const prior = attempts.get(key);
      if (prior) return prior;
      const attempt = perform(args, initial.value, generation);
      attempts.set(key, attempt);
      // A refusal has admitted nothing. Transient failures may be retried after inspection;
      // a successful or response-lost send retains the same deterministic admission identity.
      void attempt.then(result => { if (!result.ok) attempts.delete(key); }, () => attempts.delete(key));
      return attempt;
    },
  };
}
