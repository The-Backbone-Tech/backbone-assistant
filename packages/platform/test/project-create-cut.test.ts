import { childHangTimer } from '../../../scripts/lib/test-child.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freshHome, open, value } from './helpers.ts';
import { sha256 } from '../src/stub/fsx.ts';

for (const kind of ['folder','git'] as const) for (const point of ['reserved','started','prepared','recorded'] as const) {
  test(`real Host ${kind} cut at ${point} keeps a single stable project identity`, async () => {
    const home=freshHome(); const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/project-create-host-cut.ts',import.meta.url)),home,point,kind],{stdio:['ignore','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',data=>{output+=String(data);});child.stderr.on('data',data=>{errors+=String(data);});
    const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{const timer=childHangTimer(child, `project ${kind} crash cut ${point}`, ()=>reject(new Error(`cut hang detector: ${errors}`)));child.once('error',reject);child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
    assert.match(output,new RegExp(`CUT ${point}`));assert.equal(result.signal,'SIGKILL');
    const saved=JSON.parse(readFileSync(join(home,'project-create-intents',`${sha256('cut-identity')}.json`),'utf8'));
    const folder=join(home,'projects',saved.project.dir);
    assert.equal(existsSync(folder),point==='prepared' || point==='recorded');
    if ((point==='prepared' || point==='recorded') && kind==='git') {assert.equal(readFileSync(join(folder,'README.md'),'utf8'),'# Cut project\n');assert.ok(existsSync(join(folder,'.git')));}
    // The kernel's own stale locks must expire after a killed process; this is real reopen, not a mocked store.
    await new Promise(resolve=>setTimeout(resolve,6_000));
    const host=open(home).host;const result2=await host.call('projects.create',{name:'Cut project',kind,clientKey:'cut-identity'});
    if (point==='started' || point==='prepared') {assert.ok(!result2.ok);assert.equal(result2.outcome,'UNKNOWN');assert.match(result2.detail,new RegExp(saved.project.dir));assert.equal((await host.call('projects.list',{})).some(p=>p.id===saved.project.id),false);}
    else {assert.equal(value(result2).id,saved.project.id);assert.equal((await host.call('projects.list',{})).filter(p=>p.id===saved.project.id).length,1);}
  });
}
