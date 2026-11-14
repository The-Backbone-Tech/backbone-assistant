import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ApiLineProjectBudget,serveApiLine} from '@backbone-next/platform/composition/api-line';
import {spawn} from 'node:child_process';
import {childHangTimer} from '../../../../scripts/lib/test-child.ts';

function run(home:string, args:string[]) {
  return new Promise<{code:number|null;out:string;err:string}>(resolve => {
    const child = spawn(process.execPath, [new URL('../src/main.ts', import.meta.url).pathname, ...args], {env:{...process.env,BACKBONE_HOME:home},stdio:['ignore','pipe','pipe']});
    const timer = childHangTimer(child, 'project CLI completion');
    let out = '', err = '';
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.once('close', code => {clearTimeout(timer); resolve({code,out,err});});
  });
}

test('projects create reaches the running local service and projects list shows its answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-project-line-'));
  const projects: {id:string;name:string;kind:string;createdAt:string}[] = [];
  const server = await serveApiLine({home, readOnly:true, projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(), call:async (method, args) => {
    if (method === 'projects.list') return projects as never;
    assert.equal(method, 'projects.create');
    const input = args as {name:string;kind:string;clientKey:string};
    assert.match(input.clientKey, /^[0-9a-f-]{36}$/);
    const project = {id:'project',name:input.name,kind:input.kind,createdAt:'2026-11-14T00:00:00.000Z'};
    projects.push(project);
    return {ok:true,value:project} as never;
  }});
  try {
    const made = await run(home, ['projects','create','Launch plan']);
    assert.equal(made.code, 0, made.err);
    assert.match(made.out, /Created Launch plan \(project\)/);
    const listed = await run(home, ['projects','list']);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /project  Launch plan \(folder\)/);
  } finally { await server.close(); rmSync(home,{recursive:true,force:true}); }
});

test('refused, unknown and lost project creations never print Created or send twice', async () => {
  for (const outcome of ['REFUSED','UNKNOWN','lost'] as const) {
    const home = mkdtempSync(join(tmpdir(), 'cli-project-outcome-'));
    let calls = 0;
    const server = await serveApiLine({home,projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(),call:async () => {
      calls++;
      if (outcome === 'lost') throw Error('private detail');
      return {ok:false,reason:'NOT_AVAILABLE',outcome,detail:'Creation could not be confirmed.'} as never;
    }});
    try {
      const made = await run(home, ['projects','create','Launch plan','--json']);
      assert.equal(made.code, outcome === 'REFUSED' ? 1 : 4, made.err);
      assert.equal(made.out, '');
      assert.match(made.err, outcome === 'REFUSED' ? /REFUSED/ : /Unknown outcome/);
      if (outcome !== 'REFUSED') assert.doesNotMatch(made.err,/REFUSED/);
      assert.doesNotMatch(made.out + made.err, /Created|private detail/);
      assert.equal(calls,1);
    } finally {await server.close(); rmSync(home,{recursive:true,force:true});}
  }
});
