// Person-only local decisions for retained MCP observations. No dispatch, replacement run,
// receipt-as-grant, or automatic Stop/resume repair lives here.
import {lstatSync} from 'node:fs';
import {join} from 'node:path';
import type {ConnectorReadResolution,Receipt,WorkNow} from '../api.ts';
import type {Gateway} from '../stub/harness.ts';
import {holdsCredential} from '../memory/learn.ts';
import {isWithdrawn,type MaterialStore} from '../stub/material.ts';
import {CoreRefusal,type CoreLink,type RunHandle} from './core.ts';
import {ConnectorObservations,type ConnectorObservation,type ConnectorObservationScope} from './connector-observations.ts';
import {recoverConnectorMaterial} from './connector-material-read.ts';
import {createDocumentGateway,turnWrites,type WriteCrashPoint} from './document-writes.ts';
import {withHomeLock,outsideHomeLocks} from './home-lock.ts';
import {verifiedRecoveredWrites} from './recovered-writes.ts';
import {unconfirmedCustody} from './thread-custody.ts';
import type {StoredThread,ThreadJournal} from './thread-journal.ts';

export interface ConnectorReadDecisionDeps {
 home:string;material:MaterialStore;journal:ThreadJournal;core():Promise<CoreLink>;
 threads:Map<string,StoredThread>;projectDir(id:string):string;crash(point:WriteCrashPoint):void;
 currentPiece():string|null;busy(threadId:string):boolean;saveThread(thread:StoredThread):Promise<void>;
 hasCheckpoint(turnId:string):boolean;
 narrow(link:CoreLink,thread:StoredThread,turnId:string,inner:Gateway):Gateway;
}
type Decision={id:string;verdict:'reconcile'|'discard'};
const unavailable=(detail:string):Receipt<never>=>({ok:false,reason:'NOT_AVAILABLE',outcome:'REFUSED',detail});
const unresolved=(detail:string):Receipt<never>=>({ok:false,reason:'UNKNOWN_OUTCOME_HELD',outcome:'UNKNOWN',detail});
const finalEffect=(status:string)=>['succeeded','failed','denied','cancelled'].includes(status);

export function createConnectorReadDecisions(deps:ConnectorReadDecisionDeps){
 let observations=new ConnectorObservations(deps.home,deps.journal);
 let writing=0;
 const handles=new Map<string,RunHandle>(),actions=new Set<Promise<unknown>>(),shutdown=new AbortController();
 async function core(){
  shutdown.signal.throwIfAborted();
  let abort!:()=>void;
  const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(shutdown.signal.reason);shutdown.signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([deps.core(),cancelled]);}
  finally{shutdown.signal.removeEventListener('abort',abort);}
 }
 function original(observation:ConnectorObservation){
  const s=observation.request.scope,thread=deps.threads.get(s.thread);
  const turn=thread&&[...thread.turns,...thread.sideTurns].find(turn=>turn.id===s.turn);
  return thread&&thread.summary.projectId===s.project&&turn?{thread,turn}:undefined;
 }
 function ready(observation:ConnectorObservation,link:CoreLink){
  shutdown.signal.throwIfAborted();
  if(observation.request.scope.workspace!==link.id.workspace)throw new Error('The retained observation belongs to another workspace.');
  const owner=original(observation);
  if(!owner)throw new Error('The original conversation and turn are unavailable. Retained history is unchanged.');
  const {run,...carrier}=observation.request.scope;
  if(observations.originalRun(carrier)!==run)throw new Error('The original run could not be identified unambiguously.');
  if(deps.busy(owner.thread.summary.id))throw new Error('The original conversation still has an active worker. Try this person decision after it stops.');
  return owner;
 }
 function verifyLocalForDiscard(observation:ConnectorObservation){
  const root=lstatSync(join(deps.home,'material'),{throwIfNoEntry:false});
  if(root&&(!root.isDirectory()||root.isSymbolicLink()))throw new Error('The retained source directory cannot be verified.');
  const exists=lstatSync(join(deps.home,'material',observation.materialId),{throwIfNoEntry:false});
  if(!exists){
   if(observation.material||observation.tentatives.length||observation.confirmation)
    throw new Error('The expected retained original is missing. Its registration history stays unresolved.');
   return; // No original/native attempt is recorded. This does not establish Core absence.
  }
  const r=observation.request,response=observation.response;
  if(!response)throw new Error('The existing original has no exact retained response for verification.');
  // Retain's replay path checks immutable identity/provenance/bytes while preserving every
  // later lifecycle decision. Never call its creation path for a missing original on discard.
  const entry=deps.material.retainConnectorObservation({id:observation.materialId,observation:observation.id,projectId:r.scope.project,
   name:response.material.name,mediaType:response.material.mediaType,body:response.material.body,connection:r.connection,tool:r.tool});
  return entry;
 }
 async function admittedHandle(observation:ConnectorObservation,link:CoreLink,signal:AbortSignal):Promise<RunHandle>{
  const {run}=observation.request.scope,connection=observation.request.connection,cached=handles.get(run);
  if(cached){
   try{await link.admitMaterialConnectorRead(cached,connection,signal);return cached;}
   catch(error){
    // Ordinary errors and uncertain/denied admission never trigger a second claim. A native
    // stale refusal is definitive non-admission; the exact-run claim still verifies standing.
    if(!(error instanceof CoreRefusal)||error.reason!=='stale')throw error;
   }
  }
  signal.throwIfAborted();
  const handle=await link.claimMaterialRecovery(run,deps.currentPiece(),signal);
  if(handle.run!==run)throw new Error('Recovery did not return the original run.');
  handles.set(run,handle);
  await link.admitMaterialConnectorRead(handle,connection,signal);
  return handle;
 }
 async function closeOriginal(observation:ConnectorObservation,link:CoreLink,signal:AbortSignal):Promise<boolean>{
  try{
   const owner=ready(observation,link),s=observation.request.scope,handle=handles.get(s.run);
   if(!handle||deps.hasCheckpoint(s.turn))return false;
   // Do not assume that a native run has only one local turn. Another retained carrier
   // scope makes this bounded person's decision insufficient evidence to close the run.
   if(deps.journal.read().some(event=>{
    if(event.kind!=='mcp.read.reserved')return false;
    const other=event.observation.request.scope;
    return other.workspace===s.workspace&&other.run===s.run
     &&(other.project!==s.project||other.thread!==s.thread||other.turn!==s.turn);
   }))return false;
   const pending=observations.forRun(s).some(value=>value.phase!=='discarded'&&value.phase!=='not-sent'
    &&(value.phase!=='confirmed'||deps.material.load(value.materialId)?.observation?.state!=='registered'));
   if(pending)return false;
   // Authenticate the actual holder. System visibility alone is not closure authority.
   const current=await link.readBounded<{id:string}>(link.runOf(handle),
    "SELECT id FROM app.runs WHERE id = $1 AND status = 'running' AND fence = $2 AND sec.current_run() = $1",[s.run,handle.fence],signal);
   signal.throwIfAborted();if(current.rows.length!==1||current.rows[0].id!==s.run)return false;
   const effects=await link.readBounded<{status:string}>(link.system(),'SELECT status FROM app.effects WHERE run_id = $1',[s.run],signal);
   signal.throwIfAborted();if(effects.rows.some(row=>!finalEffect(row.status)))return false;
   // These maintained owners only require read/system. Give that existing interface a
   // dedicated bounded, cancellable transport; do not route close through the shared pool.
   const bounded={system:()=>link.system(),read:(actor:Parameters<CoreLink['read']>[0],sql:string,params:unknown[]=[])=>link.readBounded(actor,sql,params,signal)} as unknown as CoreLink;
   const writes=await turnWrites(bounded,s.run,s.turn),durable=await verifiedRecoveredWrites(bounded,writes,deps.material,s.project);
   if(durable.pending||durable.stop||await unconfirmedCustody(deps.home,s.thread,s.run,s.turn,s.project,writes))return false;
   signal.throwIfAborted();if(deps.busy(s.thread)||deps.hasCheckpoint(s.turn))return false;
   const outcome=owner.turn.status==='done'?'succeeded':'failed';
   const finished=await link.readBounded<{finish_run:string}>(link.runOf(handle),'SELECT gov.finish_run($1::uuid,$2::bigint,$3::text)',[s.run,handle.fence,outcome],signal);
   signal.throwIfAborted();if(finished.rows.length!==1||finished.rows[0].finish_run!==outcome)return false;
   handles.delete(s.run);
   owner.turn.work.endedAt??=new Date().toISOString();await deps.saveThread(owner.thread);
   return true;
  }catch{return false;} // Closure is separate; a local decision never proves the run closed.
 }
 async function decide(input:Decision):Promise<Receipt<ConnectorReadResolution>>{
  let effectsStarted=false;
  if(!input||typeof input.id!=='string'||!input.id||!['reconcile','discard'].includes(input.verdict))
   return {ok:false,reason:'INVALID',outcome:'REFUSED',detail:'Choose reconcile or discard for an exact connector observation.'};
  if(shutdown.signal.aborted)return unavailable('The host is closing. Retained connector history is unchanged by this attempt.');
  try{
   // Core/open may need the home lock. Resolve it before acquiring this action's lock.
   const link=await core();shutdown.signal.throwIfAborted();
   return await withHomeLock(deps.home,async lost=>{
    writing++;
    try{
    const signal=AbortSignal.any([lost,shutdown.signal]);signal.throwIfAborted();
    const observation=observations.get(input.id);
    if(!observation)return {ok:false,reason:'NOT_FOUND',outcome:'REFUSED',detail:'No such retained connector observation.'};
    if(observation.request.scope.workspace!==link.id.workspace)return unavailable('The retained observation belongs to another workspace.');
    if(deps.busy(observation.request.scope.thread))return unavailable('The original conversation still has an active worker. Try again after it stops.');
    if(input.verdict==='discard'){
     const entry=verifyLocalForDiscard(observation);signal.throwIfAborted();
     effectsStarted=true;
     if(entry&&!isWithdrawn(entry))deps.material.withdraw(entry.id);
     signal.throwIfAborted();observations.discard(observation.id);
    }else{
     ready(observation,link);
     if(observation.phase==='discarded')return unavailable('This observation was discarded from agent use. Its retained history cannot be reconciled into a source.');
     if(!observation.response)return unavailable('No verified connector response was retained. The original call will not be sent again.');
     if(link.materialEnforcement.state!=='verified')return unavailable('Native material source enforcement is not verified. Retained history stays pending.');
     effectsStarted=true;
     const handle=await admittedHandle(observation,link,signal);
     const s=observation.request.scope;
     await recoverConnectorMaterial({home:deps.home,material:deps.material,observations,projectId:s.project,threadId:s.thread,turnId:s.turn,
      handle,link,signal,closeSignal:shutdown.signal},observation.id);
     // A historical confirmation is never receiving authority, including lost-reply recovery.
     await link.admitMaterialConnectorRead(handle,observation.request.connection,signal);signal.throwIfAborted();
     const updated=observations.get(observation.id),entry=deps.material.load(observation.materialId);
     if(!updated?.confirmation)return unresolved('The original registration remains unresolved. Retained response and receipt history are kept; no provider was called.');
     if(updated.phase!=='confirmed'||entry?.observation?.state!=='registered'||entry.hidden||entry.held||entry.unsure||entry.recovery||entry.interruptedSave
      ||entry.current!==1||(entry.withdrawals?.length??0)!==0||isWithdrawn(entry))
      return unavailable('The retained observation remains unresolved or unavailable. No provider was called.');
    }
    const updated=observations.get(observation.id)!;
    return {ok:true,value:{id:observation.id,state:input.verdict==='discard'?'discarded':'reconciled',
     registration:updated.confirmation?'confirmed':'unknown',runClosed:await closeOriginal(updated,link,signal)}};
    }finally{writing--;}
   },60_000,shutdown.signal);
  }catch(error){
   // Neither a transport error nor a missing receipt is negative proof. Avoid private provider,
   // path, SQL and credential text in this person-facing receipt.
   const detail='This connector decision could not be completed. Existing response, source and receipt history are kept; no provider was called.';
   return effectsStarted&&(!(error instanceof CoreRefusal)||error.reason==='paused')?unresolved(detail):unavailable(detail);
  }
 }
 const whenIdle=async()=>{while(actions.size)await Promise.allSettled([...actions]);};
 return {
  get observations(){return observations;},
  // Host bootstrap only, before any producer gateway is active. A person waiting for Core
  // owns no journal state yet and must not prevent the owner's initial durable replay.
  reload(){if(writing)throw new Error('A connector decision still owns its write scope.');observations=new ConnectorObservations(deps.home,deps.journal);},
  originalRun:(scope:Omit<ConnectorObservationScope,'run'>)=>observations.originalRun(scope),
  gateway(link:CoreLink,handle:RunHandle,threadId:string,turnId:string,projectId:string,signal:AbortSignal,checkpointRecovery?:true):Gateway{
   const thread=deps.threads.get(threadId);if(!thread)throw new Error('The original gateway conversation is unavailable.');
   handles.set(handle.run,{...handle});
   return deps.narrow(link,thread,turnId,createDocumentGateway({home:deps.home,link,handle,threadId,turnId,projectId,signal,
    material:deps.material,journal:deps.journal,observations,projectDir:deps.projectDir,crash:deps.crash,closeSignal:shutdown.signal,
    task:thread.task,...(checkpointRecovery?{checkpointRecovery}:{})}));
  },
  resolveRead(input:Decision):Promise<Receipt<ConnectorReadResolution>>{
   // A person action is independent of a producer's aborted signal and inherited lock scope.
   const work=outsideHomeLocks(()=>decide(input));actions.add(work);
   void work.finally(()=>actions.delete(work));return work;
  },
  // The caller resolves Core before any home lock. This projection never waits on open.
  needsYou(link:CoreLink,project:string):WorkNow['needsYou']{
   return observations.forProject(link.id.workspace,project).filter(value=>value.phase!=='discarded'&&value.phase!=='not-sent'
    &&(value.phase!=='confirmed'||deps.material.load(value.materialId)?.observation?.state!=='registered')).map(value=>{
     const requested=observations.requestedAt(value.id);
     const at=requested?new Date(requested).toISOString().replace('T',' ').replace('Z',' UTC'):'local request time unavailable';
     const tool=holdsCredential(value.request.tool,[])?'(withheld tool)':value.request.tool;
     return {kind:'connector-read',
     observationId:value.id,threadId:value.request.scope.thread,...(value.material?{materialId:value.materialId}:{}),title:`Connector read · ${value.request.serverName} · ${tool}`,
     detail:`${at} · …${value.id.slice(-8)}. ${value.response?'A connector response is retained. Reconcile its original registration or discard it from agent use.':'This connector call has no verified retained response. It will not be sent again. You can discard it from agent use.'}`,
     canReconcile:!!value.response&&!!original(value)&&!deps.busy(value.request.scope.thread)&&link.materialEnforcement.state==='verified'};
    });
  },
  whenIdle,
  async close(){shutdown.abort(new Error('The host is closing.'));await whenIdle();},
 };
}
