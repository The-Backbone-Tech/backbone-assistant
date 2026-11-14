import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import type { Receipt, Thread, TurnSettings } from '../src/api.ts';
import { createHost, type Host, type HostOptions, removeDataHome } from '../src/composition/host.ts';
import { freshDataHome } from '../src/testing/data-home.ts';
import { hangDetector, waitFor } from '../../../scripts/lib/test-hang.ts';

/** A failed guard also stops the poll at its next boundary; no orphan loop keeps the file alive. */
export async function pollUntil<T>(work: (active: () => boolean) => Promise<T>, step: string): Promise<T> {
  let active = true;
  try { return await hangDetector(work(() => active), step); }
  finally { active = false; }
}

export const settings: TurnSettings = { permission: 'ask', model: 'stub', effort: 3, runsOn: 'this-computer', mode: 'chat' };

/** Every home and host this file's cases made: closed and removed when the file's cases are done. */
const homes = new Set<string>();
const hosts: Host[] = [];
const dirs = new Set<string>();
after(async () => {
  for (const h of hosts) h.close();
  for (const home of homes) await removeDataHome(home);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A scratch folder (a person's home, a fake mailbox): removed when the file's cases are done. */
export function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}

export function freshHome(): string {
  const home = freshDataHome('home');
  homes.add(home);
  return home;
}

export function open(home = freshHome(), options: Omit<HostOptions, 'home'> = {}) {
  homes.add(home);
  const host = createHost({ home, ...options });
  hosts.push(host);
  // As the app does. Opening alone resumes nothing (home-ownership.test.ts).
  void host.resumeInterrupted().catch(() => {});
  return { home, host };
}

export function value<T>(r: Receipt<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.reason}: ${r.detail}`);
  return r.value;
}

export const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');

export async function idle(host: ReturnType<typeof createHost>, threadId: string) {
  let thread!: Thread;
  await waitFor(async () => {
    thread = value(await host.call('threads.get', { id: threadId }));
    return !thread.summary.running;
  }, 'thread becomes idle', { diagnostic: () => JSON.stringify({ thread: threadId, running: thread.summary.running, turns: thread.turns.map(turn => ({ id: turn.id, status: turn.status })) }) });
  return thread;
}
