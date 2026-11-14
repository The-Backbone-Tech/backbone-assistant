import { waitFor } from '../../../scripts/lib/test-hang.ts';
import {upgradeMaterialClosureHardening,materialClosureHardeningStep,MATERIAL_CLOSURE_HARDENING_VERSION} from '@backbone/core/db';
// Native authority/timing qualification. Prepared source-only: run only after frozen Kernel review.
// Every database/home is disposable. Provider transport is never used by these controls.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {test,type TestContext} from 'node:test';
import pg from 'pg';
import {buildBaseline,baselineFiles,enter,materialGuardStep,materialLinkStep,materialEnforcementStep,MATERIAL_ENFORCEMENT_VERSION,upgradeMaterialGuard,upgradeMaterialLink,
 upgradeMaterialEnforcement,verifyMaterialEnforcement,upgradeMaterialClosure,verifyMaterialClosure,materialClosureStep,MATERIAL_CLOSURE_VERSION,signatureLedgerStep,SIGNATURE_LEDGER_VERSION,upgradeSignatureLedger,type Actor} from '@backbone/core/db';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {writeDurable} from '@backbone-next/kernel/files';
import {inspectMaterialEnforcement,materialEnforcementCatalogueState} from '../../core/src/db/material-enforcement-catalogue.ts';
import {inspectMaterialLink} from '../../core/src/db/material-link.ts';
import {captureMaterialClosureProfile} from '../../core/src/db/material-closure-profile.ts';
import {CORE_SCHEMA_UPGRADES,baselineObject} from '../../core/src/db/schema-migrations.ts';
import {CoreLink,CoreRefusal,MaterialCommitUnknown,type MaterialReadTentative,type MaterialSourceReadRequest} from '../src/composition/core.ts';
import {withHomeLock} from '../src/composition/home-lock.ts';
import {issueChildMandate} from '../src/composition/parallel-work.ts';
import {freshHome} from './helpers.ts';
import {legacyCoreDatabase} from './fixtures/legacy-core.ts';
import {signatureLedgerBodyFixtures} from './signature-ledger-body-fixtures.ts';
import {upgradeIdentity} from '../../core/src/db/identity.ts';
import {upgradeIdentityWork} from '../../core/src/db/identity-work.ts';
import {upgradeIdentityRoleRevocation} from '../../core/src/db/identity-role-revocation.ts';
import {upgradeIdentityResource} from '../../core/src/db/identity-resource.ts';
import {upgradeIdentityAdmission} from '../../core/src/db/identity-admission.ts';
import {upgradeIdentityGuarantees} from '../../core/src/db/identity-guarantees.ts';
import {upgradeIdentityPlatform} from '../../core/src/db/identity-platform.ts';
import {upgradeIdentityHardening,IDENTITY_HARDENING_RELEASES} from '../../core/src/db/identity-hardening.ts';
import {captureIdentity} from '../../core/src/db/identity-catalogue.ts';
import {verifyIdentityRuntime} from '../../core/src/db/identity-runtime.ts';
import {MATERIAL_CLOSURE_RELEASE as identityRelease0} from '../../core/src/db/identity-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as identityRelease1} from '../../core/src/db/identity-work-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as identityRelease2} from '../../core/src/db/identity-role-revocation-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as identityRelease3} from '../../core/src/db/identity-resource-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as identityRelease4} from '../../core/src/db/identity-admission-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as identityRelease5} from '../../core/src/db/identity-guarantees-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as identityRelease6} from '../../core/src/db/identity-platform-release.generated.ts';
const identityUpgrades=[upgradeIdentity,upgradeIdentityWork,upgradeIdentityRoleRevocation,upgradeIdentityResource,upgradeIdentityAdmission,upgradeIdentityGuarantees,upgradeIdentityPlatform,upgradeIdentityHardening];
const identityReleases=[identityRelease0,identityRelease1,identityRelease2,identityRelease3,identityRelease4,identityRelease5,identityRelease6,...IDENTITY_HARDENING_RELEASES];

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const BASELINE=buildBaseline().sql;
const READ='SELECT * FROM gov.record_material_source_read($1::text,$2::text,$3::integer,$4::integer,$5::text,$6::text,$7::jsonb,$8::text,$9::text,$10::text,$11::uuid,$12::uuid,$13::uuid,$14::uuid,$15::text)';
const WITHDRAW='SELECT gov.withdraw_material_source($1::text,$2::text,$3::text,$4::integer,$5::integer,$6::text)';
const SOURCE="SELECT gov.record_source('file',$1::text,$2::text,NULL,$3::uuid,NULL) AS episode";
const SERVER='SELECT gov.record_server_answer($1::uuid,$2::uuid,$3::text,$4::text) AS episode';
const WHEN='material_source_receipt';
interface NativeRead {project:string;material:string;version:number;generation:number;key:string;original:string;kind:'file'|'mcp';episode:string;prepared:string;run:string;connection:string|null;tool:string|null}
interface Receipt {episode_id:string;receipt_id:string}
const values=(r:NativeRead)=>[r.project,r.material,r.version,r.generation,r.key,r.original,
 JSON.stringify({kind:'synthetic-native-preparation',version:'1'}),r.kind,r.episode,r.prepared,null,r.run,null,r.connection,r.tool];
const withdrawal=(r:NativeRead)=>[r.project,r.material,digest(`withdraw:${r.material}:${r.generation}`),r.generation+1,r.version,'2026-11-09T12:00:00.000Z'];

async function context(t:TestContext,legacy:boolean|'released-70c6d0e'|'historical-fresh'=false){
 const home=freshHome(),url=dataHomeAdminUrl(home);
 let admin:pg.Client,opened:CoreLink|undefined;
 t.after(async()=>{if(opened){await opened.close();await CoreLink.whenClosed(home);}if(admin)await admin.end();});
 if(legacy==='historical-fresh'){
  // The fresh bootstrap is independently assembled at the historical exact-profile boundary.
  admin=await legacyCoreDatabase(url,BASELINE);
  for(const upgrade of [upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,upgradeSignatureLedger]){
   const status=await upgrade(admin,BASELINE);assert.equal(status.state,'verified',status.reason);
  }
 }else if(legacy){
  const fixtureFile=legacy==='released-70c6d0e'?'./fixtures/material-enforcement-release-70c6d0e.json':'./fixtures/material-guard-legacy.json';
  const fixtureText=readFileSync(new URL(fixtureFile,import.meta.url),'utf8');
  if(legacy==='released-70c6d0e')assert.equal(digest(fixtureText),'5e806ba5a50bb692a3247ab6a7301beec2004a00e5b89b3cb1140ad3cfb2c4eb');
  const fixture=JSON.parse(fixtureText);
  if(legacy==='released-70c6d0e')assert.equal(fixture.sourceCommit,'70c6d0e7e2c5ad9d85c6762a650c8fd3db46c97d');
  const sql=fixture.sqlLines.join('\n')+'\n';assert.equal(digest(sql),fixture.sqlSha256);
  admin=await legacyCoreDatabase(url,sql);
  if(legacy==='released-70c6d0e'){
   assert.equal((await upgradeMaterialGuard(admin,sql)).state,'verified');
   assert.equal((await upgradeMaterialLink(admin,sql)).state,'verified');
   assert.deepEqual((await admin.query("SELECT version,checksum FROM ops.schema_migrations WHERE version<>'baseline' ORDER BY version")).rows,
    [{version:'material-source-guard-v1',checksum:fixture.guardStepChecksum},{version:'material-source-link-v1',checksum:fixture.linkStepChecksum}]);
  }
 }else{
  admin=new pg.Client({connectionString:url});await admin.connect();
  // Repeat real owned admission idempotently even when the shared template has its receipts.
  // Historical sources below use their actual released installers; no row is fabricated.
  assert.equal((await upgradeMaterialGuard(admin,BASELINE)).state,'verified');
  assert.equal((await upgradeMaterialLink(admin,BASELINE)).state,'verified');
  assert.equal((await upgradeMaterialEnforcement(admin,BASELINE)).state,'verified');
 }
 const link=opened=await CoreLink.open({home});
 const task=await link.createTask('Native material enforcement control'),handle=await link.startRun(task);
 const connection=await link.call<string>(link.person(),"SELECT gov.register_connection('Synthetic server','synthetic',NULL,'person','none')");
 const read=(overrides:Partial<NativeRead>={}):NativeRead=>{
  const material=`synthetic:${randomUUID()}`;
  return {project:'synthetic-project',material,version:1,generation:0,key:digest(`read:${material}`),original:digest('original bytes'),
   kind:'file',episode:'Synthetic episode text',prepared:'Synthetic prepared text',run:handle.run,connection:null,tool:null,...overrides};
 };
 // Fixture transport limits are hang guards under parallel SQL load, never latency assertions.
 const connect=async()=>{
  const {appUrl}=JSON.parse(readFileSync(join(home,'pg','external.json'),'utf8')) as {appUrl:string};
  const client=new pg.Client({connectionString:appUrl,connectionTimeoutMillis:180_000,query_timeout:300_000});
  await client.connect();client.on('error',()=>{});t.after(()=>client.end().catch(()=>{}));
  const role=(await client.query('SELECT current_user AS role,session_user AS login')).rows[0];
  assert.deepEqual(role,{role:'backbone_app',login:'backbone_app'});
  assert.deepEqual((await client.query('SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user')).rows,[{rolsuper:false,rolbypassrls:false}]);
  return client;
 };
 return {home,url,admin,link,task,handle,connection,read,connect};
}
type Context=Awaited<ReturnType<typeof context>>;
async function identity(client:pg.Client,actor:Actor){
 await client.query(`SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true),
  set_config('backbone.run',$3,true),set_config('backbone.secret',$4,true)`,[actor.workspace??'',actor.principal??'',actor.run?.id??'',actor.run?.secret??'']);
}
async function begin(c:Context,client:pg.Client,isolation='READ COMMITTED'){
 assert.ok(['READ COMMITTED','REPEATABLE READ','SERIALIZABLE'].includes(isolation));
 await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);await identity(client,c.link.system());
 await client.query("SET LOCAL statement_timeout='240s'; SET LOCAL lock_timeout='180s'");
}
async function commit(client:pg.Client){assert.equal((await client.query('COMMIT')).command,'COMMIT');}
async function rollback(client:pg.Client){await client.query('ROLLBACK').catch(()=>{});}
async function typed(c:Context,r:NativeRead):Promise<Receipt>{
 const client=await c.connect();try{await begin(c,client);const row=(await client.query<Receipt>(READ,values(r))).rows[0];await commit(client);return row;}finally{await rollback(client);await client.end();}
}
async function snapshot(c:Context,tables=['episodes','material_source_identities','material_source_reads','material_source_withdrawals','ledger','ledger_heads','runs']){
 const output:Record<string,unknown>={};
 for(const table of tables)
  output[table]=(await c.admin.query(`SELECT to_jsonb(x) AS row FROM app.${table} x ORDER BY to_jsonb(x)::text`)).rows;
 return output;
}
const paused=(error:unknown)=>error instanceof Error&&/^paused: /.test(error.message);
async function state(c:Context,episode:string){
 await enter(c.admin,c.link.system());
 try{await c.admin.query('SET LOCAL ROLE backbone_gov');return (await c.admin.query('SELECT gov._material_source_state($1::uuid) AS state',[episode])).rows[0].state;}
 finally{await rollback(c.admin);}
}
const request=(r:NativeRead):MaterialSourceReadRequest=>({project:r.project,material:r.material,version:r.version,generation:r.generation,
 readKey:r.key,originalSha256:r.original,sourceKind:r.kind,episodeContent:r.episode,preparedText:r.prepared,authoredBy:null,
 transformation:{kind:'synthetic-native-preparation',version:'1'},...(r.connection?{connection:r.connection,tool:r.tool!}:{})});

// The published step assemblers stay frozen. Any future unpublished step must declare its
// assembler here; every PL/pgSQL function found in that exact SQL must have an actual invocation.
test('unpublished-step PL/pgSQL bodies compile from exact canonical CREATE OR REPLACE and run inside rollback-only fixtures',async t=>{
 const c=await context(t),published=new Set(['material-source-guard-v1','material-source-link-v1']);
 const unpublished=CORE_SCHEMA_UPGRADES.filter(step=>!published.has(step.version));
 const assemblers=new Map<string,(baseline:string)=>{sql:string;checksum:string}|null>([[MATERIAL_ENFORCEMENT_VERSION,materialEnforcementStep],[SIGNATURE_LEDGER_VERSION,signatureLedgerStep],[MATERIAL_CLOSURE_VERSION,materialClosureStep],
  [MATERIAL_CLOSURE_HARDENING_VERSION,materialClosureHardeningStep]]);
 for(const release of identityReleases)assemblers.set(release.version,()=>release);
 const invoke=new Map<string,()=>Promise<void>>([
  ['gov._material_source_state',async()=>{
   const result=await c.admin.query('SELECT gov._material_source_state(NULL::uuid) AS state');
   assert.deepEqual(result.rows,[{state:'unknown'}]);
  }],
  ['sec.t_material_episode_source',async()=>{
   await identity(c.admin,c.link.system());
   const result=await c.admin.query<Receipt>(READ,values(c.read()));assert.equal(result.rows.length,1);
   // This is an actual episode INSERT with its own typed binding. The constraint is advanced
   // explicitly so the new trigger executes before this rollback-only fixture ends.
   await c.admin.query('SET CONSTRAINTS ALL IMMEDIATE');
   const state=(await c.admin.query('SELECT gov._material_source_state($1::uuid) AS state',[result.rows[0].episode_id])).rows[0].state;
   assert.equal(state,'live');
   // Prove the replaced trigger actually executes, independently of the direct state call.
   // Its unbound sibling must refuse at explicit validation; the outer finally rolls back all.
   await c.admin.query('SET CONSTRAINTS ALL DEFERRED');
   await c.admin.query(SOURCE,[`material:compile-unbound-${randomUUID()}@v1`,'Synthetic unbound compiler control',c.handle.run]);
   await assert.rejects(c.admin.query('SET CONSTRAINTS ALL IMMEDIATE'),paused);
  }],
 ]);
 for(const [name,fixture] of signatureLedgerBodyFixtures(c.admin,c.link,c.connection))invoke.set(name,fixture);
 // The new step has its own canonical version files; no old function or fixture is dropped.
 const proposeClosure=async()=>{
  await identity(c.admin,c.link.system());
  const words='Synthetic closure body-validation message';
  const source=(await c.admin.query("SELECT gov.record_source('message','body-fixture',$1,$2,$3,$4) AS episode",[words,c.link.id.person,c.handle.run,c.task])).rows[0].episode;
  await identity(c.admin,c.link.runOf(c.handle));
  const candidate=(await c.admin.query('SELECT gov.propose_candidate($1,$2::jsonb,$3,$4) AS candidate',[words,JSON.stringify([{episode:source,excerpt:words}]),c.link.id.agent,'body-fixture'])).rows[0].candidate;
  assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.knowledge_candidate_inputs WHERE candidate_id=$1',[candidate])).rows[0].n,1);
  return candidate;
 };
 invoke.set('gov._material_source_projection',async()=>{assert.deepEqual((await c.admin.query('SELECT gov._material_source_projection(NULL::uuid) AS state')).rows,[{state:'unknown'}]);});
 invoke.set('gov._create_workspace',async()=>{
  await identity(c.admin,{workspace:'',principal:''});
  const made=(await c.admin.query("SELECT * FROM gov._create_workspace('Body fixture','team','Owner','body@fixture.invalid')")).rows[0];
  assert.ok(made.workspace_id);assert.equal((await c.admin.query("SELECT count(*)::int AS n FROM app.ledger WHERE workspace_id=$1 AND entry_type='knowledge.dependencies_enabled'",[made.workspace_id])).rows[0].n,1);
 });
 invoke.set('gov._personal_message_inputs_v1',async()=>{assert.equal((await c.admin.query("SELECT gov._personal_message_inputs_v1(NULL::app.knowledge_candidates,NULL::uuid,1::bigint)->>'state' AS state")).rows[0].state,'unknown');});
 invoke.set('gov._personal_message_roots_v1',async()=>{assert.equal((await c.admin.query("SELECT gov._personal_message_roots_v1(NULL::uuid,NULL::uuid)->>'state' AS state")).rows[0].state,'unknown');});
 invoke.set('gov._knowledge_personal_closure_v1',async()=>{assert.equal((await c.admin.query("SELECT gov._knowledge_personal_closure_v1(NULL::uuid,NULL::uuid)->>'state' AS state")).rows[0].state,'unknown');});
 invoke.set('gov._candidate_input_manifest_v1',async()=>{await assert.rejects(c.admin.query('SELECT gov._candidate_input_manifest_v1(NULL::app.knowledge_candidates,1::bigint)'),/^error: paused: input snapshot requires native workspace and ledger cut/);});
 invoke.set('sec.t_candidate_input_capture_v1',async()=>{await proposeClosure();});
 invoke.set('sec.t_candidate_input_structure',async()=>{await proposeClosure();await c.admin.query('SET CONSTRAINTS ALL IMMEDIATE');});
 invoke.set('gov.recall_knowledge_traced_v1',async()=>{await assert.rejects(c.admin.query('SELECT * FROM gov.recall_knowledge_traced_v1(NULL::uuid,1::bigint,ARRAY[]::text[],1)'),/^error: invalid: traced recall requires a run/);});


 // Explicit C1 calls exercise every additional PL/pgSQL definition, including
 // historical replacements. Refusals must have the native class, not SQL errors.
 const person=c.link.person();
 const value=async(sql:string,params:unknown[],expected:unknown)=>{
  await identity(c.admin,person);
  assert.deepEqual((await c.admin.query(sql,params)).rows,[{value:expected}]);
 };
 const refuses=async(sql:string,reason:string,empty=false)=>{
  await identity(c.admin,empty?{workspace:person.workspace,principal:''}:person);
  await assert.rejects(c.admin.query(sql),(error:unknown)=>error instanceof Error&&error.message.startsWith(reason+':'));
 };
 const scalars:[string,string,unknown[],unknown][]=[
  ['gov._mandate_standing','SELECT gov._mandate_standing(NULL) AS value',[],'mandate_revoked'],
  ['gov._promotion_sources_allowed','SELECT gov._promotion_sources_allowed(NULL) AS value',[],false],
  ['gov.identity_effect_owner','SELECT gov.identity_effect_owner(NULL) AS value',[],null],
  ['gov.identity_task_exists','SELECT gov.identity_task_exists($1) AS value',[c.task],true],
  ['gov.identity_document_access','SELECT gov.identity_document_access(NULL,false) AS value',[],false],
  ['gov.identity_material_scope','SELECT gov.identity_material_scope(NULL,false) AS value',[],true],
  ['gov.identity_project_access','SELECT gov.identity_project_access(NULL) AS value',[],null],
  ['gov.identity_task_access','SELECT gov.identity_task_access($1,true) AS value',[c.task],true],
  ['gov.identity_person_task_access','SELECT gov.identity_person_task_access($1,$2,true) AS value',[c.task,c.link.id.person],true],
  ['gov.identity_run_access','SELECT gov.identity_run_access(NULL,false) AS value',[],false],
  ['gov.identity_run_accounting','SELECT gov.identity_run_accounting(NULL) AS value',[],false],
  ['gov.identity_directory_delete','SELECT gov.identity_directory_delete(NULL,NULL,NULL) AS value',[],null],
  ['gov.identity_sign_out','SELECT gov.identity_sign_out(NULL) AS value',[],false],
  ['gov.identity_bind_task','SELECT gov.identity_bind_task($1,$1) AS value',[c.task],c.task],
  ['gov.identity_register_project','SELECT gov.identity_register_project($1) AS value',[c.task],c.task],
 ];
 for(const [name,sql,params,expected] of scalars)invoke.set(name,()=>value(sql,params,expected));
 const refusals:[string,string,string,boolean?][]=[
  ['gov._may_answer',"SELECT gov._may_answer(NULL,NULL,'approved')",'no_identity'],
  ['gov.unregister_piece','SELECT gov.unregister_piece(NULL)','not_found'],
  ['gov.propose_undo','SELECT gov.propose_undo(NULL,NULL,NULL,NULL,NULL)','not_found'],
  ['gov.queue_run','SELECT gov.queue_run(NULL,NULL,NULL,NULL,NULL)','not_found'],
  ['gov.claim_run',"SELECT * FROM gov.claim_run(NULL,'body-fixture',1,'direct',NULL)",'not_found',true],
  ['gov.identity_cancel_mandate_work','SELECT gov.identity_cancel_mandate_work(NULL,NULL)','denied'],
  ['gov.identity_create_task',"SELECT gov.identity_create_task(NULL,'body fixture')",'denied'],
  ['gov.join_channel_thread','SELECT gov.join_channel_thread(NULL,NULL)','not_found'],
  ['gov.revoke_mandate','SELECT gov.revoke_mandate(NULL)','not_found'],
  ['gov.share_task','SELECT gov.share_task(NULL)','not_found'],
  ['gov.identity_project_share',"SELECT gov.identity_project_share(NULL,NULL,'viewer')",'denied'],
  ['gov.identity_accept','SELECT gov.identity_accept(NULL,NULL,NULL,NULL,NULL)','invitation',true],
  ['gov.identity_change_role',"SELECT gov.identity_change_role(NULL,'member')",'not_found'],
  ['gov.identity_invite',"SELECT gov.identity_invite('invalid','member',NULL)",'invalid'],
  ['gov.identity_remove','SELECT gov.identity_remove(NULL)','not_found'],
  ['gov.identity_sign_in','SELECT gov.identity_sign_in(NULL,NULL,NULL)','no_identity',true],
  ['gov.identity_automation_create','SELECT gov.identity_automation_create(NULL,NULL,NULL,NULL)','denied'],
  ['gov.identity_automation_revoke','SELECT gov.identity_automation_revoke(NULL)','not_found'],
  ['gov.identity_directory_create','SELECT gov.identity_directory_create(NULL,NULL,NULL,NULL)','invalid'],
  ['gov.identity_directory_update','SELECT gov.identity_directory_update(NULL,NULL,NULL,NULL,NULL)','not_found'],
  ['gov.identity_document_version','SELECT gov.identity_document_version(NULL,NULL)','denied'],
  ['gov.identity_project_sharing','SELECT * FROM gov.identity_project_sharing(NULL)','denied'],
  ['gov.identity_revise_document','SELECT gov.identity_revise_document(NULL,NULL,NULL,NULL)','denied'],
  // Identity hardening: role closure, invitation closure and device recovery/current-facts crossings.
  ['gov.add_person','SELECT gov.add_person(NULL,NULL,NULL)','invalid'],
  ['gov.identity_add_person','SELECT gov.identity_add_person(NULL,NULL,NULL)','invalid'],
  ['gov.change_role',"SELECT gov.change_role(NULL,'member')",'not_found'],
  ['gov.accept_invitation','SELECT * FROM gov.accept_invitation(NULL,NULL)','empty_session_only'],
  ['gov.identity_accept_legacy','SELECT * FROM gov.identity_accept_legacy(NULL,NULL)','empty_session_only'],
  ['operator.identity_device_only','SELECT operator.identity_device_only(NULL)','denied'],
  ['operator.identity_restore_device_access','SELECT operator.identity_restore_device_access(NULL)','denied'],
 ];
 for(const [name,sql,reason,empty] of refusals)invoke.set(name,()=>refuses(sql,reason,empty));
 for(const [name,sql] of [
  ['gov.claim_next_effect',"SELECT * FROM gov.claim_next_effect('body-fixture',0)"],
  ['gov.claim_next_verification',"SELECT * FROM gov.claim_next_verification('body-fixture',0)"],
  ['gov.claim_next_run',"SELECT * FROM gov.claim_next_run('body-fixture',1,NULL,NULL)"],
 ])invoke.set(name,async()=>{
  await identity(c.admin,{workspace:'',principal:''});
  await assert.rejects(c.admin.query(sql),(error:unknown)=>error instanceof Error&&error.message.startsWith('invalid:'));
 });
 invoke.set('gov._quote_run',async()=>{await identity(c.admin,person);assert.equal((await c.admin.query('SELECT gov._quote_run(NULL,NULL)')).rowCount,1);});
 invoke.set('gov.quote_marks',async()=>{await identity(c.admin,c.link.runOf(c.handle));assert.equal((await c.admin.query("SELECT gov.quote_marks($1,'{}')",[c.handle.run])).rowCount,1);});
 invoke.set('gov.propose_candidate',async()=>{await proposeClosure();});
 invoke.set('gov.identity_budget_totals',async()=>{
  await identity(c.admin,person);
  assert.deepEqual((await c.admin.query('SELECT tokens::int,cost::int,effects::int FROM gov.identity_budget_totals(NULL)')).rows,[{tokens:0,cost:0,effects:0}]);
 });
 invoke.set('gov.identity_project_create',async()=>{
  const project=randomUUID();await value('SELECT gov.identity_project_create($1) AS value',[project],project);
  assert.deepEqual((await c.admin.query('SELECT owner_id FROM app.identity_projects WHERE workspace_id=$1 AND project_id=$2',[c.link.id.workspace,project])).rows,[{owner_id:c.link.id.person}]);
 });
 invoke.set('gov.identity_people',async()=>{
  await identity(c.admin,person);const rows=(await c.admin.query('SELECT * FROM gov.identity_people()')).rows;
  assert.ok(rows.some(row=>row.id===c.link.id.person&&row.role==='owner'&&row.status==='active'));
 });
 invoke.set('gov.identity_runtime',async()=>{
  await identity(c.admin,person);const row=(await c.admin.query('SELECT * FROM gov.identity_runtime(NULL)')).rows[0];
  assert.ok(row.agent&&row.mandate);assert.equal((await c.admin.query('SELECT gov._mandate_standing($1) AS value',[row.mandate])).rows[0].value,'ok');
 });
 for(const [name,sql] of [
  ['gov.identity_automations','SELECT * FROM gov.identity_automations()'],
  ['gov.identity_directory_list','SELECT * FROM gov.identity_directory_list(NULL)'],
  ['gov.identity_session','SELECT * FROM gov.identity_session(NULL)'],
 ])invoke.set(name,async()=>{await identity(c.admin,person);assert.deepEqual((await c.admin.query(sql)).rows,[]);});
 invoke.set('gov.identity_bind_new_task',async()=>{
  await identity(c.admin,person);
  const task=(await c.admin.query("SELECT gov.create_task($1,$1,'body trigger fixture',NULL,NULL) AS id",[c.link.id.person])).rows[0].id;
  assert.deepEqual((await c.admin.query('SELECT project_id FROM app.identity_task_projects WHERE workspace_id=$1 AND task_id=$2',[c.link.id.workspace,task])).rows,[{project_id:task}]);
 });
 invoke.set('sec.t_identity_mutation_context',async()=>{
  await identity(c.admin,{workspace:c.link.id.workspace,principal:''});
  await assert.rejects(c.admin.query('UPDATE app.episodes SET content=content WHERE false'),(error:unknown)=>error instanceof Error&&error.message.startsWith('frozen:'));
 });

 const plans:{step:string;file:string;name:string;block:string}[]=[];
 for(const descriptor of unpublished){
  const assemble=assemblers.get(descriptor.version);assert.ok(assemble,`Unpublished step ${descriptor.version} lacks a body-validation assembler`);
  const step=assemble(BASELINE);assert.ok(step);assert.equal(step.checksum,descriptor.checksum);
  const declared=[...step.sql.matchAll(/^CREATE(?: OR REPLACE)? FUNCTION\s+([A-Za-z_][\w.]+)\s*\(/gim)].map(match=>match[1].toLowerCase());
  const included:{file:string;name:string;block:string;plpgsql:boolean}[]=[];
  const canonical=baselineFiles().map(file=>({file,block:baselineObject(BASELINE,file)}));
  if([MATERIAL_CLOSURE_VERSION,MATERIAL_CLOSURE_HARDENING_VERSION,...identityReleases.map(release=>release.version)].includes(descriptor.version)){
   const prefix=`versions/${descriptor.version}/`;
   const manifest=JSON.parse(readFileSync(new URL('../../core/schema/'+prefix+'manifest.json',import.meta.url),'utf8'));
   for(const section of manifest.sections)for(const source of section.files){
    const file=prefix+source.path;canonical.push({file,block:readFileSync(new URL('../../core/schema/'+file,import.meta.url),'utf8').replace(/\r\n/g,'\n').trim()});
   }
  }
  for(const {file,block} of canonical){
   if(!block)continue;
   const definitions=[...block.matchAll(/^CREATE(?: OR REPLACE)? FUNCTION\s+([A-Za-z_][\w.]+)\s*\(/gim)];if(!definitions.length)continue;
   const replaced=block.replace(/^CREATE(?: OR REPLACE)? FUNCTION\s+/im,'CREATE OR REPLACE FUNCTION ');
   if(!step.sql.includes(block)&&!step.sql.includes(replaced))continue;
   assert.equal(definitions.length,1,`Canonical function block ${file} must identify exactly one definition`);
   const body=block.search(/\bAS\s+\$[A-Za-z_0-9]*\$/i);assert.ok(body>=0,`Canonical function ${file} lacks a recognized body delimiter`);
   included.push({file,name:definitions[0][1].toLowerCase(),block,plpgsql:/\bLANGUAGE\s+plpgsql\b/i.test(block.slice(definitions[0].index,body))});
  }
  // A closed version may re-issue a baseline body unchanged before its own grants; then the
  // baseline bytes are a substring of the versioned block, which alone is the step's source.
  const versioned=new Set(included.filter(item=>item.file.startsWith('versions/')).map(item=>item.name));
  const sources=included.filter(item=>item.file.startsWith('versions/')||!versioned.has(item.name));
  assert.deepEqual(sources.map(item=>item.name).sort(),[...declared].sort(),`Every created/replaced function in ${descriptor.version} must come from its exact canonical block`);
  plans.push(...sources.filter(item=>item.plpgsql).map(item=>({step:descriptor.version,file:item.file,name:item.name,block:item.block})));
 }
 assert.deepEqual([...new Set(plans.map(plan=>plan.name))].sort(),[...invoke.keys()].sort(),'Every unpublished PL/pgSQL function requires a real NULL or trigger fixture; no blind two-function count');
 for(const plan of plans)await t.test(`${plan.step}: ${plan.name} compiles and executes`,async()=>{
  const before=await snapshot(c),catalogue=await inspectMaterialEnforcement(c.admin);
  const signatureStores=['connector_signatures','connection_tools','decisions','principals','mandates','tasks','task_people',
   'identity_accounts','identity_agents','identity_invitations','identity_sessions','identity_projects','identity_project_people','identity_task_projects','identity_directory','identity_directory_deleted','identity_workspace_projects'],signatures=await snapshot(c,signatureStores);
  const identityCatalogue=await captureIdentity(c.admin);
  await c.admin.query('BEGIN');try{
   await c.admin.query('SET LOCAL check_function_bodies=on; SET LOCAL ROLE backbone_gov');
   await c.admin.query(plan.block.replace(/^CREATE(?: OR REPLACE)? FUNCTION\s+/im,'CREATE OR REPLACE FUNCTION '));
   await invoke.get(plan.name)!();
  }finally{await rollback(c.admin);}
  assert.deepEqual(await snapshot(c),before,'Body-validation fixtures persist no application/ledger mutation');
  assert.deepEqual(await snapshot(c,signatureStores),signatures,'Signature fixtures persist no grant, tool or decision mutation');
  assert.deepEqual(await inspectMaterialEnforcement(c.admin),catalogue,'Body-validation fixtures persist no function/ACL/catalogue mutation');
  assert.deepEqual(await captureIdentity(c.admin),identityCatalogue,'Body fixtures restore every identity definition, ACL, policy and attachment');
 });
 t.diagnostic(`Validated ${plans.length} canonical PL/pgSQL bodies across ${unpublished.length} unpublished steps; installer posture is unchanged.`);
});

// K4: neither an installation receipt nor fresh/upgraded equality alone is sufficient.
test('K4: fresh and additive upgraded homes have equal intended enforcement/catalogue and intact released steps',async t=>{
 const fresh=await context(t,'historical-fresh'),old=await context(t,true);
 const legacyTables=['episodes','ledger','ledger_heads'];const prior=await snapshot(old,legacyTables);
 const namespaces=(await old.admin.query("SELECT nspname::text,pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl FROM pg_namespace WHERE nspname IN ('app','sec','gov','ops') ORDER BY nspname")).rows;
 assert.equal((await upgradeMaterialGuard(old.admin,BASELINE)).state,'verified');
 assert.equal((await upgradeMaterialLink(old.admin,BASELINE)).state,'verified');
 assert.equal((await upgradeMaterialEnforcement(old.admin,BASELINE)).state,'verified');
 assert.deepEqual(await snapshot(old,legacyTables),prior);
 assert.deepEqual((await old.admin.query("SELECT nspname::text,pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl FROM pg_namespace WHERE nspname IN ('app','sec','gov','ops') ORDER BY nspname")).rows,namespaces);
 const installed=await inspectMaterialEnforcement(fresh.admin),upgraded=await inspectMaterialEnforcement(old.admin);
 assert.equal(materialEnforcementCatalogueState(installed),'enforced');assert.deepEqual(upgraded,installed);
 assert.deepEqual(await inspectMaterialLink(old.admin),await inspectMaterialLink(fresh.admin));
 for(const c of [fresh,old]){
  const app=await c.connect();assert.equal((await verifyMaterialEnforcement(app)).state,'verified');
  const trigger=(await c.admin.query("SELECT tgenabled,tgdeferrable,tginitdeferred,tgqual IS NULL AS no_predicate FROM pg_trigger WHERE tgrelid='app.episodes'::regclass AND tgname=$1",[WHEN])).rows;
  assert.deepEqual(trigger,[{tgenabled:'A',tgdeferrable:true,tginitdeferred:true,no_predicate:true}]);
  const owners=(await c.admin.query("SELECT n.nspname||'.'||p.proname AS name,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='gov' AND p.proname='_material_source_state') OR (n.nspname='sec' AND p.proname='t_material_episode_source') ORDER BY name")).rows;
  assert.deepEqual(owners,['gov._material_source_state','sec.t_material_episode_source'].map(name=>({name,owner:'backbone_gov',prosecdef:true,proconfig:['search_path=pg_catalog']})));
 }
 assert.equal(materialGuardStep(BASELINE)?.checksum,'aa19fe4ce8779ed4040f50b4a225cfb6e73d71b25787ab3f34aaae23f881cab7');
 assert.equal(materialLinkStep(BASELINE)?.checksum,'26815c949303419f35ec3acbda282c9a875c73202336b46a0ff157c7c192d206');
 // Preserve the old enforced matcher above, then qualify the appended complete profile on
 // both independently assembled paths. No old row or receipt is filtered from the comparison.
 assert.equal((await upgradeSignatureLedger(old.admin,BASELINE)).state,'verified');
 for(const c of [fresh,old]){
  const status=await upgradeMaterialClosure(c.admin);assert.equal(status.state,'verified',status.reason);
  const hardening=await upgradeMaterialClosureHardening(c.admin);assert.equal(hardening.state,'verified',hardening.reason);
  assert.equal((await verifyMaterialClosure(c.admin)).state,'verified');
  const materialBeforeIdentity=await snapshot(c,legacyTables);
  for(const upgrade of identityUpgrades){const status=await upgrade(c.admin);assert.equal(status.state,'verified',status.reason);}
  assert.deepEqual(await snapshot(c,legacyTables),materialBeforeIdentity,'Identity adds no material or ledger mutation');
  assert.equal((await verifyIdentityRuntime(c.admin)).state,'verified');
  assert.deepEqual((await c.admin.query('SELECT version,checksum FROM ops.schema_migrations WHERE version<>$1 ORDER BY version',['baseline'])).rows,
   [...CORE_SCHEMA_UPGRADES].sort((a,b)=>a.version.localeCompare(b.version)));
 }
 assert.deepEqual(await captureIdentity(old.admin),await captureIdentity(fresh.admin));
 assert.deepEqual(await captureMaterialClosureProfile(old.admin),await captureMaterialClosureProfile(fresh.admin));
});

test('raw reserved file/MCP inserts fail at validation, while exact nonreserved file references still work',async t=>{
 const c=await context(t),client=await c.connect();
 for(const reference of ['material:opaque@v1','material:','material:not-a-uuid@v9']){
  const before=await snapshot(c);await begin(c,client);
  try{await client.query(SOURCE,[reference,'Raw unbound words',c.handle.run]);await assert.rejects(commit(client),paused);}finally{await rollback(client);}
  assert.deepEqual(await snapshot(c),before);
 }
 for(const tool of ['read','same-tool','']){
  const before=await snapshot(c);await begin(c,client);
  try{await client.query(SERVER,[c.handle.run,c.connection,tool,'Raw unbound server words']);await assert.rejects(commit(client),paused);}finally{await rollback(client);}
  assert.deepEqual(await snapshot(c),before);
 }
 for(const reference of ['plain-file','MATERIAL:opaque@v1','materialx:opaque@v1','xmaterial:opaque@v1']){
  await begin(c,client);const result=await client.query(SOURCE,[reference,'Ordinary file words',c.handle.run]);await commit(client);
  assert.match(result.rows[0].episode,/^[a-f0-9-]{36}$/);
 }
});

test('typed file and distinct same-connection MCP reads commit their own exact binding and native privacy',async t=>{
 const c=await context(t),file=c.read(),a=c.read({kind:'mcp',connection:c.connection,tool:'same-tool'}),b=c.read({kind:'mcp',connection:c.connection,tool:'same-tool'});
 const receipts=[];
 for(const r of [file,a,b]){
  const receipt=await typed(c,r);receipts.push(receipt);
  const binding=(await c.admin.query('SELECT * FROM app.material_source_reads WHERE workspace_id=$1 AND episode_id=$2',[c.link.id.workspace,receipt.episode_id])).rows[0];
  assert.equal(binding.receipt_id,receipt.receipt_id);assert.equal(binding.read_key,r.key);assert.equal(binding.material_id,r.material);
  assert.equal(binding.original_sha256,r.original);assert.equal(binding.episode_sha256,digest(r.episode));assert.equal(binding.prepared_sha256,digest(r.prepared));
  const episode=(await c.admin.query('SELECT * FROM app.episodes WHERE id=$1',[receipt.episode_id])).rows[0];
  assert.equal(episode.source_kind,r.kind);assert.equal(episode.run_id,c.handle.run);assert.equal(episode.recorded_by,c.link.id.system);assert.equal(episode.authored_by,null);
  assert.equal(episode.trust,'untrusted');assert.equal(episode.task_id,c.task);assert.equal(await state(c,receipt.episode_id),'live');
  if(r.kind==='mcp'){assert.equal(episode.connection_id,c.connection);assert.equal(episode.sensitive,true);assert.equal(episode.source_ref,`mcp:${c.connection}/same-tool`);}
 }
 assert.equal(new Set(receipts.map(row=>row.episode_id)).size,3);
});

for(const isolation of ['REPEATABLE READ','SERIALIZABLE'])test(`K1: typed crossing and raw-trigger validation refuse ${isolation} on true app login`,async t=>{
 const c=await context(t),client=await c.connect();
 for(const kind of ['file','mcp'] as const){
  const r=c.read(kind==='mcp'?{kind,connection:c.connection,tool:'read'}:{}),before=await snapshot(c);
  await begin(c,client,isolation);
  try{await assert.rejects(client.query(READ,values(r)),/READ COMMITTED/);}finally{await rollback(client);}
  assert.deepEqual(await snapshot(c),before);
  await begin(c,client,isolation);
  try{
   if(kind==='file')await client.query(SOURCE,[`material:${r.material}@v1`,r.episode,r.run]);
   else await client.query(SERVER,[r.run,c.connection,'read',r.episode]);
   await assert.rejects(commit(client),/READ COMMITTED/);
  }finally{await rollback(client);}
  assert.deepEqual(await snapshot(c),before);
 }
});

test('K2: SET CONSTRAINTS IMMEDIATE before typed registration refuses before a binding can attach',async t=>{
 const c=await context(t),client=await c.connect(),before=await snapshot(c);
 await begin(c,client);try{
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await assert.rejects(client.query(READ,values(c.read())),paused);
 }finally{await rollback(client);}
 assert.deepEqual(await snapshot(c),before);
});

test('K2: typed then IMMEDIATE validates, and a later same-transaction withdrawal leaves genuine historical state',async t=>{
 const c=await context(t),client=await c.connect(),r=c.read();
 await begin(c,client);let receipt:Receipt;
 try{
  receipt=(await client.query<Receipt>(READ,values(r))).rows[0];
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');await client.query('SET CONSTRAINTS ALL DEFERRED');
  await client.query(WITHDRAW,withdrawal(r));await commit(client);
 }finally{await rollback(client);}
 assert.equal(await state(c,receipt!.episode_id),'withdrawn');
 assert.equal((await c.admin.query('SELECT receipt_id FROM app.material_source_reads WHERE episode_id=$1',[receipt!.episode_id])).rows[0].receipt_id,receipt!.receipt_id);
 assert.equal(await c.link.materialReadCommitWitness({workspace:c.link.id.workspace,episode:receipt!.episode_id,receipt:receipt!.receipt_id}),'confirmed');
 await assert.rejects(typed(c,r),/withdrawn/);
});

test('K2: default deferral refuses read then same-transaction withdrawal and rolls back both Core changes',async t=>{
 const c=await context(t),client=await c.connect(),r=c.read(),before=await snapshot(c);
 await begin(c,client);try{
  await client.query(READ,values(r));await client.query(WITHDRAW,withdrawal(r));await assert.rejects(commit(client),paused);
 }finally{await rollback(client);}
 assert.deepEqual(await snapshot(c),before);
});

test('K2: released savepoints preserve valid same-transaction bindings without relying on xmin equality',async t=>{
 const c=await context(t),client=await c.connect(),r=c.read();await begin(c,client);
 let receipt:Receipt;
 try{await client.query('SAVEPOINT typed_read');receipt=(await client.query<Receipt>(READ,values(r))).rows[0];await client.query('RELEASE SAVEPOINT typed_read');await commit(client);}
 finally{await rollback(client);}
 assert.equal(await state(c,receipt!.episode_id),'live');
});

test('K2: rolling back a raw insert savepoint discards its pending trigger; later typed work remains valid',async t=>{
 const c=await context(t),client=await c.connect(),r=c.read();await begin(c,client);
 let receipt:Receipt,discarded:string;
 try{
  await client.query('SAVEPOINT raw_read');discarded=(await client.query(SOURCE,[`material:${r.material}@v1`,r.episode,r.run])).rows[0].episode;
  await client.query('ROLLBACK TO SAVEPOINT raw_read');await client.query('RELEASE SAVEPOINT raw_read');
  receipt=(await client.query<Receipt>(READ,values(r))).rows[0];await commit(client);
 }finally{await rollback(client);}
 assert.equal((await c.admin.query('SELECT id FROM app.episodes WHERE id=$1',[discarded!])).rows.length,0);
 assert.equal(await state(c,receipt!.episode_id),'live');
});

test('K2: neither a new typed read nor a replay can attach an unrelated raw episode sharing its reference',async t=>{
 const c=await context(t),client=await c.connect();
 for(const replay of [false,true]){
  const r=c.read();if(replay)await typed(c,r);
  const before=await snapshot(c);await begin(c,client);
  try{
   const raw=(await client.query(SOURCE,[`material:${r.material}@v1`,r.episode,r.run])).rows[0].episode;
   const receipt=(await client.query<Receipt>(READ,values(r))).rows[0];assert.notEqual(raw,receipt.episode_id);
   await assert.rejects(commit(client),paused);
  }finally{await rollback(client);}
  assert.deepEqual(await snapshot(c),before);
 }
});

test('K3: switching principal, workspace, or into a run before deferred validation cannot borrow the old binding',async t=>{
 const c=await context(t),client=await c.connect();
 const other=(await c.admin.query("SELECT * FROM operator.create_workspace('Other tenant','team','Other','other@example.invalid')")).rows[0];
 for(const actor of [c.link.person(),c.link.runOf(c.handle),{workspace:other.workspace_id,principal:other.system_id}]){
  const before=await snapshot(c);await begin(c,client);
  try{await client.query(READ,values(c.read()));await identity(client,actor);await assert.rejects(commit(client),/system_records|workspace/);}
  finally{await rollback(client);}
  assert.deepEqual(await snapshot(c),before);
 }
});

test('K4: true app cannot use replica mode, disable its trigger, execute private state, or read closed stores',async t=>{
 const c=await context(t),app=await c.connect();
 for(const query of ["SET session_replication_role='replica'",'ALTER TABLE app.episodes DISABLE TRIGGER material_source_receipt',
  'SELECT gov._material_source_state(NULL::uuid)','SELECT * FROM app.material_source_reads',
  'SET ROLE backbone_gov','SET ROLE backbone_owner'])await assert.rejects(app.query(query),(error:unknown)=>(error as {code?:string}).code==='42501');
 assert.deepEqual((await app.query("SELECT has_parameter_privilege(current_user,'session_replication_role','SET') AS allowed")).rows,[{allowed:false}]);
 const before=await snapshot(c);await begin(c,app);
 try{await app.query(SOURCE,['material:replica-control@v1','No bound receipt',c.handle.run]);await assert.rejects(commit(app),paused);}finally{await rollback(app);}
 assert.deepEqual(await snapshot(c),before);
});

test('K4: ALWAYS still enforces raw material when disposable fixture admin deliberately sets replica mode',async t=>{
 const c=await context(t),before=await snapshot(c);
 await enter(c.admin,c.link.system());try{
  await c.admin.query("SET LOCAL session_replication_role='replica'");
  await c.admin.query(SOURCE,['material:admin-replica-control@v1','Unbound source',c.handle.run]);
  await assert.rejects(commit(c.admin),paused);
 }finally{await rollback(c.admin);}
 assert.deepEqual(await snapshot(c),before);
});

// Each change is rolled back before the next. No runtime profile is learnt from these mutations.
test('K4: exact helper, trigger, carrier, namespace, role and parameter privilege tampering pauses without new history',async t=>{
 const c=await context(t),history=(await c.admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 const mutations=[
  'ALTER TABLE app.episodes DISABLE TRIGGER material_source_receipt',
  'ALTER TABLE app.episodes ENABLE TRIGGER material_source_receipt',
  'DROP TRIGGER material_source_receipt ON app.episodes',
  'ALTER FUNCTION gov._material_source_state(uuid) SECURITY INVOKER',
  'ALTER FUNCTION gov.claim_run(uuid,text,integer,text,uuid) SECURITY INVOKER',
  'ALTER FUNCTION gov.finish_run(uuid,bigint,text) SECURITY INVOKER',
  'GRANT EXECUTE ON FUNCTION gov._claim(uuid,text,integer) TO backbone_app',
  "CREATE OR REPLACE FUNCTION gov._claimable(p_run uuid,p_from_queue boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT true $$",
  'ALTER FUNCTION sec.t_material_episode_source() SET search_path=public',
  'ALTER FUNCTION sec.t_material_episode_source() OWNER TO backbone_owner',
  'GRANT EXECUTE ON FUNCTION gov._material_source_state(uuid) TO PUBLIC',
  'GRANT EXECUTE ON FUNCTION sec.t_material_episode_source() TO backbone_app',
  "CREATE OR REPLACE FUNCTION gov._material_source_state(p_episode uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RETURN 'live'; END $$",
  "CREATE OR REPLACE FUNCTION gov.run_standing(p_run uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RETURN 'ok'; END $$",
  'GRANT CREATE ON SCHEMA sec TO backbone_app',
  'ALTER SCHEMA gov OWNER TO backbone_owner',
  'ALTER ROLE backbone_app BYPASSRLS',
  'GRANT backbone_gov TO backbone_app',
  'GRANT SET ON PARAMETER session_replication_role TO backbone_app',
 ];
 for(const mutation of mutations){
  await c.admin.query('BEGIN');try{
   await c.admin.query(mutation);assert.equal((await verifyMaterialEnforcement(c.admin)).state,'paused',mutation);
   assert.deepEqual((await c.admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);
  }finally{await rollback(c.admin);}
  assert.equal((await verifyMaterialEnforcement(c.admin)).state,'verified',mutation);
 }
});

test('K4: a predicate or unexpected second trigger is not a name-based exemption from the old guard fingerprint',async t=>{
 const c=await context(t);
 for(const ddl of [
  `DROP TRIGGER material_source_receipt ON app.episodes;
   CREATE CONSTRAINT TRIGGER material_source_receipt AFTER INSERT ON app.episodes DEFERRABLE INITIALLY DEFERRED
   FOR EACH ROW WHEN (false) EXECUTE FUNCTION sec.t_material_episode_source();
   ALTER TABLE app.episodes ENABLE ALWAYS TRIGGER material_source_receipt;`,
  'CREATE TRIGGER material_extra_guard BEFORE INSERT ON app.episodes FOR EACH ROW EXECUTE FUNCTION sec.t_material_episode_source();',
 ]){
  await c.admin.query('BEGIN');try{await c.admin.query(ddl);assert.equal((await verifyMaterialEnforcement(c.admin)).state,'paused');}
  finally{await rollback(c.admin);}
  assert.equal((await verifyMaterialEnforcement(c.admin)).state,'verified');
 }
});

async function waitBlocked(c:Context,blocked:number,holder:number){
 try {
  await waitFor(async()=>{
   const row=(await c.admin.query('SELECT $2::integer=ANY(pg_catalog.pg_blocking_pids($1::integer)) AS blocked',[blocked,holder])).rows[0];
   return row.blocked===true;
  },'workspace-head lock observation',{diagnostic:()=>`blocked pid=${blocked}; holder pid=${holder}`});
  return;
 } catch(error) { console.error(error); }
 assert.fail('the expected workspace-head lock wait was not observed before the bounded deadline');
}

test('withdrawal first: a waiting registration sees its committed tombstone and leaves no episode or binding',async t=>{
 const c=await context(t),holder=await c.connect(),waiting=await c.connect(),r=c.read();
 const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const waiterPid=(await waiting.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await begin(c,holder);await begin(c,waiting);
 try{
  await holder.query(WITHDRAW,withdrawal(r));
  const outcome=waiting.query(READ,values(r)).then(result=>({result,error:undefined}),error=>({result:undefined,error}));
  await waitBlocked(c,waiterPid,holderPid);await commit(holder);
  const result=await outcome;assert.ok(result.error instanceof Error);assert.match(result.error.message,/withdrawn/);
 }finally{await rollback(holder);await rollback(waiting);}
 assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_withdrawals WHERE material_id=$1',[r.material])).rows[0].n,1);
 assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_reads WHERE material_id=$1',[r.material])).rows[0].n,0);
 assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.episodes WHERE source_ref=$1',[`material:${r.material}@v1`])).rows[0].n,0);
});

test('registration first: withdrawal waits for actual COMMIT, then keeps the now-withdrawn historical receipt',async t=>{
 const c=await context(t),holder=await c.connect(),waiting=await c.connect(),r=c.read();
 const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const waiterPid=(await waiting.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await begin(c,holder);await begin(c,waiting);let receipt:Receipt;
 try{
  receipt=(await holder.query<Receipt>(READ,values(r))).rows[0];
  const outcome=waiting.query(WITHDRAW,withdrawal(r)).then(result=>({result,error:undefined}),error=>({result:undefined,error}));
  await waitBlocked(c,waiterPid,holderPid);await commit(holder);
  const result=await outcome;assert.equal(result.error,undefined);assert.ok(result.result);await commit(waiting);
 }finally{await rollback(holder);await rollback(waiting);}
 assert.equal(await state(c,receipt!.episode_id),'withdrawn');
 assert.equal((await c.admin.query('SELECT receipt_id FROM app.material_source_reads WHERE episode_id=$1',[receipt!.episode_id])).rows[0].receipt_id,receipt!.receipt_id);
});

test('native carrier: wrong fence/secret refuses before retaining IDs or changing material evidence',async t=>{
 const c=await context(t),r=c.read(),before=await snapshot(c);let retained=0;
 for(const handle of [{...c.handle,fence:c.handle.fence+1},{...c.handle,secret:'not-the-claimed-secret'}]){
  await assert.rejects(withHomeLock(c.home,lost=>c.link.recordMaterialSourceRead(handle,request(r),()=>{retained++;return undefined;},lost)),/stale|hold this run/);
  await assert.rejects(withHomeLock(c.home,lost=>c.link.admitMaterialConnectorRead(handle,c.connection,lost)),/stale|hold this run/);
  assert.equal(retained,0);assert.deepEqual(await snapshot(c),before);
 }
});

test('native carrier: ancestor revocation is checked even when fixture direct child and run remain active',async t=>{
 const c=await context(t);
 const root=await c.link.call<string>(c.link.person(),`SELECT gov.issue_mandate($1,NULL,'"*"','"*"','"*"','"*"',2::smallint,NULL,NULL,NULL,NULL,$2,'direct')`,[c.link.id.agent,new Date(Date.now()+86_400_000)]);
 const child=await issueChildMandate(c.link,c.link.person(),root,'worker',{child:'native-child',parent:'native-parent'});
 const handle=await c.link.startRunUnder(c.task,c.link.id.agent,child,null);
 // Deliberate disposable administrator setup isolates the ancestor standing check: normal
 // gov.revoke_mandate also cancels runs, which alone would not prove ancestor traversal.
 await c.admin.query('UPDATE app.mandates SET revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1',[root,c.link.id.person]);
 const direct=(await c.admin.query('SELECT r.status,m.revoked_at FROM app.runs r JOIN app.mandates m ON m.workspace_id=r.workspace_id AND m.id=r.mandate_id WHERE r.id=$1',[handle.run])).rows[0];
 assert.deepEqual(direct,{status:'running',revoked_at:null});const before=await snapshot(c);let retained=0;
 await assert.rejects(withHomeLock(c.home,lost=>c.link.recordMaterialSourceRead(handle,request(c.read({run:handle.run})),()=>{retained++;return undefined;},lost)),/standing|stale/);
 await assert.rejects(withHomeLock(c.home,lost=>c.link.admitMaterialConnectorRead(handle,c.connection,lost)),/standing|stale/);
 assert.equal(retained,0);assert.deepEqual(await snapshot(c),before);
});

test('native wrapper: actual COMMIT followed by lost client reply has a positive historical ledger witness after run end/withdrawal',async t=>{
 const c=await context(t),r=c.read(),path=join(c.home,'synthetic-material-tentative.json');let armed=false,retained:MaterialReadTentative|undefined;
 const raw=pg.Client.prototype.query;
 const intercepted=t.mock.method(pg.Client.prototype,'query',async function(this:pg.Client,...args:unknown[]){
  const result=await Reflect.apply(raw,this,args);
  if(armed&&args[0]==='COMMIT'){
   armed=false;assert.equal((result as pg.QueryResult).command,'COMMIT');
   throw Object.assign(new Error('Synthetic client lost the already-committed reply'),{code:'ECONNRESET'});
  }
  return result;
 });
 let unknown:MaterialCommitUnknown|undefined;
 try{
  await assert.rejects(withHomeLock(c.home,lost=>c.link.recordMaterialSourceRead(c.handle,request(r),tentative=>{
   writeDurable(path,JSON.stringify(tentative),0o600);retained=tentative;armed=true;return undefined;
  },lost)),(error:unknown)=>{if(!(error instanceof MaterialCommitUnknown))return false;unknown=error;return true;});
 }finally{intercepted.mock.restore();}
 assert.ok(retained);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),retained);assert.deepEqual(unknown!.tentative,retained);
 assert.equal(await c.link.materialReadCommitWitness(retained),'confirmed');
 await c.link.finishRun(c.handle,'succeeded');await c.link.call(c.link.system(),WITHDRAW,withdrawal(r));
 assert.equal(await c.link.materialReadCommitWitness(retained),'confirmed','positive historical confirmation grants no renewed source access');
 await assert.rejects(withHomeLock(c.home,lost=>c.link.recordMaterialSourceRead(c.handle,request(r),()=>undefined,lost)),/stale|standing|running|withdrawn/);
 assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_reads WHERE material_id=$1',[r.material])).rows[0].n,1);
});

test('native wrapper: terminating its disposable backend after durable tentative IDs leaves UNKNOWN without a witness or duplicate registration',async t=>{
 const c=await context(t),r=c.read(),path=join(c.home,'synthetic-uncommitted-tentative.json');let armed=false,retained:MaterialReadTentative|undefined;
 const raw=pg.Client.prototype.query;
 const intercepted=t.mock.method(pg.Client.prototype,'query',async function(this:pg.Client,...args:unknown[]){
  if(armed&&args[0]==='COMMIT'){
   armed=false;
   const pid=(await Reflect.apply(raw,this,['SELECT pg_backend_pid() AS pid']) as pg.QueryResult).rows[0].pid;
   assert.equal((await c.admin.query('SELECT pg_terminate_backend($1::integer) AS stopped',[pid])).rows[0].stopped,true);
  }
  return Reflect.apply(raw,this,args);
 });
 try{
  await assert.rejects(withHomeLock(c.home,lost=>c.link.recordMaterialSourceRead(c.handle,request(r),tentative=>{
   writeDurable(path,JSON.stringify(tentative),0o600);retained=tentative;armed=true;return undefined;
  },lost)),(error:unknown)=>error instanceof MaterialCommitUnknown);
 }finally{intercepted.mock.restore();}
 assert.ok(retained);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),retained);
 assert.equal(await c.link.materialReadCommitWitness(retained),'unknown','absence is not authorization to resend or proof of provider non-dispatch');
 assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_reads WHERE material_id=$1',[r.material])).rows[0].n,0);
 assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.episodes WHERE id=$1',[retained.episode])).rows[0].n,0);
});

// This reports measurements; an arbitrary wall-time threshold would conflate load with semantics.
// The only disabled-trigger phase is this private disposable performance control, restored finally.
test('benchmark: ordinary episode insertion plus COMMIT with ALWAYS no-op versus disabled fixture trigger',async t=>{
 const c=await context(t),app=await c.connect(),batch=100,rounds=5;
 const samples:{enabled:boolean;statementMs:number;commitMs:number;totalMs:number;rows:number}[]=[];
 const measure=async(enabled:boolean,record:boolean)=>{
  await c.admin.query(`ALTER TABLE app.episodes ${enabled?'ENABLE ALWAYS':'DISABLE'} TRIGGER material_source_receipt`);
  await begin(c,app);
  try{
   const start=performance.now();
   const result=await app.query("SELECT gov.record_source('message','synthetic-benchmark','Ordinary source',NULL,NULL,NULL) FROM generate_series(1,$1::integer)",[batch]);
   const inserted=performance.now();await commit(app);const done=performance.now();
   assert.equal(result.rows.length,batch);if(record)samples.push({enabled,statementMs:inserted-start,commitMs:done-inserted,totalMs:done-start,rows:batch});
  }finally{await rollback(app);}
 };
 try{
  await measure(false,false);await measure(true,false);
  for(let round=0;round<rounds;round++)for(const enabled of round%2?[true,false]:[false,true])await measure(enabled,true);
 }finally{await c.admin.query('ALTER TABLE app.episodes ENABLE ALWAYS TRIGGER material_source_receipt');}
 assert.equal((await verifyMaterialEnforcement(c.admin)).state,'verified');
 const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 const summary=(enabled:boolean)=>({enabled,rounds,batch,
  medianTotalNsPerEpisode:median(samples.filter(value=>value.enabled===enabled).map(value=>value.totalMs*1e6/value.rows)),
  medianCommitNsPerEpisode:median(samples.filter(value=>value.enabled===enabled).map(value=>value.commitMs*1e6/value.rows))});
 t.diagnostic(JSON.stringify({measurement:'native-local-ordinary-episode-noop-trigger',clock:'performance.now',samples,summary:[summary(false),summary(true)],
  limits:'Disposable test cluster may use fsync=off/synchronous_commit=off; this measures software-path overhead, not durable storage or production latency.'}));
});

test('K4: binding-to-episode FK must remain validated immediate/nondeferrable and episode binding unique',async t=>{
 const c=await context(t);
 const foreign=(await c.admin.query(`SELECT conname,convalidated,condeferrable,condeferred FROM pg_constraint
  WHERE conrelid='app.material_source_reads'::regclass AND contype='f' AND confrelid='app.episodes'::regclass`)).rows;
 assert.equal(foreign.length,1);assert.equal(foreign[0].convalidated,true);assert.equal(foreign[0].condeferrable,false);assert.equal(foreign[0].condeferred,false);
 const unique=(await c.admin.query(`SELECT conname FROM pg_constraint WHERE conrelid='app.material_source_reads'::regclass
  AND contype='u' AND pg_get_constraintdef(oid,true)='UNIQUE (workspace_id, episode_id)'`)).rows;
 assert.equal(unique.length,1);
 const identifier=(value:string)=>'"'+value.replace(/"/g,'""')+'"';
 for(const ddl of [
  `ALTER TABLE app.material_source_reads ALTER CONSTRAINT ${identifier(foreign[0].conname)} DEFERRABLE INITIALLY DEFERRED`,
  `ALTER TABLE app.material_source_reads DROP CONSTRAINT ${identifier(foreign[0].conname)};
   ALTER TABLE app.material_source_reads ADD CONSTRAINT ${identifier(foreign[0].conname)} FOREIGN KEY (workspace_id,episode_id) REFERENCES app.episodes(workspace_id,id) NOT VALID`,
  `ALTER TABLE app.material_source_reads DROP CONSTRAINT ${identifier(unique[0].conname)}`,
 ]){
  await c.admin.query('BEGIN');try{await c.admin.query(ddl);assert.equal((await verifyMaterialEnforcement(c.admin)).state,'paused');}
  finally{await rollback(c.admin);}
  assert.equal((await verifyMaterialEnforcement(c.admin)).state,'verified');
 }
});

test('owned installer refuses a busy old raw recorder, then preserves its pre-enforcement history and guards later writes',async t=>{
 const c=await context(t,true);assert.equal((await upgradeMaterialGuard(c.admin,BASELINE)).state,'verified');
 assert.equal((await upgradeMaterialLink(c.admin,BASELINE)).state,'verified');
 const app=await c.connect(),reference='material:old-inflight@v1';let oldEpisode:string;
 await begin(c,app);try{
  oldEpisode=(await app.query(SOURCE,[reference,'Historical pre-enforcement raw source',c.handle.run])).rows[0].episode;
  // The old function has actually entered and inserted while retaining its transaction/table
  // locks. The new owned DDL must fail its bounded NOWAIT admission until that transaction ends.
  assert.equal((await upgradeMaterialEnforcement(c.admin,BASELINE)).state,'paused');
  assert.equal((await c.admin.query("SELECT count(*)::int AS n FROM ops.schema_migrations WHERE version='material-source-enforcement-v1'")).rows[0].n,0);
  await commit(app);
 }finally{await rollback(app);}
 assert.equal((await upgradeMaterialEnforcement(c.admin,BASELINE)).state,'verified');
 assert.equal((await c.admin.query('SELECT content FROM app.episodes WHERE id=$1',[oldEpisode!])).rows[0].content,'Historical pre-enforcement raw source');
 assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM app.material_source_reads WHERE episode_id=$1',[oldEpisode!])).rows[0].n,0);
 await begin(c,app);try{await app.query(SOURCE,['material:after-upgrade@v1','Must not commit unbound',c.handle.run]);await assert.rejects(commit(app),paused);}
 finally{await rollback(app);}
});

test('terminating the owned installer after first new function DDL rolls back objects, receipt and namespace ACLs',async t=>{
 const c=await context(t,true);assert.equal((await upgradeMaterialGuard(c.admin,BASELINE)).state,'verified');
 assert.equal((await upgradeMaterialLink(c.admin,BASELINE)).state,'verified');
 const before=await inspectMaterialEnforcement(c.admin),history=(await c.admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 const namespaceQuery="SELECT nspname::text,pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl FROM pg_namespace WHERE nspname IN ('app','sec','gov','ops') ORDER BY nspname";
 const namespaces=(await c.admin.query(namespaceQuery)).rows;
 const worker=new pg.Client({connectionString:c.url});worker.on('error',()=>{});await worker.connect();t.after(()=>worker.end().catch(()=>{}));
 const pid=(await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await c.admin.query('SELECT pg_advisory_lock(1111573323,97)');
 try{
  const raw=worker.query.bind(worker);
  const instrumented=new Proxy(worker,{get(target,key){
   if(key!=='query')return Reflect.get(target,key);
   return(sql:string,...args:unknown[])=>{
    if(sql.startsWith('SET LOCAL check_function_bodies=false;')){
     const after='REVOKE ALL ON FUNCTION gov._material_source_state(uuid) FROM PUBLIC, backbone_app, backbone_operator;';
     assert.equal(sql.split(after).length,2,'fault latch is exactly after first new function, not inside a body');
     sql=sql.replace(after,after+'\nSELECT pg_advisory_lock(1111573323,97);');
    }
    return Reflect.apply(raw,worker,[sql,...args]);
   };
  }});
  const upgrading=upgradeMaterialEnforcement(instrumented,BASELINE);
  let blocked=false;
  await waitFor(async()=>{
   blocked=(await c.admin.query("SELECT EXISTS (SELECT FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1111573323 AND objid=97 AND NOT granted) AS blocked",[pid])).rows[0].blocked;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
  return !!blocked;},'material-enforcement-native: SQL lock observation',{diagnostic:()=>`blocked=${blocked}`});
  assert.equal(blocked,true,'installer reached injected latch after first DDL within its transaction');
  assert.equal((await c.admin.query('SELECT pg_terminate_backend($1::integer) AS stopped',[pid])).rows[0].stopped,true);
  assert.equal((await upgrading).state,'paused');
 }finally{await c.admin.query('SELECT pg_advisory_unlock(1111573323,97)');}
 assert.deepEqual(await inspectMaterialEnforcement(c.admin),before);
 assert.deepEqual((await c.admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);
 assert.deepEqual((await c.admin.query(namespaceQuery)).rows,namespaces);
 assert.equal((await upgradeMaterialEnforcement(c.admin,BASELINE)).state,'verified');
});

async function recoveryRows(c:Context){
 return {
  runs:(await c.admin.query('SELECT id,status,fence,carrier,piece_id,worker,lease_expires_at FROM app.runs ORDER BY id')).rows,
  secrets:(await c.admin.query('SELECT workspace_id,run_id,fence FROM ops.run_secrets ORDER BY workspace_id,run_id,fence')).rows,
  queue:(await c.admin.query('SELECT run_id,workspace_id,carrier_key,claimable_after FROM ops.run_queue ORDER BY run_id')).rows,
 };
}
async function expireOriginalLease(c:Context,run=c.handle.run){
 // Disposable fixture setup, not a Host recovery strategy or a real-home lease edit.
 await c.admin.query("UPDATE app.runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[run]);
}

test('original recovery claim refuses a currently held run without queuing or creating another run/secret',async t=>{
 const c=await context(t);
 await c.admin.query("UPDATE app.runs SET lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[c.handle.run]);
 const before=await recoveryRows(c);
 await assert.rejects(withHomeLock(c.home,lost=>c.link.claimMaterialRecovery(c.handle.run,null,lost)),(error:unknown)=>error instanceof CoreRefusal&&error.reason==='not_claimable'&&/^Material recovery only reclaims an original running run/.test(error.message));
 assert.deepEqual(await recoveryRows(c),before);
});

test('original recovery claim preserves exact carrier: an expired direct run cannot be reclaimed as an arbitrary piece',async t=>{
 const c=await context(t);await expireOriginalLease(c);const before=await recoveryRows(c);
 await assert.rejects(withHomeLock(c.home,lost=>c.link.claimMaterialRecovery(c.handle.run,randomUUID(),lost)),/other_piece|other than what this worker runs/);
 assert.deepEqual(await recoveryRows(c),before);
});

test('explicit original recovery claims the same expired run at a fresh native fence, authenticates it, and invalidates old holder',async t=>{
 const c=await context(t),r=c.read();await expireOriginalLease(c);const before=await recoveryRows(c);
 const recovered=await withHomeLock(c.home,lost=>c.link.claimMaterialRecovery(c.handle.run,null,lost));
 assert.equal(recovered.run,c.handle.run);assert.equal(recovered.fence,c.handle.fence+1);
 assert.match(recovered.secret,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
 const after=await recoveryRows(c);assert.equal(after.runs.length,before.runs.length);assert.equal(after.queue.length,before.queue.length);
 assert.equal(after.secrets.length,before.secrets.length+1);
 const row=after.runs.find(value=>value.id===recovered.run)!;assert.equal(row.status,'running');assert.equal(Number(row.fence),recovered.fence);
 await assert.rejects(withHomeLock(c.home,lost=>c.link.recordMaterialSourceRead(c.handle,request(r),()=>undefined,lost)),/stale|hold this run/);
 const retained:MaterialReadTentative[]=[];
 const receipt=await withHomeLock(c.home,lost=>c.link.recordMaterialSourceRead(recovered,request(r),tentative=>{retained.push(tentative);return undefined;},lost));
 assert.equal(retained.length,1);assert.deepEqual(receipt,retained[0]);
 assert.equal((await c.admin.query('SELECT run_id FROM app.material_source_reads WHERE episode_id=$1',[receipt.episode])).rows[0].run_id,c.handle.run);
 await assert.rejects(c.link.finishRun(c.handle,'succeeded'),/stale|hold this run/);
 assert.equal(await c.link.finishRun(recovered,'succeeded'),'succeeded');
 assert.equal((await c.admin.query('SELECT status FROM app.runs WHERE id=$1',[recovered.run])).rows[0].status,'succeeded');
});

test('original recovery claim never restarts a completed run or substitutes a fresh run',async t=>{
 const c=await context(t);await c.link.finishRun(c.handle,'succeeded');const before=await recoveryRows(c);
 await assert.rejects(withHomeLock(c.home,lost=>c.link.claimMaterialRecovery(c.handle.run,null,lost)),(error:unknown)=>error instanceof CoreRefusal&&error.reason==='not_claimable'&&/^Material recovery only reclaims an original running run/.test(error.message));
 assert.deepEqual(await recoveryRows(c),before);
});

test('original recovery claim rejects revoked ancestor standing without returning a holder or adding a claim',async t=>{
 const c=await context(t);
 const root=await c.link.call<string>(c.link.person(),`SELECT gov.issue_mandate($1,NULL,'"*"','"*"','"*"','"*"',2::smallint,NULL,NULL,NULL,NULL,$2,'direct')`,[c.link.id.agent,new Date(Date.now()+86_400_000)]);
 const child=await issueChildMandate(c.link,c.link.person(),root,'worker',{child:'recovery-child',parent:'recovery-parent'});
 const original=await c.link.startRunUnder(c.task,c.link.id.agent,child,null);await expireOriginalLease(c,original.run);
 await c.admin.query('UPDATE app.mandates SET revoked_at=clock_timestamp(),revoked_by=$2 WHERE id=$1',[root,c.link.id.person]);
 const before=await recoveryRows(c);
 await assert.rejects(withHomeLock(c.home,lost=>c.link.claimMaterialRecovery(original.run,null,lost)),/not_claimable|verified recovery claim|standing/);
 assert.deepEqual(await recoveryRows(c),before,'failed bounded claim transaction adds no holder even when native _claim attempted a stop');
});

test('original recovery COMMIT reply lost returns no handle, preserves native claim, and refuses an immediate second claim',async t=>{
 const c=await context(t);await expireOriginalLease(c);const before=await recoveryRows(c);
 const raw=pg.Client.prototype.query;let armed=true,returned:unknown;
 const intercepted=t.mock.method(pg.Client.prototype,'query',async function(this:pg.Client,...args:unknown[]){
  const result=await Reflect.apply(raw,this,args);
  if(armed&&args[0]==='COMMIT'){
   armed=false;assert.equal((result as pg.QueryResult).command,'COMMIT');
   throw Object.assign(new Error('Synthetic lost original-recovery COMMIT reply'),{code:'ECONNRESET'});
  }
  return result;
 });
 try{
  await assert.rejects(withHomeLock(c.home,lost=>c.link.claimMaterialRecovery(c.handle.run,null,lost)).then(value=>{returned=value;return value;}),/unresolved|native lease settle/);
 }finally{intercepted.mock.restore();}
 assert.equal(returned,undefined);assert.equal(armed,false);
 const after=await recoveryRows(c);assert.equal(after.runs.length,before.runs.length);assert.equal(after.secrets.length,before.secrets.length+1);
 assert.equal(Number(after.runs.find(value=>value.id===c.handle.run)!.fence),c.handle.fence+1);
 await assert.rejects(withHomeLock(c.home,lost=>c.link.claimMaterialRecovery(c.handle.run,null,lost)),(error:unknown)=>error instanceof CoreRefusal&&error.reason==='not_claimable'&&/^Material recovery only reclaims an original running run/.test(error.message));
 assert.deepEqual(await recoveryRows(c),after);
});


async function wakeParkedFixture(c:Context){
 await enter(c.admin,c.link.system());try{await c.admin.query('SET LOCAL ROLE backbone_gov');await c.admin.query('SELECT gov._wake_run($1::uuid)',[c.handle.run]);await commit(c.admin);}
 finally{await rollback(c.admin);}
}
for(const lifecycle of ['waiting-not-woken','waiting-woken','queued'])test(`F1: explicit recovery refuses ${lifecycle} with zero run/queue/secret/ledger mutation`,async t=>{
 const c=await context(t);let run=c.handle.run;
 if(lifecycle==='queued')run=await c.link.call<string>(c.link.person(),'SELECT gov.queue_run($1::uuid,$2::uuid,$3::uuid,NULL,NULL)',[c.task,c.link.id.agent,c.link.id.mandate]);
 else{await c.link.call(c.link.runOf(c.handle),'SELECT gov.park_run($1::uuid,$2::bigint)',[run,c.handle.fence]);if(lifecycle==='waiting-woken')await wakeParkedFixture(c);}
 const before={recovery:await recoveryRows(c),evidence:await snapshot(c)};
 await assert.rejects(withHomeLock(c.home,lost=>c.link.claimMaterialRecovery(run,null,lost)),/original running run|not_claimable/);
 assert.deepEqual({recovery:await recoveryRows(c),evidence:await snapshot(c)},before);
});

test('F1: a concurrent legitimate park/wake after running snapshot survives rollback of our recovery claim',async t=>{
 const c=await context(t);await expireOriginalLease(c);const raw=pg.Client.prototype.query;let interceptedOnce=false,parked:unknown;
 const intercepted=t.mock.method(pg.Client.prototype,'query',async function(this:pg.Client,...args:unknown[]){
  const result=await Reflect.apply(raw,this,args);
  if(!interceptedOnce&&typeof args[0]==='string'&&args[0].includes('AS ledger_seq')){
   interceptedOnce=true;
   await c.link.call(c.link.runOf(c.handle),'SELECT gov.park_run($1::uuid,$2::bigint)',[c.handle.run,c.handle.fence]);
   await wakeParkedFixture(c);parked={recovery:await recoveryRows(c),evidence:await snapshot(c)};
  }
  return result;
 });
 try{await assert.rejects(withHomeLock(c.home,lost=>c.link.claimMaterialRecovery(c.handle.run,null,lost)),/parked or stopped/);}
 finally{intercepted.mock.restore();}
 assert.equal(interceptedOnce,true);assert.ok(parked);assert.deepEqual({recovery:await recoveryRows(c),evidence:await snapshot(c)},parked);
 const run=(await c.admin.query('SELECT status,woken FROM app.runs WHERE id=$1',[c.handle.run])).rows[0];assert.deepEqual(run,{status:'waiting',woken:true});
});

for(const old of [true,'released-70c6d0e'] as const)test(`F2: ${old===true?'hashed legacy':'released R1 with actual guard/link receipts'} raw material and MCP history survives additive upgrade as unknown and withheld`,async t=>{
 const c=await context(t,old),client=await c.connect(),words='Synthetic pre-enforcement historical evidence';let file:string,mcp:string;
 if(old===true){assert.equal((await upgradeMaterialGuard(c.admin,BASELINE)).state,'verified');assert.equal((await upgradeMaterialLink(c.admin,BASELINE)).state,'verified');}
 await begin(c,client);try{
  file=(await client.query(SOURCE,['material:pre-step-source@v1',words,c.handle.run])).rows[0].episode;
  mcp=(await client.query(SERVER,[c.handle.run,c.connection,'historical-read',words])).rows[0].episode;await commit(client);
 }finally{await rollback(client);}
 const before=await snapshot(c);assert.equal((await upgradeMaterialEnforcement(c.admin,BASELINE)).state,'verified');assert.deepEqual(await snapshot(c),before);
 for(const episode of [file!,mcp!]){
  assert.equal(await state(c,episode),'unknown');
  assert.equal((await c.admin.query('SELECT count(*)::integer AS n FROM app.material_source_reads WHERE episode_id=$1',[episode])).rows[0].n,0);
  const candidate=await c.link.call<string>(c.link.runOf(c.handle),'SELECT gov.propose_candidate($1,$2::jsonb,$3,$4)',[words,JSON.stringify([{episode,excerpt:words}]),c.link.id.agent,'historical-unbound-control']);
  await assert.rejects(c.link.call(c.link.runOf(c.handle),'SELECT gov.request_promotion($1,$2,NULL,NULL)',[candidate,c.link.id.person]),/source withdrawal verification/);
 }
});

test('F5: episode rewrite rules and either explicit source text-column collation pause the exact capability',async t=>{
 const c=await context(t),view=baselineObject(BASELINE,'views/eligible_knowledge_sources.sql');assert.ok(view);
 for(const [column,ddl] of [
  [null,'CREATE RULE divert_material_source AS ON INSERT TO app.episodes DO INSTEAD NOTHING'],
  ['source_kind','ALTER TABLE app.episodes ALTER COLUMN source_kind TYPE text COLLATE "C" USING source_kind::text'],
  ['source_ref','ALTER TABLE app.episodes ALTER COLUMN source_ref TYPE text COLLATE "C" USING source_ref::text'],
 ] as const){
  await c.admin.query('BEGIN');try{
   // A dependent view can prevent a legal ALTER TYPE/COLLATE. Recreate exactly its canonical
   // owner/source/ACL inside this rollback-only fixture, rather than editing system catalogues.
   if(column==='source_kind')await c.admin.query('DROP VIEW gov.eligible_knowledge_sources');
   await c.admin.query(ddl);
   if(column==='source_kind')await c.admin.query('SET LOCAL ROLE backbone_gov;'+view+'\nRESET ROLE;');
   const catalogue=await inspectMaterialEnforcement(c.admin);
   assert.deepEqual(catalogue.posture,[{safe:false}],ddl);
   assert.equal(materialEnforcementCatalogueState(catalogue),'unknown',ddl);
   assert.equal((await verifyMaterialEnforcement(c.admin)).state,'paused',ddl);
  }finally{await rollback(c.admin);}
  assert.equal((await verifyMaterialEnforcement(c.admin)).state,'verified');
 }
});
