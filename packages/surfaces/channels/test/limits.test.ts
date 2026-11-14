import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome as freshHome } from '@backbone-next/platform/testing/data-home';
import type { ApiEvent } from '@backbone-next/platform';
import { startChannels, Ledger } from '../src/index.ts';
import type { ChannelHost } from '../src/host-consumer.ts';
import { fakeProvider } from './fake-providers.ts';
const settings={permission:'ask',model:'stub',effort:3,mode:'chat',runsOn:'this-computer'} as const;

test('startup never dispatches pending output after revocation or a new binding generation',async()=>{
 for(const rebind of [false,true]){
  const home=mkdtempSync(join(tmpdir(),'channels-output-')),fake=await fakeProvider('telegram');
  const ledger=new Ledger(home);ledger.pair('telegram','7',ledger.invite());
  ledger.createDelivery('queued-answer','telegram','telegram:1','private answer',{sender:'7',generation:ledger.bindingVersion('telegram','7')});
  ledger.unbind('telegram','7');if(rebind)ledger.pair('telegram','7',ledger.invite());ledger.close();
  const service=await startChannels(undefined,{home,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  try{await service.idle();assert.equal(fake.posts().length,0);assert.deepEqual(service.ledger.delivery('queued-answer'),{state:'failed',attempts:0});assert.deepEqual(service.ledger.attempts('queued-answer'),[]);}
  finally{await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
 }
});

test('a stopped notice does not consume the answer id; mutable and oversized progress is not posted',async()=>{
 const home=freshHome(),host=createHost({home}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const p=await host.call('projects.create',{name:'Snapshots',kind:'folder'});assert.ok(p.ok);
  const sent=await host.call('turns.send',{projectId:p.value.id,text:'snapshot seed',attachments:[],settings,clientKey:'snapshot'});assert.ok(sent.ok);
  let receipt=await host.call('threads.get',{id:sent.value.threadId});
  for(let n=0;n<500&&receipt.ok&&receipt.value.summary.running;n++){await new Promise(r=>setTimeout(r,10));receipt=await host.call('threads.get',{id:sent.value.threadId});}
  assert.ok(receipt.ok);const snapshot=structuredClone(receipt.value),turn=snapshot.turns[0];
  turn.status='stopped';turn.completed=false;delete turn.answer;turn.work.steps=[{kind:'note',label:'part'}];
  const listeners=new Set<(e:ApiEvent)=>void>();
  const proxy:ChannelHost={on(fn){listeners.add(fn);return()=>listeners.delete(fn);},async call(method,args){if(method==='threads.get')return {ok:true,value:snapshot} as never;return host.call(method,args);}};
  service=await startChannels(proxy,{home,projectId:p.value.id,settings,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;active.ledger.pair('telegram','7',active.ledger.invite());active.ledger.set('conversations',[{provider:'telegram',conversation:'telegram:1',sender:'7',threadId:snapshot.summary.id,direct:true,bindingVersion:active.ledger.bindingVersion('telegram','7')}]);
  const emit=async()=>{for(const listener of listeners)listener({topic:'threads',id:snapshot.summary.id});await active.idle();};
  await emit();assert.ok(fake.posts().some(p=>p.text==='Work stopped.'));assert.equal(active.ledger.delivery(`answer:${turn.id}`),undefined);
  turn.status='running';turn.work.steps[0].label='partial streaming note';await emit();assert.ok(!fake.posts().some(p=>p.text==='part'||p.text==='partial streaming note'));
  turn.status='done';turn.completed=true;turn.answer={text:'Recovered answer.',files:[]};turn.work.steps=[{kind:'note',label:'Complete commentary.'},{kind:'note',label:'x'.repeat(5000)}];
  await emit();assert.ok(fake.posts().some(p=>p.text==='Recovered answer.'));assert.ok(fake.posts().some(p=>p.text==='Complete commentary.'));assert.ok(!fake.posts().some(p=>String(p.text).startsWith('xxx')));
  assert.equal(active.ledger.delivery(`answer:${turn.id}`)?.state,'delivered');
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();}
});

test('the channel directory is private before service locks, including an existing loose directory',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-mode-'));mkdirSync(join(home,'channels'));chmodSync(join(home,'channels'),0o755);
 const service=await startChannels(undefined,{home});
 try{assert.equal(statSync(join(home,'channels')).mode&0o777,0o700);assert.match(service.ledger.invite(),/^[0-9a-f]{48}$/);}
 finally{await service.close();rmSync(home,{recursive:true,force:true});}
});
