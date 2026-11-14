// Owned, non-activating step. Catalogue admission precedes reliance on the old creation mutex.
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {MATERIAL_CLOSURE_RELEASE} from './material-closure-release.generated.ts';
import {verifyMaterialClosureCatalogue,verifyMaterialClosurePrerequisite} from './material-closure-profile.ts';
import {verifySignatureLedger} from './signature-ledger.ts';
import {CORE_SCHEMA_LOCK,CORE_SCHEMA_UPGRADES,readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';
import {closurePaused,closureVerified,hasMaterialClosure,verifyMaterialClosure,MATERIAL_CLOSURE_VERSION,type MaterialClosureStatus} from './material-closure-status.ts';
export {verifyMaterialClosure,MATERIAL_CLOSURE_VERSION,type MaterialClosureStatus} from './material-closure-status.ts';
/** The only executable step is statically bundled release data, not caller SQL or a folder scan. */
export function materialClosureStep(_baseline?:string):Readonly<{sql:string;checksum:string}>|null {
 const release=MATERIAL_CLOSURE_RELEASE,declared=CORE_SCHEMA_UPGRADES.find(step=>step.version===MATERIAL_CLOSURE_VERSION);
 return release.version===MATERIAL_CLOSURE_VERSION&&declared?.checksum===release.checksum&&
  createHash('sha256').update(release.sql).digest('hex')===release.checksum?release:null;
}
// All existing tables touched by the new FKs/index, beyond the candidate table drained first.
// Acquire these before any head: a busy native writer makes the installer abort, never wait
// while retaining heads. SHARE ROW EXCLUSIVE also covers the knowledge index's SHARE lock.
export const MATERIAL_CLOSURE_DEPENDENCY_LOCK_SQL='LOCK TABLE app.ledger, app.runs, app.tasks, app.principals, app.workspaces, app.knowledge IN SHARE ROW EXCLUSIVE MODE NOWAIT';
class ClosurePaused extends Error{}
export async function upgradeMaterialClosure(client:pg.ClientBase,_baseline?:string):Promise<MaterialClosureStatus>{
 const step=materialClosureStep();if(!step)return closurePaused('The shipped material closure differs from its reviewed release.');
 try{
  const version=await client.query<{version:number}>("SELECT pg_catalog.current_setting('server_version_num')::integer AS version");
  if(version.rows.length!==1||!Number.isInteger(version.rows[0].version)||version.rows[0].version<180000||version.rows[0].version>=190000)
   return closurePaused('Material closure requires qualified PostgreSQL 18.');
  const role=await client.query<{installer:boolean}>('SELECT rolsuper AS installer FROM pg_catalog.pg_roles WHERE rolname=current_user');
  if(role.rows.length!==1||role.rows[0].installer!==true)return closurePaused('Only the owned Core installer may apply material closure.');
 }catch{return closurePaused('The owned installer or PostgreSQL version could not be inspected.');}
 for(let attempt=0;attempt<3;attempt++){
  let transaction=false;
  try{
   await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');transaction=true;
   const isolation=await client.query<{isolation:string}>("SELECT pg_catalog.current_setting('transaction_isolation') AS isolation");
   if(isolation.rows.length!==1||isolation.rows[0].isolation!=='read committed')throw new ClosurePaused('Material closure requires READ COMMITTED.');
   await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
   await client.query(CORE_SCHEMA_LOCK);
   const history=await readSchemaHistory(client,'installer');
   const index=CORE_SCHEMA_UPGRADES.findIndex(item=>item.version===MATERIAL_CLOSURE_VERSION);
   if(index<0||!schemaHistoryMatches(history)||history.length<index+1)throw new ClosurePaused('Material closure prerequisite history is not installed.');
   if(hasMaterialClosure(history)){
    if((await verifyMaterialClosure(client)).state!=='verified')throw new ClosurePaused('Material closure definitions differ from their reviewed profile.');
   }else{
    // Exact inherited profiles AND the factory/wrappers/table pre-image are checked first.
    if((await verifyMaterialClosurePrerequisite(client)).state!=='verified'||(await verifySignatureLedger(client)).state!=='verified')
     throw new ClosurePaused('Material closure prerequisite catalogue is not verified.');
    const installation=await client.query<{singleton:boolean}>('SELECT singleton FROM ops.installation ORDER BY singleton FOR UPDATE NOWAIT');
    if(installation.rows.length!==1||installation.rows[0].singleton!==true)throw new ClosurePaused('The workspace creation mutex is not the exact singleton.');
    // Drains old insert bodies. Never wait for a head while retaining this table lock: normal
    // callers take head then INSERT. A busy head aborts the whole transaction before retry.
    await client.query('LOCK TABLE app.knowledge_candidates IN SHARE ROW EXCLUSIVE MODE NOWAIT');
    await client.query(MATERIAL_CLOSURE_DEPENDENCY_LOCK_SQL);
    const heads=await client.query<{workspace_id:string}>('SELECT workspace_id FROM app.ledger_heads ORDER BY workspace_id FOR UPDATE NOWAIT');
    if((await verifyMaterialClosurePrerequisite(client)).state!=='verified')throw new ClosurePaused('The material closure prerequisite changed while taking its locks.');
    await client.query(step.sql);
    if((await verifyMaterialClosureCatalogue(client)).state!=='verified')throw new ClosurePaused('Installed material closure differs from its complete reviewed profile.');
    for(const {workspace_id} of heads.rows){
     await client.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal','',true),set_config('backbone.run','',true),set_config('backbone.secret','',true)",[workspace_id]);
     const boundary=await client.query<{count:string}>("SELECT count(*)::text AS count FROM app.ledger WHERE workspace_id=$1 AND entry_type='knowledge.dependencies_enabled'",[workspace_id]);
     if(boundary.rows.length!==1||boundary.rows[0].count!=='0')throw new ClosurePaused('A material closure boundary exists without its receipt.');
     await client.query("SELECT gov._append('knowledge.dependencies_enabled',NULL,jsonb_build_object('version',$1::text),NULL)",[MATERIAL_CLOSURE_VERSION]);
    }
    await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[MATERIAL_CLOSURE_VERSION,step.checksum]);
   }
   const result=await client.query('COMMIT');
   if(result.command!=='COMMIT')throw new ClosurePaused('Material closure did not receive a confirmed COMMIT. Next open will inspect the actual history.');
   transaction=false;return closureVerified();
  }catch(error){
   if(transaction)await client.query('ROLLBACK').catch(()=>{});
   const code=(error as {code?:string}).code;
   if((code==='55P03'||code==='40P01')&&attempt<2){await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));continue;}
   return closurePaused(error instanceof ClosurePaused?error.message:code==='55P03'||code==='40P01'?'Material closure locks were busy; retry on the next open.':'Material closure installation could not be confirmed. Next open will inspect actual objects and history.');
  }
 }
 return closurePaused('Material closure locks were busy; retry on the next open.');
}
