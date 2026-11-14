import { hangDetector } from '../../../scripts/lib/test-hang.ts';
import { spawnSyncHang, TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Native storage capability controls; all homes and child processes are disposable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {Worker} from 'node:worker_threads';
import {acquireHomeFileLock,assertHomeWriteAdmission,HomeFileBusy,HomeWriteUnavailable,supportedHomeFilesystem} from '../src/home-lock.ts';

function temporary(t:TestContext){const at=fs.mkdtempSync(join(tmpdir(),'kernel-home-lock-'));t.after(()=>fs.rmSync(at,{recursive:true,force:true}));return at;}
const unavailable=(code:HomeWriteUnavailable['code'])=>(error:unknown)=>error instanceof HomeWriteUnavailable&&error.code===code;

test('the local-filesystem policy rejects network, unknown and unsupported platform profiles',()=>{
 assert.equal(supportedHomeFilesystem('darwin',26),true);
 for(const type of [0,2,18,20,23,65535])assert.equal(supportedHomeFilesystem('darwin',type),false);
 for(const type of [0xef53,0x58465342,0x9123683e,0x01021994])assert.equal(supportedHomeFilesystem('linux',type),true);
 for(const type of [0,0x6969,0x517b,0xff534d42,0xfe534d42,0x65735546,0x794c7630])assert.equal(supportedHomeFilesystem('linux',type),false);
 for(const platform of ['win32','freebsd','aix'] as const)assert.equal(supportedHomeFilesystem(platform,26),false);
});

for(const optIn of [false,true])test(`Linux admission is experimental opt-in and still rejects network storage (optIn=${optIn})`,async t=>{
 const at=temporary(t),home=join(at,'unmade'),descriptor=Object.getOwnPropertyDescriptor(process,'platform')!,prior=process.env.BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK,real=fs.statfsSync;
 Object.defineProperty(process,'platform',{value:'linux'});
 if(optIn)process.env.BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK='1';else delete process.env.BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK;
 t.after(()=>{Object.defineProperty(process,'platform',descriptor);if(prior===undefined)delete process.env.BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK;else process.env.BACKBONE_EXPERIMENTAL_LINUX_HOME_LOCK=prior;});
 let checks=0;t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>{checks++;return {...real(path),type:0x6969};}) as typeof fs.statfsSync);
 await assert.rejects(acquireHomeFileLock(home,0),unavailable(optIn?'filesystem':'platform'));
 assert.equal(checks,optIn?1:0);assert.equal(fs.existsSync(home),false);
});

test('unqualified storage refuses before creating a home or lock file',async t=>{
 const at=temporary(t),home=join(at,'not-created'),observed=fs.statfsSync(at);
 t.mock.method(fs,'statfsSync',()=>({...observed,type:0x6969}));
 assert.throws(()=>assertHomeWriteAdmission(home),unavailable('filesystem'));
 await assert.rejects(acquireHomeFileLock(home,0),unavailable('filesystem'));
 assert.equal(fs.existsSync(home),false);
});

test('the observed Darwin type number is not trusted when the boot-volume profile changed',async t=>{
 const at=temporary(t),home=join(at,'unmade'),real=fs.statfsSync,descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
 Object.defineProperty(process,'platform',{value:'darwin'});t.after(()=>Object.defineProperty(process,'platform',descriptor));
 t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...real(path),type:String(path)==='/'?27:26})) as typeof fs.statfsSync);
 await assert.rejects(acquireHomeFileLock(home,0),unavailable('filesystem'));assert.equal(fs.existsSync(home),false);
});

test('every additional owned storage target is checked before admission',t=>{
 const home=temporary(t),keys=join(home,'keys'),real=fs.statfsSync;
 fs.mkdirSync(keys);const before=fs.statSync(keys).mode;
 t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...real(path),type:String(path)===keys?0x6969:real(path).type})) as typeof fs.statfsSync);
 assert.throws(()=>assertHomeWriteAdmission(home,keys),unavailable('filesystem'));
 assert.equal(fs.statSync(keys).mode,before);assert.equal(fs.existsSync(join(home,'.lock')),false);
});

test('a missing native backend has no heartbeat fallback and creates no home',t=>{
 const at=temporary(t),home=join(at,'unmade'),source=new URL('../src/home-lock.ts',import.meta.url).href;
 const script=`import assert from 'node:assert/strict';import fs from 'node:fs';import Module from 'node:module';
 const original=Module._resolveFilename;Module._resolveFilename=function(name,...rest){if(name==='fs-native-extensions')throw Object.assign(new Error('Synthetic unavailable package'),{code:'MODULE_NOT_FOUND'});return original.call(this,name,...rest);};
 const {acquireHomeFileLock,HomeWriteUnavailable}=await import(${JSON.stringify(source)});
 await assert.rejects(acquireHomeFileLock(${JSON.stringify(home)},0),e=>e instanceof HomeWriteUnavailable&&e.code==='backend');assert.equal(fs.existsSync(${JSON.stringify(home)}),false);`;
 const result=spawnSyncHang(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(fs.existsSync(home),false);
});

for(const local of [false,true])test(`the package-local payload is required before any ancestor addon is loaded (local=${local})`,t=>{
 const at=fs.realpathSync(temporary(t)),pkg=join(at,'package'),home=join(at,'unmade'),marker=join(at,'ancestor-loaded');fs.mkdirSync(pkg);
 const installed=dirname(createRequire(import.meta.url).resolve('fs-native-extensions')),host=`${process.platform}-${process.arch}`,filename='fs-native-extensions.node';
 for(const name of ['index.js','binding.js','package.json'])fs.copyFileSync(join(installed,name),join(pkg,name));
 fs.symlinkSync(dirname(installed),join(pkg,'node_modules'),'dir');
 const ancestor=join(at,'prebuilds',host,filename);fs.mkdirSync(dirname(ancestor),{recursive:true});fs.writeFileSync(ancestor,'Synthetic ancestor addon, intercepted in this child only.');
 if(local){const target=join(pkg,'prebuilds',host,filename);fs.mkdirSync(dirname(target),{recursive:true});fs.copyFileSync(join(installed,'prebuilds',host,filename),target);}
 const source=new URL('../src/home-lock.ts',import.meta.url).href;
 const script=`import assert from 'node:assert/strict';import fs from 'node:fs';import Module from 'node:module';
 const resolve=Module._resolveFilename;Module._resolveFilename=function(name,...rest){return name==='fs-native-extensions'?${JSON.stringify(join(pkg,'index.js'))}:resolve.call(this,name,...rest);};
 const extension=Module._extensions['.node'];Module._extensions['.node']=function(module,path){if(path===${JSON.stringify(ancestor)}){fs.writeFileSync(${JSON.stringify(marker)},'loaded');module.exports={tryLock(){}};return;}return extension(module,path);};
 const {acquireHomeFileLock,HomeFileBusy,HomeWriteUnavailable}=await import(${JSON.stringify(source)});
 if(${local}){const release=await acquireHomeFileLock(${JSON.stringify(home)},0);try{await assert.rejects(acquireHomeFileLock(${JSON.stringify(home)},0),HomeFileBusy);}finally{release();}}
 else {await assert.rejects(acquireHomeFileLock(${JSON.stringify(home)},0),e=>e instanceof HomeWriteUnavailable&&e.code==='backend');assert.equal(fs.existsSync(${JSON.stringify(home)}),false);}
 assert.equal(fs.existsSync(${JSON.stringify(marker)}),false,'no ancestor binary may be dlopen\u2019d');`;
 const result=spawnSyncHang(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout: TEST_HANG_MS});
 assert.equal(result.status,0,result.stderr||result.stdout);
});

test('a worker thread cannot initialize or acquire a home lock',async t=>{
 const at=temporary(t),home=join(at,'worker-must-not-create'),source=new URL('../src/home-lock.ts',import.meta.url).href;
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');import(${JSON.stringify(source)}).then(async({acquireHomeFileLock})=>{try{const release=await acquireHomeFileLock(${JSON.stringify(home)},0);release();parentPort.postMessage('entered');}catch(error){parentPort.postMessage({code:error.code,message:error.message});}});`,{eval:true});
 t.after(()=>worker.terminate());
 const refusal=await new Promise<unknown>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
 assert.ok(typeof refusal==='object'&&refusal!==null&&'code' in refusal&&refusal.code==='backend'&&'message' in refusal);
 assert.match(String(refusal.message),/main JavaScript thread/);
 assert.equal(fs.existsSync(home),false,'a second JS event loop cannot become an independent home owner');
});

test('a dangling home link is unknown rather than admission based on its parent',t=>{
 const at=temporary(t),home=join(at,'alias');fs.symlinkSync(join(at,'missing-target'),home);
 assert.throws(()=>assertHomeWriteAdmission(home),unavailable('filesystem'));
 assert.equal(fs.existsSync(join(at,'missing-target')),false);assert.equal(fs.lstatSync(home).isSymbolicLink(),true);
});

test('release is descriptor-owned and idempotent; an unrelated raw close does not release ownership',async t=>{
 const home=temporary(t),first=await acquireHomeFileLock(home,0),path=join(home,'.lock'),before=fs.statSync(path,{bigint:true});
 try{
  const raw=fs.openSync(path,'r');fs.readSync(raw,Buffer.alloc(1),0,1,0);fs.closeSync(raw);
  await assert.rejects(acquireHomeFileLock(home,0),HomeFileBusy);
 }finally{first();}
 const second=await acquireHomeFileLock(home,0);
 try{first();await assert.rejects(acquireHomeFileLock(home,0),HomeFileBusy);}finally{second();}
 const after=fs.statSync(path,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);
});

test('an inode replacement notifies once without releasing the descriptor before its owner drains',async t=>{
 const home=temporary(t),path=join(home,'.lock'),retained=join(home,'retained-lock');
 const native=createRequire(import.meta.url)('fs-native-extensions') as {tryLock(fd:number):boolean};
 let notify!:(reason:HomeWriteUnavailable)=>void,count=0;
 const loss=new Promise<HomeWriteUnavailable>(resolve=>{notify=resolve;});
 const release=await acquireHomeFileLock(home,0,reason=>{count++;notify(reason);});
 let raw:number|undefined;
 try{
  fs.renameSync(path,retained);fs.writeFileSync(path,'',{mode:0o600});
  const reason=await hangDetector(loss,'native inode replacement notification',{diagnostic:()=>`notifications=${count}`});
  assert.equal(reason.code,'unsafe-lock');assert.equal(count,1);
  raw=fs.openSync(retained,'r+');assert.equal(native.tryLock(raw),false,'notification must not release the original inode');
  release();assert.equal(native.tryLock(raw),true,'the original inode is released only when its owner drains');
  await new Promise<void>(done=>setTimeout(done,100));assert.equal(count,1);
 }finally{release();if(raw!==undefined)fs.closeSync(raw);}
});

test('release refuses to close a descriptor number reused for a different private file',async t=>{
 const home=temporary(t),path=join(home,'.lock'),victim=join(home,'retained.txt'),open=fs.openSync;let descriptor:number|undefined,loss:HomeWriteUnavailable|undefined;
 t.mock.method(fs,'openSync',((...args:Parameters<typeof open>)=>{const fd=open(...args);if(String(args[0])===path)descriptor=fd;return fd;}) as typeof fs.openSync);
 const release=await acquireHomeFileLock(home,0,reason=>{loss=reason;});assert.ok(descriptor!==undefined);
 fs.closeSync(descriptor);const reused=open(victim,'w+',0o600);assert.equal(reused,descriptor,'the control really reuses the private descriptor number');
 try{release();assert.doesNotThrow(()=>fs.writeSync(reused,'Retained'));assert.equal(loss?.code,'unsafe-lock');assert.equal(fs.readFileSync(victim,'utf8'),'Retained');}finally{release();try{fs.closeSync(reused);}catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')throw error;}}
});

test('an unexpected release identity-read failure notifies without replacing a confirmed result',async t=>{
 const home=temporary(t),path=join(home,'.lock'),open=fs.openSync,fstat=fs.fstatSync;
 let descriptor:number|undefined,fail=false,loss:HomeWriteUnavailable|undefined;
 t.mock.method(fs,'openSync',((...args:Parameters<typeof open>)=>{const fd=open(...args);if(String(args[0])===path)descriptor=fd;return fd;}) as typeof fs.openSync);
 t.mock.method(fs,'fstatSync',((...args:Parameters<typeof fstat>)=>{if(fail&&args[0]===descriptor)throw Object.assign(new Error('Synthetic identity read failure'),{code:'EIO'});return fstat(...args);}) as typeof fs.fstatSync);
 const release=await acquireHomeFileLock(home,0,reason=>{loss=reason;});assert.ok(descriptor!==undefined);const retained=descriptor;
 try{
  fail=true;assert.doesNotThrow(()=>release(),'release must not turn a settled effect into a false failure');
  assert.equal(loss?.code,'unsafe-lock');fail=false;release();
  await assert.rejects(acquireHomeFileLock(home,0),HomeFileBusy,'unknown identity retains the descriptor until process exit');
 }finally{fail=false;release();fs.closeSync(retained);}
 const next=await acquireHomeFileLock(home,0);next();
});

test('a stale legacy directory is retained and refused, never automatically converted',async t=>{
 const home=temporary(t),path=join(home,'.lock');fs.mkdirSync(path);fs.utimesSync(path,0,0);
 await assert.rejects(acquireHomeFileLock(home,0),error=>unavailable('legacy-lock')(error)&&String((error as Error).message).includes(path));
 assert.equal(fs.lstatSync(path).isDirectory(),true);assert.equal(fs.statSync(path).mtimeMs,0);
});

for(const kind of ['symlink','hardlink','public-mode'] as const)test(`unsafe lock resource remains unchanged: ${kind}`,async t=>{
 const home=temporary(t),path=join(home,'.lock'),target=join(home,'person.txt');fs.writeFileSync(target,'Keep this exact text',{mode:0o600});
 if(kind==='symlink')fs.symlinkSync(target,path);
 else if(kind==='hardlink')fs.linkSync(target,path);
 else fs.writeFileSync(path,'Not a private lock',{mode:0o644});
 const before=fs.lstatSync(path,{bigint:true});
 await assert.rejects(acquireHomeFileLock(home,0),error=>unavailable('unsafe-lock')(error)&&String((error as Error).message).includes(path));
 const after=fs.lstatSync(path,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.equal(after.nlink,before.nlink);
 assert.equal(fs.readFileSync(target,'utf8'),'Keep this exact text');
});

for(const same of [true,false])test(`64-bit inode comparison preserves exact identity (same=${same})`,async t=>{
 const home=temporary(t),path=join(home,'.lock');fs.writeFileSync(path,'',{mode:0o600});
 const physical=fs.statSync(path,{bigint:true}),originalFstat=fs.fstatSync,originalLstat=fs.lstatSync;
 const actualId=9007199254740993n,namedId=same?actualId:9007199254740992n;
 const alter=(value:fs.Stats|fs.BigIntStats,inode:bigint,big:boolean)=>Object.assign(Object.create(Object.getPrototypeOf(value)),value,{ino:big?inode:Number(inode)});
 t.mock.method(fs,'fstatSync',((fd:number,options?:{bigint?:boolean})=>{
  const value=options?.bigint?originalFstat(fd,{bigint:true}):originalFstat(fd);
  const id=originalFstat(fd,{bigint:true});return id.dev===physical.dev&&id.ino===physical.ino?alter(value,actualId,!!options?.bigint):value;
 }) as typeof fs.fstatSync);
 t.mock.method(fs,'lstatSync',((at:fs.PathLike,options?:{bigint?:boolean})=>{
  const value=options?.bigint?originalLstat(at,{bigint:true}):originalLstat(at);
  return String(at)===path?alter(value,namedId,!!options?.bigint):value;
 }) as typeof fs.lstatSync);
 if(same){const release=await acquireHomeFileLock(home,0);release();}
 else await assert.rejects(acquireHomeFileLock(home,0),unavailable('unsafe-lock'));
});
