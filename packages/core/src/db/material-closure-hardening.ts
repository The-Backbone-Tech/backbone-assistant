// Append-only correction to a qualified foundation. No boundary/proof rewrite or capability activation.
import type pg from 'pg';
import {closureHash,verifyMaterialClosureCatalogue} from './material-closure-profile.ts';
import {verifyMaterialClosureHardeningCatalogue,MATERIAL_CLOSURE_HARDENING_VERSION} from './material-closure-hardening-profile.ts';
import {MATERIAL_CLOSURE_RELEASE as RELEASE} from './material-closure-hardening-release.generated.ts';
import {CORE_SCHEMA_LOCK,CORE_SCHEMA_UPGRADES,readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';
import {closurePaused,closureVerified,type MaterialClosureStatus} from './material-closure-status.ts';
import {MATERIAL_CLOSURE_DEPENDENCY_LOCK_SQL} from './material-closure.ts';
import {verifySignatureLedger} from './signature-ledger.ts';
export {MATERIAL_CLOSURE_HARDENING_VERSION} from './material-closure-hardening-profile.ts';
export function materialClosureHardeningStep(){
 return RELEASE.version===MATERIAL_CLOSURE_HARDENING_VERSION&&CORE_SCHEMA_UPGRADES.find(s=>s.version===MATERIAL_CLOSURE_HARDENING_VERSION)?.checksum===RELEASE.checksum
  &&closureHash(RELEASE.sql)===RELEASE.checksum?RELEASE:null;
}
class HardeningPaused extends Error{}
export async function upgradeMaterialClosureHardening(client:pg.ClientBase):Promise<MaterialClosureStatus>{
 const step=materialClosureHardeningStep();if(!step)return closurePaused('The shipped hardening release is inconsistent.');
 try{
  const v=(await client.query<{version:number}>("SELECT current_setting('server_version_num')::integer AS version")).rows;
  const role=(await client.query<{installer:boolean}>('SELECT rolsuper AS installer FROM pg_catalog.pg_roles WHERE rolname=current_user')).rows;
  if(v.length!==1||!Number.isInteger(v[0].version)||v[0].version<180000||v[0].version>=190000||role.length!==1||role[0].installer!==true)
   return closurePaused('Material closure hardening requires the owned PostgreSQL 18 installer.');
 }catch{return closurePaused('The owned hardening installer could not be inspected.');}
 for(let attempt=0;attempt<3;attempt++){
  let transaction=false;
  try{
   await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');transaction=true;
   const isolation=(await client.query<{isolation:string}>("SELECT current_setting('transaction_isolation') AS isolation")).rows;
   if(isolation.length!==1||isolation[0].isolation!=='read committed')throw new HardeningPaused('Material closure hardening requires READ COMMITTED.');
   await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");await client.query(CORE_SCHEMA_LOCK);
   const history=await readSchemaHistory(client,'installer'),index=CORE_SCHEMA_UPGRADES.findIndex(s=>s.version===MATERIAL_CLOSURE_HARDENING_VERSION);
   if(index<0||!schemaHistoryMatches(history)||history.length<index+1||history.length>index+2)
    throw new HardeningPaused('Material closure hardening requires exact recognized foundation history.');
   if(history.length===index+2){
    if((await verifyMaterialClosureHardeningCatalogue(client)).state!=='verified')throw new HardeningPaused('The hardened profile is inconsistent.');
   }else{
    if((await verifyMaterialClosureCatalogue(client)).state!=='verified'||(await verifySignatureLedger(client)).state!=='verified')
     throw new HardeningPaused('The complete foundation prerequisite is not verified.');
    const mutex=(await client.query<{singleton:boolean}>('SELECT singleton FROM ops.installation ORDER BY singleton FOR UPDATE NOWAIT')).rows;
    if(mutex.length!==1||mutex[0].singleton!==true)throw new HardeningPaused('The installation mutex is not the exact singleton.');
    await client.query('LOCK TABLE app.knowledge_candidates IN SHARE ROW EXCLUSIVE MODE NOWAIT');
    await client.query(MATERIAL_CLOSURE_DEPENDENCY_LOCK_SQL);
    await client.query('SELECT workspace_id FROM app.ledger_heads ORDER BY workspace_id FOR UPDATE NOWAIT');
    if((await verifyMaterialClosureCatalogue(client)).state!=='verified')throw new HardeningPaused('Foundation changed while acquiring locks.');
    await client.query(step.sql);
    if((await verifyMaterialClosureHardeningCatalogue(client)).state!=='verified')throw new HardeningPaused('Installed hardening profile differs.');
    await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[MATERIAL_CLOSURE_HARDENING_VERSION,step.checksum]);
   }
   const result=await client.query('COMMIT');if(result.command!=='COMMIT')throw new HardeningPaused('Hardening COMMIT was not confirmed.');
   transaction=false;return closureVerified();
  }catch(error){
   if(transaction)await client.query('ROLLBACK').catch(()=>{});
   const code=(error as {code?:string}).code;
   if((code==='55P03'||code==='40P01')&&attempt<2){await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));continue;}
   return closurePaused(error instanceof HardeningPaused?error.message:code==='55P03'||code==='40P01'
    ?'Material closure hardening locks were busy; retry on next owned open.':'Material closure hardening could not be confirmed; inspect actual history on next owned open.');
  }
 }
 return closurePaused('Material closure hardening locks were busy.');
}
