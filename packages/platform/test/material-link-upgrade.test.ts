import { waitFor } from '../../../scripts/lib/test-hang.ts';
// Additive linkage must never rewrite the released guard or accept caller-selected DDL.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import pg from 'pg';
import {buildBaseline,materialGuardStep,upgradeMaterialGuard,verifyMaterialGuard,verifyMaterialEnforcement,verifyMaterialClosure,upgradeMaterialEnforcement,upgradeSignatureLedger,upgradeMaterialClosure,upgradeMaterialClosureHardening} from '@backbone/core/db';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {materialLinkStep,inspectMaterialLink,upgradeMaterialLink,verifyMaterialLink} from '../../core/src/db/material-link.ts';
import {inspectMaterialGuard} from '../../core/src/db/material-guard.ts';
import {CORE_SCHEMA_UPGRADES} from '../../core/src/db/schema-migrations.ts';
import {CoreLink} from '../src/composition/core.ts';
import {freshDir,freshHome} from './helpers.ts';
import {writePlaintextVault} from '../src/keys/vault.ts';
import {legacyCoreDatabase} from './fixtures/legacy-core.ts';
import {upgradeIdentity} from '../../core/src/db/identity.ts';
import {upgradeIdentityWork} from '../../core/src/db/identity-work.ts';
import {upgradeIdentityRoleRevocation} from '../../core/src/db/identity-role-revocation.ts';
import {upgradeIdentityResource} from '../../core/src/db/identity-resource.ts';
import {upgradeIdentityAdmission} from '../../core/src/db/identity-admission.ts';
import {upgradeIdentityGuarantees} from '../../core/src/db/identity-guarantees.ts';
import {upgradeIdentityPlatform} from '../../core/src/db/identity-platform.ts';
import {upgradeIdentityHardening} from '../../core/src/db/identity-hardening.ts';
import {captureIdentity} from '../../core/src/db/identity-catalogue.ts';
import {verifyIdentityRuntime} from '../../core/src/db/identity-runtime.ts';
const identityUpgrades=[upgradeIdentity,upgradeIdentityWork,upgradeIdentityRoleRevocation,upgradeIdentityResource,upgradeIdentityAdmission,upgradeIdentityGuarantees,upgradeIdentityPlatform,upgradeIdentityHardening];
const fixture=JSON.parse(readFileSync(new URL('./fixtures/material-guard-legacy.json',import.meta.url),'utf8'));
const legacySql=fixture.sqlLines.join('\n')+'\n';
const baseline=buildBaseline().sql;
async function context(t:TestContext,legacy:boolean|'historical-fresh'=false){
 const home=freshHome();const url=dataHomeAdminUrl(home);const name=new URL(url).pathname.slice(1);
 assert.match(name,/^home_[a-f0-9]+$/);
 if(legacy===true)assert.equal(createHash('sha256').update(legacySql).digest('hex'),fixture.sqlSha256);
 const admin=legacy?await legacyCoreDatabase(url,legacy==='historical-fresh'?baseline:legacySql):new pg.Client({connectionString:url});
 if(!legacy)await admin.connect();
 t.after(()=>admin.end());
 const link=await CoreLink.open({home});
 t.after(async()=>{await link.close();});
 return {home,url,admin,link};
}
async function evidence(admin:pg.Client){
 const result:Record<string,unknown>={};
 for(const table of ['episodes','knowledge_candidates','knowledge','decisions','ledger','ledger_heads'])
  result[table]=(await admin.query(`SELECT to_jsonb(x) AS row FROM app.${table} x ORDER BY to_jsonb(x)::text`)).rows;
 return result;
}

test('the link step uses only its pinned baseline blocks after the unchanged released guard',()=>{
 const baseline=buildBaseline().sql;const step=materialLinkStep(baseline);assert.ok(step);
 assert.equal(createHash('sha256').update(step.sql).digest('hex'),step.checksum);
 assert.deepEqual(CORE_SCHEMA_UPGRADES[1],{version:'material-source-link-v1',checksum:step.checksum});
 assert.equal(materialGuardStep(baseline)?.checksum,'aa19fe4ce8779ed4040f50b4a225cfb6e73d71b25787ab3f34aaae23f881cab7');
 assert.deepEqual(materialLinkStep(baseline.replace(/\n/g,'\r\n')),step);
 assert.equal(materialLinkStep(baseline.replace('CREATE TABLE app.material_source_reads','CREATE TABLE app.changed_source_reads')),null);
 assert.equal(materialLinkStep(baseline+'\n\n-- gov/withdraw_material_source.sql\n\nSELECT 1;'),null);
 assert.doesNotMatch(step.sql,/CREATE OR REPLACE|DROP |UPDATE app\.|DELETE FROM/);
});

test('a known owned upgrade is additive, serializes retries and preserves the qualified guard and all existing evidence',async t=>{
 const old=await context(t,true);const fresh=await context(t,'historical-fresh');
 for(const upgrade of [upgradeMaterialGuard,upgradeMaterialLink])assert.equal((await upgrade(fresh.admin,baseline)).state,'verified');
 assert.equal((await upgradeMaterialGuard(old.admin,baseline)).state,'verified');
 const run=await old.link.startRun(await old.link.createTask('Synthetic preserved material'));
 await old.link.call(old.link.system(),"SELECT gov.record_source('file','synthetic','Synthetic existing material',NULL,$1,NULL)",[run.run]);
 const before=await evidence(old.admin);const guard=await inspectMaterialGuard(old.admin);
 const other=new pg.Client({connectionString:old.url});await other.connect();t.after(()=>other.end());
 assert.deepEqual((await Promise.all([upgradeMaterialLink(old.admin,baseline),upgradeMaterialLink(other,baseline)])).map(r=>r.state),['verified','verified']);
 assert.deepEqual(await evidence(old.admin),before);
 assert.deepEqual(await inspectMaterialGuard(old.admin),guard);
 assert.equal((await verifyMaterialGuard(old.admin)).state,'verified');
 assert.deepEqual(await inspectMaterialLink(old.admin),await inspectMaterialLink(fresh.admin));
 // The old-profile equality above remains an independent released contract.
 // Compare C1 only after both sides traverse the real owned installer chain.
 for(const c of [old,fresh]){
  for(const upgrade of [upgradeMaterialEnforcement,upgradeSignatureLedger,upgradeMaterialClosure,upgradeMaterialClosureHardening]){
   const result=await upgrade(c.admin,baseline);assert.equal(result.state,'verified',result.reason);
  }
  // Closure legitimately appends its native dependency boundary. C1 must not
  // change any of that evidence or its ledger when it adds project bindings.
  const materialBeforeIdentity=await evidence(c.admin);
  for(const upgrade of identityUpgrades){const result=await upgrade(c.admin);assert.equal(result.state,'verified',result.reason);}
  assert.deepEqual(await evidence(c.admin),materialBeforeIdentity);
  assert.equal((await verifyIdentityRuntime(c.admin)).state,'verified');
 }
 assert.deepEqual(await captureIdentity(old.admin),await captureIdentity(fresh.admin));
 assert.deepEqual(await inspectMaterialLink(old.admin),await inspectMaterialLink(fresh.admin));
 const owners=(await old.admin.query("SELECT c.relname AS name,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname IN ('material_source_identities','material_source_reads','material_source_withdrawals') ORDER BY name")).rows;
 assert.deepEqual(owners,['material_source_identities','material_source_reads','material_source_withdrawals'].map(name=>({name,owner:'backbone_owner'})));
 const functions=(await old.admin.query("SELECT p.proname AS name,pg_get_userbyid(p.proowner) AS owner,p.prosecdef AS definer,p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gov' AND p.proname IN ('record_material_source_read','withdraw_material_source') ORDER BY name")).rows;
 assert.deepEqual(functions,['record_material_source_read','withdraw_material_source'].map(name=>({name,owner:'backbone_gov',definer:true,config:['search_path=pg_catalog']})));
 assert.equal((await verifyMaterialLink(old.admin)).state,'verified');
 assert.equal((await old.admin.query("SELECT count(*)::int n FROM ops.schema_migrations WHERE version='material-source-link-v1'")).rows[0].n,1);
});

test('external link verification performs catalogue reads only and refuses unknown history or changed immutable evidence rules',async t=>{
 const {admin,home}=await context(t);
 const {appUrl}=JSON.parse(readFileSync(join(home,'pg','external.json'),'utf8'));
 const app=new pg.Client({connectionString:appUrl});await app.connect();t.after(()=>app.end());
 assert.equal((await app.query('SELECT current_user AS role')).rows[0].role,'backbone_app');
 assert.equal((await verifyMaterialLink(app)).state,'verified');
 const raw=admin.query.bind(admin);const reads=new Proxy(admin,{get(target,key){
  if(key!=='query')return Reflect.get(target,key);
  return(sql:string,...args:unknown[])=>{assert.match(sql.trim(),/^SELECT\b/);return raw(sql,...args as []);};
 }});
 assert.equal((await verifyMaterialLink(reads)).state,'verified');
 await admin.query("INSERT INTO ops.schema_migrations(version,checksum) VALUES('unknown-link-step',$1)",['0'.repeat(64)]);
 const history=(await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 const catalogue=await inspectMaterialLink(admin);
 try{
  assert.equal((await verifyMaterialLink(reads)).state,'paused');
  assert.equal((await upgradeMaterialLink(admin,baseline)).state,'paused');
  assert.deepEqual((await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);
  assert.deepEqual(await inspectMaterialLink(admin),catalogue);
 }finally{await admin.query("DELETE FROM ops.schema_migrations WHERE version='unknown-link-step'");}
 assert.equal((await verifyMaterialLink(reads)).state,'verified');
 await admin.query('BEGIN');
 try{
  await admin.query('ALTER TABLE app.material_source_reads DISABLE TRIGGER evidence');
  assert.equal((await verifyMaterialLink(reads)).state,'paused');
 }finally{await admin.query('ROLLBACK');}
 assert.equal((await verifyMaterialLink(reads)).state,'verified');
});

function linkPostureMutations(){
 const signature='gov.withdraw_material_source(text,text,text,integer,integer,text)';
 return [
  `ALTER FUNCTION ${signature} OWNER TO backbone_owner`,
  `ALTER FUNCTION ${signature} SECURITY INVOKER`,
  `ALTER FUNCTION ${signature} SET search_path=public`,
  'GRANT SELECT ON app.material_source_withdrawals TO backbone_app',
  'ALTER TABLE app.material_source_withdrawals NO FORCE ROW LEVEL SECURITY',
  'ALTER POLICY tenant_wall ON app.material_source_withdrawals USING (true) WITH CHECK (true)',
  'ALTER TABLE app.material_source_reads SET UNLOGGED',
  'CREATE RULE discard_withdrawal AS ON INSERT TO app.material_source_withdrawals DO INSTEAD NOTHING',
 ];
}
test('ownership, definer, search path, grants, RLS, policy, persistence and rewrite-rule tampering each pause without a receipt',async t=>{
 // Preserve the released link's independent exact-reason grader before the complete closure
 // profile also covers these objects through the prerequisite guard.
 const {admin}=await context(t,true);
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 assert.equal((await upgradeMaterialLink(admin,baseline)).state,'verified');
 assert.equal((await verifyMaterialEnforcement(admin)).state,'paused');
 const mutations=linkPostureMutations();
 const history=(await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 for(const mutation of mutations){
  await admin.query('BEGIN');
  try{
   await admin.query(mutation);
   const status=await verifyMaterialLink(admin);assert.equal(status.state,'paused',mutation);
   assert.equal(status.reason,'Material link definitions differ from the qualified catalogue.',mutation);
   assert.deepEqual((await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);
  }finally{await admin.query('ROLLBACK');}
  assert.equal((await verifyMaterialLink(admin)).state,'verified',mutation);
 }
});

test('the appended complete profile rejects every released-link posture mutation without a receipt or repair',async t=>{
 const {admin}=await context(t);
 assert.equal((await verifyMaterialClosure(admin)).state,'verified');
 const history=(await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 for(const mutation of linkPostureMutations()){
  await admin.query('BEGIN');
  try{
   await admin.query(mutation);
   assert.equal((await verifyMaterialClosure(admin)).state,'paused',mutation);
   assert.equal((await verifyMaterialGuard(admin)).state,'paused',mutation);
   const status=await verifyMaterialLink(admin);assert.equal(status.state,'paused',mutation);
   assert.equal(status.reason,'The prerequisite Core source guard is not verified.',mutation);
   assert.deepEqual((await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);
  }finally{await admin.query('ROLLBACK');}
  assert.equal((await verifyMaterialClosure(admin)).state,'verified',mutation);
  assert.equal((await verifyMaterialLink(admin)).state,'verified',mutation);
 }
});

test('role posture, constraints, column types and defaults, indexes, dependencies and execution grants each discriminate tampering',async t=>{
 // Isolate the released link's own attestation boundary. An enforced fresh profile also
 // rejects unsafe roles at the prerequisite guard, which would conceal this independent check.
 const {admin}=await context(t,true);
 assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 assert.equal((await upgradeMaterialLink(admin,baseline)).state,'verified');
 assert.equal((await verifyMaterialGuard(admin)).state,'verified');
 assert.equal((await verifyMaterialLink(admin)).state,'verified');
 assert.equal((await verifyMaterialEnforcement(admin)).state,'paused');
 assert.deepEqual((await admin.query(`SELECT to_regprocedure('gov._material_source_state(uuid)') IS NULL AS state_absent,
  to_regprocedure('sec.t_material_episode_source()') IS NULL AS trigger_function_absent,
  NOT EXISTS (SELECT FROM pg_catalog.pg_trigger WHERE tgrelid='app.episodes'::regclass
    AND tgname='material_source_receipt' AND NOT tgisinternal) AS trigger_absent`)).rows,
  [{state_absent:true,trigger_function_absent:true,trigger_absent:true}]);
 assert.deepEqual((await admin.query("SELECT version,checksum FROM ops.schema_migrations WHERE version<>'baseline' ORDER BY version")).rows,
  [...CORE_SCHEMA_UPGRADES.slice(0,2)].sort((a,b)=>a.version.localeCompare(b.version)));
 const constraint=async(definition:string)=>{
  const rows=(await admin.query("SELECT conname FROM pg_constraint WHERE conrelid='app.material_source_withdrawals'::regclass AND pg_get_constraintdef(oid,true)=$1",[definition])).rows;
  assert.equal(rows.length,1,definition);
  // Generated identifiers exceed 63 characters before PostgreSQL chooses its final spelling.
  return '"'+String(rows[0].conname).replace(/"/g,'""')+'"';
 };
 const unique=await constraint('UNIQUE (workspace_id, material_id, generation)');
 const foreign=await constraint('FOREIGN KEY (workspace_id, recorded_by) REFERENCES app.principals(workspace_id, id)');
 const mutations=[
  'ALTER ROLE backbone_app BYPASSRLS',
  'GRANT backbone_app TO backbone_operator',
  `ALTER TABLE app.material_source_withdrawals DROP CONSTRAINT ${unique}`,
  `ALTER TABLE app.material_source_withdrawals ALTER CONSTRAINT ${foreign} DEFERRABLE INITIALLY DEFERRED`,
  `ALTER TABLE app.material_source_withdrawals DROP CONSTRAINT ${foreign}; ALTER TABLE app.material_source_withdrawals ADD CONSTRAINT ${foreign} FOREIGN KEY (workspace_id, recorded_by) REFERENCES app.principals(workspace_id,id) NOT VALID`,
  'ALTER TABLE app.material_source_reads ALTER COLUMN receipt_id DROP DEFAULT',
  'ALTER TABLE app.material_source_withdrawals ALTER COLUMN event_at TYPE varchar',
  'DROP INDEX app.material_source_reads_version',
  "CREATE OR REPLACE FUNCTION sec.digest(p_words text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::text $$",
  'REVOKE EXECUTE ON FUNCTION gov.withdraw_material_source(text,text,text,integer,integer,text) FROM backbone_app',
 ];
 const history=(await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 for(const mutation of mutations){
  await admin.query('BEGIN');
  try{
   await admin.query(mutation);
   assert.equal((await verifyMaterialGuard(admin)).state,'verified',mutation);
   const status=await verifyMaterialLink(admin);assert.equal(status.state,'paused',mutation);
   assert.equal(status.reason,'Material link definitions differ from the qualified catalogue.',mutation);
   assert.deepEqual((await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);
  }finally{await admin.query('ROLLBACK');}
  assert.equal((await verifyMaterialLink(admin)).state,'verified',mutation);
 }
});

test('parallel legacy fixtures coordinate cluster-global roles and a failed installation releases its clients',async t=>{
 const first=freshHome(),second=freshHome();
 const firstUrl=dataHomeAdminUrl(first),secondUrl=dataHomeAdminUrl(second);
 await assert.rejects(legacyCoreDatabase(firstUrl,legacySql+'\nSELECT 1/0;'),(error:unknown)=>
  (error as {code?:string}).code==='22012');
 // Replacing that exact database proves the failed setup left no connected installer behind.
 const results=await Promise.allSettled([legacyCoreDatabase(firstUrl,legacySql),legacyCoreDatabase(secondUrl,legacySql)]);
 const clients=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
 for(const client of clients)t.after(()=>client.end());
 for(const result of results)assert.equal(result.status,'fulfilled',result.status==='rejected'?String(result.reason):'fulfilled');
 for(const client of clients)assert.deepEqual((await client.query('SELECT version FROM ops.schema_migrations')).rows,[{version:'baseline'}]);
 assert.deepEqual(await inspectMaterialGuard(clients[0]),await inspectMaterialGuard(clients[1]));
});

test('partial link objects are refused without a guessed repair or migration receipt',async t=>{
 const {admin}=await context(t,true);assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 await admin.query('CREATE TABLE app.material_source_reads (unexpected text)');
 const before=await inspectMaterialLink(admin);const rows=await evidence(admin);
 assert.equal((await upgradeMaterialLink(admin,baseline)).state,'paused');
 assert.deepEqual(await inspectMaterialLink(admin),before);assert.deepEqual(await evidence(admin),rows);
 assert.equal((await admin.query("SELECT count(*)::int n FROM ops.schema_migrations WHERE version='material-source-link-v1'")).rows[0].n,0);
});

test('terminating the additive installer after its first DDL leaves no partial objects or receipt',async t=>{
 const {admin,url}=await context(t,true);assert.equal((await upgradeMaterialGuard(admin,baseline)).state,'verified');
 const before=await inspectMaterialLink(admin);const rows=await evidence(admin);
 const worker=new pg.Client({connectionString:url});worker.on('error',()=>{});await worker.connect();t.after(()=>worker.end().catch(()=>{}));
 const pid=(await worker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await admin.query('SELECT pg_advisory_lock(1111573323,98)');
 try{
  const raw=worker.query.bind(worker);const instrumented=new Proxy(worker,{get(target,key){
   if(key!=='query')return Reflect.get(target,key);
   return(sql:string,...args:unknown[])=>{
    if(typeof sql==='string'&&sql.startsWith('SET LOCAL check_function_bodies=false;'))
     sql=sql.replace('\n);',()=> '\n);\nSELECT pg_advisory_lock(1111573323,98);');
    return raw(sql,...args as []);
   };
  }});
  const upgrading=upgradeMaterialLink(instrumented,baseline);let blocked=false;
  await waitFor(async()=>{
   blocked=(await admin.query("SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1111573323 AND objid=98 AND NOT granted",[pid])).rows[0].n===1;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
  return !!blocked;},'material-link-upgrade: SQL lock observation',{diagnostic:()=>`blocked=${blocked}`});
  assert.equal(blocked,true,'installer reached the latch after its first CREATE TABLE');
  assert.equal((await admin.query('SELECT pg_terminate_backend($1) stopped',[pid])).rows[0].stopped,true);
  assert.equal((await upgrading).state,'paused');
 }finally{await admin.query('SELECT pg_advisory_unlock(1111573323,98)');}
 assert.deepEqual(await inspectMaterialLink(admin),before);assert.deepEqual(await evidence(admin),rows);
 assert.equal((await admin.query("SELECT count(*)::int n FROM ops.schema_migrations WHERE version='material-source-link-v1'")).rows[0].n,0);
 assert.equal((await upgradeMaterialLink(admin,baseline)).state,'verified');
});

test('actual owned open installs the prerequisite then the link once; external old homes stay untouched',async t=>{
 const old=await context(t,true);assert.equal(old.link.materialLink.state,'paused');
 assert.equal((await old.admin.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname='material_source_reads'")).rows[0].n,0);
 const home=freshDir('backbone-owned-link-');writePlaintextVault(home);
 let link=await CoreLink.open({home,baselineSql:legacySql.replace(/\n/g,'\r\n')});
 t.after(async()=>{await link.close();});assert.equal(link.materialLink.state,'paused');
 // The Team update of an existing folder is admitted only on the app main-process path.
 await link.close();link=await CoreLink.open({home,allowIdentityUpgrade:true});
 assert.equal(link.materialGuard.state,'verified',link.materialGuard.reason);assert.equal(link.materialLink.state,'verified',link.materialLink.reason);
 const passwords=await link.vault.passwords().read();assert.ok(passwords);
 const admin=new pg.Client({connectionString:dataHomeAdminUrl(home,passwords)});await admin.connect();
 const history=(await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 assert.deepEqual(history.map(row=>row.version),['baseline',...CORE_SCHEMA_UPGRADES.map(step=>step.version)].sort());await admin.end();
 await link.close();link=await CoreLink.open({home});assert.equal(link.materialLink.state,'verified',link.materialLink.reason);
 const reopened=new pg.Client({connectionString:dataHomeAdminUrl(home,passwords)});await reopened.connect();
 try{assert.deepEqual((await reopened.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);}finally{await reopened.end();}
});
