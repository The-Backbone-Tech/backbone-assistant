// Offline freezing only: captures must come from one owned disposable PostgreSQL 18 source
// build, before and after the reviewed payload. This script never connects to a database.
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {INHERITED} from '../src/db/material-closure-inherited.ts';
import {BASE_FUNCTIONS,ADDED_FUNCTIONS,CRYPTO_FUNCTIONS,BASE_RELATIONS,RELATIONS,SCHEMAS} from '../src/db/material-closure-scope.ts';
import {assertInheritedMaterialProfile,summarizeMaterialClosureProfile,closureHash,closureCanonical,validateMaterialClosurePins} from '../src/db/material-closure-profile.ts';
const fail=message=>{throw new Error(message);};
const assert=(value,message)=>{if(!value)fail(message);};
const same=(a,b)=>closureCanonical(a)===closureCanonical(b);
function keys(actual,expected,label){assert(new Set(actual).size===actual.length&&same([...actual].sort(),[...expected].sort()),'Incomplete '+label);}
function captureShape(capture,phase){
 const names=phase==='current'?[...BASE_FUNCTIONS,...ADDED_FUNCTIONS]:BASE_FUNCTIONS;
 keys(capture.full.overloads.map(x=>x.signature),[...names,...CRYPTO_FUNCTIONS],phase+' overloads');
 keys(capture.full.inventory.filter(x=>x.kind==='function').map(x=>x.name),names,phase+' namespace functions');
 keys(capture.full.objects.filter(x=>x.kind==='relation').map(x=>x.name),phase==='current'?RELATIONS:BASE_RELATIONS,phase+' relations');
 keys(capture.full.namespaces.filter(x=>x.kind==='schema').map(x=>x.name),SCHEMAS,phase+' schemas');
}
/** Callable by the disposable native qualifier; no connection string or target URL accepted. */
export function freezeMaterialClosureProfiles(before,after,identity){
 assert(identity.qualifiedBaseCommit==='78c12d0bb951bba5870c7612d0938a1a1980d1ef','Unexpected qualified base');
 assert(/^[a-f0-9]{64}$/.test(identity.sourceInventorySha256)&&/^[a-f0-9]{64}$/.test(identity.payloadSha256),'Missing reviewed source identity');
 captureShape(before,'prerequisite');captureShape(after,'current');
 assertInheritedMaterialProfile(before,'prerequisite');
 const prerequisite=summarizeMaterialClosureProfile(before),current=summarizeMaterialClosureProfile(after);
 const changed=BASE_FUNCTIONS.filter(signature=>prerequisite.functions[signature]!==current.functions[signature]).sort();
 assert(same(changed,['gov._create_workspace(text,text,text,text)','gov._material_source_state(uuid)']),'Unexpected replacement function family');
 for(const signature of changed){
  const beforeRow=before.full.functions.find(row=>row.signature===signature),afterRow=after.full.functions.find(row=>row.signature===signature);
  const {body:_beforeBody,...beforeMetadata}=beforeRow;
  const {body:_afterBody,...afterMetadata}=afterRow;
  assert(same(beforeMetadata,afterMetadata),'Existing function ABI/owner/ACL/posture changed: '+signature);
 }

 for(const signature of CRYPTO_FUNCTIONS)assert(prerequisite.functions[signature]===current.functions[signature],'Changed cryptographic dependency');
 for(const signature of ADDED_FUNCTIONS)assert(prerequisite.functions[signature]===null&&typeof current.functions[signature]==='string','Missing/partial new function');
 assert(prerequisite.linkObjects===current.linkObjects&&prerequisite.linkRoles===current.linkRoles,'Changed inherited journal/role family');
 assert(prerequisite.namespaces===current.namespaces,'Changed schema/default-ACL/role/extension authority');
 const addedRelations=['app.knowledge_candidate_inputs','app.knowledge_reads'];
 const isNewFamily=row=>addedRelations.some(name=>row.name===name||row.name.startsWith(name+'.')||row.kind==='index'&&row.name.startsWith(name+'_'));
 const allowedOldAdditions=new Set([
  'trigger/app.knowledge_candidates.candidate_input_capture',
  'trigger/app.knowledge_candidates.candidate_input_structure',
  'constraint/app.knowledge_candidates.candidate_input_structure',
  'index/app.knowledge_traced_scan',
 ]);
 const prior=new Map(before.full.objects.map(row=>[row.kind+'/'+row.name,row]));
 const retained=new Set();
 for(const row of after.full.objects){
  const key=row.kind+'/'+row.name;
  if(prior.has(key)){assert(same(row,prior.get(key)),'Unexpected existing object change: '+key);retained.add(key);}
  else assert(isNewFamily(row)||allowedOldAdditions.has(key),'Unexpected object addition: '+key);
 }
 assert(retained.size===prior.size,'Dropped prerequisite object');
 const override={signature:'gov._material_source_state(uuid)',fromSpecSha256:closureHash(closureCanonical(INHERITED.nativeSpecs['gov._material_source_state(uuid)'])),to:current.functions['gov._material_source_state(uuid)']};
 const pins={version:'material-closure-foundation-v1',...identity,inheritedNativeOverride:override,
  inheritedGuardOverride:{from:INHERITED.guardObjects,to:current.guardObjects},prerequisite,current};
 validateMaterialClosurePins(pins);assertInheritedMaterialProfile(after,'current',pins);
 return pins;
}
export function writeMaterialClosurePins(pins){
 const target=new URL('../src/db/material-closure-pins.ts',import.meta.url),source=readFileSync(target,'utf8');
 const marker='export const MATERIAL_CLOSURE_PINS:';
 const offset=source.indexOf(marker);assert(offset>=0,'Missing generated release anchor');
 writeFileSync(target,source.slice(0,offset)+'export const MATERIAL_CLOSURE_PINS:MaterialClosurePins = '+JSON.stringify(pins,null,2)+';\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);
 assert(args.length===4,'Usage: node packages/core/scripts/material-closure-pins.mjs BEFORE.json AFTER.json SOURCE_INVENTORY_SHA256 PAYLOAD_SHA256');
 const pins=freezeMaterialClosureProfiles(JSON.parse(readFileSync(args[0],'utf8')),JSON.parse(readFileSync(args[1],'utf8')),
  {qualifiedBaseCommit:'78c12d0bb951bba5870c7612d0938a1a1980d1ef',sourceInventorySha256:args[2],payloadSha256:args[3]});
 writeMaterialClosurePins(pins);
 console.log('Frozen complete prerequisite/current catalogue pins from disposable source captures.');
}
