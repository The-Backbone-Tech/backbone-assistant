import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {startTestPostgres} from '../src/db/testing.ts';
import {MATERIAL_CLOSURE_RELEASE as release} from '../src/db/identity-guarantees-release.generated.ts';
import {IDENTITY_GUARANTEES_PINS} from '../src/db/identity-guarantees-pins.ts';
import {IDENTITY_ADMISSION_PINS} from '../src/db/identity-admission-pins.ts';
import {captureIdentity,identityHash,verifyIdentity} from '../src/db/identity-catalogue.ts';
import {collectMaterialClosureCatalogue} from '../src/db/material-closure-catalogue.ts';
import {verifyMaterialClosureHardeningCatalogue} from '../src/db/material-closure-hardening-profile.ts';
import {inspectSignatureLedger} from '../src/db/signature-ledger-catalogue.ts';
import {verifySignatureLedger} from '../src/db/signature-ledger.ts';
import {upgradeIdentityGuarantees} from '../src/db/identity-guarantees.ts';
import {verifyIdentityRuntime} from '../src/db/identity-runtime.ts';
const replacements=['gov.queue_run(uuid,uuid,uuid,uuid,uuid)','gov.propose_undo(uuid,jsonb,text,text,text)','gov.propose_candidate(text,jsonb,uuid,text)','gov._promotion_sources_allowed(uuid)','sec.t_candidate_input_capture_v1()'];
const postgres=await startTestPostgres({unqualifiedIdentityGuaranteesBaseline:true});await postgres.clone('identity_guarantees_source');
const client=new pg.Client({connectionString:postgres.adminUrl('identity_guarantees_source')});
try{
 await client.connect();const before=await captureIdentity(client),nativeBefore=await collectMaterialClosureCatalogue(client);
 assert.equal(identityHash(JSON.stringify(before)),IDENTITY_ADMISSION_PINS?.catalogue);
 assert.equal((await verifyIdentityRuntime(client)).state,'paused');
 await client.query('BEGIN');await client.query(release.sql);
 const after=await captureIdentity(client),nativeAfter=await collectMaterialClosureCatalogue(client);
 assert.equal(after.filter(row=>row.kind==='function').length,39);assert.equal(after.filter(row=>row.kind==='table').length,10);
 for(const row of before){const next=after.find(next=>next.kind===row.kind&&next.name===row.name);assert.ok(next);
  if(row.kind==='table'){
   const {policies:oldPolicies,triggers:oldTriggers,...oldAuthority}=row.definition;
   const {policies:newPolicies,triggers:newTriggers,...newAuthority}=next.definition;
   assert.deepEqual(newAuthority,oldAuthority);assert.equal(newAuthority.forced,true);assert.equal(newAuthority.rls,true);
   assert.deepEqual(newPolicies.filter((p:any)=>p.name!=='tenant_wall'),oldPolicies.filter((p:any)=>p.name!=='tenant_wall'));
   const oldWall=oldPolicies.find((p:any)=>p.name==='tenant_wall'),wall=newPolicies.find((p:any)=>p.name==='tenant_wall');
   const {using:oldRead,check:oldWrite,...oldWallAuthority}=oldWall,{using:newRead,check:newWrite,...newWallAuthority}=wall;
   assert.deepEqual(newWallAuthority,oldWallAuthority);assert.equal(newRead,'(workspace_id = ( SELECT sec.current_workspace() AS current_workspace))');assert.equal(newWrite,newRead);
   assert.equal((oldTriggers??[]).length,0);assert.equal(newTriggers.length,1);assert.match(newTriggers[0].definition,/BEFORE TRUNCATE/);assert.equal(newTriggers[0].enabled,'O');
  }else assert.deepEqual(next,row);
 }
 for(const signature of replacements){
  const {body:oldBody,language:oldLanguage,...oldAuthority}=nativeBefore.functions.find(row=>row.signature===signature)!;
  const {body:newBody,language:newLanguage,...newAuthority}=nativeAfter.functions.find(row=>row.signature===signature)!;
  assert.notEqual(newBody,oldBody);assert.deepEqual(newAuthority,oldAuthority);
  if(signature!=='gov._promotion_sources_allowed(uuid)')assert.equal(newLanguage,oldLanguage);
 }
 const signatureProfile=await inspectSignatureLedger(client);
 const pins={payload:release.checksum,predecessor:IDENTITY_ADMISSION_PINS!.catalogue,catalogue:identityHash(JSON.stringify(after)),signatures:{...IDENTITY_ADMISSION_PINS!.signatures,...Object.fromEntries(replacements.filter(name=>signatureProfile.functions[name]).map(name=>[name,signatureProfile.functions[name]]))}};
 if(process.argv.includes('--write'))writeFileSync(new URL('../src/db/identity-guarantees-pins.ts',import.meta.url),'// Qualified against the exact disposable admission predecessor; no home supplies expectations.\nexport const IDENTITY_GUARANTEES_PINS:{payload:string;predecessor:string;catalogue:string;signatures:Record<string,string>}|null='+JSON.stringify(pins)+';\n');
 else{
  assert.deepEqual(pins,IDENTITY_GUARANTEES_PINS);
  await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[release.version,release.checksum]);
  assert.equal((await verifyIdentity(client)).state,'verified');assert.equal((await verifyMaterialClosureHardeningCatalogue(client)).state,'verified');assert.equal((await verifySignatureLedger(client)).state,'verified');assert.equal((await verifyIdentityRuntime(client)).state,'paused');
 }
 await client.query('ROLLBACK');assert.deepEqual(await captureIdentity(client),before);
 if(!process.argv.includes('--write')){assert.equal((await upgradeIdentityGuarantees(client)).state,'verified');assert.equal((await upgradeIdentityGuarantees(client)).state,'verified');assert.equal((await verifyIdentityRuntime(client)).state,'paused');}
 console.log('Identity store and native authority guarantees match the complete profile, roll back exactly and install idempotently.');
}finally{await client.end();await postgres.drop('identity_guarantees_source');await postgres.stop();}
