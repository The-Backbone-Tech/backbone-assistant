// The gateway port doors consume (docs/repo-design.md, Doors to other tools): propose an effect,
// read its receipt, list receipts, recall accepted knowledge. Types only. Every call acts as one
// door grant: a run under a mandate the person issued outside the door, so a door can only narrow.
// Implemented by composition/gateway.ts over the core's crossings.

/** What became of an effect, in words a door shows as they are. Only DONE is success. */
export type EffectOutcome =
  /** Dispatched and observed to have happened. */
  | 'DONE'
  /** Dispatched and observed not to have happened. */
  | 'FAILED'
  /** Refused by the gateway (outside the mandate, an exact copy of an UNKNOWN, ...). Nothing was sent. */
  | 'REFUSED'
  /** Cancelled before it was sent (its mandate was revoked, a person cancelled it). */
  | 'CANCELLED'
  /** Waiting for a person's decision. Nothing was sent. */
  | 'AWAITING_DECISION'
  /** Allowed and queued, or being sent now. */
  | 'PENDING'
  /** Sent, but nobody can tell whether it happened. Never success, never resent: a person settles it. */
  | 'UNKNOWN';

export interface EffectReceipt {
  effect: string;
  idempotencyKey: string;
  operation: string;
  outcome: EffectOutcome;
  /** The core's own status word, for the record. */
  status: string;
  effectClass: number;
  route: string | null;
  /** Why the gateway routed or refused it (outside_mandate, above_ceiling, repeat_unknown_blocked, ...). */
  reason: string | null;
  /** The earlier effect this one repeats, when refused as its copy. */
  repeatOf: string | null;
  /** The arguments' hash; receipts carry references, never the words. */
  argsHash: string;
  observationHash: string | null;
  externalRef: string | null;
  /** For UNKNOWN: when its resolver must have settled it. */
  resolveBy: string | null;
  proposedAt: string;
  /** What the caller should do next, in plain words. */
  next: string;
}

export type GatewayRefusalReason = 'NO_MANDATE' | 'INVALID' | 'REUSED_KEY' | 'NOT_FOUND' | 'NOT_AVAILABLE' | 'REFUSED';
export interface GatewayRefusal {
  ok: false;
  outcome: 'REFUSED';
  reason: GatewayRefusalReason;
  detail: string;
}
/** Policy coverage notice; never a count or a disclosure that hidden records exist. */
export interface KnowledgeNotice { kind: 'source-withheld'; detail: string }
export type GatewayResult<T> = { ok: true; value: T; notice?: KnowledgeNotice } | GatewayRefusal;

export interface KnowledgeItem {
  statement: string;
  topic: string;
}

export interface GatewayMethods {
  'effects.propose': (a: { operation: string; args: Record<string, unknown>; description: string; idempotencyKey: string; expectedVersion?: string }) => GatewayResult<EffectReceipt>;
  'effects.get': (a: { effect?: string; idempotencyKey?: string }) => GatewayResult<EffectReceipt>;
  'effects.list': (a: { limit?: number }) => GatewayResult<EffectReceipt[]>;
  'knowledge.recall': (a: { words?: string[]; limit?: number }) => GatewayResult<KnowledgeItem[]>;
}
export type GatewayMethod = keyof GatewayMethods;
export type GatewayArgs<M extends GatewayMethod> = Parameters<GatewayMethods[M]>[0];
export type GatewayValue<M extends GatewayMethod> = ReturnType<GatewayMethods[M]>;

export interface Gateway {
  call<M extends GatewayMethod>(method: M, args: GatewayArgs<M>): Promise<GatewayValue<M>>;
  close(): Promise<void>;
}

/** Carries out one operation once the gateway has allowed and claimed it. Executors hold no policy. */
export interface Executor {
  /** Refuses malformed arguments before anything is proposed: a fixed reason that never repeats the caller's names or values, or null. */
  validate(args: Record<string, unknown>): string | null;
  /** Do it once. Throwing means the outcome cannot be told: UNKNOWN. */
  dispatch(args: Record<string, unknown>): Promise<{ outcome: 'succeeded' | 'failed'; evidence: string; note?: string }>;
  /** After a kill mid-dispatch: whether it visibly happened. Anything short of proof is UNKNOWN. */
  inspect(args: Record<string, unknown>): Promise<{ landed: boolean; evidence: string }>;
}

/** A door grant, as the person issued it outside any door. */
export interface DoorGrant {
  name: string;
  agent: string;
  mandate: string;
  task: string;
  run: string;
  operations: string[];
  ceiling: number;
  expiresAt: string;
  /** The door's registration the grant is bound to: the core caps its effects by what it declares. */
  piece?: { id: string; piece: string; version: string; digest: string };
}
