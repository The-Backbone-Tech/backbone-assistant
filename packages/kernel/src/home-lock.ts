// Local write admission and one persistent, open-description-owned lock inode.
// No Core, identity, database or Platform dependency: bootstrapping callers use this before writes.
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {isMainThread} from 'node:worker_threads';

export class HomeWriteUnavailable extends Error {
 readonly code:'platform'|'filesystem'|'backend'|'legacy-lock'|'unsafe-lock';
 constructor(code:HomeWriteUnavailable['code'],message:string,cause?:unknown){
  super(message,{cause});this.name='HomeWriteUnavailable';this.code=code;
 }
}
export class HomeFileBusy extends Error {}
interface NativeBackend {tryLock(fd:number):boolean}
interface NativeBinding {tryLock(fd:number,offset:number,length:number,exclusive:boolean):void}
let backend:NativeBackend|undefined;

/** A closed local-filesystem policy. A known numeric type is capability admission, not access
 * authority or evidence of current ownership. Unknown/network/FUSE profiles never fall back. */
export function supportedHomeFilesystem(platform:NodeJS.Platform,type:number):boolean {
 if(platform==='darwin')return type===26; // Observed APFS profile; admission also checks the boot volume.
 // Linux UAPI magic.h: ext family, XFS, Btrfs and tmpfs. Overlay/backing-store ambiguity is closed.
 if(platform==='linux')return [0xef53,0x58465342,0x9123683e,0x01021994].includes(type);
 return false;
}

function loadBackend():NativeBackend {
 if(backend)return backend;
 try{
  const napi=Number(process.versions.napi);
  if(!Number.isSafeInteger(napi)||napi<9)throw new Error('The runtime lacks Node-API 9.');
  // Source Node uses import.meta; bundled CommonJS resolves beside its own shipped main file.
  const require=createRequire(typeof import.meta.url==='string'?import.meta.url:__filename);
  const entry=require.resolve('fs-native-extensions');
  const manifest=JSON.parse(fs.readFileSync(join(dirname(entry),'package.json'),'utf8')) as {name?:unknown;version?:unknown};
  if(manifest.name!=='fs-native-extensions'||manifest.version!=='1.5.3')throw new Error('The installed backend is outside the reviewed version.');
  // Require only the package-local Node-API payload. The package's general loader searches
  // ancestor prebuild directories, which must never repair a missing installed home-lock addon.
  const payload=join(dirname(entry),'prebuilds',`${process.platform}-${process.arch}`,'fs-native-extensions.node');
  const value=require(payload) as Partial<NativeBinding>|null;
  if(!value||typeof value.tryLock!=='function')throw new Error('The installed backend lacks the nonblocking lock operation.');
  // Same whole-file/exclusive call and busy mapping as the pinned package's maintained JS API.
  backend={tryLock(fd){try{value.tryLock!(fd,0,0,true);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='EAGAIN')return false;throw error;}}};return backend;
 }catch(cause){
  throw new HomeWriteUnavailable('backend','The local data-home lock is unavailable. Check the installation before opening this home for writing.',cause);
 }
}

function existingDirectory(target:string):string {
 let current=resolve(target);
 for(;;){
  try{
   fs.lstatSync(current);
  }catch(cause){
   if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause;
   const parent=dirname(current);if(parent===current)throw cause;current=parent;continue;
  }
  // A dangling link is an unknown target, not permission to validate a different parent.
  if(!fs.statSync(current).isDirectory())throw new Error('The storage path is not a directory.');
  return current;
 }
}

/** Pure admission before initialization: no mkdir/chmod, probe file, key operation or child.
 * Additional owned directories let callers reject a keys/PG submount before an earlier write.
 * This neither acquires a lock nor proves a source's current availability. */
export function assertHomeWriteAdmission(home:string,...otherTargets:string[]):void {
 if(!isMainThread)throw new HomeWriteUnavailable('backend','Data-home writes and locks must run on the main JavaScript thread.');
 if(process.platform!=='darwin'&&process.platform!=='linux'){
  throw new HomeWriteUnavailable('platform','Writable data homes are not supported on this operating system.');
 }
 if(process.platform==='linux'&&process.env.BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK!=='1'){
  throw new HomeWriteUnavailable('platform','Linux data-home writing is not yet qualified. An explicit experimental evaluation may set BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=1 on supported local storage.');
 }
 for(const target of [home,...otherTargets]){
  try{
   const existing=existingDirectory(target),type=fs.statfsSync(existing).type;
   // Darwin assigns VFS type numbers by registration. Do not admit another type that reuses
   // the observed number after the qualified APFS boot-volume profile changes.
   if(process.platform==='darwin'&&fs.statfsSync('/').type!==26)throw new Error('The qualified APFS boot-volume profile needs re-observation.');
   if(!supportedHomeFilesystem(process.platform,type))throw new Error('The filesystem is outside the supported local profiles.');
  }catch(cause){
   throw new HomeWriteUnavailable('filesystem',`The storage path ${resolve(target)} needs supported local storage. Network and unrecognized filesystems are not opened for writing.`,cause);
  }
  assertLockResource(join(resolve(target),'.lock'));
 }
 loadBackend();
}

interface LockFile {fd:number;path:string;device:bigint;inode:bigint}
function assertLockResource(path:string):void {
 try{
  const existing=fs.lstatSync(path);
  if(existing.isDirectory())throw new HomeWriteUnavailable('legacy-lock',`A legacy lock directory remains at ${path}. Close older clients and follow the documented stopped-client upgrade before reopening this home.`);
  if(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1||existing.uid!==process.getuid?.()||(existing.mode&0o777)!==0o600){
   throw new HomeWriteUnavailable('unsafe-lock',`The data-home lock at ${path} must be this user's private, single-link regular file with mode 0600. Stop all clients before inspecting its layout or repairing its permissions.`);
  }
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
function verifyFile(file:LockFile):void {
 const actual=fs.fstatSync(file.fd,{bigint:true}),named=fs.lstatSync(file.path,{bigint:true});
 if(!actual.isFile()||!named.isFile()||named.isSymbolicLink()||actual.nlink!==1n||named.nlink!==1n||
    actual.uid!==BigInt(process.getuid!())||named.uid!==actual.uid||(actual.mode&0o777n)!==0o600n||
    (named.mode&0o777n)!==0o600n||actual.dev!==named.dev||actual.ino!==named.ino||
    actual.dev!==file.device||actual.ino!==file.inode){
  throw new HomeWriteUnavailable('unsafe-lock',`The data-home lock at ${file.path} is not one private, unchanged regular file.`);
 }
}

function openFile(home:string):LockFile {
 const path=join(home,'.lock');
 assertLockResource(path);
 if(!Number.isInteger(fs.constants.O_NOFOLLOW))throw new HomeWriteUnavailable('backend',`This runtime cannot safely open the data-home lock at ${path}.`);
 const flags=fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW;
 const fd=fs.openSync(path,flags,0o600); // Node/libuv opens close-on-exec; installed child behavior needs distribution qualification.
 try{
  const stat=fs.fstatSync(fd,{bigint:true}),file={fd,path,device:stat.dev,inode:stat.ino};verifyFile(file);return file;
 }catch(error){fs.closeSync(fd);throw error;}
}

/** Same backend in every cooperating writer: BSD flock on macOS; Linux F_OFD_SETLK. The
 * descriptor stays private until release. No unlink/rotation, heartbeat or PID takeover.
 * Integrity observation only notifies the cooperating owner; it never expires or releases its
 * descriptor. It cannot fence a same-user process that violates the stable-inode protocol.
 * A started acquisition drains to success/timeout; the Platform wrapper owns admission cancel.
 * This is advisory exclusion for supported private homes, not a malicious same-user boundary. */
export async function acquireHomeFileLock(home:string,waitMs:number,onIntegrityLoss?:(reason:HomeWriteUnavailable)=>void):Promise<()=>void> {
 if(!Number.isFinite(waitMs)||waitMs<0)throw new RangeError('The home-lock wait must be finite and nonnegative.');
 const target=resolve(home);assertHomeWriteAdmission(target);
 fs.mkdirSync(target,{recursive:true,mode:0o700});assertHomeWriteAdmission(target);
 const directory=fs.statSync(target);
 if(!directory.isDirectory()||directory.uid!==process.getuid?.()||(directory.mode&0o022)!==0){
  throw new HomeWriteUnavailable('unsafe-lock',`The lock folder ${target} must belong to this user and prevent other users from replacing its files.`);
 }
 const file=openFile(target),until=performance.now()+waitMs;
 try{
  for(;;){
   if(loadBackend().tryLock(file.fd)){
    verifyFile(file);let released=false,notified=false;
    const notify=(cause:unknown)=>{
     if(notified)return;notified=true;clearInterval(observation);
     onIntegrityLoss?.(cause instanceof HomeWriteUnavailable?cause:new HomeWriteUnavailable('unsafe-lock',`The data-home lock at ${file.path} can no longer be verified.`,cause));
    };
    const observation=onIntegrityLoss?setInterval(()=>{
     if(released)return;
     try{verifyFile(file);}catch(cause){notify(cause);}
    },50).unref():undefined;
    return ()=>{
     if(released)return;released=true;clearInterval(observation);
     // A foreign raw-close bug must not make release close a reused descriptor for another file.
     // Reporting loss here does not throw a false post-effect refusal for a settled callback.
     try{const current=fs.fstatSync(file.fd,{bigint:true});if(current.dev!==file.device||current.ino!==file.inode){notify(new HomeWriteUnavailable('unsafe-lock',`The descriptor for ${file.path} no longer names its owned lock inode.`));return;}}
     catch(error){notify(error);return;}
     fs.closeSync(file.fd);
    };
   }
   const remaining=until-performance.now();
   if(remaining<=0)throw new HomeFileBusy('Another process is changing this data home; try again in a moment.');
   await new Promise<void>(done=>setTimeout(done,Math.min(50,remaining)));
  }
 }catch(error){fs.closeSync(file.fd);throw error;}
}
