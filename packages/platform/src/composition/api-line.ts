import {validProjectName} from '../project-name.ts';
import { unknownCheckConfirmation } from '../api.ts';
import { memoryIsOff } from '../api-memory.ts';
import { selectionTask } from './selection-line.ts';
import {sweepAuditTemporary} from './audit-temporary.ts';
import { redactWakeGates } from '../api-proactivity.ts';
// The host's side of the api line (doors/api-line.ts). Any process of the person's user can reach this
// socket, so it carries a named list and denies the rest before the host hears of it. Reads and stop
// give that process nothing it lacks. An asked write (a send, a queued message, a goal set or run, a
// schedule) can spend the person's key now or later, so each one runs only once the person has said so
// through `confirm`, which only the process that shows them the question provides: with none, those
// writes are closed. No click stands for the next one. docs/adr/0002-api-line.md records it.
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Args, Effort, Id, Method, ModelSettings, Permission, Receipt, Result, ShownSelection, Thread, TurnSettings, ConnectorEffectQuestion, ConnectorEffectResolution, TaskNeeds } from '../api.ts';
import { API_LINE_ASKED, API_LINE_TEAM, API_LINE_PROJECTS, API_LINE_ATTACHMENTS, MAX_ATTACHMENT_LINE, API_LINE_PERSON_ASKED, API_LINE_METHODS, API_LINE_PROTOCOL, apiSocket, type HelloAnswer, MAX_ASKED, refusal, type SendState, type ConnectorEffectInput } from '../doors/api-line.ts';
import { MAX_LINE, ownFolder } from '../doors/protocol.ts';
import { continuedSelection, shownOf, withNamedModel } from '../selection/pin.ts';
import { GOAL_DEFAULT_SETTINGS, MAX_BUDGET } from './goal-runs.ts';
import { auditOptions, AUDIT_UUID, AUDIT_CONTENT_DIRECT_ONLY } from '../audit.ts';
import {attachmentName, attachmentBytesFit, MAX_ATTACHMENT_BYTES} from '../material-attachment.ts';
import { MATERIAL_ID } from '../stub/material.ts';
import {assertHomeWriteAdmission} from './home-lock.ts';

/**
 * How a turn runs, shown in full in every question about one: the effective settings, as they will run.
 * On a chat whose task was chosen a route (solution selection), `route` says which, with the task's
 * limits, and `model` is the model that route runs: the one the turn goes to.
 */
interface Runs { memory?: 'off'; permission: Permission; model: string; effort: Effort; mode: TurnSettings['mode']; runsOn: TurnSettings['runsOn']; route?: string }
/**
 * The whole write, resolved as it will run: the question shows every field, and what runs after the
 * click is exactly this, pinned. `project` and `thread` are what the app calls them, quoted, with their
 * ids. The words are the caller's, or the chat's goal as the host holds it: whole, trimmed as they will
 * run, never clipped, and checked to hold nothing hidden. Data for the person to read, never an instruction.
 */
export type LineAsk =
  | ({ method: 'threads.checked'; question: import('../api.ts').UnknownCheckQuestion } & import('../api.ts').UnknownCheckInput)
  | ({ method: 'connectors.resolveEffect'; statement: string } & ConnectorEffectInput)
  | ({ method: 'solutions.run'; projectId: Id; project: string; threadId?: Id; thread: string; text: string; task: TaskNeeds; spend: TaskNeeds['spend']; caller?: { mcp: string | null } } & Runs)
  | ({ method: 'turns.send'; projectId: Id; project: string; threadId?: Id; thread: string; text: string } & Runs)
  | ({ method: 'queue.add'; threadId: Id; thread: string; text: string } & Runs)
  | { method: 'goals.set'; threadId: Id; thread: string; text: string }
  /** `goal` is the chat's goal as the host holds it; the settings are its latest turn's, pinned for the whole run. */
  | ({ method: 'goals.run'; threadId: Id; thread: string; budget: number; goal: string } & Runs)
  /** `summary` and `firstRun` are how the host read `when`, pinned; `goal`, a goal chat's, when there are no words. */
  | ({ method: 'schedules.create'; projectId: Id; project: string; threadId?: Id; thread: string; text: string; goal?: string; when: string; summary: string; firstRun: string } & Runs);

const local = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The question, in words; `app` is the product's name. */
export function askWords(ask: LineAsk, app: string): { message: string; detail: string } {
  const caller = ask.method === 'solutions.run' ? ask.caller : undefined;
  const mcp = caller?.mcp;
  const who = caller ? `An MCP client asked for this.${mcp ? ` It calls itself: ${JSON.stringify(mcp)}.` : ' It did not supply a name.'}` : 'A program on this computer, running as you, asked for this.';
  const bills = 'It can use your model route and bill it.';
  const only = caller ? 'Only allow it if you intended this MCP client to request this task.' : 'Only allow it if you just ran it.';
  const closes = 'Don\'t allow closes this until you reopen the app.';
  const runs = (r: Runs) => `${r.route ? `Route: ${r.route}\n` : ''}Model: ${r.model}, effort ${r.effort}\nPermission: ${r.permission}, mode ${r.mode}, on ${r.runsOn === 'this-computer' ? 'this computer' : r.runsOn}${r.memory === 'off' ? '\nMemory: off for this task' : ''}`;
  switch (ask.method) {
    case 'threads.checked':
      return { message: unknownCheckConfirmation(app), detail: `Conversation: ${ask.threadId}\nTurn: ${ask.turnId}\n${ask.question.steps.map(s => `${s.at}: ${JSON.stringify(s.label)}`).join('\n')}` };
    case 'connectors.resolveEffect':
      return { message: `Record your inspection of this unknown call in ${app}?`, detail: `${who} ${only} This records what happened; it never sends the call again.\n\nStatement: ${JSON.stringify(ask.statement)}\nEffect: ${ask.effect}\nAnswer: ${ask.answer === 'happened' ? 'It did happen' : ask.answer === 'did_not_happen' ? 'It did not happen' : 'I do not know; keep it closed and keep this tool’s standing signature paused'}.\n\nConclusive answers let standing signatures resume once every unknown for this tool on this connection is resolved. ${closes}` };
    case 'solutions.run':
      return { message: `Allow this task on the shown route in ${app}?`, detail: `${who} ${bills} ${only}\n\nProject: ${ask.project}, ${ask.thread}\n${runs(ask)}\nSpend class: ${ask.spend}\nTask limits: ${JSON.stringify(ask.task)}\nThis fixes the shown route for admission; a changed route is refused. The engine retains its model routing within that route.\n\nTask, in full: ${JSON.stringify(ask.text)}\nAllow covers one selection and turn. ${closes}` };
    case 'turns.send':
      return {
        message: `Allow the command line to start this turn in ${app}?`,
        detail: `${who} ${bills} ${only}\n\nProject: ${ask.project}, ${ask.thread}\n${runs(ask)}\n\nIt says, in full: ${JSON.stringify(ask.text)}\n\nAllow covers this one turn. ${closes}`,
      };
    case 'queue.add':
      return {
        message: `Allow the command line to queue this message in ${app}?`,
        detail: `${who} It is sent as a turn when the turn in hand ends, or now if none runs. ${bills} ${only}\n\nThread: ${ask.thread}\n${runs(ask)}\n\nIt says, in full: ${JSON.stringify(ask.text)}\n\nAllow covers this one message. ${closes}`,
      };
    case 'goals.set':
      return {
        message: `Allow the command line to set this chat's goal in ${app}?`,
        detail: `${who} A goal is what a goal run works toward and is judged against; setting it starts no work. ${only}\n\nThread: ${ask.thread}\n\nThe goal, in full: ${JSON.stringify(ask.text)}\n\nAllow covers this one change. ${closes}`,
      };
    case 'goals.run':
      return {
        message: `Allow the command line to run this chat's goal in ${app}?`,
        detail: `${who} It starts up to ${ask.budget} turns of work on your model route and bills them, each followed by a check turn on the same route: up to ${ask.budget * 2} model turns in all, until a check finds the goal met. Every turn runs with the settings below, whatever the chat's later turns use. If the goal changes, the run pauses. ${only}\n\nThread: ${ask.thread}\nBudget: up to ${ask.budget} turns of work and ${ask.budget} checks (${ask.budget * 2} model turns)\n${runs(ask)}\n\nThe goal, in full: ${JSON.stringify(ask.goal)}\n\nAllow covers this one run. ${closes}`,
      };
    case 'schedules.create':
      return {
        message: `Allow the command line to schedule this work in ${app}?`,
        detail: `${who} Each run is a turn on your model route, billed to it, with no further question, until you pause or delete it in the app. ${only}\n\nProject: ${ask.project}, ${ask.thread}\nWhen: ${JSON.stringify(ask.when)}, read as ${ask.summary}; first run ${local(ask.firstRun)} (${ask.firstRun})\n${runs(ask)}\n\n${ask.goal === undefined ? `Each run says, in full: ${JSON.stringify(ask.text)}` : `Each run works toward the chat's goal, in full: ${JSON.stringify(ask.goal)}\nIf that goal changes, the schedule pauses until you resume it.`}\n\nAllow covers this one schedule. ${closes}`,
      };
  }
}

export interface ApiLineOptions {
  /** Trusted composition identifies the process holding this data folder. */
  holder?: 'background-service' | 'app' | 'other';
  home: string;
  call<M extends Method>(method: M, args: Args<M>): Promise<Result<M>>;
  /**
   * Ask the person. Without it no asked write is carried. `signal` takes the question down when nobody
   * answered in time, and whatever it resolves with then is not their answer.
   */
  confirm?: (ask: LineAsk, signal: AbortSignal) => Promise<boolean>;
  /** How long a question stays up; after that the write is refused, and the person has not said No. */
  confirmWaitMs?: number;
  /** Only trusted composition supplies this person capability. No Host.call fallback. */
  unknownChecks?: Pick<import('./host-types.ts').Host['unknownChecks'], 'question' | 'check'>;
  connectorEffects?: {
    question(effect: string, argsHash: string): Promise<Receipt<ConnectorEffectQuestion>>;
    resolve(input: ConnectorEffectInput): Promise<Receipt<ConnectorEffectResolution>>;
  };
  /** No asked write or stop crosses; explicit local project, attachment and team controls are separate. */
  readOnly?: boolean;
  /** Same-user invitation and sharing controls; never enabled by a network listener. */
  teamManagement?: boolean;
  /** Trusted composition only: local empty projects, or a company refusal directing the person to the signed-in app. */
  projectCreation?: boolean | 'signed-in-app';
  /** Required when creation is enabled. Owned by the app or daemon; reuse for all of that owner's lines, including replacements. */
  projectCreationBudget?: ApiLineProjectBudget;
  /** Trusted local composition only; company sign-in directs attachment to the signed-in app. */
  attachment?: boolean | 'signed-in-app';
  /** Reuse this owner's budget for every connection and replacement line. Required when enabled. */
  attachmentBudget?: ApiLineAttachmentBudget;
  /** How long one connection may keep the single large-frame slot without sending, and in all. Tests shorten it. */
  attachmentFrameWaitMs?: { idle: number; total: number };
}

export interface ApiLineServer {
  readonly socket: string;
  close(): Promise<void>;
}

/** Trusted composition state, never supplied or reset by a line request. */
export class ApiLineProjectBudget {
  #attempts: number[] = [];
  #total = 0;

  take(): boolean {
    const now = Date.now();
    while (this.#attempts.length && this.#attempts[0]! <= now - 60_000) this.#attempts.shift();
    if (this.#attempts.length >= 10 || this.#total >= 100) return false;
    this.#attempts.push(now);
    this.#total++;
    return true;
  }
}

/** Separate attachment allowance, owned by the serving app or daemon. Same bounded request policy. */
export class ApiLineAttachmentBudget extends ApiLineProjectBudget {}

const CONFIRM_WAIT_MS = 120_000;
const CLOSED = 'The person has not allowed this command line to start work in this app, so nothing was sent. After a Don\'t allow, it takes reopening the app.';
const NO_ANSWER = 'Nobody answered the app\'s question in time, so nothing was sent.';
const MOVED = 'What you were shown changed before it could run (the chat\'s goal, its model, its settings or its name), so nothing was done. Ask again to be shown it as it is now.';
const UNSHOWABLE = 'A name or setting this would show cannot be shown in full in the app\'s question (it is long or holds hidden characters), so nothing was asked. Use the app for it.';
const GOAL_UNSHOWABLE = `The chat\'s goal cannot be shown in full in the app\'s question (it is over ${MAX_ASKED} characters or holds hidden characters), so nothing was asked. Run it from the app.`;
const OFF_LINE = 'That is not on the line to the app, so nothing was done. Use the app for it.';
const READS_ONLY = 'This line does not start or stop work, so nothing was done. Use the app to start or stop work.';
/** What changes work: closed on a read-only line. */
const CHANGES = new Set<string>([...API_LINE_ASKED, ...API_LINE_PERSON_ASKED, 'turns.stop']);
const ASKED = new Set<string>([...API_LINE_ASKED, ...API_LINE_PERSON_ASKED]);
const BAD_SEND = `A send needs a project, its text, no attachments, this computer, a clear permission, effort and mode, and a client key. Its text is what the person is asked about, so it is at most ${MAX_ASKED} characters with nothing hidden in it, and the model and ids are one plain line. Use the app for a longer one.`;
const BAD_WRITE: Record<string, string> = {
  'projects.update': 'A project change needs a project id and a name of 1 to 1,000 readable characters, an archive boolean, or both. No other project properties may change.',
  'queue.add': `A queued message needs its thread, its text, no attachments, this computer, a clear permission, effort and mode, and a client key. Its text is at most ${MAX_ASKED} characters with nothing hidden in it, and the model and ids are one plain line.`,
  'goals.set': `A goal needs its thread, its words and the goal version you saw. The words are at most ${MAX_ASKED} characters with nothing hidden in them; clear a goal in the app.`,
  'goals.run': `A goal run needs its thread and a budget of 1 to ${MAX_BUDGET} turns.`,
  'schedules.create': `A schedule needs a project, what each run says, when, this computer, a clear permission, effort and mode, and a client key. Its words and its when are at most ${MAX_ASKED} characters with nothing hidden in them, the when one line.`,
};
const BAD_ARGS = 'Those arguments are not this call\'s.';

const text = (v: unknown): v is string => typeof v === 'string';
/** Control and format characters, and Unicode's line separators, could show the person something other than what is sent. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** A model or an id: one plain line, so a field in the question cannot pass for another. */
const lineProjectName=(v:unknown):v is string=>validProjectName(v)&&!HIDDEN.test(v.replace(/\u200d/g,''));
const plain = (v: unknown): v is string => text(v) && v.length > 0 && v.length <= MAX_ASKED && !HIDDEN.test(v);
/** A send's words. Only these may run over lines, because the question shows them quoted, with lines and tabs escaped. */
const readable = (v: unknown): v is string => text(v) && v.length <= MAX_ASKED && !HIDDEN.test(v.replace(/[\n\t]/g, ''));
type Fields = Record<string, unknown>;
/** How a turn runs, as the line carries it: this computer only, every field one the question shows. */
function runsAs(settings: unknown): TurnSettings | null {
  const s = (settings ?? {}) as Fields;
  const fits = ['ask', 'auto-review', 'full'].includes(s.permission as string) && plain(s.model) &&
    [1, 2, 3, 4, 5].includes(s.effort as number) && s.runsOn === 'this-computer' && ['chat', 'plan'].includes(s.mode as string) && (s.memory === undefined || s.memory === 'off');
  return fits ? { ...(s.memory === 'off' ? { memory: 'off' } : {}), permission: s.permission, model: s.model, effort: s.effort, runsOn: 'this-computer', mode: s.mode } as TurnSettings : null;
}
const version = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** Each call's checked arguments, holding only its named fields; null when they are not its own. */
const CHECK: Record<(typeof API_LINE_METHODS)[number] | (typeof API_LINE_TEAM)[number] | (typeof API_LINE_PROJECTS)[number] | (typeof API_LINE_ATTACHMENTS)[number] | (typeof API_LINE_PERSON_ASKED)[number], (a: Fields) => object | null> = {
  'audit.export': ({ since, until, after, includeContent, limit, session, cancel }) => {
    if ((session !== undefined && (typeof session !== 'string' || !AUDIT_UUID.test(session))) ||
        (cancel !== undefined && typeof cancel !== 'boolean') || (cancel && !session)) return null;
    try { return {...auditOptions({since,until,after,includeContent,limit} as never),
      ...(session === undefined ? {} : {session}), ...(cancel === undefined ? {} : {cancel})}; } catch { return null; }
  },
  'threads.checked': ({ threadId, turnId, revision }) => plain(threadId) && plain(turnId) && typeof revision === 'string' && /^[0-9a-f]{64}$/.test(revision) ? { threadId, turnId, revision } : null,
  'connectors.resolveEffect': ({ effect, argsHash, answer }) => typeof effect === 'string' && AUDIT_UUID.test(effect) && typeof argsHash === 'string' && /^[0-9a-f]{64}$/.test(argsHash) && ['happened', 'did_not_happen', 'keep_closed'].includes(answer as string) ? { effect, argsHash, answer } : null,
  'solutions.options': (args) => selectionTask(args),
  'solutions.verify': ({ threadId, turnId, deliverables }) => plain(threadId) && plain(turnId) && Array.isArray(deliverables) && deliverables.length > 0 && deliverables.length <= 100 && deliverables.every(plain) ? { threadId, turnId, deliverables } : null,
  'solutions.run': ({ task, threadId, projectId, text: words, attachments, settings, clientKey, caller }) => {
    const limits = selectionTask(task);
    const runs = runsAs(settings);
    const source = caller as { mcp?: unknown } | undefined;
    if (caller !== undefined && (!source || (source.mcp !== null && (!plain(source.mcp) || source.mcp.length > 60)) || runs?.permission !== 'ask')) return null;
    return limits && runs && plain(projectId) && (threadId === undefined || plain(threadId)) && readable(words) && words.trim().length > 0 && plain(clientKey) && (attachments === undefined || (Array.isArray(attachments) && attachments.length === 0))
      ? { task: limits, threadId, projectId, text: words, attachments: [], settings: runs, clientKey, ...(source ? { caller: { mcp: source.mcp } } : {}) } : null;
  },
  'core.signatureStatus': () => ({}),
  'identity.get': () => ({}),
  'identity.invite': ({role}) => ['admin','member','guest'].includes(role as string)?{role}:null,
  'identity.share': ({projectId,personId,access}) => plain(projectId)&&plain(personId)&&['viewer','editor',null].includes(access as never)?{projectId,personId,access}:null,
  'identity.remove': ({personId}) => plain(personId)?{personId}:null,
  'projects.create': ({ name, kind, clientKey }) => lineProjectName(name) && ['folder', 'git'].includes(kind as string) && plain(clientKey) && clientKey.length <= 256 ? { name: name.trim(), kind, clientKey } : null,
  'material.attach': ({projectId,name,base64,mediaType}) => plain(projectId) && text(name) && attachmentName(name) && plain(mediaType) && attachmentBytesFit(base64)
    ? {projectId,name:attachmentName(name),base64,mediaType} : null,
  'projects.update': ({id,patch}) => {
    if(!plain(id)||!patch||typeof patch!=='object'||Array.isArray(patch))return null;
    const p=patch as Record<string,unknown>;
    return Object.keys(p).length>0 && Object.keys(p).every(key=>['name','archived'].includes(key)) &&
      (!('name' in p)||(lineProjectName(p.name))) && (!('archived' in p)||typeof p.archived==='boolean') ? {id,patch:p} : null;
  },
  'projects.list': () => ({}),
  'threads.list': () => ({}),
  'models.list': () => ({}),
  'settings.policy.get': () => ({}),
  'settings.model.get': () => ({}),
  'goals.runs': () => ({}),
  'schedules.get': () => ({}),
  'threads.get': ({ id }) => (plain(id) ? { id } : null),
  'threads.search': ({ query }) => (plain(query) ? { query } : null),
  'memory.search': ({ query }) => (plain(query) ? { query } : null),
  'work.now': ({ projectId }) => (plain(projectId) ? { projectId } : null),
  'files.list': ({ projectId }) => (plain(projectId) ? { projectId } : null),
  'material.read': ({ id, version }) => (plain(id) && MATERIAL_ID.test(id) && (version === undefined || (Number.isInteger(version) && (version as number) > 0)) ? { id, ...(version === undefined ? {} : { version }) } : null),
  // Only a document version's own diff: the git scopes run a command in the project's folder, which this line does not carry.
  'changes.get': ({ projectId, threadId, scope, version }) => {
    const v = version as { materialId?: unknown; version?: unknown } | undefined;
    const fits = plain(projectId) && (threadId === undefined || plain(threadId)) && scope === 'last-turn' && !!v && typeof v === 'object' && plain(v.materialId) && MATERIAL_ID.test(v.materialId as string) && Number.isInteger(v.version) && (v.version as number) > 0;
    return fits ? { projectId, ...(threadId === undefined ? {} : { threadId }), scope, version: { materialId: v!.materialId, version: v!.version } } : null;
  },
  'turns.stop': ({ threadId }) => (plain(threadId) ? { threadId } : null),
  'turns.send': ({ threadId, projectId, text: words, attachments, settings, clientKey }) => {
    const runs = runsAs(settings);
    const fits =
      (threadId === undefined || plain(threadId)) && plain(projectId) && readable(words) && plain(clientKey) &&
      Array.isArray(attachments) && attachments.length === 0 && // An attachment would read material this line does not carry.
      runs !== null;
    return fits ? { threadId, projectId, text: words, attachments: [], settings: runs, clientKey } : null;
  },
  'queue.add': ({ threadId, text: words, attachments, settings, clientKey }) => {
    const runs = runsAs(settings);
    const fits = plain(threadId) && readable(words) && words.trim().length > 0 && plain(clientKey) && Array.isArray(attachments) && attachments.length === 0 && runs !== null;
    return fits ? { threadId, text: words, attachments: [], settings: runs, clientKey } : null;
  },
  // Clearing is not a set: an empty goal is the app's to clear.
  'goals.set': ({ threadId, text: words, baseVersion }) => (plain(threadId) && readable(words) && words.trim().length > 0 && version(baseVersion) ? { threadId, text: words, baseVersion } : null),
  // Extended guards must be set in the app until the line's confirmation can show them in full.
  'goals.run': ({ threadId, budget, tokenBudget, rubric }) => (tokenBudget === undefined && rubric === undefined && plain(threadId) && Number.isInteger(budget) && (budget as number) >= 1 && (budget as number) <= MAX_BUDGET ? { threadId, budget } : null),
  'schedules.create': ({ projectId, threadId, text: words, when, settings, clientKey, wakeGate }) => {
    if (wakeGate !== undefined) return null;
    const runs = runsAs(settings);
    const fits = plain(projectId) && (threadId === undefined || plain(threadId)) && readable(words) && plain(when) && plain(clientKey) && runs !== null;
    return fits ? { projectId, threadId, text: words, when, settings: runs, clientKey } : null;
  },
};
const carried = (method: unknown): method is keyof typeof CHECK => typeof method === 'string' && Object.hasOwn(CHECK, method);

/** Nothing outward of what the app shows: an endpoint's address can carry a token, so it stays home. */
function shown(method: Method, result: unknown): unknown {
  if (method === 'schedules.get') return redactWakeGates(result as import('../api.ts').Proactivity);
  if (method !== 'settings.model.get') return result;
  const settings = result as ModelSettings;
  const scrub = (value: Omit<ModelSettings, 'shared'>) => {
    if (!value.own) return value;
    const { baseUrl: _kept, ...own } = value.own;
    return { ...value, own };
  };
  return { ...scrub(settings), ...(settings.shared ? { shared: scrub(settings.shared) } : {}) };
}

function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once('connect', () => (probe.destroy(), resolve(true)));
    probe.once('error', () => resolve(false));
  });
}

/** Serve the home's api line. Only the process holding the home calls this (`createHost` refuses a second). */
export async function serveApiLine(options: ApiLineOptions): Promise<ApiLineServer> {
  if (options.projectCreation === true && !options.projectCreationBudget) throw new Error('Project creation requires an owner budget.');
  if (options.attachment === true && !options.attachmentBudget) throw new Error('Attachment requires an owner budget.');
  const projectBudget = options.projectCreationBudget;
  let auditScratchUnavailable=false;
  try{await sweepAuditTemporary();}catch{
    auditScratchUnavailable=true;
    process.stderr.write('Audit scratch cleanup failed; the API line remains available; audit export needs a repaired scratch parent.\n');
  }
  const path = apiSocket(options.home);
  assertHomeWriteAdmission(options.home,dirname(path));
  const waitMs = options.confirmWaitMs ?? CONFIRM_WAIT_MS;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // Not ours to change: refused just below.
  }
  if (!ownFolder(path)) throw new Error(`${dirname(path)} is not this user's alone, so the api line is not served there.`);
  if (existsSync(path)) {
    if (await answers(path)) throw new Error('Another process already serves this data folder\'s api line.');
    rmSync(path, { force: true });
  }

  /** Only a No stands, held in this process: it stops a caller asking again until the host restarts. One No closes every asked write. */
  let sends: SendState = options.confirm ? 'ask' : 'closed';
  let questions: Promise<unknown> = Promise.resolve();
  const live = new Set<AbortController>();

  /** One question at a time, each about one write: callers wait their turn. */
  function decide(ask: LineAsk, gone: () => boolean): Promise<'yes' | 'no' | 'unanswered'> {
    const turn = questions.then(async () => {
      if (gone()) return 'unanswered' as const;
      if (sends === 'closed') return 'no' as const;
      const asking = new AbortController();
      live.add(asking);
      const timer = setTimeout(() => asking.abort(), waitMs);
      try {
        const yes = await options.confirm!(ask, asking.signal);
        if (asking.signal.aborted) return 'unanswered' as const;
        if (!yes) sends = 'closed';
        return yes ? ('yes' as const) : ('no' as const);
      } catch {
        return 'unanswered' as const;
      } finally {
        clearTimeout(timer);
        live.delete(asking);
      }
    });
    questions = turn.catch(() => {});
    return turn;
  }

  type Resolved = { ask: LineAsk; args: object };
  const runsOf = (t: TurnSettings): Runs => ({ ...(memoryIsOff(t) ? { memory: 'off' as const } : {}), permission: t.permission, model: t.model, effort: t.effort, mode: t.mode, runsOn: t.runsOn });
  /**
   * The chat's chosen route a turn with these settings continues on, as the host's admission decides it
   * (selection/pin.ts): shown, and pinned as `continues`, so the host refuses the write if it moved.
   * A new chat has none. Refused when the chat's route cannot run the turn as asked, or cannot be shown whole.
   */
  const chosenFor = (t: Thread | undefined, s: TurnSettings): { runs: Runs; continues: ShownSelection } | Receipt<never> => {
    const base = t && continuedSelection(t.turns);
    if (!base) return { runs: runsOf(s), continues: null };
    const kept = withNamedModel(base, s.model, !!t.child?.model);
    if ('refused' in kept) return refusal('NOT_AVAILABLE', kept.refused);
    const { pinned, task } = kept.selection;
    if (!plain(pinned.label) || !plain(pinned.model)) return refusal('INVALID', UNSHOWABLE);
    const limits = `${task.network ? 'may reach the network' : 'may not reach the network'}, may spend ${task.spend === 'none' ? 'nothing' : task.spend === 'metered' ? 'metered usage' : task.spend}`;
    return { runs: { ...runsOf(s), model: pinned.model, route: `${pinned.label}, chosen for this chat's task, which ${limits}` }, continues: shownOf(kept.selection) };
  };
  const thread = async (id: Id): Promise<Thread | Receipt<never>> => {
    const got = (await options.call('threads.get', { id })) as Receipt<Thread>;
    return got.ok ? got.value : (got as Receipt<never>);
  };
  const failed = (v: unknown): v is Receipt<never> => !!v && typeof v === 'object' && 'ok' in v && (v as { ok: unknown }).ok === false;
  /** A name the host holds, shown only if it is one plain line: a name the person cannot read whole is refused, not shown. */
  const threadName = (t: Thread): string | Receipt<never> => (plain(t.summary.title) ? `thread ${JSON.stringify(t.summary.title)} (${t.summary.id})` : refusal('INVALID', UNSHOWABLE));
  async function projectName(id: Id): Promise<string | Receipt<never>> {
    const name = (await options.call('projects.list', {})).find((p) => p.id === id)?.name;
    if (name === undefined) return `unknown (${id})`;
    return plain(name) ? `${JSON.stringify(name)} (${id})` : refusal('INVALID', UNSHOWABLE);
  }
  /** The settings a turn on this chat runs with: a child runs on the model it was admitted on, whatever was asked. */
  const effective = (t: Thread | undefined, s: TurnSettings): TurnSettings => ({ ...s, ...(t?.child ? { model: t.child.settings.model } : {}),
    ...(memoryIsOff(s) || memoryIsOff(t?.child?.settings) || t?.turns.some(turn => memoryIsOff(turn.user.settings)) ? { memory: 'off' as const } : {}),
  });
  /** The chat's goal as the host holds it, if the person could read all of it in the question. */
  const goalShown = (t: Thread): string | Receipt<never> => {
    const goal = t.goal?.current?.text;
    if (goal === undefined || !goal.trim()) return refusal('INVALID', 'Set a goal first; it is what the check judges the work against.');
    return readable(goal) ? goal : refusal('INVALID', GOAL_UNSHOWABLE);
  };

  /**
   * The write resolved as it would run now, from the host's own state: what the question shows, and
   * the exact arguments that run after the click. Nothing is derived again after it.
   */
  async function resolve(method: string, checked: object): Promise<Resolved | Receipt<never>> {
    switch (method) {
      case 'threads.checked': {
        if (!options.unknownChecks) return refusal('NOT_AVAILABLE', 'Open the local desktop app to check this outcome.');
        const input = checked as import('../api.ts').UnknownCheckInput;
        const q = await options.unknownChecks.question(input);
        if (!q.ok) return q;
        if (q.value.revision !== input.revision) return refusal('NOT_AVAILABLE', MOVED);
        return { ask: { method, ...input, question: q.value }, args: input };
      }
      case 'connectors.resolveEffect': {
        if (!options.connectorEffects) return refusal('NOT_AVAILABLE', 'Person-side connector resolution is not connected in this app. Standing signatures remain paused.');
        const input = checked as ConnectorEffectInput;
        const q = await options.connectorEffects.question(input.effect, input.argsHash);
        if (!q.ok) return q;
        if (!readable(q.value.statement) || !q.value.statement.trim()) return refusal('INVALID', UNSHOWABLE);
        return { ask: { method, ...input, statement: q.value.statement }, args: input };
      }
      case 'solutions.run': {
        const { threadId, projectId, text, settings, task, clientKey, caller } = checked as Args<'solutions.run'>;
        const t = threadId === undefined ? undefined : await thread(threadId);
        if (failed(t)) return t;
        const where = t ? threadName(t) : 'a new thread';
        const project = await projectName(projectId);
        if (failed(where)) return where;
        if (failed(project)) return project;
        const compared = await options.call('solutions.options', task);
        const route = compared.choice?.route;
        if (!route) return refusal('NOT_AVAILABLE', compared.limitation ?? 'No route can do this task here.');
        if (!plain(route.label) || !plain(route.model) || !route.fingerprint || !/^[0-9a-f]{64}$/.test(route.fingerprint)) return refusal('NOT_AVAILABLE', 'The selected route cannot be bound to a current destination. Nothing was asked.');
        const runs = effective(t, settings);
        // Native admission honors a named turn model. Refuse a mismatch before approval so the
        // configured model shown here is also the model the initial turn will dispatch.
        if (route.kind === 'native-engine' && !['stub', 'none', route.model].includes(runs.model)) return refusal('NOT_AVAILABLE', 'The requested native model differs from the selected route. Choose that model in Settings, then request this task again. Nothing was asked or started.');
        const approvedRoute = { routeId: route.id, model: route.model, fingerprint: route.fingerprint, spend: route.spends };
        return { ask: { method, projectId, project, threadId, thread: where, text: text.trim(), task, ...runsOf(runs), model: route.model, route: route.label, spend: route.spends, ...(caller ? { caller } : {}) }, args: { projectId, threadId, text: text.trim(), attachments: [], task: { ...task, approvedRoute }, settings: runs, clientKey } };
      }
      case 'turns.send': {
        const { threadId, projectId, text: given, settings, clientKey } = checked as Args<'turns.send'>;
        const words = given.trim();
        if (!words) return refusal('INVALID', BAD_SEND);
        const t = threadId === undefined ? undefined : await thread(threadId);
        if (failed(t)) return t;
        const where = t ? threadName(t) : 'a new thread';
        const project = await projectName(projectId);
        if (failed(where)) return where;
        if (failed(project)) return project;
        const runs = effective(t, settings);
        const chosen = chosenFor(t, runs);
        if (failed(chosen)) return chosen;
        return { ask: { method, projectId, project, ...(threadId === undefined ? {} : { threadId }), thread: where, text: words, ...chosen.runs }, args: { threadId, projectId, text: words, attachments: [], settings: runs, clientKey, continues: chosen.continues } };
      }
      case 'queue.add': {
        const { threadId, text: given, settings, clientKey } = checked as Args<'queue.add'>;
        const words = given.trim();
        const t = await thread(threadId);
        if (failed(t)) return t;
        const where = threadName(t);
        if (failed(where)) return where;
        const runs = effective(t, settings);
        const chosen = chosenFor(t, runs);
        if (failed(chosen)) return chosen;
        return { ask: { method, threadId, thread: where, text: words, ...chosen.runs }, args: { threadId, text: words, attachments: [], settings: runs, clientKey, continues: chosen.continues } };
      }
      case 'goals.set': {
        const { threadId, text: given, baseVersion } = checked as Args<'goals.set'>;
        const words = given.trim();
        const t = await thread(threadId);
        if (failed(t)) return t;
        const where = threadName(t);
        if (failed(where)) return where;
        return { ask: { method, threadId, thread: where, text: words }, args: { threadId, text: words, baseVersion } };
      }
      case 'goals.run': {
        const { threadId, budget } = checked as Args<'goals.run'>;
        const t = await thread(threadId);
        if (failed(t)) return t;
        const where = threadName(t);
        if (failed(where)) return where;
        const goal = goalShown(t);
        if (failed(goal)) return goal;
        // The settings the run would take from the chat now, pinned for every turn of it.
        const runs = runsAs(t.turns.findLast((x) => x.user.settings)?.user.settings ?? GOAL_DEFAULT_SETTINGS);
        if (!runs) return refusal('INVALID', UNSHOWABLE);
        // A goal started from a selected task records that route for its work and its checks: shown and pinned here.
        const chosen = chosenFor(t, runs);
        if (failed(chosen)) return chosen;
        return { ask: { method, threadId, thread: where, budget, goal, ...chosen.runs }, args: { threadId, budget, settings: runs, goal, continues: chosen.continues } };
      }
      case 'schedules.create': {
        const { projectId, threadId, text: given, when: said, settings, clientKey } = checked as Args<'schedules.create'>;
        const words = given.trim();
        const when = said.trim();
        if (!words && threadId === undefined) return refusal('INVALID', BAD_WRITE['schedules.create']);
        const t = threadId === undefined ? undefined : await thread(threadId);
        if (failed(t)) return t;
        const where = t ? threadName(t) : 'a chat of its own';
        const project = await projectName(projectId);
        if (failed(where)) return where;
        if (failed(project)) return project;
        const goal = !words && t ? goalShown(t) : undefined;
        if (failed(goal)) return goal;
        const read = await options.call('schedules.parse', { when });
        if (!read.ok) return read as Receipt<never>;
        if (read.value.nextAt === null) return refusal('INVALID', 'That time has already passed.');
        const runs = effective(t, settings);
        const pinned = { rule: read.value.rule, anchor: read.value.anchor, firstAt: read.value.nextAt, ...(goal === undefined ? {} : { goal }) };
        return {
          ask: { method, projectId, project, ...(threadId === undefined ? {} : { threadId }), thread: where, text: words, ...(goal === undefined ? {} : { goal }), when, summary: read.value.summary, firstRun: read.value.nextAt, ...runsOf(runs) },
          args: { projectId, threadId, text: words, when, settings: runs, clientKey, pinned },
        };
      }
    }
    throw new Error(`${method} is not asked`);
  }

  /** What must be the same at execution as at the click. A schedule's first run and anchor are the host's to hold to (`pinned.firstAt`), since reading the time again moves them. */
  const essence = ({ ask, args }: Resolved) => {
    if (ask.method !== 'schedules.create') return JSON.stringify({ ask, args });
    const { summary: _s, firstRun: _f, ...shown } = ask;
    const { pinned, ...rest } = args as Args<'schedules.create'>;
    return JSON.stringify({ shown, rest, rule: pinned!.rule, goal: pinned!.goal });
  };

  async function carry(method: keyof typeof CHECK, args: Fields, gone: () => boolean): Promise<unknown> {
    if(method==='identity.invite'&&args.role==='admin')return refusal('NOT_AVAILABLE','Invite an administrator in the app. The local API line can invite members and guests only.');
    if (method === 'schedules.create' && Object.hasOwn(args, 'wakeGate')) return refusal('NOT_AVAILABLE', 'Script wake gates require the desktop native confirmation.');
    if (method === 'audit.export' && args.includeContent === true) return refusal('NOT_AVAILABLE', AUDIT_CONTENT_DIRECT_ONLY);
    if(method==='audit.export'&&auditScratchUnavailable)return refusal('NOT_AVAILABLE','Audit export requires a real owned scratch parent with mode 0700 and a socket path within 100 bytes; repair it and restart the API line.');
    const checked = CHECK[method](args);
    if (!checked) {
      if (method === 'material.attach') {
        if (!text(args.name) || !attachmentName(args.name)) return refusal('INVALID', 'That file name cannot be attached.');
        const maxEncoded = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);
        if (text(args.base64) && (args.base64.length > maxEncoded || (args.base64.length === maxEncoded && Buffer.from(args.base64, 'base64').length > MAX_ATTACHMENT_BYTES))) return refusal('INVALID', 'An attachment must be at most 25 MiB. Nothing was attached.');
        return refusal('INVALID', 'An attachment needs a project, a file name, canonical base64 bytes and a media type. Nothing was attached.');
      }
      return refusal('INVALID', method === 'turns.send' ? BAD_SEND : BAD_WRITE[method] ?? BAD_ARGS);
    }
    if ((API_LINE_PROJECTS as readonly string[]).includes(method)) {
      if (options.projectCreation === 'signed-in-app') return refusal('NOT_AVAILABLE', method==='projects.update' ? 'Change the project in the signed-in app. Project changes through this line are unavailable with company sign-in.' : 'Create the project in the signed-in app. Project creation through this line is unavailable with company sign-in.');
      if (!projectBudget!.take()) return refusal('NOT_AVAILABLE', method==='projects.update' ? 'The project change limit for this running process was reached (10 requests per minute, 100 until restart). Nothing was queued. Change the project in the app or try later.' : 'The project creation limit for this running process was reached (10 requests per minute, 100 until restart). Nothing was queued. Create the project in the app or try later.');
    }
    if (method === 'material.attach') {
      if (options.attachment === 'signed-in-app') return refusal('NOT_AVAILABLE', 'Attach the file in the signed-in app. Attachment through this line is unavailable with company sign-in.');
      if (!options.attachmentBudget!.take()) return refusal('NOT_AVAILABLE', 'The attachment limit for this running process was reached (10 requests per minute, 100 until restart). Nothing was queued. Nothing was attached. Try later, or stop the app or background service holding this data folder and attach through a standalone data folder.');
    }
    if (!ASKED.has(method) && method !== 'connectors.resolveEffect' && method !== 'threads.checked') return shown(method, await options.call(method, checked as never));
    // Closed: nothing is read for a question nobody will be shown.
    if (sends === 'closed') return refusal('NOT_AVAILABLE', CLOSED);
    const resolved = await resolve(method, checked);
    if (failed(resolved)) return resolved;
    const said = await decide(resolved.ask, gone);
    if (said === 'no') return refusal('NOT_AVAILABLE', CLOSED);
    if (said === 'unanswered') return refusal('NOT_AVAILABLE', NO_ANSWER);
    // A caller gone by now cannot be told what came of it, so nothing starts in its name.
    if (gone()) return refusal('NOT_AVAILABLE', NO_ANSWER);
    // What runs is what was shown: if the chat's goal, a child's model, its latest settings or a name
    // moved while the question was up (another question ahead of it included), nothing runs.
    const now = await resolve(method, checked);
    if (failed(now) || essence(now) !== essence(resolved)) return refusal('NOT_AVAILABLE', MOVED);
    if (method === 'threads.checked') return options.unknownChecks!.check(resolved.args as import('../api.ts').UnknownCheckInput);
    if (method === 'connectors.resolveEffect') return options.connectorEffects!.resolve(resolved.args as ConnectorEffectInput);
    return shown(method, await options.call(method, resolved.args as never));
  }

  const open = new Set<Socket>();
  // One partial original at a time; all other connections retain the ordinary byte bound.
  let largeFrame: Socket | undefined;
  const server: Server = createServer((socket) => {
    open.add(socket);
    // A continuation belongs to the connection that received it. Even another same-user
    // process with a stolen token cannot renew it. A dead client relinquishes its read slot.
    const audits=new Map<string,Fields>();
    const cancelAudit=(session:string,args:Fields)=>options.call('audit.export',{...args,session,cancel:true} as never).catch(()=>{});
    socket.once('close',()=>{for(const [session,args]of audits)void cancelAudit(session,args);audits.clear();});
    let parts: string[] = [];
    let frameBytes = 0;
    let prefix = '';
    let greeted = false;
    // A sender that stalls or drips must not keep the one slot from the person's real attachment.
    const frameWait = options.attachmentFrameWaitMs ?? { idle: 15_000, total: 120_000 };
    let frameIdle: NodeJS.Timeout | undefined, frameTotal: NodeJS.Timeout | undefined;
    const releaseFrame = () => {
      parts = [];frameBytes = 0;prefix = '';
      clearTimeout(frameIdle);clearTimeout(frameTotal);frameIdle = frameTotal = undefined;
      if (largeFrame === socket) largeFrame = undefined;
    };
    const gone = () => socket.destroyed;
    const answer = (line: object) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(line)}\n`);
    };
    const take = (message: Fields, frameLength: number) => {
      if (!greeted) {
        if (frameLength >= MAX_LINE) return socket.destroy();
        if (message.api !== API_LINE_PROTOCOL) return socket.destroy();
        greeted = true;
        const hello: HelloAnswer = { ready: true, send: sends, serverPid: process.pid };
        return answer(hello);
      }
      const { id, method, args } = message;
      if (typeof id !== 'number') return socket.destroy();
      if (!carried(method)) {
        const sharedModel = method === 'settings.model.put' && (args as Args<'settings.model.put'>)?.change?.route === 'shared';
        const detail = !sharedModel ? OFF_LINE : options.holder === 'background-service'
          ? 'The background service holds this data folder, so the shared model was not changed. Stop the background service, run backbone model shared local --endpoint <loopback-url> --model <model>, then start it again.'
          : options.holder === 'other'
          ? 'Another process holds this data folder, so the shared model was not changed. Stop it, run the command, then start it again.'
          : 'The app holds this data folder, so the shared model was not changed. Choose Settings › AI and models › Shared work, or close the app, run the command, then open it again.';
        return answer({ id, result: refusal('NOT_AVAILABLE', detail) as Receipt<never> });
      }
      if ((API_LINE_PROJECTS as readonly string[]).includes(method) && !options.projectCreation) return answer({id,result:refusal('NOT_AVAILABLE',OFF_LINE)});
      if ((API_LINE_ATTACHMENTS as readonly string[]).includes(method) && !options.attachment) return answer({id,result:refusal('NOT_AVAILABLE',OFF_LINE)});
      if ((API_LINE_TEAM as readonly string[]).includes(method)&&!options.teamManagement) return answer({id,result:refusal('NOT_AVAILABLE',OFF_LINE)});
      if (options.readOnly && CHANGES.has(method)) return answer({ id, result: refusal('NOT_AVAILABLE', READS_ONLY) as Receipt<never> });
      if (method !== 'material.attach' && frameLength >= MAX_LINE) return answer({id,result:refusal('INVALID',BAD_ARGS)});
      const fields = args && typeof args === 'object' && !Array.isArray(args) ? (args as Fields) : {};
      // A throw's words are the core's and may name a connection; only that it failed crosses.
      if(method==='audit.export'&&typeof fields.session==='string'&&!audits.has(fields.session))return answer({id,result:refusal('INVALID','This audit session belongs to another connection or has ended.')});
      void carry(method, fields, gone).then(async result => {
        if(method==='audit.export'){
          const page=result as Receipt<{session:string|null}>;
          if(page.ok&&typeof fields.session==='string')audits.delete(fields.session);
          if(page.ok&&page.value.session){
            if(gone())await cancelAudit(page.value.session,fields);
            else audits.set(page.value.session,fields);
          }
        }
        answer({id,result});
      }, () => answer({ id, failed: true }));
    };
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {open.delete(socket);releaseFrame();});
    socket.on('data', (chunk: string) => {
      // Split only the new chunk, never flatten/rescan the growing base64 body per chunk.
      let from = 0;
      while (from < chunk.length) {
        const at = chunk.indexOf('\n', from);
        const fragment = chunk.slice(from, at < 0 ? undefined : at);
        frameBytes += Buffer.byteLength(fragment, 'utf8');
        if (prefix.length < 128) prefix += fragment.slice(0, 128 - prefix.length);
        if (frameBytes >= MAX_LINE) {
          // The existing client announces the method before args. Only that bounded header
          // can lift the ceiling; no large JSON parse is needed to discover the method.
          const announced = /^\{"id":\d{1,16},"method":"material\.attach","args":/.test(prefix);
          if (!greeted || options.attachment !== true || !announced || frameBytes >= MAX_ATTACHMENT_LINE || (largeFrame && largeFrame !== socket)) return socket.destroy();
          largeFrame = socket;
          clearTimeout(frameIdle);frameIdle = setTimeout(() => socket.destroy(), frameWait.idle);
          frameTotal ??= setTimeout(() => socket.destroy(), frameWait.total);
        }
        parts.push(fragment);
        if (at < 0) return;
        const line = parts.join('');
        const length = frameBytes;
        releaseFrame();
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return socket.destroy();
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return socket.destroy();
        take(message as Fields, length);
        if (socket.destroyed) return;
        from = at + 1;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  server.unref();
  return {
    socket: path,
    async close() {
      for (const asking of live) asking.abort();
      const stopped = new Promise((r) => server.close(r));
      for (const socket of open) socket.destroy();
      await stopped;
      rmSync(path, { force: true });
    },
  };
}
