import { waitFor } from '../../../scripts/lib/test-hang.ts';
// Frozen released baseline plus every released additive prefix; disposable homes only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import pg from 'pg';
import {buildBaseline,upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,
 upgradeSignatureLedger,verifySignatureLedger,verifyMaterialGuard,verifyMaterialLink,verifyMaterialEnforcement,signatureLedgerStep} from '@backbone/core/db';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {CORE_SCHEMA_UPGRADES} from '../../core/src/db/schema-migrations.ts';
import {CoreLink} from '../src/composition/core.ts';
import {freshHome} from './helpers.ts';
import {legacyCoreDatabase} from './fixtures/legacy-core.ts';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ConnectorService} from '../src/connectors/service.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
import {freshDir} from './helpers.ts';
const legacy=JSON.parse(readFileSync(new URL('./fixtures/material-guard-legacy.json',import.meta.url),'utf8')).sqlLines.join('\n')+'\n';
const baseline=buildBaseline().sql;
const prerequisites=[upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement];
// These controls deliberately stop at A1c: the later closure changes material definitions
// and has separate owned-open/current-history controls. Keep the released prefix explicit.
const signatureHistory=CORE_SCHEMA_UPGRADES.slice(0,CORE_SCHEMA_UPGRADES.findIndex(step=>step.version==='connector-signature-ledger-v1')+1);
for(const prefix of [0,1,2,3])test(`released baseline with ${prefix} additive steps upgrades without altering old answers or released profiles`,async t=>{
 const home=freshHome(),admin=await legacyCoreDatabase(dataHomeAdminUrl(home),legacy);t.after(()=>admin.end());
 const link=await CoreLink.open({home});t.after(()=>link.close());
 for(const install of prerequisites.slice(0,prefix))assert.equal((await install(admin,baseline)).state,'verified');
 const id=randomUUID(),note='Synthetic free-text note from a released caller';
 await admin.query("INSERT INTO app.decisions(workspace_id,id,subject_kind,subject_id,proposer_id,checker_kind,checker_id,reason,proposal_hash) VALUES($1,$2,'elevation',$3,$4,'person',$5,'fixture','old-hash')",[link.id.workspace,id,randomUUID(),link.id.agent,link.id.person]);
 assert.equal(await link.call(link.person(),"SELECT gov.answer_decision($1,$2,$3,$4)",[id,'old-hash','rejected',note]),'rejected');
 const before=(await admin.query("SELECT * FROM app.ledger WHERE subject=$1 AND entry_type='decision.answered'",[id])).rows;
 assert.equal(before[0].payload.basis,undefined);
 assert.equal(await link.call(link.person(),'SELECT gov.ledger_words_match($1,$2,$3)',[before[0].seq,'note',note]),true);
 for(const install of prerequisites)assert.equal((await install(admin,baseline)).state,'verified');
 const installed=await upgradeSignatureLedger(admin,baseline);assert.equal(installed.state,'verified',installed.reason);
 for(const verify of [verifyMaterialGuard,verifyMaterialLink,verifyMaterialEnforcement,verifySignatureLedger])assert.equal((await verify(admin)).state,'verified');
 assert.deepEqual((await admin.query("SELECT * FROM app.ledger WHERE subject=$1 AND entry_type='decision.answered'",[id])).rows,before);
 assert.deepEqual(await link.call(link.person(),'SELECT gov.decision_answer_basis($1)',[id]),{method:'basis_not_recorded'});
 assert.equal((await link.read<{note:string}>(link.person(),'SELECT note FROM app.decisions WHERE id=$1',[id])).rows[0].note,note);
 // Same released ABI after the boundary retains exact behavior and still carries no JSON basis.
 const later=randomUUID();await admin.query("INSERT INTO app.decisions(workspace_id,id,subject_kind,subject_id,proposer_id,checker_kind,checker_id,reason,proposal_hash) VALUES($1,$2,'elevation',$3,$4,'person',$5,'fixture','new-hash')",[link.id.workspace,later,randomUUID(),link.id.agent,link.id.person]);
 assert.equal(await link.call(link.person(),"SELECT gov.answer_decision($1,$2,$3,$4)",[later,'new-hash','rejected',note]),'rejected');
 assert.equal((await admin.query("SELECT payload FROM app.ledger WHERE subject=$1 AND entry_type='decision.answered'",[later])).rows[0].payload.basis,undefined);
 assert.deepEqual(await link.call(link.person(),'SELECT gov.decision_answer_basis($1)',[later]),{method:'person'});
 assert.equal(await link.call(link.person(),'SELECT gov.verify_ledger()'),null);
 const history=(await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 assert.deepEqual(history.slice().map(r=>r.version),['baseline',...signatureHistory.map(s=>s.version)].sort());
 assert.equal((await upgradeSignatureLedger(admin,baseline)).state,'verified');assert.deepEqual((await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM app.ledger WHERE workspace_id=$1 AND entry_type='decision.basis_enabled'",[link.id.workspace])).rows[0].n,1);
});
test('new step refuses changed source, incomplete objects and tampering; released answer mutation still fails attestation',async t=>{
 assert.ok(signatureLedgerStep(baseline));assert.deepEqual(signatureLedgerStep(baseline.replace(/\n/g,'\r\n')),signatureLedgerStep(baseline));
 assert.equal(signatureLedgerStep(baseline.replace("s.ended_at IS NOT NULL","false")),null);
 const home=freshHome(),admin=new pg.Client({connectionString:dataHomeAdminUrl(home)});await admin.connect();t.after(()=>admin.end());
 for(const mutation of [
  "ALTER FUNCTION gov.answer_decision_with_basis(uuid,text,text,text,jsonb) SECURITY INVOKER",
  "GRANT UPDATE ON app.connector_signatures TO backbone_app",
  "ALTER TABLE app.connector_signatures NO FORCE ROW LEVEL SECURITY",
  "ALTER TABLE app.connector_signatures DISABLE TRIGGER keep",
  "ALTER TABLE app.connector_signatures DROP CONSTRAINT connector_signatures_pkey",
 ]){
  await admin.query('BEGIN');try{await admin.query(mutation);assert.equal((await verifySignatureLedger(admin)).state,'paused',mutation);}finally{await admin.query('ROLLBACK');}
 }
 await admin.query('BEGIN');try{
 const sql=(await admin.query("SELECT pg_get_functiondef('gov.answer_decision(uuid,text,text,text)'::regprocedure) AS sql")).rows[0].sql;
 await admin.query(sql.replace('RETURN p_verdict;','RETURN NULL;'));
 assert.equal((await verifyMaterialGuard(admin)).state,'paused');assert.equal((await verifySignatureLedger(admin)).state,'paused');
 }finally{await admin.query('ROLLBACK');}
 assert.equal((await verifySignatureLedger(admin)).state,'verified');
});

test('a workspace created while the step waits is included in the old-answer boundary',async t=>{
 const home=freshHome(),url=dataHomeAdminUrl(home),admin=await legacyCoreDatabase(url,legacy);t.after(()=>admin.end());
 for(const install of prerequisites)assert.equal((await install(admin,baseline)).state,'verified');
 const creator=new pg.Client({connectionString:url}),installer=new pg.Client({connectionString:url});await creator.connect();await installer.connect();
 t.after(()=>creator.end());t.after(()=>installer.end());
 await creator.query('BEGIN');
 const made=(await creator.query("SELECT * FROM operator.create_workspace('Concurrent','personal','Owner','synthetic@example.test')")).rows[0];
 const decision=randomUUID();
 await creator.query("INSERT INTO app.decisions(workspace_id,id,subject_kind,subject_id,proposer_id,checker_kind,checker_id,reason,proposal_hash) VALUES($1,$2,'elevation',$3,$4,'person',$5,'fixture','old-hash')",[made.workspace_id,decision,randomUUID(),made.system_id,made.owner_id]);
 await creator.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[made.workspace_id,made.owner_id]);
 await creator.query('SET LOCAL ROLE backbone_app');
 await creator.query("SELECT gov.answer_decision($1,'old-hash','rejected','old concurrent note')",[decision]);
 const pid=(await installer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const installing=upgradeSignatureLedger(installer,baseline);
 let blocked=false;
 await waitFor(async()=>{
  blocked=(await admin.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked;
  if(!blocked)await new Promise(r=>setTimeout(r,10));
 return !!blocked;},'signature-ledger-upgrade: SQL lock observation',{diagnostic:()=>`blocked=${blocked}`});
 assert.equal(blocked,true,'installation waits for the creator before scanning workspace boundaries');
 await creator.query('COMMIT');const result=await installing;assert.equal(result.state,'verified',result.reason);
 await creator.query('BEGIN');
 try{
 await creator.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[made.workspace_id,made.owner_id]);
 assert.deepEqual((await creator.query('SELECT gov.decision_answer_basis($1) AS basis',[decision])).rows[0].basis,{method:'basis_not_recorded'});
 assert.equal((await creator.query('SELECT gov.verify_ledger() AS broken')).rows[0].broken,null);
 }finally{await creator.query('ROLLBACK');}
});

test('a missing step receipt never appends another boundary over existing answers',async t=>{
 const home=freshHome(),admin=await legacyCoreDatabase(dataHomeAdminUrl(home),legacy);t.after(()=>admin.end());
 const link=await CoreLink.open({home});t.after(()=>link.close());
 // Exercise the historical A1c recovery branch on its actual released prefix, before closure.
 // The owned A1c installer supplies the real old-answer boundary; do not invent a marker or
 // leave a later receipt whose non-prefix history would refuse before this branch is reached.
 for(const install of [...prerequisites,upgradeSignatureLedger]){const status=await install(admin,baseline);assert.equal(status.state,'verified',status.reason);}
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM app.ledger WHERE entry_type='decision.basis_enabled'")).rows[0].n,1);
 await admin.query("DELETE FROM ops.schema_migrations WHERE version='connector-signature-ledger-v1'");
 const before=(await admin.query('SELECT seq,hash FROM app.ledger ORDER BY seq')).rows;
 const history=(await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 const result=await upgradeSignatureLedger(admin,baseline);assert.equal(result.state,'paused');assert.match(result.reason,/boundary exists without/);
 assert.deepEqual((await admin.query('SELECT seq,hash FROM app.ledger ORDER BY seq')).rows,before);
 assert.deepEqual((await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);
});

test('a missing A1c receipt in closure history is refused without appending a boundary or repairing history',async t=>{
 const home=freshHome(),link=await CoreLink.open({home});t.after(()=>link.close());
 const admin=new pg.Client({connectionString:dataHomeAdminUrl(home)});await admin.connect();t.after(()=>admin.end());
 assert.deepEqual((await admin.query('SELECT version FROM ops.schema_migrations ORDER BY version')).rows.map(row=>row.version),['baseline',...CORE_SCHEMA_UPGRADES.map(step=>step.version)].sort());
 await admin.query("DELETE FROM ops.schema_migrations WHERE version='connector-signature-ledger-v1'");
 const before=(await admin.query('SELECT seq,hash FROM app.ledger ORDER BY seq')).rows;
 const history=(await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
 const result=await upgradeSignatureLedger(admin,baseline);assert.equal(result.state,'paused');assert.match(result.reason,/history is incomplete/);
 assert.equal((await verifySignatureLedger(admin)).state,'paused');
 assert.deepEqual((await admin.query('SELECT seq,hash FROM app.ledger ORDER BY seq')).rows,before);
 assert.deepEqual((await admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,history);
});

for(const existing of [false,true])test(`released home with existing signatures=${existing} retires file-only authority after the step`,async t=>{
 const home=freshHome(),admin=await legacyCoreDatabase(dataHomeAdminUrl(home),legacy);t.after(()=>admin.end());
 const link=await CoreLink.open({home});t.after(()=>link.close());
 if(existing){mkdirSync(join(home,'connectors'),{recursive:true});writeFileSync(join(home,'connectors','mcp.json'),JSON.stringify({servers:{'claude-code:old':{enabled:true,egress:true,fingerprint:'legacy',tools:{draft_note:{enabled:true,definition:'a'.repeat(64),listed:{name:'draft_note',description:'Synthetic',inputSchema:{},annotations:{}},standing:{id:randomUUID(),definition:'a'.repeat(64),seal:'legacy',home,at:'2026-11-01T00:00:00Z'}}}}},held:[]}));}
 for(const install of [...prerequisites,upgradeSignatureLedger]){const result=await install(admin,baseline);assert.equal(result.state,'verified',result.reason);}
 const service=new ConnectorService({home,env:()=>defaultToolEnv({HOME:freshDir('old-signature-person-'),PATH:process.env.PATH}),link:async()=>link});t.after(()=>service.close());await service.ready();
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM app.connector_signatures")).rows[0].n,0,'no grant is invented for an old file UUID');
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM app.ledger WHERE entry_type='signature.given'")).rows[0].n,0);
 assert.equal(service.list().held.length,0);
 if(existing){const file=JSON.parse(readFileSync(join(home,'connectors','mcp.json'),'utf8'));assert.equal(file.servers['claude-code:old'].tools.draft_note.standing,undefined);}
});
