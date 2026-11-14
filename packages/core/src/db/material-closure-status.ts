// New history has one complete material profile. This verifier never invokes an installer or A1c.
import type pg from 'pg';
import {CORE_SCHEMA_UPGRADES,readSchemaHistory,schemaHistoryMatches,type SchemaHistoryRow} from './schema-migrations.ts';
import {verifyMaterialClosureCatalogue} from './material-closure-profile.ts';
import {verifyMaterialClosureHardeningCatalogue,MATERIAL_CLOSURE_HARDENING_VERSION} from './material-closure-hardening-profile.ts';
export const MATERIAL_CLOSURE_VERSION='material-closure-foundation-v1';
export interface MaterialClosureStatus {state:'verified'|'paused';reason:string}
export const closurePaused=(reason:string):MaterialClosureStatus=>({state:'paused',reason});
export const closureVerified=():MaterialClosureStatus=>({state:'verified',reason:'Complete native material dependency profile verified; material-backed knowledge and use remain withheld.'});
export function hasMaterialClosure(history:readonly SchemaHistoryRow[]):boolean {
 const index=CORE_SCHEMA_UPGRADES.findIndex(step=>step.version===MATERIAL_CLOSURE_VERSION);
 return index>=0&&schemaHistoryMatches(history)&&history.length>=index+2;
}
export async function verifyMaterialClosure(client:pg.ClientBase):Promise<MaterialClosureStatus>{
 try {
  const version=await client.query<{version:number}>("SELECT pg_catalog.current_setting('server_version_num')::integer AS version");
  if(version.rows.length!==1||!Number.isInteger(version.rows[0].version)||version.rows[0].version<180000||version.rows[0].version>=190000)
   return closurePaused('Material closure requires qualified PostgreSQL 18.');
  const history=await readSchemaHistory(client,'service');
  if(!hasMaterialClosure(history))return closurePaused('The material closure installation history is not complete.');
  const hardened=history.some(row=>row.version===MATERIAL_CLOSURE_HARDENING_VERSION);
  return (await (hardened?verifyMaterialClosureHardeningCatalogue:verifyMaterialClosureCatalogue)(client)).state==='verified'?closureVerified():closurePaused('Material closure differs from its complete reviewed catalogue profile.');
 }catch{return closurePaused('Material closure could not be inspected.');}
}
