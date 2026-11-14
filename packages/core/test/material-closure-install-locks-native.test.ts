// Real table contention: the installer must abort before heads, leaving native writers alive.
import pg from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {buildBaseline} from '../src/db/baseline.ts';
import {upgradeMaterialGuard} from '../src/db/material-guard.ts';
import {upgradeMaterialLink} from '../src/db/material-link.ts';
import {upgradeMaterialEnforcement} from '../src/db/material-enforcement.ts';
import {upgradeSignatureLedger} from '../src/db/signature-ledger.ts';
import {materialClosureStep,upgradeMaterialClosure} from '../src/db/material-closure.ts';
import {materialClosureHardeningStep,upgradeMaterialClosureHardening} from '../src/db/material-closure-hardening.ts';
import {startTestPostgres,type TestPostgres} from '../src/db/testing.ts';
import {closureFixture,type ClosureFixture} from './material-closure-fixture.ts';
let postgres:TestPostgres,c:ClosureFixture;
beforeAll(async()=>{postgres=await startTestPostgres();});
afterAll(async()=>{await postgres?.stop();});
beforeEach(async()=>{
 c=await closureFixture(postgres,async admin=>{
  const control=new pg.Client({connectionString:postgres.adminUrl('postgres')});await control.connect();
  try{
   await control.query('SELECT pg_advisory_lock(1111573323,1)');
   await admin.query('DROP SCHEMA app,auth,ops,sec,gov,operator,crypto CASCADE');
   const baseline=buildBaseline().sql;await admin.query(baseline);
   for(const upgrade of [upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement,upgradeSignatureLedger]){
    const status=await upgrade(admin,baseline);expect(status.state,status.reason).toBe('verified');
   }
  }finally{await control.query('SELECT pg_advisory_unlock(1111573323,1)').catch(()=>{});await control.end();}
 });
});
afterEach(async()=>{await c?.close();});
const tables=['app.knowledge_candidates','app.ledger','app.runs','app.tasks','app.principals','app.workspaces','app.knowledge'];
describe('closure installer NOWAIT native FK/index prelocks',()=>{
 it.each(tables.flatMap(table=>[['foundation',table],['hardening',table]]))('the %s installer yields to a native writer on %s before holding any head',async(stage,table)=>{
  if(stage==='hardening'){const foundation=await upgradeMaterialClosure(c.admin);expect(foundation.state,foundation.reason).toBe('verified');}
  const install=stage==='foundation'?upgradeMaterialClosure:upgradeMaterialClosureHardening;
  const step=stage==='foundation'?materialClosureStep():materialClosureHardeningStep();expect(step).not.toBeNull();
  const holder=await c.connect('admin'),installer=await c.connect('admin');
  const before=await c.snapshot();const history=(await c.admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
  const events:string[]=[],busyCodes:string[]=[];
  const wrapped={query:async(text:string,args?:unknown[])=>{
   events.push(text);
   try{return await installer.query(text,args);}catch(error){if((error as {code?:string}).code==='55P03')busyCodes.push('55P03');throw error;}
  }} as unknown as pg.ClientBase;
  await holder.query('BEGIN');
  try{
   await holder.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
   const result=await install(wrapped);expect(result.state).toBe('paused');
   expect(busyCodes).toHaveLength(3);expect(events.filter(sql=>sql==='ROLLBACK')).toHaveLength(3);
   expect(events.some(sql=>sql.startsWith('SELECT workspace_id FROM app.ledger_heads')||sql===step?.sql||sql.startsWith('INSERT INTO ops.schema_migrations'))).toBe(false);
   expect((await c.admin.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows).toEqual(history);
   expect(await c.snapshot()).toEqual(before);
   // This is the native lock-order concern: a writer owning the referenced table can still
   // take its workspace head, without a deadlock victim or installer-induced lock wait.
   await holder.query("SET LOCAL lock_timeout='500ms'");
   await holder.query("SELECT set_config('backbone.workspace',$1,true),set_config('backbone.principal',$2,true)",[c.ws,c.owner]);
   await holder.query('SELECT gov._lock_workspace()');
   expect((await holder.query('SELECT 1 AS alive')).rows).toEqual([{alive:1}]);
  }finally{await holder.query('ROLLBACK');}
  const settled=await install(installer);expect(settled.state,settled.reason).toBe('verified');
  expect((await c.admin.query('SELECT count(*)::integer AS n FROM ops.schema_migrations WHERE version=$1',[stage==='foundation'?'material-closure-foundation-v1':'material-closure-hardening-v1'])).rows).toEqual([{n:1}]);
 });
});
