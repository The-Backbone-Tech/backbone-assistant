// A real owned Host data folder, populated through its public methods while only
// the 0.1.0 definitions are installed. No synthetic replacement for Host state.
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtempSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {createHost,hostClosed,removeDataHome,type Host} from '../src/composition/host.ts';
import {plaintextKeys} from '../src/keys/vault.ts';
import {homeSecrets} from '../src/testing/keys.ts';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {MATERIAL_CLOSURE_RELEASE as identity} from '../../core/src/db/identity-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as work} from '../../core/src/db/identity-work-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as recovery} from '../../core/src/db/identity-device-recovery-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as piece} from '../../core/src/db/identity-piece-admission-release.generated.ts';
import {inspectExport} from '../src/composition/backup.ts';
import {value,idle,settings} from './helpers.ts';
import {CredentialStore} from '../src/credentials/store.ts';
import {Vault} from '../src/keys/vault.ts';

const now=Date.UTC(2026,10,13,8);
const options={allowIdentityUpgrade:true,keys:plaintextKeys(),schedules:{now:()=>now,tickMs:60_000}};
async function stop(host:Host,home:string){host.close();await hostClosed(home);}
async function database(home:string){const client=new pg.Client({connectionString:dataHomeAdminUrl(home,(await homeSecrets(home)).passwords)});await client.connect();return client;}
function workFiles(home:string){
 const files:Record<string,string>={};
 const walk=(rel:string)=>{if(!existsSync(join(home,rel)))return;for(const entry of readdirSync(join(home,rel),{withFileTypes:true})){const next=join(rel,entry.name);if(entry.isDirectory())walk(next);else files[next]=readFileSync(join(home,next)).toString('base64');}};
 for(const dir of ['threads','drafts','memory','material'])walk(dir);
 for(const file of ['projects.json','proactivity.json'])if(existsSync(join(home,file)))files[file]=readFileSync(join(home,file)).toString('base64');
 return files;
}
async function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'backbone-team-upgrade-'));
 const query=pg.Client.prototype.query;
 const mock=t.mock.method(pg.Client.prototype,'query',function(this:pg.Client,text:unknown,...args:unknown[]){if(text===identity.sql)return Promise.reject(new Error('Hold at 0.1.0 definitions'));return Reflect.apply(query,this,[text,...args]);} as never);
 const host=createHost({home,...options});
 try{
  const project=value(await host.call('projects.create',{name:'Existing project',kind:'folder'}));
  const sent=value(await host.call('turns.send',{projectId:project.id,text:'Write a brief about existing work',attachments:[],settings,clientKey:'old-turn'}));
  const thread=await idle(host,sent.threadId);assert.equal(thread.turns.length,1);
  const document=(await host.call('material.list',{projectId:project.id})).find(entry=>entry.name==='brief.md');assert.ok(document);
  value(await host.call('material.save',{id:document.id,baseVersion:1,text:'The second document version survives.'}));
  const draft=value(await host.call('drafts.put',{key:`composer:${sent.threadId}`,text:'Keep this composer draft.',meta:{threadId:sent.threadId},clientKey:'old-draft',baseRevision:0}));
  const schedule=value(await host.call('schedules.create',{projectId:project.id,text:'Scheduled existing work',when:'every hour',settings:{...settings,permission:'full'},clientKey:'old-schedule'}));
  value(await host.call('memory.instructions.put',{scope:'person',text:'Remember the existing project.'}));
  value(await host.call('memory.put',{topic:'work',text:'The existing project uses a two-page report.'}));
  const db=await database(home);let beforeHistory:unknown;
  try{beforeHistory=(await db.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows;
   assert.deepEqual((beforeHistory as {version:string}[]).map(row=>row.version),['baseline','connector-signature-ledger-v1','material-closure-foundation-v1','material-closure-hardening-v1','material-source-enforcement-v1','material-source-guard-v1','material-source-link-v1']);
   assert.equal((await db.query("SELECT 1 FROM ops.schema_migrations WHERE version LIKE 'identity-%'")).rowCount,0);}finally{await db.end();}
  await stop(host,home);mock.mock.restore();
  return {home,project,threadId:sent.threadId,document,draft,schedule,beforeHistory,before:workFiles(home)};
 }catch(error){mock.mock.restore();await stop(host,home);await removeDataHome(home);throw error;}
}
for(const boundary of [undefined,work,piece,'commit-reply-lost'] as const)test(`populated 0.1.0 Host ${typeof boundary==='object'?'rolls back at '+boundary.version:boundary??'upgrades with every kind of work intact'}`,async t=>{
 const f=await fixture(t),query=pg.Client.prototype.query,committing=new WeakSet<pg.Client>();
 const mock=boundary?t.mock.method(pg.Client.prototype,'query',function(this:pg.Client,text:unknown,...args:unknown[]){if(typeof boundary==='object'&&text===boundary.sql)return Promise.reject(new Error('Injected later boundary'));
  if(boundary==='commit-reply-lost'&&text===recovery.sql)committing.add(this);
  if(boundary==='commit-reply-lost'&&text==='COMMIT'&&committing.delete(this))return Reflect.apply(query,this,[text,...args]).then(()=>{throw new Error('Commit acknowledgement lost');});
  return Reflect.apply(query,this,[text,...args]);} as never):undefined;
 const host=createHost({home:f.home,...options});
 try{
  assert.ok((await host.call('projects.list',{})).some(project=>project.id===f.project.id));
  const thread=value(await host.call('threads.get',{id:f.threadId}));assert.equal(thread.turns.length,1);assert.match(thread.turns[0].user.text,/existing work/);
  assert.deepEqual(await host.call('drafts.get',{key:`composer:${f.threadId}`}),f.draft,'the saved draft is still the composer state');
  const schedule=(await host.call('schedules.get',{})).schedules.find(s=>s.id===f.schedule.id);assert.ok(schedule);assert.deepEqual(schedule,f.schedule);assert.ok(Date.parse(schedule.nextAt!)>now);assert.equal(schedule.paused,false);
  const memory=await host.call('memory.get',{});assert.match(memory.instructions.person,/Remember the existing project/);
  assert.ok(memory.entries.some(entry=>entry.text==='The existing project uses a two-page report.'));
  assert.equal(value(await host.call('material.read',{id:f.document.id,version:2})).text,'The second document version survives.');
  assert.ok(value(await host.call('material.read',{id:f.document.id,version:1})).text);
  const status=await host.deviceRecoveryStatus();
  const backups=readdirSync(join(f.home,'backups'));assert.equal(backups.length,1);
  const copy=join(f.home,'backups',backups[0]),exported=inspectExport(copy).summary;assert.equal(exported.counts.versions,2);assert.equal(exported.counts.threads,1);
  const after=await database(f.home);
  try{
   const owner=JSON.parse(readFileSync(join(f.home,'core.json'),'utf8')).person;
   if(typeof boundary==='object'){
    assert.match(status.notice!,/^Nothing was changed\. A copy of your data from before the update is at /);assert.ok(status.notice!.includes(copy));
    assert.deepEqual((await after.query('SELECT version,checksum FROM ops.schema_migrations ORDER BY version')).rows,f.beforeHistory);
    assert.deepEqual(workFiles(f.home),f.before,'all original work bytes are unchanged');
   }else{
    const me=value(await host.call('identity.get',{}));assert.equal(me.person.id,owner);assert.equal(me.person.role,'owner');
    assert.equal((await after.query('SELECT owner_id FROM app.identity_projects WHERE project_id=$1',[f.project.id])).rows[0].owner_id,owner);
    assert.equal((await after.query('SELECT requested_by FROM app.tasks WHERE id=$1',[JSON.parse(readFileSync(join(f.home,'threads',`${f.threadId}.json`),'utf8')).task])).rows[0].requested_by,owner);
   }
  }finally{await after.end();}
 }finally{mock?.mock.restore();await stop(host,f.home);await removeDataHome(f.home);}
});

for(const refusal of ['scrubbing','space'] as const)test(`a ${refusal} export refusal prevents every identity artifact and leaves the populated Host usable`,async t=>{
 const f=await fixture(t),vault=await Vault.open(f.home),credentials=new CredentialStore(f.home,()=>vault.masterKey());
 if(refusal==='scrubbing')await credentials.put('abc','Too short to scrub reliably');
 const space=refusal==='space'?t.mock.method(CredentialStore.prototype,'values',async()=>{throw Object.assign(new Error('No space'),{code:'ENOSPC'});}):undefined;
 const host=createHost({home:f.home,...options});
 try{
  assert.ok((await host.call('projects.list',{})).some(project=>project.id===f.project.id));
  assert.match((await host.deviceRecoveryStatus()).notice!,refusal==='space'?/update did not start.*Nothing was changed.*disk space/:/update did not start.*Nothing was changed.*export refused/);
  const db=await database(f.home);try{assert.equal((await db.query("SELECT 1 FROM ops.schema_migrations WHERE version LIKE 'identity-%'")).rowCount,0);}finally{await db.end();}
  assert.deepEqual(workFiles(f.home),f.before);
 }finally{space?.mock.restore();await stop(host,f.home);await removeDataHome(f.home);}
});

for(const client of ['app-without-device-record','headless'] as const)test(`${client} refuses an existing data folder that needs the Team update`,async t=>{
 const f=await fixture(t),query=pg.Client.prototype.query;let observed:{version:string;checksum:string}[]=[];
 // Observe the real final history reads before the refused opener stops the
 // server it started; opening another writable client would attempt the update.
 const reads=t.mock.method(pg.Client.prototype,'query',function(this:pg.Client,text:unknown,...args:unknown[]){
  const result=Reflect.apply(query,this,[text,...args]);
  if(typeof text==='string'&&/^SELECT version,checksum FROM (ops.schema_migrations|app.material_guard_history)/.test(text))return result.then((row:{rows:{version:string;checksum:string}[]})=>{observed=row.rows;return row;});
  return result;
 } as never);
 try{
  if(client==='app-without-device-record'){
   (await import('node:fs')).unlinkSync(join(f.home,'core.json'));
   const host=createHost({home:f.home,...options});
   try{await assert.rejects(host.call('projects.list',{}),/no device identity|core record/);}finally{await stop(host,f.home);}
  }else{
   const {CoreLink}=await import('../src/composition/core.ts');
   let opened:Awaited<ReturnType<typeof CoreLink.open>>|undefined;
   try{await assert.rejects(async()=>{opened=await CoreLink.open({home:f.home,keys:options.keys});},/Open the app once to update this data folder\./);}finally{await opened?.release();}
  }
  assert.ok(observed.length,'the refusing opener inspected real history');
  assert.deepEqual([...observed].sort((a,b)=>a.version.localeCompare(b.version)),f.beforeHistory,'refusal installed no identity step');
 }finally{reads.mock.restore();await removeDataHome(f.home);}
});

test('a repeatedly failed cohort reuses a verified recovery copy until its source work changes',async t=>{
 const f=await fixture(t),query=pg.Client.prototype.query;
 const mock=t.mock.method(pg.Client.prototype,'query',function(this:pg.Client,text:unknown,...args:unknown[]){if(text===work.sql)return Promise.reject(new Error('Persistent failed cohort'));return Reflect.apply(query,this,[text,...args]);} as never);
 try{
  for(let count=0;count<3;count++){
   const host=createHost({home:f.home,...options});
   try{
    await host.call('projects.list',{});
    assert.equal(readdirSync(join(f.home,'backups')).filter(name=>name.startsWith('before-team-')).length,count<2?1:2);
    if(count===1)value(await host.call('material.save',{id:f.document.id,baseVersion:2,text:'Changed after the first recovery copy.'}));
   }finally{await stop(host,f.home);}
  }
 }finally{mock.mock.restore();await removeDataHome(f.home);}
});
