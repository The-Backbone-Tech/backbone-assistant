// How a command reaches a data home. A running app serves its api line, and a command attaches to that
// (main.ts). With none, only app-kept keys are refused here; system-store and plaintext
// homes are opened in this process, one process at a time: `createHost` refuses a home another host
// holds, and before it is called this process also takes the CLI's lock (`<home>/cli`), which names
// the holder, and refuses a home whose doors something else serves.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { createHost, HomeOwned, hostClosed } from '@backbone-next/platform/composition';
import { assertHomeWriteAdmission, HomeBusy, withHomeLock } from '@backbone-next/platform/composition/home-lock';
import { doorSocket } from '@backbone-next/platform/doors';
import { startConfiguredTelemetry } from '@backbone-next/platform/composition/telemetry';
import { chooseKeys, homeKeyProvider, SYSTEM_WRAP } from '@backbone-next/platform/system-keys';
import { governedPolicy, keyDecision } from '@backbone-next/platform/policy';
import { completeHome, unfinishedHome } from './home-readiness.ts';
import { missingVaultRecovery } from './key-recovery.ts';
import type { Api } from './commands.ts';

export interface Holder {
  pid: number;
  command: string;
  /** The thread a send is carrying, once it has one. */
  thread?: string;
}

/** Someone else holds the home; nothing was done. `holder` is null for a process that is not this CLI. */
export class HomeHeld extends Error {
  readonly holder: Holder | null;
  constructor(message: string, holder: Holder | null) {
    super(message);
    this.holder = holder;
  }
}

/** The named data home is not there, and this command does not make one. */
export class HomeAbsent extends Error {}

/** The app keeps this home's keys and is not running: nothing was done, and no host was started. */
export class AppClosed extends Error {}

/** What a home holds once it has been used. An empty `threads` is not: a try with no keys makes it and leaves the home new. */
const HOME_DATA = ['data', 'projects.json', 'cluster.json'];
const hasData = (home: string) => HOME_DATA.some((name) => existsSync(join(home, name))) || (existsSync(join(home, 'threads')) && readdirSync(join(home, 'threads')).length > 0);

/** Stop before anything is opened on a home only a running app can open. Reads only the vault's holder and wrap, and never unseals. */
export function refuseClosedApp(home: string): void {
  const vault = join(home, 'keys', 'vault.json');
  if (!existsSync(vault)) {
    if (existsSync(join(home, 'keys', 'master.key')) || existsSync(join(home, 'pg', 'secrets.json'))) return; // The selector requires an explicit legacy plaintext choice.
    // A home with its database or projects has lost its vault; it is not new, and opening it could make one.
    if (hasData(home)) throw new HomeAbsent(missingVaultRecovery());
    return; // A new home: the vault's own words say what it needs.
  }
  let holder: unknown; let wrap: unknown;
  try {
    ({ holder, wrap } = JSON.parse(readFileSync(vault, 'utf8')) as { holder?: unknown; wrap?: unknown });
  } catch {
    holder = undefined;
  }
  if (holder === 'plaintext' || (holder === 'keychain' && wrap === SYSTEM_WRAP)) return;
  if (holder === 'keychain') throw new AppClosed('The app that keeps this data folder is not running, so nothing was done. Open it, then run the command again.');
  throw new AppClosed('This command cannot tell who keeps this data folder\'s keys, so nothing was done. Open the app.');
}

const RECOVERY_WAIT_MS = 30_000;
const lockDir = (home: string) => join(home, 'cli');
const holderFile = (home: string) => join(lockDir(home), 'holder.json');

export function readHolder(home: string): Holder | null {
  try {
    return JSON.parse(readFileSync(holderFile(home), 'utf8')) as Holder;
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether something answers on the home's door socket. No door runs on Windows, so nothing can. */
function servedElsewhere(home: string): Promise<boolean> {
  let path: string;
  try {
    path = doorSocket(home);
  } catch {
    return Promise.resolve(false);
  }
  if (!existsSync(path)) return Promise.resolve(false);
  return new Promise((done) => {
    const probe = createConnection(path);
    probe.once('connect', () => (probe.destroy(), done(true)));
    probe.once('error', () => done(false));
  });
}

function heldBy(home: string, unidentified?: string): HomeHeld {
  const holder = readHolder(home);
  if (holder && alive(holder.pid)) {
    return new HomeHeld(`BUSY: backbone ${holder.command} (pid ${holder.pid}) holds this data folder, and nothing was done. One process holds a data folder at a time: wait for it, or stop it.`, holder);
  }
  return new HomeHeld(unidentified ?? 'BUSY: a process that held this data folder has just ended, and nothing was done. Try again in a few seconds.', null);
}

/**
 * While this process holds the home, a running turn is one a kill interrupted, which the host has
 * resumed. Reading before it settles would show its old projection, and closing would cut it short,
 * so wait, within reason. A turn still running after that is shown as running, and resumes next time.
 */
async function recovered(host: Pick<Api, 'call'>) {
  const end = Date.now() + RECOVERY_WAIT_MS;
  let said = false;
  for (;;) {
    const running = (await host.call('threads.list', {})).filter((t) => t.running).length;
    if (!running || Date.now() > end) return;
    if (!said) process.stderr.write(`Recovering ${running} interrupted turn(s) first.\n`);
    said = true;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Hold the home for `fn`, with a host open on it. `readOnly` recovers nothing, so a read cannot start
 * a model call. `resume` carries on interrupted turns first, as opening the app does: `recovery: 'leave'`
 * goes on without waiting for them. `doors` serves
 * the home's doors for as long as the hold, so a door's host started meanwhile is refused rather than
 * running beside this one.
 */
export async function withHome<T>(
  home: string,
  command: string,
  fn: (api: Api, holding: (thread: string) => void) => Promise<T>,
  options: { create?: boolean; doors?: boolean; readOnly?: boolean; resume?: boolean; recovery?: 'wait' | 'leave' } = {},
): Promise<T> {
  if (!options.create && !existsSync(home)) throw new HomeAbsent(`No data folder at ${resolve(home)}. Name another with --home, or make one with: backbone projects create <name>.`);
  if (options.readOnly && !completeHome(home)) {
    try { refuseClosedApp(home); }
    catch (error) {
      if (error instanceof AppClosed) throw new AppClosed(`${error.message} ${unfinishedHome(home)}`);
      throw error;
    }
    // Policy inspection reads provider metadata only; it must not select or unseal keys.
    const provider = homeKeyProvider(home);
    if (provider) keyDecision(governedPolicy(home), provider.holder);
    throw new HomeAbsent(unfinishedHome(home));
  }
  refuseClosedApp(home);
  assertHomeWriteAdmission(home,join(home,'keys'),...(options.readOnly ? [] : [lockDir(home)]));
  const keys = await chooseKeys(home, process.env, undefined, { create: options.create ?? false, readOnly: options.readOnly ?? false });
  const inSession = async (me?: Holder): Promise<T> => {
        const host = createHost({
          home,
          keys,
          // The app's engine: with no model route a turn is refused. BACKBONE_HARNESS=stub names the stub for tests.
          harness: 'harness-pi',
          doors: options.doors ?? false,
          readOnly: options.readOnly,
          baselineSql: process.env.BACKBONE_BASELINE_FILE ? readFileSync(process.env.BACKBONE_BASELINE_FILE, 'utf8') : undefined,
          postgresNative: process.env.BACKBONE_POSTGRES_NATIVE || undefined,
          // The person's own skill and memory folders, only when BACKBONE_USER_HOME names them.
          ...(process.env.BACKBONE_USER_HOME ? { memory: { userHome: process.env.BACKBONE_USER_HOME } } : {}),
        });
        const telemetry = options.readOnly ? undefined : await startConfiguredTelemetry(host, home, keys);
        try {
          // Every call waits for the core and its recovery, and fails with what stopped them.
          await host.call('projects.list', {});
          if (options.resume) {
            await host.resumeInterrupted();
            if (options.recovery !== 'leave') await recovered(host);
          }
          return await fn(host, (thread) => { if (me) writeFileSync(holderFile(home), JSON.stringify({ ...me, thread }), { mode: 0o600 }); });
        } finally {
          await telemetry?.close();
          if (telemetry?.stats.dropped) {
            // main uses process.exit: write this fixed, content-free diagnostic synchronously.
            // Telemetry loss must not alter the command result or prevent Host teardown.
            try { writeSync(process.stderr.fd, 'Telemetry: export incomplete; observations were dropped.\n'); } catch { /* stderr may be closed. */ }
          }
          host.close();
          await hostClosed(home);
        }
  };
  let entered = false;
  try {
    if (options.readOnly) {
      if (await servedElsewhere(home)) throw heldBy(home, 'BUSY: another process serves this home; retry through its API line.');
      return await inSession();
    }
    return await withHomeLock(lockDir(home), async () => {
      entered = true;
      if (await servedElsewhere(home)) {
        throw new HomeHeld('BUSY: another process serves this data home (backbone-mcp host, or an app with no api line up yet), and nothing was done. One process holds a home at a time.', null);
      }
      const me: Holder = { pid: process.pid, command };
      writeFileSync(holderFile(home), JSON.stringify(me), { mode: 0o600 });
      try {
        return await inSession(me);
      } finally {
        rmSync(holderFile(home), { force: true });
      }
    }, 0);
  } catch (error) {
    if (error instanceof HomeBusy && !entered) throw heldBy(home);
    if (error instanceof HomeOwned) throw heldBy(home, `BUSY: ${error.message} Nothing was done.`);
    throw error;
  }
}
