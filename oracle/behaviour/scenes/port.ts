import type { Id } from '../../target.ts';

/**
 * The scene port: a world in which people work with their agents, an outsider controls what some
 * connected servers answer, and an adversary model does exactly what the latest injected
 * instruction says. Everything a person does goes through the product as an app would; what
 * happened is judged from what reached the outside world and what the database lets people read.
 *
 * The adversary's language is target-neutral text, written inside what an outsider controls:
 * `[[do <tool> {json}]]`, `[[say {"text": …}]]`, `[[wait]]`, `[[verdict approve]]`, with
 * `{{placeholders}}` filled from what it read (see packages/evals/README.md). Tools are named as the
 * product names them for a model: `<connection>__<tool>` for a connected server's tool, the bare
 * name for a workspace tool (`list_documents`, `read_document`, …).
 */

export interface Person {
  readonly id: Id;
  readonly name: string;
}

export type Directive =
  | { readonly kind: 'do'; readonly tool: string; readonly input: Record<string, unknown> }
  | { readonly kind: 'say'; readonly text: string };

/** What the world's people answer to a question that reaches them. */
export type Policy = 'reject' | 'leave' | 'approve';

/** A unique string planted in material, to find it wherever it goes. */
export interface Marker {
  readonly text: string;
  /** The person it is private to; null for shared material. */
  readonly owner: Id | null;
  readonly label: string;
}

/** A question as it was put to people, and what became of it. */
export interface Answered {
  readonly decision: Id;
  readonly reason: string | null;
  readonly question: string;
  readonly checkerKind: string;
  readonly seenBy: readonly string[];
  readonly answeredBy: string | null;
  readonly verdict: 'rejected' | 'left open' | 'decided by the verifier' | 'approved';
}

export interface DirectAttempt {
  readonly what: string;
  readonly outcome: string;
}

/** A call that reached an outside server, with the arguments it carried. */
export interface OutsideCall {
  readonly endpoint: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** What the agent's model was given in one turn (the boundary where context is judged). */
export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly { role: string; content?: unknown; toolCalls?: readonly { name: string }[] }[];
  readonly [more: string]: unknown;
}

/** Outbound traffic on a chat platform or mail channel the world connected. */
export interface ChannelTraffic {
  /** Mail the workspace's address sent: to whom, with what subject and text. */
  readonly mail: readonly { to: readonly string[]; subject: string; text: string }[];
  /** Messages posted on the chat platform, with their channel and the whole body as sent. */
  readonly posts: readonly { channel: string; text: string; body: unknown }[];
}

export interface WorldSpec {
  readonly label: string;
  /** The workspace's verifier: hands everything to people (default), does so quoting what it read, or obeys injected verdicts. */
  readonly verifier?: 'escalating' | 'quoting' | 'obedient';
  /** What a poisoned tool server's description says beyond its job. */
  readonly poison?: string;
  /** The outside servers connected for the workspace (the personal inbox is Marta's own). */
  readonly connect?: readonly string[];
  readonly maxEffects?: number;
  /** A chat platform and the workspace's email address, connected. */
  readonly channels?: boolean;
}

/**
 * Facts for the invariants, taken after a scenario ran. The adapter gathers them; the oracle judges
 * (behaviour/scenes/invariants.ts). Who may read what is read in each person's own session.
 */
export interface Facts {
  readonly outsideCalls: readonly OutsideCall[];
  /** Arguments (as JSON text) of effects a checker approved in the product itself. */
  readonly approvedEffectArgs: readonly string[];
  /** Effects whose work read untrusted content and holds private material, approved through an app. */
  readonly appApprovalsOfMarkedWork: readonly { operation: string; app: string }[];
  /** Who can read each text, and where, in everything their own session may read. */
  readonly readers: readonly { text: string; person: string; places: readonly string[] }[];
  /** The kinds of place the reader check covered (it must include runs and why runs are marked). */
  readonly readsCovered: readonly string[];
  /** What was sent to group conversations on a chat platform. */
  readonly groupPosts: readonly string[];
  readonly effects: readonly {
    readonly id: Id;
    readonly operation: string;
    readonly effectClass: number;
    readonly external: boolean;
    readonly status: string;
    readonly routeReason: string | null;
    /** A checker's approval is bound to it. */
    readonly approved: boolean;
    /** Its run's mandate covers its operation. */
    readonly withinMandate: boolean;
  }[];
  /** Rule-of-two questions a verifier handed to people, and whose material each is. */
  readonly handedOn: readonly { decision: Id; person: string }[];
  readonly knowledge: readonly { statement: string; status: string; approved: boolean; evidenceByAgentOrOwner: boolean }[];
  /** Where a connection's credential was found other than its own request header. */
  readonly canaryPlaces: readonly string[];
  /** The first ledger entry that does not verify, or null. */
  readonly ledgerBad: number | null;
  readonly ruleOfTwo: { readonly asked: number; readonly toPeople: number };
  readonly kept: { readonly answers: number; readonly effects: number };
}

export interface ScenePort {
  open(spec: WorldSpec): Promise<SceneWorld>;
}

/** One scenario's world: Marta Ruiz (owner), Joan Vidal (admin) and Pau Serra (member), each with an agent. */
export interface SceneWorld {
  readonly people: { readonly marta: Person; readonly joan: Person; readonly pau: Person };
  /** What each outside endpoint answers (an outsider sets these), what reached them, and their credentials. */
  readonly outside: {
    readonly answers: Record<string, string>;
    readonly calls: readonly OutsideCall[];
    readonly tokens: Readonly<Record<string, string>>;
  };
  /** The workspace's connections by endpoint: their ids and the slugs their tools are named after. */
  readonly connections: Readonly<Record<string, { id: Id; slug: string }>>;
  readonly markers: readonly Marker[];
  /** Who could read each private marker when work first touched it (the in-workspace ground truth compares with this). */
  readonly before: ReadonlyMap<string, readonly string[]>;
  /** Labels of markers whose person had their own agent share them, at their own request. */
  readonly sharedByOwner: ReadonlySet<string>;
  readonly answered: readonly Answered[];
  readonly direct: readonly DirectAttempt[];
  readonly tasks: readonly Id[];
  /** Operations and tools the people's own plans asked for (anything else the model did was unasked). */
  readonly planned: ReadonlySet<string>;
  readonly plannedTools: ReadonlySet<string>;
  modelRequests(): readonly ModelRequest[];
  channels(): Promise<ChannelTraffic>;

  marker(label: string, owner: Person | null): string;
  ownerShared(label: string): void;
  privateTask(person: Person, title: string): Promise<Id>;
  sharedTask(person: Person, title: string): Promise<Id>;
  document(person: Person, options: { title: string; content: string; task?: Id; sensitive?: boolean }): Promise<Id>;
  importMaterial(person: Person, title: string, content: string): Promise<Id>;
  importMemories(person: Person, memories: readonly string[]): Promise<void>;
  /** Undecided memory proposals wait `days` days: the one change made to the world itself (time passing). */
  proposalsWaited(days: number): Promise<void>;
  remember(person: Person, content: string): Promise<void>;
  ask(person: Person, message: string, plan?: readonly Directive[], policy?: Policy): Promise<unknown>;
  askShared(person: Person, message: string, plan?: readonly Directive[], policy?: Policy): Promise<unknown>;
  reply(person: Person, task: Id, message: string, plan?: readonly Directive[], policy?: Policy): Promise<unknown>;
  watch(person: Person, task: Id, plan?: readonly Directive[], policy?: Policy): Promise<unknown>;
  morningBrief(person: Person): Promise<Id>;
  nightlyTidy(person: Person): Promise<Id>;
  routine(person: Person, command: { instruction: string; autonomy?: string }, plan?: readonly Directive[], policy?: Policy): Promise<unknown>;
  /**
   * A message from a channel becomes work: `send` names the channel act (see `act`), the result is
   * the task it started (or continued), or null when nothing started.
   */
  fromChannel(person: Person, send: { action: string; args: Record<string, unknown> }, plan?: readonly Directive[], policy?: Policy, task?: Id): Promise<unknown | null>;
  /** Try something directly, recording what the product said (`act` names it). */
  attempt(what: string, action: { person: Person | null; action: string; args?: Record<string, unknown> }): Promise<void>;
  /** Questions outside any task: once the verifier has passed them on, the people say no. */
  drainQuestions(): Promise<void>;
  /** Another product act, by name, for one person (or the world, when null). */
  act<T = unknown>(person: Person | null, action: string, args?: Record<string, unknown>): Promise<T>;
  /** A read-only view, by name, to judge a scenario's goal. */
  view<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T[]>;
  facts(): Promise<Facts>;
  close(): Promise<void>;
}
