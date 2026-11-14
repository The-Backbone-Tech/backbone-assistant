import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome as freshHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel } from '@backbone-next/platform/testing';
import { startChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { telegramMessage } from './messages.ts';
import type { ChannelHost } from '../src/host-consumer.ts';
const settings={permission:'ask',model:'restart-script',effort:3,mode:'chat',runsOn:'this-computer'} as const;
async function until(fn:()=>Promise<boolean>) {for(let n=0;n<600;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition did not become true');}
test('restart processes queued intake once, including an unconfirmed Host acknowledgement',async()=>{
 let release!:()=>void; const gate=new Promise<void>(r=>release=r);let entered=false;
 const model=await startScriptedModel('restart-script',()=>({text:'Finished.'}),{before:async()=>{entered=true;await gate;}});
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram');
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try {
  const p=await host.call('projects.create',{name:'Restart',kind:'folder'});assert.ok(p.ok);
  const options={home,projectId:p.value.id,settings,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
  let lost=true;
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){const result=await host.call(method,args);if(method==='turns.send'&&lost){throw new Error('simulated lost acknowledgement');}return result;}};
  service=await startChannels(proxy,options);const active=()=>service!;
  fake.events(r=>active().webhook('telegram',r));
  service.ledger.pair('telegram','7',service.ledger.invite());
  await fake.emit(telegramMessage(1,'one'));await until(async()=>entered);
  await fake.emit(telegramMessage(2,'two'));await fake.emit(telegramMessage(3,'three'));
  assert.equal(service.ledger.pending().length,3,'unconfirmed admission stays in intake');
  await service.close();lost=false;release();
  await until(async()=>!(await host.call('threads.list',{}))[0].running);
  service=await startChannels(host,options);
  await service.idle();
  await until(async()=>{const ts=await host.call('threads.list',{});if(ts.length!==1)return false;const t=await host.call('threads.get',{id:ts[0].id});return t.ok&&t.value.turns.length===3&&!t.value.summary.running;});
  const ts=await host.call('threads.list',{});const t=await host.call('threads.get',{id:ts[0].id});assert.ok(t.ok);
  assert.deepEqual(t.value.turns.map(turn=>turn.user.text),['one','two','three']);
  assert.equal(service.ledger.pending().length,0);
  await fake.emit(telegramMessage(2,'two'));await service.idle();
  const repeated=await host.call('threads.get',{id:ts[0].id});assert.ok(repeated.ok);assert.equal(repeated.value.turns.length,3);
  await assert.rejects(startChannels(host,options),/already runs/);
 } finally {release();await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});

test('unbinding during a running turn prevents its queued successor from starting',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered=false;
 const model=await startScriptedModel('restart-script',()=>({text:'Finished.'}),{before:async()=>{entered=true;await gate;}});
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram');
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try {
  const p=await host.call('projects.create',{name:'Revoke',kind:'folder'});assert.ok(p.ok);
  service=await startChannels(host,{home,projectId:p.value.id,settings,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;fake.events(r=>active.webhook('telegram',r));
  active.ledger.pair('telegram','7',active.ledger.invite());
  await fake.emit(telegramMessage(1,'one'));await until(async()=>entered);
  await fake.emit(telegramMessage(2,'queued'));
  active.ledger.unbind('telegram','7');release();await active.idle();
  const list=await host.call('threads.list',{});const thread=await host.call('threads.get',{id:list[0].id});assert.ok(thread.ok);
  assert.deepEqual(thread.value.turns.map(t=>t.user.text),['one']);
  assert.equal(active.ledger.pending().length,0);
 } finally {release();await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
