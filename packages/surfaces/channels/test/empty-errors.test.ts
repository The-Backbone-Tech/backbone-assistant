import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome as freshHome} from '@backbone-next/platform/testing/data-home';
import {startScriptedModel} from '@backbone-next/platform/testing';
import {startChannels} from '../src/index.ts';
import type {ChannelHost} from '../src/host-consumer.ts';
import {fakeProvider} from './fake-providers.ts';
import {slackMessage,telegramMessage} from './messages.ts';
const settings={permission:'ask',model:'channel-errors',effort:3,mode:'chat',runsOn:'this-computer'} as const;
async function until(fn:()=>Promise<boolean>|boolean){for(let n=0;n<600;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('intake error condition did not become true');}

for(const fileShare of [false,true])test(`empty Slack ${fileShare?'file_share':'DM'} asks for text once, creates no thread, and lets the next message run`,async()=>{
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('slack'),model=await startScriptedModel(settings.model,()=>({text:'Real work finished.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const p=await host.call('projects.create',{name:'Empty Slack',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(host,{home,projectId:p.value.id,settings,retryBaseMs:10,slack:{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'}});
  const active=service;fake.events(r=>active.webhook('slack',r));active.ledger.pair('slack','T1:U1',active.ledger.invite());
  const empty={...slackMessage(1,''),event:{...slackMessage(1,'').event,...(fileShare?{subtype:'file_share',files:[{id:'local-file',name:'example.txt',mimetype:'text/plain'}]}:{})}};
  await fake.emit(empty);await fake.emit(empty);
  await until(()=>fake.posts().some(p=>p.text==='Please send text describing the work you want me to do.'));
  await active.idle();assert.deepEqual(await host.call('threads.list',{}),[]);assert.equal(fake.posts().length,1);
  await fake.emit(slackMessage(2,'real work'));await until(()=>fake.posts().some(p=>p.text==='Real work finished.'));await active.idle();
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);
  const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);assert.deepEqual(view.value.turns.map(t=>t.user.text),['real work']);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});

for(const form of ['prefix','reason'] as const)test(`a deterministic Host ${form} error is final on its first attempt and its successor runs`,async()=>{
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram'),model=await startScriptedModel(settings.model,()=>({text:'Successor finished.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 let service:Awaited<ReturnType<typeof startChannels>>|undefined,attempts=0;
 try{
  const p=await host.call('projects.create',{name:'Invalid throw',kind:'folder'});assert.ok(p.ok);
  const detail=form==='prefix'?'invalid: the input is not supported':'The input is not supported';
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){if(method==='turns.send'&&'text' in args&&args.text==='unsupported'){attempts++;throw form==='prefix'?new Error(detail):Object.assign(new Error(detail),{reason:'invalid'});}return host.call(method,args);}};
  const options={home,projectId:p.value.id,settings,retryBaseMs:10,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
  service=await startChannels(proxy,options);fake.events(r=>service!.webhook('telegram',r));service.ledger.pair('telegram','7',service.ledger.invite());
  let id='';const receive=service.ledger.receive.bind(service.ledger);service.ledger.receive=m=>{if(m.text==='unsupported')id=m.id;return receive(m);};
  await fake.emit(telegramMessage(1,'unsupported'));
  await until(()=>fake.posts().some(p=>p.text===`This message could not be taken: ${detail}`));await service.idle();
  assert.equal(attempts,1);assert.deepEqual(service.ledger.intakeStatus('telegram',id),{state:'refused',refusals:1,reason:'INVALID',detail});
  assert.equal(fake.posts().length,1);assert.deepEqual(await host.call('threads.list',{}),[]);
  await fake.emit(telegramMessage(2,'successor'));await until(()=>fake.posts().some(p=>p.text==='Successor finished.'));await service.idle();
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);assert.deepEqual(view.value.turns.map(t=>t.user.text),['successor']);
  await service.close();service=await startChannels(proxy,options);await fake.emit(telegramMessage(1,'unsupported'));await service.idle();
  assert.equal(attempts,1);assert.equal(fake.posts().filter(p=>p.text===`This message could not be taken: ${detail}`).length,1);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});

test('a transient thrown error keeps retrying beyond the permanent limit, then runs once',async()=>{
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram'),model=await startScriptedModel(settings.model,()=>({text:'Recovered transport.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 let service:Awaited<ReturnType<typeof startChannels>>|undefined,attempts=0;
 try{
  const p=await host.call('projects.create',{name:'Transient throw',kind:'folder'});assert.ok(p.ok);
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){if(method==='turns.send'&&++attempts<=4)throw new Error('Connection reset; invalid: is only diagnostic text here.');return host.call(method,args);}};
  service=await startChannels(proxy,{home,projectId:p.value.id,settings,retryBaseMs:10,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;fake.events(r=>active.webhook('telegram',r));active.ledger.pair('telegram','7',active.ledger.invite());
  await fake.emit(telegramMessage(1,'retry transport'));await until(()=>fake.posts().some(p=>p.text==='Recovered transport.'));await active.idle();
  assert.equal(attempts,5);assert.ok(!fake.posts().some(p=>String(p.text).startsWith('This message could not')));
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);assert.equal(view.value.turns.length,1);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
