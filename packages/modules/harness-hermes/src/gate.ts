// Backbone's side of the boundary: what the plugin inside Hermes asks, per call. The hook is policy
// inside the engine's process and Hermes's dispatchers swallow a failure of the hook machinery
// itself (agent/tool_executor.py, model_tools.py), so this side does not trust that the hook ran:
// a door call needs the ticket of a decision made for that call and those exact arguments, spent once.
// The gate also holds the turn's ledger: one record per call, whose outcome comes only from the
// ToolHost's answer. Whether a turn is done is read from here, never from what Hermes says happened.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HarnessEvent, ToolHost, WriteOutcome } from '@backbone-next/platform/ports';
import type { Journal, JournalEntry } from './journal.ts';

export const DOOR_TOOLS = ['door_list_files', 'door_read_file', 'door_write_file'] as const;
const DOORS: ReadonlySet<string> = new Set(DOOR_TOOLS);
/**
 * Hermes's own working toolsets, as v0.22.5 names them, that act only on its plane's home: its memory,
 * its skills and its task list. None reaches the project, the person's accounts or the outside world,
 * so each is allowed at the gate without a door. Every other native toolset stays off. Session search
 * is off until Hermes's auxiliary route can be pinned to the primary model and verified.
 */
export const NATIVE_TOOLSETS: Readonly<Record<string, readonly string[]>> = { memory: ['memory'], skills: ['skills_list', 'skill_view', 'skill_manage'], todo: ['todo_list'] };
const NATIVE: ReadonlySet<string> = new Set(Object.values(NATIVE_TOOLSETS).flat());
/** Two whole documents at the host's 2,000,000-byte limit, escaped; anything larger is refused unread. */
const MAX_BODY = 16_000_000;

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export type Narrow = (call: ToolCall) => string | null;

const owner = (file: { class: 'original' | 'working' | 'accepted' }) => file.class === 'original' ? 'original source' : 'recorded version';

/** Stable across key order, so the hook and the door agree on what was decided. */
function digest(tool: string, args: unknown) {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify([tool, canonical(args)])).digest('hex');
}

function labelOf(tool: string, args: Record<string, unknown>) {
  const name = typeof args.name === 'string' ? args.name : undefined;
  if (tool === 'door_list_files') return 'Listed the files';
  if (tool === 'door_read_file') return name ? `Read ${name}` : 'Read a file';
  if (tool === 'door_write_file') return name ? `Write ${name}` : 'Write a file';
  return tool;
}

/** What each door needs. A call of any other shape proposes nothing. */
function badShape(tool: string, args: Record<string, unknown>): string | null {
  const need = tool === 'door_write_file' ? ['name', 'content'] : tool === 'door_read_file' ? ['name'] : [];
  const missing = need.filter((k) => typeof args[k] !== 'string');
  return missing.length ? `${tool} needs ${missing.join(' and ')} as text, so it was not run.` : null;
}

export interface TurnGateEvents {
  emit(event: HarnessEvent): void;
  /** Something crossed the boundary that should not have: stop the run, fail the turn. */
  breach(reason: string): void;
  /** A call came back UNKNOWN: stop the run. */
  unknown(): void;
}

type Reply = { ok: boolean; text: string };
type Receipt = 'done' | 'refused' | 'unknown';

/**
 * One call in the ledger. decided: a ticket exists. dispatched: the door received it. answered: it
 * has a receipt. closed: the plugin holds the answer, or it was refused at the hook and has no door.
 * Moves only forward. A call that does not reach `closed`, or closes UNKNOWN, leaves the ledger open.
 */
interface Call {
  id: string;
  tool: string;
  label: string;
  key: string;
  state: 'decided' | 'dispatched' | 'answered' | 'closed';
  receipt?: Receipt;
  /** The hook allowed it. Only such a call may run in Hermes. */
  allowed: boolean;
}

/** The gate's view of one turn. Everything is decided here, per call, against current state. */
export class TurnGate {
  private calls = new Map<string, Call>();
  private tickets = new Map<string, Call>();
  /** The version of each file this turn read. A write lands only on that version, or as a new file. */
  private sources = new Map<string, number>();
  private closed = false;
  private writesClosed = false;
  private tail: Promise<unknown> = Promise.resolve();
  /** Ends the write in flight as UNKNOWN, whatever the host later says. */
  private giveUpOnWrite: (() => void) | undefined;
  /**
   * The plugin's end-of-turn count of decisions it could not get from this gate. A call blocked that
   * way leaves no record here and no event in Hermes, so `done` needs this report, at zero.
   * Missing or malformed, it is not clean, and a bad report stays bad.
   */
  private report: 'none' | 'clean' | 'bad' = 'none';
  /** The turn's outcome is written: the journal may be closed, so evidence stops here. */
  private sealed = false;
  private abort = new AbortController();
  private host: ToolHost;
  private journal: Journal;
  private narrow: Narrow | undefined;
  private events: TurnGateEvents;
  private writeTimeoutMs: number;

  constructor(host: ToolHost, journal: Journal, narrow: Narrow | undefined, events: TurnGateEvents, writeTimeoutMs = 280_000) {
    this.writeTimeoutMs = writeTimeoutMs;
    this.host = host;
    this.journal = journal;
    this.narrow = narrow;
    this.events = events;
  }

  /** No further call passes. In-flight writes are told to stop; each settles as the gateway says. */
  close() {
    this.closed = true;
    this.abort.abort();
  }

  /** True when every call has closed on a known receipt. This is the only way a turn can be `done`. */
  get balanced() {
    return [...this.calls.values()].every((c) => c.state === 'closed' && c.receipt !== 'unknown');
  }

  /** The plugin reported, at zero, and never otherwise. Can only lower a turn when false. */
  get reportedClean() {
    return this.report === 'clean';
  }

  reported(failed: unknown) {
    this.report = this.report !== 'bad' && failed === 0 ? 'clean' : 'bad';
  }

  /** Whether the gate allowed this call for this tool. Engine events that fail this only lower a turn. */
  allowed(id: string, tool: string) {
    const call = this.calls.get(id);
    return call !== undefined && call.allowed && call.tool === tool;
  }

  decide(id: string, tool: string, args: Record<string, unknown>): { action: 'allow'; ticket?: string } | { action: 'block'; message: string } {
    const label = labelOf(tool, args);
    const refuse = (message: string) => {
      // Any write refused or left UNKNOWN closes further writes, here as at the ToolHost.
      if (tool === 'door_write_file') this.writesClosed = true;
      this.events.emit({ type: 'tool', phase: 'refused', tool, label, ...(id ? { id } : {}) });
      return { action: 'block' as const, message };
    };
    // No call identity, or one already used: nothing later could be held against this decision.
    if (!id || this.calls.has(id)) {
      this.events.breach(`${tool} reached the gate with no usable call identity.`);
      return refuse('This tool call has no usable identity, so it was not run.');
    }
    const call: Call = { id, tool, label, key: digest(tool, args), state: 'closed', receipt: 'refused', allowed: false };
    this.calls.set(id, call);
    // A clean report covers only what came before it.
    if (this.report === 'clean') this.report = 'none';
    if (this.closed) return refuse('This turn has ended, so the tool call was not run.');
    if (!DOORS.has(tool) && !NATIVE.has(tool)) return refuse(`${tool} is not granted in this thread; only ${DOOR_TOOLS.join(', ')} and Hermes's own ${[...NATIVE].join(', ')} are.`);
    const shape = badShape(tool, args);
    if (shape) return refuse(shape);
    const narrowed = this.narrowed({ tool, args });
    if (narrowed) return refuse(narrowed);
    if (NATIVE.has(tool)) {
      // It runs in the plane and nothing crosses: there is no ticket and no receipt to wait for.
      call.allowed = true;
      call.receipt = 'done';
      this.events.emit({ type: 'tool', phase: 'proposed', tool, label, id });
      return { action: 'allow' };
    }
    if (tool === 'door_write_file' && this.writesClosed) return refuse('An earlier write in this turn was refused or left UNKNOWN, so no further write is proposed.');
    try {
      // Durable before the plugin can act on it, so a crash cannot forget a call the turn already proposed.
      if (tool === 'door_write_file') this.journal.record({ kind: 'intent', id, tool, name: String(args.name) });
    } catch {
      // No record, no write: a crash now could not be told from nothing having happened.
      return refuse(`The write of ${String(args.name)} could not be recorded, so it was not proposed.`);
    }
    call.state = 'decided';
    call.allowed = true;
    delete call.receipt;
    const ticket = randomUUID();
    this.tickets.set(ticket, call);
    this.events.emit({ type: 'tool', phase: 'proposed', tool, label, id });
    return { action: 'allow', ticket };
  }

  /** The plugin holds the answer. It says nothing about the outcome, which is already the receipt. */
  delivered(ticket: string) {
    const call = this.tickets.get(ticket);
    if (call?.state === 'answered') call.state = 'closed';
  }

  /** The plugin's connection dropped: it has told the model UNKNOWN, so a write in flight is UNKNOWN here too. */
  callLost() {
    this.giveUpOnWrite?.();
  }

  /** A policy that throws has made no decision: that is a refusal, not a pass. */
  private narrowed(call: ToolCall): string | null {
    try {
      return this.narrow?.(call) ?? null;
    } catch {
      return 'The policy for this thread could not be read, so the tool call was not run.';
    }
  }

  /** Why this call may not go on or come back now, read at each step: state moves while a call waits. */
  private barred(tool: string, args: Record<string, unknown>) {
    return this.closed ? 'This turn has ended, so the tool call was not run.' : this.narrowed({ tool, args });
  }

  /** Records a call's one receipt. False when it already has one: a late answer changes nothing. */
  private receipt(call: Call, phase: Receipt) {
    if (call.receipt) return false;
    call.receipt = phase;
    call.state = 'answered';
    if (call.tool === 'door_write_file' && phase !== 'done') this.writesClosed = true;
    // What happened acts first. The journal is evidence and its failure must not change the turn.
    this.events.emit({ type: 'tool', phase, tool: call.tool, label: call.label, id: call.id });
    if (phase === 'unknown') this.events.unknown();
    if (call.tool === 'door_write_file') this.note({ kind: 'settled', id: call.id, outcome: phase });
    return true;
  }

  async call(ticket: string, tool: string, args: Record<string, unknown>): Promise<Reply> {
    const call = this.tickets.get(ticket);
    if (call?.state !== 'decided' || call.tool !== tool || call.key !== digest(tool, args)) {
      if (call?.state === 'decided') this.receipt(call, 'refused');
      this.events.breach(`${tool} reached the gate with no decision for that call.`);
      return { ok: false, text: `The gate has no decision for this ${tool} call, so it was not run.` };
    }
    call.state = 'dispatched';
    const barred = this.barred(tool, args);
    if (barred) {
      this.receipt(call, 'refused');
      return { ok: false, text: barred };
    }
    if (tool !== 'door_write_file') return this.read(call, args);
    // One write at a time, so an UNKNOWN closes the latch before the next one is looked at.
    const run = this.tail.then(() => this.write(call, args));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async read(call: Call, args: Record<string, unknown>): Promise<Reply> {
    let reply: Reply;
    let read: { name: string; version: number } | undefined;
    try {
      if (call.tool === 'door_list_files') {
        const files = await this.host.list();
        reply = { ok: true, text: files.map((f) => `- ${f.name} v${f.version} (${owner(f)}) ${f.class} ${f.mediaType}`).join('\n') || 'This project has no files yet.' };
      } else {
        const name = String(args.name);
        const file = await this.host.read(name);
        if (file) read = file;
        reply = file ? { ok: true, text: `${file.name} v${file.version} (${owner(file)})\n\n${file.text}` } : { ok: false, text: `There is no file named ${name}.` };
      }
    } catch {
      reply = { ok: false, text: 'The project could not be read.' };
    }
    // Stopped or withdrawn while the host read: the material stays here.
    const barred = this.barred(call.tool, args);
    if (barred) reply = { ok: false, text: barred };
    const first = this.receipt(call, reply.ok ? 'done' : 'refused');
    // A source only once its text reaches the model.
    if (first && reply.ok && read) this.sources.set(read.name, read.version);
    return first ? reply : { ok: false, text: 'This turn has ended, so nothing was read.' };
  }

  private async write(call: Call, args: Record<string, unknown>): Promise<Reply> {
    const [name, content] = [String(args.name), String(args.content)];
    const refused = (text: string) => {
      this.receipt(call, 'refused');
      return { ok: false, text };
    };
    if (this.closed || this.writesClosed) return refused('An earlier write in this turn was refused or left UNKNOWN, so this one was not proposed.');
    // A queued write waited; the policy it passed may not hold now.
    const narrowed = this.narrowed({ tool: call.tool, args });
    if (narrowed) return refused(narrowed);
    // Only the conditional crossing: on the version this turn read, or as a new file, citing what it read.
    // Refused before the give-up timer is armed, so a refusal leaves no timer behind.
    if (!this.host.writeIfVersion) return refused('This project offers no conditional write, so the write was not proposed.');
    const unanswered: WriteOutcome = { outcome: 'UNKNOWN', detail: `The write of ${name} did not report an outcome. It is UNKNOWN and will not be resent.` };
    let timer: NodeJS.Timeout | undefined;
    const givenUp = new Promise<WriteOutcome>((resolve) => {
      this.giveUpOnWrite = () => resolve(unanswered);
      timer = setTimeout(() => resolve(unanswered), this.writeTimeoutMs);
    });
    let outcome: WriteOutcome;
    try {
      const sources = [...this.sources].map(([source, version]) => ({ name: source, version }));
      const sent = this.host.writeIfVersion(name, content, { targetVersion: this.sources.get(name) ?? null, sources }, this.abort.signal);
      // First answer wins: a DONE after the deadline changes nothing and reopens nothing.
      outcome = await Promise.race([sent, givenUp]);
      if (outcome === unanswered) void sent.then((answer) => answer.outcome !== 'UNKNOWN' && this.late(call, answer.outcome), () => undefined);
    } catch {
      // The host did not say what happened to the write. Only the gateway can.
      outcome = unanswered;
    }
    clearTimeout(timer);
    this.giveUpOnWrite = undefined;
    // The port: a write dispatched at Stop is UNKNOWN, whatever the host then says. Its answer stays as evidence.
    const overtaken = this.closed && outcome.outcome !== 'UNKNOWN' ? outcome.outcome : undefined;
    if (overtaken) outcome = unanswered;
    // Given up on by settle(): reported UNKNOWN, the turn has moved on, and the journal may be closed.
    if (!this.receipt(call, outcome.outcome === 'DONE' ? 'done' : outcome.outcome === 'UNKNOWN' ? 'unknown' : 'refused')) return { ok: false, text: `The outcome of the write of ${name} is UNKNOWN. It will not be resent.` };
    if (overtaken) this.late(call, overtaken);
    return outcome.outcome === 'DONE' ? { ok: true, text: `Wrote ${outcome.name} v${outcome.version}.` } : { ok: false, text: outcome.detail };
  }

  /** An answer that came too late to count. Kept and shown beside the UNKNOWN, which it never replaces. */
  private late(call: Call, outcome: 'DONE' | 'REFUSED') {
    if (this.sealed) return;
    this.events.emit({ type: 'tool', phase: 'unknown', tool: call.tool, label: `${call.label} (UNKNOWN; the host later reported ${outcome})`, id: call.id });
    this.note({ kind: 'late', id: call.id, outcome });
  }

  private note(entry: JournalEntry) {
    try {
      this.journal.record(entry);
    } catch {
      // Evidence lost; a settled intent left open reads as UNKNOWN on restart, the safe side.
    }
  }

  /** Gives open calls until the deadline to close. Any call with no receipt by then is UNKNOWN by construction. */
  async settle(deadlineMs: number) {
    const deadline = Date.now() + deadlineMs;
    const open = () => [...this.calls.values()].some((c) => c.state !== 'closed');
    while (open() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    for (const call of this.calls.values()) this.receipt(call, 'unknown');
    this.giveUpOnWrite?.();
    // A last turn of the event loop, so a host that answered the give-up is still recorded.
    await new Promise((r) => setTimeout(r, 0));
    this.sealed = true;
  }
}

// The gate protocol. The plane's secret never travels: a listener that took the gate's port learns
// nothing from a request and cannot answer one. Each turn has its own key, derived from the secret
// and the turn's session, so the key rotates with every turn. Each request carries a fresh nonce
// and a MAC; each reply carries a MAC over that nonce and its body, which the plugin checks first.
// The key also binds the gate's epoch, random at each start, so a request captured before a restart
// is worth nothing after it; the plugin reads the epoch at /epoch, which is public. A signed time
// bounds a request's life, so one held back fails even on its first delivery.
export const turnKey = (secret: string, epoch: string, session: string) => createHmac('sha256', secret).update(`hermes-gate-turn\n${epoch}\n${session}`).digest();
export const gateMac = (key: Buffer, kind: 'req' | 'res', path: string, nonce: string, time: string, body: string) => createHmac('sha256', key).update(`${kind}\n${path}\n${nonce}\n${time}\n${body}`).digest('hex');
/** How far a request's signed time may be from the gate's clock, exclusive: exactly this far is refused. */
const WINDOW_MS = 60_000;
/** The epoch is handed out signed over the asker's nonce, under a key only the plane's secret gives. */
export const epochMac = (secret: string, nonce: string, epoch: string, time: string) => createHmac('sha256', createHmac('sha256', secret).update('hermes-gate-epoch').digest()).update(`epoch\n${nonce}\n${epoch}\n${time}`).digest('hex');

function sameMac(given: string, expected: string) {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function rawBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parsed(raw: string) {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The loopback server the plugin calls, with the turns currently open on it, by Hermes session. */
export class GateServer {
  private sessions = new Map<string, TurnGate>();
  /** Nonces accepted within the window, by time: a request is good once, and only while fresh. */
  private nonces = new Map<string, number>();
  /** Fresh at each start of the listener. */
  private epoch = randomBytes(16).toString('hex');
  private server: Server | undefined;
  private listening: Promise<void> | undefined;
  private options: { host: string; port: number; token: string; withhold?: (text: string) => string };

  constructor(options: { host: string; port: number; token: string; withhold?: (text: string) => string }) {
    this.options = options;
  }

  open(session: string, gate: TurnGate) {
    this.sessions.set(session, gate);
  }

  shut(session: string, gate: TurnGate) {
    if (this.sessions.get(session) === gate) this.sessions.delete(session);
  }

  listen() {
    this.listening ??= new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res).catch(() => reply(res, 200, { action: 'block', ok: false, text: 'The gate failed.', message: 'The gate failed.' })));
      server.once('error', (err) => {
        this.listening = undefined;
        reject(err);
      });
      server.listen(this.options.port, this.options.host, () => {
        this.server = server;
        this.epoch = randomBytes(16).toString('hex');
        this.nonces.clear();
        resolve();
      });
    });
    return this.listening;
  }

  async close() {
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? '';
    const decide = path === '/decide';
    if (req.method !== 'POST') return reply(res, 401, {});
    if (!decide && path !== '/call' && path !== '/delivered' && path !== '/report' && path !== '/epoch') return reply(res, 404, {});
    const raw = await rawBody(req);
    const body = raw === null ? null : parsed(raw);
    if (path === '/epoch') {
      const asked = typeof body?.nonce === 'string' ? body.nonce : '';
      if (!/^[0-9a-f]{32}$/.test(asked)) return reply(res, 401, {});
      const time = String(Date.now());
      res.writeHead(200, { 'content-type': 'application/json', 'x-gate-mac': epochMac(this.options.token, asked, this.epoch, time) });
      return void res.end(JSON.stringify({ epoch: this.epoch, time: Number(time) }));
    }
    const session = typeof body?.session_id === 'string' ? body.session_id : '';
    const key = turnKey(this.options.token, this.epoch, session);
    const nonce = String(req.headers['x-gate-nonce'] ?? '');
    const time = String(req.headers['x-gate-time'] ?? '');
    const given = String(req.headers['x-gate-mac'] ?? '');
    const now = Date.now();
    // Kept for twice the window: a request accepted at any point stays invalid for the rest of its life.
    for (const [seen, at] of this.nonces) if (now - at > 2 * WINDOW_MS) this.nonces.delete(seen);
    const fresh = /^\d{1,16}$/.test(time) && Math.abs(now - Number(time)) < WINDOW_MS;
    if (raw === null || !fresh || !/^[0-9a-f]{32}$/.test(nonce) || this.nonces.has(nonce) || !sameMac(given, gateMac(key, 'req', path, nonce, time, raw))) return reply(res, 401, {});
    this.nonces.set(nonce, now);
    const answer = (value: unknown) => {
      // Toward the engine and its model: a text that carries a known key, in material, names or messages, is withheld whole.
      const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'string' && this.options.withhold ? this.options.withhold(v) : v));
      res.writeHead(200, { 'content-type': 'application/json', 'x-gate-mac': gateMac(key, 'res', path, nonce, time, text) });
      res.end(text);
    };
    const gate = session ? this.sessions.get(session) : undefined;
    if (path === '/delivered') {
      if (typeof body?.ticket === 'string') gate?.delivered(body.ticket);
      return answer({});
    }
    if (path === '/report') {
      gate?.reported(body?.failed);
      return answer({});
    }
    const tool = body?.tool_name;
    const args = body?.args ?? {};
    const refused = 'No turn of this thread is open for this call, so it was not run.';
    if (!gate || typeof tool !== 'string' || typeof args !== 'object' || Array.isArray(args)) {
      return answer(decide ? { action: 'block', message: refused } : { ok: false, text: refused });
    }
    const id = typeof body?.tool_call_id === 'string' ? body.tool_call_id : '';
    if (decide) return answer(gate.decide(id, tool, args as Record<string, unknown>));
    res.once('close', () => {
      if (!res.writableEnded && tool === 'door_write_file') gate.callLost();
    });
    return answer(await gate.call(typeof body?.ticket === 'string' ? body.ticket : '', tool, args as Record<string, unknown>));
  }
}
