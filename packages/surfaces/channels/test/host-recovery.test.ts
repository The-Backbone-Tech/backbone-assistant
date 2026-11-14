import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome as freshHome } from '@backbone-next/platform/testing/data-home';
import { startScriptedModel, type Message } from '@backbone-next/platform/testing';
import { startChannels } from '../src/index.ts';
import type { ChannelHost } from '../src/host-consumer.ts';
import { fakeProvider } from './fake-providers.ts';
import { telegramMessage } from './messages.ts';
const settings={permission:'ask',model:'recovery-script',effort:3,mode:'chat',runsOn:'this-computer'} as const;
const asked=(ms:Message[])=>{const c=ms.findLast(m=>m.role==='user')?.content;return typeof c==='string'?c:(c??[]).map(p=>p.text??'').join('');};
async function until(fn:()=>Promise<boolean>|boolean){for(let n=0;n<600;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('recovery condition did not become true');}

test('a real NOT_AVAILABLE race retries, another conversation runs, and a deleted mapping is replaced',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let scheduleEntered=false;
 const model=await startScriptedModel('recovery-script',m=>({text:`Done: ${asked(m)}`}),{before:async m=>{if(asked(m)==='scheduled work'){scheduleEntered=true;await gate;}}});
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const p=await host.call('projects.create',{name:'Recovery',kind:'folder'});assert.ok(p.ok);
  let injected=false;const attempts:number[]=[];
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){
   if(method==='turns.send' && 'text' in args && args.text==='race'){
    attempts.push(Date.now());
    if(!injected){injected=true;const send=args as Parameters<typeof host.call<'turns.send'>>[1];assert.ok((await host.call('turns.send',{...send,text:'scheduled work',clientKey:'schedule-race'})).ok);}
   }
   return host.call(method,args);
  }};
  service=await startChannels(proxy,{home,projectId:p.value.id,settings,retryBaseMs:10,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;fake.events(r=>active.webhook('telegram',r));active.ledger.pair('telegram','7',active.ledger.invite());
  await fake.emit(telegramMessage(1,'seed'));await active.idle();
  await until(async()=>!(await host.call('threads.list',{}))[0].running);
  const old=(await host.call('threads.list',{}))[0].id;
  await fake.emit(telegramMessage(2,'race'));await until(()=>scheduleEntered);
  const other=telegramMessage(3,'other conversation');other.message.chat.id=2;await fake.emit(other);
  await until(()=>fake.posts().some(p=>p.text==='Done: other conversation'));
  release();await active.idle();
  assert.ok(attempts.length>=2,'the actual NOT_AVAILABLE result was retried');
  assert.ok(attempts[1]-attempts[0]>=10,'admission retry uses a bounded backoff');
  await until(()=>fake.posts().some(p=>p.text==='Done: race'));
  await until(async()=>(await host.call('threads.delete',{id:old})).ok);
  await fake.emit(telegramMessage(4,'after deletion'));await active.idle();
  await until(()=>fake.posts().some(p=>p.text==='Done: after deletion'));
  const mapping=active.ledger.get<{conversation:string;threadId:string}[]>('conversations')!;
  assert.ok(mapping.some(c=>c.threadId!==old&&c.conversation==='telegram:1'));
 }finally{release();await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});

test('lasting Host refusal is reported while another conversation continues',async()=>{
 const model=await startScriptedModel('recovery-script',()=>({text:'Other conversation finished.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram'),reported:string[]=[];
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  const p=await host.call('projects.create',{name:'Lasting problem',kind:'folder'});assert.ok(p.ok);
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){if(method==='turns.send'&&'text' in args&&args.text==='blocked')return {ok:false,reason:'NOT_AVAILABLE',outcome:'REFUSED',detail:'temporary route refusal'} as never;return host.call(method,args);}};
  service=await startChannels(proxy,{home,projectId:p.value.id,settings,retryBaseMs:10,reportProblem:s=>reported.push(s),telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;fake.events(r=>active.webhook('telegram',r));active.ledger.pair('telegram','7',active.ledger.invite());
  await fake.emit(telegramMessage(1,'blocked'));
  const other=telegramMessage(2,'other');other.message.chat.id=2;await fake.emit(other);
  await until(()=>reported.length>0&&fake.posts().some(p=>p.text==='Other conversation finished.'));
  assert.match(reported[0],/^channels: telegram work is waiting for the Host/);
  assert.equal(active.ledger.pending().filter(m=>m.text==='blocked').length,1);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
