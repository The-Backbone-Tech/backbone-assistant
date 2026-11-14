import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Adapter} from 'chat';
import {Ledger} from '../src/ledger.ts';
import {deliveries} from '../src/delivery.ts';
import {startChannels} from '../src/index.ts';
import {fakeProvider} from './fake-providers.ts';

test('posts requested after delivery close are journaled and replay only with binding authority',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channel-close-post-')),fake=await fakeProvider('telegram');
 let ledger:Ledger|undefined=new Ledger(home),service:Awaited<ReturnType<typeof startChannels>>|undefined,calls=0;
 const adapter={async postMessage(){calls++;}} as unknown as Adapter;
 const options={home,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
 const paired='paired:telegram:1',needed='text-needed:telegram:2',refused='refused:telegram:8:0';
 try{
  ledger.pair('telegram','7',ledger.invite());const authority={sender:'7',generation:ledger.bindingVersion('telegram','7')};
  const delivery=deliveries(ledger,{telegram:adapter});await delivery.close();
  await delivery.post(paired,'telegram','telegram:1','Account bound.',authority);
  await delivery.post(needed,'telegram','telegram:1','Please send text.',authority);
  await delivery.post(refused,'telegram','telegram:8','This account is not bound.');
  assert.equal(calls,0);
  for(const id of [paired,needed,refused])assert.deepEqual(ledger.delivery(id),{state:'pending',attempts:0});
  ledger.close();ledger=undefined;
  service=await startChannels(undefined,options);await service.idle();
  assert.deepEqual(fake.posts().map(p=>p.text),['Account bound.','Please send text.']);
  for(const id of [paired,needed])assert.deepEqual(service.ledger.delivery(id),{state:'delivered',attempts:1});
  assert.deepEqual(service.ledger.delivery(refused),{state:'failed',attempts:0});
  assert.equal(service.ledger.outgoing().some(m=>m.id===refused),false);
  await service.close();service=await startChannels(undefined,options);await service.idle();
  assert.equal(fake.posts().length,2);
 }finally{ledger?.close();await service?.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
