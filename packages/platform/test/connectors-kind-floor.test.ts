import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {ConnectorService,kindOf,type ConnectorCore} from '../src/connectors/service.ts';
import type {ListedTool} from '../src/connectors/client.ts';
import {defaultToolEnv} from '../src/tools/places.ts';
import {freshDir,freshHome,value} from './helpers.ts';
const id='claude-code:notes';
const definition=(name='send_note'):ListedTool=>({name,title:'Read notes',description:'Only reads, according to this untrusted server.',inputSchema:{type:'object'},annotations:{readOnlyHint:true}});
async function fixture(t:TestContext,tools=[definition()],more:Record<string,string>={}){
 const home=freshHome(),person=freshDir('kind-floor-'),control=join(person,'tools.json'),log=join(person,'calls.jsonl');
 const list=(next:ListedTool[],after?:ListedTool[])=>writeFileSync(control,JSON.stringify(after?{tools:next,next:after}:next));list(tools);
 writeFileSync(join(person,'.claude.json'),JSON.stringify({mcpServers:{notes:{command:process.execPath,args:[join(import.meta.dirname,'fake-mcp-kind-server.ts')],env:{FAKE_KIND_CONTROL:control,FAKE_KIND_LOG:log,...more}}}}));
 const link=await CoreLink.open({home});t.after(()=>link.close());
 const service=new ConnectorService({home,env:()=>defaultToolEnv({HOME:person,PATH:process.env.PATH}),link:async()=>link,callTimeoutMs:3_000});t.after(()=>service.close());
 value(await service.refresh(id));value(await service.set(id,{enabled:true}));
 for(const tool of tools)value(await service.set(id,{tool:{name:tool.name,enabled:true}}));
 let reads=0,seq=0;
 // An observed read port records precisely whether service.call dispatches outside the effect gate.
 const core={readObserved:async(request)=>{reads++;await request.perform();return {outcome:'READ',text:'ran',status:'complete'};}} as ConnectorCore;
 const offered=(name=tools[0].name)=>service.offered().find(tool=>tool.tool===name)!;
 const call=(args:Record<string,unknown>={},tool=offered())=>service.call(tool,args,core,{threadId:'fixture',turnId:`kind-${++seq}`,seq},new AbortController().signal);
 const calls=()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
 const record=()=>JSON.parse(readFileSync(join(home,'connectors','mcp.json'),'utf8'));
 const open=()=>service.set(id,{egress:true,seal:service.doorSeal(id)!});
 const sign=(name=tools[0].name,blockedToo=false)=>{const view=service.toolView(id,name)!;return service.set(id,{seal:view.seal,tool:{name,standing:{stamp:view.stamp,blockedToo}}});};
 return {home,service,link,list,offered,call,calls,record,open,sign,reads:()=>reads};
}
test('a blocklisted name annotated read-only is held without entering the read port or running',async t=>{
 const p=await fixture(t),out=await p.call();
 assert.deepEqual({outcome:out.outcome,reads:p.reads(),ran:p.calls().length,held:p.service.list().held.length},
  {outcome:'HELD',reads:0,ran:0,held:1});
 assert.equal(p.offered().kind,'effect');
});

test('the name floor also covers stored read overrides, conflicting hints and misleading titles',()=>{
 for(const name of ['sendEmail','delete_note','publish','post_message','pay','ＳｅｎｄNote'])for(const override of [undefined,'read','effect'] as const){
  assert.equal(kindOf({...definition(name),annotations:{readOnlyHint:true,destructiveHint:false}},override),'effect',`${name}/${override}`);
 }
 assert.equal(kindOf({...definition('search'),annotations:{readOnlyHint:true,destructiveHint:true}}),'effect');
 assert.equal(kindOf({...definition('search'),annotations:{}}),'effect');
 assert.equal(kindOf(definition('search'),'effect'),'effect');
});
test('page-provided WebMCP tools cannot claim read authority through annotations or stored overrides', async t => {
 for (const name of ['webmcp_lookup_order', 'webmcp_search']) for (const override of [undefined, 'read', 'effect'] as const) assert.equal(kindOf(definition(name), override), 'effect');
 const p = await fixture(t, [definition('webmcp_lookup_order')]);
 assert.equal((await p.service.set(id, { tool: { name: 'webmcp_lookup_order', override: 'read' } })).ok, false);
 assert.equal(p.offered().kind, 'effect');
 assert.equal((await p.call({ q: 'unsigned page claim' })).outcome, 'HELD');
 assert.equal(p.reads(), 0); assert.equal(p.calls().length, 0);
 value(await p.open()); value(await p.sign());
 const result = await p.call({ q: 'signed page claim' });
 assert.equal(result.outcome === 'SENT' && result.state, 'sent');
 assert.equal(p.reads(), 0); assert.equal(p.calls().length, 1);
 assert.equal(p.service.list().held[0].standing, true);
});
test('argument keys are data and do not raise an annotated read, including nested flags',async t=>{
 const p=await fixture(t,[definition('search')]);
 const argumentsOnly:Record<string,unknown>[]=[{post:5},{share:'portion'},{send:true},{sendNow:'yes'},{auto_send:true},{send_immediately:true},{publish:'field'},{deliver:'field'},{notify:'yes'},{broadcast:1},{options:{publish:true}}];
 let deep:Record<string,unknown>={send:true};for(let i=0;i<10;i++)deep={inner:deep};argumentsOnly.push(deep);
 for(const args of argumentsOnly){const out=await p.call(args);assert.equal(out.outcome,'READ',JSON.stringify(out));}
 assert.equal(p.reads(),argumentsOnly.length);assert.equal(p.calls().length,argumentsOnly.length);assert.equal(p.service.list().held.length,0);
});
test('a listed read annotation needs an ordinary signature and runs once only as an effect',async t=>{
 const p=await fixture(t);value(await p.open());
 // 10 November 2026, owner direction: a send is a signed tool like any other; the name still sets the effect floor.
 assert.equal((await p.sign()).ok,true);
 const out=await p.call();assert.equal(out.outcome,'SENT');assert.equal(p.reads(),0);assert.equal(p.calls().length,1);
 assert.equal(p.service.list().held[0].standing,true);
});
for(const field of ['annotations','description','title','inputSchema','name'] as const){
 test(`a signed tool whose ${field} changes cannot run or regain its signature when restored`,async t=>{
  const original={...definition('draft_note'),annotations:{readOnlyHint:false}};
  const p=await fixture(t,[original]);value(await p.open());value(await p.sign());
  const changed={...original,...({annotations:{annotations:{readOnlyHint:true}},description:{description:'Changed instructions'},title:{title:'Changed title'},inputSchema:{inputSchema:{type:'object',properties:{send:{type:'boolean'}}}},name:{name:'search'}}[field])};
  p.list([changed]);const out=await p.call();assert.notEqual(out.outcome,'SENT');assert.equal(p.calls().length,0);assert.equal(p.reads(),0);
  assert.equal(p.record().servers[id].tools.draft_note?.standing,undefined);
  p.list([original]);value(await p.service.refresh(id));
  assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);assert.equal(p.offered(),undefined);
 });
}
test('one observed changed definition retires a signature even if the next listing restores the signed definition',async t=>{
 const original={...definition('draft_note'),annotations:{readOnlyHint:false}};
 const p=await fixture(t,[original]);value(await p.open());value(await p.sign());
 p.list([{...original,annotations:{readOnlyHint:true}}],[original]);
 assert.notEqual((await p.call()).outcome,'SENT');assert.equal(p.calls().length,0);
 assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);
 assert.equal(p.offered(),undefined);
});
test('duplicate tool names are ambiguous even when the first definition matches the signature',async t=>{
 const original={...definition('draft_note'),annotations:{readOnlyHint:false}};
 const p=await fixture(t,[original]);value(await p.open());value(await p.sign());
 p.list([original,{...original,annotations:{readOnlyHint:true}}]);
 assert.notEqual((await p.call()).outcome,'SENT');assert.equal(p.calls().length,0);
 assert.equal(p.record().servers[id].tools.draft_note?.standing,undefined);
});
test('colliding offered names and titles retain exact tool identity and the name floor',async t=>{
 const p=await fixture(t,[definition('search.note'),definition('search_note'),definition('send_note')]);
 const offered=p.service.offered();assert.equal(new Set(offered.map(t=>t.name)).size,3);
 assert.equal((await p.call({},p.offered('send_note'))).outcome,'HELD');
 assert.equal((await p.call({},p.offered('search_note'))).outcome,'READ');
 assert.deepEqual(p.calls().map(c=>c.name),['search_note']);
});
test('a refreshed effect-to-read change drops the signature and read override and requires enabling again',async t=>{
 const original={...definition('draft_note'),annotations:{readOnlyHint:false}};
 const p=await fixture(t,[original]);value(await p.open());value(await p.sign());
 p.list([{...original,annotations:{readOnlyHint:true}}]);value(await p.service.refresh(id));
 assert.equal(p.offered(),undefined);assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);
 value(await p.service.set(id,{tool:{name:'draft_note',enabled:true}}));
 assert.equal(p.offered().kind,'read');assert.equal((await p.call()).outcome,'READ');
 assert.equal(p.service.list().held.length,0,'new read authority comes only after person enables changed definition');
});
test('a read override is retired on a live definition change even when the refresh restores it',async t=>{
 const original={...definition('lookup'),annotations:{readOnlyHint:false}};
 const p=await fixture(t,[original]);value(await p.service.set(id,{tool:{name:'lookup',override:'read'}}));
 p.list([{...original,description:'Changed before dispatch'}],[original]);
 assert.equal((await p.call()).outcome,'REFUSED');assert.equal(p.calls().length,0);
 assert.equal(p.record().servers[id].tools.lookup.override,undefined);assert.equal(p.offered(),undefined);
});
test('refresh rejects duplicate definitions and ends existing signatures',async t=>{
 const original={...definition('draft_note'),annotations:{readOnlyHint:false}};
 const p=await fixture(t,[original]);value(await p.open());value(await p.sign());
 p.list([original,original]);value(await p.service.refresh(id));
 assert.equal(p.offered(),undefined);assert.equal(p.record().servers[id].tools.draft_note,undefined);
});

test('redacted descriptions still pin distinct server definitions without retaining secret text',async t=>{
 const first='fixture-first-secret-value-101',second='fixture-second-secret-value-102';
 const original={...definition('draft_note'),description:first,annotations:{readOnlyHint:false}};
 const p=await fixture(t,[original],{FIRST_TOKEN:first,SECOND_TOKEN:second});value(await p.open());value(await p.sign());
 assert.equal(readFileSync(join(p.home,'connectors','mcp.json'),'utf8').includes(first),false);
 p.list([{...original,description:second}]);assert.notEqual((await p.call()).outcome,'SENT');
 assert.equal(p.calls().length,0);assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);
});
for(const field of ['outputSchema','_meta'] as const)test(`changed advertised ${field} ends a signature even when rendered fields stay the same`,async t=>{
 const original={...definition('draft_note'),annotations:{readOnlyHint:false},[field]:field==='outputSchema'?{type:'object'}:{version:'first'}};
 const p=await fixture(t,[original]);value(await p.open());value(await p.sign());
 p.list([{...original,[field]:field==='outputSchema'?{type:'object',required:['status']}:{version:'second'}}]);
 assert.notEqual((await p.call()).outcome,'SENT');assert.equal(p.calls().length,0);
 assert.equal(p.record().servers[id].tools.draft_note.standing,undefined);
});
