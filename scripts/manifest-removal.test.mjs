import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {manifestProblems,digestOf} from './manifests.mjs';
import {render} from './module-readme.mjs';

test('only an experimental surface with a removal guard exemption can declare the missing guard truthfully',()=>{
 const root=mkdtempSync(join(tmpdir(),'manifest-removal-')),dir='packages/surfaces/demo';
 try{
  mkdirSync(join(root,dir,'test'),{recursive:true});mkdirSync(join(root,'schemas'));
  cpSync(new URL('../schemas/backbone.module.schema.json',import.meta.url),join(root,'schemas/backbone.module.schema.json'));
  const pkg={name:'demo',version:'1.0.0',license:'MIT',backbone:{layer:'surfaces'}};
  writeFileSync(join(root,dir,'package.json'),JSON.stringify(pkg));writeFileSync(join(root,dir,'test/demo.test.ts'),'');
  const m={manifest:1,id:'io.github.someone/demo',kind:'surface',version:'1.0.0',licence:'MIT',publisher:{name:'Someone',namespace:'io.github.someone',verification:{method:'github',status:'pending'}},
   provides:[],consumes:[],stability:'experimental',capabilities:{planes:['personal'],effectClasses:[3],operations:[],network:[],secrets:'none'},
   data:{owns:[],migrations:[],export:'nothing'},dependsOn:[],conformance:{suite:[`${dir}/test/demo.test.ts`],quality:{level:'bronze',exemptions:[]}},
   removal:{refusedWhileUnknown:false,rule:'Preserve receipts manually; no programmatic removal guard.'},digest:`sha256:${'0'.repeat(64)}`};
  const files=['package.json','test/demo.test.ts','backbone.module.json'].map(p=>`${dir}/${p}`);
  const check=value=>{
   writeFileSync(join(root,dir,'backbone.module.json'),JSON.stringify(value));
   writeFileSync(join(root,dir,'backbone.module.json'),JSON.stringify({...value,digest:digestOf(root,dir,files)}));
   return manifestProblems(root,files);
  };
  assert.ok(check(m).some(p=>p.includes('refusedWhileUnknown')),'an absent guard needs an explicit exemption');
  const qualified={...m,conformance:{...m.conformance,quality:{...m.conformance.quality,exemptions:[{rule:'removal guard',reason:'Not implemented; preserve unresolved receipts manually.'}]}}};
  assert.deepEqual(check(qualified),[]);
  assert.match(render(qualified),/no programmatic UNKNOWN removal guard/);
  assert.doesNotMatch(render(qualified),/refused while one of its effects is UNKNOWN/);
  assert.ok(check({...qualified,stability:'stable'}).some(p=>p.includes('refusedWhileUnknown')));
  writeFileSync(join(root,dir,'package.json'),JSON.stringify({...pkg,backbone:{layer:'modules'}}));
  assert.ok(check({...qualified,kind:'module'}).some(p=>p.includes('refusedWhileUnknown')));
  assert.deepEqual(check({...qualified,kind:'module',removal:{...qualified.removal,refusedWhileUnknown:true}}),[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
