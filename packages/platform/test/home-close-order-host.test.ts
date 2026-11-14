import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// Actual disposable Host/Core composition. The emergency race exists only to drain a red test;
// every late original open is joined and closed before cleanup. It is never a production remedy.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import pg from 'pg';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {CoreCloseWaitRefusal,CoreLink,type CoreOptions} from '../src/composition/core.ts';
import {grantDoor,revokeDoor} from '../src/composition/gateway.ts';
import {createHost,hostClosed} from '../src/composition/host.ts';
import {inActiveHomeLockScope,outsideHomeLocks,withHomeLock} from '../src/composition/home-lock.ts';
import {retainOriginalWrite,saveThreadProjection} from '../src/composition/thread-custody.ts';
import {Vault} from '../src/keys/vault.ts';
import {freshHome,idle,settings,value} from './helpers.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};

test('a real Host closes a queued side question before a competing standalone door grant continues', {timeout:240_000},async t=>{
 const home=freshHome(),host=createHost({home}),releaseHolder=deferred(),emergencyCleanup=deferred();
 const lateOpenings:Promise<CoreLink>[]=[];
 let holding:Promise<void>|undefined;
 t.after(async()=>{
  releaseHolder.resolve();emergencyCleanup.resolve();host.close();
  await holding;await Promise.allSettled(lateOpenings.map(opening=>opening.then(link=>link.close())));
  await hostClosed(home);
 });
 const project=value(await host.call('projects.create',{name:'Synthetic close ordering',kind:'folder'}));
 const sent=value(await host.call('turns.send',{projectId:project.id,text:'Say hello.',attachments:[],settings,clientKey:'main'}));
 const prior=await idle(host,sent.threadId);
 const privateBefore=JSON.parse(readFileSync(join(home,'threads',`${sent.threadId}.json`),'utf8'));
 assert.equal(typeof privateBefore.task,'string');
 const originalOpen=CoreLink.open,opened=deferred();
 t.mock.method(CoreLink,'open',function(options:CoreOptions){
  const original=originalOpen.call(CoreLink,options);
  if(options.home!==home)return original;
  lateOpenings.push(original);opened.resolve();
  return Promise.race([original,emergencyCleanup.promise.then(()=>{throw new Error('Emergency red-test drain before any grant mutation');})]);
 });
 const holderEntered=deferred();
 holding=withHomeLock(home,async()=>{holderEntered.resolve();await releaseHolder.promise;});await holderEntered.promise;
 // Queue G before the side request. Its original Core open starts only once H releases.
 const grant=outsideHomeLocks(()=>grantDoor({home,name:'synthetic-r1-side',operations:['outbox.write'],ceiling:3}))
  .then(value=>({value}),error=>({error}));
 await Promise.resolve(); // Complete the standalone preflight while H still holds the lock.
 const question=outsideHomeLocks(()=>host.call('sidechat.ask',{threadId:sent.threadId,text:'Do not call a model while closing.',clientKey:'side'}))
  .then(value=>({value}),error=>({error}));
 // call() and sideReady settle their already-resolved prerequisites before this turn ends.
 await new Promise<void>(resolve=>setImmediate(resolve));host.close();
 const closed=hostClosed(home);
 try{
  releaseHolder.resolve();await holding;await opened.promise;
  const [doorResult,answerResult]=await Promise.all([hangDetector(grant,'grant (close/grant lock drain)'),hangDetector(question,'question (close/grant lock drain)'),hangDetector(closed,'closed (close/grant lock drain)')]);
  if('error' in doorResult)throw doorResult.error;
  if('error' in answerResult)throw answerResult.error;
  const door=doorResult.value,answer=answerResult.value;
  assert.equal(door.name,'synthetic-r1-side');assert.equal(answer.ok,false);
  if(!answer.ok)assert.equal(answer.reason,'NOT_AVAILABLE');
  const stored=JSON.parse(readFileSync(join(home,'threads',`${sent.threadId}.json`),'utf8'));
  assert.equal(stored.sideTurns.length,0,'close admits no side runtime or side reservation');
  assert.equal(stored.task,privateBefore.task);assert.deepEqual(stored.turns.map((turn:{id:string})=>turn.id),prior.turns.map(turn=>turn.id));
  assert.deepEqual(stored.turns.at(-1).answer,prior.turns.at(-1)!.answer);
 }finally{
  releaseHolder.resolve();emergencyCleanup.resolve();
  await Promise.allSettled([holding,grant,question,closed]);
  await Promise.allSettled(lateOpenings.map(opening=>opening.then(link=>link.close())));
 }
});

test('a nested refusal preserves its outer holder and mandatory state, then an actual grant succeeds after close', {timeout:240_000},async t=>{
 const home=freshHome(),file=join(home,'threads','thread.json');
 const before={summary:{id:'thread',projectId:'project'},task:'original-task',turns:[{id:'turn',status:'running',receipt:'original-receipt'}]};
 await saveThreadProjection(home,before);
 await retainOriginalWrite(home,'thread','run','turn','project',{document:'document',name:'result.md',body:'Synthetic result',baseVersion:null});
 const custody=JSON.parse(readFileSync(file,'utf8')).writeCustody;
 const completed={...before,turns:[{id:'turn',status:'done',receipt:'original-receipt',answer:'Synthetic result'}]};
 const originalVault=Vault.open;let vaults=0,saved=false,nextEntered=false,closes=0;
 t.mock.method(Vault,'open',function(...args:Parameters<typeof Vault.open>){vaults++;return originalVault.apply(Vault,args);});
 let mandatory:Promise<void>|undefined,next:Promise<void>|undefined;
 await withHomeLock(home,async()=>{
  assert.equal(inActiveHomeLockScope(home),true);
  mandatory=outsideHomeLocks(()=>saveThreadProjection(home,completed)).then(()=>{saved=true;});
  CoreLink.closeWhenOpen(home,mandatory.then(()=>({close:async()=>{closes++;}} as unknown as CoreLink)));
  await assert.rejects(grantDoor({home:home+'/.',name:'synthetic-nested-r1',operations:['outbox.write'],ceiling:3}),
   error=>error instanceof CoreCloseWaitRefusal&&error.closed===CoreLink.whenClosed(home));
  assert.equal(vaults,0);assert.equal(existsSync(join(home,'kernel.json')),false);assert.equal(saved,false);
  assert.equal(inActiveHomeLockScope(home),true,'refusal does not release or deactivate the outer holder');
  next=outsideHomeLocks(()=>withHomeLock(home,async()=>{nextEntered=true;}));
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(nextEntered,false);
 });
 await mandatory;await next;await CoreLink.whenClosed(home);assert.equal(saved,true);assert.equal(nextEntered,true);assert.equal(closes,1);
 const stored=JSON.parse(readFileSync(file,'utf8'));assert.equal(stored.task,before.task);assert.deepEqual(stored.turns,completed.turns);assert.deepEqual(stored.writeCustody,custody);
 const granted=await grantDoor({home,name:'synthetic-nested-r1',operations:['outbox.write'],ceiling:3});
 assert.equal(granted.name,'synthetic-nested-r1');assert.equal(vaults,1);assert.ok(existsSync(join(home,'kernel.json')));
});

test('a failed Core shutdown is observed, releases the real owner and does not poison a later Host', {timeout:240_000},async t=>{
 const home=freshHome(),host=createHost({home}),failure=new Error('Synthetic close failure after native shutdown');
 let next:ReturnType<typeof createHost>|undefined;
 t.after(async()=>{host.close();next?.close();await hostClosed(home);});
 await host.call('projects.list',{});
 const original=CoreLink.prototype.close;let injected=false;
 t.mock.method(CoreLink.prototype,'close',async function(this:CoreLink){await original.call(this);if(!injected){injected=true;throw failure;}});
 host.close();await assert.rejects(hostClosed(home),error=>error===failure);assert.equal(injected,true);
 t.mock.restoreAll();next=createHost({home});assert.deepEqual(await next.call('projects.list',{}),[]);
 next.close();await hostClosed(home);
});

test('a later close and a lost response after a committed mandate are an unretried partial failure', {timeout:240_000},async t=>{
 const home=freshHome(),host=createHost({home}),failure=new Error('Synthetic lost response after committed mandate');
 t.after(async()=>{host.close();await hostClosed(home);});await host.call('projects.list',{});
 const originalCall=CoreLink.prototype.call,originalOpen=CoreLink.open;
 let opens=0,writes=0,mandate='',workspace='';
 t.mock.method(CoreLink,'open',function(options:CoreOptions){opens++;return originalOpen.call(CoreLink,options);});
 t.mock.method(CoreLink.prototype,'call',async function<T>(this:CoreLink,...args:Parameters<CoreLink['call']>):Promise<T>{
  const result=await originalCall.apply(this,args) as T;
  if(args[1].includes('gov.issue_mandate')&&args[1].includes("'piece'")&&!writes){
   writes++;mandate=String(result);workspace=this.id.workspace;host.close();throw failure;
  }
  return result;
 });
 const intent='synthetic-r1-partial';
 await assert.rejects(grantDoor({home,name:'synthetic-partial-r1',intent,operations:['outbox.write'],ceiling:3}),error=>error===failure);
 await hostClosed(home);assert.equal(opens,1);assert.equal(writes,1);assert.ok(mandate);assert.equal(existsSync(join(home,'doors','synthetic-partial-r1.json')),false);
 const admin=new pg.Client({connectionString:dataHomeAdminUrl(home)});await admin.connect();t.after(()=>admin.end());
 const observed=await admin.query('SELECT revoked_at,intent FROM app.mandates WHERE workspace_id=$1 AND id=$2',[workspace,mandate]);
 assert.equal(observed.rows.length,1);assert.equal(observed.rows[0].revoked_at,null);assert.equal(observed.rows[0].intent.connection,intent);
 t.mock.restoreAll();assert.equal(await revokeDoor({home,name:'synthetic-partial-r1',intent}),1,'explicit intent-bound cleanup is separate from retrying the failed grant');
});
