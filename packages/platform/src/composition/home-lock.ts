// An advisory lock per data home, so two processes (two copies of the app, the app and the door's
// own grant or revoke command) never change its grants and connections at the same time. Across
// processes a private descriptor holds a kernel lock on a persistent inode. A paused owner stays
// exclusive; within one process, callers queue and a holder may re-enter its active scope.
import {checkIdentityLocal} from './identity-local.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import {acquireHomeFileLock,assertHomeWriteAdmission as admitStorage,HomeFileBusy,HomeWriteUnavailable} from '@backbone-next/kernel/home-lock';
import { canonicalHome } from '../doors/protocol.ts';
export {HomeWriteUnavailable} from '@backbone-next/kernel/home-lock';

export class HomeBusy extends Error {}

interface LockScope { signal: AbortSignal; active: boolean }
const held = new AsyncLocalStorage<Map<string, LockScope>>();
const queues = new Map<string, Promise<unknown>>();
// Bundled package entries can contain distinct module copies in one JS realm. A refused key is
// process state, so loading another copy cannot turn observation of a loss into fresh admission.
const shared=globalThis as unknown as Record<symbol,Map<string,HomeWriteUnavailable>|undefined>;
const unavailable = shared[Symbol.for('@backbone-next/platform/home-lock/unavailable/v1')] ??= new Map<string,HomeWriteUnavailable>();
const assertAvailable=(key:string)=>{const reason=unavailable.get(key);if(reason)throw reason;};

/** A lost key stays unavailable in this process, including fresh Host/Vault initialization. */
export function assertHomeWriteAdmission(home:string,...targets:string[]):void {
  for(const target of [home,...targets])assertAvailable(canonicalHome(target));
  admitStorage(home,...targets);
}

/** Schedule independent work without inheriting a caller's permission to re-enter its locks. */
export function outsideHomeLocks<T>(fn: () => T): T { return held.exit(fn); }

/** Scope information for refusing a dependency wait, never write authority or permission to
 * release a holder. Never await a pending Core close or independently started Core open here:
 * either may need this lock. Core.open's scoped admission refuses the close dependency. */
export function inActiveHomeLockScope(home: string): boolean {
  return held.getStore()?.get(canonicalHome(home))?.active === true;
}

/**
 * Run `fn` holding the data home's lock: queued behind this process's other holders, and behind any
 * other process's. Nested callers share the same scope signal. There is no timed ownership loss:
 * the private descriptor stays held until the callback drains, even after a pause or cancellation.
 * Optional `admission` cancels an in-process queue wait without releasing its predecessor. An
 * acquisition already waiting on another process is joined and released before cancellation returns.
 * Never await a pending Core close or independently started Core/Host open while holding this lock.
 * An open invoked within this scope can re-enter it; Core.open refuses a pending-close dependency.
 */
export async function withHomeLock<T>(home: string, fn: (lost: AbortSignal) => Promise<T>, waitMs = 60_000, admission?: AbortSignal): Promise<T> {
  admission?.throwIfAborted();
  const key = canonicalHome(home);
  assertAvailable(key);
  const parent = held.getStore()?.get(key);
  if (parent?.active) return fn(parent.signal);
  const before = queues.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  queues.set(key, before.then(() => mine));
  try {
    if (admission) {
      let abort!: () => void;
      const cancelled = new Promise<never>((_, reject) => { abort = () => reject(admission.reason); admission.addEventListener('abort', abort, { once: true }); });
      try { await Promise.race([before, cancelled]); } finally { admission.removeEventListener('abort', abort); }
    } else await before;
    admission?.throwIfAborted();
    assertAvailable(key);
    let release: () => void;
    const lost = new AbortController();
    try {
      release = await acquireHomeFileLock(key,waitMs,reason=>{
        const refusal=new HomeWriteUnavailable(reason.code,`${reason.message} Restart this process after checking the lock.`,reason);
        unavailable.set(key,refusal);unavailable.set(canonicalHome(key),refusal);lost.abort(refusal);
      });
    } catch (error) {
      if (error instanceof HomeFileBusy) throw new HomeBusy(error.message);
      throw error;
    }
    const scope: LockScope = { signal: lost.signal, active: true };
    try {
      admission?.throwIfAborted();
      checkIdentityLocal(home);
      return await held.run(new Map([...(held.getStore() ?? []), [key, scope]]), () => fn(scope.signal));
    } finally {
      // Descendants may outlive this callback. Its async-local marker then proves no ownership.
      scope.active = false;
      release();
    }
  } finally {
    done();
  }
}
