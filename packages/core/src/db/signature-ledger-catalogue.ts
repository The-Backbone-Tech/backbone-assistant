// Exact catalogue inspection reused from the material journal's qualified inspection shape.
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {SIGNATURE_FUNCTIONS} from './signature-ledger-source.ts';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const TABLES=['connector_signatures'];
const NEW_FUNCTIONS=SIGNATURE_FUNCTIONS;
const DEPENDENCIES=['gov._append(text,text,jsonb,uuid)','gov._lock_workspace()','gov._person(text)',
 'gov._may_answer(uuid,uuid,text)','gov._settle_decision(uuid,text,uuid,text)','gov.answer_decision(uuid,text,text,text)',
 'sec.current_workspace()','sec.current_principal()','sec.names_run()','sec.principal_kind(uuid)',
 'sec.digest(text)','sec.t_keep_columns()','sec.t_refuse_truncate()',
 'sec.ledger_hash(text,uuid,bigint,text,uuid,text,jsonb,timestamp with time zone)'];
export async function inspectSignatureLedger(client:pg.ClientBase){
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
   'collation',(SELECT n.nspname||'.'||c.collname FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace WHERE c.oid=a.attcollation),
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
