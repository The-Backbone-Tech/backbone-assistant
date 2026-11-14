import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { TurnSettings, WakeGate } from '../api.ts';
import { assertHomeWriteAdmission } from '../composition/home-lock.ts';
import { governedPolicy } from '../policy/index.ts';

/** Validate the program at creation and execution. Home file permissions remain the boundary:
 * a same-user process able to edit the stored configuration already has these OS rights. */
export function gateProblem(home: string, gate: WakeGate, settings: TurnSettings): string | null {
  if (settings.permission !== 'full' || settings.runsOn !== 'this-computer' || settings.mode !== 'chat') return 'A script wake gate needs Full permission in a local chat.';
  if (!gate || typeof gate.command !== 'string' || !isAbsolute(gate.command) || gate.command.includes('\0') ||
      !Array.isArray(gate.args) || gate.args.some((a) => typeof a !== 'string' || a.includes('\0')) ||
      gate.command.length + gate.args.join('').length > 16_384 ||
      (gate.timeoutMs !== undefined && (!Number.isInteger(gate.timeoutMs) || gate.timeoutMs < 100 || gate.timeoutMs > 30_000))) return 'Use an absolute command, explicit arguments and a timeout from 100 to 30,000 ms.';
  // The script has the person's OS rights; a managed prohibition applies before starting it.
  try { if (governedPolicy(home)?.requirements.personRights === false) return 'Managed policy forbids scripts with the person\'s OS rights.'; }
  catch { return 'Managed policy could not admit the script wake gate.'; }
  return null;
}

/** Child handles are deliberately small so the never-exiting OS-process case can be tested. */
interface GateChild {
  pid?: number;
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown;
  unref(): unknown;
}
interface GateRuntime {
  concurrency?: number;
  spawn?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => GateChild;
  kill?: (pid: number) => void;
}

/** Deadlines include time waiting for a process slot. Orphans retain their slot until reaped,
 * bounding tracked child processes even if the OS cannot finish a kill. Reaping is best effort: this is
 * trusted person-rights execution, not containment of descendants that create a new session.
 */
export function createWakeGateRunner(runtime: GateRuntime = {}) {
  const limit = runtime.concurrency ?? 4;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('A gate runner needs a positive concurrency bound.');
  let active = 0;
  const queue: (() => void)[] = [];
  const spawnChild = runtime.spawn ?? ((command, args, options) => spawn(command, args, options));
  const kill = runtime.kill ?? ((pid: number) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already gone, or the OS refused. */ } });
  const pump = () => { while (active < limit && queue.length) queue.shift()!(); };
  function check(home: string, gate: WakeGate, signal: AbortSignal): Promise<'quiet' | 'wake' | 'failed'> {
    if (signal.aborted) return Promise.resolve('failed');
    return new Promise((resolve) => {
      let settled = false, exited = false, child: GateChild | undefined;
      let reaper: NodeJS.Timeout | undefined;
      const stop = () => { if (!exited && child?.pid) { try { kill(child.pid); } catch { /* The deadline is independent of kill success. */ } } };
      const detach = () => {
        if (!child || exited) return;
        child.unref();
        reaper ??= setInterval(stop, 1_000);
        reaper.unref();
      };
      const finish = (outcome: 'quiet' | 'wake' | 'failed') => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline); signal.removeEventListener('abort', abort);
        const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1);
        resolve(outcome);
      };
      const abort = () => { stop(); detach(); finish('failed'); };
      const start = () => {
        if (settled) return;
        active++;
        const ended = (code: number | null) => {
          if (exited) return;
          exited = true; clearInterval(reaper); active--;
          // The OS has reported termination: do not subsequently signal a possibly reused PID.
          finish(code === 0 ? 'quiet' : code === 10 ? 'wake' : 'failed');
          pump();
        };
        try {
          assertHomeWriteAdmission(home);
          child = spawnChild(gate.command, gate.args, { cwd: home, env: { PATH: '/usr/bin:/bin' }, shell: false, stdio: 'ignore', detached: true });
          child.once('error', () => ended(null)); child.once('exit', ended);
        } catch { ended(null); }
      };
      const deadline = setTimeout(abort, gate.timeoutMs ?? 5_000);
      signal.addEventListener('abort', abort, { once: true });
      queue.push(start); pump();
      if (signal.aborted) abort();
    });
  }
  return { check };
}

const defaultRunner = createWakeGateRunner();
export function checkWakeGate(home: string, gate: WakeGate, signal: AbortSignal): Promise<'quiet' | 'wake' | 'failed'> {
  return defaultRunner.check(home, gate, signal);
}
