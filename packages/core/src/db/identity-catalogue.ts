import {hardeningCatalogue} from './identity-hardening-source.ts';
import {IDENTITY_HARDENING_PINS} from './identity-hardening-pins.ts';
// Independent identity attestation. No expected metadata is read from a person's home.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { readSchemaHistory, schemaHistoryMatches } from './schema-migrations.ts';
import {IDENTITY_PLATFORM_PINS} from './identity-platform-pins.ts';
import {MATERIAL_CLOSURE_RELEASE as PLATFORM_RELEASE} from './identity-platform-release.generated.ts';
import {IDENTITY_GUARANTEES_PINS} from './identity-guarantees-pins.ts';
import {MATERIAL_CLOSURE_RELEASE as GUARANTEES_RELEASE} from './identity-guarantees-release.generated.ts';
import { IDENTITY_ADMISSION_PINS } from './identity-admission-pins.ts';
import { MATERIAL_CLOSURE_RELEASE as ADMISSION_RELEASE } from './identity-admission-release.generated.ts';
import { IDENTITY_RESOURCE_PINS } from './identity-resource-pins.ts';
import { MATERIAL_CLOSURE_RELEASE as RESOURCE_RELEASE } from './identity-resource-release.generated.ts';
import { IDENTITY_PINS } from './identity-pins.ts';
import { IDENTITY_ROLE_REVOCATION_PINS } from './identity-role-revocation-pins.ts';
import { MATERIAL_CLOSURE_RELEASE as ROLE_RELEASE } from './identity-role-revocation-release.generated.ts';
import { IDENTITY_WORK_PINS } from './identity-work-pins.ts';
import { MATERIAL_CLOSURE_RELEASE as WORK_RELEASE } from './identity-work-release.generated.ts';
import { MATERIAL_CLOSURE_RELEASE as RELEASE } from './identity-release.generated.ts';
import { collectMaterialClosureCatalogue } from './material-closure-catalogue.ts';
import type { MaterialClosureCapture } from './material-closure-profile.ts';

export const IDENTITY_VERSION = 'identity-v1';
export const identityHash = (text: string) => createHash('sha256').update(text).digest('hex');
function matches(rows: Awaited<ReturnType<typeof captureIdentity>>): boolean {
  if(hardeningCatalogue(identityHash(JSON.stringify(rows))))return true;
  if (!IDENTITY_PINS || IDENTITY_PINS.payload !== RELEASE.checksum || identityHash(RELEASE.sql) !== RELEASE.checksum) return false;
  if (rows.some(row => row.name === 'gov.identity_create_task(uuid,text)')) {
    if (!IDENTITY_WORK_PINS || IDENTITY_WORK_PINS.predecessor !== IDENTITY_PINS.catalogue
      || IDENTITY_WORK_PINS.payload !== WORK_RELEASE.checksum || identityHash(WORK_RELEASE.sql) !== WORK_RELEASE.checksum) return false;
    const catalogue = identityHash(JSON.stringify(rows));
    if(catalogue===IDENTITY_WORK_PINS.catalogue)return true;
    if(!IDENTITY_ROLE_REVOCATION_PINS || IDENTITY_ROLE_REVOCATION_PINS.predecessor!==IDENTITY_WORK_PINS.catalogue
      || IDENTITY_ROLE_REVOCATION_PINS.payload!==ROLE_RELEASE.checksum || identityHash(ROLE_RELEASE.sql)!==ROLE_RELEASE.checksum)return false;
    if(catalogue===IDENTITY_ROLE_REVOCATION_PINS.catalogue)return true;
    return !!IDENTITY_RESOURCE_PINS&&IDENTITY_RESOURCE_PINS.predecessor===IDENTITY_ROLE_REVOCATION_PINS.catalogue
      &&IDENTITY_RESOURCE_PINS.payload===RESOURCE_RELEASE.checksum&&identityHash(RESOURCE_RELEASE.sql)===RESOURCE_RELEASE.checksum
      &&(catalogue===IDENTITY_RESOURCE_PINS.catalogue || (!!IDENTITY_ADMISSION_PINS
        &&IDENTITY_ADMISSION_PINS.predecessor===IDENTITY_RESOURCE_PINS.catalogue
        &&IDENTITY_ADMISSION_PINS.payload===ADMISSION_RELEASE.checksum&&identityHash(ADMISSION_RELEASE.sql)===ADMISSION_RELEASE.checksum
        &&(catalogue===IDENTITY_ADMISSION_PINS.catalogue||!!IDENTITY_GUARANTEES_PINS
          &&IDENTITY_GUARANTEES_PINS.predecessor===IDENTITY_ADMISSION_PINS.catalogue
          &&IDENTITY_GUARANTEES_PINS.payload===GUARANTEES_RELEASE.checksum&&identityHash(GUARANTEES_RELEASE.sql)===GUARANTEES_RELEASE.checksum
          &&(catalogue===IDENTITY_GUARANTEES_PINS.catalogue||!!IDENTITY_PLATFORM_PINS
            &&IDENTITY_PLATFORM_PINS.predecessor===IDENTITY_GUARANTEES_PINS.catalogue
            &&IDENTITY_PLATFORM_PINS.payload===PLATFORM_RELEASE.checksum&&identityHash(PLATFORM_RELEASE.sql)===PLATFORM_RELEASE.checksum
            &&catalogue===IDENTITY_PLATFORM_PINS.catalogue))));
  }
  return identityHash(JSON.stringify(rows)) === IDENTITY_PINS.catalogue;
}
async function matchesInstalled(client: pg.ClientBase, rows: Awaited<ReturnType<typeof captureIdentity>>): Promise<boolean> {
  if (!matches(rows)) return false;
  const history = await readSchemaHistory(client, 'service');
  if (!schemaHistoryMatches(history)) return false;
  for(const pins of [...IDENTITY_HARDENING_PINS].reverse())if(history.some(row=>row.version===pins.version))return identityHash(JSON.stringify(rows))===pins.catalogue;
  // Predecessors remain verifiable for upgrade qualification. Once installed, a
  // role-revocation receipt requires its exact catalogue; replaying old bodies fails closed.
  if(history.some(row=>row.version==='identity-platform-v1'))return identityHash(JSON.stringify(rows))===IDENTITY_PLATFORM_PINS?.catalogue;
  if(history.some(row=>row.version==='identity-guarantees-v1'))return identityHash(JSON.stringify(rows))===IDENTITY_GUARANTEES_PINS?.catalogue;
  if(history.some(row=>row.version==='identity-admission-closure-v1'))return identityHash(JSON.stringify(rows))===IDENTITY_ADMISSION_PINS?.catalogue;
  if(history.some(row=>row.version==='identity-resource-guard-v1'))return identityHash(JSON.stringify(rows))===IDENTITY_RESOURCE_PINS?.catalogue;
  return !history.some(row => row.version === 'identity-role-revocation-v1')
    || identityHash(JSON.stringify(rows)) === IDENTITY_ROLE_REVOCATION_PINS?.catalogue;
}
export async function captureIdentity(client: pg.ClientBase) {
  const rows = (await client.query(`
    SELECT * FROM (SELECT 'function' AS kind,p.oid::regprocedure::text AS name,jsonb_build_object(
      'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,
      'app',has_function_privilege('backbone_app',p.oid,'EXECUTE'),
      'operator',has_function_privilege('backbone_operator',p.oid,'EXECUTE')) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname IN ('gov','operator') AND p.proname LIKE 'identity\\_%' ESCAPE '\\') OR (n.nspname='sec' AND p.proname='t_identity_mutation_context')
    UNION ALL
    SELECT 'table',n.nspname||'.'||c.relname,jsonb_build_object(
      'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'acl',c.relacl::text,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'definition',pg_get_constraintdef(x.oid),'validated',x.convalidated,'deferrable',x.condeferrable,'deferred',x.condeferred) ORDER BY x.conname COLLATE "C") FROM pg_constraint x WHERE x.conrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',x.polname,'permissive',x.polpermissive,'roles',x.polroles::regrole[]::text[],'command',x.polcmd,'using',pg_get_expr(x.polqual,x.polrelid),'check',pg_get_expr(x.polwithcheck,x.polrelid)) ORDER BY x.polname COLLATE "C") FROM pg_policy x WHERE x.polrelid=c.oid),
      'indexes',(SELECT jsonb_agg(pg_get_indexdef(x.indexrelid) ORDER BY x.indexrelid::regclass::text COLLATE "C") FROM pg_index x WHERE x.indrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('definition',pg_get_triggerdef(x.oid),'enabled',x.tgenabled) ORDER BY x.tgname COLLATE "C") FROM pg_trigger x WHERE x.tgrelid=c.oid AND NOT x.tgisinternal))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname LIKE 'identity\\_%' ESCAPE '\\' AND c.relkind IN ('r','p','v','m','f')
    UNION ALL
    SELECT 'policy',schemaname||'.'||tablename||'.'||policyname,to_jsonb(p)-'schemaname'-'tablename'-'policyname'
    FROM pg_policies p WHERE schemaname='app' AND policyname LIKE 'identity\\_project\\_%' ESCAPE '\\'
    ) inventory ORDER BY kind COLLATE "C",name COLLATE "C"`)).rows;
  if (rows.some(row=>row.name==='gov.identity_create_task(uuid,text)')) {
    const full=await collectMaterialClosureCatalogue(client);
    const names=['sec.task_visible_to(uuid,uuid)',...(rows.some(row=>row.name==='gov.identity_bind_new_task()')?['gov.claim_run(uuid,text,integer,text,uuid)','gov.claim_next_run(text,integer,text,uuid)','gov.revoke_mandate(uuid)','gov.claim_next_effect(text,integer)','gov.claim_next_verification(text,integer)','gov.join_channel_thread(uuid,uuid)','gov.share_task(uuid)']:[]),...(rows.some(row=>row.name==='gov.identity_budget_totals(uuid)')?admissionReplacements:[]),...(rows.some(row=>row.name==='gov.identity_task_exists(uuid)')?guaranteeReplacements:[])];
    for(const name of names)rows.push({kind:'replacement',name,definition:full.functions.find(row=>row.signature===name)});
    for(const name of ['app.tasks.identity_task_project_binding',...(['episodes','knowledge_candidates','ledger'].map(table=>`app.${table}.identity_mutation_context`))]){
      const trigger=full.triggers.find(row=>row.name===name);
      if(trigger)rows.push({kind:'attachment',name,definition:{trigger,object:full.objects.find(row=>row.kind==='trigger'&&row.name===name)}});
    }
  }
  const full=await collectMaterialClosureCatalogue(client);
  if(full.functions.find(row=>row.signature==='gov.change_role(uuid,text)')?.appExecutes===false) {
    for(const name of legacyPersonCrossings)rows.push({kind:'replacement',name,definition:full.functions.find(row=>row.signature===name)});
  }
  return rows;
}

/** Only exact, independently attested additions may extend the old closed namespace.
 * The caller still checks every old material function, table, role, ACL and trigger. */
export async function projectIdentityInventory(client: pg.ClientBase, actual: MaterialClosureCapture): Promise<MaterialClosureCapture> {
  const rows = await captureIdentity(client);
  if (!rows.length) return actual;
  if (!(await matchesInstalled(client, rows))) throw new Error('Identity catalogue differs from its reviewed source profile.');
  const functions = new Set(rows.filter(row => row.kind === 'function').map(row => row.name));
  const tables = new Set(rows.filter(row => row.kind === 'table').map(row => row.name));
  const types = new Set([...tables].flatMap(name => [name, name.replace('app.', 'app._')]));
  const policies = new Set(rows.filter(row=>row.kind==='policy').map(row=>row.name));
  const attachments=new Set(rows.filter(row=>row.kind==='attachment').map(row=>row.name));
  const ownedTrigger=(name:string)=>tables.has(name.slice(0,name.lastIndexOf('.')));
  const inheritedOwnedTrigger=(name:string)=>ownedTrigger('app.'+name);
  const inheritedAttachments=new Set([...attachments].map(name=>name.slice(4)));
  const inheritedPolicies = new Set([...policies].map(name=>name.slice(4)));
  const guardRows=actual.guard.objectRows.filter(row=>!((row.kind==='policy'&&inheritedPolicies.has(row.name))||(row.kind==='trigger'&&(inheritedAttachments.has(row.name)||inheritedOwnedTrigger(row.name)))));
  const linkRows=actual.link.objectRows.filter(row=>!((row.kind==='policy'&&inheritedPolicies.has(row.name))||(row.kind==='trigger'&&(inheritedAttachments.has(row.name)||inheritedOwnedTrigger(row.name)))));
  return { ...actual,
    guard:{...actual.guard,objectRows:guardRows,objects:identityHash(JSON.stringify(guardRows))},
    link:{...actual.link,objectRows:linkRows,objects:identityHash(JSON.stringify(linkRows))},
    full: { ...actual.full, triggers:actual.full.triggers.filter(row=>!(attachments.has(row.name)||ownedTrigger(row.name))), objects:actual.full.objects.filter(row=>!((row.kind==='policy'&&policies.has(row.name))||(row.kind==='trigger'&&(attachments.has(row.name)||ownedTrigger(row.name))))), inventory: actual.full.inventory.filter(row =>
    !(row.kind === 'function' && functions.has(row.name)) && !(row.kind === 'relation' && tables.has(row.name)) && !(row.kind === 'type' && types.has(row.name))) } };

}

export async function verifyIdentity(client: pg.ClientBase): Promise<{ state: 'verified' | 'paused'; reason: string }> {
  try {
    const rows = await captureIdentity(client);
    if (!(await matchesInstalled(client, rows))) throw new Error();
    return { state: 'verified', reason: 'Identity catalogue matches the frozen source qualification.' };
  } catch { return { state: 'paused', reason: 'Identity admission is unavailable until its exact catalogue is verified.' }; }
}

/** Only the attested work release may replace this inherited reader predicate. */
const legacyPersonCrossings=['gov.change_role(uuid,text)','gov.add_person(text,text,text)','gov.accept_invitation(text,text)'];
const admissionReplacements=['gov._mandate_standing(uuid)','gov._task_read_beyond(uuid,uuid)','gov.quote_marks(uuid,jsonb)','gov._quote_run(uuid,uuid)','gov.unregister_piece(uuid)','gov.give_connector_signature(uuid,text,text)','gov._may_answer(uuid,uuid,text)'];
const guaranteeReplacements=['gov.queue_run(uuid,uuid,uuid,uuid,uuid)','gov.propose_undo(uuid,jsonb,text,text,text)','gov.propose_candidate(text,jsonb,uuid,text)','gov._promotion_sources_allowed(uuid)','sec.t_candidate_input_capture_v1()'];
export function identityReaderReplacements(actual: MaterialClosureCapture): ReadonlySet<string> {
  const existing=new Set(actual.full.inventory.some(row=>row.kind==='function'&&row.name==='gov.identity_create_task(uuid,text)')
    ? ['sec.task_visible_to(uuid,uuid)',...(actual.full.inventory.some(row=>row.kind==='function'&&row.name==='gov.identity_bind_new_task()')?['gov.claim_run(uuid,text,integer,text,uuid)','gov.claim_next_run(text,integer,text,uuid)','gov.revoke_mandate(uuid)','gov.claim_next_effect(text,integer)','gov.claim_next_verification(text,integer)','gov.join_channel_thread(uuid,uuid)','gov.share_task(uuid)']:[])] : []);
  if(actual.full.inventory.some(row=>row.kind==='function'&&row.name==='gov.identity_budget_totals(uuid)'))for(const name of admissionReplacements)existing.add(name);
  if(actual.full.inventory.some(row=>row.kind==='function'&&row.name==='gov.identity_task_exists(uuid)'))for(const name of guaranteeReplacements)existing.add(name);
  if(actual.full.functions.find(row=>row.signature==='gov.change_role(uuid,text)')?.appExecutes===false)for(const name of legacyPersonCrossings)existing.add(name);
  return existing;
}

/** Signature verification retains its old complete profile except these two
 * independently attested final-phase functions. No expectations come from a home. */
export async function identitySignatureOverrides(client:pg.ClientBase):Promise<Record<string,string>>{
 const history=await readSchemaHistory(client,'service');
 if(!history.some(row=>row.version==='identity-admission-closure-v1'))return {};
 const rows=await captureIdentity(client);if(!await matchesInstalled(client,rows)||!IDENTITY_ADMISSION_PINS?.signatures)throw new Error('Identity signature extension is not verified.');
 return history.some(row=>row.version==='identity-guarantees-v1')?{...IDENTITY_GUARANTEES_PINS!.signatures}:{...IDENTITY_ADMISSION_PINS.signatures};
}
