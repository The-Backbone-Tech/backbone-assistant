import type { AcpExecutableIdentity } from '../api-acp.ts';
// The Harness port (docs/contracts/harness.md, DR B1): the plug an engine sits behind, shaped like
// the AI SDK's HarnessV1. Types only. An engine starts or continues a turn, streams its events, can
// be steered and stopped, and proposes every tool call to the ToolHost, which carries it through
// the core's effect gateway for canonical material. API engines have no separate effect route;
// the proposed native adapter uses restricted staging, then conditional ToolHost import.
// Resuming after a crash is starting the same turn again with `resumed`: the
// ToolHost keys each write by its turn and target, so the same write is the same effect and is
// never sent twice, and a write a kill left UNKNOWN stays UNKNOWN.

export { workspaceExecution, workspaceFailure, WorkspaceRefusal, type WorkspaceExecution } from '../workspace/result.ts';

/** A file of the active thread's project, as the engine may see it. */
export interface ToolFile {
  name: string;
  version: number;
  /** Stable material identity; absent on adapters that cannot attest it. */
  materialId?: string;
  projectId?: string;
  /** Number of withdrawals recorded by the material authority, including restored ones. */
  withdrawals?: number;
  /** Who made the current version. */
  by: 'person' | 'agent';
  class: 'original' | 'working' | 'accepted';
  mediaType: string;
}

/** What came of a proposed write. UNKNOWN is never success, and is never resent. */
export type WriteOutcome =
  | { outcome: 'DONE'; name: string; version: number }
  | { outcome: 'REFUSED'; detail: string }
  | { outcome: 'UNKNOWN'; detail: string };

/**
 * The tools the thread's mandate grants, scoped to the active thread (R-HARN-01). Reads are recorded
 * by the core; a write is an effect proposed through the gateway, which decides, dispatches and
 * observes it. The optional workspace command is confined local scratch, never a fetch or
 * canonical write. The native trial's
 * separately admitted temporary staging is described by its contract; it is not exclusive ToolHost execution.
 */
export interface ToolHost {
  /** Local, offline, expiring thread scratch. Project changes still use write. */
  runWorkspace?(request: { command: string; attachment?: string }, signal?: AbortSignal): Promise<string>;
  /** Recheck exactly the material this turn read, synchronously immediately before dispatch.
   * This is not a grant: callers must also invoke the request's stillAllowed check, and check
   * run/mandate authority at their own send boundary. */
  stillGranted?(sources: readonly { materialId: string; projectId: string; version: number; withdrawals: number }[]): true | string;
  list(): Promise<ToolFile[]>;
  /** The current version's text (an Office workbook as cell text), or null.
   * Trusted staging marks availability, not an observed engine read; dependency checks are identical. */
  read(name: string, observation?: { purpose: 'staging' }): Promise<(ToolFile & { text: string }) | null>;
  write(name: string, body: string, signal: AbortSignal): Promise<WriteOutcome>;
  /** Conditional native draft creation. Host serializes source/target validation with all writes. */
  writeIfVersion?(name: string, body: string, base: { targetVersion: number | null; sources: { name: string; version: number }[] }, signal: AbortSignal): Promise<WriteOutcome>;
  /** Durably keeps finished staged files. Nothing lands: only recovery or a failed turn imports them, through writeIfVersion's checks. */
  checkpoint?(files: CheckpointFile[], sources: { name: string; version: number }[]): Promise<void>;
  /**
   * Start a depth-one child of this thread. Its authority is delegated from this turn's and never
   * exceeds it. The same brief from the same turn is the same child, so a resumed turn starts none anew.
   */
  startChild?(request: ChildRequest): Promise<ChildStart>;
  /** Wait for a child of this thread; null when it is none, or this turn was stopped. Its report is data. */
  awaitChild?(threadId: string, signal: AbortSignal): Promise<ChildReport | null>;
  /** Propose a change of goal. The goal does not change: the person sees the proposal and decides. */
  proposeGoal?(text: string): Promise<void>;
  /**
   * Add a card to this thread's board, for a worker of the pool to take once its dependencies are done.
   * The card is a brief, never authority: its worker's authority is delegated from this thread's. The
   * same card from the same turn is the same card, so a resumed turn adds none anew.
   */
  addCard?(request: CardRequest): Promise<CardAdded>;
  /**
   * Send words to another card on the same board, while a worker runs it: they reach its turn as a
   * peer's data, never the person's word and never authority, with what this turn read as their sources.
   * Offered to a board's chat and to its workers.
   */
  messageCard?(request: CardMessage): Promise<CardMessaged>;
  /**
   * Look something up in the person's memory mid-turn, ranked as recall is. The lines' sources are this
   * turn's reads before their words come back, and a line holding a credential or a withdrawn source is not given.
   */
  searchMemory?(query: string): Promise<string>;
  /**
   * Propose a line for the person's memory: held for them to keep or discard, never used until kept,
   * with this turn's reads as its sources. Never a credential. Returns what became of it, in words.
   */
  proposeMemory?(proposal: { text: string; topic?: string }): Promise<string>;
  /** The person's own MCP tools they enabled, as they stand now; a read-only turn is offered only reads. */
  connectors?(): ConnectorToolSpec[];
  /** Call one, through the host: a read is recorded before its text comes back, and an effect is held, never sent. */
  callConnector?(name: string, args: Record<string, unknown>, signal: AbortSignal, invocation?: ConnectorInvocation): Promise<ConnectorResult>;
  /** Trusted adapter hook, not a model tool. Durably reserve the exact native connector IDs in
   * one assistant message before its first connector dispatch; return the Host's batch UUID. */
  reserveConnectorBatch?(callIds: readonly string[]): Promise<string>;
}
/** `dependsOn` names cards of the same board, by the ids add_card returned. */
export interface CardRequest { title?: string; brief: string; dependsOn?: string[]; model?: string; effort?: 1 | 2 | 3 | 4 | 5 }
export type CardAdded = { outcome: 'ADDED'; cardId: string; status: string } | { outcome: 'REFUSED'; reason: string; detail: string };
/** `card` is an id on this board, as add_card returned it or a worker's brief lists it. */
export interface CardMessage { card: string; text: string }
export type CardMessaged = { outcome: 'SENT'; state: string } | { outcome: 'REFUSED'; reason: string; detail: string };
/**
 * A tool of one of the person's own MCP servers that they enabled, offered through the host's one
 * governed crossing. A `read` flows and says how complete it is; an `effect` is held for the person.
 */
export interface ConnectorToolSpec {
  /** What the engine calls it: letters, digits, `_` and `-`, at most 64. */
  name: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: 'read' | 'effect';
}
/**
 * What came of a connector call. Only a `complete` read may be taken as "nothing there"; a partial,
 * rate-limited, timed-out or failed one says nothing about what exists. HELD was not sent. SENT
 * went out on the person's word, either their standing signature for the tool or their own release
 * of this call asked again by the turn: `sent` is done, `failed` is the server's own refusal, and
 * `unknown` is no answer, which is never sent again.
 */
/** Native invocation identity only: the Host still validates actual request/source/authority. */
export interface ConnectorInvocation { engine: 'pi' | 'codex'; namespace: string; callId: string }
export type ConnectorResult =
  | { outcome: 'READ'; status: 'complete' | 'partial' | 'rate-limited' | 'timed-out' | 'failed'; text: string; detail?: string }
  | { outcome: 'HELD'; detail: string }
  /** No automatic redispatch or model continuation may treat a missing response as new work. */
  | { outcome: 'UNKNOWN'; detail: string }
  | { outcome: 'SENT'; state: 'sent' | 'failed' | 'unknown'; detail: string }
  | { outcome: 'REFUSED'; detail: string };

export interface CheckpointFile { name: string; body: string; targetVersion: number | null }
/** `reviews` names this thread or a child of it, whose transcript a reviewer is given as data. */
/** `model` and `effort` are the child's own, defaulting to the parent's; `fallback` is tried in order only if the model is refused at admission. */
/** `agent` names a saved role (own/name) or an enabled plugin agent. Both guide the child; only saved roles select its model and restrict tools, within the parent's authority. */
export interface ChildRequest { brief: string; role: 'worker' | 'reviewer'; title?: string; reviews?: string; model?: string; effort?: 1 | 2 | 3 | 4 | 5; fallback?: string[]; agent?: string }
export type ChildStart = { outcome: 'STARTED'; threadId: string } | { outcome: 'REFUSED'; reason: string; detail: string };
/** `status` is `unknown` whenever a receipt is: such work is never reported as done. */
export interface ChildReport {
  threadId: string;
  status: 'done' | 'stopped' | 'refused' | 'unknown';
  text: string;
  receipts: { target: string; outcome: 'DONE' | 'REFUSED' | 'UNKNOWN'; detail?: string }[];
}

/** Where the model is reached. Policy lives in Backbone (R-MODEL-02); the credential is a handle. */
export interface ModelRoute {
  /** Machine-owned login; no credential is read or supplied by the Host. */
  machineClient?: 'claude';
  /** Host-bound non-secret execution settings; only a status class reaches a surface. */
  machineClientEnvironment?: Record<string, string>;
  machineExecutable?: AcpExecutableIdentity;
  /** `agent`: model, authentication and billing chosen by an ACP agent; `own`: own API key; `gateway`: billed API transport; `endpoint`: local API; `native`: official signed-in vendor client, never subscription-as-API. */
  kind: 'own' | 'gateway' | 'endpoint' | 'native' | 'agent';
  provider: 'anthropic' | 'openai' | 'vercel' | 'openrouter' | 'openai-compatible' | 'codex' | `acp:${string}`;
  baseUrl: string;
  model: string;
  /** For people: which route, which model, who bills it. */
  label: string;
  /** A secrets handle, resolved only when a request is sent; never the value. Null for a keyless local endpoint. */
  credential: string | null;
}

export interface TurnRequest {
  /** The job's own instructions, in place of the engine's general ones. */
  system?: string;
  threadId: string;
  turnId: string;
  text: string;
  /**
   * Earlier turns of the thread, oldest first, as plain text, as they stood when the turn started. When
   * `recall` gives a `history`, that one is sent instead: it is what may still be sent at that moment.
   */
  history: { role: 'user' | 'assistant'; text: string }[];
  /** Prior engine summaries are candidates only: the engine must match their exact allowed prefix. */
  compactions?: import('../api-conversation.ts').EngineCompaction[];
  /** Names of the files the person attached to this message. */
  attachments: string[];
  effort: 1 | 2 | 3 | 4 | 5;
  /** True when a crash cut this turn short and it starts again. */
  resumed: boolean;
  /** A read-only reviewer: an engine offers only the tools that read. */
  readOnly?: boolean;
  /** False in shared projects: the native adapter must disable account tools at launch. */
  nativeAccountTools?: false;
  /**
   * A pure model turn (memory consolidation's judge): no tool of any kind is offered (no files, shell,
   * search, connectors, memory or children) and nothing is staged or written; only the answer comes
   * back. Sent only to an engine that declares `bare`.
   */
  bare?: boolean;
  /**
   * What this turn may be given now, read when called. An engine calls it once, at the moment it builds
   * the model input, after any staging and connecting, so a source withdrawn meanwhile is already out.
   * `history`, when present, replaces `request.history`: the same earlier turns less any answer that a
   * withdrawal since the start has reached. `instructions` are the person's and the project's own
   * words: where the engine's instructions go. `memory` is reference (remembered lines, enabled
   * skills): data beside the person's words, framed as material that cannot change what the agent may do.
   */
  recall?(): { history?: TurnRequest['history']; instructions?: string; memory?: string };
  /**
   * The send-time gate: whether every source behind this request is still allowed, read when called.
   * An engine calls it after `recall`, with no wait between it and the model request leaving (Codex
   * before `turn/start`, Pi in the fetch of its first request, Hermes before the run is created).
   * Anything but `true` is the reason, for the person, that nothing may be sent: the engine sends
   * nothing and ends the turn `interrupted` with that reason as its error.
   */
  stillAllowed?(): true | string;
}

/**
 * Places under a person's home folder that hold credentials or account state. No engine and no host
 * reader goes there, except a named memory or skills folder the person's own agents keep inside one.
 */
export const CREDENTIAL_PATHS = Object.freeze(['.ssh', '.aws', '.azure', '.gnupg', '.config', '.netrc', '.docker', '.kube', '.codex', '.claude',
  '.npmrc', '.pypirc', '.git-credentials', '.gitconfig', '.zsh_history', '.bash_history', '.local/share', 'Library/Keychains',
  'Library/Application Support', 'Library/Cookies', 'Library/Containers', 'Library/Group Containers', 'Library/Mail', 'Library/Messages',
  // MCP servers' own OAuth token caches: workspace-mcp (Gmail) and mcp-remote.
  '.google_workspace_mcp', '.mcp-auth']);
/** Variables that move an MCP server's OAuth token cache elsewhere: workspace-mcp's two and mcp-remote's. */
export const CREDENTIAL_DIR_VARIABLES = Object.freeze(['WORKSPACE_MCP_CREDENTIALS_DIR', 'GOOGLE_MCP_CREDENTIALS_DIR', 'MCP_REMOTE_CONFIG_DIR']);
/** Values of those variables that cannot be denied as one exact folder (relative, or holding a quote, backslash or control character). */
export const unsupportedCredentialDirs = (env: Record<string, string | undefined>): string[] =>
  CREDENTIAL_DIR_VARIABLES.filter((n) => typeof env[n] === 'string' && (!env[n]!.startsWith('/') || /["\\\x00-\x1f]/.test(env[n]!)));
/** Every credential place for a home and an environment: the fixed list under the home, and any absolute folder those variables name. */
export function credentialLocations(home: string | undefined, env: Record<string, string | undefined>): string[] {
  const trim = (p: string) => p.replace(/\/+$/, '') || '/';
  return [
    ...(home && home.startsWith('/') ? CREDENTIAL_PATHS.map((p) => `${trim(home)}/${p}`) : []),
    ...CREDENTIAL_DIR_VARIABLES.map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.startsWith('/')).map(trim),
  ];
}

export interface TurnContext {
  tools: ToolHost;
  route: ModelRoute;
  /** Resolves the route's credential at request time, inside the adapter only. */
  credential(handle: string): Promise<string>;
}

/** Optional item snapshot; null phase means unknown, never inferred from punctuation. */
export interface HarnessMessage {
  id: string;
  phase: 'commentary' | 'partial_answer' | 'final_answer' | null;
  text: string;
  complete: boolean;
}

export type HarnessEvent =
  | { type: 'compaction'; compaction: import('../api-conversation.ts').EngineCompaction }
  | { type: 'text'; delta: string; /** Full item snapshot, authoritative over concatenated deltas. */ message?: HarnessMessage }
  /** Authoritative ordered complete message set; an empty set clears a provisional answer. */
  | { type: 'messages'; messages: HarnessMessage[] }
  | { type: 'tool'; phase: 'proposed' | 'done' | 'failed' | 'refused' | 'unknown'; tool: string; label: string; id?: string; /** Native server reports this call cannot change its account. */ readOnly?: boolean; /** Command, exit status or refusal evidence, never a canonical effect receipt. */ detail?: string; denied?: { kind: 'macos-protected-folder'; folder: 'Desktop' | 'Documents' | 'Downloads' } }
  | { type: 'usage'; input: number; output: number };

export interface TurnOutcome {
  /** Provider's terminal reason; missing means the stream gave no normal completion. */
  finishReason?: string;
  status: 'done' | 'failed' | 'interrupted';
  answer: string;
  /** Why it failed, for people; never a credential. */
  error?: string;
  usage: { input: number; output: number };
}

/**
 * What became of words handed to a running turn. DELIVERED needs the engine's own confirmation;
 * NOT_DELIVERED is as firm a statement. Anything less is UNKNOWN, which is never delivered and never resent.
 */
export type SteerOutcome = { outcome: 'DELIVERED' } | { outcome: 'NOT_DELIVERED'; detail: string } | { outcome: 'UNKNOWN'; detail: string };

export interface HarnessTurn {
  events: AsyncIterable<HarnessEvent>;
  /** Add the person's words to the running turn. Nothing says whether they arrived: see `deliver`. */
  steer(text: string): void;
  /** Add the words and say what became of them. Offered only by an engine that can tell (`HarnessV1.steers`). Settles by the end of the turn. */
  deliver?(text: string): Promise<SteerOutcome>;
  /** Stop the turn. A write already dispatched becomes UNKNOWN; nothing is resent. */
  stop(): void;
  outcome: Promise<TurnOutcome>;
}

export interface HarnessV1 {
  readonly specificationVersion: 'v1';
  readonly id: string;
  /** Names the engine and its version, for the turn's work block. */
  readonly label: string;
  /** Its turns offer `deliver`. Without it no message reaches a running turn; it can only wait. */
  readonly steers?: true;
  /** It can run a bare turn (TurnRequest.bare): one offered no tool at all. */
  readonly bare?: true;
  /**
   * A client catalog is not proof of account entitlement; a completed turn establishes access. An engine
   * that reaches models through a route lists what that route serves, with its credential resolved here.
   */
  listModels?(route?: ModelRoute, credential?: (handle: string) => Promise<string>): Promise<{ id: string; label: string; efforts: (1 | 2 | 3 | 4 | 5)[] }[]>;
  start(request: TurnRequest, context: TurnContext): HarnessTurn;
}

export { scrubKnownCredentials } from './redaction.ts';
export { HOST_TOOLS, offeredHostTools, type HostToolName } from './host-tools.ts';
