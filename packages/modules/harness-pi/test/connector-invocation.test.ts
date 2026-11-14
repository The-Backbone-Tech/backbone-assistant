// The real maintained Agent loop with an in-memory assistant stream: no provider/network/process.
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {Agent} from '@earendil-works/pi-agent-core';
import {createAssistantMessageEventStream,type AssistantMessage,type ToolCall} from '@earendil-works/pi-ai';
import type {ConnectorInvocation,HarnessEvent,ToolHost,TurnRequest} from '@backbone-next/platform/ports';
import {createPiHarness} from '../src/index.ts';

const namespace='11111111-1111-4111-8111-111111111111',otherNamespace='22222222-2222-4222-8222-222222222222';
const deferred=()=>{let resolve!:(value:string)=>void;const promise=new Promise<string>(r=>{resolve=r;});return {promise,resolve};};
const call=(id:string,name='lookup'):ToolCall=>({type:'toolCall',id,name,arguments:{q:'identical'}});
function message(calls:ToolCall[]):AssistantMessage{return {role:'assistant',content:calls,api:'openai-completions',provider:'backbone-openai-compatible',model:'fixture',
 usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:calls.length?'toolUse':'stop',timestamp:1};}
const request:TurnRequest={threadId:'host-thread',turnId:'host-turn',text:'Synthetic connector request',history:[],attachments:[],effort:1,resumed:false};
function setup(t:TestContext,messages:AssistantMessage[],overrides:Partial<ToolHost>={}){
 let streams=0,fetches=0;const invocations:{name:string;args:Record<string,unknown>;origin:ConnectorInvocation|undefined}[]=[];
 const host:ToolHost={list:async()=>[],read:async()=>null,write:async()=>{throw new Error('No write');},
  connectors:()=>[{name:'lookup',server:'Synthetic',tool:'lookup',description:'Read synthetic data',inputSchema:{type:'object',properties:{q:{type:'string'}}},kind:'read'}],
  reserveConnectorBatch:async()=>namespace,
  callConnector:async(name,args,_signal,origin)=>{invocations.push({name,args,origin});return {outcome:'READ',status:'complete',text:'answer'};},...overrides};
 t.mock.method(globalThis,'fetch',async()=>{fetches++;throw new Error('No network');});
 const prompt=Agent.prototype.prompt;
 t.mock.method(Agent.prototype,'prompt',function(this:Agent,...args:Parameters<Agent['prompt']>){
  this.streamFunction=()=>{streams++;const stream=createAssistantMessageEventStream(),next=messages.shift()??message([]);stream.push({type:'done',reason:next.stopReason as 'stop'|'toolUse',message:next});return stream;};
  return prompt.apply(this,args);
 });
 const run=createPiHarness().start(request,{tools:host,route:{kind:'endpoint',provider:'openai-compatible',model:'fixture',baseUrl:'https://model.invalid',credential:null,label:'offline'},credential:async()=>{throw new Error('No credential');}});
 const events:HarnessEvent[]=[];const collecting=(async()=>{for await(const event of run.events)events.push(event);})();
 t.after(async()=>{run.stop();await run.outcome;await collecting;assert.equal(fetches,0);});
 return {run,events,collecting,invocations,streams:()=>streams};
}

test('Pi awaits one durable allocation for the exact batch before either identical legitimate call',async t=>{
 const entered=deferred(),release=deferred(),batches:readonly string[][]=[];
 const s=setup(t,[message([call('native-alpha'),call('native-beta')])],{reserveConnectorBatch:async ids=>{(batches as string[][]).push([...ids]);entered.resolve('entered');return release.promise;}});
 try{
  await Promise.race([entered.promise,s.run.outcome.then(()=>{throw new Error('The engine ended without allocating its durable connector batch.');})]);
  await new Promise(r=>setImmediate(r));assert.equal(s.invocations.length,0,'no connector dispatch while allocation is pending');
  release.resolve(namespace);const outcome=await s.run.outcome;await s.collecting;
  assert.equal(outcome.status,'done');assert.deepEqual(batches,[['native-alpha','native-beta']]);
  assert.deepEqual(s.invocations.map(x=>x.origin),[{engine:'pi',namespace,callId:'native-alpha'},{engine:'pi',namespace,callId:'native-beta'}]);
  assert.deepEqual(s.invocations.map(x=>x.args),[{q:'identical'},{q:'identical'}]);
 }finally{release.resolve(namespace);}
});

test('Pi scopes reused native IDs in different assistant messages to different allocated batches',async t=>{
 let allocations=0;
 const s=setup(t,[message([call('same-native-id')]),message([call('same-native-id')])],{reserveConnectorBatch:async ids=>{assert.deepEqual(ids,['same-native-id']);return allocations++?otherNamespace:namespace;}});
 await s.run.outcome;assert.equal(allocations,2);assert.deepEqual(s.invocations.map(x=>x.origin?.namespace),[namespace,otherNamespace]);
});

for(const invalid of ['missing-hook','empty-id','duplicate-id','invalid-namespace','invalid-namespace-type','allocation-failed'] as const)test(`Pi refuses ${invalid} without a guessed identity or connector dispatch`,async t=>{
 let allocations=0;
 const overrides:Partial<ToolHost>={reserveConnectorBatch:async()=>{allocations++;if(invalid==='allocation-failed')throw new Error('Private reservation error');if(invalid==='invalid-namespace-type')return {toString:()=>namespace} as unknown as string;return invalid==='invalid-namespace'?'not-a-batch-uuid':namespace;}};
 if(invalid==='missing-hook')overrides.reserveConnectorBatch=undefined;
 const ids=invalid==='empty-id'?['']:invalid==='duplicate-id'?['same','same']:['native-id'];
 const s=setup(t,[message(ids.map(id=>call(id)))],overrides);await s.run.outcome;await s.collecting;
 assert.equal(s.invocations.length,0);assert.equal(allocations,['invalid-namespace','invalid-namespace-type','allocation-failed'].includes(invalid)?1:0);
 assert.ok(s.events.some(event=>event.type==='tool'&&event.phase==='refused'));
});

test('Pi abort during durable batch allocation cannot dispatch after that allocation resolves',async t=>{
 const entered=deferred(),release=deferred();
 const s=setup(t,[message([call('native-id')])],{reserveConnectorBatch:async()=>{entered.resolve('entered');return release.promise;}});
 try{
  await entered.promise;s.run.stop();release.resolve(namespace);
  const outcome=await s.run.outcome;assert.equal(outcome.status,'interrupted');assert.equal(s.invocations.length,0);assert.equal(s.streams(),1);
 }finally{release.resolve(namespace);}
});

test('Pi UNKNOWN aborts its own mixed batch before another connector or model continuation',async t=>{
 let calls=0;
 const s=setup(t,[message([call('ordinary','list_files'),call('unknown'),call('must-not-dispatch')])],{callConnector:async()=>{calls++;return {outcome:'UNKNOWN',detail:'The original response is unknown; never resend it.'};}});
 const outcome=await s.run.outcome;await s.collecting;
 assert.equal(calls,1);assert.equal(s.streams(),1,'no model continuation even though an earlier ordinary result was non-terminating');
 assert.equal(outcome.status,'interrupted');assert.match(outcome.error!,/original response is unknown/);
 assert.ok(s.events.some(event=>event.type==='tool'&&event.phase==='unknown'));
});
