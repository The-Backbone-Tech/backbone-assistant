import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Args, Project, Receipt} from '../src/api.ts';
import {ApiLineProjectBudget,serveApiLine} from '../src/composition/api-line.ts';
import {attachApi, API_LINE_PROJECTS} from '../src/doors/api-line.ts';
import {createKeyedProject} from '../src/composition/project-create.ts';

const input = {name:'Launch plan',kind:'folder',clientKey:'create-1'} as const;

test('project creation is exactly one opt-in local request and all other writes stay closed', async () => {
  assert.deepEqual(API_LINE_PROJECTS, ['projects.create', 'projects.update']);
  for (const enabled of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), 'line-projects-'));
    const calls:unknown[] = [];
    const server = await serveApiLine({home,readOnly:true,projectCreation:enabled,projectCreationBudget:new ApiLineProjectBudget(),call:async (method,args) => {calls.push({method,args}); return {ok:true,value:{id:'project'}} as never;}});
    const client = await attachApi(home); assert.ok(client);
    try {
      const created = await client.call('projects.create', {...input, name:' Launch plan ', path:'/ignored', role:'admin', projectCreation:true} as Args<'projects.create'>);
      assert.equal(created.ok, enabled);
      assert.deepEqual(calls, enabled ? [{method:'projects.create',args:input}] : []);
      for (const method of ['terminal.run','settings.model.put','threads.delete','identity.invite','turns.stop','turns.send']) {
        const denied = await client.call(method as never, {} as never) as {ok:boolean};
        assert.equal(denied.ok, false, method);
      }
      assert.equal(calls.length, enabled ? 1 : 0);
    } finally {client.close(); await server.close(); rmSync(home,{recursive:true,force:true});}
  }
});

test('project creation validates the full name, kind and bounded creation identity before calling the host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'line-project-validation-'));
  let calls = 0;
  const server = await serveApiLine({home,projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(),call:async () => {calls++; return {ok:true} as never;}});
  const client = await attachApi(home); assert.ok(client);
  try {
    for (const changed of [{name:''},{name:'  '},{name:'a\nb'},{name:'a\u202eb'},{name:'x'.repeat(1001)},{kind:'other'},{clientKey:undefined},{clientKey:''},{clientKey:'x'.repeat(257)},{clientKey:'a\nb'}]) {
      const receipt:Receipt<Project> = await client.call('projects.create', {...input,...changed} as Args<'projects.create'>);
      assert.ok(!receipt.ok); assert.equal(receipt.outcome,'REFUSED'); assert.equal(receipt.reason,'INVALID');
    }
    assert.equal(calls,0);
  } finally {client.close(); await server.close(); rmSync(home,{recursive:true,force:true});}
});

test('the line preserves the project intent: one project per identity, conflicting details refused, interrupted creation unknown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'line-project-intent-'));
  let projects:(Project & {dir:string})[] = [];
  let cut = false;
  const server = await serveApiLine({home,readOnly:true,projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(),call:async (method,args) => {
    if (method === 'projects.list') return projects.map(({dir:_dir,...project})=>project) as never;
    assert.equal(method,'projects.create');
    const {name,kind,clientKey} = args as Args<'projects.create'>;
    return await createKeyedProject({home,list:()=>projects,save:next=>{projects=next;},emit:()=>{},cut:point=>{if(cut && point==='started') throw Error('simulated interruption');}},name,kind,clientKey!) as never;
  }});
  const client = await attachApi(home); assert.ok(client);
  try {
    for (const kind of ['folder','git'] as const) {
      const args = {...input,kind,clientKey:kind};
      const one:Receipt<Project> = await client.call('projects.create',args); assert.ok(one.ok);
      assert.deepEqual(await client.call('projects.create',args),one);
      const changed:Receipt<Project> = await client.call('projects.create',{...args,name:'Changed'});
      assert.ok(!changed.ok); assert.equal(changed.outcome,'REFUSED');
    }
    assert.equal((await client.call('projects.list',{})).length,2);
    cut = true;
    await assert.rejects(client.call('projects.create',input), /not known/);
    const unconfirmed = await client.call('projects.create',input);
    assert.ok(!unconfirmed.ok); assert.equal(unconfirmed.outcome,'UNKNOWN');
    assert.equal((await client.call('projects.list',{})).length,2);
  } finally {client.close(); await server.close(); rmSync(home,{recursive:true,force:true});}
});
