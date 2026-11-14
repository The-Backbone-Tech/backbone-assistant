import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome as freshHome} from '@backbone-next/platform/testing/data-home';
import {startScriptedModel} from '@backbone-next/platform/testing';
import {startChannels} from '../src/index.ts';
import type {ChannelHost} from '../src/host-consumer.ts';
import {fakeProvider} from './fake-providers.ts';
import {telegramMessage} from './messages.ts';
const settings={permission:'ask',model:'waiting-notice',effort:3,mode:'chat',runsOn:'this-computer'} as const;
async function until(fn:()=>Promise<boolean>|boolean){for(let n=0;n<600;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('waiting notice condition did not become true');}

test('three durable NOT_AVAILABLE receipts notify once across restart and the kept message eventually runs once',async()=>{
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram'),model=await startScriptedModel(settings.model,()=>({text:'Kept message finished.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 let service:Awaited<ReturnType<typeof startChannels>>|undefined,blocked=true,attempts=0;
 const detail='Saved recovery data needs inspection.';
 const notice=`This message is kept and will run when the cause clears: ${detail}`;
 try{
  const p=await host.call('projects.create',{name:'Waiting notice',kind:'folder'});assert.ok(p.ok);
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){if(method==='turns.send'){attempts++;if(blocked)return {ok:false,reason:'NOT_AVAILABLE',outcome:'REFUSED',detail} as never;}return host.call(method,args);}};
  const options={home,projectId:p.value.id,settings,retryBaseMs:100,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
  service=await startChannels(proxy,options);fake.events(r=>service!.webhook('telegram',r));service.ledger.pair('telegram','7',service.ledger.invite());
  let id='';const receive=service.ledger.receive.bind(service.ledger);service.ledger.receive=m=>{id=m.id;return receive(m);};
  await fake.emit(telegramMessage(1,'kept message'));
  await until(()=>attempts>=2);await service.close();
  assert.equal(fake.posts().length,0,'two refusals do not yet notify');assert.equal(attempts,2);
  service=await startChannels(proxy,options);
  await until(()=>fake.posts().some(p=>p.text===notice));
  assert.equal(attempts,3,'restart preserves the first two refusals');
  assert.equal(service.ledger.intakeStatus('telegram',id)?.state,'pending');
  await until(()=>attempts>=5);assert.equal(fake.posts().filter(p=>p.text===notice).length,1,'later refusals in the same streak do not repeat');
  await service.close();service=await startChannels(proxy,options);
  await until(()=>attempts>=6);assert.equal(fake.posts().filter(p=>p.text===notice).length,1,'a further restart does not repeat');
  blocked=false;await until(()=>fake.posts().some(p=>p.text==='Kept message finished.'));await service.idle();
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);
  const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);assert.deepEqual(view.value.turns.map(t=>t.user.text),['kept message']);
  assert.equal(service.ledger.intakeStatus('telegram',id)?.state,'done');assert.equal(fake.posts().filter(p=>p.text===notice).length,1);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});

test('three durable denied throws notify once across restart and the kept message eventually runs once',async()=>{
 const home=freshHome(),host=createHost({home,harness:'harness-pi'}),fake=await fakeProvider('telegram'),model=await startScriptedModel(settings.model,()=>({text:'Kept message finished.'}));
 process.env.BACKBONE_MODEL_ENDPOINT=model.url;process.env.BACKBONE_MODEL_ID=model.model;
 let service:Awaited<ReturnType<typeof startChannels>>|undefined,blocked=true,attempts=0;
 const detail='Saved recovery data needs inspection.';
 const notice='This message is kept and will run when the cause clears.';
 try{
  const p=await host.call('projects.create',{name:'Waiting notice',kind:'folder'});assert.ok(p.ok);
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){if(method==='turns.send'){attempts++;if(blocked)throw Object.assign(new Error(detail),{reason:'denied'});}return host.call(method,args);}};
  const options={home,projectId:p.value.id,settings,retryBaseMs:100,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
  service=await startChannels(proxy,options);fake.events(r=>service!.webhook('telegram',r));service.ledger.pair('telegram','7',service.ledger.invite());
  let id='';const receive=service.ledger.receive.bind(service.ledger);service.ledger.receive=m=>{id=m.id;return receive(m);};
  await fake.emit(telegramMessage(1,'kept message'));
  await until(()=>attempts>=2);await service.close();
  assert.equal(fake.posts().length,0,'two refusals do not yet notify');assert.equal(attempts,2);
  service=await startChannels(proxy,options);
  await until(()=>fake.posts().some(p=>p.text===notice));
  assert.equal(attempts,3,'restart preserves the first two refusals');
  assert.equal(service.ledger.intakeStatus('telegram',id)?.state,'pending');
  await until(()=>attempts>=5);assert.equal(fake.posts().filter(p=>p.text===notice).length,1,'later refusals in the same streak do not repeat');
  await service.close();service=await startChannels(proxy,options);
  await until(()=>attempts>=6);assert.equal(fake.posts().filter(p=>p.text===notice).length,1,'a further restart does not repeat');
  blocked=false;await until(()=>fake.posts().some(p=>p.text==='Kept message finished.'));await service.idle();
  const threads=await host.call('threads.list',{});assert.equal(threads.length,1);
  const view=await host.call('threads.get',{id:threads[0].id});assert.ok(view.ok);assert.deepEqual(view.value.turns.map(t=>t.user.text),['kept message']);
  assert.equal(service.ledger.intakeStatus('telegram',id)?.state,'done');assert.equal(fake.posts().filter(p=>p.text===notice).length,1);
 }finally{await service?.close();host.close();await removeDataHome(home);await fake.close();await model.close();delete process.env.BACKBONE_MODEL_ENDPOINT;delete process.env.BACKBONE_MODEL_ID;}
});
