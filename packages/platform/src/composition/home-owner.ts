// One live host per data home, for as long as its process lives. The owner listens on a socket in
// the home's user-only folder: the operating system ends that with the process, however it dies,
// and goes on answering for a process that is paused. So a lapse of time never hands a home over,
// and recovery can only close a run whose owner really is gone.
import { governedPolicy } from '../policy/index.ts';
import { startWorkspaceSweep } from './workspace-lifecycle.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { userInfo } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { canonicalHome, doorSocket, ownFolder } from '../doors/protocol.ts';
import { assertHomeWriteAdmission, inActiveHomeLockScope, withHomeLock } from './home-lock.ts';

export class HomeOwned extends Error {}

/** Release attempts are keyed exactly as ownership/locks. A fresh owner waits for settlement,
 * then probes the real socket; a prior failure is not permission to bypass a still-live owner. */
const releases = new Map<string, Promise<void>>();
export async function priorHomeRelease(home: string): Promise<void> {
  await Promise.allSettled([releases.get(canonicalHome(home))]);
}
export function homeRelease(home: string): Promise<void> {
  return releases.get(canonicalHome(home)) ?? Promise.resolve();
}
export function trackHomeRelease(home: string, current: Promise<void>): void {
  const key = canonicalHome(home);
  const done = Promise.allSettled([releases.get(key), current]).then(([, own]) => {
    if (own.status === 'rejected') throw own.reason;
  });
  void done.catch(() => {}); // Observers retain this failure; the next attempt settles it independently.
  releases.set(key, done);
}

/**
 * Admit Host initialization before any constructor writes. Writable modes also make the
 * real home private; readOnly performs admission inspection without initializing stores.
 */
export function prepareHome(home: string, readOnly=false): void {
  governedPolicy(home);
  assertHomeWriteAdmission(home,...['keys','pg','threads','memory','triage'].map(part=>join(home,part)));
  if(readOnly)return;
  // The data home, with the project folders the Host projects documents into, is the person's private storage
  // on this device: Core's rule of two treats writing there as not publishing, so only their user may enter it.
  // The folder a link points to is the one made private; a home of another user's is not opened for writing.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const real = realpathSync(home);
  const found = statSync(real);
  if (!found.isDirectory() || found.uid !== process.getuid?.()) {
    throw new Error(`${real} is not this user's own folder, so this data folder is not opened for writing.`);
  }
  chmodSync(real, 0o700);
  // On macOS an access-control list can still let others in whatever the mode says, so its entries are removed
  // and their absence checked. (On Linux the mode sets the ACL mask, which already shuts out named entries.)
  if (process.platform === 'darwin') {
    execFileSync('/bin/chmod', ['-N', real]);
    if (/^\s*\d+: /m.test(execFileSync('/bin/ls', ['-led', real], { encoding: 'utf8' }))) {
      throw new Error(`${real} keeps an access list that may let others in, so this data folder is not opened for writing.`);
    }
  }
}

/** Only this process's Host/Core are drained here. The caller must already have stopped every
 * other owner and independent scope; this is no proof of global quiescence or deletion authority. */
export async function waitToRemoveHome(home:string,closed:()=>Promise<void>):Promise<void>{
  if(inActiveHomeLockScope(home))throw new Error('A data folder cannot be removed inside its active lock. Stop all owners and independent scopes before removing it.');
  await closed();
}

/**
 * Writable short-path owners use the home's run folder. Readers and long-path owners use
 * the OS account's private runtime folder, independent of HOME/TMPDIR supplied by a client.
 * Another local account cannot pre-create this folder in the world-writable temp namespace.
 */
export function ownerSocket(home: string, readOnly = false) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\backbone-owner-${createHash('sha256').update(canonicalHome(home)).digest('hex').slice(0, 16)}`;
  const at=canonicalHome(home),door=doorSocket(at);
  if (!readOnly && basename(door)==='door.sock') return join(dirname(door),'owner.sock');
  const account=realpathSync(userInfo().homedir),found=lstatSync(account),folder=join(account,'.backbone-runtime');
  if(!found.isDirectory()||found.uid!==process.getuid?.()||(found.mode&0o022)!==0)throw new Error(`${account} is not this user's protected account folder, so no owner socket is used.`);
  if(folder===at||folder.startsWith(at+sep))throw new Error('The owner runtime folder must be outside the data folder; this read cannot create one inside it.');
  const path=join(folder,`${createHash('sha256').update(at).digest('hex').slice(0,16)}.${readOnly?'readonly-':''}owner.sock`);
  if(Buffer.byteLength(path)>(process.platform==='darwin'?103:107))throw new Error(`${folder} is too long for a private owner socket.`);
  return path;
}

/** Make the owner's folder this user's alone, or refuse a folder that is someone else's or a link. */
function ownersFolder(path: string) {
  if (process.platform === 'win32') return;
  const folder = dirname(path);
  assertHomeWriteAdmission(folder);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  // Tightened only when it is a real folder of this user's: a link's target is never touched.
  const found = lstatSync(folder);
  if (found.isDirectory() && found.uid === process.getuid?.()) chmodSync(folder, 0o700);
  if (!ownFolder(path)) throw new Error(`${folder} is not this user's alone, so this data folder is not opened.`);
}

/** Inspect before connecting, including candidates owned by the other opening mode. */
export async function ownerAnswers(path:string):Promise<boolean>{
  if(process.platform!=='win32'){
    const folder=dirname(path);
    try{lstatSync(folder);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw new Error(`${folder} cannot be inspected for private ownership.`);}
    if(!ownFolder(path))throw new Error(`${folder} is not this user's private owner folder; no socket was probed.`);
    let socket;
    try{socket=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw new Error(`${path} cannot be inspected for private ownership.`);}
    // Bind creates 0700 under the private umask, then readiness tightens it to 0600.
    // Either private mode must be probeable if the owner dies between those steps.
    const mode=socket.mode&0o777;
    if(!socket.isSocket()||socket.uid!==process.getuid?.()||(mode!==0o600&&mode!==0o700))throw new Error(`${path} is not this user's private owner socket; no connection was made.`);
  }
  return new Promise<boolean>((resolve) => {
  const probe = createConnection(path);
  probe.setTimeout(1000,()=>{probe.destroy();resolve(true);});
  probe.once('connect', () => { probe.destroy(); resolve(true); });
  // Only "nobody is listening" is proof of no owner. Anything else counts as one.
  probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
  });
}

const listen = (path: string) => new Promise<Server>((resolve, reject) => {
  const server = createServer((socket) => socket.destroy());
  server.once('error', reject);
  // Unix bind is synchronous. Never yield with a changed process-wide mask, and
  // never expose a group/other-accessible socket before the readiness callback.
  const previous=process.umask(0o077);
  try {
    server.listen(path, () => {
      server.removeListener('error', reject);
      server.unref();
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      resolve(server);
    });
  } finally { process.umask(previous); }
});

/** Hold the home until the returned release, or the end of this process. */
export async function ownHome(given: string, options: {readOnly?: boolean} = {}): Promise<() => Promise<void>> {
  const home = canonicalHome(given);
  assertHomeWriteAdmission(home);
  const path = ownerSocket(home, !!options.readOnly);
  ownersFolder(path);
  const inUse = async () => {
    for (const candidate of [ownerSocket(home), ownerSocket(home,true)]) if (await ownerAnswers(candidate)) throw new HomeOwned('This data folder is in use by another host.');
  };
  // Asked before the lock too: an owner may hold that lock, and a refusal need not wait for it.
  await inUse();
  const server = await withHomeLock(home, async () => {
    await inUse();
    try { unlinkSync(path); } catch { /* No leftover from a killed owner. */ }
    return listen(path);
  });
  // Keep the Host's supplied namespace spelling, as its ToolHost does; ownership itself is canonical.
  const stopSweep = options.readOnly ? async () => {} : startWorkspaceSweep(given);
  return async () => { await stopSweep(); await new Promise<void>((resolve) => server.close(() => resolve())); };
}
