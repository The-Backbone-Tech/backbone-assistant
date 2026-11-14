import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import https from 'node:https';
import {Socket} from 'node:net';
import {setImmediate as tick} from 'node:timers/promises';
import {hangDetector} from '../../../../scripts/lib/test-hang.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {channelCredentials} from '@backbone-next/platform/credentials/channels';
import {Vault} from '@backbone-next/platform/keys';
import {memoryKeychain,findInHome} from '@backbone-next/platform/testing/keys';
import {Chat,type WebhookOptions} from 'chat';
import {createMemoryState} from '@chat-adapter/state-memory';
import {Ledger,startChannels} from '../src/index.ts';
import {channelAdapters} from '../src/adapters.ts';
import {DurableDiscord} from '../src/breadth-adapters.ts';
import {deliveries} from '../src/delivery.ts';
import {breadthEndpoint,breadthRequest,discordMessage,teamsMessage,verifyRelay} from './breadth-fixtures.ts';
const token=()=>`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.synthetic`;

test('Discord signed pings use its public key, and Gateway group DMs never enter intake',async()=>{
 const home=mkdtempSync(join(tmpdir(),'discord-boundary-')),fake=await breadthEndpoint(),keys=generateKeyPairSync('ed25519');
 const publicKey=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
 const service=await startChannels(undefined,{home,discord:{token:'fake-discord-token',applicationId:'app-id',publicKey,apiUrl:fake.url},consume:async()=>{throw new Error('No work expected');}});
 try{
  const body=JSON.stringify({type:1}),timestamp=String(Math.floor(Date.now()/1000));
  const signature=sign(null,Buffer.from(timestamp+body),keys.privateKey).toString('hex');
  const ping=(signature:string)=>new Request('http://localhost/channels/discord',{method:'POST',body,headers:{'x-signature-ed25519':signature,'x-signature-timestamp':timestamp}});
  assert.equal((await service.webhook('discord',ping(signature))).status,200);
  assert.equal((await service.webhook('discord',ping('0'.repeat(128)))).status,401);
  await service.webhook('discord',breadthRequest('discord',discordMessage(1,'shared work',{channel_type:3})));await service.idle();
  assert.equal(service.ledger.intakeCount(),0);assert.equal(fake.requests.length,0);
 }finally{await service.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});

test('Teams production composition rejects a relay signature without Microsoft authorization',async()=>{
 const home=mkdtempSync(join(tmpdir(),'teams-native-auth-')),fake=await breadthEndpoint();
 const network=mock.method(https,'request',()=>{throw new Error('Outside HTTP is forbidden in this test');});
 let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 try{
  service=await startChannels(undefined,{home,teams:{appId:'app-id',password:'synthetic-password',tenantId:'tenant-one',apiUrl:fake.url}});
  assert.equal((await service.webhook('teams',breadthRequest('teams',teamsMessage(1,'spoof',fake.url)))).status,401);
  assert.equal(service.ledger.intakeCount(),0);assert.equal(network.mock.callCount(),0);
 }finally{network.mock.restore();await service?.close();await fake.close();rmSync(home,{recursive:true,force:true});}
});

for(const provider of ['discord','teams'] as const)test(`${provider} a silent local delivery becomes UNKNOWN after its deadline, with no resend`,async t=>{
 const home=mkdtempSync(join(tmpdir(),'breadth-deadline-')),fake=await breadthEndpoint(),ledger=new Ledger(home);
 const adapters=channelAdapters({deliveryTimeoutMs:50,...(provider==='discord'?{discord:{token:'fake-discord-token',applicationId:'app-id',publicKey:'a'.repeat(64),apiUrl:fake.url}}:{teams:{appId:'app-id',password:'synthetic-password',tenantId:'tenant-one',apiUrl:fake.url,token,webhookVerifier:verifyRelay}})});
 const bot=new Chat({userName:'assistant',adapters,state:createMemoryState(),logger:'silent'}),delivery=deliveries(ledger,adapters);
 try{
  await bot.initialize();ledger.pair(provider,'person',ledger.invite());fake.silence();
  const conversation=provider==='discord'?'discord:@me:D1':adapters.teams.parseMessage(teamsMessage(1,'test',fake.url)).threadId;
  // The deadline is a product property. Freeze it while real HTTP reaches the provider,
  // then expire it explicitly; cold connection startup must not consume the test's 50 ms.
  const timeout=AbortSignal.timeout,socketTimeout=Socket.prototype.setTimeout;let deadlines=0;
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{
   if(ms!==50)return timeout(ms);
   deadlines++;
   const expiry=new AbortController();setTimeout(()=>expiry.abort(new DOMException('Delivery deadline expired','TimeoutError')),ms);return expiry.signal;
  });
  // Socket inactivity timers use Node internals outside MockTimers. The SDK's ordinary
  // request deadline still runs on the controlled setTimeout clock, not this native timer.
  t.mock.method(Socket.prototype,'setTimeout',function(this:Socket,ms:number,callback?:()=>void){if(ms===50){deadlines++;return this;}return socketTimeout.call(this,ms,callback);});
  try{
   // Yield before enabling MockTimers so the shared hang detector keeps its real clock.
   await hangDetector((async()=>{
    await Promise.resolve();t.mock.timers.enable({apis:['setTimeout']});
    try{
     const sent=delivery.post('deadline-answer',provider,conversation,'Answer',{sender:'person',generation:ledger.bindingVersion(provider,'person')});
     await fake.posted;
     assert.ok(deadlines>0,'the request uses the configured 50 ms delivery deadline');
     assert.equal(ledger.delivery('deadline-answer')?.state,'sending');
     t.mock.timers.tick(49);await tick();assert.equal(ledger.delivery('deadline-answer')?.state,'sending');
     t.mock.timers.tick(1);await sent;await delivery.idle();
    }finally{t.mock.timers.reset();}
   })(),`${provider} delivery reaches its controlled deadline`,{diagnostic:()=>JSON.stringify({delivery:ledger.delivery('deadline-answer'),posts:fake.posts().length,deadlines})});
  }finally{t.mock.timers.reset();t.mock.restoreAll();}
  assert.deepEqual(ledger.attempts('deadline-answer'),['unknown']);assert.equal(fake.posts().length,1);
  await delivery.replay('deadline-answer');assert.equal(fake.posts().length,1);
 }finally{await fake.close();await delivery.close();await bot.shutdown();ledger.close();rmSync(home,{recursive:true,force:true});}
});

test('the daemon Gateway loop renews the SDK listener and stops on its abort signal',async()=>{
 const home=mkdtempSync(join(tmpdir(),'discord-gateway-'));let rounds=0;
 const stop=new AbortController();
 const listener=mock.method(DurableDiscord.prototype,'startGatewayListener',async(options:WebhookOptions,_duration?:number,signal?:AbortSignal,url?:string)=>{
  assert.equal(url,'http://127.0.0.1:3038/channels/discord');assert.equal(signal,stop.signal);
  options.waitUntil!(Promise.resolve());if(++rounds===2)stop.abort();return new Response('{}');
 });
 const service=await startChannels(undefined,{home,discord:{token:'fake-discord-token',applicationId:'app-id',publicKey:'a'.repeat(64)}});
 try{await service.discordGateway('http://127.0.0.1:3038/channels/discord',stop.signal);assert.equal(rounds,2);}finally{listener.mock.restore();await service.close();rmSync(home,{recursive:true,force:true});}
});

test('each provider keeps distinct sealed credentials under a memory-held Keychain key',async()=>{
 const home=mkdtempSync(join(tmpdir(),'breadth-sealed-')),keys=memoryKeychain();
 const previous=process.env.BACKBONE_KEYS;delete process.env.BACKBONE_KEYS;
 try{
  const credentials=await channelCredentials(home,keys),canaries:Buffer[]=[];
  for(const provider of ['slack','telegram','discord','teams'] as const){
   const token=`synthetic-${provider}-secret-canary`,verification=`synthetic-${provider}-verification-canary`;
   await credentials.connect(provider,token,verification);canaries.push(Buffer.from(token),Buffer.from(verification));
  }
  const reopened=await channelCredentials(home,keys);
  for(const provider of ['slack','telegram','discord','teams'] as const)assert.deepEqual(await reopened.resolve(provider),{token:`synthetic-${provider}-secret-canary`,verification:`synthetic-${provider}-verification-canary`});
  canaries.push(await (await Vault.open(home,keys)).masterKey());assert.deepEqual(findInHome(home,canaries),[]);
 }finally{Vault.forget(home);if(previous===undefined)delete process.env.BACKBONE_KEYS;else process.env.BACKBONE_KEYS=previous;rmSync(home,{recursive:true,force:true});}
});
