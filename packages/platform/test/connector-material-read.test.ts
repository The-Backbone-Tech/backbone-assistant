// Real private Store/journal, synthetic Core and SDK answers. No SQL, provider or network.
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {MaterialStore,managedPathProblem} from '../src/stub/material.ts';
import {ThreadJournal} from '../src/composition/thread-journal.ts';
import {ConnectorObservations} from '../src/composition/connector-observations.ts';
import {connectorObservationScope,readConnectorMaterial,recoverConnectorMaterial,type ConnectorMaterialReadOptions,type ConnectorMaterialReadRequest} from '../src/composition/connector-material-read.ts';
import type {CallAnswer} from '../src/connectors/client.ts';
import type {MaterialReadTentative,MaterialSourceReadRequest} from '../src/composition/core.ts';
import {outsideHomeLocks,withHomeLock} from '../src/composition/home-lock.ts';
const uuid=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
async function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'connector-material-owner-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const material=new MaterialStore(home,{},()=>{}),journal=new ThreadJournal(home),observations=new ConnectorObservations(home,journal);
 const state:{admissions:number;provider:number;records:MaterialSourceReadRequest[];witness:boolean;failRegistration:boolean;lostCommit:boolean;offer:boolean;beforeRecord?:()=>void;afterAdmission?:()=>void;answer:CallAnswer}={
  admissions:0,provider:0,records:[],witness:false,failRegistration:false,lostCommit:false,offer:true,answer:{observed:true,status:'complete',text:'Actual result'}
 };
 const options:ConnectorMaterialReadOptions={home,material,observations,projectId:'project',threadId:'thread',turnId:'turn',handle:{run:uuid('3'),fence:1,secret:'fake'},link:{id:{workspace:uuid('1')} as ConnectorMaterialReadOptions['link']['id'],materialEnforcement:{state:'verified',reason:'Synthetic profile, not native qualification.'},
  async admitMaterialConnectorRead(){state.admissions++;state.afterAdmission?.();},
  async recordMaterialSourceRead(_h,payload,retain){state.beforeRecord?.();state.records.push(structuredClone(payload));if(state.failRegistration)throw new Error('Synthetic Core refusal');
   const result:MaterialReadTentative={workspace:uuid('1'),readKey:payload.readKey,episode:uuid('4'),receipt:uuid('5')};retain(result);if(state.lostCommit)throw new Error('Synthetic lost commit reply');return result;},
  async materialReadCommitWitness(){return state.witness?'confirmed':'unknown';}
 }};
 await withHomeLock(home,async()=>observations.startProtocol(connectorObservationScope(options)));
 const request:ConnectorMaterialReadRequest={tool:{name:'mcp__server__lookup',serverId:'server',serverName:'Server',connection:{id:uuid('2'),slug:'server'},tool:'lookup',description:'Find',inputSchema:{},kind:'read',launch:'a'.repeat(64),definition:'b'.repeat(64)},args:{q:'same'},invocation:{engine:'codex',namespace:'["native-thread","native-turn"]',callId:'call-1'},signal:new AbortController().signal,
  stillOffered:()=>state.offer,async perform(){state.provider++;return state.answer;}};
 return {home,material,journal,observations,options,request,state};
}
test('one native invocation retains response and pending material before typed registration and returns only the confirmed source',async t=>{
 const f=await fixture(t);f.state.beforeRecord=()=>{
  const obs=f.observations.forRun(connectorObservationScope(f.options))[0];assert.equal(obs.phase,'material');assert.ok(obs.response);
  assert.equal(f.material.list('project').length,0,'pending material is not automatic input');
 };
 const result=await readConnectorMaterial(f.options,f.request);assert.equal(result.outcome,'READ');if(result.outcome!=='READ')return;
 assert.equal(f.state.provider,1);assert.equal(f.state.admissions,2);assert.equal(f.state.records.length,1);assert.equal(result.text,'Actual result');
 assert.equal(f.material.load(result.material.id)?.observation?.state,'registered');assert.equal(f.material.list('project').length,1);
 const record=f.state.records[0];assert.equal(record.authoredBy,null);assert.equal(record.sourceKind,'mcp');assert.equal(record.connection,uuid('2'));
 assert.deepEqual(JSON.parse(record.preparedText),{outcome:'READ',status:'complete',text:'Actual result'});
});
test('duplicate native invocation does not resend, while distinct native IDs with identical arguments remain legitimate distinct reads',async t=>{
 const f=await fixture(t);const first=await readConnectorMaterial(f.options,f.request),again=await readConnectorMaterial(f.options,f.request);
 assert.equal(first.outcome,'READ');assert.deepEqual(again,first);assert.equal(f.state.provider,1);
 f.request.invocation!.callId='call-2';const second=await readConnectorMaterial(f.options,f.request);assert.equal(second.outcome,'READ');assert.equal(f.state.provider,2);
 if(first.outcome==='READ'&&second.outcome==='READ')assert.notEqual(first.material.id,second.material.id);
 assert.notEqual(f.state.records[0].readKey,f.state.records[1].readKey);
});
test('rejection after dispatch stays UNKNOWN without a fabricated source and blocks a new automatic call ID in the same turn',async t=>{
 const f=await fixture(t);f.request.perform=async()=>{f.state.provider++;throw new Error('Looks like a server response');};
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');assert.equal(f.state.records.length,0);assert.equal(f.material.list('project',true).length,0);
 f.request.invocation!.callId='call-2';assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');assert.equal(f.state.provider,1);
 f.options.turnId='person-next-turn';await withHomeLock(f.home,async()=>f.observations.startProtocol(connectorObservationScope(f.options)));
 f.request.perform=async()=>{f.state.provider++;return f.state.answer;};assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'READ');assert.equal(f.state.provider,2);
});
test('an unobserved SDK diagnostic never becomes an MCP episode, including a failed-looking result',async t=>{
 const f=await fixture(t);f.state.answer={observed:false,status:'failed',text:'',detail:'Synthetic transport error'};
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');assert.equal(f.state.records.length,0);
});
test('a resolved isError-style result is observed and retained with its failed status',async t=>{
 const f=await fixture(t);f.state.answer={observed:true,status:'failed',text:'Actual error result',detail:'Server result'};
 const result=await readConnectorMaterial(f.options,f.request);assert.equal(result.outcome,'READ');if(result.outcome==='READ')assert.equal(result.status,'failed');assert.equal(f.state.records.length,1);
});
test('registration failure retains exact response and pending original; exact recovery never repeats the provider',async t=>{
 const f=await fixture(t);f.state.failRegistration=true;assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');
 const obs=f.observations.forRun(connectorObservationScope(f.options))[0];assert.equal(obs.phase,'material');assert.equal(f.material.list('project').length,0);
 f.state.failRegistration=false;assert.deepEqual(await recoverConnectorMaterial(f.options),{pending:false});assert.equal(f.state.provider,1);assert.equal(f.material.list('project').length,1);
});
test('lost COMMIT resolves only with a positive historical witness for retained IDs, plus fresh admission before handover',async t=>{
 const f=await fixture(t);f.state.lostCommit=true;assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');
 assert.equal(f.observations.forRun(connectorObservationScope(f.options))[0].phase,'tentative');f.state.witness=true;
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'READ');assert.equal(f.state.records.length,1);assert.equal(f.state.provider,1);assert.equal(f.state.admissions,2);
});
test('missing ledger witness is not proof of absence: only exact original registration key is retried',async t=>{
 const f=await fixture(t);f.state.lostCommit=true;await readConnectorMaterial(f.options,f.request);f.state.lostCommit=false;
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'READ');assert.equal(f.state.provider,1);assert.equal(f.state.records.length,2);
 assert.deepEqual(f.state.records[0],f.state.records[1]);
});
test('stopping after an observed response still retains it, and local recovery makes no provider call',async t=>{
 const f=await fixture(t),stop=new AbortController();f.request.signal=stop.signal;f.request.perform=async()=>{f.state.provider++;stop.abort();return f.state.answer;};
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');
 const obs=f.observations.forRun(connectorObservationScope(f.options))[0];assert.equal(obs.phase,'response');assert.equal(obs.response?.text,'Actual result');assert.equal(f.state.records.length,0);
 assert.deepEqual(await recoverConnectorMaterial(f.options),{pending:false});assert.equal(f.state.provider,1);
});
test('withdrawal after historical confirmation prevents handover and never clears withdrawal state',async t=>{
 const f=await fixture(t);f.state.afterAdmission=()=>{if(f.state.admissions===2){const obs=f.observations.forRun(connectorObservationScope(f.options))[0];f.material.withdraw(obs.materialId);}};
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');assert.equal(f.state.provider,1);
 const obs=f.observations.forRun(connectorObservationScope(f.options))[0];assert.equal(obs.phase,'confirmed');assert.equal(f.material.load(obs.materialId)?.withdrawals?.length,1);
});
test('JSON preparations retain control characters explicitly without unsupported NUL in Core text',async t=>{
 const f=await fixture(t);f.state.answer={observed:true,status:'complete',text:'A\0B'};
 const result=await readConnectorMaterial(f.options,f.request);assert.equal(result.outcome,'READ');if(result.outcome==='READ')assert.equal(result.text,'A\0B');
 assert.equal(f.state.records[0].episodeContent.includes('\0'),false);assert.equal(f.state.records[0].preparedText.includes('\0'),false);
 assert.equal(JSON.parse(f.state.records[0].preparedText).text,'A\0B');
});
test('the home lock is released while waiting for the remote response',async t=>{
 const f=await fixture(t);let resolve!:(answer:CallAnswer)=>void,started!:()=>void;const invoked=new Promise<void>(r=>started=r);
 f.request.perform=()=>{f.state.provider++;started();return new Promise(r=>resolve=r);};
 const reading=readConnectorMaterial(f.options,f.request);await invoked;
 await outsideHomeLocks(()=>withHomeLock(f.home,async()=>{assert.equal(f.state.records.length,0);resolve(f.state.answer);}));
 assert.equal((await reading).outcome,'READ');
});
test('fresh replay of dispatched-without-response history never sends the provider again',async t=>{
 const f=await fixture(t);f.state.answer={observed:false,status:'failed',text:''};await readConnectorMaterial(f.options,f.request);
 f.options.observations=new ConnectorObservations(f.home,new ThreadJournal(f.home));f.request.invocation!.callId='new-id';
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');assert.equal(f.state.provider,1);
});
test('missing native identity and changed live offer cause no dispatch or fabricated source',async t=>{
 const f=await fixture(t);const invocation=f.request.invocation;delete f.request.invocation;
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'REFUSED');f.request.invocation=invocation;f.state.offer=false;
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'REFUSED');assert.equal(f.state.provider,0);assert.equal(f.state.records.length,0);
});
test('a proven pre-dispatch native admission refusal is not reported as a provider outcome',async t=>{
 const f=await fixture(t);f.options.link.admitMaterialConnectorRead=async()=>{throw new Error('Synthetic admission refused');};
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'REFUSED');assert.equal(f.state.provider,0);assert.equal(f.state.records.length,0);
 assert.equal(f.observations.forRun(connectorObservationScope(f.options))[0].phase,'not-sent');
});
test('Host shutdown cancels response-retention lock admission, avoiding a close/worker dependency cycle',async t=>{
 const f=await fixture(t),shutdown=new AbortController();f.options.closeSignal=shutdown.signal;
 let resolve!:(answer:CallAnswer)=>void,started!:()=>void;const invoked=new Promise<void>(r=>started=r);
 f.request.perform=()=>{f.state.provider++;started();return new Promise(r=>resolve=r);};
 const reading=readConnectorMaterial(f.options,f.request);await invoked;let settled=false;
 void reading.then(()=>{settled=true;});
 try{await outsideHomeLocks(()=>withHomeLock(f.home,async()=>{
  shutdown.abort();resolve(f.state.answer);
  await new Promise<void>(resolve=>setTimeout(resolve,100));
  assert.equal(settled,true,'a closing Host cannot await its worker while that worker waits for this held lock');
 }));}finally{await reading;}
 assert.equal((await reading).outcome,'UNKNOWN');assert.equal(f.state.records.length,0);
 assert.equal(f.observations.forRun(connectorObservationScope(f.options))[0].phase,'dispatched','unretained response stays uncertain, never a fabricated absence');
});

for(const [description,serverName,tool] of [
 ['long ASCII','s'.repeat(1100),'read_answer'],
 ['astral boundary','s'.repeat(450)+'😀'.repeat(80),'read_answer'],
 ['separators','server/../\\line\r\n','read/path\\answer'],
] as const)test(`connector labels remain exportable and exact source identities survive cold recovery: ${description}`,async t=>{
 const f=await fixture(t);f.request.tool.serverName=serverName;f.request.tool.tool=tool;f.state.failRegistration=true;
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');
 const before=f.observations.forRun(connectorObservationScope(f.options))[0],name=before.response!.material.name;
 assert.equal(managedPathProblem(name,[]),undefined);assert.equal(name.includes('/'),false);
 assert.ok(name.length<=1024);assert.equal(Buffer.from(name,'utf8').toString('utf8'),name);
 assert.ok(name.endsWith(` · ${before.id.slice(0,16)}.json`),'the observation suffix survives truncation');
 if(description==='astral boundary'){
  assert.equal(name,`From ${'s'.repeat(450)} · ${before.id.slice(0,16)}.json`,'the next emoji cannot fit in the remaining single code unit');
  assert.doesNotMatch(name,/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u,'truncation never leaves an unpaired surrogate');
 }
 assert.equal(before.request.serverName,serverName);assert.equal(before.request.tool,tool);
 const envelope=JSON.parse(before.response!.material.body);assert.equal(envelope.server,serverName);assert.equal(envelope.tool,tool);
 const retainedMeta=readFileSync(join(f.home,'material',before.materialId,'meta.json'));
 f.options.observations=new ConnectorObservations(f.home,new ThreadJournal(f.home));f.state.failRegistration=false;
 assert.deepEqual(await recoverConnectorMaterial(f.options),{pending:false});
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'READ');assert.equal(f.state.provider,1);
 const after=f.options.observations.get(before.id)!;
 assert.deepEqual(after.response,before.response);assert.equal(after.request.serverName,serverName);assert.equal(after.request.tool,tool);
 assert.equal(f.material.load(before.materialId)!.name,name);assert.deepEqual(f.material.load(before.materialId)!.fromServer,{connection:f.request.tool.connection.id,tool});
 assert.equal(f.state.records.at(-1)!.connection,f.request.tool.connection.id);assert.equal(f.state.records.at(-1)!.tool,tool);
 assert.equal(f.state.records.at(-1)!.authoredBy,null);
 assert.ok(retainedMeta.includes(Buffer.from(JSON.stringify(name))),'the saved label was fixed before registration/recovery');
});

test('a generated connector label collision uses a bounded alternative frozen before replay',async t=>{
 const f=await fixture(t);f.request.tool.serverName='Collision server '+ 's'.repeat(1100);
 const allocate=f.material.freeName.bind(f.material);let occupied='';
 f.material.freeName=(project,label)=>{
  if(!occupied){occupied=label;f.material.create(project,label,'application/json',Buffer.from('Existing person data'),'original','person');}
  return allocate(project,label);
 };
 const first=await readConnectorMaterial(f.options,f.request);assert.equal(first.outcome,'READ');if(first.outcome!=='READ')return;
 assert.notEqual(first.material.name,occupied);assert.equal(managedPathProblem(first.material.name,[]),undefined);
 const observation=f.observations.forRun(connectorObservationScope(f.options))[0];
 assert.ok(first.material.name.endsWith(` · ${observation.id.slice(0,16)} (2).json`),'collision allocation preserves the observation suffix');
 f.options.observations=new ConnectorObservations(f.home,new ThreadJournal(f.home));
 assert.deepEqual(await readConnectorMaterial(f.options,f.request),first);assert.equal(f.state.provider,1);
 assert.equal(f.material.list('project',true).find(entry=>entry.name===occupied)!.versions[0].by,'person');
});

test('a frozen legacy invalid response without an original stays unresolved, unchanged and never resent',async t=>{
 const f=await fixture(t),name='From '+ 'legacy'.repeat(200)+'.json';
 const before=await withHomeLock(f.home,async()=>{
  const o=f.observations.reserve({scope:connectorObservationScope(f.options),origin:f.request.invocation!,serverId:f.request.tool.serverId,
   serverName:f.request.tool.serverName,connection:f.request.tool.connection.id,tool:f.request.tool.tool,launch:f.request.tool.launch,
   definition:f.request.tool.definition,argsJson:JSON.stringify(f.request.args)}).observation;
  f.observations.beginDispatch(o.id);f.observations.retainResponse(o.id,{status:'complete',text:'Retained legacy answer',
   material:{name,mediaType:'application/json',body:'{"result":"Retained legacy answer"}'},episodeContent:'Legacy episode',preparedText:'Retained legacy answer',transformation:{kind:'legacy-test',version:'1'}});
  f.observations.release(o.id);return f.observations.get(o.id)!;
 });
 const journalBefore=readFileSync(f.journal.path);
 f.options.observations=new ConnectorObservations(f.home,new ThreadJournal(f.home));
 assert.deepEqual(await recoverConnectorMaterial(f.options),{pending:true});
 assert.equal((await readConnectorMaterial(f.options,f.request)).outcome,'UNKNOWN');
 assert.equal(f.state.provider,0);assert.equal(f.state.records.length,0);
 assert.deepEqual(f.options.observations.get(before.id),before);assert.deepEqual(readFileSync(f.journal.path),journalBefore);
 assert.equal(existsSync(join(f.home,'material',before.materialId)),false,'new invalid material is not created under a renamed label');
});
