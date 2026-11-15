import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {projectList} from '../src/composition/project-list.ts';

for(const landed of [false,true])test(`project list reconciles a failed write from disk (landed=${landed}) without replay`,t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'project-list-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const path=join(root,'projects.json'),before=[{id:'p',name:'Before',kind:'folder' as const,createdAt:'now',dir:'p'}],after=[{...before[0],name:'After'}];
  fs.writeFileSync(path,JSON.stringify(before));let writes=0;
  const store=projectList(path,before,next=>{writes++;if(landed)fs.writeFileSync(path,JSON.stringify(next));throw new Error('controlled disk failure');});
  assert.throws(()=>store.save(after));assert.deepEqual(store.read(),landed?after:before);assert.equal(store.unavailable(),false);assert.equal(writes,1);
});
test('project list holds writes only while disk cannot be read',t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'project-list-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const path=join(root,'projects.json'),before=[{id:'p',name:'Before',kind:'folder' as const,createdAt:'now',dir:'p'}];let writes=0;
  fs.writeFileSync(path,JSON.stringify(before));
  const store=projectList(path,before,()=>{writes++;fs.writeFileSync(path,'{broken');throw new Error('controlled read failure');});
  assert.throws(()=>store.save(before));assert.throws(()=>store.read());assert.equal(store.unavailable(),true);assert.throws(()=>store.save(before));assert.equal(writes,1);
  fs.writeFileSync(path,JSON.stringify(before));assert.deepEqual(store.read(),before);assert.equal(store.unavailable(),false);
});
