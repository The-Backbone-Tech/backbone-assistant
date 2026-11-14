import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {Adapter} from 'chat';
import {Ledger} from '../src/ledger.ts';
import {deliveries} from '../src/delivery.ts';

for(const kind of ['intake-refused','intake-waiting'] as const) test(`${kind} unknown retries a fixed notice and records delivery`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'notice-retry-')),ledger=new Ledger(home),texts:string[]=[],times:number[]=[];
 ledger.pair('telegram','7',ledger.invite());const authority={sender:'7',generation:ledger.bindingVersion('telegram','7')};
 const adapter={async postMessage(_conversation:string,message:{raw:string}){texts.push(message.raw);times.push(Date.now());if(texts.length===1)throw new Error('timeout');}} as unknown as Adapter;
 const delivery=deliveries(ledger,{telegram:adapter}),id=`${kind}:telegram:1`;
 try{
  await delivery.post(id,'telegram','chat','Host detail could contain input',authority);await delivery.idle();
  assert.deepEqual(ledger.attempts(id),['unknown','delivered']);
  assert.equal(texts[1],kind==='intake-waiting'?'This message is kept and will run when the cause clears.':'This message could not be taken.');
  assert.ok(times[1]-times[0]>=900);
 }finally{ledger.close();rmSync(home,{recursive:true,force:true});}
});

test('unknown notices stop after three attempts while unknown answers never retry',async()=>{
 const home=mkdtempSync(join(tmpdir(),'notice-bound-')),ledger=new Ledger(home),texts:string[]=[];
 ledger.pair('telegram','7',ledger.invite());const authority={sender:'7',generation:ledger.bindingVersion('telegram','7')};
 const adapter={async postMessage(_conversation:string,message:{raw:string}){texts.push(message.raw);throw new Error('timeout');}} as unknown as Adapter;
 const delivery=deliveries(ledger,{telegram:adapter});
 try{
  await delivery.post('intake-waiting:telegram:2','telegram','chat','detail',authority);await delivery.idle();
  assert.deepEqual(ledger.attempts('intake-waiting:telegram:2'),['unknown','unknown','unknown']);
  await delivery.replay('intake-waiting:telegram:2');assert.equal(texts.length,3);
  await delivery.post('answer:1','telegram','chat','turn content',authority);
  await delivery.replay('answer:1');assert.deepEqual(ledger.attempts('answer:1'),['unknown']);assert.equal(texts.length,4);
 }finally{ledger.close();rmSync(home,{recursive:true,force:true});}
});

test('revocation during the retry delay prevents the next notice dispatch',async()=>{
 const home=mkdtempSync(join(tmpdir(),'notice-revoke-')),ledger=new Ledger(home);let calls=0;
 ledger.pair('telegram','7',ledger.invite());const authority={sender:'7',generation:ledger.bindingVersion('telegram','7')};
 const adapter={async postMessage(){calls++;ledger.unbind('telegram','7');throw new Error('timeout');}} as unknown as Adapter;
 try{const delivery=deliveries(ledger,{telegram:adapter}),id='intake-refused:telegram:3';await delivery.post(id,'telegram','chat','detail',authority);await delivery.idle();assert.equal(calls,1);assert.deepEqual(ledger.attempts(id),['unknown']);
  assert.deepEqual(ledger.delivery(id),{state:'unknown',attempts:1});
  const db=new DatabaseSync(join(home,'channels','journal.sqlite'));try{assert.equal(db.prepare('SELECT blocked FROM deliveries WHERE id=?').get(id)?.blocked,1);}finally{db.close();}
  assert.equal(ledger.outgoing().some(m=>m.id===id),false);assert.equal(ledger.beginDelivery(id),false);await delivery.replay(id);assert.equal(calls,1);
 }
 finally{ledger.close();rmSync(home,{recursive:true,force:true});}
});

test('a Telegram notice times out at the fake endpoint and the next dispatch is delivered',async()=>{
 const {fakeProvider}=await import('./fake-providers.ts');const {channelAdapters}=await import('../src/adapters.ts');
 const home=mkdtempSync(join(tmpdir(),'notice-timeout-')),ledger=new Ledger(home),fake=await fakeProvider('telegram');
 ledger.pair('telegram','7',ledger.invite());const authority={sender:'7',generation:ledger.bindingVersion('telegram','7')};
 try{
  fake.script('silent');const delivery=deliveries(ledger,channelAdapters({deliveryTimeoutMs:100,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}}));
  const pending=delivery.post('intake-refused:telegram:timeout','telegram','telegram:1','First notice with detail',authority);
  for(let n=0;n<100&&!fake.posts().length;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(fake.posts().length,1);fake.script('ok');await pending;await delivery.idle();
  assert.deepEqual(ledger.attempts('intake-refused:telegram:timeout'),['unknown','delivered']);
  assert.deepEqual(fake.posts().map(p=>p.text),['First notice with detail','This message could not be taken.']);
 }finally{ledger.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});

test('a recovered unknown notice retains its retry count across restart',async()=>{
 const home=mkdtempSync(join(tmpdir(),'notice-recover-'));let ledger=new Ledger(home);let calls=0;
 ledger.pair('telegram','7',ledger.invite());const authority={sender:'7',generation:ledger.bindingVersion('telegram','7')},id='intake-waiting:telegram:restart';
 const adapter={async postMessage(){calls++;throw new Error('timeout');}} as unknown as Adapter;
 try{
  ledger.createDelivery(id,'telegram','chat','detail',authority);assert.equal(ledger.beginDelivery(id),true);ledger.finishDelivery(id,'unknown');ledger.close();
  ledger=new Ledger(home);ledger.recoverDeliveries();assert.equal(ledger.outgoing().some(m=>m.id===id),true);
  const delivery=deliveries(ledger,{telegram:adapter});await delivery.replay(id);await delivery.idle();assert.equal(calls,2);assert.deepEqual(ledger.attempts(id),['unknown','unknown','unknown']);
 }finally{ledger.close();rmSync(home,{recursive:true,force:true});}
});

test('a queued answer passes a timed-out notice before its retry',async()=>{
 const home=mkdtempSync(join(tmpdir(),'notice-fair-')),ledger=new Ledger(home),events:string[]=[];
 ledger.pair('telegram','7',ledger.invite());const authority={sender:'7',generation:ledger.bindingVersion('telegram','7')};
 let started!:()=>void;const firstStarted=new Promise<void>(r=>{started=r;});let attempts=0;
 const adapter={async postMessage(conversation:string){events.push(conversation);if(conversation==='notice'&&++attempts===1){started();await new Promise(r=>setTimeout(r,100));throw new Error('deadline');}}} as unknown as Adapter;
 const delivery=deliveries(ledger,{telegram:adapter});
 try{
  const notice=delivery.post('intake-waiting:telegram:fair','telegram','notice','detail',authority);await firstStarted;
  const answer=delivery.post('answer:fair','telegram','answer','turn content',authority);await Promise.all([notice,answer]);await delivery.idle();
  assert.deepEqual(events,['notice','answer','notice']);assert.deepEqual(ledger.attempts('intake-waiting:telegram:fair'),['unknown','delivered']);
 }finally{await delivery.close();ledger.close();rmSync(home,{recursive:true,force:true});}
});

test('closing during a retry wait cancels the timer and restart replays the notice',async()=>{
 const home=mkdtempSync(join(tmpdir(),'notice-close-'));let ledger=new Ledger(home),calls=0;
 ledger.pair('telegram','7',ledger.invite());const authority={sender:'7',generation:ledger.bindingVersion('telegram','7')},id='intake-refused:telegram:close';
 const adapter={async postMessage(){calls++;if(calls===1)throw new Error('deadline');}} as unknown as Adapter;
 let delivery=deliveries(ledger,{telegram:adapter});const cleared=mock.method(globalThis,'clearTimeout');
 try{
  await delivery.post(id,'telegram','chat','detail',authority);await delivery.close();assert.equal(cleared.mock.callCount(),1);ledger.close();
  await new Promise(r=>setTimeout(r,1100));assert.equal(calls,1);
  ledger=new Ledger(home);ledger.recoverDeliveries();assert.equal(ledger.outgoing().some(m=>m.id===id),true);
  delivery=deliveries(ledger,{telegram:adapter});await delivery.replay(id);await delivery.idle();
  assert.equal(calls,2);assert.deepEqual(ledger.attempts(id),['unknown','delivered']);
 }finally{cleared.mock.restore();await delivery.close();ledger.close();rmSync(home,{recursive:true,force:true});}
});

test('service close cancels notice retry and service restart recovers it',async()=>{
 const {fakeProvider}=await import('./fake-providers.ts');const {startChannels}=await import('../src/index.ts');
 const home=mkdtempSync(join(tmpdir(),'notice-service-close-')),fake=await fakeProvider('telegram'),ledger=new Ledger(home),id='intake-waiting:telegram:service';
 ledger.pair('telegram','7',ledger.invite());const authority={sender:'7',generation:ledger.bindingVersion('telegram','7')};
 ledger.createDelivery(id,'telegram','telegram:1','detail',authority);ledger.beginDelivery(id);ledger.finishDelivery(id,'unknown');ledger.close();
 const options={home,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  service=await startChannels(undefined,options);await service.close();service=undefined;
  await new Promise(r=>setTimeout(r,1100));assert.equal(fake.posts().length,0);
  service=await startChannels(undefined,options);await service.idle();
  assert.deepEqual(service.ledger.attempts(id),['unknown','delivered']);assert.equal(fake.posts().length,1);
 }finally{await service?.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
