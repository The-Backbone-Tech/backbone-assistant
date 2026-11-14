// The real journey: this adapter against real Hermes in a disposable VM with no mounts and egress
// dropped, with a scripted model and synthetic data. Run it by hand, never in `pnpm check`:
//   node packages/modules/harness-hermes/journey/drive.ts <lima-instance> [journey ...]
// The VM must already hold Hermes in $HOME/hermes and journey/scripted_model.py in $HOME/scripted_model.py.
// journey/vm/ defines that VM and its fetch window, with the evidence of the last run (fetch-window.md).
// Node stays out of the VM: one SSH channel carries the API server out and the gate in, both on
// loopback, and the gate serves only a fake ToolHost with synthetic files. Each journey prints one
// JSON line; a journey that throws reports its failure and the rest still run.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { HarnessEvent, ModelRoute, ToolHost, TurnRequest, WriteOutcome } from '@backbone-next/platform/ports';
import { createHermesHarness, writePlane, HERMES_COMMIT, type Narrow } from '../src/index.ts';

const instance = process.argv[2];
if (!instance) throw new Error('usage: drive.ts <lima-instance> [journey ...]');
const only = process.argv.slice(3);
const run = promisify(execFile);
const vm = async (cmd: string, timeout = 60_000) => (await run('limactl', ['shell', instance, 'bash', '-c', cmd], { timeout, maxBuffer: 1 << 24 })).stdout.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const API_PORT = 18642;
const GATE_PORT = 19911;
const VM_GATE_PORT = 9911;

const route: ModelRoute = { kind: 'endpoint', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:8900/v1', model: 'scripted-1', label: 'Scripted model', credential: null };
const request = (turnId: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({ threadId: 'journey', turnId, text: 'Do the scripted work.', history: [], attachments: [], effort: 3, resumed: false, ...extra });

function fakeHost(onWrite?: (signal: AbortSignal) => Promise<WriteOutcome>) {
  const writes: string[] = [];
  const host: ToolHost = {
    list: async () => [{ name: 'note.md', version: 1, by: 'person', class: 'original', mediaType: 'text/markdown' }],
    read: async (name) => (name === 'note.md' ? { name, version: 1, by: 'person', class: 'original', mediaType: 'text/markdown', text: 'Synthetic note. Revenue up 4%.' } : null),
    write: async (name, _body, signal) => {
      writes.push(name);
      return onWrite ? onWrite(signal) : { outcome: 'DONE', name, version: 1 };
    },
  };
  return { host, writes };
}

async function collect(turn: { events: AsyncIterable<HarnessEvent> }) {
  const all: HarnessEvent[] = [];
  for await (const e of turn.events) all.push(e);
  return all;
}
const phases = (events: HarnessEvent[]) => events.flatMap((e) => (e.type === 'tool' ? [`${e.tool}:${e.phase}`] : []));
const requests = async () => Number(await vm('[ -f $HOME/model/requests.jsonl ] && wc -l < $HOME/model/requests.jsonl || echo 0'));
/** What the model was told and offered on its last real step; Hermes also makes side requests with no tools. */
const lastStep = async () => JSON.parse(await vm(`[ -f $HOME/model/requests.jsonl ] || { echo '{"tool":[],"offered":[]}'; exit 0; }; `+`python3 - <<'P'\nimport json,os\nrows=[json.loads(l) for l in open(os.environ['HOME']+'/model/requests.jsonl')]\nr=[x for x in rows if x['tools']][-1]\nprint(json.dumps({'tool':[str(m.get('content'))[:220] for m in r['messages'] if m.get('role')=='tool'],'offered':r['tools']}))\nP`)) as { tool: string[]; offered: string[] };
const killHermes = () => vm("pkill -9 -f '[h]ermes_cli.main|[.]venv/bin/hermes' ; true");

async function script(name: string, steps: unknown[]) {
  await vm(`mkdir -p $HOME/model/scripts $HOME/fx; rm -f $HOME/model/hold.* $HOME/model/release.* $HOME/fx/*; cat > $HOME/model/scripts/${name}.json <<'J'\n${JSON.stringify(steps)}\nJ\necho ${name} > $HOME/model/active`);
}

class Plane {
  apiKey = randomBytes(24).toString('hex');
  gateToken = randomBytes(24).toString('hex');
  name: string;
  home: string;

  constructor(name: string) {
    this.name = name;
    this.home = `$HOME/run/${name}`;
  }

  async write(gatePort = VM_GATE_PORT) {
    const local = await mkdtemp(join(tmpdir(), 'hermes-plane-'));
    await writePlane(local, { gateUrl: `http://127.0.0.1:${gatePort}`, gateToken: this.gateToken, modelBaseUrl: route.baseUrl, model: route.model });
    await vm(`rm -rf ${this.home}; mkdir -p $HOME/run`);
    await run('limactl', ['copy', '-r', local, `${instance}:run/${this.name}`]);
    await vm(`printf 'API_SERVER_ENABLED=true\\nAPI_SERVER_KEY=${this.apiKey}\\nOPENAI_API_KEY=synthetic-${this.name}\\n' > ${this.home}/.env; chmod 600 ${this.home}/.env`);
    await rm(local, { recursive: true, force: true });
  }

  async start() {
    await vm(`cd $HOME/run; HERMES_HOME=$HOME/run/${this.name} nohup $HOME/hermes/.venv/bin/hermes gateway run > ${this.home}/gateway.log 2>&1 < /dev/null & disown; true`);
    for (let i = 0; i < 240; i += 1) {
      if (await fetch(`http://127.0.0.1:${API_PORT}/health`).then((r) => r.ok, () => false)) return;
      await sleep(500);
    }
    throw new Error(`gateway did not start: ${await vm(`tail -n 20 ${this.home}/gateway.log`)}`);
  }

  harness(narrow?: Narrow, journalDir?: string) {
    return createHermesHarness({ baseUrl: `http://127.0.0.1:${API_PORT}`, apiKey: async () => this.apiKey, gate: { host: '127.0.0.1', port: GATE_PORT, token: this.gateToken }, journalDir: journalDir!, narrow, planeModel: { baseUrl: route.baseUrl, model: route.model }, stopTimeoutMs: 15_000, lostAfterMs: 10_000, settleMs: 3_000 });
  }
}

const context = (tools: ToolHost) => ({ tools, route, credential: async () => { throw new Error('no credential in this journey'); } });

const journeys: Record<string, (dir: string) => Promise<Record<string, unknown>>> = {
  /** A read, a list and a write cross through the door; the tool ids Hermes reports match the gate's. */
  async baseline(dir) {
    const p = new Plane('baseline');
    await p.write();
    await script('baseline', [{ call: 'door_list_files' }, { call: 'door_read_file', args: { name: 'note.md' } }, { call: 'door_write_file', args: { name: 'brief.md', content: '# Brief' } }, { final: 'Wrote brief.md v1.' }]);
    await p.start();
    const h = p.harness(undefined, dir);
    const { host, writes } = fakeHost();
    const turn = h.start(request('t1'), context(host));
    const [events, outcome] = await Promise.all([collect(turn), turn.outcome]);
    await h.close();
    return { outcome, phases: phases(events), writes, modelRequests: await requests() };
  },
  /** A native tool on the default plane: it is not there to call, and its effect does not happen. */
  async refused(dir) {
    const p = new Plane('refused');
    await p.write();
    await script('refused', [{ call: 'terminal', args: { command: 'touch $HOME/fx/EFFECT' } }, { final: 'Refused.' }]);
    await p.start();
    const h = p.harness(undefined, dir);
    const turn = h.start(request('t1'), context(fakeHost().host));
    const [events, outcome] = await Promise.all([collect(turn), turn.outcome]);
    await h.close();
    const last = await lastStep();
    return { outcome, phases: phases(events), effectFiles: await vm('ls $HOME/fx | wc -l'), toldModel: last.tool, offered: last.offered };
  },
  /** The plugin fails closed for real: the gate's port is dead, so a door write is blocked at the hook. */
  async gateDown(dir) {
    const p = new Plane('gatedown');
    await p.write(9); // discard port: nothing listens
    await script('gatedown', [{ call: 'door_write_file', args: { name: 'a.md', content: 'x' } }, { final: 'Blocked.' }]);
    await p.start();
    const h = p.harness(undefined, dir);
    const { host, writes } = fakeHost();
    const turn = h.start(request('t1'), context(host));
    const [events, outcome] = await Promise.all([collect(turn), turn.outcome]);
    await h.close();
    return { outcome, phases: phases(events), writes, toldModel: (await lastStep()).tool };
  },
  /** The positive control: the same script with no plugin and no adapter does make the file. */
  async control() {
    const p = new Plane('control');
    await p.write();
    await vm(`rm -rf ${p.home}/plugins/host_gate; sed -i 's/^    - door$/    - terminal/' ${p.home}/config.yaml`);
    await script('control', [{ call: 'terminal', args: { command: 'touch $HOME/fx/EFFECT' } }, { final: 'Ran.' }]);
    await p.start();
    const res = await fetch(`http://127.0.0.1:${API_PORT}/v1/runs`, { method: 'POST', headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ input: 'Do the scripted work.', session_id: 'control' }) });
    const { run_id: id } = (await res.json()) as { run_id: string };
    for (let i = 0; i < 120; i += 1) {
      const status = (await (await fetch(`http://127.0.0.1:${API_PORT}/v1/runs/${id}`, { headers: { authorization: `Bearer ${p.apiKey}` } })).json()) as { status: string };
      if (status.status !== 'running' && status.status !== 'queued') break;
      await sleep(250);
    }
    return { effectFiles: await vm('ls $HOME/fx | wc -l'), toldModel: (await lastStep()).tool };
  },
  /** The hook machinery failing, for real, on the default plane: no hook registers, and there is no native tool to reach and no ticket for the door. */
  async hookless(dir) {
    const p = new Plane('hookless');
    await p.write();
    await vm(`sed -i '/register_hook/d' ${p.home}/plugins/host_gate/__init__.py`);
    await script('hookless', [{ call: 'terminal', args: { command: 'touch $HOME/fx/EFFECT' } }, { call: 'door_write_file', args: { name: 'a.md', content: 'x' } }, { final: 'All fine.' }]);
    await p.start();
    const h = p.harness(undefined, dir);
    const { host, writes } = fakeHost();
    const turn = h.start(request('t1'), context(host));
    const [events, outcome] = await Promise.all([collect(turn), turn.outcome]);
    await h.close();
    const last = await lastStep();
    return { outcome, phases: phases(events), writes, effectFiles: await vm('ls $HOME/fx | wc -l'), offered: last.offered };
  },
  /** Backbone itself is killed -9 during a door write: its own gate dies, the next call finds no gate, and a restart reports UNKNOWN and repeats nothing. */
  async crash(dir) {
    const p = new Plane('crash');
    await p.write();
    await script('crash', [{ call: 'door_write_file', args: { name: 'a.md', content: 'x' } }, { call: 'door_write_file', args: { name: 'b.md', content: 'y' } }, { final: 'Finished with no gate.' }]);
    await p.start();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), instance], { env: { ...process.env, HERMES_JOURNEY_CHILD: JSON.stringify({ apiKey: p.apiKey, gateToken: p.gateToken, dir }) }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => { if (d.includes('writing')) resolve(); });
      child.once('exit', () => reject(new Error('the child ended before its write')));
    });
    child.removeAllListeners('exit');
    child.kill('SIGKILL');
    await sleep(6000);
    const before = await requests();
    const told = (await lastStep()).tool;
    const after = p.harness(undefined, dir);
    const { host, writes } = fakeHost();
    const resumed = after.start(request('t1', { resumed: true }), context(host));
    const [events, outcome] = await Promise.all([collect(resumed), resumed.outcome]);
    await sleep(2000);
    await after.close();
    return { outcome, phases: phases(events), writesAfterRestart: writes, noReplay: (await requests()) === before, toldModelAfterTheCrash: told };
  },
  /** Stop while the gateway holds a write: UNKNOWN, one write, the run settles cancelled. */
  async stop(dir) {
    const p = new Plane('stop');
    await p.write();
    await script('stop', [{ call: 'door_write_file', args: { name: 'a.md', content: 'x' } }, { call: 'door_write_file', args: { name: 'late.md', content: 'y' } }, { final: 'never' }]);
    await p.start();
    const h = p.harness(undefined, dir);
    let started!: () => void;
    const writing = new Promise<void>((r) => (started = r));
    const { host, writes } = fakeHost((signal) => {
      started();
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'UNKNOWN', detail: 'Stopped during the write. UNKNOWN.' }), { once: true }));
    });
    const turn = h.start(request('t1'), context(host));
    const all = collect(turn);
    await writing;
    turn.stop();
    const outcome = await turn.outcome;
    await h.close();
    return { outcome, phases: phases(await all), writes };
  },
  /** Policy tightened mid-run: Hermes still offers the tool; the gate decides at the next call. */
  async tightened(dir) {
    const p = new Plane('tightened');
    await p.write();
    await script('tightened', [{ call: 'door_write_file', args: { name: 'a.md', content: 'x' } }, { hold: 'tighten', then: { call: 'door_write_file', args: { name: 'b.md', content: 'y' } } }, { final: 'Stopped writing.' }]);
    await p.start();
    let tight = false;
    const h = p.harness(() => (tight ? 'Writes were withdrawn from this thread.' : null), dir);
    const { host, writes } = fakeHost();
    const turn = h.start(request('t1'), context(host));
    const all = collect(turn);
    for (let i = 0; i < 240 && (await vm('ls $HOME/model/hold.tighten 2>/dev/null | wc -l')) === '0'; i += 1) await sleep(500);
    tight = true;
    await vm('touch $HOME/model/release.tighten');
    const outcome = await turn.outcome;
    await h.close();
    const last = await lastStep();
    return { outcome, phases: phases(await all), writes, stillOfferedByHermes: last.offered.includes('door_write_file'), toldModel: last.tool };
  },
  /** kill -9 during a door write: UNKNOWN here, `unknown` there; a restart replays nothing, and the next turn is not fenced. */
  async kill(dir) {
    const p = new Plane('kill');
    await p.write();
    await script('kill', [{ call: 'door_write_file', args: { name: 'a.md', content: 'x' } }, { final: 'never' }]);
    await p.start();
    const h = p.harness(undefined, dir);
    let started!: () => void;
    const writing = new Promise<void>((r) => (started = r));
    const { host, writes } = fakeHost((signal) => {
      started();
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ outcome: 'UNKNOWN', detail: 'Lost during the write. UNKNOWN.' }), { once: true }));
    });
    const turn = h.start(request('t1'), context(host));
    const all = collect(turn);
    await writing;
    await killHermes();
    const outcome = await turn.outcome;
    const before = await requests();
    await h.close();
    await p.start();
    await sleep(5000);
    const runs = await vm(`python3 - <<'P'\nimport sqlite3,os\nc=sqlite3.connect(os.environ['HOME']+'/run/kill/state.db')\nprint(c.execute('select status,outcome from session_admissions').fetchall())\nP`);
    const after = p.harness(undefined, dir);
    const resumed = after.start(request('t1', { resumed: true }), context(fakeHost().host));
    const [resumedEvents, resumedOutcome] = await Promise.all([collect(resumed), resumed.outcome]);
    await sleep(3000);
    const noReplay = (await requests()) === before;
    await script('next', [{ final: 'The next turn runs.' }]);
    const next = after.start(request('t2'), context(fakeHost().host));
    const [, nextOutcome] = await Promise.all([collect(next), next.outcome]);
    await after.close();
    return { outcome, phases: phases(await all), writes, hermesAdmissions: runs, resumed: { outcome: resumedOutcome, phases: phases(resumedEvents) }, noReplay, nextTurn: nextOutcome };
  },
  /** A finished turn started again with `resumed: false`: its claim holds, so it only recovers, and nothing reaches the model. */
  async reclaimed(dir) {
    const p = new Plane('reclaimed');
    await p.write();
    await script('reclaimed', [{ call: 'door_write_file', args: { name: 'a.md', content: 'x' } }, { final: 'Wrote a.md.' }]);
    await p.start();
    const h = p.harness(undefined, dir);
    const first = fakeHost();
    const turn = h.start(request('t1'), context(first.host));
    const [, outcome] = await Promise.all([collect(turn), turn.outcome]);
    const before = await requests();
    const second = fakeHost();
    const retry = h.start(request('t1'), context(second.host));
    const [, retried] = await Promise.all([collect(retry), retry.outcome]);
    await sleep(2000);
    await h.close();
    return { outcome, retried, writes: first.writes, writesOnRetry: second.writes, noReplay: (await requests()) === before };
  },
  /** Stop while the host holds a read: the material it then returns never reaches Hermes. */
  async pendingRead(dir) {
    const p = new Plane('pendingread');
    await p.write();
    await script('pendingread', [{ call: 'door_read_file', args: { name: 'note.md' } }, { final: 'Read it.' }]);
    await p.start();
    const h = p.harness(undefined, dir);
    let reading!: () => void;
    let answer!: () => void;
    const started = new Promise<void>((r) => (reading = r));
    const held = new Promise<void>((r) => (answer = r));
    const { host } = fakeHost();
    const read = host.read;
    host.read = async (name) => {
      reading();
      await held;
      return read(name);
    };
    const turn = h.start(request('t1'), context(host));
    const all = collect(turn);
    await started;
    turn.stop();
    answer();
    const outcome = await turn.outcome;
    await sleep(2000);
    await h.close();
    const material = await vm("grep -c 'Revenue up 4%' $HOME/model/requests.jsonl || true");
    return { outcome, phases: phases(await all), material };
  },
  /** The plugin off: admission refuses and no run starts. */
  async pluginOff(dir) {
    const p = new Plane('pluginoff');
    await p.write();
    await vm(`rm -rf ${p.home}/plugins/host_gate`);
    await script('pluginoff', [{ final: 'never' }]);
    await p.start();
    const h = p.harness(undefined, dir);
    const turn = h.start(request('t1'), context(fakeHost().host));
    const [, outcome] = await Promise.all([collect(turn), turn.outcome]);
    await h.close();
    return { outcome, modelRequests: await requests() };
  },
};

// The process the crash journey kills: it holds one write open and says so.
if (process.env.HERMES_JOURNEY_CHILD) {
  const { apiKey, gateToken, dir } = JSON.parse(process.env.HERMES_JOURNEY_CHILD) as { apiKey: string; gateToken: string; dir: string };
  const h = createHermesHarness({ baseUrl: `http://127.0.0.1:${API_PORT}`, apiKey: async () => apiKey, gate: { host: '127.0.0.1', port: GATE_PORT, token: gateToken }, journalDir: dir, planeModel: { baseUrl: route.baseUrl, model: route.model } });
  const { host } = fakeHost(() => {
    console.log('writing');
    return new Promise(() => undefined);
  });
  await h.start(request('t1'), context(host)).outcome;
  process.exit(0);
}

type Seen = Record<string, any>;
const has = (r: Seen, phase: string) => (r.phases as string[]).includes(phase);
/** What each journey must show. A journey that shows anything else fails the run. */
const expected: Record<string, (r: Seen) => boolean> = {
  baseline: (r) => r.outcome.status === 'done' && r.writes.length === 1 && has(r, 'door_write_file:done'),
  refused: (r) => r.effectFiles === '0' && !r.offered.includes('terminal'),
  // Changed 2 November: this journey used to end done, a defect; a call blocked by a dead gate now keeps the turn from done.
  gateDown: (r) => r.outcome.status !== 'done' && r.writes.length === 0 && /did not allow/.test(r.toldModel[0]),
  control: (r) => r.effectFiles === '1',
  hookless: (r) => r.outcome.status !== 'done' && r.writes.length === 0 && r.effectFiles === '0' && !r.offered.includes('terminal'),
  crash: (r) => r.outcome.status === 'interrupted' && has(r, 'door_write_file:unknown') && r.writesAfterRestart.length === 0 && r.noReplay === true,
  stop: (r) => r.outcome.status === 'interrupted' && r.writes.length === 1 && has(r, 'door_write_file:unknown'),
  tightened: (r) => r.writes.length === 1 && has(r, 'door_write_file:refused') && r.stillOfferedByHermes === true,
  kill: (r) => r.outcome.status === 'interrupted' && r.writes.length === 1 && has(r, 'door_write_file:unknown') && /unknown/.test(r.hermesAdmissions) && r.noReplay === true && r.nextTurn.status === 'done' && r.resumed.phases.includes('door_write_file:unknown'),
  reclaimed: (r) => r.outcome.status === 'done' && r.retried.status === 'interrupted' && r.writes.length === 1 && r.writesOnRetry.length === 0 && r.noReplay === true,
  pendingRead: (r) => r.outcome.status === 'interrupted' && r.material === '0',
  pluginOff: (r) => r.outcome.status === 'failed' && r.modelRequests === 0,
};

let tunnel: ChildProcess | undefined;
let failures = 0;
try {
  console.log(JSON.stringify({ versions: await vm('$HOME/hermes/.venv/bin/hermes --version | head -1; $HOME/hermes/.venv/bin/python -V'), pinned: HERMES_COMMIT, firewall: await vm('sudo iptables -S OUTPUT | head -4') }));
  await vm("python3 -I $HOME/scripted_model.py > /dev/null 2>&1 < /dev/null & disown; true");
  tunnel = spawn('ssh', ['-F', join(homedir(), '.lima', instance, 'ssh.config'), '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${API_PORT}:127.0.0.1:8642`, '-R', `127.0.0.1:${VM_GATE_PORT}:127.0.0.1:${GATE_PORT}`, `lima-${instance}`], { stdio: 'ignore' });
  await sleep(1500);
  for (const [name, journey] of Object.entries(journeys)) {
    if (only.length && !only.includes(name)) continue;
    const dir = await mkdtemp(join(tmpdir(), 'hermes-journal-'));
    await vm('rm -f $HOME/model/requests.jsonl');
    const started = Date.now();
    const result = await journey(dir).then((r) => ({ journey: name, ...r }), (e: unknown) => ({ journey: name, threw: String(e) }));
    const passed = !('threw' in result) && expected[name](result);
    if (!passed) failures += 1;
    console.log(JSON.stringify({ passed, ...result, ms: Date.now() - started }));
    await killHermes();
    // A journey must not start against the last journey's gateway.
    for (let i = 0; i < 60 && (await fetch(`http://127.0.0.1:${API_PORT}/health`).then((r) => r.ok, () => false)); i += 1) await sleep(250);
    await sleep(800);
    await rm(dir, { recursive: true, force: true });
  }
} finally {
  tunnel?.kill();
  await vm("pkill -f '[s]cripted_model.py'; true").catch(() => undefined);
}
console.log(failures ? `${failures} journey(s) failed.` : 'All journeys passed.');
process.exit(failures ? 1 : 0);
