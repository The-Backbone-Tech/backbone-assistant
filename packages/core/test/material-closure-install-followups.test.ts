// Protocol negatives complement, rather than replace, real NOWAIT lock-contention controls.
import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/db/material-closure-profile.ts',()=>({
 verifyMaterialClosureCatalogue:vi.fn(async()=>({state:'verified',reason:'Synthetic profile.'})),
 verifyMaterialClosurePrerequisite:vi.fn(async()=>({state:'verified',reason:'Synthetic prerequisite.'})),
}));
vi.mock('../src/db/signature-ledger.ts',()=>({verifySignatureLedger:vi.fn(async()=>({state:'verified',reason:'Synthetic signature.'}))}));
import {upgradeMaterialClosure} from '../src/db/material-closure.ts';
import {CORE_SCHEMA_UPGRADES} from '../src/db/schema-migrations.ts';
const referenced=['app.ledger','app.runs','app.tasks','app.principals','app.workspaces','app.knowledge'];
function fixture(busyDependencies=false){
 const events:string[]=[];
 const closureIndex=CORE_SCHEMA_UPGRADES.findIndex(s=>s.version==='material-closure-foundation-v1');
 const client={query:async(sql:string)=>{
  events.push(sql);
  if(sql.includes("current_setting('server_version_num')"))return {rows:[{version:180000}]};
  if(sql.startsWith('SELECT rolsuper'))return {rows:[{installer:true}]};
  if(sql.includes("current_setting('transaction_isolation')"))return {rows:[{isolation:'read committed'}]};
  if(sql.startsWith('SELECT version,checksum'))return {rows:[{version:'baseline',checksum:'a'.repeat(64)},...CORE_SCHEMA_UPGRADES.slice(0,closureIndex)]};
  if(sql.startsWith('SELECT singleton FROM ops.installation'))return {rows:[{singleton:true}]};
  if(sql.startsWith('LOCK TABLE')&&sql.includes('app.ledger')&&busyDependencies)throw Object.assign(new Error('Synthetic referenced-table contention'),{code:'55P03'});
  if(sql.startsWith('SELECT workspace_id FROM app.ledger_heads'))return {rows:[]};
  return {rows:[],command:sql==='COMMIT'?'COMMIT':undefined};
 }};
 return {client:client as never,events};
}
describe('closure installer prelocks every referenced table',()=>{
 it('takes all referenced FK/index locks NOWAIT after the candidate table and before heads or DDL',async()=>{
  const f=fixture();expect((await upgradeMaterialClosure(f.client)).state).toBe('verified');
  const mutex=f.events.findIndex(s=>s.startsWith('SELECT singleton FROM ops.installation'));
  const candidate=f.events.findIndex(s=>s.startsWith('LOCK TABLE app.knowledge_candidates'));
  const dependencies=f.events.findIndex(s=>s.startsWith('LOCK TABLE')&&referenced.every(table=>new RegExp(`${table.replace('.','\\.')}[ ,]`).test(s)));
  const head=f.events.findIndex(s=>s.startsWith('SELECT workspace_id FROM app.ledger_heads'));
  const ddl=f.events.findIndex(s=>s.includes('CREATE TABLE app.knowledge_candidate_inputs'));
  expect(candidate).toBeGreaterThan(mutex);expect(dependencies).toBeGreaterThan(candidate);
  expect(head).toBeGreaterThan(dependencies);expect(ddl).toBeGreaterThan(head);
  expect(f.events[dependencies]).toContain('IN SHARE ROW EXCLUSIVE MODE NOWAIT');
 });
 it('busy referenced tables roll back each bounded attempt without reaching any head, DDL or receipt',async()=>{
  const f=fixture(true);expect((await upgradeMaterialClosure(f.client)).state).toBe('paused');
  expect(f.events.filter(s=>s==='BEGIN ISOLATION LEVEL READ COMMITTED')).toHaveLength(3);
  expect(f.events.filter(s=>s==='ROLLBACK')).toHaveLength(3);
  expect(f.events.some(s=>s.startsWith('SELECT workspace_id FROM app.ledger_heads')||s.includes('CREATE TABLE app.knowledge_candidate_inputs')||s.startsWith('INSERT INTO ops.schema_migrations'))).toBe(false);
  expect(f.events.at(-1)).toBe('ROLLBACK');
 });
});
