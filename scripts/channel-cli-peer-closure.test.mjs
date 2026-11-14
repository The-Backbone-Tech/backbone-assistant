import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {satisfies} from 'semver';
import {bundleTeams} from './lib/bundle-cli-teams.mjs';

const root=join(import.meta.dirname,'..');

test('a compatible CLI dependency is supplied by npm even when the adapter installed another compatible version',()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'channel-cli-root-peer-')));
 try{
  function pkg(path,entry){mkdirSync(path,{recursive:true});writeFileSync(join(path,'package.json'),JSON.stringify(entry));}
  const source=join(home,'source');
  const stage=join(home,'stage');
  const teams=join(source,'packages/surfaces/channels/node_modules/@chat-adapter/teams');
  pkg(stage,{name:'cli-fixture',version:'1.0.0',dependencies:{'fixture-shared':'2.3.4','fixture-peer':'4.0.0'}});
  pkg(teams,{name:'@chat-adapter/teams',version:'4.44.0',dependencies:{'fixture-shared':'^2.0.0 || ^3.0.0'}});
  mkdirSync(join(teams,'dist'));writeFileSync(join(teams,'dist/index.js'),'// logger: this.config.appLogger,');
  pkg(join(teams,'node_modules/fixture-shared'),{name:'fixture-shared',version:'2.4.0',peerDependencies:{'fixture-peer':'^3 || ^4'},peerDependenciesMeta:{'fixture-peer':{optional:true}}});
  pkg(join(teams,'node_modules/fixture-shared/node_modules/fixture-peer'),{name:'fixture-peer',version:'3.0.0'});

  bundleTeams(stage,source,'4.44.0');

  const packages=readdirSync(stage,{recursive:true}).filter(path=>path.endsWith('package.json')).map(path=>JSON.parse(readFileSync(join(stage,path))));
  assert.deepEqual(packages.map(pkg=>pkg.name).sort(),['@chat-adapter/teams','cli-fixture']);
  assert.equal(packages.find(pkg=>pkg.name==='cli-fixture').dependencies['fixture-shared'],'2.3.4');
  assert.equal(packages.find(pkg=>pkg.name==='@chat-adapter/teams').dependencies['fixture-shared'],undefined);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('the packed CLI has no bundled optional peer that is also a CLI dependency',{timeout:180_000},()=>{
 const home=mkdtempSync(join(tmpdir(),'channel-cli-peer-closure-'));
 try{
  const archive=execFileSync(process.execPath,[join(root,'scripts/pack-cli.mjs'),home],{encoding:'utf8'}).trim();
  const unpack=join(home,'unpack');mkdirSync(unpack);execFileSync('tar',['-xzf',archive,'-C',unpack]);
  const cli=join(unpack,'package');
  const dependencies=JSON.parse(readFileSync(join(cli,'package.json'))).dependencies;
  const collisions=[];
  const bundledRootEdges=[];
  for(const path of readdirSync(join(cli,'node_modules'),{recursive:true,withFileTypes:true})){
   if(!path.isFile()||path.name!=='package.json')continue;
   const pkg=JSON.parse(readFileSync(join(path.parentPath,path.name)));
   for(const kind of ['dependencies','optionalDependencies','peerDependencies']){
    for(const [dependency,range] of Object.entries(pkg[kind]??{})){
     if(dependencies[dependency]&&satisfies(dependencies[dependency],range))bundledRootEdges.push({package:pkg.name,dependency,kind});
    }
   }
   for(const peer of Object.keys(pkg.peerDependencies??{})){
    if(pkg.peerDependenciesMeta?.[peer]?.optional&&Object.hasOwn(dependencies,peer))collisions.push({package:pkg.name,peer});
   }
  }
  assert.deepEqual(collisions,[],'npm must own CLI dependencies without bundled optional-peer placeholders');
  assert.deepEqual(bundledRootEdges,[],'bundled metadata must not pull compatible root dependencies into npm bundled ownership');
 }finally{rmSync(home,{recursive:true,force:true});}
});
