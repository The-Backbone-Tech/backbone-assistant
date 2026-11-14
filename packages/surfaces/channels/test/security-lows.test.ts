import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {startChannels,Ledger} from '../src/index.ts';
import {DurableDiscord} from '../src/breadth-adapters.ts';
import {discordMessage,breadthRequest} from './breadth-fixtures.ts';
import {channelDecisions} from '../src/decisions.ts';
import type {ChannelHost,Conversation} from '../src/host-consumer.ts';

test('a raw Discord Gateway message resolved as a group DM never enters intake',async()=>{
 const home=mkdtempSync(join(tmpdir(),'discord-raw-group-'));let lookups=0;
 const fake=createServer((req,res)=>{assert.equal(req.method,'GET');assert.equal(req.url,'/channels/D1');lookups++;res.setHeader('content-type','application/json');res.end(JSON.stringify({type:3}));});
 await new Promise<void>(r=>fake.listen(0,'127.0.0.1',r));const address=fake.address();assert.ok(address&&typeof address!=='string');
 const service=await startChannels(undefined,{home,discord:{token:'fake-discord-token',applicationId:'app-id',publicKey:'a'.repeat(64),apiUrl:`http://127.0.0.1:${address.port}`}});
 try{assert.equal((await service.webhook('discord',breadthRequest('discord',discordMessage(1,'group work')))).status,200);await service.idle();assert.equal(lookups,1);assert.equal(service.ledger.intakeCount(),0);}
 finally{await service.close();fake.closeAllConnections();await new Promise<void>(r=>fake.close(()=>r()));rmSync(home,{recursive:true,force:true});}
});

for(const supplied of ['fake-discord-tokem','x','x'.repeat(200)])test(`Discord forwarding rejects an incorrect token of ${Buffer.byteLength(supplied)} bytes`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'discord-token-'));
 const service=await startChannels(undefined,{home,discord:{token:'fake-discord-token',applicationId:'app-id',publicKey:'a'.repeat(64)}});
 try{const request=breadthRequest('discord',discordMessage(1,'spoof',{channel_type:1}));request.headers.set('x-discord-gateway-token',supplied);assert.equal((await service.webhook('discord',request)).status,401);assert.equal(service.ledger.intakeCount(),0);}
 finally{await service.close();rmSync(home,{recursive:true,force:true});}
});

test('Discord Gateway retries a listener exception and still honors Stop',async()=>{
 const home=mkdtempSync(join(tmpdir(),'discord-listener-retry-')),stop=new AbortController();let attempts=0,problems=0;
 const listener=mock.method(DurableDiscord.prototype,'startGatewayListener',async()=>{if(++attempts===1)throw new Error('local failure');stop.abort();return new Response('{}');});
 const service=await startChannels(undefined,{home,retryBaseMs:1,reportProblem:()=>{problems++;},discord:{token:'fake-discord-token',applicationId:'app-id',publicKey:'a'.repeat(64)}});
 try{await service.discordGateway('http://127.0.0.1/channels/discord',stop.signal);assert.equal(attempts,2);assert.equal(problems,1);}
 finally{listener.mock.restore();await service.close();rmSync(home,{recursive:true,force:true});}
});

test('decision housekeeping removes closed and revoked cards while retaining uncertain active decisions across restart',async()=>{
 const home=mkdtempSync(join(tmpdir(),'decision-housekeeping-'));let ledger=new Ledger(home),calls=0;
 ledger.pair('teams','tenant:person',ledger.invite());
 const conversation:Conversation={provider:'teams',conversation:'teams:private',sender:'tenant:person',threadId:'thread',bindingVersion:ledger.bindingVersion('teams','tenant:person'),direct:true};
 const choice={kind:'connector-read',threadId:'thread',observationId:'read',title:'Retained read',detail:'One response',canReconcile:true} as const;
 const posts:string[]=[];
 const host:ChannelHost={on:()=>()=>{},async call(method){if(method==='threads.get')return {ok:true,value:{summary:{running:false}}} as never;if(method==='work.now')return {needsYou:[choice]} as never;if(method==='connectors.resolveRead'){calls++;throw new Error('lost acknowledgement');}throw new Error('Unexpected method');}};
 const post=async(_id:string,_p:unknown,_c:string,text:string)=>{posts.push(text);};
 try{
  let decisions=channelDecisions(host,ledger,'project',post);await decisions.offer(conversation,choice);
  const code=posts[0].match(/\/decision ([a-f0-9]{32}) discard/)![1];
  const message={provider:'teams',id:'reply',conversation:'teams:private',sender:'tenant:person',bindingVersion:conversation.bindingVersion,direct:true,text:`/decision ${code} discard`} as const;
  await decisions.consume(message);decisions.prune(conversation,[choice]);
  ledger.close();ledger=new Ledger(home);decisions=channelDecisions(host,ledger,'project',post);
  const count=posts.length;await decisions.offer(conversation,choice);assert.equal(posts.length,count);await decisions.consume({...message,id:'duplicate'});assert.equal(calls,1);
  decisions.prune(conversation,[]);assert.deepEqual(ledger.get('read-decisions'),[]);
  await decisions.offer(conversation,{...choice,observationId:'another-read'});ledger.unbind('teams','tenant:person');decisions.prune();assert.deepEqual(ledger.get('read-decisions'),[]);
 }finally{ledger.close();rmSync(home,{recursive:true,force:true});}
});
