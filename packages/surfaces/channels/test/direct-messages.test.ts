import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { slackMessage, telegramMessage } from './messages.ts';
for(const provider of ['slack','telegram'] as const)test(`${provider}: bound and unbound group messages are neither journaled nor answered`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-dm-')),fake=await fakeProvider(provider),seen:string[]=[];
 const service=await startChannels(undefined,{home,[provider]:provider==='slack'?{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'}:{token:'fake',secret:'test-signing',apiUrl:fake.url},consume:async m=>{seen.push(m.text);}});
 fake.events(r=>service.webhook(provider,r));service.ledger.pair(provider,provider==='slack'?'T1:U1':'7',service.ledger.invite());
 try{
  for(const bound of [true,false]){
   const payload=provider==='slack'?{...slackMessage(bound?1:2,'group'),event:{...slackMessage(1,'group').event,channel:'C9',channel_type:'channel',user:bound?'U1':'U2'}}:{...telegramMessage(bound?1:2,'group'),message:{...telegramMessage(bound?1:2,'group').message,chat:{id:-9,type:'supergroup'},from:{id:bound?7:8,is_bot:false,first_name:'Person'}}};
   await fake.emit(payload);
  }
  await service.idle();assert.deepEqual(seen,[]);assert.equal(fake.posts().length,0);assert.equal(service.ledger.intakeCount(),0);
  assert.equal(service.ledger.get('conversations'),undefined);
  await fake.emit((provider==='slack'?slackMessage:telegramMessage)(3,'direct'));await service.idle();assert.deepEqual(seen,['direct']);
 }finally{await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
test('Slack bindings include the team even when a validly signed event repeats the user id',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-team-')),fake=await fakeProvider('slack'),seen:string[]=[];
 const service=await startChannels(undefined,{home,slack:{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'},consume:async m=>{seen.push(m.text);}});
 fake.events(r=>service.webhook('slack',r));service.ledger.pair('slack','T1:U1',service.ledger.invite());
 try{
  const other={...slackMessage(1,'other team'),team_id:'T2'};
  await fake.emit(other);await service.idle();assert.deepEqual(seen,[]);assert.equal(service.ledger.bound('slack','T2:U1'),false);
  await fake.emit(slackMessage(2,'own team'));await service.idle();assert.deepEqual(seen,['own team']);
 }finally{await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
