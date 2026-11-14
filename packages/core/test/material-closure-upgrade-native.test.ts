// Native installation tests rebuild only a disposable per-test database from frozen bootstrap.
// No product home, outside connection, account, provider or cluster-global privilege mutation.
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {buildBaseline} from '../src/db/baseline.ts';
import {upgradeMaterialGuard} from '../src/db/material-guard.ts';
import {upgradeMaterialLink} from '../src/db/material-link.ts';
import {upgradeMaterialEnforcement} from '../src/db/material-enforcement.ts';
import {upgradeSignatureLedger,verifySignatureLedger} from '../src/db/signature-ledger.ts';
import {materialClosureStep,upgradeMaterialClosure,verifyMaterialClosure,MATERIAL_CLOSURE_VERSION} from '../src/db/material-closure.ts';
import {CORE_SCHEMA_UPGRADES} from '../src/db/schema-migrations.ts';
import {enter} from '../src/db/session.ts';
import {startTestPostgres,type TestPostgres} from '../src/db/testing.ts';
import {closureFixture,type ClosureFixture} from './material-closure-fixture.ts';

let postgres:TestPostgres,c:ClosureFixture;
beforeAll(async()=>{postgres=await startTestPostgres();});
afterAll(async()=>{await postgres?.stop();});

async function rebuildHistoricalBaseline(admin:pg.Client,bootstrap:string){
 const control=new pg.Client({connectionString:postgres.adminUrl('postgres')});await control.connect();
 try{
  // Frozen role ALTERs are cluster-global, so use the existing owning lock in postgres.
  await control.query('SELECT pg_advisory_lock(1111573323,1)');
  await admin.query('DROP SCHEMA app,auth,ops,sec,gov,operator,crypto CASCADE');
  await admin.query(bootstrap);
  const baseline=buildBaseline().sql;
  for(const upgrade of [upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,upgradeSignatureLedger]){
   const status=await upgrade(admin,baseline);expect(status.state,`${upgrade.name}: ${status.reason}`).toBe('verified');
  }
 }finally{await control.query('SELECT pg_advisory_unlock(1111573323,1)').catch(()=>{});await control.end();}
}
async function historicalBaseline(admin:pg.Client){await rebuildHistoricalBaseline(admin,buildBaseline().sql);}
beforeEach(async()=>{c=await closureFixture(postgres,historicalBaseline);});
afterEach(async()=>{await c?.close();});
const FOUNDATION_UPGRADES=CORE_SCHEMA_UPGRADES.slice(0,CORE_SCHEMA_UPGRADES.findIndex(s=>s.version===MATERIAL_CLOSURE_VERSION)+1);
const install=()=>upgradeMaterialClosure(c.admin,buildBaseline().sql);
const boundaryRows=async()=>(await c.admin.query("SELECT workspace_id,seq,subject,payload FROM app.ledger WHERE entry_type='knowledge.dependencies_enabled' ORDER BY workspace_id,seq")).rows;
const receiptRows=async()=>(await c.admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
const catalogueCut=async()=>(await c.admin.query(`SELECT
 pg_get_functiondef('gov._create_workspace(text,text,text,text)'::regprocedure) AS factory,
 pg_get_functiondef('gov._material_source_state(uuid)'::regprocedure) AS state,
 to_regclass('app.knowledge_candidate_inputs')::text AS inputs,
 to_regclass('app.knowledge_reads')::text AS reads,
 to_regprocedure('gov.recall_knowledge_traced_v1(uuid,bigint,text[],integer)')::text AS crossing`)).rows;

function nativeFaultClient(client:pg.Client,mode:'after-ddl'|'rollback-tag'|'lost-commit'){
 const sql=materialClosureStep()?.sql;if(!sql)throw new Error('Missing reviewed closure SQL');
 let applied=false,commitAttempt=false;
 const wrapped={query:async(text:string,args?:unknown[])=>{
  if(text==='COMMIT'){
   commitAttempt=true;
   if(mode==='rollback-tag')return client.query('ROLLBACK');
   const committed=await client.query(text,args);
   if(mode==='lost-commit')throw new Error('Synthetic lost COMMIT acknowledgement');
   return committed;
  }
  const result=await client.query(text,args);
  if(text===sql){applied=true;if(mode==='after-ddl')throw new Error('Synthetic disconnect after actual DDL');}
  return result;
 }} as unknown as pg.ClientBase;
 return {wrapped,applied:()=>applied,commitAttempt:()=>commitAttempt};
}

describe('material closure: native fresh/upgrade history and boundary',()=>{
 it('upgrades exact old history atomically, preserves legacy candidate rows and derives their real cut without backfill',async()=>{
  const old=await c.personal('An honest legacy personal declaration has its actual Native cut.');await c.accept(old);
  const oldRow=(await c.admin.query('SELECT * FROM app.knowledge_candidates WHERE workspace_id=$1 AND id=$2',[c.ws,old.candidate])).rows[0];
  expect((await verifyMaterialClosure(c.service)).state).toBe('paused');expect(await boundaryRows()).toEqual([]);
  const identities=async()=>(await c.admin.query("SELECT p.oid::text AS oid,p.oid::regprocedure::text AS signature FROM pg_proc p WHERE p.oid IN ('gov._create_workspace(text,text,text,text)'::regprocedure,'gov._material_source_state(uuid)'::regprocedure) ORDER BY signature")).rows;
  const originalIdentities=await identities();

  expect((await install()).state).toBe('verified');
  expect(await identities()).toEqual(originalIdentities);
  expect(await receiptRows()).toEqual([{version:'baseline',checksum:buildBaseline().checksum},...FOUNDATION_UPGRADES].sort((a,b)=>a.version.localeCompare(b.version)));
  const boundary=await boundaryRows();expect(boundary).toHaveLength(1);expect(boundary[0]).toMatchObject({workspace_id:c.ws,subject:null,payload:{version:MATERIAL_CLOSURE_VERSION}});
  expect((await c.admin.query('SELECT * FROM app.knowledge_candidates WHERE workspace_id=$1 AND id=$2',[c.ws,old.candidate])).rows).toEqual([oldRow]);
  expect((await c.admin.query('SELECT count(*)::integer AS n FROM app.knowledge_candidate_inputs WHERE workspace_id=$1',[c.ws])).rows[0].n).toBe(0);
  const r=await c.run(),rows=await c.recall(r);expect(rows).toHaveLength(1);expect(rows[0].candidate_id).toBe(old.candidate);
  const read=(await c.admin.query('SELECT source_snapshot FROM app.knowledge_reads WHERE workspace_id=$1',[c.ws])).rows[0];
  expect(read.source_snapshot.candidate_closure.basis).toBe('legacy_exact_native_cut');
  expect((await c.admin.query('SELECT count(*)::integer AS n FROM app.knowledge_candidate_inputs WHERE workspace_id=$1',[c.ws])).rows[0].n).toBe(0);
  expect((await verifySignatureLedger(c.service)).state).toBe('verified');expect((await verifyMaterialClosure(c.service)).state).toBe('verified');
 });
 it('an old prepared two-column recall from before installation keeps its ABI and result after the closure commit',async()=>{
  const old=await c.personal('A warmed historical caller keeps the old safe ABI.');await c.accept(old);const r=await c.run();
  const query={name:'closure-preupgrade-recall',text:'SELECT * FROM gov.recall_knowledge($1,$2,100)',values:[r.id,[]]};
  await enter(c.service,c.runActor(r));const before=await c.service.query(query);await c.service.query('COMMIT');
  expect(before.fields.map(field=>field.name)).toEqual(['statement','topic']);expect(before.rows).toHaveLength(1);
  expect((await install()).state).toBe('verified');
  await enter(c.service,c.runActor(r));const after=await c.service.query(query);await c.service.query('COMMIT');
  expect(after.fields.map(field=>field.name)).toEqual(['statement','topic']);expect(after.rows).toEqual(before.rows);
  expect(await c.recall(r)).toHaveLength(1);
 });
 it('upgrades the actual frozen pre-guard 577fb329 legacy source without rewriting its historical baseline receipt',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../platform/test/fixtures/material-guard-legacy.json',import.meta.url),'utf8'));
  const sql=fixture.sqlLines.join('\n')+'\n';
  const legacyChecksum='577fb329991be04ce409785ae92068a6aa3385c87636e67060ae08c0e713033b';
  expect(fixture.sourceCommit).toBe('f9cf2c99321a7f07ab1b0d022aea61aed54b06b4');
  expect(fixture.baselineChecksum).toBe(legacyChecksum);expect(fixture.endsWithNewline).toBe(true);
  expect(fixture.sqlSha256).toBe('fbcbb0b9e635ee23fd121e2962924b0e790af65b84ec2259e9e9eb6798795496');
  expect(createHash('sha256').update(sql).digest('hex')).toBe(fixture.sqlSha256);
  // Replace only this test's cloned database. No fixture SQL, live DB or receipt is rewritten.
  await c.close();c=await closureFixture(postgres,admin=>rebuildHistoricalBaseline(admin,sql));
  const historyBefore=await receiptRows();
  expect(historyBefore).toEqual([{version:'baseline',checksum:legacyChecksum},...FOUNDATION_UPGRADES.filter(step=>step.version!==MATERIAL_CLOSURE_VERSION)].sort((a,b)=>a.version.localeCompare(b.version)));
  const declaration=await c.personal('The frozen legacy source has an honest Native personal declaration.');await c.accept(declaration);
  const status=await install();expect(status.state,status.reason).toBe('verified');
  expect(await receiptRows()).toEqual([{version:'baseline',checksum:legacyChecksum},...FOUNDATION_UPGRADES].sort((a,b)=>a.version.localeCompare(b.version)));
  expect((await verifyMaterialClosure(c.service)).state).toBe('verified');expect((await verifySignatureLedger(c.service)).state).toBe('verified');
  expect((await c.admin.query('SELECT count(*)::integer AS n FROM app.knowledge_candidate_inputs WHERE workspace_id=$1',[c.ws])).rows[0].n).toBe(0);
  const r=await c.run();expect(await c.recall(r)).toHaveLength(1);
  expect((await c.admin.query('SELECT count(*)::integer AS n FROM app.knowledge_candidate_inputs WHERE workspace_id=$1',[c.ws])).rows[0].n).toBe(0);
  expect(await boundaryRows()).toHaveLength(1);
 });
 it('a repeated installer receives the exact profile and appends neither another boundary nor another receipt',async()=>{
  expect((await install()).state).toBe('verified');const before=await c.snapshot(),receipts=await receiptRows(),catalogue=await catalogueCut();
  expect((await install()).state).toBe('verified');expect(await c.snapshot()).toEqual(before);expect(await receiptRows()).toEqual(receipts);expect(await catalogueCut()).toEqual(catalogue);
 });
 it('a checksum-shaped historical baseline receipt grants nothing without the complete exact prerequisite profile',async()=>{
  await c.admin.query("UPDATE ops.schema_migrations SET checksum=repeat('f',64) WHERE version='baseline'");
  expect((await install()).state).toBe('verified');
  expect((await receiptRows()).find(row=>row.version==='baseline')?.checksum).toBe('f'.repeat(64));
  await c.admin.query('ALTER FUNCTION gov._append(text,text,jsonb,uuid) OWNER TO postgres');
  expect((await verifyMaterialClosure(c.service)).state).toBe('paused');
 });
 it('an unknown declared prerequisite receipt refuses before DDL or boundary creation',async()=>{
  await c.admin.query("UPDATE ops.schema_migrations SET checksum=repeat('0',64) WHERE version='connector-signature-ledger-v1'");
  const before=await catalogueCut(),receipts=await receiptRows();expect((await install()).state).toBe('paused');
  expect(await catalogueCut()).toEqual(before);expect(await receiptRows()).toEqual(receipts);expect(await boundaryRows()).toEqual([]);
 });
 it('a valid new profile with its required receipt removed is not repaired or accepted as old history',async()=>{
  expect((await install()).state).toBe('verified');await c.admin.query('DELETE FROM ops.schema_migrations WHERE version=$1',[MATERIAL_CLOSURE_VERSION]);
  const before=await c.snapshot();expect((await install()).state).toBe('paused');expect(await c.snapshot()).toEqual(before);
  expect((await verifyMaterialClosure(c.service)).state).toBe('paused');
 });
});

describe('material closure: actual installer lock owners and atomic failure',()=>{
 it('a head-first caller makes the table-first installer abort cleanly, release its table lock, then retry after the caller commits',async()=>{
  const input=await c.source('An existing caller retains the Native head before candidate insertion.');
  const holder=await c.connect('admin'),installer=await c.connect('admin');
  await enter(holder,c.actor(c.p));await holder.query('SELECT gov._lock_workspace()');
  const started=performance.now(),status=await upgradeMaterialClosure(installer,buildBaseline().sql);
  expect(status.state).toBe('paused');expect(status.reason).toMatch(/busy/);expect(performance.now()-started).toBeLessThan(10000);
  const installerPid=(await installer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  expect((await c.admin.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=$1 AND relation='app.knowledge_candidates'::regclass",[installerPid])).rows[0].n).toBe(0);
  try{
   const candidate=(await holder.query('SELECT gov.propose_candidate($1,$2::jsonb,$3,$4) AS id',[input.statement,JSON.stringify([{episode:input.episode,excerpt:input.statement}]),c.p,'closure'])).rows[0].id;
   expect(candidate).toBeTruthy();expect((await holder.query('COMMIT')).command).toBe('COMMIT');
   expect((await upgradeMaterialClosure(installer,buildBaseline().sql)).state).toBe('verified');expect(await boundaryRows()).toHaveLength(1);
  }finally{await holder.query('ROLLBACK');}
 });
 it('the real workspace factory holds ops.installation and an installation retry includes the newly committed workspace exactly once',async()=>{
  const creator=await c.connect('operator'),installer=await c.connect('admin');
  await creator.query('BEGIN');
  const second=(await creator.query("SELECT * FROM operator.create_workspace('Concurrent factory','team','Second','second@closure.invalid')")).rows[0];
  try{
   const status=await upgradeMaterialClosure(installer,buildBaseline().sql);expect(status.state).toBe('paused');expect(status.reason).toMatch(/busy/);expect(await boundaryRows()).toEqual([]);
   expect((await creator.query('COMMIT')).command).toBe('COMMIT');
   expect((await upgradeMaterialClosure(installer,buildBaseline().sql)).state).toBe('verified');
   expect((await boundaryRows()).map(row=>row.workspace_id).sort()).toEqual([c.ws,second.workspace_id].sort());
   const third=(await creator.query("SELECT * FROM operator.create_workspace('After upgrade','team','Third','third@closure.invalid')")).rows[0];
   expect((await boundaryRows()).map(row=>row.workspace_id).sort()).toEqual([c.ws,second.workspace_id,third.workspace_id].sort());
  }finally{await creator.query('ROLLBACK');}
 });
 it.each(['after-ddl','rollback-tag'] as const)('actual DDL followed by %s leaves no partial object, boundary or receipt',async mode=>{
  const before=await catalogueCut(),rows=await c.snapshot(),receipts=await receiptRows(),fault=nativeFaultClient(c.admin,mode);
  const status=await upgradeMaterialClosure(fault.wrapped,buildBaseline().sql);expect(fault.applied()).toBe(true);expect(status.state).toBe('paused');
  if(mode==='rollback-tag')expect(fault.commitAttempt()).toBe(true);
  const observer=await c.connect('admin');
  expect((await observer.query("SELECT to_regclass('app.knowledge_candidate_inputs')::text AS inputs")).rows).toEqual([{inputs:null}]);
  expect(await catalogueCut()).toEqual(before);expect(await receiptRows()).toEqual(receipts);expect(await c.snapshot()).toEqual(rows);
  expect((await install()).state).toBe('verified');
 });
 it('a lost actual COMMIT reply returns paused; independent history/profile verification recovers without blind replay',async()=>{
  const fault=nativeFaultClient(c.admin,'lost-commit');
  expect((await upgradeMaterialClosure(fault.wrapped,buildBaseline().sql)).state).toBe('paused');expect(fault.applied()).toBe(true);expect(fault.commitAttempt()).toBe(true);
  const observer=await c.connect();expect((await verifyMaterialClosure(observer)).state).toBe('verified');
  const rows=await c.snapshot(),receipts=await receiptRows();expect((await install()).state).toBe('verified');expect(await c.snapshot()).toEqual(rows);expect(await receiptRows()).toEqual(receipts);
 });
});

describe('material closure: complete profile detects additional catalogue drift',()=>{
 it.each([
  ['unchanged carrier ownership','ALTER FUNCTION gov._append(text,text,jsonb,uuid) OWNER TO postgres'],
  ['new helper ownership','ALTER FUNCTION gov._candidate_claim_digest_v1(app.knowledge_candidates) OWNER TO postgres'],
  ['new trigger enablement','ALTER TABLE app.knowledge_candidates DISABLE TRIGGER candidate_input_capture'],
  ['new deferred structure mode','DROP TRIGGER candidate_input_structure ON app.knowledge_candidates; CREATE CONSTRAINT TRIGGER candidate_input_structure AFTER INSERT ON app.knowledge_candidates DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION sec.t_candidate_input_structure(); ALTER TABLE app.knowledge_candidates ENABLE ALWAYS TRIGGER candidate_input_structure'],
  ['new private table access','GRANT SELECT ON app.knowledge_reads TO backbone_app'],
  ['new private table row security','ALTER TABLE app.knowledge_reads NO FORCE ROW LEVEL SECURITY'],
  ['new table column collation','ALTER TABLE app.knowledge_reads ALTER COLUMN source_sha256 TYPE text COLLATE "C"'],
  ['new table column default','ALTER TABLE app.knowledge_reads ALTER COLUMN read_at SET DEFAULT clock_timestamp()'],
  ['new proof snapshot constraint','ALTER TABLE app.knowledge_candidate_inputs DROP CONSTRAINT candidate_inputs_run_snapshot'],
  ['existing knowledge scan index','DROP INDEX app.knowledge_traced_scan'],
  ['same-name overload',"CREATE FUNCTION gov._lock_workspace(integer) RETURNS void LANGUAGE plpgsql AS 'BEGIN RETURN; END;'"],
  ['existing table rewrite rule','CREATE RULE closure_wrong AS ON UPDATE TO app.knowledge DO INSTEAD NOTHING'],
 ] as const)('refuses %s without repairing it',async(_name,mutation)=>{
  expect((await install()).state).toBe('verified');await c.admin.query(mutation);
  expect((await verifyMaterialClosure(c.service)).state).toBe('paused');expect((await install()).state).toBe('paused');
 });
});
