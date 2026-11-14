import {TEST_HANG_MS} from '../../../../scripts/lib/test-hang.ts';
import { enableConnector } from '@backbone-next/platform/testing/connectors';
// A channel job reaches a real Host connector UNKNOWN against a local MCP endpoint.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome as freshHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { toolWorld } from '@backbone-next/platform/testing/tools';
import { startChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { slackMessage, telegramMessage } from './messages.ts';

import {fakeRead,hostState} from './decision-fixtures.ts';

for(const provider of ['slack','telegram'] as const)test(`${provider} directs an unresolved connector read to Needs you in the app, once and only for its thread`,async()=>{
 const remote=await fakeRead(),world=toolWorld({seed:false}),home=freshHome(),fake=await fakeProvider(provider);
 writeFileSync(world.files.claude,JSON.stringify({mcpServers:{notes:{type:'http',url:remote.url}}}));
 const model=await startScriptedModel(`channel-connector-${provider}`,messages=>messages.some(m=>m.role==='tool')?{text:'Finished connector attempt.'}:{calls:[{name:'mcp__notes__lookup',args:{}}]});
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const host=createHost({home,harness:'harness-pi',connectors:{env:world.toolEnv,sources:['claude-code'],callTimeoutMs:1000}});
 const until=hostState(host,()=>JSON.stringify({calls:remote.calls(),modelRequests:model.requests.length}));
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 const settings={permission:'ask',model:model.model,effort:3,mode:'chat',runsOn:'this-computer'} as const;
 try{
  const listed=await host.call('connectors.refresh',{serverId:'claude-code:notes'});assert.ok(listed.ok);assert.equal(listed.value.problem,undefined);
  assert.ok((await enableConnector(host, 'claude-code:notes')).ok);
  assert.ok((await enableConnector(host, 'claude-code:notes', 'lookup')).ok);
  const p=await host.call('projects.create',{name:'Channel read decision',kind:'folder'});assert.ok(p.ok);
  const options={home,projectId:p.value.id,settings,[provider]:provider==='slack'?{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'}:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
  service=await startChannels(host,options);
  fake.events(r=>service!.webhook(provider,r));service.ledger.pair(provider,provider==='slack'?'T1:U1':'7',service.ledger.invite());
  await fake.emit((provider==='slack'?slackMessage:telegramMessage)(1,'Look up a note'));
  await until(async()=>{
   const threads=await host.call('threads.list',{});if(threads.length!==1)return false;
   const t=await host.call('threads.get',{id:threads[0].id});
   return t.ok&&t.value.turns.length===1&&t.value.turns[0].status!=='running'&&!t.value.summary.running;
  });
  const thread=(await host.call('threads.list',{}))[0];
  const now=await host.call('work.now',{projectId:p.value.id});
  const decision=now.needsYou.find(n=>n.kind==='connector-read');
  assert.ok(decision,JSON.stringify({now,thread:await host.call('threads.get',{id:thread.id}),calls:remote.calls(),modelRequests:model.requests}));
  assert.equal(decision.threadId,thread.id);assert.equal(decision.canReconcile,false);
  await service.idle();
  const notices=()=>fake.posts().filter(p=>String(p.text).includes('Needs you')&&/\/decision [a-f0-9]{32} discard/.test(String(p.text)));
  assert.equal(notices().length,1,'the person is told where to answer the decision');
  assert.equal(remote.calls(),1,'the unknown read is not dispatched again');
  await service.close();service=await startChannels(host,options);await service.idle();
  assert.equal(notices().length,1,'the recorded notice is not repeated on restart');
  // A second surface in the same project has its own decision, not this chat's notice.
  const other=await host.call('turns.send',{projectId:p.value.id,text:'A separate caller',attachments:[],settings,clientKey:'unrelated-connector'});assert.ok(other.ok);
  await until(async()=>{const t=await host.call('threads.get',{id:other.value.threadId});return t.ok&&t.value.turns.length===1&&t.value.turns[0].status!=='running'&&!t.value.summary.running;});
  await service.idle();assert.equal(notices().length,1);assert.equal(remote.calls(),2);
  const stillPending=await host.call('work.now',{projectId:p.value.id});
  assert.equal(stillPending.needsYou.filter(n=>n.kind==='connector-read').length,2,'no person decision is taken by the channel');
 }finally{
  await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();await remote.close();world.remove();
  delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;
 }
});

test('an in-flight read that succeeds gets no decision notice when another surface emits Host events',async()=>{
 const remote=await fakeRead('complete'),world=toolWorld({seed:false}),home=freshHome(),fake=await fakeProvider('telegram');
 writeFileSync(world.files.claude,JSON.stringify({mcpServers:{notes:{type:'http',url:remote.url}}}));
 const model=await startScriptedModel('channel-successful-connector',messages=>{
  const c=messages.findLast(m=>m.role==='user')?.content;
  const asked=typeof c==='string'?c:(c??[]).map(p=>p.text??'').join('');
  if(asked.startsWith('Other caller')||messages.some(m=>m.role==='tool'))return {text:'Done.'};
  return {calls:[{name:'mcp__notes__lookup',args:{}}]};
 });
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 // The fixture releases its response explicitly; this deadline only detects a hung fixture.
 const host=createHost({home,harness:'harness-pi',connectors:{env:world.toolEnv,sources:['claude-code'],callTimeoutMs:TEST_HANG_MS}});
 const until=hostState(host,()=>JSON.stringify({calls:remote.calls(),modelRequests:model.requests.length}));
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 const settings={permission:'ask',model:model.model,effort:3,mode:'chat',runsOn:'this-computer'} as const;
 try{
  const listed=await host.call('connectors.refresh',{serverId:'claude-code:notes'});assert.ok(listed.ok);assert.equal(listed.value.problem,undefined);
  assert.ok((await enableConnector(host, 'claude-code:notes')).ok);
  assert.ok((await enableConnector(host, 'claude-code:notes', 'lookup')).ok);
  const p=await host.call('projects.create',{name:'Successful read',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(host,{home,projectId:p.value.id,settings,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;fake.events(r=>active.webhook('telegram',r));active.ledger.pair('telegram','7',active.ledger.invite());
  await fake.emit(telegramMessage(1,'Read a note'));await remote.called;
  const pending=await host.call('work.now',{projectId:p.value.id});assert.ok(pending.needsYou.some(n=>n.kind==='connector-read'));
  const other=await host.call('turns.send',{projectId:p.value.id,text:'Other caller',attachments:[],settings,clientKey:'successful-read-other'});assert.ok(other.ok);
  await until(async()=>{const t=await host.call('threads.get',{id:other.value.threadId});return t.ok&&t.value.turns.some(t=>t.completed);});
  await active.idle();assert.ok(!fake.posts().some(p=>String(p.text).includes('needs your decision')));
  remote.release();
  await until(async()=>{const t=(await host.call('threads.list',{})).find(t=>t.id!==other.value.threadId);if(!t)return false;const v=await host.call('threads.get',{id:t.id});return v.ok&&v.value.turns.some(t=>t.completed);});
  await active.idle();assert.ok(!fake.posts().some(p=>String(p.text).includes('needs your decision')));
  assert.ok(!(await host.call('work.now',{projectId:p.value.id})).needsYou.some(n=>n.kind==='connector-read'));
  assert.equal(remote.calls(),1);
 }finally{
  remote.release();await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();await remote.close();world.remove();
  delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;
 }
});
