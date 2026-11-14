// Real released-shape compatibility and append-only profile/receipt controls. No live homes.
import pg from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {buildBaseline} from '../src/db/baseline.ts';
import {upgradeMaterialGuard} from '../src/db/material-guard.ts';
import {upgradeMaterialLink} from '../src/db/material-link.ts';
import {upgradeMaterialEnforcement} from '../src/db/material-enforcement.ts';
import {upgradeSignatureLedger,verifySignatureLedger} from '../src/db/signature-ledger.ts';
import {upgradeMaterialClosure,verifyMaterialClosure} from '../src/db/material-closure.ts';
import {upgradeMaterialClosureHardening,materialClosureHardeningStep} from '../src/db/material-closure-hardening.ts';
import {startTestPostgres,type TestPostgres} from '../src/db/testing.ts';
import {closureFixture,type ClosureFixture} from './material-closure-fixture.ts';
let postgres:TestPostgres,c:ClosureFixture;
beforeAll(async()=>{postgres=await startTestPostgres();});
afterAll(async()=>{await postgres?.stop();});
beforeEach(async()=>{c=await closureFixture(postgres,async admin=>{
 const control=new pg.Client({connectionString:postgres.adminUrl('postgres')});await control.connect();
 try{
  await control.query('SELECT pg_advisory_lock(1111573323,1)');
  await admin.query('DROP SCHEMA app,auth,ops,sec,gov,operator,crypto CASCADE');
  const baseline=buildBaseline().sql;await admin.query(baseline);
  for(const install of [upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,upgradeSignatureLedger,upgradeMaterialClosure]){
   const status=await install(admin,baseline);expect(status.state,status.reason).toBe('verified');
  }
 }finally{await control.query('SELECT pg_advisory_unlock(1111573323,1)').catch(()=>{});await control.end();}
});});
afterEach(async()=>{await c?.close();});
const proof=async(id:string)=>(await c.admin.query('SELECT * FROM app.knowledge_candidate_inputs WHERE workspace_id=$1 AND candidate_id=$2',[c.ws,id])).rows[0];
const history=async()=>(await c.admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
const install=async()=>{const status=await upgradeMaterialClosureHardening(c.admin);expect(status.state,status.reason).toBe('verified');};
const shapes=[
 {name:'missing excerpt',extra:{},content:'The date stays open.',promotes:false},
 {name:'null excerpt',extra:{excerpt:null},content:'The date stays open.',promotes:false},
 {name:'numeric literal excerpt',extra:{excerpt:42},content:'42 apples were delivered.',promotes:true},
 {name:'boolean literal excerpt',extra:{excerpt:true},content:'The native literal is true.',promotes:true},
 {name:'array literal excerpt',extra:{excerpt:['word']},content:'The native literal is ["word"].',promotes:true},
 {name:'object literal excerpt',extra:{excerpt:{key:'value'}},content:'The native literal is {"key": "value"}.',promotes:true},
 {name:'extra keys',extra:{excerpt:'date stays open',extra:'Caller words confer no authority'},content:'The date stays open.',promotes:true},
];
describe('hardening preserves released proposal shapes without granting complete lineage',()=>{
 it.each(shapes.flatMap(shape=>['person','run'].map(kind=>({...shape,kind}))))('$kind: $name is captured as unknown; promotion retains its released predicate',async test=>{
  const source=await c.source(test.content),who=test.kind==='run'?c.runActor(await c.run(c.p)):c.actor(c.p);
  const principal=who.run?(await c.admin.query('SELECT agent_id FROM app.runs WHERE workspace_id=$1 AND id=$2',[c.ws,who.run.id])).rows[0].agent_id:c.p;
  const evidence=[{episode:source.episode,...test.extra}];
  const propose=()=>c.one<string>(who,'gov.propose_candidate($1,$2::jsonb,$3,$4)',
   ['A native candidate with a historically supported citation.',JSON.stringify(evidence),principal,'closure']);
  const before=await c.snapshot();
  // Discriminating old/new control: qualified foundation's guard rejects these supported shapes.
  await expect(propose()).rejects.toThrow(/^invalid:/);expect(await c.snapshot()).toEqual(before);
  await install();
  const candidate=await propose(),p=await proof(candidate);
  expect(p.input_manifest.complete).toBe(false);
  expect(p.input_manifest.unknown).toContainEqual(expect.objectContaining({kind:'citation_shape_unsupported',ordinal:'1',episode_id:source.episode}));
  expect(JSON.stringify(p.input_manifest)).not.toContain('Caller words confer no authority');
  expect((await c.admin.query('SELECT status,owner_id,terms_hash FROM app.knowledge_candidates WHERE workspace_id=$1 AND id=$2',[c.ws,candidate])).rows)
   .toEqual([{status:'open',owner_id:null,terms_hash:null}]);
  if(test.promotes){
   const decision=await c.one<string>(who,'gov.request_promotion($1,$2,NULL,NULL)',[candidate,c.owner]);
   const hash=(await c.admin.query('SELECT proposal_hash FROM app.decisions WHERE workspace_id=$1 AND id=$2',[c.ws,decision])).rows[0].proposal_hash;
   await c.one(c.actor(c.owner),"gov.answer_decision($1,$2,'approved','Independent native shape compatibility control')",[decision,hash]);
   expect((await c.admin.query('SELECT id FROM app.knowledge WHERE workspace_id=$1 AND candidate_id=$2',[c.ws,candidate])).rows).toHaveLength(1);
   const receiving=await c.run();expect(await c.recall(receiving)).toEqual([]);
  }else{
   const proposed=await c.snapshot();
   await expect(c.one(who,'gov.request_promotion($1,$2,NULL,NULL)',[candidate,c.owner])).rejects.toThrow(/^not_verbatim:/);
   expect(await c.snapshot()).toEqual(proposed);
   expect((await c.admin.query('SELECT id FROM app.decisions WHERE workspace_id=$1 AND subject_id=$2',[c.ws,candidate])).rows).toEqual([]);
  }
  expect(await proof(candidate)).toEqual(p);
  const closure=await c.one<{state:string}>(c.actor(c.owner),'gov._knowledge_personal_closure_v1($1,$2)',[candidate,c.owner],c.admin);
  expect(closure.state).toBe('unknown');
 });
 it.each([null,42,'not an object',true,[]])('released proposal itself refuses non-object element %j as not_found before capture',async element=>{
  const before=await c.snapshot();
  for(const phase of ['foundation','hardening']){
   if(phase==='hardening')await install();
   const snapshot=await c.snapshot();
   await expect(c.one(c.actor(c.p),'gov.propose_candidate($1,$2::jsonb,$3,$4)',['A supported statement.',JSON.stringify([element]),c.p,'closure'])).rejects.toThrow(/^not_found:/);
   expect(await c.snapshot()).toEqual(snapshot);
  }
  expect((await c.admin.query('SELECT count(*)::integer AS n FROM app.knowledge_candidate_inputs WHERE workspace_id=$1',[c.ws])).rows).toEqual([{n:0}]);
  expect(before.knowledge_candidates).toEqual([]);
 });
});
describe('hardening installs append-only and confirms native catalogue and COMMIT',()=>{
 it('retains foundation proof/receipt/boundary and valid recalled knowledge, preserving OIDs and all historical bytes',async()=>{
  const input=await c.personal();await c.accept(input);const original=await proof(input.candidate),receipts=await history(),before=await c.snapshot();
  const identities=async()=>(await c.admin.query("SELECT oid::text,oid::regprocedure::text AS signature FROM pg_proc WHERE oid IN ('sec.t_candidate_input_capture_v1()'::regprocedure,'gov._candidate_input_manifest_v1(app.knowledge_candidates,bigint)'::regprocedure) ORDER BY 2")).rows;
  const oids=await identities();await install();expect(await identities()).toEqual(oids);expect(await proof(input.candidate)).toEqual(original);expect(await c.snapshot()).toEqual(before);
  expect((await history()).filter(row=>row.version!=='material-closure-hardening-v1')).toEqual(receipts);
  const receiver=await c.run();expect(await c.recall(receiver)).toHaveLength(1);expect((await verifySignatureLedger(c.service)).state).toBe('verified');
  const settled=await c.snapshot(),latest=await history();await install();expect(await c.snapshot()).toEqual(settled);expect(await history()).toEqual(latest);
 });
 it.each(['after-ddl','rollback-tag','lost-commit'])('actual %s refuses success and leaves either original history or confirmed inspection truth',async mode=>{
  const step=materialClosureHardeningStep();expect(step).not.toBeNull();const before=await c.snapshot(),old=await history();
  const client={query:async(sql:string,args?:unknown[])=>{
   if(sql==='COMMIT'){
    if(mode==='rollback-tag')return c.admin.query('ROLLBACK');
    const result=await c.admin.query(sql,args);if(mode==='lost-commit')throw new Error('Synthetic lost acknowledgement');return result;
   }
   const result=await c.admin.query(sql,args);if(sql===step?.sql&&mode==='after-ddl')throw new Error('Synthetic disconnect after native DDL');return result;
  }} as unknown as pg.ClientBase;
  expect((await upgradeMaterialClosureHardening(client)).state).toBe('paused');expect(await c.snapshot()).toEqual(before);
  if(mode==='lost-commit')expect((await history()).filter(row=>row.version!=='material-closure-hardening-v1')).toEqual(old);
  else expect(await history()).toEqual(old);
  expect((await verifyMaterialClosure(c.service)).state).toBe('verified');await install();
 });
 it('does not adopt changed functions under missing or unknown hardening history',async()=>{
  await install();await c.admin.query("DELETE FROM ops.schema_migrations WHERE version='material-closure-hardening-v1'");
  const before=await c.snapshot(),receipts=await history();
  expect((await verifyMaterialClosure(c.service)).state).toBe('paused');expect((await upgradeMaterialClosureHardening(c.admin)).state).toBe('paused');
  expect(await c.snapshot()).toEqual(before);expect(await history()).toEqual(receipts);
 });
 it('retains the independent crypto known-name overload check outside the product namespace inventory',async()=>{
  // Use a body that compiles but introduces an unsupported overload; it is never called.
  const create="CREATE FUNCTION crypto.hmac(integer,integer,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT ''::bytea $$";
  await c.admin.query(create);expect((await verifyMaterialClosure(c.service)).state).toBe('paused');
  await c.admin.query('DROP FUNCTION crypto.hmac(integer,integer,text)');await install();
  await c.admin.query(create);const before=await c.snapshot(),receipts=await history();
  expect((await verifyMaterialClosure(c.service)).state).toBe('paused');expect((await verifySignatureLedger(c.service)).state).toBe('paused');
  expect((await upgradeMaterialClosureHardening(c.admin)).state).toBe('paused');expect(await c.snapshot()).toEqual(before);expect(await history()).toEqual(receipts);
 });
 it('retains complete inherited attestation on hardened history, including an unchanged function ACL',async()=>{
  await install();await c.admin.query('ALTER FUNCTION gov._append(text,text,jsonb,uuid) OWNER TO postgres');
  const before=await c.snapshot(),receipts=await history();expect((await verifyMaterialClosure(c.service)).state).toBe('paused');expect((await verifySignatureLedger(c.service)).state).toBe('paused');
  expect((await upgradeMaterialClosureHardening(c.admin)).state).toBe('paused');expect(await c.snapshot()).toEqual(before);expect(await history()).toEqual(receipts);
 });
});
