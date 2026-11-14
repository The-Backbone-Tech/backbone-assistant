import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {startTestPostgres} from '../src/db/testing.ts';
import {MATERIAL_CLOSURE_RELEASE as release} from '../src/db/identity-admission-release.generated.ts';
import {IDENTITY_ADMISSION_PINS} from '../src/db/identity-admission-pins.ts';
import {IDENTITY_RESOURCE_PINS} from '../src/db/identity-resource-pins.ts';
import {captureIdentity,identityHash,verifyIdentity} from '../src/db/identity-catalogue.ts';
import {collectMaterialClosureCatalogue} from '../src/db/material-closure-catalogue.ts';
import {verifyMaterialClosureHardeningCatalogue} from '../src/db/material-closure-hardening-profile.ts';
import {inspectSignatureLedger} from '../src/db/signature-ledger-catalogue.ts';
import {verifySignatureLedger} from '../src/db/signature-ledger.ts';
import {upgradeIdentityAdmission} from '../src/db/identity-admission.ts';
import {verifyIdentityRuntime} from '../src/db/identity-runtime.ts';
import {upgradeIdentity} from '../src/db/identity.ts';
import {upgradeIdentityWork} from '../src/db/identity-work.ts';
import {upgradeIdentityRoleRevocation} from '../src/db/identity-role-revocation.ts';
import {upgradeIdentityResource} from '../src/db/identity-resource.ts';

const postgres=await startTestPostgres({unqualifiedIdentityAdmissionBaseline:true});await postgres.clone('identity_admission_source');
const client=new pg.Client({connectionString:postgres.adminUrl('identity_admission_source')});
try{
 await client.connect();const before=await captureIdentity(client),nativeBefore=await collectMaterialClosureCatalogue(client);
 assert.equal(identityHash(JSON.stringify(before)),IDENTITY_RESOURCE_PINS?.catalogue);
 assert.equal((await verifyIdentityRuntime(client)).state,'paused');
 await client.query('BEGIN');await client.query(release.sql);
 const after=await captureIdentity(client),nativeAfter=await collectMaterialClosureCatalogue(client);
 assert.equal(after.filter(row=>row.kind==='function').length,37);assert.equal(after.filter(row=>row.kind==='table').length,10);
 for(const row of before){const next=after.find(next=>next.kind===row.kind&&next.name===row.name);assert.ok(next);
  if(['gov.identity_bind_task(uuid,uuid)','gov.identity_document_access(uuid,boolean)','gov.identity_effect_decider_access(uuid)'].includes(row.name)){
   const {definition:oldBody,...oldAuthority}=row.definition,{definition:newBody,...newAuthority}=next.definition;
   assert.notEqual(newBody,oldBody);assert.deepEqual(newAuthority,oldAuthority);
  }else if(row.kind==='policy'&&['app.documents.identity_project_','app.episodes.identity_project_'].some(prefix=>row.name.startsWith(prefix))){
   const {qual:oldRead,with_check:oldWrite,...oldAuthority}=row.definition;
   const {qual:newRead,with_check:newWrite,...newAuthority}=next.definition;
   assert.deepEqual(newAuthority,oldAuthority);assert.notDeepEqual([newRead,newWrite],[oldRead,oldWrite]);
   assert.match([newRead,newWrite].join(' '),/identity_material_scope/);
  }else assert.deepEqual(next,row);
 }
 for(const signature of ['gov._mandate_standing(uuid)','gov._task_read_beyond(uuid,uuid)','gov.quote_marks(uuid,jsonb)','gov._quote_run(uuid,uuid)','gov.unregister_piece(uuid)','gov.give_connector_signature(uuid,text,text)','gov._may_answer(uuid,uuid,text)']){
  const {body:oldBody,...oldAuthority}=nativeBefore.functions.find(row=>row.signature===signature)!;
  const {body:newBody,...newAuthority}=nativeAfter.functions.find(row=>row.signature===signature)!;
  assert.notEqual(newBody,oldBody);assert.deepEqual(newAuthority,oldAuthority);
 }
 const signatureProfile=await inspectSignatureLedger(client);
 const pins={payload:release.checksum,predecessor:IDENTITY_RESOURCE_PINS!.catalogue,catalogue:identityHash(JSON.stringify(after)),signatures:Object.fromEntries(['gov.give_connector_signature(uuid,text,text)','gov._may_answer(uuid,uuid,text)'].map(name=>[name,signatureProfile.functions[name]!]))};
 if(process.argv.includes('--write'))writeFileSync(new URL('../src/db/identity-admission-pins.ts',import.meta.url),'// Qualified only against a disposable closed predecessor.\nexport const IDENTITY_ADMISSION_PINS: {payload:string;predecessor:string;catalogue:string;signatures:Record<string,string>}|null='+JSON.stringify(pins)+';\n');
 else{
  assert.deepEqual(pins,IDENTITY_ADMISSION_PINS);
  await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[release.version,release.checksum]);
  assert.equal((await verifyIdentity(client)).state,'verified');assert.equal((await verifyMaterialClosureHardeningCatalogue(client)).state,'verified');assert.equal((await verifySignatureLedger(client)).state,'verified');
  assert.equal((await verifyIdentityRuntime(client)).state,'paused');
 }
 await client.query('ROLLBACK');assert.deepEqual(await captureIdentity(client),before);
 if(!process.argv.includes('--write')){
  assert.equal((await upgradeIdentityAdmission(client)).state,'verified');assert.equal((await upgradeIdentityAdmission(client)).state,'verified');
  assert.equal((await verifyIdentityRuntime(client)).state,'paused');
 }
 console.log('Admission closure matches its complete native catalogue, retains predecessor authority and rolls back exactly.');
}finally{await client.end();await postgres.drop('identity_admission_source');await postgres.stop();}

// Exercise actual committed phases as well as the missing-receipt external-home
// matrix. An exact upgrade predecessor must never count as runtime readiness.
if(!process.argv.includes('--write')){
 const phases=await startTestPostgres({unqualifiedIdentityBaseline:true});await phases.clone('identity_runtime_phases');
 const observer=new pg.Client({connectionString:phases.adminUrl('identity_runtime_phases')});
 try{
  await observer.connect();
  for(const install of [upgradeIdentity,upgradeIdentityWork,upgradeIdentityRoleRevocation,upgradeIdentityResource,upgradeIdentityAdmission]){
   assert.equal((await verifyIdentityRuntime(observer)).state,'paused');
   assert.equal((await install(observer)).state,'verified');
  }
  assert.equal((await verifyIdentityRuntime(observer)).state,'paused');
  console.log('Every actual interrupted identity phase stays paused; the reviewed admission predecessor also stays paused until the guarantees step.');
 }finally{await observer.end();await phases.drop('identity_runtime_phases');await phases.stop();}
}
