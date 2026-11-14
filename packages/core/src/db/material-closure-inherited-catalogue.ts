// Inherited catalogue queries. Preserve their exact SQL and historical hash encodings.
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {INHERITED} from './material-closure-inherited.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const GUARD_FUNCTIONS = [
  'gov._promotion_sources_allowed(uuid)',
  'gov.request_promotion(uuid,uuid,timestamp with time zone,timestamp with time zone)',
  'gov._promote(uuid,uuid,uuid)', 'gov.may_decide(uuid)', 'gov.claim_next_verification(text,integer)',
  'gov.recall_knowledge(uuid,text[],integer)',
  'sec.visible_eligible_knowledge_sources()', 'sec.t_material_promotion_guard()',
  'sec.t_candidate()', 'sec.t_evidence()', 'sec.t_ledger_append_only()', 'sec.t_refuse_truncate()',
  'sec.t_principal()', 'sec.t_knowledge()',
  'gov._settle_decision(uuid,text,uuid,text)', 'gov.answer_decision(uuid,text,text,text)',
  'gov.verifier_answer(uuid,text,text)', 'gov.propose_candidate(text,jsonb,uuid,text)',
  'gov.record_source(text,text,text,uuid,uuid,uuid,text,uuid)',
  'gov.record_server_answer(uuid,uuid,text,text)', 'gov._append(text,text,jsonb,uuid)',
  'sec.candidate_visible(uuid)', 'sec.decision_visible(uuid)',
] as const;
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

export interface FunctionRow {signature:string;kind:string;support:boolean;sqlBody:boolean;body:string|null;language:string;owner:string;definer:boolean;volatility:string;result:string;set:boolean;strict:boolean;leakproof:boolean;parallel:string;configuration:string[]|null;defaults:number;defaultExpression:string|null;argumentNames:string[]|null;argumentModes:string[]|null;allArgumentTypes:string[]|null;variadic:boolean;acl:{grantee:string;grantor:string;privilege:string;grantable:boolean}[]|null;appExecutes:boolean;operatorExecutes:boolean;ownerExecutes:boolean}
export interface TriggerRow {name:string;enabled:string;type:number;function:string;constraint:boolean;constraintType:string;constraintTable:boolean;constraintDeferrable:boolean;constraintDeferred:boolean;deferrable:boolean;deferred:boolean;validated:boolean;predicate:string|null;arguments:number;argumentBytes:number;updateColumns:number;oldTable:string|null;newTable:string|null;constraintRelation:string|null;parent:number}
export interface PostureRow {safe:boolean}
export interface MaterialEnforcementCatalogue {functions:FunctionRow[];triggers:TriggerRow[];posture:PostureRow[]}


export async function collectGuard(client: pg.ClientBase) {
  const { rows } = await client.query<{ signature: string; definition: unknown }>(`
    SELECT wanted.signature, jsonb_build_object(
      'definition',pg_catalog.pg_get_functiondef(p.oid),'owner',pg_catalog.pg_get_userbyid(p.proowner),
      'acl',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable) FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a),
      'appExecutes',pg_catalog.has_function_privilege('backbone_app',p.oid,'EXECUTE')
    ) AS definition
    FROM pg_catalog.unnest($1::text[]) wanted(signature)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(wanted.signature)
    ORDER BY wanted.signature COLLATE "C"`, [GUARD_FUNCTIONS]);
  const functions = Object.fromEntries(rows.map(row => [row.signature,
    (row.definition as { definition: unknown }).definition === null ? null : hash(JSON.stringify(row.definition))]));
  const objects = await client.query<{ kind: string; name: string; definition: unknown }>(`
    SELECT * FROM (SELECT 'relation' AS kind,n.nspname||'.'||c.relname AS name,jsonb_build_object(
      'kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,
      'forced',c.relforcerowsecurity,'acl',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable) FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a),
      'view',CASE WHEN c.relkind='v' THEN pg_catalog.pg_get_viewdef(c.oid,true) END) AS definition
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname='app' AND c.relname IN ('episodes','knowledge_candidates','knowledge','decisions','ledger','principals','material_guard_history'))
       OR (n.nspname='gov' AND c.relname='eligible_knowledge_sources')
    UNION ALL
    SELECT 'column',c.relname||'.'||a.attname,jsonb_build_object('type',pg_catalog.format_type(a.atttypid,a.atttypmod),
      'required',a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='app' AND c.relname IN ('episodes','knowledge_candidates','knowledge','decisions','ledger','principals')
    UNION ALL
    SELECT 'policy',tablename||'.'||policyname,to_jsonb(p)-'schemaname'-'tablename'-'policyname'
    FROM pg_catalog.pg_policies p WHERE schemaname='app' AND tablename IN ('episodes','knowledge_candidates','knowledge','decisions','ledger','principals')
    UNION ALL
    SELECT 'trigger',c.relname||'.'||t.tgname,jsonb_build_object('definition',pg_catalog.pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled)
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname='app' AND c.relname IN ('episodes','knowledge_candidates','knowledge','ledger','principals')
    UNION ALL
    SELECT 'index',c.relname,jsonb_build_object('definition',pg_catalog.pg_get_indexdef(c.oid),'valid',i.indisvalid,'ready',i.indisready)
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='app' AND t.relname IN ('episodes','knowledge_candidates','knowledge','decisions','ledger','principals')
    ) catalogue ORDER BY kind COLLATE "C",name COLLATE "C"`);
  if(new Set(objects.rows.map(row=>`${row.kind}:${row.name}`)).size!==objects.rows.length)throw new Error('Ambiguous Core catalogue labels.');
  return { functions, objects: hash(JSON.stringify(objects.rows)), objectRows:objects.rows };
}

export async function collectLink(client:pg.ClientBase){
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
  objects:hash(JSON.stringify(objects)),relations:objects.filter(row=>row.kind==='relation').length, objectRows:objects, roleRows:roles};
}

export async function collectEnforcement(client:pg.ClientBase):Promise<MaterialEnforcementCatalogue>{
 const functions=(await client.query<FunctionRow>(`
  SELECT wanted.signature,p.prokind AS kind,p.prosupport<>0 AS support,p.prosqlbody IS NOT NULL AS "sqlBody",p.prosrc AS body,l.lanname AS language,pg_catalog.pg_get_userbyid(p.proowner) AS owner,
   p.prosecdef AS definer,p.provolatile AS volatility,pg_catalog.format_type(p.prorettype,NULL) AS result,p.proretset AS set,
   p.proisstrict AS strict,p.proleakproof AS leakproof,p.proparallel AS parallel,p.proconfig AS configuration,
   p.pronargdefaults::integer AS defaults,pg_catalog.pg_get_expr(p.proargdefaults,0) AS "defaultExpression",
   p.proargnames AS "argumentNames",p.proargmodes::text[] AS "argumentModes",
   CASE WHEN p.proallargtypes IS NULL THEN NULL ELSE ARRAY(SELECT pg_catalog.format_type(a.type,NULL)
    FROM pg_catalog.unnest(p.proallargtypes) WITH ORDINALITY a(type,ordinal) ORDER BY a.ordinal) END AS "allArgumentTypes",
   p.provariadic<>0 AS variadic,
   (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
    'grantor',pg_catalog.pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
    ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable)
    FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a) AS acl,
   pg_catalog.has_function_privilege('backbone_app',p.oid,'EXECUTE') AS "appExecutes",
   pg_catalog.has_function_privilege('backbone_operator',p.oid,'EXECUTE') AS "operatorExecutes",
   pg_catalog.has_function_privilege('backbone_owner',p.oid,'EXECUTE') AS "ownerExecutes"
  FROM pg_catalog.unnest($1::text[]) wanted(signature)
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(wanted.signature)
  LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  ORDER BY wanted.signature COLLATE "C"`,[Object.keys(INHERITED.nativeSpecs)])).rows;
 const triggers=(await client.query<TriggerRow>(`
  SELECT c.relname||'.'||t.tgname AS name,t.tgenabled AS enabled,t.tgtype::integer AS type,
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
  WHERE NOT t.tgisinternal AND n.nspname='app' AND c.relname='episodes' AND t.tgname='material_source_receipt'
  ORDER BY (c.relname||'.'||t.tgname) COLLATE "C"`)).rows;
 const posture=(await client.query<PostureRow>(`
  SELECT (
   (SELECT count(*)=4 AND bool_and(NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
     AND rolinherit AND rolcanlogin=(rolname IN ('backbone_app','backbone_operator')))
    FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]))
   AND NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=m.member WHERE r.rolname=ANY($1::text[]) OR member.rolname=ANY($1::text[]))
   AND NOT EXISTS (SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname||'.'||p.proname=ANY($2::text[]) AND NOT p.oid=ANY(
      ARRAY(SELECT pg_catalog.to_regprocedure(signature)::oid FROM pg_catalog.unnest($3::text[]) signature WHERE pg_catalog.to_regprocedure(signature) IS NOT NULL)))
   -- A table INSERT rule can divert a source before any AFTER trigger queues its event.
   AND NOT EXISTS (SELECT FROM pg_catalog.pg_rewrite WHERE ev_class='app.episodes'::regclass)
   -- Both canonical text columns inherit the deterministic database-default collation.
   -- Another explicit collation is a different profile, even if it happens to compare safely.
   AND (SELECT count(*)=2 AND bool_and(a.attcollation='pg_catalog."default"'::regcollation
       AND co.collprovider='d' AND co.collisdeterministic)
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
    WHERE a.attrelid='app.episodes'::regclass AND a.attname IN ('source_kind','source_ref')
      AND a.attnum>0 AND NOT a.attisdropped)
   AND NOT pg_catalog.has_parameter_privilege('backbone_app','session_replication_role','SET')
   AND NOT pg_catalog.has_parameter_privilege('backbone_operator','session_replication_role','SET')
   AND (SELECT count(*)=4 AND bool_and(pg_catalog.pg_get_userbyid(n.nspowner)=CASE WHEN n.nspname='gov' THEN 'backbone_gov' ELSE 'backbone_owner' END)
    FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('app','sec','gov','ops'))
   AND NOT EXISTS (SELECT FROM pg_catalog.pg_namespace n,
    LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
    WHERE n.nspname IN ('app','sec','gov','ops') AND (a.is_grantable
     OR NOT ((a.grantee=n.nspowner AND a.grantor=n.nspowner AND a.privilege_type IN ('CREATE','USAGE'))
      OR (pg_catalog.pg_get_userbyid(a.grantee)='backbone_gov' AND a.grantor=n.nspowner AND a.privilege_type='USAGE' AND n.nspname IN ('app','sec','ops'))
      OR (pg_catalog.pg_get_userbyid(a.grantee)='backbone_gov' AND a.grantor=n.nspowner AND a.privilege_type='CREATE' AND n.nspname='sec')
      OR (pg_catalog.pg_get_userbyid(a.grantee)='backbone_app' AND a.grantor=n.nspowner AND a.privilege_type='USAGE' AND n.nspname IN ('app','sec','gov')))))
   AND pg_catalog.has_schema_privilege('backbone_gov','sec','CREATE')
   AND pg_catalog.has_schema_privilege('backbone_gov','sec','USAGE')
   AND pg_catalog.has_schema_privilege('backbone_gov','app','USAGE')
   AND pg_catalog.has_schema_privilege('backbone_gov','ops','USAGE')
   AND NOT pg_catalog.has_schema_privilege('backbone_app','sec','CREATE')
   AND NOT pg_catalog.has_schema_privilege('backbone_app','gov','CREATE')
   AND NOT pg_catalog.has_schema_privilege('backbone_operator','sec','CREATE')
   AND NOT pg_catalog.has_schema_privilege('backbone_operator','gov','CREATE')
  ) AS safe`,[['backbone_owner','backbone_gov','backbone_app','backbone_operator'],Object.keys(INHERITED.nativeSpecs).map(name=>name.split('(')[0]),Object.keys(INHERITED.nativeSpecs)])).rows;
 return {functions,triggers,posture};
}
