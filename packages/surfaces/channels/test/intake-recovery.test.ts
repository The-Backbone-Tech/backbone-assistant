import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { slackMessage, telegramMessage } from './messages.ts';

test('Slack retries dispatch after a failed journal write, including its retry header',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-retry-')),fake=await fakeProvider('slack'),seen:string[]=[];
 const service=await startChannels(undefined,{home,slack:{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'},consume:async m=>{seen.push(m.text);}});
 fake.events(r=>service.webhook('slack',r));
 service.ledger.pair('slack','T1:U1',service.ledger.invite());
 const receive=service.ledger.receive.bind(service.ledger);let fail=true;
 service.ledger.receive=m=>{if(fail){fail=false;throw new Error('simulated SQLITE_BUSY');}return receive(m);};
 try{
  assert.equal((await fake.emit(slackMessage(1,'keep this job'))).status,503);
  assert.equal(seen.length,0);assert.equal(service.ledger.pending().length,0);
  assert.equal((await fake.emit(slackMessage(1,'keep this job'),'test-signing',{'x-slack-retry-num':'1'})).status,200);
  await service.idle();assert.deepEqual(seen,['keep this job']);
  await fake.emit(slackMessage(1,'keep this job'),'test-signing',{'x-slack-retry-num':'2'});await service.idle();
  assert.deepEqual(seen,['keep this job']);
 }finally{await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
test('Telegram bot_command entities are durable ordinary messages, once',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-command-')),fake=await fakeProvider('telegram'),seen:string[]=[];
 const service=await startChannels(undefined,{home,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url},consume:async m=>{seen.push(m.text);}});
 fake.events(r=>service.webhook('telegram',r));service.ledger.pair('telegram','7',service.ledger.invite());
 const fixture={...telegramMessage(1,'/status of the release'),message:{...telegramMessage(1,'/status of the release').message,entities:[{type:'bot_command',offset:0,length:7}]}};
 try{assert.equal((await fake.emit(fixture)).status,200);await service.idle();assert.deepEqual(seen,['/status of the release']);await fake.emit(fixture);await service.idle();assert.equal(seen.length,1);}
 finally{await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
