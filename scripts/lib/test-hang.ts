import { spawnSync, execFileSync, type SpawnSyncOptions, type ExecFileSyncOptions } from 'node:child_process';

// Test harness only. Three minutes detects a stalled operation under parallel load; it is
// never a startup, shutdown or lock latency assertion. Keep timing properties in their tests.
export const TEST_HANG_MS = 180_000;
export interface HangOptions {
  hangMs?: number;
  /** Evaluated at failure, so the log describes the current pending state. */
  diagnostic?: () => string;
}
export async function hangDetector<T>(work: Promise<T>, step: string, { hangMs = TEST_HANG_MS, diagnostic }: HangOptions = {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        let state = '';
        try { state = diagnostic?.() ?? ''; } catch (error) { state = `diagnostic failed: ${String(error)}`; }
        const error = new Error(`${step} still pending at the ${hangMs} ms hang detector${state ? `\n${state}` : ''}`);
        // Emit before unwinding: a broken emergency cleanup must not swallow the pending-step log.
        console.error(error.message);
        reject(error);
      }, hangMs);
    })]);
  } finally { clearTimeout(timer); }
}
export async function waitFor(check: () => boolean | Promise<boolean>, step: string, options: HangOptions & { intervalMs?: number } = {}): Promise<void> {
  let stopped = false, pause: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  const poll = async () => {
    while (!stopped) {
      if (await check()) return;
      if (stopped) return;
      await new Promise<void>(resolve => { wake = resolve; pause = setTimeout(resolve, options.intervalMs ?? 25); });
    }
  };
  try { await hangDetector(poll(), step, options); }
  finally { stopped = true; clearTimeout(pause); wake?.(); }
}

/** Synchronous fixture calls cannot use a JS timer; the native timeout is the same hang guard. */
export const spawnSyncHang = ((command: string, args: readonly string[] = [], options: SpawnSyncOptions = {}) => {
  const result = spawnSync(command, args, { ...options, timeout: TEST_HANG_MS });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    console.error(`${command} child completion still pending at the ${TEST_HANG_MS} ms hang detector\nexit code: ${result.status}\nsignal: ${result.signal}\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`);
  }
  return result;
}) as typeof spawnSync;
export const execFileSyncHang = ((file: string, args: readonly string[] = [], options: ExecFileSyncOptions = {}) => {
  try { return execFileSync(file, args, { ...options, timeout: TEST_HANG_MS }); }
  catch (error) {
    const state = error as NodeJS.ErrnoException & { status?: number; signal?: string; stdout?: unknown; stderr?: unknown };
    if (state.code === 'ETIMEDOUT') console.error(`${file} child completion still pending at the ${TEST_HANG_MS} ms hang detector\nexit code: ${state.status}\nsignal: ${state.signal}\nstdout:\n${state.stdout ?? ''}\nstderr:\n${state.stderr ?? ''}`);
    throw error;
  }
}) as typeof execFileSync;
