import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createHost,hostClosed,removeDataHome} from '@backbone-next/platform/composition';
import {plaintextKeys} from '@backbone-next/platform/keys';
import {systemKeys} from '@backbone-next/platform/system-keys';
import {cli,daemon,FakeSystemStore,passed} from './system-key-fixture.ts';
import {homeState,assertHomeState} from '../../../platform/test/readonly-home-state.ts';
import {nativeHome} from '../../../platform/test/readonly-native-fixtures.ts';

for(const kind of ['plaintext','system'])test(`native CLI reads and daemon-held doctor preserve the ${kind} home`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'f7-cli-')),home=join(root,'home'),store=new FakeSystemStore();
 let holder:Awaited<ReturnType<typeof daemon>>|undefined;
 t.after(async()=>{if(holder&&holder.child.exitCode===null&&holder.child.signalCode===null){holder.child.kill('SIGTERM');await holder.done;}await removeDataHome(home);rmSync(root,{recursive:true,force:true});});
 // App-style setup has no CLI holder directory: a read must not manufacture one.
 const keys=kind==='system'?systemKeys(home,store):plaintextKeys(),writer=createHost({home,keys,harness:'stub'});
 try{await writer.call('projects.create',{name:'Read from the terminal',kind:'folder'});}finally{writer.close();await hostClosed(home);}
 assert.equal(existsSync(join(home,'cli')),false);
 const before=homeState(home),writes=store.writes;
 for(const args of [['projects','list'],['doctor','--json']]){
  const result=await cli(home,args,store,kind==='plaintext'?'plaintext':undefined);passed(result);
  if(args[0]==='doctor'){const report=JSON.parse(result.out);assert.equal(report.ok,true);assert.ok(report.checks.some((c:{name:string;status:string})=>c.name==='projects'&&c.status==='ok'));}
  assertHomeState(before,homeState(home),true);assert.equal(store.writes,writes);
 }
 assert.equal(existsSync(join(home,'cli')),false);
 holder=await daemon(home,store,kind==='plaintext'?'plaintext':undefined);
 const heldBefore=homeState(home),heldWrites=store.writes;
 const report=await cli(home,['doctor','--json'],store,kind==='plaintext'?'plaintext':undefined);passed(report);
 assert.equal(JSON.parse(report.out).ok,true);
 assert.ok(JSON.parse(report.out).checks.some((c:{name:string;detail:string})=>c.name==='holder'&&/line/.test(c.detail)));
 passed(await cli(home,['projects','list'],store,kind==='plaintext'?'plaintext':undefined));
 assertHomeState(heldBefore,homeState(home),true);assert.equal(store.writes,heldWrites);
});
for(const kind of ['plaintext','system'])for(const stage of ['vault','stamp','passwords','cluster','identity','missing-folders'])test(`real doctor and projects list refuse ${kind} first run stopped at ${stage} without any path exception`,async t=>{
 const f=await nativeHome(t,kind,stage==='missing-folders'?'complete':stage),store=new FakeSystemStore();
 if(stage==='missing-folders'){rmSync(join(f.home,'memory'),{recursive:true});rmSync(join(f.home,'threads'),{recursive:true});}
 const before=homeState(f.home);
 for(const args of [['projects','list'],['doctor','--json']]){
  const result=await cli(f.home,args,store,kind==='plaintext'?'plaintext':undefined);assert.equal(result.code,1);
  const detail=args[0]==='doctor'?JSON.parse(result.out).checks.find((c:{name:string})=>c.name==='home').detail:result.err;
  assert.ok(detail.includes('projects create')&&detail.includes(f.home),'refusal names a writable command for the same home');
  assertHomeState(before,homeState(f.home));
 }
 assert.equal(store.writes,0);assert.equal(store.reads,0);assert.equal(store.probes,0);
});
for(const kind of ['plaintext','system'])test(`real CLI refuses pending ${kind} schema without installing a step`,async t=>{
 const f=await nativeHome(t,kind,'pending'),store=new FakeSystemStore();
 for(const [id,key] of f.store.items)store.items.set(id,Buffer.from(key));
 const before=homeState(f.home);
 for(const args of [['projects','list'],['doctor','--json']]){
  const result=await cli(f.home,args,store,kind==='plaintext'?'plaintext':undefined);assert.equal(result.code,1);
  if(args[0]==='doctor')assert.equal(JSON.parse(result.out).ok,false);
  assert.ok((result.out+result.err).includes('upgrade'),'pending schema gives upgrade guidance');
  assertHomeState(before,homeState(f.home),true);
 }
 assert.equal(store.writes,0);
});
