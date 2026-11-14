// Home-owned delivery of an already committed local withdrawal. Confirmation is historical
// evidence, never current source authority; no provider operation is performed here.
import type {CapabilityNotice} from '../api.ts';
import {type MaterialStore,type MaterialWithdrawalEvent,MATERIAL_ID} from '../stub/material.ts';
import {CoreRefusal,type MaterialWithdrawalConfirmation} from './core.ts';
import {outsideHomeLocks,withHomeLock} from './home-lock.ts';

interface Options {
 home:string;material:MaterialStore;workspace:string;
 writable():boolean;
 record(event:MaterialWithdrawalEvent):Promise<MaterialWithdrawalConfirmation>;
 changed(project:string):void;
}
const RETRY_MS=[1000,5000,30_000] as const;

export function createMaterialWithdrawalDelivery(options:Options){
 const {home,material,workspace}=options;
 const admission=new AbortController();
 let closed=false,again=false,failures=0,active:Promise<void>|undefined,timer:NodeJS.Timeout|undefined;
 const allowed=()=>!closed&&options.writable();
 const pending=()=>material.pendingWithdrawals(workspace).filter(event=>!material.withdrawalConflict(event.materialId,event.id,workspace));
 async function pass():Promise<'idle'|'more'|'failed'>{
  if(!allowed())return 'idle';
  const events=await withHomeLock(home,async lost=>{
   if(lost.aborted)throw new Error('The home lock was lost.');
   return allowed()?pending():[];
  },undefined,admission.signal);
  let failed=false;
  for(const event of events){
   if(!allowed())return 'idle';
   try{
    // No home lock is held across this await. The transport owns its finite connection/query waits.
    const reply=await options.record(event);
    if(reply.workspace!==workspace||reply.event!==event.id||typeof reply.receipt!=='string'||!MATERIAL_ID.test(reply.receipt))
     {failed=true;continue;}
    const merged=await withHomeLock(home,async lost=>{
     if(lost.aborted)throw new Error('The home lock was lost.');
     if(!allowed())return 'closed';
     // The store reloads here, after every await: Save, restore and later events all survive.
     if(material.acknowledgeWithdrawal(event.materialId,event.id,workspace,reply.receipt))return 'acknowledged';
     return material.withdrawalConflict(event.materialId,event.id,workspace)?'conflict':'unmatched';
    },undefined,admission.signal);
    if(!allowed())return 'idle';
    if(merged==='acknowledged')options.changed(event.projectId);
    else if(merged!=='conflict')failed=true;
   }catch(error){
    if(!allowed())return 'idle';
    if(!(error instanceof CoreRefusal)||error.reason!=='conflict'||!/^conflict: /.test(error.message)){failed=true;continue;}
    let retained=false;
    try{retained=await withHomeLock(home,async lost=>{
     if(lost.aborted)throw new Error('The home lock was lost.');
     return allowed()&&material.recordWithdrawalConflict(event.materialId,event.id,workspace);
    },undefined,admission.signal);}catch{if(!allowed())return 'idle';failed=true;continue;}
    if(retained&&allowed())options.changed(event.projectId);
   }
  }
  return withHomeLock(home,async lost=>{
   if(lost.aborted)throw new Error('The home lock was lost.');
   return !allowed()?'idle':failed?'failed':pending().length?'more':'idle';
  },undefined,admission.signal);
 }
 function start(){
  if(!allowed()||active||timer)return;
  again=false;
  let done!:()=>void;active=new Promise<void>(resolve=>{done=resolve;});
  // Do not borrow a request's async-local home-lock marker for detached network work.
  outsideHomeLocks(()=>setImmediate(async()=>{
   let result:'idle'|'more'|'failed'='idle';
   try{result=await pass();}catch{result=allowed()?'failed':'idle';}
   finally{
    active=undefined;done();
    if(!allowed())return;
    if(result==='failed'){
     const delay=RETRY_MS[Math.min(failures++,RETRY_MS.length-1)];
     timer=setTimeout(()=>{timer=undefined;start();},delay);timer.unref();
    }else{
     failures=0;
     // New events arriving during a pass or its completion cannot lose their notification.
     if(result==='more'||again)start();
    }
   }
  }));
 }
 const whenIdle=async()=>{while(active)await active;};
 return {
  request(){if(!allowed())return;if(active){again=true;return;}start();},
  whenIdle,
  notices:(project:string)=>withdrawalDeliveryNotices(material,workspace,project),
  async close(){closed=true;admission.abort();again=false;if(timer)clearTimeout(timer);timer=undefined;await whenIdle();},
 };
}

/** Person-facing, project-scoped state. A stored receipt never supplies a live-use permission. */
export function withdrawalDeliveryNotices(material:MaterialStore,workspace:string,project:string):CapabilityNotice[]{
 const events=material.pendingWithdrawals(workspace).filter(event=>event.projectId===project);
 const sources=new Map<string,{name:string;conflict:boolean}>();
 for(const event of events){
  const previous=sources.get(event.materialId);
  sources.set(event.materialId,{name:material.load(event.materialId)?.name??'A source',
   conflict:!!previous?.conflict||material.withdrawalConflict(event.materialId,event.id,workspace)});
 }
 return [...sources.entries()].map(([materialId,source])=>source.conflict
  ?{code:'material-withdrawal-conflict',materialId,message:`Withdrawal confirmation for ${source.name} conflicts with saved history; review is required.`}
  :{code:'material-withdrawal-pending',materialId,message:`Withdrawal confirmation is pending for ${source.name}.`});
}
