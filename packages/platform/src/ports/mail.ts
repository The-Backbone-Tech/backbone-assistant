// The mail connector port: types only. A connector reads one mailbox and, once its writes are
// open, changes it; it holds no policy. It classifies every request itself, from the request's own
// fields and the mailbox's label catalogue, never from a command string: the operation name, the
// effect class the gateway records and the recovery class the brief shows all come from what the
// request would do. A request it does not recognise, or an argument it does not know, is refused.
// Writes stay gated until the lab's door conformance is accepted; a gated connector refuses them.
import type { RecoveryClass } from '../api.ts';

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailAttachment {
  name: string;
  mediaType: string;
  size: number;
}

export interface MailMessage {
  id: string;
  threadId: string;
  /** Changes whenever the message changes at the provider (Gmail's historyId, Graph's changeKey). */
  version: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  date: string;
  /** Label ids, system ones included (INBOX, UNREAD, SPAM, TRASH). */
  labels: string[];
  attachments: MailAttachment[];
  /** Plain text. */
  body: string;
}

export type MailSummary = Pick<MailMessage, 'id' | 'threadId' | 'version' | 'from' | 'subject' | 'date' | 'labels'>;

export interface MailLabel {
  id: string;
  name: string;
  system: boolean;
}

/** What a connector can be asked, as data. Sending, forwarding and deleting are not in it. */
export type MailRequest =
  | { op: 'list'; after?: string }
  | { op: 'read'; id: string }
  | { op: 'labels' }
  /** Add and remove labels on one message, at the version it was read at. Moves are label changes (INBOX, SPAM, TRASH). */
  | { op: 'modify'; id: string; version: string; add: string[]; remove: string[] };

/** How a change can be taken back, sized to its finality (the api's words). A read has none. */
export type { RecoveryClass };

export interface ClassifiedOperation {
  /** Stable receipt identity for provider attribution only; grants no authority and is not a request argument. */
  operationKey?: string;
  /** The operation the gateway records, derived from what the request does: mail.list, mail.read, mail.labels, mail.label, mail.move, mail.trash. */
  operation: string;
  effectClass: 1 | 2 | 3 | 4 | 5 | 6;
  external: boolean;
  read: boolean;
  recovery: RecoveryClass | null;
  /** Confirmed inverse if already known; pure pre-dispatch classification leaves this null. */
  undo: MailRequest | null;
  /** The request, normalised: what the gateway hashes and the person's approval binds. */
  args: Record<string, unknown>;
  /** What it does, in plain words, for the brief. */
  summary: string;
}

export type Classification = { ok: true; value: ClassifiedOperation } | { ok: false; reason: string };

/** Whether the account may be used for this job: scopes, licence tier, admin consent. Anything short of proof is not entitled. */
export interface Entitlement {
  ok: boolean;
  provider: string;
  account: string;
  /** What is missing, in plain words; empty when entitled. */
  missing: string[];
  detail: string;
}

export interface MailConnector {
  /** The mailbox's own clock, when it is not this computer's. */
  now?(): string;
  /** `fake`, `gmail`, `graph`: who answers. */
  readonly provider: string;
  readonly account: string;
  /** For people: which mailbox, through what. */
  readonly label: string;
  /** `gated` until the door's conformance is accepted: `apply` then refuses every write. */
  readonly writes: 'gated' | 'open';
  /** Checked at onboarding and before every run; fails closed. */
  entitlement(): Promise<Entitlement>;
  /** A pure function of the request and the label catalogue. */
  classify(request: MailRequest, labels: MailLabel[]): Classification;
  /** The inbox, oldest first, after a cursor; the cursor to continue from. */
  list(after?: string): Promise<{ messages: MailSummary[]; cursor: string }>;
  read(id: string): Promise<MailMessage>;
  labels(): Promise<MailLabel[]>;
  /** Carry out once. A confirmed success may return its executable, post-write-version-bound inverse.
   * Throwing means UNKNOWN; no inverse or success may be invented from that uncertainty. */
  apply(operation: ClassifiedOperation): Promise<{ outcome: 'succeeded' | 'failed'; evidence: string; undo?: MailRequest | null }>;
  /** After an UNKNOWN, read the provider without applying again. Positive proof must identify the
   * operationKey, exact normalized request and input version in this account; matching labels alone
   * are insufficient. The trusted caller also binds the actual loaded registration to the receipt.
   * An absent key or unsupported attribution remains null when the outcome is ambiguous.
   * This metadata grants no authority and promises no provider idempotency. */
  probe(operation: ClassifiedOperation): Promise<{ landed: boolean | null; evidence: string }>;
  /** Calls back when new mail arrives (Gmail push, Graph change notifications); returns a stop. */
  watch(listener: () => void): () => void;
}

/**
 * The job's instructions for one mailbox, given alike to the job and to any baseline it is measured
 * against: categories with definitions in order of precedence (the first that fits wins), the
 * urgency rubric, the moves, and how to name the requester, mark a suspicious message and reply.
 */
export interface TriageTask {
  /** Whose mail it is and what they do, in one sentence. */
  context: string;
  categories: { id: string; label: string; definition: string }[];
  urgency: { id: string; definition: string }[];
  moves: { id: string; definition: string }[];
  requester: string;
  suspicious: string;
  reply: string;
}

/** What a mail module exports: the composition loads it by path, after checking its digest, and calls these. */
export interface MailModule {
  createMailConnector(options: { home: string; provider?: string }): MailConnector;
  readTask(): TriageTask;
}
