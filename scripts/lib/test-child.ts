// Test harness only: observe a child from spawn, before it can print its startup line.
import type { ChildProcess } from 'node:child_process';
import { TEST_HANG_MS } from './test-hang.ts';

// Three minutes is a hang detector for a stalled child under a parallel suite, not a startup
// timing assertion. Readiness is the child's own output (or its exit), never elapsed time.
export const CHILD_START_HANG_MS = TEST_HANG_MS;
export const MCP_HOST_READY = /^Serving the doors of .+; stop with Ctrl-C\.\r?$/m;
export const DAEMON_READY = /^daemon: serving .+ \(pid \d+\).*\r?$/m;

const observations = new WeakMap<ChildProcess, ReturnType<typeof createObservation>>();
export function observeChild(child: ChildProcess, label: string) {
  let output = observations.get(child);
  if (!output) { output = createObservation(child, label); observations.set(child, output); }
  return output;
}
function createObservation(child: ChildProcess, label: string) {
  let stdout = '', stderr = '', failure: Error | undefined;
  let exited = child.exitCode !== null || child.signalCode !== null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  child.stdout?.on('data', chunk => { stdout += String(chunk); notify(); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); notify(); });
  // close follows exit and drains both pipes, so an early exit's last diagnostic is retained.
  child.once('close', () => { exited = true; notify(); });
  child.once('error', error => { failure = error; notify(); });
  const diagnostic = (reason: string) => new Error(`${label} ${reason}\nexit code: ${child.exitCode}\nsignal: ${child.signalCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get exitCode() { return child.exitCode; },
    diagnostic,
    waitForOutput(pattern: RegExp, { allowExit = false, hangMs = CHILD_START_HANG_MS } = {}): Promise<'ready' | 'exit'> {
      return new Promise((resolve, reject) => {
        const finish = (result: 'ready' | 'exit' | Error) => {
          clearTimeout(timer); listeners.delete(check);
          if (result instanceof Error) reject(result); else resolve(result);
        };
        const check = () => {
          if (failure) return finish(diagnostic(`could not start: ${failure.message}`));
          if (exited) return finish(allowExit ? 'exit' : diagnostic('exited before readiness'));
          // A fresh RegExp avoids stateful lastIndex on a caller's global/sticky expression.
          if (new RegExp(pattern).test(stdout)) finish('ready');
        };
        const timer = setTimeout(() => finish(diagnostic(`hit the ${hangMs} ms hang detector before readiness`)), hangMs);
        listeners.add(check);
        check();
      });
    },
  };
}

/** Last-resort fixture cleanup, not a child lifetime assertion. Observe before any output. */
export function childHangTimer(child: ChildProcess, label: string, onHang: () => void = () => { process.exitCode = 1; }) {
  const output = observeChild(child, label);
  return setTimeout(() => {
    console.error(output.diagnostic(`still pending at the ${TEST_HANG_MS} ms hang detector`).message);
    onHang();
    child.kill('SIGKILL');
  }, TEST_HANG_MS);
}
