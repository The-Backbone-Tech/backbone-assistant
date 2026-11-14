// Additive preparation and withdrawal receipts. These never authorize delivery or knowledge use.
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {hasMaterialClosure,verifyMaterialClosure} from './material-closure-status.ts';
import {verifyMaterialGuard} from './material-guard.ts';
import {baselineObject,CORE_SCHEMA_LOCK,CORE_SCHEMA_UPGRADES,readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';

export interface MaterialLinkStatus {state:'verified'|'paused';reason:string}
const paused=(reason:string):MaterialLinkStatus=>({state:'paused',reason});
const verified=():MaterialLinkStatus=>({state:'verified',reason:'Material preparation and withdrawal records verified; receipts confer no current access.'});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export const MATERIAL_LINK_VERSION='material-source-link-v1';
const TABLES=['material_source_identities','material_source_withdrawals','material_source_reads'];
const NEW_FUNCTIONS=[
 'gov.withdraw_material_source(text,text,text,integer,integer,text)',
 'gov.record_material_source_read(text,text,integer,integer,text,text,jsonb,text,text,text,uuid,uuid,uuid,uuid,text)',
];
const DEPENDENCIES=['gov._system(text)','gov._lock_workspace()','gov._run_person(uuid)',
 'sec.task_visible_to(uuid,uuid)','sec.t_evidence()','sec.t_refuse_truncate()',
 'gov._mark(uuid,text,text,text)','gov._person_name(uuid)','sec.digest(text)',
 'sec.current_workspace()','sec.current_principal()','sec.current_run()','sec.names_run()',
 'sec.system_principal()','sec.ledger_hash(text,uuid,bigint,text,uuid,text,jsonb,timestamp with time zone)'];
const FILES=[...TABLES.map(table=>`app/${table}.sql`),'gov/withdraw_material_source.sql','gov/record_material_source_read.sql'];
// Frozen from independently reviewed source and a disposable PostgreSQL 18 catalogue, after
// asserting intended owners, bodies, privileges, RLS and role posture. Runtime never learns pins.
const STATEMENT_PINS:Record<string,string>={
  "app/material_source_identities.sql": "707803f645d7242462e9229cbf95c89a9476eb53ef4fe83ef55f6fe6500f0b93",
  "app/material_source_withdrawals.sql": "2469443435ab4a05addbee82a784108a87c984e411b3b62ef8731f4aafa1ec93",
  "app/material_source_reads.sql": "404c4354ddce7088f3fff10c781f2103ab950ba9c58aea0f90abfb6d0f84462d",
  "gov/withdraw_material_source.sql": "9c4938f2f637419ee3dc003b9e1cf297ec657c5837f6b0dc72b9b8f28fe76bdc",
  "gov/record_material_source_read.sql": "d7972ef50c2fed0a448294d866ae4328a687520ed906cf2b2c2261637a43fb09"
};
const FUNCTION_PINS:Record<string,string>={
  "gov._lock_workspace()": "8d6f4837bfc5139a7098072c671c364411f9b2a04a8dd32d70838de2680c9915",
  "gov._mark(uuid,text,text,text)": "b2aa0fc5f3f2e8aff42874e6406b333bf7b6d59c1521dad9d5a7ee4086061da8",
  "gov._person_name(uuid)": "0a6c045ec567b01f44500544a9b1adcad3103f7c3bb1a0ea7b4799fb472bb794",
  "gov._run_person(uuid)": "8264cc2656a64135907fe2bdc97ef2d0391e58fd034a5afc6656a399c62e0d7c",
  "gov._system(text)": "506717ded9ec36d400f421e43e9bb9fd965dfa5f856a6ad9b2f0270f3d2ddf7a",
  "gov.record_material_source_read(text,text,integer,integer,text,text,jsonb,text,text,text,uuid,uuid,uuid,uuid,text)": "fc7d68b81fe56df5e453f08a19025c457714381e0955b6427dda5eabbc82f70f",
  "gov.withdraw_material_source(text,text,text,integer,integer,text)": "f15350fab565b61a3d1ed2f634e73f1e87775371f5a5489375c4100201647eff",
  "sec.current_principal()": "f45a2dc923a72033984f7a58b5fb5f86e31dcde077e6c2e1c8968fef5d9aecd0",
  "sec.current_run()": "c0af0f0990e25fbad69e789495524ffc0442010d47b9389e22c8ae44c609b4c0",
  "sec.current_workspace()": "f45d4a6c70fdd5007f8b2ee0764ffdda935b9c1b9b072c72b2aae1392b087da3",
  "sec.digest(text)": "8a22e9c88f36efbbe90d7919b05eeec2b06cbd41636fe9e2f61662d7a243e29b",
  "sec.ledger_hash(text,uuid,bigint,text,uuid,text,jsonb,timestamp with time zone)": "dc46a13fec1e28dd4a5766c166d929981441cb36a7c40cb5301d7f422382caab",
  "sec.names_run()": "7d48058670c251fa7a25cbe8cdad58cc653d00f07f728758424c91de42fd8580",
  "sec.system_principal()": "e0bbe97191ecd993b4f41f88ace3610922ab002e92f0f9fa34d8687f5af53e41",
  "sec.t_evidence()": "d4d7b1ddf6b1cce924cf9129d0869234aa55e9d52c3648c0ba58c5183af9f2f0",
  "sec.t_refuse_truncate()": "d2f47eb245401e46569ff535020053c287123860505c09295f863c879fb07048",
  "sec.task_visible_to(uuid,uuid)": "1ab60c3845c73b0b16d1910681a665a03a111894a939bf659b0f5f8f0062ee48"
};
const OBJECT_PIN='1b36491fed742fb87faf1d33afb6932b4f20276f82e0ddee5fea39152792ca29';
const ROLE_PIN='a6729e040029f302de55cc0a6683493fa3c7cb51fe270a730c54ee23788805ff';

/** Single executable source: exact per-object baseline blocks, never schema-folder reads. */
export function materialLinkStep(baseline:string):{sql:string;checksum:string}|null {
 const blocks=FILES.map(file=>baselineObject(baseline,file));
 if(Object.keys(STATEMENT_PINS).length!==FILES.length || blocks.some((sql,index)=>!sql||hash(sql)!==STATEMENT_PINS[FILES[index]]))return null;
 const sql=['SET LOCAL check_function_bodies=false;','SET LOCAL ROLE backbone_owner;',
  ...blocks.slice(0,TABLES.length),'RESET ROLE;','SET LOCAL ROLE backbone_gov;',
  ...blocks.slice(TABLES.length),'RESET ROLE;'].join('\n')+'\n';
 const checksum=hash(sql);const step=CORE_SCHEMA_UPGRADES.find(step=>step.version===MATERIAL_LINK_VERSION);
 return step?.checksum===checksum?{sql,checksum}:null;
}

/** Catalogue only. Includes constraints and defaults, since a missing uniqueness or generated
 * receipt would break replay semantics despite an otherwise identical function definition. */
export async function inspectMaterialLink(client:pg.ClientBase){
 const functions=(await client.query<{signature:string;definition:{definition:unknown}}>(`
  SELECT wanted.signature,pg_catalog.jsonb_build_object(
   'definition',pg_catalog.pg_get_functiondef(p.oid),'owner',pg_catalog.pg_get_userbyid(p.proowner),
   'acl',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
      pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
     FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a),
   'appExecutes',pg_catalog.has_function_privilege('backbone_app',p.oid,'EXECUTE')) AS definition
  FROM pg_catalog.unnest($1::text[]) wanted(signature) LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(wanted.signature)
  ORDER BY wanted.signature COLLATE "C"`,[[...NEW_FUNCTIONS,...DEPENDENCIES]])).rows;
 const objects=(await client.query<{kind:string;name:string;definition:unknown}>(`
  SELECT * FROM (SELECT 'relation' AS kind,c.relname::text AS name,pg_catalog.jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'owner',pg_catalog.pg_get_userbyid(c.relowner),
   'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
   'acl',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
     pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
    FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a)) AS definition
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname=ANY($1::text[])
  UNION ALL SELECT 'column',c.relname||'.'||a.attname,pg_catalog.jsonb_build_object('type',pg_catalog.format_type(a.atttypid,a.atttypmod),
   'required',a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid))
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='app' AND c.relname=ANY($1::text[])
  UNION ALL SELECT 'constraint',c.relname||'.'||k.conname,pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_constraintdef(k.oid,true),
   'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred)
  FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='app' AND c.relname=ANY($1::text[])
  UNION ALL SELECT 'policy',tablename||'.'||policyname,pg_catalog.to_jsonb(p)-'schemaname'-'tablename'-'policyname'
  FROM pg_catalog.pg_policies p WHERE schemaname='app' AND tablename=ANY($1::text[])
  UNION ALL SELECT 'rule',c.relname||'.'||r.rulename,pg_catalog.jsonb_build_object(
   'definition',pg_catalog.pg_get_ruledef(r.oid,true),'enabled',r.ev_enabled)
  FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='app' AND c.relname=ANY($1::text[])
  UNION ALL SELECT 'trigger',c.relname||'.'||t.tgname,pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled)
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname='app' AND c.relname=ANY($1::text[])
  UNION ALL SELECT 'index',c.relname,pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_indexdef(c.oid),'valid',i.indisvalid,'ready',i.indisready)
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname='app' AND t.relname=ANY($1::text[]) ) catalogue ORDER BY kind COLLATE "C",name COLLATE "C"`,[TABLES])).rows;
 const roles=(await client.query(`
  SELECT * FROM (SELECT 'role' AS kind,rolname::text AS name,pg_catalog.jsonb_build_object('superuser',rolsuper,'bypassRls',rolbypassrls,
   'createRole',rolcreaterole,'createDb',rolcreatedb,'login',rolcanlogin,'inherit',rolinherit) AS definition
  FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])
  UNION ALL SELECT 'membership',parent.rolname||'/'||member.rolname,pg_catalog.jsonb_build_object(
   'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
  FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
   JOIN pg_catalog.pg_roles member ON member.oid=m.member
  WHERE parent.rolname=ANY($1::text[]) OR member.rolname=ANY($1::text[])
  ) catalogue ORDER BY kind COLLATE "C",name COLLATE "C"`,[['backbone_owner','backbone_gov','backbone_app','backbone_operator']])).rows;
 // A UNION headed by PostgreSQL's `name` type silently truncates concatenated labels to 63
 // bytes. Cast the first label to text above and reject duplicate keys rather than hash tied
 // rows in catalogue-dependent order. Constraints on these tables already exceed that length.
 if(new Set(objects.map(row=>`${row.kind}:${row.name}`)).size!==objects.length ||
  new Set(roles.map(row=>`${row.kind}:${row.name}`)).size!==roles.length)throw new Error('Ambiguous Core catalogue labels.');
 return {functions:Object.fromEntries(functions.map(row=>[row.signature,row.definition.definition===null?null:hash(JSON.stringify(row.definition))])),roles:hash(JSON.stringify(roles)),
  objects:hash(JSON.stringify(objects)),relations:objects.filter(row=>row.kind==='relation').length};
}

async function definitions(client:pg.ClientBase):Promise<'absent'|'linked'|'unknown'>{
 const installed=await inspectMaterialLink(client);
 if(installed.roles!==ROLE_PIN || Object.keys(FUNCTION_PINS).length!==NEW_FUNCTIONS.length+DEPENDENCIES.length ||
  DEPENDENCIES.some(name=>installed.functions[name]!==FUNCTION_PINS[name]))return 'unknown';
 if(installed.relations===0 && NEW_FUNCTIONS.every(name=>installed.functions[name]===null))return 'absent';
 return installed.objects===OBJECT_PIN && [...NEW_FUNCTIONS,...DEPENDENCIES].every(name=>installed.functions[name]===FUNCTION_PINS[name])?'linked':'unknown';
}

/** Read-only for external databases; history rejects unknown steps and definitions attest this
 * capability. Neither acknowledgement nor this status establishes current source availability. */
export async function verifyMaterialLink(client:pg.ClientBase):Promise<MaterialLinkStatus>{
 try{
  if((await verifyMaterialGuard(client)).state!=='verified')return paused('The prerequisite Core source guard is not verified.');
  const history=await readSchemaHistory(client,'service');
  if(!schemaHistoryMatches(history))return paused('Core migration history is not recognized by this link.');
  if(hasMaterialClosure(history))return verifyMaterialClosure(client);
  return await definitions(client)==='linked'?verified():paused('Material link definitions differ from the qualified catalogue.');
 }catch{return paused('Material link definitions could not be inspected.');}
}

/** Owned installer only: exact absence or exact installed definitions, never partial repair.
 * No existing application row is changed. A failed transaction records no installation receipt. */
export async function upgradeMaterialLink(client:pg.ClientBase,baseline:string):Promise<MaterialLinkStatus>{
 const step=materialLinkStep(baseline);if(!step)return paused('The shipped material link differs from its reviewed pins.');
 for(let attempt=0;attempt<3;attempt++){
  let transaction=false;
  try{
   const role=await client.query<{installer:boolean}>('SELECT rolsuper AS installer FROM pg_catalog.pg_roles WHERE rolname=current_user');
   if(role.rows[0]?.installer!==true)return paused('Only the owned Core installer may apply this link.');
   await client.query('BEGIN');transaction=true;
   await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
   await client.query(CORE_SCHEMA_LOCK);
   const history=await readSchemaHistory(client,'installer');
   if(hasMaterialClosure(history)){
    const status=await verifyMaterialClosure(client);
    if(status.state!=='verified')throw new LinkPaused(status.reason);
    if((await client.query('COMMIT')).command!=='COMMIT')throw new LinkPaused('Material closure inspection did not receive a confirmed COMMIT.');
    transaction=false;return status;
   }
   const index=CORE_SCHEMA_UPGRADES.findIndex(item=>item.version===MATERIAL_LINK_VERSION);
   if(index<0 || !schemaHistoryMatches(history) || history.length<index+1)throw new LinkPaused('The material link prerequisite history is not installed.');
   if((await verifyMaterialGuard(client)).state!=='verified')throw new LinkPaused('The prerequisite Core source guard is not verified.');
   const state=await definitions(client);
   if(state==='unknown' || (state==='absent'&&history.length!==index+1))throw new LinkPaused('Material link definitions and installation history disagree.');
   if(state==='absent'){
    await client.query(step.sql);
    if(await definitions(client)!=='linked')throw new LinkPaused('Installed material link differs from its reviewed definitions.');
    if((await verifyMaterialGuard(client)).state!=='verified')throw new LinkPaused('The additive link changed the prerequisite source guard.');
   }
   if(history.length===index+1)await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[MATERIAL_LINK_VERSION,step.checksum]);
   await client.query('COMMIT');transaction=false;return verified();
  }catch(error){
   if(transaction)await client.query('ROLLBACK').catch(()=>{});
   const code=(error as {code?:string}).code;
   if((code==='55P03'||code==='40P01')&&attempt<2){await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));continue;}
   return paused(error instanceof LinkPaused?error.message:code==='55P03'||code==='40P01'?'The material link schema lock was busy; retry on the next open.':'The material link upgrade could not be verified; no upgrade was committed.');
  }
 }
 return paused('The material link schema lock was busy; retry on the next open.');
}
class LinkPaused extends Error{}
