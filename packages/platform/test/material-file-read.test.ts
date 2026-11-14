// Offline Host boundary controls. Fake Core records ordering, never native SQL authority.
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {MaterialStore} from '../src/stub/material.ts';
import {readMaterialFile,type MaterialFileReadOptions,type MaterialFileReadRequest} from '../src/composition/material-file-read.ts';
import type {MaterialSourceReadRequest,MaterialReadTentative} from '../src/composition/core.ts';
import {inActiveHomeLockScope} from '../src/composition/home-lock.ts';
import {sha256} from '../src/stub/fsx.ts';
const warningAt='2026-11-10T00:00:00.000Z';
const receipt={workspace:'workspace',readKey:'',episode:'episode',receipt:'receipt'};
function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'file-read-owner-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const material=new MaterialStore(home,{},()=>{}),entry=material.create('project','note.md','text/markdown',Buffer.from('Exact\nsource'),'working','person','source');
 const records:MaterialSourceReadRequest[]=[],events:unknown[]=[],state:{during?:()=>void;after?:()=>void;failAppend?:boolean;failCore?:boolean}={};
 const options:MaterialFileReadOptions={home,material,threadId:'thread',turnId:'turn',projectId:'project',handle:{run:'run',fence:1,secret:'fake'},link:{id:{workspace:'workspace'},async recordMaterialSourceRead(_handle,input,retain,signal){
  assert.equal(inActiveHomeLockScope(home),true);signal.throwIfAborted();records.push(structuredClone(input));state.during?.();
  const result={...receipt,readKey:input.readKey};retain(result);if(state.failCore)throw new Error('Synthetic lost commit reply');state.after?.();return result;
 }},journal:{append(event){if(state.failAppend)throw new Error('Synthetic fsync failed');events.push(structuredClone(event));return {...event,at:'2026-11-09T00:00:00Z'};}}};
 const request:MaterialFileReadRequest={materialId:entry.id,name:entry.name,version:1,withdrawals:0,profile:'harness'};
 return {home,material,entry,options,request,records,events,state};
}
test('only exact prepared bytes are registered and returned after tentative and confirmed barriers',async t=>{
 const f=fixture(t),result=await readMaterialFile(f.options,f.request);
 assert.equal(result.text,'Exact\nsource');assert.equal(result.materialId,'source');assert.equal(result.version,1);
 assert.equal(f.records[0].episodeContent,result.text);assert.equal(f.records[0].preparedText,result.text);
 assert.deepEqual(f.events.map(value=>(value as {kind:string}).kind),['material.read.tentative','material.read.confirmed']);
 assert.equal(result.preparation.readKey,f.records[0].readKey);
});
test('a forged caller text or author is ignored; fresh Store metadata supplies conservative author',async t=>{
 const f=fixture(t);await readMaterialFile(f.options,{...f.request,text:'forged',authoredBy:'agent'} as MaterialFileReadRequest);
 assert.equal(f.records[0].preparedText,'Exact\nsource');assert.equal(f.records[0].authoredBy,'person');
 const restored={...f.material.load('source')!,restored:true};writeFileSync(join(f.home,'material/source/meta.json'),JSON.stringify(restored));
 await readMaterialFile(f.options,f.request);assert.equal(f.records[1].authoredBy,null);assert.notEqual(f.records[0].readKey,f.records[1].readKey);
});
for(const patch of [{hidden:true},{held:{id:'other',name:'held'}},{recovery:{turnId:'other',reason:'inspect'}},{unsure:{id:'other',name:'uncertain'}}, {projectId:'foreign'},{name:'renamed.md'}])test(`fresh source refusal: ${JSON.stringify(patch)}`,async t=>{
 const f=fixture(t);writeFileSync(join(f.home,'material/source/meta.json'),JSON.stringify({...f.entry,...patch}));
 await assert.rejects(readMaterialFile(f.options,f.request));assert.equal(f.records.length,0);
});
for(const warning of [null,false,[],{}, {version:0,at:warningAt},{version:1,at:warningAt},{version:-1,at:warningAt},{version:2.5,at:warningAt},
 {version:'2',at:warningAt},{version:Number.MAX_SAFE_INTEGER+1,at:warningAt}])test(`invalid interrupted Save warning refuses before Core: ${JSON.stringify(warning)}`,async t=>{
 const f=fixture(t);writeFileSync(join(f.home,'material/source/meta.json'),JSON.stringify({...f.entry,interruptedSave:warning}));
 await assert.rejects(readMaterialFile(f.options,f.request),/unavailable/i);assert.equal(f.records.length,0);assert.equal(f.events.length,0);
});
for(const patch of [{class:'original'},{unsure:{id:'other',name:'uncertain'}}])test(`a future Save warning never permits original mutation or unsure material: ${JSON.stringify(patch)}`,async t=>{
 const f=fixture(t);writeFileSync(join(f.home,'material/source/meta.json'),JSON.stringify({...f.entry,...patch,interruptedSave:{version:2,at:warningAt}}));
 await assert.rejects(readMaterialFile(f.options,f.request),/unavailable/i);assert.equal(f.records.length,0);
});
test('a future Save warning timestamp is display metadata, not current-read authority',async t=>{
 const f=fixture(t),warning={version:2,at:'now'};
 writeFileSync(join(f.home,'material/source/meta.json'),JSON.stringify({...f.entry,interruptedSave:warning}));
 const result=await readMaterialFile(f.options,f.request);assert.equal(result.text,'Exact\nsource');assert.equal(result.version,1);
 assert.equal(f.records[0].originalSha256,f.entry.versions[0].sha256);assert.deepEqual(f.material.load('source')!.interruptedSave,warning);
});
for(const by of ['agent','person'] as const)test(`Store settlement preserves the exact committed current after an interrupted newer Save (${by==='agent'?'working':'accepted'})`,async t=>{
 const f=fixture(t),committedText='Committed current source';
 const committed=await f.material.save('source',committedText,1,by);assert.equal(committed.ok,true);if(!committed.ok)return;
 const current=committed.value,next=current.current+1,future='Uncommitted orphan future bytes';
 const intent=join(f.home,'material/source/intent.json'),orphan=join(f.home,'material/source/versions',String(next));
 writeFileSync(intent,JSON.stringify({version:next,at:warningAt}));writeFileSync(orphan,future);
 // readMaterialFile invokes the real Store.load settlement; no kill or synthetic load response.
 const result=await readMaterialFile(f.options,{...f.request,version:current.current});
 assert.equal(result.text,committedText);assert.equal(result.version,current.current);
 assert.equal(f.records.length,1);assert.equal(f.records[0].version,current.current);
 assert.equal(f.records[0].originalSha256,current.versions.find(version=>version.n===current.current)!.sha256);
 assert.equal(f.records[0].originalSha256,sha256(Buffer.from(committedText)));
 assert.equal(f.records[0].episodeContent,committedText);assert.equal(f.records[0].preparedText,committedText);
 const warning={version:next,at:warningAt},settled=f.material.load('source')!;
 assert.equal(settled.class,by==='agent'?'working':'accepted');assert.equal(settled.current,current.current);
 assert.deepEqual(settled.interruptedSave,warning);assert.equal(existsSync(intent),false,'Store settles the abandoned intent');
 assert.deepEqual(JSON.parse(readFileSync(join(f.home,'material/source/meta.json'),'utf8')).interruptedSave,warning,'the warning is not silently cleared');
 assert.equal(settled.versions.some(version=>version.n===next),false);assert.equal(readFileSync(orphan,'utf8'),future,'uncommitted bytes remain evidence');
 await assert.rejects(readMaterialFile(f.options,{...f.request,version:next}),/unavailable/i);
 await assert.rejects(readMaterialFile(f.options,{...f.request,version:next,profile:'historical-utf8',historical:true}),/unavailable/i);
 assert.equal(f.records.length,1,'neither future request reaches Core');assert.equal(f.events.length,2);
 assert.deepEqual(f.material.load('source')!.interruptedSave,warning);assert.equal(readFileSync(orphan,'utf8'),future);
});
test('withdraw/restore increments generation, and old generation cannot be read under the same key',async t=>{
 const f=fixture(t);await readMaterialFile(f.options,f.request);f.material.withdraw('source');
 await assert.rejects(readMaterialFile(f.options,f.request));f.material.restore('source');
 await assert.rejects(readMaterialFile(f.options,f.request));await readMaterialFile(f.options,{...f.request,withdrawals:1});
 assert.equal(f.records[1].generation,1);assert.notEqual(f.records[0].readKey,f.records[1].readKey);
});
test('file hash corruption refuses before Core even when byte count is unchanged',async t=>{
 const f=fixture(t);writeFileSync(join(f.home,'material/source/versions/1'),'Other\nsource');
 await assert.rejects(readMaterialFile(f.options,f.request),/hash|bytes/i);assert.equal(f.records.length,0);
});
test('file read identity is stable for exact original run and payload, distinct across turns and profiles',async t=>{
 const f=fixture(t);await readMaterialFile(f.options,f.request);await readMaterialFile(f.options,f.request);
 assert.equal(f.records[0].readKey,f.records[1].readKey);f.options.turnId='next';await readMaterialFile(f.options,f.request);
 assert.notEqual(f.records[1].readKey,f.records[2].readKey);await readMaterialFile(f.options,{...f.request,profile:'stub'});
 assert.notEqual(f.records[2].readKey,f.records[3].readKey);assert.equal(f.records[3].preparedText,'note.md: Exact source');
});
test('source mutation while awaiting registration prevents data handover after acknowledged Core commit',async t=>{
 const f=fixture(t);f.state.after=()=>f.material.mark('source',{hidden:true});
 await assert.rejects(readMaterialFile(f.options,f.request),/changed|unavailable/i);assert.equal(f.events.length,2,'historical commit remains truthful');
});
test('abort after acknowledged commit retains history but hands over no text',async t=>{
 const f=fixture(t),stop=new AbortController();f.options.signal=stop.signal;f.state.after=()=>stop.abort();
 await assert.rejects(readMaterialFile(f.options,f.request));assert.equal(f.events.length,2);
});
test('durable append failure or lost Core reply never returns prepared text or a confirmed receipt',async t=>{
 const f=fixture(t);f.state.failAppend=true;await assert.rejects(readMaterialFile(f.options,f.request),/fsync/);assert.equal(f.events.length,0);
 f.state.failAppend=false;f.state.failCore=true;await assert.rejects(readMaterialFile(f.options,f.request),/commit/);
 assert.deepEqual(f.events.map(value=>(value as {kind:string}).kind),['material.read.tentative']);
});
test('explicit historical preparation reads the selected immutable version; ordinary current read refuses it',async t=>{
 const f=fixture(t);assert.equal((await f.material.save('source','Later source',1,'agent')).ok,true);
 await assert.rejects(readMaterialFile(f.options,f.request));
 await assert.rejects(readMaterialFile(f.options,{...f.request,historical:true}));
 const result=await readMaterialFile(f.options,{...f.request,profile:'historical-utf8',historical:true});
 assert.equal(result.text,'Exact\nsource');assert.equal(result.version,1);assert.equal(f.records[0].version,1);
});
test('saved connector material remains an unauthored MCP source for its real connection',async t=>{
 const f=fixture(t);writeFileSync(join(f.home,'material/source/meta.json'),JSON.stringify({...f.entry,fromServer:{connection:'connection',tool:'tool'}}));
 await readMaterialFile(f.options,f.request);assert.equal(f.records[0].sourceKind,'mcp');assert.equal(f.records[0].authoredBy,null);
 assert.equal(f.records[0].connection,'connection');assert.equal(f.records[0].tool,'tool');
});
