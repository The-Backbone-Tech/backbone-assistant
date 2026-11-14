// Controlled recording port for offline reader tests, and real journal/owner composition shared
// by direct-Core tests. This fixture never opens Core, a provider, or a process.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {CoreLink,MaterialReadTentative,MaterialSourceReadRequest,RunHandle} from '../../src/composition/core.ts';
import {createDocumentGateway} from '../../src/composition/document-writes.ts';
import {ConnectorObservations} from '../../src/composition/connector-observations.ts';
import {inActiveHomeLockScope} from '../../src/composition/home-lock.ts';
import {ThreadJournal} from '../../src/composition/thread-journal.ts';
import type {MaterialStore} from '../../src/stub/material.ts';

export const controlledReadHandle:RunHandle={run:'fixture-run',fence:1,secret:'synthetic-fixture-claim'};
export function controlledReadCore(home:string){
 const records:MaterialSourceReadRequest[]=[],committed=new Map<string,{payload:string;receipt:MaterialReadTentative}>();
 const workspace='11111111-1111-4111-8111-111111111111';
 const link={id:{workspace},materialEnforcement:{state:'verified',reason:'Synthetic profile, not native qualification.'},
  admitMaterialConnectorRead:async(_handle:RunHandle,_connection:string,signal:AbortSignal)=>{assert.equal(inActiveHomeLockScope(home),true);signal.throwIfAborted();},
  recordMaterialSourceRead:async(_handle:RunHandle,input:MaterialSourceReadRequest,beforeCommit:(value:MaterialReadTentative)=>undefined,signal:AbortSignal)=>{
   assert.equal(inActiveHomeLockScope(home),true);signal.throwIfAborted();records.push(structuredClone(input));
   const payload=JSON.stringify(input),prior=committed.get(input.readKey);
   if(prior){assert.equal(prior.payload,payload,'the same read key cannot change its payload');assert.equal(beforeCommit(prior.receipt),undefined);return prior.receipt;}
   const receipt={workspace,readKey:input.readKey,episode:randomUUID(),receipt:randomUUID()};
   assert.equal(beforeCommit(receipt),undefined);committed.set(input.readKey,{payload,receipt});return receipt;
  },
  materialReadCommitWitness:async(value:MaterialReadTentative)=>[...committed.values()].some(x=>x.receipt.workspace===value.workspace&&x.receipt.episode===value.episode&&x.receipt.receipt===value.receipt)?'confirmed':'unknown',
 } as unknown as CoreLink;
 return {link,records};
}
export function typedMaterialGateway(options:{home:string;link:CoreLink;handle:RunHandle;material:MaterialStore;projectId?:string;threadId?:string;turnId?:string}){
 const {home}=options,journal=new ThreadJournal(home),observations=new ConnectorObservations(home,journal);
 const gateway=createDocumentGateway({...options,projectId:options.projectId??'project',threadId:options.threadId??'fixture-thread',turnId:options.turnId??'fixture-turn',journal,observations,projectDir:()=>home,crash(){}});
 return {gateway,journal,observations};
}
