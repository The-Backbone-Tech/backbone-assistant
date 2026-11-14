// Every boundary must roll back the entire identity cohort and its receipts.
// Exercise the real owned installer on a populated 0.1.0 database, with no invented receipts.
import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {dirname,join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {assertHomeWriteAdmission} from '@backbone-next/kernel/home-lock';
import {startTestPostgres} from '../src/db/testing.ts';
import {openPersonalDatabase} from '../src/db/personal.ts';
import {buildBaseline} from '../src/db/baseline.ts';
import {IDENTITY_HARDENING_RELEASES} from '../src/db/identity-hardening-source.ts';
import {MATERIAL_CLOSURE_RELEASE as identity} from '../src/db/identity-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as work} from '../src/db/identity-work-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as roles} from '../src/db/identity-role-revocation-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as resource} from '../src/db/identity-resource-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as admission} from '../src/db/identity-admission-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as guarantees} from '../src/db/identity-guarantees-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as platform} from '../src/db/identity-platform-release.generated.ts';

// A physical cluster is needed by the owned installer. Vitest isolates this
// file; only fixture startup bypasses the runner's shared, already-current template.
async function previousCore(){
 const shared=process.env.BACKBONE_TEST_PG;
 try{delete process.env.BACKBONE_TEST_PG;return await startTestPostgres({unqualifiedIdentityBaseline:true});}
 finally{if(shared===undefined)delete process.env.BACKBONE_TEST_PG;else process.env.BACKBONE_TEST_PG=shared;}
}
for(const boundary of [identity,work,roles,resource,admission,guarantees,platform,...IDENTITY_HARDENING_RELEASES])it(`a failure before ${boundary.version} leaves the previous populated data folder working`,async()=>{
 const postgres=await previousCore();await postgres.clone('backbone');
 const client=new pg.Client({connectionString:postgres.adminUrl('backbone')});let mock:ReturnType<typeof vi.spyOn>|undefined;
 try{
  await client.connect();const made=(await client.query("SELECT * FROM operator.create_workspace('Old work','team','Owner',NULL)")).rows[0];
  await client.query("SELECT set_config('backbone.workspace',$1,false),set_config('backbone.principal',$2,false)",[made.workspace_id,made.owner_id]);
  const task=(await client.query("SELECT gov.create_task($1,$1,'Existing conversation',NULL,NULL) AS id",[made.owner_id])).rows[0].id;
  const document=(await client.query("SELECT gov.create_document($1,'Existing draft','Keep these words',NULL) AS id",[task])).rows[0].id;
  const before=(await client.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
  const dir=dirname((await client.query('SHOW data_directory')).rows[0].data_directory as string),url=new URL(postgres.adminUrl('backbone'));
  assertHomeWriteAdmission(dir);writeFileSync(join(dir,'cluster.json'),JSON.stringify({port:Number(url.port)}));
  const passwords={admin:decodeURIComponent(url.password),app:decodeURIComponent(new URL(postgres.appUrl('backbone')).password),operator:decodeURIComponent(new URL(postgres.operatorUrl('backbone')).password)};
  const query=pg.Client.prototype.query;
  mock=vi.spyOn(pg.Client.prototype,'query');
  mock.mockImplementation(function(this:pg.Client,text:unknown,...args:unknown[]){
   if(text===boundary.sql)return Promise.reject(new Error('Injected identity boundary failure'));
   return Reflect.apply(query,this,[text,...args]);
  } as never);
  const opened=await openPersonalDatabase({dir,baselineSql:buildBaseline().sql,allowIdentityUpgrade:true,
   // This Core atomicity fixture trusts an app backup hook; portable export is
   // separately exercised by the populated Host upgrade tests.
   beforeIdentityUpgrade:async()=>join(dir,'atomicity-fixture-copy'),passwords:{read:async()=>passwords,write:async()=>{throw new Error('No password change');}}});
  mock.mockRestore();mock=undefined;
  const canCreate=await (async()=>{const created=(await client.query("SELECT gov.create_task($1,$1,'Still works',NULL,NULL) AS id",[made.owner_id])).rows[0].id;await client.query('SELECT gov.post_message($1,$2,$3)',[created,made.owner_id,'Continue the conversation']);})().then(()=>({ok:true,error:undefined}),error=>({ok:false,error:(error as Error).message}));
  console.info(JSON.stringify({boundary:boundary.version,legacyConversation:canCreate}));
  expect(opened.identityStatus.state).toBe('paused');
  expect(canCreate.ok).toBe(true);
  expect((await client.query('SELECT content FROM app.documents WHERE id=$1',[document])).rows[0].content).toBe('Keep these words');
  expect((await client.query('SELECT requested_by FROM app.tasks WHERE id=$1',[task])).rows[0].requested_by).toBe(made.owner_id);
  expect((await client.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows).toEqual(before);
  await opened.stopIfStarted();
 }finally{mock?.mockRestore();await client.end();await postgres.drop('backbone');await postgres.stop();}
},30000);
