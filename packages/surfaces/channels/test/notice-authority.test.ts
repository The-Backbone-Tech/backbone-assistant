import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createHost,removeDataHome} from '@backbone-next/platform/composition';
import {freshDataHome as freshHome} from '@backbone-next/platform/testing/data-home';
import {startChannels} from '../src/index.ts';
import type {ChannelHost} from '../src/host-consumer.ts';
import {fakeProvider} from './fake-providers.ts';
import {telegramMessage} from './messages.ts';
import {TEST_HANG_MS,hangDetector,waitFor} from '../../../../scripts/lib/test-hang.ts';
import {observeChild} from '../../../../scripts/lib/test-child.ts';
const settings={permission:'ask',model:'stub',effort:3,mode:'chat',runsOn:'this-computer'} as const;

test('CLI unbind completes while a terminal notice is waiting on a silent provider',async t=>{
 const home=freshHome(),host=createHost({home}),fake=await fakeProvider('telegram');let service:Awaited<ReturnType<typeof startChannels>>|undefined;
 const deliveryTimeoutMs=5000,deadlines:AbortController[]=[];
 try{
  const p=await host.call('projects.create',{name:'Notice lock',kind:'folder'});assert.ok(p.ok);
  const proxy:ChannelHost={on:fn=>host.on(fn),async call(method,args){if(method==='turns.send')return {ok:false,reason:'INVALID',outcome:'REFUSED',detail:'This input cannot run.'} as never;return host.call(method,args);}};
  service=await startChannels(proxy,{home,projectId:p.value.id,settings,retryBaseMs:10,deliveryTimeoutMs,telegram:{token:'fake',secret:'test-signing',apiUrl:fake.url}});
  const active=service;fake.events(r=>active.webhook('telegram',r));active.ledger.pair('telegram','7',active.ledger.invite());fake.script('silent');
  // Only the delivery's five-second expiry is controlled. Cold CLI startup and I/O keep real time.
  const timeout=AbortSignal.timeout;
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{
   if(ms!==deliveryTimeoutMs)return timeout(ms);
   const deadline=new AbortController();deadlines.push(deadline);return deadline.signal;
  });
  let id='';const receive=active.ledger.receive.bind(active.ledger);active.ledger.receive=m=>{id=m.id;return receive(m);};
  await fake.emit(telegramMessage(1,'invalid'));
  const diagnostic=()=>JSON.stringify({delivery:active.ledger.delivery(`intake-refused:telegram:${id}`),posts:fake.posts().length,deliveryTimeoutMs,deadlines:deadlines.map(d=>({expired:d.signal.aborted}))});
  await waitFor(()=>fake.posts().length===1,'terminal notice reaches the silent provider',{diagnostic});
  assert.ok(deadlines.length>0,'the notice uses the configured five-second delivery deadline');
  assert.ok(id);assert.equal(active.ledger.delivery(`intake-refused:telegram:${id}`)?.state,'sending');
  const cli=fileURLToPath(new URL('../../cli/src/main.ts',import.meta.url));
  // Three minutes detects a hung child; it is not an unbind or TypeScript startup latency promise.
  const command=promisify(execFile)(process.execPath,[cli,'channels','unbind','--home',home,'--json'],{timeout:TEST_HANG_MS});
  const output=observeChild(command.child,'CLI channels unbind');
  const result=await hangDetector(command,'CLI unbind finishes before delivery expiry',{diagnostic:()=>`${output.diagnostic('pending CLI completion').message}\n${diagnostic()}`});
  assert.deepEqual(JSON.parse(result.stdout),{unbound:1});assert.equal(active.ledger.bound('telegram','7'),false);
  // Unbind finished before dispatch got an answer or reached its five-second deadline.
  assert.ok(deadlines.every(d=>!d.signal.aborted),'unbind completes before the five-second delivery deadline expires');
  assert.equal(active.ledger.delivery(`intake-refused:telegram:${id}`)?.state,'sending');
  assert.equal(fake.posts().length,1);
 }finally{
  // Explicit expiry releases the deliberately silent delivery even when an earlier assertion fails.
  for(const deadline of deadlines)deadline.abort(new DOMException('Delivery deadline expired','TimeoutError'));
  await fake.close();await service?.close();await host.close();await removeDataHome(home);
 }
});
