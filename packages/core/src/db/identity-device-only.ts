// Admit current device facts independently of unrelated Team catalogue damage.
import type pg from 'pg';
import {recoveryHash} from './identity-device-recovery.ts';
import {IDENTITY_DEVICE_ONLY_PIN} from './identity-device-only-pins.ts';
export async function captureDeviceOnly(client:pg.ClientBase){
 return (await client.query(`SELECT * FROM (
 SELECT 'function' AS kind,p.oid::regprocedure::text AS name,jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text) AS definition
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='operator' AND p.proname='identity_device_only'
 UNION ALL SELECT 'table',c.relname,jsonb_build_object('rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner))
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname IN ('principals','identity_sessions','mandates','ledger')
 UNION ALL SELECT 'policy',tablename||'.'||policyname,to_jsonb(p)-'schemaname'-'tablename'-'policyname' FROM pg_policies p
 WHERE schemaname='app' AND tablename IN ('principals','identity_sessions','mandates','ledger')
 ) checks ORDER BY kind COLLATE "C",name COLLATE "C"`)).rows;
}
export async function deviceOnlyAvailable(client:pg.ClientBase):Promise<boolean>{
 try{return recoveryHash(await captureDeviceOnly(client))===IDENTITY_DEVICE_ONLY_PIN;}catch{return false;}
}
export async function deviceOnly(client:pg.ClientBase,workspace:string,person:string):Promise<boolean>{
 try{
  if(!await deviceOnlyAvailable(client))return false;
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.run','',true)",[workspace]);
  return (await client.query('SELECT operator.identity_device_only($1) AS solo',[person])).rows[0]?.solo===true;
 }catch{return false;}finally{await client.query('ROLLBACK').catch(()=>{});}
}
