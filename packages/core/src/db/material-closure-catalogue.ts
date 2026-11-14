// Fixed complete Core metadata scope, independent of installers, status and source SQL.
import type pg from 'pg';
import type {FunctionRow,TriggerRow} from './material-closure-inherited-catalogue.ts';
import {FUNCTIONS,RELATIONS,SCHEMAS} from './material-closure-scope.ts';
export interface ObjectRow {kind:string;name:string;definition:unknown}
export interface NativeFunctionRow extends FunctionRow {binary:string|null;cost:string|null;rows:string|null;transforms:string[]|null}
// Metadata capture only. No public SQL, profile or scope argument.
export async function collectMaterialClosureCatalogue(client:pg.ClientBase){
 const signatures=FUNCTIONS;
 const functions=(await client.query<NativeFunctionRow>(`
  SELECT wanted.signature,p.prokind AS kind,p.prosupport<>0 AS support,p.prosqlbody IS NOT NULL AS "sqlBody",p.prosrc AS body,l.lanname AS language,pg_catalog.pg_get_userbyid(p.proowner) AS owner,
   p.prosecdef AS definer,p.provolatile AS volatility,pg_catalog.format_type(p.prorettype,NULL) AS result,p.proretset AS set,
   p.proisstrict AS strict,p.proleakproof AS leakproof,p.proparallel AS parallel,p.proconfig AS configuration,
   p.pronargdefaults::integer AS defaults,pg_catalog.pg_get_expr(p.proargdefaults,0) AS "defaultExpression",
   p.proargnames AS "argumentNames",p.proargmodes::text[] AS "argumentModes",
   CASE WHEN p.proallargtypes IS NULL THEN NULL ELSE ARRAY(SELECT pg_catalog.format_type(a.type,NULL)
    FROM pg_catalog.unnest(p.proallargtypes) WITH ORDINALITY a(type,ordinal) ORDER BY a.ordinal) END AS "allArgumentTypes",
   p.provariadic<>0 AS variadic,p.probin AS binary,p.procost::text AS cost,p.prorows::text AS rows,
   CASE WHEN p.protrftypes IS NULL THEN NULL ELSE ARRAY(SELECT pg_catalog.format_type(a.type,NULL) FROM pg_catalog.unnest(p.protrftypes) WITH ORDINALITY a(type,ordinal) ORDER BY a.ordinal) END AS transforms,
   (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
    'grantor',pg_catalog.pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
    ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
    FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a) AS acl,
   pg_catalog.has_function_privilege('backbone_app',p.oid,'EXECUTE') AS "appExecutes",
   pg_catalog.has_function_privilege('backbone_operator',p.oid,'EXECUTE') AS "operatorExecutes",
   pg_catalog.has_function_privilege('backbone_owner',p.oid,'EXECUTE') AS "ownerExecutes"
  FROM pg_catalog.unnest($1::text[]) wanted(signature)
  -- Catalogue identity lookup must not require USAGE on private crypto/operator schemas.
  -- Formatting an existing OID is observation; resolving a supplied regprocedure name is not.
  LEFT JOIN pg_catalog.pg_proc p ON p.oid::regprocedure::text=wanted.signature
  LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  ORDER BY wanted.signature COLLATE "C"`,[signatures])).rows;
 const objects=(await client.query<ObjectRow>(`
  SELECT * FROM (SELECT 'relation' AS kind,(n.nspname||'.'||c.relname)::text AS name,pg_catalog.jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'owner',pg_catalog.pg_get_userbyid(c.relowner),
   'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'view',CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(c.oid,true) END,'options',c.reloptions,'replicaIdentity',c.relreplident,'accessMethod',(SELECT amname FROM pg_catalog.pg_am WHERE oid=c.relam),
   'acl',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
     pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
    FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a)) AS definition
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname=ANY($1::text[])
  UNION ALL SELECT 'column',n.nspname||'.'||c.relname||'.'||a.attname,pg_catalog.jsonb_build_object('type',pg_catalog.format_type(a.atttypid,a.atttypmod),
   'required',a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'number',a.attnum,'options',a.attoptions,
   'acl',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(CASE WHEN ac.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(ac.grantee) END,pg_catalog.pg_get_userbyid(ac.grantor),ac.privilege_type,ac.is_grantable) ORDER BY ac.grantee::regrole::text COLLATE "C",ac.privilege_type COLLATE "C",ac.is_grantable) FROM pg_catalog.aclexplode(a.attacl) ac),
   'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE pg_catalog.jsonb_build_object(
    'schema',cn.nspname,'name',co.collname,'provider',co.collprovider,'deterministic',co.collisdeterministic,'version',co.collversion) END)
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
   LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname||'.'||c.relname=ANY($1::text[])
  UNION ALL SELECT 'constraint',n.nspname||'.'||c.relname||'.'||k.conname,pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_constraintdef(k.oid,true),
   'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred)
  FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname||'.'||c.relname=ANY($1::text[])
  UNION ALL SELECT 'policy',schemaname||'.'||tablename||'.'||policyname,pg_catalog.to_jsonb(p)-'schemaname'-'tablename'-'policyname'
  FROM pg_catalog.pg_policies p WHERE schemaname||'.'||tablename=ANY($1::text[])
  UNION ALL SELECT 'rule',n.nspname||'.'||c.relname||'.'||r.rulename,pg_catalog.jsonb_build_object(
   'definition',pg_catalog.pg_get_ruledef(r.oid,true),'enabled',r.ev_enabled)
  FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname||'.'||c.relname=ANY($1::text[])
  UNION ALL SELECT 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled)
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname||'.'||c.relname=ANY($1::text[])
  UNION ALL SELECT 'index',n.nspname||'.'||c.relname,pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_indexdef(c.oid),'valid',i.indisvalid,'ready',i.indisready)
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname||'.'||t.relname=ANY($1::text[]) ) catalogue ORDER BY kind COLLATE "C",name COLLATE "C"`,[RELATIONS])).rows;
 const triggers=(await client.query<TriggerRow>(`
  SELECT n.nspname||'.'||c.relname||'.'||t.tgname AS name,t.tgenabled AS enabled,t.tgtype::integer AS type,
   t.tgfoid::regprocedure::text AS function,t.tgconstraint<>0 AS constraint,k.contype AS "constraintType",
   k.conrelid=t.tgrelid AS "constraintTable",k.condeferrable AS "constraintDeferrable",k.condeferred AS "constraintDeferred",
   t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,k.convalidated AS validated,
   t.tgqual::text AS predicate,t.tgnargs::integer AS arguments,octet_length(t.tgargs) AS "argumentBytes",
   cardinality(t.tgattr::smallint[]) AS "updateColumns",t.tgoldtable AS "oldTable",t.tgnewtable AS "newTable",
   CASE WHEN t.tgconstrrelid=0 THEN NULL ELSE t.tgconstrrelid::regclass::text END AS "constraintRelation",
   t.tgparentid::integer AS parent
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
   JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   LEFT JOIN pg_catalog.pg_constraint k ON k.oid=t.tgconstraint
  WHERE NOT t.tgisinternal AND n.nspname||'.'||c.relname=ANY($1::text[])
  ORDER BY (n.nspname||'.'||c.relname||'.'||t.tgname) COLLATE "C"`,[RELATIONS])).rows;
 const overloads=(await client.query<{signature:string}>(`
 SELECT p.oid::regprocedure::text AS signature FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname||'.'||p.proname=ANY($1::text[])
 ORDER BY p.oid::regprocedure::text COLLATE "C"`,
 [FUNCTIONS.map(s=>s.split('(')[0])])).rows;
 const authority=await collectAuthority(client);
 return {functions,objects,triggers,overloads,...authority};
}


/** Exact schema/privilege and namespace inventories. The four released role/membership
 * encodings remain independently checked by collectLink; these add previously implicit scope. */
async function collectAuthority(client:pg.ClientBase){
 const namespaces=(await client.query<ObjectRow>(`
 SELECT * FROM (
 SELECT 'schema' AS kind,n.nspname::text AS name,pg_catalog.jsonb_build_object(
  'owner',pg_catalog.pg_get_userbyid(n.nspowner),
  'acl',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
   pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
   FROM pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a)) AS definition
 FROM pg_catalog.pg_namespace n WHERE n.nspname=ANY($1::text[])
 UNION ALL SELECT 'default-privilege',pg_catalog.pg_get_userbyid(d.defaclrole)||'/'||COALESCE(n.nspname,'*')||'/'||d.defaclobjtype::text,
  (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
   pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
   FROM pg_catalog.aclexplode(d.defaclacl) a)
 FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
 WHERE pg_catalog.pg_get_userbyid(d.defaclrole)=ANY($2::text[]) OR n.nspname=ANY($1::text[])
 UNION ALL SELECT 'extension',e.extname::text,pg_catalog.jsonb_build_object(
  'version',e.extversion,'schema',n.nspname,'relocatable',e.extrelocatable,
  'config',CASE WHEN e.extconfig IS NULL THEN NULL ELSE ARRAY(SELECT c::regclass::text FROM pg_catalog.unnest(e.extconfig) WITH ORDINALITY c(c,ordinal) ORDER BY c.ordinal) END,
  'condition',e.extcondition)
 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'
 UNION ALL SELECT 'role-posture',r.rolname::text,pg_catalog.jsonb_build_object(
  'superuser',r.rolsuper,'bypassRls',r.rolbypassrls,'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,
  'login',r.rolcanlogin,'inherit',r.rolinherit,'replication',r.rolreplication,'connectionLimit',r.rolconnlimit,
  'validUntil',r.rolvaliduntil::text)
 FROM pg_catalog.pg_roles r WHERE r.rolname=ANY($2::text[])
 UNION ALL SELECT 'role-configuration',r.rolname||'/'||COALESCE(db.datname,'*'),pg_catalog.to_jsonb(s.setconfig)
 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_roles r ON r.oid=s.setrole
 LEFT JOIN pg_catalog.pg_database db ON db.oid=s.setdatabase WHERE r.rolname=ANY($2::text[])
 ) catalogue ORDER BY kind COLLATE "C",name COLLATE "C"`,[SCHEMAS,['backbone_owner','backbone_gov','backbone_app','backbone_operator']])).rows;
 // Type/sequence/foreign/partition additions are explicit namespace changes, never hidden by
 // looking up only expected names. Index and trigger additions are covered by full families.
 const inventory=(await client.query<ObjectRow>(`
 SELECT * FROM (
 SELECT 'function' AS kind,p.oid::regprocedure::text AS name,pg_catalog.to_jsonb(p.prokind::text) AS definition
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname=ANY($1::text[]) AND n.nspname<>'crypto'
 UNION ALL SELECT 'relation',n.nspname||'.'||c.relname,pg_catalog.to_jsonb(c.relkind::text)
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','m','S','f','c')
 UNION ALL SELECT 'type',n.nspname||'.'||t.typname,pg_catalog.jsonb_build_object(
  'kind',t.typtype,'category',t.typcategory,'owner',pg_catalog.pg_get_userbyid(t.typowner),'required',t.typnotnull,
  'base',CASE WHEN t.typbasetype=0 THEN NULL ELSE pg_catalog.format_type(t.typbasetype,NULL) END,
  'element',CASE WHEN t.typelem=0 THEN NULL ELSE pg_catalog.format_type(t.typelem,NULL) END,
  'relation',CASE WHEN t.typrelid=0 THEN NULL ELSE t.typrelid::regclass::text END,'default',t.typdefault,
  'enum',(SELECT pg_catalog.jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid))
 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname=ANY($1::text[]) AND n.nspname<>'crypto'
 ) catalogue ORDER BY kind COLLATE "C",name COLLATE "C"`,[SCHEMAS])).rows;
 return {namespaces,inventory};
}
