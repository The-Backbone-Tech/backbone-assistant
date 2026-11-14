import { hangDetector, waitFor } from '../../../scripts/lib/test-hang.ts';
// Disposable composed journeys: local withdrawal returns before its Core acknowledgement.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {CoreLink,CoreRefusal} from '../src/composition/core.ts';
import {createHost,hostClosed} from '../src/composition/host.ts';
import type {Host,HostOptions} from '../src/composition/host.ts';
import {MaterialStore} from '../src/stub/material.ts';
import {writeJson} from '../src/stub/fsx.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import {grantDoor} from '../src/composition/gateway.ts';
import {b64,freshHome,value} from './helpers.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function eventually(check:()=>boolean|Promise<boolean>){
 try { await waitFor(check,'local withdrawal Core acknowledgement'); return; }
 catch(error) { console.error(error); }
 assert.fail('Expected the bounded local withdrawal delivery to settle.');
}
function context(t:TestContext){
 const home=freshHome(),hosts:Host[]=[];
 const open=(readOnly=false,options:Partial<HostOptions>={})=>{const host=createHost({home,...options,readOnly});hosts.push(host);return host;};
 t.after(async()=>{for(const host of hosts)host.close();await hostClosed(home);});
 return {home,open,store:new MaterialStore(home,{},()=>{})};
}
async function original(host:Host){
 const project=value(await host.call('projects.create',{name:'Synthetic withdrawal',kind:'folder'}));
 const entry=value(await host.call('material.attach',{projectId:project.id,name:'source.md',mediaType:'text/markdown',base64:b64('Immutable original')}));
 return {project,entry};
}
const meta=(home:string,id:string)=>readFileSync(join(home,'material',id,'meta.json'),'utf8');

test('a queued withdrawal cannot deadlock Host close followed by a door grant under the home lock', {timeout:600_000},async t=>{
 const {home,open,store}=context(t),now=Date.parse('2026-11-09T12:00:00.000Z');
 // Isolate delivery: this empty store has no daily work, skills, turns or scheduled admission.
 writeJson(join(home,'memory','.consolidated.json'),{day:new Date(now).toISOString().slice(0,10)});
 const host=open(false,{schedules:{now:()=>now,tickMs:3_600_000}});const {entry}=await original(host);
 assert.deepEqual(await host.call('threads.list',{}),[]);
 const proactive=await host.call('schedules.get',{});assert.equal(proactive.schedules.length,0);assert.equal(proactive.runs.length,0);
 assert.equal(proactive.heartbeat,null);
 assert.equal(existsSync(join(home,'skills')),false);
 await withHomeLock(home,async()=>{
  value(await host.call('material.lifecycle',{id:entry.id,version:1,lifecycle:0,state:'withdrawn'}));
  await new Promise(r=>setImmediate(r));host.close();
  await hangDetector(hostClosed(home),'C3 delivery Host close inside its held home lock'); // Still inside the holder: uncancellable admission cannot pass.
  await grantDoor({home,name:'synthetic-after-close',operations:['outbox.write'],ceiling:3});
 });
 await hostClosed(home);assert.equal(store.load(entry.id)!.withdrawals![0].coreAcknowledgements,undefined);
 const next=open();await next.call('projects.list',{});
 await eventually(()=>!!store.load(entry.id)!.withdrawals![0].coreAcknowledgements?.length);
});

test('withdrawal delivery waits for successful Host opening and does not survive a failed open', {timeout:600_000},async t=>{
 const entered=deferred(),release=deferred(),confirm=CoreLink.prototype.confirmMaterialWithdrawal,grant=CoreLink.prototype.grantPiece;
 t.after(()=>{release.resolve();CoreLink.prototype.confirmMaterialWithdrawal=confirm;CoreLink.prototype.grantPiece=grant;});
 const {home,open,store}=context(t),first=open();const {entry}=await original(first);
 first.close();await hostClosed(home);await withHomeLock(home,async()=>{store.withdraw(entry.id);});
 let calls=0;
 CoreLink.prototype.confirmMaterialWithdrawal=async function(event){calls++;return confirm.call(this,event);};
 CoreLink.prototype.grantPiece=async function(){entered.resolve();await release.promise;throw new Error('Synthetic Host opening failed');};
 const failing=open(false,{harness:'harness-pi'});const opening=failing.call('projects.list',{});const rejected=assert.rejects(opening,/Synthetic Host opening failed/);
 await entered.promise;await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 assert.equal(calls,0,'pending withdrawals must not start while the Host is still opening');
 release.resolve();await rejected;failing.close();await hostClosed(home);
 assert.equal(calls,0);assert.equal(store.load(entry.id)!.withdrawals![0].coreAcknowledgements,undefined);
});

test('Host returns local withdrawal while Core is in flight and preserves restore and a newer withdrawal', {timeout:600_000},async t=>{
 const entered=deferred(),release=deferred(),confirm=CoreLink.prototype.confirmMaterialWithdrawal;
 t.after(()=>{release.resolve();CoreLink.prototype.confirmMaterialWithdrawal=confirm;});
 const {home,open,store}=context(t),host=open();const {project,entry}=await original(host);
 let calls=0,workspace='';
 CoreLink.prototype.confirmMaterialWithdrawal=async function(event){
  calls++;workspace=this.id.workspace;const result=await confirm.call(this,event);
  if(calls===1){entered.resolve();await release.promise;}return result;
 };
 const first=value(await host.call('material.lifecycle',{id:entry.id,version:1,lifecycle:0,state:'withdrawn'}));
 assert.equal(first.withdrawals?.length,1);await entered.promise;
 assert.equal(store.pendingWithdrawals(workspace).length,1,'Core commit alone is not a local acknowledgement');
 assert.match((await host.call('work.now',{projectId:project.id})).notices!.map(notice=>notice.message).join(' '),/confirmation is pending.*source.md/i);
 const restored=value(await host.call('material.lifecycle',{id:entry.id,version:1,lifecycle:first.lifecycle,state:'current'}));
 const second=value(await host.call('material.lifecycle',{id:entry.id,version:1,lifecycle:restored.lifecycle,state:'withdrawn'}));
 assert.equal(second.withdrawals?.length,2);release.resolve();
 await eventually(()=>store.pendingWithdrawals(workspace).length===0);
 const final=store.load(entry.id)!;assert.equal(final.lifecycle,3);assert.equal(final.withdrawals!.length,2);
 assert.ok(final.withdrawals![0].restoredAt);assert.equal(final.withdrawals![1].restoredAt,undefined);
 assert.equal(calls,2);assert.equal(Buffer.from(store.bytes(entry.id,1)).toString(),'Immutable original');
 assert.ok(meta(home,entry.id).includes('coreAcknowledgements'));
 assert.doesNotMatch((await host.call('work.now',{projectId:project.id})).notices!.map(notice=>notice.message).join(' '),/confirmation is pending/);
});

test('a Core commit with lost response stays pending and startup retries the same event and receipt', {timeout:600_000},async t=>{
 const {home,open,store}=context(t),host=open();const {entry}=await original(host);
 const attempted=deferred(),confirm=CoreLink.prototype.confirmMaterialWithdrawal;
 let calls=0,workspace='',receipt='',eventId='';
 CoreLink.prototype.confirmMaterialWithdrawal=async function(event){
  calls++;workspace=this.id.workspace;eventId=event.id;const result=await confirm.call(this,event);receipt=result.receipt;
  attempted.resolve();throw new Error('Synthetic acknowledgement lost after COMMIT');
 };
 t.after(()=>{CoreLink.prototype.confirmMaterialWithdrawal=confirm;});
 value(await host.call('material.lifecycle',{id:entry.id,version:1,lifecycle:0,state:'withdrawn'}));await attempted.promise;
 host.close();await hostClosed(home);assert.equal(calls,1);assert.equal(store.pendingWithdrawals(workspace)[0].id,eventId);
 CoreLink.prototype.confirmMaterialWithdrawal=async function(event){calls++;assert.equal(event.id,eventId);return confirm.call(this,event);};
 const next=open();await next.call('projects.list',{});
 await eventually(()=>store.pendingWithdrawals(workspace).length===0);
 assert.equal(calls,2);const ack=store.load(entry.id)!.withdrawals![0].coreAcknowledgements![0];
 assert.equal(ack.receipt,receipt);assert.equal(ack.event,eventId);
});

test('terminal conflicts survive reopen, remain project-scoped in read-only Now and are not retried', {timeout:600_000},async t=>{
 const {home,open,store}=context(t),host=open();const {project,entry}=await original(host);
 const other=value(await host.call('projects.create',{name:'Other project',kind:'folder'}));
 const confirm=CoreLink.prototype.confirmMaterialWithdrawal;let calls=0,workspace='';
 CoreLink.prototype.confirmMaterialWithdrawal=async function(){calls++;workspace=this.id.workspace;throw new CoreRefusal('conflict','conflict: Synthetic journal conflict');};
 t.after(()=>{CoreLink.prototype.confirmMaterialWithdrawal=confirm;});
 value(await host.call('material.lifecycle',{id:entry.id,version:1,lifecycle:0,state:'withdrawn'}));
 await eventually(()=>!!workspace&&store.withdrawalConflicts(workspace).length===1);
 host.close();await hostClosed(home);const before=meta(home,entry.id);
 const readonly=open(true);await readonly.call('projects.list',{});
 assert.match((await readonly.call('work.now',{projectId:project.id})).notices!.map(notice=>notice.message).join(' '),/source.md.*review is required/);
 assert.doesNotMatch((await readonly.call('work.now',{projectId:other.id})).notices!.map(notice=>notice.message).join(' '),/source.md/);
 readonly.close();await hostClosed(home);assert.equal(meta(home,entry.id),before);assert.equal(calls,1);
 const next=open();await next.call('projects.list',{});await new Promise(r=>setImmediate(r));
 assert.equal(calls,1);assert.equal(store.pendingWithdrawals(workspace).length,1);
});

test('close joins a committed in-flight response without merging it; read-only open leaves it for a writable Host', {timeout:600_000},async t=>{
 const entered=deferred(),release=deferred(),confirm=CoreLink.prototype.confirmMaterialWithdrawal;
 t.after(()=>{release.resolve();CoreLink.prototype.confirmMaterialWithdrawal=confirm;});
 const {home,open,store}=context(t),host=open();const {project,entry}=await original(host);
 let calls=0,workspace='';
 CoreLink.prototype.confirmMaterialWithdrawal=async function(event){calls++;workspace=this.id.workspace;const result=await confirm.call(this,event);entered.resolve();await release.promise;return result;};
 value(await host.call('material.lifecycle',{id:entry.id,version:1,lifecycle:0,state:'withdrawn'}));await entered.promise;
 host.close();let closed=false;const closing=hostClosed(home).then(()=>{closed=true;});
 await new Promise(r=>setImmediate(r));assert.equal(closed,false);release.resolve();await closing;
 assert.equal(store.pendingWithdrawals(workspace).length,1);const before=meta(home,entry.id);
 const readonly=open(true);await readonly.call('projects.list',{});
 assert.match((await readonly.call('work.now',{projectId:project.id})).notices!.map(notice=>notice.message).join(' '),/confirmation is pending/);
 readonly.close();await hostClosed(home);assert.equal(calls,1);assert.equal(meta(home,entry.id),before);
 CoreLink.prototype.confirmMaterialWithdrawal=async function(event){calls++;return confirm.call(this,event);};
 const next=open();await next.call('projects.list',{});await eventually(()=>store.pendingWithdrawals(workspace).length===0);
 assert.equal(calls,2);
});
