// Real store/home-lock behaviour; no provider or database is involved in these worker controls.
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {MaterialStore} from '../src/stub/material.ts';
import {CoreRefusal} from '../src/composition/core.ts';
import {outsideHomeLocks,withHomeLock} from '../src/composition/home-lock.ts';
import {createMaterialWithdrawalDelivery,withdrawalDeliveryNotices} from '../src/composition/material-withdrawal-delivery.ts';
const WORKSPACE='workspace-a';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(t:TestContext,working=false){
 const home=mkdtempSync(join(tmpdir(),'material-delivery-'));
 const material=new MaterialStore(home,working?{saveDelayMs:50}:{},()=>{});
 const entry=material.create('project-a','source.md','text/markdown',Buffer.from('v1'),working?'working':'original',working?'agent':'person');
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 return {home,material,entry};
}
const confirmation=(event:{id:string},receipt='receipt-a')=>({workspace:WORKSPACE,event:event.id,receipt});

test('a detached delivery cannot borrow a still-active caller home lock',async t=>{
 const {home,material,entry}=setup(t);let calls=0;
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>{calls++;return confirmation(event);}});
 t.after(()=>worker.close());
 await withHomeLock(home,async()=>{
  material.withdraw(entry.id);worker.request();await tick();await tick();
  assert.equal(calls,0,'delivery must queue behind its caller, even while the inherited marker is active');
 });
 await worker.whenIdle();assert.equal(calls,1);assert.deepEqual(material.pendingWithdrawals(WORKSPACE),[]);
});

test('close cancels a queued lock admission without waiting for the caller holding it',async t=>{
 const {home,material,entry}=setup(t);material.withdraw(entry.id);let calls=0;
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>{calls++;return confirmation(event);}});
 t.after(()=>worker.close());
 let closedWhileHeld=false,laterEntered=false,closing:Promise<void>|undefined,later:Promise<void>|undefined;
 await withHomeLock(home,async()=>{
  worker.request();await tick();let closed=false;closing=worker.close().then(()=>{closed=true;});
  await tick();await tick();closedWhileHeld=closed;
  later=outsideHomeLocks(()=>withHomeLock(home,async()=>{laterEntered=true;}));
  await tick();assert.equal(laterEntered,false,'cancelling a reservation never releases the current holder');
 });
 await closing;await later;
 assert.equal(closedWhileHeld,true,'a caller may hold this lock while it waits for Host close before opening Core again');
 assert.equal(calls,0);assert.equal(material.pendingWithdrawals(WORKSPACE).length,1);
 assert.equal(laterEntered,true,'the next real holder still enters after the predecessor releases');
});

test('Core delivery releases the home lock and a late reply preserves restore and a second withdrawal',async t=>{
 const {home,material,entry}=setup(t);let release!:()=>void,started!:()=>void;
 const waiting=new Promise<void>(resolve=>{release=resolve;}),called=new Promise<void>(resolve=>{started=resolve;});
 let calls=0;
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>{
  calls++;if(calls===1){started();await waiting;}return confirmation(event,`receipt-${calls}`);
 }});
 t.after(async()=>{release();await worker.close();});
 await withHomeLock(home,async()=>{material.withdraw(entry.id);worker.request();});
 await called;
 await withHomeLock(home,async()=>{material.restore(entry.id);material.withdraw(entry.id);worker.request();});
 release();await worker.whenIdle();
 // A second coalesced pass must not be lost at the end of the first one.
 const now=material.load(entry.id)!;assert.equal(now.withdrawals?.length,2);
 assert.ok(now.withdrawals![0].restoredAt);assert.equal(now.withdrawals![1].restoredAt,undefined);
 assert.deepEqual(material.pendingWithdrawals(WORKSPACE),[]);assert.equal(calls,2);
 assert.equal(Buffer.from(material.bytes(entry.id,1)).toString(),'v1');
});

test('acknowledgement queues behind a real Save and merges its latest metadata',async t=>{
 const {home,material,entry}=setup(t,true);let release!:()=>void,started!:()=>void;
 const waiting=new Promise<void>(resolve=>{release=resolve;}),called=new Promise<void>(resolve=>{started=resolve;});
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>{started();await waiting;return confirmation(event);}});
 t.after(async()=>{release();await worker.close();});
 await withHomeLock(home,async()=>{material.withdraw(entry.id);});worker.request();await called;
 const saving=withHomeLock(home,async()=>material.save(entry.id,'person v2',1));
 await tick();release();const saved=await saving;assert.equal(saved.ok,true);await worker.whenIdle();
 const now=material.load(entry.id)!;assert.equal(now.current,2);assert.equal(now.versions.length,2);
 assert.equal(Buffer.from(material.bytes(entry.id,2)).toString(),'person v2');
 assert.equal(now.withdrawals![0].version,1);assert.deepEqual(material.pendingWithdrawals(WORKSPACE),[]);
});

test('a lost confirmation leaves the same event pending; reopen retries it without another logical Core record',async t=>{
 const {home,material,entry}=setup(t);const records=new Map<string,string>();let calls=0;
 const record=async(event:{id:string})=>{calls++;const receipt=records.get(event.id)??'receipt-a';records.set(event.id,receipt);if(calls===1)throw new Error('Synthetic response lost after Core commit');return confirmation(event,receipt);};
 await withHomeLock(home,async()=>{material.withdraw(entry.id);});
 const first=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record});
 first.request();await first.whenIdle();assert.equal(calls,1);assert.equal(material.pendingWithdrawals(WORKSPACE).length,1);await first.close();
 const reopened=new MaterialStore(home,{},()=>{});
 const next=createMaterialWithdrawalDelivery({home,material:reopened,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record});t.after(()=>next.close());
 next.request();await next.whenIdle();assert.equal(calls,2);assert.equal(records.size,1);assert.deepEqual(reopened.pendingWithdrawals(WORKSPACE),[]);
});

test('a terminal conflict is durable, visible only in its project and never automatically retried',async t=>{
 const {home,material,entry}=setup(t);await withHomeLock(home,async()=>{material.withdraw(entry.id);});let calls=0;
 const options={home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async()=>{calls++;throw new CoreRefusal('conflict','conflict: Synthetic payload conflict');}};
 const worker=createMaterialWithdrawalDelivery(options);worker.request();await worker.whenIdle();assert.equal(calls,1);await worker.close();
 assert.equal(material.withdrawalConflicts(WORKSPACE).length,1);assert.equal(material.pendingWithdrawals(WORKSPACE).length,1);
 assert.match(withdrawalDeliveryNotices(material,WORKSPACE,'project-a').map(notice=>notice.message).join(' '),/source.md.*review|review.*source.md/i);
 assert.deepEqual(withdrawalDeliveryNotices(material,WORKSPACE,'another-project'),[]);
 const reopened=createMaterialWithdrawalDelivery({...options,material:new MaterialStore(home,{},()=>{})});t.after(()=>reopened.close());
 reopened.request();await reopened.whenIdle();assert.equal(calls,1);
});

test('a terminal conflict does not block another source in the same delivery pass',async t=>{
 const {home,material,entry}=setup(t);
 const other=material.create('project-a','another.md','text/markdown',Buffer.from('other bytes'),'original','person');
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-09T12:00:00.000Z')});
 material.withdraw(entry.id);t.mock.timers.tick(1);material.withdraw(other.id);const calls:string[]=[];
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>{
  calls.push(event.materialId);if(event.materialId===entry.id)throw new CoreRefusal('conflict','conflict: Synthetic payload mismatch');
  return confirmation(event);
 }});t.after(()=>worker.close());
 worker.request();await worker.whenIdle();
 assert.deepEqual(calls,[entry.id,other.id]);assert.deepEqual(material.withdrawalConflicts(WORKSPACE).map(event=>event.materialId),[entry.id]);
 assert.deepEqual(material.pendingWithdrawals(WORKSPACE).map(event=>event.materialId),[entry.id]);
 assert.ok(material.load(other.id)!.withdrawals![0].coreAcknowledgements?.length);
});

test('a generic unique violation is pending and retryable rather than a terminal payload conflict',async t=>{
 const {home,material,entry}=setup(t);material.withdraw(entry.id);let calls=0;
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>{
  calls++;if(calls===1)throw new CoreRefusal('conflict','duplicate key value violates unique constraint');
  return confirmation(event);
 }});
 worker.request();await worker.whenIdle();await worker.close();
 assert.equal(calls,1);assert.equal(material.pendingWithdrawals(WORKSPACE).length,1);assert.deepEqual(material.withdrawalConflicts(WORKSPACE),[]);
 const reopened=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>{calls++;return confirmation(event);}});
 t.after(()=>reopened.close());reopened.request();await reopened.whenIdle();assert.equal(calls,2);assert.deepEqual(material.pendingWithdrawals(WORKSPACE),[]);
});

test('mismatched workspace, event or unsafe receipt confirms nothing',async t=>{
 for(const field of ['workspace','event','receipt']){
  const {home,material,entry}=setup(t);await withHomeLock(home,async()=>{material.withdraw(entry.id);});
  const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>({...confirmation(event),[field]:field==='receipt'?'../unsafe':'wrong'})});
  worker.request();await worker.whenIdle();await worker.close();assert.equal(material.pendingWithdrawals(WORKSPACE).length,1);assert.deepEqual(material.withdrawalConflicts(WORKSPACE),[]);
 }
});

test('read-only and closed workers neither deliver nor recreate a removed home',async t=>{
 const {home,material,entry}=setup(t);material.withdraw(entry.id);let calls=0;
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>false,changed:()=>{},record:async event=>{calls++;return confirmation(event);}});
 worker.request();await worker.whenIdle();await worker.close();rmSync(home,{recursive:true,force:true});worker.request();await tick();assert.equal(calls,0);assert.equal(existsSync(home),false);
});

test('close joins an active delivery and prevents its acknowledgement or a retry after closing',async t=>{
 const {home,material,entry}=setup(t);material.withdraw(entry.id);let release!:()=>void,started!:()=>void,calls=0;
 const waiting=new Promise<void>(resolve=>{release=resolve;}),called=new Promise<void>(resolve=>{started=resolve;});
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>{calls++;started();await waiting;return confirmation(event);}});
 worker.request();await called;let closed=false;const closing=worker.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);
 release();await closing;assert.equal(closed,true);assert.equal(material.pendingWithdrawals(WORKSPACE).length,1);worker.request();await tick();assert.equal(calls,1);
});

test('retry is backed off, never overlaps a slow attempt and stops once its event is confirmed',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {home,material,entry}=setup(t);material.withdraw(entry.id);let calls=0;
 const worker=createMaterialWithdrawalDelivery({home,material,workspace:WORKSPACE,writable:()=>true,changed:()=>{},record:async event=>{calls++;if(calls<3)throw new Error('Synthetic unavailable Core');return confirmation(event);}});t.after(()=>worker.close());
 worker.request();await worker.whenIdle();assert.equal(calls,1);worker.request();await tick();assert.equal(calls,1,'a new notification cannot bypass outage backoff');
 t.mock.timers.tick(999);await tick();assert.equal(calls,1);t.mock.timers.tick(1);await tick();await worker.whenIdle();assert.equal(calls,2);
 t.mock.timers.tick(4999);await tick();assert.equal(calls,2);t.mock.timers.tick(1);await tick();await worker.whenIdle();assert.equal(calls,3);
 assert.deepEqual(material.pendingWithdrawals(WORKSPACE),[]);t.mock.timers.tick(120_000);await tick();assert.equal(calls,3);
});
