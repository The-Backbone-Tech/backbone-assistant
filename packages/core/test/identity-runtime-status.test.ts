import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {expect,it} from 'vitest';
import {assertHomeWriteAdmission} from '@backbone-next/kernel/home-lock';
import {startTestPostgres} from '../src/db/testing.ts';
import {openPersonalDatabase} from '../src/db/personal.ts';
import {buildBaseline} from '../src/db/baseline.ts';
const steps=['identity-v1','identity-work-v1','identity-role-revocation-v1','identity-resource-guard-v1','identity-admission-closure-v1','identity-guarantees-v1','identity-platform-v1','identity-role-closure-v1','identity-piece-admission-v1','identity-lookup-closure-v1','identity-invitation-closure-v1','identity-device-recovery-v1','identity-device-lockout-v1','identity-device-subject-v1','identity-native-turn-v1','identity-device-current-v1'];
for(let count=0;count<=steps.length;count++)it(`external identity runtime requires the entire phase history (${count}/${steps.length})`,async()=>{
 const postgres=await startTestPostgres(),database=`identity_runtime_${randomUUID().replaceAll('-','')}`,dir=mkdtempSync(join(tmpdir(),'identity-runtime-'));await postgres.clone(database);
 const observer=new pg.Client({connectionString:postgres.adminUrl(database)});
 try{await observer.connect();if(count<steps.length)await observer.query('DELETE FROM ops.schema_migrations WHERE version=ANY($1::text[])',[steps.slice(count)]);
  assertHomeWriteAdmission(dir);writeFileSync(join(dir,'external.json'),JSON.stringify({appUrl:postgres.appUrl(database),operatorUrl:postgres.operatorUrl(database)}));
  const opened=await openPersonalDatabase({dir,baselineSql:buildBaseline().sql});
  expect((opened as unknown as {identityStatus?:{state:string}}).identityStatus).toMatchObject({state:count===steps.length?'verified':'paused'});
  await opened.stop();
 }finally{await observer.end();await postgres.drop(database);await postgres.stop();rmSync(dir,{recursive:true,force:true});}
},30_000);

it('an external identity runtime is paused when its final native policy is altered',async()=>{
 const postgres=await startTestPostgres(),database=`identity_runtime_${randomUUID().replaceAll('-','')}`,dir=mkdtempSync(join(tmpdir(),'identity-runtime-'));await postgres.clone(database);
 const observer=new pg.Client({connectionString:postgres.adminUrl(database)});
 try{await observer.connect();await observer.query('DROP POLICY identity_project_crossing_read ON app.runs');
  assertHomeWriteAdmission(dir);writeFileSync(join(dir,'external.json'),JSON.stringify({appUrl:postgres.appUrl(database),operatorUrl:postgres.operatorUrl(database)}));
  const opened=await openPersonalDatabase({dir,baselineSql:buildBaseline().sql});expect((opened as unknown as {identityStatus?:{state:string}}).identityStatus).toMatchObject({state:'paused'});await opened.stop();
 }finally{await observer.end();await postgres.drop(database);await postgres.stop();rmSync(dir,{recursive:true,force:true});}
},30_000);
