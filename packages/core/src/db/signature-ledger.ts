// Additive signature installation. Personal-home wiring belongs to personal.ts and is deliberately separate.
import {createHash} from 'node:crypto';
import type pg from 'pg';
import pins from './signature-ledger-pins.ts';
import {identitySignatureOverrides} from './identity-catalogue.ts';
import {inspectSignatureLedger} from './signature-ledger-catalogue.ts';
import {SIGNATURE_FILES,SIGNATURE_FUNCTIONS,SIGNATURE_LEDGER_VERSION,assembleSignatureStep} from './signature-ledger-source.ts';
import {baselineObject,CORE_SCHEMA_LOCK,CORE_SCHEMA_UPGRADES,readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';
import {materialPrerequisiteVerified} from './material-status.ts';
export {SIGNATURE_LEDGER_VERSION};
export interface SignatureLedgerStatus {state:'verified'|'paused';reason:string}
const paused=(reason:string):SignatureLedgerStatus=>({state:'paused',reason});
const verified=():SignatureLedgerStatus=>({state:'verified',reason:'Signature life and decision basis match the additive Core profile.'});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function signatureLedgerStep(baseline:string):{sql:string;checksum:string}|null {
  const statements=pins.statements as Record<string,string>;
  const blocks=SIGNATURE_FILES.map(file=>baselineObject(baseline,file));
  if(blocks.some((block,i)=>!block||hash(block)!==statements[SIGNATURE_FILES[i]]))return null;
  const sql=assembleSignatureStep(blocks as string[]),checksum=hash(sql);
  return checksum===pins.checksum&&CORE_SCHEMA_UPGRADES.find(step=>step.version===SIGNATURE_LEDGER_VERSION)?.checksum===checksum?{sql,checksum}:null;
}
async function profile(client:pg.ClientBase):Promise<'absent'|'installed'|'unknown'> {
  const actual=await inspectSignatureLedger(client),expected=pins.catalogue;
  if(actual.roles!==expected.roles)return 'unknown';
  let overrides:Record<string,string>;
  try{overrides=await identitySignatureOverrides(client);}catch{return 'unknown';}
  const functions={...expected.functions,...overrides} as Record<string,string|null>;
  if(Object.keys(functions).some(name=>!SIGNATURE_FUNCTIONS.includes(name)&&actual.functions[name]!==functions[name]))return 'unknown';
  if(actual.relations===0&&SIGNATURE_FUNCTIONS.every(name=>actual.functions[name]===null))return 'absent';
  return actual.objects===expected.objects&&Object.keys(functions).every(name=>actual.functions[name]===functions[name])?'installed':'unknown';
}
// Both verification and installation choose the material prerequisite by exact history; the
// independent signature catalogue and released source/checksum remain unchanged.
async function prerequisiteVerified(client:pg.ClientBase):Promise<boolean> {
  return materialPrerequisiteVerified(client);
}
export async function verifySignatureLedger(client:pg.ClientBase):Promise<SignatureLedgerStatus> {
  try {
    const history=await readSchemaHistory(client,'service');
    const index=CORE_SCHEMA_UPGRADES.findIndex(step=>step.version===SIGNATURE_LEDGER_VERSION);
    if(index<0||!schemaHistoryMatches(history)||history.length<index+2)return paused('Signature installation history is incomplete.');
    // Diagnose this capability's own profile independently before the complete material
    // prerequisite (which conservatively includes these definitions too). Both must pass.
    if(await profile(client)!=='installed')return paused('Signature definitions differ from the exact catalogue profile.');
    if(!await prerequisiteVerified(client))return paused('Signature prerequisite enforcement is not verified.');
    return verified();
  }catch{return paused('Signature ledger could not be inspected.');}
}
export async function upgradeSignatureLedger(client:pg.ClientBase,baseline:string):Promise<SignatureLedgerStatus> {
  const step=signatureLedgerStep(baseline);if(!step)return paused('Signature source differs from its reviewed pins.');
  try {
    if(!(await client.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper)return paused('Only the owned installer applies the signature step.');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
    await client.query(CORE_SCHEMA_LOCK);
    const history=await readSchemaHistory(client,'installer');
    const index=CORE_SCHEMA_UPGRADES.findIndex(step=>step.version===SIGNATURE_LEDGER_VERSION);
    if(index<0||!schemaHistoryMatches(history)||history.length<index+1)throw new Error('Signature prerequisite history is incomplete.');
    if(!await prerequisiteVerified(client))throw new Error('Signature prerequisite enforcement is not verified.');
    if(history.length===index+1){
      // A workspace created during the scan could otherwise have a pre-step answer without
      // its boundary marker. Finish all earlier creations and block new ones until COMMIT.
      await client.query('LOCK TABLE app.workspaces IN SHARE MODE');
      if((await client.query("SELECT EXISTS(SELECT FROM app.ledger WHERE entry_type='decision.basis_enabled') AS present")).rows[0].present)
        throw new Error('A signature boundary exists without its migration receipt.');
    }
    const state=await profile(client);
    if(state==='unknown'||state==='absent'&&history.length!==index+1)throw new Error('Signature catalogue and history disagree.');
    if(state==='absent')await client.query(step.sql);
    if(await profile(client)!=='installed')throw new Error('Installed signature catalogue differs.');
    if(history.length===index+1){
      // Lock every existing head before its marker. Answers racing this installation serialize
      // before or after the marker; no wall clock or rewritten historical payload is needed.
      const workspaces=(await client.query('SELECT id FROM app.workspaces ORDER BY id')).rows;
      for(const {id} of workspaces){
        await client.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal','',true),set_config('backbone.run','',true)",[id]);
        await client.query("SELECT gov._lock_workspace(); SELECT gov._append('decision.basis_enabled',NULL,'{}'::jsonb,NULL)");
      }
      await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[SIGNATURE_LEDGER_VERSION,step.checksum]);
    }
    const result=await client.query('COMMIT');
    if(result.command!=='COMMIT')throw new Error('Signature COMMIT was not confirmed.');
    return verified();
  }catch(error){await client.query('ROLLBACK').catch(()=>{});return paused((error as Error).message);}
}
