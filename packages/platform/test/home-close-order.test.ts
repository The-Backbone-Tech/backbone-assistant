import { hangDetector } from '../../../scripts/lib/test-hang.ts';
// Native same-process Core close/open and gateway ordering, without opening a database or model.
// The real side admission supplies the worker edge; only the final link/Vault are test doubles.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {CoreLink,type CoreOptions} from '../src/composition/core.ts';
import {grantDoor} from '../src/composition/gateway.ts';
import {claimCoreHome} from '../src/composition/home-kernel.ts';
import {outsideHomeLocks,withHomeLock} from '../src/composition/home-lock.ts';
import {createSideChat} from '../src/composition/sidechat.ts';
import {Vault} from '../src/keys/vault.ts';
import {MaterialStore} from '../src/stub/material.ts';
import {retainOriginalWrite,saveThreadProjection} from '../src/composition/thread-custody.ts';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};

test('a side admission joined by Core close cannot remain behind a grant waiting for that close', {timeout:240_000},async t=>{
 const home=mkdtempSync(join(tmpdir(),'backbone-close-order-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 await claimCoreHome(home);
 const holderEntered=deferred(),releaseHolder=deferred(),opened=deferred(),emergencyCleanup=deferred();
 const sentinel=new Error('Synthetic Vault boundary reached: no database opened');
 const originalOpen=CoreLink.open;let plans=0,begins=0,saves=0,closeCalls=0,closing=false,vaultAttempts=0,opens=0;
 t.mock.method(Vault,'open',async()=>{vaultAttempts++;throw sentinel;});
 t.mock.method(CoreLink,'open',function(options:CoreOptions){opens++;const result=originalOpen.call(CoreLink,options);opened.resolve();return result;});
 const side=createSideChat({home,material:new MaterialStore(home,{},()=>{}),thread:()=>undefined,
  plan:()=>{plans++;throw new Error('No model should be planned.');},
  begin:async()=>{begins++;throw new Error('No run should begin.');},
  credential:async()=>{throw new Error('No credential should be read.');},
  save:async()=>{saves++;},closing:()=>closing,
 });
 const holding=withHomeLock(home,async()=>{holderEntered.resolve();await releaseHolder.promise;});
 await holderEntered.promise;
 let grantSettled=false,grantError:unknown,idleSettled=false;
 // The grant is queued first. Its Core.open captures the subsequent close only after H releases.
 const grant=outsideHomeLocks(()=>grantDoor({home,name:'synthetic-close-order',operations:['outbox.write'],ceiling:3}))
  .then(()=>{grantSettled=true;},error=>{grantError=error;grantSettled=true;});
 await Promise.resolve(); // The standalone preflight completes; G queues before the worker.
 const question=outsideHomeLocks(()=>side.ask({threadId:'thread',text:'Synthetic side question',clientKey:'close-order'}));
 closing=true;side.close();
 const idle=side.whenIdle().then(()=>{idleSettled=true;});
 const finalLink={close:async()=>{closeCalls++;}} as unknown as CoreLink;
 // The emergency branch is used only in finally to clean up a failing regression. It must never
 // settle the observed production ordering or manufacture a green result.
 CoreLink.closeWhenOpen(home,Promise.race([idle,emergencyCleanup.promise]).then(()=>finalLink));

 try{
  releaseHolder.resolve();await holding;
  await Promise.race([opened.promise,grant.then(()=>{throw grantError??new Error('Grant settled before Core open.');})]);
  await Promise.all([hangDetector(grant,'grant (close/grant lock drain)'),hangDetector(idle,'idle (close/grant lock drain)')]);
  assert.equal(grantSettled,true,'the grant must release its lock before awaiting the joined Core close');
  assert.equal(idleSettled,true,'the queued side admission must be able to observe close and finish');
  assert.equal(grantError,sentinel,'the real open reaches the controlled Vault boundary only after draining close');
  const answer=await question;assert.equal(answer.ok,false);
  assert.equal(plans,0);assert.equal(begins,0);assert.equal(saves,0);assert.equal(closeCalls,1);assert.equal(opens,2);assert.equal(vaultAttempts,1);
 }finally{

  t.diagnostic(JSON.stringify({grantSettled,idleSettled,plans,begins,saves,closeCalls,vaultAttempts,stage:'before emergency cleanup'}));
  releaseHolder.resolve();emergencyCleanup.resolve();side.close();
  await Promise.allSettled([holding,question,grant,idle,CoreLink.whenClosed(home)]);
 }
});

test('mandatory completion behind a closing Core is saved with its original task and custody', {timeout:240_000},async t=>{
 const home=mkdtempSync(join(tmpdir(),'backbone-close-completion-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));await claimCoreHome(home);
 const before={summary:{id:'thread',projectId:'project'},task:'original-task',turns:[{id:'turn',status:'running',receipt:'original-receipt'}]};
 await saveThreadProjection(home,before);
 await retainOriginalWrite(home,'thread','run','turn','project',{document:'document',name:'result.md',body:'Synthetic final result',baseVersion:null});
 const file=join(home,'threads','thread.json');
 const custody=JSON.parse(readFileSync(file,'utf8')).writeCustody;
 const completed={...before,turns:[{id:'turn',status:'done',receipt:'original-receipt',answer:'Synthetic final result'}]};
 const holderEntered=deferred(),releaseHolder=deferred(),opened=deferred(),emergencyCleanup=deferred();
 const sentinel=new Error('Synthetic Vault boundary reached: no database opened');
 const originalOpen=CoreLink.open;let vaultAttempts=0,closeCalls=0,opens=0;
 t.mock.method(Vault,'open',async()=>{vaultAttempts++;throw sentinel;});
 t.mock.method(CoreLink,'open',function(options:CoreOptions){opens++;const result=originalOpen.call(CoreLink,options);opened.resolve();return result;});
 const holding=withHomeLock(home,async()=>{holderEntered.resolve();await releaseHolder.promise;});await holderEntered.promise;
 let grantSettled=false,grantError:unknown,saved=false;
 const grant=outsideHomeLocks(()=>grantDoor({home,name:'synthetic-completion-order',operations:['outbox.write'],ceiling:3}))
  .then(()=>{grantSettled=true;},error=>{grantError=error;grantSettled=true;});
 await Promise.resolve();
 const mandatory=outsideHomeLocks(()=>saveThreadProjection(home,completed)).then(()=>{saved=true;});
 const finalLink={close:async()=>{closeCalls++;}} as unknown as CoreLink;
 CoreLink.closeWhenOpen(home,Promise.race([mandatory,emergencyCleanup.promise]).then(()=>finalLink));

 try{
  releaseHolder.resolve();await holding;
  await Promise.race([opened.promise,grant.then(()=>{throw grantError??new Error('Grant settled before Core open.');})]);
  await Promise.all([hangDetector(grant,'grant (close/grant lock drain)'),hangDetector(mandatory,'mandatory (close/grant lock drain)')]);
  assert.equal(grantSettled,true);assert.equal(grantError,sentinel);assert.equal(saved,true);assert.equal(closeCalls,1);assert.equal(opens,2);assert.equal(vaultAttempts,1);
  const stored=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(stored.task,'original-task');assert.deepEqual(stored.turns,completed.turns);assert.deepEqual(stored.writeCustody,custody);
 }finally{
  t.diagnostic(JSON.stringify({grantSettled,saved,closeCalls,vaultAttempts,stage:'before emergency cleanup'}));
  releaseHolder.resolve();emergencyCleanup.resolve();await Promise.allSettled([holding,mandatory,grant,CoreLink.whenClosed(home)]);
 }
});
