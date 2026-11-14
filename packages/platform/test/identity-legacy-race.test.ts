import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIdentityHost,type IdentityHostDeps} from '../src/composition/identity-host.ts';

test('a sole-device read cannot publish a private project created by a newly accepted person',async()=>{
 const home=mkdtempSync(join(tmpdir(),'backbone-legacy-race-'));
 let admitted=false,accepted=false;
 const hidden={id:'second-person-private-project',name:'Private'};
 const link={identityStatus:{state:'paused'},identities:{devicePerson:'owner'},
  legacyDeviceOnly:async()=>{if(!admitted)accepted=true;return true;},
  legacyDeviceCall:async<T>(work:()=>Promise<T>)=>{
   admitted=true;
   try{return {legacy:true,value:await work()};}
   finally{admitted=false;accepted=true;}
  }};
 const deps:IdentityHostDeps={home,readOnly:false,link:async()=>link as never,projects:()=>[],threads:new Map(),summary:async thread=>thread.summary,
  material:{} as never,piece:()=>null,nativeEngine:()=>false,emit(){},abort(){},on:()=>()=>{},
  dispatch:(async()=>accepted?[hidden]:[]) as IdentityHostDeps['dispatch']};
 try{assert.deepEqual(await createIdentityHost(deps).call(undefined,'projects.list',{}),[]);assert.equal(accepted,true);}
 finally{rmSync(home,{recursive:true,force:true});}
});
