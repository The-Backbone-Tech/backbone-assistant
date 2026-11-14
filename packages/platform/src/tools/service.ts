// Connecting a person's AI tools to the MCP door, from the app (Settings › Connect your AI tools).
//
// Declarative, as Kubernetes controllers and Terraform are: for each tool the data home keeps what
// the person chose (connected under grant G, or taken back), and a reconciler converges what is
// actually there toward it, both ways: at connect, at disconnect, at every start, and after any
// failure. Each thing made carries a finalizer (revoke, entry, skills); taking a connection back runs
// them revoke first, and the record stays until every one is done, so a record never goes while its
// grant may be live. The reconciler also repairs drift: an entry removed by hand comes back, and an
// entry pointing at an old path of the app (moved or updated) is rewritten to the door's new path.
//
// Each tool's record is its own file with a revision (compare-and-set, store.ts), and every change
// holds the data home's lock (home-lock.ts), so two apps or the door's own command never overwrite
// each other. A grant is asked for under an intent id recorded first (the outbox pattern): the core
// keeps the id on the mandate, so a grant whose file never appeared is still found and revoked, and a
// revoke counts as done only when the core says no mandate for that id still stands. The expiry the
// person approved is kept as an absolute time and passed unchanged; an intent past it is never granted.
//
// The grant is the person's act through the platform (grantDoor), never through MCP and never
// through the generic api transport: only the process that showed the person the grant calls
// connect. After an update changes the door, the tool asks for the person's approval again, and
// nothing is granted anew without it. Entries start the door inside the app, name only the data
// home, and are called `backbone-door`, or the next free name beside someone else's.
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AiTool, AiToolId, AiTools, ConnectTool, DoorOffer, Receipt } from '../api.ts';
import { CoreCloseWaitRefusal, CoreLink, type CoreOptions } from '../composition/core.ts';
import { grantDoor, readGrant, revokeDoor, standingForIntent } from '../composition/gateway.ts';
import { withHomeLock } from '../composition/home-lock.ts';
import { PIECES, pieceOnDisk } from '../composition/pieces.ts';
import { readJson, sha256, writeAtomic, writeJson } from '../stub/fsx.ts';
import { type Check, type Entry, ENTRY, entryName, MECHANISMS } from './mechanisms.ts';
import { defaultToolEnv, place, TOOL_IDS, type ToolEnv, type ToolPlace } from './places.ts';
import { SKILL } from './skill.ts';
import { readRecord, writeRecord } from './store.ts';

/** The door the installation ships: the command every entry starts (inside the app), and its own folder, registered as it is on disk. */
export interface DoorStart {
  command: string;
  piece: string;
}

/** Granting and revoking a door: the platform's own, or a stand-in a test makes fail. */
export interface ToolDoors {
  grant: typeof grantDoor;
  revoke: typeof revokeDoor;
}

export interface ToolOptions {
  home: string;
  /** The app's name, shown in Claude Desktop's install dialog. */
  label?: string;
  /** The door this installation ships; a checkout's own by default. */
  door?: DoorStart;
  /** Where the tools are looked for; this process's environment by default. */
  env?: ToolEnv;
  doors?: ToolDoors;
  core: Pick<CoreOptions, 'baselineSql' | 'postgresNative' | 'keys'>;
  link: () => Promise<CoreLink>;
}

/** The longest a tool's permission lasts; the person may choose less. */
export const MAX_DAYS = 30;
/** How many `backbone-door-<n>` names are tried beside entries someone else made. */
const NAMES = 20;

type Finalizer = 'revoke' | 'entry' | 'skills';
interface Saved {
  path: string;
  existed: boolean;
  sha256: string | null;
  copy: string | null;
}
/** One tool's connection: what the person chose, and what is owed before the record may go. */
export interface Connection {
  /** The intent id, recorded before the grant is asked for; the core keeps it on the mandate. */
  id: string;
  want: 'connected' | 'absent';
  grant: string;
  /** Our entry's name in the tool's settings. */
  name: string;
  /** What the person approved; `expiresAt` is absolute and passed to the core unchanged. */
  permission: { operations: string[]; ceiling: number; expiresAt: string; askEachCall: boolean };
  /** Cleanup owed, in the order it runs: revoke first. Each is added as soon as its thing may exist. */
  finalizers: Finalizer[];
  /** Skill folders this app made for this tool, and the folders above them it made. */
  skills: { dir: string; made: string[] }[];
  /** The connect has not converged yet: if it fails now, the person's connect did not happen. */
  first: boolean;
  /** Why the last reconcile did not converge, in plain words; null once it did. */
  problem: string | null;
  connectedAt: string;
  savepoint: string;
  written?: string;
  bundle?: string;
}
type Last = { check: Check[]; at: string; note: string };
/** The records as read, with the revision and text each was read at: only changed ones are written, each by compare-and-set. */
interface State {
  tools: Partial<Record<AiToolId, Connection>>;
  revs: Partial<Record<AiToolId, number>>;
  seen: Partial<Record<AiToolId, string>>;
}

const refused = <T>(reason: 'INVALID' | 'NOT_AVAILABLE' | 'NOT_FOUND', detail: string): Receipt<T> => ({ ok: false, reason, detail, outcome: 'REFUSED' });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** While its app was already running when it was connected: it reads its settings only at start. */
const RESTART: Record<AiToolId, string> = {
  'claude-code': '',
  codex: 'Restart the Codex app to use it: quit it and open it again.',
  cursor: 'Restart Cursor to use it.',
  'claude-desktop': '',
};
/** Once connected: a command-line session that was already open keeps its old settings. */
const CONNECTED: Record<AiToolId, string | null> = {
  'claude-code': 'New Claude Code sessions can use it.',
  codex: 'New Codex sessions can use it.',
  cursor: null,
  'claude-desktop': null,
};
const CHECK_WORDS: Record<Check, string> = {
  identical: 'its settings are exactly as they were before connecting',
  'tool-state-only': 'its settings match the save point apart from what the tool itself keeps there',
  'changed-since': 'something else in its settings changed after connecting (not by this app); the copy from before is kept',
  'ours-remains': 'the entry is still there; disconnect again',
};
const PENDING = 'The permission could not be taken back yet. It is tried again when the app starts; Disconnect tries now.';
// A caller may already have persisted intent/finalizers before Core refuses admission.
const CLOSING = 'This app is closing; connection changes are paused. Any permission cleanup still owed will be retried when the app starts.';
const UPDATE = 'The app was updated. Approve again to keep it connected; until then the door refuses it.';
const ENDED = 'Its permission has ended. Disconnect, then connect again to give a new one.';

export function createToolConnections(options: ToolOptions) {
  const { home } = options;
  const env = options.env ?? defaultToolEnv();
  const doors = options.doors ?? { grant: grantDoor, revoke: revokeDoor };
  const door: DoorStart = options.door ?? { command: join(PIECES.mcp.dir, 'src/main.ts'), piece: PIECES.mcp.dir };
  const root = join(home, 'tools');
  const records = join(root, 'connections');
  const lastPath = (tool: AiToolId) => join(root, 'last', `${tool}.json`);

  function load(): State {
    const state: State = { tools: {}, revs: {}, seen: {} };
    for (const tool of TOOL_IDS) {
      const r = readRecord<Connection>(records, tool);
      if (!r) continue;
      state.tools[tool] = r.value;
      state.revs[tool] = r.rev;
      state.seen[tool] = JSON.stringify(r.value);
    }
    return state;
  }
  /** Write each record that changed since it was read, by compare-and-set: a stale copy is refused, never written. */
  function save(state: State) {
    for (const tool of TOOL_IDS) {
      const now = state.tools[tool] ?? null;
      const text = now ? JSON.stringify(now) : undefined;
      if (text === state.seen[tool]) continue;
      state.revs[tool] = writeRecord(records, tool, now, state.revs[tool] ?? 0);
      state.seen[tool] = text;
    }
  }
  const last = (tool: AiToolId) => readJson<Last | null>(lastPath(tool), null);
  const setLast = (tool: AiToolId, value: Last | null) => (value ? writeJson(lastPath(tool), value) : rmSync(lastPath(tool), { force: true }));

  const entryFor = (c: Connection): Entry => ({ command: door.command, args: ['serve', '--grant', c.grant], env: { BACKBONE_HOME: home } });
  /** Ours: an entry that starts our grant (from this app's path or an old one). */
  const ours = (c: Connection, e: Entry | null) => !!e && JSON.stringify(e.args) === JSON.stringify(['serve', '--grant', c.grant]) && e.env?.BACKBONE_HOME === home;
  const current = (c: Connection, e: Entry | null) => ours(c, e) && e!.command === door.command;
  const owe = (c: Connection, f: Finalizer) => c.finalizers.includes(f) || c.finalizers.push(f);
  const paid = (c: Connection, f: Finalizer) => (c.finalizers = c.finalizers.filter((x) => x !== f));

  /** The door's declaration: the widest permission a tool can be given. */
  function offer(): DoorOffer & { version: string; digest: string } {
    const piece = pieceOnDisk(door.piece, PIECES.mcp.id);
    const { operations, effectClasses } = piece.manifest.capabilities;
    return { operations: [...operations], ceiling: Math.min(Math.max(...effectClasses), 4), days: MAX_DAYS, version: piece.manifest.version, digest: piece.digest };
  }

  function takeSavepoint(tool: AiToolId, files: string[]): string {
    const dir = join(root, 'savepoints', `${tool}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(join(dir, 'files'), { recursive: true, mode: 0o700 });
    const index: Saved[] = files.map((path, i) => {
      if (!existsSync(path)) return { path, existed: false, sha256: null, copy: null };
      const bytes = readFileSync(path);
      writeAtomic(join(dir, 'files', String(i)), bytes);
      chmodSync(join(dir, 'files', String(i)), 0o600);
      return { path, existed: true, sha256: sha256(bytes), copy: `files/${i}` };
    });
    writeJson(join(dir, 'index.json'), index);
    return dir;
  }
  const savedConfig = (c: Connection, p: ToolPlace) => readJson<Saved[]>(join(c.savepoint, 'index.json'), []).find((s) => s.path === p.config);
  const savedBytes = (c: Connection, s: Saved | undefined) => (s?.copy ? readFileSync(join(c.savepoint, s.copy)) : null);

  /** Install the usage skill where it is missing, recording each as it lands; share one this app installed; leave anyone else's alone. */
  function installSkills(state: State, p: ToolPlace, c: Connection) {
    for (const dir of p.skills) {
      if (c.skills.some((s) => s.dir === dir)) continue;
      const file = join(dir, 'SKILL.md');
      if (existsSync(dir)) {
        const shared = Object.values(state.tools).some((r) => r !== c && r?.skills.some((s) => s.dir === dir));
        if (shared && existsSync(file) && readFileSync(file, 'utf8') === SKILL) c.skills.push({ dir, made: [] });
        continue;
      }
      const made: string[] = [];
      for (let d = dir; !existsSync(d); d = dirname(d)) made.unshift(d);
      mkdirSync(dir, { recursive: true });
      // Recorded before the file is written: taking it back removes what was made either way.
      c.skills.push({ dir, made });
      owe(c, 'skills');
      save(state);
      writeAtomic(file, SKILL);
    }
    if (c.skills.length) owe(c, 'skills');
    save(state);
  }

  /** Remove the skills this app installed, unless another connected tool still reads one, or it was changed. */
  function removeSkills(state: State, tool: AiToolId, c: Connection) {
    for (const s of [...c.skills].reverse()) {
      const other = Object.entries(state.tools).find(([id, r]) => id !== tool && r?.want === 'connected' && r.skills.some((x) => x.dir === s.dir))?.[1];
      if (other) {
        // Hand the folder to the tool that still reads it, so the last one removes it.
        const theirs = other.skills.find((x) => x.dir === s.dir)!;
        theirs.made = [...new Set([...s.made, ...theirs.made])];
        continue;
      }
      const file = join(s.dir, 'SKILL.md');
      if (existsSync(file) && readFileSync(file, 'utf8') !== SKILL) continue;
      rmSync(file, { force: true });
      for (const d of [...s.made].reverse()) {
        try {
          if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
        } catch {
          // A folder that is not empty stays.
        }
      }
    }
    c.skills = [];
  }

  /** What the core holds for this connection's intent: its standing mandates, by the core's own answer. */
  async function inCore(c: Connection) {
    return standingForIntent(await options.link(), c.id);
  }
  /** The grant stands, and was made for the door as it is now (not for an earlier version of it). */
  async function grantState(c: Connection): Promise<'standing' | 'ended' | 'stale'> {
    const [m] = await inCore(c);
    if (!m || new Date(m.expires_at).getTime() <= Date.now()) return 'ended';
    return m.digest === offer().digest ? 'standing' : 'stale';
  }

  /** Converge a tool wanted connected: the grant, then our entry at the door's current path, then the skills. */
  async function toConnected(state: State, tool: AiToolId, c: Connection) {
    const p = place(tool, env);
    const mechanism = MECHANISMS[tool];
    if (!c.finalizers.includes('revoke')) {
      // An intent past the expiry the person approved is never granted.
      if (Date.parse(c.permission.expiresAt) <= Date.now()) throw new Error('Its approval expired before it was granted.');
      // Recorded before the core is asked: a stop right after the grant is still found and taken back.
      owe(c, 'revoke');
      save(state);
      await doors.grant({ home, name: c.grant, intent: c.id, operations: c.permission.operations, ceiling: c.permission.ceiling, expiresAt: new Date(c.permission.expiresAt), piece: door.piece, ...options.core });
    } else {
      const now = await grantState(c);
      // Authority is never widened on the person's behalf: an ended or outdated grant waits for them.
      if (now === 'ended') throw new Error(ENDED);
      if (now === 'stale') throw new Error(UPDATE);
    }
    if (tool === 'claude-desktop') {
      // Claude installs the bundle in its own window; a copy it holds cannot be rewritten from here.
      if (!c.bundle) {
        owe(c, 'entry');
        save(state);
        const done = await mechanism.add({ t: env, place: p, name: c.name, entry: entryFor(c), askEachCall: c.permission.askEachCall, dir: join(root, tool), label: options.label ?? 'Assistant', version: offer().version, grant: c.grant });
        c.bundle = done.bundle;
        save(state);
      }
    } else {
      const now = await mechanism.read(p, env, c.name);
      if (now && !ours(c, now)) throw new Error(`Another server now uses the name ${c.name} in ${p.name}; it was left as it is.`);
      if (!current(c, now)) {
        owe(c, 'entry');
        save(state);
        if (now) await mechanism.remove({ t: env, place: p, name: c.name });
        const done = await mechanism.add({ t: env, place: p, name: c.name, entry: entryFor(c), askEachCall: c.permission.askEachCall, dir: join(root, tool), label: options.label ?? 'Assistant', version: offer().version, grant: c.grant });
        c.written = done.written;
        save(state);
      }
    }
    installSkills(state, p, c);
  }

  /** Converge a tool taken back: run its finalizers, revoke first. The rest still runs when revoking fails, since it only narrows. */
  async function toAbsent(state: State, tool: AiToolId, c: Connection): Promise<string | null> {
    const p = place(tool, env);
    const mechanism = MECHANISMS[tool];
    const problems: string[] = [];
    if (c.finalizers.includes('revoke')) {
      try {
        await doors.revoke({ home, name: c.grant, intent: c.id, ...options.core });
        // Done only when the core says nothing for this intent still stands; a missing file proves nothing.
        if ((await inCore(c)).length) throw new Error('still standing');
        paid(c, 'revoke');
      } catch (error) {
        // This service owns the outer home lock. Unwind it; never await the close here or
        // mistake a pre-write refusal for a successful revoke/empty standing-grant answer.
        if (error instanceof CoreCloseWaitRefusal) throw error;
        problems.push(PENDING);
      }
      save(state);
    }
    if (c.finalizers.includes('entry')) {
      try {
        if (tool === 'claude-desktop') await mechanism.remove({ t: env, place: p, name: c.name, bundle: c.bundle });
        else {
          const now = await mechanism.read(p, env, c.name);
          const saved = savedConfig(c, p);
          if (ours(c, now)) await mechanism.remove({ t: env, place: p, name: c.name, original: saved ? (saved.existed ? savedBytes(c, saved) : null) : undefined, written: c.written });
        }
        paid(c, 'entry');
      } catch (error) {
        problems.push(`${c.finalizers.includes('revoke') ? '' : 'The permission is revoked. '}Removing the entry did not finish: ${message(error)}`);
      }
      save(state);
    }
    if (c.finalizers.includes('skills')) {
      removeSkills(state, tool, c);
      paid(c, 'skills');
      save(state);
    }
    return problems.length ? problems.join(' ') : null;
  }

  /** Converge one tool toward what the person chose. Returns the problem when it did not converge. */
  async function reconcile(state: State, tool: AiToolId): Promise<string | null> {
    const c = state.tools[tool];
    if (!c) return null;
    if (c.want === 'connected') {
      try {
        await toConnected(state, tool, c);
        c.first = false;
        c.problem = null;
        save(state);
        return null;
      } catch (error) {
        c.problem = error instanceof CoreCloseWaitRefusal ? CLOSING : message(error);
        // An unconfirmed first connection may have partial authority: take it back, revoke first.
        if (c.first) c.want = 'absent';
        save(state);
        // owe('revoke') was durable before the grant. Keep it for recovery outside this
        // closing Host instead of attempting another nested Core open under the same lock.
        if (error instanceof CoreCloseWaitRefusal) throw error;
        if (!c.first) return c.problem;
      }
    }
    // Why a first connect failed, kept for the person beside anything taking it back left owed.
    const cause = c.first ? c.problem : null;
    let left: string | null;
    try { left = await toAbsent(state, tool, c); }
    catch (error) {
      if (error instanceof CoreCloseWaitRefusal) { c.problem = CLOSING; save(state); }
      throw error;
    }
    if (!c.finalizers.length) {
      delete state.tools[tool];
      save(state);
      return cause;
    }
    c.problem = left;
    save(state);
    return [cause, left].filter(Boolean).join(' ') || PENDING;
  }

  async function receipts(c: Connection): Promise<number> {
    const grant = readGrant(home, c.grant);
    if (!grant) return 0;
    try {
      const link = await options.link();
      const { rows } = await link.read<{ n: number }>(link.person(), 'SELECT count(*)::int AS n FROM app.effects WHERE run_id = $1', [grant.run]);
      return rows[0]?.n ?? 0;
    } catch {
      return 0;
    }
  }

  function startedBefore(p: ToolPlace, at: string): boolean {
    if (!p.process) return false;
    const since = new Date(at).getTime();
    return env.processes().some((x) => p.process!.test(x.command) && x.started.getTime() < since);
  }

  /** Whether Claude Desktop shows our bundle as installed, read-only from its extensions folder. */
  function desktopInstalled(p: ToolPlace, name: string): boolean {
    const dir = p.data ? join(p.data, 'Claude Extensions') : null;
    if (!dir || !existsSync(dir)) return false;
    return readdirSync(dir).some((d) => {
      try {
        return (JSON.parse(readFileSync(join(dir, d, 'manifest.json'), 'utf8')) as { name?: string }).name === name;
      } catch {
        return false;
      }
    });
  }

  async function view(id: AiToolId, state: State): Promise<AiTool> {
    const p = place(id, env);
    const c = state.tools[id];
    const base: AiTool = { id, name: p.name, state: 'disconnected', note: null, permission: null, receipts: 0, foreign: false, entryName: null, update: false };
    if (c) {
      const v: AiTool = { ...base, permission: c.permission, receipts: await receipts(c), entryName: c.name };
      if (c.want === 'absent') return { ...v, state: 'needs-attention', note: c.problem ?? PENDING };
      const granted = c.finalizers.includes('revoke') ? await grantState(c).catch(() => 'standing' as const) : 'standing';
      if (granted === 'stale') return { ...v, state: 'needs-attention', note: UPDATE, update: true };
      if (c.problem) return { ...v, state: 'needs-attention', note: c.problem };
      if (granted === 'ended' || Date.parse(c.permission.expiresAt) <= Date.now()) return { ...v, state: 'needs-attention', note: ENDED };
      if (id === 'claude-desktop' && !desktopInstalled(p, c.name)) return { ...v, state: 'needs-attention', note: 'Finish in Claude: its own window asks you to install the door.' };
      const named = c.name !== ENTRY ? `Connected as ${c.name}: another server already uses the name ${ENTRY}.` : null;
      if (startedBefore(p, c.connectedAt)) return { ...v, state: 'needs-restart', note: [named, RESTART[id]].filter(Boolean).join(' ') };
      return { ...v, state: 'connected', note: [named, CONNECTED[id]].filter(Boolean).join(' ') || null };
    }
    if (!p.installed) return { ...base, state: 'not-installed' };
    let foreign = false;
    try {
      foreign = !!(await MECHANISMS[id].read(p, env, ENTRY));
    } catch {
      return { ...base, note: `${p.name}'s settings could not be read; connecting would change nothing.` };
    }
    if (foreign) return { ...base, foreign, note: `${p.name} already has a server named ${ENTRY} that this app did not add. It stays as it is; this app's gets a name of its own.` };
    return { ...base, note: last(id)?.note ?? null };
  }

  async function list(): Promise<AiTools> {
    const state = load();
    const { version: _v, digest: _d, ...o } = offer();
    return { available: true, tools: await Promise.all(TOOL_IDS.map((id) => view(id, state))), offer: o };
  }

  /** Take a tool's connection back, revoke first; the record stays while anything is still owed. */
  async function takeBack(state: State, tool: AiToolId): Promise<{ problem: string | null; check: Check | null }> {
    const c = state.tools[tool]!;
    const p = place(tool, env);
    c.want = 'absent';
    c.first = false;
    save(state);
    const saved = savedConfig(c, p);
    const before = saved?.existed ? savedBytes(c, saved) : null;
    const name = c.name;
    const problem = await reconcile(state, tool);
    if (problem || state.tools[tool]) return { problem: problem ?? PENDING, check: null };
    const after = existsSync(p.config) ? readFileSync(p.config) : null;
    return { problem: null, check: MECHANISMS[tool].check(before, after, name) };
  }

  async function connect(req: ConnectTool): Promise<Receipt<AiTool>> {
    if (!TOOL_IDS.includes(req.tool)) return refused('NOT_FOUND', 'No such tool.');
    const declared = offer();
    // The person may narrow what the door declares, never widen it.
    const operations = req.operations ?? declared.operations;
    const ceiling = req.ceiling ?? declared.ceiling;
    const days = req.days ?? declared.days;
    if (!operations.length || new Set(operations).size !== operations.length || operations.some((o) => !declared.operations.includes(o))) {
      return refused('INVALID', 'A tool may only be given operations the door declares.');
    }
    if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > declared.ceiling) return refused('INVALID', `The ceiling is at most what the door declares (${declared.ceiling}).`);
    if (!Number.isInteger(days) || days < 1 || days > declared.days) return refused('INVALID', `A permission lasts at most ${declared.days} days.`);
    const state = load();
    const p = place(req.tool, env);
    const was = state.tools[req.tool];
    if (was) {
      // An update the person approves now: the grant for the old door is taken back first.
      const stale = was.want === 'connected' && was.finalizers.includes('revoke') && (await grantState(was).catch((error) => {
        if (error instanceof CoreCloseWaitRefusal) throw error;
        return 'standing';
      })) === 'stale';
      if (!stale) return refused('NOT_AVAILABLE', 'This tool is already connected, or needs attention. Disconnect it first.');
      const back = await takeBack(state, req.tool);
      if (back.problem) return refused('NOT_AVAILABLE', back.problem);
    }
    if (!p.installed) return refused('NOT_FOUND', `${p.name} is not installed on this computer.`);
    if (req.tool !== 'claude-desktop' && req.tool !== 'cursor' && !p.command) return refused('NOT_AVAILABLE', `${p.name}'s own command was not found, so its settings cannot be changed the way it expects.`);
    // An entry someone else made is never touched: ours takes the first free name.
    let name: string | null = null;
    try {
      for (let n = 1; n <= NAMES && !name; n++) if (!(await MECHANISMS[req.tool].read(p, env, entryName(n)))) name = entryName(n);
    } catch (error) {
      return refused('INVALID', message(error));
    }
    if (!name) return refused('NOT_AVAILABLE', `${p.name} already has servers named ${ENTRY} to ${entryName(NAMES)}.`);
    let n = 1;
    while (existsSync(join(home, 'doors', `${req.tool}-${n}.json`))) n++;
    // What the person chose, recorded before anything changes; the reconciler makes it so.
    state.tools[req.tool] = {
      id: randomUUID(),
      want: 'connected',
      grant: `${req.tool}-${n}`,
      name,
      permission: { operations, ceiling, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(), askEachCall: !!req.askEachCall },
      finalizers: [],
      skills: [],
      first: true,
      problem: null,
      connectedAt: new Date().toISOString(),
      savepoint: takeSavepoint(req.tool, [p.config, ...p.skills.map((d) => join(d, 'SKILL.md'))]),
    };
    save(state);
    const problem = await reconcile(state, req.tool);
    if (problem) return refused('NOT_AVAILABLE', `${p.name} was not connected: ${problem}`);
    state.tools[req.tool]!.connectedAt = new Date().toISOString();
    save(state);
    setLast(req.tool, null);
    return { ok: true, value: await view(req.tool, state) };
  }

  async function disconnect({ tool }: { tool: AiToolId }): Promise<Receipt<AiTool>> {
    const state = load();
    if (!state.tools[tool]) return refused('NOT_FOUND', 'This tool is not connected.');
    const back = await takeBack(state, tool);
    if (back.problem) return refused('NOT_AVAILABLE', back.problem);
    const note = tool === 'claude-desktop'
      ? `Disconnected. The permission is revoked; in Claude, open Settings › Extensions and remove ${options.label ?? 'Assistant'}.`
      : `Disconnected: ${CHECK_WORDS[back.check!]}.`;
    setLast(tool, { check: [back.check!], at: new Date().toISOString(), note });
    return { ok: true, value: await view(tool, state) };
  }

  /** At start: converge every tool toward what the person chose. Returns how many records changed. */
  async function recover(): Promise<number> {
    const state = load();
    let changed = 0;
    for (const tool of TOOL_IDS) {
      const c = state.tools[tool];
      if (!c) continue;
      const before = JSON.stringify(c);
      // An interrupted first connection was not confirmed; take back partial authority, revoke first.
      if (c.first && c.want === 'connected') {
        c.want = 'absent';
        c.problem = 'Connecting stopped before it finished, so it was taken back.';
      }
      await reconcile(state, tool);
      if (!state.tools[tool] && c.want === 'absent') setLast(tool, { check: [], at: new Date().toISOString(), note: 'Disconnected: its permission was taken back when the app started.' });
      if (JSON.stringify(state.tools[tool]) !== before) changed++;
    }
    return changed;
  }

  // Every change holds the data home's lock: one at a time in this process, and against any other.
  const locked = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A): Promise<R> => withHomeLock(home, () => fn(...a));
  const closingReceipt = <A extends unknown[], T>(fn: (...a: A) => Promise<Receipt<T>>) => async (...a: A): Promise<Receipt<T>> => {
    try { return await fn(...a); }
    catch (error) {
      if (error instanceof CoreCloseWaitRefusal) return refused('NOT_AVAILABLE', CLOSING);
      throw error;
    }
  };
  // Startup recovery has a count API: it propagates the typed refusal rather than reporting
  // convergence. Interactive callers receive the Host's closing category after state is retained.
  return { list, connect: locked(closingReceipt(connect)), disconnect: locked(closingReceipt(disconnect)), recover: locked(recover) };
}
