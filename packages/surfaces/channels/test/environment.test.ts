import https from 'node:https';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackAdapter } from '@chat-adapter/slack';
import { startChannels } from '../src/index.ts';
import { channelAdapters } from '../src/adapters.ts';
import { fakeProvider } from './fake-providers.ts';
import { slackMessage, telegramMessage } from './messages.ts';

test('SDK environment cannot enable forwarding, replace verification, or redirect configured calls',async()=>{
 const home=mkdtempSync(join(tmpdir(),'channels-env-')),slack=await fakeProvider('slack'),telegram=await fakeProvider('telegram'),trap=await fakeProvider('slack');
 const values={SLACK_APP_TOKEN:'unsigned-token',SLACK_SOCKET_FORWARDING_SECRET:'forwarded-secret',SLACK_SIGNING_SECRET:'wrong-secret',SLACK_API_URL:trap.url+'/api/',SLACK_ENCRYPTION_KEY:'not-a-valid-key',TELEGRAM_API_BASE_URL:trap.url,TELEGRAM_WEBHOOK_SECRET_TOKEN:'wrong-secret',TELEGRAM_ALLOW_UNVERIFIED_WEBHOOKS:'true',TELEGRAM_ALLOWED_USER_IDS:'999',TELEGRAM_BOT_USERNAME:'wrong-name'};
 const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 const seen:string[]=[];let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  service=await startChannels(undefined,{home,slack:{token:'fake',signingSecret:'test-signing',apiUrl:slack.url+'/api/'},telegram:{token:'fake',secret:'test-signing',apiUrl:telegram.url},consume:async m=>{seen.push(m.text);}});
  const active=service;slack.events(r=>active.webhook('slack',r));telegram.events(r=>active.webhook('telegram',r));active.ledger.pair('slack','T1:U1',active.ledger.invite());active.ledger.pair('telegram','7',active.ledger.invite());
  const forwarded=new Request('http://localhost/events',{method:'POST',body:JSON.stringify(slackMessage(1,'unsigned')),headers:{'content-type':'application/json','x-slack-socket-token':'unsigned-token'}});
  assert.equal((await active.webhook('slack',forwarded)).status,401);
  assert.equal((await slack.emit(slackMessage(2,'signed'),'test-signing',{'x-slack-socket-token':'forwarded-secret'})).status,401);
  assert.equal((await slack.emit(slackMessage(3,'signed'))).status,200);
  assert.notEqual((await telegram.emit(telegramMessage(4,'wrong'),'wrong-secret')).status,200);
  await telegram.emit(telegramMessage(5,'private'));await active.idle();
  assert.deepEqual(seen.sort(),['private','signed']);assert.equal(trap.requests.length,0);
  // Intercept the pinned SDK's HTTP transports to inspect the production destination without any outside call.
  const defaults=channelAdapters({slack:{token:'fake',signingSecret:'test-signing'},telegram:{token:'fake',secret:'test-signing'}});
  const networkGuard=mock.method(https,'request',()=>{throw new Error('An outside HTTP call was attempted by the test.');});
  const client=Reflect.get(defaults.slack as SlackAdapter,'_client');
  const axios=Reflect.get(client,'axios') as {defaults:{adapter:(config:{baseURL:string;url:string})=>Promise<unknown>}};
  let slackUrl='';axios.defaults.adapter=async config=>{slackUrl=new URL(config.url,config.baseURL).href;return {status:200,statusText:'OK',headers:{},request:{path:'/api/chat.postMessage'},config,data:{ok:true,ts:'1',channel:'D1'}};};
  await defaults.slack.postMessage('slack:D1:',{raw:'probe'});assert.equal(slackUrl,'https://slack.com/api/chat.postMessage');
  const original=globalThis.fetch;let telegramUrl='';
  try{globalThis.fetch=async input=>{telegramUrl=String(input);return Response.json({ok:true,result:{message_id:1,date:0,chat:{id:1,type:'private'},text:'probe'}});};await defaults.telegram.postMessage('telegram:1',{raw:'probe'});}finally{globalThis.fetch=original;}
  assert.equal(telegramUrl,'https://api.telegram.org/botfake/sendMessage');
  networkGuard.mock.restore();
 }finally{mock.restoreAll();await service?.close();for(const[k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;await slack.close();await telegram.close();await trap.close();rmSync(home,{recursive:true,force:true});}
});
