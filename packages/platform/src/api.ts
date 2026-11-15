import type { SchedulePin, ScheduleTimePin } from './api-schedules.ts';
export type { SchedulePin, ScheduleTimePin } from './api-schedules.ts';
import type { ThreadControlMethods } from './api-thread-control.ts';
export type { AgentRoleListing } from './api-agent-roles.ts';
import type { PolicyView } from './policy/visibility.ts';
import type { IdentityMethods } from './api-identity.ts';
export type { PersonRole, ProjectAccess, WorkspacePerson, IdentityView, AutomationIdentity } from './api-identity.ts';
import type { WakeGate, WakeGateState, SignedWebhook, TriggerIngress, ExternalTriggerAuthority } from './api-proactivity.ts';
export type { WakeGate, WakeGateState, SignedWebhook, TriggerIngress, ExternalTriggerAuthority } from './api-proactivity.ts';
export { redactWakeGates } from './api-proactivity.ts';
import type { EngineCompaction } from './api-conversation.ts';
export type { EngineCompaction } from './api-conversation.ts';
import type { ModelRouteView } from './api-models.ts';
export type { ModelRouteView } from './api-models.ts';
// The `api` port the thread app consumes: projections in, commands out, receipts back.
// Aligned with docs/contracts/work-material.md and packages/surfaces/app/CONTRACT.md.
// Types, constants and pure reference-data formatting the surfaces may use.
// The stub behind it (src/stub) is replaced by S1-02's core without changing this file.
import type { Selection, TaskNeeds } from './selection/choose.ts';
import type { Verification } from './selection/verify.ts';
export type { DeliverableCheck, Verification } from './selection/verify.ts';
export type { Capability, Option, Route, Selection, Spend, TaskNeeds } from './selection/choose.ts';

export type { AuditOptions, AuditExport, AuditRequest, AuditPage } from './audit.ts';
import type { AuditRequest, AuditPage } from './audit.ts';

export type { ConnectorTool, ConnectorServer, HeldCall, ConnectorEffectAnswer, ConnectorEffectResolution, ConnectorEffectQuestion, ConnectorsView } from './api-connectors.ts';
export { CONNECTOR_CATALOGUE, catalogueScopes } from './api-catalogue.ts';
export type { CatalogueApp, CatalogueId, CataloguePreset, CatalogueEntry, CatalogueConnection, CatalogueDisconnect } from './api-catalogue.ts';
import type { ConnectorServer, HeldCall, ConnectorsView } from './api-connectors.ts';

export type { GoalRun } from './api-goals.ts';
import type { GoalRun } from './api-goals.ts';
export type { MemorySource, MemoryTrust, MemoryEntry, MemoryJudged, MemoryChange, TurnMemory, Skill, PluginPart, SkillMerge, SkillLearning, CuratorReport, MemoryView, MemoryRoute, MemoryImportResult } from './api-memory.ts';
import type { MemoryTaskSettings, SkillControlMethods, MemoryEntry, TurnMemory, Skill, PluginPart, SkillLearning, CuratorReport, MemoryView, MemoryRoute, MemoryImportResult } from './api-memory.ts';
export type { SkillChange } from './api-memory.ts';

export { memoryReferenceText, memoryReferenceJson } from './memory/visible.ts';

export type Id = string;

/** Every command returns a receipt. A refusal names its reason; UNKNOWN is never success. */
export type Receipt<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RefusalReason; detail: string; outcome: 'REFUSED' | 'UNKNOWN' };

export type RefusalReason =
  | 'NOT_FOUND'
  /** This exact project-creation intent has a recorded terminal preparation failure. */
  | 'PROJECT_CREATE_FAILED'
  | 'STALE_BASE'
  | 'SIDE_CHAT_READ_ONLY'
  | 'UNKNOWN_OUTCOME_HELD'
  | 'NOT_A_REPOSITORY'
  | 'NOT_AVAILABLE'
  | 'INVALID'
  /** A child tried to start a child: delegation stops at depth one. */
  | 'DEPTH_LIMIT'
  /** A child asked for more than its parent has; the detail names the axis. */
  | 'WIDER_THAN_PARENT'
  /** Nothing was done: the owner has no model for shared work, which this needs (Settings › AI and models › Shared work). */
  | 'SHARED_WORK_REQUIRED';

// ---- Projections -----------------------------------------------------------

export type ProjectKind = 'folder' | 'git';
export interface Project {
  id: Id;
  name: string;
  kind: ProjectKind;
  createdAt: string;
  /** Absent on older data folders means active. Archiving changes visibility only. */
  archived?: boolean;
  /** Display hint computed by Host; every update still checks live ownership. */
  canUpdate?: boolean;
  /** Present on authenticated shared-project projections; enforced by Host, not the UI. */
  access?: import('./api-identity.ts').ProjectAccess;
}

export interface ThreadSummary {
  /** Authenticated conversation projection: live project permission and ownership, never authority. */
  access?: 'viewer' | 'editor';
  id: Id;
  projectId: Id;
  title: string;
  pinned: boolean;
  unread: boolean;
  /** A manual section name; absent means the project's default list. */
  section?: string;
  parentId?: Id;
  /** Set on a child thread. */
  childRole?: ChildRole;
  archived: boolean;
  running: boolean;
  /** Derived recovery state, never permission to resume or retry an effect. */
  recoveryHold?: { turnId: Id; kind: 'inspection' | 'awaiting-decision' | 'recovering' };
  updatedAt: string;
}

export type Permission = 'ask' | 'auto-review' | 'full';
export type RunsOn = 'this-computer' | 'cloud';
export type Effort = 1 | 2 | 3 | 4 | 5;
export interface TurnSettings extends MemoryTaskSettings {
  permission: Permission;
  model: string;
  effort: Effort;
  runsOn: RunsOn;
  mode: 'chat' | 'plan';
}

export interface FileLink {
  materialId: Id;
  name: string;
  version: number;
}

export type EffectOutcome = 'DONE' | 'REFUSED' | 'UNKNOWN';
export interface EffectRecord {
  key: string;
  kind: 'write-working-copy';
  target: string;
  outcome: EffectOutcome;
  detail?: string;
  /** For a DONE write: the exact document version it made, and the sha256 of that version's content, so a later check reads that version and not whatever is there now. */
  materialId?: Id;
  version?: number;
  sha256?: string;
}

export type ProtectedFolderDenial = { kind: 'macos-protected-folder'; folder: 'Desktop' | 'Documents' | 'Downloads' };

export interface WorkStep {
  /** Observation time for possible-write native activity or an unknown outcome; inspection uses the turn start for other or older steps. */
  at?: string;
  kind: 'read' | 'search' | 'list' | 'write' | 'note';
  label: string;
  denied?: ProtectedFolderDenial;
}

export interface UnknownCheckQuestion { revision: string; steps: { label: string; at: string }[] }
export interface UnknownCheck extends UnknownCheckQuestion { by: Id; byName?: string; at: string }
export interface UnknownCheckInput { threadId: Id; turnId: Id; revision: string }
export const unknownCheckConfirmation = (app: string): string => `Mark as checked? ${app} will not repeat this action; continuing may ask the assistant to try again.`;

export interface Turn {
  /** A shared carrier remains required during recovery, even for a device-owner session. */
  sharedEngine?: 'harness-pi';
  /** A recovery admission result, separate from the original turn and its receipts. */
  recoveryAttempt?: { detail: string; at: string };
  /** Submission identity for read-only reconciliation; never a send instruction. */
  clientKey?:string;
  /** Owner inspection, never success. The journal owns this durable acknowledgement. */
  unknownChecked?: UnknownCheck;
  /** Read projection: false when later evidence invalidated the retained inspection. */
  unknownCheckedCurrent?: boolean;
  /** Derived local person-side offer; never authority for an engine. */
  unknownCheck?: UnknownCheckQuestion;
  /** Observed native call that may have changed an account; read-only calls never set this. */
  nativeAccountActivity?: true;
  /** An engine or connector reported an uncertain action; restarting never clears it. */
  unknownOutcome?: true;
  /** Exact connector effects plus any uncertainty without a reconcilable identity. */
  unknownEvidence?: { connectorEffects: Id[]; other?: true };
  /** Original turn of a person-requested restart; retained with its admission receipt. */
  restartOf?: Id;
  externalTrigger?: ExternalTriggerAuthority;
  id: Id;
  side: boolean;
  /** A side question's caller-supplied operation identity, retained across a lost response. */
  sideClientKey?: string;
  /** Durable identity of the separate Core task, its scope and the registered piece that may recover it. */
  sideRun?: { version: 1; threadId: Id; projectId: Id; turnId: Id; taskId: Id; pieceId: Id; scope: 'read-only'; routeDigest: string; queueIntent?: true; runId?: Id };
  /** The Core run may still need settlement; the question must never be resent automatically. */
  sideRecoveryPending?: boolean;
  /** Derived person-side offer for retained recovery data; a revision token, never authority. */
  recovery?: { revision: string; detail: string };
  /** A source it read was withdrawn while it worked, so its answer is not replayed to later turns. */
  withheld?: boolean;
  /** What it read or was given as history, and how many withdrawals each source had then. On disk before the text is handed over. */
  reads?: { id: Id; name: string; version: number; withdrawals: number; /** Staged copy: available to the engine, opening not observed. Still a full dependency. */ available?: true; inherited?: boolean; /** Came with something it was told. Its source version stays dead once withdrawn, restored or not. */ told?: boolean }[];
  /** Its work ran to the end. Recovery calls a turn done only with this on disk, however its writes came out. */
  completed?: boolean;
  /** What it was given from memory and what it left there. */
  memory?: TurnMemory;
  /** A goal check: the judge's verdict on the work against the goal. An assessment, never authority. */
  judge?: { verdict: 'met' | 'not-met' | 'blocked' | null; detail: string };
  /** The person stopped it. Written before Stop is acknowledged, so recovery honours it after a kill. */
  stopRequested?: boolean;
  /** A kill cut it short and the host carried it on after the restart. A run it belongs to that it did not finish is marked interrupted, not stopped. */
  interrupted?: boolean;
  /** Its words are an agent's brief to a child: told through the chokepoint, never replayed as history. */
  brief?: 'agent';
  /** The children's reports this turn received: their reads count as its own. */
  handovers?: { threadId: Id; turnId: Id }[];
  /** What the person added while it ran, and what became of each. */
  steers?: TurnSteer[];
  /** This turn called no model: it is the person bringing a worker's document into this thread. */
  merge?: TurnMerge;
  /** It was given a turn with no read set, so it counts as having read every source then in the project. */
  unknownSources?: boolean;
  /**
   * The sources behind words the host wrote into this turn's own text (a goal run's goal and the last
   * check's finding, a schedule's goal), by source version. They are among its told reads, so the
   * send-time gate checks them, and its text leaves history once any of them is withdrawn.
   */
  textSources?: { id: Id; name: string; version: number; withdrawals: number }[];
  /** Recovered documents whose classification against withdrawals failed; the next start retries. */
  unclassified?: FileLink[];
  user: { text: string; attachments: FileLink[]; settings?: TurnSettings; at: string };
  work: {
    startedAt: string;
    endedAt?: string;
    steps: WorkStep[];
    harness: string;
    /** Ordered carriers used by this turn, including its original route on recovery. No endpoint or key is exposed. */
    carriers?: { engine: string; fingerprint: string; model: string; label: string; shared: boolean }[];
    /** Provider's finish reason; an unfinished answer is never a done turn. */
    finishReason?: string;
    /** Counts reported by the harness, not subscription balance or money spent. */
    usage?: { input: number; output: number };
    compactions?: EngineCompaction[];
  };
  answer?: { text: string; files: FileLink[] };
  refusal?: { reason: RefusalReason; detail: string };
  /** Why its engine could not finish, in the route's own words (a status code first where it gave one). */
  failure?: { detail: string };
  effects: EffectRecord[];
  status: 'running' | 'done' | 'stopped' | 'refused';
  /**
   * Its task's chosen route: set by solution selection, carried to the person's ordinary follow-ups in
   * the chat, and recorded by a goal run for each of its turns. What it ran on is what was chosen, or it did not run.
   */
  selection?: TurnSelection;
}

/** A model route as a turn records it: where requests go and which model; never a credential. */
export interface RouteRecord { kind: 'own' | 'gateway' | 'endpoint' | 'native' | 'agent'; provider: string; baseUrl: string; model: string; label: string; fingerprint?: string }

/**
 * The task's constraints, the route chosen for it and why, the concrete route pinned at the choice, and
 * the dispatch route recorded at the send gate (absent until dispatch; never copied to another turn).
 * This is not an independent observation of which model served an ACP or Codex request.
 */
export interface TurnSelection { task: TaskNeeds; routeId: string; reasons: string[]; pinned: RouteRecord; ran?: RouteRecord; /** The whole selection the choice was made from, answered again to a repeated request with the same key. Only on the turn solutions.run started. */ options?: Selection; /** A goal run's own turn, on the choice the run recorded: never the chat's choice for a later follow-up. */ origin?: 'goal-run' }

/**
 * The chosen route a caller was shown a write would continue on: `null` when it was shown none. Admission
 * refuses the write when the route it would take differs, so what runs is what was allowed.
 */
export type ShownSelection = Pick<TurnSelection, 'task' | 'routeId' | 'pinned'> | null;

export interface ThreadCard {
  project: string;
  changes: { added: number; removed: number; files: number };
  subagents: { active: number; done: number };
  sources: FileLink[];
}

export interface Thread {
  /** Earlier branches and their receipts remain readable after a rewind. */
  rewinds?: import('./api-rewind.ts').RewindRecord[];
  rewindPending?: import('./api-rewind.ts').RewindRecord;
  summary: ThreadSummary;
  turns: Turn[];
  sideTurns: Turn[];
  card: ThreadCard;
  /** What this work is for; a child shows its parent's. Absent until a goal is set or proposed. */
  goal?: GoalState;
  /** Set on a child thread: where its authority comes from. */
  child?: ChildLink;
  /** This thread's children, with each one's report once it has one. */
  children?: ChildView[];
  /** The conversation this one was copied from. */
  forkedFrom?: { threadId: Id; turnId?: Id };
  /** The goal running until it is met, when one does. */
  goalRun?: GoalRun;
  /** Messages waiting for the running turn to finish, oldest first. */
  queue?: QueuedMessage[];
  /** Why the queue is waiting for the person rather than for the turn. `queue.send` is their answer. */
  queueHeld?: string;
  /** Whether a message can reach this thread's running turn, on this engine. */
  steering?: { available: boolean; detail?: string };
  /** Set when a reviewer cannot run here, with why, before the person asks for one. */
  reviewer?: { available: false; detail: string };
}

// ---- Talking to work while it runs -----------------------------------------

/** A message that waits for the turn to end. It is the person's until it becomes a turn; then it is gone from here, once. */
export interface QueuedMessage {
  id: Id;
  text: string;
  attachments: FileLink[];
  settings: TurnSettings;
  /** The chosen route it was allowed to continue on, when it was added with one shown; it is sent on that route or not at all. */
  continues?: ShownSelection;
  /** Moves with every edit, so a change made on a stale view is refused. */
  version: number;
  at: string;
  /** Why the last attempt to send it did not start. It stays queued. */
  problem?: string;
  /** It was steered at a turn that ended before taking it. */
  fromSteer?: boolean;
}
/**
 * `sending`: handed to the engine, no answer yet. `delivered`: the engine confirmed the model took it.
 * `not-delivered`: the engine confirmed it did not; the words went back to the queue.
 * `unknown`: neither could be confirmed. Never counted as delivered, and never resent by itself.
 */
export type SteerState = 'sending' | 'delivered' | 'not-delivered' | 'unknown';
export interface TurnSteer { id: Id; text: string; at: string; state: SteerState; detail?: string; /** A peer's words (message_card), not the person's: never replayed as theirs, never requeued as a turn. */ peer?: true }

// ---- Parallel work: goals, children and handover ----------------------------

/** The goal in force. Only a person sets one; an accepted proposal is the person's act. */
export interface Goal { text: string; by: 'person'; at: string; fromProposal?: Id; /** What the proposal's turn had read: its words leave later turns if one is withdrawn. */ reads?: NonNullable<Turn['reads']> }
/** An agent's proposed change: on the record, and changing nothing until the person accepts it. */
export interface GoalProposal {
  id: Id;
  text: string;
  by: 'agent';
  threadId: Id;
  turnId: Id;
  at: string;
  state: 'open' | 'accepted' | 'declined';
  decidedAt?: string;
  reads?: NonNullable<Turn['reads']>;
}
/** One entry of a goal's history, which is never shortened. */
export interface GoalChange { action: 'set' | 'cleared' | 'accepted' | 'declined'; text: string; by: 'person'; at: string; proposalId?: Id }
/** `version` moves with every change, so a decision made on a stale view is refused. */
export interface GoalState { current: Goal | null; version: number; proposals: GoalProposal[]; history: GoalChange[] }

/** `reviewer` is read-only: its mandate holds no operation and it is given no tool that acts. */
export type ChildRole = 'worker' | 'reviewer';
export interface AgentRole {
  name: string;
  description: string;
  model: string;
  tools?: string[];
  instructions: string;
  markdown: string;
  digest: string;
}

export interface ChildLink {
  /** Snapshot at admission: later edits affect future helpers only. */
  agentRole?: Pick<AgentRole, 'name' | 'digest' | 'tools'>;
  parentThreadId: Id;
  /** The parent turn that started it; absent when the person did. */
  parentTurnId?: Id;
  role: ChildRole;
  startedBy: 'person' | 'agent';
  /** Its ceiling: never above its parent's when it started. `model` is the one it was admitted on. */
  settings: TurnSettings;
  /** Present when a model was asked for: the choice made at admission, never changed after. */
  model?: ChildModel;
  /** The thread a reviewer reviews. */
  reviews?: Id;
  /** What does not bind this child, for the person to see. */
  notEnforced?: NotEnforced[];
  at: string;
}
/**
 * How a child's model was chosen, once, at admission: the models asked for in order, each one passed
 * over with why, and the one its turns run on. Nothing falls back after a turn has begun.
 */
export interface ChildModel {
  asked: string[];
  ran: string;
  passedOver: { model: string; detail: string }[];
}
/** A limit that is stated, not enforced: shown to the person and never to be presented as a guarantee. */
export interface NotEnforced { axis: 'permission' | 'token-budget'; detail: string }
/** What a child's turn came to. Its text is data for the parent, never an instruction or a permission. */
export interface Handover {
  threadId: Id;
  turnId: Id;
  role: ChildRole;
  /** `unknown` whenever any receipt is UNKNOWN: such work is never reported as done. */
  status: 'done' | 'stopped' | 'refused' | 'unknown';
  /** Empty, with `withheld`, once a source it had was withdrawn. The receipts stay. */
  text: string;
  withheld?: boolean;
  files: FileLink[];
  receipts: EffectRecord[];
  reads: { id: Id; name: string; version: number }[];
  /** Counts reported by the harness, not subscription balance or money spent. */
  usage?: { input: number; output: number };
  /** The engine and route it ran on, which say who bills it. */
  harness: string;
  at: string;
}
/**
 * A document a worker made, as the parent can take it. `ready`: its version is the document's current
 * one. `stale`: the document moved on, so it can only land beside it. `merged`: already brought back.
 * `blocked`: `detail` says why, and nothing can be taken.
 */
export interface ChildDocument {
  materialId: Id;
  name: string;
  /** The version the worker made. */
  version: number;
  /** The document's current version: `children.merge` takes this as `baseVersion`. */
  current: number;
  /** Who made the current version. */
  by: 'person' | 'agent';
  state: 'ready' | 'stale' | 'merged' | 'blocked';
  detail?: string;
  /** The parent's turn that brought it back. */
  mergedIn?: Id;
}
/** What a merge turn took and how. The worker's receipts and reads stay with it. */
export interface TurnMerge {
  threadId: Id;
  turnId: Id;
  materialId: Id;
  name: string;
  version: number;
  /** `adopted`: taken as it stands, no version made. `beside`: kept as a new document, the original untouched. */
  outcome: 'adopted' | 'beside';
  beside?: { name: string; document: Id };
  receipts: EffectRecord[];
  reads: { id: Id; name: string; version: number }[];
}
export interface ChildView {
  threadId: Id;
  title: string;
  role: ChildRole;
  startedBy: 'person' | 'agent';
  settings: TurnSettings;
  /** The model its turns run on, and any fallback taken at admission. */
  model: ChildModel;
  running: boolean;
  /** Unresolved UNKNOWN outcomes across all of its turns. */
  unknown: number;
  notEnforced?: NotEnforced[];
  handover?: Handover;
  /** What the parent can bring back, one document at a time. */
  documents?: ChildDocument[];
}

/** original = bytes as attached; working = agent-written; accepted = the person saved it. */
export { isCutOffFinish } from './completion.ts';
export { terminalModelHint, settingsModelHint } from './model-setup.ts';

export type MaterialClass = 'original' | 'working' | 'accepted';
export interface MaterialVersion {
  n: number;
  by: 'person' | 'agent';
  at: string;
  bytes: number;
  sha256: string;
}
export interface MaterialEntry {
  /** Local rewind recovery identity; never a Core receipt. */
  rewindOperation?: string;
  id: Id;
  projectId: Id;
  name: string;
  mediaType: string;
  class: MaterialClass;
  /** Intermediates are hidden, never deleted. */
  hidden: boolean;
  versions: MaterialVersion[];
  current: number;
  /** Set when the last Save did not finish; the current version is still `current`. */
  interruptedSave?: { version: number; at: string };
  /** App-managed documents have no automatic external filesystem projection. */
  projection?: 'managed';
  /** Host-assigned identity of a person's explicit structured original. Its path is data,
   * never permission to project a file or load instructions. Absent on legacy/server sources. */
  source?: { kind: 'person'; path: string };
  /** Host-assigned archive provenance. Historical version authors never establish Core trust. */
  restored?: true;
  /** The person said this is not temporary output. */
  kept?: boolean;
  /** Each time the person withdrew this original, and when they restored it. Never shortened. */
  withdrawals?: {
    at: string;
    version: number;
    restoredAt?: string;
    /** Composition-owned delivery receipts, not source authority or proof of Core's current state.
     * Only the exact event and workspace match. Archive restore never imports these as grants. */
    coreAcknowledgements?: { event: string; workspace: string; receipt: string; at: string }[];
    /** Composition-owned terminal Core conflicts, never authority or acknowledgement. An exact
     * conflict keeps delivery UNKNOWN and refuses automatic confirmation, including after restore. */
    coreConflicts?: { event: string; workspace: string; at: string }[];
  }[];
  /** A move in or out of the project folder that a kill may have interrupted, and the file it is for. */
  projecting?: 'in' | 'out' | 'rewind';
  folderSha?: string;
  /** A different file is at this path in the folder; it was left alone. Keep clears this. */
  folderConflict?: boolean;
  /** May carry this withdrawn source and could not safely be held, or (`interrupted`) came from a turn cut short and may be incomplete. Only Keep clears this; a Save does not. */
  unsure?: { id: Id; name: string; interrupted?: boolean };
  /** Moves with every lifecycle change, so a decision made on a stale view is refused. Absent is 0. */
  lifecycle?: number;
  /** Made by a turn that had this withdrawn source: out of later work's reach until the person decides. */
  held?: { id: Id; name: string; changed?: boolean };
  /** Local inspection data from an unimported checkpoint, never an authorised output or agent input. */
  recovery?: { turnId: Id; reason: string };
  /** What a connected server answered, kept as a source: a later read is recorded as that server's answer again, untrusted and as private as the connection. */
  fromServer?: { connection: Id; tool: string };
  /** Host-owned connector observation history. Pending bytes are withheld from agent inputs;
   * registered records preparation history only, never current source authority or delivery. */
  observation?: { id: string; state: 'pending' | 'registered' };
}

export interface WorkNowDocument { id: Id; name: string; version: number; lifecycle: number; by: 'person' | 'agent'; at: string }
/** What a person is told about withdrawing: it ends later access and is not a purge. */
export const WITHDRAWAL_WORDS = 'Later work will not receive this document. A turn already running may have received it: what that turn makes from then on is held for you. Text already given to a model, or copied by a person or into a finished document, cannot be recalled. Every version is kept here and nothing is purged.';
/** What matters now in a project, computed on request. */
export interface CapabilityNotice {
  code: 'knowledge-source-guard' | 'material-withdrawal-pending' | 'material-withdrawal-conflict';
  message: string;
  materialId?: Id;
}
/** Explicit person choice on retained connector history, never a provider operation. */
export interface ConnectorReadResolution {
  id: Id;
  state: 'reconciled' | 'discarded';
  registration: 'confirmed' | 'unknown';
  runClosed: boolean;
}
export interface WorkNow {
  /** Capability notices, independent of documents and decisions that need a person. */
  notices?: CapabilityNotice[];
  running: { threadId: Id; title: string }[];
  needsYou: { kind: 'unknown' | 'stopped' | 'interrupted-save' | 'held' | 'unsure' | 'goal' | 'connector' | 'connector-read'; threadId?: Id; materialId?: Id; observationId?: Id; canReconcile?: boolean; version?: number; lifecycle?: number; proposalId?: Id; /** The item is a child's; this is its parent. */ parentThreadId?: Id; title: string; detail: string }[];
  progress: { threadId: Id; title: string; line: string; at: string }[];
  /** Documents in use, the person's own first. */
  current: WorkNowDocument[];
  temporary: WorkNowDocument[];
  retired: WorkNowDocument[];
  /** `mayCarry`: documents still in use from turns that read it. */
  withdrawn: (WorkNowDocument & { withdrawnAt: string; mayCarry: string[] })[];
}

export interface ProjectFile {
  /** Current material version and author, not the last saved ancestor's acceptance. */
  current?: number; by?: 'person' | 'agent'; personSaved?: number; managed?: boolean;
  /** Workspace-relative file path, or a managed document's name. Display groups are separate. */
  path: string;
  group?: 'files' | 'documents';
  class: MaterialClass | 'unregistered';
  materialId?: Id;
}

export type ChangeScope = 'last-turn' | 'uncommitted' | 'unstaged' | 'staged' | 'committed' | 'branch';
export const CHANGE_SCOPES: ChangeScope[] = ['last-turn', 'uncommitted', 'unstaged', 'staged', 'committed', 'branch'];
export interface FileChange {
  path: string;
  added: number;
  removed: number;
  patch: string;
}
export interface Changes {
  scope: ChangeScope;
  base: string;
  bases: string[];
  files: FileChange[];
}

export interface Draft {
  /** Monotonic per-key revision, including an empty tombstone. */
  revision: number;
  key: string;
  text: string;
  meta?: Record<string, string | number>;
  updatedAt: string;
}

export interface ModelChoice {
  id: string;
  label: string;
  efforts: Effort[];
  permissions?: readonly Permission[];
}

/** Model settings as the app sees them: which routes are set and which is active, never a key. */
export type OwnProvider = 'anthropic' | 'openai' | 'openai-compatible';
export type GatewayProvider = 'vercel' | 'openrouter';
/** A model server on this computer. It is keyless and reached on the loopback only. */
export type LocalProvider = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'other';
export const LOCAL_RUNTIMES: Record<LocalProvider, { name: string }> = {
  ollama: { name: 'Ollama' },
  lmstudio: { name: 'LM Studio' },
  llamacpp: { name: 'llama.cpp' },
  vllm: { name: 'vLLM' },
  other: { name: 'Local server' },
};
/** What runs on this computer's usual model ports, found by reading each server's /v1/models. */
export interface LocalModels {
  runtimes: { provider: Exclude<LocalProvider, 'other'>; name: string; baseUrl: string; models: string[] }[];
}
export interface ModelSettings extends AcpModelSettings {
  /** Explicit Pi route for colleagues and named automations. */
  shared?: Omit<ModelSettings, 'shared'>;
  own: { provider: OwnProvider; model: string; keySet: boolean; baseUrl?: string } | null;
  gateway: { provider: GatewayProvider; model: string; keySet: boolean } | null;
  /** A model running on this computer, chosen in Settings. No key. */
  local?: { provider: LocalProvider; baseUrl: string; model: string } | null;
  /** Said once, after a local choice is saved: the address used and whether the server lists the model. */
  localNote?: string;
  /** The route the next turn will use, or null with `hint` saying what to do. */
  active: ModelRouteView | null;
  hint: string | null;
  /** Present only for a selected native engine; no API key is imported or read. */
  native?: { provider: 'codex'; model: string };
  /** The engine turns run on. */
  harness: string;
}
/** One engine a person may choose in Settings, and whether it can run on this computer. */
export interface EngineOption {
  id: string;
  /** The short name `settings.engine.put` and `backbone engine` take. */
  name: 'pi' | 'codex' | 'acp' | 'stub';
  label: string;
  /** What changes with this engine, in one sentence. */
  about: string;
  /** Refused: managed policy does not allow it, so it is not offered. */
  state: 'available' | 'unavailable' | 'refused';
  /** Why it is unavailable or refused, in words the person can act on. */
  reason?: string;
}
/** The engines for this data folder. A choice is saved with `settings.engine.put` and applies when the app next starts. */
export interface EngineChoices {
  /** The engine this process runs on now. */
  running: string;
  /** The engine the next start will use, or null when the managed policy refuses the saved choice. */
  next: string | null;
  /** The engine saved for this data folder, or null when none is saved. Differs from `next` when the launch environment fixes the engine. */
  stored: string | null;
  /** BACKBONE_HARNESS is set for this process, so a saved choice does not apply while it is. */
  environment: boolean;
  options: EngineOption[];
}
/** The routes a person can choose, in policy order: their own key first, then a gateway. */
export const ROUTE_CHOICES = {
  anthropic: { route: 'own', name: 'Anthropic API (your key)', model: 'claude-sonnet-5-5', bills: 'billed by Anthropic to your key' },
  openai: { route: 'own', name: 'OpenAI API (your key)', model: 'gpt-5.5', bills: 'billed by OpenAI to your key' },
  'openai-compatible': { route: 'own', name: 'OpenAI-compatible endpoint (your key)', model: '', bills: 'billed by that endpoint to your key' },
  vercel: { route: 'gateway', name: 'Vercel AI Gateway', model: 'anthropic/claude-sonnet-5.5', bills: 'billed by Vercel to your gateway key, at provider prices' },
  openrouter: { route: 'gateway', name: 'OpenRouter', model: 'anthropic/claude-sonnet-5.5', bills: 'billed by OpenRouter to your credits, with its fee' },
} as const;
export { ACP_CLAUDE_PRESET, ACP_PROCESS_VISIBILITY_WARNING } from './api-acp.ts';
export type { AcpAgentConfiguration, AcpAgentDraft, AcpPrepared, AcpExecutableIdentity, AcpExecutableAcceptance, AcpSettingsChange, AcpModelSettings, MachineClientState } from './api-acp.ts';
import type { AcpSettingsChange, AcpModelSettings } from './api-acp.ts';
/** A key is pasted by the person and sealed at once; it is never read back. */
export type ModelSettingsChange =
  | { route: 'shared'; change: ModelSettingsChange }
  | AcpSettingsChange
  | { route: 'native'; provider: 'codex'; model: string }
  | { route: 'own'; provider: OwnProvider; model?: string; key?: string; baseUrl?: string }
  | { route: 'gateway'; provider: GatewayProvider; model?: string; key?: string }
  | { route: 'local'; provider: LocalProvider; baseUrl: string; model: string }
  | { route: 'own' | 'gateway' | 'local'; clear: true };

export interface TerminalResult {
  command: string;
  output: string;
  code: number | null;
}

/** A person's line-mode command, owned by the platform rather than an open tab. */
export interface TerminalBlock extends TerminalResult {
  id: string;
  clientKey: string;
  status: 'running' | 'succeeded' | 'failed' | 'not-known';
  cwd: string;
  startedAt: string;
  detail?: string;
  stopping?: boolean;
  saveError?: string;
  signals: string[];
  omittedBytes: number;
  omittedLines: number;
}
export interface TerminalView {
  cwd: string; commands: TerminalBlock[]; omittedCommands: number;
  /** Prefix fresh client keys with this namespace; compaction expires forgotten requests without replay. */
  historyKey?: string;
}

/** Per-viewer UI state (layout, theme, open tabs). Never durable work state. */
export interface ViewerPrefs {
  theme: 'light' | 'dark' | 'system';
  selectedThreadId?: Id;
  selectedProjectId?: Id;
  /** A page the centre shows instead of a thread or Home: the mail triage brief, Now, Scheduled or Memory. */
  view?: 'brief' | 'now' | 'scheduled' | 'memory';
  pane: { open: boolean; tabs: PaneTab[]; active?: string };
  composer?: Partial<TurnSettings>;
  /** The person has seen what Full access reaches on a new data folder (kept, changed, or a first message sent). It stays with the data folder. */
  fullAccessNotice?: 'decided';
  /** The Settings section this viewer used last, opened again when Settings opens without a named section. */
  settingsSection?: SettingsSectionId;
}
/** Every Settings section, by id. The app's list and the stored last-used section share this one set. */
export const SETTINGS_SECTIONS = ['general', 'model-route', 'agent-roles', 'connectors', 'signed-tools', 'plugins', 'ai-tools', 'people', 'sharing', 'proactive', 'backup', 'telemetry', 'notices'] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];
/** Viewer settings as stored and served: a last-used Settings section that names no section is dropped. */
export function normaliseViewerPrefs<T extends ViewerPrefs>(prefs: T): T {
  if (prefs?.settingsSection === undefined || (SETTINGS_SECTIONS as readonly unknown[]).includes(prefs.settingsSection)) return prefs;
  const { settingsSection: _dropped, ...rest } = prefs;
  return rest as T;
}
export type PaneTab =
  | { id: string; kind: 'changes' | 'files' | 'terminal' | 'side-chat' | 'browser' | 'launcher' }
  | { id: string; kind: 'file'; materialId: Id; version?: number }
  /** What one version of a document changed, against the version before it. */
  | { id: string; kind: 'diff'; materialId: Id; version: number };

export type ApiEvent = { topic: 'identity' | 'projects' | 'threads' | 'material' | 'drafts' | 'settings' | 'tools' | 'triage' | 'schedules' | 'triggers' | 'memory' | 'goals' | 'board' | 'connectors'; id?: Id; /** An emergency the person is told about at once, counted. */ urgent?: string };

// ---- AI tools connected to the MCP door ------------------------------------

/** The AI tools a person can connect to this app's MCP door from Settings. */
export type AiToolId = 'claude-code' | 'codex' | 'cursor' | 'claude-desktop';
export type AiToolState = 'not-installed' | 'disconnected' | 'connected' | 'needs-restart' | 'needs-attention';
/** What a connected tool may do through the door: the person's grant, never wider than the door declares. */
export interface ToolPermission {
  operations: string[];
  /** The highest effect class allowed without asking the person (CEILING_WORDS says it in words). */
  ceiling: number;
  expiresAt: string;
  /** The tool also asks the person before each call (the stricter setting). */
  askEachCall: boolean;
}
export interface AiTool {
  id: AiToolId;
  name: string;
  state: AiToolState;
  /** What to do next, in one plain sentence, when there is something. */
  note: string | null;
  permission: ToolPermission | null;
  /** Receipts the door has written for this tool's current permission. */
  receipts: number;
  /** An entry named `backbone` that this app did not write is in the tool's settings: it is left alone, and ours takes another name. */
  foreign: boolean;
  /** The name this app's entry has in the tool's settings, while connected (`backbone-door`, or `backbone-door-2`, … beside someone else's). */
  entryName: string | null;
  /** The app's door changed (an update): the person approves again, with one click, before it is granted anew. */
  update: boolean;
}
/** The widest permission the door declares: the defaults the card starts from. Narrowing only. */
export interface DoorOffer {
  operations: string[];
  ceiling: number;
  days: number;
}
export interface AiTools {
  /** False where this host does not manage tools (the browser bridge). */
  available: boolean;
  tools: AiTool[];
  offer: DoorOffer | null;
}
/**
 * Connecting a tool grants it a permission, so it is not an api method: no transport (IPC, HTTP)
 * carries it. Only the process that shows the person the grant and takes their click calls it
 * (Host.connectTool in the desktop app's main process). Omitted fields take the door's declared defaults.
 */
export interface ConnectTool {
  tool: AiToolId;
  operations?: string[];
  ceiling?: number;
  days?: number;
  askEachCall?: boolean;
}
/** A ceiling in plain words: how risky an action may be before the person is asked. */
export const CEILING_WORDS: Record<number, string> = { 1: 'read-only', 2: 'low risk', 3: 'medium risk', 4: 'high risk' };

// ---- Mail triage: a named job, its capability and its brief ---------------

/** What came of one of the job's acts, in the brief's words. Only DONE and DISCARDED are final for the person. */
export type BriefOutcome = 'DONE' | 'PROPOSED' | 'ACCEPTED' | 'DISCARDED' | 'REFUSED' | 'CANCELLED' | 'PENDING' | 'FAILED' | 'UNKNOWN';
/** How an act can be taken back, sized to its finality (the connector's class for mailbox changes). */
export type RecoveryClass = 'exact-undo' | 'bounded-cancellation' | 'compensation' | 'irreversible';
export const RECOVERY_WORDS: Record<RecoveryClass, string> = {
  'exact-undo': 'exact undo',
  'bounded-cancellation': 'bounded cancellation',
  compensation: 'compensation',
  irreversible: 'irreversible',
};

export interface BriefItem {
  /** The receipt: the effect's id in the core. */
  effect: string;
  kind: 'draft' | 'proposal';
  message: { id: string; from: string; subject: string };
  summary: string;
  outcome: BriefOutcome;
  recovery: RecoveryClass | null;
  /** The way back, in words. */
  undo: string | null;
  /** A confirmed inverse can be requested once by the person. */
  undoable?: boolean;
  /** A draft opens in the viewer. */
  materialId?: string;
  /** A proposal waiting for the person's accept or discard. */
  decidable: boolean;
  detail?: string;
}

export interface TriagedRequest {
  id: string;
  from: string;
  subject: string;
  requester: string | null;
  category: string | null;
  urgency: string | null;
  suspicious: boolean;
  needsYou: string | null;
  draft: BriefItem | null;
  proposal: BriefItem | null;
}

export interface Brief {
  /** What was done (drafts), what is proposed (labels and moves), and what needs the person. */
  done: BriefItem[];
  proposed: BriefItem[];
  needsYou: { message: { id: string; from: string; subject: string }; reason: string }[];
  requests: TriagedRequest[];
  counts: { requests: number; read: number; drafted: number; proposed: number; accepted: number; discarded: number; needsYou: number; unknown: number; refused: number };
  /** Why the last run ended early, if it did. */
  stopped: string | null;
}

export interface CapabilityView {
  id: string;
  version: number;
  state: 'active' | 'suspended' | 'revoked' | 'expired';
  /** The signed payload's hash, as the core recorded it. */
  hash: string;
  summary: string[];
  /** Current attenuation, separate from the immutable signed payload and its hash. */
  effectiveSummary?: string[];
  signedAt: string;
  signedWith: 'touch-id' | 'device-password';
  expiresAt: string;
  reason: string | null;
}

/** What the one screen shows before the person signs: a summary of the payload, and its hash. */
export interface CapabilityOffer {
  hash: string;
  summary: string[];
  /** Axes on which it grants more than the capability in force, if one is. */
  widening: string[];
  /** Signing again what was suspended. */
  again: boolean;
}

export interface TriageView {
  /** False where this host cannot run the job (no engine). */
  available: boolean;
  connection: { provider: string; account: string; label: string; detail: string; readOnly: boolean } | null;
  capability: CapabilityView | null;
  offer: CapabilityOffer | null;
  running: boolean;
  lastRun: { startedAt: string; endedAt: string | null; outcome: string | null; reason: string | null; handled: number } | null;
  /** The project the drafts live in, for the viewer. */
  projectId: string | null;
  /** Writes to the mailbox: gated until the door's conformance is accepted. */
  writes: 'gated' | 'open';
  brief: Brief;
}

/**
 * Signing a capability is not an api method: no transport carries it. Only the process that showed
 * the person the payload and took their Touch ID or device password (the desktop app's main) calls
 * Host.signCapability, naming the hash it showed.
 */
export interface SignCapability {
  hash: string;
  presence: 'touch-id' | 'device-password';
}

// ---- The task board and its worker pool ------------------------------------

/**
 * `todo` waits on a dependency, `ready` waits for a worker (or its backoff), `blocked` has a dependency
 * that failed or is held, `held` waits for the person: an UNKNOWN write, a Stop, or their hold.
 */
export type CardStatus = 'todo' | 'ready' | 'running' | 'done' | 'failed' | 'blocked' | 'held';
/** One worker turn a card had, and what came of it. */
export interface CardAttempt {
  threadId: Id;
  turnId: Id;
  /** `start`: a new worker; `retry`: another turn on the same worker. */
  kind: 'start' | 'retry';
  at: string;
  outcome?: 'done' | 'requeued' | 'retried' | 'failed' | 'held' | 'restarted';
  detail?: string;
}
/** A card is a brief for one worker. One the agent added is its words to weigh, never authority. */
export interface Card {
  id: Id;
  title: string;
  brief: string;
  /** Cards on the same board that must be done first. */
  dependsOn: Id[];
  /** The worker's own model and effort; the parent's when left out. */
  model?: string;
  effort?: Effort;
  status: CardStatus;
  by: 'person' | 'agent';
  /** Why it waits, is held or failed. */
  detail?: string;
  /** Held because a write's outcome is UNKNOWN or may be: it is never run again by itself. */
  unknown?: boolean;
  /** Rate limits and server errors that put it back on the board (at most 3), and retries in place (at most 1). */
  requeues: number;
  retries: number;
  /** Not taken before this time: the backoff after a rate limit or a server error. */
  notBefore?: string;
  /** The worker running it, or that last ran it. */
  threadId?: Id;
  turnId?: Id;
  attempts: CardAttempt[];
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface BoardPool {
  /** How many workers run at once: 1 to 16, 2 by default. */
  size: number;
  running: number;
  /** Why nothing new starts by itself, after a Stop of the board's chat. */
  paused?: string;
}
/** The board of a chat: its cards, and the pool of workers, each a child of that chat. */
export interface Board { threadId: Id; projectId: Id; pool: BoardPool; cards: Card[] }
/** Whether this host owns its data home, and if not, who does when that is known. */
export interface HostStatus {
  owns: boolean;
  detail?: string;
  /** The headless daemon holding the home (`backbone daemon run`), from its own record. */
  heldBy?: { kind: 'daemon'; pid: number; since: string };
}

/** A thread where every word of a search was found, and where. */
export interface ThreadHit { threadId: Id; title: string; turnId?: Id; field: 'title' | 'words' | 'answer'; snippet: string }

// ---- Proactivity -----------------------------------------------------------

/** When scheduled work is due: an RRULE subset, a five-field cron, or one moment. Local time. */
export type Rule = { kind: 'rrule'; rrule: string } | { kind: 'cron'; cron: string } | { kind: 'once'; at: string };
/** Active hours, local "HH:MM". An end before the start runs overnight; equal means all day. */
export interface Hours { start: string; end: string }

/**
 * Work the host starts on its own while the app is open: a schedule on a chat or its goal, or the one
 * heartbeat, a standing check that stays quiet unless something needs the person. Each run is a turn
 * on the one turn path, so held writes, UNKNOWN and withdrawal hold for it as for any turn.
 */
export interface Schedule {
  /** External read projections reveal that a gate exists, never its program or arguments. */
  hasWakeGate?: boolean;
  wakeGate?: WakeGate;
  id: Id;
  kind: 'schedule' | 'heartbeat';
  projectId: Id;
  /** Where its turns go; a schedule made without one gets its chat on its first run. */
  threadId: Id | null;
  /** What each run asks. Empty on a goal's schedule: each run works toward the chat's goal. */
  text: string;
  /** The person's words for when, and what they were read as. */
  when: string;
  rule: Rule;
  summary: string;
  hours?: Hours;
  settings: TurnSettings;
  paused: boolean;
  /** Why the host paused it, when it did: the person resumes it. */
  pausedBecause?: string;
  /** When its times count from, when the person was shown them before it was made; otherwise `createdAt`. */
  anchor?: string;
  /** On a goal's schedule made through the api line: the goal the person was shown. A changed goal pauses it. */
  goal?: string;
  createdAt: string;
  nextAt: string | null;
  lastRunAt: string | null;
  version: number;
}

/** quiet: a heartbeat found nothing. needs-you waits for the daily brief; an emergency does not. interrupted: the app stopped during its turn, which did not finish; it waits for the brief too. */
export type RunOutcome = 'starting' | 'running' | 'done' | 'quiet' | 'needs-you' | 'emergency' | 'stopped' | 'failed' | 'skipped' | 'interrupted';

export interface ScheduleRun {
  wakeGate?: WakeGateState;
  id: Id;
  scheduleId: Id;
  kind: Schedule['kind'];
  title: string;
  dueAt: string;
  startedAt: string;
  endedAt: string | null;
  threadId: Id | null;
  turnId: Id | null;
  outcome: RunOutcome;
  /** The answer's first lines, or why it did not run. */
  summary: string;
  /** Runs missed while the app was closed, which this one stands for. */
  caughtUp?: number;
}

export interface DailyBriefItem {
  id: Id;
  runId: Id | null;
  threadId: Id | null;
  title: string;
  detail: string;
  done: boolean;
}

/** One message a day. Each item takes at most one click. */
export interface DailyBrief { date: string; at: string; items: DailyBriefItem[] }

/** What reached the person today, counted: at most one brief, plus security or money emergencies. */
export interface Interruptions {
  date: string;
  briefs: number;
  emergencies: { at: string; runId: Id; kind: 'security' | 'money'; detail: string }[];
  /** Emergencies a run started by outside data (a webhook, a file) claimed: held for the brief, not told at once. */
  suppressed?: { at: string; runId: Id; kind: 'security' | 'money'; detail: string }[];
}

export interface Proactivity {
  schedules: Schedule[];
  heartbeat: Schedule | null;
  /** Newest first, the latest 200. */
  runs: ScheduleRun[];
  brief: { time: string; latest: DailyBrief | null };
  interruptions: Interruptions;
}

/**
 * Work that starts on an event rather than a time: a file changed in a project's folder, a webhook to
 * the loopback endpoint, or new mail in the connected mailbox. Like a schedule it is attached to a chat
 * or the chat's goal, and each run is a turn on the one turn path. Events that arrive while a run is
 * going wait, and become one follow-up run.
 */
export interface Trigger extends TriggerIngress {
  id: Id;
  kind: 'file' | 'webhook' | 'mail';
  projectId: Id;
  /** Where its turns go; a trigger made without one gets its chat on its first run. */
  threadId: Id | null;
  /** What each run asks. Empty: each run works toward the chat's goal. */
  text: string;
  /** file: what is watched, relative to the project's folder ('' is all of it). */
  path?: string;
  /** Where to POST: local bearer auth by default; signed mode can advertise an HTTPS relay. */
  url?: string;
  settings: TurnSettings;
  paused: boolean;
  /** Its watcher (file, mail) or endpoint (webhook) is listening now. */
  watching: boolean;
  /** Events waiting for the run going now to end. */
  pending: number;
  createdAt: string;
  lastRunAt: string | null;
  version: number;
}

export interface TriggerRun {
  id: Id;
  triggerId: Id;
  kind: Trigger['kind'];
  title: string;
  startedAt: string;
  endedAt: string | null;
  threadId: Id | null;
  turnId: Id | null;
  outcome: RunOutcome;
  /** The answer's first lines, or why it did not run. */
  summary: string;
  /** How many events this run stands for. */
  events: number;
  /** The run that carries this interrupted one on, once the person resumed it. */
  resumedBy?: Id;
}

export interface Triggers {
  triggers: Trigger[];
  /** Newest first, the latest 200. */
  runs: TriggerRun[];
}

// ---- Commands --------------------------------------------------------------

/** The whole port as a method map; every transport (IPC, HTTP) carries exactly this. */
/**
 * The person's work exported in plain files (composition/backup.ts): projects with every document
 * version, chats and receipts as history, memory and skills. No credential, authority or database row.
 */
export interface HomeExport {
  folder: string;
  id: string;
  createdAt: string;
  /** `unresolved`: receipts and held calls that were UNKNOWN or held when exported. */
  counts: { projects: number; threads: number; documents: number; versions: number; memoryFiles: number; skills: number; roles?: number; receipts: number; unresolved: number };
  /** What is never in an export, and why, in plain words. */
  excluded: { what: string; why: string }[];
  files: number;
  /** How many credential values were cut out of the files. */
  scrubbed: number;
}

/** The folder the person picked for an export, as it was when they picked it. */
export interface PickedFolder { path: string; real: string; dev: number; ino: number }

export interface StandingSignatureStatus { step: 'connector-signature-ledger-v1'; state: 'verified' | 'paused' }

export type { RewindFile, RewindPlan, RewindChoice, RewindRecord } from './api-rewind.ts';
import type { RewindMethods } from './api-rewind.ts';
export type { ThreadRestartRequest, ThreadRestartReceipt } from './api-thread-control.ts';

export interface ApiMethods extends RewindMethods, ThreadControlMethods, SkillControlMethods, IdentityMethods {
  /** A read of committed Core audit receipts; paths and file writes belong to the caller. */
  'audit.export': (a: AuditRequest) => Receipt<AuditPage>;
  /** Pure inspection of the Core step's receipt and exact profile; no vault, install or work. */
  'core.signatureStatus': (a: Record<string, never>) => StandingSignatureStatus;
  'projects.list': (a: Record<string, never>) => Project[];
  'projects.update': (a: { id: Id; patch: Partial<Pick<Project, 'name' | 'archived'>> }) => Receipt<Project>;
  'projects.create': (a: { name: string; kind: ProjectKind; clientKey?: string }) => Receipt<Project>;
  'threads.list': (a: Record<string, never>) => ThreadSummary[];
  'threads.get': (a: { id: Id }) => Receipt<Thread>;
  'threads.update': (a: { id: Id; patch: Partial<Pick<ThreadSummary, 'title' | 'pinned' | 'unread' | 'section' | 'projectId' | 'archived'>> }) => Receipt<ThreadSummary>;
  'threads.delete': (a: { id: Id }) => Receipt<{ id: Id }>;
  /** Copy a thread's finished turns into a new, independent chat: no receipt, child or run comes with them. */
  'threads.fork': (a: { id: Id; clientKey: string; /** Fork from this turn: the new chat keeps the history up to and including it. */ turnId?: Id }) => Receipt<ThreadSummary>;
  /** Every thread's title, the person's words and the answers, for all the words in `query`. */
  'threads.search': (a: { query: string }) => ThreadHit[];
  /**
   * Run the chat's goal until a judge finds it met, within `budget` turns of work, each followed by a
   * check turn. `settings` pins how every turn of it runs (otherwise the chat's latest when it starts, pinned likewise); `goal` refuses
   * the run unless the goal is still those words, and pauses it if the goal changes later.
   */
  'goals.run': (a: { threadId: Id; budget: number; tokenBudget?: number; rubric?: string[]; settings?: TurnSettings; goal?: string; /** Refuses the run unless its recorded choice is this one. */ continues?: ShownSelection }) => Receipt<GoalRun>;
  /** Hold the run after the turn in hand; resume goes on from where it was. */
  'goals.pause': (a: { threadId: Id }) => Receipt<GoalRun>;
  'goals.resume': (a: { threadId: Id }) => Receipt<GoalRun>;
  'goals.runs': (a: Record<string, never>) => GoalRun[];
  /** The chat's board: every card, and its pool of workers. */
  'board.get': (a: { threadId: Id }) => Receipt<Board>;
  /** Add a card. It is ready once every card it depends on is done; a worker then takes it. */
  'board.add': (a: { threadId: Id; title: string; brief: string; dependsOn?: Id[]; model?: string; effort?: Effort; clientKey: string }) => Receipt<Card>;
  /**
   * Change a card that is not running. `status: 'ready'` releases a held, failed or blocked card, its
   * counts reset; `'held'` keeps it from running. `baseVersion` is the `Card.version` the person saw.
   */
  'board.update': (a: { threadId: Id; cardId: Id; patch: { title?: string; brief?: string; dependsOn?: Id[]; model?: string | null; effort?: Effort | null; status?: 'ready' | 'held' }; baseVersion: number }) => Receipt<Card>;
  /** Remove a card that is not running and that no other card depends on. */
  'board.remove': (a: { threadId: Id; cardId: Id; baseVersion: number }) => Receipt<{ id: Id }>;
  /** The pool: how many workers run at once, and resuming it after a Stop. */
  'board.pool': (a: { threadId: Id; size?: number; paused?: false }) => Receipt<BoardPool>;
  /** Whether this host owns its home: an app opened on a home a daemon holds says so, rather than half-working. */
  'host.status': (a: Record<string, never>) => HostStatus;
  /** Set, change or clear a thread's goal. `baseVersion` is the `GoalState.version` the person saw. */
  'goals.set': (a: { threadId: Id; text: string; baseVersion: number }) => Receipt<GoalState>;
  'goals.clear': (a: { threadId: Id; baseVersion: number }) => Receipt<GoalState>;
  /** The person accepts or declines an agent's proposed goal. */
  'goals.decide': (a: { threadId: Id; proposalId: Id; verdict: 'accept' | 'decline'; baseVersion: number }) => Receipt<GoalState>;
  /**
   * Start a depth-one child on a thread of its own, under a mandate delegated from the parent's.
   * `settings` may only narrow the parent's, except `settings.model`: the child's own model, checked at
   * admission against what the engine and route serve, with `fallback` the next ones to try if it is
   * refused there. Left out, it is the parent's. `reviews` names the parent or a child of it, whose
   * transcript a reviewer is given as data.
   */
  'children.start': (a: { parentThreadId: Id; text: string; role: ChildRole; title?: string; settings?: Partial<TurnSettings>; fallback?: string[]; reviews?: Id; clientKey: string }) => Receipt<{ threadId: Id; turnId: Id }>;
  /** A follow-up continues the chat's chosen route, if it has one (`Turn.selection`); `continues` refuses it unless that is the route shown. */
  'turns.send': (a: { threadId?: Id; projectId: Id; text: string; attachments: Id[]; settings: TurnSettings; clientKey: string; continues?: ShownSelection; /** Refuse admission unless this is still the latest turn. */ afterTurnId?: Id }) => Receipt<{ threadId: Id; turnId: Id }>;
  'turns.stop': (a: { threadId: Id; /** A stale restart never stops a newer turn. */ turnId?: Id }) => Receipt<{ stopped: boolean }>;
  /** Explicit person action: keep recovery data and end pending own-worker runs, never retry an old request. Unresolved effects remain. */
  'turns.keepRecovery': (a: { threadId: Id; turnId: Id; revision: string }) => Receipt<{ files: FileLink[]; cleared: boolean; detail: string }>;
  /** Add words to the running turn. The receipt says it was handed over, no more: `Turn.steers` says what became of it. */
  'turns.steer': (a: { threadId: Id; text: string; clientKey: string }) => Receipt<TurnSteer>;
  /** Wait for the turn to finish. An idle thread with nothing to hold it sends at once. */
  'queue.add': (a: { threadId: Id; text: string; attachments: Id[]; settings: TurnSettings; clientKey: string; continues?: ShownSelection }) => Receipt<QueuedMessage>;
  /** `baseVersion` is the `QueuedMessage.version` the person saw. Refused once it was sent. */
  'queue.edit': (a: { threadId: Id; id: Id; text: string; baseVersion: number }) => Receipt<QueuedMessage>;
  'queue.remove': (a: { threadId: Id; id: Id; baseVersion: number }) => Receipt<{ id: Id }>;
  /**
   * The person sends this message now, past anything holding the queue. It names the message, so a
   * retry finds the turn it made and can never send the one behind it. Only the oldest can go.
   */
  'queue.send': (a: { threadId: Id; id: Id; baseVersion: number }) => Receipt<{ threadId: Id; turnId: Id }>;
  /**
   * Bring one document a worker made into its parent, as a turn of the parent that calls no model.
   * `baseVersion` is `ChildDocument.current`. Nothing replaces a version: a document that moved on keeps
   * its version, and the worker's lands beside it.
   */
  'children.merge': (a: { parentThreadId: Id; childThreadId: Id; materialId: Id; version: number; baseVersion: number; clientKey: string }) => Receipt<{ threadId: Id; turnId: Id }>;
  /** Read-only side question. Model text is not evidence that an action happened: only a recorded
   * effect or refusal is authoritative. A runtime may reject an unknown tool without exposing
   * an attempted call to the host, so absence of a refusal does not prove no action was attempted. */
  'sidechat.ask': (a: { threadId: Id; text: string; clientKey?: string }) => Receipt<Turn>;
  /** Stop only this side turn, never the main conversation's running turn. */
  'sidechat.stop': (a: { threadId: Id; turnId: Id }) => Receipt<{ stopped: boolean }>;
  'material.attach': (a: { projectId: Id; name: string; base64: string; mediaType: string; relativePath?: string }) => Receipt<MaterialEntry>;
  'material.list': (a: { projectId: Id; includeHidden?: boolean }) => MaterialEntry[];
  'material.read': (a: { id: Id; version?: number }) => Receipt<{ entry: MaterialEntry; text?: string; base64?: string }>;
  'material.save': (a: { id: Id; text: string; baseVersion: number }) => Receipt<MaterialEntry>;
  /**
   * Retire temporary output, keep it, or bring it back; withdraw an attached original, which `current`
   * restores; on a held document `current` or `kept` releases it and `retired` sets it aside.
   * Nothing is deleted. `version` and `lifecycle` are what the person saw; `lifecycle` is required to
   * withdraw, for a held document, and for any document whose lifecycle has moved.
   */
  'material.lifecycle': (a: { id: Id; version: number; state: 'retired' | 'kept' | 'current' | 'withdrawn'; lifecycle?: number }) => Receipt<MaterialEntry>;
  'work.now': (a: { projectId: Id }) => WorkNow;
  'files.list': (a: { projectId: Id }) => ProjectFile[];
  /**
   * An answer's absolute or local `file:` link, resolved where the project's folder is known: a document
   * of this project whose real path is inside its folder, or refused. The folder itself is never returned.
   */
  'files.resolveLink': (a: { projectId: Id; href: string }) => Receipt<{ materialId: Id; path: string }>;
  'drafts.put': (a: { key: string; text: string; meta?: Record<string, string | number>; clientKey: string; baseRevision?: number }) => Receipt<Draft>;
  'drafts.get': (a: { key: string }) => Draft | null;
  /** With `version`, that one document version of this project against the version before it, whatever the scope. */
  'changes.get': (a: { projectId: Id; threadId?: Id; scope: ChangeScope; base?: string; version?: { materialId: Id; version: number } }) => Receipt<Changes>;
  /** Local device owner only, with terminal.run project and policy admission; list and Stop remain available during a rewind. */
  'terminal.list': (a: { projectId: Id }) => Receipt<TerminalView>;
  /** Record before dispatch. Reusing clientKey observes the original command; it never runs it again. */
  'terminal.start': (a: { projectId: Id; command: string; clientKey: string }) => Receipt<TerminalBlock>;
  /** Only this project's admitted command: interrupt, wait one second, terminate, wait, then kill its group. */
  'terminal.stop': (a: { projectId: Id; id: string }) => Receipt<TerminalBlock>;
  /** Clear finished blocks only; a running command and its custody remain. */
  'terminal.clear': (a: { projectId: Id }) => Receipt<TerminalView>;
  'terminal.run': (a: { projectId: Id; command: string }) => Receipt<TerminalResult>;
  'models.list': (a: Record<string, never>) => ModelChoice[];
  /** Store the engine for the next Host open; never changes a running turn. */
  'settings.engine.put': (a: { engine: string }) => Receipt<{ engine: string; detail: string }>;
  /** The engines this computer offers, which one runs and which one the next start uses. Changes nothing. */
  /** `fresh` asks the installed clients again instead of reusing an answer from the last few seconds. */
  'settings.engines.get': (a: { fresh?: boolean }) => EngineChoices;
  'settings.policy.get': (a: Record<string, never>) => PolicyView;
  'settings.model.get': (a: Record<string, never>) => ModelSettings;
  'settings.model.put': (a: { change: ModelSettingsChange }) => Receipt<ModelSettings>;
  /** Look for model servers on 127.0.0.1's usual ports. Reads only: never starts, installs or downloads anything. */
  'models.local': (a: Record<string, never>) => LocalModels;
  'viewer.get': (a: Record<string, never>) => ViewerPrefs;
  'viewer.put': (a: { prefs: ViewerPrefs }) => ViewerPrefs;
  'tools.list': (a: Record<string, never>) => AiTools;
  'tools.disconnect': (a: { tool: AiToolId }) => Receipt<AiTool>;
  'triage.get': (a: Record<string, never>) => TriageView;
  /** Connect the sample mailbox: the entitlement check first; then reads only, until a capability is signed. */
  'triage.connect': (a: Record<string, never>) => Receipt<TriageView>;
  'triage.run': (a: Record<string, never>) => Receipt<TriageView>;
  'triage.stop': (a: Record<string, never>) => Receipt<{ stopped: boolean }>;
  /** Accept or discard one proposal, bound to the change it names. */
  'triage.undo': (a: { effect: Id }) => Receipt<BriefItem>;
  'triage.decide': (a: { effect: Id; verdict: 'accept' | 'discard' }) => Receipt<BriefItem>;
  /** Revoke the capability (final) and the connection; the mailbox is left as it is. */
  'triage.disconnect': (a: Record<string, never>) => Receipt<TriageView>;
  /** Schedules, the heartbeat, recent runs and the daily brief. */
  'schedules.get': (a: Record<string, never>) => Proactivity;
  /** Read a person's words for when, without saving anything: the rule, in words, its next time, and the moment its times count from. */
  'schedules.parse': (a: { when: string }) => Receipt<{ rule: Rule; summary: string; nextAt: string | null; anchor: string }>;
  /**
   * `pinned` is what the person was shown, from `schedules.parse`: the schedule takes that rule and
   * anchor rather than reading `when` again, and is refused unless its first run is still `firstAt`.
   * `goal` pins a goal's schedule to that goal.
   */
  'schedules.create': (a: { projectId: Id; threadId?: Id; text: string; when: string; settings: TurnSettings; clientKey: string; wakeGate?: WakeGate; pinned?: SchedulePin }) => Receipt<Schedule>;
  /** `baseVersion` is the `Schedule.version` the person saw. */
  'schedules.update': (a: { id: Id; patch: { paused?: boolean; when?: string; text?: string; wakeGate?: WakeGate | null }; baseVersion: number; pinned?: ScheduleTimePin }) => Receipt<Schedule>;
  'schedules.delete': (a: { id: Id }) => Receipt<{ id: Id }>;
  /** Run it now, once; its schedule is unchanged. */
  'schedules.run': (a: { id: Id; clientKey: string }) => Receipt<ScheduleRun>;
  /** Set the one heartbeat: every N minutes inside active hours, checking `check`. Off removes it. */
  'heartbeat.put': (a: { enabled: boolean; projectId: Id; everyMinutes: number; hours: Hours; check: string; settings: TurnSettings }) => Receipt<Schedule | null>;
  /** When the daily brief comes, local "HH:MM". */
  'brief.put': (a: { time: string }) => Receipt<Proactivity['brief']>;
  /** Mark one brief item handled. */
  'brief.done': (a: { id: Id }) => Receipt<DailyBrief>;
  /** Triggers and their recent runs. */
  'triggers.get': (a: Record<string, never>) => Triggers;
  /** A webhook's secret is in this one answer only; it is kept sealed and never shown again. */
  'triggers.create': (a: { kind: Trigger['kind']; projectId: Id; threadId?: Id; text: string; path?: string; webhook?: SignedWebhook; settings: TurnSettings; clientKey: string }) => Receipt<{ trigger: Trigger; secret?: string }>;
  /** `baseVersion` is the `Trigger.version` the person saw. */
  'triggers.update': (a: { id: Id; patch: { paused?: boolean; text?: string }; baseVersion: number }) => Receipt<Trigger>;
  'triggers.delete': (a: { id: Id }) => Receipt<{ id: Id }>;
  /** Carry on an interrupted run: a new run of its trigger, in the same chat, told to check what the cut-short turn left before going on. Once per run; refused while a write of the cut turn is UNKNOWN. */
  'triggers.resume': (a: { runId: Id; clientKey: string }) => Receipt<TriggerRun>;
  /** What memory holds; `projectId` picks whose project instructions are shown. */
  /** Solution selection: the routes here, each eligible or why not, and a reasoned choice under the task's hard constraints (docs/specs/solution-selection.md). Reads only. */
  'solutions.options': (a: TaskNeeds) => Selection;
  /**
   * Choose, then start the task on the chosen route when it is the engine this home runs: the turn
   * starts, or the reason it did not (no route can, or the choice needs another engine) is given. The
   * choice then governs the person's ordinary follow-ups in the chat until another choice replaces it;
   * a goal run keeps the choice it recorded when it was allowed, and schedules and triggers run as they
   * were allowed, so none of them adopts a later, unrelated choice.
   * A model the settings name explicitly is kept: on a native engine it runs on the chosen route; where
   * the chosen route cannot run it, nothing starts.
   */
  'solutions.run': (a: { projectId: Id; threadId?: Id; text: string; /** Attached material IDs, admitted under the same checks as turns.send. */ attachments?: Id[]; task: TaskNeeds; settings: TurnSettings; clientKey: string; /** Claimed MCP client name (at most 60 characters), or null when absent; informational only, requires ask permission. */ caller?: { mcp: string | null } }) => Receipt<{ selection: Selection; started: { threadId: Id; turnId: Id } | null; detail: string }>;
  /** Whether the turn's named deliverables were written by it and read back as their kind; completion only when all were. Reads only. */
  'solutions.verify': (a: { threadId: Id; turnId: Id; deliverables: string[] }) => Receipt<Verification>;
  'memory.get': (a: { projectId?: Id }) => MemoryView;
  'memory.search': (a: { query: string }) => MemoryEntry[];
  /** Name an embeddings model on this computer for recall by meaning, or clear it (null). Only a loopback address is taken. */
  'memory.meaning.put': (a: { route: MemoryRoute | null }) => Receipt<MemoryRoute | null>;
  'memory.instructions.put': (a: { scope: 'person' | 'project'; projectId?: Id; text: string }) => Receipt<MemoryView['instructions']>;
  /** Add or edit a line, never a credential. An unchanged save of a withheld line includes that exact text as reference, keeping its trust. */
  'memory.put': (a: { id?: Id; topic: string; text: string }) => Receipt<MemoryEntry>;
  'memory.forget': (a: { id: Id }) => Receipt<{ id: Id }>;
  /**
   * One consolidation pass by a model's judgement, through the home's engine route: lines merged,
   * superseded or retired, and engines' proposals kept. What touches the person's own words waits for
   * them (`proposed`); the rest is done with an undo (`kept`). Nothing happens with no model set up.
   */
  'memory.consolidate': (a: Record<string, never>) => Receipt<{ proposed: number; kept: number }>;
  /** Keep a line or change waiting for the person, with its sources, or discard it. */
  'memory.proposal.decide': (a: { id: Id; verdict: 'keep' | 'discard' }) => Receipt<MemoryEntry | null>;
  /** Undo a change consolidation made by itself: what it added leaves, what it took out comes back. */
  'memory.undo': (a: { id: Id }) => Receipt<{ id: Id }>;
  /** Copy memories in, read-only, with their source kept: Codex's memories folder, Claude's, or a markdown file. */
  'memory.import': (a: { from: 'codex' | 'claude' | 'file'; path?: string }) => Receipt<MemoryImportResult>;
  /** Draft a skill from a chat's last finished turn; it waits for the person's OK. */
  'skills.draft': (a: { threadId: Id }) => Receipt<Skill>;
  /**
   * accept or decline a draft or a proposed edit; enable or disable a skill found in the person's folders;
   * restore an archived skill; decline a proposed merge (by its id) so it is not proposed again.
   */
  'skills.decide': (a: { id: Id; verdict: 'accept' | 'decline' | 'enable' | 'disable' | 'restore' }) => Receipt<Skill | null>;
  /** Turn drafting skills from complex finished turns on or off. */
  'skills.learning.put': (a: { auto: boolean }) => Receipt<SkillLearning>;
  /** Run the skills curator now: archive what has gone unused for 30 days, propose merges. Deletes nothing. */
  'skills.curate': (a: Record<string, never>) => Receipt<CuratorReport>;
  /** Saved Claude Code subagent Markdown definitions, checked against stored credentials. */
  'agents.list': (a: Record<string, never>) => Receipt<import('./api-agent-roles.ts').AgentRoleListing>;
  'agents.save': (a: { name: string; markdown: string; base: string | null }) => Receipt<AgentRole>;
  'agents.delete': (a: { name: string; base: string }) => Receipt<{ name: string }>;
  /** The commands, agents and hooks of the Claude Code and Codex plugins the person enabled, as their files say now; any field holding a credential withheld. */
  'plugins.parts': (a: Record<string, never>) => PluginPart[];
  /**
   * Enable a command or agent at the version the person was shown (`digest`, as listed), or disable it.
   * A file changed since is refused (STALE_BASE) and listed anew. A hook is never enabled; one holding a credential is refused.
   */
  'plugins.decide': (a: { id: Id; verdict: 'enable' | 'disable'; digest?: string }) => Receipt<PluginPart>;
  /**
   * An enabled command's template filled with the person's arguments (`$ARGUMENTS`, `$1`…`$9`), for the
   * composer to send as their message. `name` is its slash name, or `plugin:name` when two share it.
   * Nothing in it is run: a shell line stays words, and its `allowed-tools` grants nothing.
   */
  'plugins.command': (a: { name: string; args: string }) => Receipt<{ text: string; plugin: string }>;
  /** The person's MCP servers, as their configs say now, with what they chose and the calls held for them. */
  'connectors.list': (a: Record<string, never>) => ConnectorsView;
  /** Start the server and list its tools. A tool whose definition changed since it was enabled turns off. */
  'connectors.refresh': (a: { serverId: Id }) => Receipt<ConnectorServer>;
  /** Takes connector authority away: disable, close sending, end a signature or count a tool as an effect. Enabling is person-only in desktop main. */
  'connectors.set': (a: { serverId: Id; enabled?: boolean; /** The egress door for this server: a call the person releases is sent. Closed by default. */ egress?: boolean; tool?: { name: string; enabled?: boolean; override?: 'read' | 'effect' | null; /** Ends the person's standing signature for the tool. Giving one is theirs alone, in the desktop app. */ standing?: false } }) => Receipt<ConnectorServer>;
  /** The person answers a held call on its exact statement. A release is recorded; nothing is sent while egress is closed. */
  'connectors.decide': (a: { effect: Id; argsHash: string; verdict: 'release' | 'discard' }) => Receipt<HeldCall>;
  /** Person-only decision on an existing read. Never offered to a model or tool host; neither choice resends a provider call. */
  'connectors.resolveRead': (a: { id: Id; verdict: 'reconcile' | 'discard' }) => Receipt<ConnectorReadResolution>;
  /**
   * Export the whole home into `to`, a folder that is absent or empty, outside the home. Refused while
   * a turn runs. A renderer gives no path: it gives the one-time `ticket` the app's own folder picker
   * issued (composition/backup.ts, exportDestinations), which its transport turns into the folder and
   * the picked folder's identity (`picked`), checked again when the export is written.
   */
  'backup.export': (a: { to: string; picked?: PickedFolder } | { ticket: string }) => Receipt<HomeExport>;
  /** Read an export and check every file against its manifest. Changes nothing. */
  'backup.inspect': (a: { from: string }) => Receipt<HomeExport>;
}
export type Method = keyof ApiMethods;
export type Args<M extends Method> = Parameters<ApiMethods[M]>[0];
export type Result<M extends Method> = ReturnType<ApiMethods[M]>;

export const METHODS: Method[] = [
  'threads.rewindPreview', 'threads.rewind', 'threads.rewindFinish',
  'identity.get', 'identity.invite', 'identity.role', 'identity.remove', 'identity.share', 'identity.sharing', 'identity.automations', 'identity.automation.create', 'identity.automation.revoke', 'identity.automation.run',
  'core.signatureStatus',
  'projects.list', 'projects.create', 'projects.update', 'threads.list', 'threads.get', 'threads.update', 'threads.delete', 'threads.restart', 'threads.fork',
  'goals.set', 'goals.clear', 'goals.decide', 'children.start',
  'children.merge', 'turns.send', 'turns.stop', 'turns.keepRecovery', 'turns.steer', 'queue.add', 'queue.edit', 'queue.remove', 'queue.send', 'sidechat.ask', 'sidechat.stop', 'material.attach', 'material.list', 'material.read',
  'material.save', 'material.lifecycle', 'work.now', 'files.list', 'files.resolveLink', 'drafts.put', 'drafts.get', 'changes.get', 'terminal.run', 'terminal.list', 'terminal.start', 'terminal.stop', 'terminal.clear',
  'models.list', 'models.local', 'settings.engine.put', 'settings.engines.get', 'settings.model.get', 'settings.policy.get', 'settings.model.put', 'viewer.get', 'viewer.put',
  'tools.list', 'tools.disconnect',
  'triage.get', 'triage.connect', 'triage.run', 'triage.stop', 'triage.undo', 'triage.decide', 'triage.disconnect',
  'schedules.get', 'schedules.parse', 'schedules.create', 'schedules.update', 'schedules.delete', 'schedules.run', 'heartbeat.put', 'brief.put', 'brief.done',
  'triggers.get', 'triggers.create', 'triggers.update', 'triggers.delete', 'triggers.resume',
  'solutions.options', 'solutions.run', 'solutions.verify', 'memory.get', 'memory.search', 'memory.meaning.put', 'memory.instructions.put', 'memory.put', 'memory.forget', 'memory.consolidate', 'memory.proposal.decide', 'memory.undo', 'memory.import', 'skills.draft', 'skills.decide', 'skills.learning.put', 'skills.curate', 'skills.put', 'skills.remove', 'skills.undo',
  'plugins.parts', 'plugins.decide', 'plugins.command',
  'agents.list', 'agents.save', 'agents.delete',
  'threads.search', 'goals.run', 'goals.pause', 'goals.resume', 'goals.runs', 'host.status',
  'board.get', 'board.add', 'board.update', 'board.remove', 'board.pool',
  'connectors.list', 'connectors.refresh', 'connectors.set', 'connectors.decide', 'connectors.resolveRead',
  'backup.export', 'backup.inspect', 'audit.export',
];

/** What the side chat may use (R-UX-SIDECHAT-01). */
export const SIDE_CHAT_TOOLS = ['read', 'search', 'list'] as const;

export const DEFAULT_PREFS: ViewerPrefs = { theme: 'system', pane: { open: false, tabs: [] } };
