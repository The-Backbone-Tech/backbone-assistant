// The headless daemon: one long-lived host for a data home, without the app, so schedules, the
// heartbeat and goal runs go on while the app is closed. It owns the home exactly as the app would
// (the host's owner socket: one owner per home, and a second is refused), serves the home's doors and
// the api line for the command line, and ends cleanly on SIGTERM or SIGINT. The api line has no one
// to ask and is read-only: no send and no stop crosses it. The command line reads through it, and
// work starts from schedules, goal runs, configured channels or the app. The home's grant door runs too, as in the app:
// a granted agent may propose effects through it, under that grant's own limits.
//
// It selects the system store for a new home, and preserves an existing plaintext home.
// BACKBONE_KEYS=plaintext is an explicit headless choice. A home whose keys the app keeps in the Keychain
// is refused, honestly, rather than opened half-way.
//
// On macOS `daemon install` writes one per-user launchd agent for the home into the user's own
// LaunchAgents folder and loads it with launchctl; `daemon uninstall` unloads and removes it. Nothing
// else on the machine is touched.
import { sharedEngineNote } from './shared-engine-note.ts';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHome, createHost, HomeOwned, hostClosed } from '@backbone-next/platform/composition';
import { ApiLineAttachmentBudget, ApiLineProjectBudget, serveApiLine } from '@backbone-next/platform/composition/api-line';
import { startConfiguredTelemetry } from '@backbone-next/platform/composition/telemetry';
import { chooseKeys } from '@backbone-next/platform/system-keys';
import { lastKeyRefusal, type LastKeyRefusal } from './daemon-key-refusal.ts';
import { daemonKeyEnvironment } from './daemon-key-environment.ts';
import { refuseClosedApp } from './session.ts';
import {serveIdentityApi} from '@backbone-next/platform/composition/identity-http';
import {sharedCertificate} from '@backbone-next/platform/composition/shared-certificate';
import {isIP} from 'node:net';
import {assertHomeWriteAdmission} from '@backbone-next/platform/composition/home-lock';

export const daemonFile = (home: string) => join(home, 'daemon.json');

/** One agent per home, named for its real path: a link or another spelling of the home names the same agent. */
export const daemonLabel = (home: string) => `io.github.albertoangulo.daemon.${createHash('sha256').update(canonicalHome(home)).digest('hex').slice(0, 12)}`;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function plistFor(a: { label: string; node: string; script: string; home: string; logs: string }): string {
  const environment = Object.entries(daemonKeyEnvironment(a.home)).map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`).join('\n');
  const args = [a.node, a.script, 'daemon', 'run', '--home', a.home].map((s) => `    <string>${xml(s)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(a.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(a.logs, 'daemon.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(a.logs, 'daemon.log'))}</string>
</dict>
</plist>
`;
}

export interface Launchd {
  /** The user's LaunchAgents folder. */
  agents: string;
  uid: number;
  node: string;
  script: string;
  launchctl(args: string[]): { code: number; out: string };
  /** How long launchd may take to let go of an agent after bootout (it answers before it is done). */
  settleMs?: number;
}

export function launchd(): Launchd {
  return {
    agents: join(homedir(), 'Library', 'LaunchAgents'),
    uid: process.getuid?.() ?? 0,
    node: process.execPath,
    script: fileURLToPath(new URL('./main.ts', import.meta.url)),
    launchctl: (args) => { const r = spawnSync('launchctl', args, { encoding: 'utf8' }); return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }; },
  };
}

const plistPath = (home: string, at: Launchd) => join(at.agents, `${daemonLabel(home)}.plist`);

/** bootout's answer for "nothing by that name is loaded": nothing is left to unload. */
const notLoaded = (r: { code: number; out: string }) => r.code === 3 || r.code === 113 || /no such process|could not find service/i.test(r.out);
/** print's documented answer for a service launchd does not have: exit 113, "Could not find service". */
const notFound = (r: { code: number; out: string }) => r.code === 113;
const said = (r: { code: number; out: string }) => r.out.trim() || `exit ${r.code}`;

/**
 * Unload the agent, and know it. Only print's "service not found" counts as gone; it still being
 * there, or any answer that cannot tell, is thrown, so nothing is removed or claimed on a guess.
 */
function unload(label: string, at: Launchd) {
  const out = at.launchctl(['bootout', `gui/${at.uid}/${label}`]);
  if (out.code !== 0 && !notLoaded(out)) throw new Error(`launchctl could not unload the agent: ${said(out)}`);
  // bootout returns while the agent is still stopping: ask again until launchd says it has none.
  let printed = at.launchctl(['print', `gui/${at.uid}/${label}`]);
  for (const end = Date.now() + (at.settleMs ?? 10_000); printed.code === 0 && Date.now() < end; ) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    printed = at.launchctl(['print', `gui/${at.uid}/${label}`]);
  }
  if (printed.code === 0) throw new Error(`the agent ${label} is still loaded after launchctl bootout; it was left in place.`);
  if (!notFound(printed)) throw new Error(`Unknown outcome: launchctl could not say whether ${label} is still loaded (${said(printed)}); its file was left in place.`);
}

/**
 * A folder of this user's alone: a real folder (not a link), owned by this user, which no one else may
 * write. Made 0700 if missing. launchd runs what the agent file says, so neither it nor the log it
 * appends to may sit where someone else could swap them.
 */
function ownedFolder(folder: string, what: string) {
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const found = lstatSync(folder);
  if (!found.isDirectory() || found.uid !== process.getuid?.() || (found.mode & 0o022) !== 0) {
    throw new Error(`${what} ${folder} is not this user's alone (a link, someone else's, or writable by others); nothing was installed.`);
  }
}

/** Write the agent file without following a link: a fresh file made exclusively, then renamed into place. */
function writePlist(plist: string, text: string) {
  try {
    const found = lstatSync(plist);
    if (found.isSymbolicLink()) throw new Error(`${plist} is a link; nothing was written where it points.`);
    if (!found.isFile()) throw new Error(`${plist} is not a plain file; nothing was installed.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = join(dirname(plist), `.${process.pid}.${Date.now()}.plist.tmp`);
  writeFileSync(temp, text, { mode: 0o644, flag: 'wx' });
  try {
    chmodSync(temp, 0o644);
    renameSync(temp, plist);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function install(home: string, at: Launchd): { label: string; plist: string } {
  const real = canonicalHome(home);
  const label = daemonLabel(real);
  const plist = plistPath(real, at);
  const logs = join(real, 'logs');
  const text = plistFor({ label, node: at.node, script: at.script, home: real, logs });
  assertHomeWriteAdmission(real,join(real,'keys'));
  ownedFolder(at.agents, 'The LaunchAgents folder');
  ownedFolder(logs, 'The log folder');
  // Installing again replaces the agent: whatever launchd has under this label is unloaded first,
  // file or no file, and known to be.
  unload(label, at);
  writePlist(plist, text);
  const loaded = at.launchctl(['bootstrap', `gui/${at.uid}`, plist]);
  if (loaded.code !== 0) {
    rmSync(plist, { force: true });
    throw new Error(`launchctl could not load the agent: ${said(loaded)}`);
  }
  return { label, plist };
}

/** Unload, then remove the agent file. Removal is claimed only once launchd says it has no such agent. */
export function uninstall(home: string, at: Launchd): { label: string; removed: boolean } {
  const label = daemonLabel(home);
  const plist = plistPath(home, at);
  unload(label, at);
  const removed = existsSync(plist);
  rmSync(plist, { force: true });
  return { label, removed };
}

export function status(home: string, at: Launchd): { installed: boolean; running: boolean; pid?: number; lastRefusal?: LastKeyRefusal } {
  const installed = existsSync(plistPath(home, at));
  const printed = at.launchctl(['print', `gui/${at.uid}/${daemonLabel(home)}`]);
  const running = printed.code === 0 && /\bstate = running\b/.test(printed.out);
  const refusal = running ? undefined : lastKeyRefusal(home), diagnostic = refusal ? { lastRefusal: refusal } : {};
  if (printed.code !== 0) return { installed, running: false, ...diagnostic };
  const pid = /\bpid = (\d+)/.exec(printed.out)?.[1];
  return { installed, running, ...(pid ? { pid: Number(pid) } : {}), ...diagnostic };
}

export class DaemonBusy extends Error {}

/** Run the daemon until SIGTERM or SIGINT. Resolves when it has ended cleanly. */
export async function runDaemon(home: string, say: (line: string) => void, share?:string): Promise<void> {
  const binding=share===undefined?undefined:sharedBinding(share);
  refuseClosedApp(home);
  assertHomeWriteAdmission(home,join(home,'keys'));
  const keys = await chooseKeys(home);
  mkdirSync(home, { recursive: true });
  const host = createHost({
    home,
    keys,
    harness: 'harness-pi',
    doors: true,
    postgresNative: process.env.BACKBONE_POSTGRES_NATIVE || undefined,
    // The person's own skill and memory folders, only when BACKBONE_USER_HOME names them.
    ...(process.env.BACKBONE_USER_HOME ? { memory: { userHome: process.env.BACKBONE_USER_HOME } } : {}),
  });
  const telemetry = await startConfiguredTelemetry(host, home, keys);
  try {
    // Every call waits for the core and the home's ownership, and fails with what stopped them.
    await host.call('projects.list', {});
  } catch (error) {
    await telemetry?.close();
    host.close();
    await hostClosed(home).catch(() => {});
    if (error instanceof HomeOwned) throw new DaemonBusy(`BUSY: ${error.message} One process holds a data folder at a time; nothing was started.`);
    throw error;
  }
  let channels: {close():Promise<void>} | undefined;
  try { if (existsSync(join(home,'channels','journal.sqlite'))) { const {startConfiguredChannels}=await import('./daemon-channels.ts'); channels=await startConfiguredChannels(host,home,say,keys); } } catch { say('channels: could not start; schedules and goals remain active. Check channel configuration, credentials and listener port.'); }
  let shared:Awaited<ReturnType<typeof serveIdentityApi>>|undefined, line:Awaited<ReturnType<typeof serveApiLine>>|undefined;
  const projectCreationBudget = new ApiLineProjectBudget();
  const attachmentBudget = new ApiLineAttachmentBudget();
  try {
    let sharedState:{origin:string;fingerprint:string}|undefined;
    if(binding){
      const tls=await sharedCertificate(home,keys);
      shared=await serveIdentityApi({host,tls,...binding});
      const url=new URL(shared.origin);
      if(binding.address==='0.0.0.0'||binding.address==='::'){
        const family=binding.address==='::'?'IPv6':'IPv4';
        const address=Object.values(networkInterfaces()).flat().find(i=>i?.family===family&&!i.internal&&!i.address.startsWith('fe80:'))?.address;
        url.hostname=address?(family==='IPv6'?'['+address+']':address):(family==='IPv6'?'[::1]':'127.0.0.1');
      }
      sharedState={origin:url.origin,fingerprint:tls.fingerprint};
    }
    assertHomeWriteAdmission(home);
    writeFileSync(daemonFile(home),JSON.stringify({pid:process.pid,since:new Date().toISOString(),...(sharedState?{shared:sharedState}:{})}),{mode:0o600});
    line=await serveApiLine({ holder: 'background-service',home,projectCreationBudget,attachment:true,attachmentBudget,call:(method,args)=>host.call(method,args),readOnly:true,projectCreation:true,teamManagement:!!shared}).catch(()=>undefined);
    await host.sharedEngineReady(); // Startup, including the shared load, settles before its notice is read.
    void host.resumeInterrupted().catch(()=>{});
    await new Promise<void>(done=>{
      const end=()=>{process.off('SIGTERM',end);process.off('SIGINT',end);done();};
      process.once('SIGTERM',end);process.once('SIGINT',end);
      say(`daemon: serving ${resolve(home)} (pid ${process.pid})${line?', api line up (reads and local project creation)':''}`);
      const note=sharedEngineNote(home,()=>host.engineBringsOwnTools(),host.sharedEngineNotice());
      if(sharedState)say(`Shared workspace: ${sharedState.origin}\nCertificate SHA-256: ${sharedState.fingerprint}\nCreate a join link with backbone team invite.${note?`\n${note}`:''}`);
    });
    say('daemon: stopping');
  } finally {
    await shared?.close();await channels?.close();await telemetry?.close();await line?.close();
    host.close();await hostClosed(home);
    assertHomeWriteAdmission(home);rmSync(daemonFile(home),{force:true});
  }
  say('daemon: stopped');
}

/** An explicit numeric bind avoids resolving a hostname to an unintended interface. */
export function sharedBinding(value:string):{address:string;port:number}{
  const match=/^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
  if(!match||!isIP(match[1]??match[2])||Number(match[3])>65535)throw new Error('Use --share <numeric-ip>:<port>, such as --share 192.168.1.10:8443. Put IPv6 addresses in brackets.');
  return {address:match[1]??match[2],port:Number(match[3])};
}
