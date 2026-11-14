// Offline retention controls with real disposable Store files, no provider or database.
import assert from 'node:assert/strict';
import {chmodSync,existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import type {MaterialEntry} from '../src/api.ts';
import {MaterialStore,type MaterialImport} from '../src/stub/material.ts';
import {sha256} from '../src/stub/fsx.ts';

function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'observation-material-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const projected:MaterialEntry[]=[];
 const store=new MaterialStore(home,{},entry=>projected.push(structuredClone(entry)));
 const input={id:'11111111-1111-4111-8111-111111111111',observation:'a'.repeat(64),projectId:'project',name:'Observed answer.json',mediaType:'application/json',body:'{"answer":"Exact 😀"}',connection:'22222222-2222-4222-8222-222222222222',tool:'read_answer'};
 const meta=join(home,'material',input.id,'meta.json'),version=join(home,'material',input.id,'versions','1');
 return {home,store,input,projected,meta,version};
}

test('retention creates an exact private managed original already pending, never projected or offered',t=>{
 const f=fixture(t),entry=f.store.retainConnectorObservation(f.input);
 assert.deepEqual(entry.observation,{id:f.input.observation,state:'pending'});
 assert.equal(entry.class,'original');assert.equal(entry.projection,'managed');assert.equal(entry.current,1);
 assert.deepEqual(entry.fromServer,{connection:f.input.connection,tool:f.input.tool});
 assert.equal(entry.versions[0].sha256,sha256(f.input.body));assert.equal(entry.versions[0].by,'agent');
 assert.equal(Buffer.from(f.store.bytes(entry.id,1)).toString(),f.input.body);
 assert.deepEqual(f.projected,[]);assert.deepEqual(f.store.list('project'),[]);assert.deepEqual(f.store.available('project'),[]);
 assert.equal(f.store.list('project',true)[0].id,entry.id);
 for(const path of [join(f.home,'material'),join(f.home,'material',entry.id),join(f.home,'material',entry.id,'versions')])assert.equal(lstatSync(path).mode&0o777,0o700);
});

test('exact pending and registered replays preserve the original metadata, immutable bytes and lifecycle',t=>{
 const f=fixture(t),first=f.store.retainConnectorObservation(f.input),before=readFileSync(f.meta);
 assert.deepEqual(f.store.retainConnectorObservation(f.input),first);assert.deepEqual(readFileSync(f.meta),before);
 const registered=f.store.registerConnectorObservation(first.id,f.input.observation,sha256(f.input.body));
 assert.equal(registered.observation?.state,'registered');assert.equal(f.store.list('project').length,1);
 const hidden=f.store.mark(first.id,{hidden:true}),registeredBefore=readFileSync(f.meta);
 assert.deepEqual(f.store.retainConnectorObservation(f.input),hidden);
 assert.deepEqual(readFileSync(f.meta),registeredBefore);assert.deepEqual(f.projected,[]);
 assert.equal(f.store.registerConnectorObservation(first.id,f.input.observation,sha256(f.input.body)).hidden,true,'idempotent registration never clears a later choice');
});

for(const patch of [{id:'other'},{observation:'b'.repeat(64)},{projectId:'other'},{name:'Different.json'},{mediaType:'text/plain'},{body:'{"answer":"Other 😀"}'},{connection:'33333333-3333-4333-8333-333333333333'},{tool:'other_tool'}])test(`changed immutable retention request refuses without replacing anything: ${JSON.stringify(patch)}`,t=>{
 const f=fixture(t);f.store.retainConnectorObservation(f.input);const before=readFileSync(f.meta),bytes=readFileSync(f.version);
 if('id' in patch){assert.throws(()=>f.store.retainConnectorObservation({...f.input,id:'44444444-4444-4444-8444-444444444444'}));}
 else assert.throws(()=>f.store.retainConnectorObservation({...f.input,...patch}));
 assert.deepEqual(readFileSync(f.meta),before);assert.deepEqual(readFileSync(f.version),bytes);
});

test('ordinary material at the preallocated id is never adopted as an observation',t=>{
 const f=fixture(t);f.store.create('project',f.input.name,f.input.mediaType,Buffer.from(f.input.body),'original','agent',f.input.id,'managed',undefined,{connection:f.input.connection,tool:f.input.tool});
 const before=readFileSync(f.meta);assert.throws(()=>f.store.retainConnectorObservation(f.input));assert.deepEqual(readFileSync(f.meta),before);
});

test('partial preallocated directories and unexpected version files remain inert recovery evidence',t=>{
 const f=fixture(t),dir=join(f.home,'material',f.input.id);mkdirSync(join(dir,'versions'),{recursive:true});writeFileSync(f.version,'partial');
 assert.throws(()=>f.store.retainConnectorObservation(f.input));assert.equal(readFileSync(f.version,'utf8'),'partial');assert.equal(existsSync(f.meta),false);
 rmSync(dir,{recursive:true});f.store.retainConnectorObservation(f.input);writeFileSync(join(dir,'versions','2'),'unexpected');
 assert.throws(()=>f.store.retainConnectorObservation(f.input));assert.throws(()=>f.store.registerConnectorObservation(f.input.id,f.input.observation,sha256(f.input.body)));
});

test('immutable byte corruption refuses both replay and registration',t=>{
 const f=fixture(t);f.store.retainConnectorObservation(f.input);chmodSync(f.version,0o600);writeFileSync(f.version,Buffer.from(f.input.body).map(byte=>byte===69?79:byte));
 assert.throws(()=>f.store.retainConnectorObservation(f.input));assert.throws(()=>f.store.registerConnectorObservation(f.input.id,f.input.observation,sha256(f.input.body)));
 assert.equal(f.store.load(f.input.id)?.observation?.state,'pending');
});

for(const patch of [{hidden:true},{held:{id:'source',name:'held'}},{unsure:{id:'source',name:'uncertain'}},{recovery:{turnId:'turn',reason:'inspect'}},{interruptedSave:{version:2,at:'now'}},{lifecycle:1},{restored:true},{projecting:'in'}])test(`changed pending state is never cleared by a historical Core confirmation: ${JSON.stringify(patch)}`,t=>{
 const f=fixture(t),entry=f.store.retainConnectorObservation(f.input);writeFileSync(f.meta,JSON.stringify({...entry,...patch}));
 const before=readFileSync(f.meta);assert.throws(()=>f.store.registerConnectorObservation(entry.id,f.input.observation,sha256(f.input.body)));
 assert.deepEqual(readFileSync(f.meta),before);assert.equal(f.store.available('project').length,0);
});

test('withdrawal and restore preserve pending status and cannot project or revive the observation',t=>{
 const f=fixture(t),entry=f.store.retainConnectorObservation(f.input);f.store.withdraw(entry.id);f.store.restore(entry.id);
 assert.equal(f.store.load(entry.id)?.withdrawals?.length,1);assert.equal(f.store.load(entry.id)?.observation?.state,'pending');
 assert.equal(f.projected.length,0);assert.equal(f.store.available('project').length,0);assert.equal(f.store.list('project').length,0);
 assert.throws(()=>f.store.registerConnectorObservation(entry.id,f.input.observation,sha256(f.input.body)));
});

test('matching digests cannot register the wrong observation or a forged metadata shape',t=>{
 const f=fixture(t),entry=f.store.retainConnectorObservation(f.input);
 assert.throws(()=>f.store.registerConnectorObservation(entry.id,'b'.repeat(64),sha256(f.input.body)));
 assert.throws(()=>f.store.registerConnectorObservation(entry.id,f.input.observation,'b'.repeat(64)));
 writeFileSync(f.meta,JSON.stringify({...entry,class:'accepted'}));
 assert.throws(()=>f.store.registerConnectorObservation(entry.id,f.input.observation,sha256(f.input.body)));
});

test('symlink aliases never substitute observation directories, metadata or version bytes',t=>{
 const f=fixture(t),other=join(f.home,'elsewhere');mkdirSync(other);mkdirSync(join(f.home,'material'));
 symlinkSync(other,join(f.home,'material',f.input.id));assert.throws(()=>f.store.retainConnectorObservation(f.input));
 rmSync(join(f.home,'material',f.input.id));f.store.retainConnectorObservation(f.input);
 const bytes=readFileSync(f.version),external=join(other,'version');writeFileSync(external,bytes);rmSync(f.version);symlinkSync(external,f.version);
 assert.throws(()=>f.store.retainConnectorObservation(f.input));assert.throws(()=>f.store.registerConnectorObservation(f.input.id,f.input.observation,sha256(f.input.body)));
});

test('restoration creates a new identity and imports no observation marker or registration',async t=>{
 const f=fixture(t),layout={projection:'managed',original:true,observation:{id:f.input.observation,state:'registered'},fromServer:{connection:f.input.connection,tool:f.input.tool}} as MaterialImport;
 const result=await f.store.importDocument('project','Restored.json','application/json',[f.input.body],layout);
 assert.equal(result.ok,true);if(!result.ok)return;
 assert.notEqual(result.value.id,f.input.id);assert.equal(result.value.observation,undefined);assert.equal(result.value.fromServer,undefined);assert.equal(result.value.restored,true);
 assert.throws(()=>f.store.registerConnectorObservation(result.value.id,f.input.observation,sha256(f.input.body)));
});

test('an aliased material root refuses before settling unrelated Save evidence through that alias',t=>{
 const f=fixture(t),external=join(f.home,'outside-material'),other=join(external,'other');mkdirSync(other,{recursive:true});
 const metadata={id:'other',projectId:'project',name:'other.md',mediaType:'text/plain',class:'working',hidden:false,current:1,versions:[{n:1,at:'2026-11-09T00:00:00Z',by:'agent',bytes:1,sha256:sha256('x')}]};
 const meta=join(other,'meta.json'),intent=join(other,'intent.json');writeFileSync(meta,JSON.stringify(metadata));writeFileSync(intent,JSON.stringify({version:2,at:'now'}));
 symlinkSync(external,join(f.home,'material'));const before=readFileSync(meta);
 assert.throws(()=>f.store.retainConnectorObservation(f.input));assert.equal(existsSync(intent),true);assert.deepEqual(readFileSync(meta),before);
});

test('metadata or byte hard-link aliases refuse replay and registration',t=>{
 const f=fixture(t);f.store.retainConnectorObservation(f.input);linkSync(f.version,join(f.home,'another-byte-name'));
 assert.throws(()=>f.store.retainConnectorObservation(f.input));assert.throws(()=>f.store.registerConnectorObservation(f.input.id,f.input.observation,sha256(f.input.body)));
 rmSync(join(f.home,'another-byte-name'));linkSync(f.meta,join(f.home,'another-meta-name'));
 assert.throws(()=>f.store.retainConnectorObservation(f.input));assert.throws(()=>f.store.registerConnectorObservation(f.input.id,f.input.observation,sha256(f.input.body)));
});

test('a pending projection intent is settled without projecting bytes or enabling agent input',t=>{
 const f=fixture(t),entry=f.store.retainConnectorObservation(f.input);
 writeFileSync(f.meta,JSON.stringify({...entry,projecting:'in'}));f.store.settleProjections();
 assert.equal(f.store.load(entry.id)?.projecting,undefined);assert.equal(f.projected.length,0);
 assert.equal(f.store.list('project').length,0);assert.equal(f.store.available('project').length,0);
});

for(const name of ['x'.repeat(1025),'.hidden.json','nested/answer.json','line\nanswer.json','back\\answer.json','   '])test(`new connector retention refuses an unsupported flat label before filesystem mutation: ${JSON.stringify(name.slice(0,40))}`,t=>{
 const f=fixture(t);
 assert.throws(()=>f.store.retainConnectorObservation({...f.input,name}),/supported flat label/);
 assert.equal(existsSync(join(f.home,'material')),false);assert.deepEqual(f.projected,[]);
});

test('an exact legacy overlong original remains immutable during replay without a silent rename or lifecycle reset',t=>{
 const f=fixture(t),input={...f.input,name:'Legacy '+ 'x'.repeat(1100)+'.json'};
 // Reconstruct the old released format, which admitted this label before the new-write guard.
 const original=f.store.create(input.projectId,input.name,input.mediaType,Buffer.from(input.body),'original','agent',input.id,'managed',undefined,{connection:input.connection,tool:input.tool});
 writeFileSync(f.meta,JSON.stringify({...original,hidden:true,lifecycle:1,observation:{id:input.observation,state:'registered'}}));
 const metadata=readFileSync(f.meta),bytes=readFileSync(f.version);
 const replayed=f.store.retainConnectorObservation(input);
 assert.equal(replayed.name,input.name);assert.equal(replayed.hidden,true);assert.equal(replayed.lifecycle,1);
 assert.deepEqual(readFileSync(f.meta),metadata);assert.deepEqual(readFileSync(f.version),bytes);
 assert.throws(()=>f.store.retainConnectorObservation({...input,name:'Silently shortened.json'}),/another immutable source/);
 assert.deepEqual(readFileSync(f.meta),metadata);
});
