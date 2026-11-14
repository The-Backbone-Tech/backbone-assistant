import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open, value, idle, settings } from './helpers.ts';
import { randomUUID } from 'node:crypto';
import { startScriptedModel } from '../src/testing/scripted-model.ts';
import { hangDetector } from '../../../scripts/lib/test-hang.ts';

test('an invited viewer sees one shared project, cannot mutate it or borrow the owner, and loses every request on removal', async () => {
  const { host } = open();
  const shared = value(await host.call('projects.create', { name: 'Shared', kind: 'folder' }));
  const privateProject = value(await host.call('projects.create', { name: 'Private', kind: 'folder' }));
  const sent = value(await host.call('turns.send', { projectId: shared.id, text: 'Write a brief', settings,attachments:[],clientKey:randomUUID() }));
  await idle(host, sent.threadId);
  const invitation = value(await host.call('identity.invite', { role: 'guest' }));
  const joined = value(await host.acceptInvitation(invitation.token, 'Viewer'));
  await host.call('identity.share', { projectId: shared.id, personId: joined.person.id, access: 'viewer' });
  assert.deepEqual((await host.callAuthenticated(joined.session, 'projects.list', {})).map(project => project.id), [shared.id]);
  assert.equal(value(await host.callAuthenticated(joined.session, 'identity.get', {})).person.role, 'guest');
  assert.equal(value(await host.callAuthenticated(joined.session, 'threads.get', { id: sent.threadId })).summary.projectId, shared.id);
  await assert.rejects(host.callAuthenticated(joined.session, 'turns.send', { projectId: shared.id, text: 'Change it',settings,attachments:[],clientKey:randomUUID() }));
  await assert.rejects(host.callAuthenticated(joined.session, 'files.list', { projectId: privateProject.id }));
  await assert.rejects(host.callAuthenticated(joined.session, 'identity.invite', { role: 'admin' }));
  await assert.rejects(host.callAuthenticated('', 'projects.list', {}));
  await assert.rejects(host.callAuthenticated('not-a-session', 'projects.list', {}));
  value(await host.call('identity.remove', { personId: joined.person.id }));
  await assert.rejects(host.callAuthenticated(joined.session, 'projects.list', {}));
  assert.equal((await host.call('projects.list', {})).length, 2);
});

test('an editor runs as the named person, sees no personal memory or connectors, and revocation stops its running automation', async () => {
  const { host } = open();
  const project = value(await host.call('projects.create', { name: 'Team', kind: 'folder' }));
  const invitation = value(await host.call('identity.invite', { role: 'member' }));
  const joined = value(await host.acceptInvitation(invitation.token, 'Member'));
  value(await host.call('identity.share', { projectId: project.id, personId: joined.person.id, access: 'editor' }));
  const sent = value(await host.callAuthenticated(joined.session, 'turns.send', { projectId: project.id, text: 'Write a team brief',settings,attachments:[],clientKey:randomUUID() }));
  await idle(host, sent.threadId);
  const thread = value(await host.callAuthenticated(joined.session, 'threads.get', { id: sent.threadId }));
  assert.ok(thread.turns.length);
  await assert.rejects(host.callAuthenticated(joined.session, 'memory.get', {}));
  await assert.rejects(host.callAuthenticated(joined.session, 'connectors.list', {}));
  await assert.rejects(host.callAuthenticated(joined.session, 'backup.inspect', { from: 'unavailable' }));
});

test('an admin runs an automation for a named member and revocation stops the live engine without dispatching its late answer', async () => {
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const model = await startScriptedModel('identity-model', () => ({ text:'Late answer' }), { before:async () => { entered(); await held; } });
  const { host } = open(undefined,{harness:'harness-pi'});
  try {
    value(await host.call('settings.model.put',{change:{route:'own',provider:'openai-compatible',baseUrl:model.url,model:model.model,key:`fake-${randomUUID()}`}}));
    const project = value(await host.call('projects.create',{name:'Automated team work',kind:'folder'}));
    const invitation = value(await host.call('identity.invite',{role:'member'}));
    const member = value(await host.acceptInvitation(invitation.token,'Named member'));
    value(await host.call('identity.share',{projectId:project.id,personId:member.person.id,access:'editor'}));
    value(await host.call('memory.put',{topic:'private',text:'OWNER_ONLY_IDENTITY_CANARY'}));
    const automation = value(await host.call('identity.automation.create',{personId:member.person.id,projectId:project.id,name:'Project helper'}));
    const sent = value(await host.call('identity.automation.run',{id:automation.id,text:'Wait for a result'}));
    await hangDetector(entering,'identity automation reaches the local engine');
    const request = model.requests.find(request=>request.body.includes('Wait for a result'))!;
    assert.doesNotMatch(request.body,/OWNER_ONLY_IDENTITY_CANARY/);
    const tools = JSON.parse(request.body).tools as {function:{name:string}}[];
    assert.ok(!tools.some(tool=>/connector|memory|child|workspace|card/.test(tool.function.name)),'the named identity receives project file tools only');
    value(await host.call('identity.automation.revoke',{id:automation.id}));
    release();
    await idle(host,sent.threadId);
    const thread = value(await host.call('threads.get',{id:sent.threadId}));
    assert.notEqual(thread.turns[0].status,'done');
    assert.ok(!thread.turns[0].answer?.text.includes('Late answer'));
    await assert.rejects(host.call('identity.automation.run',{id:automation.id,text:'Try again'}));
  } finally { release(); await model.close(); }
});


test('a demoted project owner remains a viewer and cannot grant editor access through Host', async () => {
  const {host}=open();
  const invite=value(await host.call('identity.invite',{role:'admin'}));
  const formerAdmin=value(await host.acceptInvitation(invite.token,'Project owner'));
  const project=value(await host.callAuthenticated(formerAdmin.session,'projects.create',{name:'Owned project',kind:'folder'}));
  const colleagueInvite=value(await host.call('identity.invite',{role:'member'}));
  const colleague=value(await host.acceptInvitation(colleagueInvite.token,'Colleague'));
  value(await host.call('identity.role',{personId:formerAdmin.person.id,role:'guest'}));
  assert.equal(value(await host.callAuthenticated(formerAdmin.session,'identity.sharing',{projectId:project.id})).access,'viewer');
  await assert.rejects(host.callAuthenticated(formerAdmin.session,'identity.share',{projectId:project.id,personId:colleague.person.id,access:'editor'}));
  assert.deepEqual(await host.callAuthenticated(colleague.session,'projects.list',{}),[]);
});

test('only the submitting person reads the turn client key for lost-reply reconciliation',async()=>{
  const {host}=open();const project=value(await host.call('projects.create',{name:'Reconciliation',kind:'folder'}));
  const invitation=value(await host.call('identity.invite',{role:'member'}));const writer=value(await host.acceptInvitation(invitation.token,'Writer'));
  value(await host.call('identity.share',{projectId:project.id,personId:writer.person.id,access:'editor'}));
  const clientKey=randomUUID();const sent=value(await host.callAuthenticated(writer.session,'turns.send',{projectId:project.id,text:'Write a brief',settings,attachments:[],clientKey}));await idle(host,sent.threadId);
  assert.equal(value(await host.callAuthenticated(writer.session,'threads.get',{id:sent.threadId})).turns[0].clientKey,clientKey);
  const other=value(await host.acceptInvitation(value(await host.call('identity.invite',{role:'guest'})).token,'Reader'));
  value(await host.call('identity.share',{projectId:project.id,personId:other.person.id,access:'viewer'}));
  assert.equal(value(await host.callAuthenticated(other.session,'threads.get',{id:sent.threadId})).turns[0].clientKey,undefined);
});
