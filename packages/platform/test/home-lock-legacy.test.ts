import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
// Old/new protocol compatibility. Conversion below is an explicit quiescent fixture operation.
import assert from 'node:assert/strict';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import {lstatSync,mkdtempSync,rmdirSync,rmSync,statSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import lockfile from 'proper-lockfile';
import {HomeWriteUnavailable,withHomeLock} from '../src/composition/home-lock.ts';

function home(t:TestContext){const h=mkdtempSync(join(tmpdir(),'lock-compat-'));t.after(()=>rmSync(h,{recursive:true,force:true}));return h;}
async function holder(t:TestContext,h:string,legacy=false){
 const script=fileURLToPath(new URL(legacy?'./home-lock-legacy-holder.ts':'./lock-contender.ts',import.meta.url));
 const child=spawn(process.execPath,[script,h,'hold'],{stdio:['pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams;
 const exited=once(child,'exit');let output='',errors='';child.stderr.on('data',(bytes:Buffer)=>{errors+=bytes.toString();});
 t.after(async()=>{child.kill('SIGCONT');if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
 await Promise.race([
  new Promise<void>(resolve=>child.stdout.on('data',(bytes:Buffer)=>{output+=bytes.toString();if(output.includes('held\n'))resolve();})),
  exited.then(()=>{throw new Error('Compatibility holder exited before entry: '+errors);}),
 ]);
 return {child,exited};
}
const legacyRefusal=(error:unknown)=>error instanceof HomeWriteUnavailable&&error.code==='legacy-lock';
const oldRefusal=(code:string)=>(error:unknown)=>(error as NodeJS.ErrnoException).code===code;
const oldTake=(h:string)=>lockfile.lock(h,{realpath:false,lockfilePath:join(h,'.lock'),stale:5_000,update:1_000,retries:0});

test('legacy-style heartbeat writes to a regular file neither grant ownership nor notify loss',async t=>{
 const h=home(t);await withHomeLock(h,async signal=>{
  const path=join(h,'.lock'),first=statSync(path,{bigint:true});utimesSync(path,0,0);
  await assert.rejects(oldTake(h),oldRefusal('ENOTDIR'));
  utimesSync(path,new Date(),new Date());await new Promise<void>(resolve=>setTimeout(resolve,120));
  assert.equal(signal.aborted,false);assert.equal(statSync(path,{bigint:true}).ino,first.ino);
 });
});

for(const state of ['idle','holding','paused','crashed'] as const)test(`a persistent new lock excludes legacy mkdir/rmdir acquisition when ${state}`,{timeout: TEST_HANG_MS * 2},async t=>{
 const h=home(t),path=join(h,'.lock');await withHomeLock(h,async()=>{});
 const first=statSync(path,{bigint:true});
 const active=state==='idle'?undefined:await holder(t,h);
 if(state==='paused')active!.child.kill('SIGSTOP');
 if(state==='crashed'){active!.child.kill('SIGKILL');await active!.exited;}
 await assert.rejects(oldTake(h),oldRefusal('ELOCKED'));
 utimesSync(path,0,0); // Force the old client's stale/rmdir branch, even while new ownership is live.
 await assert.rejects(oldTake(h),oldRefusal('ENOTDIR'));
 // A legacy heartbeat may update a regular file; it cannot confer ownership or replace the inode.
 utimesSync(path,new Date(),new Date());
 const after=statSync(path,{bigint:true});assert.equal(after.ino,first.ino);assert.equal(after.dev,first.dev);assert.equal(after.isFile(),true);
 if(active&&state!=='crashed'){
  active.child.kill('SIGCONT');active.child.stdin.end('release\n');const [code]=await active.exited;assert.equal(code,0);
 }
 await withHomeLock(h,async signal=>assert.equal(signal.aborted,false));
 assert.equal(statSync(path,{bigint:true}).ino,first.ino);
});

test('a paused legacy owner and its crashed directory are refused until an explicit stopped-client fixture conversion',{timeout: TEST_HANG_MS * 2},async t=>{
 const h=home(t),path=join(h,'.lock'),active=await holder(t,h,true);
 await assert.rejects(withHomeLock(h,async()=>assert.fail('new writer entered a legacy-held home')),legacyRefusal);
 active.child.kill('SIGSTOP');
 await new Promise<void>(resolve=>setTimeout(resolve,6_200));
 await assert.rejects(withHomeLock(h,async()=>assert.fail('new writer entered after a legacy pause')),legacyRefusal);
 assert.equal(lstatSync(path).isDirectory(),true);
 active.child.kill('SIGKILL');await active.exited;utimesSync(path,0,0);
 await assert.rejects(withHomeLock(h,async()=>assert.fail('new writer converted a crashed legacy home')),legacyRefusal);
 assert.equal(lstatSync(path).isDirectory(),true);
 // All test clients are now stopped. The test explicitly confirms this disposable conversion;
 // production acquisition never performs it and no live data-home migration is exercised here.
 rmdirSync(path);
 await withHomeLock(h,async()=>{});assert.equal(lstatSync(path).isFile(),true);
 await assert.rejects(oldTake(h),oldRefusal('ELOCKED'));
});

test('a normally released legacy owner can be upgraded without replacing any new persistent inode',async t=>{
 const h=home(t),active=await holder(t,h,true);
 active.child.stdin.end('release\n');const [code]=await active.exited;assert.equal(code,0);
 await withHomeLock(h,async()=>{});const first=statSync(join(h,'.lock'),{bigint:true});
 await withHomeLock(h,async()=>{});assert.equal(statSync(join(h,'.lock'),{bigint:true}).ino,first.ino);
});
