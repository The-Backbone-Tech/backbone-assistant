// Protocol controls are not substitutes for the real native interleavings.
import {describe,it,expect,vi} from 'vitest';
vi.mock('../src/db/material-closure-profile.ts',()=>({
 verifyMaterialClosureCatalogue:vi.fn(async()=>({state:'verified',reason:'Synthetic profile only.'})),verifyMaterialClosurePrerequisite:vi.fn(async()=>({state:'verified',reason:'Synthetic profile only.'})),
}));
vi.mock('../src/db/signature-ledger.ts',()=>({verifySignatureLedger:vi.fn(async()=>({state:'verified',reason:'Synthetic prerequisite only.'}))}));
import {upgradeMaterialClosure} from '../src/db/material-closure.ts';
import {CORE_SCHEMA_UPGRADES} from '../src/db/schema-migrations.ts';
import {verifyMaterialClosureCatalogue,verifyMaterialClosurePrerequisite} from '../src/db/material-closure-profile.ts';
function fixture(options:{busy?:boolean;commit?:string;lostCommit?:boolean;isolation?:string;current?:boolean}={}){
 const events:{sql:string;args?:unknown[]}[]=[];
 const history=[{version:'baseline',checksum:'5'.repeat(64)},...CORE_SCHEMA_UPGRADES.slice(0,CORE_SCHEMA_UPGRADES.findIndex(s=>s.version==='material-closure-foundation-v1')+(options.current?1:0))];
 const client={query:async(sql:string,args?:unknown[])=>{
  events.push({sql,args});
  if(sql.includes("current_setting('server_version_num')"))return {rows:[{version:180000}]};
  if(sql.startsWith('SELECT rolsuper'))return {rows:[{installer:true}]};
  if(sql.includes("current_setting('transaction_isolation')"))return {rows:[{isolation:options.isolation??'read committed'}]};
  if(sql.startsWith('SELECT version,checksum'))return {rows:history};
  if(sql.startsWith('SELECT singleton FROM ops.installation'))return {rows:[{singleton:true}]};
  if(sql.startsWith('SELECT workspace_id FROM app.ledger_heads')){
   if(options.busy)throw Object.assign(new Error('Synthetic busy head'),{code:'55P03'});
   return {rows:[{workspace_id:'11111111-1111-4111-8111-111111111111'}]};
  }
  if(sql.includes('count(*)')&&sql.includes('knowledge.dependencies_enabled'))return {rows:[{count:'0'}]};
  if(sql==='COMMIT'&&options.lostCommit)throw new Error('Synthetic lost COMMIT reply with private data');
  return {rows:[],command:sql==='COMMIT'?(options.commit??'COMMIT'):undefined};
 }};
 return {client:client as never,events};
}
describe('closure installer atomic bounded protocol (fake driver only)',()=>{
 it('takes the attested mutex then candidate table then heads, before DDL and receipt',async()=>{
  const f=fixture();expect((await upgradeMaterialClosure(f.client)).state).toBe('verified');
  const sql=f.events.map(e=>e.sql),mutex=sql.findIndex(s=>s.startsWith('SELECT singleton FROM ops.installation')),
   table=sql.findIndex(s=>s.startsWith('LOCK TABLE app.knowledge_candidates')),head=sql.findIndex(s=>s.startsWith('SELECT workspace_id FROM app.ledger_heads')),
   ddl=sql.findIndex(s=>s.includes('CREATE OR REPLACE FUNCTION gov._material_source_state')),
   receipt=sql.findIndex(s=>s.startsWith('INSERT INTO ops.schema_migrations'));
  expect(mutex).toBeGreaterThan(0);expect(table).toBeGreaterThan(mutex);expect(head).toBeGreaterThan(table);
  expect(ddl).toBeGreaterThan(head);expect(receipt).toBeGreaterThan(ddl);expect(sql.at(-1)).toBe('COMMIT');
  expect(sql[head]).toContain('NOWAIT');expect(sql.some(s=>/lock_timeout/.test(s)&&/statement_timeout/.test(s))).toBe(true);
 });
 it('rolls back and releases locks before each bounded retry',async()=>{
  const f=fixture({busy:true});expect((await upgradeMaterialClosure(f.client)).state).toBe('paused');
  const sql=f.events.map(e=>e.sql);expect(sql.filter(s=>s==='ROLLBACK')).toHaveLength(3);
  expect(sql.filter(s=>s==='BEGIN ISOLATION LEVEL READ COMMITTED')).toHaveLength(3);
  expect(sql.some(s=>s.startsWith('INSERT INTO ops.schema_migrations')||s.includes('CREATE OR REPLACE FUNCTION'))).toBe(false);
  expect(sql.at(-1)).toBe('ROLLBACK');
 });
 for(const options of [{commit:'ROLLBACK'},{lostCommit:true},{isolation:'repeatable read'}])it(`never reports success for ${JSON.stringify(options)}`,async()=>{
  const f=fixture(options);const result=await upgradeMaterialClosure(f.client);expect(result.state).toBe('paused');
  expect(result.reason).not.toContain('private data');expect(f.events.at(-1)?.sql).toBe('ROLLBACK');
 });
 it('does not repair a changed prerequisite',async()=>{
  vi.mocked(verifyMaterialClosurePrerequisite).mockResolvedValueOnce({state:'paused',reason:'Synthetic changed prerequisite.'});
  const f=fixture();expect((await upgradeMaterialClosure(f.client)).state).toBe('paused');
  expect(f.events.some(e=>e.sql.startsWith('LOCK TABLE')||e.sql.includes('CREATE OR REPLACE FUNCTION'))).toBe(false);
 });
 it('current history inspects the new profile without replaying DDL or old prerequisites',async()=>{
  const f=fixture({current:true});expect((await upgradeMaterialClosure(f.client)).state).toBe('verified');
  expect(f.events.some(e=>e.sql.startsWith('LOCK TABLE')||e.sql.includes('CREATE OR REPLACE FUNCTION')||e.sql.startsWith('INSERT INTO ops.schema_migrations'))).toBe(false);
  expect(verifyMaterialClosureCatalogue).toHaveBeenCalled();
 });
});
