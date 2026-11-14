import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { freshHome, open, value } from './helpers.ts';
import { sha256, writeJson } from '../src/stub/fsx.ts';

test('same creation identity survives Host restart; changed fields refuse and no-key callers remain usable', async () => {
  const home=freshHome(); const first=open(home).host;
  const args={name:'Durable project',kind:'folder' as const,clientKey:'create-identity'};
  const [one,two]=await Promise.all([first.call('projects.create',args),first.call('projects.create',args)]);
  assert.deepEqual(value(one),value(two));
  const mismatch=await first.call('projects.create',{...args,name:'Changed'});assert.ok(!mismatch.ok);assert.equal(mismatch.reason,'INVALID');
  assert.notEqual(value(await first.call('projects.create',{name:'Legacy',kind:'folder'})).id,value(one).id);
  first.close();const {CoreLink}=await import('../src/composition/core.ts');await CoreLink.whenClosed(home);
  const second=open(home).host;assert.deepEqual(value(await second.call('projects.create',args)),value(one));
  assert.equal((await second.call('projects.list',{})).filter(p=>p.id===value(one).id).length,1);
});

test('an occupied reserved directory stays untouched and a started attempt remains uncertain', async () => {
  const home=freshHome(), key='occupied-attempt'; const dir='occupied-project';
  mkdirSync(join(home,'project-create-intents'),{recursive:true});mkdirSync(join(home,'projects',dir),{recursive:true});
  writeFileSync(join(home,'projects',dir,'README.md'),'human content');
  writeJson(join(home,'project-create-intents',`${sha256(key)}.json`),{key,name:'Occupied',kind:'git',phase:'reserved',project:{id:'fixed-id',name:'Occupied',kind:'git',createdAt:'now',dir}});
  const host=open(home).host;const args={name:'Occupied',kind:'git' as const,clientKey:key};
  const refused=await host.call('projects.create',args);assert.ok(!refused.ok);assert.equal(refused.outcome,'REFUSED');
  assert.equal(readFileSync(join(home,'projects',dir,'README.md'),'utf8'),'human content');
  const retry=await host.call('projects.create',args);assert.ok(!retry.ok);assert.equal(retry.outcome,'REFUSED');assert.deepEqual(retry,refused);
  assert.equal((await host.call('projects.list',{})).some(p=>p.id==='fixed-id'),false);
  host.close();const {CoreLink}=await import('../src/composition/core.ts');await CoreLink.whenClosed(home);
  const reopened=open(home).host;assert.deepEqual(await reopened.call('projects.create',args),refused);
});

test('a detected Git setup failure reports the partial folder and stays refused on retry', async () => {
  const home=freshHome(), host=open(home).host; await host.call('projects.list',{}); const oldPath=process.env.PATH;
  try {
    process.env.PATH='';
    const args={name:'Git failure',kind:'git' as const,clientKey:'git-failure'};
    const first=await host.call('projects.create',args);assert.ok(!first.ok);assert.equal(first.outcome,'REFUSED');assert.match(first.detail,/Partial files were left at/);
    const retry=await host.call('projects.create',args);assert.deepEqual(retry,first);
    assert.equal((await host.call('projects.list',{})).some(p=>p.name==='Git failure'),false);
  } finally {if(oldPath===undefined) delete process.env.PATH; else process.env.PATH=oldPath;}
});

test('invalid identity is refused before any project is created', async () => {
  const host=open().host; const result=await host.call('projects.create',{name:'Invalid',kind:'folder',clientKey:''});
  assert.ok(!result.ok);assert.equal(result.reason,'INVALID');assert.equal((await host.call('projects.list',{})).some(p=>p.name==='Invalid'),false);
});
