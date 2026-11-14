import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// The real tools outer home lock and nested Core admission, with disposable tool settings only.
// No database/model opens: Vault is a tripwire; only the final close-only link is synthetic.
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {CoreCloseWaitRefusal,CoreLink,type CoreOptions} from '../src/composition/core.ts';
import {grantDoor,revokeDoor} from '../src/composition/gateway.ts';
import {outsideHomeLocks} from '../src/composition/home-lock.ts';
import {PIECES} from '../src/composition/pieces.ts';
import {retainOriginalWrite,saveThreadProjection} from '../src/composition/thread-custody.ts';
import {Vault} from '../src/keys/vault.ts';
import {pieceDigest,pieceFiles,readManifest} from '../src/pieces/digest.ts';
import {toolWorld} from '../src/testing/tools.ts';
import {MECHANISMS} from '../src/tools/mechanisms.ts';
import {createToolConnections,type Connection,type ToolDoors} from '../src/tools/service.ts';
import {readRecord,writeRecord} from '../src/tools/store.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function fixture(t:TestContext){
 const world=toolWorld(),home=join(world.root,'data');mkdirSync(home);
 t.after(()=>world.remove());
 // As in tools-safety: a disposable declared piece, independent of another owner's WIP manifest.
 const piece=join(world.root,'door');
 for(const file of pieceFiles(PIECES.mcp.dir)){mkdirSync(dirname(join(piece,file)),{recursive:true});cpSync(join(PIECES.mcp.dir,file),join(piece,file));}
 writeFileSync(join(piece,'backbone.module.json'),`${JSON.stringify({...readManifest(piece),digest:pieceDigest(piece)})}\n`);
 let vaultAttempts=0,coreReads=0;
 const refused:unknown[]=[];
 const originalOpen=CoreLink.open;
 t.mock.method(Vault,'open',async()=>{vaultAttempts++;throw new Error('Unexpected Vault boundary; no database may open in this test.');});
 t.mock.method(CoreLink,'open',(options:CoreOptions)=>originalOpen.call(CoreLink,options).catch(error=>{refused.push(error);throw error;}));
 const link={person:()=>({}),read:async()=>{coreReads++;return {rows:[]};}} as unknown as CoreLink;
 const service=(doors?:ToolDoors)=>createToolConnections({home,env:world.toolEnv,door:{command:join(piece,'src','main.ts'),piece},core:{},link:async()=>link,...(doors?{doors}:{})});
 const record=()=>readRecord<Connection>(join(home,'tools','connections'),'cursor')?.value;
 const untouched=world.snapshot();
 return {home,world,service,record,untouched,refused,counts:()=>({vaultAttempts,coreReads})};
}
async function completion(home:string){
 const original={summary:{id:'thread',projectId:'project'},task:'original-task',turns:[{id:'turn',status:'running',receipt:'original-receipt'}]};
 await saveThreadProjection(home,original);
 await retainOriginalWrite(home,'thread','run','turn','project',{document:'document',name:'result.md',body:'Synthetic committed result',baseVersion:null});
 const path=join(home,'threads','thread.json'),custody=JSON.parse(readFileSync(path,'utf8')).writeCustody;
 const final={...original,turns:[{id:'turn',status:'done',receipt:'original-receipt',answer:'Synthetic committed result'}]};
 return {queue:()=>outsideHomeLocks(()=>saveThreadProjection(home,final)),verify:()=>{
  const saved=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(saved.task,'original-task');assert.deepEqual(saved.turns,final.turns);assert.deepEqual(saved.writeCustody,custody);
 }};
}
function seed(home:string,first=false){
 const connection:Connection={id:'original-intent',want:'connected',grant:'cursor-1',name:'backbone-door',
  permission:{operations:['outbox.write'],ceiling:3,expiresAt:new Date(Date.now()+86_400_000).toISOString(),askEachCall:false},
  finalizers:['revoke','entry','skills'],skills:[],first,problem:null,connectedAt:new Date().toISOString(),savepoint:join(home,'unused-savepoint')};
 writeRecord(join(home,'tools','connections'),'cursor',connection,0);return connection;
}
function noCoreEffects(home:string,counts:{vaultAttempts:number;coreReads:number}){
 assert.deepEqual(counts,{vaultAttempts:0,coreReads:0},'refusal precedes Vault and any standing-grant answer');
 for(const name of ['kernel.json','core.json','pg','keys','doors'])assert.equal(existsSync(join(home,name)),false,`no Core ${name} mutation`);
}

test('native nested tools connect refuses closing, releases its outer lock and preserves owed revoke while mandatory completion lands',{timeout:240_000},async t=>{
 const f=fixture(t),done=await completion(f.home),entered=deferred(),resume=deferred(),emergency=deferred();
 const read=MECHANISMS.cursor.read;let paused=false,closeCalls=0,passed=false;
 t.mock.method(MECHANISMS.cursor,'read',async(...args:Parameters<typeof read>)=>{
  if(!paused){paused=true;entered.resolve();await resume.promise;}
  return read(...args);
 });
 const connecting=f.service().connect({tool:'cursor'});await entered.promise;
 const mandatory=done.queue();
 CoreLink.closeWhenOpen(f.home,Promise.race([mandatory,emergency.promise]).then(()=>({close:async()=>{closeCalls++;}} as unknown as CoreLink)));
 const closed=CoreLink.whenClosed(f.home);
 try{
  resume.resolve();const [answer]=await Promise.all([hangDetector(connecting,'tools connect'),hangDetector(mandatory,'mandatory completion'),hangDetector(closed,'Core close')]);
  assert.equal(answer.ok,false);if(answer.ok)assert.fail('Closing cannot grant a tool.');
  assert.equal(answer.reason,'NOT_AVAILABLE');assert.match(answer.detail,/^This app is closing;/);
  assert.doesNotMatch(answer.detail,/was not connected:|nothing (?:was |has been )?(?:changed|read|signed)/i,'caller already wrote durable cleanup intent');
  assert.equal(f.refused.length,1,'nested caller never waits or retries under its outer lock');
  assert.ok(f.refused[0] instanceof CoreCloseWaitRefusal);assert.equal(closeCalls,1);
  const owed=f.record();assert.ok(owed);assert.equal(owed.want,'absent');assert.deepEqual(owed.finalizers,['revoke']);
  assert.match(owed.problem!,/^This app is closing;/);assert.ok(owed.id);assert.equal(owed.permission.operations[0],'outbox.write');
  noCoreEffects(f.home,f.counts());done.verify();assert.deepEqual(f.world.snapshot(),f.untouched);
  // A later startup pays the finalizer only after a Core answer confirms this intent is absent.
  let revokes=0;const recovering=f.service({grant:grantDoor,revoke:async()=>{revokes++;return 0;}});
  assert.equal(await recovering.recover(),1);assert.equal(revokes,1);assert.equal(f.counts().coreReads,1);assert.equal(f.record(),undefined);
  assert.deepEqual(f.world.snapshot(),f.untouched);passed=true;
 }finally{
  t.diagnostic(JSON.stringify({...f.counts(),closeCalls,passed,stage:'before emergency cleanup'}));
  if(!passed)emergency.resolve();resume.resolve();await Promise.allSettled([connecting,mandatory,closed]);
 }
});

test('ordinary grant errors that mention closing remain ordinary failures, with cleanup still owed',async t=>{
 const f=fixture(t);
 const ordinary=new Error(new CoreCloseWaitRefusal(Promise.resolve()).message);
 const service=f.service({grant:async()=>{throw ordinary;},revoke:async()=>{throw ordinary;}});
 const answer=await service.connect({tool:'cursor'});
 assert.equal(answer.ok,false);if(answer.ok)assert.fail('A failed grant cannot report connected.');
 assert.equal(answer.reason,'NOT_AVAILABLE');assert.match(answer.detail,/^Cursor was not connected:/);
 assert.match(answer.detail,/permission could not be taken back yet/);
 const owed=f.record();assert.ok(owed);assert.equal(owed.want,'absent');assert.deepEqual(owed.finalizers,['revoke']);
 assert.deepEqual(f.world.snapshot(),f.untouched);noCoreEffects(f.home,f.counts());
});

for(const operation of ['disconnect','recover'] as const)test(`native nested tools ${operation} keeps closing typed until its public boundary and retains cleanup for a later startup`,{timeout:240_000},async t=>{
 const f=fixture(t),original=seed(f.home,operation==='recover'),done=await completion(f.home);
 const entered=deferred(),resume=deferred(),emergency=deferred();let revokes=0,closeCalls=0,passed=false;
 const service=f.service({grant:grantDoor,revoke:async options=>{revokes++;entered.resolve();await resume.promise;return revokeDoor(options);}});
 const work=operation==='disconnect'?service.disconnect({tool:'cursor'}):service.recover();
 // Keep a rejection observed immediately; the native typed result is asserted after close drains.
 const result=work.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
 await entered.promise;const mandatory=done.queue();
 CoreLink.closeWhenOpen(f.home,Promise.race([mandatory,emergency.promise]).then(()=>({close:async()=>{closeCalls++;}} as unknown as CoreLink)));
 const closed=CoreLink.whenClosed(f.home);
 try{
  resume.resolve();const [outcome]=await Promise.all([hangDetector(result,`tools ${operation}`),hangDetector(mandatory,'mandatory completion'),hangDetector(closed,'Core close')]);
  if(operation==='disconnect'){
   assert.equal(outcome.error,undefined);assert.ok(outcome.value&&typeof outcome.value==='object');
   assert.equal(outcome.value.ok,false);if(outcome.value.ok)assert.fail('Closing cannot report revocation complete.');
   assert.equal(outcome.value.reason,'NOT_AVAILABLE');assert.match(outcome.value.detail,/^This app is closing;/);
  }else{
   assert.ok(outcome.error instanceof CoreCloseWaitRefusal,'recover must propagate closing, never return a count claiming convergence');
   await outcome.error.closed;
  }
  assert.equal(revokes,1);assert.equal(f.refused.length,1);assert.ok(f.refused[0] instanceof CoreCloseWaitRefusal);assert.equal(closeCalls,1);
  const owed=f.record();assert.ok(owed);assert.equal(owed.want,'absent');assert.deepEqual(owed.finalizers,original.finalizers);
  assert.equal(owed.id,original.id);assert.deepEqual(owed.permission,original.permission);assert.match(owed.problem!,/^This app is closing;/);
  noCoreEffects(f.home,f.counts());done.verify();assert.deepEqual(f.world.snapshot(),f.untouched);
  let laterRevokes=0;const later=f.service({grant:grantDoor,revoke:async()=>{laterRevokes++;return 0;}});
  assert.equal(await later.recover(),1);assert.equal(laterRevokes,1);assert.equal(f.record(),undefined);assert.equal(f.counts().coreReads,1);
  assert.deepEqual(f.world.snapshot(),f.untouched);passed=true;
 }finally{
  t.diagnostic(JSON.stringify({...f.counts(),revokes,closeCalls,passed,stage:'before emergency cleanup'}));
  if(!passed)emergency.resolve();resume.resolve();await Promise.allSettled([result,mandatory,closed]);
 }
});
