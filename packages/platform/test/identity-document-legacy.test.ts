import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CoreLink} from '../src/composition/core.ts';
import {IdentityUnavailable} from '../src/composition/identity-core.ts';
for(const solo of [true,false])test(`document access with paused identity keeps the legacy sole-device boundary (solo=${solo})`,async()=>{
 let reads=0,writes=0;
 const fake={identityStatus:{state:'paused'},legacyDeviceOnly:async()=>solo,identities:{requireReady(){throw new IdentityUnavailable();}},person:()=>({}),
  async read(_actor:unknown,sql:string){assert.doesNotMatch(sql,/gov\.identity_/);reads++;return {rows:[{version:3}]};},
  async call(_actor:unknown,sql:string){assert.match(sql,/gov\.revise_document/);writes++;return 4;}};
 const version=()=>CoreLink.prototype.documentVersion.call(fake as never,'document','project');
 const save=()=>CoreLink.prototype.reviseDocument.call(fake as never,'document','person words','project',3);
 if(solo){assert.equal(await version(),3);assert.equal(await save(),4);assert.equal(reads,1);assert.equal(writes,1);}
 else{await assert.rejects(version(),IdentityUnavailable);await assert.rejects(save(),IdentityUnavailable);assert.equal(reads,0);assert.equal(writes,0);}
});
