// Private observation history, not a provider queue or a source/authority grant. The trusted
// composition owns native call identity, redaction, current admission and every actual dispatch.
import {randomBytes,randomUUID} from 'node:crypto';
import type {MaterialReadTentative} from './core.ts';
import {inActiveHomeLockScope} from './home-lock.ts';
import {sha256} from '../stub/fsx.ts';
import type {ConnectorInvocation} from '../ports/harness.ts';
export type {ConnectorInvocation} from '../ports/harness.ts';

export interface ConnectorObservationScope {workspace:string;project:string;thread:string;turn:string;run:string}
export interface ConnectorObservationRequest {
 scope:ConnectorObservationScope;origin:ConnectorInvocation;
 serverId:string;serverName:string;connection:string;tool:string;launch:string;definition:string;argsJson:string;
}
export interface RetainedConnectorResponse {
 status:'complete'|'partial'|'failed'|'rate-limited';text:string;detail?:string;
 material:{name:string;mediaType:string;body:string};
 episodeContent:string;preparedText:string;transformation:Record<string,unknown>;
}
export interface ConnectorObservation {
 id:string;request:ConnectorObservationRequest;materialId:string;readKey:string;
 phase:'reserved'|'dispatched'|'not-sent'|'unknown'|'response'|'material'|'tentative'|'confirmed'|'discarded';
 dispatched:boolean;response?:RetainedConnectorResponse;material?:{version:1;sha256:string};
 tentatives:MaterialReadTentative[];confirmation?:MaterialReadTentative;detail?:string;
}
interface Batch {id:string;scope:ConnectorObservationScope;callIds:string[]}
export type ConnectorObservationEvent=
 | {kind:'mcp.protocol.started';threadId:string;scope:ConnectorObservationScope;version:'1'}
 | {kind:'mcp.batch.reserved';threadId:string;batch:Batch}
 | {kind:'mcp.read.reserved';threadId:string;observation:ConnectorObservation}
 | {kind:'mcp.read.dispatched';threadId:string;id:string}
 | {kind:'mcp.read.discarded';threadId:string;id:string}
 | {kind:'mcp.read.not-sent'|'mcp.read.unknown';threadId:string;id:string;detail:string}
 | {kind:'mcp.read.response';threadId:string;id:string;response:RetainedConnectorResponse}
 | {kind:'mcp.read.material';threadId:string;id:string;material:{version:1;sha256:string}}
 | {kind:'mcp.read.tentative'|'mcp.read.confirmed';threadId:string;id:string;receipt:MaterialReadTentative};
export interface ConnectorObservationJournal {
 append(event:ConnectorObservationEvent):ConnectorObservationEvent&{at:string};
 read():readonly unknown[];
}
const HEX=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HISTORY='Connector read history could not be verified. Existing records are kept; no connector was called.';
const copy=<T>(value:T):T=>structuredClone(value);
function text(value:unknown,max=8192):value is string{return typeof value==='string'&&value.length>0&&Buffer.byteLength(value,'utf8')<=max&&!value.includes('\0')&&Buffer.from(value).toString('utf8')===value;}
function scope(value:ConnectorObservationScope):ConnectorObservationScope{
 if(!value||!['workspace','project','thread','turn','run'].every(key=>text(value[key as keyof ConnectorObservationScope],512)))throw new Error('Invalid connector observation scope.');
 return {workspace:value.workspace,project:value.project,thread:value.thread,turn:value.turn,run:value.run};
}
const sameScope=(a:ConnectorObservationScope,b:ConnectorObservationScope)=>JSON.stringify(scope(a))===JSON.stringify(scope(b));
const sameReceipt=(a:MaterialReadTentative,b:MaterialReadTentative)=>a.workspace===b.workspace&&a.readKey===b.readKey&&a.episode===b.episode&&a.receipt===b.receipt;
function request(value:ConnectorObservationRequest):ConnectorObservationRequest{
 if(!value||!value.origin||!['pi','codex'].includes(value.origin.engine)||!text(value.origin.namespace,2048)||!text(value.origin.callId,512))throw new Error('A connector read requires unambiguous native invocation identity.');
 if(![value.serverId,value.serverName,value.connection,value.tool].every(value=>text(value))||!HEX.test(value.launch)||!HEX.test(value.definition))throw new Error('Invalid connector observation request.');
 if(typeof value.argsJson!=='string')throw new Error('A connector request requires its exact JSON arguments.');
 const args=JSON.parse(value.argsJson);
 if(!args||typeof args!=='object'||Array.isArray(args)||JSON.stringify(args)!==value.argsJson)throw new Error('Connector arguments must be the retained JSON object, serialized once.');
 return {scope:scope(value.scope),origin:{engine:value.origin.engine,namespace:value.origin.namespace,callId:value.origin.callId},serverId:value.serverId,serverName:value.serverName,connection:value.connection,tool:value.tool,launch:value.launch,definition:value.definition,argsJson:value.argsJson};
}
function identity(value:ConnectorObservationRequest):string{
 const s=value.scope,o=value.origin;
 return sha256(JSON.stringify(['mcp-observation-v1',s.workspace,s.project,s.thread,s.turn,s.run,o.engine,o.namespace,o.callId]));
}
function response(value:RetainedConnectorResponse):RetainedConnectorResponse{
 if(!value||!['complete','partial','failed','rate-limited'].includes(value.status)||typeof value.text!=='string'||(value.detail!==undefined&&typeof value.detail!=='string')
  ||!value.material||!text(value.material.name)||!text(value.material.mediaType,512)||typeof value.material.body!=='string'
  ||typeof value.episodeContent!=='string'||typeof value.preparedText!=='string'||!value.transformation||typeof value.transformation!=='object'||Array.isArray(value.transformation)
  ||!text(value.transformation.kind,512)||!text(value.transformation.version,512))throw new Error('A retained connector response requires exact observed result renderings.');
 const retained=copy(value);
 if([retained.text,retained.detail??'',retained.material.body,retained.episodeContent,retained.preparedText].some(value=>Buffer.from(value,'utf8').toString('utf8')!==value))throw new Error('Connector response text must roundtrip UTF8 before retention.');
 return retained;
}

/** One instance per owned home. Durable history is rebuilt independently of thread projections,
 * including deleted threads; absence of an in-memory owner never resumes a provider call. */
export class ConnectorObservations {
 private readonly observations=new Map<string,ConnectorObservation>();
 private readonly requestedTimes=new Map<string,string>();
 private readonly batches=new Map<string,Batch>();
 private readonly started=new Set<string>();
 private readonly created=new Set<string>();
 private readonly active=new Set<string>();
 private failed=false;
 private readonly home:string;
 private readonly journal:ConnectorObservationJournal;
 constructor(home:string,journal:ConnectorObservationJournal){
  this.home=home;this.journal=journal;
  try{
   for(const raw of journal.read()){
    if(!raw||typeof raw!=='object')continue;
    const event=raw as {kind?:unknown};
    if(typeof event.kind==='string'&&event.kind.startsWith('mcp.')){
     this.apply(raw as ConnectorObservationEvent);
     this.retainRequestedAt(raw as ConnectorObservationEvent,(raw as {at?:unknown}).at);
    }
   }
  }catch{this.failed=true;}
 }
 get problem():string|undefined{return this.failed?HISTORY:undefined;}
 private ready(){if(this.failed)throw new Error(HISTORY);}
 private writer(){this.ready();if(!inActiveHomeLockScope(this.home))throw new Error('Connector observation changes require the data folder lock.');}
 private require(id:string){this.ready();const value=this.observations.get(id);if(!value)throw new Error('No such connector observation.');return value;}
 private mutable(id:string){const value=this.require(id);if(value.phase==='discarded')throw new Error('This connector observation was discarded from agent use; its history cannot be revived.');return value;}
 private append(event:ConnectorObservationEvent){
  this.writer();
  // apply validates fully before replacing one immutable state view. In particular, retaining
  // tentative IDs never clones or rewrites the earlier large response while Core's head is held.
  this.apply(copy(event));
  try{
   const written=this.journal.append(copy(event));
   if(!written||typeof written.at!=='string')throw new Error('Connector history requires a synchronous durable journal append.');
   this.retainRequestedAt(event,written.at);
  }
  catch(error){this.failed=true;throw error;} // A torn or uncertain append forbids all later dispatch in this instance.
 }
 /** Display-only local reservation time. Neither a request field nor an identity input. */
 private retainRequestedAt(event:ConnectorObservationEvent,at:unknown){
  if(event.kind!=='mcp.read.reserved')return;
  if(typeof at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at)||!Number.isFinite(Date.parse(at)))throw new Error(HISTORY);
  this.requestedTimes.set(event.observation.id,at);
 }
 private apply(event:ConnectorObservationEvent){
  if(event.kind==='mcp.protocol.started'){
   const s=scope(event.scope);
   if(event.version!=='1'||event.threadId!==s.thread)throw new Error(HISTORY);
   this.started.add(JSON.stringify(s));return;
  }
  if(event.kind==='mcp.batch.reserved'){
   const b=event.batch,s=scope(b?.scope);
   if(!UUID.test(b.id)||event.threadId!==s.thread||!Array.isArray(b.callIds)||!b.callIds.length||b.callIds.some(id=>!text(id,512))||new Set(b.callIds).size!==b.callIds.length||this.batches.has(b.id))throw new Error(HISTORY);
   this.batches.set(b.id,copy({...b,scope:s}));return;
  }
  if(event.kind==='mcp.read.reserved'){
   const value=event.observation,r=request(value?.request);
   if(value.id!==identity(r)||event.threadId!==r.scope.thread||!UUID.test(value.materialId)||!HEX.test(value.readKey)||value.phase!=='reserved'||value.dispatched!==false
    ||!Array.isArray(value.tentatives)||value.tentatives.length||value.response||value.material||value.confirmation||this.observations.has(value.id))throw new Error(HISTORY);
   if([...this.observations.values()].some(other=>other.materialId===value.materialId||other.readKey===value.readKey))throw new Error(HISTORY);
   if(r.origin.engine==='pi'){
    const batch=this.batches.get(r.origin.namespace);
    if(!batch||!sameScope(batch.scope,r.scope)||!batch.callIds.includes(r.origin.callId))throw new Error('The Pi call is not in its durable native batch.');
   }
   this.observations.set(value.id,copy({...value,request:r}));return;
  }
  const prior=this.require(event.id),value={...prior,tentatives:[...prior.tentatives]};
  if(event.threadId!==value.request.scope.thread)throw new Error(HISTORY);
  if(value.phase==='discarded'&&event.kind!=='mcp.read.discarded')throw new Error(HISTORY);
  switch(event.kind){
   case 'mcp.read.discarded':value.phase='discarded';break;
   case 'mcp.read.dispatched':if(value.phase!=='reserved'||!this.started.has(JSON.stringify(value.request.scope)))throw new Error(HISTORY);value.phase='dispatched';value.dispatched=true;break;
   case 'mcp.read.not-sent':
    if(!['reserved','dispatched'].includes(value.phase)||!text(event.detail))throw new Error(HISTORY);
    value.phase='not-sent';value.detail=event.detail;break;
   case 'mcp.read.unknown':
    if(value.phase!=='dispatched'||!text(event.detail))throw new Error(HISTORY);
    value.phase='unknown';value.detail=event.detail;break;
   case 'mcp.read.response':if(value.phase!=='dispatched')throw new Error(HISTORY);value.response=response(event.response);value.phase='response';break;
   case 'mcp.read.material':
    if(value.phase!=='response'||event.material.version!==1||!HEX.test(event.material.sha256)||event.material.sha256!==sha256(Buffer.from(value.response!.material.body,'utf8')))throw new Error(HISTORY);
    value.material=copy(event.material);value.phase='material';break;
   case 'mcp.read.tentative':case 'mcp.read.confirmed':{
    const r=event.receipt;
    if(!value.material||!['material','tentative','confirmed'].includes(value.phase)||r.workspace!==value.request.scope.workspace||r.readKey!==value.readKey||!UUID.test(r.episode)||!UUID.test(r.receipt))throw new Error(HISTORY);
    if(event.kind==='mcp.read.tentative'){
     if(value.phase==='confirmed'&&(r.episode!==value.confirmation!.episode||r.receipt!==value.confirmation!.receipt))throw new Error(HISTORY);
     if(!value.tentatives.some(prior=>sameReceipt(prior,r)))value.tentatives.push(copy(r));
     if(value.phase!=='confirmed')value.phase='tentative';
    }else{
     if(!value.tentatives.some(prior=>sameReceipt(prior,r))||(value.confirmation&&!sameReceipt(value.confirmation,r)))throw new Error(HISTORY);
     value.confirmation=copy(r);value.phase='confirmed';
    }break;
   }
   default:throw new Error(HISTORY);
  }
  this.observations.set(value.id,value);
 }
 allocatePiBatch(current:ConnectorObservationScope,callIds:readonly string[]):string{
  this.writer();const batch={id:randomUUID(),scope:scope(current),callIds:[...callIds]};
  this.append({kind:'mcp.batch.reserved',threadId:batch.scope.thread,batch});return batch.id;
 }
 /** Called only for a fresh producer, before its engine starts. Adding this while resuming a
  * legacy turn would erase uncertainty about old calls; missing history never proves no call. */
 startProtocol(current:ConnectorObservationScope):void{
  this.writer();const s=scope(current);if(this.started.has(JSON.stringify(s)))return;
  this.append({kind:'mcp.protocol.started',threadId:s.thread,scope:s,version:'1'});
 }
 reserve(input:ConnectorObservationRequest):{observation:ConnectorObservation;created:boolean}{
  this.writer();const r=request(input),id=identity(r),prior=this.observations.get(id);
  if(prior){if(JSON.stringify(prior.request)!==JSON.stringify(r))throw new Error('This native invocation already names another connector request.');return {observation:copy(prior),created:false};}
  const observation:ConnectorObservation={id,request:r,materialId:randomUUID(),readKey:randomBytes(32).toString('hex'),phase:'reserved',dispatched:false,tentatives:[]};
  this.append({kind:'mcp.read.reserved',threadId:r.scope.thread,observation});this.created.add(id);return {observation:copy(observation),created:true};
 }
 beginDispatch(id:string):boolean{
  this.writer();const value=this.require(id);
  if(!this.started.has(JSON.stringify(value.request.scope)))throw new Error('This turn has no verified connector dispatch history. An earlier call cannot be ruled out.');
  if(value.phase!=='reserved')return false;
  if(!this.created.has(id))throw new Error('An earlier reserved invocation is not resumed as a provider call.');
  if([...this.observations.values()].some(other=>other.id!==id&&sameScope(other.request.scope,value.request.scope)&&other.dispatched&&!['confirmed','not-sent'].includes(other.phase)&&!this.active.has(other.id)))
   throw new Error('An earlier connector call in this turn is unresolved. It will not be sent again.');
  this.append({kind:'mcp.read.dispatched',threadId:value.request.scope.thread,id});this.active.add(id);return true;
 }
 retainResponse(id:string,retained:RetainedConnectorResponse):void{this.writer();const value=this.mutable(id),next=response(retained);if(value.response&&JSON.stringify(value.response)===JSON.stringify(next))return;this.append({kind:'mcp.read.response',threadId:value.request.scope.thread,id,response:next});}
 retainMaterial(id:string,digest:string):void{this.writer();const value=this.mutable(id);if(value.material?.version===1&&value.material.sha256===digest)return;this.append({kind:'mcp.read.material',threadId:value.request.scope.thread,id,material:{version:1,sha256:digest}});}
 retainTentative(id:string,receipt:MaterialReadTentative):undefined{this.writer();const value=this.mutable(id);if(value.tentatives.some(prior=>sameReceipt(prior,receipt)))return undefined;this.append({kind:'mcp.read.tentative',threadId:value.request.scope.thread,id,receipt:copy(receipt)});return undefined;}
 confirm(id:string,receipt:MaterialReadTentative):void{this.writer();const value=this.mutable(id);if(value.confirmation&&sameReceipt(value.confirmation,receipt))return;this.append({kind:'mcp.read.confirmed',threadId:value.request.scope.thread,id,receipt:copy(receipt)});this.active.delete(id);}
 notSent(id:string,detail:string):void{const value=this.require(id);this.append({kind:'mcp.read.not-sent',threadId:value.request.scope.thread,id,detail});this.active.delete(id);}
 unknown(id:string,detail:string):void{const value=this.require(id);this.append({kind:'mcp.read.unknown',threadId:value.request.scope.thread,id,detail});this.active.delete(id);}
 /** Explicit person decision only. Terminal withholding preserves even an acknowledged Core
  * registration; it supplies no negative proof and performs no material/Core/provider effect. */
 discard(id:string):void{
  this.writer();const value=this.require(id);
  if(value.phase==='discarded'){this.active.delete(id);return;}
  this.append({kind:'mcp.read.discarded',threadId:value.request.scope.thread,id});this.active.delete(id);
 }
 /** Ephemeral ownership only. A retained response can still need registration after this exits. */
 release(id:string):void{this.active.delete(id);}
 /** Time assigned by the durable local journal, never supplied by the model/caller. */
 requestedAt(id:string):string|undefined{this.ready();return this.requestedTimes.get(id);}
 get(id:string):ConnectorObservation|undefined{this.ready();const value=this.observations.get(id);return value&&copy(value);}
 forRun(current:ConnectorObservationScope):ConnectorObservation[]{this.ready();return [...this.observations.values()].filter(value=>sameScope(value.request.scope,current)).map(copy);}
 /** Private history for a person's project view, including discarded/deleted-thread records. */
 forProject(workspace:string,project:string):ConnectorObservation[]{
  this.ready();if(!text(workspace,512)||!text(project,512))throw new Error('Invalid connector observation project scope.');
  return [...this.observations.values()].filter(value=>value.request.scope.workspace===workspace&&value.request.scope.project===project).map(copy);
 }
 /** Reconciliation can name only the one retained original run. Missing or ambiguous history
  * never selects a substitute run, and discarded observations still contribute their history. */
 originalRun(current:Omit<ConnectorObservationScope,'run'>):string|undefined{
  this.ready();
  if(!current||!['workspace','project','thread','turn'].every(key=>text(current[key as keyof typeof current],512)))throw new Error('Invalid connector observation turn scope.');
  const runs=new Set([...this.observations.values()].filter(value=>{
   const s=value.request.scope;return s.workspace===current.workspace&&s.project===current.project&&s.thread===current.thread&&s.turn===current.turn;
  }).map(value=>value.request.scope.run));
  if(runs.size>1)throw new Error('Connector observation history is ambiguous: this turn names more than one original run.');
  return runs.values().next().value;
 }
 hasDispatchHistory(current:ConnectorObservationScope):boolean{return this.forRun(current).some(value=>value.dispatched);}
 hasProtocolHistory(current:ConnectorObservationScope):boolean{this.ready();return this.started.has(JSON.stringify(scope(current)));}
}
