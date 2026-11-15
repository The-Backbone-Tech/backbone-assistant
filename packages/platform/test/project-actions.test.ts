import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { freshDir, freshHome, open, value, idle, settings } from './helpers.ts';
import { serveApiLine,ApiLineProjectBudget } from '../src/composition/api-line.ts';
import { hostClosed } from '../src/composition/host.ts';
import { attachApi } from '../src/doors/api-line.ts';
import { identityProviderFixture } from './identity-provider-fixture.ts';

// Real Host/Core; all projects and people are disposable fixtures.
test('device owner renames, archives and restores without changing chats, files or sharing',async()=>{
  const {host,home}=open();
  const project=value(await host.call('projects.create',{name:'Original',kind:'folder'}));
  const sent=value(await host.call('turns.send',{projectId:project.id,text:'Write a brief',settings,attachments:[],clientKey:randomUUID()}));await idle(host,sent.threadId);
  value(await host.call('schedules.create',{projectId:project.id,text:'Scheduled work',when:'every day at 9:00',settings:{...settings,permission:'full'},clientKey:randomUUID()}));
  const schedules=structuredClone(await host.call('schedules.get',{}));
  const sharing=structuredClone(value(await host.call('identity.sharing',{projectId:project.id})));
  const before=structuredClone(value(await host.call('threads.get',{id:sent.threadId}))),files=structuredClone(await host.call('files.list',{projectId:project.id}));
  const storage=JSON.parse(fs.readFileSync(join(home,'projects.json'),'utf8'))[0];
  const events:string[]=[];const off=host.on(event=>{if(event.topic==='projects')events.push(event.id!);});
  try{
    assert.equal(value(await host.call('projects.update',{id:project.id,patch:{name:'Renamed'}})).name,'Renamed');
    assert.equal(value(await host.call('projects.update',{id:project.id,patch:{archived:true}})).archived,true);
    assert.deepEqual(value(await host.call('threads.get',{id:sent.threadId})),{...before,card:{...before.card,project:'Renamed'}});
    assert.deepEqual(await host.call('files.list',{projectId:project.id}),files);
    assert.deepEqual(await host.call('schedules.get',{}),schedules);
    assert.deepEqual(value(await host.call('identity.sharing',{projectId:project.id})),sharing);
    assert.equal(JSON.parse(fs.readFileSync(join(home,'projects.json'),'utf8'))[0].dir,storage.dir);
    assert.equal(value(await host.call('projects.update',{id:project.id,patch:{archived:false}})).archived,false);
    assert.equal(events.length,3);
    assert.equal((await host.call('projects.list',{}))[0].name,'Renamed');
  }finally{off();}
  host.close();await hostClosed(home);
  const reopened=open(home).host;
  assert.equal((await reopened.call('projects.list',{}))[0].name,'Renamed');
  assert.equal((await reopened.call('projects.list',{}))[0].archived,false);
});

for(const permission of ['viewer','editor'] as const)test(`joined ${permission} cannot change project properties, while its owner can`,async()=>{
  const {host}=open(),project=value(await host.call('projects.create',{name:'Shared',kind:'folder'}));
  const colleague=value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'member'})).token,'Colleague'));
  value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:permission}));
  const listed=await host.callAuthenticated(colleague.session,'projects.list',{});assert.equal(listed[0].access,permission);assert.equal(listed[0].canUpdate,false);
  for(const patch of [{name:'Stolen'},{archived:true},{archived:false}]){
    const refused=await host.callAuthenticated(colleague.session,'projects.update',{id:project.id,patch});
    assert.ok(!refused.ok);assert.equal(refused.outcome,'REFUSED');assert.match(refused.detail,/only the project owner/i);
  }
  value(await host.call('projects.update',{id:project.id,patch:{archived:true}}));
  assert.equal((await host.callAuthenticated(colleague.session,'projects.list',{}))[0].archived,true);
  assert.equal(value(await host.callAuthenticated(colleague.session,'identity.sharing',{projectId:project.id})).access,permission);
});

test('joined project owner changes its own project but not another owner project',async()=>{
  const {host}=open();const privateProject=value(await host.call('projects.create',{name:'Private',kind:'folder'}));
  const joined=value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'member'})).token,'Owner'));
  const own=value(await host.callAuthenticated(joined.session,'projects.create',{name:'Owned',kind:'folder'}));
  for(const patch of [{name:'Owned renamed'},{archived:true},{archived:false}])assert.ok((await host.callAuthenticated(joined.session,'projects.update',{id:own.id,patch})).ok);
  const denied=await host.callAuthenticated(joined.session,'projects.update',{id:privateProject.id,patch:{name:'Leak'}});assert.ok(!denied.ok);
  const missing=await host.callAuthenticated(joined.session,'projects.update',{id:randomUUID(),patch:{name:'Leak'}});assert.deepEqual(denied,missing);
  const deviceDenied=await host.call('projects.update',{id:own.id,patch:{name:'Override'}});assert.ok(!deviceDenied.ok,'device ownership does not widen project ownership');
});

test('write admission lost after authentication and before project storage leaves no change',async t=>{
  const {host,home}=open(),project=value(await host.call('projects.create',{name:'Original',kind:'folder'}));
  const before=fs.readFileSync(join(home,'projects.json'),'utf8'),statfs=fs.statfsSync;let admitted=true;
  t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...statfs(path),...(!admitted?{type:0x6969}:{})})) as typeof fs.statfsSync);
  {
    admitted=false;
    const result=await host.call('projects.update',{id:project.id,patch:{archived:true}});
    assert.ok(!result.ok);assert.equal(result.outcome,'REFUSED');
    assert.equal(fs.readFileSync(join(home,'projects.json'),'utf8'),before);
    assert.equal((await host.call('projects.list',{}))[0].archived,undefined);
  }
});

test('company renderer requires a session and its project owner can change project properties',async()=>{
  const provider=await identityProviderFixture();
  const bearer=randomUUID();
  const {host}=open(undefined,{identity:{company:{issuer:provider.issuer,clientId:'fixture',redirectUri:'http://127.0.0.1/callback',allowLoopbackHttp:true},directory:{bearer,issuer:provider.issuer}}});
  try{
    await assert.rejects(host.callAuthenticated('','projects.create',{name:'Unsigned',kind:'folder'}));
    await assert.rejects(host.callAuthenticated('','projects.update',{id:randomUUID(),patch:{name:'Unsigned'}}));
    // Host.call is the trusted process/device API, as it is for project creation.
    const local=value(await host.call('projects.create',{name:'Device project',kind:'folder'}));
    value(await host.call('projects.update',{id:local.id,patch:{name:'Device renamed'}}));
    const enrolled=await host.directoryRequest(new Request('http://127.0.0.1/scim/v2/Users',{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/scim+json'},body:JSON.stringify({userName:'project-owner',externalId:'project-owner'})}));
    assert.equal(enrolled.status,201);
    const browser='project-browser';const authorization=await host.beginCompanySignIn(browser);
    const signed=value(await host.completeCompanySignIn(provider.callback(authorization,'project-owner'),browser));
    const project=value(await host.callAuthenticated(signed.session,'projects.create',{name:'Company project',kind:'folder'}));
    assert.ok((await host.callAuthenticated(signed.session,'projects.update',{id:project.id,patch:{name:'Company renamed',archived:true}})).ok);
    assert.ok((await host.callAuthenticated(signed.session,'projects.update',{id:project.id,patch:{archived:false}})).ok);
    assert.deepEqual((await host.callAuthenticated(signed.session,'projects.list',{})).map(project=>project.id),[project.id]);
  }finally{await provider.close();}
});

test('project changes use the creation opt-in, company refusal and shared request budget on the line',async t=>{
  const {host,home}=open(),project=value(await host.call('projects.create',{name:'Line',kind:'folder'}));
  for(const enabled of [false,'signed-in-app',true] as const){
    let calls=0;
    const server=await serveApiLine({home,projectCreation:enabled,projectCreationBudget:new ApiLineProjectBudget(),call:async(method,args)=>{calls++;return host.call(method,args);}});
    const line=await attachApi(home);assert.ok(line);
    try{
      const result=await line.call('projects.update',{id:project.id,patch:{name:'Via line'}});
      if(enabled===true){assert.ok(result.ok);for(let i=0;i<9;i++)assert.ok((await line.call('projects.update',{id:project.id,patch:{archived:i%2===0}})).ok);
        const denied=await line.call('projects.create',{name:'Over budget',kind:'folder',clientKey:randomUUID()});assert.ok(!denied.ok);assert.equal(calls,10);
      }else{assert.ok(!result.ok);assert.equal(calls,0);if(enabled==='signed-in-app')assert.match(result.detail,/signed-in app/);}
    }finally{line.close();await server.close();}
  }
});

test('archiving a project keeps its running turn alive and its files reachable',async()=>{
  const {startScriptedModel}=await import('../src/testing/scripted-model.ts');
  const {hangDetector}=await import('../../../scripts/lib/test-hang.ts');
  let entered!:()=>void,release!:()=>void;
  const entering=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const model=await startScriptedModel('project-archive-running',()=>({text:'Finished in archived project'}),{before:async()=>{entered();await held;}});
  const {host}=open(undefined,{harness:'harness-pi'});
  try{
    value(await host.call('settings.model.put',{change:{route:'own',provider:'openai-compatible',baseUrl:model.url,model:model.model,key:`fake-${randomUUID()}`}}));
    const project=value(await host.call('projects.create',{name:'Running project',kind:'folder'}));
    const sent=value(await host.call('turns.send',{projectId:project.id,text:'Keep running',settings:{...settings,model:model.model},attachments:[],clientKey:randomUUID()}));
    await hangDetector(entering,'project turn reaches scripted engine');
    value(await host.call('projects.update',{id:project.id,patch:{archived:true}}));
    assert.equal(value(await host.call('threads.get',{id:sent.threadId})).summary.running,true);
    await host.call('files.list',{projectId:project.id});
    release();const done=await idle(host,sent.threadId);assert.equal(done.turns[0].status,'done');
  }finally{release();await model.close();}
});

test('Host reports an uncertain durable project write as unknown and never repeats it',async t=>{
  const {syncBuiltinESMExports}=await import('node:module');
  const {host,home}=open(),project=value(await host.call('projects.create',{name:'Before lost commit',kind:'folder'}));
  const rename=fs.renameSync;let writes=0;
  t.mock.method(fs,'renameSync',((from:fs.PathLike,to:fs.PathLike)=>{
    rename(from,to);
    if(String(to)===join(home,'projects.json')){writes++;throw new Error('Controlled failure after rename');}
  }) as typeof fs.renameSync);syncBuiltinESMExports();
  try{
    const receipt=await host.call('projects.update',{id:project.id,patch:{name:'After lost commit'}});
    assert.ok(!receipt.ok);assert.equal(receipt.outcome,'UNKNOWN');assert.equal(writes,1);
    assert.equal(JSON.parse(fs.readFileSync(join(home,'projects.json'),'utf8'))[0].name,'After lost commit');
    assert.equal((await host.call('projects.list',{}))[0].name,'After lost commit');
    t.mock.restoreAll();syncBuiltinESMExports();
    const held=await host.call('projects.update',{id:project.id,patch:{archived:true}});assert.ok(held.ok);
    const create=await host.call('projects.create',{name:'Must not overwrite',kind:'folder'});assert.ok(create.ok);assert.equal(writes,1);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
  host.close();await hostClosed(home);
  assert.equal((await open(home).host.call('projects.list',{}))[0].name,'After lost commit');
});

test('a demoted owner has viewer access and cannot change project properties',async()=>{
  const {host}=open();const owner=value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'member'})).token,'Former owner'));
  const project=value(await host.callAuthenticated(owner.session,'projects.create',{name:'Before demotion',kind:'folder'}));
  value(await host.call('identity.role',{personId:owner.person.id,role:'guest'}));
  assert.equal((await host.callAuthenticated(owner.session,'projects.list',{}))[0].access,'viewer');
  const result=await host.callAuthenticated(owner.session,'projects.update',{id:project.id,patch:{name:'After demotion'}});
  assert.ok(!result.ok);assert.equal(result.outcome,'REFUSED');assert.match(result.detail,/project owner/);
});

test('a real creation recheck after rename and archive preserves current properties across reopening',async()=>{
  const {host,home}=open();const args={name:'Original creation',kind:'folder' as const,clientKey:randomUUID()};
  const made=value(await host.call('projects.create',args));
  value(await host.call('projects.update',{id:made.id,patch:{name:'Current project',archived:true}}));
  const checked=value(await host.call('projects.create',args));assert.equal(checked.id,made.id);assert.equal(checked.name,'Current project');assert.equal(checked.archived,true);
  host.close();await hostClosed(home);
  const reopened=open(home).host;const again=value(await reopened.call('projects.create',args));
  assert.equal(again.id,made.id);assert.equal(again.name,'Current project');assert.equal(again.archived,true);
  assert.equal((await reopened.call('projects.list',{})).length,1);
});

 test('an unreadable project list refuses later writes and recovers on an explicit read',async t=>{
  const {syncBuiltinESMExports}=await import('node:module');
  const {host,home}=open(),project=value(await host.call('projects.create',{name:'Before',kind:'folder'}));
  const path=join(home,'projects.json'),rename=fs.renameSync,read=fs.readFileSync;let unreadable=false,writes=0;
  t.mock.method(fs,'renameSync',((from:fs.PathLike,to:fs.PathLike)=>{rename(from,to);if(String(to)===path){writes++;unreadable=true;throw new Error('Controlled lost durable answer');}}) as typeof fs.renameSync);
  t.mock.method(fs,'readFileSync',((file:fs.PathOrFileDescriptor,...args:unknown[])=>{if(String(file)===path&&unreadable)throw new Error('Controlled unreadable list');return (read as Function)(file,...args);}) as typeof fs.readFileSync);syncBuiltinESMExports();
  try{
    const first=await host.call('projects.update',{id:project.id,patch:{name:'After'}});assert.ok(!first.ok);assert.equal(first.outcome,'UNKNOWN');
    for(const request of [()=>host.call('projects.update',{id:project.id,patch:{archived:true}}),()=>host.call('projects.create',{name:'Later',kind:'folder'})]){const held=await request();assert.ok(!held.ok);assert.equal(held.outcome,'REFUSED');}
    assert.equal(writes,1);await assert.rejects(host.call('projects.list',{}));
    unreadable=false;assert.equal((await host.call('projects.list',{}))[0].name,'After');
    t.mock.restoreAll();syncBuiltinESMExports();assert.ok((await host.call('projects.update',{id:project.id,patch:{archived:true}})).ok);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 });

 test('an archived project survives a real Host backup and restore',async()=>{
  const source=open(),project=value(await source.host.call('projects.create',{name:'Archived backup',kind:'folder'}));
  value(await source.host.call('projects.update',{id:project.id,patch:{archived:true}}));
  const exported=join(freshDir('project-archive-export-'),'export');value(await source.host.call('backup.export',{to:exported}));
  assert.equal(JSON.parse(fs.readFileSync(join(exported,'projects/p001/project.json'),'utf8')).archived,true);
  const home=freshHome(),target=open(home);await target.host.importExport(exported);target.host.close();await hostClosed(home);
  const restored=await open(home).host.call('projects.list',{});assert.equal(restored.find(p=>p.name==='Archived backup')?.archived,true);
 });
