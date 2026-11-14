// Complete-superset verification over the immutable foundation profile and two explicit replacements.
import type pg from 'pg';
import {MATERIAL_CLOSURE_PINS} from './material-closure-pins.ts';
import {MATERIAL_CLOSURE_HARDENING_PINS} from './material-closure-hardening-pins.ts';
import {MATERIAL_CLOSURE_RELEASE as RELEASE} from './material-closure-hardening-release.generated.ts';
import {projectIdentityInventory,identityReaderReplacements} from './identity-catalogue.ts';
import {captureMaterialClosureProfile,assertInheritedMaterialProfile,summarizeMaterialClosureProfile,
 validateMaterialClosurePins,assertMaterialClosureCurrentScope,closureCanonical,closureHash,closureNativeHash} from './material-closure-profile.ts';
export const MATERIAL_CLOSURE_HARDENING_VERSION='material-closure-hardening-v1';
export const HARDENED_FUNCTIONS=Object.freeze([
 'gov._candidate_input_manifest_v1(app.knowledge_candidates,bigint)','sec.t_candidate_input_capture_v1()',
]);
export async function verifyMaterialClosureHardeningCatalogue(client:pg.ClientBase){
 try{
  const foundation=validateMaterialClosurePins(MATERIAL_CLOSURE_PINS),pins=MATERIAL_CLOSURE_HARDENING_PINS;
  if(RELEASE.version!==MATERIAL_CLOSURE_HARDENING_VERSION||!pins||pins.version!==MATERIAL_CLOSURE_HARDENING_VERSION||pins.qualifiedBaseCommit!=='1fef3fc0cf17cc21b559396f481a2997f8feda61'
    ||pins.payloadSha256!==RELEASE.checksum||closureHash(RELEASE.sql)!==pins.payloadSha256
    ||pins.predecessorProfileSha256!==closureHash(closureCanonical(foundation.current))
    ||closureCanonical(Object.keys(pins.functions).sort())!==closureCanonical([...HARDENED_FUNCTIONS].sort())
    ||HARDENED_FUNCTIONS.some(name=>!(/^[a-f0-9]{64}$/.test(pins.functions[name]))||pins.functions[name]===foundation.current.functions[name]))
   throw new Error('Unbound hardening release');
  const v=(await client.query<{version:number}>("SELECT current_setting('server_version_num')::integer AS version")).rows;
  if(v.length!==1||!Number.isInteger(v[0].version)||v[0].version<180000||v[0].version>=190000)throw new Error('PostgreSQL 18 required');
  const captured=await captureMaterialClosureProfile(client);
  const actual=await projectIdentityInventory(client,captured), replacements=identityReaderReplacements(captured);
  assertInheritedMaterialProfile(actual,'current',foundation,replacements);
  assertMaterialClosureCurrentScope(actual);
  const expected={...foundation.current,functions:{...foundation.current.functions,...pins.functions,...Object.fromEntries(actual.full.functions.filter(row=>replacements.has(row.signature)).map(row=>[row.signature,closureNativeHash(row)]))}};
  if(closureCanonical(summarizeMaterialClosureProfile(actual))!==closureCanonical(expected))throw new Error('Complete catalogue mismatch');
  // Complete inventory/overload/namespace hashes retain every foundation scope, not merely the changed functions.
  return {state:'verified' as const,reason:'Complete hardened material dependency profile verified; material remains withheld.'};
 }catch{return {state:'paused' as const,reason:'Material closure hardening differs from its complete reviewed catalogue profile.'};}
}
