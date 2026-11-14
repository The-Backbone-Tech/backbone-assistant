// Real extracted native connector handoff used by the acknowledged-turn handler; no process/SDK transport.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ConnectorInvocation,ConnectorToolSpec,ToolHost} from '@backbone-next/platform/ports';
import {carryCodexConnector} from '../src/index.ts';

const tool:ConnectorToolSpec={name:'lookup',server:'Synthetic',tool:'lookup',description:'Read',kind:'read',inputSchema:{type:'object'}};
const acknowledged={threadId:'native-thread',turnId:'native-turn'};
const params={threadId:acknowledged.threadId,turnId:acknowledged.turnId,callId:'native-call',arguments:{q:'identical'},id:901};

test('Codex forwards native call IDs and the exact acknowledged tuple, never an RPC ID or argument hash',async()=>{
 const origins:ConnectorInvocation[]=[];let stopped=0;
 const tools:Pick<ToolHost,'callConnector'>={callConnector:async(name,args,_signal,origin)=>{assert.equal(name,tool.name);assert.deepEqual(args,{q:'identical'});assert.ok(origin);origins.push(origin);return {outcome:'READ',status:'complete',text:'answer'};}};
 for(const callId of ['native-first','native-second']){
  const result=await carryCodexConnector(tools,tool,{...params,callId},acknowledged,new AbortController().signal,()=>{stopped++;});assert.equal(result?.success,true);
 }
 assert.deepEqual(origins,[{engine:'codex',namespace:JSON.stringify(['native-thread','native-turn']),callId:'native-first'},{engine:'codex',namespace:JSON.stringify(['native-thread','native-turn']),callId:'native-second'}]);assert.equal(stopped,0);
});

for(const invalid of [{callId:''},{callId:' '},{callId:undefined},{callId:901},{callId:'\0'},{callId:'\ud800'},{threadId:'other'},{turnId:'other'}])test(`Codex refuses unbound native identity ${JSON.stringify(invalid)}`,async()=>{
 let calls=0;const result=await carryCodexConnector({callConnector:async()=>{calls++;return {outcome:'READ',status:'complete',text:'unexpected'};}},tool,{...params,...invalid},acknowledged,new AbortController().signal,()=>{});
 assert.equal(result,null);assert.equal(calls,0);
});

test('Codex serialized tuple keeps opaque namespace components unambiguous',async()=>{
 const origins:ConnectorInvocation[]=[];const tools:Pick<ToolHost,'callConnector'>={callConnector:async(_name,_args,_signal,origin)=>{assert.ok(origin);origins.push(origin);return {outcome:'REFUSED',detail:'Synthetic refusal'};}};
 for(const scope of [{threadId:'a:b',turnId:'c'},{threadId:'a',turnId:'b:c'}])await carryCodexConnector(tools,tool,{...params,...scope},scope,new AbortController().signal,()=>{});
 assert.deepEqual(origins.map(x=>x.namespace),['["a:b","c"]','["a","b:c"]']);
});

test('Codex does not invoke after abort and UNKNOWN stops the current native turn',async()=>{
 let calls=0,stops=0;const abort=new AbortController();abort.abort();
 const tools:Pick<ToolHost,'callConnector'>={callConnector:async()=>{calls++;return {outcome:'UNKNOWN',detail:'Retained UNKNOWN; do not dispatch again.'};}};
 assert.equal(await carryCodexConnector(tools,tool,params,acknowledged,abort.signal,()=>{stops++;}),null);assert.equal(calls,0);
 const result=await carryCodexConnector(tools,tool,params,acknowledged,new AbortController().signal,()=>{stops++;});assert.equal(result?.success,false);assert.equal(calls,1);assert.equal(stops,1);assert.match(JSON.stringify(result),/Retained UNKNOWN/);
});
