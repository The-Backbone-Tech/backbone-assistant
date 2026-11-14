import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome as freshHome} from '@backbone-next/platform/testing/data-home';
import {withHomeLock,inActiveHomeLockScope} from '@backbone-next/platform/composition/home-lock';
import type {ApiEvent} from '@backbone-next/platform';
import {startChannels,Ledger} from '../src/index.ts';
import type {ChannelHost} from '../src/host-consumer.ts';
import {fakeProvider} from './fake-providers.ts';
import {slackMessage,telegramMessage} from './messages.ts';
const settings={permission:'ask',model:'stub',effort:3,mode:'chat',runsOn:'this-computer'} as const;

test('opening a pre-team Slack binding ends it once and requires a fresh team-scoped pairing',async()=>{
 const home=freshHome(),host=createHost({home}),fake=await fakeProvider('slack');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const seed=new Ledger(home);seed.pair('slack','U1',seed.invite());const before=seed.bindingVersion('slack','U1');seed.pair('slack','T1:U2',seed.invite());seed.close();
  const migrated=new Ledger(home);assert.equal(migrated.bound('slack','U1'),false);assert.equal(migrated.bound('slack','T1:U2'),true);
  const revoked=migrated.bindingVersion('slack','U1');assert.ok(revoked>before);migrated.close();
  const p=await host.call('projects.create',{name:'Upgrade',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(host,{home,projectId:p.value.id,settings,slack:{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'}});
  const active=service;fake.events(r=>active.webhook('slack',r));assert.equal(active.ledger.bindingVersion('slack','U1'),revoked);
  await fake.emit(slackMessage(1,'old account'));await active.idle();assert.deepEqual(await host.call('threads.list',{}),[]);
  assert.ok(fake.posts().some(p=>String(p.text).includes('not bound')));
  await fake.emit(slackMessage(2,active.ledger.invite()));await active.idle();assert.ok(active.ledger.bound('slack','T1:U1'));
  await fake.emit(slackMessage(3,'new job'));await active.idle();assert.equal((await host.call('threads.list',{})).length,1);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();}
});

test('legacy intake without direct attestation is finished silently and null-authority output is blocked on replay',async()=>{
 const home=freshHome(),host=createHost({home}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const seed=new Ledger(home);seed.pair('telegram','7',seed.invite());
  seed.receive({provider:'telegram',conversation:'telegram:1',sender:'7',id:'old-intake',text:'old unauthenticated work'});
  seed.createDelivery('old-output','telegram','telegram:1','old unauthenticated answer');seed.close();
  const p=await host.call('projects.create',{name:'Legacy',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(host,{home,projectId:p.value.id,settings,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  await service.idle();assert.deepEqual(await host.call('threads.list',{}),[]);assert.equal(fake.posts().length,0);
  assert.equal(service.ledger.intakeStatus('telegram','old-intake')?.state,'done');
  assert.deepEqual(service.ledger.delivery('old-output'),{state:'failed',attempts:0});assert.deepEqual(service.ledger.attempts('old-output'),[]);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();}
});

test('listener intake and projection leave the emitting Host home-lock scope',async()=>{
 const home=freshHome(),host=createHost({home}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 const listeners=new Set<(e:ApiEvent)=>void>(),scopes:{method:string;held:boolean}[]=[];
 let entered:()=>void=()=>{};
 const proxy:ChannelHost={on(fn){listeners.add(fn);return()=>listeners.delete(fn);},async call(method,args){scopes.push({method,held:inActiveHomeLockScope(home)});entered();return host.call(method,args);}};
 try{
  const p=await host.call('projects.create',{name:'Listener',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(proxy,{home,projectId:p.value.id,settings,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;await active.idle();active.ledger.pair('telegram','7',active.ledger.invite());
  await withHomeLock(home,async()=>{
   active.ledger.receive({provider:'telegram',conversation:'telegram:1',sender:'7',id:'listener-work',text:'job',direct:true});
   const called=new Promise<void>(r=>entered=r);for(const fn of listeners)fn({topic:'threads'});await called;
   assert.ok(scopes.some(s=>s.method==='turns.send'));assert.ok(scopes.every(s=>!s.held),JSON.stringify(scopes));
  });
  await active.idle();assert.equal((await host.call('threads.list',{})).length,1);scopes.length=0;
  await withHomeLock(home,async()=>{
   const called=new Promise<void>(r=>entered=r);for(const fn of listeners)fn({topic:'threads'});await called;
   assert.ok(scopes.some(s=>s.method==='threads.get'));assert.ok(scopes.every(s=>!s.held),JSON.stringify(scopes));
  });
  await active.idle();
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();}
});

test('a captionless Telegram photo is recorded once, asks for text, and starts no turn',async()=>{
 const home=freshHome(),host=createHost({home}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const p=await host.call('projects.create',{name:'Photo',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(host,{home,projectId:p.value.id,settings,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;fake.events(r=>active.webhook('telegram',r));active.ledger.pair('telegram','7',active.ledger.invite());
  const photo={...telegramMessage(1,''),message:{...telegramMessage(1,'').message,photo:[{file_id:'local-photo',file_unique_id:'unique-local-photo',width:1,height:1}]}};delete (photo.message as {text?:string}).text;
  await fake.emit(photo);
  for(let n=0;n<500&&fake.posts().length===0&&(await host.call('threads.list',{})).length===0;n++)await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(await host.call('threads.list',{}),[]);assert.equal(fake.posts().length,1);
  await active.idle();await fake.emit(photo);await active.idle();
  assert.equal(active.ledger.intakeCount(),1);assert.deepEqual(await host.call('threads.list',{}),[]);
  assert.deepEqual(fake.posts().map(p=>p.text),['Please send text describing the work you want me to do.']);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();}
});
