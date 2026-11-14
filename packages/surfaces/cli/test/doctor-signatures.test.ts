import { observeChild } from '../../../../scripts/lib/test-child.ts';
// Real doctor processes, a deliberately released Core, and a held home's real API line.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {after,test} from 'node:test';
import {removeDataHome} from '@backbone-next/platform/composition';
import {attachApi} from '@backbone-next/platform/doors/api-line';
import {freshDataHome} from '@backbone-next/platform/testing/data-home';
import {prepareHomeWithoutSignatureStep} from '../../../platform/test/fixtures/signature-doctor-home.ts';
import {standingSignaturesCheck} from '../src/doctor-signatures.ts';
import type {Api} from '../src/commands.ts';
const main=join(import.meta.dirname,'../src/main.ts'),STEP='connector-signature-ledger-v1';
const person=mkdtempSync(join(tmpdir(),'doctor-signatures-person-')),homes:string[]=[];
after(async()=>{for(const home of homes)await removeDataHome(home);rmSync(person,{recursive:true,force:true});});
const env=(home:string)=>({...process.env,HOME:person,BACKBONE_HOME:home,BACKBONE_KEYS:'plaintext',BACKBONE_HARNESS:'stub'});
const run=(home:string,args:string[])=>spawnSync(process.execPath,[main,...args],{env:env(home),encoding:'utf8'});
function files(home:string){
 const out:string[]=[];
 function walk(dir:string){for(const e of readdirSync(dir,{withFileTypes:true})){
  const at=join(dir,e.name);if(e.isDirectory())walk(at);else if(e.isFile()){
   const s=statSync(at);out.push(`${relative(home,at)} ${s.mode} ${s.mtimeMs} ${createHash('sha256').update(readFileSync(at)).digest('hex')}`);
  }
 }}walk(home);return out.sort();
}
for(const missing of [false,true])test(`free home doctor refuses pending schema=${missing}, without file or ledger writes`,async t=>{
 const home=freshDataHome('doctor-signatures');homes.push(home);
 const fixture=missing?await prepareHomeWithoutSignatureStep(home):null;t.after(()=>fixture?.close());
 const made=run(home,['projects','create','One']);assert.equal(made.status,0,made.stderr);
 if(missing){
  mkdirSync(join(home,'connectors'),{recursive:true});
  writeFileSync(join(home,'connectors','mcp.json'),JSON.stringify({servers:{gone:{enabled:true,fingerprint:'old',tools:{tool:{enabled:true,definition:'old',listed:{name:'tool',description:'Synthetic',inputSchema:{},annotations:{}},standing:{id:'legacy',definition:'old',home,seal:'old',at:'2026-11-01T00:00:00Z'}}}}},held:[]}));
 }
 const before=files(home),database=await fixture?.snapshot();
 const result=run(home,['doctor','--json']);assert.equal(result.status,missing?1:0,result.stderr+result.stdout);
 const report=JSON.parse(result.stdout),check=report.checks.find((c:{name:string})=>c.name==='standing signatures');
 assert.ok(check);assert.equal(check.status,missing?'warn':'ok');assert.ok(check.detail.includes(STEP));assert.equal(report.ok,!missing);
 if(missing){const open=report.checks.find((c:{name:string})=>c.name==='open');assert.equal(open?.status,'fail');assert.match(open.detail,/writable.*upgrade/i);}
 if(missing){assert.match(check.detail,/cannot be permitted.*permission.*works.*database operator.*administrative installer/);assert.equal(await fixture!.snapshot(),database);}
 assert.deepEqual(files(home),before,'all home files, including external.json and the vault, are unchanged');
});
for(const missing of [false,true])test(`held home doctor reads the step over its API line, missing=${missing}`,async t=>{
 const home=freshDataHome('doctor-signatures-held');homes.push(home);
 const fixture=missing?await prepareHomeWithoutSignatureStep(home):null;t.after(()=>fixture?.close());
 const child=spawn(process.execPath,[join(import.meta.dirname,'line-host.ts')],{env:env(home),stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}});
 let out='',err='';child.stdout.on('data',x=>out+=String(x));child.stderr.on('data',x=>err+=String(x));
 await observeChild(child,'doctor API Host').waitForOutput(/^serving\r?$/m);
 assert.match(out,/serving/,err);
 const line=await attachApi(home);assert.ok(line);
 try{assert.deepEqual(await line.call('core.signatureStatus',{}),{step:STEP,state:missing?'paused':'verified'});}finally{line.close();}
 const {BACKBONE_KEYS:_keys,...noKeys}=env(home);
 const result=await new Promise<{code:number|null;out:string;err:string}>(resolve=>{
  const doctor=spawn(process.execPath,[main,'doctor','--json'],{env:noKeys,stdio:['ignore','pipe','pipe']});let out='',err='';
  doctor.stdout.on('data',x=>out+=String(x));doctor.stderr.on('data',x=>err+=String(x));doctor.once('close',code=>resolve({code,out,err}));
 });
 assert.equal(result.code,0,result.err+result.out);
 const checks=JSON.parse(result.out).checks;assert.match(checks.find((c:{name:string})=>c.name==='holder').detail,/api line/);
 assert.equal(checks.find((c:{name:string})=>c.name==='standing signatures').status,missing?'warn':'ok');
 assert.equal(existsSync(join(home,'cli')),false,'the doctor client never opens/holds the home');
});
test('owned-home warning names the next-open installer and diagnostic details contain no returned or thrown words',async()=>{
 const fake={call:async()=>{throw new Error('PRIVATE_DATABASE_WORDS');}} as unknown as Pick<Api,'call'>;
 const check=await standingSignaturesCheck(fake,false);assert.equal(check.status,'warn');assert.match(check.detail,/could not be inspected.*later version.*next open/);
 const unavailable=await standingSignaturesCheck(null,false);assert.equal(unavailable.status,'warn');assert.match(unavailable.detail,/could not be inspected/);
 const paused={call:async()=>({step:STEP,state:'paused'})} as unknown as Pick<Api,'call'>;
 const missing=await standingSignaturesCheck(paused,false);assert.match(missing.detail,/is missing or not verified/);assert.notEqual(missing.detail,unavailable.detail);
 assert.ok(check.detail.includes(STEP));assert.ok(!check.detail.includes('PRIVATE_DATABASE_WORDS'));
 const forged={call:async()=>({step:'PRIVATE_DATABASE_WORDS',state:'verified',reason:'PRIVATE_DATABASE_WORDS'})} as unknown as Pick<Api,'call'>;
 assert.ok(!(await standingSignaturesCheck(forged,true)).detail.includes('PRIVATE_DATABASE_WORDS'));
});
