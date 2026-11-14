import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {upgradeIdentityResource} from '../src/db/identity-resource.ts';
import {serviceClient} from '../src/db/session.ts';
import {startTestPostgres} from '../src/db/testing.ts';
import {MATERIAL_CLOSURE_RELEASE as release} from '../src/db/identity-resource-release.generated.ts';
import {captureIdentity,identityHash,verifyIdentity} from '../src/db/identity-catalogue.ts';
import {IDENTITY_ROLE_REVOCATION_PINS} from '../src/db/identity-role-revocation-pins.ts';
import {IDENTITY_RESOURCE_PINS} from '../src/db/identity-resource-pins.ts';
import {collectMaterialClosureCatalogue} from '../src/db/material-closure-catalogue.ts';
import {verifyMaterialClosureHardeningCatalogue} from '../src/db/material-closure-hardening-profile.ts';

const postgres=await startTestPostgres({unqualifiedIdentityResourceBaseline:true});await postgres.clone('identity_resource_source');
const client=new pg.Client({connectionString:postgres.adminUrl('identity_resource_source')});
try{
 await client.connect();const before=await captureIdentity(client);assert.equal(identityHash(JSON.stringify(before)),IDENTITY_ROLE_REVOCATION_PINS?.catalogue);
 const nativeBefore=await collectMaterialClosureCatalogue(client);
 await client.query('BEGIN');await client.query(release.sql);
 const after=await captureIdentity(client);assert.equal(after.filter(r=>r.kind==='function').length,35);assert.equal(after.filter(r=>r.kind==='table').length,10);
 const changed=new Set(['gov.identity_task_access(uuid,boolean)','gov.identity_person_task_access(uuid,uuid,boolean)','gov.identity_create_task(uuid,text)','gov.identity_bind_task(uuid,uuid)','gov.identity_directory_list(text)','gov.identity_project_access(uuid)',
 'app.tasks.identity_project_insert','app.runs.identity_project_crossing_read','app.effects.identity_project_crossing_read','app.effects.identity_project_read','app.effects.identity_project_update']);
 for(const row of before){const next=after.find(r=>r.kind===row.kind&&r.name===row.name);assert.ok(next);
  if(changed.has(row.name)){
   assert.notDeepEqual(next.definition,row.definition);
   if(row.kind==='function'){const {definition:oldBody,...oldAuthority}=row.definition;const {definition:newBody,...newAuthority}=next.definition;assert.notEqual(oldBody,newBody);assert.deepEqual(newAuthority,oldAuthority);}
  }else assert.deepEqual(next,row);
 }
 const nativeAfter=await collectMaterialClosureCatalogue(client);
 for(const signature of ['gov.claim_run(uuid,text,integer,text,uuid)','gov.claim_next_run(text,integer,text,uuid)','gov.revoke_mandate(uuid)','gov.claim_next_effect(text,integer)','gov.claim_next_verification(text,integer)','gov.join_channel_thread(uuid,uuid)','gov.share_task(uuid)']){
  const {body:oldBody,...oldAuthority}=nativeBefore.functions.find(row=>row.signature===signature)!;
  const {body:newBody,...newAuthority}=nativeAfter.functions.find(row=>row.signature===signature)!;
  assert.notEqual(oldBody,newBody);assert.deepEqual(newAuthority,oldAuthority);
 }
 const pins={payload:release.checksum,predecessor:IDENTITY_ROLE_REVOCATION_PINS!.catalogue,catalogue:identityHash(JSON.stringify(after))};
 if(process.argv.includes('--write'))writeFileSync(new URL('../src/db/identity-resource-pins.ts',import.meta.url),'// Qualified from the disposable closed predecessor, never a live home.\nexport const IDENTITY_RESOURCE_PINS: {payload:string;predecessor:string;catalogue:string}|null='+JSON.stringify(pins)+';\n');
 else{
  assert.deepEqual(pins,IDENTITY_RESOURCE_PINS);
  await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[release.version,release.checksum]);
  assert.equal((await verifyIdentity(client)).state,'verified');assert.equal((await verifyMaterialClosureHardeningCatalogue(client)).state,'verified');
 }
 await client.query('ROLLBACK');assert.deepEqual(await captureIdentity(client),before);
 if(!process.argv.includes('--write')){
  await client.query('SET ROLE backbone_operator');
  const made=(await client.query('SELECT * FROM operator.create_workspace($1,$2,$3,$4)',['Upgrade fixture','team','Owner','owner@example.invalid'])).rows[0];
  await client.query('RESET ROLE');
  const service=await serviceClient(postgres.appUrl('identity_resource_source'));
  try{
   await service.query('BEGIN');await service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[made.workspace_id,made.owner_id]);
   const task=(await service.query('SELECT gov.create_task($1,$1,$2,NULL,NULL) AS id',[made.owner_id,'Existing human task'])).rows[0].id;const shared=(await service.query("SELECT gov.create_task($1,$1,$2,NULL,'workspace') AS id",[made.owner_id,'Existing workspace task'])).rows[0].id;await service.query('COMMIT');
   assert.equal((await client.query('SELECT count(*)::int AS n FROM app.identity_task_projects WHERE task_id=$1',[task])).rows[0].n,0);
   assert.equal((await upgradeIdentityResource(client)).state,'verified');
   assert.equal((await client.query('SELECT count(*)::int AS n FROM app.identity_task_projects WHERE task_id=$1',[task])).rows[0].n,1);
   assert.equal((await client.query('SELECT title FROM app.tasks WHERE id=$1',[task])).rows[0].title,'Existing human task');
   assert.equal((await upgradeIdentityResource(client)).state,'verified');
   await service.query('BEGIN');await service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[made.workspace_id,made.owner_id]);
   const later=(await service.query("SELECT gov.add_person('Later person',NULL,'member') AS id")).rows[0].id;await service.query('COMMIT');
   await service.query('BEGIN');await service.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[made.workspace_id,later]);
   assert.deepEqual((await service.query('SELECT id FROM app.tasks WHERE id IN($1,$2)',[task,shared])).rows.map(row=>row.id),[shared]);await service.query('COMMIT');
  }finally{await service.end();}
 }
 console.log('Resource guard reproduces its complete native catalogue, explicit replacements and attachment; predecessor rollback is exact.');
}finally{await client.end();await postgres.drop('identity_resource_source');await postgres.stop();}
