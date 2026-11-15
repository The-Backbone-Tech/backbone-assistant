import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Receipt,Project} from '../src/api.ts';
import {ApiLineProjectBudget,serveApiLine} from '../src/composition/api-line.ts';
import {attachApi} from '../src/doors/api-line.ts';

test('project update line rebuilds bounded properties and refuses authority or path changes',async()=>{
  const home=mkdtempSync(join(tmpdir(),'project-line-properties-'));const calls:unknown[]=[];
  const server=await serveApiLine({home,projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(),call:async(method,args)=>{calls.push({method,args});return {ok:true,value:{id:'p'}} as never;}});
  const client=await attachApi(home);assert.ok(client);
  try{
    for(const args of [
      {id:'',patch:{name:'Name'}},{id:'p\nq',patch:{name:'Name'}},{id:'p',patch:{}},
      {id:'p',patch:{name:''}},{id:'p',patch:{name:' \t '}},{id:'p',patch:{name:'a\u202eb'}},{id:'p',patch:{name:'x'.repeat(1001)}},
      {id:'p',patch:{archived:'yes'}},{id:'p',patch:{archived:null}},{id:'p',patch:{dir:'other'}},{id:'p',patch:{access:'owner'}},
    ]){
      const result:Receipt<Project>=await client.call('projects.update',args as never);assert.ok(!result.ok);assert.equal(result.reason,'INVALID');assert.equal(result.outcome,'REFUSED');assert.match(result.detail,/project change needs/);
    }
    assert.equal(calls.length,0);
    const result:Receipt<Project>=await client.call('projects.update',{id:'p',patch:{name:'Renamed',archived:true},path:'/ignored',personId:'other'} as never);assert.ok(result.ok);
    assert.deepEqual(calls,[{method:'projects.update',args:{id:'p',patch:{name:'Renamed',archived:true}}}]);
  }finally{client.close();await server.close();rmSync(home,{recursive:true,force:true});}
});

test('project line creation and rename both accept joined emoji',async()=>{
  const home=mkdtempSync(join(tmpdir(),'project-line-emoji-'));const calls:unknown[]=[];
  const server=await serveApiLine({home,projectCreation:true,projectCreationBudget:new ApiLineProjectBudget(),call:async(method,args)=>{calls.push({method,args});return {ok:true,value:{id:'p'}} as never;}});
  const client=await attachApi(home);assert.ok(client);
  try{
    assert.ok((await client.call('projects.create',{name:'Team 👩‍💻',kind:'folder',clientKey:'emoji'})).ok);
    assert.ok((await client.call('projects.update',{id:'p',patch:{name:'Team 👩‍💻'}})).ok);
    assert.equal(calls.length,2);
  }finally{client.close();await server.close();rmSync(home,{recursive:true,force:true});}
});
