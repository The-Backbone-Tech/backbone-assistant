import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {check} from './licences.mjs';

for(const [name,metadata,allowed] of [
 ['legacy MIT',{licenses:[{type:'MIT',url:'https://example.test/LICENSE'}]},true],
 ['legacy prohibited',{licenses:[{type:'GPL-3.0'}]},false],
 ['mixed legacy obligations',{licenses:[{type:'MIT'},{type:'GPL-3.0'}]},false],
 ['legacy expression cannot mask another obligation',{licenses:[{type:'MIT OR GPL-3.0'},{type:'GPL-3.0'}]},false],
 ['empty legacy declaration',{licenses:[]},false],
 ['malformed legacy declaration',{licenses:[{url:'https://example.test/LICENSE'}]},false],
 ['current prohibited beats old MIT',{license:'GPL-3.0',licenses:[{type:'MIT'}]},false],
])test(`installed dependency licence metadata: ${name}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'licence-metadata-'));
 try{
  execFileSync('git',['init','--quiet'],{cwd:root});
  const directory=join(root,'node_modules','.pnpm','dependency@1.0.0','node_modules','dependency');mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,'package.json'),JSON.stringify({name:'dependency',version:'1.0.0',...metadata}));
  assert.equal(check(root).length===0,allowed);
 }finally{rmSync(root,{recursive:true,force:true});}
});
