// Main owns the picked paths and launch custody. A renderer gets only an opaque, window-bound id.
// The child performs normal admission and reports through a private process channel; spawning alone
// is never an opened result. No target write or new filesystem lock belongs to this module.
import { SYSTEM_WRAP } from '@backbone-next/platform/system-keys';
import { KeysRefused } from '@backbone-next/platform/keys';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import type { EventEmitter } from 'node:events';

export type FolderOpenResult = { state: 'opened' } | { state: 'already-open'; current?: boolean } | { state: 'failed' | 'unknown'; detail: string };
export type FolderPick = { ok: true; id: string; folder: string } | { ok: false; reason: string; detail: string };
const failed = (detail: string): FolderOpenResult => ({state:'failed',detail});
const identity = (folder: string) => {
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a plain data folder, not a link.');
  return `${stat.dev}:${stat.ino}:${realpathSync(folder)}`;
};
export function createDataFolderOpener(options: { check(folder: string): void; launch(folder: string): Promise<FolderOpenResult>; now?: () => number; currentFolder?: string }) {
  const now = options.now ?? Date.now;
  const picks = new Map<string, {folder:string; identity:string; owner:number; at:number; result?:Promise<FolderOpenResult>}>();
  return {
    pick(folder: string, owner: number): FolderPick {
      try {
        const seen = identity(folder); options.check(folder);
        for (const [id,p] of picks) if (now()-p.at>30*60_000) picks.delete(id);
        const id=randomUUID(); picks.set(id,{folder,identity:seen,owner,at:now()});
        return {ok:true,id,folder};
      } catch (error) { return {ok:false,reason:'INVALID',detail:error instanceof Error?error.message:String(error)}; }
    },
    async open(id: unknown, owner: number): Promise<FolderOpenResult> {
      const pick=typeof id==='string'?picks.get(id):undefined;
      if (!pick || pick.owner!==owner) return failed('Choose it with “Open another data folder…” in this window.');
      if (pick.result) return pick.result;
      if (now()-pick.at>30*60_000) return failed('That choice expired. Use “Open another data folder…” to choose it again.');
      try {
        if (identity(pick.folder)!==pick.identity) return failed('The data folder changed after it was chosen. Choose it again.');
        options.check(pick.folder);
        if (options.currentFolder && realpathSync(pick.folder) === realpathSync(options.currentFolder)) {
          pick.result = Promise.resolve({state:'already-open',current:true});
          return pick.result;
        }
        pick.result=Promise.resolve().then(()=>options.launch(pick.folder)).catch(()=>({state:'unknown' as const,detail:'The launch result could not be confirmed. Check the other window before trying again.'}));
        return pick.result;
      } catch (error) { return failed(error instanceof Error?error.message:String(error)); }
    },
  };
}

/** An allowlist: no ambient keys, client settings, model endpoints or personal memory imports. */
export function launchEnvironment(folder: string, parent: NodeJS.ProcessEnv, packaged: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv={};
  for (const key of ['PATH','HOME','USER','LOGNAME','TMPDIR','TEMP','TMP','LANG','LC_ALL','SystemRoot','WINDIR','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR']) if (parent[key]!==undefined) env[key]=parent[key];
  env.BACKBONE_HOME=folder;
  if (!packaged && parent.BACKBONE_KEYS==='plaintext') env.BACKBONE_KEYS='plaintext';
  return env;
}
type Child = EventEmitter & { unref(): void; connected?: boolean; disconnect(): void };
interface LaunchOptions {
  executable: string; appPath: string; packaged: boolean; env: NodeJS.ProcessEnv;
  spawn?: (executable:string,args:string[],options: {env:NodeJS.ProcessEnv;detached:boolean;stdio:['ignore','ignore','ignore','ipc']})=>Child;
  timeoutMs?: number;
}
export function launchDataFolder(folder: string, options: LaunchOptions): Promise<FolderOpenResult> {
  return new Promise(resolve=>{
    let child:Child;
    let settled=false;
    const finish=(result:FolderOpenResult)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      try { if(child?.connected)child.disconnect(); } catch { /* The child may have closed the channel first. */ }
      child?.unref();resolve(result);
    };
    const timer=setTimeout(()=>finish({state:'unknown',detail:'The other window has not confirmed that it opened. It may still be starting. Check it before trying again; no second launch was made.'}),options.timeoutMs??90_000);
    try {
      child=(options.spawn??spawn)(options.executable,options.packaged?[]:[options.appPath],{env:launchEnvironment(folder,options.env,options.packaged),detached:true,stdio:['ignore','ignore','ignore','ipc']});
      child.once('error',error=>finish(failed(`Could not start the app: ${error.message}`)));
      // Node may deliver exit before the final IPC message. Disconnect drains that channel.
      let exited = false;
      let disconnected = child.connected === false;
      const stopped = () => finish(failed('The other app stopped before confirming its data folder.'));
      child.once('exit',()=>{exited=true;if(disconnected)setImmediate(stopped);});
      child.once('disconnect',()=>{disconnected=true;if(exited)setImmediate(stopped);});
      child.on('message',(value:unknown)=>{
        if(!value||typeof value!=='object')return;
        const v=value as Record<string,unknown>;
        if(v.state==='opened'||v.state==='already-open')finish({state:v.state});
        else if(v.state==='failed'&&typeof v.detail==='string')finish(failed(v.detail));
      });
    }catch(error){finish(failed(error instanceof Error?error.message:String(error)));}
  });
}


/** Give the IPC pipe time to flush even when a duplicate instance exits immediately. */
export function reportBeforeExit(result: object, send: ((result: object, done: () => void) => void) | undefined, exit: () => void, timeoutMs = 1000): void {
  let ended = false;
  const finish = () => { if (ended) return; ended = true; clearTimeout(timer); exit(); };
  const timer = setTimeout(finish, timeoutMs);
  if (!send) { finish(); return; }
  try { send(result, finish); } catch { finish(); }
}

/** `keys`: this app can never open the folder. `keychain`: the Keychain refused this time; retry. */
export interface FolderStartupProblem { kind: 'keys' | 'keychain' | 'startup'; detail: string }
/** Fixed words from the original Core error, before identity bootstrap can mask it. */
export function folderStartupProblem(error: unknown, provider?: {holder:string;wrap:string} | null): FolderStartupProblem {
  if (error instanceof KeysRefused) {
    if (provider?.holder === 'keychain' && provider.wrap === SYSTEM_WRAP) return {kind:'keys',detail:'This data folder’s keys are protected by the command’s system key store; this app uses a different Keychain format, so open it with the command that created it or restore an export into a new data folder.'};
    if (error.code === 'plaintext-home') return {kind:'keys',detail:'This data folder keeps its keys in plain files; the installed app requires Keychain-held keys, so open it with the command that created it or restore an export into a new data folder.'};
    if (error.code === 'test-database') return {kind:'keys',detail:'This data folder borrows a test database; the installed app opens only a data folder with a database of its own.'};
    // A locked or refusing Keychain says nothing lasting about the folder, which may be the person's own.
    return {kind:'keychain',detail:'The Keychain did not give this data folder’s keys. Unlock the Keychain, or allow access when macOS asks, then open the app again. Nothing was changed.'};
  }
  return {kind:'startup',detail:'The app could not finish opening this data folder. Read the reason in the other window.'};
}

/** The visible page alone cannot establish ownership or a successful startup. */
export function folderVisibleResult(input: { owns: boolean; readSucceeded: boolean; failed: boolean; problem?: FolderStartupProblem }): FolderOpenResult {
  if (!input.owns) return failed('Another process holds this data folder. The other window explains how to free it.');
  if (!input.readSucceeded || input.failed) return failed(input.problem?.detail ?? 'The app could not finish opening this data folder. Read the reason in the other window.');
  return {state:'opened'};
}
export function folderChoiceRefusal(company: boolean): Extract<FolderPick,{ok:false}> | undefined {
  return company ? {ok:false,reason:'NOT_AVAILABLE',detail:'Your company controls data folders. Ask your administrator.'} : undefined;
}
export function secondLaunchAction(hasWindow: boolean, ready: boolean, stopping: boolean): 'focus' | 'open' | 'none' {
  return hasWindow ? 'focus' : ready && !stopping ? 'open' : 'none';
}
/** The picker has no qualification for removable volumes, even if formatted as APFS. */
export function checkFolderStorage(folder: string, admit: (folder: string) => void, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin' && (folder === '/Volumes' || folder.startsWith('/Volumes/'))) {
    throw new Error('Choose a data folder on this Mac’s startup disk. Other volumes, including removable and network disks, are not supported here.');
  }
  admit(folder);
}
