// A person's inspection is an acknowledgement, never evidence that an action succeeded.
import type { HeldCall, Receipt, Turn, UnknownCheck, UnknownCheckInput, UnknownCheckQuestion } from '../api.ts';
import { IdentityRefused, IdentityUnavailable } from './identity-core.ts';
import { sha256 } from '../stub/fsx.ts';
import { assertHomeWriteAdmission, withHomeLock, inActiveHomeLockScope } from './home-lock.ts';
import { applyEvent, type StoredThread, type ThreadJournal } from './thread-journal.ts';

const refused = <T>(detail: string): Receipt<T> => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail });
const named = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(v);
export function unknownRevision(turn: Turn): string {
  return sha256(JSON.stringify([turn.id, turn.status, turn.unknownOutcome, turn.unknownEvidence, turn.nativeAccountActivity, turn.effects, turn.work]));
}
export const unknownChecked = (turn: Turn): boolean => !!turn.unknownChecked && turn.unknownChecked.revision === unknownRevision(turn);

/** Connector custody and document writes keep their verification route. A mixed turn can
 * acknowledge only its unattributed part, after every named effect has reconciled. */
export function checkQuestion(threadId: string, turn: Turn, held: readonly Pick<HeldCall, 'threadId' | 'turnId' | 'state' | 'effect'>[], reconciled: readonly string[] = []): UnknownCheckQuestion | undefined {
  const effects = turn.unknownEvidence?.connectorEffects ?? [];
  if (!Array.isArray(effects) || effects.some(id => typeof id !== 'string' || !id)) return;
  if (turn.status === 'running' || turn.side || (!turn.unknownOutcome && !(turn.nativeAccountActivity && turn.status !== 'done'))
    || turn.effects.some(e => e.outcome === 'UNKNOWN')
    || (effects.length && (!turn.unknownEvidence?.other || effects.some(id => !reconciled.includes(id))))
    || held.some(h => h.threadId === threadId && h.turnId === turn.id && (h.state === 'unknown' || h.state === 'waiting') && !reconciled.includes(h.effect))) return;
  const steps = turn.work.steps.map(s => ({ label: s.label, at: s.at ?? turn.work.startedAt }));
  return { revision: unknownRevision(turn), steps: steps.length ? steps : [{ label: 'Unattributed action; no server or tool was recorded.', at: turn.work.startedAt || turn.user.at }] };
}

export function createUnknownChecks(deps: {
  admit<T>(threadId: string, work: () => Promise<T>): Promise<T>;
  home: string; threads: Map<string, StoredThread>; journal: ThreadJournal;
  ready(): Promise<{ person: string; name?: string }>; unavailable(): boolean; held(): readonly HeldCall[];
  reconciled(threadId: string, turnId: string, effect: string): Promise<boolean>;
  enter(checking: boolean): () => void;
  save(thread: StoredThread): Promise<void>; checked(thread: StoredThread): void;
  /** Crash observation immediately after the canonical audit event has been flushed. */
  recorded?(): void;
}) {
  const pending = new Set<Promise<unknown>>();
  function tracked<T>(checking: boolean, work: () => Promise<T>): Promise<T> {
    const leave = deps.enter(checking);
    const promise = work(); pending.add(promise);
    void promise.finally(() => { pending.delete(promise); leave(); }).catch(() => {});
    return promise;
  }
  async function inspect(input: { threadId: string; turnId: string }): Promise<Receipt<{ question: UnknownCheckQuestion; reconciled: string[] }>> {
    if (!named(input?.threadId) || !named(input?.turnId)) return refused('Choose the exact conversation and turn.');
    const outerLock = inActiveHomeLockScope(deps.home);
    const snapshot = await withHomeLock(deps.home, async () => {
      const thread = deps.threads.get(input.threadId), turn = thread?.turns.find(t => t.id === input.turnId);
      return turn && !thread?.summary.running && !thread?.rewindPending ? structuredClone(turn) : undefined;
    });
    if (!snapshot) return refused('The uncertain turn is still running or unavailable.');
    const effects = snapshot.unknownEvidence?.connectorEffects ?? [];
    if (!Array.isArray(effects) || effects.some(id => typeof id !== 'string' || !id)) return refused('This turn needs its existing recovery controls.');
    if (effects.length && outerLock) return refused('Inspect this connector outcome outside a pending home write.');
    const reconciled: string[] = [];
    // Core crossings run outside the home lock. No provider action is performed or repeated.
    for (const effect of new Set(effects)) {
      if (!await deps.reconciled(input.threadId, input.turnId, effect).catch(() => false)) return refused('Reconcile the connector effect before checking other uncertainty.');
      reconciled.push(effect);
    }
    return withHomeLock(deps.home, async () => {
      const thread = deps.threads.get(input.threadId), turn = thread?.turns.find(t => t.id === input.turnId);
      const q = turn && !thread?.summary.running && !thread?.rewindPending && unknownRevision(snapshot) === unknownRevision(turn) && checkQuestion(input.threadId, turn, deps.held(), reconciled);
      return q ? { ok: true, value: { question: q, reconciled } } : refused('This outcome has a verification path, changed or is still running. Use its existing recovery controls.');
    });
  }
  async function admitted<T>(threadId: string, work: () => Promise<Receipt<T>>): Promise<Receipt<T>> {
    if (deps.unavailable()) return refused('Checking is available only to the owner in a writable local app.');
    try { return await deps.admit(threadId, work); }
    catch (error) {
      if (error instanceof IdentityRefused || error instanceof IdentityUnavailable) return refused('Only the conversation owner on this device may check it.');
      throw error;
    }
  }
  return {
    question: (input: { threadId: string; turnId: string }, signal?: AbortSignal): Promise<Receipt<UnknownCheckQuestion>> => tracked(false, () => admitted<UnknownCheckQuestion>(input?.threadId, async () => {
      if (deps.unavailable() || signal?.aborted) return refused('Checking is available only to the owner in a writable local app.');
      await deps.ready();
      const result = await inspect(input);
      if (deps.unavailable() || signal?.aborted) return refused('Checking is unavailable in this session.');
      return result.ok ? { ok: true, value: result.value.question } : result;
    })),
    check: (input: UnknownCheckInput, signal?: AbortSignal): Promise<Receipt<UnknownCheck>> => tracked(true, () => admitted<UnknownCheck>(input?.threadId, async () => {
      if (deps.unavailable() || signal?.aborted) return refused('Checking is available only to the owner in a writable local app.');
      const identity = await deps.ready();
      const inspected = await inspect(input);
      if (!inspected.ok) return inspected;
      return withHomeLock(deps.home, async () => {
        if (deps.unavailable() || signal?.aborted || !named(input?.threadId) || !named(input?.turnId)) return refused('Choose the exact conversation and turn in the local app.');
        const thread = deps.threads.get(input.threadId), turn = thread?.turns.find(t => t.id === input.turnId);
        const q = turn && !thread?.summary.running && !thread?.rewindPending && checkQuestion(input.threadId, turn, deps.held(), inspected.value.reconciled);
        if (!q || q.revision !== inspected.value.question.revision || q.revision !== input.revision) return refused('The uncertain step changed or has a verification path. Inspect it again.');
        if (unknownChecked(turn!)) return { ok: true, value: turn!.unknownChecked! };
        const check: UnknownCheck = { ...q, by: identity.person, ...(identity.name ? { byName: identity.name } : {}), at: new Date().toISOString() };
        // This append-only, fsynced event is the local audit log and owns the turn projection.
        // A crash before saving the cache replays the same acknowledgement, never a provider call.
        assertHomeWriteAdmission(deps.home);
        applyEvent(deps.threads, deps.journal.append({ kind: 'turn.unknown.checked', threadId: input.threadId, turnId: input.turnId, check }));
        deps.recorded?.();
        await deps.save(thread!);
        deps.checked(thread!);
        return { ok: true, value: check };
      });
    })),
    async whenIdle() { while (pending.size) await Promise.allSettled([...pending]); },
  };
}

/** Read-only offer projection; acceptance rechecks exact witnesses outside the home lock. */
export function projectUnknownChecks(t: StoredThread, held: readonly HeldCall[], available: boolean, recoveryFor: (turn: Turn) => Turn['recovery']): Turn[] {
    // Local receipts suffice for an offer, never for accepting a check. The person path
    // re-verifies each exact Core witness outside the lock before recording anything.
    const reconciled = held.filter(h => h.resolution?.state === 'recorded' && !!h.resolution.ledger
      && ['happened', 'did_not_happen'].includes(h.resolution.answer));
    return t.turns.map(turn => {
      const recovery = recoveryFor(turn);
      const current = unknownChecked(turn);
      const unknownCheck = available && !t.summary.running && !t.rewindPending && !current
        ? checkQuestion(t.summary.id, turn, held, reconciled.filter(h => h.threadId === t.summary.id && h.turnId === turn.id).map(h => h.effect)) : undefined;
      return { ...turn, ...(recovery ? { recovery } : {}), unknownCheck, ...(turn.unknownChecked ? { unknownCheckedCurrent: current } : {}) };
    });
}
