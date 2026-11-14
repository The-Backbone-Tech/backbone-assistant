import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { open,value,idle,settings } from './helpers.ts';

async function colleague(host:ReturnType<typeof open>['host'],role:'member'|'admin'|'guest'='member'){
  const invitation=value(await host.call('identity.invite',{role}));
  return value(await host.acceptInvitation(invitation.token,'Colleague'));
}

test('a project hint cannot authorize another thread or material, including after sharing is revoked',async()=>{
  const {host}=open(),person=await colleague(host);
  const privateProject=value(await host.call('projects.create',{name:'Private owner project',kind:'folder'}));
  const own=value(await host.callAuthenticated(person.session,'projects.create',{name:'Member project',kind:'folder'}));
  const sent=value(await host.call('turns.send',{projectId:privateProject.id,text:'Private owner words',attachments:[],settings,clientKey:randomUUID()}));
  await idle(host,sent.threadId);
  const file=value(await host.call('material.attach',{projectId:privateProject.id,name:'Private.txt',base64:Buffer.from('Private file').toString('base64'),mediaType:'text/plain'}));
  const forged={id:sent.threadId,projectId:own.id};
  await assert.rejects(host.callAuthenticated(person.session,'threads.get',forged));
  await assert.rejects(host.callAuthenticated(person.session,'threads.get',{id:randomUUID(),projectId:own.id} as typeof forged));
  await assert.rejects(host.callAuthenticated(person.session,'material.read',{id:file.id,projectId:own.id} as {id:string}));
  value(await host.call('identity.share',{projectId:privateProject.id,personId:person.person.id,access:'viewer'}));
  assert.ok(value(await host.callAuthenticated(person.session,'threads.get',{id:sent.threadId})).turns.length);
  await assert.rejects(host.callAuthenticated(person.session,'threads.get',forged),'even two visible projects cannot be substituted');
  value(await host.call('identity.share',{projectId:privateProject.id,personId:person.person.id,access:null}));
  await assert.rejects(host.callAuthenticated(person.session,'threads.get',forged));
});

test('a downgraded author cannot rename archive delete stop or save through a project they still edit',async()=>{
  const {host}=open(),person=await colleague(host);
  const project=value(await host.call('projects.create',{name:'Shared work',kind:'folder'}));
  const own=value(await host.callAuthenticated(person.session,'projects.create',{name:'Still writable',kind:'folder'}));
  value(await host.call('identity.share',{projectId:project.id,personId:person.person.id,access:'editor'}));
  const sent=value(await host.callAuthenticated(person.session,'turns.send',{projectId:project.id,text:'Member words',attachments:[],settings,clientKey:randomUUID()}));
  await idle(host,sent.threadId);
  const file=value(await host.call('material.attach',{projectId:project.id,name:'Notes.txt',base64:Buffer.from('Human original').toString('base64'),mediaType:'text/plain'}));
  value(await host.call('identity.share',{projectId:project.id,personId:person.person.id,access:'viewer'}));
  for(const patch of [{title:'Changed'},{archived:true}]) await assert.rejects(host.callAuthenticated(person.session,'threads.update',{id:sent.threadId,projectId:own.id,patch} as {id:string;patch:typeof patch}));
  await assert.rejects(host.callAuthenticated(person.session,'threads.delete',{id:sent.threadId,projectId:own.id} as {id:string}));
  await assert.rejects(host.callAuthenticated(person.session,'turns.stop',{threadId:sent.threadId,projectId:own.id} as {threadId:string}));
  await assert.rejects(host.callAuthenticated(person.session,'material.save',{id:file.id,text:'Overwrite',baseVersion:1}));
  await assert.rejects(host.callAuthenticated(person.session,'material.lifecycle',{id:file.id,version:1,state:'withdrawn'}));
  assert.equal(value(await host.call('material.read',{id:file.id})).text,'Human original');
  assert.notEqual(value(await host.call('threads.get',{id:sent.threadId})).summary.archived,true);
});

test('the device owner cannot read a member private project through local Host data',async()=>{
  const {host}=open(),person=await colleague(host);
  const project=value(await host.callAuthenticated(person.session,'projects.create',{name:'Member private project',kind:'folder'}));
  assert.ok(!(await host.call('projects.list',{})).some(row=>row.id===project.id));
  await assert.rejects(host.call('files.list',{projectId:project.id}));
});

test('company configuration refuses invitation-code acceptance without contacting the provider',async()=>{
  const {host}=open(undefined,{identity:{company:{issuer:'https://provider.example.invalid',clientId:'fixture',redirectUri:'http://127.0.0.1/callback'}}});
  const invitation=value(await host.call('identity.invite',{role:'member'}));
  await assert.rejects(host.acceptInvitation(invitation.token,'Bypass identity provider'));
  const people=value(await host.call('identity.get',{})).people;
  assert.equal(people.length,1);
});

test('an admin who loses project access cannot run a named person automation',async()=>{
  const {host}=open(),admin=await colleague(host,'admin'),member=await colleague(host);
  const project=value(await host.call('projects.create',{name:'Named automation',kind:'folder'}));
  for(const person of [admin,member])value(await host.call('identity.share',{projectId:project.id,personId:person.person.id,access:'editor'}));
  const automation=value(await host.callAuthenticated(admin.session,'identity.automation.create',{projectId:project.id,personId:member.person.id,name:'Named helper'}));
  value(await host.call('identity.share',{projectId:project.id,personId:admin.person.id,access:null}));
  await assert.rejects(host.callAuthenticated(admin.session,'identity.automation.run',{id:automation.id,text:'Unauthorized request'}));
  assert.equal((await host.call('threads.list',{})).length,0);
});


test('the device can list its projects through a read-only Core link without a write crossing',async()=>{
 const {host,home}=open();const project=value(await host.call('projects.create',{name:'Read-only listing',kind:'folder'}));
 await host.close();
 const readonly=open(home,{readOnly:true}).host;
 assert.ok((await readonly.call('projects.list',{})).some(row=>row.id===project.id));
});
