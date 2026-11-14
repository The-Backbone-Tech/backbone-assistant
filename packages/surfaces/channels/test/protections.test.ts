import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChannels, serveChannels } from '../src/index.ts';
import { fakeProvider } from './fake-providers.ts';
import { slackMessage, telegramMessage } from './messages.ts';

test('Slack HTTP verifies signatures and freshness, pairs through rendered text, and filters bots',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-protection-')),fake=await fakeProvider('slack'),seen:string[]=[];
 const service=await startChannels(undefined,{home,slack:{token:'fake',signingSecret:'test-signing',apiUrl:fake.url+'/api/'},consume:async m=>{seen.push(m.text);}}),listener=await serveChannels(service,0);
 const send=(payload:unknown,age=0,bad=false)=>{
  const body=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000)-age);
  return fetch(`http://127.0.0.1:${listener.port}/channels/slack`,{method:'POST',body,headers:{'content-type':'application/json','x-slack-request-timestamp':timestamp,'x-slack-signature':bad?'v0=bad':`v0=${createHmac('sha256','test-signing').update(`v0:${timestamp}:${body}`).digest('hex')}`}});
 };
 try{
  assert.equal((await send(slackMessage(1,'bad signature'),0,true)).status,401);
  assert.equal((await send(slackMessage(2,'stale timestamp'),600)).status,401);
  assert.equal(service.ledger.intakeCount(),0);assert.equal(fake.posts().length,0);
  const code=service.ledger.invite();assert.match(code,/^[0-9a-f]{48}$/);
  assert.equal((await send(slackMessage(3,code))).status,200);await service.idle();assert.equal(service.ledger.bound('slack','T1:U1'),true);assert.deepEqual(seen,[]);
  await send(slackMessage(4,'ordinary job'));await service.idle();assert.deepEqual(seen,['ordinary job']);
  const before=service.ledger.intakeCount(),posts=fake.posts().length;
  await send({...slackMessage(5,'bot job'),event:{...slackMessage(5,'bot job').event,bot_id:'OTHER_BOT'}});await service.idle();
  assert.equal(service.ledger.intakeCount(),before);assert.equal(fake.posts().length,posts);assert.deepEqual(seen,['ordinary job']);
 }finally{await listener.close();await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
test('Telegram foreign bots cannot journal work, including the command path',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-bot-')),fake=await fakeProvider('telegram'),seen:string[]=[];
 const service=await startChannels(undefined,{home,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url},consume:async m=>{seen.push(m.text);}});
 fake.events(r=>service.webhook('telegram',r));service.ledger.pair('telegram','7',service.ledger.invite());
 try{
  for(const command of [false,true]){const fixture=telegramMessage(command?2:1,command?'/status release':'bot job');await fake.emit({...fixture,message:{...fixture.message,from:{...fixture.message.from,is_bot:true},...(command?{entities:[{type:'bot_command',offset:0,length:7}]}:{})}});}
  await service.idle();assert.deepEqual(seen,[]);assert.equal(service.ledger.intakeCount(),0);assert.equal(fake.posts().length,0);
 }finally{await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});
