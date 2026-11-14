// A fake Hermes host: the API server's wire format (status codes, SSE frames with sequence ids,
// Idempotency-Key replay, the `unknown` status after a restart) and the plugin's calls to the gate,
// driven by a script. It never runs a model or a real tool. What it copies was read from v0.22.5
// (gateway/platforms/api_server_runs.py, website/docs/user-guide/features/api-server.md); the
// behaviour it stands in for is checked by the separate VM journey, not by these tests.
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type Step =
  /** Frame text written as is, with no sequence number. */
  | { raw: string }
  /** A tool call on the normal path: the hook asks the gate, then the tool runs. With `lostReply`, the door's answer never reaches the plugin. */
  | { tool: string; args?: Record<string, unknown>; id?: string; lostReply?: boolean }
  /** The hook could not reach the gate: the plugin blocks the call and counts it, and Hermes emits no tool event. */
  | { unreachable: string; args?: Record<string, unknown>; id?: string }
  /** A tool that ran with no hook at all: Hermes's dispatchers swallow a dispatch failure. */
  | { unhooked: string; args?: Record<string, unknown>; id?: string }
  /** A door call whose hook never ran: the handler reached the gate directly, perhaps replaying the last ticket. */
  | { doorOnly: string; args?: Record<string, unknown>; replayTicket?: boolean }
  /** The hook saw one set of arguments and the door received another. */
  | { tool: string; args: Record<string, unknown>; doorArgs: Record<string, unknown>; id?: string }
  /** The hook is allowed but the door is never reached, and Hermes reports the tool finished. */
  | { skipsDoor: string; args?: Record<string, unknown>; id?: string }
  | { say: string }
  | { event: string; fields?: Record<string, unknown> }
  | { hold: string }
  /** `cutTail` is written after the end with no blank line, then the stream closes: a record cut off. */
  | { end: 'completed' | 'failed' | 'cancelled' | 'interrupted'; output?: string; error?: string; trailing?: { event: string; fields?: Record<string, unknown> }; cutTail?: string };

export const DOORS = ['door_list_files', 'door_read_file', 'door_write_file'];

// The gate protocol as the plugin speaks it, written here apart from src/ so a test checks the
// adapter against the protocol rather than against itself. The plane's secret never travels. The
// turn's key binds the gate's epoch, a random value fresh at each gate start and read at /epoch, so
// a request captured before a restart is worth nothing after it. Each request carries a fresh nonce,
// a time and a MAC over them; each reply a MAC over the same. A gate with no /epoch speaks the older
// form, so these tests can show a defect of that form rather than fail on transport.
const turnKey = (master: string, epoch: string, session: string) => createHmac('sha256', master).update(epoch ? `hermes-gate-turn\n${epoch}\n${session}` : `hermes-gate-turn\n${session}`).digest();
const mac = (key: Buffer, kind: 'req' | 'res', path: string, nonce: string, time: string, body: string) => createHmac('sha256', key).update(time ? `${kind}\n${path}\n${nonce}\n${time}\n${body}` : `${kind}\n${path}\n${nonce}\n${body}`).digest('hex');

/** The gate's epoch, asked with a fresh nonce and checked against the plane's secret, as the plugin does. A gate that only offers a plain GET is the older form. */
export async function gateEpoch(url: string, master = '') {
  const nonce = randomBytes(16).toString('hex');
  try {
    const res = await fetch(`${url}/epoch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
    if (res.ok) {
      const text = await res.text();
      const body = JSON.parse(text) as { epoch?: unknown; time?: unknown };
      const key = createHmac('sha256', master).update('hermes-gate-epoch').digest();
      const want = createHmac('sha256', key).update(`epoch\n${nonce}\n${String(body.epoch)}\n${String(body.time)}`).digest('hex');
      return res.headers.get('x-gate-mac') === want && typeof body.epoch === 'string' ? body.epoch : '';
    }
    const old = await fetch(`${url}/epoch`);
    const body = (await old.json()) as { epoch?: unknown };
    return typeof body?.epoch === 'string' ? body.epoch : '';
  } catch {
    return '';
  }
}

/** One signed request to the gate, as the plugin makes it. `verified` says whether the reply proved the key; `sent` can be replayed byte for byte. */
export async function gateRequest(url: string, master: string, path: string, body: unknown, options: { signal?: AbortSignal; nonce?: string; session?: string; time?: number } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const fromBody = body && typeof body === 'object' && typeof (body as { session_id?: unknown }).session_id === 'string' ? (body as { session_id: string }).session_id : '';
  const epoch = await gateEpoch(url, master);
  const key = turnKey(master, epoch, options.session ?? fromBody);
  const nonce = options.nonce ?? randomBytes(16).toString('hex');
  const time = epoch ? String(options.time ?? Date.now()) : '';
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-gate-nonce': nonce, 'x-gate-mac': mac(key, 'req', path, nonce, time, text), ...(time ? { 'x-gate-time': time } : {}) };
  const res = await fetch(`${url}${path}`, { method: 'POST', signal: options.signal, headers, body: text });
  const reply = await res.text();
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(reply);
  } catch {
    // Not JSON: no fact for the caller.
  }
  return { status: res.status, json, verified: res.headers.get('x-gate-mac') === mac(key, 'res', path, nonce, time, reply), nonce, text, sent: { path, headers, text } };
}

/** The same bytes again, as a captured request would be sent. */
export async function replayGate(url: string, sent: { path: string; headers: Record<string, string>; text: string }) {
  return (await fetch(`${url}${sent.path}`, { method: 'POST', headers: sent.headers, body: sent.text })).status;
}

interface Run {
  id: string;
  body: Record<string, any>;
  key: string | undefined;
  status: string;
  seq: number;
  frames: string[];
  listeners: Set<ServerResponse>;
  output: string;
  usage: Record<string, number>;
  error?: string;
  stopped: boolean;
  generation: number;
}

export interface FakeOptions {
  apiKey: string;
  gateUrl: string;
  gateToken: string;
  version?: string;
  capabilities?: Record<string, unknown>;
  toolsets?: unknown[];
  /** Answer POST /v1/runs with this status and do nothing. */
  refuseRuns?: number;
  /** Drop the connection after accepting POST /v1/runs: the outcome of the request is unknown. */
  dropRunResponse?: boolean;
  /** Hold that dropped response this long, so the run's tools are already moving when it is lost. */
  dropAfterMs?: number;
  /** Refuse POST /stop, as a wedged gateway would. */
  stopFails?: boolean;
  /** Ignore POST /stop and never end the run. */
  stopIgnored?: boolean;
  /** Event connections open and then say nothing, ever: a stalled stream, not a closed one. */
  stallStreams?: boolean;
  /** Answer /v1/toolsets with a 500 this many times, as Hermes does during boot. */
  toolsetsFail?: number;
  /** Accept any bearer key, as a server does while its key rotates. */
  anyKey?: boolean;
  /** The plugin's end-of-turn report never reaches the gate. */
  noReport?: boolean;
}

export class FakeHermes {
  url = '';
  port = 0;
  runs: Run[] = [];
  posts: { key: string | undefined; body: Record<string, any>; auth: string }[] = [];
  stops: string[] = [];
  steers: string[] = [];
  /** The bearer each steer was sent with. */
  steerAuth: string[] = [];
  approvals: string[] = [];
  /** Tools the fake actually ran, as Hermes would have. A refused tool must not appear here. */
  ran: string[] = [];
  /** What the gate told the hook or the door, for each call, as the model would read it. */
  toldModel: string[] = [];
  private server!: Server;
  private sockets = new Set<Socket>();
  private holds = new Map<string, () => void>();
  private held = new Map<string, () => void>();
  private script: Step[][] = [];
  private options: FakeOptions;
  private lastTicket: unknown;
  /** The plugin's local count of decisions it could not get, per session, as `post_llm_call` reports it. */
  private failedDecides = new Map<string, number>();
  /** Called as POST /v1/runs arrives, so a test can see what was durable by then. */
  onPost: (() => void) | undefined;

  constructor(options: FakeOptions) {
    this.options = options;
  }

  /** The steps of the next run. */
  queue(...steps: Step[]) {
    this.script.push(steps);
    return this;
  }

  async listen(port = 0) {
    this.server = createServer((req, res) => void this.handle(req.method ?? '', req.url ?? '', req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this;
  }

  /** kill -9: every connection drops and nothing finishes. The state stays, as state.db would. */
  async kill() {
    for (const run of this.runs) if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) run.status = 'unknown';
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
    for (const release of this.held.values()) release();
  }

  /** The gateway comes back on the same port; runs it lost stay `unknown`. */
  restart() {
    return this.listen(this.port);
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
    for (const release of this.held.values()) release();
  }

  /** Cut the event stream only; the run goes on. */
  dropStreams() {
    for (const run of this.runs) for (const res of run.listeners) res.destroy();
  }

  /** Resolves when a `hold` step is reached. */
  reached(name: string) {
    return new Promise<void>((resolve) => {
      if (this.held.has(name)) resolve();
      else this.holds.set(name, resolve);
    });
  }

  release(name: string) {
    this.held.get(name)?.();
  }

  private async handle(method: string, url: string, req: import('node:http').IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const path = url.split('?')[0];
    if (path === '/health') return json(res, 200, { status: 'ok', platform: 'hermes-agent', version: this.options.version ?? '0.22.5' });
    if (!this.options.anyKey && req.headers.authorization !== `Bearer ${this.options.apiKey}`) return json(res, 401, { error: { message: 'unauthorized' } });
    if (path === '/v1/capabilities') {
      return json(res, 200, { object: 'hermes.api_server.capabilities', features: this.options.capabilities ?? { run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true, run_unknown_resolution: true, runs_idempotency: { supported: true, durable: true } } });
    }
    if (path === '/v1/toolsets' && (this.options.toolsetsFail ?? 0) > 0) {
      this.options.toolsetsFail! -= 1;
      return json(res, 500, { error: { message: 'Failed to enumerate toolsets' } });
    }
    if (path === '/v1/toolsets') return json(res, 200, { object: 'list', platform: 'api_server', data: this.options.toolsets ?? [{ name: 'door', enabled: true, configured: true, tools: DOORS }, { name: 'terminal', enabled: false, configured: true, tools: ['terminal'] }] });
    if (path === '/v1/runs' && method === 'POST') return this.create(req.headers['idempotency-key'] as string | undefined, JSON.parse(raw), res, String(req.headers.authorization ?? ''));
    const match = /^\/v1\/runs\/([^/]+)(?:\/(events|stop|steer|approval))?$/.exec(path);
    const run = this.runs.find((r) => r.id === match?.[1]);
    if (!match || !run) return json(res, 404, { error: { message: 'no such run' } });
    if (!match[2]) return json(res, 200, { object: 'hermes.run', run_id: run.id, status: run.status, session_id: run.body.session_id, output: run.output, usage: run.usage, ...(run.status === 'unknown' ? { admission_id: 'adm', execution_generation: run.generation } : {}), ...(run.error ? { error: run.error } : {}) });
    if (match[2] === 'events') return this.subscribe(run, new URL(url, 'http://x').searchParams.get('last_seq'), res);
    if (match[2] === 'steer') {
      this.steers.push(JSON.parse(raw).input);
      this.steerAuth.push(String(req.headers.authorization ?? ''));
      return json(res, 200, { status: 'queued' });
    }
    if (match[2] === 'approval') {
      this.approvals.push(raw);
      return json(res, 200, {});
    }
    this.stops.push(run.id);
    if (this.options.stopFails) return json(res, 503, { error: { message: 'runtime_draining' } });
    if (run.status === 'unknown') return json(res, 409, { error: { code: 'unknown_execution' } });
    run.stopped = true;
    if (!this.options.stopIgnored) for (const release of this.held.values()) release();
    return json(res, 200, { status: 'stopping' });
  }

  private create(key: string | undefined, body: Record<string, any>, res: ServerResponse, auth = '') {
    this.posts.push({ key, body, auth });
    this.onPost?.();
    if (this.options.refuseRuns) return json(res, this.options.refuseRuns, { error: { message: 'refused' } });
    const existing = key && this.runs.find((r) => r.key === key);
    if (existing) {
      res.setHeader('Idempotency-Replayed', 'true');
      return json(res, 202, { run_id: existing.id, status: existing.status });
    }
    const run: Run = { id: `run_${this.runs.length + 1}`, body, key, status: 'running', seq: -1, frames: [], listeners: new Set(), output: '', usage: { input_tokens: 21, output_tokens: 8 }, stopped: false, generation: 1 };
    this.runs.push(run);
    void this.play(run, this.script.shift() ?? [{ end: 'completed', output: 'Done.' }]);
    if (this.options.dropRunResponse) {
      setTimeout(() => res.destroy(), this.options.dropAfterMs ?? 0);
      return;
    }
    return json(res, 202, { run_id: run.id, status: 'started' });
  }

  private subscribe(run: Run, lastSeq: string | null, res: ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': open\n\n');
    if (this.options.stallStreams) return;
    const from = lastSeq === null ? 0 : Number(lastSeq) + 1;
    for (const frame of run.frames.slice(from)) res.write(frame);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      res.end(': stream closed\n\n');
      return;
    }
    run.listeners.add(res);
    res.on('close', () => run.listeners.delete(res));
  }

  /** Lose the next event from the record, as a gap in the stream would. */
  skipNextSeq() {
    for (const run of this.runs) {
      run.seq += 1;
      run.frames.push('');
    }
  }

  private emit(run: Run, name: string, fields: Record<string, unknown> = {}) {
    if (run.status === 'unknown') return;
    run.seq += 1;
    const frame = `id: ${run.seq}\ndata: ${JSON.stringify({ event: name, run_id: run.id, timestamp: 0, seq: run.seq, ...fields })}\n\n`;
    run.frames.push(frame);
    for (const res of run.listeners) res.write(frame);
  }

  /** As the plugin: a reply that does not prove the key is no reply. */
  private async gate(path: string, body: unknown): Promise<Record<string, any>> {
    const reply = await gateRequest(this.options.gateUrl, this.options.gateToken, path, body);
    if (!reply.verified || !reply.json) throw new Error('the gate did not prove it holds the key');
    return reply.json;
  }

  private async call(run: Run, tool: string, args: Record<string, unknown>, id: string, doorArgs = args, hooked = true, lostReply = false) {
    const session_id = run.body.session_id;
    let blocked: string | undefined;
    let ticket: unknown;
    if (hooked) {
      // The plugin's fail-closed path: no answer from the gate is a block.
      const decision: Record<string, any> = await this.gate('/decide', { session_id, tool_call_id: id, tool_name: tool, args }).catch(() => {
        this.failedDecides.set(session_id, (this.failedDecides.get(session_id) ?? 0) + 1);
        return { action: 'block', message: 'unreachable' };
      });
      if (decision.action !== 'allow') blocked = String(decision.message);
      ticket = decision.ticket;
      this.lastTicket = ticket;
    }
    if (blocked !== undefined) {
      // As Hermes v0.22.5 does: a blocked call emits neither tool.started nor tool.completed.
      this.toldModel.push(blocked);
      return;
    }
    this.emit(run, 'tool.started', { tool, preview: '', tool_call_id: id });
    if (DOORS.includes(tool)) {
      const reply = await this.gate('/call', { session_id, tool_name: tool, args: doorArgs, ...(ticket ? { ticket } : {}) }).catch(() => ({ text: 'unreachable' }));
      this.toldModel.push(String(reply.text));
      // As the plugin does: the answer reached the handler, so say so before Hermes goes on.
      if (ticket && !lostReply) await this.gate('/delivered', { session_id, ticket }).catch(() => undefined);
    } else {
      this.ran.push(tool);
    }
    this.emit(run, 'tool.completed', { tool, duration: 0, error: false, preview: '', tool_call_id: id });
  }

  private async play(run: Run, steps: Step[]) {
    // Yield so the client can subscribe, as the real run starts on another task.
    await new Promise((r) => setTimeout(r, 5));
    let n = 0;
    for (const step of steps) {
      if (run.status === 'unknown') return;
      if (run.stopped) break;
      n += 1;
      if ('say' in step) this.emit(run, 'message.delta', { delta: step.say });
      else if ('raw' in step) {
        const frame = `data: ${step.raw}\n\n`;
        run.frames.push(frame);
        run.seq += 1;
        for (const res of run.listeners) res.write(frame);
      }
      else if ('event' in step) this.emit(run, step.event, step.fields ?? {});
      else if ('hold' in step) {
        await new Promise<void>((resolve) => {
          this.held.set(step.hold, () => {
            this.held.delete(step.hold);
            resolve();
          });
          this.holds.get(step.hold)?.();
        });
      } else if ('end' in step) {
        await this.report(run);
        return this.finish(run, step.end, step.output, step.error, step.trailing, step.cutTail);
      } else if ('unreachable' in step) {
        // As Hermes does for a blocked call: no tool.started, no tool.completed.
        const session_id = run.body.session_id;
        this.failedDecides.set(session_id, (this.failedDecides.get(session_id) ?? 0) + 1);
        this.toldModel.push('The gate did not allow this tool call, so it was not run.');
      }
      else if ('skipsDoor' in step) {
        const id = step.id ?? `call_${n}`;
        await this.gate('/decide', { session_id: run.body.session_id, tool_call_id: id, tool_name: step.skipsDoor, args: step.args ?? {} });
        this.emit(run, 'tool.completed', { tool: step.skipsDoor, duration: 0, error: false, preview: '', tool_call_id: id });
      } else if ('unhooked' in step) await this.call(run, step.unhooked, step.args ?? {}, step.id ?? `call_${n}`, step.args ?? {}, false);
      else if ('doorOnly' in step) {
        const session_id = run.body.session_id;
        const reply = await this.gate('/call', { session_id, tool_name: step.doorOnly, args: step.args ?? {}, ...(step.replayTicket ? { ticket: this.lastTicket } : {}) });
        this.toldModel.push(String(reply.text));
      } else await this.call(run, step.tool, step.args ?? {}, step.id ?? `call_${n}`, 'doorArgs' in step ? step.doorArgs : (step.args ?? {}), true, 'lostReply' in step && step.lostReply === true);
    }
    if (run.stopped) return this.finish(run, 'cancelled');
    if (run.status === 'running') {
      await this.report(run);
      this.finish(run, 'completed', 'Done.');
    }
  }

  /** The plugin's post_llm_call: once per turn, after the tool loop, before the run completes. */
  private async report(run: Run) {
    const session_id = run.body.session_id;
    const failed = this.failedDecides.get(session_id) ?? 0;
    if (!this.options.noReport) await this.gate('/report', { session_id, failed }).catch(() => undefined);
  }

  private finish(run: Run, status: 'completed' | 'failed' | 'cancelled' | 'interrupted', output = '', error?: string, trailing?: { event: string; fields?: Record<string, unknown> }, cutTail?: string) {
    if (run.status === 'unknown') return;
    run.status = status;
    run.output = output;
    if (error) run.error = error;
    this.emit(run, `run.${status}`, { output, usage: run.usage, ...(error ? { error } : {}) });
    if (trailing) this.emit(run, trailing.event, trailing.fields ?? {});
    if (cutTail !== undefined) {
      for (const res of run.listeners) res.end(cutTail);
      return;
    }
    for (const res of run.listeners) res.end(': stream closed\n\n');
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
