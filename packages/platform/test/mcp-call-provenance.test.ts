import { TEST_HANG_MS } from '../../../scripts/lib/test-hang.ts';
// Whole-case hang guard; product deadlines are asserted separately.
// Real McpSession.open/call with a fake SDK boundary: transport start/fetch are forbidden.
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {Client,ProtocolError,ProtocolErrorCode,SdkError,SdkErrorCode,StreamableHTTPClientTransport,type CallToolResult} from '@modelcontextprotocol/client';
import {McpSession,NOT_AN_ABSENCE,TimedOut} from '../src/connectors/client.ts';

const secret='synthetic-sensitive-value';
const text=(value:string,isError=false):CallToolResult=>({content:[{type:'text',text:value}],...(isError?{isError:true}:{})});
async function fixture(t:TestContext,answer:()=>Promise<CallToolResult>){
 let starts=0,fetches=0,connects=0,calls=0,closes=0;
 t.mock.method(StreamableHTTPClientTransport.prototype,'start',async()=>{starts++;throw new Error('No transport may start in a provenance unit test.');});
 t.mock.method(globalThis,'fetch',async()=>{fetches++;throw new Error('No network may run in a provenance unit test.');});
 t.mock.method(Client.prototype,'connect',async()=>{connects++;});
 t.mock.method(Client.prototype,'close',async()=>{closes++;});
 t.mock.method(Client.prototype,'callTool',async(params:Parameters<Client['callTool']>[0],options:Parameters<Client['callTool']>[1])=>{
  calls++;assert.deepEqual(params,{name:'lookup',arguments:{q:'synthetic'}});assert.ok(options?.signal);return answer();
 });
 const session=await McpSession.open({transport:'http',url:'https://mcp.invalid/never-requested',headers:{Authorization:`Bearer ${secret}`}});
 t.after(async()=>{
  await session.close();assert.equal(connects,1);assert.equal(closes,1);assert.equal(starts,0);assert.equal(fetches,0);
 });
 return {session,calls:()=>calls};
}

for(const sample of [
 {name:'empty complete',result:{content:[]} as CallToolResult,status:'complete',body:''},
 {name:'ordinary complete',result:text('Found one'),status:'complete',body:'Found one'},
 {name:'isError',result:text('Read failed at the server',true),status:'failed',body:'Read failed at the server'},
 {name:'empty isError',result:{content:[],isError:true} as CallToolResult,status:'failed',body:''},
 {name:'partial page',result:{...text('First page'),structuredContent:{nextCursor:'next-page'}},status:'partial',body:'First page'},
 {name:'rate-limited isError',result:text('429 too many requests',true),status:'rate-limited',body:'429 too many requests'},
])test(`a resolved SDK ${sample.name} result is observed independently of completeness/status`,async t=>{
 const {session,calls}=await fixture(t,async()=>sample.result);
 const answer=await session.call('lookup',{q:'synthetic'},new AbortController().signal);
 assert.equal(answer.observed,true);assert.equal(answer.status,sample.status);assert.equal(answer.text,sample.body);assert.equal(calls(),1);
 if(sample.status!=='complete')assert.ok(answer.detail,'incomplete/error results still say they establish no absence');
});

for(const sample of [
 {name:'ProtocolError with possible remote-looking data',error:new ProtocolError(ProtocolErrorCode.InvalidParams,'Read failed at the server',{request:'not-a-provenance-signal'}),status:'failed'},
 {name:'local SDK output validation error',error:new ProtocolError(ProtocolErrorCode.InvalidParams,'Structured content does not match the tool output schema'),status:'failed'},
 {name:'transport failure',error:new Error('Connection reset while waiting for the answer'),status:'failed'},
 {name:'SDK timeout',error:new SdkError(SdkErrorCode.RequestTimeout,'Request timed out'),status:'timed-out'},
 {name:'outer timeout error',error:new TimedOut('The call took longer than expected'),status:'timed-out'},
 {name:'rate-limit exception',error:new ProtocolError(ProtocolErrorCode.InternalError,'429 too many requests'),status:'rate-limited'},
])test(`a rejected SDK ${sample.name} is not an observed tool result`,async t=>{
 const {session,calls}=await fixture(t,async()=>{throw sample.error;});
 const answer=await session.call('lookup',{q:'synthetic'},new AbortController().signal);
 assert.equal(answer.observed,false);assert.equal(answer.status,sample.status);assert.equal(answer.text,'');assert.ok(answer.detail);assert.equal(calls(),1);
});

test('same-looking failed and rate-limited result/error strings never supply provenance',async t=>{
 let mode:'result'|'error'='result',wording='Read failed at the server';
 const {session,calls}=await fixture(t,async()=>{
  if(mode==='error')throw new ProtocolError(ProtocolErrorCode.InternalError,wording);
  return text(wording,true);
 });
 for(const [words,status] of [['Read failed at the server','failed'],['429 too many requests','rate-limited']] as const){
  wording=words;mode='result';const observed=await session.call('lookup',{q:'synthetic'},new AbortController().signal);
  mode='error';const unknown=await session.call('lookup',{q:'synthetic'},new AbortController().signal);
  assert.equal(observed.status,status);assert.equal(unknown.status,status);assert.equal(observed.observed,true);assert.equal(unknown.observed,false);
  assert.equal(observed.text,words);assert.equal(unknown.text,'');
 }
 assert.equal(calls(),4,'neither result nor rejection causes another SDK invocation');
});

test('abort plus rejection remains unobserved, while an actually resolved SDK result stays observed',async t=>{
 const aborted=new AbortController();let resolveResult=false;
 const {session,calls}=await fixture(t,async()=>{aborted.abort();if(resolveResult)return text('Observed despite a concurrent abort');throw new DOMException('Stopped without a reply','AbortError');});
 const unknown=await session.call('lookup',{q:'synthetic'},aborted.signal);
 assert.equal(unknown.observed,false);assert.equal(unknown.status,'failed');assert.equal(unknown.detail,'Stopped before a verified tool result was retained. The request may have been sent.');assert.equal(unknown.text,'');
 resolveResult=true;const observed=await session.call('lookup',{q:'synthetic'},aborted.signal);
 assert.equal(observed.observed,true);assert.equal(observed.text,'Observed despite a concurrent abort');assert.equal(calls(),2);
});

test('rendering preserves flattening, clipping and credential redaction for observed results and rejected diagnostics',async t=>{
 let mode:'flat'|'structured'|'clipped'|'rejected'='flat';
 const {session}=await fixture(t,async()=>{
  if(mode==='rejected')throw new Error(`Failure echoed Bearer ${secret}`);
  if(mode==='structured')return {content:[],structuredContent:{message:secret}};
  if(mode==='clipped')return text('x'.repeat(200_001));
  return {content:[{type:'text',text:`Value ${secret}`},{type:'image',mimeType:'image/png',data:'AA=='}]};
 });
 const call=()=>session.call('lookup',{q:'synthetic'},new AbortController().signal);
 const flat=await call();assert.equal(flat.observed,true);assert.equal(flat.text,'Value [hidden]\n[image content not shown]');assert.equal(flat.status,'complete');
 mode='structured';const structured=await call();assert.equal(structured.observed,true);assert.equal(structured.text,'{"message":"[hidden]"}');
 mode='clipped';const clipped=await call();assert.equal(clipped.observed,true);assert.equal(clipped.text,'x'.repeat(200_000));assert.equal(clipped.status,'partial');assert.match(clipped.detail!,/cut/);
 mode='rejected';const rejected=await call();assert.equal(rejected.observed,false);assert.equal(rejected.status,'failed');assert.match(rejected.detail!,/Failure echoed \[hidden\]/);
 for(const answer of [flat,structured,clipped,rejected])assert.equal(JSON.stringify(answer).includes(secret),false);
});

test('the real outer deadline remains unobserved and a later fake SDK result causes no repeat',{timeout: TEST_HANG_MS * 2},async t=>{
 let resolve!:(value:CallToolResult)=>void;
 const delayed=new Promise<CallToolResult>(r=>{resolve=r;});
 const {session,calls}=await fixture(t,()=>delayed);
 try{
  const answer=await session.call('lookup',{q:'synthetic'},new AbortController().signal,0);
  assert.equal(answer.observed,false);assert.equal(answer.status,'timed-out');assert.equal(answer.text,'');assert.equal(answer.detail,NOT_AN_ABSENCE['timed-out']);
  resolve(text('A late result is not the response retained by this completed call'));await delayed;
  assert.equal(answer.observed,false);assert.equal(calls(),1);
 }finally{resolve(text('cleanup'));await delayed;}
});

for (const sample of [
 { name: 'browser action deadline', result: text('TimeoutError: locator.click: Timeout 2000ms exceeded.', true) },
 { name: 'upstream socket deadline', result: text('ETIMEDOUT after sending the request', true) },
 { name: 'structured deadline', result: { ...text('Action failed', true), structuredContent: { error: { code: 'DEADLINE_EXCEEDED', token: secret } } } },
 { name: 'deadline beyond the display bound', result: text('x'.repeat(200_000) + ' deadline expired', true) },
 { name: 'rate limit with an upstream timeout', result: text('429: upstream timed out after accepting the request', true) },
]) test(`a resolved ${sample.name} preserves its observed error and records uncertain delivery`, async t => {
 const { session, calls } = await fixture(t, async () => sample.result);
 const answer = await session.call('lookup', { q: 'synthetic' }, new AbortController().signal);
 assert.equal(answer.observed, true, 'an observed error reply is not an absent SDK response');
 assert.equal(answer.reportedTimeout, true, 'the action deadline does not prove that its effect failed');
 assert.equal(answer.status, sample.name.startsWith('rate limit') ? 'rate-limited' : 'failed', 'read completeness/status semantics stay distinct from effect outcome');
 assert.equal(answer.text, (sample.result.content![0] as { text: string }).text.slice(0, 200_000));
 assert.equal(JSON.stringify(answer).includes(secret), false);
 assert.equal(calls(), 1);
});

test('ordinary refusals and successful text mentioning a timeout do not report an expired action deadline', async t => {
 let result = text('Not allowed: the folder is read-only.', true);
 const { session } = await fixture(t, async () => result);
 const refused = await session.call('lookup', { q: 'synthetic' }, new AbortController().signal);
 assert.equal(refused.status, 'failed'); assert.equal(refused.observed, true); assert.equal(refused.reportedTimeout, undefined);
 result = text('The timeout setting is 2000ms. Completed successfully.');
 const complete = await session.call('lookup', { q: 'synthetic' }, new AbortController().signal);
 assert.equal(complete.status, 'complete'); assert.equal(complete.observed, true); assert.equal(complete.reportedTimeout, undefined);
});
