// Recovery attests its own crossing even when unrelated identity admission is paused.
import type pg from 'pg';
import {createHash} from 'node:crypto';
import {IDENTITY_DEVICE_RECOVERY_PIN} from './identity-device-recovery-pins.ts';
export async function captureDeviceRecovery(client:pg.ClientBase){
 return (await client.query(`SELECT pg_get_functiondef(p.oid) AS definition,pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl,
  has_function_privilege('backbone_app',p.oid,'EXECUTE') AS app,
  has_function_privilege('backbone_operator',p.oid,'EXECUTE') AS operator
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='operator' AND p.proname='identity_restore_device_access' AND pg_get_function_identity_arguments(p.oid)='p_person uuid'`)).rows;
}
export const recoveryHash=(rows:unknown)=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
export async function deviceRecoveryAvailable(client:pg.ClientBase):Promise<boolean>{
 try{return recoveryHash(await captureDeviceRecovery(client))===IDENTITY_DEVICE_RECOVERY_PIN;}catch{return false;}
}
/** Operator credential is owned by the local process, never a service/session caller. */
export async function restoreDeviceAccess(client:pg.ClientBase,workspace:string,person:string,signal?:AbortSignal):Promise<void>{
 signal?.throwIfAborted();
 let transaction=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');transaction=true;
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  if(!await deviceRecoveryAvailable(client))throw new Error('The device recovery crossing could not be verified.');
  await client.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal','',true),set_config('backbone.run','',true),set_config('backbone.secret','',true)",[workspace]);
  signal?.throwIfAborted();
  await client.query('SELECT operator.identity_restore_device_access($1)',[person]);
  // Withdrawal while SQL waits still rolls back the membership and audit together.
  signal?.throwIfAborted();
  if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Device recovery was not confirmed.');
  transaction=false;
 }finally{if(transaction)await client.query('ROLLBACK').catch(()=>{});}
}
