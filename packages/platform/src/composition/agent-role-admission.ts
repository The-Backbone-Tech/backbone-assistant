import type { ChildStart } from '../ports/harness.ts';

/** Identical concurrent named calls share the actual admission outcome, never its in-memory reservation. */
export function createRoleAdmission() {
  const pending = new Map<string, Promise<ChildStart>>();
  return (key: string | undefined, start: () => Promise<ChildStart>): Promise<ChildStart> => {
    if (!key) return start();
    const prior = pending.get(key);
    if (prior) return prior;
    // Install the promise before invoking start: even a synchronous reentrant caller joins it.
    const result = Promise.resolve().then(start);
    pending.set(key, result);
    const settled = () => { if (pending.get(key) === result) pending.delete(key); };
    void result.then(settled, settled);
    return result;
  };
}
