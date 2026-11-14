import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome as freshHome} from '@backbone-next/platform/testing/data-home';
import {startScriptedModel} from '@backbone-next/platform/testing';
import {startChannels} from '../src/index.ts';
import type {ChannelHost} from '../src/host-consumer.ts';
import type {Args} from '@backbone-next/platform';
import {fakeProvider} from './fake-providers.ts';
import {telegramMessage} from './messages.ts';
const settings={permission:'ask',model:'permanent-refusal',effort:3,mode:'chat',runsOn:'this-computer'} as const;
async function until(fn:()=>Promise<boolean>|boolean){for(let n=0;n<2000;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('refusal condition did not become true');}

test('moving a channel thread replaces its mapping and keeps later intake ordered exactly once',async()=>{
 const model=await startScriptedModel(settings.model,()=>({text:'Taken.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const p=await host.call('projects.create',{name:'Channel',kind:'folder'}),other=await host.call('projects.create',{name:'Moved',kind:'folder'});assert.ok(p.ok&&other.ok);
  service=await startChannels(host,{home,projectId:p.value.id,settings,retryBaseMs:10,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;fake.events(r=>active.webhook('telegram',r));active.ledger.pair('telegram','7',active.ledger.invite());
  await fake.emit(telegramMessage(1,'seed'));await until(()=>fake.posts().some(p=>p.text==='Taken.'));
  const old=(await host.call('threads.list',{}))[0].id;
  await until(async()=>(await host.call('threads.update',{id:old,patch:{projectId:other.value.id}})).ok);
  await fake.emit(telegramMessage(2,'next'));await fake.emit(telegramMessage(3,'last'));
  await until(async()=>{const t=(await host.call('threads.list',{})).find(t=>t.projectId===p.value.id);if(!t)return false;const v=await host.call('threads.get',{id:t.id});return v.ok&&v.value.turns.length===2&&v.value.turns.every(t=>t.completed);});
  await active.idle();
  const threads=await host.call('threads.list',{});assert.equal(threads.length,2);
  const current=threads.find(t=>t.projectId===p.value.id)!;const view=await host.call('threads.get',{id:current.id});assert.ok(view.ok);
  assert.deepEqual(view.value.turns.map(t=>t.user.text),['next','last']);
  await fake.emit(telegramMessage(2,'next'));await active.idle();
  const again=await host.call('threads.get',{id:current.id});assert.ok(again.ok);assert.equal(again.value.turns.length,2);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});

for(const reason of ['INVALID','NOT_FOUND'] as const)test(`an unmapped ${reason} ends after ${reason==='INVALID'?'one attempt':'three durable attempts'}, notifies once, and releases its successor`,async()=>{
 const limit=reason==='INVALID'?1:3,detail=reason==='INVALID'?'This project cannot take that message.':'No such project.';
 const model=await startScriptedModel(settings.model,()=>({text:'Successor taken.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined,attempts=0;
 try{
  const p=await host.call('projects.create',{name:'Refusal',kind:'folder'});assert.ok(p.ok);
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){
   if(method==='turns.send'&&'text' in args&&args.text==='invalid'){
    attempts++;return {ok:false,reason,outcome:'REFUSED',detail} as never;
   }return host.call(method,args);
  }};
  const options={home,projectId:p.value.id,settings,retryBaseMs:10,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
  service=await startChannels(proxy,options);fake.events(r=>service!.webhook('telegram',r));service.ledger.pair('telegram','7',service.ledger.invite());
  let refusedId='';const receive=service.ledger.receive.bind(service.ledger);service.ledger.receive=m=>{if(m.text==='invalid')refusedId=m.id;return receive(m);};
  await fake.emit(telegramMessage(1,'invalid'));await until(()=>attempts===1);
  if(reason!=='INVALID'){await service.close();service=await startChannels(proxy,options);}
  await fake.emit(telegramMessage(2,'successor'));
  await until(()=>fake.posts().some(p=>p.text==='Successor taken.'));
  await service.idle();assert.equal(attempts,limit);
  const notices=()=>fake.posts().filter(p=>p.text===`This message could not be taken: ${detail}`);
  assert.equal(notices().length,1);
  assert.ok(fake.posts().findIndex(p=>String(p.text).startsWith('This message could not'))<fake.posts().findIndex(p=>p.text==='Successor taken.'));
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);
  const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);assert.deepEqual(view.value.turns.map(t=>t.user.text),['successor']);
  const record=service.ledger.intakeStatus('telegram',refusedId);
  assert.deepEqual(record,{state:'refused',refusals:limit,reason,detail});
  await service.close();service=await startChannels(proxy,options);await fake.emit(telegramMessage(1,'invalid'));await service.idle();
  assert.equal(attempts,limit);assert.equal(notices().length,1);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});

test('first admission lost before mapping and moved thread produces a false refusal without a second turn',async()=>{
 const model=await startScriptedModel(settings.model,()=>({text:'First message answer.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined,first=true;
 try{
  const p=await host.call('projects.create',{name:'First message',kind:'folder'}),other=await host.call('projects.create',{name:'Moved first',kind:'folder'});assert.ok(p.ok&&other.ok);
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){
   if(method==='turns.send'&&first){first=false;const result=await host.call('turns.send',args as Args<'turns.send'>);assert.ok(result.ok);
    await until(async()=>{const view=await host.call('threads.get',{id:result.value.threadId});return view.ok&&view.value.turns.every(t=>t.completed);});
    await until(async()=>(await host.call('threads.update',{id:result.value.threadId,patch:{projectId:other.value.id}})).ok);throw new Error('lost acknowledgement');
   }return host.call(method,args);
  }};
  service=await startChannels(proxy,{home,projectId:p.value.id,settings,retryBaseMs:10,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  fake.events(r=>service!.webhook('telegram',r));service.ledger.pair('telegram','7',service.ledger.invite());
  await fake.emit(telegramMessage(1,'first message'));
  await until(()=>fake.posts().some(p=>p.text==='This message could not be taken: Use the active chat project.'));await service.idle();
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);
  assert.deepEqual(view.value.turns.map(t=>t.user.text),['first message']);assert.equal(fake.posts().some(p=>p.text==='First message answer.'),false);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
