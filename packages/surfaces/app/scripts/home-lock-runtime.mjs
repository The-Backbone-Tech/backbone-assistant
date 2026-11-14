// The one external Node-API backend and its production loader closure, shared by main and MCP.
import {createHash} from 'node:crypto';
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Publisher tarball 1.5.3, selected Node-API .node files (not Bare/NAN payloads).
const PAYLOADS={
 '1.5.3:darwin-arm64':'150874bf1529508be53c319f30ca76ae0ac5925ea13a582881392b11f27c6a1d',
 '1.5.3:darwin-x64':'1626a4905c888fae83120b7ff00e0acacc26631657dd6c6fb894d0946af2ff20',
 '1.5.3:linux-arm64':'882acf55bc832f1ff8c0617185551885b9f738b72a805a1ffdedb7331454178a',
 '1.5.3:linux-x64':'2984ccaa4f18338c86f20be0c50c5545327dae8e2bf0896162444791e15ddecd',
};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function packageRoot(name,from){
 const require=createRequire(join(from,'package.json'));
 let at=dirname(require.resolve(name));
 for(;;){
  const manifest=join(at,'package.json');
  if(existsSync(manifest)&&JSON.parse(readFileSync(manifest,'utf8')).name===name)return realpathSync(at);
  const parent=dirname(at);if(parent===at)throw new Error(`Cannot find the installed manifest for ${name}.`);at=parent;
 }
}

/** Build-only: every installed reader gets the same selected backend; no runtime installer. */
export function stageHomeLockRuntime(){
 const kernel=dirname(fileURLToPath(new URL('../../../kernel/package.json',import.meta.url)));
 const requested=JSON.parse(readFileSync(join(kernel,'package.json'),'utf8')).dependencies['fs-native-extensions'];
 const source=packageRoot('fs-native-extensions',kernel),manifest=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
 if(manifest.version!==requested)throw new Error('The native lock backend differs from the pinned Kernel dependency.');
 const target=`${process.platform}-${process.arch}`,selected=`prebuilds/${target}/fs-native-extensions.node`;
 const expected=PAYLOADS[`${manifest.version}:${target}`];
 if(!expected||!existsSync(join(source,selected))||hash(readFileSync(join(source,selected)))!==expected){
  throw new Error(`The ${target} home-lock payload is missing or differs from the reviewed publisher bytes.`);
 }
 const destination=resolve('dist/node_modules'),packages=new Map();
 rmSync(destination,{recursive:true,force:true});mkdirSync(destination,{recursive:true});
 function copy(name,from){
  const root=packageRoot(name,from),metadata=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(packages.has(name)){
   if(packages.get(name)!==metadata.version)throw new Error(`Conflicting native-loader dependency versions for ${name}.`);
   return;
  }
  packages.set(name,metadata.version);
  cpSync(root,join(destination,...name.split('/')),{recursive:true,dereference:false,filter:at=>{
   const local=relative(root,at).split(sep).join('/');
   if(lstatSync(at).isSymbolicLink())throw new Error(`A runtime dependency contains an unexpected link: ${name}/${local}.`);
   if(name==='fs-native-extensions'&&local.startsWith('prebuilds/')){
    return local===`prebuilds/${target}`||local===selected;
   }
   return true;
  }});
  for(const dependency of Object.keys(metadata.dependencies??{}).sort())copy(dependency,root);
 }
 copy('fs-native-extensions',kernel);
 const record={backend:manifest.name,version:manifest.version,target,native:`node_modules/fs-native-extensions/${selected}`,publisherSha256:expected,packages:Object.fromEntries([...packages].sort(([a],[b])=>a.localeCompare(b)))};
 writeFileSync('dist/home-lock-runtime.json',JSON.stringify(record,null,2)+'\n');
 return record;
}

/** Before packaging the unsigned staging tree. Signing may change Mach-O signature bytes later. */
export function verifyHomeLockRuntime(root='dist'){
 const record=JSON.parse(readFileSync(join(root,'home-lock-runtime.json'),'utf8'));
 const expected=PAYLOADS[`${record.version}:${record.target}`];
 if(record.target!==`${process.platform}-${process.arch}`||record.publisherSha256!==expected||!expected||
    hash(readFileSync(join(root,record.native)))!==expected)throw new Error('The staged home-lock runtime differs from its reviewed payload.');
 for(const [name,version] of Object.entries(record.packages)){
  const metadata=JSON.parse(readFileSync(join(root,'node_modules',...name.split('/'),'package.json'),'utf8'));
  if(metadata.name!==name||metadata.version!==version)throw new Error(`The staged native-loader dependency differs: ${name}.`);
 }
 return record;
}
