#!/usr/bin/env node
import { terminalModelHint } from '@backbone-next/platform';
import {remoteCommand,teamCommand,sharedDaemonState} from './remote.ts';
import { runExec } from './exec.ts';
import { doctorResult } from './doctor-result.ts';
import { policyFor, policyDescription } from '@backbone-next/platform/policy';
import { inspectTelemetryStatus } from '@backbone-next/platform/composition/telemetry';
// backbone: the person's command line over the platform api. A running app's api line if there is one;
// otherwise one process, one command, one hold of the data home (session.ts). `backbone --help` lists
// the commands and the exit codes.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalHome, type Host, pnpmCheck, postgresCheck, sharedMemoryCheck } from '@backbone-next/platform/composition';
import { join, resolve } from 'node:path';
import { attachApi, LineSilent } from '@backbone-next/platform/doors/api-line';
import { KeysRefused } from '@backbone-next/platform/keys';
import {assertHomeWriteAdmission} from '@backbone-next/platform/composition/home-lock';
import { createInterface } from 'node:readline';
import { engineClientChecks } from './doctor-engine.ts';
import { selectedHarness } from '@backbone-next/platform/composition/engine-settings';
import { selectedMachineClientCheck } from '@backbone-next/platform/machine-client';
import { doctorModelSettings } from './machine-client-status.ts';
import {standingSignaturesCheck} from './doctor-signatures.ts';
import { versionLine } from './version.ts';
import { runChat, type ChatKey } from './chat.ts';
import { completeHome, unfinishedHome } from './home-readiness.ts';
import { keyRefusalLine } from './daemon-key-refusal.ts';
import { cliKeyRefusal, keyHomeRecovery } from './key-recovery.ts';
import { keyProviderCheck } from './key-provider.ts';
import { fullScreen } from './screen.ts';
import { EXIT, parse, runCommand, USAGE, type Api, type Io, type Parsed } from './commands.ts';
import { alive, AppClosed, HomeAbsent, HomeHeld, readHolder, refuseClosedApp, withHome } from './session.ts';
import { BackupRefused, importHome, type ImportPlan, newHome } from '@backbone-next/platform/composition/backup';
import { DaemonBusy, daemonFile, install, launchd, runDaemon, status as agentStatus, uninstall } from './daemon.ts';

const io: Io = {
  out: (text) => void process.stdout.write(`${text}\n`),
  err: (text) => void process.stderr.write(`${text}\n`),
  onInterrupt: (fn) => void process.once('SIGINT', fn),
  holding: () => {},
  pollMs: 100,
  stopWaitMs: 30_000,
};

/** Commands that only read: they open read-only, so none of them can start a model call. */
const READS = new Set(['solutions options', 'solutions verify', 'projects list', 'threads list', 'threads show', 'now', 'files', 'files read', 'models', 'export']);
/** Commands that change the home: an interrupted turn is carried on before them. */
const CHANGES = new Set(['solutions run', 'projects create', 'threads archive', 'send', 'stop', 'chat', 'goal set', 'goal run', 'queue', 'schedule add']);
/** Commands whose write the app asks the person about, each one, when it goes over the app's line. */
const ASKED = new Set(['solutions run', 'send', 'chat', 'goal', 'goal set', 'goal run', 'queue', 'schedule add']);

/**
 * The interactive session: lines from the terminal, and Ctrl-C passed to the turn in hand (each send
 * or goal registers its own stop); with none running, it says how to leave.
 */
function chat(parsed: Parsed, api: Api, base: Io): Promise<number> {
  // Full screen at a terminal (unless --json asks for plain lines); piped input keeps plain output.
  const screen = process.stdin.isTTY && process.stdout.isTTY && !parsed.json ? fullScreen((s) => void process.stdout.write(s), () => ({ rows: process.stdout.rows || 24, columns: process.stdout.columns || 80 })) : null;
  if (screen) { base = { ...base, out: screen.out, err: screen.err }; process.stdout.on('resize', screen.layout); process.once('exit', screen.close); }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let stopping: (() => void) | undefined;
  const interrupt = () => { const fn = stopping; stopping = undefined; if (fn) fn(); else base.out('(/quit to leave)'); };
  rl.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);
  // Lines are queued as they come, so none typed (or piped) while a turn runs is lost.
  const lines: string[] = [];
  let closed = false;
  let waiting: ((line: string | null) => void) | undefined;
  rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = undefined; w(l); } else lines.push(l); });
  rl.once('close', () => { closed = true; waiting?.(null); waiting = undefined; });
  // At a full screen: Ctrl-O opens the last written documents' diff, Esc closes the pane, and
  // PgUp/PgDn scroll it. readline passes these keys on without putting them in the line.
  let onKey: ((key: ChatKey) => Promise<void>) | undefined;
  const keypress = (_: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
    if (!screen || !key) return;
    if (key.name === 'escape' && screen.paneOpen()) void onKey?.('close');
    else if (key.ctrl && key.name === 'o') void onKey?.('diff');
    else if (key.name === 'pageup' || key.name === 'pagedown') screen.scrollPane((key.name === 'pageup' ? -1 : 1) * Math.max(1, (process.stdout.rows || 24) - 5));
  };
  if (screen) process.stdin.on('keypress', keypress);
  const prompt = {
    ...(screen ? { pane: { show: screen.pane, close: () => screen.pane(null) }, onKey: (fn: (key: ChatKey) => Promise<void>) => void (onKey = fn) } : {}),
    status: (text: string) => screen?.status(text),
    ask: (p: string) => {
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (closed) return Promise.resolve(null);
      // A prompt is for a person at a terminal; piped input gets clean output.
      if (process.stdin.isTTY) { screen?.toInput(); rl.setPrompt(p); rl.prompt(); }
      return new Promise<string | null>((r) => (waiting = r));
    },
  };
  return runChat(parsed, api, { ...base, onInterrupt: (fn) => void (stopping = fn) }, prompt).finally(() => { process.off('SIGINT', interrupt); process.stdin.off('keypress', keypress); rl.close(); if (screen) { process.stdout.off('resize', screen.layout); screen.close(); } });
}

async function command(parsed: Parsed, io: Io): Promise<number> {
  if (parsed.name === 'threads checked') {
    const line = existsSync(parsed.home) ? await attachApi(parsed.home) : null;
    if (!line) { io.err('REFUSED (NOT_AVAILABLE): open the desktop app to check this outcome.'); return EXIT.REFUSED; }
    try {
      const result = await line.call('threads.get', { id: parsed.target! });
      if (!result.ok) { io.err(result.detail); return EXIT.REFUSED; }
      const turn = result.value.turns.find(t => t.id === parsed.options.turnId);
      const q = turn?.unknownCheck ?? (turn?.unknownCheckedCurrent === false ? undefined : turn?.unknownChecked);
      if (!q) { io.err('REFUSED (NOT_AVAILABLE): this turn has a verification path or cannot be checked.'); return EXIT.REFUSED; }
      io.err('Waiting for your confirmation in the app.');
      const receipt = await line.checkedTurn({ threadId: parsed.target!, turnId: turn!.id, revision: q.revision });
      if (!receipt.ok) { io.err(receipt.detail); return EXIT.REFUSED; }
      io.out(parsed.json ? JSON.stringify(receipt.value) : `unknown, checked by ${receipt.value.byName ?? receipt.value.by} on ${receipt.value.at}. Nothing was repeated.\nChecker ID: ${receipt.value.by}`);
      return EXIT.OK;
    } finally { line.close(); }
  }
  if (parsed.name === 'connectors resolve') {
    const line = existsSync(parsed.home) ? await attachApi(parsed.home) : null;
    if (!line) { io.err('REFUSED (NOT_AVAILABLE): open the app to inspect this unknown call. Permissions remain paused.'); return EXIT.REFUSED; }
    try {
      const receipt = await line.resolveConnectorEffect({ effect: parsed.target!, argsHash: parsed.options.argsHash!, answer: parsed.options.connectorAnswer! });
      if (!receipt.ok) { io.err(`REFUSED (${receipt.reason}): ${receipt.detail}`); return EXIT.REFUSED; }
      io.out(parsed.json ? JSON.stringify(receipt.value) : `Inspection receipt ${receipt.value.id}: ${receipt.value.answer}; ${receipt.value.state}. The original call is never resent.`);
      return receipt.value.state === 'recorded' ? EXIT.OK : EXIT.UNKNOWN;
    } finally { line.close(); }
  }
  const run = (api: Api, given: Io) => (parsed.name === 'chat' ? chat(parsed, api, given) : runCommand(parsed, api, given));
  // A running app answers for its home: nothing here opens it, whatever the keys, and nothing retries.
  const line = existsSync(parsed.home) ? await attachApi(parsed.home) : null;
  if (line) {
    // The line carries no export: the database is read as its installer, which only the app's own process does.
    if (parsed.name === 'export') { line.close(); io.err('REFUSED (NOT_AVAILABLE): the app holds this data folder. Export it from Settings › Backup, or close the app and run this again.'); return EXIT.REFUSED; }
    try {
      // These sends cannot carry attachments; refuse before the shared helper uploads an original.
      if (parsed.options.attach?.length) { io.err('REFUSED (NOT_AVAILABLE): Send attachments in the app, or stop the app or background service holding this data folder and send through a standalone data folder. Nothing was attached or started.'); return EXIT.REFUSED; }
      if (ASKED.has(parsed.name) && line.send === 'ask') io.err('Waiting for you in the app: it asks whether each message, goal or schedule may go ahead.');
      return await run(line, { ...io, live: true });
    } finally {
      line.close();
    }
  }
  return withHome(parsed.home, parsed.name, (api, holding) => run(api, { ...io, holding }), {
    create: parsed.name === 'projects create',
    doors: parsed.name === 'solutions run' || parsed.name === 'send' || parsed.name === 'chat',
    readOnly: READS.has(parsed.name) || (parsed.name === 'engine' && !parsed.target),
    resume: CHANGES.has(parsed.name),
    // Stop is what ends a resumed turn, so it must not wait for one.
    recovery: parsed.name === 'stop' ? 'leave' : 'wait',
  });
}

/**
 * A stop from a second process: the send holding the home carries the turn, and only that process's
 * platform can abort it, so it is signalled as Ctrl-C would, and the stop then reads what came of it.
 */
async function stopHeldSend(parsed: Parsed, held: HomeHeld): Promise<number> {
  const holder = held.holder;
  if (!holder || !['send', 'solutions run'].includes(holder.command) || !holder.thread || (parsed.target && parsed.target !== holder.thread)) throw held;
  process.kill(holder.pid, 'SIGINT');
  for (const end = Date.now() + io.stopWaitMs + 5_000; Date.now() < end && readHolder(parsed.home)?.pid === holder.pid && alive(holder.pid); ) {
    await new Promise((r) => setTimeout(r, io.pollMs));
  }
  if (readHolder(parsed.home)?.pid === holder.pid && alive(holder.pid)) {
    io.err(`Unknown outcome: the stop was asked for, and backbone send (pid ${holder.pid}) has not ended.`);
    return EXIT.UNKNOWN;
  }
  return withHome(parsed.home, 'stop', async api => {
    const read = await api.call('threads.get', { id: holder.thread! });
    if (!read.ok) { io.err(`${read.outcome === 'UNKNOWN' ? 'Unknown outcome' : read.outcome}: ${read.detail}`); return read.outcome === 'UNKNOWN' ? EXIT.UNKNOWN : EXIT.REFUSED; }
    const turn = read.value.turns.at(-1);
    const unknown = turn?.effects.filter(e => e.outcome === 'UNKNOWN') ?? [];
    const stopped = turn?.stopRequested === true && turn.status === 'stopped';
    io.out(parsed.json ? JSON.stringify({ thread: holder.thread, stopped, status: turn?.status, unknown: unknown.map(e => e.target) }) : stopped ? `Stopped ${holder.thread}: stopped.` : `Stop requested for ${holder.thread}; final state: ${turn?.status ?? 'unavailable'}.`);
    for (const e of unknown) io.err(`Unknown outcome ${e.target}: ${e.detail ?? 'write outcome unconfirmed'}`);
    return unknown.length || !turn || turn.status === 'running' ? EXIT.UNKNOWN : EXIT.OK;
  }, { readOnly: true });
}

async function doctor(parsed: Parsed): Promise<number> {
  let selectedEngine: string | undefined;
  const checks: { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }[] = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push({ name: 'node', status: major > 22 || (major === 22 && minor >= 18) ? 'ok' : 'fail', detail: process.versions.node });
  checks.push(pnpmCheck(), postgresCheck(process.env.BACKBONE_POSTGRES_NATIVE || undefined), sharedMemoryCheck(fileURLToPath(new URL('../../../../scripts/pg-shm-sweep.mjs', import.meta.url))));
  const home = resolve(parsed.home);
  const policy = policyFor(home);
  checks.push(policyDescription(policy));
  if (policy.status === 'refused') return doctorResult(parsed, checks, io);
  // The engine this home would open with (session variable, then the home's setting), even if it cannot be opened now;
  // an opened home's own answer replaces it below.
  try { selectedEngine = selectedHarness(home); } catch { selectedEngine = undefined; }
  // Require the finished first-run metadata before Host can initialize any local stores.
  const telemetry = await inspectTelemetryStatus(home);
  checks.push({ name: 'telemetry', status: telemetry.status === 'misconfigured' ? 'warn' : 'ok', detail: telemetry.status === 'misconfigured' ? `misconfigured (${telemetry.reason})` : telemetry.status === 'on' ? `on (configuration; ${telemetry.storedHeaders} collector header(s) stored, not opened; applies on restart)` : 'off (configuration; applies on restart)' });
  const made = completeHome(home);
  if (existsSync(join(home, 'keys', 'vault.json'))) {
    checks.push(keyProviderCheck(home));
    if (!made) {
      try { refuseClosedApp(home); }
      catch (error) { if (error instanceof AppClosed) checks.push({ name: 'holder', status: 'warn', detail: error.message }); else throw error; }
    }
  }
  // Ordered from most to least protected, so the plain-text route is the last suggestion a person reads.
  const firstRun = 'Create a data folder with backbone projects create "My project" using the same --home or BACKBONE_HOME; where a system key store is usable, it protects the keys at rest; code running as you can still ask the key store. For an app-kept data folder, open the app and create a project there, then keep the app open for the CLI. For a headless data folder without a store, run BACKBONE_KEYS=plaintext backbone projects create "My project". Its keys are stored in plain text; protect the folder as you would the keys.';
  if (!existsSync(home)) checks.push({ name: 'home', status: 'fail', detail: `No data folder at ${home}. ${firstRun}` });
  else if (!made) checks.push({ name: 'home', status: 'fail', detail: `No data folder here is finished: ${unfinishedHome(home)}${keyHomeRecovery(home) ? '' : ` ${firstRun}`}` });
  else {
    checks.push({ name: 'home', status: 'ok', detail: home });
    const look = async (api: Api, holder: string) => {
      checks.push({ name: 'holder', status: 'ok', detail: holder });
      const settings = await doctorModelSettings(api);
      selectedEngine = settings.harness;
      const client = await selectedMachineClientCheck(settings);
      if (client) checks.push(client);
      checks.push({ name: 'engine', status: 'ok', detail: settings.harness });
      checks.push({ name: 'route', status: settings.active ? 'ok' : 'warn', detail: settings.active?.label ?? terminalModelHint(settings.hint ?? 'none set up') });
      checks.push({ name: 'projects', status: 'ok', detail: String((await api.call('projects.list', {})).length) });
      checks.push(await standingSignaturesCheck(api, existsSync(join(home, 'pg', 'external.json'))));
    };
    try {
      const line = await attachApi(parsed.home);
      if (line) {
        try {
          await look(line, `the process holding it (the app or the daemon), over its api line (sends: ${line.send})`);
        } finally {
          line.close();
        }
      } else {
        refuseClosedApp(parsed.home);
        // Read-only: no recovery, projection, schedule, trigger, door or listener starts for a diagnosis.
        await withHome(parsed.home, 'doctor', (api) => look(api, 'free: this process opened it read-only'), { readOnly: true });
      }
    } catch (error) {
      if (error instanceof HomeHeld || error instanceof LineSilent) checks.push({ name: 'holder', status: 'warn', detail: error.message });
      else if (error instanceof AppClosed) checks.push({ name: 'holder', status: 'warn', detail: error.message });
      else checks.push({ name: 'open', status: 'fail', detail: error instanceof KeysRefused ? cliKeyRefusal(error, home) : (error as Error).message });
    }
  }
  if (made && !checks.some(c => c.name === 'standing signatures'))
    checks.push(await standingSignaturesCheck(null, existsSync(join(home, 'pg', 'external.json'))));
  checks.push(...engineClientChecks(selectedEngine));
  return doctorResult(parsed, checks, io);
}

/**
 * Bring an export into a new, empty home, through that home's own api as the person would add it. A
 * dry run reads the export and the home and changes nothing. A home that is not new is refused and
 * left as it is: the person imports into a new one and switches homes themselves.
 */
async function restore(parsed: Parsed): Promise<number> {
  const home = resolve(parsed.home);
  const from = resolve(parsed.target as string);
  let plan: ImportPlan;
  try {
    if (parsed.options.dryRun) plan = await importHome({ from, home, dryRun: true });
    else {
      const notNew = newHome(home);
      if (notNew) throw new BackupRefused('INVALID', notNew);
      assertHomeWriteAdmission(home);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // The host imports under its home's lock, through its own methods; withHome hands over that host.
      plan = await withHome(home, 'restore', (api) => (api as unknown as Host).importExport(from), { create: true });
    }
  } catch (error) {
    if (error instanceof BackupRefused) { io.err(`REFUSED (${error.reason}): ${error.message}`); return EXIT.REFUSED; }
    throw error;
  }
  const c = plan.export.counts;
  const a = plan.adds;
  io.out(parsed.json ? JSON.stringify(plan, null, 2) : [
    `${plan.dryRun ? 'Dry run, nothing changed. ' : ''}Export ${plan.export.id} of ${plan.export.createdAt}: ${c.projects} projects, ${c.threads} chats, ${c.documents} documents, ${c.receipts} receipts (${c.unresolved} unresolved).`,
    ...plan.conflicts.map((x) => `Conflict: ${x}`),
    ...plan.skipped.map((x) => `Left out: ${x}`),
    plan.done ? `Imported into ${plan.target}: ${a.projects} projects, ${a.documents} documents (${a.versions} versions), ${a.chats} chats and the receipts as documents to read, ${a.memoryFiles} memory files, ${a.skills} skills waiting for you to accept. Nothing in it gives permission or runs by itself: set up model keys, servers and schedules again.`
      : plan.conflicts.length ? 'Nothing would be imported as asked.' : `Would import ${a.projects} projects, ${a.documents} documents (${a.versions} versions), ${a.chats} chats, ${a.memoryFiles} memory files and ${a.skills} skills into ${plan.target}.`,
  ].join('\n'));
  return plan.conflicts.length ? EXIT.REFUSED : EXIT.OK;
}

/** Who holds the home now, and what of it runs on its own. */
async function homeStatus(parsed: Parsed): Promise<number> {
  const home = resolve(parsed.home);
  const lines = [`data folder: ${home}`];
  const daemon = existsSync(daemonFile(home)) ? JSON.parse(readFileSync(daemonFile(home), 'utf8')) as { pid: number; since: string } : null;
  const holder = readHolder(home);
  const line = existsSync(home) ? await attachApi(home).catch(() => null) : null;
  if (daemon && alive(daemon.pid)) lines.push(`held by: daemon (pid ${daemon.pid}), since ${daemon.since}`);
  else if (holder && alive(holder.pid)) lines.push(`held by: backbone ${holder.command} (pid ${holder.pid})`);
  else if (line) lines.push('held by: the app');
  else lines.push('held by: nothing; it is free');
  if (process.platform === 'darwin') {
    const agentNow = agentStatus(home, launchd());
    lines.push(`launchd agent: ${agentNow.installed ? (agentNow.running ? `installed, running (pid ${agentNow.pid ?? '?'})` : 'installed, not running') : 'not installed'}`);
  }
  if (line) {
    try {
      // The line answers a method it does not carry with a refusal, not the projection: shown only when given.
      const runs: unknown = await line.call('goals.runs', {}).catch(() => null);
      if (Array.isArray(runs)) lines.push(`goals running: ${runs.filter((r: { status: string }) => r.status === 'running').length}`);
      const given: unknown = await line.call('schedules.get', {}).catch(() => null);
      const schedules = given && typeof given === 'object' && 'schedules' in given ? given as Awaited<ReturnType<typeof line.call<'schedules.get'>>> : null;
      if (schedules) {
        const next = schedules.schedules.filter((s) => !s.paused && s.nextAt).sort((a, b) => a.nextAt!.localeCompare(b.nextAt!))[0];
        lines.push(`schedules: ${schedules.schedules.length}${next ? `, next ${next.nextAt}` : ''}; heartbeat: ${schedules.heartbeat ? schedules.heartbeat.summary : 'off'}`);
      }
    } finally {
      line.close();
    }
  }
  io.out(parsed.json ? JSON.stringify({ home, daemon, holder, line: !!line }, null, 2) : lines.join('\n'));
  return EXIT.OK;
}

/** The daemon as this user's launchd agent: macOS only, and only this user's LaunchAgents folder. */
async function agent(parsed: Parsed): Promise<number> {
  if(parsed.name==='daemon status'&&process.platform!=='darwin'){
    const state=await sharedDaemonState(parsed.home);
    io.out(parsed.json?JSON.stringify(state?{...state,running:true}:{running:false}):state?`running (pid ${state.pid})${state.shared?`\nShared workspace: ${state.shared.origin}\nCertificate SHA-256: ${state.shared.fingerprint}`:'\nSharing is off.'}`:'not running');return EXIT.OK;
  }
  if (process.platform !== 'darwin') { io.err('REFUSED (NOT_AVAILABLE): launchd agents are macOS only. On Linux, run `backbone daemon run` under your service manager, or use the Docker compose file.'); return EXIT.REFUSED; }
  const at = launchd();
  // The agent is the real home's, whatever spelling or link named it.
  const home = canonicalHome(parsed.home);
  if (parsed.name === 'daemon install') {
    const made = install(home, at);
    io.out(`Installed ${made.label}: ${made.plist}\nIt runs \`backbone daemon run\` for ${home} at login, and again if it fails. Remove it with: backbone daemon uninstall --home ${JSON.stringify(home)}`);
    return EXIT.OK;
  }
  if (parsed.name === 'daemon uninstall') {
    const gone = uninstall(home, at);
    io.out(`${gone.removed ? `Removed ${gone.label}; launchd no longer has it.` : `No agent was installed for ${home}.`} The data folder and its logs (${join(home, 'logs')}) stay where they are.`);
    return EXIT.OK;
  }
  const now = agentStatus(home, at);
  const state = await sharedDaemonState(home);
  const shared = state?.shared;
  const sharedText = shared ? `\nShared workspace: ${shared.origin}\nCertificate SHA-256: ${shared.fingerprint}` : '';
  const lastRefusal = now.lastRefusal ? `\nlast key refusal: ${now.lastRefusal.kind} at ${now.lastRefusal.at}` : '';
  io.out(parsed.json ? JSON.stringify({...now,...(shared?{shared}:{})}) : (now.installed ? `installed; ${now.running ? `running (pid ${now.pid ?? '?'})` : 'not running'}` : 'not installed') + lastRefusal + sharedText);
  return EXIT.OK;
}

async function main(): Promise<number> {
  if (process.argv.length === 3 && process.argv[2] === '--version') {
    io.out(versionLine());
    return EXIT.OK;
  }
  const parsed = parse(process.argv.slice(2));
  if (parsed.help) {
    io.out(USAGE);
    return EXIT.OK;
  }
  if (parsed.usage) {
    io.err(`backbone: ${parsed.usage}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  if (parsed.name === 'notices') {
    const { noticesCommand } = await import('./notices.ts');
    const code = noticesCommand(parsed.json, io);
    // The complete inventory can exceed a pipe's buffer. Drain before main exits.
    await new Promise<void>((resolve, reject) => process.stdout.write('', error => error ? reject(error) : resolve()));
    return code;
  }
  if (parsed.name === 'doctor') return doctor(parsed);
  if (parsed.name === 'status') return homeStatus(parsed);
  if (parsed.name === 'daemon run') {
    try {
      await runDaemon(parsed.home, io.out, parsed.options.share);
      return EXIT.OK;
    } catch (error) {
      // SuccessfulExit=false restarts failures: key refusals must be a clean stop, never a loop.
      if (error instanceof KeysRefused) {
        io.err(keyRefusalLine(error, parsed.home));
        return EXIT.OK;
      }
      if (error instanceof DaemonBusy) { io.err(error.message); return EXIT.BUSY; }
      if (error instanceof AppClosed) { io.err(`REFUSED (NOT_AVAILABLE): ${error.message} The daemon holds only a data folder whose keys it can keep headless.`); return EXIT.REFUSED; }
      throw error;
    }
  }
  if (parsed.name.startsWith('daemon ')) return agent(parsed);
  return parsed.name === 'exec' ? runExec(parsed, io, execute) : execute(parsed, io);
}

async function execute(parsed: Parsed, io: Io): Promise<number> {
  try {
    if(parsed.name==='join'||parsed.name.startsWith('remote '))return await remoteCommand(parsed,io);
    if(parsed.name.startsWith('team '))return await teamCommand(parsed,io);
    if (parsed.name.startsWith('policy ')) { const { policyCommand } = await import('./policy.ts'); return policyCommand(parsed, io); }
    if (parsed.name.startsWith('telemetry ')) { const {telemetryCommand}=await import('./telemetry.ts'); return await telemetryCommand(parsed,io,process.stdin); }
    if (parsed.name.startsWith('channels ')) { const {channelsCommand}=await import('./channels.ts'); return await channelsCommand(parsed,io,process.stdin); }
    if (parsed.name.startsWith('audit ')) { const { auditCommand } = await import('./audit.ts'); return await auditCommand(parsed, io); }
    if (parsed.name === 'restore') return await restore(parsed);
    try {
      return await command(parsed, io);
    } catch (error) {
      if (parsed.name === 'stop' && error instanceof HomeHeld) return await stopHeldSend(parsed, error);
      throw error;
    }
  } catch (error) {
    if (error instanceof HomeHeld) {
      io.err(error.message);
      return EXIT.BUSY;
    }
    if (error instanceof LineSilent) {
      io.err(`BUSY: ${error.message}`);
      return EXIT.BUSY;
    }
    if (error instanceof AppClosed) {
      io.err(`REFUSED (NOT_AVAILABLE): ${error.message}`);
      return EXIT.REFUSED;
    }
    if (error instanceof HomeAbsent) {
      io.err(`REFUSED (NOT_FOUND): ${error.message}`);
      return EXIT.REFUSED;
    }
    if (error instanceof KeysRefused) {
      io.err(`REFUSED (NOT_AVAILABLE): ${cliKeyRefusal(error, parsed.home)}`);
      return EXIT.REFUSED;
    }
    throw error;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`backbone: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT.REFUSED);
  },
);
