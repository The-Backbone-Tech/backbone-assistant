// Offline only: qualify frozen-source disposable pre/post captures, never a live home.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {MATERIAL_CLOSURE_PINS} from '../src/db/material-closure-pins.ts';
import {MATERIAL_CLOSURE_RELEASE} from '../src/db/material-closure-hardening-release.generated.ts';
import {HARDENED_FUNCTIONS,MATERIAL_CLOSURE_HARDENING_VERSION} from '../src/db/material-closure-hardening-profile.ts';
import {validateMaterialClosurePins,summarizeMaterialClosureProfile,assertInheritedMaterialProfile,
 assertMaterialClosureCurrentScope,closureCanonical,closureHash,closureNativeHash} from '../src/db/material-closure-profile.ts';
export function freezeHardeningPins(before,after){
 const foundation=validateMaterialClosurePins(MATERIAL_CLOSURE_PINS);
 assertInheritedMaterialProfile(before,'current',foundation);assertInheritedMaterialProfile(after,'current',foundation);
 assertMaterialClosureCurrentScope(before);assertMaterialClosureCurrentScope(after);
 const pre=summarizeMaterialClosureProfile(before),post=summarizeMaterialClosureProfile(after);
 assert.equal(closureCanonical(pre),closureCanonical(foundation.current),'Hardening pre-image is not the complete qualified foundation');
 assert.equal(before.full.functions.length,after.full.functions.length);
 const overrides={};
 for(let i=0;i<before.full.functions.length;i++){
  const a=before.full.functions[i],b=after.full.functions[i];assert.equal(a.signature,b.signature);
  if(HARDENED_FUNCTIONS.includes(a.signature)){
   assert.notEqual(a.body,b.body);assert.equal(closureCanonical({...a,body:null}),closureCanonical({...b,body:null}),'Only function body may change');
   overrides[a.signature]=closureNativeHash(b);
  }else assert.equal(closureCanonical(a),closureCanonical(b),'Unchanged native function differs');
 }
 assert.deepEqual(Object.keys(overrides).sort(),[...HARDENED_FUNCTIONS].sort());
 assert.equal(closureCanonical(post),closureCanonical({...foundation.current,functions:{...foundation.current.functions,...overrides}}),'Unchanged complete scope differs');
 return {version:MATERIAL_CLOSURE_HARDENING_VERSION,qualifiedBaseCommit:'1fef3fc0cf17cc21b559396f481a2997f8feda61',
  payloadSha256:MATERIAL_CLOSURE_RELEASE.checksum,predecessorProfileSha256:closureHash(closureCanonical(foundation.current)),functions:overrides};
}
export function writeHardeningPins(pins){
 const path=new URL('../src/db/material-closure-hardening-pins.ts',import.meta.url),text=readFileSync(path,'utf8'),mark='export const MATERIAL_CLOSURE_HARDENING_PINS:';
 assert.ok(text.includes(mark));writeFileSync(path,text.slice(0,text.indexOf(mark))+mark+'MaterialClosureHardeningPins='+JSON.stringify(pins,null,2)+';\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 assert.equal(process.argv.length,4,'Usage: BEFORE.json AFTER.json');
 writeHardeningPins(freezeHardeningPins(JSON.parse(readFileSync(process.argv[2])),JSON.parse(readFileSync(process.argv[3]))));
}
