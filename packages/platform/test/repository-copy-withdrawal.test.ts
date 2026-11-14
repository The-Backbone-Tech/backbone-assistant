// Retained file copies use material identity; this never enables live repository access.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {hangDetector,waitFor} from '../../../scripts/lib/test-hang.ts';
import type {Turn} from '../src/api.ts';
import {CoreLink,type MaterialSourceReadRequest} from '../src/composition/core.ts';
import {runHarnessTurn} from '../src/composition/harness-turn.ts';
import {hostClosed} from '../src/composition/host.ts';
import {replay,taintedReads} from '../src/composition/withdrawal.ts';
import {MaterialStore} from '../src/stub/material.ts';
import type {TurnOutcome} from '../src/ports/harness.ts';
import {b64,freshDir,open,value} from './helpers.ts';
import {typedMaterialGateway} from './fixtures/typed-material-gateway.ts';

for(const failure of ['unavailable','lost acknowledgement'] as const)test(`repository-file copy withdrawal survives ${failure} without reviving old input`,{timeout:600_000},async t=>{
 const repository=freshDir('retained-repository-'),path=join(repository,'docs','terms.md');
 execFileSync('git',['init','--quiet',repository]);mkdirSync(join(repository,'docs'));
 const original='Repository terms: payment is due in thirty days.\n';writeFileSync(path,original);
 execFileSync('git',['-C',repository,'add','docs/terms.md']);
 const {home,host}=open(),material=new MaterialStore(home,{},()=>{});
 const project=value(await host.call('projects.create',{name:'Retained repository copy',kind:'folder'}));
 const entry=value(await host.call('material.attach',{projectId:project.id,name:'terms.md',relativePath:'docs/terms.md',mediaType:'text/markdown',base64:b64(readFileSync(path))}));
 writeFileSync(path,'The external repository changed after the deliberate copy.\n');
 const record=CoreLink.prototype.recordMaterialSourceRead,registered:MaterialSourceReadRequest[]=[];
 CoreLink.prototype.recordMaterialSourceRead=async function(...args){
  if(args[1].material===entry.id)registered.push(structuredClone(args[1]));
  return record.apply(this,args);
 };
 t.after(()=>{CoreLink.prototype.recordMaterialSourceRead=record;});
 const link=await CoreLink.open({home});let closed=false;
 t.after(async()=>{if(!closed)await link.close();host.close();await hostClosed(home);});
 const task=await link.createTask('Read the retained repository copy'),handle=await link.startRun(task);
 const {gateway}=typedMaterialGateway({home,link,handle,material,projectId:project.id,threadId:'copy-thread',turnId:'copy-turn'});
 const confirm=CoreLink.prototype.confirmMaterialWithdrawal;
 let attempts=0,event='',firstReceipt='',workspace='',attempted!:()=>void;
 const attemptedPromise=new Promise<void>(resolve=>{attempted=resolve;});
 CoreLink.prototype.confirmMaterialWithdrawal=async function(withdrawal){
  attempts++;event=withdrawal.id;workspace=this.id.workspace;
  if(failure==='lost acknowledgement')firstReceipt=(await confirm.call(this,withdrawal)).receipt;
  attempted();throw new Error(`Synthetic ${failure}; no local confirmation`);
 };
 t.after(()=>{CoreLink.prototype.confirmMaterialWithdrawal=confirm;});
 const turn:Turn={id:'copy-turn',side:false,user:{text:'Read the retained terms.',attachments:[],at:''},work:{startedAt:'',harness:'controlled-copy',steps:[]},effects:[],status:'running'};
 let derivedCalls=0,consumer!:Promise<TurnOutcome>;
 await runHarnessTurn({material,projectId:project.id,threadId:'copy-thread',gateway,writeDelayMs:0,
  signal:new AbortController().signal,history:[],resumed:false,progress(){},
  route:{kind:'native',provider:'codex',baseUrl:'',model:'controlled',label:'controlled',credential:null},
  credential:async()=>{throw new Error('No provider credential in this control');},
  memory:{recall:()=>({instructions:'',text:'',sources:[],record:{used:[],instructions:false,skills:[],remembered:[]}}),propose:async()=>{derivedCalls++;return 'Unexpected adoption';}},
  harness:{specificationVersion:'v1',id:'controlled-copy',label:'Controlled source consumer',start(_request,{tools}){
   const outcome=(async()=>{
    const read=await tools.read(entry.name);assert.ok(read);assert.equal(read.text,original);
    assert.equal(registered.length,1);assert.equal(registered[0].authoredBy,null);
    assert.equal(registered[0].sourceKind,'file');assert.equal(registered[0].generation,0);
    const historical:Turn={...structuredClone(turn),status:'done',answer:{text:'Derived from the retained terms.',files:[]}};
    assert.equal(replay([historical],material,project.id).answered.has(turn.id),true);
    const withdrawn=value(await host.call('material.lifecycle',{id:entry.id,version:1,lifecycle:0,state:'withdrawn'}));
    assert.equal(withdrawn.withdrawals?.length,1);await hangDetector(attemptedPromise,'repository-copy withdrawal delivery attempt');
    assert.equal(material.pendingWithdrawals(workspace).length,1);
    assert.equal(await tools.read(entry.name),null,'pending withdrawal blocks the supported source consumer');
    assert.notEqual(tools.stillGranted!([{materialId:entry.id,projectId:project.id,version:1,withdrawals:0}]),true);
    assert.match(await tools.proposeMemory!({text:'A derived assertion'}),/withdrawn/);
    assert.equal(derivedCalls,0,'derived material is refused before the memory owner is called');
    assert.equal(taintedReads(historical,id=>material.load(id)).length,1);
    assert.equal(replay([historical],material,project.id).answered.size,0);
    const inspected=value(await host.call('material.read',{id:entry.id}));assert.equal(inspected.text,original);
    const restored=value(await host.call('material.lifecycle',{id:entry.id,version:1,lifecycle:withdrawn.lifecycle,state:'current'}));
    assert.equal(restored.withdrawals?.length,1);
    assert.equal(replay([historical],material,project.id).answered.size,0,'restore cannot revive pre-withdrawal derived context');
    await assert.rejects(gateway.read({materialId:entry.id,name:entry.name,version:1,withdrawals:0,profile:'harness'}),/unavailable/);
    return {status:'done' as const,answer:'Source use stopped.',usage:{input:0,output:0}};
   })();consumer=outcome;return {events:(async function*(){})(),outcome,stop(){},steer(){}};
  }},
 },turn,[]);
 assert.ok(consumer,'the real source consumer was started');await consumer;
 assert.equal(registered.length,1);
 await link.close();closed=true;host.close();await hostClosed(home);
 const attemptsBefore=attempts;assert.ok(attemptsBefore>=1);const exactEvent=event;
 CoreLink.prototype.confirmMaterialWithdrawal=async function(withdrawal){
  attempts++;assert.equal(withdrawal.id,exactEvent);const receipt=await confirm.call(this,withdrawal);
  if(firstReceipt)assert.equal(receipt.receipt,firstReceipt);return receipt;
 };
 const next=open(home).host;t.after(async()=>{next.close();await hostClosed(home);});await next.call('projects.list',{});
 await waitFor(()=>material.pendingWithdrawals(workspace).length===0,'repository-copy withdrawal acknowledgement after reopen');
 assert.equal(attempts,attemptsBefore+1,'reopen retries only the immutable withdrawal event');
 assert.equal(registered.length,1,'delivery never repeats source registration on any CoreLink after reopen');
 const final=material.load(entry.id)!;assert.equal(final.withdrawals!.length,1);assert.ok(final.withdrawals![0].coreAcknowledgements?.length);
 assert.equal(value(await next.call('material.read',{id:entry.id})).text,original);
 assert.equal(readFileSync(path,'utf8'),'The external repository changed after the deliberate copy.\n');
 const fresh=await CoreLink.open({home});
 try{
  const newTask=await fresh.createTask('Read the restored copy'),newHandle=await fresh.startRun(newTask);
  const newGateway=typedMaterialGateway({home,link:fresh,handle:newHandle,material,projectId:project.id,threadId:'new-copy-thread',turnId:'new-copy-turn'}).gateway;
  await assert.rejects(newGateway.read({materialId:entry.id,name:entry.name,version:1,withdrawals:0,profile:'harness'}),/unavailable/);
  const read=await newGateway.read({materialId:entry.id,name:entry.name,version:1,withdrawals:1,profile:'harness'});
  assert.equal(read.text,original);assert.equal(read.withdrawals,1);assert.equal(registered.length,2,'a deliberate new-generation read is observed by the same spy');
 }finally{await fresh.close();next.close();await hostClosed(home);}
 assert.equal(registered.length,2,'closing the reopened Host did not register another source');
});
