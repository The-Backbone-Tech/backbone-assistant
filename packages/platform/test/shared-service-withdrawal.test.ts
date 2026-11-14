import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { IdentityRefused } from '../src/composition/identity-core.ts';
import { hangDetector } from '../../../scripts/lib/test-hang.ts';
import { open, value, idle, settings } from './helpers.ts';

test('withdrawing a project share stops its running member turn and withholds the late answer', async () => {
  let entered!:()=>void,release!:()=>void,answered!:()=>void;
  const entering=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const answering=new Promise<void>(resolve=>{answered=resolve;});
  const model=await startScriptedModel('shared-withdrawal',()=>{answered();return {text:'LATE_WITHDRAWN_SHARE_ANSWER'};},{before:async()=>{entered();await held;}});
  const {host}=open(undefined,{harness:'harness-pi'});
  try {
    value(await host.call('settings.model.put',{change:{route:'own',provider:'openai-compatible',baseUrl:model.url,model:model.model,key:'fake-'+randomUUID()}}));
    const project=value(await host.call('projects.create',{name:'Withdrawn running share',kind:'folder'}));
    const invitation=value(await host.call('identity.invite',{role:'member'}));
    const member=value(await host.acceptInvitation(invitation.token,'Running colleague'));
    value(await host.call('identity.share',{projectId:project.id,personId:member.person.id,access:'editor'}));
    const sent=value(await host.callAuthenticated(member.session,'turns.send',{projectId:project.id,text:'Hold this project answer',attachments:[],settings:{...settings,model:(await host.call('models.list',{}))[0].id},clientKey:randomUUID()}));
    await hangDetector(entering,'the member turn reaches the held local model');
    assert.equal(value(await host.call('threads.get',{id:sent.threadId})).summary.running,true);
    value(await host.call('identity.share',{projectId:project.id,personId:member.person.id,access:null}));
    // It must stop while the model still holds its answer, not merely after receiving late text.
    const stopped=await idle(host,sent.threadId);
    assert.notEqual(stopped.turns[0].status,'done');
    await assert.rejects(host.callAuthenticated(member.session,'threads.get',{id:sent.threadId}),IdentityRefused);
    await assert.rejects(host.callAuthenticated(member.session,'turns.send',{projectId:project.id,threadId:sent.threadId,text:'Try after withdrawal',attachments:[],settings,clientKey:randomUUID()}),IdentityRefused);
    // The workspace session itself remains valid: this is project access withdrawal.
    assert.equal(value(await host.callAuthenticated(member.session,'identity.get',{})).person.id,member.person.id);
    assert.deepEqual(await host.callAuthenticated(member.session,'projects.list',{}),[]);
    release();
    await hangDetector(answering,'the model produces its answer after share withdrawal');
    const final=await idle(host,sent.threadId);
    assert.ok(!final.turns[0].answer?.text.includes('LATE_WITHDRAWN_SHARE_ANSWER'));
    assert.notEqual(final.turns[0].status,'done');
  } finally { release(); await model.close(); }
});
