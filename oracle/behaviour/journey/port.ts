/**
 * The journey port: J-01 (one thread, one brief) reached the way the app reaches a running
 * Backbone — through its public HTTP API — plus the service process itself, which a case may
 * restart, stop, or kill outright. The agent is scripted (no model provider is ever called): a
 * case says what the agent does for each message, and the port reports what the agent was given.
 *
 * Every verdict a case reaches is about stored, observable state: the documents and their
 * versions, the thread's writes and their outcomes, and the model's input. Never model prose.
 */

/** A hold the agent waits on after it has decided its write and before it hands it over. */
export class Hold {
  /** Resolves when the agent is waiting at the hold. */
  readonly reached: Promise<void>;
  private readonly released: Promise<void>;
  private reach = () => {};
  private open = () => {};
  constructor() {
    this.reached = new Promise<void>((resolve) => (this.reach = resolve));
    this.released = new Promise<void>((resolve) => (this.open = resolve));
  }
  release(): void {
    this.open();
  }
  /** The adapter's side: announce the agent is here, then wait for the case. */
  async wait(): Promise<void> {
    this.reach();
    await this.released;
  }
}

export const hold = () => new Hold();

/** What the scripted agent does for one message of the person's. */
export interface AgentPlan {
  /** Titles of documents the agent reads first, in order (attached material, the brief). */
  readonly read?: readonly string[];
  /** Its one write: a new document, or an edit of `document` at the `version` it read. */
  readonly write?: {
    readonly title: string;
    readonly content: string;
    readonly document?: string;
    readonly version?: number;
  };
  /** Wait here after deciding the write, before handing it over (stop-while-prepared cases). */
  readonly hold?: Hold;
  /** What it says when done. */
  readonly answer: string;
}

/** What the person attaches to the first message. */
export interface Material {
  readonly note?: { readonly title: string; readonly text: string };
  readonly spreadsheet?: { readonly name: string; readonly bytes: Uint8Array };
}

export type Author = 'person' | 'agent';

export interface DocumentState {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly content: string;
  /** Who made the current version. */
  readonly by: Author;
  /** Every version kept, oldest first, the current one last, with its words and who made it. */
  readonly versions: readonly { readonly version: number; readonly by: Author; readonly content: string }[];
  /** The original file a document keeps, when it is one. */
  readonly original?: { readonly filename: string; readonly sha256: string; readonly byteLength: number };
}

/**
 * An agent write's outcome as the target states it. `unknown`: the target cannot say whether it
 * happened. `pending`: not finished yet.
 */
export type WriteStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'denied' | 'unknown';

export interface WriteView {
  readonly id: string;
  readonly status: WriteStatus;
  /** The document it wrote or meant to write, when the target names it. */
  readonly document?: string;
}

export interface ThreadView {
  readonly id: string;
  readonly project: string | null;
  /** Nothing is at work in the thread (no run running or waiting to run). */
  readonly idle: boolean;
  readonly answers: readonly string[];
  /** The agent's writes in this thread, oldest first. */
  readonly writes: readonly WriteView[];
  /** Questions the thread put to the person (approvals and other decisions). */
  readonly questions: number;
}

/** What the target says about one Save, by the Save's own identity. */
export type SaveState =
  | { readonly status: 'accepted'; readonly version: number }
  /** Captured and kept, not saved: the person may continue it. */
  | { readonly status: 'prepared' }
  | { readonly status: 'unknown' }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'closed' | 'retired' | 'unavailable' };

/** One Save of one edit, captured before it is sent; its identity survives the service's death. */
export interface SaveTicket {
  readonly document: string;
  readonly content: string;
}

/** Where a service armed to crash dies during an agent's write. */
export type CrashPoint = 'write.proposed' | 'write.claimed' | 'write.begun' | 'write.recorded';

/** One model request: everything the agent was given, and the documents among it. */
export interface Seen {
  readonly text: string;
  readonly documents: readonly { readonly id: string; readonly version: number; readonly content: string }[];
}

export interface Journey {
  readonly person: string;
  createProject(name: string): Promise<string>;
  /** Start a thread. Resolves once the thread exists; the agent works on. */
  ask(input: {
    readonly message: string;
    readonly project?: string;
    readonly material?: Material;
    readonly agent: AgentPlan;
  }): Promise<{ readonly thread: string; readonly attachments: readonly string[] }>;
  followUp(thread: string, message: string, agent: AgentPlan): Promise<void>;
  /** Wait until the thread has at least `answers` answers and nothing is at work. */
  settled(thread: string, answers: number, timeoutMs?: number): Promise<ThreadView>;
  thread(thread: string): Promise<ThreadView>;
  /** The person presses Stop. False when the target says nothing was at work. */
  stop(thread: string): Promise<boolean>;
  documents(): Promise<readonly { readonly id: string; readonly title: string; readonly version: number }[]>;
  document(id: string): Promise<DocumentState>;
  /** The original bytes a document keeps, at a version. */
  original(id: string, version: number): Promise<Uint8Array>;
  /** The person's edit, captured where it survives a crash, before Save is pressed. */
  prepareSave(
    id: string,
    edit: { readonly title: string; readonly content: string; readonly expectedVersion: number },
  ): Promise<SaveTicket>;
  /** Press Save (or continue a prepared Save). */
  save(ticket: SaveTicket): Promise<SaveState>;
  /** Ask the target what became of a Save, without saving. */
  saveState(ticket: SaveTicket): Promise<SaveState>;
  /** Press Save and kill the service `afterMs` after the request leaves; the service stays down. */
  saveThenKill(ticket: SaveTicket, afterMs: number): Promise<void>;
  /** Every model request so far, in order. */
  seen(): readonly Seen[];
  /** Stop the service cleanly and start it again. */
  restart(): Promise<void>;
  /** Kill the service at once (SIGKILL); it stays down until `start`. */
  kill(): Promise<void>;
  /** Start the service, optionally armed to die at a point of the next agent write. */
  start(options?: { readonly crashAt?: CrashPoint }): Promise<void>;
  /** Resolves true when an armed service died at its point within `timeoutMs`. */
  crashed(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface JourneyPort {
  open(label: string): Promise<Journey>;
}
