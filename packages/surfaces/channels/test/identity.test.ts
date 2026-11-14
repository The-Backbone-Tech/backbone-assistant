import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { telegramMessage } from './messages.ts';
test('unbound refusal is once; one-time pairing authorizes, unbinding stops next message', async()=>{
 const home=mkdtempSync(join(tmpdir(),'channel-identity-')),fake=await fakeProvider('telegram'),seen:string[]=[];
 const service=await startChannels(undefined,{home,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url},consume:async m=>{seen.push(m.text);}});
 fake.events(r=>service.webhook('telegram',r));
 const emit=async(id:number,text:string)=>{await fake.emit(telegramMessage(id,text));await service.idle();};
 try {
  await emit(1,'hello');await emit(2,'again');
  assert.equal(seen.length,0);assert.equal(fake.requests.filter(r=>r.path.endsWith('/sendMessage')).length,1);
  const code=service.ledger.invite();await emit(3,code);await emit(4,'job');
  assert.deepEqual(seen,['job']);
  service.ledger.unbind('telegram','7');await emit(5,'next');await emit(6,'again');
  assert.deepEqual(seen,['job']);
  assert.equal(fake.requests.filter(r=>r.path.endsWith('/sendMessage')).length,3);
 } finally {await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
