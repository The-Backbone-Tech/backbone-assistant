import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {bundleTeams} from './lib/bundle-cli-teams.mjs';

for(const rootInstalled of [false,true]){
 test(`Teams dependencies leave the CLI root dependency ${rootInstalled?'unchanged':'available for npm to install'}`,()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'channel-cli-dependencies-')));
  try{
   const source=join(home,'source');
   const stage=join(home,'stage');
   function file(path,contents){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,contents);}
   function pkg(path,name,version,dependencies={}){file(join(path,'package.json'),JSON.stringify({name,version,dependencies}));}
   const teams=join(source,'packages/surfaces/channels/node_modules/@chat-adapter/teams');
   pkg(teams,'@chat-adapter/teams','4.44.0',{zod:'3.0.0'});
   file(join(teams,'dist/index.js'),'// logger: this.config.appLogger,');
   file(join(teams,'dist/index.d.ts'),'export {};');
   file(join(teams,'dist/index.js.map'),'{}');
   file(join(teams,'LICENSE'),'Fixture licence retained');
   const adapterZod=join(teams,'node_modules/zod');
   pkg(adapterZod,'zod','3.0.0',{'fixture-leaf':'1.0.0'});
   pkg(join(adapterZod,'node_modules/fixture-leaf'),'fixture-leaf','1.0.0');
   pkg(stage,'cli-fixture','1.0.0',{zod:'4.0.0'});
   const rootZod=join(stage,'node_modules/zod');
   if(rootInstalled){pkg(rootZod,'zod','4.0.0');file(join(rootZod,'v4/index.js'),'export const cliDependency = true;');}
   const before=rootInstalled?readFileSync(join(rootZod,'package.json'),'utf8'):undefined;

   bundleTeams(stage,source,'4.44.0');

   assert.deepEqual(readdirSync(join(stage,'node_modules')).sort(),rootInstalled?['@chat-adapter','zod']:['@chat-adapter']);
   const bundledTeams=join(stage,'node_modules/@chat-adapter/teams');
   assert.deepEqual(readdirSync(join(bundledTeams,'dist')),['index.js']);
   assert.equal(readFileSync(join(bundledTeams,'LICENSE'),'utf8'),'Fixture licence retained');
   const adapterRequire=createRequire(join(bundledTeams,'package.json'));
   assert.equal(adapterRequire('zod/package.json').version,'3.0.0');
   const nestedZod=join(bundledTeams,'node_modules/zod');
   assert.equal(adapterRequire.resolve('zod/package.json'),join(nestedZod,'package.json'));
   assert.equal(createRequire(join(nestedZod,'package.json'))('fixture-leaf/package.json').version,'1.0.0');
   if(rootInstalled){
    assert.equal(readFileSync(join(rootZod,'package.json'),'utf8'),before);
    assert.equal(createRequire(join(stage,'package.json'))('zod/package.json').version,'4.0.0');
    assert.equal(readFileSync(join(rootZod,'v4/index.js'),'utf8'),'export const cliDependency = true;');
   }
  }finally{rmSync(home,{recursive:true,force:true});}
 });
}
