// Pure catalogue attestation shared with the prerequisite guard. No verifier/installer imports.
// Source-body pins and explicit structural facts are compiled; runtime never learns a profile.
import {createHash} from 'node:crypto';
import type pg from 'pg';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const FUNCTIONS={
  "gov._material_source_state(uuid)": {
    "body": "b1bbb48853615c2b126e7e0826d79989aeb6567515b9b482bbcfb92598ed2245",
    "language": "plpgsql",
    "volatility": "v",
    "result": "text",
    "set": false,
    "app": false,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_episode"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "sec.t_material_episode_source()": {
    "body": "5aea80446ed45333b7937e6ae9a6bc3cd0491e455c7de6052199018a866def7c",
    "language": "plpgsql",
    "volatility": "v",
    "result": "trigger",
    "set": false,
    "app": false,
    "ownerExecute": true,
    "definer": true,
    "parallel": "u",
    "argumentNames": null,
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov._holder(uuid,bigint)": {
    "body": "7ef2152e33970c4e763dac7dc58ec3e14122661f9e2e3773879852704693692a",
    "language": "plpgsql",
    "volatility": "v",
    "result": "app.runs",
    "set": false,
    "app": false,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run",
      "p_fence"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov.renew_run_lease(uuid,bigint,integer)": {
    "body": "d0f4efa65694cac6acfe0654b2ddb0a07dc4e929e41f0bc7276ef2d7014bf9e7",
    "language": "plpgsql",
    "volatility": "v",
    "result": "timestamp with time zone",
    "set": false,
    "app": true,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run",
      "p_fence",
      "p_lease_ms"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov.run_standing(uuid)": {
    "body": "937c93a1d4ea8f71ce3d8101fabb0ff202c0a732c61eacae42e4094af5de87bd",
    "language": "plpgsql",
    "volatility": "v",
    "result": "text",
    "set": false,
    "app": true,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov._mandate_standing(uuid)": {
    "body": "10c1ce47013ec478e401cb6a6290f1b18670c1ed275f1a3aae92ae59fee2ee49",
    "language": "plpgsql",
    "volatility": "s",
    "result": "text",
    "set": false,
    "app": false,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_mandate"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov._ancestors(uuid)": {
    "body": "f4c56081bc3d17b027dd96a79e6ef7c8f0d8c5709084657b300efbe568d2f5a8",
    "language": "sql",
    "volatility": "s",
    "result": "uuid",
    "set": true,
    "app": false,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_mandate"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov._subtree(uuid)": {
    "body": "c4f7b6c24b6b6ed72a186fe480124316340059f3b86a13802807627c5a5539aa",
    "language": "sql",
    "volatility": "s",
    "result": "uuid",
    "set": true,
    "app": false,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_mandate"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov.claim_run(uuid,text,integer,text,uuid)": {
    "body": "d4f6dbf5ad5fd657995ac0b30a1dc7805e18fd5fa60dc54ad00a9e218bf3782f",
    "language": "plpgsql",
    "volatility": "v",
    "result": "record",
    "set": true,
    "app": true,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run",
      "p_worker",
      "p_lease_ms",
      "p_carrier",
      "p_piece",
      "fence",
      "secret"
    ],
    "argumentModes": [
      "i",
      "i",
      "i",
      "i",
      "i",
      "t",
      "t"
    ],
    "allArgumentTypes": [
      "uuid",
      "text",
      "integer",
      "text",
      "uuid",
      "bigint",
      "text"
    ],
    "defaults": 1,
    "defaultExpression": "NULL::uuid"
  },
  "gov._claim(uuid,text,integer)": {
    "body": "49bb5b86466831b8a82965a7ecd3d211a9c300fb1912bdd98cba92f7698cfbde",
    "language": "plpgsql",
    "volatility": "v",
    "result": "record",
    "set": false,
    "app": false,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run",
      "p_worker",
      "p_lease_ms",
      "fence",
      "secret"
    ],
    "argumentModes": [
      "i",
      "i",
      "i",
      "o",
      "o"
    ],
    "allArgumentTypes": [
      "uuid",
      "text",
      "integer",
      "bigint",
      "text"
    ],
    "defaults": 0,
    "defaultExpression": null
  },
  "gov._claimable(uuid,boolean)": {
    "body": "2642ab8b5ed28259075f9323a4274c2541c5b16a109e75db3dce778a25d0059f",
    "language": "sql",
    "volatility": "s",
    "result": "boolean",
    "set": false,
    "app": false,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run",
      "p_from_queue"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov._stop_run(uuid,text,text)": {
    "body": "1b0f5d47ff3b7845342b56da159e5b86306818bf52061ab0240215c0f1f91891",
    "language": "plpgsql",
    "volatility": "v",
    "result": "void",
    "set": false,
    "app": false,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run",
      "p_status",
      "p_reason"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "sec.t_run_marks()": {
    "body": "d58abc189feff54fe185ec33d505b07820fb34c4d6719c6169cdcac52290660d",
    "language": "plpgsql",
    "volatility": "v",
    "result": "trigger",
    "set": false,
    "app": false,
    "ownerExecute": true,
    "definer": false,
    "parallel": "u",
    "argumentNames": null,
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "sec.t_run_piece()": {
    "body": "f8f8c1485df755f4f1b7adb6383b6560130b0c606e848eacf63a014512a57c1f",
    "language": "plpgsql",
    "volatility": "v",
    "result": "trigger",
    "set": false,
    "app": false,
    "ownerExecute": true,
    "definer": false,
    "parallel": "u",
    "argumentNames": null,
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "sec.piece_binding(uuid)": {
    "body": "4a91484d9e88994a0e32d549c68968f35ee628db53305120ca472f0c6754cb22",
    "language": "sql",
    "volatility": "s",
    "result": "text",
    "set": false,
    "app": false,
    "ownerExecute": true,
    "definer": false,
    "parallel": "u",
    "argumentNames": [
      "p_piece"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "sec.task_visible(uuid)": {
    "body": "ac91e1420bb9c906ed8aebdb68a07466dfbb27f0f7b80b92f374f76c7d59d1b4",
    "language": "sql",
    "volatility": "s",
    "result": "boolean",
    "set": false,
    "app": true,
    "ownerExecute": true,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_task"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "sec.viewer()": {
    "body": "ec7fec6028bcba67a0147b09759be0f6ac70aeacc96997cd4787c5056e9044ed",
    "language": "sql",
    "volatility": "s",
    "result": "uuid",
    "set": false,
    "app": true,
    "ownerExecute": true,
    "definer": false,
    "parallel": "u",
    "argumentNames": null,
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "sec.acting_for()": {
    "body": "f31cad116fdd2e5d82e8054b5552cfed06efd8b32153be5b89619ced78f3bff2",
    "language": "sql",
    "volatility": "s",
    "result": "uuid",
    "set": false,
    "app": true,
    "ownerExecute": true,
    "definer": true,
    "parallel": "u",
    "argumentNames": null,
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov.finish_run(uuid,bigint,text)": {
    "body": "1922359a81a6aeac56a63f4497977ebbd8df3f96bc9ba91c87df2cfadc3f3a84",
    "language": "plpgsql",
    "volatility": "v",
    "result": "text",
    "set": false,
    "app": true,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run",
      "p_fence",
      "p_outcome"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov.park_run(uuid,bigint)": {
    "body": "f6d2e233043c690544717c64bd239c74d0b7b30f48e2cb7b9ea9d806043a1515",
    "language": "plpgsql",
    "volatility": "v",
    "result": "text",
    "set": false,
    "app": true,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run",
      "p_fence"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  },
  "gov._wake_run(uuid)": {
    "body": "cba54bcc8b39002fc033d37a59f088ae7ef4484ad99f480729cb651e22cd0784",
    "language": "plpgsql",
    "volatility": "v",
    "result": "void",
    "set": false,
    "app": false,
    "ownerExecute": false,
    "definer": true,
    "parallel": "u",
    "argumentNames": [
      "p_run"
    ],
    "argumentModes": null,
    "allArgumentTypes": null,
    "defaults": 0,
    "defaultExpression": null
  }
} as const;
export const MATERIAL_ENFORCEMENT_TRIGGER='episodes.material_source_receipt';
interface FunctionRow {signature:string;kind:string;support:boolean;sqlBody:boolean;body:string|null;language:string;owner:string;definer:boolean;volatility:string;result:string;set:boolean;strict:boolean;leakproof:boolean;parallel:string;configuration:string[]|null;defaults:number;defaultExpression:string|null;argumentNames:string[]|null;argumentModes:string[]|null;allArgumentTypes:string[]|null;variadic:boolean;acl:{grantee:string;grantor:string;privilege:string;grantable:boolean}[]|null;appExecutes:boolean;operatorExecutes:boolean;ownerExecutes:boolean}
interface TriggerRow {name:string;enabled:string;type:number;function:string;constraint:boolean;constraintType:string;constraintTable:boolean;constraintDeferrable:boolean;constraintDeferred:boolean;deferrable:boolean;deferred:boolean;validated:boolean;predicate:string|null;arguments:number;argumentBytes:number;updateColumns:number;oldTable:string|null;newTable:string|null;constraintRelation:string|null;parent:number}
interface PostureRow {safe:boolean}
export interface MaterialEnforcementCatalogue {functions:FunctionRow[];triggers:TriggerRow[];posture:PostureRow[]}

/** This profile covers only the additive enforcement and carrier functions/posture. The original
 * complete guard and journal object/function pins remain required by their owning verifiers. */
export async function inspectMaterialEnforcement(client:pg.ClientBase):Promise<MaterialEnforcementCatalogue>{
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
  ORDER BY wanted.signature COLLATE "C"`,[Object.keys(FUNCTIONS)])).rows;
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
  ) AS safe`,[['backbone_owner','backbone_gov','backbone_app','backbone_operator'],Object.keys(FUNCTIONS).map(name=>name.split('(')[0]),Object.keys(FUNCTIONS)])).rows;
 return {functions,triggers,posture};
}

/** Exact extra profile only; callers must additionally attest the unchanged prerequisite pins.
 * No target name or history row alone exempts a trigger from the original complete guard hash. */
export function materialEnforcementCatalogueState(installed:MaterialEnforcementCatalogue):'absent'|'enforced'|'unknown'{
 const signatures=Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[];
 if(installed.functions.length!==signatures.length||new Set(installed.functions.map(row=>row.signature)).size!==signatures.length
  ||installed.posture.length!==1||installed.posture[0].safe!==true)return 'unknown';
 const introduced=['gov._material_source_state(uuid)','sec.t_material_episode_source()'];
 for(const signature of signatures.filter(name=>!introduced.includes(name))){
  if(!functionMatches(signature,installed.functions.find(row=>row.signature===signature)))return 'unknown';
 }
 if(introduced.every(name=>installed.functions.find(row=>row.signature===name)?.body===null)&&installed.triggers.length===0)return 'absent';
 if(signatures.some(signature=>!functionMatches(signature,installed.functions.find(row=>row.signature===signature)))||installed.triggers.length!==1)return 'unknown';
 const trigger=installed.triggers[0];
 return trigger.name===MATERIAL_ENFORCEMENT_TRIGGER&&trigger.enabled==='A'&&trigger.type===5
  &&trigger.function==='sec.t_material_episode_source()'&&trigger.constraint===true&&trigger.constraintType==='t'
  &&trigger.constraintTable===true&&trigger.constraintDeferrable===true&&trigger.constraintDeferred===true&&trigger.deferrable===true
  &&trigger.deferred===true&&trigger.validated===true&&trigger.predicate===null&&trigger.arguments===0
  &&trigger.argumentBytes===0&&trigger.updateColumns===0&&trigger.oldTable===null&&trigger.newTable===null
  &&trigger.constraintRelation===null&&trigger.parent===0?'enforced':'unknown';
}
function functionMatches(signature:keyof typeof FUNCTIONS,row:FunctionRow|undefined):boolean{
 const expected=FUNCTIONS[signature];
 if(!row||row.body===null||hash(row.body)!==expected.body||row.kind!=='f'||row.support!==false||row.sqlBody!==false
  ||row.language!==expected.language||row.owner!=='backbone_gov'
  ||row.definer!==expected.definer||row.volatility!==expected.volatility||row.result!==expected.result||row.set!==expected.set
  ||row.strict!==false||row.leakproof!==false||row.parallel!==expected.parallel||row.defaults!==expected.defaults||row.defaultExpression!==expected.defaultExpression||row.variadic!==false
  ||JSON.stringify(row.argumentNames)!==JSON.stringify(expected.argumentNames)
  ||JSON.stringify(row.argumentModes)!==JSON.stringify(expected.argumentModes)
  ||JSON.stringify(row.allArgumentTypes)!==JSON.stringify(expected.allArgumentTypes)
  ||JSON.stringify(row.configuration)!==JSON.stringify(['search_path=pg_catalog'])
  ||row.appExecutes!==expected.app||row.operatorExecutes!==false||row.ownerExecutes!==expected.ownerExecute)return false;
 const grantees=['backbone_gov',...(expected.app?['backbone_app']:[]),...(expected.ownerExecute?['backbone_owner']:[])];
 return Array.isArray(row.acl)&&row.acl.length===grantees.length&&new Set(row.acl.map(acl=>acl.grantee)).size===grantees.length
  &&row.acl.every(acl=>grantees.includes(acl.grantee)&&acl.grantor==='backbone_gov'&&acl.privilege==='EXECUTE'&&acl.grantable===false);
}
export function materialEnforcementCatalogueMatches(installed:MaterialEnforcementCatalogue):boolean{
 return materialEnforcementCatalogueState(installed)==='enforced';
}
