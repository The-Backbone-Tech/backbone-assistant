// Journal replay may retire scratch only for a writable Host, never for an inspecting Host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import {ThreadJournal} from '../src/composition/thread-journal.ts';
import {WorkspaceStore} from '../src/workspace/store.ts';
import {assertHomeState,homeState} from './readonly-home-state.ts';

async function fixture(t:TestContext){
 const root=fs.mkdtempSync(join(tmpdir(),'readonly-thread-workspace-')),home=join(root,'home'),scratch=join(root,'scratch');
 for(const part of ['keys','pg','threads','memory/daily','memory/projects','memory/topics'])fs.mkdirSync(join(home,part),{recursive:true,mode:0o700});
 for(const [name,value] of Object.entries({'kernel.json':{kernel:'core',database:'',workspace:''},'core.json':{},'keys/vault.json':{},'pg/external.json':{}}))fs.writeFileSync(join(home,name),JSON.stringify(value),{mode:0o600});
 await withHomeLock(home,async()=>{});
 const journal=new ThreadJournal(home);journal.append({kind:'thread.deleted',threadId:'deleted-thread'});
 fs.writeFileSync(scratch,'pending scratch',{mode:0o600});
 t.after(async()=>{t.mock.restoreAll();syncBuiltinESMExports();await hostClosed(home);fs.rmSync(root,{recursive:true,force:true});});
 // Exercise the cleanup branch on every supported test machine without allocating a sandbox
 // volume. The gate changes only during synchronous replay, not during Host ownership or I/O.
 const exists=fs.existsSync,rebuild=ThreadJournal.prototype.rebuild;
 t.mock.method(fs,'existsSync',(path:fs.PathLike)=>path==='/usr/bin/sandbox-exec'||exists(path));syncBuiltinESMExports();
 t.mock.method(ThreadJournal.prototype,'rebuild',function(this:ThreadJournal,...args:Parameters<ThreadJournal['rebuild']>){
  const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
  Object.defineProperty(process,'platform',{...platform,value:'darwin'});
  try{return Reflect.apply(rebuild,this,args);}finally{Object.defineProperty(process,'platform',platform);}
 });
 const removed=t.mock.method(WorkspaceStore.prototype,'remove',async(thread:string)=>{
  assert.equal(thread,'deleted-thread');fs.rmSync(scratch,{force:true});
 });
 return {home,scratch,removed};
}

test('a read-only Host preserves deleted-thread scratch through both startup replays',async t=>{
 const f=await fixture(t),before=homeState(f.home),host=createHost({home:f.home,readOnly:true});
 host.close();await hostClosed(f.home);
 assert.equal(fs.existsSync(f.scratch),true,'inspection must leave scratch for a later writable owner');
 assert.equal(f.removed.mock.callCount(),0);assertHomeState(before,homeState(f.home));
});

test('a writable Host still retires scratch recorded by a deleted-thread journal event',async t=>{
 const f=await fixture(t),host=createHost({home:f.home});
 host.close();await hostClosed(f.home);
 assert.equal(fs.existsSync(f.scratch),false);assert.ok(f.removed.mock.callCount()>0);
});
