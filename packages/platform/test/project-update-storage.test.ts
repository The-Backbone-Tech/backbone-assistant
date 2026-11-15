import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateProject } from '../src/composition/project-update.ts';
import { HomeBusy, withHomeLock } from '../src/composition/home-lock.ts';
import { writeJson } from '../src/stub/fsx.ts';

function fixture(t: import('node:test').TestContext) {
  const home = fs.mkdtempSync(join(tmpdir(), 'project-update-'));
  t.after(() => fs.rmSync(home, {recursive:true,force:true}));
  let projects = [{id:'p',name:'Original',kind:'folder' as const,createdAt:'now',dir:'original'}];
  let events = 0;
  const deps = {home,list:()=>projects,save:(next:typeof projects)=>{writeJson(join(home,'projects.json'),next);projects=next;},emit:()=>{events++;}};
  return {home,deps,projects:()=>projects,events:()=>events};
}

test('rename, archive and restore preserve project storage and emit one project event per write', async t => {
  const f=fixture(t);
  for(const patch of [{name:' Renamed '},{archived:true},{archived:false}]) {
    const result=await updateProject(f.deps,'p',patch);assert.ok(result.ok);
    assert.equal('dir' in result.value,false);
  }
  assert.equal(f.projects()[0].name,'Renamed');assert.equal(f.projects()[0].dir,'original');
  assert.equal(f.events(),3);
});

test('invalid patches and missing projects write nothing', async t => {
  const f=fixture(t);
  for(const patch of [{},{name:''},{name:123},{archived:'yes'},{dir:'elsewhere'},{name:'x',access:'owner'}]) {
    const r=await updateProject(f.deps,'p',patch as never);assert.ok(!r.ok);assert.equal(r.outcome,'REFUSED');
  }
  const missing=await updateProject(f.deps,'missing',{archived:true});assert.ok(!missing.ok);
  assert.equal(f.events(),0);assert.equal(fs.existsSync(join(f.home,'projects.json')),false);
});

test('admission lost while waiting for the folder lock refuses without changing memory or disk',async t=>{
  const f=fixture(t), statfs=fs.statfsSync;
  let admitted=true;
  t.mock.method(fs,'statfsSync',((path:fs.PathLike)=>({...statfs(path),...(!admitted?{type:0x6969}:{})})) as typeof fs.statfsSync);
  await withHomeLock(f.home,async()=>{
    admitted=false;
    const result=await updateProject(f.deps,'p',{name:'Lost'});
    assert.ok(!result.ok);assert.equal(result.outcome,'REFUSED');
    assert.equal(f.projects()[0].name,'Original');assert.equal(f.events(),0);
    assert.equal(fs.existsSync(join(f.home,'projects.json')),false);
  });
});

test('a write whose durable outcome cannot be confirmed is unknown and never repeated',async t=>{
  const f=fixture(t);let saves=0;
  const result=await updateProject({...f.deps,save:()=>{saves++;throw new Error('fsync failed');}},'p',{archived:true});
  assert.ok(!result.ok);assert.equal(result.outcome,'UNKNOWN');assert.equal(saves,1);assert.equal(f.events(),0);
});

test('an unresolved earlier storage write prevents a later project update',async t=>{
  const f=fixture(t);let saves=0;
  const result=await updateProject({...f.deps,unavailable:()=>true,save:()=>{saves++;}},'p',{name:'Later write'});
  assert.ok(!result.ok);assert.equal(result.outcome,'REFUSED');assert.equal(saves,0);
});

test('a validated patch cannot gain fields or change its name while waiting for the folder lock',async t=>{
  const f=fixture(t);let entered!:()=>void,release!:()=>void;
  const entering=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const lock=withHomeLock(f.home,async()=>{entered();await held;});await entering;
  const patch={name:'Requested name'};
  const operation=updateProject(f.deps,'p',patch);
  Object.assign(patch,{name:'Changed while waiting',dir:'other-folder'});release();await lock;
  const result=await operation;assert.ok(result.ok);assert.equal(result.value.name,'Requested name');assert.equal(f.projects()[0].dir,'original');
});

 test('rename accepts the same emoji name as creation',async t=>{
  const f=fixture(t);const result=await updateProject(f.deps,'p',{name:'Team 👩‍💻'});assert.ok(result.ok);
 });

 test('a busy folder before a project write is a refusal, not an unknown outcome',async t=>{
  const f=fixture(t);const result=await updateProject({...f.deps,list:()=>{throw new HomeBusy('controlled busy folder');}},'p',{name:'Later'});
  assert.ok(!result.ok);assert.equal(result.outcome,'REFUSED');assert.equal(f.events(),0);
 });

 test('rename retains names creation already accepts, including line breaks',async t=>{
  const f=fixture(t);const result=await updateProject(f.deps,'p',{name:'Two\nlines 👩‍💻'});assert.ok(result.ok);
 });
