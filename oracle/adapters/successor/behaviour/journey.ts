import { writePlaintextVault } from '../../../../packages/platform/src/keys/vault.ts';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BehaviourUse } from '../../../behaviour/target.ts';
import type {
  AgentPlan,
  CrashPoint,
  DocumentState,
  Journey,
  JourneyPort,
  SaveState,
  SaveTicket,
  Seen,
  ThreadView,
  WriteStatus,
} from '../../../behaviour/journey/port.ts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const BRIDGE = join(REPO, 'packages/surfaces/app/server/bridge.ts');
const SETTINGS = { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' } as const;
const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Receipt<T> {
  ok: boolean;
  value?: T;
  reason?: string;
  detail?: string;
}
interface Entry {
  id: string;
  projectId: string;
  name: string;
  class: string;
  current: number;
  versions: { n: number; by: 'person' | 'agent'; sha256: string; bytes: number }[];
}
interface Turn {
  id: string;
  status: string;
  answer?: { text: string; files: { materialId: string; name: string }[] };
  effects: { key: string; target: string; outcome: 'DONE' | 'REFUSED' | 'UNKNOWN' }[];
}

/**
 * J-01 through the successor's public HTTP API: the app's bridge (packages/surfaces/app/server),
 * run as its own process on a scratch data home, with the core behind it. The agent is the
 * platform's scripted stand-in: the case's plan for each message is handed to it through the
 * script folder the service is started with, and it records there what it was given.
 */
class ServiceJourney implements Journey {
  readonly person = 'You';
  private readonly home = mkdtempSync(join(tmpdir(), 'backbone-journey-'));
  private readonly script = join(this.home, 'script');
  private child?: ChildProcess;
  private exited?: Promise<NodeJS.Signals | null>;
  private url = '';
  private defaultProject?: string;
  private readonly holds = new Set<string>();
  private readonly usage: BehaviourUse[];

  constructor(usage: BehaviourUse[]) {
    this.usage = usage;
    writePlaintextVault(join(this.home, 'data')); // Explicit disposable headless fixture, never the person's Keychain.
    for (const d of ['plans', 'held', 'release']) mkdirSync(join(this.script, d), { recursive: true });
  }

  async start(options: { crashAt?: CrashPoint } = {}): Promise<void> {
    // Re-arming a crash point replaces this adapter's own service; it never opens a second Host.
    await this.halt('SIGTERM');
    this.usage.push({ name: 'service.start', kind: 'process' });
    const child = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        BACKBONE_HOME: join(this.home, 'data'),
        BACKBONE_HARNESS: 'scripted',
        BACKBONE_SCRIPT_DIR: this.script,
        ...(options.crashAt ? { BACKBONE_CRASH_AT: options.crashAt } : {}),
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exited = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    let err = '';
    child.stderr?.on('data', (c) => (err = (err + String(c)).slice(-4000)));
    this.url = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout?.on('data', (c) => {
        out += String(c);
        const m = /backbone bridge on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (m) resolve(m[1]);
      });
      child.once('exit', () => reject(new Error(`the service exited before it listened: ${err}`)));
    });
    // The first call waits for the core to be up.
    await this.call('projects.list', {});
  }

  private async call<T>(method: string, args: unknown): Promise<T> {
    this.usage.push({ name: method, kind: 'api' });
    const res = await fetch(`${this.url}/api`, { method: 'POST', body: JSON.stringify({ method, args }) });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`${method}: ${body.error}`);
    return body;
  }

  private async value<T>(method: string, args: unknown): Promise<T> {
    const r = await this.call<Receipt<T>>(method, args);
    if (!r.ok) throw new Error(`${method} refused: ${r.reason}: ${r.detail}`);
    return r.value as T;
  }

  /** Hand the scripted agent its plan for one message, and answer its hold when it reaches it. */
  private plan(message: string, agent: AgentPlan) {
    const holdId = agent.hold ? randomUUID() : undefined;
    writeFileSync(join(this.script, 'plans', `${sha(message)}.json`), JSON.stringify({ ...agent, hold: holdId }));
    if (agent.hold && holdId) {
      const h = agent.hold;
      this.holds.add(holdId);
      void (async () => {
        while (this.holds.has(holdId) && !existsSync(join(this.script, 'held', holdId))) await sleep(20);
        if (!this.holds.has(holdId)) return;
        await h.wait();
        writeFileSync(join(this.script, 'release', holdId), '');
      })();
    }
  }

  async createProject(name: string): Promise<string> {
    return (await this.value<{ id: string }>('projects.create', { name, kind: 'folder' })).id;
  }

  private async project(): Promise<string> {
    this.defaultProject ??= await this.createProject('J-01');
    return this.defaultProject;
  }

  async ask(input: Parameters<Journey['ask']>[0]) {
    const projectId = input.project ?? (await this.project());
    const attachments: string[] = [];
    if (input.material?.note) {
      const e = await this.value<Entry>('material.attach', {
        projectId,
        name: input.material.note.title,
        base64: Buffer.from(input.material.note.text).toString('base64'),
        mediaType: 'text/markdown',
      });
      attachments.push(e.id);
    }
    if (input.material?.spreadsheet) {
      const e = await this.value<Entry>('material.attach', {
        projectId,
        name: input.material.spreadsheet.name,
        base64: Buffer.from(input.material.spreadsheet.bytes).toString('base64'),
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      attachments.push(e.id);
    }
    this.plan(input.message, input.agent);
    const sent = await this.value<{ threadId: string }>('turns.send', {
      projectId,
      text: input.message,
      attachments,
      settings: SETTINGS,
      clientKey: randomUUID(),
    });
    return { thread: sent.threadId, attachments };
  }

  async followUp(thread: string, message: string, agent: AgentPlan): Promise<void> {
    const t = await this.value<{ summary: { projectId: string } }>('threads.get', { id: thread });
    this.plan(message, agent);
    await this.value('turns.send', { threadId: thread, projectId: t.summary.projectId, text: message, attachments: [], settings: SETTINGS, clientKey: randomUUID() });
  }

  async thread(thread: string): Promise<ThreadView> {
    const t = await this.value<{ summary: { id: string; projectId: string; running: boolean }; turns: Turn[] }>('threads.get', { id: thread });
    const names = new Map((await this.entries()).map((e) => [`${e.projectId}\0${e.name}`, e.id]));
    const status = (turn: Turn, outcome: string): WriteStatus =>
      turn.status === 'running' && outcome === 'UNKNOWN' ? 'pending' : outcome === 'DONE' ? 'succeeded' : outcome === 'UNKNOWN' ? 'unknown' : 'denied';
    return {
      id: t.summary.id,
      project: t.summary.projectId,
      idle: !t.summary.running,
      answers: t.turns.filter((x) => x.answer && x.status !== 'running').map((x) => x.answer?.text ?? ''),
      writes: t.turns.flatMap((turn) =>
        turn.effects.map((e) => ({
          id: e.key,
          status: status(turn, e.outcome),
          document: turn.answer?.files.find((f) => f.name === e.target)?.materialId ?? names.get(`${t.summary.projectId}\0${e.target}`),
        })),
      ),
      questions: 0,
    };
  }

  async settled(thread: string, answers: number, timeoutMs = 60_000): Promise<ThreadView> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const view = await this.thread(thread);
      if (view.idle && view.answers.length >= answers) return view;
      if (Date.now() > until) throw new Error(`the thread did not settle: ${JSON.stringify(view)}`);
      await sleep(100);
    }
  }

  async stop(thread: string): Promise<boolean> {
    return (await this.value<{ stopped: boolean }>('turns.stop', { threadId: thread })).stopped;
  }

  private async entries(): Promise<Entry[]> {
    const projects = await this.call<{ id: string }[]>('projects.list', {});
    return (await Promise.all(projects.map((p) => this.call<Entry[]>('material.list', { projectId: p.id, includeHidden: true })))).flat();
  }

  async documents() {
    return (await this.entries()).map((e) => ({ id: e.id, title: e.name, version: e.current }));
  }

  private async read(id: string, version: number) {
    return this.value<{ entry: Entry; text?: string; base64?: string }>('material.read', { id, version });
  }

  async document(id: string): Promise<DocumentState> {
    const { entry } = await this.read(id, 0 || (await this.read(id, 1)).entry.current);
    const versions = await Promise.all(
      entry.versions.map(async (v) => {
        const r = await this.read(id, v.n);
        return { version: v.n, by: v.by, content: r.text ?? r.base64 ?? '' };
      }),
    );
    const current = versions.find((v) => v.version === entry.current);
    return {
      id: entry.id,
      title: entry.name,
      version: entry.current,
      content: current?.content ?? '',
      by: current?.by ?? 'person',
      versions,
      ...(entry.class === 'original'
        ? { original: { filename: entry.name, sha256: entry.versions[0]?.sha256 ?? '', byteLength: entry.versions[0]?.bytes ?? 0 } }
        : {}),
    };
  }

  async original(id: string, version: number): Promise<Uint8Array> {
    const r = await this.read(id, version);
    return new Uint8Array(r.base64 !== undefined ? Buffer.from(r.base64, 'base64') : Buffer.from(r.text ?? ''));
  }

  private draftKey = (t: SaveTicket) => `save:${t.document}:${sha(t.content)}`;

  async prepareSave(id: string, edit: { title: string; content: string; expectedVersion: number }): Promise<SaveTicket> {
    const ticket = { document: id, content: edit.content };
    await this.value('drafts.put', { key: this.draftKey(ticket), text: edit.content, meta: { baseVersion: edit.expectedVersion }, clientKey: this.draftKey(ticket) });
    return ticket;
  }

  async saveState(ticket: SaveTicket): Promise<SaveState> {
    const doc = await this.document(ticket.document);
    const landed = doc.versions.find((v) => v.by === 'person' && v.content === ticket.content);
    if (landed) return { status: 'accepted', version: landed.version };
    const draft = await this.call<{ meta?: { baseVersion?: number } } | null>('drafts.get', { key: this.draftKey(ticket) });
    return draft ? { status: 'prepared' } : { status: 'unavailable' };
  }

  async save(ticket: SaveTicket): Promise<SaveState> {
    const state = await this.saveState(ticket);
    if (state.status !== 'prepared') return state;
    const draft = await this.call<{ meta?: { baseVersion?: number } } | null>('drafts.get', { key: this.draftKey(ticket) });
    const r = await this.call<Receipt<Entry>>('material.save', { id: ticket.document, text: ticket.content, baseVersion: draft?.meta?.baseVersion ?? 0 });
    if (r.ok) return { status: 'accepted', version: r.value?.current ?? 0 };
    const after = await this.saveState(ticket);
    return after.status === 'accepted' ? after : { status: 'refused', reason: r.reason ?? 'refused' };
  }

  async saveThenKill(ticket: SaveTicket, afterMs: number): Promise<void> {
    const draft = await this.call<{ meta?: { baseVersion?: number } } | null>('drafts.get', { key: this.draftKey(ticket) });
    void this.call('material.save', { id: ticket.document, text: ticket.content, baseVersion: draft?.meta?.baseVersion ?? 0 }).catch(() => {});
    await sleep(afterMs);
    await this.kill();
  }

  seen(): readonly Seen[] {
    const path = join(this.script, 'seen.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Seen);
  }

  async restart(): Promise<void> {
    await this.halt('SIGTERM');
    await this.start();
  }

  async kill(): Promise<void> {
    await this.halt('SIGKILL');
  }

  private async halt(signal: NodeJS.Signals) {
    this.usage.push({ name: `service.${signal === 'SIGKILL' ? 'kill' : 'stop'}`, kind: 'process' });
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill(signal);
      await this.exited;
    }
  }

  async crashed(timeoutMs = 30_000): Promise<boolean> {
    const signal = await Promise.race([this.exited, sleep(timeoutMs).then(() => 'timeout' as const)]);
    return signal === 'SIGKILL';
  }

  async close(): Promise<void> {
    this.holds.clear();
    await this.halt('SIGTERM');
    // A killed service leaves its database running; stop it before the home goes.
    const pid = join(this.home, 'data', 'pg', 'data', 'postmaster.pid');
    if (existsSync(pid)) {
      const n = Number(readFileSync(pid, 'utf8').split('\n')[0]);
      try {
        process.kill(n, 'SIGINT');
        for (let i = 0; i < 100; i++) {
          process.kill(n, 0);
          await sleep(50);
        }
      } catch {}
    }
    rmSync(this.home, { recursive: true, force: true });
  }
}

export function journeyPort(usage: BehaviourUse[]): JourneyPort {
  return {
    async open() {
      const j = new ServiceJourney(usage);
      try { await j.start(); return j; }
      catch (error) { await j.close(); throw error; }
    },
  };
}
