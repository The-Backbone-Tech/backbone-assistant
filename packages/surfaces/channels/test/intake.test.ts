import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { slackMessage, telegramMessage } from './messages.ts';
for (const provider of ['slack','telegram'] as const) test(`${provider} durable duplicate intake and overlapping messages retain order`, async () => {
  const home=mkdtempSync(join(tmpdir(),'channel-intake-')), fake=await fakeProvider(provider);
  let release!:()=>void; const gate=new Promise<void>(r=>release=r); const seen:string[]=[];
  const service=await startChannels(undefined,{home,[provider]:provider==='slack'?{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'}:{token:'fake',secret:'test-signing',apiUrl:fake.url},consume:async m=>{seen.push(m.text);if(m.text==='one')await gate;}});
  service.ledger.pair(provider,provider==='slack'?'T1:U1':'7',service.ledger.invite());
  fake.events(r=>service.webhook(provider,r));
  const message=provider==='slack'?slackMessage:telegramMessage;
  try {
    await fake.emit(message(1,'one'));
    await Promise.all([fake.emit(message(2,'two')),fake.emit(message(3,'three'))]);
    await fake.emit(message(1,'one'));
    assert.equal(service.ledger.pending().length,3);
    // 'two' and 'three' are sent at the same moment, so which arrives first is not fixed: the order that must be kept is the
    // order in which the journal recorded them, with 'one' first because it arrived alone.
    const arrival=service.ledger.pending().map(m=>m.text);
    assert.equal(arrival[0],'one'); assert.deepEqual([...arrival].sort(),['one','three','two']);
    release(); await service.idle();
    assert.deepEqual(seen,arrival);
    assert.equal(service.ledger.pending().length,0);
  } finally {release();await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
