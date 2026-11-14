import type { TestContext } from 'node:test';

/** Advance selected product deadlines; native I/O and diagnostic hang guards keep real time. */
export function productClock(mock: Pick<TestContext['mock'], 'timers'>, delays: readonly number[]) {
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  mock.timers.enable({ apis: ['setTimeout'] });
  const clockSet = globalThis.setTimeout, clockClear = globalThis.clearTimeout;
  const handles = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    if (!delays.includes(ms)) return nativeSet(callback, ms, ...args);
    const handle = clockSet(callback, ms, ...args);
    handles.add(handle);
    return handle;
  }) as typeof setTimeout;
  // MockTimers also replaces clearTimeout: native handles must go to the native clearer.
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    if (handles.has(handle)) clockClear(handle); else nativeClear(handle);
  }) as typeof clearTimeout;
  let active = true;
  return {
    tick(ms: number) { mock.timers.tick(ms); },
    reset() {
      if (!active) return;
      active = false;
      globalThis.setTimeout = clockSet; globalThis.clearTimeout = clockClear;
      mock.timers.reset(); handles.clear();
    },
  };
}
