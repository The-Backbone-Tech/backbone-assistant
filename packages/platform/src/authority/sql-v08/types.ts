// The narrow typed port onto the v0.8 kernel. Not the privileged test driver in its lab.
export interface RunHandle { readonly run: string; readonly fence: number; readonly secret: string }
export interface Observation {
  readonly model: string; readonly pin: string; readonly family: string;
  readonly provider: string; readonly region: string; readonly harness: string;
}
export type SqlOutcome<T> =
  | { readonly status: 'committed'; readonly value: T }
  | { readonly status: 'denied'; readonly code: string }
  | { readonly status: 'unavailable'; readonly reason: 'database-unavailable' | 'credential-role' }
  | { readonly status: 'unknown'; readonly reason: 'transaction-outcome-unknown' };

/** Trusted installation configuration, never renderer/agent request arguments. */
export interface PersonalInstallation {
  readonly workspaceId: string; readonly personId: string; readonly accountId: string;
}
export interface AuthenticatedPersonalSession extends PersonalInstallation {
  readonly status: 'authenticated';
  /** SQL-issued session from the separate identity owner. Never diagnostics or persistent transport state. */
  readonly personToken: string;
}
/** What a person act asks for. A `statement` is the exact words the person must confirm for this act alone. */
export interface PersonRequest { readonly act: string; readonly statement?: string }
/** Required app-main integration. It must perform actual identity verification and bind the SQL session
 * to its installation. A claimed identity or test fixture is not an implementation of this boundary. */
export interface TrustedPersonalSessionOwner {
  /** `person` only when a human answered; anything else is reported as a fixture's word. */
  readonly attests?: 'person' | 'fixture';
  current(request?: PersonRequest): Promise<AuthenticatedPersonalSession | { readonly status: 'required' }>;
}
export interface ContractTerms {
  readonly purpose: string;
  /** Explicit finite SQL envelope; the transport supplies no wildcard or effect-ceiling defaults. */
  readonly data: readonly string[];
  readonly tools: readonly string[];
  readonly destinations: readonly string[];
  readonly ceiling: 1 | 2 | 3 | 4;
  readonly budget: number;
  readonly models: readonly string[];
  readonly ttlMs: number;
  readonly checker: boolean;
}
export interface ScratchContent { readonly bytes: Uint8Array; readonly execution: string }
/** Landed SQL payload only. Paths are data, never filesystem write instructions. */
export interface LandingFile { readonly path: string; readonly bytes: string }
export interface RunAuthority {
  writeContent(input: { readonly key: string; readonly bytes: Uint8Array;
    readonly execution: string; readonly note?: boolean }): Promise<SqlOutcome<void>>;
  readContent(key: string, note?: boolean): Promise<SqlOutcome<ScratchContent | null>>;
  /** The named checker settles one snapshot's unknown with what it observed. */
  reconcilePromotion(intent: string, snapshot: string, observed: PromotionObserved): Promise<SqlOutcome<string>>;
}
/** What can be said of a promotion's landing. Approved needs a spent verdict on that snapshot. */
export type PromotionObserved = 'approved-executed' | 'execution-error';
/** One snapshot's landing record, as the door reads it. */
export interface CrossingRecord {
  readonly intent: string; readonly snapshot: string; readonly disposition: string; readonly reconciliation: string | null;
}
export interface PersonAuthority {
  /** The person SQL authenticated for this session. */
  principal(): Promise<SqlOutcome<string>>;
  /**
   * The person, on a session minted only once they confirmed exactly `statement`. For an act the kernel
   * gives the door, not the person (settling a write's UNKNOWN): the caller acts right after, and SQL
   * cannot tie the two together.
   */
  confirm(act: string, statement: string): Promise<SqlOutcome<string>>;
  /**
   * Takes one held write out, naming the digests shown. Only the contract's owner can. The person is
   * asked `statement` with the attempt and both digests added, on a session of its own.
   */
  acceptAttempt(attempt: string, target: string, args: string, statement: string): Promise<SqlOutcome<void>>;
  denyAttempt(attempt: string, statement: string): Promise<SqlOutcome<void>>;
  /** The owner's word, by digest, once the named checker is gone. SQL cannot check what it says. */
  reconcilePromotionAsOwner(intent: string, snapshot: string, observed: PromotionObserved, observation: string): Promise<SqlOutcome<string>>;
  /** Explicit artifact ID; current SQL visibility decides access. Committed means the read committed,
   * not effect completion. Null means absent/invisible. No material mutation or receipt inference. */
  readLanding(artifactId: string): Promise<SqlOutcome<readonly LandingFile[] | null>>;
  createPlane(name: string): Promise<SqlOutcome<string>>;
  createTask(plane: string, title: string): Promise<SqlOutcome<string>>;
  formContract(plane: string, terms: ContractTerms): Promise<SqlOutcome<string>>;
  admitRun(input: { readonly plane: string; readonly task: string;
    readonly attributes?: { readonly model?: string; readonly family?: string; readonly provider?: string } }):
    Promise<SqlOutcome<RunHandle>>;
  reclaim(run: string): Promise<SqlOutcome<RunHandle>>;
  cancel(run: string): Promise<SqlOutcome<void>>;
  erase(run: string): Promise<SqlOutcome<void>>;
  revokeContract(plane: string): Promise<SqlOutcome<string>>;
}
/** Trusted runtime only. Do not give this port or its credentials to a production actor. */
export interface TrustedExecutionObserver {
  observeExecution(handle: RunHandle, observed: Observation): Promise<SqlOutcome<string | null>>;
  /** A lease is not dispatch, provider authorization, settlement or an effect receipt. */
  issueOutboundLease(handle: RunHandle): Promise<SqlOutcome<string | null>>;
}
export type AttemptStatus = 'held' | 'attempted' | 'claimed' | 'dispatching' | 'executed' | 'denied' | 'failed' | 'unknown';
/** What the door assigns. Nothing here comes from a run or a model, and nothing here can hold content. */
export interface AttemptRequest {
  readonly class: 'document' | 'external' | 'irreversible'; readonly tool: string; readonly operation: string;
  /** Hex SHA-256 digests. */
  readonly target: string; readonly args: string; readonly key: string;
  readonly cost: number;
}
export interface EffectAttempt extends AttemptRequest {
  readonly id: string; readonly run: string; readonly fence: number; readonly status: AttemptStatus;
  readonly reconciliation: string | null;
}
/**
 * What an egress door gives a destination that fences. Run closure in SQL holds only up to begin:
 * past it nothing can call a paused dispatcher back, so the last check leaves a window, and only the
 * destination can close it. It must apply `key` at most once, and must refuse `fence` once a higher
 * fence of `run` is known to it. The document door's destination is this home, which has no fence.
 */
export interface DestinationFence {
  readonly key: string; readonly attempt: string; readonly run: string; readonly fence: number;
}
/** Trusted runtime only. SQL binds these calls to the attempt, not to what really happened. */
export interface EffectDoor {
  attempt(handle: RunHandle, request: AttemptRequest): Promise<SqlOutcome<string>>;
  /** Null: a closed run denied it, or a hold left it waiting. A row a close already ended, or a held row, is refused. */
  claim(attempt: string, leaseMs: number): Promise<SqlOutcome<string | null>>;
  /** Names what is about to go out: an accepted row is one target and one set of arguments. */
  begin(attempt: string, claim: string, args: string, target: string): Promise<SqlOutcome<boolean>>;
  settle(attempt: string, claim: string, outcome: 'executed' | 'failed' | 'unknown'): Promise<SqlOutcome<void>>;
  sweep(): Promise<SqlOutcome<number>>;
  /** Only what the door observed at the source. An unknown never reconciles on a guess. */
  reconcile(attempt: string, outcome: 'executed' | 'failed', observation: string): Promise<SqlOutcome<void>>;
  /** The attempts of one run. */
  attempts(run: string): Promise<SqlOutcome<readonly EffectAttempt[]>>;
  /** The attempts of these runs, in one read. */
  attemptsOf(runs: readonly string[]): Promise<SqlOutcome<readonly EffectAttempt[]>>;
  /** Whether this attempt may still land now: it is dispatching, and gov.effect_cap still passes it. */
  mayLand(run: string, fence: number, attempt: string): Promise<SqlOutcome<boolean>>;
  /** A first outcome-unknown and nothing else, for when the checker cannot record it. Door only. */
  recordUnknownCrossing(intent: string, snapshot: string, iteration: number): Promise<SqlOutcome<void>>;
  /** Every landing record of the workspace, through the audit export. */
  crossingRecords(): Promise<SqlOutcome<readonly CrossingRecord[]>>;
  /** Ends a run with no person. Finished is the kernel's to grant: it refuses a run with anything open or unknown. */
  closeRun(run: string, fence: number, status: 'finished' | 'cancelled'): Promise<SqlOutcome<void>>;
  /** A run as it stands, or null if the kernel does not show it. */
  readRun(run: string): Promise<SqlOutcome<{ readonly id: string; readonly status: string; readonly fence: number } | null>>;
  /** Names the kernel's database, so a home can be held to it. */
  database(): Promise<SqlOutcome<string>>;
  runs(task: string): Promise<SqlOutcome<readonly { readonly id: string; readonly status: string; readonly fence: number }[]>>;
  /** Every run of the workspace. The kernel's only way to find a run whose id died with its process. */
  allRuns(): Promise<SqlOutcome<readonly { readonly id: string; readonly task: string; readonly status: string; readonly fence: number }[]>>;
}
/** Trusted composition only. Never pass this object, person/observer ports or raw handles to an actor.
 * The isolated actor receives only one opaque RunAuthority created by the trusted composition. */
export interface SqlV08PersonalRuntime {
  readonly person: PersonAuthority;
  readonly observer: TrustedExecutionObserver;
  readonly door: EffectDoor;
  run(handle: RunHandle): RunAuthority;
}

/** Structural subset of pg.Pool. No arbitrary-query capability is returned to consumers. */
export interface SqlPool {
  connect(): Promise<SqlClient>;
}
export interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(error?: Error): void;
  /** The driver's connection events, for a connection held for the host's life. */
  on?(event: 'error' | 'end', listener: () => void): unknown;
}
