// Grade the source graph the image executes, not merely its entry point's inclusion.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {test} from 'node:test';
import {parse} from '@babel/parser';
const root=resolve(import.meta.dirname,'..');
function imports(file,sources){
 if(!/\.(?:ts|tsx|mjs|js)$/.test(file))return [];
 const tree=parse(sources.get(file)??readFileSync(file,'utf8'),{sourceType:'module',plugins:['typescript'],createImportExpressions:true});
 const found=[];
 function walk(node){
  if(!node||typeof node!=='object')return;
  const source=['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)?node.source
   :node.type==='ImportExpression'?node.source:null;
  if(typeof source?.value==='string'&&source.value.startsWith('.'))found.push(resolve(dirname(file),source.value));
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
 }
 walk(tree);return found;
}
function missingCoreImports(context,sources=new Map()){
 const seen=new Set(),missing=[],pending=['packages/core/src/index.ts','packages/core/src/db/index.ts'].map(file=>join(root,file));
 while(pending.length){
  const file=pending.pop(),path=relative(root,file).split('\\').join('/');
  if(seen.has(file)||!path.startsWith('packages/core/src/'))continue;
  seen.add(file);if(!context.has(path))missing.push(path);
  pending.push(...imports(file,sources));
 }
 return missing.sort();
}
const context=()=>new Set(execFileSync(process.execPath,['scripts/lib/docker-context.mjs','--list'],{cwd:root,encoding:'utf8'}).trim().split('\n'));
test('every Core entry and database import/re-export, including dynamic imports, is included in the image build context',()=>{
 assert.deepEqual(missingCoreImports(context()),[]);
});
test('the graph check detects excluded transitive pins even when the Core entry point is present',()=>{
 const files=context();assert.ok(files.has('packages/core/src/db/index.ts'));
 files.delete('packages/core/src/db/signature-ledger-pins.ts');
 assert.deepEqual(missingCoreImports(files),['packages/core/src/db/signature-ledger-pins.ts']);
});

test('the graph rejects a JSON import added to the public Core entry',()=>{
 const entry=join(root,'packages/core/src/index.ts');
 const sources=new Map([[entry,readFileSync(entry,'utf8')+"\nimport './excluded-image-data.json';\n"]]);
 assert.deepEqual(missingCoreImports(context(),sources),['packages/core/src/excluded-image-data.json']);
});
test('the graph rejects an excluded dynamic import nested inside the database graph',()=>{
 const entry=join(root,'packages/core/src/db/signature-ledger.ts'),target=join(root,'packages/core/src/db/excluded-image-module.ts');
 const sources=new Map([[entry,readFileSync(entry,'utf8')+"\nasync function imageProbe(){return import('./excluded-image-module.ts');}\n"],[target,'export {};']]);
 assert.deepEqual(missingCoreImports(context(),sources),['packages/core/src/db/excluded-image-module.ts']);
});
