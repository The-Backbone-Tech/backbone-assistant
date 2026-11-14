/**
 * The target adapter: the only surface the core oracle touches. A target is a whole Backbone
 * installation (the legacy repository today, the successor later). Cases name crossings and views
 * by the oracle's vocabulary below; each adapter binds that vocabulary to its own schema.
 *
 * The four verbs are the ones the plan names: `setWorkspace`, `asPrincipal`, `call` and `observe`.
 * Three more exist because some promises cannot be stated without them, and each is reported
 * separately so the black-box share stays honest:
 * - `operator` — installation-level acts no service session may perform (creating a workspace
 *   after the first). Every case's fixture uses it.
 * - `adversary` — what an attacker with storage access does (rewriting the ledger under the
 *   database). Only cases whose promise is "detected" use it; their assertion is public.
 * - `race` / `hold` — concurrency control, for "exactly one wins" promises.
 */

export type Id = string;

/** Who a session acts as. Empty: no workspace, no principal. */
export interface Actor {
  readonly workspace?: Id;
  readonly principal?: Id;
  /** A claimed run: its id and the secret returned when it was claimed. */
  readonly run?: { readonly id: Id; readonly secret: string };
}

export interface Session {
  readonly actor: Actor;
  /** A session naming only `workspace` (or nothing, when null). */
  asPrincipal(principal: Id): Session;
  /** The same session, naming a run and the secret it claims to hold. */
  asRun(run: Id, secret: string): Session;
  /** Invoke a crossing in its own transaction. A refusal rejects with `Refusal`. */
  call<T = unknown>(crossing: string, args?: Record<string, unknown>): Promise<T>;
  /** Read a view as this session sees it; an invisible row is simply absent. */
  observe<T = Record<string, unknown>>(view: string, args?: Record<string, unknown>): Promise<T[]>;
  /**
   * Invoke a crossing and keep its transaction open until `release`; the result resolves when the
   * crossing returns, the commit when released. For "the first is still uncommitted" races.
   */
  hold<T = unknown>(
    crossing: string,
    args?: Record<string, unknown>,
  ): { result: Promise<T>; release(): void; committed: Promise<void> };
}

export interface RaceItem {
  readonly session: Session;
  readonly crossing: string;
  readonly args?: Record<string, unknown>;
}

/** What a race item came back with: its value, or the refusal. */
export type Settled<T = unknown> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export interface Operator {
  /** Create a workspace with its owner and system principal, as the installation's operator. */
  createWorkspace(args: {
    name: string;
    kind: 'personal' | 'team' | 'company';
    ownerName: string;
    ownerEmail: string;
  }): Promise<{ workspace: Id; owner: Id; system: Id }>;
}

export interface Adversary {
  /** An attack below every grant; resolves with what the attack itself returned, if anything. */
  attack<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
}

export interface Target {
  readonly name: string;
  setWorkspace(workspace: Id | null): Session;
  readonly operator: Operator;
  readonly adversary: Adversary;
  /** Start every item's transaction, then run them all at the same instant. */
  race<T = unknown>(items: readonly RaceItem[]): Promise<Settled<T>[]>;
  /** Binding kinds used since the last drain (for the black-box accounting). */
  drainUsage(): BindingUse[];
  close(): Promise<void>;
}

/** How an adapter implemented one step, recorded per case. */
export type BindingKind =
  | 'crossing' // a published crossing function
  | 'governed-write' // a write the service may make, decided by row-level security (no named crossing)
  | 'view' // a row-level-security-governed read
  | 'operator'
  | 'adversary';

export interface BindingUse {
  readonly name: string;
  readonly kind: BindingKind;
}

/**
 * Why a crossing refused, in the oracle's words. Adapters map their own errors onto these; an
 * error they cannot place is `unclassified`, which no case accepts as a specific reason.
 */
export const REASONS = [
  'not_found', // the subject does not exist for this session (including: it is another workspace's)
  'denied', // no grant, or row-level security refused the row
  'no_identity', // the session acts as nobody
  'not_in_run', // the act needs a live run held by this session
  'stale', // a fence, lease or claim that is no longer current
  'invalid', // the arguments are malformed or out of range
  'conflict', // a uniqueness rule (one open question, a reused key)
  'not_claimable', // the run or effect cannot be claimed now
  'workers_only', // the act belongs to a worker process, not a principal
  'empty_session_only', // the act starts from an empty session
  'own_proposal', // the proposer answers its own question
  'not_by_runs', // a decision answered from inside a run
  'someone_else', // the decision belongs to another person
  'not_independent', // the checker sits in the proposer's delegation tree
  'role', // the role does not allow it (members, owners and admins, verifiers…)
  'verifier_only', // the decision belongs to a verifier
  'verifier_proof', // a verifier answer without its persisted response proof
  'different_proposal', // the answer names another proposal than the one asked
  'not_open', // the decision or subject is no longer open
  'exceeds_parent', // an authority wider than its source
  'revoked', // the mandate is revoked or expired
  'mandate_holder', // the run's agent does not hold the mandate
  'system_dispatches', // only the system principal dispatches
  'window', // inside the workspace's cancellation window
  'too_late', // dispatch already began
  'reconciler', // only a dispatcher or an admin settles an unknown outcome
  'reused_key', // an idempotency key reused for different content
  'frozen', // the record cannot be altered
  'budget', // a budget is spent
  'already_rejected', // the same question was already answered no under the same authority
  'unclassified',
] as const;
/**
 * A reason from the list above, or a promise-specific one an adapter's refusal table declares
 * (each such reason is listed in that promise's coverage file).
 */
export type Reason = (typeof REASONS)[number] | (string & {});

export class Refusal extends Error {
  override readonly name = 'Refusal';
  readonly reason: Reason;
  readonly detail: string;
  readonly crossing: string;
  constructor(reason: Reason, detail: string, crossing: string) {
    super(`${crossing} refused (${reason}): ${detail}`);
    this.reason = reason;
    this.detail = detail;
    this.crossing = crossing;
  }
}
