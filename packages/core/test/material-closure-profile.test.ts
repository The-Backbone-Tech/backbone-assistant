import {describe,it,expect} from 'vitest';
import {INHERITED} from '../src/db/material-closure-inherited.ts';
import {FUNCTIONS,BASE_FUNCTIONS,ADDED_FUNCTIONS,BASE_RELATIONS,ADDED_RELATIONS} from '../src/db/material-closure-scope.ts';
import {closureCanonical,closureNativeHash,validateMaterialClosurePins} from '../src/db/material-closure-profile.ts';
import type {FunctionRow} from '../src/db/material-closure-inherited-catalogue.ts';

describe('the closed complete material profile',()=>{
 it('retains the independent 59-signature union without substituting prosrc for definition claims',()=>{
  expect(INHERITED.signatures).toHaveLength(59);
  expect([...new Set([...INHERITED.definitionClaims.map(x=>x.signature),...Object.keys(INHERITED.nativeSpecs)])].sort()).toEqual([...INHERITED.signatures].sort());
  expect(INHERITED.definitionClaims).toHaveLength(40);
  expect(Object.keys(INHERITED.nativeSpecs)).toHaveLength(21);
  expect(new Set(INHERITED.definitionClaims.map(x=>x.family+'/'+x.signature)).size).toBe(40);
 });
 it('covers the actual post-A1c Core and names every additional family finitely',()=>{
  expect(BASE_FUNCTIONS).toHaveLength(198);expect(ADDED_FUNCTIONS).toHaveLength(9);
  expect(FUNCTIONS).toHaveLength(210);expect(new Set(FUNCTIONS).size).toBe(FUNCTIONS.length);
  expect(BASE_RELATIONS).toHaveLength(50);expect(ADDED_RELATIONS).toEqual(['app.knowledge_candidate_inputs','app.knowledge_reads']);
  expect(BASE_FUNCTIONS).toContain('operator.create_workspace(text,text,text,text)');
  expect(BASE_RELATIONS).toContain('ops.installation');
  for(const signature of INHERITED.signatures)expect(BASE_FUNCTIONS).toContain(signature);
 });
 it('refuses incomplete compiled data before it can be used to inspect a target',()=>{
  expect(()=>validateMaterialClosurePins(null)).toThrow('No compiled complete release profile');
  expect(()=>validateMaterialClosurePins({version:'material-closure-foundation-v1'} as never)).toThrow('Unfrozen complete release identity');
 });
 it('normalizes object key order while preserving array order and every native metadata change',()=>{
  expect(closureCanonical({z:{b:2,a:1},a:['b','a']})).toBe(closureCanonical({a:['b','a'],z:{a:1,b:2}}));
  expect(closureCanonical(['b','a'])).not.toBe(closureCanonical(['a','b']));
  const row={signature:'gov.sample()',body:'BEGIN RETURN 1; END',acl:[{grantee:'backbone_gov',grantor:'backbone_gov',privilege:'EXECUTE',grantable:false}],configuration:['search_path=pg_catalog'],defaults:0,defaultExpression:null} as FunctionRow;
  for(const patch of [{body:'BEGIN RETURN 2; END'},{configuration:['search_path=public']},{defaults:1},{defaultExpression:'true'},{acl:null},{owner:'other'},{result:'boolean'},{operatorExecutes:true}])expect(closureNativeHash({...row,...patch})).not.toBe(closureNativeHash(row));
 });
});
