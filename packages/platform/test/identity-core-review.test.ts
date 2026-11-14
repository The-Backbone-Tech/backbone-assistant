import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {inActiveHomeLockScope} from '../src/composition/home-lock.ts';
import {homeRelease} from '../src/composition/home-owner.ts';
import {waitFor} from '../../../scripts/lib/test-hang.ts';
import {startScriptedModel} from '../src/testing/scripted-model.ts';
import {open,value,idle,settings} from './helpers.ts';

test('a remaining owner reopens after removing the original device owner without renewing their identity or grants',async t=>{
 const model=await startScriptedModel('owner-restart',()=>({text:'Work for the remaining owner'}));
 try{
 const first=open(undefined,{harness:'harness-pi'}),original=value(await first.host.call('identity.get',{})).person;
 value(await first.host.call('settings.model.put',{change:{route:'own',provider:'openai-compatible',baseUrl:model.url,model:model.model,key:`fake-${randomUUID()}`}}));
 const invite=value(await first.host.call('identity.invite',{role:'admin'})),next=value(await first.host.acceptInvitation(invite.token,'Remaining owner'));
 value(await first.host.call('identity.role',{personId:next.person.id,role:'owner'}));
 const project=value(await first.host.callAuthenticated(next.session,'projects.create',{name:'Remaining owner work',kind:'folder'}));
 value(await first.host.callAuthenticated(next.session,'identity.remove',{personId:original.id}));
 const before=readFileSync(join(first.home,'core.json'),'utf8'),originalIdentity=JSON.parse(before);
 first.host.close();await CoreLink.whenClosed(first.home);await homeRelease(first.home);
 const opening=CoreLink.open;let mounted!:CoreLink;
 t.mock.method(CoreLink,'open',async function(...args:Parameters<typeof opening>){mounted=await Reflect.apply(opening,CoreLink,args);return mounted;});
 const restarted=open(first.home,{harness:'harness-pi'}).host;
 assert.equal(value(await restarted.callAuthenticated(next.session,'identity.get',{})).person.id,next.person.id);
 assert.ok((await restarted.callAuthenticated(next.session,'projects.list',{})).some(row=>row.id===project.id));
 await assert.rejects(restarted.call('identity.get',{}));
 const sent=value(await restarted.callAuthenticated(next.session,'turns.send',{projectId:project.id,text:'Continue as the remaining owner',attachments:[],settings:{...settings,model:model.model},clientKey:randomUUID()}));
 await waitFor(async()=>!value(await restarted.callAuthenticated(next.session,'threads.get',{id:sent.threadId})).summary.running,'remaining owner finishes their independently authorized model work');
 assert.equal(value(await restarted.callAuthenticated(next.session,'threads.get',{id:sent.threadId})).turns.at(-1)?.answer?.text,'Work for the remaining owner');
 assert.ok(model.requests.length>0,'the mounted registered engine ran, without a stub fallback');
 assert.equal(readFileSync(join(first.home,'core.json'),'utf8'),before,'mounting never replaces or renews the removed device identity');
 assert.equal((await mounted.read<{revoked:boolean}>(mounted.system(),'SELECT revoked_at IS NOT NULL AS revoked FROM app.mandates WHERE id=$1',[originalIdentity.mandate])).rows[0].revoked,true);
 assert.equal((await mounted.read<{n:number}>(mounted.system(),'SELECT count(*)::int AS n FROM app.mandates WHERE on_behalf_of_id=$1 AND revoked_at IS NULL',[original.id])).rows[0].n,0);
 const people=value(await restarted.callAuthenticated(next.session,'identity.get',{})).people;
 assert.equal(people.find(person=>person.id===original.id)?.status,'removed');
 }finally{await model.close();}
});

test('shared-project child and fork tasks bind their actual publication audience and cross Core outside the home lock',async t=>{
 const {host,home}=open(),project=value(await host.call('projects.create',{name:'Shared publication',kind:'folder'}));
 const invitation=value(await host.call('identity.invite',{role:'guest'})),viewer=value(await host.acceptInvitation(invitation.token,'Viewer'));
 value(await host.call('identity.share',{projectId:project.id,personId:viewer.person.id,access:'viewer'}));
 const parent=value(await host.call('turns.send',{projectId:project.id,text:'Start work',attachments:[],settings,clientKey:randomUUID()}));await idle(host,parent.threadId);
 const original=CoreLink.prototype.createTask;let link!:CoreLink,lockedCrossing=false;
 t.mock.method(CoreLink.prototype,'createTask',async function(this:CoreLink,...args:Parameters<typeof original>){link=this;return Reflect.apply(original,this,args);});
 for(const method of ['call','read'] as const){const native=CoreLink.prototype[method];t.mock.method(CoreLink.prototype,method,function(this:CoreLink,...args:Parameters<typeof native>){lockedCrossing||=inActiveHomeLockScope(home);return Reflect.apply(native,this,args);});}
 const child=value(await host.call('children.start',{parentThreadId:parent.threadId,text:'Check publication',role:'worker',clientKey:randomUUID()}));await idle(host,child.threadId);
 const fork=value(await host.call('threads.fork',{id:parent.threadId,clientKey:randomUUID()}));
 const privateTask=await link.createTask('Private source for the control');
 for(const id of [child.threadId,fork.id]){
  const task=JSON.parse(readFileSync(join(home,'threads',id+'.json'),'utf8')).task;
  assert.equal((await link.identities.asPerson(viewer.person.id,()=>link.read(link.person(),'SELECT id FROM app.tasks WHERE id=$1',[task]))).rows[0]?.id,task,'the actual project recipient reads the native task');
  const run=await link.startRun(task);
  try{
   await link.call(link.system(),"SELECT gov.record_source('web','fixture://outsider','Fixture outside words',NULL,$1,NULL,NULL,NULL)",[run.run]);
   await link.call(link.runOf(run),'SELECT gov.quote_marks($1,$2::jsonb)',[run.run,JSON.stringify({tasks:[privateTask]})]);
   const effect=await link.call<string>(link.runOf(run),"SELECT gov.propose_effect($1,$2,NULL,'fixture','workspace.write_document',NULL,NULL,NULL,NULL,$3::jsonb,'Publication control',NULL,$4)",[run.run,run.fence,JSON.stringify({task_id:task,title:'Shared output',content:'Both taints'}),randomUUID()]);
   assert.deepEqual((await link.read(link.system(),'SELECT status,route_reason FROM app.effects WHERE id=$1',[effect])).rows[0],{status:'awaiting_checker',route_reason:'rule_of_two'});
  }finally{await link.finishRun(run,'failed');}
 }
 assert.equal(lockedCrossing,false,'child and fork preparation must not await Core while holding the home lock');
 value(await host.call('identity.share',{projectId:project.id,personId:viewer.person.id,access:null}));
 for(const id of [child.threadId,fork.id])await assert.rejects(host.callAuthenticated(viewer.session,'threads.get',{id}));
});
