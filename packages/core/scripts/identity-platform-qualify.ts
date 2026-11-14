// The new profile is derived only from a disposable, exact predecessor.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {startTestPostgres} from '../src/db/testing.ts';
import {MATERIAL_CLOSURE_RELEASE as release} from '../src/db/identity-platform-release.generated.ts';
import {IDENTITY_GUARANTEES_PINS} from '../src/db/identity-guarantees-pins.ts';
import {IDENTITY_PLATFORM_PINS} from '../src/db/identity-platform-pins.ts';
import {captureIdentity,identityHash,verifyIdentity} from '../src/db/identity-catalogue.ts';
import {verifyIdentityRuntime} from '../src/db/identity-runtime.ts';
import {verifyMaterialClosureHardeningCatalogue} from '../src/db/material-closure-hardening-profile.ts';
import {upgradeIdentityPlatform} from '../src/db/identity-platform.ts';
const postgres=await startTestPostgres({unqualifiedIdentityPlatformBaseline:true});
await postgres.clone('identity_platform_source');
const client=new pg.Client({connectionString:postgres.adminUrl('identity_platform_source')});
try{
 await client.connect();const before=await captureIdentity(client);
 assert.equal(identityHash(JSON.stringify(before)),IDENTITY_GUARANTEES_PINS?.catalogue);
 await client.query('BEGIN');await client.query(release.sql);
 const after=await captureIdentity(client);
 for(const row of before){
  const next=after.find(next=>next.kind===row.kind&&next.name===row.name);assert.ok(next);
  if(row.name==='gov.identity_bind_new_task()')assert.notDeepEqual(next,row);else assert.deepEqual(next,row);
 }
 assert.equal(after.filter(row=>row.kind==='attachment'&&row.name.endsWith('.identity_mutation_context')).length,3);
 const pins={payload:release.checksum,predecessor:IDENTITY_GUARANTEES_PINS!.catalogue,catalogue:identityHash(JSON.stringify(after)),signatures:{...IDENTITY_GUARANTEES_PINS!.signatures}};
 if(process.argv.includes('--write'))writeFileSync(new URL('../src/db/identity-platform-pins.ts',import.meta.url),'// Qualified from the exact disposable guarantees predecessor; no user data supplies pins.\nexport const IDENTITY_PLATFORM_PINS:{payload:string;predecessor:string;catalogue:string;signatures:Record<string,string>}|null='+JSON.stringify(pins)+';\n');
 else{
  assert.deepEqual(pins,IDENTITY_PLATFORM_PINS);
  await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[release.version,release.checksum]);
  assert.equal((await verifyIdentity(client)).state,'verified');
  assert.equal((await verifyMaterialClosureHardeningCatalogue(client)).state,'verified');
  // A platform-only predecessor is no longer the complete runtime history.
  assert.equal((await verifyIdentityRuntime(client)).state,'paused');
 }
 await client.query('ROLLBACK');assert.deepEqual(await captureIdentity(client),before);
 if(!process.argv.includes('--write')){
  assert.equal((await upgradeIdentityPlatform(client)).state,'verified');
  assert.equal((await upgradeIdentityPlatform(client)).state,'verified');
  // A platform-only predecessor is no longer the complete runtime history.
  assert.equal((await verifyIdentityRuntime(client)).state,'paused');
 }
 console.log('Identity platform profile preserves its predecessor, rolls back exactly and installs idempotently.');
}finally{await client.end();await postgres.drop('identity_platform_source');await postgres.stop();}
