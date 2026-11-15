import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { dataHomeAdminUrl } from '@backbone/core/testing';
import { waitFor } from '../../../scripts/lib/test-hang.ts';
import { PIECE_DIRS } from '../src/composition/pieces.ts';
import { pieceDigest, pieceFiles } from '../src/pieces/digest.ts';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { withHomeLock, assertHomeWriteAdmission } from '../src/composition/home-lock.ts';
import { serveIdentityApi } from '../src/composition/identity-http.ts';
import { hostClosed } from '../src/composition/host.ts';
import { open, value, freshHome, freshDir, settings, idle } from './helpers.ts';

function nativeFixture() {
  const fixture = freshDir('shared-native-piece-');
  for (const path of pieceFiles(PIECE_DIRS['harness-codex'])) {
    const target = join(fixture, path); mkdirSync(dirname(target), { recursive:true }); copyFileSync(join(PIECE_DIRS['harness-codex'], path), target);
  }
  writeFileSync(join(fixture, 'src/index.ts'), `export function createCodexHarness(){return {
    specificationVersion:'v1', id:'native-fixture', label:'Owner native fixture',
    async listModels(){return [{id:'personal',label:'Personal',efforts:[3]}]},
    start(request,context){return {events:(async function*(){})(),outcome:Promise.resolve({status:'done',answer:'Owner route '+context.route.model+(request.nativeAccountTools===false?' contained':' native tools'),usage:{input:0,output:0}}),stop(){},steer(){}}}
  }}`);
  const path = join(fixture,'backbone.module.json'), manifest = JSON.parse(readFileSync(path,'utf8'));
  writeFileSync(path, JSON.stringify({...manifest,digest:pieceDigest(fixture)}));
  return fixture;
}

test('colleagues use only explicit Pi route while owner native turns and model catalog stay personal', async t => {
  const model = await startScriptedModel('shared-model', () => ({text:'Shared answer'}));
  t.after(() => model.close());
  const {host} = open(freshHome(), {harness:'harness-codex',pieceDirs:{'harness-codex':nativeFixture()}});
  const project = value(await host.call('projects.create',{name:'Shared',kind:'folder'}));
  value(await host.call('settings.model.put',{change:{route:'native',provider:'codex',model:'personal'}}));
  const colleague = value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'member'})).token,'Colleague'));
  value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'editor'}));
  const send = () => host.callAuthenticated(colleague.session,'turns.send',{projectId:project.id,text:'Hello',attachments:[],settings,clientKey:randomUUID()});
  await assert.rejects(send(), /was not sent.*shared model/);
  const invalid = await host.call('settings.model.put',{change:{route:'shared',change:{route:'native',provider:'codex',model:'personal'}}});
  assert.equal(invalid.ok,false);
  value(await host.call('settings.model.put',{change:{route:'shared',change:{route:'local',provider:'other',baseUrl:model.url,model:model.model}}}));
  assert.equal((await host.callAuthenticated(colleague.session,'models.list',{}))[0].id,'shared-model');
  assert.equal((await host.call('models.list',{}))[0].id,'personal');
  const sent = value(await send());
  const thread = await idle(host,sent.threadId), turn = thread.turns[0];
  assert.equal(turn.status,'done',JSON.stringify(turn)); assert.equal(turn.answer?.text,'Shared answer');
  assert.match(turn.work.harness,/Pi.*shared-model/);
  assert.equal(value(await host.callAuthenticated(colleague.session,'threads.get',{id:sent.threadId})).summary.access,'editor');
  const privateProject = value(await host.call('projects.create',{name:'Personal',kind:'folder'}));
  const owner = value(await host.call('turns.send',{projectId:privateProject.id,text:'Owner turn',attachments:[],settings:{...settings,permission:'full',model:'personal'},clientKey:randomUUID()}));
  const personal = (await idle(host,owner.threadId)).turns[0];
  assert.equal(personal.answer?.text,'Owner route personal native tools',JSON.stringify(personal));
  assert.match(personal.work.harness,/Owner native fixture/);
  assert.ok(personal.work.carriers?.length);
  value(await host.call('identity.share',{projectId:privateProject.id,personId:colleague.person.id,access:'viewer'}));
  assert.equal(value(await host.callAuthenticated(colleague.session,'threads.get',{id:owner.threadId})).turns[0].work.carriers,undefined,'an authorized colleague sees no internal route identities');
  assert.ok(model.requests.every(request => !request.body.includes('Owner turn') && !request.body.includes('personal')));
  for (const request of model.requests) {
    // Model-list probes are bodyless; every request that has a body is still checked for tools.
    const tools = request.body ? JSON.parse(request.body).tools ?? [] : [];
    assert.ok(tools.every((tool:{function:{name:string}}) => !/connector|memory|children|schedule/.test(tool.function.name)));
  }
  const automation = value(await host.call('identity.automation.create',{personId:colleague.person.id,projectId:project.id,name:'Shared worker'}));
  const automated = value(await host.call('identity.automation.run',{id:automation.id,text:'Automated work'}));
  const automaticTurn = (await idle(host,automated.threadId)).turns[0];
  assert.equal(automaticTurn.status,'done',JSON.stringify(automaticTurn));
  assert.match(automaticTurn.work.harness,/Pi.*shared-model/);
  value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'viewer'}));
  await assert.rejects(send(), /identity or project permission/);
  value(await host.call('identity.remove',{personId:colleague.person.id}));
  await assert.rejects(send(), /identity or project permission/);
});

for (const change of ['viewer', 'remove', 'withdraw'] as const) test(`shared Pi turn stops after ${change} while its local model is running`, async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), held = new Promise<void>(resolve => release = resolve);
  const model = await startScriptedModel('shared-model', messages => change === 'withdraw' && !messages.some(message => message.role === 'tool') ? {calls:[{name:'read_file',args:{name:'source.md'}}]} : {text:'Late answer'}, {before:async messages => { if (change !== 'withdraw' || messages.some(message => message.role === 'tool')) { entered(); await held; } }});
  t.after(async () => { release(); await model.close(); });
  const {host} = open(freshHome(),{harness:'harness-codex',pieceDirs:{'harness-codex':nativeFixture()}});
  const project = value(await host.call('projects.create',{name:'Revocation',kind:'folder'}));
  value(await host.call('settings.model.put',{change:{route:'shared',change:{route:'local',provider:'other',baseUrl:model.url,model:model.model}}}));
  const colleague = value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'member'})).token,'Colleague'));
  value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'editor'}));
  const material = value(await host.call('material.attach',{projectId:project.id,name:'source.md',base64:Buffer.from('Shared source').toString('base64'),mediaType:'text/markdown'}));
  const sent = value(await host.callAuthenticated(colleague.session,'turns.send',{projectId:project.id,text:'Read source.md',attachments:[material.id],settings,clientKey:randomUUID()}));
  await started;
  if (change === 'viewer') value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'viewer'}));
  else if (change === 'remove') value(await host.call('identity.remove',{personId:colleague.person.id}));
  else value(await host.call('material.lifecycle',{id:material.id,version:1,state:'withdrawn',lifecycle:0}));
  release();
  const turn = (await idle(host,sent.threadId)).turns[0];
  if (change === 'withdraw') { assert.equal(turn.withheld,true,JSON.stringify(turn)); assert.match(turn.answer?.text ?? '',/source.md was withdrawn/); }
  else { assert.notEqual(turn.status,'done',JSON.stringify(turn)); assert.notEqual(turn.status,'refused','work already began before access ended'); }
  assert.notEqual(turn.answer?.text,'Late answer');
  assert.equal(model.requests.filter(request => request.body.includes('"messages"')).length,change === 'withdraw' ? 2 : 1,'no replay after access or source changes');
});


test('a local send cannot recover a recorded shared Pi turn on the personal Pi route after clear', async t => {
  const personal = await startScriptedModel('personal-model', () => ({text:'Personal answer'}));
  const shared = await startScriptedModel('shared-model', () => ({text:'Shared answer'}));
  t.after(async () => { await personal.close(); await shared.close(); });
  const {host,home} = open(freshHome(),{harness:'harness-pi'});
  const project = value(await host.call('projects.create',{name:'Recovery boundary',kind:'folder'}));
  value(await host.call('settings.model.put',{change:{route:'local',provider:'other',baseUrl:personal.url,model:personal.model}}));
  value(await host.call('settings.model.put',{change:{route:'shared',change:{route:'local',provider:'other',baseUrl:shared.url,model:shared.model}}}));
  const colleague = value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'member'})).token,'Colleague'));
  value(await host.call('identity.share',{projectId:project.id,personId:colleague.person.id,access:'editor'}));
  const sent = value(await host.callAuthenticated(colleague.session,'turns.send',{projectId:project.id,text:'Shared work',attachments:[],settings,clientKey:randomUUID()}));
  const original = (await idle(host,sent.threadId)).turns[0];
  assert.equal(original.sharedEngine,'harness-pi');
  value(await host.call('settings.model.put',{change:{route:'shared',change:{route:'local',clear:true}}}));
  // Retained producer data is a controlled recovery fixture; a send must not adopt it.
  const checkpoint = join(home,'checkpoints',sent.turnId+'.json'), bytes = JSON.stringify({files:[],sources:[]});
  await withHomeLock(home,async()=>{assertHomeWriteAdmission(home);mkdirSync(dirname(checkpoint),{recursive:true});assertHomeWriteAdmission(home);writeFileSync(checkpoint,bytes);});
  const next = await host.call('turns.send',{projectId:project.id,threadId:sent.threadId,text:'Continue locally',attachments:[],settings,clientKey:randomUUID()});
  assert.equal(next.ok,false); if (!next.ok) assert.match(next.detail,/Saved work.*reconciled/);
  await waitFor(async()=>value(await host.call('threads.get',{id:sent.threadId})).turns[0].recoveryAttempt!==undefined||['refused','stopped'].includes(value(await host.call('threads.get',{id:sent.threadId})).turns[0].status),'launched shared recovery settles with its recorded refusal');
  const settled=value(await host.call('threads.get',{id:sent.threadId})).turns[0];
  assert.equal(settled.status,'done');
  assert.equal(settled.answer?.text,'Shared answer');
  assert.match(settled.recoveryAttempt?.detail??'',/Recovery did not start.*Shared work/);
  assert.equal(settled.refusal,undefined);
  assert.equal(value(await host.call('threads.get',{id:sent.threadId})).summary.running,false);
  assert.equal(settled.interrupted,undefined,'refusal occurred before resumeAdmitted');
  host.close(); await hostClosed(home);
  assert.equal(existsSync(checkpoint),true,'missing shared choice retains recovery data');
  assert.equal(readFileSync(checkpoint,'utf8'),bytes);
  assert.equal(personal.requests.filter(request=>request.body.includes('"messages"')).length,0,'personal model never receives shared recovery');
  assert.equal(shared.requests.filter(request=>request.body.includes('"messages"')).length,1,'shared work is never resent');
});


for (const configured of [true,false]) test(`the owner's other computer protects personal history and starts on ${configured?'shared':'workspace Pi'}`, async t => {
  const personal=await startScriptedModel('personal-model',()=>({text:'Personal answer'}));
  const shared=await startScriptedModel('shared-model',()=>({text:'Shared answer'}));
  t.after(async()=>{await personal.close();await shared.close();});
  const {host,home}=open(freshHome(),{harness:'harness-pi'});
  const project=value(await host.call('projects.create',{name:'Owner remote boundary',kind:'folder'}));
  value(await host.call('settings.model.put',{change:{route:'local',provider:'other',baseUrl:personal.url,model:personal.model}}));
  const original=value(await host.call('turns.send',{projectId:project.id,text:'Private personal context',attachments:[],settings,clientKey:randomUUID()}));
  await idle(host,original.threadId);
  if(configured)value(await host.call('settings.model.put',{change:{route:'shared',change:{route:'local',provider:'other',baseUrl:shared.url,model:shared.model}}}));
  const owner=value(await host.call('identity.get',{})).person.id,session=randomUUID();
  // Only the owned disposable database gets this authenticated owner-session fixture.
  const db=new pg.Client({connectionString:dataHomeAdminUrl(home)});await db.connect();
  try{await db.query("INSERT INTO app.identity_sessions(workspace_id,token_hash,principal_id,expires_at) SELECT workspace_id,$1,id,clock_timestamp()+interval '1 hour' FROM app.principals WHERE id=$2",[createHash('sha256').update(session).digest('hex'),owner]);}finally{await db.end();}
  const send=(threadId?:string)=>host.callAuthenticated(session,'turns.send',{projectId:project.id,threadId,text:'From another computer',attachments:[],settings,clientKey:randomUUID()});
  if(configured){
    const http=await serveIdentityApi({host});t.after(()=>http.close());
    const response=await fetch(http.origin+'/api',{method:'POST',headers:{authorization:`Bearer ${session}`},body:JSON.stringify({method:'turns.send',args:{projectId:project.id,threadId:original.threadId,text:'Remote continuation',attachments:[],settings,clientKey:randomUUID()}})});
    assert.equal(response.status,409);
    assert.match((await response.json()).error,/This conversation was started on the owner's computer/);
    const read=await fetch(http.origin+'/api',{method:'POST',headers:{authorization:`Bearer ${session}`},body:JSON.stringify({method:'threads.get',args:{id:original.threadId}})});
    assert.equal((await read.json()).value.turns[0].work.carriers,undefined,'route identities stay on the owner computer');
    await assert.rejects(send(original.threadId),/This conversation was started on the owner's computer with its own model\. Continue it there, or start a new conversation here\./);
    assert.equal(shared.requests.filter(r=>r.body.includes('"messages"')).length,0);
    // Even after the personal selection changes, the route used by the original turn owns its history.
    value(await host.call('settings.model.put',{change:{route:'local',provider:'other',baseUrl:shared.url,model:shared.model}}));
    await assert.rejects(send(original.threadId),/This conversation was started/);
  }else{
    const continued=value(await send(original.threadId));
    assert.equal((await idle(host,continued.threadId)).turns.at(-1)?.answer?.text,'Personal answer');
  }
  const fresh=value(await send());
  const turn=(await idle(host,fresh.threadId)).turns[0];
  assert.equal(turn.status,'done',JSON.stringify(turn));
  assert.equal(turn.answer?.text,configured?'Shared answer':'Personal answer');
  assert.equal(!!turn.sharedEngine,configured);
  assert.ok(shared.requests.every(r=>!r.body.includes('Private personal context')));
});


test('the Host exposes a failed shared load to the owner without disabling personal turns', async t => {
  const {host}=open(freshHome(),{harness:'harness-codex',pieceDirs:{'harness-codex':nativeFixture(),'harness-pi':freshDir('missing-shared-piece-')}});
  const project=value(await host.call('projects.create',{name:'Load diagnosis',kind:'folder'}));
  const result=await host.call('settings.model.put',{change:{route:'shared',change:{route:'local',provider:'other',baseUrl:'http://127.0.0.1:1',model:'shared'}}});
  assert.equal(result.ok,false);
  const hint=(await host.call('settings.model.get',{})).shared?.hint;
  assert.match(hint??'',/Shared engine could not load:/);
  assert.equal(host.sharedEngineNotice(),hint);
  await assert.rejects(host.call('identity.automation.create',{personId:value(await host.call('identity.get',{})).person.id,projectId:project.id,name:'Owner automation'}),/Automation was not created.*Shared work.*Shared engine could not load:/);
  const admin=value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'admin'})).token,'Admin'));
  const http=await serveIdentityApi({host});t.after(()=>http.close());
  const response=await fetch(http.origin+'/api',{method:'POST',headers:{authorization:`Bearer ${admin.session}`},body:JSON.stringify({method:'identity.automation.create',args:{personId:admin.person.id,projectId:project.id,name:'Refused automation'}})});
  assert.equal(response.status,409);
  const problem=await response.json();assert.equal(problem.outcome,'REFUSED');assert.match(problem.error,/Automation was not created/);assert.doesNotMatch(problem.error,/Shared engine could not load|missing-shared-piece/);
  value(await host.call('settings.model.put',{change:{route:'native',provider:'codex',model:'personal'}}));
  const sent=value(await host.call('turns.send',{projectId:project.id,text:'Personal still works',attachments:[],settings:{...settings,model:'personal',permission:'full'},clientKey:randomUUID()}));
  assert.equal((await idle(host,sent.threadId)).turns[0].answer?.text,'Owner route personal native tools');
});

test('Host passes the recorded shared requirement when the device owner recovers their remote turn', async t => {
  const personal=await startScriptedModel('personal-model',()=>({text:'Personal answer'}));
  const shared=await startScriptedModel('shared-model',()=>({text:'Shared answer'}));
  t.after(async()=>{await personal.close();await shared.close();});
  const {host,home}=open(freshHome(),{harness:'harness-pi'});
  const project=value(await host.call('projects.create',{name:'Owner shared recovery',kind:'folder'}));
  value(await host.call('settings.model.put',{change:{route:'local',provider:'other',baseUrl:personal.url,model:personal.model}}));
  value(await host.call('settings.model.put',{change:{route:'shared',change:{route:'local',provider:'other',baseUrl:shared.url,model:shared.model}}}));
  const owner=value(await host.call('identity.get',{})).person.id,session=randomUUID();
  const db=new pg.Client({connectionString:dataHomeAdminUrl(home)});await db.connect();
  try{await db.query("INSERT INTO app.identity_sessions(workspace_id,token_hash,principal_id,expires_at) SELECT workspace_id,$1,id,clock_timestamp()+interval '1 hour' FROM app.principals WHERE id=$2",[createHash('sha256').update(session).digest('hex'),owner]);}finally{await db.end();}
  const sent=value(await host.callAuthenticated(session,'turns.send',{projectId:project.id,text:'Owner remote work',attachments:[],settings,clientKey:randomUUID()}));
  assert.equal((await idle(host,sent.threadId)).turns[0].sharedEngine,'harness-pi');
  value(await host.call('settings.model.put',{change:{route:'shared',change:{route:'local',clear:true}}}));
  const checkpoint=join(home,'checkpoints',sent.turnId+'.json'),bytes=JSON.stringify({files:[],sources:[]});
  await withHomeLock(home,async()=>{assertHomeWriteAdmission(home);mkdirSync(dirname(checkpoint),{recursive:true});assertHomeWriteAdmission(home);writeFileSync(checkpoint,bytes);});
  const next=await host.call('turns.send',{projectId:project.id,threadId:sent.threadId,text:'Continue here',attachments:[],settings,clientKey:randomUUID()});
  assert.equal(next.ok,false);
  await waitFor(async()=>value(await host.call('threads.get',{id:sent.threadId})).turns[0].recoveryAttempt!==undefined||['refused','stopped'].includes(value(await host.call('threads.get',{id:sent.threadId})).turns[0].status),'owner shared recovery settles');
  const settled=value(await host.call('threads.get',{id:sent.threadId})).turns[0];
  assert.equal(settled.status,'done',JSON.stringify(settled));
  assert.equal(settled.answer?.text,'Shared answer');
  assert.match(settled.recoveryAttempt?.detail??'',/Recovery did not start.*Shared work/);
  assert.equal(settled.refusal,undefined);
  assert.equal(settled.interrupted,undefined,'resumeAsActor refused before resumeAdmitted');
  assert.equal(readFileSync(checkpoint,'utf8'),bytes);
  assert.equal(personal.requests.filter(r=>r.body.includes('"messages"')).length,0);
});

test('a failed shared load with a saved provider key cannot deadlock writable startup', async () => {
  const home=freshHome(),native=nativeFixture(),missing=freshDir('missing-shared-startup-');
  const options={harness:'harness-codex',pieceDirs:{'harness-codex':native,'harness-pi':missing}};
  const {host:first}=open(home,options);
  value(await first.call('projects.create',{name:'Startup diagnosis',kind:'folder'}));
  const saved=await first.call('settings.model.put',{change:{route:'shared',change:{route:'own',provider:'openai',key:'shared-startup-canary',model:'shared'}}});
  assert.equal(saved.ok,false,'the setting persists even though loading fails');
  first.close();await hostClosed(home);
  const {host}=open(home,options);
  const settings=await host.call('settings.model.get',{});
  assert.match(settings.shared?.hint??'',/Shared engine could not load:/);
  assert.doesNotMatch(settings.shared?.hint??'',/shared-startup-canary/);
  assert.match(settings.harness,/Owner native fixture/);
});
