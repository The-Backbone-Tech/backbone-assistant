// Typed native recall protocol. The caller owns a dedicated bounded, log-policy-checked transport.
// This confirms one read, never complete receiving-run context or future source-use authority.
import type pg from 'pg';
import {verifyMaterialClosure} from './material-closure-status.ts';

export interface TracedKnowledgeRow {
 readonly read_id:string;readonly knowledge_id:string;readonly candidate_id:string;
 /** PostgreSQL int8 text: never coerce to a JavaScript Number. */
 readonly read_seq:string;readonly statement:string;readonly topic:string;
}
type RecallReason='invalid'|'paused'|'cancelled'|'denied'|'stale'|'not_in_run'|'no_identity'|'role';
export class TracedRecallRefusal extends Error {
 readonly reason:RecallReason;
 constructor(reason:RecallReason){
  // No SQL row, native ID, secret, driver error/detail/cause or returned words in an exception.
  super(reason==='invalid'?'Knowledge recall arguments are invalid.':reason==='cancelled'
   ?'Knowledge recall was cancelled; no result was handed over.'
   :'Knowledge recall was not confirmed; no result was handed over.');
  this.name='TracedRecallRefusal';this.reason=reason;
 }
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// The v1 crossing's finite output budget; exceeding it refuses the entire read.
const MAX_TRACED_RESULTS=100;
function boundedSearch(words:readonly string[]|null):boolean {
 if(words===null)return true;
 if(!Array.isArray(words)||words.length>64)return false;
 let total=0;
 for(const word of words){
  if(typeof word!=='string'||word.includes('\0'))return false;
  // PostgreSQL length(text) counts Unicode characters, not UTF-16 code units.
  let characters=0;for(const _ of word)if(++characters>256)return false;
  total+=characters;if(total>8192)return false;
 }
 return true;
}
const readKeys=['candidate_id','knowledge_id','read_id','read_seq','statement','topic'];
const reasons=new Set<RecallReason>(['invalid','paused','cancelled','denied','stale','not_in_run','no_identity','role']);
function sanitized(error:unknown):TracedRecallRefusal {
 if(error instanceof TracedRecallRefusal)return error;
 const prefix=error instanceof Error?error.message.split(':',1)[0]:'';
 return new TracedRecallRefusal(reasons.has(prefix as RecallReason)?prefix as RecallReason:'paused');
}

/** Own a fresh bounded dedicated client; check logging before invoking perform.
 * Always discard the client in finally, on success or error; never return it to a pool or
 * reuse it for another operation. Cleanup must settle before the transport returns rows. */
export type BoundedTracedTransport=(signal:AbortSignal,
 perform:(client:pg.Client)=>Promise<readonly TracedKnowledgeRow[]>)=>Promise<readonly TracedKnowledgeRow[]>;
/** The adapter must obey BoundedTracedTransport's discard-only client contract.
 * The callback verifies the actual closure profile inside its transaction before credentials
 * or the crossing. Never use registration's historical acknowledged override. Transport
 * cleanup is asynchronous: recheck AFTER its finally. */
export async function recallThroughBoundedTransport(transport:BoundedTracedTransport,workspace:string,
 h:{run:string;fence:number;secret:string},words:readonly string[]|null,limit:number,signal:AbortSignal):Promise<readonly TracedKnowledgeRow[]> {
 try{
  const perform=prepareTracedRecall(workspace,h,words,limit,signal);
  const rows=await transport(signal,perform);
  if(signal.aborted)throw new TracedRecallRefusal('cancelled');
  return rows;
 }catch(error){throw sanitized(error);}
}

/** Capture synchronously BEFORE CoreLink awaits opening its dedicated client. The returned
 * closure is private to that one transport call; it grants neither future source use nor a
 * complete receiving-run context. IDs refer to durable native lineage, never inferred text. */
export function prepareTracedRecall(workspace:string,h:{run:string;fence:number;secret:string},
 words:readonly string[]|null,limit:number,signal:AbortSignal): (client:pg.Client)=>Promise<readonly TracedKnowledgeRow[]> {
 if(!uuid.test(workspace)||!h||!uuid.test(h.run)||!Number.isSafeInteger(h.fence)||h.fence<=0
    ||typeof h.secret!=='string'||h.secret.length===0||h.secret.includes('\0')
    ||!Number.isInteger(limit)||limit<1||limit>MAX_TRACED_RESULTS||!boundedSearch(words))
  throw new TracedRecallRefusal('invalid');
 const captured=Object.freeze({workspace,run:h.run,fence:h.fence,secret:h.secret,
  words:words===null?null:Object.freeze([...words]),limit});
 const live=()=>{if(signal.aborted)throw new TracedRecallRefusal('cancelled');};
 live();
 let used=false;
 return async client=>{
  if(used)throw new TracedRecallRefusal('paused');used=true;
  try{
   live();
   await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
   live();
   if((await verifyMaterialClosure(client)).state!=='verified')throw new TracedRecallRefusal('paused');
   live();
   // The transport checks logging before this callback; identity lasts only this transaction.
   await client.query({text:`SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),
    set_config('backbone.run',$3,true),set_config('backbone.secret',$4,true)`,
    values:[captured.workspace,'',captured.run,captured.secret]});
   live();
   const selected=await client.query<Record<string,unknown>>(
    'SELECT read_id,knowledge_id,candidate_id,read_seq,statement,topic FROM gov.recall_knowledge_traced_v1($1::uuid,$2::bigint,$3::text[],$4::integer)',
    [captured.run,captured.fence,captured.words,captured.limit]);
   // Driver rows stay private, even when a later malformed row refuses the whole batch.
   if(selected.command!=='SELECT'||!Array.isArray(selected.rows)||selected.rowCount!==selected.rows.length
      ||selected.rows.length>captured.limit)throw new TracedRecallRefusal('paused');
   const readIds=new Set<string>(),knowledgeIds=new Set<string>();let batchSeq:string|undefined;let resultBytes=0;
   const buffered=selected.rows.map(row=>{
    if(!row||Object.keys(row).sort().join('\0')!==readKeys.join('\0')||
       typeof row.read_id!=='string'||!uuid.test(row.read_id)||readIds.has(row.read_id)||
       typeof row.knowledge_id!=='string'||!uuid.test(row.knowledge_id)||knowledgeIds.has(row.knowledge_id)||
       typeof row.candidate_id!=='string'||!uuid.test(row.candidate_id)||
       typeof row.read_seq!=='string'||row.read_seq.length>19||!/^[1-9][0-9]*$/.test(row.read_seq)||BigInt(row.read_seq)>9223372036854775807n||
       batchSeq!==undefined&&row.read_seq!==batchSeq||
       typeof row.statement!=='string'||row.statement.length===0||typeof row.topic!=='string')
     throw new TracedRecallRefusal('paused');
    resultBytes+=Buffer.byteLength(row.statement,'utf8')+Buffer.byteLength(row.topic,'utf8')+128;
    if(resultBytes>2097152)throw new TracedRecallRefusal('paused');
    readIds.add(row.read_id);knowledgeIds.add(row.knowledge_id);batchSeq=row.read_seq;
    return Object.freeze({read_id:row.read_id,knowledge_id:row.knowledge_id,candidate_id:row.candidate_id,
     read_seq:row.read_seq,statement:row.statement,topic:row.topic});
   });
   live();
   const committed=await client.query('COMMIT');
   if(committed.command!=='COMMIT')throw new TracedRecallRefusal('paused');
   // A confirmed native read is historical evidence, not permission to hand over after Stop.
   live();
   return Object.freeze(buffered);
  }catch(error){
   throw sanitized(error);
  }
  // The dedicated transport discards the client in finally, never returning it to a pool. Do not queue ROLLBACK behind an
  // unresponsive query, retry a lost COMMIT or return tentative rows/IDs through an error.
 };
}
