import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Project} from '../src/api.ts';
import {createKeyedProject} from '../src/composition/project-create.ts';
import {decideProjectIntent,type ProjectIntent} from '../src/composition/project-create-intent.ts';
import {updateProject} from '../src/composition/project-update.ts';
import {writeJson} from '../src/stub/fsx.ts';

test('creation reconciliation accepts mutable names but still checks every immutable identity field',()=>{
  const project={id:'project',name:'Original',kind:'folder' as const,dir:'original-project',createdAt:'now'};
  const intent:ProjectIntent={key:'key',name:'Original',kind:'folder',phase:'ready',project};
  const changed={...project,name:'Renamed',archived:true};
  assert.deepEqual(decideProjectIntent(intent,intent,changed),{action:'ready',intent});
  for(const patch of [{id:'other'},{kind:'git' as const},{dir:'other'},{createdAt:'later'}])assert.equal(decideProjectIntent(intent,intent,{...changed,...patch}).action,'unknown');
  assert.equal(decideProjectIntent(intent,{...intent,name:'New creation intent'},changed).action,'conflict');
});

test('a creation recheck after rename and archive returns the current project without repeating preparation',async t=>{
  const home=mkdtempSync(join(tmpdir(),'project-recheck-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  let projects:(Project&{dir:string})[]=[],started=0;
  const deps={home,list:()=>projects,save:(next:typeof projects)=>{writeJson(join(home,'projects.json'),next);projects=next;},emit:()=>{},cut:(point:string)=>{if(point==='started')started++;}};
  const made=await createKeyedProject(deps,'Original','folder','creation-key');assert.ok(made.ok);
  const edited=await updateProject(deps,made.value.id,{name:'Renamed',archived:true});assert.ok(edited.ok);
  const folders=readdirSync(join(home,'projects'));
  for(let i=0;i<2;i++){
    const checked=await createKeyedProject(deps,'Original','folder','creation-key');assert.ok(checked.ok);
    assert.equal(checked.value.id,made.value.id);assert.equal(checked.value.name,'Renamed');assert.equal(checked.value.archived,true);
  }
  assert.equal(started,1);assert.deepEqual(readdirSync(join(home,'projects')),folders);assert.equal(projects.length,1);
});
