// An identity admission holds a Core connection until its dispatch returns. A handler whose
// authorized effect is immediate but whose acknowledgement waits for persistence (Stop) hands that
// wait back here: the request releases its admission first, then the caller still receives the
// result only after the wait ends. Only work that narrows (records an already authorized stop)
// may be deferred; nothing deferred grants, reads or changes access.
import { AsyncLocalStorage } from 'node:async_hooks';

interface Tail { deferrable: boolean; after?: () => Promise<unknown> }
const tails = new AsyncLocalStorage<Tail>();
const DEFERRED = Symbol('deferred past admission');

/** Run one request; a deferred tail runs after `work` (and so its admission) has settled.
 * Only a request of a deferrable method may defer, never work nested inside another request. */
export async function withAdmissionTail<T>(deferrable: boolean, work: () => Promise<T>): Promise<T> {
  const tail: Tail = { deferrable };
  let result: T;
  try {
    result = await tails.run(tail, work);
  } catch (error) {
    // The deferred part only persists what was already authorized and done; never drop it.
    if (tail.after) await tail.after().catch(() => {});
    throw error;
  }
  if (!tail.after) return result;
  if (result !== (DEFERRED as unknown)) throw new Error('A deferred tail must be the request result.');
  return await tail.after() as T;
}

/** Inside a request: return the placeholder now and finish after admission. Elsewhere: finish inline.
 * `started`: work begun before admission ends whose result `finish` awaits. It is observed at once,
 * so a failure meanwhile is no unhandled rejection; `finish` still receives and reports it. */
export function deferPastAdmission<T>(finish: () => Promise<T>, ...started: Promise<unknown>[]): Promise<T> {
  for (const work of started) work.catch(() => {});
  const tail = tails.getStore();
  if (!tail?.deferrable || tail.after) return finish();
  tail.after = finish;
  return Promise.resolve(DEFERRED as unknown as T);
}

/** After a handler returned: when it deferred its finish past admission, run `cleanup` once that
 * finish ends (the Host's in-flight and Stop accounting) and return true. Otherwise return false. */
export function afterDeferred(result: unknown, cleanup: () => void): boolean {
  const tail = tails.getStore();
  const finish = tail?.after;
  if (result !== DEFERRED || !tail || !finish) return false;
  tail.after = async () => { try { return await finish(); } finally { cleanup(); } };
  return true;
}
