import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome as freshHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { withHomeLock } from '@backbone-next/platform/composition/home-lock';
import type { ChannelHost } from '../src/host-consumer.ts';
import { startChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { telegramMessage } from './messages.ts';
const settings={permission:'ask',model:'authority-script',effort:3,mode:'chat',runsOn:'this-computer'} as const;
async function until(fn:()=>Promise<boolean>|boolean){for(let n=0;n<600;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('authority condition did not become true');}
test('unbind then rebind cannot authorize an earlier queued message',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered=false;
 const model=await startScriptedModel('authority-script',()=>({text:'Done.'}),{before:async()=>{entered=true;await gate;}});
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const p=await host.call('projects.create',{name:'Generation',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(host,{home,projectId:p.value.id,settings,retryBaseMs:10,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});const active=service;fake.events(r=>active.webhook('telegram',r));
  active.ledger.pair('telegram','7',active.ledger.invite());await fake.emit(telegramMessage(1,'first'));await until(()=>entered);
  await fake.emit(telegramMessage(2,'old generation queued'));assert.equal(active.ledger.pending().length,1);
  active.ledger.unbind('telegram','7');active.ledger.pair('telegram','7',active.ledger.invite());release();await active.idle();
  let users:string[]=[];for(const t of await host.call('threads.list',{})){const view=await host.call('threads.get',{id:t.id});if(view.ok)users.push(...view.value.turns.map(t=>t.user.text));}
  assert.deepEqual(users,['first']);
  await fake.emit(telegramMessage(3,'fresh generation'));await active.idle();
  users=[];for(const t of await host.call('threads.list',{})){const view=await host.call('threads.get',{id:t.id});if(view.ok)users.push(...view.value.turns.map(t=>t.user.text));}
  assert.deepEqual(users.sort(),['first','fresh generation']);
 }finally{release();await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
test('a trusted unbind waits for an admission already holding the authority lock',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered=false;const order:string[]=[];
 const model=await startScriptedModel('authority-script',()=>({text:'Done.'}));process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 let unbind:Promise<unknown>|undefined;
 try{
  const p=await host.call('projects.create',{name:'Admission lock',kind:'folder'});assert.ok(p.ok);
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){if(method==='turns.send'){entered=true;await gate;const result=await host.call(method,args);order.push('admitted');return result;}return host.call(method,args);}};
  service=await startChannels(proxy,{home,projectId:p.value.id,settings,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});const active=service;fake.events(r=>active.webhook('telegram',r));active.ledger.pair('telegram','7',active.ledger.invite());
  await fake.emit(telegramMessage(1,'job'));await until(()=>entered);
  unbind=withHomeLock(join(home,'channels','authority'),async()=>{active.ledger.unbindAll();order.push('unbound');});
  await new Promise(r=>setTimeout(r,100));assert.deepEqual(order,[],'the trusted unbind cannot acknowledge ahead of pending admission');
  release();await unbind;await active.idle();assert.deepEqual(order,['admitted','unbound']);
 }finally{release();await unbind;await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
