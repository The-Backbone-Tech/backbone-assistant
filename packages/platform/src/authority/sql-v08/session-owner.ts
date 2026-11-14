// The person's session owner: the one place a person's authority is made. It holds the identity
// login (the only role that can mint a person session) and mints only after a presence check the
// person answers outside the renderer and the agent: the app's main process shows its own dialog.
// Routine acts ride one presence for a window; an act that names a statement needs that exact
// statement confirmed, every time. Tokens live in this process's memory and nowhere else.
import { scalar, transaction } from './transport.ts';
import type { AuthenticatedPersonalSession, PersonalInstallation, PersonRequest, SqlPool, TrustedPersonalSessionOwner } from './types.ts';

/** What the person answered. `unavailable`: no way to ask (no window, no display); treated as no. */
export type PresenceAnswer = 'confirmed' | 'declined' | 'unavailable';
/** Asks the person, in a surface neither the renderer nor the agent can draw or answer. */
export interface PresenceCheck {
  /** `person` when a human answers; `fixture` for tests, whose answers are scripted. */
  readonly attests: 'person' | 'fixture';
  /** `signal` aborts when the answer no longer counts (timed out, or end()): close the visible question then. */
  confirm(request: PersonRequest, signal: AbortSignal): Promise<PresenceAnswer>;
}

/** The identity login's mint: a fresh SQL session for the installation's person, or null. */
export function identityMint(pool: SqlPool, binding: PersonalInstallation): () => Promise<string | null> {
  return async () => {
    const minted = await transaction(pool, 'identity', { workspaceId: binding.workspaceId }, (c) =>
      scalar(c, 'SELECT gov.authenticate_person($1::uuid) AS value', [binding.personId]));
    return minted.status === 'committed' && typeof minted.value === 'string' && minted.value ? minted.value : null;
  };
}

/** The kernel's person sessions last 300 seconds from minting; one is reused for less than that. */
export const SESSION_REUSE_MS = 240_000;
/** How long one presence carries routine acts. */
export const PRESENT_FOR_MS = 15 * 60_000;

export interface PresentPersonSessions extends TrustedPersonalSessionOwner {
  /**
   * Forget the presence and the routine session, refuse every act still waiting, and answer any open
   * question with no: the screen locked, the machine slept, the person left. A session already handed
   * to an act stays valid in SQL until its 300 seconds end; the kernel has no call that revokes one.
   */
  end(): void;
}

export function presentPersonSessions(options: {
  binding: PersonalInstallation;
  mint: () => Promise<string | null>;
  presence: PresenceCheck;
  now?: () => number;
  presentForMs?: number;
  /** A mint past this has no answer: the act is refused, never left waiting. */
  mintTimeoutMs?: number;
  /** A question unanswered this long counts as no, so one unanswered dialog cannot hold every later act. */
  presenceTimeoutMs?: number;
}): PresentPersonSessions {
  const now = options.now ?? Date.now;
  const presentForMs = options.presentForMs ?? PRESENT_FOR_MS;
  const binding = Object.freeze({ workspaceId: options.binding.workspaceId, personId: options.binding.personId, accountId: options.binding.accountId });
  let presentAt: number | undefined;
  /** Only routine sessions are reused. A statement's session is handed to its one act and forgotten here. */
  let routine: { token: string; at: number } | undefined;
  let epoch = 0;
  /** Settles every question in flight as no when end() is called. */
  let ended = new AbortController();
  // One question at a time: concurrent acts wait for the answer already being asked.
  let queue: Promise<unknown> = Promise.resolve();
  const required = { status: 'required' as const };

  /** The work's answer, or the fallback once `ms` pass or `signal` aborts. The work's own signal aborts then too. */
  const within = <T>(work: (signal: AbortSignal) => Promise<T>, ms: number, fallback: T, signal: AbortSignal): Promise<T> => {
    const done = new AbortController();
    const stop = () => done.abort();
    const timer = setTimeout(stop, ms);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const late = new Promise<T>((resolve) => done.signal.addEventListener('abort', () => resolve(fallback), { once: true }));
    return Promise.race([Promise.resolve().then(() => work(done.signal)).catch(() => fallback), late]).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      // Settled either way: a question still on screen is closed.
      done.abort();
    });
  };
  const ask = async (request: PersonRequest, signal: AbortSignal): Promise<boolean> =>
    (await within((s) => options.presence.confirm(Object.freeze({ act: request.act, statement: request.statement }), s),
      options.presenceTimeoutMs ?? 5 * 60_000, 'unavailable' as PresenceAnswer, signal)) === 'confirmed';
  const mint = async (signal: AbortSignal): Promise<string | null> => {
    const token = await within(() => options.mint(), options.mintTimeoutMs ?? 10_000, null, signal);
    // An end() while the mint was in flight wins: its token is dropped, never handed out.
    return token && !signal.aborted ? token : null;
  };
  const answer = (token: string): AuthenticatedPersonalSession => ({ status: 'authenticated', ...binding, personToken: token });

  const current = (request: PersonRequest = { act: 'routine' }) => {
    // The epoch is the one this act was asked in: an end() before its turn comes refuses it.
    const queuedIn = epoch; const signal = ended.signal;
    const turn = queue.then(async (): Promise<AuthenticatedPersonalSession | typeof required> => {
      if (queuedIn !== epoch) return required;
      if (request.statement !== undefined) {
        if (typeof request.statement !== 'string' || !request.statement.trim()) return required;
        if (!await ask(request, signal) || signal.aborted) return required;
        presentAt = now();
        // Its own session, minted after this answer and never reused by another act.
        const token = await mint(signal);
        return token ? answer(token) : required;
      }
      if (presentAt === undefined || now() - presentAt >= presentForMs) {
        if (!await ask(request, signal) || signal.aborted) return required;
        presentAt = now();
        routine = undefined;
      }
      if (routine && now() - routine.at < SESSION_REUSE_MS) return answer(routine.token);
      const token = await mint(signal);
      if (!token) return required;
      routine = { token, at: now() };
      return answer(token);
    });
    queue = turn.catch(() => {});
    return turn;
  };

  return Object.freeze({
    attests: options.presence.attests,
    current,
    end: () => { epoch++; presentAt = undefined; routine = undefined; ended.abort(); ended = new AbortController(); },
  });
}
