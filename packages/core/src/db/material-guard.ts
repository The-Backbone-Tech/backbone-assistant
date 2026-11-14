// One frozen upgrade for promotion, recall and run visibility. Source SQL remains in schema/;
// compiled fingerprints attest the installed definitions on every open, including external homes.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import {hasMaterialClosure,verifyMaterialClosure} from './material-closure-status.ts';
import {inspectMaterialEnforcement,materialEnforcementCatalogueMatches,MATERIAL_ENFORCEMENT_TRIGGER} from './material-enforcement-catalogue.ts';
import {CORE_SCHEMA_LOCK,CORE_SCHEMA_UPGRADES,baselineObject,readSchemaHistory,schemaHistoryMatches} from './schema-migrations.ts';
export {CORE_SCHEMA_LOCK} from './schema-migrations.ts';

export const MATERIAL_GUARD_VERSION = CORE_SCHEMA_UPGRADES[0].version;
export interface MaterialGuardStatus { state: 'verified' | 'paused'; reason: string }
const paused = (reason: string): MaterialGuardStatus => ({ state: 'paused', reason });
const verified = (): MaterialGuardStatus => ({ state: 'verified', reason: 'Knowledge source checks verified; material and connected-source knowledge remains withheld.' });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// The exact function families, rather than a whole-baseline checksum. Unrelated schema evolution
// is outside this capability's fingerprint. These values change only with independent Kernel review.
const FUNCTION_PINS: Record<string, { legacy: string | null; guarded: string }> = {
  "gov._append(text,text,jsonb,uuid)": {
    "legacy": "bd2229fa2ad637710dca59f091fe8398f3dda10312507400d460b9562a6467ce",
    "guarded": "bd2229fa2ad637710dca59f091fe8398f3dda10312507400d460b9562a6467ce"
  },
  "gov._promote(uuid,uuid,uuid)": {
    "legacy": "7609a021d90554b886164d6961e57b820e3477d44eb0abe609636a3fb7763b13",
    "guarded": "14eb32c4e67b4c40adc49723b738e88972f8d91d8aab76f72bc3e65cecd2561e"
  },
  "gov._promotion_sources_allowed(uuid)": {
    "legacy": null,
    "guarded": "ad9a9464fe56f25ab1cb056afe89ac1ea6088ae2586e0f28b552d43e2bc9e6b2"
  },
  "gov._settle_decision(uuid,text,uuid,text)": {
    "legacy": "5e5f7eb5de6ec684132de4e8cbed129b9ab3177b5aa14e501d5cd8a51eef666d",
    "guarded": "5e5f7eb5de6ec684132de4e8cbed129b9ab3177b5aa14e501d5cd8a51eef666d"
  },
  "gov.answer_decision(uuid,text,text,text)": {
    "legacy": "0243f9d9d54550660c43a8382f6fdd90ea579f878ca106c902fac77671d8b01c",
    "guarded": "0243f9d9d54550660c43a8382f6fdd90ea579f878ca106c902fac77671d8b01c"
  },
  "gov.claim_next_verification(text,integer)": {
    "legacy": "6967a9f75459c6d202ada4097204287428a2891f81cb80e63b5fe5ce71d7cafb",
    "guarded": "a32f9d5bdc272b5766b27e9131c70f1f5c5f891f602f3c52da29e45bd1802cd9"
  },
  "gov.may_decide(uuid)": {
    "legacy": "ec89e7c2c639e937f584dfd2901bdc8e0c690062c2f779bafca27d8d426c0bd5",
    "guarded": "69e1e760f76e865300050a8b1286a08933dddea7d8dac01835279d18dd8bb466"
  },
  "gov.propose_candidate(text,jsonb,uuid,text)": {
    "legacy": "86ac147b0cf383f464589a8922650fe8ad29cc310f4d0e712e83e15dc3d9ebff",
    "guarded": "86ac147b0cf383f464589a8922650fe8ad29cc310f4d0e712e83e15dc3d9ebff"
  },
  "gov.recall_knowledge(uuid,text[],integer)": {
    "legacy": "d598f7ac4e2aa4658e8ff6cb9e68085164e240d900c2b3129e9373548ea158e2",
    "guarded": "ed7185c90928287beb6a20654521ef54280c2278a7be38232162b8161122dd70"
  },
  "gov.record_server_answer(uuid,uuid,text,text)": {
    "legacy": "0834bfb712bfae9fa4d62b12867be09779572fe54772dd62e5c8f236eca30c87",
    "guarded": "0834bfb712bfae9fa4d62b12867be09779572fe54772dd62e5c8f236eca30c87"
  },
  "gov.record_source(text,text,text,uuid,uuid,uuid,text,uuid)": {
    "legacy": "a1304c87814b01bb2dd19509f4eb89d2ca4b74709566592cb67231fcfef969dd",
    "guarded": "a1304c87814b01bb2dd19509f4eb89d2ca4b74709566592cb67231fcfef969dd"
  },
  "gov.request_promotion(uuid,uuid,timestamp with time zone,timestamp with time zone)": {
    "legacy": "792b29408ba5544d06b047d9c519f4544959a8481407ae8ec9b1d7a17249eccb",
    "guarded": "5e1f686a3eeec77c4101fdacdda7e627e898eb79a9e16e762a0f6197d0fa7fad"
  },
  "gov.verifier_answer(uuid,text,text)": {
    "legacy": "d7655f3e93c8b484a940b71f90089aa1bf9d32a04ee1d430326a2a189b8dac8d",
    "guarded": "d7655f3e93c8b484a940b71f90089aa1bf9d32a04ee1d430326a2a189b8dac8d"
  },
  "sec.candidate_visible(uuid)": {
    "legacy": "eea327c52f3dcc8b85a52bedea8e6f9aa198d87a2625e97ac99aa3910d838d5b",
    "guarded": "eea327c52f3dcc8b85a52bedea8e6f9aa198d87a2625e97ac99aa3910d838d5b"
  },
  "sec.decision_visible(uuid)": {
    "legacy": "7d7c9b7d99de7a89d25e63d32bbf5e9a50727c476acee09bc5d220521fe11fd3",
    "guarded": "7d7c9b7d99de7a89d25e63d32bbf5e9a50727c476acee09bc5d220521fe11fd3"
  },
  "sec.t_candidate()": {
    "legacy": "370a8f11c3e0848d5c3ea07b3c503d4f36079467295d303ea95379ebacde3c6d",
    "guarded": "370a8f11c3e0848d5c3ea07b3c503d4f36079467295d303ea95379ebacde3c6d"
  },
  "sec.t_evidence()": {
    "legacy": "d4d7b1ddf6b1cce924cf9129d0869234aa55e9d52c3648c0ba58c5183af9f2f0",
    "guarded": "d4d7b1ddf6b1cce924cf9129d0869234aa55e9d52c3648c0ba58c5183af9f2f0"
  },
  "sec.t_knowledge()": {
    "legacy": "85a2184842ebc2ca0c7c812cfd4d80e6083459e9e8bc2e44aa7afa824ec3c8aa",
    "guarded": "85a2184842ebc2ca0c7c812cfd4d80e6083459e9e8bc2e44aa7afa824ec3c8aa"
  },
  "sec.t_ledger_append_only()": {
    "legacy": "07c8d8fb70f34d5f9925d245ef2ba351ea8c3ae1a1aab852948fe5ff48b5ffe2",
    "guarded": "07c8d8fb70f34d5f9925d245ef2ba351ea8c3ae1a1aab852948fe5ff48b5ffe2"
  },
  "sec.t_material_promotion_guard()": {
    "legacy": null,
    "guarded": "d3b77857de19ca99250970f4b52dcd1ecd29f7bd3c882ee30cf170cef2dcc0e5"
  },
  "sec.t_principal()": {
    "legacy": "81ae4944dc1a2321195e664b24f1d1ec804b037ae0f39e098c11b47c35904414",
    "guarded": "81ae4944dc1a2321195e664b24f1d1ec804b037ae0f39e098c11b47c35904414"
  },
  "sec.t_refuse_truncate()": {
    "legacy": "d2f47eb245401e46569ff535020053c287123860505c09295f863c879fb07048",
    "guarded": "d2f47eb245401e46569ff535020053c287123860505c09295f863c879fb07048"
  },
  "sec.visible_eligible_knowledge_sources()": {
    "legacy": null,
    "guarded": "fb2a5c4aec7bf23f4be9226c9f3482485d8333e9d5ff52dff57f2173745f7175"
  }
};
const OBJECT_PINS = {"legacy":"89b3b798a513c9dd0e4f1db624463d2647d66e409769091b3fd872881ea09d6b","guarded":"2f807badd1fd73ee0ae9ec24ecb3e47ef416531c4b83c443155165d4638f17f0"};
const STATEMENT_PINS: Record<string, string> = {
  "gov/_promotion_sources_allowed.sql": "69afc08cbbb2fea377bf66ed2c2bf12435347a881268aabc8ab3d10d495d7d48",
  "gov/request_promotion.sql": "919c886ce5c384f9265a89f14b1b0eb47994d6bd72f2f56ea6b427be58048994",
  "gov/_promote.sql": "4aae87ce47324cbb04f01701ebb0f9fdff073329832c708c8e6c6981729a8cd3",
  "gov/may_decide.sql": "f8fb5e0f59ae42c1a98cc2d49f15167fc3ba68a7f2b963576661db4ba7e6ef24",
  "gov/claim_next_verification.sql": "d29bc1fd8d14711d4f0467230d24ba66654445be813a9adc6373cbd76946e550",
  "gov/recall_knowledge.sql": "6f8766579886934d68c8d01b65772acd8d38c5bc52a562cf81d0b22dba16d54d",
  "sec/visible_eligible_knowledge_sources.sql": "99b713bbb8a60bad507b86ecab61dfbeb7dedab6dcde4af3cb0a063684144925",
  "sec/t_material_promotion_guard.sql": "3bea8d7747ff3b7d9d250ac87f8a7d482a95663cafc779acc3a0624510605d89",
  "views/eligible_knowledge_sources.sql": "b7898c5b4e0066f186dc0af951137522fd2b905703a199548d5be4e0173c3422",
  "app/material_guard_history.sql": "6ceb17e305f0169016325c5bc8ac272bf8855d2d15fd66a7515749643ad7c85c",
  "knowledge_candidates.readers": "d71edfdd7c00fd236e654690cdbefae196ba0f07c5f8dbd60c99bb4770c2c177",
  "decisions.readers": "008066c348a82ae2dfe97faf982e1ea8a5f7b0e0ecfcb7ce7a595c5c94ca3522",
  "knowledge.readers": "27f51801b952f02379aaca23ac3e5f9e67300119e7d23f3ab0657bb779fd6a4f",
  "episodes_run_sources": "059cbe1d6d0b3eb3aa7b837d5a00897c544579926d4e999eb7f2d82ebd3c3a6a",
  "material_source_guard": "796ec85c1a5b202f6aa9724958ba9e8e50ec42b532df1270d77e319b9ee44375"
};
const STEP_CHECKSUM = CORE_SCHEMA_UPGRADES[0].checksum;

const FUNCTIONS = [
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

/** Catalogue metadata only: no tenant values, credentials, parameter text or app rows. Exported
 * from this module for the disposable qualification harness, not the package's public API. */
export async function inspectMaterialGuard(client: pg.ClientBase) {
  const { rows } = await client.query<{ signature: string; definition: unknown }>(`
    SELECT wanted.signature, jsonb_build_object(
      'definition',pg_catalog.pg_get_functiondef(p.oid),'owner',pg_catalog.pg_get_userbyid(p.proowner),
      'acl',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,pg_catalog.pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee::regrole::text COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable) FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a),
      'appExecutes',pg_catalog.has_function_privilege('backbone_app',p.oid,'EXECUTE')
    ) AS definition
    FROM pg_catalog.unnest($1::text[]) wanted(signature)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(wanted.signature)
    ORDER BY wanted.signature COLLATE "C"`, [FUNCTIONS]);
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

async function definitions(client: pg.ClientBase): Promise<'legacy' | 'guarded' | 'unknown'> {
  const installed = await inspectMaterialGuard(client);
  if (Object.keys(FUNCTION_PINS).length !== FUNCTIONS.length) return 'unknown';
  for (const state of ['guarded', 'legacy'] as const) {
    if (installed.objects === OBJECT_PINS[state] && FUNCTIONS.every(name => installed.functions[name] === FUNCTION_PINS[name]?.[state])) return state;
  }
  // A new trigger is removed only after its complete additive function/trigger/posture profile
  // matches. The remaining entire object family and all released function pins must still match.
  if(FUNCTIONS.every(name=>installed.functions[name]===FUNCTION_PINS[name]?.guarded)
      && materialEnforcementCatalogueMatches(await inspectMaterialEnforcement(client))){
    const extra=installed.objectRows.filter(row=>row.kind==='trigger'&&row.name===MATERIAL_ENFORCEMENT_TRIGGER);
    const original=installed.objectRows.filter(row=>row.kind!=='trigger'||row.name!==MATERIAL_ENFORCEMENT_TRIGGER);
    if(extra.length===1&&hash(JSON.stringify(original))===OBJECT_PINS.guarded)return 'guarded';
  }
  return 'unknown';
}

// Each block comes from the one assembled baseline. Statement hashes refuse changed shipped SQL,
// and the resulting step checksum is compiled separately so external history can be checked too.
const FUNCTION_FILES = [
  'gov/_promotion_sources_allowed.sql', 'gov/request_promotion.sql', 'gov/_promote.sql',
  'gov/may_decide.sql', 'gov/claim_next_verification.sql', 'gov/recall_knowledge.sql',
  'sec/visible_eligible_knowledge_sources.sql', 'sec/t_material_promotion_guard.sql',
];
/** Pure assembly: no schema-folder dependency, second executable SQL copy or caller-selected DDL. */
export function materialGuardStep(baseline: string): { sql: string; checksum: string } | null {
  const source = baseline.replace(/\r\n/g,'\n');
  const statements: Record<string,string> = {};
  for (const file of [...FUNCTION_FILES,'views/eligible_knowledge_sources.sql','app/material_guard_history.sql']) {
    const sql = baselineObject(source,file);
    if (!sql) return null;
    statements[file] = sql;
  }
  for (const table of ['knowledge_candidates','decisions','knowledge']) {
    const sql = baselineObject(source,`app/${table}.sql`);
    const policy = sql?.match(/^CREATE POLICY readers .+;$/m)?.[0];
    if (!policy) return null;
    statements[`${table}.readers`] = policy;
  }
  for (const [key,file,prefix] of [
    ['episodes_run_sources','app/episodes.sql','CREATE INDEX episodes_run_sources '],
    ['material_source_guard','app/knowledge.sql','CREATE TRIGGER material_source_guard '],
  ]) {
    const statement = baselineObject(source,file)?.split('\n').filter(line => line.startsWith(prefix));
    if (statement?.length !== 1) return null;
    statements[key] = statement[0];
  }
  if (Object.keys(statements).length !== Object.keys(STATEMENT_PINS).length ||
      Object.entries(statements).some(([key,sql]) => hash(sql) !== STATEMENT_PINS[key])) return null;
  const sql = [
    'SET LOCAL check_function_bodies=false;', 'SET LOCAL ROLE backbone_gov;',
    ...FUNCTION_FILES.map(file => statements[file].replace('CREATE FUNCTION ','CREATE OR REPLACE FUNCTION ')),
    statements['views/eligible_knowledge_sources.sql'],
    'REVOKE ALL ON FUNCTION gov._promotion_sources_allowed(uuid), sec.t_material_promotion_guard(), sec.visible_eligible_knowledge_sources() FROM PUBLIC, backbone_app;',
    'GRANT EXECUTE ON FUNCTION sec.visible_eligible_knowledge_sources() TO backbone_app;',
    'GRANT EXECUTE ON FUNCTION sec.t_material_promotion_guard(), sec.visible_eligible_knowledge_sources() TO backbone_owner;',
    'RESET ROLE;', 'SET LOCAL ROLE backbone_owner;', statements['app/material_guard_history.sql'],
    ...['knowledge_candidates','decisions','knowledge'].map(table => `DROP POLICY readers ON app.${table};\n${statements[`${table}.readers`]}`),
    statements.episodes_run_sources, statements.material_source_guard, 'RESET ROLE;',
  ].join('\n')+'\n';
  const checksum = hash(sql);
  return checksum === STEP_CHECKSUM ? { sql,checksum } : null;
}

/** External databases receive no DDL. Both the installed definitions and the raw installation
 * history must be readable and recognized; opening the home never turns missing evidence into OK. */
export async function verifyMaterialGuard(client: pg.ClientBase): Promise<MaterialGuardStatus> {
  try {
    const history = await readSchemaHistory(client,'service');
    if (!schemaHistoryMatches(history)) return paused('Core migration history is not recognized by this guard.');
    if(hasMaterialClosure(history))return verifyMaterialClosure(client);
    return await definitions(client) === 'guarded' ? verified() : paused('Core source checks differ from the qualified definitions.');
  } catch { return paused('Core source checks could not be inspected. Promotion and recall are paused.'); }
}

/** Owned installer only. The same target-database advisory lock covers fresh baseline and upgrades.
 * Table locks also bar an old approval already executing from inserting knowledge after commit.
 * A busy crossing retries finitely; unknown or failed upgrades change no app row and pause only
 * this capability. Installation metadata and DDL commit together. */
export async function upgradeMaterialGuard(client: pg.ClientBase, baseline: string): Promise<MaterialGuardStatus> {
  const step = materialGuardStep(baseline);
  if (!step) return paused('The shipped Core guard does not match its reviewed definition pins.');
  for (let attempt=0;attempt<3;attempt++) {
    let transaction=false;
    try {
      const role = await client.query<{installer:boolean}>('SELECT rolsuper AS installer FROM pg_catalog.pg_roles WHERE rolname=current_user');
      if (role.rows[0]?.installer !== true) return paused('Only the owned Core installer may apply this guard.');
      await client.query('BEGIN');transaction=true;
      await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
      await client.query(CORE_SCHEMA_LOCK);
      const history = await readSchemaHistory(client,'installer');
      if (!schemaHistoryMatches(history)) throw new GuardPaused('Core migration history is not recognized by this guard.');
      if(hasMaterialClosure(history)){
        const status=await verifyMaterialClosure(client);
        if(status.state!=='verified')throw new GuardPaused(status.reason);
        if((await client.query('COMMIT')).command!=='COMMIT')throw new GuardPaused('Material closure inspection did not receive a confirmed COMMIT.');
        transaction=false;return status;
      }
      const state=await definitions(client);
      if (state==='unknown' || (state==='legacy' && history.length!==1)) throw new GuardPaused('Core guard definitions and migration history disagree.');
      if (state==='legacy') {
        await client.query('LOCK TABLE app.knowledge_candidates, app.knowledge IN SHARE ROW EXCLUSIVE MODE NOWAIT');
        await client.query(step.sql);
        if (await definitions(client)!=='guarded') throw new GuardPaused('Installed Core guard does not match its reviewed definitions.');
      }
      if (history.length===1) await client.query('INSERT INTO ops.schema_migrations(version,checksum) VALUES($1,$2)',[MATERIAL_GUARD_VERSION,step.checksum]);
      await client.query('COMMIT');transaction=false;
      return verified();
    } catch(error) {
      if (transaction) await client.query('ROLLBACK').catch(()=>{});
      const code=(error as {code?:string}).code;
      if ((code==='55P03'||code==='40P01') && attempt<2) { await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));continue; }
      if (error instanceof GuardPaused) return paused(error.message);
      return paused(code==='55P03'||code==='40P01' ? 'Core guard schema lock was busy; retry on the next open.' : 'Core guard upgrade could not be verified; no upgrade was committed.');
    }
  }
  return paused('Core guard schema lock was busy; retry on the next open.');
}
class GuardPaused extends Error {}
