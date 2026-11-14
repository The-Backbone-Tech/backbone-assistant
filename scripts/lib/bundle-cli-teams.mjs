// npm consumers cannot apply pnpm patch metadata. Use npm's supported bundled
// dependencies with real directories, not pnpm's links outside the archive root.
import {cpSync,existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {satisfies} from 'semver';

function installedPackage(name,from){
 for(let dir=from;;dir=dirname(dir)){
  const candidate=join(dir,'node_modules',name);
  if(existsSync(join(candidate,'package.json')))return realpathSync(candidate);
  if(dirname(dir)===dir)return;
 }
}
export function bundleTeams(stage,sourceRoot,version){
 stage=realpathSync(stage);
 const cliDependencies=JSON.parse(readFileSync(join(stage,'package.json'),'utf8')).dependencies??{};
 const providedByCli=(name,range)=>cliDependencies[name]&&satisfies(cliDependencies[name],range);
 const source=installedPackage('@chat-adapter/teams',join(sourceRoot,'packages/surfaces/channels'));
 if(!source)throw new Error('Install the pinned Teams adapter before packaging the CLI.');
 const entry=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
 if(version!=='4.44.0'||entry.version!==version||!readFileSync(join(source,'dist/index.js'),'utf8').includes('logger: this.config.appLogger,'))throw new Error('The CLI requires the pinned Teams App logger patch.');
 const adapterRoot=join(stage,'node_modules','@chat-adapter/teams');
 function copy(name,source,parent){
  const pkg=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
  const existing=installedPackage(name,parent);
  if(existing&&existing.startsWith(stage+'/')&&JSON.parse(readFileSync(join(existing,'package.json'),'utf8')).version===pkg.version)return;
  // npm installs the CLI's dependencies later. Share copies only inside Teams'
  // tree so an empty root slot cannot shadow the CLI's required version.
  const shared=join(adapterRoot,'node_modules',name);
  const target=parent===stage?adapterRoot:existsSync(join(shared,'package.json'))?join(parent,'node_modules',name):shared;
  mkdirSync(dirname(target),{recursive:true});
  // This CLI ships a runtime, not a development SDK. Keep executable assets and
  // licences; omit test data, declarations and source maps from the nested tree.
  cpSync(source,target,{recursive:true,dereference:true,filter:path=>!['node_modules','test','tests','testing','fixtures','__tests__'].includes(basename(path))&&!/(?:\.map|\.d\.[cm]?ts)$/.test(path)});
  // An absent copy is not enough: npm follows dependency declarations of bundled
  // packages too. The CLI owns these pins, so remove their redundant bundle edges.
  const bundled={...pkg};
  for(const kind of ['dependencies','optionalDependencies','peerDependencies']){
   if(pkg[kind])bundled[kind]=Object.fromEntries(Object.entries(pkg[kind]).filter(([name,range])=>!providedByCli(name,range)));
  }
  if(pkg.peerDependenciesMeta)bundled.peerDependenciesMeta=Object.fromEntries(Object.entries(pkg.peerDependenciesMeta).filter(([name])=>!pkg.peerDependencies?.[name]||!providedByCli(name,pkg.peerDependencies[name])));
  writeFileSync(join(target,'package.json'),`${JSON.stringify(bundled,null,2)}\n`);
  const optional=pkg.optionalDependencies??{};
  const dependencies={...pkg.dependencies,...optional,...pkg.peerDependencies};
  for(const dependency of Object.keys(dependencies)){
   // npm must install compatible CLI dependencies once at the root. Bundling a
   // second copy can turn its optional peers into empty npm placeholders.
   if(providedByCli(dependency,dependencies[dependency]))continue;
   const found=installedPackage(dependency,source);
   if(!found){if(dependency in optional||pkg.peerDependenciesMeta?.[dependency]?.optional)continue;throw new Error(`Missing bundled dependency ${dependency}.`);}
   copy(dependency,found,target);
  }
 }
 copy('@chat-adapter/teams',source,stage);
}
