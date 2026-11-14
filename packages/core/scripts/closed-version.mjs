// Owning source check for the frozen bootstrap and every explicit closed Core version.
// This checks build provenance, not native security semantics or an installed database.
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleClosedVersion,canonical,sha256} from './closed-version-assembler.mjs';
import {functionDeclarations,functionVersionIndex,sqlTokens} from './closed-version-functions.mjs';
import {CORE_SCHEMA_UPGRADES} from '../src/db/schema-migrations.ts';
export {assembleClosedVersion,functionDeclarations};
const compare=(a,b)=>a<b?-1:a>b?1:0;
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
const require=(condition,message)=>{if(!condition)throw new Error(message);};
const sorted=value=>[...value].sort(compare);
function sqlFiles(dir,prefix='') {
 const files=[];
 for(const ent of readdirSync(dir,{withFileTypes:true})){
  const file=prefix+ent.name;
  if(ent.isDirectory())files.push(...sqlFiles(join(dir,ent.name),file+'/'));
  else if(ent.isFile()&&ent.name.endsWith('.sql'))files.push(file);
 }
 return files;
}
/** Index signatures exactly and name relation families/attachments. Native qualification owns
 * their full columns, policies, trigger flags, ACLs, constraints, roles and dependency closure. */
export function policyDeclarations(sql) {
 const tokens=sqlTokens(sql),objects=[];
 for(let i=0;i<tokens.length;i++)if(tokens[i]==='create'&&tokens[i+1]==='policy'){
  const name=tokens[i+2];let on=i+3;while(on<tokens.length&&tokens[on]!=='on'&&tokens[on]!==';')on++;
  require(/^[a-z_][a-z0-9_$]*$/.test(name??'')&&tokens[on]==='on'&&tokens[on+2]==='.', 'unsupported SQL policy declaration');
  objects.push('policy '+tokens[on+1]+'.'+tokens[on+3]+'.'+name);
 }
 return objects;
}
function declarations(bytes,includePolicies=false) {
 const sql=bytes.toString('utf8'),tokens=sqlTokens(sql),objects=functionDeclarations(sql).map(f=>'function '+f);
 if(includePolicies)objects.push(...policyDeclarations(sql));
 const qualified=i=>tokens[i]+'.'+tokens[i+2];
 for(let i=0;i<tokens.length;i++){
  if(tokens[i]!=='create')continue;
  let c=i+1;if(tokens[c]==='or'&&tokens[c+1]==='replace')c+=2;
  if(tokens[c]==='unique')c++;
  if(['table','view'].includes(tokens[c])&&tokens[c+2]==='.')objects.push(tokens[c]+' '+qualified(c+1));
  else if(tokens[c]==='index'){
   const name=tokens[c+1];let on=c+2;while(on<tokens.length&&tokens[on]!=='on'&&tokens[on]!==';')on++;
   require(tokens[on]==='on'&&tokens[on+2]==='.', 'unsupported SQL index declaration');
   objects.push('index '+tokens[on+1]+'.'+name);
  }else{
   if(tokens[c]==='constraint')c++;
   if(tokens[c]!=='trigger')continue;
   const name=tokens[c+1];let on=c+2;while(on<tokens.length&&tokens[on]!=='on'&&tokens[on]!==';')on++;
   require(tokens[on]==='on'&&tokens[on+2]==='.', 'unsupported SQL trigger declaration');
   objects.push('trigger '+qualified(on+1)+'.'+name);
  }
 }
 return objects;
}
function indexTable(bytes, object) {
 const tokens=sqlTokens(bytes.toString('utf8'));
 for(let i=0;i<tokens.length;i++)if(tokens[i]==='create'){
  let c=i+1;if(tokens[c]==='unique')c++;
  if(tokens[c]!=='index')continue;
  const name=tokens[c+1];let on=c+2;while(on<tokens.length&&tokens[on]!=='on'&&tokens[on]!==';')on++;
  if(tokens[on]==='on'&&tokens[on+2]==='.'&&object==='index '+tokens[on+1]+'.'+name)
   return 'table '+tokens[on+1]+'.'+tokens[on+3];
 }
 return null;
}
export function coreSourceState(root) {
 const schema=join(root,'packages/core/schema'),baseline=readJson(join(schema,'baseline.json'));
 require(exact(baseline,['format','comment','sections','sourceHashes','bodyChecksum','artifactChecksum'])&&baseline.format===1,'baseline manifest fields');
 const bootstrap=new Map(),parts=['-- Core baseline (generated from packages/core/schema; do not edit).','SET check_function_bodies = false;'];
 require(Array.isArray(baseline.sections)&&baseline.sections.length>0,'baseline sections');
 for(const section of baseline.sections){
  require(exact(section,['role','files'])&&[null,'backbone_gov','backbone_owner'].includes(section.role)&&Array.isArray(section.files)&&section.files.length,'baseline section fields');
  parts.push(section.role?`SET ROLE ${section.role};`:'RESET ROLE;');
  for(const file of section.files){
   require(typeof file==='string'&&/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\.sql$/.test(file)&&!file.startsWith('versions/'),'finite baseline source path');
   require(!bootstrap.has(file),'duplicate baseline source');
   const bytes=readFileSync(join(schema,file));bootstrap.set(file,bytes);
   require(sha256(bytes)===baseline.sourceHashes[file],'baseline raw source digest: '+file);
   parts.push('-- '+file,bytes.toString('utf8').replace(/\r\n/g,'\n').trim());
  }
 }
 require(exact(baseline.sourceHashes,[...bootstrap.keys()]),'baseline source inventory');
 parts.push('RESET ROLE;');const body=parts.join('\n\n'),checksum=sha256(body);
 require(checksum===baseline.bodyChecksum,'baseline body checksum');
 const baselineSql=body+`\n\nINSERT INTO ops.schema_migrations (version, checksum) VALUES ('baseline', '${checksum}');\n`;
 require(sha256(baselineSql)===baseline.artifactChecksum,'baseline artifact checksum');
 const catalogue=readJson(join(schema,'versions.json'));
 require(exact(catalogue,['format','historical','versions'])&&catalogue.format===1&&Array.isArray(catalogue.historical)&&Array.isArray(catalogue.versions),'version catalogue fields');
 const versions=[],all=new Map(),initial=[],groupedPolicies=new Map();
 // Historical manifests grouped policies with their owning source. Preserve
 // those receipts; promote an exact old address when a later step replaces it.
 for(const [file,bytes]of bootstrap)for(const object of policyDeclarations(bytes.toString('utf8')))groupedPolicies.set(object,{object,version:'baseline',file});
 for(const [file,bytes] of bootstrap)for(const object of declarations(bytes)){
  require(!all.has(object),'duplicate bootstrap object: '+object);
  const row={object,version:'baseline',file};all.set(object,row);initial.push(row);
 }
 let prerequisite=catalogue.historical;
 const anchors=[...catalogue.historical,...catalogue.versions.map(({version,checksum})=>({version,checksum}))];
 require(canonical(anchors)===canonical(CORE_SCHEMA_UPGRADES),'released upgrade registry differs');
 const seenVersions=new Set(catalogue.historical.map(r=>r.version));
 const claimedFiles=new Set(bootstrap.keys());
 for(const anchor of catalogue.versions){
  require(exact(anchor,['version','checksum','manifestSha256'])&&/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]*$/.test(anchor.version)&&!seenVersions.has(anchor.version),'released version identity');
  seenVersions.add(anchor.version);
  const prefix='versions/'+anchor.version+'/',manifest=readJson(join(schema,prefix,'manifest.json'));
  require(manifest.version===anchor.version,'version directory identity');
  const sources=new Map();
  for(const section of manifest.sections)for(const row of section.files){
   require(/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\.sql$/.test(row.path),'closed source path');
   require(!sources.has(row.path),'duplicate source');
   sources.set(row.path,readFileSync(join(schema,prefix,row.path)));claimedFiles.add(prefix+row.path);
  }
  const explicitPolicies=manifest.changes.some(row=>row.object.startsWith('policy '));
  for(const row of manifest.changes)if(row.object.startsWith('policy ')&&!all.has(row.object)&&groupedPolicies.has(row.object))all.set(row.object,groupedPolicies.get(row.object));
  const built=assembleClosedVersion(manifest,sources,prerequisite,all,anchor);
  const defined=new Set();
  for(const [file,bytes] of sources)for(const object of declarations(bytes,explicitPolicies)){
   require(!defined.has(object),'duplicate object in version: '+object);defined.add(object);
   const declaration=manifest.changes.find(c=>c.object===object&&c.file===file);
   // A new table owns its own constraints/indexes/policies/triggers as a full family. An
   // attachment/index on an EXISTING table must have its own explicit object declaration.
   const ownTable=object.startsWith('trigger ')?object.split('.').slice(0,-1).join('.').replace(/^trigger /,'table '):null;
   const tableFamily=ownTable&&manifest.changes.some(c=>c.action==='add'&&c.object===ownTable&&c.file===file);
   const ownIndex=object.startsWith('index ')&&manifest.changes.some(c=>c.action==='add'&&c.object===indexTable(bytes,object)&&c.file===file);
   require(declaration||tableFamily||ownIndex,'source object lacks declaration: '+object);
   all.set(object,{object,version:manifest.version,file:prefix+file});
  }
  for(const row of manifest.changes)require(defined.has(row.object),'declared object absent: '+row.object);
  for(const[file,bytes]of sources)for(const object of policyDeclarations(bytes.toString('utf8')))groupedPolicies.set(object,{object,version:manifest.version,file:prefix+file});
  versions.push({manifest,sources,built});prerequisite=[...prerequisite,{version:manifest.version,checksum:manifest.checksum}];
 }
 const actual=sqlFiles(schema);
 require(canonical(sorted(actual))===canonical(sorted(claimedFiles)),'unlisted or missing Core SQL source');
 const functionIndex=functionVersionIndex(bootstrap,versions);
 const current={format:1,bootstrap:initial.sort((a,b)=>compare(a.object,b.object)),objects:[...all.values()].sort((a,b)=>compare(a.object,b.object)),
  functions:functionIndex.map(([signature,row])=>({signature,...row,file:row.version==='baseline'?row.file:'versions/'+row.version+'/'+row.file}))};
 return {baselineSql,baselineChecksum:checksum,versions,current};
}
// A newly declared version needs its own reviewed runtime-data owner. Never select the last
// bundle into an older version's path: packaged historical installers retain their own bytes.
const RUNTIME_RELEASE_FILES=Object.freeze({
 'material-closure-foundation-v1':'packages/core/src/db/material-closure-release.generated.ts',
 'material-closure-hardening-v1':'packages/core/src/db/material-closure-hardening-release.generated.ts',
 'identity-v1':'packages/core/src/db/identity-release.generated.ts',
 'identity-work-v1':'packages/core/src/db/identity-work-release.generated.ts',
 'identity-role-revocation-v1':'packages/core/src/db/identity-role-revocation-release.generated.ts',
 'identity-resource-guard-v1':'packages/core/src/db/identity-resource-release.generated.ts',
 'identity-admission-closure-v1':'packages/core/src/db/identity-admission-release.generated.ts',
 'identity-guarantees-v1':'packages/core/src/db/identity-guarantees-release.generated.ts',
 'identity-platform-v1':'packages/core/src/db/identity-platform-release.generated.ts',
 'identity-role-closure-v1':'packages/core/src/db/identity-role-closure-release.generated.ts',
 'identity-piece-admission-v1':'packages/core/src/db/identity-piece-admission-release.generated.ts',
 'identity-lookup-closure-v1':'packages/core/src/db/identity-lookup-closure-release.generated.ts',
 'identity-invitation-closure-v1':'packages/core/src/db/identity-invitation-closure-release.generated.ts',
 'identity-device-recovery-v1':'packages/core/src/db/identity-device-recovery-release.generated.ts',
 'identity-device-lockout-v1':'packages/core/src/db/identity-device-lockout-release.generated.ts',
 'identity-device-subject-v1':'packages/core/src/db/identity-device-subject-release.generated.ts',
 'identity-native-turn-v1':'packages/core/src/db/identity-native-turn-release.generated.ts',
 'identity-device-current-v1':'packages/core/src/db/identity-device-current-release.generated.ts',
});
export function runtimeReleaseArtifacts(versions) {
 const byVersion=new Map(versions.map(row=>[row.manifest.version,row]));
 require(byVersion.size===versions.length&&canonical(sorted(byVersion.keys()))===canonical(sorted(Object.keys(RUNTIME_RELEASE_FILES))),
  'runtime release artifact mapping differs; add a separately owned artifact for each new version');
 return Object.entries(RUNTIME_RELEASE_FILES).map(([version,file])=>({file,artifact:byVersion.get(version).built.artifact}));
}
export function checkCoreSources(root) {
 try{
  const state=coreSourceState(root),schema=join(root,'packages/core/schema');
  require(canonical(readJson(join(schema,'current.json')))===canonical(state.current),'current definition index differs; regenerate from closed sources');
  for(const {file,artifact} of runtimeReleaseArtifacts(state.versions))
   require(artifact===readFileSync(join(root,file),'utf8'),'generated release data differs: '+file);
  return [];
 }catch(error){return ['Core closed sources: '+error.message];}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 if(process.argv.slice(2).join(' ')==='--write'){
  const state=coreSourceState(root),artifacts=runtimeReleaseArtifacts(state.versions);
  // Resolve the complete mapping before any write, so an unmapped new version changes nothing.
  writeFileSync(join(root,'packages/core/schema/current.json'),JSON.stringify(state.current,null,2)+'\n');
  for(const {file,artifact} of artifacts)writeFileSync(join(root,file),artifact);
 }
 const problems=checkCoreSources(root);if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log('Core closed source inventory, versions, current index and release data match.');
}
