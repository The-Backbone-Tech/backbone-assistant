import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome as freshHome} from '@backbone-next/platform/testing/data-home';
import type {Args} from '@backbone-next/platform';
import {Ledger,startChannels,type Inbound} from '../src/index.ts';
import {hostConsumer,type ChannelHost} from '../src/host-consumer.ts';
import {channelAdapters} from '../src/adapters.ts';
import {deliveries} from '../src/delivery.ts';
import {fakeProvider} from './fake-providers.ts';
import {telegramMessage} from './messages.ts';
const settings={permission:'ask',model:'stub',effort:3,mode:'chat',runsOn:'this-computer'} as const;
async function until(fn:()=>Promise<boolean>|boolean){for(let n=0;n<600;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('INVALID condition did not become true');}

test('a thrown INVALID preserves the mapped conversation for its successor',async()=>{
 const home=freshHome(),host=createHost({home}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 const calls:Args<'turns.send'>[]=[];
 const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){
  if(method==='turns.send'&&'text' in args&&args.text==='unsupported'){calls.push(args as Args<'turns.send'>);throw new Error('invalid: unsupported input');}
  return host.call(method,args);
 }};
 try{
  const p=await host.call('projects.create',{name:'Mapped invalid',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(proxy,{home,projectId:p.value.id,settings,retryBaseMs:10,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;fake.events(r=>active.webhook('telegram',r));active.ledger.pair('telegram','7',active.ledger.invite());
  await fake.emit(telegramMessage(1,'seed'));
  await until(async()=>{const t=(await host.call('threads.list',{}))[0];if(!t)return false;const v=await host.call('threads.get',{id:t.id});return v.ok&&v.value.turns.some(t=>t.completed);});
  await active.idle();const old=(await host.call('threads.list',{}))[0].id;
  let id='';const receive=active.ledger.receive.bind(active.ledger);active.ledger.receive=m=>{if(m.text==='unsupported')id=m.id;return receive(m);};
  await fake.emit(telegramMessage(2,'unsupported'));await until(()=>fake.posts().some(p=>p.text==='This message could not be taken: invalid: unsupported input'));await active.idle();
  assert.deepEqual(calls.map(c=>c.threadId),[old]);assert.equal(new Set(calls.map(c=>c.clientKey)).size,1);
  assert.deepEqual(active.ledger.intakeStatus('telegram',id),{state:'refused',refusals:1,reason:'INVALID',detail:'invalid: unsupported input'});
  assert.equal((await host.call('threads.list',{})).length,1);
  await fake.emit(telegramMessage(3,'successor'));await active.idle();
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);
  const texts:string[]=[];for(const t of threads){const v=await host.call('threads.get',{id:t.id});assert.ok(v.ok);texts.push(...v.value.turns.map(t=>t.user.text));}
  assert.deepEqual(texts.sort(),['seed','successor']);assert.equal(calls.length,1);
  assert.equal(fake.posts().filter(p=>p.text==='This message could not be taken: invalid: unsupported input').length,1);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();}
});

test('the consumer delivers the real Host empty-message INVALID once, with no chat or retry',async()=>{
 const home=freshHome(),host=createHost({home}),ledger=new Ledger(home),fake=await fakeProvider('telegram');let attempts=0;
 try{
  const p=await host.call('projects.create',{name:'Host empty refusal',kind:'folder'});assert.ok(p.ok);
  ledger.pair('telegram','7',ledger.invite());
  const m:Inbound={provider:'telegram',id:'direct-empty',conversation:'telegram:1',sender:'7',text:' \n\t',direct:true,bindingVersion:ledger.bindingVersion('telegram','7')};
  ledger.receive(m);
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){if(method==='turns.send')attempts++;return host.call(method,args);}};
  const delivery=deliveries(ledger,channelAdapters({telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}}));
  const consumer=hostConsumer(proxy,ledger,{home,projectId:p.value.id,settings},delivery.post,()=>false);
  // Both webhook paths already reject !text.trim(), exactly as the Host does. Exercise
  // the consumer boundary directly instead of inventing a provider bypass.
  assert.equal((await consumer.consume(m)).done,true);await delivery.idle();
  assert.equal(attempts,1);assert.deepEqual(await host.call('threads.list',{}),[]);
  assert.deepEqual(fake.posts().map(p=>p.text),['This message could not be taken: A message needs words; nothing was sent.']);
  assert.deepEqual(ledger.intakeStatus('telegram',m.id),{state:'refused',refusals:1,reason:'INVALID',detail:'A message needs words; nothing was sent.'});
  assert.deepEqual(ledger.pending(),[]);assert.equal(ledger.receive(m),false);
  await consumer.sync();await delivery.idle();assert.equal(attempts,1);assert.equal(fake.posts().length,1);
 }finally{ledger.close();host.close();await removeDataHome(home);await fake.close();}
});
