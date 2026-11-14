// Private Store/journal and controlled native crossings only: no Core open, SQL or provider.
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createConnectorReadDecisions} from '../src/composition/connector-read-decisions.ts';
import {CoreRefusal,type CoreLink,type RunHandle} from '../src/composition/core.ts';
import {ThreadJournal,type StoredThread} from '../src/composition/thread-journal.ts';
import {withHomeLock,outsideHomeLocks,inActiveHomeLockScope} from '../src/composition/home-lock.ts';
import {MaterialStore,isWithdrawn} from '../src/stub/material.ts';
import {sha256,writeJson} from '../src/stub/fsx.ts';

const uuid=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
async function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'connector-read-decision-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const material=new MaterialStore(home,{},()=>{}),journal=new ThreadJournal(home);
 const thread={summary:{id:'thread',projectId:'project',title:'Original work',pinned:false,unread:false,archived:false,running:false,updatedAt:'2026-11-09T00:00:00Z'},
  turns:[{id:'turn',side:false,user:{text:'Question',attachments:[],at:'2026-11-09T00:00:00Z'},work:{startedAt:'2026-11-09T00:00:00Z',steps:[],harness:'synthetic'},effects:[],status:'stopped' as const}],sideTurns:[],clientKeys:[],task:'task'} satisfies StoredThread;
 mkdirSync(join(home,'threads'));writeJson(join(home,'threads','thread.json'),thread);
 const threads=new Map<string,StoredThread>([['thread',thread]]),handle:RunHandle={run:uuid('3'),fence:1,secret:'synthetic-original-claim'};
 const state={admissions:0,claims:0,records:0,finishes:0,busy:false,checkpoint:false,paused:false,admissionError:undefined as Error|undefined,
  claimError:undefined as Error|undefined,recordError:undefined as Error|undefined,effects:[] as {id:string;status:string;operation:string;key?:string;run?:string;args:unknown}[],saves:0,
  coreWait:undefined as Promise<CoreLink>|undefined,admissionOnce:undefined as Error|undefined};
 const link={id:{workspace:uuid('1')},get materialEnforcement(){return {state:state.paused?'paused':'verified'};},
  async admitMaterialConnectorRead(_h:RunHandle,_c:string,signal:AbortSignal){assert.equal(inActiveHomeLockScope(home),true);signal.throwIfAborted();state.admissions++;
   if(state.admissionOnce){const error=state.admissionOnce;state.admissionOnce=undefined;throw error;}if(state.admissionError)throw state.admissionError;},
  async claimMaterialRecovery(run:string,_piece:string|null,signal:AbortSignal){assert.equal(run,handle.run);assert.equal(inActiveHomeLockScope(home),true);signal.throwIfAborted();state.claims++;if(state.claimError)throw state.claimError;return {...handle,fence:2};},
  async recordMaterialSourceRead(_h:RunHandle,input:{readKey:string},retain:(receipt:unknown)=>undefined,signal:AbortSignal){state.records++;signal.throwIfAborted();if(state.recordError)throw state.recordError;
   const receipt={workspace:uuid('1'),readKey:input.readKey,episode:uuid('4'),receipt:uuid('5')};assert.equal(retain(receipt),undefined);return receipt;},
  async materialReadCommitWitness(){return 'unknown';},system:()=>({}),runOf:()=>({}),
  async readBounded(_actor:unknown,sql:string,params:unknown[],signal:AbortSignal){assert.equal(inActiveHomeLockScope(home),true);signal.throwIfAborted();
   if(sql.includes('SELECT gov.finish_run')){assert.equal(params[0],handle.run);state.finishes++;return {rows:[{finish_run:params[2]}]};}
   return {rows:sql.includes('FROM app.runs')?[{id:handle.run,status:'running',fence:1}]:structuredClone(sql.includes("operation = 'workspace.write_document'")?state.effects.filter(row=>row.operation==='workspace.write_document'):state.effects)};},
  async read(){assert.fail('Person decision closure must not use the shared pool read');},
  async finishRun(){assert.fail('Person decision closure must not use the shared pool finish');},
 } as unknown as CoreLink;
 const decisions=createConnectorReadDecisions({home,material,journal,core:()=>state.coreWait??Promise.resolve(link),threads,projectDir:()=>home,crash(){},currentPiece:()=>null,
  busy:()=>state.busy,async saveThread(){state.saves++;},hasCheckpoint:()=>state.checkpoint,narrow:(_link,_thread,_turn,inner)=>inner});
 async function seed(stage:'response'|'material'|'tentative'|'confirmed'|'unknown'='response',callId='native-call-1',keepActive=false,tool='lookup'){
  return withHomeLock(home,async()=>{
   const observations=decisions.observations,scope={workspace:uuid('1'),project:'project',thread:'thread',turn:'turn',run:handle.run};observations.startProtocol(scope);
   const {observation}=observations.reserve({scope,origin:{engine:'codex',namespace:'["native-thread","native-turn"]',callId},serverId:'server',serverName:'Server',connection:uuid('2'),tool,launch:'a'.repeat(64),definition:'b'.repeat(64),argsJson:'{"q":"same"}'});
   observations.beginDispatch(observation.id);
   if(stage==='unknown'){observations.unknown(observation.id,'No verified response.');return observations.get(observation.id)!;}
   const body=JSON.stringify({answer:'Exact retained response'});
   observations.retainResponse(observation.id,{status:'complete',text:'Exact retained response',material:{name:`Observed-${callId}.json`,mediaType:'application/json',body},episodeContent:body,preparedText:'Exact retained response',transformation:{kind:'fixture',version:'1'}});
   if(stage!=='response'){
    material.retainConnectorObservation({id:observation.materialId,observation:observation.id,projectId:'project',name:`Observed-${callId}.json`,mediaType:'application/json',body,connection:uuid('2'),tool});
    observations.retainMaterial(observation.id,sha256(body));
    if(stage==='tentative'||stage==='confirmed'){
     const receipt={workspace:uuid('1'),readKey:observation.readKey,episode:uuid('4'),receipt:uuid('5')};observations.retainTentative(observation.id,receipt);
     if(stage==='confirmed'){observations.confirm(observation.id,receipt);material.registerConnectorObservation(observation.materialId,observation.id,sha256(body));}
    }
   }
   if(!keepActive)observations.release(observation.id);return observations.get(observation.id)!;
  });
 }
 const cache=()=>decisions.gateway(link,handle,'thread','turn','project',AbortSignal.abort('old producer stopped'));
 return {home,material,journal,thread,threads,handle,state,link,decisions,seed,cache};
}

test('only an explicit reconcile registers retained history, using a fresh signal and the exact original run',async t=>{
 const f=await fixture(t),o=await f.seed();f.cache();
 assert.equal(f.state.records,0);assert.equal((await f.decisions.needsYou(f.link,'project'))[0].canReconcile,true);
 const result=await f.decisions.resolveRead({id:o.id,verdict:'reconcile'});assert.equal(result.ok,true);
 if(result.ok)assert.deepEqual(result.value,{id:o.id,state:'reconciled',registration:'confirmed',runClosed:true});
 assert.equal(f.state.claims,0);assert.equal(f.state.records,1);assert.ok(f.state.admissions>=1);
 assert.equal(f.material.load(o.materialId)?.observation?.state,'registered');assert.equal(f.state.finishes,1);
});
test('an uncached original is claimed once; an unresolved claim never registers or fabricates a replacement run',async t=>{
 const f=await fixture(t),o=await f.seed();f.state.claimError=new Error('Synthetic lost claim COMMIT');
 const refused=await f.decisions.resolveRead({id:o.id,verdict:'reconcile'});assert.equal(refused.ok,false);
 if(!refused.ok){assert.equal(refused.outcome,'UNKNOWN');assert.equal(refused.reason,'UNKNOWN_OUTCOME_HELD');assert.equal(refused.detail.includes('Synthetic lost claim'),false);}
 assert.equal(f.state.claims,1);assert.equal(f.state.records,0);assert.equal(f.decisions.observations.get(o.id)?.phase,'response');
 f.state.claimError=undefined;assert.equal((await f.decisions.resolveRead({id:o.id,verdict:'reconcile'})).ok,true);assert.equal(f.state.claims,2);
});
test('busy, absent original turn, workspace mismatch and paused enforcement each refuse before claiming or recording',async t=>{
 for(const condition of ['busy','turn','workspace','paused'] as const){
  const f=await fixture(t),o=await f.seed();
  if(condition==='busy')f.state.busy=true;if(condition==='turn')f.thread.turns=[];
  if(condition==='workspace')(f.link.id as {workspace:string}).workspace=uuid('9');if(condition==='paused')f.state.paused=true;
  const result=await f.decisions.resolveRead({id:o.id,verdict:'reconcile'});assert.equal(result.ok,false,condition);assert.equal(f.state.claims,0,condition);assert.equal(f.state.records,0,condition);
 }
});
test('cached admission errors cannot widen into a new claim, including an ordinary error named stale',async t=>{
 for(const error of [new Error('stale'),new CoreRefusal('paused','Transport outcome unknown'),new CoreRefusal('denied','Mandate revoked')]){
  const f=await fixture(t),o=await f.seed();f.cache();f.state.admissionError=error;
  assert.equal((await f.decisions.resolveRead({id:o.id,verdict:'reconcile'})).ok,false);assert.equal(f.state.claims,0);assert.equal(f.state.records,0);
 }
});
test('discard retains confirmed receipt and bytes, withdraws locally once, and stays terminal after reopen',async t=>{
 const f=await fixture(t),o=await f.seed('confirmed'),before=f.material.bytes(o.materialId,1);f.cache();
 const result=await f.decisions.resolveRead({id:o.id,verdict:'discard'});assert.equal(result.ok,true);
 if(result.ok){assert.equal(result.value.registration,'confirmed');assert.equal(result.value.state,'discarded');}
 assert.equal(f.state.records,0);assert.equal(isWithdrawn(f.material.load(o.materialId)!),true);assert.deepEqual(f.material.bytes(o.materialId,1),before);
 assert.deepEqual(f.decisions.observations.get(o.id)?.confirmation,o.confirmation);
 assert.equal((await f.decisions.resolveRead({id:o.id,verdict:'discard'})).ok,true);assert.equal(f.material.load(o.materialId)?.withdrawals?.length,1);
 f.decisions.reload();assert.equal(f.decisions.observations.get(o.id)?.phase,'discarded');assert.equal((await f.decisions.resolveRead({id:o.id,verdict:'reconcile'})).ok,false);
});
test('discard before material/native attempt creates no original, and UNKNOWN is never reported as Core absence',async t=>{
 for(const stage of ['response','unknown'] as const){const f=await fixture(t),o=await f.seed(stage);
  const result=await f.decisions.resolveRead({id:o.id,verdict:'discard'});assert.equal(result.ok,true);
  if(result.ok){assert.equal(result.value.registration,'unknown');assert.equal(result.value.runClosed,false);}
  assert.equal(f.material.load(o.materialId),null);assert.equal(f.state.records,0);assert.equal(f.state.claims,0);
 }
});
test('missing or contradictory expected originals preserve pending evidence instead of creating a source on discard',async t=>{
 for(const mode of ['missing','contradictory'] as const){const f=await fixture(t),o=await f.seed('tentative');
  if(mode==='missing')rmSync(join(f.home,'material',o.materialId),{recursive:true,force:true});
  else{const path=join(f.home,'material',o.materialId,'versions','1');chmodSync(path,0o600);writeFileSync(path,'changed');}
  const result=await f.decisions.resolveRead({id:o.id,verdict:'discard'});assert.equal(result.ok,false);assert.equal(f.decisions.observations.get(o.id)?.phase,'tentative');assert.equal(f.state.records,0);
  if(!result.ok)assert.equal(result.outcome,'REFUSED','proven missing/corrupt local preflight did not start a decision');
 }
});
test('checkpoint and another unresolved observation each prevent run closure without blocking a local discard',async t=>{
 for(const blocker of ['checkpoint','observation','effect'] as const){const f=await fixture(t),o=await f.seed('confirmed');f.cache();
  if(blocker==='checkpoint')f.state.checkpoint=true;
  if(blocker==='observation')await f.seed('unknown','native-other-call');
  if(blocker==='effect')f.state.effects=[{id:'effect',status:'unknown',operation:'other.operation',args:{}}];
  const result=await f.decisions.resolveRead({id:o.id,verdict:'discard'});assert.equal(result.ok,true);if(result.ok)assert.equal(result.value.runClosed,false);assert.equal(f.state.finishes,0);
 }
});
test('close cancels queued person lock admission and joins it without releasing another holder',async t=>{
 const f=await fixture(t),o=await f.seed();let waiting!:Promise<unknown>;
 await outsideHomeLocks(()=>withHomeLock(f.home,async()=>{
  waiting=outsideHomeLocks(()=>f.decisions.resolveRead({id:o.id,verdict:'reconcile'}));
  await new Promise<void>(resolve=>setImmediate(resolve));await outsideHomeLocks(()=>f.decisions.close());
  assert.equal(inActiveHomeLockScope(f.home),true);assert.equal(f.state.records,0);assert.equal(f.state.claims,0);
 }));
 assert.equal((await waiting as {ok:boolean}).ok,false);await f.decisions.whenIdle();
});
test('close cancels waiting for Core without cancelling its independent owner or waiting for it to open',async t=>{
 const f=await fixture(t),o=await f.seed();let open!:(link:CoreLink)=>void;f.state.coreWait=new Promise(resolve=>open=resolve);
 const work=f.decisions.resolveRead({id:o.id,verdict:'reconcile'});await new Promise<void>(resolve=>setImmediate(resolve));
 await f.decisions.close();assert.equal((await work).ok,false);assert.equal(f.state.records,0);assert.equal(f.state.claims,0);
 open(f.link);await f.state.coreWait;assert.equal(f.state.records,0);
});
test('discard remains possible for deleted-thread history and paused enforcement; reconcile cannot substitute a new turn',async t=>{
 const f=await fixture(t),o=await f.seed('material');f.threads.delete('thread');f.state.paused=true;
 assert.equal((await f.decisions.resolveRead({id:o.id,verdict:'reconcile'})).ok,false);
 const result=await f.decisions.resolveRead({id:o.id,verdict:'discard'});assert.equal(result.ok,true);
 if(result.ok)assert.deepEqual(result.value,{id:o.id,state:'discarded',registration:'unknown',runClosed:false});
 assert.equal(f.state.records,0);assert.equal(f.state.claims,0);assert.equal(isWithdrawn(f.material.load(o.materialId)!),true);
});
test('a native stale cached holder permits only an exact original-run claim and fresh admission',async t=>{
 const f=await fixture(t),o=await f.seed();f.cache();f.state.admissionOnce=new CoreRefusal('stale','The native holder is stale.');
 assert.equal((await f.decisions.resolveRead({id:o.id,verdict:'reconcile'})).ok,true);assert.equal(f.state.claims,1);assert.equal(f.state.records,1);
});
test('one explicit reconcile cannot register a second retained observation in the same original run',async t=>{
 const f=await fixture(t),first=await f.seed('response','native-first-call',true),second=await f.seed('response','native-second-call');f.decisions.observations.release(first.id);f.cache();
 const result=await f.decisions.resolveRead({id:first.id,verdict:'reconcile'});assert.equal(result.ok,true);if(result.ok)assert.equal(result.value.runClosed,false);
 assert.equal(f.state.records,1);assert.equal(f.decisions.observations.get(second.id)?.phase,'response');assert.equal(f.material.load(second.materialId),null);
 assert.equal(f.state.finishes,0);
});
test('confirmed history still needs native admission before a pending original can be published',async t=>{
 const f=await fixture(t),o=await f.seed('confirmed');f.cache();
 const path=join(f.home,'material',o.materialId,'meta.json'),entry=f.material.load(o.materialId)!;
 writeJson(path,{...entry,observation:{id:o.id,state:'pending'}});
 f.state.admissionError=new CoreRefusal('denied','The receiving connection is no longer visible.');
 assert.equal((await f.decisions.resolveRead({id:o.id,verdict:'reconcile'})).ok,false);assert.equal(f.material.load(o.materialId)?.observation?.state,'pending');assert.equal(f.state.records,0);
 f.state.admissionError=undefined;const result=await f.decisions.resolveRead({id:o.id,verdict:'reconcile'});assert.equal(result.ok,true);
 assert.equal(f.material.load(o.materialId)?.observation?.state,'registered');assert.equal(f.state.records,0,'the confirmed receipt is not registered as a new episode');
 assert.deepEqual(f.decisions.observations.get(o.id)?.confirmation,o.confirmation);
});
test('a response-less unknown call and an invalid decision never cause native registration or a claim',async t=>{
 const f=await fixture(t),o=await f.seed('unknown');assert.equal((await f.decisions.resolveRead({id:o.id,verdict:'reconcile'})).ok,false);
 const invalid=await f.decisions.resolveRead({id:o.id,verdict:'automatic' as 'reconcile'});assert.equal(invalid.ok,false);if(!invalid.ok)assert.equal(invalid.reason,'INVALID');
 assert.equal(f.state.records,0);assert.equal(f.state.claims,0);
});
test('unconfirmed original write custody and missing successful write artifacts hold the run open',async t=>{
 for(const mode of ['custody','artifact'] as const){const f=await fixture(t),o=await f.seed('confirmed');f.cache();
  if(mode==='custody')writeJson(join(f.home,'threads','thread.json'),{...f.thread,writeCustody:{version:1,writes:{'turn:unconfirmed.md':{damaged:true}}}});
  else f.state.effects=[{id:'write-effect',operation:'workspace.write_document',status:'succeeded',run:f.handle.run,key:'turn:missing.md',args:{document_id:'missing',title:'missing.md',content_sha256:sha256('missing'),base_version:null}}];
  const result=await f.decisions.resolveRead({id:o.id,verdict:'discard'});assert.equal(result.ok,true);if(result.ok)assert.equal(result.value.runClosed,false);assert.equal(f.state.finishes,0);
 }
});
test('another retained carrier scope for the same run is not assumed to be this turn and prevents closure',async t=>{
 const f=await fixture(t),o=await f.seed('confirmed');f.cache();
 await withHomeLock(f.home,async()=>{
  f.decisions.observations.reserve({...o.request,scope:{...o.request.scope,turn:'other-original-turn'},origin:{...o.request.origin,callId:'other-native-call'}});
 });
 const result=await f.decisions.resolveRead({id:o.id,verdict:'discard'});assert.equal(result.ok,true);if(result.ok)assert.equal(result.value.runClosed,false);
 assert.equal(f.state.finishes,0);assert.equal(f.state.records,0);
});
test('Host close aborts bounded closure reads after a durable local discard; it never reports a false finished run',async t=>{
 const f=await fixture(t),o=await f.seed('confirmed');f.cache();let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 f.link.readBounded=(async(_actor:unknown,_sql:string,_params:unknown[],signal:AbortSignal)=>{
  entered();return await new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 }) as CoreLink['readBounded'];
 const work=f.decisions.resolveRead({id:o.id,verdict:'discard'});await started;await f.decisions.close();
 const result=await work;assert.equal(result.ok,true);if(result.ok)assert.deepEqual(result.value,{id:o.id,state:'discarded',registration:'confirmed',runClosed:false});
 assert.equal(f.decisions.observations.get(o.id)?.phase,'discarded');assert.equal(isWithdrawn(f.material.load(o.materialId)!),true);assert.equal(f.state.finishes,0);
});
test('ambiguous original-run history refuses reconcile without claiming, while local discard remains available',async t=>{
 const f=await fixture(t),o=await f.seed();f.cache();
 await withHomeLock(f.home,async()=>f.decisions.observations.reserve({...o.request,scope:{...o.request.scope,run:uuid('6')},origin:{...o.request.origin,callId:'another-original-run'}}));
 assert.equal((await f.decisions.resolveRead({id:o.id,verdict:'reconcile'})).ok,false);assert.equal(f.state.claims,0);assert.equal(f.state.records,0);
 const result=await f.decisions.resolveRead({id:o.id,verdict:'discard'});assert.equal(result.ok,true);if(result.ok)assert.equal(result.value.runClosed,false);assert.equal(f.state.finishes,0);
});
test('owned bootstrap can reload durable history while a person action merely waits for Core',async t=>{
 const f=await fixture(t),o=await f.seed();let open!:(link:CoreLink)=>void;f.state.coreWait=new Promise(resolve=>open=resolve);
 const work=f.decisions.resolveRead({id:o.id,verdict:'reconcile'});await new Promise<void>(resolve=>setImmediate(resolve));
 await withHomeLock(f.home,async()=>{
  // Existing durable history can differ from the constructor's pre-owner snapshot.
  f.journal.append({kind:'mcp.read.discarded',threadId:'thread',id:o.id});
  f.decisions.reload();assert.equal(f.decisions.observations.get(o.id)?.phase,'discarded');
 });
 open(f.link);const result=await work;assert.equal(result.ok,false);assert.equal(f.state.claims,0);assert.equal(f.state.records,0);await f.decisions.whenIdle();
});
test('bootstrap reload refuses during an actual decision write scope and never swaps its registry',async t=>{
 const f=await fixture(t),o=await f.seed();f.cache();const original=f.decisions.observations;
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const admit=f.link.admitMaterialConnectorRead.bind(f.link);
 f.link.admitMaterialConnectorRead=async(...args)=>{entered();await gate;return admit(...args);};
 const work=f.decisions.resolveRead({id:o.id,verdict:'reconcile'});await started;
 try{assert.throws(()=>f.decisions.reload(),/write scope/);assert.equal(f.decisions.observations,original);}
 finally{release();await work;}
 assert.equal((await work).ok,true);await f.decisions.whenIdle();
});


test('Now projects from an already resolved link under the home lock without awaiting Core open',async t=>{
 const f=await fixture(t),o=await f.seed();f.state.coreWait=new Promise(()=>{});
 await withHomeLock(f.home,async()=>{
  const rows=f.decisions.needsYou(f.link,'project');assert.equal(Array.isArray(rows),true);assert.equal(rows[0].observationId,o.id);
  assert.equal(f.state.records,0);assert.equal(f.state.claims,0);assert.equal(f.state.admissions,0);
 });
});
test('same-thread identical calls have durable UTC/tool/short-ID labels; selecting one leaves its neighbor intact',async t=>{
 const f=await fixture(t),first=await f.seed('response','native-first-call',true),second=await f.seed('response','native-second-call');f.decisions.observations.release(first.id);
 const cards=f.decisions.needsYou(f.link,'project');assert.equal(cards.length,2);assert.equal(cards[0].threadId,cards[1].threadId);
 assert.deepEqual(first.request.argsJson,second.request.argsJson);assert.equal(first.request.tool,second.request.tool);
 for(const observation of [first,second]){
  const card=cards.find(value=>value.observationId===observation.id)!;
  const at=f.decisions.observations.requestedAt(observation.id)!;
  assert.ok(card.title.includes('lookup'));assert.ok(card.detail.includes(new Date(at).toISOString().replace('T',' ').replace('Z',' UTC')));
  assert.ok(card.detail.includes(`…${observation.id.slice(-8)}`));assert.equal(card.detail.includes('"q"'),false,'no arguments are used as a label or identity');
 }
 const decision=await f.decisions.resolveRead({id:first.id,verdict:'discard'});assert.equal(decision.ok,true);
 const after=f.decisions.needsYou(f.link,'project');assert.deepEqual(after.map(value=>value.observationId),[second.id]);
 assert.equal(f.decisions.observations.get(second.id)?.response?.text,second.response!.text);assert.equal(f.state.records,0);assert.equal(f.state.claims,0);
});
test('work.now resolves Core before entering its home lock and passes that link to the projection',()=>{
 const source=readFileSync(new URL('../src/composition/host-reads.ts',import.meta.url),'utf8');
 const handler=source.slice(source.indexOf("    'work.now':"),source.indexOf("    'drafts.get':"));
 assert.ok(handler.indexOf('await core')>=0);assert.ok(handler.indexOf('await core')<handler.indexOf('withHomeLock('));
 assert.match(handler,/sourceReads\.needsYou\(link,\s*projectId\)/);assert.doesNotMatch(handler,/await sourceReads\.needsYou/);
});

test('credential-shaped tool labels are withheld only in display while the exact retained protocol stays intact',async t=>{
 const f=await fixture(t),tool='sk-'+ 'x'.repeat(20),o=await f.seed('response','native-tool-label',false,tool);
 const card=f.decisions.needsYou(f.link,'project')[0];assert.ok(card.title.includes('(withheld tool)'));assert.equal(card.title.includes(tool),false);
 assert.equal(f.decisions.observations.get(o.id)!.request.tool,tool);assert.ok(card.detail.includes(`…${o.id.slice(-8)}`));
 assert.equal(f.state.records,0);assert.equal(f.state.admissions,0);
});
