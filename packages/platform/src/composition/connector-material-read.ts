// One trusted MCP read: retain native identity before dispatch, the observed result before Core,
// and an exact source binding before handover. Recovery below never calls a provider.
import type {MaterialEntry} from '../api.ts';
import type {ConnectorInvocation} from '../ports/harness.ts';
import type {CallAnswer} from '../connectors/client.ts';
import type {OfferedTool} from '../connectors/service.ts';
import {connectorMaterialLabel,isWithdrawn,type MaterialStore} from '../stub/material.ts';
import {sha256} from '../stub/fsx.ts';
import type {CoreLink,RunHandle} from './core.ts';
import {withHomeLock} from './home-lock.ts';
import {ConnectorObservations,type ConnectorObservation,type ConnectorObservationScope,type RetainedConnectorResponse} from './connector-observations.ts';

export interface ConnectorMaterialReadOptions {
  home:string;projectId:string;threadId:string;turnId:string;handle:RunHandle;signal?:AbortSignal;
  /** Host close cancels lock admission; a user Stop may still retain already observed history. */
  closeSignal?:AbortSignal;
  link:Pick<CoreLink,'id'|'materialEnforcement'|'admitMaterialConnectorRead'|'recordMaterialSourceRead'|'materialReadCommitWitness'>;
  material:Pick<MaterialStore,'load'|'bytes'|'freeName'|'retainConnectorObservation'|'registerConnectorObservation'>;
  observations:ConnectorObservations;
}
export interface ConnectorMaterialReadRequest {
  tool:OfferedTool;args:Record<string,unknown>;invocation?:ConnectorInvocation;signal:AbortSignal;
  /** The service rechecks exact current launch/definition/choice synchronously here. */
  stillOffered():boolean;
  /** Exactly one SDK tool call. This is never called by registration-only recovery. */
  perform():Promise<CallAnswer>;
}
export type ConnectorMaterialReadOutcome=
  | {outcome:'READ';source:string;observed:true;status:CallAnswer['status'];text:string;detail?:string;material:{id:string;name:string;version:1;withdrawals:number}}
  | {outcome:'UNKNOWN'|'REFUSED';detail:string};
const UNKNOWN='The connector read is unresolved. Its existing history is kept; it was not sent again and no result was handed over.';
export function connectorObservationScope(options:ConnectorMaterialReadOptions):ConnectorObservationScope{
  return {workspace:options.link.id.workspace,project:options.projectId,thread:options.threadId,turn:options.turnId,run:options.handle.run};
}
function admissionSignal(options:ConnectorMaterialReadOptions,request?:AbortSignal){
  return AbortSignal.any([...(options.signal?[options.signal]:[]),...(options.closeSignal?[options.closeSignal]:[]),...(request?[request]:[])]);
}
function signalFor(options:ConnectorMaterialReadOptions,lost:AbortSignal,request?:AbortSignal){
  return AbortSignal.any([lost,admissionSignal(options,request)]);
}

function retainedResponse(options:ConnectorMaterialReadOptions,observation:ConnectorObservation,answer:CallAnswer):RetainedConnectorResponse{
  if(answer.status==='timed-out')throw new Error('A timeout is not a retained server result.');
  const r=observation.request;
  const result={outcome:'READ',status:answer.status,text:answer.text,...(answer.detail!==undefined?{detail:answer.detail}:{})};
  // Each representation is explicit. JSON keeps NUL and control characters in content without
  // sending an unsupported NUL in PostgreSQL text. None of these hashes claims wire provenance.
  const episodeContent=JSON.stringify({kind:'mcp-observation',version:'1',server:r.serverName,tool:r.tool,args:JSON.parse(r.argsJson),result});
  const name=options.material.freeName(options.projectId,connectorMaterialLabel(r.serverName,r.tool,observation.id));
  return {status:answer.status,text:answer.text,...(answer.detail!==undefined?{detail:answer.detail}:{}),
    material:{name,mediaType:'application/json',body:episodeContent},episodeContent,preparedText:JSON.stringify(result),
    transformation:{kind:'material-mcp-preparation',version:'1',material:'mcp-observation-json-v1',episode:'mcp-observation-json-v1',prepared:'connector-result-json-v1',unicode:'utf8-roundtrip'}};
}
function retainMaterial(options:ConnectorMaterialReadOptions,observation:ConnectorObservation):MaterialEntry{
  const r=observation.request,response=observation.response;
  if(!response)throw new Error('No observed connector response is retained.');
  const entry=options.material.retainConnectorObservation({id:observation.materialId,observation:observation.id,projectId:r.scope.project,
    name:response.material.name,mediaType:response.material.mediaType,body:response.material.body,connection:r.connection,tool:r.tool});
  options.observations.retainMaterial(observation.id,sha256(Buffer.from(response.material.body,'utf8')));
  return entry;
}
function currentMaterial(options:ConnectorMaterialReadOptions,observation:ConnectorObservation):MaterialEntry{
  // Replay verifies every original identity, provenance and byte, preserving later lifecycle state.
  const entry=retainMaterial(options,observation);
  if(entry.projectId!==options.projectId||entry.hidden||entry.held||entry.recovery||entry.unsure||entry.interruptedSave||isWithdrawn(entry)
    ||entry.current!==1||(entry.withdrawals?.length??0)!==0)throw new Error('The retained connector source changed or is unavailable.');
  return entry;
}
async function registerRetained(options:ConnectorMaterialReadOptions,id:string,signal:AbortSignal):Promise<ConnectorObservation>{
  let observation=options.observations.get(id)!;
  if(observation.phase==='discarded')throw new Error('This observation was discarded from agent use. Its history cannot publish a source.');
  if(options.link.materialEnforcement.state!=='verified')throw new Error('Native material source enforcement is not verified.');
  if(!observation.response)throw new Error('No observed response is available for registration.');
  currentMaterial(options,observation);observation=options.observations.get(id)!;
  if(!observation.confirmation){
    // Positive witnesses resolve only retained IDs. Absence is not rollback, nor permission to
    // replay a provider; exact registration can still resolve the original key and payload.
    for(const tentative of observation.tentatives){
      if(await options.link.materialReadCommitWitness(tentative,signal)==='confirmed'){
        options.observations.confirm(id,tentative);break;
      }
    }
    observation=options.observations.get(id)!;
    if(!observation.confirmation){
      const r=observation.request,response=observation.response!;
      const receipt=await options.link.recordMaterialSourceRead(options.handle,{
        project:r.scope.project,material:observation.materialId,version:1,generation:0,readKey:observation.readKey,
        originalSha256:sha256(Buffer.from(response.material.body,'utf8')),transformation:response.transformation,
        sourceKind:'mcp',episodeContent:response.episodeContent,preparedText:response.preparedText,authoredBy:null,connection:r.connection,tool:r.tool
      },receipt=>options.observations.retainTentative(id,receipt),signal);
      options.observations.confirm(id,receipt);
    }
  }
  signal.throwIfAborted();observation=options.observations.get(id)!;
  currentMaterial(options,observation);
  options.material.registerConnectorObservation(observation.materialId,id,observation.material!.sha256);
  return options.observations.get(id)!;
}

export async function readConnectorMaterial(options:ConnectorMaterialReadOptions,input:ConnectorMaterialReadRequest):Promise<ConnectorMaterialReadOutcome>{
  if(!input.invocation)return {outcome:'REFUSED',detail:'The native connector invocation identity is unavailable. Nothing was called.'};
  const tool=structuredClone(input.tool),argsJson=JSON.stringify(input.args),invocation=structuredClone(input.invocation);
  let id:string|undefined;
  try{
    const prepared=await withHomeLock(options.home,async lost=>{
      const signal=signalFor(options,lost,input.signal);signal.throwIfAborted();
      const reserved=options.observations.reserve({scope:connectorObservationScope(options),origin:invocation,
        serverId:tool.serverId,serverName:tool.serverName,connection:tool.connection.id,tool:tool.tool,launch:tool.launch,definition:tool.definition,argsJson});
      id=reserved.observation.id;
      if(reserved.observation.phase!=='reserved')return {existing:reserved.observation};
      if(!reserved.created)return {existing:reserved.observation};
      await options.link.admitMaterialConnectorRead(options.handle,tool.connection.id,signal);
      signal.throwIfAborted();
      if(!input.stillOffered()){
        options.observations.notSent(id,'The exact enabled connector offer changed before dispatch.');
        return {refused:true};
      }
      if(!options.observations.beginDispatch(id))return {existing:options.observations.get(id)!};
      if(signal.aborted||!input.stillOffered()){
        options.observations.notSent(id,'The turn stopped or its exact enabled offer changed before the provider call.');
        return {refused:true};
      }
      // Invoke with no await after the final local checks. Return the promise INSIDE an object:
      // the home lock is released before waiting on the remote response.
      let work:Promise<CallAnswer>;
      try{work=input.perform();}catch(error){work=Promise.reject(error);}
      return {pending:Promise.resolve(work).then(answer=>({answer}),error=>({error}))};
    },60_000,admissionSignal(options,input.signal));
    if('refused' in prepared)return {outcome:'REFUSED',detail:'The connector changed before dispatch. Nothing was called.'};
    if('pending' in prepared&&prepared.pending){
      const received=await prepared.pending;
      await withHomeLock(options.home,async()=>{
        if('error' in received||!received.answer.observed){
          options.observations.unknown(id!,'No verified tool result was retained after dispatch.');return;
        }
        options.observations.retainResponse(id!,retainedResponse(options,options.observations.get(id!)!,received.answer));
      },60_000,options.closeSignal); // A user Stop may retain history; Host shutdown never waits for a closing lock holder.
    }
    return await withHomeLock(options.home,async lost=>{
      const signal=signalFor(options,lost,input.signal),observation=options.observations.get(id!)!;
      if(!observation.response)return {outcome:'UNKNOWN',detail:UNKNOWN};
      signal.throwIfAborted();
      const confirmed=await registerRetained(options,id!,signal);
      // Historical confirmation alone is insufficient: revalidate the real run and receiving
      // connection before delivering even a cached/positively witnessed result.
      await options.link.admitMaterialConnectorRead(options.handle,tool.connection.id,signal);
      signal.throwIfAborted();const entry=currentMaterial(options,confirmed),response=confirmed.response!;
      return {outcome:'READ',source:`mcp:${tool.connection.id}/${tool.tool}`,observed:true,status:response.status,text:response.text,
        ...(response.detail!==undefined?{detail:response.detail}:{}),material:{id:entry.id,name:entry.name,version:1,withdrawals:0}};
    },60_000,admissionSignal(options,input.signal));
  }catch{
    // A source/provider/COMMIT outcome cannot be reconstructed from an exception's wording.
    // Durable phases preserve exactly where work stopped; no catch path repeats the provider.
    if(id){
      try{
        const unsent=await withHomeLock(options.home,async()=>{
          const value=options.observations.get(id!);
          if(value?.phase!=='reserved'||value.dispatched)return false;
          const earlierUnresolved=options.observations.forRun(connectorObservationScope(options))
            .some(other=>other.id!==id&&other.dispatched&&!['confirmed','not-sent'].includes(other.phase));
          options.observations.notSent(id!,'Native admission did not complete before any provider dispatch.');
          return !earlierUnresolved;
        },60_000,options.closeSignal);
        if(unsent)return {outcome:'REFUSED',detail:'Native connector admission did not complete. Nothing was called.'};
      }catch{ /* Unverifiable or uncertain history remains UNKNOWN, never proof of no call. */ }
    }
    return {outcome:'UNKNOWN',detail:UNKNOWN};
  }finally{if(id)options.observations.release(id);}
}

/** Registration-only continuation for the original run. A pending or unknown provider call
 * never becomes a queue item. Callers decide how to display unresolved work or finish the run. */
export async function recoverConnectorMaterial(options:ConnectorMaterialReadOptions,id?:string):Promise<{pending:boolean}>{
  return withHomeLock(options.home,async lost=>{
    const signal=signalFor(options,lost);let pending=false;
    for(const observation of options.observations.forRun(connectorObservationScope(options))){
      if((id!==undefined&&observation.id!==id)||!observation.response||observation.phase==='discarded')continue;
      if(observation.phase==='confirmed'&&options.material.load(observation.materialId)?.observation?.state==='registered')continue;
      try{await registerRetained(options,observation.id,signal);}catch{pending=true;}
    }
    return {pending};
  },60_000,admissionSignal(options));
}

/** Private gateway of the original turn. Protocol start is allowed only for a fresh producer;
 * resuming old text history cannot prove which native MCP calls may already have left. */
export function createConnectorMaterialGateway(options:ConnectorMaterialReadOptions){
  const current=()=>connectorObservationScope(options);
  return {
    readObserved:(request:ConnectorMaterialReadRequest)=>readConnectorMaterial(options,request),
    async prepareProtocol(resumed:boolean){
      await withHomeLock(options.home,async lost=>{
        signalFor(options,lost).throwIfAborted();
        if(resumed){
          if(!options.observations.hasProtocolHistory(current())||options.observations.hasDispatchHistory(current()))
            throw new Error('This interrupted turn cannot restart connector dispatch from reconstructed text history. Its retained results are recovered locally; unresolved calls are not sent again.');
        }else options.observations.startProtocol(current());
      },60_000,admissionSignal(options));
    },
    reserveBatch:(callIds:readonly string[])=>withHomeLock(options.home,async lost=>{
      signalFor(options,lost).throwIfAborted();
      if(!options.observations.hasProtocolHistory(current()))throw new Error('Connector dispatch protocol has not started for this turn.');
      return options.observations.allocatePiBatch(current(),callIds);
    },60_000,admissionSignal(options)),
    recover:()=>recoverConnectorMaterial(options),
    pending:()=>options.observations.forRun(current()).some(value=>value.phase!=='discarded'&&!!value.response&&(!value.confirmation||options.material.load(value.materialId)?.observation?.state==='pending')),
  };
}
