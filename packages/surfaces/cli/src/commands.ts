// What each command asks of the platform api and what it says back. This file holds no policy: the
// platform decides, and every answer is its receipt or projection as it is. The exit code says which:
// only a thing that is known to have gone through is 0, and an UNKNOWN is never that.
import { RemoteError } from '@backbone-next/platform/remote/client';
import { isCutOffFinish, terminalModelHint } from '@backbone-next/platform';
import { attachFile, firstJobCommand } from './first-job.ts';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Args, Effort, HomeExport, Method, Permission, Project, ProjectKind, Receipt, Result, Thread, ThreadSummary, Turn, TurnSettings } from '@backbone-next/platform';

export const EXIT = { OK: 0, REFUSED: 1, USAGE: 2, STOPPED: 3, UNKNOWN: 4, BUSY: 5, FAILED: 6, UNFINISHED: 7 } as const;

export const USAGE = `usage: backbone <command> [--home <data folder>] [--json]

  chat [--thread <thread>] [--project <project>]
               an interactive session: type to send, /help for commands, Ctrl-C stops the turn
  solutions options [--needs model,files] [--network true|false] [--spend none|plan|metered] [--structured] [--evidence <public-topic>]
  solutions run <text> [same constraints] [--project <project>] [--thread <thread>]
  solutions verify <turn> --thread <thread> --deliverable <name>...
  projects list
  projects create <name> [--kind folder|git]
  projects rename <id> <name>
  projects archive <id>
  projects restore <id>
  threads list [--all]
  threads checked <thread> --turn <turn>
  threads show <thread>
  threads archive <thread>
  exec <text> [--json] [--output-schema <file>] [--thread <thread>] [--project <project>]
               one headless turn; JSONL events with --json, a schema-checked final answer when requested
  send <text> [--thread <thread>] [--project <project>] [--attach <path>]...
               [--model <id>] [--effort 1-5] [--permission ask|auto-review|full] [--plan]
  goal <text> [--thread <thread>] [--project <project>] [--budget 1-50]
               set the goal and run it until a check finds it met; send "/goal <text>" does the same
  goal set <text> --thread <thread>
               set or change the thread's goal; it starts no work
  goal run <thread> [--budget 1-50]
               run the thread's goal until a check finds it met, following it
  goal pause <thread>
  goal resume <thread>
  queue <text> --thread <thread> [--model <id>] [--effort 1-5] [--permission ...] [--plan]
               sent when the thread's turn in hand ends, or now if none runs
  schedule add <text> --when <words> [--thread <thread>] [--project <project>] [--model <id>] ...
               run this on a schedule: "every day at 9:00", a cron line, or one moment
  stop [<thread>]
  now [--project <project>]
  files [--project <project>]
  models
  engine [pi|codex|acp|stub]          show or store the engine for this data folder (next process)
  model codex --model <id>
  model shared local --endpoint <loopback-url> --model <id> [--runtime ollama|lmstudio|llamacpp|vllm|other]
  model local --endpoint <loopback-url> --model <id> [--runtime ollama|lmstudio|llamacpp|vllm|other]
  files attach <path> [--project <project>]
  files read <name-or-id> [--version <n>] [--project <project>]
  files save <name-or-id> --base-version <n> [--from <edited-file>] [--project <project>]
               without --from, accept the text version you read; a Save creates a person version
  import codex|claude|<file.md>     copy memories in, read-only, with their source kept
  export <folder>                   your work in plain files: no credential, database or authority
  audit export [<file>|-] --since <instant> --until <instant> [--after <event id>] [--limit <source rows>] [--include-content] [--scratch-root <directory>]
  audit verify <file> [--previous <file>]   offline integrity check, no data folder required
  restore <folder> [--dry-run]      an export into a new, empty data folder, as you would add it yourself
  status                            who holds the data folder, and what runs on its own
  join [<link>] [--name <name>]       join a shared workspace on another computer
  remote projects|threads          list shared work (--project <id> filters threads)
  remote read <thread>             read a shared conversation
  remote send <text>               send and read the answer (--project <id> or --thread <id>)
  remote events|leave              follow workspace changes, or sign out
  team invite [--role member|guest]   create one join link on the owner computer
  team people                      list people and their IDs
  team share <project> --person <id> --access viewer|editor|none
  team remove <person>             remove a colleague
  daemon run [--share <ip:port>]    hold the data folder without the app, so schedules and goals go on
  daemon install|uninstall|status   the daemon as a launchd agent for this user (macOS)
  channels connect slack|telegram|discord|teams
                                   read token/password and verification/registration from stdin (two lines)
  channels bind                    print a one-time account binding code
  channels unbind                  end all channel account bindings
  telemetry endpoint <url>         set the full OTLP traces URL for this data folder
  telemetry header                 read collector headers as a JSON object from stdin and seal them
  telemetry off                    disable telemetry for this data folder
  connectors resolve <effect> --args-hash <hash> --answer happened|did_not_happen|keep_closed
               asks you in the running app; never dispatches the call again
  policy verify <file>             verify a candidate against protected system trust
  policy show                      show the effective signed machine policy
  notices [--json]                  bundled licence and notice text; no data folder required
  doctor

The data folder comes from --home or BACKBONE_HOME.
With the app running, each send, queue, goal set, goal run and schedule add waits for you to allow it there.
Exit codes: 0 done, 1 refused, 2 usage, 3 stopped, 4 unknown, 5 the data folder is held by another process, 6 failed, 7 unfinished answer.\nA goal exits 0 when met and 3 when it waits for you: blocked, out of budget, paused or interrupted.`;

export interface Api {
  call<M extends Method>(method: M, args: Args<M>): Promise<Result<M>>;
}

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Called once on the person's interrupt. */
  onInterrupt(fn: () => void): void;
  /** The thread this process's send is carrying, so a `stop` elsewhere can find it. */
  holding(thread: string): void;
  pollMs: number;
  /** How long a stop may take to settle before what came of it counts as unknown. */
  stopWaitMs: number;
  /** The api is a running app's, over its line: a running turn there is live, not one a kill left. */
  live?: boolean;
  /** Headless projection of the same send; observers never grant or retry work. */
  turn?: {
    started(threadId: string, turnId: string): void;
    updated(turn: Turn): void;
    ended(turn: Turn): void;
  };
}

export interface Parsed {
  /** Why the command line is not usable; the rest is then meaningless. */
  usage?: string;
  help?: boolean;
  name: string;
  home: string;
  json: boolean;
  target?: string;
  options: {
    task?: Args<'solutions.options'>; deliverables?: string[];
    outputSchema?: string;
    endpoint?: string; runtime?: string; attach?: string[]; from?: string; version?: number; baseVersion?: number;
    turnId?: string;
    argsHash?: string; connectorAnswer?: 'happened' | 'did_not_happen' | 'keep_closed';
    share?:string; name?:string; person?:string; access?:'viewer'|'editor'|'none'; role?:'admin'|'member'|'guest';
    channelPort?: number;
    scratchRoot?: string; since?: string; until?: string; after?: string; limit?: number; includeContent?: boolean; previous?: string;
    kind: ProjectKind;
    all: boolean;
    thread?: string;
    project?: string;
    model?: string;
    effort: Effort;
    permission: Permission;
    plan: boolean;
    /** The most turns of work a goal run starts. */
    budget: number;
    /** restore: say what would happen, and change nothing. */
    dryRun: boolean;
    /** schedule add: the person's words for when. */
    when?: string;
  };
}

const KINDS: readonly string[] = ['folder', 'git'];
const PERMISSIONS: readonly string[] = ['ask', 'auto-review', 'full'];
/** Commands and whether the words after them are required. */
const COMMANDS: Record<string, 'none' | 'one' | 'optional' | 'text' | 'folder'> = {
  'connectors resolve': 'one',
  'solutions options': 'none', 'solutions run': 'text', 'solutions verify': 'one',
  chat: 'none',
  'projects list': 'none',
  'projects create': 'text',
  'projects rename': 'text',
  'projects archive': 'one',
  'projects restore': 'one',
  'threads list': 'none',
  'threads checked': 'one',
  'threads show': 'one',
  'threads archive': 'one',
  send: 'text',
  exec: 'text',
  goal: 'text',
  'goal set': 'text',
  'goal run': 'one',
  queue: 'text',
  'schedule add': 'text',
  'goal pause': 'one',
  'goal resume': 'one',
  stop: 'optional',
  now: 'none',
  files: 'none',
  models: 'none',
  engine: 'optional', model: 'one', 'files attach': 'one', 'files read': 'one', 'files save': 'one',
  import: 'text',
  export: 'folder',
  restore: 'folder',
  status: 'none',
  join:'optional', 'remote projects':'none','remote threads':'none','remote read':'one','remote send':'text','remote leave':'none','remote events':'none',
  'team invite':'none','team people':'none','team share':'one','team remove':'one',
  'daemon run': 'none',
  'daemon install': 'none',
  'daemon uninstall': 'none',
  'daemon status': 'none',
  'audit export': 'optional',
  'audit verify': 'one',
  'channels connect': 'one',
  'channels bind': 'none',
  'channels unbind': 'none',
  'telemetry endpoint': 'one',
  'telemetry header': 'none',
  'telemetry off': 'none',
  'policy verify': 'one',
  'policy show': 'none',
  notices: 'none',
  doctor: 'none',
};

export function parse(argv: string[], env: NodeJS.ProcessEnv = process.env): Parsed {
  const blank = (usage?: string): Parsed => ({ usage, name: '', home: '', json: false, options: { kind: 'folder', all: false, effort: 3, permission: 'ask', plan: false, budget: 5, dryRun: false } });
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        needs: { type: 'string', default: 'model,files' }, network: { type: 'string', default: 'true' }, spend: { type: 'string', default: 'metered' }, structured: { type: 'boolean', default: false }, evidence: { type: 'string' }, deliverable: { type: 'string', multiple: true },
        'output-schema': { type: 'string' },
        endpoint: { type: 'string' }, runtime: { type: 'string' }, attach: { type: 'string', multiple: true }, from: { type: 'string' }, version: { type: 'string' }, 'base-version': { type: 'string' },
        'scratch-root': { type: 'string' }, limit: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, after: { type: 'string' },
        'include-content': { type: 'boolean' }, previous: { type: 'string' },
        share:{type:'string'}, name:{type:'string'}, person:{type:'string'}, access:{type:'string'}, role:{type:'string'},
        home: { type: 'string' },
        turn: { type: 'string' },
        'args-hash': { type: 'string' }, answer: { type: 'string' },
        port: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        kind: { type: 'string', default: 'folder' },
        all: { type: 'boolean', default: false },
        thread: { type: 'string' },
        project: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string', default: '3' },
        permission: { type: 'string', default: 'ask' },
        plan: { type: 'boolean', default: false },
        budget: { type: 'string', default: '5' },
        'dry-run': { type: 'boolean', default: false },
        when: { type: 'string' },
      },
    });
  } catch (error) {
    return blank((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { ...blank(), help: true };
  const two = positionals.slice(0, 2).join(' ');
  const name = COMMANDS[two] ? two : positionals[0];
  const shape = COMMANDS[name ?? ''];
  if (!shape) return blank(name ? `no command ${two}.` : 'name a command.');
  const words = positionals.slice(name.split(' ').length);
  if(name==='projects rename'&&(words.length<2||!words[0].trim()||!words.slice(1).join(' ').trim()))return blank('projects rename needs a project id and a name.');
  if (shape === 'none' && words.length) return blank(`${name} takes no words after it.`);
  if (shape === 'folder' && words.length !== 1) return blank(`${name} takes one folder.`);
  if (values['dry-run'] && name !== 'restore') return blank('--dry-run is for restore.');
  // The thing a command takes, in plain words, for the messages below.
  const noun = name.startsWith('projects ') || name === 'team share' ? 'project id' : name === 'team remove' ? 'person id' : name.startsWith('audit ') ? 'file' : 'thread';
  if (shape === 'one' && words.some(word => !word.trim()) && name.startsWith('team ')) return blank(`${name} needs a ${noun}.`);
  if ((shape === 'one' || shape === 'optional') && words.length > 1 && !(name === 'model' && words[0] === 'shared' && words.length === 2)) return blank(name === 'telemetry endpoint' ? 'telemetry endpoint takes one URL.' : `${name} takes one ${noun}.`);
  const what: Record<string, string> = { send: 'the text to send', queue: 'the text to send', 'goal set': 'the goal', 'schedule add': 'what each run says' };
  if ((shape === 'one' || shape === 'text') && !words.length) return blank(name === 'telemetry endpoint' ? 'telemetry endpoint needs a full OTLP traces URL.' : shape === 'one' ? `${name} needs ${name.endsWith(' verify') ? 'a file' : `a ${noun}`}.` : `${name} needs ${what[name] ?? 'a name'}.`);
  if ((name === 'goal set' || name === 'queue') && !values.thread) return blank(`${name} needs --thread <thread>.`);
  if(values.share!==undefined&&name!=='daemon run')return blank('--share is for daemon run.');
  if(values.name!==undefined&&name!=='join')return blank('--name is for join.');
  if(values.role!==undefined&&(name!=='team invite'||!['member','guest'].includes(values.role)))return blank('--role is member or guest for team invite. Invite an admin in the app.');
  if((values.person!==undefined||values.access!==undefined)&&name!=='team share')return blank('--person and --access are for team share.');
  if(name==='team share'&&(!values.person||!['viewer','editor','none'].includes(values.access??'')))return blank('team share needs --person <id> and --access viewer|editor|none.');
  if (values.when !== undefined && name !== 'schedule add') return blank('--when is for schedule add.');
  if (name === 'schedule add' && !values.when) return blank('schedule add needs --when <words>, such as "every day at 9:00".');
  if (values.port!==undefined && (name!=='channels connect'||!/^\d+$/.test(values.port)||Number(values.port)>65535)) return blank('--port is 0 to 65535, for channels connect.');
  if (name === 'audit export' && (!values.since || !values.until)) return blank('audit export requires --since and --until.');
  if ([values['scratch-root'], values.since, values.until, values.after, values.limit, values['include-content']].some(v => v !== undefined) && name !== 'audit export') return blank('--since, --until, --after and --include-content are for audit export.');
  if (values.limit !== undefined && (!/^[1-9][0-9]*$/.test(values.limit) || !Number.isSafeInteger(Number(values.limit)))) return blank('--limit must be a positive safe integer.');
  if (name === 'threads checked' && !values.turn) return blank('threads checked needs --turn <turn>.');
  if (values.turn !== undefined && name !== 'threads checked') return blank('--turn is for threads checked.');
  if (name === 'connectors resolve' && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(words[0] ?? '') || !/^[0-9a-f]{64}$/.test(values['args-hash'] ?? '') || !['happened', 'did_not_happen', 'keep_closed'].includes(values.answer ?? ''))) return blank('connectors resolve needs an effect UUID, --args-hash and --answer happened|did_not_happen|keep_closed.');
  if ((values['args-hash'] !== undefined || values.answer !== undefined) && name !== 'connectors resolve') return blank('--args-hash and --answer are for connectors resolve.');
  if (values.previous !== undefined && name !== 'audit verify') return blank('--previous is for audit verify.');
  if (values['output-schema'] !== undefined && name !== 'exec') return blank('--output-schema is for exec.');
  if (name === 'exec' && /^\/goal(?:\s|$)/.test(words.join(' ').trim())) return blank('exec runs one turn; use goal for a goal run.');
  if (values.attach && name !== 'send' && name !== 'exec') return blank('--attach is for send; use files attach to attach separately.');
  if (name === 'model' && (!['codex', 'local', 'shared local'].includes(words.join(' ')) || !values.model || (words.at(-1) === 'local' && !values.endpoint))) return blank('use model codex --model <id>, model local --endpoint <loopback-url> --model <id>, or model shared local --endpoint <loopback-url> --model <id>. Hosted keys are added in the app Settings > AI and models; never type them into CLI arguments.');
  if ((values.endpoint || values.runtime) && name !== 'model') return blank('--endpoint and --runtime are for model local.');
  if (values.from && name !== 'files save') return blank('--from is for files save.');
  if (values.version && name !== 'files read') return blank('--version is for files read.');
  if (values['base-version'] && name !== 'files save') return blank('--base-version is for files save.');
  for (const v of [values.version, values['base-version']]) if (v !== undefined && (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v)))) return blank('a document version is a positive safe integer.');
  if (name === 'files save' && !values['base-version']) return blank('files save needs --base-version <version-you-read>.');
  if (!KINDS.includes(values.kind)) return blank('--kind is folder or git.');
  if (!PERMISSIONS.includes(values.permission)) return blank('--permission is ask, auto-review or full.');
  const supplied = (flags: string[]) => argv.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  if (supplied(['--needs', '--network', '--spend', '--structured']) && !['solutions options', 'solutions run'].includes(name)) return blank('task constraints are for solutions options or solutions run.');
  if (values.evidence !== undefined && name !== 'solutions options') return blank('--evidence is for solutions options.');
  if (values.evidence !== undefined && (!values.evidence.trim() || values.evidence.length > 200 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(values.evidence) || values.evidence.startsWith('-'))) return blank('--evidence needs a public topic or record id of at most 200 plain characters.');
  if (values.deliverable !== undefined && name !== 'solutions verify') return blank('--deliverable is for solutions verify.');
  if (name === 'solutions run' && !supplied(['--spend'])) values.spend = 'none';
  if (name.startsWith('solutions ')) {
    if (!['true', 'false'].includes(values.network)) return blank('--network is true or false.');
    if (!['none', 'plan', 'metered'].includes(values.spend)) return blank('--spend is none, plan or metered.');
    if (values.needs.split(',').length > 4 || !values.needs.split(',').every((n) => ['model', 'code', 'files', 'mail'].includes(n))) return blank('--needs lists model, code, files or mail.');
    if (name === 'solutions verify' && (!values.thread || !values.deliverable?.length)) return blank('solutions verify needs --thread and --deliverable.');
  }
  const effort = Number(values.effort);
  if (![1, 2, 3, 4, 5].includes(effort)) return blank('--effort is 1 to 5.');
  const budget = Number(values.budget);
  if (!Number.isInteger(budget) || budget < 1 || budget > 50) return blank('--budget is 1 to 50 turns.');
  const home = values.home || env.BACKBONE_HOME || ((name==='join'||name.startsWith('remote '))?join(env.BACKBONE_USER_HOME??homedir(),'.local','share','backbone'):undefined) || (name === 'notices' || name === 'audit verify' || name.startsWith('policy ') ? '' : undefined);
  if (!home && name !== 'notices' && name !== 'audit verify' && !name.startsWith('policy ')) return blank('name the data folder with --home or BACKBONE_HOME.');
  return {
    name,
    home: home!,
    json: values.json,
    target: (name==='projects rename'?words[0]:words.join(' ')) || undefined,
    options: {
      ...(name.startsWith('solutions ') ? { task: { needs: values.needs.split(',') as Args<'solutions.options'>['needs'], network: values.network === 'true', spend: values.spend as Args<'solutions.options'>['spend'], structured: values.structured, ...(values.evidence ? { evidenceQuery: values.evidence } : {}) }, deliverables: values.deliverable } : {}),
      share:values.share,name:name==='projects rename'?words.slice(1).join(' '):values.name,person:values.person,access:values.access as Parsed['options']['access'],role:values.role as Parsed['options']['role'],
      outputSchema: values['output-schema'],
      endpoint: values.endpoint, runtime: values.runtime, attach: values.attach, from: values.from, version: values.version === undefined ? undefined : Number(values.version), baseVersion: values['base-version'] === undefined ? undefined : Number(values['base-version']),
      turnId: values.turn, argsHash: values['args-hash'], connectorAnswer: values.answer as Parsed['options']['connectorAnswer'],
      ...(values.limit===undefined?{}:{limit:Number(values.limit)}), scratchRoot: values['scratch-root'], since: values.since, until: values.until, after: values.after, includeContent: values['include-content'], previous: values.previous,
      ...(values.port===undefined?{}:{channelPort:Number(values.port)}),
      kind: values.kind as ProjectKind,
      all: values.all,
      thread: values.thread,
      project: values.project,
      model: values.model,
      effort: effort as Effort,
      permission: values.permission as Permission,
      plan: values.plan,
      budget,
      dryRun: values['dry-run'],
      ...(values.when === undefined ? {} : { when: values.when }),
    },
  };
}

/** What an export holds and left out, in a person's words. */
export function exported(made: HomeExport): string {
  const c = made.counts;
  return [
    `Exported to ${made.folder}: ${made.files} files.`,
    `${c.projects} projects, ${c.threads} chats, ${c.documents} documents (${c.versions} versions), ${c.memoryFiles} memory files, ${c.skills} skills; ${c.receipts} receipts in a report, ${c.unresolved} unresolved.`,
    `${made.scrubbed} credential value(s) cut out. Never in it:`,
    ...made.excluded.map((e) => `  ${e.what}: ${e.why}`),
  ].join('\n');
}

/** Ends the command with this code once its words are said. */
class Ended extends Error {
  readonly code: number;
  constructor(code: number) {
    super('ended');
    this.code = code;
  }
}

const say = (r: { reason: string; detail: string; outcome: 'REFUSED' | 'UNKNOWN' }) => `${r.outcome === 'UNKNOWN' ? 'Unknown outcome' : r.outcome} (${r.reason}): ${terminalModelHint(r.detail)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCommand(parsed: Parsed, api: Api, io: Io): Promise<number> {
  const { json, options, target } = parsed;
  const show = (value: unknown, text: () => string) => io.out(json ? JSON.stringify(value, null, 2) : text());
  const refuse = (detail: string, reason = 'NOT_FOUND'): never => {
    io.err(say({ reason, detail, outcome: 'REFUSED' }));
    throw new Ended(EXIT.REFUSED);
  };
  const usage = (detail: string): never => {
    io.err(`backbone: ${detail}`);
    throw new Ended(EXIT.USAGE);
  };
  /** The value of a receipt; a refusal or an UNKNOWN ends the command, in the platform's words. */
  const value = <T>(receipt: Receipt<T>): T => {
    if (receipt.ok) return receipt.value;
    io.err(say(receipt));
    throw new Ended(receipt.outcome === 'UNKNOWN' ? EXIT.UNKNOWN : EXIT.REFUSED);
  };
  /** A command that changes something: a call that throws may have gone through, so it is UNKNOWN, and it is not repeated. */
  const changing = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof Ended) throw error;
      if(error instanceof RemoteError){io.err(error.message);throw new Ended(error.outcome==='REFUSED'?EXIT.REFUSED:EXIT.UNKNOWN);}
      io.err(`Unknown outcome (NOT_AVAILABLE): the call was lost, so whether it happened is not known; read it back before doing it again. ${(error as Error).message}`);
      throw new Ended(EXIT.UNKNOWN);
    }
  };
  const thread = async (id: string): Promise<Thread> => value(await api.call('threads.get', { id }));

  async function project(): Promise<Project> {
    const all = await api.call('projects.list', {});
    if (options.project) return all.find((p) => p.id === options.project || p.name === options.project) ?? refuse(`No project ${options.project}.`);
    if (!all.length) refuse('There is no project yet; make one with: backbone projects create <name>.');
    const active=all.filter(project=>!project.archived);
    if (!active.length) refuse('There is no active project; restore one or make one with: backbone projects create <name>.');
    if (active.length > 1) usage(`name one of ${active.length} projects with --project.`);
    return active[0];
  }

  /** What a settled turn came to, said once. Effects first: they are what happened. */
  function outcome(turn: Turn): number {
    io.turn?.ended(turn);
    for (const e of turn.effects) {
      const line = `${e.outcome === 'UNKNOWN' ? 'Unknown outcome' : e.outcome} ${e.kind} ${e.target}${e.detail ? `: ${e.detail}` : ''}`;
      if (!json) (e.outcome === 'DONE' ? io.out : io.err)(line);
    }
    if (!json && turn.answer && turn.status !== 'refused') io.out(turn.answer.text);
    if (json) io.out(JSON.stringify(turn, null, 2));
    if (turn.effects.some((e) => e.outcome === 'UNKNOWN')) {
      io.err('Unknown outcome: a write has no known outcome. It is not sent again; a person settles it.');
      return EXIT.UNKNOWN;
    }
    if (turn.status === 'running') {
      io.err('Unknown outcome: the turn had not settled when this stopped waiting.');
      return EXIT.UNKNOWN;
    }
    if (turn.status === 'stopped') {
      if (turn.failure) {
        const unfinished = isCutOffFinish(turn.work.finishReason);
        io.err(`${unfinished ? 'UNFINISHED' : 'FAILED'}: ${turn.failure.detail}`);
        return unfinished ? EXIT.UNFINISHED : EXIT.FAILED;
      }
      io.err('STOPPED: the turn was stopped before it finished.');
      return EXIT.STOPPED;
    }
    if (turn.status === 'refused') {
      io.err(say({ reason: turn.refusal?.reason ?? 'NOT_AVAILABLE', detail: turn.refusal?.detail ?? 'The turn was refused.', outcome: 'REFUSED' }));
      return EXIT.REFUSED;
    }
    return turn.effects.every((e) => e.outcome === 'DONE') ? EXIT.OK : EXIT.REFUSED;
  }

  /** Follow a turn until it settles, printing its work as it goes. `stopAsked` starts the clock on it. */
  async function follow(threadId: string, turnId: string, stopAsked: () => number | null): Promise<Turn> {
    let printed: string[] = [];
    let before: string[] = [];
    for (;;) {
      const turn = (await thread(threadId)).turns.find((t) => t.id === turnId);
      if (!turn) refuse(`Turn ${turnId} is not in thread ${threadId}.`);
      io.turn?.updated(turn!);
      const { steps } = turn!.work;
      // The engine's words grow in place as it writes them. The last note of a running turn waits until
      // two reads in a row agree, so each note is said once, whole, and not as a run of growing prefixes.
      if (!json) {
        for (const [i, step] of steps.entries()) {
          const growing = turn!.status === 'running' && i === steps.length - 1 && step.kind === 'note' && before[i] !== step.label;
          if (printed[i] !== step.label && !growing) { io.out(`  ${step.label}`); printed[i] = step.label; }
        }
      }
      before = steps.map((s) => s.label);
      const asked = stopAsked();
      if (turn!.status !== 'running' || (asked !== null && Date.now() - asked > io.stopWaitMs)) return turn!;
      await sleep(io.pollMs);
    }
  }

  /** How a turn this command starts runs: the options given, and the first model offered unless one is named. */
  async function turnSettings(): Promise<TurnSettings> {
    const model = options.model ?? (await api.call('models.list', {}))[0]?.id ?? 'none';
    return { permission: options.permission, model, effort: options.effort, runsOn: 'this-computer', mode: options.plan ? 'plan' : 'chat' };
  }

  async function send(): Promise<number> {
    const text = target as string;
    const asGoal = /^\/goal\s+([\s\S]+)$/.exec(text.trim());
    if (asGoal && parsed.name === 'send') return goal(asGoal[1].trim());
    const existing = options.thread ? await thread(options.thread) : undefined;
    const projectId = existing?.summary.projectId ?? (await project()).id;
    const settings = await turnSettings();
    const attachments: string[] = [];
    for (const path of options.attach ?? []) attachments.push(value(await changing(() => attachFile(api, projectId, path))).id);
    const args = { threadId: options.thread, projectId, text, attachments, settings, clientKey: randomUUID() };
    let started: { threadId: string; turnId: string };
    if (parsed.name === 'solutions run') {
      const run = value(await changing(() => api.call('solutions.run', { ...args, task: options.task! })));
      if (!run.started) { show(run, () => run.detail); return EXIT.REFUSED; }
      if (!json) {
        io.out(run.detail);
        for (const option of [...run.selection.feasible, ...run.selection.excluded]) io.out(`${option.route.label}: ${option.reasons.join('; ')}`);
      }
      started = run.started;
    } else started = value(await changing(() => api.call('turns.send', args)));
    const { threadId, turnId } = started;
    let asked: number | null = null;
    io.onInterrupt(() => {
      asked = Date.now();
      void api.call('turns.stop', { threadId }).catch(() => {});
    });
    io.holding(threadId);
    io.turn?.started(threadId, turnId);
    if (!json) io.out(`thread ${threadId}`);
    const finished = await changing(() => follow(threadId, turnId, () => asked));
    if (!json && parsed.name === 'solutions run') io.out(finished.selection?.ran ? `Dispatched to: ${finished.selection.ran.label}` : 'No model dispatch was observed.');
    return outcome(finished);
  }

  /**
   * The app composer's /goal: with no thread, the words start a chat; then they are its goal, run until
   * a check finds it met. This process carries the run and follows it, printing each check. Ctrl-C
   * pauses the run and stops the turn in hand.
   */
  async function goal(text: string): Promise<number> {
    let threadId = options.thread;
    if (!threadId) {
      const projectId = (await project()).id;
      const settings = await turnSettings();
      threadId = value(await changing(() => api.call('turns.send', { projectId, text, attachments: [], settings, clientKey: randomUUID() }))).threadId;
    }
    const id = threadId;
    io.holding(id);
    const before = await thread(id);
    value(await changing(() => api.call('goals.set', { threadId: id, text, baseVersion: before.goal?.version ?? 0 })));
    return runGoal(id, `goal: ${text} · `);
  }

  /** Run the thread's goal within the budget and follow it, printing each check, until it settles. Ctrl-C pauses it and stops the turn in hand. */
  async function runGoal(id: string, said = ''): Promise<number> {
    value(await changing(() => api.call('goals.run', { threadId: id, budget: options.budget })));
    io.onInterrupt(() => {
      void api.call('goals.pause', { threadId: id }).catch(() => {});
      void api.call('turns.stop', { threadId: id }).catch(() => {});
    });
    if (!json) io.out(`thread ${id} · ${said}up to ${options.budget} turns`);
    const checked = new Set<string>();
    for (;;) {
      const t = await thread(id);
      for (const turn of t.turns) {
        if (!turn.judge?.verdict || checked.has(turn.id)) continue;
        checked.add(turn.id);
        if (!json && turn.judge.verdict === 'not-met') io.out(`  check: not met: ${turn.judge.detail}`);
      }
      const run = t.goalRun;
      if (run && run.status !== 'running' && !t.summary.running) {
        if (json) io.out(JSON.stringify(run));
        if (run.status === 'met') { if (!json) io.out(`MET: ${run.evidence?.detail ?? ''}`); return EXIT.OK; }
        if (!json) io.err(`${run.status === 'budget' ? 'OUT OF BUDGET' : run.status.toUpperCase()}: ${run.detail ?? ''}`);
        return EXIT.STOPPED;
      }
      await sleep(io.pollMs);
    }
  }

  async function stop(): Promise<number> {
    if (!target) usage('name the thread to stop.');
    const id = target as string;
    const before = await thread(id);
    const { stopped } = value(await changing(() => api.call('turns.stop', { threadId: id })));
    const last = before.turns.at(-1);
    const asked = Date.now();
    const turn = stopped && last ? await changing(() => follow(id, last.id, () => asked)) : last;
    return settled(id, turn, stopped);
  }

  /** What a stop came to. Reaching the end of the stop is success, unless a write's outcome is not known. */
  function settled(id: string, turn: Turn | undefined, stopped: boolean): number {
    const unknown = turn?.effects.filter((e) => e.outcome === 'UNKNOWN') ?? [];
    show({ thread: id, stopped, status: turn?.status ?? null, unknown: unknown.map((e) => e.target) }, () => (stopped ? `Stopped ${id}: ${turn?.status}.` : `Nothing is running in ${id}.`));
    for (const e of unknown) io.err(`Unknown outcome ${e.kind} ${e.target}${e.detail ? `: ${e.detail}` : ''}`);
    return unknown.length || turn?.status === 'running' ? EXIT.UNKNOWN : EXIT.OK;
  }

  const summaryLine = (t: ThreadSummary) => `${t.id}  ${t.running ? 'running ' : ''}${t.archived ? 'archived ' : ''}${t.title}`;

  function showThread(t: Thread): number {
    show(t, () => {
      const lines = [`${t.summary.title} (${t.summary.id})`];
      for (const turn of t.turns) {
        lines.push(`[${turn.unknownOutcome || turn.unknownChecked ? 'unknown' : turn.status}] ${turn.user.text}`, `  Engine: ${turn.work.harness}${turn.work.finishReason ? ` · finish: ${turn.work.finishReason}` : ''}`, ...turn.work.steps.map((s) => `  ${s.label}`));
        if (turn.unknownChecked) {
          const check = turn.unknownChecked;
          lines.push(turn.unknownCheckedCurrent === false
            ? `Earlier check by ${check.byName ?? check.by} on ${check.at}; the turn changed and this check no longer applies.`
            : `unknown, checked by ${check.byName ?? check.by} on ${check.at}`,
            `  Checker ID: ${check.by}`, ...check.steps.map(s => `  ${s.at}: ${s.label}`));
        }
        if (((!turn.unknownChecked || turn.unknownCheckedCurrent === false) && turn.unknownOutcome) || turn.unknownCheck) lines.push(`Unknown outcome${turn.unknownCheck ? `; use backbone threads checked ${t.summary.id} --turn ${turn.id}` : ''}`);
        // A read settles nothing, so a turn a kill left reads as it was left.
        if (turn.status === 'running') lines.push(io.live ? 'Unknown outcome: this turn is still running in the app, so what it comes to is not known yet.' : 'Unknown outcome: this turn did not finish here. The next command that changes this data folder recovers it.');
        if (turn.answer) lines.push(turn.answer.text);
        if (turn.refusal) lines.push(say({ ...turn.refusal, outcome: 'REFUSED' }));
        lines.push(...turn.effects.map((e) => `${e.outcome === 'UNKNOWN' ? 'Unknown outcome' : e.outcome} ${e.kind} ${e.target}${e.detail ? `: ${e.detail}` : ''}`));
      }
      return lines.join('\n');
    });
    // A turn still running is not settled: live in the app, or here an unfinished recovery.
    return t.turns.some((turn) => turn.status === 'running' || turn.unknownCheck || turn.unknownCheckedCurrent === false || (turn.unknownOutcome && !turn.unknownChecked) || turn.effects.some((e) => e.outcome === 'UNKNOWN')) ? EXIT.UNKNOWN : EXIT.OK;
  }

  async function now(): Promise<number> {
    const work = await api.call('work.now', { projectId: (await project()).id });
    show(work, () => {
      const section = (title: string, rows: string[]) => (rows.length ? [title, ...rows.map((r) => `  ${r}`)] : []);
      const docs = (rows: { name: string; version: number }[]) => rows.map((d) => `${d.name} v${d.version}`);
      const lines = [
        ...section('Needs you', work.needsYou.map((n) => `${n.kind === 'unknown' ? 'Unknown outcome' : n.kind} ${n.title}: ${n.detail}`)),
        ...section('Running', work.running.map((r) => r.title)),
        ...section('Progress', work.progress.map((p) => `${p.title}: ${p.line}`)),
        ...section('Current', docs(work.current)),
        ...section('Temporary', docs(work.temporary)),
        ...section('Retired', docs(work.retired)),
        ...section('Withdrawn', docs(work.withdrawn)),
      ];
      return lines.join('\n') || 'Nothing is going on in this project.';
    });
    return work.needsYou.some((n) => n.kind === 'unknown') ? EXIT.UNKNOWN : EXIT.OK;
  }

  try {
    const first = await firstJobCommand(parsed, api, io, project);
    if (first !== undefined) return first;
    switch (parsed.name) {
      case 'projects list': {
        const all = await api.call('projects.list', {});
        show(all, () => all.map((p) => `${p.id}  ${p.name} (${p.kind})${p.archived ? ' archived' : ''}`).join('\n') || 'No projects yet.');
        return EXIT.OK;
      }
      case 'projects create': {
        const made = value(await changing(() => api.call('projects.create', { name: target as string, kind: options.kind, clientKey: randomUUID() })));
        show(made, () => `Created ${made.name} (${made.id}).`);
        return EXIT.OK;
      }
      case 'projects rename':
      case 'projects archive':
      case 'projects restore': {
        const patch=parsed.name==='projects rename'?{name:options.name!}:{archived:parsed.name==='projects archive'};
        const done=value(await changing(()=>api.call('projects.update',{id:target!,patch})));
        const verb=parsed.name==='projects rename'?'Renamed':parsed.name==='projects archive'?'Archived':'Restored';
        show(done,()=>`${verb} ${done.name} (${done.id}).`);
        return EXIT.OK;
      }
      case 'threads list': {
        const [threads,projects]=await Promise.all([api.call('threads.list',{}),api.call('projects.list',{})]);
        const archivedProjects=new Set(projects.filter(project=>project.archived).map(project=>project.id));
        const all = threads.filter(t=>options.all||(!t.archived&&!archivedProjects.has(t.projectId)));
        show(all, () => all.map(summaryLine).join('\n') || 'No threads.');
        return EXIT.OK;
      }
      case 'threads show':
        return showThread(await thread(target as string));
      case 'threads archive': {
        const done = value(await changing(() => api.call('threads.update', { id: target as string, patch: { archived: true } })));
        show(done, () => `Archived ${done.id}.`);
        return EXIT.OK;
      }
      case 'solutions options': {
        const selection = await api.call('solutions.options', options.task!);
        show(selection, () => [...selection.feasible, ...selection.excluded].map((o) => `${o.route.id}: ${o.route.availability?.state ?? (o.route.eligible ? 'now' : 'setup')} — ${o.route.availability?.detail ?? ''} ${o.reasons.join('; ')}`).join('\n') + `\nChoice: ${selection.choice?.route.id ?? selection.limitation}` + (selection.evidence ? `\nArena: ${selection.evidence.status}. ${selection.evidence.detail}\n${JSON.stringify(selection.evidence.records ?? {})}` : ''));
        return EXIT.OK;
      }
      case 'solutions verify': {
        const checked = value(await api.call('solutions.verify', { threadId: options.thread!, turnId: target!, deliverables: options.deliverables! }));
        show(checked, () => checked.summary);
        return checked.complete ? EXIT.OK : EXIT.UNFINISHED;
      }
      case 'solutions run':
      case 'send':
        return await send();
      case 'goal':
        return await goal(target as string);
      case 'import': {
        const from = target === 'codex' || target === 'claude' ? target : 'file';
        const done = value(await changing(() => api.call('memory.import', { from, ...(from === 'file' ? { path: resolve(target as string) } : {}) })));
        show(done, () => `${done.added} added to memory from ${from === 'file' ? target : from === 'codex' ? 'Codex' : 'Claude'}; the source is unchanged.`);
        return EXIT.OK;
      }
      case 'export': {
        const made = value(await api.call('backup.export', { to: resolve(target as string) }));
        show(made, () => exported(made));
        return EXIT.OK;
      }
      case 'goal set': {
        const id = options.thread as string;
        const before = await thread(id);
        const state = value(await changing(() => api.call('goals.set', { threadId: id, text: target as string, baseVersion: before.goal?.version ?? 0 })));
        show(state, () => `Goal set on ${id}: ${state.current?.text ?? ''}`);
        return EXIT.OK;
      }
      case 'goal run':
        io.holding(target as string);
        return await runGoal(target as string);
      case 'queue': {
        const threadId = options.thread as string;
        const settings = await turnSettings();
        const queued = value(await changing(() => api.call('queue.add', { threadId, text: target as string, attachments: [], settings, clientKey: randomUUID() })));
        show(queued, () => `Queued ${queued.id} in ${threadId}. It is sent when the turn in hand ends, or now if none runs.`);
        return EXIT.OK;
      }
      case 'schedule add': {
        const projectId = options.thread ? (await thread(options.thread)).summary.projectId : (await project()).id;
        const settings = await turnSettings();
        const made = value(await changing(() => api.call('schedules.create', { projectId, ...(options.thread ? { threadId: options.thread } : {}), text: target as string, when: options.when as string, settings, clientKey: randomUUID() })));
        show(made, () => `Scheduled ${made.id}: ${made.summary}, next ${made.nextAt ?? 'none'}. Pause or delete it in the app.`);
        return EXIT.OK;
      }
      case 'goal pause':
      case 'goal resume': {
        const run = value(await changing(() => api.call(parsed.name === 'goal pause' ? 'goals.pause' : 'goals.resume', { threadId: target as string })));
        show(run, () => `Goal ${run.status} in ${run.threadId}.`);
        return EXIT.OK;
      }
      case 'stop':
        return await stop();
      case 'now':
        return await now();
      case 'files': {
        const files = await api.call('files.list', { projectId: (await project()).id });
        show(files, () => files.map(f => `${f.class.padEnd(8)} ${f.path}${f.class === 'unregistered' ? ' · not given to the engine; attach to use it' : ''}${f.current ? ` v${f.current} · ${f.by ?? 'author unknown'}` : ''}${f.current && f.class === 'working' ? ` · not accepted${f.personSaved ? `; person saved v${f.personSaved}` : ''}` : ''}${f.managed ? ' · managed document' : ''}`).join('\n') || 'No files.\nUse backbone files attach <path> to register material.');
        return EXIT.OK;
      }
      case 'models': {
        const models = await api.call('models.list', {});
        const settings = await api.call('settings.model.get', {});
        show({ models, settings }, () =>
          [...models.map((m) => `${m.id}  ${m.label}`), `Engine: ${settings.harness}`, `Route: ${settings.active?.label ?? terminalModelHint(settings.hint ?? 'none')}`, `Shared work: Pi · ${settings.shared?.active?.label ?? 'not configured'}`].join('\n'));
        return EXIT.OK;
      }
      default:
        return usage(`no command ${parsed.name}.`);
    }
  } catch (error) {
    if (error instanceof Ended) return error.code;
    throw error;
  }
}
