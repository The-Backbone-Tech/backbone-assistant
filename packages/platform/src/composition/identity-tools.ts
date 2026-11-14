import type { ToolHost } from '../ports/harness.ts';

/** Async project tools cross a fresh identity admission. Synchronous provenance checks
 * keep their existing contract; the engine's send gate also observes its stop signal. */
export function identityTools(tools: ToolHost, admit: (work: () => Promise<unknown>) => Promise<unknown>): ToolHost {
  return new Proxy(tools, { get(target,key,receiver) {
    const value = Reflect.get(target,key,receiver);
    if (typeof value !== 'function' || key === 'stillGranted') return value;
    return (...args: unknown[]) => admit(() => Promise.resolve(Reflect.apply(value,target,args)));
  } });
}
