// A fake mailbox: an in-process model of one provider mailbox, with the provider's truth kept apart
// from what the caller is told. Modelled on the destination fakes of the work-planes lab (its
// `prototype/packages/fakes`, read 26 Oct 2026; nothing imported): deterministic identifiers and
// versions, scripted faults that act before or after the provider commits, and a probe that reads
// the provider's state rather than the caller's memory. Behaviours are labelled [V] verified at the
// provider's documentation, [I] inference, as there.
//
// - Versions: every change bumps a mailbox-wide history counter and stamps the message with it
//   (Gmail's historyId [V]). A change names the version it was read at and is refused when the
//   message has moved on ([I]: Graph's If-Match on changeKey; Gmail has no precondition, so its
//   adapter reads the historyId first).
// - Modify is atomic for one message [V: users.messages.modify]. Its faults: lost before it reaches
//   the provider, applied and the reply lost (a timeout), applied with a 5xx, or a documented 429.
// - There is no send, forward or delete: the outbox exists only so tests can see it stays empty.
// - The state can live in a file, so it survives the app's restarts as a real provider would.
import { createHash, randomUUID } from 'node:crypto';
import { withHomeLock } from '@backbone-next/platform/composition/home-lock';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClassifiedOperation, Entitlement, MailConnector, MailLabel, MailMessage, MailRequest, MailSummary } from '@backbone-next/platform/ports/mail';
import { classifyMailRequest } from './classify.ts';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixture');

export interface Seed {
  account: string;
  /** The mailbox's clock: when this inbox is being read. */
  now: string;
  aliases?: string[];
  labels: MailLabel[];
  messages: Omit<MailMessage, 'version'>[];
}

export type FaultKind = 'timeout-before-commit' | 'timeout-after-commit' | 'unknown-after-commit' | 'reject';
/** A scripted fault: the nth call (1-based, default 1) of an operation. */
export interface Fault {
  at: 'list' | 'read' | 'labels' | 'modify';
  nth?: number;
  kind: FaultKind;
}

/** What the account holds at the provider: the job needs reads; label and move need modify. */
export const SCOPES = { read: 'mail.read', modify: 'mail.modify' } as const;

export interface FakeMailboxOptions {
  /** A file the provider's state lives in; in memory when absent. */
  stateFile?: string;
  /** The mailbox to seed with: the bundled fixture by default. */
  seed?: Seed;
  /** How many seeded messages are in the inbox at the start; the rest arrive with deliver(). All by default. */
  initial?: number;
  /** What the account was granted. Both scopes by default; a missing one fails the entitlement check. */
  scopes?: string[];
  /** Tests open the write path to prove its receipts; the app ships it gated. */
  writes?: 'gated' | 'open';
  faults?: Fault[];
  /** The provider's answer time, so tests can stop the job mid-call. */
  latencyMs?: number;
}

interface State {
  account: string;
  history: number;
  /** When each message arrived: the history value it was delivered at. */
  arrivals: Record<string, number>;
  messages: MailMessage[];
  /** Seeded messages not yet delivered. */
  pending: Omit<MailMessage, 'version'>[];
  labels: MailLabel[];
  /** Messages sent from this mailbox. Nothing in this connector sends: it stays empty. */
  outbox: unknown[];
  /** Every change the provider applied, in order. */
  applied: { id: string; add: string[]; remove: string[]; version: string; operationKey?: string; expectedVersion?: string; requestHash?: string }[];
}

export class ProviderTimeout extends Error {
  override readonly name = 'ProviderTimeout';
}
export class ProviderUnknown extends Error {
  override readonly name = 'ProviderUnknown';
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function readSeed(dir = FIXTURE_DIR): Seed {
  return JSON.parse(readFileSync(join(dir, 'mailbox.json'), 'utf8')) as Seed;
}

export class FakeMailbox implements MailConnector {
  readonly provider = 'fake';
  readonly account: string;
  readonly label: string;
  readonly writes: 'gated' | 'open';
  readonly #options: FakeMailboxOptions;
  #state: State;
  readonly #calls = new Map<string, number>();
  readonly #listeners = new Set<() => void>();

  readonly #seedNow: string;

  constructor(options: FakeMailboxOptions = {}) {
    this.#options = options;
    this.#seedNow = (options.seed ?? readSeed()).now;
    this.writes = options.writes ?? 'gated';
    const saved = options.stateFile && existsSync(options.stateFile) ? (JSON.parse(readFileSync(options.stateFile, 'utf8')) as State) : null;
    if (saved) this.#state = saved;
    else {
      const seed = options.seed ?? readSeed();
      const initial = options.initial ?? seed.messages.length;
      this.#state = {
        account: seed.account,
        history: 0,
        arrivals: {},
        messages: [],
        pending: seed.messages.map((m) => structuredClone(m)),
        labels: structuredClone(seed.labels),
        outbox: [],
        applied: [],
      };
      this.#deliver(initial, false);
    }
    this.account = this.#state.account;
    this.label = `Sample mailbox (${this.account})`;
  }

  /** The provider's own truth, for tests: never what a caller was told. */
  get truth(): Readonly<State> {
    this.#reload();
    return structuredClone(this.#state);
  }

  /** New mail arrives: the next `n` seeded messages land in the inbox, and watchers are told. */
  deliver(n = 1): number {
    this.#reload();
    const landed = this.#deliver(n);
    if (landed) for (const l of this.#listeners) l();
    return landed;
  }

  #deliver(n: number, persist = true): number {
    const next = this.#state.pending.splice(0, n);
    for (const m of next) {
      this.#state.messages.push({ ...m, version: String(++this.#state.history) });
      this.#state.arrivals[m.id] = this.#state.history;
    }
    if (persist) this.#save();
    return next.length;
  }

  #save() {
    const file = this.#options.stateFile;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#state));
    renameSync(temporary, file);
  }

  #reload() {
    const file = this.#options.stateFile;
    if (file && existsSync(file)) {
      const state = JSON.parse(readFileSync(file, 'utf8')) as State;
      if (state.account !== this.account) throw new Error('The provider state belongs to another account.');
      this.#state = state;
    }
  }

  #withState<T>(run: () => T | Promise<T>): Promise<T> {
    const work = async () => { this.#reload(); if (this.#options.stateFile && !existsSync(this.#options.stateFile)) this.#save(); return run(); };
    return this.#options.stateFile ? withHomeLock(`${this.#options.stateFile}.provider`, work) : work();
  }

  #requireScope(modify = false) {
    const scopes = this.#options.scopes ?? [SCOPES.read, SCOPES.modify];
    if (![SCOPES.read, ...(modify ? [SCOPES.modify] : [])].every((scope) => scopes.includes(scope))) throw new Error('The provider entitlement no longer includes the required read/modify permission.');
  }

  /** The scripted fault for this call of `at`, if any. */
  #fault(at: Fault['at']): FaultKind | null {
    const n = (this.#calls.get(at) ?? 0) + 1;
    this.#calls.set(at, n);
    return this.#options.faults?.find((f) => f.at === at && (f.nth ?? 1) === n)?.kind ?? null;
  }

  async #answer<T>(at: Fault['at'], run: () => T): Promise<T> {
    return this.#withState(async () => {
      if (this.#options.latencyMs) await new Promise((r) => setTimeout(r, this.#options.latencyMs));
      this.#reload();
      this.#requireScope(at === 'modify');
      const fault = this.#fault(at);
      if (fault === 'timeout-before-commit') throw new ProviderTimeout(`${at}: no answer (the request never reached the provider)`);
      if (fault === 'reject') throw Object.assign(new Error(`${at}: 429 rate limited; nothing applied`), { status: 429 });
      const value = run();
      if (fault === 'timeout-after-commit') throw new ProviderTimeout(`${at}: no answer (the provider applied it)`);
      if (fault === 'unknown-after-commit') throw new ProviderUnknown(`${at}: 500 backendError (the provider applied it)`);
      return structuredClone(value);
    });
  }

  now(): string {
    return this.#seedNow;
  }

  async entitlement(): Promise<Entitlement> {
    const scopes = this.#options.scopes ?? [SCOPES.read, SCOPES.modify];
    const missing = [
      ...(scopes.includes(SCOPES.read) ? [] : ['permission to read mail']),
      ...(scopes.includes(SCOPES.modify) ? [] : ['permission to change labels (asked for when label and move are signed)']),
    ];
    const readable = scopes.includes(SCOPES.read);
    return {
      ok: readable,
      provider: this.provider,
      account: this.account,
      missing,
      detail: readable ? `The sample mailbox ${this.account} can be read.` : `The account ${this.account} has not granted ${missing.join(' or ')}; nothing was read.`,
    };
  }

  classify(request: MailRequest, labels: MailLabel[]) {
    return classifyMailRequest(request, labels);
  }

  list(after?: string): Promise<{ messages: MailSummary[]; cursor: string }> {
    return this.#answer('list', () => {
      const from = Number(after ?? 0);
      const inbox = this.#state.messages.filter((m) => m.labels.includes('INBOX') && (this.#state.arrivals[m.id] ?? 0) > from);
      const messages = inbox.map(({ id, threadId, version, from: sender, subject, date, labels }) => ({ id, threadId, version, from: sender, subject, date, labels }));
      return { messages, cursor: String(this.#state.history) };
    });
  }

  read(id: string): Promise<MailMessage> {
    return this.#answer('read', () => {
      const m = this.#state.messages.find((x) => x.id === id);
      if (!m) throw Object.assign(new Error('404 notFound'), { status: 404 });
      return m;
    });
  }

  labels(): Promise<MailLabel[]> {
    return this.#answer('labels', () => this.#state.labels);
  }

  async apply(op: ClassifiedOperation): Promise<{ outcome: 'succeeded' | 'failed'; evidence: string; undo?: MailRequest | null }> {
    // Gated until the door's conformance is accepted: nothing reaches the provider.
    if (this.writes !== 'open') throw new Error('Writes to this mailbox are gated: nothing was sent to the provider.');
    if (op.read) throw new Error('A read is not applied.');
    const a = op.args as { id: string; version: string; add: string[]; remove: string[] };
    return this.#answer('modify', () => {
      const m = this.#state.messages.find((x) => x.id === a.id);
      if (!m) return { outcome: 'failed' as const, evidence: sha(`not-found:${a.id}`) };
      if (m.version !== a.version) return { outcome: 'failed' as const, evidence: sha(`conflict:${a.id}:${m.version}`) };
      const before = [...m.labels];
      m.labels = [...m.labels.filter((l) => !a.remove.includes(l)), ...a.add.filter((l) => !m.labels.includes(l))];
      m.version = String(++this.#state.history);
      this.#state.applied.push({ id: a.id, add: a.add, remove: a.remove, version: m.version, operationKey: op.operationKey, expectedVersion: a.version, requestHash: sha(JSON.stringify(a)) });
      this.#save();
      const add = before.filter((l) => !m.labels.includes(l));
      const remove = m.labels.filter((l) => !before.includes(l));
      const undo: MailRequest | null = add.length || remove.length ? { op: 'modify', id: m.id, version: m.version, add, remove } : null;
      return { outcome: 'succeeded' as const, evidence: sha(`applied:${a.id}:${m.version}`), undo };
    });
  }

  async probe(op: ClassifiedOperation): Promise<{ landed: boolean | null; evidence: string }> {
    return this.#withState(() => {
      this.#requireScope();
      const a = op.args as { id: string; version: string; add: string[]; remove: string[] };
      const m = this.#state.messages.find((x) => x.id === a.id);
      if (!m) return { landed: null, evidence: sha(`probe-missing:${a.id}`) };
      // Matching labels cannot identify the caller's operation. A provider record must bind the
      // stable receipt key, exact request and expected version; legacy records remain ambiguous.
      const applied = op.operationKey && this.#state.applied.find((r) => r.operationKey === op.operationKey && r.id === a.id && r.expectedVersion === a.version && r.requestHash === sha(JSON.stringify(a)));
      if (applied) return { landed: true, evidence: sha(`probe:${this.account}:${op.operationKey}:${applied.version}:${applied.requestHash}`) };
      if (m.version === a.version) return { landed: false, evidence: sha(`probe:${a.id}:${m.version}:unchanged`) };
      return { landed: null, evidence: sha(`probe:${a.id}:${m.version}:moved-on`) };
    });
  }

  watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
