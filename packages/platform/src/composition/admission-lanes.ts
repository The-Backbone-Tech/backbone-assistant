// An identity admission holds one Core connection for its whole request, including any wait for
// the home lock behind a write in dispatch. Ordinary requests therefore share a bounded number of
// admission connections; status reads and Stop keep a reserve of their own so the running work stays
// visible and stoppable however many requests are queued. Nothing admitted on the reserve waits for
// the home lock: thread reads do not take it, and Stop holds its admission only to authorize and
// abort; its save waits for the lock after the admission is released (admission-tail.ts).
// Lanes only schedule connections: every admission still takes the same shared identity lock.
import type pg from 'pg';

export type AdmissionLane = 'request' | 'status';
export const REQUEST_ADMISSIONS = 8;
export const STATUS_ADMISSIONS = 4;
export const ADMISSION_CONNECTIONS = REQUEST_ADMISSIONS + STATUS_ADMISSIONS;

export function admissionLanes(connect: () => Promise<pg.PoolClient>): (lane?: AdmissionLane) => Promise<pg.PoolClient> {
  let used = 0;
  const waiting: (() => void)[] = [];
  // A released slot passes straight to the next waiter, so the request lane never exceeds its share.
  const take = () => used < REQUEST_ADMISSIONS ? (used++, Promise.resolve()) : new Promise<void>((resolve) => waiting.push(resolve));
  const free = () => { const next = waiting.shift(); if (next) next(); else used--; };
  return async (lane = 'request') => {
    if (lane === 'status') return connect();
    await take();
    let client: pg.PoolClient;
    try { client = await connect(); } catch (error) { free(); throw error; }
    const release = client.release.bind(client);
    let released = false;
    client.release = ((error?: Error | boolean) => { if (!released) { released = true; free(); } return release(error); }) as pg.PoolClient['release'];
    return client;
  };
}
