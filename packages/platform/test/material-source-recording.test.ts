// Offline transport protocol, not evidence of native SQL authority or catalogue qualification.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import pg from 'pg';
import {CoreLink,CoreRefusal,type MaterialSourceReadRequest,type MaterialReadTentative} from '../src/composition/core.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
const driver=pg as unknown as {Client:new(config:unknown)=>unknown};
const ids={workspace:'11111111-1111-4111-8111-111111111111',system:'22222222-2222-4222-8222-222222222222',person:'33333333-3333-4333-8333-333333333333',agent:'44444444-4444-4444-8444-444444444444',run:'55555555-5555-4555-8555-555555555555',episode:'66666666-6666-4666-8666-666666666666',receipt:'77777777-7777-4777-8777-777777777777'};
const input:MaterialSourceReadRequest={project:'project',material:'material',version:1,generation:0,readKey:'a'.repeat(64),originalSha256:'b'.repeat(64),transformation:{kind:'material-file-preparation',version:'1'},sourceKind:'file',episodeContent:'retained text',preparedText:'retained text',authoredBy:null};
function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'material-recording-protocol-')),calls:{sql:string;values?:unknown[]}[]=[],events:string[]=[];
 const state:{safe:boolean;witness:boolean;standing:string;visible:boolean;claimable:boolean;recoveryEligible:boolean;lifecycleClear:boolean;snapshotFence:string;claimFence:string;ledgerSequence:string;ended:number;created:number;commitCommand:string;onRole?:()=>void;afterRecord?:()=>void;afterCommit?:()=>void;commitFailure?:Error;recordGate?:Promise<void>}={safe:true,witness:true,standing:'ok',visible:true,claimable:true,recoveryEligible:true,lifecycleClear:true,snapshotFence:'7',claimFence:'8',ledgerSequence:'9007199254740993',ended:0,created:0,commitCommand:'COMMIT'};
 const original=driver.Client;
 class Client extends EventEmitter{
  constructor(){super();state.created++;}
  async connect(){}
  async query(query:string|{text:string;values?:unknown[]},values?:unknown[]){
   const sql=typeof query==='string'?query:query.text;calls.push({sql,values:typeof query==='string'?values:query.values});events.push(sql);
   if(sql.includes('SELECT rolsuper')){state.onRole?.();return {rows:[{rolsuper:false,rolbypassrls:false}]};}
   if(sql.includes("current_setting('log_parameter_max_length')"))return {rows:[{parameters:state.safe?'0':'-1',errors:'0',debug_plan:'off'}]};
   if(sql.includes('gov.run_standing('))return {rows:[{standing:state.standing}]};
   if(sql.includes('AS material_recipient_visible'))return {rows:[{material_recipient_visible:state.visible}]};
   if(sql.includes('AS ledger_seq'))return {rows:state.recoveryEligible?[{fence:state.snapshotFence,ledger_seq:state.ledgerSequence}]:[]};
   if(sql.includes('AS material_recovery_lifecycle_clear'))return {rows:[{material_recovery_lifecycle_clear:state.lifecycleClear}]};
   if(sql.includes('gov.claim_run('))return {rows:state.claimable?[{fence:state.claimFence,secret:`${ids.person}.${ids.agent}`}]:[]};
   if(sql.startsWith('SELECT episode_id, receipt_id FROM gov.record_material_source_read')){await state.recordGate;state.afterRecord?.();return {rows:[{episode_id:ids.episode,receipt_id:ids.receipt}]};}
   if(sql.includes("entry_type = 'material.read_registered'"))return {rows:state.witness?[{receipt:ids.receipt}]:[]};
   if(sql==='COMMIT'){if(state.commitFailure)throw state.commitFailure;state.afterCommit?.();}
   return {rows:[],command:sql==='COMMIT'?state.commitCommand:sql};
  }
  async end(){state.ended++;}
 }
 driver.Client=Client;t.after(()=>{driver.Client=original;rmSync(home,{recursive:true,force:true});});
 const verified={state:'verified',reason:'Synthetic verified profile'};
 const db={appUrl:'synthetic-unused',materialGuard:verified,materialLink:verified,materialEnforcement:verified};
 // Run the real constructor/actor fields without opening Core or creating a network pool.
 const link=Reflect.construct(CoreLink,[db,{},{},{...ids},join(home,'core.json'),{}]) as CoreLink;
 const handle={run:ids.run,fence:7,secret:'synthetic-only-secret'};
 return {home,link,handle,calls,events,state};
}

test('registration verifies the carrier and durably retains tentative IDs before COMMIT, returning only after COMMIT',async t=>{
 const f=fixture(t);
 const receipt=await withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,pending=>{
  assert.deepEqual(pending,{workspace:ids.workspace,readKey:input.readKey,episode:ids.episode,receipt:ids.receipt});
  assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);f.events.push('tentative fsync');
 },signal));
 assert.equal(receipt.receipt,ids.receipt);assert.equal(f.state.ended,1);
 const renew=f.calls.findIndex(call=>call.sql.includes('gov.renew_run_lease(')),record=f.calls.findIndex(call=>call.sql.includes('gov.record_material_source_read('));
 assert.ok(renew>=0&&record>renew);assert.ok(f.events.indexOf('COMMIT')>f.events.indexOf('tentative fsync'));
 const identity=f.calls.filter(call=>call.sql.includes("set_config('backbone.workspace'"));
 assert.equal(identity.length,2);assert.deepEqual(identity[0].values,[ids.workspace,'',ids.run,f.handle.secret]);
 assert.deepEqual(identity[1].values,[ids.workspace,ids.system,'',''],'system recording clears the run and secret');
 assert.ok(f.calls.every(call=>!call.sql.includes(f.handle.secret)),'secret never enters SQL text');
});

test('failed durable retention prevents COMMIT and closes its dedicated connection',async t=>{
 const f=fixture(t),failure=new Error('Synthetic journal fsync failed');
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{throw failure;},signal)),error=>error===failure);
 assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);assert.equal(f.state.ended,1);
});

test('a promise-returning callback refuses before COMMIT',async t=>{
 const f=fixture(t),invalid=(()=>Promise.resolve()) as unknown as (pending:MaterialReadTentative)=>undefined;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,invalid,signal)),/synchronous/i);
 assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);assert.equal(f.state.ended,1);
});

test('abort after durable retention is a typed unknown with tentative IDs, never a Core refusal',async t=>{
 const f=fixture(t),abort=new AbortController();
 await assert.rejects(withHomeLock(f.home,lost=>f.link.recordMaterialSourceRead(f.handle,input,()=>{abort.abort();},AbortSignal.any([lost,abort.signal]))),error=>{
  assert.ok(!(error instanceof CoreRefusal));assert.equal((error as Error).name,'MaterialCommitUnknown');
  assert.equal((error as {tentative:MaterialReadTentative}).tentative.receipt,ids.receipt);return true;
 });
 assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);
});

for(const code of ['ECONNRESET','EPIPE'])test(`${code} during COMMIT remains a typed unknown, not a SQL refusal`,async t=>{
 const f=fixture(t);f.state.commitFailure=Object.assign(new Error('Synthetic lost COMMIT response'),{code});
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{},signal)),error=>{
  assert.ok(!(error instanceof CoreRefusal));assert.equal((error as Error).name,'MaterialCommitUnknown');assert.equal((error as {tentative:MaterialReadTentative}).tentative.episode,ids.episode);return true;
 });
 assert.equal(f.state.ended,1);
});

test('a real server constraint error at COMMIT is a definite refusal',async t=>{
 const f=fixture(t),error=new pg.DatabaseError('paused: synthetic deferred constraint',1,'error');error.code='P0001';error.severity='ERROR';f.state.commitFailure=error;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{},signal)),failure=>failure instanceof CoreRefusal&&failure.reason==='paused');
});

for(const code of ['40003','08007'])test(`server completion uncertainty ${code} is not a definite refusal`,async t=>{
 const f=fixture(t),error=new pg.DatabaseError('Synthetic uncertain transaction completion',1,'error');error.code=code;error.severity='ERROR';f.state.commitFailure=error;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{},signal)),failure=>!(failure instanceof CoreRefusal)&&(failure as Error).name==='MaterialCommitUnknown');
});

test('acknowledged COMMIT survives a late abort; data handover still belongs to the caller',async t=>{
 const f=fixture(t),abort=new AbortController();f.state.afterCommit=()=>abort.abort();
 const result=await withHomeLock(f.home,lost=>f.link.recordMaterialSourceRead(f.handle,input,()=>{},AbortSignal.any([lost,abort.signal])));
 assert.equal(result.receipt,ids.receipt);assert.equal(abort.signal.aborted,true);
});

test('acknowledged COMMIT survives a simultaneously expiring local deadline',async t=>{
 const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});f.state.afterCommit=()=>t.mock.timers.tick(8000);
 const result=await withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{},signal));
 assert.equal(result.receipt,ids.receipt);
});

test('a registration escaping its home-lock callback cannot persist tentative IDs or COMMIT',async t=>{
 const f=fixture(t);let release!:()=>void,pending:Promise<MaterialReadTentative>|undefined,retained=0;
 f.state.recordGate=new Promise<void>(resolve=>{release=resolve;});
 await withHomeLock(f.home,async lost=>{pending=f.link.recordMaterialSourceRead(f.handle,input,()=>{retained++;},lost);});
 release();await assert.rejects(pending!,/lock/i);assert.equal(retained,0);assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);
});

test('lock-loss signal after the record statement prevents local retention and COMMIT without masquerading as a SQL refusal',async t=>{
 const f=fixture(t),lost=new AbortController();f.state.afterRecord=()=>lost.abort();let retained=0;
 await assert.rejects(withHomeLock(f.home,held=>f.link.recordMaterialSourceRead(f.handle,input,()=>{retained++;},AbortSignal.any([held,lost.signal]))),error=>!(error instanceof CoreRefusal));
 assert.equal(retained,0);assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);
});

test('a rollback response is never reported as an acknowledged COMMIT',async t=>{
 const f=fixture(t);f.state.commitCommand='ROLLBACK';let retained=0;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{retained++;},signal)),/COMMIT/i);
 assert.equal(retained,1,'tentative IDs remain historical inspection evidence, not confirmation');assert.equal(f.state.ended,1);
});

test('caller mutation during transport cannot change the captured key, payload, actor or carrier',async t=>{
 const f=fixture(t),request=structuredClone(input);
 f.state.onRole=()=>{request.readKey='c'.repeat(64);request.preparedText='changed';request.transformation.kind='changed';f.handle.secret='changed';f.link.id.workspace=ids.person;f.link.id.system=ids.agent;};
 const receipt=await withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,request,()=>{},signal));
 assert.equal(receipt.workspace,ids.workspace);assert.equal(receipt.readKey,input.readKey);
 const record=f.calls.find(call=>call.sql.includes('gov.record_material_source_read('));assert.ok(record);
 assert.equal(record.values?.[4],input.readKey);assert.equal(record.values?.[6],JSON.stringify(input.transformation));assert.equal(record.values?.[9],input.preparedText);
 const actors=f.calls.filter(call=>call.sql.includes("set_config('backbone.workspace'"));
 assert.deepEqual(actors[0].values,[ids.workspace,'',ids.run,'synthetic-only-secret']);assert.deepEqual(actors[1].values,[ids.workspace,ids.system,'','']);
});

test('unsafe logging refuses before actor credentials or a registration and closes the connection',async t=>{
 const f=fixture(t);f.state.safe=false;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{},signal)),/log/i);
 assert.equal(f.calls.some(call=>call.sql.includes('set_config')),false);assert.equal(f.calls.some(call=>call.sql.includes('record_material_source_read')),false);assert.equal(f.state.ended,1);
});

test('an unverified enforcement status and an unheld source lock refuse before any connection',async t=>{
 const f=fixture(t);
 await assert.rejects(f.link.recordMaterialSourceRead(f.handle,input,()=>{},new AbortController().signal),/lock/i);
 Object.assign(f.link,{db:{appUrl:'synthetic-unused',materialGuard:{state:'verified'},materialLink:{state:'verified'}}});
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{},signal)),/enforcement|verified/i);
 assert.equal(f.state.created,0);
});

test('a ledger witness confirms only matching historical IDs; absence stays unknown and never re-registers',async t=>{
 const f=fixture(t),pending={workspace:ids.workspace,episode:ids.episode,receipt:ids.receipt};
 assert.equal(await f.link.materialReadCommitWitness(pending),'confirmed');
 f.state.witness=false;assert.equal(await f.link.materialReadCommitWitness(pending),'unknown');
 assert.equal(f.calls.some(call=>call.sql.includes('record_material_source_read')||call.sql.includes('renew_run_lease')),false);
 const query=f.calls.find(call=>call.sql.includes("entry_type = 'material.read_registered'"));assert.ok(query);
 assert.deepEqual(query.values,[ids.workspace,ids.receipt,ids.episode,ids.system]);
 assert.equal(f.state.ended,2);
});

test('a foreign workspace witness is rejected before any connection',async t=>{
 const f=fixture(t);
 await assert.rejects(f.link.materialReadCommitWitness({workspace:ids.person,episode:ids.episode,receipt:ids.receipt}),/workspace/i);
 assert.equal(f.state.created,0);
});

for(const standing of ['mandate_revoked','mandate_expired','budget_exhausted','stopped'])test(`registration refuses ${standing} before changing to the system recorder`,async t=>{
 const f=fixture(t);f.state.standing=standing;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{},signal)),failure=>failure instanceof CoreRefusal);
 assert.equal(f.calls.some(call=>call.sql.includes('record_material_source_read(')),false);
 assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);
});

test('registration refuses invisible run audience before the trusted recorder',async t=>{
 const f=fixture(t);f.state.visible=false;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.recordMaterialSourceRead(f.handle,input,()=>{},signal)),failure=>failure instanceof CoreRefusal);
 assert.equal(f.calls.some(call=>call.sql.includes('record_material_source_read(')),false);
});

test('pre-dispatch admission checks the native holder, hierarchy, run audience and connection through RunActor',async t=>{
 const f=fixture(t);
 await withHomeLock(f.home,signal=>f.link.admitMaterialConnectorRead(f.handle,ids.person,signal));
 assert.equal(f.calls.filter(call=>call.sql.includes("set_config('backbone.workspace'")).length,1,'no system recorder is used for provider admission');
 assert.ok(f.calls.some(call=>call.sql.includes('gov.renew_run_lease(')));
 assert.ok(f.calls.some(call=>call.sql.includes('gov.run_standing(')));
 const visibility=f.calls.find(call=>call.sql.includes('AS material_recipient_visible'))!;
 assert.ok(visibility.sql.includes('app.connections'));assert.deepEqual(visibility.values,[ids.run,ids.person]);
 assert.equal(f.calls.at(-1)?.sql,'COMMIT');
 assert.equal(f.calls.some(call=>call.sql.includes('record_material_source_read(')),false);
});

test('pre-dispatch admission refuses invisible connection, paused enforcement and absent home lock',async t=>{
 const f=fixture(t);f.state.visible=false;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.admitMaterialConnectorRead(f.handle,ids.person,signal)),failure=>failure instanceof CoreRefusal);
 assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);
 await assert.rejects(f.link.admitMaterialConnectorRead(f.handle,ids.person,new AbortController().signal),/lock/i);
});

test('explicit recovery claims only the original native run and carrier with bounded transport, never queues work',async t=>{
 const f=fixture(t),piece=ids.person;
 const handle=await withHomeLock(f.home,signal=>f.link.claimMaterialRecovery(ids.run,piece,signal));
 assert.deepEqual(handle,{run:ids.run,fence:8,secret:`${ids.person}.${ids.agent}`});
 const claim=f.calls.find(call=>call.sql.includes('gov.claim_run('))!;assert.deepEqual(claim.values,[ids.run,`host-${process.pid}`,6000,'piece',piece]);
 assert.equal(f.calls.filter(call=>call.sql.includes("set_config('backbone.workspace'")).length,3,'system snapshot, empty worker claim, then the actual new holder');
 assert.equal(f.calls.at(-1)?.sql,'COMMIT');
 assert.equal(f.calls.some(call=>call.sql.includes('queue_run')||call.sql.includes('record_material_source_read')),false);
 assert.ok(f.calls.every(call=>!call.sql.includes(`${ids.person}.${ids.agent}`)));
});
test('an unavailable original claim or a lost COMMIT never produces a substitute handle',async t=>{
 const f=fixture(t);f.state.claimable=false;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.claimMaterialRecovery(ids.run,null,signal)),error=>error instanceof CoreRefusal&&error.reason==='not_claimable');
 assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);f.state.claimable=true;f.state.commitFailure=Object.assign(new Error('Lost claim COMMIT reply'),{code:'ECONNRESET'});
 await assert.rejects(withHomeLock(f.home,signal=>f.link.claimMaterialRecovery(ids.run,null,signal)),/unresolved/i);
 assert.equal(f.calls.some(call=>call.sql.includes('queue_run')||call.sql.includes('record_material_source_read')),false);
});
test('recovery claim requires verified enforcement and held source lock before connecting',async t=>{
 const f=fixture(t);await assert.rejects(f.link.claimMaterialRecovery(ids.run,null,new AbortController().signal),/lock/i);
 assert.equal(f.state.created,0);
});
test('recovery evidence queries use a bounded dedicated connection and the exact captured actor',async t=>{
 const f=fixture(t),actor=f.link.runOf(f.handle),parameters=[ids.run,7,'failed'];
 await withHomeLock(f.home,signal=>f.link.readBounded(actor,'SELECT gov.finish_run($1::uuid,$2::bigint,$3::text)',parameters,signal));
 assert.equal(f.state.created,1);assert.equal(f.state.ended,1);
 const identity=f.calls.find(call=>call.sql.includes("set_config('backbone.workspace'"))!;assert.deepEqual(identity.values,[ids.workspace,'',ids.run,f.handle.secret]);
 assert.equal(f.calls.at(-1)?.sql,'SELECT gov.finish_run($1::uuid,$2::bigint,$3::text)');assert.deepEqual(f.calls.at(-1)?.values,parameters);
});
test('unsafe logging and a cancelled recovery evidence query stop before actor or SQL parameters',async t=>{
 const f=fixture(t);f.state.safe=false;
 await assert.rejects(f.link.readBounded(f.link.system(),'SELECT $1',['private-synthetic-value'],new AbortController().signal),/log/i);
 assert.equal(f.calls.some(call=>call.sql.includes("set_config('backbone.workspace'")),false);
 const abort=new AbortController();abort.abort();const before=f.state.created;
 await assert.rejects(f.link.readBounded(f.link.system(),'SELECT $1',['private-synthetic-value'],abort.signal));assert.equal(f.state.created,before);
});


for(const lifecycle of ['waiting-not-woken','waiting-woken','queued'])test(`recovery pre-read refuses ${lifecycle} before native claim or COMMIT`,async t=>{
 const f=fixture(t);f.state.recoveryEligible=false;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.claimMaterialRecovery(ids.run,null,signal)),/original running run|not_claimable/);
 const pre=f.calls.find(call=>call.sql.includes('AS ledger_seq'))!;
 assert.ok(pre.sql.includes("r.status = 'running'"));assert.ok(pre.sql.includes('r.lease_expires_at <= clock_timestamp()'));
 assert.equal(f.calls.some(call=>call.sql.includes('gov.claim_run(')||call.sql==='COMMIT'),false);
});
test('recovery snapshots sequence as bigint text and rejects intervening park/finish/stop under the native head lock',async t=>{
 const f=fixture(t);f.state.lifecycleClear=false;
 await assert.rejects(withHomeLock(f.home,signal=>f.link.claimMaterialRecovery(ids.run,null,signal)),/parked or stopped/);
 const pre=f.calls.findIndex(call=>call.sql.includes('AS ledger_seq')),claim=f.calls.findIndex(call=>call.sql.includes('gov.claim_run(')),check=f.calls.findIndex(call=>call.sql.includes('AS material_recovery_lifecycle_clear'));
 assert.ok(pre>=0&&claim>pre&&check>claim);
 assert.deepEqual(f.calls[check].values,[ids.workspace,ids.run,'9007199254740993',['run.parked','run.finished','run.stopped']]);
 assert.ok(f.calls[check].sql.includes('l.subject = $2::text'));assert.ok(f.calls[check].sql.includes('l.seq > $3::bigint'));
 assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);
});
test('recovery refuses another intervening holder instead of accepting a later claim generation',async t=>{
 const f=fixture(t);f.state.claimFence='9';
 await assert.rejects(withHomeLock(f.home,signal=>f.link.claimMaterialRecovery(ids.run,null,signal)),/holder changed/);
 assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);
});
test('recovery rejects missing or malformed snapshot proof before claiming',async t=>{
 const f=fixture(t);f.state.ledgerSequence='9007199254740993.5';
 await assert.rejects(withHomeLock(f.home,signal=>f.link.claimMaterialRecovery(ids.run,null,signal)),/original running run/);
 assert.equal(f.calls.some(call=>call.sql.includes('gov.claim_run(')||call.sql==='COMMIT'),false);
});


test('recovery keeps its captured workspace/system/holder identity through transport awaits',async t=>{
 const f=fixture(t);f.state.onRole=()=>{f.link.id.workspace=ids.person;f.link.id.system=ids.agent;};
 const result=await withHomeLock(f.home,signal=>f.link.claimMaterialRecovery(ids.run,null,signal));assert.equal(result.run,ids.run);
 const identities=f.calls.filter(call=>call.sql.includes("set_config('backbone.workspace'"));
 assert.deepEqual(identities.map(call=>call.values?.[0]),[ids.workspace,ids.workspace,ids.workspace]);
 assert.deepEqual(identities[0].values,[ids.workspace,ids.system,'','']);
 assert.deepEqual(f.calls.find(call=>call.sql.includes('AS ledger_seq'))?.values,[ids.workspace,ids.run]);
 assert.deepEqual(f.calls.find(call=>call.sql.includes('AS material_recovery_lifecycle_clear'))?.values?.slice(0,2),[ids.workspace,ids.run]);
});
