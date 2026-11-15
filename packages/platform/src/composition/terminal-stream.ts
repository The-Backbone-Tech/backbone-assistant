// A line is one recorded effect. No renderer-owned process or automatic replay.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Receipt, TerminalBlock, TerminalView, TerminalResult } from '../api.ts';
import { writeJson } from '../stub/fsx.ts';
import { assertHomeWriteAdmission, outsideHomeLocks, withHomeLock } from './home-lock.ts';
import { terminalOutput } from './terminal-output.ts';
import { captureTerminalProcess, inspectTerminalProcess, type TerminalProcess } from './terminal-process.ts';

const COMMANDS = 50, KEYS = 1_000, WAIT = 1_000;
const UNCONFIRMED = 'The command outcome could not be confirmed. This command will not run again automatically.';
const CORRUPT = 'The terminal record for this project cannot be read; nothing was run. Clear terminal history to continue.';
const STOP_UNCONFIRMED = 'Stop could not confirm the process right now; press Stop again to try again.';
const RECOVERED = 'Still running from before the app stopped. Further output is unavailable; Stop is available.';
const SAVE_ERROR = 'The command record could not be saved. The outcome shown is what the app observed; it may be unavailable after a restart.';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const refused = <T>(detail: string): Receipt<T> => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'REFUSED', detail });
const ok = <T>(value: T): Receipt<T> => ({ ok: true, value: structuredClone(value) });
type Saved = TerminalView & { projectId: string; historyKey: string; strictKeys?: boolean; keys: Record<string, string>; processes: Record<string, TerminalProcess> };
type Running = { buffer?: ReturnType<typeof terminalOutput>; block: TerminalBlock; child?: ChildProcess; state: Saved; projectId: string; closed: boolean; stopReason?: 'person' | 'timeout' | 'app'; code: number | null; signal: string | null; timers: NodeJS.Timeout[] };
interface Deps { home: string; directory(id: string): string; exists(id: string): boolean; changed(id: string): void; writable?(): boolean; startHold?(projectId: string): string | undefined }

export function createTerminal(deps: Deps) {
  const dirtyProjects = new Set<string>();
  const states = new Map<string, Saved>(), running = new Map<string, Running>();
  let closingWork: Promise<void> | undefined;
  let closed = false, writing: Promise<void> | undefined, saveTimer: NodeJS.Timeout | undefined;
  const root = join(deps.home, 'terminal');
  const path = (id: string) => join(root, hash(id) + '.json');
  const empty = (id: string): Saved => ({ projectId: id, cwd: deps.directory(id), commands: [], omittedCommands: 0, keys: {}, processes: {}, historyKey: randomUUID() });
  function save(id: string, state: Saved) {
    assertHomeWriteAdmission(deps.home, root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertHomeWriteAdmission(deps.home, root);
    writeJson(path(id), state);
  }
  function load(id: string): Saved {
    const known = states.get(id);
    if (known) return known;
    let state: Saved;
    try {
      if (existsSync(path(id)) && statSync(path(id)).size > 12_000_000) throw new Error('Oversized record');
      state = existsSync(path(id)) ? JSON.parse(readFileSync(path(id), 'utf8')) as Saved : empty(id);
      if (!Array.isArray(state.commands) || state.commands.length > COMMANDS || !state.keys || typeof state.keys !== 'object' || !Number.isSafeInteger(state.omittedCommands)) throw new Error('Invalid record');
      const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
      if (state.commands.filter(b => b?.status === 'running').length > 1) throw new Error('Invalid running slot');
      for (const b of state.commands) {
        if (!b || typeof b.id !== 'string' || typeof b.clientKey !== 'string' || b.clientKey.length > 200
          || typeof b.command !== 'string' || Buffer.byteLength(b.command) > 8192
          || typeof b.output !== 'string' || Buffer.byteLength(b.output) > 65_536
          || typeof b.cwd !== 'string' || typeof b.startedAt !== 'string' || !Number.isFinite(Date.parse(b.startedAt))
          || !Array.isArray(b.signals) || !b.signals.every(s => ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(s))
          || !count(b.omittedBytes) || !count(b.omittedLines)
          || !['running', 'succeeded', 'failed', 'not-known'].includes(b.status)) throw new Error('Invalid block');
      }
      state.projectId = id; state.historyKey ??= randomUUID(); state.processes ??= {};
    } catch { throw new Error(CORRUPT); }
    states.set(id, state);
    const owned = running.get(id);
    if (owned) {
      // A read-back after an uncertain Clear must keep the live child, output buffer and Stop timers.
      state.commands = [...state.commands.filter(b => b.id !== owned.block.id), owned.block];
      if (state.commands.length > COMMANDS) { state.commands.shift(); state.omittedCommands++; }
      state.keys[hash(owned.block.clientKey)] = owned.block.id;
      const identity = owned.state.processes[owned.block.id];
      if (identity) state.processes[owned.block.id] = identity;
      owned.state = state;
    }
    for (const block of state.commands) if (block.status === 'running') {
      if (owned?.block === block) continue;
      const checked = inspectTerminalProcess(state.processes[block.id]);
      if (checked === 'same' || checked === 'unconfirmed') {
        block.stopping = false; block.detail = RECOVERED;
        running.set(id, { block, state, projectId: id, closed: false, code: null, signal: null, timers: [] });
      } else { block.status = 'not-known'; block.stopping = false; block.detail = 'The command outcome could not be confirmed after the app stopped. This command will not run again automatically.'; }
    }
    return state;
  }
  function changed(id: string, immediate = false) {
    dirtyProjects.add(id);
    if (immediate) { clearTimeout(saveTimer); saveTimer = undefined; }
    if (!closed && !saveTimer) saveTimer = setTimeout(() => { saveTimer = undefined; void flush().catch(() => {}); }, immediate ? 0 : WAIT);
  }
  async function flush(): Promise<void> {
    if (writing) { await writing; if (dirtyProjects.size) return flush(); return; }
    writing = withHomeLock(deps.home, async () => {
      const ids = [...dirtyProjects]; dirtyProjects.clear();
      let failure: unknown;
      for (const id of ids) {
        const state = states.get(id)!;
        running.get(id)?.buffer?.publish();
        try {
          for (const block of state.commands) delete block.saveError;
          save(id, state);
        } catch (error) {
          const block = state.commands.at(-1); if (block) block.saveError = SAVE_ERROR;
          deps.changed(id); failure = error;
        }
      }
      if (failure) throw failure;
    });
    try { await writing; } finally { writing = undefined; }
    if (dirtyProjects.size) return flush();
  }
  function finish(run: Running, unknown = false) {
    if (running.get(run.projectId) !== run) return;
    unknown ||= !run.stopReason && (!run.closed || run.code === null && run.signal === null);
    run.timers.forEach(clearTimeout);
    running.delete(run.projectId);
    delete run.state.processes[run.block.id];
    run.block.status = unknown ? 'not-known' : run.block.stopping || run.code !== 0 || run.signal ? 'failed' : 'succeeded';
    run.block.code = run.code;
    run.block.detail = unknown ? UNCONFIRMED : run.block.stopping ? run.stopReason === 'app' ? 'Stopped: the app closed' : run.stopReason === 'timeout' ? 'Time limit reached' : 'Stopped by you' : run.signal ? `Ended by ${run.signal}` : undefined;
    run.block.stopping = false;
    deps.changed(run.projectId); changed(run.projectId, true);
  }
  function inspect(run: Running) { return inspectTerminalProcess(run.state.processes[run.block.id]); }
  function keepRunning(run: Running, detail = STOP_UNCONFIRMED) {
    run.timers.forEach(clearTimeout); run.timers = [];
    run.block.stopping = false; run.stopReason = undefined; run.block.detail = detail;
    deps.changed(run.projectId); changed(run.projectId, true);
  }
  function stopGroup(run: Running, reason: 'person' | 'timeout' | 'app') {
    run.stopReason = reason; run.block.stopping = true; delete run.block.detail;
    const later = (fn: () => void, ms: number) => run.timers.push(setTimeout(fn, ms));
    function step(index: number, attempts = 0) {
      if (running.get(run.projectId) !== run || closed) return;
      const state = inspect(run);
      if (state === 'unconfirmed') {
        if (run.closed) { finish(run); return; }
        if (attempts < 3) later(() => step(index, attempts + 1), 150);
        else keepRunning(run);
        return;
      }
      if (state === 'different') { finish(run, true); return; }
      if (state === 'gone') {
        if (!run.block.signals.length) { run.block.stopping = false; run.stopReason = undefined; }
        if (run.closed || !run.child) finish(run);
        else later(() => finish(run), WAIT); // Allow Node to deliver the observed receipt and close.
        return;
      }
      if (index === 3) { keepRunning(run); return; }
      const name = (['SIGINT', 'SIGTERM', 'SIGKILL'] as const)[index];
      try { process.kill(-run.state.processes[run.block.id].group, name); run.block.signals.push(name); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { keepRunning(run); return; }
        if (!run.block.signals.length) { run.block.stopping = false; run.stopReason = undefined; }
        if (run.closed) finish(run); else later(() => finish(run), WAIT);
        return;
      }
      changed(run.projectId); later(() => step(index + 1), WAIT);
    }
    step(0);
  }
  function refreshRecovered(id: string) {
    const run = running.get(id);
    if (run && !run.child && !run.block.stopping) {
      const checked = inspect(run);
      if (checked === 'gone' || checked === 'different') finish(run, true);
    }
  }
  return {
    hasRunning(projectId: string): boolean | string {
      // A damaged record cannot establish that a rewind is safe.
      try { load(projectId); refreshRecovered(projectId); return running.has(projectId); } catch { return 'The terminal record for this project cannot be read; use Clear terminal history in the Terminal tab before rewinding.'; }
    },
    async list(projectId: string): Promise<Receipt<TerminalView>> {
      if (closed || closingWork || !deps.exists(projectId)) return refused('No such available project.');
      try {
        const state = load(projectId); refreshRecovered(projectId);
        running.get(projectId)?.buffer?.publish();
        return ok({ cwd: running.get(projectId)?.block.cwd ?? deps.directory(projectId), commands: state.commands, omittedCommands: state.omittedCommands, historyKey: state.historyKey });
      } catch { return refused(CORRUPT); }
    },
    async clear(projectId: string): Promise<Receipt<TerminalView>> {
      return withHomeLock(deps.home, async () => {
        if (closed || closingWork || !deps.exists(projectId)) return refused('No such available project.');
        let state: Saved;
        try { state = load(projectId); }
        catch {
          // The confirmed clear atomically replaces unreadable history, never inferring process authority.
          state = empty(projectId);
        }
        const next: Saved = { ...state, commands: state.commands.filter(b => b.status === 'running'), omittedCommands: 0, keys: {}, historyKey: randomUUID(), strictKeys: true };
        for (const b of next.commands) next.keys[hash(b.clientKey)] = b.id;
        try { save(projectId, next); } catch {
          // Replacement may have happened before an fsync error. Inspect bytes without replaying the write.
          states.delete(projectId);
          try { load(projectId); } catch { states.set(projectId, state); }
          return { ok: false, reason: 'NOT_AVAILABLE', outcome: 'UNKNOWN', detail: 'Clear could not be confirmed. Check terminal history before trying to clear it again.' };
        }
        states.set(projectId, next);
        const run = running.get(projectId); if (run) run.state = next;
        deps.changed(projectId);
        return ok({ cwd: next.cwd, commands: next.commands, omittedCommands: 0, historyKey: next.historyKey });
      });
    },
    async start(args: { projectId: string; command: string; clientKey: string }): Promise<Receipt<TerminalBlock>> {
      return withHomeLock(deps.home, async () => {
        if (closed || closingWork || !deps.exists(args.projectId)) return refused('No such available project.');
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0') || Buffer.byteLength(args.command) > 8192 || typeof args.clientKey !== 'string' || !args.clientKey || args.clientKey.length > 200) return refused('Enter a command of at most 8,192 bytes, without null characters.');
        let state: Saved;
        try { state = load(args.projectId); } catch { return refused(CORRUPT); }
        const key = hash(args.clientKey), existing = state.keys[key];
        if (existing) {
          const block = state.commands.find(b => b.id === existing);
          return block && block.command === args.command ? ok(block) : refused('This command identity was already used. It will not run again.');
        }
        // Compaction rotates the namespace: forgotten requests can never become fresh effects.
        if (state.strictKeys && !args.clientKey.startsWith(state.historyKey + ':')) return refused('This command identity has expired. Check terminal history before entering a new command.');
        const hold = deps.startHold?.(args.projectId);
        if (hold) return refused(hold);
        refreshRecovered(args.projectId);
        if (running.has(args.projectId)) return refused('A command is already running in this project. Stop it or wait for it to finish.');
        const block: TerminalBlock = { id: randomUUID(), clientKey: args.clientKey, command: args.command, cwd: deps.directory(args.projectId), output: '', code: null, status: 'running', startedAt: new Date().toISOString(), signals: [], omittedBytes: 0, omittedLines: 0 };
        state.cwd = block.cwd; state.commands.push(block); state.keys[key] = block.id;
        if (state.commands.length > COMMANDS) { state.commands.shift(); state.omittedCommands++; }
        if (Object.keys(state.keys).length > KEYS) {
          state.keys = Object.fromEntries(Object.entries(state.keys).slice(-KEYS)); state.historyKey = randomUUID(); state.strictKeys = true;
        }
        try { save(args.projectId, state); } // Record intent before dispatch; a crash here is not known, never a replay.
        catch { block.status = 'failed'; block.detail = 'Not started: the command record could not be saved.'; return refused(block.detail); }
        let launcher: ChildProcess | undefined;
        outsideHomeLocks(() => {
          try {
            const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)));
            // The relay keeps the group leader alive while any command descendant holds output open.
            // Exit status uses a private pipe closed in the person's shell, separate from untrusted output.
            const supervisor = 'read -r terminal_start || exit 125\nexec </dev/null\nexec 3>&2\n{ /bin/sh -c "$1" 3>&- 2>&1; printf "terminal-exit:%s\\n" "$?" >&3; } | /bin/cat\nexit 0';
            const child = spawn('/bin/sh', ['-c', supervisor, 'terminal', 'exec 2>&1\n' + args.command], { cwd: block.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
            launcher = child;
            child.stdin!.on('error', () => {}); // A missing folder can close the launcher before admission answers.
            const run: Running = { block, state, child, projectId: args.projectId, closed: false, code: null, signal: null, timers: [] };
            running.set(args.projectId, run);
            const identity = child.pid && captureTerminalProcess(child.pid);
            if (identity) state.processes[block.id] = identity;
            else if (child.pid) {
              // The waiting shell has received no command input. EOF ends it without executing the line.
              block.status = 'failed'; block.detail = 'Not started: the command process identity could not be confirmed.';
              running.delete(args.projectId); child.stdin!.end(); launcher = undefined;
            }
            const buffer = terminalOutput(block); run.buffer = buffer;
            child.stdout!.on('data', (data: Buffer) => { if (!closed) { buffer.append(data, 0); changed(args.projectId); } });
            let exitReceipt = '';
            child.stderr!.on('data', (data: Buffer) => { if (exitReceipt.length < 64) exitReceipt += data.toString('utf8').slice(0, 64 - exitReceipt.length); });
            child.once('error', () => { if (!closed) finish(run, true); });
            child.once('close', (code, sig) => {
              const recorded = exitReceipt.match(/^terminal-exit:(\d{1,3})\n$/);
              run.closed = true; run.code = recorded && Number(recorded[1]) <= 255 ? Number(recorded[1]) : code === 0 ? null : code; run.signal = sig;
              if (!closed) {
                buffer.end();
                if (block.stopping && !block.signals.length) { block.stopping = false; run.stopReason = undefined; }
                if (!block.stopping) finish(run);
              }
            });
          } catch {
            block.status = 'failed'; block.detail = 'Not started: the command process could not be created.';
          }
        });
        // Persist custody before answering, still under the same admitted data-folder lock.
        try {
          save(args.projectId, state);
          // The shell closes stdin before the person's program, which remains noninteractive.
          launcher?.stdin?.end('start\n');
        } catch {
          block.status = 'failed'; block.detail = 'Not started: the process identity could not be saved.';
          launcher?.stdin?.end();
          const run = running.get(args.projectId);
          if (run) { run.block.stopping = false; running.delete(args.projectId); delete state.processes[block.id]; }
          block.saveError = SAVE_ERROR;
          changed(args.projectId, true);
        }
        deps.changed(args.projectId); return ok(block);
      });
    },
    async stop(projectId: string, id: string, reason: 'person' | 'timeout' = 'person'): Promise<Receipt<TerminalBlock>> {
      if (closed || closingWork || !deps.exists(projectId)) return refused('No such available project.');
      try { load(projectId); } catch { return refused(CORRUPT); }
      const run = running.get(projectId);
      if (!run || run.block.id !== id) return refused('This project has no such running command.');
      if (!run.block.stopping) await withHomeLock(deps.home, async () => {
        if (running.get(projectId) !== run || run.block.stopping) return;
        try { save(projectId, run.state); } catch { run.block.saveError = SAVE_ERROR; }
        outsideHomeLocks(() => stopGroup(run, reason));
      });
      return ok(run.block);
    },
    async close() {
      if (closingWork) return closingWork;
      closingWork = (async () => {
        if (deps.writable?.() === false) { closed = true; return; }
        // Discover commands from a previous crash even if their Terminal tab was never opened.
        if (existsSync(root)) for (const file of readdirSync(root).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
          try {
            if (statSync(join(root, file)).size > 12_000_000) continue;
            const id = JSON.parse(readFileSync(join(root, file), 'utf8')).projectId; if (typeof id === 'string' && deps.exists(id) && file === hash(id) + '.json') load(id); } catch { /* An unreadable identity never grants signalling authority. */ }
        }
        for (const run of running.values()) if (!run.block.stopping) await withHomeLock(deps.home, async () => {
          if (running.get(run.projectId) !== run || run.block.stopping) return;
          try { save(run.projectId, run.state); } catch { run.block.saveError = SAVE_ERROR; }
          outsideHomeLocks(() => stopGroup(run, 'app'));
        });
        const deadline = Date.now() + WAIT * 5;
        while (running.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        for (const run of running.values()) keepRunning(run, RECOVERED);
        closed = true; clearTimeout(saveTimer);
        for (const [id, state] of states) if (state.commands.some(b => b.saveError)) dirtyProjects.add(id);
        if (dirtyProjects.size) await flush();
      })();
      return closingWork;
    },
  };
}

/** Compatibility for one-shot callers, sharing admission, output caps and the project slot. */
export async function runTerminal(terminal: Pick<ReturnType<typeof createTerminal>, 'start' | 'list' | 'stop'>, args: { projectId: string; command: string }, timeoutMs = 30_000): Promise<Receipt<TerminalResult>> {
  const initial = await terminal.list(args.projectId);
  if (!initial.ok) return initial;
  const started = await terminal.start({ ...args, clientKey: `${initial.value.historyKey}:${randomUUID()}` });
  if (!started.ok) return started;
  const deadline = Date.now() + timeoutMs;
  const unknown = (): Receipt<TerminalResult> => ({ ok: false, reason: 'NOT_AVAILABLE', outcome: 'UNKNOWN', detail: 'The command outcome is not known. It will not run again automatically.' });
  while (true) {
    const view = await terminal.list(args.projectId);
    if (!view.ok) return unknown();
    const block = view.value.commands.find(b => b.id === started.value.id);
    if (!block || block.status === 'not-known') return unknown();
    if (block.status !== 'running') {
      const omitted = block.omittedBytes || block.omittedLines ? `\n[${block.omittedBytes} output bytes and ${block.omittedLines} line breaks left out of the middle; showing the beginning and end.]\n` : '';
      return { ok: true, value: { command: block.command, output: block.output + omitted, code: block.signals.length ? null : block.code } };
    }
    if (Date.now() >= deadline && !block.stopping) await terminal.stop(args.projectId, block.id, 'timeout');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
