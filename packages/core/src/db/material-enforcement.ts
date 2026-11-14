// Native insertion enforcement, separate from historical receipts and current use authority.
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {hasMaterialClosure,verifyMaterialClosure} from './material-closure-status.ts';
import {verifyMaterialLink} from './material-link.ts';
import {inspectMaterialEnforcement,materialEnforcementCatalogueState} from './material-enforcement-catalogue.ts';
import {baselineObject,CORE_SCHEMA_LOCK,CORE_SCHEMA_UPGRADES,readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';
export interface MaterialEnforcementStatus {state:'verified'|'paused';reason:string}
export const MATERIAL_ENFORCEMENT_VERSION='material-source-enforcement-v1';
const paused=(reason:string):MaterialEnforcementStatus=>({state:'paused',reason});
const verified=():MaterialEnforcementStatus=>({state:'verified',reason:'Typed material episodes require their own live journal binding when validated; receipts grant no current access.'});
const hash=(source:string)=>createHash('sha256').update(source).digest('hex');
const FILES=['gov/_material_source_state.sql','sec/t_material_episode_source.sql'];
// Source-only SHA-256 pins. No PostgreSQL catalogue was executed to learn or accept these.
const STATEMENT_PINS:Record<string,string>={
  "gov/_material_source_state.sql": "cb1027d0d6e3ef4dd217541139979943c5d49756eaef6e21ce184d088658e3c7",
  "sec/t_material_episode_source.sql": "a4ec25f51c87c82202f285de42917c2d194240e7297f0829429e06ef511c30d8",
  "material_source_receipt": "8728f880eb38bcd431de196481ea4f985adb2f40853e94e66f02ab215c835be1"
};

/** Select the two canonical objects and exact trigger fragment, never another executable copy.
 * Released guard/link step selection and checksums remain unchanged. */
export function materialEnforcementStep(baseline:string):{sql:string;checksum:string}|null{
 const blocks:Record<string,string>={};
 for(const file of FILES){const block=baselineObject(baseline,file);if(!block)return null;blocks[file]=block;}
 const episodes=baselineObject(baseline,'app/episodes.sql');
 const triggers=episodes?.match(/CREATE CONSTRAINT TRIGGER material_source_receipt\n[\s\S]*?ENABLE ALWAYS TRIGGER material_source_receipt;/g);
 if(triggers?.length!==1)return null;
 blocks.material_source_receipt=triggers[0];
 if(Object.keys(blocks).length!==Object.keys(STATEMENT_PINS).length||Object.entries(blocks).some(([name,sql])=>hash(sql)!==STATEMENT_PINS[name]))return null;
 const sql=['SET LOCAL check_function_bodies=false;','SET LOCAL ROLE backbone_gov;',...FILES.map(file=>blocks[file]),
  'RESET ROLE;','SET LOCAL ROLE backbone_owner;',blocks.material_source_receipt,'RESET ROLE;'].join('\n')+'\n';
 const checksum=hash(sql),step=CORE_SCHEMA_UPGRADES.find(step=>step.version===MATERIAL_ENFORCEMENT_VERSION);
 return step?.checksum===checksum?{sql,checksum}:null;
}

/** This profile is qualified on PostgreSQL 18 only, independently of catalogue formatting. */
async function qualifiedPostgres18(client:pg.ClientBase):Promise<boolean>{
 const result=await client.query<{version:number}>("SELECT pg_catalog.current_setting('server_version_num')::integer AS version");
 const version=result.rows[0]?.version;
 return result.rows.length===1&&Number.isInteger(version)&&version>=180000&&version<190000;
}

/** External databases receive inspection only. A complete recognized history and exact native
 * profile are both required, including the old guard/link pins and closed-table constraints. */
export async function verifyMaterialEnforcement(client:pg.ClientBase):Promise<MaterialEnforcementStatus>{
 try{
  if(!await qualifiedPostgres18(client))return paused('Material insertion enforcement requires qualified PostgreSQL 18.');
  const history=await readSchemaHistory(client,'service');
  if(hasMaterialClosure(history))return verifyMaterialClosure(client);
  const index=CORE_SCHEMA_UPGRADES.findIndex(step=>step.version===MATERIAL_ENFORCEMENT_VERSION);
  if(index<0||!schemaHistoryMatches(history)||history.length<index+2)return paused('The material enforcement installation history is not complete.');
  if((await verifyMaterialLink(client)).state!=='verified')return paused('The prerequisite material journal is not verified.');
  return materialEnforcementCatalogueState(await inspectMaterialEnforcement(client))==='enforced'?verified():paused('Material insertion enforcement differs from its reviewed catalogue profile.');
 }catch{return paused('Material insertion enforcement could not be inspected.');}
}

async function namespaces(client:pg.ClientBase):Promise<string>{
 const result=await client.query(`SELECT nspname::text,pg_catalog.pg_get_userbyid(nspowner) AS owner,nspacl::text AS acl
  FROM pg_catalog.pg_namespace WHERE nspname IN ('app','sec','gov','ops') ORDER BY nspname COLLATE "C"`);
 return JSON.stringify(result.rows);
}
/** Owned installer only. Unknown/partial objects are refused, not repaired. All DDL, exact
 * verification and history commit together; no application row, old SQL or schema ACL changes. */
export async function upgradeMaterialEnforcement(client:pg.ClientBase,baseline:string):Promise<MaterialEnforcementStatus>{
 const step=materialEnforcementStep(baseline);if(!step)return paused('The shipped material enforcement differs from its reviewed source pins.');
 try{if(!await qualifiedPostgres18(client))return paused('Material insertion enforcement requires qualified PostgreSQL 18.');}
 catch{return paused('The PostgreSQL version could not be inspected. Material insertion enforcement is paused.');}
 for(let attempt=0;attempt<3;attempt++){
  let transaction=false;
  try{
   const role=await client.query<{installer:boolean}>('SELECT rolsuper AS installer FROM pg_catalog.pg_roles WHERE rolname=current_user');
   if(role.rows[0]?.installer!==true)return paused('Only the owned Core installer may apply material enforcement.');
   await client.query('BEGIN');transaction=true;
   await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
   await client.query(CORE_SCHEMA_LOCK);
   const history=await readSchemaHistory(client,'installer');
   if(hasMaterialClosure(history)){
    const status=await verifyMaterialClosure(client);
    if(status.state!=='verified')throw new EnforcementPaused(status.reason);
    if((await client.query('COMMIT')).command!=='COMMIT')throw new EnforcementPaused('Material closure inspection did not receive a confirmed COMMIT.');
    transaction=false;return status;
   }
   const index=CORE_SCHEMA_UPGRADES.findIndex(item=>item.version===MATERIAL_ENFORCEMENT_VERSION);
   if(index<0||!schemaHistoryMatches(history)||history.length<index+1)throw new EnforcementPaused('The prerequisite material journal history is not installed.');
   if((await verifyMaterialLink(client)).state!=='verified')throw new EnforcementPaused('The prerequisite material journal is not verified.');
   const state=materialEnforcementCatalogueState(await inspectMaterialEnforcement(client));
   if(state==='unknown'||(state==='absent'&&history.length!==index+1))throw new EnforcementPaused('Material enforcement definitions and installation history disagree.');
   const before=await namespaces(client);
   if(state==='absent'){
    // An old raw recorder already holding its table lock must finish before this DDL commits.
    await client.query('LOCK TABLE app.episodes, app.material_source_identities, app.material_source_reads, app.material_source_withdrawals IN SHARE ROW EXCLUSIVE MODE NOWAIT');
    await client.query(step.sql);
    if(materialEnforcementCatalogueState(await inspectMaterialEnforcement(client))!=='enforced')throw new EnforcementPaused('Installed material enforcement differs from its reviewed profile.');
    if((await verifyMaterialLink(client)).state!=='verified')throw new EnforcementPaused('The additive enforcement changed its journal prerequisite.');
   }
   if(await namespaces(client)!==before)throw new EnforcementPaused('Material enforcement changed an existing namespace owner or ACL.');
   if(history.length===index+1)await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[MATERIAL_ENFORCEMENT_VERSION,step.checksum]);
   const committed=await client.query('COMMIT');
   if(committed.command!=='COMMIT')throw new EnforcementPaused('Material enforcement did not receive a confirmed COMMIT. Next open will inspect its existing objects and receipt.');
   transaction=false;return verified();
  }catch(error){
   if(transaction)await client.query('ROLLBACK').catch(()=>{});
   const code=(error as {code?:string}).code;
   if((code==='55P03'||code==='40P01')&&attempt<2){await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));continue;}
   return paused(error instanceof EnforcementPaused?error.message:code==='55P03'||code==='40P01'?'Material enforcement schema lock was busy; retry on the next open.':'Material enforcement installation could not be confirmed. Next open will inspect existing objects and history.');
  }
 }
 return paused('Material enforcement schema lock was busy; retry on the next open.');
}
class EnforcementPaused extends Error{}
