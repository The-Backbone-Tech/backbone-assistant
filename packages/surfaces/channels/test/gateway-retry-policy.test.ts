import '../../../../scripts/lib/test-local-network.cjs';
import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import type {WebhookOptions} from 'chat';
import {gatewayRetry} from '../src/gateway-retry.ts';
import {DurableDiscord} from '../src/breadth-adapters.ts';
import {startChannels} from '../src/service.ts';

test('Gateway failures increase delay to a cap and emit only periodic aggregate notices',()=>{
 const retry=gatewayRetry();const delays:number[]=[],notices:string[]=[];
 for(let n=0;n<100;n++){const result=retry.failed(n*1000);delays.push(result.waitMs);if(result.notice)notices.push(result.notice);}
 assert.ok(delays.slice(0,6).every((value,n,array)=>n===0||value>array[n-1]));
 assert.equal(Math.max(...delays),60_000);assert.equal(delays.at(-1),60_000);
 assert.equal(notices.length,1);
 const summary=retry.failed(300_000);assert.ok(summary.notice);assert.match(summary.notice,/100/);
 assert.equal(retry.failed(301_000).notice,undefined);
 assert.ok(retry.recovered());assert.equal(retry.recovered(),undefined);
 assert.equal(retry.failed(302_000).waitMs,1000);
});

for(const mode of ['throw','early completion'] as const)test('Gateway backs off after '+mode+' and remains abortable',async()=>{
 const home=mkdtempSync(join(tmpdir(),'gateway-backoff-')),stop=new AbortController();let calls=0;const reports:string[]=[];
 const service=await startChannels(undefined,{home,retryBaseMs:10,reportProblem:text=>reports.push(text),discord:{token:'fake',applicationId:'app',publicKey:'a'.repeat(64)}});
 const listener=mock.method(DurableDiscord.prototype,'startGatewayListener',async(options:WebhookOptions)=>{
  calls++;if(calls===5)stop.abort();
  if(mode==='throw'&&!stop.signal.aborted)throw new Error('synthetic revoked token');
  options.waitUntil!(Promise.resolve());return new Response('{}');
 });
 mock.timers.enable({apis:['Date','setTimeout'],now:0});
 try{
  const running=service.discordGateway('http://127.0.0.1/channels/discord',stop.signal);await tick();
  assert.equal(calls,1);
  for(const delay of [10,20,40,80]){mock.timers.tick(delay-1);await tick();const before:number=calls;mock.timers.tick(1);await tick();assert.equal(calls,before+1);}
  await running;assert.equal(calls,5);assert.equal(reports.length,1);
 }finally{stop.abort();mock.timers.reset();listener.mock.restore();await service.close();rmSync(home,{recursive:true,force:true});}
});
