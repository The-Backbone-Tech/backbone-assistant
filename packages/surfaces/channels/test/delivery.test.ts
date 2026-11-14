import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { slackMessage, telegramMessage } from './messages.ts';
for (const provider of ['slack','telegram'] as const) for (const outcome of ['fail','silent'] as const) test(`${provider} ${outcome} delivery is recorded and restart never repeats unknown`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'channel-delivery-')),fake=await fakeProvider(provider);
 const options={home,deliveryTimeoutMs:100,[provider]:provider==='slack'?{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'}:{token:'fake',secret:'test-signing',apiUrl:fake.url}};
 let service=await startChannels(undefined,options);
 fake.events(r=>service.webhook(provider,r));
 try {
  fake.script(outcome);
  await fake.emit((provider==='slack'?slackMessage:telegramMessage)(1,'unbound'));
  await service.idle();
  const id=`refused:${provider}:${provider==='slack'?'T1:U1':'7'}:0`;
  assert.deepEqual(service.ledger.delivery(id),{state:outcome==='fail'?'delivered':'unknown',attempts:outcome==='fail'?2:1});
  assert.deepEqual(service.ledger.attempts(id),outcome==='fail'?['failed','delivered']:['unknown']);
  assert.equal(fake.posts().length,outcome==='fail'?2:1);
  await service.close();
  service=await startChannels(undefined,options);
  await fake.emit((provider==='slack'?slackMessage:telegramMessage)(1,'unbound'));
  await service.idle();
  assert.equal(fake.posts().length,outcome==='fail'?2:1,'neither a delivered nor an unknown notice is resent');
 } finally {await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
