// Exact history chooses a profile before obsolete installers or verifiers can inspect changed SQL.
import type pg from 'pg';
import {readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';
import {hasMaterialClosure,verifyMaterialClosure} from './material-closure-status.ts';
import {verifyMaterialGuard,type MaterialGuardStatus} from './material-guard.ts';
import {verifyMaterialLink,type MaterialLinkStatus} from './material-link.ts';
import {verifyMaterialEnforcement,type MaterialEnforcementStatus} from './material-enforcement.ts';
export interface MaterialStatuses {materialGuard:MaterialGuardStatus;materialLink:MaterialLinkStatus;materialEnforcement:MaterialEnforcementStatus}
export async function verifyMaterialStatuses(client:pg.ClientBase):Promise<MaterialStatuses>{
 const history=await readSchemaHistory(client,'service');
 if(!schemaHistoryMatches(history)){
  const status={state:'paused' as const,reason:'The material installation history is not recognized.'};
  return {materialGuard:{...status},materialLink:{...status},materialEnforcement:{...status}};
 }
 if(hasMaterialClosure(history)){
  const status=await verifyMaterialClosure(client);
  return {materialGuard:{...status},materialLink:{...status},materialEnforcement:{...status}};
 }
 return {materialGuard:await verifyMaterialGuard(client),materialLink:await verifyMaterialLink(client),materialEnforcement:await verifyMaterialEnforcement(client)};
}
/** Shared by both A1c prerequisite sites. Old history keeps its released prerequisite. */
export async function materialPrerequisiteVerified(client:pg.ClientBase):Promise<boolean>{
 const history=await readSchemaHistory(client,'service');
 if(hasMaterialClosure(history))return (await verifyMaterialClosure(client)).state==='verified';
 return (await verifyMaterialEnforcement(client)).state==='verified';
}
