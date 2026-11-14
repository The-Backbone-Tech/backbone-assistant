import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {openPersonalDatabase,PersonalReadRefusal} from '@backbone/core/db';
import {baseline,nativeHome} from './readonly-native-fixtures.ts';

test('a writable open lets PostgreSQL recover an EPERM stale postmaster PID',async t=>{
 const f=await nativeHome(t),pid=join(f.home,'pg','data','postmaster.pid');
 // PID 1 belongs to the system, not this disposable home. Model the platform's EPERM
 // result deterministically in Node; the real PostgreSQL process adjudicates its file.
 writeFileSync(pid,`1\n${join(f.home,'pg','data')}\n`);
 const kill=process.kill;let observations=0;
 t.mock.method(process,'kill',function(id:number,signal?:number|string){
  if(id===1&&signal===0){observations++;throw Object.assign(new Error('synthetic foreign process'),{code:'EPERM'});}
  return Reflect.apply(kill,process,[id,signal]);
 });
 let db:Awaited<ReturnType<typeof openPersonalDatabase>>|undefined;
 try{db=await openPersonalDatabase({dir:join(f.home,'pg'),baselineSql:baseline,passwords:f.vault.passwords()});assert.ok(observations>0);assert.ok(existsSync(pid));assert.notEqual(readFileSync(pid,'utf8').split('\n')[0],'1');}
 finally{await db?.stopIfStarted();if(existsSync(pid)&&readFileSync(pid,'utf8').split('\n')[0]==='1')rmSync(pid);}
});
for(const readOnly of [false,true])test(`a live same-user PID refusal identifies the preserved file (readOnly=${readOnly})`,async t=>{
 const f=await nativeHome(t),pid=join(f.home,'pg','data','postmaster.pid'),bytes=`${process.pid}\n${join(f.home,'pg','data')}\n`;
 writeFileSync(pid,bytes);
 try{await assert.rejects(openPersonalDatabase({dir:join(f.home,'pg'),baselineSql:baseline,passwords:f.vault.passwords(),readOnly}),error=>{
  assert.ok(error instanceof PersonalReadRefusal);assert.equal(error.code,'server-identity');assert.ok(error.message.includes('pg/data/postmaster.pid'));return true;
 });
 assert.equal(readFileSync(pid,'utf8'),bytes);
 }finally{rmSync(pid,{force:true});}
});
