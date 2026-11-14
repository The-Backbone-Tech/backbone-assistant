// The person sees one update. All closed steps and receipts share this transaction;
// the individual installers still own their transactions when used in qualification.
import type pg from 'pg';
import {CORE_SCHEMA_LOCK} from './schema-migrations.ts';
import {upgradeIdentity} from './identity.ts';
import {upgradeIdentityWork} from './identity-work.ts';
import {upgradeIdentityRoleRevocation} from './identity-role-revocation.ts';
import {upgradeIdentityResource} from './identity-resource.ts';
import {upgradeIdentityAdmission} from './identity-admission.ts';
import {upgradeIdentityGuarantees} from './identity-guarantees.ts';
import {upgradeIdentityPlatform} from './identity-platform.ts';
import {upgradeIdentityHardening} from './identity-hardening.ts';
import {verifyIdentityRuntime,IDENTITY_PAUSED,type IdentityRuntimeStatus} from './identity-runtime.ts';

export async function upgradeIdentityCohort(client:pg.ClientBase):Promise<IdentityRuntimeStatus>{
 let transaction=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');transaction=true;
  await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
  await client.query(CORE_SCHEMA_LOCK);
  for(const install of [upgradeIdentity,upgradeIdentityWork,upgradeIdentityRoleRevocation,upgradeIdentityResource,upgradeIdentityAdmission,upgradeIdentityGuarantees,upgradeIdentityPlatform,upgradeIdentityHardening]){
   const step=await install(client,false);
   if(step.state!=='verified')throw new Error(step.reason);
  }
  const status=await verifyIdentityRuntime(client);
  if(status.state!=='verified')throw new Error(status.reason);
  const result=await client.query('COMMIT');transaction=false;
  if(result.command!=='COMMIT')throw new Error('Identity commit was not confirmed.');
  return status;
 }catch{
  if(transaction)await client.query('ROLLBACK').catch(()=>{});
  // The caller inspects actual committed history after any lost acknowledgement.
  return {...IDENTITY_PAUSED};
 }
}
