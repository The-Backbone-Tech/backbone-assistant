import {captureDeviceOnly} from '../src/db/identity-device-only.ts';
import {IDENTITY_DEVICE_ONLY_PIN} from '../src/db/identity-device-only-pins.ts';
import {IDENTITY_DEVICE_RECOVERY_PIN} from '../src/db/identity-device-recovery-pins.ts';
import {captureDeviceRecovery,recoveryHash} from '../src/db/identity-device-recovery.ts';
// Qualify only a disposable exact predecessor, never a user's data folder.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {startTestPostgres} from '../src/db/testing.ts';
import {captureIdentity,identityHash,verifyIdentity} from '../src/db/identity-catalogue.ts';
import {verifyIdentityRuntime} from '../src/db/identity-runtime.ts';
import {IDENTITY_PLATFORM_PINS} from '../src/db/identity-platform-pins.ts';
import {IDENTITY_HARDENING_RELEASES,upgradeIdentityHardening} from '../src/db/identity-hardening.ts';
import {IDENTITY_HARDENING_PINS} from '../src/db/identity-hardening-pins.ts';
import {verifyMaterialClosureHardeningCatalogue} from '../src/db/material-closure-hardening-profile.ts';
const postgres=await startTestPostgres({unqualifiedIdentityHardeningBaseline:true});await postgres.clone('team_qualification');
const client=new pg.Client({connectionString:postgres.adminUrl('team_qualification')});
try{
 await client.connect();const before=await captureIdentity(client);assert.equal(identityHash(JSON.stringify(before)),IDENTITY_PLATFORM_PINS?.catalogue);
 const pins:typeof IDENTITY_HARDENING_PINS[number][]=[];
 const replacements=new Set(['gov.identity_project_share(uuid,uuid,text)','operator.identity_restore_device_access(uuid)','gov.unregister_piece(uuid)','gov.queue_run(uuid,uuid,uuid,uuid,uuid)','gov.propose_undo(uuid,jsonb,text,text,text)','gov.propose_candidate(text,jsonb,uuid,text)']);
 await client.query('BEGIN');
 for(const release of IDENTITY_HARDENING_RELEASES){
  const previous=await captureIdentity(client);await client.query(release.sql);const after=await captureIdentity(client);
  for(const row of previous){const next=after.find(item=>item.kind===row.kind&&item.name===row.name);assert.ok(next);if(!replacements.has(row.name))assert.deepEqual(next,row);}
  pins.push({version:release.version,payload:release.checksum,predecessor:identityHash(JSON.stringify(previous)),catalogue:identityHash(JSON.stringify(after))});
 }
 const deviceOnlyPin=recoveryHash(await captureDeviceOnly(client));
 if(!process.argv.includes('--write'))assert.equal(deviceOnlyPin,IDENTITY_DEVICE_ONLY_PIN);
 if(process.argv.includes('--write'))writeFileSync(new URL('../src/db/identity-device-only-pins.ts',import.meta.url),"// Qualified only on a disposable closed predecessor; never a user's catalogue.\nexport const IDENTITY_DEVICE_ONLY_PIN='"+deviceOnlyPin+"';\n");
 const recoveryPin=recoveryHash(await captureDeviceRecovery(client));
 if(!process.argv.includes('--write'))assert.equal(recoveryPin,IDENTITY_DEVICE_RECOVERY_PIN);
 if(process.argv.includes('--write'))writeFileSync(new URL('../src/db/identity-device-recovery-pins.ts',import.meta.url),"// Qualified only on a disposable closed predecessor; never a user's catalogue.\nexport const IDENTITY_DEVICE_RECOVERY_PIN='"+recoveryPin+"';\n");
 await client.query('ROLLBACK');assert.deepEqual(await captureIdentity(client),before);
 if(process.argv.includes('--write'))assert.deepEqual(pins.slice(0,IDENTITY_HARDENING_PINS.length),IDENTITY_HARDENING_PINS);
 if(process.argv.includes('--write'))writeFileSync(new URL('../src/db/identity-hardening-pins.ts',import.meta.url),'// Qualified only from a disposable exact predecessor; no user catalogue supplies pins.\nexport const IDENTITY_HARDENING_PINS: ReadonlyArray<{version:string;payload:string;predecessor:string;catalogue:string}> = '+JSON.stringify(pins,null,2)+';\n');
 else{
  assert.deepEqual(pins,IDENTITY_HARDENING_PINS);
  assert.equal((await upgradeIdentityHardening(client)).state,'verified');
  assert.equal((await upgradeIdentityHardening(client)).state,'verified');
  assert.equal((await verifyIdentityRuntime(client)).state,'verified');
  assert.equal((await verifyIdentity(client)).state,'verified');
  assert.equal((await verifyMaterialClosureHardeningCatalogue(client)).state,'verified');
 }
 console.log('Exact predecessor, transactional rollback and closed hardening profile qualified.');
}finally{await client.end();await postgres.drop('team_qualification');await postgres.stop();}
