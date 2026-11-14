import { waitFor } from '../../../scripts/lib/test-hang.ts';
import {upgradeMaterialClosureHardening} from '@backbone/core/db';
// Frozen legacy source and disposable databases only. No real data home is opened or migrated.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test,type TestContext} from 'node:test';
import pg from 'pg';
import {buildBaseline,materialGuardStep,upgradeMaterialGuard,verifyMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,upgradeSignatureLedger,upgradeMaterialClosure,verifyMaterialClosure} from '@backbone/core/db';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {inspectMaterialGuard} from '../../core/src/db/material-guard.ts';
import {inspectMaterialLink} from '../../core/src/db/material-link.ts';
import {captureMaterialClosureProfile} from '../../core/src/db/material-closure-profile.ts';
import {CoreLink,CoreRefusal} from '../src/composition/core.ts';
import {grantDoor,openGateway} from '../src/composition/gateway.ts';
import {freshDir,freshHome,open,value} from './helpers.ts';
import {writePlaintextVault} from '../src/keys/vault.ts';
import {legacyCoreDatabase} from './fixtures/legacy-core.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/material-guard-legacy.json',import.meta.url),'utf8'));
const legacySql=fixture.sqlLines.join('\n')+'\n';
const baseline=buildBaseline().sql;
const WORDS='Synthetic guarded statement';
const paused=(error:unknown)=>error instanceof CoreRefusal&&error.reason==='paused';
async function context(t:TestContext,legacy=true,historicalFresh=false){
 const home=freshHome();const url=dataHomeAdminUrl(home);const name=new URL(url).pathname.slice(1);
 assert.match(name,/^home_[a-f0-9]+$/);
 if(legacy)assert.equal(createHash('sha256').update(legacySql).digest('hex'),fixture.sqlSha256);
 const admin=legacy||historicalFresh?await legacyCoreDatabase(url,legacy?legacySql:baseline):new pg.Client({connectionString:url});
 if(!legacy&&!historicalFresh)await admin.connect();
 // Register before Core opens: a failed setup must not leave an idle client retaining the file.
 t.after(()=>admin.end());
 if(historicalFresh){
  // Independent fresh bootstrap at the released four-step boundary, before closure replaces it.
  for(const upgrade of [upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,upgradeSignatureLedger]){
   const status=await upgrade(admin,baseline);assert.equal(status.state,'verified',status.reason);
  }
 }
 const link=await CoreLink.open({home});
 t.after(async()=>{await link.close();await CoreLink.whenClosed(home);});
 return {home,link,admin,url};
}
async function candidate(link:CoreLink,kind='file'){
 const handle=await link.startRun(await link.createTask('Synthetic source upgrade'));
 const episode=await link.call<string>(link.system(),'SELECT gov.record_source($1,$2,$3,$5,$4,NULL)',[kind,'synthetic',WORDS,handle.run,kind==='message'?link.id.person:null]);
 const actor=link.runOf(handle);
 const id=await link.call<string>(actor,'SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)',[WORDS,JSON.stringify([{episode,excerpt:WORDS}]),link.id.agent,'synthetic']);
 return {id,episode,actor,handle};
}
async function request(link:CoreLink,id:string,actor:ReturnType<CoreLink['person']>){
 const idDecision=await link.call<string>(actor,'SELECT gov.request_promotion($1,$2,NULL,NULL)',[id,link.id.person]);
 const row=(await link.read<{proposal_hash:string}>(link.person(),'SELECT proposal_hash FROM app.decisions WHERE id=$1',[idDecision])).rows[0];
 return {id:idDecision,hash:row.proposal_hash};
}
async function snapshot(admin:pg.Client){
 const result:Record<string,unknown>={};
 for(const table of ['knowledge_candidates','decisions','verifications','ledger','ledger_heads','knowledge'])result[table]=(await admin.query(`SELECT to_jsonb(x) AS row FROM app.${table} x ORDER BY to_jsonb(x)::text`)).rows;
 result.queue=(await admin.query('SELECT to_jsonb(x) AS row FROM ops.verification_queue x ORDER BY to_jsonb(x)::text')).rows;
 return result;
}

test('fresh installed definitions qualify independently of history and are not PUBLIC executable',async t=>{
 const {link,admin}=await context(t,false);
 assert.equal(link.materialGuard.state,'verified');
 assert.equal((await verifyMaterialGuard(admin)).state,'verified');
 const exposed=(await admin.query("SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gov','sec') AND has_function_privilege('public',p.oid,'EXECUTE')")).rows;
 assert.deepEqual(exposed,[]);
 assert.ok(materialGuardStep(baseline));
 assert.deepEqual(materialGuardStep(baseline.replace(/\n/g,'\r\n')),materialGuardStep(baseline));
 assert.equal(materialGuardStep(baseline.replace('Source eligibility is independent','Changed reviewed eligibility is independent')),null);
});

test('one owned upgrade preserves pending evidence and decisions, pauses approval, permits rejection and is idempotent',async t=>{
 const {link,admin}=await context(t);assert.equal(link.materialGuard.state,'paused');
 const c=await candidate(link);const d=await request(link,c.id,c.actor);
 const before=await snapshot(admin);
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 assert.deepEqual(await snapshot(admin),before);
 assert.equal((await link.call(link.person(),'SELECT gov.may_decide($1)',[d.id])),false);
 await assert.rejects(link.call(link.person(),'SELECT gov.answer_decision($1,$2,$3,NULL)',[d.id,d.hash,'approved']),paused);
 assert.deepEqual(await snapshot(admin),before);
 assert.equal(await link.call(link.person(),'SELECT gov.answer_decision($1,$2,$3,NULL)',[d.id,d.hash,'rejected']),'rejected');
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 assert.equal((await admin.query("SELECT count(*)::int n FROM ops.schema_migrations WHERE version='material-source-guard-v1'")).rows[0].n,1);
});

test('legacy accepted material knowledge is withheld from recall and run views while person records remain',async t=>{
 const {link,admin}=await context(t);const blocked=await candidate(link);const bd=await request(link,blocked.id,blocked.actor);
 await link.call(link.person(),'SELECT gov.answer_decision($1,$2,$3,NULL)',[bd.id,bd.hash,'approved']);
 const good=await candidate(link,'message');const gd=await request(link,good.id,good.actor);
 await link.call(link.person(),'SELECT gov.answer_decision($1,$2,$3,NULL)',[gd.id,gd.hash,'approved']);
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 const run=await link.startRun(await link.createTask('Synthetic recall'));const actor=link.runOf(run);
 const recalled=(await link.read(actor,'SELECT * FROM gov.recall_knowledge($1,NULL,100)',[run.run])).rows;
 assert.equal(recalled.length,1);
 assert.deepEqual((await link.read<{candidate_id:string}>(actor,'SELECT candidate_id FROM app.knowledge')).rows.map(r=>r.candidate_id),[good.id]);
 assert.equal((await link.read(actor,'SELECT id FROM app.knowledge_candidates WHERE id=$1',[blocked.id])).rows.length,0);
 assert.equal((await link.read(actor,'SELECT id FROM app.decisions WHERE id=$1',[bd.id])).rows.length,0);
 assert.equal((await link.read(link.person(),'SELECT id FROM app.knowledge')).rows.length,2);
 assert.equal((await link.read(link.person(),'SELECT id FROM app.knowledge_candidates WHERE id=$1',[blocked.id])).rows.length,1);
 await assert.rejects(link.read(actor,'SELECT * FROM gov.eligible_knowledge_sources'),/permission denied/);
 const visible=(await link.read<{id:string}>(actor,'SELECT sec.visible_eligible_knowledge_sources() id')).rows.map(r=>r.id);
 assert.deepEqual(visible,[good.id]);
});

test('fresh and upgraded catalogues agree; concurrent installers serialize and external reopen is read only',async t=>{
 const legacy=await context(t);const fresh=await context(t,false,true);
 const other=new pg.Client({connectionString:legacy.url});await other.connect();t.after(()=>other.end());
 assert.deepEqual((await Promise.all([upgradeMaterialGuard(legacy.admin,baseline),upgradeMaterialGuard(other,baseline)])).map(r=>r.state),['verified','verified']);
 // Preserve exact released-profile equality at the independently assembled fresh four-step
 // boundary. Closure has not yet added its triggers/index or replaced the old helper.
 assert.equal((await upgradeMaterialLink(legacy.admin,baseline)).state,'verified');
 assert.equal((await upgradeMaterialEnforcement(legacy.admin,baseline)).state,'verified');
 assert.equal((await upgradeSignatureLedger(legacy.admin,baseline)).state,'verified');
 assert.deepEqual(await inspectMaterialGuard(legacy.admin),await inspectMaterialGuard(fresh.admin));
 assert.deepEqual(await inspectMaterialLink(legacy.admin),await inspectMaterialLink(fresh.admin));
 const allDefinitions=async(client:pg.Client)=>(await client.query("SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,pg_get_userbyid(p.proowner) owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('gov','sec','operator') ORDER BY 1")).rows;
 assert.deepEqual(await allDefinitions(legacy.admin),await allDefinitions(fresh.admin));
 // Append the real new step to both paths, retaining the full old and new catalogue families.
 for(const installed of [legacy,fresh]){
  const status=await upgradeMaterialClosure(installed.admin);assert.equal(status.state,'verified',status.reason);
  const hardening=await upgradeMaterialClosureHardening(installed.admin);assert.equal(hardening.state,'verified',hardening.reason);
  assert.equal((await verifyMaterialClosure(installed.admin)).state,'verified');
 }
 assert.deepEqual(await captureMaterialClosureProfile(legacy.admin),await captureMaterialClosureProfile(fresh.admin));
 const history=(await legacy.admin.query('SELECT * FROM ops.schema_migrations ORDER BY version')).rows;
 await legacy.link.close();await CoreLink.whenClosed(legacy.home);
 const reopened=await CoreLink.open({home:legacy.home});t.after(()=>reopened.close());
 assert.equal(reopened.materialGuard.state,'verified');
 assert.equal(reopened.materialLink.state,'verified');
 assert.equal(reopened.materialEnforcement.state,'verified');
 assert.deepEqual((await legacy.admin.query('SELECT * FROM ops.schema_migrations ORDER BY version')).rows,history);
});

test('unknown or tampered history pauses a home without DDL or losing ordinary work',async t=>{
 const {home,link,admin}=await context(t,false);
 await admin.query("INSERT INTO ops.schema_migrations(version,checksum) VALUES('unknown-future','0000000000000000000000000000000000000000000000000000000000000000')");
 const catalogue=await inspectMaterialGuard(admin);
 assert.equal((await verifyMaterialGuard(admin)).state,'paused');
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'paused');
 await link.close();await CoreLink.whenClosed(home);
 const reopened=await CoreLink.open({home});t.after(()=>reopened.close());
 assert.equal(reopened.materialGuard.state,'paused');
 assert.match(await reopened.createTask('Synthetic ordinary work'),/^[0-9a-f-]{36}$/);
 assert.throws(()=>reopened.requireMaterialGuard(),paused);
 assert.deepEqual(await inspectMaterialGuard(admin),catalogue);
});

test('failure after the first DDL rolls back all definitions and history, preserving pending rows',async t=>{
 const {link,admin}=await context(t);const c=await candidate(link);await request(link,c.id,c.actor);
 const before=await snapshot(admin);const catalogue=await inspectMaterialGuard(admin);
 const history=(await admin.query('SELECT * FROM ops.schema_migrations ORDER BY version')).rows;
 const query=admin.query.bind(admin);let injected=false;let faultCode:string|undefined;
 const fault=new Proxy(admin,{get(target,key){if(key!=='query')return Reflect.get(target,key);return (sql:string,...args:unknown[])=>{
  if(typeof sql==='string'&&sql.startsWith('SET LOCAL check_function_bodies=false;')){injected=true;sql=sql.replace('$$;',()=> '$$;\nSELECT 1/0;');}
  return query(sql,...args as []).catch(error=>{faultCode=error.code;throw error;});
 };}});
 assert.equal((await upgradeMaterialGuard(fault,baseline)).state,'paused');assert.equal(injected,true);assert.equal(faultCode,'22012');
 assert.deepEqual(await inspectMaterialGuard(admin),catalogue);
 assert.deepEqual(await snapshot(admin),before);
 assert.deepEqual((await admin.query('SELECT * FROM ops.schema_migrations ORDER BY version')).rows,history);
});

test('paused verifier work neither changes its receipt nor starves a later non-promotion question',async t=>{
 const {link,admin}=await context(t);
 const verifier=await link.call<string>(link.person(),"SELECT gov.create_agent('Synthetic verifier','verifier')");
 const c=await candidate(link);const d=await request(link,c.id,c.actor);
 const before=await snapshot(admin);
 // Purely synthetic effect: proposal creates a question, with no dispatcher or provider installed.
 await link.call(link.person(),'SELECT gov.classify_operations($1::jsonb)',[JSON.stringify([{operation:'synthetic.external_change',class:3,external:true}])]);
 const handle=await link.startRun(await link.createTask('Synthetic checker question'));
 const connection=await link.call<string>(link.person(),'SELECT gov.register_connection($1,$2,NULL,$3,$4)',['Synthetic personal server','synthetic','person','none']);
 await link.recordServerAnswer(handle,connection,'synthetic_read','Synthetic private response');
 await link.call(link.runOf(handle),'SELECT gov.propose_effect($1,$2,NULL,$3,$4,NULL,NULL,NULL,NULL,$5::jsonb,$6,NULL,$7)',[handle.run,handle.fence,'synthetic','synthetic.external_change','{}','Synthetic question only','synthetic-question']);
 const effectQuestion=(await link.read<{id:string}>(link.person(),"SELECT id FROM app.decisions WHERE subject_kind='effect' AND checker_kind='verifier'")).rows[0];
 assert.ok(effectQuestion);
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 const heldQueue=(await admin.query('SELECT * FROM ops.verification_queue WHERE decision_id=$1',[d.id])).rows;
 const unchanged=await snapshot(admin);
 await assert.rejects(link.call({workspace:link.id.workspace,principal:verifier},'SELECT gov.verifier_answer($1,$2,$3)',[d.id,'approved','Synthetic review']),paused);
 assert.deepEqual(await snapshot(admin),unchanged);
 const claimed=(await link.read<{decision_id:string}>({},"SELECT * FROM gov.claim_next_verification('synthetic-worker',1000)")).rows;
 assert.deepEqual(claimed.map(row=>row.decision_id),[effectQuestion.id]);
 assert.deepEqual((await admin.query('SELECT * FROM ops.verification_queue WHERE decision_id=$1',[d.id])).rows,heldQueue);
 assert.deepEqual((await admin.query('SELECT to_jsonb(x) AS row FROM app.verifications x')).rows,before.verifications);
});

test('trigger mutations, changed definitions and withdrawn source-input immutability are checked independently of history',async t=>{
 const {link,admin}=await context(t,false);const c=await candidate(link,'message');
 await assert.rejects(link.read(link.system(),'UPDATE app.episodes SET source_kind=$1 WHERE id=$2',['web',c.episode]),/permission denied/);
 for(const sql of [
  "UPDATE app.episodes SET source_kind='web' WHERE id=$1",
  "DELETE FROM app.episodes WHERE id=$1",
  'UPDATE app.knowledge_candidates SET run_id=NULL WHERE id=$1',
  'UPDATE app.ledger SET subject=subject',
  'TRUNCATE app.episodes','TRUNCATE app.knowledge_candidates','TRUNCATE app.ledger',
 ]){
  await admin.query('BEGIN');await admin.query('SET LOCAL ROLE backbone_gov');
  await admin.query("SELECT set_config('backbone.workspace',$1,true)",[link.id.workspace]);
  await assert.rejects(admin.query(sql,sql.includes('$1')?[sql.includes('knowledge_candidates')?c.id:c.episode]:[]),/frozen|permission denied/);
  await admin.query('ROLLBACK');
 }
 assert.equal((await verifyMaterialGuard(admin)).state,'verified');
 await admin.query('ALTER TABLE app.knowledge DISABLE TRIGGER material_source_guard');
 assert.equal((await verifyMaterialGuard(admin)).state,'paused');
 await admin.query('ALTER TABLE app.knowledge ENABLE TRIGGER material_source_guard');
 assert.equal((await verifyMaterialGuard(admin)).state,'verified');
 for (const signature of ['sec.t_principal()','sec.t_knowledge()']) {
  const original=(await admin.query('SELECT pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition;
  await admin.query(`CREATE OR REPLACE FUNCTION ${signature} RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RETURN NEW; END $$`);
  assert.equal((await verifyMaterialGuard(admin)).state,'paused',`${signature} cannot silently stop freezing predicate inputs`);
  await admin.query(original);
  assert.equal((await verifyMaterialGuard(admin)).state,'verified');
 }
 await admin.query("ALTER FUNCTION gov._promote(uuid,uuid,uuid) SECURITY INVOKER");
 assert.equal((await verifyMaterialGuard(admin)).state,'paused');
});

test('the insert barrier refuses a legacy promotion body independently of replaced approving functions',async t=>{
 const {link,admin}=await context(t);const c=await candidate(link);const d=await request(link,c.id,c.actor);
 const body=legacySql.match(/CREATE FUNCTION gov\._promote\([\s\S]*?\$\$;/)![0].replace('gov._promote(','pg_temp.legacy_promote(');
 await admin.query(body);await admin.query('ALTER FUNCTION pg_temp.legacy_promote(uuid,uuid,uuid) OWNER TO backbone_gov');
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 const before=await snapshot(admin);
 await admin.query("SELECT set_config('backbone.workspace',$1,false)",[link.id.workspace]);
 await assert.rejects(admin.query('SELECT pg_temp.legacy_promote($1,$2,$3)',[c.id,d.id,link.id.person]),/paused: promotion awaits source withdrawal verification/);
 assert.deepEqual(await snapshot(admin),before);
 // Negative control: without only this trigger, the exact old body can still insert the row.
 await admin.query('BEGIN');await admin.query('ALTER TABLE app.knowledge DISABLE TRIGGER material_source_guard');
 assert.ok((await admin.query('SELECT pg_temp.legacy_promote($1,$2,$3) id',[c.id,d.id,link.id.person])).rows[0].id);
 await admin.query('ROLLBACK');
 assert.deepEqual(await snapshot(admin),before);
 assert.equal((await verifyMaterialGuard(admin)).state,'verified');
});

test('a busy legacy approval keeps the upgrade atomic, then pre-guard knowledge is withheld after retry',async t=>{
 const {link,admin,url}=await context(t);const c=await candidate(link);const d=await request(link,c.id,c.actor);
 const inFlight=new pg.Client({connectionString:url});await inFlight.connect();t.after(()=>inFlight.end());
 await inFlight.query('BEGIN');await inFlight.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[link.id.workspace,link.id.person]);
 await inFlight.query('SELECT gov.answer_decision($1,$2,$3,NULL)',[d.id,d.hash,'approved']);
 const catalogue=await inspectMaterialGuard(admin);
 const result=await upgradeMaterialGuard(admin,baseline);
 assert.equal(result.state,'paused');assert.match(result.reason,/busy/);
 assert.deepEqual(await inspectMaterialGuard(admin),catalogue);
 assert.equal((await admin.query("SELECT count(*)::int n FROM ops.schema_migrations WHERE version<>'baseline'")).rows[0].n,0);
 await inFlight.query('COMMIT');
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 const run=await link.startRun(await link.createTask('Synthetic post-upgrade recall'));
 assert.deepEqual((await link.read(link.runOf(run),'SELECT * FROM gov.recall_knowledge($1,NULL,100)',[run.run])).rows,[]);
 assert.equal((await link.read(link.person(),'SELECT id FROM app.knowledge WHERE candidate_id=$1',[c.id])).rows.length,1);
});

test('a read committing concurrently with a proposal is ordered by the workspace ledger sequence',async t=>{
 const {link,admin,url}=await context(t,false);const run=await link.startRun(await link.createTask('Synthetic concurrent lineage'));
 const web=await link.call<string>(link.system(),"SELECT gov.record_source('web','synthetic',$1,NULL,$2,NULL)",[WORDS,run.run]);
 const reader=new pg.Client({connectionString:url});await reader.connect();t.after(()=>reader.end());
 await reader.query('BEGIN');await reader.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[link.id.workspace,link.id.system]);
 const file=(await reader.query("SELECT gov.record_source('file','synthetic concurrent',$1,NULL,$2,NULL) id",[WORDS,run.run])).rows[0].id;
 const proposer=new pg.Client({connectionString:url});await proposer.connect();t.after(()=>proposer.end());
 await proposer.query("SET application_name='synthetic-guard-lineage'");
 await proposer.query("SELECT set_config('backbone.workspace',$1,false),set_config('backbone.principal',$2,false),set_config('backbone.run',$3,false),set_config('backbone.secret',$4,false)",[link.id.workspace,link.id.agent,run.run,run.secret]);
 const proposing=proposer.query('SELECT gov.propose_candidate($1,$2::jsonb,$3,$4) id',[WORDS,JSON.stringify([{episode:web,excerpt:WORDS}]),link.id.agent,'synthetic']);
 let blocked=false;
 await waitFor(async()=>{
  blocked=(await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='synthetic-guard-lineage' AND wait_event_type='Lock'")).rows[0].n===1;
  if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
 return !!blocked;},'material-guard-upgrade: SQL lock observation',{diagnostic:()=>`blocked=${blocked}`});
 assert.equal(blocked,true,'the proposal genuinely waits for the uncommitted read');
 await reader.query('COMMIT');const id=(await proposing).rows[0].id;
 const rows=(await link.read<{subject:string;seq:string}>(link.person(),"SELECT subject,seq FROM app.ledger WHERE subject=ANY($1::text[]) ORDER BY seq",[[file,id]])).rows;
 assert.deepEqual(rows.map(row=>row.subject),[file,id]);
 await assert.rejects(request(link,id,link.runOf(run)),paused);
});

test('set-based recall cost at 10k episodes, 1k statements and 100 results is measured with its actual plan',async t=>{
 const {link,admin}=await context(t);const run=await link.startRun(await link.createTask('Synthetic benchmark'));
 await admin.query("SELECT set_config('backbone.workspace',$1,false)",[link.id.workspace]);
 // Scale fixture only: direct synthetic rows have placeholder ledger hashes. They test query cost,
 // not chain authenticity; authority, chaining and migration preservation have separate controls.
 await admin.query(`CREATE TEMP TABLE bench_runs AS SELECT i,gen_random_uuid() id,gen_random_uuid() candidate,gen_random_uuid() decision FROM generate_series(1,1000) i;
 INSERT INTO app.runs(workspace_id,id,task_id,agent_id,mandate_id,carrier)
 SELECT r.workspace_id,b.id,r.task_id,r.agent_id,r.mandate_id,r.carrier FROM app.runs r CROSS JOIN bench_runs b WHERE r.id='${run.run}';
 CREATE TEMP TABLE bench_sources AS SELECT step.i,gen_random_uuid() id,b.id run,b.i ordinal FROM bench_runs b CROSS JOIN generate_series(1,10) step(i);
 INSERT INTO app.episodes(workspace_id,id,source_kind,source_ref,trust,content,content_hash,recorded_by,run_id)
 SELECT '${link.id.workspace}',s.id,CASE WHEN ordinal%5=0 THEN 'message' ELSE 'file' END,'synthetic scale','trusted','Synthetic scale','synthetic','${link.id.system}',s.run FROM bench_sources s;
 INSERT INTO app.ledger(workspace_id,seq,entry_type,subject,prev_hash,hash)
 SELECT '${link.id.workspace}',100000+row_number() OVER(ORDER BY ordinal,i),'source.recorded',id::text,'synthetic','synthetic' FROM bench_sources;
 INSERT INTO app.knowledge_candidates(workspace_id,id,statement,topic,evidence,proposed_by,run_id,owner_id,status)
 SELECT '${link.id.workspace}',b.candidate,'Synthetic scale statement','synthetic',jsonb_build_array(jsonb_build_object('episode',s.id,'excerpt','Synthetic scale')),'${link.id.agent}',b.id,'${link.id.person}','accepted'
 FROM bench_runs b JOIN bench_sources s ON s.run=b.id AND s.i=1;
 INSERT INTO app.ledger(workspace_id,seq,entry_type,subject,prev_hash,hash)
 SELECT '${link.id.workspace}',200000+i,'knowledge.proposed',candidate::text,'synthetic','synthetic' FROM bench_runs;
 INSERT INTO app.decisions(workspace_id,id,subject_kind,subject_id,proposer_id,checker_kind,reason,proposal_hash,status)
 SELECT '${link.id.workspace}',decision,'promotion',candidate,'${link.id.agent}','person','promotion','synthetic','approved' FROM bench_runs;
 INSERT INTO app.knowledge(workspace_id,candidate_id,decision_id,statement,topic,owner_id,accepted_by)
 SELECT '${link.id.workspace}',candidate,decision,'Synthetic scale statement','synthetic','${link.id.person}','${link.id.person}' FROM bench_runs;
 ANALYZE app.episodes;ANALYZE app.ledger;ANALYZE app.knowledge_candidates;ANALYZE app.knowledge;`);
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 const probeRun=(await admin.query('SELECT id FROM bench_runs LIMIT 1')).rows[0].id;
 await admin.query('SET ROLE backbone_gov');
 const inner=baseline.match(/FOR k IN (SELECT x\.\* FROM app\.knowledge x[\s\S]*?) LOOP/)![1].replace(/\bp_words\b/g,'NULL::text[]').replace(/\bp_limit\b/g,'100');
 const samples:number[]=[];let plan:unknown;
 for(let i=0;i<8;i++){
  const explained=(await admin.query('EXPLAIN (ANALYZE,FORMAT JSON,COSTS OFF) '+inner)).rows[0]['QUERY PLAN'][0];
  if(i) samples.push(explained['Execution Time']);plan=explained;
 }
 const median=samples.sort((a,b)=>a-b)[Math.floor(samples.length/2)];
 t.diagnostic(JSON.stringify({episodes:10000,statements:1000,results:100,medianMs:median,samplesMs:samples,plan}));
 // Exact threshold belongs to the integrator's P1 decision. Report a slow run rather than hide it
 // by relaxing an assertion or swapping in a different query.
 assert.equal((await admin.query(inner)).rows.length,100);
 const membership=(await admin.query('EXPLAIN (ANALYZE,FORMAT JSON,COSTS OFF) SELECT * FROM app.episodes WHERE workspace_id=$1 AND run_id=$2',[link.id.workspace,probeRun])).rows[0]['QUERY PLAN'];
 assert.match(JSON.stringify(membership),/episodes_run_sources/);
 t.diagnostic(JSON.stringify({runSourceIndexPlan:membership,initialBudgetMs:7,reviewedBandCeilingMs:15}));
 assert.equal(membership[0].Plan['Actual Rows'],10);
 await admin.query('RESET ROLE');
});

test('person notices describe verified withholding and unverified pause without fake held documents',async t=>{
 for(const legacy of [false,true]){
  const {home}=await context(t,legacy);
  const write=process.stderr.write;const diagnostics:string[]=[];
  process.stderr.write=function(chunk,...args){if(String(chunk).startsWith('[core] '))diagnostics.push(String(chunk));return write.call(this,chunk,...args as []);};
  try {
  const {host}=open(home);
  const project=value(await host.call('projects.create',{name:'Synthetic notice',kind:'folder'}));
  const now=await host.call('work.now',{projectId:project.id});
  assert.equal(now.notices?.length,1);
  assert.equal(now.notices![0].code,'knowledge-source-guard');
  assert.match(now.notices![0].message,legacy?/promotion and recall are paused/:/Older knowledge.*withheld/);
  assert.deepEqual(now.needsYou,[]);assert.deepEqual(now.current,[]);
  await host.call('work.now',{projectId:project.id});
  assert.equal(diagnostics.length,legacy?1:0);
  if(legacy){const report=JSON.parse(diagnostics[0].slice('[core] '.length));assert.equal(report.materialGuard.state,'paused');assert.match(report.materialGuard.reason,/could not be inspected/);assert.deepEqual(Object.keys(report),['materialGuard']);}
  } finally {process.stderr.write=write;}
 }
});

test('the public eligibility set respects private audiences and workspace isolation',async t=>{
 const {link}=await context(t,false);
 const other=await link.call<string>(link.person(),"SELECT gov.identity_add_person('Synthetic colleague','synthetic-colleague@example.invalid','member')");
 const task=await link.createTask('Synthetic private source');const run=await link.startRun(task);
 // Both permitted kinds can still be private: audience remains a separate authority boundary.
 const message=await link.call<string>(link.system(),"SELECT gov.record_source('message','synthetic private',$1,$2,$3,$4)",[WORDS,link.id.person,run.run,task]);
 await link.call(link.system(),"SELECT gov.record_source('web','synthetic outside','Synthetic external words',NULL,$1,NULL)",[run.run]);
 const id=await link.call<string>(link.runOf(run),'SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)',[WORDS,JSON.stringify([{episode:message,excerpt:WORDS}]),link.id.agent,'synthetic']);
 assert.equal((await link.read<{kept:boolean}>(link.person(),'SELECT kept FROM app.knowledge_candidates WHERE id=$1',[id])).rows[0].kept,true);
 assert.deepEqual((await link.read<{id:string}>(link.person(),'SELECT sec.visible_eligible_knowledge_sources() id')).rows.map(row=>row.id),[id]);
 const colleague={workspace:link.id.workspace,principal:other};
 assert.deepEqual((await link.read(colleague,'SELECT sec.visible_eligible_knowledge_sources() id')).rows,[]);
 assert.deepEqual((await link.read(colleague,'SELECT id FROM app.knowledge_candidates WHERE id=$1',[id])).rows,[]);
 const second=await context(t,false);
 assert.deepEqual((await second.link.read(second.link.person(),'SELECT sec.visible_eligible_knowledge_sources() id')).rows,[]);
 assert.deepEqual((await second.link.read(second.link.person(),'SELECT id FROM app.knowledge_candidates WHERE id=$1',[id])).rows,[]);
});

test('an owned disposable legacy home upgrades on the actual Core-open path and reopens without replay',async t=>{
 const home=freshDir('backbone-owned-guard-');writePlaintextVault(home);
 let link=await CoreLink.open({home,baselineSql:legacySql.replace(/\n/g,'\r\n')});
 t.after(async()=>{await link.close();await CoreLink.whenClosed(home);});
 assert.equal(link.materialGuard.state,'paused');
 const c=await candidate(link);const d=await request(link,c.id,c.actor);
 const passwords=await link.vault.passwords().read();assert.ok(passwords);
 let admin=new pg.Client({connectionString:dataHomeAdminUrl(home,passwords)});await admin.connect();
 const before=await snapshot(admin);await admin.end();
 await link.close();await CoreLink.whenClosed(home);
 // The Team update of an existing folder is admitted only on the app main-process path.
 link=await CoreLink.open({home,allowIdentityUpgrade:true});assert.equal(link.materialGuard.state,'verified',link.materialGuard.reason);
 admin=new pg.Client({connectionString:dataHomeAdminUrl(home,passwords)});await admin.connect();
 try{
  const after=await snapshot(admin);
  // Owned open appends the signature boundary and then the closure boundary. Every
  // earlier ledger/business row remains byte-identical and both new chain links are checked.
  const entries=after.ledger as {row:{entry_type:string;seq:number;hash:string;prev_hash:string;workspace_id:string;actor_id:string|null;subject:string|null;payload:unknown}}[];
  const boundaries=entries.filter(x=>x.row.entry_type==='decision.basis_enabled');assert.equal(boundaries.length,1);
  const marker=boundaries[0].row,head=(before.ledger_heads as {row:{last_seq:number;last_hash:string}}[])[0].row;
  assert.deepEqual({workspace:marker.workspace_id,actor:marker.actor_id,subject:marker.subject,payload:marker.payload},
   {workspace:link.id.workspace,actor:null,subject:null,payload:{}});
  assert.equal(marker.seq,head.last_seq+1);assert.equal(marker.prev_hash,head.last_hash);
  const closures=entries.filter(x=>x.row.entry_type==='knowledge.dependencies_enabled');assert.equal(closures.length,1);
  const closure=closures[0].row;
  assert.deepEqual({workspace:closure.workspace_id,actor:closure.actor_id,subject:closure.subject,payload:closure.payload},
   {workspace:link.id.workspace,actor:null,subject:null,payload:{version:'material-closure-foundation-v1'}});
  assert.equal(closure.seq,marker.seq+1);assert.equal(closure.prev_hash,marker.hash);
  assert.deepEqual(after.ledger_heads,[{row:{workspace_id:link.id.workspace,last_seq:closure.seq,last_hash:closure.hash}}]);
  assert.deepEqual({...after,ledger:entries.filter(x=>x!==boundaries[0]&&x!==closures[0]),ledger_heads:before.ledger_heads},before);
  assert.equal(await link.call(link.person(),'SELECT gov.verify_ledger()'),null);
  assert.equal((await admin.query("SELECT count(*)::int n FROM ops.schema_migrations WHERE version='material-source-guard-v1'")).rows[0].n,1);
  await assert.rejects(link.call(link.person(),'SELECT gov.answer_decision($1,$2,$3,NULL)',[d.id,d.hash,'approved']),paused);
 }finally{await admin.end();}
 await link.close();await CoreLink.whenClosed(home);
 link=await CoreLink.open({home});assert.equal(link.materialGuard.state,'verified',link.materialGuard.reason);
});

test('terminating the disposable installer backend after its first DDL rolls back the whole guard',async t=>{
 const {link,admin,url}=await context(t);const c=await candidate(link);await request(link,c.id,c.actor);
 const before=await snapshot(admin);const catalogue=await inspectMaterialGuard(admin);
 const history=(await admin.query('SELECT * FROM ops.schema_migrations ORDER BY version')).rows;
 const worker=new pg.Client({connectionString:url});worker.on('error',()=>{});await worker.connect();t.after(()=>worker.end().catch(()=>{}));
 const pid=(await worker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await admin.query('SELECT pg_advisory_lock(1111573323,99)');
 try{
  const raw=worker.query.bind(worker);
  const instrumented=new Proxy(worker,{get(target,key){if(key!=='query')return Reflect.get(target,key);return(sql:string,...args:unknown[])=>{
   if(typeof sql==='string'&&sql.startsWith('SET LOCAL check_function_bodies=false;'))sql=sql.replace('$$;',()=> '$$;\nSELECT pg_advisory_lock(1111573323,99);');
   return raw(sql,...args as []);
  };}});
  const upgrading=upgradeMaterialGuard(instrumented,baseline);
  let blocked=false;
  await waitFor(async()=>{
   blocked=(await admin.query("SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1111573323 AND objid=99 AND NOT granted",[pid])).rows[0].n===1;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
  return !!blocked;},'material-guard-upgrade: SQL lock observation',{diagnostic:()=>`blocked=${blocked}`});
  assert.equal(blocked,true,'the installer reached its latch after the first DDL');
  assert.equal((await admin.query('SELECT pg_terminate_backend($1) stopped',[pid])).rows[0].stopped,true);
  assert.equal((await upgrading).state,'paused');
 }finally{await admin.query('SELECT pg_advisory_unlock(1111573323,99)');}
 assert.deepEqual(await inspectMaterialGuard(admin),catalogue);
 assert.deepEqual(await snapshot(admin),before);
 assert.deepEqual((await admin.query('SELECT * FROM ops.schema_migrations ORDER BY version')).rows,history);
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
});

test('the actual gateway refuses unverified recall plainly and preserves the verified coverage notice',async t=>{
 for(const tampered of [false,true]){
  const {home,admin}=await context(t,false);
  await grantDoor({home,name:'synthetic-source-check',operations:['outbox.write'],ceiling:3});
  if(tampered)await admin.query("UPDATE ops.schema_migrations SET checksum='unknown' WHERE version='baseline'");
  const gateway=await openGateway({home,grant:'synthetic-source-check'});t.after(()=>gateway.close());
  const result=await gateway.call('knowledge.recall',{});
  if(tampered){
   assert.equal(result.ok,false);
   if(!result.ok){assert.equal(result.reason,'NOT_AVAILABLE');assert.match(result.detail,/promotion and recall are paused/);}
   assert.equal((await gateway.call('effects.list',{})).ok,true,'unrelated reads still work');
  }else{
   assert.equal(result.ok,true);
   if(result.ok){assert.deepEqual(result.value,[]);assert.equal(result.notice?.kind,'source-withheld');assert.match(result.notice.detail,/Older knowledge.*withheld/);}
  }
 }
});
