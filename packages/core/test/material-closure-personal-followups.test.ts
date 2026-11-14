// Exercise the real owned-open control flow with fake installer outcomes, never a live home.
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
const fake=vi.hoisted(()=>({data:'',history:[{version:'baseline',checksum:'a'.repeat(64)}],after:{state:'verified',reason:'Current inspected legacy message/web profile.'},inspectionThrows:false}));
vi.mock('pg',()=>({default:{Client:class{async connect(){}async end(){}async query(sql:string){
 if(sql==='SHOW data_directory')return {rows:[{data_directory:fake.data}]};
 return sql.startsWith('SELECT version,checksum')?{rows:fake.history}:{rows:[]};
}}}}));
vi.mock('@backbone-next/kernel/cluster',()=>({binaries:()=>({initdb:'unused',postgres:'unused'}),freePort:async()=>54321,ready:async()=>{}}));
vi.mock('@backbone-next/kernel/home-lock',()=>({assertHomeWriteAdmission:()=>{}}));
vi.mock('../src/db/material-guard.ts',()=>({CORE_SCHEMA_LOCK:'SELECT 1',upgradeMaterialGuard:vi.fn(async()=>({state:'verified',reason:'Old guard installed.'}))}));
vi.mock('../src/db/material-link.ts',()=>({upgradeMaterialLink:vi.fn(async()=>({state:'verified',reason:'Old link installed.'}))}));
vi.mock('../src/db/material-enforcement.ts',()=>({upgradeMaterialEnforcement:vi.fn(async()=>({state:'verified',reason:'Old enforcement installed.'}))}));
vi.mock('../src/db/signature-ledger.ts',()=>({upgradeSignatureLedger:vi.fn(async()=>({state:'verified',reason:'Signature installed.'}))}));
vi.mock('../src/db/material-closure.ts',()=>({upgradeMaterialClosure:vi.fn(async()=>({state:'paused',reason:'Synthetic closure failure or lost COMMIT acknowledgement.'}))}));
vi.mock('../src/db/material-closure-hardening.ts',()=>({upgradeMaterialClosureHardening:vi.fn(async()=>({state:'paused',reason:'Synthetic hardening failure.'}))}));
vi.mock('../src/db/material-status.ts',()=>({verifyMaterialStatuses:vi.fn(async()=>{
 if(fake.inspectionThrows)throw new Error('Synthetic unavailable actual history');
 return {materialGuard:{...fake.after},materialLink:{...fake.after},materialEnforcement:{...fake.after}};
})}));
import {openPersonalDatabase} from '../src/db/personal.ts';
import {verifyMaterialStatuses} from '../src/db/material-status.ts';
import {upgradeMaterialClosure} from '../src/db/material-closure.ts';
import {upgradeMaterialClosureHardening} from '../src/db/material-closure-hardening.ts';
import {CORE_SCHEMA_UPGRADES} from '../src/db/schema-migrations.ts';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});vi.clearAllMocks();fake.inspectionThrows=false;fake.history=[{version:'baseline',checksum:'a'.repeat(64)}];});
async function open(admitted=true){
 const dir=mkdtempSync(join(tmpdir(),'core-owned-closure-status-'));dirs.push(dir);
 // Model the authenticated server's actual home; keep the real identity check in the open path.
 fake.data=join(dir,'data');
 mkdirSync(join(dir,'data'));writeFileSync(join(dir,'data','PG_VERSION'),'18');writeFileSync(join(dir,'cluster.json'),JSON.stringify({port:54321}));
 // An existing home is updated only on the app main-process path: admitted, with a recovery copy.
 return openPersonalDatabase({dir,baselineSql:'',...(admitted?{allowIdentityUpgrade:true,beforeIdentityUpgrade:async()=>join(dir,'recovery-copy')}:{}),passwords:{read:async()=>({admin:'a'.repeat(36),app:'b'.repeat(36),operator:'c'.repeat(36)}),write:async()=>{}}});
}
describe('owned open selects actual profiles after optional closure failure',()=>{
 it('preserves independently verified legacy message/web statuses when closure failed without a receipt',async()=>{
  fake.after={state:'verified',reason:'Current inspected legacy message/web profile.'};
  const home=await open();
  for(const status of [home.materialGuard,home.materialLink,home.materialEnforcement])expect(status).toEqual(fake.after);
  expect(verifyMaterialStatuses).toHaveBeenCalledTimes(1);await home.stop();
 });
 it('uses the actual committed profile after an unknown COMMIT outcome rather than stale legacy statuses',async()=>{
  fake.after={state:'verified',reason:'Actual committed closure profile verified after lost acknowledgement.'};
  const home=await open();
  for(const status of [home.materialGuard,home.materialLink,home.materialEnforcement])expect(status).toEqual(fake.after);
  expect(verifyMaterialStatuses).toHaveBeenCalledTimes(1);await home.stop();
 });
 it('propagates a paused actual closure profile instead of preserving old verified admissions',async()=>{
  fake.after={state:'paused',reason:'Actual committed closure definitions were changed.'};
  const home=await open();
  for(const status of [home.materialGuard,home.materialLink,home.materialEnforcement])expect(status).toEqual(fake.after);
  expect(verifyMaterialStatuses).toHaveBeenCalledTimes(1);await home.stop();
 });
 it('a qualified closure home keeps its verified v1 status when optional hardening fails',async()=>{
  const index=CORE_SCHEMA_UPGRADES.findIndex(step=>step.version==='material-closure-foundation-v1');
  fake.history=[{version:'baseline',checksum:'a'.repeat(64)},...CORE_SCHEMA_UPGRADES.slice(0,index+1)];
  fake.after={state:'verified',reason:'Actual unchanged qualified closure profile.'};const home=await open();
  expect(upgradeMaterialClosureHardening).toHaveBeenCalledTimes(1);expect(upgradeMaterialClosure).not.toHaveBeenCalled();
  for(const status of [home.materialGuard,home.materialLink,home.materialEnforcement])expect(status).toEqual(fake.after);
  expect(verifyMaterialStatuses).toHaveBeenCalledTimes(1);await home.stop();
 });
 it('newly verified closure proceeds to hardening and still inspects actual profiles',async()=>{
  vi.mocked(upgradeMaterialClosure).mockResolvedValueOnce({state:'verified',reason:'Synthetic confirmed closure.'});
  fake.after={state:'verified',reason:'Current inspected closure after hardening attempt.'};const home=await open();
  expect(upgradeMaterialClosureHardening).toHaveBeenCalledTimes(1);expect(verifyMaterialStatuses).toHaveBeenCalledTimes(1);
  for(const status of [home.materialGuard,home.materialLink,home.materialEnforcement])expect(status).toEqual(fake.after);await home.stop();
 });
 it('an unavailable final inspector cannot turn a headless refusal to update into an open',async()=>{
  fake.inspectionThrows=true;
  await expect(open(false)).rejects.toThrow(/Open the app once to update this data folder/);
  expect(upgradeMaterialClosure).not.toHaveBeenCalled();
 });
 it('an unavailable final inspector never leaves stale optimistic statuses',async()=>{
  fake.inspectionThrows=true;const home=await open();
  for(const status of [home.materialGuard,home.materialLink,home.materialEnforcement])expect(status.state).toBe('paused');
  expect(verifyMaterialStatuses).toHaveBeenCalledTimes(1);await home.stop();
 });
});
